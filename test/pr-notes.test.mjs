// The relay's reply on the PR when /changes, /approve or "Request changes" isn't
// recorded as a decision (RELAY_PR_NOTES).

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { createRelay, decisionNote } from "../src/relay.mjs";
import { HELPER_MARK } from "../src/conflicts.mjs";

const RELAY_ENV = { GITHUB_WEBHOOK_SECRET: "test-secret", GITHUB_OWNER_LOGIN: "Owner", GITHUB_REPOS: "org/app", RELAY_PORT: "0" };
const waitingOnMe = { status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user } };
const repository = { full_name: "Org/App" };
const owner = { login: "owner" };

async function notesEnv(t, extra = {}, { token = true } = {}) {
  const gh = await startFakeGitHub();
  const env = await setup({ env: { ...RELAY_ENV, ...(token ? { GITHUB_TOKEN: gh.token, GITHUB_API: gh.url } : {}), ...extra } });
  t.after(async () => {
    await env.close();
    await gh.close();
  });
  const relay = createRelay(env.ctx, env.state);
  return { ...env, gh, relay };
}

// ACM-251 blocked in review with an agent; ACM-419 named second, not waiting either.
function seedNotWaiting(db) {
  const first = { id: uuid(), identifier: "ACM-251", companyId: ids.company, status: "blocked", executionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: "a-1" } } };
  const second = { id: uuid(), identifier: "ACM-419", companyId: ids.company, status: "in_progress" };
  db.issues.push(first, second);
  return { first, second };
}

const comment = (body, issue = {}) => ({
  action: "created",
  issue: { number: 31, title: "ACM-251: umbrella, part ACM-419", body: "", html_url: "https://github.com/org/app/pull/31", pull_request: {}, ...issue },
  comment: { body, html_url: "https://github.com/org/app/pull/31#issuecomment-1" },
  repository,
  sender: owner,
});

test("a /changes that isn't waiting on you is copied to the issue and explained on the PR", async (t) => {
  const { relay, db, gh, logs } = await notesEnv(t);
  const { first } = seedNotWaiting(db);
  const result = await relay.handle("issue_comment", comment("/changes Fix the reconnect hold"));
  await relay.idle();

  assert.equal(result.identifier, "ACM-251");
  assert.equal(result.action, "comment");
  assert.equal(result.prNote, true);
  assert.equal(db.patches.length, 0);
  assert.equal(db.comments.length, 1);
  assert.equal(db.comments[0].issueId, first.id);

  assert.equal(gh.comments.length, 1);
  const note = gh.comments[0];
  assert.equal(note.repo, "Org/App");
  assert.equal(note.number, 31);
  assert.match(note.body, /^\*\*Your `\/changes` was not recorded as a decision\.\*\*/);
  assert.match(note.body, /This PR names ACM-251, ACM-419\./);
  assert.match(note.body, /the relay used the first one, ACM-251 \(blocked, review stage\)/);
  assert.match(note.body, /Your text was added to ACM-251 as a comment\./);
  assert.match(note.body, /`pch changes <issue> "…"`/);
  assert.match(note.body, /_Sent automatically by Paperclip Helper\._/);
  assert.ok(note.body.endsWith(HELPER_MARK));
  assert.ok(logs.some((l) => l.msg === "relay: noted on the PR" && l.pr === 31));
});

test("a /changes that is recorded leaves the PR alone", async (t) => {
  const { relay, db, gh } = await notesEnv(t);
  db.issues.push({ id: uuid(), identifier: "ACM-251", companyId: ids.company, status: "in_review", executionState: waitingOnMe });
  const result = await relay.handle("issue_comment", comment("/changes Fix it"));
  await relay.idle();
  assert.equal(result.action, "changes");
  assert.equal(result.prNote, undefined);
  assert.equal(db.patches.length, 1);
  assert.equal(gh.comments.length, 0);
});

test("a plain comment is copied as before, without a note on the PR", async (t) => {
  const { relay, db, gh } = await notesEnv(t);
  seedNotWaiting(db);
  const result = await relay.handle("issue_comment", comment("Looks close"));
  await relay.idle();
  assert.equal(result.action, "comment");
  assert.equal(result.prNote, undefined);
  assert.equal(gh.comments.length, 0);
});

