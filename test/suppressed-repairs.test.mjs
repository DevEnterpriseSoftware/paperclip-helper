// Watchdog 22 and release.mjs: holds behind a disposition repair Paperclip suppressed
// itself (the issue already had a durable path), with its own recovery action for the
// run already resolved, so nothing clears the hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import * as cmd from "../src/commands.mjs";
import { defaultOutcome, neverStarted, repairRanMs, suppressedRepair, SUPPRESSED_REPAIR_MAX_RUN_MS } from "../src/release.mjs";
import { unstartedHoldRemedy, unstartedHoldWhy } from "../src/unstarted-holds.mjs";
import { advise } from "../src/advice.mjs";

const CAUSE = "legacy_execution_requires_reconciliation";
const DURABLE_WAIT = "Execution stopped without a recorded cancellation request: Disposition repair suppressed: durable_wait";
const SCHEDULED = "Scheduled disposition repair suppressed because the source state changed or gained a durable path";
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ---------------------------------------------------------------- the classifier

// A repair Paperclip claimed, prepared and cut off at dispatch about 2.6 s later, as
// GET /api/heartbeat-runs/:id has it.
const repairRun = (over = {}) => ({
  id: "run-1", status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", error: DURABLE_WAIT, runtimeMode: "legacy",
  createdAt: at(20 * 60_000 + 3000), startedAt: at(20 * 60_000 + 2600), finishedAt: at(20 * 60_000),
  processPid: null, processGroupId: null, usageJson: null, contextSnapshot: { issueId: "issue-1", wakeReason: "issue_disposition_repair" },
  detailRead: true, ...over,
});
// Paperclip's own action for the run, settled by its sweep.
const settledAction = (over = {}) => ({
  id: "action-1", kind: "active_run_watchdog", status: "resolved",
  evidence: { originalFailureCode: "legacy_disposition_repair_suppressed", automaticRecovery: { policy: "preserve_without_replay_v1" } }, ...over,
});
const factsOf = (run, { issue = {}, hold = {}, recovery = { active: null, action: settledAction() } } = {}) => ({
  issue: { id: "issue-1", status: "blocked", assigneeAgentId: "agent-1", ...issue },
  hold: { cause: CAUSE, runId: "run-1", recoveryActionId: "action-1", agentId: "agent-1", canRetry: false, canContinue: false, ...hold },
  run,
  recovery,
  activeRun: false,
});

test("suppressedRepair: a disposition repair Paperclip suppressed, that did nothing, with its own recovery over", () => {
  assert.equal(suppressedRepair(factsOf(repairRun())), true, "claimed, cut off within seconds");
  assert.equal(neverStarted(factsOf(repairRun())), false, "not a never-started run: it has a start time and no gate code");
  assert.equal(suppressedRepair(factsOf(repairRun({ startedAt: null, errorCode: null, error: SCHEDULED }))), true, "suppressed at its scheduled-retry gate, never started");
  assert.equal(suppressedRepair(factsOf(repairRun({ errorCode: null, error: null }))), true, "the action's originalFailureCode is evidence enough");
  assert.equal(suppressedRepair(factsOf(repairRun({ errorCode: "issue_disposition_repair_superseded", error: null }))), true, "the gate's code with no error text");
  assert.equal(suppressedRepair(factsOf(repairRun(), { recovery: { active: null, action: null } })), true, "the action no longer listed");
  assert.equal(suppressedRepair(factsOf(repairRun({ usageJson: { inputTokens: 0, outputTokens: 0 } }))), true, "zero usage");
  assert.equal(suppressedRepair(factsOf(repairRun({ processPid: 4242 }))), true, "a process record: the release still checks it is gone");
  assert.equal(defaultOutcome(factsOf(repairRun())), "not_performed");
});

