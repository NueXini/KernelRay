(function () {
"use strict";

var MOD = "/data/adb/modules/KernelRay";
var CLI = MOD + "/scripts/kernelray.sh";
// 配置、节点库和日志也都放在模块目录里——只有一个根，不写到它之外。
var STATE = MOD + "/state.json";
var APPLIED = MOD + "/runtime/applied";
var OUTBOUND = MOD + "/outbound.json";
var OUTBOUND_META = MOD + "/outbound.meta";
// 日志行数是设置页偏好；偏好加载完成之前默认为 200。
var logLines = 200;
var POLL_MS = 2000;
// 日志等级是核心意图，不是 WebView 偏好：下拉框跟随 shell 的
// 状态（runtime/loglevel），保存的值在下次启动核心时生效（docs/adr/0015）。
var LOG_LEVELS = ["none", "error", "warning", "info", "debug"];

// 语言和主题是设置页偏好，不是开机时的事实：applyLang()
// 会重新给 T 赋值，applyTheme()（theme.js）打上 data-theme，每次读取 T.x
// 都取当前词典，因为没有谁把对象捕获下来。
var langPref = "auto"; // "auto" | "zh" | "en"；"auto" 时按 navigator.language 解析
var themePref = "auto"; // "auto" | "light" | "dark"；"auto" 时按系统设置解析
var DICT_ZH = {
  start: "启动", stop: "停止", follow: "跟随", pause: "暂停", refresh: "刷新",
  pid: "进程", up: "运行时长", port: "端口", conf: "配置",
  running: "运行中", stopped: "已停止", starting: "启动中", stopping: "停止中",
  failed: "启动失败", unknown: "未知",
  noBridge: "没有检测到 KernelSU 桥接，请从 KernelSU 管理器的模块页面打开本页面。",
  startingMsg: "正在启动…", stoppingMsg: "正在停止…",
  actionFailed: "操作失败", noLog: "（还没有日志）",
  logTabCore: "核心", logTabModule: "模块",
  clearCoreLog: "清空核心日志", clearModuleLog: "清空模块日志",
  clearCoreDone: "核心日志已清空", clearModuleDone: "模块日志已清空",
  stoppedHintTp: "核心未运行；开机不会自动启动，设备当前直连；点「启动」才接管。",
  stoppedHintNone: "核心未运行，也没有应用节点；先在节点列表打开一个节点并应用，核心才会启动。",
  tpRunningHint: "已接管：设备流量自动经核心转发；socks 127.0.0.1:{port} 仍然可用。",
  tpConflict: "接管被冲突阻止：设备上有别的 VPN 或透明代理在运行。核心没有启动，设备保持直连；处理后点「重试」。",
  tpRules: "接管规则安装失败，核心没有启动，设备保持直连。详情见 kernelray.log；点「重试」再试一次。",
  tpRetry: "重试",
  "failed/rules": "接管规则", "failed/conflict": "接管冲突",
  crashed: "核心已退出",
  applyingMsg: "正在应用节点…", appliedMsg: "节点已应用",
  nodeNoState: "没有 state.json，节点信息无从得知",
  nodeSchema: "state.json 的 schema 版本未识别：",
  listTitle: "节点列表",
  listHint: "点一个节点打开详情弹窗；在弹窗里点「应用」即可切换。",
  emptyNodes: "节点库还是空的；点右上角的 + 添加节点。",
  nodeApplied: "已应用", nodeDirty: "有改动", nodePending: "未应用",
  nodeReapply: "这个节点应用后有改动；打开弹窗点「重新应用」。",
  copyLink: "复制链接", copyBase64: "复制 Base64（订阅格式）", copyOptions: "复制选项",
  copiedLink: "链接已复制", copiedBase64: "Base64 已复制", copyFailed: "复制失败",
  copyIncludesCreds: "复制链接包含完整凭证", linkError: "无法生成链接",
  credentials: "凭证", apply: "应用", reapply: "重新应用", retryApply: "重试应用",
  dialogRunningHint: "核心正在运行；应用会重启核心。",
  dialogStoppedHint: "核心未运行；应用只写入配置，不会启动核心。",
  dialogAppliedHint: "当前已是应用节点；点击只会同步选择节点，不会重启核心。",
  dialogRetryHint: "上次应用没有成功；点击会重试。",
  nodeGone: "节点已不在节点库里。",
  fieldProtocol: "协议", fieldTransport: "传输", fieldSecurity: "安全",
  fieldAddress: "地址", fieldSni: "SNI", fieldHost: "Host", fieldPath: "Path",
  fieldServiceName: "服务名", fieldFingerprint: "指纹", fieldFlow: "Flow",
  fieldAlpn: "ALPN", fieldAllowInsecure: "允许不安全",
  fieldPublicKey: "公钥", fieldShortId: "Short ID",
  fieldUuid: "UUID", fieldPassword: "密码", fieldMethod: "加密方式",
  fieldCipher: "加密方式", fieldAlterId: "Alter ID", fieldEncryption: "加密",
  yes: "是", no: "否",
  selectedMissing: "state.json 的 selected 指向了一个不存在的节点。",
  appliedMissing: "runtime/applied 指向的节点不在节点库里。",
  delete: "删除", deleteApplied: "已应用的节点不能删除；先切换到别的节点。",
  deleteRunning: "核心正在运行；先停止核心，再删除最后一个节点。",
  deleteConfirm: "删除这个节点？",
  deleteConfirmApplied: "删除已应用的节点会取消应用：核心将无法启动，代理规则会被移除。",
  cancel: "取消", deleted: "已删除",
  edit: "编辑", done: "完成",
  checkAll: "全选", uncheckAll: "取消全选",
  batchDelete: "删除", deleteConfirmN: "删除 {n} 个节点？",
  deleteConfirmNApplied: "删除这些节点会取消应用：核心将无法启动，代理规则会被移除。",
  deletedN: "已删除 {n} 个节点",
  editHint: "勾选要删除的节点，点「删除」批量删除；已应用的节点只有在核心停止、且它是最后一个节点时才能删。",
  tabStatus: "状态", tabNodes: "节点", tabLog: "日志", tabSettings: "设置", navLabel: "页面",
  setGeneral: "常规设置",
  setTheme: "主题", themeAuto: "自动", themeLight: "日间", themeDark: "夜间",
  setLang: "语言", langAuto: "自动",
  setLog: "日志行数",
  setLogLevel: "日志等级",
  logLevelNone: "关闭", logLevelError: "错误", logLevelWarning: "警告",
  logLevelInfo: "信息", logLevelDebug: "调试",
  logLevelToast: "日志等级将在下次启动核心时生效",
  logLevelPending: "已保存；停止再启动核心后生效。",
  setPorts: "入站端口",
  setPortsHint: "本地 socks/http 入站在 127.0.0.1 上监听的端口。保存后重写核心配置；核心在运行时会重启。",
  portRange: "端口必须是 1–65535 之间的整数",
  portSame: "SOCKS 和 HTTP 端口不能相同",
  portTp: "这个端口留给透明代理入站（10810），换一个",
  portsSaving: "正在应用端口…", portsSaved: "端口已应用",
  portsSave: "保存",
  setRouteMode: "分流模式",
  routeGlobal: "全局", routeCn: "大陆直连", routeCnAdblock: "大陆直连去广告",
  routeCnNoGeodata: "geo 数据缺失（bin/geosite.dat、geoip.dat）：大陆直连当前按全局渲染，补齐文件后才真正生效。",
  routeGeoMissing: "geo 数据缺失",
  routeSwitching: "正在切换分流模式…",
  addTitle: "添加节点",
  addPlaceholder: "vless://…",
  close: "关闭",
  importBtn: "导入",
  lineNo: "第 ", lineNoEnd: " 行",
  importEmpty: "没有解析出可导入的节点",
  importDone: "已导入",
  importUpdated: "，更新",
  importFailedN: "，{n} 行失败",
  notAppliedYet: "导入只写入节点库；还没有已应用节点时会顺带应用一个，否则打开节点弹窗点「应用」。"
};
var DICT_EN = {
  start: "Start", stop: "Stop", follow: "Follow", pause: "Pause", refresh: "Refresh",
  pid: "PID", up: "Uptime", port: "Ports", conf: "Config",
  running: "running", stopped: "stopped", starting: "starting", stopping: "stopping",
  failed: "failed", unknown: "unknown",
  noBridge: "KernelSU bridge not found. Open this page from the module card in the KernelSU manager.",
  startingMsg: "Starting…", stoppingMsg: "Stopping…",
  actionFailed: "Action failed", noLog: "(no log yet)",
  logTabCore: "Core", logTabModule: "Module",
  clearCoreLog: "Clear core log", clearModuleLog: "Clear module log",
  clearCoreDone: "Core log cleared", clearModuleDone: "Module log cleared",
  stoppedHintTp: "The core is stopped; boot does not start it, so the device goes direct — press Start to take over.",
  stoppedHintNone: "The core is stopped and no node is applied; open a node in the list and press Apply — the core only starts with an applied node.",
  tpRunningHint: "Takeover is on: device traffic goes through the core; socks 127.0.0.1:{port} still works.",
  tpConflict: "Takeover is blocked by a conflict: another VPN or transparent proxy is running. The core did not start and the device stays direct; resolve it and tap Retry.",
  tpRules: "Installing the takeover rules failed. The core did not start and the device stays direct. See kernelray.log; tap Retry to try again.",
  tpRetry: "Retry",
  "failed/rules": "rules", "failed/conflict": "conflict",
  crashed: "core exited",
  applyingMsg: "Applying node…", appliedMsg: "Node applied",
  nodeNoState: "No state.json, so the nodes are unknown",
  nodeSchema: "Unrecognised state.json schema: ",
  listTitle: "Node list",
  listHint: "Tap a node to open its detail dialog; press Apply there to switch.",
  emptyNodes: "No nodes yet; tap + in the top right to add one.",
  nodeApplied: "Applied", nodeDirty: "Changed", nodePending: "Not applied",
  nodeReapply: "This node changed after it was applied; open its dialog and press Re-apply.",
  copyLink: "Copy link", copyBase64: "Copy Base64 (subscription)", copyOptions: "Copy options",
  copiedLink: "Link copied", copiedBase64: "Base64 copied", copyFailed: "Copy failed",
  copyIncludesCreds: "The copied link contains the full credentials",
  linkError: "Cannot build the link",
  credentials: "Credentials", apply: "Apply", reapply: "Re-apply", retryApply: "Retry apply",
  dialogRunningHint: "The core is running; applying restarts it.",
  dialogStoppedHint: "The core is stopped; applying writes the config but does not start it.",
  dialogAppliedHint: "This is the applied node; tapping only re-syncs the selection pointer and does not restart the core.",
  dialogRetryHint: "The last apply did not succeed; tapping retries.",
  nodeGone: "The node is no longer in the store.",
  fieldProtocol: "Protocol", fieldTransport: "Transport", fieldSecurity: "Security",
  fieldAddress: "Address", fieldSni: "SNI", fieldHost: "Host", fieldPath: "Path",
  fieldServiceName: "Service name", fieldFingerprint: "Fingerprint", fieldFlow: "Flow",
  fieldAlpn: "ALPN", fieldAllowInsecure: "Allow insecure",
  fieldPublicKey: "Public key", fieldShortId: "Short ID",
  fieldUuid: "UUID", fieldPassword: "Password", fieldMethod: "Method",
  fieldCipher: "Cipher", fieldAlterId: "Alter ID", fieldEncryption: "Encryption",
  yes: "Yes", no: "No",
  selectedMissing: "state.json points selected at a node that is not in the store.",
  appliedMissing: "runtime/applied points at a node that is not in the store.",
  delete: "Delete", deleteApplied: "The applied node cannot be deleted; switch to another node first.",
  deleteRunning: "The core is running; stop it first, then delete the last node.",
  deleteConfirm: "Delete this node?",
  deleteConfirmApplied: "Deleting the applied node unapplies it: the core can no longer start and the proxy rules are removed.",
  cancel: "Cancel", deleted: "Deleted",
  edit: "Edit", done: "Done",
  checkAll: "Select all", uncheckAll: "Deselect all",
  batchDelete: "Delete", deleteConfirmN: "Delete {n} node(s)?",
  deleteConfirmNApplied: "Deleting these nodes unapplies the applied one: the core can no longer start and the proxy rules are removed.",
  deletedN: "Deleted {n} node(s)",
  editHint: "Check the nodes to delete, then tap Delete; the applied node can only be deleted when the core is stopped and it is the last node.",
  tabStatus: "Status", tabNodes: "Nodes", tabLog: "Log", tabSettings: "Settings", navLabel: "Sections",
  setGeneral: "General",
  setTheme: "Theme", themeAuto: "Auto", themeLight: "Light", themeDark: "Dark",
  setLang: "Language", langAuto: "Auto",
  setLog: "Log buffer",
  setLogLevel: "Log level",
  logLevelNone: "None", logLevelError: "Error", logLevelWarning: "Warning",
  logLevelInfo: "Info", logLevelDebug: "Debug",
  logLevelToast: "The log level applies at the next core start",
  logLevelPending: "Saved; stop and start the core to apply.",
  setPorts: "Inbound ports",
  setPortsHint: "The ports the local socks/http inbounds listen on, at 127.0.0.1. Saving rewrites the core config; a running core restarts.",
  portRange: "Ports must be integers between 1 and 65535",
  portSame: "The SOCKS and HTTP ports must differ",
  portTp: "That port is reserved for the tproxy inbound (10810); pick another",
  portsSaving: "Applying ports…", portsSaved: "Ports applied",
  portsSave: "Save",
  setRouteMode: "Routing mode",
  routeGlobal: "Global", routeCn: "Direct-CN", routeCnAdblock: "Direct-CN-Adblock",
  routeCnNoGeodata: "Geo data is missing (bin/geosite.dat, geoip.dat): Direct-CN renders as Global until the files are back.",
  routeGeoMissing: "geo data missing",
  routeSwitching: "Switching routing mode…",
  addTitle: "Add node",
  addPlaceholder: "vless://…",
  close: "Close",
  importBtn: "Import",
  lineNo: "line ", lineNoEnd: "",
  importEmpty: "No importable node in the input",
  importDone: "Imported",
  importUpdated: ", updated",
  importFailedN: ", {n} line(s) failed",
  notAppliedYet: "Importing only fills the node list; with no node applied yet it also applies one, otherwise open a node's dialog and press Apply."
};
var T = DICT_EN; // applyLang() 会在任何渲染之前重新给它赋值

var $ = function (id) { return document.getElementById(id); };
var els = {
  banner: $("banner"), badge: $("badge"), start: $("start"), stop: $("stop"),
  hint: $("hint"), pid: $("v-pid"), up: $("v-up"), port: $("v-port"),
  conf: $("v-conf"), log: $("log"), follow: $("follow"),
  logTabCore: $("logtab-core"), logTabModule: $("logtab-module"),
  logNav: $("lognav"), logTop: $("log-top"), logBottom: $("log-bottom"),
  clearLog: $("clear-log"),
  refresh: $("refresh"), pause: $("pause"), toast: $("toast"),
  lPid: $("l-pid"), lUp: $("l-up"), lPort: $("l-port"),
  lConf: $("l-conf"), lFollow: $("l-follow"), lPause: $("l-pause"),
  addNode: $("add-node"),
  nList: $("n-list"), nHint: $("n-hint"), lList: $("l-nodes"),
  editNode: $("edit-node"), nToolbar: $("n-toolbar"),
  lImport: $("l-import"), iText: $("i-text"),
  iApply: $("i-apply"), iPreview: $("i-preview"), iHint: $("i-hint"),
  overlay: $("add-overlay"), addClose: $("add-close"), tabbar: $("tabbar"),
  nodeOverlay: $("node-overlay"), ndTitle: $("nd-title"), ndPills: $("nd-pills"),
  ndInfo: $("nd-info"), ndCredSection: $("nd-cred-section"), ndCredTitle: $("nd-cred-title"),
  ndCred: $("nd-cred"), ndHint: $("nd-hint"), ndCopyHint: $("nd-copyhint"),
  ndError: $("nd-error"), ndCopyGroup: $("nd-copygroup"), ndCopy: $("nd-copy"),
  ndCopyMenu: $("nd-copy-menu"), ndMenu: $("nd-menu"),
  ndMenuBase64: $("nd-menu-base64"), ndApply: $("nd-apply"), ndClose: $("nd-close"),
  lTabStatus: $("l-tab-status"), lTabNodes: $("l-tab-nodes"), lTabLog: $("l-tab-log"),
  lTabSettings: $("l-tab-settings"),
  selLang: $("sel-lang"), lSetLang: $("l-set-lang"), lLangAuto: $("l-lang-auto"),
  lSetGeneral: $("l-set-general"),
  selTheme: $("sel-theme"), lSetTheme: $("l-set-theme"),
  lThemeAuto: $("l-theme-auto"), lThemeLight: $("l-theme-light"), lThemeDark: $("l-theme-dark"),
  selLog: $("sel-log"), lSetLog: $("l-set-log"),
  selLogLevel: $("sel-loglevel"), lSetLogLevel: $("l-set-loglevel"),
  lLogLevelNone: $("l-loglevel-none"), lLogLevelError: $("l-loglevel-error"),
  lLogLevelWarning: $("l-loglevel-warning"), lLogLevelInfo: $("l-loglevel-info"),
  lLogLevelDebug: $("l-loglevel-debug"), setLogLevelHint: $("set-loglevel-hint"),
  iSocks: $("i-socks"), iHttp: $("i-http"), portsSave: $("ports-save"),
  lSetPorts: $("l-set-ports"), lSetPortsHint: $("l-set-ports-hint"),
  lSetRouteMode: $("l-set-route-mode"),
  selRoute: $("sel-route"), lRouteGlobal: $("l-route-global"), lRouteCn: $("l-route-cn"),
  lRouteCnAdblock: $("l-route-cnadblock"),
  setRouteHint: $("set-route-hint"),
  tpCard: $("tp-card"), tpHint: $("tp-hint"), tpRetry: $("tp-retry")
};
var tabs = [].slice.call(document.querySelectorAll(".tab"));
var pages = {
  status: $("page-status"), nodes: $("page-nodes"),
  log: $("page-log"), settings: $("page-settings")
};

var hasBridge = typeof window.ksu !== "undefined" && typeof window.ksu.exec === "function";
// 页面显示哪份日志："core"（xray.log）或 "module"（kernelray.log）。
// 这是页面选择、不是偏好：它从不持久化，所以每次访问都从核心日志开始。
var logSource = "core";
// 每个来源各缓存一份 tail：只有同一来源重复时 renderLog 才跳过。
var lastLog = { core: null, module: null };
// 上次拉取 tail 时的字节大小；大小不变时轮询就跳过拉取。
var lastLogSize = { core: -1, module: -1 };
// 由清空日志递增：文件被截断时仍在途的一段 tail，绝不能把它那
// 陈旧文本渲染到已清空的视图上。
var logGen = { core: 0, module: 0 };
var lastState = "unknown";
var busy = false;
var clearBusy = false; // 清空日志自己执行一次 exec；busy 只用于核心动作
var pending = null; // 动作在途期间为 "start" | "stop"
var lastStateObj = null;
var lastKv = null;
var lastApplied = "";
var lastMetaId = "";
var confirmId = null;
// 节点详情弹窗：点按行以只读方式打开；只有它的应用按钮会切换节点。
var dialogId = "";        // 弹窗显示的节点 id；关闭时为 ""
var dialogBusy = false;   // 从弹窗发起的一次应用正在进行
var dialogError = "";     // 弹窗上一次应用失败的信息，行内显示
var dialogMenuOpen = false;
var dialogLink = "";      // 为当前节点渲染出的规范链接
var listSig = "";
// 弹窗上次渲染的内容：没有变化时 2s 轮询绝不能重建它。
var dialogSig = "";
// 当前列表渲染所依据的运行状态事实：只有它翻转时 renderStatus 才重绘列表，
// 这样 2s 轮询就不会在手指底下重建工具栏。
var listRunning = null;
// 编辑模式的勾选集合：批量删除会移除哪些行。只存在内存中——勾选是
// 临时意图，不是像 `selected` 那样的愿望——编辑模式结束时清空。
var editMode = false;
var checkSet = {};
var batchConfirm = false;
// 自上次同步以来用户碰过的端口字段：2s 轮询不能把用户正在填写另一个
// 字段时改过的值重置掉。保存成功后清空，
// 离开设置页时也清空。
var portsDirty = { socks: false, http: false };

// 清空日志按钮的名字指明它将截断哪份日志。该选择由标签页持有，
// 因此切换语言和切换标签页都会重新读到同一个标签。
function clearLogLabel() {
  return logSource === "module" ? T.clearModuleLog : T.clearCoreLog;
}

function label(key) {
  els.start.textContent = T.start;
  els.stop.textContent = T.stop;
  els.refresh.textContent = T.refresh;
  els.lFollow.textContent = T.follow;
  els.lPause.textContent = T.pause;
  els.logTabCore.textContent = T.logTabCore;
  els.logTabModule.textContent = T.logTabModule;
  els.clearLog.textContent = clearLogLabel();
  els.lPid.textContent = T.pid;
  els.lUp.textContent = T.up;
  els.lPort.textContent = T.port;
  els.lConf.textContent = T.conf;
  els.lList.textContent = T.listTitle;
  els.editNode.textContent = editMode ? T.done : T.edit;
  els.addNode.setAttribute("aria-label", T.addTitle);
  els.addClose.setAttribute("aria-label", T.close);
  els.ndClose.setAttribute("aria-label", T.close);
  els.ndCopy.textContent = T.copyLink;
  els.ndCopyMenu.setAttribute("aria-label", T.copyOptions);
  els.ndMenuBase64.textContent = T.copyBase64;
  els.ndCredTitle.textContent = T.credentials;
  els.lImport.textContent = T.addTitle;
  els.iApply.textContent = T.importBtn;
  els.iText.placeholder = T.addPlaceholder;
  els.iHint.textContent = T.notAppliedYet;
  els.lTabStatus.textContent = T.tabStatus;
  els.lTabNodes.textContent = T.tabNodes;
  els.lTabLog.textContent = T.tabLog;
  els.lTabSettings.textContent = T.tabSettings;
  els.lSetGeneral.textContent = T.setGeneral;
  els.lSetTheme.textContent = T.setTheme;
  els.lThemeAuto.textContent = T.themeAuto;
  els.lThemeLight.textContent = T.themeLight;
  els.lThemeDark.textContent = T.themeDark;
  els.lSetLang.textContent = T.setLang;
  els.lLangAuto.textContent = T.langAuto;
  els.lSetLog.textContent = T.setLog;
  els.lSetLogLevel.textContent = T.setLogLevel;
  els.lLogLevelNone.textContent = T.logLevelNone;
  els.lLogLevelError.textContent = T.logLevelError;
  els.lLogLevelWarning.textContent = T.logLevelWarning;
  els.lLogLevelInfo.textContent = T.logLevelInfo;
  els.lLogLevelDebug.textContent = T.logLevelDebug;
  els.setLogLevelHint.textContent = T.logLevelPending;
  els.lSetPorts.textContent = T.setPorts;
  els.lSetPortsHint.textContent = T.setPortsHint;
  els.portsSave.textContent = T.portsSave;
  els.lSetRouteMode.textContent = T.setRouteMode;
  els.lRouteGlobal.textContent = T.routeGlobal;
  els.lRouteCn.textContent = T.routeCn;
  els.lRouteCnAdblock.textContent = T.routeCnAdblock;
  els.tpRetry.textContent = T.tpRetry;
  els.tabbar.setAttribute("aria-label", T.navLabel);
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.className = "toast show";
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { els.toast.className = "toast"; }, 2600);
}

// 受限的 WebView 里 localStorage 本身也可能抛错；偏好退化为仅本次会话有效。
function prefsStore() {
  try { return window.localStorage; } catch (e) { return null; }
}

function resolveLang() {
  if (langPref === "zh" || langPref === "en") { return langPref; }
  return (navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
}

// 切换语言必须让旧语言下渲染出的内容失效：节点列表的签名不包含语言，
// 而 renderLog 会跳过未变化的文本。
function applyLang() {
  var lang = resolveLang();
  T = lang === "zh" ? DICT_ZH : DICT_EN;
  document.documentElement.lang = lang;
  label();
  renderPrefs();
  listSig = "";
  dialogSig = "";
  renderNodeList();
  els.iHint.textContent = T.notAppliedYet;
  els.iHint.className = "nodehint";
  lastLog.core = lastLog.module = null;
  renderLog("");
  if (!hasBridge) {
    els.banner.textContent = T.noBridge;
    els.badge.textContent = T.unknown;
  }
}

// 下拉框直接按偏好渲染：切换语言会重新给 T 赋值，并改变自动选项的
// 标签，所以两者都要经过这里。
function renderPrefs() {
  els.selTheme.value = themePref;
  els.selLang.value = langPref;
  els.selLog.value = String(logLines);
}

// 桥接的 ksu.exec 是回调式的：ksu.exec(cmd, optionsJson, callbackName)，
// 注入的 WebView 会调用 window[callbackName](errno, stdout, stderr)。
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
// 主题、语言和日志行数是 UI 偏好，不是意图：state.json 的 `settings`
// 对象保存入站端口，分流模式则是 shell 自己的偏好（docs/state-schema.md）；
// 两者反正每次模块升级都会被清掉，所以它们放在 WebView 的 localStorage 里，
// 当管理器提供的 WebView 禁用了存储时退化为仅本次会话有效。
// 本块由 tests/prefs.test.js 运行。
//
// 主题自身的模型（合法取值、"auto" 的解析、应用）在 theme.js 里，
// 它由 <head> 在本文件之前加载：一个键、一个校验器，首屏绘制就已经正确。

var PREFS_KEY = KRTheme.PREFS_KEY;
var LANGS = ["auto", "zh", "en"];
var THEMES = KRTheme.THEMES;
var LOG_LINE_STEPS = [100, 200, 500];

function prefsNormalize(raw) {
  var p = { theme: "auto", lang: "auto", logLines: 200 };
  if (!raw || typeof raw !== "object") { return p; }
  p.theme = KRTheme.themeNormalize(raw.theme);
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
    store.setItem(PREFS_KEY, JSON.stringify({ v: 1, theme: p.theme, lang: p.lang, logLines: p.logLines }));
  } catch (e) { /* 没有存储：该选择仅在本次会话内有效 */ }
}
// ---- end UI preferences ----

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
  // 没有已应用节点就不启动：shell 的启动闸门本来也会拒绝（ADR 0010）。
  els.start.disabled = busy || running || !(lastKv && lastKv.node);
  els.stop.disabled = busy || !running;
  els.clearLog.disabled = busy || clearBusy || !hasBridge;
  els.start.textContent = busy && pending === "start" ? T.startingMsg : T.start;
  els.stop.textContent = busy && pending === "stop" ? T.stoppingMsg : T.stop;
  els.iSocks.disabled = !hasBridge;
  els.iHttp.disabled = !hasBridge;
  els.portsSave.disabled = busy || !hasBridge;
  if (els.nList) { els.nList.classList.toggle("busy", busy); }
  if (dialogId) { renderDialog(); }
}

