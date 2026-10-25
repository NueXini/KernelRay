#!/system/bin/sh
# Runs in late_start service mode. The core only ever starts from an applied node's
# config (ADR 0010). Whether the TPROXY rules go in before the core starts is the
# tproxy switch's call (ADR 0011): kr_start consults the switch, installs the rules
# and swaps in the takeover config first when it is on (fail-closed), and starts the
# core idle when it is off. With no applied node nothing starts and no rules go up.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

[ -f "$MODDIR/disable" ] && exit 0

kr_dirs
kr_start
