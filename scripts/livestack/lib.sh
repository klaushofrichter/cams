# lib.sh: shared paths and helpers for the live-stack harness
# (start-sim-stack.sh, start-real-stack.sh, start-two-proxy-stack.sh,
# stop-stack.sh, check-stack.sh, check-two-proxy.sh,
# run-all-suites.sh). Sourced, never run. See docs/livestack.md.
#
# Paths (all overridable through the environment):
#   LIVESTACK_DIR           work dir: worktrees (src-*), run/, logs/, run.env,
#                           pids, fixtures/. Default ${TMPDIR:-/tmp}/cams-livestack.
#                           Always outside this repo (refused otherwise): run/
#                           of a real-camera run holds camera footage.
#   LIVESTACK_DEV_DIR       where the sibling repos live (default ~/Development)
#   LIVESTACK_CAM_SIM_REPO  default $LIVESTACK_DEV_DIR/cam-sim
#   LIVESTACK_CAM_PROXY_REPO default $LIVESTACK_DEV_DIR/cam-proxy
#   LIVESTACK_REOLINK_DIR   default $LIVESTACK_DEV_DIR/reolink (its .env names the camera)
#   LIVESTACK_CAMS_REPO     default: the repo these scripts are in
#   GO2RTC_BIN, MEDIAMTX_BIN default: the binaries in cam-proxy/tools and cam-sim/tools
#
# Never echoes a secret: values from env files and generated tokens go into
# files (mode 600) or variables, and processes get them through *_FILE.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"   # scripts/livestack
DEV_DIR="${LIVESTACK_DEV_DIR:-$HOME/Development}"
CAMS_REPO="${LIVESTACK_CAMS_REPO:-$(cd "$HERE/../.." && pwd -P)}"
CAM_SIM_REPO="${LIVESTACK_CAM_SIM_REPO:-$DEV_DIR/cam-sim}"
CAM_PROXY_REPO="${LIVESTACK_CAM_PROXY_REPO:-$DEV_DIR/cam-proxy}"
REOLINK_DIR="${LIVESTACK_REOLINK_DIR:-$DEV_DIR/reolink}"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
WORK="${LIVESTACK_DIR:-$TMP_BASE/cams-livestack}"; WORK="${WORK%/}"
LOGS="$WORK/logs"
RUN="$WORK/run"            # the current stack's data, config and secrets
PIDS="$WORK/pids"          # "<pid> <name>" per line, written by start_bg
RUN_ENV="$WORK/run.env"    # tokens and URLs of the current stack (mode 600)
FIXTURES="$WORK/fixtures"  # cam-sim's generated test-pattern media (kept between runs)
GO2RTC_BIN="${GO2RTC_BIN:-$CAM_PROXY_REPO/tools/go2rtc}"
MEDIAMTX_BIN="${MEDIAMTX_BIN:-$CAM_SIM_REPO/tools/mediamtx}"
SESSION_EMAIL="livestack@example.invalid"   # the only allowlisted cams user

die() { echo "livestack: $*" >&2; exit 1; }
note() { echo "livestack: $*"; }

