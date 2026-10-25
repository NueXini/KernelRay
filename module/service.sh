#!/system/bin/sh
# Runs in late_start service mode: start the core with the applied config (direct when no
# node has been applied). With the takeover switch on, the TPROXY rules go in before the
# core starts, so traffic drops instead of leaking while the core comes up (ADR 0004).
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

[ -f "$MODDIR/disable" ] && exit 0

kr_dirs
if command -v kr_tp_boot >/dev/null 2>&1 && kr_tp_switch_on; then
  kr_tp_boot
fi
kr_start
