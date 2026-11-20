import { T, setLang } from "./i18n.js";
import { els } from "./els.js";
import { hasBridge, exec, CLI, LOG_LEVELS } from "./bridge.js";
import { THEMES, LANGS, LOG_LINE_STEPS, themePref, langPref, logLines, loadPrefs, setPref } from "./prefs.js";
import { renderPrefs, refreshSettings, doSavePorts, setPortDirty } from "./settings.js";
import { setButtons, routeValue, refreshStatus, lastKv, coreRunning } from "./status.js";
import { clearCurrentLog, setLogSource, updateLogNav, refreshLog, renderLog, clearLogLabel, logSource, lastLogSize, invalidateLog } from "./log.js";
import { renderNodeList, invalidateList, findNodeById, canCheckNode, askDelete, confirmDelete, confirmBatchDelete, refreshNodes, editMode, confirmId, checkSet, lastStateObj, lastApplied, setConfirmId, toggleCheck, toggleEditMode, setCheck, setBatchConfirm, toggleCollapse } from "./nodelist.js";
import { nodeListModel, batchModel, deleteGate } from "./nodelist-model.js";
import { identityOf } from "./parse.js";
import { closeNodeDialog, applyFromDialog, copyDialogLink, toggleDialogMenu, openNodeDialog, dialogId, dialogBusy, dialogMenuOpen, closeDialogMenu, invalidateDialog } from "./dialog.js";
import { doImport, openAdd, closeAdd, setAddTab } from "./import.js";
import { addSubscription, refreshSubscription, openSubDialog, closeSubDialog, renderSubDialog, saveSubName, copySubUrl, confirmSubDelete, cancelSubDelete, toggleSubReveal, invalidateSubDialog } from "./subscription.js";
import { currentRoute, initNav } from "./nav.js";

var POLL_MS = 2000;

var busy = false;

var pending = null; // 动作在途期间为 "start" | "stop"
var diagBusy = false; // 诊断包收集在途：与核心动作互斥（共享 busy 闸门），状态独立

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
  els.addTabLink.textContent = T.tabLink;
  els.addTabSub.textContent = T.tabSub;
  els.sUrl.placeholder = T.subUrlPlaceholder;
  els.sName.placeholder = T.subNamePlaceholder;
  els.sAdd.textContent = T.subAdd;
  els.sHint.textContent = T.subHint;
  els.sdNameLabel.textContent = T.subNameLabel;
  els.sdCopy.textContent = T.copyUrl;
  els.sdSave.textContent = T.save;
  els.sdCancel.textContent = T.cancel;
  els.sdClose.setAttribute("aria-label", T.close);
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
  els.lSetDev.textContent = T.setDev;
  els.diagHint.textContent = T.diagHint;
  els.diagCollect.textContent = diagBusy ? T.diagCollecting : T.diagCollect;
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

// 切换语言必须让旧语言下渲染出的内容失效：节点列表的签名不包含语言，
// 而 renderLog 会跳过未变化的文本。

