// 核心配置组装测试。
//
// 只有 shell 会把配置模板 + outbound.json 拼成 config.json。
// 这套测试在临时的模块目录和假核心上 source 随包提供的 kernelray.sh，因此
// 无需 Android 设备或真正的 Xray 核心，就能检验渲染、已应用 id 的记录以及
// 应用节点的失败路径。
//
//   node tests/config.test.js
//
// 需要 bash（Windows 上是 Git Bash）。假核心只在回滚测试里真正运行，那次测试用 /proc
// 识别进程；这里没有真正的 Xray 或 iptables。

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
const OTHER_ID = "fedcba9876543210";

const fixture = {
  tag: "proxy",
  protocol: "trojan",
  settings: {
    servers: [{
      address: "n.example.com",
      port: 443,
      password: "p\"a\\s$`'<>&\nline2"
    }]
  },
  streamSettings: {
    network: "ws",
    security: "tls",
    tlsSettings: { serverName: "n.example.com", alpn: ["h2", "http/1.1"] },
    wsSettings: { path: "/ws", headers: { Host: "cdn.example.com" } },
    sockopt: { mark: "__KERNELRAY_MARK__" }
  }
};

const fakeCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then',
  '  echo "Xray 0.0.0 (test)"',
  "  exit 0",
  "fi",
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then',
  '  [ -n "$FAKE_XRAY_FAIL" ] && exit 1',
  "  exit 0",
  "fi",
  "exit 0",
  ""
].join("\n");

// 一个只为由「旧」节点出站（地址 old.example.com）生成的配置保持存活的假核心。它让
// 回滚测试能在一份真实配置正在运行时，演练「候选配置能过测试、但启动后立刻退出」
// 这条路径。
// 一个对任意配置都保持存活的假核心：启动路径测试需要一个活着的 pid，而 /proc
// 正是 kr_running 检查的地方。
const aliveCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  trap "exit 0" TERM INT',
  "  while :; do sleep 0.2; done",
  "fi",
  "exit 0",
  ""
].join("\n");

const loopingCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then',
  '  echo "Xray 0.0.0 (test)"',
  "  exit 0",
  "fi",
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then',
  "  exit 0",
  "fi",
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  if grep -q \'old.example.com\' "$3"; then',
  "    trap 'exit 0' TERM INT",
  "    while :; do sleep 0.2; done",
  "  fi",
  "  exit 1",
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

// 在 Git Bash 里路径是 /c/Users/...，而 Node 看到的是 C:\Users\...
function shPath(p) {
  if (process.platform !== "win32") { return p; }
  return "/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");
}

function makeModule(core) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernelray-conf-"));
  dirs.push(dir);
  fs.copyFileSync(template, path.join(dir, "config.example.json"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "xray"), core || fakeCore, "utf8");
  // 在 Git Bash 里 [ -x ] 把 shebang 当作可执行魔数，所以缺少执行位只会在 Linux CI
  // 上出问题；真实设备上安装的二进制本来就是可执行的（tproxy.test.js 也
  // 同样处理）。
  fs.chmodSync(path.join(dir, "bin", "xray"), 0o755);
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  // 由于 kernelray.sh 从 $KR_MODDIR/scripts 加载接管辅助函数，夹具里必须放进
  // 真正的 tproxy.sh 才能走接管的渲染路径。
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "module", "scripts", "tproxy.sh"),
    path.join(dir, "scripts", "tproxy.sh"));
  // 每次启动都是一次接管（docs/adr/0011），所以每次启动都需要内核回答「规则在位」：
  // 下面这些桩程序在每次运行里都位于 PATH 上，除非某个测试自带一套（规则缓存
  // 测试就自带）。没有它们，启动会以 failed/rules 被拒绝，这正是启动路径要检验的，
  // 却不是这里大多数测试的重点。
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  const chainless = [
    "#!/bin/sh",
    'case "$*" in',
    '  *-nL*) exit 1 ;;',
    '  *-C*) exit 1 ;;',
    "esac",
    "exit 0",
    ""
  ].join("\n");
  const plainIp = [
    "#!/bin/sh",
    'case "$*" in',
    '  *"route show"*) echo "default via 10.0.2.2 dev wlan0" ;;',
    "esac",
    "exit 0",
    ""
  ].join("\n");
  for (const [name, body] of [
    ["iptables", chainless], ["ip6tables", chainless], ["ip", plainIp],
    ["settings", "#!/bin/sh\nexit 0\n"],
    ["busybox", "#!/bin/sh\nexit 1\n"],
    ["ping", "#!/bin/sh\nexit 1\n"]
  ]) {
    fs.writeFileSync(path.join(stubs, name), body, "utf8");
    fs.chmodSync(path.join(stubs, name), 0o755);
  }
  return {
    dir: dir,
    stubs: stubs,
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    outbound: path.join(dir, "outbound.json"),
    meta: path.join(dir, "outbound.meta"),
    applied: path.join(dir, "runtime", "applied"),
    status: path.join(dir, "runtime", "status.json"),
    loglevel: path.join(dir, "runtime", "loglevel"),
    rules: path.join(dir, "runtime", "rules")
  };
}

