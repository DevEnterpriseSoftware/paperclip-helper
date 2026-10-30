// Agents that wake themselves (watchdog 21, and `pch why`).
//
// When a run ends without the agent posting a comment through the API, Paperclip
// posts the run's final message on the issue as the agent's own comment
// (heartbeat/run-completion.ts: activity "issue.comment_added" with
// details.source "run_presentation_resolver"). That comment wakes the issue's
// assignee within seconds, the same agent included, and a run that ends the same
// way starts the next: one quiet run becomes dozens (38 runs on one issue in an
// hour has been seen). The watchdog tells the board once per issue. It never
// comments on the issue itself: that would wake the agent once more.

import { listIssues } from "./paperclip.mjs";
import { mapLimit, ts } from "./util.mjs";

export const PRESENTATION_SOURCE = "run_presentation_resolver";
export const SELF_WAKE_WINDOW_MS = 60 * 60_000;
// The next run is queued within seconds of the comment; allow for a slow server.
export const SELF_WAKE_GAP_MS = 15_000;
export const SELF_WAKE_MIN = 5;

const STATUSES = "todo,in_progress,in_review,blocked";
const CONCURRENCY = 4;

// The issue's self-wakes in the window, newest first: each a run-presentation
// comment posted as an agent ({ agentId, runId, at }) followed, within the gap, by
// that agent's next run on the issue ({ nextRunId }). `activity` is the issue's
// activity log and `runs` its runs (GET /api/issues/:id/runs), in any order.
export function selfWakes(activity, runs, { now, windowMs = SELF_WAKE_WINDOW_MS, gapMs = SELF_WAKE_GAP_MS } = {}) {
  const posted = (Array.isArray(activity) ? activity : []).filter(
    (a) => a?.action === "issue.comment_added" && a.details?.source === PRESENTATION_SOURCE && now - ts(a.createdAt) < windowMs,
  );
  const started = (Array.isArray(runs) ? runs : []).map((r) => ({ id: r.runId ?? r.id, agentId: r.agentId, at: ts(r.createdAt ?? r.startedAt) }));
  const out = [];
  for (const a of posted) {
    const agentId = a.agentId ?? a.actorId;
    const at = ts(a.createdAt);
    const next = started.find((r) => r.agentId === agentId && r.id !== a.runId && r.at >= at - 1000 && r.at - at <= gapMs);
    if (next) out.push({ agentId, runId: a.runId ?? null, at, nextRunId: next.id });
  }
  return out.sort((x, y) => y.at - x.at);
}

// The agent caught in a loop on the issue, or null: SELF_WAKE_MIN or more
// self-wakes by one agent within the window. { agentId, count, since }
export function selfWakeLoop(activity, runs, opts) {
  const byAgent = new Map();
  for (const w of selfWakes(activity, runs, opts)) byAgent.set(w.agentId, [...(byAgent.get(w.agentId) ?? []), w]);
  let worst = null;
  for (const [agentId, wakes] of byAgent) {
    if (wakes.length >= SELF_WAKE_MIN && (!worst || wakes.length > worst.count)) {
      worst = { agentId, count: wakes.length, since: Math.min(...wakes.map((w) => w.at)) };
    }
  }
  return worst;
}

// What the board is told.
export function selfWakeNote({ issue, agentName, count }) {
  const who = agentName ?? "Its agent";
  return (
    `${who} is waking itself on ${issue.identifier ?? issue.id}: ${count} of its runs there in the last hour ended without a comment of its own, ` +
    "Paperclip posted each run's final message as the agent's comment (run_presentation_resolver), and that comment started the agent's next run within seconds. " +
    "Each turn is a full run. Pause the issue (or the agent) to stop it, then tell the agent to end every run with a comment of its own, " +
    "and `pch why` the issue. The watchdog doesn't comment on the issue: that would wake the agent again."
  );
}

// Watchdog 21. Once per stall window per company: issues an agent owns that changed
// since about the last look (a loop changes its issue every minute or two), each
// read again only when it has changed since.
export function createSelfWakeCheck({ ctx, records, state, stats, dryRunSeen, agentFor, noteToBoard }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;
  const scanAt = new Map(); // companyId → when last scanned
  const seen = new Map(); // issueId → { companyId, updatedAt }: read at that point, no loop
  const key = (issue) => `self-wake:${issue.id}`;

  async function check(companyId, agents) {
    const last = scanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    scanAt.set(companyId, now());
    const issues = (await listIssues(api, companyId, STATUSES)).filter(
      (i) => i.assigneeAgentId && now() - ts(i.updatedAt) < 2 * stallMs && !records.has(key(i)) && !dryRunSeen.has(key(i)),
    );
    const live = new Set(issues.map((i) => i.id));
    for (const [id, s] of seen) if (s.companyId === companyId && !live.has(id)) seen.delete(id);
    await mapLimit(issues, CONCURRENCY, async (issue) => {
      if (seen.get(issue.id)?.updatedAt === issue.updatedAt) return;
      try {
        await checkIssue(issue, agents, companyId);
      } catch (err) {
        log.warn("watchdog: self-wake check failed", { issue: issue.identifier ?? issue.id, error: err.message });
      }
    });
  }

  async function checkIssue(issue, agents, companyId) {
    const [activity, runs] = await Promise.all([
      api.request("GET", `/api/issues/${issue.id}/activity`).catch(() => null),
      api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => null),
    ]);
    if (!Array.isArray(activity) || !Array.isArray(runs)) return;
    const loop = selfWakeLoop(activity, runs, { now: now() });
    if (!loop) {
      seen.set(issue.id, { companyId, updatedAt: issue.updatedAt });
      return;
    }
    const agent = await agentFor(loop.agentId, agents).catch(() => null);
    const k = key(issue);
    // Claimed before the note is awaited: issues are checked a few at a time.
    if (config.dryRun) dryRunSeen.add(k);
    else {
      records.set(k, { count: 1, at: now(), agentId: loop.agentId, runs: loop.count });
      state.touch();
    }
    stats.selfWakes = (stats.selfWakes ?? 0) + 1;
    await noteToBoard(companyId, selfWakeNote({ issue, agentName: agent?.name, count: loop.count }), {
      issue: issue.identifier ?? issue.id, agent: agent?.name ?? loop.agentId, selfWakes: loop.count,
    });
  }

  return { check };
}
