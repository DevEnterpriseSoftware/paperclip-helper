// Relay: GitHub → Paperclip.
//
// Receives signed GitHub webhooks for the agents' pull requests and records
// your decisions on the Paperclip issue the pull request belongs to:
//
//   * PR merged by you                   → approve (status done + comment), when
//                                          the issue's approval is waiting on you
//   * Review "Request changes" by you    → request changes (status in_progress
//                                          + your review text as the comment)
//   * Comment/review by you, "/changes"  → same as Request changes
//   * Comment/review by you, "/approve"  → approve without merging
//   * Any other comment/review by you    → copied to the issue as a comment
//                                          (not a plain GitHub approval, since
//                                          merging is the approval, nor an empty review)
//   * PR opened, reopened or ready       → its URL noted on the issue, so
//                                          Paperclip links it (RELAY_LINK_PRS), in
//                                          the issue's pull-requests document,
//                                          which wakes nobody (RELAY_QUIET_NOTES)
//   * PR merged by you, its issue's      → the issue is closed as done with the
//     review stages wiped                  merge comment, as the approval would
//                                          have (RELAY_DONE_WITHOUT_STAGES)
//   * PR closed unmerged, or merged by   → a note on the issue
//     someone else
//   * Any PR merged                      → other open PRs that now conflict are
//                                          sent back to their agents
//                                          (RELAY_FIX_CONFLICTS, conflicts.mjs)
//   * PR dropped by the merge queue      → a failed check sends it back; a
//                                          cancelled run or the queue's timeout
//                                          tells the board (RELAY_MERGE_QUEUE,
//                                          merge-queue.mjs)
//
// When your /changes, /approve or "Request changes" is not recorded as a decision
// (the issue isn't waiting on you, several are, it's already done, or the PR names
// no issue), the relay replies on the PR with where your text went and why, so it
// doesn't look as if nothing arrived (RELAY_PR_NOTES, with a GitHub token).
//
// It ignores events without a valid GITHUB_WEBHOOK_SECRET signature, or from a
// repository not in GITHUB_REPOS. Decisions and copied comments also need the
// sender to be GITHUB_OWNER_LOGIN; the notes (PR opened, closed, merged by
// someone else) are posted whoever sent the event.

import http from "node:http";
import crypto from "node:crypto";
import { approvalWaitingOn, DECISION_STATUS, every, RELAYED_SIGNATURE, signed } from "./util.mjs";
import { createGitHub } from "./github.mjs";
import { createConflictSweep, HELPER_MARK } from "./conflicts.mjs";
import { createMergeQueueHandler, QUEUE_BOT } from "./merge-queue.mjs";
import { issueActivity, stagesWipe } from "./stages.mjs";
import { appendNote } from "./quiet-notes.mjs";
import { findIdentifiers } from "./identifiers.mjs";


const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_FORWARDED_CHARS = 20_000;
const LINK_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);
// Stages a single merge may approve after the first, when each is waiting on you.
const MAX_CHAINED_STAGES = 3;
// Issues looked at for one PR, counting blockers and deeper subtasks.
const MAX_RELATED_ISSUES = 40;

export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function clip(text) {
  const value = (text ?? "").trim();
  return value.length > MAX_FORWARDED_CHARS ? `${value.slice(0, MAX_FORWARDED_CHARS)}\n\n…(truncated)` : value;
}

