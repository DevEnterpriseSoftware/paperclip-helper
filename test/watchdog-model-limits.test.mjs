// Watchdog 16 and one model's own limit: Max and Ultra plans have a weekly limit
// across all models and a separate one for Fable. An agent on Fable that hits the
// Fable limit pauses that subscription's Fable agents only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, setup } from "./helpers.mjs";
import * as cmd from "../src/commands.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";
import { classifyFailure, isClaudeLimitFailure, limitKeyOf, modelFamily } from "../src/limits.mjs";
import { CLAUDE_MESSAGES, CLAUDE_MODEL_MESSAGES } from "./fixtures/limit-messages.mjs";

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
// Monday 12 October 2026, 10:00 in London (09:00 UTC).
const T0 = Date.parse("2026-10-12T09:00:00Z");
const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
// ASSUMED wording (test/fixtures/limit-messages.mjs): replace with the real text once seen.
const FABLE_LIMIT = "Claude run failed: subtype=success: You've hit your Fable weekly limit · resets Oct 14, 4pm (Europe/London)";
const ALL_MODELS =
  "Claude run failed: subtype=success: You've hit your org's monthly spend limit · ask your admin to raise it, " +
  "or switch to extra usage · your weekly limit resets Oct 12, 4pm (Europe/London)";
const secret = (secretId) => ({ CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId } });

function claude(db, name, model, env = secret("sub-1")) {
  const a = { id: uuid(), companyId: ids.company, name, status: "idle", adapterType: "claude_local", adapterConfig: { env, ...(model ? { model } : {}) } };
  db.agents.push(a);
  return a;
}

function failedRun(db, agent, { at, error = FABLE_LIMIT, errorCode = "claude_transient_upstream" } = {}) {
  const run = { id: uuid(), companyId: ids.company, agentId: agent.id, status: "failed", errorCode, error, createdAt: iso(at - MIN), finishedAt: iso(at) };
  db.heartbeatRuns.push(run);
  return run;
}

async function limitEnv(t, extra = {}) {
  const clock = { at: T0 };
  const env = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1", ...extra }, now: () => clock.at });
  t.after(env.close);
  env.db.now = () => clock.at;
  env.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: iso(T0) });
  const state = createStateStore(env.ctx.config.stateFile, { now: () => clock.at });
  return { ...env, state, clock, watchdog: createWatchdog(env.ctx, state) };
}

// Two Fable and two Opus agents on one subscription.
function team(db) {
  return {
    fable1: claude(db, "Fable One", FABLE),
    fable2: claude(db, "Fable Two", FABLE),
    opus1: claude(db, "Opus One", OPUS),
    opus2: claude(db, "Opus Two", OPUS),
  };
}

const lifecycle = (env, action) => (env.db.lifecycle ?? []).filter((l) => l.action === action).map((l) => env.db.agents.find((a) => a.id === l.agentId).name);
const notes = (env) => env.db.comments.filter((c) => c.identifier === "ACM-1");
const statuses = (agents) => Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, a.status]));

test("the Claude recogniser: a model's own limit is scoped to that model; limit text naming no model stays the account's", () => {
  const agent = { id: "c", adapterType: "claude_local", adapterConfig: { model: FABLE } };
  for (const [name, error, expected] of CLAUDE_MODEL_MESSAGES) {
    const verdict = classifyFailure({ status: "failed", errorCode: "claude_transient_upstream", error, finishedAt: iso(T0) }, agent);
    assert.equal(verdict?.kind, expected.kind, name);
    assert.equal(verdict.scope, expected.scope, name);
    assert.equal(verdict.family, expected.family, name);
    assert.equal(verdict.model, FABLE, `${name}: the agent's own model`);
    assert.equal(verdict.what, expected.what, name);
  }
  for (const [name, error, expected] of CLAUDE_MESSAGES) {
    const verdict = classifyFailure({ status: "failed", errorCode: "provider_quota", error, finishedAt: iso(T0) }, agent);
    assert.equal(verdict?.kind, expected.kind, name);
    if (expected.kind === "limit") assert.equal(verdict.scope, "account", `${name}: names no model`);
  }
  // The reset is read as before.
  const reset = classifyFailure({ status: "failed", errorCode: "claude_transient_upstream", error: FABLE_LIMIT, finishedAt: iso(T0) }, agent).reset;
  assert.deepEqual(reset, { at: Date.parse("2026-10-14T15:00:00Z"), timeZone: "Europe/London" });
  // An agent on the default model: the model the message names.
  const bare = classifyFailure({ status: "failed", errorCode: "claude_transient_upstream", error: FABLE_LIMIT, finishedAt: iso(T0) }, { id: "d", adapterType: "claude_local", adapterConfig: {} });
  assert.equal(bare.model, "Fable");
  assert.equal(bare.family, "fable");
  // Another model's own limit is named by the model.
  const opus = classifyFailure({ status: "failed", errorCode: "claude_transient_upstream", error: "You've reached your weekly limit for claude-opus-5-5.", finishedAt: iso(T0) }, agent);
  assert.equal(opus.what, "weekly limit for claude-opus-5-5");
  assert.equal(opus.family, "opus");
});

