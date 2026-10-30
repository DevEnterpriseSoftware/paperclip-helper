import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, setup } from "./helpers.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";
import { closeWorkspace, finishedAt, repoFromUrl, verdict } from "../src/worktrees.mjs";

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();

// One issue and its isolated workspace. `issue` and `ws` override fields.
function add(db, identifier, { issue = {}, ws = {} } = {}) {
  const i = { id: uuid(), identifier, companyId: ids.company, status: "done", completedAt: daysAgo(3), title: identifier, ...issue };
  const w = {
    id: uuid(),
    companyId: ids.company,
    sourceIssueId: i.id,
    mode: "isolated_workspace",
    providerType: "git_worktree",
    status: "idle",
    branchName: `${identifier}-branch`,
    closedAt: null,
    ...ws,
  };
  i.executionWorkspaceId = w.id;
  db.issues.push(i);
  db.executionWorkspaces.push(w);
  return { issue: i, ws: w };
}

function seed(db) {
  return {
    clean: add(db, "ACM-1"),
    cancelled: add(db, "ACM-2", { issue: { status: "cancelled", completedAt: null, cancelledAt: daysAgo(10) } }),
    untracked: add(db, "ACM-3", { ws: { readiness: { git: { hasUntrackedFiles: true, untrackedEntryCount: 4 } } } }),
    dirty: add(db, "ACM-4", { ws: { readiness: { git: { hasDirtyTrackedFiles: true, dirtyEntryCount: 2 } } } }),
    unmerged: add(db, "ACM-5", { ws: { readiness: { git: { aheadCount: 2, isMergedIntoBase: false } } } }),
    open: add(db, "ACM-6", { issue: { status: "in_progress", completedAt: null } }),
    recent: add(db, "ACM-7", { issue: { completedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } }),
    failedBefore: add(db, "ACM-8", {
      ws: { status: "cleanup_failed", closedAt: daysAgo(2), cwd: "/p/.paperclip/worktrees/ACM-8-branch", cleanupReason: "Skipped deleting branch" },
    }),
    archived: add(db, "ACM-9", { ws: { status: "archived", closedAt: daysAgo(5) } }),
    held: add(db, "ACM-10", { issue: { executionRunId: uuid() } }),
    shared: add(db, "ACM-11", { ws: { mode: "shared_workspace" } }),
  };
}

test("verdict: clean closes; uncommitted or unmerged work is left for you; Paperclip's refusals are skipped", () => {
  const ready = { blockingReasons: [], git: { hasDirtyTrackedFiles: false, hasUntrackedFiles: false, aheadCount: 0, isMergedIntoBase: true } };
  assert.equal(verdict(ready).action, "close");
  assert.deepEqual(verdict({ ...ready, git: { hasDirtyTrackedFiles: true, dirtyEntryCount: 1 } }), { action: "review", reasons: ["1 modified tracked file"] });

  const untracked = { ...ready, git: { hasUntrackedFiles: true, untrackedEntryCount: 3 } };
  assert.equal(verdict(untracked).action, "review");
  assert.deepEqual(verdict(untracked, { includeUntracked: true }), { action: "close", reasons: ["3 untracked files"] });

  const ahead = { ...ready, git: { aheadCount: 2, isMergedIntoBase: false, baseRef: "master" } };
  assert.deepEqual(verdict(ahead), { action: "review", reasons: ["2 commits not on master"] });
  assert.equal(verdict(ahead, { includeUnmerged: true }).action, "close");
  // A merged PR counts as delivered, whatever the ancestry says (squash merges).
  assert.equal(verdict({ ...ahead, deliveryState: "merged_via_pr" }).action, "close");
  // Modified tracked files are never closed by a flag.
  assert.equal(verdict({ ...ready, git: { hasDirtyTrackedFiles: true } }, { includeUntracked: true, includeUnmerged: true }).action, "review");

  assert.deepEqual(verdict({ ...ready, blockingReasons: ["This workspace is still linked to an open issue."] }), {
    action: "skip",
    reasons: ["This workspace is still linked to an open issue."],
  });
  assert.equal(verdict({ ...ready, isSharedWorkspace: true }).action, "skip");
  assert.equal(verdict({ ...ready, isProjectPrimaryWorkspace: true }).action, "skip");
  assert.equal(verdict(null).action, "skip");
});

