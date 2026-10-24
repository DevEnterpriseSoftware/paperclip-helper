// Watchdog 19 (WATCHDOG_REPORT_READY_TO_MERGE) and `pch ready`: PRs ready to queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOutput, minutesAgo, setup } from "./helpers.mjs";
import { ids, uuid } from "./fake-paperclip.mjs";
import { pull, startFakeGitHub } from "./fake-github.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { earlierStagesDone, queueOrder } from "../src/ready.mjs";
import * as cmd from "../src/commands.mjs";

const REPO = "org/app";

async function env(t, extra = {}) {
  const gh = await startFakeGitHub();
  t.after(gh.close);
  const e = await setup({ env: { WATCHDOG_STALL_SEC: "180", GITHUB_TOKEN: gh.token, GITHUB_API: gh.url, GITHUB_REPOS: REPO, WATCHDOG_REPORT_READY_TO_MERGE: "true", ...extra } });
  t.after(e.close);
  gh.pulls[REPO] = [];
  const reviewer = { id: uuid(), companyId: ids.company, name: "Gilfoyle", status: "idle", adapterType: "claude_local" };
  const engineer = { id: uuid(), companyId: ids.company, name: "Dinesh", status: "paused", adapterType: "claude_local" };
  e.db.agents.push(reviewer, engineer);
  return { ...e, gh, reviewer, engineer, watchdog: createWatchdog(e.ctx, e.state) };
}

let n = 700;
// An issue the reviewer approved, now at the board's approval stage, with its PR as a work product.
function atApproval(e, { number, mergeable_state = "clean", draft = false, blockedBy = [], completed = true } = {}) {
  n += 1;
  const issue = {
    id: uuid(), identifier: `ACM-${n}`, companyId: ids.company, title: `Change ${number}`, status: "in_review", assigneeAgentId: null, assigneeUserId: ids.user,
    updatedAt: minutesAgo(30), blockedBy,
    executionPolicy: { stages: [{ id: "s-review", type: "review", participants: [{ type: "agent", agentId: e.reviewer.id }] }, { id: "s-approval", type: "approval", participants: [{ type: "user", userId: ids.user }] }] },
    executionState: {
      status: "pending", currentStageId: "s-approval", currentStageIndex: 1, currentStageType: "approval", currentParticipant: { type: "user", userId: ids.user },
      returnAssignee: { type: "agent", agentId: e.engineer.id }, completedStageIds: completed ? ["s-review"] : [],
    },
  };
  e.db.issues.push(issue);
  e.db.workProducts[issue.id] = [{ type: "pull_request", url: `https://github.com/${REPO}/pull/${number}` }];
  e.gh.pulls[REPO].push(pull(number, { mergeable_state, draft, head: { ref: `b-${number}`, sha: `sha-${number}` } }));
  return issue;
}

const commentsOn = (e, issue) => e.db.comments.filter((c) => c.issueId === issue.id);

test("a PR approved by every reviewer, clean and green: one note on its issue, naming the reviewer and whether it can be paused", async (t) => {
  const e = await env(t);
  const issue = atApproval(e, { number: 41 });
  await e.watchdog.tick();
  const [note] = commentsOn(e, issue);
  assert.equal(
    note.body,
    "PR #41 is approved by every reviewer, clean and green: ready to queue. Reviewed by Gilfoyle (no open issues: it can be paused again).\n\n" +
      "https://github.com/org/app/pull/41\n\n_Paperclip Helper watchdog._",
  );
  assert.equal(note.authorUserId, ids.user, "on the issue, which waits on a person: no agent woken");

  // Once per head commit.
  e.watchdog = createWatchdog(e.ctx, e.state);
  await e.watchdog.tick();
  assert.equal(commentsOn(e, issue).length, 1);
  e.gh.pulls[REPO][0].head.sha = "sha-41-b";
  e.watchdog = createWatchdog(e.ctx, e.state);
  await e.watchdog.tick();
  assert.equal(commentsOn(e, issue).length, 2, "a new head commit is new news");
});

