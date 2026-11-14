# shellcheck shell=ash
# TPROXY 接管：让设备流量进入核心的规则、拒绝与外来 VPN 共享的
# 冲突检查、以及持久化的偏好。
# 由 kernelray.sh source，后者提供 kr_* 助手与路径。
#
# 落实 docs/adr/0004（模块持有、fail-closed 的接管）、docs/adr/0006
#（DNS 经核心的 DNS 模块）、docs/adr/0008（命名空间取值）与
# docs/adr/0011（启动即接管：每次核心启动都接管，不存在开关）与
# docs/adr/0014（geo 数据随模块内置；分流模式 是 shell 持有的、立即
# 生效的偏好）。命名空间——捕获 fwmark 19283、旁路 fwmark 19282、路由
# 表 19283/19282、ip rule pref 9500/9400、KR_TP_* 链与 tproxy 端口
# 10810——为本模块独占：装与拆的永远只有这些，绝不碰
# 其他模块的规则。

KR_TP_PORT=10810
KR_MARK=19283
KR_TABLE=19283
KR_RULE_PREF=9500
KR_BYPASS=19282
KR_BYPASS_TABLE=19282
KR_BYPASS_PREF=9400
KR_NODEIP=$KR_RUNDIR/nodeip
# "接管规则装了吗"的最后一次真实内核应答，并盖上产生它的开机戳。
# 2s 状态轮询读它，而不调两次 iptables；安全攸关的形态读者仍询问
# 内核（docs/adr/0019）。
KR_TP_RULES=$KR_RUNDIR/rules
KR_TPLOG=$KR_LOGDIR/kernelray.log
# 分流模式（docs/adr/0014）：shell 的偏好，与 日志等级 不同，它立即
# 生效。文件存在即 大陆直连；不存在即 全局，即之前每个版本的行为。
# cn 模式就是用这两个国内解析器解析大陆域名的。
KR_ROUTE=$KR_RUNDIR/route
KR_CN_DNS1=223.5.5.5
KR_CN_DNS2=119.29.29.29
# Ali DoH 的 JSON API。是 IP 字面量，询问它不需要自己先解析。
KR_DOH_RESOLVE=https://223.5.5.5/resolve
# KernelSU 的 busybox 带 wget applet，但 PATH 里既没有 wget 也没有 curl——
# KernelSU 只把 busybox/ksud/resetprop 链接进 /data/adb/ksu/bin——所以询问
# 直接点名二进制。可覆盖，便于测试打桩。
KR_BUSYBOX=${KR_BUSYBOX:-/data/adb/ksu/bin/busybox}

# 通往 kr_log 的带标签透传；tproxy 侧的行共用它。Routing 行直接
# 用自己的标签调 kr_log。
kr_tp_log() { kr_log "$@"; }

kr_tp_rules_present() {
  iptables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1 || return 1
  ip6tables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1 || return 1
  return 0
}

# 规则存在性缓存（docs/adr/0019）：最后一次真实内核应答，盖上产生它的
# 开机戳，状态轮询因此不必每 2s 问两遍 iptables。仅供参考：
# kr_conf_accept_ondisk 与启动路径仍调用 kr_tp_rules_present。缺失
# 或陈旧的缓存由一次真实检查修复并写回；重启后 boot id 变了，
# 第一次轮询会重新检查。
kr_tp_rules_cache_write() { # <0|1> [boot-id]
  _cb=${2:-$(kr_boot_id)}
  [ -d "$KR_RUNDIR" ] || mkdir -p "$KR_RUNDIR" 2>/dev/null
  _ct=$KR_TP_RULES.$$.tmp
  printf 'boot=%s\npresent=%s\n' "$_cb" "${1:-0}" >"$_ct" 2>/dev/null || {
    rm -f "$_ct"
    return 1
  }
  chmod 600 "$_ct" 2>/dev/null
  mv -f "$_ct" "$KR_TP_RULES" 2>/dev/null || {
    rm -f "$_ct"
    return 1
  }
  return 0
}

kr_tp_rules_cache() { # [boot-id]；缓存可用时设置 KR_TP_RULES_CACHED=1|0
  KR_TP_RULES_CACHED=""
  [ -s "$KR_TP_RULES" ] || return 1
  _cc_boot=""
  _cc_present=""
  while IFS='=' read -r _cc_k _cc_v; do
    case "$_cc_k" in
      boot) _cc_boot=$_cc_v ;;
      present) _cc_present=$_cc_v ;;
    esac
  done <"$KR_TP_RULES"
  _cc_now=${1:-}
  [ -n "$_cc_now" ] || _cc_now=$(kr_boot_id)
  [ -n "$_cc_now" ] && [ "$_cc_boot" = "$_cc_now" ] || return 1
  case "$_cc_present" in
    0 | 1) KR_TP_RULES_CACHED=$_cc_present; return 0 ;;
  esac
  return 1
}

