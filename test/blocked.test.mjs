import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";
import { blockedCause, chainRoots } from "../src/blocked.mjs";

test("blockedCause: open blockers, done ones, a failed clean-up, recovery, a hold, or the agent's own note", () => {
  assert.equal(blockedCause({ blockers: [{ status: "in_review" }, { status: "done" }] }).kind, "waiting");
  assert.equal(blockedCause({ blockers: [{ status: "done", isUnresolved: true }] }).kind, "waiting", "Paperclip's own flag wins");
  assert.equal(blockedCause({ blockers: [{ status: "done", isPendingFinalize: true, isUnresolved: false }] }).kind, "finalizing");
  assert.equal(blockedCause({ blockers: [{ status: "done" }, { status: "cancelled" }] }).kind, "blockersDone");
  assert.equal(blockedCause({ blockers: [], recovery: { kind: "stranded_assigned_issue" } }).kind, "parked");
  assert.equal(blockedCause({ blockers: [], hold: { cause: "x" } }).kind, "held");
  assert.equal(blockedCause({ blockers: [] }).kind, "note");
});

test("chainRoots follows blocked issues down to the ones that aren't blocked", () => {
  // a → b → c, d → c, e → f, and b → g
  const waits = new Map([
    ["a", ["b"]],
    ["b", ["c", "g"]],
    ["d", ["c"]],
    ["e", ["f"]],
  ]);
  const roots = chainRoots(waits);
  assert.deepEqual([...roots.get("c")].sort(), ["a", "b", "d"]);
  assert.deepEqual([...roots.get("g")].sort(), ["a", "b"]);
  assert.deepEqual([...roots.get("f")], ["e"]);
  assert.equal(roots.size, 3);
  assert.equal(chainRoots(new Map([["x", ["y"]], ["y", ["x"]]])).size, 0, "a cycle doesn't loop forever");
});

