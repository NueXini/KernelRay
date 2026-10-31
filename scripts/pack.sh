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

# Both .dat files are loaded by `xray -test`, so a ZIP without them cannot run 大陆直连 at
# all. Refuse to build one rather than ship a mode that refuses to switch (docs/adr/0014).
[ -s "$mod/geodata/geosite.dat" ] && [ -s "$mod/geodata/geoip.dat" ] ||
  { echo "error: no geo data at module/geodata (see module/geodata/README.md)" >&2; exit 1; }

# ADR 0001 ships one arm64 core, and a phone cannot run anything else. An x86_64 binary here is
# an emulator test build: package it (the emulator loop needs it) but say so loudly.
_machine=$(od -An -t x1 -j 18 -N 2 "$mod/bin/xray" 2>/dev/null | tr -d ' \n')
case "$_machine" in
  b700 | 00b7) ;;
  *) echo "warning: module/bin/xray is not an arm64 ELF (e_machine=$_machine) --" >&2
     echo "warning: this ZIP is a test build and will not run on a phone (docs/adr/0001)" >&2 ;;
esac

mkdir -p "$out"
zip="$out/$id-$code-$version.zip"
rm -f "$zip"

cd "$mod"
if command -v zip >/dev/null 2>&1; then
  # User data lives in the module dir at runtime; never ship it inside the zip.
  zip -qr "$zip" . -x 'bin/README.md' -x 'geodata/README.md' -x '*.DS_Store' \
    -x 'config.json' -x 'state.json' -x 'outbound.json' -x 'outbound.meta' \
    -x 'logs/*' -x 'runtime/*'
elif command -v 7z >/dev/null 2>&1; then
  7z a -tzip -bso0 -bsp0 "$zip" . -x'!bin/README.md' -x'!geodata/README.md' -x'!config.json' \
    -x'!state.json' -x'!outbound.json' -x'!outbound.meta' -x'!logs/*' -x'!runtime/*' >/dev/null
else
  echo "error: need zip or 7z on PATH" >&2
  exit 1
fi
cd - >/dev/null

echo "$zip"
