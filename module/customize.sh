# shellcheck shell=ash
# 由 KernelSU/Magisk 安装器 source。这里不要调 `exit`。
# 可用变量：MODPATH、API、ARCH、IS64BIT、KSU、KSU_VER_CODE、...

SKIPUNZIP=0

ui_print "- KernelRay (apply a node)"

if [ "$API" -lt 29 ]; then
  abort "! Android 10 (API 29) or newer is required (found API $API)"
fi
ui_print "  device: API $API, installer ARCH=$ARCH"

# ZIP 条目可能丢失可执行位（在 Windows 上构建），所以探测前先修权限。
set_perm_recursive "$MODPATH" 0 0 0755 0644
# bin/ 放核心与其加载的 geo 数据：目录可穿越，核心是其中唯一
# 可执行的文件（docs/adr/0014）。
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
# 分流模式 默认为 大陆直连去广告（ADR 0021），安装器的一次性默认：只有
# 安装器创建它，且只在偏好未设时。geo 数据缺失时默认保持 全局，
# 核心仍可启动。
command -v kr_route_default >/dev/null 2>&1 && kr_route_default
# 安装时没有已应用节点，所以这是设计使然的拒绝（ADR 0010）：
# 别把它的"先应用节点"消息打进安装器输出。
kr_ensure_config >/dev/null 2>&1
kr_status_write installed idle

ui_print "- Installed. Nothing starts on boot: open the WebUI and press Start (until a node"
ui_print "  is applied it stays stopped)."
ui_print "- Select a node in the WebUI (Nodes -> tap a row) to derive the core config;"
ui_print "  starting the core takes the device over. There is no switch: every start"
ui_print "  routes device traffic (TCP/UDP, IPv4/IPv6) through the applied node, and a start"
ui_print "  whose takeover cannot be enforced (another VPN, a rule failure, a config the core"
ui_print "  rejects) is refused instead of running a core that captures nothing."
ui_print "- 分流模式 on the Status page defaults to 大陆直连去广告: mainland domains and addresses go"
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
