# The watchdog: wake stalled work

Every `WATCHDOG_INTERVAL_SEC`, for every company your key can see, the watchdog looks for seven situations Paperclip doesn't recover from by itself. Most of them start the same way: an issue changes hands, and Paperclip cancels a run at that moment.

| In Paperclip you see… | The watchdog… |
|---|---|
| An issue assigned to an agent that **never starts**, after a hand-off. | Comments on it, which wakes the new owner. |
| A **blocked** issue whose blockers are all **done**. | Comments on it, which moves it to `todo` and wakes the owner. |
| A blocked issue whose only blocker is done but **"finalizing"** forever. | Removes that blocker, moves the issue to `todo` and explains why. |
| **"Waiting for execution recovery. Your message is saved."** | Presses Paperclip's **send queued messages now** for it. |
| **"Automatic recovery blocked"**, board decision required, after a hand-off. | Delivers the saved messages to the current owner, as **Interrupt** does. |
| **"Automatic recovery blocked … the original assignee is not invokable"**, after you paused and resumed an agent. | Comments on the issue once the agent is back, which un-parks it and wakes the agent. |
| **"Automatic recovery of this task stopped"**, with every message saved behind "The previous run has no verified stop record". | Releases the hold, as `pch release --apply` does, and delivers the saved messages. |

## 1. Dropped hand-offs

Applies to issues in `todo`, `in_progress` and `in_review`. When an issue changes hands, for example engineer → reviewer, Paperclip cancels the finishing run. That run still holds its environment lease for a minute or two. The new owner's wake is refused ("has not released its environment lease") and nothing retries it: [paperclipai/paperclip#13880](https://github.com/paperclipai/paperclip/pull/13880).

The watchdog looks for an issue where all of these hold:

- An agent owns it, and nothing is running or checked out on it.
- The latest run that did any work belongs to someone else and ended at least `WATCHDOG_STALL_SEC` ago.
- The owner isn't paused, terminated or waiting for approval.
- Paperclip has no wake queued for the owner.

It then comments on the issue, which wakes the assignee. While a task is paused, Paperclip refuses comments, so the watchdog waits until it's resumed.

Three things look like "the owner is on it" and aren't, so the watchdog ignores them:

- **Another agent's wake.** Paperclip lists every agent's wakes on the issue. A wake deferred for the previous owner, or for an agent someone mentioned, says nothing about the current one.
- **A wake that runs have overtaken.** A wake deferred before a later run was created and finished is never promoted.
- **A run refused before it started.** After a hand-off Paperclip can hold the issue for reconciliation and cancel the owner's runs on arrival (`execution_reconciliation_required`), skipping their wakes. The chat shows "Waiting to resume". The hold clears on its own, but nothing wakes the owner again. The watchdog nudges once the hold is gone, and waits while it's still in place.

## 2. Blocked issues whose blockers are all done

Paperclip should wake the assignee with `issue_blockers_resolved`, but that wake can be dropped the same way. Once the issue has been quiet for the stall window, it gets the same kind of comment. A comment on a blocked issue whose blockers are done also moves it back to `todo`; this was verified against Paperclip 2026.916.1.

## 3. Done blockers whose workspace clean-up failed

If a run is cancelled while syncing its workspace back, Paperclip records the `workspace_finalize` as failed and never retries it. It then counts that done blocker as unresolved forever, and skips every wake for the dependent issue. With `WATCHDOG_HEAL_FAILED_FINALIZE` on, the watchdog does the following once the failure is older than the stall window:

- It removes those blockers from the dependent's **Blocked by**.
- If nothing else blocks the dependent, it moves it to `todo`.
- It comments to explain why, and tells the agent to pull the branch first.

It waits while the dependent's assignee is paused, terminated or awaiting approval. Moving an issue to `todo` for an agent Paperclip can't invoke makes Paperclip's recovery block it again, this time for a board decision.

## 4. Wakes deferred behind a stopped run

Paperclip sometimes defers even the nudge's wake, because an earlier run still holds execution. A comment can't help: its wake is deferred too. The watchdog logs one warning instead of repeating itself, and `pch status` counts the issue.

With `WATCHDOG_RETRY_DEFERRED` on, the watchdog also presses Paperclip's own **send queued messages now** for that issue. Paperclip then retries the stopped run's lease clean-up once and re-sends the saved comments. The watchdog does this only when the deferred wake carries saved comments and targets no running run, so it never interrupts work. A lease that was never released, or an old process that's still alive, needs a manual look.

## 5. Recovery holds left by a hand-off

Paperclip's recovery can give up on a run that was cancelled when the issue changed hands. The issue then shows "Automatic recovery blocked" with "Board decision required", is marked blocked with no blocker linked, and its saved messages wait. With `WATCHDOG_RETRY_DEFERRED` on, the watchdog releases that hold the way the board's **Interrupt** button does: it delivers the saved messages to the current owner.

