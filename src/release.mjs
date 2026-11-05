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
// (up to 2026.1023.0), though it did nothing: neverStarted() says so from the run's
// own record, and its release records "not performed".
//
// `pch release` and the watchdog share this module: the command for any such
// hold, after you've looked; the watchdog only for one Paperclip can never
// settle by itself.

import { ACTIVE_RUN, TERMINAL_RUN } from "./util.mjs";

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

const tokensIn = (usage) => {
  if (!usage || typeof usage !== "object") return 0;
  return ["inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens"]
    .reduce((n, k) => n + (Number(usage[k]) || 0), 0);
};

// The run did model work: it recorded tokens or a cost. Whatever its process record
// says, what it did is unverified and for a person to judge (watchdog 7 leaves it).
export const ranWork = (run) => tokensIn(run?.usageJson) > 0 || Number(run?.usageJson?.costUsd) > 0;

// The run, as far as its own record goes, was cancelled by a dispatch gate before
// anything ran: no start, process, session, controller, stage, usage or retained
// workspace. Whether its events and lease agree is checked separately (neverStarted).
function looksUnstarted(run) {
  if (!run || run.status !== "cancelled" || !run.finishedAt) return false;
  // Present and null: a run Paperclip claimed has a start time, and a record without
  // the field proves nothing.
  if (!("startedAt" in run) || run.startedAt !== null) return false;
  if (run.runtimeMode === "native") return false;
  if (!DISPATCH_GATE_CODES.has(run.errorCode)) return false;
  if (STARTED_FIELDS.some((k) => run[k] != null)) return false;
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
  return { issue, hold, run, agent, queue, activeRun: list.some((r) => ACTIVE_RUN.has(r.status)) };
}

// A hold left by a run Paperclip cancelled before it started (DIR-1294, DIR-1230): a
// dispatch gate refused it (the issue changed hands a second earlier, a scheduled
// repair was no longer needed), and Paperclip still holds the issue for
// reconciliation as if it had run. There is nothing to reconcile: no start, process,
// session, usage, lease or execution event. Paperclip can't release it by itself:
// the run's agent never runs on the issue again to supersede it, and a message is
// saved behind it for good ("no verified stop record").
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

// Why this hold can't be released at all right now; empty when it can.
export function releaseProblems(facts) {
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
  // cannot bypass a pending execution review or approval stage", 409, seen live on
  // DIR-1294 and DIR-1355), and otherwise applies it as a board override that ends the
  // review (executionState cleared, its return assignee with it) (routes/issues.ts,
  // recovery-actions/resolve, 2026.1023.0). Neither keeps the review moving.
  if (reviewPending(issue)) problems.push("the issue's review stage is pending, and the release moves it to todo, which Paperclip either refuses or does by ending the review");
  // It accepts a reconciliation only from the run's own agent as the assignee.
  if (hold.agentId && issue?.assigneeAgentId && hold.agentId !== issue.assigneeAgentId) {
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
// server/src/services/explicit-native-continuation.ts, main at e5c9e60). A board
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
// press (409 "The queued message is no longer pending", seen live on DIR-861 and
// DIR-631): the release has worked, so that is read again, never reported as failing.
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
export async function releaseHold(api, facts, { actionOutcome = defaultOutcome(facts), note, signature = "" } = {}) {
  const { issue, hold, run } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  const ended = run ? `${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}` : "stopped";
  const unstarted = neverStarted(facts);
  await api.request("POST", `/api/issues/${id}/recovery-actions/resolve`, {
    actionId: hold.recoveryActionId,
    outcome: "restored",
    sourceIssueStatus: "todo",
    resolutionNote: `${note ?? "Released by the board: the held run has stopped."}${signature}`,
    executionReconciliation: {
      runId: hold.runId,
      providerStopped: true,
      actionOutcome,
      outcomeEvidence: unstarted
        ? `Run ${hold.runId} was cancelled by Paperclip's dispatch gate before it started (${run.errorCode}): ` +
          "it has no start time, process, session, usage, environment lease or execution event, so it performed no actions." +
          (actionOutcome === "not_performed" ? "" : ` The board recorded its actions as ${actionOutcome.replace("_", " ")}.`)
        : `Run ${hold.runId} ended ${ended} and recorded no process that is still running. ` +
          (actionOutcome === "mixed"
            ? "What it did before stopping is unverified; the assignee checks the workspace and branch before continuing."
            : `The board verified its actions as ${actionOutcome.replace("_", " ")}.`),
    },
  });
  return deliverAfterRelease(api, id);
}
