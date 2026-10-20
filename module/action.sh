#!/system/bin/sh
# KernelSU "Action" button: toggle the core and print the current state.
MODDIR=${0%/*}
KR_MODDIR=$MODDIR
export KR_MODDIR
. "$MODDIR/scripts/kernelray.sh"

if kr_running; then
  echo "- stopping"
  kr_stop
else
  echo "- starting"
  kr_start
fi

echo
kr_report
