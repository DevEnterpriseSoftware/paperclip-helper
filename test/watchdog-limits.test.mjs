import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";
import { isClaudeLimitFailure, parseReset, resetLabel, subscriptionOf } from "../src/limits.mjs";

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
// Monday 12 October 2026, 10:00 in London (09:00 UTC).
const T0 = Date.parse("2026-10-12T09:00:00Z");
const WEEKLY =
  "Claude run failed: subtype=success: You've hit your org's monthly spend limit · ask your admin to raise it, " +
  "or switch to extra usage · your weekly limit resets Oct 12, 4pm (Europe/London)";
const secret = (secretId) => ({ CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId } });

function claude(db, name, env = secret("sub-1"), extra = {}) {
  const a = { id: uuid(), companyId: ids.company, name, status: "idle", adapterType: "claude_local", adapterConfig: { env }, ...extra };
  db.agents.push(a);
  return a;
}

function failedRun(db, agent, { at, error = WEEKLY, errorCode = "claude_transient_upstream" } = {}) {
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
  // The state file forgets records a week old by the same (fixed) clock.
  const state = createStateStore(env.ctx.config.stateFile, { now: () => clock.at });
  return { ...env, state, clock, watchdog: createWatchdog(env.ctx, state) };
}

const lifecycle = (env, action) => (env.db.lifecycle ?? []).filter((l) => l.action === action).map((l) => env.db.agents.find((a) => a.id === l.agentId).name);

test("a usage limit pauses the account's idle agents, waits for busy ones, and tells the board once", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const reviewer = claude(env.db, "Reviewer");
  const busy = claude(env.db, "Architect");
  const other = claude(env.db, "Other account", secret("sub-2"));
  const codex = { id: uuid(), companyId: ids.company, name: "Codex Engineer", status: "idle", adapterType: "codex_local", adapterConfig: {} };
  env.db.agents.push(codex);
  failedRun(env.db, engineer, { at: T0 - 2 * MIN });
  env.db.heartbeatRuns.push({ id: uuid(), companyId: ids.company, agentId: busy.id, status: "running", createdAt: iso(T0 - MIN) });

  await env.watchdog.tick();
  assert.deepEqual(lifecycle(env, "pause").sort(), ["Engineer", "Reviewer"]);
  assert.equal(engineer.status, "paused");
  assert.equal(busy.status, "idle");
  assert.equal(other.status, "idle");
  assert.equal(codex.status, "idle");
  const notes = env.db.comments.filter((c) => c.identifier === "ACM-1");
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^Claude usage limit reached: 2 agents paused \(Engineer, Reviewer\), and 1 more once its current run ends \(Architect\)\. The limit resets Mon 12 Oct, 16:00 \(Europe\/London\); the watchdog resumes them at Mon 12 Oct, 16:05 \(Europe\/London\)\. Codex agents are unaffected/);
  assert.match(notes[0].body, /_Paperclip Helper watchdog\._$/);

  // The busy one's run ends (it fails on the limit too): it is paused then, with no second note.
  env.db.heartbeatRuns.find((r) => r.agentId === busy.id).status = "failed";
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(busy.status, "paused");
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-1").length, 1);
  assert.equal(other.status, "idle");
});

test("the agents are resumed at the reset plus the grace, not before, and the old failures don't pause them again", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  failedRun(env.db, engineer, { at: T0 - 2 * MIN });
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");

  env.clock.at = Date.parse("2026-10-12T15:04:00Z"); // 16:04 London: the reset, but within the 5 minutes' grace
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  env.clock.at = Date.parse("2026-10-12T15:05:00Z");
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");
  assert.deepEqual(lifecycle(env, "resume"), ["Engineer"]);
  env.clock.at += 10 * MIN;
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");
  assert.equal(lifecycle(env, "pause").length, 1);
  assert.equal(env.watchdog.stats.limitPauses, 1);
  assert.equal(env.watchdog.stats.limitResumes, 1);
});

