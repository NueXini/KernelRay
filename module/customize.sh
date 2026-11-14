# shellcheck shell=ash
# 由 KernelSU/Magisk 安装器 source。这里不要调 `exit`。
# 可用变量：MODPATH、API、ARCH、IS64BIT、KSU、KSU_VER_CODE、...

SKIPUNZIP=0

if [ "$API" -lt 29 ]; then
  abort "! Android 10 (API 29) or newer is required (found API $API)"
fi

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

kr_core_works || abort "! bin/xray is missing or cannot run on this device: place the arm64 Xray core at module/bin/xray and reinstall"
kr_version_refresh
# geo 数据随模块内置，装完即缺说明 zip 损坏或被裁剪，早失败早重装。
kr_geodata_ok || abort "! bin/geosite.dat or bin/geoip.dat is missing: reinstall with an intact zip"

kr_dirs
# 分流模式 默认为 大陆直连去广告（ADR 0021），安装器的一次性默认：只有
# 安装器创建它，且只在偏好未设时。
command -v kr_route_default >/dev/null 2>&1 && kr_route_default
# 安装时没有已应用节点，拒绝渲染是设计使然（ADR 0010），吞掉。但
# 残留状态里已有应用节点而渲染或测试失败是真失败——报"安装成功"
# 是假成功，中止并给原因。
if kr_applied_id >/dev/null 2>&1 && ! kr_ensure_config; then
  abort "! could not render config.json from the applied node: apply the node again from the WebUI"
fi
kr_status_write installed idle

ui_print "- KernelRay installed."