test("a /changes on a PR that names no issue says so on the PR", async (t) => {
  const { relay, db, gh } = await notesEnv(t);
  seedNotWaiting(db);
  const result = await relay.handle("issue_comment", comment("/changes Fix it", { title: "Tidy the tests", body: "" }));
  await relay.idle();
  assert.equal(result.ignored, "PR #31 names no ACM issue");
  assert.equal(result.prNote, true);
  assert.equal(db.comments.length, 0);
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0].body, /names no ACM issue in its title or body \(for comments GitHub doesn't send the branch/);
  assert.match(gh.comments[0].body, /add the issue's identifier to this PR's title or body/);
});

test("a Request changes review that isn't waiting on you says 'Your Request changes'", async (t) => {
  const { relay, db, gh } = await notesEnv(t);
  seedNotWaiting(db);
  const result = await relay.handle("pull_request_review", {
    action: "submitted",
    pull_request: { number: 31, title: "ACM-251: umbrella", head: { ref: "acm-251" }, body: "", html_url: "https://github.com/org/app/pull/31" },
    review: { id: 5, state: "changes_requested", body: "Fix it", html_url: "https://github.com/org/app/pull/31#pullrequestreview-5" },
    repository,
    sender: owner,
  });
  await relay.idle();
  assert.equal(result.action, "comment");
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0].body, /^\*\*Your Request changes was not recorded as a decision\.\*\*/);
});

test("RELAY_PR_NOTES=false, or no GitHub token, leaves the PR alone", async (t) => {
  const off = await notesEnv(t, { RELAY_PR_NOTES: "false" });
  seedNotWaiting(off.db);
  const r1 = await off.relay.handle("issue_comment", comment("/changes Fix it"));
  await off.relay.idle();
  assert.equal(r1.prNote, false);
  assert.equal(off.gh.comments.length, 0);

  const tokenless = await notesEnv(t, {}, { token: false });
  seedNotWaiting(tokenless.db);
  const r2 = await tokenless.relay.handle("issue_comment", comment("/changes Fix it"));
  await tokenless.relay.idle();
  assert.equal(r2.action, "comment");
  assert.equal(r2.prNote, false);
  assert.equal(tokenless.gh.comments.length, 0);
});

test("a note GitHub refuses is logged and doesn't fail the webhook", async (t) => {
  const { relay, db, gh, logs } = await notesEnv(t);
  seedNotWaiting(db);
  gh.fail["POST comments"] = 403;
  const result = await relay.handle("issue_comment", comment("/changes Fix it"));
  await relay.idle();
  assert.equal(result.action, "comment");
  assert.equal(db.comments.length, 1);
  assert.ok(logs.some((l) => l.msg === "relay: could not note on the PR" && /403/.test(l.error)));
});

test("the note's own delivery back to the relay is ignored", async (t) => {
  const { relay, db, gh } = await notesEnv(t);
  seedNotWaiting(db);
  await relay.handle("issue_comment", comment("/changes Fix it"));
  await relay.idle();
  const echoed = await relay.handle("issue_comment", comment(gh.comments[0].body));
  assert.deepEqual(echoed, { ignored: "the helper's own comment" });
  assert.equal(db.comments.length, 1);
});

test("decisionNote: recorded, already done, not found, several waiting", () => {
  const base = { kind: "changes", asked: "Your `/changes`", identifiers: ["ACM-1", "ACM-2"] };
  assert.equal(decisionNote({ ...base, result: { identifier: "ACM-1", action: "changes" } }), null);
  assert.match(decisionNote({ ...base, kind: "approve", asked: "Your `/approve`", result: { identifier: "ACM-1", action: "none", reason: "issue already done" } }), /ACM-1 is already done\.[\s\S]*`pch approve <issue> "…"`/);
  assert.match(decisionNote({ ...base, result: { identifiers: ["ACM-1", "ACM-2"], action: "none", reason: "no Paperclip issue found for the identifiers" } }), /None of the issues this PR names \(ACM-1, ACM-2\) was found in Paperclip\./);
  const several = decisionNote({ ...base, result: { identifier: "ACM-1", action: "comment", reason: "several issues wait on you (ACM-1, ACM-2) and none lists this PR" } });
  assert.match(several, /ACM-1, ACM-2 all wait on you, and none of them lists this PR/);
  assert.match(several, /Your text was added to ACM-1 as a comment\./);
});
