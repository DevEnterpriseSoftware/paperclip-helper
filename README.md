# Paperclip Helper

Self-hosted [Paperclip](https://github.com/paperclipai/paperclip) has gaps that show up as soon as agents do real software work: reviews you can't approve from the issue, agents that silently stop when work changes hands, questions agents ask each other that never arrive, retry storms at a usage limit, and a Costs page that reads $0. **Paperclip Helper runs beside Paperclip and closes those gaps**, using Paperclip's own API and a board key of yours.

> Paperclip Helper is an independent project. It is not made by or affiliated with the Paperclip team.

## Highlights

- **Merge to approve.** Merge an agent's PR on GitHub and its issue is approved; **Request changes** sends it back with your review as the brief. No hunting for an Approve button.
- **Nothing stalls silently.** Dropped hand-offs, finished blockers, undelivered questions, recovery holds and paused agents: the watchdog spots the situations Paperclip doesn't recover from and wakes the right agent.
- **Agents wait without polling.** A finished CI run, an answered card or a cancelled blocker reaches the agent as one wake, when it happens, instead of a monitor reloading its context every few minutes.
- **Usage limits handled.** Hit a usage limit? The Helper pauses your Claude agents, keeps your Codex agents working, and resumes them when the limit resets.
- **The merge queue doesn't strand PRs.** A conflict or a failed queue check goes back to the agent; a cancelled runner or the queue's timeout goes to you, not the implementer.
- **Reviews aren't skipped by accident.** An issue that closed with its PR still open, because an agent wiped its review stages, is reopened and the board is told.
- **You can see where the tokens go.** `pch usage` shows each agent's runs, tokens and what woke it; cost sync puts subscription runs on the Costs page; `pch why` and `pch blocked` say what's holding the work.
- **Safe by default.** Everything happens through Paperclip's API under your name, `DRY_RUN=true` previews it all, and the Helper never merges, pushes or deletes anything.

## Contents

- [What Paperclip leaves you with, and what the helper does about it](#what-paperclip-leaves-you-with-and-what-the-helper-does-about-it)
- [Paperclip issues it works around](#paperclip-issues-it-works-around)
- [How it works](#how-it-works)
- [Why it saves tokens](#why-it-saves-tokens)
- [Quick start](#quick-start)
- [The three components](#the-three-components): [relay](#relay-github--your-decisions-in-paperclip), [watchdog](#watchdog-wake-stalled-work), [cost sync](#cost-sync-what-your-subscription-runs-would-have-cost)
- [Commands](#commands)
- [Security](#security)
- [Upgrading](#upgrading) · [Troubleshooting](#troubleshooting) · [Compatibility](#compatibility)
- [Documentation](#documentation) · [Contributing](#contributing) · [License](#license)

## What Paperclip leaves you with, and what the helper does about it

### Reviews, merges and PRs

| In Paperclip you see… | With the helper… |
|---|---|
| **"Approval pending with You", and no Approve button** on the issue. | **[Relay](docs/relay.md).** Merge the PR on GitHub and the issue is approved. **Request changes** on GitHub sends it back to the engineer, with your review as the brief. |
| **PRs waiting for your review that you can't merge**, because another merge left them with conflicts. | **[Relay](docs/relay.md#prs-with-merge-conflicts).** After each merge it finds the open PRs that now conflict and sends them back to their agents to resolve, with a note on the PR. |
| **A PR the merge queue dropped**, sitting unmerged with no conflict. | **[Relay](docs/relay.md#prs-the-merge-queue-drops-without-a-conflict).** A failed merge-group check sends it back to its agent with the failed jobs; a cancelled run or the queue's status-check timeout is told to you, without waking the implementer. Optionally it queues the PR again itself. |
| **An issue done while its PR is still open and unreviewed**, or in review with no stages left (an agent's update wiped them). | **[Watchdog](docs/watchdog.md#17-issues-whose-review-stages-were-wiped).** It reopens the done issue and tells the board to restore its stages. When you merge such an issue's PR, the [relay](docs/relay.md#merging-an-issue-whose-review-stages-were-wiped) closes it, so its dependants can start. |
| **You answered an agent's card, and nothing happened**, because the issue was waiting on your review. | **[Watchdog](docs/watchdog.md#12-answers-that-reach-nobody).** It returns the issue to the agent with your answer. |
| **An issue that lists the wrong PR**, or none. | **Relay.** It notes the PR's URL on its own issue when the PR opens, so Paperclip links it, in a document that wakes nobody. |

### Stalled work

| In Paperclip you see… | With the helper… |
|---|---|
| **A board full of blocked issues, and nothing in Decisions.** Follow the chain far enough and it ends at an agent's question card to a teammate (*"Please rule on…"*) that has waited for days. Paperclip never delivers a card to a teammate who isn't the issue's assignee: the wake is cancelled before it starts. | **[Watchdog](docs/watchdog.md#10-question-cards-addressed-to-a-teammate).** It gives the teammate an issue that says which card to answer, and closes it once the card is answered; the asker wakes with the answer. **[`pch blocked`](docs/commands.md#blocked-what-the-blocked-issues-wait-on)** shows what every blocked issue waits on, and **`pch answer`** answers a card from the command line. |
| **An agent that never starts** after an issue is handed to it. | **[Watchdog](docs/watchdog.md).** It spots the wake Paperclip dropped and wakes the new owner with a comment. |
| **A blocked issue that stays blocked** after its blockers are done, or whose done blocker is "finalizing" forever. | **Watchdog.** It wakes the owner, and removes a blocker stuck on a failed workspace clean-up. |
| **An issue blocked for good by a cancelled issue.** | **[Watchdog](docs/watchdog.md#14-issues-blocked-by-a-cancelled-issue).** It tells the agent why the blocker was cancelled, so it can remove or replace it. |
| **An issue that sits for hours after CI finished**, because the agent said "waiting on run …" and stopped, or its monitor gave up first. | **[Watchdog](docs/watchdog.md#11-ci-runs-an-agent-waits-on)** (with a GitHub token). It tells the agent the run's result once it finishes, clears the agent's own monitor for that run, and can re-run jobs you know to be flaky first. Runs started by `workflow_dispatch` on the default branch are reported on every conclusion and never re-run. |
| **"Waiting for execution recovery"** or **"Automatic recovery blocked"** after a hand-off, with your message saved but never delivered. | **Watchdog.** It presses Paperclip's own **send queued messages now** / **Interrupt** for you. |
| **"Automatic recovery of this task stopped"**, and every message or **Interrupt** is saved again with "The previous run has no verified stop record". | **Watchdog.** Paperclip wants proof that a run cut off at a hand-off has stopped, and that run never recorded any, so the hold never clears. The watchdog records that the run stopped, releases the hold and delivers the saved messages. **[`pch release ISSUE`](docs/commands.md#release-a-hold-messages-cant-clear)** does the same by hand. |
| **Issues left blocked after you pause and resume agents** ("the original assignee is not invokable"). | **[Watchdog](docs/watchdog.md#15-issues-blocked-while-their-agent-was-paused).** When the agent is resumed, it puts each issue Paperclip blocked during the pause back where it was (a review stays in review) and wakes it, a few at a time. Issues blocked for any other reason, or that someone has touched since, are left alone. |
| **Runs fail at once with `setup_failed`: "requested inherited execution workspace reuse … could not be restored"**, or an agent blocks an issue asking for a "workspace ruling". | **[`pch workspace ISSUE`](docs/commands.md#workspace-an-issue-linked-to-the-wrong-workspace)**. Issues an agent creates from another issue's work are linked to that issue's workspace. Once it's closed every run fails at setup, and while it's live their commits land on its branch. `--apply` gives them a new isolated workspace, and `pch why` recommends it when it sees either. **Watchdog** clears links to a closed workspace by itself. |
| **"Why is nobody working on this?"** | **[`pch why ISSUE`](docs/commands.md)** prints Paperclip's own diagnosis, then a recommendation: what is holding the issue and the command that gets it moving. `--prompt` turns it into a prompt for an LLM chat. |

### Usage, cost and housekeeping

| In Paperclip you see… | With the helper… |
|---|---|
| **Hundreds of failed runs overnight**: every Claude agent's run fails with "You've hit your … limit · resets …", and Paperclip keeps retrying. | **[Watchdog](docs/watchdog.md#16-claude-usage-limits).** It pauses the Claude agents on that account as each one goes idle, tells you once, keeps Codex agents working, and resumes exactly those agents when the limit resets. |
| **A subscription that runs out sooner than it should**, and no way to see which agent spent it. | **[`pch usage`](docs/commands.md#usage-where-the-tokens-go)** shows each agent's runs, tokens, cost and what woke it, and flags the agent that polls, the one that keeps failing and the one using most of its provider's tokens. |
| **A Costs page that shows $0**, because your agents run on a Claude or ChatGPT subscription. | **[Cost sync](docs/cost-sync.md).** It posts each run's API-equivalent cost: Claude Code's own figure, and for Codex, tokens × OpenAI list prices. |
| **A disk that keeps filling up** with hundreds of git worktrees under `.paperclip/worktrees`, for issues finished long ago. | **[`pch worktrees`](docs/commands.md#worktrees-finished-issues-worktrees-still-on-disk)** closes the workspaces of finished issues so Paperclip removes their worktrees, and lists those with uncommitted or unmerged work for you to look at. |
| **A model drop-down that doesn't list** a new model id. | **[`pch set-model`](docs/commands.md#set-model-every-model-and-effort-level)** moves every agent from one model to another and keeps the rest of their config, effort included. |

## Paperclip issues it works around

These are open bugs in [Paperclip's issue tracker](https://github.com/paperclipai/paperclip/issues) (as of 23 October 2026) that the helper works around until a fix ships in Paperclip itself. Several have fixes proposed but not yet merged. When a fix ships, the matching check simply finds nothing to do, and each check can be switched off.

| What goes wrong in Paperclip | Paperclip issues | Fixes proposed upstream | Worked around by |
|---|---|---|---|
| **A hand-off drops the new owner's wake**: the finishing run hasn't released its environment lease yet, so the wake is skipped and never retried. | [#16882](https://github.com/paperclipai/paperclip/issues/16882), [#13532](https://github.com/paperclipai/paperclip/issues/13532), [#14973](https://github.com/paperclipai/paperclip/issues/14973) | [#13880](https://github.com/paperclipai/paperclip/pull/13880), [#13769](https://github.com/paperclipai/paperclip/pull/13769) | [watchdog 1](docs/watchdog.md#1-dropped-hand-offs) |
| **A blocked issue isn't woken when its blockers finish.** | [#14260](https://github.com/paperclipai/paperclip/issues/14260), [#5985](https://github.com/paperclipai/paperclip/issues/5985) | - | [watchdog 2](docs/watchdog.md#2-blocked-issues-whose-blockers-are-all-done) |
| **A done blocker whose workspace sync-back failed** counts as unresolved forever, so its dependants never start. | [#15311](https://github.com/paperclipai/paperclip/issues/15311) | [#17206](https://github.com/paperclipai/paperclip/pull/17206) | [watchdog 3](docs/watchdog.md#3-done-blockers-whose-workspace-clean-up-failed) |
| **A wake deferred behind a stopped run** is never re-admitted ("Waiting for execution recovery"). | [#14537](https://github.com/paperclipai/paperclip/issues/14537), [#14879](https://github.com/paperclipai/paperclip/issues/14879), [#16519](https://github.com/paperclipai/paperclip/issues/16519) | - | [watchdog 4](docs/watchdog.md#4-wakes-deferred-behind-a-stopped-run) |
| **A run stopped by a reassignment leaves a hold** the board can't release, with the saved messages behind it. | [#15028](https://github.com/paperclipai/paperclip/issues/15028), [#15943](https://github.com/paperclipai/paperclip/issues/15943) | [#15094](https://github.com/paperclipai/paperclip/pull/15094) | [watchdog 5](docs/watchdog.md#5-recovery-holds-left-by-a-hand-off) |
| **"The previous run has no verified stop record"**: a run that never started (or was cut off before recording a process) freezes the issue for good. | [#15483](https://github.com/paperclipai/paperclip/issues/15483), [#13640](https://github.com/paperclipai/paperclip/issues/13640), [#14300](https://github.com/paperclipai/paperclip/issues/14300) | [#15965](https://github.com/paperclipai/paperclip/pull/15965) | [watchdog 7](docs/watchdog.md#7-holds-paperclip-can-never-release-by-itself), `pch release` |
| **Pausing an agent blocks its issues**, and resuming it doesn't undo that. | [#14528](https://github.com/paperclipai/paperclip/issues/14528), [#15506](https://github.com/paperclipai/paperclip/issues/15506) | [#14596](https://github.com/paperclipai/paperclip/pull/14596) | [watchdog 15](docs/watchdog.md#15-issues-blocked-while-their-agent-was-paused), [watchdog 6](docs/watchdog.md#6-issues-parked-because-the-assignee-couldnt-be-run) |
| **Closing an issue archives a workspace other open issues still use**: their runs fail with `setup_failed` and they end up blocked. | [#16638](https://github.com/paperclipai/paperclip/issues/16638), [#9313](https://github.com/paperclipai/paperclip/issues/9313) | - | [watchdog 8](docs/watchdog.md#8-issues-linked-to-a-closed-workspace), `pch workspace` |
| **A question card addressed to a teammate is never delivered**: its wake is cancelled as an assignee change. | [#11932](https://github.com/paperclipai/paperclip/issues/11932), [#13518](https://github.com/paperclipai/paperclip/issues/13518), [#16409](https://github.com/paperclipai/paperclip/issues/16409) | [#11939](https://github.com/paperclipai/paperclip/pull/11939), [#14378](https://github.com/paperclipai/paperclip/pull/14378), [#15991](https://github.com/paperclipai/paperclip/pull/15991), [#16914](https://github.com/paperclipai/paperclip/pull/16914) | [watchdog 10](docs/watchdog.md#10-question-cards-addressed-to-a-teammate) |
| **An answer to an agent's card is lost** when a person holds the issue (a review stage waiting on you). | - | [#14514](https://github.com/paperclipai/paperclip/pull/14514), [#10353](https://github.com/paperclipai/paperclip/pull/10353) | [watchdog 12](docs/watchdog.md#12-answers-that-reach-nobody) |
| **A cancelled blocker never releases its dependants.** | [#9811](https://github.com/paperclipai/paperclip/issues/9811) | [#11837](https://github.com/paperclipai/paperclip/pull/11837) | [watchdog 14](docs/watchdog.md#14-issues-blocked-by-a-cancelled-issue) |
| **Claude usage-limit failures are retried as transient**, or the reset time doesn't hold runs back: hundreds of failed runs before the limit resets. | [#15797](https://github.com/paperclipai/paperclip/issues/15797), [#11597](https://github.com/paperclipai/paperclip/issues/11597) | [#17013](https://github.com/paperclipai/paperclip/pull/17013) | [watchdog 16](docs/watchdog.md#16-claude-usage-limits) |
| **An agent's update wipes an issue's review stages** (`executionPolicy: { stages: [] }`), so it closes unreviewed with its PR still open. | [#17301](https://github.com/paperclipai/paperclip/issues/17301) | related: [#16431](https://github.com/paperclipai/paperclip/pull/16431), [#11145](https://github.com/paperclipai/paperclip/issues/11145) | [watchdog 17](docs/watchdog.md#17-issues-whose-review-stages-were-wiped), [relay](docs/relay.md#merging-an-issue-whose-review-stages-were-wiped) |
| **No way to approve a review stage that waits on you**: the Approve and Request changes decisions are advertised but not shown, and the decision endpoint refuses them. | [#15496](https://github.com/paperclipai/paperclip/issues/15496) | [#10277](https://github.com/paperclipai/paperclip/pull/10277), [#5487](https://github.com/paperclipai/paperclip/pull/5487) | [relay](docs/relay.md) |

## How it works

- **One container, no npm dependencies.** It calls Paperclip's API directly with a named board key, so everything it does appears in Paperclip under your name.
- **Three components, each with its own switch:** the relay receives signed GitHub webhooks, the watchdog checks every minute, and cost sync posts every 15 minutes.
- **It works through Paperclip's API, as you would in the UI:** comments, review decisions, blocker edits, pausing and resuming agents, cost events, and issues for the questions Paperclip didn't deliver. It never merges, pushes or deletes anything. On GitHub it reads pull requests and CI runs, comments on the PRs it sends back if you turn that on, re-runs failed jobs only if you name them as flaky, and re-queues a PR in the merge queue only if you turn that on.
- **`DRY_RUN=true`** makes every component log what it would do and change nothing.

## Why it saves tokens

Agents on Paperclip often poll. An agent waiting for a CI run sets a monitor that wakes it every few minutes, and each wake starts a run that reloads the agent's whole context, only to find the CI run still queued. On a subscription that is the fastest way to hit a usage limit; on an API key it costs money.

Paperclip Helper turns those waits into events. It watches GitHub and Paperclip for the agent and wakes it **once**, when something has actually changed:

- the CI run it named has finished, with the conclusion and the failed jobs in the comment;
- a card it raised was answered;
- a hand-off was dropped;
- a blocker was cancelled;
- a merge conflict appeared in the review queue.

So agents can name what they are waiting for and stop.

In one 16-agent company, before its agents were told to rely on the Helper, about 40% of the busiest implementer's runs, and a third of its input tokens, were monitor wakes that found nothing new. One instruction in the team's agent template ("name the run you're waiting for and end your run; the Helper wakes you") removed them. Your numbers will differ.

Rely on the Helper or on short monitors, not both. When the Helper reports a run, it clears the agent's own monitor if its notes name that run, so a long verification monitor doesn't wake the agent once more for nothing. A monitor still due that names something else keeps the report back ([watchdog 11](docs/watchdog.md#11-ci-runs-an-agent-waits-on)). If you keep monitors, space them widely (30 minutes or more).

## Quick start

You need a self-hosted Paperclip and Docker with Compose v2 **on the same machine**, and a Paperclip board user.

**Linux and macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.sh | bash
```

**Windows (PowerShell 5.1 or 7):**

```powershell
irm https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.ps1 | iex
```

The installer finds Paperclip, logs in with an approval link, asks which components you want, and adds the `pch` command. It shows everything before it writes it, never uses `sudo` or administrator rights, and can be re-run at any time to change settings.

What it does step by step, unattended and manual installs, networking and the GitHub webhook: **[docs/install.md](docs/install.md)**.

## The three components

### Relay: GitHub → your decisions in Paperclip

| On GitHub | In Paperclip |
|---|---|
| **You merge** the PR | The issue is **approved**, including each consecutive stage that is waiting on you. |
| **You "Request changes"**, or comment `/changes …` | **Changes requested**: back to the engineer, with your text as the brief. |
| **You comment `/approve …`** | Approved without merging. |
| **You comment** anything else | Copied to the issue, which wakes the assignee. |
| **A merge leaves another open PR with conflicts** (optional, needs a GitHub token) | That PR's issue goes **back to its agent** to resolve them, and the PR gets a comment saying so. |
| **The merge queue drops a PR** (needs a GitHub token) | A failed check sends it back to its agent; a cancelled run or the queue's timeout is told to you. |
| **A PR opens, closes or is merged by someone else** | A note in the issue's **Pull requests** document, which wakes nobody. |

It acts only on events signed with your webhook secret, from your repositories, by your GitHub login, and only when Paperclip says the decision is waiting on *you*. Otherwise it comments. Details and settings: **[docs/relay.md](docs/relay.md)**.

### Watchdog: wake stalled work

Most stalls start the same way: an issue changes hands, Paperclip cancels a run at that moment, and the next wake is refused and never retried. Every minute the watchdog looks for the situations in the tables above. It acts only after an issue has been quiet for three minutes, at most twice per situation, and never interrupts a running run. A hold Paperclip can never release by itself is released once its run has been over for three minutes; a hold whose cause it can't be sure of is logged and left to you. A link to a closed workspace, which fails every run at setup, is cleared at once. At a Claude usage limit it pauses agents only once they are idle, and resumes only those it paused. Details and settings: **[docs/watchdog.md](docs/watchdog.md)**.

### Cost sync: what your subscription runs would have cost

Paperclip records $0 for runs billed to a subscription. Cost sync posts one cost event per finished subscription run and never touches runs billed to an API key. The amounts count toward budgets and cost events can't be deleted, so **preview with `pch costs` first**; it changes nothing. Details and settings: **[docs/cost-sync.md](docs/cost-sync.md)**.

## Commands

`pch <command>` runs a throwaway container next to the service.

| Command | What it does |
|---|---|
| `pch status` | What the service is doing, its last checks and counts, Paperclip's version and build commit, and when the key expires. |
| `pch check [ISSUE]` | Who the key belongs to, its companies and prefixes. With an issue, its stage, current participant, and whether a merge would approve it. |
| `pch why ISSUE` | Why nobody is working on an issue, and what to do about it. `--prompt` prints it as a prompt for an LLM chat. |
| `pch blocked` | Why each blocked issue is blocked, which issues the chains of blocked issues end at and what those wait on, and every question card that is waiting. |
| `pch approve ISSUE [comment]` | Approves an issue whose approval is waiting on you. It refuses otherwise. |
| `pch changes ISSUE comment` | Requests changes. The comment is required and becomes the brief. |
| `pch comment ISSUE text` | Comments as you, which wakes the assignee. |
| `pch answer ISSUE CARD text` | Answers a question card as you (a card with one question). |
| `pch workspace ISSUE [--apply]` | Gives an issue linked to a closed workspace, or to another issue's, a new isolated workspace. With a closed one, also the other open issues linked to it. It previews unless you pass `--apply`. |
| `pch release ISSUE [--apply]` | Releases an execution hold that messages and Interrupt can't clear, then delivers the saved messages. It previews unless you pass `--apply`. |
| `pch worktrees [--apply]` | Closes the workspaces of finished issues so Paperclip removes their git worktrees, leaving those that may hold work. It previews unless you pass `--apply`. |
| `pch usage [--days N] [--agent NAME]` | Where the tokens go: each agent's runs, tokens, cost and what woke it, and the agents worth a look. |
| `pch costs` | Previews what cost sync would post, and what it does to budgets. |
| `pch costs --sessions` | Checks whether resumed sessions report cumulative costs (see [cost sync](docs/cost-sync.md)). |
| `pch models` | Every agent's adapter, model, effort and status. |
| `pch set-model FROM TO [--apply]` | Moves every agent on model `FROM` to `TO`. It previews unless you pass `--apply`. |
| `pch login`, `pch revoke` | Create the helper's key; revoke and delete it. |
| `pch secret` | Prints a random webhook secret. |
| `pch update` | Updates the helper to the latest release of its major version, and restarts it (see [Upgrading](docs/install.md#upgrading)). It doesn't update Paperclip. |
| `pch version`, `pch help` | Version, and this list. |

Examples and sample output: **[docs/commands.md](docs/commands.md)**.

## Security

- **The key acts as you.** Every change the helper makes appears in Paperclip under your name, just like your own actions. The key is a named board API key, `paperclip-helper`, that lasts `KEY_EXPIRES_DAYS` (365). `pch status` shows when it expires, and the log warns you two weeks ahead.
- **Where it's stored:** `data/paperclip-token`, mode 600 on Linux and macOS. Only the container's user can read it, and it never leaves the machine.
- **Revoking it:** `pch revoke` revokes it in Paperclip and deletes the file. Run `pch login` for a new one.
- **The webhook secret** is in `.env` (mode 600 on Linux and macOS). GitHub signs every delivery with it, and unsigned or wrongly signed deliveries are rejected.
- **The GitHub token** (optional, for sending back PRs with merge conflicts or dropped by the merge queue, and for the CI runs agents wait on) is in `.env` too. Give it only the relay's repositories, "Pull requests" access and, for CI runs and merge-queue drops, "Actions: Read" ("Checks: Read" to quote a failure annotation); the helper reads pull requests and CI runs and comments on pull requests. With `WATCHDOG_CI_RERUN_JOBS` set it also re-runs the failed jobs you named as flaky ("Actions: Read and write"), and with `RELAY_REQUEUE_ON_INFRA_DROP` it re-queues PRs (a token allowed to merge); nothing else. See [the GitHub token](docs/relay.md#the-github-token).
- **Paperclip's API is never exposed.** Only the relay's path needs to be public.
- **The container** runs as a non-root user with a read-only filesystem, no capabilities, and `no-new-privileges`.
- **Logs** are one JSON line per event. Anything that looks like a key or secret is masked.
- **What it never does:** merge, push, delete, or change anything outside what's described here. Beyond comments, its edits are: the failed-finalize repair, clearing links to a closed workspace, the issues it creates (and closes) for undelivered question cards, returning an issue waiting on your review to its agent (as your "changes requested") when you answered its card meanwhile, restoring issues blocked during a pause, pausing and resuming Claude agents at a usage limit, reopening an issue closed with its PR still open (and closing one on its PR's merge), clearing an agent's monitor for a CI run it reports, and its notes document on each issue. Each has its own switch (clearing a monitor goes with `WATCHDOG_CI_RUNS`).

## Upgrading

`pch update` pulls the latest release of the helper's major version and restarts it. It never updates Paperclip. Pinning a version, upgrading without `pch`, and uninstalling: **[docs/install.md](docs/install.md#upgrading)**.

## Troubleshooting

`pch status` shows what the service is doing, `pch why ISSUE` explains a stuck issue, and `docker compose logs --tail 50` shows one JSON line per event. Symptoms and fixes: **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Compatibility

- **Paperclip versions:** tested against **Paperclip 2026.916.1** (`ghcr.io/paperclipai/paperclip:latest` on 2026-09-30) in `authenticated`/`private` mode and in `local_trusted` mode, and against **2026.1001.0**, **2026.1005.0** and **2026.1012.0** with the compatibility suite (`npm run test:compat -- <version>`, see [CONTRIBUTING.md](CONTRIBUTING.md)), which runs the helper's own code against a throwaway Paperclip of that version. The API details the helper relies on were also checked against Paperclip's `main` branch, most recently on 22 October 2026. They're written down, with source references and version-specific notes, in [docs/paperclip-internals.md](docs/paperclip-internals.md).
- **Platforms tested:** Linux with Docker Engine 29.8, and Windows 11 with Docker Desktop 4.93. On Windows, both Windows PowerShell 5.1 and PowerShell 7 were used. macOS uses the same Docker Desktop networking as Windows but hasn't been tested.

## Documentation

| Page | What's in it |
|---|---|
| [docs/install.md](docs/install.md) | What the installer does, unattended and manual installs, general settings, networking, the hostname guard, exposing the relay, upgrading, uninstalling. |
| [docs/relay.md](docs/relay.md) | Every GitHub event and what it does, how the issue is found, PRs with merge conflicts or dropped by the merge queue, the GitHub token, safety rules, the webhook, settings. |
| [docs/watchdog.md](docs/watchdog.md) | Every situation in detail, notes for the board, limits, what it leaves to you, settings. |
| [docs/cost-sync.md](docs/cost-sync.md) | How costs are worked out, what to know before turning it on, settings. |
| [docs/commands.md](docs/commands.md) | Every `pch` command, with `usage`, `blocked`, `set-model` and `why` examples. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes and fixes. |
| [docs/paperclip-internals.md](docs/paperclip-internals.md) | The Paperclip behaviour the helper relies on, with source references. |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md): the helper has no npm dependencies, and `npm test` runs the suite against a fake Paperclip.

## License

[MIT](LICENSE)