function runShell(dir, body, args, extraEnv) {
  const stubs = path.join(dir, "stubs");
  return execFileSync("bash", ["-c", body, "bash"].concat(args || []), {
    cwd: root,
    env: Object.assign({}, process.env, {
      KR_MODDIR: shPath(dir),
      KR_TEST_SCRIPT: shPath(script),
      KR_BUSYBOX: shPath(path.join(stubs, "busybox")),
      PATH: fs.existsSync(stubs) ? posixPathEnv(stubs) : process.env.PATH,
      // 假核心从不绑定 socks 端口，所以启动必须等到截止时间：这里把它缩短，免得每次启动
      // 都付 1.5 s 的代价。会退出的核心仍在第一次轮询就被发现，回滚测试正是依赖
      // 这一点。
      KR_START_POLLS: "8",
      KR_START_STEP: "0.05"
    }, extraEnv || {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// 桩目录以 Windows 格式前置；msys bash 会自行转换 PATH。
function posixPathEnv(extraDir) {
  return process.platform === "win32"
    ? extraDir + ";" + process.env.PATH
    : extraDir + ":" + process.env.PATH;
}

// 一对假的 iptables/ip6tables：记录每次调用，并用 <present> 回答
// 「链是否存在」的探测。规则缓存测试用它证明状态轮询会不会去
// 询问内核。
function makeIptablesStub(m, present) {
  const dir = path.join(m.dir, "stub-bin");
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(m.dir, "iptables.calls");
  const body = [
    "#!/bin/sh",
    'printf "%s\\n" "$(basename "$0") $*" >>"' + shPath(log) + '"',
    "exit " + (present ? 0 : 1),
    ""
  ].join("\n");
  ["iptables", "ip6tables"].forEach((name) => {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
    fs.chmodSync(path.join(dir, name), 0o755);
  });
  return { path: posixPathEnv(dir), log: log };
}

function writeRulesCache(m, boot, present) {
  fs.writeFileSync(m.rules, "boot=" + boot + "\npresent=" + present + "\n");
}

function runFail(dir, body, args, extraEnv) {
  try {
    runShell(dir, body, args, extraEnv);
  } catch (e) {
    return {
      status: e.status,
      stdout: e.stdout || "",
      stderr: e.stderr || ""
    };
  }
  throw new Error("expected the shell command to fail");
}

// 与 runShell 类似，但容忍非零退出（谓词回答「否」并不是错误）。
function runAllow(dir, body, args, extraEnv) {
  try {
    return { status: 0, stdout: runShell(dir, body, args, extraEnv), stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

function writeOutbound(m, opts) {
  const o = opts || {};
  fs.writeFileSync(m.outbound, JSON.stringify(fixture, null, o.pretty ? 2 : 0) + (o.newline ? "\n" : ""));
  fs.writeFileSync(m.meta, "id=" + (o.id || ID) + "\nhost=n.example.com\n");
}

// 界面把 state.json 序列化成带缩进的形式；shell 的提取逻辑依赖这种
// 形状（每个 settings 键独占一行）。
function writeStatePorts(m, settings, opts) {
  const o = opts || {};
  const state = Object.assign({ schema: 1, revision: 1, manual: [],
    subscriptions: [], selected: "" }, o.extra || {});
  if (settings !== undefined) { state.settings = settings; }
  fs.writeFileSync(m.state, JSON.stringify(state, null, 2) + "\n");
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const BODY_RENDER = '. "$KR_TEST_SCRIPT"; kr_render_config "$1"';
const BODY_ENSURE = '. "$KR_TEST_SCRIPT"; kr_ensure_config';
const BODY_STATUS = '. "$KR_TEST_SCRIPT"; kr_status_write "$1" "$2"';
const BODY_APPLY = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_apply "$1"';
const BODY_UNAPPLY = '. "$KR_TEST_SCRIPT"; kr_unapply';
const BODY_PORTS = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_apply_ports';
const BODY_START = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_start';
const BODY_STOP = '. "$KR_TEST_SCRIPT"; kr_stop';
const BODY_CLI = '. "$KR_TEST_SCRIPT"; kr_cli "$@"';
const BODY_SETTING_PORT = '. "$KR_TEST_SCRIPT"; kr_setting_port "$1" "$2"';

// ---- 配置模板渲染 -----------------------------------------------------------------

check("template: valid JSON with the quoted outbound placeholder", () => {
  const t = JSON.parse(fs.readFileSync(template, "utf8"));
  eq(t.outbounds[0], "__KERNELRAY_OUTBOUND__", "placeholder");
  eq(t.outbounds.length, 4, "outbound slots (proxy, direct, block, dns-out placeholder)");
  eq(t.inbounds[0].port, "__KERNELRAY_SOCKS_PORT__", "socks port placeholder");
  eq(t.inbounds[1].port, "__KERNELRAY_HTTP_PORT__", "http port placeholder");
  if (t.inbounds.indexOf("__KERNELRAY_TPROXY_INBOUND__") < 0) {
    throw new Error("the tproxy inbound placeholder is missing");
  }
  eq(t.dns, "__KERNELRAY_DNS__", "dns placeholder");
  eq(t.routing, "__KERNELRAY_ROUTING__", "routing placeholder");
  eq(t.log.loglevel, "__KERNELRAY_LOGLEVEL__", "log level placeholder");
});

check("render: no outbound is refused — the core only runs an applied node's config", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_RENDER, [""]);
  if (!/no node outbound/.test(r.stdout + r.stderr)) {
    throw new Error("expected the no-outbound refusal, got: " + (r.stdout + r.stderr));
  }
  if (fs.existsSync(m.config)) { throw new Error("no config must be created"); }
});

check("render: outbound.json is spliced verbatim, special characters included", () => {
  const m = makeModule();
  writeOutbound(m);
  const out = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (out.indexOf("__KERNELRAY") >= 0) {
    throw new Error("a placeholder survived rendering");
  }
  const cfg = JSON.parse(out);
  eq(cfg.log.loglevel, "warning", "log settings preserved");
  eq(cfg.inbounds.length, 3, "socks + http + tproxy: there is one form (docs/adr/0011)");
  eq(cfg.inbounds[0].port, 10808, "default socks port without state.json");
  eq(cfg.inbounds[1].port, 10809, "default http port without state.json");
  eq(cfg.outbounds.length, 4, "proxy + direct + block + dns-out");
  eq(cfg.outbounds[0], Object.assign({}, fixture,
    { streamSettings: Object.assign({}, fixture.streamSettings,
      { sockopt: { mark: 19282 } }) }), "the node outbound carries the bypass mark");
  eq(cfg.outbounds[1].tag, "direct", "direct tag");
  eq(cfg.outbounds[1].streamSettings.sockopt.mark, 19282, "direct bypass mark");
  eq(cfg.outbounds[2].tag, "block", "block tag");
  eq(cfg.dns.tag, "dns", "the dns module is always authored");
  eq(cfg.routing === undefined, false, "the routing block is always authored");
  eq(cfg.outbounds[0].settings.servers[0].password, fixture.settings.servers[0].password, "escaping round-trip");
});

check("render: a pretty-printed outbound file also works", () => {
  const m = makeModule();
  writeOutbound(m, { pretty: true, newline: true });
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.outbounds[0].settings.servers[0].password, fixture.settings.servers[0].password, "outbound");
});

// ---- 唯一的形态 -----------------------------------------------------------------------

check("render: tproxy inbound, dns module and routing are spliced in", () => {
  const m = makeModule();
  writeOutbound(m);
  const out = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (out.indexOf("__KERNELRAY") >= 0) {
    throw new Error("a placeholder survived rendering");
  }
  const cfg = JSON.parse(out);
  eq(cfg.inbounds.length, 3, "socks + http + tproxy");
  const tp = cfg.inbounds[2];
  eq(tp.tag, "tp-in", "tproxy tag");
  eq(tp.port, 10810, "tproxy port");
  eq(tp.protocol, "dokodemo-door", "tproxy protocol");
  eq(tp.settings.network, "tcp,udp", "tcp and udp");
  eq(tp.streamSettings.sockopt.tproxy, "tproxy", "sockopt tproxy");
  eq(cfg.outbounds.length, 4, "proxy + direct + block + dns-out");
  eq(cfg.outbounds[3], { tag: "dns-out", protocol: "dns", settings: {} }, "dns-out");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "node outbound carries the bypass mark");
  // 这个 dns 标签不是装饰：下面的分流规则按 inboundTag:["dns"] 匹配；没有它，
  // 核心会把模块自己的上游查询标记为 xray.system.<uuid> —— 这些查询随后落到
  // 端口 53 -> dns-out，模块最终变成自己问自己（ADR 0006）。
  eq(cfg.dns, { tag: "dns", servers: ["https://1.1.1.1/dns-query"], queryStrategy: "UseIPv4" }, "dns upstream: A-only, so apps never leak over v6");
  eq(cfg.routing.rules[0], {
    inboundTag: ["dns"], domain: ["full:n.example.com"], outboundTag: "direct"
  }, "the node host resolves through direct (bootstrap)");
  eq(cfg.routing.rules[1], { inboundTag: ["dns"], outboundTag: "proxy" }, "dns upstream goes through the proxy");
  eq(cfg.routing.rules[2], { network: "tcp,udp", port: 53, outboundTag: "dns-out" }, "port 53 to dns-out");
  eq(cfg.routing.rules.length, 3, "no other rules");
});

check("render: a pinned node address lands in the dns hosts", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(path.join(m.dir, "runtime", "nodeip"), "203.0.113.9\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.dns.hosts, { "full:n.example.com": "203.0.113.9" }, "hosts pin");
  eq(cfg.routing.rules[0].outboundTag, "direct", "bootstrap rule kept");
});

check("render: an IP node produces no bootstrap domain rule", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=203.0.113.10\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.routing.rules.length, 2, "only the dns and port-53 rules");
  eq(cfg.routing.rules[0], { inboundTag: ["dns"], outboundTag: "proxy" }, "dns upstream first");
});

check("render: an IPv6 node literal produces no bootstrap domain rule", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=2001:db8::1\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.routing.rules.length, 2, "only the dns and port-53 rules");
});

check("render: an outbound without the mark placeholder is refused", () => {
  const m = makeModule();
  // 旧版渲染器可能写出一条没有标记的节点出站；在接管之下它的数据包会被重新捕获回
  // 核心，形成路由环路。这样的渲染必须失败。
  fs.writeFileSync(m.outbound, JSON.stringify(fixture).replace(
    /,"sockopt":\{"mark":"__KERNELRAY_MARK__"\}/, ""));
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=n.example.com\n");
  const r = runFail(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (!/no bypass mark/.test(r.stdout + r.stderr)) {
    throw new Error("expected the mark refusal, got: " + (r.stdout + r.stderr));
  }
});

check("render: there is one form, so the form machinery is gone", () => {
  const m = makeModule();
  writeOutbound(m);
  const gone = runAllow(m.dir,
    '. "$KR_TEST_SCRIPT"; for f in kr_config_form kr_tp_form kr_tp_switch_on; do' +
    ' command -v "$f" >/dev/null 2>&1 && echo STILL-THERE $f; done');
  if (gone.stdout.includes("STILL-THERE")) {
    throw new Error("the form machinery is gone: " + gone.stdout);
  }
  // 每次渲染都带上接管各块：不存在第二种可供选择的形态。
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.inbounds.length, 3, "the tproxy inbound is always there");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "the mark is always live");
});

