# shellcheck shell=ash
# KernelRay 共享助手。由 customize.sh / uninstall.sh source。
#
# 布局契约：
#   一切都在模块目录 (/data/adb/modules/KernelRay) 里：机构、核心、
#   用户配置、节点库、日志和运行时状态。目录之外什么都不写，所以
#   卸载模块不留残余——而模块更新会整体替换
#   整个目录，config/state 随之重置（见 docs/adr/0002）。
#
# 安装时覆盖 KR_MODDIR：customize.sh 把它设为 $MODPATH。

KR_ID=KernelRay
KR_MODDIR=${KR_MODDIR:-/data/adb/modules/KernelRay}
KR_BINDIR=$KR_MODDIR/bin
KR_CONF=$KR_MODDIR/config.json
KR_LOGDIR=$KR_MODDIR/logs
KR_RUNDIR=$KR_MODDIR/runtime
KR_LOG=$KR_LOGDIR/xray.log
# 限制核心日志大小：启动在核心追加之前先轮转。只保留一代，
# 每次被替换；可覆盖，便于测试轮转一个小文件。
KR_LOG_MAX=${KR_LOG_MAX:-1048576}
KR_MLOG=$KR_LOGDIR/kernelray.log
KR_PIDFILE=$KR_RUNDIR/xray.pid
KR_STARTED=$KR_RUNDIR/started
KR_STATUS=$KR_RUNDIR/status.json
KR_VERFILE=$KR_RUNDIR/version
KR_TMPL=$KR_MODDIR/config.example.json
KR_STATE=$KR_MODDIR/state.json
KR_OUTBOUND=$KR_MODDIR/outbound.json
KR_OUTBOUND_META=$KR_MODDIR/outbound.meta
KR_APPLIED=$KR_RUNDIR/applied
KR_LOGLEVEL=$KR_RUNDIR/loglevel
# 最近一次通过 `xray -test` 的磁盘字节原样副本：启动据此跳过一次
# 会逐字重复的测试（docs/adr/0017）。
KR_CONF_TESTED=$KR_RUNDIR/config.tested

# 新 fork 的核心有这么长的时间开始监听，超时后启动仍算作"运行中"
# ——慢的核心不是失败的核心。过去每次启动都是死板的 `sleep 1`；
# 轮询在核心开始监听时立即返回（约 50-150 ms），崩溃也一步报告，
# 而不是等一秒。可覆盖，shell 测试不必睡觉。
KR_START_POLLS=${KR_START_POLLS:-30}
KR_START_STEP=${KR_START_STEP:-0.05}

# Geo 数据（docs/adr/0014）：geosite.dat 与 geoip.dat 随模块 ZIP 内置，与
# 核心同目录，核心就在那里找它们——XRAY_LOCATION_ASSET 未设时
# 它从自己可执行文件所在目录解析，不是 cwd（26.10.29 实测）。
# 所以布局携带路径、什么都不导出：数据与核心
# 一起走，否则谁都不可用。

# 接管支持（v0.7）。source 进来让每个入口——CLI、service、action、
# 卸载——看到同一套开关与规则助手。文件缺失（旧布局）
# 只禁用接管函数；模块其余部分照常工作。
# shellcheck disable=SC1090,SC1091
[ -f "$KR_MODDIR/scripts/tproxy.sh" ] && . "$KR_MODDIR/scripts/tproxy.sh"

kr_now() { date +%s; }

# 每条模块日志行携带的封闭标签集合。WebUI 的 `mlog append` 传入
# 同样的词，shell 与 UI 共享一份词汇；`kr_log` 拒绝集合之外的词，
# 让新的调用点没法自造拼法。
KR_LOG_TAGS="Node DNS Core Config TProxy Routing Module"

kr_log_tag_ok() { # <标签>：属于封闭集合时返回 0
  case " $KR_LOG_TAGS " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# 控制台行交给调用方（KernelSU 日志、CLI）；同一行也会写进
# 模块自己的日志——WebUI 日志页读的就是它。缺失的
# 日志目录（kr_dirs 之前）被静默容忍。一个时间戳供两份副本共用：
# 过去一条日志行 fork 两次 `date`，而一次启动要写好几行。
kr_log() { # <标签> <消息...>
  kr_log_tag_ok "$1" || {
    echo "kr_log: unknown tag '$1' ($KR_LOG_TAGS)" >&2
    return 2
  }
  _tag=$1
  shift
  _ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '%s [%s] %s\n' "$_ts" "$_tag" "$*"
  kr_log_write "$_ts" "$_tag" "$@"
}

# 不带控制台副本的模块日志：给从渲染内部写出的行用，它们的
# stdout 就是配置本身。
kr_log_file() { # <标签> <消息...>
  kr_log_tag_ok "$1" || {
    echo "kr_log_file: unknown tag '$1' ($KR_LOG_TAGS)" >&2
    return 2
  }
  kr_log_write "$(date '+%Y-%m-%d %H:%M:%S')" "$@"
}

kr_log_write() { # <时间戳> <标签> <消息...>
  _ts=$1
  _tag=$2
  shift 2
  # 日志行自己创建目录：第一行可能由一次渲染写出，此时还没有
  # 任何入口调过 kr_dirs。
  [ -d "$KR_LOGDIR" ] || mkdir -p "$KR_LOGDIR" 2>/dev/null
  # 先 2>/dev/null：缺失的日志目录（kr_dirs 之前）不许打印重定向错误。
  printf '%s [%s] %s\n' "$_ts" "$_tag" "$*" 2>/dev/null \
    >>"$KR_LOGDIR/kernelray.log"
}

# stdout 输出字节大小，文件缺失或不可读时为 0。`stat` 是 O(1)；`wc -c`
# 是没有 stat 的 busybox 上的回退。
kr_file_size() { # <文件>
  [ -f "$1" ] || { printf '0\n'; return 0; }
  _sz=$(stat -c %s "$1" 2>/dev/null) || _sz=""
  # 某些实现的 `wc -c` 会给单个计数补空白；数字校验前先去掉。
  case "$_sz" in '' | *[!0-9]*) _sz=$(wc -c <"$1" 2>/dev/null | tr -d '[:space:]') ;; esac
  case "$_sz" in '' | *[!0-9]*) _sz=0 ;; esac
  printf '%s\n' "$_sz"
}

# 限制核心日志大小：启动时，在核心（或其 -test）追加之前，把
# 超限的日志移开。只在没有受管核心运行时调用。
kr_log_rotate() { # <文件> [上限]
  _f=${1:-}
  _max=${2:-$KR_LOG_MAX}
  [ -n "$_f" ] && [ -f "$_f" ] || return 0
  _sz=$(kr_file_size "$_f")
  [ "$_sz" -gt "$_max" ] || return 0
  mv -f "$_f" "$_f.1" 2>/dev/null || : >"$_f" 2>/dev/null
  return 0
}

kr_dirs() {
  mkdir -p "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  # 模块目录本身保持安装时的权限；只收紧我们自己的子目录。
  chmod 700 "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  chmod 600 "$KR_CONF" "$KR_MODDIR/state.json" \
    "$KR_OUTBOUND" "$KR_OUTBOUND_META" "$KR_APPLIED" "$KR_LOGLEVEL" \
    "$KR_CONF_TESTED" 2>/dev/null
  [ -n "${KR_ROUTE:-}" ] && chmod 600 "$KR_ROUTE" 2>/dev/null
  [ -n "${KR_TP_RULES:-}" ] && chmod 600 "$KR_TP_RULES" 2>/dev/null
  return 0
}

# 核心有且只有一个：bin/xray。核心只有能在这里执行才算可用。
# $ARCH 与 `uname -m` 都不可信（模拟器报告外来的内核
# 架构），所以可用性靠运行二进制判定，绝不靠名字。
# 函数保留为唯一指名路径的地方（测试用它找 bin/）；
# 热点调用直接用 $KR_BINDIR/xray，省一次子 shell fork。
kr_core() { echo "$KR_BINDIR/xray"; }

