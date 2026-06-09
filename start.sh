#!/usr/bin/env bash
# local_remote 一键本地启动脚本(系统 service)
#
# 默认行为(start):
#   1. 生成/更新当前项目的 launchd 或 systemd user service
#   2. 启用 service 自启动(macOS 为用户登录后自启,Linux 会尝试启用 linger)
#   3. npm install 安装依赖,构建 native Swift helper
#   4. 停止已有实例并检查端口占用
#   5. 通过 service 启动前台进程,并轮询 /health 确认就绪
#
# 子命令:
#   ./start.sh logs              查看实时日志
#   ./start.sh [启动参数...]      启动/重启 service(默认),额外参数透传,如 -- --fps 10
#   ./start.sh stop               停止当前 service 实例(自启配置保留)
#   ./start.sh status             查看 service 运行状态
#   ./start.sh restart [参数]     重启 service
#   ./start.sh run [启动参数...]  内部前台入口,供 service manager 调用

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT_DIR"

RUN_DIR=".run"
PID_FILE="$RUN_DIR/local-remote.pid"
LOG_FILE="$RUN_DIR/local-remote.log"
RUNNER_FILE="$RUN_DIR/local-remote-service-runner.sh"
SERVICE_ID="$(printf '%s' "$ROOT_DIR" | cksum | awk '{print $1}')"
SERVICE_LABEL="com.local-remote.$SERVICE_ID"
SERVICE_UNIT="local-remote-$SERVICE_ID.service"
# 用于命令行匹配的进程特征(杀掉历史实例)
PROC_PATTERN="local-remote-control-demo"

# 默认环境变量(可由 shell 环境覆盖)
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
FPS="${FPS:-6}"
REMOTE_TOKEN="${REMOTE_TOKEN:-local-remote-demo}"

# --- 加载 .env ---
load_env() {
  if [ ! -f .env ]; then
    echo "[start] 未发现 .env,将仅使用当前 shell 环境变量"
    return
  fi
  echo "[start] 加载 .env 中的环境变量"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
}

# --- 杀掉已有实例 ---
kill_existing() {
  # 1) 优先按 PID 文件停止
  if [ -f "$PID_FILE" ]; then
    local oldpid
    oldpid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
      echo "[start] 停止已有进程 PID=$oldpid"
      kill "$oldpid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$oldpid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$oldpid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # 2) 兜底: 按命令行特征清理可能的残留实例
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$PROC_PATTERN" 2>/dev/null || true
  fi
}

# --- 选择可用端口 ---
# 输出两个以空格分隔的值: PORT CHANGED(1/0)
select_port() {
  local target_port="$1"
  local host="${2:-127.0.0.1}"

  if nc -z "$host" "$target_port" 2>/dev/null; then
    # 端口被占用,从高位向下扫描
    local search_start=10000
    if [ "$target_port" -ge 10000 ]; then
      search_start=$((target_port + 1))
    fi
    for candidate in $(seq "$search_start" 65535); do
      if ! nc -z "$host" "$candidate" 2>/dev/null; then
        echo "[start] 端口 $target_port 已被占用,已自动选择 $candidate"
        echo "$candidate 1"
        return
      fi
    done
    echo "[start] 错误: 未找到可用端口(已扫描到 65535)" >&2
    exit 1
  fi

  echo "$target_port 0"
}

# --- 确保 Node.js 可用 ---
ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[start] 错误: 未找到 node,需要 Node.js >= 20" >&2
    exit 1
  fi

  local node_version
  node_version="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$node_version" -lt 20 ]; then
    echo "[start] 错误: Node.js >= 20 需要,当前版本 $(node --version)" >&2
    exit 1
  fi
}

# --- 安装 npm 依赖 ---
ensure_dependencies() {
  if [ -d node_modules ] && [ -f node_modules/.package-lock.json ] 2>/dev/null; then
    return
  fi

  echo "[start] 正在安装 npm 依赖 ..."
  npm install --no-audit --no-fund
}

# --- 构建 native Swift helper ---
ensure_native_built() {
  if [ -x .build/control ] && [ -x .build/permission-guide ]; then
    return
  fi

  echo "[start] 正在构建 native helper ..."
  npm run build:native
}

