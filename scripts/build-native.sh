#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
BUILD_DIR="$ROOT_DIR/.build"
mkdir -p "$BUILD_DIR"
STAGING_DIR="$(mktemp -d "$BUILD_DIR/.native-build.XXXXXX")"
cleanup() {
  if [ ! -d "$BUILD_DIR/Local Remote Agent.app" ] && [ -d "$STAGING_DIR/previous-agent.app" ]; then
    mv "$STAGING_DIR/previous-agent.app" "$BUILD_DIR/Local Remote Agent.app"
  fi
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT
AGENT_APP="$STAGING_DIR/Local Remote Agent.app"
AGENT_EXECUTABLE="$AGENT_APP/Contents/MacOS/local-remote-agent"
GUIDE_EXECUTABLE="$STAGING_DIR/permission-guide"

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

# Only replace the installed helpers after both compiles and signature checks
# succeed. A compiler/signing failure leaves the previously working App intact.
if [ -d "$BUILD_DIR/Local Remote Agent.app" ]; then
  mv "$BUILD_DIR/Local Remote Agent.app" "$STAGING_DIR/previous-agent.app"
fi
mv "$AGENT_APP" "$BUILD_DIR/Local Remote Agent.app"
mv "$GUIDE_EXECUTABLE" "$BUILD_DIR/permission-guide"

echo "Built $BUILD_DIR/Local Remote Agent.app"
echo "Built $BUILD_DIR/permission-guide"
