// Relay: pull requests the merge queue drops for something other than a conflict
// with their base branch.
//
// GitHub's merge queue tests each queued PR on a temporary branch
// (`gh-readonly-queue/<base>/pr-<n>-<sha>`, workflow runs with event
// `merge_group`) and removes the PR when that goes wrong: `pull_request.dequeued`,
// sent by github-merge-queue[bot], with a `reason` such as CI_FAILURE, CI_TIMEOUT
// or MERGE_CONFLICT. This decides:
//
//   * CI_FAILURE with a failed merge-group job: the PR is at fault, so it is sent
//     back like a conflict, with the run, the failed jobs and the first failure
//     annotation;
//   * CI_FAILURE whose failed jobs all failed setting up their runner, before
//     checkout ("Set up runner": a self-hosted runner's job-started hook, say): none
//     of the PR's code ran, so the board is told and the PR isn't sent back or
//     queued again (it would fail the same way on that runner);
//   * CI_FAILURE with only a cancelled job (a runner restarted), or CI_TIMEOUT (the
//     queue's status-check timeout ran out while the runs waited for a runner): the
//     PR isn't at fault. The board is told, without waking the implementer, and with
//     RELAY_REQUEUE_ON_INFRA_DROP the relay queues it again, once per head commit,
//     only if a person queued it;
//   * MERGE_CONFLICT: a conflict with the base branch is the conflict sweep's
//     (conflicts.mjs); a conflict only with a PR ahead in the queue is told to the
//     board;
//   * any other reason (removed by hand, branch protections, the queue cleared): left
//     alone. Without a reason (an older GitHub Enterprise Server), the runs decide.
//
// Once per merge-group commit. Needs a GitHub token with "Actions: Read" (and
// "Checks: Read" for the annotation).

import { CLOSED_STATUSES, prLabel, RELAYED_SIGNATURE, signed } from "./util.mjs";
import { findIdentifiers } from "./identifiers.mjs";
import { noteToBoard } from "./board-note.mjs";
import { setupFailureRunner } from "./ci-runs.mjs";

export const QUEUE_BOT = "github-merge-queue[bot]";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const CANCELLED = new Set(["cancelled"]);
const RUN_PAGE = 100;


// The merge group's branch for one PR into one base.
const queueBranchPrefix = (base, number) => `gh-readonly-queue/${base}/pr-${number}-`;

// The runs of the PR's latest merge group: every workflow run on the newest
// merge-group commit for that PR. [] when there are none.
export function latestGroupRuns(runs, base, number) {
  const prefix = queueBranchPrefix(base, number);
  const mine = (Array.isArray(runs) ? runs : []).filter((r) => String(r.head_branch ?? "").startsWith(prefix));
  if (!mine.length) return [];
  const newest = mine.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
  return mine.filter((r) => r.head_sha === newest.head_sha);
}

// What dropped the PR, from its latest merge group's runs and their jobs:
// { kind: "failed", run, jobs } | { kind: "runner", run, jobs, runner } | { kind: "cancelled", run, jobs } | { kind: "timeout", runs }.
export function classifyDrop(groupRuns) {
  for (const run of groupRuns) {
    const failed = (run.jobs ?? []).filter((j) => FAILED.has(j.conclusion));
    const runner = failed.length ? setupFailureRunner(run.jobs) : null;
    if (runner) return { kind: "runner", run, jobs: failed, runner };
    if (failed.length || (FAILED.has(run.conclusion) && !(run.jobs ?? []).length)) return { kind: "failed", run, jobs: failed };
  }
  for (const run of groupRuns) {
    const cancelled = (run.jobs ?? []).filter((j) => CANCELLED.has(j.conclusion));
    if (cancelled.length || CANCELLED.has(run.conclusion)) return { kind: "cancelled", run, jobs: cancelled };
  }
  return { kind: "timeout", runs: groupRuns };
}

function failureBrief(pr, { run, jobs }, annotation) {
  const base = pr.base?.ref ?? "the base branch";
  const lines = [
    `Changes requested on ${prLabel(pr)}: a merge-queue check failed`,
    "",
    `The merge queue tested ${prLabel(pr)} combined with \`${base}\` and the PRs ahead of it, and removed it because a check failed: ${run.html_url ?? `run ${run.id}`}`,
  ];
  if (jobs.length) lines.push("", `Failed: ${jobs.map((j) => `\`${j.name}\``).join(", ")}.`);
  if (annotation) lines.push("", "First failure:", "", ...String(annotation).split("\n").slice(0, 20).map((l) => `> ${l}`));
  lines.push(
    "",
    `The PR's own CI may have passed: the queue runs on the combined change. Reproduce it against the latest \`origin/${base}\`, fix it on the same branch and push. Don't open a new pull request. Once it's fixed, the PR goes back to the queue.`,
  );
  return signed(lines.join("\n"));
}

