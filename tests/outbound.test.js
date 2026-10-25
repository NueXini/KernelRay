// Outbound renderer tests for the WebUI.
//
// The renderer lives inside module/webroot/app.js; this harness extracts the marked
// block from the shipped file, exactly like tests/parse.test.js does for the parser.
// That keeps the fixture-free "node → Xray outbound" step honest without a browser.
//
//   node tests/outbound.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const jsPath = path.join(__dirname, "..", "module", "webroot", "app.js");
const js = fs.readFileSync(jsPath, "utf8");

const START = "// ---- outbound rendering ----";
const END = "// ---- end outbound rendering ----";
const from = js.indexOf(START);
const to = js.indexOf(END);
if (from < 0 || to < 0) {
  console.error("could not find the outbound block markers in app.js");
  process.exit(1);
}

const block = js.slice(from, to);
const O = new Function(block + "\nreturn { outboundOf: outboundOf };")();

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

const VLESS_UUID = "da0b1cdf-81a5-340c-a0c7-c35c22923cbd";
const TLS_SNI = "dlcdn-rogboxbu3.asus.com";

function node(over) {
  return Object.assign({
    protocol: "vless", address: "a.example.com", port: 443,
    uuid: VLESS_UUID, encryption: "none", transport: "tcp", security: "none"
  }, over);
}

// ---- vless ------------------------------------------------------------------------------

check("vless: reality + tcp + vision flow", () => {
  const o = O.outboundOf(node({
    transport: "tcp", security: "reality", sni: TLS_SNI, fingerprint: "edge",
    publicKey: "UOSnTp3ozouOQn9ZAfUEp4W7b_I9YL_9j8sOUh6StQ8", shortId: "724a1291",
    flow: "xtls-rprx-vision"
  }));
  eq(o.tag, "proxy", "tag");
  eq(o.protocol, "vless", "protocol");
  eq(o.settings, {
    vnext: [{
      address: "a.example.com", port: 443,
      users: [{ id: VLESS_UUID, encryption: "none", flow: "xtls-rprx-vision" }]
    }]
  }, "settings");
  eq(o.streamSettings.network, "tcp", "network");
  eq(o.streamSettings.security, "reality", "security");
  eq(o.streamSettings.realitySettings, {
    serverName: TLS_SNI, fingerprint: "edge",
    publicKey: "UOSnTp3ozouOQn9ZAfUEp4W7b_I9YL_9j8sOUh6StQ8", shortId: "724a1291"
  }, "realitySettings");
  eq(o.streamSettings.tlsSettings, undefined, "reality must not get tlsSettings");
});

check("vless: ws + tls keeps Host, path, alpn and allowInsecure", () => {
  const o = O.outboundOf(node({
    transport: "ws", security: "tls", sni: TLS_SNI, host: "cdn.example.com",
    path: "/ray", alpn: ["h2", "http/1.1"], fingerprint: "chrome", allowInsecure: true
  }));
  eq(o.streamSettings.wsSettings, {
    path: "/ray", headers: { Host: "cdn.example.com" }
  }, "wsSettings");
  eq(o.streamSettings.tlsSettings, {
    serverName: TLS_SNI, alpn: ["h2", "http/1.1"],
    fingerprint: "chrome", allowInsecure: true
  }, "tlsSettings");
  eq(o.streamSettings.realitySettings, undefined, "tls must not get realitySettings");
});

check("vless: flow is omitted when the link did not ask for it", () => {
  const o = O.outboundOf(node({}));
  eq(o.settings.vnext[0].users[0], { id: VLESS_UUID, encryption: "none" }, "user");
});

check("vless: a string alpn is normalised to an array", () => {
  const o = O.outboundOf(node({ security: "tls", alpn: "h2,http/1.1" }));
  eq(o.streamSettings.tlsSettings.alpn, ["h2", "http/1.1"], "alpn");
});

check("vless: security none produces no tls/reality block", () => {
  const o = O.outboundOf(node({}));
  eq(o.streamSettings, { network: "tcp", security: "none", sockopt: { mark: "__KERNELRAY_MARK__" } }, "streamSettings");
});

// ---- vmess ------------------------------------------------------------------------------

check("vmess: alterId and cipher map to the Xray user object", () => {
  const o = O.outboundOf(node({
    protocol: "vmess", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    alterId: 0, cipher: "auto", transport: "grpc", security: "tls",
    serviceName: "svc", sni: TLS_SNI
  }));
  eq(o.settings, {
    vnext: [{
      address: "a.example.com", port: 443,
      users: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", alterId: 0, security: "auto" }]
    }]
  }, "settings");
  eq(o.streamSettings.grpcSettings, { serviceName: "svc" }, "grpcSettings");
  eq(o.streamSettings.tlsSettings.serverName, TLS_SNI, "sni");
});

