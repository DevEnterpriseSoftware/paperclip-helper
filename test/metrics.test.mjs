// Lifetime metrics (data/metrics.json) and how `pch status` shows them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { captureOutput, setup, tempDir } from "./helpers.mjs";
import { writeJson } from "../src/store.mjs";
import { createLogger } from "../src/log.mjs";
import { clearProblems, createMetrics, metricsFile, minutesSaved, readMetrics, watchProblems } from "../src/metrics.mjs";
import * as cmd from "../src/commands.mjs";

const stats = (nudges, handled = 0) => ({ relay: { on: true, handled, approvals: 1 }, watchdog: { on: true, ticks: 10, nudges, ciReports: 1 }, costSync: { on: false } });

test("totals carry over a restart and an upgrade: each process adds its own counts to what the file held", () => {
  const config = { dataDir: tempDir() };
  const first = createMetrics(config, { version: "1.12.0" });
  first.update(stats(2, 5));
  first.update(stats(3, 7)); // counts since start only grow: the latest is what counts
  first.save();
  assert.equal(readMetrics(config).totals.nudges, 3);

  const second = createMetrics(config, { version: "1.13.0" });
  second.update(stats(4, 1));
  second.save();
  const m = readMetrics(config);
  assert.equal(m.totals.nudges, 7);
  assert.equal(m.totals.githubEvents, 8);
  assert.equal(m.totals.watchdogChecks, 20);
  assert.equal(m.starts, 2);
  assert.equal(m.firstVersion, "1.12.0");
  assert.equal(m.version, "1.13.0");
  // 7 agents woken × 10 min + 2 approvals × 3 min; CI reports are among the agents woken.
  assert.equal(minutesSaved(m.totals), 76);
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

test("warnings and errors are counted as they're logged, and the latest ten kept, with what they were about", () => {
  const config = { dataDir: tempDir() };
  const metrics = createMetrics(config);
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  watchProblems(log, metrics);
  log("all fine");
  for (let i = 1; i <= 12; i += 1) log.warn(`watchdog: issue check failed ${i}`, { issue: `ACM-${i}`, error: "timeout", token: "secret" });
  log.error("relay: failed", { error: "Paperclip answered 502 with pcp_board_0123456789abcdef0123" });
  assert.equal(lines.length, 14, "still logged as before");
  metrics.save();
  const m = readMetrics(config);
  assert.equal(m.warnings, 12);
  assert.equal(m.errors, 1);
  assert.equal(m.recent.length, 10);
  assert.equal(m.recent[0].msg, "watchdog: issue check failed 4");
  assert.equal(m.recent[0].detail, "issue ACM-4, error timeout");
  assert.equal(m.recent.at(-1).level, "error");
  assert.doesNotMatch(JSON.stringify(m), /0123456789abcdef/, "secrets stay masked");
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

test("pch status shows the all-time counts, the hand work saved and the latest problems", async (t) => {
  const env = await setup();
  t.after(env.close);
  writeJson(env.ctx.config.statusFile, { version: "1.13.0", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), relay: { on: false }, watchdog: { on: false }, costSync: { on: false } });
  writeJson(metricsFile(env.ctx.config), {
    firstStartedAt: "2026-10-01T09:12:00Z", starts: 12, firstVersion: "1.11.0", version: "1.13.0",
    totals: { githubEvents: 230, approvals: 61, changeRequests: 12, relayFailures: 3, watchdogChecks: 18203, nudges: 142, ciReports: 61, releases: 4, costPosts: 1204, costCents: 31240 },
    warnings: 23, errors: 2,
    recent: [{ at: "2026-10-24T15:02:00Z", level: "warn", msg: "watchdog: issue check failed", detail: "issue ACM-12, error timeout" }, { at: "2026-10-24T16:10:00Z", level: "error", msg: "relay: failed", detail: null }],
  });
  const text = (await captureOutput(() => cmd.status(env.ctx))).join("\n");
  assert.match(text, /^All time \(since 2026-10-01 09:12 UTC, 12 starts, 1\.11\.0 → 1\.13\.0\):$/m);
  // 61×3 + 12×3 + 142×10 + 4×15 = 1,699 minutes.
  assert.match(text, /^ {2}Kept things moving: 219 actions, about 28 h of hand work saved \(a rough guess per action\)\.$/m);
  assert.match(text, /^ {7}142 {2}stalled agents woken \(61 of them finished CI runs reported\)$/m);
  assert.match(text, /^ {8}61 {2}merges and approvals recorded as your decision$/m);
  assert.match(text, /^ {2}Relay: 230 GitHub events handled, 3 failed\.$/m);
  assert.match(text, /^ {2}Watchdog: 18,203 checks run\.$/m);
  assert.match(text, /^ {2}Cost sync: 1,204 run costs posted \(\$312\.40\)\.$/m);
  assert.match(text, /^ {2}Problems: 23 warnings, 2 errors\. The latest 2, newest last:$/m);
  assert.match(text, /^ {4}2026-10-24 15:02 {2}warn {3}watchdog: issue check failed \(issue ACM-12, error timeout\)$/m);
  assert.match(text, /^ {4}2026-10-24 16:10 {2}ERROR {2}relay: failed$/m);
  process.exitCode = 0;
});

test("clearing problems with the service running: the file is emptied at once, and the service drops its copy at the next heartbeat, keeping what it logged after", () => {
  const config = { dataDir: tempDir() };
  let clock = Date.parse("2026-11-24T10:00:00Z");
  const now = () => clock;
  const metrics = createMetrics(config, { version: "1.19.0", now });
  const log = createLogger({ write: () => {} });
  watchProblems(log, metrics);
  for (let i = 1; i <= 3; i += 1) log.warn("watchdog: a check failed this tick", { check: `c${i}` });
  log.error("relay: failed", { error: "502" });
  metrics.update(stats(5));
  metrics.save();
  assert.equal(readMetrics(config).warnings, 3);

  clock += 60_000;
  assert.deepEqual(clearProblems(config, { now }), { warnings: 3, errors: 1 });
  const cleared = readMetrics(config);
  assert.equal(cleared.warnings, 0);
  assert.equal(cleared.errors, 0);
  assert.deepEqual(cleared.recent, []);
  assert.equal(cleared.problemsClearedAt, "2026-11-24T10:01:00.000Z");
  assert.equal(cleared.totals.nudges, 5, "the counts are kept");

  clock += 10_000;
  log.warn("watchdog: cannot reach Paperclip; skipping the rest of this tick", { error: "ECONNREFUSED" }); // after the clear
  metrics.update(stats(6));
  metrics.save(); // the service's next heartbeat
  const m = readMetrics(config);
  assert.equal(m.warnings, 1);
  assert.equal(m.errors, 0);
  assert.deepEqual(m.recent.map((p) => p.msg), ["watchdog: cannot reach Paperclip; skipping the rest of this tick"]);
  assert.equal(m.totals.nudges, 6);

  log.warn("watchdog: a check failed this tick", { check: "c9" });
  metrics.save(); // a later heartbeat counts as before
  assert.equal(readMetrics(config).warnings, 2);

  const restarted = createMetrics(config, { version: "1.19.0", now });
  restarted.save(); // a restart doesn't bring the cleared ones back, or clear again
  assert.equal(readMetrics(config).warnings, 2);
  assert.equal(readMetrics(config).problemsClearedAt, "2026-11-24T10:01:00.000Z");
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

test("pch status --clear-problems says what it cleared, and status then says since when", async (t) => {
  const env = await setup();
  t.after(env.close);
  writeJson(env.ctx.config.statusFile, { version: "1.19.0", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), relay: { on: false }, watchdog: { on: false }, costSync: { on: false } });
  writeJson(metricsFile(env.ctx.config), {
    firstStartedAt: "2026-10-01T09:12:00Z", starts: 2, version: "1.19.0", totals: { watchdogChecks: 40 },
    warnings: 12, errors: 1, recent: [{ at: "2026-11-24T07:05:00Z", level: "warn", msg: "watchdog: a check failed this tick", detail: null }],
  });
  const said = (await captureOutput(() => cmd.status(env.ctx, { clearProblems: true }))).join("\n");
  assert.match(said, /^Cleared 12 warnings and 1 error from the status\. The all-time counts are kept\.$/m);
  assert.match(said, /^The running service drops its own copy at its next heartbeat \(within 30 seconds\)\.$/m);
  assert.doesNotMatch(said, /All time/, "only clears");
  const text = (await captureOutput(() => cmd.status(env.ctx))).join("\n");
  assert.match(text, /^ {2}Problems since they were cleared \d{4}-\d\d-\d\d \d\d:\d\d UTC: 0 warnings, 0 errors\.$/m);
  assert.match(text, /^ {2}Watchdog: 40 checks run\.$/m);
  process.exitCode = 0;
});

test("pch status --clear-problems before the service has written any figures says so", async (t) => {
  const env = await setup();
  t.after(env.close);
  const said = (await captureOutput(() => cmd.status(env.ctx, { clearProblems: true }))).join("\n");
  assert.match(said, /^No problems recorded yet: the helper service hasn't written data\/metrics\.json\.$/m);
  process.exitCode = 0;
});
