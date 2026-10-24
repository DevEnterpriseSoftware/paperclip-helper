// Cost sync: API-equivalent cost of subscription runs.
//
// Paperclip records $0 for every run billed to a subscription: it zeroes the
// cost of runs whose billingType is "subscription_included" on purpose. Runs
// billed to an API key ("metered_api") keep their real cost and are never
// touched here. For each finished subscription run this adds what the run would
// have cost on the API, as one extra cost event (or, while under a cent, carried
// into a later one; see assignCents):
//
//   * Claude Code reports that figure itself; Paperclip keeps it on the run
//     (usageJson.costUsd / cacheAdjustedCostUsd).
//   * Codex reports only tokens, so the cost is estimated from the run's model
//     and OpenAI's list prices (prices.mjs), doubled for fast mode.
//
// Each event has zero tokens (the run's own event already counted them), the
// run's heartbeatRunId (so run counts and project attribution stay right), and
// the run's provider, biller and model (so it lands in the same Costs rows).
//
// Posted events count toward budgets and can't be deleted, so idempotency is
// careful: a run is recorded as "in flight" before its post and as synced after.
// A run whose post had an unknown outcome is never posted again.

import { every, UUID } from "./util.mjs";
import { estimateUsd, loadPrices, normalizeModel, priceFor, splitTokens } from "./prices.mjs";
import { readJson, writeJson } from "./store.mjs";
import { companyAgents } from "./paperclip.mjs";

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const RUN_WINDOW = 1000; // Paperclip returns at most this many runs, newest first
const PROVIDER_OF = { claude_local: "anthropic", codex_local: "openai" };
const unknown = (v) => !v || v === "unknown";
// How far a Claude run's token price must exceed its reported cost before the
// reported cost is taken as wrong: wide, so price-table slack never raises a run.
const RAISE_MARGIN = 0.1;
// Codex models whose fast mode Paperclip applies (codex-local, CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS).
const CODEX_FAST_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
// A run whose post keeps ending with an unknown outcome is given up after this many retries.
const MAX_INFLIGHT_RETRIES = 5;
// Rejections that are about the event itself, so posting it again won't help.
const FINAL_REJECTIONS = new Set([400, 404, 422]);
// Cost events carry this key plus the run id, so Paperclip records each run once
// even when a post is repeated (Paperclip 2026.10 and later honour it).
export const IDEMPOTENCY_PREFIX = "pch-cost-sync:";

// ------------------------------------------------------------------ state

// { version: 2, companies: { [id]: { floor, synced: { runId: finishedAt } } },
//   inflight: { runId: { at, companyId, finishedAt, body, carry } } (older files: { runId: at }),
//   skipped: { runId: reason }, idempotent: Paperclip honours idempotency keys,
//   carry: { "agent|provider|biller|model": fraction of a cent not yet posted } }
function normalizeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  return {
    version: 2,
    companies: state.companies ?? {},
    inflight: state.inflight ?? {},
    skipped: state.skipped ?? {},
    carry: state.carry && typeof state.carry === "object" ? state.carry : {},
    idempotent: state.idempotent === true,
  };
}

// A Claude run's cost from what it reported and what its tokens cost at list
// price (floor). The reported cost stands unless the floor is clearly higher.
export function claudeCost({ reported = null, floor = null }) {
  if (reported !== null && (floor === null || floor <= reported * (1 + RAISE_MARGIN))) return { usd: reported, basis: "reported" };
  if (floor === null) return { usd: null, basis: "unpriced" };
  return { usd: floor, basis: "token floor" };
}

// Paperclip stored whole cents until 2026.10 (it now takes fractions), and a run
// on a cheap model often costs a fraction of one. Each run's exact cost is added to what's carried for the
// same agent, provider, biller and model; whole cents are posted and the rest
// waits for the next run, so totals stay within a cent of the exact sum.
const carryKey = (post) => [post.agentId, post.provider, post.biller, post.model].join("|");

function assignCents(state, item) {
  const key = carryKey(item.post);
  const exact = item.usd * 100 + (state.carry[key] ?? 0);
  const whole = Math.floor(exact + 1e-9);
  item.post.costCents = whole;
  item.carry = { key, rest: Math.max(0, exact - whole) };
  return whole;
}

