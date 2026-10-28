// Watchdog 17: issues whose review stages were wiped (the check; the relay's part,
// closing an issue on a merge when no stage is left to approve, is in relay.mjs).
//
// An agent's update that sends `executionPolicy: { stages: [] }` removes the
// issue's review and approval stages (a Paperclip bug). The issue then closes as
// done, or sits in review with nothing to review, while its PR is open and
// unreviewed: a PR merged with no review, or dependants that can't start because
// their blocker never reached done. This finds:
//
//   * a done issue whose stages an agent removed (Paperclip's activity log shows
//     it) and whose own PR, opened before the issue was done, is still open: it is
//     set back to in_progress with a comment (which wakes its agent), and the board
//     is told. Once per issue and PR; closed again, the board is told instead (a
//     reopen Paperclip refuses is logged and left to you). The
//     stages aren't re-created: which ones, and who reviews, is the board's call;
//   * an issue in progress or in review whose stages an agent removed: the board
//     is told once.

import { mapLimit, pausedRefusal, ts, WATCHDOG_SIGNATURE } from "./util.mjs";
import { listIssues } from "./paperclip.mjs";
import { noteToBoard } from "./board-note.mjs";
import { notesText } from "./quiet-notes.mjs";

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const LOOKBACK_MS = 3 * 24 * 60 * 60_000; // only issues touched in the last few days
const MAX_PRS = 3; // per issue
const CONCURRENCY = 4;

const stagesOf = (policy) => (Array.isArray(policy?.stages) ? policy.stages : []);

