#!/usr/bin/env bash
# start-two-proxy-stack.sh [--stop-proxy-b | --start-proxy-b]: one cams with
# two cam-proxies, each with its own cam-sim, all local. See docs/livestack.md,
# "Two proxies".
#
#   cam-sim A ──> cam-proxy A ──┐
#                               ├──> cams (cameras.json written by
#   cam-sim B ──> cam-proxy B ──┘     scripts/cameras-config.ts)
#
# Without an option: builds and starts the whole stack (a fresh run/, like
# start-sim-stack.sh; a running stack is refused). Then
# check-two-proxy.sh checks it, and stop-stack.sh stops it.
#   --stop-proxy-b   stops only cam-proxy B (the outage check)
#   --start-proxy-b  starts cam-proxy B again with the same config and data
#
# What runs (detached worktrees in the work dir, built once per commit):
#   cam-sim   origin/main, as in the sim stack
#   cam-proxy the newest release tag (TWOPROXY_PROXY_REF; proxy B
#             TWOPROXY_PROXY_B_REF, default the same), two processes with their
#             own config, dataDir, tokens and ports
#   cams      this repo's HEAD commit (TWOPROXY_CAMS_REF), so the stack tests
#             the branch it is run from; commit first
#
# Both proxies call their camera "cam1" (each single-camera proxy's default
# look), so the generator needs the prefixes "a-" and "b-": cams knows them as
# a-cam1 ("Alpha") and b-cam1 ("Bravo"), and each maps back to cam1 on its own
# proxy. That is the case where a mix-up between proxies would show.
#
# Multi-camera proxy B (cam-proxy P1+P2, released in v2026.10.05.7; cams
# plan 2026-10-05-multi-camera-p3-cams, Task 12): TWOPROXY_B_CAMS=N (default
# 1) starts N cam-sims behind proxy B (b-cam1 … b-camN) and writes proxy B's
# config with the "cameras": [ … ] list instead of "camera", each camera
# uploading by FTP as its own user (P2). A cam-proxy without them refuses
# that config, and this script stops there.
#
# Ports, all on 127.0.0.1 (the suites use 8090-8099, 8190-8598, 18480-18602;
# the sim and real stacks 19080-19943 but 19600-19899):
#   cam-sim #n (A = 1, B = 2…)  base 19600 + 10*(n-1): http +0, https +1,
#                               control+UI +2, rtsp +3, onvif +4, baichuan +5
#   cam-proxy A  19680, go2rtc 19681/19682, FTPS 19683, passive 19690-19699
#   cam-proxy B  19780, go2rtc 19781/19782, FTPS 19783, passive 19790-19799
#                (10 more per further camera: up to 19829)
#   cams         19880
#
# Secrets: every password and token is random per run, in run/secrets-a and
# run/secrets-b (mode 600) and run.env (mode 600); never printed, never on a
# command line. Never: the real camera, the Pi, the cluster, the PoE switch,
# Google Vision (off in both configs, its key dropped from the environment),
# a .env file, or any address but 127.0.0.1.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

MODE="${1:-}"
case "$MODE" in ""|--stop-proxy-b|--start-proxy-b) ;; *) die "usage: start-two-proxy-stack.sh [--stop-proxy-b | --start-proxy-b]" ;; esac

PROXY_A_PORT=19680 PROXY_B_PORT=19780 CAMS_PORT=19880
TZ_CAM=America/Chicago
sim_port() { echo $((19600 + 10 * ($1 - 1) + $2)); }   # sim_port N OFFSET

# --- outage control (proxy B only) --------------------------------------------
pid_of() { awk -v n="$1" '$2 == n {p=$1} END {print p}' "$PIDS" 2>/dev/null; }
if [ "$MODE" = --stop-proxy-b ]; then
  [ "$(env_get "$RUN_ENV" STACK)" = two-proxy ] || die "no two-proxy stack in $WORK"
  pid="$(pid_of cam-proxy-b)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q "$HERE"; then
    kill -TERM "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
    note "cam-proxy B stopped (pid $pid)"
  else
    note "cam-proxy B is not running"
  fi
  awk '$2 != "cam-proxy-b"' "$PIDS" > "$PIDS.tmp" && mv "$PIDS.tmp" "$PIDS"
  exit 0
