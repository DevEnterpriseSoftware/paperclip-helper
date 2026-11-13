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
