# Paperclip Helper

A small companion service for self-hosted [Paperclip](https://github.com/paperclipai/paperclip). It runs as one container beside Paperclip and calls Paperclip's API with a board key of your own.

- **Relay:** merging an agent's pull request approves its issue.
- **Watchdog:** wakes agents whose work Paperclip left stalled.
- **Cost sync:** puts what your subscription runs would have cost on Paperclip's Costs page.
- **`pch` commands:** answer "why is nobody working on this?" and bulk-change agent models.

> Paperclip Helper is an independent project. It is not made by or affiliated with the Paperclip team.

## What it fixes

| In Paperclip you see… | The helper… |
|---|---|
| **"Approval pending with You"**, and no Approve button. A decision is a status change *plus* a comment in the same request, and the issue page has no button for that. Paperclip's own Approve button appears only on stalled reviews. | **Relay.** Merge the PR on GitHub and the issue is approved. **Request changes** on GitHub sends it back to the engineer, with your review as the brief. |
| **Agents stop at hand-offs**, and **blocked issues can stay blocked** after their blockers are done. | **Watchdog.** It finds issues whose wake Paperclip dropped and wakes the right agent with a comment. It also repairs blockers stuck on a failed workspace clean-up. |
| **The Costs page shows $0** because your agents run on a Claude or ChatGPT subscription. | **Cost sync.** It posts each run's API-equivalent cost: Claude Code's own figure, and for Codex, tokens × OpenAI list prices. |
| **The model drop-down doesn't list** a new model id. | **`pch set-model`** moves every agent from one model to another and keeps the rest of their config, effort included. |
| **"Why is nobody working on this?"** | **`pch why ISSUE`** prints Paperclip's own diagnosis, ready to paste into an LLM chat. |
| **An issue lists the wrong PR**, or none. | **Relay.** It posts the PR's URL on its issue when the PR opens, so Paperclip links it. |

What the helper relies on in Paperclip, and how each part was checked, is in [docs/paperclip-internals.md](docs/paperclip-internals.md).

## Quick start

You need a self-hosted Paperclip and Docker with Compose v2 **on the same machine**. On Linux that means Docker Engine; on Windows and macOS, Docker Desktop or similar. You also need a Paperclip board user.

**Linux and macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.sh | bash
```

**Windows (PowerShell 5.1 or 7):**

```powershell
irm https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.ps1 | iex
```

The installer shows everything before it writes it, and you can re-run it at any time to change settings. It keeps your key and webhook secret. It never uses `sudo` or administrator rights.

### What the installer does

1. **Checks Docker** and Compose v2, and warns if your `docker` talks to a remote engine.
2. **Asks where to install:** `~/paperclip-helper` by default, or `%USERPROFILE%\paperclip-helper` on Windows.
3. **Finds Paperclip.** It tries `127.0.0.1:3100`, published ports of Paperclip containers, their Docker networks, and `host.docker.internal`. Each is probed from inside a throwaway helper container, so the network path is the real one. If Paperclip refuses the hostname, it prints the fix (see [the hostname guard](#paperclips-hostname-guard-http-403)).
4. **Asks for Paperclip's public URL:** the address you open in a browser.
5. **Logs in.** It prints an approval link, you approve it in Paperclip, and it saves a named board key.
6. **Asks about each component:**
   - **Relay** (default: yes): your GitHub login, the repositories, and the issue prefixes (detected from your companies). Then it asks whether to post new PRs' URLs, and the port and path. It generates the webhook secret.
   - **Watchdog** (default: yes): its timing, if you want to change it, and its two repairs: blockers stuck on a failed clean-up, and wakes deferred behind a stopped run.
   - **Cost sync** (default: yes): it shows `pch costs` first, and whether to include runs that already finished.
7. **Writes `compose.yml`, `.env` (mode 600 on Linux and macOS) and `data/`**, then starts the service and shows its first log lines.
8. **Sets up the webhook.** It checks your public webhook URL. It can create the GitHub webhook with `gh`; otherwise it prints the manual steps.
9. **Adds the `pch` command:** an alias in `~/.zshrc` or `~/.bashrc` (`~/.bash_profile` on macOS), or a function in your PowerShell profile.

### Unattended install

Set `PCH_NONINTERACTIVE=1` and pass answers as environment variables.

| Variable | Meaning |
|---|---|
| `PCH_DIR` | Install directory. |
| `PAPERCLIP_API` | Paperclip's API URL. Skips discovery if it answers. |
| `PCH_NETWORK` | The network for that URL: `host`, `bridge`, or `net:<docker network>`. |
| `PAPERCLIP_PUBLIC_URL` | The address you open Paperclip at. |
| `PCH_TOKEN` | An existing board key. Without it, the installer still prints the approval link and waits. |
| `GITHUB_OWNER_LOGIN`, `GITHUB_REPOS` | `GITHUB_OWNER_LOGIN` turns the relay on, and then `GITHUB_REPOS` is required. |
| `COST_SYNC_SINCE` | Cost sync posts only runs that finish after the install, because nobody saw the preview. Pass an earlier ISO 8601 time to include past runs, or `1970-01-01T00:00:00Z` for all of them. |
| Any other setting the installer asks about, such as `ISSUE_PREFIXES`, `WATCHDOG` or `COST_SYNC` | Used as the answer. Add other settings from [`.env.example`](.env.example) to `.env` afterwards; re-runs keep them. |
| `PCH_WEBHOOK_URL` | The public webhook URL to test. |
| `PCH_IMAGE` | Another image or tag. |
| `PCH_NO_ALIAS=1` | Don't add `pch`. |

```bash
curl -fsSL …/install.sh | PCH_NONINTERACTIVE=1 GITHUB_OWNER_LOGIN=me GITHUB_REPOS=me/app bash
```

### Manual install

The published `compose.yml` uses host networking, so this is for Linux; on Docker Desktop, use the installer. Cost sync stays off until you set `COST_SYNC=true` in `.env`, so preview it with `pch costs` first.

```bash
mkdir -p ~/paperclip-helper/data && cd ~/paperclip-helper
curl -fsSLO https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/compose.yml
curl -fsSL https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/.env.example -o .env
chmod 600 .env && nano .env                 # PAPERCLIP_API, PAPERCLIP_PUBLIC_URL, PCH_UID/PCH_GID (id -u / id -g)
docker compose run --rm helper login        # approve the link in Paperclip
docker compose up -d
```

## The relay: GitHub → your decisions in Paperclip

In Paperclip, the current participant of a review or approval stage records a decision by changing the issue's status **with a comment in the same request**. `done` approves. Any other status, typically `in_progress`, requests changes and returns the issue to the engineer. The relay receives signed GitHub webhooks and records that decision for you:

| On GitHub | In Paperclip |
|---|---|
| **You merge** the PR | The issue is **approved**: `done`, with a comment naming the PR and merge commit. |
| **You "Request changes"** in a review | **Changes requested**: `in_progress` and back to the engineer, with your review text as the brief. |
| **You comment `/changes …`** on the PR, or start a review with it | Same as Request changes. |
| **You comment `/approve …`** on the PR, or start a review with it | Approved without merging. |
| **You approve** the PR in a GitHub review | Nothing. Merging is the approval. |
| **You comment** or review anything else | Your text is copied to the issue as a comment, which wakes the assignee. |
| **Someone else merges**, or the PR is **closed** without merging | A comment only. |
| **The PR is opened, reopened or marked ready for review** | Its URL is posted on the issue, so Paperclip links the PR (`RELAY_LINK_PRS`). |

Every delivery's response body says what the relay did, for example `{"identifier":"ACM-2","action":"approve","status":"done"}`. You can see it in GitHub's webhook **Recent Deliveries**, and **Redeliver** retries a delivery that failed.

**Finding the issue.** The relay collects every issue identifier (`ACM-12`) in the PR's title, branch name and body, and adds each issue's subtasks. It then acts on the one whose approval is waiting on you. A PR often names the *parent* issue, because its branch comes from the parent's workspace, while the review stages sit on a *subtask*. If several are waiting, it prefers the one that lists this PR as a work product; if none does, it comments instead of guessing. If none is waiting on you, it only comments on the first issue named.

**Safety:**

- Only events signed with your webhook secret (HMAC-SHA256, compared in constant time) are accepted.
- Only repositories in `GITHUB_REPOS` are accepted.
- Only `GITHUB_OWNER_LOGIN` can approve or request changes. Anyone else's reviews and comments are ignored, and their merges only produce a comment.
- A decision is recorded only when Paperclip says it's waiting on *you*; otherwise the relay comments.
- The relay never merges, pushes or deletes anything.

**GitHub won't let you "Request changes" on your own PR.** If your agents open PRs with your own token, comment `/changes …` instead.

**Where to see what's waiting on you.** The Dashboard's "Pending Approvals" and the Approvals page list *formal* approval requests, such as agent hires and budget overrides, not review stages. To see reviews waiting on you, turn on **Instance settings → Experimental → Decisions**.

### Why an issue can show the wrong PRs

Paperclip builds an issue's "GitHub Pull Request" rows from full `github.com/<owner>/<repo>/pull/<n>` URLs anywhere in the issue's text. Agents usually write "PR #16", which links nothing, and a PR URL quoted from another issue shows up as if it belonged to this one. The relay posts the real PR's URL when the PR opens, so **the issue's latest "PR #N opened" comment is the one to trust.** The rows only appear with **Instance settings → Experimental → External Objects** turned on.

### Relay settings

| Setting | Default | Meaning |
|---|---|---|
| `RELAY` | unset | Unset: on when any of the three GitHub settings is set, and then all three are needed. `true`: required. `false`: off. |
| `GITHUB_WEBHOOK_SECRET` | none | The secret the GitHub webhook signs with. **Required.** |
| `GITHUB_OWNER_LOGIN` | none | Your GitHub login. **Required.** |
| `GITHUB_REPOS` | none | Comma-separated `owner/repo` list. **Required.** |
| `ISSUE_PREFIXES` | every company's own | Prefixes to look for, such as `ACM,OPS`. |
| `RELAY_LINK_PRS` | `true` | Post a newly opened PR's URL on its issue. |
| `RELAY_HOST`, `RELAY_PORT`, `RELAY_PATH` | `127.0.0.1`, `3110`, `/hooks/github` | Where the relay listens. |

**The GitHub webhook:**

- **Payload URL:** your public URL plus `RELAY_PATH`.
- **Content type:** `application/json`.
- **Secret:** `GITHUB_WEBHOOK_SECRET`.
- **Events:** **Pull requests**, **Pull request reviews** and **Issue comments**. "Pull requests" already includes opened, reopened and ready-for-review.

The installer can create it with `gh`. If `gh` answers 404, run `gh auth refresh -h github.com -s admin:repo_hook`.

## The watchdog: wake stalled work

Every `WATCHDOG_INTERVAL_SEC`, for every company your key can see, the watchdog looks for three situations Paperclip doesn't recover from by itself.

**1. Dropped hand-offs** (`todo`, `in_progress`, `in_review`). When an issue changes hands, for example engineer → reviewer, Paperclip cancels the finishing run. That run still holds its environment lease for a minute or two. The new owner's wake is refused ("has not released its environment lease") and nothing retries it: [paperclipai/paperclip#13880](https://github.com/paperclipai/paperclip/pull/13880).

The watchdog looks for an issue where all of these hold:

- An agent owns it, and nothing is running or checked out on it.
- The latest run belongs to someone else and ended at least `WATCHDOG_STALL_SEC` ago.
- The owner isn't paused, terminated or waiting for approval.
- Paperclip has no wake queued for it.

It then comments on the issue, which wakes the assignee. While a task is paused, Paperclip refuses comments, so the watchdog waits until it's resumed.

**2. Blocked issues whose blockers are all done.** Paperclip should wake the assignee with `issue_blockers_resolved`, but that wake can be dropped the same way. Once the issue has been quiet for the stall window, it gets the same kind of comment. A comment on a blocked issue whose blockers are done also moves it back to `todo`; this was verified against Paperclip 2026.916.1.

**3. Done blockers whose workspace clean-up failed.** If a run is cancelled while syncing its workspace back, Paperclip records the `workspace_finalize` as failed and never retries it. It then counts that done blocker as unresolved forever, and skips every wake for the dependent issue. With `WATCHDOG_HEAL_FAILED_FINALIZE` on, the watchdog does the following once the failure is older than the stall window:

- It removes those blockers from the dependent's **Blocked by**.
- If nothing else blocks the dependent, it moves it to `todo`.
- It comments to explain why, and tells the agent to pull the branch first.

Each nudge mentions the assignee and says what stalled. Each situation gets at most `WATCHDOG_MAX_NUDGES` comments, spaced by the stall window. The counts are kept in `data/state.json`, so a restart doesn't re-nudge.

**When a comment can't help.** Paperclip sometimes defers even the nudge's wake, because an earlier run still holds execution. The watchdog then logs one warning instead of repeating itself, and `pch status` counts the issue. `pch why ISSUE` shows the runs and their lease state.

With `WATCHDOG_RETRY_DEFERRED` on, the watchdog also presses Paperclip's own **send queued messages now** for that issue, at most `WATCHDOG_MAX_NUDGES` times, spaced by the stall window. Paperclip then retries the stopped run's lease clean-up once and re-sends the saved comments. The watchdog does this only when the deferred wake carries saved comments and targets no running run, so it never interrupts work. A lease that was never released, or an old process that's still alive, needs a manual look. This retry has been checked against Paperclip's source but not yet against a live instance.

| Setting | Default | Meaning |
|---|---|---|
| `WATCHDOG` | `true` | `false` turns it off. |
| `WATCHDOG_INTERVAL_SEC` | `60` | How often it checks (at least 15). |
| `WATCHDOG_STALL_SEC` | `180` | How long an issue must be quiet before it acts. |
| `WATCHDOG_MAX_NUDGES` | `2` | Comments per stalled situation, and retries per deferred wake. |
| `WATCHDOG_HEAL_FAILED_FINALIZE` | `true` | Repair blockers stuck on a failed clean-up. This edits the issue's **Blocked by**. |
| `WATCHDOG_RETRY_DEFERRED` | `true` | Ask Paperclip to retry a wake deferred behind a stopped run (see above). |

`DRY_RUN=true` makes every component log what it would do and change nothing.

## Cost sync: what your subscription runs would have cost

Paperclip deliberately records **$0** for runs billed to a subscription (`billingType: subscription_included`). If your agents use a Claude or ChatGPT plan, the Costs page stays empty.

For each finished subscription run, cost sync posts one extra cost event with the run's API-equivalent cost:

- **Claude Code** (`claude_local`) reports that figure itself, and Paperclip keeps it on the run.
- **Codex** (`codex_local`) reports only tokens. The cost is estimated from the run's model and OpenAI's list prices, with cached input at the cached rate and fast mode doubled. The price table ([`src/prices.mjs`](src/prices.mjs)) was checked on 2026-09-30.
  - Add or override models with a `prices.json` in the data directory.
  - Codex runs on the default model have no recorded model. Set `CODEX_DEFAULT_MODEL` to price them; otherwise they're skipped.

**What it never touches:** runs billed to an API key (`metered_api`), which already carry their real cost, and adapters not listed in `COST_SYNC_ADAPTERS`.

Each event has zero tokens (the run's own event counted them), the run's id, provider, biller and model, and the run's finish time. Token totals, run counts, project attribution and monthly totals therefore stay right.

**Before you turn it on:**

- **The amounts count toward budgets.** A company or agent budget with a hard stop pauses work once the synced amounts reach it. `pch costs` shows each budget before and after.
- **Cost events can't be deleted** through Paperclip's API. The helper records every run it posts in `data/cost-synced.json`, and never posts a run twice, even across crashes.
  - If `data/` is lost, it checks Paperclip's activity log for earlier posts. If it finds any, it syncs only runs that finish from then on.
- **Paperclip stores whole cents,** and a run on a cheap model can cost a fraction of one. Fractions are carried per agent and model until they add up to a cent, so totals stay within a cent of the exact sum.
- Only the most recent 1,000 runs per company are visible to it. Runs that were stopped before recording any usage can't be synced.
- The figures are estimates of API list price, not what you pay.

Preview it any time. It changes nothing:

```text
$ pch costs
Acme: not yet synced (412 runs already synced)
  Reviewer                38 runs   $    61.20
  Engineer                22 runs   $    54.87   (22 estimated from tokens)
  Total                   60 runs   $   116.07
  not synced: 3 runs, model unknown (set CODEX_DEFAULT_MODEL to price it)
  budget "Engineer" (agent, calendar_month_utc): $0.00 → $54.87 of $50.00. WARNING: this reaches the hard stop, so Paperclip would pause the agent.
```

| Setting | Default | Meaning |
|---|---|---|
| `COST_SYNC` | `true` | `false` turns it off. |
| `COST_SYNC_INTERVAL_SEC` | `900` | How often it posts (at least 60). |
| `COST_SYNC_SINCE` | none | Only runs that finished after this ISO 8601 time. |
| `COST_SYNC_ADAPTERS` | `claude_local,codex_local` | Agent adapters whose subscription runs are synced. |
| `CODEX_DEFAULT_MODEL` | none | The model to price Codex runs with when none was recorded. |
| `COST_PRICES_FILE` | `/data/prices.json` | Your own prices; the format is in `src/prices.mjs`. |

## Commands

With the alias, `pch <command>` runs a throwaway container next to the service (`docker compose run --rm helper <command>`).

| Command | What it does |
|---|---|
| `pch status` | What the service is doing, its last checks and counts, and when the key expires. |
| `pch check [ISSUE]` | Who the key belongs to, its companies and prefixes. With an issue, its stage, current participant, and whether a merge would approve it. |
| `pch why ISSUE` | Paperclip's own diagnosis of why nobody is working on an issue: wakes, blockers, workspace clean-ups, runs and leases. |
| `pch approve ISSUE [comment]` | Approves an issue whose approval is waiting on you. It refuses otherwise. |
| `pch changes ISSUE comment` | Requests changes. The comment is required and becomes the brief. |
| `pch comment ISSUE text` | Comments as you, which wakes the assignee. |
| `pch costs` | Previews what cost sync would post, and what it does to budgets. |
| `pch costs --sessions` | Checks whether resumed sessions report cumulative costs (see [Compatibility](#compatibility)). |
| `pch models` | Every agent's adapter, model, effort and status. |
| `pch set-model FROM TO [--apply]` | Moves every agent on model `FROM` to `TO`. It previews unless you pass `--apply`. |
| `pch login`, `pch revoke` | Create the helper's key; revoke and delete it. |
| `pch secret` | Prints a random webhook secret. |
| `pch version`, `pch help` | Version, and this list. |

### `set-model`: every model and effort level

`set-model` changes only `adapterConfig.model`, because Paperclip merges the change into the existing config, so effort, engine and env are kept. It re-reads each agent afterwards and flags anything that went missing.

```text
$ pch set-model claude-opus-5 claude-opus-5.5
would change Architect: claude-opus-5 → claude-opus-5.5 (effort xhigh kept)
would change Reviewer: claude-opus-5 → claude-opus-5.5 (effort high kept)

2 agent(s). Run again with --apply to change them.
```

### Debugging with an LLM

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

## Networking

The helper reaches Paperclip's API directly; it never goes through your tunnel or proxy. Paperclip's public URL is used only for the approval link `pch login` prints.

| Paperclip runs… | Helper networking | `PAPERCLIP_API` | Tested |
|---|---|---|---|
| In Docker on Linux, port published on the host | `network_mode: host` | `http://127.0.0.1:<published port>` | Yes |
| Natively on Linux, including `local_trusted` mode | `network_mode: host` | `http://127.0.0.1:3100` | Yes |
| In Docker on the same host, port **not** published | Joins Paperclip's network; the relay port is published on `127.0.0.1` | `http://<service>:3100` (allow the hostname) | Yes |
| Docker Desktop on Windows or macOS | Bridge network; the relay port is published on `127.0.0.1` | `http://host.docker.internal:3100` (allow the hostname), or Paperclip's own network if it's a container | Windows: yes. macOS: not yet |

The installer picks the row for you.

### Paperclip's hostname guard (HTTP 403)

Paperclip refuses requests addressed to a hostname it doesn't know, with:

```text
This hostname is not allowed for this Paperclip instance. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.
```

`localhost`, `127.0.0.1` and `::1` are always allowed, which is why host networking needs no setup. Any other name must be allowed where Paperclip runs:

- **Paperclip installed natively:** run `npx paperclipai allowed-hostname <host>`, then restart Paperclip.
- **Paperclip in a container:** set `PAPERCLIP_ALLOWED_HOSTNAMES=<host>` in its environment and recreate it. This variable *replaces* the config file's list, so include any hostnames you already allowed.

The helper and the installer recognise this 403 and print the hostname to allow.

### Letting GitHub reach the relay

GitHub needs HTTPS access to **one path**, `RELAY_PATH`, forwarded to the relay's port. Nothing else should be exposed, and Paperclip's API isn't involved. Any tunnel or reverse proxy works: Cloudflare Tunnel, ngrok, Tailscale Funnel, nginx or Caddy. If you don't want inbound webhooks at all, leave the relay off and use the watchdog and cost sync.

**Cloudflare Tunnel example:**

1. **Route the path.** In the tunnel's config, add a rule for the path **above** the rule that serves Paperclip, because rules match top-down:

   ```yaml
   ingress:
     - hostname: paperclip.example.com
       path: ^/hooks/github$
       service: http://localhost:3110
     - hostname: paperclip.example.com
       service: http://localhost:3100
     - service: http_status:404
   ```

   In a dashboard-managed tunnel, add the same public hostname route, with that path, above the Paperclip route.

2. **Let GitHub through Access.** If Cloudflare Access protects the hostname, add an application for exactly `paperclip.example.com/hooks/github` with a **Bypass** policy. GitHub has no identity to log in with; the webhook signature is the lock.

3. **Check it** from anywhere with `curl https://paperclip.example.com/hooks/github`. It should answer `{"error":"POST only"}`.
   - **A login page** means the Access bypass is missing.
   - **Paperclip's page or a 404** means the tunnel route is missing, or sits below Paperclip's rule.

## Security

- **The key acts as you.** Every change the helper makes appears in Paperclip under your name, just like your own actions. The key is a named board API key, `paperclip-helper`, that lasts `KEY_EXPIRES_DAYS` (365). `pch status` shows when it expires, and the log warns you two weeks ahead.
- **Where it's stored:** `data/paperclip-token`, mode 600 on Linux and macOS. Only the container's user can read it, and it never leaves the machine.
- **Revoking it:** `pch revoke` revokes it in Paperclip and deletes the file. Run `pch login` for a new one.
- **The webhook secret** is in `.env` (mode 600 on Linux and macOS). GitHub signs every delivery with it, and unsigned or wrongly signed deliveries are rejected.
- **Paperclip's API is never exposed.** Only the relay's path needs to be public.
- **The container** runs as a non-root user with a read-only filesystem, no capabilities, and `no-new-privileges`.
- **Logs** are one JSON line per event. Anything that looks like a key or secret is masked.
- **What it never does:** merge, push, delete, or change anything outside what's described here. The watchdog's only edit beyond comments is the failed-finalize repair, which you can switch off.

## Upgrading

```bash
cd ~/paperclip-helper && docker compose pull && docker compose up -d
```

`.env` and `data/` are untouched. `compose.yml` follows the `:1` tag, so upgrades stay within version 1. To pin an exact version, set `PCH_IMAGE=ghcr.io/deventerprisesoftware/paperclip-helper:1.0.0` in `.env`. Re-run the installer to pick up settings added in newer versions.

## Uninstalling

```bash
pch revoke                                    # revoke the key in Paperclip
cd ~/paperclip-helper && docker compose down
cd ~ && rm -rf ~/paperclip-helper             # and the pch line in your shell or PowerShell profile
```

Delete the GitHub webhook in each repository's settings. Cost events already posted stay in Paperclip.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Paperclip refused the hostname …` | [The hostname guard](#paperclips-hostname-guard-http-403): allow the hostname, or use host networking. |
| `cannot reach Paperclip at http://127.0.0.1:3100` | From a container, `127.0.0.1` is the host only with `network_mode: host`. Check `PAPERCLIP_API`, or re-run the installer. |
| `Paperclip rejected the helper's board key` | It expired or was revoked. Run `pch login`. |
| `config: …` lines, and the container restarts | A setting is missing or invalid. The line names it. |
| Deliveries show 401 in GitHub | The webhook secret doesn't match `GITHUB_WEBHOOK_SECRET`. |
| A delivery failed with `Task is paused` | Paperclip refuses comments on a paused task. Resume it, then **Redeliver** in GitHub. |
| Deliveries show `names no ACM issue` | The PR's title, branch and body contain no issue identifier. |
| A merge only comments (`decision is not waiting on you`) | The approval stage isn't pending on your user. `pch check ISSUE` shows who it's waiting on. |
| No PR rows on the issue | Turn on **Instance settings → Experimental → External Objects**. |
| Codex costs missing | Look for `pch costs` lines such as `model unknown` or `no price for …`, then set `CODEX_DEFAULT_MODEL` or add the model to `prices.json`. |
| Anything else | `docker compose logs --tail 50`. There's one JSON line per event; `LOG_LEVEL=debug` shows more. |

## Compatibility

- **Paperclip versions:** tested against **Paperclip 2026.916.1** (`ghcr.io/paperclipai/paperclip:latest` on 2026-09-30) in `authenticated`/`private` mode and in `local_trusted` mode. The API details the helper relies on were also checked against Paperclip's `main` branch at the end of September 2026. They're written down, with source references, in [docs/paperclip-internals.md](docs/paperclip-internals.md).
- **Platforms tested:** Linux with Docker Engine 29.8, and Windows 11 with Docker Desktop 4.93. On Windows, both Windows PowerShell 5.1 and PowerShell 7 were used. macOS uses the same Docker Desktop networking as Windows but hasn't been tested.
- **Mentions:** on Paperclip's `main`, an `@mention` in a comment no longer wakes the mentioned agent. The watchdog doesn't depend on it, because a board user's comment wakes the issue's assignee, which is who it nudges.
- **After paperclipai/paperclip#13880 ships:** the watchdog's hand-off check should find nothing to do, and can stay on or be turned off. The other checks cover separate gaps.
- **Resumed sessions:** Claude Code's reported cost is per run, not cumulative for a resumed session, so nothing is counted twice. `pch costs --sessions` checks this on your own runs.
- **Codex:** on Paperclip's CLI engine every Codex run is a fresh thread, and Paperclip's token counts match Codex's own logs. Codex on the ACP engine hasn't been checked.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md): the helper has no npm dependencies, and `npm test` runs the suite against a fake Paperclip.

## License

[MIT](LICENSE)
