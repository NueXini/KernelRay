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
    echo "! tproxy switch is on: the rules stay up (fail-closed), so the device has no"
    echo "  network until the core starts again -- starting the core brings tproxy back."
    echo "  For direct traffic, turn the switch off in the WebUI settings (or run:" 
    echo "  kernelray.sh tproxy off) and start the core."
  fi
else
  echo "- starting"
  if ! kr_start; then
    echo "! start refused or failed; with no node applied, tap a node in the WebUI node list first"
  fi
fi

echo
kr_report