# 探测要花一个进程（ARM 转译下 0.3-0.5 s），而一次调用最多问
# 同一个问题三遍（apply、随后的启动、版本缓存），所以答案
# 被记忆化，供进程余生使用。
#
# 这里不用 `head`/`timeout`：customize.sh 跑在安装器的 PATH 里，KernelSU 上那是
# 只有 busybox 目录——不在其中的外部命令会把"无法探测"变成
# "此设备无法运行核心"并中止安装。`read` 和 `printf` 是 shell
# 内建，`timeout` 只在存在时使用。显式 `return 0` 也重要：
# 这个 busybox 的 `printf` 在会话首次调用时返回 1，而返回码等于
# 最后一条命令的函数会把可用的核心报告成不可用。
kr_core_probe() { # stdout 输出版本行；二进制无法在此执行时返回 1
  if [ "${KR_CORE_PROBED:-0}" = 1 ]; then
    [ -n "$KR_CORE_VER" ] || return 1
    printf '%s\n' "$KR_CORE_VER"
    return 0
  fi
  KR_CORE_PROBED=1
  KR_CORE_VER=""
  _bin=$KR_BINDIR/xray
  [ -x "$_bin" ] || return 1
  if command -v timeout >/dev/null 2>&1; then
    _out=$(timeout 15 "$_bin" -version 2>/dev/null)
  else
    _out=$("$_bin" -version 2>/dev/null)
  fi
  [ -n "$_out" ] || return 1
  # 版本是第一行；二进制随后打印一行横幅。
  IFS= read -r KR_CORE_VER <<EOF
$_out
EOF
  [ -n "$KR_CORE_VER" ] || return 1
  printf '%s\n' "$KR_CORE_VER"
  return 0
}

kr_core_works() { kr_core_probe >/dev/null 2>&1; }

kr_core_version() { kr_core_probe; }

# 版本字符串被缓存：跑 `xray -version` 要花一个进程（ARM 转译下
# 还要几百 ms），对 2s 的 WebUI 轮询太贵。
kr_version_refresh() {
  _v=$(kr_core_probe) || return 0
  kr_dirs
  printf '%s\n' "$_v" >"$KR_VERFILE" 2>/dev/null
}

# 永不探测核心的缓存版本：唯一读者是安装打印（customize.sh），
# 版本只在模块重装时变化。
kr_version_read() { # 设置 KR_VERSION_VAL；缓存缺失或为空时返回 1
  KR_VERSION_VAL=""
  [ -s "$KR_VERFILE" ] || return 1
  IFS= read -r KR_VERSION_VAL <"$KR_VERFILE" || :
  [ -n "$KR_VERSION_VAL" ] || return 1
  return 0
}

kr_version_cached() {
  if kr_version_read; then
    printf '%s\n' "$KR_VERSION_VAL"
    return 0
  fi
  kr_version_refresh
  kr_version_read && printf '%s\n' "$KR_VERSION_VAL"
}

# 读一次 pidfile、不用子 shell：状态轮询要问它两次。
kr_pid_read() { # 设置 KR_PID_VAL；缺失或不是 pid 时返回 1
  KR_PID_VAL=""
  [ -s "$KR_PIDFILE" ] || return 1
  IFS= read -r KR_PID_VAL <"$KR_PIDFILE" || :
  case "$KR_PID_VAL" in '' | *[!0-9]*) KR_PID_VAL=""; return 1 ;; esac
  return 0
}

kr_pid() { kr_pid_read || return 1; printf '%s\n' "$KR_PID_VAL"; }

# 仅当记录的 pid 活着 *且* 是我们的核心时为真（防 pid 复用）。
kr_running() {
  kr_pid_read || return 1
  kill -0 "$KR_PID_VAL" 2>/dev/null || return 1
  case "$( { tr '\0' ' ' <"/proc/$KR_PID_VAL/cmdline"; } 2>/dev/null )" in
    *xray*) return 0 ;;
  esac
  return 1
}

# 当前用我们的配置运行核心的每个 pid，包括不受管的实例。
# 启动可能互相赛跑——WebUI、终端和 apply 自己的重启可能重叠——
# 核心起两次会把同一端口绑两次（Go 设置了
# SO_REUSEPORT）。
#
# 对 /proc 一次 grep 找出候选，而不是每个 pid 一次 `cat`：那要
# 每进程约 5 ms，几百进程的手机上就是好几秒。`xray` 是 argv[0]（可执行
# 路径），候选只有少数几个——我们自己的 grep 也在其中，下面
# 的完整匹配会拒绝它。只重读那几个，判定条件保持原样：
# xray ... run ... -c <我们的配置>。
kr_core_pids() {
  for _f in $(grep -al xray /proc/[0-9]*/cmdline 2>/dev/null); do
    # 组重定向让在 grep 与这次读取之间退出的候选闭嘴；
    # 命令上的普通 `2>/dev/null` 盖不住 shell 自己的打开错误。
    case "$( { tr '\0' ' ' <"$_f"; } 2>/dev/null )" in
      *xray*run*-c*"$KR_CONF"*) ;;
      *) continue ;;
    esac
    _p=${_f#/proc/}
    echo "${_p%/cmdline}"
  done
}

kr_kill_strays() { # <要保留的 pid，可为空>
  for _p in $(kr_core_pids); do
    [ -n "$1" ] && [ "$_p" = "$1" ] && continue
    kr_log Core "killing stray core pid $_p"
    kill "$_p" 2>/dev/null
  done
}

# socks 入站的端口，按 config.json 携带的（已应用事实），不是
# state.json 愿望的（意图）：一次从未生效的端口修改不许让启动
# 去等一个没人监听的端口。
kr_conf_socks_port() {
  [ -s "$KR_CONF" ] || return 1
  awk '
    /"tag"[[:space:]]*:[[:space:]]*"socks-in"/ { seen = 1 }
    seen && /"port"[[:space:]]*:[[:space:]]*[0-9]/ {
      sub(/.*"port"[[:space:]]*:[[:space:]]*/, ""); sub(/[^0-9].*/, ""); print; exit
    }
  ' "$KR_CONF" 2>/dev/null
}

# <端口> 在 127.0.0.1 上监听吗？/proc/net/tcp 用 st 0A、本地地址
# 0100007F 和十六进制端口列出这种 socket——一次 awk 读取，轮询除 awk 外无 fork。
# KR_NET_TCP 是其测试使用的接缝；生产值即默认值。
kr_port_listening() { # <端口>
  case "${1:-}" in '' | *[!0-9]*) return 1 ;; esac
  awk -v port="$1" '
    BEGIN { want = "0100007F:" sprintf("%04X", port) }
    $4 == "0A" && $2 == want { found = 1; exit }
    END { exit !found }
  ' "${KR_NET_TCP:-/proc/net/tcp}" 2>/dev/null
}

# 等待新 fork 的核心开始服务。退出的核心立即报告
#（死板的 sleep 总要先睡满一秒才发现崩溃），开始监听的核心立即返回，
# 截止时限还活着的算已启动——慢的核心不是失败的核心
#（ARM 转译、冷的页缓存）。
kr_core_wait_ready() { # <pid>
  _p=${1:-}
  [ -n "$_p" ] || return 1
  _port=$(kr_conf_socks_port) || _port=""
  _i=0
  while [ "$_i" -lt "$KR_START_POLLS" ]; do
    kill -0 "$_p" 2>/dev/null || return 1
    [ -n "$_port" ] && kr_port_listening "$_port" && return 0
    sleep "$KR_START_STEP"
    _i=$((_i + 1))
  done
  kill -0 "$_p" 2>/dev/null
}

# 串行化并发启动。mkdir 是原子的；超过约 10s 的锁是陈旧的。
kr_lock() {
  _i=0
  while ! mkdir "$KR_RUNDIR/start.lock" 2>/dev/null; do
    _i=$((_i + 1))
    if [ "$_i" -eq 50 ]; then
      kr_log Core "start lock stuck, clearing it"
      rm -rf "$KR_RUNDIR/start.lock"
    fi
    [ "$_i" -ge 60 ] && return 1
    sleep 0.2
  done
  trap 'rmdir "$KR_RUNDIR/start.lock" 2>/dev/null' EXIT
  return 0
}

