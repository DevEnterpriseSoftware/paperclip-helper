import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";
import { advise } from "../src/advice.mjs";
import { classifyLink, deadLinkWorkspaceId, isolatedSelection } from "../src/workspace.mjs";

// What the Workspace picker's "New isolated workspace" sends, for an issue whose settings are just the mode.
const ISOLATED = {
  executionWorkspaceId: null,
  executionWorkspacePreference: "isolated_workspace",
  executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: null },
};

// DIR-318's workspace, closed after DIR-318 finished; DIR-415 and DIR-416 were
// created from its work and still point at it.
function seed(db, { wsStatus = "archived", ownerStatus = "done" } = {}) {
  const agent = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle" };
  const carla = { id: uuid(), companyId: ids.company, name: "Carla", status: "idle" };
  db.agents.push(agent, carla);
  const owner = { id: uuid(), identifier: "ACM-318", companyId: ids.company, status: ownerStatus, title: "Recovery" };
  const ws = {
    id: uuid(),
    companyId: ids.company,
    sourceIssueId: owner.id,
    mode: "isolated_workspace",
    status: wsStatus,
    branchName: "ACM-318-recovery",
    closedAt: wsStatus === "archived" ? minutesAgo(180) : null,
  };
  db.executionWorkspaces.push(ws);
  owner.executionWorkspaceId = ws.id;
  const linked = (identifier, status, assigneeAgentId = agent.id) => ({
    id: uuid(),
    identifier,
    companyId: ids.company,
    status,
    assigneeAgentId,
    title: `Work for ${identifier}`,
    executionWorkspaceId: ws.id,
    executionWorkspacePreference: "reuse_existing",
    executionWorkspaceSettings: { mode: "isolated_workspace" },
  });
  const a = linked("ACM-415", "in_review");
  const b = linked("ACM-416", "blocked");
  const done = linked("ACM-417", "done");
  db.issues.push(owner, a, b, done);
  return { agent, carla, owner, ws, a, b, done };
}

const setupFailed = (agentId, wsId, identifier) => ({
  runId: uuid(),
  agentId,
  status: "failed",
  errorCode: "setup_failed",
  createdAt: minutesAgo(5),
  finishedAt: minutesAgo(5),
  error:
    `Issue ${identifier} requested inherited execution workspace reuse for ${wsId}, but the workspace could not be restored. ` +
    "Repair or unarchive the referenced execution workspace, or intentionally clear the issue's reuse_existing workspace binding before retrying.",
});

test("the dead-link error is recognised, with and without a cause", () => {
  const id = "0b4a273f-270a-4cfe-8ec4-c4313d91194e";
  assert.equal(deadLinkWorkspaceId(setupFailed("x", id, "DIR-415").error), id);
  assert.equal(
    deadLinkWorkspaceId(`Issue DIR-1 requested inherited execution workspace reuse for ${id.toUpperCase()}, but the workspace could not be restored because ENOENT.`),
    id,
  );
  assert.equal(deadLinkWorkspaceId("Workspace validation failed"), null);
  assert.equal(deadLinkWorkspaceId(null), null);
});

test("links are classified: none, dead, foreign, own", () => {
  const issue = { id: "i1", executionWorkspaceId: "w1", executionWorkspacePreference: "reuse_existing" };
  assert.equal(classifyLink({ ...issue, executionWorkspacePreference: "isolated_workspace" }, null), "none");
  assert.equal(classifyLink({ id: "i1" }, null), "none");
  assert.equal(classifyLink(issue, { status: "archived", sourceIssueId: "i1" }), "dead");
  assert.equal(classifyLink(issue, null, { missing: true }), "dead");
  assert.equal(classifyLink(issue, { status: "active", sourceIssueId: "i2" }), "foreign");
  assert.equal(classifyLink(issue, { status: "active", sourceIssueId: "i1" }), "own");
  assert.equal(classifyLink(issue, null), "unknown");
});

