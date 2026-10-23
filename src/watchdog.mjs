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
//    6 leaves alone the issues a sweep under way is still to restore.
//
// 16. Claude usage limits (limits.mjs). When an account hits its 5-hour, weekly or
//    spend limit, every Claude agent on it fails its next run and Paperclip keeps
//    retrying them. With WATCHDOG_LIMIT_PAUSE on, a Claude agent's run that failed
//    with the limit wording pauses every agent on the same account (the secret its
//    ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN comes from, or the machine's own
//    login), each once it has no run queued or going: pausing mid-run cancels the run. The board is told
//    once (the log, and WATCHDOG_NOTIFY_ISSUE). At the reset the message gives
//    (an hour later when it gives none), plus WATCHDOG_LIMIT_RESUME_GRACE_MIN, it
//    resumes exactly the agents it paused, never one a person paused, and 15
//    restores their issues. Codex agents' quota failures are left to Paperclip.
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
import { agentMention, approvalWaitingOn, asleep, every, mapLimit, ts } from "./util.mjs";
import { holdFacts, releaseHold, releaseProblems, unprovable } from "./release.mjs";
import { clearLink, deadLinkWorkspaceId, isolatedWorkspacesEnabled, linkedWorkspace } from "./workspace.mjs";
import { addresseeReached, cardText, pendingCards, QUESTION_STATUSES, relayIssue, strandedCard } from "./questions.mjs";
import { createGitHub } from "./github.mjs";
import { ciMessage, failedJobs, monitorPending, onlyFlaky, runRefs, UNINFORMATIVE, waitingOn } from "./ci-runs.mjs";
import { answeredCards, answerText, escalatedReview, quote, reviewStage } from "./board-held.mjs";
import { createLimitCheck } from "./limits.mjs";
import { createStagesCheck } from "./stages.mjs";
import { findIdentifiers } from "./identifiers.mjs";
import { concurrencyOf, holdingBlockers, pauseRecoveryAction, recoveryNotice, restoreStatus, statusChangedSince, sweepOrder } from "./resume.mjs";

const WATCHED_STATUSES = "todo,in_progress,in_review";
const OPEN_STATUSES = "backlog,todo,in_progress,in_review,blocked";
// Statuses where a comment restarts the assignee without overriding a decision:
// a blocked issue may be blocked for a reason, and one in review waits on a reviewer.
const RESTARTABLE = new Set(["todo", "in_progress"]);
const ACTIVE_RUN = new Set(["queued", "scheduled_retry", "running"]);
const PENDING_WAKE = new Set(["queued", "claimed", "deferred_issue_execution"]);
const CONCURRENCY = 4;
// A run that failed on the model provider: a usage limit, or the transient family Paperclip files
// some limits under (it took Claude's "You've hit your org's monthly spend limit" for transient).
const PROVIDER_FAILURE = /^(provider_quota|[a-z]+_transient_upstream|transient_upstream)$/;
const PROVIDER_FAILURE_HOLD_MS = 6 * 60 * 60_000;
const PARKED_BUDGET_RESET_MS = 24 * 60 * 60_000;
// A long-lived record is touched this often, so the state file (which forgets records
// untouched for a week) keeps it.
const RECORD_REFRESH_MS = 24 * 60 * 60_000;
const latestRun = (runs) =>
  runs.reduce((a, r) => (!a || ts(r.finishedAt ?? r.createdAt) > ts(a.finishedAt ?? a.createdAt) ? r : a), null);
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
  resumeRestore: (issue, commentId) => `resume-restore:${issue.id}:${commentId ?? "?"}`, // the one restore of an issue after a pause's recovery block
};

