(function () {
"use strict";

var MOD = "/data/adb/modules/kernelray";
var CLI = MOD + "/scripts/kernelray.sh";
// Config, node store and logs sit in the module dir too — one root, nothing outside it.
var STATE = MOD + "/state.json";
var APPLIED = MOD + "/runtime/applied";
var OUTBOUND = MOD + "/outbound.json";
var OUTBOUND_META = MOD + "/outbound.meta";
// Log buffer size is a Settings-page preference; 200 is the default before prefs load.
var logLines = 200;
var POLL_MS = 2000;

// Language is a Settings-page preference, not a boot-time fact: applyLang() reassigns T,
// and every T.x read picks the current dictionary because nothing captures the object.
var langPref = "auto"; // "auto" | "zh" | "en"; resolved against navigator.language when "auto"
var DICT_ZH = {
  start: "启动", stop: "停止", follow: "跟随", refresh: "刷新",
  log: "日志", pid: "进程", up: "运行时长", port: "端口", core: "核心", conf: "配置",
  running: "运行中", stopped: "已停止", starting: "启动中", stopping: "停止中",
  failed: "启动失败", unknown: "未知",
  noBridge: "没有检测到 KernelSU 桥接，请从 KernelSU 管理器的模块页面打开本页面。",
  startingMsg: "正在启动…", stoppingMsg: "正在停止…",
  actionFailed: "操作失败", noLog: "（还没有日志）",
  stoppedHint: "核心未运行；已应用的节点会在下次启动时生效。",
  stoppedHintNone: "核心未运行，也没有应用节点；先在节点列表点一个节点应用，核心才会启动。",
  runningHint: "核心还没接管系统流量；把客户端指向 127.0.0.1:{port} 就会走已应用的节点。",
  tpRunningHint: "已接管：设备流量自动经核心转发；socks 127.0.0.1:{port} 仍然可用。",
  setTp: "tproxy透明代理",
  setTpOn: "已开启：核心下次启动时（开机或状态页「启动」），设备流量（TCP/UDP、IPv4/IPv6）经已应用的节点转发；ping 等 ICMP 仍直连。",
  setTpOff: "已关闭：核心启动后设备流量直连；本地 socks/http 入站仍按需使用。",
  setTpPending: "核心运行中，但 tproxy 尚未生效；停止再启动（或重启设备）后生效。",
  setTpNoNode: "还没有已应用的节点；应用节点后，核心启动时 tproxy 会自动开启。",
  tpConflict: "tproxy 被冲突阻止：设备上有别的 VPN 或透明代理在运行。处理后点「重试」；关闭开关并重启核心可恢复直连。",
  tpRules: "tproxy 规则安装失败，已回滚（可能漏流量）。详情见 kernelray.log；点「重试」再试一次。",
  tpRetry: "重试",
  tpOnMsg: "tproxy 已开启；下次启动核心时生效", tpOffMsg: "tproxy 已关闭；下次启动核心时生效",
  "failed/rules": "接管规则", "failed/conflict": "接管冲突",
  applyingMsg: "正在应用节点…", appliedMsg: "节点已应用",
  nodeNoState: "没有 state.json，节点信息无从得知",
  nodeSchema: "state.json 的 schema 版本未识别：",
  listTitle: "节点列表",
  listHint: "点一个节点即可切换并应用；「已应用」是核心正在使用的节点。",
  emptyNodes: "节点库还是空的；点右上角的 + 添加节点。",
  nodeApplied: "已应用", nodeDirty: "有改动", nodePending: "未应用",
  nodeReapply: "这个节点应用后有改动；点一下重新应用。",
  selectedMissing: "state.json 的 selected 指向了一个不存在的节点。",
  appliedMissing: "runtime/applied 指向的节点不在节点库里。",
  delete: "删除", deleteApplied: "已应用的节点不能删除；先切换到别的节点。",
  deleteConfirm: "删除这个节点？", cancel: "取消", deleted: "已删除",
  edit: "编辑", done: "完成",
  checkAll: "全选", uncheckAll: "取消全选",
  batchDelete: "删除", deleteConfirmN: "删除 {n} 个节点？",
  deletedN: "已删除 {n} 个节点",
  editHint: "勾选要删除的节点，点「删除」批量删除；已应用的节点不能删除。",
  tabStatus: "状态", tabNodes: "节点", tabLog: "日志", tabSettings: "设置", navLabel: "页面",
  setGeneral: "常规设置",
  setLang: "语言", langAuto: "自动",
  setLangHint: "「自动」跟随系统语言。改动立即生效，只存在本机 WebView 里，不写入 state.json。",
  setLog: "日志行数",
  setLogHint: "日志页每次拉取的行数；行数越多看得越早。",
  setPorts: "入站端口",
  setPortsHint: "本地 socks/http 入站在 127.0.0.1 上监听的端口。保存后重写核心配置；核心在运行时会重启。",
  portRange: "端口必须是 1–65535 之间的整数",
  portSame: "SOCKS 和 HTTP 端口不能相同",
  portTp: "这个端口留给透明代理入站（10810），换一个",
  portsSaving: "正在应用端口…", portsSaved: "端口已应用",
  portsSave: "保存",
  setSoon: "路由与 DNS 目前是内置策略：DNS 由核心的 DNS 模块应答并经节点转发；透明代理开关在本页上方。",
  addTitle: "添加节点",
  addPlaceholder: "vless://…",
  close: "关闭",
  importBtn: "导入",
  lineNo: "第 ", lineNoEnd: " 行",
  importEmpty: "没有解析出可导入的节点",
  importDone: "已导入",
  importUpdated: "，更新",
  importFailedN: "，{n} 行失败",
  notAppliedYet: "导入只写入节点库，不会切换；点列表里的节点即可切换并应用。"
};
var DICT_EN = {
  start: "Start", stop: "Stop", follow: "Follow", refresh: "Refresh",
  log: "Log", pid: "PID", up: "Uptime", port: "Ports", core: "Core", conf: "Config",
  running: "running", stopped: "stopped", starting: "starting", stopping: "stopping",
  failed: "failed", unknown: "unknown",
  noBridge: "KernelSU bridge not found. Open this page from the module card in the KernelSU manager.",
  startingMsg: "Starting…", stoppingMsg: "Stopping…",
  actionFailed: "Action failed", noLog: "(no log yet)",
  stoppedHint: "The core is stopped; the applied node takes effect on the next start.",
  stoppedHintNone: "The core is stopped and no node is applied; tap a node in the node list to apply one — the core only starts with an applied node.",
  runningHint: "The core does not intercept system traffic yet; point clients at 127.0.0.1:{port} to use the applied node.",
  tpRunningHint: "Takeover is on: device traffic goes through the core; socks 127.0.0.1:{port} still works.",
  setTp: "TPROXY transparent proxy",
  setTpOn: "On: at the next core start (boot or the Status page's Start), device traffic (TCP/UDP, IPv4/IPv6) goes through the applied node; ICMP such as ping stays direct.",
  setTpOff: "Off: with the core started, device traffic goes out directly; the local socks/http inbounds remain available.",
  setTpPending: "The core is running, but tproxy is not in effect yet; stop and start it (or reboot) to apply.",
  setTpNoNode: "No applied node yet; once a node is applied, tproxy engages automatically when the core starts.",
  tpConflict: "tproxy is blocked by a conflict: another VPN or transparent proxy is running. Resolve it and retry; switch tproxy off and restart the core to go direct.",
  tpRules: "Installing the tproxy rules failed and was rolled back (traffic may leak). See kernelray.log; tap Retry to try again.",
  tpRetry: "Retry",
  tpOnMsg: "tproxy on; takes effect at the next core start", tpOffMsg: "tproxy off; takes effect at the next core start",
  "failed/rules": "rules", "failed/conflict": "conflict",
  applyingMsg: "Applying node…", appliedMsg: "Node applied",
  nodeNoState: "No state.json, so the nodes are unknown",
  nodeSchema: "Unrecognised state.json schema: ",
  listTitle: "Node list",
  listHint: "Tap a node to switch and apply it; “Applied” is what the core runs.",
  emptyNodes: "No nodes yet; tap + in the top right to add one.",
  nodeApplied: "Applied", nodeDirty: "Changed", nodePending: "Not applied",
  nodeReapply: "This node changed after it was applied; tap to re-apply.",
  selectedMissing: "state.json points selected at a node that is not in the store.",
  appliedMissing: "runtime/applied points at a node that is not in the store.",
  delete: "Delete", deleteApplied: "The applied node cannot be deleted; switch to another node first.",
  deleteConfirm: "Delete this node?", cancel: "Cancel", deleted: "Deleted",
  edit: "Edit", done: "Done",
  checkAll: "Select all", uncheckAll: "Deselect all",
  batchDelete: "Delete", deleteConfirmN: "Delete {n} node(s)?",
  deletedN: "Deleted {n} node(s)",
  editHint: "Check the nodes to delete, then tap Delete; the applied node cannot be deleted.",
  tabStatus: "Status", tabNodes: "Nodes", tabLog: "Log", tabSettings: "Settings", navLabel: "Sections",
  setGeneral: "General",
  setLang: "Language", langAuto: "Auto",
  setLangHint: "Auto follows the system language. Applies immediately and stays in this WebView; it never touches state.json.",
  setLog: "Log buffer",
  setLogHint: "How many lines the Log tab fetches each time; more lines reach further back.",
  setPorts: "Inbound ports",
  setPortsHint: "The ports the local socks/http inbounds listen on, at 127.0.0.1. Saving rewrites the core config; a running core restarts.",
  portRange: "Ports must be integers between 1 and 65535",
  portSame: "The SOCKS and HTTP ports must differ",
  portTp: "That port is reserved for the tproxy inbound (10810); pick another",
  portsSaving: "Applying ports…", portsSaved: "Ports applied",
  portsSave: "Save",
  setSoon: "Routing and DNS are built-in policy for now: DNS is answered by the core's DNS module and sent through the node; the tproxy switch is on this page.",
  addTitle: "Add node",
  addPlaceholder: "vless://…",
  close: "Close",
  importBtn: "Import",
  lineNo: "line ", lineNoEnd: "",
  importEmpty: "No importable node in the input",
  importDone: "Imported",
  importUpdated: ", updated",
  importFailedN: ", {n} line(s) failed",
  notAppliedYet: "Importing only fills the node list; tap a node there to switch and apply it."
};
var T = DICT_EN; // applyLang() reassigns this before anything renders

var $ = function (id) { return document.getElementById(id); };
var els = {
  banner: $("banner"), badge: $("badge"), start: $("start"), stop: $("stop"),
  hint: $("hint"), pid: $("v-pid"), up: $("v-up"), port: $("v-port"),
  core: $("v-core"), conf: $("v-conf"), log: $("log"), follow: $("follow"),
  refresh: $("refresh"), toast: $("toast"),
  lPid: $("l-pid"), lUp: $("l-up"), lPort: $("l-port"), lCore: $("l-core"),
  lConf: $("l-conf"), lLog: $("l-log"), lFollow: $("l-follow"),
  addNode: $("add-node"),
  nList: $("n-list"), nHint: $("n-hint"), lList: $("l-nodes"),
  editNode: $("edit-node"), nToolbar: $("n-toolbar"),
  lImport: $("l-import"), iText: $("i-text"),
  iApply: $("i-apply"), iPreview: $("i-preview"), iHint: $("i-hint"),
  overlay: $("add-overlay"), addClose: $("add-close"), tabbar: $("tabbar"),
  lTabStatus: $("l-tab-status"), lTabNodes: $("l-tab-nodes"), lTabLog: $("l-tab-log"),
  lTabSettings: $("l-tab-settings"),
  selLang: $("sel-lang"), lSetLang: $("l-set-lang"), lLangAuto: $("l-lang-auto"),
  lSetGeneral: $("l-set-general"), lSetLangHint: $("l-set-lang-hint"),
  selLog: $("sel-log"), lSetLog: $("l-set-log"), lSetLogHint: $("l-set-log-hint"),
  iSocks: $("i-socks"), iHttp: $("i-http"), portsSave: $("ports-save"),
  lSetPorts: $("l-set-ports"), lSetPortsHint: $("l-set-ports-hint"),
  lSetSoon: $("l-set-soon"),
  tpCard: $("tp-card"), tpHint: $("tp-hint"), tpRetry: $("tp-retry"),
  lSetTp: $("l-set-tp"), setTpHint: $("set-tp-hint"), setTpSwitch: $("set-tp-switch")
};
var tabs = [].slice.call(document.querySelectorAll(".tab"));
var pages = {
  status: $("page-status"), nodes: $("page-nodes"),
  log: $("page-log"), settings: $("page-settings")
};

var hasBridge = typeof window.ksu !== "undefined" && typeof window.ksu.exec === "function";
var lastLog = "";
var lastState = "unknown";
var busy = false;
var pending = null; // "start" | "stop" while the action is in flight
var lastStateObj = null;
var lastKv = null;
var lastApplied = "";
var lastMetaId = "";
var confirmId = null;
var listSig = "";
// Edit-mode check set: which rows a batch delete would remove. In memory only — a check is
// a temporary intent, not a wish like `selected` — and cleared when edit mode ends.
var editMode = false;
var checkSet = {};
var batchConfirm = false;
// Port fields the user has touched since the last sync: a 2s poll must not reset a
// field the user edited while filling in the other one. Cleared on a successful save
// and when the settings page is left.
var portsDirty = { socks: false, http: false };

function label(key) {
  els.start.textContent = T.start;
  els.stop.textContent = T.stop;
  els.refresh.textContent = T.refresh;
  els.lFollow.textContent = T.follow;
  els.lLog.textContent = T.log;
  els.lPid.textContent = T.pid;
  els.lUp.textContent = T.up;
  els.lPort.textContent = T.port;
  els.lCore.textContent = T.core;
  els.lConf.textContent = T.conf;
  els.lList.textContent = T.listTitle;
  els.editNode.textContent = editMode ? T.done : T.edit;
  els.addNode.setAttribute("aria-label", T.addTitle);
  els.addClose.setAttribute("aria-label", T.close);
  els.lImport.textContent = T.addTitle;
  els.iApply.textContent = T.importBtn;
  els.iText.placeholder = T.addPlaceholder;
  els.iHint.textContent = T.notAppliedYet;
  els.lTabStatus.textContent = T.tabStatus;
  els.lTabNodes.textContent = T.tabNodes;
  els.lTabLog.textContent = T.tabLog;
  els.lTabSettings.textContent = T.tabSettings;
  els.lSetGeneral.textContent = T.setGeneral;
  els.lSetLang.textContent = T.setLang;
  els.lLangAuto.textContent = T.langAuto;
  els.lSetLangHint.textContent = T.setLangHint;
  els.lSetLog.textContent = T.setLog;
  els.lSetLogHint.textContent = T.setLogHint;
  els.lSetPorts.textContent = T.setPorts;
  els.lSetPortsHint.textContent = T.setPortsHint;
  els.portsSave.textContent = T.portsSave;
  els.lSetSoon.textContent = T.setSoon;
  els.lSetTp.textContent = T.setTp;
  els.tpRetry.textContent = T.tpRetry;
  els.tabbar.setAttribute("aria-label", T.navLabel);
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.className = "toast show";
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { els.toast.className = "toast"; }, 2600);
}

// localStorage itself can throw in a locked-down WebView; prefs survive as session-only.
function prefsStore() {
  try { return window.localStorage; } catch (e) { return null; }
}

function resolveLang() {
  if (langPref === "zh" || langPref === "en") { return langPref; }
  return (navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
}

// Switching language has to invalidate what was rendered under the old one: the node list
// signature does not include language, and renderLog skips unchanged text.
function applyLang() {
  var lang = resolveLang();
  T = lang === "zh" ? DICT_ZH : DICT_EN;
  document.documentElement.lang = lang;
  label();
  renderPrefs();
  listSig = "";
  renderNodeList();
  els.iHint.textContent = T.notAppliedYet;
  els.iHint.className = "nodehint";
  lastLog = null;
  renderLog("");
  if (!hasBridge) {
    els.banner.textContent = T.noBridge;
    els.badge.textContent = T.unknown;
  }
}

// The selects render straight from the prefs: a language switch reassigns T and the
// Auto option's label, so both run through here.
function renderPrefs() {
  els.selLang.value = langPref;
  els.selLog.value = String(logLines);
}

// ksu.exec is callback-based: ksu.exec(cmd, optionsJson, callbackName) and the
// injected WebView calls window[callbackName](errno, stdout, stderr).
function exec(cmd) {
  return new Promise(function (resolve, reject) {
    if (!hasBridge) { reject(new Error("no bridge")); return; }
    var name = "kc_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    window[name] = function (errno, stdout, stderr) {
      delete window[name];
      resolve({ errno: errno, stdout: stdout || "", stderr: stderr || "" });
    };
    try {
      window.ksu.exec(cmd, JSON.stringify({}), name);
    } catch (e) {
      delete window[name];
      reject(e);
    }
  });
}

function parseKv(text) {
  var out = {};
  (text || "").split("\n").forEach(function (line) {
    var i = line.indexOf("=");
    if (i > 0) { out[line.slice(0, i).trim()] = line.slice(i + 1); }
  });
  return out;
}

// ---- UI preferences ----
// Language and log-buffer size are UI prefs, not intent: state.json's `settings` object is
// reserved for routing/DNS (docs/state-schema.md) and is wiped by every module upgrade
// anyway, so these live in the WebView's localStorage and degrade to session-only when the
// manager ships a WebView with storage disabled. tests/prefs.test.js runs this block.

var PREFS_KEY = "kernelray.prefs";
var LANGS = ["auto", "zh", "en"];
var LOG_LINE_STEPS = [100, 200, 500];

function prefsNormalize(raw) {
  var p = { lang: "auto", logLines: 200 };
  if (!raw || typeof raw !== "object") { return p; }
  if (LANGS.indexOf(raw.lang) >= 0) { p.lang = String(raw.lang); }
  var n = Number(raw.logLines);
  if (LOG_LINE_STEPS.indexOf(n) >= 0) { p.logLines = n; }
  return p;
}

function prefsLoad(store) {
  try {
    return prefsNormalize(JSON.parse((store && store.getItem(PREFS_KEY)) || "null"));
  } catch (e) { return prefsNormalize(null); }
}

function prefsSave(store, prefs) {
  try {
    var p = prefsNormalize(prefs);
    store.setItem(PREFS_KEY, JSON.stringify({ v: 1, lang: p.lang, logLines: p.logLines }));
  } catch (e) { /* no storage: the choice lasts for this session only */ }
}
// ---- end UI preferences ----

// ---- inbound port settings ----
// The local socks/http inbound ports are core intent, not UI prefs: the shell reads them
// from state.json's `settings` when it renders config.json (ADR 0009), so saving goes
// through state.json + the shell's render/restart path, like a node apply. tests/prefs.test.js
// runs this block too.

var PORT_DEFAULTS = { socks: 10808, http: 10809 };
var TP_PORT = 10810; // the tproxy inbound the shell owns; a local inbound must not take it

function portVal(raw) {
  var n = Number(raw);
  if (!isFinite(n) || n !== Math.floor(n)) { return 0; }
  return n >= 1 && n <= 65535 ? n : 0;
}

// Per-field fallback: a missing or invalid port leaves that inbound on its default, so a
// hand-edited state.json can never knock both inbounds out. The same rule the shell applies.
function portsNormalize(raw) {
  var s = raw && typeof raw === "object" ? portVal(raw.socksPort) : 0;
  var h = raw && typeof raw === "object" ? portVal(raw.httpPort) : 0;
  return { socks: s || PORT_DEFAULTS.socks, http: h || PORT_DEFAULTS.http };
}

// "" = acceptable; otherwise the i18n key of why the save is refused.
function portsValidate(socks, http) {
  var s = portVal(socks), h = portVal(http);
  if (!s || !h) { return "portRange"; }
  if (s === h) { return "portSame"; }
  if (s === TP_PORT || h === TP_PORT) { return "portTp"; }
  return "";
}
// ---- end inbound port settings ----

// ---- node parsing ----
// Share link → node. Lives here rather than in the shell: there is no jq on the device and
// URI/JSON/base64 handling in awk would be a liability. tests/parse.test.js extracts this
// block from the shipped file, so keep the markers.

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

// `new URL()` was the obvious way to split these links, and it is the wrong dependency: userinfo
// handling for a non-special scheme is exactly the sort of thing a WebView can differ on, and
// when it does, every vless/trojan link fails at once with "missing uuid". Splitting
// scheme://[userinfo@]host:port[?query][#frag] by hand is a dozen lines and predictable.
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

// Link `type=` values are the v2ray/Xray `network` values, except that some clients write
// `http` for HTTP/2. Anything unrecognised is kept verbatim rather than guessed at.
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

// vmess:// carries base64(JSON) — v2rayN's object, not a URI. The newer `vmess://uuid@host`
// form is a different spec and is reported as unsupported instead of mis-parsed.
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
  // `trojan://user:pass@host` appears in the wild; the password is the part after the colon.
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

// ss:// is two formats in one: SIP002 puts base64(method:password) in the userinfo, the
// legacy form base64s the whole method:password@host:port. A plain `method:password`
// userinfo is also legal and must not be fed to atob.
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

// Identity decides deduplication: protocol + host + port + credential. Name, transport and
// TLS parameters are presentation, not identity (see docs/state-schema.md).
function identityOf(node) {
  var cred;
  if (node.protocol === "ss") { cred = [node.method, node.password]; }
  else if (node.protocol === "trojan") { cred = [node.password]; }
  else { cred = [node.uuid]; }
  var parts = [node.protocol, String(node.address || "").toLowerCase(), node.port];
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

// A whole base64 blob (what airports hand out) is only decoded when the input has no link on
// any line, so a single malformed line can never turn the whole paste into garbage.
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

// ---- outbound rendering ----
// state.json's selected node → the one Xray outbound the shell splices into the config
// template. The shell cannot parse nested JSON (there is no jq on the device), so the
// protocol knowledge lives here and tests/outbound.test.js runs this exact block.
//
// The node outbound carries the "__KERNELRAY_MARK__" sockopt placeholder, never a real
// mark: on Android a SO_MARK with no matching ip rule loses routing (the node's Reality
// handshake failed on v0.6 until the mark was removed). The shell replaces the
// placeholder with the bypass mark only while takeover is on (docs/adr/0008), keeping
// mark and rules together; the template's fixed direct outbound keeps its literal mark
// because an unused outbound creates no socket.

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
  // Replaced by the shell with the bypass mark (takeover on) or 0 (off); never a real
  // mark here, because the renderer cannot know the switch state.
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

function uptime(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) { return "–"; }
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  var m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) { return d + "d " + h + "h"; }
  if (h) { return h + "h " + m + "m"; }
  if (m) { return m + "m " + s + "s"; }
  return s + "s";
}

