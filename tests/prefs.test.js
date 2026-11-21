// 针对 WebUI 设置页的界面偏好测试。
//
// 偏好模型位于 module/webroot/js/prefs.js 与 module/webroot/js/ports.js 中；本测试框架从随包文件里抽出带标记的
// 代码块，与 tests/parse.test.js 抽取解析器的做法完全一致。偏好的规范化、
// 原文解析/序列化与来源决策（文件、旧 localStorage blob）都是纯逻辑，
// 因此无需浏览器、WebView 或真实文件系统即可测试。
//
//   运行：node tests/prefs.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const prefsPath = path.join(__dirname, "..", "module", "webroot", "js", "prefs.js");
const portsPath = path.join(__dirname, "..", "module", "webroot", "js", "ports.js");
const prefsJs = fs.readFileSync(prefsPath, "utf8");
const portsJs = fs.readFileSync(portsPath, "utf8");

// 偏好代码块从 theme.js 取得键名与主题校验；设备上 <head> 先于 js/prefs.js 加载它。
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
const from = prefsJs.indexOf(START);
const to = prefsJs.indexOf(END);
if (from < 0 || to < 0) {
  console.error("could not find the UI preferences block markers in prefs.js");
  process.exit(1);
}

const block = prefsJs.slice(from, to);
const P = new Function(block + "\nreturn {" +
  " prefsNormalize: prefsNormalize, prefsParse: prefsParse, prefsSerialize: prefsSerialize," +
  " prefsSource: prefsSource, PREFS_KEY: PREFS_KEY, LANGS: LANGS, THEMES: THEMES, LOG_LINE_STEPS: LOG_LINE_STEPS" +
"};")();

// 入站端口代码块遵循同样的抽取约定。
const PORTS_START = "// ---- inbound port settings ----";
const PORTS_END = "// ---- end inbound port settings ----";
const pfrom = portsJs.indexOf(PORTS_START);
const pto = portsJs.indexOf(PORTS_END);
if (pfrom < 0 || pto < 0) {
  console.error("could not find the inbound port settings block markers in ports.js");
  process.exit(1);
}
const PB = new Function(portsJs.slice(pfrom, pto) + "\nreturn {" +
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

// 偏好文件（config/webui/preferences.json）与旧 localStorage blob 是同一
// 形状（v/theme/lang/logLines），来源决策的输入都是原文，不再是存储句柄：
// fileText = null 表示文件缺失或读不出，legacyRaw 是 localStorage 里的旧
// blob（没有就是 null）。

check("file text is the source of truth when it parses", () => {
  eq(P.prefsSource(JSON.stringify({ v: 1, theme: "dark", lang: "zh", logLines: 500 }), null),
    { prefs: { theme: "dark", lang: "zh", logLines: 500 }, seed: null });
  // 旧 blob 还在时也不回头用它：文件能解析就是事实。
  eq(P.prefsSource(JSON.stringify({ v: 1, theme: "light", lang: "en", logLines: 100 }),
    JSON.stringify({ v: 1, theme: "dark", lang: "zh", logLines: 500 })),
    { prefs: { theme: "light", lang: "en", logLines: 100 }, seed: null });
});

check("a file with extra/unknown fields loads field by field and does not seed", () => {
  eq(P.prefsSource(JSON.stringify({ v: 1, lang: "zh", logLines: 500, fontSize: 18 }), null),
    { prefs: { theme: "auto", lang: "zh", logLines: 500 }, seed: null });
});

check("a corrupted file loads as the defaults and does not seed from the old blob", () => {
  // 文件存在但读不出内容：内存里落到默认值；不播种——坏文件不该被
  // 旧 blob 覆盖，用户下次仍能看到"文件坏了"这个事实。
  eq(P.prefsSource("{not json", JSON.stringify({ v: 1, theme: "dark", lang: "zh" })),
    { prefs: { theme: "auto", lang: "auto", logLines: 200 }, seed: null });
});

check("a missing file seeds the preferences.json from the legacy blob once", () => {
  const got = P.prefsSource(null, JSON.stringify({ v: 1, theme: "dark", lang: "zh", logLines: 500 }));
  eq(got.prefs, { theme: "dark", lang: "zh", logLines: 500 });
  // 播种串是规范化前的原样搬迁：旧 blob 写什么就搬什么。
  eq(JSON.parse(got.seed), { v: 1, theme: "dark", lang: "zh", logLines: 500 });
});

check("a legacy blob with junk fields is normalized into the seed", () => {
  const got = P.prefsSource(null, JSON.stringify({ v: 9, theme: "sepia", lang: "zh", logLines: 999, extra: 1 }));
  eq(got.prefs, { theme: "auto", lang: "zh", logLines: 200 });
  eq(JSON.parse(got.seed), { v: 1, theme: "auto", lang: "zh", logLines: 200 });
});

check("no file and no legacy blob: defaults, nothing to seed", () => {
  eq(P.prefsSource(null, null), { prefs: { theme: "auto", lang: "auto", logLines: 200 }, seed: null });
  eq(P.prefsSource(null, ""), { prefs: { theme: "auto", lang: "auto", logLines: 200 }, seed: null });
  eq(P.prefsSource("", "junk"), { prefs: { theme: "auto", lang: "auto", logLines: 200 }, seed: null });
});

check("an invalid legacy blob is ignored, not seeded", () => {
  eq(P.prefsSource(null, "{not json"), { prefs: { theme: "auto", lang: "auto", logLines: 200 }, seed: null });
  eq(P.prefsSource(null, "[1,2]"), { prefs: { theme: "auto", lang: "auto", logLines: 200 }, seed: null });
});

check("prefsParse reads the same shape from raw text", () => {
  eq(P.prefsParse(JSON.stringify({ v: 1, theme: "dark", lang: "zh", logLines: 500 })),
    { theme: "dark", lang: "zh", logLines: 500 });
  eq(P.prefsParse("{not json"), { theme: "auto", lang: "auto", logLines: 200 });
  eq(P.prefsParse(null), { theme: "auto", lang: "auto", logLines: 200 });
});

check("prefsSerialize normalises before persisting", () => {
  eq(JSON.parse(P.prefsSerialize({ theme: "sepia", lang: "zh", logLines: 999, extra: 1 })),
    { v: 1, theme: "auto", lang: "zh", logLines: 200 });
  // 序列化→解析往返不丢字段。
  eq(P.prefsParse(P.prefsSerialize({ theme: "dark", lang: "en", logLines: 100 })),
    { theme: "dark", lang: "en", logLines: 100 });
});

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