// 删除门槛与取消应用决策都需要实时事实，且只有状态读出来是 "stopped"
// 才能证明核心已停：未知或读不出的状态一律按运行中处理。
function coreRunning() {
  return !(lastKv && lastKv.state === "stopped");
}

// 已应用行拒绝删除的原因：列表里还有别的节点就不是死路（先切换再删除）；
// 核心正在运行才是。
function deleteRefusal(model) {
  return model.rows.length > 1 ? T.deleteApplied : T.deleteRunning;
}

// 编辑模式只有在删除门槛允许时才能勾选已应用行，这样批量删除与行上的 ✕
// 保持一致。
function canCheckNode(node) {
  if (!(lastApplied && lastApplied === node.id)) { return true; }
  return deleteGate(nodeListModel(lastStateObj, lastApplied), coreRunning());
}

function findNodeById(state, id) {
  if (!state || !id || !Array.isArray(state.manual)) { return null; }
  for (var i = 0; i < state.manual.length; i++) {
    var n = state.manual[i];
    if (n && String(n.id) === String(id)) { return n; }
  }
  return null;
}

// 存储的 IPv6 地址不带方括号（Xray 要求如此），显示时必须补回去，
// 否则 "2001:db8::1:443" 根本没法读。
function hostPort(n) {
  var a = String(n.address || "");
  if (a.indexOf(":") >= 0) { a = "[" + a + "]"; }
  return a + (n.port ? ":" + n.port : "");
}

