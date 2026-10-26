#!/usr/bin/env node
// Paperclip Helper: small automations that run beside a self-hosted Paperclip.
//
//   relay.mjs      GitHub webhooks → your approval decisions in Paperclip   (on when a GITHUB_* setting is)
//   watchdog.mjs   wakes agents whose work Paperclip left stalled           (WATCHDOG, default on)
//   cost-sync.mjs  API-equivalent cost of subscription runs → Costs page    (COST_SYNC, default on)
//
// With no command it runs every enabled component; `help` lists the one-off
// commands. No dependencies: Node 22+. Configuration is environment variables.

import { createContext, VERSION } from "./context.mjs";
import { serviceProblems } from "./config.mjs";
import { createStateStore, writeJson } from "./store.mjs";
import { redact } from "./log.mjs";
import { createRelay } from "./relay.mjs";
import { createWatchdog } from "./watchdog.mjs";
import { createCostSync } from "./cost-sync.mjs";
import * as cmd from "./commands.mjs";
import { parseCommandLine, SPECS } from "./args.mjs";
import { HEARTBEAT_MS, otherInstance } from "./instance.mjs";
import { createMetrics, watchProblems } from "./metrics.mjs";

// Set once the service starts: from then on, even a crash is a JSON log line.
let serviceLog = null;

