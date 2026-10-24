// Cost sync figures checked against hand-worked list-price arithmetic, and the
// token shapes Paperclip has stored over time (see prices.mjs splitTokens).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { claudeCost, createCostSync } from "../src/cost-sync.mjs";
import { BUILTIN_PRICES, estimateUsd, priceFor, splitTokens } from "../src/prices.mjs";
import { tokensOf } from "../src/usage.mjs";

const sub = (extra) => ({ billingType: "subscription_included", costStatus: "reported", ...extra });

async function env(t, extra = {}) {
  const e = await setup({ env: extra });
  t.after(e.close);
  const agent = (name, adapterType, adapterConfig = {}) => {
    const a = { id: uuid(), companyId: ids.company, name, adapterType, adapterConfig, status: "idle" };
    e.db.agents.push(a);
    return a;
  };
  let minute = 60;
  const run = (agentId, usageJson, extra = {}) => {
    minute -= 1; // each run finishes a minute after the last, so posts go in seeding order
    const r = { id: uuid(), companyId: ids.company, agentId, status: "succeeded", createdAt: minutesAgo(minute + 10), finishedAt: minutesAgo(minute), usageJson, contextSnapshot: {}, ...extra };
    e.db.heartbeatRuns.push(r);
    return r;
  };
  return { ...e, agent, run, sync: createCostSync(e.ctx), posted: () => new Map(e.db.costEvents.map((ev) => [ev.heartbeatRunId, ev])) };
}

// ------------------------------------------------------------------ tokens

test("splitTokens: Codex input with and without Paperclip's rawInputIncludesCached mark", () => {
  // Paperclip 2026.10+: input is already net of cache reads.
  assert.deepEqual(splitTokens({ inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 5, rawInputIncludesCached: false }, "codex_local"), {
    input: 100_000,
    cacheRead: 900_000,
    cacheWrite: 0,
    output: 5,
  });
  // Older runs: Codex's own input, which includes the cache reads.
  assert.equal(splitTokens({ inputTokens: 1_000_000, cachedInputTokens: 900_000 }, "codex_local").input, 100_000);
  // Claude's input never included cache reads.
  assert.equal(splitTokens({ inputTokens: 100_000, cachedInputTokens: 50_000 }, "claude_local").input, 100_000);
  // The ACP breakdown separates cache writes from input.
  assert.deepEqual(splitTokens({ inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 0 }, "claude_local", { cachedWriteTokens: 30_000 }), {
    input: 70_000,
    cacheRead: 0,
    cacheWrite: 30_000,
    output: 0,
  });
  // A breakdown larger than the input is not trusted.
  assert.equal(splitTokens({ inputTokens: 10 }, "claude_local", { cachedWriteTokens: 30 }).cacheWrite, 0);
});

test("pch usage counts fresh input the same way", () => {
  const marked = { usageJson: { inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 1, rawInputIncludesCached: false } };
  assert.deepEqual(tokensOf(marked, "codex_local"), { input: 100_000, cached: 900_000, output: 1 });
  const legacy = { usageJson: { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 1 } };
  assert.deepEqual(tokensOf(legacy, "codex_local"), { input: 100_000, cached: 900_000, output: 1 });
});

test("the price table matches the published list prices checked 2026-10-24", () => {
  const p = (m) => {
    const { input, cachedInput, cacheWrite, output } = priceFor(BUILTIN_PRICES, m, "2026-10-24");
    return [input, cachedInput, cacheWrite, output];
  };
  // platform.claude.com/docs/en/about-claude/pricing: input, cache hit, 5m write, output.
  assert.deepEqual(p("claude-opus-5-5"), [4, 0.2, 5, 20]);
  assert.deepEqual(p("claude-sonnet-5-5"), [2, 0.1, 2.5, 10]);
  assert.deepEqual(p("claude-fable-5-1"), [10, 0.25, 12.5, 50]);
  // developers.openai.com/api/docs/pricing: input, cached, 30m write, output.
  assert.deepEqual(p("gpt-6.1-sol"), [2, 0.1, 2.5, 10]);
  assert.deepEqual(p("gpt-6-luna"), [0.1, 0.01, 0.125, 0.5]);
});