test("pch blocked: the chains end at a card Paperclip never delivered, and the other causes are listed", async (t) => {
  const env = await setup();
  t.after(env.close);
  const db = env.db;
  const carla = { id: uuid(), companyId: ids.company, name: "Carla", status: "idle" };
  const gilfoyle = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
  db.agents.push(carla, gilfoyle);
  const issue = (identifier, status, extra = {}) => {
    const i = { id: uuid(), identifier, companyId: ids.company, status, assigneeAgentId: carla.id, updatedAt: minutesAgo(10), ...extra };
    db.issues.push(i);
    return i;
  };
  const root = issue("ACM-479", "in_review");
  const mid = issue("ACM-480", "blocked");
  const top = issue("ACM-481", "blocked");
  const note = issue("ACM-490", "blocked");
  const done = issue("ACM-491", "blocked");
  const approval = issue("ACM-500", "in_review", {
    executionState: { status: "pending", currentParticipant: { type: "user", userId: ids.user } },
  });
  const waitsOnApproval = issue("ACM-501", "blocked");
  const blocker = (i) => ({ id: i.id, identifier: i.identifier, status: i.status });
  db.blockerDiagnostics[mid.id] = { blockers: [blocker(root)] };
  db.blockerDiagnostics[top.id] = { blockers: [blocker(mid)] };
  db.blockerDiagnostics[done.id] = { blockers: [{ id: uuid(), identifier: "ACM-1", status: "done" }] };
  db.blockerDiagnostics[waitsOnApproval.id] = { blockers: [blocker(approval)] };
  db.comments.push({ issueId: note.id, body: "Which signing certificate should the installer use?" });
  const card = {
    id: uuid(),
    kind: "ask_user_questions",
    status: "pending",
    addresseeAgentId: gilfoyle.id,
    createdByAgentId: carla.id,
    createdAt: minutesAgo(60 * 30),
    payload: { questions: [{ prompt: "May I use a FILE_READ_ATTRIBUTES handle?" }] },
  };
  db.interactions[root.id] = [card];
  db.interactions[note.id] = [
    { id: uuid(), kind: "request_confirmation", status: "pending", addresseeUserId: ids.user, createdByAgentId: carla.id, createdAt: minutesAgo(5), payload: { prompt: "Ship it?" } },
  ];
  // The watchdog already routed the card.
  fs.writeFileSync(env.ctx.config.stateFile, JSON.stringify({ nudges: { [`question:${card.id}`]: { count: 1, at: Date.now(), relay: "ACM-530" } } }));

  const text = (await captureOutput(() => cmd.blocked(env.ctx))).join("\n");
  assert.match(text, /ACM: 5 blocked issues/);
  assert.match(text, /3 wait on other open issues\. Those chains end at 2 issues:/);
  assert.match(text, /ACM-479 +in_review +Carla +holds 2 +← a question card to Gilfoyle, 30 h old, never delivered \(routed to ACM-530\)/);
  assert.match(text, /ACM-500 .*holds 1 +← its approval is waiting on you/);
  assert.match(text, /1 have every blocker done[^\n]*\n +ACM-491/);
  assert.match(text, /1 blocked by their agent with no blocking issue linked[^\n]*\n +ACM-490 +Carla +"Which signing certificate/);
  assert.match(text, /1 question card addressed to an agent that isn't the issue's assignee/);
  assert.match(text, /ACM-479 +Carla → Gilfoyle +30 h +routed to ACM-530\n +May I use a FILE_READ_ATTRIBUTES handle\?/);
  assert.match(text, /1 other question card waiting:\n +ACM-490 +Carla → you +5 min +Ship it\?/);
});

test("pch blocked: nothing to report says so", async (t) => {
  const env = await setup();
  t.after(env.close);
  const text = (await captureOutput(() => cmd.blocked(env.ctx))).join("\n");
  assert.equal(text, "ACM: nothing blocked, and no question card waiting.");
});

test("pch why: a card Paperclip never delivered is the recommendation, with the watchdog's issue once routed", async (t) => {
  const env = await setup();
  t.after(env.close);
  const db = env.db;
  const carla = { id: uuid(), companyId: ids.company, name: "Carla", status: "idle" };
  const gilfoyle = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
  db.agents.push(carla, gilfoyle);
  const issue = { id: uuid(), identifier: "ACM-479", companyId: ids.company, status: "in_review", assigneeAgentId: carla.id, updatedAt: minutesAgo(60) };
  db.issues.push(issue);
  const card = {
    id: uuid(),
    kind: "ask_user_questions",
    status: "pending",
    addresseeAgentId: gilfoyle.id,
    createdByAgentId: carla.id,
    createdAt: minutesAgo(120),
    payload: { questions: [{ prompt: "May I use a FILE_READ_ATTRIBUTES handle?" }] },
  };
  db.interactions[issue.id] = [card];
  db.issueRuns[issue.id] = [
    { runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(130), finishedAt: minutesAgo(119) },
    { runId: uuid(), agentId: gilfoyle.id, status: "cancelled", errorCode: "issue_assignee_changed", startedAt: null, createdAt: minutesAgo(119), finishedAt: minutesAgo(119) },
  ];

  let text = (await captureOutput(() => cmd.why(env.ctx, "ACM-479"))).join("\n");
  assert.match(text, /Question card: Carla → Gilfoyle, ask_user_questions/);
  assert.match(text, /Recommendation: Carla is waiting on a question card addressed to Gilfoyle, asked 2 h ago: "May I use a FILE_READ_ATTRIBUTES handle\?" Paperclip never delivers it/);
  assert.match(text, /Or create an issue assigned to Gilfoyle/);
  assert.match(text, /The watchdog does the second by itself/);

  fs.writeFileSync(env.ctx.config.stateFile, JSON.stringify({ nudges: { [`question:${card.id}`]: { count: 1, at: Date.now(), relay: "ACM-530", relayId: "x" } } }));
  text = (await captureOutput(() => cmd.why(env.ctx, "ACM-479"))).join("\n");
  assert.match(text, /routed to ACM-530/);
  assert.match(text, /The watchdog gave Gilfoyle ACM-530 to answer it/);

  // A card for you is yours to answer.
  card.addresseeAgentId = null;
  card.addresseeUserId = ids.user;
  text = (await captureOutput(() => cmd.why(env.ctx, "ACM-479"))).join("\n");
  assert.match(text, /Recommendation: Carla is waiting on a question card addressed to you/);
  assert.match(text, /leaves this one to you/);
});
