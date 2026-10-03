import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sign } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createRelay, findIdentifiers, isWorkProductOf, verifySignature } from "../src/relay.mjs";
import { createStateStore } from "../src/store.mjs";

const SECRET = "test-secret";
const RELAY_ENV = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_OWNER_LOGIN: "Owner", GITHUB_REPOS: "org/app", RELAY_PORT: "0" };

const waitingOnMe = { status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user } };

// Parent ACM-1 (named by the PR) with child ACM-2, whose approval waits on the operator.
function seed(db) {
  const parent = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "in_progress", title: "Feature" };
  const child = {
    id: uuid(),
    identifier: "ACM-2",
    companyId: ids.company,
    parentId: parent.id,
    status: "in_review",
    executionState: waitingOnMe,
  };
  db.issues.push(parent, child);
  return { parent, child };
}

const repo = { full_name: "Org/App" };
const pr = (extra = {}) => ({
  number: 8,
  title: "ACM-1: add the thing",
  head: { ref: "acm-1-thing" },
  body: "Closes ACM-1",
  html_url: "https://github.com/org/app/pull/8",
  base: { ref: "main" },
  merged: true,
  merge_commit_sha: "abcdef1234567890",
  ...extra,
});
const owner = { login: "owner" };

async function relayEnv(t, extra = {}) {
  const env = await setup({ env: { ...RELAY_ENV, ...extra } });
  t.after(env.close);
  const relay = createRelay(env.ctx, env.state);
  return { ...env, relay };
}

test("finds every identifier the PR names, in order", () => {
  const ids = findIdentifiers({ title: "ACM-3 and acm-4", head: { ref: "feat/ACM-3" }, body: "See OPS-12, ACM-5" }, ["ACM", "OPS"]);
  assert.deepEqual(ids, ["ACM-3", "ACM-4", "OPS-12", "ACM-5"]);
  assert.deepEqual(findIdentifiers({ title: "ACM-3", body: "OPS-12" }, ["OPS"]), ["OPS-12"]);
});

test("a PR work product matches by URL, or by repository and number, never by a bare number", () => {
  const p = { number: 12, html_url: "https://github.com/Org/App/pull/12" };
  const wp = (extra) => ({ type: "pull_request", ...extra });
  assert.equal(isWorkProductOf(wp({ url: "https://github.com/org/app/pull/12" }), p), true);
  assert.equal(isWorkProductOf(wp({ metadata: { repo: "org/app", number: 12 } }), p), true);
  assert.equal(isWorkProductOf(wp({ externalId: "Org/App#12" }), p), true);
  assert.equal(isWorkProductOf(wp({ externalId: "12" }), p), false);
  assert.equal(isWorkProductOf(wp({ url: "https://github.com/org/other/pull/12" }), p), false);
  assert.equal(isWorkProductOf(wp({ metadata: { repo: "org/other", number: 12 } }), p), false);
  assert.equal(isWorkProductOf({ type: "branch", url: "https://github.com/org/app/pull/12" }, p), false);
});

test("signatures: valid, wrong, missing", () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(SECRET, body, sign(SECRET, body)), true);
  assert.equal(verifySignature(SECRET, body, sign("other", body)), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature("", body, sign("", body)), false);
});

test("a merge by the owner approves the child whose approval waits on them", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { child } = seed(db);
  const result = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.deepEqual(result, { identifier: "ACM-2", action: "approve", status: "done" });
  assert.equal(db.patches.length, 1);
  assert.equal(db.patches[0].issueId, child.id);
  assert.equal(db.patches[0].body.status, "done");
  assert.match(db.patches[0].body.comment, /^Approved: PR #8 merged into `main` by @owner \(abcdef123456\)/);
});