// ------------------------------------------------------------------ Codex

test("Codex: a marked run's fresh input is priced in full (it used to be lost)", async (t) => {
  const e = await env(t);
  const codex = e.agent("Codex", "codex_local", { model: "gpt-6.1-sol" });
  const r = e.run(codex.id, sub({ provider: "openai", biller: "chatgpt", model: "gpt-6.1-sol", inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 50_000, rawInputIncludesCached: false }));
  await e.sync.tick();
  // 0.1M × $2 + 0.9M × $0.10 + 0.05M × $10 = 0.20 + 0.09 + 0.50 = $0.79.
  // (Subtracting the cache reads again priced the fresh input at nothing: $0.51.)
  assert.equal(e.posted().get(r.id).costCents, 79);
  assert.equal(e.posted().get(r.id).costStatus, "estimated");
});

test("Codex on ACP: cache writes from the run's breakdown at the write price", async (t) => {
  const e = await env(t);
  const codex = e.agent("Codex", "codex_local", { model: "gpt-6.1-sol" });
  const r = e.run(
    codex.id,
    sub({ provider: "openai", biller: "chatgpt", model: "gpt-6.1-sol", inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 50_000, rawInputIncludesCached: false }),
    { resultJson: { fastMode: false, usage: { inputTokens: 80_000, cachedWriteTokens: 20_000, cachedReadTokens: 900_000, outputTokens: 50_000 } } },
  );
  await e.sync.tick();
  // 0.08M × $2 + 0.02M × $2.50 + 0.9M × $0.10 + 0.05M × $10 = 0.16 + 0.05 + 0.09 + 0.50 = $0.80.
  assert.equal(e.posted().get(r.id).costCents, 80);
});

test("Codex with no recorded model is priced with the agent's configured model", async (t) => {
  const e = await env(t);
  const codex = e.agent("Codex", "codex_local", { model: "gpt-6-luna" });
  const r = e.run(codex.id, sub({ provider: "openai", model: "unknown", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, rawInputIncludesCached: false }));
  await e.sync.tick();
  // 1M × $0.10 + 1M × $0.50 = $0.60.
  const ev = e.posted().get(r.id);
  assert.equal(ev.costCents, 60);
  assert.equal(ev.model, "gpt-6-luna");
});

// ------------------------------------------------------------------ Claude

// 30K input (all fresh), 2M cache reads, 40K output on Opus 5.5:
// 0.03M × $4 + 2M × $0.20 + 0.04M × $20 = 0.12 + 0.40 + 0.80 = $1.32.
const opusTokens = { inputTokens: 30_000, cachedInputTokens: 2_000_000, outputTokens: 40_000 };
const opus = (extra) => sub({ provider: "anthropic", biller: "anthropic", model: "claude-opus-5-5", ...opusTokens, ...extra });

test("claudeCost: the reported cost stands unless the tokens cost clearly more", () => {
  assert.deepEqual(claudeCost({ reported: 2, floor: 1.32 }), { usd: 2, basis: "reported" });
  assert.deepEqual(claudeCost({ reported: 1.25, floor: 1.32 }), { usd: 1.25, basis: "reported" }, "within 10%: price slack, not a gap");
  assert.deepEqual(claudeCost({ reported: 0.5, floor: 1.32 }), { usd: 1.32, basis: "token floor" });
  assert.deepEqual(claudeCost({ reported: null, floor: 1.32 }), { usd: 1.32, basis: "token floor" });
  assert.deepEqual(claudeCost({ reported: 0.5, floor: null }), { usd: 0.5, basis: "reported" });
});