fi
if [ "$MODE" = --start-proxy-b ]; then
  [ "$(env_get "$RUN_ENV" STACK)" = two-proxy ] || die "no two-proxy stack in $WORK"
  pid="$(pid_of cam-proxy-b)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && die "cam-proxy B is running (pid $pid)"
  require_ports_free $PROXY_B_PORT 19781 19782 19783
  start_proxy "$RUN/proxy-b/config.json" cam-proxy-b "$(env_get "$RUN_ENV" PROXY_B_SRC)" "$RUN/secrets-b"
  wait_http "http://127.0.0.1:$PROXY_B_PORT/health" 60 "cam-proxy B"
  exit 0
fi

# --- the whole stack -------------------------------------------------------------
B_CAMS="${TWOPROXY_B_CAMS:-1}"
[[ "$B_CAMS" =~ ^[1-4]$ ]] || die "TWOPROXY_B_CAMS is 1 to 4"
SIMS=$((1 + B_CAMS))   # sim 1 is A's, sims 2.. are B's
B_PASSIVE="19790-$((19789 + 10 * B_CAMS))"   # 10 per camera with FTP (cam-proxy spec 2026-10-05 §7)

new_run
ports=($PROXY_A_PORT 19681 19682 19683 $(seq 19690 19699) $PROXY_B_PORT 19781 19782 19783 $(seq 19790 $((19789 + 10 * B_CAMS))) $CAMS_PORT)
for n in $(seq 1 $SIMS); do for o in 0 1 2 3 4 5; do ports+=("$(sim_port "$n" $o)"); done; done
require_ports_free "${ports[@]}"
[ -x "$MEDIAMTX_BIN" ] || die "MediaMTX missing at $MEDIAMTX_BIN (cam-sim scripts/install-mediamtx.sh, or set MEDIAMTX_BIN)"

PROXY_A_REF="${TWOPROXY_PROXY_REF:-$(latest_tag cam-proxy)}"
PROXY_B_REF="${TWOPROXY_PROXY_B_REF:-$PROXY_A_REF}"
[ -n "$PROXY_A_REF" ] || die "cam-proxy: no release tag found"
CAMS_REF="${TWOPROXY_CAMS_REF:-$(git -C "$CAMS_REPO" rev-parse HEAD)}"
[ -z "$(git -C "$CAMS_REPO" status --porcelain -- server web scripts/cameras-config.ts 2>/dev/null)" ] \
  || note "cams has uncommitted changes in server/, web/ or the generator: the stack runs the commit ${CAMS_REF:0:7}, not them"
safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._' '-'; }
PROXY_A_SRC="$WORK/src-cam-proxy-$(safe "$PROXY_A_REF")"
PROXY_B_SRC="$WORK/src-cam-proxy-$(safe "$PROXY_B_REF")"
CAMS_SRC="$WORK/src-cams-$(git -C "$CAMS_REPO" rev-parse --short "$CAMS_REF")"

prepare_repo cam-sim
prepare_repo cam-proxy "$PROXY_A_REF" "$PROXY_A_SRC"
[ "$PROXY_B_SRC" = "$PROXY_A_SRC" ] || prepare_repo cam-proxy "$PROXY_B_REF" "$PROXY_B_SRC"
prepare_repo cams "$CAMS_REF" "$CAMS_SRC"

# Per-run secrets, one folder per proxy. Each proxy's cam-sims have two users,
# "proxy" (cam-proxy) and "cams" (cams), as on the real camera.
for x in a b; do
  d="$RUN/secrets-$x"
  ( umask 077; mkdir -p "$d" )
  pw_proxy="$(gen_token)" pw_cams="$(gen_token)"
  ( umask 077
    printf '%s' "$(gen_token)" > "$d/proxy_tokens"
    printf '%s' "$(gen_token)" > "$d/proxy_admin_token"
    printf '%s' "$pw_proxy" > "$d/camera_password"
    printf '%s' "$pw_cams" > "$d/cams_password"
    printf '%s' "$(gen_token)" > "$d/ftp_password"
    printf '%s' "$(gen_token)" > "$d/camsim_control_token"
    printf '%s' "proxy:admin:$pw_proxy;cams:admin:$pw_cams" > "$d/camsim_users" )
  unset pw_proxy pw_cams
