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
// 8. Issues linked to a closed workspace. An issue an agent creates from another
//    issue's work is linked to that issue's execution workspace (reuse_existing).
//    Paperclip closes the workspace when its issue finishes but leaves the links,
//    and every run on a linked issue then fails at setup ("requested inherited
//    execution workspace reuse … could not be restored"); retries fail the same
//    way. With WATCHDOG_CLEAR_DEAD_LINKS on, the watchdog clears the link on every
//    open issue linked to an archived or missing workspace, as `pch workspace
//    --apply` does: the next run gets a new isolated workspace, with the issue's
//    other workspace settings kept. Once per issue and workspace; an issue with a
//    run in progress or a workspace change already scheduled waits. When the
//    assignee's last run failed on the link and the issue is todo or in
//    progress, it also comments to restart the assignee. A link to a live
//    workspace, or to the issue's own closed one, is never touched.
//
// 9. Issues waiting for a workspace their agent scheduled. An agent that finds
//    its issue on another issue's branch schedules a workspace of its own for
//    its next run (PUT /api/issues/:id/workspace; Paperclip applies it at the
//    next admission) and leaves the issue in todo. Nothing starts that next run.
//    Once the issue has been quiet for the stall window with a pending workspace
//    selection and no run, the watchdog comments, which wakes the assignee. Part
//    of WATCHDOG_CLEAR_DEAD_LINKS.
//
// 10. Question cards addressed to a teammate who never sees them. An agent asks
//    a teammate (addresseeAgentId) with a card on its own issue. Paperclip wakes
//    the addressee, then cancels that run before it starts ("issue_assignee_changed"),
//    because the addressee isn't the issue's assignee. The card waits for good,
//    and so does everything blocked behind the asker. With WATCHDOG_ROUTE_QUESTIONS
//    on, once such a card has waited for the stall window and the addressee has
//    had no run on the issue since, the watchdog creates an issue assigned to the
//    addressee that says which card to answer and how (see questions.mjs). It
//    closes that issue once the card is answered or withdrawn. Once per card.
//
// 11. CI runs an agent waits on (ci-runs.mjs). An agent names a GitHub Actions
//    run it waits on in its latest comment (or the latest that names one, or its
//    Paperclip monitor's notes), then stops, or its monitor gives up before the
//    run finishes. A monitor that has fired, timed out or used up its attempts
//    won't fire again, and a wake that hasn't started within the stall window may
//    never start, so neither holds the report back; nor does a monitor whose notes
//    name the run, which is cleared in the same step as the report. With
//    WATCHDOG_CI_RUNS on and a GitHub token, once that run has finished and the
//    agent hasn't run on the issue since, the watchdog comments with the result,
//    which wakes it. With WATCHDOG_CI_RERUN_JOBS set, a run whose failed jobs all
//    match that pattern (known flaky jobs) is re-run first, up to
//    WATCHDOG_CI_RERUN_MAX times, while it is still the PR's head. Runs dispatched
//    with workflow_dispatch on the repository's default branch (read from GitHub)
//    are never re-run or silenced when the branch moves; every conclusion,
//    including cancelled, is reported.
//
// 12. Answers that reach nobody (board-held.mjs). An agent asked you with a card
//    and you answered it while the issue waited on your review, so Paperclip
//    woke the assignee: you. With WATCHDOG_DELIVER_ANSWERS on, the watchdog
//    returns the issue to that agent (your decision, "changes requested") with
//    the answer quoted. Once per card.
//
// 13. Reviews escalated by Paperclip's review-round limit (board-held.mjs). With
//    WATCHDOG_RETURN_ESCALATED_REVIEWS on (off by default), the watchdog returns
//    such a review to its implementer with the reviewer's latest request,
//    WATCHDOG_MAX_NUDGES times per issue, then leaves it to you.
//
// 14. Blocked by a cancelled issue. Paperclip never counts a cancelled blocker as
//    resolved, so the dependent stays blocked until someone edits its "Blocked
//    by". With WATCHDOG_CANCELLED_BLOCKERS on, the watchdog tells the dependent's
//    agent, quoting why the blocker was cancelled, so it can remove or replace
//    the blocker itself. Once per blocker.
//
// 15. Issues blocked by recovery while their agent was paused (resume.mjs). Pausing
//    an agent with runs queued or in flight makes Paperclip's recovery give up on
//    each affected issue: it is set to blocked with a system comment whose
//    "Recovery" section says the board must decide ("the original assignee is not
//    invokable"). Resuming the agent restarts none of them. With
//    WATCHDOG_RESUME_SWEEP on, the watchdog remembers each agent's status every
//    tick; when one goes from paused to available, it restores that agent's issues
//    whose newest comment is that recovery notice, posted while the agent was
//    paused, with no unresolved blocker and no status change since. Each goes back
//    to in_review if a review stage is pending, else to the status Paperclip
//    recorded before the block (todo if it didn't), with one comment, which wakes
//    the assignee. At most WATCHDOG_RESUME_SWEEP_LIMIT runs in flight per agent
//    from the sweep (default: the agent's maxConcurrentRuns); the rest follow on
//    later ticks. A block from while the agent was running, an issue a person has
//    acted on since, and an issue blocked for any other reason are never touched.
//    6 leaves alone the issues a sweep under way is still to restore. A review
//    whose pending stage waits on the paused agent is blocked the same way ("the
//    participant is not invokable", cause execution_review_participant_recovery):
//    it goes back to in_review, which re-wakes the participant. An agent already
//    paused when the helper starts counts from its pausedAt, else its latest
//    "agent.paused" activity, else an unknown time; one resumed before the
//    helper's first look (the activity log again) is swept too.
//
// 16. Usage limits (limits.mjs). When a plan hits its usage limit (a Claude
//    account's 5-hour, weekly or spend limit; a ChatGPT plan's limit for Codex, or
//    an API key's quota), every agent on it fails its next run and Paperclip keeps
//    retrying them. With WATCHDOG_USAGE_LIMIT_PAUSE on (WATCHDOG_LIMIT_PAUSE before
//    1.12), each adapter's recogniser reads its failed runs: a limit pauses every
//    agent on the same account (Claude: the ANTHROPIC_API_KEY or
//    CLAUDE_CODE_OAUTH_TOKEN secret, or the machine's own login; Codex: the
//    OPENAI_API_KEY secret, or the login in CODEX_HOME), each once it has no run
//    queued or going: pausing mid-run cancels the run. Transient capacity ("model is
//    at capacity") is left to Paperclip's retries, and an adapter without a
//    recogniser is left alone. The board is told once (the log, and
//    WATCHDOG_NOTIFY_ISSUE). At the reset the message gives (an hour later when it
//    gives none), plus WATCHDOG_LIMIT_RESUME_GRACE_MIN, it resumes exactly the
//    agents it paused, never one a person paused, and 15 restores their issues.
//
// 17. Wiped review stages (stages.mjs). An agent's update that sends an empty
//    executionPolicy.stages removes the issue's reviews (a Paperclip bug), and the
//    issue closes with its PR open and unreviewed. With WATCHDOG_STAGES_WIPE on, a
//    done issue whose own PR is still open is set back to in_progress with a
//    comment, and an issue in progress or in review whose activity shows its stages
//    were removed is reported; the board is told either way. Stages aren't
//    re-created. (The relay closes an issue on its PR's merge when no stage is
//    left to approve: RELAY_DONE_WITHOUT_STAGES.)
//
// Nudges and retries are capped per situation (WATCHDOG_MAX_NUDGES) and spaced
// by the stall window. Their counts are kept in the state file across restarts.

