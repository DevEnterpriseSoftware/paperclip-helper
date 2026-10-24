// API list prices, used to work out what a subscription run would have cost.
//
// USD per million tokens, standard tier, short context. `from` is the first day
// a price applies; a run is priced with the latest entry on or before the day it
// finished (or the earliest entry, if the run predates them all).
//
//   input        prompt tokens that were neither read from nor written to a cache
//   cachedInput  prompt tokens read from a cache
//   cacheWrite   prompt tokens written to a cache (optional; priced as input when absent)
//   output       completion tokens, reasoning included
//
// Codex reports only tokens, so its runs are priced here. Claude Code reports its
// own cost; the Anthropic prices give the least a Claude run's tokens can have
// cost, which catches runs whose reported cost is missing or too low (cost-sync.mjs).
//
// Override or extend it with a JSON file in the data directory (COST_PRICES_FILE,
// default /data/prices.json) in the same shape as BUILTIN_PRICES.models, e.g.
//   { "models": { "gpt-5.6-sol": [
//       { "from": "2026-01-01", "input": 4, "cachedInput": 0.4, "output": 20 },
//       { "from": "2026-11-22", "input": 5, "cachedInput": 0.5, "output": 30 } ] } }
// A model in the file replaces that model's whole built-in list, so include every
// period you want priced.

import fs from "node:fs";

