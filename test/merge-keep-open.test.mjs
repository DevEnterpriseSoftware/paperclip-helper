import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { createRelay } from "../src/relay.mjs";

// Approve-on-merge closes an issue only when the merge finishes it.
const REPO = "org/app";
const HOUR = 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const MARKER = "Merge does not complete this issue";

async function keepEnv(t, extra = {}) {
  const gh = await startFakeGitHub();
  const env = await setup({
    env: { GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, GITHUB_REPOS: REPO, GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "Owner", RELAY_PORT: "0", ...extra },
  });
  t.after(async () => {
    await env.close();
    await gh.close();
  });
  env.db.simulateWakes = true;
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "claude_local" };
  env.db.agents.push(engineer);
  return { ...env, gh, engineer, relay: createRelay(env.ctx, env.state, { sleep: async () => {} }) };
}

let n = 500;
// An issue the engineer handed to review, now at the board's approval stage, with
// the hand-off comment that sent it there.
function inReview(env, { handOff = "Fixed the parser bug in PR #12. Ready for review.", description = "Run the proofs.", ...fields } = {}) {
  n += 1;
  const at = Date.now() - HOUR;
  const issue = {
    id: uuid(), identifier: `ACM-${n}`, companyId: ids.company, title: "Verify the release", description, status: "in_review",
    assigneeAgentId: null, assigneeUserId: ids.user, updatedAt: iso(at),
    executionState: {
      status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user },
      returnAssignee: { type: "agent", agentId: env.engineer.id },
    },
    ...fields,
  };
  env.db.issues.push(issue);
  env.db.comments.push({ id: uuid(), issueId: issue.id, identifier: issue.identifier, authorType: "agent", authorAgentId: env.engineer.id, authorUserId: null, body: handOff, createdAt: iso(at) });
  env.db.activity.push({ id: uuid(), action: "issue.updated", entityType: "issue", entityId: issue.id, actorType: "agent", actorId: env.engineer.id, agentId: env.engineer.id,
    createdAt: iso(at), details: { changes: { status: { from: "in_progress", to: "in_review" } } } });
  return issue;
}

const merged = (issue, number = 12, sender = "Owner") => ({
  action: "closed",
  pull_request: { ...pull(number, { title: `${issue.identifier}: fix the parser` }), merged: true, merge_commit_sha: "abcdef1234567890" },
  repository: { full_name: REPO },
  sender: { login: sender },
});
const runsFor = (env, issue) => (env.db.issueRuns[issue.id] ?? []).filter((r) => r.status === "queued");

test("the marker in the hand-off: the merge is relayed, the stage isn't approved, and the implementer gets the issue back", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env, { handOff: `Fixed the defect proof 1 found, in PR #12.\n\n${MARKER.toLowerCase()}: the proofs resume after it merges.` });
  const result = await env.relay.handle("pull_request", merged(issue));
  assert.equal(result.action, "changes");
  assert.equal(issue.status, "in_progress");
  assert.equal(issue.assigneeAgentId, env.engineer.id);
  assert.equal(env.db.patches.length, 1);
  assert.equal(env.db.patches[0].body.status, "in_progress");
  assert.equal(
    env.db.patches[0].body.comment,
    "PR #12 merged (`abcdef123456`). This issue says the merge doesn't complete it, so it's back with you for the rest of the work.\n\n" +
      "https://github.com/org/app/pull/12\n\n_Relayed from GitHub by Paperclip Helper._",
  );
  assert.equal(runsFor(env, issue).length, 1, "the implementer was woken");
  assert.equal(runsFor(env, issue)[0].agentId, env.engineer.id);
});

test("the marker in the issue's description, or its review request, keeps it open too", async (t) => {
  const env = await keepEnv(t);
  const described = inReview(env, { description: `Run the five proofs.\n\n${MARKER}.` });
  assert.equal((await env.relay.handle("pull_request", merged(described, 13))).action, "changes");
  const requested = inReview(env);
  requested.executionState.reviewRequest = { instructions: `Check the fix only. ${MARKER}.` };
  assert.equal((await env.relay.handle("pull_request", merged(requested, 14))).action, "changes");
  assert.equal(described.status, "in_progress");
  assert.equal(requested.status, "in_progress");
});

