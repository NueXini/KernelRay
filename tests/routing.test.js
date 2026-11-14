// 分流模式 (routing mode) 测试。
//
// 这个模式是 shell 持有的偏好（docs/adr/0014）：runtime/route 由
// `kernelray.sh routing global|cn` 写入，并通过重新渲染配置立即生效。这套测试在
// 临时模块目录、假核心与假的地理数据上 source 随包 shell，因此无需 Android 设备
// 或真正的 .dat 文件，就能覆盖渲染矩阵（全局/大陆直连 × 接管/直连运行）、
// 地理数据降级以及切换的失败路径。
//
//   node tests/routing.test.js
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
  tag: "proxy",
  protocol: "trojan",
  settings: { servers: [{ address: "n.example.com", port: 443, password: "pw" }] },
  streamSettings: {
    network: "tcp", security: "none", sockopt: { mark: "__KERNELRAY_MARK__" }
  }
};

// `-version` 输出版本；只有设置 FAKE_XRAY_FAIL 时 `-test` 才失败；
// 除非 FAKE_START_FAIL 另有指示，`run -c` 会保持存活。
const fakeCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then',
  '  [ -n "$FAKE_XRAY_FAIL" ] && exit 1',
  "  exit 0",
  "fi",
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  [ -n "$FAKE_START_FAIL" ] && exit 1',
  '  trap "exit 0" TERM INT',
  "  while :; do sleep 0.2; done",
  "fi",
  "exit 0",
  ""
].join("\n");

// 对全局形态能启动，对大陆直连则死亡，这样不必手动改偏好就能走到换入操作的
// 回滚路径。
const modeAwareCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  grep -q "geosite:cn" "$3" && exit 1',
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

// 一个 iptables 拒绝建链的桩目录：接管规则安装失败，启动必须被拒绝
// （没有接管就没有核心，docs/adr/0011）。
function makeFailingIptables(m) {
  const dir = path.join(m.dir, "fail-bin");
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    "#!/bin/sh",
    'case "$*" in',
    '  *-nL*) exit 1 ;;',
    '  *-C*) exit 1 ;;',
    '  *"-N KR_TP_OUTPUT"*) exit 1 ;;',
    "esac",
    "exit 0",
    ""
  ].join("\n");
  ["iptables", "ip6tables"].forEach(function (name) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
    fs.chmodSync(path.join(dir, name), 0o755);
  });
  return posixPathEnv(dir) + (process.platform === "win32" ? ";" : ":") + posixPathEnv(m.stubs);
}

