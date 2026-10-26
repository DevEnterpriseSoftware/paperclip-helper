// Runs Paperclip refuses at setup on the workspace (workspace_validation_failed):
// `pch why` naming the reason, `pch worktrees --links [--retry]`, and watchdog 20.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";
import { advise } from "../src/advice.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createStateStore } from "../src/store.mjs";
import {
  hostPaths, meaningOf, nextRunOutcome, REASON_CODES, RELATIVE_LINKS, repairCommands, shq, stoppedByClassifier, validationOf,
} from "../src/worktree-links.mjs";

const CONFLICT = "persisted_workspace_source_conflict";
const NOT_REUSABLE = "git_worktree_not_reusable";
const NEXT_ACTION = "Board operator: repair the source task workspace link, project workspace cwd, or git checkout, then explicitly retry or reassign.";
const ERROR =
  "The selected execution workspace's original repository could not be verified. Restore its original project source. " +
  "Before intentionally clearing the task's existing-workspace binding to choose another repository, review and preserve its retained work.";

let n = 10;
// An issue Paperclip's recovery parked after its run failed the workspace validation:
// the run's resultJson and the recovery action's evidence carry the same reason.
function parked(db, agent, { worktree, code = RELATIVE_LINKS, reason = CONFLICT, extra = {}, status = "blocked", inList = false } = {}) {
  n += 1;
  const identifier = `ACM-${n}`;
  const ws = {
    id: uuid(), companyId: ids.company, mode: "isolated_workspace", status: "active", repoUrl: "https://github.com/org/app.git",
    cwd: worktree, providerRef: worktree, branchName: `${identifier}-work`,
  };
  const issue = {
    id: uuid(), identifier, companyId: ids.company, status, title: `Work ${identifier}`, assigneeAgentId: agent.id,
    executionWorkspaceId: ws.id, executionWorkspacePreference: "reuse_existing", updatedAt: minutesAgo(30),
  };
  ws.sourceIssueId = issue.id;
  const validation = { reason, reasonCode: code, executionWorkspaceId: ws.id, ...extra };
  const runId = uuid();
  const run = {
    id: runId, runId, companyId: ids.company, agentId: agent.id, status: "failed", errorCode: "workspace_validation_failed",
    error: ERROR, createdAt: minutesAgo(20), finishedAt: minutesAgo(20), resultJson: { workspaceValidation: validation },
  };
  db.issueRuns[issue.id] = [run];
  db.heartbeatRuns.push(run);
  const action = {
    id: uuid(), kind: "workspace_validation", status: "active", ownerType: "board", cause: "workspace_validation_failed", nextAction: NEXT_ACTION,
    evidence: { sourceIssueId: issue.id, latestRunId: runId, latestRunErrorCode: "workspace_validation_failed", recoveryCause: "workspace_validation_failed", workspaceValidation: validation },
    createdAt: minutesAgo(19),
  };
  db.recoveryActions[issue.id] = action;
  if (inList) issue.activeRecoveryAction = action;
  db.executionWorkspaces.push(ws);
  db.issues.push(issue);
  return { issue, ws, run, action };
}

async function env(t, extra = {}) {
  n = 10;
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", ...extra } });
  t.after(e.close);
  const builder = { id: uuid(), companyId: ids.company, name: "Builder", status: "idle", adapterType: "claude_local" };
  const reviewer = { id: uuid(), companyId: ids.company, name: "Reviewer", status: "idle", adapterType: "claude_local" };
  e.db.agents.push(builder, reviewer);
  return { ...e, builder, reviewer };
}

// ---------------------------------------------------------------- the pure parts

