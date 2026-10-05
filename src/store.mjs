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

export function fileExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

// A bounded map of key → timestamp-ish records, kept in memory and saved on demand.
// Oldest entries (by insertion) are dropped beyond `max`.
export class BoundedMap {
  constructor(entries = [], max = 1000) {
    this.max = max;
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
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
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
export function createStateStore(file, { now = () => Date.now() } = {}) {
  const raw = readJson(file, {}) ?? {};
  const deliveries = new BoundedMap(Object.entries(raw.deliveries ?? {}), 1000);
  const nudges = new BoundedMap(Object.entries(raw.nudges ?? {}), 2000);
  const conflicts = new BoundedMap(Object.entries(raw.conflicts ?? {}), 500);
  let dirty = false;
  const WEEK = 7 * 86_400_000;

  const store = {
    deliveries,
    nudges,
    conflicts,
    touch() {
      dirty = true;
    },
    save({ force = false } = {}) {
      if (!dirty && !force) return;
      // Forget nudge records nobody has touched for a week.
      for (const [key, value] of nudges.entries()) {
        if (now() - (value?.at ?? 0) > WEEK) nudges.delete(key);
      }
      writeJson(file, {
        version: 1,
        deliveries: Object.fromEntries(deliveries.entries()),
        nudges: Object.fromEntries(nudges.entries()),
        conflicts: Object.fromEntries(conflicts.entries()),
      });
      dirty = false;
    },
  };
  return store;
}