function setButtons() {
  var running = lastState === "running";
  // No applied node, no start: the shell's start gate would refuse it anyway (ADR 0010).
  els.start.disabled = busy || running || !(lastKv && lastKv.node);
  els.stop.disabled = busy || !running;
  els.start.textContent = busy && pending === "start" ? T.startingMsg : T.start;
  els.stop.textContent = busy && pending === "stop" ? T.stoppingMsg : T.stop;
  els.setTpSwitch.disabled = busy;
  els.iSocks.disabled = !hasBridge;
  els.iHttp.disabled = !hasBridge;
  els.portsSave.disabled = busy || !hasBridge;
  if (els.nList) { els.nList.classList.toggle("busy", busy); }
}

function findNodeById(state, id) {
  if (!state || !id || !Array.isArray(state.manual)) { return null; }
  for (var i = 0; i < state.manual.length; i++) {
    var n = state.manual[i];
    if (n && String(n.id) === String(id)) { return n; }
  }
  return null;
}

// IPv6 addresses are stored without brackets (that is what Xray wants), so the display has to
// put them back — otherwise "2001:db8::1:443" is unreadable.
function hostPort(n) {
  var a = String(n.address || "");
  if (a.indexOf(":") >= 0) { a = "[" + a + "]"; }
  return a + (n.port ? ":" + n.port : "");
}

