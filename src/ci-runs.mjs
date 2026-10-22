// GitHub Actions runs an agent is waiting on (watchdog, 11).
//
// An agent that pushes and waits for CI usually says so ("waiting on run
// 39498202022", a link to the run) and stops, or schedules a Paperclip monitor
// to look again later. Monitors give up after a timeout or a number of attempts,
// and a run that queues behind others (one self-hosted runner, a busy org) can
// finish long after that. Nothing then wakes the agent: the issue sits blocked
// or in progress with CI long since green or red. The watchdog reads the run
// the agent named, and once it has finished, and the agent hasn't run on the
// issue since, comments with the result, which wakes the agent.
//
// Optionally (WATCHDOG_CI_RERUN_JOBS) a failed run whose failed jobs all match a
// pattern you know to be flaky is re-run first, a few times per run, and only
// reported once an attempt passes or the re-runs are used up.

import { ts } from "./util.mjs";

// Runs are referred to by id (11 digits today) or by URL. A bare number needs at
// least 9 digits and a word that says it's a run, so a PR or issue number never
// matches.
const RUN_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/gi;
// "check run 4123…" is a check run (another id space), not a workflow run.
const RUN_WORD = /(?<!check[\s-])\b(?:workflow\s+run|CI\s+run|run(?:\s+id)?|runs)\s*[#:/]?\s*(\d{9,})\b/gi;
const MAX_REFS = 3;

// The runs a piece of text names, newest first (run ids only grow), as
// { repo, id }: repo is "owner/name" (lower case) for a URL, null for a bare id.
// "The failure in run A is fixed; waiting on run B": B is the one waited on.
export function runRefs(text) {
  const out = [];
  const seen = new Set();
  const s = String(text ?? "");
  const add = (repo, id) => {
    if (seen.has(id) || out.length >= MAX_REFS) return;
    seen.add(id);
    out.push({ repo, id });
  };
  const found = [];
  for (const m of s.matchAll(RUN_URL)) found.push([m[1].toLowerCase(), m[2]]);
  for (const m of s.matchAll(RUN_WORD)) found.push([null, m[1]]);
  found.sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : BigInt(b[1]) < BigInt(a[1]) ? -1 : 0));
  for (const [repo, id] of found) add(repo, id);
  return out;
}

// The text an agent wrote about what it waits on: its latest comment on the issue
// and the notes of a Paperclip monitor it scheduled (the monitor's externalRef is
// redacted when read, its notes aren't). `comments` are newest first.
export function waitingText(comments, agentId, monitor) {
  return waitingOn(comments, agentId, monitor).text;
}

// The same, with when the agent said it: a comment written after the run finished
// means the agent saw the result (it watched the run within its own run).
//
// An agent often names the run once and follows up without repeating it
// ("blocked on run X", then "cleared a dependency; still waiting on CI"). When
// its latest comment names no run, its most recent one that does counts. When it
// spoke is still its latest comment, so a run that finished before the agent last
// spoke is never reported: it may have seen the result.
export function waitingOn(comments, agentId, monitor) {
  const mine = (Array.isArray(comments) ? comments : []).filter((c) => c?.authorAgentId === agentId);
  const named = mine.find((c) => runRefs(c.body).length > 0) ?? mine[0];
  return { text: [named?.body ?? "", monitor?.notes ?? ""].join("\n"), saidAt: mine[0]?.createdAt ?? null };
}

// Conclusions that say nothing about the change: a run cancelled (often by a newer
// push), skipped, or waiting on someone's approval. Not reported.
export const UNINFORMATIVE = new Set(["cancelled", "skipped", "neutral", "action_required", "stale"]);

// A Paperclip monitor that will still wake the agent by itself: leave it to that.
// Only a scheduled monitor fires. A triggered one has fired and waits for the
// agent to schedule it again, and a cleared one is done, so neither wakes anyone
// by itself. A scheduled one acts when its next check comes (or only just came:
// Paperclip's scheduler looks every 30 seconds by default). Past its timeout or
// out of attempts, it is cleared then instead of fired, and wakes the agent only
// under the default recovery policy, wake_owner (issue_monitor_recovery); the
// others tell the board instead. (dispatchClaimedIssueMonitor and
// issueMonitorLimitClearReason, server/src/services/heartbeat/scheduling.ts)
const MONITOR_GRACE_MS = 2 * 60_000;
export function monitorPending(monitor, now) {
  if (monitor?.status !== "scheduled") return false;
  const next = ts(monitor.nextCheckAt);
  if (!next || next + MONITOR_GRACE_MS <= now) return false;
  const timeout = ts(monitor.timeoutAt);
  const max = Number(monitor.maxAttempts);
  const spent = Boolean(timeout && timeout <= next) || (max > 0 && Number(monitor.attemptCount ?? 0) + 1 > max);
  return !spent || (monitor.recoveryPolicy ?? "wake_owner") === "wake_owner";
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
export const failedJobs = (jobs) => (Array.isArray(jobs) ? jobs : []).filter((j) => FAILED.has(j?.conclusion));

// Only the flaky jobs failed, so a re-run may pass: every failed job's name
// matches the pattern, and there is at least one.
export function onlyFlaky(jobs, pattern) {
  const failed = failedJobs(jobs);
  return Boolean(pattern) && failed.length > 0 && failed.every((j) => pattern.test(String(j.name ?? "")));
}

// What the comment says about the run. Plain text plus the run's own link (an
// Actions URL, which Paperclip doesn't take for a pull request).
export function ciMessage({ run, jobs, reruns = 0 }) {
  const name = run.name ?? run.display_title ?? "CI";
  const attempt = Number(run.run_attempt ?? 1);
  const label = `${name} run ${run.id}${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
  const where = [run.head_branch ? `\`${run.head_branch}\`` : null, run.head_sha ? `\`${String(run.head_sha).slice(0, 9)}\`` : null]
    .filter(Boolean)
    .join(" at ");
  const conclusion = run.conclusion ?? "finished";
  const noVerdict = UNINFORMATIVE.has(conclusion);
  const lines = [
    `the CI run you were waiting on has finished, and you haven't run on this issue since: ${label}${where ? ` on ${where}` : ""} ` +
      `finished ${new Date(ts(run.updated_at)).toISOString().replace(/\.\d+Z$/, "Z")} with **${conclusion}**. ${run.html_url ?? ""}`.trim(),
  ];
  const failed = failedJobs(jobs);
  if (failed.length) {
    const names = failed.slice(0, 10).map((j) => `\`${j.name}\``).join(", ");
    lines.push("", `Failed jobs: ${names}${failed.length > 10 ? `, and ${failed.length - 10} more` : ""}.`);
  }
  if (reruns) lines.push("", `The watchdog re-ran its failed jobs ${reruns === 1 ? "once" : `${reruns} times`} first, as jobs known to be flaky.`);
  lines.push(
    "",
    conclusion === "success"
      ? "Please continue from where you were waiting on it (resubmit, or carry on with the next step)."
      : noVerdict
        ? "It gave no verdict on the change. If you still need one, start it again (or a new run), and say which run you wait on; otherwise continue."
        : "Please look at the failed jobs and continue: fix what your change broke, or say why it isn't yours.",
  );
  return lines.join("\n");
}
