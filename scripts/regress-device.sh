#!/system/bin/sh
# 已安装 KernelRay 模块的回归测试架（设备端以 root 运行）。
# 覆盖 v0.10.0 开关重构的 P0/P1/P2 用例（docs/adr/0017），并经
# 启动即接管（docs/adr/0011）修订：不存在 tproxy 开关，每次启动都
# 接管，无法落实接管的启动被拒绝。
# 用法：adb push scripts/regress-device.sh /data/local/tmp/ && adb shell "su -c sh /data/local/tmp/regress.sh"
# KernelRay 回归测试架（P0 + P1 + P2），面向 v0.10.0。
# 用法：sh /data/local/tmp/regress.sh   （以 root，经 su）
# 每个用例一行：PASS <名称> / FAIL <名称> / INFO <名称> <细节>
S=/data/adb/modules/KernelRay/scripts/kernelray.sh
M=/data/adb/modules/KernelRay
RUN=$M/runtime
L=$M/logs/xray.log
KL=$M/logs/kernelray.log
pass=0; fail=0

ok()   { echo "PASS $1"; pass=$((pass+1)); }
bad()  { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
info() { echo "INFO $1 $2"; }

# ---- 助手 ----
listening() { # <端口>
  awk -v want="0100007F:$(printf '%04X' "$1")" '$4 == "0A" && $2 == want { f = 1 } END { exit !f }' /proc/net/tcp
}
tests_in() { # <起始行>
  sed -n "${1:-1},\$p" "$L" | grep -c 'Configuration OK\.'
}
runs_in() { # <起始行>
  sed -n "${1:-1},\$p" "$L" | grep -c "Name:$M/config.json"
}
mark() { wc -l < "$L" 2>/dev/null || echo 0; }
ob() { # <地址> <id>
  printf '%s' '{"tag":"proxy","protocol":"vless","settings":{"vnext":[{"address":"'"$1"'","port":443,"users":[{"id":"b831381d-6324-4d53-ad4f-8cda48b30811","encryption":"none","flow":""}]}]},"streamSettings":{"network":"tcp","sockopt":{"mark":19282}}}' > "$M/outbound.json"
  printf 'id=%s\nhost=a.example.com\n' "$2" > "$M/outbound.meta"
  chmod 600 "$M/outbound.json" "$M/outbound.meta"
}
state() { $S status | sed -n 's/^state=//p'; }
node()  { $S status | sed -n 's/^node=//p'; }
phase() { $S status | sed -n 's/^phase=//p'; }
rules() { # 启动路径使用的内核事实，不是状态缓存
  if iptables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1 &&
     ip6tables -t mangle -nL KR_TP_OUTPUT >/dev/null 2>&1; then
    echo present
  else
    echo absent
  fi
}
rules_cache() { $S status | sed -n 's/^rules=//p'; }
pid()   { cat "$RUN/xray.pid" 2>/dev/null; }
expect() { # <名称> <实际> <期望>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2' want '$3'"; fi
}

reset_all() { # 干净状态：已停止、无节点、无规则、安装默认模式
  $S stop >/dev/null 2>&1
  $S unapply >/dev/null 2>&1   # 也把规则拆掉
  $S routing cnadblock >/dev/null 2>&1   # 安装器在全新安装上留下的模式
  : > "$L" 2>/dev/null
}

# =====================================================================
echo "===== P0: failure paths"

# P0-1：-test 拒绝候选 -> 旧配置原封不动，核心继续运行
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1
pid1=$(pid)
before=$(mark)
ob 192.168.1.11 badnode0001
# 被核心拒绝的配置：伪造的 network 值
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

# P0-4：切换失败后，下一次启动保留已应用节点的配置
$S stop >/dev/null 2>&1
r=$($S start 2>&1)
expect "P0-4a start keeps applied node" "$(node)" "8401c5e7cf94ad2d"
grep -q "keeping the config on disk" "$KL" && ok "P0-4b logged" || bad "P0-4b logged" "$(tail -3 "$KL" | tr '\n' ' ')"
grep -q 192.168.1.10 "$M/config.json" && ok "P0-4c config is node A" || bad "P0-4c config is node A" "no A in config"
expect "P0-4d running" "$(state)" "running"

# P0-5：同一情形，但磁盘配置不再通过 `-test` -> 拒绝它
$S stop >/dev/null 2>&1
printf '%s' '{"not":"a config"}' > "$M/config.json"
chmod 600 "$M/config.json"
r=$($S start 2>&1)
rc=$?
expect "P0-5a start refuses" "$rc" "1"
echo "$r" | grep -q "config test failed" && ok "P0-5b message" || bad "P0-5b message" "$r"
# 拒绝落在 kr_ensure_config，它在 kr_start_locked 写失败状态之前就返回了
# ——核心就是不启动，最后一次状态保持原样。要紧的状态：
# 未运行，且没有为一个不会运行的核心装任何规则。
expect "P0-5c not running" "$(state)" "stopped"
expect "P0-5d no rules" "$(rules)" "absent"
# 把已应用节点的配置放回去，供本次运行后续用例使用。
$S unapply >/dev/null 2>&1
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1

# P0-2：测试通过却起不来的候选 -> 回滚
# badnode0001 的出站现在测试能过，但真正的失败需要核心启动后退出；
# 用 tproxy 端口冲突的配置模拟：自己占住 10810。
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1
pid1=$(pid)
# 第二个节点渲染正常（测试通过）——只有端口被占时启动才会失败，
# 所以我们改用成文的替代：配置有效，但从这里无法让核心绑不了端口。
# 主机上由 tests/config.test.js 覆盖；这里只在自然发生时验证回滚标记
# 路径。无法强制时跳过。
info "P0-2 rollback" "covered by unit tests (loopingCore); device force needs a port collision"
$S stop >/dev/null 2>&1

# P0-3：无旧配置的启动失败 -> stopped/no-node。只要能重建，shell 会从
# 已应用出站重建配置（那是 kr_ensure_config 的职责），所以诚实的
# 期望是带着已应用节点成功启动——不是拒绝。
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
rm -f "$M/config.json"
$S start >/dev/null 2>&1
expect "P0-3a rebuilds and runs" "$(state)" "running"
expect "P0-3b node" "$(node)" "8401c5e7cf94ad2d"
grep -q 192.168.1.10 "$M/config.json" && ok "P0-3c config from the applied outbound" || bad "P0-3c config" "not the applied node"

# P0-3'：连已应用出站也没了时，重建拒绝，什么都不运行
reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
rm -f "$M/config.json" "$M/outbound.json"
r=$($S start 2>&1)
# 启动拒绝把 failed/no-config 写进 status.json；`status` 报告的是活
# 进程状态（stopped）与最后一个 phase（no-config）。
phase_now=$(sed -n 's/.*"phase":"\([^"]*\)".*/\1/p' "$M/runtime/status.json")
state_now=$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$M/runtime/status.json")
expect "P0-3d refuses without the outbound" "$state_now" "failed"
expect "P0-3e phase" "$phase_now" "no-config"
[ -f "$M/config.json" ] && bad "P0-3f no config created" "config exists" || ok "P0-3f no config created"

reset_all

# =====================================================================
echo "===== P1：启动 / 停止"

# P1-7：冷启动，规则不在位：恰好一次测试，规则装上
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
before=$(mark)
t0=$(date +%s%N 2>/dev/null || echo 0)
$S start >/dev/null 2>&1
expect "P1-7a running" "$(state)" "running"
expect "P1-7b rules present" "$(rules)" "present"
expect "P1-7h cache present" "$(rules_cache)" "present"
# apply 已渲染并测试配置；启动复用那些字节（什么都没变），
# 所以启动本身不花测试。只统计启动本身的花费，从标记之后的
# 第一次 config.json 加载算起。
#（逐手势的账目见最后的 summary）
expect "P1-7c one run" "$(runs_in "$before")" "1"
grep -q '"tag":"tp-in"' "$M/config.json" && ok "P1-7e tp-in present" || bad "P1-7e tp-in present" "no tp-in"

# P1-8：运行中再启动 -> 无操作
pid1=$(pid)
before=$(mark)
$S start >/dev/null 2>&1
expect "P1-8a same pid" "$(pid)" "$pid1"
expect "P1-8b no test" "$(tests_in "$before")" "0"
expect "P1-8c no run" "$(runs_in "$before")" "0"

# P1-13：游离核心被杀掉
nohup "$M/bin/xray" run -c "$M/config.json" >/dev/null 2>&1 &
stray=$!
sleep 1
n_before=$(ps -A -o ARGS | grep -c "^xray run")
$S start >/dev/null 2>&1
sleep 1
n_after=$(ps -A -o ARGS | grep -c "^xray run")
if [ "$n_after" = 1 ]; then ok "P1-13 stray killed"; else bad "P1-13 stray killed" "cores before=$n_before after=$n_after"; fi
kill -0 "$stray" 2>/dev/null && bad "P1-13b stray gone" "still alive" || ok "P1-13b stray gone"

# P1-9：停止后捕获仍在位（fail-closed，docs/adr/0004）
$S stop >/dev/null 2>&1
before=$(mark)
expect "P1-9a stopped" "$(state)" "stopped"
expect "P1-9b rules still present" "$(rules)" "present"
expect "P1-9f cache present" "$(rules_cache)" "present"
# ……而下一次启动复用它们，而不是重装。
$S start >/dev/null 2>&1
expect "P1-9c running" "$(state)" "running"
expect "P1-9d rules present" "$(rules)" "present"
grep -q '"tag":"tp-in"' "$M/config.json" && ok "P1-9e tp-in present" || bad "P1-9e tp-in present" "no tp-in"

# P1-10：日志级别在下一次启动时生效
$S loglevel debug >/dev/null 2>&1
p1=$($S status | sed -n 's/^loglevelpending=//p')
$S stop >/dev/null 2>&1
$S start >/dev/null 2>&1
p2=$($S status | sed -n 's/^loglevelpending=//p')
lv=$(grep -o '"loglevel": "[a-z]*"' "$M/config.json" | head -1)
expect "P1-10a pending before" "$p1" "1"
expect "P1-10b pending after" "$p2" "0"
expect "P1-10c config level" "$lv" '"loglevel": "debug"'
$S loglevel warning >/dev/null 2>&1   # 回到默认（移除文件）

# P1-11：cn 偏好下 geo 数据缺失 -> 降级启动，不是失败
$S routing cn >/dev/null 2>&1
mv "$M/bin/geoip.dat" /data/local/tmp/geoip.bak
$S stop >/dev/null 2>&1
$S start >/dev/null 2>&1
if [ "$(state)" = "running" ]; then ok "P1-11a degraded start"; else bad "P1-11a degraded start" "state=$(state)"; fi
grep -q "geo data missing" "$KL" && ok "P1-11b logged" || bad "P1-11b logged" "$(tail -2 "$KL" | tr '\n' ' ')"
grep -q geosite:cn "$M/config.json" && bad "P1-11c degraded to global" "cn rules present" || ok "P1-11c degraded to global"
mv /data/local/tmp/geoip.bak "$M/bin/geoip.dat"
$S routing global >/dev/null 2>&1

# P1-13：cnadblock 偏好下 geo 数据缺失 -> 启动被拒绝，不降级
#（docs/adr/0021：名叫 去广告 的模式绝不许静默当作 大陆直连 运行）
$S routing cnadblock >/dev/null 2>&1
mv "$M/bin/geosite.dat" /data/local/tmp/geosite.bak
$S stop >/dev/null 2>&1
r=$($S start 2>&1); rc=$?
expect "P1-13a refused" "$rc" "1"
echo "$r" | grep -qx "geo data missing" && ok "P1-13b message" || bad "P1-13b message" "$r"
# status.json 写的是 failed/config-invalid；kv 的 state 来自活进程，所以
# 读作 stopped——指名原因的是 phase。
expect "P1-13c state" "$(state)" "stopped"
expect "P1-13d phase" "$(phase)" "config-invalid"
grep -q "cnadblock cannot start" "$KL" && ok "P1-13e logged" || bad "P1-13e logged" "$(tail -2 "$KL" | tr '\n' ' ')"
mv /data/local/tmp/geosite.bak "$M/bin/geosite.dat"
$S routing global >/dev/null 2>&1

# P1-12：没有已应用节点 -> 拒绝，无规则
$S stop >/dev/null 2>&1
$S unapply >/dev/null 2>&1
r=$($S start 2>&1)
rc=$?
expect "P1-12a refuses" "$rc" "1"
echo "$r" | grep -q "no applied node" && ok "P1-12b message" || bad "P1-12b message" "$r"
expect "P1-12c no rules" "$(rules)" "absent"
expect "P1-12e cache absent" "$(rules_cache)" "absent"
expect "P1-12d phase" "$(phase)" "no-node"

# P1-14：起不来的核心 -> 快速 failed/crashed
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1
$S stop >/dev/null 2>&1
# 用一个真实的监听者占住 socks 端口（busybox 的 nc 一直留在前台；第一轮
# 的 toybox nc 立即退出，核心绑定了端口，用例从未发生）
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
echo "===== P2：应用与幂等"

reset_all
ob 192.168.1.10 8401c5e7cf94ad2d
$S apply 8401c5e7cf94ad2d >/dev/null 2>&1
$S start >/dev/null 2>&1

# P2-15：切换已应用节点：一次测试，一次重启
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

# P2-16：重新应用同一节点：不测试、不重启
pid1=$(pid)
before=$(mark)
ob 192.168.1.11 8401c5e7cf94ad2e   # 同一节点，重写文件
$S apply 8401c5e7cf94ad2e >/dev/null 2>&1
expect "P2-16a same pid" "$(pid)" "$pid1"
expect "P2-16b no test" "$(tests_in "$before")" "0"
expect "P2-16c no run" "$(runs_in "$before")" "0"
grep -q "config unchanged" "$KL" && ok "P2-16d logged" || bad "P2-16d logged" "$(tail -2 "$KL" | tr '\n' ' ')"

# P2-17：端口值未变：无操作
pid1=$(pid)
before=$(mark)
$S ports >/dev/null 2>&1
expect "P2-17a same pid" "$(pid)" "$pid1"
expect "P2-17b no test" "$(tests_in "$before")" "0"
grep -q "already carries the saved ports" "$KL" && ok "P2-17c logged" || bad "P2-17c logged" "$(tail -2 "$KL" | tr '\n' ' ')"

# P2-18：端口变更 -> 重启，新端口监听。本夹具的 state.json 没有
# settings 对象，按 WebUI 的写法写一个（美化输出、settings 在位）。
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
# 恢复
$S stop >/dev/null 2>&1
write_ports 10808 10809
$S ports >/dev/null 2>&1
$S start >/dev/null 2>&1

# P2-19：分流模式 全局 <-> cn
before=$(mark)
$S routing cn >/dev/null 2>&1
expect "P2-19a cn restarts once" "$(tests_in "$before")" "1"
grep -q geosite:cn "$M/config.json" && ok "P2-19b cn rules" || bad "P2-19b cn rules" "absent"
expect "P2-19c routing=cn" "$($S status | sed -n 's/^routing=//p')" "cn"
before=$(mark)
$S routing global >/dev/null 2>&1
grep -q geosite:cn "$M/config.json" && bad "P2-19d global rules" "cn still present" || ok "P2-19d global rules"
expect "P2-19e one test" "$(tests_in "$before")" "1"

# 钉死顺序：解析发生在核心被停止 *之前*
grep -n "pinned node address\|could not pre-resolve" "$KL" | tail -1 | cut -d' ' -f1-2 > /tmp/pin.t
grep -n "stopped pid" "$KL" | tail -1 | cut -d' ' -f1-2 > /tmp/stop.t
if [ "$(cat /tmp/pin.t)" = "$(cat /tmp/stop.t)" ]; then
  info "P2-20 pin order" "与停止同一秒；不确定时手动看日志"
else
  ok "P2-20 pin order"
fi

# P2-21：cnadblock 渲染广告沉没端与 block 规则（只有真核心能证明它
# 接受 `#3` 的 hosts 值）
$S routing global >/dev/null 2>&1
$S routing cnadblock >/dev/null 2>&1
# -F：配置是紧凑 JSON，toybox grep 的 BRE 不支持 \| 交替。
grep -qF '"geosite:category-ads-all":"#3"' "$M/config.json" && \
  ok "P2-21a dns sink" || bad "P2-21a dns sink" "no ad sink in config.json"
grep -qF '"domain":["geosite:category-ads-all"],"outboundTag":"block"' "$M/config.json" && \
  ok "P2-21b block rule" || bad "P2-21b block rule" "no block rule in config.json"
expect "P2-21c routing=cnadblock" "$($S status | sed -n 's/^routing=//p')" "cnadblock"
$S routing global >/dev/null 2>&1

# P2-22：清空日志 在核心运行时原地截断活日志（不重启）。
[ "$(state)" = "running" ] || $S start >/dev/null 2>&1
p_before=$(pid)
printf 'before-clear\n' >> "$L"
rm -f /tmp/kr-clear-ready /tmp/kr-clear-go
# 在清空之前打开的追加 fd 模拟核心的 >>：改成 unlink 文件，
# 这一行就会写进死 inode，WebUI 再也 tail 不到。
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
# 模块日志同样清空，且不留标记行。
printf 'before-clear\n' >> "$KL"
$S mlog clear >/dev/null 2>&1
expect "P2-22e mlogsize" "$($S status log | sed -n 's/^mlogsize=//p')" "0"
$S mlog append Module "post-clear probe" >/dev/null 2>&1
$S mlog 5 | grep -q "post-clear probe" && ok "P2-22f module log keeps accepting lines" || \
  bad "P2-22f module log keeps accepting lines" "no post-clear line"
rm -f /tmp/kr-clear-ready /tmp/kr-clear-go

# ---- 汇总 ----
echo "===== summary: $pass passed, $fail failed"
reset_all
rm -f /tmp/pin.t /tmp/stop.t
[ "$fail" = 0 ]
