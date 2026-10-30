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
//
// The backstop (WATCHDOG_CI_BACKSTOP_MIN). An issue left in progress, owned by an
// agent, with no run and no monitor, has no live path for Paperclip's disposition
// guard: when the agent's run ends that way, Paperclip wakes it to "repair" the
// disposition, twice, then blocks the issue for the board ("unchanged_source_state_
// exhausted"). A comment naming a run isn't a live path; a scheduled monitor is. So
// while the run an agent waits on is still going, the watchdog gives its issue a
// Paperclip monitor of its own: one check, hours out (the run's worst case), whose
// notes name the run. The watchdog still reports the run when it finishes and clears
// the monitor in the same step; the monitor fires only if that report never comes.

import { listIssues } from "./paperclip.mjs";
import { ACTIVE_RUN, asleep, mapLimit, pausedRefusal, ts } from "./util.mjs";

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

// ---------------------------------------------------------------- the backstop monitor

// The watchdog's own monitor is told apart by its notes, which start with this
// (Paperclip stores a monitor's externalRef as "[redacted]", so the notes are also
// where the run is named), and by who scheduled it: a board key's monitor is
// scheduledBy "board".
export const BACKSTOP_MARK = "Paperclip Helper CI backstop";
export const isBackstop = (monitor) =>
  String(monitor?.notes ?? "").startsWith(BACKSTOP_MARK) && (monitor.scheduledBy == null || monitor.scheduledBy === "board");

// Paperclip's limits on a monitor: maxAttempts 1–100, notes up to 500 characters.
const MAX_MONITOR_ATTEMPTS = 100;
// Past nextCheckAt, a monitor whose timeoutAt has also passed is cleared instead of
// fired; the scheduler looks every 30 seconds, so this leaves it ample time to fire.
const BACKSTOP_TIMEOUT_MARGIN_MS = 30 * 60_000;

export function backstopNotes(run, { replaced = false } = {}) {
  const ref = run.html_url ?? `run ${run.id}`;
  return (
    `${BACKSTOP_MARK} for CI run ${ref}. It wakes the assignee once, at this check, only if the Helper misses the run finishing; ` +
    `the Helper reports the run and clears this monitor when it finishes.${replaced ? " It replaced the assignee's own monitor polling this run." : ""}`
  ).slice(0, 500);
}

// The monitor the watchdog schedules for a run (PATCH /api/issues/:id
// executionPolicy.monitor). One check: Paperclip strips a monitor from the policy
// when it fires. Its attempt count is the issue's, kept across every monitor ever
// scheduled on it, and a monitor whose maxAttempts that count already reaches is
// refused ("Monitor bounds are already exhausted"): maxAttempts is one more than the
// issue has used, or none past Paperclip's cap of 100 (the timeout still bounds it).
export function backstopMonitor({ run, now, backstopMs, attemptCount = 0, replaced = false }) {
  const next = now + backstopMs;
  const used = Math.max(0, Number(attemptCount) || 0);
  return {
    kind: "external_service",
    serviceName: "github",
    externalRef: run.html_url ?? String(run.id),
    nextCheckAt: new Date(next).toISOString(),
    timeoutAt: new Date(next + BACKSTOP_TIMEOUT_MARGIN_MS).toISOString(),
    ...(used + 1 <= MAX_MONITOR_ATTEMPTS ? { maxAttempts: used + 1 } : {}),
    recoveryPolicy: "wake_owner",
    notes: backstopNotes(run, { replaced }),
  };
}

// The attempts the issue's monitors have used, as Paperclip counts them.
export const monitorAttempts = (issue) =>
  Math.max(Number(issue?.monitorAttemptCount) || 0, Number(issue?.executionState?.monitor?.attemptCount) || 0);

// Does the monitor watch this run and nothing else? Every run its notes name is it.
export function watchesOnly(monitor, run) {
  const refs = runRefs(monitor?.notes);
  return refs.length > 0 && refs.every((r) => String(r.id) === String(run.id));
}