test("an agent a person paused stays paused: before the limit, or again during it", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const reviewer = claude(env.db, "Reviewer");
  const manual = claude(env.db, "Paused by you", secret("sub-1"), { status: "paused", pausedAt: iso(T0 - 60 * MIN), pauseReason: "manual" });
  failedRun(env.db, engineer, { at: T0 - 2 * MIN });
  await env.watchdog.tick();
  assert.deepEqual(lifecycle(env, "pause").sort(), ["Engineer", "Reviewer"]);

  // You resume the reviewer and pause it again yourself during the limit.
  reviewer.pausedAt = iso(T0 + 30 * MIN);
  env.clock.at = Date.parse("2026-10-12T15:10:00Z");
  await env.watchdog.tick();
  assert.deepEqual(lifecycle(env, "resume"), ["Engineer"]);
  assert.equal(reviewer.status, "paused");
  assert.equal(manual.status, "paused");
});

test("a limit message with no reset time pauses for an hour, then looks again", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  failedRun(env.db, engineer, { at: T0 - 2 * MIN, error: "Claude run failed: 5-hour limit reached." });
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  assert.match(env.db.comments.find((c) => c.identifier === "ACM-1").body, /Claude didn't say when the limit resets, so the watchdog resumes them at Mon 12 Oct, 10:03 \(UTC\) to try again/);
  env.clock.at = T0 + 63 * MIN; // failure + 1 hour + 5 minutes' grace
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");

  // Still at the limit: its next run fails the same way. Paused again, for two hours this
  // time, and the board isn't told a second time about the same limit.
  failedRun(env.db, engineer, { at: env.clock.at + MIN, error: "Claude run failed: 5-hour limit reached." });
  env.clock.at += 2 * MIN;
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  assert.equal(env.db.comments.filter((c) => c.identifier === "ACM-1").length, 1);
  env.clock.at += 110 * MIN;
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  env.clock.at += 20 * MIN;
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");
});

test("a transient failure, a Codex quota failure, or an old limit already reset does nothing", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const codex = { id: uuid(), companyId: ids.company, name: "Codex", status: "idle", adapterType: "codex_local", adapterConfig: {} };
  env.db.agents.push(codex);
  failedRun(env.db, engineer, { at: T0 - MIN, error: "Claude exited with code 143" });
  failedRun(env.db, codex, { at: T0 - MIN, errorCode: "provider_quota", error: "Selected model is at capacity. Please try a different model." });
  // A limit hit yesterday that reset at 16:00 yesterday.
  failedRun(env.db, engineer, { at: T0 - 24 * 60 * MIN, error: "You've hit your limit · resets 4pm (Europe/London)" });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(lifecycle(env, "pause").length, 0);
  assert.equal(env.db.comments.length, 0);
});

test("newer Paperclip's provider_quota code counts for a Claude agent; dry run and WATCHDOG_LIMIT_PAUSE=false pause nothing", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  failedRun(env.db, engineer, { at: T0 - MIN, errorCode: "provider_quota" });
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");

  for (const extra of [{ DRY_RUN: "true" }, { WATCHDOG_LIMIT_PAUSE: "false" }]) {
    const quiet = await limitEnv(t, extra);
    const agent = claude(quiet.db, "Engineer");
    failedRun(quiet.db, agent, { at: T0 - MIN });
    await quiet.watchdog.tick();
    await quiet.watchdog.tick();
    assert.equal(agent.status, "idle", JSON.stringify(extra));
    assert.equal(quiet.db.comments.length, 0);
    const would = quiet.logs.filter((l) => /would pause an agent/.test(l.msg));
    assert.equal(would.length, extra.DRY_RUN ? 1 : 0);
  }
});

test("without a notify issue, the board hears it in the log", async (t) => {
  const env = await limitEnv(t, { WATCHDOG_NOTIFY_ISSUE: "" });
  const engineer = claude(env.db, "Engineer");
  failedRun(env.db, engineer, { at: T0 - MIN });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  assert.equal(env.logs.filter((l) => l.msg === "watchdog: a note for the board" && /^Claude usage limit reached: 1 agent paused/.test(l.text)).length, 1);
});

