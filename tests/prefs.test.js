// UI preference tests for the WebUI's Settings page.
//
// The prefs model lives inside module/webroot/app.js; this harness extracts the marked block
// from the shipped file, exactly like tests/parse.test.js does for the parser. Normalising,
// loading and saving prefs is pure logic over a storage handle, so it can be tested without
// a browser or a WebView.
//
//   node tests/prefs.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const jsPath = path.join(__dirname, "..", "module", "webroot", "app.js");
const js = fs.readFileSync(jsPath, "utf8");

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
  " PREFS_KEY: PREFS_KEY, LANGS: LANGS, LOG_LINE_STEPS: LOG_LINE_STEPS" +
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

// A storage handle that behaves like localStorage; throws on every access when asked to.
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
  eq(P.prefsNormalize(null), { lang: "auto", logLines: 200 });
  eq(P.prefsNormalize(undefined), { lang: "auto", logLines: 200 });
  eq(P.prefsNormalize("junk"), { lang: "auto", logLines: 200 });
});

check("valid prefs pass through unchanged", () => {
  eq(P.prefsNormalize({ lang: "zh", logLines: 500 }), { lang: "zh", logLines: 500 });
  eq(P.prefsNormalize({ lang: "en", logLines: 100 }), { lang: "en", logLines: 100 });
});

check("unknown values fall back field by field", () => {
  eq(P.prefsNormalize({ lang: "fr", logLines: 500 }), { lang: "auto", logLines: 500 });
  eq(P.prefsNormalize({ lang: "zh", logLines: 300 }), { lang: "zh", logLines: 200 });
  eq(P.prefsNormalize({ lang: true, logLines: "200 lines" }), { lang: "auto", logLines: 200 });
});

check("a logLines given as a numeric string is coerced, not accepted blindly", () => {
  eq(P.prefsNormalize({ logLines: "500" }), { lang: "auto", logLines: 500 });
  eq(P.prefsNormalize({ logLines: "abc" }), { lang: "auto", logLines: 200 });
});

check("extra fields from a future version are dropped, not preserved", () => {
  eq(P.prefsNormalize({ lang: "en", logLines: 100, v: 9, theme: "dark" }),
    { lang: "en", logLines: 100 });
});

check("prefsLoad reads the kernelray.prefs key", () => {
  const store = memStore();
  store.setItem("kernelray.prefs", JSON.stringify({ v: 1, lang: "zh", logLines: 500 }));
  eq(P.prefsLoad(store), { lang: "zh", logLines: 500 });
});

check("prefsLoad with nothing stored returns the defaults", () => {
  eq(P.prefsLoad(memStore()), { lang: "auto", logLines: 200 });
});

check("prefsLoad survives invalid JSON and a null-ish store", () => {
  const store = memStore();
  store.setItem("kernelray.prefs", "{not json");
  eq(P.prefsLoad(store), { lang: "auto", logLines: 200 });
  eq(P.prefsLoad(null), { lang: "auto", logLines: 200 });
  eq(P.prefsLoad(denyStore), { lang: "auto", logLines: 200 });
});

check("prefsSave writes v/lang/logLines and round-trips through prefsLoad", () => {
  const store = memStore();
  P.prefsSave(store, P.prefsNormalize({ lang: "en", logLines: 100 }));
  eq(JSON.parse(store.getItem("kernelray.prefs")), { v: 1, lang: "en", logLines: 100 });
  eq(P.prefsLoad(store), { lang: "en", logLines: 100 });
});

check("prefsSave normalises before persisting", () => {
  const store = memStore();
  P.prefsSave(store, { lang: "zh", logLines: 999, extra: 1 });
  eq(JSON.parse(store.getItem("kernelray.prefs")), { v: 1, lang: "zh", logLines: 200 });
});

check("prefsSave against a denied store does not throw", () => {
  P.prefsSave(denyStore, { lang: "zh", logLines: 200 });
});

check("the presets the Settings page offers are the ones normalise accepts", () => {
  eq(P.LANGS, ["auto", "zh", "en"]);
  eq(P.LOG_LINE_STEPS, [100, 200, 500]);
});

if (failures.length) {
  console.error(failures.length + " prefs test(s) failed:\n");
  for (const failure of failures) { console.error("  - " + failure); }
  process.exit(1);
}
console.log(pass + " prefs tests passing");
