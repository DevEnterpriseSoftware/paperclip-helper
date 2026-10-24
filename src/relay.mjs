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
//   * PR merged by you, when the merge   → changes requested instead of approve:
//     doesn't finish the issue (its        the issue goes back to its implementer
//     hand-off or description says so,     for the rest of the work
//     or it has open child issues)         (RELAY_MERGE_KEEP_OPEN_MARKER,
//                                          RELAY_MERGE_KEEP_OPEN_CHILDREN)
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

//
// The HTTP side (signatures, duplicate deliveries, answering GitHub in time) is
// webhook-server.mjs; finding the issue and recording a decision is decisions.mjs.

import { every, prLabel } from "./util.mjs";
import { createGitHub, HELPER_MARK } from "./github.mjs";
import { createConflictSweep } from "./conflicts.mjs";
import { createMergeQueueHandler, QUEUE_BOT } from "./merge-queue.mjs";
import { createDecisions, decisionNote } from "./decisions.mjs";
import { createWebhookServer } from "./webhook-server.mjs";
import { findIdentifiers } from "./identifiers.mjs";

const MAX_FORWARDED_CHARS = 20_000;
const LINK_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

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

// "Changes requested on PR #8", "Approved on PR #8", or "<plain> on PR #8".
const heading = (kind, plain, pr) =>
  `${kind === "changes" ? "Changes requested" : kind === "approve" ? "Approved" : plain} on ${prLabel(pr)}`;

