// One-off commands: `pch <command>` (docker compose run --rm helper <command>).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStatus, serviceLive } from "./instance.mjs";
import { createGitHub, tokenSource } from "./github.mjs";
import { companyAgents, companyPrefixes } from "./paperclip.mjs";
import { approvalWaitingOn, COMMAND_SIGNATURE, DECISION_STATUS, effortOf, pausedRefusal, plural, signed } from "./util.mjs";
import { createCostSync } from "./cost-sync.mjs";
import { blocked as blockedReport } from "./blocked.mjs";
import {
  actsAsUser, continuationText, continuePausedHold, CONVERSATION_ADAPTERS, holdFacts, pausedHold, releaseHold, releaseProblems, RELEASE_OUTCOMES, unprovable,
} from "./release.mjs";
import {
  clearLink,
  clearProblems,
  describeLink,
  ENABLE_SETTING_HINT,
  isolatedWorkspacesEnabled,
  issuesLinkedTo,
  linkFacts,
} from "./workspace.mjs";
import { age, closeWorkspace, folderOf, lastFailedOperation, survey } from "./worktrees.mjs";
import {
  awaitNextRuns, byCheckout, codeLabel, linkCheck, parkedOnValidation, RELATIVE_LINKS, repairCommands, retryProblem,
} from "./worktree-links.mjs";
import { readUsage, render, summarize } from "./usage.mjs";
import { answerFor, findCard } from "./answer.mjs";
export { why } from "./why.mjs";
import { excerpt } from "./advice.mjs";
import { findReady } from "./ready.mjs";
import { COUNTERS, minutesSaved, readMetrics } from "./metrics.mjs";
import { colours } from "./colour.mjs";

export const USAGE = `Paperclip Helper: fixes what a self-hosted Paperclip doesn't recover from by itself.

Usage: pch <command>

What's going on
  status                     what the running helper is doing, and when its key expires
  why ISSUE [--prompt]       why nobody is working on an issue, and what to do about it
                             (--prompt: the same as a prompt for an LLM chat)
  blocked                    what every blocked issue waits on, and every question card waiting
  ready                      PRs approved by every reviewer, clean and green, in queue order
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
  worktrees [--apply] [--min-days N] [--include-untracked] [--include-unmerged] [--verbose]
                             close finished issues' workspaces, so Paperclip removes their worktrees;
                             --verbose also lists each workspace left alone, and why
  worktrees --links [--retry]
                             issues whose every run fails at setup on relative worktree links: the
                             repair to run on the host (--retry: then wake them)
  models                     every agent's adapter, model and effort
  set-model FROM TO [--apply]
                             move every agent on model FROM to TO

Costs
  costs                      what cost sync would post (changes nothing)
  costs --sessions           whether resumed sessions report cumulative costs
  costs --audit [--days N]   check the last N days' cost figures (default 7; changes nothing)
  costs --compare-days N     the last N days' costs against the N days before: how much of the
                             change is usage, and how much 1.12's costing (changes nothing)
  costs --retry-skipped      post the runs Paperclip rejected again, on the service's next pass

Setup
  run                        run the service in the foreground, as its container does
                             (refuses while another helper runs on the same data directory)
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
        const count = `${pulls.length} open ${pulls.length === 1 ? "PR" : "PRs"}`;
        if (!pulls.length) {
          out(`GitHub: ${tokenSource(ctx.config)} reads ${repo} (${count})`);
          continue;
        }
        // The conflict sweep also reads each PR on its own (only that says whether it
        // merges), which is a different call from the list: try it on the oldest one.
        const number = pulls[0].number;
        try {
          await github.pull(repo, number);
          out(`GitHub: ${tokenSource(ctx.config)} reads ${repo} (${count}; PR #${number} read on its own too)`);
        } catch (err) {
          out(`GitHub: ${tokenSource(ctx.config)} lists ${repo}'s PRs (${count}), but reading PR #${number} on its own failed: ${err.summary ?? err.message}`);
          process.exitCode = 1;
        }
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

