import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { createRelay } from "../src/relay.mjs";
import { createStateStore } from "../src/store.mjs";
import { HELPER_MARK } from "../src/conflicts.mjs";
import { redact } from "../src/log.mjs";

const RELAY_ENV = {
  GITHUB_WEBHOOK_SECRET: "test-secret",
  GITHUB_OWNER_LOGIN: "Owner",
  GITHUB_REPOS: "org/app",
  RELAY_PORT: "0",
  RELAY_FIX_CONFLICTS: "true",
};
const waitingOnMe = { status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user } };
const REPO = "org/app";

// ACM-1 in review and waiting on the operator; ACM-5 still with its engineer.
function seed(db) {
  const review = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "in_review", executionState: waitingOnMe };
  const working = { id: uuid(), identifier: "ACM-5", companyId: ids.company, status: "in_progress" };
  db.issues.push(review, working);
  return { review, working };
}

async function sweepEnv(t, extra = {}) {
  const gh = await startFakeGitHub();
  const env = await setup({ env: { ...RELAY_ENV, GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, ...extra } });
  t.after(async () => {
    await env.close();
    await gh.close();
  });
  const waits = [];
  const relay = createRelay(env.ctx, env.state, { sleep: async (ms) => void waits.push(ms) });
  gh.pulls[REPO] = [];
  return { ...env, gh, relay, waits, open: gh.pulls[REPO] };
}

const merged = (number = 7) => ({
  action: "closed",
  pull_request: { ...pull(number, { title: "chore: unrelated" }), merged: true, merge_commit_sha: "abcdef1234567890" },
  repository: { full_name: "Org/App" },
  sender: { login: "someone" },
});

