// Watchdog 22 and release.mjs: holds behind runs Paperclip's dispatch cancelled
// before they started, and reports of holds behind runs that did execute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import * as cmd from "../src/commands.mjs";
import { claimedOnly, DISPATCH_GATE_CODES, endedReviewOf, handOnRoute, handOnText, neverStarted, releaseProblems } from "../src/release.mjs";
import { HAND_ON_CHECK_MS } from "../src/unstarted-holds.mjs";
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

// A disposition repair Paperclip claimed, and the board's reassignment cancelled a few
// seconds later, while it was still preparing.
const claimedRun = (over = {}) => unstartedRun({
  errorCode: "issue_reassigned", startedAt: minutesAgo(61), controllerBootId: "boot-1", controllerLeaseExpiresAt: minutesAgo(60),
  executionStage: "preparing", resultJson: { reassignmentStopRequested: true }, ...over,
});

test("neverStarted: a run claimed and cancelled by a reassignment while still preparing never ran", () => {
  assert.equal(neverStarted(factsOf(claimedRun())), true);
  assert.equal(claimedOnly(claimedRun()), true);
  assert.equal(claimedOnly(unstartedRun()), false);
  assert.equal(neverStarted(factsOf(claimedRun({ executionStage: null }))), true, "no stage left on the record");
  const no = (what, over) => assert.equal(neverStarted(factsOf(claimedRun(over))), false, what);
  no("dispatched to its adapter", { executionStage: "dispatching" });
  no("an adapter invoke event", { events: [{ eventType: "lifecycle" }, { eventType: "adapter.invoke" }] });
  no("a process", { processPid: 4242 });
  no("a process start", { processStartedAt: minutesAgo(61) });
  no("a resolved runtime mode", { runtimeModeResolvedAt: minutesAgo(61) });
  no("a session", { sessionIdAfter: "sess-1" });
  no("usage", { usageJson: { inputTokens: 10 } });
  no("claimed, and cancelled by a dispatch gate's code", { errorCode: "issue_assignee_changed" });
  no("claimed, and cancelled by the board", { errorCode: "cancelled" });
});

test("endedReviewOf: the newest change to a pending stage decides", () => {
  const ended = (from, to = null, extra = {}) => ({ action: "issue.updated", createdAt: minutesAgo(5), details: { changes: { executionState: { from, to } } }, ...extra });
  const stage = { status: "pending", currentParticipant: { type: "agent", agentId: "agent-1" }, returnAssignee: { type: "agent", agentId: "agent-9" } };
  assert.deepEqual(endedReviewOf([ended(stage)], "agent-1"), { returnAssigneeAgentId: "agent-9", endedAt: minutesAgo(5) });
  const monitorOnly = { action: "issue.updated", details: { changes: { executionState: { from: null, to: { status: "idle", monitor: { status: "scheduled" } } } } } };
  assert.equal(endedReviewOf([monitorOnly, ended(stage)], "agent-1").returnAssigneeAgentId, "agent-9", "a monitor's change after it is skipped");
  assert.equal(endedReviewOf([ended(null, stage), ended(stage)], "agent-1"), null, "a stage started again since");
  assert.equal(endedReviewOf([ended(stage)], "agent-2"), null, "another agent's review");
  assert.equal(endedReviewOf([ended({ ...stage, returnAssignee: { type: "user", userId: "u-1" } })], "agent-1"), null, "returning to a person");
  assert.equal(endedReviewOf([ended(stage, { status: "idle", lastDecisionId: "d-1" })], "agent-1"), null, "a decision, not an ending");
  assert.equal(endedReviewOf([{ action: "issue.commented" }], "agent-1"), null);
  assert.equal(endedReviewOf(null, "agent-1"), null);
});