test("the validation is read from a run or a recovery action, and each known code has a meaning", () => {
  const v = { reason: CONFLICT, reasonCode: RELATIVE_LINKS, executionWorkspaceId: "w1" };
  assert.deepEqual(validationOf({ resultJson: { workspaceValidation: v } }), { ...v, worktreePath: null, inspection: null });
  assert.deepEqual(validationOf({ evidence: { workspaceValidation: v } }), { ...v, worktreePath: null, inspection: null });
  assert.equal(validationOf({ resultJson: {} }), null);
  assert.equal(validationOf({ evidence: { workspaceValidation: { executionWorkspaceId: "w1" } } }), null, "no reason, nothing to say");
  for (const code of Object.keys(REASON_CODES)) assert.ok(meaningOf({ reasonCode: code }), code);
  assert.equal(meaningOf({ reason: "something_new", reasonCode: "brand_new" }), null);
  assert.match(meaningOf({ reason: "git_worktree_base_materialization_failed" }), /couldn't create the project's checkout/);
  const inspection = validationOf({ evidence: { workspaceValidation: { reason: NOT_REUSABLE, reasonCode: "git_inspection_failed", inspectionDiagnostic: { command: "worktree_list", failure: "spawn_failed", errorCode: "ENOENT" } } } });
  assert.match(meaningOf(inspection), /`git worktree list` in the project checkout failed .*\(spawn_failed, ENOENT\)$/);
});

test("the checkout comes from Paperclip's worktree layout; other layouts ask git for it", () => {
  assert.deepEqual(hostPaths({ cwd: "/srv/app/.paperclip/worktrees/ACM-12-work/" }), {
    worktree: "/srv/app/.paperclip/worktrees/ACM-12-work", checkout: "/srv/app", worktreesDir: "/srv/app/.paperclip/worktrees",
  });
  assert.deepEqual(hostPaths({ providerRef: "/data/trees/ACM-12", cwd: "/elsewhere" }), { worktree: "/data/trees/ACM-12", checkout: null, worktreesDir: "/data/trees" });
  assert.deepEqual(hostPaths(null, { worktreePath: "/srv/app/.paperclip/worktrees/x" }).checkout, "/srv/app");
  assert.deepEqual(hostPaths(null), { worktree: null, checkout: null, worktreesDir: null });

  // Every worktree git lists for the checkout, wherever it is (a branch with a slash nests one).
  const list = `git -C "$B" worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2`;
  assert.deepEqual(repairCommands(hostPaths({ cwd: "/srv/app/.paperclip/worktrees/ACM-12-work" })), [
    "B='/srv/app'",
    'git -C "$B" config --local worktree.useRelativePaths false',
    `${list} | tr '\\n' '\\0' | xargs -0 -r git -C "$B" worktree repair --no-relative-paths`,
    `${list} | sed 's|$|/.git|' | tr '\\n' '\\0' | xargs -0 -r grep -L '^gitdir: /' | wc -l     # 0: every worktree links to the checkout by absolute path`,
    `grep -L '^/' "$B"/.git/worktrees/*/gitdir | wc -l     # 0: the checkout links to every worktree by absolute path`,
  ]);
  const custom = repairCommands(hostPaths({ cwd: "/data/trees/ACM-12" }));
  assert.equal(custom[0], `B="$(dirname "$(git -C '/data/trees/ACM-12' rev-parse --path-format=absolute --git-common-dir)")"`);
  assert.equal(custom.length, 5);
  assert.equal(shq("/srv/it's here"), `'/srv/it'\\''s here'`);
});

