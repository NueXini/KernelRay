#!/system/bin/sh
# Runs in late_start service mode: start the core in idle mode.
# v0 does not touch iptables/DNS/TUN, so nothing here may block or take over traffic.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

[ -f "$MODDIR/disable" ] && exit 0

kr_start
