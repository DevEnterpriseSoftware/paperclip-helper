import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";

function agents(db) {
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "claude_local" };
  const reviewer = { id: uuid(), companyId: ids.company, name: "Reviewer", status: "idle", adapterType: "claude_local" };
  db.agents.push(engineer, reviewer);
  return { engineer, reviewer };
}

// An issue handed from the engineer to the reviewer ten minutes ago; the reviewer never started.
// The engineer's run was created 300 minutes ago, so a deferred wake a test adds is never
// stale: no finished run was created after it.
function droppedHandOff(db) {
  const { engineer, reviewer } = agents(db);
  const issue = { id: uuid(), identifier: "ACM-5", companyId: ids.company, status: "in_review", assigneeAgentId: reviewer.id, updatedAt: minutesAgo(10) };
  db.issues.push(issue);
  db.issueRuns[issue.id] = [{ runId: uuid(), agentId: engineer.id, status: "cancelled", createdAt: minutesAgo(300), finishedAt: minutesAgo(10) }];
  return { issue, engineer, reviewer };
}

async function watchdogEnv(t, extra = {}, now) {
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...extra }, now });
  t.after(env.close);
  return { ...env, watchdog: createWatchdog(env.ctx, env.state) };
}

test("a dropped hand-off gets one mention comment per stall window, up to the cap, across restarts", async (t) => {
  let clock = Date.now();
  const env = await watchdogEnv(t, {}, () => clock);
  const { issue, reviewer } = droppedHandOff(env.db);

  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  const body = env.db.comments[0].body;
  assert.ok(body.startsWith(`[@Reviewer](agent://${reviewer.id}) this issue is yours now (in_review)`));
  assert.match(body, /paperclipai\/paperclip#13880/);
  // No URL: Paperclip would link it to the issue as a pull request.
  assert.doesNotMatch(body, /github\.com/);
  assert.match(body, /nudge 1\/2/);

  // The comment refreshed updatedAt: the next tick waits for the stall window.
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);

  // The watchdog's own record also holds the next nudge back, even when updatedAt looks old.
  issue.updatedAt = minutesAgo(10);
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);

  clock += 4 * 60_000;
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 2);
  assert.match(env.db.comments[1].body, /nudge 2\/2/);
  clock += 4 * 60_000;

  // A restarted watchdog remembers the cap.
  issue.updatedAt = minutesAgo(10);
  const restarted = createWatchdog(env.ctx, createStateStore(env.ctx.config.stateFile));
  await restarted.tick();
  assert.equal(env.db.comments.length, 2);
});

test("no nudge when a wake is pending, a run is active, the agent is paused, or the issue moved recently", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, reviewer } = droppedHandOff(env.db);

  env.db.wakes[issue.id] = [{ kind: "wake_request", status: "queued", reason: "issue_assigned" }];
  await env.watchdog.tick();
  env.db.wakes[issue.id] = [{ kind: "wake_request", status: "deferred_issue_execution" }];
  await env.watchdog.tick();
  env.db.wakes[issue.id] = [];

  env.db.issueRuns[issue.id].push({ runId: uuid(), agentId: reviewer.id, status: "queued", createdAt: minutesAgo(1) });
  await env.watchdog.tick();
  env.db.issueRuns[issue.id].pop();

  reviewer.status = "paused";
  await env.watchdog.tick();
  reviewer.status = "idle";

  issue.updatedAt = minutesAgo(1);
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);

  issue.updatedAt = minutesAgo(10);
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
});

test("wakes deferred for other agents don't hide a dropped hand-off from the assignee", async (t) => {
  // Handed from the engineer to the reviewer: the deferred wakes belong to the
  // engineer, and nothing waits for the reviewer.
  const env = await watchdogEnv(t);
  const { issue, engineer, reviewer } = droppedHandOff(env.db);
  const deferred = (agentId, reason, min) => ({ kind: "wake_request", agentId, status: "deferred_issue_execution", reason, requestedAt: minutesAgo(min) });
  env.db.wakes[issue.id] = [deferred(engineer.id, "issue_comment_mentioned", 200), deferred(engineer.id, "other", 220)];
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.ok(env.db.comments[0].body.startsWith(`[@Reviewer](agent://${reviewer.id})`));
  assert.equal(env.logs.filter((l) => l.msg.startsWith("watchdog: a wake has been deferred")).length, 0);

  // A wake waiting for the assignee itself still holds the nudge back.
  const env2 = await watchdogEnv(t);
  const second = droppedHandOff(env2.db);
  env2.db.wakes[second.issue.id] = [deferred(second.reviewer.id, "issue_commented", 200)];
  await env2.watchdog.tick();
  assert.equal(env2.db.comments.length, 0);
  assert.equal(env2.logs.filter((l) => l.msg.startsWith("watchdog: a wake has been deferred")).length, 1);
});

