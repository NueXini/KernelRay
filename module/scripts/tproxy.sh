# shellcheck shell=ash
# TPROXY takeover: the rules that make device traffic enter the core, the conflict
# checks that refuse to share them with a foreign VPN, and the persisted switch.
# Sourced by kernelray.sh, which provides the kr_* helpers and paths.
#
# Implements docs/adr/0004 (module-owned, fail-closed takeover), docs/adr/0006
# (DNS through the core's DNS module), docs/adr/0008 (namespace values) and
# docs/adr/0011 (the switch is a default-on preference coupled to the core's start). The namespace — capture fwmark 19283, bypass fwmark 19282, routing
# tables 19283/19282, ip rule preferences 9500/9400, the KR_TP_* chains and tproxy port
# 10810 — is exclusive to this module: only those are ever installed or removed, never
# another module's rules.

KR_TP_PORT=10810
KR_MARK=19283
KR_TABLE=19283
KR_RULE_PREF=9500
KR_BYPASS=19282
KR_BYPASS_TABLE=19282
KR_BYPASS_PREF=9400
KR_TP_SWITCH=$KR_RUNDIR/tproxy
KR_NODEIP=$KR_RUNDIR/nodeip
KR_TPLOG=$KR_LOGDIR/kernelray.log

kr_tp_log() { kr_log "$*"; }

# The persisted tproxy switch (tproxy透明代理开关): presence of the file is the user's
# choice that takeover engages when the core starts. It is on from install (ADR 0011)
# and is a pure preference: writing it never touches a running core or the rules.
kr_tp_switch_on() { [ -s "$KR_TP_SWITCH" ]; }

# Install-time default (ADR 0011): the switch starts on, so the first core start after
# a node is applied takes the device over. A user's off is an absent file; only the
# installer (fresh install or update) recreates it.
kr_tp_default_on() {
  [ -s "$KR_TP_SWITCH" ] && return 0
  kr_dirs
  printf 'on\n' >"$KR_TP_SWITCH" 2>/dev/null || return 0
  chmod 600 "$KR_TP_SWITCH" 2>/dev/null
  kr_tp_log "tproxy switch defaults to on"
}

# The switch write since ADR 0011: on|off only persists the preference. It is applied
# by the next core start (kr_start_locked), never immediately -- a running core is
# left exactly as it is.
kr_tproxy_set() { # <on|off>
  kr_dirs
  case "$1" in
    on)
      printf 'on\n' >"$KR_TP_SWITCH" 2>/dev/null || {
        echo "could not write $KR_TP_SWITCH" >&2
        return 1
      }
      chmod 600 "$KR_TP_SWITCH" 2>/dev/null
      kr_tp_log "tproxy switch: on (takes effect at the next core start)"
      ;;
    off)
      rm -f "$KR_TP_SWITCH"
      kr_tp_log "tproxy switch: off (takes effect at the next core start)"
      ;;
    *)
      echo "usage: kr_tproxy_set {on|off}" >&2
      return 2
      ;;
  esac
  return 0
}

kr_tp_rules_present() {
  iptables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1 || return 1
  ip6tables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1 || return 1
  return 0
}

# 冲突 detection (docs/adr/0004): a foreign VPN/TUN, an always-on VPN setting or a
# foreign -j TPROXY rule. Heuristic by nature; the docs still say only one
# transparent proxy may be active. Prints the reason and returns 0 on conflict.
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

