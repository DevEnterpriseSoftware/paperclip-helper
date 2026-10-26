// Runs refused at setup because Paperclip can't verify the issue's workspace
// (`workspace_validation_failed`): what each reason means, and the case the
// helper can do something about, worktrees whose git links are relative.
// `pch why`, `pch worktrees --links` and the watchdog (20) share this module.
//
// Before a run reuses an issue's execution workspace, Paperclip checks that the
// worktree on disk still belongs to the project checkout it was made from
// (resolvePersistedGitWorkspaceSource, server/src/services/persisted-workspace-source.ts),
// and that `git worktree list` there still lists it (inspectManagedGitWorktreeBranch,
// server/src/services/workspace-runtime.ts). When either can't be proven it fails
// the run before the adapter starts, with `errorCode: "workspace_validation_failed"`
// and the reason in the run's `resultJson.workspaceValidation`:
// `{ reason, reasonCode, executionWorkspaceId }`. Its recovery then blocks the
// issue under a board-owned recovery action (`kind: "workspace_validation"`) whose
// `evidence.workspaceValidation` is the same object. The wake diagnostics only say
// "raw error text is withheld", and the next action is generic.
//
// `source_registration_unproven` has a cause that git itself is happy with. With
// `worktree.useRelativePaths` set (git 2.48 or newer) for the user Paperclip runs as,
// git writes both of a worktree's links as relative paths: `<worktree>/.git` holds
// `gitdir: ../../../.git/worktrees/<name>`, and the checkout's
// `.git/worktrees/<name>/gitdir` holds `../../../.paperclip/worktrees/<name>/.git`.
// Paperclip's hasLinkedWorktreeStorage() calls realpath() on that second one without
// resolving it against the folder it is in, so it resolves against Paperclip's own
// working directory, never matches, and every run on every such worktree fails.
// The repair (on the host, as that user) is the checkout's own
// `worktree.useRelativePaths false` and `git worktree repair --no-relative-paths` over
// its worktrees; then a board comment retries each issue. The helper never touches
// the disk, and usually can't see it, so it prints those commands.

import path from "node:path";
import { listIssues } from "./paperclip.mjs";
import { ACTIVE_RUN, asleep, mapLimit, plural, ts } from "./util.mjs";

export const VALIDATION_FAILED = "workspace_validation_failed";
export const RECOVERY_KIND = "workspace_validation";
export const RELATIVE_LINKS = "source_registration_unproven";

// Where Paperclip puts a project's worktrees unless its strategy sets worktreeParentDir.
const MANAGED_DIR = "/.paperclip/worktrees/";

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// What each reason code says Paperclip couldn't prove, read from Paperclip's source at
// 2026.1023.0. The first group is persisted_workspace_source_conflict, the second
// git_worktree_not_reusable (the source check reports git_inspection_failed under that
// reason too).
export const REASON_CODES = {
  source_scope_mismatch:
    "the workspace isn't the issue's: it belongs to another company or project, or the project workspace it was made from is gone or belongs elsewhere",
  explicit_project_workspace_conflict:
    "the issue asks for a different project workspace than the one its existing execution workspace was made from",
  source_path_unproven:
    "the workspace's path can't be trusted: it records none, its cwd and providerRef disagree, or something is at the path that isn't a folder Paperclip can resolve (a broken link, no permission)",
  source_registration_unproven:
    "the worktree's links back to the project checkout can't be proven: its .git isn't a file pointing at the checkout, or no project checkout lists it as a worktree whose gitdir link leads back to it",
  source_repository_mismatch:
    "the project checkout that owns the worktree isn't the workspace's repository: its stored remote.origin.url (the local config value, not `git remote get-url`) differs from the workspace's repoUrl, or it has more than one origin URL",
  source_repository_unavailable:
    "the worktree is gone and Paperclip can't rebuild it from the original repository: the workspace records no repoUrl, or no checkout of that repository is available and it may not clone one",
  missing_worktree: "the worktree's folder doesn't exist",
  not_a_git_checkout: "the worktree's folder isn't a git checkout",
  not_registered: "the project checkout's `git worktree list` doesn't list the worktree",
  wrong_repository_root: "git resolves the worktree's folder to a different repository root",
  branch_mismatch: "the worktree is on a different branch than the workspace records",
  git_inspection_failed:
    "`git worktree list` in the project checkout failed (git couldn't start, exited with an error, or printed more than Paperclip reads), so nothing could be checked",
};

