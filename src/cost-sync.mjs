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
import { estimateUsd, loadPrices, priceFor } from "./prices.mjs";
import { readJson, writeJson } from "./store.mjs";
import { companyAgents } from "./paperclip.mjs";

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const RUN_WINDOW = 1000; // Paperclip returns at most this many runs, newest first
const PROVIDER_OF = { claude_local: "anthropic", codex_local: "openai" };
const unknown = (v) => !v || v === "unknown";

// ------------------------------------------------------------------ state

// { version: 2, companies: { [id]: { floor, synced: { runId: finishedAt } } },
//   inflight: { runId: at }, skipped: { runId: reason },
//   carry: { "agent|provider|biller|model": fraction of a cent not yet posted } }
function normalizeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  return {
    version: 2,
    companies: state.companies ?? {},
    inflight: state.inflight ?? {},
    skipped: state.skipped ?? {},
    carry: state.carry && typeof state.carry === "object" ? state.carry : {},
  };
}

// Paperclip stores whole cents, and a run on a cheap model often costs a
// fraction of one. Each run's exact cost is added to what's carried for the
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
  async function fastModeOf(run, agent) {
    if (agent?.adapterType !== "codex_local") return false;
    const detail = await recordOf(`/api/heartbeat-runs/${run.id}`);
    if (detail === undefined) return null;
    if (typeof detail?.resultJson?.fastMode === "boolean") return detail.resultJson.fastMode;
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

  // What to do with one run: { post } with the event, or { skip, final } (final:
  // never look at it again), or null when it isn't a subscription run of ours.
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
    let usd = null;
    let basis = "reported";
    const reported = typeof u.cacheAdjustedCostUsd === "number" ? u.cacheAdjustedCostUsd : u.costUsd;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      usd = reported;
    } else {
      const tokens = {
        inputTokens: Number(u.inputTokens) || 0,
        cachedInputTokens: Number(u.cachedInputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
      };
      if (!tokens.inputTokens && !tokens.outputTokens) return { skip: "no cost or tokens", final: true };
      const priceModel = model ?? (adapter === "codex_local" && config.codexDefaultModel ? config.codexDefaultModel : null);
      if (!priceModel) return { skip: "model unknown (set CODEX_DEFAULT_MODEL to price it)", final: false, unpriced: "unknown" };
      const price = priceFor(table, priceModel, finishedAt);
      if (!price) return { skip: `no price for ${priceModel}`, final: false, unpriced: priceModel };
      const fast = await fastModeOf(run, agent);
      if (fast === null) return { skip: "fast mode unknown (Paperclip didn't answer)", final: false };
      usd = estimateUsd(price, tokens) * (fast ? 2 : 1);
      model ??= price.model;
      basis = "estimated";
    }
    if (!(usd > 0)) return { skip: "no cost", final: true };
    const issueId = run.contextSnapshot?.issueId;
    return {
      usd,
      basis,
      post: {
        agentId: run.agentId,
        heartbeatRunId: run.id,
        ...(typeof issueId === "string" && UUID.test(issueId) ? { issueId } : {}),
        provider,
        biller,
        billingType: "subscription_included",
        costStatus: "reported",
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

  async function post(state, companyId, item) {
    const runId = item.run.id;
    state.inflight[runId] = new Date().toISOString();
    saveState(state); // before the post: a crash now means "maybe posted", never "post again"
    let body = item.post;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await api.request("POST", `/api/companies/${companyId}/cost-events`, body);
        delete state.inflight[runId];
        companyState(state, companyId).synced[runId] = item.run.finishedAt;
        state.carry[item.carry.key] = item.carry.rest;
        saveState(state);
        return true;
      } catch (err) {
        if (err.status >= 400 && err.status < 500 && body.issueId && attempt === 1) {
          const { issueId: _gone, ...rest } = body; // the issue may be gone: post without it
          body = rest;
          continue;
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
        } else {
          // Timed out or the connection dropped: it may have been recorded.
          state.carry[item.carry.key] = item.carry.rest;
          log.warn("cost sync: unknown outcome of a cost post; it won't be retried", { run: runId, error: err.message });
        }
        throw err;
      }
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

    // Runs still "in flight" had a post with an unknown outcome (a timeout, a
    // dropped connection, or the helper stopping mid-post). It may have been
    // recorded, so never post them again.
    for (const [runId] of Object.entries(state.inflight)) {
      state.skipped[runId] = "unknown outcome (the post may have been recorded)";
      delete state.inflight[runId];
      log.warn("cost sync: a post's outcome is unknown; that run won't be posted again", { run: runId });
    }

    try {
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
        const row = byAgent.get(name) ?? { runs: 0, usd: 0, estimated: 0 };
        row.runs += 1;
        row.usd += i.usd;
        if (i.basis === "estimated") row.estimated += 1;
        byAgent.set(name, row);
      }
      const synced = Object.keys(state.companies[companyId]?.synced ?? {}).length;
      print(`${company?.name ?? companyId}: not yet synced (${synced} runs already synced)`);
      let sub = 0;
      for (const [name, row] of [...byAgent].sort((a, b) => b[1].usd - a[1].usd)) {
        const note = row.estimated ? `   (${row.estimated} estimated from tokens)` : "";
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

  let loop = null;
  return {
    tick,
    preview,
    sessions,
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