# 状态轮询的视角：缓存可用时用缓存，否则一次真实检查并写回。
# 安全攸关的形态读者绝不使用它。
kr_tp_rules_status() { # [boot-id]；设置 KR_TP_RULES_STATE=present|absent
  _ts_boot=${1:-}
  if kr_tp_rules_cache "$_ts_boot"; then
    if [ "$KR_TP_RULES_CACHED" = 1 ]; then
      KR_TP_RULES_STATE=present
    else
      KR_TP_RULES_STATE=absent
    fi
    return 0
  fi
  # 若安装/移除在询问内核期间写入，那个答案比这次的更新：前后比较
  # 丢弃陈旧的写回。
  _ts_before=$(cat "$KR_TP_RULES" 2>/dev/null)
  if kr_tp_rules_present; then
    KR_TP_RULES_STATE=present
    _ts_after=$(cat "$KR_TP_RULES" 2>/dev/null)
    [ "$_ts_before" = "$_ts_after" ] && kr_tp_rules_cache_write 1 "$_ts_boot"
  else
    KR_TP_RULES_STATE=absent
    _ts_after=$(cat "$KR_TP_RULES" 2>/dev/null)
    [ "$_ts_before" = "$_ts_after" ] && kr_tp_rules_cache_write 0 "$_ts_boot"
  fi
  return 0
}

# 冲突检测（docs/adr/0004）：外来 VPN/TUN、始终开启的 VPN 设置或
# 外来的 -j TPROXY 规则。本质上是启发式的；文档仍然写明同一
# 时刻只能有一个透明代理。冲突时打印原因并返回 0。
kr_tp_conflict() {
  _links=$(ip link show 2>/dev/null) || _links=""
  printf '%s\n' "$_links" | grep -q '^[0-9][0-9]*: \(tun[0-9]*\|wg[0-9]*\):.*<.*UP.*>' && {
    printf '%s\n' "$_links" | sed -n 's/^[0-9][0-9]*: \(\(tun\|wg\)[0-9]*\):.*/\1/p' | head -n 1 | {
      read -r _if
      echo "interface $_if is up (a VPN or tunnel owns the routing)"
    }
    return 0
  }
  _vpn=$(settings get secure always_on_vpn_app 2>/dev/null)
  if [ -n "$_vpn" ] && [ "$_vpn" != "null" ]; then
    echo "always-on VPN is set ($_vpn)"
    return 0
  fi
  for _ipt in iptables ip6tables; do
    if "$_ipt" -t mangle -S 2>/dev/null | grep '^-A ' | grep -- '-j TPROXY' |
      grep -v '^-A KR_TP_' >/dev/null 2>&1; then
      echo "$_ipt mangle has a foreign TPROXY rule"
      return 0
    fi
  done
  return 1
}

