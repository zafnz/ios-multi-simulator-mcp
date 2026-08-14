#!/usr/bin/env bash
# Start/stop the MCP daemon detached, so it survives between tool calls and can
# be restarted without a long-running foreground task.
#
#   imsmd.sh start [KEY=VALUE ...]   start, with optional env overrides
#   imsmd.sh stop                    stop
#   imsmd.sh restart [KEY=VALUE ...]
#   imsmd.sh status
set -uo pipefail

PIDFILE=/tmp/imsm-daemon.pid
LOG=/tmp/imsm-daemon.log
ROOT=$(cd "$(dirname "$0")/.." && pwd)

stop() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
      sleep 0.25
    done
  fi
  # Anything else holding the port would make a restart look like it worked
  # while the old build kept answering.
  pkill -f "$ROOT/build/index.js" 2>/dev/null
  sleep 1
  rm -f "$PIDFILE"
  echo "stopped"
}

start() {
  if lsof -nP -iTCP:8008 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: port 8008 already in use; run stop first" >&2
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
    lsof -nP -iTCP:8008 -sTCP:LISTEN 2>/dev/null | tail -1
    ;;
  *) echo "usage: $0 {start|stop|restart|status} [KEY=VALUE ...]" >&2; exit 1 ;;
esac
