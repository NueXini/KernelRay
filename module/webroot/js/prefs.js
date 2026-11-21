import { PREFS_FILE, hasBridge, exec, writeFile } from "./bridge.js";

var KRTheme = window.KRTheme;

// 日志行数是设置页偏好；偏好加载完成之前默认为 200。
var logLines = 200;

var langPref = "auto"; // "auto" | "zh" | "en"；"auto" 时按 navigator.language 解析
var themePref = "auto"; // "auto" | "light" | "dark"；"auto" 时按系统设置解析

// 受限的 WebView 里 localStorage 本身也可能抛错；此时退化为仅本次会话有效。
function prefsStore() {
  try { return window.localStorage; } catch (e) { return null; }
}

// ---- UI preferences ----
// 主题、语言和日志行数是 UI 偏好，不是意图：state.json 的 `settings`
// 对象保存入站端口，分流模式则是 shell 自己的偏好（docs/state-schema.md）。
// 偏好的事实来源是桥接侧的 config/webui/preferences.json——文件由模块
// 持有，升级和清除 WebView 数据都不会再丢掉它们；localStorage 只在
// 没有桥接时使用（旧路径），并且是首次加载时的一次性种子来源。
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

// 偏好文件（或 localStorage 旧 blob）的原文 → 规范化对象。
// null、空串和坏 JSON 都落到默认值；多余字段丢弃。
function prefsParse(text) {
  if (text === null || text === undefined) { return prefsNormalize(null); }
  try { return prefsNormalize(JSON.parse(String(text))); }
  catch (e) { return prefsNormalize(null); }
}

// 规范化对象 → 持久化原文。文件与旧 blob 是同一形状（v/theme/lang/logLines），
// 播种时按这个形状原样搬迁，而不是逐字段重新解释。
function prefsSerialize(prefs) {
  var p = prefsNormalize(prefs);
  return JSON.stringify({ v: 1, theme: p.theme, lang: p.lang, logLines: p.logLines });
}

// 一次加载的决策，纯函数：fileText 是偏好文件的原文（null = 缺失或
// 读不出），legacyRaw 是 localStorage 里的旧 blob。文件可解析就是事实；
// 文件缺失、读不出或损坏时，旧 blob 迁移进来一次（seed=true，调用方
// 把它写进文件，下次加载就走文件）；两处都没有就落到默认值。
function prefsSource(fileText, legacyRaw) {
  if (fileText !== null && fileText !== undefined && String(fileText) !== "") {
    return { prefs: prefsParse(fileText), seed: null };
  }
  var legacy = null;
  try { legacy = JSON.parse(String(legacyRaw || "")); } catch (e) { legacy = null; }
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    return { prefs: prefsNormalize(legacy), seed: prefsSerialize(legacy) };
  }
  return { prefs: prefsNormalize(null), seed: null };
}
// ---- end UI preferences ----

var prefs = null;

// 无桥接时的旧路径：localStorage。存储抛错时静默放弃，偏好只在本次
// 会话内有效——与迁移前的行为一致。
function legacyPrefs() {
  var store = prefsStore();
  if (!store) { return null; }
  try { return store.getItem(PREFS_KEY); } catch (e) { return null; }
}

function legacySave(text) {
  var store = prefsStore();
  if (!store) { return; }
  try { store.setItem(PREFS_KEY, text); } catch (e) { /* 没有存储：仅本次会话 */ }
}

function adopt(p) {
  prefs = p;
  themePref = p.theme;
  langPref = p.lang;
  logLines = p.logLines;
}

// 桥接可用时偏好文件是事实来源；文件缺失或读不出而 localStorage 还留着
// 旧 blob 时播种一次。播种失败不致命：内存偏好已生效，下次加载再试。
// 返回 Promise，主流程在它之后重新应用主题与语言。
function loadPrefs() {
  if (!hasBridge) {
    adopt(prefsSource(null, legacyPrefs()).prefs);
    return Promise.resolve();
  }
  return exec("cat " + PREFS_FILE + " 2>/dev/null").then(function (r) {
    var fileText = r.errno === 0 ? (r.stdout || "") : null;
    if (fileText !== null && !String(fileText).trim()) { fileText = null; }
    var got = prefsSource(fileText, legacyPrefs());
    adopt(got.prefs);
    if (got.seed) {
      writeFile(PREFS_FILE, got.seed + "\n", "600").catch(function () {});
      // 播种之后旧 blob 继续留着：theme.js 首屏仍从这里读，避免闪一下默认配色。
    }
  }).catch(function () {
    // 桥接错误已在启动时报告；偏好退回默认值，仅本次会话。
    adopt(prefsNormalize(null));
  });
}

function setPref(key, val) {
  if (key === "theme") { themePref = val; prefs.theme = val; }
  else if (key === "lang") { langPref = val; prefs.lang = val; }
  else if (key === "logLines") { logLines = val; prefs.logLines = val; }
  var text = prefsSerialize(prefs);
  if (hasBridge) {
    // 文件是事实来源；写失败只影响持久化，本次会话的偏好已经生效。
    writeFile(PREFS_FILE, text + "\n", "600").catch(function () {});
    // localStorage 里的镜像跟着更新：theme.js 首屏从它读，不同步会闪旧配色。
    legacySave(text);
  } else {
    legacySave(text);
  }
}

export { PREFS_KEY, LANGS, THEMES, LOG_LINE_STEPS, prefsNormalize, prefsParse, prefsSerialize, prefsSource, prefsStore, langPref, themePref, logLines, loadPrefs, setPref };
