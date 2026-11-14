// Watchdog 11's backstop monitor, and 21: agents that wake themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { agentCiMonitor, BACKSTOP_MARK, backstopMonitor, isBackstop, polls, runRefs, sawRun, stillWaitsOn } from "../src/ci-runs.mjs";
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

const RUN_URL = "https://github.com/org/app/actions/runs/30498202022";

// Carla pushed, named the run she waits on, and ended her run with the issue in
// progress. The run is still queued.
function waitingOnCi(env, { status = "in_progress", comment = `Pushed c0de1234. Waiting on ${RUN_URL} before resubmitting.`, runStatus = "queued" } = {}) {
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
    id: 30498202022, name: "ci", status: runStatus, conclusion: null, run_attempt: 1, head_branch: "acm-192", head_sha: "c0de12341",
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
  const run = { id: 30498202022, html_url: RUN_URL };
  const m = backstopMonitor({ run, now, backstopMs: 360 * 60_000, attemptCount: 7 });
  assert.equal(m.kind, "external_service");
  assert.equal(m.serviceName, "github");
  assert.equal(m.externalRef, RUN_URL);
  assert.equal(m.nextCheckAt, "2026-10-30T15:00:00.000Z");
  assert.ok(Date.parse(m.timeoutAt) > Date.parse(m.nextCheckAt));
  assert.equal(m.maxAttempts, 8, "Paperclip counts attempts across every monitor on the issue");
  assert.equal(m.recoveryPolicy, "wake_owner");
  assert.ok(m.notes.startsWith(BACKSTOP_MARK) && m.notes.length <= 500);
  // The notes name the run the way the watchdog reads it back (Paperclip redacts externalRef).
  assert.deepEqual(runRefs(m.notes), [{ repo: "org/app", id: "30498202022" }]);
  assert.equal(backstopMonitor({ run, now, backstopMs: 3_600_000, attemptCount: 100 }).maxAttempts, undefined, "past Paperclip's cap of 100: none");
  assert.ok(isBackstop({ notes: m.notes, scheduledBy: "board" }));
  assert.ok(!isBackstop({ notes: m.notes, scheduledBy: "assignee" }), "an agent copying the notes doesn't make it the Helper's");
  assert.ok(!isBackstop({ notes: "CI run 30498202022" }));
});

