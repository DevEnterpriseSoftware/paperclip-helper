// One-off commands: `pch <command>` (docker compose run --rm helper <command>).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./store.mjs";
import { createGitHub, tokenSource } from "./github.mjs";
import { companyAgents, companyPrefixes } from "./paperclip.mjs";
import { approvalWaitingOn, COMMAND_SIGNATURE, DECISION_STATUS, effortOf, plural, signed } from "./util.mjs";
import { createCostSync } from "./cost-sync.mjs";
import { blocked as blockedReport } from "./blocked.mjs";
import { holdFacts, releaseHold, releaseProblems, RELEASE_OUTCOMES, unprovable } from "./release.mjs";
import {
  clearLink,
  clearProblems,
  describeLink,
  ENABLE_SETTING_HINT,
  isolatedWorkspacesEnabled,
  issuesLinkedTo,
  linkFacts,
} from "./workspace.mjs";
import { closeWorkspace, lastFailedOperation, survey } from "./worktrees.mjs";
import { readUsage, render, summarize } from "./usage.mjs";
import { answerFor, findCard } from "./answer.mjs";
export { why } from "./why.mjs";
import { excerpt } from "./advice.mjs";

export const USAGE = `Paperclip Helper: fixes what a self-hosted Paperclip doesn't recover from by itself.

Usage: pch [command]   (no command: run every enabled component, as the container does)

What's going on
  status                     what the running helper is doing, and when its key expires
  why ISSUE [--prompt]       why nobody is working on an issue, and what to do about it
                             (--prompt: the same as a prompt for an LLM chat)
  blocked                    what every blocked issue waits on, and every question card waiting
  usage [--days N] [--agent NAME]
                             where the tokens go: runs, tokens and cost per agent, and what woke it
  check [ISSUE]              who the key belongs to; with an issue, what a merge would do to it

Decide and unblock
  approve ISSUE [comment]    approve an issue whose approval is waiting on you
  changes ISSUE comment      request changes (the comment becomes the brief)
  comment ISSUE text         comment as you (wakes the assignee)
  answer ISSUE CARD text     answer a question card (CARD: its id, or the start of it)
  release ISSUE [--apply] [--outcome mixed|completed|not_performed]
                             release an execution hold whose run can't prove it stopped
  workspace ISSUE [--apply]  give an issue linked to a closed (or another issue's) workspace its own

Housekeeping
  worktrees [--apply] [--min-days N] [--include-untracked] [--include-unmerged]
                             close finished issues' workspaces, so Paperclip removes their worktrees
  models                     every agent's adapter, model and effort
  set-model FROM TO [--apply]
                             move every agent on model FROM to TO

Costs
  costs                      what cost sync would post (changes nothing)
  costs --sessions           whether resumed sessions report cumulative costs
  costs --audit [--days N]   check the last N days' cost figures (default 7; changes nothing)

Setup
  login                      create the helper's board API key (approve it in the browser)
  revoke                     revoke the key and delete it
  secret                     print a random webhook secret for GITHUB_WEBHOOK_SECRET
  update                     update to the latest release of this major version
  version                    print the version

Commands with --apply only preview without it. An option's value can follow it
(--days 7) or be joined to it (--days=7). Text that starts with -- goes after a bare --:
  pch comment ACM-1 -- --force is fine here

Settings come from .env: https://github.com/DevEnterpriseSoftware/paperclip-helper`;

// Lines go to the console, or to `sink` while a command collects its own output.
let sink = null;
const out = (line = "") => (sink ? sink.push(line) : console.log(line));

// ---------------------------------------------------------------- key

export async function login(ctx) {
  const { config, api } = ctx;
  const challenge = await api.request(
    "POST",
    "/api/cli-auth/challenges",
    { command: `${config.keyName} login`, clientName: config.keyName, requestedAccess: "board" },
    { token: "" },
  );
  const approvalUrl = config.publicUrl
    ? `${config.publicUrl}${challenge.approvalPath}`
    : challenge.approvalUrl ?? `${config.paperclipApi}${challenge.approvalPath}`;
  out("\nOpen this link in a browser where you're signed in to Paperclip, and approve:\n");
  out(`  ${approvalUrl}\n`);
  out("If that host isn't reachable from your browser, keep the path and use the");
  out("address you normally open Paperclip at (set PAPERCLIP_PUBLIC_URL to fix the link).\n");
  out("Waiting for approval…");

  const deadline = Date.parse(challenge.expiresAt);
  for (;;) {
    if (Date.now() > deadline) throw new Error("the approval link expired; run login again");
    const status = await api.request(
      "GET",
      `/api${challenge.pollPath}?token=${encodeURIComponent(challenge.token)}`,
      undefined,
      { token: "" },
    );
    if (status.status === "approved") break;
    if (status.status === "cancelled" || status.status === "expired") throw new Error(`the approval was ${status.status}; run login again`);
    await new Promise((r) => setTimeout(r, Math.max(1000, challenge.suggestedPollIntervalMs ?? 1000)));
  }

  // Swap the 30-day CLI token for a named key you can find and revoke later.
  const temp = challenge.boardApiToken;
  const expiresAt =
    config.keyExpiresDays > 0 ? new Date(Date.now() + config.keyExpiresDays * 86_400_000).toISOString() : null;
  const key = await api.request("POST", "/api/board-api-keys", { name: config.keyName, expiresAt }, { token: temp });
  await api.request("POST", "/api/cli-auth/revoke-current", {}, { token: temp }).catch(() => {});

  fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
  fs.writeFileSync(config.tokenFile, `${key.token}\n`, { mode: 0o600 });
  const identity = await api.whoAmI({ refresh: true });
  out(`Saved the "${config.keyName}" key for ${identity.user?.name ?? identity.userId} to ${config.tokenFile}.`);
  out(expiresAt ? `It expires on ${expiresAt.slice(0, 10)}; \`pch status\` warns you in advance.` : "It does not expire.");
}