test("Claude: a run that stopped before reporting a cost is priced from its tokens", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const r = e.run(claude.id, opus({}), { status: "timed_out" });
  await e.sync.tick();
  const ev = e.posted().get(r.id);
  assert.equal(ev.costCents, 132);
  assert.equal(ev.costStatus, "estimated");
  assert.equal(ev.model, "claude-opus-5-5");
});

test("Claude: a reported cost at or above the token price is kept, without fetching the run", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const r = e.run(claude.id, opus({ costUsd: 2.5, cacheAdjustedCostUsd: 2.5 }));
  await e.sync.tick();
  assert.equal(e.posted().get(r.id).costCents, 250);
  assert.equal(e.posted().get(r.id).costStatus, "reported");
  assert.equal(e.fake.requests.some((q) => q.method === "GET" && q.path === `/api/heartbeat-runs/${r.id}`), false);
});

test("Claude on ACP: a delta below the token price is raised to it, never to the session's running cost", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  // The running cost includes earlier runs' turns, already posted: it is never used.
  const r = e.run(claude.id, opus({ costUsd: 0.5, cacheAdjustedCostUsd: 0.5 }), { resultJson: { cumulativeCostUsd: 3.5 } });
  await e.sync.tick();
  const ev = e.posted().get(r.id);
  assert.equal(ev.costCents, 132);
  assert.equal(ev.costStatus, "estimated");
});

test("Claude CLI with subagents on another model: priced model by model, not all at the main model", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  // Opus main loop: 1M cache reads, 0.1M output = 0.20 + 2.00 = $2.20.
  // Haiku subagents: 10M cache reads, 2M output = 0.10 + 1.00 = $1.10. Together $3.30, as reported.
  const usageByModel = [
    { model: "claude-opus-5-5", usage: { inputTokens: 0, cachedInputTokens: 1_000_000, outputTokens: 100_000 }, costUsd: 2.2 },
    { model: "claude-haiku-5-5", usage: { inputTokens: 0, cachedInputTokens: 10_000_000, outputTokens: 2_000_000 }, costUsd: 1.1 },
  ];
  const r = e.run(claude.id, sub({ provider: "anthropic", biller: "anthropic", model: "mixed", inputTokens: 0, cachedInputTokens: 11_000_000, outputTokens: 2_100_000, costUsd: 3.3, usageByModel }));
  await e.sync.tick();
  // Priced all at Opus the tokens would come to $44.20.
  assert.equal(e.posted().get(r.id).costCents, 330);
});

test("Claude \"mixed\" without a per-model split keeps its reported cost", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const r = e.run(claude.id, sub({ provider: "anthropic", biller: "anthropic", model: "mixed", inputTokens: 0, cachedInputTokens: 11_000_000, outputTokens: 2_100_000, costUsd: 3.3 }));
  await e.sync.tick();
  assert.equal(e.posted().get(r.id).costCents, 330);
});

test("Claude on ACP: cache writes in the breakdown raise the floor", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  // 30K input of which 20K were cache writes: 0.01M × $4 + 0.02M × $5 + 0.40 + 0.80 = $1.34.
  const r = e.run(claude.id, opus({ costUsd: 0.2 }), { resultJson: { usage: { inputTokens: 10_000, cachedWriteTokens: 20_000 } } });
  await e.sync.tick();
  assert.equal(e.posted().get(r.id).costCents, 134);
});

test("Claude that reported no cost and used several models is not guessed at", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-sonnet-5-5" });
  const r = e.run(claude.id, sub({ provider: "anthropic", biller: "anthropic", model: "mixed", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }), { status: "cancelled" });
  await e.sync.tick();
  assert.equal(e.posted().has(r.id), false);
});

