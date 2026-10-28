// One watchdog tick's reads from Paperclip, shared between its checks, and what
// each check cost.
//
// A tick runs its checks one after another, and several read the same things: the
// issue in full (GET /api/issues/:id), its runs, the open-issue list (once per
// status filter). Paperclip's per-issue run list is one of its costlier answers
// (the issue's whole run history, matched against its activity log), and asked
// once per check it made most of a tick's time. Within a tick, a read is made once
// and its answer handed to every check that asks again.
//
// Only another check's read is shared. A check that asks again for what it read
// itself is reading it again on purpose (to see whether it changed before acting
// on it), so that goes to Paperclip, and is what later checks then share. Anything
// a check changes (a comment, a PATCH, any request but a read) drops every shared
// answer, so no check acts on what the tick read before a change; nor on an answer
// older than maxAgeMs. Each caller gets its own copy, so a check that sorts or edits
// what it got can't change what another one sees. Issue listings are shared by every
// check alike: a check acts on a listing's rows only after reading the issue itself.
// Outside a tick (begin/end) every request goes straight to Paperclip.
//
// It also counts, per check, how long it took and how many requests it made, and
// per kind of request (method and path, ids left out) how many there were and how
// long they took: `pch status` shows the slowest of each.
//
// Paperclip's own ETags don't help here: it sends them only on the per-issue
// routes, made by hashing the answer it has already built, so a 304 saves the
// transfer and none of the work.

// Every open status: a listing of any of them is filtered from one listing of all.
export const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const OPEN = new Set(OPEN_ISSUE_STATUSES);
const DEFAULT_MAX_AGE_MS = 30_000;

// "GET /api/issues/:id/runs": the request without its ids or query.
export function requestKind(method, apiPath) {
  const p = String(apiPath)
    .replace(/\?.*$/, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/[A-Z][A-Z0-9]*-\d+(?=\/|$)/g, "/:id");
  return `${method} ${p}`;
}

const copy = (value) => (value === null || typeof value !== "object" ? value : structuredClone(value));

export function createTickReads(api, { clock = () => performance.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  let shared = null; // path → { at, answer: Promise }, while a tick is on
  let tick = null; // this tick's counts
  let check = null; // the check now running: { name, ms, requests, seen: the paths it has asked for }

  const fresh = () => ({ requests: 0, shared: 0, kinds: new Map(), checks: [] });

  async function timed(method, apiPath, body, options) {
    const started = clock();
    try {
      return await api.request(method, apiPath, body, options);
    } finally {
      if (tick) {
        const ms = clock() - started;
        tick.requests += 1;
        if (check) check.requests += 1;
        const kind = requestKind(method, apiPath);
        const k = tick.kinds.get(kind) ?? { kind, count: 0, ms: 0, maxMs: 0 };
        k.count += 1;
        k.ms += ms;
        k.maxMs = Math.max(k.maxMs, ms);
        tick.kinds.set(kind, k);
      }
    }
  }

  async function request(method, apiPath, body, options = {}) {
    // A request made with another key, or a change, is never shared; a change drops
    // what was read before it, and again once it is done (a read that started while
    // it was on may have seen either side of it).
    if (!shared || method !== "GET" || body !== undefined || options.token !== undefined) {
      if (method !== "GET") shared?.clear();
      try {
        return await timed(method, apiPath, body, options);
      } finally {
        if (method !== "GET") shared?.clear();
      }
    }
    const hit = shared.get(apiPath);
    // Asked before by this check (answered from Paperclip or from another check's read): again on purpose.
    const again = Boolean(check?.seen.has(apiPath));
    check?.seen.add(apiPath);
    if (hit && !again && clock() - hit.at < maxAgeMs) {
      tick.shared += 1;
      return copy(await hit.answer);
    }
    const answer = timed(method, apiPath, body, options);
    const entry = { at: clock(), answer };
    shared.set(apiPath, entry);
    // A failed read is shared too: asking again this tick would only wait for the same timeout.
    answer.catch(() => {});
    return copy(await answer);
  }

  // listIssues() asks here first (paperclip.mjs): one listing of every open status
  // per company and tick, filtered for each caller; other statuses as asked.
  async function listing(companyId, statuses, fetchRows) {
    const wanted = String(statuses).split(",").map((s) => s.trim()).filter(Boolean);
    if (!shared || !wanted.length || !wanted.every((s) => OPEN.has(s))) return fetchRows(statuses);
    const key = `listing:${companyId}`;
    let hit = shared.get(key);
    if (!hit || clock() - hit.at >= maxAgeMs) {
      hit = { at: clock(), answer: fetchRows(OPEN_ISSUE_STATUSES.join(",")) };
      hit.answer.catch(() => {});
      shared.set(key, hit);
    } else {
      tick.shared += 1;
    }
    let rows;
    try {
      rows = await hit.answer;
    } catch {
      // Paperclip refused the whole listing: each check asks for its own, as without
      // the shared listing, so one refusal fails no more checks than it did before.
      return fetchRows(statuses);
    }
    const want = new Set(wanted);
    return copy(rows.filter((r) => want.has(r?.status)));
  }

  return {
    // The client the watchdog and its checks use: Paperclip's, with reads shared during a tick.
    api: { ...api, request, sharedListing: listing, get base() { return api.base; }, whoAmI: (...a) => api.whoAmI?.(...a) },
    begin() {
      shared = new Map();
      tick = fresh();
      check = null;
    },
    // Runs fn as the check `name`, timing it.
    async within(name, fn) {
      const c = { name, ms: 0, requests: 0, seen: new Set() };
      const started = clock();
      check = c;
      try {
        return await fn();
      } finally {
        c.ms = clock() - started;
        check = null;
        if (tick) {
          // The same check for another company adds to its first entry.
          const prior = tick.checks.find((x) => x.name === name);
          if (prior) {
            prior.ms += c.ms;
            prior.requests += c.requests;
          } else tick.checks.push(c);
        }
      }
    },
    // This tick's counts, for the status file: the slowest checks and kinds of request first.
    end({ top = 5 } = {}) {
      const t = tick;
      shared = null;
      tick = null;
      check = null;
      if (!t) return null;
      const round = (ms) => Math.round(ms);
      return {
        requests: t.requests,
        shared: t.shared,
        checks: t.checks
          .filter((c) => c.ms >= 1 || c.requests)
          .sort((a, b) => b.ms - a.ms)
          .slice(0, top)
          .map((c) => ({ name: c.name, ms: round(c.ms), requests: c.requests })),
        slowest: [...t.kinds.values()]
          .sort((a, b) => b.ms - a.ms)
          .slice(0, top)
          .map((k) => ({ kind: k.kind, count: k.count, ms: round(k.ms), avgMs: round(k.ms / k.count), maxMs: round(k.maxMs) })),
      };
    },
  };
}
