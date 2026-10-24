// Decisions: where the relay records what you did on a pull request.
//
// A PR names one or more Paperclip issues (identifiers.mjs). resolveTarget() finds
// the one whose approval is waiting on you; decide() records your approval or
// changes requested there, or, when no issue is waiting on you, keeps your text as
// a comment and says why it wasn't a decision. The relay (relay.mjs) calls these for
// merges, reviews and PR comments; the conflict sweep (conflicts.mjs) and the
// merge-queue handler (merge-queue.mjs) to send a PR back to its agent.
//
// decide() returns { identifier, action, status, ... } and, when nothing was
// recorded as a decision, a `code`:
//   "not-found"     none of the issues the PR names exists in Paperclip
//   "already-done"  an approval for an issue that is already done
//   "not-waiting"   no decision on the PR's issues waits on you: your text went in
//                   as a comment on the first one
//   "ambiguous"     several wait on you and none lists this PR (`waitingOn`): your
//                   text went in as a comment, and nothing was decided
// decisionNote() turns that into the note the relay leaves on the PR.

import { approvalWaitingOn, DECISION_STATUS, prLabel, RELAYED_SIGNATURE, signed, ts } from "./util.mjs";
import { issueActivity, stagesWipe } from "./stages.mjs";
import { appendNote } from "./quiet-notes.mjs";

// Stages a single merge may approve after the first, when each is waiting on you.
const MAX_CHAINED_STAGES = 3;
// Issues looked at for one PR, counting blockers and deeper subtasks.
const MAX_RELATED_ISSUES = 40;
// The slack between a move to review and the hand-off comment sent with it.
const HAND_OFF_SLACK_MS = 2 * 60_000;
// The issue statuses a merge may close when its review stages were wiped.
const CLOSABLE = new Set(["todo", "in_progress", "in_review"]);

// Whether a work product is this PR. Agents create PR work products themselves,
// in no fixed shape, so accept the PR's URL, metadata.repo ("owner/repo") plus
// metadata.number, or an externalId of "owner/repo#N". A bare number could be
// any repository's.
export function isWorkProductOf(wp, pr) {
  if (wp?.type !== "pull_request") return false;
  const url = String(pr?.html_url ?? "").toLowerCase();
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return false;
  const [repo, number] = [m[1], Number(m[2])];
  return (
    String(wp.url ?? "").toLowerCase().replace(/\/+$/, "") === url ||
    (String(wp.metadata?.repo ?? "").toLowerCase() === repo && Number(wp.metadata?.number) === number) ||
    String(wp.externalId ?? "").toLowerCase() === `${repo}#${number}`
  );
}

// What to say on the PR when a decision you asked for wasn't recorded; null when
// it was. `asked` names what you did ("`/changes`", "Request changes"); `result`
// is decide()'s; `identifiers` are the issues the PR names.
export function decisionNote({ kind, asked, result, identifiers, prefixLabel = "Paperclip", fromComment = false }) {
  if (result && result.action === kind) return null;
  if (result && /dry run/.test(String(result.action))) return null;
  const named = identifiers?.length ? identifiers.join(", ") : null;
  const pch = kind === "approve" ? "pch approve" : "pch changes";
  const target = result?.identifier ?? null;
  const lines = [`**${asked} was not recorded as a decision.**`, ""];
  let copied = false;
  if (!named) {
    lines.push(
      `This PR names no ${prefixLabel} issue in its title or body${fromComment ? " (for comments GitHub doesn't send the branch, so its name isn't read)" : " or branch"}, so nothing was sent to Paperclip.`,
    );
  } else if (result?.code === "not-found") {
    lines.push(`None of the issues this PR names (${named}) was found in Paperclip.`);
  } else if (result?.code === "already-done") {
    lines.push(`${target} is already done.`);
  } else if (result?.code === "ambiguous") {
    lines.push(`${result.waitingOn.join(", ")} all wait on you, and none of them lists this PR, so the relay didn't guess.`);
    copied = true;
  } else if (result?.code === "not-waiting") {
    const where = [result.status, result.stageType ? `${result.stageType} stage` : null].filter(Boolean).join(", ");
    lines.push(`This PR names ${named}. None of those issues, their subtasks or their blockers has a decision waiting on you, so the relay used the first one, ${target}${where ? ` (${where})` : ""}.`);
    copied = true;
  } else {
    lines.push(`The relay did \`${result?.action ?? "nothing"}\`${target ? ` on ${target}` : ""}${result?.reason ? `: ${result.reason}` : ""}.`);
  }
  if (copied && target) lines.push("", `Your text was added to ${target} as a comment. Nothing else changed.`);
  lines.push(
    "",
    `To decide on the issue you meant, run \`${pch} <issue> "…"\` (\`pch check <issue>\` shows who its decision is waiting on)` +
      (named ? "." : ", or add the issue's identifier to this PR's title or body and comment again."),
  );
  return lines.join("\n");
}

