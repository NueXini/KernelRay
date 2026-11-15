// ---- inbound port settings ----
// 本地 socks/http 入站端口是核心意图，不是 UI 偏好：shell 渲染 config.json 时
// 从 state.json 的 `settings` 读取它们（ADR 0009），所以保存要
// 走 state.json + shell 的渲染/重启路径，与应用节点一样。
// 本块同样由 tests/prefs.test.js 运行。

var PORT_DEFAULTS = { socks: 10808, http: 10809 };
var TP_PORT = 10810; // 由 shell 占用的 tproxy 入站；本地入站不能占用它

function portVal(raw) {
  var n = Number(raw);
  if (!isFinite(n) || n !== Math.floor(n)) { return 0; }
  return n >= 1 && n <= 65535 ? n : 0;
}

// 逐字段回退：某个端口缺失或非法时，该入站保留默认值，因此
// 手工改过的 state.json 也绝不会让两个入站同时失效。这与 shell 的规则一致。
function portsNormalize(raw) {
  var s = raw && typeof raw === "object" ? portVal(raw.socksPort) : 0;
  var h = raw && typeof raw === "object" ? portVal(raw.httpPort) : 0;
  return { socks: s || PORT_DEFAULTS.socks, http: h || PORT_DEFAULTS.http };
}

// 返回 "" 表示可接受；否则返回拒绝保存原因对应的 i18n 键。
function portsValidate(socks, http) {
  var s = portVal(socks), h = portVal(http);
  if (!s || !h) { return "portRange"; }
  if (s === h) { return "portSame"; }
  if (s === TP_PORT || h === TP_PORT) { return "portTp"; }
  return "";
}
// ---- end inbound port settings ----

export { PORT_DEFAULTS, TP_PORT, portVal, portsNormalize, portsValidate };