test("no marker and no open children: approved and done, as before", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env);
  const result = await env.relay.handle("pull_request", merged(issue));
  assert.equal(result.action, "approve");
  assert.equal(issue.status, "done");
  assert.match(env.db.patches[0].body.comment, /^Approved: PR #12 merged/);
});

test("the marker in an earlier hand-off, before the issue last went to review, doesn't count", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env);
  // An old comment from a previous round, well before the latest move to review.
  env.db.comments.unshift({ id: uuid(), issueId: issue.id, authorType: "agent", authorAgentId: env.engineer.id, body: `Step 1 of 3. ${MARKER}.`, createdAt: iso(Date.now() - 5 * HOUR) });
  assert.equal((await env.relay.handle("pull_request", merged(issue))).action, "approve");
  assert.equal(issue.status, "done");
});

test("open child issues keep it open with RELAY_MERGE_KEEP_OPEN_CHILDREN; without the setting, as before", async (t) => {
  for (const [setting, action, status] of [["true", "changes", "in_progress"], ["false", "approve", "done"]]) {
    const env = await keepEnv(t, { RELAY_MERGE_KEEP_OPEN_CHILDREN: setting });
    const issue = inReview(env);
    env.db.issues.push(
      { id: uuid(), identifier: "ACM-601", companyId: ids.company, parentId: issue.id, status: "todo" },
      { id: uuid(), identifier: "ACM-602", companyId: ids.company, parentId: issue.id, status: "done" },
    );
    const result = await env.relay.handle("pull_request", merged(issue));
    assert.equal(result.action, action, setting);
    assert.equal(issue.status, status, setting);
    if (setting === "true") assert.match(env.db.patches[0].body.comment, /This issue still has open child issues \(ACM-601\), so it's back with you/);
  }
});

test("a done or cancelled issue is left as it is; an empty marker setting turns the check off; a dry run changes nothing", async (t) => {
  const env = await keepEnv(t);
  const done = inReview(env, { handOff: MARKER, status: "done", executionState: null });
  assert.equal((await env.relay.handle("pull_request", merged(done, 20))).action, "none");
  const cancelled = inReview(env, { handOff: MARKER, status: "cancelled", executionState: null });
  await env.relay.handle("pull_request", merged(cancelled, 21));
  assert.equal(done.status, "done");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(env.db.patches.length, 0);

  const off = await keepEnv(t, { RELAY_MERGE_KEEP_OPEN_MARKER: "" });
  const issue = inReview(off, { handOff: MARKER });
  assert.equal((await off.relay.handle("pull_request", merged(issue))).action, "approve");

  const custom = await keepEnv(t, { RELAY_MERGE_KEEP_OPEN_MARKER: "Part of a series" });
  const step = inReview(custom, { handOff: "This PR is part of a series." });
  assert.equal((await custom.relay.handle("pull_request", merged(step))).action, "changes");

  const dry = await keepEnv(t, { DRY_RUN: "true" });
  const kept = inReview(dry, { handOff: MARKER });
  assert.equal((await dry.relay.handle("pull_request", merged(kept))).action, "changes (dry run)");
  assert.equal(dry.db.patches.length, 0);
});

test("a merge by someone else is only noted, marker or not", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env, { handOff: MARKER });
  await env.relay.handle("pull_request", merged(issue, 12, "carla"));
  assert.equal(issue.status, "in_review");
  assert.equal(env.db.patches.length, 0);
});

test("a board move back to review afterwards (the resume sweep's restore) doesn't hide the implementer's hand-off", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env, { handOff: `Fixed it in PR #12. ${MARKER}.` });
  // Ten minutes ago the board moved it from blocked back to review.
  env.db.activity.push({ id: uuid(), action: "issue.updated", entityType: "issue", entityId: issue.id, actorType: "user", actorId: ids.user,
    createdAt: iso(Date.now() - 10 * 60_000), details: { changes: { status: { from: "blocked", to: "in_review" } } } });
  assert.equal((await env.relay.handle("pull_request", merged(issue))).action, "changes");
  assert.equal(issue.status, "in_progress");
});

