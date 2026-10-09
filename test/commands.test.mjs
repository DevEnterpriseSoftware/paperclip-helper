import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { captureOutput, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import * as cmd from "../src/commands.mjs";
import { writeJson } from "../src/store.mjs";

function agents(db) {
  const make = (name, adapterConfig, extra = {}) => {
    const a = { id: uuid(), companyId: ids.company, name, adapterType: "claude_local", adapterConfig, status: "idle", ...extra };
    db.agents.push(a);
    return a;
  };
  return {
    a: make("Alpha", { model: "claude-opus-5", effort: "xhigh", env: { X: "1" } }),
    b: make("Beta", { model: "claude-opus-5", effort: "high" }),
    c: make("Gamma", { model: "claude-sonnet-5" }),
  };
}

test("set-model previews, then changes only the model and keeps everything else", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a, b, c } = agents(env.db);
  const preview = await captureOutput(() => cmd.setModel(env.ctx, "claude-opus-5", "claude-opus-5.5"));
  assert.match(preview.join("\n"), /would change Alpha: claude-opus-5 → claude-opus-5.5 \(effort xhigh kept\)/);
  assert.equal(a.adapterConfig.model, "claude-opus-5");

  const lines = await captureOutput(() => cmd.setModel(env.ctx, "claude-opus-5", "claude-opus-5.5", ["--apply"]));
  assert.deepEqual(a.adapterConfig, { model: "claude-opus-5.5", effort: "xhigh", env: { X: "1" } });
  assert.equal(b.adapterConfig.model, "claude-opus-5.5");
  assert.equal(c.adapterConfig.model, "claude-sonnet-5");
  assert.equal(lines.filter((l) => l.startsWith("changed")).length, 2);
});

test("set-model flags an agent that lost settings", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { a } = agents(env.db);
  a.dropOnPatch = ["effort"];
  let lines;
  await assert.rejects(async () => {
    lines = await captureOutput(() => cmd.setModel(env.ctx, "claude-opus-5", "x", ["--apply"]));
  }, /need checking/);
});

