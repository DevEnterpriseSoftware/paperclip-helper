// Watchdog 18: wakes held by an unreconciled run an agent's pause cancelled, lifted
// the way Paperclip lifts it: the issue with that run's agent, and a board user's comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import * as cmd from "../src/commands.mjs";

async function env(t, extra = {}) {
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1", WATCHDOG_RESUME_SETTLE_MIN: "0", ...extra } });
  t.after(e.close);
  e.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: minutesAgo(600) });
  return { ...e, watchdog: createWatchdog(e.ctx, e.state) };
}

// The implementer's run was cancelled by its pause two days ago; the board then moved
// the issue to review, so the reviewer is the assignee and its stage is pending. Every
// wake for the reviewer sits behind the hold the paused run left.
function heldReview(db, { errorCode = "agent_paused", ownerStatus = "idle", adapterType = "claude_local", maxRuns = 2 } = {}) {
  const implementer = { id: uuid(), companyId: ids.company, name: "Dinesh", status: ownerStatus, adapterType, runtimeConfig: { heartbeat: { maxConcurrentRuns: maxRuns } } };
  const reviewer = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle", adapterType: "claude_local" };
  db.agents.push(implementer, reviewer);
  const runId = uuid();
  const issue = {
    id: uuid(), identifier: "ACM-77", companyId: ids.company, title: "Parser fix", status: "in_review", assigneeAgentId: reviewer.id, updatedAt: minutesAgo(30),
    executionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer.id }, returnAssignee: { type: "agent", agentId: implementer.id } },
    executionBlocker: {
      recoveryActionId: uuid(), runId, agentId: implementer.id, cause: "legacy_execution_requires_reconciliation",
      runStatus: "cancelled", runError: "Cancelled due to agent pause", canContinue: false, canRetry: false, savedMessageCount: 2,
      nextAction: "Inspect the run before sending a new message to request continuation.",
    },
  };
  db.issues.push(issue);
  db.issueRuns[issue.id] = [{ runId, agentId: implementer.id, status: "cancelled", errorCode, createdAt: minutesAgo(2900), finishedAt: minutesAgo(2880) }];
  db.heartbeatRuns.push({ id: runId, companyId: ids.company, agentId: implementer.id, status: "cancelled", errorCode, error: "Cancelled due to agent pause", processPid: 999999999, processGroupId: null, createdAt: minutesAgo(2900) });
  db.wakes[issue.id] = [
    { kind: "wake_request", agentId: reviewer.id, status: "deferred_issue_execution", reason: "issue_commented", requestedAt: minutesAgo(20) },
    { kind: "wake_request", agentId: reviewer.id, status: "deferred_issue_execution", reason: "execution_review_requested", requestedAt: minutesAgo(25) },
  ];
  return { issue, implementer, reviewer, runId };
}

const notes = (e) => e.db.comments.filter((c) => c.identifier === "ACM-1");
const issueComments = (e, issue) => e.db.comments.filter((c) => c.issueId === issue.id);

test("assigned to the reviewer: the issue goes back to the paused run's agent, then one board comment lifts the hold", async (t) => {
  const e = await env(t);
  const { issue, implementer, runId } = heldReview(e.db);
  await e.watchdog.tick();

  // Step 1, a reassignment on its own; step 2, a separate plain comment.
  const patch = e.db.patches.find((p) => p.issueId === issue.id);
  assert.deepEqual(patch.body, { assigneeAgentId: implementer.id });
  const [comment] = issueComments(e, issue);
  assert.ok(comment.body.startsWith(`[@Dinesh](agent://${implementer.id}) your run on this issue was cancelled when you were paused`));
  assert.match(comment.body, /continue from where the pause cut you off, then hand the issue on as you normally would/);
  assert.equal(comment.authorUserId, ids.user, "a board user's comment");
  assert.equal(e.db.resolutions, undefined, "no recovery-action resolution");

  assert.equal(issue.executionBlocker, null, "lifted");
  assert.equal(issue.assigneeAgentId, implementer.id);
  assert.equal(issue.status, "in_review", "status and stage untouched");
  const started = e.db.issueRuns[issue.id].find((r) => r.status === "queued");
  assert.equal(started.agentId, implementer.id);
  assert.equal(started.reason, "issue_reopened_via_comment");

  const [note] = notes(e);
  assert.match(
    note.body,
    new RegExp(
      `^ACM-77: Paperclip holds every wake on this issue behind Dinesh's run ${runId.slice(0, 8)}, which was cancelled when Dinesh was paused and never reconciled \\(legacy_execution_requires_reconciliation\\): ` +
        "Gilfoyle's issue_commented \\(deferred since .*Z\\), Gilfoyle's execution_review_requested \\(deferred since .*Z\\) won't start\\. " +
        "The watchdog assigned the issue back to Dinesh \\(from Gilfoyle\\) and asked Dinesh to continue from where the pause cut it off, which is what Paperclip lifts the hold on\\. The hold is gone\\.",
    ),
  );
  assert.equal(e.watchdog.stats.pausedHolds, 1);

  // Once per blocker: held again by the same run, a restarted watchdog leaves it.
  issue.executionBlocker = { recoveryActionId: uuid(), runId, agentId: implementer.id, cause: "legacy_execution_requires_reconciliation" };
  issue.assigneeAgentId = e.db.agents.find((a) => a.name === "Gilfoyle").id;
  await createWatchdog(e.ctx, e.state).tick();
  assert.equal(e.db.continuations.length, 1);
  assert.equal(issueComments(e, issue).length, 1);
});

