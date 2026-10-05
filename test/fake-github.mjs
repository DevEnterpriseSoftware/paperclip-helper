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
  const pulls = {}; // "org/app" → [pull]
  const comments = []; // { repo, number, body }
  const requests = [];
  const fail = {}; // "POST comments" or "GET pull 8" → status

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
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: "Bad credentials" });
      let m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
      if (m && req.method === "GET") {
        const base = url.searchParams.get("base");
        const rows = (pulls[m[1]] ?? []).filter((p) => p.state === "open" && (!base || p.base.ref === base));
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
    pulls,
    comments,
    requests,
    fail,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