// ---- node list model ----
// 由 state.json 与 runtime/applied 推导出节点页显示的行。纯函数、无 DOM，
// 使 tests/nodelist.test.js 无需浏览器即可运行。本版本不涉及订阅节点：
// 列表只渲染手工节点库。
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
    // 点按已应用节点不会动核心，除非重新导入改动了它的字段。
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

// 删除门槛：已应用节点只有在核心已停止、且它是最后一行时才可删除，
// 这样删除会清空节点库。行的 ✕ 与编辑模式批量删除共用一条规则。
// `running` 表示"无法证明确已停止"：调用方把读不出的状态算作运行中，
// 因此删除绝不会与刚启动的核心竞态。
function deleteGate(model, running) {
  return !running && model.rows.length === 1 && model.rows[0].applied;
}

// 删除 `ids` 时是否还要取消应用（移除 config.json、runtime/applied、渲染出的
// 出站和接管规则）。触发条件是删除后的状态，而不是被删的那一行：
// 核心已停止且列表被清空时已经无处可运行；悬空的已应用 id（没有
// 对应行的 id）否则会把凭证留在 config.json 里，而启动闸门仍会
// 让下次启动带着它运行（ADR 0013）。
function emptiesList(model, ids) {
  if (model.rows.length === 0) { return false; }
  var gone = {};
  ids.forEach(function (id) { gone[id] = true; });
  for (var i = 0; i < model.rows.length; i++) {
    if (!gone[model.rows[i].id]) { return false; }
  }
  return true;
}