test("handOnRoute: the issue moved to another agent, or the held reviewer's review ended", () => {
  const base = factsOf(unstartedRun());
  assert.deepEqual(handOnRoute({ ...base, issue: { ...base.issue, assigneeAgentId: "agent-2" } }), { kind: "owner-moved", targetAgentId: "agent-2", reassign: true });
  assert.deepEqual(handOnRoute({ ...base, endedReview: { returnAssigneeAgentId: "agent-9" } }), { kind: "review-ended", targetAgentId: "agent-9", reassign: false });
  assert.equal(handOnRoute(base), null, "the run's agent's issue, no review ended: a plain release");
  assert.equal(handOnRoute({ ...base, issue: { ...base.issue, assigneeAgentId: "agent-2", executionState: { status: "pending" } } }), null, "a pending review");
  assert.equal(handOnRoute({ ...base, issue: { ...base.issue, assigneeAgentId: null, assigneeUserId: "u-1" } }), null, "a person's");
  assert.equal(handOnRoute({ ...base, issue: { ...base.issue, assigneeAgentId: "agent-2", status: "done" } }), null);
  const text = handOnText({ route: { kind: "owner-moved" }, holdAgent: { id: "agent-1", name: "Monica" }, target: { id: "agent-2", name: "Carla" }, errorCode: "issue_reassigned" });
  assert.match(text, /^\[@Monica\]\(agent:\/\/agent-1\) Paperclip held this issue .*\(issue_reassigned\).*yours again for a moment\. Please reassign this issue to \[@Carla\]\(agent:\/\/agent-2\) and change nothing else/);
  assert.match(
    handOnText({ route: { kind: "review-ended" }, holdAgent: { id: "agent-1", name: "Monica" }, target: { id: "agent-2", name: "Carla" }, errorCode: "issue_assignee_changed" }),
    /The review that run was for has ended, and the work here is \[@Carla\]\(agent:\/\/agent-2\)'s\./,
  );
});

