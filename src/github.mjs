// GitHub REST API client, for the relay (its conflict sweep, and its notes on a
// PR when a decision you asked for wasn't recorded) and the watchdog's CI-run check.
//
// It lists open pull requests, reads whether each can be merged, and leaves a
// comment on the ones it sends back or explains. It needs a token with "Pull requests"
// access on the repositories in GITHUB_REPOS: read to look, read and write to
// comment. The watchdog reads workflow runs and their jobs ("Actions: Read") and,
// only for jobs you named as flaky, re-runs failed jobs ("Actions: Read and write").
// It never merges, pushes, closes or deletes anything.
//
// The token is GITHUB_TOKEN as it is, or the contents of GITHUB_TOKEN_FILE, read
// again for every request: a GitHub App installation token lasts an hour, and
// whatever keeps that file fresh replaces it without the helper restarting.

import fs from "node:fs";

export class GitHubError extends Error {
  constructor(message, { status = 0, method, path } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

// Where the token comes from, as messages name it.
export function tokenSource(config) {
  return config.githubTokenFile ? `the token in GITHUB_TOKEN_FILE (${config.githubTokenFile})` : "GITHUB_TOKEN";
}

// The token for one request: GITHUB_TOKEN, or GITHUB_TOKEN_FILE read now.
export function readToken(config, { readFile = fs.readFileSync } = {}) {
  if (!config.githubTokenFile) return config.githubToken;
  let token;
  try {
    token = String(readFile(config.githubTokenFile, "utf8")).trim();
  } catch (err) {
    throw new GitHubError(
      `cannot read GITHUB_TOKEN_FILE ${config.githubTokenFile} (${err?.code ?? err?.message}): check its folder is mounted into the container and readable by the helper's user (PCH_UID)`,
    );
  }
  if (!token) {
    throw new GitHubError(`GITHUB_TOKEN_FILE ${config.githubTokenFile} is empty: is the program that writes it running?`);
  }
  return token;
}

function minutesSinceWritten(file) {
  try {
    return Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
  } catch {
    return null;
  }
}

export function createGitHub({ config, log, fetchImpl = globalThis.fetch } = {}) {
  const base = config.githubApi;
  const timeoutMs = config.timeoutSec * 1000;
  const source = tokenSource(config);

  function explain(method, path, res, data, text) {
    const detail = data && typeof data === "object" && data.message ? String(data.message) : String(text ?? "").slice(0, 300);
    const meta = { status: res.status, method, path };
    if (res.status === 401) {
      if (config.githubTokenFile) {
        const age = minutesSinceWritten(config.githubTokenFile);
        return new GitHubError(
          `GitHub rejected ${source} (${detail}). The file was written ${age ?? "?"} minutes ago; a GitHub App token lasts 60. Check that the program that renews it is running.`,
          meta,
        );
      }
      return new GitHubError(`GitHub rejected GITHUB_TOKEN (${detail}). It may have expired or been revoked: create a new one.`, meta);
    }
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      return new GitHubError(`GitHub's rate limit for ${source} is used up (${detail}).`, meta);
    }
    if (res.status === 403 || res.status === 404) {
      const need = method === "GET" ? "read" : "read and write";
      const scope = /\/actions\//.test(path) ? "Actions" : "Pull requests";
      return new GitHubError(
        `${method} ${path} → ${res.status}: ${detail}. ${source} needs "${scope}: ${need}" on this repository.`,
        meta,
      );
    }
    return new GitHubError(`${method} ${path} → ${res.status}: ${detail}`, meta);
  }

  async function request(method, path, body) {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${readToken(config)}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": `paperclip-helper/${config.version || "dev"}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    let text;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const why = err?.name === "TimeoutError" ? `no answer within ${config.timeoutSec}s` : (err?.cause?.code ?? err?.code ?? "network");
      throw new GitHubError(`cannot reach GitHub at ${base} for ${method} ${path} (${why})`, { method, path });
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.ok) return data;
    log?.debug?.("github: request failed", { method, path, status: res.status });
    throw explain(method, path, res, data, text);
  }

  return {
    request,
    // Open PRs of owner/repo, oldest first; with `baseRef`, only those into that branch.
    async openPulls(repo, baseRef) {
      const out = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const q = new URLSearchParams({ state: "open", sort: "created", direction: "asc", per_page: String(PAGE_SIZE), page: String(page) });
        if (baseRef) q.set("base", baseRef);
        const rows = await request("GET", `/repos/${repo}/pulls?${q}`);
        if (!Array.isArray(rows)) break;
        out.push(...rows);
        if (rows.length < PAGE_SIZE) break;
      }
      return out;
    },
    // One PR in full: only this carries `mergeable` (true, false, or null while
    // GitHub is still working it out).
    pull: (repo, number) => request("GET", `/repos/${repo}/pulls/${number}`),
    comment: (repo, number, body) => request("POST", `/repos/${repo}/issues/${number}/comments`, { body }),
    // GitHub Actions, for the watchdog's CI-run check (needs "Actions: read"; a re-run "read and write").
    // One workflow run: status, conclusion, run_attempt, head_sha, updated_at, pull_requests, html_url.
    workflowRun: (repo, id) => request("GET", `/repos/${repo}/actions/runs/${id}`),
    // The jobs of the run's latest attempt.
    async workflowJobs(repo, id) {
      const data = await request("GET", `/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`);
      return Array.isArray(data?.jobs) ? data.jobs : [];
    },
    rerunFailedJobs: (repo, id) => request("POST", `/repos/${repo}/actions/runs/${id}/rerun-failed-jobs`, {}),
    repository: (repo) => request("GET", `/repos/${repo}`),
    // A branch's head commit (commit.sha), to tell whether a run is still its branch's latest.
    branch: (repo, name) => request("GET", `/repos/${repo}/branches/${encodeURIComponent(name)}`),
  };
}
