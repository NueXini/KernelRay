// 关于 TPROXY 接管的测试。
//
// 接管规则安装、冲突检测与启动路径都出自 module/scripts/tproxy.sh，对着会记录参数的
// 假 iptables/ip6tables/ip/settings 二进制运行，因此无需 Android 设备就能检验
// 安装/移除/冲突/失败关闭的语义。
//
//   node tests/tproxy.test.js
//
// 需要 bash（Windows 上是 Git Bash）。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const script = path.join(root, "module", "scripts", "kernelray.sh");
const template = path.join(root, "module", "config.example.json");

const ID = "0123456789abcdef";

const fixture = {
  tag: "proxy", protocol: "trojan",
  settings: { servers: [{ address: "n.example.com", port: 443, password: "pw" }] },
  streamSettings: {
    network: "tcp", security: "none", sockopt: { mark: "__KERNELRAY_MARK__" }
  }
};

// 假的 iptables/ip6tables：记录一切调用；行为由 FAKE_* 开关决定。
// 设置 FAKE_IPT_NOCHAIN 时 -nL（「链是否存在」的探测）会失败，于是安装
// 真的会发出规则；设置 FAKE_IPT_FAIL_N 时 -N KR_TP_OUTPUT 会失败。
const fakeIpt = [
  "#!/bin/sh",
  'printf "%s\\n" "$(basename "$0") $*" >>"$FAKE_LOG"',
  'if [ "$1 $2 $3" = "-t mangle -S" ] && [ -n "$FAKE_IPT_SAVE" ]; then',
  '  cat "$FAKE_IPT_SAVE"',
  "  exit 0",
  "fi",
  'case "$*" in',
  '  *-nL*) [ -n "$FAKE_IPT_NOCHAIN" ] && exit 1 ;;',
  '  *-C*) [ -n "$FAKE_IPT_NOCHAIN" ] && exit 1 ;; # the hook rule is not there yet',
  '  *"-N KR_TP_OUTPUT"*) [ -n "$FAKE_IPT_FAIL_N" ] && exit 1 ;;',
  "esac",
  "exit 0",
  ""
].join("\n");

// 假的 ip：记录调用；设置了 $FAKE_IP_LINK 时 `ip link show` 会打印它，其余调用成功。
// 假的 ip：记录调用；`ip link show` 打印 $FAKE_IP_LINK，`ip [-6] route show …`
// 会打印 $FAKE_IP_DEF（kr_tp_routes 复制进旁路表的那条默认路由）。
const fakeIp = [
  "#!/bin/sh",
  'printf "%s\\n" "$(basename "$0") $*" >>"$FAKE_LOG"',
  'if [ "$1 $2" = "link show" ] && [ -n "$FAKE_IP_LINK" ]; then',
  '  echo "$FAKE_IP_LINK"',
  "fi",
  'case "$*" in',
  '  *"route show"*) [ -n "$FAKE_IP_DEF" ] && echo "$FAKE_IP_DEF" ;;',
  "esac",
  "exit 0",
  ""
].join("\n");

const fakeSettings = [
  "#!/bin/sh",
  '[ -n "$FAKE_VPN_APP" ] && echo "$FAKE_VPN_APP"',
  "exit 0",
  ""
].join("\n");

// 这些测试里没有网络：节点主机名的解析（kr_tp_pin_node）必须快速失败，而不是
// 耗在 busybox wget 的 -T 和 ping 的 -W2 上。设置 FAKE_WGET_JSON 时，它就是桩
// 打印的 DoH 应答；不设置时桩像网络不可达一样失败。桩之所以叫 "busybox"，
// 是因为解析调用的是 $KR_BUSYBOX（被改指向这个桩）wget。
const fakeWget = [
  "#!/bin/sh",
  'printf "%s\\n" "$(basename "$0") $*" >>"$FAKE_LOG"',
  // 解析把请求包在 `busybox timeout 4 busybox wget ...` 里；这里用内部的 argv
  // 重新执行来扮演那层包装，于是日志里记下的请求行就是内部那条。
  'if [ "$1" = timeout ]; then shift 2; exec "$0" "$@"; fi',
  '[ -n "$FAKE_WGET_JSON" ] && { printf "%s\\n" "$FAKE_WGET_JSON"; exit 0; }',
  "exit 1",
  ""
].join("\n");

