// Watchdog 11–14: CI runs agents wait on, answers that reach nobody, reviews
// escalated by the review-round limit, and cancelled blockers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { ciMessage, monitorPending, onlyFlaky, runRefs, waitingOn, waitingText } from "../src/ci-runs.mjs";
import { answerText, escalatedReview } from "../src/board-held.mjs";

async function watchdogEnv(t, extra = {}, { github = true } = {}) {
  const gh = github ? await startFakeGitHub() : null;
  if (gh) t.after(gh.close);
  const clock = { now: Date.now() };
  const ghEnv = gh ? { GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, GITHUB_REPOS: "org/app" } : {};
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...ghEnv, ...extra }, now: () => clock.now });
  t.after(env.close);
  return { ...env, gh, clock, watchdog: createWatchdog(env.ctx, env.state), later: (min) => (clock.now += min * 60_000) };
}

const agent = (db, name, status = "idle") => {
  const a = { id: uuid(), companyId: ids.company, name, status };
  db.agents.push(a);
  return a;
};

// ---------------------------------------------------------------- 11. pure helpers

test("runRefs finds runs by URL or by a run id, never a PR or issue number", () => {
  assert.deepEqual(runRefs("Waiting on https://github.com/Org/App/actions/runs/39498202022/job/123 to finish"), [
    { repo: "org/app", id: "39498202022" },
  ]);
  assert.deepEqual(runRefs("Blocked on a board re-run of CI run 39343878299 (attempt 2)."), [{ repo: null, id: "39343878299" }]);
  assert.deepEqual(runRefs("waiting on run #39517675740; monitor 12 attempts"), [{ repo: null, id: "39517675740" }]);
  assert.deepEqual(runRefs("PR #204 for DIR-448, see issue 1234567890 and commit 39517675740"), []);
  assert.equal(runRefs("run 111111111 run 222222222 run 333333333 run 444444444").length, 3, "at most three");
});

test("waitingText reads the agent's latest comment and its monitor's notes", () => {
  const comments = [
    { authorUserId: "u", body: "board says hi" },
    { authorAgentId: "a1", body: "waiting on run 39498202022" },
    { authorAgentId: "a1", body: "older: run 11111111111" },
  ];
  assert.deepEqual(runRefs(waitingText(comments, "a1", null)), [{ repo: null, id: "39498202022" }]);
  assert.deepEqual(runRefs(waitingText([], "a1", { notes: "poll run 39496790108" })), [{ repo: null, id: "39496790108" }]);
});

test("a scheduled monitor still to act is left to Paperclip; a triggered, cleared or overdue one isn't", () => {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const scheduled = { status: "scheduled", nextCheckAt: iso(60_000), timeoutAt: iso(3_600_000), attemptCount: 3, maxAttempts: 12 };
  assert.equal(monitorPending(scheduled, now), true, "a check still to come");
  assert.equal(monitorPending({ ...scheduled, nextCheckAt: iso(-30_000) }, now), true, "just due: Paperclip fires it within seconds");
  assert.equal(monitorPending({ ...scheduled, nextCheckAt: iso(-10 * 60_000) }, now), false, "long overdue: it isn't firing");
  assert.equal(monitorPending({ ...scheduled, nextCheckAt: null }, now), false, "no next check");
  // Past its timeout or out of attempts, Paperclip clears it at its next check and,
  // under the default recovery policy, wakes the agent: still pending. The other
  // policies tell the board instead.
  assert.equal(monitorPending({ ...scheduled, timeoutAt: iso(-1000) }, now), true, "timed out, wake_owner by default");
  assert.equal(monitorPending({ ...scheduled, attemptCount: 12 }, now), true, "attempts used up, wake_owner by default");
  assert.equal(monitorPending({ ...scheduled, timeoutAt: iso(-1000), recoveryPolicy: "escalate_to_board" }, now), false);
  assert.equal(monitorPending({ ...scheduled, attemptCount: 12, recoveryPolicy: "create_recovery_issue" }, now), false);
  assert.equal(monitorPending({ ...scheduled, recoveryPolicy: "escalate_to_board" }, now), true, "within its limits it fires");
  // What a monitor looks like once it has fired: it waits for the agent to schedule it again.
  assert.equal(monitorPending({ status: "triggered", nextCheckAt: null, timeoutAt: iso(-60_000), attemptCount: 12, maxAttempts: 12 }, now), false);
  assert.equal(monitorPending({ status: "triggered", nextCheckAt: null, timeoutAt: iso(60_000), attemptCount: 1, maxAttempts: 12 }, now), false);
  assert.equal(monitorPending({ ...scheduled, status: "cleared" }, now), false);
  assert.equal(monitorPending(null, now), false);
});