test("workspace previews a dead link and the other open issues on it, and changes nothing", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, ws } = seed(env.db);
  const text = (await captureOutput(() => cmd.workspace(env.ctx, "acm-415"))).join("\n");
  assert.match(text, /^ACM-415: in_review/);
  assert.match(text, new RegExp(`Workspace: reuses ACM-318's workspace ${ws.id.slice(0, 8)} \\(archived .*branch ACM-318-recovery\\): every run fails at setup`));
  assert.match(text, /Also linked to it: ACM-416 \(blocked\)/);
  assert.doesNotMatch(text, /ACM-417/, "a done issue is left out");
  assert.match(text, /--apply gives these 2 issues a new isolated workspace/);
  assert.match(text, /pch workspace acm-415 --apply/);
  assert.equal(env.db.patches.length, 0);
  assert.equal(a.executionWorkspaceId, ws.id);
});

test("workspace --apply clears the dead link on every open issue linked to it", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, b, done, ws } = seed(env.db);
  const text = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-415", ["--apply"]))).join("\n");
  assert.deepEqual(env.db.patches.map((p) => p.identifier).sort(), ["ACM-415", "ACM-416"]);
  for (const p of env.db.patches) assert.deepEqual(p.body, ISOLATED, "the same change as the Workspace picker");
  for (const i of [a, b]) {
    assert.equal(i.executionWorkspaceId, null);
    assert.equal(i.executionWorkspacePreference, "isolated_workspace");
  }
  assert.equal(done.executionWorkspaceId, ws.id, "a done issue is not touched");
  assert.equal(a.status, "in_review", "the status is not changed");
  assert.equal(env.db.comments.length, 0, "nothing is posted");
  assert.match(text, /ACM-415: linked to no other workspace now/);
  assert.match(text, /ACM-416: linked to no other workspace now/);
  assert.match(text, /pch comment ACM-415 "Gilfoyle, the workspace is fixed/);
});

test("workspace --apply leaves a linked issue with a run in progress alone", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { agent, b, ws } = seed(env.db);
  env.db.issueRuns[b.id] = [{ runId: uuid(), agentId: agent.id, status: "queued", createdAt: minutesAgo(1) }];
  const text = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-415", ["--apply"]))).join("\n");
  assert.match(text, /ACM-416: left alone \(a run is queued on it\)/);
  assert.deepEqual(env.db.patches.map((p) => p.identifier), ["ACM-415"]);
  assert.equal(b.executionWorkspaceId, ws.id);
});

test("workspace refuses: its own live workspace, a run in progress, a done issue", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { agent, a, b, done, ws } = seed(env.db);

  const own = { ...a, id: uuid(), identifier: "ACM-500" };
  const ownWs = { id: uuid(), companyId: ids.company, sourceIssueId: own.id, status: "active", branchName: "own" };
  own.executionWorkspaceId = ownWs.id;
  env.db.executionWorkspaces.push(ownWs);
  env.db.issues.push(own);
  const text = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-500", ["--apply"]))).join("\n");
  assert.match(text, /its own workspace .* \(active, branch own\)[\s\S]*Nothing to clear/);

  env.db.issueRuns[b.id] = [{ runId: uuid(), agentId: agent.id, status: "running", createdAt: minutesAgo(1) }];
  await assert.rejects(cmd.workspace(env.ctx, "ACM-416", ["--apply"]), /Not changing ACM-416: a run is running on it/);
  await assert.rejects(cmd.workspace(env.ctx, "ACM-417", ["--apply"]), /Not changing ACM-417: it is done/);
  assert.equal(env.db.patches.length, 0);
  assert.equal(done.executionWorkspaceId, ws.id);
});

test("workspace says so when Paperclip ignores workspace changes", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, ws } = seed(env.db);

  env.db.experimental = { enableIsolatedWorkspaces: false };
  await assert.rejects(cmd.workspace(env.ctx, "ACM-415", ["--apply"]), /Enable Isolated Workspaces" is off[\s\S]*Nothing changed/);
  assert.equal(env.db.patches.length, 0, "it doesn't send a change Paperclip would drop");

  // An older Paperclip without the settings endpoint, that drops the change anyway.
  env.db.experimental = null;
  env.fake.fail("PATCH", /^\/api\/issues\/[^/]+$/, 200, { times: 5, body: { ok: true } });
  await assert.rejects(cmd.workspace(env.ctx, "ACM-415", ["--apply"]), /kept the link[\s\S]*Enable Isolated Workspaces/);
  assert.equal(a.executionWorkspaceId, ws.id);
});

