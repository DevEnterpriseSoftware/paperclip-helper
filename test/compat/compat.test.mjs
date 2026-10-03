// Compatibility suite: the helper's own code against a real, throwaway Paperclip.
//
// The unit tests run against test/fake-paperclip.mjs, which only proves the
// helper agrees with our idea of Paperclip. This suite proves it agrees with
// Paperclip itself, for one version at a time:
//
//   npm run test:compat -- 2026.1001.0      boots that version, runs this, removes it
//   PAPERCLIP_COMPAT_API=http://127.0.0.1:3100 node --test test/compat/
//
// It needs a Paperclip in local_trusted mode (requests without a key act as the
// board, which is how the suite seeds companies, agents and issues) that holds
// nothing but earlier compat data. Agents use the `process` adapter with a shell
// one-liner, so runs, wakes and queues are real and no model is involved.
//
// Three layers:
//   1. Paperclip's OpenAPI document lists every endpoint the helper calls.
//   2. Each response carries the fields, and each write the semantics, the helper reads.
//   3. The helper's own components (login, watchdog, relay, cost sync, commands)
//      run end to end against situations reproduced on the real server.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext } from "../../src/context.mjs";
import { createStateStore } from "../../src/store.mjs";
import { companyAgents, companyPrefixes, listIssues } from "../../src/paperclip.mjs";
import { createWatchdog } from "../../src/watchdog.mjs";
import { createRelay } from "../../src/relay.mjs";
import { createCostSync } from "../../src/cost-sync.mjs";
import * as commands from "../../src/commands.mjs";
import { approvalWaitingOn } from "../../src/util.mjs";

const BASE = (process.env.PAPERCLIP_COMPAT_API ?? "").replace(/\/+$/, "");
const COMPANY_PREFIX = "pch-compat";
const OWNER = "compat-owner";

// Every Paperclip endpoint the helper calls, as OpenAPI path templates. The last
// test fails when the helper calls something that isn't listed, so this stays current.
const HELPER_ENDPOINTS = [
  ["GET", "/api/health"],
  ["POST", "/api/cli-auth/challenges"],
  ["GET", "/api/cli-auth/challenges/{id}"],
  ["GET", "/api/cli-auth/me"],
  ["POST", "/api/cli-auth/revoke-current"],
  ["GET", "/api/board-api-keys"],
  ["POST", "/api/board-api-keys"],
  ["GET", "/api/companies/{companyId}"],
  ["GET", "/api/companies/{companyId}/agents"],
  ["GET", "/api/companies/{companyId}/issues"],
  ["GET", "/api/companies/{companyId}/heartbeat-runs"],
  ["GET", "/api/companies/{companyId}/activity"],
  ["GET", "/api/companies/{companyId}/budgets/overview"],
  ["POST", "/api/companies/{companyId}/cost-events"],
  ["GET", "/api/heartbeat-runs/{runId}"],
  ["GET", "/api/heartbeat-runs/{runId}/events"],
  ["GET", "/api/agents/{id}"],
  ["PATCH", "/api/agents/{id}"],
  ["GET", "/api/issues/{id}"],
  ["PATCH", "/api/issues/{id}"],
  ["POST", "/api/issues/{id}/comments"],
  ["GET", "/api/issues/{id}/comments"],
  ["GET", "/api/issues/{id}/recovery-actions"],
  ["GET", "/api/issues/{id}/runs"],
  ["GET", "/api/issues/{id}/work-products"],
  ["GET", "/api/issues/{id}/diagnostics/wakes"],
  ["GET", "/api/issues/{id}/diagnostics/blockers"],
  ["GET", "/api/issues/{id}/queued-comments"],
  ["POST", "/api/issues/{id}/queued-comments/interrupt"],
  ["GET", "/api/execution-workspaces/{id}/workspace-operations"],
];
const templateRegex = (template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);

