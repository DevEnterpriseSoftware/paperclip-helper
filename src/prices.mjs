// API list prices, used to estimate what a subscription run would have cost
// when the agent's CLI reports tokens but no cost (Codex does this).
//
// USD per million tokens, standard tier, short context. `from` is the first
// day a price applies; a run is priced with the latest entry on or before the
// day it finished (or the earliest entry, if the run predates them all). Claude
// Code reports its own cost, so Claude runs don't need this table.
//
// Override or extend it with a JSON file in the data directory (COST_PRICES_FILE,
// default /data/prices.json) in the same shape as BUILTIN_PRICES.models, e.g.
//   { "models": { "gpt-5.6-sol": [
//       { "from": "2026-01-01", "input": 4, "cachedInput": 0.4, "output": 20 },
//       { "from": "2026-11-22", "input": 5, "cachedInput": 0.5, "output": 30 } ] } }
// A model in the file replaces that model's whole built-in list, so include every
// period you want priced.

import { readJson } from "./store.mjs";

export const BUILTIN_PRICES = {
  checked: "2026-09-30",
  source: "https://developers.openai.com/api/docs/pricing",
  models: {
    "gpt-6-astra": [{ from: "2026-01-01", input: 10, cachedInput: 1, output: 50 }],
    "gpt-6.1-sol": [{ from: "2026-01-01", input: 2, cachedInput: 0.1, output: 10 }],
    "gpt-6-sol": [{ from: "2026-01-01", input: 2, cachedInput: 0.2, output: 10 }],
    "gpt-6-luna": [{ from: "2026-01-01", input: 0.1, cachedInput: 0.01, output: 0.5 }],
    // Promotional price, announced as lasting at least through 2026-11-21.
    "gpt-5.6-sol": [{ from: "2026-01-01", input: 4, cachedInput: 0.4, output: 20 }],
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
  },
  // Model names Paperclip passes through that the API knows by another name.
  aliases: {
    "gpt-5.6": "gpt-5.6-sol",
  },
};

export function normalizeModel(model) {
  let id = String(model ?? "").trim().toLowerCase();
  id = id.replace(/^(openai|anthropic)\//, "");
  return id;
}

export function loadPrices(file, log) {
  const table = { models: { ...BUILTIN_PRICES.models }, aliases: { ...BUILTIN_PRICES.aliases } };
  if (!file) return table;
  let custom;
  try {
    custom = readJson(file, null);
  } catch (err) {
    log?.warn?.("cost sync: could not read the prices file", { file, error: err.message });
    return table;
  }
  if (!custom) return table;
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
    ["input", "cachedInput", "output"].every((k) => typeof e[k] === "number" && e[k] >= 0)
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

// OpenAI counts cached input as part of input: uncached = input − cached.
export function estimateUsd(price, { inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 }) {
  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const uncached = Math.max(0, inputTokens - cached);
  return (uncached * price.input + cached * price.cachedInput + outputTokens * price.output) / 1_000_000;
}
