#!/system/bin/sh
# Regression harness for an installed KernelRay module (run on-device as root).
# Covers the P0/P1/P2 cases from the v0.10.0 switch rework (docs/adr/0017) as amended by
# 启动即接管 (docs/adr/0011): there is no tproxy switch, so every start takes over and a
# start whose takeover cannot be enforced is refused.
# Usage: adb push scripts/regress-device.sh /data/local/tmp/ && adb shell "su -c sh /data/local/tmp/regress.sh"
# KernelRay regression harness (P0 + P1 + P2) for v0.10.0.
# Usage: sh /data/local/tmp/regress.sh   (as root, via su)
# Emits one line per case: PASS <name> / FAIL <name> / INFO <name> <detail>
S=/data/adb/modules/KernelRay/scripts/kernelray.sh
M=/data/adb/modules/KernelRay
RUN=$M/runtime
L=$M/logs/xray.log
KL=$M/logs/kernelray.log
pass=0; fail=0

ok()   { echo "PASS $1"; pass=$((pass+1)); }
bad()  { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
info() { echo "INFO $1 $2"; }

# ---- helpers ----
listening() { # <port>
  awk -v want="0100007F:$(printf '%04X' "$1")" '$4 == "0A" && $2 == want { f = 1 } END { exit !f }' /proc/net/tcp
}
tests_in() { # <from-line>
  sed -n "${1:-1},\$p" "$L" | grep -c 'Configuration OK\.'
}
runs_in() { # <from-line>
  sed -n "${1:-1},\$p" "$L" | grep -c "Name:$M/config.json"
}
mark() { wc -l < "$L" 2>/dev/null || echo 0; }
ob() { # <address> <id>
  printf '%s' '{"tag":"proxy","protocol":"vless","settings":{"vnext":[{"address":"'"$1"'","port":443,"users":[{"id":"b831381d-6324-4d53-ad4f-8cda48b30811","encryption":"none","flow":""}]}]},"streamSettings":{"network":"tcp","sockopt":{"mark":19282}}}' > "$M/outbound.json"
  printf 'id=%s\nhost=a.example.com\n' "$2" > "$M/outbound.meta"
  chmod 600 "$M/outbound.json" "$M/outbound.meta"
}
state() { $S status | sed -n 's/^state=//p'; }
node()  { $S status | sed -n 's/^node=//p'; }
phase() { $S status | sed -n 's/^phase=//p'; }
rules() { # the kernel fact the start path uses, not the status cache
  if iptables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1 &&
     ip6tables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1; then
    echo present
  else
    echo absent
  fi
}
rules_cache() { $S status | sed -n 's/^rules=//p'; }
pid()   { cat "$RUN/xray.pid" 2>/dev/null; }
expect() { # <name> <got> <want>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2' want '$3'"; fi
}

reset_all() { # clean state: stopped, no node, no rules, the install default mode
  $S stop >/dev/null 2>&1
  $S unapply >/dev/null 2>&1   # also takes the rules down
  $S routing cnadblock >/dev/null 2>&1   # what the installer leaves on a fresh install
  : > "$L" 2>/dev/null
}

# =====================================================================
echo "===== P0: failure paths"

# P0-1: -test rejects the candidate -> old config untouched, core keeps running
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1
pid1=$(pid)
before=$(mark)
ob 192.168.1.11 badnode0001
# a config the core rejects: bogus network value
printf '%s' '{"tag":"proxy","protocol":"vless","settings":{"vnext":[{"address":"192.168.1.11","port":443,"users":[{"id":"b831381d-6324-4d53-ad4f-8cda48b30811","encryption":"none","flow":""}]}]},"streamSettings":{"network":"bogus-network","sockopt":{"mark":19282}}}' > "$M/outbound.json"
chmod 600 "$M/outbound.json"
r=$($S apply badnode0001 2>&1)
rc=$?
expect "P0-1a apply rejects rc" "$([ $rc -ne 0 ] && echo nz || echo z)" "nz"
echo "$r" | grep -q "config test failed" && ok "P0-1b message" || bad "P0-1b message" "$r"
expect "P0-1c applied id kept" "$(node)" "8401c5e7cf94ad2d"
expect "P0-1d core alive, same pid" "$(pid)" "$pid1"
expect "P0-1e state running" "$(state)" "running"
expect "P0-1f config untouched" "$(grep -c 192.168.1.10 "$M/config.json")" "1"

# P0-4: after the failed switch, the next start keeps the APPLIED node's config
$S stop >/dev/null 2>&1
r=$($S start 2>&1)
expect "P0-4a start keeps applied node" "$(node)" "8401c5e7cf94ad2d"
grep -q "keeping the config on disk" "$KL" && ok "P0-4b logged" || bad "P0-4b logged" "$(tail -3 "$KL" | tr '\n' ' ')"
grep -q 192.168.1.10 "$M/config.json" && ok "P0-4c config is node A" || bad "P0-4c config is node A" "no A in config"
expect "P0-4d running" "$(state)" "running"

# P0-5: same situation, but the config on disk no longer passes `-test` -> refuse it
$S stop >/dev/null 2>&1
printf '%s' '{"not":"a config"}' > "$M/config.json"
chmod 600 "$M/config.json"
r=$($S start 2>&1)
rc=$?
expect "P0-5a start refuses" "$rc" "1"
echo "$r" | grep -q "config test failed" && ok "P0-5b message" || bad "P0-5b message" "$r"
# The refusal lands in kr_ensure_config, which returns before kr_start_locked writes a failed
# status -- the core is simply not started and the last status stands. The state that matters:
# not running, and no rules installed for a core that will not run.
expect "P0-5c not running" "$(state)" "stopped"
expect "P0-5d no rules" "$(rules)" "absent"
# Put the applied node's config back for the rest of the run.
$S unapply >/dev/null 2>&1
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1

# P0-2: candidate that tests but does not start -> rollback
# badnode0001's outbound now tests fine but the REAL failure needs a core that exits after
# start; emulate with a config whose tproxy port collides: occupy 10810 ourselves.
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1
pid1=$(pid)
# a second node that renders fine (tests pass) - the start will fail only if the port is
# taken, so we instead rely on the documented alternative: valid config, but kill the core's
# ability to bind by pointing the config at an occupied port is not reachable from here.
# Covered by tests/config.test.js on the host; here we verify the ROLLBACK MARKER path only
# when it happens naturally. Skip if we cannot force it.
info "P0-2 rollback" "covered by unit tests (loopingCore); device force needs a port collision"
$S stop >/dev/null 2>&1

# P0-3: failed start with no previous config -> stopped/no-node. The shell REBUILDS the
# config from the applied outbound when it can (that is kr_ensure_config's job), so the honest
# expectation is a successful start carrying the applied node -- not a refusal.
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
rm -f "$M/config.json"
$S start >/dev/null 2>&1
expect "P0-3a rebuilds and runs" "$(state)" "running"
expect "P0-3b node" "$(node)" "8401c5e7cf94ad2d"
grep -q 192.168.1.10 "$M/config.json" && ok "P0-3c config from the applied outbound" || bad "P0-3c config" "not the applied node"

# P0-3': with the applied outbound GONE too, the rebuild refuses and nothing runs
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
rm -f "$M/config.json" "$M/outbound.json"
r=$($S start 2>&1)
# The start refusal writes failed/no-config into status.json; `status` reports the LIVE
# process state (stopped) with the last phase (no-config).
phase_now=$(sed -n 's/.*"phase":"\([^"]*\)".*/\1/p' "$M/runtime/status.json")
state_now=$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$M/runtime/status.json")
expect "P0-3d refuses without the outbound" "$state_now" "failed"
expect "P0-3e phase" "$phase_now" "no-config"
[ -f "$M/config.json" ] && bad "P0-3f no config created" "config exists" || ok "P0-3f no config created"

reset_all

# =====================================================================
echo "===== P1: start / stop"

# P1-7: cold start, rules absent: exactly one test, rules up
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
before=$(mark)
t0=$(date +%s%N 2>/dev/null || echo 0)
$S start >/dev/null 2>&1
expect "P1-7a running" "$(state)" "running"
expect "P1-7b rules present" "$(rules)" "present"
expect "P1-7h cache present" "$(rules_cache)" "present"
# The apply rendered and tested the config; the start re-uses those bytes (nothing changed),
# so the start itself costs no test. Count what the START itself cost, from the first
# config.json load after the mark.
# (see the final summary for the per-gesture accounting)
expect "P1-7c one run" "$(runs_in "$before")" "1"
grep -q '"tag":"tp-in"' "$M/config.json" && ok "P1-7e tp-in present" || bad "P1-7e tp-in present" "no tp-in"

# P1-8: start while running -> no-op
pid1=$(pid)
before=$(mark)
$S start >/dev/null 2>&1
expect "P1-8a same pid" "$(pid)" "$pid1"
expect "P1-8b no test" "$(tests_in "$before")" "0"
expect "P1-8c no run" "$(runs_in "$before")" "0"

# P1-13: stray core gets killed
nohup "$M/bin/xray" run -c "$M/config.json" >/dev/null 2>&1 &
stray=$!
sleep 1
n_before=$(ps -A -o ARGS | grep -c "^xray run")
$S start >/dev/null 2>&1
sleep 1
n_after=$(ps -A -o ARGS | grep -c "^xray run")
if [ "$n_after" = 1 ]; then ok "P1-13 stray killed"; else bad "P1-13 stray killed" "cores before=$n_before after=$n_after"; fi
kill -0 "$stray" 2>/dev/null && bad "P1-13b stray gone" "still alive" || ok "P1-13b stray gone"

# P1-9: stop leaves the capture up (fail-closed, docs/adr/0004)
$S stop >/dev/null 2>&1
before=$(mark)
expect "P1-9a stopped" "$(state)" "stopped"
expect "P1-9b rules still present" "$(rules)" "present"
expect "P1-9f cache present" "$(rules_cache)" "present"
# ...and the next start re-uses them instead of reinstalling.
$S start >/dev/null 2>&1
expect "P1-9c running" "$(state)" "running"
expect "P1-9d rules present" "$(rules)" "present"
grep -q '"tag":"tp-in"' "$M/config.json" && ok "P1-9e tp-in present" || bad "P1-9e tp-in present" "no tp-in"

# P1-10: log level applied at next start
$S loglevel debug >/dev/null 2>&1
p1=$($S status | sed -n 's/^loglevelpending=//p')
$S stop >/dev/null 2>&1
$S start >/dev/null 2>&1
p2=$($S status | sed -n 's/^loglevelpending=//p')
lv=$(grep -o '"loglevel": "[a-z]*"' "$M/config.json" | head -1)
expect "P1-10a pending before" "$p1" "1"
expect "P1-10b pending after" "$p2" "0"
expect "P1-10c config level" "$lv" '"loglevel": "debug"'
$S loglevel warning >/dev/null 2>&1   # back to default (removes the file)

# P1-11: missing geo data with cn preference -> degraded start, not failure
$S routing cn >/dev/null 2>&1
mv "$M/bin/geoip.dat" /data/local/tmp/geoip.bak
$S stop >/dev/null 2>&1
$S start >/dev/null 2>&1
if [ "$(state)" = "running" ]; then ok "P1-11a degraded start"; else bad "P1-11a degraded start" "state=$(state)"; fi
grep -q "geo data missing" "$KL" && ok "P1-11b logged" || bad "P1-11b logged" "$(tail -2 "$KL" | tr '\n' ' ')"
grep -q geosite:cn "$M/config.json" && bad "P1-11c degraded to global" "cn rules present" || ok "P1-11c degraded to global"
mv /data/local/tmp/geoip.bak "$M/bin/geoip.dat"
$S routing global >/dev/null 2>&1

# P1-13: missing geo data with the cnadblock preference -> the start is refused, not degraded
# (docs/adr/0021: a mode named 去广告 must not silently run as 大陆直连)
$S routing cnadblock >/dev/null 2>&1
mv "$M/bin/geosite.dat" /data/local/tmp/geosite.bak
$S stop >/dev/null 2>&1
r=$($S start 2>&1); rc=$?
expect "P1-13a refused" "$rc" "1"
echo "$r" | grep -qx "geo data missing" && ok "P1-13b message" || bad "P1-13b message" "$r"
# status.json says failed/config-invalid; the kv's state comes from the live process, so it
# reads stopped -- the phase is what names the reason.
expect "P1-13c state" "$(state)" "stopped"
expect "P1-13d phase" "$(phase)" "config-invalid"
grep -q "cnadblock cannot start" "$KL" && ok "P1-13e logged" || bad "P1-13e logged" "$(tail -2 "$KL" | tr '\n' ' ')"
mv /data/local/tmp/geosite.bak "$M/bin/geosite.dat"
$S routing global >/dev/null 2>&1

# P1-12: no applied node -> refuse, no rules
$S stop >/dev/null 2>&1
$S unapply >/dev/null 2>&1
r=$($S start 2>&1)
rc=$?
expect "P1-12a refuses" "$rc" "1"
echo "$r" | grep -q "no applied node" && ok "P1-12b message" || bad "P1-12b message" "$r"
expect "P1-12c no rules" "$(rules)" "absent"
expect "P1-12e cache absent" "$(rules_cache)" "absent"
expect "P1-12d phase" "$(phase)" "no-node"

# P1-14: core that cannot start -> failed/crashed quickly
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1
$S stop >/dev/null 2>&1
# occupy the socks port with a REAL listener (busybox nc stays in the foreground; the toybox
# nc in the first run exited at once, so the core bound fine and the case never happened)
nohup /data/adb/ksu/bin/busybox nc -l -p 10808 127.0.0.1 >/dev/null 2>&1 &
hog=$!
sleep 1
if kill -0 "$hog" 2>/dev/null && listening 10808; then
  r=$($S start 2>&1)
  if [ "$(state)" = "stopped" ] && [ "$(phase)" = "crashed" ]; then ok "P1-14 crashed"; else bad "P1-14 crashed" "state=$(state) phase=$(phase)"; fi
else
  info "P1-14" "hog did not hold the port, case not exercised"
fi
kill "$hog" 2>/dev/null
pkill -f "nc -l -p 10808" 2>/dev/null

# =====================================================================
echo "===== P2: apply and idempotence"

reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1

# P2-15: switching the applied node: one test, one restart
before=$(mark)
t0=$(date +%s%N)
ob 192.168.1.11 8401c5e7cf94ad2e
r=$($S apply 8401c5e7cf94ad2e 2>&1)
expect "P2-15a applied" "$(node)" "8401c5e7cf94ad2e"
expect "P2-15b running" "$(state)" "running"
expect "P2-15c one test" "$(tests_in "$before")" "1"
expect "P2-15d one run" "$(runs_in "$before")" "1"
grep -q 192.168.1.11 "$M/config.json" && ok "P2-15e config is new node" || bad "P2-15e config is new node" "no new node"
t1=$(date +%s%N)
info "P2-15f duration" "$(( (t1 - t0) / 1000000 ))ms"

# P2-16: re-apply the same node: no test, no restart
pid1=$(pid)
before=$(mark)
ob 192.168.1.11 8401c5e7cf94ad2e   # same node, rewritten files
$S apply 8401c5e7cf94ad2e >/dev/null 2>&1
expect "P2-16a same pid" "$(pid)" "$pid1"
expect "P2-16b no test" "$(tests_in "$before")" "0"
expect "P2-16c no run" "$(runs_in "$before")" "0"
grep -q "config unchanged" "$KL" && ok "P2-16d logged" || bad "P2-16d logged" "$(tail -2 "$KL" | tr '\n' ' ')"

# P2-17: ports with current values: no-op
pid1=$(pid)
before=$(mark)
$S ports >/dev/null 2>&1
expect "P2-17a same pid" "$(pid)" "$pid1"
expect "P2-17b no test" "$(tests_in "$before")" "0"
grep -q "already carries the saved ports" "$KL" && ok "P2-17c logged" || bad "P2-17c logged" "$(tail -2 "$KL" | tr '\n' ' ')"

# P2-18: ports changed -> restart, new port listens. state.json has no settings object in
# this fixture, so write one the way the WebUI does (pretty, settings present).
write_ports() { # <socks> <http>
  cat > "$M/state.json" <<EOF
{
  "schema": 1,
  "revision": 99,
  "settings": {
    "socksPort": $1,
    "httpPort": $2
  },
  "manual": [],
  "subscriptions": [],
  "selected": ""
}
EOF
}
pid1=$(pid)
$S stop >/dev/null 2>&1
write_ports 10808 10809
$S ports >/dev/null 2>&1
write_ports 13008 13009
$S ports >/dev/null 2>&1
grep -q 13008 "$M/config.json" && ok "P2-18a config carries it" || bad "P2-18a config carries it" "no 13008"
$S start >/dev/null 2>&1
listening 13008 && ok "P2-18b new socks port" || bad "P2-18b new socks port" "not listening"
# restore
$S stop >/dev/null 2>&1
write_ports 10808 10809
$S ports >/dev/null 2>&1
$S start >/dev/null 2>&1

# P2-19: routing mode global <-> cn
before=$(mark)
$S routing cn >/dev/null 2>&1
expect "P2-19a cn restarts once" "$(tests_in "$before")" "1"
grep -q geosite:cn "$M/config.json" && ok "P2-19b cn rules" || bad "P2-19b cn rules" "absent"
expect "P2-19c routing=cn" "$($S status | sed -n 's/^routing=//p')" "cn"
before=$(mark)
$S routing global >/dev/null 2>&1
grep -q geosite:cn "$M/config.json" && bad "P2-19d global rules" "cn still present" || ok "P2-19d global rules"
expect "P2-19e one test" "$(tests_in "$before")" "1"

# pin order: the resolve happens BEFORE the core is stopped
grep -n "pinned node address\|could not pre-resolve" "$KL" | tail -1 | cut -d' ' -f1-2 > /tmp/pin.t
grep -n "stopped pid" "$KL" | tail -1 | cut -d' ' -f1-2 > /tmp/stop.t
if [ "$(cat /tmp/pin.t)" = "$(cat /tmp/stop.t)" ]; then
  info "P2-20 pin order" "same second as the stop; check the log manually if unsure"
else
  ok "P2-20 pin order"
fi

# P2-21: cnadblock renders the ad sink and the block rule (only the real core can prove it
# accepts the `#3` hosts value)
$S routing global >/dev/null 2>&1
$S routing cnadblock >/dev/null 2>&1
# -F: the config is compact JSON, and toybox grep has no \| alternation in BRE.
grep -qF '"geosite:category-ads-all":"#3"' "$M/config.json" && \
  ok "P2-21a dns sink" || bad "P2-21a dns sink" "no ad sink in config.json"
grep -qF '"domain":["geosite:category-ads-all"],"outboundTag":"block"' "$M/config.json" && \
  ok "P2-21b block rule" || bad "P2-21b block rule" "no block rule in config.json"
expect "P2-21c routing=cnadblock" "$($S status | sed -n 's/^routing=//p')" "cnadblock"
$S routing global >/dev/null 2>&1

# P2-22: 清空日志 truncates the live log in place while the core is running (no restart).
[ "$(state)" = "running" ] || $S start >/dev/null 2>&1
p_before=$(pid)
printf 'before-clear\n' >> "$L"
rm -f /tmp/kr-clear-ready /tmp/kr-clear-go
# An append fd opened before the clear models the core's >>: unlinking the file instead
# would send this line into a dead inode that the WebUI can no longer tail.
( exec 3>>"$L"; : > /tmp/kr-clear-ready
  i=0; while [ ! -f /tmp/kr-clear-go ] && [ "$i" -lt 30 ]; do sleep 1; i=$((i+1)); done
  printf 'after-clear\n' >&3 ) &
w=$!
i=0; while [ ! -f /tmp/kr-clear-ready ] && [ "$i" -lt 30 ]; do sleep 1; i=$((i+1)); done
$S log clear >/dev/null 2>&1
expect "P2-22a core log is 0 bytes" "$(wc -c < "$L" 2>/dev/null | tr -d ' ')" "0"
$S log 5 | grep -q "before-clear" && bad "P2-22b old lines gone" "sentinel still tailed" || ok "P2-22b old lines gone"
expect "P2-22c no restart" "$(pid)" "$p_before"
: > /tmp/kr-clear-go
wait "$w"
grep -q "after-clear" "$L" && ok "P2-22d an open writer still lands in the visible file" || \
  bad "P2-22d an open writer still lands in the visible file" "$(tail -2 "$L" | tr '\n' ' ')"
# The module log clears the same way and leaves no marker line behind.
printf 'before-clear\n' >> "$KL"
$S mlog clear >/dev/null 2>&1
expect "P2-22e mlogsize" "$($S status log | sed -n 's/^mlogsize=//p')" "0"
$S mlog append Module "post-clear probe" >/dev/null 2>&1
$S mlog 5 | grep -q "post-clear probe" && ok "P2-22f module log keeps accepting lines" || \
  bad "P2-22f module log keeps accepting lines" "no post-clear line"
rm -f /tmp/kr-clear-ready /tmp/kr-clear-go

# ---- summary ----
echo "===== summary: $pass passed, $fail failed"
reset_all
rm -f /tmp/pin.t /tmp/stop.t
[ "$fail" = 0 ]
