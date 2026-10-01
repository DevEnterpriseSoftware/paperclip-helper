// Everything a component needs, built once: settings, logger, API client,
// the board key, and who that key belongs to.

import fs from "node:fs";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { companyPrefixes, createPaperclip } from "./paperclip.mjs";

export const VERSION = (() => {
  if (process.env.HELPER_VERSION) return process.env.HELPER_VERSION;
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0-dev";
  }
})();

const IDENTITY_MAX_AGE_MS = 60 * 60 * 1000;

export function createContext({ env = process.env, fetchImpl, write, now = () => Date.now() } = {}) {
  const { config, problems } = loadConfig(env);
  config.version = VERSION;
  const log = createLogger({ level: config.logLevel, write });
  const readToken = () => {
    try {
      return fs.readFileSync(config.tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  };
  const api = createPaperclip({ config, readToken, log, fetchImpl });

  let lastIdentity = null;
  let prefixes = config.prefixes;

  // Who the key belongs to. Re-read at most hourly, so companies added later
  // are picked up and a revoked key is noticed; issue prefixes follow it.
  async function identity({ refresh = false } = {}) {
    const me = await api.whoAmI({ refresh, maxAgeMs: IDENTITY_MAX_AGE_MS });
    if (me !== lastIdentity) {
      lastIdentity = me;
      if (!config.prefixes.length) {
        const found = await companyPrefixes(api, me?.companyIds);
        if (found.length) prefixes = found;
      }
    }
    return me;
  }

  return {
    config,
    problems,
    log,
    api,
    readToken,
    identity,
    prefixes: () => prefixes,
    now,
  };
}
