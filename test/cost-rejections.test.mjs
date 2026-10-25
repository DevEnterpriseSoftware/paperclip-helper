// Cost events Paperclip rejects: what is logged, the costStatus older releases
// refuse, and `pch costs --retry-skipped`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { COST_STATUSES, OLD_COST_STATUSES, costEventIssues, ids } from "./fake-paperclip.mjs";
import { createCostSync, retryFileOf } from "../src/cost-sync.mjs";
import { BUILTIN_PRICES } from "../src/prices.mjs";
import { readJson, writeJson } from "../src/store.mjs";
import * as commands from "../src/commands.mjs";

// Three Codex runs a Paperclip 2026.1012.0 refused the cost events of (400:
// Validation error), with their usage as it recorded them: ChatGPT plan, no cost
// reported, about 90% of the input read from cache, no fast mode. Only the times
// are moved to just now, so they are past the settle window and inside the price table.
const AGENT = "fc4847f2-ec64-425f-8d03-026170d0fbe2";
const ISSUE = "7a6c4e1b-ec62-4801-84f7-0c1b1935b783";
const usage = (input, cached, output) => ({
  model: "gpt-6.1-sol",
  biller: "chatgpt",
  provider: "openai",
  costStatus: "unpriced",
  billingType: "subscription_included",
  inputTokens: input,
  rawInputTokens: input,
  cachedInputTokens: cached,
  rawCachedInputTokens: cached,
  outputTokens: output,
  rawOutputTokens: output,
  usageSource: "per_run",
  freshSession: true,
});
const REJECTED = [
  { id: "137e9527-5163-4be3-ab4a-7a73fdadbbf1", ago: 50, usageJson: usage(894_773, 810_752, 3_712) },
  { id: "767ee7e9-1444-4891-b39b-2d18989b9236", ago: 40, usageJson: usage(406_398, 332_288, 2_060) },
  { id: "60e17fd8-bbeb-4f13-9a6d-e5107c3436de", ago: 30, usageJson: usage(946_515, 852_864, 3_432) },
];
// What their tokens cost at gpt-6.1-sol's list price ($2 input, $0.10 cached, $10 output per M):
// fresh input (input − cached) + cache reads + output.
// 137e9527: 84,021 × 2 + 810,752 × 0.1 + 3,712 × 10 = $0.2862372 (and so on).
const EXACT_USD = { "137e9527-5163-4be3-ab4a-7a73fdadbbf1": 0.2862372, "767ee7e9-1444-4891-b39b-2d18989b9236": 0.2020488, "60e17fd8-bbeb-4f13-9a6d-e5107c3436de": 0.3069084 };

