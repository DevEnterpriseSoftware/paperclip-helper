import { test } from "node:test";
import assert from "node:assert/strict";
import { advise, llmPrompt } from "../src/advice.mjs";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";

const A = "agent-a";
const B = "agent-b";
const base = (extra = {}) => ({
  identifier: "ACM-1",
  issue: { status: "in_progress", assigneeAgentId: A },
  me: "u-me",
  assignee: { name: "Carla", status: "idle" },
  nameOf: (id) => ({ [A]: "Carla", [B]: "Hoover" })[id] ?? null,
  blockers: { readiness: { allBlockersDone: true }, blockers: [] },
  wakes: [],
  runs: [],
  config: { watchdog: true, watchdogRetryDeferred: true, watchdogHealFailedFinalize: true },
  ...extra,
});
const run = (agentId, status, min, extra = {}) => ({ runId: `r-${agentId}-${min}`, agentId, status, createdAt: minutesAgo(min), finishedAt: minutesAgo(min), ...extra });

test("advice: a paused assignee, a running run and a long-queued run", () => {
  const paused = advise(base({ assignee: { name: "Carla", status: "paused" } }));
  assert.match(paused.what, /Carla is paused/);
  assert.equal(paused.watchdog, "manual");

  const running = advise(base({ runs: [run(A, "running", 4)] }));
  assert.match(running.what, /working on it now/);
  assert.deepEqual(running.steps, []);

  const queued = advise(base({ runs: [run(A, "queued", 55)] }));
  assert.match(queued.what, /queued for 55 min without starting/);
  assert.match(queued.steps[1], /Interrupt/);
});

test("advice: a decision waiting on you", () => {
  const a = advise(base({ issue: { status: "in_review", assigneeAgentId: A, executionState: { status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: "u-me" } } } }));
  assert.match(a.what, /approval is waiting on you/);
  assert.match(a.steps[1], /pch approve ACM-1/);
});

test("advice: parked by recovery, with and without a kind the watchdog handles", () => {
  const stranded = advise(base({ issue: { status: "blocked", assigneeAgentId: A }, recovery: { kind: "stranded_assigned_issue", ownerType: "board" } }));
  assert.match(stranded.what, /parked this issue for a board decision/);
  assert.equal(stranded.steps[0], 'pch comment ACM-1 "Carla, please continue this issue."');
  assert.equal(stranded.watchdog, "auto");

  const review = advise(base({ issue: { status: "blocked", assigneeAgentId: A }, recovery: { kind: "stalled_review", ownerType: "board", nextAction: "Inspect the evidence" } }));
  assert.match(review.what, /stalled_review/);
  assert.equal(review.steps[0], "Paperclip's own next action: Inspect the evidence");
  assert.equal(review.watchdog, "manual");
});

test("advice: blocked issues — open blocker, done blockers, an agent's own note, and a loop", () => {
  const blocked = { status: "blocked", assigneeAgentId: A };
  const open = advise(base({ issue: blocked, blockers: { blockers: [{ identifier: "ACM-2", status: "in_progress" }] } }));
  assert.match(open.what, /waiting on ACM-2 \(in_progress\)/);
  assert.deepEqual(open.steps.slice(0, 1), ["pch why ACM-2"]);
  assert.match(open.steps.at(-1), /^pch blocked/);

  const done = advise(base({ issue: blocked, blockers: { blockers: [{ identifier: "ACM-2", status: "done" }] } }));
  assert.match(done.what, /Every blocker is done/);
  assert.equal(done.watchdog, "auto");

  const note = advise(base({ issue: blocked, runs: [run(A, "succeeded", 600)], lastComment: { body: "Blocked: approval eb404903 still pending." } }));
  assert.match(note.what, /blocked this issue with a note of its own/);
  assert.match(note.what, /approval eb404903/);
  assert.equal(note.watchdog, "manual");

  const loop = advise(base({ issue: blocked, runs: [run(A, "succeeded", 5), run(A, "succeeded", 12), run(A, "succeeded", 19), run(A, "succeeded", 26)] }));
  assert.match(loop.what, /has run 4 times in the last 45 min/);
  assert.match(loop.steps[1], /pause the issue/);
});

