import { test } from "node:test";
import assert from "node:assert/strict";
import { createTickReads, OPEN_ISSUE_STATUSES, requestKind } from "../src/tick-reads.mjs";
import { listIssues } from "../src/paperclip.mjs";

// A Paperclip client that answers from `answers` (path → value or function) and records every request.
function stubApi(answers = {}) {
  const calls = [];
  return {
    calls,
    base: "http://paperclip.test",
    async request(method, path, body) {
      calls.push(`${method} ${path}`);
      const a = Object.entries(answers).find(([k]) => path.startsWith(k))?.[1];
      if (a instanceof Error) throw a;
      return typeof a === "function" ? a(method, path, body) : structuredClone(a ?? null);
    },
  };
}

test("a read is shared between checks within a tick, never outside one", async () => {
  const api = stubApi({ "/api/issues/1/runs": [{ runId: "r1", status: "succeeded" }] });
  const reads = createTickReads(api);
  await reads.api.request("GET", "/api/issues/1/runs");
  await reads.api.request("GET", "/api/issues/1/runs");
  assert.equal(api.calls.length, 2, "outside a tick every request goes to Paperclip");

  reads.begin();
  const a = await reads.within("hand-offs", () => reads.api.request("GET", "/api/issues/1/runs"));
  const b = await reads.within("CI runs", () => reads.api.request("GET", "/api/issues/1/runs"));
  assert.equal(api.calls.length, 3);
  assert.deepEqual(a, b);
  // Each caller has its own copy.
  a[0].status = "changed";
  const c = await reads.within("waiting on you", () => reads.api.request("GET", "/api/issues/1/runs"));
  assert.equal(c[0].status, "succeeded");
  const t = reads.end();
  assert.equal(t.requests, 1);
  assert.equal(t.shared, 2);
});

test("a check reading again what it read before goes to Paperclip, even when another check read it first", async () => {
  let status = "in_review";
  const api = stubApi({ "/api/issues/1": () => ({ id: "1", status }) });
  const reads = createTickReads(api);
  reads.begin();
  await reads.within("paused-run holds", () => reads.api.request("GET", "/api/issues/1"));
  status = "done";
  const seen = await reads.within("waiting on you", async () => {
    const first = await reads.api.request("GET", "/api/issues/1"); // the other check's answer
    const again = await reads.api.request("GET", "/api/issues/1"); // read again before acting: fresh
    return [first.status, again.status];
  });
  assert.deepEqual(seen, ["in_review", "done"]);
  assert.equal(api.calls.length, 2);
  // The fresh answer is what a later check gets.
  const later = await reads.within("CI runs", () => reads.api.request("GET", "/api/issues/1"));
  assert.equal(later.status, "done");
  reads.end();
});

test("any change drops what the tick read, and an answer older than maxAgeMs isn't shared", async () => {
  let clock = 0;
  const api = stubApi({ "/api/issues/1": { id: "1" }, "/api/issues/1/comments": { id: "c" } });
  const reads = createTickReads(api, { clock: () => clock, maxAgeMs: 1000 });
  reads.begin();
  await reads.within("a", () => reads.api.request("GET", "/api/issues/1"));
  await reads.within("b", () => reads.api.request("POST", "/api/issues/1/comments", { body: "x" }));
  await reads.within("c", () => reads.api.request("GET", "/api/issues/1"));
  assert.equal(api.calls.filter((c) => c === "GET /api/issues/1").length, 2, "read again after the comment");
  clock += 1500;
  await reads.within("d", () => reads.api.request("GET", "/api/issues/1"));
  assert.equal(api.calls.filter((c) => c === "GET /api/issues/1").length, 3, "read again once too old");
  reads.end();
});

test("a failed read is shared too: the tick doesn't wait for the same timeout twice", async () => {
  const api = stubApi({ "/api/issues/1/runs": new Error("timeout") });
  const reads = createTickReads(api);
  reads.begin();
  await assert.rejects(reads.within("a", () => reads.api.request("GET", "/api/issues/1/runs")), /timeout/);
  await assert.rejects(reads.within("b", () => reads.api.request("GET", "/api/issues/1/runs")), /timeout/);
  assert.equal(api.calls.length, 1);
  reads.end();
});

test("listings of open statuses come from one listing per tick and company; others are asked as they are", async () => {
  const rows = [
    { id: "a", status: "todo" },
    { id: "b", status: "blocked" },
    { id: "c", status: "in_review" },
  ];
  const api = stubApi({ "/api/companies/co/issues": (m, path) => {
    const wanted = new URLSearchParams(path.split("?")[1]).get("status").split(",");
    return rows.filter((r) => wanted.includes(r.status));
  } });
  const reads = createTickReads(api);
  reads.begin();
  const blocked = await reads.within("blocked issues", () => listIssues(reads.api, "co", "blocked"));
  const watched = await reads.within("hand-offs", () => listIssues(reads.api, "co", "todo,in_progress,in_review"));
  const done = await reads.within("review stages", () => listIssues(reads.api, "co", "done"));
  assert.deepEqual(blocked.map((r) => r.id), ["b"]);
  assert.deepEqual(watched.map((r) => r.id), ["a", "c"]);
  assert.deepEqual(done, []);
  const listings = api.calls.filter((c) => c.includes("/issues?"));
  assert.equal(listings.length, 2);
  assert.match(listings[0], new RegExp(`status=${encodeURIComponent(OPEN_ISSUE_STATUSES.join(","))}`));
  assert.match(listings[1], /status=done/);
  reads.end();
});

test("a refused shared listing leaves each check to ask for its own", async () => {
  const api = stubApi({ "/api/companies/co/issues": (m, path) => {
    if (path.includes("backlog")) throw Object.assign(new Error("too big"), { status: 500 });
    return [{ id: "b", status: "blocked" }];
  } });
  const reads = createTickReads(api);
  reads.begin();
  const blocked = await reads.within("blocked issues", () => listIssues(reads.api, "co", "blocked"));
  assert.deepEqual(blocked.map((r) => r.id), ["b"]);
  reads.end();
});

test("the tick's counts name the slowest checks and kinds of request", async () => {
  let clock = 0;
  const api = stubApi({ "/api/issues/": () => { clock += 50; return {}; } });
  const reads = createTickReads(api, { clock: () => clock });
  reads.begin();
  await reads.within("quick", () => reads.api.request("GET", "/api/issues/11111111-1111-4111-8111-111111111111"));
  await reads.within("slow", async () => {
    for (const n of [2, 3, 4]) await reads.api.request("GET", `/api/issues/${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111/runs`);
  });
  const t = reads.end();
  assert.deepEqual(t.checks, [{ name: "slow", ms: 150, requests: 3 }, { name: "quick", ms: 50, requests: 1 }]);
  assert.deepEqual(t.slowest[0], { kind: "GET /api/issues/:id/runs", count: 3, ms: 150, avgMs: 50, maxMs: 50 });
  assert.equal(reads.end(), null, "nothing counted outside a tick");
});

test("requestKind leaves ids, identifiers and queries out", () => {
  assert.equal(requestKind("GET", "/api/issues/ACM-12/comments?order=desc&limit=3"), "GET /api/issues/:id/comments");
  assert.equal(requestKind("GET", "/api/companies/c0000000-0000-4000-8000-000000000001/issues?status=todo"), "GET /api/companies/:id/issues");
});
