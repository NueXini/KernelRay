// 大陆直连去广告 (Direct-CN-Adblock) tests.
//
// The third 分流模式 (docs/adr/0021): `runtime/route` holds `cnadblock`, and the render is
// 大陆直连's rules plus two ad parts -- the DNS module's `hosts` sink and a `block` routing
// rule. This harness sources the shipped shell against a throwaway module dir, a fake core and
// fake geo data, so the render matrix (全局 / 大陆直连 / 大陆直连去广告 × takeover/idle), the
// no-degrade rule and the fail-closed start are covered without an Android device or the real
// .dat files.
//
//   node tests/adblock.test.js
//
// Requires bash (Git Bash on Windows).

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

// -version prints; -test fails only when FAKE_XRAY_FAIL is set; `run -c` stays up unless
// FAKE_START_FAIL says otherwise.
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

// What the real core does with a category it cannot load: a config that names `geosite:` or
// `geoip:` fails -test when the matching .dat is gone, and nothing else fails. That is the one
// behaviour the fail-closed path depends on, so the fake reproduces exactly it.
const geoAwareCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then',
  '  if grep -q "geosite:" "$4" && [ ! -s "$KR_MODDIR/bin/geosite.dat" ]; then exit 1; fi',
  '  if grep -q "geoip:" "$4" && [ ! -s "$KR_MODDIR/bin/geoip.dat" ]; then exit 1; fi',
  "  exit 0",
  "fi",
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  trap "exit 0" TERM INT',
  "  while :; do sleep 0.2; done",
  "fi",
  "exit 0",
  ""
].join("\n");

// Tests fine, dies on a config that carries the ad parts: the switch's rollback path.
const adAwareCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-c" ]; then',
  '  grep -q "category-ads-all" "$3" && exit 1',
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

// The stub dir is prepended in Windows format; msys bash converts PATH itself.
function posixPathEnv(extraDir) {
  return process.platform === "win32"
    ? extraDir + ";" + process.env.PATH
    : extraDir + ":" + process.env.PATH;
}

function makeModule(core) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernelray-ad-"));
  dirs.push(dir);
  fs.copyFileSync(template, path.join(dir, "config.example.json"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "xray"), core || fakeCore, "utf8");
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "module", "scripts", "tproxy.sh"),
    path.join(dir, "scripts", "tproxy.sh"));
  fs.writeFileSync(path.join(dir, "bin", "geosite.dat"), "geosite\n");
  fs.writeFileSync(path.join(dir, "bin", "geoip.dat"), "geoip\n");
  // Every start takes over (docs/adr/0011), so a start needs a kernel that says yes.
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
const BODY_KV = '. "$KR_TEST_SCRIPT"; kr_status_kv';
const BODY_START = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_start';
const BODY_STOP = '. "$KR_TEST_SCRIPT"; kr_stop';

const AD_RULE = { domain: ["geosite:category-ads-all"], outboundTag: "block" };
const CN_AD_TAKEOVER = [
  { inboundTag: ["dns"], domain: ["full:n.example.com"], outboundTag: "direct" },
  { inboundTag: ["dns"], ip: ["223.5.5.5", "119.29.29.29"], outboundTag: "direct" },
  { inboundTag: ["dns"], outboundTag: "proxy" },
  { network: "tcp,udp", port: 53, outboundTag: "dns-out" },
  AD_RULE,
  { ip: ["geoip:private"], outboundTag: "direct" },
  { domain: ["geosite:private"], outboundTag: "direct" },
  { domain: ["geosite:cn"], outboundTag: "direct" },
  { ip: ["geoip:cn"], outboundTag: "direct" }
];

// ---- rendering --------------------------------------------------------------------------

check("render: 大陆直连去广告 adds the DNS sink and the block rule to 大陆直连", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cnadblock"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));

  // The DNS module is the load-bearing half: taken-over traffic carries no domain, so only the
  // resolver can refuse an ad domain (docs/adr/0021).
  eq(cfg.dns.servers.length, 3, "the domestic split survives");
  eq(cfg.dns.hosts, { "geosite:category-ads-all": "#3" }, "the ad sink is the only hosts entry");
  eq(cfg.dns.tag, "dns", "the tag its routing rules match");

  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "the geo strategy");
  eq(cfg.routing.rules, CN_AD_TAKEOVER, "rules in order");
  eq(cfg.routing.rules[4], AD_RULE, "ads before the geo rules: a mainland ad must not go direct");
  eq(cfg.routing.rules.findIndex(function (r) { return r.outboundTag === "block"; }), 4,
    "the ad rule sits after the dns/port-53 group (index 4) and before the geo rules");
});

