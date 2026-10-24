// Small units with no service around them: the state store's cap, the relay's
// notes document, the price file, hold-release safety, answered cards, issue
// paging, the GitHub client's retries, config ranges, usage counts, and the fake
// Paperclip's own review decisions.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup, tempDir } from "./helpers.mjs";
import { ids } from "./fake-paperclip.mjs";
import { BoundedMap, createStateStore } from "../src/store.mjs";
import { withEntry } from "../src/quiet-notes.mjs";
import { loadPrices } from "../src/prices.mjs";
import { processAlive, releaseProblems } from "../src/release.mjs";
import { answeredCards } from "../src/board-held.mjs";
import { listIssues } from "../src/paperclip.mjs";
import { createGitHub } from "../src/github.mjs";
import { loadConfig } from "../src/config.mjs";
import { summarize } from "../src/usage.mjs";

const logger = () => {
  const lines = [];
  const log = (msg, extra) => lines.push({ level: "info", msg, ...extra });
  log.warn = (msg, extra) => lines.push({ level: "warn", msg, ...extra });
  log.debug = () => {};
  return { log, lines };
};

test("the state store's cap never drops a record of something still going on", () => {
  const map = new BoundedMap([], 3, (key) => key.startsWith("live:"));
  map.set("live:a", 1);
  for (let i = 0; i < 10; i++) map.set(`count:${i}`, i);
  assert.equal(map.size, 3);
  assert.equal(map.has("live:a"), true);
  assert.deepEqual(map.entries().map(([k]) => k), ["live:a", "count:8", "count:9"]);
  // With nothing else left to drop, even a kept one goes: the cap holds.
  const full = new BoundedMap([], 2, () => true);
  for (const k of ["a", "b", "c"]) full.set(k, 1);
  assert.deepEqual(full.entries().map(([k]) => k), ["b", "c"]);

  // The watchdog's own: a routed card still open, an agent's pause, a usage-limit pause.
  const store = createStateStore(path.join(tempDir(), "state.json"));
  store.nudges.set("question:c1", { relayId: "i1", count: 1, at: 0 });
  store.nudges.set("agent-paused:a1", { since: 0, count: 1, at: 0 });
  store.nudges.set("limit:co:acct", { resetAt: 0, count: 1, at: 0 });
  for (let i = 0; i < 2100; i++) store.nudges.set(`nudge:${i}`, { count: 1, at: 0 });
  for (const key of ["question:c1", "agent-paused:a1", "limit:co:acct"]) assert.equal(store.nudges.has(key), true, key);
  assert.equal(store.nudges.size, 2000);
});

test("the relay's notes document drops its own oldest lines past 200, never a person's", () => {
  const relayLine = (i) => `- 2026-10-${String(1 + (i % 28)).padStart(2, "0")} 09:${String(i % 60).padStart(2, "0")} UTC: PR #${i} opened`;
  const body = ["# Pull requests", "", "- my own note: PR #3 is the one to watch", ...Array.from({ length: 200 }, (_, i) => relayLine(i))].join("\n");
  const next = withEntry(body, relayLine(999)).split("\n");
  assert.ok(next.includes("- my own note: PR #3 is the one to watch"));
  assert.equal(next.filter((l) => / UTC: PR #/.test(l)).length, 200);
  assert.ok(!next.includes(relayLine(0)), "the oldest of the relay's own went");
  assert.equal(next.at(-2), relayLine(999));
});

test("a malformed prices file is reported and left where it is, and the built-in prices are used", () => {
  const dir = tempDir();
  const file = path.join(dir, "prices.json");
  fs.writeFileSync(file, '{ "models": { "gpt-x": [ { "input": 1, }, ] } }');
  const { log, lines } = logger();
  const table = loadPrices(file, log);
  assert.ok(Object.keys(table.models).length > 0, "built-in prices");
  assert.equal(lines.filter((l) => l.level === "warn" && /could not read the prices file/.test(l.msg)).length, 1);
  assert.equal(fs.existsSync(file), true, "not renamed");
  assert.deepEqual(fs.readdirSync(dir), ["prices.json"]);
  // No file at all is normal: no warning.
  const quiet = logger();
  loadPrices(path.join(dir, "none.json"), quiet.log);
  assert.equal(quiet.lines.length, 0);
});

test("a hold isn't released while its run's process, or process group, is alive on this host", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(2 ** 30), false);
  const hold = { runId: "r1", recoveryActionId: "a1" };
  const ended = { status: "failed", processPid: null, processGroupId: null };
  assert.deepEqual(releaseProblems({ hold, run: ended }), []);
  assert.deepEqual(releaseProblems({ hold, run: { ...ended, processPid: process.pid } }), [`process ${process.pid} is still alive on this host`]);
  assert.deepEqual(releaseProblems({ hold, run: { ...ended, processPid: 2 ** 30 } }), []);
  // A process group is checked as one (a negative pid).
  const group = process.platform === "win32" ? null : process.getpgid?.(process.pid) ?? null;
  if (group) assert.match(releaseProblems({ hold, run: { ...ended, processGroupId: group } }).join(), new RegExp(`process ${group} is still alive`));
  assert.match(releaseProblems({ hold, run: { status: "running" } }).join(), /still running/);
  assert.match(releaseProblems({ hold: { runId: "r1" }, run: ended }).join(), /names no source run or recovery action/);
  assert.match(releaseProblems({ hold, run: ended, activeRun: true }).join(), /another run on the issue is active/);
});