// Reasons with no code of their own, as Paperclip's recovery words them.
const REASONS = {
  git_worktree_branch_incoherence: "the worktree's branch doesn't agree with what Paperclip recorded for it",
  git_worktree_base_materialization_failed: "Paperclip couldn't create the project's checkout to make the worktree from (its repository URL, or access to clone it)",
};

// The validation Paperclip recorded, from a run (`resultJson.workspaceValidation`)
// or a recovery action (`evidence.workspaceValidation`). Null when there is none.
export function validationOf(source) {
  const v = source?.resultJson?.workspaceValidation ?? source?.evidence?.workspaceValidation ?? null;
  if (!v || typeof v !== "object") return null;
  const reason = text(v.reason);
  const reasonCode = text(v.reasonCode);
  if (!reason && !reasonCode) return null;
  const d = v.inspectionDiagnostic && typeof v.inspectionDiagnostic === "object" ? v.inspectionDiagnostic : null;
  return {
    reason,
    reasonCode,
    executionWorkspaceId: text(v.executionWorkspaceId),
    worktreePath: text(v.worktreePath),
    inspection: d ? { failure: text(d.failure), errorCode: text(d.errorCode), exitCode: Number.isInteger(d.exitCode) ? d.exitCode : null } : null,
  };
}

// What the reason says Paperclip couldn't prove, in one clause; null for one it doesn't know.
export function meaningOf(v) {
  if (!v) return null;
  const known = (v.reasonCode && REASON_CODES[v.reasonCode]) ?? (v.reason && REASONS[v.reason]) ?? null;
  if (!known || v.reasonCode !== "git_inspection_failed" || !v.inspection?.failure) return known;
  const how = v.inspection.errorCode ? `, ${v.inspection.errorCode}` : v.inspection.exitCode != null ? `, exit ${v.inspection.exitCode}` : "";
  return `${known} (${v.inspection.failure}${how})`;
}

// "persisted_workspace_source_conflict, source_registration_unproven"
export const codeLabel = (v) => [v?.reason, v?.reasonCode].filter(Boolean).join(", ");

// Where the worktree and its project checkout are on Paperclip's host, from the
// workspace's path. Paperclip's own layout is <checkout>/.paperclip/worktrees/<name>;
// for another (a strategy's worktreeParentDir) the checkout isn't known, and the
// commands ask git for it.
export function hostPaths(workspace, v = null) {
  const raw = text(workspace?.providerRef) ?? text(workspace?.cwd) ?? v?.worktreePath ?? null;
  if (!raw) return { worktree: null, checkout: null, worktreesDir: null };
  const worktree = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  const i = worktree.indexOf(MANAGED_DIR);
  if (i > 0) return { worktree, checkout: worktree.slice(0, i), worktreesDir: worktree.slice(0, i + MANAGED_DIR.length - 1) };
  return { worktree, checkout: null, worktreesDir: path.posix.dirname(worktree) };
}

// A path for a POSIX shell, in single quotes.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The check that tells relative links from anything else.
export const linkCheck = (paths) => `cat ${shq(`${paths.worktree ?? "<worktree>"}/.git`)}`;

// The checkout's linked worktrees, one path per line, as git lists them (absolute, whatever
// the links say, and wherever they are: a branch name with a slash nests one a level down).
const LIST = `git -C "$B" worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2`;

// The two counts of links that are still relative: the worktrees' own (.git files) and
// the checkout's (gitdir files). Both 0 means every link is absolute.
const RELATIVE_WORKTREE_LINKS = `${LIST} | sed 's|$|/.git|' | tr '\\n' '\\0' | xargs -0 -r grep -L '^gitdir: /' | wc -l`;
const RELATIVE_CHECKOUT_LINKS = `grep -L '^/' "$B"/.git/worktrees/*/gitdir | wc -l`;