- It only does this when the held run was cancelled by a reassignment, and no run is active on the issue.
- It waits while the owner is paused, terminated or awaiting approval.
- A hold with any other cause means Paperclip is unsure what the run did. The watchdog logs it once and leaves the decision to you.

Pressing **Interrupt** by hand releases such a hold on Paperclip 2026.916.1. The watchdog's own press, in 4 and 5, has been checked against Paperclip's source and the test suite, not yet against a live instance.

## 6. Issues parked because the assignee couldn't be run

Paperclip's recovery sweep looks for assigned issues that nothing is working on. When it finds one whose agent it can't invoke, it gives up: it records a recovery action for the board (`stranded_assigned_issue`), marks the issue blocked with no blocker linked, and shows "Automatic recovery blocked: the original assignee is not invokable". The usual cause is that you paused the agent, for a migration or an upgrade, and the sweep ran before you resumed it. A run cut off by a hand-off can strand an issue the same way.

Nothing un-parks the issue when the agent comes back. A comment from a board user is the decision Paperclip is waiting for: it moves the issue out of blocked and wakes the assignee. So once the agent is available and the issue has been quiet for the stall window, the watchdog:

- delivers the issue's saved messages, if it has any (with `WATCHDOG_RETRY_DEFERRED` on), as in 5;
- otherwise posts a nudge that says why the issue was parked.

It waits while the agent is paused, terminated or awaiting approval, and while any run is active on the issue. A recovery action of any other kind, such as a stalled review, asks for a judgement about who continues. The watchdog logs it once and leaves it to you; `pch why ISSUE` prints the kind, Paperclip's next action, and a recommendation.

A comment clearing a parked issue was verified by hand on Paperclip 2026.916.1.

## 7. Holds Paperclip can never release by itself

Before Paperclip starts anything new on an issue held for reconciliation (`legacy_execution_requires_reconciliation`), it wants proof that the held run's process is gone: a process id or group it can check, or a stop record. A run cut off at a hand-off, or one whose adapter failed before a process started, records neither. Paperclip then saves every message, Interrupt and comment behind the hold for good. Waiting changes nothing, and nor does pressing Interrupt.

With `WATCHDOG_RELEASE_HOLDS` on, the watchdog releases such a hold the way `pch release ISSUE --apply` does: it records the board's reconciliation (the run has stopped; what it did is unverified) and delivers the saved messages. If there are none, it comments instead, which wakes the owner. Either way the agent is told, or Paperclip's own continuation tells it, that the stopped run may have done part of its work, so it checks the workspace and branch first.

- It acts only on that cause, and only when the held run recorded no process id or group. A run with a recorded process is Paperclip's to check, and its hold clears once the process is gone.
- It waits until the run has been over for the stall window, and while the owner is paused, terminated or awaiting approval.
- It leaves the hold alone, and logs it once, while the run is still active, its environment lease is unreleased, or another run on the issue is active.
- It releases each held run once. A hold that comes back for the same run is logged once and left to you.

This was verified against Paperclip 2026.916.1, 2026.1001.0 and 2026.1005.0 by the compatibility suite, which reproduces the hold with an agent whose command doesn't exist.

## Limits

Each nudge mentions the assignee and says what stalled. Each situation gets at most `WATCHDOG_MAX_NUDGES` comments or presses, spaced by the stall window. The counts are kept in `data/state.json`, so a restart doesn't repeat them.

## What it leaves to you

These look similar in Paperclip, and `pch why ISSUE` tells them apart:

- **An agent waiting on you.** An issue an agent blocked with a note of its own, such as a pending approval or a missing permission, has no blocker linked. Paperclip can keep waking the agent, which re-checks and stops again, a run each time. Decide the approval, or pause the issue.
- **A recovery hold or recovery action of another kind,** such as a stalled review. A message from you to the agent is the board decision Paperclip is waiting for.
- **A run that stays queued.** The watchdog sees a queued run as work on its way, and doesn't check how long it has waited.

## Watchdog settings

| Setting | Default | Meaning |
|---|---|---|
| `WATCHDOG` | `true` | `false` turns it off. |
| `WATCHDOG_INTERVAL_SEC` | `60` | How often it checks (at least 15). |
| `WATCHDOG_STALL_SEC` | `180` | How long an issue must be quiet before it acts. |
| `WATCHDOG_MAX_NUDGES` | `2` | Comments per stalled situation, and retries per deferred wake. |
| `WATCHDOG_HEAL_FAILED_FINALIZE` | `true` | Repair blockers stuck on a failed clean-up. This edits the issue's **Blocked by**. |
| `WATCHDOG_RETRY_DEFERRED` | `true` | Ask Paperclip to retry a wake deferred behind a stopped run, and release a hand-off's recovery hold (4 and 5 above). |
| `WATCHDOG_RELEASE_HOLDS` | `true` | Release a hold Paperclip can never release by itself, once its run has been over for the stall window (7 above). |


---

[← Back to the README](../README.md)