test("releaseProblems: a pending review stage, another agent's run, or open blockers keep the hold", () => {
  const facts = (issue, hold = {}) => ({ ...factsOf(unstartedRun(), issue), hold: { ...factsOf(unstartedRun()).hold, ...hold } });
  assert.deepEqual(releaseProblems(facts({})), []);
  assert.match(releaseProblems(facts({ status: "in_review", executionState: { status: "pending" } }))[0], /review stage is pending.*by ending the review/);
  assert.match(releaseProblems(facts({ status: "blocked", executionState: { status: "pending" } }))[0], /review stage is pending/, "a held review Paperclip set to blocked");
  assert.deepEqual(releaseProblems(facts({ status: "in_review", executionState: null })), [], "in review with no stage left: nothing to end");
  assert.match(releaseProblems(facts({}, { agentId: "agent-2" }))[0], /another agent's than the assignee's/);
  assert.deepEqual(releaseProblems(facts({}, { agentId: "agent-2" }), { handOn: true }), [], "unless it is handed on");
  assert.match(releaseProblems({ ...facts({}, { agentId: "agent-2" }), activeRun: true }, { handOn: true })[0], /another run on the issue is active/);
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

// Richard's scheduled disposition repair, suppressed at its gate because the
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

test("a hold behind a run that never started is released as not performed, and the saved messages delivered once", async (t) => {
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

test("no saved messages and Paperclip's continuation started (as on 2026.1023.0): no comment", async (t) => {
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

// The reviewer's run, cancelled before it started, holds the issue while the reviewer
// has its review. Paperclip releases such a hold only by moving the issue to todo, and
// refuses that (or ends the review) while the stage is pending. Measured on 2026.1023.0:
// its sweep sets a held review to blocked with the stage kept, a board user's comment
// moves that to todo with the stage kept, the release from todo changes no status, and a
// move back to in_review re-pends the very same stage.
function heldReview(e, { status = "in_review", saved = 1, moreActions = 0 } = {}) {
  const implementer = agent(e.db, "Gilfoyle");
  const h = unstartedHold(e.db, { status, errorCode: "issue_assignee_changed", saved });
  const { issue } = h;
  issue.executionState = {
    status: "pending", currentStageId: "stage-1", currentStageIndex: 0, currentStageType: "review",
    currentParticipant: { type: "agent", agentId: issue.assigneeAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: implementer.id, userId: null },
    reviewRequest: { instructions: "Run the Windows tests" }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    monitor: null, changesRequestedCount: 0,
  };
  issue.executionPolicy = { stages: [{ id: "stage-1", type: "review", participants: [{ type: "agent", agentId: issue.assigneeAgentId }] }] };
  issue.moreHolds = Array.from({ length: moreActions }, () => ({ ...issue.executionBlocker, recoveryActionId: uuid() }));
  return { ...h, implementer, stage: structuredClone(issue.executionState) };
}
const statusPatches = (e, issue) => e.db.patches.filter((p) => p.issueId === issue.id && ("status" in p.body || "assigneeAgentId" in p.body)).map((p) => p.body);

test("a held review at its first stage: the review is started again with the same reviewer and implementer, and the hold released", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue, runId, stage, implementer } = heldReview(e, { moreActions: 1 });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 2, "both of Paperclip's actions for the run");
  for (const { body } of e.db.resolutions) {
    assert.equal(body.sourceIssueStatus, "todo");
    assert.equal(body.executionReconciliation.actionOutcome, "not_performed");
    assert.equal(body.executionReconciliation.runId, runId);
  }
  assert.equal(issue.executionBlocker, null);
  assert.equal(issue.status, "in_review");
  assert.equal(issue.assigneeAgentId, stage.currentParticipant.agentId, "with the reviewer");
  for (const k of ["status", "currentStageId", "currentStageIndex", "currentStageType", "currentParticipant", "returnAssignee", "reviewRequest", "completedStageIds", "changesRequestedCount"]) {
    assert.deepEqual(issue.executionState[k], stage[k], k);
  }
  assert.deepEqual(statusPatches(e, issue), [
    { status: "todo" },
    { status: "backlog", assigneeAgentId: implementer.id },
    { status: "in_review", assigneeAgentId: stage.currentParticipant.agentId, reviewRequest: stage.reviewRequest },
  ]);
  assert.equal(onIssue(e, issue).length, 0, "no comment: the review wakes the reviewer");
  const [note] = notes(e);
  assert.match(note.body, /The watchdog released it, starting its review again at the same first stage with Richard, returning to Gilfoyle \(nothing in it had been completed; the saved messages stay on the issue for Richard's review run\), recording that the run performed nothing/);
  assert.equal(e.watchdog.stats.unstartedHolds, 1);

  clock += 4 * 60_000;
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 2);
  assert.equal(statusPatches(e, issue).length, 3);
});

test("a held review Paperclip already parked in blocked is released at once, whatever stage it is at", async (t) => {
  const e = await env(t);
  const { issue, stage } = heldReview(e, { status: "blocked", saved: 2 });
  issue.executionState.currentStageIndex = 1;
  issue.executionState.completedStageIds = ["stage-0"];
  issue.executionState.changesRequestedCount = 2;
  const later = structuredClone(issue.executionState);
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  assert.equal(issue.status, "in_review");
  assert.deepEqual(issue.executionState, later, "completed stages and the round count kept");
  assert.notDeepEqual(later, stage);
  assert.match(notes(e)[0].body, /without ending the review \(review stage 2 with Richard, returning to Gilfoyle, as it was\)/);
});

test("in review past its first stage, after a round, or after a decision: never started again, told once with what lifts it", async (t) => {
  for (const [what, change] of [
    ["a later stage", (st) => Object.assign(st, { currentStageIndex: 1, completedStageIds: ["stage-0"] })],
    ["a round of changes", (st) => Object.assign(st, { changesRequestedCount: 1 })],
    ["a decision", (st) => Object.assign(st, { lastDecisionId: uuid(), lastDecisionOutcome: "changes_requested" })],
  ]) {
    let clock = Date.now();
    const e = await env(t, {}, () => clock);
    const { issue } = heldReview(e);
    change(issue.executionState);
    const kept = structuredClone(issue.executionState);
    for (let i = 0; i < 3; i += 1) {
      await e.watchdog.tick();
      clock += 4 * 60_000;
    }
    assert.equal(e.db.resolutions, undefined, what);
    assert.deepEqual(issue.executionState, kept, what);
    assert.deepEqual(statusPatches(e, issue), [], what);
    const [note, ...more] = notes(e);
    assert.equal(more.length, 0, what);
    assert.match(note.body, /The watchdog won't release it: the issue's review stage is pending/, what);
    assert.match(note.body, /A Paperclip with paperclipai\/paperclip#18838 releases this hold by itself and leaves the review as it is\./, what);
  }
});

test("a held review needs the helper to comment as a board user; a review that can't be put back is told to the board", async (t) => {
  const agentKey = await env(t);
  agentKey.db.meSource = "agent_key";
  const a = heldReview(agentKey, { status: "blocked" });
  await agentKey.watchdog.tick();
  assert.equal(agentKey.db.resolutions, undefined);
  assert.deepEqual(a.issue.executionState, a.stage);
  assert.match(notes(agentKey)[0].body, /only a board user's comment moves a blocked review to todo with its stage kept, and the helper's Paperclip key isn't a user's/);

  const stuck = await env(t);
  const s = heldReview(stuck, { status: "blocked" });
  stuck.fake.fail("PATCH", `/api/issues/${s.issue.id}`, 500, { times: 2 });
  await stuck.watchdog.tick();
  assert.equal(stuck.db.resolutions.length, 1, "released");
  assert.equal(s.issue.status, "todo", "left in todo with its stage");
  assert.deepEqual(s.issue.executionState, s.stage);
  assert.match(notes(stuck)[0].body, /The watchdog released it, but putting the issue back in review failed \(.*\): move it to in_review, which keeps its stage\./);
});

test("a pending review whose reviewer isn't the held run's agent keeps its stage; a suppressed retry's note says Paperclip's fix doesn't cover it", async (t) => {
  const e = await env(t);
  const { issue } = unstartedHold(e.db, { status: "blocked", executionState: { status: "pending", currentStageType: "review" } });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions, undefined);
  assert.equal(issue.executionState.status, "pending");
  assert.match(notes(e)[0].body, /Paperclip's own fix \(paperclipai\/paperclip#18838\) doesn't cover a run with this code\./);
});

test("another agent has the issue, so the held run's agent gets it a moment and is asked to hand it on", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const carla = agent(e.db, "Carla");
  const { issue, owner, runId } = unstartedHold(e.db, { assignee: carla, status: "blocked", errorCode: "issue_reassigned",
    run: { startedAt: minutesAgo(61), controllerBootId: "boot-1", controllerLeaseExpiresAt: minutesAgo(60), executionStage: "preparing" },
  });
  await e.watchdog.tick();

  const [give] = e.db.patches.filter((p) => p.issueId === issue.id);
  assert.deepEqual(give.body, { assigneeAgentId: owner.id }, "back to the run's agent, nothing else");
  const [ask] = onIssue(e, issue);
  assert.match(ask.body, new RegExp(`^\\[@Richard\\]\\(agent://${owner.id}\\) Paperclip held this issue .*Please reassign this issue to \\[@Carla\\]\\(agent://${carla.id}\\) and change nothing else`));
  assert.match(ask.body, /_Paperclip Helper watchdog\._$/);
  assert.equal(e.db.resolutions.length, 1, "released while the issue is the run's agent's");
  assert.equal(e.db.resolutions[0].body.executionReconciliation.actionOutcome, "not_performed");
  assert.match(e.db.resolutions[0].body.executionReconciliation.outcomeEvidence, /cancelled after Paperclip claimed it, while still preparing, before it was dispatched to its adapter \(issue_reassigned\)/);
  assert.equal(e.db.interrupts.length, 1, "the saved messages start the run's agent now");
  assert.equal(issue.assigneeAgentId, owner.id);
  assert.match(notes(e)[0].body, new RegExp(`behind Richard's run ${runId.slice(0, 8)}, which was cancelled while it was still preparing, before it reached its adapter \\(issue_reassigned\\)`));
  assert.match(notes(e)[0].body, /The watchdog released it, giving the issue back to Richard a moment \(Paperclip releases it only while it is theirs\) and asking them to reassign it to Carla, recording/);

  // He didn't, and nothing of his runs there: the watchdog reassigns it once the check is due.
  e.db.issueRuns[issue.id].push({ runId: uuid(), agentId: owner.id, status: "running", createdAt: new Date(clock).toISOString() });
  clock += HAND_ON_CHECK_MS + 1000;
  await e.watchdog.tick();
  assert.equal(issue.assigneeAgentId, owner.id, "not while a run of his is active");
  e.db.issueRuns[issue.id].at(-1).status = "succeeded";
  clock += 60_000;
  await e.watchdog.tick();
  assert.equal(issue.assigneeAgentId, carla.id);
  const last = e.db.patches.filter((p) => p.issueId === issue.id).at(-1);
  assert.match(last.body.comment, new RegExp(`^\\[@Carla\\]\\(agent://${carla.id}\\) this issue is yours again`));
  assert.match(notes(e).at(-1).body, /Richard didn't give the issue to Carla after the watchdog's release, so the watchdog did/);
  const count = e.db.patches.length;
  clock += HAND_ON_CHECK_MS * 2;
  await e.watchdog.tick();
  assert.equal(e.db.patches.length, count, "once");
});

test("a hand-on that worked is left alone; one with a run active on the issue isn't released, and the note says not to reassign", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const carla = agent(e.db, "Carla");
  const { issue } = unstartedHold(e.db, { assignee: carla });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  issue.assigneeAgentId = carla.id; // his run handed it on
  const count = e.db.patches.length;
  clock += HAND_ON_CHECK_MS + 1000;
  await e.watchdog.tick();
  assert.equal(e.db.patches.length, count);

  const busy = await env(t);
  const dinesh = agent(busy.db, "Dinesh");
  const b = unstartedHold(busy.db, { assignee: dinesh });
  busy.db.issueRuns[b.issue.id].push({ runId: uuid(), agentId: dinesh.id, status: "queued", createdAt: minutesAgo(1) });
  await busy.watchdog.tick();
  assert.equal(busy.db.resolutions, undefined);
  assert.equal(busy.db.patches.filter((p) => p.issueId === b.issue.id).length, 0, "not reassigned");
  assert.match(notes(busy)[0].body, /another run on the issue is active\. Don't reassign the issue while that run is queued or starting/);
});

test("the held reviewer's review was ended by the board's move to todo, so the reviewer is asked to give the issue back to the implementer", async (t) => {
  const e = await env(t);
  const carla = agent(e.db, "Carla");
  const { issue, owner } = unstartedHold(e.db, { errorCode: "issue_assignee_changed" });
  e.db.activity.push({
    action: "issue.updated", entityType: "issue", entityId: issue.id, actorType: "user", createdAt: minutesAgo(10),
    details: { changes: { status: { from: "blocked", to: "todo" }, executionState: {
      from: { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: owner.id }, returnAssignee: { type: "agent", agentId: carla.id } },
      to: null,
    } } },
  });
  await e.watchdog.tick();
  assert.equal(e.db.patches.filter((p) => p.issueId === issue.id && "assigneeAgentId" in p.body).length, 0, "his already: not reassigned");
  assert.match(onIssue(e, issue)[0].body, new RegExp(`The review that run was for has ended, and the work here is \\[@Carla\\]\\(agent://${carla.id}\\)'s\\. Please reassign this issue to \\[@Carla\\]`));
  assert.equal(e.db.resolutions.length, 1);
  assert.match(notes(e)[0].body, /asking Richard to give the issue back to Carla: their review had ended, and the saved messages are Carla's work/);
});

test("pch release: another agent has the issue: the hand-on is shown, then done", async (t) => {
  const e = await setup();
  t.after(e.close);
  const carla = agent(e.db, "Carla");
  const { issue, owner } = unstartedHold(e.db, { assignee: carla });
  let lines = await captureOutput(() => cmd.release(e.ctx, issue.identifier, {}));
  assert.ok(lines.some((l) => /is Carla's now, and Paperclip accepts the release only while it is Richard's\. --apply gives it back to Richard a moment,/.test(l)), lines.join("\n"));
  assert.equal(e.db.resolutions, undefined);
  lines = await captureOutput(() => cmd.release(e.ctx, issue.identifier, { apply: true }));
  assert.ok(lines.some((l) => /hold released, given back to Richard a moment, and Richard asked to reassign it to Carla/.test(l)), lines.join("\n"));
  assert.equal(issue.assigneeAgentId, owner.id);
  assert.match(onIssue(e, issue)[0].body, /_Paperclip Helper\._$|Paperclip Helper/);
});

test("open blockers, or a run that ended a moment ago: no release", async (t) => {
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

// Carla's run worked for 50 minutes and was cancelled without a recorded cancellation.
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

test("a hold behind a run that executed is only reported, once, an hour after it ended", async (t) => {
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
    assignee: { name: "Monica", status: "idle" },
    unstartedHold: { ownerName: "Monica", runId: "1a2b3c4d-0000", errorCode: "issue_assignee_changed", problems: ["the issue's review stage is pending, and the release moves it to todo, which Paperclip either refuses or does by ending the review"] },
  });
  assert.equal(advice.watchdog, "manual");
  assert.match(advice.what, /It can't be released yet: the issue's review stage is pending/);
  assert.match(advice.steps[0], /paperclipai\/paperclip#18838 releases this hold by itself and leaves the review as it is\. .*the watchdog releases the hold and asks Monica to give the issue back to its implementer/);

  // Another agent has it now: pch why shows the hand-on, and the claimed run's wording.
  const moved = await env(t);
  const carla = agent(moved.db, "Carla");
  unstartedHold(moved.db, { assignee: carla, errorCode: "issue_reassigned", run: { startedAt: minutesAgo(61), controllerBootId: "boot-1", executionStage: "preparing" } });
  const why = (await captureOutput(() => cmd.why(moved.ctx, "ACM-30"))).join("\n");
  assert.match(why, /Held run never ran: Richard's run [0-9a-f]{8} was claimed, then cancelled while still preparing, before it reached its adapter \(issue_reassigned\)\./);
  assert.match(why, /It is Carla's now, and Paperclip releases the hold only while it is Richard's: the release gives it back to Richard a moment and asks Richard to reassign it to Carla/);
  assert.match(why, /reassigns it to Carla itself/);
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

// 1.15.3: the release went through, then Paperclip promoted the saved
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
  { method: "GET", path: "/api/issues/i1", reply: { id: "i1", status: "todo", executionBlocker: null }, times: 2 },
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
  // What 1.15.3's watchdog 7 recorded on a held review: Paperclip refused its release.
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

test("pch release and pch why on a held review: kept when parked in blocked, started again when still in review", async (t) => {
  const e = await env(t);
  const { issue, stage } = heldReview(e, { status: "blocked" });
  const shown = (await captureOutput(() => cmd.release(e.ctx, "ACM-30"))).join("\n");
  assert.match(shown, /ACM-30 is in a review \(review stage 1\) that Paperclip keeps while it holds the issue\./);
  assert.match(shown, /--apply comments, as you, asking the reviewer to carry on \(which moves it to todo with the review kept\), then records/);
  const why = (await captureOutput(() => cmd.why(e.ctx, "ACM-30"))).join("\n");
  assert.match(why, /The review is kept: Paperclip parked it with its stage pending\./);
  assert.match(why, /puts the issue back in review with the same stage, reviewer and return assignee/);
  const applied = (await captureOutput(() => cmd.release(e.ctx, "ACM-30", { apply: true }))).join("\n");
  assert.match(applied, /ACM-30: hold released, review kept \(in_review\)\./);
  assert.deepEqual(issue.executionState, stage);
  assert.match(onIssue(e, issue)[0].body, /_Sent with Paperclip Helper \(`pch`\)\._$/);

  const inReview = await env(t);
  const r = heldReview(inReview);
  const preview = (await captureOutput(() => cmd.release(inReview.ctx, "ACM-30"))).join("\n");
  assert.match(preview, /ACM-30 is in review, at its first stage with nothing in it completed\. Paperclip releases a hold there only by ending the review,/);
  assert.match(preview, /returning to the same implementer, with the review request passed back\./);
  assert.deepEqual(r.issue.executionState, r.stage, "a preview changes nothing");
  const why2 = (await captureOutput(() => cmd.why(inReview.ctx, "ACM-30"))).join("\n");
  assert.match(why2, /so the release starts the same first stage again, with the same reviewer and implementer/);
  const done = (await captureOutput(() => cmd.release(inReview.ctx, "ACM-30", { apply: true }))).join("\n");
  assert.match(done, /ACM-30: hold released, review started again at its first stage with Richard \(in_review\)\./);
  assert.equal(r.issue.executionState.currentStageId, "stage-1");
  assert.equal(r.issue.executionState.returnAssignee.agentId, r.implementer.id);
});

test("a rebuild whose release Paperclip refuses puts the review back and tells the board; a reviewer reviewing his own work gets no rebuild", async (t) => {
  const e = await env(t);
  const { issue, stage, implementer } = heldReview(e);
  e.fake.fail("POST", `/api/issues/${issue.id}/recovery-actions/resolve`, 409, { times: -1 });
  await e.watchdog.tick();
  assert.equal(issue.status, "in_review", "back in review");
  assert.equal(issue.executionState.currentStageId, stage.currentStageId);
  assert.equal(issue.executionState.returnAssignee.agentId, implementer.id);
  assert.equal(issue.executionState.currentParticipant.agentId, stage.currentParticipant.agentId);
  assert.ok(issue.executionBlocker, "still held");
  assert.match(notes(e)[0].body, /The watchdog couldn't release it \(.*409.*\); see `pch release ACM-30`\./);

  const own = await env(t);
  const o = heldReview(own);
  o.issue.executionState.returnAssignee = { type: "agent", agentId: o.issue.assigneeAgentId, userId: null };
  await own.watchdog.tick();
  assert.equal(own.db.resolutions, undefined);
  assert.deepEqual(statusPatches(own, o.issue), []);
  assert.match(notes(own)[0].body, /won't release it: the issue's review stage is pending/);
});

test("a rebuilt review gets back the monitor Paperclip cleared on the way (the CI backstop's, say)", async (t) => {
  const e = await env(t);
  const { issue } = heldReview(e);
  const nextCheckAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
  issue.executionPolicy.monitor = { nextCheckAt, scheduledBy: "board", notes: "CI backstop", kind: "external_service", serviceName: "GitHub Actions" };
  await e.watchdog.tick();
  assert.equal(issue.executionBlocker, null);
  assert.equal(issue.status, "in_review");
  assert.equal(issue.executionPolicy?.monitor?.nextCheckAt, nextCheckAt, "the same check, put back");
  assert.equal(issue.executionPolicy.monitor.notes, "CI backstop");
  assert.ok(issue.executionPolicy.stages?.length, "the stages kept with it");
  assert.match(notes(e)[0].body, /Its monitor, cleared by Paperclip on the way, is set again\. Status now in_review\./);
});
