// pch's command line, parsed once for every command (index.mjs).
//
// Each command has a spec: its arguments in order, and its options. The rules are
// the same everywhere:
//   * an option is a word that starts with "--": --apply, --days 7, --days=7;
//   * an option a command doesn't have is an error, never ignored or posted as
//     text: `pch comment ACM-1 --apply hi` stops rather than comment "--apply hi";
//   * a bare "--" before the text starts it: every word after it is text, so a
//     comment can start with "--" (PowerShell drops a bare --: there it is '--');
//     a "--" within the text is part of it;
//   * a word with one dash ("-1", "-"), or with a space in it (a quoted
//     "--force is fine"), is an argument, not an option: text can hold one;
//   * the last argument of approve, changes, comment and answer is text: the rest
//     of the words, joined with spaces (or one quoted argument).
//
// parseCommandLine(command, words) → { args, options, given, help } or throws a
// usage error. Option names come back camelCased (--min-days → minDays), with
// their defaults filled in; `given` names the ones on the command line.

// An argument: "name" (required), "name?" (optional), "name..." (required text,
// the rest of the words), "name...?" (optional text).
// An option: "boolean", "number", "string", or { type, choices, default }.
export const SPECS = {
  run: { usage: "run" },
  status: { usage: "status" },
  why: { usage: "why ISSUE [--prompt]", args: ["issue"], options: { prompt: "boolean" } },
  blocked: { usage: "blocked" },
  ready: { usage: "ready" },
  usage: { usage: "usage [--days N] [--agent NAME]", options: { days: { type: "number", default: 7 }, agent: "string" } },
  check: { usage: "check [ISSUE]", args: ["issue?"] },
  approve: { usage: "approve ISSUE [comment]", args: ["issue", "text...?"] },
  changes: { usage: "changes ISSUE comment", args: ["issue", "text..."] },
  comment: { usage: "comment ISSUE text", args: ["issue", "text..."] },
  answer: { usage: "answer ISSUE CARD text", args: ["issue", "card", "text...?"] },
  release: {
    usage: "release ISSUE [--apply] [--outcome mixed|completed|not_performed]",
    args: ["issue"],
    options: { apply: "boolean", outcome: { type: "string", choices: ["mixed", "completed", "not_performed"], default: "mixed" } },
  },
  workspace: { usage: "workspace ISSUE [--apply]", args: ["issue"], options: { apply: "boolean" } },
  worktrees: {
    usage: "worktrees [--apply] [--min-days N] [--include-untracked] [--include-unmerged] | worktrees --links [--retry]",
    options: {
      apply: "boolean", "min-days": { type: "number", default: 1 }, "include-untracked": "boolean", "include-unmerged": "boolean",
      links: "boolean", retry: "boolean",
    },
    // The two forms don't mix.
    validate: (o, given) =>
      o.retry && !o.links ? "--retry goes with --links."
        : o.links && ["apply", "minDays", "includeUntracked", "includeUnmerged"].some((k) => given.has(k)) ? "--links takes only --retry."
        : null,
  },
  models: { usage: "models" },
  "set-model": { usage: "set-model FROM TO [--apply]", args: ["from", "to"], options: { apply: "boolean" } },
  costs: {
    usage: "costs [--sessions | --audit [--days N] | --compare-days N | --retry-skipped]",
    options: { sessions: "boolean", audit: "boolean", days: { type: "number", default: 7 }, "compare-days": "number", "retry-skipped": "boolean" },
  },
  login: { usage: "login" },
  revoke: { usage: "revoke" },
  secret: { usage: "secret" },
  update: { usage: "update" },
  version: { usage: "version" },
  help: { usage: "help" },
  // For the installer and the container.
  health: { usage: "health" },
  probe: { usage: "probe [URL]", args: ["url?"] },
  prefixes: { usage: "prefixes" },
  wrapper: { usage: "wrapper sh|ps1", args: ["kind"] },
};
SPECS["--help"] = SPECS["-h"] = SPECS.help;
SPECS["--version"] = SPECS.version;

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const optionSpec = (spec) => (typeof spec === "string" ? { type: spec } : spec);

export function parseCommandLine(command, words) {
  const spec = Object.hasOwn(SPECS, command) ? SPECS[command] : null;
  if (!spec) throw new Error(`Unknown command "${command}".`);
  const usage = `usage: pch ${spec.usage}`;
  const fail = (why) => {
    throw new Error(`${why}\n${usage}`);
  };
  const declared = spec.options ?? {};
  const options = {};
  for (const [name, raw] of Object.entries(declared)) {
    const o = optionSpec(raw);
    options[camel(name)] = o.default ?? (o.type === "boolean" ? false : null);
  }
  const takesText = (spec.args ?? []).some((a) => a.includes("..."));
  // The arguments before the text: once that many are in, any "--" is text.
  const fixed = (spec.args ?? []).filter((a) => !a.includes("...")).length;

  const given = new Set();
  const positionals = [];
  let help = false;
  let literal = false;
  for (let i = 0; i < words.length; i++) {
    const word = String(words[i]);
    if (literal || !word.startsWith("--") || /\s/.test(word) || (word === "--" && takesText && positionals.length > fixed)) {
      positionals.push(word);
      continue;
    }
    if (word === "--") {
      literal = true;
      continue;
    }
    const eq = word.indexOf("=");
    const name = word.slice(2, eq >= 0 ? eq : undefined);
    if (name === "help") {
      help = true;
      continue;
    }
    if (!Object.hasOwn(declared, name)) {
      const hint = takesText ? ` For text that starts with --, put a bare -- before it: pch ${command} ${spec.args[0].toUpperCase()} -- ${word} …` : "";
      fail(`pch ${command} has no option --${name}.${hint}`);
    }
    const o = optionSpec(declared[name]);
    if (o.type === "boolean") {
      if (eq >= 0) fail(`--${name} takes no value.`);
      options[camel(name)] = true;
      given.add(camel(name));
      continue;
    }
    let value = eq >= 0 ? word.slice(eq + 1) : words[++i];
    if (value === undefined || (eq < 0 && String(value).startsWith("--"))) fail(`--${name} needs a value.`);
    value = String(value);
    if (o.type === "number") {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n)) fail(`--${name} needs a number, not "${value}".`);
      value = n;
    } else if (o.choices && !o.choices.includes(value)) {
      fail(`--${name} must be one of ${o.choices.join(", ")}, not "${value}".`);
    } else if (!value) {
      fail(`--${name} needs a value.`);
    }
    options[camel(name)] = value;
    given.add(camel(name));
  }
  if (help) return { help: true, usage, args: {}, options, given };

  const args = {};
  for (const arg of spec.args ?? []) {
    const optional = arg.endsWith("?");
    const name = arg.replace(/[.?]+$/, "");
    if (arg.includes("...")) {
      const text = positionals.splice(0).join(" ").trim();
      if (!text && !optional) fail(`pch ${command} needs ${name === "text" && command !== "comment" ? "a comment" : "the text"}.`);
      args[name] = text;
      continue;
    }
    const value = positionals.shift();
    if (value === undefined && !optional) fail(`pch ${command} needs ${name === "issue" ? "an issue (ACM-12, say)" : `its ${name.toUpperCase()}`}.`);
    args[name] = value ?? null;
  }
  if (positionals.length) fail(`pch ${command} doesn't take "${positionals[0]}".`);
  const invalid = spec.validate?.(options, given);
  if (invalid) fail(invalid);
  return { help: false, usage, args, options, given };
}