async function runService(ctx) {
  const { config, log } = ctx;
  serviceLog = log;
  let markStopped = null;
  const crash = (err) => {
    log.error("paperclip helper crashed", { error: err?.message ?? String(err), stack: err?.stack ?? null });
    markStopped?.();
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  const problems = [...ctx.problems, ...serviceProblems(config)];
  if (!ctx.readToken()) problems.push(`no board API key in ${config.tokenFile}: run \`pch login\` first`);
  if (problems.length) {
    for (const p of problems) log.error(`config: ${p}`);
    process.exit(1);
  }
  const other = await otherInstance(config, { log });
  if (other) {
    log.error("another Paperclip Helper is already running on this data directory: see `pch status`", {
      startedAt: other.startedAt ?? null,
      heartbeatAt: other.heartbeatAt,
      statusFile: config.statusFile,
    });
    process.exit(1);
  }
  if (config.relayAuto && !config.relay) {
    log("relay off: set GITHUB_WEBHOOK_SECRET, GITHUB_OWNER_LOGIN and GITHUB_REPOS to turn it on");
  }

  // Lifetime counts and the latest warnings and errors (data/metrics.json, for `pch status`).
  const metrics = createMetrics(config, { version: VERSION });
  watchProblems(log, metrics);
  log("paperclip helper starting", { version: VERSION, paperclip: config.paperclipApi, dryRun: config.dryRun });
  const startedAt = new Date().toISOString();
  let identity = null;
  let key = null;
  const refreshIdentity = async () => {
    try {
      identity = await ctx.identity({ refresh: true });
      key = await cmd.currentKey(ctx).catch(() => null);
      log("paperclip identity", {
        userId: identity.userId,
        name: identity.user?.name ?? null,
        source: identity.source,
        companies: identity.companyIds?.length ?? 0,
        prefixes: ctx.prefixes(),
        keyExpiresAt: key?.expiresAt ?? null,
      });
      if (key?.expiresAt && Date.parse(key.expiresAt) - Date.now() < 14 * 86_400_000) {
        log.warn(`the helper's board key expires on ${key.expiresAt.slice(0, 10)}: run \`pch login\` to replace it`);
      }
    } catch (err) {
      log.error("paperclip identity check failed", { error: err.message });
    }
  };
  await refreshIdentity();

  const state = createStateStore(config.stateFile);
  const relay = config.relay ? createRelay(ctx, state) : null;
  const watchdog = config.watchdog ? createWatchdog(ctx, state) : null;
  const costSync = config.costSync ? createCostSync(ctx) : null;

  if (relay) {
    try {
      await relay.start();
    } catch (err) {
      const why =
        err.code === "EADDRINUSE"
          ? ": something already listens there. `pch status` shows whether a helper is running; if not, another program has the port (or set RELAY_PORT)"
          : "";
      log.error(`relay could not listen on ${config.listenHost}:${config.listenPort}${why}`, { error: err.message });
      process.exit(1);
    }
  }
  watchdog?.start();
  costSync?.start();

  const writeStatus = (extra = {}) => {
    const components = {
      relay: relay ? { on: true, ...relay.stats } : { on: false },
      watchdog: watchdog ? { on: true, ...watchdog.stats } : { on: false },
      costSync: costSync ? { on: true, ...costSync.stats } : { on: false },
    };
    try {
      metrics.update(components);
      metrics.save();
    } catch (err) {
      // Not log.error: that would count itself as a problem on every heartbeat.
      log.debug("could not write the metrics file", { error: err.message });
    }
    try {
      writeJson(config.statusFile, {
        version: VERSION,
        startedAt,
        heartbeatAt: new Date().toISOString(),
        dryRun: config.dryRun,
        paperclip: config.paperclipApi,
        identity: identity ? { userId: identity.userId, name: identity.user?.name ?? null, companies: identity.companyIds ?? [] } : null,
        keyExpiresAt: key?.expiresAt ?? null,
        ...components,
        ...extra,
      });
    } catch (err) {
      log.error("could not write the status file", { file: config.statusFile, error: err.message });
    }
  };
  writeStatus();
  // So the next start, and `pch status`, know this one has gone without waiting out its heartbeat.
  markStopped = () => writeStatus({ stoppedAt: new Date().toISOString() });
  const heartbeat = setInterval(writeStatus, HEARTBEAT_MS);
  const hourly = setInterval(refreshIdentity, 60 * 60 * 1000);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log("paperclip helper stopping", { signal });
    clearInterval(heartbeat);
    clearInterval(hourly);
    const force = setTimeout(() => process.exit(0), 20_000);
    force.unref();
    await Promise.allSettled([relay?.stop(), watchdog?.stop(), costSync?.stop()]);
    try {
      state.save({ force: true });
    } catch {}
    markStopped();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main() {
  const [command = "run", ...words] = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseCommandLine(command, words);
  } catch (err) {
    console.error(Object.hasOwn(SPECS, command) ? err.message : `${err.message}\n\n${cmd.USAGE}`);
    process.exit(2);
  }
  if (parsed.help) return console.log(parsed.usage);
  const { args: a, options: o, given } = parsed;
  const ctx = createContext();

  const commands = {
    run: () => runService(ctx),
    login: () => cmd.login(ctx),
    revoke: () => cmd.revoke(ctx),
    check: () => cmd.check(ctx, a.issue),
    why: () => cmd.why(ctx, a.issue, { prompt: o.prompt }),
    blocked: () => cmd.blocked(ctx),
    ready: () => cmd.ready(ctx),
    approve: () => cmd.decide(ctx, "approve", a.issue, a.text),
    changes: () => cmd.decide(ctx, "changes", a.issue, a.text),
    comment: () => cmd.comment(ctx, a.issue, a.text),
    answer: () => cmd.answer(ctx, a.issue, a.card, a.text),
    release: () => cmd.release(ctx, a.issue, o),
    workspace: () => cmd.workspace(ctx, a.issue, o),
    worktrees: () => cmd.worktrees(ctx, { ...o, given }),
    costs: () => cmd.costs(ctx, { ...o, given }),
    usage: () => cmd.usage(ctx, o),
    models: () => cmd.models(ctx),
    "set-model": () => cmd.setModel(ctx, a.from, a.to, o),
    status: () => cmd.status(ctx),
    health: () => cmd.health(ctx),
    probe: () => cmd.probe(ctx, a.url),
    prefixes: () => cmd.prefixes(ctx),
    secret: () => cmd.secret(),
    update: () => cmd.update(),
    wrapper: () => process.stdout.write(cmd.wrapperScript(a.kind)),
    version: () => console.log(VERSION),
    help: () => console.log(cmd.USAGE),
  };
  commands["--help"] = commands["-h"] = commands.help;
  commands["--version"] = commands.version;

  if (command !== "run" && ctx.problems.length) {
    for (const p of ctx.problems) console.error(`config: ${p}`);
  }
  await commands[command]();
}

main().catch((err) => {
  if (serviceLog) serviceLog.error("paperclip helper stopped on an error", { error: err.message });
  else console.error(redact(err.message));
  process.exit(1);
});