test("after a merge, a conflicting PR whose review waits on you is sent back, with a note on the PR", async (t) => {
  const { relay, db, gh, open, state } = await sweepEnv(t);
  const { review } = seed(db);
  open.push(pull(8, { mergeable: false }), pull(9, { title: "ACM-5: fine" }));
  // The merged PR names no issue: the sweep still runs, without holding up the webhook.
  assert.match((await relay.handle("pull_request", merged())).ignored, /names no ACM issue/);
  await relay.idle();

  assert.equal(db.patches.length, 1);
  assert.equal(db.patches[0].issueId, review.id);
  assert.equal(db.patches[0].body.status, "in_progress");
  assert.match(db.patches[0].body.comment, /^Changes requested on PR #8: merge conflicts with `main`/);
  assert.match(db.patches[0].body.comment, /since PR #7 was merged/);
  assert.match(db.patches[0].body.comment, /`change-8`.*`origin\/main`/s);
  assert.equal(gh.comments.length, 1);
  assert.equal(gh.comments[0].number, 8);
  assert.match(gh.comments[0].body, /Sent back for merge conflicts.*ACM-1 was returned to its agent with changes requested\. Attempt 1 of 2/s);
  assert.ok(gh.comments[0].body.endsWith(HELPER_MARK));
  // Only PRs into the merged PR's base branch were listed.
  assert.ok(gh.requests.some((r) => r.method === "GET" && /\/pulls\?.*base=main/.test(r.path)));
  assert.deepEqual(state.conflicts.get("org/app#8").attempts, 1);
  assert.equal(relay.stats.conflicts.sentBack, 1);
});

test("a PR is sent back once per push, and left to you when the attempts run out", async (t) => {
  const { relay, db, gh, open } = await sweepEnv(t);
  const { review } = seed(db);
  const conflicted = pull(8, { mergeable: false });
  open.push(conflicted);
  const again = () => {
    review.status = "in_review"; // the agent handed it back
    review.executionState = waitingOnMe;
  };

  assert.equal((await relay.sweepConflicts(REPO))[0].action, "changes");
  again();
  assert.match((await relay.sweepConflicts(REPO))[0].reason, /already sent back, waiting for a push/);
  assert.equal(db.patches.length, 1);

  conflicted.head = { ...conflicted.head, sha: "sha-8-b" }; // pushed, still conflicts
  assert.deepEqual((await relay.sweepConflicts(REPO))[0], { pr: 8, attempt: 2, identifier: "ACM-1", action: "changes" });
  assert.match(gh.comments.at(-1).body, /Attempt 2 of 2/);
  again();

  conflicted.head = { ...conflicted.head, sha: "sha-8-c" };
  assert.deepEqual((await relay.sweepConflicts(REPO))[0], { pr: 8, action: "give up", attempts: 2 });
  assert.match(gh.comments.at(-1).body, /Still conflicts with `main` after 2 attempts.*needs you/s);
  conflicted.head = { ...conflicted.head, sha: "sha-8-d" };
  await relay.sweepConflicts(REPO);
  assert.equal(db.patches.length, 2);
  assert.equal(gh.comments.length, 3); // told once

  // Resolved, then conflicting again later: a new conflict, counted from one.
  conflicted.mergeable = true;
  assert.equal((await relay.sweepConflicts(REPO))[0].action, "clean");
  conflicted.mergeable = false;
  assert.equal((await relay.sweepConflicts(REPO))[0].attempt, 1);
});

test("when the review isn't waiting on you, the agent gets a comment and no decision is recorded", async (t) => {
  const { relay, db, gh, open } = await sweepEnv(t);
  const { working } = seed(db);
  open.push(pull(9, { title: "ACM-5: thing", mergeable: false }));
  const [result] = await relay.sweepConflicts(REPO);
  assert.equal(result.action, "comment");
  assert.equal(db.patches.length, 0);
  assert.equal(db.comments.at(-1).issueId, working.id);
  assert.match(gh.comments[0].body, /a comment on ACM-5 asked its agent/);
});

test("drafts, PRs naming no issue, finished issues and clean PRs are left alone", async (t) => {
  const { relay, db, gh, open } = await sweepEnv(t);
  db.issues.push({ id: uuid(), identifier: "ACM-3", companyId: ids.company, status: "done" });
  open.push(
    pull(1, { draft: true, mergeable: false }),
    pull(2, { title: "chore: bump", head: { ref: "deps", sha: "x" }, mergeable: false }),
    pull(3, { title: "ACM-3: old", head: { ref: "acm-3", sha: "y" }, mergeable: false }),
    pull(4, { title: "ACM-77: gone", head: { ref: "acm-77", sha: "z" }, mergeable: false }),
    pull(5),
  );
  const results = await relay.sweepConflicts(REPO);
  assert.deepEqual(
    results.map((r) => r.reason ?? r.action),
    ["draft", "names no Paperclip issue", "ACM-3 is done", "no Paperclip issue found for ACM-77", "clean"],
  );
  assert.equal(db.patches.length + db.comments.length + gh.comments.length, 0);
});

test("GitHub is asked again while it works out whether a PR merges, and the PR is skipped if it never says", async (t) => {
  const { relay, db, open, waits } = await sweepEnv(t);
  seed(db);
  open.push(pull(8, { mergeable: [null, null, false] }), pull(9, { title: "ACM-5: x", mergeable: null }));
  const results = await relay.sweepConflicts(REPO);
  assert.equal(results[0].action, "changes");
  assert.match(results[1].reason, /hasn't worked out yet/);
  assert.equal(waits.length, 2 + 4);
  assert.equal(db.comments.filter((c) => c.via === "comment").length, 0);
});

test("RELAY_CONFLICT_PR_COMMENT=false, or a token that can't write, still sends the PR back", async (t) => {
  const quiet = await sweepEnv(t, { RELAY_CONFLICT_PR_COMMENT: "false" });
  seed(quiet.db);
  quiet.open.push(pull(8, { mergeable: false }));
  assert.equal((await quiet.relay.sweepConflicts(REPO))[0].action, "changes");
  assert.equal(quiet.gh.requests.filter((r) => r.method === "POST").length, 0);

  const readOnly = await sweepEnv(t);
  seed(readOnly.db);
  readOnly.open.push(pull(8, { mergeable: false }));
  readOnly.gh.fail["POST comments"] = 403;
  assert.equal((await readOnly.relay.sweepConflicts(REPO))[0].action, "changes");
  assert.equal(readOnly.db.patches.length, 1);
  const warning = readOnly.logs.find((l) => l.msg === "relay: could not comment on the PR");
  assert.match(warning.error, /Pull requests: read and write/);
});

test("dry run sends nothing back, comments on nothing and remembers nothing", async (t) => {
  const { relay, db, gh, open, state } = await sweepEnv(t, { DRY_RUN: "true" });
  seed(db);
  open.push(pull(8, { mergeable: false }));
  assert.equal((await relay.sweepConflicts(REPO))[0].action, "changes (dry run)");
  assert.equal(db.patches.length + db.comments.length + gh.comments.length, 0);
  assert.equal(state.conflicts.size, 0);
});

test("what was sent back survives a restart, and closed PRs are forgotten", async (t) => {
  const { relay, db, ctx, open } = await sweepEnv(t);
  const { review } = seed(db);
  open.push(pull(8, { mergeable: false }));
  await relay.sweepConflicts(REPO);
  review.status = "in_review";
  review.executionState = waitingOnMe;

  const state = createStateStore(ctx.config.stateFile);
  const restarted = createRelay(ctx, state, { sleep: async () => {} });
  assert.match((await restarted.sweepConflicts(REPO))[0].reason, /already sent back/);
  assert.equal(db.patches.length, 1);
  open[0].state = "closed";
  await restarted.sweepConflicts(REPO);
  assert.equal(state.conflicts.size, 0);
});

test("the helper's own PR comment is not copied back to Paperclip, and one failing PR doesn't stop the rest", async (t) => {
  const { relay, db, open, gh } = await sweepEnv(t);
  seed(db);
  const comment = {
    action: "created",
    issue: { number: 8, title: "ACM-1: thing", body: "", pull_request: {} },
    comment: { body: `**Sent back for merge conflicts.**\n\n${HELPER_MARK}`, html_url: "https://github.com/org/app/pull/8#c1" },
    repository: { full_name: "Org/App" },
    sender: { login: "owner" },
  };
  assert.deepEqual(await relay.handle("issue_comment", comment), { ignored: "the helper's own comment" });
  assert.equal(db.comments.length, 0);

  open.push(pull(8, { mergeable: false }), pull(9, { title: "ACM-5: x", mergeable: false }));
  gh.fail["GET pull 8"] = 500;
  const results = await relay.sweepConflicts(REPO);
  assert.deepEqual(results.map((r) => r.action), ["error", "comment"]);
  assert.match(relay.stats.conflicts.lastError, /pulls\/8 → 500/);
});

test("without RELAY_FIX_CONFLICTS a merge sweeps nothing, and a bad token is explained", async (t) => {
  const off = await sweepEnv(t, { RELAY_FIX_CONFLICTS: "false" });
  seed(off.db);
  off.open.push(pull(8, { mergeable: false }));
  await off.relay.handle("pull_request", merged());
  await off.relay.idle();
  assert.equal(off.gh.requests.length, 0);
  assert.equal(off.relay.stats.conflicts, undefined);

  const bad = await sweepEnv(t, { GITHUB_TOKEN: "ghp_wrongwrongwrongwrong" });
  await assert.rejects(bad.relay.sweepConflicts(REPO), /GitHub rejected GITHUB_TOKEN/);
});

test("GitHub tokens are masked in logs", () => {
  assert.equal(redact("Bearer ghp_abcdefghijklmnopqrstuvwxyz012345"), "Bearer ghp_***");
  assert.equal(redact("github_pat_11ABCDEFG0abcdefghijklmn_opqrstuv"), "github_pat_***");
  assert.deepEqual(redact({ githubToken: "anything" }), { githubToken: "***" });
});