test("runs Paperclip refused before they started don't count as the owner having run", async (t) => {
  // DIR-91: the reviewer's runs after the hand-off were cancelled at admission
  // (execution_reconciliation_required) and its wakes skipped. The hold cleared
  // later, and nothing woke the reviewer again.
  const env = await watchdogEnv(t);
  const { issue, reviewer } = droppedHandOff(env.db);
  const refusedRun = (min) => ({ runId: uuid(), agentId: reviewer.id, status: "cancelled", errorCode: "execution_reconciliation_required", createdAt: minutesAgo(min), finishedAt: minutesAgo(min) });
  env.db.issueRuns[issue.id].push(refusedRun(8), refusedRun(7));
  env.db.wakes[issue.id] = [{ kind: "wake_request", agentId: reviewer.id, status: "skipped", reason: "other", requestedAt: minutesAgo(7) }];

  // Still held: a comment's run would be refused as well.
  issue.executionBlocker = { cause: "execution_owner_active", runId: uuid(), recoveryActionId: null };
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);

  // The hold has cleared: nudge the reviewer.
  issue.executionBlocker = null;
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.ok(env.db.comments[0].body.startsWith(`[@Reviewer](agent://${reviewer.id})`));

  // A refusal within the stall window is too recent to act on.
  const env2 = await watchdogEnv(t);
  const second = droppedHandOff(env2.db);
  env2.db.issueRuns[second.issue.id].push({ ...refusedRun(1), agentId: second.reviewer.id });
  await env2.watchdog.tick();
  assert.equal(env2.db.comments.length, 0);

  // A run of the reviewer's that did start still counts.
  const env3 = await watchdogEnv(t);
  const third = droppedHandOff(env3.db);
  env3.db.issueRuns[third.issue.id].push({ runId: uuid(), agentId: third.reviewer.id, status: "cancelled", errorCode: "issue_reassigned", createdAt: minutesAgo(8), finishedAt: minutesAgo(8) });
  await env3.watchdog.tick();
  assert.equal(env3.db.comments.length, 0);
});

test("an assignee's wake deferred before a later run came and went is stale and doesn't hold the nudge back", async (t) => {
  // The reviewer's wake was deferred 16 minutes ago; a run created after it (the
  // engineer's, reassigned) has since finished, so execution moved on without it.
  const env = await watchdogEnv(t);
  const { issue, engineer, reviewer } = droppedHandOff(env.db);
  env.db.issueRuns[issue.id].push({ runId: uuid(), agentId: engineer.id, status: "cancelled", errorCode: "issue_reassigned", createdAt: minutesAgo(15), finishedAt: minutesAgo(10) });
  env.db.wakes[issue.id] = [
    { kind: "wake_request", agentId: reviewer.id, status: "deferred_issue_execution", reason: "issue_comment_mentioned", requestedAt: minutesAgo(16) },
  ];
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.ok(env.db.comments[0].body.startsWith(`[@Reviewer](agent://${reviewer.id})`));
  assert.equal(env.logs.filter((l) => l.msg.startsWith("watchdog: a wake has been deferred")).length, 0);
});

test("an agent waiting for approval is not nudged", async (t) => {
  const env = await watchdogEnv(t);
  const { reviewer } = droppedHandOff(env.db);
  reviewer.status = "pending_approval";
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
});

test("a paused issue's nudge is postponed, not used up, and sent once it's resumed", async (t) => {
  let clock = Date.now();
  const env = await watchdogEnv(t, {}, () => clock);
  const { issue } = droppedHandOff(env.db);
  issue.paused = true;
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  assert.ok(!env.logs.some((l) => l.level === "warn"), "no warning for a paused issue");

  issue.paused = false;
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0, "still within the stall window");
  clock += 4 * 60_000;
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.match(env.db.comments[0].body, /nudge 1\/2/);
});