function command(text) {
  const first = (text ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (first === "/changes") return "changes";
  if (first === "/approve") return "approve";
  return null;
}

function stripCommand(text) {
  return (text ?? "").trim().replace(/^\/(changes|approve)\b\s*/i, "");
}

const prLabel = (pr) => `PR #${pr.number}`;

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
  } else if (result?.reason === "no Paperclip issue found for the identifiers") {
    lines.push(`None of the issues this PR names (${named}) was found in Paperclip.`);
  } else if (result?.reason === "issue already done") {
    lines.push(`${target} is already done.`);
  } else if (String(result?.reason ?? "").startsWith("several issues wait on you")) {
    lines.push(`${result.reason.replace(/^several issues wait on you \((.*)\) and none lists this PR$/, "$1")} all wait on you, and none of them lists this PR, so the relay didn't guess.`);
    copied = true;
  } else if (result?.reason === "decision is not waiting on you") {
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

// "Changes requested on PR #8", "Approved on PR #8", or "<plain> on PR #8".
const heading = (kind, plain, pr) =>
  `${kind === "changes" ? "Changes requested" : kind === "approve" ? "Approved" : plain} on ${prLabel(pr)}`;

export function createRelay(ctx, state, { github, sleep } = {}) {
  const { config, api, log } = ctx;
  const deliveries = state.deliveries;
  const prefixLabel = () => (ctx.prefixes().length ? ctx.prefixes().join("/") : "Paperclip");

  // ------------------------------------------------------------ decisions

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
  async function resolveTarget(pr, identifiers, { own = false } = {}) {
    const { userId } = await ctx.identity();
    const seen = new Map(); // identifier → issue
    const add = (issue) => {
      const key = issue?.identifier ?? issue?.id;
      if (!key || seen.has(key)) return false;
      seen.set(key, issue);
      return true;
    };
    const get = (ref) => api.request("GET", `/api/issues/${encodeURIComponent(ref)}`).catch(() => null);
    const subtasks = async (issue) => {
      const rows = await api
        .request("GET", `/api/companies/${issue.companyId}/issues?parentId=${issue.id}&limit=100`)
        .catch(() => []);
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
      const products = await api.request("GET", `/api/issues/${issue.id}/work-products`).catch(() => []);
      if ((Array.isArray(products) ? products : []).some((wp) => isWorkProductOf(wp, pr))) return found(issue);
    }
    // Several wait on you and none records this PR: don't guess which to decide.
    // A link then goes on the PR's own issue.
    if (own) return { issue: first, waiting: false };
    return { issue: waiting[0], waiting: true, ambiguous: waiting.map((i) => i.identifier ?? i.id) };
  }

  // The PR's own issue (the first it names), open, with no stage pending, whose
  // stages Paperclip's activity log shows an agent removed (stages.mjs).
  async function stagesWereWiped(issue, identifiers) {
    if (!config.relayDoneWithoutStages || (issue.identifier ?? issue.id) !== identifiers[0]) return false;
    if (issue.status === "done" || issue.status === "cancelled" || issue.executionState?.status === "pending") return false;
    if (issue.executionPolicy?.stages?.length) return false;
    return Boolean(stagesWipe(await issueActivity(api, issue.id)));
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

  // `resolved`: a target the caller already looked up for this PR. `merged`: the
  // decision is your merge of the PR (not a /approve on an open one).
  async function decide(pr, identifiers, kind, comment, resolved, { merged = false } = {}) {
    const target = resolved ?? (await resolveTarget(pr, identifiers));
    if (!target) return { identifiers, action: "none", reason: "no Paperclip issue found for the identifiers" };
    const { issue, waiting, ambiguous, via } = target;
    const identifier = issue.identifier ?? issue.id;
    const stageType = issue?.executionState?.currentStageType ?? null;

    if (kind === "approve" && issue.status === "done") {
      return { identifier, action: "none", reason: "issue already done" };
    }
    if (!waiting && merged && (await stagesWereWiped(issue, identifiers))) {
      // Your merge of its own PR, and no stage left to record it: close it as the approval
      // would have, so its dependants can start.
      if (config.dryRun) return { identifier, action: "done (dry run)", reason: "its review stages were wiped" };
      await api.request("PATCH", `/api/issues/${encodeURIComponent(identifier)}`, {
        status: "done",
        comment: signed(`${comment}\n\nThis issue's review stages had been wiped, so there was no approval to record: closed as done on the merge.`, RELAYED_SIGNATURE),
      });
      return { identifier, action: "done", reason: "its review stages were wiped" };
    }
    if (!waiting) {
      // Not your turn: keep the information, change nothing.
      const result = await addComment(identifier, comment);
      return { ...result, reason: "decision is not waiting on you", status: issue.status, stageType };
    }
    if (ambiguous) {
      // Not clear which issue it's for: keep the information, change nothing.
      const list = ambiguous.join(", ");
      const note = `_Not recorded as a decision: ${list} all wait on you, and none lists this PR. Decide on the right one in Paperclip, or with \`pch approve\` or \`pch changes\`._`;
      const result = await addComment(identifier, `${comment}\n\n${note}`);
      return { ...result, reason: `several issues wait on you (${list}) and none lists this PR`, status: issue.status, stageType };
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

  // ------------------------------------------------------------ merge conflicts

  const hasToken = Boolean(config.githubToken || config.githubTokenFile);
  const gh = github ?? (hasToken ? createGitHub({ config, log }) : null);
  const conflicts = config.relayFixConflicts
    ? createConflictSweep({
        ctx,
        state,
        github: gh,
        identifiersOf: (pr) => findIdentifiers(pr, ctx.prefixes()),
        resolveTarget,
        decide,
        sleep,
      })
    : null;
  const background = new Set();
  const inBackground = (work, what = "relay: conflict sweep failed") => {
    const run = work.catch((err) => log.error(what, { error: err.message }));
    background.add(run);
    run.finally(() => background.delete(run));
  };
  // Not awaited: GitHub gives a webhook ten seconds, and a sweep can take longer.
  function sweepAfterMerge(repo, pr) {
    if (!conflicts) return;
    inBackground(conflicts.sweep(repo, { base: pr.base?.ref, after: pr }));
  }
  async function sweepAll() {
    for (const repo of config.repos) await conflicts.sweep(repo);
  }
  const mergeQueue = config.relayMergeQueue && gh
    ? createMergeQueueHandler({
        ctx,
        state,
        github: gh,
        identifiersOf: (pr) => findIdentifiers(pr, ctx.prefixes()),
        resolveTarget,
        decide,
        addComment,
        sweepConflicts: conflicts ? (repo, base) => inBackground(conflicts.sweep(repo, { base })) : null,
      })
    : null;
  let timer = null;

  // ------------------------------------------------------------ notes on the PR

  // Tell the PR when a decision you asked for wasn't recorded. Not awaited, like
  // the sweep: the webhook has already been answered by the time GitHub replies.
  function noteOnPr(payload, number, { kind, asked, result, identifiers, fromComment }) {
    const text = decisionNote({ kind, asked, result, identifiers, prefixLabel: prefixLabel(), fromComment });
    if (!text) return result;
    const out = { ...result, prNote: false };
    if (!config.relayPrNotes || !gh || config.dryRun) return out;
    const repo = payload?.repository?.full_name;
    out.prNote = true;
    inBackground(
      gh.comment(repo, number, `${signed(text)}\n\n${HELPER_MARK}`).then(() => log("relay: noted on the PR", { repo, pr: number, kind })),
      "relay: could not note on the PR",
    );
    return out;
  }

  // ------------------------------------------------------------ GitHub events

  // `meta.delivery`: the delivery id, for work that finishes after the webhook is answered.
  async function handle(event, payload, meta = {}) {
    const repo = payload?.repository?.full_name?.toLowerCase();
    if (config.repos.length && !config.repos.includes(repo)) {
      return { ignored: `repository ${repo} is not in GITHUB_REPOS` };
    }
    if (event === "ping") return { pong: true, zen: payload?.zen ?? null };
    await ctx.identity(); // loads the issue prefixes
    const prefixes = ctx.prefixes();
    const sender = payload?.sender?.login?.toLowerCase();

    if (event === "pull_request") {
      const pr = payload.pull_request;
      if (LINK_ACTIONS.has(payload.action) && config.relayLinkPrs) {
        // Paperclip links a PR to an issue (its "GitHub Pull Request" property, with
        // live status) only when the full github.com URL appears in the issue's text.
        // Agents often write "PR #16", which links nothing, so post the URL. Any
        // sender: the comment is informational only.
        const identifiers = findIdentifiers(pr, prefixes);
        if (!identifiers.length) return { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
        const verb = payload.action === "reopened" ? "reopened" : "opened";
        // On the PR's own issue (or its subtask), never on a blocker or another issue it mentions.
        const target = await resolveTarget(pr, identifiers, { own: true }).catch(() => null);
        return addNote(target?.issue?.identifier ?? identifiers[0], `${prLabel(pr)} ${verb} by @${payload.sender?.login}: ${pr.html_url}`);
      }
      if (payload.action === "enqueued") {
        mergeQueue?.enqueued(repo, payload);
        return { ignored: "pull_request.enqueued (noted who queued it)" };
      }
      if (payload.action === "dequeued") {
        if (!mergeQueue) return { ignored: "pull_request.dequeued (RELAY_MERGE_QUEUE is off, or no GitHub token)" };
        // A person taking it out of the queue decided that themselves.
        if (payload.sender?.login !== QUEUE_BOT) return { ignored: `removed from the merge queue by @${payload.sender?.login}` };
        // GitHub reads take a few seconds; the webhook is answered at once. If the work
        // fails, the delivery is forgotten so GitHub's "Redeliver" can try again.
        const number = payload.pull_request?.number;
        const work = mergeQueue
          .handle(repo, payload)
          .then((result) => log("relay: merge-queue drop", { repo, pr: number, reason: payload.reason ?? null, result }))
          .catch((err) => {
            mergeQueue.stats.lastError = err.message;
            if (meta.delivery) deliveries.delete(meta.delivery);
            throw new Error(`${repo}#${number}: ${err.message}`);
          });
        inBackground(work, "relay: merge-queue drop failed");
        return { queued: "merge-queue drop" };
      }
      if (payload.action !== "closed") return { ignored: `pull_request.${payload.action}` };
      // Whoever merged it and whatever it names: the base branch moved.
      if (pr.merged) sweepAfterMerge(repo, pr);
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) return { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
      const identifier = identifiers[0];
      if (!pr.merged) {
        return addNote(identifier, `${prLabel(pr)} was closed without merging by @${payload.sender.login}: ${pr.html_url}`);
      }
      if (sender !== config.ownerLogin) {
        return addNote(identifier, `${prLabel(pr)} was merged by @${payload.sender.login}, not by the approver: ${pr.html_url}`);
      }
      return decide(
        pr,
        identifiers,
        "approve",
        `Approved: ${prLabel(pr)} merged into \`${pr.base?.ref}\` by @${payload.sender.login} (${pr.merge_commit_sha?.slice(0, 12) ?? "no sha"}).\n\n${pr.html_url}`,
        undefined,
        { merged: true },
      );
    }

    if (event === "pull_request_review") {
      if (payload.action !== "submitted") return { ignored: `pull_request_review.${payload.action}` };
      if (sender !== config.ownerLogin) return { ignored: `review by @${payload.sender?.login}` };
      const pr = payload.pull_request;
      const review = payload.review;
      const state = review.state?.toLowerCase();
      if (state === "approved" && !command(review.body)) {
        // Merging is the approval; a GitHub approval alone changes nothing.
        return { ignored: "GitHub approval (merge to approve in Paperclip)" };
      }
      const kind = state === "changes_requested" ? "changes" : command(review.body);
      const asked = command(review.body) ? `Your \`/${kind}\`` : "Your Request changes";
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) {
        const ignored = { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
        return kind ? noteOnPr(payload, pr.number, { kind, asked, result: ignored, identifiers }) : ignored;
      }
      const text = clip(stripCommand(review.body));
      const inline = `Inline comments, if any: \`gh api repos/${payload.repository.full_name}/pulls/${pr.number}/reviews/${review.id}/comments\``;
      const comment = `${heading(kind, "Review", pr)} (${review.html_url}):\n\n${text || "(no summary)"}\n\n${inline}`;
      if (kind === "changes" || kind === "approve") {
        const result = await decide(pr, identifiers, kind, comment);
        return noteOnPr(payload, pr.number, { kind, asked, result, identifiers });
      }
      if (!text) return { ignored: "review with no summary text" };
      return commentOnTarget(pr, identifiers, comment);
    }

    if (event === "issue_comment") {
      if (payload.action !== "created") return { ignored: `issue_comment.${payload.action}` };
      if (!payload.issue?.pull_request) return { ignored: "comment on an issue, not a PR" };
      if (sender !== config.ownerLogin) return { ignored: `comment by @${payload.sender?.login}` };
      // With your own token, the helper's PR comments arrive as yours.
      if (String(payload.comment?.body ?? "").includes(HELPER_MARK)) return { ignored: "the helper's own comment" };
      // The issue stands in for the PR (title, body, number, html_url), but it has
      // no branch, so only the title and body are searched for identifiers.
      const pr = payload.issue;
      const kind = command(payload.comment.body);
      const asked = `Your \`/${kind}\``;
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) {
        const ignored = { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
        return kind ? noteOnPr(payload, pr.number, { kind, asked, result: ignored, identifiers, fromComment: true }) : ignored;
      }
      const text = clip(stripCommand(payload.comment.body));
      const comment = `${heading(kind, "Comment", pr)} (${payload.comment.html_url}):\n\n${text || "(no text)"}`;
      if (kind) {
        const result = await decide(pr, identifiers, kind, comment);
        return noteOnPr(payload, pr.number, { kind, asked, result, identifiers, fromComment: true });
      }
      return commentOnTarget(pr, identifiers, comment);
    }

    return { ignored: `event ${event}` };
  }

  // ------------------------------------------------------------ HTTP server

  const stats = { handled: 0, failed: 0, lastEventAt: null, lastError: null };
  if (conflicts) stats.conflicts = conflicts.stats;
  if (mergeQueue) stats.mergeQueue = mergeQueue.stats;

  function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function receive(req, res, raw) {
    const event = req.headers["x-github-event"];
    const delivery = req.headers["x-github-delivery"];
    if (!verifySignature(config.secret, raw, req.headers["x-hub-signature-256"])) {
      log.warn("relay: rejected, bad signature", { event, delivery });
      return send(res, 401, { error: "bad signature" });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { error: "payload is not JSON (set the webhook content type to application/json)" });
    }
    if (delivery && deliveries.has(delivery)) return send(res, 200, { duplicate: delivery });
    if (delivery) {
      deliveries.set(delivery, { at: Date.now() });
      state.touch();
    }
    try {
      const result = await handle(event, payload, { delivery });
      stats.handled += 1;
      stats.lastEventAt = new Date().toISOString();
      log("relay: handled", { event, action: payload?.action, delivery, result });
      send(res, 200, result ?? {});
    } catch (err) {
      if (delivery) deliveries.delete(delivery); // let a GitHub "Redeliver" try again
      stats.failed += 1;
      stats.lastError = err.message;
      log.error("relay: failed", { event, action: payload?.action, delivery, error: err.message });
      send(res, 502, { error: err.message });
    } finally {
      try {
        state.save();
      } catch (err) {
        log.error("relay: could not save state", { error: err.message });
      }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname !== config.webhookPath) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const work = receive(req, res, Buffer.concat(chunks));
      inflight.add(work);
      work.finally(() => inflight.delete(work));
    });
  });
  const inflight = new Set();

  return {
    handle,
    server,
    stats,
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listenPort, config.listenHost, () => {
          server.off("error", reject);
          log(`relay on: http://${config.listenHost}:${server.address().port}${config.webhookPath}`, {
            repos: config.repos,
            owner: config.ownerLogin,
            prefixes: ctx.prefixes().length ? ctx.prefixes() : "every company's own",
            fixConflicts: Boolean(conflicts),
            mergeQueue: mergeQueue ? { requeue: config.relayRequeueOnInfraDrop } : config.relayMergeQueue ? "off: no GitHub token" : false,
          });
          if (conflicts && config.conflictSweepSec > 0) {
            timer = every("relay conflicts", config.conflictSweepSec, 30_000, sweepAll, log);
          }
          resolve(server.address().port);
        });
      });
    },
    // Look at every open PR now (all repositories, or one).
    sweepConflicts: (repo, options) => (repo ? conflicts.sweep(repo, options) : sweepAll()),
    // Resolves when the sweeps started by merges have finished.
    async idle() {
      while (background.size) await Promise.allSettled([...background]);
    },
    async stop() {
      await timer?.stop();
      await new Promise((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...inflight, ...background]);
    },
  };
}