check("render: the ad parts are not optional -- there is one form", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cnadblock"]);
  // KR_TAKEOVER is not an input any more: the dns module and the ad sink are always authored.
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { KR_TAKEOVER: "0" }));
  eq(cfg.dns.hosts, { "geosite:category-ads-all": "#3" }, "the sink is there");
  eq(cfg.inbounds.length, 3, "tproxy inbound present");
  eq(cfg.routing.rules, CN_AD_TAKEOVER, "the full rule set");
  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "strategy");
});

check("render: a pinned node address and the ad sink share the hosts map", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cnadblock"]);
  fs.writeFileSync(path.join(m.dir, "runtime", "nodeip"), "203.0.113.9\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.dns.hosts, {
    "full:n.example.com": "203.0.113.9", "geosite:category-ads-all": "#3"
  }, "both entries, one map");
  eq(cfg.routing.rules, CN_AD_TAKEOVER, "the pin does not move the rules");
});

check("render: 大陆直连 and 全局 carry no ad parts", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cn = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (/category-ads-all/.test(cn)) { throw new Error("大陆直连 must not block ads: " + cn); }
  eq(JSON.parse(cn).dns.hosts, undefined, "no hosts map at all without a pin");

  runShell(m.dir, BODY_PREF, ["global"]);
  const global = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (/category-ads-all/.test(global)) { throw new Error("全局 must not block ads"); }
});

check("render: no degrade -- missing geo data still renders the ad parts", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cnadblock"]);
  fs.unlinkSync(m.geosite);
  // 大陆直连 falls back to the global form here; 大陆直连去广告 must not, or its name would
  // describe a config it is not running (docs/adr/0021). The refusal happens at -test instead.
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.routing.rules, CN_AD_TAKEOVER, "the ad parts are still there");
  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "still the geo strategy");
  eq(runShell(m.dir, BODY_MODE).trim(), "cnadblock", "the preference is untouched by a render");
});

// ---- the preference ---------------------------------------------------------------------

check("pref: cnadblock round-trips through runtime/route, and junk reads as 全局", () => {
  const m = makeModule();
  runShell(m.dir, BODY_PREF, ["cnadblock"]);
  eq(fs.readFileSync(m.route, "utf8").trim(), "cnadblock", "written value");
  eq(runShell(m.dir, BODY_MODE).trim(), "cnadblock", "read back");

  fs.writeFileSync(m.route, "CN\n");
  eq(runShell(m.dir, BODY_MODE).trim(), "global", "case matters: an unknown value is 全局");

  fs.writeFileSync(m.route, "cnad\n");
  eq(runShell(m.dir, BODY_MODE).trim(), "global", "a truncated value is 全局");

  runShell(m.dir, BODY_PREF, ["global"]);
  if (fs.existsSync(m.route)) { throw new Error("global is the absent-file mode"); }
});

check("cli: routing status reports cnadblock as its own effective mode, even without data", () => {
  const m = makeModule();
  runShell(m.dir, BODY_PREF, ["cnadblock"]);
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_route_status').trim().split("\n"),
    ["mode=cnadblock", "effective=cnadblock", "geodata=ok"], "with data");

  fs.unlinkSync(m.geosite);
  // The one place this mode differs from 大陆直连 in the status: it is never degraded, so the
  // effective mode is the preference and the missing data is reported beside it.
  eq(runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_route_status').trim().split("\n"),
    ["mode=cnadblock", "effective=cnadblock", "geodata=missing"], "without data");

  const kv = runShell(m.dir, BODY_KV);
  if (!/^route=cnadblock$/m.test(kv)) { throw new Error("kv route: " + kv); }
  if (!/^routing=cnadblock$/m.test(kv)) { throw new Error("kv routing: " + kv); }
  if (!/^geodata=missing$/m.test(kv)) { throw new Error("kv geodata: " + kv); }
});

check("cli: routing cnadblock renders, tests and swaps the config, then records the preference", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cnadblock"]);
  eq(fs.readFileSync(m.route, "utf8").trim(), "cnadblock", "preference written");
  const cfg = readJson(m.config);
  eq(cfg.routing.rules, CN_AD_TAKEOVER, "the takeover rule set: there is no other");
  eq(cfg.dns.hosts, { "geosite:category-ads-all": "#3" }, "the sink is in the dns module");
});

check("cli: routing cnadblock refuses without data with one short message", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  fs.unlinkSync(m.geosite);
  const r = runFail(m.dir, BODY_SET, ["cnadblock"]);
  eq(r.stderr.trim(), "geo data missing", "the toast text, and nothing else");
  if (fs.existsSync(m.route)) { throw new Error("the mode must not change"); }
  if (fs.existsSync(m.config)) { throw new Error("no config may be rendered"); }
  const log = fs.readFileSync(m.moduleLog, "utf8");
  if (!/\[Routing\].*geo data missing; cnadblock cannot start/.test(log)) {
    throw new Error("the refusal must be in the module log: " + log);
  }
});

