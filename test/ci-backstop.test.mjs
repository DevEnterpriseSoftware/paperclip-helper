// Watchdog 11's backstop monitor, and 21: agents that wake themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { agentCiMonitor, BACKSTOP_MARK, backstopMonitor, isBackstop, polls } from "../src/ci-runs.mjs";
import { selfWakeLoop, selfWakes } from "../src/self-wakes.mjs";
import { advise } from "../src/advice.mjs";
import { loadConfig } from "../src/config.mjs";

async function watchdogEnv(t, extra = {}) {
  const gh = await startFakeGitHub();
  t.after(gh.close);
  const clock = { now: Date.now() };
  const env = await setup({
    env: { WATCHDOG_STALL_SEC: "180", GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, GITHUB_REPOS: "org/app", ...extra },
    now: () => clock.now,
  });
  t.after(env.close);
  return { ...env, gh, clock, watchdog: createWatchdog(env.ctx, env.state), later: (min) => (clock.now += min * 60_000) };
}

const RUN_URL = "https://github.com/org/app/actions/runs/39498202022";

// Carla pushed, named the run she waits on, and ended her run with the issue in
// progress. The run is still queued.
function waitingOnCi(env, { status = "in_progress", comment = `Pushed b61d07a9. Waiting on ${RUN_URL} before resubmitting.`, runStatus = "queued" } = {}) {
  const carla = { id: uuid(), companyId: ids.company, name: "Carla", status: "idle" };
  env.db.agents.push(carla);
  const stages = [{ id: "s1", type: "review", participants: [{ type: "user", userId: ids.user }] }];
  const issue = {
    id: uuid(), identifier: "ACM-192", companyId: ids.company, status, assigneeAgentId: carla.id, updatedAt: minutesAgo(5),
    executionPolicy: { stages },
  };
  env.db.issues.push(issue);
  env.db.comments.push({ issueId: issue.id, identifier: issue.identifier, body: comment, authorAgentId: carla.id, createdAt: minutesAgo(5) });
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(15), startedAt: minutesAgo(15), finishedAt: minutesAgo(5) }];
  const run = {
    id: 39498202022, name: "ci", status: runStatus, conclusion: null, run_attempt: 1, head_branch: "acm-192", head_sha: "b61d07a91",
    updated_at: minutesAgo(5), html_url: RUN_URL, pull_requests: [{ number: 188 }], jobs: [],
  };
  env.gh.runs["org/app"] = { [run.id]: run };
  return { carla, issue, run, stages };
}

const finish = (env, run, conclusion = "success") => Object.assign(run, { status: "completed", conclusion, updated_at: new Date(env.clock.now).toISOString() });
const helperComments = (db, issue) => db.comments.filter((c) => c.issueId === issue.id && !c.authorAgentId);
const monitorPatches = (db, issue) => db.patches.filter((p) => p.issueId === issue.id && p.body.executionPolicy !== undefined);

// ---------------------------------------------------------------- pure helpers

test("backstopMonitor: one check hours out, the run in its notes, one more attempt than the issue has used", () => {
  const now = Date.parse("2026-10-30T09:00:00Z");
  const run = { id: 39498202022, html_url: RUN_URL };
  const m = backstopMonitor({ run, now, backstopMs: 360 * 60_000, attemptCount: 7 });
  assert.equal(m.kind, "external_service");
  assert.equal(m.serviceName, "github");
  assert.equal(m.externalRef, RUN_URL);
  assert.equal(m.nextCheckAt, "2026-10-30T15:00:00.000Z");
  assert.ok(Date.parse(m.timeoutAt) > Date.parse(m.nextCheckAt));
  assert.equal(m.maxAttempts, 8, "Paperclip counts attempts across every monitor on the issue");
  assert.equal(m.recoveryPolicy, "wake_owner");
  assert.ok(m.notes.startsWith(BACKSTOP_MARK) && m.notes.includes(RUN_URL) && m.notes.length <= 500);
  assert.equal(backstopMonitor({ run, now, backstopMs: 3_600_000, attemptCount: 100 }).maxAttempts, undefined, "past Paperclip's cap of 100: none");
  assert.ok(isBackstop({ notes: m.notes, scheduledBy: "board" }));
  assert.ok(!isBackstop({ notes: m.notes, scheduledBy: "assignee" }), "an agent copying the notes doesn't make it the Helper's");
  assert.ok(!isBackstop({ notes: "CI run 39498202022" }));
});