const fakePing = [
  "#!/bin/sh",
  "exit 1",
  ""
].join("\n");

// `-version` 输出版本，`-test` 通过，`run -c` 保持存活，让启动能到达 "running"。
// 每次调用都记入 $FAKE_LOG，测试因此可以断言什么先跑、什么后跑。
const fakeCore = [
  "#!/bin/sh",
  'printf "core %s\\n" "$*" >>"$FAKE_LOG"',
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  trap "exit 0" TERM INT',
  "  while :; do sleep 0.2; done",
  "fi",
  "exit 0",
  ""
].join("\n");

const dirs = [];
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(name + "\n    " + e.message.replace(/\n/g, "\n    "));
  }
}

function eq(actual, expected, what) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (e) {
    throw new Error((what || "value") + "\n" + e.message);
  }
}

function shPath(p) {
  if (process.platform !== "win32") { return p; }
  return "/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");
}

// 桩目录以 Windows 格式前置；msys bash 会自行转换 PATH。
function posixPathEnv(extraDir) {
  return process.platform === "win32"
    ? extraDir + ";" + process.env.PATH
    : extraDir + ":" + process.env.PATH;
}

function makeModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernelray-tp-"));
  dirs.push(dir);
  fs.copyFileSync(template, path.join(dir, "config.example.json"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "xray"), fakeCore, "utf8");
  fs.chmodSync(path.join(dir, "bin", "xray"), 0o755);
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "module", "scripts", "tproxy.sh"),
    path.join(dir, "scripts", "tproxy.sh"));
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  for (const [name, body] of [["iptables", fakeIpt], ["ip6tables", fakeIpt],
    ["ip", fakeIp], ["settings", fakeSettings], ["busybox", fakeWget], ["ping", fakePing]]) {
    fs.writeFileSync(path.join(stubs, name), body, "utf8");
    fs.chmodSync(path.join(stubs, name), 0o755);
  }
  return {
    dir: dir,
    config: path.join(dir, "config.json"),
    outbound: path.join(dir, "outbound.json"),
    meta: path.join(dir, "outbound.meta"),
    applied: path.join(dir, "runtime", "applied"),
    status: path.join(dir, "runtime", "status.json"),
    log: path.join(dir, "logs", "kernelray.log")
  };
}