test("a dispatched run that ends without a verdict says so, not that something broke", () => {
  const run = { id: 7, name: "verify", head_branch: "main", conclusion: "cancelled", updated_at: "2026-10-21T01:44:00Z" };
  const text = ciMessage({ run, jobs: [] });
  assert.match(text, /\*\*cancelled\*\*/);
  assert.match(text, /gave no verdict/);
  assert.doesNotMatch(text, /fix what your change broke/);
});

test("when the agent's latest comment names no run, its latest one that does counts", () => {
  const comments = [
    { authorAgentId: "a1", body: "Cleared a finished dependency; still waiting on CI.", createdAt: "2026-10-21T13:10:08Z" },
    { authorUserId: "u", body: "run 22222222222 from someone else" },
    { authorAgentId: "a1", body: "Blocked on [the Windows job](https://github.com/org/app/actions/runs/39498202022/job/1).", createdAt: "2026-10-21T13:09:25Z" },
    { authorAgentId: "a1", body: "older: run 11111111111", createdAt: "2026-10-21T12:00:00Z" },
  ];
  const said = waitingOn(comments, "a1", null);
  assert.deepEqual(runRefs(said.text), [{ repo: "org/app", id: "39498202022" }]);
  assert.equal(said.saidAt, "2026-10-21T13:10:08Z", "when the agent last spoke is still its latest comment");
});

test("only runs whose failed jobs are all known flaky are re-run", () => {
  const p = /windows/i;
  const job = (name, conclusion) => ({ name, conclusion });
  assert.equal(onlyFlaky([job("e2e (windows)", "failure"), job("ci-gate", "skipped"), job("unit", "success")], p), true);
  assert.equal(onlyFlaky([job("e2e (windows)", "failure"), job("unit", "failure")], p), false);
  assert.equal(onlyFlaky([job("unit", "success")], p), false, "nothing failed");
  assert.equal(onlyFlaky([job("e2e (windows)", "failure")], null), false, "no pattern, no re-run");
});

test("the CI message names the run, its result and the failed jobs", () => {
  const run = { id: 7, name: "ci", run_attempt: 2, head_branch: "acm-1", head_sha: "b61d07a91abc", conclusion: "failure", updated_at: "2026-10-21T01:44:00Z", html_url: "https://github.com/org/app/actions/runs/7" };
  const text = ciMessage({ run, jobs: [{ name: "dotnet (windows)", conclusion: "failure" }], reruns: 1 });
  assert.match(text, /ci run 7 \(attempt 2\) on `acm-1` at `b61d07a91`/);
  assert.match(text, /\*\*failure\*\*/);
  assert.match(text, /Failed jobs: `dotnet \(windows\)`/);
  assert.match(text, /re-ran its failed jobs once/);
  assert.doesNotMatch(text, /\/pull\//, "never a PR URL: Paperclip would link it to the issue");
});

// ---------------------------------------------------------------- 11. CI runs, end to end

// Carla pushed, said she waits on run 39498202022, and stopped. The run finished
// 30 minutes ago; her last run on the issue ended before that.
function waitingOnCi(env, { conclusion = "success", finishedMin = 30, comment = "Pushed b61d07a9. Waiting on run 39498202022 before resubmitting.", status = "blocked" } = {}) {
  const carla = agent(env.db, "Carla");
  const issue = { id: uuid(), identifier: "ACM-192", companyId: ids.company, status, assigneeAgentId: carla.id, updatedAt: minutesAgo(60) };
  env.db.issues.push(issue);
  env.db.comments.push({ issueId: issue.id, identifier: issue.identifier, body: comment, authorAgentId: carla.id, createdAt: minutesAgo(60) });
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(70), startedAt: minutesAgo(70), finishedAt: minutesAgo(60) }];
  const run = {
    id: 39498202022,
    name: "ci",
    status: "completed",
    conclusion,
    run_attempt: 1,
    head_branch: "acm-192",
    head_sha: "b61d07a91",
    updated_at: minutesAgo(finishedMin),
    html_url: "https://github.com/org/app/actions/runs/39498202022",
    pull_requests: [{ number: 188 }],
    jobs: conclusion === "success" ? [] : [{ name: "e2e (windows)", conclusion: "failure" }, { name: "ci-gate", conclusion: "failure" }],
  };
  env.gh.runs["org/app"] = { [run.id]: run };
  return { carla, issue, run };
}

const helperComments = (db, issue) => db.comments.filter((c) => c.issueId === issue.id && !c.authorAgentId);

test("a finished run the agent waits on is reported on its issue, once", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env);
  await env.watchdog.tick();
  const posted = helperComments(env.db, issue);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.startsWith(`[@Carla](agent://${carla.id}) the CI run you were waiting on has finished`));
  assert.match(posted[0].body, /\*\*success\*\*/);
  assert.match(posted[0].body, /_Paperclip Helper watchdog, nudge 1\/2\._$/);
  assert.equal(env.watchdog.stats.ciReports, 1);

  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "once per run attempt");
});

