// TPROXY takeover tests.
//
// The rule installer, conflict detection and boot path in module/scripts/tproxy.sh run
// against fake iptables/ip6tables/ip/settings binaries that log their arguments, so the
// install/remove/conflict/fail-closed semantics are tested without an Android device.
//
//   node tests/tproxy.test.js
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
  tag: "proxy", protocol: "trojan",
  settings: { servers: [{ address: "n.example.com", port: 443, password: "pw" }] },
  streamSettings: {
    network: "tcp", security: "none", sockopt: { mark: "__KERNELRAY_MARK__" }
  }
};

// iptables/ip6tables: log everything; behave per the FAKE_* knobs. -nL (the
// "is the chain there" probe) fails while FAKE_IPT_NOCHAIN is set, so an install
// actually emits its rules; -N KR_TP_OUTPUT fails while FAKE_IPT_FAIL_N is set.
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

// ip: log; `ip link show` prints $FAKE_IP_LINK when set; the rest succeeds.
// ip: log; `ip link show` prints $FAKE_IP_LINK; `ip [-6] route show …` prints
// $FAKE_IP_DEF (the default route kr_tp_routes copies into the bypass table).
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

const fakeCore = [
  "#!/bin/sh",
  'if [ "$1" = "-version" ]; then echo "Xray 0.0.0 (test)"; exit 0; fi',
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
    ["ip", fakeIp], ["settings", fakeSettings]]) {
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
    tproxy: path.join(dir, "runtime", "tproxy"),
    log: path.join(dir, "logs", "kernelray.log")
  };
}

