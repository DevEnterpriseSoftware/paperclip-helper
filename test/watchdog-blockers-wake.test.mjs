// Watchdog 2 (blocked issues whose blockers are all done) leaves an issue alone when
// the blockers-resolved wake got through, or when it waits on a card a person must
// answer. Agents often leave a done blocker in "Blocked by" when they go on to wait
// for something else, so "every blocker is done, the issue is blocked and idle" alone
// doesn't prove the wake was dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { blockersResolvedWake, boardCard, ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import * as cmd from "../src/commands.mjs";

async function watchdogEnv(t, extra = {}) {
  let clock = Date.now();
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...extra }, now: () => clock });
  t.after(env.close);
  return { ...env, watchdog: createWatchdog(env.ctx, env.state), later: (min) => (clock += min * 60_000) };
}

const WAKE_SKIP = "watchdog: no blockers-resolved nudge: wake taken up by run";

// ACM-6 is blocked by ACM-7, which was done 30 minutes ago. ACM-6 is still blocked
// with ACM-7 listed, its assignee idle, and nothing has touched it for 20 minutes.
function doneBlocker(env) {
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "claude_local" };
  env.db.agents.push(engineer);
  const blocker = { id: uuid(), identifier: "ACM-7", companyId: ids.company, status: "done", completedAt: minutesAgo(30), updatedAt: minutesAgo(30) };
  const issue = {
    id: uuid(), identifier: "ACM-6", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id,
    blockedBy: [{ id: blocker.id, identifier: "ACM-7", status: "done" }], updatedAt: minutesAgo(20),
  };
  env.db.issues.push(blocker, issue);
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: true, isDependencyReady: true, unresolvedBlockerCount: 0 },
    blockers: [{ id: blocker.id, identifier: "ACM-7", status: "done", isPendingFinalize: false }],
  };
  return { engineer, blocker, issue };
}

// The assignee's run the wake made: started as the blocker finished, ended four minutes later.
function wakeRun(env, issue, engineer, { at = 30 } = {}) {
  const run = { runId: uuid(), agentId: engineer.id, status: "succeeded", createdAt: minutesAgo(at), startedAt: minutesAgo(at), finishedAt: minutesAgo(at - 4) };
  (env.db.issueRuns[issue.id] ??= []).unshift(run);
  return run;
}

function agentComment(env, issue, engineer, body, at) {
  env.db.comments.push({ id: uuid(), issueId: issue.id, body, authorType: "agent", authorAgentId: engineer.id, authorUserId: null, createdAt: minutesAgo(at) });
}

const helperComments = (env) => env.db.comments.filter((c) => c.authorType === "user");

async function ticks(env, n = 3) {
  for (let i = 0; i < n; i += 1) {
    await env.watchdog.tick();
    env.later(4);
  }
}

test("a wake taken up whose run then waits on a board card: no nudge, no comment, no status change", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer, blocker, issue } = doneBlocker(env);
  const run = wakeRun(env, issue, engineer);
  blockersResolvedWake(env.db, issue, { runId: run.runId, blockerIds: [blocker.id], at: minutesAgo(30) });
  boardCard(env.db, issue, { at: minutesAgo(27) });
  agentComment(env, issue, engineer, "The follow-up is done. This now waits only for the board's answer on the card.", 26);

  await ticks(env);
  assert.equal(helperComments(env).length, 0, "no 'every blocker on this issue is done' comment");
  assert.equal(env.db.patches.length, 0);
  assert.equal(issue.status, "blocked", "not reopened");
  const skips = env.logs.filter((l) => l.msg === `${WAKE_SKIP} ${run.runId}`);
  assert.equal(skips.length, 1, "said once");
  assert.equal(skips[0].level, "debug");
  assert.equal(skips[0].rule, "2");
  assert.equal(skips[0].by, "wake run");
  assert.deepEqual(skips[0].blockersDone, ["ACM-7"]);
});