test("never while the owner is still paused: one log line, and continued with one note when the resume sweep sees it resumed", async (t) => {
  const e = await env(t);
  const { issue, implementer } = heldReview(e.db, { ownerStatus: "paused" });
  await e.watchdog.tick();
  await e.watchdog.tick();
  assert.ok(issue.executionBlocker, "untouched");
  assert.equal(e.db.patches.filter((p) => p.issueId === issue.id).length, 0);
  assert.equal(issueComments(e, issue).length, 0);
  assert.equal(notes(e).length, 0, "no note until it is continued");
  assert.equal(e.logs.filter((l) => /waits until that agent is resumed/.test(l.msg)).length, 1);

  // Resumed: the resume sweep sees it on its next tick (settle window 0 here) and asks for a scan at once.
  implementer.status = "idle";
  await e.watchdog.tick();
  assert.equal(issue.executionBlocker, null);
  assert.equal(issue.assigneeAgentId, implementer.id);
  assert.equal(notes(e).length, 1, "one note for the issue it continued");
  const lines = e.logs.filter((l) => l.issue === "ACM-77" && l.continued);
  assert.equal(lines.length, 1, "one log line");
  assert.equal(lines[0].level, "info", "not counted as a problem");
});

// A person's change on the issue, as Paperclip's activity log has it.
const change = (e, issue, changes, { min = 30, actorType = "user", actorId = ids.user } = {}) =>
  e.db.activity.push({ id: uuid(), action: "issue.updated", entityType: "issue", entityId: issue.id, actorType, actorId, agentId: actorType === "agent" ? actorId : null, createdAt: minutesAgo(min), details: { changes } });

test("a person has taken it over, and it's theirs for good: set to done, cancelled or backlog, or given to another agent that has run on it", async (t) => {
  const cases = {
    done: (e, h) => change(e, h.issue, { status: { from: "in_review", to: "done" } }, { min: 200 }),
    cancelled: (e, h) => change(e, h.issue, { status: { from: "in_review", to: "cancelled" } }, { min: 200 }),
    backlog: (e, h) => change(e, h.issue, { status: { from: "in_review", to: "backlog" } }, { min: 200 }),
    "another agent that ran": (e, h) => {
      const other = { id: uuid(), companyId: ids.company, name: "Richard", status: "idle", adapterType: "claude_local" };
      e.db.agents.push(other);
      change(e, h.issue, { assigneeAgentId: { from: h.reviewer.id, to: other.id } }, { min: 200 });
      e.db.issueRuns[h.issue.id].unshift({ runId: uuid(), agentId: other.id, status: "succeeded", createdAt: minutesAgo(190), startedAt: minutesAgo(190), finishedAt: minutesAgo(180) });
    },
  };
  for (const [name, take] of Object.entries(cases)) {
    const e = await env(t);
    const h = heldReview(e.db);
    take(e, h);
    await e.watchdog.tick();
    await createWatchdog(e.ctx, e.state).tick();
    assert.ok(h.issue.executionBlocker, name);
    assert.equal(e.db.patches.filter((p) => p.issueId === h.issue.id).length, 0, name);
    assert.equal(issueComments(e, h.issue).length, 0, name);
    assert.equal(notes(e).length, 0, name);
    assert.equal(e.logs.filter((l) => /a person has taken the issue over/.test(l.msg)).length, 1, name);
  }
});