function seed(db) {
  db.agents.push({ id: AGENT, companyId: ids.company, name: "Carla", adapterType: "codex_local", adapterConfig: { model: "gpt-6.1-sol" }, status: "idle" });
  db.issues.push({ id: ISSUE, identifier: "ACM-7", companyId: ids.company, status: "in_progress" });
  for (const r of REJECTED) {
    db.heartbeatRuns.push({
      id: r.id,
      companyId: ids.company,
      agentId: AGENT,
      status: "succeeded",
      createdAt: minutesAgo(r.ago + 10),
      finishedAt: minutesAgo(r.ago),
      usageJson: r.usageJson,
      resultJson: { summary: "done" },
      contextSnapshot: { issueId: ISSUE },
    });
    // The Codex CLI invocation: no service_tier="fast", so no fast mode.
    db.runEvents[r.id] = [{ eventType: "adapter.invoke", payload: { commandArgs: ["exec", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"'] } }];
  }
}

async function env(t, statuses) {
  const e = await setup();
  t.after(e.close);
  e.db.costStatuses = statuses;
  seed(e.db);
  return { ...e, sync: createCostSync(e.ctx) };
}

const logged = (e, level, re) => e.logs.filter((l) => l.level === level && re.test(l.msg));
const byRun = (db) => new Map(db.costEvents.map((ev) => [ev.heartbeatRunId, ev]));

test("the three rejected Codex runs: their events pass Paperclip's cost schema except costStatus, which 2026.1012.0 refuses", async (t) => {
  const e = await env(t, OLD_COST_STATUSES);
  for (const r of REJECTED) {
    const run = e.db.heartbeatRuns.find((x) => x.id === r.id);
    const agent = e.db.agents.find((a) => a.id === AGENT);
    const verdict = await e.sync.evaluate(run, agent, BUILTIN_PRICES, Date.now());
    assert.equal(verdict.basis, "estimated");
    assert.ok(Math.abs(verdict.usd - EXACT_USD[r.id]) < 1e-9, `${r.id}: ${verdict.usd}`);
    const body = { ...verdict.post, costCents: Math.floor(verdict.usd * 100) };
    // None of the suspects: no negative tokens (the event carries none), occurredAt in UTC with a Z,
    // no pricing provenance, the run's own model.
    assert.deepEqual([body.inputTokens, body.cachedInputTokens, body.outputTokens], [0, 0, 0]);
    assert.match(body.occurredAt, /Z$/);
    assert.equal(body.pricingProvenance, undefined);
    assert.equal(body.model, "gpt-6.1-sol");
    assert.deepEqual(costEventIssues(body, COST_STATUSES), [], "a Paperclip with \"estimated\" takes it as it is");
    assert.deepEqual(
      costEventIssues(body, OLD_COST_STATUSES).map((i) => i.path.join(".")),
      ["costStatus"],
      "2026.1012.0 refuses exactly one field: costStatus \"estimated\"",
    );
  }
});

test("a Paperclip without costStatus \"estimated\": estimated costs are posted as \"reported\", said once, nothing skipped", async (t) => {
  const e = await env(t, OLD_COST_STATUSES);
  await e.sync.tick();
  const posted = byRun(e.db);
  assert.equal(posted.size, 3);
  // Oldest first, with the fraction of a cent carried: 28.62¢ → 28 (.62 on), 20.20 + .62 → 20 (.83 on), 30.69 + .83 → 31.
  assert.deepEqual(REJECTED.map((r) => posted.get(r.id).costCents), [28, 20, 31]);
  for (const ev of posted.values()) {
    assert.equal(ev.costStatus, "reported");
    assert.equal(ev.billingType, "subscription_included");
    assert.equal(ev.issueId, ISSUE);
  }
  assert.equal(logged(e, "info", /doesn't take costStatus "estimated"/).length, 1, "said once, at the first post");
  assert.equal(logged(e, "error", /rejected/).length, 0);
  assert.equal(logged(e, "warn", /rejected/).length, 0);
  const state = readJson(e.ctx.config.costStateFile, {});
  assert.deepEqual(state.skipped, {});
  assert.deepEqual(state.inflight, {});
});

test("a Paperclip with costStatus \"estimated\" gets it, with no fallback", async (t) => {
  const e = await env(t, COST_STATUSES);
  await e.sync.tick();
  assert.deepEqual([...byRun(e.db).values()].map((ev) => ev.costStatus), ["estimated", "estimated", "estimated"]);
  assert.equal(logged(e, "info", /doesn't take costStatus/).length, 0);
});

test("a rejected event: Paperclip's whole answer and the post's field names at warn, once per run; the issues in the skip reason", async (t) => {
  const e = await env(t, ["unpriced"]); // refuses "estimated" and "reported" alike
  await e.sync.tick();
  assert.equal(e.db.costEvents.length, 0);
  const warns = logged(e, "warn", /Paperclip's answer to a rejected cost event/);
  assert.equal(warns.length, 3, "one per run");
  const first = warns.find((w) => w.run === REJECTED[0].id);
  assert.equal(first.status, 400);
  assert.equal(first.response.error, "Validation error");
  assert.deepEqual(first.response.details.map((i) => i.path), [["costStatus"]]);
  assert.deepEqual(first.response.details[0].values, ["unpriced"]);
  assert.deepEqual(first.fields, [
    "idempotencyKey", "agentId", "heartbeatRunId", "issueId", "provider", "biller", "billingType",
    "costStatus", "model", "inputTokens", "cachedInputTokens", "outputTokens", "costCents", "occurredAt",
  ]);
  const errors = logged(e, "error", /Paperclip rejected a cost event/);
  assert.equal(errors.length, 3);
  assert.match(errors[0].error, /400: Validation error \(costStatus: Invalid option: expected one of "unpriced"\)/);
  const state = readJson(e.ctx.config.costStateFile, {});
  assert.match(state.skipped[REJECTED[0].id], /^rejected: .*costStatus: Invalid option/);

  // Retried and rejected again in the same process: the answer isn't logged a second time.
  e.sync.queueRetries({ print: () => {} });
  await e.sync.tick();
  assert.equal(logged(e, "warn", /Paperclip's answer to a rejected cost event/).length, 3);
  assert.equal(logged(e, "error", /Paperclip rejected a cost event/).length, 6);
});

test("costs --retry-skipped: rejected runs are posted on the service's next pass, even one the run list no longer shows", async (t) => {
  const e = await env(t, ["unpriced"]);
  await e.sync.tick(); // all three rejected and skipped
  assert.equal(Object.keys(readJson(e.ctx.config.costStateFile, {}).skipped).length, 3);
  // The oldest has since dropped out of Paperclip's latest 1,000 runs.
  e.db.heartbeatRuns.find((r) => r.id === REJECTED[0].id).unlisted = true;
  // A later pass doesn't post skipped runs by itself.
  e.db.costStatuses = OLD_COST_STATUSES;
  await e.sync.tick();
  assert.equal(e.db.costEvents.length, 0);

  // The command, as `pch costs --retry-skipped` runs it: in its own process, with the service still running.
  writeJson(e.ctx.config.statusFile, { version: "test", startedAt: minutesAgo(60), heartbeatAt: new Date().toISOString() });
  const lines = await captureOutput(() => commands.costs(e.ctx, { retrySkipped: true }));
  assert.match(lines[0], /^3 skipped runs are queued to be posted again:/);
  assert.ok(lines.some((l) => l.includes(REJECTED[0].id) && /rejected: .*costStatus/.test(l)));
  assert.match(lines.at(-1), /The service posts them on its next cost-sync pass \(every 15 min\)/);
  assert.deepEqual(readJson(retryFileOf(e.ctx.config), null).runs.sort(), REJECTED.map((r) => r.id).sort());
  const before = readJson(e.ctx.config.costStateFile, {});
  assert.equal(Object.keys(before.skipped).length, 3, "the command leaves the state file to the service");

  // The service's next pass.
  const service = createCostSync(e.ctx);
  await service.tick();
  assert.deepEqual(REJECTED.map((r) => byRun(e.db).get(r.id)?.costCents), [28, 20, 31]);
  const after = readJson(e.ctx.config.costStateFile, {});
  assert.deepEqual(after.skipped, {});
  assert.deepEqual(after.retry, {});
  assert.equal(fs.existsSync(retryFileOf(e.ctx.config)), false, "the request is taken");
  assert.equal(logged(e, "info", /posting skipped runs again/).at(-1).runs, 3);

  // Nothing is posted twice.
  await service.tick();
  assert.equal(e.db.costEvents.length, 3);
});

test("costs --retry-skipped keeps a run whose post may have been recorded, unless Paperclip keeps idempotency keys", async (t) => {
  const e = await env(t, COST_STATUSES);
  const [a, b, c] = REJECTED.map((r) => r.id);
  writeJson(e.ctx.config.costStateFile, {
    version: 2,
    companies: {},
    inflight: {},
    carry: {},
    idempotent: false,
    skipped: { [a]: "rejected: POST … → 400: Validation error", [b]: "unknown outcome (the post may have been recorded)", [c]: "unknown outcome after 5 retries" },
  });
  const lines = await captureOutput(() => commands.costs(e.ctx, { retrySkipped: true }));
  assert.match(lines[0], /^1 skipped run is queued/);
  assert.ok(lines.some((l) => /^2 skipped runs stay skipped:/.test(l)));
  assert.ok(lines.some((l) => l.includes(b) && /could count it twice/.test(l)));
  assert.match(lines.at(-1), /The service isn't running: they are posted on its first pass once it starts/);
  await e.sync.tick();
  assert.deepEqual([...byRun(e.db).keys()], [a]);
  assert.deepEqual(Object.keys(readJson(e.ctx.config.costStateFile, {}).skipped).sort(), [b, c].sort());

  // With keys honoured, posting one again can't count it twice: all of them go.
  const state = readJson(e.ctx.config.costStateFile, {});
  writeJson(e.ctx.config.costStateFile, { ...state, idempotent: true });
  const again = await captureOutput(() => commands.costs(e.ctx, { retrySkipped: true }));
  assert.match(again[0], /^2 skipped runs are queued/);
  await e.sync.tick();
  assert.equal(e.db.costEvents.length, 3);
});

test("costs --retry-skipped with nothing skipped, and with another costs option", async (t) => {
  const e = await env(t, COST_STATUSES);
  const lines = await captureOutput(() => commands.costs(e.ctx, { retrySkipped: true }));
  assert.deepEqual(lines, ["No skipped runs: nothing to post again."]);
  assert.equal(fs.existsSync(retryFileOf(e.ctx.config)), false);
  await assert.rejects(() => commands.costs(e.ctx, { retrySkipped: true, audit: true }), /one at a time/);
});
