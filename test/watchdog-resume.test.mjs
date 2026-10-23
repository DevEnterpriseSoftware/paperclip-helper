import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";
import { concurrencyOf, holdingBlockers, pauseRecoveryAction, recoveryNotice, restoreStatus, statusChangedSince } from "../src/resume.mjs";

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const NOT_INVOKABLE =
  "Paperclip cannot safely continue automatic recovery because the original assignee is not invokable. " +
  "The source assignment is unchanged and the board must choose the next action.";
const kv = (label, value) => ({ type: "key_value", label, value });

// The comment Paperclip's recovery posts when it gives up on an issue whose assignee
// it can't invoke (buildStrandedRecoveryEscalationNotice, services/recovery/stranded-notice.ts).
function recoveryComment(issue, { at, actionId, runId, metadata = true, responsibility = "system", owner = "Board decision required" }) {
  return {
    id: uuid(),
    issueId: issue.id,
    identifier: issue.identifier,
    authorType: "system",
    authorAgentId: null,
    authorUserId: null,
    body: NOT_INVOKABLE,
    createdAt: iso(at),
    presentation: { kind: "system_notice", tone: "danger", title: "Automatic recovery blocked", detailsDefaultOpen: false },
    metadata: metadata
      ? {
          version: 1,
          recoveryResponsibility: responsibility,
          sourceRunId: runId,
          sections: [
            {
              title: "Recovery",
              rows: [
                kv("Recovery action", actionId),
                kv("Recovery owner", owner),
                kv("Next action", "Inspect the evidence, then retry the original owner, explicitly reassign, repair the execution path, or record an intentional resolution"),
              ],
            },
            { title: "Run evidence", rows: [{ type: "run_link", label: "Source run", runId, title: "cancelled" }, kv("Failure code", "agent_paused")] },
          ],
        }
      : null,
  };
}

function agent(db, extra = {}) {
  const a = {
    id: uuid(), companyId: ids.company, name: extra.name ?? "Engineer", status: "idle", adapterType: "claude_local",
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, ...extra,
  };
  db.agents.push(a);
  return a;
}

let n = 300;
// An issue Paperclip's recovery blocked at `at`: its run cancelled, set to blocked
// with the recovery notice as its newest comment and a board recovery action.
function recoveryBlock(db, owner, { at, previousStatus = "in_progress", comment = {}, action = {}, ...fields }) {
  n += 1;
  const issue = {
    id: uuid(), identifier: `ACM-${n}`, companyId: ids.company, status: "blocked", assigneeAgentId: owner.id, priority: "medium",
    updatedAt: iso(at), blockedTransitionAt: iso(at), blockedBy: [], ...fields,
  };
  db.issues.push(issue);
  const runId = uuid();
  db.issueRuns[issue.id] = [
    { runId, agentId: owner.id, status: "cancelled", errorCode: "agent_paused", createdAt: iso(at - 2 * MIN), finishedAt: iso(at - MIN) },
  ];
  const actionId = uuid();
  db.recoveryActions[issue.id] = {
    id: actionId, kind: "stranded_assigned_issue", cause: "stranded_assigned_issue", status: "active", ownerType: "board",
    evidence: { previousStatus, latestRunId: runId, latestRunStatus: "cancelled" }, ...action,
  };
  db.comments.push(recoveryComment(issue, { at, actionId, runId, ...comment }));
  return issue;
}

async function resumeEnv(t, extra = {}) {
  // The test clock runs a little behind the fake's own: Paperclip-side timestamps the
  // fake writes (updatedAt) are then never older than the watchdog thinks.
  const clock = { at: Date.now() - 60 * MIN };
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...extra }, now: () => clock.at });
  t.after(env.close);
  env.db.simulateWakes = true;
  return { ...env, clock, watchdog: createWatchdog(env.ctx, env.state) };
}

