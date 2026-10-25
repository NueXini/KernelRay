#!/system/bin/sh
# KernelSU "Action" button: toggle the core and print the current state.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

if kr_running; then
  echo "- stopping"
  kr_stop
  if command -v kr_tp_switch_on >/dev/null 2>&1 && kr_tp_switch_on; then
    echo "! takeover switch is on: the rules stay up (fail-closed), so the device has no"
    echo "  network until the core starts again, or run: kernelray.sh tproxy off"
  fi
else
  echo "- starting"
  kr_start
fi

echo
kr_report
