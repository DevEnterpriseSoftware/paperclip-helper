// Watchdog 22 and release.mjs: holds behind runs Paperclip's dispatch cancelled
// before they started (DIR-1294, DIR-1355, DIR-1230), and reports of holds behind
// runs that did execute (DIR-1277).
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import * as cmd from "../src/commands.mjs";
import { DISPATCH_GATE_CODES, neverStarted, releaseProblems } from "../src/release.mjs";
import { advise } from "../src/advice.mjs";

const CAUSE = "legacy_execution_requires_reconciliation";

// ---------------------------------------------------------------- the classifier

// A run as GET /api/heartbeat-runs/:id has it after a dispatch gate cancelled it.
const unstartedRun = (over = {}) => ({
  id: "run-1", status: "cancelled", errorCode: "issue_assignee_changed", runtimeMode: "legacy",
  createdAt: minutesAgo(61), finishedAt: minutesAgo(60), startedAt: null, runtimeModeResolvedAt: null,
  processPid: null, processGroupId: null, processStartedAt: null, nativeIssueId: null, nativeSessionId: null,
  sessionIdAfter: null, controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
  usageJson: null, resultJson: { stopReason: "issue_assignee_changed" }, contextSnapshot: { issueId: "issue-1" },
  detailRead: true, events: [{ seq: 1, eventType: "lifecycle", sourceEventId: null }],
  ...over,
});
const factsOf = (run, issue = {}) => ({
  issue: { id: "issue-1", status: "todo", assigneeAgentId: "agent-1", ...issue },
  hold: { cause: CAUSE, runId: "run-1", recoveryActionId: "action-1", agentId: "agent-1" },
  run,
  activeRun: false,
});

test("neverStarted: a dispatch gate's cancellation with nothing that shows it ran", () => {
  assert.equal(neverStarted(factsOf(unstartedRun())), true);
  assert.equal(neverStarted(factsOf(unstartedRun({ errorCode: "issue_disposition_repair_superseded" }))), true, "a suppressed scheduled retry");
  assert.equal(neverStarted(factsOf(unstartedRun({ events: [] }))), true, "no events at all");
  assert.equal(neverStarted(factsOf(unstartedRun({ usageJson: { inputTokens: 0, outputTokens: 0 } }))), true, "zero usage");
  for (const code of ["issue_assignee_changed", "issue_disposition_repair_superseded", "issue_review_participant_changed", "issue_reassigned"]) {
    assert.ok(DISPATCH_GATE_CODES.has(code), code);
  }
  assert.equal(DISPATCH_GATE_CODES.has("execution_reconciliation_required"), false, "the hold's own refusal is Paperclip's to let past");
});

test("neverStarted: anything that shows the run began, or a record that can't tell, says no", () => {
  const no = (what, over, issue) => assert.equal(neverStarted(factsOf(unstartedRun(over), issue)), false, what);
  no("a start time", { startedAt: minutesAgo(61) });
  no("no startedAt field: proves nothing", { startedAt: undefined });
  assert.equal(neverStarted(factsOf((({ startedAt, ...r }) => r)(unstartedRun()))), false, "a record without startedAt");
  no("a process", { processPid: 4242 });
  no("a process group", { processGroupId: 4242 });
  no("a session", { sessionIdAfter: "sess-1" });
  no("a resolved runtime mode", { runtimeModeResolvedAt: minutesAgo(61) });
  no("an execution stage", { executionStage: "provider" });
  no("a controller", { controllerBootId: "boot-1" });
  no("the native runtime", { runtimeMode: "native" });
  no("usage", { usageJson: { inputTokens: 1200, outputTokens: 40 } });
  no("a cost", { usageJson: { costUsd: 0.02 } });
  no("an adapter invoke event", { events: [{ eventType: "adapter.invoke" }] });
  no("a runner's event", { events: [{ eventType: "lifecycle", sourceEventId: "evt-9" }] });
  no("events unread", { events: null });
  no("an environment lease", { environmentLease: { status: "released", releasedAt: minutesAgo(60) } });
  no("a retained workspace", { resultJson: { workspaceRestoreRecovery: { schema: "x" } } });
  no("not a dispatch gate's code", { errorCode: "cancelled" });
  no("a pause's cancellation (18's)", { errorCode: "agent_paused" });
  no("not cancelled", { status: "failed" });
  no("not finished", { finishedAt: null });
  no("another issue's run", { contextSnapshot: { issueId: "issue-2" } });
  no("the detail wasn't read", { detailRead: false });
  assert.equal(neverStarted({ ...factsOf(unstartedRun()), hold: { cause: "other", runId: "run-1" } }), false, "another cause");
});

