// `pch answer ISSUE CARD "text"`: answer a question card from the command line.
//
// Paperclip's respond endpoint takes the answers the UI sends: per question its
// chosen option ids, and a typed answer as `otherText` (with no option id: the
// UI doesn't send the free-text option's id). A card with one question is
// answered with an option whose label or id matches the text, else with the text
// itself when the question takes a typed answer.

// The card on the issue: by id, or a unique start of its id.
export function findCard(cards, ref) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c?.status === "pending");
  const want = String(ref ?? "").toLowerCase();
  const matches = want.length >= 4 ? list.filter((c) => String(c.id).toLowerCase().startsWith(want)) : [];
  if (matches.length === 1) return matches[0];
  const listing = list.map((c) => `  ${c.id}  ${c.kind}: ${questionText(c)}`).join("\n") || "  (none)";
  const why = want.length < 4 ? `"${ref ?? ""}" is too short: give at least the first 4 characters of the card's id` : `${matches.length ? "Several pending cards start with" : "No pending card matches"} "${ref}"`;
  throw new Error(`${why}. Pending cards on this issue:\n${listing}`);
}

const questionText = (card) => (card?.payload?.questions ?? []).map((q) => q.prompt).filter(Boolean).join(" / ").slice(0, 120) || "(no question text)";

// The respond body for a one-question card: { answers: [...] }, and a label for what was answered.
export function answerFor(card, text) {
  if (card?.kind !== "ask_user_questions") {
    throw new Error(`That card is a ${card?.kind ?? "card of unknown kind"}, not questions: answer it in Paperclip.`);
  }
  const questions = card.payload?.questions ?? [];
  if (questions.length !== 1) {
    throw new Error(`That card asks ${questions.length} questions; \`pch answer\` answers a card with one. Answer it in Paperclip:\n${questions.map((q) => `  ${q.id}: ${q.prompt}`).join("\n")}`);
  }
  const value = String(text ?? "").trim();
  if (!value) throw new Error('usage: pch answer ISSUE CARD "answer"');
  const [q] = questions;
  const prompt = q.prompt ?? q.id;
  if (q.selectionMode === "multi") throw new Error(`"${prompt}" takes several answers: answer it in Paperclip.`);
  const options = (q.options ?? []).filter((o) => !o.freeText);
  const same = (a) => String(a ?? "").toLowerCase() === value.toLowerCase();
  // A label first: an option's id can read like another option's label.
  const picked = options.find((o) => same(o.label)) ?? options.find((o) => same(o.id));
  if (picked) return { body: { answers: [{ questionId: q.id, optionIds: [picked.id] }] }, prompt, answer: picked.label ?? picked.id };
  // A text question takes a typed answer even if Paperclip didn't store its free-text option.
  const typed = q.answerMode === "text" || q.allowOther || (q.options ?? []).some((o) => o.freeText);
  if (!typed) {
    throw new Error(options.length ? `"${prompt}" takes one of: ${options.map((o) => o.label ?? o.id).join(", ")}.` : `"${prompt}" takes no typed answer and has no options: answer it in Paperclip.`);
  }
  return { body: { answers: [{ questionId: q.id, optionIds: [], otherText: value }] }, prompt, answer: value };
}