check("vmess: default cipher is auto", () => {
  const o = O.outboundOf(node({ protocol: "vmess", uuid: "id", cipher: undefined }));
  eq(o.settings.vnext[0].users[0].security, "auto", "security");
});

// ---- trojan / ss ------------------------------------------------------------------------

check("trojan: password, path and Host", () => {
  const o = O.outboundOf(node({
    protocol: "trojan", password: "p@ss:word", transport: "ws", security: "tls",
    sni: TLS_SNI, host: "cdn.example.com", path: "/tj"
  }));
  eq(o.settings, {
    servers: [{ address: "a.example.com", port: 443, password: "p@ss:word" }]
  }, "settings");
  eq(o.streamSettings.wsSettings, {
    path: "/tj", headers: { Host: "cdn.example.com" }
  }, "wsSettings");
});

check("ss: method and password", () => {
  const o = O.outboundOf({
    protocol: "ss", address: "d.example.com", port: 8388,
    method: "aes-256-gcm", password: "secret"
  });
  eq(o.settings, {
    servers: [{ address: "d.example.com", port: 8388, method: "aes-256-gcm", password: "secret" }]
  }, "settings");
  eq(o.streamSettings, { network: "tcp", security: "none", sockopt: { mark: "__KERNELRAY_MARK__" } }, "streamSettings");
});

// ---- transports -------------------------------------------------------------------------

check("h2: httpSettings uses an array for host", () => {
  const o = O.outboundOf(node({
    transport: "h2", security: "tls", host: "h.example.com", path: "/h2"
  }));
  eq(o.streamSettings.httpSettings, {
    path: "/h2", host: ["h.example.com"]
  }, "httpSettings");
});

check("httpupgrade: httpupgradeSettings keeps host as a string", () => {
  const o = O.outboundOf(node({
    transport: "httpupgrade", host: "u.example.com", path: "/up"
  }));
  eq(o.streamSettings.httpupgradeSettings, {
    path: "/up", host: "u.example.com"
  }, "httpupgradeSettings");
});

check("unknown transports are passed through rather than guessed at", () => {
  const o = O.outboundOf(node({ transport: "kcp" }));
  eq(o.streamSettings.network, "kcp", "network");
  eq(o.streamSettings.kcpSettings, undefined, "no invented transport settings");
});

// ---- escaping and validation ------------------------------------------------------------

check("credentials survive JSON escaping and stay on one line", () => {
  const pw = "p\"a\\s$`'<>&\nline2";
  const o = O.outboundOf(node({ protocol: "trojan", password: pw }));
  const text = JSON.stringify(o);
  if (text.indexOf("\n") >= 0) { throw new Error("outbound JSON must be one line"); }
  eq(JSON.parse(text).settings.servers[0].password, pw, "password round-trip");
});

check("port strings are coerced to numbers", () => {
  const o = O.outboundOf(node({ port: "8443" }));
  eq(o.settings.vnext[0].port, 8443, "port");
  eq(typeof o.settings.vnext[0].port, "number", "port type");
});

// The renderer never writes a real mark: a SO_MARK without the matching ip rule loses
// routing on Android (verified on v0.6). It writes the placeholder, and the shell —
// which knows the switch state — replaces it with the bypass mark or 0, so mark and
// rules always ship together (docs/adr/0008).
check("every protocol carries the mark placeholder, never a real mark", () => {
  const fixtures = [
    node({}),
    node({ protocol: "vmess", uuid: "id" }),
    node({ protocol: "trojan", password: "pw" }),
    { protocol: "ss", address: "d.example.com", port: 8388, method: "aes-256-gcm", password: "secret" }
  ];
  fixtures.forEach((n) => {
    eq(O.outboundOf(n).streamSettings.sockopt, { mark: "__KERNELRAY_MARK__" }, n.protocol);
  });
});

check("an unsupported protocol is rejected instead of rendered", () => {
  assert.throws(() => O.outboundOf({ protocol: "hysteria2", address: "x", port: 443 }), /unsupported/);
});

check("missing required fields are rejected", () => {
  assert.throws(() => O.outboundOf(node({ address: "" })), /address/);
  assert.throws(() => O.outboundOf(node({ port: 0 })), /port/);
  assert.throws(() => O.outboundOf(node({ uuid: "" })), /uuid/);
  assert.throws(() => O.outboundOf(node({ protocol: "trojan" })), /password/);
  assert.throws(() => O.outboundOf({ protocol: "ss", address: "x", port: 1 }), /method/);
});

// ---- report -----------------------------------------------------------------------------

if (failures.length) {
  console.error("\n" + failures.length + " failing, " + pass + " passing\n");
  failures.forEach((f) => console.error("FAIL " + f + "\n"));
  process.exit(1);
}
console.log(pass + " outbound tests passing");
