import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureOutput, setup, tempDir } from "./helpers.mjs";
import { HEARTBEAT_MS, otherInstance, serviceLive } from "../src/instance.mjs";
import { writeJson } from "../src/store.mjs";
import * as cmd from "../src/commands.mjs";

const INDEX = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const ago = (ms, now = Date.now()) => new Date(now - ms).toISOString();

// A clock that the check's sleeps move on.
function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function statusDir() {
  const dir = tempDir();
  return { dir, config: { statusFile: path.join(dir, "status.json") }, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("serviceLive: a recent heartbeat not marked stopped", () => {
  const now = Date.now();
  assert.equal(serviceLive(null, now), false);
  assert.equal(serviceLive({ heartbeatAt: ago(5_000, now) }, now), true);
  assert.equal(serviceLive({ heartbeatAt: ago(5 * 60_000, now) }, now), false);
  assert.equal(serviceLive({ heartbeatAt: ago(5_000, now), stoppedAt: ago(1_000, now) }, now), false);
});

test("otherInstance: no status, a stale one, or one marked stopped is no other helper, at once", async (t) => {
  const d = statusDir();
  t.after(d.close);
  let slept = 0;
  const sleep = async () => slept++;
  assert.equal(await otherInstance(d.config, { sleep }), null);
  writeJson(d.config.statusFile, { heartbeatAt: ago(10 * 60_000) });
  assert.equal(await otherInstance(d.config, { sleep }), null);
  writeJson(d.config.statusFile, { heartbeatAt: ago(2_000), stoppedAt: ago(1_000) });
  assert.equal(await otherInstance(d.config, { sleep }), null);
  assert.equal(slept, 0);
});

test("otherInstance: a heartbeat that moves is a running helper", async (t) => {
  const d = statusDir();
  t.after(d.close);
  const clock = fakeClock();
  writeJson(d.config.statusFile, { startedAt: ago(3_600_000, clock.now()), heartbeatAt: ago(25_000, clock.now()) });
  const logged = [];
  let beats = 0;
  const sleep = async (ms) => {
    clock.advance(ms);
    // The other helper's next heartbeat, 5 s on.
    if (++beats === 5) writeJson(d.config.statusFile, { startedAt: ago(3_600_000, clock.now()), heartbeatAt: new Date(clock.now()).toISOString() });
  };
  const other = await otherInstance(d.config, { log: (m) => logged.push(m), now: clock.now, sleep });
  assert.ok(other, "the moving heartbeat is another helper");
  assert.equal(beats, 5);
  assert.match(logged.join("\n"), /waiting up to 15 s to see whether another helper is running/);
});

test("otherInstance: a heartbeat that never moves was a helper killed outright, so the start goes ahead", async (t) => {
  const d = statusDir();
  t.after(d.close);
  const clock = fakeClock();
  writeJson(d.config.statusFile, { heartbeatAt: ago(1_000, clock.now()) });
  let waited = 0;
  const sleep = async (ms) => {
    clock.advance(ms);
    waited += ms;
  };
  assert.equal(await otherInstance(d.config, { now: clock.now, sleep }), null);
  // Until its next heartbeat was due, and a little longer: never the whole stale window.
  assert.ok(waited >= HEARTBEAT_MS - 1_000 && waited <= HEARTBEAT_MS + 10_000, `waited ${waited} ms`);
});

test("otherInstance: a helper that stops while the check watches is no other helper", async (t) => {
  const d = statusDir();
  t.after(d.close);
  const clock = fakeClock();
  writeJson(d.config.statusFile, { heartbeatAt: ago(1_000, clock.now()) });
  let n = 0;
  const sleep = async (ms) => {
    clock.advance(ms);
    if (++n === 3) writeJson(d.config.statusFile, { heartbeatAt: ago(1_000, clock.now()), stoppedAt: new Date(clock.now()).toISOString() });
  };
  assert.equal(await otherInstance(d.config, { now: clock.now, sleep }), null);
  assert.equal(n, 3);
});

test("status and health: a helper marked stopped is not running, even with a recent heartbeat", async (t) => {
  const env = await setup();
  t.after(env.close);
  const now = Date.now();
  writeJson(env.ctx.config.statusFile, {
    version: "9.9.9",
    startedAt: ago(3_600_000, now),
    heartbeatAt: ago(10_000, now),
    stoppedAt: ago(5_000, now),
    relay: { on: false },
    watchdog: { on: false },
    costSync: { on: false },
  });
  const lines = await captureOutput(() => cmd.status(env.ctx));
  process.exitCode = 0;
  assert.match(lines[0], /^Paperclip Helper 9\.9\.9: NOT RUNNING\. It stopped at \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  await assert.rejects(cmd.health(env.ctx), /the service has stopped/);

  writeJson(env.ctx.config.statusFile, { version: "9.9.9", startedAt: ago(3_600_000, now), heartbeatAt: ago(10_000, now), relay: { on: false } });
  const running = await captureOutput(() => cmd.status(env.ctx));
  process.exitCode = 0;
  assert.match(running[0], /^Paperclip Helper 9\.9\.9: running since /);
});

// The service itself: started for real, against the fake Paperclip.
function runService(env, extraEnv = {}) {
  const child = spawn(process.execPath, [INDEX, "run"], {
    env: { PATH: process.env.PATH, PAPERCLIP_API: env.fake.url, DATA_DIR: env.dataDir, RELAY: "false", WATCHDOG: "true", COST_SYNC: "false", DRY_RUN: "true", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push({ msg: line });
      }
    }
  });
  child.stderr.on("data", (chunk) => lines.push({ msg: String(chunk) }));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const waitFor = async (re, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (lines.some((l) => re.test(l.msg))) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no log line matching ${re}: ${JSON.stringify(lines)}`);
  };
  return { child, lines, exited, waitFor };
}

test("the service refuses to start beside a running helper, and starts at once after a clean stop", async (t) => {
  const env = await setup();
  t.after(env.close);
  const statusFile = path.join(env.dataDir, "status.json");
  const now = Date.now();
  // A helper on the same data directory whose heartbeat moves.
  writeJson(statusFile, { version: "1.0.0", startedAt: ago(60_000, now), heartbeatAt: ago(HEARTBEAT_MS - 2_000, now) });
  const beat = setInterval(() => writeJson(statusFile, { version: "1.0.0", startedAt: ago(60_000, now), heartbeatAt: new Date().toISOString() }), 500);
  t.after(() => clearInterval(beat));

  const second = runService(env);
  t.after(() => second.child.kill("SIGKILL"));
  assert.equal(await second.exited, 1);
  clearInterval(beat);
  assert.ok(second.lines.some((l) => /another Paperclip Helper is already running on this data directory/.test(l.msg)), JSON.stringify(second.lines));
  assert.ok(!second.lines.some((l) => l.msg === "paperclip helper starting"), "it stopped before starting anything");

  // Now no other helper: this one starts, and its clean stop is marked.
  fs.rmSync(statusFile);
  const first = runService(env);
  t.after(() => first.child.kill("SIGKILL"));
  await first.waitFor(/^paperclip helper starting$/);
  const end = Date.now() + 10_000;
  while (!fs.existsSync(statusFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0);
  const s = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.ok(s.stoppedAt, "the status says it stopped");

  // So the next start doesn't wait out the heartbeat.
  const third = runService(env);
  t.after(() => third.child.kill("SIGKILL"));
  await third.waitFor(/^paperclip helper starting$/, 3_000);
  assert.ok(!third.lines.some((l) => /waiting up to/.test(l.msg)));
  third.child.kill("SIGTERM");
  await third.exited;
});

test("relay port in use: the log line says what to check", async (t) => {
  const env = await setup();
  t.after(env.close);
  const net = await import("node:net");
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const svc = runService(env, {
    RELAY: "true",
    RELAY_PORT: String(port),
    GITHUB_WEBHOOK_SECRET: "s".repeat(32),
    GITHUB_OWNER_LOGIN: "me",
    GITHUB_REPOS: "me/app",
  });
  t.after(() => svc.child.kill("SIGKILL"));
  assert.equal(await svc.exited, 1);
  const line = svc.lines.find((l) => /relay could not listen/.test(l.msg));
  assert.ok(line, JSON.stringify(svc.lines));
  assert.match(line.msg, new RegExp(`127\\.0\\.0\\.1:${port}: something already listens there\\. \`pch status\` shows whether a helper is running`));
  assert.match(line.error, /EADDRINUSE/);
});
