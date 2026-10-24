// Watchdog 15: issues Paperclip's recovery blocked while their agent was paused.
//
// Pausing an agent that has runs queued or in flight cancels them. Paperclip's
// recovery sweep then finds each affected issue assigned to an agent it can't
// invoke and gives up on it: the issue goes to `blocked`, with no blocker linked,
// and a system comment ("Paperclip cannot safely continue automatic recovery
// because the original assignee is not invokable…") whose metadata has a
// "Recovery" section, "Recovery owner: Board decision required". Resuming the
// agent restarts none of them. An issue in review whose pending stage waits on the
// paused agent gets the same treatment from the review-participant recovery: blocked,
// with "Paperclip cannot continue the pending execution-review participant because
// the participant is not invokable…" (a recovery action of cause
// execution_review_participant_recovery), and executionState.currentParticipant
// still the paused agent. This module has the sweep (createResumeSweep), which
// restores such issues once the agent is resumed, and the helpers it uses.
//
// The sweep records every pause and resume it sees in the state file, so a resume
// while the helper was down is still seen, and at start-up reads Paperclip's
// activity log for pauses from before. Watchdog 6 (issues Paperclip's recovery
// parked) asks it whether a resume is settling or being swept, and shares its
// per-agent run slots, so the two never give an agent more runs at once than its
// limit.

import { listIssues } from "./paperclip.mjs";
import { ACTIVE_RUN, agentMention, asleep, pausedRefusal, ts, WATCHDOG_SIGNATURE } from "./util.mjs";

// Statuses an issue can be restored to. Anything else Paperclip recorded as the
// previous status (it records only these three today) restores to todo.
const RESTORABLE = new Set(["todo", "in_progress", "in_review"]);
// Blockers that don't hold the issue back for this check: Paperclip keeps a
// cancelled blocker unresolved, but the issue was running with it before the
// pause, so it isn't why it is blocked now (watchdog 14 tells the agent about it).
const SETTLED_BLOCKER = new Set(["done", "cancelled"]);
// Paperclip clamps maxConcurrentRuns to 1–50 (normalizeMaxConcurrentRuns).
const MAX_CONCURRENT_RUNS_LIMIT = 50;

const NOT_INVOKABLE = /original assignee is not invokable/i;
// buildExecutionReviewParticipantUnavailableNoticeSeed (services/recovery/stranded-notice.ts).
// Its sibling, "Paperclip retried the pending execution-review participant once, but…",
// is a reviewer that ran and failed, not a pause, and never matches.
const PARTICIPANT_NOT_INVOKABLE = /pending\s+execution-review\s+participant\s+because\s+the\s+participant\s+is\s+not\s+invokable/i;
export const PARTICIPANT_RECOVERY_CAUSE = "execution_review_participant_recovery";

const rowValue = (section, label) => {
  const row = (Array.isArray(section?.rows) ? section.rows : []).find((r) => r?.label === label);
  return row ? (row.value ?? row.name ?? null) : undefined;
};

// The system comment Paperclip's recovery posts when it gives up on an issue for
// the board, or null. With metadata (current Paperclip), the comment must carry a
// "Recovery" section owned by the board, and not be one Paperclip says is for a
// person to fix (recoveryResponsibility "user": a usage limit, a missing login),
// which no resume fixes. Without metadata (older Paperclip), its body must say the
// assignee (or the review participant) was not invokable.
//
// { kind, actionId, notInvokable }: kind "assignee" for the issue's assignee,
// "participant" for the pending review stage's participant (its body always says
// the participant was not invokable: the same cause's "retried once" notice is a
// failed reviewer, not a pause); actionId names the recovery action when the comment
// says which; notInvokable is whether the comment itself says it was the pause
// (needed when the action can't be read).
export function recoveryNotice(comment) {
  if (!comment || comment.authorAgentId || comment.authorUserId) return null;
  if (comment.authorType != null && comment.authorType !== "system") return null;
  const body = String(comment.body ?? "");
  const participant = PARTICIPANT_NOT_INVOKABLE.test(body);
  const meta = comment.metadata;
  if (meta && Array.isArray(meta.sections)) {
    const section = meta.sections.find((s) => s?.title === "Recovery");
    if (!section || rowValue(section, "Recovery owner") !== "Board decision required") return null;
    if (meta.recoveryResponsibility === "user") return null;
    const evidence = meta.sections.find((s) => s?.title === "Run evidence");
    return {
      kind: participant ? "participant" : "assignee",
      actionId: rowValue(section, "Recovery action") ?? null,
      // What says it was the pause when the recovery action can't be read: the
      // not-invokable text, or a source run the pause cancelled.
      notInvokable: participant || NOT_INVOKABLE.test(body) || rowValue(evidence, "Failure code") === "agent_paused",
    };
  }
  if (participant) return { kind: "participant", actionId: null, notInvokable: true };
  return NOT_INVOKABLE.test(body) ? { kind: "assignee", actionId: null, notInvokable: true } : null;
}