# 一个地址族的规则：<iptables|ip6tables>。核心自己的 socket 带旁路
# mark、最先返回；发往端口 53 的 DNS 在旁路段之前就用捕获 mark 标记，
# 让局域网解析器也被捕获（docs/adr/0006）；DHCP 在一切之前旁路，
# 因为被代理的 DHCP 应答永远分不到地址。
kr_tp_ipt_rules() { # <二进制>
  _i=$1
  if [ "$_i" = ip6tables ]; then
    $_i -t mangle -N KR_TP_OUTPUT 2>/dev/null || return 1
    $_i -t mangle -F KR_TP_OUTPUT || return 1
    $_i -t mangle -A KR_TP_OUTPUT -m mark --mark $KR_BYPASS -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -p tcp --dport 53 -j MARK --set-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_OUTPUT -p udp --dport 53 -j MARK --set-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_OUTPUT -m mark --mark $KR_MARK -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d ::1/128 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d fe80::/10 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d fc00::/7 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d ff00::/8 -j RETURN || return 1
    _addrs=$(kr_tp_own_addrs $_i)
    for _a in $_addrs; do
      $_i -t mangle -A KR_TP_OUTPUT -d "$_a" -j RETURN || return 1
    done
    $_i -t mangle -A KR_TP_OUTPUT -j MARK --set-mark $KR_MARK || return 1

    $_i -t mangle -N KR_TP_PREROUTING 2>/dev/null || return 1
    $_i -t mangle -F KR_TP_PREROUTING || return 1
    # 只把本地客户端的包交给监听——每个被捕获的包都源自本地源。
    # lo 上的其余一切都是核心自己的透明应答（SYN-ACK、DNS 应答，其
    # 源是 ORIGINAL 目的地）：它带着从被捕获 SYN 继承的 tproxy mark，
    # 必须流向正常本地投递——捕获它会把每条应答劫回核心，让所有
    # 握手挂死。
    # 目的地为环回的包是同一情形的另一端：核心自己的
    # socks/http 监听从 127/8 应答到 127/8 的本地客户端，下面按源
    # 匹配的 TPROXY 否则会劫走那个 SYN-ACK，挂死每条本地代理连接。
    $_i -t mangle -A KR_TP_PREROUTING ! -i lo -j RETURN || return 1
    $_i -t mangle -A KR_TP_PREROUTING -d ::1/128 -j RETURN || return 1
    $_i -t mangle -A KR_TP_PREROUTING -d ::ffff:127.0.0.0/104 -j RETURN || return 1
    $_i -t mangle -A KR_TP_PREROUTING -s ::1/128 -p tcp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_PREROUTING -s ::1/128 -p udp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    _addrs=$(kr_tp_own_addrs $_i)
    for _a in $_addrs; do
      $_i -t mangle -A KR_TP_PREROUTING -s "${_a%/*}" -p tcp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
      $_i -t mangle -A KR_TP_PREROUTING -s "${_a%/*}" -p udp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    done
  else
    $_i -t mangle -N KR_TP_OUTPUT 2>/dev/null || return 1
    $_i -t mangle -F KR_TP_OUTPUT || return 1
    $_i -t mangle -A KR_TP_OUTPUT -m mark --mark $KR_BYPASS -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -p tcp --dport 53 -j MARK --set-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_OUTPUT -p udp --dport 53 -j MARK --set-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_OUTPUT -m mark --mark $KR_MARK -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -p udp --dport 67:68 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 0.0.0.0/8 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 10.0.0.0/8 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 100.64.0.0/10 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 127.0.0.0/8 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 169.254.0.0/16 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 172.16.0.0/12 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 192.168.0.0/16 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 224.0.0.0/4 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 240.0.0.0/4 -j RETURN || return 1
    $_i -t mangle -A KR_TP_OUTPUT -d 255.255.255.255/32 -j RETURN || return 1
    _addrs=$(kr_tp_own_addrs $_i)
    for _a in $_addrs; do
      $_i -t mangle -A KR_TP_OUTPUT -d "$_a" -j RETURN || return 1
    done
    $_i -t mangle -A KR_TP_OUTPUT -j MARK --set-mark $KR_MARK || return 1

    $_i -t mangle -N KR_TP_PREROUTING 2>/dev/null || return 1
    $_i -t mangle -F KR_TP_PREROUTING || return 1
    $_i -t mangle -A KR_TP_PREROUTING ! -i lo -j RETURN || return 1
    # 环回目的地是本地入站（socks/http），不是被捕获流量；下面按源
    # 匹配的 TPROXY 会劫走它的 SYN-ACK，挂死本地连接。
    $_i -t mangle -A KR_TP_PREROUTING -d 127.0.0.0/8 -j RETURN || return 1
    $_i -t mangle -A KR_TP_PREROUTING -s 127.0.0.0/8 -p tcp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_PREROUTING -s 127.0.0.0/8 -p udp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    _addrs=$(kr_tp_own_addrs $_i)
    for _a in $_addrs; do
      $_i -t mangle -A KR_TP_PREROUTING -s "${_a%/*}" -p tcp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
      $_i -t mangle -A KR_TP_PREROUTING -s "${_a%/*}" -p udp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    done
  fi

  # 通配 tproxy 监听绝不能是局域网上的开放代理（docs/adr/0004）。
  $_i -t filter -N KR_TP_INPUT 2>/dev/null || return 1
  $_i -t filter -F KR_TP_INPUT || return 1
  $_i -t filter -A KR_TP_INPUT ! -i lo -p tcp --dport $KR_TP_PORT -j DROP || return 1
  $_i -t filter -A KR_TP_INPUT ! -i lo -p udp --dport $KR_TP_PORT -j DROP || return 1
  $_i -t filter -A KR_TP_INPUT -j RETURN || return 1

  $_i -t mangle -C PREROUTING -j KR_TP_PREROUTING 2>/dev/null ||
    $_i -t mangle -A PREROUTING -j KR_TP_PREROUTING || return 1
  $_i -t mangle -C OUTPUT -j KR_TP_OUTPUT 2>/dev/null ||
    $_i -t mangle -A OUTPUT -j KR_TP_OUTPUT || return 1
  $_i -t filter -C INPUT -j KR_TP_INPUT 2>/dev/null ||
    $_i -t filter -A INPUT -j KR_TP_INPUT || return 1
  return 0
}

# 设备自身的地址（每行一个）。tproxy 应答要回到原始客户端地址
# ——设备自己——而它不在公网 IP 设备的任何固定旁路段里；
# 没有这条规则，应答会被捕获并环回。
kr_tp_own_addrs() { # <iptables|ip6tables>，stdout 输出
  if [ "$1" = ip6tables ]; then
    ip -6 addr show scope global 2>/dev/null | grep -oE 'inet6 [0-9a-fA-F:]+/[0-9]+' | awk '{print $2}'
  else
    ip -4 addr show 2>/dev/null | grep -oE 'inet [0-9.]+/[0-9]+' | awk '{print $2}'
  fi
}

