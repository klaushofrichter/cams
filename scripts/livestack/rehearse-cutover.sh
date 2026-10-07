#!/usr/bin/env bash
# The cams side of the P4 cut-over rehearsal (cams-admin runbook §R step 4)
# on cams-admin's local stack: real cams processes from this repo's build go
# through cut-over steps 5–8 and their rollbacks (scripts/livestack/
# rehearse-cutover.ts says which). Needs the stack running:
#   (cd ~/Development/cams-admin && LOCALSTACK_DIR=<dir> scripts/localstack/start.sh --no-s3)
#   LOCALSTACK_DIR=<dir> scripts/livestack/rehearse-cutover.sh
# The result (and the cams logs, cameras.json files and exports: test data,
# mode 600) goes to $LOCALSTACK_DIR/rehearse-cams, never into git. Only
# 127.0.0.1: never the real camera, the Pi, the cluster or a real cams-admin.
set -euo pipefail
LS="${LOCALSTACK_DIR:-${TMPDIR:-/tmp}/cams-admin-localstack}"; LS="${LS%/}"
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
URL="${REHEARSE_ADMIN_URL:-http://localhost:29000}"
[ -r "$LS/run/cams-admin/cookie" ] || { echo "rehearse: no cams-admin local stack in $LS (start it first)" >&2; exit 2; }
curl -sf "$URL/health" >/dev/null || { echo "rehearse: cams-admin is not answering on $URL" >&2; exit 2; }
for p in 29610 29611; do ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || { echo "rehearse: port $p is in use" >&2; exit 2; }; done
( cd "$REPO" && npm run build ) > "$LS/logs/build-cams.log" 2>&1 || { echo "rehearse: cams build failed ($LS/logs/build-cams.log)" >&2; exit 1; }
W="$LS/rehearse-cams"
rm -rf "$W" && mkdir -p "$W" && chmod 700 "$W"
cd "$REPO"
exec npx tsx scripts/livestack/rehearse-cutover.ts --url "$URL" --session-file "$LS/run/cams-admin/cookie" --run "$LS/run" --account "${REHEARSE_ACCOUNT:-beta}" --work "$W"
