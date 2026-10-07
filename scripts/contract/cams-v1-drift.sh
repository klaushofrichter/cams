#!/usr/bin/env bash
# The cams-v1 contract drift check (migration P4): the vendored copy in
# contract/cams-v1 must equal cams-admin's contract/cams-v1 (SOURCE
# excluded), and jcs.ts.txt cams-admin's server/crypto/jcs.ts. SOURCE is
# "<commit> (contract/cams-v1, <branch>)": while the contract is still on a
# cams-admin branch, that branch's head is the reference (main once SOURCE
# says main). Vendoring a new contract = scripts/contract/vendor-cams-v1.sh.
set -euo pipefail
dir=contract/cams-v1
repo=${CAMS_ADMIN_REPO:-https://github.com/klaushofrichter/cams-admin.git}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --filter=blob:none --no-checkout "$repo" "$tmp/repo"
branch=$(sed -n 's/.*(contract\/cams-v1, \([A-Za-z0-9._\/-]*\)).*/\1/p' "$dir/SOURCE")
ref=origin/${branch:-main}
if ! git -C "$tmp/repo" rev-parse -q --verify "$ref" >/dev/null; then
  echo "::error::SOURCE names cams-admin branch ${branch}, which no longer exists: vendor from main"
  exit 1
fi
mkdir "$tmp/out"
git -C "$tmp/repo" archive "$ref" contract/cams-v1 | tar -x -C "$tmp/out"
git -C "$tmp/repo" show "$ref:server/crypto/jcs.ts" > "$tmp/out/contract/cams-v1/jcs.ts.txt"
if ! diff -r -x SOURCE "$tmp/out/contract/cams-v1" "$dir"; then
  echo "::error::contract/cams-v1 differs from cams-admin $ref: vendor the new contract (scripts/contract/vendor-cams-v1.sh)"
  exit 1
fi
echo "contract/cams-v1 matches cams-admin $ref"