function makeModule(core) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernelray-route-"));
  dirs.push(dir);
  fs.copyFileSync(template, path.join(dir, "config.example.json"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "xray"), core || fakeCore, "utf8");
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "module", "scripts", "tproxy.sh"),
    path.join(dir, "scripts", "tproxy.sh"));
  // 地理数据就放在核心旁边（docs/adr/0014）。`-s` 是 shell 检查的依据：
  // 空的 .dat 与缺失的 .dat 等价。
  fs.writeFileSync(path.join(dir, "bin", "geosite.dat"), "geosite\n");
  fs.writeFileSync(path.join(dir, "bin", "geoip.dat"), "geoip\n");
  // 每次启动都是一次接管（docs/adr/0011），所以启动需要内核回答「规则在位」。
  // 桩程序在每次运行里都位于 PATH 上；想要制造失败的测试会自带一套
  // （见 makeFailingIptables）。
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
    outbound: path.join(dir, "outbound.json"),
    meta: path.join(dir, "outbound.meta"),
    applied: path.join(dir, "runtime", "applied"),
    status: path.join(dir, "runtime", "status.json"),
    route: path.join(dir, "runtime", "route"),
    geosite: path.join(dir, "bin", "geosite.dat"),
    geoip: path.join(dir, "bin", "geoip.dat"),
    moduleLog: path.join(dir, "logs", "kernelray.log")
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
      // 假核心从不绑定 socks 端口，所以启动要等到截止时间：把它缩短，免得每次
      // 启动都付 1.5 s 的代价。会退出的核心仍在第一次轮询就被发现，回滚测试
      // 正是依赖这一点。
      KR_START_POLLS: "8",
      KR_START_STEP: "0.05"
    }, extraEnv || {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFail(dir, body, args, extraEnv) {
  try {
    runShell(dir, body, args, extraEnv);
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
  throw new Error("expected the shell command to fail");
}

function writeOutbound(m, host) {
  fs.writeFileSync(m.outbound, JSON.stringify(fixture));
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=" + (host || "n.example.com") + "\n");
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const BODY_RENDER = '. "$KR_TEST_SCRIPT"; kr_render_config "$1"';
const BODY_SET = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_route_set "$1"';
const BODY_PREF = '. "$KR_TEST_SCRIPT"; kr_route_write "$1"';
const BODY_MODE = '. "$KR_TEST_SCRIPT"; kr_route_mode';
const BODY_STATUS = '. "$KR_TEST_SCRIPT"; kr_status_write stopped idle';
const BODY_KV = '. "$KR_TEST_SCRIPT"; kr_status_kv';
const BODY_START = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_start';
const BODY_STOP = '. "$KR_TEST_SCRIPT"; kr_stop';

const CN_RULES_TAKEOVER = [
  { inboundTag: ["dns"], domain: ["full:n.example.com"], outboundTag: "direct" },
  { inboundTag: ["dns"], ip: ["223.5.5.5", "119.29.29.29"], outboundTag: "direct" },
  { inboundTag: ["dns"], outboundTag: "proxy" },
  { network: "tcp,udp", port: 53, outboundTag: "dns-out" },
  { ip: ["geoip:private"], outboundTag: "direct" },
  { domain: ["geosite:private"], outboundTag: "direct" },
  { domain: ["geosite:cn"], outboundTag: "direct" },
  { ip: ["geoip:cn"], outboundTag: "direct" }
];
// 全局的规则集：接管形态始终带有 DNS 模块和端口 53 的捕获。
const GLOBAL_RULES = [
  { inboundTag: ["dns"], domain: ["full:n.example.com"], outboundTag: "direct" },
  { inboundTag: ["dns"], outboundTag: "proxy" },
  { network: "tcp,udp", port: 53, outboundTag: "dns-out" }
];

// ---- 渲染 --------------------------------------------------------------------------

check("render: 大陆直连 splits DNS and sends mainland destinations direct", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));

  eq(cfg.dns.servers.length, 3, "two domestic resolvers and the DoH fallback");
  eq(cfg.dns.servers[0], {
    address: "223.5.5.5", domains: ["geosite:cn"], expectIPs: ["geoip:cn"]
  }, "first domestic resolver");
  eq(cfg.dns.servers[1], {
    address: "119.29.29.29", domains: ["geosite:cn"], expectIPs: ["geoip:cn"]
  }, "second domestic resolver");
  eq(cfg.dns.servers[2], "https://1.1.1.1/dns-query", "DoH stays the fallback");
  eq(cfg.dns.queryStrategy, "UseIPv4", "queryStrategy survives the split");
  // 下面的分流规则匹配 inboundTag:["dns"]；只有 dns 块声明了该标签，核心
  // 才会给它的上游查询打上这个标签 —— 否则标签就是 xray.system.<uuid>，每条
  // 上游查询都会落到端口 53 -> dns-out（又回到本模块），国内解析器根本
  // 不会被问到。
  eq(cfg.dns.tag, "dns", "the dns module carries the tag its routing rules match");

  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "unmatched domains get resolved and re-tested");
  eq(cfg.routing.rules, CN_RULES_TAKEOVER, "rules in order");
});

check("render: 全局 keeps the pre-0014 takeover blocks byte for byte", () => {
  const m = makeModule();
  writeOutbound(m);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.dns, { tag: "dns", servers: ["https://1.1.1.1/dns-query"], queryStrategy: "UseIPv4" }, "dns");
  eq(cfg.routing.domainStrategy, "AsIs", "strategy");
  eq(cfg.routing.rules, GLOBAL_RULES, "rules");
});

check("render: there is no idle form left to render", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { KR_TAKEOVER: "0" }));
  // 环境变量 KR_TAKEOVER 已不再是输入：一次渲染永远是接管形态。
  eq(cfg.inbounds.length, 3, "tproxy inbound present");
  eq(cfg.dns.tag, "dns", "the dns module is present");
  eq(cfg.routing.rules, CN_RULES_TAKEOVER, "the full cn rule set, dns group included");
});

check("render: an IP node keeps the resolver rule and loses the bootstrap rule", () => {
  const m = makeModule();
  writeOutbound(m, "203.0.113.9");
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.routing.rules, CN_RULES_TAKEOVER.slice(1), "no full:host rule for a literal");
  eq(cfg.dns.servers.length, 3, "the split is not tied to the node's hostname");
});

check("render: a pinned node address lands in the hosts of the split DNS too", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  fs.writeFileSync(path.join(m.dir, "runtime", "nodeip"), "203.0.113.9\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.dns.servers.length, 3, "the split survives the pin");
  eq(cfg.dns.hosts, { "full:n.example.com": "203.0.113.9" }, "hosts pin");
  eq(cfg.routing.rules, CN_RULES_TAKEOVER, "the rules are unchanged by the pin");
});

