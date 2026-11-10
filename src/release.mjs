// Execution holds Paperclip can't release by itself, and the board's release.
//
// Paperclip holds an issue (executionBlocker, cause
// legacy_execution_requires_reconciliation) when a run stopped without proof of
// what it did. Before it starts anything new it wants proof that the run's
// process is gone: a recorded process id or group it can check, or a stop
// record. A run cut off at a hand-off, or one whose adapter failed to start, can
// have neither. Then every message, Interrupt and comment is saved with "The
// previous run has no verified stop record" (process_identity_missing), and only
// the board's reconciliation (POST /recovery-actions/resolve) releases it.
//
// A run Paperclip's dispatch gate cancelled before it started is held the same way
// (up to 2026.1023.0), though it did nothing, and so is one a reassignment cancelled
// after its claim but before its dispatch: neverStarted() says so from the run's own
// record, and its release records "not performed".
//
// `pch release` and the watchdog share this module: the command for any such
// hold, after you've looked; the watchdog only for one Paperclip can never
// settle by itself.

import { ACTIVE_RUN, TERMINAL_RUN } from "./util.mjs";
import { isBackstop } from "./ci-runs.mjs";

export const RECONCILIATION_CAUSE = "legacy_execution_requires_reconciliation";
export const RELEASE_OUTCOMES = ["mixed", "completed", "not_performed"];

// Whether a process with this id exists here. Only meaningful when the helper
// runs on Paperclip's host; anywhere else it says nothing either way.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Paperclip's own dispatch gates (modules/run-dispatch/domain/policy.ts): the codes it
// cancels a queued run (QueuedRunStalenessErrorCode) or a scheduled retry
// (ScheduledRetryGateErrorCode) with before the run is claimed. Up to 2026.1023.0 such
// a run is held for reconciliation like any other cancelled run, though it never
// started. execution_reconciliation_required is left out: it is the hold refusing a
// run, and Paperclip lets the next message past that one by itself.
export const DISPATCH_GATE_CODES = new Set([
  // queued runs
  "issue_waiting_for_response", "issue_dependencies_blocked", "issue_not_found", "issue_assignee_changed",
  "issue_terminal_status", "issue_not_in_progress", "issue_execution_lock_changed", "issue_blocked",
  "issue_review_participant_changed", "issue_continuation_waiting_on_review",
  // scheduled retries
  "agent_not_invokable", "heartbeat_wake_on_demand_disabled", "budget_blocked", "issue_reassigned", "issue_cancelled",
  "issue_paused", "issue_disposition_repair_superseded",
]);

// The queued-run codes Paperclip itself stopped holding for (paperclipai/paperclip#18838,
// on main from 2026-11-03; not in 2026.1023.0). A suppressed scheduled retry
// (issue_disposition_repair_superseded, say) is still held there.
export const UPSTREAM_RELEASED_CODES = new Set([
  "issue_not_found", "issue_not_in_progress", "issue_assignee_changed", "issue_waiting_for_response",
  "issue_continuation_waiting_on_review", "issue_dependencies_blocked", "issue_blocked", "issue_execution_lock_changed",
  "issue_terminal_status", "issue_review_participant_changed",
]);

// Every field Paperclip sets once a run is claimed, gets a process, a session, a
// controller or an execution stage: all must be empty for a run that never started
// (noRetainedExecutionPredicate, services/pre-dispatch-execution-evidence.ts).
const STARTED_FIELDS = [
  "runtimeModeResolvedAt", "processPid", "processGroupId", "processStartedAt", "nativeIssueId", "nativeSessionId",
  "sessionIdAfter", "controllerBootId", "controllerLeaseExpiresAt", "executionStage",
];
// Run events that mean execution began (executionStartedEventPredicate, same file). Any
// event carrying a sourceEventId came from a runner, which counts too.
const STARTED_EVENTS = new Set([
  "adapter.invoke", "native.process_start_requested", "native.process_identity_recorded", "harness.ready", "session.started",
  "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result", "tool.execution.started",
]);

// A claim gives a legacy run a start time, a controller lease and the "preparing" stage
// (legacyControllerClaim), and nothing more until it is dispatched to its adapter
// ("dispatching", then the adapter.invoke event).
const CLAIM_FIELDS = new Set(["controllerBootId", "controllerLeaseExpiresAt", "executionStage"]);
// What cancels a claimed run before dispatch without its adapter ever acknowledging a
// stop: the board's reassignment (routes/issues.ts, "Cancelled before issue
// reassignment"). Seen on 2026.1023.0: a disposition repair claimed, then cancelled by
// a board reassignment a few seconds later, still preparing.
export const CLAIMED_CANCEL_CODES = new Set(["issue_reassigned"]);