test("finishedAt reads completedAt or cancelledAt, falling back to updatedAt, like Paperclip's reaper", () => {
  assert.equal(finishedAt({ status: "done", completedAt: "2026-10-01T00:00:00Z" }), Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(finishedAt({ status: "cancelled", cancelledAt: null, updatedAt: "2026-10-02T00:00:00Z" }), Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(finishedAt({ status: "in_progress", updatedAt: "2026-10-02T00:00:00Z" }), null);
});

test("worktrees previews: what Paperclip can close, what would lose work, what it refuses; nothing changes", async () => {
  const h = await setup();
  try {
    seed(h.db);
    const lines = await captureOutput(() => cmd.worktrees(h.ctx));
    const text = lines.join("\n");
    assert.match(text, /ACM: 10 open workspaces, 6 of them worktrees of issues finished 1\+ days ago/);
    assert.match(text, /Paperclip can close 2 and remove their worktrees:/);
    for (const id of ["ACM-1", "ACM-2"]) assert.match(text, new RegExp(`\\n    ${id} `));
    assert.match(text, /1 were closed before, but their clean-up failed[^]*\n    ACM-8 +\/p\/\.paperclip\/worktrees\/ACM-8-branch\n +Skipped deleting branch/);
    assert.match(text, /3 may hold work that isn't on GitHub/);
    assert.match(text, /ACM-3 .*4 untracked files/);
    assert.match(text, /ACM-4 .*2 modified tracked files/);
    assert.match(text, /ACM-5 .*2 commits not on master/);
    assert.match(text, /Paperclip won't close 1:\n    ACM-10 .*run [0-9a-f]{8} still holds the issue \(Paperclip didn't say what state it is in\)/);
    assert.match(text, /Left alone: 1 of open issues \(1 in_progress\), 1 of issues finished in the last day, 1 sessions on the project's shared checkout \(nothing to free\)\./);
    assert.match(text, /--verbose lists each of them, and why\./);
    assert.match(text, /Without GITHUB_TOKEN or GITHUB_TOKEN_FILE, a squash-merged branch looks unmerged/);
    assert.match(text, /pch worktrees --apply/);
    assert.doesNotMatch(text, /ACM-9/, "an archived workspace isn't listed");
    assert.deepEqual(h.db.workspaceCloses, []);
  } finally {
    await h.close();
  }
});

test("worktrees --apply closes the clean ones and shows why a clean-up failed", async () => {
  const h = await setup();
  try {
    const s = seed(h.db);
    s.cancelled.ws.closeFails = "'/x/.paperclip/worktrees/ACM-2' contains modified or untracked files, use --force to delete it";
    const lines = await captureOutput(() => cmd.worktrees(h.ctx, { apply: true }));
    process.exitCode = 0;
    const text = lines.join("\n");
    assert.deepEqual(new Set(h.db.workspaceCloses), new Set([s.clean.ws.id, s.cancelled.ws.id]));
    assert.equal(s.clean.ws.status, "archived");
    assert.equal(s.failedBefore.ws.status, "cleanup_failed", "Paperclip can't close a closed workspace again");
    assert.match(text, /ACM-1: closed/);
    assert.match(text, /ACM-2: cleanup_failed: .*contains modified or untracked files/);
    assert.match(text, /\| worktree_cleanup failed \(exit 128\)/);
    assert.match(text, /Closed 1 workspace\. 1 didn't close cleanly/);
    // The ones that would lose work, and open issues', are untouched.
    for (const k of ["untracked", "dirty", "unmerged", "open", "recent", "held"]) assert.notEqual(s[k].ws.status, "archived", k);
  } finally {
    await h.close();
  }
});

test("worktrees --include-untracked --include-unmerged --min-days=0 widen what is closed, never modified files", async () => {
  const h = await setup();
  try {
    const s = seed(h.db);
    await captureOutput(() => cmd.worktrees(h.ctx, { apply: true, includeUntracked: true, includeUnmerged: true, minDays: 0 }));
    for (const k of ["clean", "cancelled", "untracked", "unmerged", "recent"]) assert.equal(s[k].ws.status, "archived", k);
    for (const k of ["dirty", "open", "held", "failedBefore", "shared"]) assert.notEqual(s[k].ws.status, "archived", k);
  } finally {
    await h.close();
  }
});

test("worktrees leaves a workspace another open issue still uses, and rejects unknown options", async () => {
  const h = await setup();
  try {
    const { ws } = add(h.db, "ACM-1");
    h.db.issues.push({ id: uuid(), identifier: "ACM-2", companyId: ids.company, status: "todo", executionWorkspaceId: ws.id });
    const lines = await captureOutput(() => cmd.worktrees(h.ctx, { apply: true }));
    assert.match(lines.join("\n"), /won't close 1:\n    ACM-1 .*still linked to open issue ACM-2 \(todo\)/);
    assert.match(lines.join("\n"), /Nothing to close\./);
    assert.deepEqual(h.db.workspaceCloses, []);
    await assert.rejects(cmd.worktrees(h.ctx, { minDays: -1 }), /--min-days must be/);
  } finally {
    await h.close();
  }
});

test("repoFromUrl reads owner/repo from https and ssh remotes", () => {
  assert.equal(repoFromUrl("https://github.com/Org/App.git"), "org/app");
  assert.equal(repoFromUrl("git@github.com:org/app.git"), "org/app");
  assert.equal(repoFromUrl("https://github.com/org/app/"), "org/app");
  assert.equal(repoFromUrl("/home/me/app"), null);
  assert.equal(repoFromUrl(null), null);
});

test("verdict: commits off the base branch but in a merged PR are delivered (squash merge); more than the PR had are not", () => {
  const r = { blockingReasons: [], git: { aheadCount: 3, isMergedIntoBase: false, baseRef: "origin/master" } };
  assert.deepEqual(verdict(r, {}, { number: 41, commits: 3 }), { action: "close", reasons: ["PR #41 merged"] });
  assert.deepEqual(verdict(r, {}, { number: 41, commits: 2 }), {
    action: "review",
    reasons: ["3 commits not on origin/master (PR #41 was merged with 2 commits)"],
  });
  assert.equal(verdict(r, {}, null).action, "review");
});

test("worktrees asks GitHub about unmerged branches: a merged PR closes, an unmerged or bigger one is left", async () => {
  const gh = await startFakeGitHub();
  const h = await setup({ env: { GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, GITHUB_REPOS: "org/app" } });
  try {
    const ahead = (n) => ({ readiness: { git: { aheadCount: n, isMergedIntoBase: false } } });
    const squashed = add(h.db, "ACM-21", { ws: ahead(2) });
    const extra = add(h.db, "ACM-22", { ws: { ...ahead(5), repoUrl: "https://github.com/org/app.git" } });
    const noPr = add(h.db, "ACM-23", { ws: ahead(1) });
    const openPr = add(h.db, "ACM-24", { ws: ahead(1) });
    gh.pulls["org/app"] = [
      pull(7, { state: "closed", merged_at: daysAgo(4), commits: 2, head: { ref: "ACM-21-branch", sha: "a" } }),
      pull(8, { state: "closed", merged_at: daysAgo(4), commits: 3, head: { ref: "ACM-22-branch", sha: "b" } }),
      pull(9, { state: "open", commits: 1, head: { ref: "ACM-24-branch", sha: "c" } }),
      // Closed without merging: not delivered.
      pull(10, { state: "closed", merged_at: null, commits: 1, head: { ref: "ACM-23-branch", sha: "d" } }),
    ];
    const lines = await captureOutput(() => cmd.worktrees(h.ctx, { apply: true }));
    process.exitCode = 0;
    const text = lines.join("\n");
    assert.match(text, /ACM-21 .*\(PR #7 merged\)/);
    assert.match(text, /ACM-22 .*5 commits not on master \(PR #8 was merged with 3 commits\)/);
    assert.match(text, /ACM-23 .*1 commit not on master  ACM-23/);
    assert.equal(squashed.ws.status, "archived");
    for (const x of [extra, noPr, openPr]) assert.notEqual(x.ws.status, "archived", x.issue.identifier);
    assert.doesNotMatch(text, /Without GITHUB_TOKEN/);
    assert.ok(gh.requests.some((r) => r.path.startsWith("/repos/org/app/pulls?state=closed&head=org%3AACM-21-branch")));
  } finally {
    await h.close();
    await gh.close();
  }
});

test("closeWorkspace: a workspace closed meanwhile is reported as already closed; any other 404 is an error", async () => {
  const notFound = Object.assign(new Error("PATCH … → 404: Execution workspace not found"), { status: 404 });
  const api = (current) => ({
    request: async (method) => {
      if (method === "PATCH") throw notFound;
      if (current === null) throw notFound;
      return current;
    },
  });
  assert.deepEqual(await closeWorkspace(api({ status: "archived", cleanupReason: null }), { id: "w" }), {
    ok: true,
    alreadyClosed: true,
    status: "archived",
    cleanupReason: null,
  });
  assert.equal((await closeWorkspace(api({ status: "cleanup_failed", cleanupReason: "x" }), { id: "w" })).alreadyClosed, true);
  await assert.rejects(closeWorkspace(api({ status: "idle" }), { id: "w" }), /404/);
  await assert.rejects(closeWorkspace(api(null), { id: "w" }), /404/);
});

test("verdict names the open issues a workspace is still linked to, keeps every blocking reason, and says when the folder is gone", () => {
  const ready = { blockingReasons: [], warnings: [], git: {} };
  const linked = {
    ...ready,
    blockingReasons: ["This workspace is still linked to 2 open issues.", "Paperclip could not verify the workspace git status. Retry before destructive cleanup."],
    linkedIssues: [
      { id: "a", identifier: "ACM-1", status: "cancelled" },
      { id: "b", identifier: "ACM-2", status: "in_progress" },
      { id: "c", identifier: "ACM-3", status: "blocked" },
    ],
  };
  assert.deepEqual(verdict(linked), {
    action: "skip",
    reasons: ["still linked to open issues ACM-2 (in_progress), ACM-3 (blocked)", "Paperclip could not verify the workspace git status. Retry before destructive cleanup."],
  });
  // Without linkedIssues (an older Paperclip), Paperclip's own words stay.
  assert.deepEqual(verdict({ ...ready, blockingReasons: ["This workspace is still linked to an open issue."] }).reasons, ["This workspace is still linked to an open issue."]);
  const gone = { ...ready, warnings: ['Workspace path "/x" does not exist, so Paperclip cannot inspect git status before close.'] };
  assert.deepEqual(verdict(gone), { action: "close", reasons: ["its folder is already gone"] });
});

test("worktrees says which run holds a finished issue and whether it has ended, and shows the folder of each it won't close", async () => {
  const h = await setup();
  try {
    const ended = uuid();
    const live = uuid();
    h.db.heartbeatRuns.push({ id: ended, companyId: ids.company, status: "cancelled", finishedAt: daysAgo(2) });
    h.db.heartbeatRuns.push({ id: live, companyId: ids.company, status: "running", finishedAt: null });
    add(h.db, "ACM-1", { issue: { status: "cancelled", cancelledAt: daysAgo(4), executionRunId: ended }, ws: { cwd: "/p/.paperclip/worktrees/ACM-1-branch" } });
    add(h.db, "ACM-2", { issue: { checkoutRunId: live }, ws: { cwd: "/p/.paperclip/worktrees/ACM-2-branch" } });
    add(h.db, "ACM-3", { ws: { cwd: "/p/.paperclip/worktrees/ACM-3-branch", readiness: { git: { hasDirtyTrackedFiles: true, dirtyEntryCount: 1 } } } });
    const text = (await captureOutput(() => cmd.worktrees(h.ctx))).join("\n");
    assert.match(text, new RegExp(`ACM-1 .*run ${ended.slice(0, 8)} still holds the issue although it ended \\(cancelled 2d ago\\): see pch why ACM-1  ACM-1-branch\\n +/p/\\.paperclip/worktrees/ACM-1-branch`));
    assert.match(text, new RegExp(`ACM-2 .*run ${live.slice(0, 8)} still holds the issue \\(running\\)`));
    assert.match(text, /ACM-3 .*1 modified tracked file  ACM-3-branch\n +\/p\/\.paperclip\/worktrees\/ACM-3-branch/);
    assert.match(text, /git -C <folder> status --short lists the uncommitted files/);
    assert.deepEqual(h.db.workspaceCloses, []);
  } finally {
    await h.close();
  }
});

test("worktrees --verbose lists each workspace it left alone, with why and its folder", async () => {
  const h = await setup();
  try {
    add(h.db, "ACM-1", { issue: { status: "blocked", completedAt: null }, ws: { cwd: "/p/wt/ACM-1" } });
    add(h.db, "ACM-2", { issue: { status: "in_review", completedAt: null } });
    add(h.db, "ACM-3", { issue: { completedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString() } });
    h.db.executionWorkspaces.push({ id: uuid(), companyId: ids.company, sourceIssueId: null, mode: "isolated_workspace", status: "idle", branchName: "loose-branch", closedAt: null });
    h.db.executionWorkspaces.push({ id: uuid(), companyId: ids.company, sourceIssueId: uuid(), mode: "isolated_workspace", status: "idle", branchName: "orphan-branch", closedAt: null });
    const quiet = (await captureOutput(() => cmd.worktrees(h.ctx))).join("\n");
    assert.match(quiet, /Left alone: 3 of open issues \(1 blocked, 1 in_review, 1 not found\), 1 of issues finished in the last day, 1 with no source issue\./);
    assert.doesNotMatch(quiet, /issue is blocked/);
    const text = (await captureOutput(() => cmd.worktrees(h.ctx, { verbose: true }))).join("\n");
    assert.match(text, /ACM-1 +issue is blocked  ACM-1-branch\n +\/p\/wt\/ACM-1/);
    assert.match(text, /ACM-2 +issue is in_review  ACM-2-branch/);
    assert.match(text, /ACM-3 +finished 5h ago  ACM-3-branch/);
    assert.match(text, /- +no source issue  loose-branch/);
    assert.match(text, /[0-9a-f]{8} +its issue isn't listed \(deleted, or not visible to you\)  orphan-branch/);
    assert.doesNotMatch(text, /--verbose lists each/);
    await assert.rejects(cmd.worktrees(h.ctx, { links: true, verbose: true, given: new Set(["verbose"]) }), /--links takes only --retry/);
  } finally {
    await h.close();
  }
});