function willUnapply(model, ids, running) {
  return !running && emptiesList(model, ids);
}

// 编辑模式的勾选集合 → 批量删除可以作用于哪些行。纯函数，便于
// 让 tests/nodelist.test.js 无需浏览器运行；只有调用方的删除门槛允许时，
// 已应用行才加入（✕ 在完全相同的情形下拒绝），已没有对应行的勾选 id
// （刷新后的陈旧集合）直接忽略。
function batchModel(model, checks, allowApplied) {
  var set = checks || {};
  var checkable = [];
  var checked = [];
  for (var i = 0; i < model.rows.length; i++) {
    var row = model.rows[i];
    if (row.applied && !allowApplied) { continue; }
    checkable.push(row.id);
    if (set[row.id]) { checked.push(row.id); }
  }
  return {
    checkableIds: checkable, checkedIds: checked,
    allChecked: checkable.length > 0 && checked.length === checkable.length
  };
}
// 节点详情弹窗的按钮状态：已应用且干净是唯一无操作的点按（切换失败后
// 它仍可能重新同步 `selected`）；已应用但有改动则重新应用，当前节点却
// 未应用则是重试。纯函数，便于 tests/nodelist.test.js 运行。
function nodeDialogModel(node, appliedId, selectedId) {
  var id = node && node.id !== null && node.id !== undefined ? String(node.id) : "";
  var applied = id !== "" && appliedId !== null && appliedId !== undefined &&
    String(appliedId) !== "" && id === String(appliedId);
  var selected = id !== "" && selectedId !== null && selectedId !== undefined &&
    String(selectedId) !== "" && id === String(selectedId);
  var dirty = !!(node && node.dirty);
  var action = "apply";
  if (applied && dirty) { action = "reapply"; }
  else if (selected && !applied) { action = "retry"; }
  return {
    id: id, applied: applied, selected: selected, dirty: dirty,
    action: action, noop: applied && !dirty
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

// 每一行都用 createElement/textContent 构建：节点名来自导入的链接，
// 绝不能进入 innerHTML。
function renderRow(row, allowDelete) {
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
    q.textContent = row.applied ? T.deleteConfirmApplied : T.deleteConfirm;
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
    // 编辑模式下整行都是勾选开关；已应用行的复选框遵循与 ✕ 相同的
    // 删除门槛。节点详情弹窗只在编辑模式之外打开。
    var check = document.createElement("input");
    check.type = "checkbox";
    check.className = "ncheck";
    check.setAttribute("data-action", "check");
    check.setAttribute("aria-label", row.node.name || row.id);
    // 门槛关闭前留下的勾选（核心在别处启动了）不能显示为已勾选，
    // 因为该复选框现已禁用；batchModel 无论如何都会忽略它。
    check.checked = !!checkSet[row.id] && !(row.applied && !allowDelete);
    if (row.applied && !allowDelete) { check.disabled = true; }
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
  del.className = "ndel" + (row.applied && !allowDelete ? " muted" : "");
  del.setAttribute("data-action", "delete");
  del.setAttribute("aria-label", T.delete);
  del.textContent = "✕";
  el.appendChild(del);
  return el;
}

// 编辑模式工具栏：全选、批量删除以及行内确认。与每一行一样，
// 它用 createElement/textContent 构建；数量取自勾选集合。
function renderBatchBar(model, bm, unapplies) {
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
    q.textContent = (unapplies ? T.deleteConfirmNApplied : T.deleteConfirmN)
      .replace("{n}", String(bm.checkedIds.length));
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
  var running = coreRunning();
  listRunning = running;
  var gate = deleteGate(model, running);
  var bm = batchModel(model, checkSet, gate);
  // 门槛跟随运行状态，所以停止/启动也必须让列表失效重绘。
  var sig = [String(state && state.schema), lastApplied, confirmId || "",
    editMode ? "edit" : "", batchConfirm ? "batch" : "", gate ? "gate" : ""];
  bm.checkedIds.forEach(function (id) { sig.push(id); });
  model.rows.forEach(function (row) { sig.push(rowSig(row)); });
  var signature = sig.join("\n");
  if (signature !== listSig) {
    listSig = signature;
    els.nList.textContent = "";
    model.rows.forEach(function (row) { els.nList.appendChild(renderRow(row, gate)); });
    if (model.empty) {
      // 空列表也必须提供能填满它的手势，而不只是卡片标题里的 +：
      // 初次使用的用户会看向页面中间。
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "primary nempty";
      addBtn.setAttribute("data-action", "add");
      addBtn.textContent = T.addTitle;
      els.nList.appendChild(addBtn);
    }
  }
  renderBatchBar(model, bm, willUnapply(model, bm.checkedIds, running));
  els.editNode.textContent = editMode ? T.done : T.edit;
  els.editNode.disabled = busy || model.empty;
  var hint = listHint(model, state);
  els.nHint.textContent = hint.text;
  els.nHint.className = "nodehint" + (hint.cls ? " " + hint.cls : "");
  if (els.nList) { els.nList.classList.toggle("busy", busy); }
  if (dialogId) { renderDialog(); }
}

// 先写 selected，再写 outbound.meta/outbound.json/CLI：这样崩溃或应用失败
// 留下的是诚实的"selected B, applied A"状态，而不是比指针更新的配置。
function writeSelected(id) {
  if (!lastStateObj || lastStateObj.selected === id) { return Promise.resolve(false); }
  lastStateObj.selected = id;
  lastStateObj.revision = (Number(lastStateObj.revision) || 0) + 1;
  return writeState(lastStateObj).then(function () { return true; });
}

function switchTo(n, opts) {
  opts = opts || {};
  var done = typeof opts.done === "function" ? opts.done : null;
  function finish(err) {
    if (!done) { return; }
    try { done(err || null); } catch (e) { /* 弹窗回调不能中断应用链路 */ }
  }
  function fail(msg) {
    if (!opts.fromDialog) { toast(msg); }
    finish(new Error(msg));
  }
  if (busy || !hasBridge) { finish(new Error(T.actionFailed)); return; }
  if (!lastStateObj) { fail(T.nodeNoState); return; }
  if (lastStateObj.schema && lastStateObj.schema !== 1) {
    fail(T.nodeSchema + lastStateObj.schema);
    return;
  }
  if (!n || !n.id || !/^[0-9A-Za-z_-]+$/.test(n.id)) {
    fail(T.actionFailed + ": node has no usable id");
    return;
  }

  // 已经是已应用节点：无需动核心。切换失败时 selected 仍可能指向这里。
  if (lastApplied && lastApplied === n.id && !n.dirty) {
    busy = true;
    setButtons();
    renderNodeList();
    writeSelected(n.id).then(function () {
      if (opts.fromDialog) { toast(T.appliedMsg); }
      finish(null);
    }).catch(function (e) {
      if (!opts.fromDialog) { toast(T.actionFailed + ": " + e.message); }
      finish(e);
    }).then(function () {
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
    fail(T.actionFailed + ": " + e.message);
    return;
  }

  confirmId = null;
  busy = true;
  setButtons();
  renderNodeList();
  if (!opts.fromDialog) { toast(T.applyingMsg); }

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
      // 只有当节点仍渲染出与刚应用时完全相同的出站，才清除该标记；
      // 更新的编辑必须继续保持未应用标记。
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
    finish(null);
  }).catch(function (e) {
    if (!opts.fromDialog) { toast(T.actionFailed + ": " + e.message); }
    finish(e);
  }).then(function () {
    busy = false;
    setButtons();
    refreshPage();
  });
}

// ---- node detail dialog ----
// 点按行以只读方式打开它：显示节点字段与规范链接，但只有应用按钮
// 会写 `selected` 或触碰核心。与添加弹窗一样，它不持有路由或
// 历史记录条目。

function currentDialogNode() {
  return dialogId ? findNodeById(lastStateObj, dialogId) : null;
}

// 打开弹窗必须冻结背后的页面：否则遮罩上的触摸滚动会拖动底下的节点列表。
// 用 body.dialog-open（CSS）隐藏溢出；这个类还能保留滚动位置，
// 不像重置 body scrollTop 那样。
function syncDialogScrollLock() {
  document.body.classList.toggle("dialog-open",
    Boolean(dialogId || !els.overlay.hidden));
}

function openNodeDialog(n) {
  if (dialogId || dialogBusy || busy || !hasBridge || !lastStateObj || editMode || confirmId ||
      !els.overlay.hidden) {
    return;
  }
  if (!n || !n.id) { return; }
  dialogId = String(n.id);
  dialogBusy = false;
  dialogError = "";
  dialogMenuOpen = false;
  dialogLink = "";
  dialogSig = "";
  els.nodeOverlay.hidden = false;
  syncDialogScrollLock();
  renderDialog();
  if (els.ndClose && els.ndClose.focus) { els.ndClose.focus(); }
}

function closeNodeDialog() {
  if (dialogBusy) { return; }
  var id = dialogId;
  dialogId = "";
  dialogBusy = false;
  dialogError = "";
  dialogMenuOpen = false;
  dialogLink = "";
  els.nodeOverlay.hidden = true;
  syncDialogScrollLock();
  if (!id) { return; }
  var rows = els.nList.querySelectorAll(".nrow");
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute("data-id") === id) {
      if (rows[i].focus) { rows[i].focus(); }
      return;
    }
  }
}