const tokensIn = (usage) => {
  if (!usage || typeof usage !== "object") return 0;
  return ["inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens"]
    .reduce((n, k) => n + (Number(usage[k]) || 0), 0);
};

// The run did model work: it recorded tokens or a cost. Whatever its process record
// says, what it did is unverified and for a person to judge (watchdog 7 leaves it).
export const ranWork = (run) => tokensIn(run?.usageJson) > 0 || Number(run?.usageJson?.costUsd) > 0;

// The run, as far as its own record goes, was cancelled before anything ran: by a
// dispatch gate before it was claimed (no start, controller or stage), or by a
// reassignment after its claim but before its dispatch (still "preparing"); either way
// no process, session, usage or retained workspace. Whether its events and lease agree
// is checked separately (neverStarted).
function looksUnstarted(run) {
  if (!run || run.status !== "cancelled" || !run.finishedAt) return false;
  // A record without the field proves nothing either way.
  if (!("startedAt" in run)) return false;
  if (run.runtimeMode === "native") return false;
  // Never claimed: a dispatch gate's code. Claimed: cancelled by a reassignment while
  // still preparing, with nothing beyond what a claim sets.
  const claimed = run.startedAt !== null;
  if (claimed) {
    if (!CLAIMED_CANCEL_CODES.has(run.errorCode) || (run.executionStage != null && run.executionStage !== "preparing")) return false;
  } else if (!DISPATCH_GATE_CODES.has(run.errorCode)) return false;
  if (STARTED_FIELDS.some((k) => run[k] != null && !(claimed && CLAIM_FIELDS.has(k)))) return false;
  if (ranWork(run)) return false;
  const result = run.resultJson ?? {};
  if (result.workspaceRestoreFailure || result.workspaceRestoreRecovery) return false;
  return true;
}

// Everything a release decision needs, for one issue. Null when it isn't held.
export async function holdFacts(api, issueRef) {
  const id = encodeURIComponent(issueRef);
  const issue = await api.request("GET", `/api/issues/${id}`);
  const hold = issue.executionBlocker ?? null;
  if (!hold) return { issue, hold: null };
  const runs = await api.request("GET", `/api/issues/${id}/runs`).catch(() => []);
  const list = Array.isArray(runs) ? runs : [];
  const listed = hold.runId ? list.find((r) => (r.runId ?? r.id) === hold.runId) ?? null : null;
  // The issue's run list has no process ids; the run itself does.
  const detail = hold.runId ? await api.request("GET", `/api/heartbeat-runs/${hold.runId}`).catch(() => null) : null;
  const run = listed || detail ? { ...(detail ?? {}), ...(listed ?? {}), processPid: detail?.processPid ?? null, processGroupId: detail?.processGroupId ?? null, detailRead: Boolean(detail) } : null;
  // A run that looks unstarted: its events must agree (null when they couldn't be read).
  if (run && detail && looksUnstarted(detail)) {
    const events = await api.request("GET", `/api/heartbeat-runs/${hold.runId}/events?limit=200`).catch(() => null);
    run.events = Array.isArray(events) ? events : null;
  }
  const agent = hold.agentId ? await api.request("GET", `/api/agents/${hold.agentId}`).catch(() => null) : null;
  const queue = await api.request("GET", `/api/issues/${id}/queued-comments`).catch(() => null);
  // The issue is the held run's agent's, with no review pending: was it their review that ended?
  let endedReview = null;
  if (hold.cause === RECONCILIATION_CAUSE && hold.agentId && issue.assigneeAgentId === hold.agentId && !reviewPending(issue)) {
    const activity = await api.request("GET", `/api/issues/${id}/activity`).catch(() => null);
    endedReview = endedReviewOf(activity, hold.agentId);
  }
  return { issue, hold, run, agent, queue, endedReview, activeRun: list.some((r) => ACTIVE_RUN.has(r.status)) };
}

// A hold left by a run Paperclip cancelled before it started: a
// dispatch gate refused it (the issue changed hands a second earlier, a scheduled
// repair was no longer needed), and Paperclip still holds the issue for
// reconciliation as if it had run. There is nothing to reconcile: no start, process,
// session, usage, lease or execution event. Paperclip can't release it by itself:
// the run's agent never runs on the issue again to supersede it, and a message is
// saved behind it for good ("no verified stop record").
// A never-started run that Paperclip had claimed (cancelled while preparing), for the wording.
export const claimedOnly = (run) => run?.startedAt != null;

export function neverStarted(facts) {
  const { hold, run, issue } = facts ?? {};
  if (hold?.cause !== RECONCILIATION_CAUSE || !run?.detailRead || !looksUnstarted(run)) return false;
  if (run.environmentLease) return false;
  if (!Array.isArray(run.events)) return false; // unread: unknown, so no
  if (run.events.some((e) => e?.sourceEventId != null || STARTED_EVENTS.has(e?.eventType))) return false;
  // The run was for this issue (Paperclip's reconciliation checks the same).
  const runIssue = run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.issueId ?? null;
  if (runIssue && issue?.id && runIssue !== issue.id) return false;
  return true;
}