function applyLang() {
  setLang();
  label();
  renderPrefs();
  invalidateList();
  invalidateDialog();
  renderNodeList();
  els.iHint.textContent = T.notAppliedYet;
  els.iHint.className = "nodehint";
  els.sHint.textContent = T.subHint;
  invalidateSubDialog();
  renderSubDialog();
  invalidateLog();
  renderLog("");
  if (!hasBridge) {
    els.banner.textContent = T.noBridge;
    els.badge.textContent = T.unknown;
  }
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
    renderSubDialog();
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
// 诊断包不走 run()：它是设置页的手势，不刷新状态页，也用不到 pending 的
// 启动/停止文案切换；但它尊重 busy——核心动作在途时不并行打包。
els.diagCollect.addEventListener("click", function () {
  if (busy || diagBusy) { return; }
  diagBusy = true;
  setButtons();
  toast(T.diagCollecting);
  exec(CLI + " diagnostics").then(function (r) {
    if (r.errno !== 0) {
      toast(T.diagFailed + ": " + (r.stderr || r.errno));
      return;
    }
    var dest = (r.stdout || "").trim();
    toast(T.diagDone);
    // toast 会消失，而路径是接下来要拿的东西：写进卡片常驻的 hint 区。
    if (dest) {
      els.diagPath.textContent = dest;
      els.diagPath.hidden = false;
    }
  }).catch(function (e) {
    toast(T.diagFailed + ": " + e.message);
  }).then(function () {
    diagBusy = false;
    setButtons();
  });
});
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
  // 组头按钮在行之外，所以要在找 .nrow 之前处理。
  if (act === "subcollapse") { toggleCollapse(t.getAttribute("data-sub")); return; }
  if (act === "subrefresh") { refreshSubscription(t.getAttribute("data-sub")); return; }
  if (act === "submenu") { openSubDialog(t.getAttribute("data-sub")); return; }
  var row = t && t.closest ? t.closest(".nrow") : null;
  if (!row) { return; }
  var node = findNodeById(lastStateObj, row.getAttribute("data-id"));
  if (!node) { return; }
  // 编辑模式下整行都是勾选开关；除非删除门槛允许，已应用行被排除，
  // 节点详情弹窗只在编辑模式之外打开。
  if (editMode) {
    // 订阅行不是可勾选项：它们归订阅所有，没有单条删除。
    if (row.hasAttribute("data-sub")) { return; }
    if (!canCheckNode(node)) { return; }
    toggleCheck(node.id);
    renderNodeList();
    return;
  }
  var action = t.getAttribute ? t.getAttribute("data-action") : "";
  if (action === "delete") { askDelete(node); return; }
  if (action === "cancel") { setConfirmId(null); renderNodeList(); return; }
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
    if (e.target.hasAttribute("data-sub")) { return; }
    if (!canCheckNode(node)) { return; }
    toggleCheck(node.id);
    renderNodeList();
    return;
  }
  if (confirmId) { return; }
  openNodeDialog(node);
});
els.editNode.addEventListener("click", function () {
  toggleEditMode();
  renderNodeList();
});
els.nToolbar.addEventListener("click", function (e) {
  var t = e.target;
  var act = t && t.getAttribute ? t.getAttribute("data-action") : "";
  if (act === "checkall") {
    var model = nodeListModel(lastStateObj, lastApplied, identityOf);
    var bm = batchModel(model, checkSet, deleteGate(model, coreRunning()));
    if (bm.allChecked) {
      bm.checkableIds.forEach(function (id) { setCheck(id, false); });
    } else {
      bm.checkableIds.forEach(function (id) { setCheck(id, true); });
    }
  } else if (act === "batchdel") {
    setBatchConfirm(true);
  } else if (act === "batchconfirm") {
    confirmBatchDelete();
    return;
  } else if (act === "batchcancel") {
    setBatchConfirm(false);
  } else {
    return;
  }
  renderNodeList();
});
els.iApply.addEventListener("click", doImport);
els.addNode.addEventListener("click", openAdd);
els.addClose.addEventListener("click", closeAdd);
els.addTabLink.addEventListener("click", function () { setAddTab("link"); });
els.addTabSub.addEventListener("click", function () { setAddTab("sub"); });
els.sUrl.addEventListener("input", function () {
  els.sAdd.disabled = busy || !els.sUrl.value.trim();
});
els.sAdd.addEventListener("click", function () {
  addSubscription(els.sUrl.value, els.sName.value);
});
els.subOverlay.addEventListener("click", function (e) {
  if (e.target === els.subOverlay) { closeSubDialog(); }
});
els.sdClose.addEventListener("click", closeSubDialog);
els.sdSave.addEventListener("click", saveSubName);
els.sdCopy.addEventListener("click", copySubUrl);
els.sdReveal.addEventListener("click", toggleSubReveal);
els.sdDelete.addEventListener("click", confirmSubDelete);
els.sdCancel.addEventListener("click", cancelSubDelete);
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
  closeDialogMenu();
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") { return; }
  if (!els.subOverlay.hidden) { closeSubDialog(); return; }
  if (dialogMenuOpen) {
    closeDialogMenu();
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
  setPref("theme", v);
  window.KRTheme.applyTheme(v);
});
els.selLang.addEventListener("change", function () {
  var v = els.selLang.value;
  if (LANGS.indexOf(v) < 0 || v === langPref) { return; }
  setPref("lang", v);
  applyLang();
  if (hasBridge) {
    refreshStatus();
    if (currentRoute === "log") { refreshLog(); }
  }
});
els.selLog.addEventListener("change", function () {
  var n = Number(els.selLog.value);
  if (LOG_LINE_STEPS.indexOf(n) < 0 || n === logLines) { return; }
  setPref("logLines", n);
  renderPrefs();
  if (hasBridge && currentRoute === "log") { refreshLog(); }
});
els.portsSave.addEventListener("click", doSavePorts);
els.iSocks.addEventListener("input", function () { setPortDirty("socks", true); });
els.iHttp.addEventListener("input", function () { setPortDirty("http", true); });

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

function setBusy(v) { busy = v; }

export { busy, pending, diagBusy, setBusy, toast, refreshPage };

function init() {
  loadPrefs();
  window.KRTheme.applyTheme(themePref);
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
}
init();