function addInfoRow(dl, key, val) {
  if (val === null || val === undefined || String(val) === "") { return; }
  var dt = document.createElement("dt");
  dt.textContent = key;
  var dd = document.createElement("dd");
  dd.textContent = String(val);
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function renderDialog() {
  if (!dialogId) { return; }
  var node = currentDialogNode();
  if (!node) {
    if (dialogBusy) {
      els.ndError.textContent = T.nodeGone;
      els.ndError.hidden = false;
      els.ndApply.disabled = true;
      els.ndCopy.disabled = true;
      els.ndCopyMenu.disabled = true;
      dialogLink = "";
      dialogMenuOpen = false;
      els.ndMenu.hidden = true;
      return;
    }
    closeNodeDialog();
    toast(T.nodeGone);
    return;
  }

  var selectedId = lastStateObj && typeof lastStateObj.selected === "string"
    ? lastStateObj.selected : "";
  var model = nodeDialogModel(node, lastApplied, selectedId);
  // 每次 2s 轮询，renderNodeList 与 setButtons 都会走到这里。只在弹窗
  // 展示的某个事实变化时才重绘；切换语言会重置 dialogSig。
  var sig = [
    String(node.id), JSON.stringify(node), lastApplied || "", selectedId,
    model.applied ? 1 : 0, model.selected ? 1 : 0, model.dirty ? 1 : 0,
    model.action, model.noop ? 1 : 0,
    lastKv && lastKv.state ? lastKv.state : "",
    dialogBusy ? 1 : 0, busy ? 1 : 0, dialogError || "", dialogMenuOpen ? 1 : 0
  ].join("\n");
  if (sig === dialogSig) { return; }
  dialogSig = sig;

  els.ndTitle.textContent = node.name || node.protocol || "node";

  els.ndPills.textContent = "";
  if (model.applied) { els.ndPills.appendChild(pill(T.nodeApplied, "ok")); }
  else if (model.selected) { els.ndPills.appendChild(pill(T.nodePending, "warn")); }
  if (model.dirty) { els.ndPills.appendChild(pill(T.nodeDirty, "warn")); }

  els.ndInfo.textContent = "";
  addInfoRow(els.ndInfo, T.fieldProtocol, node.protocol);
  // 在 ss 的链接模型里没有传输/安全字段；显示默认值等于凭空造出字段。
  if (node.protocol !== "ss") {
    addInfoRow(els.ndInfo, T.fieldTransport, node.transport || "tcp");
    addInfoRow(els.ndInfo, T.fieldSecurity, node.security || "none");
  }
  addInfoRow(els.ndInfo, T.fieldAddress, hostPort(node));
  addInfoRow(els.ndInfo, T.fieldSni, node.sni);
  addInfoRow(els.ndInfo, T.fieldHost, node.host);
  addInfoRow(els.ndInfo, T.fieldPath, node.path);
  addInfoRow(els.ndInfo, T.fieldServiceName, node.serviceName);
  addInfoRow(els.ndInfo, T.fieldFingerprint, node.fingerprint);
  addInfoRow(els.ndInfo, T.fieldFlow, node.flow);
  addInfoRow(els.ndInfo, T.fieldAlpn, alpnValue(node));
  addInfoRow(els.ndInfo, T.fieldPublicKey, node.publicKey);
  addInfoRow(els.ndInfo, T.fieldShortId, node.shortId);
  if (node.allowInsecure !== undefined && node.allowInsecure !== null) {
    addInfoRow(els.ndInfo, T.fieldAllowInsecure, node.allowInsecure ? T.yes : T.no);
  }

  els.ndCred.textContent = "";
  if (node.protocol === "vless" || node.protocol === "vmess") {
    addInfoRow(els.ndCred, T.fieldUuid, node.uuid);
  }
  if (node.protocol === "vless") {
    addInfoRow(els.ndCred, T.fieldEncryption, node.encryption || "none");
  }
  if (node.protocol === "vmess") {
    addInfoRow(els.ndCred, T.fieldAlterId, node.alterId !== undefined ? node.alterId : 0);
    addInfoRow(els.ndCred, T.fieldCipher, node.cipher || "auto");
  }
  if (node.protocol === "trojan" || node.protocol === "ss") {
    addInfoRow(els.ndCred, T.fieldPassword, node.password);
  }
  if (node.protocol === "ss") {
    addInfoRow(els.ndCred, T.fieldMethod, node.method);
  }
  els.ndCredSection.hidden = els.ndCred.childNodes.length === 0;

  var link = "";
  var linkErr = "";
  try { link = linkOf(node); } catch (e) { linkErr = e.message || String(e); }
  dialogLink = link;
  if (!link) { dialogMenuOpen = false; }
  els.ndCopy.disabled = !link;
  els.ndCopyMenu.disabled = !link;
  if (linkErr) {
    els.ndCopyHint.textContent = T.linkError + ": " + linkErr;
    els.ndCopyHint.className = "nodehint warn";
  } else {
    els.ndCopyHint.textContent = T.copyIncludesCreds;
    els.ndCopyHint.className = "nodehint";
  }

  var hint;
  if (model.noop) { hint = T.dialogAppliedHint; }
  else if (model.action === "retry") { hint = T.dialogRetryHint; }
  else if (lastKv && lastKv.state === "running") { hint = T.dialogRunningHint; }
  else { hint = T.dialogStoppedHint; }
  els.ndHint.textContent = hint;

  if (dialogError) {
    els.ndError.textContent = dialogError;
    els.ndError.hidden = false;
  } else {
    els.ndError.textContent = "";
    els.ndError.hidden = true;
  }

  var label = model.action === "reapply" ? T.reapply
    : model.action === "retry" ? T.retryApply : T.apply;
  els.ndApply.textContent = dialogBusy ? T.applyingMsg : label;
  els.ndApply.disabled = dialogBusy || busy;
  els.ndClose.disabled = dialogBusy;

  els.ndMenu.hidden = !dialogMenuOpen;
  els.ndCopyMenu.setAttribute("aria-expanded", dialogMenuOpen ? "true" : "false");
}

function applyFromDialog() {
  var node = currentDialogNode();
  if (!node || dialogBusy || busy) { return; }
  dialogBusy = true;
  dialogError = "";
  dialogMenuOpen = false;
  renderDialog();
  try {
    switchTo(node, {
      fromDialog: true,
      done: function (err) {
        dialogBusy = false;
        if (err) {
          dialogError = err.message || String(err);
          renderDialog();
        } else {
          closeNodeDialog();
        }
      }
    });
  } catch (e) {
    dialogBusy = false;
    dialogError = e.message || String(e);
    renderDialog();
  }
}

function toggleDialogMenu() {
  if (!dialogId || !dialogLink) { return; }
  dialogMenuOpen = !dialogMenuOpen;
  renderDialog();
}

function legacyCopy(text) {
  return new Promise(function (resolve, reject) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    var active = document.activeElement;
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand("copy");
    } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (active && active.focus) { active.focus(); }
    if (ok) { resolve(); } else { reject(new Error("copy failed")); }
  });
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var p = navigator.clipboard.writeText(text);
      if (p && typeof p.then === "function") {
        return p.catch(function () { return legacyCopy(text); });
      }
    }
  } catch (e) { /* 继续走 textarea 的回退路径 */ }
  return legacyCopy(text);
}