test("routed through a person: theirs until it is assigned back to the hold's owner, then the quiet period from then", async (t) => {
  let clock = Date.now();
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1", WATCHDOG_RESUME_SETTLE_MIN: "0" }, now: () => clock });
  t.after(e.close);
  e.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: minutesAgo(600) });
  const h = heldReview(e.db);
  Object.assign(h.issue, { assigneeAgentId: null, assigneeUserId: ids.user });
  const tick = () => createWatchdog(e.ctx, e.state).tick(); // a fresh scan each time
  await tick();
  await tick();
  assert.ok(h.issue.executionBlocker, "with a person");
  assert.equal(e.db.patches.length, 0);
  assert.ok(e.logs.some((l) => /left alone: the issue is with a person/.test(l.msg)));

  // Given to another agent (not the owner): still the person's routing, left alone.
  h.issue.assigneeUserId = null;
  h.issue.assigneeAgentId = h.reviewer.id;
  await tick();
  assert.equal(e.db.patches.length, 0, "only coming back to the owner ends it");

  // Back to the owner, by a person, without the activity log saying so: the quiet period starts now.
  h.issue.assigneeAgentId = h.implementer.id;
  await tick();
  assert.ok(h.issue.executionBlocker, "the quiet period first");
  assert.equal(e.db.comments.filter((c) => c.issueId === h.issue.id).length, 0);
  clock += 61 * 60_000;
  await tick();
  assert.equal(h.issue.executionBlocker, null, "continued once quiet");
  assert.equal(e.db.patches.filter((p) => p.issueId === h.issue.id).length, 0, "already the owner's: no reassignment");
});

test("anything else a person does only restarts the quiet period; after it, the hold is continued as usual", async (t) => {
  const cases = {
    comment: (e, h, min) => e.db.comments.push({ id: uuid(), issueId: h.issue.id, body: "Looking at this.", authorType: "user", authorUserId: ids.user, authorAgentId: null, createdAt: minutesAgo(min) }),
    "pch comment": (e, h, min) => e.db.comments.push({ id: uuid(), issueId: h.issue.id, body: "Carry on.\n\n_Sent with Paperclip Helper (`pch`)._", authorType: "user", authorUserId: ids.user, authorAgentId: null, createdAt: minutesAgo(min) }),
    "move to in_progress": (e, h, min) => change(e, h.issue, { status: { from: "in_review", to: "in_progress" } }, { min }),
    "back to the owner": (e, h, min) => change(e, h.issue, { assigneeAgentId: { from: h.reviewer.id, to: h.implementer.id } }, { min }),
    "another agent, not run yet": (e, h, min) => change(e, h.issue, { assigneeAgentId: { from: h.implementer.id, to: h.reviewer.id } }, { min }),
    "Paperclip's stage hand-off": (e, h, min) =>
      change(e, h.issue, { status: { from: "in_progress", to: "in_review" }, assigneeAgentId: { from: h.implementer.id, to: h.reviewer.id } }, { min, actorType: "agent", actorId: h.implementer.id }),
  };
  for (const [name, act] of Object.entries(cases)) {
    // 30 minutes ago: within the 60-minute quiet period.
    const recent = await env(t);
    const r = heldReview(recent.db);
    act(recent, r, 30);
    await recent.watchdog.tick();
    assert.ok(r.issue.executionBlocker, `${name}: waits`);
    assert.equal(recent.db.patches.filter((p) => p.issueId === r.issue.id).length, 0, name);
    assert.equal(recent.logs.filter((l) => /waits for the issue to be quiet/.test(l.msg)).length, 1, name);

    // 90 minutes ago: quiet since, so it is continued.
    const quiet = await env(t);
    const q = heldReview(quiet.db);
    act(quiet, q, 90);
    await quiet.watchdog.tick();
    assert.equal(q.issue.executionBlocker, null, `${name}: continued after the quiet period`);
    assert.equal(q.issue.assigneeAgentId, q.implementer.id, name);
  }
});

test("WATCHDOG_HOLD_QUIET_MIN sets the quiet period", async (t) => {
  const e = await env(t, { WATCHDOG_HOLD_QUIET_MIN: "15" });
  const h = heldReview(e.db);
  e.db.comments.push({ id: uuid(), issueId: h.issue.id, body: "Looking.", authorType: "user", authorUserId: ids.user, authorAgentId: null, createdAt: minutesAgo(20) });
  await e.watchdog.tick();
  assert.equal(h.issue.executionBlocker, null);
});