test("a retry's next run: past setup, the same failure, or not started yet; a refusal is recognised", () => {
  assert.equal(nextRunOutcome(null).kind, "waiting");
  assert.equal(nextRunOutcome({ status: "queued" }).kind, "waiting");
  assert.deepEqual(nextRunOutcome({ status: "running" }), { kind: "waiting", text: "running, still in setup" }, "claimed, the workspace not checked yet");
  assert.equal(nextRunOutcome({ status: "running" }, { adapterStarted: true }).kind, "past");
  assert.equal(nextRunOutcome({ status: "failed", errorCode: "adapter_failed" }).kind, "past");
  const again = nextRunOutcome({ status: "failed", errorCode: "workspace_validation_failed", resultJson: { workspaceValidation: { reason: CONFLICT, reasonCode: RELATIVE_LINKS } } });
  assert.deepEqual(again, { kind: "again", text: `failed at setup again (${CONFLICT}, ${RELATIVE_LINKS})` });
  const other = nextRunOutcome({ status: "failed", errorCode: "workspace_validation_failed", resultJson: { workspaceValidation: { reason: NOT_REUSABLE, reasonCode: "not_registered" } } });
  assert.deepEqual(other, { kind: "other", text: `failed at setup, now for another reason (${NOT_REUSABLE}, not_registered)` });
  assert.equal(stoppedByClassifier({ resultJson: { stopReason: "refusal" } }), true);
  assert.equal(stoppedByClassifier({ resultJson: { errorFamily: "model_refusal" } }), true);
  assert.equal(stoppedByClassifier({ status: "failed", errorCode: "adapter_failed", resultJson: {} }), false);
});

// ---------------------------------------------------------------- pch why

const facts = (v, ws, extra = {}) => ({
  identifier: "ACM-12",
  issue: { id: "i1", status: "blocked", assigneeAgentId: "a1" },
  assignee: { name: "Builder", status: "idle" },
  workspaceValidation: { ...v, paths: hostPaths(ws, v), repoUrl: ws?.repoUrl ?? null, nextAction: NEXT_ACTION },
  recovery: { kind: "workspace_validation", ownerType: "board", nextAction: NEXT_ACTION },
  config: {},
  ...extra,
});