test("a merge that only clears your escalated review also approves your approval stage that follows", async (t) => {
  // DIR-68: the review stage hit its round cap and went to the operator; approving it
  // moved the issue to the approval stage, again the operator's, and left it in review.
  const { relay, db } = await relayEnv(t);
  const { child } = seed(db);
  child.executionState = { status: "pending", currentStageType: "review", currentParticipant: { type: "user", userId: ids.user } };
  child.nextStages = [{ type: "approval", participant: { type: "user", userId: ids.user } }];
  const result = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.deepEqual(result, { identifier: "ACM-2", action: "approve", status: "done", stages: ["review", "approval"] });
  assert.equal(db.patches.length, 2);
  assert.match(db.patches[1].body.comment, /^Approved at the approval stage as well: PR #8 was merged\./);
  assert.equal(child.status, "done");
});

test("a merge stops at a stage that is someone else's, and says so", async (t) => {
  const { relay, db, logs } = await relayEnv(t);
  const { child } = seed(db);
  child.executionState = { status: "pending", currentStageType: "review", currentParticipant: { type: "user", userId: ids.user } };
  child.nextStages = [{ type: "approval", participant: { type: "agent", agentId: "a-approver" } }];
  const result = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.equal(db.patches.length, 1);
  assert.equal(result.status, "in_review");
  assert.equal(result.warning, "asked for done, issue is in_review (approval pending with agent a-approver)");
  assert.ok(logs.some((l) => l.msg === "relay: the decision didn't move the issue where it was sent"));
});

test("issue prefixes come from Paperclip when ISSUE_PREFIXES is empty", async (t) => {
  const { relay, db } = await relayEnv(t);
  seed(db);
  const result = await relay.handle("pull_request", {
    action: "closed",
    pull_request: pr({ title: "no id here", head: { ref: "x" }, body: "" }),
    repository: repo,
    sender: owner,
  });
  assert.deepEqual(result, { ignored: "PR #8 names no ACM issue" });
});

test("a merge by someone else, or a close, only comments", async (t) => {
  const { relay, db } = await relayEnv(t);
  seed(db);
  const other = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: { login: "bot" } });
  assert.equal(other.action, "comment");
  const closed = await relay.handle("pull_request", { action: "closed", pull_request: pr({ merged: false }), repository: repo, sender: owner });
  assert.equal(closed.action, "comment");
  assert.equal(db.patches.length, 0);
  assert.equal(db.comments.length, 2);
  assert.match(db.comments[0].body, /merged by @bot, not by the approver/);
  assert.match(db.comments[1].body, /closed without merging/);
});

