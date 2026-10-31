// Node → share-link tests for the WebUI.
//
// The generator lives inside module/webroot/app.js, next to the parser it must round-trip
// through. This harness extracts both marked blocks from the shipped file, so the copied link
// is tested against the exact parser that will read it back on the device.
//
//   node tests/link.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const jsPath = path.join(__dirname, "..", "module", "webroot", "app.js");
const js = fs.readFileSync(jsPath, "utf8");

function marked(start, end) {
  const from = js.indexOf(start);
  const to = js.indexOf(end);
  if (from < 0 || to < 0) {
    console.error("could not find the " + start + " block markers in app.js");
    process.exit(1);
  }
  return js.slice(from, to);
}

const linksBlock = marked("// ---- node links ----", "// ---- end node links ----");
const parseBlock = marked("// ---- node parsing ----", "// ---- end node parsing ----");
const L = new Function(linksBlock +
  "\nreturn { linkOf: linkOf, base64Link: base64Link };")();
const P = new Function(parseBlock +
  "\nreturn { parseLink: parseLink, parseInput: parseInput, identityOf: identityOf };")();

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

function roundTrip(node) {
  const link = L.linkOf(node);
  const r = P.parseLink(link);
  if (!r.ok) { throw new Error("round-trip parse failed: " + r.error + "\nlink: " + link); }
  return { link: link, node: r.node };
}

const VLESS_UUID = "da0b1cdf-81a5-340c-a0c7-c35c22923cbd";

// ---- vless ------------------------------------------------------------------------------

check("vless: reality node round-trips through the parser", () => {
  const n = {
    protocol: "vless", address: "sfy1.example.com", port: 24171, uuid: VLESS_UUID,
    encryption: "none", transport: "tcp", security: "reality",
    sni: "cdn.example.com", fingerprint: "edge",
    publicKey: "UOSnTp3ozouOQn9ZAfUEp4W7b_I9YL_9j8sOUh6StQ8", shortId: "724a1291",
    flow: "xtls-rprx-vision", name: "日本BGP1[x1|Vless]@10Gbps"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.transport, "tcp", "transport");
  eq(r.node.security, "reality", "security");
  eq(r.node.sni, "cdn.example.com", "sni");
  eq(r.node.fingerprint, "edge", "fingerprint");
  eq(r.node.publicKey, n.publicKey, "publicKey");
  eq(r.node.shortId, "724a1291", "shortId");
  eq(r.node.flow, "xtls-rprx-vision", "flow");
  eq(r.node.name, n.name, "name");
  if (!/^vless:\/\/[^@]+@sfy1\.example\.com:24171\?/.test(r.link)) {
    throw new Error("unexpected link shape: " + r.link);
  }
  if (!/encryption=none/.test(r.link)) { throw new Error("vless link lost encryption=none"); }
});

check("vless: ws + tls keeps path, host, alpn and allowInsecure", () => {
  const n = {
    protocol: "vless", address: "a.example.com", port: 443, uuid: VLESS_UUID,
    encryption: "none", transport: "ws", security: "tls",
    sni: "a.example.com", path: "/ws?x=1&y=2", host: "cdn.example.com",
    alpn: ["h2", "http/1.1"], allowInsecure: true, name: "WS #1"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.transport, "ws", "transport");
  eq(r.node.path, n.path, "path");
  eq(r.node.host, n.host, "host");
  eq(r.node.alpn, n.alpn, "alpn");
  eq(r.node.allowInsecure, true, "allowInsecure");
  eq(r.node.name, n.name, "name");
});

check("vless: IPv6 gets brackets in the URI and loses them in the store", () => {
  const n = {
    protocol: "vless", address: "2001:db8::1", port: 443, uuid: VLESS_UUID,
    encryption: "none", transport: "tcp", security: "none", name: "v6"
  };
  const r = roundTrip(n);
  if (r.link.indexOf("@[2001:db8::1]:443") < 0) {
    throw new Error("IPv6 host is not bracketed: " + r.link);
  }
  eq(r.node.address, "2001:db8::1", "address");
});

check("vless: a missing uuid is refused", () => {
  let failed = false;
  try { L.linkOf({ protocol: "vless", address: "a", port: 443 }); } catch (e) { failed = /uuid/.test(e.message); }
  eq(failed, true, "missing uuid refused");
});

check("vless: gRPC serviceName round-trips", () => {
  const n = {
    protocol: "vless", address: "g.example.com", port: 443, uuid: VLESS_UUID,
    encryption: "none", transport: "grpc", security: "tls",
    sni: "g.example.com", serviceName: "my-service", name: "GRPC"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.transport, "grpc", "transport");
  eq(r.node.serviceName, n.serviceName, "serviceName");
});

