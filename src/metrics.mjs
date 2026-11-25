// Lifetime metrics: what the helper has done since it was first started, across
// restarts and upgrades, and the latest warnings and errors. One small JSON file in
// the data directory (data/metrics.json, beside state.json), which `pch status` reads.
//
// The components keep counts since their own start (their `stats`). Each heartbeat
// adds those to the totals the file held when this process started and writes the
// file again, so nothing has to count twice. Warnings and errors are counted as
// they're logged, and the last RECENT of them kept. A process killed between two
// heartbeats loses at most one heartbeat's counts. It's a rough record, not an audit.
//
// `pch status --clear-problems` clears the warnings and errors (not the counts) from
// another process: it writes the file with them emptied and a problemsClearedAt, and
// the running service, which would otherwise write its own back at the next heartbeat,
// sees the newer problemsClearedAt there and drops everything logged before it.

import path from "node:path";
import { readJson, writeJson } from "./store.mjs";
import { redact } from "./log.mjs";

const RECENT = 10;

// What each count is, where it comes from in the status's component stats, and a
// rough guess at the minutes it saves you: noticing the stall, finding why, and
// doing it by hand. Counts with no minutes are shown but not credited (a CI
// report is already one of the agents woken).
export const COUNTERS = [
  // relay
  { key: "githubEvents", label: "GitHub events handled", from: (s) => s.relay?.handled },
  { key: "approvals", label: "merges and approvals recorded as your decision", minutes: 3, from: (s) => s.relay?.approvals },
  { key: "changeRequests", label: "change requests relayed to an agent", minutes: 3, from: (s) => s.relay?.changeRequests },
  { key: "conflictsSentBack", label: "PRs with merge conflicts sent back", minutes: 5, from: (s) => s.relay?.conflicts?.sentBack },
  { key: "queueDrops", label: "merge-queue drops sorted out", minutes: 5, from: (s) => s.relay?.mergeQueue?.dropped },
  { key: "relayFailures", label: "GitHub events that failed", from: (s) => s.relay?.failed },
  // watchdog
  { key: "watchdogChecks", label: "watchdog checks run", from: (s) => s.watchdog?.ticks },
  { key: "nudges", label: "stalled agents woken", minutes: 10, from: (s) => s.watchdog?.nudges },
  { key: "ciReports", label: "of them, finished CI runs reported", from: (s) => s.watchdog?.ciReports },
  { key: "retries", label: "deferred wakes retried", minutes: 5, from: (s) => s.watchdog?.retries },
  { key: "releases", label: "holds released", minutes: 15, from: (s) => s.watchdog?.releases },
  { key: "unstartedHolds", label: "of them, behind a run that never started", from: (s) => s.watchdog?.unstartedHolds },
  { key: "suppressedRepairs", label: "of them, behind a suppressed disposition repair", from: (s) => s.watchdog?.suppressedRepairs },
  { key: "pausedHolds", label: "holds from a paused run lifted", minutes: 15, from: (s) => s.watchdog?.pausedHolds },
  { key: "heals", label: "blockers stuck on a failed clean-up repaired", minutes: 15, from: (s) => s.watchdog?.heals },
  { key: "deadLinks", label: "links to a closed workspace cleared", minutes: 15, from: (s) => s.watchdog?.deadLinks },
  { key: "questions", label: "undelivered question cards routed", minutes: 15, from: (s) => s.watchdog?.questions },
  { key: "returned", label: "reviews returned to their agent", minutes: 10, from: (s) => s.watchdog?.returned },
  { key: "resumed", label: "issues restored after a resume", minutes: 5, from: (s) => s.watchdog?.resumed },
  { key: "limitPauses", label: "agents paused at a usage limit", minutes: 5, from: (s) => s.watchdog?.limitPauses },
  { key: "limitResumes", label: "agents resumed after the limit reset", minutes: 5, from: (s) => s.watchdog?.limitResumes },
  { key: "ciReruns", label: "flaky CI runs re-run", minutes: 5, from: (s) => s.watchdog?.ciReruns },
  { key: "ciBackstops", label: "CI waits given a backstop monitor", from: (s) => s.watchdog?.ciBackstops },
  { key: "reopened", label: "issues closed with an open PR reopened", minutes: 15, from: (s) => s.watchdog?.reopened },
  { key: "wipes", label: "wiped review stages reported", minutes: 10, from: (s) => s.watchdog?.wipes },
  { key: "runnerProblems", label: "broken runners reported", minutes: 15, from: (s) => s.watchdog?.runnerProblems },
  { key: "readyNotes", label: "PRs reported ready to queue", minutes: 2, from: (s) => s.watchdog?.readyNotes },
  { key: "worktreeLinkNotes", label: "project checkouts with relative worktree links reported", minutes: 15, from: (s) => s.watchdog?.worktreeLinkNotes },
  { key: "selfWakes", label: "agents waking themselves reported", minutes: 15, from: (s) => s.watchdog?.selfWakes },
  { key: "stuck", label: "wakes stuck behind a stopped run, reported", from: (s) => s.watchdog?.stuck },
  // cost sync
  { key: "costPosts", label: "run costs posted", from: (s) => s.costSync?.posted },
  { key: "costCents", label: "cents posted", from: (s) => s.costSync?.postedCents },
];

