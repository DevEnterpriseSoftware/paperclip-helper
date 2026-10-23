# The watchdog: wake stalled work

Every `WATCHDOG_INTERVAL_SEC`, for every company your key can see, the watchdog looks for seventeen situations Paperclip doesn't recover from by itself. Most of them start the same way: an issue changes hands, and Paperclip cancels a run at that moment. Four are about work that waits on something outside the agent's run (CI, your answer, a review, a cancelled issue), and the last three about paused agents, usage limits and wiped review stages.

**Contents:** [1. Dropped hand-offs](#1-dropped-hand-offs) · [2. Blocked issues whose blockers are all done](#2-blocked-issues-whose-blockers-are-all-done) · [3. Done blockers whose workspace clean-up failed](#3-done-blockers-whose-workspace-clean-up-failed) · [4. Wakes deferred behind a stopped run](#4-wakes-deferred-behind-a-stopped-run) · [5. Recovery holds left by a hand-off](#5-recovery-holds-left-by-a-hand-off) · [6. Issues parked because the assignee couldn't be run](#6-issues-parked-because-the-assignee-couldnt-be-run) · [7. Holds Paperclip can never release by itself](#7-holds-paperclip-can-never-release-by-itself) · [8. Issues linked to a closed workspace](#8-issues-linked-to-a-closed-workspace) · [9. Issues waiting for a workspace their agent scheduled](#9-issues-waiting-for-a-workspace-their-agent-scheduled) · [10. Question cards addressed to a teammate](#10-question-cards-addressed-to-a-teammate) · [11. CI runs an agent waits on](#11-ci-runs-an-agent-waits-on) · [12. Answers that reach nobody](#12-answers-that-reach-nobody) · [13. Reviews escalated by Paperclip's review-round limit](#13-reviews-escalated-by-paperclips-review-round-limit) · [14. Issues blocked by a cancelled issue](#14-issues-blocked-by-a-cancelled-issue) · [15. Issues blocked while their agent was paused](#15-issues-blocked-while-their-agent-was-paused) · [16. Claude usage limits](#16-claude-usage-limits) · [17. Issues whose review stages were wiped](#17-issues-whose-review-stages-were-wiped) · [Notes for the board](#notes-for-the-board) · [Limits](#limits) · [What it leaves to you](#what-it-leaves-to-you) · [Watchdog settings](#watchdog-settings)

| In Paperclip you see… | The watchdog… |
|---|---|
| An issue assigned to an agent that **never starts**, after a hand-off. | Comments on it, which wakes the new owner. |
| A **blocked** issue whose blockers are all **done**. | Comments on it, which moves it to `todo` and wakes the owner. |
| A blocked issue whose only blocker is done but **"finalizing"** forever. | Removes that blocker, moves the issue to `todo` and explains why. |
| **"Waiting for execution recovery. Your message is saved."** | Presses Paperclip's **send queued messages now** for it. |
| **"Automatic recovery blocked"**, board decision required, after a hand-off. | Delivers the saved messages to the current owner, as **Interrupt** does. |
| **"Automatic recovery blocked … the original assignee is not invokable"**, after you paused and resumed an agent. | When the agent is resumed, restores each issue blocked during the pause to the status it had (in review if a review stage is pending) and wakes it, a few per tick (15). Any it doesn't restore get a comment once the agent is back, which un-parks them (6). |
| **"Automatic recovery of this task stopped"**, with every message saved behind "The previous run has no verified stop record". | Releases the hold, as `pch release --apply` does, and delivers the saved messages. |
| Every run fails at once with **`setup_failed`: "requested inherited execution workspace reuse … could not be restored"**. | Clears the issue's link to the closed workspace, as `pch workspace --apply` does, and restarts the agent if that run was its last. |
| An agent scheduled a workspace of its own and left the issue in **todo**, and nothing started its next run. | Comments on it, which wakes the agent on its new workspace. |
| A **question card** an agent addressed to a teammate sits unanswered for days, and the issues blocked behind it with it. It isn't in **Decisions**, because it isn't waiting on you. | Creates an issue assigned to the teammate that says which card to answer, and closes it once the card is answered. |
| An agent said it **waits on a CI run** ("waiting on run 39498202022"), or its monitor gave up, and the issue sits for hours after the run finished. | Comments with the run's result, which wakes the agent. Optionally re-runs jobs you know to be flaky first. |
| You **answered an agent's card** while the issue waited on your review, and the agent never acted on it. | Returns the issue to that agent with your answer quoted. |
| A review lands with **you** after an agent requested changes, instead of going back to the implementer. | Nothing by default: that is Paperclip's review-round limit. With `WATCHDOG_RETURN_ESCALATED_REVIEWS` on, returns it to the implementer, twice per issue. |
| An issue stays **blocked by a cancelled issue**. | Tells its agent why the blocker was cancelled, so it can remove or replace the blocker. |
| Hundreds of failed runs overnight: **"You've hit your … limit · resets …"** on every Claude agent. | Pauses the Claude agents on that account as each one goes idle, tells the board once, and resumes exactly those agents when the limit resets (16). Codex agents keep working. |
| An issue **done while its PR is still open and unreviewed**, or in review with no stages left. | Reopens the done one, and tells the board to restore the stages (17). The relay closes such an issue when you merge its PR. |

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

When the agent was paused and has just been resumed, [15](#15-issues-blocked-while-their-agent-was-paused) looks at its blocked issues first, once the resume has settled, and this check leaves them alone until then and while that sweep holds them. The settle window (`WATCHDOG_RESUME_SETTLE_MIN`) holds this check back after a resume even with the sweep off. Its nudges share the sweep's per-agent limit of runs in flight (`WATCHDOG_RESUME_SWEEP_LIMIT`, or the agent's `maxConcurrentRuns`): with the agent's queue full, the rest wait for a later tick.

## 7. Holds Paperclip can never release by itself

Before Paperclip starts anything new on an issue held for reconciliation (`legacy_execution_requires_reconciliation`), it wants proof that the held run's process is gone: a process id or group it can check, or a stop record. A run cut off at a hand-off, or one whose adapter failed before a process started, records neither. Paperclip then saves every message, Interrupt and comment behind the hold for good. Waiting changes nothing, and nor does pressing Interrupt.

With `WATCHDOG_RELEASE_HOLDS` on, the watchdog releases such a hold the way `pch release ISSUE --apply` does: it records the board's reconciliation (the run has stopped; what it did is unverified) and delivers the saved messages. If there are none, it comments instead, which wakes the owner. Either way the agent is told, or Paperclip's own continuation tells it, that the stopped run may have done part of its work, so it checks the workspace and branch first.

- It acts only on that cause, and only when the held run recorded no process id or group. A run with a recorded process is Paperclip's to check, and its hold clears once the process is gone.
- It waits until the run has been over for the stall window, and while the owner is paused, terminated or awaiting approval.
- It leaves the hold alone, and logs it once, while the run is still active, its environment lease is unreleased, or another run on the issue is active.
- It releases each held run once. A hold that comes back for the same run is logged once and left to you.

This was verified against Paperclip 2026.916.1, 2026.1001.0, 2026.1005.0 and 2026.1012.0 by the compatibility suite, which reproduces the hold with an agent whose command doesn't exist.

## 8. Issues linked to a closed workspace

An issue an agent creates from another issue's work is linked to that issue's execution workspace. When that issue finishes, Paperclip closes its workspace but leaves the links on other issues. Every run on them then fails before the agent starts, with `setup_failed` and "Issue … requested inherited execution workspace reuse for …, but the workspace could not be restored". Retry and comments fail the same way.

With `WATCHDOG_CLEAR_DEAD_LINKS` on, the watchdog looks at every open issue (backlog to blocked) linked to another workspace. When that workspace is archived or no longer exists, it clears the link, as `pch workspace ISSUE --apply` does: the next run gets a new isolated workspace. The issue's other workspace settings, such as a pinned branch or its environment, are kept.

- It doesn't wait for the stall window: a run on that issue can only fail until the link is cleared.
- It judges the workspace the way Paperclip does when it starts a run: from the issue's own copy of it. The workspace's own page answers "not found" for one your key may not read, so that alone is never taken as closed.
- It waits while a run on the issue is queued or running, and leaves done and cancelled issues alone, and any issue with a workspace change already scheduled for its next run.
- It clears each issue's link to a given workspace once. If Paperclip refuses the change, it tries again a stall window later, `WATCHDOG_MAX_NUDGES` times in all, then logs that it leaves it to you. If Paperclip ignores the change, it logs that once.
- If the assignee's last run failed on that link and the issue is todo or in progress, it also comments, which restarts the agent. A blocked issue, or one in review, only has its link cleared. A comment there would move it on without your decision, so `pch why` gives you the comment to send.
- It never touches a link to a live workspace, even another issue's. That may be shared on purpose; `pch workspace` changes it when you decide.
- It leaves an issue linked to its own closed workspace (a finished issue you reopened) to you, and logs it once: unarchiving that workspace may be the better fix.
- Paperclip ignores the change while **Instance settings → Experimental → Enable Isolated Workspaces** is off. The watchdog then changes nothing, and logs once a day which issues are affected.

## 9. Issues waiting for a workspace their agent scheduled

An agent can't change its own workspace during a run, but it can schedule one for its next run (`PUT /api/issues/:id/workspace`). The agent instructions in this setup have an engineer do that when its branch carries another issue's pull request, instead of asking you. It then leaves the issue in `todo`, and nothing starts the next run.

With `WATCHDOG_CLEAR_DEAD_LINKS` on, the watchdog looks at `todo` issues touched in the last day that have been quiet for the stall window. If one has a workspace selection waiting for its next run, no run in progress and no wake pending, it comments, which wakes the assignee on its new workspace. It nudges at most `WATCHDOG_MAX_NUDGES` times per scheduled selection.

## 10. Question cards addressed to a teammate

An agent asks a teammate a question by saving a card on its own issue, addressed to that teammate (`addresseeAgentId`), and waits in review. Paperclip wakes the teammate (`interaction_pending`), but its run admission then cancels the run before it starts: "Cancelled because issue assignee changed before the queued run could start". Nothing changed hands. Only the assignee, a review participant or a comment's wake may run on an issue, and a card's wake is none of them. The card waits for good, and every issue blocked behind the asker waits with it. Seen on Paperclip 2026.1012.0, and still so on `main` in October 2026 (`decideQueuedRunStaleness`, `server/src/modules/run-dispatch/domain/policy.ts`). Reported upstream as paperclipai/paperclip#11932 (also #13518 and #16409), with fixes open in #11939, #14378 and #15991. Once one ships, the watchdog finds nothing to route; it can stay on or be turned off.

Any run of the teammate may answer the card, whatever issue the run is for. So with `WATCHDOG_ROUTE_QUESTIONS` on, the watchdog looks at every open issue's pending cards once per stall window. For a card where all of these hold:

- it's addressed to an agent other than the issue's assignee;
- it has waited for the stall window;
- that agent has had no run on the issue since (one that started, or is about to, means the wake got through);
- that agent isn't paused, terminated or awaiting approval;

it creates an issue assigned to that agent, in the same project and with the same priority, titled "Answer Carla's question on ACM-479". The issue quotes the question and says which card to answer, with the route for its kind (`respond` for questions, `accept`/`reject` for confirmations). Answering the card wakes the asker. A comment wouldn't record an answer.

- Once the card is answered, withdrawn or expired, the watchdog closes that issue, if the agent hasn't already. It waits while a run holds the issue.
- If the agent closes the issue without answering, for example because its instructions leave the call to the board, the watchdog logs it once and leaves the card to you.
- Each card is routed once. If Paperclip doesn't answer the request that creates the issue, the issue may exist anyway, so it isn't tried again: the log says so.
- A card addressed to a person, or to anyone, is left alone: `pch blocked` lists those.

The hand-off check (1) also ignores the teammate's cancelled run. That run never started, so it isn't the issue changing hands, and nudging the asker would only make it check its card again.

## 11. CI runs an agent waits on

An agent that pushes and waits for CI usually says so in a comment ("Waiting on run 39498202022", or a link to the run) and stops, or schedules a Paperclip monitor to look again later. A monitor gives up after its timeout or its attempts, and a run that queues behind others (one self-hosted runner, a busy organization) can finish long after that. Nothing then wakes the agent: the issue sits blocked or in progress with CI long since green or red.

With `WATCHDOG_CI_RUNS` on and a GitHub token (`GITHUB_TOKEN` or `GITHUB_TOKEN_FILE`, with **Actions: Read** on the repositories), the watchdog reads, once per stall window, the latest comment of each quiet issue's agent (or, when that names no run, the agent's latest comment that does, among the issue's last ten) and its monitor's notes (Paperclip redacts a monitor's `externalRef`; its notes are readable). It looks for a run, by its Actions URL or by a run id of 9 digits or more next to the word "run", so PR and issue numbers never match. Once that run has finished, it comments with the result, which wakes the agent: the run, its attempt, branch and commit, the conclusion, and the failed jobs.

- Only issues an agent owns, in todo, in progress, in review or blocked, touched in the last three days, with nothing running on them.
- Only a run in `GITHUB_REPOS`. A run named by id alone is looked up in each of those repositories.
- It waits until the run has been finished for the stall window, which leaves the agent's own monitor time to fire, and while a Paperclip monitor that watches something else is still scheduled to check later: status `scheduled`, its next check ahead or due within the last two minutes (Paperclip's scheduler looks every 30 seconds by default). Past its timeout or out of attempts, Paperclip clears such a monitor at its next check and, under the default recovery policy `wake_owner`, wakes the agent then, so it still counts; with `create_recovery_issue` or `escalate_to_board` it doesn't. A monitor that has fired (`triggered`) waits for the agent to schedule it again, and a `cleared` one is done: neither holds the report back.
- **A monitor that watches this run and nothing else** (every run its notes name is this one; Paperclip redacts a monitor's `externalRef`, so the notes are all there is to go on) doesn't hold the report back: it would only wake the agent again to find the run finished. The watchdog reads the issue again, then reports the run and clears that monitor in the same step: one `PATCH` of the issue with the comment and the issue's current execution policy without its monitor (Paperclip records it as cleared, `manual`). When the clearing goes through, the comment says so; if Paperclip refuses the policy change, the comment goes on its own and the monitor stays. Monitors that also name another run, or name nothing, are left alone, as is a monitor whose policy Paperclip doesn't show.
- A queued wake for the agent holds the report back for the stall window. With nothing running on the issue, one waiting longer isn't starting (a monitor's own wake has been seen queued for hours while a new comment started a run at once), so the run is reported, and the comment's wake joins the queued one. A wake deferred behind an earlier run holds it back for as long as it waits: a comment would be deferred with it (see [4. Wakes deferred behind a stopped run](#4-wakes-deferred-behind-a-stopped-run)).
- When a comment names several runs, the newest is the one waited on; while it is still going, nothing is said about older ones.
- Nothing is said when the agent has run on the issue since the run finished, or wrote its comment after the run finished (it watched the run within its own run): it has seen the result.
- Nothing is said about a run that was cancelled (usually by a newer push), skipped or is waiting on an approval, or whose PR or branch has moved on to a newer commit since: that commit's run is what counts.
- **Default-branch dispatches are the exception:** a `workflow_dispatch` run whose `head_branch` matches the repository's default branch (read from GitHub) is reported on every conclusion, including `cancelled`, even if the branch has moved on. It is never automatically re-run, regardless of the flaky-job pattern. All other timing, monitor and wake checks still apply. The run reported is the one the agent named, even when newer commits on the branch have superseded its commit: the agent asked for that commit's verdict. The default branch is read with `GET /repos/{owner}/{repo}` (**Metadata: Read**, which every GitHub App and fine-grained token has) and kept for an hour; while GitHub doesn't answer, the branch read earlier is used, or, before the first answer, such a run waits and is looked at again on the next scan; the log says which, once. A dispatched run that ends `cancelled` or `skipped` is reported as giving no verdict, not as a failure.
- Once per run attempt: a run you (or an agent) re-run is reported again when its new attempt finishes.
- **Why a run wasn't reported:** with `LOG_LEVEL=debug`, the log has one line per run attempt and reason ("watchdog: a finished CI run an agent waits on isn't reported", with `reason`), for example "the agent has run on the issue since it finished". If GitHub refuses to show a run (401, or a 403 that isn't its rate limit), a warning says so once per repository, with GitHub's answer and the permission the token needs (or that the token was rejected): no run there is reported until it can read them.

**Monitors and the Helper.** An agent's own Paperclip monitor that is still due and watches something else keeps this report back (see above), and each monitor wake is a full run that reloads the agent's context. So rely on one or the other: tell agents to name the run they wait on and end their run, or, if they keep monitors, space them widely (30 minutes or more). Monitors every few minutes on top of the Helper only add runs that find the CI still going.

**Flaky jobs.** Set `WATCHDOG_CI_RERUN_JOBS` to a regular expression matching the names of jobs you know to be flaky, for example `^e2e \(windows\)$|^ci-gate$`. A finished run whose failed jobs *all* match is re-run instead of reported (GitHub's "Re-run failed jobs"), up to `WATCHDOG_CI_RERUN_MAX` times per run (default 2), and only while the run's commit is still its pull request's head: a newer push runs CI by itself. The agent hears nothing until an attempt passes or the re-runs are used up, and the comment then says how many re-runs there were. A run with any other failure is reported straight away. Re-runs need **Actions: Read and write**; if GitHub refuses one, the run is reported instead and the log says which permission is missing. Empty (the default) never re-runs anything.

## 12. Answers that reach nobody

While a review or approval stage waits on a person, Paperclip assigns the issue to that person. Nothing on it wakes an agent: a comment from you wakes the assignee, which is you, and on current Paperclip a mention wakes nobody (paperclipai/paperclip#14577). So when an agent asked you something with a card (a report to paste, a choice) and you answer it after the issue reached your stage, Paperclip delivers the answer to you, and the agent never hears it.

With `WATCHDOG_DELIVER_ANSWERS` on, the watchdog looks at the issues waiting on your decision once per stall window. When the stage's return assignee (the agent that submitted the work) created a card on the issue that a person has answered, accepted or rejected, the answer is at least 30 minutes old (time for you to decide yourself), and no run of that agent on the issue was going when it came or has started since, the watchdog returns the issue to the agent: it records **changes requested** as you, the stage's participant, with a comment that quotes your answer and asks the agent to act on it and hand the issue back for review. Paperclip then assigns it to the agent and wakes it; its resubmission comes back to the same stage.

- Only an issue whose decision waits on the helper's own user (the board key's), as `pch check ISSUE` reports it. Only that user can decide.
- Only an answer Paperclip would have delivered: the card's `continuationPolicy` asks to wake the assignee on this answer (a card that asked for no wake, or the rejection of an accept-only card, is left alone).
- Once per card. It waits while the agent is paused, terminated or awaiting approval, or a run is active on the issue. It reads the issue again just before deciding, and does nothing if you decided in the meantime.
- Never on a review Paperclip escalated to you (13): that is only returned when you turn that on.
- Your decision resets Paperclip's review-round count for the stage, as any decision of yours does.

## 13. Reviews escalated by Paperclip's review-round limit

When agents request changes on one review stage `maxReviewRounds` times in a row (3 unless the issue's execution policy says otherwise), Paperclip stops returning the work to its implementer and hands the review to the responsible person instead: the stage stays pending, with you as participant although you aren't one of its reviewers. That is deliberate, a guard against two agents bouncing work for ever, so the watchdog leaves it to you by default.

If you'd rather the work went back to the implementer, there are two ways:

- **Raise the limit** in your execution policies (`maxReviewRounds`, up to 50). Paperclip then keeps returning the work itself, and still escalates at the new limit.
- **`WATCHDOG_RETURN_ESCALATED_REVIEWS=true`.** Once such an escalated review has been quiet for the stall window, the watchdog returns it to the implementer as your **changes requested**, quoting the latest comment of one of the stage's reviewers. A decision of yours resets Paperclip's round count, so each return gives the agents `maxReviewRounds` more rounds (with the defaults, 2 returns × 3 rounds). At most `WATCHDOG_MAX_NUDGES` returns per issue (counted for a week); after that the next escalation is logged and left to you. It leaves an issue alone while a card on it waits on a person, and when the implementer has run since the reviewer's comment.

## 14. Issues blocked by a cancelled issue

Paperclip counts a blocker as resolved only when it is **done**. A cancelled blocker stays unresolved until someone removes or replaces it in **Blocked by**, so the dependent stays blocked and nothing wakes its agent. Often the work landed elsewhere (another issue's PR carried the fix) and nobody updated the link.

With `WATCHDOG_CANCELLED_BLOCKERS` on, once such an issue has been quiet for the stall window, the watchdog comments on it once, which wakes its agent: which blockers were cancelled, each one's last comment (usually why it was cancelled), and what to do. If the work landed elsewhere or isn't needed, remove the blocker (and link what replaced it); if it is still needed, say so and ask for a replacement. It waits while the agent is paused, terminated or awaiting approval, or a run is active or a wake pending on the issue.

## 15. Issues blocked while their agent was paused

Pausing an agent cancels the runs it has queued or in flight. Paperclip's recovery sweep then finds each of those issues assigned to an agent it can't invoke, and gives up on it: it sets the issue to `blocked`, with no blocker linked, and posts a system comment, "Paperclip cannot safely continue automatic recovery because the original assignee is not invokable. The source assignment is unchanged and the board must choose the next action.", whose details have a **Recovery** section: *Recovery owner: Board decision required*. Resuming the agent restarts none of them. Pausing six agents at once has left sixteen issues to set back by hand.

With `WATCHDOG_RESUME_SWEEP` on, the watchdog remembers every agent's status each tick (in `data/state.json`, so a resume while the helper is down still counts). When an agent goes from `paused` to available, it waits `WATCHDOG_RESUME_SETTLE_MIN` minutes (10 by default), touching none of the agent's blocked issues meanwhile, not even with [6](#6-issues-parked-because-the-assignee-couldnt-be-run). A resume to check one thing, followed by a pause, so restores and wakes nothing: the sweep is called off, and the next resume covers both pauses. Once the resume has settled, it looks at the agent's blocked issues and restores each one that meets all of these:

- it is still assigned to that agent, with nothing running on it;
- no unresolved blocker: **Blocked by** is empty, or every blocker is done or cancelled;
- its newest comment is Paperclip's recovery notice, recognised by the **Recovery** section of its details (board decision required, and not one Paperclip marks for a person to fix, such as a usage limit or a missing login). On a Paperclip whose comments carry no details, by its text, "the original assignee is not invokable";
- that comment was posted while the agent was paused: after Paperclip's `pausedAt` for the agent (or, without it, after the watchdog's last check that saw the agent running) and before the resume;
- nothing has changed since: no newer comment from anyone, and the issue hasn't left `blocked` and come back;
- the recovery action the comment names, when Paperclip shows it, is the "assignee not invokable" kind (`stranded_assigned_issue`), not a lost process or a failed workspace. When Paperclip shows no action, the comment itself must say the assignee was not invokable, or name a run the pause cancelled (`agent_paused`); when reading the action fails, the issue waits for the next tick.

Each issue goes back to:

- `in_review` when a review or approval stage is pending, so the stage's participant is woken rather than the implementer (moving it anywhere else as the board would dissolve the stage);
- otherwise the status Paperclip recorded before the block (its recovery action's `previousStatus`: todo, in progress or in review);
- otherwise `todo`.

The status change carries one comment, "*Agent* was resumed: retrying the original owner (the recovery block came from the pause).", and together they wake the assignee, as your own comment would.

**Paced.** It never gives the agent more than `WATCHDOG_RESUME_SWEEP_LIMIT` runs in flight; `0` (the default) means the agent's own `maxConcurrentRuns` (its heartbeat setting in Paperclip, which Paperclip sets to 20 for new agents), or 1 if Paperclip doesn't show one. Every run the agent has queued or going counts against that limit, on any issue: those of issues restored earlier, and the wakes Paperclip held during the pause and releases on the resume (comments, resolved blockers, assignments). Nudges from 6 for the same agent share the same limit, so neither path adds to a full queue. Just before each restore the agent is read again: paused since, it gets nothing back. Most urgent first, then longest blocked. The rest follow on later ticks. While a sweep is under way, [6](#6-issues-parked-because-the-assignee-couldnt-be-run) leaves alone the issues the sweep is still to restore; any other blocked issue of the agent is 6's as usual. The sweep ends at the first tick with nothing left to restore or postponed, and after a day at most. If the agents can't be listed on a tick, nothing is decided about pauses until the next one.

**Never restored by the sweep:** an issue whose recovery block came while the agent was *not* paused (a real failure the board should look at), an issue someone has acted on since, and an issue blocked for any other reason. If the agent is paused again before the sweep ends, the next resume covers both pauses. A task you paused (its own pause, not the agent's) postpones the restore until you resume it; a change Paperclip refuses is logged and left to you. A pause and resume that both fall between two checks isn't seen (6 still un-parks those issues once they have been quiet). With `DRY_RUN=true` it logs what it would restore and keeps the sweep open, so turning dry run off within the day still restores them.

Upstream, a deliberate pause arguably shouldn't make Paperclip give up on the agent's work at all. Recent Paperclip source already skips the block for some paused cases (a run cancelled by the pause); this sweep covers the versions and paths that still block.

## 16. Claude usage limits

When a Claude subscription hits its 5-hour or weekly limit (or an API organisation its spend limit), every Claude agent on that account fails its next run, and Paperclip keeps waking and retrying them: hundreds of failed runs before the limit resets, each a wasted run. Paperclip files them as `claude_transient_upstream` (2026.10 releases) or `provider_quota` (newer source), with the message Claude gave: *"You've hit your org's monthly spend limit · … · your weekly limit resets Oct 12, 4pm (Europe/London)"*. The same codes cover real transient failures (*"Claude exited with code 143"*), so only the limit wording counts.

With `WATCHDOG_LIMIT_PAUSE` on, the watchdog reads each company's latest 200 runs every tick. When a `claude_local` agent's run failed with the limit wording:

1. **When it resets** comes from the "resets …" right after the limit wording: a date if given, a clock time, and the time zone in brackets (UTC if there is none), or the Unix time of Claude's older `usage limit reached|<time>` format. A reset more than a week away, or none at all (a monthly spend cap, say), counts as unknown: the watchdog tries again after an hour, then after 2, 4 and at most 8 hours while the same limit keeps failing.
2. **Who shares the limit:** the Claude agents on the same account, as far as Paperclip shows it, in the order Paperclip's adapter picks credentials: the same secret behind `ANTHROPIC_API_KEY`, else behind `CLAUDE_CODE_OAUTH_TOKEN`, else neither set (the Claude login stored on the machine). A token wins over the stored login, so agents that each have their own `CLAUDE_CONFIG_DIR` (their own sessions and settings) but the same token secret share one account. Without a token, the login is the one in the agent's `CLAUDE_CONFIG_DIR`, or the machine's default. An agent whose account can't be compared is its own group and is paused only when it fails itself: a token typed in as plain text, or a `CLAUDE_CONFIG_DIR` with no token (Paperclip redacts both), Bedrock, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL`, or a managed AI connection.
3. **Pause** each of them with Paperclip's pause (`POST /api/agents/:id/pause`) once it has no run queued or going: pausing mid-run cancels the run, and Paperclip's recovery then blocks its issue. The agent and its latest runs are read again just before each pause, so a retry that started during the tick isn't cut off. A busy agent is paused at the first tick after its run ends; one whose runs keep it busy for 30 ticks is logged once, so you can decide whether to pause it yourself. An agent already paused, terminated or awaiting approval is left alone. The watchdog records which agents it paused, and when, in `data/state.json`.
4. **Tell the board once,** as soon as at least one agent is paused: a warning in the log, and a comment on the issue named in `WATCHDOG_NOTIFY_ISSUE` when that issue is in the same company: *"Claude usage limit reached: 3 agents paused (…). The limit resets Mon 12 Oct, 16:00 (Europe/London); the watchdog resumes them at Mon 12 Oct, 16:05 (Europe/London). Codex agents are unaffected and keep working."* A board comment wakes the issue's assignee, so pick an issue assigned to a person, or to nobody. The same limit failing again within six hours of a resume isn't announced again.
5. **Resume** exactly the agents it paused, `WATCHDOG_LIMIT_RESUME_GRACE_MIN` minutes after the reset. An agent you have paused again since (its pause time changed) or resumed already is left as it is. A resume Paperclip refuses is tried again each tick, five times, then left to you. With `WATCHDOG_RESUME_SWEEP` on, the resume sweep (15) then restores the issues Paperclip blocked during the pause. If the account is still at its limit, the next failure starts a new pause.

Codex agents' own quota failures (`provider_quota`, *"Selected model is at capacity"*) are transient: nothing is paused, and Paperclip retries them. With `DRY_RUN=true` it logs once which agents it would pause and changes nothing. A pause Paperclip refuses is logged once per limit.

## 17. Issues whose review stages were wiped

An agent's update that sends `executionPolicy: { stages: [] }` removes the issue's review and approval stages; Paperclip then stores no policy at all. The issue closes as done, or sits in review with nothing to review, while its PR is open and unreviewed. It has been seen with Codex agents in particular. The result is a PR merged with no review, or dependants that can't start because Paperclip starts a dependant only once its blocker is done ("Issue is blocked by unresolved blockers"). This is a Paperclip bug ([paperclipai/paperclip#17301](https://github.com/paperclipai/paperclip/issues/17301)); until it is fixed, with `WATCHDOG_STAGES_WIPE` on, once per stall window the watchdog looks at issues touched in the last three days:

- **Done, with its stages wiped and its own PR still open** (with a GitHub token): the issue's activity log must show an agent's update that removed its stages, and it must have none now. The PRs are its PR work products and the PR links in the relay's [Pull requests document](relay.md#quiet-notes) and its last 20 comments, in `GITHUB_REPOS`; only one whose first named issue is this one, opened before the issue was done, counts (a revert or follow-up opened later doesn't). The issue is set back to `in_progress` with a comment, *"This issue was closed while PR #12 was still open and unreviewed, so the watchdog has reopened it. Its review stages were wiped (by …), so the board or the architect must restore them before it is reviewed. Don't mark it done again until they are."*, which wakes its agent, and the board is told. Once per issue and PR: closed again with the PR still open, it is left done and the board is told instead.
- **In progress or in review, with no stages, and an agent's update removed them:** the board is told once, with who made the change. Nothing else changes.

It never re-creates stages: which reviews the issue needs, and who does them, is the board's call. A merged or closed PR, an issue that never had stages, and stages a person removed are left alone. Each issue is looked at again only when it changes.

When you merge such an issue's PR, the relay closes it as done ([the relay](relay.md#merging-an-issue-whose-review-stages-were-wiped), `RELAY_DONE_WITHOUT_STAGES`).

## Notes for the board

Some checks tell the board about something it should know: a usage limit that paused agents (16), an issue closed with its PR still open or whose review stages were wiped (17), and the relay's merge-queue drops that aren't the PR's fault. Each is a warning in the log. Set `WATCHDOG_NOTIFY_ISSUE` to an issue (`ACM-12`) and each also becomes a comment there, for the companies that issue belongs to. Pick an issue assigned to a person or to nobody: a board comment wakes the issue's assigned agent.

## Limits

With `DRY_RUN=true` the watchdog logs what it would do, once per situation, and records nothing, so turning dry run off leaves everything still to do.

Each nudge mentions the assignee and says what stalled. Each situation gets at most `WATCHDOG_MAX_NUDGES` comments or presses, spaced by the stall window. The counts are kept in `data/state.json`, so a restart doesn't repeat them.

## What it leaves to you

These look similar in Paperclip, and `pch why ISSUE` tells them apart:

- **An agent waiting on you.** An issue an agent blocked with a note of its own, such as a pending approval or a missing permission, has no blocker linked. Paperclip can keep waking the agent, which re-checks and stops again, a run each time. Decide the approval, or pause the issue.
- **A recovery hold or recovery action of another kind,** such as a stalled review. A message from you to the agent is the board decision Paperclip is waiting for.
- **A question card addressed to you, or to anyone.** `pch blocked` lists every card that is waiting, with who it waits on.
- **A run that stays queued.** The watchdog sees a queued run as work on its way, and doesn't check how long it has waited.
- **A review Paperclip escalated to you** after its review-round limit, unless you turn on `WATCHDOG_RETURN_ESCALATED_REVIEWS` (13 above).
- **A card an agent addresses to you about who should do the work** (Paperclip refuses an agent delegating back to the agent that delegated to it, and the agent asks the board). Answering it on your behalf would defeat that guard.

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
| `WATCHDOG_CLEAR_DEAD_LINKS` | `true` | Clear an open issue's link to a closed workspace, and restart its agent if its last run failed on it (8 above). Wake an agent waiting on a workspace it scheduled (9 above). |
| `WATCHDOG_ROUTE_QUESTIONS` | `true` | Give an agent an issue for each question card a teammate addressed to it that Paperclip never delivered, and close it once the card is answered (10 above). `false` leaves them to you; `pch blocked` lists them. |
| `WATCHDOG_CI_RUNS` | `true` | Tell an agent that a CI run it said it waits on has finished (11 above). Needs `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE` with **Actions: Read**; without a token it is off. A monitor whose notes name the run is cleared when the run is reported; one still due that names something else keeps the report back, so rely on the Helper or space monitors widely (30 minutes or more), not both at short intervals. |
| `WATCHDOG_CI_RERUN_JOBS` | none | A regular expression for jobs known to be flaky. A run whose failed jobs all match is re-run before it is reported. Needs **Actions: Read and write**. Empty: never re-run. |
| `WATCHDOG_CI_RERUN_MAX` | `2` | Re-runs per run, at most. |
| `WATCHDOG_DELIVER_ANSWERS` | `true` | Return an issue waiting on your decision to the agent whose card you answered meanwhile, as your "changes requested" (12 above). |
| `WATCHDOG_RETURN_ESCALATED_REVIEWS` | `false` | Return a review Paperclip escalated to you after its review-round limit to the implementer, `WATCHDOG_MAX_NUDGES` times per issue (13 above). |
| `WATCHDOG_CANCELLED_BLOCKERS` | `true` | Tell an agent once that its issue is blocked by a cancelled issue, with why it was cancelled (14 above). |
| `WATCHDOG_RESUME_SWEEP` | `true` | When a paused agent is resumed, restore its issues Paperclip's recovery blocked during the pause, and wake them (15 above). |
| `WATCHDOG_RESUME_SWEEP_LIMIT` | `0` | Runs the watchdog may give an agent at once, counting the runs it already has queued or going; the sweep's restores and 6's nudges share it. `0`: the agent's `maxConcurrentRuns`, or 1 if Paperclip doesn't show one. |
| `WATCHDOG_RESUME_SETTLE_MIN` | `10` | Minutes after a resume before the agent's blocked issues are touched (by 15 or 6). `0`: at once. |
| `WATCHDOG_LIMIT_PAUSE` | `true` | Pause the Claude agents on an account that hit its usage limit, each once idle, and resume them at the reset (16 above). |
| `WATCHDOG_LIMIT_RESUME_GRACE_MIN` | `5` | Minutes after the reset before they are resumed. |
| `WATCHDOG_STAGES_WIPE` | `true` | Reopen a done issue whose own PR is still open, and tell the board about issues whose review stages an update removed (17 above). The open-PR part needs a GitHub token. |
| `WATCHDOG_NOTIFY_ISSUE` | none | An issue (`ACM-12`) for the [notes for the board](#notes-for-the-board) in its company. Choose one assigned to a person or to nobody: a board comment wakes the assignee. Without it, the notes are only in the log. |


---

[← Back to the README](../README.md)
