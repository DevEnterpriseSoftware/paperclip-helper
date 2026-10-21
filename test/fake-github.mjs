// A small in-memory stand-in for the parts of GitHub's REST API the relay uses.
// Tests seed `pulls`, run a sweep, then inspect `comments` and `requests`.

import http from "node:http";

// A pull request as GitHub lists it. `mergeable` is only served on the single-PR
// route; an array is served one value per read (null = still being worked out).
export const pull = (number, extra = {}) => ({
  number,
  state: "open",
  draft: false,
  title: `ACM-1: change ${number}`,
  body: "",
  html_url: `https://github.com/org/app/pull/${number}`,
  head: { ref: `change-${number}`, sha: `sha-${number}-a` },
  base: { ref: "main" },
  mergeable: true,
  ...extra,
});

export async function startFakeGitHub({ token = "ghp_testtoken0123456789abcdef" } = {}) {
  const repos = {}; // "org/app" → repository metadata, including default_branch
  const branches = {}; // "org/app" → { [name]: branch }
  const pulls = {}; // "org/app" → [pull]
  const runs = {}; // "org/app" → { [runId]: workflow run, with `jobs` (served on the jobs route) and `onRerun(run)` }
  const reruns = []; // { repo, id }
  const comments = []; // { repo, number, body }
  const requests = [];
  const fail = {}; // "POST comments" or "GET pull 8" → status
  // The token GitHub accepts. A test renews it (as a GitHub App's hourly token is) by setting `current.token`.
  const current = { token };

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://github");
      requests.push({ method: req.method, path: url.pathname + url.search });
      if (req.headers.authorization !== `Bearer ${current.token}`) return send(res, 401, { message: "Bad credentials" });
      let m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
      if (m && req.method === "GET") {
        if (fail["GET repo"]) return send(res, fail["GET repo"], { message: "Server Error" });
        return repos[m[1]] ? send(res, 200, repos[m[1]]) : send(res, 404, { message: "Not Found" });
      }
      m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/);
      if (m && req.method === "GET") {
        const branch = branches[m[1]]?.[decodeURIComponent(m[2])];
        return branch ? send(res, 200, branch) : send(res, 404, { message: "Not Found" });
      }
      m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
      if (m && req.method === "GET") {
        const base = url.searchParams.get("base");
        // state defaults to open, like GitHub; head is "owner:branch".
        const state = url.searchParams.get("state") ?? "open";
        const head = url.searchParams.get("head");
        const rows = (pulls[m[1]] ?? []).filter(
          (p) =>
            (state === "all" || p.state === state) &&
            (!base || p.base.ref === base) &&
            (!head || `${m[1].split("/")[0]}:${p.head.ref}` === head),
        );
        // The list never says whether a PR merges.
        return send(res, 200, rows.map(({ mergeable, ...rest }) => rest));
      }
      m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
      if (m && req.method === "GET") {
        const found = (pulls[m[1]] ?? []).find((p) => p.number === Number(m[2]));
        if (!found) return send(res, 404, { message: "Not Found" });
        if (fail[`GET pull ${m[2]}`]) return send(res, fail[`GET pull ${m[2]}`], { message: "Server Error" });
        const mergeable = Array.isArray(found.mergeable)
          ? found.mergeable.length > 1
            ? found.mergeable.shift()
            : found.mergeable[0]
          : found.mergeable;
        return send(res, 200, { ...found, mergeable });
      }
      m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(\/jobs|\/rerun-failed-jobs)?$/);
      if (m) {
        const run = runs[m[1]]?.[m[2]];
        if (!run) return send(res, 404, { message: "Not Found" });
        if (m[3] === "/jobs" && req.method === "GET") return send(res, 200, { total_count: (run.jobs ?? []).length, jobs: run.jobs ?? [] });
        if (m[3] === "/rerun-failed-jobs" && req.method === "POST") {
          if (fail["POST rerun"]) return send(res, fail["POST rerun"], { message: "Resource not accessible by integration" });
          reruns.push({ repo: m[1], id: m[2] });
          run.onRerun?.(run);
          return send(res, 201, {});
        }
        if (!m[3] && req.method === "GET") {
          const { jobs, onRerun, ...rest } = run;
          return send(res, 200, rest);
        }
      }
      m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
      if (m && req.method === "POST") {
        if (fail["POST comments"]) return send(res, fail["POST comments"], { message: "Resource not accessible by personal access token" });
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")).body;
        comments.push({ repo: m[1], number: Number(m[2]), body });
        return send(res, 201, { id: comments.length });
      }
      send(res, 404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    current,
    repos,
    branches,
    pulls,
    runs,
    reruns,
    comments,
    requests,
    fail,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
