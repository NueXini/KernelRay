var KRTheme = window.KRTheme;

// 日志行数是设置页偏好；偏好加载完成之前默认为 200。
var logLines = 200;

var langPref = "auto"; // "auto" | "zh" | "en"；"auto" 时按 navigator.language 解析
var themePref = "auto"; // "auto" | "light" | "dark"；"auto" 时按系统设置解析

// 受限的 WebView 里 localStorage 本身也可能抛错；偏好退化为仅本次会话有效。
function prefsStore() {
  try { return window.localStorage; } catch (e) { return null; }
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

var prefs = null;

function loadPrefs() {
  prefs = prefsLoad(prefsStore());
  themePref = prefs.theme;
  langPref = prefs.lang;
  logLines = prefs.logLines;
}

function setPref(key, val) {
  if (key === "theme") { themePref = val; prefs.theme = val; }
  else if (key === "lang") { langPref = val; prefs.lang = val; }
  else if (key === "logLines") { logLines = val; prefs.logLines = val; }
  prefsSave(prefsStore(), prefs);
}

export { PREFS_KEY, LANGS, THEMES, LOG_LINE_STEPS, prefsNormalize, prefsLoad, prefsSave, prefsStore, langPref, themePref, logLines, loadPrefs, setPref };
