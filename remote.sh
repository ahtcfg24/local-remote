#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$APP_DIR/.run"
LOG_FILE="${LOG_FILE:-$RUN_DIR/local-remote.log}"
PLIST_FILE="$RUN_DIR/ai.local-remote-control-demo.plist"
LABEL="${LABEL:-ai.local-remote-control-demo}"
DOMAIN="gui/$(id -u)"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
FPS="${FPS:-6}"
REMOTE_TOKEN="${REMOTE_TOKEN:-local-remote-demo}"

command="${1:-start}"

mkdir -p "$RUN_DIR"

local_ip() {
  ipconfig getifaddr en0 2>/dev/null \
    || ipconfig getifaddr en1 2>/dev/null \
    || echo "127.0.0.1"
}

job_pid() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = / { print $3; exit }'
}

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

print_urls() {
  local ip
  ip="$(local_ip)"
  echo "Local URL: http://127.0.0.1:${PORT}/?token=${REMOTE_TOKEN}"
  echo "LAN URL:   http://${ip}:${PORT}/?token=${REMOTE_TOKEN}"
}

write_plist() {
  local node_bin
  node_bin="$(command -v node)"
  if [[ -z "$node_bin" ]]; then
    echo "node not found. Install Node.js >=20 first."
    exit 1
  fi

  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>$HOST</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>FPS</key>
    <string>$FPS</string>
    <key>REMOTE_TOKEN</key>
    <string>$REMOTE_TOKEN</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF
}

start_server() {
  local pid
  pid="$(job_pid || true)"
  if [[ -n "$pid" ]]; then
    echo "Already running, pid: $pid"
    print_urls
    echo "Log: $LOG_FILE"
    return
  fi

  touch "$LOG_FILE"

  echo "Building native helper..."
  (cd "$APP_DIR" && npm run build:native)

  if is_loaded; then
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi

  write_plist

  echo "Starting LaunchAgent..."
  launchctl bootstrap "$DOMAIN" "$PLIST_FILE"
  launchctl kickstart -k "$DOMAIN/$LABEL"

  sleep 1
  pid="$(job_pid || true)"
  if [[ -z "$pid" ]]; then
    echo "Start failed. Last log lines:"
    tail -40 "$LOG_FILE" || true
    exit 1
  fi

  echo "Started, pid: $pid"
  print_urls
  echo "Log: $LOG_FILE"
}

stop_server() {
  local pid
  pid="$(job_pid || true)"
  if [[ -z "$pid" && ! is_loaded ]]; then
    echo "Not running."
    return
  fi

  if [[ -n "$pid" ]]; then
    echo "Stopping pid: $pid"
  else
    echo "Unloading LaunchAgent..."
  fi
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  echo "Stopped."
}

status_server() {
  local pid
  pid="$(job_pid || true)"
  if [[ -n "$pid" ]]; then
    echo "Running, pid: $pid"
    print_urls
    echo "Log: $LOG_FILE"
  else
    echo "Not running."
  fi
}

open_guide() {
  echo "Building native helper..."
  (cd "$APP_DIR" && npm run build:native)
  echo "Opening permission guide..."
  "$APP_DIR/.build/permission-guide" "$(command -v node)" "$APP_DIR/.build/control" "$APP_DIR" >/dev/null 2>&1 &
}

case "$command" in
  start)
    start_server
    ;;
  guide)
    open_guide
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    start_server
    ;;
  status)
    status_server
    ;;
  logs)
    touch "$LOG_FILE"
    tail -n "${LINES:-80}" -f "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|logs|guide]"
    exit 2
    ;;
esac