function runShell(m, body, extraEnv) {
  return execFileSync("bash", ["-c", body, "bash"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      KR_MODDIR: shPath(m.dir),
      KR_TEST_SCRIPT: shPath(script),
      FAKE_LOG: shPath(path.join(m.dir, "iptables.log")),
      FAKE_IP_DEF: "default via 10.0.2.2 dev wlan0",
      PATH: posixPathEnv(path.join(m.dir, "stubs"))
    }, extraEnv || {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// Like runShell but tolerates a non-zero exit (kr_tp_conflict returns 1 on "no conflict").
function runAllow(m, body, extraEnv) {
  try { return { status: 0, stdout: runShell(m, body, extraEnv) }; }
  catch (e) { return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" }; }
}

function writeApplied(m) {
  fs.writeFileSync(m.outbound, JSON.stringify(fixture));
  fs.writeFileSync(m.meta, "id=" + ID + "\nhost=n.example.com\n");
  fs.writeFileSync(m.applied, ID + "\n");
  fs.writeFileSync(m.tproxy, "on\n");
}

function fakeLog(m) {
  try { return fs.readFileSync(path.join(m.dir, "iptables.log"), "utf8"); }
  catch (e) { return ""; }
}

const BODY_INSTALL = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_install';
const BODY_REMOVE = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_remove';
const BODY_CONFLICT = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_conflict';
const BODY_BOOT = '. "$KR_TEST_SCRIPT"; kr_dirs; chmod +x "$KR_MODDIR/bin/xray"; kr_tp_engage; echo "phase=${KR_TP_PHASE:-unset}"';

// ---- install ----------------------------------------------------------------------------

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
  // DNS to a LAN resolver is captured: port 53 is marked before the private ranges.
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

// ---- remove -----------------------------------------------------------------------------

check("remove: tolerant when nothing was ever installed", () => {
  const m = makeModule();
  runShell(m, BODY_REMOVE, {});
  const log = fakeLog(m);
  if (!log.includes("iptables -t mangle -X KR_TP_OUTPUT")) {
    throw new Error("remove must still run its cleanup steps");
  }
});

// ---- conflict ---------------------------------------------------------------------------

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

// ---- engage (start-coupled takeover, ADR 0011) ------------------------------------------

check("engage: no usable outbound installs no rules and keeps the switch", () => {
  const m = makeModule();
  fs.writeFileSync(m.tproxy, "on\n");
  // A stale takeover-form config from the previous session: it must be left alone --
  // nothing starts it, because the start gate refuses without a usable outbound.
  fs.writeFileSync(m.config, JSON.stringify({ sentinel: true }));
  fs.writeFileSync(m.applied, ID + "\n");
  fs.rmSync(m.outbound, { force: true });
  const out = runShell(m, BODY_BOOT, { FAKE_IPT_NOCHAIN: "1" });
  if (!fs.existsSync(m.tproxy)) { throw new Error("the switch is intent and must survive"); }
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id is not silently cleared");
  eq(JSON.parse(fs.readFileSync(m.config, "utf8")), { sentinel: true }, "config untouched");
  const log = fakeLog(m);
  if (log.includes("iptables -t mangle -N KR_TP_OUTPUT")) {
    throw new Error("no usable outbound means no rules, even with the switch on (ADR 0011)");
  }
  if (!/phase=unset/.test(out)) { throw new Error("unexpected phase: " + out); }
});

check("engage: nothing applied at all keeps the network direct", () => {
  const m = makeModule();
  fs.writeFileSync(m.tproxy, "on\n");
  const out = runShell(m, BODY_BOOT, { FAKE_IP_LINK: TUN_UP });
  if (!fs.existsSync(m.tproxy)) { throw new Error("the switch is intent and must survive"); }
  const log = fakeLog(m);
  if (log.includes("-N KR_TP_OUTPUT")) {
    throw new Error("a start without an applied node never installs the rules (ADR 0011)");
  }
  if (!/phase=unset/.test(out)) { throw new Error("unexpected phase: " + out); }
});

check("engage: a conflict renders the no-takeover config and reports failed/conflict", () => {
  const m = makeModule();
  writeApplied(m);
  const out = runShell(m, BODY_BOOT, {
    FAKE_IPT_NOCHAIN: "1", FAKE_IP_LINK: TUN_UP
  });
  const cfg = JSON.parse(fs.readFileSync(m.config, "utf8"));
  eq(cfg.inbounds.length, 2, "no tproxy inbound after a conflict");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 0, "mark dropped");
  eq(cfg.routing, undefined, "no routing after a conflict");
  const st = JSON.parse(fs.readFileSync(m.status, "utf8"));
  eq(st.phase, "failed/conflict", "phase");
  eq(st.tproxy, "on", "the switch stays on: intent is not silently rewritten");
  if (!/phase=failed\/conflict/.test(out)) { throw new Error("KR_TP_PHASE wrong: " + out); }
  if (fs.existsSync(m.tproxy) === false) { throw new Error("switch file must survive"); }
});

check("engage: a failed rule install reports failed/rules and stays no-takeover", () => {
  const m = makeModule();
  writeApplied(m);
  const out = runShell(m, BODY_BOOT, { FAKE_IPT_NOCHAIN: "1", FAKE_IPT_FAIL_N: "1" });
  const cfg = JSON.parse(fs.readFileSync(m.config, "utf8"));
  eq(cfg.inbounds.length, 2, "no tproxy inbound after a rule failure");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 0, "mark dropped");
  const st = JSON.parse(fs.readFileSync(m.status, "utf8"));
  eq(st.phase, "failed/rules", "phase");
  if (!/phase=failed\/rules/.test(out)) { throw new Error("KR_TP_PHASE wrong: " + out); }
});

check("engage: with no conflict the takeover config is on disk before the core starts", () => {
  const m = makeModule();
  writeApplied(m);
  const out = runShell(m, BODY_BOOT, {});
  const cfg = JSON.parse(fs.readFileSync(m.config, "utf8"));
  eq(cfg.inbounds.length, 3, "tproxy inbound present");
  eq(cfg.outbounds[0].streamSettings.sockopt.mark, 19282, "live mark");
  eq(cfg.routing.rules.some((r) => r.outboundTag === "dns-out"), true, "dns rule present");
  if (!/phase=idle/.test(out)) { throw new Error("KR_TP_PHASE wrong: " + out); }
  if (!fs.existsSync(m.tproxy)) { throw new Error("switch file must survive a successful engage"); }
});

// ---- the switch is a pure preference (ADR 0011) ------------------------------------------

check("switch: on/off only writes the preference, never the core or the rules", () => {
  const m = makeModule();
  const tp = m.tproxy.split("\\").join("/");
  const body = '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tproxy_set off; [ -e "' + tp + '" ] && echo STILL-THERE;' +
    ' kr_tproxy_set on; grep -q on "' + tp + '" && echo ON';
  const out = runShell(m, body, { FAKE_IPT_NOCHAIN: "1" });
  if (out.includes("STILL-THERE")) { throw new Error("off must remove the switch file"); }
  if (!out.includes("ON")) { throw new Error("on must write the switch file"); }
  const log = fakeLog(m);
  if (log.includes("iptables") || log.includes("ip6tables") || log.includes("ip rule")) {
    throw new Error("the switch write must not install or remove rules");
  }
});

check("switch: install defaults it to on, an update resets an off back to on", () => {
  const m = makeModule();
  runShell(m, '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tp_default_on; kr_tp_default_on', {});
  if (!fs.existsSync(m.tproxy)) { throw new Error("install must create the switch (default on)"); }

  // ADR 0002 + ADR 0011: an update replaces the module dir and re-runs the installer,
  // so an explicit off does not survive it -- the accepted cost of default-on.
  const m2 = makeModule();
  fs.writeFileSync(m2.tproxy, "on\n");
  runShell(m2, '. "$KR_TEST_SCRIPT"; kr_dirs; kr_tproxy_set off; kr_tp_default_on', {});
  if (fs.readFileSync(m2.tproxy, "utf8").trim() !== "on") {
    throw new Error("the installer must reset the switch to on");
  }
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
console.log(pass + " tproxy tests passing");
