#!/usr/bin/env bash
# Boots a built Presio image and proves the local-mode backend actually works,
# then proves an existing deployment survives upgrading to it.
#
# Run by CI on pull requests that touch the image (.github/workflows/ci.yml) and
# again before publishing (.github/workflows/publish-local-image.yml). It lives
# here rather than inline in either so the two cannot drift.
#
#   deploy/smoke-test.sh <image> [previous-image]
#
# <image>          the build under test, already present locally
# [previous-image] a published release to upgrade *from*; skipped if absent or
#                  not pullable (a fresh fork, or before the first release)
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image> [previous-image]}"
PREV="${2:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ::error:: / ::notice:: are GitHub Actions annotations; harmless when run locally.
log()  { echo "$*"; }
fail() { echo "::error::$*"; exit 1; }

cleanup() {
  docker rm -f smoke old new >/dev/null 2>&1 || true
  docker volume rm presio-upgrade >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Waits for the container to serve, failing fast on a crash-loop rather than
# waiting out the whole timeout.
wait_for_http() {
  local name="$1" port="$2" status
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1; then return 0; fi
    status=$(docker inspect -f '{{.State.Status}}' "$name")
    if [ "$status" != "running" ]; then
      docker logs "$name" || true
      fail "$name is '$status' before serving traffic"
    fi
    sleep 2
  done
  docker logs "$name" || true
  fail "$name never became healthy"
}

run_container() {
  docker run -d --name "$1" -p "$2:3001" "${@:4}" \
    -e PRESIO_MODE=local -e LOCAL_DATA_DIR=/data -e TRUST_PROXY=false "$3" >/dev/null
  wait_for_http "$1" "$2"
}

# Creates a session by uploading a PDF; echoes "<id> <token>".
create_session() {
  local port="$1" resp
  resp=$(curl -fsS -F "file=@$REPO_ROOT/example/example.pdf" "http://localhost:$port/api/present")
  echo "$(echo "$resp" | jq -re .id) $(echo "$resp" | jq -re .url | sed 's/.*[?&]t=//')"
}

log "=== smoke test: $IMAGE ==="
run_container smoke 3001 "$IMAGE"

curl -fsS http://localhost:3001/healthz | jq -re .version
curl -fsS http://localhost:3001/ | grep -q "<title>" || fail "SPA not served"

# Exercise the SQLite + filesystem backend end to end: a session row is
# inserted, the PDF is written to /data, read back, then removed.
read -r id token <<<"$(create_session 3001)"
curl -fsS -o /tmp/handoff.pdf "http://localhost:3001/api/sessions/$id/handoff?t=$token"
[ -s /tmp/handoff.pdf ] || fail "handoff PDF empty"
curl -fsS -X POST -H "x-controller-token: $token" \
  "http://localhost:3001/api/sessions/$id/handoff/complete" | jq -re .ok
docker exec smoke test -f /data/presio.db || fail "SQLite DB not created"
docker rm -f smoke >/dev/null
log "smoke test passed"

# The test above only ever exercises a brand-new database. What actually breaks
# self-hosters is an *upgrade*: a released image is already running against a
# /data volume, and the new one has to adopt it without losing sessions (see the
# migration sequence in server/local/db.ts).
if [ -z "$PREV" ]; then
  log "::notice::no previous image given — skipping the upgrade test"
  exit 0
fi
if ! docker pull -q "$PREV" >/dev/null 2>&1; then
  log "::notice::no published $PREV yet — skipping the upgrade test"
  exit 0
fi

log "=== upgrade test: $PREV -> $IMAGE ==="
docker volume create presio-upgrade >/dev/null

run_container old 3002 "$PREV" -v presio-upgrade:/data
read -r id _token <<<"$(create_session 3002)"
log "created session $id on $PREV"
docker rm -f old >/dev/null

run_container new 3002 "$IMAGE" -v presio-upgrade:/data
docker logs new 2>&1 | grep -i "\[local\]" || true

# Read the row back through the API rather than poking the database, so the
# assertion is "the deployment still works", not "a row still exists".
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3002/api/sessions/$id/handoff?t=$_token")
[ "$code" = "200" ] || fail "session $id did not survive the upgrade (HTTP $code)"
log "session $id survived the upgrade"