# One family's rules: <iptables|ip6tables>. The core's own sockets carry the bypass
# mark and return first; DNS to port 53 is marked with the capture mark before the
# bypass ranges so a LAN resolver is captured too (docs/adr/0006); DHCP is bypassed
# before everything, since a proxied DHCP reply never assigns an address.
kr_tp_ipt_rules() { # <binary>
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
    # Deliver to the listener only the packets of LOCAL clients — every captured packet
    # originates from a local source. Everything else on lo is the core's own transparent
    # reply (SYN-ACK, DNS answer, whose source is the ORIGINAL destination): it carries the
    # tproxy-mark inherited from the captured SYN and must flow to normal local delivery —
    # capturing it would steal every answer back into the core and hang every handshake.
    $_i -t mangle -A KR_TP_PREROUTING ! -i lo -j RETURN || return 1
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
    $_i -t mangle -A KR_TP_PREROUTING -s 127.0.0.0/8 -p tcp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    $_i -t mangle -A KR_TP_PREROUTING -s 127.0.0.0/8 -p udp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    _addrs=$(kr_tp_own_addrs $_i)
    for _a in $_addrs; do
      $_i -t mangle -A KR_TP_PREROUTING -s "${_a%/*}" -p tcp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
      $_i -t mangle -A KR_TP_PREROUTING -s "${_a%/*}" -p udp -j TPROXY --on-port $KR_TP_PORT --tproxy-mark $KR_MARK || return 1
    done
  fi

  # The wildcard tproxy listener must not be an open proxy on the LAN (docs/adr/0004).
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

# The device's own addresses (one per line). A tproxy reply goes back to the original
# client address — the device itself — which is not in any fixed bypass range on a
# public-IP device; without this, the reply is captured and loops.
kr_tp_own_addrs() { # <iptables|ip6tables> on stdout
  if [ "$1" = ip6tables ]; then
    ip -6 addr show scope global 2>/dev/null | grep -oE 'inet6 [0-9a-fA-F:]+/[0-9]+' | awk '{print $2}'
  else
    ip -4 addr show 2>/dev/null | grep -oE 'inet [0-9.]+/[0-9]+' | awk '{print $2}'
  fi
}

kr_tp_routes() {
  # Capture path: packets marked by the OUTPUT chain are rerouted over lo into the
  # tproxy listener.
  ip rule del pref $KR_RULE_PREF 2>/dev/null
  ip rule add pref $KR_RULE_PREF fwmark $KR_MARK lookup $KR_TABLE || return 1
  ip route replace local 0.0.0.0/0 dev lo table $KR_TABLE || return 1
  ip -6 rule del pref $KR_RULE_PREF 2>/dev/null
  ip -6 rule add pref $KR_RULE_PREF fwmark $KR_MARK lookup $KR_TABLE || return 1
  ip -6 route replace local ::/0 dev lo table $KR_TABLE || return 1
  # Bypass path: the core's own sockets carry $KR_BYPASS and must NOT enter the capture
  # table (that would loop them back into the core). Android routes the default through
  # a per-network table selected by netd's marks, so the bypass table gets a copy of the
  # current default route. A later network switch is recovered by toggling takeover.
  # It also needs local delivery: tproxy replies go back to the device's own address,
  # and a default-only table would ship them to the gateway and lose them.
  _def4=$(ip route show table all 2>/dev/null | grep -m1 '^default ')
  if [ -z "$_def4" ]; then
    kr_tp_log "no ipv4 default route; cannot build the bypass path"
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
      kr_tp_log "could not copy the ipv6 default route; no v6 bypass"
    fi
  else
    kr_tp_log "no ipv6 default route; the bypass table has no v6 route"
  fi
  return 0
}

# Re-add a default route (from `ip route show table all`) into the bypass table: strip
# the foreign table id and RA/expiry decorations, keep via/dev.
kr_tp_copy_route() { # <4|6> <route line>
  _r=${2#default }
  _via=$(printf '%s\n' "$_r" | sed -n 's/.*via \([^ ]*\).*/\1/p')
  _dev=$(printf '%s\n' "$_r" | sed -n 's/.*dev \([^ ]*\).*/\1/p')
  if [ -n "$_via" ]; then
    ip -$1 route add default via "$_via" dev "$_dev" table $KR_BYPASS_TABLE
  else
    ip -$1 route add default dev "$_dev" table $KR_BYPASS_TABLE
  fi
}

# Install the whole takeover namespace, both families. Any failure removes everything
# again: a half-capture is a silent leak, not a smaller feature (docs/adr/0004).
kr_tp_install() {
  if kr_tp_rules_present; then
    kr_tp_log "takeover rules already present"
    return 0
  fi
  kr_tp_log "installing takeover rules (mark $KR_MARK, table $KR_TABLE, pref $KR_RULE_PREF, port $KR_TP_PORT)"
  if ! kr_tp_ipt_rules iptables; then
    kr_tp_log "iptables rules failed; removing everything again"
    kr_tp_remove
    return 1
  fi
  if ! kr_tp_ipt_rules ip6tables; then
    kr_tp_log "ip6tables rules failed; removing everything again"
    kr_tp_remove
    return 1
  fi
  if ! kr_tp_routes; then
    kr_tp_log "policy routing failed; removing everything again"
    kr_tp_remove
    return 1
  fi
  kr_tp_log "takeover rules installed"
  return 0
}

# Remove exactly our namespace. Every call is tolerant: uninstall and the failure
# paths rely on this succeeding even when nothing was ever installed.
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
  return 0
}

# JSON-escape a value the shell splices into a generated block (today: the node host).
kr_tp_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Resolve the applied node's host with the system resolver. Only safe while the rules
# are OFF (direct network); the result is pinned into the core DNS module's hosts so the
# node connection never depends on an upstream resolver (the bootstrap deadlock, see
# docs/adr/0008). Prints the ip, or nothing when the host is a literal or unresolvable.
kr_tp_resolve_node() {
  _host=$(kr_meta_get host 2>/dev/null)
  case "$_host" in
    *:*) return 0 ;; # an ipv6 literal: nothing to resolve
    *[!0-9.]*) ;; # a domain: resolve it
    *) return 0 ;; # an ipv4 literal
  esac
  _out=$(ping -c1 -W2 "$_host" 2>/dev/null | sed -n 's/^[^(]*(\([0-9.]*\)).*/\1/p' | head -n 1)
  [ -n "$_out" ] && echo "$_out"
}