export async function revoke(ctx) {
  await ctx.api.request("POST", "/api/cli-auth/revoke-current", {});
  fs.rmSync(ctx.config.tokenFile, { force: true });
  out(`Revoked the helper's key and deleted ${ctx.config.tokenFile}.`);
}

// The helper's own key record (name, expiry), matched by the key id.
export async function currentKey(ctx) {
  const me = await ctx.identity();
  if (!me.keyId) return null;
  const keys = await ctx.api.request("GET", "/api/board-api-keys").catch(() => []);
  return (Array.isArray(keys) ? keys : []).find((k) => k.id === me.keyId) ?? null;
}

function expiryNote(key) {
  if (!key) return "";
  if (!key.expiresAt) return `key "${key.name}", no expiry`;
  const days = Math.floor((Date.parse(key.expiresAt) - Date.now()) / 86_400_000);
  if (days < 0) return `key "${key.name}", expired ${key.expiresAt.slice(0, 10)}: get a new one with \`pch login\``;
  const warn = days < 30 ? `: renew it soon with \`pch login\`` : "";
  return `key "${key.name}", expires ${key.expiresAt.slice(0, 10)} (in ${plural(days, "day")}${warn})`;
}

// ---------------------------------------------------------------- check

export async function check(ctx, identifier) {
  const { api } = ctx;
  const me = await ctx.identity();
  out(`Key belongs to: ${me.user?.name ?? "?"} <${me.user?.email ?? "?"}> (${me.userId}), via ${me.source}`);
  const key = await currentKey(ctx);
  if (key) out(`Key: ${expiryNote(key)}`);
  for (const companyId of me.companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => null);
    out(`Company: ${company?.name ?? companyId} (issue prefix ${company?.issuePrefix ?? "?"})`);
  }
  if (ctx.config.relayFixConflicts && (ctx.config.githubToken || ctx.config.githubTokenFile)) {
    // Reading is all this can try: commenting is only tested by doing it.
    const github = createGitHub({ config: ctx.config, log: ctx.log });
    for (const repo of ctx.config.repos) {
      try {
        const pulls = await github.openPulls(repo);
        out(`GitHub: ${tokenSource(ctx.config)} reads ${repo} (${pulls.length} open ${pulls.length === 1 ? "PR" : "PRs"})`);
      } catch (err) {
        out(`GitHub: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
  if (!identifier) return;
  const issue = await api.request("GET", `/api/issues/${encodeURIComponent(identifier)}`);
  const state = issue.executionState;
  out(`${identifier}: status ${issue.status}; stage ${state?.currentStageType ?? "none"} (${state?.status ?? "no execution state"})`);
  out(`Current participant: ${JSON.stringify(state?.currentParticipant ?? null)}`);
  out(
    approvalWaitingOn(issue, me.userId)
      ? "A merge by you would approve it (status done), unless the PR names another issue that's also waiting on you."
      : "A merge would only add a comment: the decision is not waiting on you.",
  );
}

// ---------------------------------------------------------------- blocked

export async function blocked(ctx) {
  await blockedReport(ctx, out);
}

// ---------------------------------------------------------------- release

// An execution hold that messages and Interrupt can't clear (see release.mjs).
// Shows the hold and the held run; --apply records the board's reconciliation
// (the run has stopped; what it did is unverified unless --outcome says
// otherwise) and delivers the saved messages.
export async function release(ctx, identifier, { apply = false, outcome: actionOutcome = "mixed" } = {}) {
  if (!identifier) throw new Error("usage: pch release ISSUE [--apply] [--outcome mixed|completed|not_performed]");
  if (!RELEASE_OUTCOMES.includes(actionOutcome)) {
    throw new Error(`--outcome must be one of ${RELEASE_OUTCOMES.join(", ")}`);
  }
  const facts = await holdFacts(ctx.api, identifier);
  const { issue, hold, run, agent, queue } = facts;
  if (!hold) {
    out(`${identifier}: no execution hold. Nothing to release; \`pch why ${identifier}\` says what else is going on.`);
    return;
  }
  out(`${identifier}: ${issue.status}, held: ${hold.cause ?? "unknown cause"}`);
  if (hold.nextAction) out(`  Paperclip: ${hold.nextAction}`);
  out(`Held run: ${hold.runId ?? "?"}${agent?.name ? ` (${agent.name})` : ""}`);
  if (run) {
    const l = run.environmentLease;
    out(`  ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}, finished ${run.finishedAt ?? "never"}`);
    if (run.detailRead) {
      out(`  process: ${run.processPid ?? "none recorded"}${run.processGroupId ? `, group ${run.processGroupId}` : ""}`);
    }
    if (l) out(`  lease: ${l.status}${l.releasedAt ? "" : " (not released)"}${l.cleanupStatus ? `, cleanup ${l.cleanupStatus}` : ""}`);
  } else {
    out("  (not among the issue's runs)");
  }
  const saved = queue?.entries?.length ?? 0;
  if (saved) out(`Saved messages: ${saved}${queue.executionWait?.message ? ` ("${queue.executionWait.message}")` : ""}`);
  if (unprovable(facts)) out("Paperclip can't release this by itself: the run recorded no process it could check.");

  const problems = releaseProblems(facts);
  if (problems.length) {
    throw new Error(`Not releasing: ${problems.join("; ")}. Nothing changed.`);
  }
  if (!apply) {
    out("");
    out(`--apply records, as the board, that this run has stopped and that what it did is ${actionOutcome === "mixed" ? "unverified (mixed)" : actionOutcome.replace("_", " ")},`);
    out(`moves ${identifier} to todo, and ${saved ? "delivers the saved messages" : "lets the next message start a run"}.`);
    out("Only do it if no agent process from that run is still running. Have the agent check the branch before it continues.");
    out(`  pch release ${identifier} --apply${actionOutcome !== "mixed" ? ` --outcome ${actionOutcome}` : ""}`);
    return;
  }
  let result;
  try {
    result = await releaseHold(ctx.api, facts, { actionOutcome, signature: `\n\n${COMMAND_SIGNATURE}` });
  } catch (err) {
    if (err.stillHeld) throw new Error(`${err.message}. Run \`pch why ${identifier}\`.`);
    throw err;
  }
  out(`${identifier}: hold released (${result.status}).`);
  if (result.delivered) out(`Delivered ${result.delivered} saved message(s) to ${agent?.name ?? "the assignee"}.`);
  else if (result.waiting) out(`${result.waiting} saved message(s) are waiting; they start with the next run.`);
  else out(`No saved messages: \`pch comment ${identifier} "..."\` tells the assignee what to do next.`);
}

// ---------------------------------------------------------------- workspace

// An issue linked to a closed workspace fails every run at setup; one linked to
// another issue's live workspace works on that issue's branch (see workspace.mjs).
// Shows the link; --apply gives the issue a new isolated workspace, like "New
// isolated workspace" in its Workspace picker. With a closed workspace, the other
// open issues still linked to it are fixed too: they'd fail the same way.
export async function workspace(ctx, identifier, { apply = false } = {}) {
  if (!identifier) throw new Error("usage: pch workspace ISSUE [--apply]");
  const { api } = ctx;
  const facts = await linkFacts(api, identifier);
  const { issue } = facts;
  const label = (i) => i.identifier ?? String(i.id).slice(0, 8);
  out(`${label(issue)}: ${issue.status}${issue.title ? ` — ${issue.title}` : ""}`);
  const line = describeLink(facts);
  out(`Workspace: ${line ?? "no link to another workspace; each run gets the one the project's policy says"}`);
  if (facts.state === "none" || facts.state === "own") {
    out("Nothing to clear.");
    return;
  }

  const runsOf = async (ref) => {
    const r = await api.request("GET", `/api/issues/${encodeURIComponent(ref)}/runs`).catch(() => []);
    return Array.isArray(r) ? r : [];
  };
  const problems = clearProblems(facts, await runsOf(issue.id ?? identifier));
  if (problems.length) throw new Error(`Not changing ${label(issue)}: ${problems.join("; ")}. Nothing changed.`);

  // A closed workspace fails every issue linked to it; a live one may be shared
  // on purpose, so only the issue you named is changed.
  const others = facts.state === "dead" ? await issuesLinkedTo(api, issue.companyId, facts.workspaceId, { exceptId: issue.id }) : [];
  if (others.length) {
    out(`Also linked to it: ${others.map((i) => `${label(i)} (${i.status})`).join(", ")}`);
  }
  const targets = [issue, ...others];

  const enabled = await isolatedWorkspacesEnabled(api);
  if (enabled === false) throw new Error(`${ENABLE_SETTING_HINT} Nothing changed.`);

  if (!apply) {
    out("");
    out(`--apply gives ${targets.length === 1 ? label(issue) : `these ${targets.length} issues`} a new isolated workspace on the next run,`);
    out(`like "New isolated workspace" in the issue's Workspace picker. Its other workspace settings (a pinned branch, the environment) are kept.`);
    if (facts.state === "foreign") {
      out(`Its runs stop working on ${facts.owner?.identifier ?? "the other issue"}'s branch. Anything it already committed there stays there.`);
    } else if (facts.ownClosed) {
      out("It is the issue's own workspace: the new one starts from the base branch, not from that workspace's branch, which is left as it is.");
    } else {
      out("The closed workspace and its branch are left as they are.");
    }
    out(`  pch workspace ${identifier} --apply`);
    return;
  }

  let failed = 0;
  for (const target of targets) {
    // The full issue, for its current settings (list rows don't carry them) and state.
    const full = target === issue ? issue : await api.request("GET", `/api/issues/${target.id}`).catch(() => null);
    if (!full) {
      out(`${label(target)}: left alone (couldn't read it).`);
      continue;
    }
    if (target !== issue) {
      const p = full.executionWorkspaceId !== facts.workspaceId
        ? ["its link changed meanwhile"]
        : clearProblems({ ...facts, issue: full }, await runsOf(full.id), full);
      if (p.length) {
        out(`${label(target)}: left alone (${p.join("; ")}).`);
        continue;
      }
    }
    const result = await clearLink(api, full);
    if (!result.ok) {
      failed += 1;
      out(`${label(target)}: Paperclip kept the link.`);
      continue;
    }
    out(`${label(target)}: linked to no other workspace now; the next run gets a new isolated one.`);
  }
  if (failed) {
    throw new Error(enabled === null ? `${failed} issue(s) kept the link. ${ENABLE_SETTING_HINT}` : `${failed} issue(s) kept the link.`);
  }
  const who = issue.assigneeAgentId ? (await api.request("GET", `/api/agents/${issue.assigneeAgentId}`).catch(() => null))?.name : null;
  out("");
  out("Nothing restarts by itself. To have the assignee carry on:");
  out(
    `  pch comment ${identifier} "${who ? `${who}, the` : "The"} workspace is fixed: you have a new isolated workspace. ` +
      `Please continue this issue."`,
  );
}

// ---------------------------------------------------------------- worktrees

// Workspaces of finished issues still on disk (see worktrees.mjs). Lists what
// Paperclip would remove, what it would throw away work for, and what it
// refuses; --apply closes the first group one by one, as the Close button does.
export async function worktrees(ctx, { apply = false, minDays = 1, includeUntracked = false, includeUnmerged = false } = {}) {
  const { api } = ctx;
  if (!Number.isFinite(minDays) || minDays < 0) throw new Error("--min-days must be a number of days, 0 or more");
  const opts = { includeUntracked, includeUnmerged };

  const me = await ctx.identity();
  const now = ctx.now();
  const label = (i) => i.identifier ?? String(i.id).slice(0, 8);
  const row = (r, note) => {
    const days = r.days === null ? "   ?" : `${Math.floor(r.days)}d`.padStart(4);
    const branch = r.ws.branchName ?? r.ws.name ?? r.ws.id.slice(0, 8);
    return `    ${label(r.issue).padEnd(10)} ${r.issue.status.padEnd(9)} ${days}  ${note ? `${note}  ` : ""}${branch.length > 70 ? `${branch.slice(0, 69)}…` : branch}`;
  };
  const toClose = [];
  let reviewCount = 0;
  const hasGitHub = Boolean(ctx.config.githubToken || ctx.config.githubTokenFile);
  const github = hasGitHub ? createGitHub({ config: ctx.config, log: ctx.log }) : null;

  for (const companyId of me.companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => ({}));
    const name = company.issuePrefix ?? company.name ?? companyId;
    const { counts, results, failedBefore, githubErrors } = await survey(api, companyId, {
      now,
      minDays,
      flags: opts,
      github,
      repos: ctx.config.repos ?? [],
    });
    if (!counts.workspaces) {
      out(`${name}: no open workspaces.`);
      continue;
    }
    const close = results.filter((r) => r.action === "close");
    const review = results.filter((r) => r.action === "review");
    const skip = results.filter((r) => r.action === "skip");
    out(`${name}: ${plural(counts.workspaces, "open workspace")}, ${results.length} of them worktrees of issues finished ${minDays ? `${minDays}+ days ago` : "at any time"}`);
    if (close.length) {
      out(`  Paperclip can close ${close.length} and remove their worktrees:`);
      for (const r of close) out(row(r, r.reasons.length ? `(${r.reasons.join(", ")})` : ""));
    }
    if (review.length) {
      out(`  ${review.length} may hold work that isn't on GitHub. Look at these yourself:`);
      for (const r of review) out(row(r, r.reasons.join(", ")));
    }
    if (skip.length) {
      out(`  Paperclip won't close ${skip.length}:`);
      for (const r of skip) out(row(r, r.reasons[0]));
    }
    if (failedBefore.length) {
      out(`  ${failedBefore.length} were closed before, but their clean-up failed. Paperclip treats them as closed and won't retry;`);
      out("  if a folder below still exists, remove it with `git worktree remove --force <folder>` from the project's checkout:");
      for (const f of failedBefore) {
        const who = f.issue ? label(f.issue).padEnd(10) : "?".padEnd(10);
        out(`    ${who} ${f.ws.cwd ?? f.ws.providerRef ?? f.ws.branchName ?? f.ws.id}`);
        if (f.ws.cleanupReason) out(`               ${excerpt(f.ws.cleanupReason, 160)}`);
      }
    }
    const notLooked = [
      counts.open && `${counts.open} of open issues`,
      counts.recent && `${counts.recent} of issues finished in the last ${minDays === 1 ? "day" : `${minDays} days`}`,
      counts.shared && `${counts.shared} sessions on the project's shared checkout (nothing to free)`,
      counts.noIssue && `${counts.noIssue} with no source issue`,
    ].filter(Boolean);
    if (notLooked.length) out(`  Left alone: ${notLooked.join(", ")}.`);
    if (!hasGitHub && review.some((r) => r.reasons.some((x) => / not on /.test(x)))) {
      out("  Without GITHUB_TOKEN or GITHUB_TOKEN_FILE, a squash-merged branch looks unmerged: set one to have merged PRs checked.");
    }
    for (const e of githubErrors) out(`  GitHub: ${e}`);
    toClose.push(...close);
    reviewCount += review.length;
  }

  if (!toClose.length) {
    out("");
    out("Nothing to close.");
    return;
  }
  if (!apply) {
    out("");
    out(`--apply closes these ${plural(toClose.length, "workspace")}, as their Close button does: Paperclip stops their runtime services,`);
    out("removes the git worktrees (untracked build output with them) and deletes the branches it created once they're merged.");
    out("Issues and their history stay. Reopening an issue later gives it a new workspace.");
    if (reviewCount && !(opts.includeUntracked && opts.includeUnmerged)) {
      out("--include-untracked also closes those with untracked files; --include-unmerged those with commits that aren't merged. Modified files are never closed.");
    }
    const same = [minDays !== 1 && `--min-days ${minDays}`, includeUntracked && "--include-untracked", includeUnmerged && "--include-unmerged"].filter(Boolean);
    out(`  pch worktrees --apply${same.map((f) => ` ${f}`).join("")}`);
    return;
  }

  out("");
  let closed = 0;
  const failed = [];
  for (const r of toClose) {
    try {
      const result = await closeWorkspace(api, r.ws);
      if (result.alreadyClosed) {
        out(`${label(r.issue)}: already closed (${result.status})${result.cleanupReason ? `: ${excerpt(result.cleanupReason, 160)}` : ""}`);
      } else if (result.ok) {
        closed += 1;
        out(`${label(r.issue)}: closed${result.cleanupReason ? ` (${excerpt(result.cleanupReason, 160)})` : ""}`);
      } else {
        failed.push(r);
        out(`${label(r.issue)}: ${result.status}${result.cleanupReason ? `: ${excerpt(result.cleanupReason, 200)}` : ""}`);
        const op = await lastFailedOperation(api, r.ws.id);
        for (const line of op) out(`  | ${line}`);
      }
    } catch (err) {
      failed.push(r);
      out(`${label(r.issue)}: not closed: ${err.message}`);
    }
  }
  out("");
  out(`Closed ${plural(closed, "workspace")}.${failed.length ? ` ${failed.length} didn't close cleanly; their worktrees may still be on disk.` : ""}`);
  if (failed.length) process.exitCode = 1;
}

// ---------------------------------------------------------------- decisions

// approve / changes: the same decision the relay records on a merge or review.
export async function decide(ctx, kind, identifier, text) {
  if (!identifier) throw new Error(`usage: pch ${kind} ISSUE ${kind === "approve" ? "[comment]" : "comment"}`);
  if (kind === "changes" && !text) throw new Error("changes needs a comment: it becomes the engineer's brief");
  const comment = text || "Approved.";
  const issue = await ctx.api.request("GET", `/api/issues/${encodeURIComponent(identifier)}`);
  const { userId } = await ctx.identity();
  if (!approvalWaitingOn(issue, userId)) {
    const p = issue.executionState?.currentParticipant;
    throw new Error(
      `${identifier} is ${issue.status}; its decision isn't waiting on you ` +
        `(current participant: ${p ? `${p.type} ${p.agentId ?? p.userId}` : "none"}). Nothing changed.`,
    );
  }
  await ctx.api.request("PATCH", `/api/issues/${encodeURIComponent(identifier)}`, {
    status: DECISION_STATUS[kind],
    comment: signed(comment, COMMAND_SIGNATURE),
  });
  out(`${identifier}: ${kind === "approve" ? "approved (done)" : "changes requested (back to the engineer)"}.`);
}

export async function answer(ctx, identifier, cardRef, text) {
  if (!identifier || !cardRef) throw new Error('usage: pch answer ISSUE CARD "answer" (CARD: its id, or the start of it)');
  const cards = await ctx.api.request("GET", `/api/issues/${encodeURIComponent(identifier)}/interactions`);
  const card = findCard(cards, cardRef);
  const { body, prompt, answer: given } = answerFor(card, text);
  await ctx.api.request("POST", `/api/issues/${encodeURIComponent(identifier)}/interactions/${card.id}/respond`, body);
  out(`Answered card ${card.id} on ${identifier}: "${prompt}" → ${given}`);
}

export async function comment(ctx, identifier, text) {
  if (!identifier || !text) throw new Error("usage: pch comment ISSUE text");
  await ctx.api.request("POST", `/api/issues/${encodeURIComponent(identifier)}/comments`, { body: signed(text, COMMAND_SIGNATURE) });
  out(`${identifier}: comment added.`);
}

// ---------------------------------------------------------------- agent models

async function listAgents(ctx) {
  const { companyIds = [] } = await ctx.identity();
  const agents = [];
  for (const companyId of companyIds) agents.push(...(await companyAgents(ctx.api, companyId)));
  return agents;
}


export async function models(ctx) {
  const agents = await listAgents(ctx);
  for (const a of agents.sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
    const cfg = a.adapterConfig ?? {};
    out(
      `${String(a.name).padEnd(16)} ${String(a.adapterType ?? "").padEnd(14)} ${String(cfg.model ?? "(default)").padEnd(20)} ` +
        `${String(effortOf(cfg)).padEnd(8)} ${a.status ?? ""}`,
    );
  }
}

// PATCH merges into adapterConfig, so only the model changes: effort, engine,
// env and everything else stay as they are. Preview unless --apply is given.
export async function setModel(ctx, from, to, { apply = false } = {}) {
  if (!from || !to) throw new Error("usage: pch set-model FROM TO [--apply]");
  const targets = (await listAgents(ctx)).filter((a) => a.adapterConfig?.model === from);
  if (!targets.length) {
    out(`No agent uses ${from}.`);
    return;
  }
  let problems = 0;
  for (const a of targets) {
    const before = a.adapterConfig ?? {};
    if (!apply) {
      out(`would change ${a.name}: ${from} → ${to} (effort ${effortOf(before) || "unset"} kept)`);
      continue;
    }
    await ctx.api.request("PATCH", `/api/agents/${a.id}`, { adapterConfig: { model: to } });
    const after = (await ctx.api.request("GET", `/api/agents/${a.id}`)).adapterConfig ?? {};
    const lost = Object.keys(before).filter((k) => k !== "model" && !(k in after));
    const ok = after.model === to && effortOf(after) === effortOf(before) && lost.length === 0;
    if (!ok) problems += 1;
    out(
      `${ok ? "changed" : "CHECK  "} ${a.name}: ${before.model} → ${after.model}, effort ${effortOf(before) || "unset"} → ${effortOf(after) || "unset"}` +
        (lost.length ? `, settings missing afterwards: ${lost.join(", ")}` : ""),
    );
  }
  if (!apply) out(`\n${targets.length} agent(s). Run again with --apply to change them.`);
  if (problems) throw new Error(`${problems} agent(s) need checking: see the lines marked CHECK.`);
}

// ---------------------------------------------------------------- usage

export async function usage(ctx, { days = 7, agent = null } = {}) {
  if (!(days > 0)) throw new Error("--days needs a number of days, e.g. --days 7");
  const opts = { days, agent };
  const until = ctx.now();
  const since = until - opts.days * 24 * 60 * 60_000;
  const { companyIds = [] } = await ctx.identity();
  let found = false;
  for (const companyId of companyIds) {
    const data = await readUsage(ctx.api, companyId, { since, until, agentName: opts.agent });
    if (opts.agent && !data.agents.length) continue; // the agent is in another company
    found = true;
    if (companyIds.length > 1) {
      const company = await ctx.api.request("GET", `/api/companies/${companyId}`).catch(() => null);
      out(`== ${company?.name ?? companyId}`);
    }
    for (const line of render(summarize({ ...data, since }), { days: opts.days, truncated: data.truncated, costError: data.costError })) out(line);
    if (companyIds.length > 1) out("");
  }
  if (opts.agent && !found) out(`No agent called ${opts.agent}.`);
}

// ---------------------------------------------------------------- costs

export async function costs(ctx, { sessions = false, audit = false, days = 7, given = new Set() } = {}) {
  if (sessions && audit) throw new Error("usage: pch costs [--sessions | --audit [--days N]] (one at a time)");
  if (given.has("days") && !audit) throw new Error("--days goes with --audit: pch costs --audit --days N");
  const sync = createCostSync(ctx);
  if (sessions) return sync.sessions();
  if (audit) {
    if (!(days > 0)) throw new Error("usage: pch costs --audit [--days N]");
    return sync.audit({ days, print: out });
  }
  if (!ctx.config.costSync) out("(COST_SYNC is off: this is what it would post if you turned it on.)\n");
  return sync.preview();
}

// ---------------------------------------------------------------- status / health

export function readStatus(config) {
  return readJson(config.statusFile, null);
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

// Paperclip's version and build commit, e.g. "2026.1001.0, commit 8f8a0ab".
// Its health endpoint reports them only to an authenticated caller, so this
// asks with the helper's key. Null when it reports neither.
export async function paperclipBuild(ctx) {
  const h = await ctx.api.request("GET", "/api/health").catch(() => null);
  if (!h || typeof h !== "object") return null;
  const version = typeof h.version === "string" && h.version ? h.version : null;
  const commit = typeof h.commit === "string" && h.commit ? `commit ${h.commit.slice(0, 7)}` : null;
  return [version, commit].filter(Boolean).join(", ") || null;
}

// The service writes its status every 30 s; one older than this means it has stopped.
const HEARTBEAT_STALE_MS = 120_000;

// A count worth showing, in words: "3 nudges", or nothing for zero.
const counted = (n, one, many) => (n ? plural(n, one, many) : null);
const since = (iso) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "?");

export async function status(ctx) {
  const s = readStatus(ctx.config);
  const stale = !s || Date.now() - Date.parse(s.heartbeatAt ?? 0) > HEARTBEAT_STALE_MS;
  if (!s) {
    out("The helper service has not written a status yet: is it running? (docker compose ps, docker compose logs)");
  } else {
    out(
      stale
        ? `Paperclip Helper ${s.version}: NOT RUNNING. Its last heartbeat was ${ago(s.heartbeatAt)} (started ${since(s.startedAt)}).`
        : `Paperclip Helper ${s.version}: running since ${since(s.startedAt)}.`,
    );
    if (s.dryRun) out("DRY RUN: components log what they would do and change nothing.");
    const r = s.relay;
    out(r?.on ? `Relay: on. ${plural(r.handled, "delivery", "deliveries")} handled, ${r.failed} failed, the last ${ago(r.lastEventAt)}.` : "Relay: off.");
    if (r?.lastError) out(`  Last error: ${r.lastError}`);
    const k = r?.on ? r.conflicts : null;
    if (k) out(`  Merge conflicts: ${plural(k.sentBack, "PR")} sent back, last look ${ago(k.lastSweepAt)}.${k.lastError ? ` Last error: ${k.lastError}` : ""}`);
    const q = r?.on ? r.mergeQueue : null;
    if (q) {
      const parts = [plural(q.dropped, "drop") + " handled", `${q.sentBack} sent back`, `${q.noted} told to you`, counted(q.requeued, "queued again", "queued again")];
      out(`  Merge queue: ${parts.filter(Boolean).join(", ")}.${q.lastError ? ` Last error: ${q.lastError}` : ""}`);
    }
    const w = s.watchdog;
    if (w?.on) {
      out(`Watchdog: on. Last check ${ago(w.lastTickAt)}${w.lastTickMs != null ? ` (${w.lastTickMs} ms)` : ""}.`);
      const done = [
        counted(w.nudges, "nudge"),
        counted(w.heals, "blocker repaired", "blockers repaired"),
        counted(w.retries, "deferred wake retried", "deferred wakes retried"),
        counted(w.releases, "hold released", "holds released"),
        counted(w.deadLinks, "link to a closed workspace cleared", "links to a closed workspace cleared"),
        counted(w.questions, "undelivered question card routed", "undelivered question cards routed"),
        counted(w.ciReports, "finished CI run reported", "finished CI runs reported"),
        counted(w.ciReruns, "flaky CI run re-run", "flaky CI runs re-run"),
        counted(w.returned, "issue returned to its agent", "issues returned to their agent"),
        counted(w.resumed, "issue restored after a resume", "issues restored after a resume"),
        w.limitPauses ? `${plural(w.limitPauses, "agent")} paused at a usage limit (${w.limitResumes} resumed)` : null,
        counted(w.reopened, "done issue with an open PR reopened", "done issues with an open PR reopened"),
        counted(w.wipes, "wiped review stage reported", "wiped review stages reported"),
      ].filter(Boolean);
      out(`  Since start: ${done.length ? done.join(", ") : "nothing needed doing"}.`);
      if (w.stuck) out(`  ${plural(w.stuck, "issue")} stuck behind a deferred wake: see the log.`);
      if (w.lastError) out(`  Last error: ${w.lastError}`);
    } else {
      out("Watchdog: off.");
    }
    const c = s.costSync;
    out(
      c?.on
        ? `Cost sync: on. Last run ${ago(c.lastTickAt)}; ${plural(c.posted ?? 0, "run")} ($${((c.postedCents ?? 0) / 100).toFixed(2)}) posted since start.`
        : "Cost sync: off.",
    );
    if (c?.lastError) out(`  Last error: ${c.lastError}`);
    const unpriced = Object.entries(c?.unpriced ?? {});
    if (unpriced.length) out(`  Not priced: ${unpriced.map(([m, n]) => `${m} (${plural(n, "run")})`).join(", ")}; see COST_PRICES_FILE and CODEX_DEFAULT_MODEL.`);
  }
  // Live checks, from this container.
  try {
    const me = await ctx.identity();
    const key = await currentKey(ctx);
    const build = await paperclipBuild(ctx);
    out(`Paperclip: ${ctx.config.paperclipApi}${build ? ` (${build})` : ""} as ${me.user?.name ?? me.userId}${key ? `; ${expiryNote(key)}` : ""}`);
  } catch (err) {
    out(`Paperclip: ${err.message}`);
    process.exitCode = 1;
  }
  if (stale) process.exitCode = 1;
}

// Docker HEALTHCHECK: the service's heartbeat is fresh and the relay answers.
export async function health(ctx) {
  const s = readStatus(ctx.config);
  if (!s || Date.now() - Date.parse(s.heartbeatAt ?? 0) > HEARTBEAT_STALE_MS) throw new Error("no recent heartbeat from the service");
  if (s.relay?.on) {
    const host = ["0.0.0.0", "::", ""].includes(ctx.config.listenHost) ? "127.0.0.1" : ctx.config.listenHost;
    const res = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${ctx.config.listenPort}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`relay /healthz answered ${res.status}`);
  }
  out("ok");
}