test("nothing is said while the run is going, before the stall window, or once the agent has run since", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue, run } = waitingOnCi(env, { finishedMin: 1 });
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0, "finished a minute ago: the agent's own monitor may still see it");

  run.status = "in_progress";
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0, "still running");

  run.status = "completed";
  env.db.issueRuns[issue.id].unshift({ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: new Date(env.clock.now - 60_000).toISOString(), startedAt: new Date(env.clock.now - 60_000).toISOString() });
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0, "the agent ran after the run finished: it has seen it");
});

test("a run someone re-runs by hand is reported again once its new attempt finishes", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, run } = waitingOnCi(env, { conclusion: "failure" });
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  Object.assign(run, { status: "in_progress", run_attempt: 2 });
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "attempt 2 is still running");
  Object.assign(run, { status: "completed", conclusion: "success", updated_at: new Date(env.clock.now).toISOString(), jobs: [] });
  env.later(10);
  await env.watchdog.tick();
  const posted = helperComments(env.db, issue);
  assert.equal(posted.length, 2);
  assert.match(posted[1].body, /attempt 2\) .*\*\*success\*\*/s);
});

test("a Paperclip monitor still due to fire is left to do its job", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env);
  issue.executionState = { status: "pending", monitor: { status: "scheduled", nextCheckAt: new Date(env.clock.now + 600_000).toISOString() } };
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0);
});

test("a run named only in a monitor's notes counts too", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env, { comment: "Handing off to the monitor." });
  issue.executionState = { monitor: { status: "triggered", serviceName: "github-actions", notes: "CI run 39498202022 on acm-192" } };
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
});

// The agent named the run, then followed up without repeating it; its monitor
// had used up its attempts and fired for the last time before the run finished.
test("a run named before the agent's latest comment is reported once its monitor has given up", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env, { comment: "Blocked on queued CI: https://github.com/org/app/actions/runs/39498202022/job/1. The monitor's attempts are used up." });
  env.db.comments.find((c) => c.issueId === issue.id).createdAt = minutesAgo(61);
  env.db.comments.push({ issueId: issue.id, body: "Cleared a finished dependency; still waiting on CI. Monitor exhausted.", authorAgentId: carla.id, createdAt: minutesAgo(60) });
  const ago = (min) => new Date(env.clock.now - min * 60_000).toISOString();
  issue.executionState = { monitor: { status: "triggered", notes: null, nextCheckAt: null, timeoutAt: ago(20), attemptCount: 12, maxAttempts: 12 } };
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.match(helperComments(env.db, issue)[0].body, /run 39498202022/);
});

test("a run that finished before the agent's latest comment isn't reported, even when that comment names no run", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env, { comment: "Waiting on run 39498202022." });
  env.db.comments.push({ issueId: issue.id, body: "Saw CI; resubmitting.", authorAgentId: carla.id, createdAt: minutesAgo(20) });
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0);
});

// The monitor fired once; its wake to the agent was never delivered and sat in
// Paperclip's queue while the run finished. A comment would have started a run.
test("a wake that has waited longer than the stall window doesn't silence the report; a fresh one does", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env, { finishedMin: 20 });
  const ago = (min) => new Date(env.clock.now - min * 60_000).toISOString();
  issue.executionState = { monitor: { status: "triggered", nextCheckAt: null, timeoutAt: ago(-60), attemptCount: 1, maxAttempts: 12 } };
  env.db.wakes[issue.id] = [{ kind: "wake_request", agentId: carla.id, status: "queued", reason: "issue_monitor_due", requestedAt: ago(1) }];
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0, "a wake requested a minute ago gets its chance to start");
  assert.equal(env.logs.filter((l) => l.level === "debug" && l.reason === "a wake for the agent is waiting to start").length, 1);

  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "ten minutes on and still waiting: it may never start");
});

test("a wake deferred behind an earlier run still holds the report: a comment would be deferred with it", async (t) => {
  const env = await watchdogEnv(t);
  const { carla, issue } = waitingOnCi(env, { finishedMin: 20 });
  // Requested after the agent's last run (so not stale), deferred ever since.
  env.db.wakes[issue.id] = [{ kind: "wake_request", agentId: carla.id, status: "deferred_issue_execution", reason: "issue_monitor_due", requestedAt: minutesAgo(55) }];
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0);
  assert.ok(env.logs.some((l) => l.reason === "a wake for the agent is waiting to start"));
});