kr_tp_pin_node() {
  _ip=$(kr_tp_resolve_node)
  if [ -n "$_ip" ]; then
    printf '%s\n' "$_ip" >"$KR_NODEIP"
    chmod 600 "$KR_NODEIP" 2>/dev/null
    kr_tp_log "pinned node address $_ip"
  else
    rm -f "$KR_NODEIP"
    kr_tp_log "could not pre-resolve the node host; bootstrap falls back to the direct DoH rule"
  fi
}

# The takeover JSON blocks spliced into the template placeholders. Authored here, not
# in the UI: inbounds, DNS and routing are module-owned layout (docs/adr/0005).
kr_tp_render_blocks() { # sets KR_TP_INBOUND, KR_DNS_OUTBOUND, KR_DNS_BLOCK, KR_ROUTING
  KR_TP_INBOUND='{"tag":"tp-in","listen":"::","port":'"$KR_TP_PORT"',"protocol":"dokodemo-door","settings":{"network":"tcp,udp","followRedirect":true},"streamSettings":{"sockopt":{"tproxy":"tproxy"}}}'
  KR_DNS_OUTBOUND='{"tag":"dns-out","protocol":"dns","settings":{}}'
  KR_DNS_BLOCK='{"servers":["https://1.1.1.1/dns-query"],"queryStrategy":"UseIPv4"}'
  # The applied node's own hostname resolves through the direct outbound (bootstrap,
  # docs/adr/0006); an IP node needs no exception. Everything else the DNS module asks
  # goes through the proxy.
  _rules='{"inboundTag":["dns"],"outboundTag":"proxy"},{"network":"tcp,udp","port":53,"outboundTag":"dns-out"}'
  _host=$(kr_meta_get host 2>/dev/null)
  case "$_host" in
    *:*) _host="" ;; # an IPv6 literal: nothing to resolve
    *[!0-9.]*) : ;; # a domain: keep the exception
    *) _host="" ;; # an IPv4 literal (digits and dots only): nothing to resolve
  esac
  if [ -n "$_host" ]; then
    _e=$(kr_tp_json_escape "$_host")
    _rules='{"inboundTag":["dns"],"domain":["full:'$_e'"],"outboundTag":"direct"},'$_rules
  fi
  KR_ROUTING='{"domainStrategy":"AsIs","rules":['$_rules']}'
  # A pinned node address removes the bootstrap dependence on any upstream resolver:
  # the DNS module answers the node domain from hosts without asking anyone.
  _nodeip=$(cat "$KR_NODEIP" 2>/dev/null)
  if [ -n "$_host" ] && [ -n "$_nodeip" ]; then
    KR_DNS_BLOCK='{"servers":["https://1.1.1.1/dns-query"],"queryStrategy":"UseIPv4","hosts":{"full:'$_e'":"'$_nodeip'"}}'
  fi
  return 0
}

