// One JSON line per event, on stdout: {"at":…,"level":…,"msg":…,…}.
// Values that look like credentials are masked before they're written.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|authorization|cookie/i;
const SECRET_VALUE = /\bpcp_[a-z_]*[0-9a-f]{16,}\b/gi;

export function redact(value, depth = 0) {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "pcp_***");
  if (!value || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && typeof v === "string" && v ? "***" : redact(v, depth + 1);
  }
  return out;
}

export function createLogger({ level = "info", write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, extra) => {
    if (LEVELS[lvl] < threshold) return;
    write(JSON.stringify({ at: new Date().toISOString(), level: lvl, msg: redact(msg), ...redact(extra ?? {}) }));
  };
  const log = emit("info");
  log.debug = emit("debug");
  log.info = log;
  log.warn = emit("warn");
  log.error = emit("error");
  log.setLevel = (lvl) => {
    threshold = LEVELS[lvl] ?? threshold;
  };
  return log;
}