test("an issue Paperclip blocked during the limit's pause is restored after the resume", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer", secret("sub-1"), { runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } });
  failedRun(env.db, engineer, { at: T0 - MIN });
  await env.watchdog.tick();
  // Paperclip's recovery blocks one of its issues while it is paused.
  const issue = {
    id: uuid(), identifier: "ACM-7", companyId: ids.company, status: "blocked", assigneeAgentId: engineer.id, blockedBy: [],
    updatedAt: iso(T0 + 10 * MIN), blockedTransitionAt: iso(T0 + 10 * MIN),
  };
  env.db.issues.push(issue);
  env.db.comments.push({
    id: uuid(), issueId: issue.id, authorType: "system", authorAgentId: null, authorUserId: null, createdAt: iso(T0 + 10 * MIN),
    body: "Paperclip cannot safely continue automatic recovery because the original assignee is not invokable.",
    metadata: { version: 1, recoveryResponsibility: "system", sections: [{ title: "Recovery", rows: [{ type: "key_value", label: "Recovery owner", value: "Board decision required" }] }] },
  });
  env.clock.at = Date.parse("2026-10-12T15:06:00Z");
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");
  assert.equal(issue.status, "todo");
});

test("a refused resume is tried again next tick; a pause Paperclip refuses is logged once", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const stubborn = claude(env.db, "Stubborn");
  failedRun(env.db, engineer, { at: T0 - MIN });
  env.fake.fail("POST", `/api/agents/${stubborn.id}/pause`, 500, { times: -1 });
  await env.watchdog.tick();
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(stubborn.status, "idle");
  assert.equal(env.logs.filter((l) => /couldn't pause an agent/.test(l.msg)).length, 1);

  env.fake.clearFailures();
  env.fake.fail("POST", `/api/agents/${engineer.id}/resume`, 503, { times: -1 });
  env.clock.at = Date.parse("2026-10-12T15:06:00Z");
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  env.fake.clearFailures();
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");
});

test("no note when nothing was paused, and never on another company's issue", async (t) => {
  const env = await limitEnv(t);
  // Every agent on the account is busy (or paused by you): nothing paused, nothing said yet.
  const busy = claude(env.db, "Busy");
  claude(env.db, "Yours", secret("sub-1"), { status: "paused", pausedAt: iso(T0 - 60 * MIN), pauseReason: "manual" });
  failedRun(env.db, busy, { at: T0 - MIN });
  env.db.heartbeatRuns.push({ id: uuid(), companyId: ids.company, agentId: busy.id, status: "running", createdAt: iso(T0) });
  await env.watchdog.tick();
  assert.equal(env.db.comments.length, 0);
  assert.equal(env.logs.filter((l) => /Claude usage limit reached/.test(l.text ?? "")).length, 0);

  // The notify issue belongs to another company.
  const other = await limitEnv(t);
  other.db.issues[0].companyId = "c-other";
  const agent = claude(other.db, "Engineer");
  failedRun(other.db, agent, { at: T0 - MIN });
  await other.watchdog.tick();
  assert.equal(agent.status, "paused");
  assert.equal(other.db.comments.length, 0);
  assert.equal(other.logs.filter((l) => /Claude usage limit reached: 1 agent paused/.test(l.text)).length, 1);
});

test("a dry run logs each agent it would pause once, however many ticks", async (t) => {
  const env = await limitEnv(t, { DRY_RUN: "true" });
  const agent = claude(env.db, "Engineer");
  failedRun(env.db, agent, { at: T0 - MIN });
  for (let i = 0; i < 4; i++) {
    await env.watchdog.tick();
    env.clock.at += MIN;
  }
  assert.equal(env.logs.filter((l) => /would pause an agent/.test(l.msg)).length, 1);
  assert.equal(env.logs.filter((l) => /hit its usage limit/.test(l.msg)).length, 1);
});

// ---------------------------------------------------------------- the pure helpers

test("parseReset reads a date, a clock time, a time zone, and refuses what isn't a time", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const at = (text) => {
    const r = parseReset(text, now);
    return r && new Date(r.at).toISOString();
  };
  assert.equal(at(WEEKLY), "2026-10-12T15:00:00.000Z");
  assert.equal(at("You've hit your limit · resets 3am (America/New_York)"), "2026-10-11T07:00:00.000Z");
  assert.equal(at("5-hour limit reached ∙ resets 4:30pm"), "2026-10-10T16:30:00.000Z");
  assert.equal(at("usage limit reached; resets at 11:00 (Europe/London)"), "2026-10-11T10:00:00.000Z");
  assert.equal(at("weekly limit reached, resets Oct 14, 9am (Europe/London)"), "2026-10-14T08:00:00.000Z");
  // More than a week ahead, or just past: misread, so unknown (one hour, then back off).
  assert.equal(at("weekly limit reached, resets Jan 3, 9am (Europe/London)"), null);
  assert.equal(at("weekly limit reached, resets Oct 10, 11am (Europe/London)"), null);
  // A "resets" before the limit phrase is about something else.
  assert.equal(at("429 rate limit resets 10:00 … You've hit your limit · resets 4pm (UTC)"), "2026-10-10T16:00:00.000Z");
  // Claude's older format: a Unix time.
  assert.equal(at(`Claude AI usage limit reached|${Math.floor(Date.parse("2026-10-10T17:00:00Z") / 1000)}`), "2026-10-10T17:00:00.000Z");
  assert.equal(at("resets 4pm (Not/AZone)"), "2026-10-10T16:00:00.000Z"); // an unknown zone: UTC
  assert.equal(at("Claude exited with code 143"), null);
  assert.equal(at("resets 13pm"), null);
  assert.equal(resetLabel(Date.parse("2026-10-12T15:00:00Z"), "Europe/London"), "Mon 12 Oct, 16:00 (Europe/London)");
});