kr_cleanup_legacy() {
  # 早期布局的遗留物；没有任何东西再读它们。runtime/tproxy 曾是
  # tproxy 开关，runtime/config.form 记录磁盘字节渲染的是两种配置形态中的
  # 哪一种——两者都被 启动即接管 废除（docs/adr/0011）。旧版留下的文件
  # 绝不许影响任何东西，所以是删除而不是忽略。
  rm -f "$KR_RUNDIR/arch" "$KR_RUNDIR/watch.lock" "$KR_RUNDIR/tproxy" \
    "$KR_RUNDIR/config.form" "$KR_RUNDIR/config.form.prev" 2>/dev/null
}

# 已应用节点 id：当前配置由哪个节点构建而来。什么都没应用时为空，
# 此时什么都不许启动（ADR 0010）。只接受十六进制/字母数字 id
#（外加 _ 和 -），值可安全拼接进路径、状态 JSON 和 UI。
kr_applied_read() { # 设置 KR_APPLIED_VAL；缺失或非法时返回 1
  KR_APPLIED_VAL=""
  [ -s "$KR_APPLIED" ] || return 1
  IFS= read -r KR_APPLIED_VAL <"$KR_APPLIED" || :
  case "$KR_APPLIED_VAL" in '' | *[!0-9A-Za-z_-]*) KR_APPLIED_VAL=""; return 1 ;; esac
  return 0
}

kr_applied_id() { kr_applied_read || return 1; printf '%s\n' "$KR_APPLIED_VAL"; }

kr_meta_get() { # <键：id|host>
  [ -f "$KR_OUTBOUND_META" ] || return 1
  # 一个进程代替 `sed | head`；键是固定前缀，用不上正则。
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' \
    "$KR_OUTBOUND_META" 2>/dev/null
}

# 渲染出站的 id，供节点页的"有没有变化"检查。shell 读循环：
# 文件只有两行，而它跑在 2s 轮询上。
kr_meta_read() { # 设置 KR_META_ID；文件或 id 行缺失时返回 1
  KR_META_ID=""
  [ -s "$KR_OUTBOUND_META" ] || return 1
  # `|| [ -n "$_mk" ]`：手写的文件可能末行不带换行。
  while IFS= read -r _mk || [ -n "$_mk" ]; do
    case "$_mk" in id=*) KR_META_ID=${_mk#id=}; return 0 ;; esac
  done <"$KR_OUTBOUND_META"
  return 1
}

# 从 state.json 的 settings 里取两个入站端口，一趟完成。UI 序列化
# state.json 时让 settings 对象里每个键独占一行；这里只读它拥有的
# 两个扁平整数键（ADR 0009）并逐字段回退，所以缺失、手改美化
# 或半残的 state.json 永远无法把入站踢下默认端口。
# 设置 KR_SOCKS_PORT / KR_HTTP_PORT。
kr_settings_ports() {
  KR_SOCKS_PORT=10808
  KR_HTTP_PORT=10809
  KR_STATE_REVISION=0
  [ -s "$KR_STATE" ] || return 0
  _ports=$(awk -v s=10808 -v h=10809 '
    /"settings"[[:space:]]*:/ { in_settings = 1 }
    /^[[:space:]]*}/ { in_settings = 0 }
    in_settings && !seen_s && /"socksPort"[[:space:]]*:[[:space:]]*[0-9]/ {
      match($0, /"socksPort"[[:space:]]*:[[:space:]]*[0-9]+/)
      v = substr($0, RSTART, RLENGTH); sub(/^[^0-9]*/, "", v); s = v + 0; seen_s = 1
    }
    in_settings && !seen_h && /"httpPort"[[:space:]]*:[[:space:]]*[0-9]/ {
      match($0, /"httpPort"[[:space:]]*:[[:space:]]*[0-9]+/)
      v = substr($0, RSTART, RLENGTH); sub(/^[^0-9]*/, "", v); h = v + 0; seen_h = 1
    }
    # 顶层 revision：UI 每次写入都递增，节点页靠它跳过未变化的
    # 整个 state.json 读取。
    !seen_r && /^[[:space:]]*"revision"[[:space:]]*:/ {
      match($0, /"revision"[[:space:]]*:[[:space:]]*[0-9]+/)
      v = substr($0, RSTART, RLENGTH); sub(/^[^0-9]*/, "", v); r = v + 0; seen_r = 1
    }
    END { print s, h, r + 0 }
  ' "$KR_STATE" 2>/dev/null)
  # 不用 `set --`：那会冲掉调用方的位置参数，而像 kr_render_config 这样的
  # 调用方在本函数返回后仍拥有自己的 $1/$2。
  _ps=""
  _ph=""
  _rev=""
  IFS=' ' read -r _ps _ph _rev <<EOF
$_ports
EOF
  case "${_ps:-}" in '' | 0 | *[!0-9]*) ;; *) [ "$_ps" -ge 1 ] && [ "$_ps" -le 65535 ] && KR_SOCKS_PORT=$_ps ;; esac
  case "${_ph:-}" in '' | 0 | *[!0-9]*) ;; *) [ "$_ph" -ge 1 ] && [ "$_ph" -le 65535 ] && KR_HTTP_PORT=$_ph ;; esac
  case "${_rev:-}" in '' | *[!0-9]*) ;; *) KR_STATE_REVISION=$_rev ;; esac
  return 0
}

# 单个入站端口，旧接口：只需要一个字段的调用方仍得到相同的
# 逐字段回退。解析与 kr_settings_ports 共享。
kr_setting_port() { # <键> <默认值>
  kr_settings_ports
  case "$1" in
    socksPort) printf '%s\n' "$KR_SOCKS_PORT" ;;
    httpPort) printf '%s\n' "$KR_HTTP_PORT" ;;
    *) printf '%s\n' "$2" ;;
  esac
}

# 日志等级（docs/adr/0015）：shell 的偏好，如同分流模式。文件不存在即
# 默认 警告，所以模块更新（替换 runtime/）
# 会重置它，未知值回退到 警告，而不是把坏级别烘进核心会拒绝的
# 配置里。
KR_LOGLEVEL_DEFAULT=warning

kr_loglevel_read() { # 设置 KR_LOGLEVEL_VAL，默认 警告
  KR_LOGLEVEL_VAL=""
  [ -s "$KR_LOGLEVEL" ] && { IFS= read -r KR_LOGLEVEL_VAL <"$KR_LOGLEVEL" || :; }
  case "$KR_LOGLEVEL_VAL" in
    none | error | warning | info | debug) ;;
    *) KR_LOGLEVEL_VAL=$KR_LOGLEVEL_DEFAULT ;;
  esac
  return 0
}

kr_loglevel_get() { kr_loglevel_read; printf '%s\n' "$KR_LOGLEVEL_VAL"; }

# config.json 实际携带的级别；配置或字段缺失时返回 1。
# 启动漂移检查与状态 kv 靠它区分"已保存"和"已在运行"。
kr_loglevel_config_read() { # 设置 KR_LOGLEVEL_CONFIG；缺失时返回 1
  KR_LOGLEVEL_CONFIG=""
  [ -s "$KR_CONF" ] || return 1
  KR_LOGLEVEL_CONFIG=$(awk -F'"' '/^[[:space:]]*"loglevel"/ { print $4; exit }' "$KR_CONF" 2>/dev/null)
  [ -n "$KR_LOGLEVEL_CONFIG" ] || return 1
  return 0
}

kr_loglevel_config() { kr_loglevel_config_read || return 1; printf '%s\n' "$KR_LOGLEVEL_CONFIG"; }

# loglevel <level>：只持久化偏好。运行中的核心与 config.json 原样
# 不动；下次核心启动重渲染配置以对齐（docs/adr/0015）。写默认值
# 即移除文件，让"文件不存在"始终是 警告 的唯一表示。
kr_loglevel_set() { # <none|error|warning|info|debug>
  case "$1" in
    none | error | warning | info | debug) ;;
    *)
      echo "usage: kernelray.sh loglevel {none|error|warning|info|debug|status}" >&2
      return 2
      ;;
  esac
  kr_dirs
  _old=$(kr_loglevel_get)
  if [ "$1" = "$KR_LOGLEVEL_DEFAULT" ]; then
    rm -f "$KR_LOGLEVEL"
  else
    printf '%s\n' "$1" >"$KR_LOGLEVEL" 2>/dev/null || {
      echo "could not write $KR_LOGLEVEL" >&2
      return 1
    }
    chmod 600 "$KR_LOGLEVEL" 2>/dev/null
  fi
  if [ "$_old" = "$1" ]; then
    kr_log Core "log level: $_old (unchanged)"
  else
    kr_log Core "log level: $_old -> $1 (takes effect at the next core start)"
  fi
  return 0
}