test("suppressedRepair: anything that shows work, another kind of run, or Paperclip still on it says no", () => {
  const no = (what, run, opts) => assert.equal(suppressedRepair(factsOf(repairRun(run), opts)), false, what);
  no("output tokens", { usageJson: { inputTokens: 900, outputTokens: 40 } });
  no("a cost", { usageJson: { costUsd: 0.01 } });
  no("ran longer than the limit", { startedAt: at(20 * 60_000 + SUPPRESSED_REPAIR_MAX_RUN_MS) });
  no("a 50-minute run", { startedAt: at(70 * 60_000) });
  no("no startedAt field: can't tell how long it ran", { startedAt: undefined });
  assert.equal(suppressedRepair(factsOf((({ startedAt, ...r }) => r)(repairRun()))), false, "a record without startedAt");
  no("another wake reason", { contextSnapshot: { issueId: "issue-1", wakeReason: "issue_commented" } });
  no("no wake reason", { contextSnapshot: { issueId: "issue-1" } });
  no("another error, no suppression evidence", { errorCode: "cancelled", error: "Cancelled by the board" }, { recovery: { active: null, action: settledAction({ evidence: {} }) } });
  no("not cancelled", { status: "failed" });
  no("not finished", { finishedAt: null });
  no("another issue's run", { contextSnapshot: { issueId: "issue-2", wakeReason: "issue_disposition_repair" } });
  no("the detail wasn't read", { detailRead: false });
  no("Paperclip's recovery still active", {}, { recovery: { active: { id: "action-2", status: "active" }, action: settledAction() } });
  no("the named action not settled", {}, { recovery: { active: null, action: settledAction({ status: "pending" }) } });
  no("the recovery actions couldn't be read", {}, { recovery: null });
  no("Paperclip offers a retry", {}, { hold: { canRetry: true } });
  no("another cause", {}, { hold: { cause: "other" } });
  assert.equal(repairRanMs(repairRun({ startedAt: null })), 0);
  assert.equal(Math.round(repairRanMs(repairRun()) / 100), 26);
});