function copyDialogLink(kind) {
  var link = dialogLink;
  if (!link) { toast(T.copyFailed); return; }
  var text = link;
  if (kind === "base64") {
    try { text = base64Link(link); } catch (e) {
      toast(T.copyFailed + ": " + (e.message || e));
      return;
    }
  }
  copyText(text).then(function () {
    toast(kind === "base64" ? T.copiedBase64 : T.copiedLink);
    dialogMenuOpen = false;
    if (dialogId) { renderDialog(); }
  }).catch(function (e) {
    toast(T.copyFailed + ": " + (e.message || e));
  });
}
// ---- end node detail dialog ----

function askDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var model = nodeListModel(lastStateObj, lastApplied);
  if (lastApplied && lastApplied === n.id && !deleteGate(model, coreRunning())) {
    toast(deleteRefusal(model));
    return;
  }
  confirmId = n.id;
  renderNodeList();
}

// 单个或多个 id 共用一条删除路径：过滤手工节点库，若被删节点是当前节点
// 就清掉 selected 指针，渲染出的出站若属于被删节点就丢弃，然后持久化。
// 先执行 rm 再写入：rm 失败必须让节点留在库里，以便删除可以重试。
// 核心已停止时清空列表的删除就是一次取消应用（ADR 0013），出于同样
// 的原因它也最先执行。
function deleteNodes(ids) {
  var state = lastStateObj;
  var unapply = willUnapply(nodeListModel(state, lastApplied), ids, coreRunning());
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
  var chain;
  if (unapply) {
    chain = exec(CLI + " unapply").then(function (r) {
      if (r.errno !== 0) { throw new Error((r.stderr || "").trim() || ("exit " + r.errno)); }
      lastApplied = "";
      lastMetaId = "";
    });
  } else {
    var removeRendered = lastMetaId && gone[lastMetaId];
    chain = removeRendered ? exec("rm -f " + OUTBOUND + " " + OUTBOUND_META).then(function (r) {
      if (r.errno !== 0) { throw new Error((r.stderr || "").trim() || ("exit " + r.errno)); }
      lastMetaId = "";
    }) : Promise.resolve();
  }
  return chain.then(function () {
    return writeState(state).then(function () {
      logNodeLine("deleted " + ids.length + " nodes");
    });
  });
}

function confirmDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var model = nodeListModel(lastStateObj, lastApplied);
  if (lastApplied && lastApplied === n.id && !deleteGate(model, coreRunning())) {
    confirmId = null;
    renderNodeList();
    toast(deleteRefusal(model));
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
  var model = nodeListModel(lastStateObj, lastApplied);
  var gate = deleteGate(model, coreRunning());
  var ids = batchModel(model, checkSet, gate).checkedIds;
  if (ids.length === 0) {
    batchConfirm = false;
    renderNodeList();
    return;
  }
  // 除非门槛允许，勾选集合里不会有已应用行；但勾选与确认之间的一次
  // 刷新也不能让它混进来。
  if (!gate && lastApplied && ids.indexOf(lastApplied) >= 0) {
    batchConfirm = false;
    renderNodeList();
    toast(deleteRefusal(model));
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

// 意图写在 state.json；runtime/applied 指向当前配置由之生成的节点。
// 一次 exec 里同时读取状态、已应用 id 与渲染出站的 meta；切换失败后列表必须
// 显示"已选中未应用"，而不是假装已经切换成功。
// 状态轮询带着 state revision、已应用 id 和 meta id：三者都没动时，
// 整个文件已经在 lastStateObj 里，无需再读、也无需重绘。
function refreshNodes(kv) {
  var known = lastStateObj;
  if (kv && known && kv.revision !== undefined && known.revision !== undefined &&
      String(kv.revision) === String(known.revision) &&
      String(kv.node || "") === String(lastApplied || "") &&
      String(kv.meta || "") === String(lastMetaId || "")) {
    return Promise.resolve();
  }
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

// ---- import switch rule ----

// 只有存在已应用节点，一次导入之后节点库才是可用的；首次导入正是用户
// 希望刚粘贴的节点跑起来的时刻。要切换到的节点是已设好且仍能解析的指针
// （切换失败会把它留在那里），否则取列表能显示的第一个节点。
// "" 表示"什么都不切换"：已经有已应用节点。纯函数，便于导入测试
// 在无需浏览器的情况下运行。
function applyAfterImport(state, appliedId) {
  if (appliedId) { return ""; }
  var manual = state && Array.isArray(state.manual) ? state.manual : [];
  var selected = state && typeof state.selected === "string" ? state.selected : "";
  var first = "";
  for (var i = 0; i < manual.length; i++) {
    var n = manual[i];
    // 与 nodeListModel 相同的过滤：没有 id 的节点没有可标记为已应用的行。
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") {
      continue;
    }
    var id = String(n.id);
    if (first === "") { first = id; }
    if (selected !== "" && id === selected) { return id; }
  }
  return first;
}

// ---- end import switch rule ----

// ---- node import UI ----

// 重新导入会原地更新节点并保留其 id，因此当前节点与所有指向它的引用
// 都能存活；只有真正新的身份才追加。对节点库建一份索引，
// 使导入 N 个节点是 O(N)，而不是每节点都扫一遍列表。
function mergeNodes(state, nodes) {
  if (!state.schema) { state.schema = 1; }
  if (!Array.isArray(state.manual)) { state.manual = []; }
  if (!Array.isArray(state.subscriptions)) { state.subscriptions = []; }
  var byIdentity = Object.create(null);
  state.manual.forEach(function (n) {
    if (!n || !n.protocol || !n.address) { return; }
    var ident = identityOf(n);
    if (!byIdentity[ident]) { byIdentity[ident] = n; }
  });
  var added = 0, updated = 0;
  nodes.forEach(function (n) {
    delete n.dupOf;
    var ident = identityOf(n);
    var existing = byIdentity[ident] || null;
    if (existing) {
      var keepId = existing.id || idOf(n);
      Object.keys(n).forEach(function (k) { if (k !== "id") { existing[k] = n[k]; } });
      existing.id = keepId;
      // 同一个 id，凭证/传输可能变了：已应用的配置就此过时。
      // 列表会一直标记它，直到下一次成功应用清除该标记。
      existing.dirty = true;
      updated++;
    } else {
      n.id = n.id || idOf(n);
      state.manual.push(n);
      byIdentity[ident] = n;
      added++;
    }
  });
  return { added: added, updated: updated };
}

function writeFile(path, text, mode) {
  var b64 = bytesToBase64(new TextEncoder().encode(text));
  // 用 tmp + mv，杜绝写了一半的文件；这些文件含凭证，所以权限是 0600。
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

// 部分失败时弹窗仍盖在用户输入之上：导入成功的行已经完成，
// 失败的行列在这里，便于修改后重试。
function renderFailedRows(rows) {
  els.iPreview.textContent = "";
  rows.forEach(function (r) {
    els.iPreview.appendChild(previewLine(
      { num: r.line, name: r.error, meta: T.lineNo + r.line + T.lineNoEnd }, "bad"));
  });
}

// 模块日志里由 UI 侧节点库改动写下的导入/删除行：shell 看不到它们——
// 页面直接经桥接写节点库——因此 `mlog append` 是唯一入口。
// 尽力而为：一行日志写失败绝不能影响操作本身的结果。用单引号：
// 消息只含数字、空格和括号。
function logNodeLine(message) {
  exec(CLI + " mlog append Node '" + message + "'").catch(function () {});
}

// 日志行与 toast 的数字一致：全是新增时读作 (3 new)，
// 混合时读作 (2 updated, 1 failed)；既无失败也无更新时不带后缀段。
function importLogLine(added, updated, failed) {
  var msg = "imported " + (added + updated) + " nodes";
  var bits = [];
  if (added) { bits.push(String(added) + " new"); }
  if (updated) { bits.push(String(updated) + " updated"); }
  if (failed) { bits.push(String(failed) + " failed"); }
  if (bits.length) { msg += " (" + bits.join(", ") + ")"; }
  return msg;
}

// 一个手势：解析输入，把可解析的行合并进节点库。还没有已应用节点时，
// 同一手势也会切换到 applyAfterImport 指定的节点（ADR 0012）；
// 已经有已应用节点时，只有节点库发生变化。
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
  var nextId = "";

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
      // 页面必须持有刚写入的内容：switchTo 会读 lastStateObj，若拿着旧副本，
      // 重新导入的节点在自身应用成功后仍会被标记为有改动。
      lastStateObj = state;
      nextId = applyAfterImport(state, lastApplied);
      logNodeLine(importLogLine(res.added, res.updated, bad.length));
      var msg = T.importDone + " " + res.added;
      if (res.updated) { msg += T.importUpdated + " " + res.updated; }
      if (!bad.length) {
        toast(msg);
        closeAdd();
        refreshPage();
      } else {
        // 文本保留以便编辑；重新导入是安全的，因为 mergeNodes 按身份更新，
        // 而不是复制出重复项。
        toast(msg + T.importFailedN.replace("{n}", String(bad.length)));
        renderFailedRows(bad);
      }
    });
  }).catch(function (e) {
    nextId = "";
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    busy = false;
    setButtons();
    els.iApply.disabled = !els.iText.value.trim();
    // 在 busy 清除之后：switchTo 在另一个操作占用页面时会拒绝运行。
    if (!nextId) { return; }
    var node = findNodeById(lastStateObj, nextId);
    nextId = "";
    if (node) { switchTo(node); }
  });
}

