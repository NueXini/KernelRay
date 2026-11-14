// 主题与语言一样都是设置页的偏好：它与语言共用 WebView 的 localStorage 里同一份
// `kernelray.prefs` 数据，绝不进入 state.json。
//
// 本文件在 <head> 中、body 绘制之前加载，因此第一帧就已带上所选配色 —— 深色页面在
// 加载 app.js 期间不能闪出浅色；app.js 复用这里的函数，不重复键名，也不会重复
// "auto" 的解析。
//
// 配色本身只在 app.css 中定义一处，以 html[data-theme="light"|"dark"] 为键：
// "auto" 在这里解析，这样深色配色就不必写两遍。

var PREFS_KEY = "kernelray.prefs";
var THEMES = ["auto", "light", "dark"];
var DARK_QUERY = "(prefers-color-scheme: dark)";

function themeNormalize(raw) {
  return THEMES.indexOf(raw) >= 0 ? raw : "auto";
}

function systemDark() {
  if (typeof window === "undefined" || !window.matchMedia) { return false; }
  try { return !!window.matchMedia(DARK_QUERY).matches; } catch (e) { return false; }
}

// "auto" 是唯一需要持续询问系统的偏好：偏好为 auto 时，applyTheme() 订阅 change
// 事件，否则取消该订阅。这样系统配色切换时，已打开的页面无需重新加载，
// 就能直接重绘。
function resolveTheme(pref) {
  var p = themeNormalize(pref);
  if (p !== "auto") { return p; }
  return systemDark() ? "dark" : "light";
}

function readThemePref(store) {
  try {
    var raw = JSON.parse((store && store.getItem(PREFS_KEY)) || "null");
    return themeNormalize(raw && raw.theme);
  } catch (e) { return "auto"; }
}

// 受限的 WebView 里连 localStorage 本身也可能抛异常；此时该偏好只在本次会话内有效。
function prefStore() {
  try { return window.localStorage; } catch (e) { return null; }
}

var themeListener = null;
var themeMedia = null;

function watchSystem(on) {
  if (typeof window === "undefined" || !window.matchMedia) { return; }
  var mq = window.matchMedia(DARK_QUERY);
  if (on && !themeListener) {
    themeListener = function () { applyTheme("auto"); };
    if (mq.addEventListener) { mq.addEventListener("change", themeListener); }
    else if (mq.addListener) { mq.addListener(themeListener); }
    themeMedia = mq;
  } else if (!on && themeListener) {
    if (themeMedia && themeMedia.removeEventListener) {
      themeMedia.removeEventListener("change", themeListener);
    } else if (themeMedia && themeMedia.removeListener) {
      themeMedia.removeListener(themeListener);
    }
    themeListener = null;
    themeMedia = null;
  }
}

// 属性 data-theme 是解析后的配色，绝不会是 "auto"，所以 CSS 不需要媒体查询；该属性
// 还驱动 app.css 中的 color-scheme，正是它让原生下拉框和数字调节按钮采用用户挑选的
// 配色，而不是系统的配色。
function applyTheme(pref) {
  var p = themeNormalize(pref);
  var resolved = resolveTheme(p);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-theme", resolved);
  }
  watchSystem(p === "auto");
  return resolved;
}

// 管理器的 WebView 没有模块加载器：app.js 直接从全局对象上取这套 API。
if (typeof window !== "undefined") {
  window.KRTheme = {
    PREFS_KEY: PREFS_KEY, THEMES: THEMES,
    themeNormalize: themeNormalize, resolveTheme: resolveTheme,
    readThemePref: readThemePref, prefStore: prefStore, applyTheme: applyTheme
  };
}

// 在解析时、首次绘制之前运行。
if (typeof document !== "undefined") {
  applyTheme(readThemePref(prefStore()));
}