const pause = (env, a) => {
  a.status = "paused";
  a.pausedAt = iso(env.clock.at);
};
const resume = (a) => {
  a.status = "idle";
  a.pausedAt = null;
};
const restoredComments = (env) => env.db.comments.filter((c) => c.via === "patch" && /was resumed/.test(c.body));
// The runs the restores queued finish.
const finishRuns = (env) => {
  for (const runs of Object.values(env.db.issueRuns)) for (const r of runs) if (r.status === "queued") r.status = "succeeded";
};
const queuedRuns = (env, issue) => (env.db.issueRuns[issue.id] ?? []).filter((r) => r.status === "queued");

test("an issue blocked by recovery while its agent was paused is restored and woken on resume, once", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db);
  await env.watchdog.tick(); // seen running

  pause(env, engineer);
  await env.watchdog.tick(); // seen paused
  env.clock.at += MIN;
  const issue = recoveryBlock(env.db, engineer, { at: env.clock.at, previousStatus: "in_progress" });
  env.clock.at += 5 * MIN;
  await env.watchdog.tick(); // still paused: nothing
  assert.equal(env.db.patches.length, 0);

  resume(engineer);
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  assert.equal(env.db.patches[0].body.status, "in_progress");
  assert.equal(issue.status, "in_progress");
  const [comment] = restoredComments(env);
  assert.equal(
    comment.body,
    `[@Engineer](agent://${engineer.id}) was resumed: retrying the original owner (the recovery block came from the pause).\n\n_Paperclip Helper watchdog._`,
  );
  // The restore woke the assignee: Paperclip queued it a run.
  assert.equal(queuedRuns(env, issue).length, 1);
  assert.equal(queuedRuns(env, issue)[0].agentId, engineer.id);
  assert.equal(env.watchdog.stats.resumed, 1);

  // Never twice, and no nudge from check 6 on top.
  env.clock.at += 10 * MIN;
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  assert.equal(env.db.comments.filter((c) => c.via !== undefined).length, 1);
});

test("the restored status is the one Paperclip recorded, in_review while a review stage is pending, else todo", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } } });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const todo = recoveryBlock(env.db, engineer, { at: env.clock.at, previousStatus: "todo" });
  const unknown = recoveryBlock(env.db, engineer, { at: env.clock.at, action: { evidence: {} } });
  const review = recoveryBlock(env.db, engineer, {
    at: env.clock.at, previousStatus: "in_progress",
    executionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: engineer.id } },
  });
  // No recovery action Paperclip will show (an older Paperclip, or one already settled): the comment decides.
  const noAction = recoveryBlock(env.db, engineer, { at: env.clock.at, previousStatus: "in_progress" });
  delete env.db.recoveryActions[noAction.id];
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(todo.status, "todo");
  assert.equal(unknown.status, "todo");
  assert.equal(review.status, "in_review");
  assert.equal(noAction.status, "todo");
  for (const i of [todo, unknown, review, noAction]) assert.equal(queuedRuns(env, i).length, 1, i.identifier);
});

test("a recovery block from while the agent was running is a real failure and is left alone", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } } });
  // Blocked before the pause: a real failure the board must look at.
  const before = recoveryBlock(env.db, engineer, { at: env.clock.at - 10 * MIN });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const during = recoveryBlock(env.db, engineer, { at: env.clock.at });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  // The sweep restored only the block from the pause. (Check 6 still applies its own
  // rules to the other one: a nudge once it has been quiet, not a restore.)
  assert.deepEqual(env.db.patches.map((p) => p.issueId), [during.id]);
  assert.equal(before.status, "blocked");
  assert.equal(during.status, "in_progress");

  // An agent never paused at all: nothing to restore.
  const other = agent(env.db, { name: "Reviewer" });
  await env.watchdog.tick();
  const failed = recoveryBlock(env.db, other, { at: env.clock.at });
  env.clock.at += MIN;
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(failed.status, "blocked");
  assert.equal(env.db.patches.length, 1);
  assert.equal(restoredComments(env).length, 1);
});