check("cli: a candidate the core rejects changes neither the mode nor the config", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  const r = runFail(m.dir, BODY_SET, ["cnadblock"], { FAKE_XRAY_FAIL: "1" });
  if (!/config test failed/.test(r.stderr)) {
    throw new Error("a non-geo rejection keeps the generic message: " + r.stderr);
  }
  if (fs.existsSync(m.route)) { throw new Error("the mode must not change"); }
  if (fs.existsSync(m.config)) { throw new Error("no config may be swapped in"); }
});

check("cli: a candidate that does not start rolls the preference back", () => {
  const m = makeModule(adAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_START);
  const before = fs.readFileSync(m.config, "utf8");

  runFail(m.dir, BODY_SET, ["cnadblock"]);

  if (fs.existsSync(m.route)) { throw new Error("the preference must be back to global"); }
  eq(fs.readFileSync(m.config, "utf8"), before, "the previous config is restored");
  const kv = runShell(m.dir, BODY_KV);
  if (!/^state=running$/m.test(kv)) { throw new Error("the old config must be running again"); }
  if (!/^route=global$/m.test(kv)) { throw new Error("status must agree with the rollback"); }
  runShell(m.dir, BODY_STOP);
});

check("cli: routing cnadblock with no applied node saves the preference and renders nothing", () => {
  const m = makeModule();
  runShell(m.dir, BODY_SET, ["cnadblock"]);
  eq(fs.readFileSync(m.route, "utf8").trim(), "cnadblock", "preference");
  if (fs.existsSync(m.config)) { throw new Error("there is no node to render"); }
});

check("cli: an unknown mode is a usage error", () => {
  const m = makeModule();
  const r = runFail(m.dir, BODY_SET, ["cn-ad"]);
  eq(r.status, 2, "exit code");
  if (!/routing \{global\|cn\|cnadblock\|status\}/.test(r.stderr)) {
    throw new Error("usage line: " + r.stderr);
  }
});

// ---- the install default ----------------------------------------------------------------

check("default: the installer writes cnadblock when the preference is unset", () => {
  const m = makeModule();
  eq(runShell(m.dir, BODY_MODE).trim(), "global", "an absent file reads as 全局");
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_route_default');
  eq(fs.readFileSync(m.route, "utf8").trim(), "cnadblock", "the default is written");
  eq(runShell(m.dir, BODY_MODE).trim(), "cnadblock", "and reads back");
});

check("default: an existing choice survives, and missing geo data keeps 全局", () => {
  const m = makeModule();
  runShell(m.dir, BODY_PREF, ["cn"]);
  runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_route_default');
  eq(runShell(m.dir, BODY_MODE).trim(), "cn", "a user's mode is not overwritten");

  // A default the core cannot start with is worse than one that does less (docs/adr/0021).
  const n = makeModule();
  fs.unlinkSync(n.geosite);
  runShell(n.dir, '. "$KR_TEST_SCRIPT"; kr_route_default');
  if (fs.existsSync(n.route)) { throw new Error("no default may be written without the data"); }
  eq(runShell(n.dir, BODY_MODE).trim(), "global", "stays 全局");
  const log = fs.readFileSync(n.moduleLog, "utf8");
  if (!/\[Routing\].*default stays global/.test(log)) {
    throw new Error("the skipped default must be logged: " + log);
  }
});

// ---- fail-closed ------------------------------------------------------------------------

check("start: cnadblock runs with the data present", () => {
  const m = makeModule(geoAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cnadblock"]);
  runShell(m.dir, BODY_START);
  eq(readJson(m.status).state, "running", "the core starts");
  runShell(m.dir, BODY_STOP);
});

check("start: data gone under cnadblock refuses the start and says why", () => {
  const m = makeModule(geoAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cnadblock"]);
  // The config on disk is already the tested cnadblock form, so the tested marker alone would
  // let the start through and the core would die on its own without the sentence this mode
  // owes the user. That is the case this covers.
  runShell(m.dir, BODY_START);
  runShell(m.dir, BODY_STOP);
  fs.unlinkSync(m.geosite);

  const r = runFail(m.dir, BODY_START);
  eq(r.stderr.trim(), "geo data missing", "the toast text");
  const st = readJson(m.status);
  eq(st.state, "failed", "no running core");
  eq(st.phase, "config-invalid", "the reason is the config, not a crash");
  const log = fs.readFileSync(m.moduleLog, "utf8");
  if (!/\[Routing\].*geo data missing; cnadblock cannot start/.test(log)) {
    throw new Error("the refusal must be in the module log: " + log);
  }
  if (fs.existsSync(path.join(m.dir, "runtime", "xray.pid"))) {
    throw new Error("no core may be left behind");
  }
});

// ---- done -------------------------------------------------------------------------------

dirs.forEach(function (d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* windows */ }
});

if (failures.length) {
  console.error(failures.join("\n\n"));
  console.error("\n" + pass + " passing, " + failures.length + " failing");
  process.exit(1);
}
console.log(pass + " ad-blocking tests passing");