// ---- node list model ----
// state.json + runtime/applied → the rows the Nodes page shows. Pure and free of DOM so
// tests/nodelist.test.js can run it without a browser. Subscription nodes are out of scope
// for this version: the list renders the manual store only.
function nodeListModel(state, appliedId) {
  var rows = [];
  var selectedId = state && typeof state.selected === "string" ? state.selected : "";
  var applied = appliedId ? String(appliedId) : "";
  var manual = state && Array.isArray(state.manual) ? state.manual : [];
  var selectedKnown = selectedId === "";
  var appliedKnown = applied === "";
  for (var i = 0; i < manual.length; i++) {
    var n = manual[i];
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") {
      continue;
    }
    var id = String(n.id);
    var row = {
      node: n, id: id,
      applied: applied !== "" && id === applied,
      selected: selectedId !== "" && id === selectedId,
      dirty: !!n.dirty
    };
    row.unapplied = row.selected && !row.applied;
    // Tapping the applied node does no core work unless a re-import changed its fields.
    row.noop = row.applied && !row.dirty;
    if (row.applied) { appliedKnown = true; }
    if (row.selected) { selectedKnown = true; }
    rows.push(row);
  }
  return {
    rows: rows, appliedId: applied, selectedId: selectedId,
    appliedKnown: appliedKnown, selectedKnown: selectedKnown, empty: rows.length === 0
  };
}

