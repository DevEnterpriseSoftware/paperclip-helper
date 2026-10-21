// `pch worktrees`: the execution workspaces of finished issues that are still on
// disk, and closing them so Paperclip removes their git worktrees.
//
// Paperclip removes a workspace's worktree when the workspace is closed
// (archived). Its terminal-workspace reaper closes them by itself, but only once
// the issue's whole tree is done or cancelled, the worktree is clean, Paperclip
// can prove the branch was delivered (a merged PR it can read, or the commits on
// the base branch), and the issue has been finished for
// PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS (7 by default). Squash merges, PRs
// Paperclip can't read and untracked build output all keep a worktree, so they
// pile up: hundreds of them, hundreds of MB each.
//
// This closes them the way the workspace's Close button does
// (PATCH /api/execution-workspaces/:id { status: "archived" }): Paperclip checks
// the workspace can be closed, stops its runtime services, runs the project's
// clean-up commands, removes the worktree and deletes the branch it created
// when that branch is merged. The helper never touches the disk itself.
// Paperclip reports what stands in the way first (GET …/close-readiness): an
// open issue still linked, uncommitted changes, commits not on the base branch.
// Those are left for you unless you ask for them.

import { listIssues } from "./paperclip.mjs";
import { mapLimit } from "./util.mjs";

const TERMINAL = new Set(["done", "cancelled"]);

// Workspaces that may still hold a worktree. cleanup_failed is a closed one
// whose clean-up didn't finish: closing it again retries the clean-up.
export const OPEN_WORKSPACE_STATUSES = "active,idle,in_review,cleanup_failed";

const DAY_MS = 24 * 60 * 60 * 1000;

// When the issue finished, as Paperclip's reaper reads it (issueTerminalTimestamp).
export function finishedAt(issue) {
  const at = issue.status === "done" ? issue.completedAt ?? issue.updatedAt : issue.status === "cancelled" ? issue.cancelledAt ?? issue.updatedAt : null;
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : null;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What to do with one finished issue's workspace, from Paperclip's close-readiness.
// Returns { action: "close" | "review" | "skip", reasons: [...] }:
//   close   nothing stands in the way (or only what the flags allow)
//   review  closing would throw away work: uncommitted changes, unmerged commits
//   skip    Paperclip won't close it, or closing it frees nothing
export function verdict(readiness, { includeUntracked = false, includeUnmerged = false } = {}) {
  if (!readiness) return { action: "skip", reasons: ["Paperclip couldn't say whether it can be closed"] };
  if (readiness.isSharedWorkspace) return { action: "skip", reasons: ["it is the project's shared checkout, not a worktree"] };
  if (readiness.isProjectPrimaryWorkspace) return { action: "skip", reasons: ["it is the project's main checkout"] };
  const blocking = Array.isArray(readiness.blockingReasons) ? readiness.blockingReasons : [];
  if (blocking.length) return { action: "skip", reasons: blocking };

  const git = readiness.git ?? {};
  const reasons = [];
  let held = false;
  if (git.hasDirtyTrackedFiles) {
    held = true;
    reasons.push(`${plural(git.dirtyEntryCount ?? 0, "modified tracked file")}`);
  }
  if (git.hasUntrackedFiles) {
    if (!includeUntracked) held = true;
    reasons.push(`${plural(git.untrackedEntryCount ?? 0, "untracked file")}`);
  }
  const unmerged = (git.aheadCount ?? 0) > 0 && git.isMergedIntoBase === false && readiness.deliveryState !== "merged_via_pr";
  if (unmerged) {
    if (!includeUnmerged) held = true;
    reasons.push(`${plural(git.aheadCount, "commit")} not on ${git.baseRef ?? "the base branch"}`);
  }
  return { action: held ? "review" : "close", reasons };
}

// Every open workspace in the company whose source issue is done or cancelled,
// with what Paperclip says about closing it. Workspaces of open issues, and of
// issues finished less than minDays ago, are only counted.
export async function survey(api, companyId, { now, minDays = 1, concurrency = 4, flags = {} } = {}) {
  const rows = await api.request("GET", `/api/companies/${companyId}/execution-workspaces?status=${OPEN_WORKSPACE_STATUSES}`);
  const workspaces = (Array.isArray(rows) ? rows : []).filter((w) => w.status !== "archived");
  const counts = { workspaces: workspaces.length, open: 0, recent: 0, noIssue: 0 };
  if (!workspaces.length) return { counts, results: [] };

  const finished = await listIssues(api, companyId, "done,cancelled");
  const issuesById = new Map(finished.map((i) => [i.id, i]));
  const candidates = [];
  for (const ws of workspaces) {
    if (!ws.sourceIssueId) {
      counts.noIssue += 1;
      continue;
    }
    const issue = issuesById.get(ws.sourceIssueId);
    if (!issue || !TERMINAL.has(issue.status)) {
      counts.open += 1;
      continue;
    }
    const at = finishedAt(issue);
    const days = at === null ? null : (now - at) / DAY_MS;
    if (days !== null && days < minDays) {
      counts.recent += 1;
      continue;
    }
    candidates.push({ ws, issue, days });
  }

  const results = await mapLimit(candidates, concurrency, async (c) => {
    if (c.issue.executionRunId || c.issue.checkoutRunId) return { ...c, action: "skip", reasons: ["a run still holds the issue"] };
    let readiness;
    try {
      readiness = await api.request("GET", `/api/execution-workspaces/${c.ws.id}/close-readiness`, undefined, { timeoutMs: 60_000 });
    } catch (err) {
      return { ...c, action: "skip", reasons: [`couldn't read close-readiness: ${err.message}`] };
    }
    return { ...c, readiness, ...verdict(readiness, flags) };
  });
  return { counts, results };
}

// Closes one workspace, as its Close button does. Paperclip removes the worktree
// before it answers, so this can take a while for a big one.
export async function closeWorkspace(api, ws) {
  const after = await api.request("PATCH", `/api/execution-workspaces/${ws.id}`, { status: "archived" }, { timeoutMs: 300_000 });
  return {
    ok: after?.status === "archived",
    status: after?.status ?? "?",
    cleanupReason: after?.cleanupReason ?? null,
  };
}

// The last lines a failed workspace operation printed (its clean-up), for a close
// that didn't finish. Empty when there is none or it can't be read.
export async function lastFailedOperation(api, workspaceId, maxLines = 6) {
  const ops = await api.request("GET", `/api/execution-workspaces/${workspaceId}/workspace-operations`).catch(() => []);
  const failed = (Array.isArray(ops) ? ops : [])
    .filter((op) => op.status === "failed")
    .sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0))
    .at(-1);
  if (!failed) return [];
  const text = [failed.stderrExcerpt, failed.stdoutExcerpt].filter(Boolean).join("\n");
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  return [`${failed.phase ?? "operation"} failed${failed.exitCode != null ? ` (exit ${failed.exitCode})` : ""}`, ...lines.slice(-maxLines)];
}
