// Configuration: environment variables (usually from .env), validated once.
//
// loadConfig() never throws. It returns the settings plus a list of problems,
// one readable line each, so the caller can print them all (the service then
// stops; one-off commands carry on).

import path from "node:path";

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

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
  const num = (name, fallback, { min = 0 } = {}) => {
    const raw = get(name);
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
      problems.push(`${name}=${raw} must be a number of at least ${min}`);
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
    listenPort: num("RELAY_PORT", 3110, { min: 0 }),
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
    // Return an issue waiting on your review to its agent when you answered the agent's
    // card meanwhile: Paperclip woke you with the answer, not the agent.
    watchdogDeliverAnswers: bool("WATCHDOG_DELIVER_ANSWERS", true),
    // Return a review Paperclip escalated to you after the agents used up their review
    // rounds (maxReviewRounds) to its implementer. Off: that limit is deliberate.
    watchdogReturnEscalatedReviews: bool("WATCHDOG_RETURN_ESCALATED_REVIEWS", false),
    // Tell an agent its issue is blocked by a cancelled issue, which Paperclip never
    // counts as resolved.
    watchdogCancelledBlockers: bool("WATCHDOG_CANCELLED_BLOCKERS", true),

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