check("a template without the placeholder is refused", () => {
  const m = makeModule();
  fs.writeFileSync(path.join(m.dir, "config.example.json"), '{"outbounds":[]}\n');
  const r = runFail(m.dir, BODY_RENDER, [""]);
  if (!/placeholder/.test(r.stdout + r.stderr)) {
    throw new Error("expected a placeholder error, got: " + (r.stdout + r.stderr));
  }
});

// ---- 入站端口 ---------------------------------------------------------------------

check("render: the inbound ports come from state.json's settings", () => {
  const m = makeModule();
  writeStatePorts(m, { socksPort: 12008, httpPort: 12009 });
  writeOutbound(m);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.inbounds[0].port, 12008, "socks");
  eq(cfg.inbounds[1].port, 12009, "http");
});

check("render: a broken or out-of-range port falls back per field", () => {
  const m = makeModule();
  writeOutbound(m);
  writeStatePorts(m, { socksPort: "11008", httpPort: "not a port" });
  let cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.inbounds[0].port, 10808, "a quoted (hand-edited) value is not trusted");
  eq(cfg.inbounds[1].port, 10809, "junk falls back to the default");

  writeStatePorts(m, { socksPort: 70000, httpPort: 0 });
  cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.inbounds[0].port, 10808, "out of range falls back");
  eq(cfg.inbounds[1].port, 10809, "zero falls back");

  writeStatePorts(m, {});
  cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.inbounds[0].port, 10808, "missing settings object falls back");
  eq(cfg.inbounds[1].port, 10809, "http too");
});

check("ports: a stopped core gets the re-rendered config", () => {
  const m = makeModule();
  writeStatePorts(m, { socksPort: 13008, httpPort: 13009 });
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_PORTS);
  const cfg = readJson(m.config);
  eq(cfg.inbounds[0].port, 13008, "socks");
  eq(cfg.inbounds[1].port, 13009, "http");
  eq(cfg.outbounds[0].settings, fixture.settings, "the applied node is re-rendered as-is");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id untouched");
  eq(readJson(m.status).state, "stopped", "state");
});

check("ports: without an applied node the change is refused", () => {
  const m = makeModule();
  writeStatePorts(m, { socksPort: 13008, httpPort: 13009 });
  writeOutbound(m);
  const r = runFail(m.dir, BODY_PORTS);
  if (!/no applied node/.test(r.stderr)) {
    throw new Error("expected the no-node refusal, got: " + r.stderr);
  }
  if (fs.existsSync(m.config)) { throw new Error("no config must be created"); }
});

check("ports: a broken applied bookkeeping is refused, applied id kept", () => {
  const m = makeModule();
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  fs.writeFileSync(m.applied, ID + "\n");
  writeStatePorts(m, { socksPort: 13008, httpPort: 13009 });
  writeOutbound(m, { id: OTHER_ID });
  const r = runFail(m.dir, BODY_PORTS);
  if (!/does not belong to node/.test(r.stderr)) {
    throw new Error("expected the bookkeeping refusal, got: " + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "old config untouched");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id kept");
});

check("ports: a failed xray -test leaves config.json and the applied id untouched", () => {
  const m = makeModule();
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  fs.writeFileSync(m.applied, ID + "\n");
  writeStatePorts(m, { socksPort: 13008, httpPort: 13009 });
  writeOutbound(m);
  const r = runFail(m.dir, BODY_PORTS, [], { FAKE_XRAY_FAIL: "1" });
  if (!/config test failed/.test(r.stderr)) {
    throw new Error("expected a config-test error, got: " + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "old config untouched");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "old applied id untouched");
});

// ---- 日志等级 (log level) ---------------------------------------------------------------

check("render: the log level comes from runtime/loglevel, defaulting to 警告", () => {
  const m = makeModule();
  writeOutbound(m);
  let cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.log.loglevel, "warning", "no preference file: the default");
  ["none", "error", "info", "debug"].forEach((lv) => {
    fs.writeFileSync(m.loglevel, lv + "\n");
    cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
    eq(cfg.log.loglevel, lv, lv);
  });
  fs.writeFileSync(m.loglevel, "warning\n");
  cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.log.loglevel, "warning", "the explicit default");
  fs.writeFileSync(m.loglevel, "DEBUG\n");
  cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.log.loglevel, "warning", "an unknown value falls back to the default");
});

check("render: a template without the log level placeholder is refused", () => {
  const m = makeModule();
  writeOutbound(m);
  const tmpl = path.join(m.dir, "config.example.json");
  const t = JSON.parse(fs.readFileSync(tmpl, "utf8"));
  delete t.log.loglevel;
  fs.writeFileSync(tmpl, JSON.stringify(t));
  const r = runFail(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (!/loglevel placeholder/.test(r.stdout + r.stderr)) {
    throw new Error("expected a loglevel placeholder refusal, got: " + (r.stdout + r.stderr));
  }
});

check("loglevel: the CLI writes the preference and leaves config.json alone", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_APPLY, [ID]);
  const before = fs.readFileSync(m.config, "utf8");
  runShell(m.dir, BODY_CLI, ["loglevel", "debug"]);
  eq(fs.readFileSync(m.loglevel, "utf8").trim(), "debug", "preference written");
  eq(fs.readFileSync(m.config, "utf8"), before, "config.json untouched");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id untouched");
  const st = runShell(m.dir, BODY_CLI, ["loglevel", "status"]);
  if (!/^level=debug$/m.test(st) || !/^active=warning$/m.test(st) || !/^pending=0$/m.test(st)) {
    throw new Error("unexpected loglevel status:\n" + st);
  }
  runShell(m.dir, BODY_CLI, ["loglevel", "warning"]);
  if (fs.existsSync(m.loglevel)) { throw new Error("setting the default must remove the file"); }
});

check("loglevel: an unknown level is a usage error and changes nothing", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_CLI, ["loglevel", "verbose"]);
  eq(r.status, 2, "exit code");
  if (fs.existsSync(m.loglevel)) { throw new Error("no preference must be written"); }
});

check("start: a saved log level is re-rendered before the core runs", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  runShell(m.dir, BODY_APPLY, [ID]);
  runShell(m.dir, BODY_START);
  runShell(m.dir, BODY_CLI, ["loglevel", "debug"]);
  // 运行中的配置仍是旧的那份：正是 UI 警告用户会出现的那个状态。
  eq(readJson(m.config).log.loglevel, "warning", "config untouched before the next start");
  const pending = runShell(m.dir, BODY_CLI, ["status"]);
  if (!/^loglevel=debug$/m.test(pending) || !/^loglevelpending=1$/m.test(pending)) {
    throw new Error("expected loglevelpending=1 while the core runs, got:\n" + pending);
  }
  runShell(m.dir, BODY_STOP);
  runShell(m.dir, BODY_START);
  eq(readJson(m.config).log.loglevel, "debug", "the next start re-renders the new level");
  const after = runShell(m.dir, BODY_CLI, ["status"]);
  if (!/^loglevelpending=0$/m.test(after)) {
    throw new Error("expected loglevelpending=0 after the restart, got:\n" + after);
  }
  runShell(m.dir, BODY_STOP);
});

// ---- kr_ensure_config -------------------------------------------------------------------

