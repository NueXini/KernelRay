# shellcheck shell=ash
# Sourced by the KernelSU/Magisk installer. Do not call `exit` here.
# Available: MODPATH, API, ARCH, IS64BIT, KSU, KSU_VER_CODE, ...

SKIPUNZIP=0

ui_print "- KernelRay (idle run)"

if [ "$API" -lt 29 ]; then
  abort "! Android 10 (API 29) or newer is required (found API $API)"
fi
ui_print "  device: API $API, installer ARCH=$ARCH"

# Zip entries may lose the exec bit (built on Windows), so fix modes before probing.
set_perm_recursive "$MODPATH" 0 0 0755 0644
set_perm_recursive "$MODPATH/bin" 0 0 0755 0755
set_perm "$MODPATH/bin/xray" 0 0 0755
set_perm "$MODPATH/service.sh" 0 0 0755
set_perm "$MODPATH/action.sh" 0 0 0755
set_perm "$MODPATH/uninstall.sh" 0 0 0755
set_perm "$MODPATH/scripts/kernelray.sh" 0 0 0755

KR_MODDIR=$MODPATH
export KR_MODDIR
. "$MODPATH/scripts/kernelray.sh"

if ! kr_core_works; then
  ui_print "! bin/xray is missing or cannot run on this device"
  abort "! place the arm64 Xray core at module/bin/xray and reinstall"
fi
kr_version_refresh
ui_print "  core: $(kr_version_cached)"

kr_dirs
kr_ensure_config
kr_status_write installed idle

ui_print "- Installed. Core starts in idle mode on boot (socks 127.0.0.1:10808, http 127.0.0.1:10809)."
ui_print "- Config: $KR_CONF (left untouched on reinstall)"
ui_print "- Log:    $KR_LOG"
