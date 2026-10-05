#!/usr/bin/env bash
# stop-stack.sh [--clean]: stops the stack start-*-stack.sh started (sim,
# real or two-proxy: they share the work dir and its pids file).
# See docs/livestack.md.
#
# Stops only the processes recorded in the work dir's pids file, newest first
# (cams, cam-proxy, cam-sim), with SIGTERM so cam-proxy stops its go2rtc and
# ffmpeg children and cam-sim its MediaMTX; SIGKILL after 20 s. A PID is
# signalled only while its command line still names this harness (its
# bind-local.cjs / sim-local.cjs, or the work dir), so a reused PID is never hit.
#
# Without --clean, keeps logs/, run/, run.env, the fixtures and the src-*
# worktrees for a look or the next run. With --clean, then deletes run/,
# run.env, logs/, fixtures/ and suites/ (a real-camera run's run/ holds camera
# footage: delete it, never upload it) and removes the src-* worktrees (the
# stacks' and run-all-suites.sh's) from their repos.
#
# Never touches anything it did not start: no pkill, no other ports, not the Pi.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

CLEAN=0
case "${1:-}" in
  --clean) CLEAN=1 ;;
  "") ;;
  *) die "usage: stop-stack.sh [--clean]" ;;
esac

ours() { # ours PID: alive and started by this harness
  local cmd
  cmd="$(ps -p "$1" -o command= 2>/dev/null)" || return 1
  case "$cmd" in *"$HERE"*|*"$WORK"*) return 0 ;; *) return 1 ;; esac
}

if [ -f "$PIDS" ]; then
  list=()
  while read -r pid name; do [ -n "${pid:-}" ] && list=("$pid:$name" "${list[@]}"); done < "$PIDS"
  for entry in "${list[@]}"; do
    pid="${entry%%:*}" name="${entry#*:}"
    if ours "$pid"; then
      kill -TERM "$pid" 2>/dev/null && note "SIGTERM $name ($pid)"
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      if kill -0 "$pid" 2>/dev/null && ours "$pid"; then kill -KILL "$pid" 2>/dev/null; note "SIGKILL $name ($pid)"; fi
    else
      note "$name ($pid) is not running"
    fi
  done
  rm -f "$PIDS"
  note "stopped. Leftover children, if any: pgrep -fl 'go2rtc|mediamtx' (they belong to this run only if their config is under $WORK or a camsim-rtsp-/go2rtc temp folder)"
else
  note "no pids file in $WORK; nothing to stop"
fi

if [ "$CLEAN" = 1 ]; then
  remove_worktrees
  rm -rf "$RUN" "$RUN_ENV" "$LOGS" "$FIXTURES" "$WORK/suites"
  note "deleted run/, run.env, logs/, fixtures/ and suites/ in $WORK"
  rmdir "$WORK" 2>/dev/null && note "removed $WORK" || true
fi
