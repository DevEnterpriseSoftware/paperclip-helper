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
  assert.deepEqual(open.steps, ["pch why ACM-2"]);

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
