// `pch why ISSUE`: Paperclip's own diagnostics for one issue, in plain lines, then
// a recommendation (advice.mjs): what is going on, what to do, and whether the
// watchdog does it by itself. With --prompt, the same as a prompt for an LLM chat.

import { readJson } from "./store.mjs";
import { advise, excerpt, llmPrompt } from "./advice.mjs";
import { pendingCards } from "./questions.mjs";
import { deadLinkWorkspaceId, describeLink, linkFacts } from "./workspace.mjs";
import { classifyFailure, labelOf, localZone, resetLabel } from "./limits.mjs";
import { issueActivity, stagesWipe } from "./stages.mjs";
import { isBackstop, monitorPending, runRefs, waitingOn } from "./ci-runs.mjs";
import { selfWakeLoop } from "./self-wakes.mjs";
import { PAUSE_CANCEL, RECONCILIATION_CAUSE } from "./release.mjs";
import { describeWakes } from "./paused-holds.mjs";
import { codeLabel, EXTENSION_ERROR, hostPaths, meaningOf, readWorkspace, RECOVERY_KIND, VALIDATION_FAILED, validationOf } from "./worktree-links.mjs";
import { ts } from "./util.mjs";

// A blocker counts as "finalizing" until the latest operation on its execution
// workspace is a successful workspace_finalize. Show the last few operations.
async function showWorkspaceOps(api, identifier, out) {
  const issue = await api.request("GET", `/api/issues/${encodeURIComponent(identifier)}`).catch(() => null);
  const wsId = issue?.executionWorkspaceId;
  if (!wsId) {
    out("    (no execution workspace on the issue)");
    return;
  }
  const ops = await api.request("GET", `/api/execution-workspaces/${wsId}/workspace-operations`).catch((e) => {
    out(`    workspace operations unavailable: ${e.message}`);
    return [];
  });
  const sorted = (Array.isArray(ops) ? ops : []).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  out(`    workspace ${wsId}: last ${Math.min(6, sorted.length)} of ${sorted.length} operations`);
  for (const op of sorted.slice(-6)) {
    const who = op.issueId === issue.id ? identifier : op.issueId ? `issue ${op.issueId.slice(0, 8)}` : "unattributed";
    out(
      `    ${op.startedAt}  ${String(op.phase).padEnd(20)} ${String(op.status).padEnd(10)} ${who}` +
        `${op.heartbeatRunId ? `  run ${op.heartbeatRunId.slice(0, 8)}` : ""}${op.finishedAt ? "" : "  (not finished)"}`,
    );
    if (op.status === "failed") {
      const excerpt = [op.stderrExcerpt, op.stdoutExcerpt].filter(Boolean).join("\n").trim();
      const note =
        op.metadata && typeof op.metadata === "object"
          ? ["errorMessage", "error", "reason", "failureReason", "message"].map((k) => op.metadata[k]).find((v) => typeof v === "string")
          : null;
      if (op.exitCode != null) out(`      exit code ${op.exitCode}`);
      if (note) out(`      ${note}`);
      for (const line of excerpt.split("\n").slice(-12)) if (line.trim()) out(`      | ${line}`);
    }
  }
}

// Paperclip's wake and blocker diagnostics for one issue, in plain lines.
// Then a recommendation: what is going on, what to do, and whether the watchdog
// does it by itself. With --prompt, the same as a prompt for an LLM chat.
export async function why(ctx, identifier, { prompt = false, print = console.log } = {}) {
  if (!identifier) throw new Error("usage: pch why ISSUE [--prompt]");
  const report = [];
  const facts = await whyReport(ctx, identifier, (line = "") => report.push(line));
  const advice = advise(facts);
  if (prompt) {
    print(llmPrompt({ identifier, report: report.join("\n"), advice, lastComments: facts.lastComments }));
    return;
  }
  for (const line of report) print(line);
  if (facts.lastComment) print(`Last comment: ${facts.lastComment.author ?? "someone"}: ${excerpt(facts.lastComment.body)}`);
  print("");
  print(`Recommendation: ${advice.what}`);
  advice.steps.forEach((step, i) => print(`  ${i + 1}. ${step}`));
  if (advice.watchdog === "auto" && advice.autoNote) {
    print(`  ${advice.autoNote}`);
  } else if (advice.watchdog === "auto") {
    print(`  The watchdog does this by itself once the issue has been quiet for ${ctx.config.watchdogStallSec}s. Do it by hand only if you don't want to wait.`);
  } else if (advice.watchdog === "manual") {
    print("  The watchdog leaves this one to you.");
  }
  print(`  Not what you see? \`pch why ${identifier} --prompt\` prints all of this as a prompt for an LLM chat.`);
}