kr_loglevel_status() {
  _lv=$(kr_loglevel_get)
  _lvc=$(kr_loglevel_config) || _lvc="-"
  echo "level=$_lv"
  echo "active=$_lvc"
  if kr_running && [ "$_lvc" != "$_lv" ]; then
    echo "pending=1"
  else
    echo "pending=0"
  fi
  return 0
}

# 哪次开机写的文件。`/proc/sys/kernel/random/boot_id` 是内核每次开机
# 铸造的随机 id，比较它不需要时钟——不像 `started` 对 /proc/uptime
# 的比较，NTP 同步墙钟之前那是错的。内核不暴露它时为空；
# 阅读方随即回退为按现状信任文件。
kr_boot_id() {
  _b=""
  # 这里不用 [ -s ]：procfs 文件报告的 stat 大小为 0，所以即使有值 -s 也是假。
  # 组重定向让没有该文件的内核闭嘴。
  { IFS= read -r _b < /proc/sys/kernel/random/boot_id; } 2>/dev/null || :
  printf '%s\n' "$_b"
}

kr_status_write() { # <状态> <阶段>
  _s=""
  [ -s "$KR_STARTED" ] && { IFS= read -r _s <"$KR_STARTED" || :; }
  case "$_s" in '' | *[!0-9]*) _s=0 ;; esac
  _n=""
  kr_applied_read && _n=$KR_APPLIED_VAL
  _rt=global
  command -v kr_route_mode >/dev/null 2>&1 && _rt=$(kr_route_mode)
  kr_dirs
  printf '{"state":"%s","phase":"%s","started":%s,"revision":0,"node":"%s","route":"%s","boot":"%s"}\n' \
    "$1" "$2" "$_s" "$_n" "$_rt" "$(kr_boot_id)" >"$KR_STATUS" 2>/dev/null
}

# 用一条出站渲染模板。出站经环境变量传入，不拼进 awk 程序或
# shell 字符串：JSON 含反斜杠、引号和 `$`，awk -v 的值或双引号
# shell 展开都会重新解释它们。占位符是带引号的字符串，模板对
# 工具仍是合法 JSON，但只有模块渲染之后整个字符串替换完才留下
# 可运行的配置。
kr_render_config() { # <出站文件> [分流模式覆盖]
  _ob=${1:-}
  if [ ! -f "$KR_TMPL" ]; then
    kr_log Config "missing config template $KR_TMPL"
    return 1
  fi
  # 对模板一趟代替四次 `grep -q` fork。位序就是消息一直以来的顺序：
  # 出站、两个端口、日志级别。
  _tmpl_ph=$(awk '
    /__KERNELRAY_OUTBOUND__/ { o = 1 }
    /__KERNELRAY_SOCKS_PORT__/ { s = 1 }
    /__KERNELRAY_HTTP_PORT__/ { h = 1 }
    /__KERNELRAY_LOGLEVEL__/ { l = 1 }
    END { printf "%d%d%d%d", o, s, h, l }
  ' "$KR_TMPL" 2>/dev/null)
  case "$_tmpl_ph" in
    1111) ;;
    0*) kr_log Config "config template $KR_TMPL has no outbound placeholder"; return 1 ;;
    ?0*) kr_log Config "config template $KR_TMPL has no inbound port placeholders"; return 1 ;;
    ???0) kr_log Config "config template $KR_TMPL has no loglevel placeholder"; return 1 ;;
    *) kr_log Config "config template $KR_TMPL has no placeholders"; return 1 ;;
  esac
  # 没有出站就没有配置：核心只运行从已应用节点派生的配置
  #（ADR 0010）。没有 freedom 回退可退。
  if [ -z "$_ob" ] || [ ! -s "$_ob" ]; then
    kr_log Node "no node outbound to render; apply a node first"
    return 1
  fi
  _line=$(cat "$_ob") || return 1
  _route=${2:-}

  # 只有唯一形态（docs/adr/0011）：每次启动都接管，所以每次渲染都带
  # tproxy 入站、DNS 模块、路由块和旁路 mark。没有第二种形态可选
  # ——这也是这里没有任何东西向活规则提问的原因。
  if ! kr_tp_render_blocks "$_route"; then
    kr_log TProxy "could not build the takeover blocks"
    return 1
  fi
  _tp_in=$KR_TP_INBOUND
  _dns_out=$KR_DNS_OUTBOUND
  _dns=$KR_DNS_BLOCK
  _routing=$KR_ROUTING
  _mark=$KR_BYPASS
  if [ "${KR_ROUTE_DEGRADED:-0}" = 1 ]; then
    # 偏好要求 cn 而 geo 数据没了：安全方向是全部走节点，
    # 绝不是死核心。只记文件——本函数的 stdout 是配置。
    kr_log_file Routing "geo data missing under $KR_BINDIR; rendered the global routing form"
  fi
  # 出站与接管块经环境变量传入，不拼进 awk 程序或 shell 字符串：
  # JSON 含反斜杠、引号和 `` $ ``，awk -v 的值或双引号 shell 展开
  # 都会重新解释它们。
  # 接管占位符行把前置逗号留在模板里，这样替换（块拼入）与移除
  #（整行丢弃）两种结果都是合法 JSON；模板本身能被解析，因为
  # 每个占位符都是带引号的字符串。
  # 节点出站丢了旁路 mark 的接管配置会让 OUTPUT 规则把核心自身
  # 的连接捕获回核心：路由环回。没有占位符的出站（过期的渲染器）
  # 被拒绝，不入库。
  kr_settings_ports
  kr_loglevel_read
  KR_OUT_LINE=$_line KR_TP_MARK=$_mark \
    KR_SOCKS_PORT=$KR_SOCKS_PORT \
    KR_HTTP_PORT=$KR_HTTP_PORT \
    KR_LOGLEVEL_VAL=$KR_LOGLEVEL_VAL \
    KR_TP_INBOUND_BLOCK=$_tp_in KR_DNS_OUTBOUND_BLOCK=$_dns_out \
    KR_DNS_BLOCK=$_dns KR_ROUTING_BLOCK=$_routing awk '
    BEGIN {
      out = ENVIRON["KR_OUT_LINE"]
      gsub(/"__KERNELRAY_MARK__"/, ENVIRON["KR_TP_MARK"], out)
      # 容忍空白：outbound.json 通常是紧凑的，但美化过的文件也是
      # 合法输入，不得被当作"无 mark"拒绝。q 是引号字符，模式
      # 因此不需要自己的反斜杠。
      q = sprintf("%c", 34)
      if (match(out, q "mark" q "[ \t]*:[ \t]*" ENVIRON["KR_TP_MARK"] "([^0-9]|$)") == 0) {
        print "kernelray: the node outbound carries no bypass mark; refusing a takeover config" > "/dev/stderr"
        exit 3
      }
    }
    {
      line = $0
      ph = "\"__KERNELRAY_OUTBOUND__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) out substr(line, p + length(ph))
      ph = "\"__KERNELRAY_SOCKS_PORT__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) ENVIRON["KR_SOCKS_PORT"] substr(line, p + length(ph))
      ph = "\"__KERNELRAY_HTTP_PORT__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) ENVIRON["KR_HTTP_PORT"] substr(line, p + length(ph))
      ph = "\"__KERNELRAY_LOGLEVEL__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) "\"" ENVIRON["KR_LOGLEVEL_VAL"] "\"" substr(line, p + length(ph))
      # 路由块总是编写：每种形态都接管，连 全局 都有 dns/端口-53
      # 规则（docs/adr/0011、docs/adr/0014）。
      ph = "\"__KERNELRAY_ROUTING__\""
      p = index(line, ph)
      if (p > 0) {
        print substr(line, 1, p - 1) ENVIRON["KR_ROUTING_BLOCK"] substr(line, p + length(ph))
        next
      }
      ph = "\"__KERNELRAY_TPROXY_INBOUND__\""
      p = index(line, ph)
      if (p > 0) { print "," ENVIRON["KR_TP_INBOUND_BLOCK"]; next }
      ph = "\"__KERNELRAY_DNS_OUTBOUND__\""
      p = index(line, ph)
      if (p > 0) { print "," ENVIRON["KR_DNS_OUTBOUND_BLOCK"]; next }
      ph = "\"__KERNELRAY_DNS__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) ENVIRON["KR_DNS_BLOCK"] substr(line, p + length(ph))
      print line
    }
  ' "$KR_TMPL"
}