test("why a finished run isn't reported is logged at debug level, once per run and reason", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env, { finishedMin: 1 });
  const quiet = () => env.logs.filter((l) => l.msg === "watchdog: a finished CI run an agent waits on isn't reported");
  await env.watchdog.tick();
  env.later(1); // within the stall window: no new scan
  await env.watchdog.tick();
  assert.equal(quiet().length, 1);
  assert.equal(quiet()[0].reason, "finished less than the stall window ago");
  assert.equal(quiet()[0].issue, issue.identifier);
  issue.executionState = { monitor: { status: "scheduled", nextCheckAt: new Date(env.clock.now + 3_600_000).toISOString() } };
  env.later(10);
  await env.watchdog.tick();
  env.later(10);
  await env.watchdog.tick();
  assert.deepEqual(quiet().map((l) => l.reason), ["finished less than the stall window ago", "the agent's Paperclip monitor will still fire"]);
  // Back to an earlier reason, then the monitor again: each reason is logged once.
  issue.executionState = null;
  env.later(10);
  env.db.wakes[issue.id] = [{ kind: "wake_request", agentId: issue.assigneeAgentId, status: "queued", requestedAt: new Date(env.clock.now).toISOString() }];
  await env.watchdog.tick();
  env.db.wakes[issue.id] = [];
  issue.executionState = { monitor: { status: "scheduled", nextCheckAt: new Date(env.clock.now + 3_600_000).toISOString() } };
  env.later(10);
  await env.watchdog.tick();
  assert.equal(quiet().length, 3);
  assert.equal(quiet()[2].reason, "a wake for the agent is waiting to start");
  assert.equal(helperComments(env.db, issue).length, 0);
});

test("a token that may not read a repository's runs is warned about once", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env, { comment: "waiting on https://github.com/org/app/actions/runs/39498202022" });
  env.gh.fail["GET run"] = 403;
  await env.watchdog.tick();
  env.later(10);
  await env.watchdog.tick();
  const warned = env.logs.filter((l) => l.level === "warn" && /refused to show a CI run/.test(l.msg));
  assert.equal(warned.length, 1);
  assert.match(warned[0].error, /Actions: read/);
  assert.equal(helperComments(env.db, issue).length, 0);

  delete env.gh.fail["GET run"];
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "reported once the token can read it");
});

test("without a GitHub token the check is off; a run outside GITHUB_REPOS is never read", async (t) => {
  const off = await watchdogEnv(t, {}, { github: false });
  const carla = agent(off.db, "Carla");
  const issue = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "blocked", assigneeAgentId: carla.id, updatedAt: minutesAgo(60) };
  off.db.issues.push(issue);
  off.db.comments.push({ issueId: issue.id, body: "waiting on run 39498202022", authorAgentId: carla.id });
  await off.watchdog.tick();
  assert.equal(helperComments(off.db, issue).length, 0);

  const env = await watchdogEnv(t);
  const { issue: other } = waitingOnCi(env, { comment: "waiting on https://github.com/elsewhere/repo/actions/runs/39498202022" });
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, other).length, 0);
  assert.ok(!env.gh.requests.some((r) => r.path.includes("elsewhere")));
});

test("a dispatched run on the default branch is reported, never re-run", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "windows|^ci-gate$" });
  const { issue, run } = waitingOnCi(env, { conclusion: "failure" });
  env.gh.repos["org/app"] = { default_branch: "trunk" };
  Object.assign(run, { event: "workflow_dispatch", head_branch: "trunk", pull_requests: [] });
  env.gh.branches["org/app"] = { trunk: { commit: { sha: run.head_sha } } };

  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.match(helperComments(env.db, issue)[0].body, /\*\*failure\*\*/);
  assert.equal(env.gh.reruns.length, 0);
  assert.equal(env.watchdog.stats.ciReports, 1);
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "once per attempt");
});

test("a dispatched run on the default branch is reported after the branch moved on", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, run } = waitingOnCi(env);
  env.gh.repos["org/app"] = { default_branch: "release/default" };
  Object.assign(run, { event: "workflow_dispatch", head_branch: "release/default", pull_requests: [] });
  env.gh.branches["org/app"] = { "release/default": { commit: { sha: "newer000" } } };

  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.match(helperComments(env.db, issue)[0].body, /\*\*success\*\*/);
  assert.equal(env.gh.reruns.length, 0);
});

test("a cancelled dispatched run on the default branch is reported", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, run } = waitingOnCi(env, { conclusion: "cancelled" });
  env.gh.repos["org/app"] = { default_branch: "main" };
  Object.assign(run, { event: "workflow_dispatch", head_branch: "main", pull_requests: [] });

  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.match(helperComments(env.db, issue)[0].body, /\*\*cancelled\*\*/);
  assert.equal(env.gh.reruns.length, 0);
});

