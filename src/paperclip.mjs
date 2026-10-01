// Paperclip HTTP API client.
//
// The helper calls Paperclip with a board API key that belongs to you (created
// by `login`), so everything it does is recorded in Paperclip as done by you.

export class PaperclipError extends Error {
  constructor(message, { status = 0, code = "http", method, path } = {}) {
    super(message);
    this.name = "PaperclipError";
    this.status = status;
    this.code = code;
    this.method = method;
    this.path = path;
  }
}

// Connection failures where nothing reached Paperclip, so even a POST is safe to retry.
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

// A path as it may appear in errors and logs: credentials in the query string
// (the login poll carries ?token=) are masked.
export function shownPath(apiPath) {
  return String(apiPath).replace(/([?&](?:token|secret|key)=)[^&#]*/gi, "$1***");
}

function errorCode(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return err?.cause?.code ?? err?.code ?? err?.cause?.name ?? "network";
}

export function createPaperclip({ config, readToken = () => "", log, fetchImpl = globalThis.fetch, sleep } = {}) {
  const base = config.paperclipApi;
  const timeoutMs = config.timeoutSec * 1000;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const hostname = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return base;
    }
  })();

  function explain(method, apiPath, status, data, text, sentToken) {
    const detail = data && typeof data === "object" && data.error ? String(data.error) : String(text ?? "").slice(0, 300);
    if (status === 403 && /hostname is not allowed|Missing Host header/i.test(detail)) {
      return new PaperclipError(
        `Paperclip refused the hostname "${hostname}" (its private-hostname guard, HTTP 403). ` +
          `Either reach Paperclip as 127.0.0.1 or localhost (host networking), or allow "${hostname}" in Paperclip: ` +
          `run \`npx paperclipai allowed-hostname ${hostname}\` where Paperclip runs and restart it, ` +
          `or add it to PAPERCLIP_ALLOWED_HOSTNAMES in Paperclip's environment (that list replaces the config file's).`,
        { status, code: "hostname_guard", method, path: apiPath },
      );
    }
    if (status === 401 && sentToken) {
      return new PaperclipError(
        `Paperclip rejected the helper's board key (${detail}). It may have expired or been revoked: run \`pch login\` for a new one.`,
        { status, code: "unauthorized", method, path: apiPath },
      );
    }
    return new PaperclipError(`${method} ${apiPath} → ${status}: ${detail}`, { status, method, path: apiPath });
  }

  async function request(method, apiPath, body, { token, retry = true } = {}) {
    const bearer = token === undefined ? readToken() : token;
    const shown = shownPath(apiPath);
    const idempotent = method === "GET" || method === "HEAD";
    const headers = { accept: "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 1; ; attempt += 1) {
      let res;
      let text;
      try {
        res = await fetchImpl(`${base}${apiPath}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        const code = errorCode(err);
        if (retry && attempt === 1 && (idempotent || NEVER_SENT.has(code))) {
          log?.debug?.("paperclip: retrying after a connection error", { method, path: shown, error: code });
          await wait(1000);
          continue;
        }
        const hint =
          code === "timeout"
            ? `no answer within ${config.timeoutSec}s`
            : `${code}; check PAPERCLIP_API and that Paperclip is running. From a container, 127.0.0.1 is the host only with network_mode: host`;
        const error = new PaperclipError(`cannot reach Paperclip at ${base} for ${method} ${shown} (${hint})`, {
          code: code === "timeout" ? "timeout" : "network",
          method,
          path: shown,
        });
        error.neverSent = NEVER_SENT.has(code); // false: the request may have been processed
        throw error;
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.ok) return data;
      if (retry && attempt === 1 && idempotent && (res.status >= 500 || res.status === 429)) {
        const after = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000);
        continue;
      }
      throw explain(method, shown, res.status, data, text, bearer);
    }
  }

  // Who the key belongs to, cached; refreshed when older than maxAgeMs.
  let identity = null;
  let identityAt = 0;
  async function whoAmI({ refresh = false, maxAgeMs = Infinity } = {}) {
    if (!identity || refresh || Date.now() - identityAt > maxAgeMs) {
      identity = await request("GET", "/api/cli-auth/me");
      identityAt = Date.now();
    }
    return identity;
  }

  return { base, request, whoAmI };
}

// Every issue in a company with one of the given statuses, page by page
// (keyset paging on id, the only stable order Paperclip offers).
export async function listIssues(api, companyId, statuses, { pageSize = 500, maxPages = 50 } = {}) {
  const out = [];
  let afterId = null;
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({ status: statuses, sortField: "id", sortDir: "asc", limit: String(pageSize) });
    if (afterId) q.set("afterId", afterId);
    let rows;
    try {
      rows = await api.request("GET", `/api/companies/${companyId}/issues?${q}`);
    } catch (err) {
      // Older Paperclip without keyset paging: one large page instead.
      if (page === 0 && (err.status === 400 || err.status === 422)) {
        const fallback = await api.request("GET", `/api/companies/${companyId}/issues?status=${statuses}&limit=1000`);
        return Array.isArray(fallback) ? fallback : [];
      }
      throw err;
    }
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    afterId = rows.at(-1)?.id;
    if (!afterId) break;
  }
  return out;
}

// Every agent in a company.
export async function companyAgents(api, companyId) {
  const list = await api.request("GET", `/api/companies/${companyId}/agents`);
  return Array.isArray(list) ? list : [];
}

// The issue prefixes (ACM in ACM-6) of every company the key can see.
export async function companyPrefixes(api, companyIds) {
  const prefixes = [];
  for (const companyId of companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => null);
    const prefix = String(company?.issuePrefix ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (prefix && !prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}
