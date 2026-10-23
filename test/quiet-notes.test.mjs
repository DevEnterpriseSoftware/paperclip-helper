import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull } from "./fake-github.mjs";
import { createRelay } from "../src/relay.mjs";
import * as cmd from "../src/commands.mjs";
import { answerFor, findCard } from "../src/answer.mjs";

const ENV = { GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "Owner", GITHUB_REPOS: "org/app", RELAY_PORT: "0" };

async function notesEnv(t, extra = {}) {
  const env = await setup({ env: { ...ENV, ...extra } });
  t.after(env.close);
  env.db.simulateWakes = true;
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "claude_local" };
  env.db.agents.push(engineer);
  const issue = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "in_progress", assigneeAgentId: engineer.id };
  env.db.issues.push(issue);
  return { ...env, issue, relay: createRelay(env.ctx, env.state, { sleep: async () => {} }) };
}

const event = (action, extra = {}, sender = "carla") => ({ action, pull_request: { ...pull(12, { title: "ACM-1: change" }), ...extra }, repository: { full_name: "org/app" }, sender: { login: sender } });

test("PR notes go in the issue's pull-requests document, which wakes nobody", async (t) => {
  const env = await notesEnv(t);
  assert.equal((await env.relay.handle("pull_request", event("opened"))).action, "note");
  await env.relay.handle("pull_request", event("closed", { merged: false }));
  await env.relay.handle("pull_request", event("reopened"));
  await env.relay.handle("pull_request", event("closed", { merged: true, merge_commit_sha: "abc" }, "someone"));
  const doc = env.db.documents[env.issue.id]["pull-requests"];
  assert.match(doc.body, /^# Pull requests\n\n_Kept by Paperclip Helper's relay/);
  const lines = doc.body.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^- \d{4}-\d\d-\d\d \d\d:\d\d UTC: PR #12 opened by @carla: https:\/\/github\.com\/org\/app\/pull\/12$/);
  assert.match(lines[1], /PR #12 was closed without merging by @carla/);
  assert.match(lines[3], /PR #12 was merged by @someone, not by the approver/);
  assert.equal(env.db.comments.length, 0);
  assert.equal(Object.values(env.db.issueRuns).flat().length, 0, "nobody woken");
});

test("an update that loses the race is tried again on the latest revision; a refused document falls back to a comment", async (t) => {
  const env = await notesEnv(t);
  await env.relay.handle("pull_request", event("opened"));
  env.fake.fail("PUT", `/api/issues/ACM-1/documents/pull-requests`, 409, { body: { error: "Document was updated by someone else" } });
  await env.relay.handle("pull_request", event("reopened"));
  assert.equal(env.db.documents[env.issue.id]["pull-requests"].body.split("\n").filter((l) => l.startsWith("- ")).length, 2);

  env.fake.fail("PUT", `/api/issues/ACM-1/documents/pull-requests`, 403, { times: -1, body: { error: "Forbidden" } });
  const result = await env.relay.handle("pull_request", event("reopened"));
  assert.equal(result.action, "comment");
  assert.match(env.db.comments.at(-1).body, /PR #12 reopened by @carla/);
});

test("a person's additions to the notes are kept; a document the relay didn't start, or a locked one, gets a comment instead", async (t) => {
  const env = await notesEnv(t);
  await env.relay.handle("pull_request", event("opened"));
  const doc = env.db.documents[env.issue.id]["pull-requests"];
  doc.body = doc.body.replace("# Pull requests", "# Pull requests\n\nReviewer: Rex (added by hand)");
  await env.relay.handle("pull_request", event("reopened"));
  assert.match(env.db.documents[env.issue.id]["pull-requests"].body, /Reviewer: Rex \(added by hand\)[\s\S]*opened[\s\S]*reopened/);

  const theirs = await notesEnv(t);
  theirs.db.documents[theirs.issue.id] = { "pull-requests": { key: "pull-requests", body: "# PRs\n\nThe agent's own list.", latestRevisionId: uuid() } };
  assert.equal((await theirs.relay.handle("pull_request", event("opened"))).action, "comment");
  assert.equal(theirs.db.documents[theirs.issue.id]["pull-requests"].body, "# PRs\n\nThe agent's own list.");

  const locked = await notesEnv(t);
  await locked.relay.handle("pull_request", event("opened"));
  locked.db.documents[locked.issue.id]["pull-requests"].lockedAt = new Date().toISOString();
  const puts = () => locked.fake.requests.filter((r) => r.method === "PUT").length;
  const before = puts();
  assert.equal((await locked.relay.handle("pull_request", event("reopened"))).action, "comment");
  assert.equal(puts() - before, 1, "a locked document isn't retried");
});

// ---------------------------------------------------------------- pch answer

const textCard = {
  id: "c0ffee00-0000-4000-8000-000000000001", kind: "ask_user_questions", status: "pending",
  payload: { questions: [{ id: "closure", prompt: "How should this close?", allowOther: true, required: true, options: [{ id: "paperclip_text_answer", label: "Type an answer", freeText: true }] }] },
};
const choiceCard = {
  id: "c0ffee00-0000-4000-8000-000000000002", kind: "ask_user_questions", status: "pending",
  payload: { questions: [{ id: "env", prompt: "Which environment?", options: [{ id: "staging", label: "Staging" }, { id: "prod", label: "Production" }] }] },
};

test("pch answer sends a typed answer the way the UI does, and picks an option by its label", async (t) => {
  const env = await notesEnv(t);
  env.db.interactions[env.issue.id] = [structuredClone(textCard), structuredClone(choiceCard)];
  const out = await captureOutput(() => cmd.answer(env.ctx, "ACM-1", "c0ffee00-0000-4000-8000-000000000001", "Close it as done; the fix shipped in #12."));
  assert.deepEqual(out, ['Answered card c0ffee00-0000-4000-8000-000000000001 on ACM-1: "How should this close?" → Close it as done; the fix shipped in #12.']);
  const respond = env.fake.requests.find((r) => r.method === "POST" && /\/respond$/.test(r.path));
  assert.deepEqual(respond.body, { answers: [{ questionId: "closure", optionIds: [], otherText: "Close it as done; the fix shipped in #12." }] });
  assert.equal(env.db.interactions[env.issue.id][0].status, "answered");

  await captureOutput(() => cmd.answer(env.ctx, "ACM-1", "c0ffee00-0000-4000-8000-000000000002", "production"));
  assert.deepEqual(env.db.interactions[env.issue.id][1].result.answers, [{ questionId: "env", optionIds: ["prod"] }]);
});

test("Paperclip (and the fake) refuse the answer format that failed by hand: a text field instead of otherText", async (t) => {
  const env = await notesEnv(t);
  env.db.interactions[env.issue.id] = [structuredClone(textCard)];
  await assert.rejects(
    () => env.ctx.api.request("POST", `/api/issues/ACM-1/interactions/${textCard.id}/respond`, { answers: [{ questionId: "closure", optionIds: ["paperclip_text_answer"], text: "done" }] }),
    /requires an answer/,
  );
});

test("pch answer refuses what it can't answer, and lists the pending cards", async () => {
  assert.throws(() => findCard([textCard], "nope"), /No pending card matches "nope"\. Pending cards on this issue:\n  c0ffee00-0000-4000-8000-000000000001  ask_user_questions: How should this close\?/);
  assert.throws(() => findCard([textCard, choiceCard], "c0ffee"), /Several pending cards start with "c0ffee"/);
  assert.equal(findCard([textCard, choiceCard], "c0ffee00-0000-4000-8000-000000000002").id, choiceCard.id);
  assert.throws(() => answerFor(choiceCard, "QA"), /"Which environment\?" takes one of: Staging, Production\./);
  assert.throws(() => answerFor({ ...textCard, kind: "request_confirmation" }, "yes"), /request_confirmation, not questions/);
  const two = { ...textCard, payload: { questions: [...textCard.payload.questions, choiceCard.payload.questions[0]] } };
  assert.throws(() => answerFor(two, "x"), /asks 2 questions/);
  assert.throws(() => answerFor(textCard, "  "), /usage: pch answer/);
  assert.throws(() => findCard([textCard], "c0f"), /is too short/);
  // A label wins over an id that reads like another label.
  const tricky = { ...choiceCard, payload: { questions: [{ id: "q", prompt: "Ship?", options: [{ id: "yes", label: "No" }, { id: "y2", label: "Yes" }] }] } };
  assert.deepEqual(answerFor(tricky, "yes").body.answers[0].optionIds, ["y2"]);
  const multi = { ...choiceCard, payload: { questions: [{ ...choiceCard.payload.questions[0], selectionMode: "multi" }] } };
  assert.throws(() => answerFor(multi, "Staging"), /takes several answers/);
});
