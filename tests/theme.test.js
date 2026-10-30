// Theme preference tests for the WebUI.
//
// theme.js is a classic script loaded in <head> before the body paints, so it can only touch
// `window` (matchMedia, localStorage) and `document.documentElement`. Evaluating the shipped
// file with both stubbed is exactly what the WebView gives it, minus the painting — the same
// "run the file we ship" contract as tests/prefs.test.js.
//
//   node tests/theme.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const themePath = path.join(__dirname, "..", "module", "webroot", "theme.js");
const src = fs.readFileSync(themePath, "utf8");

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(name + "\n    " + e.message.replace(/\n/g, "\n    "));
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((what || "value") + "\n      expected " + b + "\n      actual   " + a);
  }
}

function memStore(seed) {
  const m = new Map();
  if (seed !== undefined) { m.set("kernelray.prefs", JSON.stringify(seed)); }
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }
  };
}

const denyStore = {
  getItem() { throw new Error("denied"); },
  setItem() { throw new Error("denied"); }
};

// A fresh evaluation of theme.js, with the system palette and the stored blob under control.
function load(opts) {
  const o = opts || {};
  const attrs = {};
  const media = {
    matches: !!o.systemDark,
    added: 0,
    removed: 0,
    fn: null,
    addEventListener(name, fn) { this.added++; this.fn = fn; },
    removeEventListener() { this.removed++; this.fn = null; }
  };
  global.window = {
    matchMedia: () => media,
    localStorage: o.store === undefined ? memStore() : o.store
  };
  global.document = {
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }
  };
  new Function(src)();
  const api = global.window.KRTheme;
  api.attrs = attrs;
  api.media = media;
  return api;
}

// ---- normalising and resolving ----

check("the three presets, and nothing else", () => {
  const t = load();
  eq(t.THEMES, ["auto", "light", "dark"]);
  eq(t.themeNormalize("auto"), "auto");
  eq(t.themeNormalize("light"), "light");
  eq(t.themeNormalize("dark"), "dark");
});

check("unknown and non-string values normalise to auto", () => {
  const t = load();
  eq(t.themeNormalize(undefined), "auto");
  eq(t.themeNormalize(null), "auto");
  eq(t.themeNormalize(""), "auto");
  eq(t.themeNormalize("DARK"), "auto");
  eq(t.themeNormalize("midnight"), "auto");
  eq(t.themeNormalize(1), "auto");
  eq(t.themeNormalize({ theme: "dark" }), "auto");
});

check("auto follows the system; an explicit choice overrides it", () => {
  eq(load({ systemDark: true }).resolveTheme("auto"), "dark");
  eq(load({ systemDark: false }).resolveTheme("auto"), "light");
  eq(load({ systemDark: true }).resolveTheme("light"), "light");
  eq(load({ systemDark: false }).resolveTheme("dark"), "dark");
  eq(load({ systemDark: true }).resolveTheme("junk"), "dark");
});

check("no matchMedia at all resolves auto to light instead of throwing", () => {
  global.window = { localStorage: memStore() };
  global.document = { documentElement: { setAttribute() {} } };
  new Function(src)();
  eq(global.window.KRTheme.resolveTheme("auto"), "light");
});

// ---- reading the stored preference ----

check("readThemePref: nothing stored, or no store, means auto", () => {
  const t = load();
  eq(t.readThemePref(memStore()), "auto");
  eq(t.readThemePref(null), "auto");
  eq(t.readThemePref(denyStore), "auto");
});

check("readThemePref: the stored theme, or auto when it is junk", () => {
  const t = load();
  eq(t.readThemePref(memStore({ v: 1, theme: "dark", lang: "zh", logLines: 500 })), "dark");
  eq(t.readThemePref(memStore({ v: 1, theme: "light" })), "light");
  eq(t.readThemePref(memStore({ v: 1, theme: "sepia" })), "auto");
  eq(t.readThemePref(memStore({ v: 1, lang: "zh" })), "auto");
  eq(t.readThemePref(memStore([1, 2, 3])), "auto");
});

check("prefStore survives a localStorage that throws", () => {
  global.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    get localStorage() { throw new Error("denied"); }
  };
  global.document = { documentElement: { setAttribute() {} } };
  new Function(src)();
  eq(global.window.KRTheme.prefStore(), null);
  eq(global.window.KRTheme.readThemePref(global.window.KRTheme.prefStore()), "auto");
});

// ---- applying it ----

check("loading stamps the stored palette before anything else runs", () => {
  const dark = load({ systemDark: false, store: memStore({ v: 1, theme: "dark" }) });
  eq(dark.attrs["data-theme"], "dark");
  const light = load({ systemDark: true, store: memStore({ v: 1, theme: "light" }) });
  eq(light.attrs["data-theme"], "light");
});

check("an unset pref stamps the system's palette", () => {
  eq(load({ systemDark: true }).attrs["data-theme"], "dark");
  eq(load({ systemDark: false }).attrs["data-theme"], "light");
});

check("the attribute is never the word auto", () => {
  eq(load({ systemDark: true }).applyTheme("auto"), "dark");
  eq(load({ systemDark: false }).applyTheme("auto"), "light");
  eq(load().applyTheme("nonsense"), "light");
});

check("auto follows a system flip while the page is open", () => {
  const t = load({ systemDark: false });
  eq(t.attrs["data-theme"], "light");
  eq(t.media.added, 1, "auto subscribes to the system change event");
  t.media.matches = true;
  t.media.fn();
  eq(t.attrs["data-theme"], "dark");
});

check("an explicit choice stops following the system", () => {
  const t = load({ systemDark: true });
  eq(t.media.added, 1);
  t.applyTheme("light");
  eq(t.attrs["data-theme"], "light");
  eq(t.media.removed, 1, "the subscription is dropped once the pref is not auto");
  eq(t.media.fn, null, "no listener is left behind to repaint");
});

check("going back to auto resubscribes", () => {
  const t = load({ systemDark: false });
  t.applyTheme("dark");
  eq(t.media.removed, 1);
  t.applyTheme("auto");
  eq(t.media.added, 2);
  eq(t.attrs["data-theme"], "light");
});

check("an older WebView with only addListener still follows the system", () => {
  const attrs = {};
  const media = {
    matches: false,
    legacyAdded: 0,
    addListener(fn) { this.legacyAdded++; this.fn = fn; }
  };
  global.window = { matchMedia: () => media, localStorage: memStore() };
  global.document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  new Function(src)();
  eq(media.legacyAdded, 1);
  media.matches = true;
  media.fn();
  eq(attrs["data-theme"], "dark");
});

if (failures.length) {
  console.error(failures.length + " theme test(s) failed:\n");
  for (const failure of failures) { console.error("  - " + failure); }
  process.exit(1);
}
console.log(pass + " theme tests passing");
