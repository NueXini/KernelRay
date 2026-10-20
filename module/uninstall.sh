#!/system/bin/sh
# KernelSU runs this when the module is removed. Stop the core, keep user data.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

kr_stop
rm -f "$KR_RUNDIR/arch" # leftover from the earlier per-arch layout
kr_log "module removed; data kept in $KR_DATA (delete it manually to wipe config and logs)"
