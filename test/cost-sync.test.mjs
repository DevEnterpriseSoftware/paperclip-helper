import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createCostSync } from "../src/cost-sync.mjs";
import { BUILTIN_PRICES, estimateUsd, priceFor } from "../src/prices.mjs";

const sub = (extra) => ({ billingType: "subscription_included", costStatus: "reported", ...extra });

function seed(db) {
  const agent = (name, adapterType, adapterConfig = {}) => {
    const a = { id: uuid(), companyId: ids.company, name, adapterType, adapterConfig, status: "idle" };
    db.agents.push(a);
    return a;
  };
  const claude = agent("Claude", "claude_local", { model: "claude-sonnet-5" });
  const codex = agent("Codex", "codex_local", { model: "gpt-5.3-codex" });
  const fast = agent("Fast", "codex_local", { model: "gpt-5.3-codex", fastMode: true });
  const gemini = agent("Gemini", "gemini_local");
  const issue = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "done" };
  db.issues.push(issue);
  const codexTokens = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
  const run = (id, agentId, usageJson, extra = {}) => {
    const r = {
      id,
      companyId: ids.company,
      agentId,
      status: "succeeded",
      createdAt: minutesAgo(40),
      finishedAt: minutesAgo(30),
      usageJson,
      contextSnapshot: { issueId: issue.id },
      ...extra,
    };
    db.heartbeatRuns.push(r);
    return r;
  };
  const runs = {
    claude: run(uuid(), claude.id, sub({ provider: "anthropic", biller: "anthropic", model: "claude-sonnet-5", costUsd: 1.234, cacheAdjustedCostUsd: 1.234, inputTokens: 5000, outputTokens: 300 })),
    apiKey: run(uuid(), claude.id, { billingType: "metered_api", provider: "anthropic", biller: "anthropic", model: "claude-sonnet-5", costUsd: 2 }),
    codex: run(uuid(), codex.id, sub({ provider: "openai", biller: "chatgpt", model: "gpt-5.3-codex", ...codexTokens, costStatus: "unpriced" })),
    fast: run(uuid(), fast.id, sub({ provider: "openai", biller: "chatgpt", model: "gpt-5.3-codex", ...codexTokens })),
    blankModel: run(uuid(), codex.id, sub({ provider: "openai", biller: "chatgpt", model: "unknown", ...codexTokens })),
    tiny: run(uuid(), claude.id, sub({ provider: "anthropic", biller: "anthropic", model: "claude-sonnet-5", costUsd: 0.004 })),
    running: run(uuid(), claude.id, null, { status: "running", finishedAt: null }),
    settling: run(uuid(), claude.id, sub({ provider: "anthropic", biller: "anthropic", model: "claude-sonnet-5", costUsd: 3 }), { finishedAt: minutesAgo(1) }),
    gemini: run(uuid(), gemini.id, sub({ provider: "google", biller: "google", model: "gemini-3-pro", costUsd: 0.5 })),
  };
  return { claude, codex, fast, gemini, issue, runs };
}

async function syncEnv(t, extra = {}) {
  const env = await setup({ env: extra });
  t.after(env.close);
  const seeded = seed(env.db);
  return { ...env, ...seeded, sync: createCostSync(env.ctx) };
}

const byRun = (db) => new Map(db.costEvents.map((e) => [e.heartbeatRunId, e]));

test("price table: lookup by date and alias, and OpenAI's cached-input arithmetic", () => {
  assert.equal(priceFor(BUILTIN_PRICES, "gpt-5.6", "2026-09-30").model, "gpt-5.6-sol");
  assert.equal(priceFor(BUILTIN_PRICES, "OpenAI/GPT-5.3-Codex", "2026-09-30").output, 14);
  assert.equal(priceFor(BUILTIN_PRICES, "claude-sonnet-5"), null);
  const table = { models: { m: [{ from: "2026-01-01", input: 1, cachedInput: 0.1, output: 2 }, { from: "2026-06-01", input: 3, cachedInput: 0.3, output: 6 }] }, aliases: {} };
  assert.equal(priceFor(table, "m", "2026-03-01").input, 1);
  assert.equal(priceFor(table, "m", "2026-07-01").input, 3);
  const usd = estimateUsd({ input: 1.75, cachedInput: 0.175, output: 14 }, { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 });
  assert.equal(Math.round(usd * 100), 252);
});