test("agentCiMonitor and polls tell an agent's polling CI monitor from its other waits", () => {
  const run = { id: 39498202022 };
  const now = Date.now();
  const at = (min) => new Date(now + min * 60_000).toISOString();
  assert.ok(agentCiMonitor({ notes: "Re-check CI run 39498202022", nextCheckAt: at(20) }, run));
  assert.ok(agentCiMonitor({ notes: "Re-check CI", serviceName: "github", nextCheckAt: at(20) }, run), "no run named, on GitHub");
  assert.ok(!agentCiMonitor({ notes: "Vendor sandbox back?", serviceName: "vendor", nextCheckAt: at(20) }, run));
  assert.ok(!agentCiMonitor({ notes: "CI run 39498202022, then the deploy run 39498299999", nextCheckAt: at(20) }, run));
  assert.ok(polls({ nextCheckAt: at(20) }, now, 360 * 60_000));
  assert.ok(!polls({ nextCheckAt: at(300) }, now, 360 * 60_000), "an agent's own backstop, hours out");
});

test("WATCHDOG_CI_BACKSTOP_MIN is hours, never minutes; 0 turns it off", () => {
  assert.equal(loadConfig({}).config.watchdogCiBackstopMin, 360);
  assert.equal(loadConfig({ WATCHDOG_CI_BACKSTOP_MIN: "0" }).config.watchdogCiBackstopMin, 0);
  assert.deepEqual(loadConfig({ WATCHDOG_CI_BACKSTOP_MIN: "10" }).problems, ["WATCHDOG_CI_BACKSTOP_MIN=10 must be 0 (off) or at least 30"]);
  assert.equal(loadConfig({}).config.watchdogSelfWakes, true);
});

// ---------------------------------------------------------------- the backstop, end to end

test("a run still going gets the Helper's backstop monitor, with the issue's policy kept and nobody woken", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, stages } = waitingOnCi(env);
  issue.monitorAttemptCount = 3; // earlier monitors on this issue fired three times
  await env.watchdog.tick();
  const [patch, ...more] = monitorPatches(env.db, issue);
  assert.equal(more.length, 0);
  assert.equal(patch.body.comment, undefined, "no comment: that would wake the agent");
  assert.deepEqual(patch.body.executionPolicy.stages, stages);
  const m = patch.body.executionPolicy.monitor;
  assert.equal(m.maxAttempts, 4);
  assert.equal(m.externalRef, RUN_URL);
  assert.equal(Date.parse(m.nextCheckAt), env.clock.now + 360 * 60_000);
  assert.equal(issue.executionState.monitor.status, "scheduled");
  assert.equal(issue.executionState.monitor.scheduledBy, "board");
  assert.equal(issue.executionPolicy.monitor.externalRef, "[redacted]", "Paperclip stores it redacted: the notes name the run");
  assert.equal(helperComments(env.db, issue).length, 0);
  assert.equal(env.watchdog.stats.ciBackstops, 1);
  assert.ok(env.logs.some((l) => l.msg === "watchdog: scheduled a CI backstop monitor" && l.run === 39498202022));

  env.later(1);
  await env.watchdog.tick();
  env.later(4);
  await env.watchdog.tick();
  assert.equal(monitorPatches(env.db, issue).length, 1, "it stands: not scheduled again");
});

test("the backstop goes on while the agent's run is still going: the guard looks the moment it ends", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env);
  const running = { runId: uuid(), agentId: carla.id, status: "running", createdAt: minutesAgo(2), startedAt: minutesAgo(2) };
  env.db.issueRuns[issue.id].unshift(running);
  issue.executionRunId = running.runId;
  issue.updatedAt = new Date().toISOString();
  await env.watchdog.tick();
  assert.equal(monitorPatches(env.db, issue).length, 1);
});

test("no backstop for a run already finished, an issue not in progress, a run outside GITHUB_REPOS, or with it off", async (t) => {
  const done = await watchdogEnv(t);
  const a = waitingOnCi(done, { runStatus: "completed" });
  a.run.conclusion = "success";
  await done.watchdog.tick();
  assert.equal(monitorPatches(done.db, a.issue).length, 0, "finished: the report is on its way");

  const blocked = await watchdogEnv(t);
  const b = waitingOnCi(blocked, { status: "blocked" });
  await blocked.watchdog.tick();
  assert.equal(blocked.db.patches.length, 0, "Paperclip keeps a monitor only in progress or in review");

  const elsewhere = await watchdogEnv(t);
  const c = waitingOnCi(elsewhere, { comment: "Waiting on https://github.com/other/repo/actions/runs/39498202022" });
  await elsewhere.watchdog.tick();
  assert.equal(monitorPatches(elsewhere.db, c.issue).length, 0);

  const off = await watchdogEnv(t, { WATCHDOG_CI_BACKSTOP_MIN: "0" });
  const d = waitingOnCi(off);
  await off.watchdog.tick();
  assert.equal(off.db.patches.length, 0);
  assert.equal(b.issue.executionPolicy.monitor, undefined);
  assert.equal(d.issue.executionState, undefined);
});