test("agentCiMonitor and polls tell an agent's polling CI monitor from its other waits", () => {
  const run = { id: 30498202022 };
  const now = Date.now();
  const at = (min) => new Date(now + min * 60_000).toISOString();
  assert.ok(agentCiMonitor({ notes: "Re-check CI run 30498202022", nextCheckAt: at(20) }, run));
  assert.ok(agentCiMonitor({ notes: "Re-check CI", serviceName: "github", nextCheckAt: at(20) }, run), "no run named, on GitHub");
  assert.ok(!agentCiMonitor({ notes: "Vendor sandbox back?", serviceName: "vendor", nextCheckAt: at(20) }, run));
  assert.ok(!agentCiMonitor({ notes: "CI run 30498202022, then the deploy run 30498299999", nextCheckAt: at(20) }, run));
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
  assert.ok(env.logs.some((l) => l.msg === "watchdog: scheduled a CI backstop monitor" && l.run === 30498202022));

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
  const c = waitingOnCi(elsewhere, { comment: "Waiting on https://github.com/other/repo/actions/runs/30498202022" });
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

  const newer = { id: 30498300001, name: "ci", status: "in_progress", run_attempt: 1, html_url: "https://github.com/org/app/actions/runs/30498300001", updated_at: new Date(env.clock.now).toISOString(), jobs: [] };
  env.gh.runs["org/app"][newer.id] = newer;
  env.db.comments.push({ issueId: issue.id, body: `Fixed the lint error and pushed; waiting on ${newer.html_url}`, authorAgentId: carla.id, createdAt: new Date().toISOString() });
  issue.updatedAt = new Date().toISOString();
  env.later(1);
  await env.watchdog.tick();
  const moved = monitorPatches(env.db, issue);
  assert.equal(moved.length, 2);
  assert.match(moved[1].body.executionPolicy.monitor.notes, /30498300001/);
  assert.doesNotMatch(moved[1].body.executionPolicy.monitor.notes, /30498202022/);

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

// Paperclip holds the issue behind the disposition repair it had scheduled when Carla's
// run ended, which the backstop made unnecessary: suppressed before it started
// (issue_disposition_repair_superseded), then settled to blocked by a direct update that
// leaves the monitor where it is. With `clear`, Paperclip cleared the monitor on the way.
function holdBehindSuppressedRepair(env, { carla, issue }, { clear = false } = {}) {
  const runId = uuid();
  const finishedAt = minutesAgo(5);
  env.db.heartbeatRuns.push({
    id: runId, companyId: ids.company, agentId: carla.id, status: "cancelled", errorCode: "issue_disposition_repair_superseded", runtimeMode: "legacy",
    createdAt: minutesAgo(6), finishedAt, startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null, processStartedAt: null,
    nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null, controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    usageJson: null, resultJson: {}, contextSnapshot: { issueId: issue.id },
  });
  env.db.runEvents[runId] = [];
  env.db.issueRuns[issue.id].unshift({ runId, agentId: carla.id, status: "cancelled", errorCode: "issue_disposition_repair_superseded", createdAt: minutesAgo(6), finishedAt });
  issue.status = "blocked";
  issue.executionBlocker = {
    recoveryActionId: uuid(), runId, agentId: carla.id, cause: "legacy_execution_requires_reconciliation", runStatus: "cancelled", savedMessageCount: 0,
  };
  if (clear) {
    issue.executionPolicy = { stages: issue.executionPolicy.stages };
    issue.executionState = { ...issue.executionState, monitor: { ...issue.executionState.monitor, status: "cleared", clearReason: "invalid_status", nextCheckAt: null } };
  }
  issue.updatedAt = new Date(Date.now() + 1000).toISOString();
  return runId;
}

test("a hold keeps the backstop: never cleared from a held issue, while a blocked one that isn't held loses it as before", async (t) => {
  const env = await watchdogEnv(t);
  const w = waitingOnCi(env);
  const { issue } = w;
  await env.watchdog.tick();
  const scheduled = issue.executionPolicy.monitor;
  const record = env.state.nudges.get(`ci-backstop:${issue.id}`);
  assert.ok(record.monitor.notes.startsWith(BACKSTOP_MARK), "the record keeps the monitor as scheduled, for a release to put back");
  assert.equal(record.monitor.externalRef, RUN_URL);

  holdBehindSuppressedRepair(env, w);
  env.later(1);
  await env.watchdog.tick();
  env.later(1);
  await env.watchdog.tick();
  assert.equal(monitorPatches(env.db, issue).length, 1, "not cleared: the release puts the issue back in progress with it");
  assert.deepEqual(issue.executionPolicy.monitor, scheduled);
  assert.ok(env.state.nudges.has(`ci-backstop:${issue.id}`));
  assert.ok(!env.logs.some((l) => l.msg === "watchdog: cleared its CI backstop monitor"));

  // Blocked for another reason (nothing holds it): cleared, as before.
  issue.executionBlocker = null;
  issue.updatedAt = new Date(Date.now() + 2000).toISOString();
  env.later(1);
  await env.watchdog.tick();
  const tidied = monitorPatches(env.db, issue);
  assert.equal(tidied.length, 2);
  assert.equal(tidied[1].body.executionPolicy.monitor, undefined);
  assert.ok(!env.state.nudges.has(`ci-backstop:${issue.id}`));
});

// The agent's runs on the issue that Paperclip queued (a wake), with simulateWakes on.
const wakesOf = (env, { carla, issue }) => (env.db.issueRuns[issue.id] ?? []).filter((r) => r.agentId === carla.id && r.status === "queued");
const keptLines = (env) => env.logs.filter((l) => l.msg === "watchdog: a hold on an issue waiting on CI is kept until the run finishes");

test("a hold behind the repair the backstop suppressed is kept while CI runs, and released with the run's report once it finishes: one wake", async (t) => {
  const env = await watchdogEnv(t);
  env.db.simulateWakes = true;
  const w = waitingOnCi(env);
  const { issue } = w;
  await env.watchdog.tick();
  const scheduled = issue.executionPolicy.monitor;
  const runId = holdBehindSuppressedRepair(env, w);

  // CI still going: two hold scans, a stall window apart, release nothing and wake nobody.
  for (let i = 0; i < 3; i += 1) {
    env.later(4);
    await env.watchdog.tick();
  }
  assert.equal((env.db.resolutions ?? []).length, 0, "the hold stays while the run goes");
  assert.equal(issue.executionBlocker.runId, runId);
  assert.equal(issue.status, "blocked");
  assert.deepEqual(issue.executionPolicy.monitor, scheduled, "the backstop stays with it");
  assert.equal(helperComments(env.db, issue).length, 0);
  assert.equal(wakesOf(env, w).length, 0, "no wake before CI finishes");
  const kept = keptLines(env);
  assert.equal(kept.length, 1, "said once, not every scan");
  assert.equal(kept[0].rule, "22");
  assert.equal(String(kept[0].ciRun), String(w.run.id));
  assert.equal(kept[0].ciState, "running");

  // CI finishes: the report is posted behind the hold (saved there), the backstop cleared
  // with it, and the release delivers it: the agent's one wake, with the result.
  env.later(4);
  finish(env, w.run);
  await env.watchdog.tick();
  const [report, ...more] = helperComments(env.db, issue);
  assert.equal(more.length, 0);
  assert.match(report.body, /finished/);
  assert.match(report.body, /The Helper's backstop monitor for this run was cleared\./);
  assert.equal(env.db.resolutions.length, 1);
  assert.equal(env.db.resolutions[0].body.executionReconciliation.runId, runId);
  assert.equal(env.db.resolutions[0].body.executionReconciliation.actionOutcome, "not_performed");
  assert.equal(issue.executionBlocker, null);
  assert.equal(issue.status, "todo", "nothing to wait on any more: no backstop put back");
  assert.equal(issue.executionPolicy?.monitor ?? null, null);
  assert.equal(env.db.interrupts.length, 1, "the saved report delivered");
  assert.equal(wakesOf(env, w).length, 1, "exactly one wake, carrying the result");
  assert.ok(!env.state.nudges.has(`ci-backstop:${issue.id}`));
  assert.equal([...env.state.nudges.entries()].filter(([k]) => k.startsWith("unstarted-follow-up:")).length, 0, "no follow-up on top");
  const note = env.logs.find((l) => l.msg === "watchdog: a note for the board" && /released it/.test(l.text));
  assert.match(note.text, /It waited for the CI run the agent was waiting on \(30498202022\) to finish, and posted its report behind the hold, so the release wakes the agent once, with the result\./);
  assert.equal(note.ciReport, true);

  // Nothing more from the watchdog afterwards.
  for (let i = 0; i < 2; i += 1) {
    env.later(4);
    await env.watchdog.tick();
  }
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.equal(env.db.resolutions.length, 1);
});

test("a held issue a comment reopened to todo still waits on CI: the record outlives the cleared monitor", async (t) => {
  const env = await watchdogEnv(t);
  env.db.simulateWakes = true;
  const w = waitingOnCi(env);
  const { issue } = w;
  await env.watchdog.tick();
  holdBehindSuppressedRepair(env, w, { clear: true });
  issue.status = "todo"; // a board comment's reopen; Paperclip cleared the monitor
  env.later(4);
  await env.watchdog.tick();
  env.later(4);
  await env.watchdog.tick();
  assert.equal((env.db.resolutions ?? []).length, 0);
  assert.ok(env.state.nudges.has(`ci-backstop:${issue.id}`), "kept for the release to know the wait");
  assert.equal(monitorPatches(env.db, issue).length, 1, "nothing put back on a held issue");
  assert.equal(wakesOf(env, w).length, 0);

  env.later(4);
  finish(env, w.run, "failure");
  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1);
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.match(helperComments(env.db, issue)[0].body, /failure|failed/i);
  assert.equal(wakesOf(env, w).length, 1);
});

test("a hold behind a repair suppressed at dispatch (7's: prepared, never invoked) is kept while CI runs and released with the report", async (t) => {
  const env = await watchdogEnv(t);
  env.db.simulateWakes = true;
  const w = waitingOnCi(env);
  const { carla, issue } = w;
  await env.watchdog.tick();
  // Paperclip claimed and prepared the repair, then its dispatch check found the backstop
  // (durable_wait) and cancelled it: a start time, no process, no usage.
  const runId = uuid();
  const finishedAt = minutesAgo(5);
  env.db.heartbeatRuns.push({
    id: runId, companyId: ids.company, agentId: carla.id, status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", runtimeMode: "legacy",
    error: "Disposition repair suppressed: durable_wait", createdAt: minutesAgo(6), startedAt: minutesAgo(6), finishedAt, processPid: null, processGroupId: null,
    executionStage: "dispatching", usageJson: null, resultJson: {}, contextSnapshot: { issueId: issue.id },
  });
  env.db.issueRuns[issue.id].unshift({ runId, agentId: carla.id, status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", createdAt: minutesAgo(6), startedAt: minutesAgo(6), finishedAt });
  issue.status = "blocked";
  issue.executionBlocker = { recoveryActionId: uuid(), runId, agentId: carla.id, cause: "legacy_execution_requires_reconciliation", runStatus: "cancelled", savedMessageCount: 0 };
  issue.updatedAt = minutesAgo(5);

  for (let i = 0; i < 2; i += 1) {
    env.later(4);
    await env.watchdog.tick();
  }
  assert.equal((env.db.resolutions ?? []).length, 0);
  assert.equal(wakesOf(env, w).length, 0);
  assert.equal(keptLines(env).length, 1);
  assert.equal(keptLines(env)[0].rule, "7");

  env.later(4);
  finish(env, w.run);
  await env.watchdog.tick();
  assert.equal(env.db.resolutions.length, 1);
  assert.equal(env.db.resolutions[0].body.executionReconciliation.actionOutcome, "mixed");
  assert.equal(helperComments(env.db, issue).length, 1, "the report, and no 'continue' nudge on top");
  assert.equal(wakesOf(env, w).length, 1);
  const released = env.logs.find((l) => l.msg === "watchdog: released a hold Paperclip couldn't release by itself");
  assert.equal(released.ciReport, "delivered with the release");
});

test("the blockers-resolved nudge leaves an issue held for recovery, or waiting on CI, alone, and says why once", async (t) => {
  const env = await watchdogEnv(t);
  env.db.simulateWakes = true;
  const w = waitingOnCi(env);
  const { issue } = w;
  await env.watchdog.tick();
  holdBehindSuppressedRepair(env, w);
  // Its old blocker links are done, but they aren't why it is blocked.
  issue.blockedBy = [{ id: uuid(), identifier: "ACM-170", status: "done" }, { id: uuid(), identifier: "ACM-171", status: "done" }];
  env.db.blockerDiagnostics[issue.id] = { readiness: { allBlockersDone: true }, blockers: issue.blockedBy };
  issue.updatedAt = minutesAgo(10);
  for (let i = 0; i < 3; i += 1) {
    env.later(4);
    await env.watchdog.tick();
  }
  assert.equal(helperComments(env.db, issue).length, 0, "no 'every blocker on this issue is done' comment");
  assert.equal(issue.status, "blocked", "not reopened");
  assert.deepEqual(issue.executionPolicy.monitor.notes.startsWith(BACKSTOP_MARK), true, "the backstop not cleared by a reopen");
  const skipped = env.logs.filter((l) => l.msg === "watchdog: no blockers-resolved nudge: the issue is held for recovery, not by its blockers");
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0].blockersDone, ["ACM-170", "ACM-171"]);
  assert.equal(skipped[0].rule, "2");
});

// ---------------------------------------------------------------- a finished run the agent never read

test("stillWaitsOn: a comment that still waits on the run, by id, by URL or as CI, and not one past it", () => {
  const run = { id: 30498202022 };
  assert.ok(stillWaitsOn("The issue stays assigned to me and I am waiting on run 30498202022.", run));
  assert.ok(stillWaitsOn(`Still waiting for ${RUN_URL} to finish.`, run));
  assert.ok(stillWaitsOn("No change: still waiting on CI.", run), "no run named, but CI");
  assert.ok(stillWaitsOn("Blocked on run 30498202022.", run));
  assert.ok(stillWaitsOn("Awaiting the checks before resubmitting.", run));
  assert.ok(!stillWaitsOn("CI run 30498202022 passed, submitting.", run), "a result: it read the run");
  assert.ok(!stillWaitsOn("Run 30498202022 failed on lint; fixing.", run));
  assert.ok(!stillWaitsOn("Fixed the failure in run 30498202022; waiting on run 30498300001.", run), "it waits on a newer run");
  assert.ok(!stillWaitsOn("No longer waiting on run 30498202022: it failed.", run));
  assert.ok(!stillWaitsOn("Waiting on the vendor's sandbox.", run), "another wait");
  assert.ok(!stillWaitsOn("", run));
});

test("sawRun: a later run or comment means the agent saw the result, unless all it said since still waits", () => {
  const run = { id: 30498202022 };
  const done = 1_000;
  const waiting = { at: 1_500, body: "Still waiting on run 30498202022." };
  const read = { at: 1_600, body: "Run 30498202022 failed; fixing the test." };
  assert.equal(sawRun([], run, done, null), null, "nothing since: not seen");
  assert.equal(sawRun([{ at: 500, body: "Waiting on run 30498202022." }], run, done, null), null, "said before it finished");
  assert.equal(sawRun([waiting], run, done, null), null, "only still waiting since");
  assert.equal(sawRun([read, waiting], run, done, null), "commented");
  assert.equal(sawRun([], run, done, 1_200), "ran", "a run since, nothing said: it could read CI");
  assert.equal(sawRun([waiting], run, done, 1_200), null, "a run since that only said it still waits");
  assert.equal(sawRun([waiting], run, done, 1_550), "ran", "what it said before its latest run doesn't count");
});

// The agent's run that started before the run finished (a disposition repair, say)
// posts after it finished that it is still waiting on that very run.
function repairStillWaiting(env, w, { startedMin = 3, commentMin = 1 } = {}) {
  const at = (min) => new Date(env.clock.now - min * 60_000).toISOString();
  env.db.issueRuns[w.issue.id].unshift({ runId: uuid(), agentId: w.carla.id, status: "succeeded", createdAt: at(startedMin), startedAt: at(startedMin), finishedAt: at(commentMin) });
  env.db.comments.push({
    issueId: w.issue.id, authorAgentId: w.carla.id, createdAt: at(commentMin),
    body: `Recording the disposition: the Helper's backstop is in place, the issue stays assigned to me, and I am waiting on run ${w.run.id}.`,
  });
  w.issue.updatedAt = at(commentMin);
}

test("a comment after the run finished that still waits on it doesn't count as seen: reported within a stall window", async (t) => {
  const env = await watchdogEnv(t);
  const w = waitingOnCi(env);
  await env.watchdog.tick();
  assert.equal(w.issue.executionState.monitor.status, "scheduled");

  env.later(2);
  finish(env, w.run, "failure");
  w.run.jobs = [{ name: "e2e (windows)", conclusion: "failure" }];
  env.later(5);
  repairStillWaiting(env, w, { startedMin: 6, commentMin: 1 });
  env.later(3); // the issue quiet for a stall window
  await env.watchdog.tick();
  const [report, ...more] = helperComments(env.db, w.issue);
  assert.equal(more.length, 0);
  assert.ok(report, "reported, not left to the backstop hours later");
  assert.match(report.body, /\*\*failure\*\*/);
  assert.equal(w.issue.executionState.monitor.status, "cleared", "the backstop cleared with it");
});

test("a run started after the finish that only says it still waits doesn't count as seen either", async (t) => {
  const env = await watchdogEnv(t);
  const w = waitingOnCi(env);
  await env.watchdog.tick();
  env.later(2);
  finish(env, w.run, "failure");
  env.later(5);
  repairStillWaiting(env, w, { startedMin: 3, commentMin: 1 });
  env.later(3);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, w.issue).length, 1);
});

