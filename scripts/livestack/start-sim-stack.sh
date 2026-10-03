#!/usr/bin/env bash
# start-sim-stack.sh: the simulated stack, cam-sim -> cam-proxy -> cams, all
# local. See docs/livestack.md.
#
# Starts (from detached worktrees of origin/main in the work dir, built once
# per commit): cam-sim (the camera), cam-proxy (the gateway, FTP on) and cams
# (the viewer, with that proxy). Writes a fresh run/ (configs, data, secrets)
# and run.env (per-run tokens, mode 600) in the work dir and records the PIDs
# for stop-stack.sh. Then triggers one 20 s person event on cam-sim.
#
# Ports, all on 127.0.0.1 (the automated suites use 8090-8099, 8190-8598,
# 18480, 18600, 18601, so both can run at once):
#   cam-sim   http 19080, https 19443, control+UI 19943, rtsp 19554,
#             onvif 19800, baichuan 19900
#   cam-proxy 19480, go2rtc 19555/19984, FTPS 19221, passive 19230-19239
#   cams      19580 (camera "simcam")
#
# Prerequisites: node + npm, git, jq, ffmpeg, openssl, lsof, curl; the
# cam-sim and cam-proxy repos (LIVESTACK_DEV_DIR, default ~/Development);
# go2rtc in cam-proxy/tools and MediaMTX in cam-sim/tools (their install
# scripts). The work dir is LIVESTACK_DIR (default ${TMPDIR:-/tmp}/cams-livestack).
#
# Never: touches the real camera or the Pi, binds anything but 127.0.0.1,
# reads a .env file, or prints a secret (all passwords and tokens are random
# per run).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SIM_HTTP=19080 SIM_HTTPS=19443 SIM_CONTROL=19943 SIM_RTSP=19554 SIM_ONVIF=19800 SIM_BAICHUAN=19900
PROXY_PORT=19480 GO2RTC_RTSP=19555 GO2RTC_API=19984 FTP_PORT=19221 FTP_PASSIVE=19230-19239
CAMS_PORT=19580
CAM=simcam
TZ_CAM=America/Chicago

new_run
require_ports_free $SIM_HTTP $SIM_HTTPS $SIM_CONTROL $SIM_RTSP $SIM_ONVIF $SIM_BAICHUAN \
  $PROXY_PORT $GO2RTC_RTSP $GO2RTC_API $FTP_PORT $(seq 19230 19239) $CAMS_PORT
[ -x "$MEDIAMTX_BIN" ] || die "MediaMTX missing at $MEDIAMTX_BIN (cam-sim scripts/install-mediamtx.sh, or set MEDIAMTX_BIN); cam-sim would run without RTSP and the proxy without stills"

prepare_repo cam-sim
prepare_repo cam-proxy
prepare_repo cams

# Per-run secrets: files in run/secrets (600), tokens also in run.env (600)
# for check-stack.sh. cam-sim gets two camera users: "proxy" for cam-proxy and
# "cams" for cams, as on the real camera.
PROXY_TOKEN="$(gen_token)"; PROXY_ADMIN="$(gen_token)"; SIM_CONTROL_TOKEN="$(gen_token)"
CAM_PW_PROXY="$(gen_token)"; CAM_PW_CAMS="$(gen_token)"; FTP_PW="$(gen_token)"
put_secret proxy_tokens "$PROXY_TOKEN"
put_secret proxy_admin_token "$PROXY_ADMIN"
put_secret camera_password "$CAM_PW_PROXY"
put_secret ftp_password "$FTP_PW"
put_secret camsim_users "proxy:admin:$CAM_PW_PROXY;cams:admin:$CAM_PW_CAMS"
put_secret camsim_control_token "$SIM_CONTROL_TOKEN"
runenv_put STACK sim
runenv_put CAM "$CAM"
runenv_put CAM_TZ "$TZ_CAM"
runenv_put PROXY_URL "http://127.0.0.1:$PROXY_PORT"
runenv_put CAMS_URL "http://127.0.0.1:$CAMS_PORT"
runenv_put SIM_CONTROL_URL "http://127.0.0.1:$SIM_CONTROL"
runenv_put PROXY_TOKEN "$PROXY_TOKEN"
runenv_put PROXY_ADMIN_TOKEN "$PROXY_ADMIN"
runenv_put CAMSIM_CONTROL_TOKEN "$SIM_CONTROL_TOKEN"
runenv_put CAMS_COOKIE_SECRET "$(gen_token)"
runenv_put SESSION_EMAIL "$SESSION_EMAIL"

