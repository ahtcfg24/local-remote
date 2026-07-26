#!/usr/bin/env bash
# remote.sh — 兼容入口:除 guide 外全部转发到 start.sh,避免两套启动逻辑
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command="${1:-start}"

case "$command" in
  guide)
    # 打开 macOS 授权拖拽引导弹窗
    echo "Building native helper..."
    (cd "$APP_DIR" && npm run build:native)
    echo "Opening permission guide..."
    "$APP_DIR/.build/permission-guide" "$(command -v node)" "$APP_DIR/.build/agent" "$APP_DIR" >/dev/null 2>&1 &
    ;;
  start | stop | restart | status | logs)
    exec "$APP_DIR/start.sh" "$@"
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|logs|guide]"
    exit 2
    ;;
esac