// ---------------------------------------------------------------- ready

// PRs ready to queue (ready.mjs): issues at your approval stage, every earlier stage
// done, whose PR is open, not a draft, and clean on GitHub. In queue order, then the
// issues at your approval that aren't ready and why. Read-only.
export async function ready(ctx) {
  const { config, api } = ctx;
  if (!config.githubToken && !config.githubTokenFile) throw new Error("pch ready reads the PRs from GitHub: set GITHUB_TOKEN or GITHUB_TOKEN_FILE (Pull requests: Read).");
  if (!config.repos.length) throw new Error("pch ready looks for PRs in GITHUB_REPOS: set it.");
  const github = createGitHub({ config, log: ctx.log });
  const me = await ctx.identity();
  for (const companyId of me.companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => null);
    const skipped = [];
    const list = await findReady({ api, config, github, userId: me.userId, companyId, skipped });
    const agents = new Map((await companyAgents(api, companyId).catch(() => [])).map((a) => [a.id, a]));
    out(`${company?.name ?? companyId}: ${list.length ? `${plural(list.length, "PR")} ready to queue, in queue order` : "no PR ready to queue"}`);
    list.forEach((r, i) => {
      const reviewers = r.reviewers.map((id) => agents.get(id)?.name).filter(Boolean);
      out(
        `  ${i + 1}. ${r.pr.repo}#${r.pr.number}  ${r.issue.identifier ?? r.issue.id}  ${r.issue.title ?? ""}`.trimEnd() +
          `${r.pr.sha ? `  (head ${String(r.pr.sha).slice(0, 9)})` : ""}${reviewers.length ? `  reviewed by ${reviewers.join(", ")}` : ""}`,
      );
      if (r.pr.url) out(`     ${r.pr.url}`);
    });
    if (skipped.length) {
      out("  At your approval, but not ready:");
      for (const s of skipped) out(`    ${s.issue.identifier ?? s.issue.id}: ${s.why}`);
    }
  }
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
  // A run a pause cancelled: Paperclip lifts its hold only on an explicit continuation
  // (release.mjs): the issue with that run's agent, and a board user's comment.
  if (pausedHold(facts)) {
    out("The run was cancelled when its agent was paused. The hold covers every agent's wakes on the issue; Paperclip lifts it only");
    out(`when a board user comments while ${agent?.name ?? "that agent"} has the issue and isn't paused.`);
    const name = agent?.name ?? "the run's agent";
    if (!agent || agent.status === "paused") throw new Error(`${name} is still paused: resume it first. Nothing changed.`);
    if (["terminated", "pending_approval"].includes(agent.status)) throw new Error(`${name} is ${agent.status}: only a reconciliation releases this hold. Nothing changed.`);
    if (!CONVERSATION_ADAPTERS.has(agent.adapterType)) throw new Error(`Paperclip continues only an agent on a conversation adapter, and ${name} is on ${agent.adapterType}. Nothing changed.`);
    const back = issue.assigneeAgentId !== agent.id;
    if (!apply) {
      out("");
      out(`--apply ${back ? `assigns ${identifier} back to ${name}, then ` : ""}comments, as you, asking ${name} to continue from where the pause cut it off`);
      out("and hand the issue on as usual. That comment is what lifts the hold and starts its run.");
      out(`  pch release ${identifier} --apply`);
      return;
    }
    if (!actsAsUser(await ctx.identity())) {
      throw new Error(`Paperclip lifts it only on a board user's comment, and this key doesn't comment as one: ${back ? `assign ${identifier} to ${name}, then ` : ""}comment on it yourself. Nothing changed.`);
    }
    const result = await continuePausedHold(ctx.api, facts, { text: continuationText(agent, `\n\n${COMMAND_SIGNATURE}`) });
    out(`${identifier}: ${result.reassigned ? `assigned back to ${name}, and ` : ""}asked ${name} to continue.`);
    out(result.lifted ? "The hold is gone; its run should start within seconds." : `Paperclip still showed the hold a moment later: if no run starts, run \`pch why ${identifier}\`.`);
    return;
  }
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
export async function worktrees(ctx, { apply = false, minDays = 1, includeUntracked = false, includeUnmerged = false, verbose = false, links = false, retry = false, given = new Set(), ...rest } = {}) {
  const { api } = ctx;
  if (retry && !links) throw new Error("--retry goes with --links: pch worktrees --links --retry");
  if (links) {
    const others = ["apply", "minDays", "includeUntracked", "includeUnmerged", "verbose"].filter((k) => given.has(k) || (k === "apply" && apply));
    if (others.length) throw new Error("--links takes only --retry: usage: pch worktrees --links [--retry]");
    return worktreeLinks(ctx, { retry, ...rest });
  }
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
  // The worktree's folder under its row, for the ones you may want to look at yourself.
  const where = (ws) => {
    const f = folderOf(ws);
    if (f) out(`               ${f}`);
  };
  const toClose = [];
  let reviewCount = 0;
  const hasGitHub = Boolean(ctx.config.githubToken || ctx.config.githubTokenFile);
  const github = hasGitHub ? createGitHub({ config: ctx.config, log: ctx.log }) : null;

  for (const companyId of me.companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => ({}));
    const name = company.issuePrefix ?? company.name ?? companyId;
    const { counts, results, failedBefore, leftAlone, openByStatus, githubErrors } = await survey(api, companyId, {
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
      for (const r of review) {
        out(row(r, r.reasons.join(", ")));
        where(r.ws);
      }
      out("  On Paperclip's host, git -C <folder> status --short lists the uncommitted files; git -C <folder> log --oneline <base>..HEAD the unmerged commits.");
    }
    if (skip.length) {
      out(`  Paperclip won't close ${skip.length}:`);
      for (const r of skip) {
        out(row(r, r.reasons.join("; ")));
        where(r.ws);
      }
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
    const byStatus = Object.entries(openByStatus ?? {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
    const notLooked = [
      counts.open && `${counts.open} of open issues${byStatus.length ? ` (${byStatus.join(", ")})` : ""}`,
      counts.recent && `${counts.recent} of issues finished in the last ${minDays === 1 ? "day" : `${minDays} days`}`,
      counts.shared && `${counts.shared} sessions on the project's shared checkout (nothing to free)`,
      counts.noIssue && `${counts.noIssue} with no source issue`,
    ].filter(Boolean);
    if (notLooked.length) out(`  Left alone: ${notLooked.join(", ")}.`);
    if (verbose && leftAlone?.length) {
      const why = (l) =>
        l.why === "recent" ? `finished ${age(l.days * 24 * 60 * 60_000)} ago`
          : l.why === "noIssue" ? "no source issue"
          : l.why === "missing" ? "its issue isn't listed (deleted, or not visible to you)"
          : `issue is ${l.issue?.status ?? "open"}`;
      for (const l of leftAlone) {
        const who = l.issue ? label(l.issue) : l.ws.sourceIssueId ? String(l.ws.sourceIssueId).slice(0, 8) : "-";
        out(`    ${who.padEnd(10)} ${why(l)}  ${l.ws.branchName ?? l.ws.name ?? l.ws.id.slice(0, 8)}`);
        where(l.ws);
      }
    } else if (leftAlone?.length) {
      out("  --verbose lists each of them, and why.");
    }
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

// ---------------------------------------------------------------- worktree links

// Issues whose every run Paperclip refuses at setup because it can't prove their
// worktree links back to the project checkout (source_registration_unproven; see
// worktree-links.mjs), grouped by checkout, with the commands that repair the links
// on Paperclip's host. The helper never touches the disk. --retry, once you have run
// them, comments on each issue still parked this way, as you: the retry Paperclip
// waits for. Then it reports each issue's next run.
export async function worktreeLinks(ctx, { retry = false, waitMs = 60_000, pollMs = 3_000 } = {}) {
  const { api } = ctx;
  const me = await ctx.identity();
  const label = (i) => i.identifier ?? String(i.id).slice(0, 8);
  const agents = new Map();
  const agentOf = async (id) => {
    if (!id) return null;
    if (!agents.has(id)) agents.set(id, await api.request("GET", `/api/agents/${id}`).catch(() => null));
    return agents.get(id);
  };
  const targets = [];
  for (const companyId of me.companyIds ?? []) {
    const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => ({}));
    const name = company.issuePrefix ?? company.name ?? companyId;
    const parked = await parkedOnValidation(api, companyId);
    const relative = parked.filter((p) => p.validation.reasonCode === RELATIVE_LINKS);
    const other = parked.filter((p) => p.validation.reasonCode !== RELATIVE_LINKS);
    if (!relative.length) {
      out(`${name}: no issue is parked on its worktree links.`);
    } else {
      out(`${name}: ${plural(relative.length, "issue")} fail${relative.length === 1 ? "s" : ""} every run at setup: Paperclip can't prove their worktrees link back to the project checkout (${RELATIVE_LINKS})`);
      for (const group of await byCheckout(api, relative)) {
        out("");
        out(`  ${group.paths.checkout ? `Project checkout ${group.paths.checkout}` : `Worktrees in ${group.key}`}: ${plural(group.items.length, "issue")}`);
        for (const item of group.items) {
          const who = (await agentOf(item.issue.assigneeAgentId))?.name ?? "nobody";
          out(`    ${label(item.issue).padEnd(10)} ${String(who).padEnd(14)} ${item.paths.worktree ?? `workspace ${String(item.validation.executionWorkspaceId ?? "?").slice(0, 8)}`}`);
        }
        const sample = group.items.find((i) => i.paths.worktree)?.paths ?? group.paths;
        out(`  Check: ${linkCheck(sample)}   (a gitdir: that doesn't start with / confirms relative links)`);
        out("  On the Paperclip host, as the user Paperclip runs as (this repository only; the user's global git setting stays):");
        for (const line of repairCommands(sample)) out(`    ${line}`);
        out("  Every worktree in the checkout is repaired, not only these: any other with relative links fails on its next run.");
        targets.push(...group.items);
      }
    }
    if (other.length) {
      out(`  Also parked on workspace validation, for other reasons (\`pch why ISSUE\` says what each needs): ${other.map((p) => `${label(p.issue)} (${codeLabel(p.validation)})`).join(", ")}`);
    }
  }
  if (!targets.length) return;
  if (!retry) {
    out("");
    out("Once the repair has run on the host:");
    out("  pch worktrees --links --retry");
    out("It comments, as you, on each issue still parked this way (the retry Paperclip waits for), then reports each issue's next run.");
    out("Before the repair, a retry only fails the same way.");
    return;
  }

  out("");
  const retried = [];
  for (const item of targets) {
    const id = item.issue.id;
    const [issue, recovery, runs, blockers] = await Promise.all([
      api.request("GET", `/api/issues/${id}`).catch(() => null),
      api.request("GET", `/api/issues/${id}/recovery-actions`).catch(() => null),
      api.request("GET", `/api/issues/${id}/runs`).catch(() => null),
      api.request("GET", `/api/issues/${id}/diagnostics/blockers`).catch(() => null),
    ]);
    if (!issue || !recovery || !runs || !blockers) {
      out(`${label(item.issue)}: left alone (couldn't read ${!issue ? "it" : !recovery ? "its recovery actions" : !runs ? "its runs" : "its blockers"}).`);
      continue;
    }
    const agent = await agentOf(issue.assigneeAgentId);
    const problem = await retryProblem(issue, recovery.active ?? null, runs, {
      agent,
      blockers,
      detailOf: (r) => api.request("GET", `/api/heartbeat-runs/${r.runId ?? r.id}`),
    });
    if (problem) {
      out(`${label(issue)}: left alone (${problem}).`);
      continue;
    }
    const who = agent?.name;
    const text = `${who ? `${who}, the` : "The"} worktree links are repaired: Paperclip can verify this issue's workspace again. Please continue this issue.`;
    try {
      await api.request("POST", `/api/issues/${id}/comments`, { body: signed(text, COMMAND_SIGNATURE) });
    } catch (err) {
      out(`${label(issue)}: not retried: ${pausedRefusal(err) ? "the task is paused; resume it first" : err.message}`);
      process.exitCode = 1;
      continue;
    }
    const list = Array.isArray(runs) ? runs : [];
    retried.push({ issue, known: new Set(list.map((r) => r.runId ?? r.id)) });
    out(`${label(issue)}: retried (a comment as you).`);
  }
  if (!retried.length) return;
  out("");
  out(`Their next runs (waiting up to ${Math.round(waitMs / 1000)}s):`);
  const outcomes = await awaitNextRuns(api, retried, { waitMs, pollMs });
  let again = 0;
  let other = 0;
  for (const { issue } of retried) {
    const o = outcomes.get(issue.id);
    if (o?.kind === "again") again += 1;
    if (o?.kind === "other") other += 1;
    out(`  ${label(issue).padEnd(10)} ${o?.text ?? "?"}${o?.kind === "waiting" || o?.kind === "other" ? `: \`pch why ${label(issue)}\`` : ""}`);
  }
  if (again) {
    out("");
    out(`${plural(again, "issue")} failed the same way. Either the links are still relative (run the repair above on the host; both counts must print 0),`);
    out("or the worktree isn't one the repair fixes: a separate clone (its .git is a folder), or one `git worktree list` doesn't show. `pch why ISSUE` has the check.");
  }
  if (again || other) process.exitCode = 1;
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

export async function costs(ctx, { sessions = false, audit = false, days = 7, compareDays = null, retrySkipped = false, given = new Set() } = {}) {
  const compare = given.has("compareDays");
  if ([sessions, audit || compare, retrySkipped].filter(Boolean).length > 1) {
    throw new Error("usage: pch costs [--sessions | --audit [--days N] | --compare-days N | --retry-skipped] (one at a time; --audit and --compare-days go together)");
  }
  if (given.has("days") && !audit) throw new Error("--days goes with --audit: pch costs --audit --days N");
  if (compare && !(compareDays > 0)) throw new Error("usage: pch costs --compare-days N   (N: the days in each period, e.g. 7 for week on week)");
  const sync = createCostSync(ctx);
  if (sessions) return sync.sessions();
  if (retrySkipped) {
    const { queued } = sync.queueRetries({ print: out });
    if (!queued) return;
    const s = readStatus(ctx.config);
    const minutes = Math.round(ctx.config.costSyncIntervalSec / 60);
    if (!ctx.config.costSync) out("COST_SYNC is off: they are posted once you turn it on and restart the service.");
    else if (ctx.config.dryRun) out("DRY_RUN is on: the service only logs what it would post, so they stay queued until you turn it off.");
    else if (serviceLive(s)) out(`The service posts them on its next cost-sync pass (every ${minutes} min); \`pch status\` shows the posts, and the log any rejection again.`);
    else out("The service isn't running: they are posted on its first pass once it starts.");
    return;
  }
  if (audit) {
    if (!(days > 0)) throw new Error("usage: pch costs --audit [--days N]");
    await sync.audit({ days, print: out });
    if (!compare) return;
    out("");
  }
  if (compare) return sync.compare({ days: compareDays, print: out });
  if (!ctx.config.costSync) out("(COST_SYNC is off: this is what it would post if you turned it on.)\n");
  return sync.preview();
}

// ---------------------------------------------------------------- status / health

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

// A count worth showing, in words: "3 nudges", or nothing for zero.
const counted = (n, one, many) => (n ? plural(n, one, many) : null);
const since = (iso) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "?");

// "190.7 s", "850 ms".
const seconds = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// How slow is slow, for the colours of `pch status`: null (fine), "yellow" or "red".
// A check is measured against the watchdog's interval: one that takes longer than
// the interval delays the next. A part of it, against a sixth and half of that. A
// kind of request, against fixed times: Paperclip answers most within 100 ms.
export function slowness(ms, { intervalSec = 60, what = "check" } = {}) {
  const interval = intervalSec * 1000;
  const [yellow, red] =
    what === "check" ? [interval / 2, interval] :
      what === "part" ? [interval / 6, interval / 2] :
        what === "request" ? [250, 1000] :
          [1000, 5000]; // the longest single request
  return ms >= red ? "red" : ms >= yellow ? "yellow" : null;
}

const tint = (paint, level, text) => (level ? paint[level](text) : text);

// What the watchdog's last check cost: its requests to Paperclip (and how many
// answers it reused from earlier in the same check), its slowest parts and kinds of
// request, and how many GitHub reads were answered "not modified". Slow figures are
// yellow or red (see slowness).
export function tickLines(w, { paint = colours({ enabled: false }), intervalSec = 60 } = {}) {
  const t = w?.lastTick;
  const lines = [];
  const time = (ms, what) => tint(paint, slowness(ms, { intervalSec, what }), seconds(ms));
  if (t) {
    lines.push(`Requests to Paperclip: ${t.requests}${t.shared ? `, and ${plural(t.shared, "answer")} reused within the check` : ""}.`);
    if (t.checks?.length) lines.push(`Slowest parts: ${t.checks.map((c) => `${c.name} ${time(c.ms, "part")} (${plural(c.requests, "request")})`).join(", ")}.`);
    if (t.slowest?.length) {
      lines.push(`Slowest requests: ${t.slowest.map((k) => `${k.kind}: ${k.count} × ${time(k.avgMs, "request")} avg, ${time(k.maxMs, "longest")} max`).join("; ")}.`);
    }
  }
  const g = w?.github;
  if (g?.reads) lines.push(`GitHub reads since start: ${g.reads}, ${g.notModified} answered "not modified" (not counted against the rate limit).`);
  return lines;
}

// The key's expiry as a level: "red" once expired, "yellow" within 30 days, else null.
function expiryLevel(key) {
  if (!key?.expiresAt) return null;
  const days = Math.floor((Date.parse(key.expiresAt) - Date.now()) / 86_400_000);
  return days < 0 ? "red" : days < 30 ? "yellow" : null;
}

// `pch status`: one section per component, a blank line between them and around
// the whole. On a terminal, what is on is green, what is off yellow, errors and a
// stopped service red, warnings and slow timings yellow (or red when very slow).
export async function status(ctx) {
  const paint = colours();
  const { red, green, yellow, bold } = paint;
  const label = (name) => bold(name);
  const onOff = (on) => (on ? green("on") : yellow("off"));
  const lastError = (text) => out(`  ${red(`Last error: ${text}`)}`);
  const intervalSec = ctx.config.watchdogIntervalSec ?? 60;
  const s = readStatus(ctx.config);
  const stale = !serviceLive(s);
  out("");
  if (!s) {
    out(red("The helper service has not written a status yet: is it running? (docker compose ps, docker compose logs)"));
  } else {
    out(
      s.stoppedAt
        ? `${label(`Paperclip Helper ${s.version}`)}: ${red("NOT RUNNING")}. It stopped at ${since(s.stoppedAt)} (started ${since(s.startedAt)}).`
        : stale
          ? `${label(`Paperclip Helper ${s.version}`)}: ${red("NOT RUNNING")}. Its last heartbeat was ${ago(s.heartbeatAt)} (started ${since(s.startedAt)}).`
          : `${label(`Paperclip Helper ${s.version}`)}: ${green("running")} since ${since(s.startedAt)}.`,
    );
    if (s.dryRun) out(yellow("DRY RUN: components log what they would do and change nothing."));

    const r = s.relay;
    out("");
    out(
      r?.on
        ? `${label("Relay")}: ${onOff(true)}. ${plural(r.handled, "delivery", "deliveries")} handled, ${r.failed ? red(`${r.failed} failed`) : "0 failed"}, the last ${ago(r.lastEventAt)}.`
        : `${label("Relay")}: ${onOff(false)}.`,
    );
    if (r?.lastError) lastError(r.lastError);
    const k = r?.on ? r.conflicts : null;
    if (k) out(`  Merge conflicts: ${plural(k.sentBack, "PR")} sent back, last look ${ago(k.lastSweepAt)}.${k.lastError ? ` ${red(`Last error: ${k.lastError}`)}` : ""}`);
    const q = r?.on ? r.mergeQueue : null;
    if (q) {
      const parts = [plural(q.dropped, "drop") + " handled", `${q.sentBack} sent back`, `${q.noted} told to you`, counted(q.requeued, "queued again", "queued again")];
      out(`  Merge queue: ${parts.filter(Boolean).join(", ")}.${q.lastError ? ` ${red(`Last error: ${q.lastError}`)}` : ""}`);
    }

    const w = s.watchdog;
    out("");
    if (w?.on) {
      // A last check long ago means the watchdog is behind (a check still running, or stuck).
      const age = w.lastTickAt ? Date.now() - Date.parse(w.lastTickAt) : null;
      const expected = Math.max(intervalSec * 1000, w.lastTickMs ?? 0);
      const late = age == null ? null : age > 10 * expected ? "red" : age > 3 * expected ? "yellow" : null;
      const took = w.lastTickMs != null ? ` (${tint(paint, slowness(w.lastTickMs, { intervalSec, what: "check" }) ?? "green", seconds(w.lastTickMs))})` : "";
      out(`${label("Watchdog")}: ${onOff(true)}. Last check ${tint(paint, late, ago(w.lastTickAt))}${took}.`);
      for (const line of tickLines(w, { paint, intervalSec })) out(`  ${line}`);
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
        counted(w.pausedHolds, "hold from a paused run lifted", "holds from a paused run lifted"),
        counted(w.runnerProblems, "broken runner reported", "broken runners reported"),
        counted(w.readyNotes, "PR ready to queue reported", "PRs ready to queue reported"),
        counted(w.worktreeLinkNotes, "checkout with relative worktree links reported", "checkouts with relative worktree links reported"),
      ].filter(Boolean);
      out(`  Since start: ${done.length ? done.join(", ") : "nothing needed doing"}.`);
      if (w.stuck) out(`  ${yellow(`${plural(w.stuck, "issue")} stuck behind a deferred wake: see the log.`)}`);
      if (w.lastError) lastError(w.lastError);
    } else {
      out(`${label("Watchdog")}: ${onOff(false)}.`);
    }

    const c = s.costSync;
    out("");
    out(
      c?.on
        ? `${label("Cost sync")}: ${onOff(true)}. Last run ${ago(c.lastTickAt)}; ${plural(c.posted ?? 0, "run")} ($${((c.postedCents ?? 0) / 100).toFixed(2)}) posted since start.`
        : `${label("Cost sync")}: ${onOff(false)}.`,
    );
    if (c?.lastError) lastError(c.lastError);
    const unpriced = Object.entries(c?.unpriced ?? {});
    if (unpriced.length) out(`  ${yellow(`Not priced: ${unpriced.map(([m, n]) => `${m} (${plural(n, "run")})`).join(", ")}`)}; see COST_PRICES_FILE and CODEX_DEFAULT_MODEL.`);
  }
  showMetrics(readMetrics(ctx.config), paint);
  // Live checks, from this container.
  out("");
  try {
    const me = await ctx.identity();
    const key = await currentKey(ctx);
    const build = await paperclipBuild(ctx);
    const note = key ? `; ${tint(paint, expiryLevel(key), expiryNote(key))}` : "";
    out(`${label("Paperclip")}: ${ctx.config.paperclipApi}${build ? ` (${build})` : ""} as ${me.user?.name ?? me.userId}${note}`);
  } catch (err) {
    out(`${label("Paperclip")}: ${red(err.message)}`);
    process.exitCode = 1;
  }
  out("");
  if (stale) process.exitCode = 1;
}

// The lifetime counts and latest problems from data/metrics.json (metrics.mjs).
function showMetrics(m, paint = colours({ enabled: false })) {
  if (!m?.totals) return;
  const t = m.totals;
  const n = (v) => Number(v ?? 0).toLocaleString("en-GB");
  const versions = m.firstVersion && m.firstVersion !== m.version ? `, ${m.firstVersion} → ${m.version}` : "";
  out("");
  out(`${paint.bold("All time")} (since ${since(m.firstStartedAt)}, ${plural(m.starts ?? 1, "start")}${versions}):`);
  const credited = COUNTERS.filter((c) => c.minutes && t[c.key] > 0);
  const actions = credited.reduce((sum, c) => sum + t[c.key], 0);
  const minutes = minutesSaved(t);
  const time = minutes >= 90 ? `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} h` : `${minutes} min`;
  out(
    actions
      ? `  Kept things moving: ${n(actions)} ${actions === 1 ? "action" : "actions"}, about ${time} of hand work saved (a rough guess per action).`
      : "  Kept things moving: nothing needed doing yet.",
  );
  for (const c of credited) {
    const extra = c.key === "nudges" && t.ciReports ? ` (${n(t.ciReports)} of them finished CI runs reported)` : "";
    out(`    ${n(t[c.key]).padStart(6)}  ${c.label}${extra}`);
  }
  out(`  Relay: ${n(t.githubEvents)} GitHub ${t.githubEvents === 1 ? "event" : "events"} handled${t.relayFailures ? `, ${paint.red(`${n(t.relayFailures)} failed`)}` : ""}.`);
  out(`  Watchdog: ${n(t.watchdogChecks)} ${t.watchdogChecks === 1 ? "check" : "checks"} run${t.stuck ? `; ${n(t.stuck)} wakes found stuck behind a stopped run` : ""}.`);
  out(`  Cost sync: ${n(t.costPosts)} run ${t.costPosts === 1 ? "cost" : "costs"} posted ($${(Number(t.costCents ?? 0) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}).`);
  const recent = Array.isArray(m.recent) ? m.recent : [];
  const warnings = plural(m.warnings ?? 0, "warning");
  const errors = plural(m.errors ?? 0, "error");
  out(`  Problems: ${m.warnings ? paint.yellow(warnings) : warnings}, ${m.errors ? paint.red(errors) : errors}${recent.length ? `. The latest ${recent.length}, newest last:` : "."}`);
  for (const p of recent) {
    const line = `${p.level === "error" ? "ERROR" : "warn "}  ${p.msg}${p.detail ? ` (${p.detail})` : ""}`;
    out(`    ${since(p.at).replace(" UTC", "")}  ${p.level === "error" ? paint.red(line) : paint.yellow(line)}`);
  }
}

// Docker HEALTHCHECK: the service's heartbeat is fresh and the relay answers.
export async function health(ctx) {
  const s = readStatus(ctx.config);
  if (!serviceLive(s)) throw new Error(s?.stoppedAt ? "the service has stopped" : "no recent heartbeat from the service");
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
