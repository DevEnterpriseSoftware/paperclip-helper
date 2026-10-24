// PRs ready to queue: watchdog 19 (WATCHDOG_REPORT_READY_TO_MERGE, off by default)
// and `pch ready`.
//
// When the board pauses its agents to save usage and resumes a reviewer for one
// review, nothing says when that review has passed: the issue moves to the
// board's approval stage and waits. A PR is ready to queue when:
//
//   * its issue waits on your approval stage (in review, the pending stage is an
//     approval and its participant is you) with every stage before it completed;
//   * the PR (a PR work product of the issue, or a PR the relay noted on it, in
//     GITHUB_REPOS) is open, not a draft, and GitHub calls it mergeable and
//     "clean": no conflict, and every required check green (whatever the
//     repository's branch protection or ruleset requires).
//
// The watchdog tells the board once per PR head commit, on the issue itself (it
// waits on a person, so the comment wakes no agent), naming the agents that
// reviewed it and whether each still has open work, so you know which you can
// pause again. `pch ready` lists them all, in queue order: an issue after any
// issue it is blocked by, then the oldest PR first.

import { listIssues } from "./paperclip.mjs";
import { approvalWaitingOn, asleep, mapLimit, plural, ts, WATCHDOG_SIGNATURE } from "./util.mjs";
import { prRefs } from "./stages.mjs";
import { notesText } from "./quiet-notes.mjs";
import { noteToBoard } from "./board-note.mjs";

const OPEN = "todo,in_progress,in_review,blocked";
const CONCURRENCY = 4;

// Every stage before the pending one is completed (or the issue doesn't say otherwise).
export function earlierStagesDone(issue) {
  const stages = Array.isArray(issue?.executionPolicy?.stages) ? issue.executionPolicy.stages : [];
  const state = issue?.executionState;
  if (!stages.length || !state) return true;
  let index = Number.isInteger(state.currentStageIndex) ? state.currentStageIndex : stages.findIndex((s) => s.id === state.currentStageId);
  if (index < 0) return true;
  const done = new Set(Array.isArray(state.completedStageIds) ? state.completedStageIds : []);
  return stages.slice(0, index).every((s) => !s.id || done.has(s.id));
}

// The agents named as participants of the issue's stages before the pending one: its reviewers.
export function reviewersOf(issue) {
  const stages = Array.isArray(issue?.executionPolicy?.stages) ? issue.executionPolicy.stages : [];
  const state = issue?.executionState;
  const index = Number.isInteger(state?.currentStageIndex) ? state.currentStageIndex : stages.findIndex((s) => s.id === state?.currentStageId);
  const before = index >= 0 ? stages.slice(0, index) : stages.filter((s) => s.type !== "approval");
  const ids = new Set();
  for (const s of before) for (const p of Array.isArray(s.participants) ? s.participants : []) if (p?.type === "agent" && p.agentId) ids.add(p.agentId);
  return [...ids];
}

// An issue whose approval waits on you, past every earlier stage.
export const atYourApproval = (issue, userId) =>
  approvalWaitingOn(issue, userId) && issue.executionState?.currentStageType === "approval" && earlierStagesDone(issue);

// Queue order: the oldest PR first (lowest number), except that an issue waits for
// any issue in the list it is blocked by.
export function queueOrder(ready) {
  const left = [...ready].sort((a, b) => a.pr.number - b.pr.number || a.pr.repo.localeCompare(b.pr.repo));
  const out = [];
  const waitsOn = (r) => (r.issue.blockedBy ?? []).some((b) => left.some((x) => x !== r && x.issue.id === b.id));
  while (left.length) {
    // A blocker cycle can't be ordered: then simply the oldest.
    const i = Math.max(0, left.findIndex((r) => !waitsOn(r)));
    out.push(...left.splice(i, 1));
  }
  return out;
}

