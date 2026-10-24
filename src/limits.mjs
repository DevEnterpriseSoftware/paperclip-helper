// Watchdog 16: usage limits (createLimitCheck; watchdog.mjs runs it each tick).
//
// When a plan hits its usage limit (a Claude subscription's 5-hour or weekly
// limit, a ChatGPT plan's limit for Codex, an API organisation's spend cap or
// quota), every agent on it fails its next run, and Paperclip keeps waking and
// retrying them: hundreds of failed runs before the limit resets.
//
// Each adapter has a recogniser (RECOGNISERS) that decides three things from a
// failed run: whether it is an account limit (pause the account's agents until
// the reset) or transient capacity (left to Paperclip's own retries), when the
// limit resets, and which agents share the account. An adapter without one is
// left alone, as before.
//
// Claude: Paperclip files the failure as `claude_transient_upstream` (as of
// 2026.10) or, in newer source, `provider_quota`; the error text says which limit
// and when it resets: "You've hit your org's monthly spend limit · … · your weekly
// limit resets Oct 12, 4pm (Europe/London)". The same error codes cover real
// transient failures ("Claude exited with code 143"), so only the limit wording
// counts.
//
// Codex: the run's error is the Codex CLI's own message (codex-rs
// protocol/src/error.rs, UsageLimitReachedError and CodexErr). Paperclip's error
// code can't be relied on: its CLI path files "Selected model is at capacity" as
// `provider_quota` too, and the API's quota message as neither. So the wording
// decides: the ChatGPT-plan limit ("You’ve hit your usage limit. … Try again at
// 3:45 PM."), the API's quota and billing errors (insufficient_quota, "Quota
// exceeded. Check your plan and billing details."), and the workspace's credit or
// spend cap are limits; "Selected model is at capacity" and "high demand" are
// transient.

import { asleep, plural, ts } from "./util.mjs";
import { noteToBoard } from "./board-note.mjs";

const LIMIT_CODES = new Set(["claude_transient_upstream", "provider_quota"]);
// The wording of Claude's limit messages (as Paperclip's own claude-local parser
// matches them, packages/adapters/claude-local/src/server/parse.ts).
const LIMIT_TEXT =
  /you(?:'|’)ve\s+hit\s+your\s+(?:[\w'’-]+\s+){0,3}limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached/i;
// "resets Oct 12, 4pm (Europe/London)", "resets at 4:30pm (UTC)", "resets 16:00".
const RESET_TEXT =
  /\bresets?\s+(?:at\s+|on\s+)?(?:([A-Z][a-z]{2,8})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?\s*m\.?)?(?:\s*\(([^)]+)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// A Claude agent's run that failed on a usage limit.
export function isClaudeLimitFailure(run, agent) {
  if (agent?.adapterType !== "claude_local") return false;
  return CLAUDE.classify(run)?.kind === "limit";
}

// The wall-clock parts of a moment in a time zone.
function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute };
}

// The moment a wall-clock time in a time zone happens (DST-safe), or null.
function fromWallClock({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = partsIn(new Date(guess), timeZone);
    const offset = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (offset === 0) return guess;
    guess += offset;
  }
  return null;
}