check("ensure: no config and no applied node refuses to create one", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_ENSURE);
  if (!/no applied node/.test(r.stdout + r.stderr)) {
    throw new Error("expected the no-node refusal, got: " + r.stdout + r.stderr);
  }
  if (fs.existsSync(m.config)) { throw new Error("no config must be created"); }
});

check("ensure: a deleted config is rebuilt from the applied outbound", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_ENSURE);
  const cfg = readJson(m.config);
  eq(cfg.outbounds[0].settings, fixture.settings, "applied outbound");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "the bypass mark is always live");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id kept");
});

check("ensure: an applied id whose outbound is gone is refused, not taken from disk", () => {
  const m = makeModule();
  // 这里曾是「形态比对」的守卫：磁盘上那份配置背后没有渲染出的节点出站，它什么也
  // 描述不了，因此绝不能被运行（ADR 0010）。
  fs.writeFileSync(m.meta, "id=" + OTHER_ID + "\nhost=n.example.com\n");
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  const r = runFail(m.dir, BODY_ENSURE);
  if (!/no rendered outbound/.test(r.stdout + r.stderr)) {
    throw new Error("expected the no-outbound refusal, got: " + r.stdout + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "config untouched");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id is kept, never silently cleared");
});

check("ensure: a failed switch keeps the applied node's config, it does not render the other node", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m, { id: OTHER_ID });   // 用户尝试的那个节点
  fs.writeFileSync(m.applied, ID + "\n");
  // 回滚留下的东西：这个节点的核心配置。
  const cfg = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  fs.writeFileSync(m.config, cfg);
  runShell(m.dir, BODY_ENSURE);
  eq(fs.readFileSync(m.config, "utf8"), cfg, "the old node's config is kept, not re-rendered");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id untouched");
});

check("start: without an applied node the core stays stopped (no-node)", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_START);
  if (!/no applied node/.test(r.stderr)) {
    throw new Error("expected the start refusal, got: " + r.stderr);
  }
  const st = readJson(m.status);
  eq(st.state, "stopped", "state");
  eq(st.phase, "no-node", "phase");
  if (fs.existsSync(m.config)) { throw new Error("no config must be created"); }
});

check("start: an applied id without its outbound fails with no-config", () => {
  const m = makeModule();
  fs.writeFileSync(m.applied, ID + "\n");
  const r = runFail(m.dir, BODY_START);
  if (!/no rendered outbound/.test(r.stdout + r.stderr)) {
    throw new Error("expected the bookkeeping refusal, got: " + r.stdout + r.stderr);
  }
  const st = readJson(m.status);
  eq(st.state, "failed", "state");
  eq(st.phase, "no-config", "phase");
  if (fs.existsSync(m.config)) { throw new Error("no config must be created"); }
});

// ---- kr_apply ---------------------------------------------------------------------------

check("apply: a stopped core gets the new config and the applied id", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_APPLY, [ID]);
  const cfg = readJson(m.config);
  eq(cfg.outbounds[0].settings, fixture.settings, "config carries the node outbound");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "the bypass mark is always live");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id");
  const st = readJson(m.status);
  eq(st.state, "stopped", "state");
  eq(st.phase, "idle", "phase");
  eq(st.node, ID, "status node");
  if (process.platform !== "win32") {
    eq(fs.statSync(m.config).mode & 0o777, 0o600, "config mode");
  }
});

check("apply: a failed xray -test leaves config.json and the applied id untouched", () => {
  const m = makeModule();
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  fs.writeFileSync(m.applied, OTHER_ID + "\n");
  writeOutbound(m);
  const r = runFail(m.dir, BODY_APPLY, [ID], { FAKE_XRAY_FAIL: "1" });
  if (!/config test failed/.test(r.stderr)) {
    throw new Error("expected a config-test error, got: " + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "old config untouched");
  eq(fs.readFileSync(m.applied, "utf8").trim(), OTHER_ID, "old applied id untouched");
});

check("apply: outbound.json and outbound.meta must agree on the id", () => {
  const m = makeModule();
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  writeOutbound(m, { id: OTHER_ID });
  const r = runFail(m.dir, BODY_APPLY, [ID]);
  if (!/does not belong/.test(r.stderr)) {
    throw new Error("expected an id-mismatch error, got: " + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "config untouched");
  if (fs.existsSync(m.applied)) { throw new Error("applied id must not be written"); }
});

check("apply: no outbound.json is an error, not an idle apply", () => {
  const m = makeModule();
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  const r = runFail(m.dir, BODY_APPLY, [ID]);
  if (!/no rendered outbound/.test(r.stderr)) {
    throw new Error("expected a missing-outbound error, got: " + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "config untouched");
});

check("apply: an invalid id is refused before anything is read", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_APPLY, ["bad id"]);
  if (!/invalid node id/.test(r.stderr)) {
    throw new Error("expected an invalid-id error, got: " + r.stderr);
  }
});

check("apply: a candidate that tests but does not start is rolled back", () => {
  const m = makeModule(loopingCore);
  try {
    // 核心运行的是「旧」节点的核心配置；候选配置（夹具节点）能通过测试，却在启动后
    // 立刻退出，因此换入操作必须恢复先前的配置。
    const oldFixture = JSON.parse(JSON.stringify(fixture));
    oldFixture.settings.servers[0].address = "old.example.com";
    fs.writeFileSync(m.outbound, JSON.stringify(oldFixture));
    fs.writeFileSync(m.meta, "id=" + OTHER_ID + "\nhost=old.example.com\n");
    fs.writeFileSync(m.applied, OTHER_ID + "\n");
    runShell(m.dir, BODY_START);
    eq(readJson(m.status).state, "running", "the old node's core did start");

    writeOutbound(m);
    const r = runFail(m.dir, BODY_APPLY, [ID]);
    if (!/previous config restored/.test(r.stderr)) {
      throw new Error("expected a rollback error, got: " + r.stderr);
    }

    const cfg = readJson(m.config);
    eq(cfg.outbounds[0].settings.servers[0].address, "old.example.com", "previous config restored");
    eq(fs.readFileSync(m.applied, "utf8").trim(), OTHER_ID, "old applied id restored");
    const st = readJson(m.status);
    eq(st.state, "running", "restored core is running");
    eq(st.node, OTHER_ID, "the applied node after rollback");
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
});

check("apply: a failed start with no previous config leaves the core stopped with no node", () => {
  const m = makeModule(loopingCore);
  try {
    const oldFixture = JSON.parse(JSON.stringify(fixture));
    oldFixture.settings.servers[0].address = "old.example.com";
    fs.writeFileSync(m.outbound, JSON.stringify(oldFixture));
    fs.writeFileSync(m.meta, "id=" + OTHER_ID + "\nhost=old.example.com\n");
    fs.writeFileSync(m.applied, OTHER_ID + "\n");
    runShell(m.dir, BODY_START);
    eq(readJson(m.status).state, "running", "the old node's core did start");
    // 核心还在运行时先前那份配置消失了，换入操作便无物可回滚：核心必须停下来，
    // 而不是退回到任何别的东西。
    fs.unlinkSync(m.config);

    writeOutbound(m);
    const r = runFail(m.dir, BODY_APPLY, [ID]);
    if (!/no previous config/.test(r.stderr)) {
      throw new Error("expected the no-rollback error, got: " + r.stderr);
    }
    if (fs.existsSync(m.config)) { throw new Error("the failed candidate must be dropped"); }
    if (fs.existsSync(m.applied)) { throw new Error("the applied id is void without a config"); }
    const st = readJson(m.status);
    eq(st.state, "stopped", "state");
    eq(st.phase, "no-node", "phase");
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
});

// ---- kr_unapply -------------------------------------------------------------------------

check("unapply: config, applied id and the rendered outbound all go, status says no-node", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  runShell(m.dir, BODY_UNAPPLY);
  if (fs.existsSync(m.config)) { throw new Error("config.json must be removed"); }
  if (fs.existsSync(m.applied)) { throw new Error("runtime/applied must be removed"); }
  if (fs.existsSync(m.outbound)) { throw new Error("outbound.json must be removed"); }
  if (fs.existsSync(m.meta)) { throw new Error("outbound.meta must be removed"); }
  const st = readJson(m.status);
  eq(st.state, "stopped", "state");
  eq(st.phase, "no-node", "phase");
  eq(st.node, "", "node");
});

check("unapply: nothing applied is an idempotent success", () => {
  const m = makeModule();
  runShell(m.dir, BODY_UNAPPLY);
  const st = readJson(m.status);
  eq(st.state, "stopped", "state");
  eq(st.phase, "no-node", "phase");
  if (fs.existsSync(m.config)) { throw new Error("no config must appear"); }
});

check("unapply: a running core is refused and keeps its config and applied id", () => {
  const m = makeModule(loopingCore);
  try {
    const oldFixture = JSON.parse(JSON.stringify(fixture));
    oldFixture.settings.servers[0].address = "old.example.com";
    fs.writeFileSync(m.outbound, JSON.stringify(oldFixture));
    fs.writeFileSync(m.meta, "id=" + OTHER_ID + "\nhost=old.example.com\n");
    fs.writeFileSync(m.applied, OTHER_ID + "\n");
    runShell(m.dir, BODY_START);
    eq(readJson(m.status).state, "running", "the core did start");

    const r = runFail(m.dir, BODY_UNAPPLY);
    if (!/core is running/.test(r.stderr)) {
      throw new Error("expected the running refusal, got: " + r.stderr);
    }
    if (!fs.existsSync(m.config)) { throw new Error("a running core's config must stay"); }
    eq(fs.readFileSync(m.applied, "utf8").trim(), OTHER_ID, "applied id kept");
    eq(readJson(m.status).state, "running", "status untouched");
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
});

// ---- 状态簿记 -----------------------------------------------------------------

check("status: status.json records the applied id", () => {
  const m = makeModule();
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_STATUS, ["running", "idle"]);
  const st = readJson(m.status);
  eq(st.state, "running", "state");
  eq(st.phase, "idle", "phase");
  eq(st.node, ID, "node");
});

check("status: an invalid applied file is reported as no node", () => {
  const m = makeModule();
  fs.writeFileSync(m.applied, "not a node id\n");
  runShell(m.dir, BODY_STATUS, ["stopped", "idle"]);
  eq(readJson(m.status).node, "", "node");
});

check("status: a core that died on its own is reported as crashed, not as the stale phase", () => {
  const m = makeModule();
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(path.join(m.dir, "runtime", "started"),
    String(Math.floor(Date.now() / 1000)) + "\n");
  fs.writeFileSync(path.join(m.dir, "runtime", "xray.pid"), "999999\n");
  runShell(m.dir, BODY_STATUS, ["running", "idle"]);
  const kv = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv');
  if (!/^state=stopped$/m.test(kv)) { throw new Error("state: " + kv); }
  if (!/^phase=crashed$/m.test(kv)) {
    throw new Error("a pidfile that outlived its process is a crash, not idle: " + kv);
  }
});

check("status: a stopped core is not reported as crashed", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_START);
  runShell(m.dir, BODY_STOP);
  // 停止核心会把接管规则留在位上（失败关闭，docs/adr/0004）：缓存里仍然写着
  // 值 present，因为捕获确实还在。
  if (!/^present=1$/m.test(fs.readFileSync(m.rules, "utf8"))) {
    throw new Error("a stop leaves the capture up, so the cache must say present");
  }
  const kv = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv');
  if (/^phase=crashed$/m.test(kv)) { throw new Error("a stop is not a crash: " + kv); }
  if (!/^state=stopped$/m.test(kv)) { throw new Error("state: " + kv); }
});