export function createCostSync(ctx) {
  const { config, api, log } = ctx;
  const stats = { ticks: 0, lastTickAt: null, posted: 0, postedCents: 0, lastError: null, unpriced: {} };
  const warnedModels = new Set();

  function loadState() {
    // A missing file and a corrupt one (readJson moves it aside) are both
    // fresh, so the lost-state guard in tick() runs for either.
    const raw = readJson(config.costStateFile, null);
    return { state: normalizeState(raw), fresh: raw === null };
  }
  const saveState = (state) => writeJson(config.costStateFile, state);

  function companyState(state, companyId) {
    state.companies[companyId] ??= { floor: null, synced: {} };
    return state.companies[companyId];
  }

  // Runs finished before this are never synced.
  function floorOf(state, companyId) {
    const floor = state.companies[companyId]?.floor ?? null;
    const since = config.costSyncSince;
    if (!floor) return since;
    if (!since) return floor;
    return Date.parse(floor) > Date.parse(since) ? floor : since;
  }

  // Did this user post cost events to the company before? Used when the state
  // file is missing, so a lost data directory doesn't post everything twice.
  async function postedBefore(companyId, userId) {
    const rows = await api.request("GET", `/api/companies/${companyId}/activity?entityType=cost_event&limit=500`);
    const list = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
    return list.some((a) => a?.action === "cost.reported" && a?.actorType === "user" && a?.actorId === userId);
  }

  const prices = () => loadPrices(config.costPricesFile, log);

  // Whether a Codex run used fast mode (twice the price), from the run's own
  // record rather than the agent's current setting: the ACP engine stores
  // resultJson.fastMode, and the CLI engine's adapter.invoke event carries
  // service_tier="fast" only when it applied fast mode (Paperclip ignores the
  // setting for models that don't support it). With neither record, the agent's
  // setting. null when Paperclip didn't answer: the run waits for the next pass.
  async function fastModeOf(run, agent, detail) {
    if (agent?.adapterType !== "codex_local") return false;
    // The ACP engine records the requested setting; Paperclip applies it only on models that have fast mode.
    if (typeof detail?.resultJson?.fastMode === "boolean") {
      const model = normalizeModel(run.usageJson?.model ?? agent?.adapterConfig?.model ?? "");
      return detail.resultJson.fastMode && (!model || model === "unknown" || CODEX_FAST_MODELS.has(model));
    }
    const events = await recordOf(`/api/heartbeat-runs/${run.id}/events?limit=1000`);
    if (events === undefined) return null;
    const invokes = (Array.isArray(events) ? events : []).filter((e) => e?.eventType === "adapter.invoke");
    // Each attempt logs its own invoke; the last one is the attempt that finished.
    const args = invokes.at(-1)?.payload?.commandArgs;
    if (Array.isArray(args)) return args.some((a) => /^service_tier\s*=\s*"?fast"?$/.test(String(a)));
    return agent?.adapterConfig?.fastMode === true;
  }

  // A GET whose 404 means there's no record (null); any other failure is unknown (undefined).
  async function recordOf(apiPath) {
    try {
      return await api.request("GET", apiPath);
    } catch (err) {
      return err.status === 404 ? null : undefined;
    }
  }

  // The run's model for pricing: the recorded one, else (when Paperclip recorded
  // nothing) the agent's configured model. "mixed" (a Claude run that used more
  // than one model) has no single price: see tokenPrice.
  function pricingModel(u, agent, adapter) {
    if (u.model === "mixed") return null;
    if (!unknown(u.model)) return u.model;
    const configured = agent?.adapterConfig?.model;
    if (typeof configured === "string" && configured.trim() && !unknown(configured)) return configured;
    if (adapter === "codex_local" && config.codexDefaultModel) return config.codexDefaultModel;
    return null;
  }

  // What the run's tokens cost at list price: { usd, model }, or { unpriced } when
  // a model has no price. A run Paperclip split by model (usageByModel) is priced
  // model by model; a "mixed" run without the split isn't priced at all, since
  // pricing a cheaper subagent model's tokens at the main model's price overstates
  // it. With upper, every cache write the split can't separate is priced as a
  // write: the most the floor can come to, without fetching the run.
  function tokenPrice(u, agent, adapter, table, at, detail, { upper = false } = {}) {
    const parts = Array.isArray(u.usageByModel) ? u.usageByModel.filter((p) => p && typeof p.model === "string") : [];
    if (parts.length) {
      let usd = 0;
      for (const part of parts) {
        const price = priceFor(table, part.model, at);
        if (!price) return { unpriced: part.model };
        const t = splitTokens(part.usage, adapter);
        usd += estimateUsd(price, upper ? { ...t, input: 0, cacheWrite: t.input } : t);
      }
      return { usd, model: null };
    }
    const model = pricingModel(u, agent, adapter);
    if (!model) return { unpriced: u.model === "mixed" ? "mixed" : "unknown" };
    const price = priceFor(table, model, at);
    if (!price) return { unpriced: model };
    const t = splitTokens(u, adapter, upper ? null : detail?.resultJson?.usage);
    return { usd: estimateUsd(price, upper ? { ...t, input: 0, cacheWrite: t.input } : t), model: price.model };
  }

  // What to do with one run: { post } with the event, or { skip, final } (final:
  // never look at it again), or null when it isn't a subscription run of ours.
  //
  // Claude: the reported cost, unless the run's tokens clearly cost more at list
  // price; they can't have cost less, so a lower figure is wrong. That happens
  // with the ACP engine, whose cost for a run is the growth of its session's
  // running cost: when the agent process restarted, the running cost restarted
  // too, and the growth understates the run. A run that stopped before Claude
  // reported a cost (killed, timed out) is priced from its tokens, at its model.
  async function evaluate(run, agent, table, nowMs) {
    if (!TERMINAL_RUN.has(run.status)) return { skip: "not finished", final: false };
    const finishedAt = run.finishedAt ?? null;
    if (!finishedAt) return { skip: "not finished", final: false };
    if (nowMs - Date.parse(finishedAt) < config.costSyncSettleSec * 1000) return { skip: "settling", final: false };
    const u = run.usageJson;
    // Stopped and failed runs often record no usage at all; nothing to sync.
    if (!u || typeof u !== "object") return null;
    if (u.billingType !== "subscription_included") return null; // API-key and other runs: Paperclip has the cost
    const adapter = agent?.adapterType ?? null;
    if (!adapter || !config.costSyncAdapters.includes(adapter)) return null;

    const provider = unknown(u.provider) ? PROVIDER_OF[adapter] ?? "unknown" : u.provider;
    const biller = unknown(u.biller) ? (provider === "openai" ? "chatgpt" : provider) : u.biller;
    let model = unknown(u.model) ? null : u.model;
    const raw = typeof u.cacheAdjustedCostUsd === "number" ? u.cacheAdjustedCostUsd : u.costUsd;
    const reported = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    const claude = provider === "anthropic";

    let usd = null;
    let basis = "reported";
    let floor = null;
    if (claude && reported !== null) {
      usd = reported;
      // Cheap check first: could the tokens cost clearly more than reported? Only
      // then fetch the run for the exact split of cache writes.
      const most = tokenPrice(u, agent, adapter, table, finishedAt, null, { upper: true });
      if (most.usd > reported * (1 + RAISE_MARGIN)) {
        const detail = await recordOf(`/api/heartbeat-runs/${run.id}`);
        if (detail === undefined) return { skip: "run details unavailable (Paperclip didn't answer)", final: false };
        floor = tokenPrice(u, agent, adapter, table, finishedAt, detail).usd ?? null;
        ({ usd, basis } = claudeCost({ reported, floor }));
      }
    } else if (reported !== null) {
      usd = reported;
    } else {
      const tokens = splitTokens(u, adapter);
      if (!tokens.input && !tokens.cacheRead && !tokens.output) return { skip: "no cost or tokens", final: true };
      const quick = tokenPrice(u, agent, adapter, table, finishedAt, null);
      if (quick.unpriced === "unknown") {
        const hint = adapter === "codex_local" ? " (set CODEX_DEFAULT_MODEL to price it)" : "";
        return { skip: `model unknown${hint}`, final: false, unpriced: "unknown" };
      }
      if (quick.unpriced === "mixed") return { skip: "used several models and reported no cost", final: true };
      if (quick.unpriced) return { skip: `no price for ${quick.unpriced}`, final: false, unpriced: quick.unpriced };
      const detail = await recordOf(`/api/heartbeat-runs/${run.id}`);
      if (detail === undefined) return { skip: "run details unavailable (Paperclip didn't answer)", final: false };
      const fast = await fastModeOf(run, agent, detail);
      if (fast === null) return { skip: "fast mode unknown (Paperclip didn't answer)", final: false };
      const priced = tokenPrice(u, agent, adapter, table, finishedAt, detail);
      usd = priced.usd * (fast ? 2 : 1);
      model ??= priced.model;
      basis = claude ? "token floor" : "estimated";
    }
    if (!(usd > 0)) return { skip: "no cost", final: true };
    const issueId = run.contextSnapshot?.issueId;
    return {
      usd,
      basis,
      reported,
      floor,
      post: {
        idempotencyKey: `${IDEMPOTENCY_PREFIX}${run.id}`,
        agentId: run.agentId,
        heartbeatRunId: run.id,
        ...(typeof issueId === "string" && UUID.test(issueId) ? { issueId } : {}),
        provider,
        biller,
        billingType: "subscription_included",
        costStatus: basis === "reported" ? "reported" : "estimated",
        model: model ?? "unknown",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: null, // set by assignCents, with the carried remainder
        occurredAt: new Date(finishedAt).toISOString(),
      },
    };
  }

  async function agentsOf(companyId) {
    return new Map((await companyAgents(api, companyId)).map((a) => [a.id, a]));
  }

  // The company's agent list leaves out terminated agents, whose runs still count.
  async function agentOf(agents, id) {
    if (id && !agents.has(id)) agents.set(id, await api.request("GET", `/api/agents/${id}`).catch(() => null));
    return agents.get(id) ?? null;
  }

  // Every run of the company Paperclip will show us, with what to do about it.
  async function scan(companyId, state, table, nowMs) {
    const agents = await agentsOf(companyId);
    const runs = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?limit=${RUN_WINDOW}`);
    const list = Array.isArray(runs) ? runs : [];
    const cs = companyState(state, companyId);
    const floor = floorOf(state, companyId);
    const items = [];
    for (const run of list) {
      if (cs.synced[run.id] !== undefined || state.inflight[run.id] || state.skipped[run.id]) continue;
      if (floor && run.finishedAt && Date.parse(run.finishedAt) < Date.parse(floor)) continue;
      const agent = await agentOf(agents, run.agentId);
      const verdict = await evaluate(run, agent, table, nowMs);
      if (verdict) items.push({ run, agent, ...verdict });
    }
    return { items, list, agents };
  }

  // After a full pass: runs older than the oldest one Paperclip still shows
  // can't come back, so move the floor up and forget their ids.
  function advanceFloor(state, companyId, list) {
    const cs = companyState(state, companyId);
    if (list.length < RUN_WINDOW) return; // we see every run the company has
    const oldest = list
      .map((r) => Date.parse(r.finishedAt ?? r.createdAt ?? ""))
      .filter(Number.isFinite)
      .reduce((a, b) => Math.min(a, b), Infinity);
    if (!Number.isFinite(oldest)) return;
    if (!cs.floor || oldest > Date.parse(cs.floor)) cs.floor = new Date(oldest).toISOString();
    const floorMs = Date.parse(cs.floor);
    for (const [id, at] of Object.entries(cs.synced)) if (at && Date.parse(at) < floorMs) delete cs.synced[id];
  }

  // Posts one run's event. Before the post the run is recorded as in flight,
  // with the exact body: a crash or an unknown outcome then means "maybe posted".
  // Once Paperclip has shown it honours idempotency keys (state.idempotent), such
  // a run is posted again with the same body and key, and Paperclip records it at
  // most once. Without that, it is never posted again.
  async function post(state, companyId, item) {
    const runId = item.run.id;
    state.inflight[runId] = { at: new Date().toISOString(), companyId, finishedAt: item.run.finishedAt, body: item.post, carry: item.carry };
    saveState(state);
    return send(state, companyId, runId, item.post, item.carry, item.run.finishedAt);
  }

  async function send(state, companyId, runId, first, carry, finishedAt) {
    let body = first;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const res = await api.request("POST", `/api/companies/${companyId}/cost-events`, body);
        // Re-checked on every post, so a Paperclip that stops keeping keys (downgraded, restored) is noticed.
        if (body.idempotencyKey) state.idempotent = res?.idempotencyKey === body.idempotencyKey;
        delete state.inflight[runId];
        companyState(state, companyId).synced[runId] = finishedAt;
        state.carry[carry.key] = carry.rest;
        saveState(state);
        return true;
      } catch (err) {
        if (err.status === 409 && body.idempotencyKey) {
          // The key is taken by a different receipt: an earlier post of this run
          // was recorded (with other figures). Count the run as synced.
          delete state.inflight[runId];
          companyState(state, companyId).synced[runId] = finishedAt;
          state.carry[carry.key] = carry.rest;
          saveState(state);
          log.warn("cost sync: Paperclip already has a cost event for this run; not posting another", { run: runId });
          return false;
        }
        if (err.status >= 400 && err.status < 500 && body.issueId && attempt === 1) {
          const { issueId: _gone, ...rest } = body; // the issue may be gone: post without it
          body = rest;
          if (state.inflight[runId]) state.inflight[runId].body = body;
          continue;
        }
        if (err.status >= 400 && err.status < 500 && !FINAL_REJECTIONS.has(err.status)) {
          // Not this event's fault (the key was revoked, too many requests): nothing
          // was recorded, so the run is posted again next pass.
          delete state.inflight[runId];
          saveState(state);
          throw err;
        }
        if (err.status >= 400 && err.status < 500) {
          delete state.inflight[runId];
          state.skipped[runId] = `rejected: ${err.message}`.slice(0, 300);
          saveState(state);
          log.error("cost sync: Paperclip rejected a cost event; skipping that run", { run: runId, error: err.message });
          return false;
        }
        if (err.status >= 500 || err.neverSent) {
          delete state.inflight[runId]; // not recorded: try again next time
          saveState(state);
        } else if (state.idempotent) {
          // Timed out or the connection dropped: it may have been recorded. The
          // in-flight entry keeps the body, and the next pass posts it again.
          log.warn("cost sync: unknown outcome of a cost post; it will be posted again with the same key", { run: runId, error: err.message });
        } else {
          state.carry[carry.key] = carry.rest;
          log.warn("cost sync: unknown outcome of a cost post; it won't be retried", { run: runId, error: err.message });
        }
        throw err;
      }
    }
  }

  // Runs still in flight: their post had an unknown outcome (a timeout, a dropped
  // connection, or the helper stopping mid-post). Post them again with the same
  // key when Paperclip honours keys; otherwise never post them again.
  async function settleInflight(state, posted) {
    for (const [runId, entry] of Object.entries(state.inflight)) {
      const retry = state.idempotent && entry && typeof entry === "object" && entry.body?.idempotencyKey && entry.companyId;
      if (!retry) {
        state.skipped[runId] = "unknown outcome (the post may have been recorded)";
        delete state.inflight[runId];
        log.warn("cost sync: a post's outcome is unknown; that run won't be posted again", { run: runId });
        continue;
      }
      if (config.dryRun) continue;
      entry.retries = (entry.retries ?? 0) + 1;
      if (entry.retries > MAX_INFLIGHT_RETRIES) {
        state.skipped[runId] = `unknown outcome after ${MAX_INFLIGHT_RETRIES} retries`;
        delete state.inflight[runId];
        log.warn("cost sync: a post kept ending with an unknown outcome; giving that run up", { run: runId });
        continue;
      }
      if (await send(state, entry.companyId, runId, entry.body, entry.carry, entry.finishedAt)) posted(entry.body.costCents);
    }
  }

  async function tick() {
    const started = Date.now();
    const { userId, companyIds = [] } = await ctx.identity();
    const { state, fresh } = loadState();
    const table = prices();
    const unpriced = {};
    let posted = 0;
    let cents = 0;
    let complete = true;

    try {
      await settleInflight(state, (c) => {
        posted += 1;
        cents += c;
      });
      for (const companyId of companyIds) {
        const cs = companyState(state, companyId);
        if (fresh && !config.costSyncSince && !cs.floor) {
          let before = true;
          try {
            before = await postedBefore(companyId, userId);
          } catch (err) {
            log.warn("cost sync: could not check for earlier cost posts", { company: companyId, error: err.message });
          }
          if (before) {
            cs.floor = new Date().toISOString();
            log.warn(
              "cost sync: no state file, but earlier cost events by you exist (or couldn't be checked); " +
                "syncing only runs that finish from now on, so nothing is posted twice. " +
                "Set COST_SYNC_SINCE to sync from an earlier date.",
              { company: companyId, stateFile: config.costStateFile },
            );
          }
        }
        const { items, list } = await scan(companyId, state, table, Date.now());
        // Oldest first, so carried fractions follow the order the runs finished.
        items.sort((a, b) => (Date.parse(a.run.finishedAt) || 0) - (Date.parse(b.run.finishedAt) || 0));
        for (const item of items) {
          if (item.unpriced && !warnedModels.has(item.unpriced)) {
            warnedModels.add(item.unpriced);
            log.warn(`cost sync: ${item.skip}; those runs are left unsynced`, { model: item.unpriced, pricesFile: config.costPricesFile });
          }
          if (item.unpriced) unpriced[item.unpriced] = (unpriced[item.unpriced] ?? 0) + 1;
          if (item.skip) {
            if (item.final) cs.synced[item.run.id] = item.run.finishedAt;
            continue;
          }
          if (assignCents(state, item) === 0) {
            // Less than a cent so far: carry it, and count the run as synced.
            state.carry[item.carry.key] = item.carry.rest;
            cs.synced[item.run.id] = item.run.finishedAt;
            continue;
          }
          if (config.dryRun) {
            log("cost sync: would post (dry run)", { run: item.run.id, agent: item.agent?.name, costCents: item.post.costCents, basis: item.basis });
            state.carry[item.carry.key] = item.carry.rest; // in memory only: dry runs save nothing
            continue;
          }
          if (await post(state, companyId, item)) {
            posted += 1;
            cents += item.post.costCents;
          }
        }
        advanceFloor(state, companyId, list);
      }
    } catch (err) {
      complete = false;
      stats.lastError = err.message;
      throw err;
    } finally {
      if (!config.dryRun) saveState(state);
      stats.ticks += 1;
      stats.lastTickAt = new Date(started).toISOString();
      stats.posted += posted;
      stats.postedCents += cents;
      stats.unpriced = unpriced;
      if (complete) stats.lastError = null;
      if (posted) log("cost sync: posted", { runs: posted, usd: (cents / 100).toFixed(2) });
    }
  }

  // `costs`: what cost sync would post for runs not yet synced (including ones
  // still settling), per agent in exact dollars, and how that moves budgets.
  // Changes nothing.
  async function preview({ print = console.log } = {}) {
    const { userId, companyIds = [] } = await ctx.identity();
    const { state, fresh } = loadState();
    const table = prices();
    let total = 0;
    let runs = 0;
    for (const companyId of companyIds) {
      const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => null);
      const { items } = await scan(companyId, state, table, Date.now() + config.costSyncSettleSec * 1000);
      const postable = items.filter((i) => i.post);
      const skipped = items.filter((i) => i.skip && !i.final);
      const byAgent = new Map();
      for (const i of postable) {
        const name = i.agent?.name ?? i.run.agentId;
        const row = byAgent.get(name) ?? { runs: 0, usd: 0, estimated: 0, raised: 0 };
        row.runs += 1;
        row.usd += i.usd;
        if (i.basis === "estimated") row.estimated += 1;
        if (i.basis === "token floor") row.raised += 1;
        byAgent.set(name, row);
      }
      const synced = Object.keys(state.companies[companyId]?.synced ?? {}).length;
      print(`${company?.name ?? companyId}: not yet synced (${synced} runs already synced)`);
      let sub = 0;
      for (const [name, row] of [...byAgent].sort((a, b) => b[1].usd - a[1].usd)) {
        const notes = [];
        if (row.estimated) notes.push(`${row.estimated} estimated from tokens`);
        if (row.raised) notes.push(`${row.raised} raised to what their tokens cost`);
        const note = notes.length ? `   (${notes.join("; ")})` : "";
        print(`  ${name.padEnd(20)} ${String(row.runs).padStart(5)} runs   $${row.usd.toFixed(2).padStart(9)}${note}`);
        sub += row.usd;
      }
      print(`  ${"Total".padEnd(20)} ${String(postable.length).padStart(5)} runs   $${sub.toFixed(2).padStart(9)}`);
      const reasons = new Map();
      for (const i of skipped) reasons.set(i.skip, (reasons.get(i.skip) ?? 0) + 1);
      for (const [reason, n] of reasons) if (reason !== "settling" && reason !== "not finished") print(`  not synced: ${n} runs, ${reason}`);
      if (fresh && !config.costSyncSince) {
        const before = await postedBefore(companyId, userId).catch(() => true);
        if (before) print("  Earlier cost events by you exist and there's no state file: only new runs will be synced (see COST_SYNC_SINCE).");
      }
      await budgetImpact(companyId, postable, print);
      total += sub;
      runs += postable.length;
    }
    if (companyIds.length > 1) print(`All companies: ${runs} runs, $${total.toFixed(2)}`);
  }

  // For each active company or agent budget the posts fall in, show the spend
  // before → after, and warn when that reaches the limit, loudly for a hard stop.
  async function budgetImpact(companyId, postable, print) {
    const overview = await api.request("GET", `/api/companies/${companyId}/budgets/overview`).catch(() => null);
    for (const p of overview?.policies ?? []) {
      if (!p.isActive || p.metric !== "billed_cents" || p.scopeType === "project") continue;
      const start = Date.parse(p.windowStart) || 0;
      const end = Date.parse(p.windowEnd) || Infinity;
      const adds = postable
        .filter((i) => p.scopeType === "company" || i.run.agentId === p.scopeId)
        .filter((i) => {
          const t = Date.parse(i.post.occurredAt);
          return t >= start && t < end;
        })
        .reduce((sum, i) => sum + i.usd * 100, 0);
      if (!adds) continue;
      const after = p.observedAmount + adds;
      const over = after >= p.amount;
      const line =
        `  budget "${p.scopeName}" (${p.scopeType}, ${p.windowKind}): $${(p.observedAmount / 100).toFixed(2)} → ` +
        `$${(after / 100).toFixed(2)} of $${(p.amount / 100).toFixed(2)}`;
      if (over && p.hardStopEnabled) print(`${line}. WARNING: this reaches the hard stop, so Paperclip would pause the ${p.scopeType === "company" ? "company" : "agent"}.`);
      else if (over) print(`${line}. Over budget (no hard stop).`);
      else print(line);
    }
  }

  // `costs --sessions`: is a resumed run's reported cost cumulative? Pairs each
  // resumed subscription run with the run it resumed (its sessionIdBefore is
  // that run's sessionIdAfter; Claude Code gives the resumed session a new id).
  // If the cost were cumulative, a resumed run would never cost less.
  async function sessions({ print = console.log, limit = 10 } = {}) {
    const { companyIds = [] } = await ctx.identity();
    const byAdapter = new Map();
    const samples = [];
    for (const companyId of companyIds) {
      const agents = await agentsOf(companyId);
      const runs = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?limit=${RUN_WINDOW}`);
      const list = Array.isArray(runs) ? runs : [];
      const byAfter = new Map(list.filter((r) => r.sessionIdAfter).map((r) => [r.sessionIdAfter, r]));
      for (const run of list) {
        const u = run.usageJson;
        if (u?.billingType !== "subscription_included" || typeof u.costUsd !== "number" || !run.sessionIdBefore) continue;
        const prev = byAfter.get(run.sessionIdBefore);
        if (!prev || prev.id === run.id || typeof prev.usageJson?.costUsd !== "number") continue;
        const adapter = agents.get(run.agentId)?.adapterType ?? "?";
        const row = byAdapter.get(adapter) ?? { pairs: 0, notLess: 0 };
        row.pairs += 1;
        if (u.costUsd >= prev.usageJson.costUsd) row.notLess += 1;
        byAdapter.set(adapter, row);
        if (samples.length < limit) samples.push(`  ${adapter}: $${prev.usageJson.costUsd.toFixed(3)} → resumed $${u.costUsd.toFixed(3)}`);
      }
    }
    if (!byAdapter.size) {
      print("No resumed subscription runs yet: nothing to compare.");
      return;
    }
    for (const line of samples) print(line);
    print("");
    for (const [adapter, row] of byAdapter) {
      const verdict =
        row.pairs < 5
          ? "too few to tell"
          : row.notLess === row.pairs
            ? "every resumed run cost at least as much as the run it resumed: the figures may be cumulative, so cost sync could over-count (please open an issue)"
            : "some resumed runs cost less than the run they resumed, so the figures are per run";
      print(`${adapter}: ${row.pairs} resumed runs, ${row.notLess} cost at least as much as the run they resumed; ${verdict}.`);
    }
  }

  // `costs --audit`: checks the figures. Changes nothing. For every subscription
  // run of the synced adapters that finished in the last `days` days, per agent:
  // tokens, the cost reported, what the tokens cost at list price, and what cost
  // sync posts (or would). Then what wasn't synced and why, and duplicates: runs
  // Paperclip listed twice, and runs this user posted more than one event for.
  async function audit({ print = console.log, days = 7 } = {}) {
    const { userId, companyIds = [] } = await ctx.identity();
    const { state } = loadState();
    const table = prices();
    const sinceMs = Date.now() - days * 86_400_000;
    const money = (n) => `$${n.toFixed(2)}`;
    const mtok = (n) => `${(n / 1e6).toFixed(1)}M`;
    for (const companyId of companyIds) {
      const company = await api.request("GET", `/api/companies/${companyId}`).catch(() => null);
      const agents = await agentsOf(companyId);
      const runs = await api.request("GET", `/api/companies/${companyId}/heartbeat-runs?limit=${RUN_WINDOW}`);
      const list = Array.isArray(runs) ? runs : [];
      const seen = new Map();
      for (const r of list) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
      const listedTwice = [...seen.values()].filter((n) => n > 1).length;
      const oldest = list.reduce((m, r) => Math.min(m, Date.parse(r.finishedAt ?? r.createdAt ?? "") || Infinity), Infinity);

      const picked = [];
      for (const run of list) {
        if (!TERMINAL_RUN.has(run.status) || !run.finishedAt || Date.parse(run.finishedAt) < sinceMs) continue;
        const u = run.usageJson;
        if (u?.billingType !== "subscription_included") continue;
        const agent = await agentOf(agents, run.agentId);
        if (!agent || !config.costSyncAdapters.includes(agent.adapterType)) continue;
        picked.push({ run, agent, u });
      }
      // Each run's own record, a few at a time.
      for (let i = 0; i < picked.length; i += 6) {
        await Promise.all(picked.slice(i, i + 6).map(async (p) => {
          p.detail = await recordOf(`/api/heartbeat-runs/${p.run.id}`);
        }));
      }

      const byAgent = new Map();
      const byProvider = new Map();
      const sync = { synced: 0, pending: 0, never: 0, skipped: new Map() };
      const floorOfCompany = floorOf(state, companyId);
      let unreadable = 0;
      for (const { run, agent, u, detail } of picked) {
        const adapter = agent.adapterType;
        const provider = unknown(u.provider) ? PROVIDER_OF[adapter] ?? "unknown" : u.provider;
        if (detail === undefined) unreadable += 1;
        const tokens = splitTokens(u, adapter, detail?.resultJson?.usage);
        const fast = adapter === "codex_local" ? (await fastModeOf(run, agent, detail)) === true : false;
        const priced = tokenPrice(u, agent, adapter, table, run.finishedAt, detail);
        const tokenUsd = priced.usd !== undefined ? priced.usd * (fast ? 2 : 1) : null;
        const raw = typeof u.cacheAdjustedCostUsd === "number" ? u.cacheAdjustedCostUsd : u.costUsd;
        const reported = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
        let posts = null;
        let basis = "unpriced";
        if (provider === "anthropic") ({ usd: posts, basis } = claudeCost({ reported, floor: tokenUsd }));
        else if (reported !== null) [posts, basis] = [reported, "reported"];
        else if (tokenUsd !== null) [posts, basis] = [tokenUsd, "estimated"];

        const key = agent.name ?? run.agentId;
        const a = byAgent.get(key) ?? { adapter, runs: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reported: 0, tokenUsd: 0, posts: 0, noCost: 0, low: 0, unpriced: 0 };
        a.runs += 1;
        a.input += tokens.input;
        a.cacheRead += tokens.cacheRead;
        a.cacheWrite += tokens.cacheWrite;
        a.output += tokens.output;
        a.reported += reported ?? 0;
        a.tokenUsd += tokenUsd ?? 0;
        a.posts += posts ?? 0;
        if (reported === null) a.noCost += 1;
        if (basis === "token floor" && reported !== null) a.low += 1;
        if (posts === null) a.unpriced += 1;
        byAgent.set(key, a);

        const pv = byProvider.get(provider) ?? { runs: 0, reported: 0, tokenUsd: 0, posts: 0, noCost: 0, floor: 0, unpriced: 0 };
        pv.runs += 1;
        pv.reported += reported ?? 0;
        pv.tokenUsd += tokenUsd ?? 0;
        pv.posts += posts ?? 0;
        if (reported === null) pv.noCost += 1;
        if (basis === "token floor" && reported !== null) pv.floor += 1;
        if (posts === null) pv.unpriced += 1;
        byProvider.set(provider, pv);

        if (state.companies[companyId]?.synced[run.id] !== undefined) sync.synced += 1;
        else if (state.skipped[run.id]) {
          const why = state.skipped[run.id].replace(/:.*/, "");
          sync.skipped.set(why, (sync.skipped.get(why) ?? 0) + 1);
        } else if (floorOfCompany && Date.parse(run.finishedAt) < Date.parse(floorOfCompany)) sync.never += 1;
        else sync.pending += 1;
      }

      print(`${company?.name ?? companyId}: subscription runs that finished in the last ${days} days (${picked.length} runs)`);
      if (Number.isFinite(oldest) && list.length >= RUN_WINDOW && oldest > sinceMs) {
        print(`  Paperclip lists only the latest ${RUN_WINDOW} runs, back to ${new Date(oldest).toISOString().slice(0, 16)}Z; older runs aren't counted here.`);
      }
      print(`  ${"Agent".padEnd(22)} ${"runs".padStart(5)} ${"input".padStart(8)} ${"c.read".padStart(8)} ${"c.write".padStart(8)} ${"output".padStart(8)} ${"reported".padStart(10)} ${"tokens".padStart(10)} ${"now".padStart(10)}`);
      for (const [name, a] of [...byAgent].sort((x, y) => y[1].posts - x[1].posts)) {
        const flags = [];
        if (a.noCost) flags.push(`${a.noCost} no cost reported`);
        if (a.low) flags.push(`${a.low} raised`);
        if (a.unpriced) flags.push(`${a.unpriced} unpriced`);
        print(
          `  ${name.slice(0, 22).padEnd(22)} ${String(a.runs).padStart(5)} ${mtok(a.input).padStart(8)} ${mtok(a.cacheRead).padStart(8)} ${mtok(a.cacheWrite).padStart(8)} ${mtok(a.output).padStart(8)} ` +
            `${money(a.reported).padStart(10)} ${money(a.tokenUsd).padStart(10)} ${money(a.posts).padStart(10)}${flags.length ? `   ${flags.join(", ")}` : ""}`,
        );
      }
      for (const [provider, pv] of byProvider) {
        print(`  ${provider}: ${pv.runs} runs; reported ${money(pv.reported)}; their tokens at list price ${money(pv.tokenUsd)}; cost sync would post ${money(pv.posts)} for them now.`);
        if (provider === "anthropic") {
          if (pv.noCost) print(`    ${pv.noCost} runs reported no cost (stopped before Claude reported one); priced from their tokens.`);
          if (pv.floor) print(`    ${pv.floor} runs reported more than 10% less than their tokens cost at list price; raised to the token price.`);
        }
        if (pv.unpriced) print(`    ${pv.unpriced} runs can't be priced (model unknown or not in the price table).`);
      }
      const skipped = [...sync.skipped].map(([why, n]) => `${n} ${why}`).join(", ");
      print(`  Sync state: ${sync.synced} synced, ${sync.pending} not yet${sync.never ? `, ${sync.never} before the sync start (never synced)` : ""}${skipped ? `, skipped: ${skipped}` : ""}.`);
      if (unreadable) print(`  ${unreadable} runs' details couldn't be read; their cache writes are priced as input.`);
      print(`  Idempotency keys: ${state.idempotent ? "honoured by this Paperclip" : "not confirmed yet (needs Paperclip 2026.10 or later and one post)"}.`);

      // Duplicates among this user's own cost posts (Paperclip's activity log keeps
      // the latest 500 per request).
      const acts = await api.request("GET", `/api/companies/${companyId}/activity?entityType=cost_event&limit=500`).catch(() => null);
      const rows = (Array.isArray(acts) ? acts : Array.isArray(acts?.items) ? acts.items : []).filter(
        (r) => r?.action === "cost.reported" && r?.actorType === "user" && r?.actorId === userId,
      );
      const perRun = new Map();
      for (const r of rows) {
        const id = r.runId ?? r.details?.heartbeatRunId;
        if (id) perRun.set(id, (perRun.get(id) ?? 0) + 1);
      }
      const twice = [...perRun].filter(([, n]) => n > 1);
      const window = rows.length ? ` (Paperclip's activity log shows the latest 500 cost events, so this covers only recent posts)` : "";
      const dupLine = !rows.length
        ? "no cost posts by you in the activity log"
        : !perRun.size
          ? `${rows.length} recent cost posts by you, but the log doesn't name their runs`
          : `${rows.length} recent cost posts by you cover ${perRun.size} runs; ${twice.length ? `${twice.length} runs were posted more than once: ${twice.slice(0, 5).map(([id]) => id).join(", ")}` : "none twice"}`;
      print(`  Duplicates: ${listedTwice ? `${listedTwice} runs listed twice by Paperclip` : "no run listed twice"}; ${dupLine}${window}.`);
    }
  }

  let loop = null;
  return {
    tick,
    preview,
    sessions,
    audit,
    evaluate,
    stats,
    start() {
      log("cost sync on", {
        everySec: config.costSyncIntervalSec,
        adapters: config.costSyncAdapters,
        since: config.costSyncSince,
        stateFile: config.costStateFile,
      });
      loop = every("cost sync", config.costSyncIntervalSec, 10_000, tick, log);
    },
    async stop() {
      await loop?.stop();
    },
  };
}
