// Config-assembly tests.
//
// The shell is the only thing that turns the template + outbound.json into config.json.
// This harness sources the shipped kernelray.sh against a throwaway module dir and a fake
// core, so it can test rendering, the applied-id bookkeeping and apply's failure paths
// without an Android device or a real Xray binary.
//
//   node tests/config.test.js
//
// Requires bash (Git Bash on Windows). The fake core only runs for the rollback test,
// which uses /proc to identify the process; there is no real Xray or iptables here.

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

// A fake core that stays up only for a config built from the "old" node outbound
// (address old.example.com). It lets the rollback tests exercise the "candidate tests
// but exits right after start" path while a real config is running.
// A fake core that stays up for any config: the start-path tests need a live pid, and /proc is
// what kr_running checks.
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

// Git Bash wants /c/Users/... where Node sees C:\Users\...
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
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  // kernelray.sh sources the takeover helpers from $KR_MODDIR/scripts, so the fixture
  // needs the real tproxy.sh for the takeover render paths.
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "module", "scripts", "tproxy.sh"),
    path.join(dir, "scripts", "tproxy.sh"));
  return {
    dir: dir,
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    outbound: path.join(dir, "outbound.json"),
    meta: path.join(dir, "outbound.meta"),
    applied: path.join(dir, "runtime", "applied"),
    status: path.join(dir, "runtime", "status.json"),
    tproxy: path.join(dir, "runtime", "tproxy"),
    loglevel: path.join(dir, "runtime", "loglevel")
  };
}