// The issue has a review stage in progress (executionState pending), whatever its
// status: Paperclip's recovery sets a held review to blocked and keeps the stage.
export const reviewPending = (issue) => issue?.executionState?.status === "pending";

// Blockers on the issue that aren't done or cancelled ("Blocked by"). A blocker
// without a status counts as unresolved.
const openBlockers = (issue) =>
  (Array.isArray(issue?.blockedBy) ? issue.blockedBy : []).filter((b) => !["done", "cancelled"].includes(b?.status));

// A held review that can be released without ending it (measured on 2026.1023.0).
// Paperclip's settle sweep sets a held review to blocked with a direct status update,
// so its stage stays pending; a board user's comment then moves it to todo the same
// way (the comment reopen), still pending. From todo the release needs no status
// change, so neither the hand-back gate nor the stage transition runs, and a board
// move back to in_review re-pends the very same stage (the drifted-stage repair):
// participant, return assignee, review request, completed stages and round count all
// kept. "lossless" for such an issue in blocked or todo.
//
// One still in review can't get there on demand (no board move out of review keeps the
// stage, and Paperclip parks it only sometimes). "rebuild" for one whose review has
// nothing in it to lose: its first stage, none completed, no rounds, no decision, no
// agent to return to (a monitor on it is put back). The board's move to todo ends it, the hold is
// released from todo, the implementer has the issue a moment (in backlog, so no run
// starts), and review is asked for with the reviewer named: Paperclip starts the first
// stage again with that reviewer and that implementer, and the review request passed
// back. Measured on 2026.1023.0: the same stage, reviewer and return assignee, the
// reviewer's run at once. Its saved wakes are cancelled as the issue leaves them (the
// comments stay, and their review run reads them). null for any other review.
const firstStageUntouched = (state) =>
  (state.currentStageIndex ?? 0) === 0 && !(state.completedStageIds ?? []).length && !(state.changesRequestedCount ?? 0) &&
  !state.lastDecisionId && !state.lastDecisionOutcome && state.returnAssignee?.type === "agent" && Boolean(state.returnAssignee.agentId);

// A monitor on the issue's policy (the CI backstop's, say) is cleared by Paperclip when
// the issue leaves in_progress and in_review (monitorClearReasonForIssue). Put back as
// it was, a minute out if its check is already due; returns whether it was.
async function restoreMonitor(api, id, monitor) {
  if (!monitor) return false;
  const now = await api.request("GET", `/api/issues/${id}`);
  if (now.executionPolicy?.monitor) return false;
  const due = Date.parse(monitor.nextCheckAt ?? "");
  const nextCheckAt = Number.isFinite(due) && due > Date.now() + 30_000 ? monitor.nextCheckAt : new Date(Date.now() + 60_000).toISOString();
  await api.request("PATCH", `/api/issues/${id}`, { executionPolicy: { ...(now.executionPolicy ?? {}), monitor: { ...monitor, nextCheckAt } } });
  return true;
}

// The CI backstop a plain release puts back (watchdog 11's monitor, ci-runs.mjs). An agent
// waiting on CI with the backstop standing gets a disposition repair scheduled when its
// run ends a moment before the monitor arrives; the monitor makes the repair unnecessary,
// Paperclip suppresses it before it starts (issue_disposition_repair_superseded), and up
// to 2026.1106.0 holds the issue behind it, set blocked by a direct update that leaves
// the monitor. The release moves the issue to todo, which clears it, and wakes the agent
// (Paperclip's continuation, the saved messages): that run, ending with no monitor, gets
// the next repair, the backstop comes back a few seconds later, and suppresses it into
// the next hold. So the release puts the issue back in progress with the backstop before
// any wake starts, and the run ends with a live path.
//
// The backstop on the held issue: the policy's monitor, the Helper's, still scheduled,
// and the issue still the held run's agent's. `recorded` (the watchdog's record of the
// backstop it scheduled) stands in when Paperclip has cleared it from the policy.
export function heldBackstop(facts, { recorded = null, now = Date.now() } = {}) {
  const { issue, hold } = facts ?? {};
  if (!issue || !hold?.agentId || issue.assigneeAgentId !== hold.agentId || issue.assigneeUserId) return null;
  if (reviewPending(issue) || ["done", "cancelled", "in_review"].includes(issue.status)) return null;
  const monitor = issue.executionPolicy?.monitor ?? null;
  if (monitor) {
    const state = issue.executionState?.monitor;
    return isBackstop(monitor) && (!state || state.status === "scheduled") ? monitor : null;
  }
  const m = recorded?.agentId === hold.agentId ? recorded.monitor : null;
  return m && isBackstop(m) && Date.parse(m.timeoutAt ?? m.nextCheckAt ?? "") > now ? m : null;
}

