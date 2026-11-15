// ---- node parsing ----
// 分享链接 → 节点。放在这里而不是 shell 里：设备上没有 jq，
// 用 awk 处理 URI/JSON/base64 会是负担。
// 测试 tests/parse.test.js 会从发布文件中抽取这一块，所以保留分区标记。

function parseFail(msg) { return { ok: false, error: msg }; }

function b64bytes(s) {
  var t = String(s == null ? "" : s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  while (t.length % 4) { t += "="; }
  try {
    var bin = atob(t);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  } catch (e) {
    return null;
  }
}

function b64text(s) {
  var bytes = b64bytes(s);
  if (!bytes) { return ""; }
  if (typeof TextDecoder !== "undefined") {
    try { return new TextDecoder("utf-8").decode(bytes); } catch (e) { return ""; }
  }
  var raw = "";
  for (var i = 0; i < bytes.length; i++) { raw += String.fromCharCode(bytes[i]); }
  try { return decodeURIComponent(escape(raw)); } catch (e) { return raw; }
}

function decodeName(s) {
  if (!s) { return ""; }
  try { return decodeURIComponent(s).trim(); } catch (e) { return String(s).trim(); }
}

function portOf(raw) {
  var p = parseInt(raw, 10);
  return p > 0 && p < 65536 ? p : 0;
}

// 用 `new URL()` 拆分这些链接看似自然，却是错误的依赖：
// 对非特殊 scheme 的 userinfo 处理，正是各 WebView 容易有差异的地方，
// 一旦有差异，所有 vless/trojan 链接会一起以 "missing uuid" 失败。
// 手工拆分 scheme://[userinfo@]host:port[?query][#frag] 只要十几行，而且行为可预测。
function splitUri(link) {
  var m = /^([a-z0-9+.-]+):\/\/([\s\S]*)$/i.exec(String(link || "").trim());
  if (!m) { return null; }
  var rest = m[2];
  var hash = "", query = "";
  var i = rest.indexOf("#");
  if (i >= 0) { hash = rest.slice(i + 1); rest = rest.slice(0, i); }
  var q = rest.indexOf("?");
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  var userinfo = "", hostport = rest;
  var at = rest.lastIndexOf("@");
  if (at >= 0) { userinfo = rest.slice(0, at); hostport = rest.slice(at + 1); }
  var hp = /^(\[[^\]]*\]|[^:]*):?(\d*)$/.exec(hostport);
  var host = hp ? hp[1].replace(/^\[|\]$/g, "") : hostport;
  return {
    scheme: m[1].toLowerCase(), userinfo: userinfo, host: host,
    port: hp ? portOf(hp[2]) : 0, hash: hash, params: new URLSearchParams(query)
  };
}

function setIf(obj, key, val) {
  if (val !== null && val !== undefined && String(val) !== "") { obj[key] = String(val); }
}

// 链接里的 `type=` 取值就是 v2ray/Xray 的 `network` 取值，只是有些客户端
// 会把 HTTP/2 写成 `http`。无法识别的值原样保留，绝不猜测。
function transportOf(raw) {
  var t = String(raw || "").toLowerCase();
  if (!t) { return "tcp"; }
  if (t === "http") { return "h2"; }
  return t;
}

function securityOf(raw) {
  var s = String(raw || "").toLowerCase();
  return s || "none";
}

function applyLinkParams(node, p) {
  setIf(node, "sni", p.get("sni"));
  setIf(node, "fingerprint", p.get("fp"));
  setIf(node, "publicKey", p.get("pbk"));
  setIf(node, "shortId", p.get("sid"));
  setIf(node, "flow", p.get("flow"));
  setIf(node, "path", p.get("path"));
  setIf(node, "host", p.get("host"));
  setIf(node, "serviceName", p.get("serviceName"));
  var alpn = p.get("alpn");
  if (alpn) { node.alpn = alpn.split(",").filter(function (x) { return x; }); }
  var ai = p.get("allowInsecure");
  if (ai === "1" || ai === "true") { node.allowInsecure = true; }
}