kr_tp_routes() {
  # 捕获路径：OUTPUT 链标记的包经 lo 重路由进 tproxy 监听。
  ip rule del pref $KR_RULE_PREF 2>/dev/null
  ip rule add pref $KR_RULE_PREF fwmark $KR_MARK lookup $KR_TABLE || return 1
  ip route replace local 0.0.0.0/0 dev lo table $KR_TABLE || return 1
  ip -6 rule del pref $KR_RULE_PREF 2>/dev/null
  ip -6 rule add pref $KR_RULE_PREF fwmark $KR_MARK lookup $KR_TABLE || return 1
  ip -6 route replace local ::/0 dev lo table $KR_TABLE || return 1
  # 旁路路径：核心自己的 socket 带 $KR_BYPASS，绝不能进捕获表
  #（那会把它们环回进核心）。Android 经 netd 的 mark 选择的逐网络
  # 表路由默认路由，所以旁路表拿到当前默认路由的一份副本。
  # 之后切换网络由再次接管恢复。
  # 它还需要本地投递：tproxy 应答回到设备自己的地址，
  # 只有默认路由的表会把它们发给网关并丢失。
  _def4=$(ip route show table all 2>/dev/null | grep -m1 '^default ')
  if [ -z "$_def4" ]; then
    kr_tp_log TProxy "no ipv4 default route; cannot build the bypass path"
    return 1
  fi
  _r=$(kr_tp_copy_route 4 "$_def4") || return 1
  ip route add local 127.0.0.0/8 dev lo table $KR_BYPASS_TABLE 2>/dev/null
  for _a in $(kr_tp_own_addrs iptables); do
    ip route add local "${_a%/*}" dev lo table $KR_BYPASS_TABLE 2>/dev/null
  done
  ip route show table main 2>/dev/null | grep -v '^default' | while IFS= read -r _rt; do
    ip route add $_rt table $KR_BYPASS_TABLE 2>/dev/null
  done
  ip rule del pref $KR_BYPASS_PREF 2>/dev/null
  ip rule add pref $KR_BYPASS_PREF fwmark $KR_BYPASS lookup $KR_BYPASS_TABLE || return 1
  _def6=$(ip -6 route show table all 2>/dev/null | grep -m1 '^default ')
  if [ -n "$_def6" ]; then
    if kr_tp_copy_route 6 "$_def6"; then
      ip -6 route add local ::1 dev lo table $KR_BYPASS_TABLE 2>/dev/null
      for _a in $(kr_tp_own_addrs ip6tables); do
        ip -6 route add local "${_a%/*}" dev lo table $KR_BYPASS_TABLE 2>/dev/null
      done
      ip -6 rule del pref $KR_BYPASS_PREF 2>/dev/null
      ip -6 rule add pref $KR_BYPASS_PREF fwmark $KR_BYPASS lookup $KR_BYPASS_TABLE || return 1
    else
      kr_tp_log TProxy "could not copy the ipv6 default route; no v6 bypass"
    fi
  else
    kr_tp_log TProxy "no ipv6 default route; the bypass table has no v6 route"
  fi
  return 0
}

