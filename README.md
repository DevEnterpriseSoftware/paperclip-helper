# Paperclip Helper

Self-hosted [Paperclip](https://github.com/paperclipai/paperclip) has gaps that show up as soon as agents do real work: reviews you can't approve from the issue, agents that silently stop when work changes hands, and a Costs page that reads $0. **Paperclip Helper is one small container that runs beside Paperclip and closes those gaps**, using Paperclip's own API and a board key of yours.

> Paperclip Helper is an independent project. It is not made by or affiliated with the Paperclip team.

## What Paperclip leaves you with, and what the helper does about it

| In Paperclip you see… | With the helper… |
|---|---|
| **"Approval pending with You", and no Approve button** on the issue. | **[Relay](docs/relay.md).** Merge the PR on GitHub and the issue is approved. **Request changes** on GitHub sends it back to the engineer, with your review as the brief. |
| **An agent that never starts** after an issue is handed to it. | **[Watchdog](docs/watchdog.md).** It spots the wake Paperclip dropped and wakes the new owner with a comment. |
| **A blocked issue that stays blocked** after its blockers are done, or whose done blocker is "finalizing" forever. | **Watchdog.** It wakes the owner, and removes a blocker stuck on a failed workspace clean-up. |
| **"Waiting for execution recovery"** or **"Automatic recovery blocked"** after a hand-off, with your message saved but never delivered. | **Watchdog.** It presses Paperclip's own **send queued messages now** / **Interrupt** for you. |
| **Issues left blocked after you pause and resume agents** ("the original assignee is not invokable"). | **Watchdog.** Once the agent is back, it comments on each issue Paperclip parked, which un-parks it and wakes the agent. |
| **A Costs page that shows $0**, because your agents run on a Claude or ChatGPT subscription. | **[Cost sync](docs/cost-sync.md).** It posts each run's API-equivalent cost: Claude Code's own figure, and for Codex, tokens × OpenAI list prices. |
| **A model drop-down that doesn't list** a new model id. | **[`pch set-model`](docs/commands.md)** moves every agent from one model to another and keeps the rest of their config, effort included. |
| **"Why is nobody working on this?"** | **[`pch why ISSUE`](docs/commands.md)** prints Paperclip's own diagnosis, then a recommendation: what is holding the issue and the command that gets it moving. `--prompt` turns it into a prompt for an LLM chat. |
| **PRs waiting for your review that you can't merge**, because another merge left them with conflicts. | **Relay.** After each merge it finds the open PRs that now conflict and sends them back to their agents to resolve, with a note on the PR. |
| **An issue that lists the wrong PR**, or none. | **Relay.** It posts the PR's URL on its issue when the PR opens, so Paperclip links it. |

## How it works

- **One container, no npm dependencies.** It calls Paperclip's API directly with a named board key, so everything it does appears in Paperclip under your name.
- **Three components, each with its own switch:** the relay receives signed GitHub webhooks, the watchdog checks every minute, and cost sync posts every 15 minutes.
- **It works through Paperclip's API, as you would in the UI:** comments, review decisions, blocker edits and cost events. It never merges, pushes or deletes anything. On GitHub it only reads pull requests and, if you turn that on, comments on the ones it sends back.
- **`DRY_RUN=true`** makes every component log what it would do and change nothing.

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

It acts only on events signed with your webhook secret, from your repositories, by your GitHub login, and only when Paperclip says the decision is waiting on *you*. Otherwise it comments. Details and settings: **[docs/relay.md](docs/relay.md)**.

### Watchdog: wake stalled work

Most stalls start the same way: an issue changes hands, Paperclip cancels a run at that moment, and the next wake is refused and never retried. Every minute the watchdog looks for the stalls in the table above, six situations in all. It acts only after an issue has been quiet for three minutes, at most twice per situation, and never interrupts a running run. A hold whose cause it can't be sure of is logged and left to you. Details and settings: **[docs/watchdog.md](docs/watchdog.md)**.

### Cost sync: what your subscription runs would have cost

Paperclip records $0 for runs billed to a subscription. Cost sync posts one cost event per finished subscription run and never touches runs billed to an API key. The amounts count toward budgets and cost events can't be deleted, so **preview with `pch costs` first**; it changes nothing. Details and settings: **[docs/cost-sync.md](docs/cost-sync.md)**.

## Commands

`pch <command>` runs a throwaway container next to the service.

| Command | What it does |
|---|---|
| `pch status` | What the service is doing, its last checks and counts, and when the key expires. |
| `pch check [ISSUE]` | Who the key belongs to, its companies and prefixes. With an issue, its stage, current participant, and whether a merge would approve it. |
| `pch why ISSUE` | Why nobody is working on an issue, and what to do about it. `--prompt` prints it as a prompt for an LLM chat. |
| `pch approve ISSUE [comment]` | Approves an issue whose approval is waiting on you. It refuses otherwise. |
| `pch changes ISSUE comment` | Requests changes. The comment is required and becomes the brief. |
| `pch comment ISSUE text` | Comments as you, which wakes the assignee. |
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
- **The GitHub token** (optional, for sending back PRs with merge conflicts) is in `.env` too. Give it only the relay's repositories and only "Pull requests" access; the helper reads pull requests and comments on them, nothing else. See [the GitHub token](docs/relay.md#the-github-token).
- **Paperclip's API is never exposed.** Only the relay's path needs to be public.
- **The container** runs as a non-root user with a read-only filesystem, no capabilities, and `no-new-privileges`.
- **Logs** are one JSON line per event. Anything that looks like a key or secret is masked.
- **What it never does:** merge, push, delete, or change anything outside what's described here. The watchdog's only edit beyond comments is the failed-finalize repair, which you can switch off.

## Upgrading

`pch update` pulls the latest release of the helper's major version and restarts it. It never updates Paperclip. Pinning a version, upgrading without `pch`, and uninstalling: **[docs/install.md](docs/install.md#upgrading)**.

## Troubleshooting

`pch status` shows what the service is doing, `pch why ISSUE` explains a stuck issue, and `docker compose logs --tail 50` shows one JSON line per event. Symptoms and fixes: **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Compatibility

- **Paperclip versions:** tested against **Paperclip 2026.916.1** (`ghcr.io/paperclipai/paperclip:latest` on 2026-09-30) in `authenticated`/`private` mode and in `local_trusted` mode, and against **2026.1001.0** with the compatibility suite (`npm run test:compat -- <version>`, see [CONTRIBUTING.md](CONTRIBUTING.md)), which runs the helper's own code against a throwaway Paperclip of that version. The API details the helper relies on were also checked against Paperclip's `main` branch at the end of September 2026. They're written down, with source references and version-specific notes, in [docs/paperclip-internals.md](docs/paperclip-internals.md).
- **Platforms tested:** Linux with Docker Engine 29.8, and Windows 11 with Docker Desktop 4.93. On Windows, both Windows PowerShell 5.1 and PowerShell 7 were used. macOS uses the same Docker Desktop networking as Windows but hasn't been tested.

## Documentation

| Page | What's in it |
|---|---|
| [docs/install.md](docs/install.md) | What the installer does, unattended and manual installs, general settings, networking, the hostname guard, exposing the relay, upgrading, uninstalling. |
| [docs/relay.md](docs/relay.md) | Every GitHub event and what it does, how the issue is found, PRs with merge conflicts and the GitHub token, safety rules, the webhook, settings. |
| [docs/watchdog.md](docs/watchdog.md) | The six situations in detail, limits, what it leaves to you, settings. |
| [docs/cost-sync.md](docs/cost-sync.md) | How costs are worked out, what to know before turning it on, settings. |
| [docs/commands.md](docs/commands.md) | Every `pch` command, with `set-model` and `why` examples. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes and fixes. |
| [docs/paperclip-internals.md](docs/paperclip-internals.md) | The Paperclip behaviour the helper relies on, with source references. |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md): the helper has no npm dependencies, and `npm test` runs the suite against a fake Paperclip.

## License

[MIT](LICENSE)