test("a workspace whose row is gone is dead; a 404 from the workspace itself proves nothing", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, ws } = seed(env.db);
  a.executionWorkspaceId = uuid(); // gone: the issue carries currentExecutionWorkspace: null
  const gone = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-415"))).join("\n");
  assert.match(gone, /reuses workspace .{8}, which no longer exists: every run fails at setup/);

  // An older Paperclip whose issues don't carry their workspace: it's read
  // directly, and a 404 (missing, or private to the key) is not taken as closed.
  env.db.noInlineWorkspace = true;
  a.executionWorkspaceId = ws.id;
  ws.status = "active";
  ws.private = true;
  const text = (await captureOutput(() => cmd.why(env.ctx, "ACM-415"))).join("\n");
  assert.match(text, /Workspace: reuses workspace .{8} \(couldn't read it: not found, or not readable with this key\)/);
  assert.doesNotMatch(text, /runs can't start/);
  await assert.rejects(cmd.workspace(env.ctx, "ACM-415", ["--apply"]), /couldn't be read/);
  assert.equal(env.db.patches.length, 0);

  ws.private = false;
  ws.status = "archived";
  const read = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-415"))).join("\n");
  assert.match(read, /\(archived/);
  assert.ok(env.fake.requests.some((r) => r.path === `/api/execution-workspaces/${ws.id}`));
});

test("workspace --apply keeps the issue's other workspace settings", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a } = seed(env.db);
  const envId = uuid();
  a.executionWorkspaceSettings = {
    mode: "isolated_workspace",
    environmentId: envId,
    workspaceStrategy: { type: "git_worktree", existingBranch: "feature/x" },
    networkEgress: { allowFqdns: ["example.com"] },
  };
  await captureOutput(() => cmd.workspace(env.ctx, "ACM-415", ["--apply"]));
  assert.deepEqual(a.executionWorkspaceSettings, {
    mode: "isolated_workspace",
    environmentId: envId,
    workspaceStrategy: { type: "git_worktree", existingBranch: "feature/x" },
    networkEgress: { allowFqdns: ["example.com"] },
  });
  assert.equal(a.executionWorkspaceId, null);
});

test("workspace leaves alone a change already scheduled, and explains its own closed workspace", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, b, ws, owner } = seed(env.db);
  b.workspacePendingSelection = { selection: "isolated_workspace" };
  const text = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-415", ["--apply"]))).join("\n");
  assert.match(text, /ACM-416: left alone \(a workspace change is already scheduled for its next run\)/);
  assert.equal(b.executionWorkspaceId, ws.id);
  await assert.rejects(cmd.workspace(env.ctx, "ACM-416", ["--apply"]), /already scheduled/);

  // A finished issue reopened after its own workspace was closed.
  Object.assign(owner, { status: "todo", executionWorkspacePreference: "reuse_existing", assigneeAgentId: a.assigneeAgentId });
  const own = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-318"))).join("\n");
  assert.match(own, /reuses its own workspace .{8} \(archived/);
  assert.match(own, /It is the issue's own workspace: the new one starts from the base branch/);
});

test("workspace --apply on a live workspace another issue owns changes only that issue", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, b, ws } = seed(env.db, { wsStatus: "active", ownerStatus: "in_progress" });
  const preview = (await captureOutput(() => cmd.workspace(env.ctx, "ACM-415"))).join("\n");
  assert.match(preview, /reuses ACM-318's workspace .{8} \(active, branch ACM-318-recovery\): its commits land on that issue's branch/);
  assert.doesNotMatch(preview, /Also linked/, "a live workspace may be shared on purpose");
  assert.match(preview, /stop working on ACM-318's branch/);

  await captureOutput(() => cmd.workspace(env.ctx, "ACM-415", ["--apply"]));
  assert.deepEqual(env.db.patches.map((p) => p.identifier), ["ACM-415"]);
  assert.equal(a.executionWorkspaceId, null);
  assert.equal(b.executionWorkspaceId, ws.id);
});