test("runs not dispatched on the default branch keep the head-moved, re-run and cancelled rules", async (t) => {
  for (const [event, branch] of [["push", "main"], ["pull_request", "change"], ["workflow_dispatch", "master"]]) {
    await t.test(`${event} on ${branch}`, async (t) => {
      for (const scenario of ["moved", "flaky", "cancelled"]) {
        await t.test(scenario, async (t) => {
          const env = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "windows|^ci-gate$" });
          const { issue, run } = waitingOnCi(env, { conclusion: scenario === "cancelled" ? "cancelled" : "failure" });
          env.gh.repos["org/app"] = { default_branch: "main" };
          Object.assign(run, { event, head_branch: branch, pull_requests: event === "pull_request" ? [{ number: 188 }] : [] });
          const sha = scenario === "moved" ? "newer000" : run.head_sha;
          env.gh.branches["org/app"] = { [branch]: { commit: { sha } } };
          env.gh.pulls["org/app"] = [{ number: 188, state: "open", head: { sha }, base: { ref: "main" } }];

          await env.watchdog.tick();
          assert.equal(helperComments(env.db, issue).length, 0);
          assert.equal(env.gh.reruns.length, scenario === "flaky" ? 1 : 0);
        });
      }
    });
  }
});

test("the default branch is read once per repository; while GitHub won't say, a dispatched run waits, never re-run", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "windows|^ci-gate$" });
  const { issue, run } = waitingOnCi(env, { conclusion: "failure" });
  Object.assign(run, { event: "workflow_dispatch", head_branch: "main", pull_requests: [] });
  env.gh.branches["org/app"] = { main: { commit: { sha: run.head_sha } } };
  env.gh.fail["GET repo"] = 403;
  const repoReads = () => env.gh.requests.filter((r) => r.method === "GET" && r.path === "/repos/org/app").length;
  const warned = () => env.logs.filter((l) => l.level === "warn" && /default branch/.test(l.msg));

  await env.watchdog.tick();
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0, "not reported while the default branch is unknown");
  assert.equal(env.gh.reruns.length, 0, "and never re-run meanwhile");
  assert.equal(warned().length, 1, "warned once, not every scan");
  assert.match(warned()[0].error, /Metadata: read/);

  delete env.gh.fail["GET repo"];
  env.gh.repos["org/app"] = { default_branch: "main" };
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "reported once GitHub answers");
  assert.equal(env.gh.reruns.length, 0);
  const reads = repoReads();

  // A second attempt finishing within the hour uses the branch already read.
  Object.assign(run, { run_attempt: 2, updated_at: new Date(env.clock.now).toISOString() });
  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 2);
  assert.equal(repoReads(), reads, "the default branch is kept for the hour");
});

test("known flaky jobs are re-run first, then the passing attempt is reported", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "\\(windows\\)|^ci-gate$" });
  const { issue, run } = waitingOnCi(env, { conclusion: "failure" });
  env.gh.pulls["org/app"] = [{ number: 188, state: "open", head: { sha: "b61d07a91" }, base: { ref: "main" } }];
  run.onRerun = (r) => Object.assign(r, { status: "queued", run_attempt: 2 });

  await env.watchdog.tick();
  assert.deepEqual(env.gh.reruns, [{ repo: "org/app", id: "39498202022" }]);
  assert.equal(helperComments(env.db, issue).length, 0, "no comment for the re-run itself");
  assert.equal(env.watchdog.stats.ciReruns, 1);

  Object.assign(run, { status: "completed", conclusion: "success", updated_at: new Date(env.clock.now + 60_000).toISOString(), jobs: [] });
  env.later(10);
  await env.watchdog.tick();
  const posted = helperComments(env.db, issue);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /attempt 2/);
  assert.match(posted[0].body, /re-ran its failed jobs once/);
});

test("a real failure is reported, not re-run; a run whose PR has moved on is neither", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "windows", WATCHDOG_CI_RERUN_MAX: "1" });
  const { issue, run } = waitingOnCi(env, { conclusion: "failure" });
  run.jobs = [{ name: "e2e (windows)", conclusion: "failure" }, { name: "unit", conclusion: "failure" }];
  await env.watchdog.tick();
  assert.equal(env.gh.reruns.length, 0, "unit failed too: not a flake");
  assert.match(helperComments(env.db, issue)[0].body, /Failed jobs: `e2e \(windows\)`, `unit`/);

  const env2 = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "windows" });
  const { issue: moved, run: run2 } = waitingOnCi(env2, { conclusion: "failure" });
  run2.jobs = [{ name: "e2e (windows)", conclusion: "failure" }];
  env2.gh.pulls["org/app"] = [{ number: 188, state: "open", head: { sha: "newer000" }, base: { ref: "main" } }];
  await env2.watchdog.tick();
  assert.equal(env2.gh.reruns.length, 0, "the agent pushed since: its new head runs CI anyway");
  assert.equal(helperComments(env2.db, moved).length, 0, "nor reported: the new push's run is what counts");
});