test("posts subscription runs once: Claude's reported cost, Codex estimated from tokens, fast mode doubled", async (t) => {
  const env = await syncEnv(t);
  await env.sync.tick();
  const events = byRun(env.db);
  assert.equal(events.size, 3);

  const claude = events.get(env.runs.claude.id);
  assert.deepEqual(
    { ...claude, id: undefined, companyId: undefined },
    {
      id: undefined,
      companyId: undefined,
      agentId: env.claude.id,
      heartbeatRunId: env.runs.claude.id,
      issueId: env.issue.id,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      costStatus: "reported",
      model: "claude-sonnet-5",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 123,
      occurredAt: env.runs.claude.finishedAt,
    },
  );
  const codex = events.get(env.runs.codex.id);
  assert.equal(codex.costCents, 252);
  assert.equal(codex.provider, "openai");
  assert.equal(codex.biller, "chatgpt");
  assert.equal(codex.model, "gpt-5.3-codex");
  assert.equal(events.get(env.runs.fast.id).costCents, 504);

  // Not posted on this pass: API-key runs and other adapters (never), an unknown
  // model (until priced), the sub-cent run (carried), unfinished or settling runs (later).
  for (const skipped of ["apiKey", "gemini", "blankModel", "tiny", "running", "settling"]) {
    assert.equal(events.has(env.runs[skipped].id), false, skipped);
  }
  assert.ok(env.logs.some((l) => l.level === "warn" && /model unknown/.test(l.msg)));

  await env.sync.tick();
  assert.equal(env.db.costEvents.length, 3, "a second pass posts nothing");
  assert.equal(env.sync.stats.posted, 3);
});

test("fast mode comes from the run's own record, not the agent's current setting", async (t) => {
  const env = await syncEnv(t);
  // ACP engine: resultJson.fastMode. The agent has fast mode on now, but this run didn't.
  env.runs.fast.resultJson = { fastMode: false };
  // CLI engine: service_tier="fast" in the last attempt's command, though the agent has it off now.
  const invoke = (args) => ({ eventType: "adapter.invoke", payload: { commandArgs: ["exec", "--json", ...args] } });
  env.db.runEvents[env.runs.codex.id] = [invoke([]), invoke(["-c", 'service_tier="fast"', "-c", "features.fast_mode=true"])];
  await env.sync.tick();
  const events = byRun(env.db);
  assert.equal(events.get(env.runs.fast.id).costCents, 252);
  assert.equal(events.get(env.runs.codex.id).costCents, 504);
});

test("when Paperclip doesn't answer about fast mode, the run waits for the next pass", async (t) => {
  const env = await syncEnv(t);
  env.fake.fail("GET", `/api/heartbeat-runs/${env.runs.fast.id}`, 500, { times: 2 }); // a GET is retried once
  await env.sync.tick();
  assert.equal(byRun(env.db).has(env.runs.fast.id), false);
  assert.ok(byRun(env.db).has(env.runs.codex.id), "other runs aren't held up");
  await env.sync.tick();
  assert.equal(byRun(env.db).get(env.runs.fast.id).costCents, 504);
});

test("a CLI run whose fast mode Paperclip ignored is not doubled", async (t) => {
  const env = await syncEnv(t);
  env.db.runEvents[env.runs.fast.id] = [{ eventType: "adapter.invoke", payload: { commandArgs: ["exec", "--json"], commandNotes: ["Paperclip will ignore it for model gpt-5.3-codex."] } }];
  await env.sync.tick();
  assert.equal(byRun(env.db).get(env.runs.fast.id).costCents, 252);
});

