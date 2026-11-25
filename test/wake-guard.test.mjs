// The loop breaker (wake-guard.mjs): the watchdog never wakes an agent over and over for nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWakeGuard, wakeLoopKey, WINDOW_MS } from "../src/wake-guard.mjs";
import { createWatchdog } from "../src/watchdog.mjs";

const RUN = "https://github.com/org/app/actions/runs/30498202022";
const NEW_RUN = "https://github.com/org/app/actions/runs/30498299999";

async function guardEnv(t) {
  const clock = { now: Date.now() };
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180" }, now: () => clock.now });
  t.after(env.close);
  const notes = [];
  const guard = createWakeGuard({
    ctx: env.ctx, records: env.state.nudges, state: env.state,
    noteToBoard: async (companyId, text, extra) => notes.push({ companyId, text, extra }),
  });
  const agent = { id: uuid(), companyId: ids.company, name: "Dana", status: "idle" };
  env.db.agents.push(agent);
  const issue = { id: uuid(), identifier: "ACM-301", companyId: ids.company, status: "in_progress", assigneeAgentId: agent.id, updatedAt: minutesAgo(20) };
  env.db.issues.push(issue);
  const say = (body, at = new Date(clock.now).toISOString()) =>
    env.db.comments.push({ id: uuid(), issueId: issue.id, body, authorAgentId: agent.id, authorUserId: null, createdAt: at });
  say(`Pushed. Waiting on ${RUN}.`, minutesAgo(25));
  return { ...env, clock, guard, notes, agent, issue, say, later: (min) => (clock.now += min * 60_000) };
}

test("two wakes in half an hour with nothing moving on the issue: the third is held back, the board told once", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  assert.equal(await guard.allow(issue, "release (22)"), true, "nothing recorded: allowed");
  await guard.woke(issue, "release (22)");
  env.later(5);
  env.say("Still waiting on CI for that push.");
  assert.equal(await guard.allow(issue, "blockers done"), true, "one wake so far");
  await guard.woke(issue, "blockers done");
  env.later(5);
  env.say(`Still waiting on ${RUN}.`); // the same run: no progress

  assert.equal(await guard.allow(issue, "release (7)"), false);
  assert.equal(env.notes.length, 1);
  assert.match(env.notes[0].text, /^ACM-301: the watchdog has woken the assignee 2 times in 10 min \(release \(22\), blockers done\), and nothing has moved on the issue since/);
  assert.match(env.notes[0].text, /`pch why ACM-301`/);
  assert.equal(env.notes[0].extra.decision, "loop breaker tripped");

  env.later(5);
  assert.equal(await guard.allow(issue, "release (22)"), false, "still held back");
  assert.equal(await guard.allow(issue, "release (22)"), false);
  assert.equal(env.notes.length, 1, "told once");
  assert.equal(env.logs.filter((l) => l.msg === "watchdog: a wake held back by the loop breaker").length, 1, "logged once");

  // A new CI run named (a new push): moved on, and the next wake goes through.
  env.say(`Fixed the test; pushed again. Waiting on ${NEW_RUN}.`);
  assert.equal(await guard.allow(issue, "release (22)"), true);
  assert.ok(!env.state.nudges.has(wakeLoopKey(issue.id)));
});

test("a person's comment, another assignee or a review count as moving on; the Helper's own comments don't", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  const loop = async () => {
    await guard.woke(issue, "nudge");
    env.later(2);
    await guard.woke(issue, "nudge");
    env.later(2);
  };

  await loop();
  env.db.comments.push({ id: uuid(), issueId: issue.id, body: "Released.\n\n_Paperclip Helper watchdog._", authorAgentId: null, authorUserId: "u1", createdAt: new Date(env.clock.now).toISOString() });
  assert.equal(await guard.allow(issue, "nudge"), false, "the Helper's own comment is no progress");
  env.db.comments.push({ id: uuid(), issueId: issue.id, body: "Dana, the runner is back.", authorAgentId: null, authorUserId: "u1", createdAt: new Date(env.clock.now).toISOString() });
  assert.equal(await guard.allow(issue, "nudge"), true, "a person spoke");

  await loop();
  issue.status = "in_review";
  assert.equal(await guard.allow(issue, "nudge"), true, "in review");
  issue.status = "in_progress";

  await loop();
  const other = uuid();
  issue.assigneeAgentId = other;
  assert.equal(await guard.allow(issue, "nudge"), true, "another assignee");
});