// After the release: the issue (in todo, the held run's agent's, no longer held) back in
// progress and the backstop set again. "kept" when the release left it on the issue,
// "restored" when it was set again, null when the issue isn't one to put it on.
async function restoreBackstop(api, id, monitor, agentId) {
  const now = await api.request("GET", `/api/issues/${id}`);
  if (now.executionPolicy?.monitor) return isBackstop(now.executionPolicy.monitor) ? "kept" : null;
  if (now.executionBlocker || now.assigneeAgentId !== agentId || now.assigneeUserId) return null;
  if (now.status === "todo") await api.request("PATCH", `/api/issues/${id}`, { status: "in_progress" });
  else if (now.status !== "in_progress") return null;
  return (await restoreMonitor(api, id, monitor)) ? "restored" : null;
}

export function heldReviewRoute(facts) {
  const { issue, hold } = facts ?? {};
  if (!reviewPending(issue) || !hold?.agentId) return null;
  const participant = issue.executionState.currentParticipant;
  if (participant?.type !== "agent" || participant.agentId !== hold.agentId || issue.assigneeAgentId !== hold.agentId) return null;
  if (issue.status === "blocked" || issue.status === "todo") return "lossless";
  if (issue.status === "in_review" && firstStageUntouched(issue.executionState) && issue.executionState.returnAssignee.agentId !== hold.agentId) return "rebuild";
  return null;
}

// A board reassignment cancels the old owner's running run, and Paperclip cancels their
// queued one at dispatch once they no longer have the issue. Up to 2026.1023.0 either can
// hold the issue again: at once (a run claimed but still preparing), or when they next
// own it while nothing runs and that cancelled run is still their latest there (the
// stranded-work sweep: a continuation queued for them after a release, cancelled when
// the board reassigned the issue, held again once they became its reviewer again). A run that reaches its adapter is stopped with a receipt and holds
// nothing, and so is a run whose own agent reassigns the issue.
//
// So where the release needs the issue with the held run's agent and the work belongs
// to someone else, the watchdog doesn't move it on itself while their run may be queued:
// it asks them to. "Hand-on" routes:
//   owner-moved   the issue was given to another agent after the run (no review
//                 pending): back to the run's agent a moment, who is asked to reassign
//                 it to that agent; the release is accepted while it is theirs.
//   review-ended  the run was its reviewer's, and the board ended that review with the
//                 issue still theirs (a move to todo clears the stage): they are
//                 asked to give it back to the implementer the review would have
//                 returned to, rather than being handed the saved messages, which are
//                 the implementer's work.
// Null for anything else.
export function handOnRoute(facts) {
  const { issue, hold } = facts ?? {};
  if (!hold?.agentId || !issue || reviewPending(issue) || ["done", "cancelled"].includes(issue.status)) return null;
  if (issue.assigneeAgentId && issue.assigneeAgentId !== hold.agentId) {
    return { kind: "owner-moved", targetAgentId: issue.assigneeAgentId, reassign: true };
  }
  if (issue.assigneeAgentId === hold.agentId && facts.endedReview?.returnAssigneeAgentId) {
    return { kind: "review-ended", targetAgentId: facts.endedReview.returnAssigneeAgentId, reassign: false };
  }
  return null;
}

// The review an agent was the participant of, ended without a decision, from the issue's
// activity log (newest first): the newest entry whose executionState change starts or
// ends a pending stage decides. { returnAssigneeAgentId, endedAt } when it ended a stage
// pending with `agentId`, returning to another agent; else null.
export function endedReviewOf(activity, agentId) {
  for (const entry of Array.isArray(activity) ? activity : []) {
    const change = entry?.action === "issue.updated" ? entry.details?.changes?.executionState : null;
    if (!change) continue;
    const { from, to } = change;
    if (from?.status !== "pending" && to?.status !== "pending") continue; // a monitor's change, say
    if (to?.status === "pending") return null; // a stage started (again)
    if (from.currentParticipant?.type !== "agent" || from.currentParticipant.agentId !== agentId) return null;
    if (to?.lastDecisionId && to.lastDecisionId !== from.lastDecisionId) return null; // decided, not ended
    const back = from.returnAssignee;
    if (back?.type !== "agent" || !back.agentId || back.agentId === agentId) return null;
    return { returnAssigneeAgentId: back.agentId, endedAt: entry.createdAt ?? null };
  }
  return null;
}

