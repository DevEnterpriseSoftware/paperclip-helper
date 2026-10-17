// `pch blocked`: why every blocked issue is blocked, what the chains of blocked
// issues are waiting on at the bottom, and every question card that is waiting
// on someone: a teammate Paperclip never woke for it, a person, or anyone.
//
// Paperclip's Decisions page lists reviews waiting on you, and the Approvals
// page formal approvals. Neither shows a blocked issue whose chain ends at a
// question card, or a card addressed to an agent that was never delivered
// (questions.mjs), so a board of blocked issues can look like work waiting on
// you when it is waiting on an agent, or the other way round.

import { companyAgents, listIssues } from "./paperclip.mjs";
import { approvalWaitingOn, mapLimit, ts } from "./util.mjs";
import { cardText, pendingCards, QUESTION_STATUSES, strandedCard } from "./questions.mjs";
import { readJson } from "./store.mjs";

const CLOSED = new Set(["done", "cancelled"]);
const CONCURRENCY = 6;

// Why one blocked issue is blocked, from Paperclip's blocker diagnostics, its
// recovery actions and its execution hold. Pure, for tests.
export function blockedCause({ blockers, recovery, hold }) {
  const linked = Array.isArray(blockers) ? blockers : [];
  // Paperclip says per blocker whether it still blocks; older releases only give its status.
  const open = linked.filter((b) => (typeof b.isUnresolved === "boolean" ? b.isUnresolved : !CLOSED.has(b.status)));
  if (open.length) return { kind: "waiting", open };
  if (linked.some((b) => b.isPendingFinalize)) return { kind: "finalizing" };
  if (linked.length) return { kind: "blockersDone" };
  if (recovery) return { kind: "parked", recovery };
  if (hold) return { kind: "held", hold };
  return { kind: "note" };
}

