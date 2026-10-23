import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createRelay } from "../src/relay.mjs";
import { prRefs, stagesWipe } from "../src/stages.mjs";

const REPO = "org/app";
const HOUR = 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const stages = [{ id: "s1", type: "review", participants: [{ type: "agent", agentId: "arch" }] }];
const waitingOnMe = { status: "pending", currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user } };

async function stagesEnv(t, extra = {}) {
  const gh = await startFakeGitHub();
  const env = await setup({
    env: {
      WATCHDOG_STALL_SEC: "180", GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, GITHUB_REPOS: REPO,
      GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "Owner", RELAY_PORT: "0", WATCHDOG_NOTIFY_ISSUE: "ACM-90", ...extra,
    },
  });
  t.after(async () => {
    await env.close();
    await gh.close();
  });
  gh.pulls[REPO] = [];
  const codex = { id: uuid(), companyId: ids.company, name: "Codex Engineer", status: "idle", adapterType: "codex_local" };
  env.db.agents.push(codex);
  env.db.issues.push({ id: uuid(), identifier: "ACM-90", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: iso(Date.now()) });
  return { ...env, gh, codex, watchdog: createWatchdog(env.ctx, env.state), relay: createRelay(env.ctx, env.state, { sleep: async () => {} }) };
}

// The update in which an agent sent `executionPolicy: { stages: [] }`.
function wipe(db, issue, agent) {
  db.activity.push({
    id: uuid(), action: "issue.updated", entityType: "issue", entityId: issue.id, actorType: "agent", actorId: agent.id, agentId: agent.id,
    createdAt: iso(Date.now() - HOUR), details: { executionPolicy: { stages: [] }, changes: { executionPolicy: { from: { stages }, to: null } } },
  });
}

function doneIssue(env, n, extra = {}) {
  const issue = { id: uuid(), identifier: `ACM-${n}`, companyId: ids.company, status: "done", assigneeAgentId: env.codex.id, executionPolicy: null, updatedAt: iso(Date.now() - HOUR), ...extra };
  env.db.issues.push(issue);
  return issue;
}

