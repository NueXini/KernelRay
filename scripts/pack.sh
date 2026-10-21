#!/usr/bin/env bash
# Package module/ into a flashable module ZIP.
# Usage: scripts/pack.sh [outdir]   (default: build/)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
mod="$root/module"
out="${1:-$root/build}"

prop="$mod/module.prop"
id=$(sed -n 's/^id=//p' "$prop")
version=$(sed -n 's/^version=//p' "$prop")
code=$(sed -n 's/^versionCode=//p' "$prop")

[ -f "$mod/bin/xray" ] ||
  { echo "error: no core at module/bin/xray (see module/bin/README.md)" >&2; exit 1; }

mkdir -p "$out"
zip="$out/$id-$code-$version.zip"
rm -f "$zip"

cd "$mod"
if command -v zip >/dev/null 2>&1; then
  # User data lives in the module dir at runtime; never ship it inside the zip.
  zip -qr "$zip" . -x 'bin/README.md' -x '*.DS_Store' \
    -x 'config.json' -x 'state.json' -x 'outbound.json' -x 'outbound.meta' \
    -x 'logs/*' -x 'runtime/*'
elif command -v 7z >/dev/null 2>&1; then
  7z a -tzip -bso0 -bsp0 "$zip" . -x'!bin/README.md' -x'!config.json' -x'!state.json' \
    -x'!outbound.json' -x'!outbound.meta' -x'!logs/*' -x'!runtime/*' >/dev/null
else
  echo "error: need zip or 7z on PATH" >&2
  exit 1
fi
cd - >/dev/null

echo "$zip"
