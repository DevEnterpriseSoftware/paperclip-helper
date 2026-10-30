// Automatic notices (a conflict send-back, a failed merge-queue check) go only to the
// issue that owns the PR: never to another issue that happens to wait on the board,
// where the helper's PATCH would be a change request that sends approved work back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { createRelay } from "../src/relay.mjs";
import { createDecisions } from "../src/decisions.mjs";
import { createStateStore } from "../src/store.mjs";
import { titleIdentifier } from "../src/identifiers.mjs";
import { QUEUE_BOT } from "../src/merge-queue.mjs";

const REPO = "org/app";
const waitingOnMe = () => ({
  status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user },
  returnAssignee: { type: "agent", agentId: "a-implementer" },
});
const prUrl = (n) => `https://github.com/org/app/pull/${n}`;
const workProduct = (n) => ({ type: "pull_request", url: prUrl(n), title: `PR #${n}` });

async function env(t, extra = {}) {
  const gh = await startFakeGitHub();
  const e = await setup({
    env: {
      GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "Owner", GITHUB_REPOS: REPO, RELAY_PORT: "0",
      RELAY_FIX_CONFLICTS: "true", GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, WATCHDOG_NOTIFY_ISSUE: "ACM-99", ...extra,
    },
  });
  t.after(async () => {
    await e.close();
    await gh.close();
  });
  gh.pulls[REPO] = [];
  gh.runs[REPO] = {};
  const relay = createRelay(e.ctx, e.state, { sleep: async () => {} });
  const notify = { id: uuid(), identifier: "ACM-99", companyId: ids.company, status: "todo", assigneeUserId: ids.user };
  e.db.issues.push(notify);
  const add = (identifier, fields = {}) => {
    const issue = { id: uuid(), identifier, companyId: ids.company, status: "in_progress", ...fields };
    e.db.issues.push(issue);
    return issue;
  };
  const workspace = (issue, branchName, fields = {}) => {
    const ws = { id: uuid(), companyId: ids.company, sourceIssueId: issue.id, mode: "isolated_workspace", status: "active", branchName, ...fields };
    e.db.executionWorkspaces.push(ws);
    return ws;
  };
  // Everything written to an issue other than the board-notes issue.
  const touched = () => [
    ...new Set([
      ...e.db.patches.map((p) => p.identifier),
      ...e.db.comments.filter((c) => c.issueId !== notify.id).map((c) => c.identifier ?? c.issueId),
    ]),
  ];
  const boardNotes = () => e.db.comments.filter((c) => c.issueId === notify.id);
  return { ...e, gh, relay, add, workspace, touched, boardNotes, notify };
}

// Issue A: approved by its reviewers, at the board's approval stage, its own PR #283 in
// the merge queue. It blocks B and C, so it is related to both.
function approvedAndQueued(e) {
  const A = e.add("ACM-1", { status: "in_review", executionState: waitingOnMe() });
  e.db.workProducts[A.id] = [workProduct(283)];
  e.workspace(A, "ACM-1-feature");
  return A;
}

test("titleIdentifier reads only the identifier that starts the title", () => {
  assert.equal(titleIdentifier({ title: "ACM-2: thing" }, ["ACM"]), "ACM-2");
  assert.equal(titleIdentifier({ title: "[acm-12] thing" }, ["ACM"]), "ACM-12");
  assert.equal(titleIdentifier({ title: "Fix ACM-3 later" }, ["ACM"]), null);
  assert.equal(titleIdentifier({ title: "ACM-2x" }, ["ACM"]), null);
  assert.equal(titleIdentifier({}, ["ACM"]), null);
});

test("two issues in review: the conflict notice goes to the PR's owner, not to the related one in the merge queue", async (t) => {
  const e = await env(t);
  const A = approvedAndQueued(e);
  const B = e.add("ACM-2", { status: "in_review", executionState: waitingOnMe(), blockedBy: [{ id: A.id }] });
  e.workspace(B, "ACM-2-slug");
  e.gh.pulls[REPO].push(pull(285, { title: "ACM-2: the change", head: { ref: "ACM-2-slug", sha: "s285" }, mergeable: false }));

  const [result] = await e.relay.sweepConflicts(REPO);
  assert.deepEqual(result, { pr: 285, attempt: 1, identifier: "ACM-2", action: "changes" });
  assert.deepEqual(e.touched(), ["ACM-2"]);
  assert.equal(A.status, "in_review", "the approved, queued issue is untouched");
  assert.equal(A.executionState.status, "pending");
  assert.equal(B.status, "in_progress", "the owner went back to its implementer");
  assert.equal(e.boardNotes().length, 0);
});