// When git writes relative worktree links (worktree.useRelativePaths, git 2.48 or newer)
// it also turns on a repository extension in the checkout's shared config,
// extensions.relativeWorktrees, and `git worktree repair --no-relative-paths` leaves it
// on. Git and Paperclip don't mind it; a tool with its own git reader refuses the whole
// repository: .NET SourceLink (Microsoft.Build.Tasks.Git) fails every build with
// "Unsupported repository extension 'relativeworktrees'", and libgit2-based tools can
// fail the same way. Removing it is safe once every link is absolute, and the
// repository's own worktree.useRelativePaths false keeps new links absolute.
export const EXTENSION = "extensions.relativeWorktrees";
export const EXTENSION_ERROR = /Unsupported repository extension '?relativeworktrees'?/i;

// The unset, run only when both counts are 0, so a half-finished repair never leaves
// relative links without the extension git needs to read them. `git config --unset`
// exits 5 when the key isn't there: already done, not an error.
export const UNSET_EXTENSION =
  `[ "$(${RELATIVE_WORKTREE_LINKS})" -eq 0 ] && [ "$(${RELATIVE_CHECKOUT_LINKS})" -eq 0 ] && ` +
  `{ git -C "$B" config --unset ${EXTENSION} || [ $? -eq 5 ]; }     # only once both counts are 0: .NET SourceLink and libgit2 refuse the extension git leaves behind`;

// The line that sets $B: the checkout from the path, or, outside Paperclip's own layout,
// from git (which still reads relative links).
const checkoutLine = (paths) =>
  paths.checkout
    ? `B=${shq(paths.checkout)}`
    : `B="$(dirname "$(git -C ${shq(paths.worktree ?? "<worktree>")} rev-parse --path-format=absolute --git-common-dir)")"`;

// The host commands for one project checkout, ready to paste: this repository's own
// worktree.useRelativePaths false (the user's global setting stays), the repair over
// every worktree git lists for it (any other with relative links fails on its next run),
// the two counts that should both print 0, and then, only if they do, the removal of
// the extension git leaves behind. For Paperclip's own layout this repairs what
// `"$B"/.paperclip/worktrees/*/` names, the form that fixed it on a live instance.
export function repairCommands(paths) {
  return [
    checkoutLine(paths),
    `git -C "$B" config --local worktree.useRelativePaths false`,
    `${LIST} | tr '\\n' '\\0' | xargs -0 -r git -C "$B" worktree repair --no-relative-paths`,
    `${RELATIVE_WORKTREE_LINKS}     # 0: every worktree links to the checkout by absolute path`,
    `${RELATIVE_CHECKOUT_LINKS}     # 0: the checkout links to every worktree by absolute path`,
    UNSET_EXTENSION,
  ];
}

// For a checkout already repaired without the last step: the check, then the same
// guarded unset (which also confirms no link is relative any more).
export function extensionCommands(paths) {
  return [checkoutLine(paths), `git -C "$B" config --get ${EXTENSION}     # true: the extension is still on`, UNSET_EXTENSION];
}

// Codes whose cause is in Paperclip's own records (the issue moved project, its project
// workspace changed), not on the host: nothing on disk fixes them.
const IN_PAPERCLIP = new Set(["source_scope_mismatch", "explicit_project_workspace_conflict"]);
const NEW_WORKSPACE =
  "once the work on its branch is safe (pushed, or merged), give the issue a new workspace: New isolated workspace in its Workspace picker. " +
  "Paperclip leaves the old worktree and branch as they are";

