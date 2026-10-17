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
| `pch release ISSUE [--apply] [--outcome=…]` | Releases an execution hold whose run can't prove it stopped, so messages and Interrupt stay saved behind it. It previews unless you pass `--apply`. See [`release`](#release-a-hold-messages-cant-clear). |
| `pch workspace ISSUE [--apply]` | Gives an issue linked to a closed workspace, or to another issue's live one, a new isolated workspace. It previews unless you pass `--apply`. See [`workspace`](#workspace-an-issue-linked-to-the-wrong-workspace). |
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