test("isClaudeLimitFailure is true for the account's limit and a model's own; the key is the model's on that account", () => {
  const agent = { id: "c", adapterType: "claude_local", adapterConfig: { env: secret("sub-1"), model: FABLE } };
  const run = (error) => ({ status: "failed", errorCode: "claude_transient_upstream", error, finishedAt: iso(T0) });
  assert.equal(isClaudeLimitFailure(run(FABLE_LIMIT), agent), true);
  assert.equal(isClaudeLimitFailure(run(ALL_MODELS), agent), true);
  assert.equal(limitKeyOf(classifyFailure(run(FABLE_LIMIT), agent), agent), "model:CLAUDE_CODE_OAUTH_TOKEN:secret:sub-1:fable");
  assert.equal(limitKeyOf(classifyFailure(run(ALL_MODELS), agent), agent), "CLAUDE_CODE_OAUTH_TOKEN:secret:sub-1");
  assert.deepEqual([FABLE, "claude-3-5-sonnet-20241022", "opus", "sonnet[1m]", "Fable", ""].map(modelFamily), ["fable", "sonnet", "opus", "sonnet", "fable", null]);
});

test("the Fable limit pauses the subscription's Fable agents only, with one note, and resumes them at the reset", async (t) => {
  const env = await limitEnv(t);
  const agents = team(env.db);
  failedRun(env.db, agents.fable1, { at: T0 - MIN });

  await env.watchdog.tick();
  assert.deepEqual(statuses(agents), { fable1: "paused", fable2: "paused", opus1: "idle", opus2: "idle" });
  assert.equal(notes(env).length, 1);
  assert.match(
    notes(env)[0].body,
    /^Claude Fable weekly limit reached: 2 agents on claude-fable-5-2 paused \(Fable One, Fable Two\)\. The limit resets Wed 14 Oct, 16:00 \(Europe\/London\); the watchdog resumes them at Wed 14 Oct, 16:05 \(Europe\/London\)\. Claude agents on other models keep running\./,
  );
  assert.ok(env.logs.some((l) => /hit its Fable weekly limit; pausing its agents on claude-fable-5-2/.test(l.msg)));
  // The full text of the limit failure, for checking the wording against.
  assert.ok(env.logs.some((l) => l.level === "debug" && /failed on a usage limit/.test(l.msg) && l.error === FABLE_LIMIT && l.scope === "model"));

  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(notes(env).length, 1, "told once");
  assert.deepEqual(statuses(agents), { fable1: "paused", fable2: "paused", opus1: "idle", opus2: "idle" });

  env.clock.at = Date.parse("2026-10-14T15:06:00Z");
  await env.watchdog.tick();
  assert.deepEqual(statuses(agents), { fable1: "idle", fable2: "idle", opus1: "idle", opus2: "idle" });
  assert.deepEqual(lifecycle(env, "resume").sort(), ["Fable One", "Fable Two"]);
});

