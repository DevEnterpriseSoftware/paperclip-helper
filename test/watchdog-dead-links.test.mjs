import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";

const ISOLATED = {
  executionWorkspaceId: null,
  executionWorkspacePreference: "isolated_workspace",
  executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: null },
};

async function watchdogEnv(t, extra = {}, now) {
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...extra }, now });
  t.after(env.close);
  return { ...env, watchdog: createWatchdog(env.ctx, env.state) };
}

// ACM-318 finished and its isolated workspace was closed; issues created from
// its work are still linked to it.
function closedWorkspace(db, { status = "archived" } = {}) {
  const agent = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
  db.agents.push(agent);
  const owner = { id: uuid(), identifier: "ACM-318", companyId: ids.company, status: "done", updatedAt: minutesAgo(300) };
  const ws = { id: uuid(), companyId: ids.company, sourceIssueId: owner.id, mode: "isolated_workspace", status, branchName: "ACM-318-x" };
  db.executionWorkspaces.push(ws);
  db.issues.push(owner);
  const linked = (identifier, status, extra = {}) => {
    const issue = {
      id: uuid(),
      identifier,
      companyId: ids.company,
      status,
      assigneeAgentId: agent.id,
      updatedAt: minutesAgo(1),
      executionWorkspaceId: ws.id,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      ...extra,
    };
    db.issues.push(issue);
    return issue;
  };
  return { agent, owner, ws, linked };
}

// The run Paperclip fails at setup because the linked workspace can't be restored.
function failedOnLink(db, issue, agent, wsId) {
  const runId = uuid();
  const error =
    `Issue ${issue.identifier} requested inherited execution workspace reuse for ${wsId}, but the workspace could not be restored. ` +
    "Repair or unarchive the referenced execution workspace, or intentionally clear the issue's reuse_existing workspace binding before retrying.";
  db.issueRuns[issue.id] = [{ runId, agentId: agent.id, status: "failed", errorCode: "setup_failed", createdAt: minutesAgo(5), finishedAt: minutesAgo(5) }];
  db.heartbeatRuns.push({ id: runId, companyId: ids.company, agentId: agent.id, status: "failed", errorCode: "setup_failed", error, createdAt: minutesAgo(5) });
}

const patchesFor = (db, issue) => db.patches.filter((p) => p.issueId === issue.id);

test("a link to a closed workspace is cleared, and an assignee whose run failed on it is restarted once", async (t) => {
  const env = await watchdogEnv(t);
  const { agent, ws, linked } = closedWorkspace(env.db);
  const issue = linked("ACM-416", "todo");
  failedOnLink(env.db, issue, agent, ws.id);

  await env.watchdog.tick();
  assert.deepEqual(patchesFor(env.db, issue).map((p) => p.body), [ISOLATED]);
  assert.equal(issue.executionWorkspaceId, null);
  assert.equal(issue.status, "todo", "the status is not changed");
  const comments = env.db.comments.filter((c) => c.issueId === issue.id);
  assert.equal(comments.length, 1);
  assert.ok(comments[0].body.startsWith(`[@Gilfoyle](agent://${agent.id}) this issue was linked to ACM-318's workspace, which is closed`));
  assert.match(comments[0].body, /next run gets a new isolated workspace/);
  assert.equal(env.watchdog.stats.deadLinks, 1);
  assert.ok(env.logs.some((l) => l.msg?.includes("cleared a link to a closed workspace") && l.owner === "ACM-318"));

  await env.watchdog.tick();
  assert.equal(patchesFor(env.db, issue).length, 1, "once");
  assert.equal(env.db.comments.filter((c) => c.issueId === issue.id).length, 1);
});

test("blocked, in-review and backlog issues get the link cleared, without a comment that would override them", async (t) => {
  const env = await watchdogEnv(t);
  const { agent, ws, linked } = closedWorkspace(env.db);
  const blocked = linked("ACM-416", "blocked");
  const review = linked("ACM-415", "in_review");
  const backlog = linked("ACM-420", "backlog");
  for (const i of [blocked, review]) failedOnLink(env.db, i, agent, ws.id);

  await env.watchdog.tick();
  for (const i of [blocked, review, backlog]) assert.equal(i.executionWorkspaceId, null, i.identifier);
  assert.equal(blocked.status, "blocked");
  assert.equal(review.status, "in_review");
  assert.equal(env.db.comments.length, 0);
});

