// 分流模式 (routing mode) tests.
//
// The mode is a shell-owned preference (docs/adr/0014): runtime/route, written by
// `kernelray.sh routing global|cn` and applied at once by re-rendering the config. This
// harness sources the shipped shell against a throwaway module dir, a fake core and fake geo
// data, so the render matrix (全局/大陆直连 × takeover/idle), the geo-data degradation and the
// switch's failure paths are covered without an Android device or the real .dat files.
//
//   node tests/routing.test.js
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

// -version prints; -test fails only when FAKE_XRAY_FAIL is set and dumps the asset env when
// FAKE_ENV_LOG names a file; `run -c` stays up unless FAKE_START_FAIL says otherwise.
const fakeCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
  'if [ "$1" = "run" ] && [ "$2" = "-test" ]; then',
  '  [ -n "$FAKE_ENV_LOG" ] && printf "%s\\n" "$XRAY_LOCATION_ASSET" >"$FAKE_ENV_LOG"',
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

// Starts for the 全局 form and dies for 大陆直连, so the swap's rollback path is reachable
// without touching the preference by hand.
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
  fs.mkdirSync(path.join(dir, "geodata"), { recursive: true });
  // `-s` is what the shell checks: an empty .dat is as good as a missing one.
  fs.writeFileSync(path.join(dir, "geodata", "geosite.dat"), "geosite\n");
  fs.writeFileSync(path.join(dir, "geodata", "geoip.dat"), "geoip\n");
  fs.writeFileSync(path.join(dir, "geodata", "VERSION"), "loyalsoldier 202610292204\n");
  return {
    dir: dir,
    config: path.join(dir, "config.json"),
    outbound: path.join(dir, "outbound.json"),
    meta: path.join(dir, "outbound.meta"),
    applied: path.join(dir, "runtime", "applied"),
    status: path.join(dir, "runtime", "status.json"),
    route: path.join(dir, "runtime", "route"),
    geosite: path.join(dir, "geodata", "geosite.dat"),
    geoip: path.join(dir, "geodata", "geoip.dat"),
    moduleLog: path.join(dir, "logs", "kernelray.log")
  };
}

function runShell(dir, body, args, extraEnv) {
  return execFileSync("bash", ["-c", body, "bash"].concat(args || []), {
    cwd: root,
    env: Object.assign({}, process.env, {
      KR_MODDIR: shPath(dir),
      KR_TEST_SCRIPT: shPath(script),
      // The fake cores never bind the socks port, so a start waits for its deadline: shorten
      // it instead of paying 1.5 s per start. A core that exits is still caught on the first
      // poll, which is what the rollback tests rely on.
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
const BODY_RENDER_TP = '. "$KR_TEST_SCRIPT"; KR_TAKEOVER=$TP kr_render_config "$1"';
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
const CN_RULES_IDLE = CN_RULES_TAKEOVER.slice(4);

// ---- rendering --------------------------------------------------------------------------

check("render: 大陆直连 splits DNS and sends mainland destinations direct", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));

  eq(cfg.dns.servers.length, 3, "two domestic resolvers and the DoH fallback");
  eq(cfg.dns.servers[0], {
    address: "223.5.5.5", domains: ["geosite:cn"], expectIPs: ["geoip:cn"]
  }, "first domestic resolver");
  eq(cfg.dns.servers[1], {
    address: "119.29.29.29", domains: ["geosite:cn"], expectIPs: ["geoip:cn"]
  }, "second domestic resolver");
  eq(cfg.dns.servers[2], "https://1.1.1.1/dns-query", "DoH stays the fallback");
  eq(cfg.dns.queryStrategy, "UseIPv4", "queryStrategy survives the split");

  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "unmatched domains get resolved and re-tested");
  eq(cfg.routing.rules, CN_RULES_TAKEOVER, "rules in order");
});

check("render: 全局 keeps the pre-0014 takeover blocks byte for byte", () => {
  const m = makeModule();
  writeOutbound(m);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.dns, { servers: ["https://1.1.1.1/dns-query"], queryStrategy: "UseIPv4" }, "dns");
  eq(cfg.routing.domainStrategy, "AsIs", "strategy");
  eq(cfg.routing.rules, [
    { inboundTag: ["dns"], domain: ["full:n.example.com"], outboundTag: "direct" },
    { inboundTag: ["dns"], outboundTag: "proxy" },
    { network: "tcp,udp", port: 53, outboundTag: "dns-out" }
  ], "rules");
});

check("render: 大陆直连 in the idle form keeps the geo rules and drops the DNS module", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { KR_TAKEOVER: "0" }));
  eq(cfg.dns, undefined, "no dns module without takeover");
  eq(cfg.inbounds.length, 2, "no tproxy inbound");
  eq(cfg.routing.rules, CN_RULES_IDLE, "geo rules only: no dns inbound exists to route");
  eq(cfg.routing.domainStrategy, "IPIfNonMatch", "strategy");
});