test("which answered cards were meant to wake the agent that asked", () => {
  const card = (extra) => ({ id: "c", createdByAgentId: "a1", status: "answered", resolvedByUserId: "u", resolvedAt: "2026-10-24T09:00:00Z", ...extra });
  const pick = (cards) => answeredCards(cards, "a1").map((c) => c.id);
  assert.deepEqual(pick([card({ id: "plain" })]), ["plain"], "older Paperclip: every answer wakes");
  assert.deepEqual(pick([card({ id: "wake", continuationPolicy: "wake_assignee" })]), ["wake"]);
  assert.deepEqual(pick([card({ id: "never", continuationPolicy: "none" })]), []);
  assert.deepEqual(
    pick(["accepted", "answered", "rejected"].map((status) => card({ id: status, status, continuationPolicy: "wake_assignee_on_accept" }))),
    ["accepted", "answered"],
  );
  assert.deepEqual(pick([card({ id: "plan", kind: "request_confirmation", status: "rejected", continuationPolicy: "none" })]), ["plan"], "a rejected plan goes back to its author");
  assert.deepEqual(pick([card({ id: "agent", resolvedByUserId: null })]), [], "answered by an agent");
  assert.deepEqual(pick([card({ id: "other", createdByAgentId: "a2" })]), [], "another agent's card");
  assert.deepEqual(pick([card({ id: "pending", status: "pending" })]), []);
  assert.deepEqual(pick([card({ id: "undated", resolvedAt: null })]), []);
});

test("issue listing: one large page on a Paperclip without paging; a later page's failure is thrown, never a partial list", async () => {
  const calls = [];
  const old = {
    async request(method, url) {
      calls.push(url);
      if (url.includes("sortField")) throw Object.assign(new Error("bad query"), { status: 400 });
      return [{ id: "i1" }, { id: "i2" }];
    },
  };
  assert.deepEqual(await listIssues(old, "co", "todo"), [{ id: "i1" }, { id: "i2" }]);
  assert.match(calls.at(-1), /status=todo&limit=1000$/);

  let page = 0;
  const flaky = {
    async request() {
      page += 1;
      if (page === 1) return [{ id: "a" }, { id: "b" }];
      throw Object.assign(new Error("Paperclip is down"), { status: 503 });
    },
  };
  await assert.rejects(listIssues(flaky, "co", "todo", { pageSize: 2 }), /Paperclip is down/);
});

