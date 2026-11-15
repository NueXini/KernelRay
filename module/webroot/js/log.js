import { T } from "./i18n.js";
import { els } from "./els.js";
import { CLI, exec, hasBridge } from "./bridge.js";
import { logLines } from "./prefs.js";
import { busy, toast } from "./main.js";
import { lastKv, setButtons } from "./status.js";

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

var clearBusy = false; // 清空日志自己执行一次 exec；busy 只用于核心动作

// 清空日志按钮的名字指明它将截断哪份日志。该选择由标签页持有，
// 因此切换语言和切换标签页都会重新读到同一个标签。
function clearLogLabel() {
  return logSource === "module" ? T.clearModuleLog : T.clearCoreLog;
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

function invalidateLog() {
  lastLog.core = lastLog.module = null;
}

export { logSource, lastLog, lastLogSize, logGen, clearBusy, clearLogLabel, renderLog, updateLogNav, refreshLog, setLogSource, clearCurrentLog, invalidateLog };