test("a wake deferred far longer than a lease is held is reported once, not nudged", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = droppedHandOff(env.db);
  env.db.issueRuns[issue.id][0].environmentLease = { status: "expired" };
  env.db.wakes[issue.id] = [{ kind: "wake_request", status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) }];
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  const warnings = env.logs.filter((l) => l.msg.startsWith("watchdog: a wake has been deferred"));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].previousRunLease, "expired");
  assert.equal(env.watchdog.stats.stuck, 1);
  // No saved comments are queued, so nothing is re-sent.
  assert.equal(env.db.interrupts.length, 0);
});

test("the stuck report describes the newest deferred wake, not the oldest", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = droppedHandOff(env.db);
  // Paperclip lists wake events newest first.
  env.db.wakes[issue.id] = [
    { kind: "wake_request", status: "deferred_issue_execution", reason: "issue_comment_mentioned", requestedAt: minutesAgo(30) },
    { kind: "wake_request", status: "deferred_issue_execution", reason: "other", requestedAt: minutesAgo(90) },
    { kind: "wake_request", status: "deferred_issue_execution", reason: "other", requestedAt: minutesAgo(240) },
  ];
  await env.watchdog.tick();
  const [warning] = env.logs.filter((l) => l.msg.startsWith("watchdog: a wake has been deferred"));
  assert.equal(warning.reason, "issue_comment_mentioned");
  assert.equal(warning.deferredMin, 30);

  // A newer deferred wake (say, from a retry) is a new situation and is reported again.
  env.db.wakes[issue.id].unshift({ kind: "wake_request", status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(15) });
  await env.watchdog.tick();
  assert.equal(env.logs.filter((l) => l.msg.startsWith("watchdog: a wake has been deferred")).length, 2);
});

function stuckWithQueue(env, queue = {}) {
  const { issue } = droppedHandOff(env.db);
  env.db.wakes[issue.id] = [{ kind: "wake_request", status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) }];
  env.db.queuedComments[issue.id] = {
    issueId: issue.id,
    queueId: uuid(),
    state: "deferred",
    targetRunId: null,
    revision: "rev-1",
    protocol: "legacy",
    entries: [{ comment: { id: uuid(), body: "please continue" }, position: 0 }],
    executionWait: { reason: "execution_owner_active", message: "Waiting for execution recovery." },
    ...queue,
  };
  return issue;
}

test("with WATCHDOG_RETRY_DEFERRED, a stuck queue of saved comments is re-sent, capped and spaced", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_RETRY_DEFERRED: "true" });
  const issue = stuckWithQueue(env);

  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 1);
  assert.deepEqual(env.db.interrupts[0].body, { queueId: env.db.queuedComments[issue.id].queueId, revision: "rev-1", targetRunId: null });
  assert.equal(env.watchdog.stats.retries, 1);
  assert.equal(env.db.comments.length, 0);

  // Not again within the stall window.
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 1);

  // Spaced by the stall window, capped at WATCHDOG_MAX_NUDGES, across restarts.
  const key = `retry:${issue.id}`;
  env.state.nudges.set(key, { ...env.state.nudges.get(key), at: Date.now() - 10 * 60_000 });
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 2);
  env.state.nudges.set(key, { ...env.state.nudges.get(key), at: Date.now() - 10 * 60_000 });
  env.state.save();
  const restarted = createWatchdog(env.ctx, createStateStore(env.ctx.config.stateFile));
  await restarted.tick();
  assert.equal(env.db.interrupts.length, 2);

  // Once nothing is deferred any more, a later episode gets its own retries.
  env.db.wakes[issue.id] = [];
  await env.watchdog.tick(); // (this tick nudges the idle hand-off instead)
  assert.equal(env.state.nudges.has(key), false);
  issue.updatedAt = minutesAgo(10);
  env.db.wakes[issue.id] = [{ kind: "wake_request", status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(12) }];
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 3);
});

test("a deferred wake with nothing to re-send, a queue in another protocol, or one targeting a run, is only reported", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_RETRY_DEFERRED: "true" });
  const noQueue = stuckWithQueue(env);
  delete env.db.queuedComments[noQueue.id];
  const running = stuckWithQueue(env, { targetRunId: uuid() });
  const native = stuckWithQueue(env, { protocol: "paperclip_runner_v1" });

  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 0);
  const skips = env.logs.filter((l) => l.msg.startsWith("watchdog: no saved comments to re-send"));
  assert.deepEqual(skips.map((l) => l.issue).sort(), [noQueue, running, native].map((i) => i.identifier).sort());
});