// The status values the helper's logic branches on. A value outside these sets
// would be treated as "finished" or "not pending" without anyone having decided so.
const RUN_STATUSES = new Set(["queued", "scheduled_retry", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const ACTIVE_RUN = new Set(["queued", "scheduled_retry", "running"]);
const AGENT_STATUSES = new Set(["active", "paused", "idle", "running", "error", "pending_approval", "terminated"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A request as the implicit local board, for seeding and for reading results back.
async function board(method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, data };
}

async function ok(method, apiPath, body) {
  const res = await board(method, apiPath, body);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${apiPath} → ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  return res.data;
}

async function until(label, fn, { timeoutMs = 45_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const hasKeys = (object, keys, what) => {
  for (const key of keys) assert.ok(object && key in object, `${what} has no "${key}" field (has: ${Object.keys(object ?? {}).join(", ")})`);
};
const isIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

async function captureOutput(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

if (!BASE) {
  test("compatibility suite", { skip: "set PAPERCLIP_COMPAT_API to a throwaway Paperclip, or use `npm run test:compat -- <version>`" }, () => {});
} else {
  describe(`helper against Paperclip at ${BASE}`, { concurrency: false }, () => {
    const s = { calls: [], logs: [], skew: 0 }; // shared across the tests, which run in order

    const runsOf = (issueId) => ok("GET", `/api/issues/${issueId}/runs`);
    const commentsOf = (issueId) => ok("GET", `/api/issues/${issueId}/comments`);
    const issue = (body) => ok("POST", `/api/companies/${s.company.id}/issues`, body);
    const agent = (name, script, extra = {}) =>
      ok("POST", `/api/companies/${s.company.id}/agents`, {
        name,
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "sh", args: ["-c", script], ...extra },
      });
    // Paperclip follows a run that left no comment with one more run, so "idle"
    // means no active run on two looks in a row.
    const settled = (issueId) =>
      until(`runs on ${issueId} to finish`, async () => {
        const quiet = async () => {
          const runs = await runsOf(issueId);
          return runs.length > 0 && !runs.some((r) => ACTIVE_RUN.has(r.status));
        };
        if (!(await quiet())) return false;
        await sleep(1500);
        return quiet();
      });
    // An issue whose review (and then approval) is waiting on the board user.
    const inReview = async (title, stages = ["review"]) => {
      const created = await issue({
        title,
        status: "todo",
        assigneeAgentId: s.alice.id,
        executionPolicy: { stages: stages.map((type) => ({ type, participants: [{ type: "user", userId: s.me.userId }] })) },
      });
      await settled(created.id);
      await ok("PATCH", `/api/issues/${created.id}`, { status: "in_review" });
      return created;
    };
    const pr = (identifier, number, extra = {}) => ({
      number,
      title: `${identifier}: compat change`,
      head: { ref: `${identifier.toLowerCase()}-compat` },
      body: `Closes ${identifier}`,
      html_url: `https://github.com/acme/app/pull/${number}`,
      base: { ref: "main" },
      merged: true,
      merge_commit_sha: "abcdef1234567890",
      ...extra,
    });
    const gh = (extra) => ({ repository: { full_name: "acme/app" }, sender: { login: OWNER }, ...extra });

    before(async () => {
      const health = await ok("GET", "/api/health");
      s.version = health.version ?? health.serverVersion ?? "unknown";
      assert.equal(
        health.deploymentMode,
        "local_trusted",
        "the compat suite seeds data as the implicit local board, so it needs a local_trusted Paperclip",
      );
      const companies = await ok("GET", "/api/companies");
      const foreign = companies.filter((c) => !String(c.name).startsWith(COMPANY_PREFIX));
      assert.equal(
        foreign.length,
        0,
        `this Paperclip holds real companies (${foreign.map((c) => c.name).join(", ")}). ` +
          "The suite runs the watchdog and relay over every company the key can see: point it at a throwaway instance.",
      );

      s.company = await ok("POST", "/api/companies", { name: `${COMPANY_PREFIX} ${new Date().toISOString()}` });
      s.alice = await agent("Alice", "echo alice");
      s.bob = await agent("Bob", "echo bob");
      s.slow = await agent("Slow", "sleep 25");
      s.oldModel = `compat-old-${Date.now()}`;
      s.modelled = await agent("Modelled", "echo modelled", { model: s.oldModel, effort: "high" });

      s.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pch-compat-"));
      // Every request the helper's client makes is recorded, and the login
      // challenge is approved the way the board would in the browser.
      const fetchImpl = async (url, init = {}) => {
        const { pathname } = new URL(url);
        const method = init.method ?? "GET";
        s.calls.push({ method, pathname });
        const res = await fetch(url, init);
        if (method === "POST" && pathname === "/api/cli-auth/challenges" && res.ok) {
          const challenge = await res.clone().json();
          await ok("POST", `/api/cli-auth/challenges/${challenge.id}/approve`, { token: challenge.token });
        }
        return res;
      };
      s.ctx = createContext({
        env: {
          PAPERCLIP_API: BASE,
          DATA_DIR: s.dataDir,
          PAPERCLIP_TIMEOUT_SEC: "30",
          LOG_LEVEL: "debug",
          WATCHDOG_STALL_SEC: "60",
          GITHUB_WEBHOOK_SECRET: "compat-secret",
          GITHUB_OWNER_LOGIN: OWNER,
          GITHUB_REPOS: "acme/app",
          RELAY_PORT: "0",
        },
        fetchImpl,
        write: (line) => s.logs.push(JSON.parse(line)),
        now: () => Date.now() + s.skew,
      });
      assert.deepEqual(s.ctx.problems, [], "the compat configuration is valid");
      s.state = createStateStore(s.ctx.config.stateFile);
    });

    after(() => {
      if (s.dataDir) fs.rmSync(s.dataDir, { recursive: true, force: true });
    });

    // ------------------------------------------------------------ 1. the API surface

    test("Paperclip's OpenAPI document lists every endpoint the helper calls", async (t) => {
      const res = await board("GET", "/api/openapi.json");
      if (res.status === 404) return t.skip("this Paperclip serves no /api/openapi.json");
      assert.equal(res.status, 200);
      const paths = res.data.paths ?? {};
      const missing = HELPER_ENDPOINTS.filter(([method, template]) => !paths[template]?.[method.toLowerCase()]).map((e) => e.join(" "));
      assert.deepEqual(missing, [], "endpoints the helper uses that Paperclip no longer documents");
    });

    // ------------------------------------------------------------ 2. key and identity

    test("pch login: the challenge, its approval and the named board key", async () => {
      const lines = await captureOutput(() => commands.login(s.ctx));
      assert.ok(lines.some((l) => l.includes("/cli-auth/")), "login prints an approval link");
      const token = fs.readFileSync(s.ctx.config.tokenFile, "utf8").trim();
      assert.match(token, /^pcp_board_/);

      const me = await s.ctx.identity({ refresh: true });
      s.me = me;
      hasKeys(me, ["userId", "companyIds", "source", "keyId", "user"], "GET /api/cli-auth/me");
      assert.equal(me.source, "board_key", "the saved key is used, not the implicit local board");
      assert.ok(me.companyIds.includes(s.company.id), "the key sees the company created for this run");

      const key = await commands.currentKey(s.ctx);
      assert.equal(key?.name, s.ctx.config.keyName, "the named key is listed by GET /api/board-api-keys");
      hasKeys(key, ["id", "name", "expiresAt"], "a board API key");
    });

    test("a wrong key is refused with 401, which the client explains", async () => {
      await assert.rejects(
        s.ctx.api.request("GET", "/api/cli-auth/me", undefined, { token: "pcp_board_0000000000000000000000000000000000000000000000" }),
        (err) => err.status === 401 && err.code === "unauthorized",
      );
    });

    test("companies and agents carry what the helper reads", async () => {
      const prefixes = await companyPrefixes(s.ctx.api, [s.company.id]);
      assert.deepEqual(prefixes, [String(s.company.issuePrefix).toUpperCase()]);
      assert.ok(s.ctx.prefixes().includes(prefixes[0]), "identity() picked the prefix up");

      const agents = await companyAgents(s.ctx.api, s.company.id);
      assert.equal(agents.length, 4);
      for (const a of agents) {
        hasKeys(a, ["id", "name", "status", "adapterType", "adapterConfig", "companyId"], "an agent");
        assert.ok(AGENT_STATUSES.has(a.status), `agent status "${a.status}" is one the helper knows`);
      }
    });

    // ------------------------------------------------------------ 3. issues

    test("issue list: status filter, keyset paging and the parent filter", async () => {
      const parent = await issue({ title: "List parent", status: "backlog" });
      const children = [];
      for (let i = 0; i < 5; i += 1) children.push(await issue({ title: `List child ${i}`, status: "backlog", parentId: parent.id }));

      const before = s.calls.length;
      const listed = await listIssues(s.ctx.api, s.company.id, "backlog", { pageSize: 2 });
      const requests = s.calls.slice(before);
      assert.deepEqual(listed.map((i) => i.id).sort(), [parent, ...children].map((i) => i.id).sort(), "every issue once, across pages");
      assert.ok(requests.length >= 3, "the list was read page by page (afterId is honoured), not through the one-page fallback");
      for (const row of listed) {
        hasKeys(row, ["id", "identifier", "status", "assigneeAgentId", "executionRunId", "checkoutRunId", "updatedAt", "companyId"], "an issue list row");
        assert.equal(row.status, "backlog");
        assert.ok(isIso(row.updatedAt));
      }
      assert.deepEqual(await listIssues(s.ctx.api, s.company.id, "cancelled"), [], "the status filter filters");

      const byParent = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/issues?parentId=${parent.id}&limit=100`);
      assert.deepEqual(byParent.map((i) => i.id).sort(), children.map((i) => i.id).sort());
    });

    test("an issue is read by identifier, with its blockers, execution state and hold", async () => {
      const blocker = await issue({ title: "Detail blocker", status: "backlog" });
      const dependent = await issue({ title: "Detail dependent", status: "blocked", blockedByIssueIds: [blocker.id] });
      const full = await s.ctx.api.request("GET", `/api/issues/${encodeURIComponent(dependent.identifier)}`);
      assert.equal(full.id, dependent.id, "GET /api/issues/:identifier resolves an identifier");
      hasKeys(
        full,
        ["status", "companyId", "assigneeAgentId", "blockedBy", "executionState", "executionBlocker", "executionWorkspaceId", "executionRunId", "checkoutRunId"],
        "an issue",
      );
      assert.deepEqual(full.blockedBy.map((b) => b.id), [blocker.id]);

      const diag = await s.ctx.api.request("GET", `/api/issues/${dependent.id}/diagnostics/blockers`);
      assert.equal(diag.readiness.allBlockersDone, false);
      assert.equal(diag.blockers.length, 1);
      hasKeys(diag.blockers[0], ["id", "identifier", "status", "isPendingFinalize"], "a blocker in the diagnostics");
      hasKeys(diag.readiness, ["allBlockersDone", "isDependencyReady", "unresolvedBlockerCount", "pendingFinalizeBlockerCount"], "blocker readiness");

      assert.deepEqual(await s.ctx.api.request("GET", `/api/issues/${dependent.id}/work-products`), []);
      const unknown = await board("GET", "/api/execution-workspaces/00000000-0000-4000-8000-000000000001/workspace-operations");
      assert.equal(unknown.status, 404, "an unknown execution workspace is a 404, which the helper treats as no operations");
    });

    test("a board comment wakes the assignee, and runs and wakes read as expected", async () => {
      s.work = await issue({ title: "Work", status: "todo", assigneeAgentId: s.alice.id });
      await settled(s.work.id);
      const before = (await runsOf(s.work.id)).length;

      const posted = await s.ctx.api.request("POST", `/api/issues/${s.work.id}/comments`, { body: "compat: please look again" });
      assert.ok(posted.id, "POST comments returns the comment");
      // What `pch why` quotes, and how the watchdog finds an issue Paperclip's recovery parked.
      const latest = await s.ctx.api.request("GET", `/api/issues/${s.work.id}/comments?order=desc&limit=3`);
      assert.ok(Array.isArray(latest) && latest.length >= 1 && latest.length <= 3, "comments are listed, and limit is honoured");
      assert.equal(latest[0].id, posted.id, "comments are listed newest first with order=desc");
      hasKeys(latest[0], ["body", "authorUserId", "authorAgentId", "createdAt"], "a comment");
      const parked = await s.ctx.api.request("GET", `/api/issues/${s.work.id}/recovery-actions`);
      hasKeys(parked, ["active", "actions"], "the recovery-actions snapshot");
      assert.equal(parked.active, null, "an issue nobody parked has no active recovery action");
      const runs = await until("a run started by the comment", async () => {
        const list = await runsOf(s.work.id);
        return list.length > before ? list : null;
      });
      for (const run of runs) {
        assert.ok(run.runId ?? run.id, "a run has an id");
        hasKeys(run, ["agentId", "status", "createdAt", "startedAt", "finishedAt", "errorCode"], "an issue run");
        assert.ok(RUN_STATUSES.has(run.status), `run status "${run.status}" is one the helper knows`);
        assert.equal(run.agentId, s.alice.id);
      }
      assert.ok(Date.parse(runs[0].createdAt) >= Date.parse(runs.at(-1).createdAt), "runs are listed newest first");

      const wakes = await s.ctx.api.request("GET", `/api/issues/${s.work.id}/diagnostics/wakes`);
      hasKeys(wakes, ["issue", "events"], "wake diagnostics");
      const requests = wakes.events.filter((e) => e.kind === "wake_request");
      assert.ok(requests.length > 0, "wake requests are listed as kind wake_request");
      for (const e of requests) hasKeys(e, ["agentId", "status", "reason", "requestedAt"], "a wake request");
      assert.ok(requests.every((e) => e.agentId === s.alice.id), "wake requests carry the agent's id");
      assert.ok(Date.parse(requests[0].requestedAt) >= Date.parse(requests.at(-1).requestedAt), "wakes are listed newest first");
    });

    test("a comment during a run is held in the queue the watchdog reads, and interrupt takes its body", async () => {
      const slow = await issue({ title: "Slow", status: "todo", assigneeAgentId: s.slow.id });
      const running = await until("the slow run to start", async () => (await runsOf(slow.id)).find((r) => r.status === "running"));
      const live = await s.ctx.api.request("GET", `/api/issues/${slow.id}`);
      assert.ok(live.executionRunId, "an issue with a running run carries executionRunId, which keeps the watchdog off it");

      await s.ctx.api.request("POST", `/api/issues/${slow.id}/comments`, { body: "compat: sent while running" });
      const queue = await until("the comment to be queued", async () => {
        const q = await s.ctx.api.request("GET", `/api/issues/${slow.id}/queued-comments`);
        return q.entries?.length ? q : null;
      });
      hasKeys(queue, ["queueId", "state", "protocol", "revision", "targetRunId", "entries"], "the queued-comments snapshot");
      assert.equal(queue.state, "deferred");
      assert.equal(queue.protocol, "legacy", "a process agent's queue uses the protocol the watchdog can re-send");
      assert.equal(queue.targetRunId, running.runId ?? running.id, "a queue behind a running run names it, so the watchdog leaves it alone");
      assert.equal(queue.entries[0].comment.body, "compat: sent while running");

      // The watchdog's request body, against a queue that isn't there: accepted as a
      // request (409, the queue moved on), not rejected as malformed (400).
      const gone = await board("POST", `/api/issues/${slow.id}/queued-comments/interrupt`, {
        queueId: "00000000-0000-4000-8000-000000000001",
        revision: queue.revision,
        targetRunId: null,
      });
      assert.equal(gone.status, 409, `interrupt with the watchdog's body: ${JSON.stringify(gone.data)}`);
      const stale = await board("POST", `/api/issues/${slow.id}/queued-comments/interrupt`, {
        queueId: queue.queueId,
        revision: "stale",
        targetRunId: null,
      });
      assert.equal(stale.status, 409, "a stale revision is refused");
      assert.ok((await runsOf(slow.id)).some((r) => r.status === "running"), "none of that interrupted the running run");
    });

    test("a paused task refuses board comments the way the watchdog recognises", async () => {
      const paused = await issue({ title: "Paused", status: "todo", assigneeAgentId: s.alice.id });
      await settled(paused.id);
      await ok("POST", `/api/issues/${paused.id}/tree-holds`, { mode: "pause", reason: "compat" });
      const refused = (err) => err.status === 409 && /paused/i.test(err.message);
      await assert.rejects(s.ctx.api.request("POST", `/api/issues/${paused.id}/comments`, { body: "compat" }), refused);
      await assert.rejects(s.ctx.api.request("PATCH", `/api/issues/${paused.id}`, { comment: "compat", blockedByIssueIds: [] }), refused);
    });

    test("one PATCH detaches blockers, moves the issue and comments (the failed-finalize repair)", async () => {
      const blocker = await issue({ title: "Repair blocker", status: "todo" });
      const other = await issue({ title: "Repair other blocker", status: "todo" });
      const dependent = await issue({ title: "Repair dependent", status: "blocked", assigneeAgentId: s.alice.id, blockedByIssueIds: [blocker.id, other.id] });

      await s.ctx.api.request("PATCH", `/api/issues/${dependent.id}`, { blockedByIssueIds: [other.id], comment: "compat: one blocker detached" });
      let full = await s.ctx.api.request("GET", `/api/issues/${dependent.id}`);
      assert.deepEqual(full.blockedBy.map((b) => b.id), [other.id]);
      assert.equal(full.status, "blocked", "still blocked while a blocker remains");

      await s.ctx.api.request("PATCH", `/api/issues/${dependent.id}`, { blockedByIssueIds: [], status: "todo", comment: "compat: nothing blocks this now" });
      full = await s.ctx.api.request("GET", `/api/issues/${dependent.id}`);
      assert.deepEqual(full.blockedBy, []);
      assert.notEqual(full.status, "blocked");
      const bodies = (await commentsOf(dependent.id)).map((c) => c.body);
      assert.ok(bodies.includes("compat: one blocker detached") && bodies.includes("compat: nothing blocks this now"), "the PATCH's comment is posted");
      await until("the repair's comment to wake the assignee", async () => (await runsOf(dependent.id)).length > 0);
    });

    // ------------------------------------------------------------ 4. the watchdog, for real

    test("watchdog: a hand-off whose wake was dropped is nudged, and the nudge starts the new owner", async (t) => {
      const handed = await issue({ title: "Hand-off", status: "todo", assigneeAgentId: s.alice.id });
      await settled(handed.id);
      // Reproduce a dropped hand-off wake: the new owner is paused while the issue
      // changes hands, so Paperclip skips the wake and never sends it again.
      await ok("POST", `/api/agents/${s.bob.id}/pause`, {});
      await ok("PATCH", `/api/issues/${handed.id}`, { assigneeAgentId: s.bob.id });
      await sleep(1500);
      await ok("POST", `/api/agents/${s.bob.id}/resume`, {});
      await sleep(3000);
      if ((await runsOf(handed.id)).some((r) => r.agentId === s.bob.id)) {
        return t.skip("this Paperclip woke the new owner by itself, so there was no dropped hand-off to repair");
      }

      const watchdog = createWatchdog(s.ctx, s.state);
      const nudges = async () => (await commentsOf(handed.id)).filter((c) => c.body.includes("Paperclip Helper watchdog"));

      await watchdog.tick();
      assert.equal((await nudges()).length, 0, "nothing is nudged inside the stall window");

      s.skew = 10 * 60_000; // ten minutes later
      await watchdog.tick();
      const posted = await nudges();
      assert.equal(posted.length, 1, `one nudge on the handed-off issue (log: ${JSON.stringify(s.logs.filter((l) => /watchdog/.test(l.msg ?? l.message ?? "")).slice(-3))})`);
      assert.ok(posted[0].body.startsWith(`[@Bob](agent://${s.bob.id}) this issue is yours now`), posted[0].body);
      assert.ok(watchdog.stats.nudges >= 1);
      assert.equal(watchdog.stats.lastError, null);

      await until("the nudge to start the new owner", async () => (await runsOf(handed.id)).some((r) => r.agentId === s.bob.id));
      await settled(handed.id);
      s.skew = 30 * 60_000;
      await watchdog.tick();
      assert.equal((await nudges()).length, 1, "once the owner has run, the issue is left alone");
      s.skew = 0;
    });

    test("watchdog: issues that are progressing normally are never touched", async () => {
      // Everything seeded so far, looked at an hour later: runs by the current
      // owner, a blocked issue with an open blocker, a paused task, a running run.
      const before = new Map();
      const issues = await ok("GET", `/api/companies/${s.company.id}/issues?limit=1000`);
      for (const i of issues) before.set(i.id, (await commentsOf(i.id)).length);
      s.skew = 60 * 60_000;
      const watchdog = createWatchdog(s.ctx, createStateStore(path.join(s.dataDir, "fresh-state.json")));
      await watchdog.tick();
      s.skew = 0;
      assert.equal(watchdog.stats.lastError, null);
      const touched = [];
      for (const i of issues) if ((await commentsOf(i.id)).length !== before.get(i.id)) touched.push(i.title);
      assert.deepEqual(touched, [], "issues the watchdog commented on without cause");
      const failed = s.logs.filter((l) => /check failed/.test(JSON.stringify(l)));
      assert.deepEqual(failed, [], "no per-issue check failed against the real API");
    });

    // ------------------------------------------------------------ 5. the relay, for real

    test("relay: a merge approves the review stage and the approval stage after it", async () => {
      const reviewed = await inReview("Two-stage review", ["review", "approval"]);
      const waiting = await s.ctx.api.request("GET", `/api/issues/${reviewed.id}`);
      hasKeys(waiting.executionState, ["status", "currentStageType", "currentParticipant"], "an issue's executionState");
      assert.ok(approvalWaitingOn(waiting, s.me.userId), `the review waits on the board user: ${JSON.stringify(waiting.executionState)}`);
      const row = (await listIssues(s.ctx.api, s.company.id, "in_review")).find((i) => i.id === reviewed.id);
      assert.equal(row.status, "in_review", "the issue is listed as in_review, which is what makes the relay read it in full");

      const relay = createRelay(s.ctx, s.state);
      const result = await relay.handle("pull_request", gh({ action: "closed", pull_request: pr(reviewed.identifier, 11) }));
      assert.deepEqual(result, { identifier: reviewed.identifier, action: "approve", status: "done", stages: ["review", "approval"] });
      const done = await s.ctx.api.request("GET", `/api/issues/${reviewed.id}`);
      assert.equal(done.status, "done");
      assert.ok((await commentsOf(reviewed.id)).some((c) => c.body.includes("Approved: PR #11 merged")), "the decision's comment is on the issue");
    });

    test("relay: Request changes sends the issue back, and a new PR is linked by a comment", async () => {
      const reviewed = await inReview("Changes requested");
      const relay = createRelay(s.ctx, s.state);

      const opened = await relay.handle("pull_request", gh({ action: "opened", pull_request: pr(reviewed.identifier, 12, { merged: false }) }));
      assert.deepEqual(opened, { identifier: reviewed.identifier, action: "comment" });

      const result = await relay.handle(
        "pull_request_review",
        gh({
          action: "submitted",
          pull_request: pr(reviewed.identifier, 12, { merged: false }),
          review: { id: 1, state: "changes_requested", body: "compat: please rename it", html_url: "https://github.com/acme/app/pull/12#pullrequestreview-1" },
        }),
      );
      assert.equal(result.action, "changes");
      const back = await s.ctx.api.request("GET", `/api/issues/${reviewed.id}`);
      assert.notEqual(back.status, "in_review", "the issue left review");
      assert.notEqual(back.status, "done");
      assert.equal(back.assigneeAgentId, s.alice.id, "it is back with the engineer");
      const bodies = (await commentsOf(reviewed.id)).map((c) => c.body);
      assert.ok(bodies.some((b) => b.includes("https://github.com/acme/app/pull/12") && b.includes("opened")), "the PR's URL was posted");
      assert.ok(bodies.some((b) => b.includes("compat: please rename it")), "the review text became the comment");
    });

    test("relay: a merge for an issue that isn't waiting on you only comments", async () => {
      const relay = createRelay(s.ctx, s.state);
      const result = await relay.handle("pull_request", gh({ action: "closed", pull_request: pr(s.work.identifier, 13) }));
      assert.equal(result.action, "comment");
      assert.equal(result.reason, "decision is not waiting on you");
      assert.notEqual((await s.ctx.api.request("GET", `/api/issues/${s.work.id}`)).status, "done");
    });

    // ------------------------------------------------------------ 6. cost sync

    test("cost sync: run records, the cost event it posts, and the guards it reads", async () => {
      const runs = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/heartbeat-runs?limit=1000`);
      assert.ok(Array.isArray(runs) && runs.length > 0);
      for (const run of runs) {
        hasKeys(run, ["id", "agentId", "status", "finishedAt", "createdAt", "usageJson", "contextSnapshot"], "a heartbeat run");
        assert.ok(RUN_STATUSES.has(run.status), `run status "${run.status}" is one the helper knows`);
      }
      const run = runs.find((r) => r.status === "succeeded" && r.contextSnapshot?.issueId);
      assert.ok(run, "a finished run names its issue in contextSnapshot.issueId");

      const detail = await s.ctx.api.request("GET", `/api/heartbeat-runs/${run.id}`);
      hasKeys(detail, ["resultJson", "usageJson"], "a heartbeat run's detail");
      const events = await s.ctx.api.request("GET", `/api/heartbeat-runs/${run.id}/events?limit=1000`);
      const invoke = events.find((e) => e.eventType === "adapter.invoke");
      assert.ok(invoke, "a run logs an adapter.invoke event");
      assert.ok(Array.isArray(invoke.payload?.commandArgs), "adapter.invoke carries payload.commandArgs, where Codex fast mode is read");
      assert.ok(events[0].seq <= events.at(-1).seq, "events are listed oldest first");

      // Exactly the body cost-sync.mjs posts.
      const event = await s.ctx.api.request("POST", `/api/companies/${s.company.id}/cost-events`, {
        agentId: run.agentId,
        heartbeatRunId: run.id,
        issueId: run.contextSnapshot.issueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        costStatus: "reported",
        model: "compat-model",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 3,
        occurredAt: new Date(run.finishedAt).toISOString(),
      });
      assert.equal(event.costCents, 3);
      assert.equal(event.heartbeatRunId, run.id);

      const activity = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/activity?entityType=cost_event&limit=500`);
      const rows = Array.isArray(activity) ? activity : activity.items;
      assert.ok(
        rows.some((a) => a.action === "cost.reported" && a.actorType === "user" && a.actorId === s.me.userId && a.entityId === event.id),
        "the post is in the activity log as cost.reported by the key's user, which guards against posting twice after a lost state file",
      );
      const budgets = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/budgets/overview`);
      assert.ok(Array.isArray(budgets.policies));
    });

    test("cost sync: a pass over real runs completes and posts nothing for runs that aren't subscription runs", async () => {
      const sync = createCostSync(s.ctx);
      const lines = [];
      await sync.preview({ print: (line = "") => lines.push(line) });
      await sync.tick();
      assert.equal(sync.stats.lastError, null);
      assert.equal(sync.stats.posted, 0, "process-adapter runs report no subscription usage");
    });

    // ------------------------------------------------------------ 7. commands

    test("pch check, why, models, approve and comment against real data", async () => {
      const reviewed = await inReview("Approve by command");
      let lines = await captureOutput(() => commands.check(s.ctx, reviewed.identifier));
      assert.ok(lines.some((l) => l.includes("A merge by you would approve it")), lines.join("\n"));

      lines = await captureOutput(() => commands.decide(s.ctx, "approve", reviewed.identifier, "compat: approved by command"));
      assert.ok(lines[0].includes("approved (done)"));
      assert.equal((await s.ctx.api.request("GET", `/api/issues/${reviewed.id}`)).status, "done");
      await assert.rejects(commands.decide(s.ctx, "approve", s.work.identifier, "no"), /isn't waiting on you/);

      lines = await captureOutput(() => commands.why(s.ctx, s.work.identifier));
      assert.ok(lines.some((l) => l.startsWith("Assignee: Alice")), lines.join("\n"));
      assert.ok(lines.includes("Latest wake requests:") && lines.includes("Latest runs:"), lines.join("\n"));
      assert.ok(lines.some((l) => /Alice {2}succeeded/.test(l)), "runs are shown with the agent's name and status");

      lines = await captureOutput(() => commands.models(s.ctx));
      assert.ok(lines.some((l) => l.startsWith("Modelled") && l.includes("process") && l.includes(s.oldModel) && l.includes("high")), lines.join("\n"));

      await captureOutput(() => commands.comment(s.ctx, s.work.identifier, "compat: comment by command"));
      assert.ok((await commentsOf(s.work.id)).some((c) => c.body === "compat: comment by command"));
    });

    test("pch set-model changes only the model: PATCH merges into adapterConfig", async () => {
      const newModel = `${s.oldModel}-new`;
      const lines = await captureOutput(() => commands.setModel(s.ctx, s.oldModel, newModel, ["--apply"]));
      assert.ok(lines.some((l) => l.startsWith("changed Modelled")), lines.join("\n"));
      const after = await s.ctx.api.request("GET", `/api/agents/${s.modelled.id}`);
      assert.equal(after.adapterConfig.model, newModel);
      assert.equal(after.adapterConfig.effort, "high");
      assert.equal(after.adapterConfig.command, "sh");
      assert.deepEqual(after.adapterConfig.args, ["-c", "echo modelled"]);
    });

    test("a terminated agent leaves the company list but can still be read", async () => {
      await ok("POST", `/api/agents/${s.modelled.id}/terminate`, {});
      const listed = await companyAgents(s.ctx.api, s.company.id);
      assert.ok(!listed.some((a) => a.id === s.modelled.id), "terminated agents are left out of the list");
      const direct = await s.ctx.api.request("GET", `/api/agents/${s.modelled.id}`);
      assert.equal(direct.status, "terminated", "which is why cost sync reads them one by one");
    });

    // ------------------------------------------------------------ 8. the end

    test("every request the helper made is to a listed endpoint", () => {
      const patterns = HELPER_ENDPOINTS.map(([method, template]) => ({ method, regex: templateRegex(template) }));
      const unlisted = new Set();
      for (const call of s.calls) {
        if (!patterns.some((p) => p.method === call.method && p.regex.test(call.pathname))) unlisted.add(`${call.method} ${call.pathname}`);
      }
      assert.deepEqual([...unlisted], [], "add these to HELPER_ENDPOINTS so the OpenAPI check covers them");
    });

    test("pch revoke: the key stops working", async () => {
      const token = s.ctx.readToken();
      await captureOutput(() => commands.revoke(s.ctx));
      assert.equal(fs.existsSync(s.ctx.config.tokenFile), false);
      await assert.rejects(s.ctx.api.request("GET", "/api/cli-auth/me", undefined, { token }), (err) => err.status === 401);
    });
  });
}
