# Troubleshooting

Start with `pch status` and, for a stuck issue, `pch why ISSUE`.

| Symptom | Cause and fix |
|---|---|
| `Paperclip refused the hostname …` | [The hostname guard](install.md#paperclips-hostname-guard-http-403): allow the hostname, or use host networking. |
| `cannot reach Paperclip at http://127.0.0.1:3100` | From a container, `127.0.0.1` is the host only with `network_mode: host`. Check `PAPERCLIP_API`, or re-run the installer. |
| `Paperclip rejected the helper's board key` | It expired or was revoked. Run `pch login`. |
| `config: …` lines, and the container restarts | A setting is missing or invalid. The line names it. |
| Deliveries show 401 in GitHub | The webhook secret doesn't match `GITHUB_WEBHOOK_SECRET`. |
| A delivery failed with `Task is paused` | Paperclip refuses comments on a paused task. Resume it, then **Redeliver** in GitHub. |
| Deliveries show `names no ACM issue` | The PR's title, branch and body contain no issue identifier. |
| A **`/changes` or `/approve` did nothing** you can see | It reached the relay, but the PR's issue wasn't waiting on you, so your text was copied to the first issue the PR names as a comment. With a GitHub token the relay replies on the PR saying which issue and why. Record the decision with `pch changes ISSUE "…"`. |
| A merge only comments (`decision is not waiting on you`) | The approval stage isn't pending on your user. `pch check ISSUE` shows who it's waiting on. |
| A merge leaves the issue **in review**, "Approval pending with You" | The merge approved an earlier stage of yours and the next one belongs to someone else, or the relay is older than 1.0.1. The delivery's response has a `warning` naming who it's waiting on. |
| A PR has **merge conflicts** after you merged another | Turn on [`RELAY_FIX_CONFLICTS`](relay.md#prs-with-merge-conflicts) and the relay sends it back for you. Without it, comment `/changes Merge main and resolve the conflicts` on the PR. |
| A conflicting PR **wasn't sent back** | Look for `relay: conflict sweep` in the log: each PR it left alone has a `reason` (a draft, names no issue, already sent back and waiting for a push, attempts used up). `pch check` tests the token. GitHub can take a minute to notice a conflict; the next look picks it up. |
| The log says **could not comment on the PR** | The token can read but not write. Give it "Pull requests: Read and write", or set `RELAY_CONFLICT_PR_COMMENT=false`. The PR was still sent back. |
| Every run fails at once with **`setup_failed`: "requested inherited execution workspace reuse … could not be restored"** | The issue is linked to a closed workspace, usually that of the issue it was created from. Run `pch workspace ISSUE --apply`, then comment to restart the assignee. See [`workspace`](commands.md#workspace-an-issue-linked-to-the-wrong-workspace). |
| An agent blocks an issue asking for a **"workspace ruling"**, or says it would commit on another issue's branch | The issue is linked to another issue's live workspace. If it should have its own branch and PR, run `pch workspace ISSUE --apply` and say so in a comment. |
| `pch workspace` says **Paperclip ignores workspace changes** | Turn on Instance settings → Experimental → Enable Isolated Workspaces. |
| An issue is **blocked with nothing in "Blocked by"** | Either an agent blocked it with a note of its own, or Paperclip's recovery did. `pch why ISSUE` shows an execution hold if there is one; see [what the watchdog leaves to you](watchdog.md#what-it-leaves-to-you). |
| An agent **runs every few minutes** and posts the same "Blocked: …" note | It's waiting on something only you can do, usually an approval. Decide it, or pause the issue. |
| "**The original assignee is not invokable**" | The agent, or one above it in the org chart, was paused, terminated or awaiting approval when Paperclip's recovery ran. Resume it. If the agent itself was paused, the watchdog restores its issues blocked during the pause ([15](watchdog.md#15-issues-blocked-while-their-agent-was-paused)); others it un-parks with a comment; `pch why ISSUE` gives the command to do it yourself. |
| **Claude agents paused by themselves** | A Claude usage limit: the watchdog paused the agents on that account ([16](watchdog.md#16-claude-usage-limits)). The log (and `WATCHDOG_NOTIFY_ISSUE`) says until when; they are resumed a few minutes after the reset. Resume one yourself whenever you like; `WATCHDOG_LIMIT_PAUSE=false` turns it off. |
| An issue the agent closed **was reopened by the watchdog** | It closed while its own PR was still open, after an agent's update wiped its review stages ([17](watchdog.md#17-issues-whose-review-stages-were-wiped)). Restore its review stages; the watchdog doesn't re-create them. |
| A PR **dropped from the merge queue** wasn't sent back | The queue removed it for a cancelled run or its status-check timeout, not a failed check, so the relay told the board instead ([relay](relay.md#prs-the-merge-queue-drops-without-a-conflict)). Queue it again. The log line `relay: merge-queue drop` says what it found. |
| An agent's **monitor disappeared** after a CI report | Its notes named only the run the watchdog reported, so it was cleared in the same step ([11](watchdog.md#11-ci-runs-an-agent-waits-on)): it would only have woken the agent to find the run finished. |
| Where did the **"PR #12 opened by …" comments** go? | Into the issue's **Pull requests** document, which wakes nobody (`RELAY_QUIET_NOTES`). |
| **Answering a card through the API is refused** ("requires an answer") | Send a typed answer as `otherText`, not `text`, or use `pch answer ISSUE CARD "…"`. |
| No PR rows on the issue | Turn on **Instance settings → Experimental → External Objects**. |
| Codex costs missing | Look for `pch costs` lines such as `model unknown` or `no price for …`, then set `CODEX_DEFAULT_MODEL` or add the model to `prices.json`. |
| Anything else | `docker compose logs --tail 50`. There's one JSON line per event; `LOG_LEVEL=debug` shows more. |

---

[← Back to the README](../README.md)
