// Issues waiting on your review whose next move is really their agent's
// (watchdog, 12 and 13).
//
// While a review or approval stage waits on a person, Paperclip assigns the issue
// to that person. Nothing on it wakes an agent: a board comment wakes the
// assignee (you), and a mention wakes nobody on current Paperclip (#14577). Only
// a decision moves it: requesting changes (`status: in_progress` with a comment,
// from the participant) returns it to the stage's `returnAssignee`, the agent
// that submitted it. The watchdog makes that decision, as you, in two cases:
//
// 12. The agent asked you something with a card on the issue, and you answered
//     after the issue reached your stage. Paperclip wakes the issue's assignee
//     with the answer, which is you, so the agent never hears it.
//
// 13. Paperclip's review-round limit. After `maxReviewRounds` (default 3) agent
//     change requests in a row on one review stage, Paperclip hands the review to
//     the responsible person instead of back to the implementer
//     (issue-execution-policy.ts, "Rounds exhausted"). Off by default: that limit
//     is Paperclip's guard against two agents bouncing work for ever. Raising
//     `maxReviewRounds` in the issue's execution policy is the other way.

import { listIssues } from "./paperclip.mjs";
import { cardText } from "./questions.mjs";
import { ACTIVE_RUN, agentMention, approvalWaitingOn, asleep, mapLimit, pausedRefusal, ts, WATCHDOG_SIGNATURE } from "./util.mjs";

export const DEFAULT_MAX_REVIEW_ROUNDS = 3; // Paperclip's, issue-execution-policy.ts
const RESOLVED = new Set(["answered", "accepted", "rejected"]);
const MAX_QUOTE = 1500;

// Cards the returning agent asked on the issue that a person has since answered,
// and whose answer Paperclip would have delivered to the assignee: the card's
// continuationPolicy asks for a wake (routes/issues.ts, continuationPolicyAllowsWake).
// A card that asked for no wake, or a rejection of an accept-only card, was never
// meant to restart the agent.
export function answeredCards(cards, agentId) {
  return (Array.isArray(cards) ? cards : []).filter(
    (c) => c?.createdByAgentId === agentId && RESOLVED.has(c.status) && c.resolvedByUserId && ts(c.resolvedAt) && answerWakes(c),
  );
}

export function answerWakes(card) {
  const policy = card?.continuationPolicy ?? "wake_assignee"; // older Paperclip: every answer woke the assignee
  if (policy === "wake_assignee") return true;
  if (policy === "wake_assignee_on_accept") return card.status === "accepted" || card.status === "answered";
  // A rejected plan confirmation ("Request changes") always goes back to its author.
  return card.status === "rejected" && card.kind === "request_confirmation";
}

// The answer, as text an agent can act on.
export function answerText(card) {
  const r = card?.result ?? {};
  const parts = [];
  if (typeof r.summaryMarkdown === "string" && r.summaryMarkdown.trim()) parts.push(r.summaryMarkdown.trim());
  else if (Array.isArray(r.answers) && r.answers.length) {
    const questions = Array.isArray(card.payload?.questions) ? card.payload.questions : [];
    for (const a of r.answers) {
      const q = questions.find((x) => x?.id === a?.questionId);
      const labels = (a?.optionIds ?? []).map((id) => q?.options?.find((o) => o?.id === id)?.label ?? id);
      const chosen = [...labels, a?.otherText].filter((x) => typeof x === "string" && x.trim());
      parts.push(`${q?.prompt ? `${q.prompt}: ` : ""}${chosen.join("; ") || "(no answer)"}`);
    }
  } else if (Array.isArray(r.items) && r.items.length) {
    for (const item of r.items) parts.push(`${item.id}: ${item.verdict}${item.reason ? ` (${item.reason})` : ""}`);
  }
  if (!parts.length) {
    const outcome = card?.status === "accepted" || card?.status === "rejected" ? card.status : r.outcome ?? card?.status;
    parts.push(`${outcome ?? "answered"}${r.reason ? `: ${r.reason}` : ""}`);
  } else if (r.reason && !parts.some((p) => p.includes(r.reason))) {
    parts.push(r.reason);
  }
  return clip(parts.join("\n"));
}