test("a todo issue whose last run didn't fail on the link is cleared without a comment", async (t) => {
  const env = await watchdogEnv(t);
  const { agent, linked } = closedWorkspace(env.db);
  const fresh = linked("ACM-421", "todo");
  const other = linked("ACM-422", "in_progress");
  env.db.issueRuns[other.id] = [{ runId: uuid(), agentId: agent.id, status: "failed", errorCode: "adapter_failed", createdAt: minutesAgo(5) }];

  await env.watchdog.tick();
  assert.equal(fresh.executionWorkspaceId, null);
  assert.equal(other.executionWorkspaceId, null);
  assert.equal(env.db.comments.length, 0);
});

test("a workspace that no longer exists counts as closed", async (t) => {
  const env = await watchdogEnv(t);
  const { linked } = closedWorkspace(env.db);
  const issue = linked("ACM-423", "todo", { executionWorkspaceId: uuid() });
  await env.watchdog.tick();
  assert.equal(issue.executionWorkspaceId, null);
});

test("never touched: a live workspace, its own workspace, a done issue, a run in progress", async (t) => {
  const env = await watchdogEnv(t);
  const { agent, ws, linked } = closedWorkspace(env.db, { status: "active" });
  const foreign = linked("ACM-419", "blocked");
  const own = linked("ACM-424", "todo");
  const ownWs = { id: uuid(), companyId: ids.company, sourceIssueId: own.id, status: "idle" };
  env.db.executionWorkspaces.push(ownWs);
  own.executionWorkspaceId = ownWs.id;

  const closed = { id: uuid(), companyId: ids.company, sourceIssueId: null, status: "archived" };
  env.db.executionWorkspaces.push(closed);
  const done = linked("ACM-425", "done", { executionWorkspaceId: closed.id });
  const busy = linked("ACM-426", "in_progress", { executionWorkspaceId: closed.id });
  env.db.issueRuns[busy.id] = [{ runId: uuid(), agentId: agent.id, status: "running", createdAt: minutesAgo(1) }];
  const checkedOut = linked("ACM-427", "in_progress", { executionWorkspaceId: closed.id, executionRunId: uuid() });

  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  assert.equal(foreign.executionWorkspaceId, ws.id);
  assert.equal(done.executionWorkspaceId, closed.id);

  // Once the run is over, the next tick clears it.
  env.db.issueRuns[busy.id][0].status = "succeeded";
  checkedOut.executionRunId = null;
  await env.watchdog.tick();
  assert.deepEqual(env.db.patches.map((p) => p.identifier).sort(), ["ACM-426", "ACM-427"]);
});

test("a paused assignee's link is cleared, but it isn't restarted", async (t) => {
  const env = await watchdogEnv(t);
  const { agent, ws, linked } = closedWorkspace(env.db);
  agent.status = "paused";
  const issue = linked("ACM-416", "todo");
  failedOnLink(env.db, issue, agent, ws.id);
  await env.watchdog.tick();
  assert.equal(issue.executionWorkspaceId, null);
  assert.equal(env.db.comments.length, 0);
});

test("with isolated workspaces off, nothing is sent and it is reported once a day", async (t) => {
  let clock = Date.now();
  const env = await watchdogEnv(t, {}, () => clock);
  const { linked } = closedWorkspace(env.db);
  const issue = linked("ACM-416", "todo");
  env.db.experimental = { enableIsolatedWorkspaces: false };

  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  const warnings = () => env.logs.filter((l) => l.msg?.includes("Enable Isolated Workspaces"));
  assert.equal(warnings().length, 1);
  assert.deepEqual(warnings()[0].issues, ["ACM-416"]);

  clock += 25 * 60 * 60_000;
  await env.watchdog.tick();
  assert.equal(warnings().length, 2);

  env.db.experimental = { enableIsolatedWorkspaces: true };
  await env.watchdog.tick();
  assert.equal(issue.executionWorkspaceId, null, "cleared once Paperclip accepts it");
});

