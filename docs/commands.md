# The `pch` commands

`pch <command>` runs a throwaway container next to the service (`docker compose run --rm helper <command>`). The exception is `pch update`, which runs on the host, because the container can't pull its own image.

| Command | What it does |
|---|---|
| `pch status` | What the service is doing, its last checks and counts, Paperclip's version and build commit, and when the key expires. |
| `pch check [ISSUE]` | Who the key belongs to, its companies and prefixes. With an issue, its stage, current participant, and whether a merge would approve it. With `RELAY_FIX_CONFLICTS` on, also whether the GitHub token (`GITHUB_TOKEN`, or the one in `GITHUB_TOKEN_FILE`) can read each repository. |
| `pch why ISSUE` | Why nobody is working on an issue, and what to do about it: Paperclip's own diagnosis (wakes, blockers, workspace clean-ups, runs and leases, recovery), then a recommendation. `--prompt` prints it all as a prompt for an LLM chat. |
| `pch blocked` | Why each blocked issue is blocked, which issues the chains of blocked issues end at and what those wait on, and every question card that is waiting. See [`blocked`](#blocked-what-the-blocked-issues-wait-on). |
| `pch approve ISSUE [comment]` | Approves an issue whose approval is waiting on you. It refuses otherwise. |
| `pch changes ISSUE comment` | Requests changes. The comment is required and becomes the brief. |
| `pch comment ISSUE text` | Comments as you, which wakes the assignee. |
| `pch answer ISSUE CARD text` | Answers a question card as you, as the card's form would: `CARD` is its id or the start of it. A card with one question only: an option whose label (or id) is the text, else the text as a typed answer when the question takes one. Without a matching card it lists the pending ones. Quote the text to keep its spacing exactly. |
| `pch release ISSUE [--apply] [--outcome=…]` | Releases an execution hold whose run can't prove it stopped, so messages and Interrupt stay saved behind it. It previews unless you pass `--apply`. See [`release`](#release-a-hold-messages-cant-clear). |
| `pch workspace ISSUE [--apply]` | Gives an issue linked to a closed workspace, or to another issue's live one, a new isolated workspace. It previews unless you pass `--apply`. See [`workspace`](#workspace-an-issue-linked-to-the-wrong-workspace). |
| `pch worktrees [--apply]` | Closes the execution workspaces of finished issues, so Paperclip removes their git worktrees from disk. It previews unless you pass `--apply`. See [`worktrees`](#worktrees-finished-issues-worktrees-still-on-disk). |
| `pch usage [--days N] [--agent NAME]` | Where the tokens go: per agent, its runs, tokens, cost, model and effort, what woke it, and the agents worth a look (one that polls, one that keeps failing, one using most of its provider's tokens). Read-only. See [`usage`](#usage-where-the-tokens-go). |
| `pch costs` | Previews what cost sync would post, and what it does to budgets. |
| `pch costs --sessions` | Checks whether resumed sessions report cumulative costs (see [Compatibility](../README.md#compatibility)). |
| `pch models` | Every agent's adapter, model, effort and status. |
| `pch set-model FROM TO [--apply]` | Moves every agent on model `FROM` to `TO`. It previews unless you pass `--apply`. |
| `pch login`, `pch revoke` | Create the helper's key; revoke and delete it. |
| `pch secret` | Prints a random webhook secret. |
| `pch update` | Updates the helper to the latest release of its major version, and restarts it (see [Upgrading](install.md#upgrading)). It doesn't update Paperclip. |
| `pch version`, `pch help` | Version, and this list. |

## `blocked`: what the blocked issues wait on

A board full of blocked issues is hard to read in Paperclip. Most are blocked by other issues, which are blocked by others in turn, and the issue at the bottom of the chain is in review or in progress, so the list of blocked issues never leads you to it. Paperclip's **Decisions** page shows only reviews waiting on you, and no question card. `pch blocked` reads it all at once:

```text
$ pch blocked
ACM: 96 blocked issues
  95 wait on other open issues. Those chains end at 13 issues:
    ACM-479    in_review    Carla          holds 31  ← a question card to Gilfoyle, 30 h old, never delivered (routed to ACM-530)
    ACM-517    in_review                   holds 12  ← its approval is waiting on you (Decisions)
    ACM-284    in_review    Jian-Yang      holds 9   ← review by Jian-Yang
    …
  1 blocked by their agent with no blocking issue linked. These wait on someone, often you:
    ACM-490    Carla          "Which signing certificate should the installer use?"
    `pch why ISSUE` for each, then answer in a comment.

  8 question cards addressed to an agent that isn't the issue's assignee. Paperclip never wakes that agent for them:
    ACM-413    Carla → Gilfoyle         2 days   routed to ACM-529
      DIR-413 is implemented at 299bc3fbc (PR #130), but verification is red. Please route…
    …
```

- **Waiting on other open issues:** each chain is followed to the issues that aren't blocked themselves. `holds` counts the blocked issues waiting on each one, directly or not, and the arrow says what that issue waits on: a question card and who it's for, your approval, a reviewer, or a run.
- **Every blocker done, a failed workspace clean-up, parked by recovery, held for reconciliation:** the watchdog's cases, listed with what happens next.
- **Blocked by the agent with no blocking issue linked:** the agent's own note, usually a question. These are the ones most likely waiting on you.
- **Question cards addressed to an agent that isn't the assignee:** Paperclip cancels the wake such a card sends, so nobody sees it ([the watchdog, 10](watchdog.md#10-question-cards-addressed-to-a-teammate)). Each line says whether the watchdog has routed it, and to which issue.
- **Other question cards:** for you, a board user, a person, or anyone.

It reads only, and looks at every open issue's cards, so on a large company it takes a few seconds.

## `usage`: where the tokens go

When a subscription runs out sooner than it should, the question is which agent spent it, and on what. `pch usage` reads each agent's runs over the last 7 days (`--days N`), or one agent's (`--agent NAME`), and changes nothing:

```text
Usage over the last 7 days

Agent  Runs  Failed  Input  Cached  Output      Cost  Model              Effort
Carla   100       0  10.0M  100.0M    500k  $1234.56  claude-opus-4-7    high
Cody     10       6   406k    4.0M     20k         -  gpt-5.4            medium
Rex      10       0   200k    2.0M     20k         -  claude-sonnet-4-6  -

What woke them:
  Carla: issue_commented 50 (50%), issue_monitor_due 40 (40%), issue_blockers_resolved 10 (10%)
  Cody: issue_commented 6 (60%), issue_assigned 4 (40%)
  Rex: execution_review_requested 10 (100%)

Worth a look:
  - Carla polls: 40% of its runs (40 of 100) were its own monitor's wakes. Tell it to name the run it waits on and end its run; the watchdog wakes it when the run finishes.
  - Cody: 60% of its runs failed (6 of 10). Its runs' errors say why; `pch why` helps on one of its issues.
```

- **Runs and tokens** come from each agent's finished runs (`GET /api/companies/:id/heartbeat-runs?agentId=…`, its latest 1000; the report says when that cut the window short). Input is fresh input, cached input its own column, as Paperclip records them; for Codex, whose input included its cache hits on Paperclip releases before late October 2026, the cached part is taken out of the input.
- **Cost** is what Paperclip records per agent for the period (`/costs/by-agent`): $0 for subscription runs unless [cost sync](cost-sync.md) posts their API-equivalent cost. If Paperclip won't give the costs, the report says so.
- **What woke them** is each run's wake reason: `issue_monitor_due` (its own Paperclip monitor), `issue_commented`, `issue_blockers_resolved`, `interaction_pending`, an assignment, a timer, and so on.
- **Worth a look:** more than 25% of an agent's runs are monitor wakes (it polls: rely on the [watchdog's CI report](watchdog.md#11-ci-runs-an-agent-waits-on) instead); more than 20% of its runs failed (at least 5); or it used far more than an even share of its provider's tokens (Anthropic for Claude agents, OpenAI for Codex): more than 30%, and more than twice an even share (so with two or three agents on a provider, one being busier isn't flagged).

## `set-model`: every model and effort level

`set-model` changes only `adapterConfig.model`, because Paperclip merges the change into the existing config, so effort, engine and env are kept. It re-reads each agent afterwards and flags anything that went missing.

```text
$ pch set-model claude-opus-5 claude-opus-5.5
would change Architect: claude-opus-5 → claude-opus-5.5 (effort xhigh kept)
would change Reviewer: claude-opus-5 → claude-opus-5.5 (effort high kept)

2 agent(s). Run again with --apply to change them.
```

## `why`: what is holding an issue, and what to do

`pch why ISSUE` prints Paperclip's own diagnostics for the issue, the latest comment, and then a recommendation:

```text
$ pch why ACM-109
ACM-109: blocked — User detection on Linux and macOS
Blocker diagnosis: ACM-109 is blocked but has no first-class blocker relations.
Blockers: none linked; dependency ready: yes
Assignee: Gilfoyle
Latest runs:
  2026-10-01T12:47:48.260Z  Gilfoyle  succeeded
Recovery: stranded_assigned_issue, waiting on board since 2026-10-03T13:24:38.581Z
  Next action: Board operator: inspect the evidence, repair the runtime if appropriate, then explicitly retry the original owner, reassign, or intentionally resolve the task.
Last comment: you: ACM-111 is done, but its workspace clean-up (workspace_finalize) failed, so …

Recommendation: Paperclip's recovery parked this issue for a board decision: it couldn't run Gilfoyle when it looked (the agent was paused, or the issue had just changed hands). Gilfoyle is available now.
  1. pch comment ACM-109 "Gilfoyle, please continue this issue."
  2. A plain comment is the decision Paperclip is waiting for: it moves the issue out of blocked and wakes the agent.
  The watchdog does this by itself once the issue has been quiet for 180s. Do it by hand only if you don't want to wait.
```

The recommendation names what is going on, gives the steps as commands you can paste, and says whether [the watchdog](watchdog.md) does it by itself or leaves it to you. It covers, in this order:

- an assignee that is paused, terminated or awaiting approval;
- a run that is working, about to start, or has sat queued for more than ten minutes;
- a review or approval waiting on you;
- a link to a closed workspace, which fails every run at setup;
- an execution hold, and an issue Paperclip's recovery parked;
- saved messages waiting behind an earlier run;
- a question card the asker waits on: one Paperclip never delivered to the teammate it's addressed to (with the issue the watchdog routed it to), or one for you;
- a blocked issue: waiting on open blockers, on a workspace clean-up, with every blocker done, blocked by an agent over another issue's workspace or with a note of its own, or an agent re-running every few minutes while it waits on you;
- a dropped hand-off, runs Paperclip refused before they started, a failed run, and a run that finished without moving the issue on.

It is a set of rules over what Paperclip reports, not a judgement: it quotes the agent's last note where the answer is in there, and it can be wrong about a case nobody has met yet.

## `release`: a hold messages can't clear

Paperclip holds an issue (`legacy_execution_requires_reconciliation`) when a run stopped without proof of what it did. Before it starts anything new it wants proof that the run's process is gone: a recorded process id it can check, or a stop record. A run cut off at a hand-off can have neither. Then every message, Interrupt and comment is saved with "The previous run has no verified stop record", and nothing releases it.

`pch release ISSUE` shows the hold, the held run (status, process, lease) and the saved messages, and changes nothing. `--apply` records the board's reconciliation (`POST /api/issues/:id/recovery-actions/resolve`): the run has stopped, and what it did is unverified (`--outcome=mixed`, the default; or `completed`, `not_performed`). Paperclip moves the issue to `todo`, and the command then delivers the saved messages, as Interrupt does.

It refuses while the run is still active, its environment lease is unreleased, or its process is alive on the helper's host. Since nobody verified what the run did, have the agent check the branch before it builds on it.

The [watchdog](watchdog.md#7-holds-paperclip-can-never-release-by-itself) does this by itself for a hold whose run recorded no process at all (`WATCHDOG_RELEASE_HOLDS`). Use the command for a hold it leaves to you, or to release one without waiting.

## `workspace`: an issue linked to the wrong workspace

When an agent creates an issue from another issue's work (a follow-up, a sub-issue, an issue its run creates), Paperclip links the new issue to that issue's execution workspace (`reuse_existing`), and every run on it asks for that one workspace. No project or instance setting turns this off. It goes wrong in two ways:

- **The workspace is closed.** Paperclip closes an issue's isolated workspace when the issue finishes, but leaves the links on other issues. Every run on them then fails before the agent starts: `setup_failed`, "Issue … requested inherited execution workspace reuse for …, but the workspace could not be restored". Retry and comments fail the same way.
- **The workspace belongs to another issue that is still open.** The new issue's commits land on that issue's branch. An agent that notices blocks the issue and asks for a "workspace ruling".

`pch workspace ISSUE` shows the link: whose workspace, its status and branch. For a closed one it also lists the other open issues still linked to it. `--apply` makes the same change as **New isolated workspace** in the issue's Workspace picker: the link is cleared, and the next run gets a new worktree. Unlike the picker, it keeps the issue's other workspace settings, such as a pinned branch or its environment. With a closed workspace, every open issue linked to it is changed; with a live one, only the issue you named, because a live workspace may be shared on purpose. Nothing is posted and no status changes. The command prints the comment that tells the assignee to carry on.

```text
$ pch workspace ACM-416
ACM-416: blocked — Intermittent: SelfTest on elevated Windows
Workspace: reuses ACM-318's workspace 0b4a273f (archived 2026-10-16T06:36:12.000Z, branch ACM-318-recovery): every run fails at setup
Also linked to it: ACM-415 (in_review)

--apply gives these 2 issues a new isolated workspace on the next run,
like "New isolated workspace" in the issue's Workspace picker. Its other workspace settings (a pinned branch, the environment) are kept.
The closed workspace and its branch are left as they are.
  pch workspace ACM-416 --apply
```

It leaves alone an issue with a run queued or running, an issue that is done or cancelled, and an issue with a workspace change already scheduled for its next run. On a Paperclip whose issues don't carry a copy of their workspace, it won't act on a workspace it can't read: "not found" there can also mean your key may not read it.

Paperclip only accepts this change while **Instance settings → Experimental → Enable Isolated Workspaces** is on. While it's off, the Workspace picker is hidden and Paperclip drops the change without an error. The command checks the setting first and reads each issue back afterwards, so it says so instead of reporting a change that didn't happen.

[The watchdog](watchdog.md#8-issues-linked-to-a-closed-workspace) clears links to a closed workspace by itself (`WATCHDOG_CLEAR_DEAD_LINKS`). Use the command for a link to another issue's live workspace, or to clear one without waiting.

`pch why` recommends this command when the issue is linked to a closed workspace, or when its assignee's last run failed restoring one. It also recommends it when an agent has blocked the issue with a note about its workspace or branch while it is linked to another issue's live workspace.

## `worktrees`: finished issues' worktrees still on disk

Each issue with an isolated workspace gets its own git worktree, and every one carries its own build output: a few hundred MB each for a .NET or Node project, more for one that builds a desktop app. Paperclip removes a worktree when its workspace is closed. Its reaper closes the workspaces of finished issues by itself, but only when all of these hold:

- the issue, and every issue under it, is done or cancelled;
- the worktree has no uncommitted changes, untracked files included;
- Paperclip can prove the branch was delivered: a merged PR it can read through its own GitHub connection, or the branch's commits on the base branch. A squash merge leaves different commits on the base branch, so it proves nothing without the PR;
- the issue finished at least `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` ago (7 by default).

Miss any one and the worktree stays. On a busy instance they pile up into hundreds of worktrees and tens of GB, inside a WSL or VM disk that doesn't shrink by itself.

`pch worktrees` lists the open workspaces of issues finished at least a day ago (`--min-days=N` to change that), with what Paperclip's own close check (`close-readiness`) says about each:

```text
$ pch worktrees
ACM: 231 open workspaces, 162 of them worktrees of issues finished 1+ days ago
  Paperclip can close 171 and remove their worktrees:
    ACM-296    done       14d  ACM-296-fody-weavers-compile-assets-only
    ACM-326    cancelled  13d  ACM-326-regenerate-wirecontract
    …
  4 may hold work that isn't on GitHub. Look at these yourself:
    ACM-51     done       14d  2 modified tracked files  ACM-51-module-settings-one-credential-key-rule
    ACM-241    done       11d  2 commits not on master  ACM-241-protected-build-renames-nothing
    …
  Paperclip won't close 23:
    ACM-305    done        6d  This workspace is still linked to an open issue.  ACM-305-…
  Left alone: 31 of open issues, 2 of issues finished in the last day.

--apply closes these 171 workspaces, as their Close button does: …
  pch worktrees --apply
```

`--apply` closes the first group one at a time, as the workspace's **Close** button does (`PATCH /api/execution-workspaces/:id` with `status: "archived"`). Paperclip stops the workspace's runtime services, runs the project's clean-up and teardown commands, removes the worktree (`git worktree remove --force`, so untracked build output goes with it) and deletes the branch it created if that branch is merged. The issue, its history and the branch on GitHub stay. When a clean-up fails, the command prints the end of its output. A workspace whose clean-up failed earlier (`cleanup_failed`) counts as closed in Paperclip and can't be closed again, so the command only lists it with its folder: if the folder is still there, remove it with `git worktree remove --force <folder>` from the project's checkout.

What it leaves alone:

- **Workspaces of open issues**, and of issues finished less than `--min-days` ago (default 1), in case one is reopened.
- **Modified tracked files.** Always: commit or discard them yourself.
- **Untracked files** (anything git doesn't ignore: scratch clones, new files nobody committed) unless you pass `--include-untracked`. Ignored build output (`bin/`, `obj/`, `node_modules/`) doesn't count.
- **Commits not on the base branch** unless you pass `--include-unmerged`. A squash-merged branch always looks like this, because the merge puts new commits on the base branch. With `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE` set ("Pull requests: Read"), the command asks GitHub for the branch's PR: a merged PR with at least as many commits as the worktree is ahead holds all of them, so that worktree is closed ("PR #41 merged"). More commits than the PR had means some were made after it, and the worktree is left for you. The repository is the workspace's `repoUrl`, or each of `GITHUB_REPOS`.
- **Sessions on the project's shared checkout** (`shared_workspace`). They're only counted: closing one removes a record and frees nothing.
- **What Paperclip refuses**: a workspace another open issue is still linked to, or one whose git state it can't read (its folder may already be gone).
- **An issue a run still holds.**

The helper changes nothing on disk itself; Paperclip does the removal and records each step in the workspace's operations. To have Paperclip's reaper keep up by itself, shorten its cooldown with `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` in Paperclip's environment. Reclaiming the freed space from a WSL or VM disk is a separate step (on WSL: `fstrim`, then compact the `.vhdx`).

## Debugging with an LLM

For those cases, `pch why ISSUE --prompt` prints the same diagnostics, the recommendation and the issue's last three comments as one prompt, ready to paste into an LLM chat. The plain output works too: it lets an assistant tell a dropped wake from a dependency gate, a failed clean-up, or a run that never released execution:

```text
$ pch why ACM-8
ACM-8: in_review — Add retry to the uploader
Diagnosis: The most recent wake for ACM-8 is deferred for issue_commented.
Blockers: all done; dependency ready: yes
Latest wake requests:
  2026-09-30T21:52:24.371Z  issue_assigned  → completed
  2026-09-30T21:52:26.611Z  missing_issue_comment  → cancelled (failed)
  2026-09-30T21:52:54.458Z  issue_commented  → deferred_issue_execution
Latest runs:
  2026-09-30T21:52:24.371Z  Engineer  succeeded  lease released
  2026-09-30T21:52:26.611Z  Engineer  cancelled (issue_reassigned)  lease expired
```

For a blocker stuck in finalization, `why` also lists the last workspace operations, with the error output of the one that failed.

---

[← Back to the README](../README.md)
