#!/usr/bin/env bash
# Start/stop the MCP daemon detached, so it survives between tool calls and can
# be restarted without a long-running foreground task.
#
#   imsmd.sh start [KEY=VALUE ...]   start, with optional env overrides
#   imsmd.sh stop                    stop
#   imsmd.sh restart [KEY=VALUE ...]
#   imsmd.sh status
set -uo pipefail

PORT=${IOS_SIMULATOR_MCP_HTTP_PORT:-8008}
PIDFILE=/tmp/imsm-daemon.pid
LOG=/tmp/imsm-daemon.log
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Kills the process in the pidfile and nothing else.
#
# This used to end with `pkill -f "$ROOT/build/index.js"`, to stop a leftover
# process from answering after a restart and making it look like the new build
# was live. That killed every server started from this checkout, on any port,
# including production ones belonging to someone else -- and it did so silently.
# The pidfile exists precisely so that cannot happen. If something else is
# holding the port, say so and let a human decide; never reach for a process we
# did not start.
stop() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$PIDFILE"

  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "WARNING: port $PORT is still in use by a process this script did not start:" >&2
    lsof -nP -iTCP:$PORT -sTCP:LISTEN >&2
    echo "Leaving it alone. Stop it yourself, or use a different port." >&2
  fi
  echo "stopped"
}

start() {
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: port $PORT already in use; run stop first" >&2
    exit 1
  fi
  : > "$LOG"
  env "$@" nohup node "$ROOT/build/index.js" -v >>"$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 40); do
    grep -q "listening on" "$LOG" 2>/dev/null && break
    sleep 0.25
  done
  echo "started pid $(cat "$PIDFILE")"
  [ $# -gt 0 ] && echo "env: $*"
  head -2 "$LOG"
}

case "${1:-status}" in
  start)   shift; start "$@" ;;
  stop)    stop ;;
  restart) shift; stop >/dev/null; start "$@" ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running pid $(cat "$PIDFILE")"
    else
      echo "not running"
    fi
    lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | tail -1
    ;;
  *) echo "usage: $0 {start|stop|restart|status} [KEY=VALUE ...]" >&2; exit 1 ;;
esac
