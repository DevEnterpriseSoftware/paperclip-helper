// Question cards (issue-thread interactions) addressed to an agent that isn't
// the issue's assignee.
//
// An agent asks a teammate a question by saving a card on its own issue with
// `addresseeAgentId` set to that teammate. Paperclip wakes the addressee
// (wakeReason "interaction_pending"), but its run admission then cancels that
// run before it starts, as "issue_assignee_changed": only the assignee, a
// review participant or a comment/mention wake may run on an issue, and the
// card's wake is none of them (decideQueuedRunStaleness in
// server/src/modules/run-dispatch/domain/policy.ts; checked against Paperclip
// 2026.1012.0 and main at f553471). The card then waits for good, and so does
// everything blocked behind the asker. Upstream: paperclipai/paperclip#11932
// (fixes open in #11939, #14378, #15991).
//
// Any run of the addressee may answer the card (respond, accept, reject,
// verdicts), whatever issue the run is for. So the watchdog gives the
// addressee an issue of its own that says which card to answer, and closes it
// once the card is settled. `pch blocked` lists these cards.

import { ACTIVE_RUN, ts } from "./util.mjs";

export const QUESTION_STATUSES = "todo,in_progress,in_review,blocked";

// The issue's pending cards; [] when Paperclip has no interactions route (404).
// Any other failure throws: an unread issue must not look like one with no cards.
export async function pendingCards(api, issueId) {
  const list = await api.request("GET", `/api/issues/${issueId}/interactions`).catch((err) => {
    if (err?.status === 404) return [];
    throw err;
  });
  return (Array.isArray(list) ? list : []).filter((c) => c?.status === "pending");
}

// A card only its addressee may answer, addressed to an agent other than the
// issue's assignee: Paperclip never lets that agent's wake run.
export function strandedCard(card, issue) {
  return Boolean(card?.addresseeAgentId) && card.addresseeAgentId !== issue?.assigneeAgentId;
}

// Did the addressee get a run on the issue since the card was saved? A run that
// started (or is about to) means the wake got through, so the card isn't stranded.
export function addresseeReached(card, runs) {
  const since = ts(card.createdAt);
  return (Array.isArray(runs) ? runs : []).some(
    (r) => r.agentId === card.addresseeAgentId && ts(r.createdAt) >= since && (ACTIVE_RUN.has(r.status) || r.status === "succeeded"),
  );
}

// The card's question(s) as one line of text, cut at `max` characters.
export function cardText(card, max = 300) {
  const p = card?.payload ?? {};
  const parts = [];
  for (const q of Array.isArray(p.questions) ? p.questions : []) if (q?.prompt) parts.push(q.prompt);
  if (!parts.length) for (const k of ["prompt", "title", "summary", "detail", "body"]) if (typeof p[k] === "string" && p[k]) parts.push(p[k]);
  if (!parts.length && card?.title) parts.push(card.title);
  if (!parts.length && card?.summary) parts.push(card.summary);
  const text = parts.join(" | ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The route that answers a card of this kind.
export function answerRoute(kind) {
  switch (kind) {
    case "ask_user_questions":
      return "POST /api/issues/{issueId}/interactions/{interactionId}/respond";
    case "request_confirmation":
    case "request_checkbox_confirmation":
      return "POST /api/issues/{issueId}/interactions/{interactionId}/accept (or /reject)";
    case "request_item_verdicts":
      return "POST /api/issues/{issueId}/interactions/{interactionId}/verdicts";
    default:
      return "the card's own route (respond, accept, reject or verdicts)";
  }
}

// The issue the watchdog gives the addressee.
export function relayIssue({ card, source, askerName, addresseeName }) {
  const who = source.identifier ?? source.id;
  const asker = askerName ?? "A teammate";
  const route = answerRoute(card.kind).replace("{issueId}", source.id).replace("{interactionId}", card.id);
  const title = `Answer ${askerName ? `${askerName}'s` : "a"} question on ${who}`;
  const description = [
    `${asker} asked you a question on [${who}](${prefixPath(who)}) ${ago(card.createdAt)}, and is waiting for your answer. ` +
      `Paperclip never delivered it: it cancels the wake a question card sends to anyone who isn't the issue's assignee. ` +
      `This issue is that wake.`,
    "",
    `> ${cardText(card, 1200)}`,
    "",
    "**What to do**",
    `- Read ${who}: its thread, plan and documents.`,
    `- Answer the card itself: \`${route}\` (card \`${card.id}\`, kind \`${card.kind}\`). Answering wakes ${askerName ?? "the asker"}; a comment doesn't record an answer.`,
    `- Make the call your instructions give you. If they reserve it for the board, say so in a comment on ${who} and leave the card for the board.`,
    "- Then mark this issue done. If the card is already answered or withdrawn, just mark this issue done.",
    "",
    `_Sent automatically by Paperclip Helper's watchdog for ${addresseeName ?? "the addressee"}._`,
  ].join("\n");
  return { title, description };
}

// A relative link Paperclip renders: /PREFIX/issues/PREFIX-123.
function prefixPath(identifier) {
  const m = /^([A-Z0-9]+)-\d+$/i.exec(String(identifier));
  return m ? `/${m[1].toUpperCase()}/issues/${identifier}` : `/issues/${identifier}`;
}

function ago(iso) {
  const ms = Date.now() - ts(iso);
  if (!ts(iso) || ms < 0) return "earlier";
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return "less than an hour ago";
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}