import { companyAgents, listIssues } from "./paperclip.mjs";
import { ACTIVE_RUN, agentMention, asleep, every, mapLimit, pausedRefusal, ts, WATCHDOG_SIGNATURE } from "./util.mjs";
import { holdFacts, releaseHold, releaseProblems, unprovable } from "./release.mjs";
import { clearLink, deadLinkWorkspaceId, isolatedWorkspacesEnabled, linkedWorkspace } from "./workspace.mjs";
import { addresseeReached, cardText, pendingCards, QUESTION_STATUSES, relayIssue, strandedCard } from "./questions.mjs";
import { createGitHub } from "./github.mjs";
import { createCiRunsCheck } from "./ci-runs.mjs";
import { createBoardHeldCheck, quote } from "./board-held.mjs";
import { createLimitCheck, localZone, RECOGNISERS } from "./limits.mjs";
import { createStagesCheck } from "./stages.mjs";
import { findIdentifiers } from "./identifiers.mjs";
import {
  concurrencyOf, holdingBlockers, participantRecoveryAction, PARTICIPANT_RECOVERY_CAUSE, pauseRecoveryAction, recoveryNotice, restoreStatus,
  reviewParticipantOf, statusChangedSince, sweepOrder,
} from "./resume.mjs";

const WATCHED_STATUSES = "todo,in_progress,in_review";
const OPEN_STATUSES = "backlog,todo,in_progress,in_review,blocked";
// Statuses where a comment restarts the assignee without overriding a decision:
// a blocked issue may be blocked for a reason, and one in review waits on a reviewer.
const RESTARTABLE = new Set(["todo", "in_progress"]);
const PENDING_WAKE = new Set(["queued", "claimed", "deferred_issue_execution"]);
const CONCURRENCY = 4;
// A run that failed on the model provider: a usage limit, or the transient family Paperclip files
// some limits under (it took Claude's "You've hit your org's monthly spend limit" for transient).
const PROVIDER_FAILURE = /^(provider_quota|[a-z]+_transient_upstream|transient_upstream)$/;
const PROVIDER_FAILURE_HOLD_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// A long-lived record is touched this often, so the state file (which forgets records
// untouched for a week) keeps it.
const RECORD_REFRESH_MS = 24 * 60 * 60_000;
const latestRun = (runs) =>
  runs.reduce((a, r) => (!a || ts(r.finishedAt ?? r.createdAt) > ts(a.finishedAt ?? a.createdAt) ? r : a), null);
// Plain text, no URL: Paperclip links every github.com pull-request URL in a
// comment to the issue as one of its PRs, so a link here would show Paperclip's
// own PR on every issue the watchdog nudges.
const HANDOFF_BUG = "paperclipai/paperclip#13880";


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
  parked: (issue) => `parked:${issue.id}:${issue.assigneeAgentId}`, // nudges for an issue Paperclip's recovery parked, whatever the action
  parkedReported: (issue, actionId) => `parked-report:${issue.id}:${actionId}`, // a parked issue left to the board, reported once
  release: (issue, runId) => `release:${issue.id}:${runId}`, // the one automatic release of a hold Paperclip can't release
  releaseReported: (issue, runId) => `release-report:${issue.id}:${runId}`, // such a hold that isn't safe to release, reported once
  releaseNudge: (issue, runId) => `release-nudge:${issue.id}:${runId}`, // the comment after a release with no saved messages
  deadLink: (issue, wsId) => `dead-link:${issue.id}:${wsId}`, // the one clearing of a link to a closed workspace
  deadLinkNudge: (issue, wsId) => `dead-link-nudge:${issue.id}:${wsId}`, // the comment that restarts the assignee after it
  deadLinkFail: (issue, wsId) => `dead-link-fail:${issue.id}:${wsId}`, // failed attempts to clear it, retried a stall window apart
  deadLinkOwn: (issue, wsId) => `dead-link-own:${issue.id}:${wsId}`, // a link to the issue's own closed workspace, reported once
  deadLinkOff: () => "dead-link-off", // isolated workspaces off, so links can't be cleared: reported once a day
  question: (card) => `question:${card.id}`, // the issue that routed a stranded card to its addressee
  scheduledWorkspace: (issue) => `workspace-scheduled:${issue.id}:${issue.workspaceBindingRevision ?? "?"}`, // nudges to start a run on a scheduled workspace
  ciRun: (issue, run) => `ci:${issue.id}:${run.id}:${run.run_attempt ?? 1}`, // the comment that a run the agent waits on finished
  ciRerun: (repo, run) => `ci-rerun:${repo}#${run.id}`, // re-runs of a run's flaky failed jobs: { count, at }
  ciRerunFail: (repo, run) => `ci-rerun-fail:${repo}#${run.id}`, // GitHub refused a re-run, reported once
  answer: (card) => `answer:${card.id}`, // the return of an issue whose card you answered on your review
  escalated: (issue) => `escalated:${issue.id}`, // returns of reviews Paperclip escalated to you, per issue
  escalatedSeen: (issue, decisionId) => `escalated-seen:${issue.id}:${decisionId ?? "?"}`, // one return per escalation, or its report
  cancelledBlocker: (issue, ids) => `cancelled-blocker:${issue.id}:${ids.join(",")}`, // nudges about cancelled blockers
  agentPaused: (agentId) => `agent-paused:${agentId}`, // an agent seen paused: { since, companyId }
  agentResumed: (agentId) => `agent-resumed:${agentId}`, // its resume, while its issues are restored: { since, resumedAt, companyId }
  agentSwept: (agentId) => `agent-swept:${agentId}`, // the last resume whose sweep ended: { resumedAt }, so a restart doesn't sweep it again
  resumeRestore: (issue, commentId) => `resume-restore:${issue.id}:${commentId ?? "?"}`, // the one restore of an issue after a pause's recovery block
};

// 15. A resumed agent's issues are looked at for at most this long after the resume.
const RESUME_SWEEP_MS = 24 * 60 * 60_000;
// Clock slack between the helper and Paperclip when comparing a comment's time with a pause.
const CLOCK_SLACK_MS = 5_000;
// A pause whose start nobody can tell (an agent already paused when the helper starts,
// with neither Paperclip's pausedAt nor an "agent.paused" activity entry): `since` 0,
// so any recovery notice that says the agent couldn't be invoked counts.
const UNKNOWN_SINCE = 0;
// Agent activity read once per company when the helper starts: its pauses and resumes.
const STARTUP_ACTIVITY_LIMIT = 500;

