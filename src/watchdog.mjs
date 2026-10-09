// Watchdog: wake agents whose work Paperclip left stalled.
//
// 1. Dropped hand-offs (paperclipai/paperclip#13769, #13880). When an issue
//    changes hands (engineer → reviewer, reviewer → engineer, …) Paperclip
//    cancels the finishing run, which still holds the environment lease for a
//    minute or two. The new owner's wake is refused ("has not released its
//    environment lease") and never retried. The watchdog finds issues whose
//    owner never started after a hand-off and comments on them, which wakes
//    the assignee, as you would by hand.
//
// 2. Blocked issues whose blockers are all done. Paperclip should wake the
//    assignee with issue_blockers_resolved, but that wake can be dropped the
//    same way. They get the same kind of comment once quiet for the stall window.
//
// 3. Done blockers whose workspace clean-up failed. A blocker is done, but the
//    clean-up of its workspace (workspace_finalize) failed, typically because
//    the run was cancelled at a hand-off while syncing back. Paperclip then
//    treats the blocker as unresolved forever and skips every wake for the
//    dependent. With WATCHDOG_HEAL_FAILED_FINALIZE on, the watchdog removes such
//    blockers from the dependent's "Blocked by", moves it to todo if nothing
//    else blocks it, and explains why in a comment that also wakes the assignee.
//
// 4. Wakes deferred behind a run that still holds execution. A comment can't
//    help: its wake is deferred too. The watchdog logs it once and, with
//    WATCHDOG_RETRY_DEFERRED on, presses Paperclip's own "send queued messages
//    now" (queued-comments/interrupt). For a stopped run that grants one extra
//    clean-up attempt on the run's environment lease, then re-sends the saved
//    comments. It never interrupts a running run.
//
// 5. Recovery holds left by a hand-off. Paperclip's recovery can give up on a
//    run that was cancelled when the issue changed hands ("Automatic recovery
//    blocked", board decision required) and mark the issue blocked, with the
//    saved messages waiting. With WATCHDOG_RETRY_DEFERRED on, the watchdog
//    delivers them to the current owner, as the board's Interrupt button does.
//    A hold with any other cause is only reported: that decision stays yours.
//
// 6. Issues Paperclip's recovery parked because it couldn't run the assignee.
//    Its sweep finds an assigned issue whose agent is paused (or whose run was
//    cut off by a hand-off), records a recovery action for the board
//    (stranded_assigned_issue: "Automatic recovery blocked") and marks the issue
//    blocked. Nothing un-parks it when the agent comes back. A board comment is
//    the decision Paperclip is waiting for, so once the agent is available the
//    watchdog comments, or delivers the saved messages if there are any. Any
//    other kind of recovery action is only reported.
//
// 7. Holds Paperclip can never release by itself. A run that stopped without a
//    process id or stop record Paperclip can check (cut off at a hand-off, or an
//    adapter that failed to start) leaves the issue held for reconciliation
//    (legacy_execution_requires_reconciliation), and every message, Interrupt
//    and comment is saved behind it ("no verified stop record"). Waiting changes
//    nothing. With WATCHDOG_RELEASE_HOLDS on, once the run has been over for the
//    stall window, the watchdog records the board's reconciliation (the run has
//    stopped; what it did is unverified) and delivers the saved messages, as
//    `pch release --apply` does. Once per held run; a hold whose run may still be
//    running, holds a lease or has a live process is only reported.
//
// Nudges and retries are capped per situation (WATCHDOG_MAX_NUDGES) and spaced
// by the stall window. Their counts are kept in the state file across restarts.

import { companyAgents, listIssues } from "./paperclip.mjs";
import { agentMention, every, mapLimit, ts } from "./util.mjs";
import { holdFacts, releaseHold, releaseProblems, unprovable } from "./release.mjs";

