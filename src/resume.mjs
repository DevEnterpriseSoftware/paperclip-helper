// Watchdog 15: issues Paperclip's recovery blocked while their agent was paused.
//
// Pausing an agent that has runs queued or in flight cancels them. Paperclip's
// recovery sweep then finds each affected issue assigned to an agent it can't
// invoke and gives up on it: the issue goes to `blocked`, with no blocker linked,
// and a system comment ("Paperclip cannot safely continue automatic recovery
// because the original assignee is not invokable…") whose metadata has a
// "Recovery" section, "Recovery owner: Board decision required". Resuming the
// agent restarts none of them. The pure helpers the watchdog's sweep uses are
// here; the sweep itself is in watchdog.mjs.

import { ts } from "./util.mjs";

// Statuses an issue can be restored to. Anything else Paperclip recorded as the
// previous status (it records only these three today) restores to todo.
const RESTORABLE = new Set(["todo", "in_progress", "in_review"]);
// Blockers that don't hold the issue back for this check: Paperclip keeps a
// cancelled blocker unresolved, but the issue was running with it before the
// pause, so it isn't why it is blocked now (watchdog 14 tells the agent about it).
const SETTLED_BLOCKER = new Set(["done", "cancelled"]);
// Paperclip clamps maxConcurrentRuns to 1–50 (normalizeMaxConcurrentRuns).
const MAX_CONCURRENT_RUNS_LIMIT = 50;

const NOT_INVOKABLE = /original assignee is not invokable/i;

const rowValue = (section, label) => {
  const row = (Array.isArray(section?.rows) ? section.rows : []).find((r) => r?.label === label);
  return row ? (row.value ?? row.name ?? null) : undefined;
};

// The system comment Paperclip's recovery posts when it gives up on an issue for
// the board, or null. With metadata (current Paperclip), the comment must carry a
// "Recovery" section owned by the board, and not be one Paperclip says is for a
// person to fix (recoveryResponsibility "user": a usage limit, a missing login),
// which no resume fixes. Without metadata (older Paperclip), its body must say the
// assignee was not invokable. { actionId } names the recovery action when the
// comment says which; notInvokable is whether the comment itself says it was the
// assignee that couldn't be run (needed when the action can't be read).
export function recoveryNotice(comment) {
  if (!comment || comment.authorAgentId || comment.authorUserId) return null;
  if (comment.authorType != null && comment.authorType !== "system") return null;
  const meta = comment.metadata;
  if (meta && Array.isArray(meta.sections)) {
    const section = meta.sections.find((s) => s?.title === "Recovery");
    if (!section || rowValue(section, "Recovery owner") !== "Board decision required") return null;
    if (meta.recoveryResponsibility === "user") return null;
    const evidence = meta.sections.find((s) => s?.title === "Run evidence");
    return {
      actionId: rowValue(section, "Recovery action") ?? null,
      // What says it was the pause when the recovery action can't be read: the
      // not-invokable text, or a source run the pause cancelled.
      notInvokable: NOT_INVOKABLE.test(String(comment.body ?? "")) || rowValue(evidence, "Failure code") === "agent_paused",
    };
  }
  return NOT_INVOKABLE.test(String(comment.body ?? "")) ? { actionId: null, notInvokable: true } : null;
}

// Blockers that still hold the issue: anything not done or cancelled, or whose
// status Paperclip didn't give (assumed to hold it).
export function holdingBlockers(issue) {
  return (Array.isArray(issue?.blockedBy) ? issue.blockedBy : []).filter((b) => !SETTLED_BLOCKER.has(b?.status));
}

// Did the issue change status after the comment? Paperclip sets blockedTransitionAt
// when an issue moves into blocked, in the same transaction that posts the comment
// (so within a moment of it). A later one means it left blocked and came back.
export function statusChangedSince(issue, commentAt) {
  const at = ts(issue?.blockedTransitionAt);
  return Boolean(at && commentAt && at - commentAt > 60_000);
}

// Is this recovery action one that blocked the issue because its assignee couldn't
// be invoked? Unknown (null) when the action wasn't found: the comment decides.
export function pauseRecoveryAction(action) {
  if (!action) return null;
  if (action.ownerType && action.ownerType !== "board") return false;
  const kind = action.kind ?? "stranded_assigned_issue";
  const cause = action.cause ?? "stranded_assigned_issue";
  return kind === "stranded_assigned_issue" && cause === "stranded_assigned_issue";
}

// The status to restore: in_review while a review or approval stage is pending, so
// its participant is woken (a board move to todo or in_progress would dissolve the
// stage); otherwise the status Paperclip recorded before the block; else todo.
export function restoreStatus(issue, action) {
  const state = issue?.executionState;
  if (state?.status === "pending" && state.currentStageType) return { status: "in_review", from: "review stage" };
  const previous = action?.evidence?.previousStatus;
  if (RESTORABLE.has(previous)) return { status: previous, from: "recovery evidence" };
  return { status: "todo", from: "default" };
}

// How many of an agent's issues to restore per tick: its maxConcurrentRuns
// (runtimeConfig.heartbeat), clamped as Paperclip does, or 1 when it doesn't say.
export function concurrencyOf(agent) {
  const raw = Number(agent?.runtimeConfig?.heartbeat?.maxConcurrentRuns);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(MAX_CONCURRENT_RUNS_LIMIT, Math.floor(raw));
}

const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };

// Most urgent first, then the longest blocked.
export function sweepOrder(a, b) {
  const pa = PRIORITY[a?.priority] ?? 2;
  const pb = PRIORITY[b?.priority] ?? 2;
  return pa - pb || ts(a?.updatedAt) - ts(b?.updatedAt);
}