// 运行提示里提到 socks 端口；shell 现在报告的是已配置的那个。
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
  els.conf.textContent = kv.conf || "–";
  if (state === "running") {
    // 运行中的核心一定带着接管规则（启动即接管，docs/adr/0011）：无法落实
    // 接管的启动会被拒绝，所以这是运行中的核心唯一可能得到的提示。
    els.hint.textContent = hintText(T.tpRunningHint, kv);
  } else {
    // 开机不自动启动，意味着核心停止时设备保持直连，而提示必须点明这一点
    // （见 docs/adr/0018）。
    els.hint.textContent = kv.node ? T.stoppedHintTp : T.stoppedHintNone;
  }

  // 状态卡片只用于失败：设置页里曾经有过的开关已经移除
  // （docs/adr/0011），所以失败是这张卡片唯一需要说的事。冲突或
  // 接管规则失败会让核心停机、设备保持直连；重试执行的就是按钮
  // 那次启动。
  var tpFailed = phase === "failed/conflict" || phase === "failed/rules";
  els.tpCard.hidden = !tpFailed;
  if (tpFailed) {
    els.tpHint.textContent = phase === "failed/conflict" ? T.tpConflict : T.tpRules;
  }
  els.tpRetry.hidden = !tpFailed || busy;

  // 分流模式取自偏好（kv.route）。卡片放在状态页，紧挨着它改变的状态；
  // 它下方的提示只用于告警：全局不需要地理数据，缺数据时大陆直连
  // 退化为全局（ADR 0014），大陆直连去广告则拒绝启动（ADR 0021）；
  // 因此正常模式什么都不说，只有缺文件时才出现这一行。
  var routeMode = routeValue(kv.route);
  els.selRoute.value = routeMode;
  var routeHint = "";
  if (kv.geodata === "missing") {
    if (routeMode === "cn") { routeHint = T.routeCnNoGeodata; }
    else if (routeMode === "cnadblock") { routeHint = T.routeGeoMissing; }
  }
  els.setRouteHint.textContent = routeHint;
  els.setRouteHint.className = routeHint ? "hint warn" : "hint";
  els.setRouteHint.hidden = !routeHint;

  // 日志等级来自 shell，而不是 localStorage：下拉框显示已保存的
  // 偏好，只有运行中的核心仍带着旧等级时才出现提示
  // （下次启动生效，docs/adr/0015）。
  var logLevel = LOG_LEVELS.indexOf(kv.loglevel) >= 0 ? kv.loglevel : "warning";
  els.selLogLevel.value = logLevel;
  els.setLogLevelHint.hidden = kv.loglevelpending !== "1";

  setButtons();
  // 删除门槛取决于运行状态，所以停止或启动都要重新判定列表。
  if (coreRunning() !== listRunning) { renderNodeList(); }
}

function renderLog(text) {
  if (text === lastLog[logSource]) { return; }
  lastLog[logSource] = text;
  var atBottom = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 24;
  els.log.textContent = text || T.noLog;
  if (els.follow.checked && atBottom) { els.log.scrollTop = els.log.scrollHeight; }
  updateLogNav();
}

// 浮动滚动按钮只在日志确实溢出时存在：日志短就没有按钮。
// 隐藏的页面没有布局（两个测量值都是 0），因此同一检查也覆盖了
// 停在别的标签页的情况；文本变化时 renderLog 会重新判定。
function updateLogNav() {
  els.logNav.hidden = els.log.scrollHeight <= els.log.clientHeight;
}

function refreshStatus() {
  // 按页面附加的参数：日志页带上日志大小，节点页带上渲染出的 meta id，
  // 这样两者都不必再读一次 state.json。
  var page = currentRoute === "log" ? " log" : (currentRoute === "nodes" ? " nodes" : "");
  var cmd = CLI + " status" + page;
  return exec(cmd).then(function (r) {
    if (r.errno !== 0 && !r.stdout) {
      els.banner.textContent = r.stderr || (T.actionFailed + " (status)");
      els.banner.className = "banner show";
      return null;
    }
    var kv = parseKv(r.stdout);
    renderStatus(kv);
    return kv;
  }).catch(function () { return null; /* 桥接错误已在启动时报告 */ });
}

function refreshLog(size) {
  // 记下来源和代号：tail 在途时切换标签或清空日志，都不能把那段
  // 陈旧文本渲染出来（它自己的拉取已经在路上）。
  var source = logSource;
  var gen = logGen[source];
  var cmd = source === "module" ? "mlog" : "log";
  return exec(CLI + " " + cmd + " " + logLines).then(function (r) {
    if (source !== logSource || gen !== logGen[source]) { return; }
    renderLog(r.stdout || r.stderr);
    if (size !== undefined) { lastLogSize[source] = String(size); }
  }).catch(function () {});
}

// 切换标签只改变下一次拉取读哪个 tail：跟随、暂停和日志行数
// 都沿用原来的设置。丢弃缓存项，避免重绘被跳过；
// 页面先空着，直到拉取返回。
function setLogSource(source) {
  if (source === logSource) { return; }
  logSource = source;
  els.clearLog.textContent = clearLogLabel();
  els.logTabCore.classList.toggle("active", source === "core");
  els.logTabModule.classList.toggle("active", source === "module");
  els.logTabCore.setAttribute("aria-selected", source === "core" ? "true" : "false");
  els.logTabModule.setAttribute("aria-selected", source === "module" ? "true" : "false");
  lastLog[source] = null;
  renderLog("");
  // 状态轮询已经给出新来源的大小；把它传进去，避免下一次轮询
  // 把同一段 tail 再取一遍。
  var size;
  if (lastKv) { size = source === "module" ? lastKv.mlogsize : lastKv.logsize; }
  refreshLog(size);
}

// 清空日志是无需确认的一次点按：按钮写出它将截断的文件，
// 提示 toast 写出实际已清空的文件。像 refreshLog 那样记下来源——
// 切换标签发生在 shell 在途时，既不能重绘另一个日志，也不能声称它已被清空。
function clearCurrentLog() {
  if (!hasBridge || busy || clearBusy) { return; }
  var source = logSource;
  var cmd = (source === "module" ? "mlog" : "log") + " clear";
  logGen[source]++; // 丢弃该日志尚在途的 tail
  clearBusy = true;
  setButtons();
  exec(CLI + " " + cmd).then(function (r) {
    if (r.errno !== 0) {
      toast(T.actionFailed + ": " + (r.stderr || r.errno));
      return;
    }
    toast(source === "module" ? T.clearModuleDone : T.clearCoreDone);
    // 截断使大小从 N 变成 0。两个缓存都丢掉，视图立刻清空，
    // 而 2s 轮询也不会因为记着旧大小而跳过新的 tail。
    lastLog[source] = null;
    lastLogSize[source] = -1;
    if (source === logSource) { renderLog(""); refreshLog(); }
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    clearBusy = false;
    setButtons();
  });
}

// 三种分流模式取值对应 shell 能写入的值（docs/adr/0021）。本页不认识的值
// 一律读作全局，即无文件时的模式，这样手改 runtime/route 也绝不会
// 让下拉框空白。全局已不再是默认值：安装器写入的是 `cnadblock`。
var ROUTE_MODES = ["global", "cn", "cnadblock"];
function routeValue(v) { return ROUTE_MODES.indexOf(v) >= 0 ? v : "global"; }

// 设置页显示生效的端口（state.json 的取值，已套用默认值），让用户
// 看到的正是 shell 会渲染的结果，即使文件上次是手工写的。
// 状态轮询已经通过 shell 自己的逐字段回退带上了端口，所以本页
// 不再每 2s 读取并解析 state.json。用户正在编辑的字段保持不动：
// 而 2s 轮询也绝不能覆盖正在输入的内容。
function refreshSettings() {
  var kv = lastKv;
  var p = portsNormalize(kv ? { socksPort: kv.socks, httpPort: kv.http } : null);
  if (!portsDirty.socks && document.activeElement !== els.iSocks) {
    els.iSocks.value = String(p.socks);
  }
  if (!portsDirty.http && document.activeElement !== els.iHttp) {
    els.iHttp.value = String(p.http);
  }
}

