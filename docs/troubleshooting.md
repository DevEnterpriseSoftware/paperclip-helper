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
| A merge only comments (`decision is not waiting on you`) | The approval stage isn't pending on your user. `pch check ISSUE` shows who it's waiting on. |
| A merge leaves the issue **in review**, "Approval pending with You" | The merge approved an earlier stage of yours and the next one belongs to someone else, or the relay is older than 1.0.1. The delivery's response has a `warning` naming who it's waiting on. |
| A PR has **merge conflicts** after you merged another | GitHub sends no event for that. Comment `/changes Rebase onto main and resolve the conflicts` on the PR to send the issue back. |
| An issue is **blocked with nothing in "Blocked by"** | Either an agent blocked it with a note of its own, or Paperclip's recovery did. `pch why ISSUE` shows an execution hold if there is one; see [what the watchdog leaves to you](watchdog.md#what-it-leaves-to-you). |
| An agent **runs every few minutes** and posts the same "Blocked: …" note | It's waiting on something only you can do, usually an approval. Decide it, or pause the issue. |
| "**The original assignee is not invokable**" | The agent, or one above it in the org chart, was paused, terminated or awaiting approval when Paperclip's recovery ran. Resume it, then message the agent on the issue. |
| No PR rows on the issue | Turn on **Instance settings → Experimental → External Objects**. |
| Codex costs missing | Look for `pch costs` lines such as `model unknown` or `no price for …`, then set `CODEX_DEFAULT_MODEL` or add the model to `prices.json`. |
| Anything else | `docker compose logs --tail 50`. There's one JSON line per event; `LOG_LEVEL=debug` shows more. |

---

[← Back to the README](../README.md)
