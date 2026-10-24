// An issue's link to another issue's execution workspace, and the board's fix.
//
// An issue whose execution workspace preference is `reuse_existing` names a
// workspace by id (`executionWorkspaceId`), and every run on it asks Paperclip
// to restore that one workspace. Issues an agent creates from another issue's
// work inherit that issue's link. Two things then go wrong:
//
// - The workspace is closed (`archived`) or gone. Paperclip refuses every run
//   before the agent starts: setup_failed, "Issue X requested inherited
//   execution workspace reuse for <id>, but the workspace could not be
//   restored". Retries and comments fail the same way.
// - The workspace is alive but belongs to another issue (its branch). The
//   agent's commits would land on that issue's branch, and an agent that
//   notices blocks the issue and asks for a "workspace ruling".
//
// The fix in both cases is what the issue's Workspace picker does with "New
// isolated workspace": clear the link, so the next run gets a fresh worktree.
// `pch workspace`, `pch why` and the watchdog share this module.

import { ACTIVE_RUN } from "./util.mjs";

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The run error Paperclip records when the linked workspace can't be restored
// (formatInheritedExecutionWorkspaceReuseFailure, server/src/services/heartbeat/workspaces.ts).
export const DEAD_LINK_ERROR = new RegExp(
  `requested inherited execution workspace reuse for (${UUID_RE}), but the workspace could not be restored`,
  "i",
);

const OPEN = (status) => status !== "done" && status !== "cancelled";

// The change "New isolated workspace" in the issue's Workspace picker makes
// (buildWorkspaceSelectionUpdate, ui/src/lib/issue-workspace-selection.ts),
// except that the issue's other workspace settings are kept: Paperclip replaces
// executionWorkspaceSettings whole on update, so sending only the mode would
// drop a pinned branch, the environment, network egress or runtime settings.
export function isolatedSelection(issue) {
  const current = issue?.executionWorkspaceSettings;
  const kept = current && typeof current === "object" ? { ...current } : {};
  return {
    executionWorkspaceId: null,
    executionWorkspacePreference: "isolated_workspace",
    executionWorkspaceSettings: { ...kept, mode: "isolated_workspace", environmentId: kept.environmentId ?? null },
  };
}

// The workspace id a setup_failed run couldn't restore, from its error text.
export function deadLinkWorkspaceId(errorText) {
  const m = DEAD_LINK_ERROR.exec(String(errorText ?? ""));
  return m ? m[1].toLowerCase() : null;
}

// What the issue's workspace link is:
//   none     no reuse_existing link: each run gets the workspace the project's policy says
//   dead     linked to a workspace that is archived or no longer exists: every run fails at setup
//   foreign  linked to a live workspace another issue owns: runs work on that issue's branch
//   own      linked to its own live workspace: nothing wrong
//   unknown  linked, but whether the workspace is alive couldn't be told
export function classifyLink(issue, workspace, { missing = false } = {}) {
  const id = issue?.executionWorkspaceId ?? null;
  if (!id || issue.executionWorkspacePreference !== "reuse_existing") return "none";
  if (missing || workspace?.status === "archived") return "dead";
  if (!workspace) return "unknown";
  if (workspace.sourceIssueId && workspace.sourceIssueId !== issue.id) return "foreign";
  return "own";
}

// The issue's workspace as Paperclip resolves it for runs. `GET /api/issues/:id`
// carries it as currentExecutionWorkspace, read without a privacy check, and
// null when the row is gone: that is what heartbeat sees. The workspace's own
// endpoint answers 404 both for a missing workspace and for one the key may not
// read (issue privacy), so a 404 there proves nothing. Returns
// { workspace, missing, known }; known is false when the issue doesn't carry
// the field (an older Paperclip) and the workspace couldn't be read either.
export async function linkedWorkspace(api, issue) {
  const wsId = issue.executionWorkspaceId;
  if (Object.hasOwn(issue, "currentExecutionWorkspace")) {
    const inline = issue.currentExecutionWorkspace;
    if (inline === null) return { workspace: null, missing: true, known: true };
    if (inline?.id === wsId && inline.status) return { workspace: inline, missing: false, known: true };
  }
  try {
    return { workspace: await api.request("GET", `/api/execution-workspaces/${wsId}`), missing: false, known: true };
  } catch (err) {
    return { workspace: null, missing: false, known: false, readError: err.status === 404 ? "not found, or not readable with this key" : err.message };
  }
}

