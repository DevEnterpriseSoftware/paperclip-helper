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
    heartbeatRuns: [], // { id, companyId, agentId, status, finishedAt, usageJson, contextSnapshot, createdAt, resultJson }
    runEvents: {}, // runId → [{ seq, eventType, payload }], oldest first
    costEvents: [],
    activity: [],
    budgets: { policies: [] },
  };
}

const GUARD =
  "This hostname is not allowed for this Paperclip instance. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";

export async function startFake({ db = emptyDb(), allowedHosts = null } = {}) {
  const requests = [];
  const failures = []; // { method, path (regex), status, body, times, hang }

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
      if (q.get("sortField") === "id") list = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (q.get("afterId")) list = list.filter((i) => i.id > q.get("afterId"));
      const limit = Math.min(Number(q.get("limit") ?? 500), 1000);
      // Like Paperclip, list rows don't carry the execution state.
      return send(200, list.slice(0, limit).map((i) => ({ ...i, executionState: null })));
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/heartbeat-runs$/))) {
      const limit = Math.min(Number(q.get("limit") ?? 1000), 1000);
      const list = db.heartbeatRuns
        .filter((r) => r.companyId === m[1])
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
      return send(200, list);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/cost-events$/)) && req.method === "POST") {
      if (!body.agentId || !body.provider || !body.model || !Number.isInteger(body.costCents)) {
        return send(400, { error: "Validation error" });
      }
      if (body.issueId && !db.issues.some((i) => i.id === body.issueId)) return send(422, { error: "Issue not found" });
      const event = { id: uuid(), companyId: m[1], ...body };
      db.costEvents.push(event);
      db.activity.push({ action: "cost.reported", actorType: "user", actorId: who.userId, entityType: "cost_event", entityId: event.id });
      return send(201, event);
    }
    if ((m = p.match(/^\/api\/companies\/([^/]+)\/activity$/))) {
      const type = q.get("entityType");
      return send(200, db.activity.filter((a) => !type || a.entityType === type));
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
      if (rest === "" && req.method === "GET") return send(200, issue);
      if (rest === "" && req.method === "PATCH") {
        if (body.comment && issue.paused) return send(409, { error: "Task is paused. Resume it before sending a message." });
        db.patches.push({ issueId: issue.id, identifier: issue.identifier, body });
        if (body.status === "done" && issue.nextStages?.length && issue.executionState?.status === "pending") {
          // Like Paperclip's applyIssueExecutionStageTransition: approving a stage
          // that isn't the last moves the issue to the next stage, still in review.
          const next = issue.nextStages.shift();
          issue.executionState = { status: "pending", currentStageType: next.type, currentParticipant: next.participant };
          issue.status = "in_review";
        } else if (body.status) issue.status = body.status;
        if (body.blockedByIssueIds) issue.blockedBy = body.blockedByIssueIds.map((id) => ({ id }));
        if (body.comment) db.comments.push({ issueId: issue.id, identifier: issue.identifier, body: body.comment, via: "patch" });
        issue.updatedAt = new Date().toISOString();
        return send(200, issue);
      }
      if (rest === "/comments" && req.method === "POST") {
        // Paperclip's assertBoardCommentNotPaused: a paused task tree refuses board comments.
        if (issue.paused) return send(409, { error: "Task is paused. Resume it before sending a message." });
        db.comments.push({ issueId: issue.id, identifier: issue.identifier, body: body.body, via: "comment" });
        issue.updatedAt = new Date().toISOString();
        return send(201, { id: uuid(), body: body.body });
      }
      if (rest === "/runs") return send(200, db.issueRuns[issue.id] ?? []);
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
