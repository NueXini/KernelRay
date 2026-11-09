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
# bin/ holds the core and the geo data it loads: the directory is traversable and the core is
# the only file in it that executes (docs/adr/0014).
set_perm_recursive "$MODPATH/bin" 0 0 0755 0644
set_perm "$MODPATH/bin/xray" 0 0 0755
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

if kr_geodata_ok 2>/dev/null; then
  ui_print "  geo data: present"
else
  ui_print "! bin/geosite.dat or bin/geoip.dat is missing: the 分流模式"
  ui_print "! 大陆直连 (Direct-CN) will refuse to switch until both files are back."
fi

kr_dirs
# The tproxy switch defaults to on (ADR 0011): the core's next start after a node is
# applied takes the device over. An update recreates it the same way.
command -v kr_tp_default_on >/dev/null 2>&1 && kr_tp_default_on
# The 分流模式 defaults to 大陆直连去广告 (ADR 0021), the same install-time pattern. With the geo
# data missing the default stays 全局, so the core can still start.
command -v kr_route_default >/dev/null 2>&1 && kr_route_default
# No applied node at install time, so this is a refusal by design (ADR 0010): keep its
# "apply a node first" message out of the installer output.
kr_ensure_config >/dev/null 2>&1
kr_status_write installed idle

ui_print "- Installed. Nothing starts on boot: open the WebUI and press Start (until a node"
ui_print "  is applied it stays stopped)."
ui_print "- Select a node in the WebUI (Nodes -> tap a row) to derive the core config;"
ui_print "  starting the core with a node applied also brings tproxy up."
ui_print "- TPROXY transparent proxy is ON by default: every core start (the WebUI's Start"
ui_print "  button) routes device traffic through the applied node. Turn it off in the"
ui_print "  WebUI Settings (tproxy透明代理) if you only want the local socks/http inbounds."
ui_print "- 分流模式 (Settings) defaults to 大陆直连去广告: mainland domains and addresses go"
ui_print "  direct, everything else through the node, and ad domains stop resolving. Switch to"
ui_print "  全局 if you want everything through the applied node."
ui_print "  大陆直连 sends mainland domains and addresses direct, with DNS split to match;"
ui_print "  switching it re-renders the config and restarts a running core."
ui_print "  大陆直连去广告 (Direct-CN-Adblock) adds ad blocking to 大陆直连; with the geo data"
ui_print "  missing it refuses to start instead of degrading to 全局."
ui_print "- Config: /data/adb/modules/$KR_ID/config.json (generated; do not hand-edit)"
ui_print "- Log:    /data/adb/modules/$KR_ID/logs/xray.log"
ui_print "! Everything lives in this module dir. A module update replaces it whole,"
ui_print "! so config.json, state.json, outbound.json, outbound.meta and logs are reset by"
ui_print "! upgrading. Re-import and apply the node after an update."
