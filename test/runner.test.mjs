// Agents on the Paperclip Runner: adapterType "paperclip_runner", the harness in the
// adapter config. Each feature that tells Claude from Codex must see the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";
import { createCostSync } from "../src/cost-sync.mjs";
import { accountOf, classifyFailure, isClaudeLimitFailure, RUNNER_LIMIT_CODE } from "../src/limits.mjs";
import { CONVERSATION_ADAPTERS } from "../src/release.mjs";
import { harnessOf, onRunner } from "../src/util.mjs";
import * as cmd from "../src/commands.mjs";

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-12T09:00:00Z");
const token = (secretId) => ({ CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId } });
const WEEKLY =
  "Claude run failed: subtype=success: You've hit your org's monthly spend limit · ask your admin to raise it, " +
  "or switch to extra usage · your weekly limit resets Oct 12, 4pm (Europe/London)";

const runnerClaude = (extra = {}) => ({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude", ...extra } });
const runnerCodex = (extra = {}) => ({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", ...extra } });

test("harnessOf: a legacy agent's adapter type, a Runner agent's harness as Paperclip reads it", () => {
  assert.equal(harnessOf({ adapterType: "claude_local" }), "claude_local");
  assert.equal(harnessOf({ adapterType: "process" }), "process");
  assert.equal(harnessOf(runnerClaude()), "claude_local");
  assert.equal(harnessOf({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx" } }), "claude_local", "acpx defaults to Claude");
  assert.equal(harnessOf(runnerCodex()), "codex_local");
  assert.equal(harnessOf({ adapterType: "paperclip_runner", adapterConfig: {} }), "codex_local", "no provider is Codex");
  assert.equal(harnessOf({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } }), "opencode_local");
  assert.equal(harnessOf({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi" } }), "pi_local");
  assert.equal(harnessOf({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "copilot" } }), "acpx:copilot");
  assert.equal(harnessOf(null), null);
  assert.equal(onRunner(runnerClaude()), true);
  assert.equal(onRunner({ adapterType: "claude_local" }), false);
});

test("a Runner agent shares an account with legacy agents on the same login, and its limit runs are recognised", () => {
  const legacy = { id: "a", adapterType: "claude_local", adapterConfig: { env: token("sub-1") } };
  const runner = { id: "b", ...runnerClaude({ env: token("sub-1") }) };
  assert.equal(accountOf(runner), accountOf(legacy));
  const at = iso(T0);
  // The Runner's own code without the provider's limit wording: that agent's limit only.
  const coded = { status: "failed", errorCode: RUNNER_LIMIT_CODE, error: "The provider ended the turn.", finishedAt: at };
  assert.deepEqual([classifyFailure(coded, runner).kind, classifyFailure(coded, runner).scope], ["limit", "agent"]);
  assert.equal(isClaudeLimitFailure(coded, runner), true);
  // Claude's own wording keeps its reset and scope.
  const worded = classifyFailure({ status: "failed", errorCode: RUNNER_LIMIT_CODE, error: WEEKLY, finishedAt: at }, runner);
  assert.equal(worded.kind, "limit");
  assert.equal(worded.scope, "account");
  assert.equal(worded.reset.at, Date.parse("2026-10-12T15:00:00Z"));
  // Codex on the Runner, the same code.
  const codex = { id: "c", ...runnerCodex() };
  assert.equal(classifyFailure(coded, codex).scope, "agent");
  // Another failure on the Runner isn't one.
  assert.equal(classifyFailure({ status: "failed", errorCode: "native_provider_startup_rejected", error: "refused", finishedAt: at }, runner), null);
});

async function limitEnv(t) {
  const clock = { at: T0 };
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1" }, now: () => clock.at });
  t.after(env.close);
  env.db.now = () => clock.at;
  env.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: iso(T0) });
  const state = createStateStore(env.ctx.config.stateFile, { now: () => clock.at });
  return { ...env, state, clock, watchdog: createWatchdog(env.ctx, state) };
}

test("a Runner agent's limit pauses the account's legacy agents and leaves Runner agents to Paperclip, saying so", async (t) => {
  const env = await limitEnv(t);
  const add = (name, shape) => {
    const a = { id: uuid(), companyId: ids.company, name, status: "idle", ...shape };
    env.db.agents.push(a);
    return a;
  };
  const monica = add("Monica", runnerClaude({ env: token("sub-1") }));
  const jared = add("Jared", runnerClaude({ env: token("sub-1") }));
  const gilfoyle = add("Gilfoyle", { adapterType: "claude_local", adapterConfig: { env: token("sub-1") } });
  const other = add("Other", { adapterType: "claude_local", adapterConfig: { env: token("sub-2") } });
  env.db.heartbeatRuns.push({
    id: uuid(), companyId: ids.company, agentId: monica.id, status: "failed", errorCode: RUNNER_LIMIT_CODE, error: WEEKLY,
    createdAt: iso(T0 - 3 * MIN), finishedAt: iso(T0 - 2 * MIN),
  });

  await env.watchdog.tick();
  assert.equal(gilfoyle.status, "paused");
  assert.equal(monica.status, "idle", "Paperclip holds and retries a Runner agent itself");
  assert.equal(jared.status, "idle");
  assert.equal(other.status, "idle");
  const notes = env.db.comments.filter((c) => c.identifier === "ACM-1");
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^Claude usage limit reached: 1 agent paused \(Gilfoyle\)\./);
  assert.match(notes[0].body, /Monica, Jared run on the Paperclip Runner, which holds their work until the reset by itself, so the watchdog leaves them running\./);
});

test("a Runner limit without the provider's wording (a rate limit, say) pauses no one", async (t) => {
  const env = await limitEnv(t);
  const monica = { id: uuid(), companyId: ids.company, name: "Monica", status: "idle", ...runnerClaude({ env: token("sub-1") }) };
  const gilfoyle = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle", adapterType: "claude_local", adapterConfig: { env: token("sub-1") } };
  env.db.agents.push(monica, gilfoyle);
  env.db.heartbeatRuns.push({
    id: uuid(), companyId: ids.company, agentId: monica.id, status: "failed", errorCode: RUNNER_LIMIT_CODE, error: "Rate limited by the provider.",
    createdAt: iso(T0 - 3 * MIN), finishedAt: iso(T0 - 2 * MIN),
  });
  await env.watchdog.tick();
  assert.equal(gilfoyle.status, "idle");
  assert.equal(monica.status, "idle");
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-1").length, 0);
});

test("an account with only Runner agents: nothing is paused and no note is posted", async (t) => {
  const env = await limitEnv(t);
  const monica = { id: uuid(), companyId: ids.company, name: "Monica", status: "idle", ...runnerClaude({ env: token("sub-1") }) };
  env.db.agents.push(monica);
  env.db.heartbeatRuns.push({
    id: uuid(), companyId: ids.company, agentId: monica.id, status: "failed", errorCode: RUNNER_LIMIT_CODE, error: WEEKLY,
    createdAt: iso(T0 - 3 * MIN), finishedAt: iso(T0 - 2 * MIN),
  });
  await env.watchdog.tick();
  assert.equal(monica.status, "idle");
  assert.equal((env.db.lifecycle ?? []).length, 0);
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-1").length, 0);
});

test("a hold left by a Runner agent's paused run is continued like a legacy agent's", async (t) => {
  assert.ok(CONVERSATION_ADAPTERS.has("paperclip_runner"));
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1", WATCHDOG_RESUME_SETTLE_MIN: "0" } });
  t.after(e.close);
  e.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: minutesAgo(600) });
  const implementer = { id: uuid(), companyId: ids.company, name: "Dinesh", status: "idle", ...runnerCodex(), runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } };
  e.db.agents.push(implementer);
  const runId = uuid();
  const issue = {
    id: uuid(), identifier: "ACM-77", companyId: ids.company, title: "Parser fix", status: "in_progress", assigneeAgentId: implementer.id, updatedAt: minutesAgo(30),
    executionBlocker: { recoveryActionId: uuid(), runId, agentId: implementer.id, cause: "legacy_execution_requires_reconciliation", runStatus: "cancelled" },
  };
  e.db.issues.push(issue);
  e.db.issueRuns[issue.id] = [{ runId, agentId: implementer.id, status: "cancelled", errorCode: "agent_paused", createdAt: minutesAgo(2900), finishedAt: minutesAgo(2880) }];
  e.db.heartbeatRuns.push({ id: runId, companyId: ids.company, agentId: implementer.id, status: "cancelled", errorCode: "agent_paused", error: "Cancelled due to agent pause", createdAt: minutesAgo(2900) });
  await createWatchdog(e.ctx, e.state).tick();
  assert.equal(issue.executionBlocker, null, "lifted");
  assert.equal(e.db.continuations?.length, 1);
});

test("cost sync: a Runner subscription run is priced as its harness; a Runner run Paperclip bills as unknown is left alone", async (t) => {
  const env = await setup({});
  t.after(env.close);
  const add = (name, shape) => {
    const a = { id: uuid(), companyId: ids.company, name, status: "idle", ...shape };
    env.db.agents.push(a);
    return a;
  };
  const claude = add("Monica", runnerClaude({ model: "claude-sonnet-5" }));
  const codex = add("Dinesh", runnerCodex({ model: "gpt-5.3-codex" }));
  const issue = { id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "done" };
  env.db.issues.push(issue);
  const run = (agentId, usageJson) => {
    const r = { id: uuid(), companyId: ids.company, agentId, status: "succeeded", createdAt: minutesAgo(40), finishedAt: minutesAgo(30), usageJson, contextSnapshot: { issueId: issue.id } };
    env.db.heartbeatRuns.push(r);
    return r;
  };
  const sub = run(claude.id, { billingType: "subscription_included", costStatus: "reported", provider: "anthropic", biller: "anthropic", model: "claude-sonnet-5", costUsd: 1.234, cacheAdjustedCostUsd: 1.234 });
  const codexTokens = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000, rawInputIncludesCached: false };
  const codexSub = run(codex.id, { billingType: "subscription_included", provider: "openai", biller: "chatgpt", model: "gpt-5.3-codex", ...codexTokens });
  const unknown = run(codex.id, { billingType: "unknown", provider: "openai", biller: "unknown", model: "gpt-5.3-codex", ...codexTokens });
  await createCostSync(env.ctx).tick();
  const events = new Map(env.db.costEvents.map((e) => [e.heartbeatRunId, e]));
  assert.equal(events.get(sub.id).costCents, 123);
  assert.equal(events.get(sub.id).provider, "anthropic");
  assert.equal(events.get(codexSub.id).provider, "openai");
  assert.ok(events.get(codexSub.id).costCents > 0);
  assert.equal(events.has(unknown.id), false);
});

test("pch models names a Runner agent's harness", async (t) => {
  const env = await setup({});
  t.after(env.close);
  env.db.agents.push(
    { id: uuid(), companyId: ids.company, name: "Monica", status: "idle", ...runnerClaude({ model: "claude-sonnet-5-5", effort: "medium" }) },
    { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle", adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } },
  );
  const out = (await captureOutput(() => cmd.models(env.ctx))).join("\n");
  assert.match(out, /^Monica\s+runner:claude\s+claude-sonnet-5-5\s+medium/m);
  assert.match(out, /^Gilfoyle\s+claude_local\s+claude-opus-5-5/m);
});