test("not ready: a draft, a PR that isn't clean, an earlier stage not done; and off by default", async (t) => {
  const e = await env(t);
  const draft = atApproval(e, { number: 42, draft: true });
  const blocked = atApproval(e, { number: 43, mergeable_state: "blocked" });
  const unstable = atApproval(e, { number: 44, mergeable_state: "unstable" });
  const early = atApproval(e, { number: 45, completed: false });
  // Still with the reviewer: not the board's approval stage.
  const inReview = atApproval(e, { number: 46 });
  Object.assign(inReview, { assigneeAgentId: e.reviewer.id, assigneeUserId: null });
  inReview.executionState = { ...inReview.executionState, currentStageId: "s-review", currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: e.reviewer.id } };
  await e.watchdog.tick();
  for (const issue of [draft, blocked, unstable, early, inReview]) assert.equal(commentsOn(e, issue).length, 0, issue.identifier);

  const lines = (await captureOutput(() => cmd.ready(e.ctx))).join("\n");
  assert.match(lines, /Acme: no PR ready to queue/);
  assert.match(lines, /ACM-\d+: PR #42 is a draft/);
  assert.match(lines, /ACM-\d+: PR #43 is not clean \(blocked\)/);
  assert.match(lines, /ACM-\d+: PR #44 is not clean \(unstable\)/);

  const off = await env(t, { WATCHDOG_REPORT_READY_TO_MERGE: "" });
  const issue = atApproval(off, { number: 47 });
  await off.watchdog.tick();
  assert.equal(commentsOn(off, issue).length, 0, "off unless you turn it on");
});

test("pch ready lists the ready PRs in queue order: after their blockers, then the oldest PR first", async (t) => {
  const e = await env(t, { WATCHDOG_REPORT_READY_TO_MERGE: "false" });
  const first = atApproval(e, { number: 52 });
  const dependent = atApproval(e, { number: 50, blockedBy: [{ id: first.id }] });
  const other = atApproval(e, { number: 51 });
  // The reviewer still has another issue: it shouldn't be paused yet.
  e.db.issues.push({ id: uuid(), identifier: "ACM-799", companyId: ids.company, status: "todo", assigneeAgentId: e.reviewer.id, updatedAt: minutesAgo(5) });
  const lines = await captureOutput(() => cmd.ready(e.ctx));
  const order = lines.filter((l) => /^\s+\d\. /.test(l)).map((l) => l.match(/org\/app#(\d+)/)[1]);
  assert.deepEqual(order, ["51", "52", "50"]);
  assert.match(lines.join("\n"), /Acme: 3 PRs ready to queue, in queue order/);
  assert.match(lines.join("\n"), new RegExp(`org/app#51  ${other.identifier}  Change 51  \\(head sha-51\\)  reviewed by Gilfoyle`));
  assert.equal(e.db.comments.length, 0, "read-only");

  // The watchdog's note says where each PR is in that order, and that the reviewer still has work.
  const w = createWatchdog(e.makeCtx({ WATCHDOG_REPORT_READY_TO_MERGE: "true" }), e.state);
  await w.tick();
  const [note] = commentsOn(e, other);
  assert.match(note.body, /ready to queue \(1 of 3 in queue order; `pch ready` lists them\)\. Reviewed by Gilfoyle \(still has 1 open issue\)\./);
  assert.ok(commentsOn(e, dependent).length === 1);
});

test("earlierStagesDone and queueOrder", () => {
  const stages = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(earlierStagesDone({ executionPolicy: { stages }, executionState: { currentStageIndex: 2, completedStageIds: ["a", "b"] } }), true);
  assert.equal(earlierStagesDone({ executionPolicy: { stages }, executionState: { currentStageId: "c", completedStageIds: ["a"] } }), false);
  assert.equal(earlierStagesDone({ executionState: { currentStageIndex: 0 } }), true, "no stage list: nothing says otherwise");
  const r = (id, number, blockedBy = []) => ({ issue: { id, blockedBy }, pr: { repo: REPO, number } });
  assert.deepEqual(queueOrder([r("x", 3), r("y", 1, [{ id: "x" }]), r("z", 2)]).map((x) => x.issue.id), ["z", "x", "y"]);
  assert.deepEqual(queueOrder([r("a", 1, [{ id: "b" }]), r("b", 2, [{ id: "a" }])]).map((x) => x.issue.id), ["a", "b"], "a cycle: the oldest first");
});