// For the installer: can this container reach Paperclip at URL? One JSON line.
export async function probe(ctx, url) {
  const base = (url || ctx.config.paperclipApi).replace(/\/+$/, "");
  const result = { url: base, ok: false };
  try {
    const res = await fetch(`${base}/api/health`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    result.status = res.status;
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (res.ok && data && typeof data === "object" && data.status) {
      result.ok = true;
      for (const k of ["status", "version", "deploymentMode", "deploymentExposure", "bootstrapStatus", "authReady"]) {
        if (data[k] !== undefined) result[k] = data[k];
      }
    } else if (res.status === 403 && /hostname is not allowed|Missing Host header/i.test(text)) {
      result.code = "hostname_guard";
      result.hostname = new URL(base).hostname;
    } else {
      result.code = "unexpected";
      result.body = text.slice(0, 200);
    }
  } catch (err) {
    result.code = err?.name === "TimeoutError" ? "timeout" : err?.cause?.code ?? "network";
  }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

// For the installer: the companies' issue prefixes, comma-separated.
export async function prefixes(ctx) {
  const me = await ctx.identity();
  console.log((await companyPrefixes(ctx.api, me.companyIds)).join(","));
}

export function secret() {
  console.log(crypto.randomBytes(32).toString("hex"));
}

// `pch update` is handled by the host-side pch.sh / pch.ps1, because this container
// can't pull its own image. Reaching this means pch runs the container directly:
// an alias from an installer older than 1.1, or a manual install.
export function update() {
  out("pch update runs on the host, and your pch command starts the helper's container directly.");
  out("Re-run the installer once to get the pch command that can update the helper:\n");
  out("  curl -fsSL https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.sh | bash");
  out("  irm https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.ps1 | iex   # Windows\n");
  out("Or update now, in the directory with compose.yml:\n");
  out("  docker compose pull && docker compose up -d");
}

// For the installer and `pch update`: the host-side pch script, `sh` or `ps1`.
export function wrapperScript(kind) {
  if (kind !== "sh" && kind !== "ps1") throw new Error("usage: wrapper sh|ps1");
  return fs.readFileSync(new URL(`../bin/pch.${kind}`, import.meta.url), "utf8");
}