// The edit-mode check set → what a batch delete may act on. Pure so tests/nodelist.test.js
// can run it: the applied row never joins (single delete refuses it too), and check ids
// that no longer have a row (a stale set after a refresh) are simply ignored.
function batchModel(model, checks) {
  var set = checks || {};
  var checkable = [];
  var checked = [];
  for (var i = 0; i < model.rows.length; i++) {
    var row = model.rows[i];
    if (row.applied) { continue; }
    checkable.push(row.id);
    if (set[row.id]) { checked.push(row.id); }
  }
  return {
    checkableIds: checkable, checkedIds: checked,
    allChecked: checkable.length > 0 && checked.length === checkable.length
  };
}
// ---- end node list model ----

function nodeMeta(n) {
  var bits = [];
  if (n.protocol) { bits.push(n.protocol); }
  if (n.transport && n.transport !== "tcp") { bits.push(n.transport); }
  if (n.security) { bits.push(n.security); }
  if (n.address) { bits.push(hostPort(n)); }
  return bits.join(" · ");
}

function pill(text, cls) {
  var el = document.createElement("span");
  el.className = "pill " + cls;
  el.textContent = text;
  return el;
}

function listHint(model, state) {
  if (!state) { return { text: T.nodeNoState, cls: "" }; }
  if (state.schema && state.schema !== 1) {
    return { text: T.nodeSchema + state.schema, cls: "warn" };
  }
  if (!model.appliedKnown) { return { text: T.appliedMissing, cls: "warn" }; }
  if (!model.selectedKnown) { return { text: T.selectedMissing, cls: "warn" }; }
  for (var i = 0; i < model.rows.length; i++) {
    if (model.rows[i].applied && model.rows[i].dirty) {
      return { text: T.nodeReapply, cls: "warn" };
    }
  }
  if (model.empty) { return { text: T.emptyNodes, cls: "" }; }
  if (editMode) { return { text: T.editHint, cls: "" }; }
  return { text: T.listHint, cls: "" };
}

function rowSig(row) {
  var n = row.node;
  return [row.id, n.name || "", n.protocol || "", n.transport || "", n.security || "",
    n.address || "", n.port || "", row.applied ? 1 : 0, row.selected ? 1 : 0,
    row.dirty ? 1 : 0].join("|");
}

// Every row is built with createElement/textContent: node names come from imported links and
// must never reach innerHTML.
function renderRow(row) {
  var el = document.createElement("div");
  el.className = "nrow" + (row.applied ? " applied" : "") +
    (confirmId === row.id && !editMode ? " confirming" : "") +
    (editMode ? " editing" : "");
  el.setAttribute("data-id", row.id);

  var main = document.createElement("div");
  main.className = "nrow-main";
  var name = document.createElement("div");
  name.className = "nrow-name";
  name.textContent = row.node.name || row.node.protocol || "node";
  main.appendChild(name);
  var meta = document.createElement("div");
  meta.className = "nrow-meta";
  meta.textContent = nodeMeta(row.node);
  main.appendChild(meta);
  el.appendChild(main);

  if (confirmId === row.id) {
    var q = document.createElement("div");
    q.className = "nrow-q";
    q.textContent = T.deleteConfirm;
    main.appendChild(q);
    var actions = document.createElement("div");
    actions.className = "nactions";
    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "small danger";
    yes.setAttribute("data-action", "confirm");
    yes.textContent = T.delete;
    var no = document.createElement("button");
    no.type = "button";
    no.className = "small";
    no.setAttribute("data-action", "cancel");
    no.textContent = T.cancel;
    actions.appendChild(yes);
    actions.appendChild(no);
    el.appendChild(actions);
    return el;
  }

  if (!editMode) {
    el.setAttribute("role", "button");
    el.tabIndex = 0;
  } else {
    // In edit mode the whole row is the check toggle; the applied row's box is disabled
    // because a delete refuses it too. The switch gesture waits outside edit mode.
    var check = document.createElement("input");
    check.type = "checkbox";
    check.className = "ncheck";
    check.setAttribute("data-action", "check");
    check.setAttribute("aria-label", row.node.name || row.id);
    check.checked = !!checkSet[row.id];
    if (row.applied) { check.disabled = true; }
    el.insertBefore(check, el.firstChild);
  }

  var pills = document.createElement("div");
  pills.className = "npills";
  if (row.applied) { pills.appendChild(pill(T.nodeApplied, "ok")); }
  else if (row.unapplied) { pills.appendChild(pill(T.nodePending, "warn")); }
  if (row.dirty) { pills.appendChild(pill(T.nodeDirty, "warn")); }
  main.appendChild(pills);

  if (editMode) { return el; }

  var del = document.createElement("button");
  del.type = "button";
  del.className = "ndel" + (row.applied ? " muted" : "");
  del.setAttribute("data-action", "delete");
  del.setAttribute("aria-label", T.delete);
  del.textContent = "✕";
  el.appendChild(del);
  return el;
}

