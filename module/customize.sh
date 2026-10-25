# shellcheck shell=ash
# Sourced by the KernelSU/Magisk installer. Do not call `exit` here.
# Available: MODPATH, API, ARCH, IS64BIT, KSU, KSU_VER_CODE, ...

SKIPUNZIP=0

ui_print "- KernelRay (apply a node)"

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
set_perm "$MODPATH/scripts/tproxy.sh" 0 0 0755

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
# The tproxy switch defaults to on (ADR 0011): the core's next start after a node is
# applied takes the device over. An update recreates it the same way.
command -v kr_tp_default_on >/dev/null 2>&1 && kr_tp_default_on
kr_ensure_config
kr_status_write installed idle

ui_print "- Installed. Core starts on boot; until a node is applied it stays stopped."
ui_print "- Select a node in the WebUI (Nodes -> tap a row) to derive the core config;"
ui_print "  starting the core with a node applied also brings tproxy up."
ui_print "- TPROXY transparent proxy is ON by default: every core start (boot or the Start"
ui_print "  button) routes device traffic through the applied node. Turn it off in the"
ui_print "  WebUI Settings (tproxy透明代理) if you only want the local socks/http inbounds."
ui_print "- Config: /data/adb/modules/$KR_ID/config.json (generated; do not hand-edit)"
ui_print "- Log:    /data/adb/modules/$KR_ID/logs/xray.log"
ui_print "! Everything lives in this module dir. A module update replaces it whole,"
ui_print "! so config.json, state.json, outbound.json, outbound.meta and logs are reset by"
ui_print "! upgrading. Re-import and apply the node after an update."