test("wakes further apart than the window don't trip it; a CI report starts the count again", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  await guard.woke(issue, "nudge");
  env.later(WINDOW_MS / 60_000 + 1);
  await guard.woke(issue, "nudge");
  env.later(1);
  assert.equal(await guard.allow(issue, "nudge"), true, "one wake in the window");
  await guard.woke(issue, "nudge");
  env.later(1);
  guard.reset(issue);
  assert.equal(await guard.allow(issue, "nudge"), true);
  assert.equal(env.notes.length, 0);
});

test("the watchdog's nudges ask the loop breaker: a synthetic loop gets one board note and no third comment", async (t) => {
  const clock = { now: Date.now() };
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180" }, now: () => clock.now });
  t.after(env.close);
  const watchdog = createWatchdog(env.ctx, env.state);
  const engineer = { id: uuid(), companyId: ids.company, name: "Engineer", status: "idle", adapterType: "claude_local" };
  env.db.agents.push(engineer);
  const issue = { id: uuid(), identifier: "ACM-6", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: minutesAgo(10) };
  env.db.issues.push(issue);
  env.db.blockerDiagnostics[issue.id] = {
    readiness: { allBlockersDone: true, isDependencyReady: true, unresolvedBlockerCount: 0 },
    blockers: [{ id: uuid(), identifier: "ACM-7", status: "done" }],
  };
  // The watchdog woke this issue twice in the last twenty minutes, and the agent only said it was waiting.
  env.state.nudges.set(wakeLoopKey(issue.id), {
    count: 2, at: clock.now - 10 * 60_000, assignee: engineer.id, since: clock.now - 20 * 60_000,
    wakes: [clock.now - 20 * 60_000, clock.now - 10 * 60_000], refs: [], rules: ["release (22)", "release (22)"],
  });
  await watchdog.tick();
  assert.equal(env.db.comments.length, 0, "no third wake");
  const notes = env.logs.filter((l) => l.msg === "watchdog: a note for the board" && /loop|nothing has moved/.test(l.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^ACM-6: the watchdog has woken the assignee 2 times in 20 min \(release \(22\)\)/);

  clock.now += 4 * 60_000;
  await watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  assert.equal(env.logs.filter((l) => l.msg === "watchdog: a note for the board").length, 1, "told once");

  // Without that history, the genuinely dropped wake is nudged as before.
  env.state.nudges.delete(wakeLoopKey(issue.id));
  clock.now += 4 * 60_000;
  await watchdog.tick();
  assert.equal(env.db.comments.length, 1);
  assert.match(env.db.comments[0].body, /every blocker on this issue is done \(ACM-7\)/);
  assert.equal(env.state.nudges.get(wakeLoopKey(issue.id)).wakes.length, 1, "counted for the next time");
});

// ---------------------------------------------------------------- holds and card answers (1.19.1)

// The issue held behind `runId` (null: not held), as GET /api/issues/:id has it.
const holdOn = (issue, runId) => {
  issue.executionBlocker = runId ? { runId, cause: "legacy_execution_requires_reconciliation", canRetry: false } : null;
};
const HOLD = "Paperclip holds every wake on this issue behind Dana's run 1a2b3c4d, a disposition repair it suppressed itself";

test("the loop it guards makes a new hold each turn: a new hold before the trip doesn't count, and it still trips", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  // Released, an empty run, a suppressed repair, held again behind another run: twice.
  holdOn(issue, "hold-1");
  await guard.woke(issue, "release (22)");
  env.later(8);
  holdOn(issue, "hold-2");
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), true);
  await guard.woke(issue, "release (22)");
  env.later(8);
  holdOn(issue, "hold-3");
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), false, "the third turn is held back");
  const r = env.state.nudges.get(wakeLoopKey(issue.id));
  assert.equal(r.holdRun, "hold-3", "the hold in force when it tripped");
  assert.equal(env.notes.length, 1, "one note: the trip, naming the release it holds back");
  assert.match(env.notes[0].text, /That holds back this release: Paperclip holds every wake on this issue behind Dana's run 1a2b3c4d.*`pch release ACM-301 --apply` releases it now, if the loop is over\./);

  // Still behind the same run, nothing else changed: still held back, and nothing more said.
  env.later(10);
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), false);
  assert.equal(env.notes.length, 1);
});