// The comment that asks the held run's agent to hand the issue on.
export function handOnText({ route, holdAgent, target, errorCode, signature = "" }) {
  const mention = (a, fallback) => (a?.id ? `[@${a.name ?? fallback}](agent://${a.id})` : fallback);
  const them = target?.name ?? "them";
  return (
    `${mention(holdAgent, "")} Paperclip held this issue behind a run of yours that was cancelled before it did anything (${errorCode}), ` +
    `and it releases that hold only while the issue is yours${route.kind === "owner-moved" ? ", so it is yours again for a moment" : ""}.` +
    (route.kind === "review-ended" ? ` The review that run was for has ended, and the work here is ${mention(target, "its implementer")}'s.` : "") +
    ` Please reassign this issue to ${mention(target, "its owner")} and change nothing else: don't work on it or answer the messages here, which are for ${them}.` +
    signature
  ).trim();
}

// The hand-on release (handOnRoute): the issue to the held run's agent if it isn't theirs
// (a PATCH of assigneeAgentId alone, nothing running to cancel: releaseProblems refuses
// any active run), the comment asking them to hand it on, the release, and the saved
// messages delivered, so their run starts now. Their own reassignment is the run's
// disposition, so no repair follows. If anything fails after the issue was moved, it
// goes back to where it was. Returns deliverAfterRelease's answer plus { handOn, reassigned }.
export async function releaseHandedOn(api, facts, { route, comment, actionOutcome = defaultOutcome(facts), note, signature = "" }) {
  const { issue, hold } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  let reassigned = false;
  const back = async () => {
    if (reassigned) await api.request("PATCH", `/api/issues/${id}`, { assigneeAgentId: route.targetAgentId }).catch(() => {});
  };
  try {
    if (route.reassign) {
      await api.request("PATCH", `/api/issues/${id}`, { assigneeAgentId: hold.agentId });
      reassigned = true;
      const now = await api.request("GET", `/api/issues/${id}`);
      if (now.assigneeAgentId !== hold.agentId) throw new Error("Paperclip didn't give the issue to the held run's agent");
      if (reviewPending(now)) throw new Error("giving the issue to the held run's agent started a review stage");
    }
    await api.request("POST", `/api/issues/${id}/comments`, { body: comment });
    await resolveRun(api, id, facts, { actionOutcome, note, signature });
  } catch (err) {
    await back();
    throw err;
  }
  return { ...(await deliverAfterRelease(api, id)), handOn: route.kind, reassigned };
}

// What a review is, for telling whether a step changed it.
const REVIEW_KEYS = [
  "status", "currentStageId", "currentStageIndex", "currentStageType", "currentParticipant", "returnAssignee", "reviewRequest",
  "completedStageIds", "lastDecisionId", "lastDecisionOutcome", "changesRequestedCount",
];
export const sameReview = (a, b) => REVIEW_KEYS.every((k) => JSON.stringify(a?.[k] ?? null) === JSON.stringify(b?.[k] ?? null));

// Why this hold can't be released at all right now; empty when it can. With
// { heldReview: true }, a pending review heldReviewRoute has a route for isn't one.
// An active run (queued or running) on the issue always is: it would supersede the
// hold, and a reassignment now would cancel it and hold the issue again.
export function releaseProblems(facts, { heldReview = false, handOn = false } = {}) {
  const { hold, run, activeRun, issue } = facts;
  const problems = [];
  if (!hold.runId || !hold.recoveryActionId) problems.push("the hold names no source run or recovery action");
  if (hold.workspaceRepairRequired) problems.push("the hold needs a workspace repair, not a release");
  if (run && !TERMINAL_RUN.has(run.status)) problems.push(`the run is still ${run.status}`);
  if (activeRun) problems.push("another run on the issue is active");
  if (run?.environmentLease && !run.environmentLease.releasedAt) problems.push("its environment lease was never released");
  for (const pid of [run?.processPid, run?.processGroupId ? -run.processGroupId : null]) {
    if (pid && processAlive(pid)) problems.push(`process ${Math.abs(pid)} is still alive on this host`);
  }
  // Paperclip's reconciliation moves the issue to todo. While a review stage is pending
  // it refuses that when the hold's owner still has the issue ("Safe recovery hand-back
  // cannot bypass a pending execution review or approval stage", 409, seen on
  // 2026.1023.0), and otherwise applies it as a board override that ends the
  // review (executionState cleared, its return assignee with it) (routes/issues.ts,
  // recovery-actions/resolve, 2026.1023.0). Neither keeps the review moving.
  if (reviewPending(issue) && !(heldReview && heldReviewRoute(facts))) {
    problems.push("the issue's review stage is pending, and the release moves it to todo, which Paperclip either refuses or does by ending the review");
  }
  // It accepts a reconciliation only from the run's own agent as the assignee.
  // With { handOn: true }, one handOnRoute gives back to the run's agent first isn't one.
  if (hold.agentId && issue?.assigneeAgentId && hold.agentId !== issue.assigneeAgentId && !(handOn && handOnRoute(facts)?.reassign)) {
    problems.push("the held run is another agent's than the assignee's, and Paperclip releases it only while the run's agent has the issue");
  }
  // The move to todo would also unblock an issue blocked by other issues.
  const open = issue?.status === "blocked" ? openBlockers(issue) : [];
  if (open.length) problems.push(`the issue is blocked by ${open.map((b) => b.identifier ?? b.id).join(", ")}, and the release moves it to todo`);
  return problems;
}