test("a done issue whose own PR is still open is reopened, with a note for the board, once", async (t) => {
  const env = await stagesEnv(t);
  const issue = doneIssue(env, 5);
  wipe(env.db, issue, env.codex);
  env.db.workProducts[issue.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/12" }];
  env.gh.pulls[REPO].push(pull(12, { title: "ACM-5: the change" }));

  await env.watchdog.tick();
  assert.equal(issue.status, "in_progress");
  const [patch] = env.db.patches;
  assert.equal(patch.body.status, "in_progress");
  assert.match(patch.body.comment, /^This issue was closed while PR #12 was still open and unreviewed, so the watchdog has reopened it\. Its review stages were wiped \(by Codex Engineer, /);
  assert.match(patch.body.comment, /the board or the architect must restore them/);
  assert.match(patch.body.comment, /_Paperclip Helper watchdog\._$/);
  const note = env.db.comments.find((c) => c.identifier === "ACM-90");
  assert.match(note.body, /^ACM-5 was closed while PR #12 was still open and unreviewed; the watchdog reopened it\. Its review stages were wiped by Codex Engineer: restore them\./);

  // Closed again by the agent: not reopened a second time, the board is told instead.
  // (A new watchdog: one scan per stall window, and the issue has changed.)
  issue.status = "done";
  issue.updatedAt = iso(Date.now() - HOUR / 2);
  const later = createWatchdog(env.ctx, env.state);
  await later.tick();
  assert.equal(issue.status, "done");
  assert.equal(env.watchdog.stats.reopened, 1);
  const notes = env.db.comments.filter((c) => c.identifier === "ACM-90");
  assert.equal(notes.length, 2);
  assert.match(notes[1].body, /^ACM-5 was closed again while PR #12 is still open and unreviewed\. The watchdog won't reopen it twice/);
});

test("once reopened, the board isn't told about the same wipe again while the issue is in progress", async (t) => {
  const env = await stagesEnv(t);
  const issue = doneIssue(env, 20);
  wipe(env.db, issue, env.codex);
  env.db.workProducts[issue.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/20" }];
  env.gh.pulls[REPO].push(pull(20, { title: "ACM-20: the change" }));
  await env.watchdog.tick();
  assert.equal(issue.status, "in_progress");
  issue.updatedAt = iso(Date.now() - HOUR / 2);
  await createWatchdog(env.ctx, env.state).tick();
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-90").length, 1);
});

test("a reopen Paperclip refuses is logged, and never reported as closed again", async (t) => {
  const env = await stagesEnv(t);
  const issue = doneIssue(env, 21);
  wipe(env.db, issue, env.codex);
  env.db.workProducts[issue.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/21" }];
  env.gh.pulls[REPO].push(pull(21, { title: "ACM-21: the change" }));
  env.fake.fail("PATCH", `/api/issues/${issue.id}`, 403, { times: -1, body: { error: "Forbidden" } });
  await env.watchdog.tick();
  assert.equal(issue.status, "done");
  assert.equal(env.logs.filter((l) => /couldn't reopen a done issue/.test(l.msg)).length, 1);
  issue.updatedAt = iso(Date.now() - HOUR / 2);
  await createWatchdog(env.ctx, env.state).tick();
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-90").length, 0);
  assert.equal(env.logs.filter((l) => /couldn't reopen a done issue/.test(l.msg)).length, 1);
});

test("the relay's note in the pull-requests document is enough to find the PR", async (t) => {
  const env = await stagesEnv(t);
  const issue = doneIssue(env, 80);
  wipe(env.db, issue, env.codex);
  env.gh.pulls[REPO].push(pull(80, { title: "ACM-80: change" }));
  await env.relay.handle("pull_request", { action: "opened", pull_request: pull(80, { title: "ACM-80: change" }), repository: { full_name: REPO }, sender: { login: "carla" } });
  assert.equal(env.db.comments.filter((c) => c.issueId === issue.id).length, 0, "the link went in the document");
  await env.watchdog.tick();
  assert.equal(issue.status, "in_progress");
});

test("a done issue whose PR merged, or is another issue's, or was closed, is left alone", async (t) => {
  const env = await stagesEnv(t);
  const merged = doneIssue(env, 6);
  for (const issue of env.db.issues.filter((i) => i.status === "done")) wipe(env.db, issue, env.codex);
  env.db.workProducts[merged.id] = [{ type: "pull_request", metadata: { repo: REPO, number: 13 } }];
  env.gh.pulls[REPO].push(pull(13, { title: "ACM-6", state: "closed", merged: true }));
  const others = doneIssue(env, 7);
  env.db.comments.push({ issueId: others.id, body: "Follow-up in https://github.com/org/app/pull/14" });
  env.gh.pulls[REPO].push(pull(14, { title: "ACM-8: something else (see ACM-7)" }));
  const closed = doneIssue(env, 9);
  env.db.workProducts[closed.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/15" }];
  env.gh.pulls[REPO].push(pull(15, { title: "ACM-9", state: "closed" }));
  for (const issue of [others, closed]) wipe(env.db, issue, env.codex);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  assert.equal(env.db.comments.filter((c) => c.via).length, 0);
});

test("never reopened: no wipe on record, a person removed the stages, a revert opened after it was done, stages restored", async (t) => {
  const env = await stagesEnv(t);
  const pr = (n, extra = {}) => env.gh.pulls[REPO].push(pull(n, { title: `ACM-${n}: change`, ...extra }));
  // A team that doesn't use stages: done while the PR waits for a merge is how it works.
  const plain = doneIssue(env, 60);
  env.db.workProducts[plain.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/60" }];
  pr(60);
  // A person took the stages off on purpose.
  const byPerson = doneIssue(env, 61);
  env.db.workProducts[byPerson.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/61" }];
  pr(61);
  env.db.activity.push({ id: uuid(), action: "issue.updated", entityType: "issue", entityId: byPerson.id, actorType: "user", actorId: ids.user,
    createdAt: iso(Date.now() - HOUR), details: { changes: { executionPolicy: { from: { stages }, to: null } } } });
  // A revert opened after the issue was done (approved properly before).
  const reverted = doneIssue(env, 62, { completedAt: iso(Date.now() - 2 * HOUR) });
  wipe(env.db, reverted, env.codex);
  env.db.comments.push({ issueId: reverted.id, body: "Reverting in https://github.com/org/app/pull/63" });
  env.gh.pulls[REPO].push(pull(63, { title: 'Revert "ACM-62: change"', created_at: iso(Date.now() - HOUR) }));
  // Wiped, then restored by the board before it closed.
  const restored = doneIssue(env, 64, { executionPolicy: { stages } });
  wipe(env.db, restored, env.codex);
  env.db.workProducts[restored.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/64" }];
  pr(64);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 0);
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-90").length, 0);
});

test("a wipe far back in a busy issue's history still counts", async (t) => {
  const env = await stagesEnv(t);
  const issue = doneIssue(env, 70);
  wipe(env.db, issue, env.codex);
  for (let i = 0; i < 150; i++) env.db.activity.push({ id: uuid(), action: "issue.comment_added", entityType: "issue", entityId: issue.id, actorType: "agent", createdAt: iso(Date.now()) });
  env.db.workProducts[issue.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/70" }];
  env.gh.pulls[REPO].push(pull(70, { title: "ACM-70" }));
  await env.watchdog.tick();
  assert.equal(issue.status, "in_progress");
});

test("an issue in review whose stages an update removed is reported to the board once; one that never had stages isn't", async (t) => {
  const env = await stagesEnv(t);
  const wiped = { id: uuid(), identifier: "ACM-20", companyId: ids.company, status: "in_review", assigneeAgentId: env.codex.id, executionPolicy: null, updatedAt: iso(Date.now() - HOUR) };
  const plain = { id: uuid(), identifier: "ACM-21", companyId: ids.company, status: "in_progress", assigneeAgentId: env.codex.id, executionPolicy: null, updatedAt: iso(Date.now() - HOUR) };
  env.db.issues.push(wiped, plain);
  wipe(env.db, wiped, env.codex);
  await env.watchdog.tick();
  const notes = env.db.comments.filter((c) => c.identifier === "ACM-90");
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^ACM-20 \(in_review\) lost its review stages in an update by Codex Engineer: nothing will review or approve it\./);
  assert.equal(wiped.status, "in_review");
  const again = createWatchdog(env.ctx, env.state);
  await again.tick();
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-90").length, 1);
});

const mergedEvent = (number, title, sender = "Owner") => ({
  action: "closed",
  pull_request: { ...pull(number, { title }), merged: true, merge_commit_sha: "abcdef1234567890" },
  repository: { full_name: REPO },
  sender: { login: sender },
});

test("your merge of an issue's own PR closes it as done when its stages were wiped; a pending approval is decided as before", async (t) => {
  const env = await stagesEnv(t);
  const wiped = { id: uuid(), identifier: "ACM-30", companyId: ids.company, status: "in_progress", assigneeAgentId: env.codex.id, executionPolicy: null };
  env.db.issues.push(wiped);
  wipe(env.db, wiped, env.codex);
  const result = await env.relay.handle("pull_request", mergedEvent(30, "ACM-30: change"));
  assert.equal(result.action, "done");
  assert.equal(wiped.status, "done");
  assert.match(env.db.patches[0].body.comment, /^Approved: PR #30 merged/);
  assert.match(env.db.patches[0].body.comment, /review stages had been wiped/);

  const waiting = { id: uuid(), identifier: "ACM-31", companyId: ids.company, status: "in_review", executionState: waitingOnMe };
  env.db.issues.push(waiting);
  assert.equal((await env.relay.handle("pull_request", mergedEvent(31, "ACM-31"))).action, "approve");
});

test("a merge with no wipe on record, a merge by someone else, or another issue's PR, closes nothing", async (t) => {
  const env = await stagesEnv(t);
  const never = { id: uuid(), identifier: "ACM-40", companyId: ids.company, status: "in_progress", executionPolicy: null };
  const wiped = { id: uuid(), identifier: "ACM-41", companyId: ids.company, status: "in_progress", executionPolicy: null };
  env.db.issues.push(never, wiped);
  wipe(env.db, wiped, env.codex);
  assert.equal((await env.relay.handle("pull_request", mergedEvent(40, "ACM-40"))).action, "comment");
  await env.relay.handle("pull_request", mergedEvent(41, "ACM-41", "someone"));
  // Names another issue first: ACM-41 is only mentioned.
  await env.relay.handle("pull_request", mergedEvent(42, "ACM-40: also touches ACM-41"));
  assert.equal(never.status, "in_progress");
  assert.equal(wiped.status, "in_progress");
  assert.equal(env.db.patches.length, 0);

  // A /approve on the PR before it merges isn't a merge: nothing is closed.
  const approved = await env.relay.handle("issue_comment", {
    action: "created", issue: { number: 41, title: "ACM-41: change", pull_request: {}, html_url: "https://github.com/org/app/pull/41" },
    comment: { body: "/approve looks fine", html_url: "https://github.com/org/app/pull/41#c" }, repository: { full_name: REPO }, sender: { login: "Owner" },
  });
  assert.equal(approved.action, "comment");
  assert.equal(wiped.status, "in_progress");

  const off = await stagesEnv(t, { RELAY_DONE_WITHOUT_STAGES: "false" });
  const issue = { id: uuid(), identifier: "ACM-43", companyId: ids.company, status: "in_progress", executionPolicy: null };
  off.db.issues.push(issue);
  wipe(off.db, issue, off.codex);
  await off.relay.handle("pull_request", mergedEvent(43, "ACM-43"));
  assert.equal(issue.status, "in_progress");
});

test("dry run and WATCHDOG_STAGES_WIPE=false change nothing", async (t) => {
  for (const extra of [{ DRY_RUN: "true" }, { WATCHDOG_STAGES_WIPE: "false" }]) {
    const env = await stagesEnv(t, extra);
    const issue = doneIssue(env, 50);
    env.db.workProducts[issue.id] = [{ type: "pull_request", url: "https://github.com/org/app/pull/50" }];
    env.gh.pulls[REPO].push(pull(50, { title: "ACM-50" }));
    await env.watchdog.tick();
    await env.watchdog.tick();
    assert.equal(issue.status, "done", JSON.stringify(extra));
    assert.equal(env.db.comments.length, 0);
  }
});

test("prRefs and stagesWipe", () => {
  assert.deepEqual(
    prRefs({ workProducts: [{ type: "pull_request", url: "https://github.com/Org/App/pull/3" }, { type: "branch", url: "x" }], texts: ["see https://github.com/org/app/pull/4 and https://github.com/other/repo/pull/5"] }, [REPO]),
    [{ repo: REPO, number: 3 }, { repo: REPO, number: 4 }],
  );
  const entry = (from, to, actorType = "agent") => ({ action: "issue.updated", actorType, details: { changes: { executionPolicy: { from, to } } } });
  assert.equal(stagesWipe([entry({ stages: [] }, { stages })]), null);
  assert.ok(stagesWipe([entry({ stages }, { stages: [] })]));
  assert.ok(stagesWipe([entry({ stages }, null)]));
  assert.equal(stagesWipe([entry({ stages }, null, "user")]), null);
  assert.equal(stagesWipe(null), null);
});
