import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { createRelay } from "../src/relay.mjs";
import { classifyDrop, dropReason, latestGroupRuns, QUEUE_BOT } from "../src/merge-queue.mjs";

const REPO = "org/app";
// A stage waiting on you remembers who handed the work in (returnAssignee), as Paperclip's does.
const waitingOnMe = { status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user }, returnAssignee: { type: "agent", agentId: "a-implementer" } };
let runId = 9000;

// ACM-1 waits on the board's approval, as a queued PR's issue does: assigned to the board user.
async function queueEnv(t, extra = {}) {
  const gh = await startFakeGitHub();
  const env = await setup({
    env: {
      GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "Owner", GITHUB_REPOS: REPO, RELAY_PORT: "0",
      GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, RELAY_MERGE_QUEUE: "true", ...extra,
    },
  });
  t.after(async () => {
    await env.close();
    await gh.close();
  });
  env.db.simulateWakes = true;
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "codex_local" };
  env.db.agents.push(engineer);
  const relay = createRelay(env.ctx, env.state, { sleep: async () => {} });
  const issue = {
    id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "in_review", executionState: waitingOnMe,
    assigneeUserId: ids.user, assigneeAgentId: null,
  };
  env.db.issues.push(issue);
  gh.pulls[REPO] = [pull(8, { node_id: "PR_node8", mergeable_state: "blocked" })];
  gh.runs[REPO] = {};
  return { ...env, gh, relay, issue, engineer };
}

// A merge-group run for a PR, with its jobs.
function groupRun(gh, { sha = "mg-1", conclusion = "success", jobs = [], minutesAgo = 5, number = 8 } = {}) {
  runId += 1;
  const run = {
    id: runId, event: "merge_group", status: "completed", conclusion, head_sha: sha,
    head_branch: `gh-readonly-queue/main/pr-${number}-${sha}`, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    html_url: `https://github.com/org/app/actions/runs/${runId}`,
    jobs: jobs.map((j, i) => ({ id: runId * 10 + i, name: j[0], conclusion: j[1] })),
  };
  gh.runs[REPO][run.id] = run;
  return run;
}

const dequeued = (reason = "CI_FAILURE", sender = QUEUE_BOT) => ({
  action: "dequeued", number: 8, reason, pull_request: pull(8), repository: { full_name: "org/app" }, sender: { login: sender },
});

async function drop(env, payload = dequeued()) {
  const answer = await env.relay.handle("pull_request", payload);
  await env.relay.idle();
  return answer;
}
const runsOf = (env) => Object.values(env.db.issueRuns).flat();

