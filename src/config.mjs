// Configuration: environment variables (usually from .env), validated once.
//
// loadConfig() never throws. It returns the settings plus a list of problems,
// one readable line each, so the caller can print them all (the service then
// stops; one-off commands carry on).

import path from "node:path";

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

export const DEFAULT_KEEP_OPEN_MARKER = "Merge does not complete this issue";

export function loadConfig(env = process.env) {
  const problems = [];
  const get = (name, fallback = "") => {
    const value = env[name];
    return value === undefined || value.trim() === "" ? fallback : value.trim();
  };
  const isSet = (name) => get(name) !== "";
  const bool = (name, fallback) => {
    const value = get(name);
    if (value === "") return fallback;
    if (TRUE.test(value)) return true;
    if (FALSE.test(value)) return false;
    problems.push(`${name}=${value} is not true or false`);
    return fallback;
  };
  const num = (name, fallback, { min = 0, max = Infinity } = {}) => {
    const raw = get(name);
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      problems.push(`${name}=${raw} must be a number ${max < Infinity ? `from ${min} to ${max}` : `of at least ${min}`}`);
      return fallback;
    }
    return value;
  };
  const list = (name) =>
    get(name)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const url = (name, fallback) => {
    const value = get(name, fallback).replace(/\/+$/, "");
    if (!value) return "";
    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      problems.push(`${name}=${value} is not an http(s) URL`);
    }
    return value;
  };
  const regex = (name) => {
    const raw = get(name);
    if (!raw) return "";
    try {
      new RegExp(raw, "i");
    } catch (err) {
      problems.push(`${name}=${raw} is not a regular expression (${err.message})`);
      return "";
    }
    return raw;
  };
  const zone = (name) => {
    const raw = get(name);
    if (!raw) return "";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw });
    } catch {
      problems.push(`${name}=${raw} is not a time zone (use an IANA name, e.g. Europe/London or UTC)`);
      return "";
    }
    return raw;
  };
  const date = (name) => {
    const raw = get(name);
    if (!raw) return null;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) {
      problems.push(`${name}=${raw} is not a date (use ISO 8601, e.g. 2026-10-01T00:00:00Z)`);
      return null;
    }
    return new Date(t).toISOString();
  };

  const dataDir = get("DATA_DIR", "/data");
  const logLevel = get("LOG_LEVEL", "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    problems.push(`LOG_LEVEL=${logLevel} must be debug, info, warn or error`);
  }

  // RELAY: true, false, or unset. Unset turns the relay on when any of
  // GITHUB_WEBHOOK_SECRET, GITHUB_OWNER_LOGIN or GITHUB_REPOS is set
  // (serviceProblems then requires all three).
  const relaySetting = get("RELAY");
  const relayFields = ["GITHUB_WEBHOOK_SECRET", "GITHUB_OWNER_LOGIN", "GITHUB_REPOS"];
  const relayConfigured = relayFields.filter(isSet);
  let relay;
  let relayAuto = false;
  if (relaySetting === "") {
    relayAuto = true;
    relay = relayConfigured.length > 0;
  } else {
    relay = bool("RELAY", false);
  }
  const webhookPath = get("RELAY_PATH", "/hooks/github");
  if (!webhookPath.startsWith("/")) problems.push(`RELAY_PATH=${webhookPath} must start with /`);

  // A backstop is hours out, never minutes: a short one is the polling it replaces.
  const backstopMin = get("WATCHDOG_CI_BACKSTOP_MIN");
  if (backstopMin !== "" && Number(backstopMin) > 0 && Number(backstopMin) < 30) {
    problems.push(`WATCHDOG_CI_BACKSTOP_MIN=${backstopMin} must be 0 (off) or at least 30`);
  }
  const sweepSec = get("RELAY_CONFLICT_SWEEP_SEC");
  if (sweepSec !== "" && Number(sweepSec) > 0 && Number(sweepSec) < 60) {
    problems.push(`RELAY_CONFLICT_SWEEP_SEC=${sweepSec} must be 0 (off) or at least 60`);
  }

  const config = {
    version: "",
    dataDir,
    logLevel,
    dryRun: bool("DRY_RUN", false),

    // Paperclip
    paperclipApi: url("PAPERCLIP_API", "http://127.0.0.1:3100"),
    publicUrl: url("PAPERCLIP_PUBLIC_URL", ""),
    tokenFile: get("PAPERCLIP_TOKEN_FILE", path.posix.join(dataDir, "paperclip-token")),
    keyName: get("PAPERCLIP_KEY_NAME", "paperclip-helper"),
    keyExpiresDays: num("KEY_EXPIRES_DAYS", 365),
    timeoutSec: num("PAPERCLIP_TIMEOUT_SEC", 20, { min: 1 }),
    stateFile: get("STATE_FILE", path.posix.join(dataDir, "state.json")),
    statusFile: get("STATUS_FILE", path.posix.join(dataDir, "status.json")),

    // relay.mjs: GitHub webhooks
    relay,
    relayAuto,
    listenHost: get("RELAY_HOST", "127.0.0.1"),
    listenPort: num("RELAY_PORT", 3110, { min: 0, max: 65535 }),
    webhookPath,
    secret: get("GITHUB_WEBHOOK_SECRET"),
    ownerLogin: get("GITHUB_OWNER_LOGIN").toLowerCase(),
    repos: list("GITHUB_REPOS").map((s) => s.toLowerCase()),
    // Empty: use every company's own issue prefix, read from Paperclip.
    prefixes: list("ISSUE_PREFIXES").map((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean),
    // Post a newly opened PR's URL on its issue, so Paperclip links the PR.
    relayLinkPrs: bool("RELAY_LINK_PRS", true),
    // Reply on the PR when your /changes, /approve or "Request changes" wasn't recorded
    // as a decision, saying where it went and why (needs GITHUB_TOKEN or GITHUB_TOKEN_FILE).
    relayPrNotes: bool("RELAY_PR_NOTES", true),

    // relay.mjs: send PRs with merge conflicts back to their agents
    relayFixConflicts: bool("RELAY_FIX_CONFLICTS", false),
    // Either a token as it is (a personal access token: a person's or a machine account's), or a
    // file that another program keeps fresh (a GitHub App installation token lasts an hour). The
    // file is read again for every request, so a renewed token is used at once.
    githubToken: get("GITHUB_TOKEN"),
    githubTokenFile: get("GITHUB_TOKEN_FILE"),
    githubApi: url("GITHUB_API", "https://api.github.com"),
    // Send-backs per PR for one run of conflicts, before leaving it to you.
    conflictMaxAttempts: num("RELAY_CONFLICT_MAX_ATTEMPTS", 2, { min: 1 }),
    // Say on the PR that it was sent back (needs a token that can write).
    conflictPrComment: bool("RELAY_CONFLICT_PR_COMMENT", true),
    // Besides after each merge, look at every open PR this often. 0 = only after merges.
    conflictSweepSec: num("RELAY_CONFLICT_SWEEP_SEC", 900),
    // A PR the merge queue drops without a conflict: a failed check sends it back to its
    // agent, a cancelled run or the queue's timeout is noted for the board (needs a token).
    // On by default; it needs a GitHub token, and without one the relay says once that it is off.
    relayMergeQueue: bool("RELAY_MERGE_QUEUE", true),
    // Queue such a PR again yourself (once per head commit, only one a person queued).
    // Needs a token allowed to merge (GraphQL enqueuePullRequest). Off by default.
    relayRequeueOnInfraDrop: bool("RELAY_REQUEUE_ON_INFRA_DROP", false),
    // When you merge an issue's own PR and the issue has no review or approval stage
    // left to record it, close the issue as done, as the approval would have.
    relayDoneWithoutStages: bool("RELAY_DONE_WITHOUT_STAGES", true),
    // Your merge doesn't finish an issue whose hand-off or description says so with
    // this phrase (any case): the issue goes back to its implementer instead of being
    // approved. Set but empty: the check is off.
    relayMergeKeepOpenMarker: env.RELAY_MERGE_KEEP_OPEN_MARKER === undefined ? DEFAULT_KEEP_OPEN_MARKER : env.RELAY_MERGE_KEEP_OPEN_MARKER.trim(),
    // Nor does it finish an issue with open child issues (off by default).
    relayMergeKeepOpenChildren: bool("RELAY_MERGE_KEEP_OPEN_CHILDREN", false),
    // Notes that need nothing from the agent (PR opened, closed, merged by someone
    // else) go in the issue's "pull-requests" document, which wakes nobody, not in a
    // comment, which wakes the assignee.
    relayQuietNotes: bool("RELAY_QUIET_NOTES", true),

    // watchdog.mjs: re-wake stalled work
    watchdog: bool("WATCHDOG", true),
    watchdogIntervalSec: Math.max(15, num("WATCHDOG_INTERVAL_SEC", 60, { min: 1 })),
    watchdogStallSec: num("WATCHDOG_STALL_SEC", 180, { min: 1 }),
    watchdogMaxNudges: num("WATCHDOG_MAX_NUDGES", 2),
    watchdogHealFailedFinalize: bool("WATCHDOG_HEAL_FAILED_FINALIZE", true),
    watchdogRetryDeferred: bool("WATCHDOG_RETRY_DEFERRED", true),
    watchdogReleaseHolds: bool("WATCHDOG_RELEASE_HOLDS", true),
    watchdogClearDeadLinks: bool("WATCHDOG_CLEAR_DEAD_LINKS", true),
    // Give an agent an issue for each question card a teammate addressed to it
    // that Paperclip never delivered (its wake is cancelled for a non-assignee).
    watchdogRouteQuestions: bool("WATCHDOG_ROUTE_QUESTIONS", true),
    // Tell an agent that a GitHub Actions run it said it waits on has finished, once it
    // has and the agent hasn't run since (needs GITHUB_TOKEN or GITHUB_TOKEN_FILE).
    watchdogCiRuns: bool("WATCHDOG_CI_RUNS", true),
    // Known flaky jobs (a regular expression on the job name): a run whose failed jobs
    // all match is re-run first, up to WATCHDOG_CI_RERUN_MAX times. Empty: never re-run.
    watchdogCiRerunJobs: regex("WATCHDOG_CI_RERUN_JOBS"),
    watchdogCiRerunMax: num("WATCHDOG_CI_RERUN_MAX", 2),
    // While a run an agent waits on is still going, give its issue (in progress) a
    // Paperclip monitor of the watchdog's own, this many minutes out: the live path
    // Paperclip's disposition guard asks for. Cleared when the run is reported; it
    // fires only if that report never comes. At least the runs' worst case (a merge
    // queue's status-check timeout, a long queue for one runner). 0: no backstop.
    watchdogCiBackstopMin: num("WATCHDOG_CI_BACKSTOP_MIN", 360),
    // Return an issue waiting on your review to its agent when you answered the agent's
    // card meanwhile: Paperclip woke you with the answer, not the agent.
    watchdogDeliverAnswers: bool("WATCHDOG_DELIVER_ANSWERS", true),
    // Return a review Paperclip escalated to you after the agents used up their review
    // rounds (maxReviewRounds) to its implementer. Off: that limit is deliberate.
    watchdogReturnEscalatedReviews: bool("WATCHDOG_RETURN_ESCALATED_REVIEWS", false),
    // Tell an agent its issue is blocked by a cancelled issue, which Paperclip never
    // counts as resolved.
    watchdogCancelledBlockers: bool("WATCHDOG_CANCELLED_BLOCKERS", true),
    // When a paused agent is resumed, restore its issues Paperclip's recovery blocked
    // during the pause ("the original assignee is not invokable"). WATCHDOG_RESUME_SWEEP_LIMIT:
    // the runs the watchdog may give an agent at once, counting those it has queued or
    // going, for these restores and for 6's nudges (0: the agent's maxConcurrentRuns).
    watchdogResumeSweep: bool("WATCHDOG_RESUME_SWEEP", true),
    watchdogResumeSweepLimit: Math.floor(num("WATCHDOG_RESUME_SWEEP_LIMIT", 0)),
    // Minutes a resume must hold before the agent's blocked issues are touched: a
    // resume to check one thing, then a pause again, restores and wakes nothing.
    watchdogResumeSettleMin: Math.max(0, num("WATCHDOG_RESUME_SETTLE_MIN", 10)),
    // When a plan hits its usage limit (a Claude or Codex agent's run fails with the
    // limit wording), pause the agents on that account (each once idle) and resume them
    // this many minutes after the reset. A comment goes on WATCHDOG_NOTIFY_ISSUE (an
    // issue identifier) when it happens, if set. WATCHDOG_LIMIT_PAUSE is the name
    // before 1.12, still read when the new one isn't set.
    watchdogLimitPause: bool("WATCHDOG_USAGE_LIMIT_PAUSE", bool("WATCHDOG_LIMIT_PAUSE", true)),
    watchdogLimitResumeGraceMin: num("WATCHDOG_LIMIT_RESUME_GRACE_MIN", 5),
    // The time zone Codex writes its reset times in ("try again at 3:45 PM"): that of
    // the machine Paperclip runs on. Empty: the helper's own.
    watchdogLimitTimeZone: zone("WATCHDOG_LIMIT_TIME_ZONE"),
    watchdogNotifyIssue: get("WATCHDOG_NOTIFY_ISSUE"),
    // Minutes an issue held by a run a pause cancelled must be quiet (no comment, status
    // move or reassignment by a person, no stage hand-off) before the watchdog continues it.
    watchdogHoldQuietMin: num("WATCHDOG_HOLD_QUIET_MIN", 60),
    // Reopen a done issue whose own PR is still open, and report issues whose review
    // stages an update removed (the open-PR part needs a GitHub token).
    watchdogStagesWipe: bool("WATCHDOG_STAGES_WIPE", true),
    // Tell the board when an issue reaches your approval stage with its PR approved by
    // every reviewer, clean and green: ready to queue (needs a GitHub token). Off by default.
    watchdogReportReadyToMerge: bool("WATCHDOG_REPORT_READY_TO_MERGE", false),
    // Tell the board, once per project checkout, when issues are parked because their git
    // worktree links are relative (watchdog 20). Notes only: nothing is commented or changed.
    watchdogWorktreeLinks: bool("WATCHDOG_WORKTREE_LINKS", true),
    // Tell the board, once per issue, when an agent keeps waking itself there: its runs
    // end without a comment of its own, Paperclip posts each run's final message as the
    // agent's comment, and that starts its next run (watchdog 21). Notes only.
    watchdogSelfWakes: bool("WATCHDOG_SELF_WAKES", true),

    // cost-sync.mjs: API-equivalent cost of subscription runs
    costSync: bool("COST_SYNC", true),
    costSyncIntervalSec: Math.max(60, num("COST_SYNC_INTERVAL_SEC", 900, { min: 1 })),
    costStateFile: get("COST_STATE_FILE", path.posix.join(dataDir, "cost-synced.json")),
    costSyncSince: date("COST_SYNC_SINCE"),
    costSyncAdapters: list("COST_SYNC_ADAPTERS").map((s) => s.toLowerCase()),
    costPricesFile: get("COST_PRICES_FILE", path.posix.join(dataDir, "prices.json")),
    codexDefaultModel: get("CODEX_DEFAULT_MODEL"),
    costSyncSettleSec: num("COST_SYNC_SETTLE_SEC", 300),
  };
  if (!config.costSyncAdapters.length) config.costSyncAdapters = ["claude_local", "codex_local"];

  const relayProblems = [];
  if (!config.secret) relayProblems.push("GITHUB_WEBHOOK_SECRET is not set");
  if (!config.ownerLogin) relayProblems.push("GITHUB_OWNER_LOGIN is not set");
  if (!config.repos.length) relayProblems.push("GITHUB_REPOS is not set");
  config.relayProblems = relayProblems;

  return { config, problems };
}

