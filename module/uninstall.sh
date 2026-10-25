#!/system/bin/sh
# KernelSU runs this when the module is removed. Stop the core and remove the takeover
# rules — only the module's own KR_TP_* chains, table 19283 and rule preference 9500,
# never another module's. KernelSU then deletes the module dir, which is also where
# config, node store and logs live, so nothing is left behind.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

kr_stop
if command -v kr_tp_remove >/dev/null 2>&1; then
  kr_tp_remove
fi