// Everything `pch workspace` and `pch why` need about one issue's link.
// `issue` may be passed when the caller already read it.
export async function linkFacts(api, issueRef, { issue = null } = {}) {
  const current = issue ?? (await api.request("GET", `/api/issues/${encodeURIComponent(issueRef)}`));
  const wsId = current?.executionWorkspaceId ?? null;
  let found = { workspace: null, missing: false, known: true };
  if (wsId && current.executionWorkspacePreference === "reuse_existing") found = await linkedWorkspace(api, current);
  const { workspace, missing, readError = null } = found;
  const state = classifyLink(current, workspace, { missing });
  let owner = null;
  if (workspace?.sourceIssueId && workspace.sourceIssueId !== current.id) {
    const o = await api.request("GET", `/api/issues/${workspace.sourceIssueId}`).catch(() => null);
    owner = o ? { id: o.id, identifier: o.identifier ?? null, status: o.status ?? null } : { id: workspace.sourceIssueId, identifier: null, status: null };
  }
  const ownClosed = state === "dead" && workspace?.sourceIssueId === current.id;
  return { issue: current, workspaceId: wsId, workspace, missing, readError, state, owner, ownClosed };
}

// One line describing the link, for `why` and `workspace`.
export function describeLink(facts) {
  const { state, workspaceId, workspace, owner } = facts;
  if (state === "none") return null;
  const short = String(workspaceId).slice(0, 8);
  const whose = owner ? `${owner.identifier ?? owner.id.slice(0, 8)}'s workspace` : facts.ownClosed ? "its own workspace" : "workspace";
  const branch = workspace?.branchName ? `, branch ${workspace.branchName}` : "";
  if (state === "dead") {
    return facts.missing
      ? `reuses workspace ${short}, which no longer exists: every run fails at setup`
      : `reuses ${whose} ${short} (archived${workspace?.closedAt ? ` ${workspace.closedAt}` : ""}${branch}): every run fails at setup`;
  }
  if (state === "foreign") return `reuses ${whose} ${short} (${workspace.status}${branch}): its commits land on that issue's branch`;
  if (state === "unknown") return `reuses workspace ${short} (couldn't read it${facts.readError ? `: ${facts.readError}` : ""})`;
  return `its own workspace ${short} (${workspace?.status ?? "?"}${branch})`;
}

// Other open issues still linked to the same workspace: when it's dead, they
// fail the same way. Paperclip's issue list filters by executionWorkspaceId;
// the rows are checked again here in case an older Paperclip ignores the filter.
export async function issuesLinkedTo(api, companyId, workspaceId, { exceptId = null } = {}) {
  if (!companyId || !workspaceId) return [];
  const rows = await api
    .request("GET", `/api/companies/${companyId}/issues?executionWorkspaceId=${encodeURIComponent(workspaceId)}&limit=1000`)
    .catch(() => []);
  return (Array.isArray(rows) ? rows : []).filter(
    (i) => i.id !== exceptId && i.executionWorkspaceId === workspaceId && i.executionWorkspacePreference === "reuse_existing" && OPEN(i.status),
  );
}

// Why this issue's link shouldn't be changed right now; empty when it can.
// `issue` is the issue as read (a list row or GET /api/issues/:id).
export function clearProblems(facts, runs = [], issue = facts.issue) {
  const problems = [];
  if (facts.state === "none") problems.push("it has no workspace link to clear");
  if (facts.state === "own") problems.push("it is linked to its own live workspace, which is what it should use");
  if (facts.state === "unknown") problems.push("its linked workspace couldn't be read");
  if (!OPEN(issue.status)) problems.push(`it is ${issue.status}`);
  if (issue.executionRunId || issue.checkoutRunId) problems.push("a run holds it");
  const active = runs.find((r) => ACTIVE_RUN.has(r.status));
  if (active) problems.push(`a run is ${active.status} on it`);
  // A change already scheduled for the next run fixes the link by itself, and
  // a new change would cancel it.
  if (issue.workspacePendingSelection) problems.push("a workspace change is already scheduled for its next run");
  return problems;
}

// Whether Paperclip accepts workspace changes on issues at all. With the
// instance's experimental "Enable Isolated Workspaces" off, an issue update
// silently drops executionWorkspaceId, executionWorkspacePreference and
// executionWorkspaceSettings (services/issues.ts update), and the issue's
// Workspace picker is hidden. Inheritance on create isn't gated, so issues still
// get links they can't be rid of. null: couldn't tell (older Paperclip, no access).
export async function isolatedWorkspacesEnabled(api) {
  const s = await api.request("GET", "/api/instance/settings/experimental").catch(() => null);
  return typeof s?.enableIsolatedWorkspaces === "boolean" ? s.enableIsolatedWorkspaces : null;
}

export const ENABLE_SETTING_HINT =
  'Paperclip ignores workspace changes on issues while Instance settings → Experimental → "Enable Isolated Workspaces" is off. ' +
  "Turn it on (it also shows the Workspace picker on issues), then run this again.";

// Clears the link, then reads the issue back: Paperclip drops the change
// without an error when isolated workspaces are off, and that has to show.
// `issue` is the full issue (GET /api/issues/:id), for its current settings.
export async function clearLink(api, issue) {
  const id = encodeURIComponent(issue.id ?? issue.identifier);
  await api.request("PATCH", `/api/issues/${id}`, isolatedSelection(issue));
  const after = await api.request("GET", `/api/issues/${id}`);
  const ok = !after.executionWorkspaceId || after.executionWorkspacePreference !== "reuse_existing";
  return { ok, issue: after };
}