test("the helper's own comments, an agent's, and actions from before the hold aren't a person's", async (t) => {
  const e = await env(t);
  const { issue, implementer } = heldReview(e.db);
  const at = minutesAgo(60);
  // A watchdog nudge, with the status change that went with it.
  e.db.comments.push({ id: uuid(), issueId: issue.id, body: "Please continue.\n\n_Paperclip Helper watchdog, nudge 1/2._", authorType: "user", authorUserId: ids.user, authorAgentId: null, createdAt: at });
  e.db.activity.push({ id: uuid(), action: "issue.updated", entityType: "issue", entityId: issue.id, actorType: "user", actorId: ids.user, createdAt: at, details: { changes: { status: { from: "blocked", to: "in_review" } } } });
  // The agent's own comment, and a person's from before the pause.
  e.db.comments.push({ id: uuid(), issueId: issue.id, body: "Handing to review.", authorType: "agent", authorAgentId: implementer.id, authorUserId: null, createdAt: at });
  e.db.comments.push({ id: uuid(), issueId: issue.id, body: "Looks good so far.", authorType: "user", authorUserId: ids.user, authorAgentId: null, createdAt: minutesAgo(3000) });
  await e.watchdog.tick();
  assert.equal(issue.executionBlocker, null, "continued");
});

test("an agent paused a moment before acting is skipped, and continued after its next resume", async (t) => {
  const e = await env(t);
  const { issue, implementer } = heldReview(e.db);
  // Paused between the scan and the requests: right as its run slots are counted.
  e.db.onRequest = (method, path) => {
    if (path.includes(`heartbeat-runs?agentId=${implementer.id}`)) implementer.status = "paused";
  };
  await e.watchdog.tick();
  assert.ok(issue.executionBlocker);
  assert.equal(e.db.patches.filter((p) => p.issueId === issue.id).length, 0);
  assert.equal(issueComments(e, issue).length, 0);
  e.db.onRequest = null;
  await e.watchdog.tick(); // seen paused
  implementer.status = "idle";
  await e.watchdog.tick(); // resumed: the sweep asks for a scan
  assert.equal(issue.executionBlocker, null);
});

test("the resume's settle window holds it back, and the agent's run limit paces it", async (t) => {
  const settle = await env(t, { WATCHDOG_RESUME_SETTLE_MIN: "10" });
  const a = heldReview(settle.db, { ownerStatus: "paused" });
  await settle.watchdog.tick();
  a.implementer.status = "idle";
  await settle.watchdog.tick();
  await createWatchdog(settle.ctx, settle.state).tick(); // a fresh scan, with the resume on record
  assert.ok(a.issue.executionBlocker, "within the settle window");
  assert.equal(settle.db.patches.length, 0);

  const busy = await env(t);
  const b = heldReview(busy.db, { maxRuns: 1 });
  busy.db.heartbeatRuns.push({ id: uuid(), companyId: ids.company, agentId: b.implementer.id, status: "running", createdAt: minutesAgo(1) });
  await busy.watchdog.tick();
  assert.ok(b.issue.executionBlocker, "no free run slot: a later scan");
  assert.equal(busy.db.patches.length, 0);
});

test("a cancellation for another reason is left alone", async (t) => {
  const e = await env(t);
  const { issue } = heldReview(e.db, { errorCode: "issue_reassigned" });
  await e.watchdog.tick();
  assert.ok(issue.executionBlocker);
  assert.equal(e.db.patches.filter((p) => p.issueId === issue.id).length, 0);
  assert.equal(notes(e).length, 0);
});

test("a helper key that doesn't comment as a board user: the two steps go to the board and on the issue, nothing else", async (t) => {
  const e = await env(t);
  e.db.meSource = "agent_key";
  const { issue } = heldReview(e.db);
  await e.watchdog.tick();
  await e.watchdog.tick();
  assert.ok(issue.executionBlocker, "still held");
  assert.equal(e.db.patches.filter((p) => p.issueId === issue.id).length, 0, "not reassigned");
  assert.equal(notes(e).length, 1);
  assert.match(
    notes(e)[0].body,
    /The helper's key doesn't comment as a board user, so it can't do this itself\. Paperclip lifts it only when a board user comments while the issue is assigned to Dinesh, and Dinesh isn't paused: \(1\) assign the issue back to Dinesh \(it is with Gilfoyle now\); \(2\) comment on it telling Dinesh to continue/,
  );
  const [onIssue] = issueComments(e, issue);
  assert.match(onIssue.body, /\(1\) assign the issue back to Dinesh/);
  assert.equal(issueComments(e, issue).length, 1, "once");
});