done

B_IDS=()
for i in $(seq 1 "$B_CAMS"); do B_IDS+=("cam$i"); done
runenv_put STACK two-proxy
runenv_put CAM_TZ "$TZ_CAM"
runenv_put CAMS_URL "http://127.0.0.1:$CAMS_PORT"
runenv_put PROXY_A_URL "http://127.0.0.1:$PROXY_A_PORT"
runenv_put PROXY_B_URL "http://127.0.0.1:$PROXY_B_PORT"
runenv_put PROXY_A_REF "$PROXY_A_REF"
runenv_put PROXY_B_REF "$PROXY_B_REF"
runenv_put PROXY_B_SRC "$PROXY_B_SRC"
runenv_put CAMS_SRC "$CAMS_SRC"
runenv_put CAMS_A "a-cam1"
runenv_put CAMS_B "$(printf 'b-%s,' "${B_IDS[@]}" | sed 's/,$//')"
runenv_put SIM_A_CONTROL_URL "http://127.0.0.1:$(sim_port 1 2)"
runenv_put SIM_B_CONTROL_URLS "$(for n in $(seq 2 $SIMS); do printf 'http://127.0.0.1:%s,' "$(sim_port "$n" 2)"; done | sed 's/,$//')"
for x in a b; do
  X="$(echo "$x" | tr a-z A-Z)"
  runenv_put "PROXY_${X}_TOKEN" "$(cat "$RUN/secrets-$x/proxy_tokens")"
  runenv_put "PROXY_${X}_ADMIN_TOKEN" "$(cat "$RUN/secrets-$x/proxy_admin_token")"
  runenv_put "SIM_${X}_CONTROL_TOKEN" "$(cat "$RUN/secrets-$x/camsim_control_token")"
done
runenv_put CAMS_COOKIE_SECRET "$(gen_token)"
runenv_put SESSION_EMAIL "$SESSION_EMAIL"

# cam-proxy configs (schema: <src>/config.schema.json). One camera: the
# legacy "camera" object. Several (proxy B with TWOPROXY_B_CAMS > 1): the
# "cameras" list, each camera uploading by FTP as its own user (spec
# 2026-10-05 §4.2, §7: one FTP server for all, P2); an older proxy refuses it
# in validate_proxy_config.
camera_json() { # camera_json SIM_N ID NAME
  jq -n --arg id "$2" --arg name "$3" --argjson http "$(sim_port "$1" 0)" --argjson rtsp "$(sim_port "$1" 3)" \
    --argjson onvif "$(sim_port "$1" 4)" --argjson bc "$(sim_port "$1" 5)" \
    '{ id: $id, name: $name, host: ("127.0.0.1:" + ($http|tostring)), protocol: "http", user: "proxy",
       webUiUrl: "none", onvifPort: $onvif, rtspPort: $rtsp, baichuanPort: $bc, statusPollS: 5 }'
}
proxy_config() { # proxy_config X PORT FTP_PORT PASSIVE CAMERAS_JSON_ARRAY
  local x="$1"
  mkdir -p "$RUN/proxy-$x/data"
  jq -n --arg data "$RUN/proxy-$x/data" --arg go2rtc "$GO2RTC_BIN" --argjson port "$2" \
    --argjson grtsp $(($2 + 1)) --argjson gapi $(($2 + 2)) --argjson ftp "$3" --arg passive "$4" --argjson cams "$5" '{
    server: { port: $port, dataDir: $data, logLevel: "info" },
    go2rtc: { binary: $go2rtc, rtspPort: $grtsp, apiPort: $gapi },
    stills: { enabled: true, stream: "sub" },
    storage: { maxBytes: 5368709120, minFreeBytes: 2147483648 },
    recordings: { cacheMB: 1024 },
    analytics: { googleVision: { enabled: false } },
    ftp: { enabled: true, port: $ftp, passive: $passive, tls: true, stream: "sub", publicHost: "127.0.0.1" }
  } + (if ($cams | length) == 1
       then { camera: $cams[0] } | .ftp.user = "camera"
       else { cameras: ($cams | map(. + { ftp: { user: .id } })) } end)' > "$RUN/proxy-$x/config.json"
}
proxy_config a $PROXY_A_PORT 19683 19690-19699 "[$(camera_json 1 cam1 Alpha)]"
b_cams="$(for i in $(seq 1 "$B_CAMS"); do camera_json $((1 + i)) "cam$i" "$([ "$i" = 1 ] && echo Bravo || echo "Bravo $i")"; done | jq -s -c .)"
proxy_config b $PROXY_B_PORT 19783 "$B_PASSIVE" "$b_cams"
validate_proxy_config "$RUN/proxy-a/config.json" "$PROXY_A_SRC" "$RUN/secrets-a"
if [ "$B_CAMS" -gt 1 ]; then
  ( validate_proxy_config "$RUN/proxy-b/config.json" "$PROXY_B_SRC" "$RUN/secrets-b" ) \
    || die "proxy B ($PROXY_B_REF) refuses a config with $B_CAMS cameras: TWOPROXY_B_CAMS > 1 needs a cam-proxy with P1+P2 (v2026.10.05.7 or newer)"