test("releaseProblems: a pending review stage, another agent's run, or open blockers keep the hold", () => {
  const facts = (issue, hold = {}) => ({ ...factsOf(unstartedRun(), issue), hold: { ...factsOf(unstartedRun()).hold, ...hold } });
  assert.deepEqual(releaseProblems(facts({})), []);
  assert.match(releaseProblems(facts({ status: "in_review", executionState: { status: "pending" } }))[0], /review stage is pending.*by ending the review/);
  assert.match(releaseProblems(facts({ status: "blocked", executionState: { status: "pending" } }))[0], /review stage is pending/, "a held review Paperclip set to blocked");
  assert.deepEqual(releaseProblems(facts({ status: "in_review", executionState: null })), [], "in review with no stage left: nothing to end");
  assert.match(releaseProblems(facts({}, { agentId: "agent-2" }))[0], /another agent's than the assignee's/);
  assert.match(releaseProblems(facts({ status: "blocked", blockedBy: [{ identifier: "ACM-5", status: "in_progress" }, { identifier: "ACM-6", status: "done" }] }))[0], /blocked by ACM-5,/);
  assert.deepEqual(releaseProblems(facts({ status: "blocked", blockedBy: [{ identifier: "ACM-6", status: "done" }] })), []);
});

// ---------------------------------------------------------------- the watchdog

async function env(t, extra = {}, now) {
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1", ...extra }, now });
  t.after(e.close);
  e.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: minutesAgo(600) });
  return { ...e, watchdog: createWatchdog(e.ctx, e.state) };
}

const agent = (db, name, over = {}) => {
  const a = { id: uuid(), companyId: ids.company, name, status: "idle", adapterType: "claude_local", ...over };
  db.agents.push(a);
  return a;
};

// DIR-1230: Richard's scheduled disposition repair, suppressed at its gate because the
// issue had moved on, still holds the issue, with two board messages saved behind it.
function unstartedHold(db, {
  status = "todo", errorCode = "issue_disposition_repair_superseded", saved = 2, finishedMin = 60, executionState = null,
  run: runOver = {}, owner: ownerOver = {}, assignee = null, blockedBy = undefined, events = [],
} = {}) {
  const owner = agent(db, "Richard", ownerOver);
  const runId = uuid();
  const issue = {
    id: uuid(), identifier: "ACM-30", companyId: ids.company, title: "Retry policy", status, assigneeAgentId: (assignee ?? owner).id,
    updatedAt: minutesAgo(30), executionState, ...(blockedBy ? { blockedBy } : {}),
    executionBlocker: {
      recoveryActionId: uuid(), runId, agentId: owner.id, cause: CAUSE, runStatus: "cancelled",
      runError: "Execution was cancelled; its source was not recorded.", canContinue: false, canRetry: false, savedMessageCount: saved,
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated. Inspect the run before sending a new message to request continuation.",
    },
  };
  db.issues.push(issue);
  db.issueRuns[issue.id] = [{ runId, agentId: owner.id, status: "cancelled", errorCode, createdAt: minutesAgo(finishedMin + 1), finishedAt: minutesAgo(finishedMin) }];
  db.heartbeatRuns.push({
    ...unstartedRun({ errorCode, finishedAt: minutesAgo(finishedMin), createdAt: minutesAgo(finishedMin + 1), contextSnapshot: { issueId: issue.id } }),
    id: runId, companyId: ids.company, agentId: owner.id, detailRead: undefined, events: undefined, ...runOver,
  });
  db.runEvents[runId] = events;
  if (saved) {
    db.wakes[issue.id] = [{ kind: "wake_request", agentId: issue.assigneeAgentId, status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) }];
    db.queuedComments[issue.id] = {
      issueId: issue.id, queueId: uuid(), state: "deferred", targetRunId: null, revision: "rev-1", protocol: "legacy",
      entries: Array.from({ length: saved }, (_, i) => ({ comment: { id: uuid(), body: `Board message ${i + 1}` }, position: i })),
      executionWait: { reason: "process_identity_missing", message: "The previous run has no verified stop record. Paperclip cannot start this message yet." },
    };
  }
  return { issue, owner, runId };
}

const notes = (e) => e.db.comments.filter((c) => c.identifier === "ACM-1");
const onIssue = (e, issue) => e.db.comments.filter((c) => c.issueId === issue.id);