// ---- trojan -----------------------------------------------------------------------------

check("trojan: special-character password, ws and tls round-trip", () => {
  const n = {
    protocol: "trojan", address: "c.example.com", port: 443, password: "p@ss:word/?#",
    transport: "ws", security: "tls", sni: "c.example.com", path: "/tj",
    host: "c.example.com", alpn: ["h2"], name: "TJ 1"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.password, n.password, "password");
  eq(r.node.transport, "ws", "transport");
  eq(r.node.security, "tls", "security");
  eq(r.node.sni, n.sni, "sni");
  eq(r.node.path, n.path, "path");
  eq(r.node.alpn, n.alpn, "alpn");
  eq(r.node.name, n.name, "name");
});

check("trojan: security=none survives the round-trip", () => {
  const n = {
    protocol: "trojan", address: "c.example.com", port: 80, password: "pw",
    transport: "tcp", security: "none", name: "plain"
  };
  const r = roundTrip(n);
  eq(r.node.security, "none", "security");
});

check("trojan: reality fields survive the round-trip", () => {
  const n = {
    protocol: "trojan", address: "c.example.com", port: 443, password: "pw",
    transport: "tcp", security: "reality", sni: "cdn.example.com",
    fingerprint: "edge", publicKey: "pk", shortId: "sid", flow: "xtls-rprx-vision",
    name: "TJ reality"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.security, "reality", "security");
  eq(r.node.publicKey, n.publicKey, "publicKey");
  eq(r.node.shortId, n.shortId, "shortId");
  eq(r.node.flow, n.flow, "flow");
});

// ---- vmess ------------------------------------------------------------------------------

check("vmess: JSON link round-trips transport, TLS and name", () => {
  const n = {
    protocol: "vmess", address: "b.example.com", port: 8443, uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    alterId: 0, cipher: "auto", transport: "ws", security: "tls",
    sni: "s.example.com", fingerprint: "chrome", host: "h.example.com", path: "/ray",
    alpn: ["h2", "http/1.1"], name: "VM-1"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.alterId, 0, "alterId");
  eq(r.node.cipher, "auto", "cipher");
  eq(r.node.transport, "ws", "transport");
  eq(r.node.security, "tls", "security");
  eq(r.node.sni, n.sni, "sni");
  eq(r.node.fingerprint, n.fingerprint, "fingerprint");
  eq(r.node.host, n.host, "host");
  eq(r.node.path, n.path, "path");
  eq(r.node.alpn, n.alpn, "alpn");
  eq(r.node.name, n.name, "name");
  if (r.link.indexOf("vmess://") !== 0) { throw new Error("not a vmess link"); }
});

check("vmess: IPv6 is plain in the JSON add field", () => {
  const n = {
    protocol: "vmess", address: "2001:db8::2", port: 443, uuid: "id-1",
    alterId: 0, cipher: "auto", transport: "tcp", security: "none", name: "v6"
  };
  const r = roundTrip(n);
  eq(r.node.address, "2001:db8::2", "address");
  const body = Buffer.from(r.link.slice("vmess://".length), "base64").toString("utf8");
  const j = JSON.parse(body);
  eq(j.add, "2001:db8::2", "add has no brackets");
  eq(j.port, "443", "port is a string");
  eq(j.aid, "0", "aid is a string");
  eq(j.tls, "", "none is an empty tls");
});

// ---- ss ---------------------------------------------------------------------------------

check("ss: SIP002 link round-trips method, password and name", () => {
  const n = {
    protocol: "ss", address: "d.example.com", port: 8388,
    method: "aes-256-gcm", password: "p@ss:word", name: "SS 1"
  };
  const r = roundTrip(n);
  eq(P.identityOf(r.node), P.identityOf(n), "identity");
  eq(r.node.method, n.method, "method");
  eq(r.node.password, n.password, "password");
  eq(r.node.name, n.name, "name");
  if (!/^ss:\/\/[A-Za-z0-9_-]+@d\.example\.com:8388#/.test(r.link)) {
    throw new Error("not SIP002 (URL-safe base64 without padding): " + r.link);
  }
});