test("once tripped, a hold behind another run is the issue moving on; the same hold isn't", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  holdOn(issue, "hold-A");
  await guard.woke(issue, "nudge");
  env.later(2);
  await guard.woke(issue, "nudge");
  env.later(2);
  assert.equal(await guard.allow(issue, "nudge"), false, "tripped behind hold-A");
  assert.equal(env.state.nudges.get(wakeLoopKey(issue.id)).holdRun, "hold-A");

  env.later(60);
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), false, "the same hold: held back");

  // The board released hold-A by hand, the agent ran, and Paperclip held the issue again behind another run.
  env.later(600);
  holdOn(issue, "hold-B");
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), true);
  assert.ok(!env.state.nudges.has(wakeLoopKey(issue.id)), "the record is forgotten");
  assert.ok(env.logs.some((l) => l.msg === "watchdog: the issue moved on since its last wakes; the loop breaker lets the next one through"));
});

test("a trip recorded before 1.19.1 (no hold on the record) lets a held issue through; an unheld one stays held back", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  const t0 = env.clock.now;
  const old = { count: 2, at: t0 - 60 * 60_000, assignee: issue.assigneeAgentId, since: t0, wakes: [], refs: [], rules: ["nudge", "nudge"], tripped: t0 - 60 * 60_000 };
  env.state.nudges.set(wakeLoopKey(issue.id), { ...old });
  holdOn(issue, null);
  assert.equal(await guard.allow(issue, "nudge"), false, "not held: nothing new");
  holdOn(issue, "hold-X");
  assert.equal(await guard.allow(issue, "release (22)"), true);
  assert.ok(!env.state.nudges.has(wakeLoopKey(issue.id)));
});

test("a card a person answered since the first wake counts as moving on; an earlier answer or an agent's doesn't", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  const card = (over) => ({ id: uuid(), kind: "ask_user_questions", status: "answered", createdByAgentId: issue.assigneeAgentId, createdAt: minutesAgo(60), ...over });
  env.db.interactions[issue.id] = [card({ resolvedByUserId: "u1", resolvedAt: minutesAgo(40) })]; // before the first wake
  await guard.woke(issue, "nudge");
  env.later(2);
  await guard.woke(issue, "nudge");
  env.later(2);
  env.db.interactions[issue.id].push(card({ resolvedByAgentId: uuid(), resolvedAt: new Date(env.clock.now).toISOString() }));
  env.db.interactions[issue.id].push(card({ status: "pending" }));
  assert.equal(await guard.allow(issue, "nudge"), false, "an old answer, an agent's answer and a pending card: nothing new");
  env.later(30);
  env.db.interactions[issue.id].push(card({ resolvedByUserId: "u1", resolvedAt: new Date(env.clock.now).toISOString() }));
  assert.equal(await guard.allow(issue, "nudge"), true, "the board answered a card");
});

test("a release the loop breaker holds back is told to the board once per hold, with when it lets go", async (t) => {
  const env = await guardEnv(t);
  const { guard, issue } = env;
  const t0 = env.clock.now;
  // Tripped by nudges, a while before the hold.
  await guard.woke(issue, "nudge");
  env.later(2);
  await guard.woke(issue, "nudge");
  env.later(2);
  assert.equal(await guard.allow(issue, "nudge"), false);
  const tripped = env.state.nudges.get(wakeLoopKey(issue.id)).tripped;
  assert.equal(env.notes.length, 1);

  env.later(30);
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), false);
  assert.equal(env.notes.length, 2);
  const { text, extra } = env.notes[1];
  const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  assert.ok(text.startsWith(`ACM-301: ${HOLD}. The watchdog won't release it: the loop breaker tripped at ${utc(tripped)} and holds back every wake on this issue until ${utc(tripped + 24 * 60 * 60_000)}`), text);
  assert.match(text, /a person's comment or card answer, another assignee or status, a new CI run named, or a hold behind another run/);
  assert.match(text, /`pch release ACM-301 --apply` releases it now, if the loop is over; `pch why ACM-301` says what the agent waits on\.$/);
  assert.equal(extra.problems[0], `the loop breaker tripped at ${utc(tripped)}`);
  assert.ok(tripped >= t0);

  env.later(5);
  assert.equal(await guard.allow(issue, "release (22)", { hold: HOLD }), false);
  assert.equal(await guard.allow(issue, "nudge"), false, "a nudge says nothing");
  assert.equal(env.notes.length, 2, "once for this hold");
});