test("DIR-1230: a hold behind a run that never started is released as not performed, and the saved messages delivered once", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue, runId } = unstartedHold(e.db);
  await e.watchdog.tick();

  assert.equal(e.db.resolutions.length, 1);
  const { body } = e.db.resolutions[0];
  assert.equal(body.actionId, issue.executionBlocker?.recoveryActionId ?? body.actionId);
  assert.equal(body.outcome, "restored");
  assert.equal(body.sourceIssueStatus, "todo");
  assert.equal(body.executionReconciliation.runId, runId);
  assert.equal(body.executionReconciliation.providerStopped, true);
  assert.equal(body.executionReconciliation.actionOutcome, "not_performed");
  assert.match(body.executionReconciliation.outcomeEvidence, /cancelled by Paperclip's dispatch gate before it started \(issue_disposition_repair_superseded\).*performed no actions/);
  assert.match(body.resolutionNote, /^Released by Paperclip Helper's watchdog: run .* was cancelled before it started/);
  assert.match(body.resolutionNote, /_Paperclip Helper watchdog\._$/);

  assert.equal(issue.executionBlocker, null);
  assert.equal(e.db.interrupts.length, 1, "the saved messages are delivered, once");
  assert.equal(onIssue(e, issue).length, 0, "no comment: the saved messages wake the agent");
  assert.equal(e.watchdog.stats.releases, 1);
  assert.equal(e.watchdog.stats.unstartedHolds, 1);
  const [note] = notes(e);
  assert.match(
    note.body,
    new RegExp(
      `^ACM-30: Paperclip holds every wake on this issue behind Richard's run ${runId.slice(0, 8)}, which its dispatch cancelled before it started ` +
        "\\(issue_disposition_repair_superseded\\), and never releases that hold by itself \\(legacy_execution_requires_reconciliation\\): " +
        "Richard's issue_commented \\(deferred since .*Z\\) won't start\\. The watchdog released it, recording that the run performed nothing, " +
        "and delivered 2 saved messages to Richard\\. Status now todo\\.",
    ),
  );
  assert.equal(e.logs.find((l) => l.msg === "watchdog: a note for the board")?.level, "info", "a note about something done, not a warning");

  // The next scans, a stall window apart: nothing more for that run.
  clock += 4 * 60_000;
  await e.watchdog.tick();
  clock += 4 * 60_000;
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  assert.equal(e.db.interrupts.length, 1);
  assert.equal(notes(e).length, 1);
});

test("held again by the same run after the release: told to the board once, never released twice", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue } = unstartedHold(e.db);
  const hold = { ...issue.executionBlocker };
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  issue.executionBlocker = hold;
  issue.status = "todo";
  for (let i = 0; i < 3; i += 1) {
    clock += 4 * 60_000;
    await e.watchdog.tick();
  }
  assert.equal(e.db.resolutions.length, 1);
  const back = notes(e).filter((n) => /holds the issue behind it again/.test(n.body));
  assert.equal(back.length, 1);
});

test("no saved messages: Paperclip's own continuation gets its time, then one comment if no run started", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue, owner } = unstartedHold(e.db, { saved: 0 });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  assert.equal(e.db.interrupts.length, 0);
  assert.equal(onIssue(e, issue).length, 0, "not at once: Paperclip starts its own continuation from a sweep every 15 s");
  assert.match(notes(e)[0].body, /The watchdog released it, recording that the run performed nothing\. Status now todo\.$/m);
  clock += 20_000;
  await e.watchdog.tick();
  assert.equal(onIssue(e, issue).length, 0, "two sweeps first");
  clock += 40_000;
  await e.watchdog.tick();
  const [comment, ...more] = onIssue(e, issue);
  assert.equal(more.length, 0);
  assert.ok(comment.body.startsWith(`[@Richard](agent://${owner.id}) Paperclip held this issue behind a run of yours it had cancelled before it started`));
  assert.match(comment.body, /That run did nothing, so there is nothing of it to check: please continue this issue\./);
  clock += 10 * 60_000;
  await e.watchdog.tick();
  assert.equal(onIssue(e, issue).length, 1, "once");
});

test("no saved messages and Paperclip's continuation started (seen live on 2026.1023.0): no comment", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue, owner } = unstartedHold(e.db, { saved: 0 });
  await e.watchdog.tick();
  e.db.issueRuns[issue.id].unshift({ runId: uuid(), agentId: owner.id, status: "succeeded", createdAt: new Date(clock + 1200).toISOString(), finishedAt: new Date(clock + 5000).toISOString() });
  clock += 60_000;
  await e.watchdog.tick();
  assert.equal(onIssue(e, issue).length, 0);
  assert.equal([...e.state.nudges.entries()].filter(([k]) => k.startsWith("unstarted-follow-up:")).length, 0, "nothing left to follow up");
});

