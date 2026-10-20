#!/system/bin/sh
# KernelSU runs this when the module is removed. Stop the core; KernelSU then deletes the
# module dir, which is also where config, node store and logs live, so nothing is left behind.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

kr_stop