// `answerWithinMs`: how long a webhook waits for its outcome (webhook-server.mjs).
export function createRelay(ctx, state, { github, sleep, answerWithinMs } = {}) {
  const { config, log } = ctx;
  const prefixLabel = () => (ctx.prefixes().length ? ctx.prefixes().join("/") : "Paperclip");
  const decisions = createDecisions(ctx);
  const { decide, addNote, commentOnTarget, resolveTarget } = decisions;

  // ------------------------------------------------------------ work after the answer

  const hasToken = Boolean(config.githubToken || config.githubTokenFile);
  const gh = github ?? (hasToken ? createGitHub({ config, log }) : null);
  const background = new Set();
  const inBackground = (work, what) => {
    const run = work.catch((err) => log.error(what, { error: err.message }));
    background.add(run);
    run.finally(() => background.delete(run));
  };

  const conflicts = config.relayFixConflicts ? createConflictSweep({ ctx, state, github: gh, decisions, sleep }) : null;
  // Not awaited: a sweep reads every open PR, and the merge's own decision comes first.
  const sweepConflicts = (repo, base, after) => inBackground(conflicts.sweep(repo, { base, after }), "relay: conflict sweep failed");
  async function sweepAll() {
    for (const repo of config.repos) await conflicts.sweep(repo);
  }
  if (config.relayMergeQueue && !gh) {
    log("relay: merge-queue drops aren't handled: no GitHub token (set GITHUB_TOKEN or GITHUB_TOKEN_FILE, with Actions: Read)");
  }
  const mergeQueue = config.relayMergeQueue && gh
    ? createMergeQueueHandler({ ctx, state, github: gh, decisions, sweepConflicts: conflicts ? (repo, base) => sweepConflicts(repo, base) : null })
    : null;
  let timer = null;

  // Tell the PR when a decision you asked for wasn't recorded. Not awaited, like
  // the sweep: the decision itself is what the webhook's answer reports.
  function noteOnPr(payload, number, { kind, asked, result, identifiers, fromComment }) {
    const text = decisionNote({ kind, asked, result, identifiers, prefixLabel: prefixLabel(), fromComment });
    if (!text) return result;
    const out = { ...result, prNote: false };
    if (!config.relayPrNotes || !gh || config.dryRun) return out;
    const repo = payload?.repository?.full_name;
    out.prNote = true;
    inBackground(
      gh.helperComment(repo, number, text).then(() => log("relay: noted on the PR", { repo, pr: number, kind })),
      "relay: could not note on the PR",
    );
    return out;
  }

  // ------------------------------------------------------------ GitHub events

  async function handle(event, payload) {
    // A ping first: an organisation webhook's has no repository.
    if (event === "ping") return { pong: true, zen: payload?.zen ?? null };
    const repo = payload?.repository?.full_name?.toLowerCase();
    if (config.repos.length && !config.repos.includes(repo)) {
      return { ignored: `repository ${repo} is not in GITHUB_REPOS` };
    }
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
        return { ignored: mergeQueue ? "pull_request.enqueued (noted who queued it)" : "pull_request.enqueued" };
      }
      if (payload.action === "dequeued") {
        if (!mergeQueue) return { ignored: "pull_request.dequeued (RELAY_MERGE_QUEUE is off, or no GitHub token)" };
        // A person taking it out of the queue decided that themselves.
        if (payload.sender?.login !== QUEUE_BOT) return { ignored: `removed from the merge queue by @${payload.sender?.login}` };
        // Several GitHub reads: the webhook server answers GitHub in time regardless.
        const number = payload.pull_request?.number;
        try {
          const result = await mergeQueue.handle(repo, payload);
          log("relay: merge-queue drop", { repo, pr: number, reason: payload.reason ?? null, result });
          return result;
        } catch (err) {
          mergeQueue.stats.lastError = err.message;
          throw new Error(`merge-queue drop of ${repo}#${number}: ${err.message}`);
        }
      }
      if (payload.action !== "closed") return { ignored: `pull_request.${payload.action}` };
      // Whoever merged it and whatever it names: the base branch moved.
      if (pr.merged && conflicts) sweepConflicts(repo, pr.base?.ref, pr);
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) return { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
      const identifier = identifiers[0];
      if (!pr.merged) {
        return addNote(identifier, `${prLabel(pr)} was closed without merging by @${payload.sender.login}: ${pr.html_url}`);
      }
      if (sender !== config.ownerLogin) {
        return addNote(identifier, `${prLabel(pr)} was merged by @${payload.sender.login}, not by the approver: ${pr.html_url}`);
      }
      return decide({
        pr,
        identifiers,
        kind: "approve",
        comment: `Approved: ${prLabel(pr)} merged into \`${pr.base?.ref}\` by @${payload.sender.login} (${pr.merge_commit_sha?.slice(0, 12) ?? "no sha"}).\n\n${pr.html_url}`,
        merged: true,
      });
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
      const asked = command(review.body) ? `Your \`/${command(review.body)}\`` : "Your Request changes";
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) {
        const ignored = { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
        return kind ? noteOnPr(payload, pr.number, { kind, asked, result: ignored, identifiers }) : ignored;
      }
      const text = clip(stripCommand(review.body));
      const inline = `Inline comments, if any: \`gh api repos/${payload.repository.full_name}/pulls/${pr.number}/reviews/${review.id}/comments\``;
      const comment = `${heading(kind, "Review", pr)} (${review.html_url}):\n\n${text || "(no summary)"}\n\n${inline}`;
      if (kind === "changes" || kind === "approve") {
        const result = await decide({ pr, identifiers, kind, comment });
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
        const result = await decide({ pr, identifiers, kind, comment });
        return noteOnPr(payload, pr.number, { kind, asked, result, identifiers, fromComment: true });
      }
      return commentOnTarget(pr, identifiers, comment);
    }

    return { ignored: `event ${event}` };
  }

  // ------------------------------------------------------------ HTTP

  const webhooks = createWebhookServer({ ctx, state, handle, answerWithinMs });
  const stats = webhooks.stats;
  if (conflicts) stats.conflicts = conflicts.stats;
  if (mergeQueue) stats.mergeQueue = mergeQueue.stats;

  return {
    handle,
    server: webhooks.server,
    stats,
    async start() {
      const port = await webhooks.listen();
      log(`relay on: http://${config.listenHost}:${port}${config.webhookPath}`, {
        repos: config.repos,
        owner: config.ownerLogin,
        prefixes: ctx.prefixes().length ? ctx.prefixes() : "every company's own",
        fixConflicts: Boolean(conflicts),
        mergeQueue: mergeQueue ? { requeue: config.relayRequeueOnInfraDrop } : config.relayMergeQueue ? "off: no GitHub token" : false,
      });
      if (conflicts && config.conflictSweepSec > 0) {
        timer = every("relay conflicts", config.conflictSweepSec, 30_000, sweepAll, log);
      }
      return port;
    },
    // Look at every open PR now (all repositories, or one).
    sweepConflicts: (repo, options) => (repo ? conflicts.sweep(repo, options) : sweepAll()),
    // Resolves when the deliveries received and the work they started have finished.
    async idle() {
      do {
        await webhooks.idle();
        await Promise.allSettled([...background]);
      } while (background.size);
    },
    async stop() {
      await timer?.stop();
      await webhooks.close();
      await Promise.allSettled([...background]);
    },
  };
}