// What `pch why` recommends for a run Paperclip refused at setup on its workspace.
// `facts`: { identifier, who, comment(text) → command, nextAction, paths, repoUrl }.
export function validationAdvice(v, { identifier, who, comment, nextAction = null, paths = {}, repoUrl = null }) {
  const label = codeLabel(v) || "no reason given";
  const theirs = nextAction ? [`Paperclip's own next action: ${nextAction}`] : [];
  if (v.reasonCode === RELATIVE_LINKS) {
    const cmds = repairCommands(paths).map((l) => `       ${l}`).join("\n");
    return {
      what:
        `${who}'s runs fail at setup (${VALIDATION_FAILED}: ${label}): ${REASON_CODES[RELATIVE_LINKS]}. ` +
        "Most likely git wrote the worktree's links as relative paths (worktree.useRelativePaths, git 2.48 or newer), which Paperclip doesn't resolve; " +
        "git itself is happy with them. Retries and comments fail the same way until the links are absolute.",
      steps: [
        `Check, on the Paperclip host: ${linkCheck(paths)}   (a gitdir: that doesn't start with / confirms it. A folder instead of a file is a separate clone, ` +
          `and a worktree \`git worktree list\` doesn't show fails the same way: the repair won't help those; ${NEW_WORKSPACE})`,
        `Repair, on the Paperclip host as the user Paperclip runs as (this repository only; the user's global git setting stays):\n${cmds}\n` +
          "     Every worktree in the checkout is repaired, not only this one: any other with relative links fails on its next run. " +
          `The last line removes ${EXTENSION}, which git turned on with the relative links and leaves behind: .NET SourceLink and libgit2 refuse a repository that has it.`,
        `Then retry: pch worktrees --links --retry   (comments on every issue still parked this way, which is Paperclip's retry; or ${comment(`${who}, the worktree links are repaired. Please continue this issue.`)})`,
      ],
      watchdog: "manual",
    };
  }
  const meaning = meaningOf(v);
  const where = paths.worktree ? ` (worktree ${paths.worktree})` : "";
  const extra = [];
  if (v.reasonCode === "source_repository_mismatch" && paths.checkout) {
    extra.push(
      `Check, on the Paperclip host: git -C ${shq(paths.checkout)} config --local --get-all remote.origin.url   ` +
        `(it must print exactly one URL${repoUrl ? `, ${repoUrl}` : ", the workspace's repoUrl"})`,
    );
  }
  let fix;
  if (IN_PAPERCLIP.has(v.reasonCode)) {
    extra.push(`Nothing on disk fixes this: it's in Paperclip's records. Put the issue's project or project workspace back, or ${NEW_WORKSPACE}.`);
    fix = "Then";
  } else if (v.reasonCode === "source_repository_unavailable") {
    extra.push(`Restore the project's checkout${repoUrl ? ` of ${repoUrl}` : ""} on the host (or the workspace's repository URL), or ${NEW_WORKSPACE}.`);
    fix = "Then";
  } else {
    fix = "Once it's fixed on the host";
  }
  return {
    what:
      `${who}'s runs fail at setup (${VALIDATION_FAILED}: ${label})${meaning ? `: Paperclip couldn't verify the workspace, because ${meaning}` : ""}${where}. ` +
      "Retries and comments fail the same way until that is fixed.",
    steps: [
      ...theirs,
      ...extra,
      ...(meaning ? [] : [`pch why ${identifier} --prompt   (Paperclip's reason isn't one the helper knows: the prompt carries it for an LLM chat)`]),
      `${fix}: ${comment(`${who}, the workspace is fixed. Please continue this issue.`)}`,
    ],
    watchdog: "manual",
  };
}

// What `pch why` recommends when the assignee's builds fail on the extension git left
// behind (EXTENSION_ERROR in its last comments or its last run's error): the agent
// reports it, Paperclip doesn't, so it shows up nowhere else.
export function extensionAdvice({ who, comment, paths = {} }) {
  const cmds = extensionCommands(paths).map((l) => `       ${l}`).join("\n");
  return {
    what:
      `${who}'s builds fail with "Unsupported repository extension 'relativeworktrees'": the project checkout still has ${EXTENSION}, ` +
      "which git turned on when it wrote relative worktree links and which `git worktree repair --no-relative-paths` leaves behind. " +
      "Git and Paperclip don't mind it, but tools with their own git reader refuse the repository: .NET SourceLink (every `dotnet build`), and libgit2-based tools.",
    steps: [
      `On the Paperclip host, as the user Paperclip runs as:\n${cmds}\n` +
        "     The unset runs only once no link is relative (both counts 0); if it doesn't run, the repair isn't finished: `pch worktrees --links` prints all of it.",
      `Then: ${comment(`${who}, the repository extension that broke the build is removed. Please run the build again and continue this issue.`)}`,
    ],
    watchdog: "manual",
  };
}

