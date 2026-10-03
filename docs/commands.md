# The `pch` commands

`pch <command>` runs a throwaway container next to the service (`docker compose run --rm helper <command>`). The exception is `pch update`, which runs on the host, because the container can't pull its own image.

| Command | What it does |
|---|---|
| `pch status` | What the service is doing, its last checks and counts, and when the key expires. |
| `pch check [ISSUE]` | Who the key belongs to, its companies and prefixes. With an issue, its stage, current participant, and whether a merge would approve it. |
| `pch why ISSUE` | Paperclip's own diagnosis of why nobody is working on an issue: wakes, blockers, workspace clean-ups, runs and leases. |
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

## Debugging with an LLM

`pch why` is written to be pasted into an LLM chat. Run it on the stuck issue, paste the output, and ask what's wrong. The output lets the assistant tell a dropped wake from a dependency gate, a failed clean-up, or a run that never released execution:

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
