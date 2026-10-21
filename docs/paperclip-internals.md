# Paperclip internals the helper depends on

Paperclip's API is large and mostly undocumented. Everything below was read in Paperclip's source. Facts marked **(live)** were also checked against a running Paperclip 2026.916.1 (commit `d554c47`, `ghcr.io/paperclipai/paperclip:2026.916.1`).

**Source references:**

- Paths are at commit `53aad90` (2026-09-28) unless marked otherwise. **(2026.916.1)** marks facts read at the release tag `v2026.916.1` (`d554c47`).
- `main` was at `5edf55d` on 2026-09-30.
- The production release `2026.916.1` is not an ancestor of `53aad90`. Differences that matter are called out.

**When Paperclip is upgraded,** run `npm run test:compat -- <version>` first. It boots that Paperclip from npm and runs the helper's own code against it: every endpoint below, the response fields the helper reads, and the watchdog, relay and commands end to end (see [test/compat](../test/compat/compat.test.mjs)). Then a quick run of `pch check`, `pch why` and `pch costs` on your own instance covers what a throwaway instance can't reproduce: real lease refusals, failed workspace clean-ups and subscription runs.

**Checked releases:** 2026.916.1, 2026.1001.0, 2026.1005.0 and 2026.1012.0 pass the compatibility suite. 2026.1005.0 retries a run that ends without a disposition (no comment, no status change) about a minute later, as `scheduled_retry` with `scheduledRetryReason: "issue_disposition_repair"`, and after the retry parks the issue with a `deliberate_wait_without_target` recovery action. The helper already counts `scheduled_retry` as an active run, so the watchdog leaves such an issue alone. 2026.1001.0 changed the comment queue in one way that touches the helper (paperclipai/paperclip#13539): a queue can now hold a saved answer or approval instead of comments, and `queued-comments/interrupt` also accepts such a queue when its response needs a fresh session. The watchdog's request and the fields it reads are unchanged.

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
- **Workspace links (`pch workspace`, `pch why`):**
  - **Inherited on create.** A new issue with a source issue (`inheritExecutionWorkspaceFromIssueId`, else `parentId`) in the same project gets the source's `executionWorkspaceId`, `executionWorkspacePreference: "reuse_existing"`, and its settings. This happens unless the create body names a workspace field (`services/issues.ts` create). An agent's create with no workspace fields and no `parentId` inherits from the issue its run is on (`resolveRunIssueWorkspaceInheritanceSource`, `routes/issues.ts`). No project or instance setting turns this off. (main, 2026-10-16)
  - **Closing doesn't unlink.** Archiving a workspace clears `issues.executionWorkspaceId` only for `shared_workspace` mode (`routes/execution-workspaces.ts` PATCH). Issues linked to an isolated workspace keep the id and `reuse_existing`.
  - **A run on a linked issue whose workspace is archived or missing fails at setup.** There's no fallback to a fresh workspace: `errorCode` `setup_failed`, and the error begins "Issue <identifier> requested inherited execution workspace reuse for <workspace id>, but the workspace could not be restored" (`formatInheritedExecutionWorkspaceReuseFailure`, `services/heartbeat/workspaces.ts`). The issue's run list withholds the error text; `GET /api/heartbeat-runs/:id` has it.
  - **`GET /api/issues/:id`** carries `currentExecutionWorkspace` (`id`, `sourceIssueId`, `status`, `branchName`, `closedAt`, …), read without a privacy check; it is `null` when the row is gone, as heartbeat sees it. **`GET /api/execution-workspaces/:id`** returns the full row, but answers 404 both for a missing workspace and for one the caller may not read (`assertWorkspacePrivacy`), so a 404 there doesn't mean it's gone. `sourceIssueId` is the issue that owns the workspace. `status` is `active`, `idle`, `in_review`, `archived` or `cleanup_failed`; heartbeat treats only `archived` (or a missing row) as unavailable.
  - **Clearing a link** is the Workspace picker's "New isolated workspace": `PATCH /api/issues/:id` with `executionWorkspaceId: null`, `executionWorkspacePreference: "isolated_workspace"`, `executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: null }` (`buildWorkspaceSelectionUpdate`, `ui/src/lib/issue-workspace-selection.ts`). Nothing re-inherits on update. Update replaces `executionWorkspaceSettings` whole, so the helper sends the issue's current settings with the new mode, keeping a pinned branch (`workspaceStrategy.existingBranch`), `environmentId`, `networkEgress` and `workspaceRuntime`. The update also cancels a `workspacePendingSelection` (a change scheduled for the next run), so the helper leaves such issues alone. List rows carry `executionWorkspaceId` and `executionWorkspacePreference`, but `executionWorkspaceSettings` and `workspacePendingSelection` are `null` there.
  - **With `enableIsolatedWorkspaces` off** (`GET /api/instance/settings/experimental`, readable by any board user), create and update drop the three workspace fields without an error, and the UI hides the picker. Inheritance on create still happens.
  - **`GET /api/companies/:id/issues?executionWorkspaceId=<id>`** lists the issues linked to a workspace.
  - **An agent can't change its own issue's workspace during its run:** the update is refused with 409 "Task run still owns its workspace". It can schedule one instead: `PUT /api/issues/:id/workspace` with `{ selection, expectedBindingRevision, requestKey }`, scoped to the agent's current task. Paperclip stores it as `workspacePendingSelection` and applies it at the next normal admission (`selectTaskWorkspace`, `services/execution-workspaces.ts`; `routes/task-workspaces.ts`). Nothing starts that admission by itself.
  - **On create, naming `projectWorkspaceId` (or any execution workspace field) stops inheritance** from the parent or the run's issue. Unlike the execution workspace fields, `projectWorkspaceId` isn't dropped when isolated workspaces are off.
- **Closing workspaces (`pch worktrees`):**
  - **The terminal-workspace reaper** (`sweepTerminalWorkspaces`, `services/execution-workspaces.ts`, every 30 s, 50 rows a sweep) archives an open workspace only when its source issue and the whole issue tree under it are done or cancelled, the worktree is clean (untracked files count), the delivery state is `merged_via_pr` (a merged PR whose head ref and SHA match the worktree, read through Paperclip's own GitHub access) or `merged_by_ancestry`, no run is active, and the latest terminal timestamp is older than `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` (default 7; 0 turns the cooldown off). It removes the worktree **without** `--force`. Anything else is counted as skipped, and the server logs "terminal issue workspace reaper skipped all candidates" at most every 10 minutes. (2026.1012.0)
  - **`GET /api/companies/:id/execution-workspaces?status=a,b`** lists a company's workspaces; `status` is a comma-separated filter. Rows carry `sourceIssueId`, `status`, `branchName`, `cwd`, `providerType`, `closedAt`, `cleanupReason`; `deliveryState` is always `unknown` in the list.
  - **`GET /api/execution-workspaces/:id/close-readiness`** runs the close check: `{ state: ready|ready_with_warnings|blocked, blockingReasons[], warnings[], deliveryState, isSharedWorkspace, isProjectPrimaryWorkspace, linkedIssues[], plannedActions[], git: { baseRef, hasDirtyTrackedFiles, dirtyEntryCount, hasUntrackedFiles, untrackedEntryCount, aheadCount, behindCount, isMergedIntoBase, createdByRuntime } }`. It blocks only for an open issue linked to a non-shared workspace, or a git status it couldn't read; uncommitted and unmerged work are warnings. It inspects git and may resolve PRs, so it is slow on a big worktree.
  - **`PATCH /api/execution-workspaces/:id { status: "archived" }`** is the Close button. It refuses with 409 when close-readiness is blocked, then stops runtime services, runs cleanup and teardown commands, runs `git worktree remove --force` and `git branch -d` for a branch the runtime created, all before it answers. A clean-up that didn't finish leaves `status: "cleanup_failed"` with the warnings in `cleanupReason`; `cleanup_failed` counts as closed (`isClosedExecutionWorkspaceStatus`): closing it again, or an archived one, answers **404 "Execution workspace not found"** (`archiveWorkspaceUnderLifecycleLock` returns null), so nothing retries a failed clean-up. (2026.1012.0)
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
- **The review-round limit** (`resolveMaxReviewRounds`, `DEFAULT_MAX_REVIEW_ROUNDS = 3`; 2026.1012.0 and `main` at 8b873e0). An agent's changes-requested decision on a review stage counts a round (`executionState.changesRequestedCount`); approving the stage, or any person's decision, resets it. When an agent's request reaches `executionPolicy.maxReviewRounds` (1–50, default 3) and the issue has a responsible user (`responsibleUserId`, else `createdByUserId`), the stage stays **pending** with that person as `currentParticipant`, although they aren't one of the stage's participants, instead of returning to `returnAssignee`. Only that person can then move it ("Only the escalated reviewer can advance the current execution stage"). `lastDecisionOutcome` keeps the previous round's `changes_requested`. Watchdog 13 reads this.
- **While a stage waits on a person, the issue is assigned to that person** (`assigneeUserId`, `assigneeAgentId: null`; `patchForPrincipal`), and `returnAssignee` keeps the submitter. A board comment then wakes no agent, and an answered card wakes the assignee: the person. A changes-requested decision from the participant sets `assigneeAgentId` back to `returnAssignee`. A single PATCH that also names another assignee keeps `returnAssignee`; to hand the work to a different agent, decide first and reassign in a second PATCH. Watchdog 12 relies on this.
- **Changes requested at a later stage come back to that stage.** A resubmission after `changes_requested` resumes the stage that requested them (`existingState.status === "changes_requested" ? currentStage : nextPendingStage`), so work sent back from the board's approval stage (a merge-conflict send-back, say) returns straight to the board, without the earlier review stage.
- **Formal approvals are something else.** The Dashboard's "Pending Approvals" and the Approvals page list formal *approval requests*, such as hires and budget overrides. The experimental **Decisions** page lists reviews waiting on a user.

## Question cards (issue-thread interactions)

- **`GET /api/issues/:id/interactions`** lists an issue's cards, oldest first, with `id`, `kind` (`ask_user_questions`, `request_confirmation`, `request_checkbox_confirmation`, `request_item_verdicts`, `suggest_tasks`, `connection_intent`, …), `status` (`pending`, `answered`, `accepted`, `rejected`, `cancelled`, `expired`), `addresseeAgentId`, `addresseeUserId`, `createdByAgentId`, `effectiveResolverPolicy`, `payload` (questions under `payload.questions[].prompt`) and `createdAt`. There's no company-wide list. (live, 2026.1012.0)
- **A card addressed to an agent other than the assignee is never delivered.** Saving it wakes the addressee with `wakeReason: "interaction_pending"` (`routes/issues.ts`). At admission `decideQueuedRunStaleness` (`modules/run-dispatch/domain/policy.ts`) cancels the run as `issue_assignee_changed`, "Cancelled because issue assignee changed before the queued run could start", because the run's agent isn't the assignee and `interaction_pending` isn't one of the wake reasons a non-assignee may run on (`ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS`: comments and mentions only). The run has `startedAt: null`. Nothing retries it. (live, 2026.1012.0; same on `main` at f553471) Upstream: #11932, #13518, #16409; open fixes #11939, #14378, #15991. Related: #16563 (the addressee's wake prompt reads as an assignment).
- **Answered cards** carry `resolvedAt`, `resolvedByUserId` or `resolvedByAgentId`, and `result`: `answers[] { questionId, optionIds, otherText }` and `summaryMarkdown` for questions (options are `payload.questions[].options[] { id, label }`), `outcome`/`reason` for confirmations, `items[] { verdict, reason }` for verdicts. Statuses `answered`, `accepted` and `rejected` are a person's or agent's answer. (main, 2026-10-21)
- **Any run of the addressee can answer it,** on whatever issue the run is for: `POST /api/issues/:id/interactions/:interactionId/respond` (questions), `/accept`, `/reject`, `/verdicts`. The resolver check wants an authenticated run of that agent in the same company, not a run on the card's issue (`assertAgentInteractionRunAttribution`). Answering wakes the issue's assignee with the result. A board user can answer too.
- **`POST /api/companies/:id/issues`** with `{ title, description, assigneeAgentId, status: "todo", projectId, priority }` from a board key creates an issue and wakes its assignee. With no parent and no workspace field it inherits no execution workspace. (live, 2026.1012.0)

## Comments and wakes

- **Mentions:** only the markdown link `[@Name](agent://<agentId>)` is a mention; a plain `@Name` isn't.
  - At `53aad90` and in 2026.916.1, a mention wakes that agent.
  - **On `main` after 2026-09-29 (#14577), mentions no longer wake anyone.** A mention of an agent on an issue assigned to a person therefore wakes nothing; a decision (see above) is the only way to hand such an issue back.
- **`POST /api/issues/:id/comments { body }`** accepts identifiers.
  - **A board user's comment wakes the issue's assignee** unless the issue is `done` or `cancelled` (`services/issue-comment-wakeup.ts`). The watchdog relies on this.
  - **It sets the issue's `updatedAt`** (`addComment`, `server/src/services/issues.ts`). The watchdog spaces its nudges by its own record anyway. (2026.916.1)
- **A paused task refuses board comments.** While the issue's task tree has an active pause hold, a comment, or a PATCH that carries one, gets 409 `Task is paused. Resume it before sending a message.` (`assertBoardCommentNotPaused`, `server/src/routes/issues.ts`). The watchdog postpones its nudge or repair; a relay delivery fails, and GitHub's **Redeliver** retries it once the task is resumed. (2026.916.1)
- **A cancelled blocker never resolves its dependents.** Only `done` blockers count (`listDependencyReadiness`, "cancelled blockers stay unresolved until an operator removes or replaces the blocker relationship explicitly"); `GET /api/issues/:id/diagnostics/blockers` lists it with `status: "cancelled"` and the flag `cancelled_blocker_in_set`. Watchdog 14 reads this.
- **Monitors** (`executionPolicy.monitor`, state in `executionState.monitor`): `status` is `scheduled`, `triggered` or `cleared`, with `nextCheckAt`, `timeoutAt`, `maxAttempts`, `attemptCount`, `serviceName`, `notes` (up to 500 characters) and `clearReason` (`timeout_exceeded`, `max_attempts_exhausted`, …). `externalRef` is always redacted when read (`redactIssueMonitorExternalRef`), so the run a monitor watches is only readable from its notes. A monitor is allowed only on an agent-assigned issue in progress or in review. Watchdog 11 reads this.
- **Delegation cycles:** an agent may not create a child issue assigned to the agent that created a still-open ancestor (`assertNoAgentDelegationCycle`, 409 `delegation_cycle`). The agent is told to finish the work itself or escalate to the board, which is why such cards land with you; the helper leaves them to you.
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
- **Execution holds that need the board** (read in 2026.916.1, 2026.1001.0 and 2026.1005.0 source; `pch release` uses it):
  - `executionBlocker` on `GET /api/issues/:id` has `recoveryActionId`, `runId`, `agentId`, `cause`, `nextAction`, `canContinue`, `canRetry`, `savedMessageCount`, and `workspaceRepairRequired` when set (`server/src/services/execution-blocker.ts`).
  - Before a saved message starts a run, the held run must prove it stopped: a recorded `processPid` or `processGroupId` that is gone, or a native stop record (`explicit-native-continuation.ts`). A run with neither, e.g. one cut off at a hand-off, is refused with "The previous run has no verified stop record" (`process_identity_missing`) for good, whatever the board sends.
  - `POST /api/issues/:id/recovery-actions/resolve` with `{ actionId, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation: { runId, providerStopped: true, actionOutcome: "completed" | "not_performed" | "mixed", outcomeEvidence (20+ chars) } }` is the board's reconciliation. It also reopens an action automatic recovery already settled (`automaticRecovery.replay === "blocked"`), which is what releases the hold.
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
