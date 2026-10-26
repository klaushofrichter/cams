#!/bin/sh
# svelte-check runs through npx: its typescript peer is ^5 || ^6 and the
# project's is 7. It runs from outside the project, so npx installs the
# project's exact svelte next to it: TypeScript merges the two svelte copies
# only when their versions match, and a newer svelte (5.57.3 on 2026-10-26)
# fails the Snippet types ("Two different types with this name exist").
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
V=$(node -p "require('$ROOT/node_modules/svelte/package.json').version")
cd "${TMPDIR:-/tmp}"
exec npx --yes -p svelte-check@4.7.6 -p "svelte@$V" svelte-check --workspace "$ROOT/web" --tsconfig "$ROOT/tsconfig.json" --threshold error "$@"