check("status: status.json records the boot that wrote it", () => {
  const m = makeModule();
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo boot-x; }; kr_status_write running idle');
  eq(readJson(m.status).boot, "boot-x", "boot");
});

// 由于 procfs 文件上报的 stat 大小是 0，[ -s ] 守卫在真实设备上会让 kr_boot_id
// 变成空值，尽管文件里确实有内容。只有 Linux CI 能跑到真实文件。
check("status: kr_boot_id reads a procfs file whose stat size is zero", () => {
  if (!fs.existsSync("/proc/sys/kernel/random/boot_id")) { return; } // 这里（Git Bash）没有 procfs
  const m = makeModule();
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_boot_id').trim();
  if (!out) { throw new Error("kr_boot_id returned empty for a procfs boot id"); }
});

// 开机时已没有任何东西会重写 status.json（docs/adr/0018），所以重启后留下的那份文件是
// 常态而非边缘情况：它的 phase 属于过去，不是现在。
check("status: a status.json from an earlier boot reads as idle, not as its old phase", () => {
  const m = makeModule();
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(m.status, JSON.stringify({
    state: "running", phase: "failed/rules", started: 1, revision: 0,
    node: ID, tproxy: "on", route: "global", boot: "the-previous-boot"
  }) + "\n");
  fs.writeFileSync(path.join(m.dir, "runtime", "xray.pid"), "999999\n");
  const kv = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_status_kv');
  if (!/^phase=idle$/m.test(kv)) {
    throw new Error("another boot's status is the past, not a failure: " + kv);
  }
  if (!/^state=stopped$/m.test(kv)) { throw new Error("state: " + kv); }
});

check("status: a pidfile written by this boot is still evidence of a crash", () => {
  const m = makeModule();
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(m.status, JSON.stringify({
    state: "running", phase: "idle", started: 1, revision: 0,
    node: ID, tproxy: "on", route: "global", boot: "the-current-boot"
  }) + "\n");
  fs.writeFileSync(path.join(m.dir, "runtime", "xray.pid"), "999999\n");
  const kv = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_status_kv');
  if (!/^phase=crashed$/m.test(kv)) {
    throw new Error("a pidfile from this boot means the core died: " + kv);
  }
});

// ---- 规则在位缓存 (docs/adr/0019) -------------------------------------------------

check("status: a valid rule cache answers present without asking iptables", () => {
  const m = makeModule();
  writeRulesCache(m, "the-current-boot", 1);
  const stub = makeIptablesStub(m, true);
  const kv = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_status_kv',
    [], { PATH: stub.path });
  if (!/^rules=present$/m.test(kv)) { throw new Error(kv); }
  if (fs.existsSync(stub.log)) {
    throw new Error("the poll asked iptables: " + fs.readFileSync(stub.log, "utf8"));
  }
});

check("status: a stale rule cache forces one real check and is repaired", () => {
  const m = makeModule();
  writeRulesCache(m, "the-previous-boot", 1);
  const stub = makeIptablesStub(m, false); // 内核说规则已消失
  const body = '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_status_kv';
  const first = runShell(m.dir, body, [], { PATH: stub.path });
  if (!/^rules=absent$/m.test(first)) { throw new Error(first); }
  const calls = fs.readFileSync(stub.log, "utf8").trim().split("\n");
  eq(calls.length, 1, "one probe: a missing family answers before the second");
  const cache = fs.readFileSync(m.rules, "utf8");
  if (!/^boot=the-current-boot$/m.test(cache) || !/^present=0$/m.test(cache)) {
    throw new Error("cache not repaired:\n" + cache);
  }
  const second = runShell(m.dir, body, [], { PATH: stub.path });
  if (!/^rules=absent$/m.test(second)) { throw new Error(second); }
  eq(fs.readFileSync(stub.log, "utf8").trim().split("\n").length, 1,
    "the repaired cache is used without another probe");
});

check("status: a missing rule cache is answered by one check and written back", () => {
  const m = makeModule();
  const stub = makeIptablesStub(m, true);
  const kv = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_status_kv',
    [], { PATH: stub.path });
  if (!/^rules=present$/m.test(kv)) { throw new Error(kv); }
  const calls = fs.readFileSync(stub.log, "utf8").trim().split("\n");
  eq(calls.length, 2, "one probe per family when both are present");
  const cache = fs.readFileSync(m.rules, "utf8");
  if (!/^boot=the-current-boot$/m.test(cache) || !/^present=1$/m.test(cache)) {
    throw new Error("cache not written:\n" + cache);
  }
});

