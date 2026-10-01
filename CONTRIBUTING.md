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
docs/paperclip-internals.md   the Paperclip API facts the helper relies on
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

To try a local image with the installer, set `PCH_IMAGE=paperclip-helper:dev`; the installer uses a local image when it can't pull one.

## Prices

`src/prices.mjs` holds OpenAI list prices for Codex. A pull request that updates a price should link the official pricing page, and add an entry with a new `from` date rather than editing the old one, so past runs keep their price.

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag.

The release workflow tests, builds `linux/amd64` and `linux/arm64`, and pushes `ghcr.io/deventerprisesoftware/paperclip-helper:X.Y.Z`, `:X.Y`, `:X` and `:latest`.