const WATCHED_STATUSES = "todo,in_progress,in_review";
const ACTIVE_RUN = new Set(["queued", "scheduled_retry", "running"]);
const PENDING_WAKE = new Set(["queued", "claimed", "deferred_issue_execution"]);
const CONCURRENCY = 4;
// Plain text, no URL: Paperclip links every github.com pull-request URL in a
// comment to the issue as one of its PRs, so a link here would show Paperclip's
// own PR on every issue the watchdog nudges.
const HANDOFF_BUG = "paperclipai/paperclip#13880";

// A paused task tree refuses a board user's comment, alone or with a PATCH, with
// 409 "Task is paused" (assertBoardCommentNotPaused). Nothing to do until it resumes.
const pausedRefusal = (err) => err?.status === 409 && /paused/i.test(err.message);

// What the watchdog has done about each situation, as keys of one map persisted
// in the state file (state.nudges): { count, at } per key. The key formats are
// stored, so changing one would forget its counts on upgrade.
const record = {
  handOff: (issue, run) => `${issue.id}:${issue.assigneeAgentId}:${run.runId ?? run.id}`, // nudges after a dropped hand-off
  blocked: (issue, done) => `blocked:${issue.id}:${done.join(",")}`, // nudges once blockers are done
  retry: (issue) => `retry:${issue.id}`, // "send queued messages now" presses
  retrySkipped: (issue) => `retry-skip:${issue.id}`, // a deferred wake with nothing to re-send, reported once
  stuck: (issue, wake) => `stuck:${issue.id}:${wake.requestedAt}`, // a deferred wake, reported once
  hold: (issue, runId) => `hold:${issue.id}:${runId}`, // presses to release a hand-off's recovery hold
  holdReported: (issue, runId) => `hold-report:${issue.id}:${runId}`, // a hold left to the board, reported once
  parked: (issue, actionId) => `parked:${issue.id}:${actionId}`, // nudges for an issue Paperclip's recovery parked
  parkedReported: (issue, actionId) => `parked-report:${issue.id}:${actionId}`, // a parked issue left to the board, reported once
  release: (issue, runId) => `release:${issue.id}:${runId}`, // the one automatic release of a hold Paperclip can't release
  releaseReported: (issue, runId) => `release-report:${issue.id}:${runId}`, // such a hold that isn't safe to release, reported once
  releaseNudge: (issue, runId) => `release-nudge:${issue.id}:${runId}`, // the comment after a release with no saved messages
};

