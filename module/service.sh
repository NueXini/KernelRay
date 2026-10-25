#!/system/bin/sh
# Runs in late_start service mode. The core only ever starts from an applied node's
# config (ADR 0010): with no node applied, kr_start refuses and status.json records
# stopped/no-node. With the takeover switch on, the TPROXY rules go in before the core
# starts, so traffic drops instead of leaking while the core comes up (ADR 0004) --
# and with no applied node they go in anyway, fail-closed, until one is applied.
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