# 把一条默认路由（来自 `ip route show table all`）补进旁路表：剥掉
# 外来表 id 和 RA/过期装饰，保留 via/dev。
kr_tp_copy_route() { # <4|6> <路由行>
  _r=${2#default }
  _via=$(printf '%s\n' "$_r" | sed -n 's/.*via \([^ ]*\).*/\1/p')
  _dev=$(printf '%s\n' "$_r" | sed -n 's/.*dev \([^ ]*\).*/\1/p')
  if [ -n "$_via" ]; then
    ip -$1 route add default via "$_via" dev "$_dev" table $KR_BYPASS_TABLE
  else
    ip -$1 route add default dev "$_dev" table $KR_BYPASS_TABLE
  fi
}

# 安装整套接管命名空间，两个地址族。任何失败都会把一切再次移除：
# 半次捕获是静默泄漏，不是更小的功能（docs/adr/0004）。
kr_tp_install() {
  if kr_tp_rules_present; then
    kr_tp_log TProxy "takeover rules already present"
    kr_tp_rules_cache_write 1
    return 0
  fi
  kr_tp_log TProxy "installing takeover rules (mark $KR_MARK, table $KR_TABLE, pref $KR_RULE_PREF, port $KR_TP_PORT)"
  if ! kr_tp_ipt_rules iptables; then
    kr_tp_log TProxy "iptables rules failed; removing everything again"
    kr_tp_remove
    return 1
  fi
  if ! kr_tp_ipt_rules ip6tables; then
    kr_tp_log TProxy "ip6tables rules failed; removing everything again"
    kr_tp_remove
    return 1
  fi
  if ! kr_tp_routes; then
    kr_tp_log TProxy "policy routing failed; removing everything again"
    kr_tp_remove
    return 1
  fi
  kr_tp_log TProxy "takeover rules installed"
  kr_tp_rules_cache_write 1
  return 0
}

# 只移除我们自己的命名空间。每次调用都是容忍的：卸载与失败路径
# 依赖它在什么都没装过时也能成功。
kr_tp_remove() {
  for _i in iptables ip6tables; do
    "$_i" -t mangle -D PREROUTING -j KR_TP_PREROUTING 2>/dev/null
    "$_i" -t mangle -D OUTPUT -j KR_TP_OUTPUT 2>/dev/null
    "$_i" -t filter -D INPUT -j KR_TP_INPUT 2>/dev/null
    "$_i" -t mangle -F KR_TP_PREROUTING 2>/dev/null
    "$_i" -t mangle -X KR_TP_PREROUTING 2>/dev/null
    "$_i" -t mangle -F KR_TP_OUTPUT 2>/dev/null
    "$_i" -t mangle -X KR_TP_OUTPUT 2>/dev/null
    "$_i" -t filter -F KR_TP_INPUT 2>/dev/null
    "$_i" -t filter -X KR_TP_INPUT 2>/dev/null
  done
  ip rule del pref $KR_RULE_PREF 2>/dev/null
  ip -6 rule del pref $KR_RULE_PREF 2>/dev/null
  ip rule del pref $KR_BYPASS_PREF 2>/dev/null
  ip -6 rule del pref $KR_BYPASS_PREF 2>/dev/null
  ip route del local 0.0.0.0/0 table $KR_TABLE 2>/dev/null
  ip -6 route del local ::/0 table $KR_TABLE 2>/dev/null
  ip route flush table $KR_BYPASS_TABLE 2>/dev/null
  ip -6 route flush table $KR_BYPASS_TABLE 2>/dev/null
  kr_tp_rules_cache_write 0
  return 0
}

# JSON 转义 shell 要拼进生成块的值（目前：节点主机名）。
kr_tp_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# 解析已应用节点的主机名。只在规则关闭（直连网络）时安全；结果
# 被钉进核心 DNS 模块的 hosts，让节点连接从不依赖上游解析器
#（自举死锁，见 docs/adr/0008）。系统解析器正是被污染的网络会毒化
# 的东西，所以第一问是经 $KR_BUSYBOX wget 的固定 DoH 端点
#（只要 A 记录，与 DNS 模块的 UseIPv4 匹配）；KernelSU 的 busybox
# 带 wget applet，PATH 里既没有 wget 也没有 curl。
# TLS 校验关闭
#（--no-check-certificate）：Android 的 busybox 没有可校验的 CA 库，
# 而对固定 IP 的未校验询问胜过退回被污染毒化的解析器
#（docs/adr/0008）。-T 只限读取；敌意网络上的连接否则可能挂几十秒
#（实测：约 50 s），所以 busybox 的 timeout applet 给询问恢复硬性的
# 整调用预算——即 curl 的 --max-time 语义。busybox 缺失或询问失败
# 回退到系统
# 解析器。打印 ip；主机名是字面量或无法解析时什么都不打印。
kr_tp_resolve_node() {
  _host=$(kr_meta_get host 2>/dev/null)
  case "$_host" in
    *:*) return 0 ;; # ipv6 字面量：无可解析
    *[!0-9.]*) ;; # 域名：解析它
    *) return 0 ;; # ipv4 字面量
  esac
  # 百分号编码查询值；先编码 %，避免后面的规则双重编码。
  _enc=$(printf '%s' "$_host" | sed -e 's/%/%25/g' -e 's/&/%26/g' -e 's/=/%3D/g' \
    -e 's/?/%3F/g' -e 's/#/%23/g' -e 's/ /%20/g')
  _out=$("$KR_BUSYBOX" timeout 4 "$KR_BUSYBOX" wget -q -T 4 -t 1 -O - --no-check-certificate \
    "$KR_DOH_RESOLVE?name=$_enc&type=A" 2>/dev/null |
    grep -o '"type":1,"data":"[0-9.]*"' | head -n 1 |
    sed 's/.*"data":"\([0-9.]*\)".*/\1/')
  [ -n "$_out" ] && {
    kr_log_file DNS "resolved $_host -> $_out via DoH"
    echo "$_out"
    return 0
  }
  # 不是 kr_log：本函数的 stdout 是它的返回值。
  kr_log_file DNS "the DoH ask failed; falling back to the system resolver"
  _out=$(ping -c1 -W2 "$_host" 2>/dev/null | sed -n 's/^[^(]*(\([0-9.]*\)).*/\1/p' | head -n 1)
  [ -n "$_out" ] && echo "$_out"
}

kr_tp_pin_node() {
  # 每次调用只解析一次：apply 在渲染前钉死，它触发的启动
  # 在同一个 shell 里运行——同一问题问两遍要花一次 DoH 往返（约 0.2-4 s）。
  [ "${KR_NODEIP_PINNED:-0}" = 1 ] && return 0
  KR_NODEIP_PINNED=1
  _ip=$(kr_tp_resolve_node)
  if [ -n "$_ip" ]; then
    printf '%s\n' "$_ip" >"$KR_NODEIP"
    chmod 600 "$KR_NODEIP" 2>/dev/null
    kr_tp_log Node "pinned node address $_ip"
  else
    rm -f "$KR_NODEIP"
    kr_tp_log DNS "could not pre-resolve the node host; bootstrap falls back to the direct DoH rule"
  fi
}

# ---- geo 数据与 分流模式（docs/adr/0014） ------------------------------------------

# 两个 .dat 文件必须同时在场：引用 geosite:cn 而没有 geosite.dat 的配置
# 过不了 `xray -test`，缺 geoip.dat 是晚一条规则的同一个死胡同。
kr_geodata_ok() {
  [ -s "$KR_BINDIR/geosite.dat" ] && [ -s "$KR_BINDIR/geoip.dat" ]
}