test("the all-models weekly limit still pauses every agent on the subscription", async (t) => {
  const env = await limitEnv(t);
  const agents = team(env.db);
  failedRun(env.db, agents.fable1, { at: T0 - MIN, error: ALL_MODELS });
  await env.watchdog.tick();
  assert.deepEqual(statuses(agents), { fable1: "paused", fable2: "paused", opus1: "paused", opus2: "paused" });
  assert.match(notes(env)[0].body, /^Claude usage limit reached: 4 agents paused/);
  assert.doesNotMatch(notes(env)[0].body, /other models/);
});

test("the Fable limit leaves a Fable agent on another subscription alone", async (t) => {
  const env = await limitEnv(t);
  const agents = team(env.db);
  const elsewhere = claude(env.db, "Fable Elsewhere", FABLE, secret("sub-2"));
  failedRun(env.db, agents.fable2, { at: T0 - MIN });
  await env.watchdog.tick();
  assert.equal(agents.fable1.status, "paused");
  assert.equal(elsewhere.status, "idle");
});

test("an agent on the default model is paused for the Fable limit only when it failed on it itself", async (t) => {
  const env = await limitEnv(t);
  const agents = team(env.db);
  const bare = claude(env.db, "Default Model");
  const otherBare = claude(env.db, "Default Too");
  failedRun(env.db, bare, { at: T0 - MIN });
  await env.watchdog.tick();
  assert.deepEqual(statuses(agents), { fable1: "paused", fable2: "paused", opus1: "idle", opus2: "idle" });
  assert.equal(bare.status, "paused");
  assert.equal(otherBare.status, "idle");
});

test("pch why on a paused Fable agent names the Fable limit and its reset", async (t) => {
  const env = await limitEnv(t);
  const agents = team(env.db);
  failedRun(env.db, agents.fable1, { at: T0 - MIN });
  await env.watchdog.tick();
  env.db.issues.push({ id: uuid(), identifier: "ACM-2", companyId: ids.company, status: "todo", title: "Work", assigneeAgentId: agents.fable2.id, updatedAt: iso(T0) });
  env.state.save({ force: true });
  const why = (await captureOutput(() => cmd.why(env.ctx, "ACM-2"))).join("\n");
  assert.match(why, /Paused by the watchdog at a usage limit \(the Claude Fable weekly limit, which resets Wed 14 Oct, 16:00 \(Europe\/London\)\); resumed at Wed 14 Oct, 16:05 \(Europe\/London\)/);
  assert.match(why, /The watchdog paused Fable Two because its Claude Fable weekly limit was reached/);
  assert.match(why, /agents on other models keep running/);
});

test("a dry run says it would pause the Fable agents for the Fable limit, and changes nothing", async (t) => {
  const env = await limitEnv(t, { DRY_RUN: "true" });
  const agents = team(env.db);
  failedRun(env.db, agents.fable1, { at: T0 - MIN });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.deepEqual(statuses(agents), { fable1: "idle", fable2: "idle", opus1: "idle", opus2: "idle" });
  assert.equal(env.db.comments.length, 0);
  const would = env.logs.filter((l) => /would pause an agent for the Claude Fable weekly limit/.test(l.msg)).map((l) => l.agent);
  assert.deepEqual(would.sort(), ["Fable One", "Fable Two"]);
  assert.equal([...env.state.nudges.entries()].filter(([k]) => k.startsWith("limit:")).length, 0);
});

test("a Fable agent switched to another model while paused is resumed at the next tick; the others wait for the reset", async (t) => {
  const env = await limitEnv(t);
  const agents = team(env.db);
  failedRun(env.db, agents.fable1, { at: T0 - MIN });
  await env.watchdog.tick();
  assert.equal(agents.fable1.status, "paused");

  agents.fable1.adapterConfig.model = OPUS;
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(agents.fable1.status, "idle");
  assert.equal(agents.fable2.status, "paused");
  assert.ok(env.logs.some((l) => /is on another model now; resuming it/.test(l.msg) && l.agent === "Fable One"));

  // Not paused again, though its own failed run is still in the list.
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(agents.fable1.status, "idle");
  assert.deepEqual(lifecycle(env, "pause").filter((n) => n === "Fable One").length, 1);
});