test("DIR-1294: a pending review stage is never released; the board is told once why and what lifts it", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const implementer = agent(e.db, "Gilfoyle");
  const { issue, runId } = unstartedHold(e.db, {
    status: "in_review", errorCode: "issue_assignee_changed", saved: 1,
    executionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "agent" }, returnAssignee: { type: "agent", agentId: implementer.id } },
  });
  issue.executionState.currentParticipant.agentId = issue.assigneeAgentId;
  const stage = structuredClone(issue.executionState);
  for (let i = 0; i < 3; i += 1) {
    await e.watchdog.tick();
    clock += 4 * 60_000;
  }
  assert.equal(e.db.resolutions, undefined, "no release");
  assert.equal(e.db.interrupts.length, 0);
  assert.deepEqual(issue.executionState, stage, "the review stage is untouched");
  assert.equal(issue.status, "in_review");
  assert.equal(onIssue(e, issue).length, 0);
  const [note, ...more] = notes(e);
  assert.equal(more.length, 0, "told once");
  assert.match(note.body, new RegExp(`^ACM-30: Paperclip holds every wake on this issue behind Richard's run ${runId.slice(0, 8)}, which its dispatch cancelled before it started \\(issue_assignee_changed\\)`));
  assert.match(note.body, /The watchdog won't release it: the issue's review stage is pending, and the release moves it to todo, which Paperclip either refuses or does by ending the review\./);
  assert.match(note.body, /A Paperclip with paperclipai\/paperclip#18838 releases this hold by itself and leaves the review as it is\./);
  assert.match(note.body, /move it to todo yourself, still assigned to Richard, and the watchdog releases the hold on its next scan\.$/m);

  // A person ends the review themselves (Paperclip clears the stage): the next scan releases it.
  issue.status = "todo";
  issue.executionState = null;
  clock += 4 * 60_000;
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  assert.equal(e.db.resolutions[0].body.executionReconciliation.actionOutcome, "not_performed");
  assert.equal(e.db.interrupts.length, 1);
});

test("a held review Paperclip set to blocked keeps its stage too; a suppressed retry's note says Paperclip's fix doesn't cover it", async (t) => {
  const e = await env(t);
  const { issue } = unstartedHold(e.db, { status: "blocked", executionState: { status: "pending", currentStageType: "review" } });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions, undefined);
  assert.equal(issue.executionState.status, "pending");
  assert.match(notes(e)[0].body, /Paperclip's own fix \(paperclipai\/paperclip#18838\) doesn't cover a run with this code\./);
});

