import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";
import { compact, render, summarize, tokensOf, wakeOf } from "../src/usage.mjs";

const HOUR = 60 * 60_000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

function agent(db, name, adapterType, model, effort) {
  const a = { id: uuid(), companyId: ids.company, name, status: "idle", adapterType, adapterConfig: { model, effort } };
  db.agents.push(a);
  return a;
}

function runs(db, a, n, { wake = "issue_commented", status = "succeeded", input = 100_000, cached = 1_000_000, output = 5_000, hoursAgo = 24 } = {}) {
  if (a.adapterType === "codex_local") input += cached; // Codex counts cache hits in its input
  for (let i = 0; i < n; i++) {
    db.heartbeatRuns.push({
      id: uuid(), companyId: ids.company, agentId: a.id, status, createdAt: ago(hoursAgo),
      usageJson: { inputTokens: input, cachedInputTokens: cached, outputTokens: output },
      contextSnapshot: { wakeReason: wake }, invocationSource: "automation",
    });
  }
}

// An implementer that polls, a reviewer that's fine, a Codex agent that keeps failing.
function seed(db) {
  const carla = agent(db, "Carla", "claude_local", "claude-opus-4-7", "high");
  const rex = agent(db, "Rex", "claude_local", "claude-sonnet-4-6", "");
  const cody = agent(db, "Cody", "codex_local", "gpt-5.4", "medium");
  runs(db, carla, 40, { wake: "issue_monitor_due" });
  runs(db, carla, 50, { wake: "issue_commented" });
  runs(db, carla, 10, { wake: "issue_blockers_resolved" });
  runs(db, rex, 10, { wake: "execution_review_requested", input: 20_000, cached: 200_000, output: 2_000 });
  runs(db, cody, 6, { status: "failed", input: 1_000, cached: 0, output: 0 });
  runs(db, cody, 2, { status: "running", input: 0, cached: 0, output: 0 }); // not finished: not counted
  runs(db, cody, 4, { wake: "issue_assigned" });
  // Older than the window: not counted.
  runs(db, carla, 30, { wake: "issue_monitor_due", hoursAgo: 24 * 10 });
  db.costEvents.push({ id: uuid(), companyId: ids.company, agentId: carla.id, costCents: 123_456, occurredAt: ago(30) });
  return { carla, rex, cody };
}

test("pch usage prints per-agent totals, what woke them, and the agents worth a look", async (t) => {
  const env = await setup();
  t.after(env.close);
  seed(env.db);
  const lines = await captureOutput(() => cmd.usage(env.ctx, { days: 7 }));
  const text = lines.join("\n");
  assert.match(text, /^Usage over the last 7 days/);
  assert.match(text, /^Agent\s+Runs\s+Failed\s+Input\s+Cached\s+Output\s+Cost\s+Model\s+Effort$/m);
  assert.match(text, /^Carla\s+100\s+0\s+10\.0M\s+100\.0M\s+500k\s+\$1234\.56\s+claude-opus-4-7\s+high$/m);
  assert.match(text, /^Rex\s+10\s+0\s+200k\s+2\.0M\s+20k\s+-\s+claude-sonnet-4-6\s+-$/m);
  // Codex counted cached input in its input: 1,000 fresh + 1,000,000 cached per run, not 1,001,000.
  assert.match(text, /^Cody\s+10\s+6\s+406k\s+4\.0M\s+20k\s+-\s+gpt-5\.4\s+medium$/m);
  assert.match(text, /^  Carla: issue_commented 50 \(50%\), issue_monitor_due 40 \(40%\), issue_blockers_resolved 10 \(10%\)$/m);
  assert.match(text, /Worth a look:/);
  assert.match(text, /- Carla polls: 40% of its runs \(40 of 100\) were its own monitor's wakes\./);
  assert.match(text, /- Cody: 60% of its runs failed \(6 of 10\)/);
  // Two agents on a provider: one always has half. Not flagged.
  assert.doesNotMatch(text, /used \d+% of the/);
  assert.doesNotMatch(text, /Rex polls/);
  // Read-only.
  assert.equal(env.fake.requests.filter((r) => r.method !== "GET").length, 0);
});

test("--agent narrows it to one agent; an unknown name says so", async (t) => {
  const env = await setup();
  t.after(env.close);
  seed(env.db);
  const lines = await captureOutput(() => cmd.usage(env.ctx, { agent: "rex" }));
  assert.ok(lines.some((l) => /^Rex\s+10/.test(l)));
  assert.ok(!lines.some((l) => /^Carla\s/.test(l)));
  assert.ok(lines.includes("Nothing stands out."));
  assert.deepEqual(await captureOutput(() => cmd.usage(env.ctx, { agent: "Nobody" })), ["No agent called Nobody."]);
});

test("one agent far above an even share of its provider's tokens is flagged", () => {
  const agents = ["A", "B", "C", "D", "E"].map((name) => ({ id: name, name, adapterType: "claude_local", adapterConfig: {} }));
  const run = (agentId, input) => ({ agentId, status: "succeeded", createdAt: new Date().toISOString(), usageJson: { inputTokens: input } });
  const { flags } = summarize({ agents, runs: [run("A", 1000), run("B", 100), run("C", 100), run("D", 100), run("E", 100)], since: 0 });
  assert.deepEqual(flags.map((f) => f.text), ["A used 71% of the Anthropic tokens."]);
});

test("costs Paperclip refuses are said, not shown as $0; a refused run list is an error", async (t) => {
  const env = await setup();
  t.after(env.close);
  seed(env.db);
  env.fake.fail("GET", `/api/companies/${ids.company}/costs/by-agent`, 403, { times: -1, body: { error: "Forbidden" } });
  const lines = await captureOutput(() => cmd.usage(env.ctx));
  assert.ok(lines.some((l) => /^Paperclip didn't give the costs \(.*Forbidden.*\): the Cost column is empty\.$/.test(l)));
  assert.ok(!lines.some((l) => /\$0 for subscription runs/.test(l)));
  env.fake.fail("GET", `/api/companies/${ids.company}/heartbeat-runs`, 403, { times: -1, body: { error: "Forbidden" } });
  await assert.rejects(() => cmd.usage(env.ctx), /Forbidden/);
});

test("wakeOf, compact and a quiet company", () => {
  assert.deepEqual(tokensOf({ usageJson: { inputTokens: 1_100, cachedInputTokens: 1_000 } }, "codex_local"), { input: 100, cached: 1_000, output: 0 });
  assert.deepEqual(tokensOf({ usageJson: { inputTokens: 100, cachedInputTokens: 1_000 } }, "codex_local"), { input: 100, cached: 1_000, output: 0 });
  assert.deepEqual(tokensOf({ usageJson: { inputTokens: 1_100, cachedInputTokens: 1_000 } }, "claude_local"), { input: 1_100, cached: 1_000, output: 0 });
  assert.equal(compact(999_950), "1.0M");
  assert.equal(wakeOf({ contextSnapshot: { wakeReason: "issue_monitor_due" } }), "issue_monitor_due");
  assert.equal(wakeOf({ invocationSource: "timer" }), "timer");
  assert.equal(compact(1_234_567), "1.2M");
  assert.equal(compact(56_000), "56k");
  assert.equal(compact(999), "999");
  assert.deepEqual(summarize({ agents: [{ id: "a", name: "A" }], runs: [], since: 0 }), { rows: [], flags: [] });
  assert.deepEqual(render({ rows: [], flags: [] }, { days: 7 }), ["No finished runs in the last 7 days."]);
});