test("an issue someone acted on since the block, or blocked for another reason, is left alone", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 } } });
  const reviewer = agent(env.db, { name: "Reviewer" });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const at = env.clock.at;

  // A person commented after the block.
  const commented = recoveryBlock(env.db, engineer, { at });
  env.db.comments.push({ id: uuid(), issueId: commented.id, authorType: "user", authorUserId: ids.user, body: "Looking into this.", createdAt: iso(at + 30_000) });
  // The agent commented after it (an agent can comment while paused, through another run's key).
  const agentNote = recoveryBlock(env.db, engineer, { at });
  env.db.comments.push({ id: uuid(), issueId: agentNote.id, authorType: "agent", authorAgentId: reviewer.id, body: "Blocked on infra.", createdAt: iso(at + 30_000) });
  // Its status changed since: moved out of blocked and back.
  const moved = recoveryBlock(env.db, engineer, { at, blockedTransitionAt: iso(at + 3 * MIN) });
  // Blocked by an open issue.
  const blocker = { id: uuid(), identifier: "ACM-900", companyId: ids.company, status: "in_progress", assigneeAgentId: reviewer.id, updatedAt: iso(at) };
  env.db.issues.push(blocker);
  const dependent = recoveryBlock(env.db, engineer, { at, blockedBy: [{ id: blocker.id, identifier: blocker.identifier, status: "in_progress" }] });
  // Blocked by recovery for something a resume doesn't fix: a usage limit (for a person),
  // another recovery owner, an action of another cause.
  const quota = recoveryBlock(env.db, engineer, { at, comment: { responsibility: "user" } });
  const owned = recoveryBlock(env.db, engineer, { at, comment: { owner: "Recovery Agent" } });
  const lost = recoveryBlock(env.db, engineer, { at, action: { cause: "process_lost" } });
  // Reassigned since.
  const reassigned = recoveryBlock(env.db, engineer, { at });
  reassigned.assigneeAgentId = reviewer.id;
  // A run in progress on it.
  const running = recoveryBlock(env.db, engineer, { at });
  env.db.issueRuns[running.id].unshift({ runId: uuid(), agentId: engineer.id, status: "running", createdAt: iso(at + MIN) });

  // Blocked with no comment of Paperclip's, or a different system notice.
  const plain = { id: uuid(), identifier: "ACM-901", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, updatedAt: iso(at), blockedBy: [] };
  env.db.issues.push(plain);
  const otherNotice = recoveryBlock(env.db, engineer, { at, comment: { metadata: false } });
  env.db.comments.find((c) => c.issueId === otherNotice.id).body = "Paperclip could not restore a live execution path for this issue automatically.";

  // And one that qualifies, so the sweep certainly ran.
  const ok = recoveryBlock(env.db, engineer, { at });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();

  assert.equal(ok.status, "in_progress");
  for (const issue of [commented, agentNote, moved, dependent, quota, owned, lost, running, plain, otherNotice]) {
    assert.equal(issue.status, "blocked", issue.identifier);
  }
  assert.equal(reassigned.status, "blocked");
  assert.deepEqual(env.db.patches.map((p) => p.issueId), [ok.id]);
});

test("more issues than the agent's maxConcurrentRuns are restored over several ticks", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const issues = [];
  for (let i = 0; i < 5; i++) issues.push(recoveryBlock(env.db, engineer, { at: env.clock.at + i * 1000, updatedAt: iso(env.clock.at + i * 1000) }));
  // The most urgent goes first.
  issues[4].priority = "critical";
  env.clock.at += MIN;
  resume(engineer);

  // While the first two runs are still queued, no more are restored.
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 2);
  const restoredAfter = [];
  for (let i = 0; i < 3; i++) {
    finishRuns(env);
    await env.watchdog.tick();
    restoredAfter.push(env.db.patches.length);
  }
  assert.deepEqual(restoredAfter, [4, 5, 5]);
  assert.equal(env.db.patches[0].issueId, issues[4].id);
  assert.ok(issues.every((i) => i.status === "in_progress"));
  // The issues still waiting were left to the sweep: check 6 didn't comment on them meanwhile.
  assert.equal(env.db.comments.filter((c) => c.via === "comment").length, 0);
  // The sweep is over.
  assert.equal(env.state.nudges.has(`agent-resumed:${engineer.id}`), false);
});

