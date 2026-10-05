# The `pch` commands

`pch <command>` runs a throwaway container next to the service (`docker compose run --rm helper <command>`). The exception is `pch update`, which runs on the host, because the container can't pull its own image.

| Command | What it does |
|---|---|
| `pch status` | What the service is doing, its last checks and counts, and when the key expires. |
| `pch check [ISSUE]` | Who the key belongs to, its companies and prefixes. With an issue, its stage, current participant, and whether a merge would approve it. With `RELAY_FIX_CONFLICTS` on, also whether `GITHUB_TOKEN` can read each repository. |
| `pch why ISSUE` | Why nobody is working on an issue, and what to do about it: Paperclip's own diagnosis (wakes, blockers, workspace clean-ups, runs and leases, recovery), then a recommendation. `--prompt` prints it all as a prompt for an LLM chat. |
| `pch approve ISSUE [comment]` | Approves an issue whose approval is waiting on you. It refuses otherwise. |
| `pch changes ISSUE comment` | Requests changes. The comment is required and becomes the brief. |
| `pch comment ISSUE text` | Comments as you, which wakes the assignee. |
| `pch costs` | Previews what cost sync would post, and what it does to budgets. |
| `pch costs --sessions` | Checks whether resumed sessions report cumulative costs (see [Compatibility](../README.md#compatibility)). |
| `pch models` | Every agent's adapter, model, effort and status. |
| `pch set-model FROM TO [--apply]` | Moves every agent on model `FROM` to `TO`. It previews unless you pass `--apply`. |
| `pch login`, `pch revoke` | Create the helper's key; revoke and delete it. |
| `pch secret` | Prints a random webhook secret. |
| `pch update` | Updates the helper to the latest release of its major version, and restarts it (see [Upgrading](install.md#upgrading)). It doesn't update Paperclip. |
| `pch version`, `pch help` | Version, and this list. |

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
- an execution hold, and an issue Paperclip's recovery parked;
- saved messages waiting behind an earlier run;
- a blocked issue: waiting on open blockers, on a workspace clean-up, with every blocker done, blocked by an agent's own note, or an agent re-running every few minutes while it waits on you;
- a dropped hand-off, runs Paperclip refused before they started, a failed run, and a run that finished without moving the issue on.

It is a set of rules over what Paperclip reports, not a judgement: it quotes the agent's last note where the answer is in there, and it can be wrong about a case nobody has met yet.

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