# --- 准备运行时环境 ---
prepare_runtime() {
  mkdir -p "$RUN_DIR"
  ensure_node
  ensure_dependencies
  ensure_native_built
  load_env

  # 更新 env 变量(加载 .env 后可能已变化)
  HOST="${HOST:-0.0.0.0}"
  PORT="${PORT:-8787}"
  FPS="${FPS:-6}"
  REMOTE_TOKEN="${REMOTE_TOKEN:-local-remote-demo}"

  # 端口选择
  local port_selection changed selected_port
  port_selection="$(select_port "$PORT" "${HOST//0.0.0.0/127.0.0.1}")"
  read -r selected_port changed <<<"$port_selection"
  if [ "$changed" = "1" ]; then
    PORT="$selected_port"
  fi

  # 0.0.0.0 只用于监听;本机探活固定走 127.0.0.1
  PROBE_HOST="$HOST"
  if [ "$PROBE_HOST" = "0.0.0.0" ]; then
    PROBE_HOST="127.0.0.1"
  fi
}

# --- 识别当前系统可用的 service manager ---
detect_service_backend() {
  case "$(uname -s)" in
    Darwin)
      if ! command -v launchctl >/dev/null 2>&1; then
        echo "[start] 错误: 当前系统未找到 launchctl" >&2
        exit 1
      fi
      echo "launchd"
      ;;
    Linux)
      if ! command -v systemctl >/dev/null 2>&1; then
        echo "[start] 错误: 当前系统未找到 systemctl" >&2
        exit 1
      fi
      echo "systemd"
      ;;
    *)
      echo "[start] 错误: 当前系统暂不支持自动 service 启动" >&2
      exit 1
      ;;
  esac
}

# --- 为 launchd plist 转义 XML 文本 ---
xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

# --- 为 systemd unit 的带引号字段转义 ---
systemd_escape_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

launchd_domain() {
  echo "gui/$(id -u)"
}

launchd_target() {
  echo "$(launchd_domain)/$SERVICE_LABEL"
}

launchd_plist_path() {
  echo "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
}

systemd_unit_path() {
  echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT"
}

# --- 写入 service 调用的前台 runner ---
write_service_runner() {
  local node_bin
  node_bin="$(command -v node)"

  {
    echo "#!/usr/bin/env bash"
    echo "set -euo pipefail"
    printf 'cd %q\n' "$ROOT_DIR"
    # 导出环境变量供 node 进程使用
    printf 'export HOST=%q\n' "$HOST"
    printf 'export PORT=%q\n' "$PORT"
    printf 'export FPS=%q\n' "$FPS"
    printf 'export REMOTE_TOKEN=%q\n' "$REMOTE_TOKEN"
    printf 'exec %q server.js' "$node_bin"
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf ' >> %q 2>&1\n' "$ROOT_DIR/$LOG_FILE"
  } > "$RUNNER_FILE"
  chmod +x "$RUNNER_FILE"
}

# --- 写入 macOS LaunchAgent 配置 ---
install_launchd_service() {
  local plist node_bin
  plist="$(launchd_plist_path)"
  node_bin="$(command -v node)"
  mkdir -p "$(dirname "$plist")"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$SERVICE_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$ROOT_DIR/$RUNNER_FILE")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT_DIR")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>$(xml_escape "$HOST")</string>
    <key>PORT</key>
    <string>$(xml_escape "$PORT")</string>
    <key>FPS</key>
    <string>$(xml_escape "$FPS")</string>
    <key>REMOTE_TOKEN</key>
    <string>$(xml_escape "$REMOTE_TOKEN")</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$ROOT_DIR/$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ROOT_DIR/$LOG_FILE")</string>
</dict>
</plist>
EOF
}

# --- 写入 Linux systemd user service 配置 ---
install_systemd_service() {
  local unit
  unit="$(systemd_unit_path)"
  mkdir -p "$(dirname "$unit")"

  cat > "$unit" <<EOF
[Unit]
Description=local_remote control demo ($ROOT_DIR)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="$(systemd_escape_value "$ROOT_DIR")"
ExecStart=/bin/bash "$(systemd_escape_value "$ROOT_DIR/$RUNNER_FILE")"
Restart=always
RestartSec=3
Environment="HOST=$(systemd_escape_value "$HOST")"
Environment="PORT=$(systemd_escape_value "$PORT")"
Environment="FPS=$(systemd_escape_value "$FPS")"
Environment="REMOTE_TOKEN=$(systemd_escape_value "$REMOTE_TOKEN")"

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
}

# --- Linux 用户服务需要 linger 才能在无登录会话时随系统启动 ---
enable_systemd_linger() {
  if ! command -v loginctl >/dev/null 2>&1 || [ -z "${USER:-}" ]; then
    return
  fi

  if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q "Linger=no"; then
    if loginctl enable-linger "$USER" >/dev/null 2>&1; then
      echo "[start] 已为用户 $USER 启用 systemd linger"
    else
      echo "[start] 警告: 无法自动启用 systemd linger;重启后可能需要登录用户会话才会启动" >&2
    fi
  fi
}

# --- 根据系统类型安装或更新 service 文件 ---
install_service() {
  local backend="$1"
  case "$backend" in
    launchd)
      install_launchd_service
      ;;
    systemd)
      install_systemd_service
      ;;
  esac
}

# --- 停止当前 service 实例,但保留自启动配置 ---
stop_service_backend() {
  local backend="$1"
  case "$backend" in
    launchd)
      launchctl bootout "$(launchd_target)" >/dev/null 2>&1 || true
      ;;
    systemd)
      systemctl --user stop "$SERVICE_UNIT" >/dev/null 2>&1 || true
      ;;
  esac
}

