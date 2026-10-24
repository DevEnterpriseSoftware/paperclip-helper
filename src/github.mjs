// GitHub API client (REST, and GraphQL for re-queueing), for the relay (its conflict
// sweep, merge-queue drops, and its notes on a PR when a decision you asked for
// wasn't recorded) and the watchdog (CI runs, and the PRs of issues whose review
// stages were wiped).
//
// It lists open pull requests, reads whether each can be merged, and leaves a
// comment on the ones it sends back or explains: "Pull requests" access on the
// repositories in GITHUB_REPOS, read to look, read and write to comment. Merge-queue
// drops and the CI check read workflow runs and their jobs ("Actions: Read"), and a
// failed check's annotation ("Checks: Read", optional). Only for jobs you named as
// flaky does the watchdog re-run failed jobs ("Actions: Read and write"), and only
// with RELAY_REQUEUE_ON_INFRA_DROP (off by default) does the relay put a PR back in
// the merge queue (a token allowed to merge). It never merges, pushes, closes or
// deletes anything itself.
//
// The token is GITHUB_TOKEN as it is, or the contents of GITHUB_TOKEN_FILE, read
// again for every request: a GitHub App installation token lasts an hour, and
// whatever keeps that file fresh replaces it without the helper restarting.

import fs from "node:fs";
import { signed } from "./util.mjs";

// Ends every comment the helper writes on a PR, so the relay doesn't copy its
// own comments back to Paperclip when GitHub delivers them as webhooks.
export const HELPER_MARK = "<!-- paperclip-helper -->";

export class GitHubError extends Error {
  constructor(message, { status = 0, method, path, retryAfter = null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.retryAfter = retryAfter;
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

// A read GitHub may answer on a second try: a dropped connection, a 5xx, or a
// secondary rate limit that names a short wait (Retry-After, in seconds).
const RETRY_WAIT_MS = 1_000;
const MAX_RETRY_AFTER_SEC = 10;

export function createGitHub({ config, log, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const base = config.githubApi;
  const timeoutMs = config.timeoutSec * 1000;
  const source = tokenSource(config);
  // github.com serves GraphQL at /graphql; GitHub Enterprise Server at /api/graphql, beside /api/v3.
  const graphqlUrl = /\/api\/v3\/?$/.test(base) ? base.replace(/\/api\/v3\/?$/, "/api/graphql") : `${base}/graphql`;

  function explain(method, path, res, data, text) {
    const detail = data && typeof data === "object" && data.message ? String(data.message) : String(text ?? "").slice(0, 300);
    const meta = { status: res.status, method, path, retryAfter: res.headers.get("retry-after") };
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
    if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after"))) {
      return new GitHubError(`GitHub's rate limit for ${source} is used up (${detail}).`, meta);
    }
    if (res.status === 403 || res.status === 404) {
      const need = method === "GET" ? "read" : "read and write";
      const scope = /\/actions\//.test(path)
        ? "Actions"
        : /\/check-runs|\/check-suites/.test(path)
          ? "Checks"
          : /\/branches\/|\/contents\//.test(path)
            ? "Contents"
            : /^\/repos\/[^/]+\/[^/]+$/.test(path)
              ? "Metadata"
              : "Pull requests";
      return new GitHubError(
        `${method} ${path} → ${res.status}: ${detail}. ${source} needs "${scope}: ${need}" on this repository.`,
        meta,
      );
    }
    return new GitHubError(`${method} ${path} → ${res.status}: ${detail}`, meta);
  }

  async function request(method, path, body) {
    // Only reads are retried: a write that may have happened must not happen twice.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await requestOnce(method, path, body);
      } catch (err) {
        const wait = retryWait(err);
        if (method !== "GET" || attempt > 1 || wait === null) throw err;
        log?.debug?.("github: retrying a read", { path, status: err.status ?? null, waitMs: wait });
        await sleep(wait);
      }
    }
  }

  // How long to wait before retrying, or null when a retry won't help.
  function retryWait(err) {
    if (!err.status) return RETRY_WAIT_MS; // couldn't reach GitHub
    if (err.status >= 500) return RETRY_WAIT_MS;
    const after = Number(err.retryAfter);
    if ((err.status === 403 || err.status === 429) && after > 0 && after <= MAX_RETRY_AFTER_SEC) return after * 1000;
    return null;
  }

  async function requestOnce(method, path, body) {
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
      res = await fetchImpl(/^https?:/.test(path) ? path : `${base}${path}`, {
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
    // The helper's own comment: signed, and marked so the relay ignores it when it comes back.
    helperComment: (repo, number, text) => request("POST", `/repos/${repo}/issues/${number}/comments`, { body: `${signed(text)}\n\n${HELPER_MARK}` }),
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
    // GraphQL, for the merge queue (enqueuePullRequest). GitHub answers 200 with `errors` on failure.
    async graphql(query, variables) {
      const data = await request("POST", graphqlUrl, { query, variables });
      if (data?.errors?.length) throw new GitHubError(`GraphQL: ${data.errors.map((e) => e.message).join("; ")}`, { status: 200, method: "POST", path: "/graphql" });
      return data?.data;
    },
  };
}