function infraNote(pr, drop, requeued = false) {
  if (drop.kind === "runner") {
    return (
      `${prLabel(pr)} was dropped from the merge queue because its merge-group jobs failed setting up runner \`${drop.runner}\` ("Set up runner"), ` +
      `before checkout: none of the PR's code ran. Fix the runner, then queue it again.${drop.run.html_url ? `\n\n${drop.run.html_url}` : ""}\n\n${pr.html_url}`
    );
  }
  const cause =
    drop.kind === "cancelled"
      ? `a cancelled run${drop.jobs.length ? ` (${drop.jobs.map((j) => `\`${j.name}\``).join(", ")} cancelled)` : ""}, which is usually a runner restarting`
      : "the queue's status-check timeout: its merge-group checks didn't all report in time (a busy or single runner)";
  const link = drop.kind === "cancelled" ? drop.run.html_url : drop.runs[0]?.html_url;
  return (
    `${prLabel(pr)} was dropped from the merge queue by ${cause}, not by the PR. ${requeued ? "The relay has queued it again." : "Queue it again."}` +
    `${link ? `\n\n${link}` : ""}\n\n${pr.html_url}`
  );
}

const CLOSED = CLOSED_STATUSES;
// Merge-group runs are listed from this far back: a queue's timeout is an hour by default.
const RUN_LOOKBACK_MS = 12 * 60 * 60_000;
const RUN_PAGES = 5;

// What GitHub's reason says: "failure", "timeout", "conflict", "other", or null with no reason.
export function dropReason(reason) {
  if (!reason) return null;
  if (/fail/i.test(reason)) return "failure";
  if (/time[_\s-]*out/i.test(reason)) return "timeout";
  if (/conflict/i.test(reason)) return "conflict";
  return "other";
}