function validZone(name) {
  if (!name) return null;
  const zone = name.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

// Claude's older format names the reset as a Unix time: "Claude AI usage limit reached|1760281200".
const EPOCH_RESET = /usage\s+limit\s+reached\|(\d{10})\b/i;
// The reset follows the limit phrase closely; a "resets" further away is about something else.
const RESET_WINDOW = 200;
// The longest limit is a week: a date further out was misread.
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;

// When the limit resets, from the error text: { at (ms), timeZone } or null.
// Without a date, the next such time after `now`; without a time zone, UTC (the
// zone Claude gives is the account's; a guess here would be the helper's own).
export function parseReset(text, now) {
  const all = String(text ?? "");
  const epoch = all.match(EPOCH_RESET);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    return at > now && at - now <= MAX_RESET_AHEAD_MS ? { at, timeZone: "UTC" } : null;
  }
  const limit = all.match(LIMIT_TEXT);
  const near = limit ? all.slice(limit.index, limit.index + limit[0].length + RESET_WINDOW) : all;
  const m = near.match(RESET_TEXT);
  if (!m) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = m;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (/^p/i.test(meridiem) ? 12 : 0);
  } else if (minuteText == null) {
    return null; // "resets 4" alone isn't a time
  }
  if (hour > 23 || minute > 59) return null;
  const timeZone = validZone(zoneText) ?? "UTC";
  const today = partsIn(new Date(now), timeZone);
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
    const day = Number(dayText);
    if (!month || day < 1 || day > 31) return null;
    // The year isn't given: the one that puts the date in the coming week.
    for (const year of [today.year, today.year + 1]) {
      const at = fromWallClock({ year, month, day, hour, minute }, timeZone);
      if (at != null && at > now && at - now <= MAX_RESET_AHEAD_MS) return { at, timeZone };
    }
    return null;
  }
  for (const add of [0, 1]) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    const at = fromWallClock({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, timeZone);
    if (at != null && at > now) return { at, timeZone };
  }
  return null;
}

// Settings that send an agent's runs somewhere other than a Claude account's
// token or login: Bedrock, a proxy, or another token type.
const OWN_ROUTE = ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const isSet = (value) => value != null && value !== "" && value !== "0" && value !== "false";
const REDACTED = /^\*+REDACTED\*+$/;

// Which Claude account an agent's runs are billed to, as far as Paperclip shows,
// in the order Paperclip's claude-local adapter picks credentials: the secret
// behind ANTHROPIC_API_KEY, else behind CLAUDE_CODE_OAUTH_TOKEN, else the Claude
// login stored in its config directory (CLAUDE_CONFIG_DIR, or the machine's
// default). A token in the environment wins over the stored login, so a
// per-agent CLAUDE_CONFIG_DIR (its own sessions and settings) doesn't change the
// account when a token secret is bound. An agent whose account can't be compared
// (a token typed in as plain text, or a config directory, which Paperclip
// redacts; Bedrock or a proxy; a managed AI connection) is its own group: it is
// paused when it fails itself. null for an agent that isn't a Claude agent.
export function subscriptionOf(agent) {
  if (agent?.adapterType !== "claude_local") return null;
  const own = `agent:${agent.id}`;
  const env = agent.adapterConfig?.env ?? {};
  if (agent.runtimeConfig?.aiConnection || agent.adapterConfig?.managedAiConnection) return own;
  if (OWN_ROUTE.some((name) => isSet(env[name]?.value ?? env[name]))) return own;
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const binding = env[name];
    if (binding == null || binding === "") continue;
    if (binding?.type === "secret_ref" && binding.secretId) return `${name}:secret:${binding.secretId}`;
    return own;
  }
  // No token: the login stored in the config directory. The same directory is the same login.
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir == null || dir === "") return "host-login";
  if (dir?.type === "secret_ref" && dir.secretId) return `host-login:secret:${dir.secretId}`;
  const path = typeof dir === "string" ? dir : dir?.value;
  return path && !REDACTED.test(path) ? `host-login:${path}` : own;
}

// ---------------------------------------------------------------- Codex