# config.tested 记录通过 `xray -test` 的磁盘字节原样副本。渲染是意图
# 的纯函数、测试是渲染字节的纯函数，所以与已测配置逐字节相同的
# 配置无需再测——这正是把一次切换从三次测试降到一次的机制
#（docs/adr/0017）。
kr_conf_install() {
  cp -f "$KR_CONF" "$KR_CONF_TESTED" 2>/dev/null || rm -f "$KR_CONF_TESTED"
}

# 磁盘上的配置是已应用节点唯一的描述（切换失败后 outbound.json
# 描述的是用户尝试的节点，而回滚恢复了本节点的配置——ADR 0007
# 让旧节点一直运行到用户重试）。什么都渲染不出来，所以字节
# 原样接受——走同一个测试闸门，它只在字节未知时才咬人。
kr_conf_accept_ondisk() {
  if [ ! -s "$KR_CONF" ]; then
    kr_log Config "no config on disk to fall back to"
    echo "no config for the applied node; re-tap the node in the WebUI" >&2
    return 1
  fi
  if cmp -s "$KR_CONF" "$KR_CONF_TESTED"; then return 0; fi
  if ! "$KR_BINDIR/xray" run -test -c "$KR_CONF" >>"$KR_LOG" 2>&1; then
    kr_log Config "xray -test rejected the config on disk"
    echo "config test failed (see $KR_LOG)" >&2
    return 2
  fi
  kr_conf_install
  return 0
}

kr_applied_write() { # <node id>
  printf '%s\n' "$1" >"$KR_APPLIED" 2>/dev/null || return 1
  chmod 600 "$KR_APPLIED" 2>/dev/null
  return 0
}

# `-test` 拒绝时的消息。渲染的是 大陆直连去广告 时，广告部分引用
# geosite:category-ads-all，实践中让测试失败的唯一原因就是 geo 数据
# 没了——而该模式永不降级，所以改为拒绝启动（docs/adr/0021）。
# 消息于是只有一句，与 WebUI 提示和 toast 同文；其余拒绝保留
# 通用消息。标志来自渲染，所以只有渲染路径带着它走到这里。
kr_config_test_failed() { # <磁盘上|生成的>
  if [ "${KR_ROUTE_BLOCK_ADS:-0}" = 1 ] && ! kr_geodata_ok; then
    kr_log Routing "geo data missing; cnadblock cannot start"
    echo "geo data missing" >&2
    return 0
  fi
  kr_log Config "xray -test rejected the $1 config"
  echo "config test failed (see $KR_LOG)" >&2
  return 0
}

# 这次启动将运行的配置：从 <applied-id> 渲染并已知通过 `xray -test`。
# 把 KR_CANDIDATE 设为已测候选的路径，或 config.json 已恰好持有
# 这些字节时设为 ""——调用方于是无可测试、无可写入、无可重启。
# 测试通过前什么都不碰，所以坏节点永远不会停掉运行中的核心
#（ADR 0007）。
#
# 返回 0 且 KR_CANDIDATE 已设置；1 表示拒绝（消息在 stderr，什么都没碰）；2
# 表示候选未通过 `xray -test`（什么都没碰）。
kr_config_candidate() { # <applied-id> [分流模式覆盖]
  KR_CANDIDATE=""
  _id=${1:-}
  _route=${2:-}
  kr_dirs
  if [ -z "$_id" ]; then
    kr_log Config "no applied node; nothing to render"
    echo "no applied node; apply a node first" >&2
    return 1
  fi
  if [ ! -s "$KR_OUTBOUND" ]; then
    kr_log Config "applied id $_id has no rendered outbound"
    echo "no rendered outbound (apply from the WebUI first)" >&2
    return 1
  fi
  _meta=$(kr_meta_get id) || _meta=""
  if [ "$_meta" != "$_id" ]; then
    kr_log Config "applied id $_id: outbound.meta belongs to '$_meta'"
    echo "outbound.json does not belong to node $_id" >&2
    return 1
  fi
  if ! kr_core_works; then
    kr_log Core "core missing or not executable"
    echo "core missing or not executable" >&2
    return 1
  fi
  # 保留 .json 后缀：xray -test 按文件名判格式。
  _cand=$KR_RUNDIR/config.new.json
  if ! kr_render_config "$KR_OUTBOUND" "$_route" >"$_cand"; then
    rm -f "$_cand"
    echo "could not render config" >&2
    return 1
  fi
  chmod 600 "$_cand" 2>/dev/null
  # 大陆直连去广告 永不降级，而磁盘配置可能已经是数据丢失之前
  # 测过的 cnadblock 形态：tested 标记会让启动放行，核心自己死去，
  # 而没有这个模式欠用户的那句失败说明。上面的渲染设置了标志，
  # 所以这恰好只对带广告部分的渲染运行（docs/adr/0021）。
  if [ "${KR_ROUTE_BLOCK_ADS:-0}" = 1 ] && ! kr_geodata_ok; then
    rm -f "$_cand"
    kr_config_test_failed generated
    return 2
  fi
  if cmp -s "$_cand" "$KR_CONF"; then
    # 字节相同：无可写入、无可重启。只有测试结果可能未知——本标记
    # 存在之前写的配置，或手改过的——就地修复，不碰 config.json。
    if cmp -s "$_cand" "$KR_CONF_TESTED"; then
      rm -f "$_cand"
      return 0
    fi
    if ! "$KR_BINDIR/xray" run -test -c "$_cand" >>"$KR_LOG" 2>&1; then
      rm -f "$_cand"
      kr_config_test_failed "on disk"
      return 2
    fi
    kr_conf_install
    rm -f "$_cand"
    return 0
  fi
  if ! "$KR_BINDIR/xray" run -test -c "$_cand" >>"$KR_LOG" 2>&1; then
    rm -f "$_cand"
    kr_config_test_failed generated
    return 2
  fi
  KR_CANDIDATE=$_cand
  return 0
}

# 让 config.json 成为这次启动将运行的配置。幂等：磁盘字节已是
# 已测字节时，不渲染、不测试、不写入、不重启。这是模块把意图
#（已应用节点、偏好）变成配置的唯一地点。
kr_ensure_config() {
  _n=$(kr_applied_id) || _n=""
  _meta=$(kr_meta_get id) || _meta=""
  if [ -n "$_n" ] && [ -n "$_meta" ] && [ -s "$KR_OUTBOUND" ] && [ "$_meta" != "$_n" ]; then
    # 切换失败：outbound.json 已经描述用户尝试的节点，本节点的配置
    # 无法重新推导——磁盘上那份就是它（ADR 0007）。三个非空条件
    # 区分的是切换失败而非无出站：没有渲染出站时磁盘配置不可能
    # 描述任何东西，落到 kr_config_candidate 则改为拒绝启动（ADR 0010）。
    kr_log Node "ensure: applied id $_n, outbound.meta belongs to '$_meta'; keeping the config on disk"
    kr_conf_accept_ondisk
    return $?
  fi
  kr_config_candidate "$_n" || return $?
  [ -n "$KR_CANDIDATE" ] || return 0
  kr_swap_config "$KR_CANDIDATE" "" || return 1
  return 0
}

