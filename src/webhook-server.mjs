// The relay's HTTP side: receives GitHub's webhooks, checks their signature,
// drops a delivery it has already handled, and hands the event to the relay.
//
// GitHub waits ten seconds for an answer and then marks the delivery failed,
// whatever happens after. Finding a PR's issue can take longer than that (Paperclip
// reads for every issue it names, their subtasks and blockers), so the event is
// handled while the answer waits at most ANSWER_WITHIN_MS:
//   * done in time: 200 with what the relay did (shown in GitHub's "Recent
//     Deliveries"), or 502 when it failed;
//   * still going: 202, and the work goes on; its outcome goes to the log.
// A delivery is remembered (in the state file) only once it has succeeded, so a
// redelivery of it changes nothing. One that fails, in time or after, or that a
// crash or restart cut short, isn't, so GitHub's "Redeliver" tries it again. A
// redelivery while the first is still going waits for nothing and changes nothing.

import http from "node:http";
import crypto from "node:crypto";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
// GitHub gives up after 10 s: answer well before.
export const ANSWER_WITHIN_MS = 8_000;

export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// `handle(event, payload)` does the work and resolves to what it did.
export function createWebhookServer({ ctx, state, handle, answerWithinMs = ANSWER_WITHIN_MS }) {
  const { config, log } = ctx;
  const deliveries = state.deliveries;
  const stats = { handled: 0, failed: 0, answeredLate: 0, lastEventAt: null, lastError: null };
  const inflight = new Set(); // promises: deliveries being received or worked on
  const working = new Set(); // delivery ids being worked on, not yet remembered

  const save = () => {
    try {
      state.save();
    } catch (err) {
      log.error("relay: could not save state", { error: err.message });
    }
  };

  // The event's work, start to finish, whether or not the webhook is still waiting.
  async function work(event, payload, delivery) {
    try {
      const result = (await handle(event, payload)) ?? {};
      if (delivery) {
        deliveries.set(delivery, { at: ctx.now() });
        state.touch();
      }
      stats.handled += 1;
      stats.lastEventAt = new Date().toISOString();
      log("relay: handled", { event, action: payload?.action, delivery, result });
      return { status: 200, body: result };
    } catch (err) {
      // Not remembered, so a GitHub "Redeliver" tries again.
      stats.failed += 1;
      stats.lastError = err.message;
      log.error("relay: failed", { event, action: payload?.action, delivery, error: err.message });
      return { status: 502, body: { error: err.message } };
    } finally {
      working.delete(delivery);
      save();
    }
  }

  async function receive(req, res, raw) {
    const event = req.headers["x-github-event"];
    const delivery = req.headers["x-github-delivery"];
    if (!verifySignature(config.secret, raw, req.headers["x-hub-signature-256"])) {
      log.warn("relay: rejected, bad signature", { event, delivery });
      return send(res, 401, { error: "bad signature" });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { error: "payload is not JSON (set the webhook content type to application/json)" });
    }
    if (delivery && deliveries.has(delivery)) return send(res, 200, { duplicate: delivery });
    if (delivery && working.has(delivery)) {
      return send(res, 409, { inProgress: delivery, note: "this delivery is still being worked on; if it fails, Redeliver it once more" });
    }
    if (delivery) working.add(delivery);

    const done = work(event, payload, delivery);
    track(done);
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), answerWithinMs);
    });
    const outcome = await Promise.race([done, late]);
    clearTimeout(timer);
    if (outcome) return send(res, outcome.status, outcome.body);
    stats.answeredLate += 1;
    log("relay: still working on a delivery; answered GitHub so it doesn't time out", { event, action: payload?.action, delivery });
    send(res, 202, {
      accepted: delivery ?? true,
      note: `still working after ${Math.round(answerWithinMs / 1000)}s; the outcome is in the helper's log. If it failed, Redeliver this delivery.`,
    });
  }

  function track(promise) {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname !== config.webhookPath) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      track(receive(req, res, Buffer.concat(chunks)));
    });
  });

  // Resolves when every delivery received so far has been handled.
  async function idle() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  return {
    server,
    stats,
    idle,
    // Resolves with the port.
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listenPort, config.listenHost, () => {
          server.off("error", reject);
          resolve(server.address().port);
        });
      });
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await idle();
    },
  };
}
