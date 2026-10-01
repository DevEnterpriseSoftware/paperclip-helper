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