test("fractions of a cent are carried per agent and model until they add up", async (t) => {
  const env = await setup();
  t.after(env.close);
  const agent = { id: uuid(), companyId: ids.company, name: "Luna", adapterType: "codex_local", adapterConfig: { model: "gpt-6-luna" } };
  env.db.agents.push(agent);
  // 0.3¢ each: 6,000 uncached input at $0.10/M = $0.0006, plus 4,800 output at $0.50/M = $0.0024.
  const run = (minutes, model = "gpt-6-luna") =>
    env.db.heartbeatRuns.push({
      id: uuid(),
      companyId: ids.company,
      agentId: agent.id,
      status: "succeeded",
      createdAt: minutesAgo(minutes + 1),
      finishedAt: minutesAgo(minutes),
      usageJson: sub({ provider: "openai", biller: "chatgpt", model, inputTokens: 6000, cachedInputTokens: 0, outputTokens: 4800 }),
    });
  for (const m of [50, 49, 48, 47, 46]) run(m);
  run(45, "gpt-6-sol"); // another model carries separately
  const sync = createCostSync(env.ctx);
  await sync.tick();
  // 0.3 → 0.6 → 0.9 → 1.2 (post 1¢, carry 0.2) → 0.5
  const luna = env.db.costEvents.filter((e) => e.model === "gpt-6-luna");
  assert.deepEqual(luna.map((e) => e.costCents), [1]);
  assert.equal(env.db.costEvents.filter((e) => e.model === "gpt-6-sol").length, 1); // 6k × $2/M + 4.8k × $10/M = 6¢
  const saved = JSON.parse(fs.readFileSync(env.ctx.config.costStateFile, "utf8"));
  const key = Object.keys(saved.carry).find((k) => k.endsWith("|gpt-6-luna"));
  assert.ok(Math.abs(saved.carry[key] - 0.5) < 1e-6, `carry ${saved.carry[key]}`);
  assert.equal(Object.keys(saved.companies[ids.company].synced).length, 6, "carried runs count as synced");

  // Two more runs: 0.5 + 0.3 + 0.3 = 1.1 → one more cent; nothing is posted twice.
  run(10);
  run(9);
  await sync.tick();
  assert.deepEqual(env.db.costEvents.filter((e) => e.model === "gpt-6-luna").map((e) => e.costCents), [1, 1]);
});

test("CODEX_DEFAULT_MODEL prices runs whose model Paperclip didn't record", async (t) => {
  const env = await syncEnv(t, { CODEX_DEFAULT_MODEL: "gpt-5.3-codex" });
  await env.sync.tick();
  const blank = byRun(env.db).get(env.runs.blankModel.id);
  assert.equal(blank.costCents, 252);
  assert.equal(blank.model, "gpt-5.3-codex");
});

test("a prices file adds models", async (t) => {
  const env = await syncEnv(t);
  env.runs.codex.usageJson.model = "gpt-7-preview";
  fs.writeFileSync(env.ctx.config.costPricesFile, JSON.stringify({ models: { "gpt-7-preview": [{ from: "2026-01-01", input: 10, cachedInput: 1, output: 10 }] } }));
  await env.sync.tick();
  // 600k uncached × $10 + 400k cached × $1 + 100k output × $10, per million
  assert.equal(byRun(env.db).get(env.runs.codex.id).costCents, 740);
});

test("COST_SYNC_ADAPTERS replaces the default adapters", async (t) => {
  const env = await syncEnv(t, { COST_SYNC_ADAPTERS: "gemini_local" });
  await env.sync.tick();
  assert.deepEqual([...byRun(env.db).keys()], [env.runs.gemini.id]);
});

test("a post interrupted by a crash is never repeated", async (t) => {
  const env = await syncEnv(t);
  fs.writeFileSync(
    env.ctx.config.costStateFile,
    JSON.stringify({ version: 2, companies: {}, inflight: { [env.runs.codex.id]: minutesAgo(5) }, skipped: {} }),
  );
  await env.sync.tick();
  assert.equal(byRun(env.db).has(env.runs.codex.id), false);
  assert.equal(env.db.costEvents.length, 2);
});

test("an event whose issue Paperclip no longer has is posted without it", async (t) => {
  const env = await syncEnv(t);
  env.runs.claude.contextSnapshot.issueId = uuid(); // an issue Paperclip no longer has
  await env.sync.tick();
  const claude = byRun(env.db).get(env.runs.claude.id);
  assert.ok(claude, "posted");
  assert.equal(claude.issueId, undefined);
  assert.equal(byRun(env.db).get(env.runs.codex.id).issueId, env.issue.id, "other events keep theirs");
});

test("a 5xx is retried next time; a timeout is not", async (t) => {
  const env = await syncEnv(t, { PAPERCLIP_TIMEOUT_SEC: "1" });
  const path = `/api/companies/${ids.company}/cost-events`;

  env.fake.fail("POST", path, 503);
  await assert.rejects(env.sync.tick());
  assert.equal(env.db.costEvents.length, 0);

  env.fake.fail("POST", path, 0, { hang: true });
  await assert.rejects(env.sync.tick());
  const hung = env.fake.requests.filter((r) => r.method === "POST").at(-1).body.heartbeatRunId;

  await env.sync.tick();
  const events = byRun(env.db);
  assert.equal(events.has(hung), false, "the timed-out post is not repeated");
  assert.equal(events.size, 2);
});