// Issues the CI-run check reads: an agent that waits on CI leaves its issue in
// any of these. Only those touched in the last few days: an older wait is stale.
const CI_STATUSES = "todo,in_progress,in_review,blocked";
const CI_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_BRANCH_TTL_MS = 60 * 60_000; // a renamed default branch is picked up within the hour
// Issues waiting on your review (12, 13) are looked at once per stall window.
const BOARD_STATUSES = "in_review";
// How long after you answer an agent's card the watchdog waits before returning
// the issue: time for you to approve it, or send it back yourself.
const ANSWER_WAIT_MS = 30 * 60_000;
// 15. A resumed agent's issues are looked for for at most this long after the resume.
const RESUME_SWEEP_MS = 24 * 60 * 60_000;
// Clock slack between the helper and Paperclip when comparing a comment's time with a pause.
const CLOCK_SLACK_MS = 5_000;
// Restored issues a resume sweep remembers, to count their runs still in flight (more than any limit).
const MAX_REMEMBERED_RESTORES = 50;

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
  const ciScanAt = new Map(); // companyId → when the CI runs agents wait on were last looked at
  const boardScanAt = new Map(); // companyId → when issues waiting on your review were last looked at
  const ciTexts = new Map(); // issueId → { companyId, updatedAt, refs } (the issue's updatedAt moves with every comment)
  const ciRuns = new Map(); // "repo#id" → finished run (with jobs), for one scan: a run can be re-run at any time
  const ciRepoOf = new Map(); // bare run id → the repository it was found in
  const ciMissing = new Set(); // "repo#id" (repo "*" for a bare id) found in none of GITHUB_REPOS
  const ciDefaultBranch = new Map(); // repo → { branch, at }: its default branch as GitHub last said
  const ciRepoWarned = new Set(); // repos whose default branch GitHub didn't give, warned once until it does
  const ciSilenced = new Map(); // CI record key → { companyId, reasons }: why a finished run isn't reported, as logged
  const ciRefused = new Set(); // repos whose runs the GitHub token may not read, warned once until it can
  const seenStatus = new Map(); // agentId → its status at this process's previous tick
  let previousTickAt = null; // when this process's previous tick started
  const sweepHeld = new Map(); // agentId → ids of its issues a resume sweep will restore on a later tick
  const hasGitHubToken = Boolean(config.githubToken || config.githubTokenFile);
  const github = deps.github ?? (hasGitHubToken ? createGitHub({ config, log }) : null);
  const stagesCheck = createStagesCheck({ ctx, records, state, stats, dryRunSeen, github, identifiersOf: (pr) => findIdentifiers(pr, ctx.prefixes()) });
  const rerunPattern = (() => {
    if (!config.watchdogCiRerunJobs) return null;
    try {
      return new RegExp(config.watchdogCiRerunJobs, "i");
    } catch {
      return null; // config.mjs reports it
    }
  })();
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
      await retryDeferred(issue, record.hold(issue, action.id));
      return;
    }
    // One nudge budget per issue and assignee, not per recovery action: each failed retry chain
    // makes a new action, and a budget keyed on it never runs out. It starts again after a day.
    const key = record.parked(issue);
    const prior = records.get(key);
    if (prior && now() - prior.at > PARKED_BUDGET_RESET_MS) records.delete(key);
    await nudge(
      issue,
      key,
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
  // within the stall window. With `patch`, the comment travels in a PATCH of the
  // issue with those fields, so both happen in one step, and `patchNote` is added
  // to it; if Paperclip refuses the fields, the comment goes alone, without the note.
  async function nudge(issue, key, agent, message, logExtra, { patch = null, patchNote = "" } = {}) {
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
      // An agent just resumed: its issues blocked during the pause are 15's to restore.
      (issue) => issue.assigneeAgentId && !issue.executionRunId && !issue.checkoutRunId && !resumeSweepHolds(issue),
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
      if (!prior || now() - prior.at > PARKED_BUDGET_RESET_MS) {
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
      (i) => candidate(i) && now() - ts(i.updatedAt) < PARKED_BUDGET_RESET_MS,
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
          comment: `The card on ${r.source} is no longer waiting (answered, withdrawn or expired), so this issue is closed.\n\n_Sent automatically by Paperclip Helper's watchdog._`,
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

  // The run behind a reference: { state: "missing" } (not in GITHUB_REPOS, or not
  // found), { state: "unknown" } (GitHub didn't answer), { state: "running" }, or
  // { state: "finished", repo, run, jobs } with the latest attempt's jobs. Read
  // once per scan: a finished run can be re-run (by you, or an agent) at any time.
  // Ids not found anywhere are remembered for the process.
  async function lookupRun(ref) {
    if (ciMissing.has(`${ref.repo ?? "*"}#${ref.id}`)) return { state: "missing" };
    const repos = ref.repo ? [ref.repo] : ciRepoOf.has(ref.id) ? [ciRepoOf.get(ref.id)] : config.repos;
    for (const repo of repos) {
      if (config.repos.length && !config.repos.includes(repo)) continue;
      const cached = ciRuns.get(`${repo}#${ref.id}`);
      if (cached) return cached;
      let run;
      try {
        run = await github.workflowRun(repo, ref.id);
      } catch (err) {
        if (err.status === 404) continue;
        const refused = err.status === 401 || (err.status === 403 && !/rate limit/i.test(err.message));
        if (refused && !ciRefused.has(repo)) {
          // Without Actions: Read no run is ever reported: say so where it's seen.
          ciRefused.add(repo);
          log.warn("watchdog: GitHub refused to show a CI run; no run in this repository is reported until it does", { repo, run: ref.id, error: err.message });
        } else {
          log.debug("watchdog: couldn't read a CI run", { repo, run: ref.id, error: err.message });
        }
        return { state: "unknown" };
      }
      ciRefused.delete(repo);
      ciRepoOf.set(ref.id, repo);
      let found = { state: "running" };
      if (run?.status === "completed") {
        const jobs = run.conclusion === "success" || UNINFORMATIVE.has(run.conclusion) ? [] : await github.workflowJobs(repo, ref.id).catch(() => []);
        found = { state: "finished", repo, run, jobs };
      }
      ciRuns.set(`${repo}#${ref.id}`, found);
      return found;
    }
    ciMissing.add(`${ref.repo ?? "*"}#${ref.id}`);
    return { state: "missing" };
  }

  // The repository's default branch, read from GitHub (never assumed) and kept
  // for an hour. When GitHub doesn't answer, the last answer if there is one,
  // else undefined: the caller waits for the next scan rather than guess. The
  // failure is logged once per repository until GitHub answers again.
  async function defaultBranch(repo) {
    const cached = ciDefaultBranch.get(repo);
    if (cached && now() - cached.at < DEFAULT_BRANCH_TTL_MS) return cached.branch;
    try {
      const branch = (await github.repository(repo))?.default_branch ?? null;
      ciDefaultBranch.set(repo, { branch, at: now() });
      ciRepoWarned.delete(repo);
      return branch;
    } catch (err) {
      if (!ciRepoWarned.has(repo)) {
        ciRepoWarned.add(repo);
        log.warn(
          cached
            ? "watchdog: couldn't read a repository's default branch; using the one read earlier"
            : "watchdog: couldn't read a repository's default branch; runs dispatched there wait until GitHub answers",
          { repo, error: err.message, ...(cached ? { defaultBranch: cached.branch } : {}) },
        );
      }
      return cached ? cached.branch : undefined;
    }
  }

  // Has the run's branch moved on since? Its PR's head, or else the branch's.
  // null when GitHub can't tell (a fork's branch, a deleted branch).
  async function headMoved(repo, run) {
    const prNumber = run.pull_requests?.[0]?.number;
    if (prNumber) {
      const pr = await github.pull(repo, prNumber).catch(() => null);
      if (!pr) return null;
      return pr.state !== "open" || Boolean(pr.head?.sha && pr.head.sha !== run.head_sha);
    }
    if (!run.head_branch) return null;
    const branch = await github.branch(repo, run.head_branch).catch(() => null);
    const sha = branch?.commit?.sha;
    return sha ? sha !== run.head_sha : null;
  }

  // Re-runs the run's failed jobs when they are all known flaky, the run is still
  // its PR's head, and it hasn't used its re-runs. True when it did.
  async function rerunFlaky({ repo, run, jobs }, issue) {
    if (!rerunPattern || run.conclusion === "success" || !onlyFlaky(jobs, rerunPattern)) return false;
    const key = record.ciRerun(repo, run);
    const prior = records.get(key);
    if ((prior?.count ?? 0) >= config.watchdogCiRerunMax || records.has(record.ciRerunFail(repo, run))) return false;
    // A newer push runs CI by itself; re-running an old head proves nothing.
    if ((await headMoved(repo, run)) !== false) return false;
    const extra = { issue: issue.identifier ?? issue.id, repo, run: run.id, attempt: run.run_attempt ?? 1, jobs: failedJobs(jobs).map((j) => j.name) };
    if (config.dryRun) {
      log("watchdog: would re-run a CI run's flaky jobs (dry run)", extra);
      return false;
    }
    try {
      await github.rerunFailedJobs(repo, run.id);
    } catch (err) {
      records.set(record.ciRerunFail(repo, run), { count: 1, at: now() });
      state.touch();
      log.warn("watchdog: GitHub refused to re-run a CI run's failed jobs; reporting it instead", { ...extra, error: err.message });
      return false;
    }
    records.set(key, { count: (prior?.count ?? 0) + 1, at: now() });
    state.touch();
    stats.ciReruns += 1;
    log("watchdog: re-ran a CI run's flaky failed jobs", { ...extra, rerun: (prior?.count ?? 0) + 1 });
    return true;
  }

  async function checkCiRuns(companyId, agents) {
    if (!github) return;
    const last = ciScanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    ciScanAt.set(companyId, now());
    ciRuns.clear();
    const issues = (await listIssues(api, companyId, CI_STATUSES)).filter(
      (i) => candidate(i) && now() - ts(i.updatedAt) < CI_LOOKBACK_MS,
    );
    const live = new Set(issues.map((i) => i.id));
    // Forget this company's issues that are no longer looked at (keys are per issue).
    for (const [id, c] of ciTexts) if (c.companyId === companyId && !live.has(id)) ciTexts.delete(id);
    for (const [k, v] of ciSilenced) if (v.companyId === companyId && !live.has(k.split(":")[1])) ciSilenced.delete(k);
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      try {
        await checkCiIssue(issue, agents, companyId);
      } catch (err) {
        log.warn("watchdog: CI run check failed", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
  }

  async function checkCiIssue(issue, agents, companyId) {
    const assignee = issue.assigneeAgentId;
    let cached = ciTexts.get(issue.id);
    let full = null;
    if (!cached || cached.updatedAt !== issue.updatedAt || cached.assignee !== assignee) {
      // The agent's latest comment, and its monitor's notes: what it said it waits on.
      const comments = await api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=10`).catch(() => null);
      if (!Array.isArray(comments)) return;
      full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
      const said = waitingOn(comments, assignee, full?.executionState?.monitor);
      cached = { companyId, updatedAt: issue.updatedAt, assignee, refs: runRefs(said.text), saidAt: said.saidAt };
      ciTexts.set(issue.id, cached);
    }
    if (!cached.refs.length) return;
    const agent = await agentFor(assignee, agents).catch(() => null);
    if (!agent || asleep(agent)) return;
    // Newest run first: the one the agent waits on. While it runs, the older ones don't matter.
    let found = null;
    for (const ref of cached.refs) {
      const r = await lookupRun(ref);
      if (r.state === "missing") continue;
      if (r.state !== "finished") return;
      found = r;
      break;
    }
    if (!found) return;
    const { run } = found;
    const key = record.ciRun(issue, run);
    if ((records.get(key)?.count ?? 0) > 0 || dryRunSeen.has(key)) return; // reported (a paused task leaves a count of 0)
    // Why a finished run isn't reported (yet), at debug level, once per run attempt
    // and reason: LOG_LEVEL=debug shows why an agent wasn't told.
    const silent = (reason, extra = {}) => {
      const seen = ciSilenced.get(key) ?? { companyId, reasons: new Set() };
      ciSilenced.set(key, seen);
      if (seen.reasons.has(reason)) return;
      seen.reasons.add(reason);
      log.debug("watchdog: a finished CI run an agent waits on isn't reported", {
        issue: issue.identifier ?? issue.id, repo: found.repo, run: run.id, attempt: run.run_attempt ?? 1, reason, ...extra,
      });
    };
    // A run dispatched on the default branch is a verdict the agent asked for: it
    // is reported on any conclusion, never re-run, and still counts once the
    // branch has moved on. Only dispatched runs ask GitHub for the default branch;
    // while GitHub doesn't say, such a run waits for the next scan, never re-run.
    let dispatchedOnDefault = false;
    if (run.event === "workflow_dispatch" && run.head_branch) {
      const branch = await defaultBranch(found.repo);
      if (branch === undefined) return silent("the repository's default branch is unknown");
      dispatchedOnDefault = run.head_branch === branch;
    }
    // Cancelled by a newer push, skipped, waiting on approval.
    if (!dispatchedOnDefault && UNINFORMATIVE.has(run.conclusion)) return silent(`its conclusion, ${run.conclusion}, says nothing about the change`);
    const finishedAt = ts(run.updated_at);
    // Give the agent's own monitor, or the agent, the stall window to notice.
    if (!finishedAt || now() - finishedAt < stallMs) return silent("finished less than the stall window ago");
    // The agent wrote about the run after it finished: it watched it within its own run.
    if (cached.saidAt && ts(cached.saidAt) >= finishedAt) return silent("the agent commented after it finished");
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => null);
    if (!Array.isArray(runs)) return;
    if (runs.some((r) => ACTIVE_RUN.has(r.status))) return silent("a run on the issue is in progress");
    // The agent has run on the issue since the run finished: it has seen the result.
    if (startedRuns(runs).some((r) => r.agentId === assignee && ts(r.startedAt ?? r.createdAt) >= finishedAt)) {
      return silent("the agent has run on the issue since it finished");
    }
    full ??= await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (!full || full.assigneeAgentId !== assignee) return;
    const monitor = full.executionState?.monitor;
    const monitorDue = monitorPending(monitor, now());
    // A monitor still due that watches this very run would only wake the agent again
    // to find it finished: report now, and clear the monitor in the same step. One
    // that watches something else is left to fire. (Paperclip redacts a monitor's
    // externalRef, so only its notes can name the run.)
    if (monitorDue && !watchesOnly(monitor, run)) return silent("the agent's Paperclip monitor will still fire", { nextCheckAt: monitor.nextCheckAt });
    // A monitor Paperclip shows without the policy that holds it can't be cleared: leave it to fire.
    if (monitorDue && !full.executionPolicy?.monitor) return silent("the agent's monitor can't be cleared");
    // A wake still waiting gets the stall window to start a run. One older than
    // that may never be delivered (a monitor's own wake can sit deferred for
    // hours), and the comment's wake joins any that is: report anyway.
    if (await hasPendingWake(full, runs, agents, { freshWithin: stallMs })) return silent("a wake for the agent is waiting to start");
    if (!dispatchedOnDefault && (await rerunFlaky(found, issue))) return;
    // Pushed since: that push's own run is what counts now.
    if (!dispatchedOnDefault && (await headMoved(found.repo, run)) === true) return silent("its branch or pull request has moved on");
    const reruns = records.get(record.ciRerun(found.repo, run))?.count ?? 0;
    // The policy is replaced whole: read it again now, so nothing changed meanwhile is overwritten.
    let clearMonitor;
    if (monitorDue) {
      const fresh = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
      const freshMonitor = fresh?.executionState?.monitor;
      if (!fresh || (monitorPending(freshMonitor, now()) && (!watchesOnly(freshMonitor, run) || !fresh.executionPolicy?.monitor))) {
        return silent("the agent's monitor changed while the report was prepared");
      }
      if (monitorPending(freshMonitor, now())) clearMonitor = withoutMonitor(fresh.executionPolicy);
    }
    const posted = await nudge(
      full,
      key,
      agent,
      ciMessage({ run, jobs: found.jobs, reruns }),
      { reason: "CI run finished", repo: found.repo, run: run.id, conclusion: run.conclusion },
      clearMonitor !== undefined
        ? { patch: { executionPolicy: clearMonitor }, patchNote: "\n\nYour Paperclip monitor for this run was cleared: it would only have woken you to find the run finished." }
        : {},
    );
    if (posted) stats.ciReports += 1;
  }

  // The issue's execution policy without its monitor (Paperclip replaces the policy
  // whole and clears the monitor when it's gone); undefined when there's no policy.
  function withoutMonitor(policy) {
    if (!policy?.monitor) return undefined;
    const { monitor, ...rest } = policy;
    return rest;
  }

  // Does the monitor watch this run and nothing else? Every run its notes name is it.
  function watchesOnly(monitor, run) {
    const refs = runRefs(monitor?.notes);
    return refs.length > 0 && refs.every((r) => String(r.id) === String(run.id));
  }

  // ---------------------------------------------------------------- 12, 13. issues waiting on your review

  // Returns the issue to its implementer as your "changes requested" decision:
  // status in_progress with the comment, in one PATCH (Paperclip's rule). Once
  // per key; a paused task or a refused decision is logged and tried no more.
  async function returnToAgent(issue, key, agent, message, logExtra) {
    if (records.has(key)) return false;
    const who = issue.identifier ?? issue.id;
    const comment = `${agentMention(agent)} ${message}\n\n_Paperclip Helper watchdog._`;
    if (config.dryRun) {
      if (dryRunSeen.has(key)) return false;
      dryRunSeen.add(key);
      log("watchdog: would return the issue to its agent (dry run)", { issue: who, agent: agent.name, ...logExtra });
      return false;
    }
    // Several requests have passed since the issue was read. If you decided in the
    // meantime (approved it, say), in_progress would reopen it: read it again.
    const { userId } = await ctx.identity();
    const now_ = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (
      !now_ ||
      !approvalWaitingOn(now_, userId) ||
      (now_.executionState?.lastDecisionId ?? null) !== (issue.executionState?.lastDecisionId ?? null) ||
      now_.executionState?.returnAssignee?.agentId !== agent.id
    ) {
      log.debug("watchdog: the issue changed before it could be returned; looked at again next time", { issue: who });
      return false;
    }
    try {
      await api.request("PATCH", `/api/issues/${issue.id}`, { status: "in_progress", comment });
    } catch (err) {
      if (pausedRefusal(err)) {
        log.debug("watchdog: the issue is paused; return postponed", { issue: who });
        return false;
      }
      records.set(key, { count: 1, at: now(), failed: true });
      state.touch();
      log.warn("watchdog: Paperclip refused to return the issue to its agent; left to you", { issue: who, ...logExtra, error: err.message });
      return false;
    }
    records.set(key, { count: 1, at: now() });
    state.touch();
    stats.returned += 1;
    log("watchdog: returned the issue to its agent", { issue: who, agent: agent.name, ...logExtra });
    return true;
  }

  async function checkWaitingOnYou(companyId, agents) {
    if (!config.watchdogDeliverAnswers && !config.watchdogReturnEscalatedReviews) return;
    const last = boardScanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    boardScanAt.set(companyId, now());
    const { userId } = await ctx.identity();
    if (!userId) return;
    const issues = (await listIssues(api, companyId, BOARD_STATUSES)).filter(
      (i) => i.assigneeUserId === userId && !i.assigneeAgentId && !i.executionRunId && !i.checkoutRunId && quiet(i),
    );
    await mapLimit(issues, CONCURRENCY, async (row) => {
      try {
        const issue = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
        if (!issue || !approvalWaitingOn(issue, userId)) return;
        const back = issue.executionState?.returnAssignee;
        if (back?.type !== "agent" || !back.agentId) return;
        const agent = await agentFor(back.agentId, agents).catch(() => null);
        // Returning it to an agent Paperclip can't invoke only parks it.
        if (!agent || asleep(agent)) return;
        const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => null);
        if (!Array.isArray(runs) || runs.some((r) => ACTIVE_RUN.has(r.status))) return;
        const cards = await api.request("GET", `/api/issues/${issue.id}/interactions`).catch(() => []);
        // An escalated review is only ever returned by 13: returning it as you for an
        // answer would reset Paperclip's round count behind WATCHDOG_RETURN_ESCALATED_REVIEWS.
        if (escalatedReview(issue, userId)) {
          if (config.watchdogReturnEscalatedReviews) await returnEscalated(issue, agent, cards, runs, agents);
          return;
        }
        if (config.watchdogDeliverAnswers) await deliverAnswer(issue, agent, cards, runs);
      } catch (err) {
        log.warn("watchdog: check of an issue waiting on your review failed", { issue: row.identifier ?? row.id, error: err.message });
      }
    });
  }

  // 12. The agent's card, answered by a person, with no run of the agent since.
  async function deliverAnswer(issue, agent, cards, runs) {
    const answered = answeredCards(cards, agent.id).sort((a, b) => ts(b.resolvedAt) - ts(a.resolvedAt));
    const card = answered[0];
    if (!card) return false;
    const answeredAt = ts(card.resolvedAt);
    // Give you time to decide yourself after answering (approve, or send it back with a note).
    if (now() - answeredAt < Math.max(stallMs, ANSWER_WAIT_MS)) return true;
    // A run of the agent that started after the answer, or was still going when it
    // came, has seen it (Paperclip hands a running agent the answer).
    if (startedRuns(runs).some((r) => r.agentId === agent.id && (ACTIVE_RUN.has(r.status) || ts(r.finishedAt) >= answeredAt || ts(r.startedAt ?? r.createdAt) >= answeredAt))) return false;
    const key = record.answer(card);
    if (records.has(key)) return false;
    const what = cardText(card, 300);
    return returnToAgent(
      issue,
      key,
      agent,
      `your card on this issue${what ? ` ("${what}")` : ""} was answered, but the answer reached no one: the issue was ` +
        `waiting on the board's review, so Paperclip woke no agent. The answer:\n\n${quote(answerText(card))}\n\n` +
        `The watchdog has returned the issue to you. Act on the answer (check what it reports), then hand the issue back for ` +
        `review; if nothing needs to change, say so and resubmit as it is.`,
      { reason: "answered card", card: card.id },
    );
  }

  // 13. A review Paperclip escalated to you after the agents used up their rounds.
  async function returnEscalated(issue, agent, cards, runs, agents) {
    const decisionId = issue.executionState?.lastDecisionId ?? null;
    const seen = record.escalatedSeen(issue, decisionId);
    if (records.has(seen)) return;
    const who = issue.identifier ?? issue.id;
    // Waiting on a person for something else (a card addressed to one): that comes first.
    const waitingOnPerson = (Array.isArray(cards) ? cards : []).some((c) => c?.status === "pending" && (c.addresseeUserId || !c.addresseeAgentId));
    if (waitingOnPerson) return;
    const comments = await api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=20`).catch(() => null);
    if (!Array.isArray(comments)) return;
    // The reviewer's request: the latest comment by one of the stage's reviewers, or
    // else by any agent other than the implementer.
    const reviewers = new Set((reviewStage(issue)?.participants ?? []).filter((p) => p?.type === "agent").map((p) => p.agentId));
    const request =
      comments.find((c) => c?.authorAgentId && reviewers.has(c.authorAgentId)) ??
      comments.find((c) => c?.authorAgentId && c.authorAgentId !== agent.id);
    if (!request) return;
    // The implementer has run since that request: it isn't waiting to hear it.
    if (startedRuns(runs).some((r) => r.agentId === agent.id && ts(r.startedAt ?? r.createdAt) > ts(request.createdAt))) return;
    const budget = record.escalated(issue);
    const used = records.get(budget)?.count ?? 0;
    records.set(seen, { count: 1, at: now() });
    state.touch();
    if (used >= config.watchdogMaxNudges) {
      log.warn("watchdog: a review Paperclip escalated to you again; the watchdog's returns are used up, so it's yours", {
        issue: who,
        rounds: issue.executionState?.changesRequestedCount ?? null,
        hint: "Approve, request changes yourself, or raise maxReviewRounds in the issue's execution policy.",
      });
      return;
    }
    const reviewer = await agentFor(request.authorAgentId, agents).catch(() => null);
    const rounds = issue.executionState?.changesRequestedCount ?? null;
    const done = await returnToAgent(
      issue,
      `${budget}:${used + 1}`,
      agent,
      `${reviewer?.name ?? "The reviewer"} requested changes again, and after ${rounds ?? "several"} rounds Paperclip handed the ` +
        `review to the board instead of back to you (its review-round limit). The watchdog returns it to you with the latest ` +
        `request:\n\n${quote(request.body)}\n\nPlease address it and resubmit. If you think the request is wrong, or it needs ` +
        `a decision from the board, say so in a comment instead of resubmitting unchanged.`,
      { reason: "escalated review", rounds, reviewer: reviewer?.name ?? null },
    );
    if (done) {
      records.set(budget, { count: used + 1, at: now() });
      state.touch();
    } else {
      records.delete(seen); // not returned (dry run, paused): look again next time
      state.touch();
    }
  }

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
          state.touch();
        }
        if (!gone || gone === true) continue; // can't tell: look again next tick
        agent = gone;
      }
      if (agent.status === "terminated") {
        records.delete(key);
        state.touch();
        continue;
      }
      if (agent.status === "paused") {
        if (!paused) {
          // Paused again before its issues were all restored: the next resume covers both pauses.
          records.delete(key);
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
        const entry = { count: 0, at: now(), since: r.since, resumedAt: tickAt, companyId, restored: [] };
        records.set(record.agentResumed(agentId), entry);
        state.touch();
        log("watchdog: an agent was resumed; looking for its issues Paperclip's recovery blocked during the pause", {
          agent: agent.name,
          pausedSince: new Date(r.since).toISOString(),
        });
        resumed.push({ agent, entry });
        continue;
      }
      if (asleep(agent)) continue; // awaiting approval: its issues wait
      if (now() - (r.resumedAt ?? 0) > RESUME_SWEEP_MS) {
        records.delete(key);
        sweepHeld.delete(agentId);
        state.touch();
        continue;
      }
      resumed.push({ agent, entry: r });
    }
    // Agents seen paused for the first time. Paperclip's pausedAt says when; without
    // it, no earlier than this process's previous tick that saw the agent unpaused,
    // or now on the first tick (a block from before then isn't attributed to the pause).
    for (const agent of agents.values()) {
      if (agent.status !== "paused") continue;
      if (records.has(record.agentPaused(agent.id)) || records.has(record.agentResumed(agent.id))) continue;
      const known = seenStatus.has(agent.id) && seenStatus.get(agent.id) !== "paused" && previousTickAt != null;
      const since = ts(agent.pausedAt) || (known ? previousTickAt : tickAt);
      records.set(record.agentPaused(agent.id), { count: 1, at: now(), since, companyId });
      state.touch();
    }
    for (const agent of agents.values()) seenStatus.set(agent.id, agent.status);
    return resumed;
  }

  // Is this issue waiting for a sweep under way (to be restored on a later tick, or
  // postponed)? Then 6 leaves it to the sweep. Issues the sweep turned down aren't held.
  const resumeSweepHolds = (issue) => config.watchdogResumeSweep && Boolean(sweepHeld.get(issue.assigneeAgentId)?.has(issue.id));

  async function checkResumes(companyId, agents, tickAt) {
    const resumed = await trackPauses(companyId, agents, tickAt);
    if (!resumed.length) return;
    const blocked = (await listIssues(api, companyId, "blocked")).sort(sweepOrder);
    for (const { agent, entry } of resumed) {
      try {
        await sweepAgent(agent, entry, blocked.filter((i) => i.assigneeAgentId === agent.id));
      } catch (err) {
        log.warn("watchdog: resume sweep failed", { agent: agent.name, error: err.message });
      }
    }
  }

  // Each tick: every one of the agent's blocked issues is looked at, and up to the
  // limit restored, less those this sweep restored earlier that still have a run
  // queued or going, so a resume never puts more than the limit of runs in flight.
  // The sweep ends at the first tick with nothing left to restore and nothing postponed.
  async function sweepAgent(agent, entry, issues) {
    const limit = config.watchdogResumeSweepLimit || concurrencyOf(agent);
    const earlier = Array.isArray(entry.restored) ? entry.restored : [];
    let inFlight = 0;
    for (const id of earlier) {
      const runs = await api.request("GET", `/api/issues/${id}/runs`).catch(() => null);
      // Unknown counts as in flight: prefer waiting a tick to queueing too many.
      if (!Array.isArray(runs) || runs.some((r) => r.agentId === agent.id && ACTIVE_RUN.has(r.status))) inFlight += 1;
    }
    let budget = Math.max(0, limit - inFlight);
    const held = new Set();
    const restoredNow = [];
    for (const issue of issues) {
      const verdict = await pauseBlocked(issue, agent, entry);
      if (verdict === "postponed") {
        held.add(issue.id);
        continue;
      }
      if (!verdict) continue;
      if (budget <= 0) {
        held.add(issue.id); // a later tick
        continue;
      }
      const result = await restoreIssue(issue, agent, verdict);
      if (result === "restored") {
        budget -= 1;
        restoredNow.push(issue.id);
      } else if (result === "postponed") held.add(issue.id);
    }
    const key = record.agentResumed(agent.id);
    if (held.size) sweepHeld.set(agent.id, held);
    else sweepHeld.delete(agent.id);
    // In a dry run nothing changed, so nothing is used up: the sweep stays for the real run (until it expires).
    if (!held.size && !config.dryRun) {
      records.delete(key);
      log.debug("watchdog: resume sweep finished", { agent: agent.name, restored: (entry.count ?? 0) + restoredNow.length });
    } else {
      // Only the restored issues whose runs may still be going are worth keeping.
      const restored = [...earlier, ...restoredNow].slice(-MAX_REMEMBERED_RESTORES);
      records.set(key, { ...entry, count: (entry.count ?? 0) + restoredNow.length, restored, at: now() });
    }
    state.touch();
  }

  // Is this an issue Paperclip's recovery blocked because the agent was paused, and
  // that nobody has touched since? { latest, action, target } if so, "postponed"
  // when Paperclip couldn't say right now, else false.
  async function pauseBlocked(row, agent, entry) {
    if (row.status !== "blocked" || row.assigneeAgentId !== agent.id || row.executionRunId || row.checkoutRunId) return false;
    const full = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
    if (!full) return "postponed";
    if (full.status !== "blocked" || full.assigneeAgentId !== agent.id) return false;
    // Blocked by another issue: that is why it is blocked, not the pause.
    if (holdingBlockers(full).length) return false;
    // The newest comment must be the recovery notice: anything after it (a person,
    // the agent, the watchdog) means someone has acted on the issue since.
    const comments = await api.request("GET", `/api/issues/${row.id}/comments?order=desc&limit=1`).catch(() => null);
    if (!Array.isArray(comments)) return "postponed";
    const latest = comments[0];
    const notice = recoveryNotice(latest);
    if (!notice) return false;
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
    const kind = pauseRecoveryAction(action);
    // An action of another cause (a lost process, a failed workspace) isn't the pause.
    if (kind === false) return false;
    // Without the action, other recovery families post the same Recovery section:
    // only the "not invokable" notice, or a run the pause cancelled, is the pause's.
    if (kind === null && !notice.notInvokable) return false;
    const runs = await api.request("GET", `/api/issues/${row.id}/runs`).catch(() => null);
    if (!Array.isArray(runs)) return "postponed";
    if (runs.some((r) => ACTIVE_RUN.has(r.status))) return false;
    return { latest, target: restoreStatus(full, action) };
  }

  // "restored" (or, in a dry run, would have been), "postponed" (try again next
  // tick), or false (refused: left to you).
  async function restoreIssue(row, agent, { latest, target }) {
    const who = row.identifier ?? row.id;
    const key = record.resumeRestore(row, latest.id);
    const extra = { issue: who, agent: agent.name, status: target.status, from: target.from };
    if (config.dryRun) {
      dryRunSeen.add(key);
      log("watchdog: would restore an issue blocked while its agent was paused (dry run)", extra);
      return "restored";
    }
    const comment =
      `${agentMention(agent)} was resumed: retrying the original owner (the recovery block came from the pause).` +
      `\n\n_Paperclip Helper watchdog._`;
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
    const { companyIds = [] } = await ctx.identity();
    try {
      for (const companyId of companyIds) {
        let listed = true;
        const list = await companyAgents(api, companyId).catch(() => {
          listed = false;
          return [];
        });
        const agents = new Map(list.map((a) => [a.id, a]));
        // Without the agents' statuses a pause or resume can't be told: wait for the next tick.
        // Pauses for a usage limit first, then resumes, which the resume sweep then sees.
        if (config.watchdogLimitPause && listed) await limits.check(companyId, agents);
        if (config.watchdogResumeSweep && listed) await checkResumes(companyId, agents, started);
        if (config.watchdogClearDeadLinks) {
          await checkDeadLinks(companyId, agents);
          await checkScheduledWorkspaces(companyId, agents);
        }
        await checkBlocked(companyId, agents);
        await checkHandOffs(companyId, agents);
        if (config.watchdogRouteQuestions) await checkQuestions(companyId, agents);
        await checkWaitingOnYou(companyId, agents);
        if (config.watchdogCiRuns) await checkCiRuns(companyId, agents);
        if (config.watchdogStagesWipe) await stagesCheck.check(companyId, agents);
      }
      stats.lastError = null;
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
        limitPause: config.watchdogLimitPause ? { graceMin: config.watchdogLimitResumeGraceMin, notifyIssue: config.watchdogNotifyIssue || null } : false,
        stagesWipe: config.watchdogStagesWipe ? (github ? true : "on, without the open-PR part: no GitHub token") : false,
        resumeSweep: config.watchdogResumeSweep ? config.watchdogResumeSweepLimit || "the agent's maxConcurrentRuns" : false,
      });
      loop = every("watchdog", config.watchdogIntervalSec, 5_000, tick, log);
    },
    async stop() {
      await loop?.stop();
    },
  };
}