export function createWatchdog(ctx, state) {
  const { config, api, log } = ctx;
  const records = state.nudges;
  const stats = { ticks: 0, lastTickAt: null, lastTickMs: null, nudges: 0, heals: 0, stuck: 0, retries: 0, releases: 0, lastError: null };
  const stallMs = config.watchdogStallSec * 1000;
  const now = () => ctx.now();

  async function agentFor(id, agents) {
    if (!agents.has(id)) agents.set(id, await api.request("GET", `/api/agents/${id}`));
    return agents.get(id);
  }

  // A wake still waiting in Paperclip's queue (the agent is busy elsewhere, or
  // the issue's previous run still holds execution) means a comment can't help.
  async function hasPendingWake(issue, runs, agents = new Map()) {
    const wakes = await api.request("GET", `/api/issues/${issue.id}/diagnostics/wakes`).catch(() => null);
    // Only the assignee's own wakes count. The diagnostics list every agent's
    // wakes for the issue, and after a hand-off the previous owner's (or a
    // mentioned agent's) wake can stay deferred forever while nothing at all
    // is waiting for the assignee. agentId is null only when the key can't read
    // internal ids; then any pending wake counts.
    //
    // A deferred wake is stale once a run was created on the issue after it and
    // has finished: execution moved on without it, and Paperclip never promotes
    // it afterwards. Carried across reassignments, such a wake would otherwise
    // hide a dropped hand-off indefinitely, however many later runs come and go.
    const finished = (Array.isArray(runs) ? runs : []).filter((r) => !ACTIVE_RUN.has(r.status));
    const stale = (e) =>
      e.status === "deferred_issue_execution" && ts(e.requestedAt) > 0 && finished.some((r) => ts(r.createdAt) > ts(e.requestedAt));
    const pending = (wakes?.events ?? []).filter(
      (e) =>
        e.kind === "wake_request" &&
        PENDING_WAKE.has(e.status) &&
        (e.agentId == null || e.agentId === issue.assigneeAgentId) &&
        !stale(e),
    );
    // A wake deferred for the stall window may sit behind a hold Paperclip can
    // never release by itself: release that instead of retrying into it.
    if (pending.some((e) => e.status === "deferred_issue_execution" && now() - ts(e.requestedAt) >= stallMs)) {
      if (await releaseUnprovableHold(issue, agents)) return true;
    }
    if (!pending.length) {
      // Nothing waiting any more: a later episode gets its own retries.
      if (records.delete(record.retry(issue)) | records.delete(record.retrySkipped(issue))) state.touch();
      return false;
    }
    // Deferred for much longer than a lease is normally held: say so, once, and
    // optionally ask Paperclip to retry. Events are newest first, so [0] is the
    // latest wake: the one a fresh comment or retry would have produced.
    const stuck = pending.every((e) => e.status === "deferred_issue_execution" && now() - ts(e.requestedAt) > 3 * stallMs);
    if (stuck) {
      reportStuck(issue, pending[0], runs);
      if (config.watchdogRetryDeferred) await retryDeferred(issue);
    }
    return true;
  }

  // Paperclip's "send queued messages now" for a deferred queue of saved comments.
  async function retryDeferred(issue, key = record.retry(issue)) {
    const prior = records.get(key);
    const count = prior?.count ?? 0;
    if (count >= config.watchdogMaxNudges || (prior && now() - prior.at < stallMs)) return;
    const who = issue.identifier ?? issue.id;
    const queue = await api.request("GET", `/api/issues/${issue.id}/queued-comments`).catch(() => null);
    // Only a deferred queue of saved comments, in what Paperclip calls its "legacy"
    // queued-comments protocol, can be re-sent, and never one that targets a
    // running run: the interrupt would cancel that run.
    if (!queue?.queueId || queue.state !== "deferred" || queue.protocol !== "legacy" || !queue.entries?.length || queue.targetRunId) {
      const skipKey = record.retrySkipped(issue);
      if (!records.has(skipKey)) {
        records.set(skipKey, { count: 1, at: now() });
        state.touch();
        log.warn("watchdog: no saved comments to re-send for this deferred wake; it needs a manual look", {
          issue: who,
          queueState: queue?.state ?? null,
          protocol: queue?.protocol ?? null,
          entries: queue?.entries?.length ?? 0,
        });
      }
      return;
    }
    records.set(key, { count: count + 1, at: now() });
    state.touch();
    if (config.dryRun) {
      log("watchdog: would retry the deferred wake (dry run)", { issue: who, queueId: queue.queueId });
      return;
    }
    try {
      await api.request("POST", `/api/issues/${issue.id}/queued-comments/interrupt`, {
        queueId: queue.queueId,
        revision: queue.revision,
        targetRunId: null,
      });
      stats.retries += 1;
      log("watchdog: asked Paperclip to retry the deferred wake", {
        issue: who,
        queueId: queue.queueId,
        comments: queue.entries.length,
        retry: count + 1,
        executionWait: queue.executionWait?.reason ?? null,
      });
    } catch (err) {
      log.warn("watchdog: Paperclip refused to retry the deferred wake", { issue: who, retry: count + 1, error: err.message });
    }
  }

  // Paperclip's recovery can hold an issue ("Automatic recovery blocked", board
  // decision required), and mark it blocked, when the run it wanted to retry was
  // cancelled at a hand-off and its agent can no longer be invoked. The saved
  // messages then wait forever. For that one cause the cancelled run did nothing
  // that needs reconciling, so deliver the saved messages to the current owner,
  // as the board's Interrupt button does (DIR-86). Any other cause means Paperclip
  // is unsure what the run did: that stays the board's call, and is logged once.
  async function releaseHandOffHold(issue, blocker, runs, agents = new Map()) {
    if (await releaseUnprovableHold(issue, agents)) return;
    const who = issue.identifier ?? issue.id;
    const runId = blocker.runId ?? "unknown";
    const source = (Array.isArray(runs) ? runs : []).find((r) => (r.runId ?? r.id) === blocker.runId);
    const fromHandOff = source?.status === "cancelled" && source.errorCode === "issue_reassigned";
    if (!fromHandOff || !config.watchdogRetryDeferred) {
      const key = record.holdReported(issue, runId);
      if (records.has(key)) return;
      records.set(key, { count: 1, at: now() });
      state.touch();
      log.warn("watchdog: the issue is held for recovery and needs a board decision", {
        issue: who,
        cause: blocker.cause ?? null,
        sourceRun: blocker.runId ?? null,
        sourceRunError: source?.errorCode ?? null,
        nextAction: blocker.nextAction ?? null,
      });
      return;
    }
    await retryDeferred(issue, record.hold(issue, runId));
  }

  // ---------------------------------------------------------------- 7. holds Paperclip can't release

  // True when the issue is held in a way only the board can release (handled
  // here, or deliberately left); false when it isn't, so the other checks go on.
  async function releaseUnprovableHold(issue, agents) {
    if (!config.watchdogReleaseHolds) return false;
    const facts = await holdFacts(api, issue.id).catch(() => null);
    if (!facts?.hold || !unprovable(facts)) return false;
    const { hold, run } = facts;
    const who = issue.identifier ?? issue.id;
    const key = record.release(issue, hold.runId);
    if (records.has(key)) {
      // Released once already and held again for the same run: that's for the board.
      const reported = record.releaseReported(issue, hold.runId);
      if (now() - records.get(key).at >= stallMs && !records.has(reported)) {
        records.set(reported, { count: 1, at: now() });
        state.touch();
        log.warn("watchdog: a hold the watchdog released is back; it needs a board decision", {
          issue: who,
          sourceRun: hold.runId,
          hint: `See \`pch why ${who}\`.`,
        });
      }
      return true;
    }
    const agent = issue.assigneeAgentId ? await agentFor(issue.assigneeAgentId, agents).catch(() => null) : null;
    // Delivering a message to an agent Paperclip can't invoke only strands it again.
    if (!agent || asleep(agent)) return true;
    const endedAt = ts(run?.finishedAt);
    if (!endedAt || now() - endedAt < stallMs) return true; // give a run that just stopped its stall window
    const problems = releaseProblems(facts);
    if (problems.length) {
      const reported = record.releaseReported(issue, hold.runId);
      if (!records.has(reported)) {
        records.set(reported, { count: 1, at: now() });
        state.touch();
        log.warn("watchdog: a hold Paperclip can't release by itself isn't safe to release yet", {
          issue: who,
          sourceRun: hold.runId,
          problems,
          hint: `See \`pch release ${who}\`.`,
        });
      }
      return true;
    }
    records.set(key, { count: 1, at: now() });
    state.touch();
    const saved = facts.queue?.entries?.length ?? 0;
    if (config.dryRun) {
      log("watchdog: would release a hold Paperclip can't release by itself (dry run)", { issue: who, sourceRun: hold.runId, saved });
      return true;
    }
    let result;
    try {
      result = await releaseHold(api, facts, {
        note:
          "Released by Paperclip Helper's watchdog: the held run stopped without a record Paperclip could verify, " +
          "so Paperclip could never release this hold by itself.",
      });
    } catch (err) {
      log.warn("watchdog: couldn't release a hold Paperclip can't release by itself", {
        issue: who,
        sourceRun: hold.runId,
        error: err.message,
        hint: `See \`pch release ${who}\`.`,
      });
      return true;
    }
    stats.releases += 1;
    log("watchdog: released a hold Paperclip couldn't release by itself", {
      issue: who,
      sourceRun: hold.runId,
      sourceRunStatus: run ? `${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}` : null,
      delivered: result.delivered,
    });
    if (!result.delivered && !result.waiting) {
      await nudge(
        issue,
        record.releaseNudge(issue, hold.runId),
        agent,
        `Paperclip held this issue because an earlier run stopped without a record it could verify, and it ` +
          `couldn't release the hold by itself. The watchdog has released it. That run may have done part of ` +
          `its work: check the workspace and branch before you build on it, then please continue this issue.`,
        { reason: "released hold" },
      );
    }
    return true;
  }

  // An issue blocked by an active recovery action that waits on the board.
  async function releaseParkedIssue(issue, action, agents) {
    const who = issue.identifier ?? issue.id;
    const agent = await agentFor(issue.assigneeAgentId, agents).catch(() => null);
    // Waking an agent Paperclip can't invoke is what parked the issue in the first place.
    if (!agent || asleep(agent)) return;
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
    if ((Array.isArray(runs) ? runs : []).some((r) => ACTIVE_RUN.has(r.status))) return;
    if (action.kind !== "stranded_assigned_issue" || action.ownerType !== "board") {
      // Paperclip is asking for a judgement (a stalled review, an uncertain action): not ours to make.
      const key = record.parkedReported(issue, action.id);
      if (records.has(key)) return;
      records.set(key, { count: 1, at: now() });
      state.touch();
      log.warn("watchdog: Paperclip's recovery parked the issue and it needs a board decision", {
        issue: who,
        kind: action.kind ?? action.cause ?? null,
        owner: action.ownerType ?? null,
        nextAction: action.nextAction ?? null,
        hint: `See \`pch why ${who}\` for what to do.`,
      });
      return;
    }
    // Saved messages go first: they are what the agent was meant to act on.
    const queue = config.watchdogRetryDeferred
      ? await api.request("GET", `/api/issues/${issue.id}/queued-comments`).catch(() => null)
      : null;
    if (queue?.queueId && queue.state === "deferred" && queue.protocol === "legacy" && queue.entries?.length && !queue.targetRunId) {
      await retryDeferred(issue, record.hold(issue, action.id));
      return;
    }
    await nudge(
      issue,
      record.parked(issue, action.id),
      agent,
      `Paperclip's recovery parked this issue for a board decision: it couldn't run you when it looked ` +
        `(you were paused, or the issue had just changed hands). You are available again and nothing else ` +
        `blocks the issue. Please continue it.`,
      { reason: "parked by recovery", kind: action.kind },
    );
  }

  function reportStuck(issue, wake, runs) {
    const key = record.stuck(issue, wake);
    if (records.has(key)) return;
    records.set(key, { count: 1, at: now() });
    state.touch();
    stats.stuck += 1;
    const previous = (Array.isArray(runs) ? runs : []).find((r) => r.environmentLease || r.errorCode);
    log.warn("watchdog: a wake has been deferred for too long; a comment can't help", {
      issue: issue.identifier ?? issue.id,
      reason: wake.reason,
      deferredMin: Math.round((now() - ts(wake.requestedAt)) / 60_000),
      previousRun: previous?.runId ?? null,
      previousRunLease: previous?.environmentLease?.status ?? null,
      hint: `Paperclip is waiting for an earlier run to release execution (${HANDOFF_BUG}). See \`pch why ${issue.identifier ?? issue.id}\`.`,
    });
  }

  // Paperclip doesn't wake these (agent-eligibility.ts), so a nudge can't help.
  const asleep = (agent) => ["paused", "terminated", "pending_approval"].includes(agent?.status);

  // ---------------------------------------------------------------- 1. hand-offs

  // Cancelled by Paperclip at admission, before any work: see stalledHandOff.
  const refused = (run) => run.status === "cancelled" && run.errorCode === "execution_reconciliation_required";

  async function stalledHandOff(issue, agents) {
    const assignee = issue.assigneeAgentId;
    const agent = await agentFor(assignee, agents);
    if (asleep(agent)) return null;

    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`);
    if (!Array.isArray(runs) || runs.length === 0) return null; // never worked on: not a hand-off
    if (runs.some((r) => r.agentId === assignee && ACTIVE_RUN.has(r.status))) return null;
    const newest = (list) => list.reduce((a, b) => (ts(b.createdAt) > ts(a.createdAt) ? b : a));
    // A run Paperclip cancelled before it started, because the issue was held for
    // reconciliation after a hand-off, did no work. It doesn't count as the owner
    // having run: the hold clears on its own, but the wakes were skipped, so
    // nothing wakes the owner again (DIR-91, DIR-95).
    const worked = runs.filter((r) => !refused(r));
    if (!worked.length) return null;
    const latest = newest(worked);
    if (latest.agentId === assignee) {
      // The owner's own run ended without finishing; Paperclip may hold the issue for it.
      if (latest.status !== "succeeded" && !ACTIVE_RUN.has(latest.status)) await releaseUnprovableHold(issue, agents);
      return null; // the owner has run since the hand-off
    }
    if (ACTIVE_RUN.has(latest.status)) return null; // the previous owner is still finishing
    const last = newest(runs); // quiet since the last attempt, refused or not
    const endedAt = ts(last.finishedAt) || ts(last.startedAt) || ts(last.createdAt);
    const sinceRunSec = Math.round((now() - endedAt) / 1000);
    if (sinceRunSec < config.watchdogStallSec) return null;
    // A wake waiting in the agent's queue (it's busy elsewhere) is not a stall.
    if (await hasPendingWake(issue, runs, agents)) return null;
    if (worked.length < runs.length) {
      // While the hold is still in place, a comment's run would be refused too.
      const full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
      if (full?.executionBlocker) {
        await releaseHandOffHold(issue, full.executionBlocker, runs, agents);
        return null;
      }
    }
    return { agent, latest, sinceRunSec };
  }

  // ---------------------------------------------------------------- 2. unblocked

  async function unblockedButIdle(issue, diag, agents) {
    const assignee = issue.assigneeAgentId;
    const agent = await agentFor(assignee, agents);
    if (asleep(agent)) return null;
    const blockers = Array.isArray(diag?.blockers) ? diag.blockers : [];
    if (!diag?.readiness?.allBlockersDone || blockers.length === 0) return null;
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
    if ((Array.isArray(runs) ? runs : []).some((r) => r.agentId === assignee && ACTIVE_RUN.has(r.status))) return null;
    if (await hasPendingWake(issue, runs, agents)) return null;
    const done = blockers.map((b) => b.identifier ?? b.id).sort();
    return { agent, done };
  }

  // ---------------------------------------------------------------- 3. failed finalize

  // The latest operation on the blocker's execution workspace, if it's a failed
  // workspace_finalize that finished more than the stall window ago.
  async function failedFinalizeOf(blockerRef) {
    const blocker = await api.request("GET", `/api/issues/${encodeURIComponent(blockerRef)}`).catch(() => null);
    if (!blocker || blocker.status !== "done" || !blocker.executionWorkspaceId) return null;
    const ops = await api
      .request("GET", `/api/execution-workspaces/${blocker.executionWorkspaceId}/workspace-operations`)
      .catch(() => []);
    const latest = (Array.isArray(ops) ? ops : []).reduce((a, b) => (!a || ts(b.startedAt) > ts(a.startedAt) ? b : a), null);
    if (!latest || latest.phase !== "workspace_finalize" || latest.status !== "failed") return null;
    const ageSec = Math.round((now() - (ts(latest.finishedAt) || ts(latest.startedAt))) / 1000);
    if (ageSec < config.watchdogStallSec) return null;
    return { blocker, op: latest, ageSec };
  }

  async function healFailedFinalize(issue, diag, agents) {
    const nodes = Array.isArray(diag?.blockers) ? diag.blockers : [];
    const pending = nodes.filter((b) => b.isPendingFinalize);
    // Only when every blocker is done and the only thing holding it is finalization.
    if (!pending.length || nodes.some((b) => b.status !== "done")) return false;
    // Moving the issue to todo for an agent Paperclip can't invoke makes its
    // recovery give up on the issue ("Automatic recovery blocked") and block it
    // again, this time for a board decision (DIR-109). Wait until it's back.
    if (issue.assigneeAgentId && asleep(await agentFor(issue.assigneeAgentId, agents).catch(() => null))) return false;
    const stuck = [];
    for (const b of pending) {
      const failed = await failedFinalizeOf(b.id ?? b.identifier);
      if (!failed) return false; // not a failed finalize a stall window old: leave it to Paperclip for now
      stuck.push(failed);
    }
    const full = await api.request("GET", `/api/issues/${issue.id}`);
    const currentIds = (full.blockedBy ?? []).map((r) => r.id).filter(Boolean);
    const drop = new Set(stuck.map((s) => s.blocker.id));
    const keep = currentIds.filter((id) => !drop.has(id));
    const names = stuck.map((s) => s.blocker.identifier ?? s.blocker.id).join(", ");
    const agent = issue.assigneeAgentId ? await agentFor(issue.assigneeAgentId, agents).catch(() => null) : null;
    const mention = agent ? `${agentMention(agent)} ` : "";
    const one = stuck.length === 1;
    const comment =
      `${mention}${names} ${one ? "is" : "are"} done, but ${one ? "its" : "their"} workspace clean-up ` +
      `(workspace_finalize) failed, so Paperclip kept this issue blocked and skipped every wake. The watchdog removed ` +
      `${names} from "Blocked by". The failed clean-up may have left this workspace without ${one ? "its" : "their"} latest ` +
      `changes: pull the branch before you continue.` +
      (keep.length ? "" : " Nothing else blocks this issue, so it is back in todo. Please continue it.") +
      `\n\n_Paperclip Helper watchdog._`;
    const patch = { blockedByIssueIds: keep, comment, ...(keep.length ? {} : { status: "todo" }) };
    const who = issue.identifier ?? issue.id;
    if (config.dryRun) {
      log("watchdog: would detach failed-finalize blockers (dry run)", { issue: who, blockers: names });
      return true;
    }
    try {
      await api.request("PATCH", `/api/issues/${issue.id}`, patch);
    } catch (err) {
      if (!pausedRefusal(err)) throw err;
      log.debug("watchdog: the issue is paused; repair postponed", { issue: who });
      return true;
    }
    stats.heals += 1;
    log("watchdog: detached failed-finalize blockers", { issue: who, blockers: names, remaining: keep.length });
    return true;
  }

  // ---------------------------------------------------------------- nudges

  // Posts the comment unless this situation already had its nudges, or had one
  // within the stall window.
  async function nudge(issue, key, agent, message, logExtra) {
    const prior = records.get(key);
    const count = prior?.count ?? 0;
    if (count >= config.watchdogMaxNudges || (prior && now() - prior.at < stallMs)) return;
    records.set(key, { count: count + 1, at: now() });
    state.touch();
    const who = issue.identifier ?? issue.id;
    const body = `${agentMention(agent)} ${message}\n\n_Paperclip Helper watchdog, nudge ${count + 1}/${config.watchdogMaxNudges}._`;
    if (config.dryRun) {
      log("watchdog: would nudge (dry run)", { issue: who, agent: agent.name, ...logExtra });
      return;
    }
    try {
      await api.request("POST", `/api/issues/${issue.id}/comments`, { body });
    } catch (err) {
      if (!pausedRefusal(err)) throw err;
      // Try again a stall window later, without using up a nudge.
      records.set(key, { count, at: now() });
      log.debug("watchdog: the issue is paused; nudge postponed", { issue: who });
      return;
    }
    stats.nudges += 1;
    log("watchdog: nudged", { issue: who, agent: agent.name, nudge: count + 1, ...logExtra });
  }

  const quiet = (issue) => now() - ts(issue.updatedAt) >= stallMs;
  const candidate = (issue) => issue.assigneeAgentId && !issue.executionRunId && !issue.checkoutRunId && quiet(issue);

  async function checkHandOffs(companyId, agents) {
    const issues = (await listIssues(api, companyId, WATCHED_STATUSES)).filter(candidate);
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      try {
        const stall = await stalledHandOff(issue, agents);
        if (!stall) return;
        await nudge(
          issue,
          record.handOff(issue, stall.latest),
          stall.agent,
          `this issue is yours now (${issue.status}), but no run has started since the hand-off. ` +
            `Paperclip most likely refused the hand-off wake while the previous run released its environment lease, ` +
            `and nothing retried it (${HANDOFF_BUG}). Please pick it up.`,
          { reason: "dropped hand-off", sinceRunSec: stall.sinceRunSec },
        );
      } catch (err) {
        log.warn("watchdog: issue check failed", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
  }

  async function checkBlocked(companyId, agents) {
    const issues = (await listIssues(api, companyId, "blocked")).filter(
      (issue) => issue.assigneeAgentId && !issue.executionRunId && !issue.checkoutRunId,
    );
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      try {
        const diag = await api.request("GET", `/api/issues/${issue.id}/diagnostics/blockers`).catch(() => null);
        if (!diag) return;
        if (config.watchdogHealFailedFinalize && !diag.readiness?.allBlockersDone) {
          if (await healFailedFinalize(issue, diag, agents)) return;
        }
        if (!quiet(issue)) return;
        if (!(Array.isArray(diag.blockers) ? diag.blockers : []).length) {
          // Blocked with no linked blocker: by an agent's own note, or by Paperclip's recovery.
          if (await releaseUnprovableHold(issue, agents)) return;
          const parked = await api.request("GET", `/api/issues/${issue.id}/recovery-actions`).catch(() => null);
          if (parked?.active) {
            await releaseParkedIssue(issue, parked.active, agents);
            return;
          }
          const full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
          if (!full?.executionBlocker) return;
          // Delivering a message to an agent Paperclip can't invoke only strands it again.
          if (asleep(await agentFor(issue.assigneeAgentId, agents).catch(() => null))) return;
          const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
          if ((Array.isArray(runs) ? runs : []).some((r) => ACTIVE_RUN.has(r.status))) return;
          await releaseHandOffHold(issue, full.executionBlocker, runs, agents);
          return;
        }
        const idle = await unblockedButIdle(issue, diag, agents);
        if (!idle) return;
        await nudge(
          issue,
          record.blocked(issue, idle.done),
          idle.agent,
          `every blocker on this issue is done (${idle.done.join(", ")}), but nothing picked it back up ` +
            `(the blockers-resolved wake was dropped). Please continue it.`,
          { reason: "blockers done" },
        );
      } catch (err) {
        log.warn("watchdog: blocked check failed", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
  }

  async function tick() {
    const started = now();
    const { companyIds = [] } = await ctx.identity();
    try {
      for (const companyId of companyIds) {
        const list = await companyAgents(api, companyId).catch(() => []);
        const agents = new Map(list.map((a) => [a.id, a]));
        await checkBlocked(companyId, agents);
        await checkHandOffs(companyId, agents);
      }
      stats.lastError = null;
    } catch (err) {
      stats.lastError = err.message;
      throw err;
    } finally {
      stats.ticks += 1;
      stats.lastTickAt = new Date(started).toISOString();
      stats.lastTickMs = now() - started;
      state.save();
    }
  }

  let loop = null;
  return {
    tick,
    stats,
    start() {
      log("watchdog on", {
        everySec: config.watchdogIntervalSec,
        stallSec: config.watchdogStallSec,
        maxNudges: config.watchdogMaxNudges,
        healFailedFinalize: config.watchdogHealFailedFinalize,
        retryDeferred: config.watchdogRetryDeferred,
        releaseHolds: config.watchdogReleaseHolds,
      });
      loop = every("watchdog", config.watchdogIntervalSec, 5_000, tick, log);
    },
    async stop() {
      await loop?.stop();
    },
  };
}
