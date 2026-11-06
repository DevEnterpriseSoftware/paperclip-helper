// Compatibility suite: the helper's own code against a real, throwaway Paperclip.
//
// The unit tests run against test/fake-paperclip.mjs, which only proves the
// helper agrees with our idea of Paperclip. This suite proves it agrees with
// Paperclip itself, for one version at a time:
//
//   npm run test:compat -- 2026.1005.0      boots that version, runs this, removes it
//   PAPERCLIP_COMPAT_API=http://127.0.0.1:3100 node --test test/compat/
//
// It needs a Paperclip in local_trusted mode (requests without a key act as the
// board, which is how the suite seeds companies, agents and issues) that holds
// nothing but earlier compat data. Agents use the `process` adapter with a Node
// one-liner (Node, not sh, so it runs the same on Windows), so runs, wakes and
// queues are real and no model is involved.
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
import { companyAgents, companyPrefixes, listIssues, validationIssues } from "../../src/paperclip.mjs";
import { createWatchdog } from "../../src/watchdog.mjs";
import { createRelay } from "../../src/relay.mjs";
import { createCostSync } from "../../src/cost-sync.mjs";
import * as commands from "../../src/commands.mjs";
import { approvalWaitingOn, ts } from "../../src/util.mjs";
import { backstopMonitor, isBackstop, monitorAttempts } from "../../src/ci-runs.mjs";
import { claimedOnly, handOnRoute, holdFacts, neverStarted } from "../../src/release.mjs";

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
  ["GET", "/api/companies/{companyId}/projects"],
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
  ["POST", "/api/issues/{id}/recovery-actions/resolve"],
  ["GET", "/api/issues/{id}/runs"],
  ["GET", "/api/issues/{id}/activity"],
  ["POST", "/api/agents/{id}/pause"],
  ["POST", "/api/agents/{id}/resume"],
  ["GET", "/api/issues/{id}/documents/{key}"],
  ["PUT", "/api/issues/{id}/documents/{key}"],
  ["POST", "/api/issues/{id}/interactions/{interactionId}/respond"],
  ["GET", "/api/issues/{id}/work-products"],
  ["GET", "/api/issues/{id}/diagnostics/wakes"],
  ["GET", "/api/issues/{id}/diagnostics/blockers"],
  ["GET", "/api/issues/{id}/queued-comments"],
  ["GET", "/api/issues/{id}/interactions"],
  ["POST", "/api/issues/{id}/queued-comments/interrupt"],
  ["GET", "/api/execution-workspaces/{id}/workspace-operations"],
  ["GET", "/api/execution-workspaces/{id}"],
  ["GET", "/api/companies/{companyId}/execution-workspaces"],
  ["GET", "/api/execution-workspaces/{id}/close-readiness"],
  ["PATCH", "/api/execution-workspaces/{id}"],
  ["GET", "/api/instance/settings/experimental"],
];
// Endpoints the helper calls that Paperclip serves but its OpenAPI document doesn't
// list (on main). Covered by the last test, not by the OpenAPI check.
const UNDOCUMENTED_ENDPOINTS = [
  ["GET", "/api/companies/{companyId}/costs/by-agent"], // pch usage
];
// Whether two URLs reach the same Paperclip: localhost, 127.0.0.1 and ::1 are one host.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function sameInstance(a, b) {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    const host = (u) => (LOOPBACK.has(u.hostname) ? "loopback" : u.hostname);
    const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80");
    return host(x) === host(y) && port(x) === port(y);
  } catch {
    return false;
  }
}
const templateRegex = (template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);

