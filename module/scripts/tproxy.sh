# shellcheck shell=ash
# TPROXY takeover: the rules that make device traffic enter the core, the conflict
# checks that refuse to share them with a foreign VPN, and the persisted switch.
# Sourced by kernelray.sh, which provides the kr_* helpers and paths.
#
# Implements docs/adr/0004 (module-owned, opt-in, fail-closed takeover), docs/adr/0006
# (DNS through the core's DNS module) and docs/adr/0008 (namespace values, boot and
# toggle semantics). The namespace — capture fwmark 19283, bypass fwmark 19282, routing
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

# The persisted takeover switch (接管开关): presence of the file is the user's choice.
# Off is the default; the module never creates it on its own.
kr_tp_switch_on() { [ -s "$KR_TP_SWITCH" ]; }

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

# Boot with the switch on (service.sh, before kr_start). The config on disk may be
# stale relative to the switch, so it is re-rendered to match — a takeover-form config
# without rules loses routing, and rules without a tproxy listener blackhole traffic.
kr_tp_boot() {
  kr_tp_log "boot: takeover switch is on"
  _applied=$(kr_applied_id) || _applied=""
  _ob=""
  if [ -n "$_applied" ] && [ "$(kr_meta_get id 2>/dev/null)" = "$_applied" ] && [ -s "$KR_OUTBOUND" ]; then
    _ob=$KR_OUTBOUND
  fi
  if [ -z "$_ob" ]; then
    # No applied node: there is no config to render, and the start gate keeps the core
    # down (ADR 0010). The switch stays on (intent is never rewritten) and the rules go
    # in anyway -- fail-closed (ADR 0004): with the switch on, skipping the rules would
    # leak direct traffic until a node is applied.
    _why=$(kr_tp_conflict) || _why=""
    if [ -n "$_why" ]; then
      kr_tp_log "boot: no applied node and a conflict ($_why); takeover not enforced"
      return 0
    fi
    if ! kr_tp_install; then
      kr_tp_log "boot: no applied node and the rule install failed; takeover not enforced"
      return 0
    fi
    kr_tp_log "boot: no applied node; rules up, the core stays down until a node is applied"
    return 0
  fi
  _why=$(kr_tp_conflict) || _why=""
  if [ -n "$_why" ]; then
    kr_tp_log "boot: conflict, takeover not enforced: $_why"
    kr_tp_swap_config 0 "$_ob" || kr_tp_log "boot: could not rewrite the config for the conflict path"
    KR_TP_PHASE=failed/conflict
    kr_status_write stopped failed/conflict
    return 0
  fi
  # Resolve while the network is still direct; the rules are not up yet.
  kr_tp_pin_node
  if ! kr_tp_install; then
    kr_tp_log "boot: rule install failed, takeover not enforced"
    kr_tp_swap_config 0 "$_ob" || kr_tp_log "boot: could not rewrite the config after the rule failure"
    KR_TP_PHASE=failed/rules
    kr_status_write stopped failed/rules
    return 0
  fi
  if ! kr_tp_swap_config 1 "$_ob"; then
    kr_tp_log "boot: takeover config failed to test; removing rules and the switch"
    kr_tp_remove
    rm -f "$KR_TP_SWITCH"
    # The on-disk config may still be takeover-form from the previous session; a
    # marked node outbound with no rules loses routing, so force the no-takeover form.
    kr_tp_swap_config 0 "$_ob" || kr_tp_log "boot: could not rewrite the config to the no-takeover form"
    return 0
  fi
  KR_TP_PHASE=idle
  kr_tp_log "boot: takeover ready, rules installed before the core starts"
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

kr_tproxy_on() {
  kr_dirs
  if kr_tp_switch_on && kr_tp_rules_present; then
    kr_tp_log "takeover already on"
    return 0
  fi
  if ! kr_core_works; then
    kr_tp_log "takeover on refused: core missing or not executable"
    echo "core missing or not executable" >&2
    return 1
  fi
  _applied=$(kr_applied_id) || _applied=""
  if [ -z "$_applied" ]; then
    kr_tp_log "takeover on refused: no applied node"
    echo "apply a node first: there is no outbound to capture into" >&2
    return 1
  fi
  if [ "$(kr_meta_get id 2>/dev/null)" != "$_applied" ] || [ ! -s "$KR_OUTBOUND" ]; then
    kr_tp_log "takeover on refused: outbound does not match applied node $_applied"
    echo "outbound.json does not match the applied node; re-tap the node in the WebUI" >&2
    return 1
  fi
  _why=$(kr_tp_conflict) || _why=""
  if [ -n "$_why" ]; then
    kr_tp_log "takeover on refused: conflict: $_why"
    kr_status_write "$(kr_running && echo running || echo stopped)" failed/conflict
    echo "conflict: $_why" >&2
    return 1
  fi
  # Pin the node address while the network is still direct (rules not installed yet):
  # the takeover config's DNS module gets a hosts entry, so the node connection never
  # depends on an upstream resolver.
  kr_tp_pin_node
  _tmp=$KR_RUNDIR/config.new.json
  if ! KR_TAKEOVER=1 kr_render_config "$KR_OUTBOUND" >"$_tmp"; then
    rm -f "$_tmp"
    echo "could not render the takeover config" >&2
    return 1
  fi
  chmod 600 "$_tmp" 2>/dev/null
  if ! "$(kr_core)" run -test -c "$_tmp" >>"$KR_LOG" 2>&1; then
    rm -f "$_tmp"
    kr_tp_log "takeover on: config test failed"
    echo "config test failed (see $KR_LOG)" >&2
    return 1
  fi
  # Rules first: the window between install and core start drops traffic instead of
  # leaking it (docs/adr/0004). An install failure is the one leak path; report it.
  if ! kr_tp_install; then
    kr_status_write "$(kr_running && echo running || echo stopped)" failed/rules
    echo "could not install the takeover rules (see $KR_TPLOG)" >&2
    return 1
  fi
  printf 'on\n' >"$KR_TP_SWITCH"
  chmod 600 "$KR_TP_SWITCH" 2>/dev/null
  _was=0
  kr_running && _was=1
  _prev=$KR_RUNDIR/config.json.prev
  [ -f "$KR_CONF" ] && cp -f "$KR_CONF" "$_prev" 2>/dev/null
  [ "$_was" = 1 ] && kr_stop
  if ! mv -f "$_tmp" "$KR_CONF"; then
    rm -f "$_tmp"
    kr_tp_log "takeover on: could not replace the config; rules removed again"
    kr_tp_remove
    rm -f "$KR_TP_SWITCH"
    [ "$_was" = 1 ] && kr_start
    echo "could not replace the config" >&2
    return 1
  fi
  chmod 600 "$KR_CONF" 2>/dev/null
  # One gesture: the core comes up with the takeover config, whatever it did before.
  if ! kr_start; then
    kr_tp_log "takeover on: the core did not start; rolling back"
    if [ -f "$_prev" ]; then
      mv -f "$_prev" "$KR_CONF"
      chmod 600 "$KR_CONF" 2>/dev/null
    else
      rm -f "$KR_CONF"
    fi
    kr_tp_remove
    rm -f "$KR_TP_SWITCH"
    if kr_start; then
      echo "the takeover config failed to start; previous config restored, rules removed" >&2
    else
      echo "the takeover config failed to start; the core is down and rules are removed" >&2
    fi
    return 1
  fi
  rm -f "$_prev"
  kr_tp_log "takeover on"
  return 0
}

kr_tproxy_off() {
  kr_dirs
  if ! kr_tp_switch_on && ! kr_tp_rules_present; then
    kr_tp_log "takeover already off"
    return 0
  fi
  # Rules go first: the core keeps running for now, but the moment they are gone its
  # marked sockets lose routing anyway. Tearing down is the intended direction.
  kr_tp_remove
  rm -f "$KR_TP_SWITCH"
  _applied=$(kr_applied_id) || _applied=""
  _ob=""
  if [ -n "$_applied" ] && [ "$(kr_meta_get id 2>/dev/null)" = "$_applied" ] && [ -s "$KR_OUTBOUND" ]; then
    _ob=$KR_OUTBOUND
  fi
  if [ -z "$_ob" ]; then
    # The applied bookkeeping is broken: no config can be re-rendered, and the one on
    # disk is takeover-form whose marked outbound loses routing without the rules. The
    # core stops and the unrunnable derived config is dropped; re-tapping the node
    # rebuilds everything (ADR 0010).
    kr_tp_log "takeover off: applied id $_applied has no matching outbound; stopping"
    kr_running && kr_stop
    rm -f "$KR_CONF" "$KR_APPLIED"
    kr_status_write stopped no-node
    echo "outbound.json does not match the applied node; the core is stopped, re-tap the node in the WebUI" >&2
    return 1
  fi
  _tmp=$KR_RUNDIR/config.new.json
  if ! KR_TAKEOVER=0 kr_render_config "$_ob" >"$_tmp"; then
    rm -f "$_tmp"
    echo "could not render the config" >&2
    return 1
  fi
  chmod 600 "$_tmp" 2>/dev/null
  if ! "$(kr_core)" run -test -c "$_tmp" >>"$KR_LOG" 2>&1; then
    # The applied outbound no longer tests. The takeover-form config on disk must not
    # survive either (its mark has no rules now); drop the config and the applied id
    # and stop -- re-tapping the node rebuilds everything (ADR 0010).
    rm -f "$_tmp"
    kr_tp_log "takeover off: the applied outbound no longer tests; stopping"
    kr_running && kr_stop
    rm -f "$KR_CONF" "$KR_APPLIED"
    kr_status_write stopped no-node
    echo "the applied outbound no longer tests; the core is stopped, re-tap the node in the WebUI" >&2
    return 1
  fi
  _was=0
  kr_running && _was=1
  [ "$_was" = 1 ] && kr_stop
  if [ -n "$_tmp" ]; then
    if ! mv -f "$_tmp" "$KR_CONF"; then
      rm -f "$_tmp"
      [ "$_was" = 1 ] && kr_start
      echo "could not replace the config" >&2
      return 1
    fi
    chmod 600 "$KR_CONF" 2>/dev/null
  fi
  if [ "$_was" = 1 ]; then
    if ! kr_start; then
      kr_tp_log "takeover off: the core did not restart"
      echo "the core did not restart (see $KR_LOG)" >&2
      return 1
    fi
  else
    kr_status_write stopped idle
  fi
  kr_tp_log "takeover off"
  return 0
}

kr_tproxy_status() {
  kr_tp_switch_on && echo "switch=on" || echo "switch=off"
  kr_tp_rules_present && echo "rules=present" || echo "rules=absent"
  return 0
}