test("an agent that saw the run (ran since and said so, or wrote its result) isn't told, and its backstop isn't touched", async (t) => {
  for (const [startedMin, body] of [[3, "Run 30498202022 failed on lint; pushing a fix."], [null, "CI run 30498202022 failed; looking into it."]]) {
    const env = await watchdogEnv(t);
    const w = waitingOnCi(env);
    await env.watchdog.tick();
    const scheduled = w.issue.executionPolicy.monitor;
    env.later(2);
    finish(env, w.run, "failure");
    env.later(5);
    const at = (min) => new Date(env.clock.now - min * 60_000).toISOString();
    if (startedMin) env.db.issueRuns[w.issue.id].unshift({ runId: uuid(), agentId: w.carla.id, status: "succeeded", createdAt: at(startedMin), startedAt: at(startedMin), finishedAt: at(1) });
    env.db.comments.push({ issueId: w.issue.id, authorAgentId: w.carla.id, createdAt: at(1), body });
    w.issue.updatedAt = at(1);
    env.later(3);
    await env.watchdog.tick();
    assert.equal(helperComments(env.db, w.issue).length, 0);
    assert.deepEqual(w.issue.executionPolicy.monitor, scheduled, "seen: the backstop stays where it was");
    assert.ok(!env.logs.some((l) => /brought the CI backstop forward/.test(l.msg)));
    assert.ok(env.logs.some((l) => l.reason === (startedMin ? "the agent has run on the issue since it finished" : "the agent commented after it finished")));
  }
});