// Every issue at your approval with a PR ready to queue, in queue order:
// [{ issue, pr: { repo, number, sha, url, title }, reviewers: [agentId] }].
// `skipped` (optional) collects why the others aren't: [{ issue, why }].
export async function findReady({ api, config, github, userId, companyId, skipped = null }) {
  const rows = (await listIssues(api, companyId, "in_review")).filter((i) => !i.assigneeAgentId);
  const ready = [];
  await mapLimit(rows, CONCURRENCY, async (row) => {
    const issue = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
    if (!issue || !atYourApproval(issue, userId)) return;
    const [products, notes] = await Promise.all([
      api.request("GET", `/api/issues/${issue.id}/work-products`).catch(() => []),
      notesText(api, issue.id).catch(() => ""),
    ]);
    const refs = prRefs({ workProducts: products, texts: [notes] }, config.repos);
    if (!refs.length) return skipped?.push({ issue, why: "no PR in GITHUB_REPOS found on it" });
    const open = [];
    for (const ref of refs) {
      const pr = await github.pull(ref.repo, ref.number).catch(() => null);
      if (pr?.state === "open" && !pr.merged) open.push({ ref, pr });
    }
    if (!open.length) return skipped?.push({ issue, why: "its PR isn't open" });
    if (open.length > 1) return skipped?.push({ issue, why: `several open PRs (${open.map((o) => `#${o.ref.number}`).join(", ")})` });
    const [{ ref, pr }] = open;
    const why = pr.draft ? "a draft" : pr.mergeable !== true ? "GitHub hasn't worked out whether it merges (or it doesn't)" : pr.mergeable_state !== "clean" ? `not clean (${pr.mergeable_state ?? "unknown"})` : null;
    if (why) return skipped?.push({ issue, why: `PR #${ref.number} is ${why}` });
    ready.push({ issue, pr: { repo: ref.repo, number: ref.number, sha: pr.head?.sha ?? null, url: pr.html_url ?? null, title: pr.title ?? null }, reviewers: reviewersOf(issue) });
  });
  return queueOrder(ready);
}

// Watchdog 19.
export function createReadyCheck({ ctx, records, state, stats, dryRunSeen, record, github }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;
  const scanAt = new Map();

  async function check(companyId, agents) {
    if (!github) return;
    const last = scanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    scanAt.set(companyId, now());
    const { userId } = await ctx.identity();
    const ready = await findReady({ api, config, github, userId, companyId });
    if (!ready.length) return;
    // What else each reviewer has: open issues assigned to it.
    const open = await listIssues(api, companyId, OPEN).catch(() => []);
    const openOf = (agentId) => open.filter((i) => i.assigneeAgentId === agentId).length;
    for (const [i, r] of ready.entries()) {
      const key = record.readyToQueue(r.issue, r.pr);
      if (records.has(key) || dryRunSeen.has(key)) continue;
      const who = r.issue.identifier ?? r.issue.id;
      const reviewers = r.reviewers
        .map((id) => agents.get(id))
        .filter(Boolean)
        .map((a) => {
          const n = openOf(a.id);
          if (asleep(a)) return `${a.name} (already paused)`;
          return n ? `${a.name} (still has ${plural(n, "open issue")})` : `${a.name} (no open issues: it can be paused again)`;
        });
      const text =
        `PR #${r.pr.number} is approved by every reviewer, clean and green: ready to queue` +
        `${ready.length > 1 ? ` (${i + 1} of ${ready.length} in queue order; \`pch ready\` lists them)` : ""}.` +
        `${reviewers.length ? ` Reviewed by ${reviewers.join(", ")}.` : ""}${r.pr.url ? `\n\n${r.pr.url}` : ""}`;
      if (config.dryRun) {
        dryRunSeen.add(key);
        log("watchdog: would tell the board a PR is ready to queue (dry run)", { issue: who, pr: r.pr.number });
        continue;
      }
      records.set(key, { count: 1, at: now() });
      state.touch();
      try {
        // The issue waits on a person: a comment there wakes no agent.
        if (!r.issue.assigneeAgentId) await api.request("POST", `/api/issues/${r.issue.id}/comments`, { body: `${text}\n\n${WATCHDOG_SIGNATURE}` });
        else await noteToBoard(ctx, companyId, `${who}: ${text}`, { pr: r.pr.number });
      } catch (err) {
        log.warn("watchdog: couldn't post that a PR is ready to queue", { issue: who, pr: r.pr.number, error: err.message });
        continue;
      }
      stats.readyNotes = (stats.readyNotes ?? 0) + 1;
      log("watchdog: told the board a PR is ready to queue", { issue: who, pr: r.pr.number, sha: r.pr.sha });
    }
  }

  return { check };
}