# cam-proxy config (schema: src-cam-proxy/config.schema.json). FTP on, with
# TLS, so cam-sim's clip uploads reach the proxy as the camera's do the Pi.
PROXY_CONFIG="$RUN/proxy-config.json"
jq -n --arg data "$RUN/proxy-data" --arg go2rtc "$GO2RTC_BIN" --arg cam "$CAM" \
  --argjson port $PROXY_PORT --argjson http $SIM_HTTP --argjson onvif $SIM_ONVIF --argjson rtsp $SIM_RTSP \
  --argjson bc $SIM_BAICHUAN --argjson grtsp $GO2RTC_RTSP --argjson gapi $GO2RTC_API --argjson ftp $FTP_PORT \
  --arg passive "$FTP_PASSIVE" '{
  server: { port: $port, dataDir: $data, logLevel: "info" },
  camera: { id: $cam, name: "Sim", host: ("127.0.0.1:" + ($http|tostring)), protocol: "http", user: "proxy",
            webUiUrl: "none", onvifPort: $onvif, rtspPort: $rtsp, baichuanPort: $bc, statusPollS: 5 },
  go2rtc: { binary: $go2rtc, rtspPort: $grtsp, apiPort: $gapi },
  stills: { enabled: true, stream: "sub" },
  storage: { maxBytes: 5368709120, minFreeBytes: 2147483648 },
  recordings: { cacheMB: 1024 },
  ftp: { enabled: true, port: $ftp, passive: $passive, user: "camera", tls: true, stream: "sub", publicHost: "127.0.0.1" }
}' > "$PROXY_CONFIG"
validate_proxy_config "$PROXY_CONFIG"

# cams cameras file (README "Cameras"; server/cameraRegistry.ts). Mode 600:
# it holds the camera password and the proxy tokens (cams has no *_FILE for them).
CAMS_CAMERAS="$RUN/cams/cameras.json"
( umask 077; jq -n --arg cam "$CAM" --arg host "127.0.0.1:$SIM_HTTP" --arg url "http://127.0.0.1:$PROXY_PORT" \
  --rawfile token "$RUN/secrets/proxy_tokens" --rawfile admin "$RUN/secrets/proxy_admin_token" \
  --rawfile pw <(printf '%s' "$CAM_PW_CAMS") '[{
    id: $cam, name: "Sim", host: $host, protocol: "http", user: "cams", password: $pw,
    webUiNote: "Simulated camera (livestack)",
    proxy: { url: $url, token: $token, adminToken: $admin }
  }]' > "$CAMS_CAMERAS" )
validate_cams_cameras "$CAMS_CAMERAS"
unset CAM_PW_PROXY CAM_PW_CAMS FTP_PW PROXY_TOKEN PROXY_ADMIN