test("the run finishing: one wake, without waiting out the stall window, and the backstop cleared in the same step", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue, run, stages } = waitingOnCi(env);
  await env.watchdog.tick();
  assert.equal(issue.executionState.monitor.status, "scheduled");

  env.later(4);
  finish(env, run, "failure");
  run.jobs = [{ name: "unit", conclusion: "failure" }];
  await env.watchdog.tick();
  const posted = helperComments(env.db, issue);
  assert.equal(posted.length, 1, "reported at once: nothing else will notice the run finished");
  assert.ok(posted[0].body.startsWith(`[@Carla](agent://${carla.id}) the CI run you were waiting on has finished`));
  assert.match(posted[0].body, /The Helper's backstop monitor for this run was cleared\./);
  assert.doesNotMatch(posted[0].body, /replaced your own monitor/);
  const last = env.db.patches.at(-1).body;
  assert.ok(last.comment, "the clearing travels with the comment");
  assert.deepEqual(last.executionPolicy, { stages });
  assert.equal(issue.executionState.monitor.status, "cleared");
  assert.ok(!env.state.nudges.has(`ci-backstop:${issue.id}`));
  assert.equal(env.watchdog.stats.ciReports, 1);

  for (const min of [1, 4, 10]) {
    env.later(min);
    await env.watchdog.tick();
  }
  assert.equal(helperComments(env.db, issue).length, 1, "once");
  assert.equal(monitorPatches(env.db, issue).length, 2, "no new backstop for a finished run");
});

test("an agent's own monitor for another wait is left alone, and keeps the report back as before", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, run } = waitingOnCi(env);
  const own = { nextCheckAt: new Date(env.clock.now + 20 * 60_000).toISOString(), notes: "Vendor sandbox back up?", serviceName: "vendor", scheduledBy: "assignee" };
  issue.executionPolicy = { ...issue.executionPolicy, monitor: own };
  issue.executionState = { monitor: { status: "scheduled", ...own, attemptCount: 0 } };
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  finish(env, run);
  env.later(10);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length + helperComments(env.db, issue).length, 0, "it will still fire: left to do its job");
});

test("an agent's monitor polling the run is replaced by the backstop, said in its notes, not in a comment", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, run } = waitingOnCi(env);
  const polling = { nextCheckAt: new Date(env.clock.now + 20 * 60_000).toISOString(), notes: "Re-check CI", serviceName: "github", maxAttempts: 40, externalRef: "[redacted]", scheduledBy: "assignee" };
  issue.executionPolicy = { ...issue.executionPolicy, monitor: polling };
  issue.executionState = { monitor: { status: "scheduled", ...polling, attemptCount: 5 } };
  await env.watchdog.tick();
  const [patch] = monitorPatches(env.db, issue);
  assert.ok(patch, "replaced");
  const m = patch.body.executionPolicy.monitor;
  assert.ok(m.notes.startsWith(BACKSTOP_MARK));
  assert.match(m.notes, /replaced the assignee's own monitor polling this run/);
  assert.equal(m.maxAttempts, 6);
  assert.equal(helperComments(env.db, issue).length, 0, "a comment would wake the agent: the notes say it");
  assert.ok(env.logs.some((l) => l.msg === "watchdog: scheduled a CI backstop monitor" && l.replaced));

  env.later(4);
  finish(env, run);
  await env.watchdog.tick();
  const [report] = helperComments(env.db, issue);
  assert.match(report.body, /It had replaced your own monitor polling the run: to wait on CI, name the run in your last comment and end your run, without a monitor/);
});

test("an agent's own backstop on the run (hours out) stands, and is cleared with the report", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, run } = waitingOnCi(env);
  const own = { nextCheckAt: new Date(env.clock.now + 6 * 60 * 60_000).toISOString(), notes: `Backstop for ${RUN_URL}`, maxAttempts: 1, scheduledBy: "assignee" };
  issue.executionPolicy = { ...issue.executionPolicy, monitor: own };
  issue.executionState = { monitor: { status: "scheduled", ...own, attemptCount: 0 } };
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0, "not polling: left to stand");
  env.later(4);
  finish(env, run);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.match(helperComments(env.db, issue)[0].body, /Your Paperclip monitor for this run was cleared/);
  assert.equal(issue.executionState.monitor.status, "cleared");
});