test("the wording: why it is held, and what lifts it when the watchdog won't", () => {
  const why = unstartedHoldWhy({ ownerName: "Carla", runId: "1a2b3c4d-0000", suppressed: { error: DURABLE_WAIT, ran: "ran 2.6 s" } });
  assert.match(why, /^Paperclip holds every wake on this issue behind Carla's run 1a2b3c4d, a disposition repair it suppressed itself \(".*durable_wait"; it ran 2\.6 s, with no usage\)/);
  const suppressed = { error: SCHEDULED, ran: "never started" };
  assert.match(unstartedHoldRemedy({ problems: ["the issue's review stage is pending, …"], identifier: "ACM-1", suppressed }), /leaves a held review to you/);
  assert.match(unstartedHoldRemedy({ problems: ["the held run is another agent's than the assignee's, …"], identifier: "ACM-1", ownerName: "Carla", suppressed }), /only while Carla has the issue/);
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

// Carla's disposition repair, suppressed by Paperclip because the issue already had a
// durable path, holds the blocked issue. Paperclip's own action for the run is resolved,
// yet executionBlocker still names it.
function suppressedHold(db, { endedMin = 20, run: runOver = {}, action: actionOver = {}, assignee = null, status = "blocked", active = null, saved = 0 } = {}) {
  const owner = agent(db, "Carla");
  const runId = uuid();
  const actionId = uuid();
  const finished = Date.now() - endedMin * 60_000;
  const issue = {
    id: uuid(), identifier: "ACM-40", companyId: ids.company, title: "Sync retries", status, assigneeAgentId: (assignee ?? owner).id,
    updatedAt: minutesAgo(endedMin),
    executionBlocker: {
      recoveryActionId: actionId, runId, agentId: owner.id, cause: CAUSE, runStatus: "cancelled",
      runError: "Execution was cancelled; its source was not recorded.", canContinue: false, canRetry: false, savedMessageCount: saved,
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated. Inspect the run before sending a new message to request continuation.",
    },
  };
  db.issues.push(issue);
  const run = {
    id: runId, companyId: ids.company, agentId: owner.id, status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", error: DURABLE_WAIT,
    runtimeMode: "legacy", createdAt: new Date(finished - 3000).toISOString(), startedAt: new Date(finished - 2632).toISOString(), finishedAt: new Date(finished).toISOString(),
    processPid: null, processGroupId: null, usageJson: null, resultJson: null,
    contextSnapshot: { issueId: issue.id, wakeReason: "issue_disposition_repair" }, execution: { phase: "recovery_needed", permittedActions: ["inspect_run"] },
    ...runOver,
  };
  db.heartbeatRuns.push(run);
  db.issueRuns[issue.id] = [{ runId, agentId: owner.id, status: "cancelled", errorCode: run.errorCode, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt }];
  db.runEvents[runId] = [{ seq: 1, eventType: "lifecycle" }, { seq: 2, eventType: "adapter.invoke" }];
  db.recoveryActions[issue.id] = active;
  db.recoveryActionHistory[issue.id] = [{
    id: actionId, kind: "active_run_watchdog", status: "resolved", sourceRunId: runId,
    evidence: { originalFailureCode: "legacy_disposition_repair_suppressed", automaticRecovery: { policy: "preserve_without_replay_v1" } }, ...actionOver,
  }];
  if (saved) {
    db.queuedComments[issue.id] = {
      issueId: issue.id, queueId: uuid(), state: "deferred", targetRunId: null, revision: "rev-1", protocol: "legacy",
      entries: Array.from({ length: saved }, (_, i) => ({ comment: { id: uuid(), body: `Board message ${i + 1}` }, position: i })),
    };
  }
  return { issue, owner, run, actionId };
}

const notes = (e) => e.db.comments.filter((c) => c.identifier === "ACM-1");

test("a hold behind a suppressed repair is released once, as not performed, with the evidence", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  // It got as far as a process, long gone: 7 leaves a run with a process record, so before 1.19 nothing released this.
  const { issue, run, actionId } = suppressedHold(e.db, { run: { processPid: 2147483646 } });
  await e.watchdog.tick();

  assert.equal(e.db.resolutions.length, 1);
  const { body } = e.db.resolutions[0];
  assert.equal(body.actionId, actionId, "the already-resolved action the hold names: Paperclip accepts it");
  assert.equal(body.outcome, "restored");
  assert.equal(body.sourceIssueStatus, "todo");
  assert.equal(body.executionReconciliation.runId, run.id);
  assert.equal(body.executionReconciliation.providerStopped, true);
  assert.equal(body.executionReconciliation.actionOutcome, "not_performed");
  const evidence = body.executionReconciliation.outcomeEvidence;
  assert.match(evidence, /was a disposition repair \(issue_disposition_repair\) that Paperclip suppressed itself: ".*durable_wait"/);
  assert.ok(evidence.includes(`started ${run.startedAt} and finished ${run.finishedAt} (2.6 s)`), evidence);
  assert.match(evidence, /recorded no usage or output tokens, so it performed no actions\.$/);
  assert.match(body.resolutionNote, /^Released by Paperclip Helper's watchdog: run .* was a disposition repair Paperclip suppressed itself/);
  assert.match(body.resolutionNote, /_Paperclip Helper watchdog\._$/);

  assert.equal(issue.executionBlocker, null);
  assert.equal(issue.status, "todo");
  assert.equal(e.watchdog.stats.releases, 1);
  assert.equal(e.watchdog.stats.suppressedRepairs, 1);
  assert.equal(e.watchdog.stats.unstartedHolds, 0, "counted apart from runs that never started");
  const [note] = notes(e);
  assert.match(note.body, /^ACM-40: Paperclip holds every wake on this issue behind Carla's run .{8}, a disposition repair it suppressed itself \(".*durable_wait"; it ran 2\.6 s, with no usage\)/);
  assert.match(note.body, /The watchdog released it, recording that the run performed nothing\. Status now todo\./);

  // Held again behind the same run: never released twice.
  issue.executionBlocker = { recoveryActionId: actionId, runId: run.id, agentId: issue.assigneeAgentId, cause: CAUSE, canRetry: false };
  issue.status = "blocked";
  for (let i = 0; i < 3; i += 1) {
    clock += 4 * 60_000;
    await e.watchdog.tick();
  }
  assert.equal(e.db.resolutions.length, 1);
});

test("a suppressed repair that never started (its scheduled-retry gate) is released the same way", async (t) => {
  const e = await env(t);
  const { issue } = suppressedHold(e.db, { run: { startedAt: null, errorCode: null, error: SCHEDULED }, saved: 1 });
  e.db.runEvents[issue.executionBlocker.runId] = null; // unreadable events: not provably never started, still a suppressed repair
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
  assert.match(e.db.resolutions[0].body.executionReconciliation.outcomeEvidence, /never started, finished .*recorded no usage/);
  assert.equal(e.db.interrupts.length, 1, "the saved message is delivered");
  assert.equal(issue.executionBlocker, null);
});

test("Paperclip's own recovery goes first: nothing for 10 minutes", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const { issue } = suppressedHold(e.db, { endedMin: 5 });
  await e.watchdog.tick();
  assert.equal(e.db.resolutions?.length ?? 0, 0);
  assert.ok(issue.executionBlocker);
  clock += 6 * 60_000;
  await e.watchdog.tick();
  assert.equal(e.db.resolutions.length, 1);
});

test("a hold behind a run that did work, ran long, or isn't a suppressed repair is left alone", async (t) => {
  // A process record (long gone): 7's release of a run with no process record isn't what is tested here.
  const pid = { processPid: 2147483646 };
  const cases = [
    ["output tokens", { run: { ...pid, usageJson: { inputTokens: 1200, outputTokens: 80 } } }],
    ["a 50-minute run", { run: { ...pid, startedAt: minutesAgo(70) } }],
    ["another wake reason", { run: { ...pid, contextSnapshot: { wakeReason: "issue_commented" }, errorCode: "cancelled", error: "Cancelled" }, action: { evidence: {} } }],
    ["Paperclip's recovery still active", { run: pid, active: { id: "action-x", status: "active", kind: "active_run_watchdog" } }],
  ];
  for (const [what, opts] of cases) {
    const e = await env(t);
    const { issue } = suppressedHold(e.db, opts);
    if (opts.run?.contextSnapshot) e.db.heartbeatRuns.at(-1).contextSnapshot = { issueId: issue.id, ...opts.run.contextSnapshot };
    await e.watchdog.tick();
    assert.equal(e.db.resolutions?.length ?? 0, 0, what);
    assert.ok(issue.executionBlocker, what);
  }
});

test("the held run isn't the assignee's: told to the board once, not released", async (t) => {
  let clock = Date.now();
  const e = await env(t, {}, () => clock);
  const other = agent(e.db, "Gilfoyle");
  const { issue } = suppressedHold(e.db, { assignee: other });
  await e.watchdog.tick();
  clock += 4 * 60_000;
  await e.watchdog.tick();
  assert.equal(e.db.resolutions?.length ?? 0, 0);
  const told = notes(e).filter((n) => /The watchdog won't release it/.test(n.body));
  assert.equal(told.length, 1);
  assert.match(told[0].body, /another agent's than the assignee's.*only while Carla has the issue/);
  assert.ok(issue.executionBlocker);
});

test("WATCHDOG_RELEASE_HOLDS off: told, not released", async (t) => {
  const e = await env(t, { WATCHDOG_RELEASE_HOLDS: "false" });
  suppressedHold(e.db);
  await e.watchdog.tick();
  assert.equal(e.db.resolutions?.length ?? 0, 0);
  assert.match(notes(e)[0]?.body ?? "", /pch release ACM-40 --apply` releases it \(WATCHDOG_RELEASE_HOLDS is off\)/);
});

test("pch release and pch why say it is a suppressed repair, and --apply records not performed", async (t) => {
  const e = await env(t);
  const { issue } = suppressedHold(e.db);
  const shown = (await captureOutput(() => cmd.release(e.ctx, "ACM-40"))).join("\n");
  assert.match(shown, /This run was a disposition repair Paperclip suppressed itself \(".*durable_wait"\): it ran 2\.6 s, with no usage,/);
  assert.match(shown, /what it did is not performed/);
  assert.match(shown, /The run did no work, so the agent has nothing of it to check\./);
  assert.doesNotMatch(shown, /--outcome/, "not_performed is the default here");

  const why = (await captureOutput(() => cmd.why(e.ctx, "ACM-40"))).join("\n");
  assert.match(why, /Held run was a suppressed disposition repair: Paperclip suppressed Carla's run .{8} itself/);
  assert.match(why, /once the hold has stood 10 minutes/);

  await captureOutput(() => cmd.release(e.ctx, "ACM-40", { apply: true }));
  assert.equal(e.db.resolutions.length, 1);
  assert.equal(e.db.resolutions[0].body.executionReconciliation.actionOutcome, "not_performed");
  assert.equal(issue.executionBlocker, null);
});

test("advice for a suppressed repair with a problem names it", () => {
  const advice = advise({
    identifier: "ACM-40",
    issue: { status: "blocked", assigneeAgentId: "agent-1", executionBlocker: { cause: CAUSE, runId: "run-1", recoveryActionId: "action-1" } },
    assignee: { name: "Carla", status: "idle" },
    unstartedHold: { ownerName: "Carla", runId: "run-1", problems: ["another run on the issue is active"], suppressed: { error: DURABLE_WAIT, ran: "ran 2.6 s" } },
  });
  const text = JSON.stringify(advice);
  assert.match(text, /a disposition repair it suppressed itself/);
  assert.match(text, /another run on the issue is active/);
});