# 1. cam-sim through sim-local.cjs (its CLI bound to 127.0.0.1). It refuses
# HTTP Download like the real camera since 2026-10-01 (recordings must come
# over Baichuan), seeds four recordings today and two yesterday ("demo"),
# makes events now and then, and uploads its clips (sub) by FTPS to the proxy.
# The first start generates the test-pattern fixtures (ffmpeg, a minute or
# two); they stay in the work dir for the next run.
mkdir -p "$FIXTURES" "$RUN/camsim-data"
start_bg cam-sim env \
  LIVESTACK_CAMSIM_DIR="$WORK/src-cam-sim" \
  CAMSIM_USERS_FILE="$RUN/secrets/camsim_users" \
  CAMSIM_CONTROL_TOKEN_FILE="$RUN/secrets/camsim_control_token" \
  CAMSIM_NAME=Sim CAMSIM_TZ="$TZ_CAM" CAMSIM_SEED_CLIPS=demo CAMSIM_SD_MB=61047 \
  CAMSIM_FAULTS='[{"name":"downloads.refuse"}]' \
  CAMSIM_AUTO_EVENTS='motion:6/h,person:2/h' \
  CAMSIM_WEB_UI=true CAMSIM_LOG_LEVEL=info \
  CAMSIM_DATA_DIR="$RUN/camsim-data" CAMSIM_FIXTURE_DIR="$FIXTURES" CAMSIM_MEDIAMTX="$MEDIAMTX_BIN" \
  CAMSIM_HTTP_PORT=$SIM_HTTP CAMSIM_HTTPS_PORT=$SIM_HTTPS CAMSIM_CONTROL_PORT=$SIM_CONTROL \
  CAMSIM_RTSP_PORT=$SIM_RTSP CAMSIM_ONVIF_PORT=$SIM_ONVIF CAMSIM_BAICHUAN_PORT=$SIM_BAICHUAN \
  CAMSIM_FTP_SERVER=127.0.0.1 CAMSIM_FTP_PORT=$FTP_PORT CAMSIM_FTP_USER=camera \
  CAMSIM_FTP_PASSWORD_FILE="$RUN/secrets/ftp_password" CAMSIM_FTP_TLS=true CAMSIM_FTP_STREAM=sub \
  node "$HERE/sim-local.cjs"
wait_http "http://127.0.0.1:$SIM_CONTROL/healthz" 180 cam-sim

# 2. cam-proxy against that cam-sim.
start_proxy "$PROXY_CONFIG"
wait_http "http://127.0.0.1:$PROXY_PORT/health" 60 cam-proxy

# 3. cams with the proxy.
start_cams "$CAMS_CAMERAS" $CAMS_PORT
wait_http "http://127.0.0.1:$CAMS_PORT/health" 60 cams

# One person event now (20 s), so a fresh recording is listed and its clip
# reaches the proxy by FTP before check-stack.sh runs. The control token goes
# in a header file (curl -H @file), never on the command line.
HDR="$(mktemp -d)"; trap 'rm -rf "$HDR"' EXIT
( umask 077; printf 'Authorization: Bearer %s\n' "$(env_get "$RUN_ENV" CAMSIM_CONTROL_TOKEN)" > "$HDR/sim" )
if curl -fsS -o /dev/null --max-time 10 -H @"$HDR/sim" -H 'Content-Type: application/json' \
     -d '{"type":"person","durationS":20}' "http://127.0.0.1:$SIM_CONTROL/sim/api/events"; then
  note "triggered a 20 s person event on cam-sim (wait ~60 s before check-stack.sh for its FTP clip)"
else
  note "could not trigger an event on cam-sim (check $LOGS/cam-sim.log)"
fi

cat <<EOF

Sim stack up (all on 127.0.0.1; work dir $WORK):
  cam-sim   http :$SIM_HTTP  https :$SIM_HTTPS  control+UI :$SIM_CONTROL  rtsp :$SIM_RTSP  onvif :$SIM_ONVIF  baichuan :$SIM_BAICHUAN
  cam-proxy http://127.0.0.1:$PROXY_PORT  (ftp :$FTP_PORT, passive $FTP_PASSIVE, go2rtc :$GO2RTC_RTSP/:$GO2RTC_API)
  cams      http://127.0.0.1:$CAMS_PORT   camera "$CAM"
Check:  $HERE/check-stack.sh http://127.0.0.1:$PROXY_PORT http://127.0.0.1:$CAMS_PORT $CAM
Stop:   $HERE/stop-stack.sh
EOF