# 把已测候选安装进 config.json：备份当前配置、停运行中的核心、
# 换入候选、记录已应用 id 与 tested 标记。这里不启动任何东西
# ——那是 kr_swap_start 的活——所以需要先恢复自己意图（比如分流
# 模式）的调用方可以在中间插手。
# 传入要记录的已应用 id（apply 路径），或传 "" 让 runtime/applied
# 原样不动（ports 与 routing 路径重渲染同一节点）。核心曾在运行时设
# KR_SWAP_WAS=1，KR_SWAP_TP_WAS 记录接管规则是否已在位——回滚用它
# 只移除本次换入拉起的规则（docs/adr/0011）。每次失败都以带消息
# 返回 1；只要能恢复，核心就继续运行旧配置。
kr_swap_install() { # <候选> <已应用 id|"">
  _cand=$1
  _newid=$2
  KR_SWAP_WAS=0
  kr_running && KR_SWAP_WAS=1
  KR_SWAP_TP_WAS=0
  command -v kr_tp_rules_present >/dev/null 2>&1 && kr_tp_rules_present && KR_SWAP_TP_WAS=1
  _old=$(kr_applied_id) || _old=""
  KR_SWAP_OLD=$_old
  _prev=$KR_RUNDIR/config.json.prev
  if [ -f "$KR_CONF" ]; then
    if ! cp -f "$KR_CONF" "$_prev" 2>/dev/null; then
      rm -f "$_prev" "$_cand"
      kr_log Config "could not back up the current config"
      echo "could not back up the current config" >&2
      return 1
    fi
  else
    rm -f "$_prev"
  fi
  if [ "$KR_SWAP_WAS" = 1 ]; then
    kr_stop
  else
    # 不受管的核心可能还握着旧配置（一次失败停止的残留）。
    # 停掉它，而不是让它继续运行、状态却显示已停止。
    kr_kill_strays ""
  fi

  if ! mv -f "$_cand" "$KR_CONF"; then
    rm -f "$_cand"
    [ "$KR_SWAP_WAS" = 1 ] && kr_start
    kr_log Config "could not replace config"
    echo "could not replace config" >&2
    return 1
  fi
  chmod 600 "$KR_CONF" 2>/dev/null
  kr_conf_install
  if [ -n "$_newid" ]; then
    kr_applied_write "$_newid"
  fi
  return 0
}

# 用 kr_swap_install 刚安装的配置启动核心。起不来时返回 1；
# 由调用方决定恢复什么（kr_swap_rollback 是常规答案）。
kr_swap_start() {
  if [ "${KR_SWAP_WAS:-0}" = 1 ]; then
    kr_start
    return $?
  fi
  kr_status_write stopped idle
  return 0
}

# 撤销 kr_swap_install：恢复上一个配置与已应用 id，然后再次启动。
# 调用方必须在这 *之前* 恢复自己的意图，因为启动会从它重新推导
# 配置（docs/adr/0017）：模式已回滚的分流切换重渲染旧模式，出站
# 已指向另一节点的 apply 保留恢复的字节（kr_conf_accept_ondisk）。
#
# 重启没能回来的回滚意味着设备没有核心，而没有核心的设备不许
# 保留捕获（docs/adr/0011）：本次换入拉起的规则被移除，设备回到
# 直连而不是黑暗。换入之前已在位的规则原样不动——它们属于
# 之前运行的核心，那才是要回到的状态。
kr_swap_rollback() {
  _prev=$KR_RUNDIR/config.json.prev
  kr_log Config "new config did not start; restoring previous config"
  if [ -f "$_prev" ]; then
    mv -f "$_prev" "$KR_CONF"
    chmod 600 "$KR_CONF" 2>/dev/null
    kr_conf_install
    if [ -n "${KR_SWAP_OLD:-}" ]; then
      kr_applied_write "$KR_SWAP_OLD"
    else
      rm -f "$KR_APPLIED"
    fi
    if kr_start; then
      echo "new config failed to start; previous config restored" >&2
    else
      kr_swap_tp_rollback
      echo "new config failed to start; previous config restored but the core did not start" >&2
    fi
  else
    # 无可恢复：没有配置则已应用 id 作废，核心保持停止，
    # 而不是运行任何不是从已应用节点派生的东西。
    rm -f "$KR_CONF" "$KR_APPLIED" "$KR_CONF_TESTED"
    kr_swap_tp_rollback
    kr_status_write stopped no-node
    echo "new config failed to start; no previous config, the core stays stopped" >&2
  fi
  rm -f "$_prev"
  return 0
}

# 拆掉失败换入拉起的那一次捕获，且仅此一次。
kr_swap_tp_rollback() {
  [ "${KR_SWAP_TP_WAS:-0}" = 1 ] && return 0
  command -v kr_tp_rules_present >/dev/null 2>&1 || return 0
  kr_tp_rules_present || return 0
  kr_log TProxy "the swap brought the rules up and no core is running; removing them"
  kr_tp_remove
  return 0
}

# 给没有自己意图要恢复的调用方的完整手势：安装、启动，
# 启动失败则回滚。
kr_swap_config() { # <候选> <已应用 id|"">
  kr_swap_install "$1" "$2" || return 1
  if kr_swap_start; then
    rm -f "$KR_RUNDIR/config.json.prev"
    return 0
  fi
  kr_swap_rollback
  return 1
}

# apply <id>：UI 已渲染好 outbound.json + outbound.meta。验证它们属于
# 此 id，渲染这次切换将运行的配置，让核心校验，然后换入。候选在
# 碰运行中的核心之前测试；测试失败绝不停它、也绝不替换
# config.json（ADR 0007）。节点已渲染成磁盘字节时，不测试、
# 不写入、不重启。
kr_apply() { # <node id>
  _id=${1:-}
  case "$_id" in
    '')
      echo "usage: kernelray.sh apply <node-id>" >&2
      return 2
      ;;
    *[!0-9A-Za-z_-]*)
      echo "invalid node id: $_id" >&2
      return 2
      ;;
  esac
  kr_dirs
  # 在停止或捕获任何东西之前钉死节点地址：解析需要能用的网络，
  # 渲染需要解析的答案（docs/adr/0008）。已记忆化，随后的启动
  # 不再解析。
  command -v kr_tp_pin_node >/dev/null 2>&1 && kr_tp_pin_node

  kr_config_candidate "$_id" || return 1
  if [ -z "$KR_CANDIDATE" ]; then
    # config.json 已经是该节点的配置：不测试、不重启、无流量空档。
    # 只有已应用指针可能不同步（切换失败把它留在后面）。
    kr_applied_write "$_id" || return 1
    kr_log Node "applied node $_id (config unchanged)"
    return 0
  fi
  kr_swap_config "$KR_CANDIDATE" "$_id" || return 1
  kr_log Node "applied node $_id"
  return 0
}

# ports：用 state.json settings 里的入站端口重渲染 config.json。UI
# 先写 state.json（意图），然后调用本函数；候选的测试与换入与节点
# 应用完全相同，已应用节点按原样渲染——端口改的是本地入站，
# 从不改出站。保存已渲染的端口什么都不做。
kr_apply_ports() {
  kr_dirs
  _n=$(kr_applied_id) || {
    kr_log Node "ports: no applied node"
    echo "no applied node; apply a node first" >&2
    return 1
  }
  kr_config_candidate "$_n" || return 1
  if [ -z "$KR_CANDIDATE" ]; then
    kr_log Node "ports: the config already carries the saved ports"
    return 0
  fi
  kr_swap_config "$KR_CANDIDATE" "" || return 1
  kr_log Node "ports applied: $(kr_setting_port socksPort 10808) socks / $(kr_setting_port httpPort 10809) http"
  return 0
}