test("WATCHDOG_RESUME_SWEEP_LIMIT overrides the agent's own limit", async (t) => {
  const env = await resumeEnv(t, { WATCHDOG_RESUME_SWEEP_LIMIT: "1" });
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 } } });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  for (let i = 0; i < 3; i++) recoveryBlock(env.db, engineer, { at: env.clock.at });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  finishRuns(env);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 2);
});

test("a resume while the helper was down is seen after a restart", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db);
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.state.save({ force: true });

  env.clock.at += MIN;
  const issue = recoveryBlock(env.db, engineer, { at: env.clock.at });
  env.clock.at += 30 * MIN;
  resume(engineer);
  const state = createStateStore(env.ctx.config.stateFile);
  const restarted = createWatchdog(env.ctx, state);
  await restarted.tick();
  assert.equal(issue.status, "in_progress");
});

test("without Paperclip's pausedAt, the pause counts from the last tick that saw the agent running", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db);
  await env.watchdog.tick(); // seen running at T
  env.clock.at += 2 * MIN;
  const early = recoveryBlock(env.db, engineer, { at: env.clock.at - 3 * MIN }); // before T: not the pause
  engineer.status = "paused"; // no pausedAt
  await env.watchdog.tick();
  const late = recoveryBlock(env.db, engineer, { at: env.clock.at - MIN }); // between T and this tick
  env.clock.at += MIN;
  engineer.status = "idle";
  engineer.runtimeConfig.heartbeat.maxConcurrentRuns = 5;
  await env.watchdog.tick();
  assert.equal(early.status, "blocked");
  assert.equal(late.status, "in_progress");
});

test("an older Paperclip's notice without metadata is recognised by its text", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db);
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const issue = recoveryBlock(env.db, engineer, { at: env.clock.at, comment: { metadata: false } });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(issue.status, "in_progress");
});

test("an agent paused again before the sweep ends keeps its first pause; one still awaiting approval waits", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db);
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const first = recoveryBlock(env.db, engineer, { at: env.clock.at });
  const second = recoveryBlock(env.db, engineer, { at: env.clock.at });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick(); // one restored (limit 1)
  assert.equal(env.db.patches.length, 1);

  pause(env, engineer); // a new pausedAt
  env.clock.at += MIN;
  await env.watchdog.tick();
  engineer.status = "pending_approval";
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 1);
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(env.db.patches.length, 2);
  assert.equal(first.status, "in_progress");
  assert.equal(second.status, "in_progress");
});

test("a paused task postpones the restore; a refused one is left to you", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } } });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const held = recoveryBlock(env.db, engineer, { at: env.clock.at, paused: true });
  const refused = recoveryBlock(env.db, engineer, { at: env.clock.at });
  env.fake.fail("PATCH", `/api/issues/${refused.id}`, 422, { body: { error: "Validation error" } });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(held.status, "blocked");
  assert.equal(refused.status, "blocked");
  assert.equal(env.logs.filter((l) => /refused to restore/.test(l.msg)).length, 1);

  held.paused = false;
  await env.watchdog.tick();
  assert.equal(held.status, "in_progress");
  await env.watchdog.tick();
  assert.equal(refused.status, "blocked");
});

test("dry run and WATCHDOG_RESUME_SWEEP=false change nothing", async (t) => {
  for (const extra of [{ DRY_RUN: "true" }, { WATCHDOG_RESUME_SWEEP: "false" }]) {
    const env = await resumeEnv(t, extra);
    const engineer = agent(env.db);
    await env.watchdog.tick();
    pause(env, engineer);
    await env.watchdog.tick();
    env.clock.at += MIN;
    const issue = recoveryBlock(env.db, engineer, { at: env.clock.at });
    env.clock.at += MIN;
    resume(engineer);
    await env.watchdog.tick();
    await env.watchdog.tick();
    assert.equal(issue.status, "blocked", JSON.stringify(extra));
    assert.equal(restoredComments(env).length, 0);
    const wouldLogs = env.logs.filter((l) => /would restore an issue blocked while its agent was paused/.test(l.msg));
    assert.equal(wouldLogs.length, extra.DRY_RUN ? 1 : 0);
  }
});

