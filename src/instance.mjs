// Is a helper already running on this data directory? Two would nudge agents, post
// costs and answer webhooks twice, so the service checks before it starts.
//
// The running service rewrites status.json every HEARTBEAT_MS, and marks it stopped
// when it shuts down or crashes. A process that was killed outright (SIGKILL, out of
// memory) can't mark it, so a recent heartbeat alone doesn't prove anything: the
// check waits until the next heartbeat is due, and only a heartbeat that moves is a
// running helper. Containers don't share process ids, so a pid file couldn't tell.

import { readJson } from "./store.mjs";

// How often the service writes its status.
export const HEARTBEAT_MS = 30_000;

// A heartbeat older than this means the service has stopped.
export const HEARTBEAT_STALE_MS = 120_000;

// How long past a due heartbeat to keep watching, for a busy event loop.
const HEARTBEAT_GRACE_MS = 10_000;

export function readStatus(config) {
  return readJson(config.statusFile, null);
}

// The status says a service is running: a recent heartbeat, and not marked stopped.
export function serviceLive(s, now = Date.now()) {
  if (!s?.heartbeatAt || s.stoppedAt) return false;
  return now - Date.parse(s.heartbeatAt) <= HEARTBEAT_STALE_MS;
}

// The running helper's status, or null when there is none. Waits (polling every
// `pollMs`) only while a recent, unmoved heartbeat could still be a live one.
export async function otherInstance(config, { log = null, pollMs = 1000, now = () => Date.now(), sleep } = {}) {
  sleep ??= (ms) => new Promise((r) => setTimeout(r, ms));
  const first = readStatus(config);
  if (!serviceLive(first, now())) return null;
  const deadline = Date.parse(first.heartbeatAt) + HEARTBEAT_MS + HEARTBEAT_GRACE_MS;
  if (deadline > now()) {
    log?.(`a recent heartbeat in ${config.statusFile}: waiting up to ${Math.ceil((deadline - now()) / 1000)} s to see whether another helper is running`);
  }
  while (now() < deadline) {
    await sleep(pollMs);
    const s = readStatus(config);
    if (!s || s.stoppedAt) return null;
    if (s.heartbeatAt !== first.heartbeatAt) return serviceLive(s, now()) ? s : null;
  }
  return null;
}
