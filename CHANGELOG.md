# Changelog

## 1.1.0

- **Watchdog:** a recovery hold left by a hand-off ("Automatic recovery blocked", with the issue marked blocked and a saved message waiting) is released by delivering the saved messages to the current owner, as the board's Interrupt button does. Only when the held run was cancelled by a reassignment, and only with `WATCHDOG_RETRY_DEFERRED` on; any other hold is reported once and left to you.
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