// The pull requests an issue points at, in GITHUB_REPOS: its PR work products and
// any PR URL in the texts given (its recent comments, the relay's notes). [{ repo, number }]
export function prRefs({ workProducts = [], texts = [] }, repos) {
  const found = new Map();
  const add = (repo, number) => {
    const r = String(repo ?? "").toLowerCase();
    const n = Number(number);
    if (!r || !n || (repos.length && !repos.includes(r))) return;
    found.set(`${r}#${n}`, { repo: r, number: n });
  };
  for (const wp of Array.isArray(workProducts) ? workProducts : []) {
    if (wp?.type !== "pull_request") continue;
    const m = String(wp.url ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
    if (m) add(m[1], m[2]);
    else add(wp.metadata?.repo, wp.metadata?.number);
  }
  for (const text of texts) for (const m of String(text ?? "").matchAll(PR_URL)) add(m[1], m[2]);
  return [...found.values()].slice(0, MAX_PRS);
}

// The activity entry in which an agent removed the issue's stages, or null:
// `issue.updated` by an agent whose changes take executionPolicy from some stages
// to none. A person removing them did it on purpose.
export function stagesWipe(activity) {
  for (const entry of Array.isArray(activity) ? activity : []) {
    const change = entry?.details?.changes?.executionPolicy;
    if (entry?.action !== "issue.updated" || !change || entry.actorType !== "agent") continue;
    if (stagesOf(change.from).length && !stagesOf(change.to).length) return entry;
  }
  return null;
}

// The issue's whole activity log, newest first (GET /api/issues/:id/activity), or null.
export const issueActivity = (api, issueId) => api.request("GET", `/api/issues/${issueId}/activity`).catch(() => null);

export function createStagesCheck({ ctx, records, state, stats, dryRunSeen, github, identifiersOf }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const scanAt = new Map(); // companyId → last scan
  const looked = new Map(); // issueId → the updatedAt it was last fully looked at with
  const settledPrs = new Set(); // "repo#n" merged or closed: never open again for this check
  const stallMs = config.watchdogStallSec * 1000;

  const wipeKey = (row, wipe) => `stages-wiped:${row.id}:${wipe.id ?? wipe.createdAt}`;

  // Who made the change: the agent's name.
  const who = (entry, agents) => agents.get(entry?.agentId ?? entry?.actorId)?.name ?? null;
  const when = (entry) => new Date(entry.createdAt).toISOString().slice(0, 16).replace("T", " ");

  async function check(companyId, agents) {
    const last = scanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    scanAt.set(companyId, now());
    const due = (i) => now() - ts(i.updatedAt) < LOOKBACK_MS && looked.get(i.id) !== i.updatedAt;
    const rows = [
      ...(github ? (await listIssues(api, companyId, "done")).filter(due) : []),
      ...(await listIssues(api, companyId, "in_progress,in_review")).filter((i) => due(i) && !i.executionRunId && !i.checkoutRunId),
    ];
    // A few at a time: after a restart every issue updated in the lookback is read once.
    await mapLimit(rows, CONCURRENCY, async (row) => {
      try {
        if (row.status === "done" ? await reopenIfPrOpen(row, agents) : await reportWipe(row, agents)) looked.set(row.id, row.updatedAt);
      } catch (err) {
        log.warn("watchdog: stages check failed", { issue: row.identifier ?? row.id, error: err.message });
      }
    });
  }

  // A done issue an agent wiped the stages of, whose own PR (opened before the
  // issue was done) is still open: back to in_progress, and the board is told.
  // True once the issue has been looked at (whatever the outcome).
  async function reopenIfPrOpen(row, agents) {
    const full = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
    if (!full) return false;
    if (full.status !== "done" || stagesOf(full.executionPolicy).length || full.executionState?.status === "completed") return true;
    const activity = await issueActivity(api, row.id);
    if (!activity) return false;
    const wipe = stagesWipe(activity);
    if (!wipe) return true; // never had stages, or a person removed them: done is done
    // The relay's PR links are in the issue's pull-requests document (or, older, its comments).
    const [products, comments, notes] = await Promise.all([
      api.request("GET", `/api/issues/${row.id}/work-products`).catch(() => []),
      api.request("GET", `/api/issues/${row.id}/comments?order=desc&limit=20`).catch(() => []),
      notesText(api, row.id),
    ]);
    const texts = [...(Array.isArray(comments) ? comments : []).map((c) => c.body), notes];
    const refs = prRefs({ workProducts: products, texts }, config.repos);
    for (const ref of refs) {
      const prKey = `${ref.repo}#${ref.number}`;
      const key = `stages-reopen:${row.id}:${prKey}`;
      if (settledPrs.has(prKey) || dryRunSeen.has(key)) continue;
      const pr = await github.pull(ref.repo, ref.number).catch(() => null);
      if (!pr) return false;
      if (pr.state !== "open" || pr.merged) {
        settledPrs.add(prKey);
        continue;
      }
      // The issue's own PR (the first issue it names), opened before the issue was
      // done: a follow-up or revert opened afterwards isn't what was left unreviewed.
      if (identifiersOf(pr)[0] !== row.identifier) continue;
      if (full.completedAt && ts(pr.created_at) > ts(full.completedAt)) continue;
      const label = `PR #${pr.number}`;
      if (records.get(key)?.failed) continue; // Paperclip refused the reopen: left to you, logged then
      if (records.has(key)) {
        // Reopened once already and closed again with the PR still open: the board's.
        const again = `stages-reclosed:${row.id}:${prKey}`;
        if (!records.has(again) && !config.dryRun) {
          records.set(again, { count: 1, at: now() });
          state.touch();
          await noteToBoard(ctx, row.companyId, `${row.identifier} was closed again while ${label} is still open and unreviewed. The watchdog won't reopen it twice: restore its review stages, or decide it yourself. ${pr.html_url}`);
        }
        continue;
      }
      const by = who(wipe, agents) ?? "an agent";
      const comment =
        `This issue was closed while ${label} was still open and unreviewed, so the watchdog has reopened it. ` +
        `Its review stages were wiped (by ${by}, ${when(wipe)} UTC), so the board or the architect must restore them before it is reviewed. ` +
        `Don't mark it done again until they are. ${pr.html_url}\n\n${WATCHDOG_SIGNATURE}`;
      if (config.dryRun) {
        dryRunSeen.add(key);
        log("watchdog: would reopen a done issue whose PR is still open (dry run)", { issue: row.identifier, pr: pr.html_url });
        return true;
      }
      try {
        await api.request("PATCH", `/api/issues/${row.id}`, { status: "in_progress", comment });
      } catch (err) {
        if (pausedRefusal(err)) return false; // a paused task: next scan
        records.set(key, { count: 1, at: now(), failed: true });
        state.touch();
        log.warn("watchdog: couldn't reopen a done issue whose PR is still open; left to you", { issue: row.identifier, error: err.message });
        return true;
      }
      records.set(key, { count: 1, at: now() });
      // The board hears about this wipe here; reportWipe mustn't tell it again once the issue is open.
      records.set(wipeKey(row, wipe), { count: 1, at: now() });
      state.touch();
      stats.reopened += 1;
      await noteToBoard(ctx, row.companyId, `${row.identifier} was closed while ${label} was still open and unreviewed; the watchdog reopened it. Its review stages were wiped by ${by}: restore them. ${pr.html_url}`);
      return true;
    }
    return true;
  }

  // An issue in progress or in review whose stages an agent removed: the board is
  // told once. True once the issue has been looked at.
  async function reportWipe(row, agents) {
    const full = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
    if (!full) return false;
    if (stagesOf(full.executionPolicy).length) return true;
    const activity = await issueActivity(api, row.id);
    if (!activity) return false;
    const wipe = stagesWipe(activity);
    if (!wipe) return true;
    const key = wipeKey(row, wipe);
    if (records.has(key) || dryRunSeen.has(key)) return true;
    if (config.dryRun) dryRunSeen.add(key);
    else {
      records.set(key, { count: 1, at: now() });
      state.touch();
      stats.wipes += 1;
    }
    const by = who(wipe, agents);
    await noteToBoard(ctx, row.companyId, `${row.identifier} (${full.status}) lost its review stages in an update by ${by ?? "an agent"}: nothing will review or approve it. Restore its stages (Paperclip doesn't keep them).`);
    return true;
  }

  return { check };
}
