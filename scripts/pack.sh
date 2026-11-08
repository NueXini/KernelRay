#!/usr/bin/env bash
# Package module/ into a flashable module ZIP.
# Usage: scripts/pack.sh [outdir]   (default: build/)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
mod="$root/module"
out="${1:-$root/build}"

prop="$mod/module.prop"
id=$(sed -n 's/^id=//p' "$prop")
# The version is the pack date (ADR 0020): YY.MM.DD, and versionCode is the same date as
# YYMMDD (monotonic, so the installer still sees an upgrade). Stamped here, not by hand in
# module.prop, makes a forgotten bump impossible -- the date always matches the build. Both
# read UTC (date -u): the version is then a pure function of absolute time, so packing from
# different timezones yields the same number and versionCode can never go backwards.
version=$(date -u +%y.%m.%d)
code=$(date -u +%y%m%d)
sed -i "s/^version=.*/version=$version/" "$prop"
sed -i "s/^versionCode=.*/versionCode=$code/" "$prop"

[ -f "$mod/bin/xray" ] ||
  { echo "error: no core at module/bin/xray (see module/bin/README.md)" >&2; exit 1; }

# Both .dat files are loaded by `xray -test`, so a ZIP without them cannot run 大陆直连 at
# all. Refuse to build one rather than ship a mode that refuses to switch (docs/adr/0014).
[ -s "$mod/bin/geosite.dat" ] && [ -s "$mod/bin/geoip.dat" ] ||
  { echo "error: no geo data at module/bin (see module/bin/README.md)" >&2; exit 1; }

# ADR 0001 ships one arm64 core, and a phone cannot run anything else. An x86_64 binary here is
# an emulator test build: package it (the emulator loop needs it) but say so loudly.
_machine=$(od -An -t x1 -j 18 -N 2 "$mod/bin/xray" 2>/dev/null | tr -d ' \n')
case "$_machine" in
  b700 | 00b7) ;;
  *) echo "warning: module/bin/xray is not an arm64 ELF (e_machine=$_machine) --" >&2
     echo "warning: this ZIP is a test build and will not run on a phone (docs/adr/0001)" >&2 ;;
esac

mkdir -p "$out"
zip="$out/$id-$version.zip"
rm -f "$zip"

cd "$mod"
if command -v zip >/dev/null 2>&1; then
  # User data lives in the module dir at runtime; never ship it inside the zip.
  zip -qr "$zip" . -x 'bin/README.md' -x '*.DS_Store' \
    -x 'config.json' -x 'state.json' -x 'outbound.json' -x 'outbound.meta' \
    -x 'logs/*' -x 'runtime/*'
elif command -v 7z >/dev/null 2>&1; then
  7z a -tzip -bso0 -bsp0 "$zip" . -x'!bin/README.md' -x'!config.json' \
    -x'!state.json' -x'!outbound.json' -x'!outbound.meta' -x'!logs/*' -x'!runtime/*' >/dev/null
else
  echo "error: need zip or 7z on PATH" >&2
  exit 1
fi
cd - >/dev/null

echo "$zip"
