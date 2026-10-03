# Installing, networking and upgrading

The one-line installers are in the [README](../README.md#quick-start). This page covers what they do, the other ways to install, how the helper reaches Paperclip, and upgrades.

You need a self-hosted Paperclip and Docker with Compose v2 **on the same machine**. On Linux that means Docker Engine; on Windows and macOS, Docker Desktop or similar. You also need a Paperclip board user.

The installer shows everything before it writes it, and you can re-run it at any time to change settings. It keeps your key and webhook secret. It never uses `sudo` or administrator rights.

## What the installer does

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
9. **Adds the `pch` command:** it writes `pch.sh` (or `pch.ps1`) to the install directory, and points an alias in `~/.zshrc` or `~/.bashrc` (`~/.bash_profile` on macOS), or a function in your PowerShell profile, at it.

## Unattended install

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
| Any other setting the installer asks about, such as `ISSUE_PREFIXES`, `WATCHDOG` or `COST_SYNC` | Used as the answer. Add other settings from [`.env.example`](../.env.example) to `.env` afterwards; re-runs keep them. |
| `PCH_WEBHOOK_URL` | The public webhook URL to test. |
| `PCH_IMAGE` | Another image or tag. |
| `PCH_NO_ALIAS=1` | Don't add `pch`. |

```bash
curl -fsSL …/install.sh | PCH_NONINTERACTIVE=1 GITHUB_OWNER_LOGIN=me GITHUB_REPOS=me/app bash
```

## Manual install

The published `compose.yml` uses host networking, so this is for Linux; on Docker Desktop, use the installer. Cost sync stays off until you set `COST_SYNC=true` in `.env`, so preview it with `pch costs` first.

```bash
mkdir -p ~/paperclip-helper/data && cd ~/paperclip-helper
curl -fsSLO https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/compose.yml
curl -fsSL https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/.env.example -o .env
chmod 600 .env && nano .env                 # PAPERCLIP_API, PAPERCLIP_PUBLIC_URL, PCH_UID/PCH_GID (id -u / id -g)
docker compose run --rm helper login        # approve the link in Paperclip
docker compose up -d
docker run --rm ghcr.io/deventerprisesoftware/paperclip-helper:1 wrapper sh > pch.sh   # the pch command, with pch update
echo "alias pch='sh \"$HOME/paperclip-helper/pch.sh\"'" >> ~/.bashrc
```

## General settings

Every setting lives in `.env` in the install directory; [`.env.example`](../.env.example) lists them all with comments. Each component's own settings are on its page: [relay](relay.md#relay-settings), [watchdog](watchdog.md#watchdog-settings), [cost sync](cost-sync.md#cost-sync-settings).

| Setting | Default | Meaning |
|---|---|---|
| `PAPERCLIP_API` | `http://127.0.0.1:3100` | Paperclip's API, as reached from the helper's container (see [Networking](#networking)). |
| `PAPERCLIP_PUBLIC_URL` | none | The address you open Paperclip at. Used only for the approval link `pch login` prints. |
| `KEY_EXPIRES_DAYS` | `365` | How long the board key `pch login` creates lasts. |
| `DRY_RUN` | `false` | `true` makes every component log what it would do and change nothing. |
| `LOG_LEVEL` | `info` | `debug` shows more. |
| `PAPERCLIP_TIMEOUT_SEC` | `20` | How long to wait for Paperclip to answer a request. |
| `PCH_UID`, `PCH_GID` | `1000` | The user the container runs as; it owns `data/`. |
| `PCH_IMAGE` | the `:1` tag | Another image or tag (see [Upgrading](#upgrading)). |

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

## Upgrading

```text
$ pch update
Pulling ghcr.io/deventerprisesoftware/paperclip-helper:1
Updated Paperclip Helper: 1.0.2 → 1.1.0.
```

`pch update` pulls the image, restarts the service if the image changed, and refreshes the `pch` script itself. If the service is stopped, it only pulls, and leaves it stopped. It updates the helper only, never Paperclip.

Without `pch` (a manual install, or a `pch` from an installer older than 1.1):

```bash
cd ~/paperclip-helper && docker compose pull && docker compose up -d
```

`.env` and `data/` are untouched. `compose.yml` follows the `:1` tag, so upgrades stay within version 1. To pin an exact version, set `PCH_IMAGE=ghcr.io/deventerprisesoftware/paperclip-helper:1.1.0` in `.env`; `pch update` then follows that tag. Re-run the installer to pick up settings added in newer versions, and once to get `pch update` if your `pch` predates it.

## Uninstalling

```bash
pch revoke                                    # revoke the key in Paperclip
cd ~/paperclip-helper && docker compose down
cd ~ && rm -rf ~/paperclip-helper             # and the pch line in your shell or PowerShell profile
```

Delete the GitHub webhook in each repository's settings. Cost events already posted stay in Paperclip.


---

[← Back to the README](../README.md)
