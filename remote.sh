#!/usr/bin/env bash
# remote.sh — 兼容入口:除 guide 外全部转发到 start.sh,避免两套启动逻辑
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command="${1:-start}"

case "$command" in
  guide)
    # 打开 macOS 授权拖拽引导弹窗
    # 未改动时不要重新签名 App，否则打开引导本身可能使 TCC 授权失效。
    source "$APP_DIR/start.sh"
    ensure_node
    ensure_native_built
    echo "Opening permission guide..."
    "$APP_DIR/.build/permission-guide" \
      "$APP_DIR/.build/Local Remote Agent.app" \
      "$APP_DIR" >/dev/null 2>&1 &
    ;;
  start | stop | restart | status | logs | doctor | uninstall)
    exec "$APP_DIR/start.sh" "$@"
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|logs|doctor|uninstall|guide]"
    exit 2
    ;;
esac