test("why: every reason code gets its own advice, with Paperclip's next action; an unknown one is printed as it is", () => {
  const ws = { cwd: "/srv/app/.paperclip/worktrees/ACM-12-work", repoUrl: "https://github.com/org/app.git" };
  for (const code of Object.keys(REASON_CODES)) {
    const reason = ["missing_worktree", "not_a_git_checkout", "not_registered", "wrong_repository_root", "branch_mismatch", "git_inspection_failed"].includes(code) ? NOT_REUSABLE : CONFLICT;
    const advice = advise(facts({ reason, reasonCode: code }, ws));
    assert.match(advice.what, new RegExp(`^Builder's runs fail at setup \\(workspace_validation_failed: ${reason}, ${code}\\)`), code);
    assert.ok(advice.what.includes(REASON_CODES[code]), `${code} says what Paperclip couldn't prove`);
    assert.equal(advice.watchdog, "manual");
    if (code === RELATIVE_LINKS) continue;
    assert.equal(advice.steps[0], `Paperclip's own next action: ${NEXT_ACTION}`, code);
    // Two are in Paperclip's records, not on disk; one may need a new workspace.
    const onHost = !["source_scope_mismatch", "explicit_project_workspace_conflict", "source_repository_unavailable"].includes(code);
    assert.equal(advice.steps.at(-1), `${onHost ? "Once it's fixed on the host" : "Then"}: pch comment ACM-12 "Builder, the workspace is fixed. Please continue this issue."`, code);
    if (!onHost) assert.ok(advice.steps.some((s) => s.includes("New isolated workspace in its Workspace picker")), code);
  }
  assert.ok(advise(facts({ reason: CONFLICT, reasonCode: "source_scope_mismatch" }, ws)).steps.some((s) => s.startsWith("Nothing on disk fixes this")));
  const mismatch = advise(facts({ reason: CONFLICT, reasonCode: "source_repository_mismatch" }, ws));
  assert.ok(mismatch.steps.includes("Check, on the Paperclip host: git -C '/srv/app' config --local --get-all remote.origin.url   (it must print exactly one URL, https://github.com/org/app.git)"));

  const unknown = advise(facts({ reason: "something_new", reasonCode: "brand_new" }, ws));
  assert.match(unknown.what, /^Builder's runs fail at setup \(workspace_validation_failed: something_new, brand_new\) \(worktree \/srv\/app\/\.paperclip\/worktrees\/ACM-12-work\)\./);
  assert.equal(unknown.steps[0], `Paperclip's own next action: ${NEXT_ACTION}`);
  assert.ok(unknown.steps.some((s) => s.startsWith("pch why ACM-12 --prompt")));
});

test("why: relative worktree links get the check, the repair for the checkout and the retry", () => {
  const ws = { cwd: "/srv/app/.paperclip/worktrees/ACM-12-work" };
  const advice = advise(facts({ reason: CONFLICT, reasonCode: RELATIVE_LINKS }, ws));
  assert.match(advice.what, /worktree's links back to the project checkout can't be proven.*relative paths \(worktree\.useRelativePaths, git 2\.48 or newer\)/);
  assert.match(advice.steps[0], /^Check, on the Paperclip host: cat '\/srv\/app\/\.paperclip\/worktrees\/ACM-12-work\/\.git'   \(a gitdir: that doesn't start with \/ confirms it/);
  for (const line of repairCommands(hostPaths(ws))) assert.ok(advice.steps[1].includes(line), line);
  assert.match(advice.steps[2], /^Then retry: pch worktrees --links --retry/);
  // It comes before the hold and recovery rules: nothing else helps until the host is fixed.
  const held = advise(facts({ reason: CONFLICT, reasonCode: RELATIVE_LINKS }, ws, { issue: { id: "i1", status: "blocked", assigneeAgentId: "a1", executionBlocker: { cause: "x", nextAction: "y" } } }));
  assert.equal(held.what, advice.what);
});

test("pch why on a parked issue prints the reason code, the relative-link check and the repair for its checkout", async (t) => {
  const e = await env(t);
  const { issue } = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-11-work" });
  const lines = await captureOutput(() => cmd.why(e.ctx, issue.identifier));
  const text = lines.join("\n");
  assert.match(text, /^Workspace validation: persisted_workspace_source_conflict, source_registration_unproven \(workspace [0-9a-f]{8}\)$/m);
  assert.match(text, /^ {2}Meaning: the worktree's links back to the project checkout can't be proven/m);
  assert.match(text, /^ {2}Worktree: \/srv\/app\/\.paperclip\/worktrees\/ACM-11-work \(project checkout \/srv\/app\)$/m);
  assert.match(text, /^Recommendation: Builder's runs fail at setup \(workspace_validation_failed: persisted_workspace_source_conflict, source_registration_unproven\)/m);
  assert.match(text, /cat '\/srv\/app\/\.paperclip\/worktrees\/ACM-11-work\/\.git'/);
  assert.match(text, /^ {7}B='\/srv\/app'$/m);
  assert.match(text, /^ {7}git -C "\$B" worktree list --porcelain .* \| xargs -0 -r git -C "\$B" worktree repair --no-relative-paths$/m);
  assert.match(text, /pch worktrees --links --retry/);
  assert.doesNotMatch(text, /raw error text is withheld/);

  const prompt = (await captureOutput(() => cmd.why(e.ctx, issue.identifier, { prompt: true }))).join("\n");
  assert.match(prompt, /`workspace_validation_failed` means Paperclip refused the run before the agent started/);
  assert.match(prompt, /Workspace validation: persisted_workspace_source_conflict, source_registration_unproven/);
  assert.match(prompt, /git -C "\$B" config --local worktree\.useRelativePaths false/);
  assert.equal(e.db.comments.length, 0, "read-only");
});

test("pch why: a failed run's reason isn't advice once the issue has been woken since, or moved to another workspace", async (t) => {
  const e = await env(t);
  const { issue, run } = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-11-work", status: "todo" });
  e.db.recoveryActions[issue.id] = null;
  // The board's retry woke it, and the wake is still waiting.
  e.db.wakes[issue.id] = [{ kind: "wake_request", agentId: e.builder.id, status: "deferred_issue_execution", reason: "issue_reopened_via_comment", requestedAt: minutesAgo(1) }];
  let text = (await captureOutput(() => cmd.why(e.ctx, issue.identifier))).join("\n");
  assert.match(text, /^Last run's workspace validation: persisted_workspace_source_conflict, source_registration_unproven \(workspace [0-9a-f]{8}\); something has woken the issue since$/m);
  assert.doesNotMatch(text, /^Recommendation: Builder's runs fail at setup/m);
  // Still the current problem when nothing has tried since.
  e.db.wakes[issue.id] = [];
  text = (await captureOutput(() => cmd.why(e.ctx, issue.identifier))).join("\n");
  assert.match(text, /^Recommendation: Builder's runs fail at setup/m);
  // A new workspace since: not the issue's problem any more.
  issue.executionWorkspaceId = uuid();
  text = (await captureOutput(() => cmd.why(e.ctx, issue.identifier))).join("\n");
  assert.match(text, /; the issue is on another workspace since$/m);
  assert.doesNotMatch(text, /^Recommendation: Builder's runs fail at setup/m);
  void run;
});

test("pch why reads the reason from the recovery action when the run doesn't carry it", async (t) => {
  const e = await env(t);
  const { issue, run } = parked(e.db, e.builder, {
    worktree: "/srv/app/.paperclip/worktrees/ACM-12-work", reason: NOT_REUSABLE, code: "git_inspection_failed",
    extra: { inspectionDiagnostic: { command: "worktree_list", failure: "nonzero_exit", exitCode: 128 } },
  });
  delete run.resultJson;
  const text = (await captureOutput(() => cmd.why(e.ctx, issue.identifier))).join("\n");
  assert.match(text, /^Workspace validation: git_worktree_not_reusable, git_inspection_failed/m);
  assert.match(text, /\(nonzero_exit, exit 128\)/);
  assert.match(text, new RegExp(`Paperclip's own next action: ${NEXT_ACTION.replace(/[.,]/g, "\\$&")}`));
});

// ---------------------------------------------------------------- pch worktrees --links

test("worktrees --links groups the parked issues by checkout, with the host commands, and changes nothing", async (t) => {
  const e = await env(t);
  const a = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-11-work" });
  const b = parked(e.db, e.reviewer, { worktree: "/srv/app/.paperclip/worktrees/ACM-12-work", inList: true });
  const c = parked(e.db, e.builder, { worktree: "/srv/other/.paperclip/worktrees/ACM-13-work" });
  const mismatch = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-14-work", code: "source_repository_mismatch" });
  // Parked for another reason altogether: not listed.
  e.db.issues.push({ id: uuid(), identifier: "ACM-90", companyId: ids.company, status: "blocked", assigneeAgentId: e.builder.id });
  e.db.recoveryActions[e.db.issues.at(-1).id] = { id: uuid(), kind: "stranded_assigned_issue", ownerType: "board", evidence: {} };

  const lines = await captureOutput(() => cmd.worktrees(e.ctx, { links: true }));
  const text = lines.join("\n");
  assert.match(text, /^ACM: 3 issues fail every run at setup: Paperclip can't prove their worktrees link back to the project checkout \(source_registration_unproven\)$/m);
  assert.match(text, /^ {2}Project checkout \/srv\/app: 2 issues\n {4}ACM-11 +Builder +\/srv\/app\/\.paperclip\/worktrees\/ACM-11-work\n {4}ACM-12 +Reviewer +\/srv\/app\/\.paperclip\/worktrees\/ACM-12-work$/m);
  assert.match(text, /^ {2}Project checkout \/srv\/other: 1 issue$/m);
  assert.match(text, /^ {4}B='\/srv\/app'$/m);
  assert.match(text, /^ {4}B='\/srv\/other'$/m);
  assert.equal(lines.filter((l) => l.includes("worktree repair --no-relative-paths")).length, 2, "one repair per checkout");
  assert.match(text, /Every worktree in the checkout is repaired, not only these/);
  assert.match(text, new RegExp(`Also parked on workspace validation, for other reasons .*: ${mismatch.issue.identifier} \\(persisted_workspace_source_conflict, source_repository_mismatch\\)`));
  assert.doesNotMatch(text, /ACM-90/);
  assert.match(text, /^ {2}pch worktrees --links --retry$/m);
  assert.equal(e.db.comments.length, 0, "a preview posts nothing");
  assert.equal(e.db.patches.length, 0);
  // A list row that carries its recovery action is read from the row.
  assert.ok(!e.fake.requests.some((r) => r.path === `/api/issues/${b.issue.id}/recovery-actions`));
  assert.ok(e.fake.requests.some((r) => r.path === `/api/issues/${a.issue.id}/recovery-actions`));
  void c;
});

test("worktrees --links with nothing parked says so", async (t) => {
  const e = await env(t);
  const lines = await captureOutput(() => cmd.worktrees(e.ctx, { links: true, retry: true }));
  assert.deepEqual(lines, ["ACM: no issue is parked on its worktree links."]);
  assert.equal(e.db.comments.length, 0);
});

test("worktrees --links --retry comments only on issues still parked, never on one a classifier stopped, and reports each next run", async (t) => {
  const e = await env(t);
  const paused = { id: uuid(), companyId: ids.company, name: "Sleeper", status: "paused", adapterType: "claude_local" };
  e.db.agents.push(paused);
  const fixed = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-11-work" });
  const stillRelative = parked(e.db, e.reviewer, { worktree: "/srv/app/.paperclip/worktrees/ACM-12-work" });
  const asleep = parked(e.db, paused, { worktree: "/srv/app/.paperclip/worktrees/ACM-13-work" });
  const refused = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-14-work" });
  const moved = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-15-work" });
  // ACM-14's last run that reached the model was stopped by its safety classifier.
  const stopped = { id: uuid(), companyId: ids.company, agentId: e.builder.id, status: "failed", errorCode: "adapter_failed", createdAt: minutesAgo(60), finishedAt: minutesAgo(59), resultJson: { stopReason: "refusal", errorFamily: "model_refusal" } };
  stopped.runId = stopped.id;
  e.db.issueRuns[refused.issue.id].push(stopped);
  e.db.heartbeatRuns.push(stopped);
  // ACM-15 is unparked by someone else while the retry is under way.
  let first = true;
  e.db.onRequest = (method, p) => {
    if (first && method === "POST" && p.endsWith("/comments")) {
      first = false;
      moved.issue.status = "todo";
      e.db.recoveryActions[moved.issue.id] = null;
    }
  };
  // Still blocked by an open issue: a comment wouldn't reopen it.
  const blockedToo = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-16-work" });
  e.db.blockerDiagnostics[blockedToo.issue.id] = { readiness: { unresolvedBlockerCount: 1 }, blockers: [{ id: uuid(), identifier: "ACM-99", status: "in_progress" }] };
  // A review stage still pending: In review, not a comment, wakes its participant.
  const inReview = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-17-work" });
  inReview.issue.executionState = { status: "pending", currentStageType: "review", currentParticipant: { type: "agent", agentId: e.reviewer.id } };
  // A worktree the repair doesn't fix: the next run fails for another reason now.
  const otherNow = parked(e.db, e.reviewer, { worktree: "/srv/app/.paperclip/worktrees/ACM-18-work" });
  // What the woken runs do: ACM-11 gets past setup (its adapter starts), ACM-12 fails the
  // same way again, ACM-18 for another reason.
  e.db.onReopen = (issue, run) => {
    if (issue.id === fixed.issue.id) {
      run.status = "running";
      e.db.runEvents[run.id] = [{ seq: 1, eventType: "adapter.invoke", payload: {} }];
    }
    if (issue.id === stillRelative.issue.id) Object.assign(run, { status: "failed", errorCode: "workspace_validation_failed", resultJson: stillRelative.run.resultJson });
    if (issue.id === otherNow.issue.id) {
      Object.assign(run, { status: "failed", errorCode: "workspace_validation_failed", resultJson: { workspaceValidation: { reason: NOT_REUSABLE, reasonCode: "not_registered" } } });
    }
  };

  const lines = await captureOutput(() => cmd.worktrees(e.ctx, { links: true, retry: true, waitMs: 2000, pollMs: 50 }));
  const exitCode = process.exitCode;
  process.exitCode = 0;
  const text = lines.join("\n");
  const commented = e.db.comments.map((c) => c.identifier).sort();
  assert.deepEqual(commented, [fixed.issue.identifier, stillRelative.issue.identifier, otherNow.issue.identifier]);
  assert.equal(
    e.db.comments.find((c) => c.identifier === fixed.issue.identifier).body,
    "Builder, the worktree links are repaired: Paperclip can verify this issue's workspace again. Please continue this issue.\n\n_Sent with Paperclip Helper (`pch`)._",
  );
  assert.match(text, /^ACM-13: left alone \(Sleeper is paused, so a comment wouldn't wake it\)\.$/m);
  assert.match(text, /^ACM-14: left alone \(its last run was stopped by the model's safety classifier: that stays your call\)\.$/m);
  assert.match(text, /^ACM-15: left alone \(it is todo now\)\.$/m);
  assert.match(text, /^ {2}ACM-11 +running: past setup$/m);
  assert.match(text, /^ {2}ACM-12 +failed at setup again \(persisted_workspace_source_conflict, source_registration_unproven\)$/m);
  assert.match(text, /^ACM-16: left alone \(it is also blocked by ACM-99, so a comment wouldn't reopen it\)\.$/m);
  assert.match(text, /^ACM-17: left alone \(a review stage is pending on it: set it back to In review/m);
  assert.match(text, /^ {2}ACM-18 +failed at setup, now for another reason \(git_worktree_not_reusable, not_registered\): `pch why ACM-18`$/m);
  assert.match(text, /1 issue failed the same way\. Either the links are still relative/);
  assert.equal(exitCode, 1, "a retry that failed again fails the command");
  // Nothing but comments: no run cancelled, no agent paused, no issue changed by the helper.
  assert.equal(e.db.patches.length, 0);
  assert.deepEqual(e.db.lifecycle ?? [], []);
  assert.ok(!e.fake.requests.some((r) => r.method !== "GET" && !r.path.endsWith("/comments")));
  void asleep;
});

test("--retry needs --links, and --links takes no other option", async (t) => {
  const e = await env(t);
  await assert.rejects(cmd.worktrees(e.ctx, { retry: true }), /--retry goes with --links/);
  await assert.rejects(cmd.worktrees(e.ctx, { links: true, apply: true }), /--links takes only --retry/);
  await assert.rejects(cmd.worktrees(e.ctx, { links: true, given: new Set(["minDays"]) }), /--links takes only --retry/);
});

// ---------------------------------------------------------------- watchdog 20

async function watchdogEnv(t, extra = {}) {
  n = 10;
  const clock = { at: Date.now() };
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", WATCHDOG_NOTIFY_ISSUE: "ACM-1", ...extra }, now: () => clock.at });
  t.after(e.close);
  e.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo", title: "Board notes", updatedAt: minutesAgo(600) });
  const builder = { id: uuid(), companyId: ids.company, name: "Builder", status: "idle", adapterType: "claude_local" };
  e.db.agents.push(builder);
  const state = createStateStore(e.ctx.config.stateFile, { now: () => clock.at });
  return { ...e, clock, state, builder, notes: () => e.db.comments.filter((c) => c.identifier === "ACM-1") };
}

test("watchdog: one board note per checkout naming the command, never a comment on the issues", async (t) => {
  const e = await watchdogEnv(t);
  const a = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-11-work" });
  const b = parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-12-work" });
  const c = parked(e.db, e.builder, { worktree: "/srv/other/.paperclip/worktrees/ACM-13-work" });
  const watchdog = createWatchdog(e.ctx, e.state);
  await watchdog.tick();
  const notes = e.notes();
  assert.equal(notes.length, 2, "one per checkout");
  assert.equal(
    notes[0].body,
    `2 issues fail every run at setup (workspace_validation_failed, source_registration_unproven): Paperclip can't prove that their worktrees link back to the project checkout \`/srv/app\`: ${a.issue.identifier}, ${b.issue.identifier}. ` +
      "Most likely git wrote the links as relative paths (worktree.useRelativePaths, git 2.48 or newer). " +
      "`pch worktrees --links` prints the repair to run on the Paperclip host; after it, `pch worktrees --links --retry` wakes the issues. " +
      "The watchdog doesn't comment on them: before the repair, a comment only fails the same way.\n\n_Paperclip Helper watchdog._",
  );
  assert.match(notes[1].body, new RegExp(`^1 issue fails every run at setup .*\`/srv/other\`: ${c.issue.identifier}\\. `));
  for (const p of [a, b, c]) assert.equal(e.db.comments.filter((x) => x.issueId === p.issue.id).length, 0, "the issues are left alone");
  assert.equal(watchdog.stats.worktreeLinkNotes, 2);
  assert.ok(!e.logs.some((l) => l.msg === "watchdog: Paperclip's recovery parked the issue and it needs a board decision"), "6 leaves them to the note");

  // Later ticks, and a restart, say nothing new while the same checkouts stay parked.
  e.clock.at += 10 * 60_000;
  await watchdog.tick();
  await createWatchdog(e.ctx, e.state).tick();
  assert.equal(e.notes().length, 2);

  // A read that fails for a scan neither forgets the checkout nor notes it again.
  e.fake.fail("GET", `/api/execution-workspaces/${c.ws.id}`, 500, { times: 3 });
  e.fake.fail("GET", `/api/issues/${c.issue.id}`, 500, { times: 3 });
  e.fake.fail("GET", `/api/issues/${a.issue.id}/recovery-actions`, 500, { times: 3 });
  e.clock.at += 10 * 60_000;
  await watchdog.tick();
  e.fake.clearFailures();
  e.clock.at += 10 * 60_000;
  await watchdog.tick();
  assert.equal(e.notes().length, 2, "no second note after a failed read");
  // Still parked a week on: the record is kept fresh, so the note isn't repeated.
  for (let day = 0; day < 9; day += 1) {
    e.clock.at += 24 * 60 * 60_000;
    await watchdog.tick();
    e.state.save({ force: true });
  }
  assert.equal(e.notes().length, 2, "no weekly repeat");

  // /srv/other is repaired; when it happens there again, that is a new note.
  e.db.recoveryActions[c.issue.id] = null;
  c.issue.status = "in_progress";
  e.clock.at += 10 * 60_000;
  await watchdog.tick();
  assert.equal(e.notes().length, 2);
  const d = parked(e.db, e.builder, { worktree: "/srv/other/.paperclip/worktrees/ACM-20-work" });
  e.clock.at += 10 * 60_000;
  await watchdog.tick();
  assert.equal(e.notes().length, 3);
  assert.match(e.notes()[2].body, new RegExp(`\`/srv/other\`: ${d.issue.identifier}\\. `));
});

test("watchdog: other workspace-validation codes stay with 6's report; off and dry runs post nothing", async (t) => {
  const e = await watchdogEnv(t);
  parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-11-work", code: "source_repository_mismatch" });
  await createWatchdog(e.ctx, e.state).tick();
  assert.equal(e.notes().length, 0);
  const report = e.logs.find((l) => l.msg === "watchdog: Paperclip's recovery parked the issue and it needs a board decision");
  assert.equal(report?.reasonCode, "source_repository_mismatch");

  parked(e.db, e.builder, { worktree: "/srv/app/.paperclip/worktrees/ACM-12-work" });
  await createWatchdog(e.makeCtx({ WATCHDOG_WORKTREE_LINKS: "false" }), e.state).tick();
  assert.equal(e.notes().length, 0, "switched off");
  await createWatchdog(e.makeCtx({ DRY_RUN: "true" }), e.state).tick();
  assert.equal(e.notes().length, 0, "a dry run only logs");
  assert.ok(e.logs.some((l) => l.msg === "watchdog: would tell the board about relative worktree links (dry run)"));
});