// Problems that stop the long-running service (not the one-off commands).
export function serviceProblems(config) {
  const problems = [];
  if (config.relay && config.relayProblems.length) {
    const why = config.relayAuto
      ? "the relay turns on when any of GITHUB_WEBHOOK_SECRET, GITHUB_OWNER_LOGIN or GITHUB_REPOS is set, and then needs all three"
      : "RELAY=true needs all three of GITHUB_WEBHOOK_SECRET, GITHUB_OWNER_LOGIN and GITHUB_REPOS";
    for (const p of config.relayProblems) problems.push(`${p} (${why}; set RELAY=false to turn it off)`);
  }
  if (config.relay && config.relayFixConflicts && !config.githubToken && !config.githubTokenFile) {
    problems.push(
      "GITHUB_TOKEN is not set (RELAY_FIX_CONFLICTS=true reads pull requests from GitHub with it, or with GITHUB_TOKEN_FILE; set RELAY_FIX_CONFLICTS=false to turn it off)",
    );
  }
  if (config.githubToken && config.githubTokenFile) {
    problems.push("GITHUB_TOKEN and GITHUB_TOKEN_FILE are both set: keep one (the token, or the file that holds it)");
  }
  if (!config.relay && !config.watchdog && !config.costSync) {
    problems.push("the relay, WATCHDOG and COST_SYNC are all off: there is nothing to run");
  }
  return problems;
}