test("a refused retry is logged, and dry run only logs", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_RETRY_DEFERRED: "true" });
  const issue = stuckWithQueue(env);
  env.fake.fail("POST", `/api/issues/${issue.id}/queued-comments/interrupt`, 409, { body: { error: "The previous run has not stopped" } });
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 0);
  assert.ok(env.logs.some((l) => l.msg === "watchdog: Paperclip refused to retry the deferred wake"));

  const dry = await watchdogEnv(t, { WATCHDOG_RETRY_DEFERRED: "true", DRY_RUN: "true" });
  stuckWithQueue(dry);
  await dry.watchdog.tick();
  assert.equal(dry.db.interrupts.length, 0);
  assert.ok(dry.logs.some((l) => l.msg === "watchdog: would retry the deferred wake (dry run)"));
});

test("the owner having run since the hand-off is not a stall", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, reviewer } = droppedHandOff(env.db);
  env.db.issueRuns[issue.id].push({ runId: uuid(), agentId: reviewer.id, status: "succeeded", createdAt: minutesAgo(8), finishedAt: minutesAgo(7) });
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
});

test("dry run logs the nudge and posts nothing", async (t) => {
  const env = await watchdogEnv(t, { DRY_RUN: "true" });
  droppedHandOff(env.db);
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  assert.ok(env.logs.some((l) => l.msg === "watchdog: would nudge (dry run)"));
});

test("a blocked issue whose blockers are all done gets a nudge", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer } = agents(env.db);
  const issue = { id: uuid(), identifier: "ACM-6", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(10) };
  env.db.issues.push(issue);
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: true, isDependencyReady: true, unresolvedBlockerCount: 0 },
    blockers: [{ id: uuid(), identifier: "ACM-7", status: "done" }],
  };
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.match(env.db.comments[0].body, /every blocker on this issue is done \(ACM-7\)/);
});

test("a done blocker whose workspace clean-up failed is detached and the issue moves to todo", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer } = agents(env.db);
  const workspaceId = uuid();
  const blocker = { id: uuid(), identifier: "ACM-9", companyId: ids.company, status: "done", executionWorkspaceId: workspaceId };
  const issue = {
    id: uuid(),
    identifier: "ACM-8",
    companyId: ids.company,
    status: "blocked",
    assigneeAgentId: engineer.id,
    updatedAt: minutesAgo(1),
    blockedBy: [{ id: blocker.id }],
  };
  env.db.issues.push(blocker, issue);
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: false, isDependencyReady: false, unresolvedBlockerCount: 1, pendingFinalizeBlockerCount: 1 },
    blockers: [{ id: blocker.id, identifier: "ACM-9", status: "done", isPendingFinalize: true }],
  };
  env.db.workspaceOps[workspaceId] = [
    { phase: "workspace_prepare", status: "succeeded", startedAt: minutesAgo(40) },
    { phase: "workspace_finalize", status: "failed", startedAt: minutesAgo(12), finishedAt: minutesAgo(11) },
  ];

  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  const patch = env.db.patches[0].body;
  assert.deepEqual(patch.blockedByIssueIds, []);
  assert.equal(patch.status, "todo");
  assert.match(patch.comment, new RegExp(`^\\[@Engineer\\]\\(agent://${engineer.id}\\) ACM-9 is done, but its workspace clean-up`));
  assert.match(patch.comment, /pull the branch/);
});

// A blocked ACM-8 whose done blocker ACM-9's workspace clean-up failed half an hour ago.
function failedFinalize(env) {
  const { engineer } = agents(env.db);
  const workspaceId = uuid();
  const blocker = { id: uuid(), identifier: "ACM-9", companyId: ids.company, status: "done", executionWorkspaceId: workspaceId };
  const issue = { id: uuid(), identifier: "ACM-8", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(1), blockedBy: [{ id: blocker.id }] };
  env.db.issues.push(blocker, issue);
  const diag = {
    readiness: { allBlockersDone: false },
    blockers: [{ id: blocker.id, identifier: "ACM-9", status: "done", isPendingFinalize: true }],
  };
  env.db.blockerDiagnostics[issue.id] = diag;
  env.db.workspaceOps[workspaceId] = [{ phase: "workspace_finalize", status: "failed", startedAt: minutesAgo(31), finishedAt: minutesAgo(30) }];
  return { issue, blocker, diag, workspaceId };
}

