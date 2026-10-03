#!/usr/bin/env bash
# check-stack.sh <proxyUrl> <camsUrl> <cam>: the 23 API-level checks against a
# running stack. See docs/livestack.md for what each check proves.
#
#   sim:  check-stack.sh http://127.0.0.1:19480 http://127.0.0.1:19580 simcam
#   real: check-stack.sh http://127.0.0.1:19481 http://127.0.0.1:19581 cam1
#
# Talks to cams with a session cookie signed with this run's COOKIE_SECRET
# (from run.env in the work dir; no Google sign-in) and to cam-proxy with this
# run's client and admin tokens (run.env). Tokens go into header files in a
# private temp folder (curl -H @file), never on a command line or the terminal.
#
# Requests: GETs only, plus two read-only inventory runs (stills; clips with
# the camera compare) through POST /control/actions/inventory. Never a repair,
# never the events repair, never a camera settings write, never the Pi.
# Downloads (one sub recording, the first 2 MiB of its 4K file, a thumbnail,
# stills) land in that temp folder, which is deleted at the end.
#
# Prerequisites: curl, jq, node, xxd. Exit status 0 only when all checks pass.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

PROXY="${1:?usage: check-stack.sh <proxyUrl> <camsUrl> <cam>}"; PROXY="${PROXY%/}"
CAMS="${2:?usage: check-stack.sh <proxyUrl> <camsUrl> <cam>}"; CAMS="${CAMS%/}"
CAM="${3:?usage: check-stack.sh <proxyUrl> <camsUrl> <cam>}"
[ -s "$RUN_ENV" ] || die "no $RUN_ENV: start a stack first"
command -v jq >/dev/null || die "jq is not on the PATH"

TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
( umask 077
  printf 'Authorization: Bearer %s\n' "$(env_get "$RUN_ENV" PROXY_TOKEN)" > "$TMP/h_client"
  printf 'Authorization: Bearer %s\n' "$(env_get "$RUN_ENV" PROXY_ADMIN_TOKEN)" > "$TMP/h_admin"
  # The session cookie, signed like cams' server/session.ts: a JWT (HS256)
  # with {email, iat, exp} keyed with COOKIE_SECRET, valid one hour. The
  # email is the stack's only ALLOWED_EMAILS entry, so cams accepts it as a
  # signed-in user without Google.
  COOKIE_SECRET="$(env_get "$RUN_ENV" CAMS_COOKIE_SECRET)" SESSION_EMAIL="$(env_get "$RUN_ENV" SESSION_EMAIL)" node -e '
    const c = require("crypto"); const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const h = b({ alg: "HS256", typ: "JWT" }), p = b({ email: process.env.SESSION_EMAIL, iat: now, exp: now + 3600 });
    const s = c.createHmac("sha256", process.env.COOKIE_SECRET).update(h + "." + p).digest("base64url");
    process.stdout.write("Cookie: session=" + h + "." + p + "." + s + "\n");' > "$TMP/h_cookie" )
: > "$TMP/h_none"

TZ_CAM="$(env_get "$RUN_ENV" CAM_TZ)"; TZ_CAM="${TZ_CAM:-America/Chicago}"
# Days in the camera's time zone (the recordings lists are per camera day).
# date -v is BSD/macOS, date -d GNU.
TODAY="$(TZ="$TZ_CAM" date +%F)"
YDAY="$(TZ="$TZ_CAM" date -v-1d +%F 2>/dev/null || TZ="$TZ_CAM" date -d yesterday +%F)"; MONTH="${TODAY:0:7}"

ROWS=(); FAILS=0
row() { # row RESULT NAME DETAIL
  ROWS+=("$1|$2|$3"); [ "$1" = FAIL ] && FAILS=$((FAILS + 1))
  printf '  %-4s %-34s %s\n' "$1" "$2" "${3:0:110}"
}
# get NAME URL HEADERFILE [MAXTIME]: body in $TMP/NAME.body, status in CODE.
get() {
  CODE="$(curl -sS -o "$TMP/$1.body" -D "$TMP/$1.hdr" -w '%{http_code}' --max-time "${4:-30}" -H @"$3" "$2" 2>"$TMP/$1.err")" || true
  [ -n "$CODE" ] || CODE=000
}
# partial NAME URL HEADERFILE BYTES MAXTIME: only the first BYTES of the body.
partial() {
  { curl -sS --max-time "$5" -D "$TMP/$1.hdr" -H @"$3" "$2" 2>/dev/null || true; } | head -c "$4" > "$TMP/$1.body"
  CODE="$(awk 'toupper($1) ~ /^HTTP\// {c=$2} END {print c}' "$TMP/$1.hdr" 2>/dev/null)"; [ -n "$CODE" ] || CODE=000
}
post_admin() { # post_admin NAME PATH JSON
  CODE="$(curl -sS -o "$TMP/$1.body" -w '%{http_code}' --max-time 30 -H @"$TMP/h_admin" -H 'Content-Type: application/json' -d "$3" "$PROXY$2" 2>"$TMP/$1.err")" || true
  [ -n "$CODE" ] || CODE=000
}
body() { cat "$TMP/$1.body" 2>/dev/null; }
size() { wc -c < "$TMP/$1.body" 2>/dev/null | tr -d ' '; }
header() { awk -v k="$(echo "$2" | tr 'A-Z' 'a-z')" 'BEGIN{FS=": "} tolower($1)==k {sub(/\r$/,"",$2); v=$2} END{print v}' "$TMP/$1.hdr" 2>/dev/null; }
is_mp4() { [ "$(LC_ALL=C dd if="$TMP/$1.body" bs=1 skip=4 count=4 2>/dev/null)" = ftyp ]; }
is_jpeg() { [ "$(head -c 2 "$TMP/$1.body" 2>/dev/null | xxd -p)" = ffd8 ]; }
err_of() { jq -r '.error // empty' "$TMP/$1.body" 2>/dev/null; }
mb() { awk -v b="$1" 'BEGIN{printf "%.1f MB", b/1048576}'; }

echo "check-stack: proxy $PROXY, cams $CAMS, camera $CAM, today $TODAY ($TZ_CAM)"

# --- health and sign-in ------------------------------------------------------
get cams_health "$CAMS/health" "$TMP/h_none"
[ "$CODE" = 200 ] && [ "$(body cams_health | jq -r .status)" = ok ] \
  && row PASS "cams /health" "version $(body cams_health | jq -r .version)" || row FAIL "cams /health" "HTTP $CODE"
get proxy_health "$PROXY/health" "$TMP/h_none"
[ "$CODE" = 200 ] && [ "$(body proxy_health | jq -r .ok)" = true ] \
  && row PASS "proxy /health" "version $(body proxy_health | jq -r .version)" || row FAIL "proxy /health" "HTTP $CODE"
get me "$CAMS/api/me" "$TMP/h_cookie"
[ "$CODE" = 200 ] && row PASS "cams session (/api/me)" "signed in" || row FAIL "cams session (/api/me)" "HTTP $CODE $(err_of me)"

# --- cameras -----------------------------------------------------------------
get cams_cameras "$CAMS/api/cameras" "$TMP/h_cookie"
if [ "$CODE" = 200 ] && [ "$(body cams_cameras | jq -r --arg c "$CAM" '.[] | select(.id==$c) | .proxy')" = true ]; then
  row PASS "cams camera list" "$(body cams_cameras | jq -r 'map(.id + (if .proxy then "(proxy)" else "" end)) | join(", ")')"
else row FAIL "cams camera list" "HTTP $CODE; $CAM missing or proxy not active"; fi
get cams_status "$CAMS/api/cameras/$CAM/status" "$TMP/h_cookie" 30
[ "$CODE" = 200 ] && [ "$(body cams_status | jq -r .online)" = true ] \
  && row PASS "cams camera status" "online, $(body cams_status | jq -r '[.model, .firmware] | map(select(.)) | join(" ")')" \
  || row FAIL "cams camera status" "HTTP $CODE $(body cams_status | jq -c '{online,error}' 2>/dev/null)"
get proxy_cameras "$PROXY/api/cameras" "$TMP/h_client"
[ "$CODE" = 200 ] && [ "$(body proxy_cameras | jq -r '.[0].online')" = true ] \
  && row PASS "proxy camera (client token)" "$(body proxy_cameras | jq -c '.[0] | {id, online, stream}')" \
  || row FAIL "proxy camera (client token)" "HTTP $CODE $(body proxy_cameras | jq -c '.[0] | {id, online}' 2>/dev/null)"

# --- recordings lists ----------------------------------------------------------
get proxy_rec_today "$PROXY/api/cameras/$CAM/recordings?date=$TODAY&stream=sub" "$TMP/h_client" 150
[ "$CODE" = 200 ] && row PASS "proxy recordings $TODAY (sub)" "$(body proxy_rec_today | jq length) files, $(body proxy_rec_today | jq '[.[] | select(.clipId)] | length') with an FTP clip" \
  || row FAIL "proxy recordings $TODAY (sub)" "HTTP $CODE $(err_of proxy_rec_today)"
# Pick the recording for the play/download checks: the newest one today (else
# yesterday) that has both a sub and a main file, else the newest with a sub
# file, else the newest event.
CLIP=""
for d in "$TODAY" "$YDAY"; do
  get "ev_$d" "$CAMS/api/cameras/$CAM/events?date=$d" "$TMP/h_cookie" 150
  if [ "$CODE" = 200 ] && body "ev_$d" | jq -e '.events | type == "array"' >/dev/null 2>&1; then
    row PASS "cams History $d" "$(body "ev_$d" | jq '.events | length') events, downloads=$(body "ev_$d" | jq -r .downloads)"
    [ -z "$CLIP" ] && CLIP="$(body "ev_$d" | jq -r '(([.events[] | select(.sizeSub != null and .sizeMain != null)] | last) // ([.events[] | select(.sizeSub != null)] | last) // (.events | last)) | .id // empty')"
  else row FAIL "cams History $d" "HTTP $CODE $(err_of "ev_$d")"; fi
done
# cams' "downloads" field names where recordings come from: proxy-recordings
# (the proxy's SD-card API, Baichuan) is the expected path with a cam-proxy.
DL_STATE="$(body "ev_$TODAY" | jq -r '.downloads // empty' 2>/dev/null)"
[ "$DL_STATE" = proxy-recordings ] && row PASS "cams uses proxy recordings" "downloads=proxy-recordings (SD card via Baichuan)" \
  || row FAIL "cams uses proxy recordings" "downloads=${DL_STATE:-?} (proxy = FTP copies fallback, ok/unavailable = camera)"
get cams_days "$CAMS/api/cameras/$CAM/days?month=$MONTH" "$TMP/h_cookie" 150
[ "$CODE" = 200 ] && body cams_days | jq -e '.days | type == "array"' >/dev/null 2>&1 \
  && row PASS "cams month days $MONTH" "$(body cams_days | jq -c .days)" || row FAIL "cams month days $MONTH" "HTTP $CODE $(err_of cams_days)"
get proxy_days "$PROXY/api/cameras/$CAM/recordings/days?month=$MONTH" "$TMP/h_client" 150
[ "$CODE" = 200 ] && row PASS "proxy month days $MONTH" "$(body proxy_days | jq -c .days)" || row FAIL "proxy month days $MONTH" "HTTP $CODE $(err_of proxy_days)"

# --- one recording through cams ----------------------------------------------------
if [ -z "$CLIP" ]; then
  row FAIL "pick a recording" "no event today or yesterday"
else
  echo "  ---- recording $CLIP"
  get play "$CAMS/api/cameras/$CAM/clips/$CLIP/video" "$TMP/h_cookie" 240
  [ "$CODE" = 200 ] && is_mp4 play && row PASS "play (video, sub)" "$(mb "$(size play)"), ftyp" \
    || row FAIL "play (video, sub)" "HTTP $CODE $(err_of play) $(size play) bytes"
  get dl_sub "$CAMS/api/cameras/$CAM/clips/$CLIP/download?quality=sub" "$TMP/h_cookie" 240
  LEN="$(header dl_sub content-length)"
  if [ "$CODE" = 200 ] && is_mp4 dl_sub && [ "$(size dl_sub)" -gt 0 ] && { [ -z "$LEN" ] || [ "$LEN" = "$(size dl_sub)" ]; }; then
    row PASS "download sub" "$(mb "$(size dl_sub)"), ftyp, $(header dl_sub content-disposition | sed 's/.*filename=//')"
  else row FAIL "download sub" "HTTP $CODE $(err_of dl_sub) got $(size dl_sub) of ${LEN:-?} bytes"; fi
  get fq "$CAMS/api/cameras/$CAM/clips/$CLIP/full-quality" "$TMP/h_cookie" 150
  AVAIL="$(body fq | jq -r '.available // empty' 2>/dev/null)"
  [ "$CODE" = 200 ] && [ -n "$AVAIL" ] && row PASS "4K available? (full-quality)" "available=$AVAIL" || row FAIL "4K available? (full-quality)" "HTTP $CODE $(err_of fq)"
  # The first 2 MiB of the 4K file (a whole one is 100+ MB), or the refusal.
  partial dl_main "$CAMS/api/cameras/$CAM/clips/$CLIP/download?quality=main" "$TMP/h_cookie" 2097152 300
  if [ "$CODE" = 200 ] && is_mp4 dl_main; then
    row PASS "download 4K (main)" "streams, ftyp, Content-Length $(header dl_main content-length) ($(header dl_main content-disposition | sed 's/.*filename=//'))"
  elif [ "$CODE" = 503 ] && [ "$(err_of dl_main)" = full_quality_unavailable ]; then
    [ "$AVAIL" = false ] && row PASS "download 4K (main)" "503 full_quality_unavailable, matches available=false" \
      || row FAIL "download 4K (main)" "503 full_quality_unavailable although available=$AVAIL"
  else row FAIL "download 4K (main)" "HTTP $CODE $(err_of dl_main)"; fi
  get thumb "$CAMS/api/cameras/$CAM/clips/$CLIP/thumb.jpg" "$TMP/h_cookie" 120
  [ "$CODE" = 200 ] && is_jpeg thumb && row PASS "event thumbnail" "JPEG $(size thumb) bytes" || row FAIL "event thumbnail" "HTTP $CODE $(err_of thumb)"
fi

# --- stills and snapshot ---------------------------------------------------------
NOW_MS="$(($(date +%s) * 1000))"
get proxy_stills "$PROXY/api/cameras/$CAM/stills?from=$((NOW_MS - 120000))&to=$NOW_MS" "$TMP/h_client"
NST="$(body proxy_stills | jq 'length' 2>/dev/null)"; NST="${NST:-0}"
[ "$CODE" = 200 ] && [ "$NST" -gt 0 ] && row PASS "proxy stills (last 2 min)" "$NST stills" \
  || row FAIL "proxy stills (last 2 min)" "HTTP $CODE, $NST stills"
get still "$CAMS/api/cameras/$CAM/still/latest.jpg" "$TMP/h_cookie"
ST="$(header still x-still-time)"
[ "$CODE" = 200 ] && is_jpeg still && row PASS "cams latest still (proxy)" "JPEG $(size still) bytes, age $(( (NOW_MS - ${ST:-$NOW_MS}) / 1000 )) s" \
  || row FAIL "cams latest still (proxy)" "HTTP $CODE $(err_of still)"
get snap "$CAMS/api/cameras/$CAM/snapshot.jpg" "$TMP/h_cookie" 30
[ "$CODE" = 200 ] && is_jpeg snap && row PASS "cams snapshot (camera Snap)" "JPEG $(size snap) bytes" || row FAIL "cams snapshot (camera Snap)" "HTTP $CODE $(err_of snap)"

# --- proxy control (admin token): status and read-only inventories ----------------------
get cstatus "$PROXY/control/status" "$TMP/h_admin"
if [ "$CODE" = 200 ] && body cstatus | jq -e 'has("recordings")' >/dev/null 2>&1; then
  row PASS "proxy /control/status" "recordings: $(body cstatus | jq -c .recordings)"
else row FAIL "proxy /control/status" "HTTP $CODE $(err_of cstatus)"; fi

# inventory KIND JSON TIMEOUT: starts a read-only inventory run (never a
# repair) and waits for its report. Starting answers 409 while another run
# holds the proxy's inventory lock (e.g. its own startup check): retry for up
# to 2 min. The run answers 202 with a runId; its report is polled until the
# outcome is no longer "running" (a report exists from the start, so HTTP 200
# alone does not mean done), for up to TIMEOUT seconds. The clips compare
# lists the camera's SD card day by day, so it can take minutes on the real
# camera.
inventory() {
  local kind="$1" json="$2" secs="$3" name="inventory $1" id="" i=0
  [ "$json" = '{"kind":"clips","camera":true}' ] && name="clips compare (camera)"
  while :; do
    post_admin "inv_$kind" /control/actions/inventory "$json"
    [ "$CODE" = 409 ] && [ $i -lt 120 ] && { sleep 5; i=$((i + 5)); continue; }  # another run holds the lock
    break
  done
  id="$(body "inv_$kind" | jq -r '.runId // empty' 2>/dev/null)"
  if [ "$CODE" != 202 ] || [ -z "$id" ]; then row FAIL "$name" "start: HTTP $CODE $(err_of "inv_$kind")"; return; fi
  i=0
  while [ $i -lt "$secs" ]; do
    get "run_$kind" "$PROXY/control/inventory/runs/$id" "$TMP/h_admin"
    [ "$CODE" = 200 ] && [ "$(body "run_$kind" | jq -r .outcome)" != running ] && break
    sleep 3; i=$((i + 3))
  done
  if [ "$CODE" != 200 ]; then row FAIL "$name" "$id: no report after ${secs}s"; return; fi
  local outcome; outcome="$(body "run_$kind" | jq -r .outcome)"
  [ "$outcome" = ok ] && row PASS "$name" "$(body "run_$kind" | jq -r '.message') $(body "run_$kind" | jq -c .counts)" \
    || row FAIL "$name" "outcome=$outcome $(body "run_$kind" | jq -r '.error // .message')"
}
inventory stills '{"kind":"stills"}' 180
inventory clips '{"kind":"clips","camera":true}' 400

# --- summary -------------------------------------------------------------------------------
echo
printf '%-4s  %-34s  %s\n' RES CHECK DETAIL
printf '%-4s  %-34s  %s\n' ---- ---------------------------------- ------
for r in "${ROWS[@]}"; do
  IFS='|' read -r res name detail <<< "$r"
  printf '%-4s  %-34s  %s\n' "$res" "$name" "${detail:0:100}"
done
echo
echo "$(( ${#ROWS[@]} - FAILS )) passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