test("an issue whose recorded execution run never started is still checked: reported, and said at debug level", async (t) => {
  const env = await watchdogEnv(t);
  const w = waitingOnCi(env);
  await env.watchdog.tick();
  env.later(2);
  finish(env, w.run, "failure");
  // Another agent's automation run, queued on the issue and cancelled at dispatch, left recorded.
  const gilfoyle = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
  env.db.agents.push(gilfoyle);
  const cancelled = { runId: uuid(), agentId: gilfoyle.id, status: "cancelled", errorCode: "issue_assignee_changed", createdAt: minutesAgo(1), startedAt: null, finishedAt: minutesAgo(1) };
  env.db.issueRuns[w.issue.id].unshift(cancelled);
  w.issue.executionRunId = cancelled.runId;
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, w.issue).length, 1);
  const said = env.logs.filter((l) => l.msg === "watchdog: the issue's recorded run isn't going; its CI run is checked anyway");
  assert.equal(said.length, 1);
  assert.equal(said[0].field, "executionRunId");
  assert.equal(said[0].status, "cancelled");
});

test("a finished run left unreported brings the backstop forward to a stall window, once", async (t) => {
  const env = await watchdogEnv(t);
  const w = waitingOnCi(env);
  await env.watchdog.tick();
  const hoursOut = Date.parse(w.issue.executionState.monitor.nextCheckAt);
  env.later(2);
  finish(env, w.run, "failure");
  // A wake for Carla deferred ever since, which holds the report back.
  env.db.wakes[w.issue.id] = [{ kind: "wake_request", agentId: w.carla.id, status: "deferred_issue_execution", reason: "issue_commented", requestedAt: new Date(env.clock.now).toISOString() }];
  env.later(5);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, w.issue).length, 0);
  const [, pulled, ...more] = monitorPatches(env.db, w.issue);
  assert.equal(more.length, 0);
  const m = pulled.body.executionPolicy.monitor;
  assert.equal(Date.parse(m.nextCheckAt), env.clock.now + 180_000, "one stall window from now");
  assert.ok(Date.parse(m.nextCheckAt) < hoursOut);
  assert.ok(Date.parse(m.timeoutAt) > Date.parse(m.nextCheckAt));
  assert.ok(m.notes.startsWith(BACKSTOP_MARK) && m.notes.includes(RUN_URL), "still the Helper's backstop for the run");
  assert.notEqual(m.externalRef, "[redacted]");
  assert.deepEqual(pulled.body.executionPolicy.stages, w.stages);
  assert.equal(pulled.body.comment, undefined, "no comment: that would wake the agent");
  const line = env.logs.find((l) => l.msg === "watchdog: brought the CI backstop forward: the run it watches finished and isn't reported");
  assert.equal(line.reason, "a wake for the agent is waiting to start");
  assert.equal(env.state.nudges.get(`ci-backstop:${w.issue.id}`).pulled, true);
  assert.equal(env.watchdog.stats.ciBackstopsPulled, 1);

  // The next scan, still held back: due within the stall window already, so left be.
  env.later(3);
  await env.watchdog.tick();
  assert.equal(monitorPatches(env.db, w.issue).length, 2, "already due soon: not moved again");
  assert.equal(env.watchdog.stats.ciBackstopsPulled, 1);
});

