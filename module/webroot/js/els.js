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
  tpCard: $("tp-card"), tpHint: $("tp-hint"), tpRetry: $("tp-retry"),
  lSetDev: $("l-set-dev"), diagHint: $("l-set-diag-hint"),
  diagCollect: $("diag-collect"), diagPath: $("diag-path")
};
var tabs = [].slice.call(document.querySelectorAll(".tab"));
var pages = {
  status: $("page-status"), nodes: $("page-nodes"),
  log: $("page-log"), settings: $("page-settings")
};

export { els, tabs, pages };