async function whyReport(ctx, identifier, out) {
  const { api } = ctx;
  const id = encodeURIComponent(identifier);
  const [wakes, blockers] = await Promise.all([
    api.request("GET", `/api/issues/${id}/diagnostics/wakes`),
    api.request("GET", `/api/issues/${id}/diagnostics/blockers`).catch(() => null),
  ]);
  const issue = wakes?.issue ?? {};
  out(`${identifier}: ${issue.status ?? "?"} ${issue.title ? `— ${issue.title}` : ""}`);
  if (wakes?.diagnosis) out(`Diagnosis: ${wakes.diagnosis}`);
  if (wakes?.likelyReason && wakes.likelyReason !== wakes.diagnosis) out(`Likely reason: ${wakes.likelyReason}`);
  if (blockers?.diagnosis && blockers.diagnosis !== wakes?.diagnosis) out(`Blocker diagnosis: ${blockers.diagnosis}`);
  const r = blockers?.readiness;
  if (r) {
    const linked = (blockers?.blockers ?? []).length;
    out(
      `Blockers: ${!linked ? "none linked" : r.allBlockersDone ? "all done" : `${r.unresolvedBlockerCount} unresolved`}` +
        `${r.pendingFinalizeBlockerCount ? `, ${r.pendingFinalizeBlockerCount} waiting on workspace finalization` : ""}` +
        `; dependency ready: ${r.isDependencyReady ? "yes" : "no"}`,
    );
  }
  for (const b of blockers?.blockers ?? []) {
    out(`  ${b.identifier ?? b.id}: ${b.status}${b.isPendingFinalize ? " (finalizing)" : ""}`);
    if (b.isPendingFinalize) await showWorkspaceOps(api, b.identifier ?? b.id, out);
  }
  const names = new Map();
  const nameOf = async (agentId) => {
    if (!agentId) return null;
    if (!names.has(agentId)) {
      const agent = await api.request("GET", `/api/agents/${agentId}`).catch(() => null);
      names.set(agentId, agent?.name ?? agentId.slice(0, 8));
    }
    return names.get(agentId);
  };
  // Wakes are listed for every agent, so say whose each one is: a wake deferred
  // for the previous owner says nothing about the assignee.
  const full = await api.request("GET", `/api/issues/${id}`).catch(() => null);
  const assignee = await nameOf(full?.assigneeAgentId);
  if (assignee) out(`Assignee: ${assignee}`);
  // A link to a closed workspace fails every run at setup; one to another
  // issue's live workspace puts this issue's commits on that issue's branch.
  const link = full ? await linkFacts(api, identifier, { issue: full }).catch(() => null) : null;
  const linkLine = link ? describeLink(link) : null;
  if (linkLine) out(`Workspace: ${linkLine}`);
  const hold = full?.executionBlocker;
  let pauseHold = null;
  if (hold) {
    // Paperclip's recovery is holding the issue: new runs are refused until it's released.
    out(`Execution hold: ${hold.cause ?? "unknown cause"}${hold.runId ? `, source run ${String(hold.runId).slice(0, 8)}` : ""}`);
    if (hold.nextAction) out(`  Next action: ${hold.nextAction}`);
    // A run a pause cancelled (watchdog 18): every agent's wakes wait behind it.
    if (hold.cause === RECONCILIATION_CAUSE && hold.runId) {
      const source = await api.request("GET", `/api/heartbeat-runs/${hold.runId}`).catch(() => null);
      if (source?.status === "cancelled" && source.errorCode === PAUSE_CANCEL) {
        const ownerName = await nameOf(hold.agentId ?? source.agentId);
        const owner = await api.request("GET", `/api/agents/${hold.agentId ?? source.agentId}`).catch(() => null);
        const waiting = (wakes?.events ?? []).filter((e) => e.kind === "wake_request" && ["queued", "claimed", "deferred_issue_execution"].includes(e.status));
        for (const e of waiting) await nameOf(e.agentId);
        const held = describeWakes(waiting, (id) => names.get(id) ?? null);
        pauseHold = {
          ownerName, ownerStatus: owner?.status ?? null, ownerAdapter: owner?.adapterType ?? null, runId: hold.runId, waiting: waiting.length, held,
          assigneeName: full?.assigneeAgentId ? await nameOf(full.assigneeAgentId) : null,
        };
        out(
          `Queued wakes held by an unreconciled run from a pause: ${ownerName ?? "an agent"}'s run ${String(hold.runId).slice(0, 8)} was cancelled when ${ownerName ?? "it"} was paused; ` +
            `${held ? `${held} won't start` : "no run starts on the issue"} until it's resolved.`,
        );
      }
    }
  }
  const recent = (wakes?.events ?? []).filter((e) => e.kind === "wake_request").slice(0, 5).reverse();
  if (recent.length) {
    out("Latest wake requests:");
    for (const e of recent) {
      const who = await nameOf(e.agentId);
      out(`  ${e.requestedAt}  ${who ? `${who}  ` : ""}${e.reason ?? e.source}  → ${e.status}${e.failureClass ? ` (${e.failureClass})` : ""}`);
    }
  }
  // Runs, with their environment lease: a cancelled run whose lease was never
  // released keeps every later wake deferred.
  const runs = await api.request("GET", `/api/issues/${id}/runs`).catch(() => []);
  const latestRuns = (Array.isArray(runs) ? runs : []).slice(0, 4).reverse();
  if (latestRuns.length) {
    for (const r of latestRuns) await nameOf(r.agentId);
    out("Latest runs:");
    for (const r of latestRuns) {
      const l = r.environmentLease;
      const lease = l
        ? `  lease ${l.status}${l.releasedAt ? "" : " (not released)"}${l.cleanupStatus && l.cleanupStatus !== "succeeded" ? `, cleanup ${l.cleanupStatus}` : ""}`
        : "";
      out(`  ${r.createdAt}  ${names.get(r.agentId) ?? "?"}  ${r.status}${r.errorCode ? ` (${r.errorCode})` : ""}${lease}`);
    }
  }

  // What Paperclip's recovery decided, the saved messages, and the latest notes:
  // the rest of what a recommendation needs.
  const [parked, queue, comments, me] = await Promise.all([
    api.request("GET", `/api/issues/${id}/recovery-actions`).catch(() => null),
    api.request("GET", `/api/issues/${id}/queued-comments`).catch(() => null),
    api.request("GET", `/api/issues/${id}/comments?order=desc&limit=3`).catch(() => []),
    ctx.identity().catch(() => null),
  ]);
  const recovery = parked?.active ?? null;
  // Pending question cards, and where the watchdog routed any of them.
  const cards = full?.id ? await pendingCards(api, full.id).catch(() => []) : [];
  const routedRecords = cards.length ? readJson(ctx.config.stateFile, {})?.nudges ?? {} : {};
  const routed = {};
  for (const c of cards) {
    if (routedRecords[`question:${c.id}`]?.relay) routed[c.id] = routedRecords[`question:${c.id}`].relay;
    const [from, to] = [await nameOf(c.createdByAgentId), c.addresseeAgentId ? await nameOf(c.addresseeAgentId) : null];
    const toWhom = to ?? (c.addresseeUserId ? (c.addresseeUserId === me?.userId ? "you" : "a board user") : "anyone");
    out(`Question card: ${from ?? "?"} → ${toWhom}, ${c.kind}, asked ${c.createdAt}${routed[c.id] ? `, routed to ${routed[c.id]}` : ""}`);
  }
  if (recovery) {
    out(`Recovery: ${recovery.kind ?? recovery.cause ?? "unknown"}, waiting on ${recovery.ownerType ?? "?"} since ${recovery.createdAt ?? "?"}`);
    if (recovery.nextAction) out(`  Next action: ${recovery.nextAction}`);
  }
  if (queue?.queueId && queue.entries?.length) {
    out(`Saved messages: ${queue.entries.length} ${queue.state ?? "waiting"}${queue.executionWait?.message ? ` ("${queue.executionWait.message}")` : ""}`);
  }
  const lastComments = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const author = (await nameOf(c.authorAgentId)) ?? (c.authorUserId ? (c.authorUserId === me?.userId ? "you" : "a board user") : null);
    lastComments.push({ author, body: c.body ?? "", createdAt: c.createdAt ?? null });
  }
  const assigneeAgent = full?.assigneeAgentId ? await api.request("GET", `/api/agents/${full.assigneeAgentId}`).catch(() => null) : null;
  // The run list withholds error text; the run itself has it: a setup failure can
  // be the dead workspace link, another failure a usage limit or busy model.
  const runList = Array.isArray(runs) ? runs : [];
  const lastOwnRun = runList.find((r) => r.agentId === full?.assigneeAgentId && r.status !== "cancelled");
  let deadLinkRun = null;
  let lastFailure = null;
  let detail = null;
  if (lastOwnRun?.status === "failed") {
    const runId = lastOwnRun.runId ?? lastOwnRun.id;
    detail = await api.request("GET", `/api/heartbeat-runs/${runId}`).catch(() => null);
    if (lastOwnRun.errorCode === "setup_failed") {
      const wsId = deadLinkWorkspaceId(detail?.error);
      if (wsId) deadLinkRun = { runId, workspaceId: wsId };
    }
    const timeZone = ctx.config.watchdogLimitTimeZone || localZone();
    const verdict = detail && assigneeAgent ? classifyFailure({ ...lastOwnRun, ...detail, status: "failed" }, assigneeAgent, { timeZone }) : null;
    if (verdict) {
      lastFailure = {
        kind: verdict.kind,
        label: labelOf(assigneeAgent.adapterType),
        what: verdict.what ?? null,
        resetAt: verdict.reset ? resetLabel(verdict.reset.at, verdict.reset.timeZone) : null,
      };
      if (verdict.kind === "limit") out(`Usage limit: ${lastFailure.label} ${verdict.what}${lastFailure.resetAt ? `, resets ${lastFailure.resetAt}` : ""}`);
    }
  }
  // A run Paperclip refused at setup because it couldn't verify the workspace: the
  // reason it recorded, from the run itself or from the recovery action that parked
  // the issue. The wake diagnostics withhold it ("raw error text is withheld").
  // A failed run's reason is only advice while nothing has tried since: no wake for the
  // assignee after it (a retry, say), and the issue still on the same workspace. An
  // active recovery action of that kind is current by itself.
  let workspaceValidation = null;
  const fromRecovery = recovery?.kind === RECOVERY_KIND ? validationOf(recovery) : null;
  const fromRun = lastOwnRun?.status === "failed" && lastOwnRun.errorCode === VALIDATION_FAILED ? validationOf(detail) : null;
  const failedAt = ts(lastOwnRun?.finishedAt ?? lastOwnRun?.createdAt);
  const triedSince = (wakes?.events ?? []).some(
    (e) => e.kind === "wake_request" && (e.agentId == null || e.agentId === full?.assigneeAgentId) && ts(e.requestedAt) > failedAt,
  );
  const movedOn = fromRun?.executionWorkspaceId && full?.executionWorkspaceId && full.executionWorkspaceId !== fromRun.executionWorkspaceId;
  const v = fromRecovery ?? fromRun;
  const current = Boolean(fromRecovery) || (Boolean(fromRun) && !triedSince && !movedOn);
  if (v) {
    const ws = await readWorkspace(api, v.executionWorkspaceId ?? full?.executionWorkspaceId, full);
    const paths = hostPaths(ws, v);
    if (current) workspaceValidation = {
      ...v,
      paths,
      repoUrl: ws?.repoUrl ?? null,
      nextAction: recovery?.kind === RECOVERY_KIND ? recovery.nextAction ?? null : null,
    };
    out(
      `${current ? "Workspace validation" : "Last run's workspace validation"}: ${codeLabel(v)}${v.executionWorkspaceId ? ` (workspace ${v.executionWorkspaceId.slice(0, 8)})` : ""}` +
        `${current ? "" : movedOn ? "; the issue is on another workspace since" : "; something has woken the issue since"}`,
    );
    const meaning = meaningOf(v);
    if (meaning) out(`  Meaning: ${meaning}`);
    if (paths.worktree) out(`  Worktree: ${paths.worktree}${paths.checkout ? ` (project checkout ${paths.checkout})` : ""}`);
  }
  // Builds failing on the repository extension git leaves behind after relative worktree
  // links (worktree-links.mjs): an agent says so in a comment, or its run's error has it.
  // Paperclip's own run errors don't, so nothing else points at it.
  let extensionError = null;
  const agentSaid = (Array.isArray(comments) ? comments : []).find((c) => c.authorAgentId && EXTENSION_ERROR.test(c.body ?? ""));
  const runSaid = EXTENSION_ERROR.test(String(detail?.error ?? "")) ? lastOwnRun : null;
  if (agentSaid || runSaid) {
    const ws = await readWorkspace(api, full?.executionWorkspaceId, full);
    extensionError = { paths: hostPaths(ws), in: agentSaid ? `${(await nameOf(agentSaid.authorAgentId)) ?? "an agent"}'s comment` : "the last run's error" };
    out(`Build error: Unsupported repository extension 'relativeworktrees' (in ${extensionError.in})`);
  }
  // A usage-limit pause by the watchdog (watchdog 16), from its state file.
  const records = readJson(ctx.config.stateFile, {})?.nudges ?? {};
  let limitPause = null;
  for (const [key, r] of Object.entries(records)) {
    if (!key.startsWith("limit:") || r?.resumedAt || !r?.paused?.[full?.assigneeAgentId]) continue;
    const graceMs = (ctx.config.watchdogLimitResumeGraceMin ?? 5) * 60_000;
    limitPause = {
      label: labelOf(r.adapter ?? "claude_local"),
      what: r.what ?? "usage limit",
      resetAt: r.unknownReset ? null : resetLabel(r.resetAt, r.timeZone),
      resumeAt: resetLabel(r.resetAt + graceMs, r.timeZone),
    };
    out(`Paused by the watchdog at a usage limit; resumed at ${limitPause.resumeAt}`);
  }
  // The agent a pending review stage waits on, when it isn't the assignee's own status that matters.
  const p = full?.executionState?.status === "pending" ? full.executionState.currentParticipant : null;
  let participant = null;
  if (p?.type === "agent" && p.agentId) {
    const agent = await api.request("GET", `/api/agents/${p.agentId}`).catch(() => null);
    participant = { name: agent?.name ?? (await nameOf(p.agentId)), status: agent?.status ?? null };
    out(`Review stage waits on: ${participant.name}${participant.status ? ` (${participant.status})` : ""}`);
  }
  // The activity log: who removed the stages (watchdog 17), and whether an agent
  // keeps waking itself with its runs' posted final messages (watchdog 21).
  const activity = full?.id ? await issueActivity(api, full.id) : null;
  // In review with no stage pending: did an agent's update remove the stages (watchdog 17)?
  let stagesWipedBy = null;
  if (full?.status === "in_review" && full.executionState?.status !== "pending" && full.id) {
    const wipe = stagesWipe(activity);
    if (wipe) stagesWipedBy = (await nameOf(wipe.agentId ?? wipe.actorId)) ?? "an agent";
  }
  const loop = selfWakeLoop(activity, runList, { now: ctx.now() });
  const selfWake = loop ? { name: (await nameOf(loop.agentId)) ?? "an agent", count: loop.count } : null;
  if (selfWake) out(`Self-wakes: ${selfWake.name}, ${selfWake.count} in the last hour (each run's final message, posted as its comment, started its next run)`);
  // The CI run the assignee's latest comments say it waits on (watchdog 11).
  const said = waitingOn(Array.isArray(comments) ? comments : [], full?.assigneeAgentId, full?.executionState?.monitor);
  const ref = runRefs(said.text)[0];
  const ciRun = ref ? (ref.repo ? `${ref.repo}#${ref.id}` : ref.id) : null;
  // The watchdog's backstop monitor for that wait (watchdog 11), if it stands.
  const monitor = full?.executionState?.monitor;
  const ciBackstop = monitorPending(monitor, ctx.now()) && isBackstop(monitor) ? { nextCheckAt: monitor.nextCheckAt } : null;
  if (ciBackstop) out(`CI backstop: the Helper's monitor, next check ${ciBackstop.nextCheckAt}`);
  return {
    identifier,
    issue: full ?? { status: issue.status },
    me: me?.userId ?? null,
    assignee: assigneeAgent ? { name: assigneeAgent.name, status: assigneeAgent.status } : assignee ? { name: assignee, status: null } : null,
    nameOf: (agentId) => names.get(agentId) ?? null,
    blockers,
    wakes: (wakes?.events ?? []).filter((e) => e.kind === "wake_request"),
    runs: runList,
    link,
    deadLinkRun,
    workspaceValidation,
    extensionError,
    lastFailure,
    limitPause,
    participant,
    stagesWipedBy,
    ciRun,
    ciBackstop,
    selfWake,
    pauseHold,
    recovery,
    queue,
    cards,
    routed,
    lastComment: lastComments[0] ?? null,
    lastComments,
    config: ctx.config,
    now: ctx.now(),
  };
}
