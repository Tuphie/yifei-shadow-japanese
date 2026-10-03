#!/usr/bin/env bash
# Package extension/ into dist/kage-v<version>.zip for a GitHub Release.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
rm -f "dist/kage-v${VERSION}.zip"
cp -r extension dist/kage
(cd dist && zip -qr "kage-v${VERSION}.zip" kage -x "*.DS_Store" && rm -rf kage)
echo "dist/kage-v${VERSION}.zip"