test("a failed finalize isn't repaired while another blocker is still open", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, diag } = failedFinalize(env);
  const open = { id: uuid(), identifier: "ACM-10", companyId: ids.company, status: "in_progress" };
  env.db.issues.push(open);
  issue.blockedBy.push({ id: open.id });
  diag.blockers.push({ id: open.id, identifier: "ACM-10", status: "in_progress" });
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
});

test("a failed finalize followed by a newer operation is left to Paperclip", async (t) => {
  const env = await watchdogEnv(t);
  const { workspaceId } = failedFinalize(env);
  env.db.workspaceOps[workspaceId].push({ phase: "workspace_finalize", status: "running", startedAt: minutesAgo(5) });
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
});

test("a paused issue's repair waits quietly until it's resumed", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = failedFinalize(env);
  issue.paused = true;
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  assert.ok(!env.logs.some((l) => l.level === "warn"), "no warning for a paused issue");
  issue.paused = false;
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
});

test("a repair keeps the issue's other blockers, so it stays blocked rather than moving to todo", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, blocker } = failedFinalize(env);
  const other = { id: uuid(), identifier: "ACM-11", companyId: ids.company, status: "done" };
  env.db.issues.push(other);
  issue.blockedBy.push({ id: other.id });
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  const patch = env.db.patches[0].body;
  assert.deepEqual(patch.blockedByIssueIds, [other.id]);
  assert.equal(patch.status, undefined);
  assert.doesNotMatch(patch.comment, /back in todo/);
  assert.ok(!patch.blockedByIssueIds.includes(blocker.id));
});

test("finalize failures younger than the stall window, or healing turned off, are left alone", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer } = agents(env.db);
  const workspaceId = uuid();
  const blocker = { id: uuid(), identifier: "ACM-9", companyId: ids.company, status: "done", executionWorkspaceId: workspaceId };
  const issue = { id: uuid(), identifier: "ACM-8", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(1), blockedBy: [{ id: blocker.id }] };
  env.db.issues.push(blocker, issue);
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: false },
    blockers: [{ id: blocker.id, identifier: "ACM-9", status: "done", isPendingFinalize: true }],
  };
  env.db.workspaceOps[workspaceId] = [{ phase: "workspace_finalize", status: "failed", startedAt: minutesAgo(1), finishedAt: minutesAgo(1) }];
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);

  env.db.workspaceOps[workspaceId][0].finishedAt = minutesAgo(30);
  const off = createWatchdog(env.makeCtx({ WATCHDOG_HEAL_FAILED_FINALIZE: "false" }), env.state);
  await off.tick();
  assert.equal(env.db.patches.length, 0);
});

// DIR-86: Paperclip's recovery gave up on a run cancelled at a hand-off and marked
// the issue blocked, with no linked blocker and a saved message waiting.
function recoveryHold(env, { errorCode = "issue_reassigned" } = {}) {
  const { engineer, reviewer } = agents(env.db);
  const source = { runId: uuid(), agentId: reviewer.id, status: "cancelled", errorCode, createdAt: minutesAgo(4000), finishedAt: minutesAgo(4000) };
  const issue = {
    id: uuid(),
    identifier: "ACM-86",
    companyId: ids.company,
    status: "blocked",
    assigneeAgentId: engineer.id,
    updatedAt: minutesAgo(60),
    executionBlocker: { recoveryActionId: uuid(), runId: source.runId, agentId: reviewer.id, cause: "automatic_recovery_blocked", nextAction: "Inspect the evidence" },
  };
  env.db.issues.push(issue);
  env.db.issueRuns[issue.id] = [
    { runId: uuid(), agentId: engineer.id, status: "succeeded", createdAt: minutesAgo(2500), finishedAt: minutesAgo(2490) },
    source,
  ];
  // The saved message's wake predates the engineer's later run, and is still the live queue.
  env.db.wakes[issue.id] = [{ kind: "wake_request", agentId: engineer.id, status: "deferred_issue_execution", reason: "issue_assigned", requestedAt: minutesAgo(3900) }];
  env.db.blockerDiagnostics[issue.id] = { readiness: { allBlockersDone: true, unresolvedBlockerCount: 0 }, blockers: [] };
  env.db.queuedComments[issue.id] = {
    issueId: issue.id,
    queueId: uuid(),
    state: "deferred",
    targetRunId: null,
    revision: "rev-1",
    protocol: "legacy",
    entries: [{ comment: { id: uuid(), body: "Hand-off to Software Architect" }, position: 0 }],
    executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." },
  };
  return { issue, source };
}