test("isClaudeLimitFailure and subscriptionOf", () => {
  const claudeAgent = { id: "a", adapterType: "claude_local", adapterConfig: { env: secret("s1") } };
  const run = { status: "failed", errorCode: "claude_transient_upstream", error: WEEKLY };
  assert.equal(isClaudeLimitFailure(run, claudeAgent), true);
  assert.equal(isClaudeLimitFailure({ ...run, error: "Claude exited with code 143" }, claudeAgent), false);
  assert.equal(isClaudeLimitFailure({ ...run, status: "succeeded" }, claudeAgent), false);
  assert.equal(isClaudeLimitFailure({ ...run, errorCode: "adapter_failed" }, claudeAgent), false);
  assert.equal(isClaudeLimitFailure(run, { adapterType: "codex_local" }), false);

  assert.equal(subscriptionOf(claudeAgent), "CLAUDE_CODE_OAUTH_TOKEN:secret:s1");
  assert.equal(subscriptionOf({ id: "b", adapterType: "claude_local", adapterConfig: {} }), "host-login");
  // A token typed in as plain text is redacted: it can't be compared, so the agent is on its own.
  assert.equal(subscriptionOf({ id: "c", adapterType: "claude_local", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "***REDACTED***" } } } }), "agent:c");
  assert.equal(subscriptionOf({ id: "d", adapterType: "claude_local", adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "k" } } } }), "ANTHROPIC_API_KEY:secret:k");
  assert.equal(subscriptionOf({ id: "e", adapterType: "codex_local" }), null);
  // Paperclip's order: the API key wins over the OAuth token.
  assert.equal(subscriptionOf({ id: "f", adapterType: "claude_local", adapterConfig: { env: { ...secret("s1"), ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "k" } } } }), "ANTHROPIC_API_KEY:secret:k");
  // Bedrock, its own config directory, a proxy, a managed connection: not the shared login.
  for (const env of [{ CLAUDE_CODE_USE_BEDROCK: "1" }, { CLAUDE_CONFIG_DIR: { type: "plain", value: "***REDACTED***" } }, { ANTHROPIC_BASE_URL: "https://proxy" }]) {
    assert.equal(subscriptionOf({ id: "g", adapterType: "claude_local", adapterConfig: { env } }), "agent:g", JSON.stringify(env));
  }
  assert.equal(subscriptionOf({ id: "h", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aiConnection: { mode: "grant" } } }), "agent:h");
});