test("the GitHub client retries a read once (a 5xx, a dropped connection, a short secondary rate limit), never a write", async () => {
  const config = { githubApi: "https://api.github.test", timeoutSec: 5, githubToken: "t", version: "test" };
  const answers = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers ?? {} });
  };
  const slept = [];
  const gh = createGitHub({ config, fetchImpl, sleep: async (ms) => slept.push(ms) });

  answers.push({ status: 502 }, { status: 200, body: { ok: 1 } });
  assert.deepEqual(await gh.request("GET", "/repos/o/r"), { ok: 1 });
  answers.push(new TypeError("fetch failed"), { status: 200, body: { ok: 2 } });
  assert.deepEqual(await gh.request("GET", "/repos/o/r"), { ok: 2 });
  answers.push({ status: 403, headers: { "retry-after": "3" }, body: { message: "secondary rate limit" } }, { status: 200, body: { ok: 3 } });
  assert.deepEqual(await gh.request("GET", "/repos/o/r"), { ok: 3 });
  assert.deepEqual(slept, [1000, 1000, 3000]);

  // A write is never retried; nor a read twice; nor a refusal a retry can't fix.
  calls.length = 0;
  answers.push({ status: 502 });
  await assert.rejects(gh.request("POST", "/repos/o/r/issues/1/comments", { body: "x" }));
  assert.equal(calls.length, 1);
  answers.push({ status: 502 }, { status: 502 });
  await assert.rejects(gh.request("GET", "/repos/o/r"));
  assert.equal(calls.length, 3);
  answers.push({ status: 404, body: { message: "Not Found" } });
  await assert.rejects(gh.request("GET", "/repos/o/r/check-runs/1"), /needs "Checks: read"/);
  assert.equal(calls.length, 4);
});

test("config: a port outside 0–65535 is a problem", () => {
  assert.match(loadConfig({ RELAY_PORT: "99999" }).problems.join("\n"), /RELAY_PORT=99999 must be a number from 0 to 65535/);
  assert.equal(loadConfig({ RELAY_PORT: "3110" }).problems.length, 0);
});

test("pch usage counts an interrupted run, as a failure", () => {
  const agent = { id: "a1", name: "Carla", adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } };
  const run = (status) => ({ agentId: "a1", status, createdAt: new Date().toISOString(), usageJson: { inputTokens: 10, outputTokens: 5 } });
  const { rows } = summarize({ agents: [agent], runs: [run("succeeded"), run("interrupted"), run("running")], since: 0 });
  assert.equal(rows[0].runs, 2);
  assert.equal(rows[0].failed, 1);
});

test("the fake Paperclip decides a review as Paperclip does (issue-execution-policy.ts)", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { api } = env.ctx;
  const stage = (extra = {}) => ({ status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user }, returnAssignee: { type: "agent", agentId: "a-impl" }, ...extra });
  const issue = (n, executionState) => {
    const row = { id: `i-${n}`, identifier: `ACM-${n}`, companyId: ids.company, status: "in_review", assigneeUserId: ids.user, executionState };
    env.db.issues.push(row);
    return row;
  };

  // The participant approves the last stage: done, and the review is complete.
  const last = issue(1, stage());
  await api.request("PATCH", "/api/issues/ACM-1", { status: "done", comment: "Approved." });
  assert.equal(last.status, "done");
  assert.equal(last.executionState.status, "completed");
  assert.equal(last.executionState.lastDecisionOutcome, "approved");
  // A decision needs a comment.
  issue(2, stage());
  await assert.rejects(api.request("PATCH", "/api/issues/ACM-2", { status: "done" }), /requires a comment/);
  // Changes requested go back to the implementer.
  const back = issue(3, stage());
  await api.request("PATCH", "/api/issues/ACM-3", { status: "in_progress", comment: "Rename it." });
  assert.deepEqual([back.status, back.assigneeAgentId, back.executionState.status], ["in_progress", "a-impl", "changes_requested"]);
  // Anyone else moving it out of review decides nothing: the stage is gone.
  const other = issue(4, stage({ currentStageType: "review", currentParticipant: { type: "agent", agentId: "a-qa" } }));
  await api.request("PATCH", "/api/issues/ACM-4", { status: "todo" });
  assert.deepEqual([other.status, other.executionState], ["todo", null]);
});