// ---- 降级 ------------------------------------------------------------------------

check("degrade: a cn render without geo data falls back to 全局 and says so", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  fs.unlinkSync(m.geosite);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.dns, { tag: "dns", servers: ["https://1.1.1.1/dns-query"], queryStrategy: "UseIPv4" },
    "the global dns block, not a dead config");
  eq(cfg.routing.domainStrategy, "AsIs", "the global strategy");
  eq(cfg.routing.rules.length, 3, "the global rule set");

  const log = fs.readFileSync(m.moduleLog, "utf8");
  if (!/geo data missing/.test(log)) {
    throw new Error("the degradation must be logged in kernelray.log");
  }
});

check("degrade: the preference survives a degraded render (intent is not rewritten)", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  fs.unlinkSync(m.geoip);
  runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  eq(runShell(m.dir, BODY_MODE).trim(), "cn", "the mode is still cn");
});

check("degrade: an empty .dat counts as missing", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.geosite, "");
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_geodata_ok && echo OK || echo MISSING');
  eq(out.trim(), "MISSING", "geodata check");
});

// ---- 核心查找数据的位置 ------------------------------------------------------

check("layout: the geo data the shell checks is the data beside the core", () => {
  const m = makeModule();
  // 核心从自己可执行文件所在目录解析 geosite.dat/geoip.dat（26.10.29 在那里找，
  // 不是 cwd），所以数据必须与核心同目录 —— 既没有 XRAY_LOCATION_ASSET，也没有
  // 第二条需要保持同步的路径（docs/adr/0014）。
  const coreDir = path.posix.dirname(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_core').trim());
  eq(coreDir, shPath(m.dir) + "/bin", "the core lives in bin/");

  // 把某个 .dat 移出该目录，正是本测试要防住的布局破坏。
  const moved = path.join(m.dir, "elsewhere");
  fs.mkdirSync(moved);
  fs.renameSync(path.join(m.dir, "bin", "geosite.dat"), path.join(moved, "geosite.dat"));
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_geodata_ok && echo OK || echo MISSING').trim(),
    "MISSING", "a .dat outside the core's directory does not count");
});

// ---- CLI ----------------------------------------------------------------------------

check("cli: routing status reports the mode, the effective mode and the data", () => {
  const m = makeModule();
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_route_status');
  eq(out.trim().split("\n"), ["mode=global", "effective=global", "geodata=ok"], "fresh install");

  runShell(m.dir, BODY_PREF, ["cn"]);
  fs.unlinkSync(m.geosite);
  const out2 = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_route_status');
  eq(out2.trim().split("\n"), ["mode=cn", "effective=global", "geodata=missing"],
    "preference vs what the render may use");
});

check("cli: routing cn renders, tests and swaps the config, then records the preference", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  eq(fs.readFileSync(m.route, "utf8").trim(), "cn", "preference written");
  const cfg = readJson(m.config);
  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "the running config is the cn form");
  eq(cfg.routing.rules, CN_RULES_TAKEOVER, "the takeover rule set: there is no other");
});

check("cli: routing global removes the preference and renders the global form again", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  runShell(m.dir, BODY_SET, ["global"]);
  if (fs.existsSync(m.route)) { throw new Error("global is the absent-file mode"); }
  const cfg = readJson(m.config);
  eq(cfg.routing.domainStrategy, "AsIs", "the global strategy");
  eq(cfg.routing.rules, GLOBAL_RULES, "the global rule set");
});

check("cli: routing cn refuses without geo data and leaves the mode alone", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  fs.unlinkSync(m.geosite);
  const r = runFail(m.dir, BODY_SET, ["cn"]);
  if (!/geo data is missing/.test(r.stderr)) {
    throw new Error("the refusal must name the missing data: " + r.stderr);
  }
  if (fs.existsSync(m.route)) { throw new Error("the mode must not change"); }
  if (fs.existsSync(m.config)) { throw new Error("no config may be rendered"); }
});

check("cli: a candidate the core rejects changes neither the mode nor the config", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  const r = runFail(m.dir, BODY_SET, ["cn"], { FAKE_XRAY_FAIL: "1" });
  if (!/config test failed/.test(r.stderr)) { throw new Error("expected a test failure: " + r.stderr); }
  if (fs.existsSync(m.route)) { throw new Error("the mode must not change"); }
  if (fs.existsSync(m.config)) { throw new Error("no config may be swapped in"); }
});

