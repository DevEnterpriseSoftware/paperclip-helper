import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { QUESTION_STATUSES } from "../src/questions.mjs";

// The issue list the card scan asks for (no other check lists these statuses).
const scanQuery = `status=${encodeURIComponent(QUESTION_STATUSES)}`;

// A clock the test moves, so a second tick can come a stall window later.
async function watchdogEnv(t, extra = {}) {
  const clock = { now: Date.now() };
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...extra }, now: () => clock.now });
  t.after(env.close);
  return { ...env, clock, watchdog: createWatchdog(env.ctx, env.state), later: (min) => (clock.now += min * 60_000) };
}

// Carla asks Gilfoyle on her own issue, DIR-479; the wake Paperclip sent him
// was cancelled before it started, as it is for every non-assignee.
function strandedQuestion(db, { askedMinutesAgo = 60, addresseeStatus = "idle", status = "in_review" } = {}) {
  const carla = { id: uuid(), companyId: ids.company, name: "Carla", status: "idle" };
  const gilfoyle = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: addresseeStatus };
  db.agents.push(carla, gilfoyle);
  const issue = {
    id: uuid(),
    identifier: "ACM-479",
    companyId: ids.company,
    status,
    assigneeAgentId: carla.id,
    projectId: "p-1",
    priority: "high",
    updatedAt: minutesAgo(askedMinutesAgo),
  };
  db.issues.push(issue);
  const card = {
    id: uuid(),
    kind: "ask_user_questions",
    status: "pending",
    addresseeAgentId: gilfoyle.id,
    addresseeUserId: null,
    createdByAgentId: carla.id,
    createdAt: minutesAgo(askedMinutesAgo),
    payload: { questions: [{ id: "q", prompt: "May I use a FILE_READ_ATTRIBUTES handle for the rehearsal queries?" }] },
  };
  db.interactions[issue.id] = [card];
  db.issueRuns[issue.id] = [
    { runId: uuid(), agentId: gilfoyle.id, status: "cancelled", errorCode: "issue_assignee_changed", createdAt: minutesAgo(askedMinutesAgo - 1) },
  ];
  return { carla, gilfoyle, issue, card };
}

