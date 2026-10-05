// GitHub REST API client, for the relay's conflict sweep only.
//
// It lists open pull requests, reads whether each can be merged, and leaves a
// comment on the ones it sends back. It needs GITHUB_TOKEN with "Pull requests"
// access on the repositories in GITHUB_REPOS: read to look, read and write to
// comment. It never merges, pushes, closes or deletes anything.

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

export function createGitHub({ config, log, fetchImpl = globalThis.fetch } = {}) {
  const base = config.githubApi;
  const timeoutMs = config.timeoutSec * 1000;

  function explain(method, path, res, data, text) {
    const detail = data && typeof data === "object" && data.message ? String(data.message) : String(text ?? "").slice(0, 300);
    const meta = { status: res.status, method, path };
    if (res.status === 401) {
      return new GitHubError(`GitHub rejected GITHUB_TOKEN (${detail}). It may have expired or been revoked: create a new one.`, meta);
    }
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      return new GitHubError(`GitHub's rate limit for GITHUB_TOKEN is used up (${detail}).`, meta);
    }
    if (res.status === 403 || res.status === 404) {
      const need = method === "GET" ? "read" : "read and write";
      return new GitHubError(
        `${method} ${path} → ${res.status}: ${detail}. GITHUB_TOKEN needs "Pull requests: ${need}" on this repository.`,
        meta,
      );
    }
    return new GitHubError(`${method} ${path} → ${res.status}: ${detail}`, meta);
  }

  async function request(method, path, body) {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.githubToken}`,
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
  };
}