check("rules cache: install records present=1 and remove records present=0", () => {
  const m = makeModule();
  const stub = makeIptablesStub(m, true); // 规则已在位：安装提前返回
  const env = { PATH: stub.path };
  runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_tp_install',
    [], env);
  if (!/^present=1$/m.test(fs.readFileSync(m.rules, "utf8"))) {
    throw new Error("install did not record presence");
  }
  runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_tp_remove',
    [], env);
  if (!/^present=0$/m.test(fs.readFileSync(m.rules, "utf8"))) {
    throw new Error("remove did not record absence");
  }
});

check("status: the poll never runs the core", () => {
  const m = makeModule();
  const calls = path.join(m.dir, "version.calls");
  const core = [
    "#!/bin/sh",
    'if [ "$1" = "-version" ]; then',
    '  echo called >>"' + shPath(calls) + '"',
    '  echo "Xray 0.0.0 (test)"',
    "  exit 0",
    "fi",
    "exit 0",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(m.dir, "bin", "xray"), core, "utf8");
  fs.chmodSync(path.join(m.dir, "bin", "xray"), 0o755);
  const kv = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_boot_id() { echo the-current-boot; }; kr_status_kv');
  if (/^version=/m.test(kv)) { throw new Error(kv); }
  if (fs.existsSync(calls)) {
    throw new Error("the poll ran the core: " + fs.readFileSync(calls, "utf8"));
  }
});

// ---- 启动路径修补 ------------------------------------------------------------------

check("start: a config written before 启动即接管 is re-rendered in the one form", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  // 旧版本留下的东西：一份没有 tproxy 入站、标记也为 0 的直连运行配置。在规则之下
  // 运行它什么也捕获不到；不带规则运行它又会留下一个只有本地入站的核心。启动路径
  // 改为重新渲染（docs/adr/0011）。
  fs.writeFileSync(m.config, JSON.stringify({ sentinel: "stale" }));
  runShell(m.dir, BODY_START);
  const after = fs.readFileSync(m.config, "utf8");
  if (!/"tag":"tp-in"/.test(after)) {
    throw new Error("the start must re-render the takeover form: " + after);
  }
  if (!/"mark":19282/.test(after)) {
    throw new Error("the node outbound must carry the bypass mark: " + after);
  }
  runShell(m.dir, BODY_STOP);
});

check("start: a config that already matches this start is left alone", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  const cfg = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  fs.writeFileSync(m.config, cfg);
  const before = fs.statSync(m.config).mtimeMs;
  runShell(m.dir, BODY_START);
  eq(fs.readFileSync(m.config, "utf8"), cfg, "the config is not rewritten");
  eq(fs.statSync(m.config).mtimeMs, before, "not even touched");
  runShell(m.dir, BODY_STOP);
});

// ---- 启动就绪与进程发现 ----------------------------------------------

check("start readiness: the socks port is read from config.json, not from state.json", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  // 已应用的核心配置带着 18080；state.json 随后写成 10808。一次从未被应用的端口修改，
  // 不该让启动去等一个没有任何东西监听的端口。
  writeStatePorts(m, { socksPort: 18080, httpPort: 10809 });
  fs.writeFileSync(m.config, runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { TP: "0" }));
  writeStatePorts(m, { socksPort: 10808, httpPort: 10809 });
  const port = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_conf_socks_port').trim();
  eq(port, "18080", "the port config.json carries");
  fs.unlinkSync(m.config);
  const r = runAllow(m.dir, '. "$KR_TEST_SCRIPT"; kr_conf_socks_port');
  eq(r.status, 1, "no config, no port");
  eq(r.stdout.trim(), "", "and nothing printed");
});

check("start readiness: /proc/net/tcp parsing finds a listener on 127.0.0.1", () => {
  const m = makeModule();
  const net = path.join(m.dir, "net-tcp.fixture");
  const line = (local, st) => "  3: " + local + " 00000000:0000 " + st +
    " 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0";
  fs.writeFileSync(net, [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    line("0100007F:46A0", "0A"), // 18080 正在监听
    line("00000000:46A0", "0A"), // 通配地址上的 18080：不是我们的入站
    line("0100007F:2A38", "01"), // 10808 已建立连接，未在监听
    line("0100007F:2A38", "0A"), // 10808 正在监听
    ""
  ].join("\n"));
  const env = { KR_NET_TCP: shPath(net) };
  const body = '. "$KR_TEST_SCRIPT"; kr_port_listening "$1"';
  eq(runAllow(m.dir, body, ["18080"], env).status, 0, "a listener on 127.0.0.1");
  eq(runAllow(m.dir, body, ["10808"], env).status, 0, "a second listener, matched by port");
  eq(runAllow(m.dir, body, ["10809"], env).status, 1, "nothing listening on that port");
  eq(runAllow(m.dir, body, [""], env).status, 1, "an empty port is not a listener");
  eq(runAllow(m.dir, body, ["abc"], env).status, 1, "nor is a non-numeric one");
});

check("start readiness: a core that exits is reported before the deadline", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { TP: "0" });
  const cfg = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { TP: "0" });
  fs.writeFileSync(m.config, cfg);
  // 200 x 1 s 的截止时间：通过这个测试意味着进程死亡是被察觉到的，而不是等出来的。
  const r = runAllow(m.dir, '. "$KR_TEST_SCRIPT"; kr_core_wait_ready "$1"', ["999999"],
    { KR_START_POLLS: "200", KR_START_STEP: "1" });
  eq(r.status, 1, "a dead pid is not ready");
});

check("start readiness: a live core that never listens still counts as started", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(m.config, runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { TP: "0" }));
  // 假核心活着且不监听：截止时间才是答案，慢并不等于失败。
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; sleep 5 & p=$!; kr_core_wait_ready "$p"; echo "rc=$?"; kill $p 2>/dev/null',
    null, { KR_START_POLLS: "2", KR_START_STEP: "0.01" });
  if (!/rc=0/.test(out)) { throw new Error("expected rc=0, got: " + out); }
});

check("core pids: a process running the core with our config is found, one without is not", () => {
  const m = makeModule(aliveCore);
  // 核心进程由测试用的 harness shell 内部启动，与 kr_start 启动它们的方式一致：
  // 其中 argv[0] 是二进制路径（带有 `xray`），随后是 `run -c <config>`。由 Node
  // 派生出的进程不在 Git Bash 的 /proc 表里，所以扫描在那里什么也找不到。
  const body = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray";' +
    ' "$KR_MODDIR/bin/xray" run -c "$1" & p1=$!;' +
    ' "$KR_MODDIR/bin/xray" run -c "$2" & p2=$!;' +
    ' "$KR_MODDIR/bin/xray" -test & p3=$!;' +
    ' sleep 0.4;' +
    ' echo "p1=$p1"; echo "p2=$p2"; echo "p3=$p3";' +
    ' kr_core_pids | sed "s/^/pid=/";' +
    ' kill $p1 $p2 $p3 2>/dev/null; true';
  const out = runShell(m.dir, body, [shPath(m.config), shPath(m.state)]);
  const got = out.split(/\r?\n/).filter(Boolean);
  const pid = (name) => {
    const hit = got.filter((l) => l.indexOf(name + "=") === 0)[0];
    return hit ? hit.slice(name.length + 1) : "";
  };
  const listed = got.filter((l) => l.indexOf("pid=") === 0).map((l) => l.slice(4));
  if (listed.indexOf(pid("p1")) < 0) {
    throw new Error("our core (" + pid("p1") + ") not found in: " + listed.join(" "));
  }
  if (listed.indexOf(pid("p2")) >= 0) {
    throw new Error("a core running another config (" + pid("p2") + ") must not match");
  }
  if (listed.indexOf(pid("p3")) >= 0) {
    throw new Error("a process that only mentions xray (" + pid("p3") + ") must not match");
  }
});

