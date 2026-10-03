#!/bin/sh
# Paperclip Helper's `pch` command: https://github.com/DevEnterpriseSoftware/paperclip-helper
#
# The installer copies this file next to compose.yml, and `pch update` refreshes it.
# `pch update` runs here, on the host, because the helper's container can't pull its
# own image. Every other command runs in a throwaway container:
# docker compose run --rm helper <command>.

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
compose_file="$dir/compose.yml"

if [ "${1:-}" != update ]; then
  exec docker compose -f "$compose_file" run --rm helper "$@"
fi

compose() { docker compose -f "$compose_file" "$@"; }
fail() { printf 'x %s\n' "$*" >&2; exit 1; }

# The release an image was built from, or its short id for a local build.
image_version() {
  v=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null) || v=""
  case "$v" in "" | "<no value>") v=$(printf '%s' "$1" | sed 's/^sha256://' | cut -c 1-12) ;; esac
  printf '%s' "$v"
}

# "<state> <image id>" of the service's container when it's running, or restarting
# after a crash (when an update matters most); nothing when it's stopped or absent.
service_state() {
  for id in $(compose ps -aq helper 2>/dev/null); do
    s=$(docker inspect -f '{{.State.Status}} {{.Image}}' "$id" 2>/dev/null)
    case "$s" in running\ * | restarting\ *) printf '%s' "$s"; return ;; esac
  done
}

image=$(compose config --images 2>/dev/null | head -n 1)
[ -n "$image" ] || fail "Couldn't read $compose_file."
if grep -q '^PCH_IMAGE=..*' "$dir/.env" 2>/dev/null; then
  printf 'PCH_IMAGE in .env pins %s, so updates follow that tag.\n' "$image"
fi

before=$(service_state)
before=${before#* }
before_version=""
if [ -n "$before" ]; then before_version=$(image_version "$before"); fi

printf 'Pulling %s\n' "$image"
compose pull helper || fail "Couldn't pull $image."

# Refresh this script from the new image. mv swaps the file, so this run is unaffected.
if docker run --rm --network none "$image" wrapper sh >"$dir/pch.sh.new" 2>/dev/null && [ -s "$dir/pch.sh.new" ]; then
  mv "$dir/pch.sh.new" "$dir/pch.sh"
else
  rm -f "$dir/pch.sh.new"
fi

if [ -z "$before" ]; then
  printf "Pulled Paperclip Helper %s. The service isn't running; start it with:\n" "$(image_version "$image")"
  printf '  docker compose -f "%s" up -d\n' "$compose_file"
  exit 0
fi

compose up -d || fail "docker compose up failed."
state=$(service_state)
if [ "${state#* }" != "$before" ]; then
  sleep 5  # long enough for a new version that crashes on start to show it
  state=$(service_state)
fi
after=${state#* }
[ -n "$after" ] || fail "The service didn't start: docker compose -f \"$compose_file\" logs --tail 50"
if [ "$before" = "$after" ]; then
  printf 'Paperclip Helper %s is up to date.\n' "$(image_version "$after")"
else
  printf 'Updated Paperclip Helper: %s → %s.\n' "$before_version" "$(image_version "$after")"
fi
case "$state" in
  restarting\ *) printf '! The service keeps restarting: docker compose -f "%s" logs --tail 50\n' "$compose_file" >&2 ;;
esac