test("a wake taken up with no card: the run that ended blocked with its own comment is enough", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer, blocker, issue } = doneBlocker(env);
  const run = wakeRun(env, issue, engineer);
  blockersResolvedWake(env.db, issue, { runId: run.runId, blockerIds: [blocker.id], at: minutesAgo(30) });
  agentComment(env, issue, engineer, "Blocked: waiting on the vendor's sandbox.", 26);

  await ticks(env);
  assert.equal(helperComments(env).length, 0);
  assert.ok(env.logs.some((l) => l.msg === `${WAKE_SKIP} ${run.runId}`));
});

test("without the wake's activity, a run of the assignee or its comment since the last blocker was done counts as taken up", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer, issue } = doneBlocker(env);
  const run = wakeRun(env, issue, engineer, { at: 25 });
  await ticks(env);
  assert.equal(helperComments(env).length, 0);
  assert.equal(env.logs.find((l) => l.msg === `${WAKE_SKIP} ${run.runId}`)?.by, "run since");

  const other = await watchdogEnv(t);
  const b = doneBlocker(other);
  agentComment(other, b.issue, b.engineer, "Moving on to wait for the release window.", 25);
  await ticks(other);
  assert.equal(helperComments(other).length, 0);
  assert.ok(other.logs.some((l) => l.msg === "watchdog: no blockers-resolved nudge: wake taken up (the assignee commented since)"));
});

test("a pending board card alone, with no wake activity, holds the nudge back", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = doneBlocker(env);
  const card = boardCard(env.db, issue, { kind: "request_confirmation", at: minutesAgo(40) });

  await ticks(env);
  assert.equal(helperComments(env).length, 0);
  const skip = env.logs.filter((l) => l.msg === "watchdog: no blockers-resolved nudge: waits on a board interaction");
  assert.equal(skip.length, 1);
  assert.equal(skip[0].card, card.id);
  assert.equal(skip[0].kind, "request_confirmation");
});

test("a card addressed to a teammate isn't the board's: the dropped wake is still nudged", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = doneBlocker(env);
  const card = boardCard(env.db, issue);
  card.addresseeAgentId = uuid();
  await env.watchdog.tick();
  assert.equal(helperComments(env).length, 1);
});

test("a wake really dropped is still nudged, 1/2 then 2/2", async (t) => {
  for (const variant of ["no activity", "no run made", "a run that doesn't exist", "an old episode's wake and run"]) {
    const env = await watchdogEnv(t);
    const { engineer, blocker, issue } = doneBlocker(env);
    if (variant === "no run made") blockersResolvedWake(env.db, issue, { runId: null, blockerIds: [blocker.id], at: minutesAgo(30) });
    if (variant === "a run that doesn't exist") blockersResolvedWake(env.db, issue, { runId: uuid(), blockerIds: [blocker.id], at: minutesAgo(30) });
    if (variant === "an old episode's wake and run") {
      // An earlier blocker's wake, taken up two hours ago, before this blocker was done.
      const old = wakeRun(env, issue, engineer, { at: 120 });
      blockersResolvedWake(env.db, issue, { runId: old.runId, at: minutesAgo(120) });
      agentComment(env, issue, engineer, "Picked up after the earlier blocker.", 115);
    }
    // A card already answered isn't waiting on anyone.
    boardCard(env.db, issue).status = "answered";

    await env.watchdog.tick();
    assert.equal(helperComments(env).length, 1, variant);
    assert.match(helperComments(env)[0].body, /every blocker on this issue is done \(ACM-7\)/);
    assert.match(helperComments(env)[0].body, /nudge 1\/2/);
    issue.status = "blocked"; // the fake reopens it; the agent blocked it again without running
    env.later(4);
    issue.updatedAt = minutesAgo(10);
    await env.watchdog.tick();
    assert.equal(helperComments(env).length, 2, variant);
    assert.match(helperComments(env)[1].body, /nudge 2\/2/);
  }
});