// ---------------------------------------------------------------- the API side

// The workspace an issue's validation names, as far as the key can read it: the
// workspace itself, else the issue's inline copy when it is the same one. With
// `issueId`, the issue is read for that copy when the workspace can't be.
export async function readWorkspace(api, workspaceId, issue = null, { issueId = null } = {}) {
  if (workspaceId) {
    const ws = await api.request("GET", `/api/execution-workspaces/${workspaceId}`).catch(() => null);
    if (ws) return ws;
  }
  const full = issue ?? (issueId ? await api.request("GET", `/api/issues/${issueId}`).catch(() => null) : null);
  const inline = full?.currentExecutionWorkspace;
  return inline && (!workspaceId || inline.id === workspaceId) ? inline : null;
}

// The open issues Paperclip's recovery parked on a workspace validation, with the
// validation from the recovery action's evidence. A list row's activeRecoveryAction
// is used when it carries the evidence; otherwise the issue's own recovery actions.
// `reasonCode` keeps only that code. `report.incomplete` is set when an issue's
// recovery actions couldn't be read, so the list may be missing some.
export async function parkedOnValidation(api, companyId, { reasonCode = null, concurrency = 4, report = {} } = {}) {
  const rows = await listIssues(api, companyId, "blocked");
  const found = [];
  await mapLimit(rows, concurrency, async (row) => {
    let action = row.activeRecoveryAction;
    if (action === undefined || (action && !action.evidence)) {
      const r = await api.request("GET", `/api/issues/${row.id}/recovery-actions`).catch(() => null);
      if (!r) report.incomplete = true;
      action = r?.active ?? null;
    }
    if (action?.kind !== RECOVERY_KIND) return;
    const validation = validationOf(action);
    if (!validation || (reasonCode && validation.reasonCode !== reasonCode)) return;
    found.push({ issue: row, action, validation });
  });
  return found.sort((a, b) => String(a.issue.identifier ?? a.issue.id).localeCompare(String(b.issue.identifier ?? b.issue.id), undefined, { numeric: true }));
}

// The parked issues grouped by the project checkout their worktrees belong to (the
// folder of worktrees when the checkout can't be told from the path):
// [{ key, paths, unknown, items: [{ issue, action, validation, workspace, paths }] }].
// `unknown` marks the group of issues whose workspace couldn't be read.
export async function byCheckout(api, parked) {
  const groups = new Map();
  const seen = new Map();
  for (const p of parked) {
    const wsId = p.validation.executionWorkspaceId ?? p.issue.executionWorkspaceId ?? null;
    if (!seen.has(wsId)) seen.set(wsId, await readWorkspace(api, wsId, null, { issueId: p.issue.id }));
    const workspace = seen.get(wsId);
    const paths = hostPaths(workspace, p.validation);
    const key = paths.checkout ?? paths.worktreesDir ?? "(unknown)";
    if (!groups.has(key)) groups.set(key, { key, paths, unknown: !paths.worktree, items: [] });
    groups.get(key).items.push({ ...p, workspace, paths });
  }
  return [...groups.values()];
}