test("Codex on ACP: requested fast mode is doubled only on a model that has it", async (t) => {
  const e = await env(t);
  const codex = e.agent("Codex", "codex_local", { model: "gpt-5.3-codex", fastMode: true });
  const r = e.run(codex.id, sub({ provider: "openai", model: "gpt-5.3-codex", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, rawInputIncludesCached: false }), { resultJson: { fastMode: true } });
  await e.sync.tick();
  assert.equal(e.posted().get(r.id).costCents, 175, "1M × $1.75, not doubled");
});

// ------------------------------------------------------------------ idempotency

test("with idempotency keys, a post whose answer never came is posted again and recorded once", async (t) => {
  const e = await env(t, { PAPERCLIP_TIMEOUT_SEC: "1" });
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const first = e.run(claude.id, opus({ costUsd: 3 }));
  const second = e.run(claude.id, opus({ costUsd: 4 }));
  // The first post confirms Paperclip honours keys; the second is recorded, but its answer is lost.
  const original = e.db.costEvents.push.bind(e.db.costEvents);
  e.db.costEvents.push = (...items) => {
    const n = original(...items);
    if (items.some((i) => i.heartbeatRunId === second.id)) e.db.hangAfterRecording = 1;
    return n;
  };
  await assert.rejects(e.sync.tick());
  assert.equal(e.db.costEvents.length, 2, "both recorded");
  const state = JSON.parse(fs.readFileSync(e.ctx.config.costStateFile, "utf8"));
  assert.equal(state.idempotent, true);
  assert.ok(state.inflight[second.id]?.body, "the lost post is kept, body and all");

  await e.sync.tick();
  assert.equal(e.db.costEvents.filter((ev) => ev.heartbeatRunId === second.id).length, 1, "recorded once");
  assert.equal(e.posted().get(second.id).costCents, 400);
  const after = JSON.parse(fs.readFileSync(e.ctx.config.costStateFile, "utf8"));
  assert.deepEqual(after.inflight, {});
  assert.ok(after.companies[ids.company].synced[second.id]);
});

test("a key Paperclip already holds for other figures counts the run as synced", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const r = e.run(claude.id, opus({ costUsd: 3 }));
  e.db.costEvents.push({ id: uuid(), companyId: ids.company, idempotencyKey: `pch-cost-sync:${r.id}`, heartbeatRunId: r.id, costCents: 1 });
  await e.sync.tick();
  assert.equal(e.db.costEvents.filter((ev) => ev.heartbeatRunId === r.id).length, 1);
  const state = JSON.parse(fs.readFileSync(e.ctx.config.costStateFile, "utf8"));
  assert.ok(state.companies[ids.company].synced[r.id]);
});

test("a 401 or 429 skips nothing: the runs are posted on a later pass", async (t) => {
  const e = await env(t);
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const r = e.run(claude.id, opus({ costUsd: 3 }));
  e.fake.fail("POST", `/api/companies/${ids.company}/cost-events`, 429);
  await assert.rejects(e.sync.tick());
  const state = JSON.parse(fs.readFileSync(e.ctx.config.costStateFile, "utf8"));
  assert.deepEqual(state.skipped, {});
  await e.sync.tick();
  assert.equal(e.posted().get(r.id).costCents, 300);
});

test("a Paperclip that stops keeping keys is noticed, and lost posts aren't repeated there", async (t) => {
  const e = await env(t, { PAPERCLIP_TIMEOUT_SEC: "1" });
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  e.run(claude.id, opus({ costUsd: 3 }));
  await e.sync.tick();
  assert.equal(JSON.parse(fs.readFileSync(e.ctx.config.costStateFile, "utf8")).idempotent, true);
  e.db.costIdempotency = false; // restored from an older version
  const second = e.run(claude.id, opus({ costUsd: 4 }));
  const third = e.run(claude.id, opus({ costUsd: 5 }));
  const original = e.db.costEvents.push.bind(e.db.costEvents);
  e.db.costEvents.push = (...items) => {
    const n = original(...items);
    if (items.some((i) => i.heartbeatRunId === third.id)) e.db.hangAfterRecording = 1;
    return n;
  };
  await assert.rejects(e.sync.tick());
  await e.sync.tick();
  assert.equal(e.db.costEvents.filter((ev) => ev.heartbeatRunId === third.id).length, 1, "not posted twice");
  assert.ok(e.posted().has(second.id));
});