export function createWatchdog(ctx, state, deps = {}) {
  const { config, api, log } = ctx;
  const records = state.nudges;
  const stats = {
    ticks: 0, lastTickAt: null, lastTickMs: null, nudges: 0, heals: 0, stuck: 0, retries: 0, releases: 0, deadLinks: 0, questions: 0,
    ciReports: 0, ciReruns: 0, returned: 0, resumed: 0, limitPauses: 0, limitResumes: 0, reopened: 0, wipes: 0, lastError: null,
  };
  const stallMs = config.watchdogStallSec * 1000;
  const liveWorkspaces = new Map(); // workspaceId → when it was last seen live
  const dryRunSeen = new Set(); // dead links and cards a dry run already logged, this process only
  const questionScanAt = new Map(); // companyId → when its cards were last looked at
  const seenStatus = new Map(); // agentId → its status at this process's previous tick
  const startupRead = new Set(); // companies whose agents' pauses and resumes were read at start-up
  let previousTickAt = null; // when this process's previous tick started
  const sweepHeld = new Map(); // agentId → ids of its issues a resume sweep will restore on a later tick
  let slots = new Map(); // agentId → Promise<{ left }>: runs it may still be given this tick (startSlots)
  const hasGitHubToken = Boolean(config.githubToken || config.githubTokenFile);
  const github = deps.github ?? (hasGitHubToken ? createGitHub({ config, log }) : null);
  const stagesCheck = createStagesCheck({ ctx, records, state, stats, dryRunSeen, github, identifiersOf: (pr) => findIdentifiers(pr, ctx.prefixes()) });
  const now = () => ctx.now();
  const limits = createLimitCheck({ api, config, log, records, state, now, stats, dryRunSeen });

  async function agentFor(id, agents) {
    if (!agents.has(id)) agents.set(id, await api.request("GET", `/api/agents/${id}`));
    return agents.get(id);
  }

  // A wake still waiting in Paperclip's queue (the agent is busy elsewhere, or
  // the issue's previous run still holds execution) means a comment can't help.
  //
  // With { freshWithin }, a queued or claimed wake counts only while it was
  // requested less than that long ago: with nothing running on the issue, one
  // waiting longer isn't starting (a monitor's own wake can sit queued for hours
  // while a new comment starts a run at once). A deferred wake always counts: a
  // comment would be deferred behind the same run, and the handling above is what
  // can move it.
  async function hasPendingWake(issue, runs, agents = new Map(), { freshWithin = null } = {}) {
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
    if (freshWithin != null) return pending.some((e) => e.status === "deferred_issue_execution" || now() - ts(e.requestedAt) < freshWithin);
    return true;
  }

  // Paperclip's "send queued messages now" for a deferred queue of saved comments.
  // `before`, as for nudge, is asked last, just before the retry: false holds it back.
  async function retryDeferred(issue, key = record.retry(issue), { before = null } = {}) {
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
    if (config.dryRun) {
      // A dry run records nothing, so it uses up no retries: logged once per key.
      if (!dryRunSeen.has(key)) {
        dryRunSeen.add(key);
        log("watchdog: would retry the deferred wake (dry run)", { issue: who, queueId: queue.queueId });
      }
      return;
    }
    if (before && !(await before())) return; // not this tick
    records.set(key, { count: count + 1, at: now() });
    state.touch();
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
      // Paperclip refused the release: it was reported then, and is left to you.
      if (records.get(key).failed) return true;
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
    const saved = facts.queue?.entries?.length ?? 0;
    if (config.dryRun) {
      // Recorded only in memory: with dry run off, the release still happens.
      if (!dryRunSeen.has(key)) {
        dryRunSeen.add(key);
        log("watchdog: would release a hold Paperclip can't release by itself (dry run)", { issue: who, sourceRun: hold.runId, saved });
      }
      return true;
    }
    records.set(key, { count: 1, at: now() });
    state.touch();
    let result;
    try {
      result = await releaseHold(api, facts, {
        note:
          "Released by Paperclip Helper's watchdog: the held run stopped without a record Paperclip could verify, " +
          "so Paperclip could never release this hold by itself.",
        signature: `\n\n${WATCHDOG_SIGNATURE}`,
      });
    } catch (err) {
      records.set(key, { count: 1, at: now(), failed: true });
      state.touch();
      log.warn("watchdog: couldn't release a hold Paperclip can't release by itself; left to you", {
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
  async function releaseParkedIssue(issue, action, agents, companyId) {
    const who = issue.identifier ?? issue.id;
    const agent = await agentFor(issue.assigneeAgentId, agents).catch(() => null);
    // Waking an agent Paperclip can't invoke is what parked the issue in the first place.
    if (!agent || asleep(agent)) return;
    // Parked because its review stage's participant couldn't be invoked, and that is
    // another agent: while it is paused, or just resumed and being swept, the resume
    // sweep (15) puts the issue back in review; a nudge to the assignee would only
    // make a newer comment than the notice the sweep looks for.
    if (action.cause === PARTICIPANT_RECOVERY_CAUSE) {
      const full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
      if (!full) return;
      const participantId = reviewParticipantOf(full);
      if (participantId && participantId !== issue.assigneeAgentId) {
        const participant = await agentFor(participantId, agents).catch(() => null);
        if (!participant || asleep(participant) || settling(participantId) || records.has(record.agentResumed(participantId))) return;
      }
    }
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
    const list = Array.isArray(runs) ? runs : [];
    if (list.some((r) => ACTIVE_RUN.has(r.status))) return;
    // DIR-268: the last run hit a provider limit (or what Paperclip took for a transient error) and
    // Paperclip's own retries are spent. A nudge only starts the same failing run again, and its
    // recovery then parks the issue under a new action: 333 runs in 17 hours. Leave it to the board.
    // Only while the failure is recent: once the limit has reset (the agent is resumed the next
    // day, say), the issue gets its nudge as before.
    const last = latestRun(list);
    if (last && last.status === "failed" && PROVIDER_FAILURE.test(String(last.errorCode ?? "")) &&
        now() - ts(last.finishedAt ?? last.createdAt) < PROVIDER_FAILURE_HOLD_MS) {
      const key = record.parkedReported(issue, `provider:${last.runId ?? last.id}`);
      if (records.has(key)) return;
      records.set(key, { count: 1, at: now() });
      state.touch();
      log.warn("watchdog: a parked issue's last run failed on the model provider; not nudging", {
        issue: who,
        agent: agent.name,
        errorCode: last.errorCode,
        hint: "A usage limit or provider outage. Resume or retry the issue once the provider works again.",
      });
      return;
    }
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
      await retryDeferred(issue, record.hold(issue, action.id), { before: () => takeSlot(agent, companyId) });
      return;
    }
    // One nudge budget per issue and assignee, not per recovery action: each failed retry chain
    // makes a new action, and a budget keyed on it never runs out. It starts again after a day.
    const key = record.parked(issue);
    const prior = records.get(key);
    if (prior && now() - prior.at > DAY_MS) records.delete(key);
    await nudge(
      issue,
      key,
      agent,
      `Paperclip's recovery parked this issue for a board decision: it couldn't run you when it looked ` +
        `(you were paused, or the issue had just changed hands). You are available again and nothing else ` +
        `blocks the issue. Please continue it.`,
      { reason: "parked by recovery", kind: action.kind },
      // Paced like the resume sweep: a resume never starts more runs than the agent can take.
      { before: () => takeSlot(agent, companyId) },
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


  // ---------------------------------------------------------------- 1. hand-offs

  // Cancelled by Paperclip at admission, before any work: see stalledHandOff.
  const refused = (run) => run.status === "cancelled" && run.errorCode === "execution_reconciliation_required";
  const neverStarted = (run) => run.status === "cancelled" && run.errorCode === "issue_assignee_changed" && !run.startedAt;

  // A question card's wake to a teammate becomes a run Paperclip cancels before
  // it starts (questions.mjs). It was never the teammate's turn on the issue:
  // counted, it would look like a hand-off and get the asker nudged as the
  // "new owner" while it waits on its card. Only runs of an agent a card on the
  // issue was addressed to are left out; any other never-started run still counts.
  async function cardWakesLeftOut(issue, runs) {
    if (!Array.isArray(runs) || !runs.some(neverStarted)) return runs;
    const cards = await api.request("GET", `/api/issues/${issue.id}/interactions`).catch(() => []);
    const asked = new Map(); // addressee → when it was first asked
    for (const c of Array.isArray(cards) ? cards : []) {
      if (c?.addresseeAgentId && (!asked.has(c.addresseeAgentId) || ts(c.createdAt) < asked.get(c.addresseeAgentId))) {
        asked.set(c.addresseeAgentId, ts(c.createdAt));
      }
    }
    if (!asked.size) return runs;
    return runs.filter((r) => !(neverStarted(r) && asked.has(r.agentId) && ts(r.createdAt) >= asked.get(r.agentId)));
  }

  async function stalledHandOff(issue, agents) {
    const assignee = issue.assigneeAgentId;
    const agent = await agentFor(assignee, agents);
    if (asleep(agent)) return null;

    const runs = await cardWakesLeftOut(issue, await api.request("GET", `/api/issues/${issue.id}/runs`));
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
      `\n\n${WATCHDOG_SIGNATURE}`;
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
  // within the stall window. With `patch`, the comment travels in a PATCH of the
  // issue with those fields, so both happen in one step, and `patchNote` is added
  // to it; if Paperclip refuses the fields, the comment goes alone, without the note.
  // `before`, when given, is asked last, just before sending: false holds the nudge back.
  async function nudge(issue, key, agent, message, logExtra, { patch = null, patchNote = "", before = null } = {}) {
    const prior = records.get(key);
    const count = prior?.count ?? 0;
    if (count >= config.watchdogMaxNudges || (prior && now() - prior.at < stallMs)) return false;
    const who = issue.identifier ?? issue.id;
    if (config.dryRun) {
      // Nothing is recorded, so turning dry run off leaves every nudge still to send.
      if (dryRunSeen.has(key)) return false;
      dryRunSeen.add(key);
      log("watchdog: would nudge (dry run)", { issue: who, agent: agent.name, ...logExtra });
      return false;
    }
    if (before && !(await before())) return false; // not this tick
    records.set(key, { count: count + 1, at: now() });
    state.touch();
    const bodyOf = (text) => `${agentMention(agent)} ${text}\n\n_Paperclip Helper watchdog, nudge ${count + 1}/${config.watchdogMaxNudges}._`;
    let patched = null;
    try {
      if (patch) {
        patched = true;
        await api.request("PATCH", `/api/issues/${issue.id}`, { ...patch, comment: bodyOf(`${message}${patchNote}`) }).catch((err) => {
          if (pausedRefusal(err)) throw err;
          // The comment matters more than the rest: send it on its own.
          patched = false;
          log.warn("watchdog: Paperclip refused the change sent with a nudge; sending the comment alone", { issue: who, error: err.message });
          return api.request("POST", `/api/issues/${issue.id}/comments`, { body: bodyOf(message) });
        });
      } else await api.request("POST", `/api/issues/${issue.id}/comments`, { body: bodyOf(message) });
    } catch (err) {
      if (!pausedRefusal(err)) throw err;
      // Try again a stall window later, without using up a nudge.
      records.set(key, { count, at: now() });
      log.debug("watchdog: the issue is paused; nudge postponed", { issue: who });
      return false;
    }
    stats.nudges += 1;
    log("watchdog: nudged", { issue: who, agent: agent.name, nudge: count + 1, ...logExtra, ...(patch ? { patched } : {}) });
    return true;
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
      // An agent just resumed: nothing is touched until the resume has settled, and
      // then its issues blocked during the pause are 15's to restore.
      (issue) => issue.assigneeAgentId && !issue.executionRunId && !issue.checkoutRunId && !settling(issue.assigneeAgentId) && !resumeSweepHolds(issue),
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
            await releaseParkedIssue(issue, parked.active, agents, companyId);
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
        if (config.watchdogCancelledBlockers && (await cancelledBlockers(issue, diag, agents))) return;
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

  // ---------------------------------------------------------------- 8. dead workspace links

  // Open issues linked (reuse_existing) to a workspace that is archived or gone.
  // List rows carry executionWorkspaceId and executionWorkspacePreference. Each
  // linked workspace is judged from an issue that links to it, the way heartbeat
  // sees it (linkedWorkspace); a live one is looked at again a stall window later.
  async function checkDeadLinks(companyId, agents) {
    const rows = (await listIssues(api, companyId, OPEN_STATUSES)).filter(
      (i) => i.executionWorkspaceId && i.executionWorkspacePreference === "reuse_existing",
    );
    const due = rows.filter((i) => {
      const ws = i.executionWorkspaceId;
      if (records.has(record.deadLink(i, ws)) || records.has(record.deadLinkOwn(i, ws)) || dryRunSeen.has(record.deadLink(i, ws))) return false;
      const failed = records.get(record.deadLinkFail(i, ws));
      return !failed || (failed.count < config.watchdogMaxNudges && now() - failed.at >= stallMs);
    });
    if (!due.length) return;
    const byWorkspace = new Map();
    for (const i of due) byWorkspace.set(i.executionWorkspaceId, [...(byWorkspace.get(i.executionWorkspaceId) ?? []), i]);

    const dead = new Map(); // workspaceId → linkedWorkspace() result
    for (const [wsId, linked] of byWorkspace) {
      const seen = liveWorkspaces.get(wsId);
      if (seen && now() - seen < stallMs) continue;
      const full = await api.request("GET", `/api/issues/${linked[0].id}`).catch(() => null);
      if (!full || full.executionWorkspaceId !== wsId) continue;
      const found = await linkedWorkspace(api, full);
      if (found.known && !found.missing && found.workspace?.status !== "archived") {
        liveWorkspaces.set(wsId, now());
        continue;
      }
      dead.set(wsId, found);
    }
    if (!dead.size) return;

    // Paperclip drops workspace changes while isolated workspaces are off. Say
    // so once a day instead of "clearing" links every minute to no effect.
    if ((await isolatedWorkspacesEnabled(api)) === false) {
      const key = record.deadLinkOff();
      const prior = records.get(key);
      if (!prior || now() - prior.at > DAY_MS) {
        records.set(key, { count: 1, at: now() });
        state.touch();
        log.warn(
          'watchdog: issues are linked to a closed workspace, and every run on them fails at setup. Paperclip ignores workspace changes while Instance settings → Experimental → "Enable Isolated Workspaces" is off: turn it on and the watchdog clears the links',
          { issues: [...dead.keys()].flatMap((id) => byWorkspace.get(id).map((i) => i.identifier ?? i.id)) },
        );
      }
      return;
    }

    for (const [wsId, found] of dead) {
      for (const issue of byWorkspace.get(wsId)) {
        try {
          await clearDeadLink(issue, wsId, found, agents);
        } catch (err) {
          log.warn("watchdog: dead workspace link check failed", { issue: issue.identifier ?? issue.id, error: err.message });
        }
      }
    }
  }

  // The assignee's last run, if it failed restoring this workspace.
  async function failedOnLink(list, assignee, wsId) {
    const last = latestRun(list.filter((r) => r.agentId === assignee && r.status !== "cancelled"));
    if (last?.status !== "failed" || last.errorCode !== "setup_failed") return null;
    const detail = await api.request("GET", `/api/heartbeat-runs/${last.runId ?? last.id}`).catch(() => null);
    return deadLinkWorkspaceId(detail?.error) === wsId ? last : null;
  }

  async function clearDeadLink(row, wsId, found, agents) {
    const who = row.identifier ?? row.id;
    // A run in progress is using whatever it has: change nothing under it.
    if (row.executionRunId || row.checkoutRunId) return;
    const runs = await api.request("GET", `/api/issues/${row.id}/runs`).catch(() => []);
    const list = Array.isArray(runs) ? runs : [];
    if (list.some((r) => ACTIVE_RUN.has(r.status))) return;
    // The row may be a tick old, and has no settings: act on the issue as it is now.
    const full = await api.request("GET", `/api/issues/${row.id}`);
    if (full.executionWorkspaceId !== wsId || full.executionWorkspacePreference !== "reuse_existing") return;
    if (full.status === "done" || full.status === "cancelled") return;
    if (full.executionRunId || full.checkoutRunId) return;
    // A change you scheduled for the next run fixes the link; a new one would cancel it.
    if (full.workspacePendingSelection) return;
    const extra = { issue: who, workspace: wsId, missing: found.missing };

    // Its own workspace, closed (a finished issue reopened): unarchiving it may
    // be the better fix, so that stays your decision.
    if (found.workspace?.sourceIssueId === full.id) {
      records.set(record.deadLinkOwn(row, wsId), { count: 1, at: now() });
      state.touch();
      log.warn("watchdog: an issue is linked to its own closed workspace and every run fails at setup; `pch workspace` gives it a new one", extra);
      return;
    }
    // On a Paperclip whose issues don't carry their workspace, a workspace the
    // key can't read isn't proof it's gone: only a run that failed on it is.
    const assignee = full.assigneeAgentId;
    const failed = assignee ? await failedOnLink(list, assignee, wsId) : null;
    if (!found.known && !failed) return;

    const owner = found.workspace?.sourceIssueId
      ? await api.request("GET", `/api/issues/${found.workspace.sourceIssueId}`).catch(() => null)
      : null;
    const ownerName = owner?.identifier ?? null;
    extra.owner = ownerName;
    if (config.dryRun) {
      dryRunSeen.add(record.deadLink(row, wsId));
      log("watchdog: would clear a link to a closed workspace (dry run)", extra);
      return;
    }
    let result;
    try {
      result = await clearLink(api, full);
    } catch (err) {
      // Tried again a stall window later, up to WATCHDOG_MAX_NUDGES times.
      const key = record.deadLinkFail(row, wsId);
      const count = (records.get(key)?.count ?? 0) + 1;
      records.set(key, { count, at: now() });
      state.touch();
      const giveUp = count >= config.watchdogMaxNudges;
      log.warn(`watchdog: couldn't clear a link to a closed workspace${giveUp ? "; leaving it to you (`pch workspace`)" : ""}`, {
        ...extra,
        attempt: count,
        error: err.message,
      });
      return;
    }
    records.set(record.deadLink(row, wsId), { count: 1, at: now() });
    state.touch();
    if (!result.ok) {
      log.warn("watchdog: Paperclip kept the link to a closed workspace; `pch workspace` says why", extra);
      return;
    }
    stats.deadLinks += 1;
    log("watchdog: cleared a link to a closed workspace; the next run gets a new isolated one", extra);

    // Restart the assignee only when its last run failed on this link: nothing
    // retries a setup failure. Anything else starts as it would have. A blocked
    // issue, or one in review, waits for your decision.
    if (!failed || !RESTARTABLE.has(full.status)) return;
    const agent = await agentFor(assignee, agents).catch(() => null);
    if (!agent || asleep(agent)) return;
    await nudge(
      full,
      record.deadLinkNudge(row, wsId),
      agent,
      `this issue was linked to ${ownerName ? `${ownerName}'s workspace` : "a workspace"}, which is closed, so Paperclip failed ` +
        `every run at setup. The watchdog cleared the link: your next run gets a new isolated workspace. Please continue this issue.`,
      { reason: "closed workspace link", workspace: wsId },
    );
  }

  // ---------------------------------------------------------------- 9. scheduled workspaces

  // List rows don't carry workspacePendingSelection, so only quiet todo issues
  // touched in the last day are read in full: that is where an agent leaves one.
  async function checkScheduledWorkspaces(companyId, agents) {
    const issues = (await listIssues(api, companyId, "todo")).filter(
      (i) => candidate(i) && now() - ts(i.updatedAt) < DAY_MS,
    );
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      try {
        const full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
        if (!full?.workspacePendingSelection || full.status !== "todo" || !full.assigneeAgentId) return;
        const agent = await agentFor(full.assigneeAgentId, agents).catch(() => null);
        if (!agent || asleep(agent)) return;
        const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
        if ((Array.isArray(runs) ? runs : []).some((r) => ACTIVE_RUN.has(r.status))) return;
        if (await hasPendingWake(full, runs, agents)) return;
        await nudge(
          full,
          record.scheduledWorkspace(full),
          agent,
          "the workspace you scheduled for this issue applies from this run: you are on a new branch of your own. Please continue this issue.",
          { reason: "scheduled workspace" },
        );
      } catch (err) {
        log.warn("watchdog: scheduled workspace check failed", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
  }

  // ---------------------------------------------------------------- 10. stranded question cards

  // Every open issue's cards, once per stall window per company: a card that
  // waits less than that isn't routed anyway, and each issue costs a request.
  async function checkQuestions(companyId, agents) {
    const last = questionScanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    questionScanAt.set(companyId, now());
    const issues = await listIssues(api, companyId, QUESTION_STATUSES);
    const pending = new Map(); // card id → { card, issue }
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      try {
        for (const card of await pendingCards(api, issue.id)) pending.set(card.id, { card, issue });
      } catch (err) {
        log.debug("watchdog: couldn't read an issue's cards", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
    await settleRoutedCards(companyId, pending);
    for (const { card, issue } of pending.values()) {
      const key = record.question(card);
      if (records.has(key) || dryRunSeen.has(key)) continue;
      if (!strandedCard(card, issue) || now() - ts(card.createdAt) < stallMs) continue;
      try {
        await routeCard(companyId, card, issue, agents);
      } catch (err) {
        log.warn("watchdog: routing a question card failed", { issue: issue.identifier ?? issue.id, card: card.id, error: err.message });
      }
    }
  }

  async function routeCard(companyId, card, issue, agents) {
    const who = issue.identifier ?? issue.id;
    const addressee = await agentFor(card.addresseeAgentId, agents).catch(() => null);
    // A paused agent can't answer either way; it's routed once it's back.
    if (!addressee || asleep(addressee)) return;
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
    if (addresseeReached(card, runs)) return;
    const asker = card.createdByAgentId ? await agentFor(card.createdByAgentId, agents).catch(() => null) : null;
    const key = record.question(card);
    const { title, description } = relayIssue({ card, source: issue, askerName: asker?.name, addresseeName: addressee.name });
    const logExtra = { issue: who, card: card.id, addressee: addressee.name, asked: card.createdAt, question: cardText(card, 120) };
    if (config.dryRun) {
      dryRunSeen.add(key);
      log("watchdog: would route a question card to its addressee (dry run)", logExtra);
      return;
    }
    const body = { title, description, assigneeAgentId: addressee.id, status: "todo" };
    if (issue.projectId) body.projectId = issue.projectId;
    if (issue.priority) body.priority = issue.priority;
    const base = { count: 1, companyId, sourceId: issue.id, source: who, relayId: null, relay: null };
    // Recorded before the request: if Paperclip created the issue but the answer
    // was lost, a second scan must not create another one.
    records.set(key, { ...base, at: now() });
    state.touch();
    let created;
    try {
      created = await api.request("POST", `/api/companies/${companyId}/issues`, body);
    } catch (err) {
      // Certainly not created: try again next scan. Otherwise it may exist, so leave it to you.
      if (err.neverSent || (err.status >= 400 && err.status < 500)) records.delete(key);
      else log.warn("watchdog: creating a question card's issue may have failed; not retried", { ...logExtra, error: err.message });
      state.touch();
      throw err;
    }
    records.set(key, { ...base, at: now(), relayId: created?.id ?? null, relay: created?.identifier ?? null });
    state.touch();
    stats.questions += 1;
    log("watchdog: routed a question card to its addressee", { ...logExtra, relay: created?.identifier ?? created?.id });
  }

  // Is the card still pending? Read from its own issue, so a scan that missed
  // the issue (a failed read, or an issue moved to backlog) can't settle it.
  // null when Paperclip can't tell.
  async function cardStillPending(sourceId, cardId) {
    try {
      return (await pendingCards(api, sourceId)).some((c) => c.id === cardId);
    } catch {
      return null;
    }
  }

  // Close the issues that routed a card once the card is no longer pending.
  // A routed issue closed while its card still waits is left alone: the
  // addressee decided not to answer (or left it to the board), logged once.
  async function settleRoutedCards(companyId, pending) {
    for (const [key, r] of records.entries()) {
      if (!key.startsWith("question:") || r?.companyId !== companyId || !r.relayId || r.settled) continue;
      const cardId = key.slice("question:".length);
      const waiting = pending.has(cardId) || (r.sourceId ? await cardStillPending(r.sourceId, cardId) : true);
      if (waiting === null) continue;
      const relay = await api.request("GET", `/api/issues/${r.relayId}`).catch((err) => (err.status === 404 ? { gone: true } : null));
      if (!relay) continue;
      const closed = relay.gone || relay.status === "done" || relay.status === "cancelled";
      if (waiting) {
        if (closed && !r.leftOpen) {
          records.set(key, { ...r, leftOpen: true, at: now() });
          state.touch();
          log("watchdog: the addressee closed its question issue without answering the card; left to you", {
            issue: r.source,
            relay: r.relay,
            card: cardId,
          });
        }
        continue;
      }
      if (closed) {
        records.set(key, { ...r, settled: true, at: now() });
        state.touch();
        continue;
      }
      // The agent may be finishing up on it: let that run end first.
      if (relay.executionRunId || relay.checkoutRunId) continue;
      if (config.dryRun) {
        log("watchdog: would close a question issue whose card is settled (dry run)", { issue: r.source, relay: r.relay });
        continue;
      }
      try {
        await api.request("PATCH", `/api/issues/${r.relayId}`, {
          status: "done",
          comment: `The card on ${r.source} is no longer waiting (answered, withdrawn or expired), so this issue is closed.\n\n${WATCHDOG_SIGNATURE}`,
        });
      } catch (err) {
        if (!pausedRefusal(err)) throw err;
        continue;
      }
      records.set(key, { ...r, settled: true, at: now() });
      state.touch();
      log("watchdog: closed a question issue whose card is settled", { issue: r.source, relay: r.relay });
    }
  }

  // ---------------------------------------------------------------- 14. cancelled blockers

  // True when the issue is blocked by a cancelled issue (whether or not a nudge
  // went out now), so the blockers-done check doesn't look at it.
  async function cancelledBlockers(issue, diag, agents) {
    const blockers = Array.isArray(diag?.blockers) ? diag.blockers : [];
    const cancelled = blockers.filter((b) => b?.status === "cancelled");
    if (!cancelled.length) return false;
    const names = cancelled.map((b) => b.identifier ?? b.id);
    const key = record.cancelledBlocker(issue, [...names].sort());
    // Once: the agent decides, and an issue it keeps blocked on purpose isn't nagged.
    if ((records.get(key)?.count ?? 0) > 0 || dryRunSeen.has(key)) return true;
    const agent = await agentFor(issue.assigneeAgentId, agents).catch(() => null);
    if (!agent || asleep(agent)) return true;
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
    if ((Array.isArray(runs) ? runs : []).some((r) => ACTIVE_RUN.has(r.status))) return true;
    if (await hasPendingWake(issue, runs, agents)) return true;
    const why = [];
    for (const b of cancelled.slice(0, 3)) {
      const comments = await api.request("GET", `/api/issues/${b.id}/comments?order=desc&limit=1`).catch(() => []);
      const last = Array.isArray(comments) ? comments[0] : null;
      why.push(last?.body ? `${b.identifier ?? b.id}'s last comment:\n\n${quote(last.body)}` : `${b.identifier ?? b.id} has no comment saying why.`);
    }
    const list = names.join(", ");
    const one = names.length === 1;
    await nudge(
      issue,
      key,
      agent,
      `this issue is blocked by ${list}, which ${one ? "was" : "were"} cancelled. Paperclip never counts a cancelled blocker ` +
        `as resolved, so this issue stays blocked until its "Blocked by" changes, and nothing else will wake you for it.\n\n` +
        `${why.join("\n\n")}\n\n` +
        `Please decide. If that work landed elsewhere or isn't needed any more, remove ${list} from this issue's "Blocked by" ` +
        `(add whatever replaced ${one ? "it" : "them"}, if anything) and continue. If this issue still needs it, say so in a comment ` +
        `and ask for a replacement blocker.`,
      { reason: "cancelled blocker", blockers: list },
    );
    return true;
  }

  // ---------------------------------------------------------------- 11. CI runs agents wait on

  // The issue's runs, without those Paperclip cancelled before they started.
  const startedRuns = (runs) => (Array.isArray(runs) ? runs : []).filter((r) => !refused(r) && !neverStarted(r));

  const ciRunsCheck = createCiRunsCheck({ ctx, records, state, stats, dryRunSeen, record, github, agentFor, nudge, hasPendingWake, candidate, startedRuns });

  // ---------------------------------------------------------------- 12, 13. issues waiting on your review

  const boardHeld = createBoardHeldCheck({ ctx, records, state, stats, dryRunSeen, record, agentFor, quiet, startedRuns });

  // ---------------------------------------------------------------- 15. issues blocked during a pause

  // An agent missing from the company's list: gone for good only when Paperclip says
  // so (404, or terminated, which the list leaves out). Unknown otherwise.
  async function agentGone(agentId) {
    try {
      const agent = await api.request("GET", `/api/agents/${agentId}`);
      return agent?.status === "terminated" ? true : agent ?? null;
    } catch (err) {
      return err.status === 404 ? true : null;
    }
  }

  // Records each agent's pause and resume, and returns the agents of this company
  // resumed since (this tick or before, while their issues are still being restored).
  // Kept in the state file, so a resume while the helper was down is still seen.
  async function trackPauses(companyId, agents, tickAt) {
    const resumed = [];
    for (const [key, r] of records.entries()) {
      if (r?.companyId !== companyId) continue;
      const paused = key.startsWith("agent-paused:");
      if (!paused && !key.startsWith("agent-resumed:")) continue;
      const agentId = key.slice(key.indexOf(":") + 1);
      let agent = agents.get(agentId);
      if (!agent) {
        const gone = await agentGone(agentId);
        if (gone === true) {
          records.delete(key); // terminated or deleted: nothing to restore
          sweepHeld.delete(agentId);
          state.touch();
        }
        if (!gone || gone === true) continue; // can't tell: look again next tick
        agent = gone;
      }
      if (agent.status === "terminated") {
        records.delete(key);
        sweepHeld.delete(agentId);
        state.touch();
        continue;
      }
      if (agent.status === "paused") {
        if (!paused) {
          // Paused again before its issues were all restored: the next resume covers both pauses.
          records.delete(key);
          sweepHeld.delete(agentId);
          records.set(record.agentPaused(agentId), { count: 1, at: now(), since: r.since, companyId });
          state.touch();
        } else if (now() - (r.at ?? 0) > RECORD_REFRESH_MS) {
          records.set(key, { ...r, at: now() }); // the state file forgets records untouched for a week
          state.touch();
        }
        continue;
      }
      if (paused) {
        if (asleep(agent)) continue; // awaiting approval: not invokable yet
        records.delete(key);
        const entry = { count: 0, at: now(), since: r.since, resumedAt: tickAt, companyId };
        records.set(record.agentResumed(agentId), entry);
        state.touch();
        log("watchdog: an agent was resumed; its issues Paperclip's recovery blocked during the pause are looked at once the resume has settled", {
          agent: agent.name,
          pausedSince: r.since ? new Date(r.since).toISOString() : "unknown",
          settleMin: config.watchdogResumeSettleMin,
        });
        resumed.push({ agent, entry });
        continue;
      }
      if (asleep(agent)) continue; // awaiting approval: its issues wait
      if (now() - (r.resumedAt ?? 0) > RESUME_SWEEP_MS) {
        records.delete(key);
        records.set(record.agentSwept(agentId), { count: 1, at: now(), resumedAt: r.resumedAt });
        sweepHeld.delete(agentId);
        state.touch();
        continue;
      }
      resumed.push({ agent, entry: r });
    }
    // The first listing of this company since the helper started: an agent seen
    // paused now may have been paused long before, and one may have been resumed
    // between the restart and this tick. Paperclip's activity log says when.
    const startup = !startupRead.has(companyId);
    const activity = startup ? await agentActivity(companyId) : null;
    if (startup) startupRead.add(companyId);
    // Agents seen paused for the first time. Paperclip's pausedAt says when. Without
    // it: in a running helper, no earlier than its previous tick that saw the agent
    // unpaused (a block from before then isn't the pause's); at start-up, the agent's
    // latest "agent.paused" activity, or unknown when there is none (it was paused
    // before the helper could see it, so any not-invokable notice counts).
    for (const agent of agents.values()) {
      if (agent.status !== "paused") continue;
      if (records.has(record.agentPaused(agent.id)) || records.has(record.agentResumed(agent.id))) continue;
      const known = seenStatus.has(agent.id) && seenStatus.get(agent.id) !== "paused" && previousTickAt != null;
      const since = ts(agent.pausedAt) || (known ? previousTickAt : startup ? activity?.get(agent.id)?.pausedAt || UNKNOWN_SINCE : tickAt);
      records.set(record.agentPaused(agent.id), { count: 1, at: now(), since, companyId });
      state.touch();
      if (startup) log.debug("watchdog: an agent was already paused when the helper started; its resume will be swept", { agent: agent.name, pausedSince: since ? new Date(since).toISOString() : "unknown" });
    }
    // Resumed while the helper was starting (or down), with no pause on record: the
    // activity log's latest resume after its latest pause, within a sweep's lifetime,
    // and not one a sweep already covered.
    if (activity) {
      for (const agent of agents.values()) {
        if (asleep(agent) || records.has(record.agentPaused(agent.id)) || records.has(record.agentResumed(agent.id))) continue;
        const a = activity.get(agent.id);
        if (!a?.resumedAt || !a.pausedAt || a.resumedAt < a.pausedAt || now() - a.resumedAt > RESUME_SWEEP_MS) continue;
        if (a.resumedAt <= (records.get(record.agentSwept(agent.id))?.resumedAt ?? 0) + CLOCK_SLACK_MS) continue;
        const entry = { count: 0, at: now(), since: a.pausedAt, resumedAt: a.resumedAt, companyId };
        records.set(record.agentResumed(agent.id), entry);
        state.touch();
        log("watchdog: an agent was resumed while the helper was starting; its issues Paperclip's recovery blocked during the pause are looked at once the resume has settled", {
          agent: agent.name, pausedSince: new Date(a.pausedAt).toISOString(), resumedAt: new Date(a.resumedAt).toISOString(), settleMin: config.watchdogResumeSettleMin,
        });
        resumed.push({ agent, entry });
      }
    }
    for (const agent of agents.values()) seenStatus.set(agent.id, agent.status);
    return resumed;
  }

  // Each agent's latest pause and resume in Paperclip's activity log ("agent.paused",
  // "agent.resumed", newest first): Map agentId → { pausedAt, resumedAt }, or null
  // when Paperclip doesn't answer.
  async function agentActivity(companyId) {
    const rows = await api.request("GET", `/api/companies/${companyId}/activity?entityType=agent&limit=${STARTUP_ACTIVITY_LIMIT}`).catch(() => null);
    if (!Array.isArray(rows)) return null;
    const out = new Map();
    for (const row of rows) {
      const field = row?.action === "agent.paused" ? "pausedAt" : row?.action === "agent.resumed" ? "resumedAt" : null;
      const at = ts(row?.createdAt);
      if (!field || !at || !row.entityId) continue;
      const entry = out.get(row.entityId) ?? {};
      entry[field] = Math.max(entry[field] ?? 0, at);
      out.set(row.entityId, entry);
    }
    return out;
  }

  // Is this issue waiting for a sweep under way (to be restored on a later tick, or
  // postponed)? Then 6 leaves it to the sweep. Issues the sweep turned down aren't held.
  // Any agent's sweep: a review participant's issue may be assigned to someone else.
  const resumeSweepHolds = (issue) => config.watchdogResumeSweep && [...sweepHeld.values()].some((held) => held.has(issue.id));

  // Resumed less than WATCHDOG_RESUME_SETTLE_MIN ago: neither the sweep nor 6 touches
  // the agent's blocked issues yet. A pause within the window ends the sweep before
  // anything was restored (trackPauses), and the next resume covers both pauses.
  const settleMs = config.watchdogResumeSettleMin * 60_000;
  function settling(agentId) {
    if (!settleMs) return false;
    const r = records.get(record.agentResumed(agentId));
    return Boolean(r && now() - (r.resumedAt ?? 0) < settleMs);
  }

  // Runs an agent may still be given this tick, shared by the resume sweep and 6: its
  // limit (WATCHDOG_RESUME_SWEEP_LIMIT, or its maxConcurrentRuns) less the runs it
  // has queued or going on any issue: those of issues restored earlier, and the wakes
  // Paperclip released on the resume. Unknown counts as full: better a tick later
  // than too many runs at once.
  function startSlots() {
    slots = new Map();
  }
  async function freeSlots(agent, companyId) {
    const limit = config.watchdogResumeSweepLimit || concurrencyOf(agent);
    const runs = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`).catch(() => null);
    if (!Array.isArray(runs)) return { left: 0 };
    const live = runs.filter((r) => r.agentId === agent.id && ACTIVE_RUN.has(r.status)).length;
    return { left: Math.max(0, limit - live) };
  }
  async function takeSlot(agent, companyId) {
    if (!slots.has(agent.id)) slots.set(agent.id, freeSlots(agent, companyId));
    const s = await slots.get(agent.id);
    if (s.left <= 0) return false;
    s.left -= 1;
    return true;
  }

  // Tracks pauses and resumes (for the settle window, even with the sweep off), then sweeps.
  async function checkResumes(companyId, agents, tickAt) {
    const tracked = await trackPauses(companyId, agents, tickAt);
    if (!config.watchdogResumeSweep) return;
    const resumed = tracked.filter(({ agent }) => !settling(agent.id));
    if (!resumed.length) return;
    const blocked = (await listIssues(api, companyId, "blocked")).sort(sweepOrder);
    const fullIssues = new Map(); // issueId → its full read, shared by the agents swept this tick
    for (const { agent, entry } of resumed) {
      try {
        // Its own issues, and any other blocked issue touched since the pause began:
        // its review stage may wait on this agent (list rows carry no executionState).
        const mine = blocked.filter((i) => i.assigneeAgentId === agent.id || !i.updatedAt || ts(i.updatedAt) >= entry.since - CLOCK_SLACK_MS);
        await sweepAgent(agent, entry, mine, companyId, fullIssues);
      } catch (err) {
        log.warn("watchdog: resume sweep failed", { agent: agent.name, error: err.message });
      }
    }
  }

  // Each tick: every one of the agent's blocked issues is looked at, and as many
  // restored as the agent has free slots (takeSlot), so a resume never puts more than
  // its limit of runs in flight. The sweep ends at the first tick with nothing left to
  // restore and nothing postponed.
  async function sweepAgent(agent, entry, issues, companyId, fullIssues = new Map()) {
    const held = new Set();
    const restoredNow = [];
    let full = false;
    for (const issue of issues) {
      const verdict = await pauseBlocked(issue, agent, entry, fullIssues);
      if (verdict === "postponed") {
        held.add(issue.id);
        continue;
      }
      if (!verdict) continue;
      // Paused again since the tick began: the next resume restores it.
      if (full || !(await stillResumed(agent))) {
        held.add(issue.id);
        continue;
      }
      if (!config.dryRun && !(await takeSlot(agent, companyId))) {
        full = true;
        held.add(issue.id); // a later tick
        continue;
      }
      const result = await restoreIssue(issue, agent, verdict);
      if (result === "restored") restoredNow.push(issue.id);
      else if (result === "postponed") held.add(issue.id);
    }
    const key = record.agentResumed(agent.id);
    if (held.size) sweepHeld.set(agent.id, held);
    else sweepHeld.delete(agent.id);
    // In a dry run nothing changed, so nothing is used up: the sweep stays for the real run (until it expires).
    if (!held.size && !config.dryRun) {
      records.delete(key);
      records.set(record.agentSwept(agent.id), { count: 1, at: now(), resumedAt: entry.resumedAt });
      log.debug("watchdog: resume sweep finished", { agent: agent.name, restored: (entry.count ?? 0) + restoredNow.length });
    } else {
      records.set(key, { ...entry, count: (entry.count ?? 0) + restoredNow.length, at: now() });
    }
    state.touch();
  }

  // The agent as Paperclip has it now, just before a restore: paused or not runnable
  // again since the tick's list, nothing is restored (it would only be blocked again).
  async function stillResumed(agent) {
    const fresh = await api.request("GET", `/api/agents/${agent.id}`).catch(() => null);
    return Boolean(fresh) && !asleep(fresh);
  }

  // Is this an issue Paperclip's recovery blocked because the agent was paused, and
  // that nobody has touched since? The agent is either its assignee, or the
  // participant its pending review stage waits on. { latest, target, participant }
  // if so, "postponed" when Paperclip couldn't say right now, else false.
  async function pauseBlocked(row, agent, entry, fullIssues = new Map()) {
    if (row.status !== "blocked" || row.executionRunId || row.checkoutRunId) return false;
    if (!fullIssues.has(row.id)) fullIssues.set(row.id, await api.request("GET", `/api/issues/${row.id}`).catch(() => null));
    const full = fullIssues.get(row.id);
    if (!full) {
      fullIssues.delete(row.id); // read again next tick
      return "postponed";
    }
    if (full.status !== "blocked") return false;
    const asAssignee = full.assigneeAgentId === agent.id;
    const asParticipant = reviewParticipantOf(full) === agent.id;
    if (!asAssignee && !asParticipant) return false;
    // Blocked by another issue: that is why it is blocked, not the pause.
    if (holdingBlockers(full).length) return false;
    // The newest comment must be the recovery notice: anything after it (a person,
    // the agent, the watchdog) means someone has acted on the issue since.
    const comments = await api.request("GET", `/api/issues/${row.id}/comments?order=desc&limit=1`).catch(() => null);
    if (!Array.isArray(comments)) return "postponed";
    const latest = comments[0];
    const notice = recoveryNotice(latest);
    if (!notice) return false;
    // The notice names who couldn't be invoked: the assignee, or the review's participant.
    const participant = notice.kind === "participant";
    if (participant ? !asParticipant : !asAssignee) return false;
    const key = record.resumeRestore(full, latest.id);
    if (records.has(key) || dryRunSeen.has(key)) return false;
    // Posted while the agent was paused; one from before the pause was a real failure.
    const at = ts(latest.createdAt);
    if (!at || at < entry.since - CLOCK_SLACK_MS || at > entry.resumedAt + CLOCK_SLACK_MS) return false;
    if (statusChangedSince(full, at)) return false;
    let actions = null;
    try {
      actions = await api.request("GET", `/api/issues/${row.id}/recovery-actions`);
    } catch (err) {
      if (err.status !== 404) return "postponed"; // not knowing the action's cause, wait rather than guess
    }
    const list = [...(actions?.active ? [actions.active] : []), ...(Array.isArray(actions?.actions) ? actions.actions : [])];
    const action = (notice.actionId ? list.find((a) => a?.id === notice.actionId) : actions?.active) ?? null;
    const kind = participant ? participantRecoveryAction(action) : pauseRecoveryAction(action);
    // An action of another cause (a lost process, a failed workspace) isn't the pause.
    if (kind === false) return false;
    // Without the action, other recovery families post the same Recovery section:
    // only the "not invokable" notice, or a run the pause cancelled, is the pause's.
    if (kind === null && !notice.notInvokable) return false;
    const runs = await api.request("GET", `/api/issues/${row.id}/runs`).catch(() => null);
    if (!Array.isArray(runs)) return "postponed";
    if (runs.some((r) => ACTIVE_RUN.has(r.status))) return false;
    // A review whose participant couldn't be woken goes back to review: Paperclip
    // re-pends the stage with its participant and wakes it.
    if (participant) return { latest, participant, target: { status: "in_review", from: "review stage" } };
    return { latest, target: restoreStatus(full, action) };
  }

  // "restored" (or, in a dry run, would have been), "postponed" (try again next
  // tick), or false (refused: left to you).
  async function restoreIssue(row, agent, { latest, target, participant = false }) {
    const who = row.identifier ?? row.id;
    const key = record.resumeRestore(row, latest.id);
    const extra = { issue: who, agent: agent.name, status: target.status, from: target.from, ...(participant ? { role: "review participant" } : {}) };
    if (config.dryRun) {
      dryRunSeen.add(key);
      log("watchdog: would restore an issue blocked while its agent was paused (dry run)", extra);
      return "restored";
    }
    const comment = participant
      ? `${agentMention(agent)} was resumed: back to review, so the pending review stage goes on (the recovery block came from the pause).` +
        `\n\n${WATCHDOG_SIGNATURE}`
      : `${agentMention(agent)} was resumed: retrying the original owner (the recovery block came from the pause).` +
        `\n\n${WATCHDOG_SIGNATURE}`;
    try {
      // Status and comment in one request: a board user's comment wakes the assignee,
      // and so does the move out of blocked.
      await api.request("PATCH", `/api/issues/${row.id}`, { status: target.status, comment });
    } catch (err) {
      if (pausedRefusal(err)) {
        log.debug("watchdog: the issue is paused; restore postponed", { issue: who });
        return "postponed";
      }
      records.set(key, { count: 1, at: now(), failed: true });
      state.touch();
      log.warn("watchdog: Paperclip refused to restore an issue blocked while its agent was paused; left to you", { ...extra, error: err.message });
      return false;
    }
    records.set(key, { count: 1, at: now() });
    state.touch();
    stats.resumed += 1;
    log("watchdog: restored an issue Paperclip's recovery blocked while its agent was paused", extra);
    return "restored";
  }

  async function tick() {
    const started = now();
    let failure = null;
    // One check failing (a listing Paperclip refused, say) skips only that check for
    // that company: the others still run, and the tick says what failed.
    const run = async (name, companyId, fn) => {
      try {
        await fn();
      } catch (err) {
        failure ??= `${name}: ${err.message}`;
        log.warn("watchdog: a check failed this tick", { check: name, company: companyId, error: err.message });
      }
    };
    try {
      const { companyIds = [] } = await ctx.identity();
      startSlots();
      for (const companyId of companyIds) {
        let listed = true;
        const list = await companyAgents(api, companyId).catch(() => {
          listed = false;
          return [];
        });
        const agents = new Map(list.map((a) => [a.id, a]));
        // Without the agents' statuses a pause or resume can't be told: wait for the next tick.
        // Pauses for a usage limit first, then resumes, which the resume sweep then sees.
        if (config.watchdogLimitPause && listed) await run("usage limits", companyId, () => limits.check(companyId, agents));
        if ((config.watchdogResumeSweep || config.watchdogResumeSettleMin) && listed) {
          await run("resume sweep", companyId, () => checkResumes(companyId, agents, started));
        }
        if (config.watchdogClearDeadLinks) {
          await run("dead links", companyId, () => checkDeadLinks(companyId, agents));
          await run("scheduled workspaces", companyId, () => checkScheduledWorkspaces(companyId, agents));
        }
        await run("blocked issues", companyId, () => checkBlocked(companyId, agents));
        await run("hand-offs", companyId, () => checkHandOffs(companyId, agents));
        if (config.watchdogRouteQuestions) await run("question cards", companyId, () => checkQuestions(companyId, agents));
        await run("waiting on you", companyId, () => boardHeld.check(companyId, agents));
        if (config.watchdogCiRuns) await run("CI runs", companyId, () => ciRunsCheck.check(companyId, agents));
        if (config.watchdogStagesWipe) await run("review stages", companyId, () => stagesCheck.check(companyId, agents));
      }
      stats.lastError = failure;
    } catch (err) {
      stats.lastError = err.message;
      throw err;
    } finally {
      previousTickAt = started;
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
        clearDeadLinks: config.watchdogClearDeadLinks,
        routeQuestions: config.watchdogRouteQuestions,
        ciRuns: config.watchdogCiRuns ? (github ? true : "off: no GitHub token (GITHUB_TOKEN or GITHUB_TOKEN_FILE)") : false,
        ciRerunJobs: config.watchdogCiRerunJobs || null,
        deliverAnswers: config.watchdogDeliverAnswers,
        returnEscalatedReviews: config.watchdogReturnEscalatedReviews,
        cancelledBlockers: config.watchdogCancelledBlockers,
        limitPause: config.watchdogLimitPause
          ? { adapters: [...RECOGNISERS.keys()], graceMin: config.watchdogLimitResumeGraceMin, codexTimeZone: config.watchdogLimitTimeZone || localZone(), notifyIssue: config.watchdogNotifyIssue || null }
          : false,
        stagesWipe: config.watchdogStagesWipe ? (github ? true : "on, without the open-PR part: no GitHub token") : false,
        resumeSweep: config.watchdogResumeSweep,
        // Runs at once per agent, for the sweep's restores and 6's nudges.
        runsPerAgent: config.watchdogResumeSweepLimit || "the agent's maxConcurrentRuns",
        resumeSettleMin: config.watchdogResumeSettleMin,
      });
      loop = every("watchdog", config.watchdogIntervalSec, 5_000, tick, log);
    },
    async stop() {
      await loop?.stop();
    },
  };
}
