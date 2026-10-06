#!/usr/bin/env bash
# check-two-proxy.sh: the checks against a running two-proxy stack
# (start-two-proxy-stack.sh). See docs/livestack.md, "Two proxies".
#
# 1. scripts/livestack/two-proxy.spec.ts (Playwright, Google Chrome, its own
#    config two-proxy.config.ts: no web servers, cams' URL from run.env):
#    both cameras listed; one SSE client per proxy, however many cameras it
#    serves; live view and snapshot per camera; stills, a clip
#    and a top-bar notice per camera; an event on one proxy never shows for
#    the other's camera (both ways); the Archive merges both proxies (one clip
#    archived on each, listed with its camera, one ZIP per proxy; with
#    TWOPROXY_B_CAMS > 1 a neighbour's clip on proxy B and its ZIP's name); proxy B
#    stopped (camera A goes on, B's proxy shows unreachable) and started again
#    (its events flow, nothing old replayed). That step stops and starts
#    proxy B through start-two-proxy-stack.sh --stop-proxy-b / --start-proxy-b.
# 2. The generator again, a dry run: it must find nothing to change.
#
# Runs from this repo's checkout (npm ci done, for Playwright and tsx).
# Proxy B ends up running again, also when the spec fails midway. Never
# prints a token (the spec reads run.env itself). Exit status 0 only when
# both parts pass.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

[ "$(env_get "$RUN_ENV" STACK)" = two-proxy ] || die "no two-proxy stack in $WORK: run start-two-proxy-stack.sh first"
[ -x "$CAMS_REPO/node_modules/.bin/playwright" ] || die "no Playwright in $CAMS_REPO: npm ci first"

FAILS=0
echo "== 1. Playwright: scripts/livestack/two-proxy.spec.ts"
( cd "$CAMS_REPO" && TWOPROXY_RUN_ENV="$RUN_ENV" npx --no-install playwright test -c scripts/livestack/two-proxy.config.ts ) || FAILS=$((FAILS + 1))

# Proxy B back up whatever the spec did (it stops it on purpose midway).
if ! curl -fsS -o /dev/null --max-time 3 "$(env_get "$RUN_ENV" PROXY_B_URL)/health" 2>/dev/null; then
  note "cam-proxy B is down after the spec: starting it again"
  "$HERE/start-two-proxy-stack.sh" --start-proxy-b || FAILS=$((FAILS + 1))
fi

echo "== 2. cameras-config again (dry run): no changes expected"
CAMS_SRC="$(env_get "$RUN_ENV" CAMS_SRC)"
OUT="$( cd "$CAMS_SRC" && npx --no-install tsx scripts/cameras-config.ts --input "$RUN/cams/cameras-config.json" --output "$RUN/cams/cameras.json" 2>&1 )"; rc=$?
printf '%s\n' "$OUT" | sed 's/^/  /'
if [ "$rc" = 0 ] && printf '%s\n' "$OUT" | grep -qx '(no changes)'; then
  echo "  PASS generator re-run is a no-op"
else
  echo "  FAIL generator re-run (exit $rc) wants changes"; FAILS=$((FAILS + 1))
fi

echo
[ "$FAILS" -eq 0 ] && echo "check-two-proxy: all passed" || echo "check-two-proxy: $FAILS part(s) failed"
[ "$FAILS" -eq 0 ]