test("a refused change is tried again a stall window later, up to the cap; one Paperclip ignored is reported once", async (t) => {
  let clock = Date.now();
  const env = await watchdogEnv(t, {}, () => clock);
  const { linked } = closedWorkspace(env.db);
  const issue = linked("ACM-416", "todo");
  const patches = () => env.fake.requests.filter((r) => r.method === "PATCH" && r.path.endsWith(issue.id)).length;

  env.fake.fail("PATCH", /^\/api\/issues\/[^/]+$/, 409, { times: 2, body: { error: "Task run still owns its workspace" } });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(patches(), 1, "not every tick");
  clock += 4 * 60_000;
  await env.watchdog.tick();
  assert.equal(patches(), 2);
  clock += 4 * 60_000;
  await env.watchdog.tick();
  assert.equal(patches(), 2, "WATCHDOG_MAX_NUDGES attempts, then left to you");
  assert.ok(env.logs.some((l) => l.msg?.includes("leaving it to you")));
  assert.notEqual(issue.executionWorkspaceId, null);

  // An older Paperclip that drops the change and has no settings endpoint.
  const other = linked("ACM-428", "todo");
  env.db.experimental = null;
  env.fake.fail("PATCH", /^\/api\/issues\/[^/]+$/, 200, { times: 5, body: {} });
  await env.watchdog.tick();
  clock += 4 * 60_000;
  await env.watchdog.tick();
  assert.notEqual(other.executionWorkspaceId, null);
  assert.equal(env.logs.filter((l) => l.msg?.includes("Paperclip kept the link")).length, 1);
});

test("never cleared: a workspace the key can't read on an older Paperclip, its own closed workspace, a scheduled change", async (t) => {
  const env = await watchdogEnv(t);
  const { agent, ws, owner, linked } = closedWorkspace(env.db, { status: "active" });
  // Older Paperclip: issues don't carry their workspace, and a private one is a 404.
  env.db.noInlineWorkspace = true;
  ws.private = true;
  const hidden = linked("ACM-430", "todo");
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0, "a 404 is not proof the workspace is gone");

  // ...unless the assignee's run failed restoring it.
  failedOnLink(env.db, hidden, agent, ws.id);
  await env.watchdog.tick();
  assert.equal(hidden.executionWorkspaceId, null);
  env.db.noInlineWorkspace = false;

  const closed = { id: uuid(), companyId: ids.company, sourceIssueId: owner.id, status: "archived" };
  env.db.executionWorkspaces.push(closed);
  Object.assign(owner, { status: "todo", executionWorkspaceId: closed.id, executionWorkspacePreference: "reuse_existing", assigneeAgentId: agent.id });
  const scheduled = linked("ACM-431", "todo", { executionWorkspaceId: closed.id, workspacePendingSelection: { selection: "isolated_workspace" } });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(owner.executionWorkspaceId, closed.id, "its own closed workspace: unarchiving may be the better fix");
  assert.equal(scheduled.executionWorkspaceId, closed.id);
  assert.equal(env.logs.filter((l) => l.msg?.includes("its own closed workspace")).length, 1);
});

test("the issue's other workspace settings are kept", async (t) => {
  const env = await watchdogEnv(t);
  const { linked } = closedWorkspace(env.db);
  const settings = { mode: "isolated_workspace", environmentId: uuid(), workspaceStrategy: { type: "git_worktree", existingBranch: "feature/x" } };
  const issue = linked("ACM-432", "todo", { executionWorkspaceSettings: settings });
  await env.watchdog.tick();
  assert.equal(issue.executionWorkspaceId, null);
  assert.deepEqual(issue.executionWorkspaceSettings, settings);
});

test("dry run and WATCHDOG_CLEAR_DEAD_LINKS=false change nothing", async (t) => {
  const dry = await watchdogEnv(t, { DRY_RUN: "true" });
  const a = closedWorkspace(dry.db).linked("ACM-416", "todo");
  await dry.watchdog.tick();
  assert.equal(dry.db.patches.length, 0);
  assert.notEqual(a.executionWorkspaceId, null);
  assert.ok(dry.logs.some((l) => l.msg?.includes("would clear a link to a closed workspace")));
  await dry.watchdog.tick();
  assert.equal(dry.logs.filter((l) => l.msg?.includes("would clear")).length, 1, "logged once");
  assert.ok(!dry.state.nudges.entries().some(([k]) => k.startsWith("dead-link")), "nothing recorded: turning dry run off clears it");

  const off = await watchdogEnv(t, { WATCHDOG_CLEAR_DEAD_LINKS: "false" });
  const b = closedWorkspace(off.db).linked("ACM-416", "todo");
  await off.watchdog.tick();
  assert.equal(off.db.patches.length, 0);
  assert.notEqual(b.executionWorkspaceId, null);
});