test("a re-run GitHub refuses is reported instead, once", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_CI_RERUN_JOBS: "windows" });
  const { issue, run } = waitingOnCi(env, { conclusion: "failure" });
  run.jobs = [{ name: "e2e (windows)", conclusion: "failure" }];
  env.gh.pulls["org/app"] = [{ number: 188, state: "open", head: { sha: "b61d07a91" }, base: { ref: "main" } }];
  env.gh.fail["POST rerun"] = 403;
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1);
  assert.ok(env.logs.some((l) => l.msg.startsWith("watchdog: GitHub refused to re-run") && /Actions: read and write/.test(l.error)));
  env.later(10);
  await env.watchdog.tick();
  assert.equal(env.gh.reruns.length, 0);
  assert.equal(env.gh.requests.filter((r) => r.method === "POST").length, 1, "not tried again");
});

// ---------------------------------------------------------------- 12. answers that reach nobody

// ACM-672 waits on the operator's approval; Carla (its implementer) asked for a
// Windows report with a card, which the operator answered after it reached them.
function answeredOnReview(env, { answeredMin = 40, agentRanSince = false } = {}) {
  const carla = agent(env.db, "Carla");
  const issue = {
    id: uuid(),
    identifier: "ACM-672",
    companyId: ids.company,
    status: "in_review",
    assigneeUserId: ids.user,
    assigneeAgentId: null,
    updatedAt: minutesAgo(answeredMin),
    executionState: {
      status: "pending",
      currentStageType: "approval",
      currentParticipant: { type: "user", userId: ids.user },
      returnAssignee: { type: "agent", agentId: carla.id },
    },
  };
  env.db.issues.push(issue);
  const card = {
    id: uuid(),
    kind: "ask_user_questions",
    status: "answered",
    createdByAgentId: carla.id,
    addresseeUserId: ids.user,
    resolvedByUserId: ids.user,
    resolvedAt: minutesAgo(answeredMin),
    createdAt: minutesAgo(600),
    payload: { questions: [{ id: "q1", prompt: "Paste the elevated Windows run's verifier line", options: [{ id: "o1", label: "GREEN" }, { id: "o2", label: "RED" }] }] },
    result: { version: 1, answers: [{ questionId: "q1", optionIds: ["o1"], otherText: "69/0/0 at 2bfde26" }] },
  };
  env.db.interactions[issue.id] = [card];
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(700), startedAt: minutesAgo(700) }];
  if (agentRanSince) env.db.issueRuns[issue.id].unshift({ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(5), startedAt: minutesAgo(5) });
  return { carla, issue, card };
}

test("an answer given while the issue waited on your review goes back to the agent that asked, once", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  const { carla, issue } = answeredOnReview(env);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  const { body } = env.db.patches[0];
  assert.equal(body.status, "in_progress", "your 'changes requested' decision: Paperclip returns it to returnAssignee");
  assert.ok(body.comment.startsWith(`[@Carla](agent://${carla.id}) your card on this issue ("Paste the elevated Windows run's verifier line") was answered`));
  assert.match(body.comment, /> Paste the elevated Windows run's verifier line: GREEN; 69\/0\/0 at 2bfde26/);
  assert.match(body.comment, /_Paperclip Helper watchdog\._$/);
  assert.equal(env.watchdog.stats.returned, 1);

  issue.status = "in_review"; // say it came straight back
  env.later(10);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1, "once per card");
});

test("an answer the agent has run since, a fresh one, or one on an issue not waiting on you is left alone", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  answeredOnReview(env, { agentRanSince: true });
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0, "the agent ran after the answer");

  const env2 = await watchdogEnv(t, {}, { github: false });
  answeredOnReview(env2, { answeredMin: 1 });
  await env2.watchdog.tick();
  assert.equal(env2.db.patches.length, 0, "answered a minute ago");

  const env3 = await watchdogEnv(t, {}, { github: false });
  const { issue } = answeredOnReview(env3);
  issue.executionState.currentParticipant = { type: "user", userId: "someone-else" };
  issue.assigneeUserId = "someone-else";
  await env3.watchdog.tick();
  assert.equal(env3.db.patches.length, 0, "only the participant can decide");

  const env4 = await watchdogEnv(t, { WATCHDOG_DELIVER_ANSWERS: "false" }, { github: false });
  answeredOnReview(env4);
  await env4.watchdog.tick();
  assert.equal(env4.db.patches.length, 0, "turned off");
});

test("answerText renders every kind of answer", () => {
  assert.equal(answerText({ status: "accepted", result: { outcome: "accepted", reason: "go ahead" } }), "accepted: go ahead");
  assert.equal(answerText({ status: "answered", result: { summaryMarkdown: "**Use Carla.**" } }), "**Use Carla.**");
  assert.equal(answerText({ status: "answered", result: { items: [{ id: "a", verdict: "approve" }] } }), "a: approve");
});