test("dry run: says it would skip, for a wake taken up and for a board card, and changes nothing", async (t) => {
  const env = await watchdogEnv(t, { DRY_RUN: "true" });
  const { engineer, blocker, issue } = doneBlocker(env);
  const run = wakeRun(env, issue, engineer);
  blockersResolvedWake(env.db, issue, { runId: run.runId, blockerIds: [blocker.id], at: minutesAgo(30) });
  const second = doneBlocker(env);
  second.issue.identifier = "ACM-16";
  boardCard(env.db, second.issue);

  await ticks(env, 2);
  assert.equal(helperComments(env).length, 0);
  assert.equal(env.db.patches.length, 0);
  const taken = env.logs.filter((l) => l.msg === `watchdog: would skip the blockers-resolved nudge (dry run): wake taken up by run ${run.runId}`);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].level, "info");
  assert.equal(env.logs.filter((l) => l.msg === "watchdog: would skip the blockers-resolved nudge (dry run): waits on a board interaction").length, 1);
  assert.ok(!env.logs.some((l) => l.msg === "watchdog: would nudge (dry run)"));
});

test("a board card also holds back the hand-off and cancelled-blocker nudges", async (t) => {
  // 1: handed from the engineer to the reviewer, who never started; the engineer left a card for the board.
  const env = await watchdogEnv(t);
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "claude_local" };
  const reviewer = { id: uuid(), companyId: ids.company, name: "Reviewer", status: "idle", adapterType: "claude_local" };
  env.db.agents.push(engineer, reviewer);
  const handed = { id: uuid(), identifier: "ACM-5", companyId: ids.company, status: "in_review", assigneeAgentId: reviewer.id, updatedAt: minutesAgo(10) };
  env.db.issues.push(handed);
  env.db.issueRuns[handed.id] = [{ runId: uuid(), agentId: engineer.id, status: "cancelled", createdAt: minutesAgo(300), finishedAt: minutesAgo(10) }];
  boardCard(env.db, handed, { createdByAgentId: engineer.id });

  // 14: blocked by a cancelled issue, with a card for the board.
  const blocked = { id: uuid(), identifier: "ACM-8", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(10) };
  env.db.issues.push(blocked);
  env.db.blockerDiagnostics[blocked.id] = { readiness: { allBlockersDone: false }, blockers: [{ id: uuid(), identifier: "ACM-9", status: "cancelled" }] };
  boardCard(env.db, blocked);

  await ticks(env, 2);
  assert.equal(helperComments(env).length, 0);
  const rules = env.logs.filter((l) => /^watchdog: no (hand-off|cancelled-blocker) nudge: waits on a board interaction$/.test(l.msg)).map((l) => l.rule).sort();
  assert.deepEqual(rules, ["1", "14"]);

  // Once the card is answered, the nudges go out as before.
  for (const c of [...env.db.interactions[handed.id], ...env.db.interactions[blocked.id]]) c.status = "answered";
  handed.updatedAt = minutesAgo(10);
  blocked.updatedAt = minutesAgo(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env).length, 2);
});

test("pch why: a wake taken up isn't called dropped; an earlier round's wake doesn't count", async (t) => {
  const env = await watchdogEnv(t);
  const { engineer, blocker, issue } = doneBlocker(env);
  const run = wakeRun(env, issue, engineer);
  const wake = blockersResolvedWake(env.db, issue, { runId: run.runId, blockerIds: [blocker.id], at: minutesAgo(30) });
  agentComment(env, issue, engineer, "Waiting only for the board's answer on the card.", 26);
  let text = (await captureOutput(() => cmd.why(env.ctx, "ACM-6"))).join("\n");
  assert.match(text, new RegExp(`Blockers-resolved wake: taken up by run ${run.runId.slice(0, 8)} \\(succeeded\\)`));
  assert.match(text, /Engineer took up the wake/);
  assert.doesNotMatch(text, /was dropped/);

  // The same wake, logged for another blocker: an earlier round's.
  wake.details.resolvedBlockerIssueId = uuid();
  wake.details.blockerIssueIds = [wake.details.resolvedBlockerIssueId];
  text = (await captureOutput(() => cmd.why(env.ctx, "ACM-6"))).join("\n");
  assert.match(text, /the wake that should have restarted the issue was dropped/);
});