test("when Paperclip refuses the hand-back, the relay comments and leaves the issue open, never done", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env, { handOff: MARKER });
  env.fake.fail("PATCH", `/api/issues/${issue.identifier}`, 422, { times: -1, body: { error: "This execution stage has no return assignee" } });
  const result = await env.relay.handle("pull_request", merged(issue));
  assert.equal(result.action, "comment");
  assert.equal(issue.status, "in_review");
  const note = env.db.comments.filter((c) => c.issueId === issue.id && c.via).at(-1);
  assert.match(note.body, /This issue says the merge doesn't complete it/);
  assert.match(note.body, /Paperclip refused to return the issue \(.*no return assignee.*\): it is left as it was for you to decide/);
});

test("unfinishedWork: open checklist items and sections still to do; ticked items, quoted code and plain proofs sections don't count", async () => {
  const { unfinishedWork } = await import("../src/decisions.mjs");
  assert.equal(unfinishedWork("Fix it.\n\n- [x] parser\n- [ ] proof 2\n* [ ] proof 3"), "2 open checklist items");
  assert.equal(unfinishedWork("## Proofs\n\n- [x] proof 1\n- [x] proof 2"), null);
  assert.equal(unfinishedWork("## Proofs\n\nProof 1 passed. Proof 2 still to run."), "a section still to do (Proofs)");
  assert.equal(unfinishedWork("## Proofs\n\nAll five passed on the release build."), null);
  assert.equal(unfinishedWork("## Remaining\n\nThe Windows installer."), "a section still to do (Remaining)");
  assert.equal(unfinishedWork("## Remaining\n\n"), null);
  assert.equal(unfinishedWork("Template:\n\n```\n- [ ] step\n```"), null);
  assert.equal(unfinishedWork("1. [ ] first\n\n## To do\n\nship"), "1 open checklist item and a section still to do (To do)");
  assert.equal(unfinishedWork(null), null);
});

test("no marker but open checklist items: closed on merge as before, with a line in the merge comment", async (t) => {
  const env = await keepEnv(t);
  const issue = inReview(env, { description: "Run the proofs.\n\n- [x] proof 1\n- [ ] proof 2\n- [ ] proof 3" });
  const result = await env.relay.handle("pull_request", merged(issue));
  assert.equal(result.action, "approve");
  assert.equal(issue.status, "done", "the close isn't changed");
  assert.equal(env.db.patches.length, 1);
  assert.match(
    env.db.patches[0].body.comment,
    /^Approved: PR #12 merged[\s\S]*\n\n_Closed on merge, though the description still lists 2 open checklist items\. If this PR was only a step, reopen the issue and add the marker \("Merge does not complete this issue"\)\._\n\n_Relayed from GitHub by Paperclip Helper\._$/,
  );
  assert.ok(env.logs.some((l) => /description still lists work to do/.test(l.msg)));
});

test("no unfinished work, the marker, or an approval that isn't the last stage: no such line", async (t) => {
  const env = await keepEnv(t);
  const finished = inReview(env, { description: "- [x] proof 1\n- [x] proof 2" });
  await env.relay.handle("pull_request", merged(finished, 30));
  assert.doesNotMatch(env.db.patches.at(-1).body.comment, /Closed on merge/);

  const marked = inReview(env, { description: `- [ ] proof 2\n\n${MARKER}.` });
  assert.equal((await env.relay.handle("pull_request", merged(marked, 31))).action, "changes");
  assert.doesNotMatch(env.db.patches.at(-1).body.comment, /Closed on merge/);

  // The approval stage is the first of two: this approval moves it on, it doesn't close it.
  const early = inReview(env, { description: "- [ ] proof 2", executionPolicy: { stages: [{ id: "s1", type: "approval" }, { id: "s2", type: "approval" }] } });
  early.executionState.currentStageId = "s1";
  early.executionState.currentStageIndex = 0;
  await env.relay.handle("pull_request", merged(early, 32));
  assert.doesNotMatch(env.db.patches.at(-1).body.comment, /Closed on merge/);
});