else
  validate_proxy_config "$RUN/proxy-b/config.json" "$PROXY_B_SRC" "$RUN/secrets-b"
fi

# The cam-sims through sim-local.cjs (CLI bound to 127.0.0.1), one at a time
# (the first start generates the shared fixtures). Like the sim stack, but no
# automatic events: every event in a check run is one the check triggered, so
# it can say which proxy it must reach and which not. Each uploads its clips
# (sub) by FTPS to its own proxy, as its own FTP user there.
start_sim() { # start_sim N NAME X FTP_PORT FTP_USER (FTP_PORT "": no uploads)
  local n="$1" d="$RUN/secrets-$3" ftp=()
  mkdir -p "$RUN/camsim-$n" "$FIXTURES"
  [ -n "$4" ] && ftp=(CAMSIM_FTP_SERVER=127.0.0.1 CAMSIM_FTP_PORT="$4" CAMSIM_FTP_USER="$5"
    CAMSIM_FTP_PASSWORD_FILE="$d/ftp_password" CAMSIM_FTP_TLS=true CAMSIM_FTP_STREAM=sub)
  start_bg "cam-sim-$n" env \
    LIVESTACK_CAMSIM_DIR="$WORK/src-cam-sim" \
    CAMSIM_USERS_FILE="$d/camsim_users" CAMSIM_CONTROL_TOKEN_FILE="$d/camsim_control_token" \
    CAMSIM_NAME="$2" CAMSIM_TZ="$TZ_CAM" CAMSIM_SEED_CLIPS=demo CAMSIM_SD_MB=61047 \
    CAMSIM_FAULTS='[{"name":"downloads.refuse"}]' \
    CAMSIM_WEB_UI=true CAMSIM_LOG_LEVEL=info \
    CAMSIM_DATA_DIR="$RUN/camsim-$n" CAMSIM_FIXTURE_DIR="$FIXTURES" CAMSIM_MEDIAMTX="$MEDIAMTX_BIN" \
    CAMSIM_HTTP_PORT="$(sim_port "$n" 0)" CAMSIM_HTTPS_PORT="$(sim_port "$n" 1)" CAMSIM_CONTROL_PORT="$(sim_port "$n" 2)" \
    CAMSIM_RTSP_PORT="$(sim_port "$n" 3)" CAMSIM_ONVIF_PORT="$(sim_port "$n" 4)" CAMSIM_BAICHUAN_PORT="$(sim_port "$n" 5)" \
    ${ftp[@]+"${ftp[@]}"} \
    node "$HERE/sim-local.cjs"
  wait_http "http://127.0.0.1:$(sim_port "$n" 2)/healthz" 180 "cam-sim $n ($2)"
}
start_sim 1 Alpha a 19683 camera
for i in $(seq 1 "$B_CAMS"); do
  start_sim $((1 + i)) "$([ "$i" = 1 ] && echo Bravo || echo "Bravo $i")" b 19783 "$([ "$B_CAMS" = 1 ] && echo camera || echo "cam$i")"
