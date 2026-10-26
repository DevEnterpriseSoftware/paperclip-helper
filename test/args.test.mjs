// pch's command line (src/args.mjs): one set of rules for every command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCommandLine, SPECS } from "../src/args.mjs";
import { USAGE } from "../src/commands.mjs";

const parse = (line) => {
  const [command, ...words] = line;
  return parseCommandLine(command, words);
};

test("an option a command doesn't have stops it, rather than being posted as text or ignored", () => {
  assert.throws(() => parse(["comment", "ACM-1", "--apply", "hi"]), /pch comment has no option --apply\. For text that starts with --, put a bare -- before it: pch comment ISSUE -- --apply …\nusage: pch comment ISSUE text/);
  assert.throws(() => parse(["worktrees", "--force"]), /pch worktrees has no option --force\.\nusage: pch worktrees/);
  assert.throws(() => parse(["usage", "--weeks", "2"]), /has no option --weeks/);
  assert.throws(() => parse(["approve", "ACM-1", "--aply"]), /has no option --aply/);
});

test("an option's value can follow it or be joined to it", () => {
  for (const line of [["worktrees", "--min-days", "3"], ["worktrees", "--min-days=3"]]) {
    assert.deepEqual(parse(line).options, { apply: false, minDays: 3, includeUntracked: false, includeUnmerged: false, links: false, retry: false });
  }
  assert.deepEqual(parse(["usage", "--days=3", "--agent", "Carla"]).options, { days: 3, agent: "Carla" });
  assert.deepEqual(parse(["usage", "--agent=A=B"]).options, { days: 7, agent: "A=B" });
  assert.deepEqual(parse(["usage"]).options, { days: 7, agent: null });
  assert.deepEqual(parse(["release", "ACM-1", "--outcome", "completed", "--apply"]).options, { apply: true, outcome: "completed" });
  assert.deepEqual(parse(["release", "ACM-1", "--outcome=completed"]).options, { apply: false, outcome: "completed" });
  assert.deepEqual([...parse(["costs", "--audit", "--days", "3"]).given], ["audit", "days"]);
});

test("a bad value is named", () => {
  assert.throws(() => parse(["usage", "--days", "x"]), /--days needs a number, not "x"/);
  assert.throws(() => parse(["usage", "--days"]), /--days needs a value/);
  assert.throws(() => parse(["usage", "--agent", "--days", "3"]), /--agent needs a value/);
  assert.throws(() => parse(["usage", "--agent="]), /--agent needs a value/);
  assert.throws(() => parse(["release", "ACM-1", "--outcome=maybe"]), /--outcome must be one of mixed, completed, not_performed, not "maybe"/);
  assert.throws(() => parse(["worktrees", "--apply=yes"]), /--apply takes no value/);
});

test("text: the rest of the words; after a bare -- every word is text, and one dash is never an option", () => {
  assert.deepEqual(parse(["comment", "ACM-1", "Please", "rebase", "first."]).args, { issue: "ACM-1", text: "Please rebase first." });
  assert.deepEqual(parse(["comment", "ACM-1", "--", "--force", "is", "fine"]).args, { issue: "ACM-1", text: "--force is fine" });
  assert.deepEqual(parse(["comment", "ACM-1", "Fix the -1 offset", "-"]).args, { issue: "ACM-1", text: "Fix the -1 offset -" });
  // A quoted phrase is text, whatever it starts with.
  assert.deepEqual(parse(["comment", "ACM-1", "--force is fine here"]).args, { issue: "ACM-1", text: "--force is fine here" });
  assert.deepEqual(parse(["comment", "ACM-1", "--timeout=30 was too short"]).args, { issue: "ACM-1", text: "--timeout=30 was too short" });
  // A -- within the text stays.
  assert.deepEqual(parse(["comment", "ACM-1", "the", "build", "--", "not", "the", "tests"]).args, { issue: "ACM-1", text: "the build -- not the tests" });
  assert.deepEqual(parse(["approve", "ACM-1", "LGTM", "--", "ship", "it"]).args, { issue: "ACM-1", text: "LGTM -- ship it" });
  assert.deepEqual(parse(["answer", "ACM-1", "c1", "--", "--yes"]).args, { issue: "ACM-1", card: "c1", text: "--yes" });
  assert.deepEqual(parse(["approve", "ACM-1"]).args, { issue: "ACM-1", text: "" });
  assert.deepEqual(parse(["answer", "ACM-1", "c1", "yes"]).args, { issue: "ACM-1", card: "c1", text: "yes" });
  assert.deepEqual(parse(["set-model", "a", "b", "--apply"]), { help: false, usage: "usage: pch set-model FROM TO [--apply]", args: { from: "a", to: "b" }, options: { apply: true }, given: new Set(["apply"]) });
});

