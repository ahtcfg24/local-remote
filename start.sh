#!/usr/bin/env bash
# local_remote 一键本地启动脚本(系统 service)
#
# 默认行为(start):
#   1. 生成/更新当前项目的 macOS launchd user service
#   2. 启用用户登录后自启动
#   3. npm ci 安装依赖,构建 native Swift helper
#   4. 停止已有实例并检查端口占用
#   5. 通过 service 启动前台进程,并轮询 /health 确认就绪
#
# 子命令:
#   ./start.sh logs              查看实时日志
#   ./start.sh                   启动 service，健康实例保持运行
#   ./start.sh stop               停止当前 service 实例(自启配置保留)
#   ./start.sh status             查看 service 运行状态
#   ./start.sh restart [参数]     重启 service
#   ./start.sh doctor             检查运行环境与本地安装状态
#   ./start.sh uninstall          停止服务并移除 launchd 配置（保留 token 和日志）
#   ./start.sh run [启动参数...]  内部前台入口,供 service manager 调用

set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"

RUN_DIR=".run"
PID_FILE="$RUN_DIR/local-remote.pid"
LOG_FILE="$RUN_DIR/local-remote.log"
RUNNER_FILE="$RUN_DIR/local-remote-service-runner.sh"
SERVICE_ID="$(printf '%s' "$ROOT_DIR" | cksum | awk '{print $1}')"
SERVICE_LABEL="com.local-remote.$SERVICE_ID"
AGENT_APP=".build/Local Remote Agent.app"
AGENT_EXECUTABLE="$AGENT_APP/Contents/MacOS/local-remote-agent"

# 默认环境变量(可由 shell 环境覆盖)
# REMOTE_TOKEN 留空时由 server.js 自动生成随机 token 并持久化到 .run/token
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
FPS="${FPS:-15}"
QUALITY="${QUALITY:-0.6}"
MAX_WIDTH="${MAX_WIDTH:-1920}"
MAX_CLIENTS="${MAX_CLIENTS:-4}"
REMOTE_TOKEN="${REMOTE_TOKEN:-}"

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
    if [[ "$oldpid" =~ ^[0-9]+$ ]] && [ "$oldpid" -gt 1 ] && kill -0 "$oldpid" 2>/dev/null; then
      # PID 文件可能跨重启残留。只停止本项目的 Node，绝不杀掉复用 PID 的进程。
      local process_command process_cwd
      process_command="$(ps -p "$oldpid" -o command= 2>/dev/null || true)"
      process_cwd="$(lsof -a -p "$oldpid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
      if [[ "$process_command" != *node*server.js* ]] || [ "$process_cwd" != "$ROOT_DIR" ]; then
        echo "[start] 忽略过期 PID 文件（不属于本项目）"
        rm -f "$PID_FILE"
        return
      fi
      echo "[start] 停止已有进程 PID=$oldpid"
      kill "$oldpid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$oldpid" 2>/dev/null || break
        sleep 0.5
      done
      # 不对可能已被复用的 PID 再次发送 SIGKILL。
      if kill -0 "$oldpid" 2>/dev/null; then
        echo "[start] 旧进程尚未退出，请检查 PID=$oldpid" >&2
        return 1
      fi
    fi
    rm -f "$PID_FILE"
  fi
}

# --- 固定端口：冲突时明确失败，已有二维码与收藏地址不会悄悄失效 ---
check_port_available() {
  HOST="$HOST" PORT="$PORT" node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.on("error", (error) => {
      console.error(`[start] 无法监听 ${process.env.HOST}:${process.env.PORT} (${error.code})。请关闭占用程序或修改 .env 中的 PORT。`);
      process.exitCode = 1;
    });
    server.listen({ host: process.env.HOST, port: Number(process.env.PORT), exclusive: true }, () => server.close());
  '
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
  if [ -f node_modules/.package-lock.json ] \
    && [ ! package-lock.json -nt node_modules/.package-lock.json ] \
    && [ ! package.json -nt node_modules/.package-lock.json ]; then
    return
  fi

  echo "[start] 正在安装 npm 依赖 ..."
  npm ci --no-audit --no-fund
}

# --- 构建 native Swift helper ---
ensure_native_built() {
  if [ -x "$AGENT_EXECUTABLE" ] && [ -x .build/permission-guide ] \
    && [ ! native/agent.swift -nt "$AGENT_EXECUTABLE" ] \
    && [ ! native/agent-Info.plist -nt "$AGENT_EXECUTABLE" ] \
    && [ ! scripts/build-native.sh -nt "$AGENT_EXECUTABLE" ] \
    && [ ! native/permission_guide.swift -nt .build/permission-guide ]; then
    return
  fi

  echo "[start] 正在构建 native helper ..."
  npm run build:native
}

# --- 准备运行时环境 ---
prepare_runtime() {
  mkdir -p "$RUN_DIR"
  chmod 700 "$RUN_DIR"
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  ensure_node
  load_env
  normalize_config
  ensure_dependencies
  ensure_native_built
}

