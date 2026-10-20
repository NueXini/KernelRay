// Parser tests for the WebUI.
//
// The parser lives inside module/webroot/app.js (the WebUI is hand-written, no build step), so
// this harness extracts the marked block from the shipped file and runs it. That way the tests
// exercise exactly what ships — there is no second copy to drift.
//
//   node tests/parse.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const jsPath = path.join(__dirname, "..", "module", "webroot", "app.js");
const js = fs.readFileSync(jsPath, "utf8");

const START = "// ---- node parsing ----";
const END = "// ---- end node parsing ----";
const from = js.indexOf(START);
const to = js.indexOf(END);
if (from < 0 || to < 0) {
  console.error("could not find the parser block markers in app.js");
  process.exit(1);
}

const block = js.slice(from, to);
const P = new Function(
  block + "\nreturn { parseLink: parseLink, parseInput: parseInput, identityOf: identityOf, idOf: idOf };"
)();

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(name + "\n    " + e.message);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { throw new Error((what || "value") + "\n      expected " + b + "\n      actual   " + a); }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- vless ------------------------------------------------------------------------------

const REAL_VLESS =
  "vless://da0b1cdf-81a5-340c-a0c7-c35c22923cbd@sfy1.as-tyo1-bgp1.windows-update.xyz:24171" +
  "?type=tcp&security=reality&sni=dlcdn-rogboxbu3.asus.com&fp=edge" +
  "&pbk=UOSnTp3ozouOQn9ZAfUEp4W7b_I9YL_9j8sOUh6StQ8&sid=724a1291&flow=xtls-rprx-vision" +
  "#%E6%97%A5%E6%9C%ACBGP1%5Bx1%7CVless%5D%4010Gbps";

check("vless: reality node (the shape the device actually stores)", () => {
  const r = P.parseLink(REAL_VLESS);
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  const n = r.node;
  eq(n.protocol, "vless", "protocol");
  eq(n.address, "sfy1.as-tyo1-bgp1.windows-update.xyz", "address");
  eq(n.port, 24171, "port");
  eq(n.uuid, "da0b1cdf-81a5-340c-a0c7-c35c22923cbd", "uuid");
  eq(n.encryption, "none", "encryption");
  eq(n.transport, "tcp", "transport");
  eq(n.security, "reality", "security");
  eq(n.sni, "dlcdn-rogboxbu3.asus.com", "sni");
  eq(n.fingerprint, "edge", "fingerprint");
  eq(n.publicKey, "UOSnTp3ozouOQn9ZAfUEp4W7b_I9YL_9j8sOUh6StQ8", "publicKey");
  eq(n.shortId, "724a1291", "shortId");
  eq(n.flow, "xtls-rprx-vision", "flow");
  eq(n.name, "日本BGP1[x1|Vless]@10Gbps", "name from percent-encoded fragment");
  eq(P.idOf(n).length, 16, "id length");
});

check("vless: ws + tls, percent-encoded path, multi alpn", () => {
  const r = P.parseLink(
    "vless://11111111-2222-3333-4444-555555555555@a.example.com:443" +
    "?type=ws&security=tls&sni=a.example.com&path=%2Fws&host=cdn.example.com" +
    "&alpn=h2,http%2F1.1#WS%20node");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.transport, "ws", "transport");
  eq(r.node.security, "tls", "security");
  eq(r.node.path, "/ws", "path");
  eq(r.node.host, "cdn.example.com", "host header");
  eq(r.node.alpn, ["h2", "http/1.1"], "alpn");
  eq(r.node.name, "WS node", "name");
});

check("vless: type=http means h2", () => {
  const r = P.parseLink("vless://11111111-2222-3333-4444-555555555555@a.example.com:443?type=http&security=tls");
  eq(r.node.transport, "h2", "transport");
});

check("vless: ipv6 address loses its brackets", () => {
  const r = P.parseLink("vless://11111111-2222-3333-4444-555555555555@[2001:db8::1]:443?type=tcp#v6");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.address, "2001:db8::1", "address");
  eq(r.node.name, "v6", "name");
});

check("vless: missing uuid is rejected", () => {
  const r = P.parseLink("vless://@a.example.com:443");
  eq(r.ok, false, "ok");
  if (!/uuid/.test(r.error)) { throw new Error("unhelpful error: " + r.error); }
});

// ---- vmess ------------------------------------------------------------------------------

