// Small shared helpers.

// True when the issue's current approval decision is waiting on this user:
// in review, a pending stage, and the current participant is that user.
export function approvalWaitingOn(issue, userId) {
  const state = issue?.executionState;
  const participant = state?.currentParticipant;
  return (
    issue?.status === "in_review" &&
    state?.status === "pending" &&
    participant?.type === "user" &&
    participant?.userId === userId
  );
}

// The status a decision moves the issue to, sent with its comment in one PATCH:
// done approves; any other status requests changes and returns it to the engineer.
export const DECISION_STATUS = { approve: "done", changes: "in_progress" };

// Every message the helper posts ends with one italic line naming it, so a
// reader can tell where the message came from. `signed` adds the line unless
// the text already ends with one (the watchdog's carry a nudge count).
export const SIGNATURE = "_Sent automatically by Paperclip Helper._";
export const RELAYED_SIGNATURE = "_Relayed from GitHub by Paperclip Helper._";
export const COMMAND_SIGNATURE = "_Sent with Paperclip Helper (`pch`)._";
const SIGNED = /(^|\n)_[^_\n]*Paperclip Helper[^_\n]*_$/;

export function signed(text, signature = SIGNATURE) {
  const body = String(text ?? "").trimEnd();
  return SIGNED.test(body) ? body : `${body}\n\n${signature}`;
}

export function ts(value) {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Runs fn every intervalSec (first run after firstDelayMs), never overlapping
// itself. stop() cancels the timers and waits for a run in progress.
export function every(name, intervalSec, firstDelayMs, fn, log) {
  let running = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return running;
    running = (async () => {
      try {
        await fn();
      } catch (err) {
        log?.error?.(`${name}: tick failed`, { error: err.message });
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, intervalSec * 1000);
  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      if (running) await running;
    },
  };
}

// Runs fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function agentMention(agent) {
  return `[@${agent.name}](agent://${agent.id})`;
}