// ---------------------------------------------------------------- 13. escalated reviews

function escalated(env, { pendingCardForYou = false } = {}) {
  const carla = agent(env.db, "Carla");
  const jian = agent(env.db, "Jian-Yang");
  const issue = {
    id: uuid(),
    identifier: "ACM-622",
    companyId: ids.company,
    status: "in_review",
    assigneeUserId: ids.user,
    assigneeAgentId: null,
    updatedAt: minutesAgo(30),
    executionPolicy: { stages: [{ id: "s1", type: "review", participants: [{ type: "agent", agentId: jian.id }] }, { id: "s2", type: "approval", participants: [{ type: "user", userId: ids.user }] }] },
    executionState: {
      status: "pending",
      currentStageId: "s1",
      currentStageType: "review",
      currentParticipant: { type: "user", userId: ids.user },
      returnAssignee: { type: "agent", agentId: carla.id },
      changesRequestedCount: 3,
      lastDecisionId: "d-3",
    },
  };
  env.db.issues.push(issue);
  env.db.comments.push({ issueId: issue.id, body: "Revision 5 still lacks the four proofs.", authorAgentId: jian.id, createdAt: minutesAgo(31) });
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: jian.id, status: "succeeded", createdAt: minutesAgo(35), startedAt: minutesAgo(35) }];
  if (pendingCardForYou) env.db.interactions[issue.id] = [{ id: uuid(), kind: "ask_user_questions", status: "pending", addresseeUserId: ids.user, createdByAgentId: carla.id, createdAt: minutesAgo(40) }];
  return { carla, jian, issue };
}

test("escalatedReview spots Paperclip's review-round escalation and nothing else", () => {
  const issue = {
    status: "in_review",
    executionPolicy: { stages: [{ id: "s1", type: "review", participants: [{ type: "agent", agentId: "j" }] }] },
    executionState: { status: "pending", currentStageId: "s1", currentStageType: "review", currentParticipant: { type: "user", userId: "u" }, returnAssignee: { type: "agent", agentId: "c" }, changesRequestedCount: 3 },
  };
  assert.equal(escalatedReview(issue, "u"), true);
  assert.equal(escalatedReview({ ...issue, executionState: { ...issue.executionState, changesRequestedCount: 2 } }, "u"), false);
  assert.equal(escalatedReview({ ...issue, executionPolicy: { ...issue.executionPolicy, maxReviewRounds: 5 } }, "u"), false);
  const ownStage = { ...issue, executionPolicy: { stages: [{ id: "s1", type: "review", participants: [{ type: "user", userId: "u" }] }] } };
  assert.equal(escalatedReview(ownStage, "u"), false, "a review stage you sit on is your own review");
});

test("escalated reviews stay with you unless WATCHDOG_RETURN_ESCALATED_REVIEWS is on", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  escalated(env);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
});

test("with it on, the review goes back to the implementer with the reviewer's request, a capped number of times", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_RETURN_ESCALATED_REVIEWS: "true", WATCHDOG_MAX_NUDGES: "1" }, { github: false });
  const { carla, issue } = escalated(env);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  const { body } = env.db.patches[0];
  assert.equal(body.status, "in_progress");
  assert.ok(body.comment.startsWith(`[@Carla](agent://${carla.id}) Jian-Yang requested changes again, and after 3 rounds`));
  assert.match(body.comment, /> Revision 5 still lacks the four proofs\./);

  // Escalated again, with a new decision: the budget (WATCHDOG_MAX_NUDGES = 1) is used up.
  Object.assign(issue, { status: "in_review", updatedAt: minutesAgo(30) });
  issue.executionState.lastDecisionId = "d-6";
  env.db.comments.push({ issueId: issue.id, body: "Still missing proof 4.", authorAgentId: env.db.agents[1].id, createdAt: new Date(env.clock.now + 1000).toISOString() });
  env.later(10);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  assert.ok(env.logs.some((l) => /returns are used up/.test(l.msg)));
});

test("an escalated review that also waits on a card for a person is left alone", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_RETURN_ESCALATED_REVIEWS: "true" }, { github: false });
  escalated(env, { pendingCardForYou: true });
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
});

// ---------------------------------------------------------------- 14. cancelled blockers