# 持久化的 分流模式，按文件内容读取：`cn` 或 `cnadblock`，其他任何值
#（包括文件不存在）都是 全局。全局 是文件不存在的模式，不再是默认：
# 安装器写一次 大陆直连去广告（kr_route_default，docs/adr/0021）。写入方
# 是 `kernelray.sh routing`。
kr_route_mode() {
  _m=""
  [ -s "$KR_ROUTE" ] && { IFS= read -r _m <"$KR_ROUTE" || :; }
  case "$_m" in
    cn | cnadblock) printf '%s\n' "$_m" ;;
    *) printf 'global\n' ;;
  esac
}

kr_route_write() { # <global|cn|cnadblock>
  kr_dirs
  case "$1" in
    cn | cnadblock)
      printf '%s\n' "$1" >"$KR_ROUTE" 2>/dev/null || {
        echo "could not write $KR_ROUTE" >&2
        return 1
      }
      chmod 600 "$KR_ROUTE" 2>/dev/null
      ;;
    *) rm -f "$KR_ROUTE" ;;
  esac
  return 0
}

# 安装时默认：大陆直连去广告，让全新安装不挑任何东西就完成大陆分流
# 与广告拦截。只有安装器创建它，且只在偏好仍为未设时，所以之后的
# 选择能活到下一次安装或更新。geo 数据缺失时跳过——核心无法以其
# 启动的默认值，比一个少做事的默认值更糟
#（docs/adr/0021、docs/adr/0014）。
kr_route_default() {
  [ -s "$KR_ROUTE" ] && return 0
  if ! kr_geodata_ok; then
    kr_log Routing "geo data missing; the 分流模式 default stays global"
    return 0
  fi
  kr_route_write cnadblock || return 0
  kr_log Routing "分流模式 defaults to cnadblock"
}

# 渲染可用的：KR_ROUTE_EFFECTIVE（global|cn|cnadblock）、构建器读的
# 标志 KR_ROUTE_CN 与 KR_ROUTE_BLOCK_ADS（代替字符串比较），以及偏好
# 要求 cn 而 geo 数据没了时的 KR_ROUTE_DEGRADED。设置变量而不打印
# ——渲染的 stdout 是配置，降级绝不能有机会弄脏它——并且绝不碰
# 偏好：偏好是意图，渲染是事实。可选参数是调用方的"渲染这个模式，
# 不是保存的那个"（routing 的切换在写偏好之前先渲染候选）。
#
# geo 数据没了时 大陆直连 降级为 全局：全部走节点是慢，不是坏。
# 大陆直连去广告 不降级——名字承诺拦截，所以渲染广告部分并让
# `xray -test` 拒绝启动（docs/adr/0021）。撒谎的模式比不肯启动的
# 模式更糟。
kr_route_effective() { # [模式覆盖]
  _m=${1:-}
  [ -n "$_m" ] || _m=$(kr_route_mode)
  KR_ROUTE_DEGRADED=0
  if [ "$_m" = cn ] && ! kr_geodata_ok; then
    _m=global
    KR_ROUTE_DEGRADED=1
  fi
  KR_ROUTE_EFFECTIVE=$_m
  KR_ROUTE_CN=0
  KR_ROUTE_BLOCK_ADS=0
  case "$_m" in
    cn) KR_ROUTE_CN=1 ;;
    cnadblock) KR_ROUTE_CN=1 KR_ROUTE_BLOCK_ADS=1 ;;
  esac
  return 0
}

# DNS 模块块。全局 保留单一 DoH 上游（docs/adr/0006）。大陆直连 对
# 大陆域名先问国内解析器，让应答是 CDN 期待的那些；geoip:cn 之外的
# 应答被拒绝、查询落到仍经节点离开的 DoH。<host> <转义 host> 是
# 已应用节点自己的名字。
kr_tp_dns_block() { # <host> <转义 host> -> KR_DNS_BLOCK
  _servers='"https://1.1.1.1/dns-query"'
  if [ "$KR_ROUTE_CN" = 1 ]; then
    _servers='{"address":"'$KR_CN_DNS1'","domains":["geosite:cn"],"expectIPs":["geoip:cn"]},'
    _servers=$_servers'{"address":"'$KR_CN_DNS2'","domains":["geosite:cn"],"expectIPs":["geoip:cn"]},'
    _servers=$_servers'"https://1.1.1.1/dns-query"'
  fi
  # 钉死的节点地址移除对任何上游解析器的自举依赖：DNS 模块不经
  # 任何人、从 hosts 应答节点域名。大陆直连去广告 往同一映射加广告
  # 沉没端：`#3` 让模块以 rcode 3（NXDOMAIN）应答空响应而不是解析，
  # 广告域名彻底拿不到地址（config/dns.html；`#<n>` 形式需要核心
# >= 25.7.23，bin/README 点名了这个底线）。
  _hosts=""
  _nodeip=$(cat "$KR_NODEIP" 2>/dev/null)
  if [ -n "$1" ] && [ -n "$_nodeip" ]; then
    _hosts='"full:'$2'":"'$_nodeip'"'
  fi
  if [ "$KR_ROUTE_BLOCK_ADS" = 1 ]; then
    _hosts=$_hosts${_hosts:+,}'"geosite:category-ads-all":"#3"'
  fi
  [ -n "$_hosts" ] && _hosts=',"hosts":{'"$_hosts"'}'
  # "dns" 标签是路由块的 inboundTag:["dns"] 规则能到达这些上游查询
  # 的前提：没有它核心给它们打上 xray.system.<uuid>，它们落到
  # 端口-53 -> dns-out 规则——径直回到本模块（ADR 0006）。
  KR_DNS_BLOCK='{"tag":"dns","servers":['$_servers'],"queryStrategy":"UseIPv4"'$_hosts'}'
  return 0
}