// Every blocked issue's open blockers, followed down through other blocked
// issues to the ones that aren't blocked: the roots everything waits on.
// `waits` maps a blocked issue's id to its open blockers' ids. Returns
// rootId → the set of blocked issue ids that (directly or not) wait on it.
export function chainRoots(waits) {
  const roots = new Map();
  for (const start of waits.keys()) {
    const seen = new Set([start]);
    const stack = [...(waits.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (waits.has(id)) stack.push(...waits.get(id));
      else {
        if (!roots.has(id)) roots.set(id, new Set());
        roots.get(id).add(start);
      }
    }
  }
  return roots;
}

// Who a card waits on, in words: "Gilfoyle", "you", "a board user", "anyone".
function addresseeOf(card, me, nameOf) {
  if (card.addresseeAgentId) return nameOf(card.addresseeAgentId);
  if (card.addresseeUserId) return card.addresseeUserId === me ? "you" : "a board user";
  const policy = card.effectiveResolverPolicy ?? card.resolverPolicy;
  return policy === "human_only" ? "a person (human only)" : "anyone";
}

function age(iso, now) {
  const ms = now - ts(iso);
  if (!ts(iso) || ms < 0) return "";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

const pad = (s, n) => String(s ?? "").padEnd(n);

export async function blocked(ctx, out) {
  const { api, config } = ctx;
  const me = await ctx.identity();
  const now = ctx.now();
  const routed = readJson(config.stateFile, {})?.nudges ?? {};
  const routedTo = (card) => routed[`question:${card.id}`]?.relay ?? null;
  let anything = false;

  for (const companyId of me.companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => ({}));
    const agents = await companyAgents(api, companyId).catch(() => []);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const nameOf = (id) => (id ? names.get(id) ?? String(id).slice(0, 8) : null);
    const label = company.issuePrefix ?? company.name ?? companyId;

    // Every open issue's pending cards (blocked ones included).
    const open = await listIssues(api, companyId, QUESTION_STATUSES);
    const byId = new Map(open.map((i) => [i.id, i]));
    const cards = [];
    await mapLimit(open, CONCURRENCY, async (issue) => {
      for (const card of await pendingCards(api, issue.id).catch(() => [])) cards.push({ card, issue });
    });

    // Every blocked issue's cause.
    const blockedIssues = open.filter((i) => i.status === "blocked");
    const causes = new Map();
    await mapLimit(blockedIssues, CONCURRENCY, async (issue) => {
      const diag = await api.request("GET", `/api/issues/${issue.id}/diagnostics/blockers`).catch(() => null);
      const blockers = Array.isArray(diag?.blockers) ? diag.blockers : [];
      let recovery = null;
      let hold = null;
      if (!blockers.length) {
        const [parked, full] = await Promise.all([
          api.request("GET", `/api/issues/${issue.id}/recovery-actions`).catch(() => null),
          api.request("GET", `/api/issues/${issue.id}`).catch(() => null),
        ]);
        recovery = parked?.active ?? null;
        hold = full?.executionBlocker ?? null;
      }
      const cause = blockedCause({ blockers, recovery, hold });
      if (cause.kind === "note") {
        const c = await api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=1`).catch(() => []);
        cause.lastComment = Array.isArray(c) ? c[0] ?? null : null;
      }
      causes.set(issue.id, cause);
    });

    if (!blockedIssues.length && !cards.length) {
      out(`${label}: nothing blocked, and no question card waiting.`);
      continue;
    }
    anything = true;
    out(`${label}: ${blockedIssues.length} blocked issue${blockedIssues.length === 1 ? "" : "s"}`);
    const group = (kind) => blockedIssues.filter((i) => causes.get(i.id)?.kind === kind);
    const ident = (i) => i.identifier ?? i.id;

    // Waiting on other open issues: follow the chains to their roots.
    const waiting = group("waiting");
    if (waiting.length) {
      const blockerId = (b) => b.id ?? b.identifier;
      const waits = new Map(waiting.map((i) => [i.id, causes.get(i.id).open.map(blockerId)]));
      // A blocker given by identifier maps back to the issue id where we know it.
      const idOf = new Map(open.map((i) => [i.identifier, i.id]));
      for (const [k, v] of waits) waits.set(k, v.map((x) => idOf.get(x) ?? x));
      const roots = [...chainRoots(waits)].sort((a, b) => b[1].size - a[1].size);
      out(`  ${waiting.length} wait on other open issues. Those chains end at ${roots.length} issue${roots.length === 1 ? "" : "s"}:`);
      const rows = await mapLimit(roots, CONCURRENCY, async ([rootId, held]) => {
        const root = (await api.request("GET", `/api/issues/${rootId}`).catch(() => null)) ?? byId.get(rootId) ?? { id: rootId };
        const rootCards = cards.filter((c) => c.issue.id === root.id).map((c) => c.card);
        return { root, held: held.size, waitsOn: describeRoot(root, rootCards, me.userId, nameOf, routedTo, now) };
      });
      for (const r of rows) {
        out(`    ${pad(ident(r.root), 10)} ${pad(r.root.status, 12)} ${pad(nameOf(r.root.assigneeAgentId) ?? "", 14)} holds ${pad(r.held, 3)} ← ${r.waitsOn}`);
      }
    }
    const say = (list, text) => {
      if (!list.length) return;
      out(`  ${list.length} ${text}`);
      out(`    ${list.map(ident).join(", ")}`);
    };
    say(group("blockersDone"), `have every blocker done. The watchdog wakes them once quiet for ${config.watchdogStallSec}s.`);
    say(
      group("finalizing"),
      `wait on a done blocker whose workspace clean-up failed. ${config.watchdogHealFailedFinalize ? "The watchdog repairs them." : "WATCHDOG_HEAL_FAILED_FINALIZE is off: `pch why` each."}`,
    );
    say(group("parked"), "were parked by Paperclip's recovery. `pch why ISSUE` says which ones the watchdog un-parks.");
    say(group("held"), "are held for reconciliation after a stopped run. `pch why ISSUE`, then `pch release ISSUE` if it recommends it.");
    const notes = group("note");
    if (notes.length) {
      out(`  ${notes.length} blocked by their agent with no blocking issue linked. These wait on someone, often you:`);
      for (const i of notes) {
        const c = causes.get(i.id).lastComment;
        const text = c?.body ? `"${String(c.body).replace(/\s+/g, " ").slice(0, 110)}"` : "(no comment)";
        out(`    ${pad(ident(i), 10)} ${pad(nameOf(i.assigneeAgentId) ?? "", 14)} ${text}`);
      }
      out("    `pch why ISSUE` for each, then answer in a comment.");
    }

    // Question cards.
    const stranded = cards.filter(({ card, issue }) => strandedCard(card, issue));
    const rest = cards.filter((c) => !stranded.includes(c));
    if (stranded.length) {
      out("");
      out(`  ${stranded.length} question card${stranded.length === 1 ? "" : "s"} addressed to an agent that isn't the issue's assignee. Paperclip never wakes that agent for them:`);
      for (const { card, issue } of stranded.sort((a, b) => ts(a.card.createdAt) - ts(b.card.createdAt))) {
        const relay = routedTo(card);
        const state = relay
          ? `routed to ${relay}`
          : config.watchdogRouteQuestions
            ? "the watchdog routes it"
            : "not routed (WATCHDOG_ROUTE_QUESTIONS is off)";
        out(
          `    ${pad(ident(issue), 10)} ${pad(`${nameOf(card.createdByAgentId) ?? "?"} → ${nameOf(card.addresseeAgentId)}`, 24)} ${pad(age(card.createdAt, now), 8)} ${state}`,
        );
        out(`      ${cardText(card, 140)}`);
      }
    }
    if (rest.length) {
      out("");
      out(`  ${rest.length} other question card${rest.length === 1 ? "" : "s"} waiting:`);
      for (const { card, issue } of rest.sort((a, b) => ts(a.card.createdAt) - ts(b.card.createdAt))) {
        out(`    ${pad(ident(issue), 10)} ${pad(`${nameOf(card.createdByAgentId) ?? "?"} → ${addresseeOf(card, me.userId, nameOf)}`, 24)} ${pad(age(card.createdAt, now), 8)} ${cardText(card, 90)}`);
      }
    }
    out("");
  }
  if (!anything) return;
  out("`pch why ISSUE` explains any one of them.");
}

// What a root issue (not blocked itself, but blocking others) is waiting on.
function describeRoot(root, rootCards, me, nameOf, routedTo, now) {
  if (approvalWaitingOn(root, me)) return "its approval is waiting on you (Decisions)";
  const card = rootCards[0];
  if (card) {
    if (strandedCard(card, root)) {
      const relay = routedTo(card);
      return `a question card to ${nameOf(card.addresseeAgentId)}, ${age(card.createdAt, now)} old, never delivered${relay ? ` (routed to ${relay})` : ""}`;
    }
    return `a question card for ${addresseeOf(card, me, nameOf)}, ${age(card.createdAt, now)} old`;
  }
  const p = root.executionState?.status === "pending" ? root.executionState.currentParticipant : null;
  if (p?.type === "agent") return `review by ${nameOf(p.agentId)}`;
  if (p?.type === "user") return p.userId === me ? "a review waiting on you" : "a review by a board user";
  if (root.executionRunId || root.checkoutRunId) return "a run in progress";
  if (root.status === "blocked") return "blocked itself, with no open blocker linked (listed below)";
  if (root.status === "in_review") return "in review with no reviewer or card: `pch why` it";
  return root.status ?? "?";
}
