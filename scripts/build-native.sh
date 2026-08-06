#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
BUILD_DIR="$ROOT_DIR/.build"
AGENT_APP="$BUILD_DIR/Local Remote Agent.app"
AGENT_EXECUTABLE="$AGENT_APP/Contents/MacOS/local-remote-agent"
GUIDE_EXECUTABLE="$BUILD_DIR/permission-guide"

mkdir -p "$AGENT_APP/Contents/MacOS"
cp "$ROOT_DIR/native/agent-Info.plist" "$AGENT_APP/Contents/Info.plist"

swiftc "$ROOT_DIR/native/agent.swift" \
  -o "$AGENT_EXECUTABLE" \
  -framework AppKit \
  -framework ApplicationServices \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework VideoToolbox

# A bundle gives macOS one visible, draggable permission subject. Ad-hoc signing
# is sufficient for a local source build; users with a persistent signing
# identity can set LOCAL_REMOTE_CODESIGN_IDENTITY to preserve TCC grants across
# agent rebuilds.
SIGNING_IDENTITY="${LOCAL_REMOTE_CODESIGN_IDENTITY:--}"
codesign --force --sign "$SIGNING_IDENTITY" \
  --identifier com.local-remote.agent \
  "$AGENT_APP"
codesign --verify --strict "$AGENT_APP"

swiftc "$ROOT_DIR/native/permission_guide.swift" \
  -o "$GUIDE_EXECUTABLE" \
  -framework AppKit \
  -framework ApplicationServices

echo "Built $AGENT_APP"
echo "Built $GUIDE_EXECUTABLE"
