// ---- dns upstream settings ----
// 直连DNS 与 远程DNS 是核心意图，不是 UI 偏好：shell 渲染 config.json 时
// 从 config/settings.json 的 directDns/remoteDns 读取它们，所以保存走
// settings.json + shell 的渲染/重启路径，与应用端口一样。
// 本块同样由 tests/prefs.test.js 运行。

// 直连DNS 决定大陆域名由谁解析、且它自己的查询直连发出；远程DNS 是
// 其余域名的默认上游、查询经代理发出。两个字段都接受：
//   UDP: 裸 IPv4，可带 :端口          119.29.29.29 / 119.29.29.29:5353
//   DoH: https://IP[:端口]/dns-query   https://223.5.5.5/dns-query
// 域名形式的 DoH 一律拒绝——它会先问自己才能找到自己（自举依赖）。
// 空值 = 未配置 = shell 兜底（直连 DoH 223.5.5.5，远程 DoH 1.1.1.1）。

var DNS_DIRECT_DEFAULT = "https://223.5.5.5/dns-query";
var DNS_REMOTE_DEFAULT = "https://1.1.1.1/dns-query";

function dnsVal(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

var IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
var DOH_RE = /^https:\/\/(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?\/dns-query$/;

// 与 shell 同一条规则（kr_dns_norm）：一个值要么整体合法，要么未配置。
// 端口为 0 视为未写端口。
function dnsOk(v) {
  if (!v) { return true; }
  if (IPV4_RE.test(v)) { return true; }
  var m = v.match(/^([^:]+):(\d+)$/);
  if (m && IPV4_RE.test(m[1])) { return Number(m[2]) >= 1 && Number(m[2]) <= 65535; }
  if (DOH_RE.test(v)) {
    var port = v.match(/:(\d+)\/dns-query$/);
    return !port || (Number(port[1]) >= 1 && Number(port[1]) <= 65535);
  }
  return false;
}

// 返回 "" 表示可接受；否则返回拒绝保存原因对应的 i18n 键。
function dnsValidate(direct, remote) {
  if (!dnsOk(dnsVal(direct)) || !dnsOk(dnsVal(remote))) { return "dnsFormat"; }
  return "";
}
// ---- end dns upstream settings ----

export { DNS_DIRECT_DEFAULT, DNS_REMOTE_DEFAULT, dnsVal, dnsOk, dnsValidate };