test("a recovery hold left by a hand-off is released by delivering the saved messages, capped and spaced", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, source } = recoveryHold(env);

  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 1);
  assert.deepEqual(env.db.interrupts[0].body, { queueId: env.db.queuedComments[issue.id].queueId, revision: "rev-1", targetRunId: null });
  assert.equal(env.db.comments.length, 0);

  // Still held on the next ticks: not again within the stall window, then once more, then never.
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 1);
  const key = `hold:${issue.id}:${source.runId}`;
  const age = () => env.state.nudges.set(key, { ...env.state.nudges.get(key), at: Date.now() - 10 * 60_000 });
  age();
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 2);
  age();
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 2);
});

test("a recovery hold with any other cause, a running run, or retries turned off is left to the board", async (t) => {
  const env = await watchdogEnv(t);
  const uncertain = recoveryHold(env, { errorCode: "process_lost" });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 0);
  const reports = env.logs.filter((l) => l.msg === "watchdog: the issue is held for recovery and needs a board decision");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].issue, uncertain.issue.identifier);
  assert.equal(reports[0].sourceRunError, "process_lost");

  const env2 = await watchdogEnv(t);
  const busy = recoveryHold(env2);
  env2.db.issueRuns[busy.issue.id].push({ runId: uuid(), agentId: busy.issue.assigneeAgentId, status: "running", createdAt: minutesAgo(1) });
  await env2.watchdog.tick();
  assert.equal(env2.db.interrupts.length, 0);

  const env3 = await watchdogEnv(t, { WATCHDOG_RETRY_DEFERRED: "false" });
  recoveryHold(env3);
  await env3.watchdog.tick();
  assert.equal(env3.db.interrupts.length, 0);
  assert.equal(env3.logs.filter((l) => l.msg === "watchdog: the issue is held for recovery and needs a board decision").length, 1);
});

test("a blocked issue with no linked blocker and no recovery hold is left alone", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = recoveryHold(env);
  issue.executionBlocker = null; // an agent blocked it with a note of its own
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 0);
  assert.equal(env.db.comments.length, 0);
});

test("no repair and no hold release while the assignee is paused", async (t) => {
  // DIR-109: the repair moved the issue to todo while its assignee was paused, and
  // Paperclip's recovery blocked it again for a board decision.
  const env = await watchdogEnv(t);
  const { engineer } = agents(env.db);
  engineer.status = "paused";
  const workspaceId = uuid();
  const blocker = { id: uuid(), identifier: "ACM-9", companyId: ids.company, status: "done", executionWorkspaceId: workspaceId };
  const issue = { id: uuid(), identifier: "ACM-8", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(60), blockedBy: [{ id: blocker.id }] };
  env.db.issues.push(blocker, issue);
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: false, unresolvedBlockerCount: 1, pendingFinalizeBlockerCount: 1 },
    blockers: [{ id: blocker.id, identifier: "ACM-9", status: "done", isPendingFinalize: true }],
  };
  env.db.workspaceOps[workspaceId] = [{ phase: "workspace_finalize", status: "failed", startedAt: minutesAgo(30), finishedAt: minutesAgo(30) }];
  const held = recoveryHold(env);
  env.db.agents.find((a) => a.id === held.issue.assigneeAgentId).status = "paused";

  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  assert.equal(env.db.interrupts.length, 0);

  // Resumed: both go ahead.
  for (const a of env.db.agents) a.status = "idle";
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  assert.equal(env.db.interrupts.length, 1);
});

// DIR-109: Paperclip's recovery sweep ran while the assignee was paused, recorded a
// recovery action for the board and marked the issue blocked. Nothing un-parks it.
function parkedIssue(env, action = {}) {
  const { engineer } = agents(env.db);
  const issue = { id: uuid(), identifier: "ACM-109", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(180) };
  env.db.issues.push(issue);
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: engineer.id, status: "succeeded", createdAt: minutesAgo(3000), finishedAt: minutesAgo(2990) }];
  env.db.blockerDiagnostics[issue.id] = { readiness: { allBlockersDone: true, unresolvedBlockerCount: 0 }, blockers: [] };
  env.db.recoveryActions[issue.id] = {
    id: uuid(),
    kind: "stranded_assigned_issue",
    cause: "stranded_assigned_issue",
    status: "active",
    ownerType: "board",
    nextAction: "Board operator: inspect the evidence, then explicitly retry the original owner, reassign, or resolve.",
    ...action,
  };
  return { issue, engineer };
}