test("advice: a dropped hand-off, refused runs, a failed run and a finished one", () => {
  const dropped = advise(base({ runs: [run(B, "cancelled", 30, { errorCode: "issue_reassigned" })] }));
  assert.match(dropped.what, /handed from Hoover to Carla 30 min ago, and Carla never started/);
  assert.equal(dropped.watchdog, "auto");

  const refused = advise(base({ runs: [run(A, "cancelled", 10, { errorCode: "execution_reconciliation_required" }), run(B, "cancelled", 30, { errorCode: "issue_reassigned" })] }));
  assert.match(refused.what, /refused Carla's runs/);

  const failed = advise(base({ runs: [run(A, "failed", 20, { errorCode: "adapter_error" })] }));
  assert.match(failed.what, /last run failed \(adapter_error\) 20 min ago/);

  const finished = advise(base({ runs: [run(A, "succeeded", 20)], lastComment: { body: "Waiting for the fixture file." } }));
  assert.match(finished.what, /finished 20 min ago and left the issue in_progress/);
  assert.match(finished.what, /Waiting for the fixture file/);
});

test("pch why ends with a recommendation, and --prompt wraps it for an LLM", async (t) => {
  const env = await setup();
  t.after(env.close);
  const agent = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
  env.db.agents.push(agent);
  const issue = { id: uuid(), identifier: "ACM-109", companyId: ids.company, status: "blocked", assigneeAgentId: agent.id, title: "User detection" };
  env.db.issues.push(issue);
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: agent.id, status: "succeeded", createdAt: minutesAgo(3000) }];
  env.db.blockerDiagnostics[issue.id] = { readiness: { allBlockersDone: true, isDependencyReady: true }, blockers: [] };
  env.db.recoveryActions[issue.id] = { id: uuid(), kind: "stranded_assigned_issue", ownerType: "board", createdAt: minutesAgo(180), nextAction: "Board operator: inspect the evidence." };
  env.db.comments.push({ issueId: issue.id, body: "DIR-111 is done, but its workspace clean-up failed.", authorUserId: ids.user });

  const lines = (await captureOutput(() => cmd.why(env.ctx, "ACM-109"))).join("\n");
  assert.match(lines, /^ACM-109: blocked — User detection/);
  assert.match(lines, /Recovery: stranded_assigned_issue, waiting on board/);
  assert.match(lines, /Last comment: you: DIR-111 is done/);
  assert.match(lines, /Recommendation: Paperclip's recovery parked this issue for a board decision/);
  assert.match(lines, /1\. pch comment ACM-109 "Gilfoyle, please continue this issue\."/);
  assert.match(lines, /The watchdog does this by itself/);

  const prompt = (await captureOutput(() => cmd.why(env.ctx, "ACM-109", { prompt: true }))).join("\n");
  assert.match(prompt, /^I run a self-hosted Paperclip/);
  assert.match(prompt, /## pch why\nACM-109: blocked/);
  assert.match(prompt, /## Helper's recommendation\nPaperclip's recovery parked/);
  assert.match(prompt, /## Latest comments \(newest first\)\n- you: DIR-111 is done/);
  assert.doesNotMatch(prompt, /^Recommendation:/m);
});

test("llmPrompt copes with no comments", () => {
  const p = llmPrompt({ identifier: "ACM-1", report: "ACM-1: todo", advice: { what: "Nothing here looks stuck.", steps: [] } });
  assert.match(p, /\(none read\)/);
});

test("advice: a hold whose run can't prove it stopped points at pch release", () => {
  const hold = { recoveryActionId: "ra-1", runId: "r-1", cause: "legacy_execution_requires_reconciliation", nextAction: "Automatic recovery stopped." };
  const a = advise(base({
    issue: { status: "todo", assigneeAgentId: A, executionBlocker: hold },
    queue: { queueId: "q", state: "deferred", entries: [{}], executionWait: { reason: "process_identity_missing" } },
  }));
  assert.match(a.what, /can't release it/);
  assert.ok(a.steps.some((s) => s.startsWith("pch release ACM-1 --apply")));
  assert.equal(a.watchdog, "auto", "the watchdog releases it by itself");
  const off = advise(base({
    issue: { status: "todo", assigneeAgentId: A, executionBlocker: hold },
    config: { watchdog: true, watchdogReleaseHolds: false },
  }));
  assert.equal(off.watchdog, "manual");

  const other = advise(base({ issue: { status: "todo", assigneeAgentId: A, executionBlocker: { cause: "execution_owner_active" } } }));
  assert.match(other.steps.join("\n"), /press Interrupt/);
});

// ---------------------------------------------------------------- rules for the fixes since 1.8

test("advice: an agent the watchdog paused at a usage limit waits for the reset; one you paused gets the resume sweep", () => {
  const limited = advise(base({
    assignee: { name: "Carla", status: "paused" },
    limitPause: { label: "Codex", what: "usage limit", resetAt: "Mon 12 Oct, 15:45 (Europe/London)", resumeAt: "Mon 12 Oct, 15:50 (Europe/London)" },
  }));
  assert.match(limited.what, /^The watchdog paused Carla because its Codex usage limit was reached; it resets Mon 12 Oct, 15:45 \(Europe\/London\)\. It resumes Carla at Mon 12 Oct, 15:50/);
  assert.equal(limited.watchdog, "auto");

  const yours = advise(base({ assignee: { name: "Carla", status: "paused" }, config: { watchdog: true } }));
  assert.match(yours.steps[1], /the watchdog restores the issues Paperclip blocked during the pause/);
  const noSweep = advise(base({ assignee: { name: "Carla", status: "paused" }, config: { watchdog: true, watchdogResumeSweep: false } }));
  assert.match(noSweep.steps[1], /^If nothing starts/);
});

test("advice: a run that hit its usage limit, and one that only met a busy model", () => {
  const limit = advise(base({ runs: [run(A, "failed", 5, { errorCode: "provider_quota" })], lastFailure: { kind: "limit", label: "Claude", what: "usage limit", resetAt: "Mon 12 Oct, 16:00 (Europe/London)" } }));
  assert.match(limit.what, /Carla's last run hit its Claude usage limit, which resets Mon 12 Oct, 16:00/);
  assert.equal(limit.watchdog, "auto");
  assert.equal(advise(base({ runs: [run(A, "failed", 5)], lastFailure: { kind: "limit", label: "Claude", what: "usage limit" }, config: { watchdogLimitPause: false } })).watchdog, "manual");
  // Even when Paperclip's recovery has parked the issue since.
  const parked = advise(base({ issue: { status: "blocked", assigneeAgentId: A }, recovery: { kind: "stranded_assigned_issue", ownerType: "board" }, runs: [run(A, "failed", 5)], lastFailure: { kind: "limit", label: "Codex", what: "quota or billing limit" } }));
  assert.match(parked.what, /hit its Codex quota or billing limit\. Every run/);

  const busy = advise(base({ runs: [run(A, "failed", 5, { errorCode: "provider_quota" })], lastFailure: { kind: "transient", label: "Codex" } }));
  assert.match(busy.what, /failed on Codex's capacity 5 min ago \(the model was busy, not a usage limit\)/);
  assert.equal(busy.watchdog, null);
});

test("advice: a review blocked because its participant couldn't be woken", () => {
  const issue = { status: "blocked", assigneeAgentId: A, executionState: { status: "pending", currentParticipant: { type: "agent", agentId: B } } };
  const recovery = { kind: "stranded_assigned_issue", cause: "execution_review_participant_recovery", ownerType: "board" };
  const paused = advise(base({ issue, recovery, participant: { name: "Hoover", status: "paused" } }));
  assert.match(paused.what, /couldn't wake Hoover, the agent its pending review stage waits on \(Hoover is paused\)/);
  assert.deepEqual(paused.steps, ["Resume Hoover in Paperclip.", "Then set the issue's status back to In review: Paperclip re-pends the stage and wakes Hoover."]);
  assert.equal(paused.watchdog, "auto");
  const awake = advise(base({ issue, recovery, participant: { name: "Hoover", status: "idle" } }));
  assert.equal(awake.steps.length, 1);
  assert.equal(awake.watchdog, "manual");
});

test("advice: a review Paperclip escalated to you after the review-round limit", () => {
  const issue = {
    status: "in_review", assigneeAgentId: A,
    executionPolicy: { stages: [{ id: "s1", type: "review", participants: [{ type: "agent", agentId: B }] }] },
    executionState: { status: "pending", currentStageId: "s1", currentStageType: "review", changesRequestedCount: 3, currentParticipant: { type: "user", userId: "u-me" }, returnAssignee: { type: "agent", agentId: A } },
  };
  const a = advise(base({ issue }));
  assert.match(a.what, /handed this review to you after 3 agent change requests in a row/);
  assert.match(a.steps[1], /raise maxReviewRounds/);
  assert.equal(a.watchdog, "manual");
  assert.equal(advise(base({ issue, config: { watchdogReturnEscalatedReviews: true } })).watchdog, "auto");
});

test("advice: a cancelled blocker isn't a dropped wake", () => {
  const a = advise(base({ issue: { status: "blocked", assigneeAgentId: A }, blockers: { blockers: [{ identifier: "ACM-2", status: "done" }, { identifier: "ACM-3", status: "cancelled" }] } }));
  assert.match(a.what, /blocked by ACM-3, which was cancelled\. Paperclip never counts a cancelled blocker as resolved/);
  assert.match(a.steps[0], /remove ACM-3 from "Blocked by"/);
  assert.equal(a.watchdog, "auto");
  assert.equal(advise(base({ issue: { status: "blocked", assigneeAgentId: A }, blockers: { blockers: [{ identifier: "ACM-3", status: "cancelled" }] }, config: { watchdogCancelledBlockers: false } })).watchdog, "manual");
});

test("advice: in review with no stage pending, and stages an agent wiped", () => {
  const issue = { status: "in_review", assigneeAgentId: A, executionState: null };
  const plain = advise(base({ issue, runs: [run(A, "succeeded", 30)] }));
  assert.match(plain.what, /^It is in review, but no review stage is pending/);
  const wiped = advise(base({ issue, runs: [run(A, "succeeded", 30)], stagesWipedBy: "Dinesh" }));
  assert.match(wiped.what, /Its review stages were removed by Dinesh/);
});

test("advice: an agent waiting on a CI run", () => {
  const facts = { runs: [run(A, "succeeded", 30)], ciRun: "acme/app#39498202022", lastComment: { body: "Waiting on run 39498202022." } };
  const a = advise(base({ ...facts, config: { watchdog: true, githubToken: "t" } }));
  assert.match(a.what, /finished 30 min ago, waiting on CI run acme\/app#39498202022/);
  assert.equal(a.watchdog, "auto");
  assert.equal(advise(base(facts)).watchdog, "manual", "without a GitHub token the watchdog can't read the run");
});

test("pch why says when the watchdog paused the assignee at a usage limit, from its state file", async (t) => {
  const env = await setup();
  t.after(env.close);
  const agent = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "paused", adapterType: "codex_local" };
  env.db.agents.push(agent);
  const issue = { id: uuid(), identifier: "ACM-110", companyId: ids.company, status: "todo", assigneeAgentId: agent.id };
  env.db.issues.push(issue);
  const resetAt = Date.parse("2030-01-07T15:45:00Z");
  env.state.nudges.set(`limit:${ids.company}:codex:host-login`, {
    companyId: ids.company, account: "codex:host-login", adapter: "codex_local", what: "usage limit", resetAt, timeZone: "UTC",
    unknownReset: false, paused: { [agent.id]: { name: "Gilfoyle", pausedAt: new Date().toISOString(), tries: 0 } }, count: 1, at: Date.now(),
  });
  env.state.save({ force: true });
  const lines = (await captureOutput(() => cmd.why(env.ctx, "ACM-110"))).join("\n");
  assert.match(lines, /Paused by the watchdog at a usage limit; resumed at Mon 7 Jan, 15:50 \(UTC\)/);
  assert.match(lines, /Recommendation: The watchdog paused Gilfoyle because its Codex usage limit was reached; it resets Mon 7 Jan, 15:45 \(UTC\)/);
});