test("reviews: request changes, /approve, plain text, and a GitHub approval", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { child } = seed(db);
  const review = (state, body) => ({
    action: "submitted",
    pull_request: pr({ merged: false }),
    review: { id: 55, state, body, html_url: "https://github.com/org/app/pull/8#review-55" },
    repository: repo,
    sender: owner,
  });

  assert.deepEqual(await relay.handle("pull_request_review", review("approved", "LGTM")), {
    ignored: "GitHub approval (merge to approve in Paperclip)",
  });
  assert.equal((await relay.handle("pull_request_review", review("commented", "Nice work"))).action, "comment");
  assert.match(db.comments.at(-1).body, /^Review on PR #8/);
  assert.equal(db.comments.at(-1).identifier, "ACM-2");

  const changes = await relay.handle("pull_request_review", review("changes_requested", "Rename it"));
  assert.deepEqual(changes, { identifier: "ACM-2", action: "changes", status: "in_progress" });
  assert.equal(db.patches.at(-1).issueId, child.id);
  assert.match(db.patches.at(-1).body.comment, /^Changes requested on PR #8.*\n\nRename it\n\nInline comments, if any: `gh api repos\/Org\/App\/pulls\/8\/reviews\/55\/comments`/s);

  child.status = "in_review";
  const approve = await relay.handle("pull_request_review", review("commented", "/approve ship it"));
  assert.equal(approve.action, "approve");
  assert.match(db.patches.at(-1).body.comment, /\n\nship it\n/);
});

test("only the owner decides; other reviewers and commenters are ignored", async (t) => {
  const { relay, db } = await relayEnv(t);
  seed(db);
  const r = await relay.handle("pull_request_review", {
    action: "submitted",
    pull_request: pr(),
    review: { id: 1, state: "changes_requested", body: "no" },
    repository: repo,
    sender: { login: "someone" },
  });
  assert.deepEqual(r, { ignored: "review by @someone" });
  const c = await relay.handle("issue_comment", {
    action: "created",
    issue: { number: 8, title: "ACM-1", pull_request: {} },
    comment: { body: "/changes nope" },
    repository: repo,
    sender: { login: "someone" },
  });
  assert.deepEqual(c, { ignored: "comment by @someone" });
  assert.equal(db.patches.length + db.comments.length, 0);
});

test("PR comments: /changes decides, anything else is copied", async (t) => {
  const { relay, db } = await relayEnv(t);
  seed(db);
  const comment = (body) => ({
    action: "created",
    issue: { number: 8, title: "ACM-1: thing", body: "", pull_request: {} },
    comment: { body, html_url: "https://github.com/org/app/pull/8#c1" },
    repository: repo,
    sender: owner,
  });
  assert.equal((await relay.handle("issue_comment", comment("Looks close"))).action, "comment");
  const r = await relay.handle("issue_comment", comment("/changes use the other API"));
  assert.equal(r.action, "changes");
  assert.match(db.patches.at(-1).body.comment, /Changes requested on PR #8.*use the other API/s);
  assert.deepEqual(await relay.handle("issue_comment", { ...comment("x"), issue: { number: 1, title: "ACM-1" } }), {
    ignored: "comment on an issue, not a PR",
  });
});

test("when the decision isn't waiting on the owner, a merge only comments", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { child } = seed(db);
  child.executionState = { status: "pending", currentParticipant: { type: "agent", agentId: "a1" } };
  const r = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.equal(r.action, "comment");
  assert.equal(r.reason, "decision is not waiting on you");
  assert.equal(r.identifier, "ACM-1");
  assert.equal(db.patches.length, 0);
});

test("a merge naming a blocked issue approves its blocker when that waits on the owner", async (t) => {
  // DIR-157/DIR-159: the PR named the blocked issue; the work in review was the
  // issue blocking it, which is neither named nor a subtask of the one named.
  const { relay, db } = await relayEnv(t);
  const blocker = { id: uuid(), identifier: "ACM-5", companyId: ids.company, status: "in_review", executionState: waitingOnMe };
  const blocked = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "blocked", blockedBy: [{ id: blocker.id }] };
  db.issues.push(blocked, blocker);
  const result = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.deepEqual(result, { identifier: "ACM-5", action: "approve", status: "done", via: "blocks ACM-1" });
  assert.equal(db.patches.length, 1);
  assert.equal(db.patches[0].issueId, blocker.id);
  assert.equal(db.comments.filter((c) => c.identifier === "ACM-1").length, 0);
});

test("a merge reaches a subtask of a subtask, and a subtask of a blocker", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { child } = seed(db);
  child.status = "in_progress";
  child.executionState = null;
  const grandchild = { id: uuid(), identifier: "ACM-7", companyId: ids.company, parentId: child.id, status: "in_review", executionState: waitingOnMe };
  db.issues.push(grandchild);
  const deep = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.deepEqual(deep, { identifier: "ACM-7", action: "approve", status: "done", via: "subtask of ACM-2" });

  const blocker = { id: uuid(), identifier: "ACM-8", companyId: ids.company, status: "in_progress" };
  const under = { id: uuid(), identifier: "ACM-9", companyId: ids.company, parentId: blocker.id, status: "in_review", executionState: waitingOnMe };
  db.issues.push(blocker, under);
  db.issues.find((i) => i.identifier === "ACM-1").blockedBy = [{ id: blocker.id }];
  const viaBlocker = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.deepEqual(viaBlocker, { identifier: "ACM-9", action: "approve", status: "done", via: "subtask of ACM-8" });
});

