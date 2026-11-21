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

# 更新存活：KernelSU/Magisk 把更新装进暂存目录（$MODPATH），旧安装
# /data/adb/modules/KernelRay 在重启换入前原样不动。所有用户可见的
# 配置都住在 config/ 里，所以存活只需整树拷贝一次：cp -a 保留目录
# 权限（0700）与文件内容。全新安装（没有旧 config/）或在旧目录自身
# 上重装（两者同路径）时什么都不做。
# 拷贝后删掉开机作用域的临时文件：status.json/xray.pid/started/rules/
# nodeip 描述的是旧开机上的进程与内核现场，换了核心就不能再作数；
# watch.lock/subfetch.url 是陈旧的锁与含令牌的一次性文件。
# config.tested 必须删除：它记录的是旧核心测试过的字节，新核心必须
# 重新过一次 `xray -test`（kr_conf_install 会在下次启动重写它）。
# 节点库（nodes/、subscriptions/）与 WebUI 偏好（webui/）随树一并
# 存活；state.json 的愿望在下次启动时照常重新渲染。
if [ -d /data/adb/modules/KernelRay/config ] && \
  [ "/data/adb/modules/KernelRay" != "$MODPATH" ]; then
  cp -a /data/adb/modules/KernelRay/config/. "$MODPATH/config/"
  rm -f "$MODPATH/config/runtime/status.json" \
    "$MODPATH/config/runtime/xray.pid" \
    "$MODPATH/config/runtime/started" \
    "$MODPATH/config/runtime/rules" \
    "$MODPATH/config/runtime/nodeip" \
    "$MODPATH/config/runtime/watch.lock" \
    "$MODPATH/config/runtime/subfetch.url" \
    "$MODPATH/config/runtime/config.tested" 2>/dev/null
fi

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