test("a failed agent listing doesn't end the sweep or lose the pause", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db);
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const first = recoveryBlock(env.db, engineer, { at: env.clock.at });
  const second = recoveryBlock(env.db, engineer, { at: env.clock.at });
  // Paperclip can't list the agents while it is paused: nothing is forgotten.
  env.fake.fail("GET", `/api/companies/${ids.company}/agents`, 500, { times: -1 }); // every retry too
  await env.watchdog.tick();
  env.fake.clearFailures();
  assert.equal(env.state.nudges.has(`agent-paused:${engineer.id}`), true);
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick(); // limit 1: one restored
  assert.equal(env.db.patches.length, 1);
  finishRuns(env);
  env.fake.fail("GET", `/api/companies/${ids.company}/agents`, 500, { times: -1 }); // every retry too
  await env.watchdog.tick();
  env.fake.clearFailures();
  assert.equal(env.state.nudges.has(`agent-resumed:${engineer.id}`), true);
  await env.watchdog.tick();
  assert.equal(first.status, "in_progress");
  assert.equal(second.status, "in_progress");
  // The second was the sweep's to restore throughout: check 6 never commented on it.
  assert.equal(env.db.comments.filter((c) => c.via === "comment").length, 0);
});

test("when the recovery action can't be read, it waits; without one, only the pause's own notice counts", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 10 } } });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const at = env.clock.at;
  // A failure reading it: try again next tick, never restore blind.
  const lost = recoveryBlock(env.db, engineer, { at, action: { cause: "process_lost" } });
  env.fake.fail("GET", `/api/issues/${lost.id}/recovery-actions`, 500);
  // No action to read: another family's notice whose run wasn't cancelled by the pause stays.
  const other = recoveryBlock(env.db, engineer, { at });
  delete env.db.recoveryActions[other.id];
  const otherComment = env.db.comments.find((c) => c.issueId === other.id);
  otherComment.body = "Paperclip could not restore a live execution path for this issue automatically.";
  otherComment.metadata.sections = [otherComment.metadata.sections[0]];
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(lost.status, "blocked");
  assert.equal(other.status, "blocked");
  assert.equal(env.db.patches.length, 0);
});

test("one postponed issue doesn't keep check 6 off the agent's other blocked issues", async (t) => {
  const env = await resumeEnv(t);
  const engineer = agent(env.db, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } } });
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const held = recoveryBlock(env.db, engineer, { at: env.clock.at, paused: true });
  // Parked by recovery before the pause: not the sweep's, so check 6's to nudge once quiet.
  const parked = recoveryBlock(env.db, engineer, { at: env.clock.at - 30 * MIN });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(held.status, "blocked");
  assert.equal(env.db.comments.filter((c) => c.via === "comment" && c.issueId === parked.id).length, 1);
  assert.equal(env.db.comments.filter((c) => c.issueId === held.id && c.via).length, 0);
});

test("a dry run leaves the sweep for the real run", async (t) => {
  const env = await resumeEnv(t, { DRY_RUN: "true" });
  const engineer = agent(env.db);
  await env.watchdog.tick();
  pause(env, engineer);
  await env.watchdog.tick();
  env.clock.at += MIN;
  const issue = recoveryBlock(env.db, engineer, { at: env.clock.at });
  env.clock.at += MIN;
  resume(engineer);
  await env.watchdog.tick();
  assert.equal(issue.status, "blocked");
  env.state.save({ force: true });
  const real = createWatchdog(env.makeCtx({ DRY_RUN: "false" }), createStateStore(env.ctx.config.stateFile));
  await real.tick();
  assert.equal(issue.status, "in_progress");
});

