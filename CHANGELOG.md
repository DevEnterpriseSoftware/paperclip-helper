# Changelog

## 1.3.0

- **Watchdog: holds Paperclip can never release by itself are released.** A run cut off at a hand-off, or one whose adapter failed before a process started, records no process id or stop. Paperclip then holds the issue for reconciliation ("Automatic recovery of this task stopped") and saves every message behind "The previous run has no verified stop record", for good. With `WATCHDOG_RELEASE_HOLDS` (default `true`), once the run has been over for the stall window, the watchdog records the board's reconciliation (the run stopped; what it did is unverified) and delivers the saved messages, or comments if there are none. Once per held run; a hold whose run is still active, holds a lease or recorded a process is only logged. The installers ask about it.
- **`pch release ISSUE [--apply]`:** releases an execution hold (`legacy_execution_requires_reconciliation`) whose run recorded no process or stop, e.g. one cut off at a hand-off. Paperclip can never prove such a run stopped, so messages and Interrupt were saved behind it indefinitely. The command records the board's reconciliation (run stopped, outcome unverified by default) and delivers the saved messages. It previews unless you pass `--apply`.
- **Compatibility suite:** Paperclip 2026.916.1, 2026.1001.0 and 2026.1005.0 pass. It reproduces a hold Paperclip can't release by itself (an agent whose command doesn't exist) and checks that the watchdog releases it and the saved message then starts the owner. Its test agents now run Node instead of `sh`, so the suite also runs on Windows, and it no longer waits out 2026.1005.0's minute-later retry of runs that leave no disposition.
- **`pch why`:** recommends `pch release` for that hold, instead of a message and Interrupt, which can't release it.
- **`pch status`:** shows Paperclip's version and build commit on the "Paperclip:" line, e.g. `(2026.1001.0, commit 8f8a0ab)`. Paperclip reports them only to an authenticated caller, so the helper asks with its key.

## 1.2.1

- **Every message the helper posts says so.** Comments and decisions end with one italic line naming Paperclip Helper, so you can tell at a glance where a message came from: *Relayed from GitHub by Paperclip Helper.* on what the relay copies from GitHub (merges, reviews, PR comments, opened PRs), *Sent automatically by Paperclip Helper.* on what it sends by itself (PRs with merge conflicts, and its comments on those PRs), and *Sent with Paperclip Helper (`pch`).* on `pch approve`, `pch changes` and `pch comment`. The watchdog's messages already ended with their own line and nudge count.

## 1.2.0