# Engage takeover for a core start with the switch on (called from kr_start_locked
# after the applied-node gate; ADR 0011 couples takeover to the core's start). The
# config on disk may be stale relative to the switch, so it is re-rendered to match --
# a takeover-form config without rules loses routing, and rules without a tproxy
# listener blackhole traffic. Never fails: a conflict or a rule failure degrades to
# the idle form and a failed/* phase, and the caller still starts the core.
kr_tp_engage() {
  _applied=$(kr_applied_id) || _applied=""
  if [ -z "$_applied" ] || [ "$(kr_meta_get id 2>/dev/null)" != "$_applied" ] || [ ! -s "$KR_OUTBOUND" ]; then
    # No usable outbound: nothing to capture into, so the rules must not go up.
    # ADR 0011 supersedes the boot-time rules-without-node install of ADR 0004/0008:
    # with the switch defaulting on, that path would take a freshly installed
    # device's traffic hostage until a node is applied. The start gate (ADR 0010)
    # keeps the core down; the rules wait with it.
    kr_tp_log "engage: no usable outbound for the applied node; takeover skipped"
    return 0
  fi
  _why=$(kr_tp_conflict) || _why=""
  if [ -n "$_why" ]; then
    kr_tp_log "engage: conflict, takeover not enforced: $_why"
    kr_tp_swap_config 0 "$KR_OUTBOUND" || kr_tp_log "engage: could not rewrite the config for the conflict path"
    KR_TP_PHASE=failed/conflict
    kr_status_write stopped failed/conflict
    return 0
  fi
  # Resolve while the network is still direct; the rules are not up yet.
  kr_tp_pin_node
  if ! kr_tp_install; then
    kr_tp_log "engage: rule install failed, takeover not enforced"
    kr_tp_swap_config 0 "$KR_OUTBOUND" || kr_tp_log "engage: could not rewrite the config after the rule failure"
    KR_TP_PHASE=failed/rules
    kr_status_write stopped failed/rules
    return 0
  fi
  if ! kr_tp_swap_config 1 "$KR_OUTBOUND"; then
    kr_tp_log "engage: takeover config failed to test; removing the rules, keeping the switch"
    kr_tp_remove
    # The switch is a preference and is never silently rewritten (ADR 0011); the next
    # start retries. The on-disk config may still be takeover-form; a marked node
    # outbound with no rules loses routing, so force the no-takeover form.
    kr_tp_swap_config 0 "$KR_OUTBOUND" || kr_tp_log "engage: could not rewrite the config to the no-takeover form"
    return 0
  fi
  KR_TP_PHASE=idle
  kr_tp_log "engage: takeover rules installed before the core starts"
  return 0
}

# Render + test + atomically swap config.json without touching a running core.
# Used at boot, where the core starts afterwards (fail-closed ordering).
kr_tp_swap_config() { # <0|1 takeover> <outbound-file>
  _tmp=$KR_RUNDIR/config.new.json
  if ! KR_TAKEOVER=$1 kr_render_config "$2" >"$_tmp"; then
    rm -f "$_tmp"
    return 1
  fi
  chmod 600 "$_tmp" 2>/dev/null
  if ! "$(kr_core)" run -test -c "$_tmp" >>"$KR_LOG" 2>&1; then
    rm -f "$_tmp"
    kr_tp_log "config test failed for the takeover=$1 candidate"
    return 1
  fi
  if ! mv -f "$_tmp" "$KR_CONF"; then
    rm -f "$_tmp"
    return 1
  fi
  chmod 600 "$KR_CONF" 2>/dev/null
  return 0
}

kr_tproxy_status() {
  kr_tp_switch_on && echo "switch=on" || echo "switch=off"
  kr_tp_rules_present && echo "rules=present" || echo "rules=absent"
  return 0
}