test("a failed merge-group job sends the PR back to its implementer, with the failed jobs and the first annotation, once", async (t) => {
  const env = await queueEnv(t);
  const run = groupRun(env.gh, { conclusion: "failure", jobs: [["lint", "success"], ["e2e (windows)", "failure"]] });
  env.gh.annotations[run.id * 10 + 1] = [{ annotation_level: "warning", message: "slow" }, { annotation_level: "failure", message: "skip budget exceeded: 12 > 10" }];
  // An older merge group for the same PR, which passed: only the newest counts.
  groupRun(env.gh, { sha: "mg-0", minutesAgo: 60 });

  assert.deepEqual(await drop(env), { pr: 8, drop: "failed", reason: "CI_FAILURE", identifier: "ACM-1", action: "changes" });
  assert.equal(env.db.patches.length, 1);
  const { body } = env.db.patches[0];
  assert.equal(body.status, "in_progress");
  assert.match(body.comment, /^Changes requested on PR #8: a merge-queue check failed/);
  assert.match(body.comment, new RegExp(`actions/runs/${run.id}`));
  assert.match(body.comment, /Failed: `e2e \(windows\)`\./);
  assert.match(body.comment, /> skip budget exceeded: 12 > 10/);
  assert.equal(env.gh.comments.length, 1);
  assert.match(env.gh.comments[0].body, /Sent back: a merge-queue check failed\.\*\* ACM-1 was returned to its agent/);

  // The same drop delivered again does nothing more.
  await drop(env);
  assert.equal(env.db.patches.length, 1);
  assert.equal(env.relay.stats.mergeQueue.sentBack, 1);
});

test("a cancelled merge-group job is the runner's fault: the board is told, the implementer isn't sent it", async (t) => {
  const env = await queueEnv(t);
  groupRun(env.gh, { conclusion: "cancelled", jobs: [["build", "success"], ["test", "cancelled"]] });
  await drop(env);
  assert.equal(env.db.patches.length, 0);
  const notes = env.db.comments.filter((c) => c.issueId === env.issue.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^PR #8 was dropped from the merge queue by a cancelled run \(`test` cancelled\), which is usually a runner restarting, not by the PR\. Queue it again\./);
  assert.match(notes[0].body, /_Relayed from GitHub by Paperclip Helper\._$/);
  assert.equal(runsOf(env).length, 0); // the issue waits on a person: nobody woken
});

test("the queue's status-check timeout is never sent back, even with a failed job in the group", async (t) => {
  const env = await queueEnv(t);
  groupRun(env.gh, { conclusion: "failure", jobs: [["optional-docs", "failure"]] });
  groupRun(env.gh, { conclusion: null, jobs: [["e2e", null]] }); // still waiting for a runner
  await drop(env, dequeued("CI_TIMEOUT"));
  assert.equal(env.db.patches.length, 0);
  const note = env.db.comments.find((c) => c.issueId === env.issue.id);
  assert.match(note.body, /dropped from the merge queue by the queue's status-check timeout: its merge-group checks didn't all report in time/);
});

test("on an issue with an agent assigned, the note goes on the PR and to the board, never waking the agent", async (t) => {
  const env = await queueEnv(t, { WATCHDOG_NOTIFY_ISSUE: "ACM-50" });
  Object.assign(env.issue, { status: "in_progress", executionState: null, assigneeAgentId: env.engineer.id, assigneeUserId: null });
  env.db.issues.push({ id: uuid(), identifier: "ACM-50", companyId: ids.company, status: "todo", title: "Board notes" });
  groupRun(env.gh, { conclusion: "cancelled", jobs: [["test", "cancelled"]] });
  await drop(env);
  assert.equal(env.db.comments.filter((c) => c.issueId === env.issue.id).length, 0);
  assert.equal(runsOf(env).length, 0);
  assert.equal(env.gh.comments.length, 1);
  assert.match(env.gh.comments[0].body, /dropped from the merge queue by a cancelled run/);
  const board = env.db.comments.find((c) => c.identifier === "ACM-50");
  assert.match(board.body, /^ACM-1: PR #8 was dropped from the merge queue/);
});

test("a conflict with the base is the conflict sweep's; one with a PR ahead is told to the board; other reasons are ignored", async (t) => {
  const env = await queueEnv(t, { RELAY_FIX_CONFLICTS: "true" });
  Object.assign(env.gh.pulls[REPO][0], { mergeable: false, mergeable_state: "dirty" });
  await drop(env, dequeued("MERGE_CONFLICT"));
  assert.equal(env.db.patches.length, 1);
  assert.match(env.db.patches[0].body.comment, /^Changes requested on PR #8: merge conflicts with `main`/);
  assert.equal(env.gh.requests.filter((r) => /actions\/runs\?/.test(r.path)).length, 0);

  const ahead = await queueEnv(t);
  await drop(ahead, dequeued("MERGE_CONFLICT"));
  assert.equal(ahead.db.patches.length, 0);
  assert.match(ahead.db.comments.find((c) => c.issueId === ahead.issue.id).body, /for a conflict with a PR ahead of it, not with `main`/);

  const quiet = await queueEnv(t);
  groupRun(quiet.gh, { conclusion: "failure", jobs: [["test", "failure"]] });
  assert.match((await drop(quiet, dequeued("MANUAL", "Owner"))).ignored, /removed from the merge queue by @Owner/);
  for (const reason of ["QUEUE_CLEARED", "BRANCH_PROTECTIONS", "MANUAL"]) await drop(quiet, dequeued(reason));
  quiet.gh.pulls[REPO][0] = pull(8, { title: "chore: no issue", mergeable_state: "blocked" });
  await drop(quiet);
  quiet.gh.pulls[REPO][0] = pull(8, { merged: true, state: "closed" });
  await drop(quiet);
  assert.equal(quiet.db.patches.length + quiet.db.comments.length + quiet.gh.comments.length, 0);
});

test("a failure with no failed or cancelled job to show is reported, not guessed; no reason and no runs does nothing", async (t) => {
  const env = await queueEnv(t);
  await drop(env, dequeued("CI_FAILURE"));
  assert.equal(env.db.patches.length, 0);
  assert.match(env.db.comments.at(-1).body, /dropped from the merge queue for a failed check \(CI_FAILURE\), but no failed or cancelled merge-group job was found/);

  const old = await queueEnv(t);
  await drop(old, dequeued(null)); // an older GitHub Enterprise Server sends no reason
  assert.equal(old.db.patches.length + old.db.comments.length, 0);
});

test("the PR's runs are found past the first page of the queue's runs", async (t) => {
  const env = await queueEnv(t);
  groupRun(env.gh, { conclusion: "failure", jobs: [["test", "failure"]], minutesAgo: 30 });
  for (let i = 0; i < 120; i++) groupRun(env.gh, { sha: `other-${i}`, number: 9, minutesAgo: 1 });
  await drop(env);
  assert.equal(env.db.patches.length, 1);
});

test("a done or cancelled issue is left alone", async (t) => {
  const env = await queueEnv(t);
  Object.assign(env.issue, { status: "done", executionState: null });
  groupRun(env.gh, { conclusion: "failure", jobs: [["test", "failure"]] });
  await drop(env);
  assert.equal(env.db.patches.length + env.db.comments.length, 0);
});

test("RELAY_REQUEUE_ON_INFRA_DROP queues it again, once per commit, only when a person queued it, never after a failed check", async (t) => {
  const env = await queueEnv(t, { RELAY_REQUEUE_ON_INFRA_DROP: "true" });
  await env.relay.handle("pull_request", { ...dequeued(), action: "enqueued", sender: { login: "Owner" } });
  groupRun(env.gh, { conclusion: "cancelled", jobs: [["test", "cancelled"]] });
  await drop(env);
  assert.equal(env.gh.graphql.length, 1);
  assert.match(env.gh.graphql[0].query, /enqueuePullRequest/);
  assert.equal(env.gh.graphql[0].variables.id, "PR_node8");
  assert.match(env.db.comments.at(-1).body, /The relay has queued it again\./);

  // Dropped again on the same commit (a new merge group): told, not queued a second time.
  groupRun(env.gh, { sha: "mg-2", conclusion: "cancelled", jobs: [["test", "cancelled"]], minutesAgo: 1 });
  await drop(env);
  assert.equal(env.gh.graphql.length, 1);
  assert.equal(env.db.comments.filter((c) => /dropped from the merge queue/.test(c.body)).length, 2);

  // A failed check is the PR's: never re-queued.
  groupRun(env.gh, { sha: "mg-3", conclusion: "failure", jobs: [["test", "failure"]], minutesAgo: 0 });
  await drop(env);
  assert.equal(env.gh.graphql.length, 1);

  // Queued by a bot: never queued again by the relay.
  const bot = await queueEnv(t, { RELAY_REQUEUE_ON_INFRA_DROP: "true" });
  await bot.relay.handle("pull_request", { ...dequeued(), action: "enqueued", sender: { login: "renovate[bot]" } });
  groupRun(bot.gh, { conclusion: "cancelled", jobs: [["test", "cancelled"]] });
  await drop(bot);
  assert.equal(bot.gh.graphql.length, 0);

  // GitHub refuses (the token may not merge): the board is still told, without the "queued again".
  const refused = await queueEnv(t, { RELAY_REQUEUE_ON_INFRA_DROP: "true" });
  refused.gh.fail["POST graphql"] = 200;
  await refused.relay.handle("pull_request", { ...dequeued(), action: "enqueued", sender: { login: "Owner" } });
  groupRun(refused.gh, { conclusion: "cancelled", jobs: [["test", "cancelled"]] });
  await drop(refused);
  assert.equal(refused.gh.graphql.length, 1);
  assert.doesNotMatch(refused.db.comments.at(-1).body, /queued it again/);
  assert.equal(refused.logs.filter((l) => /couldn't queue the PR again/.test(l.msg)).length, 1);
});

test("dry run changes nothing on any path; RELAY_MERGE_QUEUE is on by default, and off when set false or without a token", async (t) => {
  for (const [conclusion, jobs] of [["failure", [["test", "failure"]]], ["cancelled", [["test", "cancelled"]]]]) {
    const env = await queueEnv(t, { DRY_RUN: "true", RELAY_REQUEUE_ON_INFRA_DROP: "true" });
    await env.relay.handle("pull_request", { ...dequeued(), action: "enqueued", sender: { login: "Owner" } });
    groupRun(env.gh, { conclusion, jobs });
    await drop(env);
    assert.equal(env.db.patches.length + env.db.comments.length + env.gh.comments.length + env.gh.graphql.length, 0, conclusion);
  }
  // Unset, with RELAY_FIX_CONFLICTS off: on.
  const byDefault = await queueEnv(t, { RELAY_MERGE_QUEUE: "", RELAY_FIX_CONFLICTS: "false" });
  groupRun(byDefault.gh, { conclusion: "failure", jobs: [["test", "failure"]] });
  assert.equal((await drop(byDefault)).action, "changes");

  const off = await queueEnv(t, { RELAY_MERGE_QUEUE: "false" });
  groupRun(off.gh, { conclusion: "failure", jobs: [["test", "failure"]] });
  assert.match((await drop(off)).ignored, /RELAY_MERGE_QUEUE is off/);

  // No token: off, and the log says so once, when the relay starts.
  const noToken = await queueEnv(t, { RELAY_MERGE_QUEUE: "", GITHUB_TOKEN: "" });
  assert.match((await drop(noToken)).ignored, /no GitHub token/);
  assert.equal(noToken.logs.filter((l) => /merge-queue drops aren't handled: no GitHub token/.test(l.msg)).length, 1);
});

test("a drop that fails names the PR, so the delivery fails and can be redelivered", async (t) => {
  const env = await queueEnv(t);
  env.gh.fail["GET pull 8"] = 500;
  await assert.rejects(drop(env), /^Error: merge-queue drop of org\/app#8: /);
  assert.ok(env.relay.stats.mergeQueue.lastError);
});

test("dropReason, classifyDrop and latestGroupRuns", () => {
  assert.equal(dropReason("CI_FAILURE"), "failure");
  assert.equal(dropReason("CI_TIMEOUT"), "timeout");
  assert.equal(dropReason("MERGE_CONFLICT"), "conflict");
  assert.equal(dropReason("BRANCH_PROTECTIONS"), "other");
  assert.equal(dropReason(undefined), null);
  const run = (sha, minutes, conclusion, jobs = []) => ({ head_sha: sha, head_branch: `gh-readonly-queue/main/pr-8-${sha}`, created_at: new Date(Date.now() - minutes * 60_000).toISOString(), conclusion, jobs });
  const runs = [run("a", 10, "failure"), run("b", 2, "success"), run("b", 3, "cancelled"), { ...run("c", 1, "failure"), head_branch: "gh-readonly-queue/main/pr-81-c" }];
  assert.deepEqual(latestGroupRuns(runs, "main", 8).map((r) => r.conclusion), ["success", "cancelled"]);
  assert.equal(latestGroupRuns(runs, "release", 8).length, 0);
  assert.equal(classifyDrop([run("x", 1, "failure", [{ name: "a", conclusion: "timed_out" }])]).kind, "failed");
  assert.equal(classifyDrop([run("x", 1, "failure")]).kind, "failed"); // a failed run whose jobs couldn't be read
  assert.equal(classifyDrop([run("x", 1, "success"), run("x", 1, "cancelled", [{ name: "t", conclusion: "cancelled" }])]).kind, "cancelled");
  assert.equal(classifyDrop([run("x", 1, "success", [{ name: "a", conclusion: "success" }])]).kind, "timeout");
  assert.equal(classifyDrop([]).kind, "timeout");
});