- **Relay: PRs with merge conflicts go back to their agents by themselves.** With many small PRs, each merge can leave other open PRs conflicting with the base branch, and they then wait for a review you can't finish. With `RELAY_FIX_CONFLICTS=true` and a `GITHUB_TOKEN`, the relay looks at the other open PRs after every merge (and every 15 minutes, in case a webhook was missed). For each one GitHub says conflicts, it requests changes on the PR's issue when its review is waiting on you, or comments on it otherwise, with a brief to bring the branch up to date, resolve the conflicts and push. It says so in a comment on the PR, so you can see it was already sent back.
  - A PR is sent back once per push, and after `RELAY_CONFLICT_MAX_ATTEMPTS` (2) pushes that still conflict it is left to you, with a note on the PR. Drafts, PRs that name no Paperclip issue, and PRs whose issue is done or cancelled are skipped.
  - Off by default. The installer asks about it and for the token; [docs/relay.md](docs/relay.md#the-github-token) has the steps to create one. `pch check` tests that the token can read your repositories, and `pch status` counts the PRs sent back.
  - The helper still never merges, pushes, closes or deletes anything. The token is used to read pull requests and to comment on them.
- **Logs:** GitHub tokens are masked, like Paperclip keys.

## 1.1.2

- **`pch why`:** ends with a recommendation: what is holding the issue, the steps or commands that get it moving, and whether the watchdog does it by itself. It also shows the latest comment, an issue Paperclip's recovery parked, and saved messages that are waiting. `pch why ISSUE --prompt` prints all of it, with the last three comments, as a prompt for an LLM chat.
- **Watchdog:** an issue Paperclip's recovery parked because it couldn't run the assignee (`stranded_assigned_issue`: "Automatic recovery blocked … the original assignee is not invokable", typically after agents were paused) is un-parked once the agent is available: the watchdog delivers its saved messages, or comments on it. Any other kind of recovery action is reported once and left to you. Paperclip reports these as recovery actions, not as an execution hold, so the 1.1.0 release of holds never saw them.

## 1.1.1

- **Relay:** when no issue the PR names, nor any of their subtasks, is waiting on you, the relay also looks at the issues blocking them and at deeper subtasks. A merge of a PR that names a blocked issue now approves the blocker in review, instead of only commenting on the blocked issue. The result says how it was found (`via: "blocks ACM-12"`). An issue the PR names, or its subtask, still wins when it is waiting.

## 1.1.0

- **Compatibility suite:** `npm run test:compat -- <version>` boots a throwaway Paperclip of that version and runs the helper's own code against it: every endpoint, the response fields it reads, and the watchdog, relay, cost sync and commands end to end. CI runs it on every push and daily against Paperclip's latest release. Paperclip 2026.916.1 and 2026.1001.0 both pass.
- **Watchdog:** a recovery hold left by a hand-off ("Automatic recovery blocked", with the issue marked blocked and a saved message waiting) is released by delivering the saved messages to the current owner, as the board's Interrupt button does. Only when the held run was cancelled by a reassignment, and only with `WATCHDOG_RETRY_DEFERRED` on; any other hold is reported once and left to you.
- **Watchdog:** the failed-clean-up repair waits while the issue's assignee is paused, terminated or awaiting approval. Moving the issue to `todo` for an agent Paperclip can't invoke made its recovery block the issue again for a board decision.
- **`pch why`:** shows an execution hold and its next action, and says "none linked" instead of "all done" when an issue has no blockers.
- **`pch update`:** updates the helper to the latest release of its major version, restarts it if the image changed, and refreshes the `pch` script itself. It runs on the host, so the installer now writes `pch.sh` (or `pch.ps1`) to the install directory and points `pch` at it. Re-run the installer once to get it. It doesn't update Paperclip.

## 1.0.2

- **Watchdog:** a run Paperclip cancelled before it started (`execution_reconciliation_required`, after a hand-off) no longer counts as the owner having picked the issue up. Once the hold has cleared, the owner is nudged; while it is still in place, the watchdog waits.

## 1.0.1

- **Relay:** a merge that approves an escalated review stage also approves the approval stage after it when that is yours too, so the issue reaches `done`. The result's `status` is read back from Paperclip, with a `warning` when the issue didn't land where it was sent.
- **Watchdog:** nudge comments name paperclipai/paperclip#13880 without a link, so Paperclip no longer lists that PR on every nudged issue.

## 1.0.0

First public release, as a published image with installers for Linux, macOS and Windows.

- **Relay:**
  - Merging a PR approves the Paperclip issue waiting on you. Request changes and `/changes` send it back, and your other comments are copied.
  - A merge that names a parent issue approves the subtask waiting on you. If several wait and none lists the PR, it comments instead of guessing.
  - A newly opened PR's URL is posted on its issue, so Paperclip links it (`RELAY_LINK_PRS`).
  - The relay turns itself on when its GitHub settings are set.
  - Issue prefixes are read from your companies when `ISSUE_PREFIXES` is empty.
- **Watchdog:**
  - Dropped hand-offs, blocked issues whose blockers are done, and blockers stuck on a failed workspace clean-up.
  - Nudges are spaced by the stall window, and their counts survive restarts.
  - Paused tasks, and agents that are paused, terminated or awaiting approval, are left alone.
  - A wake deferred behind a stuck run is reported once. `WATCHDOG_RETRY_DEFERRED` asks Paperclip to retry it through its "send queued messages now" action. Only the assignee's own wakes count, so a wake deferred for the previous owner, or one that later runs have overtaken, doesn't hide a dropped hand-off.
  - `pch why` shows the assignee and which agent each wake is for.
- **Cost sync:**
  - Subscription runs only. The installer previews it and asks; `.env.example` leaves it off, and unattended installs sync only new runs unless given `COST_SYNC_SINCE`.
  - Codex runs are priced from tokens with a dated OpenAI price table (`prices.json` to extend it). Fast mode is read from each run's own record.
  - Runs by agents that were since terminated are still synced.
  - Fractions of a cent are carried per agent and model instead of being rounded away.
  - The preview shows budget impact.
  - Idempotent across crashes, with a guard against a lost or unreadable state file.
- **Commands:** `status`, `check`, `why`, `approve`, `changes`, `comment`, `costs` (and `costs --sessions`), `models`, `set-model`, `login`, `revoke`, `secret` and `version`.
- **Robustness:**
  - Request timeouts, safe retries, and clear errors for Paperclip's hostname guard and for expired keys.
  - Config validation with one line per problem.
  - `LOG_LEVEL`, and masked secrets in logs.
  - Graceful shutdown, and an hourly identity refresh.
