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
// `pch release` and the watchdog share this module: the command for any such
// hold, after you've looked; the watchdog only for one Paperclip can never
// settle by itself.

export const RECONCILIATION_CAUSE = "legacy_execution_requires_reconciliation";
export const RELEASE_OUTCOMES = ["mixed", "completed", "not_performed"];
const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const ACTIVE_RUN = new Set(["queued", "scheduled_retry", "running"]);

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
  const agent = hold.agentId ? await api.request("GET", `/api/agents/${hold.agentId}`).catch(() => null) : null;
  const queue = await api.request("GET", `/api/issues/${id}/queued-comments`).catch(() => null);
  return { issue, hold, run, agent, queue, activeRun: list.some((r) => ACTIVE_RUN.has(r.status)) };
}

// Why this hold can't be released at all right now; empty when it can.
export function releaseProblems(facts) {
  const { hold, run, activeRun } = facts;
  const problems = [];
  if (!hold.runId || !hold.recoveryActionId) problems.push("the hold names no source run or recovery action");
  if (hold.workspaceRepairRequired) problems.push("the hold needs a workspace repair, not a release");
  if (run && !TERMINAL_RUN.has(run.status)) problems.push(`the run is still ${run.status}`);
  if (activeRun) problems.push("another run on the issue is active");
  if (run?.environmentLease && !run.environmentLease.releasedAt) problems.push("its environment lease was never released");
  for (const pid of [run?.processPid, run?.processGroupId ? -run.processGroupId : null]) {
    if (pid && processAlive(pid)) problems.push(`process ${Math.abs(pid)} is still alive on this host`);
  }
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

// Records the board's reconciliation, then delivers the saved messages the way
// Interrupt does. Returns { status, delivered, waiting }.
export async function releaseHold(api, facts, { actionOutcome = "mixed", note, signature = "" } = {}) {
  const { issue, hold, run } = facts;
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  const ended = run ? `${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}` : "stopped";
  await api.request("POST", `/api/issues/${id}/recovery-actions/resolve`, {
    actionId: hold.recoveryActionId,
    outcome: "restored",
    sourceIssueStatus: "todo",
    resolutionNote: `${note ?? "Released by the board: the held run has stopped."}${signature}`,
    executionReconciliation: {
      runId: hold.runId,
      providerStopped: true,
      actionOutcome,
      outcomeEvidence:
        `Run ${hold.runId} ended ${ended} and recorded no process that is still running. ` +
        (actionOutcome === "mixed"
          ? "What it did before stopping is unverified; the assignee checks the workspace and branch before continuing."
          : `The board verified its actions as ${actionOutcome.replace("_", " ")}.`),
    },
  });
  const after = await api.request("GET", `/api/issues/${id}`);
  if (after.executionBlocker) {
    const err = new Error(`Paperclip accepted the release but still holds the issue (${after.executionBlocker.cause ?? "unknown cause"})`);
    err.stillHeld = true;
    throw err;
  }
  // Paperclip may start the saved messages by itself; press only if they still wait.
  const queue = await api.request("GET", `/api/issues/${id}/queued-comments`).catch(() => null);
  if (queue?.queueId && queue.entries?.length && queue.state === "deferred" && !queue.targetRunId && queue.protocol === "legacy") {
    await api.request("POST", `/api/issues/${id}/queued-comments/interrupt`, {
      queueId: queue.queueId,
      revision: queue.revision,
      targetRunId: null,
    });
    return { status: after.status, delivered: queue.entries.length, waiting: 0 };
  }
  return { status: after.status, delivered: 0, waiting: queue?.entries?.length ?? 0 };
}
