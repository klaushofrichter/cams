#!/usr/bin/env bash
# Vendor the cams-v1 contract (cams service API) from cams-admin.
# Usage: scripts/contract/vendor-cams-v1.sh [branch]   (default main; the
# drift check, cams-v1-drift.sh, compares with that branch's head)
# Copies cams-admin contract/cams-v1/ at <ref> into contract/cams-v1/, plus
# cams-admin's server/crypto/jcs.ts as contract/cams-v1/jcs.ts.txt (the test
# checks server/admin/jcs.ts is the same function), and writes SOURCE with
# the resolved commit. CAMS_ADMIN_REPO overrides ../cams-admin.
set -euo pipefail
branch=${1:-main}
ref=origin/$branch
here=$(cd "$(dirname "$0")/../.." && pwd)
repo=${CAMS_ADMIN_REPO:-$here/../cams-admin}
[ -d "$repo/.git" ] || [ -f "$repo/.git" ] || { echo "no cams-admin repo at $repo (set CAMS_ADMIN_REPO)" >&2; exit 2; }
git -C "$repo" fetch -q origin || true
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
dest=$here/contract/cams-v1
rm -rf "$dest"
mkdir -p "$here/contract"
git -C "$repo" archive "$sha" contract/cams-v1 | tar -x -C "$here"
git -C "$repo" show "$sha:server/crypto/jcs.ts" > "$dest/jcs.ts.txt"
printf '%s (contract/cams-v1, %s)\n' "$sha" "$branch" > "$dest/SOURCE"
echo "vendored contract/cams-v1 from cams-admin $sha"