test("the owner not waiting on the board gets a comment; the related issue waiting on the board still gets nothing", async (t) => {
  const e = await env(t);
  const A = approvedAndQueued(e);
  const B = e.add("ACM-2", { blockedBy: [{ id: A.id }] });
  e.gh.pulls[REPO].push(pull(285, { title: "ACM-2: the change", head: { ref: "ACM-2-slug", sha: "s285" }, mergeable: false }));

  const [result] = await e.relay.sweepConflicts(REPO);
  assert.equal(result.identifier, "ACM-2");
  assert.equal(result.action, "comment");
  assert.equal(e.db.patches.length, 0);
  assert.deepEqual(e.touched(), ["ACM-2"]);
  assert.equal(e.db.comments.at(-1).issueId, B.id);
  assert.match(e.db.comments.at(-1).body, /^Changes requested on PR #285: merge conflicts/);
});

test("a head branch named after a different issue: the work product wins over the branch", async (t) => {
  const e = await env(t);
  const A = approvedAndQueued(e);
  const C = e.add("ACM-3", { blockedBy: [{ id: A.id }] });
  const D = e.add("ACM-4", { status: "in_review", executionState: waitingOnMe() });
  e.db.workProducts[C.id] = [workProduct(271)];
  e.workspace(D, "ACM-4-other-work"); // the PR was opened from D's workspace branch
  e.gh.pulls[REPO].push(pull(271, { title: "ACM-3: the change", head: { ref: "ACM-4-other-work", sha: "s271" }, mergeable: false }));

  const [result] = await e.relay.sweepConflicts(REPO);
  assert.equal(result.identifier, "ACM-3");
  assert.deepEqual(e.touched(), ["ACM-3"]);
  assert.equal(D.status, "in_review", "the branch's issue, waiting on the board, is untouched");
});

test("a work product on a subtask of the named issue makes the subtask the owner", async (t) => {
  const e = await env(t);
  const parent = e.add("ACM-5");
  const child = e.add("ACM-6", { parentId: parent.id, status: "in_review", executionState: waitingOnMe() });
  e.db.workProducts[child.id] = [{ type: "pull_request", metadata: { repo: "org/app", number: 40 } }];
  e.gh.pulls[REPO].push(pull(40, { title: "ACM-5: the change", head: { ref: "acm-5", sha: "s40" }, mergeable: false }));
  const [result] = await e.relay.sweepConflicts(REPO);
  assert.equal(result.identifier, "ACM-6");
  assert.equal(result.action, "changes");
  assert.equal(parent.status, "in_progress");
});

test("only the head branch says whose it is: its workspace's issue is the owner", async (t) => {
  const e = await env(t);
  approvedAndQueued(e);
  const E = e.add("ACM-7");
  e.workspace(E, "acm-7-slug", { status: "archived" });
  e.workspace(E, "acm-7-slug");
  e.gh.pulls[REPO].push(pull(50, { title: "Tidy the parser", head: { ref: "acm-7-slug", sha: "s50" }, mergeable: false }));
  const [result] = await e.relay.sweepConflicts(REPO);
  assert.equal(result.identifier, "ACM-7");
  assert.deepEqual(e.touched(), ["ACM-7"]);
});

test("no issue owns the PR: no issue is written to, and the board is told once", async (t) => {
  const e = await env(t);
  approvedAndQueued(e);
  // Named only in the body, as a mention: not a work product, not the title, not a workspace branch.
  e.gh.pulls[REPO].push(pull(60, { title: "Tidy the parser", body: "Follows on from ACM-1.", head: { ref: "tidy", sha: "s60" }, mergeable: false }));

  const [result] = await e.relay.sweepConflicts(REPO);
  assert.equal(result.action, "board note");
  assert.match(result.reason, /no issue lists it as a work product, its title starts with no issue identifier, and its head branch `tidy` is no issue's workspace branch/);
  assert.deepEqual(e.touched(), []);
  assert.equal(e.boardNotes().length, 1);
  assert.match(e.boardNotes()[0].body, /PR #60 conflicts with `main`, but it wasn't sent back: no single Paperclip issue owns it/);
  assert.match(e.boardNotes()[0].body, /_Relayed from GitHub by Paperclip Helper\._$/);
  assert.equal(e.gh.comments.length, 0);

  assert.match((await e.relay.sweepConflicts(REPO))[0].reason, /no issue owns it; the board was told/);
  assert.equal(e.boardNotes().length, 1);
});

test("sources that disagree, without a work product, are no owner", async (t) => {
  const e = await env(t);
  const A = approvedAndQueued(e);
  e.add("ACM-2", { blockedBy: [{ id: A.id }] });
  // The title names ACM-2; the head branch is A's workspace branch.
  e.gh.pulls[REPO].push(pull(70, { title: "ACM-2: the change", head: { ref: "ACM-1-feature", sha: "s70" }, mergeable: false }));
  const [result] = await e.relay.sweepConflicts(REPO);
  assert.equal(result.action, "board note");
  assert.match(result.reason, /its title starts with ACM-2, but its head branch `ACM-1-feature` is ACM-1's workspace branch/);
  assert.deepEqual(e.touched(), []);
  assert.equal(A.status, "in_review");
});

test("two issues listing the PR as a work product, or two live workspaces on its branch, are no owner", async (t) => {
  const e = await env(t);
  const F = e.add("ACM-8");
  const G = e.add("ACM-9");
  e.db.workProducts[F.id] = [workProduct(80)];
  e.db.workProducts[G.id] = [{ type: "pull_request", externalId: "org/app#80" }];
  e.workspace(F, "shared");
  e.workspace(G, "shared");
  e.gh.pulls[REPO].push(
    pull(80, { title: "ACM-8: x", body: "and ACM-9", head: { ref: "f", sha: "s80" }, mergeable: false }),
    pull(81, { title: "Shared work", body: "ACM-8", head: { ref: "shared", sha: "s81" }, mergeable: false }),
  );
  const results = await e.relay.sweepConflicts(REPO);
  assert.match(results[0].reason, /ACM-8 and ACM-9 all list it as a work product/);
  assert.match(results[1].reason, /head branch `shared` is the workspace branch of ACM-8 and ACM-9/);
  assert.deepEqual(e.touched(), []);
  assert.equal(e.boardNotes().length, 2);
});

test("the same conflict seen twice, across a clean spell or a restart, is one notice; a push is a new one", async (t) => {
  const e = await env(t);
  const B = e.add("ACM-2", { status: "in_review", executionState: waitingOnMe() });
  const pr = pull(285, { title: "ACM-2: the change", head: { ref: "acm-2", sha: "s1" }, mergeable: false });
  e.gh.pulls[REPO].push(pr);
  const handBack = () => Object.assign(B, { status: "in_review", executionState: waitingOnMe() });

  assert.equal((await e.relay.sweepConflicts(REPO))[0].action, "changes");
  handBack();
  assert.match((await e.relay.sweepConflicts(REPO))[0].reason, /already sent back, waiting for a push/);

  // GitHub says it merges for a moment, then conflicts again on the same commit.
  pr.mergeable = true;
  assert.equal((await e.relay.sweepConflicts(REPO))[0].action, "clean");
  pr.mergeable = false;
  assert.match((await e.relay.sweepConflicts(REPO))[0].reason, /already sent back for this commit/);
  assert.equal(e.db.patches.length, 1);

  // A push that still conflicts is a new notice, to the owner looked up again.
  pr.head = { ...pr.head, sha: "s2" };
  assert.deepEqual((await e.relay.sweepConflicts(REPO))[0], { pr: 285, attempt: 1, identifier: "ACM-2", action: "changes" });
  assert.equal(e.db.patches.length, 2);
  assert.deepEqual(e.state.conflicts.get("org/app#285").sent, ["s1:dirty", "s2:dirty"]);

  // After a restart, the same commit is still remembered.
  handBack();
  const restarted = createRelay(e.ctx, createStateStore(e.ctx.config.stateFile), { sleep: async () => {} });
  assert.match((await restarted.sweepConflicts(REPO))[0].reason, /already sent back, waiting for a push/);
  assert.equal(e.db.patches.length, 2);
});

test("the guard: an automatic change request never reaches an issue at the board's stage that doesn't own the PR", async (t) => {
  const e = await env(t);
  const A = approvedAndQueued(e);
  e.add("ACM-2");
  const decisions = createDecisions(e.ctx);
  const pr = pull(285, { title: "ACM-2: the change", head: { ref: "ACM-2-slug", sha: "s285" } });
  // Even handed A as the target, as the old lookup did.
  const result = await decisions.decide({
    pr, identifiers: ["ACM-2"], kind: "changes", comment: "Changes requested", target: { issue: A, waiting: true }, automatic: true,
  });
  assert.equal(result.code, "not-owner");
  assert.equal(result.action, "none");
  assert.deepEqual(e.touched(), []);
  assert.equal(A.status, "in_review");
  assert.ok(e.logs.some((l) => l.msg === "relay: an automatic notice was stopped: the issue doesn't own the PR"));

  // Your own decision is not automatic: it may still go where the board's decision waits.
  const yours = await decisions.decide({ pr, identifiers: ["ACM-2"], kind: "changes", comment: "Not yet", target: { issue: A, waiting: true } });
  assert.equal(yours.action, "changes");

  // And the owner itself passes the guard.
  assert.equal(await decisions.ownsPr(A, pull(283, { title: "Something", head: { ref: "x" } })), true, "by work product");
  assert.equal(await decisions.ownsPr(A, pull(9, { title: "Other", head: { ref: "ACM-1-feature" } })), true, "by workspace branch");
  assert.equal(await decisions.ownsPr(A, pull(9, { title: "ACM-1: mine", head: { ref: "x" } })), true, "by title");
  assert.equal(await decisions.ownsPr(A, pr), false);
});

test("a failed merge-queue check is sent back to the PR's owner, not to a related issue waiting on the board", async (t) => {
  const e = await env(t, { RELAY_MERGE_QUEUE: "true" });
  const A = approvedAndQueued(e);
  const B = e.add("ACM-2", { status: "in_review", executionState: waitingOnMe(), blockedBy: [{ id: A.id }] });
  const pr = pull(285, { title: "ACM-2: the change", head: { ref: "ACM-2-slug", sha: "s285" }, mergeable_state: "blocked" });
  e.gh.pulls[REPO].push(pr);
  const run = {
    id: 777, event: "merge_group", status: "completed", conclusion: "failure", head_sha: "mg-1",
    head_branch: "gh-readonly-queue/main/pr-285-mg-1", created_at: new Date().toISOString(),
    html_url: "https://github.com/org/app/actions/runs/777", jobs: [{ id: 7770, name: "test", conclusion: "failure" }],
  };
  e.gh.runs[REPO][run.id] = run;
  const payload = { action: "dequeued", number: 285, reason: "CI_FAILURE", pull_request: pr, repository: { full_name: REPO }, sender: { login: QUEUE_BOT } };

  const answer = await e.relay.handle("pull_request", payload);
  await e.relay.idle();
  assert.equal(answer.identifier, "ACM-2");
  assert.equal(answer.action, "changes");
  assert.deepEqual(e.touched(), ["ACM-2"]);
  assert.equal(B.status, "in_progress");
  assert.equal(A.status, "in_review");
});

test("a failed merge-queue check on a PR no issue owns tells the board, once, and writes to no issue", async (t) => {
  const e = await env(t, { RELAY_MERGE_QUEUE: "true" });
  approvedAndQueued(e);
  const pr = pull(90, { title: "Tidy", body: "See ACM-1", head: { ref: "tidy", sha: "s90" }, mergeable_state: "blocked" });
  e.gh.pulls[REPO].push(pr);
  e.gh.runs[REPO][778] = {
    id: 778, event: "merge_group", status: "completed", conclusion: "failure", head_sha: "mg-9",
    head_branch: "gh-readonly-queue/main/pr-90-mg-9", created_at: new Date().toISOString(),
    html_url: "https://github.com/org/app/actions/runs/778", jobs: [{ id: 7780, name: "test", conclusion: "failure" }],
  };
  const payload = { action: "dequeued", number: 90, reason: "CI_FAILURE", pull_request: pr, repository: { full_name: REPO }, sender: { login: QUEUE_BOT } };
  const answer = await e.relay.handle("pull_request", payload);
  await e.relay.idle();
  assert.equal(answer.action, "board note");
  assert.deepEqual(e.touched(), []);
  assert.equal(e.boardNotes().length, 1);
  assert.match(e.boardNotes()[0].body, /PR #90 was dropped from the merge queue for a failed check, but it wasn't sent back/);
  await e.relay.handle("pull_request", payload);
  await e.relay.idle();
  assert.equal(e.boardNotes().length, 1);
});