// A hold Paperclip can never release by itself: the run recorded no process to
// check and Paperclip says so. Waiting longer changes nothing.
export function unprovable(facts) {
  const { hold, run, queue } = facts;
  if (hold?.cause !== RECONCILIATION_CAUSE) return false;
  if (queue?.executionWait?.reason === "process_identity_missing") return true;
  return Boolean(run?.detailRead && run.processPid == null && run.processGroupId == null);
}

// A hold left by a run an agent's pause cancelled ("Cancelled due to agent pause",
// errorCode agent_paused). Paperclip counts a pause-cancel as needing reconciliation,
// and the hold covers the whole issue: every agent's wakes on it, the next owner's
// (a reviewer's, say) included, wait behind it, however long ago the pause was.
// Resuming the agent doesn't clear it, and neither does a status change, a
// reassignment, an agent's comment or Interrupt.
export const PAUSE_CANCEL = "agent_paused";
export function pausedHold(facts) {
  const { hold, run } = facts ?? {};
  return hold?.cause === RECONCILIATION_CAUSE && run?.status === "cancelled" && run.errorCode === PAUSE_CANCEL;
}

// What lifts it: an explicit continuation (admitExplicitNativeContinuation,
// server/src/services/explicit-native-continuation.ts, on main). A board
// user's plain comment on the issue (wake reason issue_commented or
// issue_reopened_via_comment) while the issue is assigned to the hold's own agent
// (executionBlocker.agentId, whose run the pause cancelled), that agent invokable, on
// a conversation adapter, and the comment newer than the run's end. A comment while
// anyone else is the assignee is saved behind the hold like any other.
export const CONVERSATION_ADAPTERS = new Set([
  "claude_local", "codex_local", "cursor", "gemini_local", "opencode_local", "pi_local", "grok_local", "kimi_local", "hermes_local",
]);

// Does the helper's key comment as a board user (actorType "user")? A board API key
// does (getActorInfo, routes/authz.ts: source board_key), as do a session and
// local_implicit; an agent's key doesn't. From `pch login`'s identity (/api/cli-auth/me).
export const actsAsUser = (identity) => Boolean(identity?.userId) && !/^agent/i.test(String(identity?.source ?? ""));

// The two steps, as the board would take them: the issue back to the hold's own agent
// (a PATCH of assigneeAgentId alone; the comment goes separately, as a single PATCH
// that names another assignee keeps the stage's returnAssignee), then the comment.
// Returns { reassigned, from, lifted, status }: `lifted` when Paperclip no longer shows
// the hold once the comment is in (it lifts it as the comment's wake is admitted, so
// a moment later is possible too).
export async function continuePausedHold(api, facts, { text }) {
  const { issue, hold } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  const from = issue.assigneeAgentId ?? null;
  const reassigned = from !== hold.agentId;
  if (reassigned) await api.request("PATCH", `/api/issues/${id}`, { assigneeAgentId: hold.agentId });
  await api.request("POST", `/api/issues/${id}/comments`, { body: text });
  const after = await api.request("GET", `/api/issues/${id}`).catch(() => null);
  return { reassigned, from, lifted: Boolean(after) && !after.executionBlocker, status: after?.status ?? issue.status };
}

