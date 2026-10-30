// Theme is a Settings-page preference, like language: it rides in the same `kernelray.prefs`
// blob in the WebView's localStorage and never reaches state.json.
//
// This file loads in <head>, before the body paints, so the first frame already carries the
// chosen palette — a dark page must not flash light while app.js loads. app.js reuses these
// functions rather than repeating the key or the "auto" resolution.
//
// The palette itself lives once in app.css, keyed on html[data-theme="light"|"dark"]:
// "auto" is resolved here so the dark colours are not written twice.

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

// "auto" is the only pref that has to keep asking the system: applyTheme() subscribes to the
// change event while the pref is auto and drops the subscription otherwise, so a system flip
// repaints an open page without a reload.
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

// localStorage itself can throw in a locked-down WebView; the pref is then session-only.
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

// data-theme is the resolved palette, never "auto", so the CSS needs no media query. The
// attribute also drives color-scheme in app.css, which is what keeps native selects and
// number spinners in the palette the user picked rather than the system's.
function applyTheme(pref) {
  var p = themeNormalize(pref);
  var resolved = resolveTheme(p);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-theme", resolved);
  }
  watchSystem(p === "auto");
  return resolved;
}

// The manager's WebView has no module loader: app.js takes the API off the global.
if (typeof window !== "undefined") {
  window.KRTheme = {
    PREFS_KEY: PREFS_KEY, THEMES: THEMES,
    themeNormalize: themeNormalize, resolveTheme: resolveTheme,
    readThemePref: readThemePref, prefStore: prefStore, applyTheme: applyTheme
  };
}

// Runs at parse time, before the first paint.
if (typeof document !== "undefined") {
  applyTheme(readThemePref(prefStore()));
}