check("core probe: one -version execution per shell, however often it is asked", () => {
  const m = makeModule();
  const counter = path.join(m.dir, "version-calls");
  const counting = [
    "#!/bin/sh",
    'if [ "$1" = "-version" ]; then',
    '  echo x >> "' + shPath(counter) + '"',
    '  echo "Xray 0.0.0 (test)"',
    "  exit 0",
    "fi",
    "exit 0",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(m.dir, "bin", "xray"), counting, "utf8");
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray";' +
    ' kr_core_works && kr_core_works && kr_core_version && kr_version_refresh');
  eq(out.trim(), "Xray 0.0.0 (test)", "the probe still answers");
  eq(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1, "one probe, one process");
});

check("core probe: a core that does not execute is remembered as unusable", () => {
  const m = makeModule();
  const counter = path.join(m.dir, "version-calls");
  const broken = [
    "#!/bin/sh",
    'echo x >> "' + shPath(counter) + '"',
    "exit 3",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(m.dir, "bin", "xray"), broken, "utf8");
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray";' +
    ' kr_core_works || echo "works=no"; kr_core_works || echo "works=no";' +
    ' kr_version_refresh; echo "refresh=$?"');
  eq(out.trim().split("\n").join("|"), "works=no|works=no|refresh=0", "both refusals, no error");
  eq(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1, "one probe, one process");
});

// ---- 一次渲染，一次测试 (docs/adr/0017) ------------------------------------------------

// 一个会记录每一次 `-test` 的核心，这样测试就能数清一次手势要花几次。
const countingCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then',
  '  [ -n "$FAKE_TEST_LOG" ] && echo t >> "$FAKE_TEST_LOG"',
  "  exit 0",
  "fi",
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  trap "exit 0" TERM INT',
  "  while :; do sleep 0.2; done",
  "fi",
  "exit 0",
  ""
].join("\n");

function testCount(log) {
  if (!fs.existsSync(log)) { return 0; }
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
}

function otherOutbound(m) {
  const other = JSON.parse(JSON.stringify(fixture));
  other.settings.servers[0].password = "other-node";
  fs.writeFileSync(m.outbound, JSON.stringify(other));
  fs.writeFileSync(m.meta, "id=" + OTHER_ID + "\nhost=n.example.com\n");
}

