#!/usr/bin/env bash
# Builds OpenCut.app on a Mac.
#
#   bash macos/build.sh             → build/OpenCut.app
#   bash macos/build.sh --install   → also copies it to /Applications and opens it
#   bash macos/build.sh --dmg       → also makes build/OpenCut.dmg to share
#
# Needs Bun and the Xcode Command Line Tools (Homebrew installs them).
set -euo pipefail

cd "$(dirname "$0")/.."
INSTALL=false
DMG=false
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=true ;;
    --dmg) DMG=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

[[ "$(uname)" == "Darwin" ]] || { echo "The Mac app has to be built on a Mac." >&2; exit 1; }
command -v bun >/dev/null || { echo "Install Bun first: brew install oven-sh/bun/bun" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "Install the Xcode Command Line Tools first: xcode-select --install" >&2; exit 1; }

ARCH="$(uname -m)"                      # arm64 (Apple Silicon) or x86_64 (Intel)
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
BUILD="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
APP="build/OpenCut.app"

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Installing dependencies"
bun install --frozen-lockfile

echo "→ Building the engine (Studio, autopilot, MCP server, CLI)"
bun build --compile src/main.ts --outfile "$APP/Contents/MacOS/opencut-engine"

echo "→ Building the app"
swiftc -O -swift-version 5 -target "$ARCH-apple-macos13.0" \
  -o "$APP/Contents/MacOS/OpenCut" macos/OpenCut/*.swift

echo "→ Icon and Info.plist"
bun macos/make-icon.ts ../../brand/marks/icon.svg "$APP/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" macos/Info.plist > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "→ Signing (ad-hoc, for this Mac)"
codesign --force --sign - "$APP/Contents/MacOS/opencut-engine"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

if $DMG; then
  echo "→ Making the disk image"
  STAGE="build/dmg"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "OpenCut" -srcfolder "$STAGE" -ov -format UDZO "build/OpenCut.dmg" >/dev/null
  rm -rf "$STAGE"
  echo "   build/OpenCut.dmg"
fi

if $INSTALL; then
  echo "→ Installing to /Applications"
  osascript -e 'quit app "OpenCut"' 2>/dev/null || true
  rm -rf "/Applications/OpenCut.app"
  cp -R "$APP" /Applications/
  open "/Applications/OpenCut.app"
fi

echo "✓ Built $APP ($VERSION, $ARCH)"
