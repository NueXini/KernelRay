#!/system/bin/sh
# Runs in late_start service mode: start the core with the applied config (direct when no
# node has been applied). This version does not touch iptables/DNS/TUN, so nothing here
# may block or take over system traffic.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

[ -f "$MODDIR/disable" ] && exit 0

kr_start