// The status values the helper's logic branches on. A value outside these sets
// would be treated as "finished" or "not pending" without anyone having decided so.
const RUN_STATUSES = new Set(["queued", "scheduled_retry", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const ACTIVE_RUN = new Set(["queued", "scheduled_retry", "running"]);
// What "settled" waits out. From 2026.1005.0 a run that leaves no disposition is
// retried about a minute later (scheduled_retry, issue_disposition_repair), which
// our echo agents always do; nothing is executing meanwhile, so it doesn't count.
const EXECUTING_RUN = new Set(["queued", "running"]);
// The agents' command: this Node, by absolute path (Paperclip spawns without a shell).
const NODE = process.execPath;
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
        adapterConfig: { command: NODE, args: ["-e", script], ...extra },
      });
    // Paperclip follows a run that left no comment with one more run, so "idle"
    // means no active run on two looks in a row.
    const settled = (issueId) =>
      until(`runs on ${issueId} to finish`, async () => {
        const quiet = async () => {
          const runs = await runsOf(issueId);
          return runs.length > 0 && !runs.some((r) => EXECUTING_RUN.has(r.status));
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
      s.alice = await agent("Alice", 'console.log("alice")');
      s.bob = await agent("Bob", 'console.log("bob")');
      s.slow = await agent("Slow", "setTimeout(() => {}, 25000)");
      s.oldModel = `compat-old-${Date.now()}`;
      s.modelled = await agent("Modelled", 'console.log("modelled")', { model: s.oldModel, effort: "high" });

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
      // What `pch worktrees` reads: the company's open workspaces (status is a comma-separated filter).
      const open = await s.ctx.api.request("GET", `/api/companies/${full.companyId}/execution-workspaces?status=active,idle,in_review,cleanup_failed`);
      assert.ok(Array.isArray(open), "execution workspaces are listed");
      for (const w of open) hasKeys(w, ["id", "status", "sourceIssueId", "branchName", "cwd"], "an execution workspace");
      // What an automatic notice's owner lookup reads (decisions.resolveOwner): every workspace, archived too,
      // by branchName and sourceIssueId. No new endpoint: the unfiltered list must still answer an array.
      const all = await s.ctx.api.request("GET", `/api/companies/${full.companyId}/execution-workspaces`);
      assert.ok(Array.isArray(all), "execution workspaces are listed without a status filter");
      for (const w of all) hasKeys(w, ["id", "status", "sourceIssueId", "branchName"], "an execution workspace (unfiltered)");
      const noReadiness = await board("GET", "/api/execution-workspaces/00000000-0000-4000-8000-000000000001/close-readiness");
      assert.equal(noReadiness.status, 404, "close-readiness of an unknown workspace is a 404");
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

    test("pch release: no hold is a no-op, and Paperclip accepts the reconciliation it sends", async () => {
      // A real legacy_execution_requires_reconciliation hold needs a run cut off with
      // no process or stop record, which a process agent can't be made to leave. So
      // this checks the parts that can break: the command on an unheld issue, and the
      // resolve route's schema for exactly the body \`pch release --apply\` posts.
      const lines = await captureOutput(() => commands.release(s.ctx, s.work.identifier ?? s.work.id, { apply: true }));
      assert.match(lines.join("\n"), /no execution hold/, "release leaves an issue without a hold alone");
      const before = await s.ctx.api.request("GET", `/api/issues/${s.work.id}`);
      assert.equal(before.executionBlocker, null, "an issue nobody held has no executionBlocker");

      const body = (providerStopped) => ({
        actionId: "00000000-0000-4000-8000-000000000001",
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "compat",
        executionReconciliation: {
          runId: "00000000-0000-4000-8000-000000000002",
          providerStopped,
          actionOutcome: "mixed",
          outcomeEvidence: "compat: the run ended and has no process left; outcome unverified.",
        },
      });
      const malformed = await board("POST", `/api/issues/${s.work.id}/recovery-actions/resolve`, body(false));
      assert.equal(malformed.status, 400, "providerStopped must be true: the route validates the reconciliation");
      const unknown = await board("POST", `/api/issues/${s.work.id}/recovery-actions/resolve`, body(true));
      assert.notEqual(unknown.status, 400, `release's body is valid: ${JSON.stringify(unknown.data)}`);
      assert.ok(unknown.status >= 400 || unknown.data?.replayed !== undefined, `an unknown action resolves nothing: ${unknown.status} ${JSON.stringify(unknown.data)}`);
      const after = await s.ctx.api.request("GET", `/api/issues/${s.work.id}`);
      assert.equal(after.status, before.status, "resolving an unknown action changes nothing");
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

    test("watchdog: a hold Paperclip can't release by itself is released, and the saved message starts the owner", async (t) => {
      // An agent whose command doesn't exist fails before any process starts, so its
      // run records no process id. Up to 2026.1012.0 Paperclip holds the issue for
      // reconciliation and can never release it by itself (the same hold a run cut off
      // at a hand-off leaves). From 2026.1023.0 the process adapter reports that no
      // provider work started (paperclipai/paperclip#14991), and nothing is held.
      // The agent is created working and broken afterwards: from 2026.1023.0 a new
      // agent is tested before it is ready (paperclipai/paperclip#15631), and one
      // whose command doesn't exist stays paused, so its runs never start.
      const broken = await agent("Broken", 'console.log("broken")');
      await until("the new agent to be ready", async () => {
        const a = await ok("GET", `/api/agents/${broken.id}`);
        assert.ok(!a.lifecycleError, `Paperclip couldn't make the agent ready: ${a.lifecycleError}`);
        return !("lifecycleState" in a) || a.lifecycleState === "ready";
      });
      await ok("PATCH", `/api/agents/${broken.id}`, { adapterConfig: { command: "pch-compat-no-such-command", args: [] } });
      const fix = () => ok("PATCH", `/api/agents/${broken.id}`, { adapterConfig: { command: NODE, args: ["-e", 'console.log("fixed")'] } });
      const held = await issue({ title: "Held", status: "todo", assigneeAgentId: broken.id });
      const failed = await until("the broken agent's run to end", async () =>
        (await runsOf(held.id)).find((r) => r.agentId === broken.id && !ACTIVE_RUN.has(r.status)));
      // The hold, if any, comes with the run's end; allow a moment for it to show.
      let hold = null;
      for (let look = 0; look < 10 && !hold; look += 1) {
        hold = (await ok("GET", `/api/issues/${held.id}`)).executionBlocker;
        if (!hold) await sleep(500);
      }

      if (!hold) {
        // Nothing to release: the owner is started the ordinary way, and the watchdog
        // has nothing to do here.
        const run = await s.ctx.api.request("GET", `/api/heartbeat-runs/${failed.runId ?? failed.id}`);
        assert.equal(run.processPid, null, "the run never started a process");
        await fix();
        await s.ctx.api.request("POST", `/api/issues/${held.id}/comments`, { body: "compat: please continue" });
        await until("the comment to start the owner", async () =>
          (await runsOf(held.id)).some((r) => r.agentId === broken.id && r.status === "succeeded"));
        await settled(held.id);
        const watchdog = createWatchdog(s.ctx, s.state);
        s.skew = 10 * 60_000;
        await watchdog.tick();
        s.skew = 0;
        assert.equal(watchdog.stats.releases, 0, "the watchdog releases nothing on an issue Paperclip never held");
        assert.equal(watchdog.stats.lastError, null);
        return t.skip("this Paperclip doesn't hold a run that never started a process, so there was no hold to release");
      }

      assert.equal(hold.cause, "legacy_execution_requires_reconciliation", "a run that never started a process is held for reconciliation");
      hasKeys(hold, ["recoveryActionId", "runId", "agentId", "cause", "nextAction"], "an execution hold");
      const source = await s.ctx.api.request("GET", `/api/heartbeat-runs/${hold.runId}`);
      hasKeys(source, ["processPid", "processGroupId", "finishedAt"], "the held run");
      assert.equal(source.processPid, null, "the held run recorded no process");

      // A message for the owner is saved behind the hold. Fix the agent, so the
      // delivered message has something that can run.
      await s.ctx.api.request("POST", `/api/issues/${held.id}/comments`, { body: "compat: please continue" });
      await until("the message to be saved", async () => (await ok("GET", `/api/issues/${held.id}/queued-comments`)).entries?.length);
      await fix();

      const watchdog = createWatchdog(s.ctx, s.state);
      await watchdog.tick();
      assert.equal(watchdog.stats.releases, 0, "nothing is released inside the stall window");
      s.skew = 10 * 60_000;
      await watchdog.tick();
      s.skew = 0;
      assert.equal(watchdog.stats.releases, 1, `the hold is released (log: ${JSON.stringify(s.logs.filter((l) => /hold/.test(l.msg ?? "")).slice(-3))})`);
      assert.equal((await ok("GET", `/api/issues/${held.id}`)).executionBlocker, null, "Paperclip no longer holds the issue");
      await until("the saved message to start the owner", async () =>
        (await runsOf(held.id)).some((r) => r.agentId === broken.id && r.status === "succeeded"));
      await settled(held.id);
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

    test("relay: Request changes sends the issue back, and a new PR is noted in the issue's Pull requests document", async () => {
      const reviewed = await inReview("Changes requested");
      const relay = createRelay(s.ctx, s.state);

      // RELAY_QUIET_NOTES (on by default): the note goes in a document, which wakes
      // nobody, rather than a comment, which would wake the engineer.
      const opened = await relay.handle("pull_request", gh({ action: "opened", pull_request: pr(reviewed.identifier, 12, { merged: false }) }));
      assert.deepEqual(opened, { identifier: reviewed.identifier, action: "note" }, "Paperclip took the Pull requests document, so the relay didn't fall back to a comment");
      const notes = await ok("GET", `/api/issues/${reviewed.id}/documents/pull-requests`);
      const body = String(notes.body);
      const links = [...body.matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => new URL(m[0]));
      assert.ok(links.some((u) => u.origin === "https://github.com" && u.pathname === "/acme/app/pull/12"), `the PR's URL is in the document: ${body}`);
      assert.ok(body.includes("opened"), `the document says the PR was opened: ${body}`);

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
      assert.ok(!bodies.some((b) => b.includes("opened by @")), "the PR's note isn't a comment");
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

      // What watchdog 22 reads to tell a run that never started (release.mjs neverStarted):
      // every field must be there, set on a run that ran, so a missing one never passes for null.
      hasKeys(
        detail,
        ["startedAt", "runtimeMode", "errorCode", "runtimeModeResolvedAt", "processPid", "processGroupId", "processStartedAt",
          "nativeIssueId", "nativeSessionId", "sessionIdAfter", "controllerBootId", "controllerLeaseExpiresAt", "executionStage"],
        "a heartbeat run's detail",
      );
      assert.ok(isIso(detail.startedAt), "a run that ran has a start time");
      assert.ok(events.every((e) => "eventType" in e && "sourceEventId" in e), "each run event has eventType and sourceEventId");
      const ranFacts = {
        issue: { id: run.contextSnapshot.issueId },
        hold: { cause: "legacy_execution_requires_reconciliation", runId: run.id },
        run: { ...detail, status: "cancelled", errorCode: "issue_assignee_changed", detailRead: true, events },
      };
      assert.equal(neverStarted(ranFacts), false, "a run that ran never reads as unstarted, whatever its code");

      // Exactly the body cost-sync.mjs posts.
      const body = {
        idempotencyKey: `pch-cost-sync:compat-${run.id}`,
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
      };
      const event = await s.ctx.api.request("POST", `/api/companies/${s.company.id}/cost-events`, body);
      assert.equal(Number(event.costCents), 3);
      assert.equal(event.heartbeatRunId, run.id);
      if (event.idempotencyKey !== undefined) {
        // Paperclip 2026.10+: the key is kept, and posting the same receipt again returns the first.
        assert.equal(event.idempotencyKey, body.idempotencyKey);
        const again = await s.ctx.api.request("POST", `/api/companies/${s.company.id}/cost-events`, body);
        assert.equal(again.id, event.id, "a repeated post with the same idempotency key is recorded once");
      }

      const activity = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/activity?entityType=cost_event&limit=500`);
      const rows = Array.isArray(activity) ? activity : activity.items;
      assert.ok(
        rows.some((a) => a.action === "cost.reported" && a.actorType === "user" && a.actorId === s.me.userId && a.entityId === event.id),
        "the post is in the activity log as cost.reported by the key's user, which guards against posting twice after a lost state file",
      );
      const budgets = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/budgets/overview`);
      assert.ok(Array.isArray(budgets.policies));
    });

    test("cost sync: an estimated cost is taken as \"estimated\", or refused on costStatus alone, as the fallback to \"reported\" expects", async () => {
      const runs = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/heartbeat-runs?limit=1000`);
      const run = runs.find((r) => r.status === "succeeded" && r.contextSnapshot?.issueId);
      // Exactly the body cost-sync.mjs posts for a cost it estimated from tokens (a Codex run).
      const body = {
        idempotencyKey: `pch-cost-sync:compat-estimated-${run.id}`,
        agentId: run.agentId,
        heartbeatRunId: run.id,
        issueId: run.contextSnapshot.issueId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        costStatus: "estimated",
        model: "compat-model",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 2,
        occurredAt: new Date(run.finishedAt).toISOString(),
      };
      const path = `/api/companies/${s.company.id}/cost-events`;
      let event;
      try {
        event = await s.ctx.api.request("POST", path, body);
        if (event.costStatus !== undefined) assert.equal(event.costStatus, "estimated");
      } catch (err) {
        // A release before "estimated" (2026.1012.0 and earlier): a 400 whose Zod issues name
        // costStatus and nothing else is what makes cost sync post the event again as "reported".
        assert.equal(err.status, 400, err.message);
        assert.deepEqual(validationIssues(err.body).map((i) => i.path), [["costStatus"]], err.message);
        event = await s.ctx.api.request("POST", path, { ...body, costStatus: "reported" });
      }
      assert.equal(Number(event.costCents), 2);
    });

    test("cost sync: an event lands under its project on the Costs page only by its own projectId", async () => {
      const runs = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/heartbeat-runs?limit=1000`);
      const run = runs.find((r) => r.status === "succeeded" && r.contextSnapshot?.issueId);
      // Where cost sync reads the run's project first: the scope Paperclip fixed for the run (2026.10+).
      const ledger = run.usageJson?.ledgerScope;
      if (ledger) {
        assert.equal(ledger.issueId, run.contextSnapshot.issueId, "usageJson.ledgerScope names the run's issue");
        assert.ok("projectId" in ledger, "usageJson.ledgerScope has projectId (null when the issue is in no project)");
      }
      const issue = await s.ctx.api.request("GET", `/api/issues/${run.contextSnapshot.issueId}`);
      assert.ok("projectId" in issue, "an issue carries projectId, the fallback without a ledger scope");
      // The suite's own setup and check (ok()) go around the helper's client: the helper never calls them.
      const project = await ok("POST", `/api/companies/${s.company.id}/projects`, { name: `Compat cost attribution ${run.id.slice(0, 8)}` });
      const listed = await s.ctx.api.request("GET", `/api/companies/${s.company.id}/projects`);
      assert.ok(listed.some((p) => p.id === project.id && p.name === project.name), "the company's project list names it (pch costs' by-project line)");
      const path = `/api/companies/${s.company.id}/cost-events`;
      const body = (key, extra) => ({
        idempotencyKey: `pch-cost-sync:compat-${key}-${run.id}`,
        agentId: run.agentId,
        heartbeatRunId: run.id,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        costStatus: "reported",
        model: "compat-model",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 7,
        occurredAt: new Date(run.finishedAt).toISOString(),
        ...extra,
      });
      await s.ctx.api.request("POST", path, body("project", { projectId: project.id }));
      const rows = await ok("GET", `/api/companies/${s.company.id}/costs/by-project`);
      const row = rows.find((r) => r.projectId === project.id);
      assert.ok(row, "the event is under its project");
      assert.equal(Number(row.costCents), 7);
      // A project that isn't there is refused with 404 and nothing recorded: cost sync then posts without it.
      await assert.rejects(
        s.ctx.api.request("POST", path, body("no-such-project", { projectId: "00000000-0000-4000-8000-00000000c0de" })),
        (err) => err.status === 404 && /project/i.test(String(err.body?.error ?? err.message)),
      );
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
      assert.ok((await commentsOf(s.work.id)).some((c) => c.body.startsWith("compat: comment by command")));
    });

    test("pch worktrees --links reads blocked issues and their recovery actions, and posts nothing", async () => {
      // A workspace validation that fails needs git worktrees under a project checkout, which
      // these process agents don't have, so the failure itself isn't reproduced here. Paperclip
      // 2026.1023.0 refused every run on worktrees git had linked by relative
      // path (worktree.useRelativePaths) with workspace_validation_failed and
      // source_registration_unproven: what this command lists and `pch why` names. What is
      // checked is the reading: the company's blocked issues, each one's recovery actions (or a
      // list row's activeRecoveryAction), and that --retry with nothing parked posts nothing.
      const before = (await commentsOf(s.work.id)).length;
      const lines = await captureOutput(() => commands.worktrees(s.ctx, { links: true, retry: true }));
      assert.ok(lines.length > 0 && lines.every((l) => /: no issue is parked on its worktree links\.$/.test(l)), lines.join("\n"));
      assert.equal((await commentsOf(s.work.id)).length, before);
    });

    test("pch set-model changes only the model: PATCH merges into adapterConfig", async () => {
      const newModel = `${s.oldModel}-new`;
      const lines = await captureOutput(() => commands.setModel(s.ctx, s.oldModel, newModel, { apply: true }));
      assert.ok(lines.some((l) => l.startsWith("changed Modelled")), lines.join("\n"));
      const after = await s.ctx.api.request("GET", `/api/agents/${s.modelled.id}`);
      assert.equal(after.adapterConfig.model, newModel);
      assert.equal(after.adapterConfig.effort, "high");
      assert.equal(after.adapterConfig.command, NODE);
      assert.deepEqual(after.adapterConfig.args, ["-e", 'console.log("modelled")']);
    });

    test("a terminated agent leaves the company list but can still be read", async () => {
      await ok("POST", `/api/agents/${s.modelled.id}/terminate`, {});
      const listed = await companyAgents(s.ctx.api, s.company.id);
      assert.ok(!listed.some((a) => a.id === s.modelled.id), "terminated agents are left out of the list");
      const direct = await s.ctx.api.request("GET", `/api/agents/${s.modelled.id}`);
      assert.equal(direct.status, "terminated", "which is why cost sync reads them one by one");
    });

    // Watchdog 22, for real: a disposition repair Paperclip scheduled, then
    // suppressed at its gate before it started because the issue gained a live path
    // (issue_disposition_repair_superseded). Up to 2026.1023.0 that leaves a hold for
    // reconciliation that nothing in Paperclip releases.
    test("watchdog 22: a repair suppressed before it started holds the issue, and the watchdog releases it as not performed", async (t) => {
      // An agent that comments with its run's own token and ends its run, leaving the issue
      // in progress: no disposition, so Paperclip repairs it at once, then schedules a second
      // repair about a minute later (seen on 2026.1023.0).
      const created = await issue({ title: "Suppressed repair", status: "todo" });
      const script =
        "const e = process.env; fetch(e.PAPERCLIP_API_URL + '/api/issues/' + e.HELD_ISSUE + '/comments', { method: 'POST', " +
        "headers: { authorization: 'Bearer ' + e.PAPERCLIP_API_KEY, 'content-type': 'application/json', 'x-paperclip-run-id': e.PAPERCLIP_RUN_ID }, " +
        "body: JSON.stringify({ body: 'Still looking into it.' }) }).then((r) => console.log('comment', r.status), (err) => console.log('comment failed', err.message));";
      const quiet = await agent("Erlich", script, { env: { HELD_ISSUE: created.id } });
      await until("the new agent to be ready", async () => {
        const a = await ok("GET", `/api/agents/${quiet.id}`);
        return !("lifecycleState" in a) || a.lifecycleState === "ready";
      });
      await ok("PATCH", `/api/issues/${created.id}`, { assigneeAgentId: quiet.id, status: "in_progress" });
      const repair = await until(
        "a disposition repair to be scheduled",
        async () => (await runsOf(created.id)).find((r) => r.status === "scheduled_retry"),
        { timeoutMs: 240_000, everyMs: 1000 },
      ).catch(() => null);
      if (!repair) return t.skip("this Paperclip scheduled no disposition repair");
      // A live path before the repair is due: the board's monitor. Its gate then suppresses it.
      const run = { id: 1, html_url: "https://github.com/org/app/actions/runs/1" };
      const full = await s.ctx.api.request("GET", `/api/issues/${created.id}`);
      const monitor = backstopMonitor({ run, now: Date.now(), backstopMs: 6 * 60 * 60_000, attemptCount: monitorAttempts(full) });
      await s.ctx.api.request("PATCH", `/api/issues/${created.id}`, { executionPolicy: { ...(full.executionPolicy ?? {}), monitor } });
      const repairId = repair.runId ?? repair.id;
      const ended = await until("the scheduled repair to end", async () => {
        const r = (await runsOf(created.id)).find((x) => (x.runId ?? x.id) === repairId);
        return r && !ACTIVE_RUN.has(r.status) ? r : null;
      }, { timeoutMs: 240_000, everyMs: 2000 });
      t.diagnostic(`the repair ended ${ended.status} (${ended.errorCode ?? "no code"})`);
      if (ended.status !== "cancelled" || ended.errorCode !== "issue_disposition_repair_superseded") {
        return t.skip(`this Paperclip didn't suppress the repair at its gate (${ended.status}, ${ended.errorCode ?? "no code"})`);
      }
      let hold = null;
      for (let look = 0; look < 20 && !hold; look += 1) {
        hold = (await ok("GET", `/api/issues/${created.id}`)).executionBlocker;
        if (!hold) await sleep(500);
      }
      if (!hold) return t.skip("this Paperclip doesn't hold an issue behind a repair it suppressed before it started");

      assert.equal(hold.cause, "legacy_execution_requires_reconciliation");
      assert.equal(hold.runId, repairId, "the hold is the suppressed repair's");
      const facts = await holdFacts(s.ctx.api, created.id);
      assert.equal(facts.run.startedAt, null, "the repair never started");
      assert.equal(neverStarted(facts), true, `the helper reads it as never started: ${JSON.stringify({ ...facts.run, events: facts.run.events?.map((e) => e.eventType) })}`);

      // A board message is saved behind the hold.
      await s.ctx.api.request("POST", `/api/issues/${created.id}/comments`, { body: "compat: please continue" });
      await until("the message to be saved", async () => (await ok("GET", `/api/issues/${created.id}/queued-comments`)).entries?.length);
      const before = (await runsOf(created.id)).length;

      const watchdog = createWatchdog(s.ctx, s.state);
      s.skew = 10 * 60_000;
      await watchdog.tick();
      s.skew = 0;
      assert.equal(watchdog.stats.unstartedHolds, 1, `released (log: ${JSON.stringify(s.logs.filter((l) => /hold|note for the board/.test(l.msg ?? "")).slice(-3))})`);
      assert.equal((await ok("GET", `/api/issues/${created.id}`)).executionBlocker, null, "Paperclip no longer holds the issue");
      await until("the saved message to start the agent", async () => (await runsOf(created.id)).length > before);
      await settled(created.id).catch(() => {});
    });

    // Watchdog 22 on a held review: the reviewer's never-started run holds the
    // issue while he has its review. Built the way it arose here: the reviewer's own
    // repair suppressed before it started (as above), then the board hands the issue to
    // its implementer and asks for review. Paperclip refuses a release that would leave
    // the review (recovery_governed_stage_pending). The watchdog releases it all the
    // same: keeping the review as it was if Paperclip has parked it in blocked, or
    // starting its first stage again with the same reviewer and implementer.
    test("watchdog 22: a held review is released, kept as it was or its untouched first stage started again", async (t) => {
      const created = await issue({ title: "Held review", status: "todo" });
      const script =
        "const e = process.env; fetch(e.PAPERCLIP_API_URL + '/api/issues/' + e.HELD_ISSUE + '/comments', { method: 'POST', " +
        "headers: { authorization: 'Bearer ' + e.PAPERCLIP_API_KEY, 'content-type': 'application/json', 'x-paperclip-run-id': e.PAPERCLIP_RUN_ID }, " +
        "body: JSON.stringify({ body: 'Looking at it.' }) }).then((r) => console.log('comment', r.status), (err) => console.log('comment failed', err.message));";
      const reviewer = await agent("Monica", script, { env: { HELD_ISSUE: created.id } });
      const implementer = await agent("Carla", 'console.log("nothing to do")');
      for (const a of [reviewer, implementer]) {
        await until("the new agent to be ready", async () => {
          const x = await ok("GET", `/api/agents/${a.id}`);
          return !("lifecycleState" in x) || x.lifecycleState === "ready";
        });
      }
      await ok("PATCH", `/api/issues/${created.id}`, { executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] } });
      await ok("PATCH", `/api/issues/${created.id}`, { assigneeAgentId: reviewer.id, status: "in_progress" });
      const repair = await until("a disposition repair to be scheduled", async () => (await runsOf(created.id)).find((r) => r.status === "scheduled_retry"), { timeoutMs: 240_000, everyMs: 1000 }).catch(() => null);
      if (!repair) return t.skip("this Paperclip scheduled no disposition repair");
      const before = await s.ctx.api.request("GET", `/api/issues/${created.id}`);
      const monitor = backstopMonitor({ run: { id: 1, html_url: "https://github.com/org/app/actions/runs/1" }, now: Date.now(), backstopMs: 6 * 60 * 60_000, attemptCount: monitorAttempts(before) });
      await s.ctx.api.request("PATCH", `/api/issues/${created.id}`, { executionPolicy: { ...(before.executionPolicy ?? {}), monitor } });
      const held = await until("the suppressed repair to hold the issue", async () => {
        const f = await ok("GET", `/api/issues/${created.id}`);
        return f.status === "blocked" && f.executionBlocker ? f : null;
      }, { timeoutMs: 240_000, everyMs: 2000 }).catch(() => null);
      if (!held) return t.skip("this Paperclip doesn't hold an issue behind a repair it suppressed before it started");
      // The implementer hands it on, and the board asks for review with the reviewer.
      await ok("PATCH", `/api/issues/${created.id}`, { assigneeAgentId: implementer.id });
      await ok("PATCH", `/api/issues/${created.id}`, { status: "in_review", assigneeAgentId: reviewer.id });
      const review = (await ok("GET", `/api/issues/${created.id}`)).executionState;
      assert.equal(review?.status, "pending");
      assert.equal(review.currentParticipant?.agentId, reviewer.id);
      assert.equal(review.returnAssignee?.agentId, implementer.id);
      const facts = await holdFacts(s.ctx.api, created.id);
      assert.equal(neverStarted(facts), true);
      // What 1.15.3 got: Paperclip won't release it out of review.
      const refused = await s.ctx.api.request("POST", `/api/issues/${created.id}/recovery-actions/resolve`, {
        actionId: facts.hold.recoveryActionId, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "compat: the old release",
        executionReconciliation: { runId: facts.hold.runId, providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "compat: the run never started." },
      }).then(() => null, (err) => err);
      if (!refused) return t.skip("this Paperclip released a held review out of review by itself");
      assert.equal(refused.status, 409);
      assert.match(refused.message, /recovery_governed_stage_pending|cannot bypass a pending execution review/);

      // Paperclip may park it in blocked by itself (a later refused wake): then the review
      // is kept as it was; still in review, its first stage is started again.
      const parked = await until("Paperclip to park the review, if it does", async () => {
        const f = await ok("GET", `/api/issues/${created.id}`);
        return f.status === "blocked" ? f : null;
      }, { timeoutMs: 20_000, everyMs: 2000 }).catch(() => null);
      t.diagnostic(parked ? "parked in blocked: the review is kept" : "still in review: its first stage is started again");
      const monitorBefore = (await ok("GET", `/api/issues/${created.id}`)).executionPolicy?.monitor ?? null;
      t.diagnostic(`policy monitor before: ${monitorBefore ? monitorBefore.nextCheckAt : "none"}`);
      const watchdog = createWatchdog(s.ctx, s.state);
      s.skew = 10 * 60_000;
      await watchdog.tick();
      s.skew = 0;
      const after = await ok("GET", `/api/issues/${created.id}`);
      assert.equal(after.executionBlocker, null, `released (log: ${JSON.stringify(s.logs.filter((l) => /hold|board|review/.test(l.msg ?? "")).slice(-3))})`);
      assert.equal(after.status, "in_review");
      assert.equal(after.assigneeAgentId, reviewer.id);
      const kept = parked
        ? ["status", "currentStageId", "currentStageIndex", "currentParticipant", "returnAssignee", "reviewRequest", "completedStageIds", "changesRequestedCount"]
        : ["status", "currentStageId", "currentStageIndex", "returnAssignee", "completedStageIds", "changesRequestedCount"];
      for (const k of kept) assert.equal(JSON.stringify(after.executionState?.[k] ?? null), JSON.stringify(review[k] ?? null), `the review's ${k}`);
      assert.equal(after.executionState?.currentParticipant?.agentId, reviewer.id);
      if (monitorBefore) assert.ok(after.executionPolicy?.monitor, "the policy monitor is there afterwards");
      assert.equal(watchdog.stats.unstartedHolds, 1);
      await until("the reviewer to run in the review", async () => (await runsOf(created.id)).some((r) => r.agentId === reviewer.id && ts(r.createdAt) > ts(after.updatedAt) - 5000));
      assert.ok(!(await runsOf(created.id)).some((r) => r.agentId === implementer.id && r.startedAt), "the implementer never ran");
      await ok("POST", `/api/agents/${reviewer.id}/pause`, {}).catch(() => {}); // the stand-in never decides
    });

    // Watchdog 22's hand-on: the board gave the held issue to another
    // agent, so Paperclip accepts the release only once the held run's agent has it again,
    // and a board reassignment back while that agent's run is queued or starting would
    // cancel the run and hold the issue again. The watchdog gives it back to that agent,
    // asks it to reassign the issue itself, releases the hold and delivers the messages;
    // the agent's own reassignment is its run's disposition. What has to hold: the issue
    // reaches the other agent, and no hold behind the first agent's runs follows, through
    // more than two of Paperclip's delivery sweeps.
    test("watchdog 22: a hold whose issue moved to another agent is handed on by the held run's agent, and no new hold follows", async (t) => {
      const created = await issue({ title: "Handed on", status: "todo" });
      const monica = await agent("Monica", 'console.log("picked up")');
      const script =
        "const e = process.env; const h = { authorization: 'Bearer ' + e.PAPERCLIP_API_KEY, 'content-type': 'application/json', 'x-paperclip-run-id': e.PAPERCLIP_RUN_ID }; " +
        "const u = e.PAPERCLIP_API_URL + '/api/issues/' + e.HELD_ISSUE; " +
        "fetch(u + '/comments', { headers: h }).then((r) => r.json()).then(async (list) => { " +
        "const asked = (Array.isArray(list) ? list : []).some((c) => String(c.body).includes('Please reassign this issue to')); " +
        "if (asked) { const r = await fetch(u, { method: 'PATCH', headers: h, body: JSON.stringify({ assigneeAgentId: e.HAND_TO }) }); console.log('handed on', r.status, (await r.text()).slice(0, 200)); } " +
        "else { const r = await fetch(u + '/comments', { method: 'POST', headers: h, body: JSON.stringify({ body: 'Still looking into it.' }) }); console.log('comment', r.status); } " +
        "}).catch((err) => console.log('failed', err.message));";
      const gilfoyle = await agent("Gilfoyle", script, { env: { HELD_ISSUE: created.id, HAND_TO: monica.id } });
      for (const a of [gilfoyle, monica]) {
        await until("the new agent to be ready", async () => {
          const x = await ok("GET", `/api/agents/${a.id}`);
          return !("lifecycleState" in x) || x.lifecycleState === "ready";
        });
      }
      await ok("PATCH", `/api/issues/${created.id}`, { assigneeAgentId: gilfoyle.id, status: "in_progress" });
      const repair = await until("a disposition repair to be scheduled", async () => (await runsOf(created.id)).find((r) => r.status === "scheduled_retry"), { timeoutMs: 240_000, everyMs: 1000 }).catch(() => null);
      if (!repair) return t.skip("this Paperclip scheduled no disposition repair");
      const full = await s.ctx.api.request("GET", `/api/issues/${created.id}`);
      const monitor = backstopMonitor({ run: { id: 1, html_url: "https://github.com/org/app/actions/runs/1" }, now: Date.now(), backstopMs: 6 * 60 * 60_000, attemptCount: monitorAttempts(full) });
      await s.ctx.api.request("PATCH", `/api/issues/${created.id}`, { executionPolicy: { ...(full.executionPolicy ?? {}), monitor } });
      // Settled (blocked, replay blocked): an action still active when the issue changes
      // hands is Paperclip's own recovery to finish, and isn't the case tested here.
      const held = await until("the suppressed repair to hold the issue", async () => {
        const f = await ok("GET", `/api/issues/${created.id}`);
        return f.status === "blocked" && f.executionBlocker ? f : null;
      }, { timeoutMs: 240_000, everyMs: 2000 }).catch(() => null);
      if (!held) return t.skip("this Paperclip doesn't hold an issue behind a repair it suppressed before it started");
      // The board gives it to Monica: what 1.16.0 left to the board ("another agent's run").
      await ok("PATCH", `/api/issues/${created.id}`, { assigneeAgentId: monica.id });
      const facts = await holdFacts(s.ctx.api, created.id);
      if (!facts.hold) {
        const recovery = await ok("GET", `/api/issues/${created.id}/recovery-actions`).catch((err) => err.message);
        assert.fail(`the board's reassignment cleared the hold: issue ${facts.issue.status}, recovery actions ${JSON.stringify(recovery).slice(0, 600)}`);
      }
      assert.equal(facts.hold.agentId, gilfoyle.id);
      assert.equal(neverStarted(facts), true);
      assert.equal(claimedOnly(facts.run), false);
      assert.deepEqual(handOnRoute(facts), { kind: "owner-moved", targetAgentId: monica.id, reassign: true });
      const refused = await s.ctx.api.request("POST", `/api/issues/${created.id}/recovery-actions/resolve`, {
        actionId: facts.hold.recoveryActionId, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "compat: the release with the issue elsewhere",
        executionReconciliation: { runId: facts.hold.runId, providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "compat: the run never started." },
      }).then(() => null, (err) => err);
      assert.ok(refused, "Paperclip refuses the release while another agent has the issue");
      assert.equal(refused.status, 409);
      t.diagnostic(`refused: ${refused.message}`);

      const releasedAt = Date.now();
      const watchdog = createWatchdog(s.ctx, s.state);
      s.skew = 10 * 60_000;
      await watchdog.tick();
      s.skew = 0;
      assert.equal(watchdog.stats.unstartedHolds, 1, `released (log: ${JSON.stringify(s.logs.filter((l) => /hold|board/.test(l.msg ?? "")).slice(-3))})`);
      const ask = (await commentsOf(created.id)).find((c) => /Please reassign this issue to/.test(c.body));
      assert.ok(ask, "the hand-on comment is on the issue");
      const handed = await until("Gilfoyle's run to give the issue to Monica", async () => {
        const f = await ok("GET", `/api/issues/${created.id}`);
        return f.assigneeAgentId === monica.id ? f : null;
      }, { timeoutMs: 120_000, everyMs: 2000 }).catch(() => null);
      const runs = async () => (await runsOf(created.id)).map((r) => `${r.agentId === gilfoyle.id ? "Gilfoyle" : r.agentId === monica.id ? "Monica" : "?"} ${r.status}${r.errorCode ? ` (${r.errorCode})` : ""}${ts(r.createdAt) >= releasedAt - 2000 ? " after" : ""}`).join("; ");
      if (!handed) {
        const log = await board("GET", `/api/heartbeat-runs/${(await runsOf(created.id)).find((r) => r.agentId === gilfoyle.id)?.runId}/log?limitBytes=8192`).catch(() => null);
        assert.fail(`the issue didn't reach Monica: runs ${await runs()}; Gilfoyle's last log: ${JSON.stringify(log?.data ?? null).slice(0, 400)}`);
      }
      // More than two delivery sweeps (15 s each), and Paperclip's stranded-work check.
      await sleep(40_000);
      const after = await ok("GET", `/api/issues/${created.id}`);
      t.diagnostic(`runs: ${await runs()}`);
      assert.ok(!after.executionBlocker || after.executionBlocker.agentId !== gilfoyle.id, `no hold behind Gilfoyle's runs: ${JSON.stringify(after.executionBlocker)}`);
      const cancelled = (await runsOf(created.id)).filter((r) => r.agentId === gilfoyle.id && ts(r.createdAt) >= releasedAt - 2000 && r.status === "cancelled" && r.errorCode !== "issue_reassigned");
      assert.deepEqual(cancelled.map((r) => r.errorCode), [], "none of Gilfoyle's runs after the release was cancelled at dispatch");
      for (const a of [gilfoyle, monica]) await ok("POST", `/api/agents/${a.id}/pause`, {}).catch(() => {});
    });

    // Watchdog 11's backstop, and the disposition guard it answers. Last, so the
    // repairs the control issue gets touch no other test. Each agent does what a real
    // one waiting on CI does: posts "waiting on <run>" through the API with its run's
    // own token (so Paperclip's missing-comment retry stays out of it) and ends its
    // run, leaving the issue in progress. The backstop goes on while that run is still
    // going, as the watchdog's does: the guard looks the moment the run ends
    // (heartbeat/run-completion.ts → reconcileLegacyContinuation).
    test("CI backstop: a board key's monitor is the live path the disposition guard wants; its attempts count across monitors; the report clears it", async (t) => {
      const run = { id: 30498202022, html_url: "https://github.com/org/app/actions/runs/30498202022" };
      // The agent says first where it will post and whether it got a run token, then the
      // comment's status: the run's log is how a failed precondition explains itself.
      const script =
        "const e = process.env; console.log('agent env', e.PAPERCLIP_API_URL, e.PAPERCLIP_API_KEY ? 'with a run token' : 'WITHOUT a run token', 'run', e.PAPERCLIP_RUN_ID); " +
        "setTimeout(() => fetch(e.PAPERCLIP_API_URL + '/api/issues/' + e.CI_ISSUE + '/comments', { method: 'POST', " +
        "headers: { authorization: 'Bearer ' + e.PAPERCLIP_API_KEY, 'content-type': 'application/json', 'x-paperclip-run-id': e.PAPERCLIP_RUN_ID }, " +
        `body: JSON.stringify({ body: 'Pushed. Waiting on ${run.html_url}' }) }).then((r) => console.log('comment', r.status), (err) => console.log('comment failed', err.message)), 3000);`;
      const waitingIssue = async (name) => {
        const created = await issue({ title: `Waiting on CI (${name})`, status: "todo" });
        const owner = await agent(name, script, { env: { CI_ISSUE: created.id } });
        await ok("PATCH", `/api/issues/${created.id}`, { assigneeAgentId: owner.id, status: "in_progress" });
        return { ...created, owner };
      };
      const schedule = async (id, extra = {}) => {
        const full = await s.ctx.api.request("GET", `/api/issues/${id}`);
        const monitor = { ...backstopMonitor({ run, now: Date.now(), backstopMs: 6 * 60 * 60_000, attemptCount: monitorAttempts(full) }), ...extra };
        await s.ctx.api.request("PATCH", `/api/issues/${id}`, { executionPolicy: { ...(full.executionPolicy ?? {}), monitor } });
        return monitor;
      };
      // What the guard did: its repair runs (wake reason issue_disposition_repair; the
      // wake diagnostics show that reason as "other") and its recovery action.
      const guardOn = async (id) => {
        const runs = await runsOf(id);
        const reasons = [];
        for (const r of runs) {
          const detail = await s.ctx.api.request("GET", `/api/heartbeat-runs/${r.runId ?? r.id}`).catch(() => null);
          reasons.push(detail?.contextSnapshot?.wakeReason ?? detail?.wakeReason ?? r.invocationSource ?? "?");
        }
        const recovery = await s.ctx.api.request("GET", `/api/issues/${id}/recovery-actions`).catch(() => null);
        const actions = [recovery?.active, ...(recovery?.actions ?? [])].filter(Boolean).map((a) => a.kind);
        const comments = (await commentsOf(id)).filter((c) => c.authorAgentId).length;
        return { repaired: reasons.includes("issue_disposition_repair") || actions.includes("deliberate_wait_without_target"), reasons, actions, comments };
      };

      // What each run on the issue did and printed: its status and error, and the agent's own lines.
      const agentOutput = async (id) => {
        const out = [];
        for (const r of await runsOf(id)) {
          const runId = r.runId ?? r.id;
          const log = await board("GET", `/api/heartbeat-runs/${runId}/log?limitBytes=65536`);
          const text = typeof log.data?.content === "string" ? log.data.content : JSON.stringify(log.data ?? "");
          const lines = [...text.matchAll(/(agent env [^"\\\n]*|comment (?:\d+|failed[^"\\\n]*))/g)].map((m) => m[1]);
          out.push(`${String(runId).slice(0, 8)} ${r.status}${r.error ? ` (${String(r.error).slice(0, 120)})` : ""}${log.status === 200 ? "" : ` [log → ${log.status}]`}: ${lines.join(" | ") || "no agent output"}`);
        }
        return out.join("; ") || "no runs";
      };

      const control = await waitingIssue("Carol");
      const waiting = await waitingIssue("Dave");
      const sent = await schedule(waiting.id);
      const guarded = await until("the guard to repair the control issue", async () => (await guardOn(control.id)).repaired, { timeoutMs: 60_000, everyMs: 2000 }).then(
        () => true,
        () => false,
      );
      await settled(waiting.id);
      const [c, w] = [await guardOn(control.id), await guardOn(waiting.id)];
      t.diagnostic(`control (no monitor): ${JSON.stringify(c)}`);
      t.diagnostic(`backstop: ${JSON.stringify(w)}`);
      if (!guarded) t.diagnostic("this Paperclip didn't repair the control issue: the guard isn't exercised");
      if (w.comments < 1) {
        // The agent's comment is the test's precondition, not the helper's work: say what the runs did.
        const [wOut, cOut] = [await agentOutput(waiting.id), await agentOutput(control.id)];
        const elsewhere = [...`${wOut} ${cOut}`.matchAll(/agent env (\S+)/g)].map((m) => m[1]).find((url) => !sameInstance(url, BASE));
        assert.fail(
          `the agent's own comment was posted with its run's token. It wasn't: backstop issue runs: ${wOut}. Control issue (${c.comments} agent comments) runs: ${cOut}` +
            (elsewhere
              ? `. The agents were told to post to ${elsewhere}, not to this Paperclip (${BASE}): its PAPERCLIP_API_URL came from the environment it was started with. Start it without your PAPERCLIP_* settings (npm run test:compat does).`
              : ""),
        );
      }
      assert.equal(w.repaired, false, "no disposition repair while the backstop stands");
      let full = await s.ctx.api.request("GET", `/api/issues/${waiting.id}`);
      assert.equal(full.status, "in_progress", "not blocked for the board");
      const m = full.executionState?.monitor;
      assert.equal(m?.status, "scheduled");
      assert.equal(m.scheduledBy, "board", "a board key's monitor is scheduledBy board");
      assert.equal(m.notes, sent.notes, "the notes are kept as sent: they name the run");
      assert.ok(isBackstop(m), "the watchdog recognises its own monitor");
      assert.equal(full.executionPolicy?.monitor?.externalRef, "[redacted]", "the externalRef is stored redacted");

      // Fired once, the issue's attempt count is 1: a monitor allowing 1 is refused.
      await ok("POST", `/api/issues/${waiting.id}/monitor/check-now`, {});
      await until("the monitor to fire", async () => (await s.ctx.api.request("GET", `/api/issues/${waiting.id}`)).executionState?.monitor?.status !== "scheduled");
      full = await s.ctx.api.request("GET", `/api/issues/${waiting.id}`);
      assert.ok(monitorAttempts(full) >= 1, `the attempt count moved (${JSON.stringify(full.executionState?.monitor)})`);
      await assert.rejects(schedule(waiting.id, { maxAttempts: monitorAttempts(full) }), (err) => err.status === 422 && /exhausted/i.test(err.message));
      if (full.status === "in_progress") {
        await schedule(waiting.id); // one more than used: accepted
        // The report: the policy without its monitor, with the comment, in one PATCH.
        full = await s.ctx.api.request("GET", `/api/issues/${waiting.id}`);
        const { monitor: _m, ...rest } = full.executionPolicy ?? {};
        await s.ctx.api.request("PATCH", `/api/issues/${waiting.id}`, { executionPolicy: rest, comment: "compat: the CI run finished" });
        full = await s.ctx.api.request("GET", `/api/issues/${waiting.id}`);
        assert.equal(full.executionState?.monitor?.status, "cleared");
        assert.equal(full.executionState.monitor.clearReason, "manual");
        assert.ok(!full.executionPolicy?.monitor);
      } else {
        t.diagnostic(`after the monitor fired the issue is ${full.status}: the clearing isn't checked`);
      }
      // No more runs for the tests after this one.
      for (const owner of [control.owner, waiting.owner]) await ok("POST", `/api/agents/${owner.id}/pause`, {});
    });

    // ------------------------------------------------------------ 8. the end

    test("every request the helper made is to a listed endpoint", () => {
      const patterns = [...HELPER_ENDPOINTS, ...UNDOCUMENTED_ENDPOINTS].map(([method, template]) => ({ method, regex: templateRegex(template) }));
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