test("pch why: a dead link outranks the blocked note and recommends pch workspace", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { agent, b, ws } = seed(env.db);
  const failed = setupFailed(agent.id, ws.id, "ACM-416");
  env.db.issueRuns[b.id] = [failed];
  env.db.heartbeatRuns.push({ id: failed.runId, companyId: ids.company, agentId: agent.id, status: "failed", error: failed.error, createdAt: failed.createdAt });
  env.db.comments.push({ issueId: b.id, body: "Blocked: waiting on the review.", authorAgentId: agent.id });

  const text = (await captureOutput(() => cmd.why(env.ctx, "ACM-416"))).join("\n");
  assert.match(text, /Workspace: reuses ACM-318's workspace .{8} \(archived/);
  assert.match(text, /Recommendation: Gilfoyle's runs can't start: the issue reuses ACM-318's workspace .{8}, which is closed/);
  assert.match(text, /1\. pch workspace ACM-416 /);
  assert.match(text, /2\. pch workspace ACM-416 --apply /);
  assert.match(text, /3\. Then: pch comment ACM-416 "Gilfoyle, the workspace is fixed/);
  assert.match(text, /The watchdog clears the link by itself within a minute/);
  const off = (await captureOutput(() => cmd.why(env.makeCtx({ WATCHDOG_CLEAR_DEAD_LINKS: "false" }), "ACM-416"))).join("\n");
  assert.match(off, /The watchdog leaves this one to you/);
});

test("pch why: once the link is cleared, a failed run is retried with a comment", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { agent, a, ws } = seed(env.db);
  const failed = setupFailed(agent.id, ws.id, "ACM-415");
  env.db.issueRuns[a.id] = [failed];
  env.db.heartbeatRuns.push({ id: failed.runId, companyId: ids.company, agentId: agent.id, status: "failed", error: failed.error, createdAt: failed.createdAt });
  Object.assign(a, isolatedSelection(a), { status: "todo" });

  const text = (await captureOutput(() => cmd.why(env.ctx, "ACM-415"))).join("\n");
  assert.doesNotMatch(text, /^Workspace:/m);
  assert.match(text, /The link has been cleared since, but nothing has restarted Gilfoyle/);
  assert.match(text, /1\. pch comment ACM-415 "Gilfoyle, the workspace is fixed/);
});

test("pch why: an agent that blocked over another issue's live workspace gets a ruling", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { carla, owner, ws } = seed(env.db, { wsStatus: "active", ownerStatus: "in_review" });
  const issue = {
    id: uuid(),
    identifier: "ACM-419",
    companyId: ids.company,
    status: "blocked",
    assigneeAgentId: carla.id,
    title: "HostStop",
    executionWorkspaceId: ws.id,
    executionWorkspacePreference: "reuse_existing",
  };
  env.db.issues.push(issue);
  env.db.issueRuns[issue.id] = [{ runId: uuid(), agentId: carla.id, status: "succeeded", createdAt: minutesAgo(30) }];
  env.db.blockerDiagnostics[issue.id] = { readiness: { allBlockersDone: true, isDependencyReady: true }, blockers: [] };
  env.db.comments.push({
    issueId: issue.id,
    body: `Implementation is blocked by the pending workspace ruling; this execution mandates commits on ${owner.identifier}'s excluded branch.`,
    authorAgentId: carla.id,
  });

  const text = (await captureOutput(() => cmd.why(env.ctx, "ACM-419"))).join("\n");
  assert.match(text, /Workspace: reuses ACM-318's workspace .{8} \(active, branch ACM-318-recovery\)/);
  assert.match(text, /Recommendation: Carla blocked this issue over its workspace: it is linked to ACM-318's live workspace \(branch ACM-318-recovery\)/);
  assert.match(text, /1\. If it should have its own branch and PR: pch workspace ACM-419 --apply/);
  assert.match(text, /2\. Then give the ruling: pch comment ACM-419 "Carla, workspace ruling/);
});

test("advice: a foreign live link with an unrelated note keeps the plain blocked advice", () => {
  const a = advise({
    identifier: "ACM-1",
    issue: { status: "blocked", assigneeAgentId: "a" },
    assignee: { name: "Carla", status: "idle" },
    blockers: { blockers: [] },
    runs: [],
    link: { state: "foreign", workspaceId: "w", owner: { identifier: "ACM-2" }, workspace: { status: "active" } },
    lastComment: { body: "Waiting for the fixture file." },
  });
  assert.match(a.what, /blocked this issue with a note of its own/);
});