function parseVless(link) {
  var u = splitUri(link);
  if (!u) { return parseFail("链接格式不对"); }
  var uuid = decodeName(u.userinfo);
  if (!uuid) { return parseFail("缺少 uuid"); }
  if (!u.host || !u.port) { return parseFail("缺少地址或端口"); }
  var p = u.params;
  var node = {
    protocol: "vless", address: u.host, port: u.port, uuid: uuid, encryption: "none",
    transport: transportOf(p.get("type")), security: securityOf(p.get("security"))
  };
  applyLinkParams(node, p);
  node.name = decodeName(u.hash) || (node.address + ":" + node.port);
  return { ok: true, node: node };
}

// 形如 vmess:// 的链接承载 base64(JSON)——v2rayN 的对象，而不是 URI。
// 较新的 `vmess://uuid@host` 形式属于另一套规范，会报不支持而不是被误解析。
function parseVmess(link) {
  var body = link.slice("vmess://".length).split("#")[0];
  var txt = b64text(body).trim();
  if (!txt) { return parseFail("vmess 链接不是 base64"); }
  var j;
  try { j = JSON.parse(txt); } catch (e) { return parseFail("base64 里不是 JSON（新式 vmess URI 暂不支持）"); }
  var addr = String(j.add || j.address || "").trim();
  var port = portOf(j.port);
  var uuid = String(j.id || "").trim();
  if (!addr || !port) { return parseFail("缺少地址或端口"); }
  if (!uuid) { return parseFail("缺少 uuid"); }
  var node = {
    protocol: "vmess", address: addr, port: port, uuid: uuid,
    alterId: Number(j.aid || j.alterId || 0) || 0,
    cipher: String(j.scy || j.cipher || "auto"),
    transport: transportOf(j.net), security: securityOf(j.tls)
  };
  setIf(node, "sni", j.sni);
  setIf(node, "host", j.host);
  setIf(node, "path", j.path);
  setIf(node, "fingerprint", j.fp);
  if (j.alpn) { node.alpn = String(j.alpn).split(",").filter(function (x) { return x; }); }
  node.name = String(j.ps || j.remarks || "").trim() || (addr + ":" + port);
  return { ok: true, node: node };
}

function parseTrojan(link) {
  var u = splitUri(link);
  if (!u) { return parseFail("链接格式不对"); }
  // 实际中存在 `trojan://user:pass@host` 这种写法；冒号后面的部分才是 password。
  var raw = u.userinfo;
  var c = raw.indexOf(":");
  var pw = decodeName(c >= 0 && raw.slice(c + 1) ? raw.slice(c + 1) : raw);
  if (!pw) { return parseFail("缺少密码"); }
  if (!u.host || !u.port) { return parseFail("缺少地址或端口"); }
  var p = u.params;
  var node = {
    protocol: "trojan", address: u.host, port: u.port, password: pw,
    transport: transportOf(p.get("type")), security: securityOf(p.get("security") || "tls")
  };
  applyLinkParams(node, p);
  node.name = decodeName(u.hash) || (node.address + ":" + node.port);
  return { ok: true, node: node };
}