test("missing and extra arguments are usage errors", () => {
  assert.throws(() => parse(["why"]), /pch why needs an issue \(ACM-12, say\)\.\nusage: pch why ISSUE \[--prompt\]/);
  assert.throws(() => parse(["why", "--prompt"]), /needs an issue/);
  assert.throws(() => parse(["changes", "ACM-1"]), /pch changes needs a comment/);
  assert.throws(() => parse(["comment", "ACM-1"]), /pch comment needs the text/);
  assert.throws(() => parse(["set-model", "a"]), /needs its TO/);
  assert.throws(() => parse(["why", "ACM-1", "ACM-2"]), /pch why doesn't take "ACM-2"/);
  assert.throws(() => parse(["status", "now"]), /pch status doesn't take "now"/);
  assert.equal(parse(["check"]).args.issue, null);
  assert.throws(() => parse(["frobnicate"]), /Unknown command "frobnicate"/);
  assert.throws(() => parse(["constructor"]), /Unknown command "constructor"/);
});

test("worktrees: --retry needs --links, and --links takes no other option", () => {
  assert.deepEqual(parse(["worktrees", "--links", "--retry"]).options, { apply: false, minDays: 1, includeUntracked: false, includeUnmerged: false, links: true, retry: true });
  assert.throws(() => parse(["worktrees", "--retry"]), /--retry goes with --links\.\nusage: pch worktrees/);
  assert.throws(() => parse(["worktrees", "--links", "--apply"]), /--links takes only --retry\./);
  assert.throws(() => parse(["worktrees", "--links", "--min-days=3"]), /--links takes only --retry\./);
});

test("--help on a command prints its usage line", () => {
  assert.equal(parse(["release", "--help"]).help, true);
  assert.equal(parse(["release", "--help"]).usage, "usage: pch release ISSUE [--apply] [--outcome mixed|completed|not_performed]");
});

test("every command in the help has a spec with the same usage", () => {
  const help = USAGE.split("\n").map((l) => l.trim());
  for (const [name, spec] of Object.entries(SPECS)) {
    if (name.startsWith("-") || ["run", "help", "health", "probe", "prefixes", "wrapper"].includes(name)) continue;
    if (name === "costs") continue; // three lines in the help
    // Two lines in the help, one per form.
    const forms = name === "worktrees" ? spec.usage.split(" | ") : [spec.usage];
    for (const form of forms) assert.ok(help.some((l) => l.startsWith(form)), `pch help shows "${form}"`);
  }
});

test("pch stops on a usage error before it reads any settings or calls Paperclip", () => {
  const index = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [index, "comment", "ACM-1", "--apply", "hi"], { encoding: "utf8", env: { PATH: process.env.PATH, PAPERCLIP_API_URL: "http://127.0.0.1:9" } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^pch comment has no option --apply/);
  const help = spawnSync(process.execPath, [index, "worktrees", "--help"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0);
  assert.equal(help.stdout.trim(), "usage: pch worktrees [--apply] [--min-days N] [--include-untracked] [--include-unmerged] | worktrees --links [--retry]");
});
