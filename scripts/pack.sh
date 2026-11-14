#!/usr/bin/env bash
# 把 module/ 打包成可刷入的模块 ZIP。
# 用法：scripts/pack.sh [输出目录]   （默认：build/）
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
mod="$root/module"
out="${1:-$root/build}"

prop="$mod/module.prop"
id=$(sed -n 's/^id=//p' "$prop")
# 版本就是打包日期（ADR 0020）：YY.MM.DD，versionCode 是同一日期的
# YYMMDD（单调，安装器仍视为升级）。在这里写入而不是手改
# module.prop，让"忘改版本号"不可能发生——日期始终与构建一致。
# 两者读 UTC（date -u）：版本于是是绝对时间的纯函数，不同时区
# 打包得到相同数字，versionCode 也绝不可能倒退。
version=$(date -u +%y.%m.%d)
code=$(date -u +%y%m%d)
sed -i "s/^version=.*/version=$version/" "$prop"
sed -i "s/^versionCode=.*/versionCode=$code/" "$prop"

[ -f "$mod/bin/xray" ] ||
  { echo "error: no core at module/bin/xray (see module/bin/README.md)" >&2; exit 1; }

# 两个 .dat 文件都会被 `xray -test` 加载，没有它们的 ZIP 根本跑不了
# 大陆直连。宁可拒绝构建，也不发布一个拒绝切换的模式（docs/adr/0014）。
[ -s "$mod/bin/geosite.dat" ] && [ -s "$mod/bin/geoip.dat" ] ||
  { echo "error: no geo data at module/bin (see module/bin/README.md)" >&2; exit 1; }

# ADR 0001 只带一个 arm64 核心，手机也跑不了别的。这里的 x86_64
# 二进制是模拟器测试构建：照样打包（模拟器循环需要它），但大声说明。
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
  # 用户数据在运行时住在模块目录里；绝不打进 zip。
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