// The edit-mode toolbar: select-all, the batch delete and its inline confirm. Built with
// createElement/textContent like every row; the count comes from the check set.
function renderBatchBar(model, bm) {
  var bar = els.nToolbar;
  if (!editMode || model.empty) {
    bar.hidden = true;
    bar.textContent = "";
    return;
  }
  bar.hidden = false;
  bar.textContent = "";
  if (batchConfirm) {
    var q = document.createElement("span");
    q.className = "nbatch-q";
    q.textContent = T.deleteConfirmN.replace("{n}", String(bm.checkedIds.length));
    bar.appendChild(q);
    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "small danger";
    yes.setAttribute("data-action", "batchconfirm");
    yes.textContent = T.delete;
    var no = document.createElement("button");
    no.type = "button";
    no.className = "small";
    no.setAttribute("data-action", "batchcancel");
    no.textContent = T.cancel;
    bar.appendChild(yes);
    bar.appendChild(no);
    return;
  }
  var all = document.createElement("button");
  all.type = "button";
  all.className = "small";
  all.setAttribute("data-action", "checkall");
  all.textContent = bm.allChecked ? T.uncheckAll : T.checkAll;
  all.disabled = bm.checkableIds.length === 0;
  var del = document.createElement("button");
  del.type = "button";
  del.className = "small danger";
  del.setAttribute("data-action", "batchdel");
  del.textContent = bm.checkedIds.length > 0
    ? T.batchDelete + " (" + bm.checkedIds.length + ")"
    : T.batchDelete;
  del.disabled = bm.checkedIds.length === 0;
  bar.appendChild(all);
  bar.appendChild(del);
}

function renderNodeList() {
  var state = lastStateObj;
  var model = nodeListModel(state, lastApplied);
  var bm = batchModel(model, checkSet);
  var sig = [String(state && state.schema), lastApplied, confirmId || "",
    editMode ? "edit" : "", batchConfirm ? "batch" : ""];
  bm.checkedIds.forEach(function (id) { sig.push(id); });
  model.rows.forEach(function (row) { sig.push(rowSig(row)); });
  var signature = sig.join("\n");
  if (signature !== listSig) {
    listSig = signature;
    els.nList.textContent = "";
    model.rows.forEach(function (row) { els.nList.appendChild(renderRow(row)); });
    if (model.empty) {
      // An empty list must still offer the one gesture that fills it, not just the + in
      // the card header: a first-time user looks at the middle of the page.
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "primary nempty";
      addBtn.setAttribute("data-action", "add");
      addBtn.textContent = T.addTitle;
      els.nList.appendChild(addBtn);
    }
  }
  renderBatchBar(model, bm);
  els.editNode.textContent = editMode ? T.done : T.edit;
  els.editNode.disabled = busy || model.empty;
  var hint = listHint(model, state);
  els.nHint.textContent = hint.text;
  els.nHint.className = "nodehint" + (hint.cls ? " " + hint.cls : "");
  if (els.nList) { els.nList.classList.toggle("busy", busy); }
}

// selected is written before outbound.meta/outbound.json/CLI: a crash or a failed apply then
// leaves the honest "selected B, applied A" state instead of a config newer than the pointer.
function writeSelected(id) {
  if (!lastStateObj || lastStateObj.selected === id) { return Promise.resolve(false); }
  lastStateObj.selected = id;
  lastStateObj.revision = (Number(lastStateObj.revision) || 0) + 1;
  return writeState(lastStateObj).then(function () { return true; });
}

function switchTo(n) {
  if (busy || !hasBridge) { return; }
  if (!lastStateObj) { toast(T.nodeNoState); return; }
  if (lastStateObj.schema && lastStateObj.schema !== 1) {
    toast(T.nodeSchema + lastStateObj.schema);
    return;
  }
  if (!n || !n.id || !/^[0-9A-Za-z_-]+$/.test(n.id)) {
    toast(T.actionFailed + ": node has no usable id");
    return;
  }

  // Already the applied node: no core work. A failed switch may still point selected here.
  if (lastApplied && lastApplied === n.id && !n.dirty) {
    busy = true;
    setButtons();
    renderNodeList();
    writeSelected(n.id).catch(function (e) { toast(T.actionFailed + ": " + e.message); }).then(function () {
      busy = false;
      setButtons();
      refreshPage();
    });
    return;
  }

  var out;
  try {
    out = outboundOf(n);
  } catch (e) {
    toast(T.actionFailed + ": " + e.message);
    return;
  }

  confirmId = null;
  busy = true;
  setButtons();
  renderNodeList();
  toast(T.applyingMsg);

  writeSelected(n.id).then(function () {
    var meta = "id=" + n.id + "\nhost=" + String(n.address || "") + "\n";
    return writeFile(OUTBOUND_META, meta, "600");
  }).then(function () {
    return writeFile(OUTBOUND, JSON.stringify(out), "600");
  }).then(function () {
    return exec(CLI + " apply " + n.id);
  }).then(function (r) {
    if (r.errno !== 0) {
      throw new Error((r.stderr || "").trim() || ("exit " + r.errno));
    }
    if (n.dirty) {
      // Clear the flag only if the node still renders to the exact outbound that was just
      // applied; a newer edit must stay marked as not applied.
      var cur = findNodeById(lastStateObj, n.id);
      var current = "";
      if (cur) {
        try { current = JSON.stringify(outboundOf(cur)); } catch (e) { current = ""; }
      }
      if (cur && current === JSON.stringify(out)) {
        cur.dirty = false;
        lastStateObj.revision = (Number(lastStateObj.revision) || 0) + 1;
        return writeState(lastStateObj);
      }
    }
  }).then(function () {
    toast(T.appliedMsg);
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    setButtons();
    refreshPage();
  });
}

function askDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  if (lastApplied && lastApplied === n.id) { toast(T.deleteApplied); return; }
  confirmId = n.id;
  renderNodeList();
}

// One deletion path for one id or many: filter the manual store, clear the selected pointer
// when it named a deleted node, drop the rendered outbound when it belonged to one, then
// persist. The rm runs before the write: a failed rm must leave the node in the store so the
// removal can be retried.
function deleteNodes(ids) {
  var state = lastStateObj;
  var gone = {};
  ids.forEach(function (id) { gone[id] = true; });
  state.manual = (Array.isArray(state.manual) ? state.manual : []).filter(function (x) {
    return !x || !gone[x.id];
  });
  if (gone[state.selected]) { state.selected = ""; }
  state.revision = (Number(state.revision) || 0) + 1;
  busy = true;
  setButtons();
  renderNodeList();
  var removeRendered = lastMetaId && gone[lastMetaId];
  var chain = removeRendered ? exec("rm -f " + OUTBOUND + " " + OUTBOUND_META).then(function (r) {
    if (r.errno !== 0) { throw new Error((r.stderr || "").trim() || ("exit " + r.errno)); }
    lastMetaId = "";
  }) : Promise.resolve();
  return chain.then(function () {
    return writeState(state);
  });
}

function confirmDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  if (lastApplied && lastApplied === n.id) {
    confirmId = null;
    renderNodeList();
    toast(T.deleteApplied);
    return;
  }
  deleteNodes([n.id]).then(function () {
    confirmId = null;
    toast(T.deleted);
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    setButtons();
    refreshPage();
  });
}

function confirmBatchDelete() {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var ids = batchModel(nodeListModel(lastStateObj, lastApplied), checkSet).checkedIds;
  if (ids.length === 0) {
    batchConfirm = false;
    renderNodeList();
    return;
  }
  // The check set never holds the applied row, but a refresh between check and confirm
  // must not let it sneak in.
  if (lastApplied && ids.indexOf(lastApplied) >= 0) {
    batchConfirm = false;
    renderNodeList();
    toast(T.deleteApplied);
    return;
  }
  var n = ids.length;
  deleteNodes(ids).then(function () {
    checkSet = {};
    batchConfirm = false;
    toast(T.deletedN.replace("{n}", String(n)));
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    setButtons();
    refreshPage();
  });
}

// state.json is the intent; runtime/applied is the node the current config was built from.
// Read state, the applied id and the rendered outbound's meta in one exec; the list must show
// "selected but not applied" after a failed switch instead of pretending it already switched.
function refreshNodes() {
  return exec("cat " + STATE + " 2>/dev/null; echo '@@APPLIED@@'; cat " + APPLIED +
    " 2>/dev/null; echo '@@META@@'; cat " + OUTBOUND_META + " 2>/dev/null")
    .then(function (r) {
      var parts = r.stdout.split("@@APPLIED@@");
      var state = null;
      try { state = JSON.parse((parts[0] || "").trim()); } catch (e) { state = null; }
      if (!state || typeof state !== "object" || Array.isArray(state)) { state = null; }
      var rest = (parts[1] || "").split("@@META@@");
      lastStateObj = state;
      lastApplied = (rest[0] || "").trim().split("\n")[0];
      lastMetaId = parseKv(rest[1] || "").id || "";
      renderNodeList();
    }).catch(function () {});
}

// ---- node import UI ----

// Import dedupes inside the manual store: subscriptions are out of scope in this version and
// an update must never land on a node the list cannot show.
function findNodeByIdentity(state, ident) {
  var manual = state && Array.isArray(state.manual) ? state.manual : [];
  for (var i = 0; i < manual.length; i++) {
    var n = manual[i];
    if (n && n.protocol && n.address && identityOf(n) === ident) { return n; }
  }
  return null;
}

// Re-importing a node updates it in place and keeps its id, so the selection and any
// reference to it survive; only a genuinely new identity is appended.
function mergeNodes(state, nodes) {
  if (!state.schema) { state.schema = 1; }
  if (!Array.isArray(state.manual)) { state.manual = []; }
  if (!Array.isArray(state.subscriptions)) { state.subscriptions = []; }
  var added = 0, updated = 0;
  nodes.forEach(function (n) {
    delete n.dupOf;
    var existing = findNodeByIdentity(state, identityOf(n));
    if (existing) {
      var keepId = existing.id || idOf(n);
      Object.keys(n).forEach(function (k) { if (k !== "id") { existing[k] = n[k]; } });
      existing.id = keepId;
      // Same id, possibly new credentials/transport: the applied config is now stale.
      // The list marks it until the next successful apply clears the flag.
      existing.dirty = true;
      updated++;
    } else {
      n.id = n.id || idOf(n);
      state.manual.push(n);
      added++;
    }
  });
  return { added: added, updated: updated };
}

function writeFile(path, text, mode) {
  var bytes = new TextEncoder().encode(text);
  var bin = "";
  for (var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
  var b64 = btoa(bin);
  // tmp + mv so a half-written file is impossible; these files hold credentials, hence 0600.
  var cmd = "printf '%s' '" + b64 + "' | base64 -d > " + path + ".tmp && chmod " + mode +
    " " + path + ".tmp && mv " + path + ".tmp " + path;
  return exec(cmd).then(function (r) {
    if (r.errno !== 0) { throw new Error(r.stderr || ("exit " + r.errno)); }
  });
}

function writeState(state) {
  return writeFile(STATE, JSON.stringify(state, null, 2) + "\n", "600");
}

function previewLine(text, cls) {
  var row = document.createElement("div");
  row.className = "prow " + cls;
  var num = document.createElement("span");
  num.className = "pnum";
  num.textContent = text.num;
  row.appendChild(num);
  var body = document.createElement("div");
  body.className = "pbody";
  var name = document.createElement("div");
  name.className = "pname";
  name.textContent = text.name;
  body.appendChild(name);
  if (text.meta) {
    var meta = document.createElement("div");
    meta.className = "pmeta";
    meta.textContent = text.meta;
    body.appendChild(meta);
  }
  row.appendChild(body);
  return row;
}

// A partial failure leaves the dialog open over the user's text: the imported rows are
// done, and the failed ones are listed here so they can be fixed and retried.
function renderFailedRows(rows) {
  els.iPreview.textContent = "";
  rows.forEach(function (r) {
    els.iPreview.appendChild(previewLine(
      { num: r.line, name: r.error, meta: T.lineNo + r.line + T.lineNoEnd }, "bad"));
  });
}

// One gesture: parse the input and merge the parseable rows into the store. Nothing here
// switches or applies a node — the list's tap gesture owns that.
function doImport() {
  if (busy || !hasBridge) { return; }
  var rows = parseInput(els.iText.value);
  var ok = rows.filter(function (r) { return r.ok; });
  if (!ok.length) {
    els.iPreview.textContent = "";
    toast(T.importEmpty);
    return;
  }
  var bad = rows.filter(function (r) { return !r.ok; });

  busy = true;
  setButtons();
  els.iApply.disabled = true;
  exec("cat " + STATE + " 2>/dev/null").then(function (r) {
    var state = null;
    try { state = JSON.parse((r.stdout || "").trim()); } catch (e) { state = null; }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      state = { schema: 1, revision: 0, manual: [], subscriptions: [], selected: "" };
    }
    var res = mergeNodes(state, ok.map(function (x) { return x.node; }));
    state.revision = (Number(state.revision) || 0) + 1;
    return writeState(state).then(function () {
      var msg = T.importDone + " " + res.added;
      if (res.updated) { msg += T.importUpdated + " " + res.updated; }
      if (!bad.length) {
        toast(msg);
        closeAdd();
        refreshPage();
      } else {
        // The text stays for editing; re-importing is safe because mergeNodes updates
        // by identity instead of duplicating.
        toast(msg + T.importFailedN.replace("{n}", String(bad.length)));
        renderFailedRows(bad);
      }
    });
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    setButtons();
    els.iApply.disabled = !els.iText.value.trim();
  });
}

// The running hints mention the socks port; the shell now reports the configured one.
function hintText(t, kv) {
  return String(t || "").replace("{port}", kv && kv.socks ? String(kv.socks) : String(PORT_DEFAULTS.socks));
}