test("an issue the PR names, or its subtask, wins over a blocker that also waits", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { parent, child } = seed(db);
  const blocker = { id: uuid(), identifier: "ACM-5", companyId: ids.company, status: "in_review", executionState: waitingOnMe };
  db.issues.push(blocker);
  parent.blockedBy = [{ id: blocker.id }];
  const result = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.deepEqual(result, { identifier: "ACM-2", action: "approve", status: "done" });
  assert.equal(child.status, "done");
  assert.equal(blocker.status, "in_review");
});

test("blockers that block each other don't loop, and with nothing waiting the named issue gets the comment", async (t) => {
  const { relay, db } = await relayEnv(t);
  const a = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "blocked" };
  const b = { id: uuid(), identifier: "ACM-5", companyId: ids.company, status: "blocked", blockedBy: [{ id: a.id }] };
  a.blockedBy = [{ id: b.id }];
  db.issues.push(a, b);
  const result = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.equal(result.identifier, "ACM-1");
  assert.equal(result.action, "comment");
  assert.equal(result.reason, "decision is not waiting on you");
  assert.equal(db.patches.length, 0);
});

test("with several waiting, the one with this PR as a work product wins", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { parent, child } = seed(db);
  const sibling = { id: uuid(), identifier: "ACM-3", companyId: ids.company, parentId: parent.id, status: "in_review", executionState: waitingOnMe };
  db.issues.push(sibling);
  db.workProducts[sibling.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/8" }];
  const r = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.equal(r.identifier, "ACM-3");
  assert.equal(child.status, "in_review");
});

test("with several waiting and none listing this PR, a merge only comments", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { parent, child } = seed(db);
  const sibling = { id: uuid(), identifier: "ACM-3", companyId: ids.company, parentId: parent.id, status: "in_review", executionState: waitingOnMe };
  db.issues.push(sibling);
  const r = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.equal(r.action, "comment");
  assert.equal(r.reason, "several issues wait on you (ACM-2, ACM-3) and none lists this PR");
  assert.equal(db.patches.length, 0);
  assert.equal(child.status, "in_review");
  assert.equal(sibling.status, "in_review");
  assert.match(db.comments.at(-1).body, /Not recorded as a decision: ACM-2, ACM-3 all wait on you/);
});

test("dry run records nothing", async (t) => {
  const { relay, db } = await relayEnv(t, { DRY_RUN: "true" });
  seed(db);
  const r = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: repo, sender: owner });
  assert.equal(r.action, "approve (dry run)");
  assert.equal(db.patches.length + db.comments.length, 0);
});

test("repositories outside GITHUB_REPOS are ignored, pings answered", async (t) => {
  const { relay } = await relayEnv(t);
  assert.deepEqual(await relay.handle("ping", { zen: "Keep it simple.", repository: repo }), { pong: true, zen: "Keep it simple." });
  const r = await relay.handle("pull_request", { action: "closed", pull_request: pr(), repository: { full_name: "evil/repo" }, sender: owner });
  assert.deepEqual(r, { ignored: "repository evil/repo is not in GITHUB_REPOS" });
});

// ---- linking PRs: post the URL when a PR opens, so Paperclip shows it on the issue

const opened = (action = "opened", extra = {}, sender = { login: "agent-bot" }) => ({
  action,
  pull_request: pr({ merged: false, ...extra }),
  repository: repo,
  sender,
});

test("an opened PR posts one comment with its URL on the issue it names", async (t) => {
  const { relay, db } = await relayEnv(t);
  const parent = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "in_progress" };
  db.issues.push(parent);
  const r = await relay.handle("pull_request", opened());
  assert.deepEqual(r, { identifier: "ACM-1", action: "comment" });
  assert.equal(db.comments.length, 1);
  assert.equal(db.comments[0].body, "PR #8 opened by @agent-bot: https://github.com/org/app/pull/8");
  assert.equal(db.patches.length, 0, "informational only: no decision");
});