function runShell(m, body, extraEnv) {
  return execFileSync("bash", ["-c", body, "bash"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      KR_MODDIR: shPath(m.dir),
      KR_TEST_SCRIPT: shPath(script),
      KR_BUSYBOX: shPath(path.join(m.dir, "stubs", "busybox")),
      FAKE_LOG: shPath(path.join(m.dir, "iptables.log")),
      FAKE_IP_DEF: "default via 10.0.2.2 dev wlan0",
      PATH: posixPathEnv(path.join(m.dir, "stubs")),
      // 假核心从不绑定 socks 端口，所以启动会一直等到截止时间。
      KR_START_POLLS: "8",
      KR_START_STEP: "0.05"
    }, extraEnv || {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// 与 runShell 类似，但容忍非零退出（kr_tp_conflict 在「无冲突」时返回 1）。
function runAllow(m, body, extraEnv) {
  try { return { status: 0, stdout: runShell(m, body, extraEnv) }; }
  catch (e) { return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" }; }
}

function writeApplied(m) {
  fs.writeFileSync(m.outbound, JSON.stringify(fixture));
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=n.example.com\n");
  fs.writeFileSync(m.applied, ID + "\n");
}

function fakeLog(m) {
  try { return fs.readFileSync(path.join(m.dir, "iptables.log"), "utf8"); }
  catch (e) { return ""; }
}

const BODY_INSTALL = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_install';
const BODY_REMOVE = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_remove';
const BODY_CONFLICT = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_conflict';
// 完整走一遍启动路径：闸门、接管规则（engage）以及启动所运行的配置。
const BODY_BOOT = '. "$KR_TEST_SCRIPT"; kr_dirs; chmod +x "$KR_MODDIR/bin/xray"; kr_start';

// ---- 规则安装 ----------------------------------------------------------------------------

check("install: both families get the full rule set and the policy routing", () => {
  const m = makeModule();
  runShell(m, BODY_INSTALL, { FAKE_IPT_NOCHAIN: "1" });
  const log = fakeLog(m);
  for (const ipt of ["iptables", "ip6tables"]) {
    if (!log.includes(ipt + " -t mangle -N KR_TP_OUTPUT")) {
      throw new Error(ipt + ": output chain not created");
    }
    if (!log.includes(ipt + " -t mangle -A KR_TP_OUTPUT -m mark --mark 19282 -j RETURN")) {
      throw new Error(ipt + ": bypass-mark return rule missing");
    }
    if (!log.includes(ipt + " -t mangle -A KR_TP_PREROUTING -s " +
      (ipt === "ip6tables" ? "::1/128" : "127.0.0.0/8") + " -p tcp -j TPROXY")) {
      throw new Error(ipt + ": tcp TPROXY rule missing");
    }
    // 本地入站（环回上的 socks/http）从 127/8 应答到 127/8；除非目的地址的 RETURN
    // 排在前面，否则源地址 TPROXY 规则会把那个 SYN-ACK 抢走。
    const loopback = ipt === "ip6tables" ? "::1/128" : "127.0.0.0/8";
    const localReturn = ipt + " -t mangle -A KR_TP_PREROUTING -d " + loopback + " -j RETURN";
    if (!log.includes(localReturn)) {
      throw new Error(ipt + ": loopback-destination RETURN missing (local inbounds would hang)");
    }
    if (log.indexOf(localReturn) > log.indexOf(ipt +
      " -t mangle -A KR_TP_PREROUTING -s " + loopback + " -p tcp -j TPROXY")) {
      throw new Error(ipt + ": loopback RETURN must precede the source TPROXY rule");
    }
    if (ipt === "ip6tables" && !log.includes(
      "ip6tables -t mangle -A KR_TP_PREROUTING -d ::ffff:127.0.0.0/104 -j RETURN")) {
      throw new Error("ip6tables: IPv4-mapped loopback RETURN missing");
    }
    if (!log.includes(ipt + " -t mangle -A KR_TP_OUTPUT -p udp --dport 53 -j MARK --set-mark 19283")) {
      throw new Error(ipt + ": dns udp mark rule missing");
    }
    if (!log.includes(ipt + " -t filter -A KR_TP_INPUT ! -i lo -p tcp --dport 10810 -j DROP")) {
      throw new Error(ipt + ": INPUT guard missing");
    }
    if (!log.includes(ipt + " -t mangle -A PREROUTING -j KR_TP_PREROUTING")) {
      throw new Error(ipt + ": PREROUTING hook missing");
    }
  }
  // 发往局域网解析器的 DNS 会被捕获：端口 53 的标记排在私有网段之前。
  const out = log.split("\n").filter((l) => l.includes("iptables -t mangle -A KR_TP_OUTPUT"));
  const dns53 = out.findIndex((l) => l.includes("--dport 53"));
  const lan = out.findIndex((l) => l.includes("192.168.0.0/16"));
  if (dns53 < 0 || lan < 0 || dns53 > lan) {
    throw new Error("port 53 must be marked before the LAN bypass");
  }
  const dhcp = out.findIndex((l) => l.includes("--dport 67:68"));
  if (dhcp < 0 || dhcp < dns53) {
    throw new Error("DHCP must be bypassed");
  }
  if (!log.includes("ip rule add pref 9500 fwmark 19283 lookup 19283")) {
    throw new Error("ipv4 capture rule missing");
  }
  if (!log.includes("ip rule add pref 9400 fwmark 19282 lookup 19282")) {
    throw new Error("ipv4 bypass rule missing");
  }
  if (!log.includes("ip -4 route add default via 10.0.2.2 dev wlan0 table 19282")) {
    throw new Error("bypass table must carry a copy of the default route");
  }
  if (!log.includes("ip -6 rule add pref 9400 fwmark 19282 lookup 19282")) {
    throw new Error("ipv6 bypass rule missing");
  }
  if (!log.includes("ip route replace local 0.0.0.0/0 dev lo table 19283")) {
    throw new Error("ipv4 local route missing");
  }
  if (!log.includes("ip -6 route replace local ::/0 dev lo table 19283")) {
    throw new Error("ipv6 local route missing");
  }
  const v4Ranges = log.split("\n").filter((l) => l.startsWith("iptables -t mangle -A KR_TP_OUTPUT -d"));
  const v6Ranges = log.split("\n").filter((l) => l.startsWith("ip6tables -t mangle -A KR_TP_OUTPUT -d"));
  if (v4Ranges.length < 8 || v6Ranges.length < 4) {
    throw new Error("bypass ranges incomplete: " + v4Ranges.length + " v4, " + v6Ranges.length + " v6");
  }
});

check("install: already-present rules are not installed twice", () => {
  const m = makeModule();
  runShell(m, BODY_INSTALL, {});
  const log = fakeLog(m);
  if (log.includes("-N KR_TP_OUTPUT")) {
    throw new Error("rules were re-created although the probe said they exist");
  }
});

check("install: a failing rule aborts and removes everything again", () => {
  const m = makeModule();
  let failed = false;
  try { runShell(m, BODY_INSTALL, { FAKE_IPT_NOCHAIN: "1", FAKE_IPT_FAIL_N: "1" }); }
  catch (e) { failed = true; }
  if (!failed) { throw new Error("install must fail when a rule cannot be created"); }
  const log = fakeLog(m);
  for (const cmd of ["-X KR_TP_OUTPUT", "-X KR_TP_PREROUTING", "-X KR_TP_INPUT"]) {
    if (!log.includes("iptables -t mangle " + cmd) && !log.includes("iptables -t filter " + cmd)) {
      throw new Error("rollback missing: " + cmd);
    }
  }
  if (!log.includes("ip rule del pref 9500")) { throw new Error("rollback must drop the policy rule"); }
});

// ---- 规则移除 -----------------------------------------------------------------------------

check("remove: tolerant when nothing was ever installed", () => {
  const m = makeModule();
  runShell(m, BODY_REMOVE, {});
  const log = fakeLog(m);
  if (!log.includes("iptables -t mangle -X KR_TP_OUTPUT")) {
    throw new Error("remove must still run its cleanup steps");
  }
});

// ---- 冲突检测 ---------------------------------------------------------------------------

const TUN_UP = "5: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500\n" +
  "    link/none";
const TUN_DOWN = "5: tun0: <POINTOPOINT,MULTICAST,NOARP> mtu 1500\n    link/none";

check("conflict: a UP tun/wg interface refuses takeover, a down one does not", () => {
  const m = makeModule();
  const up = runShell(m, BODY_CONFLICT, { FAKE_IP_LINK: TUN_UP });
  if (!/interface tun0 is up/.test(up)) { throw new Error("expected the tun0 conflict, got: " + up); }
  const down = runAllow(m, BODY_CONFLICT, { FAKE_IP_LINK: TUN_DOWN });
  if (down.stdout.trim() !== "" || down.stderr.trim() !== "") {
    throw new Error("a down tun must not conflict, got: " + down.status + " " + down.stdout + down.stderr);
  }
});

check("conflict: an always-on VPN setting refuses takeover", () => {
  const m = makeModule();
  const out = runShell(m, BODY_CONFLICT, { FAKE_VPN_APP: "com.example.vpn" });
  if (!/always-on VPN/.test(out)) { throw new Error("expected the always-on conflict, got: " + out); }
});

check("conflict: a foreign TPROXY rule refuses takeover, our own do not", () => {
  const m = makeModule();
  const foreign = path.join(m.dir, "foreign.save");
  fs.writeFileSync(foreign,
    "-A PREROUTING -p tcp -m mark --mark 19283 -j TPROXY --on-port 7893 --tproxy-mark 1\n" +
    "-A KR_TP_PREROUTING -s 127.0.0.0/8 -p tcp -j TPROXY\n");
  const out = runShell(m, BODY_CONFLICT, { FAKE_IPT_SAVE: shPath(foreign) });
  if (!/foreign TPROXY/.test(out)) { throw new Error("expected the foreign-rule conflict, got: " + out); }

  fs.writeFileSync(foreign,
    "-A KR_TP_PREROUTING -s 127.0.0.0/8 -p tcp -j TPROXY\n" +
    "-A KR_TP_PREROUTING -s 127.0.0.0/8 -p udp -j TPROXY\n");
  const own = runAllow(m, BODY_CONFLICT, { FAKE_IPT_SAVE: shPath(foreign) });
  if (own.stdout.trim() !== "" || own.stderr.trim() !== "") {
    throw new Error("our own TPROXY rules must not conflict, got: " + own.status + " " + own.stdout + own.stderr);
  }
});

// ---- 启动路径 (启动即接管, ADR 0011) ------------------------------------------------
//
// 这些测试跑完整的启动路径（闸门 -> prepare -> 配置 -> 接管规则 -> fork），因为顺序
// 正是这里的契约：冲突检查与节点地址钉死排在最前（此时网络仍是直连），然后是配置
// 与它的 `xray -test`，最后才装接管规则 —— 被核心拒绝的配置于是让设备保持直连，
// 而不是断网。断言在核心被停止之前执行，所以 status.json 里描述的仍是
// 这次启动。

function withBoot(m, env, fn) {
  try {
    return fn(runAllow(m, BODY_BOOT, env));
  } finally {
    try { runShell(m, '. "$KR_TEST_SCRIPT"; kr_stop'); } catch (e) { /* 尽力而为 */ }
  }
}

function status(m) {
  return JSON.parse(fs.readFileSync(m.status, "utf8"));
}

check("start: no usable outbound installs no rules and refuses the start", () => {
  const m = makeModule();
  // 上次会话留下的陈旧配置：背后没有渲染出的节点出站，它什么也描述不了，所以绝不能
  // 被运行（ADR 0010）—— 也不能装上任何接管规则。
  fs.writeFileSync(m.config, JSON.stringify({ sentinel: true }));
  fs.writeFileSync(m.applied, ID + "\n");
  fs.rmSync(m.outbound, { force: true });
  withBoot(m, { FAKE_IPT_NOCHAIN: "1" }, () => {
    eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id is not silently cleared");
    eq(JSON.parse(fs.readFileSync(m.config, "utf8")), { sentinel: true }, "config untouched");
    const log = fakeLog(m);
    if (log.includes("iptables -t mangle -N KR_TP_OUTPUT")) {
      throw new Error("no usable outbound means no rules (ADR 0011)");
    }
    eq(status(m).state, "failed", "state");
    eq(status(m).phase, "no-config", "phase");
  });
});

check("start: nothing applied at all keeps the network direct", () => {
  const m = makeModule();
  withBoot(m, { FAKE_IP_LINK: TUN_UP }, () => {
    const log = fakeLog(m);
    if (log.includes("-N KR_TP_OUTPUT")) {
      throw new Error("a start without an applied node never installs the rules (ADR 0011)");
    }
    eq(status(m).state, "stopped", "state");
    eq(status(m).phase, "no-node", "phase");
  });
});

check("start: a conflict refuses the start before the config is rendered", () => {
  const m = makeModule();
  writeApplied(m);
  withBoot(m, { FAKE_IPT_NOCHAIN: "1", FAKE_IP_LINK: TUN_UP }, () => {
    if (fs.existsSync(m.config)) {
      throw new Error("the conflict is checked before the render; no config may be written");
    }
    if (fakeLog(m).includes("-N KR_TP_OUTPUT")) { throw new Error("no rules after a conflict"); }
    eq(status(m).state, "stopped", "state");
    eq(status(m).phase, "failed/conflict", "phase");
  });
});

check("start: a failed rule install leaves the tested config on disk and the device direct", () => {
  const m = makeModule();
  writeApplied(m);
  withBoot(m, { FAKE_IPT_NOCHAIN: "1", FAKE_IPT_FAIL_N: "1" }, () => {
    // 在尝试装接管规则之前，配置已经渲染并通过 -test：它就是唯一的那种形态，
    // 而一个从未启动的核心也不可能围着它打环。
    const cfg = JSON.parse(fs.readFileSync(m.config, "utf8"));
    eq(cfg.inbounds.length, 3, "the takeover config is already on disk");
    eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "live mark");
    if (!fakeLog(m).includes("core run -test")) {
      throw new Error("the config must be tested before the rules go in");
    }
    eq(status(m).state, "stopped", "state");
    eq(status(m).phase, "failed/rules", "phase");
  });
});

check("start: xray -test runs before the rules go in, and a good config takes over", () => {
  const m = makeModule();
  writeApplied(m);
  withBoot(m, { FAKE_IPT_NOCHAIN: "1" }, () => {
    const log = fakeLog(m).split("\n");
    const tested = log.findIndex((l) => l.startsWith("core run -test"));
    const installed = log.findIndex((l) => l === "iptables -t mangle -N KR_TP_OUTPUT");
    if (tested < 0) { throw new Error("the config was never tested"); }
    if (installed < 0) { throw new Error("the rules were never installed"); }
    if (tested > installed) {
      throw new Error("the test must precede the rule install (docs/adr/0011)");
    }
    const cfg = JSON.parse(fs.readFileSync(m.config, "utf8"));
    eq(cfg.inbounds.length, 3, "tproxy inbound present");
    eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "live mark");
    eq(cfg.routing.rules.some((r) => r.outboundTag === "dns-out"), true, "dns rule present");
    if (fs.existsSync(path.join(m.dir, "runtime", "config.form"))) {
      throw new Error("there is no form to record any more");
    }
    eq(status(m).state, "running", "state");
    eq(status(m).phase, "idle", "phase");
  });
});

check("start: a rejected config installs no rules at all", () => {
  const m = makeModule();
  writeApplied(m);
  const rejecting = [
    "#!/bin/sh",
    'printf "core %s\\n" "$*" >>"$FAKE_LOG"',
    'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
    'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then exit 1; fi',
    "exit 0",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(m.dir, "bin", "xray"), rejecting, "utf8");
  fs.chmodSync(path.join(m.dir, "bin", "xray"), 0o755);
  withBoot(m, { FAKE_IPT_NOCHAIN: "1" }, () => {
    if (fakeLog(m).includes("-N KR_TP_OUTPUT")) {
      throw new Error("a config the core rejects must leave the device direct, not offline");
    }
    eq(status(m).state, "failed", "state");
    eq(status(m).phase, "config-invalid", "phase");
  });
});

// ---- 不存在开关 (ADR 0011) --------------------------------------------------------

check("switch: no switch API survives, and a leftover file is removed by a start", () => {
  const m = makeModule();
  writeApplied(m);
  fs.writeFileSync(path.join(m.dir, "runtime", "tproxy"), "off\n");
  fs.writeFileSync(path.join(m.dir, "runtime", "config.form"), "0\n");
  const gone = runAllow(m,
    '. "$KR_TEST_SCRIPT"; for f in kr_tp_switch_on kr_tproxy_set kr_tp_default_on kr_tp_form; do' +
    ' command -v "$f" >/dev/null 2>&1 && echo STILL-THERE $f; done');
  if (gone.stdout.includes("STILL-THERE")) {
    throw new Error("the switch API is gone: " + gone.stdout);
  }
  // 清理函数 kr_cleanup_legacy 会删除旧版本留下的东西，于是任何已经没有读取者的
  // 陈旧偏好或形态都影响不了一次启动（docs/adr/0011）。
  withBoot(m, {}, () => {
    for (const leftover of ["tproxy", "config.form"]) {
      if (fs.existsSync(path.join(m.dir, "runtime", leftover))) {
        throw new Error("a leftover " + leftover + " must be removed");
      }
    }
  });
});

check("switch: tproxy status reports the rules only, and status.json has no tproxy key", () => {
  const m = makeModule();
  writeApplied(m);
  const out = runShell(m, '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tproxy_status',
    { FAKE_IPT_NOCHAIN: "1" });
  eq(out.trim(), "rules=absent", "the diagnosis is the rules, not a preference");
  withBoot(m, {}, () => {
    if ("tproxy" in status(m)) { throw new Error("status.json must not carry a switch any more"); }
  });
});

// ---- 节点地址钉死 (ADR 0008) -------------------------------------------------------------
check("pin: the DoH answer via wget lands in runtime/nodeip, with the ask on record", () => {
  const m = makeModule();
  writeApplied(m);
  const nodeip = path.join(m.dir, "runtime", "nodeip");
  runShell(m, '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_pin_node',
    { FAKE_WGET_JSON: '{"Status":0,"Answer":[{"type":1,"data":"203.0.113.9"}]}' });
  eq(fs.readFileSync(nodeip, "utf8").trim(), "203.0.113.9", "nodeip content");

  // 模块日志记录下这次钉死；解析路径本身保持沉默，因为它的 stdout
  // 就是返回值。
  const log = fs.readFileSync(m.log, "utf8");
  if (!log.includes("pinned node address 203.0.113.9")) {
    throw new Error("the pin is not logged: " + log);
  }

  // 请求的形状是承重的：type=A 对应 DNS 模块的 UseIPv4，证书校验被有意关掉
  // （docs/adr/0008）—— 两者都不许悄无声息地退化。
  const ask = fakeLog(m).split("\n").find((l) => l.includes("wget -q"));
  if (!ask) { throw new Error("busybox wget was never called"); }
  for (const part of ["--no-check-certificate", "name=n.example.com", "type=A"]) {
    if (!ask.includes(part)) { throw new Error("the ask is missing " + part + ": " + ask); }
  }
});

check("pin: a failed DoH ask logs the fallback and answers nothing", () => {
  const m = makeModule();
  writeApplied(m);
  const out = runShell(m, '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_pin_node');
  if (fs.existsSync(path.join(m.dir, "runtime", "nodeip"))) {
    throw new Error("nothing to pin, nodeip must not exist");
  }
  if (out.includes("pinned node address")) { throw new Error("nothing was pinned"); }
  if (!fs.existsSync(m.log)) { throw new Error("the fallback is not logged"); }
  const log = fs.readFileSync(m.log, "utf8");
  if (!log.includes("the DoH ask failed; falling back to the system resolver")) {
    throw new Error("the fallback is not logged: " + log);
  }
});

// ---- 结果报告 -----------------------------------------------------------------------------

dirs.forEach((d) => {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* Windows 可能占用文件 */ }
});

if (failures.length) {
  console.error("\n" + failures.length + " failing, " + pass + " passing\n");
  failures.forEach((f) => console.error("FAIL " + f + "\n"));
  process.exit(1);
}
console.log(pass + " tproxy tests passing");
