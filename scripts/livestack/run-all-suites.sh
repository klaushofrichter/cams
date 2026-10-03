#!/usr/bin/env bash
# run-all-suites.sh: the automated suites of cam-sim, cam-proxy and cams on
# their origin/main, one repo at a time: npm ci, unit tests (vitest), build,
# e2e (Playwright). See docs/livestack.md, part 1.
#
# One repo at a time because the e2e suites share ports (8090-8099,
# 8190-8598, 18480, 18600, 18601); the live stacks use 19xxx, so a stack may
# run meanwhile. Each repo gets a fresh detached worktree in
# $LIVESTACK_DIR/suites/src-<repo> (removed and re-added every run), with a
# symlink to the repo's tools/ (go2rtc, MediaMTX) when it has one. The
# repos' own checkouts are never touched. Logs: $LIVESTACK_DIR/suites/<repo>-{ci,unit,build,e2e}.log.
#
# Prerequisites: node + npm, git, ffmpeg, Google Chrome (cams e2e); Docker is
# not needed (cams' Silo spec, the released cam-proxy image, is skipped off
# Linux CI). Never touches the real camera or the Pi.
#
# Prints one summary line per suite, e.g. "cams unit: Tests  994 passed (994)".
set -uo pipefail
source "$(dirname "$0")/lib.sh"

OUT="$WORK/suites"
mkdir -p "$OUT"
strip() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }   # drop ANSI colours

for r in cam-sim cam-proxy cams; do
  SRC="$(repo_path "$r")" D="$OUT/src-$r"
  git -C "$SRC" worktree remove --force "$D" 2>/dev/null; rm -rf "$D"; git -C "$SRC" worktree prune
  if ! { git -C "$SRC" fetch -q origin main && git -C "$SRC" worktree add -q --detach "$D" origin/main; }; then
    echo "$r: worktree failed"; continue
  fi
  [ -e "$SRC/tools" ] && ln -s "$SRC/tools" "$D/tools"
  (
    cd "$D" || exit 1
    npm ci --silent > "$OUT/$r-ci.log" 2>&1 || { echo "$r: npm ci failed (see $OUT/$r-ci.log)"; exit 1; }
    echo "== $r $(git log --oneline -1)"
    npx vitest run > "$OUT/$r-unit.log" 2>&1
    echo "$r unit: $(strip "$OUT/$r-unit.log" | grep -E '^ +Tests ' | tail -1)"
    if npm run -s build > "$OUT/$r-build.log" 2>&1; then echo "$r build: ok"; else echo "$r build: FAILED"; fi
    npx playwright install chromium > /dev/null 2>&1
    npx playwright test > "$OUT/$r-e2e.log" 2>&1
    echo "$r e2e: $(strip "$OUT/$r-e2e.log" | grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' | tr '\n' ' ')"
  )
done
echo "DONE (logs and worktrees in $OUT; remove the worktrees with: git -C <repo> worktree remove --force $OUT/src-<repo>)"
