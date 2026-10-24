import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";
import { accountOf, classifyFailure, codexAccountOf, isClaudeLimitFailure, parseCodexReset, parseReset, resetLabel, subscriptionOf } from "../src/limits.mjs";
import { loadConfig } from "../src/config.mjs";
import { CLAUDE_MESSAGES, CODEX_MESSAGES } from "./fixtures/limit-messages.mjs";

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

test("agents with their own config directory but the same token secret share one account: one failure pauses them all", async (t) => {
  const env = await limitEnv(t);
  const dir = { CLAUDE_CONFIG_DIR: { type: "plain", value: "***REDACTED***" } };
  const [a, b, c] = ["Engineer", "Reviewer", "Architect"].map((name) => claude(env.db, name, { ...dir, ...secret("sub-1") }));
  failedRun(env.db, a, { at: T0 - MIN });
  await env.watchdog.tick();
  assert.deepEqual([a, b, c].map((x) => x.status), ["paused", "paused", "paused"]);
});

test("an agent whose run starts just before its pause is left running, and paused once that run ends", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const reviewer = claude(env.db, "Reviewer");
  failedRun(env.db, engineer, { at: T0 - MIN });
  // A retry starts for the reviewer after the tick read the company's runs.
  let started = null;
  env.db.onRequest = (method, path) => {
    if (started || method !== "GET" || !path.includes(`heartbeat-runs?agentId=${reviewer.id}`)) return;
    started = { id: uuid(), companyId: ids.company, agentId: reviewer.id, status: "running", createdAt: iso(T0) };
    env.db.heartbeatRuns.push(started);
  };
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  assert.equal(reviewer.status, "idle");
  assert.equal(started.status, "running", "the run that started wasn't cancelled");
  assert.match(env.db.comments.find((c) => c.identifier === "ACM-1").body, /and 1 more once its current run ends \(Reviewer\)/);

  started.status = "succeeded";
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(reviewer.status, "paused");
});

test("an agent kept busy by its own failing retries is logged once, not paused", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const busy = claude(env.db, "Architect");
  failedRun(env.db, engineer, { at: T0 - MIN });
  for (let i = 0; i < 40; i++) {
    // The busy agent's run fails on the limit every five ticks, and a retry is queued at once.
    if (i % 5 === 0) {
      for (const r of env.db.heartbeatRuns) if (r.agentId === busy.id && r.status === "queued") r.status = "failed";
      failedRun(env.db, busy, { at: env.clock.at });
      env.db.heartbeatRuns.push({ id: uuid(), companyId: ids.company, agentId: busy.id, status: "queued", createdAt: iso(env.clock.at + 1) });
    }
    await env.watchdog.tick();
    env.clock.at += MIN;
  }
  assert.equal(busy.status, "idle");
  assert.equal(env.logs.filter((l) => /has had a run queued or going for a long time/.test(l.msg)).length, 1);
});