const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

// A warning's or error's one-line detail: the fields that say what it was about.
function detailOf(extra) {
  const e = redact(extra ?? {});
  const parts = [];
  for (const k of ["issue", "check", "company", "repo", "pr", "agent", "run", "error"]) {
    const v = e[k];
    if (v == null || v === "") continue;
    parts.push(`${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  // A note that something is left: what is in the way first.
  if (Array.isArray(e.problems) && e.problems[0]) parts.push(String(e.problems[0]));
  return parts.join(", ").slice(0, 300) || null;
}

export function metricsFile(config) {
  return path.posix.join(config.dataDir, "metrics.json");
}

export function readMetrics(config) {
  return readJson(metricsFile(config), null);
}

export function createMetrics(config, { version = "", now = () => Date.now() } = {}) {
  const file = metricsFile(config);
  const saved = readJson(file, null) ?? {};
  const at = () => new Date(now()).toISOString();
  const base = { ...(saved.totals ?? {}) };
  const data = {
    firstStartedAt: saved.firstStartedAt ?? at(),
    starts: (saved.starts ?? 0) + 1,
    firstVersion: saved.firstVersion ?? version,
    version,
    totals: { ...base },
    warnings: saved.warnings ?? 0,
    errors: saved.errors ?? 0,
    recent: Array.isArray(saved.recent) ? saved.recent.slice(-RECENT) : [],
    problemsClearedAt: saved.problemsClearedAt ?? null,
    updatedAt: at(),
  };

  // Problems cleared by `pch status --clear-problems` since this process last wrote
  // the file: keep only what was logged after, and count from those.
  function clearedSince(onDisk) {
    const cleared = onDisk?.problemsClearedAt;
    if (!cleared || cleared === data.problemsClearedAt) return;
    data.problemsClearedAt = cleared;
    data.recent = data.recent.filter((p) => p.at > cleared);
    data.warnings = data.recent.filter((p) => p.level !== "error").length;
    data.errors = data.recent.filter((p) => p.level === "error").length;
  }

  return {
    data,
    // A warning or error as it's logged.
    problem(level, msg, extra) {
      if (level === "error") data.errors += 1;
      else data.warnings += 1;
      data.recent.push({ at: at(), level, msg: String(redact(msg)).slice(0, 300), detail: detailOf(extra) });
      if (data.recent.length > RECENT) data.recent.splice(0, data.recent.length - RECENT);
    },
    // The components' counts since this process started (the status's relay,
    // watchdog and costSync), added to the totals before it.
    update(stats) {
      for (const c of COUNTERS) data.totals[c.key] = count(base[c.key]) + count(c.from(stats ?? {}));
      data.updatedAt = at();
    },
    save() {
      clearedSince(readJson(file, null));
      writeJson(file, data);
    },
  };
}

// `pch status --clear-problems`: empties the warnings and errors in the file and
// says when, so a running service drops its own at the next heartbeat (save above).
// The counts are left alone. Returns what was there, or null with no file yet.
export function clearProblems(config, { now = () => Date.now() } = {}) {
  const file = metricsFile(config);
  const saved = readJson(file, null);
  if (!saved) return null;
  writeJson(file, { ...saved, warnings: 0, errors: 0, recent: [], problemsClearedAt: new Date(now()).toISOString() });
  return { warnings: saved.warnings ?? 0, errors: saved.errors ?? 0 };
}

// Wraps the logger so every warning and error is counted and the latest kept.
export function watchProblems(log, metrics) {
  for (const level of ["warn", "error"]) {
    const write = log[level];
    log[level] = (msg, extra) => {
      write(msg, extra);
      try {
        metrics.problem(level, msg, extra);
      } catch {}
    };
  }
}

// Minutes of hand work the totals stand for, by the rough guesses above.
export function minutesSaved(totals) {
  return COUNTERS.reduce((sum, c) => sum + (c.minutes ?? 0) * count(totals?.[c.key]), 0);
}
