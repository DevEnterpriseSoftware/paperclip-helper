import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, serviceProblems } from "../src/config.mjs";

test("defaults: watchdog and cost sync on, relay off until configured", () => {
  const { config, problems } = loadConfig({});
  assert.deepEqual(problems, []);
  assert.equal(config.paperclipApi, "http://127.0.0.1:3100");
  assert.equal(config.watchdog, true);
  assert.equal(config.watchdogHealFailedFinalize, true);
  assert.equal(config.costSync, true);
  assert.equal(config.relay, false);
  assert.equal(config.relayAuto, true);
  assert.deepEqual(config.prefixes, []);
  assert.equal(config.relayLinkPrs, true);
  assert.deepEqual(config.costSyncAdapters, ["claude_local", "codex_local"]);
  assert.equal(config.tokenFile, "/data/paperclip-token");
  assert.equal(config.costStateFile, "/data/cost-synced.json");
  assert.deepEqual(serviceProblems(config), []);
});

test("relay turns on by itself when configured, and then needs every setting", () => {
  const full = loadConfig({ GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "Octo", GITHUB_REPOS: "Org/Repo, org/two" }).config;
  assert.equal(full.relay, true);
  assert.equal(full.ownerLogin, "octo");
  assert.deepEqual(full.repos, ["org/repo", "org/two"]);
  assert.deepEqual(serviceProblems(full), []);

  const partial = loadConfig({ GITHUB_WEBHOOK_SECRET: "s" }).config;
  assert.equal(partial.relay, true);
  const problems = serviceProblems(partial);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /GITHUB_OWNER_LOGIN is not set/);
  assert.match(problems[0], /RELAY=false/);
});

test("RELAY=true without settings refuses to start; RELAY=false ignores them", () => {
  assert.equal(serviceProblems(loadConfig({ RELAY: "true" }).config).length, 3);
  const off = loadConfig({ RELAY: "false", GITHUB_WEBHOOK_SECRET: "s" }).config;
  assert.equal(off.relay, false);
  assert.deepEqual(serviceProblems(off), []);
});

test("RELAY_LINK_PRS is validated like every switch", () => {
  assert.equal(loadConfig({ RELAY_LINK_PRS: "false" }).config.relayLinkPrs, false);
  const { config, problems } = loadConfig({ RELAY_LINK_PRS: "sometimes" });
  assert.equal(config.relayLinkPrs, true);
  assert.match(problems[0], /RELAY_LINK_PRS=sometimes is not true or false/);
});

test("conflict sweep: off by default, needs GITHUB_TOKEN when on, and its settings are validated", () => {
  const relay = { GITHUB_WEBHOOK_SECRET: "s", GITHUB_OWNER_LOGIN: "o", GITHUB_REPOS: "org/repo" };
  const off = loadConfig(relay).config;
  assert.equal(off.relayFixConflicts, false);
  assert.equal(off.githubApi, "https://api.github.com");
  assert.equal(off.conflictMaxAttempts, 2);
  assert.equal(off.conflictPrComment, true);
  assert.equal(off.conflictSweepSec, 900);
  assert.deepEqual(serviceProblems(off), []);

  const noToken = loadConfig({ ...relay, RELAY_FIX_CONFLICTS: "true" }).config;
  assert.match(serviceProblems(noToken)[0], /GITHUB_TOKEN is not set .*RELAY_FIX_CONFLICTS=false/);
  const on = loadConfig({ ...relay, RELAY_FIX_CONFLICTS: "true", GITHUB_TOKEN: "ghp_x", RELAY_CONFLICT_SWEEP_SEC: "0" }).config;
  assert.deepEqual(serviceProblems(on), []);
  assert.equal(on.conflictSweepSec, 0);
  // A token alone turns nothing on, and the relay being off needs no token.
  assert.equal(loadConfig({ ...relay, GITHUB_TOKEN: "ghp_x" }).config.relayFixConflicts, false);
  assert.deepEqual(serviceProblems(loadConfig({ RELAY: "false", RELAY_FIX_CONFLICTS: "true" }).config), []);

  const bad = loadConfig({ RELAY_CONFLICT_SWEEP_SEC: "5", RELAY_CONFLICT_MAX_ATTEMPTS: "0", GITHUB_API: "github" }).problems;
  assert.equal(bad.length, 3);
  assert.match(bad.join("\n"), /RELAY_CONFLICT_SWEEP_SEC=5 must be 0 \(off\) or at least 60/);
});

test("everything off is a problem", () => {
  const { config } = loadConfig({ RELAY: "false", WATCHDOG: "false", COST_SYNC: "false" });
  assert.match(serviceProblems(config)[0], /nothing to run/);
});

test("bad values are reported one line each, with defaults kept", () => {
  const { config, problems } = loadConfig({
    WATCHDOG: "maybe",
    WATCHDOG_STALL_SEC: "soon",
    PAPERCLIP_API: "localhost:3100",
    RELAY_PATH: "hooks",
    LOG_LEVEL: "loud",
    COST_SYNC_SINCE: "yesterday",
  });
  assert.equal(problems.length, 6);
  assert.equal(config.watchdog, true);
  assert.equal(config.watchdogStallSec, 180);
});

test("a complete .env loads without problems, trimming URLs and upper-casing prefixes", () => {
  const { config, problems } = loadConfig({
    PAPERCLIP_API: "http://127.0.0.1:3100/",
    PAPERCLIP_PUBLIC_URL: "https://paperclip.example.com/",
    KEY_EXPIRES_DAYS: "365",
    DRY_RUN: "false",
    RELAY: "true",
    GITHUB_WEBHOOK_SECRET: "abc",
    GITHUB_OWNER_LOGIN: "owner",
    GITHUB_REPOS: "org/repo",
    ISSUE_PREFIXES: "abc, def",
    RELAY_LINK_PRS: "true",
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "3110",
    RELAY_PATH: "/hooks/github",
    WATCHDOG: "true",
    WATCHDOG_INTERVAL_SEC: "60",
    WATCHDOG_STALL_SEC: "180",
    WATCHDOG_MAX_NUDGES: "2",
    WATCHDOG_HEAL_FAILED_FINALIZE: "true",
    COST_SYNC: "true",
    COST_SYNC_INTERVAL_SEC: "900",
  });
  assert.deepEqual(problems, []);
  assert.equal(config.paperclipApi, "http://127.0.0.1:3100");
  assert.equal(config.publicUrl, "https://paperclip.example.com");
  assert.deepEqual(config.prefixes, ["ABC", "DEF"]);
  assert.deepEqual(serviceProblems(config), []);
});
