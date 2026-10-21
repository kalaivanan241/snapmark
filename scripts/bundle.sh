#!/usr/bin/env bash
# Build Snapmark.app (release) into dist/, ad-hoc signed.
#   scripts/bundle.sh            build dist/Snapmark.app
#   scripts/bundle.sh --install  …and copy it to ~/Applications, then launch it
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
APP=dist/Snapmark.app

cargo build --release
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/snapmark "$APP/Contents/MacOS/Snapmark"
cp icons/icon.icns "$APP/Contents/Resources/Snapmark.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Snapmark</string>
  <key>CFBundleDisplayName</key><string>Snapmark</string>
  <key>CFBundleIdentifier</key><string>dev.snapmark.Snapmark</string>
  <key>CFBundleExecutable</key><string>Snapmark</string>
  <key>CFBundleIconFile</key><string>Snapmark</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.3</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Snapmark captures your screen when you take a screenshot.</string>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Image</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.image</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP"
echo "Built $APP"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p ~/Applications
  pkill -x Snapmark 2>/dev/null || true
  rm -rf ~/Applications/Snapmark.app
  cp -R "$APP" ~/Applications/
  open ~/Applications/Snapmark.app
  echo "Installed ~/Applications/Snapmark.app"
fi
