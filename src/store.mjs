// Small JSON files in the data directory, written atomically (temp file + rename).

import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    if (err instanceof SyntaxError) {
      // Keep the unreadable file for inspection rather than silently losing it.
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch {}
      return fallback;
    }
    throw err;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A bounded map of key → timestamp-ish records, kept in memory and saved on demand.
// Oldest entries (by insertion) are dropped beyond `max`, except those `keep(key,
// value)` says to keep, unless nothing else is left to drop.
export class BoundedMap {
  constructor(entries = [], max = 1000, keep = null) {
    this.max = max;
    this.keep = keep;
    this.map = new Map(entries);
    this.trim();
  }
  get(key) {
    return this.map.get(key);
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    this.trim();
  }
  delete(key) {
    return this.map.delete(key);
  }
  trim() {
    if (this.map.size <= this.max) return;
    let excess = this.map.size - this.max;
    if (this.keep) {
      for (const [key, value] of this.map) {
        if (!excess) return;
        if (this.keep(key, value)) continue;
        this.map.delete(key);
        excess -= 1;
      }
    }
    while (excess-- > 0) this.map.delete(this.map.keys().next().value);
  }
  get size() {
    return this.map.size;
  }
  entries() {
    return [...this.map.entries()];
  }
}

// The helper's own state: relay deliveries, watchdog nudges and the PRs sent back
// for merge conflicts, so a restart neither re-processes a delivery, re-nudges
// an issue nor sends a PR back twice.
// Watchdog records that stand for something still going on, not a count of what was
// done: forgetting one would route a card again, miss an agent's resume, or leave
// agents paused at a usage limit. Kept past the cap.
const LIVE_RECORD = /^(agent-paused|agent-resumed|limit):/;
const keepRecord = (key, value) => LIVE_RECORD.test(key) || (key.startsWith("question:") && value?.relayId && !value.settled);

export function createStateStore(file, { now = () => Date.now() } = {}) {
  const raw = readJson(file, {}) ?? {};
  const deliveries = new BoundedMap(Object.entries(raw.deliveries ?? {}), 1000);
  const nudges = new BoundedMap(Object.entries(raw.nudges ?? {}), 2000, keepRecord);
  const conflicts = new BoundedMap(Object.entries(raw.conflicts ?? {}), 500);
  const queue = new BoundedMap(Object.entries(raw.queue ?? {}), 500); // merge-queue drops and who queued each PR
  let dirty = false;
  const WEEK = 7 * 86_400_000;

  const store = {
    deliveries,
    nudges,
    conflicts,
    queue,
    touch() {
      dirty = true;
    },
    save({ force = false } = {}) {
      if (!dirty && !force) return;
      // Forget nudge records nobody has touched for a week.
      // A question card routed to an issue that is still open is kept however
      // old: forgetting it would route the card again (watchdog.mjs, 10).
      for (const [key, value] of nudges.entries()) {
        if (key.startsWith("question:") && value?.relayId && !value.settled) continue;
        if (now() - (value?.at ?? 0) > WEEK) nudges.delete(key);
      }
      for (const [key, value] of queue.entries()) if (now() - (value?.at ?? 0) > WEEK) queue.delete(key);
      writeJson(file, {
        version: 1,
        deliveries: Object.fromEntries(deliveries.entries()),
        nudges: Object.fromEntries(nudges.entries()),
        conflicts: Object.fromEntries(conflicts.entries()),
        queue: Object.fromEntries(queue.entries()),
      });
      dirty = false;
    },
  };
  return store;
}
