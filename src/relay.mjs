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
//   * PR opened, reopened or ready       → its URL posted on the issue, so
//                                          Paperclip links it (RELAY_LINK_PRS)
//   * PR closed unmerged, or merged by   → a note on the issue
//     someone else
//
// It ignores events without a valid GITHUB_WEBHOOK_SECRET signature, or from a
// repository not in GITHUB_REPOS. Decisions and copied comments also need the
// sender to be GITHUB_OWNER_LOGIN; the notes (PR opened, closed, merged by
// someone else) are posted whoever sent the event.

import http from "node:http";
import crypto from "node:crypto";
import { approvalWaitingOn, DECISION_STATUS } from "./util.mjs";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_FORWARDED_CHARS = 20_000;
const LINK_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);
// Stages a single merge may approve after the first, when each is waiting on you.
const MAX_CHAINED_STAGES = 3;

export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function identifierRegex(prefixes) {
  const alternatives = prefixes.map((p) => p.replace(/[^A-Z0-9]/gi, "")).filter(Boolean);
  // With no known prefix, fall back to Paperclip's identifier shape.
  const prefix = alternatives.length ? `(${alternatives.join("|")})` : "([A-Z][A-Z0-9]*)";
  return new RegExp(`\\b${prefix}-(\\d+)\\b`, "gi");
}

