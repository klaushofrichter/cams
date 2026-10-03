#!/usr/bin/env bash
# start-real-stack.sh: the REAL camera -> local cam-proxy -> local cams.
# See docs/livestack.md, "The real camera", for the whole procedure: the Pi's
# cam-proxy must be stopped first (by Klaus, or with his approval); this
# script does not do that and never connects to the Pi.
#
# Starts (from detached worktrees of origin/main in the work dir): cam-proxy,
# configured like the Pi's (camera user "proxy", https with the camera's
# Let's Encrypt name) but with FTP off, no PoE switch and Google Vision off;
# and cams with that proxy. Toward the camera: HTTP login/status/Search/Snap,
# one ONVIF subscription, one RTSP reader (stills), Baichuan downloads.
#
# Ports, all on 127.0.0.1: cam-proxy 19481 (go2rtc 19556/19985), cams 19581
# (camera "cam1"). The camera itself: https, onvif 8000, rtsp 554, baichuan 9000.
#
# Secrets, read at run time and never echoed (only the named keys are read;
# the files are never sourced):
#   $LIVESTACK_REOLINK_DIR/.env   REOLINK_IP (the camera's address)
#   $LIVESTACK_CAM_PROXY_REPO/.env CAMPROXY_CAMERA_PASSWORD (the camera's "proxy" user)
# They go to run/secrets (600) and reach cam-proxy through CAMPROXY_*_FILE.
# cams talks to the camera itself too (status, snapshot, live). Production
# cams has its own "cams" user, whose password is only in the cluster Secret;
# here it uses the proxy user unless CAMS_CAMERA_USER, CAMS_CAMERA_PASSWORD_KEY
# and CAMS_CAMERA_PASSWORD_ENV_FILE name another.
#
# Never: writes a camera setting, changes the camera's FTP target (it keeps
# pointing at the Pi), touches the Pi, binds anything but 127.0.0.1. Keep the
# run short: while it runs the Pi is down (docs/livestack.md).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PROXY_PORT=19481 GO2RTC_RTSP=19556 GO2RTC_API=19985
CAMS_PORT=19581
CAM=cam1
TZ_CAM=America/Chicago
REOLINK_ENV="$REOLINK_DIR/.env"            # REOLINK_IP
CAMPROXY_ENV="$CAM_PROXY_REPO/.env"         # CAMPROXY_CAMERA_PASSWORD
CAMERA_USER=proxy                           # as on the Pi: /srv/cam-proxy/data/config.json camera.user
CAMERA_TLS_NAME=cam1.skylar.technology      # the camera's Let's Encrypt certificate
CAMS_CAMERA_USER="${CAMS_CAMERA_USER:-proxy}"
CAMS_CAMERA_PASSWORD_KEY="${CAMS_CAMERA_PASSWORD_KEY:-CAMPROXY_CAMERA_PASSWORD}"
CAMS_CAMERA_PASSWORD_FILE_ENV="${CAMS_CAMERA_PASSWORD_ENV_FILE:-$CAMPROXY_ENV}"

new_run
require_ports_free $PROXY_PORT $GO2RTC_RTSP $GO2RTC_API $CAMS_PORT

# Values into variables only (env_get never prints to the terminal here).
CAMERA_IP="$(env_get "$REOLINK_ENV" REOLINK_IP)" || true
[ -n "$CAMERA_IP" ] || die "REOLINK_IP not found in $REOLINK_ENV"
CAM_PW="$(env_get "$CAMPROXY_ENV" CAMPROXY_CAMERA_PASSWORD)" || true
[ -n "$CAM_PW" ] || die "CAMPROXY_CAMERA_PASSWORD not found in $CAMPROXY_ENV"
CAMS_PW="$(env_get "$CAMS_CAMERA_PASSWORD_FILE_ENV" "$CAMS_CAMERA_PASSWORD_KEY")" || true
[ -n "$CAMS_PW" ] || die "$CAMS_CAMERA_PASSWORD_KEY not found in $CAMS_CAMERA_PASSWORD_FILE_ENV"

prepare_repo cam-proxy
prepare_repo cams