test("an issue Paperclip's recovery parked is nudged once its assignee is available, capped", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, engineer } = parkedIssue(env);

  engineer.status = "paused";
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);

  engineer.status = "idle";
  issue.updatedAt = minutesAgo(180);
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.ok(env.db.comments[0].body.startsWith(`[@Engineer](agent://${engineer.id}) Paperclip's recovery parked this issue`));
  assert.match(env.db.comments[0].body, /nudge 1\/2/);

  // The fake leaves it blocked: a second nudge a stall window later, then no more.
  for (let i = 0; i < 3; i++) {
    issue.updatedAt = minutesAgo(180);
    const key = `parked:${issue.id}:${env.db.recoveryActions[issue.id].id}`;
    env.state.nudges.set(key, { ...env.state.nudges.get(key), at: Date.now() - 10 * 60_000 });
    await env.watchdog.tick();
  }
  assert.equal(env.db.comments.length, 2);
});

test("a parked issue with saved messages gets them delivered instead of a comment", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = parkedIssue(env);
  env.db.queuedComments[issue.id] = {
    issueId: issue.id, queueId: uuid(), state: "deferred", targetRunId: null, revision: "rev-1", protocol: "legacy",
    entries: [{ comment: { id: uuid(), body: "Hand-off to Software Architect" }, position: 0 }],
  };
  await env.watchdog.tick();
  assert.equal(env.db.interrupts.length, 1);
  assert.equal(env.db.comments.length, 0);
});

test("any other kind of recovery action, or a running run, is left to the board", async (t) => {
  const env = await watchdogEnv(t);
  parkedIssue(env, { kind: "stalled_review", cause: "stalled_review" });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  const reports = env.logs.filter((l) => l.msg === "watchdog: Paperclip's recovery parked the issue and it needs a board decision");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, "stalled_review");

  const env2 = await watchdogEnv(t);
  const busy = parkedIssue(env2);
  env2.db.issueRuns[busy.issue.id].push({ runId: uuid(), agentId: busy.engineer.id, status: "running", createdAt: minutesAgo(1) });
  await env2.watchdog.tick();
  assert.equal(env2.db.comments.length, 0);
});

// DIR-52: Carla's run was cut off at a hand-off and recorded no process, so
// Paperclip held the issue for reconciliation and saved every message behind
// it ("no verified stop record"). Gilfoyle ran after; Carla never could.
function unprovableHold(env, { ownRun = false, saved = true, finishedMin = 60, pid = null, lease = null } = {}) {
  const { engineer: carla, reviewer: gilfoyle } = agents(env.db);
  carla.name = "Carla";
  const source = {
    runId: uuid(), agentId: carla.id, status: ownRun ? "failed" : "cancelled", errorCode: ownRun ? "adapter_failed" : "issue_reassigned",
    createdAt: minutesAgo(finishedMin + 1), finishedAt: minutesAgo(finishedMin), ...(lease ? { environmentLease: lease } : {}),
  };
  const issue = {
    id: uuid(), identifier: "ACM-52", companyId: ids.company, status: "todo", assigneeAgentId: carla.id, updatedAt: minutesAgo(30),
    executionBlocker: {
      recoveryActionId: uuid(), runId: source.runId, agentId: carla.id, cause: "legacy_execution_requires_reconciliation",
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
    },
  };
  env.db.issues.push(issue);
  env.db.issueRuns[issue.id] = ownRun
    ? [source]
    : [{ runId: uuid(), agentId: gilfoyle.id, status: "succeeded", createdAt: minutesAgo(finishedMin - 5), finishedAt: minutesAgo(finishedMin - 10) }, source];
  env.db.heartbeatRuns.push({ id: source.runId, companyId: ids.company, agentId: carla.id, status: source.status, processPid: pid, processGroupId: null });
  if (saved) {
    env.db.wakes[issue.id] = [{ kind: "wake_request", agentId: carla.id, status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) }];
    env.db.queuedComments[issue.id] = {
      issueId: issue.id, queueId: uuid(), state: "deferred", targetRunId: null, revision: "rev-1", protocol: "legacy",
      entries: [{ comment: { id: uuid(), body: "Changes requested on PR #14" }, position: 0 }],
      executionWait: { reason: "process_identity_missing", message: "The previous run has no verified stop record. Paperclip cannot start this message yet." },
    };
  }
  return { issue, source, carla };
}