// An agent's own monitor on the run it waits on: its notes name that run and no
// other, or name no run at all on a GitHub service ("github", "GitHub Actions", "CI")
// while the agent's comment names the run.
const CI_SERVICE = /git\s*hub|actions|\bci\b/i;
export function agentCiMonitor(monitor, run) {
  if (!monitor || isBackstop(monitor)) return false;
  if (watchesOnly(monitor, run)) return true;
  return runRefs(monitor.notes).length === 0 && CI_SERVICE.test(String(monitor.serviceName ?? ""));
}

// It polls: its next check comes sooner than half the backstop would. Each check is
// a full run that finds the CI still going. One set as far out as the backstop is
// the agent's own backstop, and is left to stand for the watchdog's.
export const polls = (monitor, now, backstopMs) => ts(monitor?.nextCheckAt) - now < backstopMs / 2;

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

// ---------------------------------------------------------------- runner problems

// A job that failed setting up its runner, before checkout: GitHub's own "Set up
// runner" or "Set up job" step failed (a self-hosted runner's job-started hook that
// quarantines the machine, say, or a runner that can't start the job), so none of
// the PR's code ran. Every failed job of the run must look like that, on a known runner.
const SETUP_STEP = /^set up (runner|job)$/i;
export function failedBeforeCheckout(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const failed = steps.find((st) => FAILED.has(st?.conclusion));
  if (!failed || !SETUP_STEP.test(String(failed.name ?? "").trim()) || !job.runner_name) return false;
  return !steps.some((st) => /checkout/i.test(String(st?.name ?? "")) && st.conclusion === "success");
}

// The runner a run's failed jobs all failed to set up on, or null.
export function setupFailureRunner(jobs) {
  const failed = failedJobs(jobs);
  if (!failed.length || !failed.every(failedBeforeCheckout)) return null;
  const runners = new Set(failed.map((j) => j.runner_name));
  return runners.size === 1 ? failed[0].runner_name : null;
}

// What the agent is told instead of the usual report: the run never reached its code.
export function runnerProblemMessage({ run, runner }) {
  const name = run.name ?? run.display_title ?? "CI";
  const attempt = Number(run.run_attempt ?? 1);
  const label = `${name} run ${run.id}${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
  return [
    `the CI run you were waiting on failed before checkout, on runner \`${runner}\`: ${label} failed in GitHub's "Set up runner" step, ` +
      `so none of your change ran. ${run.html_url ?? ""}`.trim(),
    "",
    "Not your PR: other pull requests' jobs on that runner fail the same way, and the board has been told. " +
      "Don't change your code for it. Once the runner works again, start the run again (or push), and say which run you wait on.",
  ].join("\n");
}

// ---------------------------------------------------------------- the check (watchdog.mjs runs it each tick)

// Issues the CI-run check reads: an agent that waits on CI leaves its issue in
// any of these. Only those touched in the last few days: an older wait is stale.
const CI_STATUSES = "todo,in_progress,in_review,blocked";
const CI_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_BRANCH_TTL_MS = 60 * 60_000; // a renamed default branch is picked up within the hour
const CONCURRENCY = 4;
// Runner problems: other PRs' runs that failed the same way, looked for in the
// repository's failed runs of the last day (newest first, a page), jobs read for a few.
const RUNNER_LOOKBACK_MS = 24 * 60 * 60_000;
const RUNNER_RUNS_READ = 12;
const RUNNER_NOTE_EVERY_MS = 24 * 60 * 60_000;
// Backstops the watchdog schedules for one run on one issue, at most: an agent that
// keeps replacing the watchdog's monitor (or Paperclip that keeps refusing it) is
// left alone after that.
const BACKSTOPS_PER_RUN = 3;

