import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { createLogger } from "../src/log.mjs";
import { listIssues } from "../src/paperclip.mjs";

test("a refused hostname explains the allowed-hostname fix", async (t) => {
  const env = await setup({ allowedHosts: ["localhost"] });
  t.after(env.close);
  await assert.rejects(env.ctx.api.request("GET", "/api/cli-auth/me"), (err) => {
    assert.equal(err.code, "hostname_guard");
    assert.match(err.message, /allowed-hostname 127\.0\.0\.1/);
    assert.match(err.message, /PAPERCLIP_ALLOWED_HOSTNAMES/);
    return true;
  });
});

test("a rejected key says to log in again", async (t) => {
  const env = await setup();
  t.after(env.close);
  await assert.rejects(env.ctx.api.request("GET", "/api/cli-auth/me", undefined, { token: "pcp_board_nope" }), (err) => {
    assert.equal(err.code, "unauthorized");
    assert.match(err.message, /pch login/);
    return true;
  });
});

test("GETs are retried once on a 5xx; POSTs are not", async (t) => {
  const env = await setup();
  t.after(env.close);
  env.fake.fail("GET", "/api/cli-auth/me", 502);
  const me = await env.ctx.api.request("GET", "/api/cli-auth/me");
  assert.equal(me.userId, ids.user);

  env.db.issues.push({ id: uuid(), identifier: "ACM-1", companyId: ids.company, status: "todo" });
  env.fake.fail("POST", "/api/issues/ACM-1/comments", 500);
  await assert.rejects(env.ctx.api.request("POST", "/api/issues/ACM-1/comments", { body: "hi" }), /500/);
  assert.equal(env.db.comments.length, 0);
  const posts = env.fake.requests.filter((r) => r.method === "POST" && r.path === "/api/issues/ACM-1/comments");
  assert.equal(posts.length, 1);
});

test("requests time out", async (t) => {
  const env = await setup({ env: { PAPERCLIP_TIMEOUT_SEC: "1" } });
  t.after(env.close);
  env.fake.fail("POST", "/api/issues/x/comments", 0, { hang: true });
  await assert.rejects(env.ctx.api.request("POST", "/api/issues/x/comments", { body: "x" }), (err) => {
    assert.equal(err.code, "timeout");
    assert.equal(err.neverSent, false);
    return true;
  });
});

test("an unreachable Paperclip is a clear error", async (t) => {
  const env = await setup({ env: { PAPERCLIP_API: "http://127.0.0.1:59999" } });
  t.after(env.close);
  await assert.rejects(env.ctx.api.request("GET", "/api/cli-auth/me"), (err) => {
    assert.equal(err.code, "network");
    assert.match(err.message, /cannot reach Paperclip at http:\/\/127\.0\.0\.1:59999/);
    return true;
  });
});

test("issue lists are read page by page", async (t) => {
  const env = await setup();
  t.after(env.close);
  for (let i = 0; i < 7; i++) env.db.issues.push({ id: uuid(), identifier: `ACM-${i}`, companyId: ids.company, status: "todo" });
  env.db.issues.push({ id: uuid(), identifier: "ACM-99", companyId: ids.company, status: "done" });
  const list = await listIssues(env.ctx.api, ids.company, "todo,in_progress", { pageSize: 3 });
  assert.equal(list.length, 7);
  const pages = env.fake.requests.filter((r) => r.path.startsWith(`/api/companies/${ids.company}/issues`));
  assert.equal(pages.length, 3);
  assert.match(pages[1].path, /afterId=/);
});

test("a token in the query string never reaches an error message or a log line", async (t) => {
  const env = await setup();
  t.after(env.close);
  env.fake.fail("GET", "/api/cli-auth/challenges/c1", 500, { times: 2 });
  await assert.rejects(env.ctx.api.request("GET", "/api/cli-auth/challenges/c1?token=secret-poll-token", undefined, { token: "" }), (err) => {
    assert.doesNotMatch(err.message, /secret-poll-token/);
    assert.match(err.message, /\?token=\*\*\*/);
    assert.doesNotMatch(err.path, /secret-poll-token/);
    return true;
  });

  const down = await setup({ env: { PAPERCLIP_API: "http://127.0.0.1:59999" } });
  t.after(down.close);
  await assert.rejects(down.ctx.api.request("GET", "/api/x?token=secret-poll-token", undefined, { token: "" }), (err) => {
    assert.doesNotMatch(err.message, /secret-poll-token/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(down.logs), /secret-poll-token/);
});

test("logs never contain keys or secrets", () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  log("x", { token: "pcp_board_0123456789abcdef0123", secret: "hunter2", note: "key pcp_board_0123456789abcdef0123 leaked" });
  assert.doesNotMatch(lines[0], /0123456789abcdef|hunter2/);
});