const released = (env) => env.logs.filter((l) => l.msg === "watchdog: released a hold Paperclip couldn't release by itself");

test("a hold Paperclip can't release by itself is released once, and its saved messages delivered", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, source } = unprovableHold(env);
  const actionId = issue.executionBlocker.recoveryActionId;

  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1);
  const { body } = env.db.resolutions[0];
  assert.equal(body.actionId, actionId);
  assert.equal(body.outcome, "restored");
  assert.equal(body.sourceIssueStatus, "todo");
  assert.deepEqual(
    [body.executionReconciliation.runId, body.executionReconciliation.providerStopped, body.executionReconciliation.actionOutcome],
    [source.runId, true, "mixed"],
  );
  assert.match(body.resolutionNote, /Paperclip Helper's watchdog/);
  assert.equal(issue.executionBlocker, null);
  assert.equal(env.db.interrupts.length, 1, "the saved messages are delivered");
  assert.equal(env.db.comments.length, 0, "no extra comment: the saved messages wake the assignee");
  assert.equal(env.watchdog.stats.releases, 1);
  assert.equal(released(env)[0].issue, "ACM-52");

  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1, "once per held run");
});

test("an owner's own run that left a hold and no messages is released, with a comment to check the branch", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, carla } = unprovableHold(env, { ownRun: true, saved: false });
  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1);
  assert.equal(issue.executionBlocker, null);
  assert.equal(env.db.comments.length, 1);
  assert.ok(env.db.comments[0].body.startsWith(`[@Carla](agent://${carla.id}) Paperclip held this issue`));
  assert.match(env.db.comments[0].body, /check the workspace and branch/);
});

test("a hold is not released while its run just ended, a process id was recorded, the lease is held, or the owner is paused", async (t) => {
  const recent = await watchdogEnv(t);
  unprovableHold(recent, { finishedMin: 1 });
  await recent.watchdog.tick();
  assert.equal(recent.db.resolutions, undefined, "a run that just ended gets its stall window");

  const pid = await watchdogEnv(t);
  const withPid = unprovableHold(pid, { saved: false, pid: 999999999 });
  await pid.watchdog.tick();
  assert.equal(pid.db.resolutions, undefined, "a recorded process is Paperclip's to check");
  assert.ok(withPid.issue.executionBlocker);

  const leased = await watchdogEnv(t);
  unprovableHold(leased, { lease: { status: "active", releasedAt: null } });
  await leased.watchdog.tick();
  await leased.watchdog.tick();
  assert.equal(leased.db.resolutions, undefined);
  const warn = leased.logs.filter((l) => l.msg === "watchdog: a hold Paperclip can't release by itself isn't safe to release yet");
  assert.equal(warn.length, 1, "reported once");
  assert.deepEqual(warn[0].problems, ["its environment lease was never released"]);

  const paused = await watchdogEnv(t);
  const p = unprovableHold(paused);
  p.carla.status = "paused";
  await paused.watchdog.tick();
  assert.equal(paused.db.resolutions, undefined);
});

test("WATCHDOG_RELEASE_HOLDS=false and dry run release nothing", async (t) => {
  const off = await watchdogEnv(t, { WATCHDOG_RELEASE_HOLDS: "false" });
  unprovableHold(off);
  await off.watchdog.tick();
  assert.equal(off.db.resolutions, undefined);

  const dry = await watchdogEnv(t, { DRY_RUN: "true" });
  unprovableHold(dry);
  await dry.watchdog.tick();
  assert.equal(dry.db.resolutions, undefined);
  assert.equal(dry.logs.filter((l) => l.msg.startsWith("watchdog: would release a hold")).length, 1);
});

test("a hold that comes back after the release is reported once, not released again", async (t) => {
  let clock = Date.now();
  const env = await watchdogEnv(t, {}, () => clock);
  const { issue } = unprovableHold(env);
  const hold = { ...issue.executionBlocker };
  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1);
  issue.executionBlocker = hold;
  issue.updatedAt = minutesAgo(30);
  clock += 10 * 60_000;
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1);
  assert.equal(env.logs.filter((l) => l.msg === "watchdog: a hold the watchdog released is back; it needs a board decision").length, 1);
});