export function createDecisions(ctx) {
  const { config, api, log } = ctx;

  // A PR can name the parent issue (its title and branch come from the parent's
  // workspace) while the review and approval stages sit on a child issue. So look
  // at every issue the PR names, plus their subtasks, and pick the one whose
  // approval is waiting on you. When none of those is waiting, look further: at
  // the issues blocking them and at deeper subtasks (a PR that names a blocked
  // issue while the work in review is its blocker). With several waiting, prefer
  // one that records this PR as a work product; if none does, decide nothing and
  // comment. With none waiting, the first issue the PR names gets a comment.
  // `own: true` looks only at the PR's own issue, the first one it names (title,
  // then branch, then body), and that issue's subtasks: where a PR's link goes. A
  // blocker, or another issue the body mentions, may be the right place for your
  // merge decision, but a link there shows the PR as that issue's.
  //
  // Returns null (no issue found) or { issue, waiting, via?, ambiguous? }.
  async function resolveTarget(pr, identifiers, { own = false } = {}) {
    const { userId } = await ctx.identity();
    const seen = new Map(); // identifier → issue
    const add = (issue) => {
      const key = issue?.identifier ?? issue?.id;
      if (!key || seen.has(key)) return false;
      seen.set(key, issue);
      return true;
    };
    // Only "no such issue" (or not one this key may see) means not found. Anything
    // else (Paperclip down, a revoked key) fails the delivery, so GitHub's Redeliver
    // can try again, rather than losing the decision as "no issue found".
    const missing = (fallback) => (err) => {
      if (err?.status === 404 || err?.status === 403) return fallback;
      throw err;
    };
    const get = (ref) => api.request("GET", `/api/issues/${encodeURIComponent(ref)}`).catch(missing(null));
    const subtasks = async (issue) => {
      const rows = await api
        .request("GET", `/api/companies/${issue.companyId}/issues?parentId=${issue.id}&limit=100`)
        .catch(missing([]));
      const out = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        // List rows carry executionState: null, so read any subtask in review in full.
        out.push((row.status === "in_review" ? await get(row.id) : null) ?? row);
      }
      return out;
    };

    const named = [];
    for (const identifier of identifiers) {
      const issue = await get(identifier);
      if (!issue?.id) continue;
      add(issue);
      named.push(issue);
      for (const child of await subtasks(issue)) add(child);
      if (own) break;
    }
    if (seen.size === 0) return null;
    const first = seen.values().next().value;
    const isWaiting = (issue) => approvalWaitingOn(issue, userId);
    let waiting = [...seen.values()].filter(isWaiting);

    const via = new Map(); // identifier → how a further issue was reached
    if (waiting.length === 0 && !own) {
      const namedIds = new Set(named.map((i) => i.id));
      const queue = [...seen.values()];
      const walked = new Set();
      while (queue.length && seen.size < MAX_RELATED_ISSUES) {
        const issue = queue.shift();
        if (!issue?.id || walked.has(issue.id)) continue;
        walked.add(issue.id);
        const label = issue.identifier ?? issue.id;
        // Blockers are only on the full issue, and list rows may not be full.
        const full = Array.isArray(issue.blockedBy) ? issue : await get(issue.id);
        const related = [];
        for (const blocker of full?.blockedBy ?? []) {
          const found = blocker?.id ? await get(blocker.id) : null;
          if (found?.id) related.push([found, `blocks ${label}`]);
        }
        // The named issues' own subtasks were read above.
        if (!namedIds.has(issue.id)) {
          for (const child of await subtasks(issue)) related.push([child, `subtask of ${label}`]);
        }
        for (const [other, how] of related) {
          if (seen.size >= MAX_RELATED_ISSUES) break;
          if (!add(other)) continue;
          via.set(other.identifier ?? other.id, how);
          queue.push(other);
        }
      }
      waiting = [...seen.values()].filter(isWaiting);
    }
    const found = (issue, extra = {}) => {
      const how = via.get(issue.identifier ?? issue.id);
      return { issue, waiting: true, ...(how ? { via: how } : {}), ...extra };
    };

    if (waiting.length === 0) return { issue: first, waiting: false };
    if (waiting.length === 1) return found(waiting[0]);
    for (const issue of waiting) {
      const products = await api.request("GET", `/api/issues/${issue.id}/work-products`).catch(missing([]));
      if ((Array.isArray(products) ? products : []).some((wp) => isWorkProductOf(wp, pr))) return found(issue);
    }
    // Several wait on you and none records this PR: don't guess which to decide.
    // A link then goes on the PR's own issue.
    if (own) return { issue: first, waiting: false };
    return { issue: waiting[0], waiting: true, ambiguous: waiting.map((i) => i.identifier ?? i.id) };
  }

  // The PR's own issue (the first it names), being worked on or in review, with no
  // stage pending, whose stages Paperclip's activity log shows an agent removed
  // (stages.mjs). A blocked issue waits on something the merge doesn't settle (a
  // blocker, a recovery decision), and a backlog one wasn't started: both are yours.
  async function stagesWereWiped(issue, identifiers) {
    if (!config.relayDoneWithoutStages || (issue.identifier ?? issue.id) !== identifiers[0]) return false;
    if (!CLOSABLE.has(issue.status) || issue.executionState?.status === "pending") return false;
    if (issue.executionPolicy?.stages?.length) return false;
    return Boolean(stagesWipe(await issueActivity(api, issue.id)));
  }

  // Does your merge finish the issue? null when it does; otherwise why not:
  // { marker: true } when the issue's description, its review request, or the
  // hand-off that sent it to review says so (RELAY_MERGE_KEEP_OPEN_MARKER), or
  // { children: [identifiers] } when it has open child issues
  // (RELAY_MERGE_KEEP_OPEN_CHILDREN). A PR that is only one step of a longer issue
  // would otherwise close it, release its dependants and wake nobody.
  async function mergeKeepsOpen(issue) {
    const marker = config.relayMergeKeepOpenMarker.toLowerCase();
    if (marker) {
      const full = (await api.request("GET", `/api/issues/${issue.id}`).catch(() => null)) ?? issue;
      const texts = [full.description, full.executionState?.reviewRequest?.instructions, ...(await handOffTexts(full))];
      if (texts.some((t) => String(t ?? "").toLowerCase().includes(marker))) return { marker: true };
    }
    if (config.relayMergeKeepOpenChildren) {
      const rows = await api.request("GET", `/api/companies/${issue.companyId}/issues?parentId=${issue.id}&limit=100`).catch(() => null);
      if (!Array.isArray(rows)) log.warn("relay: couldn't list the issue's child issues; deciding the merge without them", { identifier: issue.identifier ?? issue.id });
      const open = (Array.isArray(rows) ? rows : []).filter((c) => c.parentId === issue.id && !["done", "cancelled"].includes(c.status));
      if (open.length) return { children: open.map((c) => c.identifier ?? c.id) };
    }
    return null;
  }

  // The hand-off that sent the issue to review: its implementer's comments since
  // the implementer last moved the issue to in_review (Paperclip's activity log), the
  // hand-off comment itself included. A board move back to review (the resume
  // sweep's restore, a drag in the UI) isn't a hand-off. Without the log, the
  // implementer's latest comment.
  async function handOffTexts(issue) {
    const [comments, activity] = await Promise.all([
      api.request("GET", `/api/issues/${issue.id}/comments?order=desc&limit=50`).catch(() => null),
      issueActivity(api, issue.id),
    ]);
    const implementer = issue.executionState?.returnAssignee?.agentId ?? issue.assigneeAgentId ?? null;
    if (!Array.isArray(comments)) log.warn("relay: couldn't read the issue's comments; looking for the keep-open marker without its hand-off", { identifier: issue.identifier ?? issue.id });
    const own = (Array.isArray(comments) ? comments : []).filter((c) => c.authorAgentId && (!implementer || c.authorAgentId === implementer));
    const moves = (Array.isArray(activity) ? activity : []).filter((e) => e?.action === "issue.updated" && e.details?.changes?.status?.to === "in_review");
    const byAgent = (e) => (implementer ? (e.agentId ?? e.actorId) === implementer : e.actorType === "agent");
    const entered = moves.find(byAgent) ?? moves[0];
    if (!entered) return own.slice(0, 1).map((c) => c.body);
    // The hand-off comment is written in the same request as the move: a little slack.
    const since = ts(entered.createdAt) - HAND_OFF_SLACK_MS;
    return own.filter((c) => ts(c.createdAt) >= since).map((c) => c.body);
  }

  // Your merge of a PR that doesn't finish its issue: changes requested for you, so
  // Paperclip returns the issue to its implementer and wakes them.
  async function returnAfterMerge(pr, identifier, keep, { wiped = false } = {}) {
    const why = keep.marker
      ? "This issue says the merge doesn't complete it"
      : `This issue still has open child issues (${keep.children.join(", ")})`;
    const comment =
      `${prLabel(pr)} merged (\`${pr.merge_commit_sha?.slice(0, 12) ?? "no sha"}\`). ${why}, so it's back with you for the rest of the work.` +
      `${wiped ? " Its review stages had been wiped: ask the board to restore them before you hand it back." : ""}\n\n${pr.html_url ?? ""}`;
    const reason = keep.marker ? "the issue says the merge doesn't complete it" : `open child issues: ${keep.children.join(", ")}`;
    if (config.dryRun) return { identifier, action: "changes (dry run)", status: DECISION_STATUS.changes, reason };
    try {
      await api.request("PATCH", `/api/issues/${encodeURIComponent(identifier)}`, {
        status: DECISION_STATUS.changes,
        comment: signed(comment, RELAYED_SIGNATURE),
      });
    } catch (err) {
      // Paperclip refused the hand-back (a stage with no implementer to return to, say).
      // Closing the issue would drop the rest of its work: say so, and leave it to you.
      if (!(err?.status >= 400 && err.status < 500)) throw err;
      log.warn("relay: Paperclip refused to return the issue to its implementer after a merge that doesn't finish it; commented instead", { identifier, error: err.message });
      const result = await addComment(identifier, `${comment}\n\n_Paperclip refused to return the issue (${err.message}): it is left as it was for you to decide._`);
      return { ...result, reason: `${reason}; Paperclip refused the hand-back` };
    }
    log("relay: a merge that doesn't finish its issue; returned to its implementer", { identifier, pr: pr.number, reason });
    return { identifier, action: "changes", status: DECISION_STATUS.changes, reason };
  }

  // A note that needs nothing from the issue's agent: a line in the issue's
  // pull-requests document (wakes nobody), or a comment with RELAY_QUIET_NOTES off
  // or when Paperclip won't take the document.
  async function addNote(identifier, text) {
    if (!config.relayQuietNotes) return addComment(identifier, text);
    if (config.dryRun) return { identifier, action: "note (dry run)" };
    try {
      await appendNote(api, identifier, text, { now: ctx.now() });
      return { identifier, action: "note" };
    } catch (err) {
      log.warn("relay: couldn't write the issue's pull-requests document; commenting instead", { identifier, error: err.message });
      return addComment(identifier, text);
    }
  }

  async function addComment(identifier, comment) {
    if (config.dryRun) return { identifier, action: "comment (dry run)" };
    await api.request("POST", `/api/issues/${encodeURIComponent(identifier)}/comments`, { body: signed(comment, RELAYED_SIGNATURE) });
    return { identifier, action: "comment" };
  }

  // Record `kind` ("approve" or "changes") for the PR, with `comment` as its text.
  // `target`: what resolveTarget() found, when the caller already looked. `merged`:
  // the decision is your merge of the PR (not a /approve on an open one).
  async function decide({ pr, identifiers, kind, comment, target = undefined, merged = false }) {
    target ??= await resolveTarget(pr, identifiers);
    if (!target) return { identifiers, action: "none", code: "not-found", reason: "no Paperclip issue found for the identifiers" };
    const { issue, waiting, ambiguous, via } = target;
    const identifier = issue.identifier ?? issue.id;
    const stageType = issue?.executionState?.currentStageType ?? null;

    if (kind === "approve" && issue.status === "done") {
      return { identifier, action: "none", code: "already-done", reason: "issue already done" };
    }
    if (!waiting && merged && (await stagesWereWiped(issue, identifiers))) {
      // Your merge of its own PR, and no stage left to record it: close it as the approval
      // would have, so its dependants can start, unless the merge doesn't finish it.
      const keep = await mergeKeepsOpen(issue);
      if (keep) return returnAfterMerge(pr, identifier, keep, { wiped: true });
      if (config.dryRun) return { identifier, action: "done (dry run)", reason: "its review stages were wiped" };
      await api.request("PATCH", `/api/issues/${encodeURIComponent(identifier)}`, {
        status: "done",
        comment: signed(`${comment}\n\nThis issue's review stages had been wiped, so there was no approval to record: closed as done on the merge.`, RELAYED_SIGNATURE),
      });
      return { identifier, action: "done", reason: "its review stages were wiped" };
    }
    if (!waiting) {
      // Not your turn: keep the information, change nothing, and say so: a merge's
      // "Approved:" would read as a decision that wasn't recorded.
      const state = stageType ? `its ${stageType} stage doesn't wait on you` : `it is ${issue.status} with no stage waiting on you`;
      const result = await addComment(identifier, `${comment.replace(/^Approved: /, "")}\n\n_Not recorded as a decision: ${state}._`);
      return { ...result, code: "not-waiting", reason: "decision is not waiting on you", status: issue.status, stageType };
    }
    if (ambiguous) {
      // Not clear which issue it's for: keep the information, change nothing.
      const list = ambiguous.join(", ");
      const note = `_Not recorded as a decision: ${list} all wait on you, and none lists this PR. Decide on the right one in Paperclip, or with \`pch approve\` or \`pch changes\`._`;
      const result = await addComment(identifier, `${comment}\n\n${note}`);
      return { ...result, code: "ambiguous", waitingOn: ambiguous, reason: `several issues wait on you (${list}) and none lists this PR`, status: issue.status, stageType };
    }

    if (kind === "approve" && merged) {
      // The merge was one step of the issue, not all of it: back to its implementer.
      const keep = await mergeKeepsOpen(issue);
      if (keep) return { ...(await returnAfterMerge(pr, identifier, keep)), ...(via ? { via } : {}) };
    }

    const status = DECISION_STATUS[kind];
    if (config.dryRun) return { identifier, action: `${kind} (dry run)`, status };
    const path = `/api/issues/${encodeURIComponent(identifier)}`;
    // The decision and its comment must travel in the same PATCH.
    await api.request("PATCH", path, { status, comment: signed(comment, RELAYED_SIGNATURE) });

    // Approving a stage that isn't the last one only moves the issue to the next
    // stage. When that stage is yours too (an escalated review followed by your
    // approval, say), the merge is your decision there as well: approve it, with
    // a short comment, since Paperclip needs one per decision. Stop as soon as
    // the next decision is someone else's.
    const stages = [stageType];
    let current = await api.request("GET", path).catch(() => null);
    if (kind === "approve") {
      const { userId } = await ctx.identity();
      for (let i = 0; i < MAX_CHAINED_STAGES && current && approvalWaitingOn(current, userId); i++) {
        const next = current.executionState?.currentStageType ?? "next";
        stages.push(next);
        await api.request("PATCH", path, {
          status,
          comment: signed(`Approved at the ${next} stage as well: ${prLabel(pr)} was merged. ${pr.html_url ?? ""}`, RELAYED_SIGNATURE),
        });
        current = await api.request("GET", path).catch(() => null);
      }
    }
    const result = { identifier, action: kind, status: current?.status ?? status };
    if (via) result.via = via;
    if (stages.length > 1) result.stages = stages;
    if (current && current.status !== status) {
      // Paperclip accepted the decision but the issue didn't land where it was sent.
      const waitingOn = current.executionState?.currentParticipant ?? null;
      result.warning = `asked for ${status}, issue is ${current.status}${waitingOn ? ` (${current.executionState?.currentStageType ?? "stage"} pending with ${waitingOn.type} ${waitingOn.userId ?? waitingOn.agentId})` : ""}`;
      log.warn("relay: the decision didn't move the issue where it was sent", { identifier, ...result });
    }
    return result;
  }

  // Plain comments go where the review is waiting on you, if anywhere; else to
  // the first issue the PR names.
  async function commentOnTarget(pr, identifiers, comment, options) {
    const target = await resolveTarget(pr, identifiers, options).catch(() => null);
    return addComment(target?.issue?.identifier ?? identifiers[0], comment);
  }

  return { resolveTarget, decide, addNote, addComment, commentOnTarget };
}