// Why `--retry` shouldn't comment on this issue now; null when it may. `issue` is the
// full issue; `runs` its run list; `blockers` its /diagnostics/blockers; `detailOf(run)`
// reads a run's detail.
export async function retryProblem(issue, action, runs, { agent = null, blockers = null, detailOf } = {}) {
  if (issue.status !== "blocked") return `it is ${issue.status} now`;
  const v = validationOf(action);
  if (action?.kind !== RECOVERY_KIND || v?.reasonCode !== RELATIVE_LINKS) return "it isn't parked on its worktree links any more";
  if (!issue.assigneeAgentId) return "nobody is assigned";
  if (agent && asleep(agent)) return `${agent.name ?? "its agent"} is ${agent.status.replace("_", " ")}, so a comment wouldn't wake it`;
  // A comment reopens a blocked issue only when no blocker is unresolved (the comment
  // route's reopen); otherwise it stays blocked and nobody is woken.
  const open = (Array.isArray(blockers?.blockers) ? blockers.blockers : []).filter((b) => (b.status !== "done" && b.status !== "cancelled") || b.isPendingFinalize);
  if (open.length || blockers?.readiness?.unresolvedBlockerCount > 0) {
    return `it is also blocked by ${open.length ? open.map((b) => b.identifier ?? b.id).join(", ") : "an unresolved issue"}, so a comment wouldn't reopen it`;
  }
  // A comment reopens to todo for the assignee; a pending review stage wants its own
  // participant woken: moving the issue back to In review does that.
  if (issue.executionState?.status === "pending") {
    return "a review stage is pending on it: set it back to In review, which wakes the stage's participant, instead of a comment that hands it to the assignee";
  }
  const list = Array.isArray(runs) ? runs : [];
  const active = list.find((r) => ACTIVE_RUN.has(r.status));
  if (active) return `a run is ${active.status} on it`;
  // The last run that got past setup: one a model's safety classifier stopped stays
  // with the board, whatever the workspace does.
  const reached = [...list].sort((a, b) => ts(b.createdAt) - ts(a.createdAt)).find((r) => !(r.status === "failed" && r.errorCode === VALIDATION_FAILED));
  if (reached) {
    const detail = (detailOf ? await Promise.resolve(detailOf(reached)).catch(() => null) : null) ?? reached;
    if (stoppedByClassifier(detail)) return "its last run was stopped by the model's safety classifier: that stays your call";
  }
  return null;
}

// A run the model refused (Claude's refusal stop reason, error family model_refusal).
export function stoppedByClassifier(run) {
  const r = run?.resultJson ?? {};
  return r.stopReason === "refusal" || r.errorFamily === "model_refusal" || /refusal/i.test(String(run?.errorCode ?? ""));
}

// What became of an issue's next run after a retry: "past" (it got past setup),
// "again" (refused on relative links again), "other" (refused at setup for another
// reason now), "waiting" (queued, still in setup, or none yet). A run is `running` from
// the moment it is claimed, before the workspace is checked; `adapterStarted` (its
// adapter.invoke event, logged after the workspace is prepared) says it got past that.
export function nextRunOutcome(run, { adapterStarted = false } = {}) {
  if (!run) return { kind: "waiting", text: "no run has started yet" };
  if (ACTIVE_RUN.has(run.status)) {
    if (run.status === "running" && adapterStarted) return { kind: "past", text: "running: past setup" };
    return { kind: "waiting", text: run.status === "running" ? "running, still in setup" : `${run.status}, not started yet` };
  }
  if (run.status === "failed" && run.errorCode === VALIDATION_FAILED) {
    const v = validationOf(run);
    if (v?.reasonCode && v.reasonCode !== RELATIVE_LINKS) return { kind: "other", text: `failed at setup, now for another reason (${codeLabel(v)})` };
    return { kind: "again", text: `failed at setup again (${codeLabel(v) || VALIDATION_FAILED})` };
  }
  return { kind: "past", text: `${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}: past setup` };
}