export const BUILTIN_PRICES = {
  checked: "2026-10-24",
  sources: {
    openai: "https://developers.openai.com/api/docs/pricing",
    anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
  models: {
    // OpenAI. cacheWrite is the 30-minute write price.
    "gpt-6-astra": [{ from: "2026-01-01", input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
    "gpt-6.1-sol": [{ from: "2026-01-01", input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }],
    "gpt-6-sol": [{ from: "2026-01-01", input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }],
    "gpt-6-luna": [{ from: "2026-01-01", input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }],
    // Promotional price, announced as lasting at least through 2026-11-21.
    "gpt-5.6-sol": [{ from: "2026-01-01", input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }],
    "gpt-5.6-terra": [{ from: "2026-01-01", input: 2, cachedInput: 0.2, output: 12 }],
    "gpt-5.6-luna": [{ from: "2026-01-01", input: 0.2, cachedInput: 0.02, output: 1.2 }],
    "gpt-5.5": [{ from: "2025-01-01", input: 5, cachedInput: 0.5, output: 30 }],
    "gpt-5.4": [{ from: "2025-01-01", input: 2.5, cachedInput: 0.25, output: 15 }],
    "gpt-5.4-mini": [{ from: "2025-01-01", input: 0.75, cachedInput: 0.075, output: 4.5 }],
    "gpt-5.4-nano": [{ from: "2025-01-01", input: 0.2, cachedInput: 0.02, output: 1.25 }],
    "gpt-5.3-codex": [{ from: "2025-01-01", input: 1.75, cachedInput: 0.175, output: 14 }],
    "gpt-5.2": [{ from: "2025-01-01", input: 1.75, cachedInput: 0.175, output: 14 }],
    "gpt-5.2-codex": [{ from: "2025-01-01", input: 1.75, cachedInput: 0.175, output: 14 }],
    "gpt-5.1": [{ from: "2025-01-01", input: 1.25, cachedInput: 0.125, output: 10 }],
    "gpt-5.1-codex": [{ from: "2025-01-01", input: 1.25, cachedInput: 0.125, output: 10 }],
    "gpt-5.1-codex-max": [{ from: "2025-01-01", input: 1.25, cachedInput: 0.125, output: 10 }],
    "gpt-5.1-codex-mini": [{ from: "2025-01-01", input: 0.25, cachedInput: 0.025, output: 2 }],
    "gpt-5": [{ from: "2025-01-01", input: 1.25, cachedInput: 0.125, output: 10 }],
    "gpt-5-codex": [{ from: "2025-01-01", input: 1.25, cachedInput: 0.125, output: 10 }],
    "gpt-5-mini": [{ from: "2025-01-01", input: 0.25, cachedInput: 0.025, output: 2 }],
    "gpt-5-nano": [{ from: "2025-01-01", input: 0.05, cachedInput: 0.005, output: 0.4 }],
    "codex-mini-latest": [{ from: "2025-01-01", input: 1.5, cachedInput: 0.375, output: 6 }],
    o3: [{ from: "2025-01-01", input: 2, cachedInput: 0.5, output: 8 }],
    "o4-mini": [{ from: "2025-01-01", input: 1.1, cachedInput: 0.275, output: 4.4 }],
    "o3-mini": [{ from: "2025-01-01", input: 1.1, cachedInput: 0.55, output: 4.4 }],

    // Anthropic. cacheWrite is the 5-minute write price, the cheaper of the two,
    // since a run's totals don't say which was used.
    "claude-fable-5-1": [{ from: "2026-01-01", input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 }],
    "claude-mythos-5-1": [{ from: "2026-01-01", input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 }],
    "claude-fable-5": [{ from: "2026-01-01", input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
    "claude-mythos-5": [{ from: "2026-01-01", input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
    "claude-opus-5-5": [{ from: "2026-01-01", input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 }],
    "claude-opus-5": [{ from: "2026-01-01", input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
    "claude-opus-4-8": [{ from: "2025-01-01", input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
    "claude-opus-4-7": [{ from: "2025-01-01", input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
    "claude-opus-4-6": [{ from: "2025-01-01", input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
    "claude-opus-4-5": [{ from: "2025-01-01", input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
    "claude-opus-4-1": [{ from: "2025-01-01", input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 }],
    "claude-opus-4": [{ from: "2025-01-01", input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 }],
    "claude-sonnet-5-5": [{ from: "2026-01-01", input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }],
    "claude-sonnet-5": [{ from: "2026-01-01", input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }],
    "claude-sonnet-4-6": [{ from: "2025-01-01", input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
    "claude-sonnet-4-5": [{ from: "2025-01-01", input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
    "claude-sonnet-4": [{ from: "2025-01-01", input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
    // Haiku 5.5 costs more for prompts over 100K tokens; a run's totals can't
    // say which requests were, so this is the lower price.
    "claude-haiku-5-5": [{ from: "2026-01-01", input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }],
    "claude-haiku-4-5": [{ from: "2025-01-01", input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 }],
  },
  // Model names Paperclip passes through that the API knows by another name.
  aliases: {
    "gpt-5.6": "gpt-5.6-sol",
  },
};

export function normalizeModel(model) {
  let id = String(model ?? "").trim().toLowerCase();
  id = id.replace(/^(openai|anthropic)\//, "");
  if (id.startsWith("claude-")) {
    id = id.replace(/\[[^\]]*\]$/, ""); // claude-opus-5-5[1m]: same price for the whole window
    id = id.replace(/-\d{8}$/, ""); // dated snapshot
    id = id.replace(/(\d)\.(\d)/g, "$1-$2"); // claude-opus-5.5
  }
  return id;
}

export function loadPrices(file, log) {
  const table = { models: { ...BUILTIN_PRICES.models }, aliases: { ...BUILTIN_PRICES.aliases } };
  if (!file) return table;
  // Read here rather than with readJson: a malformed file must be reported and left
  // where it is for you to fix, not renamed aside.
  let custom;
  try {
    custom = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return table;
    log?.warn?.("cost sync: could not read the prices file; using the built-in prices", { file, error: err.message });
    return table;
  }
  if (!custom || typeof custom !== "object") return table;
  for (const [model, entries] of Object.entries(custom.models ?? {})) {
    if (!Array.isArray(entries) || !entries.every(validEntry)) {
      log?.warn?.("cost sync: ignoring a malformed price", { file, model });
      continue;
    }
    table.models[normalizeModel(model)] = entries;
  }
  for (const [from, to] of Object.entries(custom.aliases ?? {})) table.aliases[normalizeModel(from)] = normalizeModel(to);
  return table;
}

function validEntry(e) {
  return (
    e &&
    typeof e.from === "string" &&
    Number.isFinite(Date.parse(e.from)) &&
    ["input", "cachedInput", "output"].every((k) => typeof e[k] === "number" && e[k] >= 0) &&
    (e.cacheWrite === undefined || (typeof e.cacheWrite === "number" && e.cacheWrite >= 0))
  );
}

// The price entry for a model on a given date, or null if the model is unknown.
export function priceFor(table, model, at) {
  let id = normalizeModel(model);
  id = table.aliases[id] ?? id;
  const entries = table.models[id];
  if (!entries?.length) return null;
  const when = Date.parse(at ?? "") || Date.now();
  const sorted = [...entries].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  let chosen = sorted[0];
  for (const e of sorted) if (Date.parse(e.from) <= when) chosen = e;
  return { model: id, ...chosen };
}

// USD for tokens already split by splitTokens(): no category counts another's tokens.
export function estimateUsd(price, { input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) {
  const write = price.cacheWrite ?? price.input;
  return (input * price.input + cacheRead * price.cachedInput + cacheWrite * write + output * price.output) / 1_000_000;
}

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

// A run's tokens as four separate counts, from its usageJson (and, when there is
// one, the ACP engine's breakdown in resultJson.usage).
//
// Paperclip stores cache reads apart from input (cachedInputTokens), and counts
// cache writes as input. Codex was the exception until Paperclip 2026.10: it
// stored Codex's own input, which includes the cache reads. Paperclip marks runs
// stored the new way with rawInputIncludesCached: false; without the mark, a Codex
// input at least as large as its cache reads still includes them.
export function splitTokens(usage, adapterType, detail = null) {
  const u = usage ?? {};
  let input = count(u.inputTokens);
  const cacheRead = count(u.cachedInputTokens);
  const output = count(u.outputTokens);
  if (adapterType === "codex_local" && u.rawInputIncludesCached !== false && cacheRead > 0 && input >= cacheRead) input -= cacheRead;
  let cacheWrite = 0;
  const writes = count(detail?.cachedWriteTokens);
  if (writes && writes <= input) {
    cacheWrite = writes;
    input -= writes;
  }
  return { input, cacheRead, cacheWrite, output };
}