test("another agent's run, open blockers, or a run that ended a moment ago: no release", async (t) => {
  const other = await env(t);
  const someoneElse = agent(other.db, "Dinesh");
  unstartedHold(other.db, { assignee: someoneElse });
  await other.watchdog.tick();
  assert.equal(other.db.resolutions, undefined);
  assert.match(notes(other)[0].body, /won't release it: the held run is another agent's than the assignee's/);

  const blocked = await env(t);
  unstartedHold(blocked.db, { status: "blocked", blockedBy: [{ id: uuid(), identifier: "ACM-5", status: "in_progress" }] });
  await blocked.watchdog.tick();
  assert.equal(blocked.db.resolutions, undefined);
  assert.match(notes(blocked)[0].body, /the issue is blocked by ACM-5, and the release moves it to todo\. Once that is out of the way the watchdog releases it on its next scan/);

  const recent = await env(t);
  unstartedHold(recent.db, { finishedMin: 1 });
  await recent.watchdog.tick();
  assert.equal(recent.db.resolutions, undefined, "the run's stall window first");
  assert.equal(notes(recent).length, 0);
});

test("evidence the run began, or events that can't be read: not 22's to release", async (t) => {
  const started = await env(t);
  // A recorded process (gone) keeps 7 away too: Paperclip can check it by itself.
  const { issue } = unstartedHold(started.db, { saved: 0, events: [{ seq: 1, eventType: "adapter.invoke" }], run: { processPid: 999999999 } });
  await started.watchdog.tick();
  assert.equal(started.db.resolutions, undefined);
  assert.ok(issue.executionBlocker);
  assert.equal(started.watchdog.stats.unstartedHolds, 0);

  const unread = await env(t);
  const u = unstartedHold(unread.db, { saved: 0, run: { processPid: 999999999 } });
  unread.fake.fail("GET", `/api/heartbeat-runs/${u.runId}/events`, 500, { times: -1 });
  await unread.watchdog.tick();
  assert.equal(unread.db.resolutions, undefined);
});

test("an assignee that is paused is waited for; with WATCHDOG_RELEASE_HOLDS off or a dry run nothing changes", async (t) => {
  let clock = Date.now();
  const paused = await env(t, {}, () => clock);
  const p = unstartedHold(paused.db, { owner: { status: "paused" } });
  await paused.watchdog.tick();
  assert.equal(paused.db.resolutions, undefined);
  assert.equal(notes(paused).length, 0);
  p.owner.status = "idle";
  clock += 4 * 60_000;
  await paused.watchdog.tick();
  assert.equal(paused.db.resolutions.length, 1, "released once it is back");

  const off = await env(t, { WATCHDOG_RELEASE_HOLDS: "false" });
  unstartedHold(off.db);
  await off.watchdog.tick();
  assert.equal(off.db.resolutions, undefined);
  assert.match(notes(off)[0].body, /`pch release ACM-30 --apply` releases it \(WATCHDOG_RELEASE_HOLDS is off\)\./);

  const dry = await env(t, { DRY_RUN: "true" });
  unstartedHold(dry.db);
  await dry.watchdog.tick();
  await dry.watchdog.tick();
  assert.equal(dry.db.resolutions, undefined);
  assert.equal(dry.logs.filter((l) => l.msg === "watchdog: would release a hold behind a run that never started (dry run)").length, 1);
});

test("a release Paperclip refuses is told to the board once and left", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue } = unstartedHold(e.db);
  e.fake.fail("POST", `/api/issues/${issue.id}/recovery-actions/resolve`, 409, { times: -1 });
  await e.watchdog.tick();
  clock += 4 * 60_000;
  await e.watchdog.tick();
  const refused = notes(e).filter((n) => /couldn't release it/.test(n.body));
  assert.equal(refused.length, 1);
  assert.match(refused[0].body, /see `pch release ACM-30`\./);
  assert.equal(e.watchdog.stats.releases, 0);
  assert.equal(notes(e).filter((n) => /again/.test(n.body)).length, 0, "a refusal is never called 'back'");
});

// DIR-1277: Carla's run worked for 50 minutes and was cancelled without a recorded cancellation.
function executedHold(db, { finishedMin = 120 } = {}) {
  const carla = agent(db, "Carla");
  const runId = uuid();
  const issue = {
    id: uuid(), identifier: "ACM-77", companyId: ids.company, title: "Watcher", status: "blocked", assigneeAgentId: carla.id, updatedAt: minutesAgo(30),
    executionBlocker: { recoveryActionId: uuid(), runId, agentId: carla.id, cause: CAUSE, runStatus: "cancelled", savedMessageCount: 0 },
  };
  db.issues.push(issue);
  db.issueRuns[issue.id] = [{ runId, agentId: carla.id, status: "cancelled", errorCode: "cancelled", createdAt: minutesAgo(finishedMin + 51), startedAt: minutesAgo(finishedMin + 50), finishedAt: minutesAgo(finishedMin) }];
  db.heartbeatRuns.push({
    id: runId, companyId: ids.company, agentId: carla.id, status: "cancelled", errorCode: "cancelled", runtimeMode: "legacy",
    startedAt: minutesAgo(finishedMin + 50), finishedAt: minutesAgo(finishedMin), processPid: 999999999, processGroupId: null,
    usageJson: { inputTokens: 90000, outputTokens: 4000 }, contextSnapshot: { issueId: issue.id },
  });
  return { issue, runId };
}

test("DIR-1277: a hold behind a run that executed is only reported, once, an hour after it ended", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue, runId } = executedHold(e.db);
  for (let i = 0; i < 3; i += 1) {
    await e.watchdog.tick();
    clock += 4 * 60_000;
  }
  assert.equal(e.db.resolutions, undefined);
  assert.equal(onIssue(e, issue).length, 0);
  const [note, ...more] = notes(e);
  assert.equal(more.length, 0);
  assert.equal(
    note.body.split("\n\n")[0],
    `ACM-77: Paperclip holds execution on this issue behind Carla's run ${runId.slice(0, 8)}, which ran for 50 min and ended cancelled (cancelled) ` +
      "without a record of what it did. That is for a person to judge, so the watchdog leaves it: inspect the run and the branch, then " +
      "`pch release ACM-77 --apply` (with `--outcome completed` or `--outcome not_performed` once you know).",
  );

  const soon = await env(t);
  executedHold(soon.db, { finishedMin: 20 });
  await soon.watchdog.tick();
  assert.equal(notes(soon).length, 0, "not within the hour");
});