# 路由块。<1|0 接管> <host> <转义 host> -> KR_ROUTING
# 只有接管形态有 dns 入站，所以只有它拥有 DNS 模块规则与
# 端口-53 捕获。geo 规则在两种形态里相同：本地 socks 客户端得到
# 与设备相同的分流。
kr_tp_routing_block() { # <1|0> <host> <转义 host>
  _rules=""
  if [ "$1" = 1 ]; then
    # 已应用节点自己的主机名经 direct 出站解析（自举，docs/adr/0006）；
    # IP 型节点不需要例外。
    if [ -n "$2" ]; then
      _rules='{"inboundTag":["dns"],"domain":["full:'$3'"],"outboundTag":"direct"}'
    fi
    # 国内解析器查询走 direct；DNS 模块问的其余一切经代理。
    if [ "$KR_ROUTE_CN" = 1 ]; then
      _rules=$_rules${_rules:+,}'{"inboundTag":["dns"],"ip":["'$KR_CN_DNS1'","'$KR_CN_DNS2'"],"outboundTag":"direct"}'
    fi
    _rules=$_rules${_rules:+,}'{"inboundTag":["dns"],"outboundTag":"proxy"}'
    _rules=$_rules',{"network":"tcp,udp","port":53,"outboundTag":"dns-out"}'
  fi
  # 广告在所有 分流 规则之前被拒——先命中先赢，所以大陆广告域名绝不能
  # 落进 geosite:cn -> direct——并在上面的 dns/端口-53 组之后，所以解析器
  # 查询不会被它吞掉（docs/adr/0021）。
  if [ "$KR_ROUTE_BLOCK_ADS" = 1 ]; then
    _rules=$_rules${_rules:+,}'{"domain":["geosite:category-ads-all"],"outboundTag":"block"}'
  fi
  if [ "$KR_ROUTE_CN" = 1 ]; then
    # 私网目的地保持本地。接管的 iptables 旁路已把它们挡在核心之外，
    # 但本地 socks 客户端没有旁路，而路由器的管理页不是代理目标。
    _rules=$_rules${_rules:+,}'{"ip":["geoip:private"],"outboundTag":"direct"}'
    _rules=$_rules',{"domain":["geosite:private"],"outboundTag":"direct"}'
    _rules=$_rules',{"domain":["geosite:cn"],"outboundTag":"direct"}'
    _rules=$_rules',{"ip":["geoip:cn"],"outboundTag":"direct"}'
  fi
  # 全局 的 AsIs 逐字节保留 0014 之前的块。两种 geo 模式的 IPIfNonMatch
  # 让任何 geosite 分类都不认识的域名在解析后仍可匹配 geoip:cn。
  _strategy=AsIs
  [ "$KR_ROUTE_CN" = 1 ] && _strategy=IPIfNonMatch
  KR_ROUTING='{"domainStrategy":"'$_strategy'","rules":['$_rules']}'
  return 0
}

# 拼进模板占位符的接管 JSON 块。在这里编写，不在 UI：入站、DNS 与
# 路由是模块持有的布局（docs/adr/0005）。
kr_tp_render_blocks() { # [路由覆盖]；设置 KR_TP_INBOUND、KR_DNS_OUTBOUND、KR_DNS_BLOCK、KR_ROUTING
  KR_TP_INBOUND='{"tag":"tp-in","listen":"::","port":'"$KR_TP_PORT"',"protocol":"dokodemo-door","settings":{"network":"tcp,udp","followRedirect":true},"streamSettings":{"sockopt":{"tproxy":"tproxy"}}}'
  KR_DNS_OUTBOUND='{"tag":"dns-out","protocol":"dns","settings":{}}'
  kr_route_effective "${1:-}"
  _host=$(kr_meta_get host 2>/dev/null)
  case "$_host" in
    *:*) _host="" ;; # IPv6 字面量：无可解析
    *[!0-9.]*) : ;; # 域名：保留例外
    *) _host="" ;; # IPv4 字面量（仅数字与点）：无可解析
  esac
  _e=$(kr_tp_json_escape "$_host")
  kr_tp_dns_block "$_host" "$_e"
  kr_tp_routing_block 1 "$_host" "$_e"
  return 0
}

