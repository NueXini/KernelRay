// 诊断包（GLOSSARY「诊断包」）测试。
//
// 收集与打包出自 module/scripts/kernelray.sh 的 kr_diagnostics：对着临时
// 模块目录与假 iptables/ip 运行，KR_DIAG_DL 指向临时目录，因此无需
// Android 设备就能检验收集范围、凭据不进包、缺失文件的尽力语义、
// gzip 回退与不覆盖。
//
//   node tests/diagnostics.test.js
//
// 需要 bash（Windows 上是 Git Bash）与 tar。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const script = path.join(root, "module", "scripts", "kernelray.sh");

// 假的 iptables/ip6tables：回应一切但只输出被要求的标记行，快照因此
// 可断言。
const fakeIpt = [
  "#!/bin/sh",
  'echo "$(basename "$0") $*"',
  "exit 0",
  ""
].join("\n");
// 假的 ip：回显调用行；`ip route show table all` 额外给出一条默认路由，
// 让路由 get 探针能从它推导出口网卡（真机上由内核回答）。
const fakeIp = [
  "#!/bin/sh",
  'echo "ip $*"',
  'case "$*" in',
  '  *"route show table all"*) echo "default dev wlan0" ;;',
  "esac",
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

// bash 输出的路径是 msys 形式（/c/...）；Node 在 Windows 上读不了，转回来。
function fromShellPath(p) {
  if (process.platform !== "win32") { return p; }
  const m = p.match(/^\/([a-z])(\/.*)$/);
  return m ? m[1].toUpperCase() + ":" + m[2] : p;
}

function posixPathEnv(extraDir) {
  return process.platform === "win32"
    ? extraDir + ";" + process.env.PATH
    : extraDir + ":" + process.env.PATH;
}

// 与 routing.test.js 同款的模块沙盒：模板、假核心、geo 数据、
// 假内核二进制。诊断不启动核心，核心只是布局契约的一部分。
function makeModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernelray-diag-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "xray"), "#!/bin/sh\nexit 0\n", "utf8");
  fs.mkdirSync(path.join(dir, "config", "runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "module", "scripts", "tproxy.sh"),
    path.join(dir, "scripts", "tproxy.sh"));
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  for (const [name, body] of [
    ["iptables", fakeIpt], ["ip6tables", fakeIpt], ["ip", fakeIp],
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
    dl: path.join(dir, "Download"),
    status: path.join(dir, "config", "runtime", "status.json"),
    rules: path.join(dir, "config", "runtime", "rules"),
    logDir: path.join(dir, "logs"),
    mlog: path.join(dir, "logs", "kernelray.log"),
    coreLog: path.join(dir, "logs", "xray.log")
  };
}

function runShell(m, args, extraEnv) {
  return execFileSync("bash", [shPath(script)].concat(args || []), {
    cwd: root,
    env: Object.assign({}, process.env, {
      KR_MODDIR: shPath(m.dir),
      KR_DIAG_DL: shPath(m.dl),
      PATH: posixPathEnv(m.stubs)
    }, extraEnv || {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runFail(m, args, extraEnv) {
  try {
    runShell(m, args, extraEnv);
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
  throw new Error("expected the shell command to fail");
}

function dlEntries(m) {
  return fs.readdirSync(m.dl).sort();
}

function tarList(m, name) {
  return execFileSync("bash", ["-c", "tar -tf \"$1\"", "bash", shPath(path.join(m.dl, name))], {
    encoding: "utf8"
  }).split("\n").filter(function (l) {
    const t = l.trim();
    return t !== "" && t.slice(-1) !== "/";
  }).sort();
}

function readEntry(m, name, entry) {
  return execFileSync("bash",
    ["-c", "tar -xOf \"$1\" \"$2\"", "bash", shPath(path.join(m.dl, name)), entry],
    { encoding: "utf8" });
}

const PREFIX = /KernelRay-diagnostics-\d{8}-\d{6}(-\d+)?\.tar\.gz$/;

check("diagnostics: on success stdout is just the final archive path line", function () {
  const m = makeModule();
  const out = runShell(m, ["diagnostics"]);
  const lines = out.trim().split("\n");
  eq(lines.length, 1, "stdout line count");
  assert.match(lines[0], PREFIX, "path");
  assert.ok(fs.existsSync(fromShellPath(lines[0].trim())), "archive exists");
  eq(fs.readdirSync(m.dir + "/config/runtime").filter(function (n) {
    return n.indexOf("diag.") === 0;
  }), [], "staging dir cleaned");
});

check("diagnostics: an empty module still collects and missing files are listed in info.txt", function () {
  const m = makeModule();
  const dest = runShell(m, ["diagnostics"]).trim();
  const name = path.basename(dest).replace(/\.tar\.gz$/, "");
  const info = readEntry(m, path.basename(dest), name + "/info.txt");
  assert.match(info, /missing=module\.prop/, "missing recorded");
  assert.match(info, /missing=status\.json/, "missing recorded");
  assert.match(info, /missing=xray\.log/, "missing recorded");
  assert.match(info, /^bundle=/m, "bundle line");
  assert.match(info, /^boot=/m, "boot line");
});

check("diagnostics: present logs and status are collected, no credential files in the archive", function () {
  const m = makeModule();
  fs.writeFileSync(path.join(m.dir, "module.prop"), "id=KernelRay\nversionName=test\n");
  fs.writeFileSync(m.status, '{"state":"stopped","phase":"idle"}\n');
  fs.writeFileSync(m.rules, "boot=abc\npresent=0\n");
  fs.mkdirSync(m.logDir, { recursive: true });
  fs.writeFileSync(m.mlog, "log [Module] line\n");
  fs.writeFileSync(m.coreLog, "2026/11/14 line\n");
  const dest = runShell(m, ["diagnostics"]).trim();
  const name = path.basename(dest).replace(/\.tar\.gz$/, "");
  eq(tarList(m, path.basename(dest)), [
    name + "/info.txt",
    name + "/kernel-snapshot.txt",
    name + "/kernelray.log",
    name + "/module.prop",
    name + "/probes.txt",
    name + "/rules",
    name + "/status.json",
    name + "/xray.log"
  ], "archive contents");
  const snapshot = readEntry(m, path.basename(dest), name + "/kernel-snapshot.txt");
  assert.match(snapshot, /iptables -t mangle -S/, "v4 mangle section");
  // 假 iptables 回显调用行：头行之后紧跟内核应答，证明快照拿到的是
  // 实时的回答，不是空的或只有标题。
  assert.match(snapshot, /## iptables -t mangle -S\niptables -t mangle -S/,
    "kernel answers captured");
  assert.match(snapshot, /ip rule show/, "policy rules section");
  assert.match(snapshot, /ip route show table 19283/, "capture table section");
  assert.match(snapshot, /ip route show table 19282/, "bypass table section");
});

check("diagnostics: probes.txt answers the takeover state, the counters, the route lookups and the resolver state", function () {
  const m = makeModule();
  const dest = runShell(m, ["diagnostics"]).trim();
  const tar = path.basename(dest);
  const name = tar.replace(/\.tar\.gz$/, "");
  const probes = readEntry(m, tar, name + "/probes.txt");
  // 假 iptables/ip6tables 从不失败：链在，形状是当前的。verdict 与
  // kr_tproxy_status 的 rules=present|absent 同词汇（GLOSSARY：接管）。
  assert.match(probes, /^rules=present$/m, "takeover verdict");
  assert.match(probes, /^shape=current$/m, "shape verdict");
  assert.match(probes, /^table_19283_rules_v4=\d+$/m, "rule counts are facts");
  assert.match(probes, /^table_19283_routes_v6=\d+$/m, "table route counts");
  // 计数器：快照只有 -S 的形状；多少包被 mark 只有 -nvL 回答得了。
  assert.match(probes,
    /## iptables -t mangle -nvL KR_TP_OUTPUT\niptables -t mangle -nvL KR_TP_OUTPUT/,
    "counter section with a live answer");
  // 守卫链是 v6 独有的 filter 链（REJECT 只在 filter 表合法），计数器里也要收。
  assert.match(probes,
    /## ip6tables -t filter -nvL KR_TP_GUARD\nip6tables -t filter -nvL KR_TP_GUARD/,
    "guard chain counter with a live answer");
  // 路由 get 探针：带接管 mark 的查找与不带 mark 的对照；链路本地证人
  // 在默认路由推导出的出口网卡上（假 ip 给的是 wlan0）。
  assert.match(probes,
    /\$ ip route get 192\.0\.2\.1 mark 19283\nip route get 192\.0\.2\.1 mark 19283/,
    "takeover-mark route probe with its answer");
  assert.match(probes, /\$ ip -6 route get fe80::1 oif wlan0 mark 19283/,
    "link-local witness probe");
  assert.match(probes, /\$ ip route get 192\.0\.2\.1\n/, "unmarked control probe");
  assert.match(probes, /## resolver state/, "resolver section");
  assert.match(probes, /^private_dns_mode=/m, "private dns state");
  // ndc 不在场（桩目录里没有它）就少答一项，绝不为缺失失败。
  assert.doesNotMatch(probes, /ndc resolver getnetdns/, "missing ndc stays silent");
});

check("diagnostics: credential files stay in place, unchanged and out of the archive", function () {
  const m = makeModule();
  fs.writeFileSync(path.join(m.dir, "config", "config.json"), '{"secrets":true}');
  fs.writeFileSync(path.join(m.dir, "config", "state.json"), '{"secrets":true}');
  fs.writeFileSync(path.join(m.dir, "config", "outbound.json"), '{"secrets":true}');
  fs.writeFileSync(path.join(m.dir, "config", "runtime", "nodeip"), "1.2.3.4");
  const dest = runShell(m, ["diagnostics"]).trim();
  const listing = tarList(m, path.basename(dest)).join("\n");
  assert.doesNotMatch(listing, /config\.json/, "config.json excluded");
  assert.doesNotMatch(listing, /state\.json/, "state.json excluded");
  assert.doesNotMatch(listing, /outbound\.json/, "outbound.json excluded");
  assert.doesNotMatch(listing, /nodeip/, "nodeip excluded");
  // 只读手势：被收集的原文件一个不动。
  eq(fs.readFileSync(path.join(m.dir, "config", "config.json"), "utf8"), '{"secrets":true}', "config intact");
});

check("diagnostics: missing gzip falls back to plain tar", function () {
  const m = makeModule();
  fs.writeFileSync(path.join(m.stubs, "gzip"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(m.stubs, "gzip"), 0o755);
  const dest = runShell(m, ["diagnostics"]).trim();
  assert.match(dest, /\.tar$/, "plain tar fallback");
  assert.ok(fs.existsSync(fromShellPath(dest)), "archive exists");
});

check("diagnostics: repeated collections do not overwrite, bundles accumulate in the download dir", function () {
  const m = makeModule();
  const a = runShell(m, ["diagnostics"]).trim();
  const b = runShell(m, ["diagnostics"]).trim();
  assert.notStrictEqual(a, b, "distinct destinations");
  eq(dlEntries(m).length, 2, "two bundles");
});

check("diagnostics: an unwritable target errors and the staging area is cleaned", function () {
  const m = makeModule();
  // 把落点本身变成一个文件：mkdir -p 失败被容忍，打包后的 mv 必然失败。
  // chmod 在 Windows 的 msys 上挡不住写入，不是可靠的模拟手段。
  fs.writeFileSync(m.dl, "occupied");
  const r = runFail(m, ["diagnostics"]);
  assert.match(r.stderr, /diagnostics:/, "error message");
  eq(fs.readFileSync(m.dl, "utf8"), "occupied", "destination untouched");
  eq(fs.readdirSync(m.dir + "/config/runtime").filter(function (n) {
    return n.indexOf("diag.") === 0;
  }), [], "staging dir cleaned");
});

check("diagnostics: the module log records the archive location", function () {
  const m = makeModule();
  const dest = runShell(m, ["diagnostics"]).trim();
  assert.match(fs.readFileSync(m.mlog, "utf8"),
    /\[Module\] diagnostics bundle written to .*/, "log line");
});

check("probe: one command prints the whole probe set and writes no archive", function () {
  const m = makeModule();
  const out = runShell(m, ["probe"]);
  assert.match(out, /^rules=present$/m, "verdict line");
  assert.match(out, /\$ ip route get 192\.0\.2\.1/, "route-get probes");
  assert.match(out, /## iptables -t mangle -nvL/, "counter dump");
  assert.match(out, /## resolver state/, "resolver state");
  eq(fs.existsSync(m.dl) ? dlEntries(m).length : 0, 0, "no archive written");
});

check("usage: the CLI help line mentions diagnostics and probe", function () {
  const m = makeModule();
  const r = runFail(m, ["nonsense"]);
  assert.match(r.stderr, /diagnostics/, "usage mentions diagnostics");
  assert.match(r.stderr, /probe/, "usage mentions probe");
});

process.on("exit", function () {
  dirs.forEach(function (d) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ }
  });
  // eslint-disable-next-line no-console
  console.log(pass + " passed, " + failures.length + " failed");
  failures.forEach(function (f) {
    // eslint-disable-next-line no-console
    console.log("FAIL: " + f);
  });
  if (failures.length > 0) { process.exit(1); }
});