// ---------------------------------------------------------------- 7 keeps away from reviews too

test("7: a hold Paperclip can't release by itself on an issue in review is reported, not released", async (t) => {
  const e = await env(t);
  const carla = agent(e.db, "Carla");
  const runId = uuid();
  const issue = {
    id: uuid(), identifier: "ACM-52", companyId: ids.company, status: "in_review", assigneeAgentId: carla.id, updatedAt: minutesAgo(30),
    executionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: carla.id } },
    executionBlocker: { recoveryActionId: uuid(), runId, agentId: carla.id, cause: CAUSE },
  };
  e.db.issues.push(issue);
  e.db.issueRuns[issue.id] = [{ runId, agentId: carla.id, status: "failed", errorCode: "adapter_failed", createdAt: minutesAgo(61), finishedAt: minutesAgo(60) }];
  e.db.heartbeatRuns.push({ id: runId, companyId: ids.company, agentId: carla.id, status: "failed", processPid: null, processGroupId: null });
  e.db.wakes[issue.id] = [{ kind: "wake_request", agentId: carla.id, status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) }];
  await e.watchdog.tick();
  await e.watchdog.tick();
  assert.equal(e.db.resolutions, undefined);
  assert.equal(issue.executionState.status, "pending");
  const warn = e.logs.filter((l) => l.msg === "watchdog: a hold Paperclip can't release by itself isn't safe to release yet");
  assert.equal(warn.length, 1);
  assert.match(warn[0].problems.join(" "), /review stage is pending/);
});

// ---------------------------------------------------------------- pch release and pch why

test("pch release: names a run that never started, records not performed, and refuses a pending review with what lifts it", async (t) => {
  const e = await env(t);
  const { issue } = unstartedHold(e.db);
  const shown = (await captureOutput(() => cmd.release(e.ctx, "ACM-30"))).join("\n");
  assert.match(shown, /Paperclip cancelled this run before it started \(issue_disposition_repair_superseded\): no start, process, session, usage, lease or execution event\./);
  assert.match(shown, /--apply records, as the board, that this run has stopped and that what it did is not performed,/);
  assert.match(shown, /The run never started, so the agent has nothing of it to check\./);
  assert.match(shown, /^ {2}pch release ACM-30 --apply$/m);
  assert.equal(e.db.resolutions, undefined);

  const applied = (await captureOutput(() => cmd.release(e.ctx, "ACM-30", { apply: true }))).join("\n");
  assert.match(applied, /ACM-30: hold released \(todo\)\./);
  assert.match(applied, /Delivered 2 saved message\(s\) to Richard\./);
  const { body } = e.db.resolutions[0];
  assert.equal(body.executionReconciliation.actionOutcome, "not_performed");
  assert.match(body.resolutionNote, /_Sent with Paperclip Helper \(`pch`\)\._$/);
  assert.equal(issue.executionBlocker, null);

  const review = await env(t);
  const r = unstartedHold(review.db, { status: "in_review", errorCode: "issue_assignee_changed", executionState: { status: "pending", currentStageType: "review" } });
  await assert.rejects(
    () => captureOutput(() => cmd.release(review.ctx, "ACM-30", { apply: true })),
    /Not releasing: the issue's review stage is pending, and the release moves it to todo, which Paperclip either refuses or does by ending the review\. Nothing changed\. A Paperclip with paperclipai\/paperclip#18838/,
  );
  assert.equal(review.db.resolutions, undefined);
  assert.equal(r.issue.executionState.status, "pending");
});

test("pch release --outcome still overrides; a run that executed keeps 'mixed' by default", async (t) => {
  const e = await env(t);
  unstartedHold(e.db);
  const shown = (await captureOutput(() => cmd.release(e.ctx, "ACM-30", { outcome: "mixed" }))).join("\n");
  assert.match(shown, /what it did is unverified \(mixed\)/);
  assert.match(shown, /pch release ACM-30 --apply --outcome mixed/);

  const ran = await env(t);
  const { issue } = executedHold(ran.db);
  issue.status = "todo";
  ran.db.heartbeatRuns.at(-1).processPid = null;
  await captureOutput(() => cmd.release(ran.ctx, "ACM-77", { apply: true }));
  assert.equal(ran.db.resolutions[0].body.executionReconciliation.actionOutcome, "mixed");
});