# unapply：忘掉已应用节点——apply 的逆操作。从它派生的一切都走：
# 接管规则（它们捕获进一个再无节点可运行的核心）、config.json、
# runtime/applied、渲染出的出站和钉死的节点地址，状态写
# stopped/no-node，让启动闸门（ADR 0010）在再次应用节点前保持核心
# 停止。state.json 归调用方所有、原样不动（ADR 0013）。幂等：
# 什么都没应用时同样落在 stopped/no-node。
kr_unapply() {
  kr_dirs
  # 绝不从活核心底下抽走配置：那会是停止，而停止是后果不同的
  # 另一手势（fail-closed 的规则留在位上）。
  if kr_running; then
    kr_log Node "unapply: the core is running; stop it first"
    echo "core is running; stop it first" >&2
    return 1
  fi
  if command -v kr_tp_remove >/dev/null 2>&1; then
    kr_tp_remove
  fi
  rm -f "$KR_CONF" "$KR_APPLIED" "$KR_CONF_TESTED" \
    "$KR_OUTBOUND" "$KR_OUTBOUND_META" \
    "$KR_PIDFILE" "$KR_STARTED" "$KR_RUNDIR/nodeip"
  kr_log Node "unapplied: config, applied id, rendered outbound and takeover rules removed"
  kr_status_write stopped no-node
  return 0
}

kr_start() {
  kr_dirs
  kr_cleanup_legacy
  kr_lock || { kr_log Core "could not acquire start lock"; return 1; }
  kr_start_locked
  _rc=$?
  # 返回时释放，而不只靠 EXIT trap：apply 可能启动两次（新配置、
  # 然后一次回滚），锁若持到进程退出会让第二次启动去等陈旧锁
  # 超时。
  rmdir "$KR_RUNDIR/start.lock" 2>/dev/null
  return "$_rc"
}

kr_start_locked() {
  if kr_running; then
    kr_kill_strays "$(kr_pid)"
    kr_log Core "already running (pid $(kr_pid))"
    kr_status_write running "${KR_TP_PHASE:-idle}"
    return 0
  fi
  rm -f "$KR_PIDFILE"
  kr_kill_strays ""
  # 启动前先轮转核心日志，本次启动的 test/run 才往新文件追加。
  kr_log_rotate "$KR_LOG"

  _core=$KR_BINDIR/xray
  if ! kr_core_works; then
    kr_log Core "core missing or not executable: $_core"
    kr_status_write failed no-core
    return 1
  fi
  # 闸门：核心绝不运行不是从已应用节点派生的配置
  #（ADR 0010）。没有它就无可启动；诚实的状态是停止，
  # 不是直连运行。
  if ! kr_applied_id >/dev/null; then
    kr_log Core "no applied node; the core stays stopped"
    echo "no applied node; tap a node in the node list to apply one first" >&2
    kr_status_write stopped no-node
    return 1
  fi
  # 启动即接管（ADR 0011）：不存在开关。启动有两个接管半程，配置夹
  # 在中间。先冲突检查与节点钉死，趁网络还直连——钉死绝不能在
  # 捕获之下提问，渲染也需要它的答案。然后是配置，按唯一形态
  # 渲染、已知通过 `xray -test`。之后才是规则，仍在核心运行之前
  #（fail-closed，ADR 0004）——被核心拒绝的配置让设备保持直连
  # 而不是断网。任何半程失败都拒绝启动：没有接管就没有核心。
  if command -v kr_tp_prepare >/dev/null 2>&1; then
    if ! kr_tp_prepare; then
      kr_log Core "takeover cannot be enforced (${KR_TP_PHASE}); the core stays stopped"
      kr_status_write stopped "${KR_TP_PHASE}"
      return 1
    fi
  fi
  # 磁盘配置必须是这次启动将运行的配置：从已应用节点派生，携带
  # 当前端口、日志级别与分流模式——且已知通过 `xray -test`。
  # kr_ensure_config 只在字节不同时渲染并测试，所以按旧偏好写的
  # 配置（geo 数据消失、级别变更）的修复不是这里的特例：那就是
  # "字节不同"的含义。测试通过前什么都不碰，所以这里的拒绝
  # 不留规则也不留核心（docs/adr/0011）。
  kr_ensure_config
  _rc=$?
  if [ "$_rc" != 0 ]; then
    if [ "$_rc" = 2 ]; then
      kr_log Config "config test failed, see $KR_LOG"
      kr_status_write failed config-invalid
    else
      kr_status_write failed no-config
    fi
    return 1
  fi
  if command -v kr_tp_engage >/dev/null 2>&1; then
    if ! kr_tp_engage; then
      kr_log Core "takeover rules failed (${KR_TP_PHASE}); the core stays stopped"
      kr_status_write stopped "${KR_TP_PHASE}"
      return 1
    fi
  fi

  kr_status_write starting starting

  nohup "$_core" run -c "$KR_CONF" >>"$KR_LOG" 2>&1 &
  _pid=$!
  echo "$_pid" >"$KR_PIDFILE"
  kr_now >"$KR_STARTED"

  # 等待事实（入站监听），而不是等固定的一秒。
  if kr_core_wait_ready "$_pid"; then
    kr_log Core "started pid $_pid core $_core"
    kr_status_write running "${KR_TP_PHASE:-idle}"
    return 0
  fi
  rm -f "$KR_PIDFILE"
  kr_log Core "core exited right after start, see $KR_LOG"
  kr_status_write failed crashed
  return 1
}

kr_stop() {
  if ! kr_running; then
    rm -f "$KR_PIDFILE" "$KR_STARTED"
    kr_log Core "not running"
    kr_status_write stopped idle
    return 0
  fi
  _p=$(kr_pid)
  kill "$_p" 2>/dev/null
  # 50 ms 步进：核心约 0.2 s 内退出，0.2 s 的步进会把大部分等待
  # 花在空转上。预算与 SIGKILL 之前一样是 4 s。
  _i=0
  while [ "$_i" -lt 80 ] && kill -0 "$_p" 2>/dev/null; do
    sleep 0.05
    _i=$((_i + 1))
  done
  kill -9 "$_p" 2>/dev/null
  rm -f "$KR_PIDFILE" "$KR_STARTED"
  kr_log Core "stopped pid $_p"
  kr_status_write stopped idle
}

# 给 WebUI 的机器可读摘要：每行一个 key=value，值可含空格
#（按第一个 '=' 分割）。状态来自活进程，不是 status.json，所以
# 过期的状态文件无法为死核心声称 running。
kr_status_kv() { # [log|nodes] -- 2s 轮询的页面专属附加项
  # 在 kr_settings_ports（或任何助手）碰位置参数之前先抓住页面参数。
  _want=${1:-}
  if kr_running; then
    _state=running
    _pid=$KR_PID_VAL
    _started=""
    [ -s "$KR_STARTED" ] && { IFS= read -r _started <"$KR_STARTED" || :; }
    case "$_started" in '' | *[!0-9]*) _started=0 ;; esac
  else
    _state=stopped
    _pid=-
    _started=0
  fi
  # 一趟读 status.json 代替每字段一个 sed：phase、记录的 state 和
  # 写它的 boot。kr_status_write 把它写成一行。
  _sj_phase=""
  _sj_state=""
  _sj_boot=""
  if [ -s "$KR_STATUS" ]; then
    while IFS='=' read -r _k _v; do
      case "$_k" in
        phase) _sj_phase=$_v ;;
        state) _sj_state=$_v ;;
        boot) _sj_boot=$_v ;;
      esac
    done <<EOF