// The issues' next runs after a retry, polled until each has one that is past setup
// or failed again, or `waitMs` is up. `issues`: [{ issue, known }], where `known` holds
// the ids of the runs the issue had before the retry: any other run is the next one.
export async function awaitNextRuns(api, issues, { waitMs = 60_000, pollMs = 3_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const outcome = new Map();
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const { issue, known = new Set() } of issues) {
      if (outcome.get(issue.id)?.kind && outcome.get(issue.id).kind !== "waiting") continue;
      const runs = await api.request("GET", `/api/issues/${issue.id}/runs`).catch(() => []);
      const next = (Array.isArray(runs) ? runs : [])
        .filter((r) => !known.has(r.runId ?? r.id))
        .sort((a, b) => ts(b.createdAt) - ts(a.createdAt))[0];
      let run = next ?? null;
      const id = run ? run.runId ?? run.id : null;
      if (run?.status === "failed" && run.errorCode === VALIDATION_FAILED && !run.resultJson) {
        run = (await api.request("GET", `/api/heartbeat-runs/${id}`).catch(() => null)) ?? run;
      }
      let adapterStarted = false;
      if (run?.status === "running") {
        const events = await api.request("GET", `/api/heartbeat-runs/${id}/events?limit=1000`).catch(() => []);
        adapterStarted = (Array.isArray(events) ? events : []).some((e) => e.eventType === "adapter.invoke");
      }
      outcome.set(issue.id, nextRunOutcome(run, { adapterStarted }));
    }
    if ([...outcome.values()].every((o) => o.kind !== "waiting") || Date.now() >= deadline) return outcome;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

// The board's note for one checkout (watchdog 20).
export function boardNoteText(group, label = (i) => i.identifier ?? i.id) {
  const where = group.paths.checkout ? `project checkout \`${group.paths.checkout}\`` : `worktrees in \`${group.key}\``;
  return (
    `${plural(group.items.length, "issue")} fail${group.items.length === 1 ? "s" : ""} every run at setup (${VALIDATION_FAILED}, ${RELATIVE_LINKS}): ` +
    `Paperclip can't prove that their worktrees link back to the ${where}: ${group.items.map((x) => label(x.issue)).join(", ")}. ` +
    "Most likely git wrote the links as relative paths (worktree.useRelativePaths, git 2.48 or newer). " +
    "`pch worktrees --links` prints the repair to run on the Paperclip host; after it, `pch worktrees --links --retry` wakes the issues. " +
    "The watchdog doesn't comment on them: before the repair, a comment only fails the same way."
  );
}

// ---------------------------------------------------------------- watchdog 20

// Tells the board, once per project checkout, when issues are parked because their
// worktree links are relative (WATCHDOG_WORKTREE_LINKS). It never comments on the
// issues: the repair has to happen on the host first, and a comment before it only
// fails the same way. The note names `pch worktrees --links`. Once a checkout has no
// issue parked this way, its record goes, so the next time gets a note of its own; a
// scan that couldn't read everything removes nothing, so a failed read doesn't make a
// second note. A record still in use is kept fresh, so a week doesn't expire it.
export function createWorktreeLinksCheck({ ctx, records, state, stats, dryRunSeen, noteToBoard }) {
  const { api, config, log } = ctx;
  const now = () => ctx.now();
  const stallMs = config.watchdogStallSec * 1000;
  const scanAt = new Map();
  const prefix = (companyId) => `worktree-links:${companyId}:`;

  async function check(companyId) {
    const last = scanAt.get(companyId);
    if (last && now() - last < stallMs) return;
    scanAt.set(companyId, now());
    const report = {};
    const parked = await parkedOnValidation(api, companyId, { reasonCode: RELATIVE_LINKS, report });
    const all = parked.length ? await byCheckout(api, parked) : [];
    const groups = all.filter((g) => !g.unknown);
    const complete = !report.incomplete && groups.length === all.length;
    const live = new Set(groups.map((g) => `${prefix(companyId)}${g.key}`));
    for (const [key, value] of records.entries()) {
      if (!key.startsWith(prefix(companyId))) continue;
      if (live.has(key)) {
        records.set(key, { ...value, at: now() });
        state.touch();
      } else if (complete) {
        records.delete(key);
        state.touch();
      }
    }
    for (const group of groups) {
      const key = `${prefix(companyId)}${group.key}`;
      if (records.has(key) || dryRunSeen.has(key)) continue;
      const issues = group.items.map((i) => i.issue.identifier ?? i.issue.id);
      if (config.dryRun) {
        dryRunSeen.add(key);
        log("watchdog: would tell the board about relative worktree links (dry run)", { checkout: group.key, issues });
        continue;
      }
      records.set(key, { count: 1, at: now(), notedAt: now(), issues });
      state.touch();
      stats.worktreeLinkNotes = (stats.worktreeLinkNotes ?? 0) + 1;
      await noteToBoard(ctx, companyId, boardNoteText(group), { checkout: group.key, issues, reasonCode: RELATIVE_LINKS });
    }
  }

  return { check };
}