// The agent a pending review or approval stage waits on, or null.
export function reviewParticipantOf(issue) {
  const state = issue?.executionState;
  const p = state?.status === "pending" ? state.currentParticipant : null;
  return p?.type === "agent" && p.agentId ? p.agentId : null;
}

// Blockers that still hold the issue: anything not done or cancelled, or whose
// status Paperclip didn't give (assumed to hold it).
export function holdingBlockers(issue) {
  return (Array.isArray(issue?.blockedBy) ? issue.blockedBy : []).filter((b) => !SETTLED_BLOCKER.has(b?.status));
}

// Did the issue change status after the comment? Paperclip sets blockedTransitionAt
// when an issue moves into blocked, in the same transaction that posts the comment
// (so within a moment of it). A later one means it left blocked and came back.
export function statusChangedSince(issue, commentAt) {
  const at = ts(issue?.blockedTransitionAt);
  return Boolean(at && commentAt && at - commentAt > 60_000);
}

// Is this recovery action one that blocked the issue because its assignee couldn't
// be invoked? Unknown (null) when the action wasn't found: the comment decides.
export function pauseRecoveryAction(action) {
  if (!action) return null;
  if (action.ownerType && action.ownerType !== "board") return false;
  const kind = action.kind ?? "stranded_assigned_issue";
  const cause = action.cause ?? "stranded_assigned_issue";
  return kind === "stranded_assigned_issue" && cause === "stranded_assigned_issue";
}

// Is this the review-participant recovery's action (it can't invoke the stage's
// participant)? Unknown (null) when the action wasn't found: the notice decides.
export function participantRecoveryAction(action) {
  if (!action) return null;
  if (action.ownerType && action.ownerType !== "board") return false;
  const kind = action.kind ?? "stranded_assigned_issue";
  const cause = action.cause ?? PARTICIPANT_RECOVERY_CAUSE;
  return kind === "stranded_assigned_issue" && cause === PARTICIPANT_RECOVERY_CAUSE;
}

// The status to restore: in_review while a review or approval stage is pending, so
// its participant is woken (a board move to todo or in_progress would dissolve the
// stage); otherwise the status Paperclip recorded before the block; else todo.
export function restoreStatus(issue, action) {
  const state = issue?.executionState;
  if (state?.status === "pending" && state.currentStageType) return { status: "in_review", from: "review stage" };
  const previous = action?.evidence?.previousStatus;
  if (RESTORABLE.has(previous)) return { status: previous, from: "recovery evidence" };
  return { status: "todo", from: "default" };
}

// How many of an agent's issues to restore per tick: its maxConcurrentRuns
// (runtimeConfig.heartbeat), clamped as Paperclip does, or 1 when it doesn't say.
export function concurrencyOf(agent) {
  const raw = Number(agent?.runtimeConfig?.heartbeat?.maxConcurrentRuns);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(MAX_CONCURRENT_RUNS_LIMIT, Math.floor(raw));
}

const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };

// Most urgent first, then the longest blocked.
export function sweepOrder(a, b) {
  const pa = PRIORITY[a?.priority] ?? 2;
  const pb = PRIORITY[b?.priority] ?? 2;
  return pa - pb || ts(a?.updatedAt) - ts(b?.updatedAt);
}

// ---------------------------------------------------------------- the sweep

// A resumed agent's issues are looked at for at most this long after the resume.
const RESUME_SWEEP_MS = 24 * 60 * 60_000;
// Clock slack between the helper and Paperclip when comparing a comment's time with a pause.
const CLOCK_SLACK_MS = 5_000;
// A pause whose start nobody can tell (an agent already paused when the helper starts,
// with neither Paperclip's pausedAt nor an "agent.paused" activity entry): `since` 0,
// so any recovery notice that says the agent couldn't be invoked counts.
const UNKNOWN_SINCE = 0;
// Agent activity read once per company when the helper starts: its pauses and resumes.
const STARTUP_ACTIVITY_LIMIT = 500;
// A long-lived record is touched this often, so the state file (which forgets records
// untouched for a week) keeps it.
const RECORD_REFRESH_MS = 24 * 60 * 60_000;

// `record`: the watchdog's record keys (agentPaused, agentResumed, agentSwept,
// resumeRestore). Each tick: startTick(), check() per company, then endTick(at).
// `onSettled(companyId)`: called once per resume when its settle window has passed
// (check 18 then looks at the holds a pause left on that company's issues).
export function createResumeSweep({ ctx, records, state, stats, dryRunSeen, record, onSettled = null }) {
  const { config, api, log } = ctx;
  const now = () => ctx.now();
  const seenStatus = new Map(); // agentId → its status at this process's previous tick
  const startupRead = new Set(); // companies whose agents' pauses and resumes were read at start-up
  let previousTickAt = null; // when this process's previous tick started
  const sweepHeld = new Map(); // agentId → ids of its issues a resume sweep will restore on a later tick
  let slots = new Map(); // agentId → Promise<{ left }>: runs it may still be given this tick (startTick)
  const settledSeen = new Set(); // "agentId:resumedAt" whose settled resume onSettled was told of

  // An agent missing from the company's list: gone for good only when Paperclip says
  // so (404, or terminated, which the list leaves out). Unknown otherwise.
  async function agentGone(agentId) {
    try {
      const agent = await api.request("GET", `/api/agents/${agentId}`);
      return agent?.status === "terminated" ? true : agent ?? null;
    } catch (err) {
      return err.status === 404 ? true : null;
    }
  }

  // Records each agent's pause and resume, and returns the agents of this company
  // resumed since (this tick or before, while their issues are still being restored).
  // Kept in the state file, so a resume while the helper was down is still seen.
  async function trackPauses(companyId, agents, tickAt) {
    const resumed = [];
    for (const [key, r] of records.entries()) {
      if (r?.companyId !== companyId) continue;
      const paused = key.startsWith("agent-paused:");
      if (!paused && !key.startsWith("agent-resumed:")) continue;
      const agentId = key.slice(key.indexOf(":") + 1);
      let agent = agents.get(agentId);
      if (!agent) {
        const gone = await agentGone(agentId);
        if (gone === true) {
          records.delete(key); // terminated or deleted: nothing to restore
          sweepHeld.delete(agentId);
          state.touch();
        }
        if (!gone || gone === true) continue; // can't tell: look again next tick
        agent = gone;
      }
      if (agent.status === "terminated") {
        records.delete(key);
        sweepHeld.delete(agentId);
        state.touch();
        continue;
      }
      if (agent.status === "paused") {
        if (!paused) {
          // Paused again before its issues were all restored: the next resume covers both pauses.
          records.delete(key);
          sweepHeld.delete(agentId);
          records.set(record.agentPaused(agentId), { count: 1, at: now(), since: r.since, companyId });
          state.touch();
        } else if (now() - (r.at ?? 0) > RECORD_REFRESH_MS) {
          records.set(key, { ...r, at: now() }); // the state file forgets records untouched for a week
          state.touch();
        }
        continue;
      }
      if (paused) {
        if (asleep(agent)) continue; // awaiting approval: not invokable yet
        records.delete(key);
        const entry = { count: 0, at: now(), since: r.since, resumedAt: tickAt, companyId };
        records.set(record.agentResumed(agentId), entry);
        state.touch();
        log("watchdog: an agent was resumed; its issues Paperclip's recovery blocked during the pause are looked at once the resume has settled", {
          agent: agent.name,
          pausedSince: r.since ? new Date(r.since).toISOString() : "unknown",
          settleMin: config.watchdogResumeSettleMin,
        });
        resumed.push({ agent, entry });
        continue;
      }
      if (asleep(agent)) continue; // awaiting approval: its issues wait
      if (now() - (r.resumedAt ?? 0) > RESUME_SWEEP_MS) {
        records.delete(key);
        records.set(record.agentSwept(agentId), { count: 1, at: now(), resumedAt: r.resumedAt });
        sweepHeld.delete(agentId);
        state.touch();
        continue;
      }
      resumed.push({ agent, entry: r });
    }
    // The first listing of this company since the helper started: an agent seen
    // paused now may have been paused long before, and one may have been resumed
    // between the restart and this tick. Paperclip's activity log says when.
    const startup = !startupRead.has(companyId);
    const activity = startup ? await agentActivity(companyId) : null;
    if (startup) startupRead.add(companyId);
    // Agents seen paused for the first time. Paperclip's pausedAt says when. Without
    // it: in a running helper, no earlier than its previous tick that saw the agent
    // unpaused (a block from before then isn't the pause's); at start-up, the agent's
    // latest "agent.paused" activity, or unknown when there is none (it was paused
    // before the helper could see it, so any not-invokable notice counts).
    for (const agent of agents.values()) {
      if (agent.status !== "paused") continue;
      if (records.has(record.agentPaused(agent.id)) || records.has(record.agentResumed(agent.id))) continue;
      const known = seenStatus.has(agent.id) && seenStatus.get(agent.id) !== "paused" && previousTickAt != null;
      const since = ts(agent.pausedAt) || (known ? previousTickAt : startup ? activity?.get(agent.id)?.pausedAt || UNKNOWN_SINCE : tickAt);
      records.set(record.agentPaused(agent.id), { count: 1, at: now(), since, companyId });
      state.touch();
      if (startup) log.debug("watchdog: an agent was already paused when the helper started; its resume will be swept", { agent: agent.name, pausedSince: since ? new Date(since).toISOString() : "unknown" });
    }
    // Resumed while the helper was starting (or down), with no pause on record: the
    // activity log's latest resume after its latest pause, within a sweep's lifetime,
    // and not one a sweep already covered.
    if (activity) {
      for (const agent of agents.values()) {
        if (asleep(agent) || records.has(record.agentPaused(agent.id)) || records.has(record.agentResumed(agent.id))) continue;
        const a = activity.get(agent.id);
        if (!a?.resumedAt || !a.pausedAt || a.resumedAt < a.pausedAt || now() - a.resumedAt > RESUME_SWEEP_MS) continue;
        if (a.resumedAt <= (records.get(record.agentSwept(agent.id))?.resumedAt ?? 0) + CLOCK_SLACK_MS) continue;
        const entry = { count: 0, at: now(), since: a.pausedAt, resumedAt: a.resumedAt, companyId };
        records.set(record.agentResumed(agent.id), entry);
        state.touch();
        log("watchdog: an agent was resumed while the helper was starting; its issues Paperclip's recovery blocked during the pause are looked at once the resume has settled", {
          agent: agent.name, pausedSince: new Date(a.pausedAt).toISOString(), resumedAt: new Date(a.resumedAt).toISOString(), settleMin: config.watchdogResumeSettleMin,
        });
        resumed.push({ agent, entry });
      }
    }
    for (const agent of agents.values()) seenStatus.set(agent.id, agent.status);
    return resumed;
  }

  // Each agent's latest pause and resume in Paperclip's activity log ("agent.paused",
  // "agent.resumed", newest first): Map agentId → { pausedAt, resumedAt }, or null
  // when Paperclip doesn't answer.
  async function agentActivity(companyId) {
    const rows = await api.request("GET", `/api/companies/${companyId}/activity?entityType=agent&limit=${STARTUP_ACTIVITY_LIMIT}`).catch(() => null);
    if (!Array.isArray(rows)) return null;
    const out = new Map();
    for (const row of rows) {
      const field = row?.action === "agent.paused" ? "pausedAt" : row?.action === "agent.resumed" ? "resumedAt" : null;
      const at = ts(row?.createdAt);
      if (!field || !at || !row.entityId) continue;
      const entry = out.get(row.entityId) ?? {};
      entry[field] = Math.max(entry[field] ?? 0, at);
      out.set(row.entityId, entry);
    }
    return out;
  }

  // Is this issue waiting for a sweep under way (to be restored on a later tick, or
  // postponed)? Then 6 leaves it to the sweep. Issues the sweep turned down aren't held.
  // Any agent's sweep: a review participant's issue may be assigned to someone else.
  const resumeSweepHolds = (issue) => config.watchdogResumeSweep && [...sweepHeld.values()].some((held) => held.has(issue.id));

  // Resumed less than WATCHDOG_RESUME_SETTLE_MIN ago: neither the sweep nor 6 touches
  // the agent's blocked issues yet. A pause within the window ends the sweep before
  // anything was restored (trackPauses), and the next resume covers both pauses.
  const settleMs = config.watchdogResumeSettleMin * 60_000;
  function settling(agentId) {
    if (!settleMs) return false;
    const r = records.get(record.agentResumed(agentId));
    return Boolean(r && now() - (r.resumedAt ?? 0) < settleMs);
  }

  // Runs an agent may still be given this tick, shared by the resume sweep and 6: its
  // limit (WATCHDOG_RESUME_SWEEP_LIMIT, or its maxConcurrentRuns) less the runs it
  // has queued or going on any issue: those of issues restored earlier, and the wakes
  // Paperclip released on the resume. Unknown counts as full: better a tick later
  // than too many runs at once.
  function startSlots() {
    slots = new Map();
  }
  async function freeSlots(agent, companyId) {
    const limit = config.watchdogResumeSweepLimit || concurrencyOf(agent);
    const runs = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`).catch(() => null);
    if (!Array.isArray(runs)) return { left: 0 };
    const live = runs.filter((r) => r.agentId === agent.id && ACTIVE_RUN.has(r.status)).length;
    return { left: Math.max(0, limit - live) };
  }
  async function takeSlot(agent, companyId) {
    if (!slots.has(agent.id)) slots.set(agent.id, freeSlots(agent, companyId));
    const s = await slots.get(agent.id);
    if (s.left <= 0) return false;
    s.left -= 1;
    return true;
  }

  // Tracks pauses and resumes (for the settle window, even with the sweep off), then sweeps.
  async function checkResumes(companyId, agents, tickAt) {
    const tracked = await trackPauses(companyId, agents, tickAt);
    const resumed = tracked.filter(({ agent }) => !settling(agent.id));
    for (const { agent, entry } of resumed) {
      const seen = `${agent.id}:${entry.resumedAt}`;
      if (settledSeen.has(seen)) continue;
      settledSeen.add(seen);
      onSettled?.(companyId, agent);
    }
    if (!config.watchdogResumeSweep) return;
    if (!resumed.length) return;
    const blocked = (await listIssues(api, companyId, "blocked")).sort(sweepOrder);
    const fullIssues = new Map(); // issueId → its full read, shared by the agents swept this tick
    for (const { agent, entry } of resumed) {
      try {
        // Its own issues, and any other blocked issue touched since the pause began:
        // its review stage may wait on this agent (list rows carry no executionState).
        const mine = blocked.filter((i) => i.assigneeAgentId === agent.id || !i.updatedAt || ts(i.updatedAt) >= entry.since - CLOCK_SLACK_MS);
        await sweepAgent(agent, entry, mine, companyId, fullIssues);
      } catch (err) {
        log.warn("watchdog: resume sweep failed", { agent: agent.name, error: err.message });
      }
    }
  }

  // Each tick: every one of the agent's blocked issues is looked at, and as many
  // restored as the agent has free slots (takeSlot), so a resume never puts more than
  // its limit of runs in flight. The sweep ends at the first tick with nothing left to
  // restore and nothing postponed.
  async function sweepAgent(agent, entry, issues, companyId, fullIssues = new Map()) {
    const held = new Set();
    const restoredNow = [];
    let full = false;
    for (const issue of issues) {
      const verdict = await pauseBlocked(issue, agent, entry, fullIssues);
      if (verdict === "postponed") {
        held.add(issue.id);
        continue;
      }
      if (!verdict) continue;
      // Paused again since the tick began: the next resume restores it.
      if (full || !(await stillResumed(agent))) {
        held.add(issue.id);
        continue;
      }
      if (!config.dryRun && !(await takeSlot(agent, companyId))) {
        full = true;
        held.add(issue.id); // a later tick
        continue;
      }
      const result = await restoreIssue(issue, agent, verdict);
      if (result === "restored") restoredNow.push(issue.id);
      else if (result === "postponed") held.add(issue.id);
    }
    const key = record.agentResumed(agent.id);
    if (held.size) sweepHeld.set(agent.id, held);
    else sweepHeld.delete(agent.id);
    // In a dry run nothing changed, so nothing is used up: the sweep stays for the real run (until it expires).
    if (!held.size && !config.dryRun) {
      records.delete(key);
      records.set(record.agentSwept(agent.id), { count: 1, at: now(), resumedAt: entry.resumedAt });
      log.debug("watchdog: resume sweep finished", { agent: agent.name, restored: (entry.count ?? 0) + restoredNow.length });
    } else {
      records.set(key, { ...entry, count: (entry.count ?? 0) + restoredNow.length, at: now() });
    }
    state.touch();
  }

  // The agent as Paperclip has it now, just before a restore: paused or not runnable
  // again since the tick's list, nothing is restored (it would only be blocked again).
  async function stillResumed(agent) {
    const fresh = await api.request("GET", `/api/agents/${agent.id}`).catch(() => null);
    return Boolean(fresh) && !asleep(fresh);
  }

  // Is this an issue Paperclip's recovery blocked because the agent was paused, and
  // that nobody has touched since? The agent is either its assignee, or the
  // participant its pending review stage waits on. { latest, target, participant }
  // if so, "postponed" when Paperclip couldn't say right now, else false.
  async function pauseBlocked(row, agent, entry, fullIssues = new Map()) {
    if (row.status !== "blocked" || row.executionRunId || row.checkoutRunId) return false;
    if (!fullIssues.has(row.id)) fullIssues.set(row.id, await api.request("GET", `/api/issues/${row.id}`).catch(() => null));
    const full = fullIssues.get(row.id);
    if (!full) {
      fullIssues.delete(row.id); // read again next tick
      return "postponed";
    }
    if (full.status !== "blocked") return false;
    const asAssignee = full.assigneeAgentId === agent.id;
    const asParticipant = reviewParticipantOf(full) === agent.id;
    if (!asAssignee && !asParticipant) return false;
    // Blocked by another issue: that is why it is blocked, not the pause.
    if (holdingBlockers(full).length) return false;
    // The newest comment must be the recovery notice: anything after it (a person,
    // the agent, the watchdog) means someone has acted on the issue since.
    const comments = await api.request("GET", `/api/issues/${row.id}/comments?order=desc&limit=1`).catch(() => null);
    if (!Array.isArray(comments)) return "postponed";
    const latest = comments[0];
    const notice = recoveryNotice(latest);
    if (!notice) return false;
    // The notice names who couldn't be invoked: the assignee, or the review's participant.
    const participant = notice.kind === "participant";
    if (participant ? !asParticipant : !asAssignee) return false;
    const key = record.resumeRestore(full, latest.id);
    if (records.has(key) || dryRunSeen.has(key)) return false;
    // Posted while the agent was paused; one from before the pause was a real failure.
    const at = ts(latest.createdAt);
    if (!at || at < entry.since - CLOCK_SLACK_MS || at > entry.resumedAt + CLOCK_SLACK_MS) return false;
    if (statusChangedSince(full, at)) return false;
    let actions = null;
    try {
      actions = await api.request("GET", `/api/issues/${row.id}/recovery-actions`);
    } catch (err) {
      if (err.status !== 404) return "postponed"; // not knowing the action's cause, wait rather than guess
    }
    const list = [...(actions?.active ? [actions.active] : []), ...(Array.isArray(actions?.actions) ? actions.actions : [])];
    const action = (notice.actionId ? list.find((a) => a?.id === notice.actionId) : actions?.active) ?? null;
    const kind = participant ? participantRecoveryAction(action) : pauseRecoveryAction(action);
    // An action of another cause (a lost process, a failed workspace) isn't the pause.
    if (kind === false) return false;
    // Without the action, other recovery families post the same Recovery section:
    // only the "not invokable" notice, or a run the pause cancelled, is the pause's.
    if (kind === null && !notice.notInvokable) return false;
    const runs = await api.request("GET", `/api/issues/${row.id}/runs`).catch(() => null);
    if (!Array.isArray(runs)) return "postponed";
    if (runs.some((r) => ACTIVE_RUN.has(r.status))) return false;
    // A review whose participant couldn't be woken goes back to review: Paperclip
    // re-pends the stage with its participant and wakes it.
    if (participant) return { latest, participant, target: { status: "in_review", from: "review stage" } };
    return { latest, target: restoreStatus(full, action) };
  }

  // "restored" (or, in a dry run, would have been), "postponed" (try again next
  // tick), or false (refused: left to you).
  async function restoreIssue(row, agent, { latest, target, participant = false }) {
    const who = row.identifier ?? row.id;
    const key = record.resumeRestore(row, latest.id);
    const extra = { issue: who, agent: agent.name, status: target.status, from: target.from, ...(participant ? { role: "review participant" } : {}) };
    if (config.dryRun) {
      dryRunSeen.add(key);
      log("watchdog: would restore an issue blocked while its agent was paused (dry run)", extra);
      return "restored";
    }
    const comment = participant
      ? `${agentMention(agent)} was resumed: back to review, so the pending review stage goes on (the recovery block came from the pause).` +
        `\n\n${WATCHDOG_SIGNATURE}`
      : `${agentMention(agent)} was resumed: retrying the original owner (the recovery block came from the pause).` +
        `\n\n${WATCHDOG_SIGNATURE}`;
    try {
      // Status and comment in one request: a board user's comment wakes the assignee,
      // and so does the move out of blocked.
      await api.request("PATCH", `/api/issues/${row.id}`, { status: target.status, comment });
    } catch (err) {
      if (pausedRefusal(err)) {
        log.debug("watchdog: the issue is paused; restore postponed", { issue: who });
        return "postponed";
      }
      records.set(key, { count: 1, at: now(), failed: true });
      state.touch();
      log.warn("watchdog: Paperclip refused to restore an issue blocked while its agent was paused; left to you", { ...extra, error: err.message });
      return false;
    }
    records.set(key, { count: 1, at: now() });
    state.touch();
    stats.resumed += 1;
    log("watchdog: restored an issue Paperclip's recovery blocked while its agent was paused", extra);
    return "restored";
  }

  return {
    check: checkResumes,
    settling,
    // A resume whose issues are still being restored (or will be, once it settles).
    underway: (agentId) => records.has(record.agentResumed(agentId)),
    holds: resumeSweepHolds,
    takeSlot,
    startTick: startSlots,
    endTick(startedAt) {
      previousTickAt = startedAt;
    },
  };
}