test("a post that keeps timing out is given up after 5 retries", async (t) => {
  const e = await env(t, { PAPERCLIP_TIMEOUT_SEC: "1" });
  const claude = e.agent("Claude", "claude_local", { model: "claude-opus-5-5" });
  const r = e.run(claude.id, opus({ costUsd: 3 }));
  fs.writeFileSync(
    e.ctx.config.costStateFile,
    JSON.stringify({ version: 2, companies: {}, idempotent: true, skipped: {}, inflight: { [r.id]: { companyId: ids.company, finishedAt: r.finishedAt, retries: 5, body: { idempotencyKey: `pch-cost-sync:${r.id}`, agentId: claude.id, heartbeatRunId: r.id, provider: "anthropic", model: "x", costCents: 300, occurredAt: r.finishedAt }, carry: { key: "k", rest: 0 } } } }),
  );
  await e.sync.tick();
  const state = JSON.parse(fs.readFileSync(e.ctx.config.costStateFile, "utf8"));
  assert.match(state.skipped[r.id], /after 5 retries/);
  assert.equal(e.db.costEvents.length, 0);
});

// ------------------------------------------------------------------ audit

test("costs --audit: per-agent figures, why runs were raised, and duplicate posts", async (t) => {
  const e = await env(t);
  const claude = e.agent("Opus", "claude_local", { model: "claude-opus-5-5" });
  const codex = e.agent("Codex", "codex_local", { model: "gpt-6.1-sol" });
  e.run(claude.id, opus({ costUsd: 2.5 }));
  e.run(claude.id, opus({}), { status: "timed_out" });
  e.run(claude.id, opus({ costUsd: 0.5 }), { resultJson: { cumulativeCostUsd: 2.1 } });
  const c = e.run(codex.id, sub({ provider: "openai", model: "gpt-6.1-sol", inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 50_000, rawInputIncludesCached: false }), { resultJson: { fastMode: false } });
  e.run(claude.id, opus({ costUsd: 1 }), { finishedAt: minutesAgo(60 * 24 * 9) }); // outside 7 days
  // Two posts by this user for the same run.
  for (let i = 0; i < 2; i += 1) e.db.activity.push({ action: "cost.reported", actorType: "user", actorId: ids.user, entityType: "cost_event", runId: c.id });

  const text = (await captureOutput(() => e.sync.audit())).join("\n");
  // Opus: reported 2.50 + 0 + 0.50 = 3.00; tokens 3 × 1.32 = 3.96; posts 2.50 + 1.32 + 1.32 = 5.14.
  assert.match(text, /Opus\s+3\s+.*\$3\.00\s+\$3\.96\s+\$5\.14\s+1 no cost reported, 1 raised/);
  assert.match(text, /Codex\s+1\s+0\.1M\s+0\.9M\s+0\.0M\s+0\.1M\s+\$0\.00\s+\$0\.79\s+\$0\.79/);
  assert.match(text, /anthropic: 3 runs; reported \$3\.00; their tokens at list price \$3\.96; cost sync would post \$5\.14/);
  assert.match(text, /1 runs reported no cost/);
  assert.match(text, /1 runs reported more than 10% less than their tokens cost/);
  assert.match(text, /1 runs were posted more than once/);
  assert.equal(e.db.costEvents.length, 0, "the audit posts nothing");
});

test("estimateUsd prices cache writes as input when a model has no write price", () => {
  const usd = estimateUsd({ input: 1, cachedInput: 0.1, output: 2 }, { input: 1_000_000, cacheWrite: 1_000_000 });
  assert.equal(usd, 2);
});