export function quote(text) {
  return clip(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function clip(text) {
  const s = String(text ?? "").trim();
  return s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE - 1)}…` : s;
}

// Paperclip's review-round escalation: a review stage pending with a person who
// isn't one of the stage's participants, after the agents used up their rounds.
export function escalatedReview(issue, userId) {
  const st = issue?.executionState;
  if (issue?.status !== "in_review" || st?.status !== "pending" || st.currentStageType !== "review") return false;
  if (st.currentParticipant?.type !== "user" || st.currentParticipant.userId !== userId) return false;
  if (st.returnAssignee?.type !== "agent" || !st.returnAssignee.agentId) return false;
  const policy = issue.executionPolicy;
  const max = Number(policy?.maxReviewRounds) > 0 ? Number(policy.maxReviewRounds) : DEFAULT_MAX_REVIEW_ROUNDS;
  if (Number(st.changesRequestedCount ?? 0) < max) return false;
  const stage = reviewStage(issue);
  // A stage that names you as a reviewer is your own review, not an escalation.
  if (stage?.participants?.some((p) => p?.type === "user" && p.userId === userId)) return false;
  return true;
}

// The issue's current stage, from its execution policy.
export function reviewStage(issue) {
  const stages = Array.isArray(issue?.executionPolicy?.stages) ? issue.executionPolicy.stages : [];
  return stages.find((s) => s?.id === issue?.executionState?.currentStageId) ?? null;
}

// ---------------------------------------------------------------- the check (watchdog.mjs runs it each tick)

// Issues waiting on your review are looked at once per stall window.
const BOARD_STATUSES = "in_review";
// How long after you answer an agent's card the watchdog waits before returning
// the issue: time for you to approve it, or send it back yourself.
const ANSWER_WAIT_MS = 30 * 60_000;
const CONCURRENCY = 4;

// Checks 12 and 13. From the watchdog: its records (keys from `record`), `agentFor`
// (an agent by id, cached for the tick), `quiet` (the issue has been still for the
// stall window) and `startedRuns` (the issue's runs Paperclip didn't refuse).
export function createBoardHeldCheck({ ctx, records, state, stats, dryRunSeen, record, agentFor, quiet, startedRuns }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;
  const boardScanAt = new Map(); // companyId → when issues waiting on your review were last looked at


  // Returns the issue to its implementer as your "changes requested" decision:
  // status in_progress with the comment, in one PATCH (Paperclip's rule). Once
  // per key; a paused task or a refused decision is logged and tried no more.
  async function returnToAgent(issue, key, agent, message, logExtra) {
    if (records.has(key)) return false;
    const who = issue.identifier ?? issue.id;
    const comment = `${agentMention(agent)} ${message}\n\n${WATCHDOG_SIGNATURE}`;
    if (config.dryRun) {
      if (dryRunSeen.has(key)) return false;
      dryRunSeen.add(key);
      log("watchdog: would return the issue to its agent (dry run)", { issue: who, agent: agent.name, ...logExtra });
      return false;
    }
    // Several requests have passed since the issue was read. If you decided in the
    // meantime (approved it, say), in_progress would reopen it: read it again.
    const { userId } = await ctx.identity();
    const current = await api.request("GET", `/api/issues/${issue.id}`).catch(() => null);
    if (
      !current ||
      !approvalWaitingOn(current, userId) ||
      (current.executionState?.lastDecisionId ?? null) !== (issue.executionState?.lastDecisionId ?? null) ||
      current.executionState?.returnAssignee?.agentId !== agent.id
    ) {
      log.debug("watchdog: the issue changed before it could be returned; looked at again next time", { issue: who });
      return false;
    }
    try {
      await api.request("PATCH", `/api/issues/${issue.id}`, { status: "in_progress", comment });
    } catch (err) {
      if (pausedRefusal(err)) {
        log.debug("watchdog: the issue is paused; return postponed", { issue: who });
        return false;
      }
      records.set(key, { count: 1, at: now(), failed: true });
      state.touch();
      log.warn("watchdog: Paperclip refused to return the issue to its agent; left to you", { issue: who, ...logExtra, error: err.message });
      return false;
    }
    records.set(key, { count: 1, at: now() });
    state.touch();
    stats.returned += 1;
    log("watchdog: returned the issue to its agent", { issue: who, agent: agent.name, ...logExtra });
    return true;
  }

  async function checkWaitingOnYou(companyId, agents) {
    if (!config.watchdogDeliverAnswers && !config.watchdogReturnEscalatedReviews) return;
    const last = boardScanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    boardScanAt.set(companyId, now());
    const { userId } = await ctx.identity();
    if (!userId) return;
    const issues = (await listIssues(api, companyId, BOARD_STATUSES)).filter(
      (i) => i.assigneeUserId === userId && !i.assigneeAgentId && !i.executionRunId && !i.checkoutRunId && quiet(i),
    );
    await mapLimit(issues, CONCURRENCY, async (row) => {
      try {
        const issue = await api.request("GET", `/api/issues/${row.id}`).catch(() => null);
        if (!issue || !approvalWaitingOn(issue, userId)) return;
        const back = issue.executionState?.returnAssignee;
        if (back?.type !== "agent" || !back.agentId) return;
        const agent = await agentFor(back.agentId, agents).catch(() => null);
        // Returning it to an agent Paperclip can't invoke only parks it.
        if (!agent || asleep(agent)) return;
        const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => null);
        if (!Array.isArray(runs) || runs.some((r) => ACTIVE_RUN.has(r.status))) return;
        const cards = await api.request("GET", `/api/issues/${issue.id}/interactions`).catch(() => []);
        // An escalated review is only ever returned by 13: returning it as you for an
        // answer would reset Paperclip's round count behind WATCHDOG_RETURN_ESCALATED_REVIEWS.
        if (escalatedReview(issue, userId)) {
          if (config.watchdogReturnEscalatedReviews) await returnEscalated(issue, agent, cards, runs, agents);
          return;
        }
        if (config.watchdogDeliverAnswers) await deliverAnswer(issue, agent, cards, runs);
      } catch (err) {
        log.warn("watchdog: check of an issue waiting on your review failed", { issue: row.identifier ?? row.id, error: err.message });
      }
    });
  }

  // 12. The agent's card, answered by a person, with no run of the agent since.
  async function deliverAnswer(issue, agent, cards, runs) {
    const answered = answeredCards(cards, agent.id).sort((a, b) => ts(b.resolvedAt) - ts(a.resolvedAt));
    const card = answered[0];
    if (!card) return false;
    const answeredAt = ts(card.resolvedAt);
    // Give you time to decide yourself after answering (approve, or send it back with a note).
    if (now() - answeredAt < Math.max(stallMs, ANSWER_WAIT_MS)) return true;
    // A run of the agent that started after the answer, or was still going when it
    // came, has seen it (Paperclip hands a running agent the answer).
    if (startedRuns(runs).some((r) => r.agentId === agent.id && (ACTIVE_RUN.has(r.status) || ts(r.finishedAt) >= answeredAt || ts(r.startedAt ?? r.createdAt) >= answeredAt))) return false;
    const key = record.answer(card);
    if (records.has(key)) return false;
    const what = cardText(card, 300);
    return returnToAgent(
      issue,
      key,
      agent,
      `your card on this issue${what ? ` ("${what}")` : ""} was answered, but the answer reached no one: the issue was ` +
        `waiting on the board's review, so Paperclip woke no agent. The answer:\n\n${quote(answerText(card))}\n\n` +
        `The watchdog has returned the issue to you. Act on the answer (check what it reports), then hand the issue back for ` +
        `review; if nothing needs to change, say so and resubmit as it is.`,
      { reason: "answered card", card: card.id },
    );
  }

  // 13. A review Paperclip escalated to you after the agents used up their rounds.
  async function returnEscalated(issue, agent, cards, runs, agents) {
    const decisionId = issue.executionState?.lastDecisionId ?? null;
    const seen = record.escalatedSeen(issue, decisionId);
    if (records.has(seen)) return;
    const who = issue.identifier ?? issue.id;
    // Waiting on a person for something else (a card addressed to one): that comes first.
    const waitingOnPerson = (Array.isArray(cards) ? cards : []).some((c) => c?.status === "pending" && (c.addresseeUserId || !c.addresseeAgentId));
    if (waitingOnPerson) return;
    const comments = await api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=20`).catch(() => null);
    if (!Array.isArray(comments)) return;
    // The reviewer's request: the latest comment by one of the stage's reviewers, or
    // else by any agent other than the implementer.
    const reviewers = new Set((reviewStage(issue)?.participants ?? []).filter((p) => p?.type === "agent").map((p) => p.agentId));
    const request =
      comments.find((c) => c?.authorAgentId && reviewers.has(c.authorAgentId)) ??
      comments.find((c) => c?.authorAgentId && c.authorAgentId !== agent.id);
    if (!request) return;
    // The implementer has run since that request: it isn't waiting to hear it.
    if (startedRuns(runs).some((r) => r.agentId === agent.id && ts(r.startedAt ?? r.createdAt) > ts(request.createdAt))) return;
    const budget = record.escalated(issue);
    const used = records.get(budget)?.count ?? 0;
    records.set(seen, { count: 1, at: now() });
    state.touch();
    if (used >= config.watchdogMaxNudges) {
      log.warn("watchdog: a review Paperclip escalated to you again; the watchdog's returns are used up, so it's yours", {
        issue: who,
        rounds: issue.executionState?.changesRequestedCount ?? null,
        hint: "Approve, request changes yourself, or raise maxReviewRounds in the issue's execution policy.",
      });
      return;
    }
    const reviewer = await agentFor(request.authorAgentId, agents).catch(() => null);
    const rounds = issue.executionState?.changesRequestedCount ?? null;
    const done = await returnToAgent(
      issue,
      `${budget}:${used + 1}`,
      agent,
      `${reviewer?.name ?? "The reviewer"} requested changes again, and after ${rounds ?? "several"} rounds Paperclip handed the ` +
        `review to the board instead of back to you (its review-round limit). The watchdog returns it to you with the latest ` +
        `request:\n\n${quote(request.body)}\n\nPlease address it and resubmit. If you think the request is wrong, or it needs ` +
        `a decision from the board, say so in a comment instead of resubmitting unchanged.`,
      { reason: "escalated review", rounds, reviewer: reviewer?.name ?? null },
    );
    if (done) {
      records.set(budget, { count: used + 1, at: now() });
      state.touch();
    } else {
      records.delete(seen); // not returned (dry run, paused): look again next time
      state.touch();
    }
  }

  return { check: checkWaitingOnYou };
}