PROXY_TOKEN="$(gen_token)"; PROXY_ADMIN="$(gen_token)"
put_secret proxy_tokens "$PROXY_TOKEN"
put_secret proxy_admin_token "$PROXY_ADMIN"
put_secret camera_password "$CAM_PW"
put_secret cams_camera_password "$CAMS_PW"
unset CAM_PW CAMS_PW
runenv_put STACK real
runenv_put CAM "$CAM"
runenv_put CAM_TZ "$TZ_CAM"
runenv_put PROXY_URL "http://127.0.0.1:$PROXY_PORT"
runenv_put CAMS_URL "http://127.0.0.1:$CAMS_PORT"
runenv_put PROXY_TOKEN "$PROXY_TOKEN"
runenv_put PROXY_ADMIN_TOKEN "$PROXY_ADMIN"
runenv_put CAMS_COOKIE_SECRET "$(gen_token)"
runenv_put SESSION_EMAIL "$SESSION_EMAIL"
unset PROXY_TOKEN PROXY_ADMIN

# cam-proxy config, like the Pi's (cam-proxy docs/raspberry-pi.md) minus FTP
# and the PoE switch (the local proxy must never power-cycle the camera);
# Google Vision off (no key passed). Camera ports are the camera's defaults.
PROXY_CONFIG="$RUN/proxy-config.json"
jq -n --arg data "$RUN/proxy-data" --arg go2rtc "$GO2RTC_BIN" --arg cam "$CAM" --arg host "$CAMERA_IP" \
  --arg user "$CAMERA_USER" --arg tls "$CAMERA_TLS_NAME" \
  --argjson port $PROXY_PORT --argjson grtsp $GO2RTC_RTSP --argjson gapi $GO2RTC_API '{
  server: { port: $port, dataDir: $data, logLevel: "info" },
  camera: { id: $cam, name: "Den (local test)", host: $host, protocol: "https", tlsName: $tls, user: $user,
            onvifPort: 8000, rtspPort: 554, baichuanPort: 9000, statusPollS: 30, poeSwitch: { model: "none" } },
  go2rtc: { binary: $go2rtc, rtspPort: $grtsp, apiPort: $gapi },
  stills: { enabled: true, stream: "sub" },
  storage: { maxBytes: 5368709120, minFreeBytes: 2147483648 },
  recordings: { cacheMB: 2048 },
  ftp: { enabled: false, stream: "sub" },
  analytics: { googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0 } }
}' > "$PROXY_CONFIG"
validate_proxy_config "$PROXY_CONFIG"

# cams cameras file, mode 600 (camera password and proxy tokens).
CAMS_CAMERAS="$RUN/cams/cameras.json"
( umask 077; jq -n --arg cam "$CAM" --arg host "$CAMERA_IP" --arg tls "$CAMERA_TLS_NAME" --arg user "$CAMS_CAMERA_USER" \
  --arg url "http://127.0.0.1:$PROXY_PORT" \
  --rawfile token "$RUN/secrets/proxy_tokens" --rawfile admin "$RUN/secrets/proxy_admin_token" \
  --rawfile pw "$RUN/secrets/cams_camera_password" '[{
    id: $cam, name: "Den (local test)", host: $host, protocol: "https", tlsServername: $tls,
    user: $user, password: $pw,
    proxy: { url: $url, token: $token, adminToken: $admin }
  }]' > "$CAMS_CAMERAS" )
validate_cams_cameras "$CAMS_CAMERAS"

start_proxy "$PROXY_CONFIG"
wait_http "http://127.0.0.1:$PROXY_PORT/health" 60 cam-proxy
start_cams "$CAMS_CAMERAS" $CAMS_PORT
wait_http "http://127.0.0.1:$CAMS_PORT/health" 60 cams

cat <<EOF

Real stack up (listeners on 127.0.0.1; the camera is $CAMERA_IP, user $CAMERA_USER; work dir $WORK):
  cam-proxy http://127.0.0.1:$PROXY_PORT  (go2rtc :$GO2RTC_RTSP/:$GO2RTC_API, no FTP)
  cams      http://127.0.0.1:$CAMS_PORT   camera "$CAM" (camera user $CAMS_CAMERA_USER)
Give the proxy ~30 s for its first status poll and stills, then:
Check:  $HERE/check-stack.sh http://127.0.0.1:$PROXY_PORT http://127.0.0.1:$CAMS_PORT $CAM
Stop:   $HERE/stop-stack.sh --clean   (keep the run short; --clean deletes the footage in run/)
EOF