// 两种格式合在 ss:// 里：SIP002 把 base64(method:password) 放进 userinfo，
// 旧式则把整个 method:password@host:port 做 base64。纯 `method:password`
// 形式的 userinfo 也合法，绝不能交给 atob。
function parseSs(link) {
  var rest = link.slice("ss://".length);
  var hash = "", qs = "";
  var h = rest.indexOf("#");
  if (h >= 0) { hash = rest.slice(h + 1); rest = rest.slice(0, h); }
  var q = rest.indexOf("?");
  if (q >= 0) { qs = rest.slice(q + 1); rest = rest.slice(0, q); }
  if (/plugin=/.test(qs)) { return parseFail("带 plugin 的 ss 链接不支持"); }

  var method = "", password = "", host = "", port = 0;
  var at = rest.lastIndexOf("@");
  if (at >= 0) {
    var user = rest.slice(0, at);
    var dec = user.indexOf(":") >= 0 ? decodeName(user) : b64text(user);
    var c = dec.indexOf(":");
    if (c < 0) { return parseFail("userinfo 里没有 method:password"); }
    method = dec.slice(0, c);
    password = dec.slice(c + 1);
    var m = /^(\[[^\]]+\]|[^:@]+):(\d+)$/.exec(rest.slice(at + 1));
    if (!m) { return parseFail("服务器地址或端口不对"); }
    host = m[1].replace(/^\[|\]$/g, "");
    port = portOf(m[2]);
  } else {
    var all = b64text(rest);
    var m2 = /^([^:]+):(.*)@(\[[^\]]+\]|[^:@]+):(\d+)$/.exec(all);
    if (!m2) { return parseFail("ss 内容解不出来（base64 或格式不对）"); }
    method = m2[1];
    password = m2[2];
    host = m2[3].replace(/^\[|\]$/g, "");
    port = portOf(m2[4]);
  }
  if (!host || !port) { return parseFail("缺少地址或端口"); }
  if (!method) { return parseFail("缺少加密方式"); }
  return {
    ok: true,
    node: {
      protocol: "ss", address: host, port: port, method: method, password: password,
      name: decodeName(hash) || (host + ":" + port)
    }
  };
}

function parseLink(link) {
  var l = String(link || "").trim();
  var m = /^([a-z0-9+.-]+):\/\//i.exec(l);
  if (!m) { return parseFail("不是分享链接"); }
  var scheme = m[1].toLowerCase();
  if (scheme === "vless") { return parseVless(l); }
  if (scheme === "vmess") { return parseVmess(l); }
  if (scheme === "trojan") { return parseTrojan(l); }
  if (scheme === "ss") { return parseSs(l); }
  return parseFail("不支持的协议：" + scheme);
}

// 身份决定去重：协议 + 主机 + 端口 + 凭证 + sni + ws host。名称、
// 传输方式和其余 TLS 参数只是展示，不属于身份。sni 和
// 传输 host 属于身份，因为前置 CDN 的地址靠它们路由：
// 地址、端口和凭证相同却只在这两处不同的两条链接会到达不同的服务器
// （见 docs/state-schema.md）。
function identityOf(node) {
  var cred;
  if (node.protocol === "ss") { cred = [node.method, node.password]; }
  else if (node.protocol === "trojan") { cred = [node.password]; }
  else { cred = [node.uuid]; }
  var parts = [node.protocol, String(node.address || "").toLowerCase(), node.port];
  parts.push(String(node.sni || "").toLowerCase(), String(node.host || "").toLowerCase());
  for (var i = 0; i < cred.length; i++) {
    parts.push(cred[i] === null || cred[i] === undefined ? "" : String(cred[i]));
  }
  return parts.join("|");
}

function hash32(str, seed) {
  var h = seed >>> 0;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 255;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

function idOf(node) {
  var ident = identityOf(node);
  return hash32(ident, 0x811c9dc5) + hash32(ident, 0x1b873593);
}

// 整段 base64 数据块（机场分发的那种）只在输入中任何一行都没有链接时才解码，
// 这样单独一行格式错误也绝不会把整次粘贴变成垃圾。
function parseInput(text) {
  var lines = String(text || "").split(/\r?\n/);
  var hasLink = lines.some(function (x) { return x.indexOf("://") >= 0; });
  if (!hasLink) {
    var whole = b64text(String(text || "").replace(/\s+/g, ""));
    if (whole) { lines = whole.split(/\r?\n/); }
  }
  var out = [], seen = {};
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.indexOf("//") === 0 || line.charAt(0) === "#") { continue; }
    var res = parseLink(line);
    if (res.ok) {
      var ident = identityOf(res.node);
      if (seen[ident]) { res.node.dupOf = seen[ident]; }
      else { seen[ident] = i + 1; }
      res.node.id = idOf(res.node);
    }
    out.push({ line: i + 1, ok: res.ok, node: res.node, error: res.error });
  }
  return out;
}
// ---- end node parsing ----

export { parseFail, b64bytes, b64text, decodeName, portOf, splitUri, setIf, transportOf, securityOf, applyLinkParams, parseVless, parseVmess, parseTrojan, parseSs, parseLink, identityOf, hash32, idOf, parseInput };