// The comment that continues it, to the agent whose run the pause cancelled.
export function continuationText(agent, signature = "") {
  return (
    `${agent ? `[@${agent.name}](agent://${agent.id}) ` : ""}your run on this issue was cancelled when you were paused, and Paperclip has held the issue since. ` +
    "Please continue from where the pause cut you off, then hand the issue on as you normally would (back to review, say)." +
    signature
  );
}

// After a release: is the hold gone, and do saved messages still wait? Paperclip may
// start them by itself; they are pressed only if they still wait. Once the hold is
// gone, Paperclip can promote the saved wakes between our read of the queue and the
// press (409 "The queued message is no longer pending", seen on 2026.1023.0):
// the release has worked, so that is read again, never reported as failing.
async function deliverAfterRelease(api, id) {
  const after = await api.request("GET", `/api/issues/${id}`);
  if (after.executionBlocker) {
    const err = new Error(`Paperclip accepted the release but still holds the issue (${after.executionBlocker.cause ?? "unknown cause"})`);
    err.stillHeld = true;
    throw err;
  }
  const pressable = (q) => q?.queueId && q.entries?.length && q.state === "deferred" && !q.targetRunId && q.protocol === "legacy";
  let queue = await api.request("GET", `/api/issues/${id}/queued-comments`).catch(() => null);
  const saved = queue?.entries?.length ?? 0;
  for (let attempt = 0; attempt < 2 && pressable(queue); attempt += 1) {
    try {
      await api.request("POST", `/api/issues/${id}/queued-comments/interrupt`, {
        queueId: queue.queueId,
        revision: queue.revision,
        targetRunId: null,
      });
      return { status: after.status, delivered: queue.entries.length, waiting: 0 };
    } catch (err) {
      if (err.status !== 409) throw err;
      // Changed under us: Paperclip took them itself, or the queue has a new revision.
      queue = await api.request("GET", `/api/issues/${id}/queued-comments`).catch(() => null);
    }
  }
  const left = queue?.entries?.length ?? 0;
  // Gone from the queue without our press: Paperclip delivered them.
  if (saved && !left) return { status: after.status, delivered: 0, waiting: 0, byPaperclip: saved };
  return { status: after.status, delivered: 0, waiting: left };
}

// The outcome a release records when none is given: a run that never started
// performed nothing; any other's actions are unverified.
export const defaultOutcome = (facts) => (neverStarted(facts) ? "not_performed" : "mixed");

// Records the board's reconciliation, then delivers the saved messages the way
// Interrupt does. Returns { status, delivered, waiting }.
// Paperclip can record more than one recovery action for the same held run (its
// sweep makes another when a later wake is refused behind the hold; seen on
// 2026.1023.0), and the hold lasts until every one is reconciled. Resolves them in
// turn, up to a few, while the hold is still the same run's.
const MAX_ACTIONS_PER_RUN = 5;
async function resolveRun(api, id, facts, { actionOutcome, note, signature }) {
  const { hold, run } = facts;
  const ended = run ? `${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}` : "stopped";
  const unstarted = neverStarted(facts);
  let actionId = hold.recoveryActionId;
  let resolved = 0;
  for (; resolved < MAX_ACTIONS_PER_RUN && actionId; resolved += 1) {
    await api.request("POST", `/api/issues/${id}/recovery-actions/resolve`, {
      actionId,
      outcome: "restored",
      sourceIssueStatus: "todo",
      resolutionNote: `${note ?? "Released by the board: the held run has stopped."}${signature}`,
      executionReconciliation: {
        runId: hold.runId,
        providerStopped: true,
        actionOutcome,
        outcomeEvidence: unstarted
          ? (claimedOnly(run)
            ? `Run ${hold.runId} was cancelled after Paperclip claimed it, while still preparing, before it was dispatched to its adapter (${run.errorCode}): ` +
              "it has no process, adapter invocation, session, usage, environment lease or execution event, so it performed no actions."
            : `Run ${hold.runId} was cancelled by Paperclip's dispatch gate before it started (${run.errorCode}): ` +
              "it has no start time, process, session, usage, environment lease or execution event, so it performed no actions.") +
            (actionOutcome === "not_performed" ? "" : ` The board recorded its actions as ${actionOutcome.replace("_", " ")}.`)
          : `Run ${hold.runId} ended ${ended} and recorded no process that is still running. ` +
            (actionOutcome === "mixed"
              ? "What it did before stopping is unverified; the assignee checks the workspace and branch before continuing."
              : `The board verified its actions as ${actionOutcome.replace("_", " ")}.`),
      },
    });
    const now = await api.request("GET", `/api/issues/${id}`);
    const next = now.executionBlocker;
    actionId = next && next.runId === hold.runId && next.recoveryActionId && next.recoveryActionId !== actionId ? next.recoveryActionId : null;
  }
  return resolved;
}

// The plain release. With the CI backstop on the held issue (heldBackstop; `backstop`
// to name another, null for none), the issue goes back in progress with it before the
// saved messages are delivered: { backstop: "restored" | "kept" } in the answer.
export async function releaseHold(api, facts, { actionOutcome = defaultOutcome(facts), note, signature = "", backstop = heldBackstop(facts) } = {}) {
  const { issue, hold } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  await resolveRun(api, id, facts, { actionOutcome, note, signature });
  const restored = backstop ? await restoreBackstop(api, id, backstop, hold.agentId).catch(() => null) : null;
  return { ...(await deliverAfterRelease(api, id)), ...(restored ? { backstop: restored } : {}) };
}

// The rebuilt review (heldReviewRoute "rebuild"), for one still in review with nothing
// in it to lose. Each step is checked: the stage must come back with the same id,
// reviewer and return assignee, the review request passed back. If the release fails
// after the review was ended, the review is asked for again before giving up.
// Returns deliverAfterRelease's answer plus { review: "rebuilt" }.
export async function releaseRebuiltReview(api, facts, { actionOutcome = defaultOutcome(facts), note, signature = "" }) {
  const { issue, hold } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  const review = issue.executionState;
  const monitor = issue.executionPolicy?.monitor ?? null;
  const read = () => api.request("GET", `/api/issues/${id}`);
  const askAgain = async () => {
    await api.request("PATCH", `/api/issues/${id}`, { status: "backlog", assigneeAgentId: review.returnAssignee.agentId });
    await api.request("PATCH", `/api/issues/${id}`, { status: "in_review", assigneeAgentId: hold.agentId, ...(review.reviewRequest ? { reviewRequest: review.reviewRequest } : {}) });
  };
  await api.request("PATCH", `/api/issues/${id}`, { status: "todo" });
  const cleared = await read();
  if (cleared.status !== "todo" || cleared.assigneeAgentId !== hold.agentId) {
    await askAgain().catch(() => {});
    throw new Error(`Paperclip didn't take the review to todo with the reviewer still assigned (it is ${cleared.status})`);
  }
  try {
    await resolveRun(api, id, facts, { actionOutcome, note, signature });
  } catch (err) {
    await askAgain().catch(() => {});
    throw err;
  }
  try {
    await askAgain();
  } catch (first) {
    await askAgain().catch(() => {
      const err = new Error(`the hold is released, but asking for the review again failed (${first.message}): assign the issue to its implementer, then move it to in_review with the reviewer`);
      err.reviewChanged = true;
      throw err;
    });
  }
  const after = await read();
  const now = after.executionState ?? {};
  const same = after.status === "in_review" && now.status === "pending" && now.currentStageId === review.currentStageId &&
    JSON.stringify(now.currentParticipant?.agentId ?? null) === JSON.stringify(review.currentParticipant.agentId) &&
    JSON.stringify(now.returnAssignee?.agentId ?? null) === JSON.stringify(review.returnAssignee.agentId) &&
    JSON.stringify(now.reviewRequest ?? null) === JSON.stringify(review.reviewRequest ?? null);
  if (!same) {
    const err = new Error(`the hold is released, but the review didn't come back as it was (it is ${after.status}); check its stage`);
    err.reviewChanged = true;
    throw err;
  }
  const monitorRestored = await restoreMonitor(api, id, monitor).catch(() => false);
  return { ...(await deliverAfterRelease(api, id)), review: "rebuilt", monitorRestored };
}

// The lossless release of a held review (heldReviewRoute "lossless"): a board user's
// comment (`comment`) moves a blocked one to todo with its stage kept, the hold's
// actions are released from todo, and the review is asked for again, which re-pends
// the same stage. Every step is checked against the review as it was; the first that
// doesn't leave it the same stops, and an issue left in todo by a failed release is
// put back in review. Returns deliverAfterRelease's answer plus { review: true }.
export async function releaseHeldReview(api, facts, { actionOutcome = defaultOutcome(facts), note, signature = "", comment }) {
  const { issue } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  const review = issue.executionState;
  const monitor = issue.executionPolicy?.monitor ?? null;
  const read = () => api.request("GET", `/api/issues/${id}`);
  let current = issue;
  if (current.status === "blocked") {
    await api.request("POST", `/api/issues/${id}/comments`, { body: comment });
    current = await read();
    if (current.status !== "todo" || !sameReview(review, current.executionState)) {
      throw new Error(`Paperclip didn't move the review to todo with its stage kept (it is ${current.status}${sameReview(review, current.executionState) ? "" : ", its review changed"})`);
    }
  }
  try {
    await resolveRun(api, id, facts, { actionOutcome, note, signature });
  } catch (err) {
    // Back in review, as it was, before giving up.
    await api.request("PATCH", `/api/issues/${id}`, { status: "in_review" }).catch(() => {});
    throw err;
  }
  try {
    await api.request("PATCH", `/api/issues/${id}`, { status: "in_review" });
  } catch (first) {
    await api.request("PATCH", `/api/issues/${id}`, { status: "in_review" }).catch(() => {
      const err = new Error(`the hold is released, but putting the issue back in review failed (${first.message}): move it to in_review, which keeps its stage`);
      err.reviewChanged = true;
      throw err;
    });
  }
  const after = await read();
  if (after.status !== "in_review" || !sameReview(review, after.executionState)) {
    const err = new Error(`the hold is released, but the review didn't come back as it was (it is ${after.status}); check its stage`);
    err.reviewChanged = true;
    throw err;
  }
  const monitorRestored = await restoreMonitor(api, id, monitor).catch(() => false);
  return { ...(await deliverAfterRelease(api, id)), review: "kept", monitorRestored };
}
