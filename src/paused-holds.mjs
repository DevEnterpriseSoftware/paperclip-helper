// Watchdog 18: wakes held by an unreconciled run from a pause.
//
// Pausing an agent cancels its runs ("Cancelled due to agent pause", errorCode
// agent_paused), and Paperclip counts each such run as needing reconciliation: the
// issue gets an execution hold (executionBlocker, cause
// legacy_execution_requires_reconciliation) that names the paused agent and its
// cancelled run. The hold covers the whole issue, not that agent: when the board
// later moves the issue on (to a review stage, say), every wake for the next owner
// waits behind it, a comment's and the hand-off's alike, and no run starts.
// Resuming the paused agent doesn't clear it, nothing in Paperclip retries it, and
// the issue's recovery actions can even list nothing. Interrupt sends one saved
// message without lifting the hold.
//
// Paperclip lifts it only on an explicit continuation (release.mjs): a board user's
// plain comment while the issue is assigned to the hold's own agent, that agent
// invokable. So the check finds such an issue (the hold's source run cancelled by a
// pause) and:
//
//   * while that agent is still paused, tells the board once and waits;
//   * once it is resumed and the resume has settled (WATCHDOG_RESUME_SETTLE_MIN: the
//     resume sweep asks for a scan at once then), with WATCHDOG_RELEASE_HOLDS on,
//     takes the two steps the board would: the issue back to that agent (a PATCH of
//     assigneeAgentId alone, when someone else has it, a reviewer say), then one
//     comment telling it to continue from where the pause cut it off and hand the
//     issue on as it normally would. Once per hold, paced by the agent's run limit
//     like the resume sweep (WATCHDOG_RESUME_SWEEP_LIMIT, or its maxConcurrentRuns);
//     the board is told what was done;
//   * reports instead, with the two steps, when the helper's key doesn't comment as
//     a board user, the agent isn't on a conversation adapter (Paperclip continues
//     only those), was terminated, or WATCHDOG_RELEASE_HOLDS is off.
//
// Never while the agent is still paused, and never for a hold from any other run
// (that one is 7's, or yours). `pch why` names the hold, the wakes it holds and the
// two steps; `pch release --apply` takes them.

import { listIssues } from "./paperclip.mjs";
import { asleep, mapLimit, ts, WATCHDOG_SIGNATURE } from "./util.mjs";
import { noteToBoard } from "./board-note.mjs";
import { issueActivity } from "./stages.mjs";
import { actsAsUser, continuationText, continuePausedHold, CONVERSATION_ADAPTERS, holdFacts, pausedHold, RECONCILIATION_CAUSE } from "./release.mjs";

// (In this order so a test can tell this listing from the question cards' one.)
const STATUSES = "in_review,in_progress,todo,blocked";
const PENDING_WAKE = new Set(["queued", "claimed", "deferred_issue_execution"]);
const CONCURRENCY = 4;
const MAX_WAKES_NAMED = 4;

const short = (id) => String(id ?? "?").slice(0, 8);

// The wakes still waiting on the issue, any agent's, from Paperclip's wake
// diagnostics (newest first): [{ agentId, reason, status, requestedAt }].
export async function waitingWakes(api, issueId) {
  const wakes = await api.request("GET", `/api/issues/${issueId}/diagnostics/wakes`).catch(() => null);
  return (wakes?.events ?? []).filter((e) => e.kind === "wake_request" && PENDING_WAKE.has(e.status));
}

// "Reviewer's issue_commented wake (deferred since 2026-10-24 09:12Z)", a few of them.
export function describeWakes(wakes, nameOf) {
  if (!wakes.length) return "";
  const named = wakes.slice(0, MAX_WAKES_NAMED).map((e) => {
    const since = e.requestedAt ? ` since ${new Date(ts(e.requestedAt)).toISOString().slice(0, 16).replace("T", " ")}Z` : "";
    return `${nameOf(e.agentId) ?? "an agent"}'s ${e.reason ?? "wake"} (${e.status === "deferred_issue_execution" ? "deferred" : e.status}${since})`;
  });
  return `${named.join(", ")}${wakes.length > MAX_WAKES_NAMED ? `, and ${wakes.length - MAX_WAKES_NAMED} more` : ""}`;
}

// The sentence that says why the issue's wakes don't start: for the board's note,
// the hand-off nudge and `pch why`.
export function pausedHoldWhy({ ownerName, runId }) {
  const owner = ownerName ?? "an agent";
  return (
    `Paperclip holds every wake on this issue behind ${owner}'s run ${short(runId)}, which was cancelled when ${owner} was paused ` +
    `and never reconciled (legacy_execution_requires_reconciliation)`
  );
}