const vmessJson = (over) => b64(JSON.stringify(Object.assign({
  v: "2", ps: "VM-1", add: "b.example.com", port: "8443",
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", aid: "0", scy: "auto",
  net: "ws", type: "none", host: "h.example.com", path: "/ray", tls: "tls", sni: "s.example.com"
}, over)));

check("vmess: base64 JSON", () => {
  const r = P.parseLink("vmess://" + vmessJson({}));
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  const n = r.node;
  eq(n.protocol, "vmess", "protocol");
  eq(n.address, "b.example.com", "address");
  eq(n.port, 8443, "port");
  eq(n.uuid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "uuid");
  eq(n.alterId, 0, "alterId");
  eq(n.cipher, "auto", "cipher");
  eq(n.transport, "ws", "transport");
  eq(n.security, "tls", "security");
  eq(n.path, "/ray", "path");
  eq(n.host, "h.example.com", "host");
  eq(n.sni, "s.example.com", "sni");
  eq(n.name, "VM-1", "name");
});

check("vmess: base64url without padding", () => {
  const r = P.parseLink("vmess://" + b64url(JSON.stringify({
    v: "2", ps: "url", add: "c.example.com", port: 443, id: "id-1", net: "tcp", tls: ""
  })));
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.address, "c.example.com", "address");
  eq(r.node.security, "none", "security");
  eq(r.node.transport, "tcp", "transport");
});

check("vmess: the new vmess:// URI form is refused, not mis-parsed", () => {
  const r = P.parseLink("vmess://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@d.example.com:443?type=ws");
  eq(r.ok, false, "ok");
});

// ---- trojan -----------------------------------------------------------------------------

check("trojan: percent-encoded password, ws, tls by default", () => {
  const r = P.parseLink("trojan://p%40ss%3Aword@c.example.com:443?sni=c.example.com&type=ws&path=%2Ftj#TJ%201");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.password, "p@ss:word", "password");
  eq(r.node.security, "tls", "security default");
  eq(r.node.transport, "ws", "transport");
  eq(r.node.path, "/tj", "path");
  eq(r.node.name, "TJ 1", "name");
});

check("trojan: security=none is honoured", () => {
  const r = P.parseLink("trojan://pw@c.example.com:80?security=none");
  eq(r.node.security, "none", "security");
});

check("trojan: user:pass userinfo yields the password part", () => {
  const r = P.parseLink("trojan://ignored:real-pass@c.example.com:443#t");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.password, "real-pass", "password");
});

// The vless/trojan paths must not depend on `new URL()`: when a WebView disagrees about
// userinfo for non-special schemes, every such link fails at once (this actually happened).
check("vless/trojan survive a URL implementation that drops userinfo", () => {
  const RealURL = global.URL;
  global.URL = function (s) { return new RealURL(s.replace(/^[a-z0-9+.-]+:\/\/[^@]*@/i, "x://")); };
  try {
    const v = P.parseLink("vless://11111111-2222-3333-4444-555555555555@a.example.com:443?type=tcp#v");
    const t = P.parseLink("trojan://pw@b.example.com:443#t");
    eq(v.ok, true, "vless ok");
    eq(v.node.uuid, "11111111-2222-3333-4444-555555555555", "uuid");
    eq(t.ok, true, "trojan ok");
    eq(t.node.password, "pw", "password");
  } finally {
    global.URL = RealURL;
  }
});

// ---- ss ---------------------------------------------------------------------------------

check("ss: SIP002 (base64 userinfo)", () => {
  const r = P.parseLink("ss://" + b64("aes-256-gcm:secret") + "@d.example.com:8388#SS1");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.protocol, "ss", "protocol");
  eq(r.node.method, "aes-256-gcm", "method");
  eq(r.node.password, "secret", "password");
  eq(r.node.address, "d.example.com", "address");
  eq(r.node.port, 8388, "port");
  eq(r.node.name, "SS1", "name");
});

check("ss: SIP002 with plain (percent-encoded) userinfo", () => {
  const r = P.parseLink("ss://chacha20-ietf-poly1305:p%40ss@e.example.com:8389");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.method, "chacha20-ietf-poly1305", "method");
  eq(r.node.password, "p@ss", "password");
  eq(r.node.name, "e.example.com:8389", "name falls back to host:port");
});

