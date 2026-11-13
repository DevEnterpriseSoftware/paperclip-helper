// The loop breaker: the watchdog never wakes an agent over and over for nothing.
//
// Each of the watchdog's checks is right on its own terms, and each caps its own
// nudges, but two of them can feed each other: one wakes the agent, the agent's run
// ends with nothing new to do, Paperclip reacts to that ending (a repair, a hold), and
// another check answers that reaction with the next wake. Every turn costs an agent
// run and produces only "still waiting" comments, and nothing stops it but the
// condition the agent waits for, or a person.
//
// So every watchdog action that wakes an agent on an issue (a nudge, the release of a
// hold) asks first. Once the watchdog has woken the same issue WAKES times within
// WINDOW_MS, and nothing has moved on the issue since the first of those wakes, the
// next wake is not sent. The board is told once what loops, and the watchdog leaves
// the issue alone until it changes. Moved on means any of:
//   - the issue has another assignee, or is in review, done or cancelled;
//   - the assignee named a CI run it hadn't named before (a new push, a new run);
//   - a person commented (any board comment that isn't the Helper's own).
// A CI run's report is new information, not a loop: it is never held back, and it
// starts the count again.
//
// The record ("wake-loop:<issueId>") is kept in the state file with the watchdog's
// other records: { count, at, assignee, since, wakes: [ms], refs: [run ids], rules, tripped }.

import { runRefs } from "./ci-runs.mjs";
import { ts } from "./util.mjs";

export const WAKES = 2;
export const WINDOW_MS = 30 * 60_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000;
const SIGNED = /Paperclip Helper/;

export const wakeLoopKey = (issueId) => `wake-loop:${issueId}`;

export function createWakeGuard({ ctx, records, state, noteToBoard }) {
  const { api, log } = ctx;
  const now = () => ctx.now();
  const quietLogged = new Set(); // issue ids whose held-back wakes were logged since the trip, this process

  const commentsOf = async (issueId) => {
    const list = await api.request("GET", `/api/issues/${issueId}/comments?order=desc&limit=20`).catch(() => null);
    return Array.isArray(list) ? list : null;
  };
  // The run ids the assignee has named in its comments (newest 20), from `since` on when given.
  const namedRuns = (comments, agentId, since = 0) =>
    comments
      .filter((c) => c?.authorAgentId === agentId && (!since || ts(c.createdAt) >= since))
      .flatMap((c) => runRefs(c.body).map((r) => String(r.id)));

  // Whether the issue has moved on since the record's first wake (see the top).
  async function movedOn(issueId, r) {
    const issue = await api.request("GET", `/api/issues/${issueId}`).catch(() => null);
    if (!issue) return false; // can't tell: hold back, and look again next time
    if (issue.assigneeAgentId !== r.assignee || ["in_review", "done", "cancelled"].includes(issue.status)) return true;
    const comments = await commentsOf(issueId);
    if (!comments) return false;
    const known = new Set(r.refs ?? []);
    if (namedRuns(comments, r.assignee, r.since).some((id) => !known.has(id))) return true;
    return comments.some((c) => ts(c.createdAt) >= r.since && !c.authorAgentId && c.authorUserId && !SIGNED.test(String(c.body ?? "")));
  }

  const forget = (issueId) => {
    quietLogged.delete(issueId);
    if (records.delete(wakeLoopKey(issueId))) state.touch();
  };

  // May the watchdog wake `issue`'s assignee now, for `rule`? False once the issue loops:
  // the board is told once, and every later ask is held back (logged once) until the
  // issue moves on.
  async function allow(issue, rule) {
    const key = wakeLoopKey(issue.id);
    const r = records.get(key);
    if (!r) return true;
    const t = now();
    if (r.tripped ? t - r.tripped > FORGET_AFTER_MS : !(r.wakes ?? []).some((at) => t - at < WINDOW_MS)) {
      forget(issue.id);
      return true;
    }
    if (r.assignee !== issue.assigneeAgentId) {
      forget(issue.id);
      return true;
    }
    const recent = (r.wakes ?? []).filter((at) => t - at < WINDOW_MS);
    if (!r.tripped && recent.length < WAKES) return true;
    if (await movedOn(issue.id, r)) {
      forget(issue.id);
      log("watchdog: the issue moved on since its last wakes; the loop breaker lets the next one through", { issue: issue.identifier ?? issue.id, rule });
      return true;
    }
    const who = issue.identifier ?? issue.id;
    if (!r.tripped) {
      records.set(key, { ...r, tripped: t, at: t, rules: [...(r.rules ?? []), rule] });
      state.touch();
      const minutes = Math.max(1, Math.round((t - Math.min(...recent)) / 60_000));
      await noteToBoard(
        issue.companyId,
        `${who}: the watchdog has woken the assignee ${recent.length} times in ${minutes} min (${[...new Set(r.rules ?? [])].join(", ")}), and nothing has moved on the issue ` +
          `since: no new CI run named, no new assignee or status, no comment from a person. A wake now (${rule}) would only repeat that, so the watchdog leaves this issue alone ` +
          `until it changes. Look at what the agent is waiting for: \`pch why ${who}\`.`,
        { issue: who, rule, wakes: recent.length, decision: "loop breaker tripped" },
      );
      return false;
    }
    if (!quietLogged.has(issue.id)) {
      quietLogged.add(issue.id);
      log("watchdog: a wake held back by the loop breaker", { issue: who, rule, decision: "held back", trippedAt: new Date(r.tripped).toISOString() });
    }
    return false;
  }

  // The watchdog woke `issue`'s assignee, for `rule`. The first wake of a window records
  // the runs the agent has named so far, to tell a new one later.
  async function woke(issue, rule) {
    const key = wakeLoopKey(issue.id);
    const t = now();
    let r = records.get(key);
    if (r && (r.assignee !== issue.assigneeAgentId || !(r.wakes ?? []).some((at) => t - at < WINDOW_MS)) && !r.tripped) r = null;
    if (!r) {
      const comments = (await commentsOf(issue.id)) ?? [];
      r = { count: 0, at: t, assignee: issue.assigneeAgentId, since: t, wakes: [], refs: [...new Set(namedRuns(comments, issue.assigneeAgentId))], rules: [] };
    }
    const wakes = [...(r.wakes ?? []), t].filter((at) => t - at < WINDOW_MS).slice(-10);
    records.set(key, { ...r, count: (r.count ?? 0) + 1, at: t, wakes, rules: [...(r.rules ?? []), rule].slice(-10) });
    state.touch();
  }

  // New information reached the agent (a CI report): the count starts again.
  const reset = (issue) => forget(issue.id);

  return { allow, woke, reset };
}