test("reopened and ready-for-review PRs post their URL too; other actions don't", async (t) => {
  const { relay, db } = await relayEnv(t);
  seed(db);
  await relay.handle("pull_request", opened("reopened"));
  await relay.handle("pull_request", opened("ready_for_review"));
  assert.deepEqual(await relay.handle("pull_request", opened("synchronize")), { ignored: "pull_request.synchronize" });
  assert.deepEqual(
    db.comments.map((c) => c.body),
    [
      "PR #8 reopened by @agent-bot: https://github.com/org/app/pull/8",
      "PR #8 opened by @agent-bot: https://github.com/org/app/pull/8",
    ],
  );
});

test("with a parent/subtask split, the URL goes to the subtask waiting on you", async (t) => {
  const { relay, db } = await relayEnv(t);
  const { child } = seed(db);
  const r = await relay.handle("pull_request", opened());
  assert.equal(r.identifier, "ACM-2");
  assert.equal(db.comments.length, 1);
  assert.equal(db.comments[0].issueId, child.id);
  assert.match(db.comments[0].body, /https:\/\/github\.com\/org\/app\/pull\/8$/);
});

test("RELAY_LINK_PRS=false ignores opened PRs; a PR that names no issue is ignored", async (t) => {
  const off = await relayEnv(t, { RELAY_LINK_PRS: "false" });
  seed(off.db);
  assert.deepEqual(await off.relay.handle("pull_request", opened()), { ignored: "pull_request.opened" });
  assert.equal(off.db.comments.length, 0);

  const on = await relayEnv(t);
  seed(on.db);
  const r = await on.relay.handle("pull_request", opened("opened", { title: "Tidy up", head: { ref: "tidy" }, body: "" }));
  assert.deepEqual(r, { ignored: "PR #8 names no ACM issue" });
  assert.equal(on.db.comments.length, 0);
});

test("HTTP: a redelivered opened event is posted once", async (t) => {
  const { relay, db } = await relayEnv(t);
  seed(db);
  const port = await relay.start();
  t.after(() => relay.stop());
  const payload = JSON.stringify(opened());
  const deliver = () =>
    fetch(`http://127.0.0.1:${port}/hooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "open-1", "x-hub-signature-256": sign(SECRET, payload) },
      body: payload,
    });
  assert.equal((await (await deliver()).json()).action, "comment");
  assert.deepEqual(await (await deliver()).json(), { duplicate: "open-1" });
  assert.equal(db.comments.length, 1);
});

test("HTTP: signature check, JSON summary, duplicate deliveries, and redelivery after a failure", async (t) => {
  const env = await relayEnv(t);
  const { relay, db, fake } = env;
  seed(db);
  const port = await relay.start();
  t.after(() => relay.stop());
  const url = `http://127.0.0.1:${port}/hooks/github`;
  const payload = JSON.stringify({ action: "closed", pull_request: pr(), repository: repo, sender: owner });
  const deliver = (delivery, signature = sign(SECRET, payload)) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": delivery, "x-hub-signature-256": signature },
      body: payload,
    });

  assert.equal((await fetch(url)).status, 405);
  assert.deepEqual(await (await fetch(url)).json(), { error: "POST only" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  assert.equal((await deliver("d0", "sha256=00")).status, 401);

  // Paperclip fails the first time (500): the relay answers 502 and forgets the
  // delivery, so a redelivery is handled.
  fake.fail("PATCH", /^\/api\/issues\/ACM-2$/, 500);
  const failed = await deliver("d1");
  assert.equal(failed.status, 502);
  const redelivered = await deliver("d1");
  assert.equal(redelivered.status, 200);
  assert.deepEqual(await redelivered.json(), { identifier: "ACM-2", action: "approve", status: "done" });
  const duplicate = await deliver("d1");
  assert.deepEqual(await duplicate.json(), { duplicate: "d1" });
  assert.equal(db.patches.length, 1);

  // Delivery ids survive a restart.
  const again = createStateStore(env.ctx.config.stateFile);
  assert.equal(again.deliveries.has("d1"), true);
});