// The Codex CLI's messages, word for word (codex-rs protocol/src/error.rs at
// openai/codex 970111f, 2026-10-23). The plan's limit always starts "You’ve hit your
// usage limit" and is followed by "." or, for one model's own limit, " for <model>.
// Switch to another model now"; the reset follows as "Try again at <time>." or
// "… or try again at <time>.", or "later" when Codex doesn't know it.
const CODEX_PLAN_LIMIT = /you(?:'|’)ve\s+hit\s+your\s+usage\s+limit(?:\.|\s+for\s+(.+?)\.\s+switch\s+to\s+another\s+model)/i;
// API-key quota and billing (CodexErr::QuotaExceeded, from the API's error codes),
// the API's own wording when it is passed through, and a workspace's credits or
// spend cap (RateLimitReachedType). None of them gives a reset time.
const CODEX_BILLING =
  /quota\s+exceeded\.\s+check\s+your\s+plan\s+and\s+billing\s+details|you\s+exceeded\s+your\s+current\s+quota|\binsufficient_quota\b|\bcredit_balance_exhausted\b|\b(?:organization|project)_spend_limit_exceeded\b|\borganization_usage_limit_exceeded\b|your\s+workspace\s+is\s+out\s+of\s+credits|you\s+hit\s+your\s+spend\s+cap/i;
// Capacity, not a limit: another model, or a later retry, works (CodexErr::ServerOverloaded,
// CodexErr::InternalServerError). Paperclip's retries handle it.
const CODEX_CAPACITY =
  /selected\s+model\s+is\s+at\s+capacity|\bmodel\s+is\s+at\s+capacity|at\s+capacity\s+for\s+this\s+model|we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand/i;
// format_retry_timestamp: "3:45 PM" on the same day, else "Oct 25th, 2026 3:45 PM",
// in the local time zone of the machine Codex runs on (Paperclip's).
const CODEX_RESET =
  /try\s+again\s+at\s+(?:([A-Z][a-z]{2})\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP])\.?M\b/i;

// The time zone Codex wrote its reset time in: WATCHDOG_LIMIT_TIME_ZONE, else the
// helper's own (usually the same machine as Paperclip).
export function localZone() {
  try {
    return validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  } catch {
    return "UTC";
  }
}

// When a Codex limit resets, from its "try again at …", read in `timeZone`; null
// when it says "later" or names no time. Codex writes a time without a date only
// for a reset later the same day (in its zone), so such a time that has already
// passed means the zone is wrong (WATCHDOG_LIMIT_TIME_ZONE isn't Paperclip's): null,
// a guessed wait, rather than the same time tomorrow.
export function parseCodexReset(text, now, timeZone = localZone()) {
  const m = String(text ?? "").match(CODEX_RESET);
  if (!m) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = m;
  const hour12 = Number(hourText);
  const minute = Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (/^p/i.test(meridiem) ? 12 : 0);
  const zone = validZone(timeZone) ?? "UTC";
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
    const day = Number(dayText);
    if (!month || day < 1 || day > 31) return null;
    const at = fromWallClock({ year: Number(yearText), month, day, hour, minute }, zone);
    return at != null && at > now && at - now <= MAX_RESET_AHEAD_MS ? { at, timeZone: zone } : null;
  }
  const today = partsIn(new Date(now), zone);
  const at = fromWallClock({ ...today, hour, minute }, zone);
  return at != null && at > now ? { at, timeZone: zone } : null;
}

// Which account a Codex agent's runs are billed to, in the order Paperclip's
// codex-local adapter picks credentials (execute.ts): the OPENAI_API_KEY secret,
// else the login in its CODEX_HOME (a secret, or a path Paperclip shows), else the
// machine's shared Codex login (Paperclip seeds its managed homes from it). A key
// or a home typed in as plain text is redacted for board callers, so it can't be
// compared; with a proxy (OPENAI_BASE_URL), CODEX_API_KEY or a managed AI
// connection the agent is its own group too: paused when it fails itself.
export function codexAccountOf(agent) {
  if (agent?.adapterType !== "codex_local") return null;
  const own = `agent:${agent.id}`;
  const env = agent.adapterConfig?.env ?? {};
  if (agent.runtimeConfig?.aiConnection || agent.adapterConfig?.managedAiConnection) return own;
  if (["OPENAI_BASE_URL", "CODEX_API_KEY"].some((name) => isSet(env[name]?.value ?? env[name]))) return own;
  const key = env.OPENAI_API_KEY;
  if (key != null && key !== "") {
    return key?.type === "secret_ref" && key.secretId ? `codex:OPENAI_API_KEY:secret:${key.secretId}` : own;
  }
  const home = env.CODEX_HOME;
  if (home == null || home === "") return "codex:host-login";
  if (home?.type === "secret_ref" && home.secretId) return `codex:CODEX_HOME:secret:${home.secretId}`;
  const path = typeof home === "string" ? home : home?.value;
  return path && !REDACTED.test(path) ? `codex:home:${path}` : own;
}

// ---------------------------------------------------------------- recognisers

