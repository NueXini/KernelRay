// ---- outbound rendering ----
// 由 state.json 的当前节点推导出 shell 拼接进配置模板的那一条 Xray 出站。
// 由于 shell 无法解析嵌套 JSON（设备上没有 jq），协议知识放在这里，
// 测试 tests/outbound.test.js 运行的正是这一块。
//
// 节点出站携带 "__KERNELRAY_MARK__" sockopt 占位符，绝不是真实
// 真实 mark 在 Android 上若没有匹配的 ip rule 就会丢路由：v0.6 时
// 节点的 Reality 握手一直失败，直到把这个 mark 移除。shell 会把
// 占位符替换成旁路标记，这才是让 mark 与规则成对共存的做法
// （docs/adr/0008）；它不可能变成别的值（docs/adr/0011）。模板里
// 固定的 direct 出站保留字面 mark，因为未使用的出站不会创建 socket。

function tlsSettingsOf(n) {
  var t = {};
  if (n.sni) { t.serverName = String(n.sni); }
  var alpn = n.alpn;
  if (typeof alpn === "string") { alpn = alpn.split(","); }
  if (alpn && alpn.length) { t.alpn = alpn; }
  if (n.fingerprint) { t.fingerprint = String(n.fingerprint); }
  if (n.allowInsecure) { t.allowInsecure = true; }
  return t;
}

function realitySettingsOf(n) {
  var r = {};
  if (n.sni) { r.serverName = String(n.sni); }
  if (n.fingerprint) { r.fingerprint = String(n.fingerprint); }
  if (n.publicKey) { r.publicKey = String(n.publicKey); }
  if (n.shortId) { r.shortId = String(n.shortId); }
  return r;
}

function streamSettingsOf(n) {
  var net = n.transport || "tcp";
  var sec = n.security || "none";
  var s = { network: net, security: sec };
  if (sec === "tls") {
    var tls = tlsSettingsOf(n);
    if (Object.keys(tls).length) { s.tlsSettings = tls; }
  } else if (sec === "reality") {
    var reality = realitySettingsOf(n);
    if (Object.keys(reality).length) { s.realitySettings = reality; }
  }
  if (net === "ws") {
    var ws = {};
    if (n.path) { ws.path = String(n.path); }
    if (n.host) { ws.headers = { Host: String(n.host) }; }
    if (Object.keys(ws).length) { s.wsSettings = ws; }
  } else if (net === "grpc") {
    if (n.serviceName) { s.grpcSettings = { serviceName: String(n.serviceName) }; }
  } else if (net === "h2") {
    var h2 = {};
    if (n.path) { h2.path = String(n.path); }
    if (n.host) { h2.host = [String(n.host)]; }
    if (Object.keys(h2).length) { s.httpSettings = h2; }
  } else if (net === "httpupgrade") {
    var hu = {};
    if (n.path) { hu.path = String(n.path); }
    if (n.host) { hu.host = String(n.host); }
    if (Object.keys(hu).length) { s.httpupgradeSettings = hu; }
  }
  // 由 shell 替换为旁路标记；这里绝不使用真实 mark，因为
  // 渲染器是节点的纯函数，而 mark 属于规则。
  s.sockopt = { mark: "__KERNELRAY_MARK__" };
  return s;
}

function outboundOf(n) {
  if (!n || !n.address || !n.port) { throw new Error("node has no address or port"); }
  var port = Number(n.port);
  if (!(port > 0 && port < 65536)) { throw new Error("node port is invalid"); }
  var o = { tag: "proxy", protocol: n.protocol };
  if (n.protocol === "vless") {
    if (!n.uuid) { throw new Error("vless node has no uuid"); }
    var vu = { id: n.uuid, encryption: n.encryption || "none" };
    if (n.flow) { vu.flow = String(n.flow); }
    o.settings = { vnext: [{ address: n.address, port: port, users: [vu] }] };
  } else if (n.protocol === "vmess") {
    if (!n.uuid) { throw new Error("vmess node has no uuid"); }
    o.settings = { vnext: [{ address: n.address, port: port, users: [{
      id: n.uuid, alterId: Number(n.alterId) || 0, security: n.cipher || "auto"
    }] }] };
  } else if (n.protocol === "trojan") {
    if (!n.password) { throw new Error("trojan node has no password"); }
    o.settings = { servers: [{ address: n.address, port: port, password: n.password }] };
  } else if (n.protocol === "ss") {
    if (!n.method || !n.password) { throw new Error("ss node has no method/password"); }
    o.settings = { servers: [{ address: n.address, port: port, method: n.method, password: n.password }] };
  } else {
    throw new Error("unsupported protocol: " + n.protocol);
  }
  o.streamSettings = streamSettingsOf(n);
  return o;
}
// ---- end outbound rendering ----

export { tlsSettingsOf, realitySettingsOf, streamSettingsOf, outboundOf };