function renderStatus(kv) {
  lastKv = kv;
  var state = kv.state || "unknown";
  var phase = kv.phase || "";
  var failed = phase === "config-invalid" || phase === "no-core" || phase === "crashed"
    || phase === "no-config" || phase === "failed/rules" || phase === "failed/conflict";
  var cls = failed ? "failed" : state;
  var text = T[state] || state;
  if (failed) { text = T.failed + " · " + (T[phase] || phase); }
  els.badge.textContent = text;
  els.badge.className = "badge " + cls;

  if (document.visibilityState === "visible") { lastState = state; }
  els.pid.textContent = kv.pid && kv.pid !== "-" ? kv.pid : "–";
  els.up.textContent = state === "running" && kv.started
    ? uptime(Math.floor(Date.now() / 1000) - Number(kv.started))
    : "–";
  els.port.textContent = kv.socks ? "socks " + kv.socks + " · http " + kv.http : "–";
  els.core.textContent = kv.version && kv.version !== "-" ? kv.version : (kv.core || "–");
  els.conf.textContent = kv.conf || "–";
  if (state === "running") {
    // Rule presence, not the switch preference: a core started while the switch was
    // off (or before the change could apply) is not capturing anything yet.
    if (kv.rules === "present") { els.hint.textContent = hintText(T.tpRunningHint, kv); }
    else { els.hint.textContent = hintText(T.runningHint, kv); }
  } else {
    els.hint.textContent = kv.node ? T.stoppedHint : T.stoppedHintNone;
  }

  // The status card is failure-only since ADR 0011: the switch itself lives in
  // Settings. A conflict or rule failure leaves the switch on but unenforced; the
  // hint says so and the retry runs the same start the button does.
  var tpFailed = phase === "failed/conflict" || phase === "failed/rules";
  els.tpCard.hidden = !tpFailed;
  if (tpFailed) {
    els.tpHint.textContent = phase === "failed/conflict" ? T.tpConflict : T.tpRules;
  }
  els.tpRetry.hidden = !tpFailed || busy;

  // The Settings switch follows the persisted preference (kv.tproxy), with the
  // next-start semantics spelled out while the running core does not match it yet.
  var tpOn = kv.tproxy === "on";
  els.setTpSwitch.classList.toggle("on", tpOn);
  els.setTpSwitch.setAttribute("aria-checked", tpOn ? "true" : "false");
  if (!kv.node) { els.setTpHint.textContent = T.setTpNoNode; }
  else if (state === "running" && tpOn && kv.rules !== "present") {
    els.setTpHint.textContent = T.setTpPending;
  } else {
    els.setTpHint.textContent = tpOn ? T.setTpOn : T.setTpOff;
  }

  setButtons();
}

function renderLog(text) {
  if (text === lastLog) { return; }
  lastLog = text;
  var atBottom = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 24;
  els.log.textContent = text || T.noLog;
  if (els.follow.checked && atBottom) { els.log.scrollTop = els.log.scrollHeight; }
}

function refreshStatus() {
  return exec(CLI + " status").then(function (r) {
    if (r.errno !== 0 && !r.stdout) {
      els.banner.textContent = r.stderr || (T.actionFailed + " (status)");
      els.banner.className = "banner show";
      return;
    }
    renderStatus(parseKv(r.stdout));
  }).catch(function () { /* bridge error already reported at boot */ });
}

function refreshLog() {
  return exec(CLI + " log " + logLines).then(function (r) {
    renderLog(r.stdout || r.stderr);
  }).catch(function () {});
}

// The Settings page shows the effective ports (state.json's, defaults applied), so the
// user sees what the shell would render even if the file was last written by hand.
// A field the user is editing is left alone: a 2s poll must not clobber typing.
function refreshSettings() {
  return exec("cat " + STATE + " 2>/dev/null").then(function (r) {
    var state = null;
    try { state = JSON.parse((r.stdout || "").trim()); } catch (e) { state = null; }
    var p = portsNormalize(state && state.settings);
    if (!portsDirty.socks && document.activeElement !== els.iSocks) {
      els.iSocks.value = String(p.socks);
    }
    if (!portsDirty.http && document.activeElement !== els.iHttp) {
      els.iHttp.value = String(p.http);
    }
  }).catch(function () {});
}

// One gesture: validate, write state.json's settings (intent first), then let the shell
// render, test and restart. A failed render or restart leaves the old config running and
// surfaces the CLI's error, like a failed node apply.
function doSavePorts() {
  if (busy || !hasBridge) { return; }
  var err = portsValidate(els.iSocks.value, els.iHttp.value);
  if (err) { toast(T[err]); return; }
  busy = true;
  setButtons();
  toast(T.portsSaving);
  exec("cat " + STATE + " 2>/dev/null").then(function (r) {
    var state = null;
    try { state = JSON.parse((r.stdout || "").trim()); } catch (e) { state = null; }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      state = { schema: 1, revision: 0, manual: [], subscriptions: [], selected: "" };
    }
    if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) {
      state.settings = {};
    }
    state.settings.socksPort = portVal(els.iSocks.value);
    state.settings.httpPort = portVal(els.iHttp.value);
    state.revision = (Number(state.revision) || 0) + 1;
    return writeState(state).then(function () {
      return exec(CLI + " ports");
    }).then(function (r) {
      if (r.errno !== 0) { toast(T.actionFailed + ": " + (r.stderr || r.errno)); }
      else {
        // The saved values are the effective ones now; let the poll sync the fields again.
        portsDirty.socks = false;
        portsDirty.http = false;
        toast(T.portsSaved);
      }
    });
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    setButtons();
    refreshPage();
  });
}

// ---- navigation ----
// Hash routes are the only navigation state: a reload lands on the same tab and
// a link can deep-link into one. Taps replace rather than push, so a long-lived
// WebView does not accumulate history for every tab switch.
var DEFAULT_ROUTE = "status";
var currentRoute = null;
var scrollByRoute = { status: 0, nodes: 0, log: 0, settings: 0 };
var ROUTES = ["status", "nodes", "log", "settings"];

function routeOf(value) {
  var route = String(value == null ? "" : value)
    .replace(/^#\/?/, "").replace(/\/+$/, "").toLowerCase();
  if (ROUTES.indexOf(route) >= 0) { return route; }
  return DEFAULT_ROUTE;
}

function routeHash(route) { return "#/" + route; }

function showRoute(route, opts) {
  route = routeOf(route);
  // The check set is a temporary intent: leaving the node page via the tab bar discards
  // it rather than carrying it across. The add dialog overlays without a route change.
  // Typed-but-unsaved ports are the same: leaving the page discards them.
  if (route !== "settings") {
    portsDirty.socks = false;
    portsDirty.http = false;
  }
  if (route !== "nodes" && editMode) {
    editMode = false;
    checkSet = {};
    batchConfirm = false;
  }
  if (currentRoute && currentRoute !== route) {
    scrollByRoute[currentRoute] = window.scrollY || window.pageYOffset || 0;
  }
  currentRoute = route;
  Object.keys(pages).forEach(function (key) { pages[key].hidden = key !== route; });
  tabs.forEach(function (tab) {
    var tr = tab.getAttribute("data-route");
    var active = tr === route;
    tab.classList.toggle("active", active);
    if (active) { tab.setAttribute("aria-current", "page"); }
    else { tab.removeAttribute("aria-current"); }
  });
  // Hidden pages have no layout, so restore the scroll after the chosen page exists.
  var y = scrollByRoute[route] || 0;
  window.scrollTo(0, y);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () { window.scrollTo(0, y); });
  }
  // Entering the log page with Follow on should land on the newest lines even
  // when the text itself did not change since the last visit.
  if (route === "log" && els.follow.checked) {
    var toBottom = function () { els.log.scrollTop = els.log.scrollHeight; };
    if (typeof requestAnimationFrame === "function") { requestAnimationFrame(toBottom); }
    else { toBottom(); }
  }
  if (!opts || opts.refresh !== false) { refreshPage(); }
}