check("render: 全局 in the idle form has no routing at all", () => {
  const m = makeModule();
  writeOutbound(m);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { KR_TAKEOVER: "0" }));
  eq(cfg.routing, undefined, "no routing");
  eq(cfg.dns, undefined, "no dns");
});

check("render: an IP node keeps the resolver rule and loses the bootstrap rule", () => {
  const m = makeModule();
  writeOutbound(m, "203.0.113.9");
  runShell(m.dir, BODY_PREF, ["cn"]);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.routing.rules, CN_RULES_TAKEOVER.slice(1), "no full:host rule for a literal");
  eq(cfg.dns.servers.length, 3, "the split is not tied to the node's hostname");
});

check("render: a pinned node address lands in the hosts of the split DNS too", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  fs.writeFileSync(path.join(m.dir, "runtime", "nodeip"), "203.0.113.9\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.dns.servers.length, 3, "the split survives the pin");
  eq(cfg.dns.hosts, { "full:n.example.com": "203.0.113.9" }, "hosts pin");
  eq(cfg.routing.rules, CN_RULES_TAKEOVER, "the rules are unchanged by the pin");
});

// ---- degradation ------------------------------------------------------------------------

check("degrade: a cn render without geo data falls back to 全局 and says so", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_PREF, ["cn"]);
  fs.unlinkSync(m.geosite);
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.dns, { servers: ["https://1.1.1.1/dns-query"], queryStrategy: "UseIPv4" },
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
  runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" });
  eq(runShell(m.dir, BODY_MODE).trim(), "cn", "the mode is still cn");
});

check("degrade: an empty .dat counts as missing", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.geosite, "");
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_geodata_ok && echo OK || echo MISSING');
  eq(out.trim(), "MISSING", "geodata check");
});

// ---- the asset path ---------------------------------------------------------------------

check("env: XRAY_LOCATION_ASSET points every core invocation at the module's geodata", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  const envLog = path.join(m.dir, "env.log");
  const out = runShell(m.dir, '. "$KR_TEST_SCRIPT"; printf "%s\\n" "$XRAY_LOCATION_ASSET"');
  eq(out.trim(), shPath(m.dir) + "/geodata", "exported at source time");

  runShell(m.dir, BODY_SET, ["cn"], { FAKE_ENV_LOG: shPath(envLog) });
  eq(fs.readFileSync(envLog, "utf8").trim(), shPath(m.dir) + "/geodata",
    "inherited by `xray -test`");
});

// ---- the CLI ----------------------------------------------------------------------------

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
  eq(cfg.routing.rules, CN_RULES_IDLE, "idle form: the core is stopped");
});

check("cli: routing global removes the preference and renders the global form again", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  runShell(m.dir, BODY_SET, ["global"]);
  if (fs.existsSync(m.route)) { throw new Error("global is the absent-file mode"); }
  eq(readJson(m.config).routing, undefined, "no routing in the global idle form");
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
  // Get the global config running first: that is the state the switch starts from.
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
  if (!/^geodataver=loyalsoldier 202610292204$/m.test(kv)) { throw new Error("kv version: " + kv); }

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

// ---- a boot that finds the data gone ------------------------------------------------

check("start: a stale cn config degrades to 全局 when the geo data is gone (switch off)", () => {
  const m = makeModule(modeAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  if (!/geosite:cn/.test(fs.readFileSync(m.config, "utf8"))) {
    throw new Error("fixture: expected a cn config before the data went away");
  }
  fs.unlinkSync(m.geosite);

  // modeAwareCore only stays up for a config without geosite:cn, so this start proves the
  // stale config was re-rendered rather than left to fail -test.
  runShell(m.dir, BODY_START);
  if (/geosite:cn/.test(fs.readFileSync(m.config, "utf8"))) {
    throw new Error("the stale cn config must be re-rendered before the test");
  }
  eq(readJson(m.status).state, "running", "the core starts");
  eq(fs.readFileSync(m.route, "utf8").trim(), "cn", "the preference survives: intent is not rewritten");
  runShell(m.dir, BODY_STOP);
});

check("start: with the switch on, missing geo data still starts and reports the takeover failure", () => {
  const m = makeModule(modeAwareCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_SET, ["cn"]);
  fs.unlinkSync(m.geosite);
  // No iptables in this harness: the engage path fails and falls back to the idle form, which
  // must still be a config the core can load.
  fs.writeFileSync(path.join(m.dir, "runtime", "tproxy"), "on\n");
  runShell(m.dir, BODY_START);
  if (/geosite:cn/.test(fs.readFileSync(m.config, "utf8"))) {
    throw new Error("the fallback config must be the degraded global form");
  }
  const st = readJson(m.status);
  eq(st.state, "running", "the core starts");
  eq(st.phase, "failed/rules", "the takeover failure is reported, not hidden");
  eq(fs.readFileSync(m.route, "utf8").trim(), "cn", "the switch is a preference");
  runShell(m.dir, BODY_STOP);
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
console.log(pass + " routing tests passing");