// The two steps that lift it, for the board: in the note, on the issue and in `pch why`.
export function pausedHoldSteps({ ownerName, assigneeName = null, identifier }) {
  const owner = ownerName ?? "the agent whose run the pause cancelled";
  return (
    `Paperclip lifts it only when a board user comments while the issue is assigned to ${owner}, and ${owner} isn't paused: ` +
    `(1) ${assigneeName && assigneeName !== ownerName ? `assign the issue back to ${owner} (it is with ${assigneeName} now)` : `keep the issue assigned to ${owner}`}; ` +
    `(2) comment on it telling ${owner} to continue from where the pause cut it off and hand it on as usual. ` +
    `\`pch release ${identifier} --apply\` does both.`
  );
}

// A comment the helper posted by itself (the watchdog's, or one "sent automatically"):
// the board key is a person's, so its own comments carry that person's user id too.
// A comment sent with `pch` (or relayed from your GitHub action) is that person's.
const AUTOMATIC = /_Paperclip Helper watchdog[^_\n]*_|_Sent automatically by Paperclip Helper\._/;
const SAME_REQUEST_MS = 10_000;

// What people have done on the issue since the hold began (`since`, when its run
// ended), as far as the watchdog goes by it:
//
//   * { takeover: { what, at, user? } }: a person has taken it over: the issue is
//     assigned to a user (`user`: theirs until it is assigned back to the hold's
//     owner); or, for good, a person set it to done, cancelled or backlog, or
//     reassigned it to an agent other than the hold's owner, and that agent has run
//     on it since;
//   * { lastAt }: the latest of everything else, which only restarts the quiet period
//     (WATCHDOG_HOLD_QUIET_MIN): a person's comment, a status move to todo, in_progress
//     or in_review, a reassignment (back to the owner, or one that agent hasn't run
//     on), and Paperclip's own reassignment when it hands a stage to a reviewer;
//     0 when nothing happened;
//   * "unknown" when Paperclip didn't say.
//
// The helper's own comments (the watchdog's sign-off) aren't a person's, nor a change
// sent with one in the same request. Agents' comments don't count either.
const TAKEOVER_STATUSES = new Set(["done", "cancelled", "backlog"]);
export async function peopleSince(api, issue, { since, owner }) {
  const [comments, activity, runs] = await Promise.all([
    api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=50`).catch(() => null),
    issueActivity(api, issue.id),
    api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => null),
  ]);
  if (!Array.isArray(comments) || !Array.isArray(activity) || !Array.isArray(runs)) return "unknown";
  if (issue.assigneeUserId && !issue.assigneeAgentId) return { takeover: { what: "assigned it to a user", at: issue.updatedAt ?? null, user: true } };
  const after = (x) => ts(x?.createdAt) > since;
  const byUser = (c) => c?.authorUserId && !c.authorAgentId && (c.authorType == null || c.authorType === "user");
  const automatic = comments.filter((c) => byUser(c) && AUTOMATIC.test(String(c.body ?? "")));
  const helpers = (e) => automatic.some((c) => Math.abs(ts(c.createdAt) - ts(e.createdAt)) <= SAME_REQUEST_MS);
  let lastAt = 0;
  for (const c of comments) if (after(c) && byUser(c) && !AUTOMATIC.test(String(c.body ?? ""))) lastAt = Math.max(lastAt, ts(c.createdAt));
  // Oldest first, so a takeover is found at the change that made it.
  for (const e of [...activity].reverse()) {
    if (!after(e) || e?.action !== "issue.updated") continue;
    const changes = e.details?.changes ?? {};
    const status = changes.status?.to;
    const assignee = changes.assigneeAgentId ? changes.assigneeAgentId.to ?? null : undefined;
    // Paperclip handing a stage to its reviewer: the move to review assigns the participant.
    const stageHandOff = status === "in_review" && assignee !== undefined;
    const person = e.actorType === "user" && !helpers(e);
    if (!person && !stageHandOff) continue;
    if (!status && assignee === undefined && !changes.assigneeUserId) continue;
    if (person && TAKEOVER_STATUSES.has(status)) return { takeover: { what: `set it to ${status}`, at: e.createdAt } };
    if (person && !stageHandOff && assignee && assignee !== owner) {
      const ran = runs.some((r) => r.agentId === assignee && ts(r.startedAt) > ts(e.createdAt));
      if (ran) return { takeover: { what: "reassigned it to another agent, which has run on it since", at: e.createdAt } };
    }
    lastAt = Math.max(lastAt, ts(e.createdAt));
  }
  return { lastAt };
}

// Check 18. From the watchdog: its records, `record` keys, `agentFor`, `nudge`, and
// the resume sweep's `settling` and `takeSlot` (resumes).
export function createPausedHoldCheck({ ctx, records, state, stats, dryRunSeen, record, agentFor, resumes }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;
  const scanAt = new Map(); // companyId → last scan
  const acted = new Map(); // issueId → when its hold was continued: the other checks give it a stall window
  const logged = new Set(); // "key:reason": a hold left for now (agent paused, person acting), logged once
  const once = (key, reason, msg, extra) => {
    if (logged.has(`${key}:${reason}`)) return;
    logged.add(`${key}:${reason}`);
    log(msg, extra);
  };

  // Every open issue is read once per stall window: a hold doesn't change the
  // issue's updatedAt, and the list rows don't carry it. The resume sweep asks for a
  // scan at once when a resume has settled (scanSoon).
  async function check(companyId, agents) {
    const last = scanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    scanAt.set(companyId, now());
    // Issues assigned to a user too: one held that way has been taken over, recorded so for good.
    const issues = (await listIssues(api, companyId, STATUSES)).filter((i) => (i.assigneeAgentId || i.assigneeUserId) && !i.executionRunId && !i.checkoutRunId);
    await mapLimit(issues, CONCURRENCY, async (row) => {
      try {
        await checkIssue(row, agents, companyId);
      } catch (err) {
        log.warn("watchdog: paused-run hold check failed", { issue: row.identifier ?? row.id, error: err.message });
      }
    });
  }

  async function checkIssue(row, agents, companyId) {
    // One read per issue; the hold's run, agent and saved messages only for a held one.
    const full = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
    if (full?.executionBlocker?.cause !== RECONCILIATION_CAUSE) return;
    const facts = await holdFacts(api, row.id).catch(() => null);
    // Only a run the pause cancelled: any other hold is 7's, or yours.
    if (!facts?.hold || !pausedHold(facts) || !facts.hold.agentId) return;
    const { issue, hold } = facts;
    const who = issue.identifier ?? issue.id;
    const key = record.pausedHold(issue, hold.runId);
    if (records.get(key)?.done || dryRunSeen.has(key)) return; // once per hold
    const owner = facts.agent ?? (await agentFor(hold.agentId, agents).catch(() => null));
    const nameOf = (id) => (id && agents.get(id)?.name) ?? (id === owner?.id ? owner?.name : null);
    const wakes = await waitingWakes(api, issue.id);
    const why = pausedHoldWhy({ ownerName: owner?.name, runId: hold.runId });
    const held = wakes.length ? `: ${describeWakes(wakes, nameOf)} won't start` : ": no run starts on it";
    const steps = pausedHoldSteps({ ownerName: owner?.name, assigneeName: nameOf(issue.assigneeAgentId), identifier: who });
    const logExtra = { issue: who, pausedAgent: owner?.name ?? hold.agentId, sourceRun: hold.runId, waiting: wakes.length };

    // Told once per hold and reason ("paused" while the agent waits, "left" when it is
    // the board's to do), and the hold marked done when nothing more will happen.
    const tell = async (reason, text, { done = false, onIssue = false } = {}) => {
      const prior = records.get(key);
      if (prior?.told === reason || dryRunSeen.has(`${key}:${reason}`)) return;
      if (config.dryRun) dryRunSeen.add(`${key}:${reason}`);
      else {
        records.set(key, { count: 1, at: now(), told: reason, done, left: done });
        state.touch();
      }
      await noteToBoard(ctx, companyId, `${who}: ${why}${held}. ${text}`, logExtra);
      // The steps on the issue too, for whoever looks at it there.
      if (onIssue && !config.dryRun) {
        await api.request("POST", `/api/issues/${issue.id}/comments`, { body: `${why}${held}. ${text}\n\n${WATCHDOG_SIGNATURE}` })
          .catch((err) => log.warn("watchdog: couldn't note a paused-run hold on its issue", { issue: who, error: err.message }));
      }
    };

    if (!owner || ["terminated", "pending_approval"].includes(owner.status)) {
      const how = owner?.status === "terminated" ? "has since been terminated" : owner ? "is awaiting approval" : "is gone";
      return tell("left", `${owner?.name ?? "The run's agent"} ${how}, so only a reconciliation releases it: see \`pch why ${who}\`.`, { done: true });
    }
    // Never while the agent is paused: a comment then is saved behind the hold too. It
    // is continued once resumed, with one note then; till then, one log line.
    if (asleep(owner)) {
      return once(key, "paused", "watchdog: a hold left by a run an agent's pause cancelled waits until that agent is resumed", logExtra);
    }
    // A person has taken it over: theirs for good. Anything else a person did (or
    // Paperclip's stage hand-off) restarts the quiet period; after it, act as usual.
    const since = ts(facts.run?.finishedAt) || ts(facts.run?.createdAt);
    // Routed through a person (assigned to a user): theirs until it comes back to the
    // hold's owner. Then it's like any other held issue, its quiet period starting then.
    let returnedAt = 0;
    const prior = records.get(key);
    if (prior?.userHeld) {
      if (issue.assigneeAgentId !== owner.id) return once(key, "user", "watchdog: a hold left by a run an agent's pause cancelled is left alone: the issue went to a person and hasn't come back to its owner", logExtra);
      returnedAt = now();
      if (!config.dryRun) {
        records.set(key, { count: 1, at: now(), returnedAt });
        state.touch();
      }
    } else returnedAt = prior?.returnedAt ?? 0;
    const people = await peopleSince(api, issue, { since, owner: owner.id });
    if (people === "unknown") return; // a later scan
    if (people.takeover?.user) {
      if (!config.dryRun) {
        records.set(key, { count: 1, at: now(), userHeld: true });
        state.touch();
      }
      return once(key, "user", "watchdog: a hold left by a run an agent's pause cancelled is left alone: the issue is with a person", logExtra);
    }
    if (people.takeover) {
      if (!config.dryRun) {
        records.set(key, { count: 1, at: now(), done: true, person: people.takeover.what });
        state.touch();
      }
      return once(key, "person", "watchdog: a hold left by a run an agent's pause cancelled is left alone: a person has taken the issue over", {
        ...logExtra, personAction: people.takeover.what, at: people.takeover.at,
      });
    }
    const quietMs = config.watchdogHoldQuietMin * 60_000;
    const lastAt = Math.max(people.lastAt, returnedAt);
    if (lastAt && now() - lastAt < quietMs) {
      return once(key, `quiet:${lastAt}`, "watchdog: a hold left by a run an agent's pause cancelled waits for the issue to be quiet", {
        ...logExtra, lastActivityAt: new Date(lastAt).toISOString(), quietMin: config.watchdogHoldQuietMin,
      });
    }
    if (!config.watchdogReleaseHolds) return tell("left", `${steps} (WATCHDOG_RELEASE_HOLDS is off.)`, { done: true });
    if (!CONVERSATION_ADAPTERS.has(owner.adapterType)) {
      return tell("left", `Paperclip continues only an agent on a conversation adapter, and ${owner.name} is on ${owner.adapterType ?? "an unknown adapter"}: only a reconciliation releases it (see \`pch why ${who}\`).`, { done: true });
    }
    const me = await ctx.identity().catch(() => null);
    if (!actsAsUser(me)) {
      return tell("left", `The helper's key doesn't comment as a board user, so it can't do this itself. ${steps}`, { done: true, onIssue: true });
    }
    // After a resume, its settle window first (a resume to look at one thing, then a pause again).
    if (resumes.settling(owner.id)) return;
    if (config.dryRun) {
      dryRunSeen.add(key);
      log("watchdog: would continue a hold left by a run an agent's pause cancelled (dry run)", logExtra);
      return;
    }
    // The comment starts a run: paced like the resume sweep's restores.
    if (!(await resumes.takeSlot(owner, companyId))) return;
    // The agent as Paperclip has it now: paused a moment ago, it's left for its next resume.
    const fresh = await api.request("GET", `/api/agents/${owner.id}`).catch(() => null);
    if (!fresh || asleep(fresh)) return;
    // Recorded before the requests: a reassignment or comment isn't sent twice.
    records.set(key, { count: 1, at: now(), done: true });
    state.touch();
    let result;
    try {
      result = await continuePausedHold(api, facts, { text: continuationText(owner, `\n\n${WATCHDOG_SIGNATURE}`) });
    } catch (err) {
      records.set(key, { count: 1, at: now(), done: true, failed: true, left: true });
      state.touch();
      await noteToBoard(ctx, companyId, `${who}: ${why}${held}. The watchdog couldn't continue it (${err.message}). ${steps}`, logExtra);
      return;
    }
    acted.set(issue.id, now());
    stats.pausedHolds = (stats.pausedHolds ?? 0) + 1;
    // One log line (the note's, at info) and one note per issue continued.
    const back = result.reassigned ? `assigned the issue back to ${owner.name}${result.from ? ` (from ${nameOf(result.from) ?? "its assignee"})` : ""} and ` : "";
    await noteToBoard(
      ctx,
      companyId,
      `${who}: ${why}${held}. The watchdog ${back}asked ${owner.name} to continue from where the pause cut it off, which is what Paperclip lifts the hold on. ` +
        (result.lifted ? "The hold is gone." : `Paperclip still showed the hold a moment later: if no run starts, see \`pch why ${who}\`.`),
      { ...logExtra, level: "info", continued: true, reassignedFrom: result.reassigned ? nameOf(result.from) : null, lifted: result.lifted },
    );
  }

  return {
    check,
    // Resolved within the stall window: the agent's run is on its way, and a hand-off
    // nudge on top would only guess at why nothing had started.
    actedOn: (issueId) => acted.has(issueId) && now() - acted.get(issueId) < stallMs,
    // A resume has settled: look at the company's holds on the next check, not a stall window later.
    scanSoon: (companyId) => scanAt.delete(companyId),
  };
}
