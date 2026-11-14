// 针对 WebUI 设置页的界面偏好测试。
//
// 偏好模型位于 module/webroot/app.js 中；本测试框架从随包文件里抽出带标记的
// 代码块，与 tests/parse.test.js 抽取解析器的做法完全一致。偏好的规范化、
// 加载与保存都是针对存储句柄的纯逻辑，因此无需浏览器或 WebView
// 即可测试。
//
//   运行：node tests/prefs.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const jsPath = path.join(__dirname, "..", "module", "webroot", "app.js");
const js = fs.readFileSync(jsPath, "utf8");

// 偏好代码块从 theme.js 取得键名与主题校验；设备上 <head> 先于 app.js 加载它。
// 这里也按同样方式、在 DOM 打桩后加载 theme.js，让测试运行的是随包文件本身，
// 而不是那些规则的一份副本。
const themePath = path.join(__dirname, "..", "module", "webroot", "theme.js");
global.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
};
global.document = { documentElement: { setAttribute() {} } };
new Function(fs.readFileSync(themePath, "utf8"))();
global.KRTheme = global.window.KRTheme;

const START = "// ---- UI preferences ----";
const END = "// ---- end UI preferences ----";
const from = js.indexOf(START);
const to = js.indexOf(END);
if (from < 0 || to < 0) {
  console.error("could not find the UI preferences block markers in app.js");
  process.exit(1);
}

const block = js.slice(from, to);
const P = new Function(block + "\nreturn {" +
  " prefsNormalize: prefsNormalize, prefsLoad: prefsLoad, prefsSave: prefsSave," +
  " PREFS_KEY: PREFS_KEY, LANGS: LANGS, THEMES: THEMES, LOG_LINE_STEPS: LOG_LINE_STEPS" +
"};")();

// 入站端口代码块遵循同样的抽取约定。
const PORTS_START = "// ---- inbound port settings ----";
const PORTS_END = "// ---- end inbound port settings ----";
const pfrom = js.indexOf(PORTS_START);
const pto = js.indexOf(PORTS_END);
if (pfrom < 0 || pto < 0) {
  console.error("could not find the inbound port settings block markers in app.js");
  process.exit(1);
}
const PB = new Function(js.slice(pfrom, pto) + "\nreturn {" +
  " portVal: portVal, portsNormalize: portsNormalize, portsValidate: portsValidate," +
  " PORT_DEFAULTS: PORT_DEFAULTS, TP_PORT: TP_PORT" +
"};")();

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

// 一个行为类似 localStorage 的存储句柄；需要时可让每次访问都抛异常。
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }
  };
}
const denyStore = {
  getItem() { throw new Error("denied"); },
  setItem() { throw new Error("denied"); }
};

check("no input at all: the defaults", () => {
  eq(P.prefsNormalize(null), { theme: "auto", lang: "auto", logLines: 200 });
  eq(P.prefsNormalize(undefined), { theme: "auto", lang: "auto", logLines: 200 });
  eq(P.prefsNormalize("junk"), { theme: "auto", lang: "auto", logLines: 200 });
});

check("valid prefs pass through unchanged", () => {
  eq(P.prefsNormalize({ theme: "dark", lang: "zh", logLines: 500 }),
    { theme: "dark", lang: "zh", logLines: 500 });
  eq(P.prefsNormalize({ theme: "light", lang: "en", logLines: 100 }),
    { theme: "light", lang: "en", logLines: 100 });
  eq(P.prefsNormalize({ theme: "auto", lang: "auto", logLines: 200 }),
    { theme: "auto", lang: "auto", logLines: 200 });
});

check("unknown values fall back field by field", () => {
  eq(P.prefsNormalize({ theme: "dark", lang: "fr", logLines: 500 }),
    { theme: "dark", lang: "auto", logLines: 500 });
  eq(P.prefsNormalize({ theme: "dark", lang: "zh", logLines: 300 }),
    { theme: "dark", lang: "zh", logLines: 200 });
  eq(P.prefsNormalize({ theme: "dark", lang: true, logLines: "200 lines" }),
    { theme: "dark", lang: "auto", logLines: 200 });
});

check("an unknown theme falls back to auto, keeping the other fields", () => {
  eq(P.prefsNormalize({ theme: "midnight", lang: "zh", logLines: 500 }),
    { theme: "auto", lang: "zh", logLines: 500 });
  eq(P.prefsNormalize({ theme: true, lang: "en" }), { theme: "auto", lang: "en", logLines: 200 });
  eq(P.prefsNormalize({ theme: "DARK" }), { theme: "auto", lang: "auto", logLines: 200 });
});

check("a logLines given as a numeric string is coerced, not accepted blindly", () => {
  eq(P.prefsNormalize({ logLines: "500" }), { theme: "auto", lang: "auto", logLines: 500 });
  eq(P.prefsNormalize({ logLines: "abc" }), { theme: "auto", lang: "auto", logLines: 200 });
});

check("extra fields from a future version are dropped, not preserved", () => {
  eq(P.prefsNormalize({ theme: "dark", lang: "en", logLines: 100, v: 9, fontSize: 18 }),
    { theme: "dark", lang: "en", logLines: 100 });
});

