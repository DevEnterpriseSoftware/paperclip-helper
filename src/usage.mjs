// `pch usage`: where the tokens go. Read-only.
//
// Per agent over the last N days: runs (and how many failed), input, cached and
// output tokens, the API-equivalent cost Paperclip records, model and effort; then
// what woke it (the wake reasons of its runs); then flags worth acting on:
//
//   * an agent that polls: more than 25% of its runs were its own Paperclip
//     monitor's wakes (issue_monitor_due). Name the run you wait on and end the
//     run; the helper's watchdog wakes you when it finishes;
//   * a large share of failed runs;
//   * an agent with far more than an even share of its provider's tokens (more
//     than 30%, and more than twice an even share).
//
// From GET /api/companies/:id/heartbeat-runs?agentId= (usageJson, contextSnapshot
// .wakeReason, invocationSource, status) and /costs/by-agent?from=&to= (costCents).

import { effortOf, TERMINAL_RUN, ts } from "./util.mjs";
import { companyAgents } from "./paperclip.mjs";
import { splitTokens } from "./prices.mjs";

const POLL_SHARE = 0.25;
const FAILED_SHARE = 0.2;
const MIN_FAILED = 5;
const HEAVY_SHARE = 0.3;
const RUN_LIMIT = 1000; // Paperclip's most per request
const MONITOR_WAKE = "issue_monitor_due";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Input here is fresh input: cached input is its own column. Codex counts cache hits
// in its input, and Paperclip stored them that way until 2026.10; runs stored since
// carry rawInputIncludesCached: false (splitTokens in prices.mjs, as cost sync uses).
export function tokensOf(run, adapterType) {
  const u = run.usageJson ?? {};
  const t = splitTokens(
    {
      inputTokens: u.inputTokens ?? run.inputTokens,
      cachedInputTokens: u.cachedInputTokens ?? run.cachedInputTokens,
      outputTokens: u.outputTokens ?? run.outputTokens,
      rawInputIncludesCached: u.rawInputIncludesCached,
    },
    adapterType,
  );
  return { input: t.input, cached: t.cacheRead, output: t.output };
}
const FINISHED = TERMINAL_RUN;
// What woke the run: its wake reason, else how it was invoked (assignment, timer, on demand).
export const wakeOf = (run) => run.contextSnapshot?.wakeReason || run.invocationSource || "unknown";
const providerOf = (agent) => ({ claude_local: "Anthropic", codex_local: "OpenAI" })[agent?.adapterType] ?? agent?.adapterType ?? "unknown";

// Per-agent totals, wake reasons and flags from runs since `since` (ms) and the cost rows.
export function summarize({ agents, runs, costs = [], since }) {
  const byId = new Map();
  for (const agent of agents) {
    byId.set(agent.id, {
      agent, name: agent.name, provider: providerOf(agent), model: agent.adapterConfig?.model ?? "(default)",
      effort: effortOf(agent.adapterConfig) || "", runs: 0, failed: 0, input: 0, cached: 0, output: 0, costCents: 0, wakes: new Map(),
    });
  }
  for (const run of runs) {
    const row = byId.get(run.agentId);
    // Finished runs only: one still going has no usage yet.
    if (!row || ts(run.createdAt) < since || !FINISHED.has(run.status)) continue;
    row.runs += 1;
    if (run.status === "failed" || run.status === "timed_out" || run.status === "interrupted") row.failed += 1;
    const t = tokensOf(run, row.agent.adapterType);
    row.input += t.input;
    row.cached += t.cached;
    row.output += t.output;
    const wake = wakeOf(run);
    row.wakes.set(wake, (row.wakes.get(wake) ?? 0) + 1);
  }
  for (const c of costs) {
    const row = byId.get(c.agentId);
    if (row) row.costCents += num(c.costCents);
  }
  const rows = [...byId.values()].filter((r) => r.runs > 0).sort((a, b) => total(b) - total(a));
  const providerTotals = new Map();
  for (const r of rows) providerTotals.set(r.provider, (providerTotals.get(r.provider) ?? 0) + total(r));
  const flags = [];
  for (const r of rows) {
    const monitor = r.wakes.get(MONITOR_WAKE) ?? 0;
    if (r.runs && monitor / r.runs > POLL_SHARE) {
      flags.push({ agent: r.name, kind: "polls", text: `${r.name} polls: ${pct(monitor / r.runs)} of its runs (${monitor} of ${r.runs}) were its own monitor's wakes. Tell it to name the run it waits on and end its run; the watchdog wakes it when the run finishes.` });
    }
    if (r.failed >= MIN_FAILED && r.failed / r.runs > FAILED_SHARE) {
      flags.push({ agent: r.name, kind: "failing", text: `${r.name}: ${pct(r.failed / r.runs)} of its runs failed (${r.failed} of ${r.runs}). Its runs' errors say why; \`pch why\` helps on one of its issues.` });
    }
    // Far above an even share: with two or three agents on a provider, one always has 30%.
    const peers = rows.filter((x) => x.provider === r.provider).length;
    const share = total(r) / (providerTotals.get(r.provider) || 1);
    if (peers > 1 && share > Math.max(HEAVY_SHARE, 2 / peers)) {
      flags.push({ agent: r.name, kind: "heavy", text: `${r.name} used ${pct(share)} of the ${r.provider} tokens.` });
    }
  }
  return { rows, flags };
}