# The work dir must not be inside the cams repo (nothing of a run may end up
# in a commit). A relative LIVESTACK_DIR is taken from the current directory.
case "$WORK" in /*) ;; *) WORK="$PWD/$WORK" ;; esac
case "$WORK/" in "$CAMS_REPO"/*) die "LIVESTACK_DIR ($WORK) is inside the repo; use a folder outside it" ;; esac
mkdir -p "$WORK" && chmod 700 "$WORK"

# repo_path NAME: the source repo of cam-sim, cam-proxy or cams.
repo_path() {
  case "$1" in
    cam-sim) echo "$CAM_SIM_REPO" ;;
    cam-proxy) echo "$CAM_PROXY_REPO" ;;
    cams) echo "$CAMS_REPO" ;;
    *) die "unknown repo $1" ;;
  esac
}

# env_get FILE KEY: the value of KEY=... in FILE (surrounding quotes removed),
# on stdout, for capture into a variable only. Never sources the file, so
# nothing else in it is evaluated or exported.
env_get() {
  local file="$1" key="$2" v
  [ -r "$file" ] || return 1
  v="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  v="${v%$'\r'}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  printf '%s' "$v"
}

# put_secret NAME VALUE: writes VALUE (no newline) to $RUN/secrets/NAME, mode 600.
put_secret() {
  ( umask 077; mkdir -p "$RUN/secrets"; printf '%s' "$2" > "$RUN/secrets/$1" )
}

gen_token() { openssl rand -hex 24; }   # 48 characters

# A stack is running when the pids file names a live process.
stack_running() {
  [ -f "$PIDS" ] || return 1
  local pid name
  while read -r pid name; do
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
  done < "$PIDS"
  return 1
}

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

require_ports_free() {
  local p
  for p in "$@"; do port_free "$p" || die "port $p is in use; pick another or stop what listens there"; done
}

# prepare_repo REPO [REF [DIR]]: a detached worktree of REF (default
# origin/main) at DIR (default $WORK/src-REPO), with npm ci + npm run build
# done once per commit (marker .livestack-built). A REF that is a tag or a
# commit is checked out as is; LIVESTACK_REFRESH=1 moves an existing worktree
# to the newest REF. The repo's own checkout is never touched (only fetch and
# worktree add).
prepare_repo() {
  local repo="$1" ref="${2:-origin/main}" dir="${3:-$WORK/src-$1}" src sha
  src="$(repo_path "$repo")"
  [ -d "$src/.git" ] || [ -f "$src/.git" ] || die "$repo: no git repo at $src (set LIVESTACK_DEV_DIR or the LIVESTACK_*_REPO for it)"
  git -C "$src" fetch -q --tags origin main || die "$repo: git fetch failed"
  git -C "$src" rev-parse -q --verify "$ref^{commit}" >/dev/null || die "$repo: no commit $ref"
  if [ -d "$dir" ]; then
    if [ "${LIVESTACK_REFRESH:-0}" = 1 ]; then
      git -C "$dir" checkout -q --detach "$ref" || die "$repo: checkout failed"
    fi
  else
    git -C "$src" worktree prune
    git -C "$src" worktree add -q --detach "$dir" "$ref" || die "$repo: worktree add failed"
  fi
  sha="$(git -C "$dir" rev-parse HEAD)"
  if [ "$(cat "$dir/.livestack-built" 2>/dev/null)" != "$sha" ]; then
    note "$repo: npm ci + build at ${sha:0:7} (log: $LOGS/build-$repo.log)"
    ( cd "$dir" && npm ci --no-audit --no-fund && npm run build ) > "$LOGS/build-$repo.log" 2>&1 \
      || die "$repo: build failed, see $LOGS/build-$repo.log"
    echo "$sha" > "$dir/.livestack-built"
  else
    note "$repo: built at ${sha:0:7}"
  fi
}

# latest_tag REPO: the repo's newest release tag (v<date>.<n>), after a fetch.
latest_tag() {
  local src; src="$(repo_path "$1")"
  git -C "$src" fetch -q --tags origin || die "$1: git fetch failed"
  git -C "$src" tag -l 'v*' --sort=-v:refname | head -n 1
}

# remove_worktrees: removes the stacks' src-* worktrees and run-all-suites.sh's
# suites/src-* worktrees from their repos (stop-stack.sh --clean).
remove_worktrees() {
  local repo dir
  for repo in cams cam-proxy cam-sim; do
    # src-REPO, and src-REPO-<ref> of the two-proxy stack
    for dir in "$WORK/src-$repo" "$WORK/src-$repo"-* "$WORK/suites/src-$repo"; do
      [ -d "$dir" ] || continue
      git -C "$(repo_path "$repo")" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
      git -C "$(repo_path "$repo")" worktree prune
      note "removed worktree $dir"
    done
  done
}

# start_bg NAME CMD...: starts CMD in the background (nohup, its own pid),
# logs to logs/NAME.log, records "<pid> NAME" in the pids file for stop-stack.sh.
start_bg() {
  local name="$1"; shift
  nohup "$@" > "$LOGS/$name.log" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid $name" >> "$PIDS"
  note "$name started (pid $pid, log $LOGS/$name.log)"
}

# wait_http URL SECONDS NAME: waits for a 2xx answer.
wait_http() {
  local url="$1" secs="$2" name="$3" i=0
  while [ "$i" -lt "$secs" ]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then note "$name is up"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  die "$name did not answer $url within ${secs}s (see $LOGS/)"
}

# The proxy's secrets as NAME_FILE variables (the FTP password only when the
# stack has one), in the array PENV. cam-proxy reads CAMPROXY_*_FILE itself,
# so no secret is ever on a command line or in the environment as a value.
# proxy_secret_env [SECRETS_DIR]: default $RUN/secrets (the two-proxy stack
# has one folder per proxy).
proxy_secret_env() {
  local d="${1:-$RUN/secrets}"
  PENV=(CAMPROXY_TOKENS_FILE="$d/proxy_tokens"
        CAMPROXY_ADMIN_TOKEN_FILE="$d/proxy_admin_token"
        CAMPROXY_CAMERA_PASSWORD_FILE="$d/camera_password")
  if [ -f "$d/ftp_password" ]; then PENV+=(CAMPROXY_FTP_PASSWORD_FILE="$d/ftp_password"); fi
}

# validate_proxy_config CONFIG [SRC_DIR [SECRETS_DIR]]: checks a cam-proxy
# config the way the proxy will load it (schema and cross checks), without
# starting anything. SRC_DIR defaults to $WORK/src-cam-proxy.
validate_proxy_config() {
  proxy_secret_env "${3:-}"
  ( cd "${2:-$WORK/src-cam-proxy}" && env CAMPROXY_CONFIG="$1" "${PENV[@]}" \
    node -e 'require("./dist/src/config/load").loadConfig(process.env); console.log("cam-proxy config ok")' ) \
    || die "cam-proxy config $1 is invalid"
}

# validate_cams_cameras FILE [SRC_DIR]: checks a cams cameras file with cams'
# own loader (prints ids only). SRC_DIR defaults to $WORK/src-cams.
validate_cams_cameras() {
  ( cd "${2:-$WORK/src-cams}" && LOG_LEVEL=silent node -e 'const l=require("./dist/server/cameraRegistry").loadCameras(process.argv[1]); console.log("cams cameras ok: " + l.map(c => c.id + (c.proxy ? " (proxy)" : "")).join(", "))' "$1" ) \
    || die "cams cameras file $1 is invalid"
}

# start_proxy CONFIG [NAME [SRC_DIR [SECRETS_DIR]]]: cam-proxy from the
# worktree's dist, every listener on 127.0.0.1 (bind-local.cjs preload:
# cam-proxy has no bind option), secrets from files. Google Vision's key and
# URL are dropped from the environment, so a local proxy can never call it.
start_proxy() {
  proxy_secret_env "${4:-}"
  start_bg "${2:-cam-proxy}" env -C "${3:-$WORK/src-cam-proxy}" \
    -u CAMPROXY_GOOGLE_VISION_KEY -u CAMPROXY_GOOGLE_VISION_URL -u CAMPROXY_ENV_FILE \
    CAMPROXY_CONFIG="$1" "${PENV[@]}" \
    LIVESTACK_BIND=127.0.0.1 \
    node --require "$HERE/bind-local.cjs" dist/src/cli.js
}

# start_cams CAMERAS_FILE PORT [SRC_DIR]: cams from the worktree's dist
# (default $WORK/src-cams) on 127.0.0.1.
# Google sign-in is a dummy client that is never used: check-stack.sh signs
# its own session cookie with this run's COOKIE_SECRET. The rate limits are
# raised so a check run is never throttled. COOKIE_SECRET is the one value
# passed in the environment (cams has no *_FILE for it); it is per run.
start_cams() {
  local cookie_secret
  cookie_secret="$(env_get "$RUN_ENV" CAMS_COOKIE_SECRET)"
  start_bg cams env -C "${3:-$WORK/src-cams}" \
    PORT="$2" \
    COOKIE_SECRET="$cookie_secret" \
    GOOGLE_CLIENT_ID=livestack GOOGLE_CLIENT_SECRET=livestack \
    GOOGLE_REDIRECT_URI="http://127.0.0.1:$2/auth/google/callback" \
    ALLOWED_EMAILS="$SESSION_EMAIL" \
    CAMERAS_FILE="$1" \
    PREFS_FILE="$RUN/cams/prefs.json" \
    PROXY_STATE_FILE="$RUN/cams/proxy-state.json" \
    CACHE_DIR="$RUN/cams/cache" \
    APP_VERSION=livestack LOG_LEVEL=info \
    RATE_LIMIT_MAX=1000 RATE_LIMIT_API_MAX=10000 RATE_LIMIT_MEDIA_MAX=10000 RATE_LIMIT_IMAGE_MAX=50000 \
    LIVESTACK_BIND=127.0.0.1 \
    node --require "$HERE/bind-local.cjs" dist/server/server.js
}

# Fresh run folder; refuses while a stack runs. Checks the tools first.
new_run() {
  stack_running && die "a stack is running (pids in $PIDS); run stop-stack.sh first"
  [ -x "$GO2RTC_BIN" ] || die "go2rtc missing at $GO2RTC_BIN (cam-proxy scripts/install-go2rtc.sh, or set GO2RTC_BIN)"
  command -v ffmpeg >/dev/null || die "ffmpeg is not on the PATH"
  command -v jq >/dev/null || die "jq is not on the PATH"
  command -v openssl >/dev/null || die "openssl is not on the PATH"
  rm -rf "$RUN" "$PIDS"
  mkdir -p "$LOGS" "$RUN/cams/cache" "$RUN/proxy-data"
  chmod 700 "$RUN"
  ( umask 077; : > "$RUN_ENV" )
}

# runenv_put KEY VALUE: appends to run.env (mode 600), read back by env_get.
runenv_put() { ( umask 077; printf '%s=%s\n' "$1" "$2" >> "$RUN_ENV" ); }