// Every issue identifier the PR names, in order: title, branch, body.
export function findIdentifiers(pr, prefixes) {
  const found = [];
  const pattern = identifierRegex(prefixes);
  for (const text of [pr?.title, pr?.head?.ref, pr?.body]) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(pattern)) {
      const id = `${match[1].toUpperCase()}-${match[2]}`;
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
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

// "Changes requested on PR #8", "Approved on PR #8", or "<plain> on PR #8".
const heading = (kind, plain, pr) =>
  `${kind === "changes" ? "Changes requested" : kind === "approve" ? "Approved" : plain} on ${prLabel(pr)}`;

export function createRelay(ctx, state) {
  const { config, api, log } = ctx;
  const deliveries = state.deliveries;
  const prefixLabel = () => (ctx.prefixes().length ? ctx.prefixes().join("/") : "Paperclip");

  // ------------------------------------------------------------ decisions

  // A PR can name the parent issue (its title and branch come from the parent's
  // workspace) while the review and approval stages sit on a child issue. So look
  // at every issue the PR names, plus their subtasks, and pick the one whose
  // approval is waiting on you. With several, prefer one that records this PR as a
  // work product; if none does, decide nothing and comment. With none waiting, the
  // first issue the PR names gets a comment.
  async function resolveTarget(pr, identifiers) {
    const { userId } = await ctx.identity();
    const seen = new Map(); // identifier → issue
    const add = (issue) => {
      const key = issue?.identifier ?? issue?.id;
      if (key && !seen.has(key)) seen.set(key, issue);
    };
    for (const identifier of identifiers) {
      const issue = await api.request("GET", `/api/issues/${encodeURIComponent(identifier)}`).catch(() => null);
      if (!issue?.id) continue;
      add(issue);
      const children = await api
        .request("GET", `/api/companies/${issue.companyId}/issues?parentId=${issue.id}&limit=100`)
        .catch(() => []);
      for (const child of Array.isArray(children) ? children : []) {
        // List rows carry executionState: null, so read any subtask in review in full.
        const full = child.status === "in_review" ? await api.request("GET", `/api/issues/${child.id}`).catch(() => null) : null;
        add(full ?? child);
      }
    }
    if (seen.size === 0) return null;
    const waiting = [...seen.values()].filter((issue) => approvalWaitingOn(issue, userId));
    if (waiting.length <= 1) return { issue: waiting[0] ?? seen.values().next().value, waiting: waiting.length === 1 };

    for (const issue of waiting) {
      const products = await api.request("GET", `/api/issues/${issue.id}/work-products`).catch(() => []);
      if ((Array.isArray(products) ? products : []).some((wp) => isWorkProductOf(wp, pr))) return { issue, waiting: true };
    }
    // Several wait on you and none records this PR: don't guess which to decide.
    return { issue: waiting[0], waiting: true, ambiguous: waiting.map((i) => i.identifier ?? i.id) };
  }

  async function addComment(identifier, comment) {
    if (config.dryRun) return { identifier, action: "comment (dry run)" };
    await api.request("POST", `/api/issues/${encodeURIComponent(identifier)}/comments`, { body: comment });
    return { identifier, action: "comment" };
  }

  async function decide(pr, identifiers, kind, comment) {
    const target = await resolveTarget(pr, identifiers);
    if (!target) return { identifiers, action: "none", reason: "no Paperclip issue found for the identifiers" };
    const { issue, waiting, ambiguous } = target;
    const identifier = issue.identifier ?? issue.id;
    const stageType = issue?.executionState?.currentStageType ?? null;

    if (kind === "approve" && issue.status === "done") {
      return { identifier, action: "none", reason: "issue already done" };
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
    await api.request("PATCH", path, { status, comment });

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
          comment: `Approved at the ${next} stage as well: ${prLabel(pr)} was merged. ${pr.html_url ?? ""}`.trim(),
        });
        current = await api.request("GET", path).catch(() => null);
      }
    }
    const result = { identifier, action: kind, status: current?.status ?? status };
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
  async function commentOnTarget(pr, identifiers, comment) {
    const target = await resolveTarget(pr, identifiers).catch(() => null);
    return addComment(target?.issue?.identifier ?? identifiers[0], comment);
  }

  // ------------------------------------------------------------ GitHub events

  async function handle(event, payload) {
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
        return commentOnTarget(pr, identifiers, `${prLabel(pr)} ${verb} by @${payload.sender?.login}: ${pr.html_url}`);
      }
      if (payload.action !== "closed") return { ignored: `pull_request.${payload.action}` };
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) return { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
      const identifier = identifiers[0];
      if (!pr.merged) {
        return addComment(identifier, `${prLabel(pr)} was closed without merging by @${payload.sender.login}: ${pr.html_url}`);
      }
      if (sender !== config.ownerLogin) {
        return addComment(identifier, `${prLabel(pr)} was merged by @${payload.sender.login}, not by the approver: ${pr.html_url}`);
      }
      return decide(
        pr,
        identifiers,
        "approve",
        `Approved: ${prLabel(pr)} merged into \`${pr.base?.ref}\` by @${payload.sender.login} (${pr.merge_commit_sha?.slice(0, 12) ?? "no sha"}).\n\n${pr.html_url}`,
      );
    }

    if (event === "pull_request_review") {
      if (payload.action !== "submitted") return { ignored: `pull_request_review.${payload.action}` };
      if (sender !== config.ownerLogin) return { ignored: `review by @${payload.sender?.login}` };
      const pr = payload.pull_request;
      const review = payload.review;
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) return { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
      const state = review.state?.toLowerCase();
      if (state === "approved" && !command(review.body)) {
        // Merging is the approval; a GitHub approval alone changes nothing.
        return { ignored: "GitHub approval (merge to approve in Paperclip)" };
      }
      const kind = state === "changes_requested" ? "changes" : command(review.body);
      const text = clip(stripCommand(review.body));
      const inline = `Inline comments, if any: \`gh api repos/${payload.repository.full_name}/pulls/${pr.number}/reviews/${review.id}/comments\``;
      const comment = `${heading(kind, "Review", pr)} (${review.html_url}):\n\n${text || "(no summary)"}\n\n${inline}`;
      if (kind === "changes" || kind === "approve") return decide(pr, identifiers, kind, comment);
      if (!text) return { ignored: "review with no summary text" };
      return commentOnTarget(pr, identifiers, comment);
    }

    if (event === "issue_comment") {
      if (payload.action !== "created") return { ignored: `issue_comment.${payload.action}` };
      if (!payload.issue?.pull_request) return { ignored: "comment on an issue, not a PR" };
      if (sender !== config.ownerLogin) return { ignored: `comment by @${payload.sender?.login}` };
      // The issue stands in for the PR (title, body, number, html_url), but it has
      // no branch, so only the title and body are searched for identifiers.
      const pr = payload.issue;
      const identifiers = findIdentifiers(pr, prefixes);
      if (!identifiers.length) return { ignored: `${prLabel(pr)} names no ${prefixLabel()} issue` };
      const kind = command(payload.comment.body);
      const text = clip(stripCommand(payload.comment.body));
      const comment = `${heading(kind, "Comment", pr)} (${payload.comment.html_url}):\n\n${text || "(no text)"}`;
      if (kind) return decide(pr, identifiers, kind, comment);
      return commentOnTarget(pr, identifiers, comment);
    }

    return { ignored: `event ${event}` };
  }

  // ------------------------------------------------------------ HTTP server

  const stats = { handled: 0, failed: 0, lastEventAt: null, lastError: null };

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
      const result = await handle(event, payload);
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
          });
          resolve(server.address().port);
        });
      });
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...inflight]);
    },
  };
}