test("the backstop is brought forward past another agent's queued run, not past the assignee's own", async (t) => {
  for (const own of [false, true]) {
    const env = await watchdogEnv(t);
    const w = waitingOnCi(env);
    await env.watchdog.tick();
    env.later(2);
    finish(env, w.run);
    const other = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
    env.db.agents.push(other);
    env.db.issueRuns[w.issue.id].unshift({ runId: uuid(), agentId: own ? w.carla.id : other.id, status: "queued", createdAt: minutesAgo(1) });
    env.later(5);
    await env.watchdog.tick();
    assert.equal(helperComments(env.db, w.issue).length, 0);
    assert.equal(monitorPatches(env.db, w.issue).length, own ? 1 : 2, own ? "its own run will see the result" : "another agent's run won't");
  }
});

test("a backstop isn't brought forward for a run still going, and a dry run only says it would", async (t) => {
  // Still going: never, however long.
  const going = await watchdogEnv(t);
  const a = waitingOnCi(going);
  await going.watchdog.tick();
  going.db.wakes[a.issue.id] = [{ kind: "wake_request", agentId: a.carla.id, status: "deferred_issue_execution", requestedAt: new Date(going.clock.now).toISOString() }];
  for (let i = 0; i < 3; i += 1) {
    going.later(10);
    await going.watchdog.tick();
  }
  assert.equal(monitorPatches(going.db, a.issue).length, 1);

  // A dry run says what it would do, once.
  const dry = await watchdogEnv(t, { DRY_RUN: "true" });
  const b = waitingOnCi(dry);
  const m = backstopMonitor({ run: b.run, now: dry.clock.now, backstopMs: 360 * 60_000 });
  b.issue.executionPolicy = { ...b.issue.executionPolicy, monitor: { ...m, externalRef: "[redacted]", scheduledBy: "board" } };
  b.issue.executionState = { monitor: { status: "scheduled", ...m, scheduledBy: "board", attemptCount: 0 } };
  finish(dry, b.run);
  dry.db.wakes[b.issue.id] = [{ kind: "wake_request", agentId: b.carla.id, status: "deferred_issue_execution", requestedAt: new Date(dry.clock.now).toISOString() }];
  for (let i = 0; i < 2; i += 1) {
    dry.later(10);
    await dry.watchdog.tick();
  }
  assert.equal(dry.db.patches.length, 0);
  assert.equal(dry.logs.filter((l) => l.msg === "watchdog: would bring the CI backstop forward (dry run)").length, 1);
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
    ciRun: "org/app#30498202022", ciBackstop: { nextCheckAt: "2026-10-30T15:00:00.000Z" },
  });
  assert.match(waiting.what, /The Helper's backstop monitor holds the wait \(next check 2026-10-30T15:00:00.000Z\)/);
});

test("pch why: a hold on an issue waiting on CI says the watchdog keeps it until the run finishes", () => {
  const held = advise({
    identifier: "ACM-192", issue: { status: "blocked", assigneeAgentId: "a", executionBlocker: { cause: "legacy_execution_requires_reconciliation" } },
    assignee: { name: "Carla", status: "idle" },
    unstartedHold: { ownerName: "Carla", runId: "1a2b3c4d-0000", errorCode: "issue_disposition_repair_superseded", problems: [] },
    ciRun: "org/app#30498202022", ciBackstop: { nextCheckAt: "2026-10-30T15:00:00.000Z" },
  });
  assert.equal(held.watchdog, "auto");
  assert.match(held.what, /The agent is waiting on CI under the Helper's backstop, so the watchdog keeps the hold until that run finishes/);
  assert.match(held.autoNote, /once the CI run has finished \(WATCHDOG_RELEASE_HOLDS\), with the run's report as the saved message/);
});