test("a newer run named moves the backstop to it; the issue moving to review clears it without a word", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env);
  await env.watchdog.tick();
  assert.equal(monitorPatches(env.db, issue).length, 1);

  const newer = { id: 39498300001, name: "ci", status: "in_progress", run_attempt: 1, html_url: "https://github.com/org/app/actions/runs/39498300001", updated_at: new Date(env.clock.now).toISOString(), jobs: [] };
  env.gh.runs["org/app"][newer.id] = newer;
  env.db.comments.push({ issueId: issue.id, body: `Fixed the lint error and pushed; waiting on ${newer.html_url}`, authorAgentId: carla.id, createdAt: new Date().toISOString() });
  issue.updatedAt = new Date().toISOString();
  env.later(1);
  await env.watchdog.tick();
  const moved = monitorPatches(env.db, issue);
  assert.equal(moved.length, 2);
  assert.match(moved[1].body.executionPolicy.monitor.notes, /39498300001/);
  assert.doesNotMatch(moved[1].body.executionPolicy.monitor.notes, /39498202022/);

  issue.status = "in_review";
  issue.updatedAt = new Date(Date.now() + 1000).toISOString();
  env.later(1);
  await env.watchdog.tick();
  const tidied = monitorPatches(env.db, issue);
  assert.equal(tidied.length, 3);
  assert.equal(tidied[2].body.comment, undefined);
  assert.equal(tidied[2].body.executionPolicy.monitor, undefined);
  assert.equal(issue.executionState.monitor.status, "cleared");
  assert.equal(helperComments(env.db, issue).length, 0);
  assert.ok(!env.state.nudges.has(`ci-backstop:${issue.id}`));
});

test("a backstop an agent keeps wiping is put back a few times, then left to Paperclip with one warning", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env);
  for (let i = 0; i < 6; i += 1) {
    await env.watchdog.tick();
    // The agent's own update sends the policy it read before the backstop: the monitor is gone.
    issue.executionPolicy = { stages: issue.executionPolicy.stages };
    issue.executionState = { monitor: { ...issue.executionState?.monitor, status: "cleared", clearReason: "manual", nextCheckAt: null } };
    issue.updatedAt = new Date(Date.now() + i * 1000).toISOString();
    env.later(1);
  }
  assert.equal(monitorPatches(env.db, issue).length, 3);
  assert.equal(env.logs.filter((l) => /keeps being replaced or refused/.test(l.msg)).length, 1);
});

test("a dry run schedules nothing and says what it would do, once", async (t) => {
  const env = await watchdogEnv(t, { DRY_RUN: "true" });
  const { issue } = waitingOnCi(env);
  await env.watchdog.tick();
  issue.updatedAt = new Date(Date.now() + 1000).toISOString();
  env.later(1);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  assert.equal(env.logs.filter((l) => l.msg === "watchdog: would schedule a CI backstop monitor (dry run)").length, 1);
});

test("GitHub not answering: no backstop this tick, tried again the next", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env);
  env.gh.fail["GET run"] = 500;
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  delete env.gh.fail["GET run"];
  env.later(1);
  await env.watchdog.tick();
  assert.equal(monitorPatches(env.db, issue).length, 1);
});

// ---------------------------------------------------------------- 21. agents that wake themselves

// Dinesh's runs end without a comment of his own; Paperclip posts each run's final
// message as his comment, and the next run is queued two seconds later.
function selfWaking(env, { turns = 6, gapSec = 2 } = {}) {
  const dinesh = { id: uuid(), companyId: ids.company, name: "Dinesh", status: "running" };
  env.db.agents.push(dinesh);
  const issue = { id: uuid(), identifier: "ACM-305", companyId: ids.company, status: "in_progress", assigneeAgentId: dinesh.id, updatedAt: new Date().toISOString() };
  env.db.issues.push(issue);
  const runs = [];
  const start = env.clock.now - 50 * 60_000;
  for (let i = 0; i < turns + 1; i += 1) {
    const at = start + i * 7 * 60_000;
    runs.push({ runId: uuid(), agentId: dinesh.id, status: i === turns ? "running" : "succeeded", createdAt: new Date(at).toISOString(), startedAt: new Date(at + 1000).toISOString() });
  }
  for (let i = 0; i < turns; i += 1) {
    const posted = Date.parse(runs[i + 1].createdAt) - gapSec * 1000;
    env.db.activity.push({
      action: "issue.comment_added", entityType: "issue", entityId: issue.id, actorType: "agent", actorId: dinesh.id, agentId: dinesh.id, runId: runs[i].runId,
      details: { source: "run_presentation_resolver", commentId: uuid() }, createdAt: new Date(posted).toISOString(),
    });
  }
  env.db.issueRuns[issue.id] = runs.slice().reverse();
  return { dinesh, issue, runs };
}

