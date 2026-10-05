# Contributing

Thanks for helping. Issues describing a Paperclip situation the helper doesn't handle are as valuable as code. Please include `pch why ISSUE` output and your Paperclip version (`/api/health` shows the commit).

## Layout

```
src/
  index.mjs       entry point: the service, and command dispatch
  config.mjs      settings from the environment, validated
  context.mjs     config + logger + API client + identity, built once
  paperclip.mjs   HTTP client: timeouts, safe retries, readable errors
  relay.mjs       GitHub webhooks → decisions and comments
  conflicts.mjs   the relay's sweep for PRs with merge conflicts
  github.mjs      GitHub API client, used by that sweep only
  watchdog.mjs    stalled-work checks and nudges
  cost-sync.mjs   API-equivalent cost events
  prices.mjs      model price table
  commands.mjs    the one-off `pch` commands
  store.mjs       small JSON state files, written atomically
  util.mjs        small shared helpers
  log.mjs         one JSON line per event, with secrets masked
test/
  fake-paperclip.mjs   an in-memory Paperclip for the tests
  helpers.mjs          shared test set-up
  *.test.mjs
  compat/              the same code against a real Paperclip, one version at a time
docs/paperclip-internals.md   the Paperclip API facts the helper relies on
docs/*.md                     the user guides the README links to (install, relay, watchdog, cost sync, commands, troubleshooting)
install.sh, install.ps1       the installers
```

## Ground rules

- **No npm dependencies.** Node 22's standard library only, so the image stays tiny and there's nothing to audit or update.
- **Every Paperclip behaviour the code relies on goes in [docs/paperclip-internals.md](docs/paperclip-internals.md),** with a source reference, and in the fake server. When the fake server and real Paperclip disagree, fix the fake first; otherwise the tests pass against behaviour Paperclip doesn't have.
- **Anything that writes to Paperclip needs a test,** including what it must *not* do (not your decision, not your repository, API-key runs, and so on).
- **Nothing the helper posts can be taken back** (comments, decisions, cost events), so prefer doing nothing, and saying why, over guessing.
- **Keep log lines one JSON object each,** and never log a token or secret. `log.mjs` masks the obvious ones; don't rely on it.
- **Installers stay short, readable and `sudo`-free.** Keep `install.sh` working on macOS's bash 3.2 (no associative arrays or `mapfile`), and keep `install.ps1` ASCII-only and Windows PowerShell 5.1-compatible.

## Running it

```bash
npm test                     # the whole suite, against the fake Paperclip
node src/index.mjs help      # the CLI, with settings from your environment
docker build -t paperclip-helper:dev .
```

## Checking a Paperclip version

```bash
npm run test:compat                      # Paperclip's latest release
npm run test:compat -- 2026.1001.0       # one version, or several
npm run test:compat -- --keep latest     # leave it running afterwards
```

This downloads that Paperclip from npm (`npx paperclipai@<version>`), starts it with its embedded PostgreSQL in a temporary directory on a free port, runs `test/compat/compat.test.mjs` against it, and removes it. It never touches a Paperclip you already run. It needs what Paperclip needs: Node 24.11 or newer for the 2026.9 releases, and a user that isn't root. On Windows, run it in WSL.

The suite seeds a company with `process`-adapter agents (a shell one-liner each), so runs, wakes and comment queues are real and no model is called. It checks three things:

1. Paperclip's OpenAPI document still lists every endpoint the helper calls.
2. Each response carries the fields the helper reads, and each write behaves as the helper assumes.
3. `login`, the watchdog, the relay, cost sync and the commands work end to end. For example, a hand-off whose wake Paperclip dropped is nudged, and the nudge starts the new owner's run.

To run it against a Paperclip you started yourself, set `PAPERCLIP_COMPAT_API`. That instance must be in `local_trusted` mode and hold no companies of your own: the suite refuses to run otherwise.

The same suite runs in CI on every push, and daily against Paperclip's latest release (`.github/workflows/compat.yml`). When a new Paperclip passes, add its version to that workflow's list. When the helper calls a new endpoint, the suite's last test fails until you add it to `HELPER_ENDPOINTS`.

What it can't reproduce are failures that need real infrastructure: an environment lease that is refused, a failed `workspace_finalize`, a recovery hold, and subscription runs with usage. Those stay covered by the fake server's tests and by `pch why` on a live instance.

To try a local image with the installer, set `PCH_IMAGE=paperclip-helper:dev`; the installer uses a local image when it can't pull one.

## Prices

`src/prices.mjs` holds OpenAI list prices for Codex. A pull request that updates a price should link the official pricing page, and add an entry with a new `from` date rather than editing the old one, so past runs keep their price.

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag.

The release workflow tests, builds `linux/amd64` and `linux/arm64`, and pushes `ghcr.io/deventerprisesoftware/paperclip-helper:X.Y.Z`, `:X.Y`, `:X` and `:latest`.