function runShell(dir, body, args, extraEnv) {
  return execFileSync("bash", ["-c", body, "bash"].concat(args || []), {
    cwd: root,
    env: Object.assign({}, process.env, {
      KR_MODDIR: shPath(dir),
      KR_TEST_SCRIPT: shPath(script)
    }, extraEnv || {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
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

function writeOutbound(m, opts) {
  const o = opts || {};
  fs.writeFileSync(m.outbound, JSON.stringify(fixture, null, o.pretty ? 2 : 0) + (o.newline ? "\n" : ""));
  fs.writeFileSync(m.meta, "id=" + (o.id || ID) + "\nhost=n.example.com\n");
}

// The UI serialises state.json pretty-printed; the shell's extraction relies on that
// shape (every settings key on its own line).
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
const BODY_RENDER_TP = '. "$KR_TEST_SCRIPT"; KR_TAKEOVER=$TP kr_render_config "$1"';
const BODY_ENSURE = '. "$KR_TEST_SCRIPT"; kr_ensure_config';
const BODY_STATUS = '. "$KR_TEST_SCRIPT"; kr_status_write "$1" "$2"';
const BODY_APPLY = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_apply "$1"';
const BODY_UNAPPLY = '. "$KR_TEST_SCRIPT"; kr_unapply';
const BODY_PORTS = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_apply_ports';
const BODY_START = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_start';
const BODY_STOP = '. "$KR_TEST_SCRIPT"; kr_stop';
const BODY_CLI = '. "$KR_TEST_SCRIPT"; kr_cli "$@"';

// ---- template rendering -----------------------------------------------------------------

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

check("node render: outbound.json is spliced verbatim, special characters included", () => {
  const m = makeModule();
  writeOutbound(m);
  const out = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (out.indexOf("__KERNELRAY") >= 0) {
    throw new Error("a placeholder survived rendering");
  }
  const cfg = JSON.parse(out);
  eq(cfg.log.loglevel, "warning", "log settings preserved");
  eq(cfg.inbounds.length, 2, "both local inbounds kept, no tproxy inbound");
  eq(cfg.inbounds[0].port, 10808, "default socks port without state.json");
  eq(cfg.inbounds[1].port, 10809, "default http port without state.json");
  eq(cfg.outbounds.length, 3, "proxy + direct + block");
  eq(cfg.outbounds[0], Object.assign({}, fixture,
    { streamSettings: Object.assign({}, fixture.streamSettings,
      { sockopt: { mark: 0 } }) }), "the node outbound carries mark 0 without takeover");
  eq(cfg.outbounds[1].tag, "direct", "direct tag");
  eq(cfg.outbounds[1].streamSettings.sockopt.mark, 19282, "direct bypass mark");
  eq(cfg.outbounds[2].tag, "block", "block tag");
  eq(cfg.dns, undefined, "no dns block without takeover");
  eq(cfg.routing, undefined, "no routing block without takeover");
  eq(cfg.outbounds[0].settings.servers[0].password, fixture.settings.servers[0].password, "escaping round-trip");
});

check("node render: a pretty-printed outbound file also works", () => {
  const m = makeModule();
  writeOutbound(m, { pretty: true, newline: true });
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.outbounds[0].settings.servers[0].password, fixture.settings.servers[0].password, "outbound");
});

// ---- takeover render -------------------------------------------------------------------

check("takeover render: tproxy inbound, dns module and routing are spliced in", () => {
  const m = makeModule();
  writeOutbound(m);
  const out = runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" });
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
  eq(cfg.dns, { servers: ["https://1.1.1.1/dns-query"], queryStrategy: "UseIPv4" }, "dns upstream: A-only, so apps never leak over v6");
  eq(cfg.routing.rules[0], {
    inboundTag: ["dns"], domain: ["full:n.example.com"], outboundTag: "direct"
  }, "the node host resolves through direct (bootstrap)");
  eq(cfg.routing.rules[1], { inboundTag: ["dns"], outboundTag: "proxy" }, "dns upstream goes through the proxy");
  eq(cfg.routing.rules[2], { network: "tcp,udp", port: 53, outboundTag: "dns-out" }, "port 53 to dns-out");
  eq(cfg.routing.rules.length, 3, "no other rules");
});

check("takeover render: a pinned node address lands in the dns hosts", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(path.join(m.dir, "runtime", "nodeip"), "203.0.113.9\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.dns.hosts, { "full:n.example.com": "203.0.113.9" }, "hosts pin");
  eq(cfg.routing.rules[0].outboundTag, "direct", "bootstrap rule kept");
});

check("takeover render: an IP node produces no bootstrap domain rule", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=203.0.113.10\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.routing.rules.length, 2, "only the dns and port-53 rules");
  eq(cfg.routing.rules[0], { inboundTag: ["dns"], outboundTag: "proxy" }, "dns upstream first");
});

check("takeover render: an IPv6 node literal produces no bootstrap domain rule", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=2001:db8::1\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" }));
  eq(cfg.routing.rules.length, 2, "only the dns and port-53 rules");
});

check("takeover render: the mark is 0, never a live mark, when takeover is forced off", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.tproxy, "on\n");
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "0" }));
  eq(cfg.inbounds.length, 2, "no tproxy inbound");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 0, "mark 0");
  eq(cfg.routing, undefined, "no routing");
});

check("takeover render: an outbound without the mark placeholder is refused", () => {
  const m = makeModule();
  // A stale renderer could write an unmarked outbound; under takeover its packets
  // would be captured back into the core: a routing loop. The render must fail.
  fs.writeFileSync(m.outbound, JSON.stringify(fixture).replace(
    /,"sockopt":\{"mark":"__KERNELRAY_MARK__"\}/, ""));
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=n.example.com\n");
  const r = runFail(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" });
  if (!/no bypass mark/.test(r.stdout + r.stderr)) {
    throw new Error("expected the mark refusal, got: " + (r.stdout + r.stderr));
  }
});

check("render follows the switch when rules are present, and stays no-takeover when they are not", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.tproxy, "on\n");
  // No stubs: iptables is missing or finds no rules here, so the render must stay no-takeover.
  let cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.inbounds.length, 2, "switch without rules renders the no-takeover form");

  fs.mkdirSync(path.join(m.dir, "stubs"), { recursive: true });
  fs.writeFileSync(path.join(m.dir, "stubs", "iptables"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(m.dir, "stubs", "ip6tables"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(m.dir, "stubs", "iptables"), 0o755);
  fs.chmodSync(path.join(m.dir, "stubs", "ip6tables"), 0o755);
  const stubPath = path.join(m.dir, "stubs") + ":" + process.env.PATH;
  cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], {
    PATH: process.platform === "win32" ? shPath(path.join(m.dir, "stubs")) + ";" + process.env.PATH : stubPath
  }));
  eq(cfg.inbounds.length, 3, "switch plus rules renders takeover-form");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "live mark");
});

