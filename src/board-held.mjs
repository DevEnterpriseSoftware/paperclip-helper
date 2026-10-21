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

import { cardText } from "./questions.mjs";
import { ts } from "./util.mjs";

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

export { cardText };