test("approve refuses when the decision isn't waiting on you; changes refuses without a comment", async (t) => {
  const env = await setup();
  t.after(env.close);
  const issue = {
    id: uuid(),
    identifier: "ACM-4",
    companyId: ids.company,
    status: "in_review",
    executionState: { status: "pending", currentParticipant: { type: "agent", agentId: "qa" } },
  };
  env.db.issues.push(issue);
  await assert.rejects(cmd.decide(env.ctx, "approve", "ACM-4", ""), /isn't waiting on you \(current participant: agent qa\)\. Nothing changed/);
  await assert.rejects(cmd.decide(env.ctx, "changes", "ACM-4", ""), /needs a comment/);
  assert.equal(env.db.patches.length, 0);

  issue.executionState.currentParticipant = { type: "user", userId: ids.user };
  await captureOutput(() => cmd.decide(env.ctx, "approve", "acm-4", ""));
  assert.deepEqual(env.db.patches[0].body, { status: "done", comment: "Approved.\n\n_Sent with Paperclip Helper (`pch`)._" });
});

test("comment posts the text as a comment, and needs both an issue and text", async (t) => {
  const env = await setup();
  t.after(env.close);
  env.db.issues.push({ id: uuid(), identifier: "ACM-4", companyId: ids.company, status: "todo" });
  await assert.rejects(cmd.comment(env.ctx, "ACM-4", ""), /usage: comment/);
  await assert.rejects(cmd.comment(env.ctx, undefined, "hi"), /usage: comment/);
  assert.equal(env.db.comments.length, 0);
  const lines = await captureOutput(() => cmd.comment(env.ctx, "acm-4", "Please rebase first."));
  assert.deepEqual(env.db.comments.map((c) => [c.identifier, c.body, c.via]), [["ACM-4", "Please rebase first.\n\n_Sent with Paperclip Helper (`pch`)._", "comment"]]);
  assert.deepEqual(env.db.patches, []);
  assert.deepEqual(lines, ["acm-4: comment added."]);
});

test("revoke revokes the key in Paperclip and deletes the file", async (t) => {
  const env = await setup();
  t.after(env.close);
  const token = env.ctx.readToken();
  const keyId = env.db.tokens[token].keyId;
  await captureOutput(() => cmd.revoke(env.ctx));
  assert.equal(env.db.tokens[token], undefined);
  assert.ok(env.db.keys.find((k) => k.id === keyId).revokedAt);
  assert.equal(fs.existsSync(env.ctx.config.tokenFile), false);
});

test("revoke keeps the file when Paperclip refuses, so you can retry", async (t) => {
  const env = await setup();
  t.after(env.close);
  env.fake.fail("POST", "/api/cli-auth/revoke-current", 500);
  await assert.rejects(cmd.revoke(env.ctx), /500/);
  assert.equal(fs.existsSync(env.ctx.config.tokenFile), true);
});

test("login swaps the temporary token for a named key and saves it", async (t) => {
  const env = await setup({ env: { PAPERCLIP_PUBLIC_URL: "https://paperclip.example.com" } });
  t.after(env.close);
  fs.rmSync(env.ctx.config.tokenFile);
  const approver = setInterval(() => {
    for (const ch of Object.values(env.db.challenges)) if (ch.status === "pending") env.fake.approve(ch.id);
  }, 50);
  t.after(() => clearInterval(approver));
  const lines = await captureOutput(() => cmd.login(env.ctx));
  assert.match(lines.join("\n"), /https:\/\/paperclip\.example\.com\/cli-auth\//);
  const saved = fs.readFileSync(env.ctx.config.tokenFile, "utf8").trim();
  assert.ok(saved.startsWith("pcp_board_"));
  const key = env.db.keys.find((k) => env.db.tokens[saved]?.keyId === k.id);
  assert.equal(key.name, "paperclip-helper");
  assert.ok(Date.parse(key.expiresAt) > Date.now() + 360 * 86_400_000);
  // The temporary token was revoked.
  const temp = Object.values(env.db.challenges)[0].boardApiToken;
  assert.equal(env.db.tokens[temp], undefined);
});

test("status and health read the service's status file", async (t) => {
  const env = await setup();
  t.after(env.close);
  await assert.rejects(cmd.health(env.ctx), /no recent heartbeat/);
  writeJson(env.ctx.config.statusFile, {
    version: "1.0.0",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    relay: { on: false },
    watchdog: { on: true, lastTickAt: new Date().toISOString(), nudges: 3, heals: 1, lastTickMs: 40 },
    costSync: { on: true, posted: 5, postedCents: 1234, unpriced: { "gpt-9": 2 } },
  });
  const ok = await captureOutput(() => cmd.health(env.ctx));
  assert.deepEqual(ok, ["ok"]);
  const lines = (await captureOutput(() => cmd.status(env.ctx))).join("\n");
  assert.match(lines, /Watchdog: on, .*3 nudges and 1 repairs/);
  assert.match(lines, /Cost sync: on, .*5 runs \(\$12\.34\)/);
  assert.match(lines, /Not priced: gpt-9 \(2 runs\)/);
  assert.match(lines, /as Operator; key "paperclip-helper", no expiry/);
  // A Paperclip that reports no version or commit adds nothing to the line.
  assert.match(lines, /^Paperclip: \S+ as Operator/m);
  env.db.build = { version: "2026.1001.0", commit: "8f8a0ab7effbd6a0584107d8038736c134ee5047" };
  const withBuild = (await captureOutput(() => cmd.status(env.ctx))).join("\n");
  assert.match(withBuild, /^Paperclip: \S+ \(2026\.1001\.0, commit 8f8a0ab\) as Operator/m);
  process.exitCode = 0;
});

test("probe reports reachability and the hostname guard as JSON", async (t) => {
  const env = await setup({ allowedHosts: ["localhost"] });
  t.after(env.close);
  const guarded = JSON.parse((await captureOutput(() => cmd.probe(env.ctx)))[0]);
  assert.deepEqual({ ok: guarded.ok, code: guarded.code, hostname: guarded.hostname }, { ok: false, code: "hostname_guard", hostname: "127.0.0.1" });
  const ok = JSON.parse((await captureOutput(() => cmd.probe(env.ctx, `http://localhost:${env.fake.port}`)))[0]);
  assert.equal(ok.ok, true);
  assert.equal(ok.deploymentMode, "authenticated");
  process.exitCode = 0;
});

test("check shows the key, its companies and prefixes", async (t) => {
  const env = await setup();
  t.after(env.close);
  const lines = (await captureOutput(() => cmd.check(env.ctx))).join("\n");
  assert.match(lines, /Key belongs to: Operator <operator@example.com>/);
  assert.match(lines, /Company: Acme \(issue prefix ACM\)/);
  assert.ok(path.isAbsolute(env.ctx.config.tokenFile));
});

test("update explains that it runs on the host, and how to get there", async () => {
  const text = (await captureOutput(() => cmd.update())).join("\n");
  assert.match(text, /install\.sh \| bash/);
  assert.match(text, /docker compose pull && docker compose up -d/);
});

test("wrapper prints the host-side pch scripts, which handle update and pass the rest on", () => {
  for (const kind of ["sh", "ps1"]) {
    const script = cmd.wrapperScript(kind);
    assert.match(script, /update/);
    assert.match(script, /run --rm helper/);
    assert.match(script, new RegExp(`wrapper ${kind}`), `pch.${kind} refreshes itself`);
  }
  assert.match(cmd.wrapperScript("sh"), /^#!\/bin\/sh\n/);
  assert.ok(![...cmd.wrapperScript("ps1")].some((c) => c.charCodeAt(0) > 127), "pch.ps1 is ASCII for Windows PowerShell 5.1");
  assert.throws(() => cmd.wrapperScript("bat"), /wrapper sh\|ps1/);
});

function heldIssue(env, extra = {}) {
  const agent = { id: uuid(), companyId: ids.company, name: "Carla", adapterType: "claude_local", adapterConfig: {}, status: "idle" };
  env.db.agents.push(agent);
  const runId = uuid();
  const actionId = uuid();
  const issue = {
    id: uuid(),
    identifier: "ACM-52",
    companyId: ids.company,
    status: "todo",
    assigneeAgentId: agent.id,
    executionBlocker: {
      recoveryActionId: actionId,
      runId,
      agentId: agent.id,
      cause: "legacy_execution_requires_reconciliation",
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
    },
    ...extra,
  };
  env.db.issues.push(issue);
  env.db.issueRuns[issue.id] = [
    { runId, agentId: agent.id, status: "cancelled", errorCode: "issue_reassigned", createdAt: "2026-10-01T20:20:58.977Z", finishedAt: "2026-10-01T20:21:30.000Z", processPid: null, processGroupId: null },
  ];
  // The run itself carries the process ids the issue's run list leaves out.
  env.db.heartbeatRuns.push({ id: runId, companyId: ids.company, agentId: agent.id, status: "cancelled", processPid: null, processGroupId: null });
  env.db.queuedComments[issue.id] = {
    issueId: issue.id, queueId: uuid(), state: "deferred", targetRunId: null, revision: "r1", protocol: "legacy",
    entries: [{ id: uuid() }],
    executionWait: { reason: "process_identity_missing", message: "The previous run has no verified stop record. Paperclip cannot start this message yet." },
  };
  return { issue, agent, runId, actionId };
}

test("release previews a hold without changing anything", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { issue, runId } = heldIssue(env);
  const lines = await captureOutput(() => cmd.release(env.ctx, "acm-52"));
  const text = lines.join("\n");
  assert.match(text, /held: legacy_execution_requires_reconciliation/);
  assert.match(text, new RegExp(`Held run: ${runId} \\(Carla\\)`));
  assert.match(text, /process: none recorded/);
  assert.match(text, /Saved messages: 1 \("The previous run has no verified stop record/);
  assert.match(text, /Paperclip can't release this by itself/);
  assert.match(text, /pch release acm-52 --apply/);
  assert.equal(env.db.resolutions, undefined);
  assert.deepEqual(env.db.interrupts, []);
  assert.ok(issue.executionBlocker);
});

test("release --apply reconciles the held run and delivers the saved messages", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { issue, runId, actionId } = heldIssue(env);
  const lines = await captureOutput(() => cmd.release(env.ctx, "ACM-52", ["--apply"]));
  const [res] = env.db.resolutions;
  assert.equal(res.body.actionId, actionId);
  assert.equal(res.body.outcome, "restored");
  assert.equal(res.body.sourceIssueStatus, "todo");
  assert.deepEqual(
    { runId: res.body.executionReconciliation.runId, providerStopped: res.body.executionReconciliation.providerStopped, actionOutcome: res.body.executionReconciliation.actionOutcome },
    { runId, providerStopped: true, actionOutcome: "mixed" },
  );
  assert.match(res.body.executionReconciliation.outcomeEvidence, /cancelled \(issue_reassigned\).*unverified/);
  assert.equal(issue.executionBlocker, null);
  assert.equal(env.db.interrupts.length, 1);
  assert.equal(env.db.interrupts[0].body.targetRunId, null);
  assert.match(lines.join("\n"), /hold released \(todo\)[\s\S]*Delivered 1 saved message\(s\) to Carla/);
});

test("release refuses a still-running run, a bad outcome, and an issue without a hold", async (t) => {
  const env = await setup();
  t.after(env.close);
  const { issue } = heldIssue(env);
  env.db.issueRuns[issue.id][0].status = "running";
  await assert.rejects(cmd.release(env.ctx, "ACM-52", ["--apply"]), /Not releasing: the run is still running/);
  await assert.rejects(cmd.release(env.ctx, "ACM-52", ["--outcome=maybe"]), /--outcome must be one of/);
  await assert.rejects(cmd.release(env.ctx, undefined), /usage: release/);
  assert.equal(env.db.resolutions, undefined);

  issue.executionBlocker = null;
  const lines = await captureOutput(() => cmd.release(env.ctx, "ACM-52", ["--apply"]));
  assert.match(lines.join("\n"), /no execution hold/);
});
