// ---- node links ----
// 由存储的节点推导出节点详情弹窗复制的分享链接。推导而非存储：
// 节点字段才是事实来源，tests/link.test.js 会把 linkOf() 经解析器往返一遍。
// 外层 Base64 是单行订阅形式；vmess 的链接本身就是 base64 JSON，
// 所以那种形式是有意的双重编码。Base64 是编码，不是加密。
// 保留分区标记：测试框架会抽取这一块。

function plainHost(addr) {
  return String(addr == null ? "" : addr).replace(/^\[|\]$/g, "");
}

function uriHost(addr) {
  var a = plainHost(addr);
  return a.indexOf(":") >= 0 ? "[" + a + "]" : a;
}

function utf8Bytes(s) {
  s = String(s == null ? "" : s);
  if (typeof TextEncoder !== "undefined") { return new TextEncoder().encode(s); }
  var raw = unescape(encodeURIComponent(s));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) { out[i] = raw.charCodeAt(i); }
  return out;
}

// 分块处理：逐字节拼接字符串会每字节分配一次，state.json 一大就慢。
// 取 8 KiB 让 String.fromCharCode.apply 稳稳落在参数上限之内。
function bytesToBase64(bytes) {
  var chunk = 0x2000;
  var bin = "";
  for (var i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64encodeText(s) {
  return bytesToBase64(utf8Bytes(s));
}

// 在 SIP002 里，userinfo 是去掉填充的 URL-safe Base64；上面的外层订阅形式
// 保留标准字母表和填充。
function b64urlText(s) {
  return b64encodeText(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function linkName(n) {
  return String(n.name || ((n.address || "") + ":" + (n.port || "")));
}

function alpnValue(n) {
  if (typeof n.alpn === "string") { return n.alpn; }
  if (n.alpn && n.alpn.length) { return n.alpn.join(","); }
  return "";
}

function addQuery(q, key, val) {
  if (val === null || val === undefined || String(val) === "") { return; }
  q.push(key + "=" + encodeURIComponent(String(val)));
}

function linkOf(n) {
  if (!n || typeof n !== "object") { throw new Error("node is missing"); }
  var port = Number(n.port);
  if (!n.address || !(port > 0 && port < 65536) || port !== Math.floor(port)) {
    throw new Error("node has no address or port");
  }
  var host = uriHost(n.address);
  var name = encodeURIComponent(linkName(n));
  var q = [];

  if (n.protocol === "vless") {
    if (!n.uuid) { throw new Error("vless node has no uuid"); }
    addQuery(q, "type", n.transport || "tcp");
    addQuery(q, "security", n.security || "none");
    addQuery(q, "encryption", n.encryption || "none");
    addQuery(q, "sni", n.sni);
    addQuery(q, "fp", n.fingerprint);
    addQuery(q, "pbk", n.publicKey);
    addQuery(q, "sid", n.shortId);
    addQuery(q, "flow", n.flow);
    addQuery(q, "path", n.path);
    addQuery(q, "host", n.host);
    addQuery(q, "serviceName", n.serviceName);
    addQuery(q, "alpn", alpnValue(n));
    addQuery(q, "allowInsecure", n.allowInsecure ? "1" : "");
    return "vless://" + encodeURIComponent(String(n.uuid)) + "@" + host + ":" + port +
      "?" + q.join("&") + "#" + name;
  }

  if (n.protocol === "trojan") {
    if (!n.password) { throw new Error("trojan node has no password"); }
    addQuery(q, "type", n.transport || "tcp");
    addQuery(q, "security", n.security || "tls");
    addQuery(q, "sni", n.sni);
    addQuery(q, "fp", n.fingerprint);
    addQuery(q, "pbk", n.publicKey);
    addQuery(q, "sid", n.shortId);
    addQuery(q, "flow", n.flow);
    addQuery(q, "path", n.path);
    addQuery(q, "host", n.host);
    addQuery(q, "serviceName", n.serviceName);
    addQuery(q, "alpn", alpnValue(n));
    addQuery(q, "allowInsecure", n.allowInsecure ? "1" : "");
    return "trojan://" + encodeURIComponent(String(n.password)) + "@" + host + ":" + port +
      "?" + q.join("&") + "#" + name;
  }

  if (n.protocol === "vmess") {
    if (!n.uuid) { throw new Error("vmess node has no uuid"); }
    var j = {
      v: "2",
      ps: linkName(n),
      add: plainHost(n.address),
      port: String(port),
      id: String(n.uuid),
      aid: String(Number(n.alterId) || 0),
      scy: String(n.cipher || "auto"),
      net: String(n.transport || "tcp"),
      type: "none",
      host: n.host ? String(n.host) : "",
      path: n.path ? String(n.path) : "",
      tls: n.security && n.security !== "none" ? String(n.security) : "",
      sni: n.sni ? String(n.sni) : "",
      fp: n.fingerprint ? String(n.fingerprint) : "",
      alpn: alpnValue(n)
    };
    return "vmess://" + b64encodeText(JSON.stringify(j));
  }

  if (n.protocol === "ss") {
    if (!n.method || !n.password) { throw new Error("ss node has no method/password"); }
    return "ss://" + b64urlText(String(n.method) + ":" + String(n.password)) +
      "@" + host + ":" + port + "#" + name;
  }

  throw new Error("unsupported protocol: " + n.protocol);
}

function base64Link(link) {
  if (!link) { throw new Error("no link to encode"); }
  return b64encodeText(link);
}
// ---- end node links ----

export { plainHost, uriHost, utf8Bytes, bytesToBase64, b64encodeText, b64urlText, linkName, alpnValue, addQuery, linkOf, base64Link };