# 启动器与服务端共用数值归一化，探活地址与实际监听保持一致。
normalize_config() {
  local normalized
  normalized="$(HOST="$HOST" PORT="$PORT" FPS="$FPS" QUALITY="$QUALITY" MAX_WIDTH="$MAX_WIDTH" MAX_CLIENTS="$MAX_CLIENTS" node --input-type=module -e '
    import { loadConfig } from "./lib/config.js";
    const c = loadConfig();
    console.log([c.port, c.fps, c.quality, c.maxWidth, c.maxClients].join(" "));
  ')"
  read -r PORT FPS QUALITY MAX_WIDTH MAX_CLIENTS <<<"$normalized"
  HOST="${HOST:-0.0.0.0}"
}

# --- 识别当前系统可用的 service manager ---
detect_service_backend() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "[start] 错误: local_remote 的原生采集与控制组件目前仅支持 macOS 13+" >&2
    exit 1
  fi
  if ! command -v launchctl >/dev/null 2>&1; then
    echo "[start] 错误: 当前系统未找到 launchctl" >&2
    exit 1
  fi
  echo "launchd"
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

launchd_domain() {
  echo "gui/$(id -u)"
}

launchd_target() {
  echo "$(launchd_domain)/$SERVICE_LABEL"
}

launchd_plist_path() {
  echo "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
}

# --- 写入 macOS LaunchAgent 配置 ---
install_launchd_service() {
  local plist node_bin token_xml="" arguments_xml=""
  plist="$(launchd_plist_path)"
  node_bin="$(command -v node)"
  mkdir -p "$(dirname "$plist")"

  local argument
  for argument in "$@"; do
    arguments_xml="${arguments_xml}    <string>$(xml_escape "$argument")</string>
"
  done

  # token 为空时不写入 plist,由 server.js 自动生成
  if [ -n "$REMOTE_TOKEN" ]; then
    token_xml="    <key>REMOTE_TOKEN</key>
    <string>$(xml_escape "$REMOTE_TOKEN")</string>"
  fi

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
    <string>$(xml_escape "$ROOT_DIR/$AGENT_EXECUTABLE")</string>
    <string>--service</string>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "$ROOT_DIR/server.js")</string>
$arguments_xml
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
    <key>QUALITY</key>
    <string>$(xml_escape "$QUALITY")</string>
    <key>MAX_WIDTH</key>
    <string>$(xml_escape "$MAX_WIDTH")</string>
    <key>MAX_CLIENTS</key>
    <string>$(xml_escape "$MAX_CLIENTS")</string>
$token_xml
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$ROOT_DIR/$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ROOT_DIR/$LOG_FILE")</string>
</dict>
</plist>
EOF
  chmod 600 "$plist"
  plutil -lint "$plist" >/dev/null
}

# --- 根据系统类型安装或更新 service 文件 ---
install_service() {
  # 当前只支持 launchd；第一个参数保留 service backend 接口形状。
  shift
  install_launchd_service "$@"
}

# --- 停止当前 service 实例,但保留自启动配置 ---
stop_service_backend() {
  local target
  target="$(launchd_target)"
  launchctl bootout "$target" >/dev/null 2>&1 || true

  # bootout 是异步的；立即 bootstrap 偶尔会返回 I/O error (5)。
  for _ in $(seq 1 30); do
    if ! launchctl print "$target" >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  echo "[start] service 尚未停止，取消重启以避免重复实例" >&2
  return 1
}

# --- 启动并启用 service 自启动 ---
start_service_backend() {
  launchctl enable "$(launchd_target)"
  launchctl bootstrap "$(launchd_domain)" "$(launchd_plist_path)"
  launchctl kickstart "$(launchd_target)" >/dev/null 2>&1 || true
}

# --- 有效 token: 环境变量优先,否则读取 server.js 生成的持久化 token ---
effective_token() {
  if [ -n "$REMOTE_TOKEN" ]; then
    printf '%s' "$REMOTE_TOKEN"
  else
    tr -d '\n' < "$RUN_DIR/token" 2>/dev/null || true
  fi
}

# status/start 检查已安装配置，避免 shell 默认值或改动后的 .env 显示错误地址。
load_installed_environment() {
  local plist value key
  plist="$(launchd_plist_path)"
  [ -f "$plist" ] || return 1
  for key in HOST PORT FPS QUALITY MAX_WIDTH MAX_CLIENTS REMOTE_TOKEN; do
    value="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$plist" 2>/dev/null || true)"
    if [ -n "$value" ] || [ "$key" = REMOTE_TOKEN ]; then
      printf -v "$key" '%s' "$value"
    fi
  done
}

probe_service() {
  local token
  token="$(effective_token)"
  HOST="$HOST" PORT="$PORT" REMOTE_TOKEN="$token" node "$ROOT_DIR/scripts/service-health.mjs" "$@"
}

print_access_urls() {
  local token
  token="$(effective_token)"
  HOST="$HOST" PORT="$PORT" REMOTE_TOKEN="$token" node "$ROOT_DIR/scripts/access-urls.mjs"
}