// Check 11. From the watchdog: its records (keys from `record`), the GitHub client,
// `agentFor` (an agent by id, cached for the tick), `nudge` (its once-per-key
// comment that wakes the agent), `hasPendingWake` (a wake already on its way),
// `candidate` (an issue the watchdog may act on) and `startedRuns`.
export function createCiRunsCheck({ ctx, records, state, stats, dryRunSeen, record, github, agentFor, nudge, hasPendingWake, candidate, startedRuns, noteToBoard }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;
  const ciScanAt = new Map(); // companyId → when the CI runs agents wait on were last looked at
  const ciTexts = new Map(); // issueId → { companyId, updatedAt, refs } (the issue's updatedAt moves with every comment)
  const ciRuns = new Map(); // "repo#id" → finished run (with jobs), for one scan: a run can be re-run at any time
  const ciRepoOf = new Map(); // bare run id → the repository it was found in
  const ciMissing = new Set(); // "repo#id" (repo "*" for a bare id) found in none of GITHUB_REPOS
  const ciDefaultBranch = new Map(); // repo → { branch, at }: its default branch as GitHub last said
  const ciRepoWarned = new Set(); // repos whose default branch GitHub didn't give, warned once until it does
  const ciSilenced = new Map(); // CI record key → { companyId, reasons }: why a finished run isn't reported, as logged
  const ciRefused = new Set(); // repos whose runs the GitHub token may not read, warned once until it can
  const runnerScans = new Map(); // "repo|runner" → { failures, at }: other PRs' setup failures, for one scan
  const backstopMs = Math.max(0, Number(config.watchdogCiBackstopMin) || 0) * 60_000; // 0: no backstop
  const backstopSeen = new Map(); // issueId → { companyId, updatedAt, assignee }: settled by the backstop pass at that point
  const rerunPattern = (() => {
    if (!config.watchdogCiRerunJobs) return null;
    try {
      return new RegExp(config.watchdogCiRerunJobs, "i");
    } catch {
      return null; // config.mjs reports it
    }
  })();



  // The run behind a reference: { state: "missing" } (not in GITHUB_REPOS, or not
  // found), { state: "unknown" } (GitHub didn't answer), { state: "running", repo,
  // run }, or { state: "finished", repo, run, jobs } with the latest attempt's jobs.
  // Read once per scan (`fresh`: read again now): a finished run can be re-run (by
  // you, or an agent) at any time. Ids not found anywhere are remembered for the process.
  async function lookupRun(ref, { fresh = false } = {}) {
    if (ciMissing.has(`${ref.repo ?? "*"}#${ref.id}`)) return { state: "missing" };
    const repos = ref.repo ? [ref.repo] : ciRepoOf.has(ref.id) ? [ciRepoOf.get(ref.id)] : config.repos;
    for (const repo of repos) {
      if (config.repos.length && !config.repos.includes(repo)) continue;
      const cached = fresh ? null : ciRuns.get(`${repo}#${ref.id}`);
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
      let found = { state: "running", repo, run };
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

  // The repository's runs that failed setting up on this runner in the last day,
  // other than `run`'s own branch: [{ run, pr, at }]. Read once per scan and runner.
  async function setupFailuresOn(repo, runner, run) {
    const key = `${repo}|${runner}`;
    let scan = runnerScans.get(key);
    if (!scan) {
      const since = new Date(now() - RUNNER_LOOKBACK_MS).toISOString().replace(/\.\d+Z$/, "Z");
      const q = new URLSearchParams({ status: "failure", created: `>=${since}`, per_page: "50" });
      const data = await github.request("GET", `/repos/${repo}/actions/runs?${q}`).catch(() => null);
      const rows = (Array.isArray(data?.workflow_runs) ? data.workflow_runs : []).filter((r) => r.conclusion === "failure").slice(0, RUNNER_RUNS_READ);
      const failures = [];
      for (const r of rows) {
        const jobs = (ciRuns.get(`${repo}#${r.id}`)?.jobs) ?? (await github.workflowJobs(repo, r.id).catch(() => []));
        if (setupFailureRunner(jobs) !== runner) continue;
        failures.push({ run: r, jobs, pr: r.pull_requests?.[0]?.number ?? null, branch: r.head_branch ?? null, at: ts(r.created_at ?? r.run_started_at ?? r.updated_at) });
      }
      scan = { failures };
      runnerScans.set(key, scan);
    }
    return scan.failures.filter((f) => String(f.run.id) !== String(run.id) && (f.branch ?? f.pr) !== (run.head_branch ?? run.pull_requests?.[0]?.number));
  }

  // The first failure annotation of the jobs, if GitHub shows it ("Checks: Read").
  async function firstAnnotation(repo, jobs) {
    for (const job of failedJobs(jobs)) {
      const notes = await github.request("GET", `/repos/${repo}/check-runs/${job.id}/annotations?per_page=50`).catch(() => null);
      const failure = (Array.isArray(notes) ? notes : []).find((a) => a.annotation_level === "failure");
      if (failure?.message) return String(failure.message).split("\n")[0].slice(0, 300);
    }
    return null;
  }

  // A run that failed before checkout on a runner other PRs' jobs fail on too:
  // { runner } when it is, after telling the board once (a day) per runner; null otherwise.
  async function runnerProblem(found, companyId) {
    const { repo, run, jobs } = found;
    if (run.conclusion !== "failure") return null;
    const runner = setupFailureRunner(jobs);
    if (!runner) return null;
    const others = await setupFailuresOn(repo, runner, run);
    if (!others.length) return null; // one PR alone: reported as usual
    const key = `runner:${repo}:${runner}`;
    const prior = records.get(key);
    if ((!prior || now() - prior.at >= RUNNER_NOTE_EVERY_MS) && !dryRunSeen.has(key)) {
      // Claimed before anything else is awaited: issues are checked a few at a time.
      if (config.dryRun) dryRunSeen.add(key);
      else {
        records.set(key, { count: 1, at: now() });
        state.touch();
      }
      const all = [{ run, jobs, pr: run.pull_requests?.[0]?.number ?? null, branch: run.head_branch ?? null, at: ts(run.created_at ?? run.updated_at) }, ...others];
      const first = all.reduce((a, b) => (b.at && (!a.at || b.at < a.at) ? b : a));
      const prs = [...new Set(all.map((f) => (f.pr ? `PR #${f.pr}` : f.branch ? `\`${f.branch}\`` : null)).filter(Boolean))];
      const annotation = (await firstAnnotation(repo, first.jobs)) ?? (await firstAnnotation(repo, jobs));
      const when = first.at ? new Date(first.at).toISOString().slice(0, 16).replace("T", " ") + "Z" : "today";
      const text =
        `Runner \`${runner}\` (${repo}) fails jobs in "Set up runner", before checkout: ${all.length} runs on ${prs.length} pull requests have failed that way ` +
        `since ${when} (${prs.slice(0, 5).join(", ")}${prs.length > 5 ? ", …" : ""}). First error: ${annotation ?? "no annotation GitHub shows"}. ` +
        "That's the runner (its job-started hook, or the machine), not the PRs: the agents are told so, and nothing is re-run.";
      if (!config.dryRun) records.set(key, { count: 1, at: now(), since: first.at || null });
      stats.runnerProblems = (stats.runnerProblems ?? 0) + 1;
      await noteToBoard(companyId, text, { runner, repo, runs: all.length });
    }
    return { runner };
  }

  async function checkCiRuns(companyId, agents) {
    if (!github) return;
    await checkBackstops(companyId, agents);
    const last = ciScanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    ciScanAt.set(companyId, now());
    ciRuns.clear();
    runnerScans.clear();
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
    full ??= await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (!full || full.assigneeAgentId !== assignee) return;
    const monitor = full.executionState?.monitor;
    const monitorDue = monitorPending(monitor, now());
    // The watchdog's own backstop, or a monitor that watches this very run and nothing
    // else, is the agent's wait: it is cleared with the report, so nothing else will
    // notice the run finished. Report it now.
    const heldByMonitor = monitorDue && (isBackstop(monitor) || watchesOnly(monitor, run));
    // Otherwise give the agent's own monitor, or the agent, the stall window to notice.
    if (!finishedAt || (!heldByMonitor && now() - finishedAt < stallMs)) return silent("finished less than the stall window ago");
    // The agent wrote about the run after it finished: it watched it within its own run.
    if (cached.saidAt && ts(cached.saidAt) >= finishedAt) return silent("the agent commented after it finished");
    const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => null);
    if (!Array.isArray(runs)) return;
    if (runs.some((r) => ACTIVE_RUN.has(r.status))) return silent("a run on the issue is in progress");
    // The agent has run on the issue since the run finished: it has seen the result.
    if (startedRuns(runs).some((r) => r.agentId === assignee && ts(r.startedAt ?? r.createdAt) >= finishedAt)) {
      return silent("the agent has run on the issue since it finished");
    }
    // A monitor still due that watches this very run would only wake the agent again
    // to find it finished: report now, and clear the monitor in the same step. One
    // that watches something else is left to fire. (Paperclip redacts a monitor's
    // externalRef, so only its notes can name the run.) The watchdog's own backstop
    // for an earlier run is stale once the agent waits on this one: cleared too.
    if (monitorDue && !heldByMonitor) return silent("the agent's Paperclip monitor will still fire", { nextCheckAt: monitor.nextCheckAt });
    // A monitor Paperclip shows without the policy that holds it can't be cleared: leave it to fire.
    if (monitorDue && !full.executionPolicy?.monitor) return silent("the agent's monitor can't be cleared");
    // A wake still waiting gets the stall window to start a run. One older than
    // that may never be delivered (a monitor's own wake can sit deferred for
    // hours), and the comment's wake joins any that is: report anyway.
    if (await hasPendingWake(full, runs, agents, { freshWithin: stallMs })) return silent("a wake for the agent is waiting to start");
    // Failed setting up a runner other PRs' jobs fail on too: not the agent's to fix, and not re-run.
    const runnerIssue = await runnerProblem(found, companyId);
    if (runnerIssue) {
      const posted = await nudge(full, key, agent, runnerProblemMessage({ run, runner: runnerIssue.runner }), {
        reason: "CI run failed on its runner", repo: found.repo, run: run.id, runner: runnerIssue.runner,
      });
      if (posted) stats.ciReports += 1;
      return;
    }
    if (!dispatchedOnDefault && (await rerunFlaky(found, issue))) return;
    // Pushed since: that push's own run is what counts now.
    if (!dispatchedOnDefault && (await headMoved(found.repo, run)) === true) return silent("its branch or pull request has moved on");
    const reruns = records.get(record.ciRerun(found.repo, run))?.count ?? 0;
    // The policy is replaced whole: read it again now, so nothing changed meanwhile is overwritten.
    let clearMonitor;
    let cleared = null; // the monitor cleared with the report
    if (monitorDue) {
      const fresh = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
      const freshMonitor = fresh?.executionState?.monitor;
      const freshHeld = isBackstop(freshMonitor) || watchesOnly(freshMonitor, run);
      if (!fresh || (monitorPending(freshMonitor, now()) && (!freshHeld || !fresh.executionPolicy?.monitor))) {
        return silent("the agent's monitor changed while the report was prepared");
      }
      if (monitorPending(freshMonitor, now())) {
        clearMonitor = withoutMonitor(fresh.executionPolicy);
        cleared = freshMonitor;
      }
    }
    const backstopKey = record.ciBackstop(issue);
    const replaced = Boolean(records.get(backstopKey)?.replaced);
    const posted = await nudge(
      full,
      key,
      agent,
      ciMessage({ run, jobs: found.jobs, reruns }),
      { reason: "CI run finished", repo: found.repo, run: run.id, conclusion: run.conclusion, ...(cleared && isBackstop(cleared) ? { backstopCleared: true } : {}) },
      clearMonitor !== undefined ? { patch: { executionPolicy: clearMonitor }, patchNote: clearedNote(cleared, replaced) } : {},
    );
    if (posted) {
      stats.ciReports += 1;
      if (cleared && isBackstop(cleared) && records.has(backstopKey)) {
        records.delete(backstopKey);
        state.touch();
      }
    }
  }

  // What the report adds when it clears a monitor.
  function clearedNote(monitor, replaced) {
    if (!isBackstop(monitor)) return "\n\nYour Paperclip monitor for this run was cleared: it would only have woken you to find the run finished.";
    return (
      "\n\nThe Helper's backstop monitor for this run was cleared." +
      (replaced
        ? " It had replaced your own monitor polling the run: to wait on CI, name the run in your last comment and end your run, " +
          "without a monitor; the Helper keeps one for you and wakes you when the run finishes."
        : "")
    );
  }

  // The issue's execution policy without its monitor (Paperclip replaces the policy
  // whole and clears the monitor when it's gone); undefined when there's no policy.
  function withoutMonitor(policy) {
    if (!policy?.monitor) return undefined;
    const { monitor: _cleared, ...rest } = policy;
    return rest;
  }

  // ---------------------------------------------------------------- the backstop, every tick

  // Every tick, not once per stall window: Paperclip's disposition guard looks at the
  // issue the moment the agent's run ends, and the sooner the backstop stands, the
  // fewer repair wakes. Each issue is read again only once it has changed (its
  // updatedAt moves with every comment, run and monitor change), and its run looked
  // up once then.
  async function checkBackstops(companyId, agents) {
    if (!backstopMs) return;
    const issues = (await listIssues(api, companyId, CI_STATUSES)).filter(
      (i) => i.assigneeAgentId && now() - ts(i.updatedAt) < CI_LOOKBACK_MS,
    );
    const live = new Set(issues.map((i) => i.id));
    for (const [id, seen] of backstopSeen) if (seen.companyId === companyId && !live.has(id)) backstopSeen.delete(id);
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      try {
        await backstopIssue(issue, agents, companyId);
      } catch (err) {
        log.warn("watchdog: CI backstop check failed", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
  }

  async function backstopIssue(issue, agents, companyId) {
    const seen = backstopSeen.get(issue.id);
    if (seen && seen.updatedAt === issue.updatedAt && seen.assignee === issue.assigneeAgentId) return;
    const settle = () => backstopSeen.set(issue.id, { companyId, updatedAt: issue.updatedAt, assignee: issue.assigneeAgentId });
    const key = record.ciBackstop(issue);
    let mine = records.get(key);
    // Only an issue in progress needs one (the guard looks at todo and in progress,
    // and Paperclip takes a monitor only in progress or in review). Paperclip clears a
    // monitor itself when the issue moves to todo, blocked, done or cancelled; one left
    // on an issue now in review, or now another agent's, would wake the wrong run.
    if (issue.status !== "in_progress" || (mine && mine.agentId !== issue.assigneeAgentId)) {
      if (mine && !(await tidyBackstop(issue, key, issue.status !== "in_progress" ? `the issue is ${issue.status}` : "the issue changed hands"))) return;
      if (issue.status !== "in_progress") return settle();
      mine = undefined; // gone with the previous owner's backstop; the new owner may wait on CI too
    }
    const assignee = issue.assigneeAgentId;
    const comments = await api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=10`).catch(() => null);
    if (!Array.isArray(comments)) return;
    const full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (!full) return;
    if (full.status !== "in_progress" || full.assigneeAgentId !== assignee || full.assigneeUserId) return settle();
    const monitor = full.executionState?.monitor;
    // What the agent said it waits on. The watchdog's own notes don't count: the
    // agent's comments decide which run its wait is.
    const said = waitingOn(comments, assignee, isBackstop(monitor) ? null : monitor);
    const refs = runRefs(said.text);
    if (!refs.length) return settle();
    const agent = await agentFor(assignee, agents).catch(() => null);
    if (!agent || asleep(agent)) return settle();
    // The newest run named that is in GITHUB_REPOS, read now: one that has already
    // finished needs no backstop (the report is on its way).
    let found = null;
    for (const ref of refs) {
      const r = await lookupRun(ref, { fresh: true });
      if (r.state === "missing") continue;
      if (r.state === "unknown") return; // GitHub didn't answer: next tick
      found = r;
      break;
    }
    if (!found || found.state !== "running") return settle();
    const { run } = found;
    const runKey = `${found.repo}#${run.id}`;
    const pending = monitorPending(monitor, now());
    let replaced = false;
    if (pending && isBackstop(monitor)) {
      if (watchesOnly(monitor, run)) {
        // Already standing (a restart forgot the record: take it up again).
        if (!mine || mine.run !== runKey) {
          records.set(key, { count: 1, at: now(), run: runKey, agentId: assignee, replaced: Boolean(mine?.replaced) });
          state.touch();
        }
        return settle();
      }
      // The watchdog's backstop for an earlier run: moved to this one below.
    } else if (pending) {
      // The agent's own monitor. Left alone unless it polls the run it waits on.
      if (!agentCiMonitor(monitor, run) || !polls(monitor, now(), backstopMs) || !full.executionPolicy?.monitor) return settle();
      replaced = true;
    }
    const count = mine?.run === runKey ? (mine.count ?? 0) : 0;
    const extra = { issue: issue.identifier ?? issue.id, agent: agent.name, repo: found.repo, run: run.id, ...(replaced ? { replaced: "the agent's polling monitor" } : {}) };
    if (count >= BACKSTOPS_PER_RUN) {
      if (count === BACKSTOPS_PER_RUN) {
        records.set(key, { ...mine, count: count + 1, at: now() });
        state.touch();
        log.warn("watchdog: the CI backstop monitor keeps being replaced or refused; the issue is left to Paperclip", extra);
      }
      return settle();
    }
    if (config.dryRun) {
      const seenKey = `${key}:${runKey}`;
      if (!dryRunSeen.has(seenKey)) {
        dryRunSeen.add(seenKey);
        log("watchdog: would schedule a CI backstop monitor (dry run)", extra);
      }
      return settle();
    }
    // The policy is replaced whole: read it again now, so nothing changed meanwhile
    // is overwritten, and act only on the monitor seen above.
    const fresh = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (!fresh || fresh.status !== "in_progress" || fresh.assigneeAgentId !== assignee) return;
    if (!sameMonitor(fresh.executionState?.monitor, monitor)) return; // next tick
    const next = backstopMonitor({ run, now: now(), backstopMs, attemptCount: monitorAttempts(fresh), replaced });
    records.set(key, { count: count + 1, at: now(), run: runKey, agentId: assignee, replaced: replaced || (mine?.run === runKey && Boolean(mine?.replaced)) });
    state.touch();
    try {
      await api.request("PATCH", `/api/issues/${issue.id}`, { executionPolicy: { ...(fresh.executionPolicy ?? {}), monitor: next } });
    } catch (err) {
      if (pausedRefusal(err)) {
        records.set(key, { ...records.get(key), count }); // a paused task: not a try used up
        log.debug("watchdog: the issue is paused; CI backstop postponed", extra);
        return;
      }
      log.warn("watchdog: Paperclip refused the CI backstop monitor", { ...extra, error: err.message });
      return;
    }
    stats.ciBackstops = (stats.ciBackstops ?? 0) + 1;
    log("watchdog: scheduled a CI backstop monitor", { ...extra, nextCheckAt: next.nextCheckAt, maxAttempts: next.maxAttempts ?? null });
  }

  // Clears the watchdog's backstop from an issue it no longer fits, without a comment
  // (a comment would wake the assignee). True once nothing of it is left.
  async function tidyBackstop(issue, key, why) {
    const full = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (!full) return false;
    const monitor = full.executionState?.monitor;
    if (monitorPending(monitor, now()) && isBackstop(monitor) && full.executionPolicy?.monitor) {
      const extra = { issue: issue.identifier ?? issue.id, reason: why };
      if (config.dryRun) {
        if (!dryRunSeen.has(`${key}:tidy`)) {
          dryRunSeen.add(`${key}:tidy`);
          log("watchdog: would clear its CI backstop monitor (dry run)", extra);
        }
        return false;
      }
      try {
        await api.request("PATCH", `/api/issues/${issue.id}`, { executionPolicy: withoutMonitor(full.executionPolicy) ?? null });
      } catch (err) {
        if (!pausedRefusal(err)) log.warn("watchdog: couldn't clear its CI backstop monitor", { ...extra, error: err.message });
        return false;
      }
      log("watchdog: cleared its CI backstop monitor", extra);
    }
    records.delete(key);
    state.touch();
    return true;
  }

  const sameMonitor = (a, b) =>
    (a?.status ?? null) === (b?.status ?? null) && (a?.nextCheckAt ?? null) === (b?.nextCheckAt ?? null) && (a?.notes ?? null) === (b?.notes ?? null);

  return { check: checkCiRuns };
}