check("ss: IPv6 gets brackets in the URI", () => {
  const n = {
    protocol: "ss", address: "2001:db8::3", port: 8388,
    method: "aes-128-gcm", password: "pw", name: "v6"
  };
  const r = roundTrip(n);
  if (r.link.indexOf("@[2001:db8::3]:8388") < 0) {
    throw new Error("IPv6 host is not bracketed: " + r.link);
  }
  eq(r.node.address, "2001:db8::3", "address");
});

check("a parsed vless node regenerates a parseable link", () => {
  const source =
    "vless://da0b1cdf-81a5-340c-a0c7-c35c22923cbd@sfy1.example.com:24171" +
    "?type=tcp&security=reality&sni=cdn.example.com&fp=edge" +
    "&pbk=UOSnTp3ozouOQn9ZAfUEp4W7b_I9YL_9j8sOUh6StQ8&sid=724a1291&flow=xtls-rprx-vision" +
    "#%E6%97%A5%E6%9C%ACBGP1";
  const first = P.parseLink(source);
  if (!first.ok) { throw new Error("fixture parse failed: " + first.error); }
  const link = L.linkOf(first.node);
  const second = P.parseLink(link);
  if (!second.ok) { throw new Error("regenerated link failed: " + second.error + "\n" + link); }
  eq(P.identityOf(second.node), P.identityOf(first.node), "identity");
  eq(second.node.name, first.node.name, "name");
  eq(second.node.publicKey, first.node.publicKey, "publicKey");
  eq(second.node.flow, first.node.flow, "flow");
});

check("a parsed vmess node regenerates a parseable link", () => {
  const json = {
    v: "2", ps: "VM", add: "b.example.com", port: "8443",
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", aid: "0", scy: "auto",
    net: "ws", type: "none", host: "h.example.com", path: "/ray", tls: "tls",
    sni: "s.example.com"
  };
  const source = "vmess://" + Buffer.from(JSON.stringify(json), "utf8").toString("base64");
  const first = P.parseLink(source);
  if (!first.ok) { throw new Error("fixture parse failed: " + first.error); }
  const link = L.linkOf(first.node);
  const second = P.parseLink(link);
  if (!second.ok) { throw new Error("regenerated link failed: " + second.error + "\n" + link); }
  eq(P.identityOf(second.node), P.identityOf(first.node), "identity");
  eq(second.node.name, first.node.name, "name");
  eq(second.node.path, first.node.path, "path");
  eq(second.node.security, first.node.security, "security");
});

// ---- subscription Base64 ----------------------------------------------------------------

check("Base64 of a link is the one-line subscription form and re-imports", () => {
  const n = {
    protocol: "vless", address: "a.example.com", port: 443, uuid: VLESS_UUID,
    encryption: "none", transport: "tcp", security: "none", name: "sub"
  };
  const link = L.linkOf(n);
  const b64 = L.base64Link(link);
  eq(Buffer.from(b64, "base64").toString("utf8"), link, "decoded Base64");
  const rows = P.parseInput(b64);
  eq(rows.length, 1, "one imported row");
  eq(rows[0].ok, true, "row parsed");
  eq(P.identityOf(rows[0].node), P.identityOf(n), "identity");
});

check("Base64 of a vmess link is double-encoded on purpose", () => {
  const n = {
    protocol: "vmess", address: "b.example.com", port: 443, uuid: "id-1",
    alterId: 0, cipher: "auto", transport: "tcp", security: "none", name: "vm"
  };
  const link = L.linkOf(n);
  const b64 = L.base64Link(link);
  eq(Buffer.from(b64, "base64").toString("utf8"), link, "decoded Base64 is the vmess link");
  const rows = P.parseInput(b64);
  eq(rows.length, 1, "one imported row");
  eq(P.identityOf(rows[0].node), P.identityOf(n), "identity");
});

// ---- errors -----------------------------------------------------------------------------

check("unknown protocol is refused", () => {
  let failed = false;
  try {
    L.linkOf({ protocol: "hysteria2", address: "a", port: 443, name: "x" });
  } catch (e) { failed = /unsupported protocol/.test(e.message); }
  eq(failed, true, "unknown protocol refused");
});

check("a missing address or port is refused", () => {
  let failed = 0;
  try { L.linkOf({ protocol: "trojan", address: "", port: 443, password: "p" }); } catch (e) { failed++; }
  try { L.linkOf({ protocol: "trojan", address: "a", port: 0, password: "p" }); } catch (e) { failed++; }
  eq(failed, 2, "both refused");
});

if (failures.length) {
  console.error(failures.length + " link test(s) failed:\n");
  for (const failure of failures) { console.error("  - " + failure); }
  process.exit(1);
}
console.log(pass + " link tests passing");