done

start_proxy "$RUN/proxy-a/config.json" cam-proxy-a "$PROXY_A_SRC" "$RUN/secrets-a"
start_proxy "$RUN/proxy-b/config.json" cam-proxy-b "$PROXY_B_SRC" "$RUN/secrets-b"
wait_http "http://127.0.0.1:$PROXY_A_PORT/health" 60 "cam-proxy A"
wait_http "http://127.0.0.1:$PROXY_B_PORT/health" 60 "cam-proxy B"

# cams' cameras.json from the generator (README "Generating cameras.json"):
# its input names the two proxies, every secret as {"file": …} (mode 600).
# Loopback http, so no site CA and no pins (cam-proxy P5 isn't done). A dry
# run first (the diff, secrets as •••), then --write.
CAMS_CAMERAS="$RUN/cams/cameras.json" GEN_INPUT="$RUN/cams/cameras-config.json"
( umask 077; jq -n --arg a "http://127.0.0.1:$PROXY_A_PORT" --arg b "http://127.0.0.1:$PROXY_B_PORT" \
  --arg sa "$RUN/secrets-a" --arg sb "$RUN/secrets-b" '{ proxies: [
    { url: $a, prefix: "a-", protocol: "http", cameraUser: "cams",
      token: { file: ($sa + "/proxy_tokens") }, adminToken: { file: ($sa + "/proxy_admin_token") },
      cameraPassword: { file: ($sa + "/cams_password") },
      cameras: { cam1: { webUiNote: "Simulated camera Alpha (livestack, proxy A)" } } },
    { url: $b, prefix: "b-", protocol: "http", cameraUser: "cams",
      token: { file: ($sb + "/proxy_tokens") }, adminToken: { file: ($sb + "/proxy_admin_token") },
      cameraPassword: { file: ($sb + "/cams_password") },
      cameras: { cam1: { webUiNote: "Simulated camera Bravo (livestack, proxy B)" } } }
  ] }' > "$GEN_INPUT" )
generate() { ( cd "$CAMS_SRC" && npx --no-install tsx scripts/cameras-config.ts --input "$GEN_INPUT" --output "$CAMS_CAMERAS" "$@" ); }
note "cameras-config dry run:"
generate | sed 's/^/  /'
note "cameras-config --write:"
generate --write | sed 's/^/  /'
[ -s "$CAMS_CAMERAS" ] || die "the generator wrote no $CAMS_CAMERAS"
validate_cams_cameras "$CAMS_CAMERAS" "$CAMS_SRC"

start_cams "$CAMS_CAMERAS" $CAMS_PORT "$CAMS_SRC"
wait_http "http://127.0.0.1:$CAMS_PORT/health" 60 cams

cat <<EOF

Two-proxy stack up (all on 127.0.0.1; work dir $WORK):
  cam-sim A (Alpha)  control+UI :$(sim_port 1 2)   -> cam-proxy A ($PROXY_A_REF) http://127.0.0.1:$PROXY_A_PORT
  cam-sim B (Bravo)  control+UI :$(sim_port 2 2)$([ "$B_CAMS" -gt 1 ] && echo " (+$((B_CAMS - 1)) more)")   -> cam-proxy B ($PROXY_B_REF) http://127.0.0.1:$PROXY_B_PORT
  cams ($(git -C "$CAMS_SRC" rev-parse --short HEAD))  http://127.0.0.1:$CAMS_PORT   cameras $(env_get "$RUN_ENV" CAMS_A), $(env_get "$RUN_ENV" CAMS_B)
Check:  $HERE/check-two-proxy.sh
Stop:   $HERE/stop-stack.sh
EOF
