import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createContext } from "../src/context.mjs";
import { createStateStore } from "../src/store.mjs";
import { startFake } from "./fake-paperclip.mjs";

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pch-test-"));
}

// A fake Paperclip, a data directory with a board key, and a context wired to both.
export async function setup({ env = {}, db, allowedHosts, now } = {}) {
  const fake = await startFake({ db, allowedHosts });
  const dataDir = tempDir();
  const token = fake.issueKey();
  fs.writeFileSync(path.join(dataDir, "paperclip-token"), `${token}\n`);
  const logs = [];
  const makeCtx = (extraEnv = {}) =>
    createContext({
      env: {
        PAPERCLIP_API: fake.url,
        DATA_DIR: dataDir,
        PAPERCLIP_TIMEOUT_SEC: "10",
        LOG_LEVEL: "debug",
        ...env,
        ...extraEnv,
      },
      write: (line) => logs.push(JSON.parse(line)),
      now,
    });
  const ctx = makeCtx();
  const state = createStateStore(ctx.config.stateFile);
  return {
    fake,
    db: fake.db,
    ctx,
    makeCtx,
    state,
    dataDir,
    logs,
    async close() {
      await fake.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function sign(secret, body) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

// Captures console.log output while fn runs.
export async function captureOutput(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}