// ---------------------------------------------------------------- the pure helpers

test("recoveryNotice reads the Recovery section, and the text only without metadata", () => {
  const issue = { id: "i", identifier: "ACM-1" };
  const c = recoveryComment(issue, { at: Date.now(), actionId: "a1", runId: "r1" });
  assert.deepEqual(recoveryNotice(c), { actionId: "a1", notInvokable: true });
  // Another recovery family with the same section: not invokable only if its run was the pause's.
  const other = { ...c, body: "Paperclip could not restore a live execution path for this issue automatically." };
  assert.equal(recoveryNotice(other).notInvokable, true); // its Failure code is agent_paused
  other.metadata = { ...c.metadata, sections: [c.metadata.sections[0]] };
  assert.equal(recoveryNotice(other).notInvokable, false);
  assert.equal(recoveryNotice({ ...c, authorUserId: "u" }), null);
  assert.equal(recoveryNotice({ ...c, authorType: "agent" }), null);
  assert.equal(recoveryNotice({ ...c, metadata: { ...c.metadata, recoveryResponsibility: "user" } }), null);
  assert.equal(recoveryNotice({ ...c, metadata: { version: 1, sections: [{ title: "Run evidence", rows: [] }] } }), null);
  // Metadata decides over the text: the same words with another owner aren't it.
  assert.equal(recoveryNotice(recoveryComment(issue, { at: 0, actionId: "a", runId: "r", owner: "Recovery Agent" })), null);
  assert.deepEqual(recoveryNotice({ ...c, metadata: null }), { actionId: null, notInvokable: true });
  assert.equal(recoveryNotice({ ...c, metadata: null, body: "Something else." }), null);
  assert.equal(recoveryNotice(null), null);
});

test("restoreStatus, concurrencyOf, holdingBlockers, statusChangedSince, pauseRecoveryAction", () => {
  assert.equal(restoreStatus({ executionState: { status: "pending", currentStageType: "approval" } }, { evidence: { previousStatus: "todo" } }).status, "in_review");
  assert.equal(restoreStatus({ executionState: { status: "changes_requested", currentStageType: "review" } }, { evidence: { previousStatus: "in_progress" } }).status, "in_progress");
  assert.equal(restoreStatus({}, { evidence: { previousStatus: "blocked" } }).status, "todo");
  assert.equal(restoreStatus({}, null).status, "todo");

  assert.equal(concurrencyOf({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } }), 3);
  assert.equal(concurrencyOf({ runtimeConfig: { heartbeat: { maxConcurrentRuns: "4" } } }), 4);
  assert.equal(concurrencyOf({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 500 } } }), 50);
  assert.equal(concurrencyOf({ runtimeConfig: {} }), 1);
  assert.equal(concurrencyOf({}), 1);

  assert.deepEqual(holdingBlockers({ blockedBy: [{ status: "done" }, { status: "cancelled" }] }), []);
  assert.equal(holdingBlockers({ blockedBy: [{ status: "done" }, { id: "x" }] }).length, 1);
  assert.equal(holdingBlockers({}).length, 0);

  const at = Date.parse("2026-10-22T10:00:00Z");
  assert.equal(statusChangedSince({ blockedTransitionAt: "2026-10-22T10:00:00.500Z" }, at), false);
  assert.equal(statusChangedSince({ blockedTransitionAt: "2026-10-22T10:05:00Z" }, at), true);
  assert.equal(statusChangedSince({}, at), false);

  assert.equal(pauseRecoveryAction(null), null);
  assert.equal(pauseRecoveryAction({ kind: "stranded_assigned_issue", cause: "stranded_assigned_issue", ownerType: "board" }), true);
  assert.equal(pauseRecoveryAction({ kind: "stranded_assigned_issue", cause: "process_lost", ownerType: "board" }), false);
  assert.equal(pauseRecoveryAction({ kind: "workspace_validation", ownerType: "board" }), false);
  assert.equal(pauseRecoveryAction({ kind: "stranded_assigned_issue", ownerType: "system" }), false);
});