test("selfWakes pairs each posted final message with the agent's next run, seconds later", () => {
  const now = Date.parse("2026-10-30T10:00:00Z");
  const at = (min, sec = 0) => new Date(now - min * 60_000 + sec * 1000).toISOString();
  const activity = [
    { action: "issue.comment_added", agentId: "a", runId: "r1", details: { source: "run_presentation_resolver" }, createdAt: at(30) },
    { action: "issue.comment_added", agentId: "a", runId: "r2", details: { source: "run_presentation_resolver" }, createdAt: at(20) },
    { action: "issue.comment_added", agentId: "a", runId: "r3", details: {}, createdAt: at(10) }, // its own comment
    { action: "issue.comment_added", agentId: "a", runId: "r0", details: { source: "run_presentation_resolver" }, createdAt: at(90) }, // outside the hour
  ];
  const runs = [
    { runId: "r2", agentId: "a", createdAt: at(30, 3) },
    { runId: "r3", agentId: "a", createdAt: at(20, 60) }, // a minute later: something else woke it
    { runId: "rx", agentId: "b", createdAt: at(10, 1) },
  ];
  const found = selfWakes(activity, runs, { now });
  assert.deepEqual(found.map((w) => [w.runId, w.nextRunId]), [["r1", "r2"]]);
  assert.equal(selfWakeLoop(activity, runs, { now }), null, "one is not a loop");
});

test("an agent waking itself: one note for the board, never a comment on the issue", async (t) => {
  const env = await watchdogEnv(t);
  const board = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", updatedAt: minutesAgo(600) };
  env.db.issues.push(board);
  const watchdog = createWatchdog(env.makeCtx({ WATCHDOG_NOTIFY_ISSUE: "ACM-1" }), env.state);
  const { issue } = selfWaking(env);
  await watchdog.tick();
  const notes = env.db.comments.filter((c) => c.issueId === board.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^Dinesh is waking itself on ACM-305: 6 of its runs there in the last hour ended without a comment of its own/);
  assert.doesNotMatch(notes[0].body, /agent:\/\//, "no mention: that would wake it");
  assert.equal(env.db.comments.filter((c) => c.issueId === issue.id).length, 0);
  assert.equal(env.db.patches.length, 0);
  assert.equal(watchdog.stats.selfWakes, 1);

  issue.updatedAt = new Date(Date.now() + 1000).toISOString();
  env.later(5);
  await watchdog.tick();
  assert.equal(env.db.comments.filter((c) => c.issueId === board.id).length, 1, "once per issue");
});

test("four turns, or runs a minute after each message, aren't a self-wake loop; WATCHDOG_SELF_WAKES=false checks nothing", async (t) => {
  const few = await watchdogEnv(t);
  selfWaking(few, { turns: 4 });
  await few.watchdog.tick();
  assert.equal(few.watchdog.stats.selfWakes, 0);

  const slow = await watchdogEnv(t);
  selfWaking(slow, { gapSec: 60 });
  await slow.watchdog.tick();
  assert.equal(slow.watchdog.stats.selfWakes, 0);

  const off = await watchdogEnv(t, { WATCHDOG_SELF_WAKES: "false" });
  selfWaking(off);
  await off.watchdog.tick();
  assert.equal(off.watchdog.stats.selfWakes, 0);
});

test("pch why: a self-wake loop comes first, even with a run going; a CI wait names the backstop", () => {
  const issue = { status: "in_progress", assigneeAgentId: "a" };
  const loop = advise({
    identifier: "ACM-305", issue, assignee: { name: "Dinesh", status: "running" },
    runs: [{ runId: "r9", agentId: "a", status: "running", createdAt: new Date().toISOString() }],
    selfWake: { name: "Dinesh", count: 7 },
  });
  assert.match(loop.what, /^Dinesh keeps waking itself: 7 of its runs here in the last hour/);
  assert.equal(loop.watchdog, "manual");
  assert.match(loop.steps[1], /end every run with a comment of its own/);

  const waiting = advise({
    identifier: "ACM-192", issue, assignee: { name: "Carla", status: "idle" },
    runs: [{ runId: "r1", agentId: "a", status: "succeeded", createdAt: minutesAgo(20), finishedAt: minutesAgo(10) }],
    ciRun: "org/app#39498202022", ciBackstop: { nextCheckAt: "2026-10-30T15:00:00.000Z" },
  });
  assert.match(waiting.what, /The Helper's backstop monitor holds the wait \(next check 2026-10-30T15:00:00.000Z\)/);
});