check("a blob written before theme existed loads as auto", () => {
  const store = memStore();
  store.setItem("kernelray.prefs", JSON.stringify({ v: 1, lang: "zh", logLines: 500 }));
  eq(P.prefsLoad(store), { theme: "auto", lang: "zh", logLines: 500 });
});

check("prefsLoad reads the kernelray.prefs key", () => {
  const store = memStore();
  store.setItem("kernelray.prefs",
    JSON.stringify({ v: 1, theme: "dark", lang: "zh", logLines: 500 }));
  eq(P.prefsLoad(store), { theme: "dark", lang: "zh", logLines: 500 });
});

check("prefsLoad with nothing stored returns the defaults", () => {
  eq(P.prefsLoad(memStore()), { theme: "auto", lang: "auto", logLines: 200 });
});

check("prefsLoad survives invalid JSON and a null-ish store", () => {
  const store = memStore();
  store.setItem("kernelray.prefs", "{not json");
  eq(P.prefsLoad(store), { theme: "auto", lang: "auto", logLines: 200 });
  eq(P.prefsLoad(null), { theme: "auto", lang: "auto", logLines: 200 });
  eq(P.prefsLoad(denyStore), { theme: "auto", lang: "auto", logLines: 200 });
});

check("prefsSave writes v/theme/lang/logLines and round-trips through prefsLoad", () => {
  const store = memStore();
  P.prefsSave(store, P.prefsNormalize({ theme: "dark", lang: "en", logLines: 100 }));
  eq(JSON.parse(store.getItem("kernelray.prefs")),
    { v: 1, theme: "dark", lang: "en", logLines: 100 });
  eq(P.prefsLoad(store), { theme: "dark", lang: "en", logLines: 100 });
});

check("prefsSave normalises before persisting", () => {
  const store = memStore();
  P.prefsSave(store, { theme: "sepia", lang: "zh", logLines: 999, extra: 1 });
  eq(JSON.parse(store.getItem("kernelray.prefs")),
    { v: 1, theme: "auto", lang: "zh", logLines: 200 });
});

check("saving one pref does not drop the others", () => {
  const store = memStore();
  const prefs = P.prefsLoad(store);
  prefs.lang = "zh";
  P.prefsSave(store, prefs);
  prefs.theme = "dark";
  P.prefsSave(store, prefs);
  eq(P.prefsLoad(store), { theme: "dark", lang: "zh", logLines: 200 });
});

check("prefsSave against a denied store does not throw", () => {
  P.prefsSave(denyStore, { theme: "dark", lang: "zh", logLines: 200 });
});

check("the presets the Settings page offers are the ones normalise accepts", () => {
  eq(P.LANGS, ["auto", "zh", "en"]);
  eq(P.THEMES, ["auto", "light", "dark"]);
  eq(P.LOG_LINE_STEPS, [100, 200, 500]);
});

// ---- inbound port settings ----

check("ports: defaults on no input at all", () => {
  eq(PB.portsNormalize(null), { socks: 10808, http: 10809 });
  eq(PB.portsNormalize(undefined), { socks: 10808, http: 10809 });
  eq(PB.portsNormalize("junk"), { socks: 10808, http: 10809 });
  eq(PB.portsNormalize({}), { socks: 10808, http: 10809 });
});

check("ports: valid settings ports pass through", () => {
  eq(PB.portsNormalize({ socksPort: 11008, httpPort: 11009 }), { socks: 11008, http: 11009 });
  eq(PB.portsNormalize({ socksPort: 1, httpPort: 65535 }), { socks: 1, http: 65535 });
});

check("ports: an invalid port falls back per field, never both", () => {
  eq(PB.portsNormalize({ socksPort: 11008 }), { socks: 11008, http: 10809 });
  eq(PB.portsNormalize({ httpPort: "11009" }), { socks: 10808, http: 11009 });
  eq(PB.portsNormalize({ socksPort: 0, httpPort: 70000 }), { socks: 10808, http: 10809 });
  eq(PB.portsNormalize({ socksPort: "x", httpPort: 1.5 }), { socks: 10808, http: 10809 });
  eq(PB.portsNormalize({ socksPort: NaN, httpPort: Infinity }), { socks: 10808, http: 10809 });
});

check("ports: validation accepts a normal pair", () => {
  eq(PB.portsValidate(11008, 11009), "");
  eq(PB.portsValidate("11008", "11009"), "");
});

check("ports: validation refuses out-of-range and junk", () => {
  eq(PB.portsValidate(0, 11009), "portRange");
  eq(PB.portsValidate(11008, 65536), "portRange");
  eq(PB.portsValidate("", 11009), "portRange");
  eq(PB.portsValidate("abc", 11009), "portRange");
});

check("ports: validation refuses the two local inbounds colliding", () => {
  eq(PB.portsValidate(11008, 11008), "portSame");
});

check("ports: validation refuses the tproxy inbound's port", () => {
  eq(PB.portsValidate(PB.TP_PORT, 11009), "portTp");
  eq(PB.portsValidate(11008, PB.TP_PORT), "portTp");
  eq(PB.TP_PORT, 10810, "the reserved port is the shell's KR_TP_PORT");
});

if (failures.length) {
  console.error(failures.length + " prefs test(s) failed:\n");
  for (const failure of failures) { console.error("  - " + failure); }
  process.exit(1);
}
console.log(pass + " prefs tests passing");