// classify(run, { now, timeZone }) → null (not a limit or capacity failure),
// { kind: "transient" } (left to Paperclip's retries), or { kind: "limit", reset,
// scope, what }: reset { at, timeZone } or null when the message has none; scope
// "account" (every agent on the account) or "agent" (only an agent that hits it:
// one model's own limit); what names it for the board; zone, the time zone to tell
// the board a guessed reset in (the message's own when it names one).
const CLAUDE = {
  adapterType: "claude_local",
  label: "Claude",
  accountOf: (agent) => subscriptionOf(agent),
  classify(run) {
    if (run?.status !== "failed" || !LIMIT_CODES.has(run.errorCode)) return null;
    const text = String(run.error ?? "");
    if (!LIMIT_TEXT.test(text)) return { kind: "transient" };
    const at = ts(run.finishedAt ?? run.updatedAt ?? run.createdAt);
    return { kind: "limit", reset: parseReset(text, at), scope: "account", what: "usage limit" };
  },
};

const CODEX = {
  adapterType: "codex_local",
  label: "Codex",
  accountOf: codexAccountOf,
  classify(run, { timeZone } = {}) {
    if (run?.status !== "failed") return null;
    const text = String(run.error ?? "");
    const at = ts(run.finishedAt ?? run.updatedAt ?? run.createdAt);
    const plan = text.match(CODEX_PLAN_LIMIT);
    if (plan) {
      const model = plan[1]?.trim();
      return {
        kind: "limit",
        reset: parseCodexReset(text.slice(plan.index), at, timeZone),
        // One model's own limit: switching models works, so only agents that hit it wait.
        scope: model ? "agent" : "account",
        what: model ? `usage limit for ${model}` : "usage limit",
        zone: validZone(timeZone) ?? "UTC",
      };
    }
    if (CODEX_BILLING.test(text)) return { kind: "limit", reset: null, scope: "account", what: "quota or billing limit", zone: validZone(timeZone) ?? "UTC" };
    if (CODEX_CAPACITY.test(text)) return { kind: "transient" };
    return null;
  },
};

export const RECOGNISERS = new Map([CLAUDE, CODEX].map((r) => [r.adapterType, r]));
const labelOf = (adapterType) => RECOGNISERS.get(adapterType)?.label ?? adapterType ?? "agent";

// The account an agent's runs are billed to, for any adapter with a recogniser; null otherwise.
export function accountOf(agent) {
  return RECOGNISERS.get(agent?.adapterType)?.accountOf(agent) ?? null;
}

// What the agent's adapter makes of a failed run (see the recognisers above); null
// for an adapter without a recogniser, which keeps today's behaviour (nothing paused).
export function classifyFailure(run, agent, options = {}) {
  return RECOGNISERS.get(agent?.adapterType)?.classify(run, options) ?? null;
}

// A short, readable reset time for the board: in the zone the limit message named.
export function resetLabel(at, timeZone = "UTC") {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(at));
  return `${text} (${timeZone})`;
}

// The newest limit failure per account among a company's runs, after `since` (per
// account). A limit scoped to one agent (one model's own limit) is that agent's
// own: `agent:<id>`. [{ key, run, agent, at, verdict }]
function latestLimitFailures(runs, agents, sinceByKey = new Map(), timeZone) {
  const found = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const agent = agents.get(run.agentId);
    const verdict = classifyFailure(run, agent, { timeZone });
    if (verdict?.kind !== "limit") continue;
    const key = verdict.scope === "agent" ? `agent:${agent.id}` : accountOf(agent);
    if (!key) continue;
    const at = ts(run.finishedAt ?? run.updatedAt ?? run.createdAt);
    if (at <= (sinceByKey.get(key) ?? 0)) continue;
    const prior = found.get(key);
    if (!prior || at > prior.at) found.set(key, { key, run, agent, at, verdict });
  }
  return [...found.values()];
}

// The agents an event pauses: those on its account (an `agent:<id>` event, only that agent).
const onAccount = (agent, account) => accountOf(agent) === account || account === `agent:${agent.id}`;