test("pch why: the never-started hold, what releases it, and that the watchdog does", async (t) => {
  const e = await env(t);
  unstartedHold(e.db);
  const shown = (await captureOutput(() => cmd.why(e.ctx, "ACM-30"))).join("\n");
  assert.match(shown, /Held run never started: Paperclip's dispatch cancelled Richard's run [0-9a-f]{8} before it began \(issue_disposition_repair_superseded\)\./);
  assert.match(shown, /Comments and status changes are saved behind it; nothing in Paperclip releases it\./);
  assert.match(shown, /pch release ACM-30 --apply {3}\(records that the run performed nothing/);
  assert.match(shown, /The watchdog does this by itself once the run ended a stall window ago/);

  const advice = advise({
    identifier: "ACM-30", issue: { status: "in_review", assigneeAgentId: "agent-1", executionBlocker: { cause: CAUSE } },
    assignee: { name: "Jian-Yang", status: "idle" },
    unstartedHold: { ownerName: "Jian-Yang", runId: "570df7e8-0000", errorCode: "issue_assignee_changed", problems: ["the issue's review stage is pending, and the release moves it to todo, which Paperclip either refuses or does by ending the review"] },
  });
  assert.equal(advice.watchdog, "manual");
  assert.match(advice.what, /It can't be released yet: the issue's review stage is pending/);
  assert.match(advice.steps[0], /paperclipai\/paperclip#18838 releases this hold by itself/);
});

test("7: a run with no process record that did model work (an adapter with no local process) is reported once, not released", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const carla = agent(e.db, "Carla", { adapterType: "http" });
  const runId = uuid();
  const issue = {
    id: uuid(), identifier: "ACM-53", companyId: ids.company, status: "todo", assigneeAgentId: carla.id, updatedAt: minutesAgo(30),
    executionBlocker: { recoveryActionId: uuid(), runId, agentId: carla.id, cause: CAUSE },
  };
  e.db.issues.push(issue);
  e.db.issueRuns[issue.id] = [{ runId, agentId: carla.id, status: "failed", errorCode: "adapter_failed", createdAt: minutesAgo(121), startedAt: minutesAgo(120), finishedAt: minutesAgo(90) }];
  e.db.heartbeatRuns.push({
    id: runId, companyId: ids.company, agentId: carla.id, status: "failed", errorCode: "adapter_failed", startedAt: minutesAgo(120), finishedAt: minutesAgo(90),
    processPid: null, processGroupId: null, usageJson: { inputTokens: 52000, outputTokens: 3100, costUsd: 0.41 }, contextSnapshot: { issueId: issue.id },
  });
  e.db.wakes[issue.id] = [{ kind: "wake_request", agentId: carla.id, status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) }];
  for (let i = 0; i < 3; i += 1) {
    await e.watchdog.tick();
    clock += 4 * 60_000;
  }
  assert.equal(e.db.resolutions, undefined, "not released");
  assert.ok(issue.executionBlocker);
  const [note, ...more] = notes(e);
  assert.equal(more.length, 0, "reported once");
  assert.match(note.body, /^ACM-53: Paperclip holds execution on this issue behind Carla's run [0-9a-f]{8}, which ran for 30 min and ended failed \(adapter_failed\) without a record of what it did\. That is for a person to judge/);

  // The same run without usage is still 7's to release.
  const bare = await env(t);
  const c2 = agent(bare.db, "Carla");
  const r2 = uuid();
  const i2 = { id: uuid(), identifier: "ACM-54", companyId: ids.company, status: "todo", assigneeAgentId: c2.id, updatedAt: minutesAgo(30), executionBlocker: { recoveryActionId: uuid(), runId: r2, agentId: c2.id, cause: CAUSE } };
  bare.db.issues.push(i2);
  bare.db.issueRuns[i2.id] = [{ runId: r2, agentId: c2.id, status: "failed", errorCode: "adapter_failed", createdAt: minutesAgo(61), finishedAt: minutesAgo(60) }];
  bare.db.heartbeatRuns.push({ id: r2, companyId: ids.company, agentId: c2.id, status: "failed", processPid: null, processGroupId: null, usageJson: null });
  await bare.watchdog.tick();
  assert.equal(bare.db.resolutions.length, 1);
  assert.equal(bare.db.resolutions[0].body.executionReconciliation.actionOutcome, "mixed");
});

// ---------------------------------------------------------------- after the release

// DIR-861, DIR-631 (1.15.3): the release went through, then Paperclip promoted the saved
// wakes itself before the helper pressed Interrupt (409 "The queued message is no longer
// pending"), and the watchdog reported a release that had worked as failed.
function stubApi(steps) {
  const calls = [];
  return {
    calls,
    request: async (method, path, body) => {
      calls.push(`${method} ${path}`);
      const step = steps.find((s) => s.method === method && path.endsWith(s.path) && (s.times ?? 1) > 0);
      if (!step) throw new Error(`unexpected ${method} ${path}`);
      step.times = (step.times ?? 1) - 1;
      if (step.error) throw Object.assign(new Error(step.error), { status: step.status });
      return typeof step.reply === "function" ? step.reply(body) : step.reply;
    },
  };
}
const queueOf = (revision, n) => ({ queueId: "q1", state: "deferred", targetRunId: null, revision, protocol: "legacy", entries: Array.from({ length: n }, (_, i) => ({ position: i })) });
const released = (extra) => [
  { method: "POST", path: "/recovery-actions/resolve", reply: { replayed: false } },
  { method: "GET", path: "/api/issues/i1", reply: { id: "i1", status: "todo", executionBlocker: null } },
  ...extra,
];
const heldFacts = () => ({ ...factsOf(unstartedRun()), issue: { id: "i1", status: "todo", assigneeAgentId: "agent-1" } });

test("after a release, saved messages Paperclip started itself are a success, not a failure (409 on Interrupt)", async () => {
  const { releaseHold } = await import("../src/release.mjs");
  const api = stubApi(released([
    { method: "GET", path: "/queued-comments", reply: queueOf("r1", 2) },
    { method: "POST", path: "/queued-comments/interrupt", error: "The queued message is no longer pending", status: 409 },
    { method: "GET", path: "/queued-comments", reply: { queueId: null, state: null, entries: [] } },
  ]));
  const result = await releaseHold(api, heldFacts());
  assert.deepEqual(result, { status: "todo", delivered: 0, waiting: 0, byPaperclip: 2 });

  // A new revision meanwhile: pressed once more with it.
  const again = stubApi(released([
    { method: "GET", path: "/queued-comments", reply: queueOf("r1", 1) },
    { method: "POST", path: "/queued-comments/interrupt", error: "The queued messages changed in another session", status: 409 },
    { method: "GET", path: "/queued-comments", reply: queueOf("r2", 2) },
    { method: "POST", path: "/queued-comments/interrupt", reply: {} },
  ]));
  assert.deepEqual(await releaseHold(again, heldFacts()), { status: "todo", delivered: 2, waiting: 0 });

  // Any other refusal of the press is still an error.
  const refused = stubApi(released([
    { method: "GET", path: "/queued-comments", reply: queueOf("r1", 1) },
    { method: "POST", path: "/queued-comments/interrupt", error: "boom", status: 500 },
  ]));
  await assert.rejects(() => releaseHold(refused, heldFacts()), /boom/);
});

test("a hold 1.15.3 failed to release on a review is told to the board, then tried once more after the review is ended", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue, runId } = unstartedHold(e.db, { status: "in_review", errorCode: "issue_assignee_changed", saved: 1, executionState: { status: "pending", currentStageType: "review" } });
  // What 1.15.3's watchdog 7 recorded on DIR-1294: Paperclip refused its release.
  e.state.nudges.set(`release:${issue.id}:${runId}`, { count: 1, at: clock - 3 * 60 * 60_000, failed: true });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions, undefined);
  assert.equal(notes(e).filter((n) => /won't release it: the issue's review stage is pending/.test(n.body)).length, 1, "the board hears why");

  issue.status = "todo";
  issue.executionState = null;
  clock += 4 * 60_000;
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1, "tried once more, and released");
  assert.equal(e.db.interrupts.length, 1);

  // A retry Paperclip refuses again is the last.
  const twice = await env(t, {}, () => clock);
  const h = unstartedHold(twice.db);
  twice.state.nudges.set(`release:${h.issue.id}:${h.runId}`, { count: 1, at: clock - 3 * 60 * 60_000, failed: true });
  twice.fake.fail("POST", `/api/issues/${h.issue.id}/recovery-actions/resolve`, 409, { times: -1 });
  await twice.watchdog.tick();
  clock += 4 * 60_000;
  await twice.watchdog.tick();
  assert.equal(notes(twice).filter((n) => /couldn't release it/.test(n.body)).length, 1, "one more try, one note");
});