// The add dialog holds no route and no history entry: the back gesture stays with the
// tab bar. Opening resets it because closing discards whatever was typed.
function openAdd() {
  els.iText.value = "";
  els.iPreview.textContent = "";
  els.iHint.textContent = T.notAppliedYet;
  els.iHint.className = "nodehint";
  els.iApply.disabled = true;
  els.overlay.hidden = false;
}

function closeAdd() {
  els.overlay.hidden = true;
}

function go(route) {
  route = routeOf(route);
  if (route === currentRoute) { refreshPage(); return; }
  var hash = routeHash(route);
  var replaced = false;
  try { history.replaceState(null, "", hash); replaced = true; } catch (e) { /* fall back below */ }
  if (replaced) { showRoute(route, { refresh: true }); }
  else { location.hash = hash; }
}

function initNav() {
  var start = routeOf(location.hash);
  var hash = routeHash(start);
  if (location.hash !== hash) {
    try { history.replaceState(null, "", hash); } catch (e) { /* routeOf still handles the odd hash */ }
  }
  showRoute(start, { refresh: false });
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function (e) {
      e.preventDefault();
      go(tab.getAttribute("data-route"));
    });
  });
  window.addEventListener("hashchange", function () {
    var route = routeOf(location.hash);
    var normalized = routeHash(route);
    if (location.hash !== normalized) {
      try { history.replaceState(null, "", normalized); } catch (e) {}
    }
    if (route === currentRoute) { return; }
    showRoute(route, { refresh: true });
  });
}

function refreshPage() {
  if (!hasBridge) { return; }
  refreshStatus();
  if (currentRoute === "nodes") { refreshNodes(); }
  else if (currentRoute === "log") { refreshLog(); }
  else if (currentRoute === "settings") { refreshSettings(); }
}

function run(command, pendingLabel) {
  if (busy) { return; }
  busy = true;
  pending = command;
  setButtons();
  toast(pendingLabel);
  exec(CLI + " " + command).then(function (r) {
    if (r.errno !== 0) { toast(T.actionFailed + ": " + (r.stderr || r.errno)); }
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    pending = null;
    refreshPage();
  });
}

els.start.addEventListener("click", function () { run("start", T.startingMsg); });
els.stop.addEventListener("click", function () { run("stop", T.stoppingMsg); });
els.setTpSwitch.addEventListener("click", function () {
  var target = lastKv && lastKv.tproxy === "on" ? "off" : "on";
  run("tproxy " + target, target === "on" ? T.tpOnMsg : T.tpOffMsg);
});
els.tpRetry.addEventListener("click", function () { run("start", T.startingMsg); });
els.refresh.addEventListener("click", function () { refreshPage(); });
els.nList.addEventListener("click", function (e) {
  var t = e.target;
  var act = t && t.getAttribute ? t.getAttribute("data-action") : "";
  if (act === "add") { openAdd(); return; }
  var row = t && t.closest ? t.closest(".nrow") : null;
  if (!row) { return; }
  var node = findNodeById(lastStateObj, row.getAttribute("data-id"));
  if (!node) { return; }
  // In edit mode the whole row is the check toggle; the applied row is excluded and
  // ADR 0007's switch gesture waits outside edit mode.
  if (editMode) {
    if (lastApplied && lastApplied === node.id) { return; }
    if (checkSet[node.id]) { delete checkSet[node.id]; } else { checkSet[node.id] = true; }
    renderNodeList();
    return;
  }
  var action = t.getAttribute ? t.getAttribute("data-action") : "";
  if (action === "delete") { askDelete(node); return; }
  if (action === "cancel") { confirmId = null; renderNodeList(); return; }
  if (action === "confirm") { confirmDelete(node); return; }
  if (confirmId) { return; }
  switchTo(node);
});
els.nList.addEventListener("keydown", function (e) {
  if (e.key !== "Enter" && e.key !== " ") { return; }
  if (!e.target.classList || !e.target.classList.contains("nrow")) { return; }
  e.preventDefault();
  var node = findNodeById(lastStateObj, e.target.getAttribute("data-id"));
  if (!node) { return; }
  if (editMode) {
    if (lastApplied && lastApplied === node.id) { return; }
    if (checkSet[node.id]) { delete checkSet[node.id]; } else { checkSet[node.id] = true; }
    renderNodeList();
    return;
  }
  switchTo(node);
});
els.editNode.addEventListener("click", function () {
  editMode = !editMode;
  checkSet = {};
  batchConfirm = false;
  confirmId = null;
  renderNodeList();
});
els.nToolbar.addEventListener("click", function (e) {
  var t = e.target;
  var act = t && t.getAttribute ? t.getAttribute("data-action") : "";
  if (act === "checkall") {
    var bm = batchModel(nodeListModel(lastStateObj, lastApplied), checkSet);
    if (bm.allChecked) {
      bm.checkableIds.forEach(function (id) { delete checkSet[id]; });
    } else {
      bm.checkableIds.forEach(function (id) { checkSet[id] = true; });
    }
  } else if (act === "batchdel") {
    batchConfirm = true;
  } else if (act === "batchconfirm") {
    confirmBatchDelete();
    return;
  } else if (act === "batchcancel") {
    batchConfirm = false;
  } else {
    return;
  }
  renderNodeList();
});
els.iApply.addEventListener("click", doImport);
els.addNode.addEventListener("click", openAdd);
els.addClose.addEventListener("click", closeAdd);
els.overlay.addEventListener("click", function (e) {
  if (e.target === els.overlay) { closeAdd(); }
});
els.iText.addEventListener("input", function () {
  els.iApply.disabled = busy || !els.iText.value.trim();
});
els.selLang.addEventListener("change", function () {
  var v = els.selLang.value;
  if (LANGS.indexOf(v) < 0 || v === langPref) { return; }
  langPref = v;
  prefs.lang = v;
  prefsSave(prefsStore(), prefs);
  applyLang();
  if (hasBridge) {
    refreshStatus();
    if (currentRoute === "log") { refreshLog(); }
  }
});
els.selLog.addEventListener("change", function () {
  var n = Number(els.selLog.value);
  if (LOG_LINE_STEPS.indexOf(n) < 0 || n === logLines) { return; }
  logLines = n;
  prefs.logLines = n;
  prefsSave(prefsStore(), prefs);
  renderPrefs();
  if (hasBridge && currentRoute === "log") { refreshLog(); }
});
els.portsSave.addEventListener("click", doSavePorts);
els.iSocks.addEventListener("input", function () { portsDirty.socks = true; });
els.iHttp.addEventListener("input", function () { portsDirty.http = true; });

// Poll only while the page is actually visible; the WebView freezes timers in
// the background and a stale interval would otherwise pile up on resume.
var timer = null;
function startPolling() {
  if (timer || !hasBridge) { return; }
  refreshPage();
  timer = setInterval(refreshPage, POLL_MS);
}
function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "hidden") { stopPolling(); } else { startPolling(); }
});

var prefs = prefsLoad(prefsStore());
langPref = prefs.lang;
logLines = prefs.logLines;
applyLang();
initNav();
if (!hasBridge) {
  els.banner.textContent = T.noBridge;
  els.banner.className = "banner show";
  els.badge.textContent = T.unknown;
  els.hint.textContent = "";
  return;
}
setButtons();
startPolling();
})();