// 一个手势：先校验并写入 state.json 的 settings（意图优先），再让 shell
// 渲染、校验并重启。渲染或重启失败时旧配置继续运行，并把 CLI 的
// 错误显示出来，与应用节点失败时一样。
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
        // 保存的值现在就是生效值；让轮询再同步一次字段即可。
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
// 用 hash 路由作为唯一的导航状态：刷新会回到同一个标签页，链接也能
// 直接深链到某个标签页。点按用 replace 而不是 push，
// 这样长期存活的 WebView 不会为每次切换标签都堆出一条历史记录。
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
  // 勾选集合只是临时意图：经标签栏离开节点页时丢弃它，而不是带到别处。
  // 添加弹窗以遮罩形式出现，不改变路由。已输入但未保存的端口同理：
  // 离开页面就丢弃。
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
  // 隐藏页面没有布局，所以要等选中的页面存在之后再恢复滚动位置。
  var y = scrollByRoute[route] || 0;
  window.scrollTo(0, y);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () { window.scrollTo(0, y); });
  }
  // 即使文本自上次访问以来没有变化，带着"跟随"进入日志页也应落在
  // 最新几行。
  if (route === "log") { updateLogNav(); }
  if (route === "log" && els.follow.checked) {
    var toBottom = function () { els.log.scrollTop = els.log.scrollHeight; };
    if (typeof requestAnimationFrame === "function") { requestAnimationFrame(toBottom); }
    else { toBottom(); }
  }
  if (!opts || opts.refresh !== false) { refreshPage(); }
}

// 添加弹窗不持有路由，也不产生历史记录：返回手势始终属于标签栏。
// 打开时重置内容，因为关闭会丢弃已输入的一切。
function openAdd() {
  if (dialogId || dialogBusy) { return; }
  els.iText.value = "";
  els.iPreview.textContent = "";
  els.iHint.textContent = T.notAppliedYet;
  els.iHint.className = "nodehint";
  els.iApply.disabled = true;
  els.overlay.hidden = false;
  syncDialogScrollLock();
}

function closeAdd() {
  els.overlay.hidden = true;
  syncDialogScrollLock();
}

function go(route) {
  route = routeOf(route);
  if (route === currentRoute) { refreshPage(); return; }
  var hash = routeHash(route);
  var replaced = false;
  try { history.replaceState(null, "", hash); replaced = true; } catch (e) { /* 走下面的回退路径 */ }
  if (replaced) { showRoute(route, { refresh: true }); }
  else { location.hash = hash; }
}

function initNav() {
  var start = routeOf(location.hash);
  var hash = routeHash(start);
  if (location.hash !== hash) {
    try { history.replaceState(null, "", hash); } catch (e) { /* 异常的 hash 仍由 routeOf 处理 */ }
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

// 暂停复选框只冻结 2s 轮询，并不冻结日志本身：暂停期间手动拉取
// （刷新按钮）仍然会执行。
// 一次只跑一个轮询：桥接变慢也不能把 shell 堆起来。轮询在途时到达的
// 请求合并成一次后续轮询（手动优先）。
var pollInFlight = false;
var pollQueued = false;

function refreshPage(manual) {
  if (!hasBridge) { return; }
  if (pollInFlight) { pollQueued = pollQueued || !!manual; return; }
  pollInFlight = true;
  var status = refreshStatus();
  var page = Promise.resolve();
  if (currentRoute === "nodes") {
    page = status.then(function (kv) { return refreshNodes(kv); });
  } else if (currentRoute === "log") {
    if (els.pause.checked && !manual) {
      // 已暂停：状态仍会更新徽标；日志等待刷新按钮。
    } else if (manual) {
      page = refreshLog();
    } else {
      page = status.then(function (kv) {
        if (!kv || kv.logsize === undefined) { return refreshLog(); }
        var size = logSource === "module" ? kv.mlogsize : kv.logsize;
        if (String(size) !== String(lastLogSize[logSource])) { return refreshLog(size); }
      });
    }
  } else if (currentRoute === "settings") {
    page = status.then(function () { refreshSettings(); });
  }
  var done = function () {
    pollInFlight = false;
    if (pollQueued) {
      var next = pollQueued;
      pollQueued = false;
      refreshPage(next);
    }
  };
  return Promise.all([status, page]).then(done, done);
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
els.tpRetry.addEventListener("click", function () { run("start", T.startingMsg); });
els.selRoute.addEventListener("change", function () {
  var target = routeValue(els.selRoute.value);
  if (lastKv && lastKv.route === target) { return; }
  // 另一个操作占用页面时做出的改动不会发出去：把下拉框放回 shell 报告的
  // 位置，而不是让它一直错着等到下一次轮询。
  if (busy) {
    els.selRoute.value = routeValue(lastKv && lastKv.route);
    return;
  }
  run("routing " + target, T.routeSwitching);
});
els.selLogLevel.addEventListener("change", function () {
  var target = els.selLogLevel.value;
  if (LOG_LEVELS.indexOf(target) < 0) { return; }
  var current = lastKv && LOG_LEVELS.indexOf(lastKv.loglevel) >= 0 ? lastKv.loglevel : "warning";
  if (target === current) { return; }
  // 与分流模式下拉框同一条规则：另一个操作占用页面时做出的改动
  // 不会发出去；把下拉框放回 shell 报告的位置。
  if (busy) { els.selLogLevel.value = current; return; }
  run("loglevel " + target, T.logLevelToast);
});
els.tpRetry.addEventListener("click", function () { run("start", T.startingMsg); });
els.refresh.addEventListener("click", function () { refreshPage(true); });
els.clearLog.addEventListener("click", clearCurrentLog);
els.logTabCore.addEventListener("click", function () { setLogSource("core"); });
els.logTabModule.addEventListener("click", function () { setLogSource("module"); });
// 纯导航：只是一次即时 scrollTop，别无其他——不拉取、不动复选框。
els.logTop.addEventListener("click", function () { els.log.scrollTop = 0; });
els.logBottom.addEventListener("click", function () { els.log.scrollTop = els.log.scrollHeight; });
window.addEventListener("resize", updateLogNav);
els.nList.addEventListener("click", function (e) {
  var t = e.target;
  var act = t && t.getAttribute ? t.getAttribute("data-action") : "";
  if (act === "add") { openAdd(); return; }
  var row = t && t.closest ? t.closest(".nrow") : null;
  if (!row) { return; }
  var node = findNodeById(lastStateObj, row.getAttribute("data-id"));
  if (!node) { return; }
  // 编辑模式下整行都是勾选开关；除非删除门槛允许，已应用行被排除，
  // 节点详情弹窗只在编辑模式之外打开。
  if (editMode) {
    if (!canCheckNode(node)) { return; }
    if (checkSet[node.id]) { delete checkSet[node.id]; } else { checkSet[node.id] = true; }
    renderNodeList();
    return;
  }
  var action = t.getAttribute ? t.getAttribute("data-action") : "";
  if (action === "delete") { askDelete(node); return; }
  if (action === "cancel") { confirmId = null; renderNodeList(); return; }
  if (action === "confirm") { confirmDelete(node); return; }
  if (confirmId) { return; }
  openNodeDialog(node);
});
els.nList.addEventListener("keydown", function (e) {
  if (e.key !== "Enter" && e.key !== " ") { return; }
  if (!e.target.classList || !e.target.classList.contains("nrow")) { return; }
  e.preventDefault();
  var node = findNodeById(lastStateObj, e.target.getAttribute("data-id"));
  if (!node) { return; }
  if (editMode) {
    if (!canCheckNode(node)) { return; }
    if (checkSet[node.id]) { delete checkSet[node.id]; } else { checkSet[node.id] = true; }
    renderNodeList();
    return;
  }
  if (confirmId) { return; }
  openNodeDialog(node);
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
    var model = nodeListModel(lastStateObj, lastApplied);
    var bm = batchModel(model, checkSet, deleteGate(model, coreRunning()));
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
els.ndClose.addEventListener("click", closeNodeDialog);
els.nodeOverlay.addEventListener("click", function (e) {
  if (e.target === els.nodeOverlay) { closeNodeDialog(); }
});
els.ndApply.addEventListener("click", applyFromDialog);
els.ndCopy.addEventListener("click", function () { copyDialogLink("link"); });
els.ndCopyMenu.addEventListener("click", function (e) {
  e.stopPropagation();
  toggleDialogMenu();
});
els.ndMenu.addEventListener("click", function (e) {
  var t = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
  if (!t) { return; }
  copyDialogLink(t.getAttribute("data-copy"));
});
document.addEventListener("click", function (e) {
  if (!dialogMenuOpen) { return; }
  if (els.ndCopyGroup.contains(e.target)) { return; }
  dialogMenuOpen = false;
  if (dialogId) { renderDialog(); }
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") { return; }
  if (dialogMenuOpen) {
    dialogMenuOpen = false;
    if (dialogId) { renderDialog(); }
    return;
  }
  if (dialogId && !dialogBusy) { closeNodeDialog(); }
});
els.iText.addEventListener("input", function () {
  els.iApply.disabled = busy || !els.iText.value.trim();
});
// 主题切换只靠 CSS 变量重绘，无需重新渲染任何东西——
// 语言切换不同，它会让所有已渲染字符串失效。
els.selTheme.addEventListener("change", function () {
  var v = els.selTheme.value;
  if (THEMES.indexOf(v) < 0 || v === themePref) { return; }
  themePref = v;
  prefs.theme = v;
  prefsSave(prefsStore(), prefs);
  KRTheme.applyTheme(v);
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

// 只在页面确实可见时轮询；WebView 在后台会冻结定时器，
// 否则恢复时陈旧的 interval 会堆积起来。
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
themePref = prefs.theme;
langPref = prefs.lang;
logLines = prefs.logLines;
KRTheme.applyTheme(themePref);
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