check("switch: one config test, and the start it triggers adds none", () => {
  const m = makeModule(countingCore);
  const log = path.join(m.dir, "tests.log");
  const env = { FAKE_TEST_LOG: shPath(log) };
  try {
    writeOutbound(m);
    runShell(m.dir, BODY_APPLY, [ID], env);
    eq(testCount(log), 1, "the first apply tests its candidate once");
    runShell(m.dir, BODY_START, [], env);
    eq(testCount(log), 1, "the start does not repeat the test the swap already passed");
    eq(readJson(m.status).state, "running", "the core is up");

    otherOutbound(m);
    runShell(m.dir, BODY_APPLY, [OTHER_ID], env);
    eq(testCount(log), 2, "a switch tests once: no engage re-render, no start re-test");
    eq(readJson(m.status).state, "running", "the core is back up on the new node");
    eq(readJson(m.config).outbounds[0].settings.servers[0].password, "other-node",
      "the config carries the new node");
    eq(fs.readFileSync(m.applied, "utf8").trim(), OTHER_ID, "applied id");
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
});

check("apply: the bytes already on disk are neither tested nor restarted", () => {
  const m = makeModule(countingCore);
  const log = path.join(m.dir, "tests.log");
  const env = { FAKE_TEST_LOG: shPath(log) };
  const pidFile = path.join(m.dir, "runtime", "xray.pid");
  try {
    writeOutbound(m);
    runShell(m.dir, BODY_APPLY, [ID], env);
    runShell(m.dir, BODY_START, [], env);
    const pid = fs.readFileSync(pidFile, "utf8").trim();
    // 同一节点、同样的字节：不测试、不停止、不启动 —— 流量中断为零。
    runShell(m.dir, BODY_APPLY, [ID], env);
    eq(testCount(log), 1, "no second test");
    eq(fs.readFileSync(pidFile, "utf8").trim(), pid, "the same core process, never restarted");
    eq(readJson(m.status).state, "running", "still running");
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
});

check("ports: saving the ports that are already rendered restarts nothing", () => {
  const m = makeModule(countingCore);
  const log = path.join(m.dir, "tests.log");
  const env = { FAKE_TEST_LOG: shPath(log) };
  const pidFile = path.join(m.dir, "runtime", "xray.pid");
  try {
    // 配置模板自带的默认值：保存它们不改变任何一个字节。
    writeStatePorts(m, { socksPort: 10808, httpPort: 10809 });
    writeOutbound(m);
    runShell(m.dir, BODY_APPLY, [ID], env);
    runShell(m.dir, BODY_START, [], env);
    const pid = fs.readFileSync(pidFile, "utf8").trim();
    runShell(m.dir, BODY_PORTS, [], env);
    eq(testCount(log), 1, "no test");
    eq(fs.readFileSync(pidFile, "utf8").trim(), pid, "no restart");
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
});

check("ensure: a failed switch whose config fails xray -test is refused, not run", () => {
  const m = makeModule();
  writeOutbound(m, { id: OTHER_ID });
  fs.writeFileSync(m.applied, ID + "\n");
  // 回滚留下的那串字节没有任何东西为它背书（没有 config.tested）：它们同样要过
  // 测试闸门，一旦被拒绝就拒绝启动，而不是把它们跑起来。
  fs.writeFileSync(m.config, '{"sentinel":true}\n');
  const r = runFail(m.dir, BODY_ENSURE, [], { FAKE_XRAY_FAIL: "1" });
  if (!/config test failed/.test(r.stderr)) {
    throw new Error("expected the test refusal, got: " + r.stdout + r.stderr);
  }
  eq(readJson(m.config), { sentinel: true }, "the config is not silently rewritten");
});

// ---- 轮询与日志处理 ---------------------------------------------------------------

check("ports: kr_setting_port keeps the caller's positional parameters", () => {
  const m = makeModule();
  writeStatePorts(m, { socksPort: 12008, httpPort: 12009 });
  eq(runShell(m.dir, BODY_SETTING_PORT, ["socksPort", "10808"]).trim(), "12008", "socks");
  eq(runShell(m.dir, BODY_SETTING_PORT, ["httpPort", "10809"]).trim(), "12009", "http");
  eq(runShell(m.dir, BODY_SETTING_PORT, ["nope", "7777"]).trim(), "7777", "unknown key");
});

check("status: log sizes are reported only when the log page asks", () => {
  const m = makeModule();
  const log = path.join(m.dir, "logs", "xray.log");
  const mlog = path.join(m.dir, "logs", "kernelray.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "12345");
  fs.writeFileSync(mlog, "1234567");
  const plain = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv');
  if (/^logsize=/m.test(plain)) { throw new Error("the plain status must stay small"); }
  const withLog = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv log');
  if (!/^logsize=5$/m.test(withLog)) { throw new Error("logsize: " + withLog); }
  if (!/^mlogsize=7$/m.test(withLog)) { throw new Error("mlogsize: " + withLog); }
});

check("kr_log: the tag rides the line and an unknown tag is refused", () => {
  const m = makeModule();
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_log Core "started pid 42"; echo "rc=$?"');
  if (!/\[Core\] started pid 42/.test(out)) { throw new Error("console copy: " + out); }
  if (!/rc=0/.test(out)) { throw new Error("rc: " + out); }
  const mlog = fs.readFileSync(path.join(m.dir, "logs", "kernelray.log"), "utf8");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[Core\] started pid 42$/m.test(mlog)) {
    throw new Error("file line: " + JSON.stringify(mlog));
  }
  // 封闭集合之外的词会立刻失败，且不追加任何内容。
  const bad = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_log Bogus "x" 2>/dev/null; echo "rc=$?"');
  if (!/rc=2/.test(bad)) { throw new Error("unknown tag rc: " + bad); }
  eq(fs.readFileSync(path.join(m.dir, "logs", "kernelray.log"), "utf8"), mlog,
    "a refused tag must not append");
});

check("mlog append: lands in the module log, flattened to one line", () => {
  const m = makeModule();
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_mlog_append Node "imported 3 nodes (3 new)"; echo "rc=$?"');
  if (!/rc=0/.test(out)) { throw new Error("rc: " + out); }
  const mlog = fs.readFileSync(path.join(m.dir, "logs", "kernelray.log"), "utf8");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[Node\] imported 3 nodes \(3 new\)$/m.test(mlog)) {
    throw new Error("file line: " + JSON.stringify(mlog));
  }
  // 带换行的界面字符串不能把行格式拆成两行。
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; m=$(printf "two\\nlines"); kr_mlog_append Node "$m"');
  const lines = fs.readFileSync(path.join(m.dir, "logs", "kernelray.log"), "utf8").trim().split("\n");
  eq(lines.length, 2, "a newline in the message must not add a line");
  if (!/\[Node\] two lines$/.test(lines[1])) { throw new Error("flattened: " + lines[1]); }
});

check("mlog: append goes through the CLI dispatch, tail still works, tags are checked", () => {
  const m = makeModule();
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_cli mlog append Node "deleted 2 nodes"; echo "rc=$?"');
  if (!/rc=0/.test(out)) { throw new Error("rc: " + out); }
  const bad = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; kr_cli mlog append Nope "x" 2>/dev/null; echo "rc=$?"');
  if (!/rc=2/.test(bad)) { throw new Error("unknown tag rc: " + bad); }
  const tail = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli mlog 5');
  if (!/\[Node\] deleted 2 nodes$/m.test(tail)) { throw new Error("tail: " + tail); }
});

check("log clear: the CLI truncates the core log silently, with no marker line", () => {
  const m = makeModule();
  const log = path.join(m.dir, "logs", "xray.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "one\ntwo\nthree\n");
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli log clear; echo "rc=$?"');
  eq(out.trim(), "rc=0", "a successful clear prints nothing but rc");
  eq(fs.readFileSync(log, "utf8"), "", "the file is zero bytes");
});

check("log clear: truncates in place, so an already-open writer stays visible", () => {
  const m = makeModule();
  const log = path.join(m.dir, "logs", "xray.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "old\n");
  // 在清空之前打开的追加 fd 模拟核心的 >> 重定向：如果清空操作把文件解除链接，
  // 这一行就会落进一个失效的 inode，WebUI 永远看不到它。
  runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; exec 3>>"$KR_LOG"; kr_cli log clear; printf "after\\n" >&3; exec 3>&-');
  eq(fs.readFileSync(log, "utf8"), "after\n", "the open writer still lands in the visible file");
});

check("log clear: idempotent, and creates a missing log as an empty file", () => {
  const m = makeModule();
  const log = path.join(m.dir, "logs", "xray.log");
  const first = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli log clear; echo "rc=$?"');
  eq(first.trim(), "rc=0", "clearing a missing log must not fail");
  eq(fs.readFileSync(log, "utf8"), "", "a missing log becomes an empty, readable file");
  const second = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli log clear; echo "rc=$?"');
  eq(second.trim(), "rc=0", "clearing twice is still success");
  eq(fs.readFileSync(log, "utf8"), "", "the second clear changes nothing");
});

check("mlog clear: only the module log, no marker, and append still works", () => {
  const m = makeModule();
  const core = path.join(m.dir, "logs", "xray.log");
  const mlog = path.join(m.dir, "logs", "kernelray.log");
  fs.mkdirSync(path.dirname(core), { recursive: true });
  fs.writeFileSync(core, "core line\n");
  fs.writeFileSync(mlog, "module line\n");
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli log clear');
  eq(fs.readFileSync(core, "utf8"), "", "core log cleared");
  eq(fs.readFileSync(mlog, "utf8"), "module line\n", "the other log is untouched");
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli mlog clear');
  eq(fs.readFileSync(mlog, "utf8"), "", "module log cleared");
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli mlog 5'), "", "no audit line is written");
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli mlog append Module "after clear"');
  const tail = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli mlog 5');
  if (!/\[Module\] after clear/.test(tail)) {
    throw new Error("module log stopped accepting lines: " + tail);
  }
});

check("log clear: numeric tails and unknown line counts are unchanged", () => {
  const m = makeModule();
  const log = path.join(m.dir, "logs", "xray.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "kept\n");
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli log 5').trim(), "kept", "log 5 still tails");
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli log bogus').trim(), "kept",
    "a non-numeric argument still falls back to a tail");
  fs.writeFileSync(path.join(m.dir, "logs", "kernelray.log"), "module kept\n");
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_cli mlog 5').trim(), "module kept",
    "mlog 5 still tails");
});

check("status: the state revision and the rendered meta id ride along", () => {
  const m = makeModule();
  writeStatePorts(m, { socksPort: 12008, httpPort: 12009 }, { extra: { revision: 7 } });
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=n.example.com\n");
  const kv = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv nodes');
  if (!/^revision=7$/m.test(kv)) { throw new Error("revision: " + kv); }
  if (!new RegExp("^meta=" + ID + "$", "m").test(kv)) { throw new Error("meta: " + kv); }
  const plain = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv');
  if (/^meta=/m.test(plain)) { throw new Error("the plain status must not read the meta"); }
});

check("log: a start rotates the core log over the cap", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  const log = path.join(m.dir, "logs", "xray.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "x".repeat(64));
  try {
    runShell(m.dir, BODY_START, [], { KR_LOG_MAX: "8" });
  } finally {
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* 尽力而为 */ }
  }
  eq(fs.readFileSync(log + ".1", "utf8").length, 64, "the old log moved aside");
});

check("render: a template without the inbound port placeholders is refused", () => {
  const m = makeModule();
  writeOutbound(m);
  const tmpl = path.join(m.dir, "config.example.json");
  const t = JSON.parse(fs.readFileSync(tmpl, "utf8"));
  delete t.inbounds[0].port;
  fs.writeFileSync(tmpl, JSON.stringify(t));
  const r = runFail(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (!/inbound port placeholders/.test(r.stdout + r.stderr)) {
    throw new Error("expected an inbound port placeholder refusal, got: " + r.stdout + r.stderr);
  }
});

// ---- 安装器的环境 ----------------------------------------------------------

check("probe: no external commands needed (the installer's busybox-only PATH)", () => {
  const m = makeModule(aliveCore);
  // 安装脚本 customize.sh 运行时 PATH 只含 busybox 目录，那里没有 `timeout` 和 `head`。
  // 一个会调用外部命令的探测会把能用的核心误报成不可用，并让安装中止 —— 本测试
  // 钉住「只用内建命令」这条性质。（只为探测清空 PATH：harness 自己仍需 PATH
  // 来启动 bash。）
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; PATH= kr_core_works && kr_core_version');
  if (!/Xray 0\.0\.0/.test(out)) { throw new Error("expected the version, got: " + out); }
});

check("probe: its status is not its last command's (busybox printf returns 1 once)", () => {
  const m = makeModule(aliveCore);
  // 在 KernelSU 里，busybox ash 的一次会话中 *第一个* printf 会返回 1；探测若以裸
  // `printf` 结尾，就会在安装器里把能用的核心误报成不可用。
  const out = runShell(m.dir,
    '. "$KR_TEST_SCRIPT"; printf() { builtin printf "$@"; return 1; };' +
    ' kr_core_works && echo works; kr_core_probe >/dev/null && echo probed');
  eq(out.trim().split("\n").join("|"), "works|probed", "both calls succeed despite printf");
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
console.log(pass + " config tests passing");
