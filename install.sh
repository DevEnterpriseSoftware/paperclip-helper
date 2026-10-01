#!/usr/bin/env bash
# Paperclip Helper installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/DevEnterpriseSoftware/paperclip-helper/main/install.sh | bash
#
# Re-run it any time to change settings: it offers your current values and keeps
# your board key and webhook secret. Unattended installs take every answer from
# environment variables (see the README):
#
#   curl -fsSL …/install.sh | PCH_NONINTERACTIVE=1 GITHUB_OWNER_LOGIN=me … bash
#
# It never uses sudo. It writes only to the install directory and, for the `pch`
# alias, your shell's rc file.

set -euo pipefail

DEFAULT_IMAGE="ghcr.io/deventerprisesoftware/paperclip-helper:1"
IMAGE="${PCH_IMAGE:-$DEFAULT_IMAGE}"
REPO_URL="https://github.com/DevEnterpriseSoftware/paperclip-helper"
NONINTERACTIVE="${PCH_NONINTERACTIVE:-}"

# ------------------------------------------------------------------ output and input

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# ask VAR "Question" "default": reads from the terminal, even under `curl | bash`.
ask() {
  local var="$1" question="$2" default="${3:-}" answer=""
  if [ -n "$NONINTERACTIVE" ]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then printf '%s [%s]: ' "$question" "$default" >/dev/tty; else printf '%s: ' "$question" >/dev/tty; fi
  IFS= read -r answer </dev/tty || true
  printf -v "$var" '%s' "${answer:-$default}"
}

# confirm "Question" y|n: returns 0 for yes.
confirm() {
  local question="$1" default="${2:-y}" answer=""
  if [ -n "$NONINTERACTIVE" ]; then [ "$default" = y ]; return; fi
  local hint="[Y/n]"; [ "$default" = n ] && hint="[y/N]"
  printf '%s %s ' "$question" "$hint" >/dev/tty
  IFS= read -r answer </dev/tty || true
  answer="$(printf '%s' "${answer:-$default}" | tr '[:upper:]' '[:lower:]')"
  [ "${answer#y}" != "$answer" ]
}

truthy() { case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }

# A value from the existing .env, if any.
env_get() {
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# The first non-empty of: environment variable, existing .env, fallback.
pick() {
  local name="$1" fallback="${2:-}" value
  value="$(printenv "$name" 2>/dev/null || true)"
  [ -n "$value" ] || value="$(env_get "$name")"
  printf '%s' "${value:-$fallback}"
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  elif [ -r /dev/urandom ]; then od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  else docker run --rm "$IMAGE" secret </dev/null
  fi
}

mask() { local v="$1"; [ ${#v} -gt 8 ] && printf '%s…(%d chars)' "${v:0:4}" "${#v}" || printf '***'; }

# ------------------------------------------------------------------ docker

# Runs a one-off helper command with the network the service will use.
# NET_ARGS is deliberately unquoted: it holds zero or more arguments.
# shellcheck disable=SC2086
helper() {
  docker run --rm $NET_ARGS --user "$PCH_UID:$PCH_GID" -v "$DIR/data:/data" \
    -e PAPERCLIP_API="$PAPERCLIP_API" -e PAPERCLIP_PUBLIC_URL="$PAPERCLIP_PUBLIC_URL" \
    -e LOG_LEVEL=warn "$IMAGE" "$@" </dev/null
}

# probe URL NET_ARGS: one JSON line from inside a container on that network.
# shellcheck disable=SC2086
probe() { docker run --rm $2 "$IMAGE" probe "$1" </dev/null 2>/dev/null || true; }

json_field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n 1; }

check_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 (\`docker compose\`) is required: https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 </dev/null || die "Docker isn't answering. Start it, or add yourself to the docker group (then log in again), and re-run."
  local endpoint
  endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null </dev/null || true)}"
  case "$endpoint" in
    ssh://*|tcp://*)
      warn "Docker here talks to a remote engine ($endpoint). The helper must run on the machine Paperclip runs on,"
      warn "and ./data would be a path on that machine. Run this installer there instead."
      confirm "Continue anyway?" n || exit 1 ;;
  esac
  local os
  os="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null </dev/null || true)"
  VM_ENGINE=""
  if [ "$(uname -s)" = Darwin ] || printf '%s' "$os" | grep -qiE 'docker desktop|rancher|colima|orbstack|lima|podman'; then
    VM_ENGINE=1
  fi
  note "Docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null </dev/null) on ${os:-unknown}${VM_ENGINE:+ (runs in a VM: bridge networking)}"
}

# ------------------------------------------------------------------ finding Paperclip

# Candidate "URL|MODE" lines, most likely first. MODE: host, bridge or net:<network>.
candidates() {
  local current_mode="$1"
  [ -n "${PAPERCLIP_API:-}" ] && printf '%s|%s\n' "$PAPERCLIP_API" "$current_mode"
  local mode=host base=127.0.0.1
  if [ -n "$VM_ENGINE" ]; then mode=bridge; base=host.docker.internal; fi
  printf 'http://%s:3100|%s\n' "$base" "$mode"
  local name port service net
  for name in $(docker ps --format '{{.Names}} {{.Image}}' </dev/null | awk 'tolower($2) ~ /paperclip/ && tolower($2) !~ /paperclip-helper/ {print $1}'); do
    port="$(docker port "$name" 3100/tcp 2>/dev/null </dev/null | head -n 1 | sed 's/.*://' || true)"
    [ -n "$port" ] && printf 'http://%s:%s|%s\n' "$base" "$port" "$mode"
    service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$name" 2>/dev/null </dev/null || true)"
    for net in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$name" 2>/dev/null </dev/null); do
      [ "$net" = host ] || [ "$net" = none ] && continue
      printf 'http://%s:3100|net:%s\n' "${service:-$name}" "$net"
    done
  done
}

net_args_for() {
  case "$1" in
    host) printf -- '--network host' ;;
    bridge) printf -- '--add-host host.docker.internal:host-gateway' ;;
    net:*) printf -- '--network %s' "${1#net:}" ;;
  esac
}

find_paperclip() {
  local current_mode="$1" line url mode result guard_host="" tried="" refused
  while IFS= read -r line; do
    url="${line%%|*}"; mode="${line#*|}"
    case " $tried " in *" $url|$mode "*) continue ;; esac
    tried="$tried $url|$mode"
    result="$(probe "$url" "$(net_args_for "$mode")")"
    if printf '%s' "$result" | grep -q '"ok":true'; then
      PAPERCLIP_API="$url"; NET_MODE="$mode"
      note "Found Paperclip at $url ($(printf '%s' "$result" | json_field deploymentMode) mode, ${mode/net:/network })"
      return 0
    fi
    if printf '%s' "$result" | grep -q hostname_guard; then
      refused="$(printf '%s' "$result" | json_field hostname)"
      note "$url answers, but Paperclip refuses the hostname \"$refused\"."
      # Prefer suggesting a container's own name over host.docker.internal.
      case "$mode" in
        net:*) guard_host="$refused" ;;
        *) [ -n "$guard_host" ] || guard_host="$refused" ;;
      esac
    else
      note "$url: $(printf '%s' "$result" | json_field code)"
    fi
  done < <(candidates "$current_mode")
  if [ -n "$guard_host" ]; then
    say ""
    warn "Paperclip only accepts hostnames it has been told about. Allow \"$guard_host\" where Paperclip runs:"
    say "    npx paperclipai allowed-hostname $guard_host        # then restart Paperclip"
    say "  For a Paperclip container, add it to PAPERCLIP_ALLOWED_HOSTNAMES in its environment and recreate it."
    say "  (That variable replaces the config file's list: include hostnames you already allowed.)"
  fi
  return 1
}

# ------------------------------------------------------------------ files

write_compose() {
  local network_block ports=""
  if truthy "$RELAY"; then ports="    ports: [\"127.0.0.1:\${RELAY_PORT:-3110}:\${RELAY_PORT:-3110}\"]"; fi
  case "$NET_MODE" in
    host) network_block="    network_mode: host" ;;
    bridge) network_block="    extra_hosts: [\"host.docker.internal:host-gateway\"]${ports:+
$ports}" ;;
    net:*) network_block="    networks: [paperclip]${ports:+
$ports}" ;;
  esac
  {
    cat <<EOF
# Paperclip Helper: $REPO_URL
# Written by install.sh. Upgrade: docker compose pull && docker compose up -d
services:
  helper:
    image: \${PCH_IMAGE:-$DEFAULT_IMAGE}
    container_name: paperclip-helper
    restart: unless-stopped
    stop_grace_period: 30s
    user: "\${PCH_UID:-1000}:\${PCH_GID:-1000}"
$network_block
    env_file: .env
    volumes:
      - ./data:/data
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
EOF
    case "$NET_MODE" in
      net:*) printf 'networks:\n  paperclip:\n    external: true\n    name: %s\n' "${NET_MODE#net:}" ;;
    esac
  } >"$1"
}

MANAGED="PCH_UID PCH_GID PCH_IMAGE PAPERCLIP_API PAPERCLIP_PUBLIC_URL RELAY GITHUB_WEBHOOK_SECRET GITHUB_OWNER_LOGIN GITHUB_REPOS ISSUE_PREFIXES RELAY_LINK_PRS RELAY_HOST RELAY_PORT RELAY_PATH WATCHDOG WATCHDOG_INTERVAL_SEC WATCHDOG_STALL_SEC WATCHDOG_MAX_NUDGES WATCHDOG_HEAL_FAILED_FINALIZE WATCHDOG_RETRY_DEFERRED COST_SYNC COST_SYNC_SINCE"

write_env() {
  local key
  {
    say "# Paperclip Helper settings, written by install.sh. Every setting: $REPO_URL/blob/main/.env.example"
    say "# Change them by re-running the installer, or edit this file and run: docker compose up -d"
    for key in $MANAGED; do printf '%s=%s\n' "$key" "${!key:-}"; done
    if [ -f "$DIR/.env" ]; then
      # Keep settings the installer doesn't manage.
      local extra
      # The "(pattern)" form: bash 3.2 can't parse a bare "pattern)" inside $(...).
      extra="$({ grep -E '^[A-Z_][A-Z0-9_]*=' "$DIR/.env" || true; } | while IFS= read -r l; do
        case " $MANAGED " in (*" ${l%%=*} "*) ;; (*) printf '%s\n' "$l" ;; esac
      done)"
      if [ -n "$extra" ]; then printf '\n# Your other settings\n%s\n' "$extra"; fi
    fi
  } >"$1"
  chmod 600 "$1"
}

show_file() {
  say "---- $1"
  sed -e "s/^\(GITHUB_WEBHOOK_SECRET=\).\{8,\}$/\1$(mask "$GITHUB_WEBHOOK_SECRET")/" "$2" | sed 's/^/  /'
}

install_alias() {
  local rc="" line
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc"; [ "$(uname -s)" = Darwin ] && rc="$HOME/.bash_profile" ;;
  esac
  line="alias pch='docker compose -f \"$DIR/compose.yml\" run --rm helper'"
  if [ -z "$rc" ]; then
    note "Add this alias to your shell's startup file: $line"
    return
  fi
  if [ -f "$rc" ] && grep -qF "$line" "$rc"; then
    note "The pch alias is already in $rc."
    return
  fi
  if [ -f "$rc" ] && grep -q "^alias pch=" "$rc"; then
    local tmp="$rc.pch-tmp"
    grep -v "^alias pch=" "$rc" >"$tmp" && cat "$tmp" >"$rc" && rm -f "$tmp"
  fi
  printf '\n# Paperclip Helper\n%s\n' "$line" >>"$rc"
  note "Added the pch alias to $rc (open a new terminal, or run: source $rc)."
}

# ------------------------------------------------------------------ webhook

test_webhook_url() {
  local url="$1" code body
  body="$(curl -s -m 15 -o - -w '\n%{http_code}' "$url" </dev/null 2>/dev/null || true)"
  code="$(printf '%s' "$body" | tail -n 1)"
  body="$(printf '%s' "$body" | sed '$d')"
  if [ "$code" = 405 ] && printf '%s' "$body" | grep -q 'POST only'; then
    note "$url reaches the relay."
    return 0
  fi
  if printf '%s' "$body" | grep -qiE 'cloudflareaccess|cf-access|<form|sign in|log in'; then
    warn "$url shows a login page: an access policy (e.g. Cloudflare Access) is in the way."
    note "Add a bypass for exactly this path. GitHub has no identity to log in with; the webhook signature is the lock."
  elif [ "$code" = 404 ] || printf '%s' "$body" | grep -qi '<html'; then
    warn "$url reached something other than the relay (HTTP $code)."
    note "Route this path to the relay (http://localhost:${RELAY_PORT}) in your tunnel or proxy, above Paperclip's own rule."
  else
    warn "$url didn't answer as expected (HTTP ${code:-no answer})."
  fi
  return 1
}

# gh_hook URL GH-API-ARGS...: gh api with the webhook's settings, to create or update it.
gh_hook() {
  local url="$1"; shift
  gh api "$@" -F active=true \
    -f 'events[]=pull_request' -f 'events[]=pull_request_review' -f 'events[]=issue_comment' \
    -f "config[url]=$url" -f 'config[content_type]=json' -f "config[secret]=$GITHUB_WEBHOOK_SECRET" </dev/null 2>&1
}

create_webhooks() {
  local url="$1" repo out id
  for repo in $(printf '%s' "$GITHUB_REPOS" | tr ',' ' '); do
    id="$(gh api "repos/$repo/hooks" --jq ".[] | select(.config.url == \"$url\") | .id" </dev/null 2>/dev/null | head -n 1 || true)"
    if [ -n "$id" ]; then
      out="$(gh_hook "$url" -X PATCH "repos/$repo/hooks/$id")" && note "$repo: updated the existing webhook." && continue
    else
      out="$(gh_hook "$url" "repos/$repo/hooks" -f name=web)" && note "$repo: webhook created (GitHub sends a ping now)." && continue
    fi
    warn "$repo: $(printf '%s' "$out" | tail -n 1)"
    if printf '%s' "$out" | grep -q 'HTTP 404'; then
      note "gh needs the admin:repo_hook scope, and you need admin rights on $repo: run"
      note "  gh auth refresh -h github.com -s admin:repo_hook"
      note "then re-run the installer."
    fi
  done
}

manual_webhook_steps() {
  say "  Add the webhook by hand in each repository: Settings → Webhooks → Add webhook"
  say "    Payload URL:   ${1:-https://<your public host>$RELAY_PATH}"
  say "    Content type:  application/json"
  say "    Secret:        $GITHUB_WEBHOOK_SECRET"
  say "    Events:        Pull requests, Pull request reviews, Issue comments"
}

# ------------------------------------------------------------------ main

main() {
  for arg in "$@"; do
    case "$arg" in
      --non-interactive|-y) NONINTERACTIVE=1 ;;
      -h|--help) sed -n '2,14p' "$0" 2>/dev/null || true; exit 0 ;;
    esac
  done
  if [ -z "$NONINTERACTIVE" ] && ! (: </dev/tty) 2>/dev/null; then
    die "No terminal to ask questions on. Run it in a terminal, or set PCH_NONINTERACTIVE=1 with your settings."
  fi

  bold "Paperclip Helper installer"
  say "Merge-to-approve relay, stalled-work watchdog and subscription cost sync for Paperclip."

  step "Checking Docker"
  check_docker

  step "Install directory"
  ask DIR "Install into" "${PCH_DIR:-$HOME/paperclip-helper}"
  DIR="${DIR/#\~/$HOME}"
  mkdir -p "$DIR/data"
  chmod 700 "$DIR/data" 2>/dev/null || true
  [ -f "$DIR/.env" ] && note "Found an existing install: its settings are the defaults."
  PCH_UID="$(id -u)"; PCH_GID="$(id -g)"
  if [ "$PCH_UID" = 0 ]; then PCH_UID=1000; PCH_GID=1000; chown 1000:1000 "$DIR/data" 2>/dev/null || true; fi

  PCH_IMAGE="$(pick PCH_IMAGE)"
  IMAGE="${PCH_IMAGE:-$DEFAULT_IMAGE}"
  step "Pulling $IMAGE"
  local pull_out
  if ! pull_out="$(docker pull "$IMAGE" </dev/null 2>&1)"; then
    docker image inspect "$IMAGE" >/dev/null 2>&1 </dev/null || die "Couldn't pull $IMAGE: $(printf '%s' "$pull_out" | tail -n 1)"
    warn "Couldn't pull $IMAGE; using the copy already on this machine."
  fi
  note "Image $(docker run --rm "$IMAGE" version </dev/null)"

  step "Finding Paperclip"
  PAPERCLIP_API="$(pick PAPERCLIP_API)"
  local current_mode=host
  if [ -f "$DIR/compose.yml" ]; then
    if grep -q 'network_mode: host' "$DIR/compose.yml"; then current_mode=host
    elif grep -q 'external: true' "$DIR/compose.yml"; then current_mode="net:$(sed -n 's/^ *name: //p' "$DIR/compose.yml" | tail -n 1)"
    else current_mode=bridge; fi
  elif [ -n "$VM_ENGINE" ]; then current_mode=bridge; fi
  [ -n "${PCH_NETWORK:-}" ] && current_mode="$PCH_NETWORK"
  NET_MODE=""
  until find_paperclip "$current_mode"; do
    [ -n "$NONINTERACTIVE" ] && die "Couldn't reach Paperclip. Set PAPERCLIP_API (and PCH_NETWORK=host|bridge|net:<network>)."
    say ""
    ask PAPERCLIP_API "Paperclip's URL as the helper container should reach it (Enter to retry)" "${PAPERCLIP_API:-}"
    ask current_mode "Network: host, bridge, or net:<docker network>" "$current_mode"
  done
  NET_ARGS="$(net_args_for "$NET_MODE")"
  local default_public
  default_public="$(pick PAPERCLIP_PUBLIC_URL)"
  if [ -z "$default_public" ]; then
    default_public="$(printf '%s' "$PAPERCLIP_API" | sed -e 's#host.docker.internal#localhost#' -e 's#127.0.0.1#localhost#')"
  fi
  ask PAPERCLIP_PUBLIC_URL "The address you open Paperclip at in your browser" "$default_public"
  PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL%/}"

  step "Board API key"
  say "The helper acts as you in Paperclip, with a board API key of your own."
  if [ -n "${PCH_TOKEN:-}" ]; then
    printf '%s\n' "$PCH_TOKEN" >"$DIR/data/paperclip-token"
    chmod 600 "$DIR/data/paperclip-token"
  fi
  local have_key="" checked=""
  if [ -s "$DIR/data/paperclip-token" ] && checked="$(helper check 2>&1)"; then
    printf '%s\n' "$checked" | sed 's/^/  /'
    have_key=1
    confirm "Keep this key?" y || have_key=""
  fi
  if [ -z "$have_key" ]; then
    helper login || die "Login failed. Re-run the installer to try again."
    helper check | sed 's/^/  /'
  fi

  step "Relay: merge a PR to approve its issue"
  RELAY="$(pick RELAY)"
  GITHUB_OWNER_LOGIN="$(pick GITHUB_OWNER_LOGIN)"
  GITHUB_REPOS="$(pick GITHUB_REPOS)"
  GITHUB_WEBHOOK_SECRET="$(pick GITHUB_WEBHOOK_SECRET)"
  ISSUE_PREFIXES="$(pick ISSUE_PREFIXES)"
  RELAY_LINK_PRS="$(pick RELAY_LINK_PRS)"
  RELAY_PORT="$(pick RELAY_PORT 3110)"
  RELAY_PATH="$(pick RELAY_PATH /hooks/github)"
  # shellcheck disable=SC2034  # written to .env by write_env
  if [ "$NET_MODE" = host ]; then RELAY_HOST=127.0.0.1; else RELAY_HOST=0.0.0.0; fi
  # Unattended installs set up the relay only when given a GitHub login.
  local relay_default=y
  if [ -n "$NONINTERACTIVE" ] && [ -z "$GITHUB_OWNER_LOGIN" ]; then relay_default=n; fi
  if [ -n "${RELAY:-}" ] && ! truthy "$RELAY"; then relay_default=n; fi
  say "It takes signed GitHub webhooks: merging an agent's PR approves the Paperclip issue waiting on you,"
  say "and \"Request changes\" sends it back to the engineer. It needs a public HTTPS route to one path."
  if confirm "Set up the relay?" "$relay_default"; then
    RELAY=true
    if [ -z "$GITHUB_OWNER_LOGIN" ] && command -v gh >/dev/null 2>&1; then
      GITHUB_OWNER_LOGIN="$(gh api user --jq .login </dev/null 2>/dev/null || true)"
    fi
    ask GITHUB_OWNER_LOGIN "Your GitHub login (only your merges and reviews decide)" "$GITHUB_OWNER_LOGIN"
    ask GITHUB_REPOS "Repositories, comma-separated (owner/repo)" "$GITHUB_REPOS"
    if [ -z "$GITHUB_OWNER_LOGIN" ] || [ -z "$GITHUB_REPOS" ]; then
      die "The relay needs your GitHub login and at least one repository."
    fi
    local detected
    detected="$(helper prefixes 2>/dev/null || true)"
    [ -n "$detected" ] && note "Your companies' issue prefixes: $detected (used when the next answer is empty)."
    ask ISSUE_PREFIXES "Issue prefixes to look for (empty = all of your companies')" "$ISSUE_PREFIXES"
    local link=y; if [ -n "$RELAY_LINK_PRS" ] && ! truthy "$RELAY_LINK_PRS"; then link=n; fi
    if confirm "Post each new PR's URL on its issue, so Paperclip links the PR?" "$link"; then RELAY_LINK_PRS=true; else RELAY_LINK_PRS=false; fi
    ask RELAY_PORT "Relay port" "$RELAY_PORT"
    ask RELAY_PATH "Webhook path" "$RELAY_PATH"
    if [ -n "$GITHUB_WEBHOOK_SECRET" ]; then
      confirm "Keep the existing webhook secret?" y || GITHUB_WEBHOOK_SECRET=""
    fi
    [ -n "$GITHUB_WEBHOOK_SECRET" ] || GITHUB_WEBHOOK_SECRET="$(random_hex)"
  else
    RELAY=false
  fi

  step "Watchdog: wake agents whose work stalled"
  WATCHDOG="$(pick WATCHDOG true)"
  WATCHDOG_INTERVAL_SEC="$(pick WATCHDOG_INTERVAL_SEC 60)"
  WATCHDOG_STALL_SEC="$(pick WATCHDOG_STALL_SEC 180)"
  WATCHDOG_MAX_NUDGES="$(pick WATCHDOG_MAX_NUDGES 2)"
  WATCHDOG_HEAL_FAILED_FINALIZE="$(pick WATCHDOG_HEAL_FAILED_FINALIZE true)"
  WATCHDOG_RETRY_DEFERRED="$(pick WATCHDOG_RETRY_DEFERRED true)"
  say "It comments on issues whose hand-off wake Paperclip dropped, or whose blockers finished without"
  say "anything picking them up, and repairs blockers stuck on a failed workspace clean-up."
  local wd_default=y; truthy "$WATCHDOG" || wd_default=n
  if confirm "Turn the watchdog on?" "$wd_default"; then
    WATCHDOG=true
    if confirm "Adjust its timing?" n; then
      ask WATCHDOG_INTERVAL_SEC "Check every (seconds)" "$WATCHDOG_INTERVAL_SEC"
      ask WATCHDOG_STALL_SEC "Act after an issue has been quiet for (seconds)" "$WATCHDOG_STALL_SEC"
      ask WATCHDOG_MAX_NUDGES "Nudge comments per stalled issue" "$WATCHDOG_MAX_NUDGES"
    fi
    local heal=y; truthy "$WATCHDOG_HEAL_FAILED_FINALIZE" || heal=n
    if confirm "Repair blockers stuck on a failed workspace clean-up?" "$heal"; then WATCHDOG_HEAL_FAILED_FINALIZE=true; else WATCHDOG_HEAL_FAILED_FINALIZE=false; fi
    local retry=y; truthy "$WATCHDOG_RETRY_DEFERRED" || retry=n
    say "A wake deferred behind a stopped run waits forever. Paperclip's \"send queued messages now\" retries it."
    if confirm "Press it for such wakes (never interrupts a running run)?" "$retry"; then WATCHDOG_RETRY_DEFERRED=true; else WATCHDOG_RETRY_DEFERRED=false; fi
  else
    WATCHDOG=false
  fi

  step "Cost sync: what subscription runs would have cost"
  COST_SYNC="$(pick COST_SYNC true)"
  COST_SYNC_SINCE="$(pick COST_SYNC_SINCE)"
  say "Paperclip records \$0 for runs on a Claude or ChatGPT subscription. Cost sync posts each run's"
  say "API-equivalent cost (Claude Code's own figure; Codex estimated from tokens at OpenAI list prices)."
  say "Runs billed to an API key are never touched. Posted amounts count toward budgets and can't be deleted."
  say "What it would post now:"
  helper costs 2>&1 | sed 's/^/  /' || true
  local cs_default=y; truthy "$COST_SYNC" || cs_default=n
  if confirm "Turn cost sync on?" "$cs_default"; then
    COST_SYNC=true
    if [ -z "$COST_SYNC_SINCE" ] && [ ! -f "$DIR/data/cost-synced.json" ]; then
      # Unattended, nobody saw the preview: only runs from now on, unless COST_SYNC_SINCE says otherwise.
      local past=y; [ -n "$NONINTERACTIVE" ] && past=n
      confirm "Include runs that already finished (the list above)?" "$past" || COST_SYNC_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    fi
  else
    COST_SYNC=false
  fi

  step "Writing files"
  local tmp_env="$DIR/.env.new" tmp_compose="$DIR/compose.yml.new"
  write_env "$tmp_env"
  write_compose "$tmp_compose"
  show_file "$DIR/compose.yml" "$tmp_compose"
  show_file "$DIR/.env" "$tmp_env"
  if ! confirm "Write these files and start the helper?" y; then
    rm -f "$tmp_env" "$tmp_compose"
    die "Nothing written."
  fi
  mv "$tmp_env" "$DIR/.env"
  mv "$tmp_compose" "$DIR/compose.yml"

  step "Starting"
  (cd "$DIR" && docker compose up -d --remove-orphans </dev/null) || die "docker compose up failed."
  sleep 6
  (cd "$DIR" && docker compose logs --no-log-prefix --tail 20 helper </dev/null) | sed 's/^/  /'

  if truthy "$RELAY"; then
    step "Webhook"
    if curl -s -m 5 "http://127.0.0.1:$RELAY_PORT$RELAY_PATH" </dev/null 2>/dev/null | grep -q 'POST only'; then
      note "The relay answers on this machine at http://localhost:$RELAY_PORT$RELAY_PATH."
    else
      warn "The relay doesn't answer on http://localhost:$RELAY_PORT$RELAY_PATH yet: check \`docker compose logs\`."
    fi
    say "GitHub must reach that path over HTTPS: forward exactly $RELAY_PATH to http://localhost:$RELAY_PORT"
    say "with a tunnel or reverse proxy (see $REPO_URL#networking)."
    local webhook_url="${PCH_WEBHOOK_URL:-}"
    [ -z "$webhook_url" ] && [ -n "$PAPERCLIP_PUBLIC_URL" ] && case "$PAPERCLIP_PUBLIC_URL" in https://*) webhook_url="$PAPERCLIP_PUBLIC_URL$RELAY_PATH" ;; esac
    ask webhook_url "Public webhook URL (empty to skip)" "$webhook_url"
    if [ -n "$webhook_url" ]; then
      test_webhook_url "$webhook_url" || true
      if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 </dev/null; then
        if confirm "Create or update the webhook on $GITHUB_REPOS with gh?" y; then
          create_webhooks "$webhook_url"
          sleep 4
          if (cd "$DIR" && docker compose logs --no-log-prefix --since 30s helper </dev/null) | grep -q '"event":"ping"'; then
            note "The relay received GitHub's ping."
          fi
        else
          manual_webhook_steps "$webhook_url"
        fi
      else
        manual_webhook_steps "$webhook_url"
      fi
    else
      manual_webhook_steps ""
    fi
  fi

  step "The pch command"
  if [ -z "${PCH_NO_ALIAS:-}" ]; then install_alias; fi

  step "Done"
  say "The helper runs in the background and restarts with Docker. Try:"
  say "  pch status         what it's doing"
  say "  pch why ISSUE-1    why nobody is working on an issue"
  say "  pch help           every command"
  say "Upgrade:   cd $DIR && docker compose pull && docker compose up -d"
  say "Settings:  re-run this installer, or edit $DIR/.env and run docker compose up -d"
}

main "$@"
