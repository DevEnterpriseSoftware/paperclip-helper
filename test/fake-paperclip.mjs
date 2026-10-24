// A small in-memory stand-in for the parts of Paperclip's API the helper uses.
// Tests seed `db`, run a component, then inspect `db` and `requests`.

import http from "node:http";
import crypto from "node:crypto";

export const ids = {
  company: "c0000000-0000-4000-8000-000000000001",
  user: "u-operator",
};

let counter = 0;
export const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

export function emptyDb() {
  return {
    companies: [{ id: ids.company, name: "Acme", issuePrefix: "ACM" }],
    users: { [ids.user]: { id: ids.user, name: "Operator", email: "operator@example.com" } },
    tokens: {}, // token → { userId, keyId }
    keys: [], // { id, name, expiresAt, userId, revokedAt }
    challenges: {},
    agents: [],
    issues: [],
    comments: [],
    patches: [],
    issueRuns: {}, // issueId → [{ runId, agentId, status, createdAt, finishedAt }]
    wakes: {}, // issueId → [{ kind, agentId, status, reason, requestedAt }], newest first
    queuedComments: {}, // issueId → { queueId, state, protocol, revision, targetRunId, entries }
    interrupts: [], // { issueId, body }
    recoveryActions: {}, // issueId → the active recovery action
    blockerDiagnostics: {}, // issueId → { readiness, blockers }
    workProducts: {}, // issueId → [...]
    workspaceOps: {}, // workspaceId → [...]
    executionWorkspaces: [], // { id, companyId, sourceIssueId, mode, status, branchName, closedAt, readiness?, closeFails? }
    workspaceCloses: [], // ids of workspaces closed through PATCH /api/execution-workspaces/:id
    experimental: { enableIsolatedWorkspaces: true }, // GET /api/instance/settings/experimental
    heartbeatRuns: [], // { id, companyId, agentId, status, finishedAt, usageJson, contextSnapshot, createdAt, resultJson }
    runEvents: {}, // runId → [{ seq, eventType, payload }], oldest first
    costEvents: [],
    costIdempotency: true, // false: a Paperclip before 2026.10, which drops idempotencyKey
    hangAfterRecording: 0, // the next N cost posts are recorded but never answered
    activity: [],
    budgets: { policies: [] },
    interactions: {}, // issueId → [{ id, kind, status, addresseeAgentId, addresseeUserId, createdByAgentId, payload, createdAt }]
    created: [], // issues created through POST /api/companies/:id/issues
    documents: {}, // issueId → { key → { body, latestRevisionId, … } }
    // Off by default: with it on, a board update or comment wakes the issue's assignee
    // as Paperclip does (a queued run in issueRuns), for tests that check the wake.
    simulateWakes: false,
  };
}

const GUARD =
  "This hostname is not allowed for this Paperclip instance. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";

// A comment by the key's user, with the fields Paperclip's comment list carries.
function boardComment(issue, body, via, who) {
  return {
    id: uuid(), issueId: issue.id, identifier: issue.identifier, body, via,
    authorType: "user", authorUserId: who?.userId ?? null, authorAgentId: null, createdAt: new Date().toISOString(),
  };
}