# --- 启动并启用 service 自启动 ---
start_service_backend() {
  local backend="$1"
  case "$backend" in
    launchd)
      launchctl bootstrap "$(launchd_domain)" "$(launchd_plist_path)"
      launchctl enable "$(launchd_target)" >/dev/null 2>&1 || true
      launchctl kickstart -k "$(launchd_target)" >/dev/null 2>&1 || true
      ;;
    systemd)
      systemctl --user enable "$SERVICE_UNIT" >/dev/null
      enable_systemd_linger
      systemctl --user restart "$SERVICE_UNIT"
      ;;
  esac
}

# --- LAN 地址 ---
lan_addresses() {
  local result=()
  for addr in $(ifconfig | grep 'inet ' | awk '{print $2}' | grep -v '^127\.'); do
    result+=("$addr")
  done
  printf '%s\n' "${result[@]}"
}

# --- 等待 HTTP 健康检查就绪 ---
wait_for_health() {
  local ready=0
  for _ in $(seq 1 30); do
    if curl -s "http://$PROBE_HOST:$PORT/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$ready" = "1" ]; then
    echo "[start] 已就绪,监听 http://$PROBE_HOST:$PORT"
    echo "[start] 控制台: http://$PROBE_HOST:$PORT/?token=$REMOTE_TOKEN"
    echo "[start] LAN 地址:"
    local addr
    while IFS= read -r addr; do
      [ -n "$addr" ] && echo "  http://$addr:$PORT/?token=$REMOTE_TOKEN"
    done < <(lan_addresses)
    echo "[start] 查看日志: tail -f $LOG_FILE   停止当前实例: ./start.sh stop"
    return
  fi

  echo "[start] 启动失败或未就绪,最近日志:" >&2
  tail -n 30 "$LOG_FILE" >&2 || true
  exit 1
}

# --- 兼容旧版 PID 文件状态展示 ---
legacy_status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "[start] 旧版后台进程运行中, PID=$(cat "$PID_FILE")"
    return 0
  fi
  return 1
}

# --- 默认入口: 安装/重启 service 并确认健康状态 ---
start_managed_service() {
  local backend
  backend="$(detect_service_backend)"

  prepare_runtime
  write_service_runner "$@"
  install_service "$backend"
  stop_service_backend "$backend"
  kill_existing

  echo "[start] 通过 $backend service 启动 local_remote (日志: $LOG_FILE) ..."
  start_service_backend "$backend"
  wait_for_health
}

# --- stop 子命令 ---
stop_managed_service() {
  local backend
  backend="$(detect_service_backend)"
  stop_service_backend "$backend"
  kill_existing
  echo "[start] 已停止当前 service 实例;自启动配置保留"
}

# --- status 子命令 ---
status_managed_service() {
  local backend
  backend="$(detect_service_backend)"

  case "$backend" in
    launchd)
      if launchctl print "$(launchd_target)" >/dev/null 2>&1; then
        if launchctl print "$(launchd_target)" 2>/dev/null | grep -q "state = running"; then
          echo "[start] service 运行中 ($SERVICE_LABEL)"
          echo "[start] 控制台: http://127.0.0.1:$PORT/?token=$REMOTE_TOKEN"
          return 0
        fi
        echo "[start] service 已安装但当前未运行 ($SERVICE_LABEL)"
        return 1
      fi
      ;;
    systemd)
      if systemctl --user is-active --quiet "$SERVICE_UNIT"; then
        echo "[start] service 运行中 ($SERVICE_UNIT)"
        echo "[start] 控制台: http://127.0.0.1:$PORT/?token=$REMOTE_TOKEN"
        return 0
      fi
      if systemctl --user is-enabled --quiet "$SERVICE_UNIT" 2>/dev/null; then
        echo "[start] service 已启用但当前未运行 ($SERVICE_UNIT)"
        return 1
      fi
      ;;
  esac

  if legacy_status; then
    return 0
  fi

  echo "[start] 未运行"
  return 1
}

# --- service manager 调用的前台入口 ---
run_foreground() {
  prepare_runtime
  echo "[start] 前台运行 local_remote ..."
  exec node server.js "$@"
}

case "${1:-}" in
  stop)
    stop_managed_service
    ;;
  status)
    status_managed_service
    ;;
  logs)
    mkdir -p "$RUN_DIR"
    touch "$LOG_FILE"
    tail -n "${LINES:-80}" -f "$LOG_FILE"
    ;;
  restart)
    shift
    start_managed_service "$@"
    ;;
  run)
    shift
    run_foreground "$@"
    ;;
  start)
    shift
    start_managed_service "$@"
    ;;
  *)
    start_managed_service "$@"
    ;;
esac