test("an issue blocked by a cancelled issue is told why, once", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  const richard = agent(env.db, "Richard");
  const blocker = { id: uuid(), identifier: "ACM-604", companyId: ids.company, status: "cancelled" };
  const issue = { id: uuid(), identifier: "ACM-251", companyId: ids.company, status: "blocked", assigneeAgentId: richard.id, updatedAt: minutesAgo(30), blockedBy: [{ id: blocker.id }] };
  env.db.issues.push(blocker, issue);
  env.db.comments.push({ issueId: blocker.id, body: "Cancelled: the fix rode ACM-571's PR, merged.", authorAgentId: "x", createdAt: minutesAgo(40) });
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: false, unresolvedBlockerCount: 1 },
    blockers: [{ id: blocker.id, identifier: "ACM-604", status: "cancelled", isPendingFinalize: false, flags: ["cancelled_blocker_in_set"] }],
  };
  await env.watchdog.tick();
  const posted = helperComments(env.db, issue);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.startsWith(`[@Richard](agent://${richard.id}) this issue is blocked by ACM-604, which was cancelled.`));
  assert.match(posted[0].body, /> Cancelled: the fix rode ACM-571's PR, merged\./);
  assert.match(posted[0].body, /remove ACM-604 from this issue's "Blocked by"/);

  env.later(10);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 1, "once: an issue kept blocked on purpose isn't nagged");
});

// ---------------------------------------------------------------- review findings

test("runRefs puts the newest run first and ignores check-run ids", () => {
  assert.deepEqual(runRefs("the failure in https://github.com/org/app/actions/runs/39400000000 is fixed; waiting on run 39500000000").map((r) => r.id), [
    "39500000000",
    "39400000000",
  ]);
  assert.deepEqual(runRefs("see check run 41234567890"), []);
});

test("while the newest run named is still going, an older finished one isn't reported", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env, { comment: "Run 39498202022 failed, fixed it; waiting on run 39598202022 now." });
  env.gh.runs["org/app"][39598202022] = { id: 39598202022, status: "in_progress", run_attempt: 1, updated_at: minutesAgo(1) };
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0);
});

test("a run the agent wrote about after it finished, or one cancelled, isn't reported", async (t) => {
  const env = await watchdogEnv(t);
  const { issue } = waitingOnCi(env, { comment: "CI run 39498202022 passed, submitting." });
  env.db.comments.find((c) => c.issueId === issue.id).createdAt = minutesAgo(20); // after the run finished (30 min ago)
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0, "it watched the run itself");

  const env2 = await watchdogEnv(t);
  const { issue: other } = waitingOnCi(env2, { conclusion: "cancelled" });
  await env2.watchdog.tick();
  assert.equal(helperComments(env2.db, other).length, 0, "cancelled, usually by a newer push");
});

test("a dry run reports nothing and records nothing, so the real run still reports", async (t) => {
  const env = await watchdogEnv(t, { DRY_RUN: "true" });
  const { issue } = waitingOnCi(env);
  await env.watchdog.tick();
  assert.equal(helperComments(env.db, issue).length, 0);
  assert.ok(env.logs.some((l) => l.msg === "watchdog: would nudge (dry run)" && l.reason === "CI run finished"));
  assert.equal([...env.state.nudges.entries()].filter(([k]) => k.startsWith("ci:")).length, 0);
});

test("an answered card doesn't return a review Paperclip escalated, while returning escalations is off", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  const { issue, carla } = escalated(env);
  env.db.interactions[issue.id] = [
    { id: uuid(), kind: "ask_user_questions", status: "answered", continuationPolicy: "wake_assignee", createdByAgentId: carla.id, resolvedByUserId: ids.user, resolvedAt: minutesAgo(40), result: { summaryMarkdown: "yes" } },
  ];
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0, "a decision as you would reset Paperclip's round count");
});

test("an answer that asked for no wake, or came while the agent was running, isn't delivered", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  const { card } = answeredOnReview(env);
  card.continuationPolicy = "none";
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);

  const env2 = await watchdogEnv(t, {}, { github: false });
  const { issue, carla } = answeredOnReview(env2);
  env2.db.issueRuns[issue.id].unshift({ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(50), startedAt: minutesAgo(50), finishedAt: minutesAgo(35) });
  await env2.watchdog.tick();
  assert.equal(env2.db.patches.length, 0, "the run that was going when the answer came got it, then submitted");
});

test("an issue you decided on meanwhile isn't returned", async (t) => {
  const env = await watchdogEnv(t, {}, { github: false });
  const { issue } = answeredOnReview(env);
  // You approve while the watchdog is looking: the re-read before the decision sees it.
  const original = env.db.interactions[issue.id];
  let reads = 0;
  Object.defineProperty(env.db.interactions, issue.id, {
    get() {
      reads += 1;
      // Read once by the question-card scan, then by this check: approve right after.
      if (reads === 2) issue.status = "done";
      return original;
    },
    configurable: true,
  });
  await env.watchdog.tick();
  assert.equal(reads, 2, "the check got as far as the cards");
  assert.ok(env.logs.some((l) => /changed before it could be returned/.test(l.msg)));
  assert.equal(env.db.patches.length, 0);
});