$(awk -F'"' '
  {
    for (i = 1; i < NF; i++) {
      if ($i == "phase") phase = $(i + 2);
      else if ($i == "state") state = $(i + 2);
      else if ($i == "boot") boot = $(i + 2);
    }
  }
  END { printf "phase=%s\nstate=%s\nboot=%s\n", phase, state, boot }
' "$KR_STATUS" 2>/dev/null)
EOF
  fi
  _phase=$_sj_phase
  [ -n "$_phase" ] || _phase=unknown
  # 哪次开机写的状态文件决定它能是什么意思（docs/adr/0018）。文件
  # 熬过重启、下次启动前没有东西重写它，所以早前开机写的状态
  # 描述的是一个不可能还在运行的核心：读作 idle——"开机以来什么
  # 都没运行过"——而不是展示本次开机从未有过的失败。那次开机的
  # pidfile 也不能当作崩溃的证据。
  _boot=$(kr_boot_id)
  _stale=0
  if [ -n "$_boot" ] && [ "$_sj_boot" != "$_boot" ]; then
    _stale=1
  fi
  if [ "$_stale" = 1 ]; then
    _phase=idle
  elif [ "$_state" = stopped ] && [ -s "$KR_PIDFILE" ] && [ "$_sj_state" = running ]; then
    # 比进程活得久的 pidfile 意味着核心自己死了：没有东西运行去写
    # failed/crashed，状态文件仍声称 running。报告事实而不是过期
    # phase。没有 boot id（无 procfs）时只能拿 uptime 算术顶替：
    # 早于本次开机的启动不算崩溃。
    if [ -n "$_boot" ]; then
      _phase=crashed
    else
      _up=""
      { IFS=' ' read -r _up _ < /proc/uptime; } 2>/dev/null || _up=""
      _up=${_up%%.*}
      _since=""
      [ -s "$KR_STARTED" ] && { IFS= read -r _since <"$KR_STARTED" || :; }
      case "$_up" in
        '' | *[!0-9]*) _phase=crashed ;; # 没有 uptime 可比：pidfile 即证据
        *)
          case "$_since" in
            '' | *[!0-9]*) _phase=crashed ;;
            *) [ "$_since" -ge $(( $(date +%s) - _up )) ] && _phase=crashed ;;
          esac
          ;;
      esac
    fi
  fi
  _node=""
  kr_applied_read && _node=$KR_APPLIED_VAL
  _rules=absent
  if command -v kr_tp_rules_status >/dev/null 2>&1; then
    kr_tp_rules_status "$_boot"
    _rules=$KR_TP_RULES_STATE
  elif command -v kr_tp_rules_present >/dev/null 2>&1; then
    kr_tp_rules_present && _rules=present
  fi
  # route 是偏好，routing 是配置实际可用的（只在 geo 数据缺失时不同，
  # docs/adr/0014），geodata 说明是哪一种。
  _rt=global
  _rte=global
  _geo=missing
  if command -v kr_route_mode >/dev/null 2>&1; then
    _rt=$(kr_route_mode)
    kr_route_effective
    _rte=$KR_ROUTE_EFFECTIVE
    kr_geodata_ok && _geo=ok
  fi
  # 日志等级 偏好及 config.json 是否已携带它：只有运行中的核心早于
  # 变更时 UI 才显示 pending 提示（docs/adr/0015）。已停止的核心
  # 不需要提示：它的下一次启动会重渲染配置。
  kr_loglevel_read
  _lv=$KR_LOGLEVEL_VAL
  _lvc=""
  kr_loglevel_config_read && _lvc=$KR_LOGLEVEL_CONFIG
  _lvp=0
  [ "$_state" = running ] && [ "$_lvc" != "$_lv" ] && _lvp=1
  kr_settings_ports
  echo "state=$_state"
  echo "phase=$_phase"
  echo "pid=$_pid"
  echo "started=$_started"
  echo "conf=$KR_CONF"
  echo "log=$KR_LOG"
  echo "node=$_node"
  echo "revision=$KR_STATE_REVISION"
  echo "rules=$_rules"
  echo "route=$_rt"
  echo "routing=$_rte"
  echo "geodata=$_geo"
  echo "socks=$KR_SOCKS_PORT"
  echo "http=$KR_HTTP_PORT"
  echo "loglevel=$_lv"
  echo "loglevelpending=$_lvp"
  # 日志页询问大小，让未变化的日志不付 tail 也不付传输；节点页询问
  # 渲染出站的 id，以决定是否必须读 state.json。
  if [ "${_want:-}" = log ]; then
    echo "logsize=$(kr_file_size "$KR_LOG")"
    echo "mlogsize=$(kr_file_size "$KR_MLOG")"
  elif [ "${_want:-}" = nodes ]; then
    kr_meta_read && echo "meta=$KR_META_ID"
  fi
}

# kr_tail <行数> <文件>：一个日志的最后 <行数> 行，文件缺失或不可读时
# 给一行友好提示，而不是空白页。
kr_tail() {
  _n=${1:-200}
  _f=${2:-$KR_LOG}
  case "$_n" in '' | *[!0-9]*) _n=200 ;; esac
  [ "$_n" -gt 2000 ] && _n=2000
  if [ ! -f "$_f" ]; then
    echo "(no log yet: $_f)"
    return 0
  fi
  tail -n "$_n" "$_f" 2>/dev/null || echo "(cannot read $_f)"
}

# kr_log_clear <文件>：清空日志 — 原地截断一个日志，让已持有追加 fd 的
# 写入者（核心的 >> 与 kr_log_write）继续写同一个 WebUI 正在 tail 的文件。
# 用 unlink 会把之后所有行藏进死 inode。缺失的日志目录先创建：
# 在全新安装上清日志是无操作，不是错误。
kr_log_clear() { # <文件>
  _f=${1:-}
  [ -n "$_f" ] || { echo "log clear: no file" >&2; return 2; }
  [ -d "$KR_LOGDIR" ] || mkdir -p "$KR_LOGDIR" 2>/dev/null || {
    echo "log clear: cannot create $KR_LOGDIR" >&2
    return 1
  }
  : >"$_f" 2>/dev/null || { echo "log clear: cannot truncate $_f" >&2; return 1; }
  return 0
}

# kr_mlog_append <标签> <消息...>：来自 WebUI 的一条模块日志行。节点导入
# 与删除从不经过 shell——UI 经桥直接写节点库——所以这是 UI 唯一的入口。
# 标签接受与 kr_log 相同的封闭集合检查，消息压平成一行，UI 字符串里的
# 杂散换行无法破坏行格式。只写文件：这不是命令的结果，UI 记账行
# 的控制台副本是噪音。
kr_mlog_append() { # <标签> <消息...>
  kr_log_tag_ok "$1" || {
    echo "mlog append: unknown tag '$1' ($KR_LOG_TAGS)" >&2
    return 2
  }
  _tag=$1
  shift
  _msg=$(printf '%s' "$*" | tr '\n\r\t' '   ')
  kr_log_file "$_tag" "$_msg"
}

kr_cli() {
  _cmd=${1:-status}
  [ $# -gt 0 ] && shift
  case "$_cmd" in
    start) kr_start ;;
    stop) kr_stop ;;
    apply) kr_apply "${1:-}" ;;
    unapply) kr_unapply ;;
    ports) kr_apply_ports ;;
    routing)
      case "${1:-status}" in
        global|cn|cnadblock) kr_route_set "$1" ;;
        status) kr_route_status ;;
        *)
          echo "usage: kernelray.sh routing {global|cn|cnadblock|status}" >&2
          return 2
          ;;
      esac
      ;;
    loglevel)
      case "${1:-status}" in
        none | error | warning | info | debug) kr_loglevel_set "$1" ;;
        status) kr_loglevel_status ;;
        *)
          echo "usage: kernelray.sh loglevel {none|error|warning|info|debug|status}" >&2
          return 2
          ;;
      esac
      ;;
    status) kr_status_kv "${1:-}" ;;
    log)
      case "${1:-}" in
        clear) kr_log_clear "$KR_LOG" ;;
        *) kr_tail "${1:-200}" "$KR_LOG" ;;
      esac
      ;;
    mlog)
      case "${1:-}" in
        append) shift; kr_mlog_append "$@" ;;
        clear) kr_log_clear "$KR_MLOG" ;;
        *) kr_tail "${1:-200}" "$KR_MLOG" ;;
      esac
      ;;
    tproxy)
      case "${1:-status}" in
        status) kr_tproxy_status ;;
        *)
          echo "usage: kernelray.sh tproxy status" >&2
          return 2
          ;;
      esac
      ;;
    *)
      echo "usage: kernelray.sh {start|stop|apply <node-id>|unapply|ports|tproxy status|routing {global|cn|cnadblock|status}|loglevel {none|error|warning|info|debug|status}|status [log|nodes]|log [lines]|log clear|mlog [lines]|mlog clear|mlog append <tag> <message...>}" >&2
      return 2
      ;;
  esac
}

# 直接执行（WebUI、shell）→ 作为 CLI。被 source（customize.sh、
# uninstall.sh）→ 只留下上面的定义，无副作用。
case "${0##*/}" in
  kernelray.sh) kr_cli "$@" ;;
esac
