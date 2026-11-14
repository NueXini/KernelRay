#!/system/bin/sh
# KernelSU 在模块被移除时运行本脚本。停止核心并移除接管
# 规则——只有模块自己的 KR_TP_* 链、表 19283 和规则 pref 9500，
# 绝不碰其他模块的。KernelSU 随后删除模块目录，配置、节点库
# 与日志也住在那里，所以什么都不剩。
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

kr_stop
if command -v kr_tp_remove >/dev/null 2>&1; then
  kr_tp_remove
fi