export async function startFake({ db = emptyDb(), allowedHosts = null } = {}) {
  const requests = [];
  const failures = []; // { method, path (regex), status, body, times, hang }

  // Like Paperclip's PATCH /api/issues/:id and issue-comment-wakeup: a board user's
  // comment, or a move out of blocked or backlog to todo, wakes the assignee unless the
  // issue is done or cancelled or the agent can't be invoked (agent-eligibility.ts).
  // Only with db.simulateWakes: the other tests predate it and count runs themselves.
  const wakeAssignee = (issue, reason) => {
    if (!db.simulateWakes || !issue.assigneeAgentId || ["done", "cancelled"].includes(issue.status)) return;
    const agent = db.agents.find((a) => a.id === issue.assigneeAgentId);
    if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) return;
    const runs = (db.issueRuns[issue.id] ??= []);
    // One wake per issue and agent at a time: a later one coalesces into the queued run.
    if (runs.some((r) => r.agentId === agent.id && r.status === "queued")) return;
    // The same run in the company's run list, as Paperclip lists it (heartbeat-runs).
    const runId = uuid();
    const run = { id: runId, runId, companyId: issue.companyId, agentId: agent.id, status: "queued", reason, createdAt: new Date().toISOString() };
    runs.unshift(run);
    db.heartbeatRuns.push(run);
  };
  const issueByRef = (ref) => db.issues.find((i) => i.id === ref || i.identifier?.toUpperCase() === String(ref).toUpperCase());
  const actor = (req) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return token ? db.tokens[token] ?? { invalid: true } : null;
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, "http://fake");
    const p = url.pathname;
    const q = url.searchParams;
    requests.push({ method: req.method, path: p + url.search, body, host: req.headers.host });
    // A test's hook: change the world between two of the helper's requests.
    db.onRequest?.(req.method, p + url.search);
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };

    if (allowedHosts) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!allowedHosts.includes(host)) return send(403, { error: GUARD });
    }
    const failure = failures.find((f) => f.method === req.method && f.path.test(p) && f.times !== 0);
    if (failure) {
      if (failure.times > 0) failure.times -= 1;
      if (failure.hang) return; // never answer
      return send(failure.status, failure.body ?? { error: "injected failure" });
    }

    const who = actor(req);
    if (who?.invalid && p !== "/api/health") return send(401, { error: "Agent token did not verify; obtain fresh credentials and retry" });
    let m;

    // ---- health and auth
    // Like Paperclip, the version and commit are only told to an authenticated caller.
    if (p === "/api/health") {
      const build = who && !who.invalid ? db.build ?? {} : {};
      return send(200, { status: "ok", deploymentMode: "authenticated", deploymentExposure: "private", ...build });
    }
    if (p === "/api/cli-auth/challenges" && req.method === "POST") {
      const id = uuid();
      const secret = `pcp_cli_auth_${crypto.randomBytes(8).toString("hex")}`;
      const boardApiToken = `pcp_board_${crypto.randomBytes(24).toString("hex")}`;
      db.challenges[id] = { id, secret, boardApiToken, status: "pending" };
      return send(201, {
        id,
        token: secret,
        boardApiToken,
        approvalPath: `/cli-auth/${id}?token=${secret}`,
        approvalUrl: null,
        pollPath: `/cli-auth/challenges/${id}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    }
    if ((m = p.match(/^\/api\/cli-auth\/challenges\/([^/]+)$/)) && req.method === "GET") {
      const ch = db.challenges[m[1]];
      if (!ch || q.get("token") !== ch.secret) return send(404, { error: "CLI auth challenge not found" });
      return send(200, { id: ch.id, status: ch.status });
    }
    if (p === "/api/cli-auth/me") {
      if (!who) return send(401, { error: "Board authentication required" });
      return send(200, {
        userId: who.userId,
        user: db.users[who.userId],
        companyIds: db.companies.map((c) => c.id),
        source: "board_key",
        keyId: who.keyId,
      });
    }
    if (p === "/api/board-api-keys" && req.method === "POST") {
      if (!who) return send(401, { error: "Board authentication required" });
      const id = uuid();
      const token = `pcp_board_${crypto.randomBytes(24).toString("hex")}`;
      const key = { id, name: body.name, expiresAt: body.expiresAt ?? null, userId: who.userId, revokedAt: null };
      db.keys.push(key);
      db.tokens[token] = { userId: who.userId, keyId: id };
      return send(201, { ...key, token });
    }
    if (p === "/api/board-api-keys" && req.method === "GET") {
      return send(200, db.keys.filter((k) => k.userId === who?.userId && !k.revokedAt));
    }
    if (p === "/api/cli-auth/revoke-current" && req.method === "POST") {
      const token = (req.headers.authorization ?? "").slice(7);
      const entry = db.tokens[token];
      if (!entry) return send(400, { error: "Current board API key context is required" });
      delete db.tokens[token];
      const key = db.keys.find((k) => k.id === entry.keyId);
      if (key) key.revokedAt = new Date().toISOString();
      return send(200, { revoked: true, keyId: entry.keyId });
    }
    if (!who) return send(401, { error: "Board authentication required" });

    // ---- companies
    if ((m = p.match(/^\/api\/companies\/([^/]+)$/))) {
      const c = db.companies.find((x) => x.id === m[1]);
      return c ? send(200, c) : send(404, { error: "Company not found" });
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/agents$/))) {
      // Like Paperclip (services/agents.ts list): terminated agents are left out.
      return send(200, db.agents.filter((a) => a.companyId === m[1] && a.status !== "terminated"));
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/issues$/)) && req.method === "GET") {
      let list = db.issues.filter((i) => i.companyId === m[1]);
      if (q.get("status")) {
        const statuses = q.get("status").split(",");
        list = list.filter((i) => statuses.includes(i.status));
      }
      if (q.get("parentId")) list = list.filter((i) => i.parentId === q.get("parentId"));
      if (q.get("executionWorkspaceId")) list = list.filter((i) => i.executionWorkspaceId === q.get("executionWorkspaceId"));
      if (q.get("sortField") === "id") list = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (q.get("afterId")) list = list.filter((i) => i.id > q.get("afterId"));
      const limit = Math.min(Number(q.get("limit") ?? 500), 1000);
      // Like Paperclip, list rows don't carry the execution state.
      return send(200, list.slice(0, limit).map((i) => ({ ...i, executionState: null })));
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/issues$/)) && req.method === "POST") {
      // Like Paperclip's issue create: a title is required; the identifier is the next number.
      if (!body?.title) return send(400, { error: "Validation error" });
      const company = db.companies.find((c) => c.id === m[1]);
      if (!company) return send(404, { error: "Company not found" });
      const n = 1 + Math.max(0, ...db.issues.map((i) => Number(String(i.identifier ?? "").split("-")[1]) || 0));
      const issue = { id: uuid(), identifier: `${company.issuePrefix}-${n}`, companyId: m[1], status: "backlog", updatedAt: new Date().toISOString(), ...body };
      db.issues.push(issue);
      db.created.push(issue);
      return send(201, issue);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/heartbeat-runs$/))) {
      const limit = Math.min(Number(q.get("limit") ?? 1000), 1000);
      const list = db.heartbeatRuns
        .filter((r) => r.companyId === m[1] && (!q.get("agentId") || r.agentId === q.get("agentId")))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
      return send(200, list);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/cost-events$/)) && req.method === "POST") {
      if (!body.agentId || !body.provider || !body.model || !Number.isInteger(body.costCents)) {
        return send(400, { error: "Validation error" });
      }
      if (body.issueId && !db.issues.some((i) => i.id === body.issueId)) return send(422, { error: "Issue not found" });
      // Paperclip 2026.10 records a receipt once per idempotencyKey: the same receipt
      // again returns the first, a different one is a 409. Older versions drop the key.
      let receipt = body;
      if (!db.costIdempotency) {
        const { idempotencyKey: _dropped, ...rest } = body;
        receipt = rest;
      } else if (body.idempotencyKey) {
        const existing = db.costEvents.find((e) => e.idempotencyKey === body.idempotencyKey);
        if (existing) {
          const { id: _id, companyId: _c, ...was } = existing;
          const same = JSON.stringify(Object.entries(was).sort()) === JSON.stringify(Object.entries(body).sort());
          return same ? send(201, existing) : send(409, { error: "Idempotency key already used for a different cost receipt" });
        }
      }
      const event = { id: uuid(), companyId: m[1], ...receipt };
      db.costEvents.push(event);
      db.activity.push({ action: "cost.reported", actorType: "user", actorId: who.userId, entityType: "cost_event", entityId: event.id, runId: body.heartbeatRunId ?? null });
      if (db.hangAfterRecording > 0) {
        db.hangAfterRecording -= 1;
        return; // recorded, but the answer never comes
      }
      return send(201, event);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/activity$/))) {
      // Newest first, like Paperclip's activity list, filtered by entityType and entityId.
      const type = q.get("entityType");
      const entity = q.get("entityId");
      return send(200, db.activity.filter((a) => (!type || a.entityType === type) && (!entity || a.entityId === entity)).slice().reverse());
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/costs\/by-agent$/)) && req.method === "GET") {
      // Like Paperclip's costs.byAgent: cost events in [from, to], summed per agent.
      const from = Date.parse(q.get("from") ?? "") || 0;
      const to = Date.parse(q.get("to") ?? "") || Infinity;
      const rows = new Map();
      for (const e of db.costEvents) {
        const at = Date.parse(e.occurredAt ?? "");
        if (e.companyId !== m[1] || !(at >= from && at <= to)) continue;
        const row = rows.get(e.agentId) ?? { agentId: e.agentId, costCents: 0, eventCount: 0 };
        row.costCents += e.costCents ?? 0;
        row.eventCount += 1;
        rows.set(e.agentId, row);
      }
      return send(200, [...rows.values()]);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/budgets\/overview$/))) {
      return send(200, { companyId: m[1], ...db.budgets });
    }

    // ---- runs
    if ((m = p.match(/^\/api\/heartbeat-runs\/([^/]+)$/))) {
      const run = db.heartbeatRuns.find((r) => r.id === m[1]);
      return run ? send(200, run) : send(404, { error: "Heartbeat run not found" });
    }
    if ((m = p.match(/^\/api\/heartbeat-runs\/([^/]+)\/events$/))) {
      return send(200, db.runEvents[m[1]] ?? []);
    }

    // ---- agents
    // Like Paperclip's POST /api/agents/:id/pause and /resume (routes/agents.ts): a board
    // pause records pausedAt and pauseReason "manual" and cancels the agent's active runs.
    if ((m = p.match(/^\/api\/agents\/([^/]+)\/(pause|resume)$/)) && req.method === "POST") {
      const ACTIVE = ["queued", "running", "scheduled_retry"]; // heartbeat/recovery.ts cancels scheduled retries too
      const agent = db.agents.find((a) => a.id === m[1]);
      if (!agent) return send(404, { error: "Agent not found" });
      db.lifecycle = [...(db.lifecycle ?? []), { agentId: agent.id, action: m[2] }];
      if (m[2] === "pause") {
        // db.now: a test's own clock, when it runs on one.
        if (agent.status !== "paused") Object.assign(agent, { status: "paused", pausedAt: new Date(db.now?.() ?? Date.now()).toISOString(), pauseReason: "manual" });
        for (const runs of Object.values(db.issueRuns)) {
          for (const r of runs) if (r.agentId === agent.id && ACTIVE.includes(r.status)) Object.assign(r, { status: "cancelled", errorCode: "agent_paused" });
        }
        for (const r of db.heartbeatRuns) if (r.agentId === agent.id && ACTIVE.includes(r.status)) Object.assign(r, { status: "cancelled", errorCode: "agent_paused" });
      } else {
        Object.assign(agent, { status: "idle", pausedAt: null, pauseReason: null });
      }
      return send(200, agent);
    }
    if ((m = p.match(/^\/api\/agents\/([^/]+)$/))) {
      const agent = db.agents.find((a) => a.id === m[1]);
      if (!agent) return send(404, { error: "Agent not found" });
      if (req.method === "PATCH") {
        if (body.adapterConfig) {
          agent.adapterConfig = { ...agent.adapterConfig, ...body.adapterConfig };
          for (const k of agent.dropOnPatch ?? []) delete agent.adapterConfig[k];
        }
        return send(200, agent);
      }
      return send(200, agent);
    }

    // ---- issues
    if ((m = p.match(/^\/api\/issues\/([^/]+)(\/.*)?$/))) {
      const issue = issueByRef(decodeURIComponent(m[1]));
      if (!issue) return send(404, { error: "Issue not found" });
      const rest = m[2] ?? "";
      if (rest === "" && req.method === "GET") {
        // Like Paperclip (routes/issues.ts): the issue carries a compact copy of its workspace.
        // null when the issue has no workspace or its row is gone; read without a privacy check.
        if (db.noInlineWorkspace) return send(200, issue);
        const ws = issue.executionWorkspaceId ? db.executionWorkspaces.find((w) => w.id === issue.executionWorkspaceId) : null;
        return send(200, { ...issue, currentExecutionWorkspace: ws ? { ...ws } : null });
      }
      if (rest === "" && req.method === "PATCH") {
        if (body.comment && issue.paused) return send(409, { error: "Task is paused. Resume it before sending a message." });
        db.patches.push({ issueId: issue.id, identifier: issue.identifier, body });
        const before = issue.status;
        if (body.status === "done" && issue.nextStages?.length && issue.executionState?.status === "pending") {
          // Like Paperclip's applyIssueExecutionStageTransition: approving a stage
          // that isn't the last moves the issue to the next stage, still in review.
          const next = issue.nextStages.shift();
          issue.executionState = { status: "pending", currentStageType: next.type, currentParticipant: next.participant };
          issue.status = "in_review";
        } else if (body.status === "in_progress" && body.comment && issue.executionState?.status === "pending" && issue.executionState.returnAssignee?.agentId) {
          // Like Paperclip's changes requested by the stage's participant: back to the
          // implementer who submitted the work (returnAssignee), which wakes it.
          issue.executionState = { ...issue.executionState, status: "changes_requested" };
          Object.assign(issue, { status: "in_progress", assigneeAgentId: issue.executionState.returnAssignee.agentId, assigneeUserId: null });
        } else if (body.status) {
          // Like Paperclip's policy transition: leaving done or cancelled clears the execution state.
          if (["done", "cancelled"].includes(issue.status) && !["done", "cancelled"].includes(body.status)) issue.executionState = null;
          issue.status = body.status;
        }
        if (body.blockedByIssueIds) issue.blockedBy = body.blockedByIssueIds.map((id) => ({ id }));
        if ("executionPolicy" in body) {
          // Like Paperclip's applyMonitorTransition: a policy sent without its monitor clears it ("manual").
          const had = issue.executionPolicy?.monitor;
          // normalizeIssueExecutionPolicy: no stages and no monitor left is no policy.
          const policy = body.executionPolicy;
          issue.executionPolicy = policy && (policy.stages?.length || policy.monitor) ? policy : null;
          if (had && !body.executionPolicy?.monitor && issue.executionState?.monitor) {
            issue.executionState = { ...issue.executionState, monitor: { ...issue.executionState.monitor, status: "cleared", clearReason: "manual", nextCheckAt: null } };
          }
        }
        // Like Paperclip's issue update: with isolated workspaces off, the
        // workspace fields are dropped without an error.
        if (db.experimental?.enableIsolatedWorkspaces !== false) {
          for (const k of ["executionWorkspaceId", "executionWorkspacePreference", "executionWorkspaceSettings"]) {
            if (k in body) issue[k] = body[k];
          }
        }
        if (body.comment) db.comments.push(boardComment(issue, body.comment, "patch", who));
        issue.updatedAt = new Date().toISOString();
        if (body.comment) wakeAssignee(issue, "issue_commented");
        else if (issue.status === "todo" && (before === "blocked" || before === "backlog")) wakeAssignee(issue, "issue_status_changed");
        return send(200, issue);
      }
      if (rest === "/comments" && req.method === "POST") {
        // Paperclip's assertBoardCommentNotPaused: a paused task tree refuses board comments.
        if (issue.paused) return send(409, { error: "Task is paused. Resume it before sending a message." });
        const comment = boardComment(issue, body.body, "comment", who);
        db.comments.push(comment);
        issue.updatedAt = new Date().toISOString();
        wakeAssignee(issue, "issue_commented");
        return send(201, { id: comment.id, body: body.body });
      }
      if (rest === "/runs") return send(200, db.issueRuns[issue.id] ?? []);
      if ((m = rest.match(/^\/documents\/([^/]+)$/))) {
        // Like Paperclip's issue documents: an update must name the latest revision (409 otherwise).
        const docs = (db.documents[issue.id] ??= {});
        const doc = docs[m[1]];
        if (req.method === "GET") return doc ? send(200, doc) : send(404, { error: "Document not found" });
        if (req.method === "PUT") {
          if (doc?.lockedAt) return send(409, { error: "Document is locked" });
          if (doc && body.baseRevisionId !== doc.latestRevisionId) return send(409, { error: "Document was updated by someone else" });
          const next = { key: m[1], title: body.title ?? null, format: body.format, body: body.body, latestRevisionId: uuid(), latestRevisionNumber: (doc?.latestRevisionNumber ?? 0) + 1 };
          docs[m[1]] = next;
          return send(doc ? 200 : 201, next);
        }
      }
      // Like Paperclip's activity.forIssue: the issue's whole log, newest first.
      if (rest === "/activity") return send(200, db.activity.filter((a) => a.entityType === "issue" && a.entityId === issue.id).slice().reverse());
      if ((m = rest.match(/^\/interactions\/([^/]+)\/respond$/)) && req.method === "POST") {
        // Like Paperclip: a pending ask_user_questions card takes answers [{ questionId, optionIds, otherText }].
        const card = (db.interactions[issue.id] ?? []).find((c) => c.id === m[1]);
        if (!card) return send(404, { error: "Interaction not found" });
        if (card.status !== "pending") return send(409, { error: "Interaction is not pending" });
        if (!Array.isArray(body?.answers)) return send(400, { error: "answers: expected array" });
        const questions = card.payload?.questions ?? [];
        for (const a of body.answers) {
          const q = questions.find((x) => x.id === a.questionId);
          if (!q) return send(422, { error: `Unknown question ${a.questionId}` });
          const ids = new Set((q.options ?? []).map((o) => o.id));
          if ((a.optionIds ?? []).some((id) => !ids.has(id))) return send(422, { error: `Unknown option for question ${q.id}` });
          if (q.selectionMode !== "multi" && (a.optionIds ?? []).length > 1) return send(422, { error: `Question ${q.id} takes one option` });
        }
        for (const q of questions) {
          const a = body.answers.find((x) => x.questionId === q.id);
          // A text question (its only option the free-text one) is answered by otherText alone, as Paperclip reads it.
          const textOnly = (q.options ?? []).length > 0 && (q.options ?? []).every((o) => o.freeText);
          const answered = textOnly ? Boolean(a?.otherText) : Boolean(a?.optionIds?.length || a?.otherText);
          if (q.required === true && !answered) return send(422, { error: `Question ${q.id} requires an answer` });
        }
        Object.assign(card, { status: "answered", result: { version: 1, answers: body.answers }, resolvedAt: new Date().toISOString(), resolvedByUserId: who.userId });
        return send(200, card);
      }
      if (rest === "/interactions" && req.method === "GET") {
        if (db.noInteractions) return send(404, { error: "Not found" });
        return send(200, db.interactions[issue.id] ?? []);
      }
      if (rest === "/work-products") return send(200, db.workProducts[issue.id] ?? []);
      if (rest === "/diagnostics/wakes") {
        return send(200, { issue: { id: issue.id, identifier: issue.identifier, status: issue.status, title: issue.title }, diagnosis: null, events: db.wakes[issue.id] ?? [] });
      }
      if (rest === "/queued-comments" && req.method === "GET") {
        return send(200, db.queuedComments[issue.id] ?? { issueId: issue.id, queueId: null, state: null, targetRunId: null, revision: "r0", protocol: "legacy", entries: [] });
      }
      if (rest === "/queued-comments/interrupt" && req.method === "POST") {
        // Paperclip 2026.916.1: targetRunId is required but nullable; a stale revision is a 409.
        if (!body?.queueId || !body.revision || !("targetRunId" in body)) return send(400, { error: "Validation error" });
        const queue = db.queuedComments[issue.id];
        if (!queue || queue.queueId !== body.queueId) return send(409, { error: "The queued message is no longer pending" });
        if (queue.revision !== body.revision) return send(409, { error: "The queued messages changed in another session" });
        db.interrupts.push({ issueId: issue.id, body });
        return send(200, queue);
      }
      if (rest === "/recovery-actions/resolve" && req.method === "POST") {
        // Paperclip: the board's reconciliation of a held run releases the hold.
        const hold = issue.executionBlocker;
        const r = body?.executionReconciliation;
        if (!body?.outcome || !body.sourceIssueStatus || (r && (r.providerStopped !== true || !r.runId || (r.outcomeEvidence ?? "").length < 20))) {
          return send(400, { error: "Validation error" });
        }
        if (!hold || hold.recoveryActionId !== body.actionId || r?.runId !== hold.runId) return send(409, { error: "Recovery action is not active" });
        db.resolutions = [...(db.resolutions ?? []), { issueId: issue.id, body }];
        issue.executionBlocker = null;
        issue.status = body.sourceIssueStatus;
        return send(200, { issue, replayed: false });
      }
      if (rest === "/recovery-actions" && req.method === "GET") {
        const active = db.recoveryActions[issue.id] ?? null;
        return send(200, { active, actions: active ? [active] : [] });
      }
      if (rest === "/comments" && req.method === "GET") {
        // Newest first, like ?order=desc.
        const list = db.comments.filter((c) => c.issueId === issue.id).slice().reverse();
        return send(200, list.slice(0, Number(q.get("limit") ?? 50)));
      }
      if (rest === "/diagnostics/blockers") {
        return send(200, db.blockerDiagnostics[issue.id] ?? { readiness: null, blockers: [] });
      }
    }
    if (p === "/api/instance/settings/experimental" && req.method === "GET") {
      if (db.experimental === null) return send(404, { error: "Not found" });
      return send(200, db.experimental);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/execution-workspaces$/)) && req.method === "GET") {
      // Like Paperclip (services/execution-workspaces.ts list): status is a comma-separated filter.
      let list = db.executionWorkspaces.filter((w) => w.companyId === m[1]);
      if (q.get("status")) {
        const statuses = q.get("status").split(",");
        list = list.filter((w) => statuses.includes(w.status));
      }
      return send(200, list.map(({ readiness, closeFails, ...w }) => w));
    }
    if ((m = p.match(/^\/api\/execution-workspaces\/([^/]+)\/close-readiness$/)) && req.method === "GET") {
      const ws = db.executionWorkspaces.find((w) => w.id === m[1]);
      if (!ws) return send(404, { error: "Execution workspace not found" });
      // Like Paperclip's getCloseReadiness: open issues linked to it block the close.
      const linked = db.issues.filter((i) => i.executionWorkspaceId === ws.id);
      const open = linked.filter((i) => !["done", "cancelled"].includes(i.status));
      const r = {
        workspaceId: ws.id,
        deliveryState: "unknown",
        blockingReasons: open.length ? [open.length === 1 ? "This workspace is still linked to an open issue." : `This workspace is still linked to ${open.length} open issues.`] : [],
        warnings: [],
        linkedIssues: linked.map((i) => ({ id: i.id, identifier: i.identifier, status: i.status })),
        isSharedWorkspace: ws.mode === "shared_workspace",
        isProjectPrimaryWorkspace: false,
        ...ws.readiness,
        git: { baseRef: "master", hasDirtyTrackedFiles: false, hasUntrackedFiles: false, dirtyEntryCount: 0, untrackedEntryCount: 0, aheadCount: 0, behindCount: 0, isMergedIntoBase: true, createdByRuntime: true, ...ws.readiness?.git },
      };
      r.state = r.blockingReasons.length ? "blocked" : "ready";
      return send(200, r);
    }
    if ((m = p.match(/^\/api\/execution-workspaces\/([^/]+)$/)) && req.method === "PATCH") {
      const ws = db.executionWorkspaces.find((w) => w.id === m[1]);
      if (!ws) return send(404, { error: "Execution workspace not found" });
      // Like Paperclip's archive (archiveWorkspaceUnderLifecycleLock): a closed one,
      // archived or cleanup_failed, can't be closed again and answers 404.
      if (body.status === "archived" && ["archived", "cleanup_failed"].includes(ws.status)) {
        return send(404, { error: "Execution workspace not found" });
      }
      if (body.status === "archived") {
        const open = db.issues.filter((i) => i.executionWorkspaceId === ws.id && !["done", "cancelled"].includes(i.status));
        if (open.length) return send(409, { error: "This workspace is still linked to an open issue." });
        db.workspaceCloses.push(ws.id);
        ws.closedAt = new Date().toISOString();
        if (ws.closeFails) {
          ws.status = "cleanup_failed";
          ws.cleanupReason = ws.closeFails;
          db.workspaceOps[ws.id] = [
            { phase: "worktree_cleanup", status: "failed", exitCode: 128, startedAt: ws.closedAt, stderrExcerpt: `fatal: ${ws.closeFails}` },
          ];
        } else {
          ws.status = "archived";
        }
      }
      const { readiness, closeFails, ...rest } = ws;
      return send(200, rest);
    }
    if ((m = p.match(/^\/api\/execution-workspaces\/([^/]+)$/)) && req.method === "GET") {
      // Like Paperclip's assertWorkspacePrivacy: one the key may not read is a 404 too.
      const ws = db.executionWorkspaces.find((w) => w.id === m[1] && !w.private);
      return ws ? send(200, ws) : send(404, { error: "Execution workspace not found" });
    }
    if ((m = p.match(/^\/api\/execution-workspaces\/([^/]+)\/workspace-operations$/))) {
      return send(200, db.workspaceOps[m[1]] ?? []);
    }
    return send(404, { error: `fake: no route for ${req.method} ${p}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    db,
    requests,
    fail(method, path, status, { times = 1, body, hang = false } = {}) {
      failures.push({ method, path: path instanceof RegExp ? path : new RegExp(`^${path}$`), status, times, body, hang });
    },
    clearFailures() {
      failures.length = 0;
    },
    approve(challengeId) {
      const ch = db.challenges[challengeId];
      ch.status = "approved";
      db.tokens[ch.boardApiToken] = { userId: ids.user, keyId: `temp-${challengeId}` };
    },
    // A board key for the operator, as `login` would have saved.
    issueKey(name = "paperclip-helper", expiresAt = null) {
      const id = uuid();
      const token = `pcp_board_${crypto.randomBytes(24).toString("hex")}`;
      db.keys.push({ id, name, expiresAt, userId: ids.user, revokedAt: null });
      db.tokens[token] = { userId: ids.user, keyId: id };
      return token;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