test("no state file but earlier posts by you: only new runs are synced", async (t) => {
  const env = await syncEnv(t);
  env.db.activity.push({ action: "cost.reported", actorType: "user", actorId: ids.user, entityType: "cost_event" });
  await env.sync.tick();
  assert.equal(env.db.costEvents.length, 0);
  assert.ok(env.logs.some((l) => l.level === "warn" && /no state file/.test(l.msg)));
});

test("a corrupt state file is treated like a lost one: nothing is posted twice", async (t) => {
  const env = await syncEnv(t);
  fs.writeFileSync(env.ctx.config.costStateFile, "{ not json");
  env.db.activity.push({ action: "cost.reported", actorType: "user", actorId: ids.user, entityType: "cost_event" });
  await env.sync.tick();
  assert.equal(env.db.costEvents.length, 0);
  assert.ok(env.logs.some((l) => l.level === "warn" && /no state file/.test(l.msg)));
});

test("a terminated agent's runs are still synced", async (t) => {
  const env = await syncEnv(t);
  env.claude.status = "terminated";
  await env.sync.tick();
  assert.ok(byRun(env.db).has(env.runs.claude.id));
});

test("COST_SYNC_SINCE skips older runs", async (t) => {
  const env = await syncEnv(t, { COST_SYNC_SINCE: minutesAgo(20) });
  env.runs.codex.finishedAt = minutesAgo(10);
  await env.sync.tick();
  assert.deepEqual([...byRun(env.db).keys()], [env.runs.codex.id]);
});

test("dry run posts and saves nothing", async (t) => {
  const env = await syncEnv(t, { DRY_RUN: "true" });
  await env.sync.tick();
  assert.equal(env.db.costEvents.length, 0);
  assert.equal(fs.existsSync(env.ctx.config.costStateFile), false);
  assert.equal(env.logs.filter((l) => l.msg === "cost sync: would post (dry run)").length, 3);
});

test("costs --sessions pairs each resumed run with the run it resumed", async (t) => {
  const env = await setup();
  t.after(env.close);
  const agent = { id: uuid(), companyId: ids.company, name: "Claude", adapterType: "claude_local", adapterConfig: {} };
  env.db.agents.push(agent);
  // Five resumed runs; two cost less than the run before them: per-run figures.
  const costs = [2.4, 0.75, 1.5, 0.9, 1.2, 1.3];
  costs.forEach((costUsd, i) =>
    env.db.heartbeatRuns.push({
      id: uuid(),
      companyId: ids.company,
      agentId: agent.id,
      status: "succeeded",
      createdAt: minutesAgo(60 - i),
      finishedAt: minutesAgo(59 - i),
      sessionIdBefore: i ? `s${i - 1}` : null,
      sessionIdAfter: `s${i}`,
      usageJson: sub({ provider: "anthropic", model: "claude-sonnet-5", costUsd, sessionReused: i > 0 }),
    }),
  );
  const text = (await captureOutput(() => createCostSync(env.ctx).sessions())).join("\n");
  assert.match(text, /claude_local: 5 resumed runs, 3 cost at least as much .* so the figures are per run/);
  assert.match(text, /\$2\.400 → resumed \$0\.750/);
});

test("the preview lists agents and warns about budget hard stops", async (t) => {
  const env = await syncEnv(t);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  env.db.budgets.policies.push({
    isActive: true,
    metric: "billed_cents",
    scopeType: "agent",
    scopeId: env.codex.id,
    scopeName: "Codex",
    windowKind: "calendar_month_utc",
    amount: 200,
    observedAmount: 0,
    hardStopEnabled: true,
    windowStart: monthStart.toISOString(),
    windowEnd: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)).toISOString(),
  });
  const lines = await captureOutput(() => env.sync.preview());
  const text = lines.join("\n");
  assert.match(text, /Fast\s+1 runs\s+\$\s+5\.04\s+\(1 estimated from tokens\)/);
  assert.match(text, /Codex\s+1 runs\s+\$\s+2\.52/);
  assert.match(text, /Claude\s+3 runs\s+\$\s+4\.24/); // includes the 0.4¢ run, which is carried, not dropped
  assert.match(text, /not synced: 1 runs, model unknown/);
  assert.match(text, /WARNING: this reaches the hard stop/);
  assert.equal(env.db.costEvents.length, 0);
});