check("cli: a candidate that does not start rolls the preference back", () => {
  const m = makeModule(modeAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  // 先让全局形态的配置跑起来：那才是切换开始时的状态。
  runShell(m.dir, BODY_START);
  const before = fs.readFileSync(m.config, "utf8");

  runFail(m.dir, BODY_SET, ["cn"]);

  if (fs.existsSync(m.route)) { throw new Error("the preference must be back to global"); }
  eq(fs.readFileSync(m.config, "utf8"), before, "the previous config is restored");
  const kv = runShell(m.dir, BODY_KV);
  if (!/^state=running$/m.test(kv)) { throw new Error("the old config must be running again"); }
  if (!/^route=global$/m.test(kv)) { throw new Error("status must agree with the rollback"); }
  runShell(m.dir, BODY_STOP);
});

check("cli: routing cn with no applied node saves the preference and renders nothing", () => {
  const m = makeModule();
  runShell(m.dir, BODY_SET, ["cn"]);
  eq(fs.readFileSync(m.route, "utf8").trim(), "cn", "preference");
  if (fs.existsSync(m.config)) { throw new Error("there is no node to render"); }
});

check("cli: the status kv and status.json carry the mode, the effective mode and the data", () => {
  const m = makeModule();
  runShell(m.dir, BODY_PREF, ["cn"]);
  const kv = runShell(m.dir, BODY_KV);
  if (!/^route=cn$/m.test(kv)) { throw new Error("kv route: " + kv); }
  if (!/^routing=cn$/m.test(kv)) { throw new Error("kv routing: " + kv); }
  if (!/^geodata=ok$/m.test(kv)) { throw new Error("kv geodata: " + kv); }

  runShell(m.dir, BODY_STATUS);
  eq(readJson(m.status).route, "cn", "status.json route");

  fs.unlinkSync(m.geosite);
  const kv2 = runShell(m.dir, BODY_KV);
  if (!/^routing=global$/m.test(kv2)) { throw new Error("degraded effective mode: " + kv2); }
  if (!/^geodata=missing$/m.test(kv2)) { throw new Error("degraded geodata: " + kv2); }
});

check("cli: an unknown mode is a usage error", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_SET, ["cn-direct"]);
  eq(r.status, 2, "exit code");
  if (!/usage: kernelray.sh routing/.test(r.stderr)) { throw new Error("usage line: " + r.stderr); }
});

// ---- 启动时发现数据已消失 ------------------------------------------------

check("start: a stale cn config degrades to 全局 when the geo data is gone", () => {
  const m = makeModule(modeAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  if (!/geosite:cn/.test(fs.readFileSync(m.config, "utf8"))) {
    throw new Error("fixture: expected a cn config before the data went away");
  }
  fs.unlinkSync(m.geosite);

  // 假核心 modeAwareCore 只对不含 geosite:cn 的配置保持存活，所以这次启动证明
  // 那份陈旧配置被重新渲染过，而不是留着去让 -test 失败。
  runShell(m.dir, BODY_START);
  if (/geosite:cn/.test(fs.readFileSync(m.config, "utf8"))) {
    throw new Error("the stale cn config must be re-rendered before the test");
  }
  eq(readJson(m.status).state, "running", "the core starts");
  eq(fs.readFileSync(m.route, "utf8").trim(), "cn", "the preference survives: intent is not rewritten");
  runShell(m.dir, BODY_STOP);
});

check("start: with no rules available, a start is refused instead of falling back", () => {
  const m = makeModule(modeAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  fs.unlinkSync(m.geosite);
  // 接管规则安装在这里失败。启动即接管 (docs/adr/0011)：没有接管就没有核心，
  // 所以启动被拒绝 —— 设备保持直连，而不是断网。
  const r = runFail(m.dir, BODY_START, [], { PATH: makeFailingIptables(m) });
  if (!/takeover rules failed/.test(r.stdout + r.stderr)) {
    throw new Error("expected the takeover refusal, got: " + r.stdout + r.stderr);
  }
  // 在尝试装接管规则之前，配置已经渲染并通过测试：它是降级后的全局形态，
  // 因为没有地理数据时 cn 配置过不了 -test。
  if (/geosite:cn/.test(fs.readFileSync(m.config, "utf8"))) {
    throw new Error("the config must be the degraded global form");
  }
  const st = readJson(m.status);
  eq(st.state, "stopped", "state");
  eq(st.phase, "failed/rules", "phase");
  eq(fs.readFileSync(m.route, "utf8").trim(), "cn", "the mode is a preference, never rewritten");
});

// ---- 完成 -------------------------------------------------------------------------------

dirs.forEach(function (d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* Windows 可能占用文件 */ }
});

if (failures.length) {
  console.error(failures.join("\n\n"));
  console.error("\n" + pass + " passing, " + failures.length + " failing");
  process.exit(1);
}
console.log(pass + " routing tests passing");