check("ss: legacy whole-payload base64", () => {
  const r = P.parseLink("ss://" + b64("aes-128-gcm:pw@f.example.com:8390") + "#legacy");
  if (!r.ok) { throw new Error("parse failed: " + r.error); }
  eq(r.node.method, "aes-128-gcm", "method");
  eq(r.node.password, "pw", "password");
  eq(r.node.address, "f.example.com", "address");
  eq(r.node.port, 8390, "port");
  eq(r.node.name, "legacy", "name");
});

check("ss: SIP003 plugin link is refused", () => {
  const r = P.parseLink("ss://" + b64("aes-256-gcm:secret") + "@d.example.com:8388/?plugin=obfs-local%3Bobfs%3Dhttp#p");
  eq(r.ok, false, "ok");
  if (!/plugin/.test(r.error)) { throw new Error("unhelpful error: " + r.error); }
});

// ---- input handling ---------------------------------------------------------------------

check("input: unknown protocols and junk are reported per line, not swallowed", () => {
  const rows = P.parseInput(
    "hysteria2://pw@g.example.com:443#h2\n" +
    "not a link at all\n" +
    REAL_VLESS);
  eq(rows.length, 3, "row count");
  eq(rows[0].ok, false, "hysteria2 rejected");
  if (!/hysteria2/.test(rows[0].error)) { throw new Error("error should name the scheme: " + rows[0].error); }
  eq(rows[1].ok, false, "junk rejected");
  eq(rows[2].ok, true, "vless accepted");
  eq(rows[2].line, 3, "line number");
});

check("input: a whole base64 subscription blob decodes to lines", () => {
  const blob = b64([
    "trojan://pw@c.example.com:443#one",
    "ss://" + b64("aes-256-gcm:secret") + "@d.example.com:8388#two"
  ].join("\n"));
  const rows = P.parseInput(blob);
  eq(rows.length, 2, "row count");
  eq(rows[0].node.name, "one", "first name");
  eq(rows[1].node.name, "two", "second name");
});

check("input: blank lines and comments are skipped", () => {
  const rows = P.parseInput("\n\n# comment\n// another\n" + REAL_VLESS + "\n");
  eq(rows.length, 1, "row count");
  eq(rows[0].line, 5, "line number preserved");
});

// ---- identity / dedupe ------------------------------------------------------------------

check("identity: renaming does not change the id, so re-import updates in place", () => {
  const a = P.idOf(P.parseLink(REAL_VLESS).node);
  const b = P.idOf(P.parseLink(REAL_VLESS.replace(/#.*$/, "#renamed")).node);
  if (a !== b) { throw new Error("name must not be part of identity"); }
});

check("identity: a different port is a different node", () => {
  const a = P.idOf(P.parseLink(REAL_VLESS).node);
  const b = P.idOf(P.parseLink(REAL_VLESS.replace("24171", "24172")).node);
  if (a === b) { throw new Error("port must be part of identity"); }
});

check("identity: different credentials on the same host are different nodes", () => {
  const a = P.idOf(P.parseLink(REAL_VLESS).node);
  const b = P.idOf(P.parseLink(
    REAL_VLESS.replace("da0b1cdf-81a5-340c-a0c7-c35c22923cbd", "ffffffff-81a5-340c-a0c7-c35c22923cbd")).node);
  if (a === b) { throw new Error("uuid must be part of identity"); }
});

check("identity: host case is not significant", () => {
  const a = P.idOf(P.parseLink("trojan://pw@Host.Example.com:443#a").node);
  const b = P.idOf(P.parseLink("trojan://pw@host.example.com:443#b").node);
  eq(a, b, "id");
});

check("input: a duplicate inside one paste is flagged against its first line", () => {
  const rows = P.parseInput(REAL_VLESS + "\n" + REAL_VLESS.replace(/#.*$/, "#copy"));
  eq(rows.length, 2, "row count");
  eq(rows[0].node.dupOf, undefined, "first occurrence is not a duplicate");
  eq(rows[1].node.dupOf, 1, "second occurrence points at line 1");
  eq(rows[0].node.id, rows[1].node.id, "duplicates share an id");
});

// ---- report -----------------------------------------------------------------------------

if (failures.length) {
  console.error("\n" + failures.length + " failing, " + pass + " passing\n");
  failures.forEach((f) => console.error("FAIL " + f + "\n"));
  process.exit(1);
}
console.log(pass + " parser tests passing");
