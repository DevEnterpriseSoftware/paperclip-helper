// Watchdog 16: Claude usage limits (createLimitCheck; watchdog.mjs runs it each tick).
//
// When a Claude subscription hits its 5-hour or weekly limit (or an API org its
// spend limit), every agent on it fails its next run, and Paperclip keeps waking
// and retrying them: hundreds of failed runs before the limit resets. Paperclip
// files the failure as `claude_transient_upstream` (as of 2026.10) or, in newer
// source, `provider_quota`; the error text says which limit and when it resets:
// "You've hit your org's monthly spend limit · … · your weekly limit resets Oct 12,
// 4pm (Europe/London)". The same error codes cover real transient failures
// ("Claude exited with code 143"), so only the limit wording counts.

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
  if (run?.status !== "failed" || !LIMIT_CODES.has(run.errorCode)) return false;
  return LIMIT_TEXT.test(String(run.error ?? ""));
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

// A short, readable reset time for the board: in the zone Claude named.
export function resetLabel(at, timeZone = "UTC") {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(at));
  return `${text} (${timeZone})`;
}

// The newest limit failure per subscription among a company's runs, after `since`
// (per subscription). [{ key, run, agent }]
function latestLimitFailures(runs, agents, sinceByKey = new Map()) {
  const found = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const agent = agents.get(run.agentId);
    if (!isClaudeLimitFailure(run, agent)) continue;
    const key = subscriptionOf(agent);
    const at = ts(run.finishedAt ?? run.updatedAt ?? run.createdAt);
    if (at <= (sinceByKey.get(key) ?? 0)) continue;
    const prior = found.get(key);
    if (!prior || at > prior.at) found.set(key, { key, run, agent, at });
  }
  return [...found.values()];
}

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

// The check: pause the agents on a Claude account that hit its limit, each once it
// has no live run; tell the board once; resume exactly those agents at the reset.
// One record per company and account in the watchdog's records,
// `limit:<companyId>:<account>`: { resetAt, timeZone, unknownReset, waitMs, paused:
// { agentId: { name, pausedAt, tries } }, waitTicks: { agentId: ticks busy }, notified,
// runId, resumedAt }.
export function createLimitCheck({ api, config, log, records, state, now, stats, dryRunSeen }) {
  const graceMs = config.watchdogLimitResumeGraceMin * 60_000;
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
    for (const { key: account, run, agent, at } of latestLimitFailures(runs, agents, since)) {
      const prior = events.get(account);
      const event = startOrExtend(prior, { companyId, account, run, at });
      if (!event) continue;
      if (!prior || prior.resumedAt) {
        once(`limit-detected:${account}:${run.id}`, () =>
          log.warn("watchdog: a Claude account hit its usage limit; pausing its agents until it resets", {
            agent: agent.name, run: run.id, resetAt: new Date(event.resetAt).toISOString(), knownReset: !event.unknownReset,
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
  function startOrExtend(prior, { companyId, account, run, at }) {
    const reset = parseReset(run.error, at);
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
      companyId, account, runId: run.id, lastFailureAt: at,
      resetAt: active ? Math.max(prior.resetAt, resetAt) : resetAt,
      timeZone: reset?.timeZone ?? (active ? prior.timeZone : null) ?? "UTC",
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
      log.warn("watchdog: an agent at its Claude usage limit has had a run queued or going for a long time, so it hasn't been paused; pausing it yourself cancels that run", { agent: agent.name, ticks: LONG_WAIT_TICKS });
    }
  }

  // Pauses the account's agents that have no live run; returns those still busy.
  async function pauseIdle(event, agents, runs) {
    const members = [...agents.values()].filter((a) => subscriptionOf(a) === event.account);
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
        once(`limit-pause:${event.runId}:${agent.id}`, () => log("watchdog: would pause an agent until its Claude usage limit resets (dry run)", { agent: agent.name }));
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
          log.warn("watchdog: couldn't pause an agent at its Claude usage limit", { agent: agent.name, error: err.message }),
        );
        continue;
      }
      const pausedAt = paused?.pausedAt ?? new Date(now()).toISOString();
      event.paused[agent.id] = { name: agent.name, pausedAt, tries: 0 };
      // The rest of this tick (the resume sweep's pause tracking) sees it paused.
      Object.assign(agent, { status: paused?.status ?? "paused", pausedAt });
      stats.limitPauses += 1;
      log("watchdog: paused an agent until its Claude usage limit resets", { agent: agent.name, resetAt: new Date(event.resetAt).toISOString() });
    }
    save(event);
    if (!event.notified && Object.keys(event.paused).length) await notify(event, agents, waiting);
  }

  // Tells the board once per event (board-note.mjs).
  async function notify(event, agents, waiting) {
    const paused = Object.values(event.paused).map((p) => p.name);
    const others = [...agents.values()].filter((a) => a.adapterType !== "claude_local" && !asleep(a));
    const codex = others.some((a) => a.adapterType === "codex_local");
    const resumeAt = resetLabel(event.resetAt + graceMs, event.timeZone);
    const text =
      `Claude usage limit reached: ${plural(paused.length, "agent")} paused (${names(paused)})` +
      `${waiting.length ? `, and ${plural(waiting.length, "more")} once ${waiting.length === 1 ? "its" : "their"} current run ends (${names(waiting.map((a) => a.name))})` : ""}. ` +
      (event.unknownReset
        ? `Claude didn't say when the limit resets, so the watchdog resumes them at ${resumeAt} to try again.`
        : `The limit resets ${resetLabel(event.resetAt, event.timeZone)}; the watchdog resumes them at ${resumeAt}.`) +
      `${codex ? " Codex agents are unaffected and keep working." : others.length ? " Agents on other adapters keep working." : ""}` +
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
        if (agent.status === "paused") log("watchdog: an agent paused for a Claude usage limit was paused again since; leaving it paused", { agent: name });
        delete event.paused[id];
        continue;
      }
      try {
        const resumed = await api.request("POST", `/api/agents/${id}/resume`, {});
        Object.assign(agent, { status: resumed?.status ?? "idle", pausedAt: resumed?.pausedAt ?? null });
        delete event.paused[id];
        stats.limitResumes += 1;
        log("watchdog: resumed an agent after its Claude usage limit reset", { agent: name });
      } catch (err) {
        entry.tries = (entry.tries ?? 0) + 1;
        const giveUp = entry.tries >= MAX_RESUME_TRIES;
        log.warn(`watchdog: couldn't resume an agent after its Claude usage limit reset${giveUp ? "; resume it yourself" : "; trying again next tick"}`, { agent: name, error: err.message });
        if (giveUp) delete event.paused[id];
      }
    }
    if (!Object.keys(event.paused).length) event.resumedAt = now();
    save(event);
  }

  return { check };
}