check("a template without the placeholder is refused", () => {
  const m = makeModule();
  fs.writeFileSync(path.join(m.dir, "config.example.json"), '{"outbounds":[]}\n');
  const r = runFail(m.dir, BODY_RENDER, [""]);
  if (!/placeholder/.test(r.stdout + r.stderr)) {
    throw new Error("expected a placeholder error, got: " + (r.stdout + r.stderr));
  }
});

// ---- inbound ports ---------------------------------------------------------------------

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
  if (!/does not match the applied node/.test(r.stderr)) {
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
  // The running config is still the old one: the state the UI warns about.
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
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 0, "mark dropped while the switch is off");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id kept");
});

check("ensure: a mismatched meta refuses and keeps the applied id", () => {
  const m = makeModule();
  writeOutbound(m, { id: OTHER_ID });
  fs.writeFileSync(m.applied, ID + "\n");
  const r = runFail(m.dir, BODY_ENSURE);
  if (!/no matching outbound/.test(r.stdout + r.stderr)) {
    throw new Error("expected the bookkeeping refusal, got: " + r.stdout + r.stderr);
  }
  if (fs.existsSync(m.config)) { throw new Error("no config must be created"); }
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id is kept, never silently cleared");
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
  if (!/no matching outbound/.test(r.stdout + r.stderr)) {
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
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 0, "mark dropped while the switch is off");
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
    // The core runs the "old" node's config; the candidate (the fixture node) tests
    // but exits right after start, so the swap must restore the previous config.
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
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* best effort */ }
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
    // The previous config disappears while the core is up, so the swap has nothing to
    // roll back to: the core must go down, not fall back to anything.
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
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* best effort */ }
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
    try { runShell(m.dir, BODY_STOP); } catch (e) { /* best effort */ }
  }
});

// ---- status bookkeeping -----------------------------------------------------------------

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
  const kv = runShell(m.dir, '. "$KR_TEST_SCRIPT"; kr_status_kv');
  if (/^phase=crashed$/m.test(kv)) { throw new Error("a stop is not a crash: " + kv); }
  if (!/^state=stopped$/m.test(kv)) { throw new Error("state: " + kv); }
});

// ---- start-path form drift ---------------------------------------------------------------

check("start: a takeover config left on disk is re-rendered when the switch is off", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  // What the previous start left behind: the takeover form, with the node outbound marked.
  const cfg = runShell(m.dir, BODY_RENDER_TP, [shPath(m.outbound)], { TP: "1" });
  fs.writeFileSync(m.config, cfg);
  if (!/"tag":"tp-in"/.test(cfg)) { throw new Error("fixture: expected a takeover config"); }

  // No runtime/tproxy file: the switch is off, so this start must be an idle run.
  runShell(m.dir, BODY_START);
  const after = fs.readFileSync(m.config, "utf8");
  if (/"tag":"tp-in"/.test(after)) {
    throw new Error("the idle form has no tproxy inbound: " + after);
  }
  if (!/"mark":0/.test(after)) {
    throw new Error("a bypass mark with no ip rule loses routing (docs/adr/0008): " + after);
  }
  runShell(m.dir, BODY_STOP);
});

check("start: a config that already matches this start is left alone", () => {
  const m = makeModule(aliveCore);
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  const cfg = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)], { TP: "0" });
  fs.writeFileSync(m.config, cfg);
  const before = fs.statSync(m.config).mtimeMs;
  runShell(m.dir, BODY_START);
  eq(fs.readFileSync(m.config, "utf8"), cfg, "the config is not rewritten");
  eq(fs.statSync(m.config).mtimeMs, before, "not even touched");
  runShell(m.dir, BODY_STOP);
});

// ---- report -----------------------------------------------------------------------------

dirs.forEach((d) => {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* Windows can hold a file */ }
});

if (failures.length) {
  console.error("\n" + failures.length + " failing, " + pass + " passing\n");
  failures.forEach((f) => console.error("FAIL " + f + "\n"));
  process.exit(1);
}
console.log(pass + " config tests passing");