test("an agent not on a conversation adapter, WATCHDOG_RELEASE_HOLDS off, or a dry run: reported, nothing changed", async (t) => {
  const proc = await env(t);
  const p = heldReview(proc.db, { adapterType: "process" });
  await proc.watchdog.tick();
  assert.ok(p.issue.executionBlocker);
  assert.match(notes(proc)[0].body, /Paperclip continues only an agent on a conversation adapter, and Dinesh is on process/);

  const off = await env(t, { WATCHDOG_RELEASE_HOLDS: "false" });
  const o = heldReview(off.db);
  await off.watchdog.tick();
  assert.ok(o.issue.executionBlocker);
  assert.match(notes(off)[0].body, /\(WATCHDOG_RELEASE_HOLDS is off\.\)$/m);

  const dry = await env(t, { DRY_RUN: "true" });
  const d = heldReview(dry.db);
  await dry.watchdog.tick();
  await dry.watchdog.tick();
  assert.ok(d.issue.executionBlocker);
  assert.equal(dry.db.patches.length, 0);
  assert.equal(dry.logs.filter((l) => /would continue a hold left by a run an agent's pause cancelled/.test(l.msg)).length, 1);
});

test("the hand-off nudge gives the two steps when the watchdog won't lift the hold", async (t) => {
  const e = await env(t, { WATCHDOG_RELEASE_HOLDS: "false" });
  const { issue, reviewer, implementer } = heldReview(e.db);
  e.db.wakes[issue.id] = [];
  // A hand-off as check 1 sees it: the implementer ran, the reviewer never has.
  e.db.issueRuns[issue.id][0].finishedAt = minutesAgo(10);
  e.db.issueRuns[issue.id].unshift({ runId: uuid(), agentId: implementer.id, status: "succeeded", createdAt: minutesAgo(60), finishedAt: minutesAgo(50) });
  await e.watchdog.tick();
  const [nudge] = issueComments(e, issue);
  assert.ok(nudge.body.startsWith(`[@Gilfoyle](agent://${reviewer.id}) this issue is yours now (in_review), but no run has started since the hand-off: Paperclip holds every wake on this issue behind Dinesh's run`));
  assert.match(nudge.body, /The board has to lift that hold before any run starts here\. Paperclip lifts it only when a board user comments while the issue is assigned to Dinesh/);
  assert.doesNotMatch(nudge.body, /environment lease/);
});

test("pch why gives the two steps; pch release --apply takes them, and refuses while the owner is paused", async (t) => {
  const e = await env(t);
  const { issue, implementer } = heldReview(e.db, { ownerStatus: "paused" });
  const why = (await captureOutput(() => cmd.why(e.ctx, "ACM-77"))).join("\n");
  assert.match(why, /Queued wakes held by an unreconciled run from a pause: Dinesh's run .{8} was cancelled when Dinesh was paused; Gilfoyle's issue_commented/);
  assert.match(why, /1\. Resume Dinesh first/);
  assert.match(why, /2\. Assign the issue back to Dinesh \(it is with Gilfoyle now\)\./);
  assert.match(why, /3\. Then, as the board: pch comment ACM-77 "Dinesh, your run was cancelled by a pause/);
  assert.match(why, /pch release ACM-77 --apply/);

  await assert.rejects(cmd.release(e.ctx, "ACM-77", { apply: true }), /Dinesh is still paused: resume it first/);
  implementer.status = "idle";
  const preview = (await captureOutput(() => cmd.release(e.ctx, "ACM-77"))).join("\n");
  assert.match(preview, /--apply assigns ACM-77 back to Dinesh, then comments, as you/);
  assert.equal(e.db.patches.length, 0);
  const done = (await captureOutput(() => cmd.release(e.ctx, "ACM-77", { apply: true }))).join("\n");
  assert.match(done, /ACM-77: assigned back to Dinesh, and asked Dinesh to continue\.\nThe hold is gone/);
  assert.equal(issue.executionBlocker, null);
  assert.equal(issue.assigneeAgentId, implementer.id);
});