# routing <global|cn|cnadblock>：分流模式 偏好。它立即重新推导
# 配置（docs/adr/0014）：渲染新形态、测试、写偏好，然后换入。失败的
# 换入恢复偏好，所以它绝不声称一个核心并没有运行的形态。没有已
# 应用节点时没有可重渲染的东西：偏好照存，下一次应用时渲染。
kr_route_set() { # <global|cn|cnadblock>
  case "$1" in
    global | cn | cnadblock) ;;
    *)
      echo "usage: kernelray.sh routing {global|cn|cnadblock|status}" >&2
      return 2
      ;;
  esac
  kr_dirs
  _cur=$(kr_route_mode)
  if [ "$_cur" = "$1" ]; then
    kr_log Routing "already $1"
    return 0
  fi
  # 两种 geo 模式都需要文件。大陆直连 保留较长的消息；大陆直连去广告
  # 只说提示、toast 与日志行共有的那一句短话，因为它永不降级
  #（docs/adr/0021）。
  if [ "$1" != global ] && ! kr_geodata_ok; then
    case "$1" in
      cn)
        kr_log Routing "cn needs $KR_BINDIR/{geosite,geoip}.dat"
        echo "geo data is missing ($KR_BINDIR); the routing mode stays $_cur" >&2
        ;;
      *)
        kr_log Routing "geo data missing; cnadblock cannot start"
        echo "geo data missing" >&2
        ;;
    esac
    return 1
  fi
  _n=$(kr_applied_id) || _n=""
  if [ -z "$_n" ]; then
    kr_route_write "$1" || return 1
    kr_log Routing "$_cur -> $1 (no applied node; the next apply renders it)"
    return 0
  fi
  # 写偏好之前先用此模式渲染候选：被核心拒绝的配置让模式停在原地。
  kr_config_candidate "$_n" "$1" || return 1
  if ! kr_route_write "$1"; then
    [ -n "$KR_CANDIDATE" ] && rm -f "$KR_CANDIDATE"
    return 1
  fi
  if [ -z "$KR_CANDIDATE" ]; then
    kr_log Routing "$1 (the config already carries it)"
    return 0
  fi
  # 模式是这份配置的渲染意图，所以回滚必须在恢复的配置启动 *之前*
  # 恢复它：那次启动会从模式重新推导配置（docs/adr/0017）。
  if ! kr_swap_install "$KR_CANDIDATE" ""; then
    kr_route_write "$_cur"
    return 1
  fi
  if ! kr_swap_start; then
    kr_route_write "$_cur"
    kr_swap_rollback
    kr_log Routing "the $1 config did not start; the mode is back to $_cur"
    return 1
  fi
  rm -f "$KR_RUNDIR/config.json.prev"
  kr_log Routing "$_cur -> $1"
  return 0
}

kr_route_status() {
  printf 'mode=%s\n' "$(kr_route_mode)"
  kr_route_effective
  printf 'effective=%s\n' "$KR_ROUTE_EFFECTIVE"
  kr_geodata_ok && echo "geodata=ok" || echo "geodata=missing"
  return 0
}

# 启动的前半程（docs/adr/0011）：冲突检查与节点钉死，都在配置渲染
# 之前。钉死必须在网络仍直连时提问——规则之下的 DoH 查询会进入
# 一条通向尚未运行的核心的捕获——渲染也需要它的答案（DNS 模块的
# hosts 条目）。由 kr_start_locked 在已应用节点闸门之后调用。无法
# 接管时返回 1 并设置 KR_TP_PHASE：调用方随即拒绝启动，因为没有
# 接管就没有核心（docs/adr/0011）。
kr_tp_prepare() {
  _applied=$(kr_applied_id) || _applied=""
  if [ -z "$_applied" ] || [ "$(kr_meta_get id 2>/dev/null)" != "$_applied" ] || [ ! -s "$KR_OUTBOUND" ]; then
    # 没有可用的出站：没有可捕获进的东西，规则绝不能装上。启动
    # 闸门（ADR 0010）反正会拒绝这次启动；这条让规则不比启动活得久。
    kr_tp_log TProxy "prepare: no usable outbound for the applied node; takeover skipped"
    return 0
  fi
  _why=$(kr_tp_conflict) || _why=""
  if [ -n "$_why" ]; then
    kr_tp_log TProxy "prepare: conflict, takeover not enforced: $_why"
    KR_TP_PHASE=failed/conflict
    return 1
  fi
  # 已记忆化：为本渲染钉过死的 apply 不再问第二遍。
  kr_tp_pin_node
  return 0
}

# 启动的后半程（docs/adr/0011）：规则装入，仍在核心运行之前
#（fail-closed，docs/adr/0004），但仅在 `xray -test` 接受配置之后——被
# 核心拒绝的配置让设备保持直连而不是断网。返回 1 并设置
# KR_TP_PHASE；调用方随即拒绝启动。它只拥有规则，别的什么都不管。
kr_tp_engage() {
  if ! kr_tp_install; then
    kr_tp_log TProxy "engage: rule install failed, takeover not enforced"
    KR_TP_PHASE=failed/rules
    return 1
  fi
  KR_TP_PHASE=idle
  kr_tp_log TProxy "engage: takeover rules installed before the core starts"
  return 0
}

# 只读诊断。不再有可报告的开关（docs/adr/0011）；规则才是值得询问
# 的事实。
kr_tproxy_status() {
  kr_tp_rules_present && echo "rules=present" || echo "rules=absent"
  return 0
}
