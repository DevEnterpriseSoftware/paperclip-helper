// One-off commands: `pch <command>` (docker compose run --rm helper <command>).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./store.mjs";
import { companyAgents, companyPrefixes } from "./paperclip.mjs";
import { approvalWaitingOn, DECISION_STATUS } from "./util.mjs";
import { createCostSync } from "./cost-sync.mjs";

export const USAGE = `Paperclip Helper

  pch                          run every enabled component (what the container does)
  pch status                   what the running helper is doing, and when the key expires
  pch check [ISSUE]            who the key belongs to; with an issue, what a merge would do to it
  pch why ISSUE                Paperclip's own diagnosis of why nobody is working on an issue
  pch approve ISSUE [comment]  approve an issue whose approval is waiting on you
  pch changes ISSUE comment    request changes (the comment becomes the brief)
  pch comment ISSUE text       comment as you (wakes the assignee)
  pch costs                    preview what cost sync would post (changes nothing)
  pch costs --sessions         check whether resumed sessions report cumulative costs
  pch models                   every agent's adapter, model and effort
  pch set-model FROM TO [--apply]   move every agent on model FROM to TO (preview without --apply)
  pch login                    create the helper's board API key (approve it in the browser)
  pch revoke                   revoke the key and delete it
  pch secret                   print a random webhook secret for GITHUB_WEBHOOK_SECRET
  pch update                   update the helper to the latest release of its major version
  pch version                  print the version

Settings come from .env; see https://github.com/DevEnterpriseSoftware/paperclip-helper`;

const out = (line = "") => console.log(line);

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
  const warn = days < 30 ? `: renew it soon with \`pch login\`` : "";
  return `key "${key.name}", expires ${key.expiresAt.slice(0, 10)} (in ${days} days${warn})`;
}

// ---------------------------------------------------------------- check / why

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

// A blocker counts as "finalizing" until the latest operation on its execution
// workspace is a successful workspace_finalize. Show the last few operations.
async function showWorkspaceOps(api, identifier) {
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
export async function why(ctx, identifier) {
  if (!identifier) throw new Error("usage: why <ISSUE-ID>");
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
    if (b.isPendingFinalize) await showWorkspaceOps(api, b.identifier ?? b.id);
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
  const hold = full?.executionBlocker;
  if (hold) {
    // Paperclip's recovery is holding the issue: new runs are refused until it's released.
    out(`Execution hold: ${hold.cause ?? "unknown cause"}${hold.runId ? `, source run ${String(hold.runId).slice(0, 8)}` : ""}`);
    if (hold.nextAction) out(`  Next action: ${hold.nextAction}`);
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
}

// ---------------------------------------------------------------- decisions

// approve / changes: the same decision the relay records on a merge or review.
export async function decide(ctx, kind, identifier, text) {
  if (!identifier) throw new Error(`usage: ${kind} <ISSUE-ID> ${kind === "approve" ? "[comment]" : "<comment>"}`);
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
  await ctx.api.request("PATCH", `/api/issues/${encodeURIComponent(identifier)}`, { status: DECISION_STATUS[kind], comment });
  out(`${identifier}: ${kind === "approve" ? "approved (done)" : "changes requested (back to the engineer)"}.`);
}

export async function comment(ctx, identifier, text) {
  if (!identifier || !text) throw new Error("usage: comment <ISSUE-ID> <text>");
  await ctx.api.request("POST", `/api/issues/${encodeURIComponent(identifier)}/comments`, { body: text });
  out(`${identifier}: comment added.`);
}

// ---------------------------------------------------------------- agent models

async function listAgents(ctx) {
  const { companyIds = [] } = await ctx.identity();
  const agents = [];
  for (const companyId of companyIds) agents.push(...(await companyAgents(ctx.api, companyId)));
  return agents;
}

export function effortOf(cfg) {
  return cfg?.effort ?? cfg?.modelReasoningEffort ?? cfg?.reasoningEffort ?? "";
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
export async function setModel(ctx, from, to, flags = []) {
  if (!from || !to) throw new Error("usage: set-model <from-model> <to-model> [--apply]");
  const apply = flags.includes("--apply");
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

// ---------------------------------------------------------------- costs

export async function costs(ctx, flags = []) {
  const sync = createCostSync(ctx);
  if (flags.includes("--sessions")) return sync.sessions();
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

export async function status(ctx) {
  const s = readStatus(ctx.config);
  const stale = !s || Date.now() - Date.parse(s.heartbeatAt ?? 0) > 120_000;
  if (!s) {
    out("The helper service has not written a status yet: is it running? (docker compose ps, docker compose logs)");
  } else {
    out(`Paperclip Helper ${s.version}, running since ${s.startedAt}${stale ? `  (NOT RUNNING: last heartbeat ${ago(s.heartbeatAt)})` : ""}`);
    if (s.dryRun) out("DRY RUN: components log what they would do and change nothing.");
    const r = s.relay;
    out(r?.on ? `Relay: on, ${r.handled} deliveries handled, ${r.failed} failed, last ${ago(r.lastEventAt)}${r.lastError ? `; last error: ${r.lastError}` : ""}` : "Relay: off");
    const w = s.watchdog;
    out(
      w?.on
        ? `Watchdog: on, last check ${ago(w.lastTickAt)} (${w.lastTickMs ?? "?"} ms), ${w.nudges} nudges and ${w.heals} repairs since start` +
            `${w.stuck ? `; ${w.stuck} issues stuck behind a deferred wake (see the log)` : ""}` +
            `${w.retries ? `; ${w.retries} deferred wakes retried` : ""}${w.lastError ? `; last error: ${w.lastError}` : ""}`
        : "Watchdog: off",
    );
    const c = s.costSync;
    out(
      c?.on
        ? `Cost sync: on, last run ${ago(c.lastTickAt)}, ${c.posted} runs ($${((c.postedCents ?? 0) / 100).toFixed(2)}) posted since start${c.lastError ? `; last error: ${c.lastError}` : ""}`
        : "Cost sync: off",
    );
    const unpriced = Object.entries(c?.unpriced ?? {});
    if (unpriced.length) out(`  Not priced: ${unpriced.map(([m, n]) => `${m} (${n} runs)`).join(", ")}; see COST_PRICES_FILE / CODEX_DEFAULT_MODEL.`);
  }
  // Live checks, from this container.
  try {
    const me = await ctx.identity();
    const key = await currentKey(ctx);
    out(`Paperclip: ${ctx.config.paperclipApi} as ${me.user?.name ?? me.userId}${key ? `; ${expiryNote(key)}` : ""}`);
  } catch (err) {
    out(`Paperclip: ${err.message}`);
    process.exitCode = 1;
  }
  if (stale) process.exitCode = 1;
}

// Docker HEALTHCHECK: the service's heartbeat is fresh and the relay answers.
export async function health(ctx) {
  const s = readStatus(ctx.config);
  if (!s || Date.now() - Date.parse(s.heartbeatAt ?? 0) > 90_000) throw new Error("no recent heartbeat from the service");
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
