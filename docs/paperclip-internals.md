# Paperclip internals the helper depends on

Paperclip's API is large and mostly undocumented. Everything below was read in Paperclip's source. Facts marked **(live)** were also checked against a running Paperclip 2026.916.1 (commit `d554c47`, `ghcr.io/paperclipai/paperclip:2026.916.1`).

**Source references:**

- Paths are at commit `53aad90` (2026-09-28) unless marked otherwise. **(2026.916.1)** marks facts read at the release tag `v2026.916.1` (`d554c47`).
- `main` was at `5edf55d` on 2026-09-30.
- The production release `2026.916.1` is not an ancestor of `53aad90`. Differences that matter are called out.

**When Paperclip is upgraded,** run `npm run test:compat -- <version>` first. It boots that Paperclip from npm and runs the helper's own code against it: every endpoint below, the response fields the helper reads, and the watchdog, relay and commands end to end (see [test/compat](../test/compat/compat.test.mjs)). Then a quick run of `pch check`, `pch why` and `pch costs` on your own instance covers what a throwaway instance can't reproduce: real lease refusals, failed workspace clean-ups and subscription runs.

**Checked releases:** 2026.916.1 and 2026.1001.0 pass the compatibility suite. 2026.1001.0 changed the comment queue in one way that touches the helper (paperclipai/paperclip#13539): a queue can now hold a saved answer or approval instead of comments, and `queued-comments/interrupt` also accepts such a queue when its response needs a fresh session. The watchdog's request and the fields it reads are unchanged.

## Authentication: the board key

### Logging in

1. `POST /api/cli-auth/challenges` with no auth and body `{ command, clientName, requestedAccess: "board" }` (`server/src/routes/access.ts`).
   - It returns `{ id, token, boardApiToken, approvalPath, approvalUrl, pollPath, expiresAt, suggestedPollIntervalMs }`.
   - The challenge lives 10 minutes.
2. The user opens `approvalPath` on Paperclip's public URL, signed in, and approves.
   - `approvalUrl` is built from the request's Host (and may be null), so the helper rebuilds it from `PAPERCLIP_PUBLIC_URL`.
   - In `local_trusted` mode no sign-in is needed. (live)
3. Poll `GET /api<pollPath>?token=<token>` until `status` is `approved`.
   - Statuses: `pending`, `approved`, `cancelled`, `expired`.
   - An approved challenge reports `expired` after 10 minutes, but its key stays valid.
   - **The token is accepted only as that query parameter** (`req.query.token`, `server/src/routes/access.ts`). It's the same secret as in `approvalPath`, and it isn't single-use (`server/src/services/board-auth.ts`). So the helper masks `token=` in every error message and log line. (2026.916.1)

### Keys

- **The challenge's `boardApiToken` expires 30 days after approval, and use doesn't extend it** (`BOARD_API_KEY_TTL_MS`, `server/src/services/board-auth.ts`). The helper therefore swaps it for a named key.
- **`POST /api/board-api-keys` with `{ name, expiresAt }`** creates a named key. `expiresAt: null` means it never expires, and omitting it means 30 days. The response carries the `token`. (live)
- **`POST /api/cli-auth/revoke-current`** with the key revokes the key itself.
- **`GET /api/board-api-keys`** lists the caller's active keys, with `id`, `name`, `expiresAt` and `lastUsedAt`. There's no "current" flag: match the `keyId` from `/api/cli-auth/me`. (live)
- **Expired or revoked keys get 401 on every route,** including `/api/health`. Probes must send no token.

### Identity

`GET /api/cli-auth/me` returns `{ userId, user, companyIds, memberships, isInstanceAdmin, source, keyId }`. The helper works across every company in `companyIds`.

## Deployment modes and the hostname guard

- **Modes:**
  - `authenticated`, with exposure `private` or `public`;
  - `local_trusted`, which is loopback-only: the server refuses to bind anything else.
- **In `local_trusted`:**
  - A request with **no** token acts as the `local-board` user.
  - A request **with** a board key works exactly as in `authenticated` mode.
  - The helper works unchanged. (live)
- **The private-hostname guard** (`server/src/middleware/private-hostname-guard.ts`):
  - **When it's on:** in `authenticated` + `private`, and always in `local_trusted`.
  - **Always allowed:** `localhost`, `127.0.0.1`, `::1`, the bind host, and the hostname of the public URL.
  - **Everything else** is refused with 403 `{"error":"This hostname is not allowed for this Paperclip instance. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>."}`. That includes `/api/health`. (live)
  - **Allowed hostnames** come from `PAPERCLIP_ALLOWED_HOSTNAMES`, a comma list that **replaces** the config file's `server.allowedHostnames`. `npx paperclipai allowed-hostname <host>` adds to the config file, and Paperclip must then be restarted.
  - **The guard reads `X-Forwarded-Host` first,** unconditionally. The helper doesn't exploit that.
- **`GET /api/health`** needs no auth. Anonymous callers get `status`, `deploymentMode`, `deploymentExposure`, `bootstrapStatus` and `commit`. `version` appears only in `local_trusted` mode or for signed-in callers.

## Issues

- **Issue routes accept identifiers** (`ACM-6`, case-insensitive) as well as UUIDs, through `router.param`.
- **Identifiers are `<issuePrefix>-<number>`.** `GET /api/companies/:id` returns the company row, whose `issuePrefix` is non-null and unique in the instance (`packages/db/src/schema/companies.ts`, `server/src/services/issues.ts`). On a cloud-managed instance, renaming a company can change it. (2026.916.1)
- **Fields the watchdog reads** are on `GET /api/issues/:id` and on list rows alike (`issueListSelect`, `server/src/services/issues.ts`): `assigneeAgentId`, `checkoutRunId`, `executionRunId`, `executionWorkspaceId` and `updatedAt`. (2026.916.1)
- **`GET /api/companies/:id/issues`:**
  - **Status:** `status` takes a comma list.
  - **Paging:** default limit 500, maximum 1000 (larger values are clamped). The only stable paging is keyset: `sortField=id&sortDir=asc&afterId=<uuid>`. The response is a bare array; stop when a page is short.
  - **Throttle:** at most 8 of these requests in flight per actor, otherwise 429.
  - **List rows carry `executionState: null`, even when the issue has a pending stage.** Read the issue itself (`GET /api/issues/:id`) to see its stage. (live)
  - **`parentId=<uuid>`** lists subtasks.
- **`GET /api/issues/:id/runs`** returns every run on the issue, newest first. Its key is `runId`, not `id`. Each run includes `environmentLease { status, releasedAt, cleanupStatus, … }` and `errorCode`.
- **Diagnostics:**
  - **`GET /api/issues/:id/diagnostics/wakes`** returns `{ issue, diagnosis, likelyReason, events[] }`, **newest first**.
    - Each event's `kind` is `wake_request` (`projectIssueWakeRequest`, `server/src/routes/issues.ts`) or `activity`. (2026.916.1)
    - **The list covers every agent's wakes for the issue,** not just the assignee's. Each wake request's `agentId` says whose it is; it and `runId` are null for a reader without company scope. (2026.916.1)
    - Wake-request events have `status`: one of `queued`, `deferred_issue_execution`, `claimed`, `coalesced`, `skipped`, `completed`, `failed`, `cancelled`. Unknown statuses read `other`.
    - `reason` is shown only for known reasons, and is `other` otherwise.
    - **It holds at most 50 wake requests from the last 14 days** (`server/src/services/issues.ts`). A wake deferred for longer drops out, and the watchdog then treats the issue as having no pending wake. (2026.916.1)
  - **`GET /api/issues/:id/diagnostics/blockers`** returns `{ diagnosis, readiness: { allBlockersDone, isDependencyReady, unresolvedBlockerCount, pendingFinalizeBlockerCount } | null, blockers[] }`. Each blocker has `isPendingFinalize`.
- **`GET /api/execution-workspaces/:id/workspace-operations`** returns operations with `phase`, `status` (`running`/`succeeded`/`failed`/`skipped`), `stdoutExcerpt`, `stderrExcerpt` and `metadata`.

## Review and approval decisions

The rule lives in `server/src/services/issue-execution-policy.ts`:

- **Only the current participant can decide.** The participant of a pending review or approval stage records a decision with `PATCH /api/issues/:id { status, comment }`, **status and comment in the same request**. (live)
  - **`done` approves.** The comment is required.
  - **`in_progress` requests changes.** The comment is required, and the issue returns to the stage's `returnAssignee`. (live)
  - **Prior comments don't count.**
- **Anyone else who moves the issue decides nothing.** A board user who is *not* the participant and moves it out of `in_review` just clears the execution state: no approval is recorded, and nothing returns to the engineer. That's why the helper checks `approvalWaitingOn` first.
- **"Waiting on me"** means all three of these:
  - `status === "in_review"`;
  - `executionState.status === "pending"`;
  - `executionState.currentParticipant` is `{ type: "user", userId: me }`.
- **Formal approvals are something else.** The Dashboard's "Pending Approvals" and the Approvals page list formal *approval requests*, such as hires and budget overrides. The experimental **Decisions** page lists reviews waiting on a user.

## Comments and wakes

- **Mentions:** only the markdown link `[@Name](agent://<agentId>)` is a mention; a plain `@Name` isn't.
  - At `53aad90` and in 2026.916.1, a mention wakes that agent.
  - **On `main` after 2026-09-29 (#14577), mentions no longer wake anyone.**
- **`POST /api/issues/:id/comments { body }`** accepts identifiers.
  - **A board user's comment wakes the issue's assignee** unless the issue is `done` or `cancelled` (`services/issue-comment-wakeup.ts`). The watchdog relies on this.
  - **It sets the issue's `updatedAt`** (`addComment`, `server/src/services/issues.ts`). The watchdog spaces its nudges by its own record anyway. (2026.916.1)
- **A paused task refuses board comments.** While the issue's task tree has an active pause hold, a comment, or a PATCH that carries one, gets 409 `Task is paused. Resume it before sending a message.` (`assertBoardCommentNotPaused`, `server/src/routes/issues.ts`). The watchdog postpones its nudge or repair; a relay delivery fails, and GitHub's **Redeliver** retries it once the task is resumed. (2026.916.1)
- **A comment on a `blocked` issue:**
  - With **no unresolved blockers**, it moves the issue to `todo` and wakes the assignee (`issue_reopened_via_comment`). (live)
  - With **unresolved blockers**, it still wakes the assignee in a bounded "interaction" mode, and the issue stays blocked.
- **Deferred wakes:** a wake that arrives while an earlier run still "owns execution" is stored as `deferred_issue_execution` (`getConversationOwnershipBlocker`, `server/src/services/conversation-continuation.ts`).
  - **What "owns execution" means:** a cancelled or failed run whose process may still be alive, or whose environment lease is unreleased, pending clean-up, or failed clean-up.
  - **Only one sweep resumes these wakes,** and it needs a board recovery action. So a wake deferred behind a stuck run waits indefinitely. (live: a hand-off to a paused agent, then a nudge, stayed deferred)
  - **The board action that retries one** (read in 2026.916.1 source; `WATCHDOG_RETRY_DEFERRED` uses it):
    - `GET /api/issues/:id/queued-comments` returns `{ queueId, state, targetRunId, revision, protocol, entries[], executionWait? }`. A queue exists only when a `deferred_issue_execution` or `queued` wake for the assignee carries saved comment ids: `state` is `deferred` or `queued` respectively (`findQueuedCommentWake`, `server/src/routes/issues.ts`). `targetRunId` is set only when the queue is deferred **and** a run on the issue is `running` (`resolveActiveIssueRun`; `server/src/services/issue-queued-comment-queue.ts`), so a null `targetRunId` means the interrupt cancels nothing. (2026.916.1)
    - `POST /api/issues/:id/queued-comments/interrupt` with `{ queueId, revision, targetRunId }` (`targetRunId` required, nullable) is the UI's "send queued messages now". Board user only; legacy protocol only (from 2026.1001.0 also a saved answer or approval that needs a fresh session); a stale `revision` is 409.
    - If `targetRunId` is a running run, it is **cancelled**. Otherwise `resumeQueuedCommentInterrupt(…, { retryCleanup: true })` gives the blocking run's `pending_cleanup` leases one cleanup attempt past the sweep's cap (`sweepPendingCleanupLeases({ explicitRetry })`, `services/heartbeat.ts`), then re-enqueues the comments as `issue_commented`, which still passes every admission gate.
    - It doesn't help a lease that was never released (`releasedAt` null, not `pending_cleanup`) or a process that is still alive: the new wake is deferred again.
    - The route still exists on `main` at `467125f` (2026-09-30).
- **Recovery actions** (live, 2026.916.1): Paperclip's recovery sweep parks an assigned issue it can't make progress on by recording a row in `issue_recovery_actions` and moving the issue to `blocked`, with no blocker relation.
  - `GET /api/issues/:id/recovery-actions` returns `{ active, actions }`. `active` has `id`, `kind`, `cause`, `status`, `ownerType`, `nextAction`, `evidence { latestRunId, latestRunStatus, previousStatus, … }`, `wakePolicy` and `createdAt`.
  - `kind: "stranded_assigned_issue"` with `ownerType: "board"` is "Automatic recovery blocked … the original assignee is not invokable": the assignee, or an agent above it, was paused, terminated or awaiting approval when the sweep ran (`evaluateAgentInvokability`, `services/agent-invokability.ts`).
  - **It is not an execution hold.** The issue's `executionBlocker` stays null, and new runs are admitted. A board user's comment moves the issue out of `blocked` and wakes the assignee. (live: `pch comment` started a run within 20 seconds)
  - `GET /api/issues/:id/comments?order=desc&limit=N` lists comments newest first, with `body`, `authorAgentId`, `authorUserId` and `createdAt`.
- **The hand-off bug** ([#13880](https://github.com/paperclipai/paperclip/pull/13880), related [#13769](https://github.com/paperclipai/paperclip/pull/13769); both still open on 2026-09-30):
  - An issue changing hands cancels the finishing run (`issue_reassigned`).
  - That run keeps its environment lease for a minute or two.
  - The new owner's wake is refused and never retried.
- **Failed finalize:** a done blocker counts as resolved only when the latest operation on its execution workspace is a successful `workspace_finalize` (`listPendingFinalizeBlockerIssueIds`, `server/src/services/issues.ts`). A later successful finalize on the same workspace also clears it.
- **Editing blockers:**
  - `PATCH /api/issues/:id { blockedByIssueIds, status, comment }` works in one request. `blockedByIssueIds` must be UUIDs.
  - The current blockers come from `blockedBy[].id` on `GET /api/issues/:id`.
  - Moving an issue *into* `blocked` requires unresolved blockers (422 otherwise).

## Linking PRs to issues (external objects)

- **What the rows are.** An issue's "GitHub Pull Request" rows are *external objects*, not work products.
- **Where they come from.** They're detected from full `github.com/<owner>/<repo>/pull/<n>` URLs in the issue's title, description, comments and documents (`server/src/services/external-objects.ts`, `github-external-object-provider.ts`). A URL quoted from elsewhere is linked just the same.
- **What reads them.** `GET /api/issues/:id/external-objects` lists them.
- **Only with the experimental setting on.** Detection and listing are off unless **Instance settings → Experimental → External Objects** (`enableExternalObjects`) is on. With it off, the list is always empty. (live)
- **PR work products are separate.** `GET /api/issues/:id/work-products` returns a bare array (`server/src/services/work-products.ts`). A PR's has `type: "pull_request"`, `url`, a free-text `externalId`, and `metadata.repo` (`owner/repo`) with `metadata.number`. (2026.916.1)
  - **Paperclip never creates them by itself.** Agents do, because its bundled skill tells them to (`skills/paperclip/SKILL.md`), with no convention for `externalId`.
  - **So the relay matches a work product to a PR** by its URL, or by repository and number, and never by a bare number, which could belong to any repository.

## Agents

- **`PATCH /api/agents/:id { adapterConfig: { model } }` merges** into the existing `adapterConfig` at the top level. A nested object you send, such as `env`, replaces the stored one. `replaceAdapterConfig: true` replaces the whole config. (live)
- **`POST /api/agents/:id/pause`** and **`/resume`** pause and resume an agent.
- **`GET /api/companies/:id/agents`** returns a bare array with `status`, `adapterType` and `adapterConfig` (`env` redacted for board callers). Any query parameter is a 400. (2026.916.1)
  - **It leaves out terminated agents** (`server/src/services/agents.ts`). `GET /api/agents/:id` returns any agent, so cost sync falls back to it for runs by an agent that has since been terminated.
- **Agent statuses** are `active`, `paused`, `idle`, `running`, `error`, `pending_approval` and `terminated` (`packages/shared/src/constants.ts`). Paperclip never invokes a `paused`, `terminated` or `pending_approval` agent (`packages/shared/src/agent-eligibility.ts`), so the watchdog doesn't nudge their issues. (2026.916.1)

## Costs

- **The ledger's billing types** are `metered_api`, `subscription_included`, `subscription_overage`, `credits`, `fixed` and `unknown`.
- **Adapters report billing as `api` or `subscription`,** which are normalized to `metered_api` and `subscription_included` (`normalizeLedgerBillingType`).
- **How adapters decide:**
  - **`claude_local`** reports `api` when `ANTHROPIC_API_KEY` is set, `metered_api` for Bedrock, and `subscription` otherwise.
  - **`codex_local`** reports `api` when `OPENAI_API_KEY` is set, and `subscription` otherwise. `CODEX_API_KEY` alone, or a key stored by `codex login --with-api-key`, is misread as a subscription.
- **Paperclip zeroes subscription costs on purpose.** Its own cost event for a run has `costCents = 0` exactly when the billing type is `subscription_included` (`normalizeBilledCostCents`, heartbeat service). API-key runs keep their real cost.
  - **So filtering on `usageJson.billingType === "subscription_included"` can never double-count Paperclip's own cents.**
- **What a run's `usageJson` carries:** `inputTokens`, `cachedInputTokens`, `outputTokens`, `provider`, `biller`, `model` (`"unknown"` when not recorded), `costUsd`, `cacheAdjustedCostUsd` (equal to `costUsd`), `billingType`, `persistedSessionId` and `sessionReused`.
  - **Claude Code:** `costUsd` is its `total_cost_usd`, which is per run (see below). The ACP engine (the default) computes a per-run delta from the cumulative session cost.
  - **Codex:** `costUsd` is always null, so its runs are recorded `unpriced` with `costCents 0`, whether billed to an API key or a subscription.
    - Its tokens are OpenAI-style: cached input is part of input, and reasoning tokens are part of output.
    - `model` is the configured `adapterConfig.model`, or `"unknown"` for the default model.
    - **Fast mode** (`adapterConfig.fastMode`, twice the price) isn't in `usageJson`, but each run records whether it was applied. (2026.916.1)
      - **ACP engine:** `resultJson.fastMode`, a boolean (`packages/adapter-utils/src/acpx-engine/execute.ts`). The company runs list trims `resultJson`, so it's read with `GET /api/heartbeat-runs/:id`.
      - **CLI engine:** the run's `adapter.invoke` event has `-c service_tier="fast"` in `payload.commandArgs` only when fast mode was applied (`packages/adapters/codex-local/src/server/codex-args.ts`). The CLI ignores the setting for models it knows don't support it, and says so in `payload.commandNotes`. `GET /api/heartbeat-runs/:id/events` returns `{ seq, eventType, payload, … }` oldest first, 200 by default; each attempt logs its own `adapter.invoke`.
      - Without either record (including a 404 from an older Paperclip), cost sync falls back to the agent's current setting. If Paperclip doesn't answer, the run waits for the next pass.
    - **On the CLI engine, every run is a fresh Codex thread in its own Codex home.** That home lives inside the run's workspace on the execution host (`…/.paperclip-runtime/runs/<run>/workspace/.paperclip-runtime/codex/home`). So `sessionIdBefore` is always empty and nothing is resumed or accumulated.
    - **Paperclip's figures match Codex's own logs.** On 2026.916.1, Paperclip's input, cached and output tokens equalled the `total_token_usage` in Codex's own rollout logs exactly. (live)
    - **Stopped runs record no usage.** A run cancelled mid-way has `usageJson: null`, although Codex did spend tokens.
    - **A cheap model costs a fraction of a cent per run.** A `gpt-6-luna` run typically costs a fraction of a cent, and Paperclip stores whole cents. (live)
- **`GET /api/companies/:id/heartbeat-runs?limit=N`:**
  - `limit` is clamped to 1000. **With `limit` omitted, it returns every run.**
  - It is ordered by `createdAt` descending, with no paging.
  - `summary=true` nulls `usageJson`.
- **When a run is finished:** terminal statuses are `succeeded`, `failed`, `cancelled`, `timed_out` and `interrupted`. In rare paths `usageJson` is written just after the status turns terminal, so the helper waits `COST_SYNC_SETTLE_SEC` after `finishedAt`.
  - **The active statuses** are `queued`, `scheduled_retry` and `running` (`packages/shared/src/constants.ts`; Paperclip's own sets are in `server/src/services/heartbeat.ts`). The watchdog's `ACTIVE_RUN` and cost sync's `TERMINAL_RUN` match them. (2026.916.1)
- **A run's `contextSnapshot.issueId`** is the issue its wake was for (`enrichWakeContextSnapshot`, `server/src/services/heartbeat.ts`); timer runs have none. Cost sync puts it on the event when it's a UUID. (2026.916.1)
- **`POST /api/companies/:id/cost-events`:**
  - **Body:** `agentId`, `provider` and `model` are required. `costCents` is an integer ≥ 0, and `occurredAt` is an ISO datetime. `heartbeatRunId` and `issueId` are optional UUIDs, and `billingType` and `costStatus` are enums. (live)
  - **Who may post:** a board key may post for any agent in the company.
  - **What `createEvent` does:** it does **not** zero subscription events. It recomputes the agent's and company's monthly spend, and evaluates budgets. **A hard-stop budget can pause the agent, the company or the project and cancel its work.**
  - **Budget windows** are calendar months (UTC) for companies and agents, and lifetime for projects. An event lands in a month by its `occurredAt`.
- **Cost events can't be deleted, and can't be listed per run.** There's no DELETE route. There's also no listing API with `heartbeatRunId`: only aggregates. A client's own records are the only protection against double posting.
  - **What the activity log shows:** each post writes `cost.reported` with the actor, readable at `GET /api/companies/:id/activity?entityType=cost_event`. (live)
- **Costs page aggregation:**
  - Run counts use `count(distinct heartbeatRunId)` per billing type, so an extra zero-token event with the same run id and billing type doesn't change them.
  - Project attribution joins on `heartbeatRunId`.
  - An event without `issueId` doesn't appear in issue cost summaries.
- **`GET /api/companies/:id/budgets/overview`** returns `policies[]` with `scopeType`, `scopeId`, `scopeName` (the company, agent or project name), `metric` (always `billed_cents`), `windowKind`, `amount`, `observedAmount`, `hardStopEnabled`, `isActive`, `windowStart` and `windowEnd` (`server/src/services/budgets.ts`). (2026.916.1)
  - `observedAmount` sums `costCents` of every billing type, so synced events count.
  - Project budgets match only an event's `projectId`, which `POST /cost-events` doesn't derive from `issueId`. So synced events never count toward a project budget.

- **Resumed sessions report per-run cost.** A resumed run gets a new session id, and its `sessionIdBefore` is the previous run's `sessionIdAfter`. On 2026.916.1 (`claude_local`, CLI engine), resumed runs often cost less than the run they resumed, which a cumulative figure can't do. `pch costs --sessions` runs this check.

## Compatibility notes

- **Mentions:** on Paperclip's `main`, an `@mention` in a comment no longer wakes the mentioned agent. The watchdog doesn't depend on it, because a board user's comment wakes the issue's assignee, which is who it nudges.
- **After paperclipai/paperclip#13880 ships:** the watchdog's hand-off check should find nothing to do, and can stay on or be turned off. The other checks cover separate gaps.
- **Resumed sessions:** Claude Code's reported cost is per run, not cumulative for a resumed session, so nothing is counted twice. `pch costs --sessions` checks this on your own runs.
- **Codex:** on Paperclip's CLI engine every Codex run is a fresh thread, and Paperclip's token counts match Codex's own logs. Codex on the ACP engine hasn't been checked.

## Unverified

- **Codex on the ACP engine,** or any setup that resumes Codex threads. The CLI engine never resumes (above). If a thread were resumed, it's unknown whether `turn.completed` reports that turn's tokens or the thread's running total. `pch costs --sessions` shows resumed pairs if they ever occur.
- **Whether codex-acp reports a cost.** If it does, it's used as reported.
