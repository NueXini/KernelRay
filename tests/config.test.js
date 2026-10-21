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
    wsSettings: { path: "/ws", headers: { Host: "cdn.example.com" } }
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

// A fake core that stays up only for the idle config. It lets the rollback test exercise
// the "candidate tests but exits right after start" path.
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
  '  if grep -q \'"tag":"proxy","protocol":"freedom"\' "$3"; then',
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
  return {
    dir: dir,
    config: path.join(dir, "config.json"),
    outbound: path.join(dir, "outbound.json"),
    meta: path.join(dir, "outbound.meta"),
    applied: path.join(dir, "runtime", "applied"),
    status: path.join(dir, "runtime", "status.json")
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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const BODY_RENDER = '. "$KR_TEST_SCRIPT"; kr_render_config "$1"';
const BODY_ENSURE = '. "$KR_TEST_SCRIPT"; kr_ensure_config';
const BODY_STATUS = '. "$KR_TEST_SCRIPT"; kr_status_write "$1" "$2"';
const BODY_APPLY = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_apply "$1"';
const BODY_START = '. "$KR_TEST_SCRIPT"; chmod +x "$KR_MODDIR/bin/xray"; kr_start';
const BODY_STOP = '. "$KR_TEST_SCRIPT"; kr_stop';

// ---- template rendering -----------------------------------------------------------------

check("template: valid JSON with the quoted outbound placeholder", () => {
  const t = JSON.parse(fs.readFileSync(template, "utf8"));
  eq(t.outbounds[0], "__KERNELRAY_OUTBOUND__", "placeholder");
  eq(t.outbounds.length, 3, "outbound slots");
});

check("idle render: the template becomes a valid 3-outbound config", () => {
  const m = makeModule();
  const out = runShell(m.dir, BODY_RENDER, [""]);
  if (out.indexOf("__KERNELRAY_OUTBOUND__") >= 0) {
    throw new Error("placeholder survived rendering");
  }
  const cfg = JSON.parse(out);
  eq(cfg.log.loglevel, "warning", "log settings preserved");
  eq(cfg.inbounds.length, 2, "both local inbounds kept");
  eq(cfg.outbounds.length, 3, "proxy + direct + block");
  eq(cfg.outbounds[0], { tag: "proxy", protocol: "freedom", settings: {} }, "idle proxy");
  eq(cfg.outbounds[1].tag, "direct", "direct tag");
  eq(cfg.outbounds[1].streamSettings.sockopt.mark, 19283, "direct bypass mark");
  eq(cfg.outbounds[2].tag, "block", "block tag");
});

check("node render: outbound.json is spliced verbatim, special characters included", () => {
  const m = makeModule();
  writeOutbound(m);
  const out = runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]);
  if (out.indexOf("__KERNELRAY_OUTBOUND__") >= 0) {
    throw new Error("placeholder survived rendering");
  }
  const cfg = JSON.parse(out);
  eq(cfg.outbounds.length, 3, "still three outbounds");
  eq(cfg.outbounds[0], fixture, "the node outbound is first, so it is the default");
  eq(cfg.outbounds[0].settings.servers[0].password, fixture.settings.servers[0].password, "escaping round-trip");
});

check("node render: a pretty-printed outbound file also works", () => {
  const m = makeModule();
  writeOutbound(m, { pretty: true, newline: true });
  const cfg = JSON.parse(runShell(m.dir, BODY_RENDER, [shPath(m.outbound)]));
  eq(cfg.outbounds[0], fixture, "outbound");
});

check("a template without the placeholder is refused", () => {
  const m = makeModule();
  fs.writeFileSync(path.join(m.dir, "config.example.json"), '{"outbounds":[]}\n');
  const r = runFail(m.dir, BODY_RENDER, [""]);
  if (!/placeholder/.test(r.stdout + r.stderr)) {
    throw new Error("expected a placeholder error, got: " + (r.stdout + r.stderr));
  }
});

// ---- kr_ensure_config -------------------------------------------------------------------

check("ensure: missing config falls back to idle and leaves no applied id", () => {
  const m = makeModule();
  runShell(m.dir, BODY_ENSURE);
  const cfg = readJson(m.config);
  eq(cfg.outbounds[0], { tag: "proxy", protocol: "freedom", settings: {} }, "idle");
  if (fs.existsSync(m.applied)) { throw new Error("applied id must not exist"); }
});

check("ensure: a deleted config is rebuilt from the applied outbound", () => {
  const m = makeModule();
  writeOutbound(m);
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_ENSURE);
  const cfg = readJson(m.config);
  eq(cfg.outbounds[0], fixture, "applied outbound");
  eq(fs.readFileSync(m.applied, "utf8").trim(), ID, "applied id kept");
});

check("ensure: a mismatched meta falls back to idle and clears the applied id", () => {
  const m = makeModule();
  writeOutbound(m, { id: OTHER_ID });
  fs.writeFileSync(m.applied, ID + "\n");
  runShell(m.dir, BODY_ENSURE);
  const cfg = readJson(m.config);
  eq(cfg.outbounds[0], { tag: "proxy", protocol: "freedom", settings: {} }, "idle");
  if (fs.existsSync(m.applied)) { throw new Error("stale applied id must be cleared"); }
});

// ---- kr_apply ---------------------------------------------------------------------------

check("apply: a stopped core gets the new config and the applied id", () => {
  const m = makeModule();
  writeOutbound(m);
  runShell(m.dir, BODY_APPLY, [ID]);
  const cfg = readJson(m.config);
  eq(cfg.outbounds[0], fixture, "config carries the node outbound");
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
    runShell(m.dir, BODY_START);
    eq(readJson(m.status).state, "running", "idle core did start");
    eq(fs.existsSync(m.applied), false, "no applied id before the failed apply");

    writeOutbound(m);
    const r = runFail(m.dir, BODY_APPLY, [ID]);
    if (!/previous config restored/.test(r.stderr)) {
      throw new Error("expected a rollback error, got: " + r.stderr);
    }

    const cfg = readJson(m.config);
    eq(cfg.outbounds[0], { tag: "proxy", protocol: "freedom", settings: {} }, "idle config restored");
    if (fs.existsSync(m.applied)) { throw new Error("applied id must be cleared"); }
    const st = readJson(m.status);
    eq(st.state, "running", "restored core is running");
    eq(st.node, "", "no applied node after rollback");
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