test("an agent kept busy by its runs for a long time is logged once, not paused", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  const busy = claude(env.db, "Architect");
  failedRun(env.db, engineer, { at: T0 - MIN });
  env.db.heartbeatRuns.push({ id: uuid(), companyId: ids.company, agentId: busy.id, status: "queued", createdAt: iso(T0 - MIN) });
  for (let i = 0; i < 32; i++) {
    await env.watchdog.tick();
    env.clock.at += MIN;
  }
  assert.equal(busy.status, "idle");
  assert.equal(env.logs.filter((l) => /has had a run queued or going for a long time/.test(l.msg)).length, 1);
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

test("a transient failure, a Codex agent's model at capacity, or an old limit already reset does nothing", async (t) => {
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
  assert.equal(issue.status, "blocked", "not before the resume has settled");
  env.clock.at += 10 * MIN;
  await env.watchdog.tick();
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
  // Bedrock, a proxy, a managed connection: not the shared login.
  for (const env of [{ CLAUDE_CODE_USE_BEDROCK: "1" }, { ANTHROPIC_BASE_URL: "https://proxy" }, { ...secret("s1"), ANTHROPIC_AUTH_TOKEN: { type: "plain", value: "***REDACTED***" } }]) {
    assert.equal(subscriptionOf({ id: "g", adapterType: "claude_local", adapterConfig: { env } }), "agent:g", JSON.stringify(env));
  }
  // Its own config directory: with a token secret bound, the token decides the account.
  const ownDir = { CLAUDE_CONFIG_DIR: { type: "plain", value: "***REDACTED***" } };
  assert.equal(subscriptionOf({ id: "g", adapterType: "claude_local", adapterConfig: { env: { ...ownDir, ...secret("s1") } } }), "CLAUDE_CODE_OAUTH_TOKEN:secret:s1");
  // Without a token, the directory holds the login: the same directory is the same login,
  // and a redacted one can't be compared.
  assert.equal(subscriptionOf({ id: "g", adapterType: "claude_local", adapterConfig: { env: ownDir } }), "agent:g");
  assert.equal(subscriptionOf({ id: "g", adapterType: "claude_local", adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/home/pc/.claude-a" } } }), "host-login:/home/pc/.claude-a");
  assert.equal(subscriptionOf({ id: "h", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aiConnection: { mode: "grant" } } }), "agent:h");
});

// ---------------------------------------------------------------- Codex (and other adapters)

const apiKey = (secretId) => ({ OPENAI_API_KEY: { type: "secret_ref", secretId } });
const PLUS_LIMIT = CODEX_MESSAGES.find(([name]) => name === "Plus plan")[1];

function codex(db, name, env = apiKey("openai-1"), extra = {}) {
  const a = { id: uuid(), companyId: ids.company, name, status: "idle", adapterType: "codex_local", adapterConfig: { env }, ...extra };
  db.agents.push(a);
  return a;
}
// Codex's reset times are in its machine's local time: London here.
const codexEnv = (t, extra = {}) => limitEnv(t, { WATCHDOG_LIMIT_TIME_ZONE: "Europe/London", ...extra });

test("a Codex plan's usage limit pauses the Codex agents on the same API key, not Claude's, and resumes them at the reset", async (t) => {
  const env = await codexEnv(t);
  const a = codex(env.db, "Codex Engineer");
  const b = codex(env.db, "Codex Reviewer");
  const otherKey = codex(env.db, "Other key", apiKey("openai-2"));
  const claudeAgent = claude(env.db, "Claude Engineer");
  failedRun(env.db, a, { at: T0 - MIN, errorCode: "provider_quota", error: PLUS_LIMIT });

  await env.watchdog.tick();
  assert.deepEqual([a, b, otherKey, claudeAgent].map((x) => x.status), ["paused", "paused", "idle", "idle"]);
  const [note] = env.db.comments.filter((c) => c.identifier === "ACM-1");
  assert.match(
    note.body,
    /^Codex usage limit reached: 2 agents paused \(Codex Engineer, Codex Reviewer\)\. The limit resets Mon 12 Oct, 15:45 \(Europe\/London\); the watchdog resumes them at Mon 12 Oct, 15:50 \(Europe\/London\)\. Claude agents are unaffected and keep working\./,
  );
  assert.equal(env.logs.filter((l) => /a Codex account hit its usage limit/.test(l.msg)).length, 1);

  env.clock.at = Date.parse("2026-10-12T14:49:00Z"); // 15:49 London: within the grace
  await env.watchdog.tick();
  assert.equal(a.status, "paused");
  env.clock.at = Date.parse("2026-10-12T14:50:00Z");
  await env.watchdog.tick();
  assert.deepEqual([a, b].map((x) => x.status), ["idle", "idle"]);
});

test("Codex agents are grouped by their Codex login: the same CODEX_HOME, or the machine's shared login", async (t) => {
  const env = await codexEnv(t);
  const home = (path) => ({ CODEX_HOME: path });
  const shared1 = codex(env.db, "Shared 1", {});
  const shared2 = codex(env.db, "Shared 2", {});
  const ownA = codex(env.db, "Own home A", home("/home/pc/.codex-a"));
  const ownA2 = codex(env.db, "Own home A too", home("/home/pc/.codex-a"));
  const ownB = codex(env.db, "Own home B", home("/home/pc/.codex-b"));
  // A home Paperclip redacts can't be compared: that agent is its own group.
  const hidden = codex(env.db, "Hidden home", { CODEX_HOME: { type: "plain", value: "***REDACTED***" } });
  failedRun(env.db, ownA, { at: T0 - MIN, error: "You’ve hit your usage limit. Try again at 3:45 PM." });
  failedRun(env.db, shared1, { at: T0 - MIN, error: "You’ve hit your usage limit. Try again at 3:45 PM." });
  await env.watchdog.tick();
  assert.deepEqual(
    [shared1, shared2, ownA, ownA2, ownB, hidden].map((x) => x.status),
    ["paused", "paused", "paused", "paused", "idle", "idle"],
  );
  failedRun(env.db, hidden, { at: env.clock.at, error: "Quota exceeded. Check your plan and billing details." });
  env.clock.at += MIN;
  await env.watchdog.tick();
  assert.equal(hidden.status, "paused");
  assert.equal(ownB.status, "idle");
});

test("one Codex model's own limit pauses only the agent that hit it", async (t) => {
  const env = await codexEnv(t);
  const a = codex(env.db, "On the limited model");
  const b = codex(env.db, "Same key, other model");
  failedRun(env.db, a, { at: T0 - MIN, error: "You’ve hit your usage limit for codex_other. Switch to another model now, or try again at 3:45 PM." });
  await env.watchdog.tick();
  assert.deepEqual([a.status, b.status], ["paused", "idle"]);
  assert.match(env.db.comments.find((c) => c.identifier === "ACM-1").body, /^Codex usage limit for codex_other reached: 1 agent paused \(On the limited model\)\./);
  env.clock.at = Date.parse("2026-10-12T14:50:00Z");
  await env.watchdog.tick();
  assert.equal(a.status, "idle");
});

test("a Codex quota or billing error has no reset time: an hour, then it looks again", async (t) => {
  const env = await codexEnv(t);
  const a = codex(env.db, "Codex Engineer");
  failedRun(env.db, a, { at: T0 - 2 * MIN, error: "Quota exceeded. Check your plan and billing details." });
  await env.watchdog.tick();
  assert.equal(a.status, "paused");
  assert.match(env.db.comments.find((c) => c.identifier === "ACM-1").body, /^Codex quota or billing limit reached: 1 agent paused \(Codex Engineer\)\. Codex didn't say when the limit resets, so the watchdog resumes them at Mon 12 Oct, 11:03 \(Europe\/London\)/);
  env.clock.at = T0 + 63 * MIN;
  await env.watchdog.tick();
  assert.equal(a.status, "idle");
});

test("Codex capacity and high demand, a plan without Codex, and an adapter without a recogniser pause nothing", async (t) => {
  const env = await codexEnv(t);
  const a = codex(env.db, "Codex Engineer");
  const b = codex(env.db, "Codex Reviewer");
  const c = codex(env.db, "Codex Architect");
  const gemini = { id: uuid(), companyId: ids.company, name: "Gemini", status: "idle", adapterType: "gemini_local", adapterConfig: {} };
  env.db.agents.push(gemini);
  failedRun(env.db, a, { at: T0 - MIN, errorCode: "provider_quota", error: "Selected model is at capacity. Please try a different model." });
  failedRun(env.db, b, { at: T0 - MIN, errorCode: "codex_transient_upstream", error: "We’re currently experiencing high demand, which may cause temporary errors." });
  failedRun(env.db, c, { at: T0 - MIN, errorCode: null, error: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus." });
  failedRun(env.db, gemini, { at: T0 - MIN, errorCode: "provider_quota", error: "You've hit your usage limit. Try again at 3:45 PM." });
  await env.watchdog.tick();
  await env.watchdog.tick();
  assert.equal(lifecycle(env, "pause").length, 0);
  assert.equal(env.db.comments.length, 0);
});

test("WATCHDOG_USAGE_LIMIT_PAUSE=false pauses nothing; WATCHDOG_LIMIT_PAUSE is still read when it isn't set", async (t) => {
  const env = await codexEnv(t, { WATCHDOG_USAGE_LIMIT_PAUSE: "false" });
  const a = codex(env.db, "Codex Engineer");
  failedRun(env.db, a, { at: T0 - MIN, error: PLUS_LIMIT });
  await env.watchdog.tick();
  assert.equal(a.status, "idle");

  assert.equal(loadConfig({}).config.watchdogLimitPause, true);
  assert.equal(loadConfig({ WATCHDOG_LIMIT_PAUSE: "false" }).config.watchdogLimitPause, false);
  assert.equal(loadConfig({ WATCHDOG_LIMIT_PAUSE: "false", WATCHDOG_USAGE_LIMIT_PAUSE: "true" }).config.watchdogLimitPause, true);
  assert.equal(loadConfig({ WATCHDOG_USAGE_LIMIT_PAUSE: "off" }).config.watchdogLimitPause, false);
  assert.equal(loadConfig({ WATCHDOG_LIMIT_TIME_ZONE: "Europe/London" }).config.watchdogLimitTimeZone, "Europe/London");
  assert.match(loadConfig({ WATCHDOG_LIMIT_TIME_ZONE: "Mars/Olympus" }).problems.join("\n"), /WATCHDOG_LIMIT_TIME_ZONE=Mars\/Olympus is not a time zone/);
});

test("a limit record from before 1.12 (no adapter) is still a Claude limit and is resumed", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer", secret("sub-1"), { status: "paused", pausedAt: iso(T0 - MIN), pauseReason: "manual" });
  env.state.nudges.set(`limit:${ids.company}:CLAUDE_CODE_OAUTH_TOKEN:secret:sub-1`, {
    companyId: ids.company, account: "CLAUDE_CODE_OAUTH_TOKEN:secret:sub-1", runId: "r", lastFailureAt: T0 - 2 * MIN,
    resetAt: T0 + 30 * MIN, timeZone: "UTC", unknownReset: false, waitMs: 0, paused: { [engineer.id]: { name: "Engineer", pausedAt: iso(T0 - MIN), tries: 0 } },
    waitTicks: {}, notified: true, count: 1, at: T0,
  });
  env.clock.at = T0 + 36 * MIN;
  await env.watchdog.tick();
  assert.equal(engineer.status, "idle");
});

// Each message, word for word from the Codex CLI's source (test/fixtures/limit-messages.mjs).
test("the Codex recogniser: every Codex CLI message is a limit, transient, or neither, with its reset", () => {
  const agent = { id: "x", adapterType: "codex_local", adapterConfig: {} };
  const at = Date.parse("2026-10-12T09:00:00Z"); // 10:00 in London
  for (const [name, error, expected] of CODEX_MESSAGES) {
    const run = { id: "r", status: "failed", errorCode: "provider_quota", error, finishedAt: iso(at) };
    const verdict = classifyFailure(run, agent, { timeZone: "Europe/London" });
    if (expected === null) {
      assert.equal(verdict, null, name);
      continue;
    }
    assert.equal(verdict?.kind, expected.kind, name);
    if (expected.kind !== "limit") continue;
    assert.equal(verdict.scope, expected.scope, name);
    const resetAt = { today: "2026-10-12T14:45:00.000Z", dated: "2026-10-13T14:45:00.000Z" }[expected.reset];
    assert.equal(verdict.reset ? new Date(verdict.reset.at).toISOString() : null, resetAt ?? null, name);
  }
  // Only a failed run counts, whatever its error code.
  assert.equal(classifyFailure({ status: "succeeded", error: PLUS_LIMIT }, agent), null);
  assert.equal(classifyFailure({ status: "failed", errorCode: null, error: PLUS_LIMIT, finishedAt: iso(at) }, agent).kind, "limit");
});

test("the Claude recogniser: its limit wording only with its error codes; Codex wording on a Claude agent goes by Claude's rules", () => {
  const agent = { id: "c", adapterType: "claude_local", adapterConfig: {} };
  for (const [name, error, expected] of CLAUDE_MESSAGES) {
    const verdict = classifyFailure({ status: "failed", errorCode: "claude_transient_upstream", error, finishedAt: iso(T0) }, agent);
    assert.equal(verdict?.kind, expected.kind, name);
  }
  assert.equal(classifyFailure({ status: "failed", errorCode: "adapter_failed", error: CLAUDE_MESSAGES[0][1] }, agent), null);
  assert.equal(classifyFailure({ status: "failed", errorCode: "provider_quota", error: "x" }, { adapterType: "gemini_local" }), null);
});

test("parseCodexReset reads Codex's clock times in the given zone; a dateless time already passed is a zone mismatch, not tomorrow", () => {
  const now = Date.parse("2026-10-12T09:00:00Z");
  const iso2 = (r) => (r ? new Date(r.at).toISOString() : null);
  assert.equal(iso2(parseCodexReset("Try again at 3:45 PM.", now, "Europe/London")), "2026-10-12T14:45:00.000Z");
  assert.equal(iso2(parseCodexReset("Try again at 3:45 PM.", now, "UTC")), "2026-10-12T15:45:00.000Z");
  assert.equal(iso2(parseCodexReset("Try again at 9:15 AM.", now, "UTC")), "2026-10-12T09:15:00.000Z");
  // Codex writes a time without a date only for later the same day, in its own zone.
  assert.equal(parseCodexReset("Try again at 8:15 AM.", now, "UTC"), null);
  assert.equal(parseCodexReset("Try again at 12:05 AM.", now, "UTC"), null);
  // Paperclip on UTC said 9:30 AM; read as London (UTC+1) it would be 08:30 UTC, already past.
  assert.equal(parseCodexReset("Try again at 9:30 AM.", now, "Europe/London"), null);
  assert.equal(iso2(parseCodexReset("or try again at Oct 18th, 2026 1:00 AM.", now, "Europe/London")), "2026-10-18T00:00:00.000Z");
  // After the clocks go back (25 October in London), GMT again.
  assert.equal(iso2(parseCodexReset("try again at Oct 26th, 2026 9:00 AM.", Date.parse("2026-10-24T09:00:00Z"), "Europe/London")), "2026-10-26T09:00:00.000Z");
  assert.equal(parseCodexReset("Try again later.", now), null);
  assert.equal(parseCodexReset("try again at Oct 1st, 2026 9:00 AM.", now, "UTC"), null, "in the past");
  assert.equal(parseCodexReset("try again at Dec 1st, 2026 9:00 AM.", now, "UTC"), null, "more than a week away");
  assert.equal(parseCodexReset("try again at 13:00 PM.", now, "UTC"), null);
});

test("codexAccountOf and accountOf", () => {
  const agent = (env, extra = {}) => ({ id: "x", adapterType: "codex_local", adapterConfig: { env }, ...extra });
  assert.equal(codexAccountOf(agent(apiKey("k1"))), "codex:OPENAI_API_KEY:secret:k1");
  // The key wins over the home, as in Paperclip's codex-local adapter.
  assert.equal(codexAccountOf(agent({ ...apiKey("k1"), CODEX_HOME: "/h" })), "codex:OPENAI_API_KEY:secret:k1");
  assert.equal(codexAccountOf(agent({ OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" } })), "agent:x");
  assert.equal(codexAccountOf(agent({})), "codex:host-login");
  assert.equal(codexAccountOf(agent({ CODEX_HOME: "/home/pc/.codex-a" })), "codex:home:/home/pc/.codex-a");
  assert.equal(codexAccountOf(agent({ CODEX_HOME: { type: "plain", value: "/home/pc/.codex-a" } })), "codex:home:/home/pc/.codex-a");
  assert.equal(codexAccountOf(agent({ CODEX_HOME: { type: "secret_ref", secretId: "h1" } })), "codex:CODEX_HOME:secret:h1");
  assert.equal(codexAccountOf(agent({ CODEX_HOME: { type: "plain", value: "***REDACTED***" } })), "agent:x");
  for (const env of [{ OPENAI_BASE_URL: "http://proxy" }, { CODEX_API_KEY: { type: "plain", value: "***REDACTED***" } }]) {
    assert.equal(codexAccountOf(agent(env)), "agent:x", JSON.stringify(env));
  }
  assert.equal(codexAccountOf(agent({}, { runtimeConfig: { aiConnection: { mode: "grant" } } })), "agent:x");
  assert.equal(codexAccountOf({ id: "c", adapterType: "claude_local" }), null);

  assert.equal(accountOf(agent({})), "codex:host-login");
  assert.equal(accountOf({ id: "b", adapterType: "claude_local", adapterConfig: {} }), "host-login");
  assert.equal(accountOf({ id: "g", adapterType: "gemini_local" }), null);
});

test("a Codex reset time that has already passed in the configured zone is a guessed hour, not tomorrow", async (t) => {
  // Paperclip (and so Codex) on UTC, the helper told London: Codex's "9:30 AM" reads as 08:30 UTC, already past.
  const env = await codexEnv(t);
  const a = codex(env.db, "Codex Engineer");
  failedRun(env.db, a, { at: T0 - 2 * MIN, error: "You’ve hit your usage limit. Try again at 9:30 AM." });
  await env.watchdog.tick();
  assert.equal(a.status, "paused");
  assert.match(env.db.comments.find((c) => c.identifier === "ACM-1").body, /Codex didn't say when the limit resets, so the watchdog resumes them at Mon 12 Oct, 11:03 \(Europe\/London\)/);
  env.clock.at = T0 + 63 * MIN;
  await env.watchdog.tick();
  assert.equal(a.status, "idle");
});

test("an agent Paperclip has since paused for its budget is not resumed at the reset", async (t) => {
  const env = await limitEnv(t);
  const engineer = claude(env.db, "Engineer");
  failedRun(env.db, engineer, { at: T0 - 2 * MIN });
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  // Same pause time, but Paperclip now holds it for its budget.
  engineer.pauseReason = "budget";
  env.clock.at = Date.parse("2026-10-12T15:06:00Z");
  await env.watchdog.tick();
  assert.equal(engineer.status, "paused");
  assert.deepEqual(lifecycle(env, "resume"), []);
  const [, record] = [...env.state.nudges.entries()].find(([k]) => k.startsWith("limit:"));
  assert.deepEqual(record.paused, {}, "left to you, and forgotten");
});