const total = (r) => r.input + r.cached + r.output;
const pct = (x) => `${Math.round(x * 100)}%`;
export function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 999_500) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const money = (cents) => (cents ? `$${(cents / 100).toFixed(2)}` : "-");

// The report, as lines.
export function render({ rows, flags }, { days, truncated = [], costError = null }) {
  const lines = [];
  if (!rows.length) return [`No finished runs in the last ${days} days.`];
  const head = ["Agent", "Runs", "Failed", "Input", "Cached", "Output", "Cost", "Model", "Effort"];
  const table = rows.map((r) => [r.name, String(r.runs), String(r.failed), compact(r.input), compact(r.cached), compact(r.output), money(r.costCents), r.model, r.effort || "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const fmt = (row) => row.map((cell, i) => (i >= 1 && i <= 6 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ").trimEnd();
  lines.push(`Usage over the last ${days} days`, "", fmt(head), ...table.map(fmt), "");
  lines.push("What woke them:");
  for (const r of rows) {
    const wakes = [...r.wakes].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n} (${pct(n / r.runs)})`);
    lines.push(`  ${r.name}: ${wakes.join(", ")}`);
  }
  if (costError) lines.push("", `Paperclip didn't give the costs (${costError}): the Cost column is empty.`);
  else if (rows.every((r) => !r.costCents)) {
    lines.push("", "Cost is what Paperclip records: $0 for subscription runs unless cost sync posts their API-equivalent cost (`pch costs`).");
  }
  if (truncated.length) lines.push("", `Only the latest ${RUN_LIMIT} runs were read for ${truncated.join(", ")}: their totals are low.`);
  lines.push("", flags.length ? "Worth a look:" : "Nothing stands out.");
  for (const f of flags) lines.push(`  - ${f.text}`);
  return lines;
}

// Reads one company's agents, runs and costs for the report.
export async function readUsage(api, companyId, { since, until, agentName = null }) {
  const agents = (await companyAgents(api, companyId)).filter(
    (a) => !agentName || String(a.name).toLowerCase() === agentName.toLowerCase(),
  );
  const runs = [];
  const truncated = [];
  for (const agent of agents) {
    const list = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=${RUN_LIMIT}`);
    const rows = Array.isArray(list) ? list : [];
    runs.push(...rows);
    if (rows.length >= RUN_LIMIT && rows.every((r) => ts(r.createdAt) >= since)) truncated.push(agent.name);
  }
  const q = new URLSearchParams({ from: new Date(since).toISOString(), to: new Date(until).toISOString() });
  let costs = [];
  let costError = null;
  try {
    const rows = await api.request("GET", `/api/companies/${companyId}/costs/by-agent?${q}`);
    costs = Array.isArray(rows) ? rows : [];
  } catch (err) {
    costError = err.message;
  }
  return { agents, runs, costs, costError, truncated };
}

// `pch usage [--days N] [--agent NAME]`: "--days=7" and "--days 7" both work.
export function usageOptions(args) {
  const opts = { days: 7, agent: null };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] ?? "");
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = () => (eq >= 0 ? arg.slice(eq + 1) : args[++i]);
    if (flag === "--days") opts.days = Number(value());
    else if (flag === "--agent") {
      opts.agent = value();
      if (!opts.agent) throw new Error("--agent needs an agent's name, e.g. --agent Carla");
    } else if (arg) throw new Error(`usage: pch usage [--days N] [--agent NAME] (unknown: ${arg})`);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) throw new Error("--days needs a number of days, e.g. --days 7");
  return opts;
}
