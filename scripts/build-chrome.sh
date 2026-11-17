#!/usr/bin/env bash
# Build the Chrome (Manifest V3) version from the shared Firefox sources.
#   extension/  shared code: content scripts, CSS, popup
#   chrome/     Chrome-only: manifest, service worker, block rules, PNG icons
# Output: dist/chrome/ (load it unpacked) and dist/ytm-audio-saver-chrome-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
out=dist/chrome
rm -rf "$out" && mkdir -p "$out"

cp extension/content-main.js extension/content-bridge.js extension/content.css "$out/"
cp -r extension/popup "$out/popup"
cp chrome/background.js chrome/rules.json "$out/"
cp -r chrome/icons "$out/icons"
python3 - "$version" <<'EOF'
import json, sys
m = json.load(open('chrome/manifest.json'))
m['version'] = sys.argv[1]
json.dump(m, open('dist/chrome/manifest.json', 'w'), indent=2)
EOF

(cd "$out" && rm -f "../ytm-audio-saver-chrome-$version.zip" && zip -qr "../ytm-audio-saver-chrome-$version.zip" .)
echo "Built dist/chrome (v$version) and dist/ytm-audio-saver-chrome-$version.zip"
