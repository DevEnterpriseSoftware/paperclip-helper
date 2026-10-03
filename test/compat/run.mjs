#!/usr/bin/env node
// Boots a throwaway Paperclip of one version, runs the compatibility suite
// against it, and removes it again.
//
//   npm run test:compat                     the latest published Paperclip
//   npm run test:compat -- 2026.1001.0      one version
//   npm run test:compat -- 2026.916.1 2026.1001.0 latest
//   npm run test:compat -- --keep latest    leave it running afterwards, to poke at
//
// Paperclip comes from npm (`npx paperclipai@<version>`) with its embedded
// PostgreSQL, in a temporary PAPERCLIP_HOME, on a free loopback port. Nothing
// touches a Paperclip you already run. It needs what Paperclip needs: a recent
// Node (24.11 or newer for the 2026.9 releases) and a user that isn't root,
// because PostgreSQL refuses to start as root.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const versions = args.filter((a) => !a.startsWith("--"));
if (!versions.length) versions.push("latest");
const START_TIMEOUT_MS = Number(process.env.PAPERCLIP_COMPAT_START_TIMEOUT_SEC ?? 600) * 1000;
const windows = process.platform === "win32";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Paperclip, its PostgreSQL and any agent processes: the whole tree.
function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (windows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function health(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function runOne(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pch-compat-paperclip-"));
  const logFile = path.join(home, "paperclip.log");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n=== Paperclip ${version}: starting on ${base} (home ${home})`);

  const log = fs.openSync(logFile, "a");
  const child = spawn("npx", ["--yes", `paperclipai@${version}`, "onboard", "--yes", "--no-install-service", "--run"], {
    cwd: home,
    env: { ...process.env, PAPERCLIP_HOME: home, PORT: String(port), PAPERCLIP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", CI: "1" },
    stdio: ["ignore", log, log],
    detached: !windows,
    shell: windows,
  });
  const onSignal = () => {
    stop(child);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let code = 1;
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let up = null;
    while (!(up = await health(base))) {
      if (child.exitCode !== null) throw new Error(`Paperclip ${version} exited with code ${child.exitCode} before it was ready`);
      if (Date.now() > deadline) throw new Error(`Paperclip ${version} wasn't ready within ${START_TIMEOUT_MS / 1000}s`);
      await sleep(2000);
    }
    console.log(`=== Paperclip ${up.version ?? up.serverVersion ?? version} is up (${up.deploymentMode}); running the suite`);
    const tests = spawnSync(process.execPath, ["--test", "--test-reporter=spec", path.join(here, "compat.test.mjs")], {
      env: { ...process.env, PAPERCLIP_COMPAT_API: base },
      stdio: "inherit",
    });
    code = tests.status ?? 1;
    if (keep) {
      console.log(`\n--keep: Paperclip ${version} is still running at ${base}. Stop it with Ctrl+C; its data is in ${home}.`);
      await new Promise((resolve) => child.once("exit", resolve));
    }
  } catch (err) {
    console.error(`\n${err.message}`);
    const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n") : "";
    if (tail) console.error(`--- last lines of Paperclip's log ---\n${tail}`);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stop(child);
    fs.closeSync(log);
    await sleep(1500); // let PostgreSQL let go of its files
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
  return code;
}

const results = [];
for (const version of versions) results.push([version, await runOne(version)]);

console.log("\n=== Compatibility");
for (const [version, code] of results) console.log(`  Paperclip ${version}: ${code === 0 ? "compatible" : "FAILED"}`);
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0);