export function createMergeQueueHandler({ ctx, state, github, decisions, sweepConflicts }) {
  const { config, log, api } = ctx;
  const records = state.queue;
  const stats = { dropped: 0, sentBack: 0, noted: 0, requeued: 0, lastError: null };

  // Who queued the PR last, from pull_request.enqueued (kept in the state file).
  function enqueued(repo, payload) {
    records.set(`enqueued:${repo}#${payload.pull_request?.number}`, { login: payload.sender?.login ?? null, at: ctx.now() });
    state.touch();
  }

  // The PR's latest merge group's runs, with their jobs, from the runs of the last
  // few hours (several pages: the list holds every PR's merge-group runs).
  async function groupRuns(repo, base, number) {
    const since = new Date(ctx.now() - RUN_LOOKBACK_MS).toISOString().replace(/\.\d+Z$/, "Z");
    const all = [];
    for (let page = 1; page <= RUN_PAGES; page += 1) {
      const q = new URLSearchParams({ event: "merge_group", created: `>=${since}`, per_page: String(RUN_PAGE), page: String(page) });
      const data = await github.request("GET", `/repos/${repo}/actions/runs?${q}`);
      const rows = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
      all.push(...rows);
      if (rows.length < RUN_PAGE) break;
    }
    const runs = latestGroupRuns(all, base, number);
    for (const run of runs) run.jobs = await github.workflowJobs(repo, run.id).catch(() => []);
    return runs;
  }

  // The first failure annotation of a failed job, if GitHub shows it ("Checks: Read").
  async function firstAnnotation(repo, jobs) {
    for (const job of jobs) {
      const notes = await github.request("GET", `/repos/${repo}/check-runs/${job.id}/annotations?per_page=50`).catch(() => null);
      const failure = (Array.isArray(notes) ? notes : []).find((a) => a.annotation_level === "failure");
      if (failure?.message) return failure.message;
    }
    return null;
  }

  // Queues the PR again (GraphQL enqueuePullRequest): only if a person queued it,
  // once per head commit.
  async function requeue(repo, pr) {
    const who = records.get(`enqueued:${repo}#${pr.number}`)?.login;
    if (!who || /\[bot\]$/i.test(who)) return { requeued: false, reason: who ? "queued by a bot" : "not seen being queued by a person" };
    const key = `requeue:${repo}#${pr.number}:${pr.head?.sha}`;
    if (records.has(key)) return { requeued: false, reason: "already queued again once for this commit" };
    records.set(key, { at: ctx.now() });
    state.touch();
    try {
      await github.graphql("mutation($id: ID!) { enqueuePullRequest(input: { pullRequestId: $id }) { mergeQueueEntry { id } } }", { id: pr.node_id });
    } catch (err) {
      log.warn("relay: couldn't queue the PR again (the token must be allowed to merge)", { repo, pr: pr.number, error: err.message });
      return { requeued: false, reason: err.message };
    }
    stats.requeued += 1;
    return { requeued: true };
  }

  // A note for the board that wakes nobody: on the issue only while no agent is
  // assigned (it waits on a person), else on the PR and in the board notes
  // (board-note.mjs), since a board comment wakes the issue's agent.
  async function tellBoard(repo, pr, issue, text) {
    if (!issue.assigneeAgentId) return decisions.addComment(issue.identifier ?? issue.id, text);
    if (config.dryRun) return { identifier: issue.identifier, action: "note (dry run)" };
    await github
      .helperComment(repo, pr.number, text)
      .catch((err) => log.warn("relay: could not comment on the PR", { repo, pr: pr.number, error: err.message }));
    await noteToBoard({ api, config, log }, issue.companyId, `${issue.identifier}: ${text}`, { source: "relay", signature: RELAYED_SIGNATURE });
    return { identifier: issue.identifier, action: "note on the PR" };
  }

  async function handle(repo, payload) {
    const number = payload.pull_request?.number;
    const why = dropReason(payload.reason);
    if (why === "other") return { ignored: `removed from the merge queue: ${payload.reason}` };
    const pr = await github.pull(repo, number);
    if (pr?.merged || pr?.state !== "open") return { ignored: `${prLabel(payload.pull_request)} is ${pr?.merged ? "merged" : pr?.state}` };
    const conflictsWithBase = pr.mergeable === false || pr.mergeable_state === "dirty";
    if (conflictsWithBase) {
      // The conflict sweep sends it back, as for any conflicting PR.
      sweepConflicts?.(repo, pr.base?.ref);
      return { pr: number, drop: "conflict" };
    }
    const identifiers = findIdentifiers(pr, ctx.prefixes());
    if (!identifiers.length) return { ignored: `${prLabel(pr)} names no Paperclip issue` };

    const runs = why === "conflict" ? [] : await groupRuns(repo, pr.base?.ref, number);
    const drop = why === "conflict" ? { kind: "queue-conflict" } : why === "timeout" ? { kind: "timeout", runs } : classifyDrop(runs);
    // Asked to say what failed, but no failed or cancelled job to show for it: say so rather than guess.
    if (why === "failure" && drop.kind === "timeout") drop.kind = "unexplained";
    if (why === null && !runs.length) return { ignored: `no reason given and no merge-group run found for ${prLabel(pr)}` };
    const key = `drop:${repo}#${number}:${runs[0]?.head_sha ?? pr.head?.sha}:${drop.kind}`;
    if (records.has(key)) return { pr: number, drop: drop.kind, action: "skip", reason: "already handled for this merge group" };
    const out = { pr: number, drop: drop.kind, reason: payload.reason ?? null };

    const target = await decisions.resolveTarget(pr, identifiers, drop.kind === "failed" ? {} : { own: true });
    if (!target) return { ...out, action: "skip", reason: `no Paperclip issue found for ${identifiers.join(", ")}` };
    const issue = target.issue;
    if (!target.waiting && CLOSED.has(issue.status)) return { ...out, action: "skip", reason: `${issue.identifier} is ${issue.status}` };
    stats.dropped += 1;
    const record = (result) => {
      if (config.dryRun) return;
      records.set(key, { at: ctx.now(), kind: drop.kind, issue: result.identifier });
      state.touch();
    };

    if (drop.kind === "failed") {
      const annotation = await firstAnnotation(repo, drop.jobs);
      const result = await decisions.decide({ pr, identifiers, kind: "changes", comment: failureBrief(pr, drop, annotation), target });
      record(result);
      if (config.dryRun) return { ...out, ...result };
      stats.sentBack += 1;
      if (config.conflictPrComment) {
        const how = result.action === "changes" ? `${result.identifier} was returned to its agent with changes requested` : `a comment on ${result.identifier} asked its agent to fix it`;
        await github
          .helperComment(repo, number, `**Sent back: a merge-queue check failed.** ${how}. ${drop.run.html_url ?? ""}`.trim())
          .catch((err) => log.warn("relay: could not comment on the PR", { repo, pr: number, error: err.message }));
      }
      return { ...out, identifier: result.identifier, action: result.action };
    }

    // Not the PR's fault, or nothing to show: tell the board, and optionally queue it again.
    // A runner that fails every job's set-up would fail the queued PR again: not queued again.
    const infra = drop.kind === "cancelled" || drop.kind === "timeout";
    const again = infra && config.relayRequeueOnInfraDrop && !config.dryRun ? await requeue(repo, pr) : null;
    const note =
      drop.kind === "queue-conflict"
        ? `${prLabel(pr)} was dropped from the merge queue for a conflict with a PR ahead of it, not with \`${pr.base?.ref}\`. Queue it again once that PR has merged${sweepConflicts ? "; if it then conflicts, it is sent back to its agent" : ""}.\n\n${pr.html_url}`
        : drop.kind === "unexplained"
          ? `${prLabel(pr)} was dropped from the merge queue for a failed check (${payload.reason}), but no failed or cancelled merge-group job was found for it. Look at the PR's checks, then queue it again or send it back.\n\n${pr.html_url}`
          : infraNote(pr, drop, again?.requeued);
    const result = await tellBoard(repo, pr, issue, note);
    record(result);
    if (!config.dryRun) stats.noted += 1;
    return { ...out, identifier: result.identifier, action: result.action, ...(again ? { requeued: again.requeued } : {}) };
  }

  return { handle, enqueued, stats };
}