// Runs that are going or about to: pausing the agent would cancel them, and a run
// cancelled mid-way gets its issue blocked by Paperclip's recovery. A scheduled
// retry hasn't started and only waits for its time, so it doesn't hold the pause.
const LIVE = new Set(["queued", "running"]);
// No reset time in the message: look again in an hour, then back off (2, 4, 8 hours)
// while the account keeps failing the same way.
const UNKNOWN_WAIT_MS = 60 * 60_000;
const MAX_UNKNOWN_WAIT_MS = 8 * 60 * 60_000;
// A new limit failure this soon after a resume is the same limit: no second note.
const SAME_EVENT_MS = 6 * 60 * 60_000;
// Leeway when telling the watchdog's pause apart from a later one by a person.
const PAUSE_MATCH_MS = 60_000;
// Resume attempts per agent before it's left to you.
const MAX_RESUME_TRIES = 5;
// Ticks an agent may stay busy (its runs keep it from being paused) before the log says so.
const LONG_WAIT_TICKS = 30;

const names = (list) => list.join(", ");

// The check: pause the agents on an account that hit its limit, each once it has no
// live run; tell the board once; resume exactly those agents at the reset. One
// record per company and account in the watchdog's records,
// `limit:<companyId>:<account>`: { adapter, what, resetAt, timeZone, unknownReset,
// waitMs, paused: { agentId: { name, pausedAt, tries } }, waitTicks: { agentId: ticks
// busy }, notified, runId, resumedAt }. A record from before 1.12 has no adapter: Claude's.
export function createLimitCheck({ api, config, log, records, state, now, stats, dryRunSeen }) {
  const graceMs = config.watchdogLimitResumeGraceMin * 60_000;
  const timeZone = config.watchdogLimitTimeZone || localZone();
  const label = (event) => labelOf(event.adapter ?? "claude_local");
  const keyOf = (companyId, account) => `limit:${companyId}:${account}`;
  const save = (event) => {
    if (config.dryRun) return; // a dry run records nothing
    records.set(keyOf(event.companyId, event.account), { ...event, count: 1, at: now() });
    state.touch();
  };
  // Logs once per key: a dry run's "would", a pause Paperclip refused.
  const once = (key, fn) => {
    if (dryRunSeen.has(key)) return;
    dryRunSeen.add(key);
    fn();
  };

  async function check(companyId, agents) {
    const runs = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?limit=200`).catch(() => null);
    if (!Array.isArray(runs)) return;
    const events = new Map(); // account → its record
    for (const [key, r] of records.entries()) if (key.startsWith(`limit:${companyId}:`) && r?.account) events.set(r.account, r);

    // New limit failures, or later ones while the account is still paused.
    const since = new Map([...events].map(([account, r]) => [account, Math.max(r.resumedAt ?? 0, r.lastFailureAt ?? 0)]));
    for (const { key: account, run, agent, at, verdict } of latestLimitFailures(runs, agents, since, timeZone)) {
      const prior = events.get(account);
      const event = startOrExtend(prior, { companyId, account, run, at, agent, verdict });
      if (!event) continue;
      if (!prior || prior.resumedAt) {
        once(`limit-detected:${account}:${run.id}`, () =>
          log.warn(`watchdog: ${verdict.scope === "agent" ? "an agent" : `a ${label(event)} account`} hit its ${event.what}; pausing ${verdict.scope === "agent" ? "it" : "its agents"} until it resets`, {
            agent: agent.name, adapter: agent.adapterType, run: run.id, resetAt: new Date(event.resetAt).toISOString(), knownReset: !event.unknownReset,
          }),
        );
      }
      events.set(account, event);
      save(event);
    }

    for (const event of events.values()) {
      if (event.resumedAt) continue;
      if (now() >= event.resetAt + graceMs) await resume(event, agents);
      else await pauseIdle(event, agents, runs);
    }
  }

  // The event a limit failure starts, or the running one it extends; null when
  // its reset has passed already.
  function startOrExtend(prior, { companyId, account, run, at, agent, verdict }) {
    const reset = verdict.reset;
    const active = prior && !prior.resumedAt;
    // The same limit again soon after a resume: it hadn't really reset.
    const repeat = prior?.resumedAt && now() - prior.resumedAt < SAME_EVENT_MS;
    // With no reset time: an hour, doubled each time the same limit comes back (at most 8).
    let waitMs = 0;
    if (!reset) {
      if (repeat && prior.unknownReset) waitMs = Math.min(2 * (prior.waitMs || UNKNOWN_WAIT_MS), MAX_UNKNOWN_WAIT_MS);
      else if (active) waitMs = prior.waitMs || UNKNOWN_WAIT_MS;
      else waitMs = UNKNOWN_WAIT_MS;
    }
    const resetAt = reset?.at ?? at + waitMs;
    if (resetAt + graceMs <= now()) return null;
    return {
      companyId, account, adapter: agent.adapterType, what: verdict.what, runId: run.id, lastFailureAt: at,
      resetAt: active ? Math.max(prior.resetAt, resetAt) : resetAt,
      timeZone: reset?.timeZone ?? (active ? prior.timeZone : null) ?? verdict.zone ?? "UTC",
      unknownReset: active ? prior.unknownReset && !reset : !reset,
      waitMs,
      paused: active ? prior.paused : {},
      // Kept while the event lasts: a busy agent's retries failing on the limit again extend it.
      waitTicks: active ? prior.waitTicks ?? {} : {},
      notified: active ? prior.notified : Boolean(repeat && prior.notified),
    };
  }

  // Whether the agent is busy right now: a fresh read just before pausing it, since
  // a retry or a new wake can start a run after the tick's list was read. null when
  // Paperclip doesn't answer, or the agent was paused or stopped meanwhile (looked at
  // again next tick).
  async function busyNow(companyId, agent) {
    const [fresh, runs] = await Promise.all([
      api.request("GET", `/api/agents/${agent.id}`).catch(() => null),
      api.request("GET", `/api/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=5`).catch(() => null),
    ]);
    if (!fresh || !Array.isArray(runs) || asleep(fresh)) return null;
    return fresh.status === "running" || runs.some((r) => r.agentId === agent.id && LIVE.has(r.status));
  }

  // Waiting for a busy agent's runs to end is right (pausing would cancel them), but
  // a run that keeps being retried can hold it off until the reset: say so, once.
  function stillWaiting(event, agent) {
    const ticks = (event.waitTicks ??= {});
    ticks[agent.id] = (ticks[agent.id] ?? 0) + 1;
    if (ticks[agent.id] === LONG_WAIT_TICKS) {
      log.warn("watchdog: an agent at its usage limit has had a run queued or going for a long time, so it hasn't been paused; pausing it yourself cancels that run", { agent: agent.name, ticks: LONG_WAIT_TICKS });
    }
  }

  // Pauses the account's agents that have no live run; returns those still busy.
  async function pauseIdle(event, agents, runs) {
    const members = [...agents.values()].filter((a) => onAccount(a, event.account));
    const waiting = [];
    for (const agent of members) {
      if (event.paused[agent.id] || asleep(agent)) continue; // ours, or a person's or not runnable
      const live = agent.status === "running" || runs.some((r) => r.agentId === agent.id && LIVE.has(r.status));
      if (live) {
        waiting.push(agent);
        stillWaiting(event, agent);
        continue;
      }
      if (config.dryRun) {
        once(`limit-pause:${event.runId}:${agent.id}`, () => log("watchdog: would pause an agent until its usage limit resets (dry run)", { agent: agent.name }));
        continue;
      }
      // Busy, or Paperclip didn't say: not paused this tick, and counted as waiting.
      if ((await busyNow(event.companyId, agent)) !== false) {
        waiting.push(agent);
        stillWaiting(event, agent);
        continue;
      }
      let paused;
      try {
        paused = await api.request("POST", `/api/agents/${agent.id}/pause`, {});
      } catch (err) {
        once(`limit-pause-failed:${event.runId}:${agent.id}`, () =>
          log.warn("watchdog: couldn't pause an agent at its usage limit", { agent: agent.name, error: err.message }),
        );
        continue;
      }
      const pausedAt = paused?.pausedAt ?? new Date(now()).toISOString();
      event.paused[agent.id] = { name: agent.name, pausedAt, tries: 0 };
      // The rest of this tick (the resume sweep's pause tracking) sees it paused.
      Object.assign(agent, { status: paused?.status ?? "paused", pausedAt });
      stats.limitPauses += 1;
      log(`watchdog: paused an agent until its ${label(event)} ${event.what ?? "usage limit"} resets`, { agent: agent.name, resetAt: new Date(event.resetAt).toISOString() });
    }
    save(event);
    if (!event.notified && Object.keys(event.paused).length) await notify(event, agents, waiting);
  }

  // Tells the board once per event (board-note.mjs).
  async function notify(event, agents, waiting) {
    const paused = Object.values(event.paused).map((p) => p.name);
    const adapter = event.adapter ?? "claude_local";
    const name = label(event);
    // Agents on other adapters: named by adapter when it has a recogniser.
    const others = [...agents.values()].filter((a) => a.adapterType !== adapter && !asleep(a));
    const otherLabels = [...new Set(others.filter((a) => RECOGNISERS.has(a.adapterType)).map((a) => labelOf(a.adapterType)))];
    const resumeAt = resetLabel(event.resetAt + graceMs, event.timeZone);
    const what = event.what ?? "usage limit";
    const text =
      `${name} ${what} reached: ${plural(paused.length, "agent")} paused (${names(paused)})` +
      `${waiting.length ? `, and ${plural(waiting.length, "more")} once ${waiting.length === 1 ? "its" : "their"} current run ends (${names(waiting.map((a) => a.name))})` : ""}. ` +
      (event.unknownReset
        ? `${name} didn't say when the limit resets, so the watchdog resumes them at ${resumeAt} to try again.`
        : `The limit resets ${resetLabel(event.resetAt, event.timeZone)}; the watchdog resumes them at ${resumeAt}.`) +
      `${otherLabels.length ? ` ${otherLabels.join(" and ")} agents are unaffected and keep working.` : others.length ? " Agents on other adapters keep working." : ""}` +
      " An agent you pause yourself stays paused.";
    event.notified = true;
    save(event);
    await noteToBoard({ api, config, log }, event.companyId, text);
  }

  // Resumes the agents the watchdog paused, unless a person has paused one since
  // (a later pausedAt) or resumed it already. A refused resume is tried again each
  // tick, up to MAX_RESUME_TRIES; the event ends once none is left to resume.
  async function resume(event, agents) {
    if (config.dryRun) return;
    for (const [id, entry] of Object.entries(event.paused)) {
      const { name, pausedAt } = entry;
      let agent = agents.get(id);
      if (!agent) agent = await api.request("GET", `/api/agents/${id}`).catch(() => null);
      if (!agent) continue; // can't tell now: next tick
      if (agent.status !== "paused" || Math.abs(ts(agent.pausedAt) - ts(pausedAt)) > PAUSE_MATCH_MS || (agent.pauseReason && agent.pauseReason !== "manual")) {
        if (agent.status === "paused") log("watchdog: an agent paused for a usage limit was paused again since; leaving it paused", { agent: name });
        delete event.paused[id];
        continue;
      }
      try {
        const resumed = await api.request("POST", `/api/agents/${id}/resume`, {});
        Object.assign(agent, { status: resumed?.status ?? "idle", pausedAt: resumed?.pausedAt ?? null });
        delete event.paused[id];
        stats.limitResumes += 1;
        log("watchdog: resumed an agent after its usage limit reset", { agent: name });
      } catch (err) {
        entry.tries = (entry.tries ?? 0) + 1;
        const giveUp = entry.tries >= MAX_RESUME_TRIES;
        log.warn(`watchdog: couldn't resume an agent after its usage limit reset${giveUp ? "; resume it yourself" : "; trying again next tick"}`, { agent: name, error: err.message });
        if (giveUp) delete event.paused[id];
      }
    }
    if (!Object.keys(event.paused).length) event.resumedAt = now();
    save(event);
  }

  return { check };
}