# --- 等待 HTTP 健康检查就绪 ---
wait_for_health() {
  local ready=0
  for _ in $(seq 1 30); do
    if probe_service; then
      ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$ready" = "1" ]; then
    echo "[start] 服务与鉴权检查通过"
    print_access_urls
    probe_service --details || true
    echo "[start] 查看日志: tail -f $LOG_FILE   停止当前实例: ./start.sh stop"
    return
  fi

  echo "[start] 服务未通过健康与鉴权检查。运行 ./start.sh logs 查看原因。" >&2
  exit 1
}

# --- 兼容旧版 PID 文件状态展示 ---
legacy_status() {
  if [ -f "$PID_FILE" ]; then
    local oldpid
    oldpid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$oldpid" =~ ^[0-9]+$ ]] && [ "$oldpid" -gt 1 ] && kill -0 "$oldpid" 2>/dev/null; then
      local process_command process_cwd
      process_command="$(ps -p "$oldpid" -o command= 2>/dev/null || true)"
      process_cwd="$(lsof -a -p "$oldpid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
      if [[ "$process_command" == *node*server.js* ]] && [ "$process_cwd" = "$ROOT_DIR" ]; then
        echo "[start] 旧版后台进程运行中, PID=$oldpid"
        return 0
      fi
    fi
  fi
  return 1
}

# --- 默认入口: 安装/重启 service 并确认健康状态 ---
start_managed_service() {
  local backend
  backend="$(detect_service_backend)"

  # 默认启动是幂等操作；应用代码或配置更新时使用 restart。
  if [ "${RESTART_REQUESTED:-0}" = 0 ] && (
    load_installed_environment && launchctl print "$(launchd_target)" >/dev/null 2>&1 && probe_service
  ); then
    echo "[start] service 已在运行；更新代码或配置请使用 ./start.sh restart"
    (load_installed_environment && print_access_urls && probe_service --details)
    return
  fi

  prepare_runtime
  # 如果用户把 PORT 改成另一个已占用的端口，保留仍在运行的旧服务。
  # 当前服务自己的端口则必须等 stop 后再检查。
  local requested_port="$PORT"
  if ! (load_installed_environment && [ "$PORT" = "$requested_port" ] \
    && launchctl print "$(launchd_target)" >/dev/null 2>&1) && ! legacy_status >/dev/null; then
    check_port_available
  fi
  stop_service_backend "$backend"
  kill_existing
  check_port_available
  install_service "$backend" "$@"

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

  if launchctl print "$(launchd_target)" >/dev/null 2>&1; then
    if launchctl print "$(launchd_target)" 2>/dev/null | grep -q "state = running"; then
      echo "[start] service 运行中 ($SERVICE_LABEL)"
      load_installed_environment
      print_access_urls
      if probe_service --details; then
        echo "[start] HTTP 与鉴权正常"
        return 0
      fi
      echo "[start] 进程存在，但 HTTP 或鉴权检查未通过" >&2
      return 1
    fi
    echo "[start] service 已安装但当前未运行 ($SERVICE_LABEL)"
    return 1
  fi

  if legacy_status; then
    return 0
  fi

  echo "[start] 未运行"
  return 1
}

doctor() {
  local failed=0
  echo "[doctor] local_remote 环境检查"
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "[ok] macOS $(sw_vers -productVersion)"
  else
    echo "[fail] 当前系统不是 macOS" >&2
    failed=1
  fi
  for command_name in node npm swiftc launchctl curl; do
    if command -v "$command_name" >/dev/null 2>&1; then
      echo "[ok] $command_name: $(command -v "$command_name")"
    else
      echo "[fail] 缺少 $command_name" >&2
      failed=1
    fi
  done
  if command -v node >/dev/null 2>&1 && [ "$(node --version | sed 's/^v//' | cut -d. -f1)" -lt 20 ]; then
    echo "[fail] Node.js 版本低于 20: $(node --version)" >&2
    failed=1
  fi
  [ -x "$AGENT_EXECUTABLE" ] && echo "[ok] 原生 agent app 已构建" || echo "[info] 原生 agent app 尚未构建，首次启动会自动构建"
  [ -f "$RUN_DIR/token" ] && echo "[ok] 访问 token 已生成" || echo "[info] 访问 token 将在首次启动时生成"
  return "$failed"
}

uninstall_service() {
  detect_service_backend >/dev/null
  stop_service_backend launchd
  kill_existing
  rm -f "$(launchd_plist_path)" "$RUNNER_FILE" "$PID_FILE"
  echo "[start] 已卸载 launchd service；访问 token 与日志仍保留在 $RUN_DIR"
}

# --- service manager 调用的前台入口 ---
run_foreground() {
  prepare_runtime
  export HOST PORT FPS QUALITY MAX_WIDTH MAX_CLIENTS REMOTE_TOKEN
  echo "[start] 前台运行 local_remote ..."
  exec node server.js "$@"
}

main() {
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
  doctor)
    doctor
    ;;
  uninstall)
    uninstall_service
    ;;
  restart)
    shift
    RESTART_REQUESTED=1
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
  '')
    start_managed_service "$@"
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|logs|doctor|uninstall|run]" >&2
    return 2
    ;;
esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