test("a card Paperclip never delivered gets an issue of its own, assigned to the addressee, once", async (t) => {
  const env = await watchdogEnv(t);
  const { gilfoyle, issue, card } = strandedQuestion(env.db);

  await env.watchdog.tick();
  assert.equal(env.db.created.length, 1);
  const relay = env.db.created[0];
  assert.equal(relay.assigneeAgentId, gilfoyle.id);
  assert.equal(relay.status, "todo");
  assert.equal(relay.projectId, "p-1", "same project as the question");
  assert.equal(relay.priority, "high");
  assert.equal(relay.title, "Answer Carla's question on ACM-479");
  assert.match(relay.description, /FILE_READ_ATTRIBUTES handle/);
  assert.ok(relay.description.includes(`/api/issues/${issue.id}/interactions/${card.id}/respond`));
  assert.match(relay.description, /_Sent automatically by Paperclip Helper's watchdog/);
  assert.equal(env.db.comments.length, 0, "nothing is posted on the source issue");
  assert.equal(env.watchdog.stats.questions, 1);
  assert.ok(env.logs.some((l) => l.msg === "watchdog: routed a question card to its addressee" && l.relay === relay.identifier));

  env.later(5);
  await env.watchdog.tick();
  assert.equal(env.db.created.length, 1, "once per card");
});

test("the issue is closed once the card is answered, and left alone while its run is still going", async (t) => {
  const env = await watchdogEnv(t);
  const { card } = strandedQuestion(env.db);
  await env.watchdog.tick();
  const relay = env.db.created[0];

  card.status = "answered";
  relay.executionRunId = "run-1";
  env.later(5);
  await env.watchdog.tick();
  assert.equal(relay.status, "todo", "not while a run holds it");

  relay.executionRunId = null;
  env.later(5);
  await env.watchdog.tick();
  assert.equal(relay.status, "done");
  const patch = env.db.patches.find((p) => p.issueId === relay.id);
  assert.match(patch.body.comment, /no longer waiting/);

  env.later(5);
  await env.watchdog.tick();
  assert.equal(env.db.patches.filter((p) => p.issueId === relay.id).length, 1, "closed once");
});

test("an issue the addressee closed without answering is not routed again", async (t) => {
  const env = await watchdogEnv(t);
  strandedQuestion(env.db);
  await env.watchdog.tick();
  env.db.created[0].status = "done";

  env.later(5);
  await env.watchdog.tick();
  env.later(5);
  await env.watchdog.tick();
  assert.equal(env.db.created.length, 1);
  assert.equal(env.logs.filter((l) => l.msg?.startsWith("watchdog: the addressee closed its question issue")).length, 1, "logged once");
});

test("cards that reach their addressee, or don't need routing, are left alone", async (t) => {
  const env = await watchdogEnv(t);
  // Too recent: Paperclip may still deliver it.
  strandedQuestion(env.db, { askedMinutesAgo: 1 });
  // Addressed to the assignee: Paperclip's own path wakes it.
  const own = strandedQuestion(env.db);
  own.card.addresseeAgentId = own.carla.id;
  // The addressee got a run after the card: the wake went through.
  const reached = strandedQuestion(env.db);
  env.db.issueRuns[reached.issue.id].push({ runId: uuid(), agentId: reached.gilfoyle.id, status: "succeeded", createdAt: minutesAgo(30) });
  // Addressed to a person, or to anyone.
  const human = strandedQuestion(env.db);
  human.card.addresseeAgentId = null;
  human.card.addresseeUserId = ids.user;
  // A paused addressee can't answer either way.
  strandedQuestion(env.db, { addresseeStatus: "paused" });
  // Already answered.
  const answered = strandedQuestion(env.db);
  answered.card.status = "answered";

  await env.watchdog.tick();
  assert.equal(env.db.created.length, 0);
});

test("dry run and WATCHDOG_ROUTE_QUESTIONS=false create nothing", async (t) => {
  const dry = await watchdogEnv(t, { DRY_RUN: "true" });
  strandedQuestion(dry.db);
  await dry.watchdog.tick();
  dry.later(5);
  await dry.watchdog.tick();
  assert.equal(dry.db.created.length, 0);
  assert.equal(dry.logs.filter((l) => l.msg?.includes("would route a question card")).length, 1, "logged once");

  const off = await watchdogEnv(t, { WATCHDOG_ROUTE_QUESTIONS: "false" });
  strandedQuestion(off.db);
  await off.watchdog.tick();
  assert.equal(off.db.created.length, 0);
  assert.equal(off.fake.requests.filter((r) => r.path.includes(scanQuery)).length, 0, "doesn't scan for cards");
});

test("cards are looked at once per stall window, not every tick", async (t) => {
  const env = await watchdogEnv(t);
  strandedQuestion(env.db);
  await env.watchdog.tick();
  // The open-issue listing is shared by the tick's checks: what the card scan costs is its own requests.
  const looked = () => env.watchdog.stats.lastTick.checks.find((c) => c.name === "question cards")?.requests ?? 0;
  assert.ok(looked() > 0);
  await env.watchdog.tick();
  assert.equal(looked(), 0);
  env.later(4);
  await env.watchdog.tick();
  assert.ok(looked() > 0);
});

test("hand-offs: a card's cancelled wake is no hand-off, but another never-started run still is", async (t) => {
  const env = await watchdogEnv(t, { WATCHDOG_ROUTE_QUESTIONS: "false" });
  // The asker waits on its card in review, after its own run: no nudge.
  const { carla, issue } = strandedQuestion(env.db, { askedMinutesAgo: 30 });
  env.db.issueRuns[issue.id].unshift({ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(40), finishedAt: minutesAgo(31) });
  // A genuine hand-off: Dinesh's queued run was cancelled when the issue went to Carla, who never started.
  const dinesh = { id: uuid(), companyId: ids.company, name: "Dinesh", status: "idle" };
  env.db.agents.push(dinesh);
  const handed = { id: uuid(), identifier: "ACM-600", companyId: ids.company, status: "todo", assigneeAgentId: carla.id, updatedAt: minutesAgo(20) };
  env.db.issues.push(handed);
  env.db.issueRuns[handed.id] = [
    { runId: uuid(), agentId: dinesh.id, status: "cancelled", errorCode: "issue_assignee_changed", startedAt: null, createdAt: minutesAgo(20), finishedAt: minutesAgo(20) },
  ];

  await env.watchdog.tick();
  assert.equal(env.db.comments.filter((c) => c.issueId === issue.id).length, 0, "the asker isn't nudged");
  assert.equal(env.db.comments.filter((c) => c.issueId === handed.id).length, 1, "the new owner is");
});

test("a card the scan can't see is checked on its own issue before its routed issue is closed", async (t) => {
  const env = await watchdogEnv(t);
  const { issue, card } = strandedQuestion(env.db);
  await env.watchdog.tick();
  const relay = env.db.created[0];

  // The source issue goes to backlog: out of the scan, but its card still waits.
  issue.status = "backlog";
  env.later(5);
  await env.watchdog.tick();
  assert.equal(relay.status, "todo", "not closed while the card waits");

  // Reading the cards fails: nothing is decided.
  issue.status = "in_review";
  env.fake.fail("GET", `/api/issues/${issue.id}/interactions`, 400, { times: 100 });
  env.later(5);
  await env.watchdog.tick();
  assert.equal(relay.status, "todo", "not closed on a failed read");
  assert.equal(env.db.created.length, 1, "and not routed again");

  // Answered: closed.
  // A read that still fails decides nothing either.
  card.status = "answered";
  env.later(5);
  await env.watchdog.tick();
  assert.equal(relay.status, "todo", "not closed while reads fail");
  assert.ok(env.fake.requests.filter((r) => r.path === `/api/issues/${issue.id}/interactions`).length >= 4);

  // Reads work again: closed.
  env.fake.clearFailures();
  env.later(5);
  await env.watchdog.tick();
  assert.equal(relay.status, "done");
});

test("a refused create is tried again; the record of an open routed issue outlives the week", async (t) => {
  const env = await watchdogEnv(t);
  strandedQuestion(env.db);
  env.fake.fail("POST", /\/api\/companies\/[^/]+\/issues$/, 422, { times: 1 });
  await env.watchdog.tick();
  assert.equal(env.db.created.length, 0);
  env.later(5);
  await env.watchdog.tick();
  assert.equal(env.db.created.length, 1, "created on the next scan");

  // Saved with a clock eight days on: the record is kept, so the card isn't routed twice.
  const { createStateStore } = await import("../src/store.mjs");
  env.state.save({ force: true });
  const later = createStateStore(env.ctx.config.stateFile, { now: () => Date.now() + 8 * 86_400_000 });
  later.save({ force: true });
  const kept = createStateStore(env.ctx.config.stateFile);
  assert.ok(kept.nudges.entries().some(([k, v]) => k.startsWith("question:") && v.relayId === env.db.created[0].id));
});
