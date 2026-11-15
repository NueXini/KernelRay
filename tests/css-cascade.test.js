// CSS 层叠等价测试：golden 基准是拆分提交前的单文件 app.css
// （tests/fixtures/app.css），被测对象是 module/webroot/css/ 下按
// index.html 的 link 顺序拼接的 6 个文件。
//
// 规则逐字搬运只保证声明不变；同优先级规则的相对顺序决定冲突属性的
// 胜负，而拆分打乱了物理顺序。本测试把两边的"同优先级 + 同属性 +
// 不同值"冲突对各算一遍，要求每一对的胜者相同——即拆分前后层叠行为
// 等价。改动 css 后若本测试变红：要么把规则放回原层叠位，要么确认
// 翻转无害后更新 fixtures/app.css（那是对外承诺的变更，不是随手刷新）。
//
//   运行：node tests/css-cascade.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const webroot = path.join(__dirname, "..", "module", "webroot");
// 与 index.html 的 <link> 顺序一致；顺序本身就是层叠的一部分。
const LINK_ORDER = [
  "css/tokens.css", "css/base.css", "css/log.css", "css/notice.css",
  "css/nodes.css", "css/settings.css", "css/nav.css", "css/overlays.css"
];

let pass = 0;
const failures = [];

function check(name, fn) {
  try { fn(); pass++; } catch (e) { failures.push(name + "\n    " + e.message); }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { throw new Error((what || "value") + "\n      expected " + b + "\n      actual   " + a); }
}

// ---- 一个只够本仓库用的 CSS 解析器（无 @media、无嵌套，平铺规则） ----

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 返回 [{ selector, decls: { prop: value } }]，保持出现顺序。
function parseRules(css) {
  const text = stripComments(css);
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) { break; }
    const close = text.indexOf("}", open);
    if (close < 0) { throw new Error("unbalanced braces at offset " + open); }
    const selector = text.slice(i, open).trim();
    const body = text.slice(open + 1, close);
    const decls = {};
    body.split(";").forEach((decl) => {
      const j = decl.indexOf(":");
      if (j <= 0) { return; }
      const prop = decl.slice(0, j).trim().toLowerCase();
      const value = decl.slice(j + 1).trim().replace(/\s+/g, " ");
      if (prop) { decls[prop] = value; }
    });
    if (selector) { rules.push({ selector: selector.replace(/\s+/g, " "), decls }); }
    i = close + 1;
  }
  return rules;
}

// ---- 特异性（a,b,c），:not 取其参数的特异性 ----

function specificity(selector) {
  // :not(X) 贡献 X 的特异性：把参数原位展开后再统一计数。
  const flat = selector.replace(/:not\(([^()]*)\)/g, " $1 ");
  let a = 0, b = 0, c = 0;
  const tokens = flat.match(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::[\w-]+|:[\w-]+|[a-zA-Z][\w-]*|\*/g) || [];
  for (const t of tokens) {
    if (t[0] === "#") { a++; }
    else if (t[0] === "." || t[0] === "[") { b++; }
    else if (t[0] === ":") { b++; }
    else if (t === "*") { /* 零 */ }
    else { c++; } // 类型选择器（伪元素已被 :: 分离为 b 计——本仓库没有伪元素冲突，可接受）
  }
  return [a, b, c];
}

// 同文件内出现两次的同一选择器会让"胜者=后者"失真，先断言没有。
function assertUniqueSelectors(rules, source) {
  const seen = {};
  for (const r of rules) {
    if (seen[r.selector]) { throw new Error("duplicate selector in " + source + ": " + r.selector); }
    seen[r.selector] = 1;
  }
}

// 所有的 (较早规则, 较晚规则, 属性) 冲突对：同特异性、双方都声明该属性
// 且值不同。胜者恒为较晚者，所以键不需要存胜者。
function conflictPairs(rules) {
  const pairs = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (specificity(rules[i].selector).join(",") !== specificity(rules[j].selector).join(",")) { continue; }
      for (const prop of Object.keys(rules[i].decls)) {
        if (rules[j].decls[prop] !== undefined && rules[j].decls[prop] !== rules[i].decls[prop]) {
          pairs.push(rules[i].selector + " < " + rules[j].selector + " :: " + prop);
        }
      }
    }
  }
  return pairs.sort();
}

function diffSets(actual, expected, what) {
  const missing = expected.filter((k) => actual.indexOf(k) < 0);
  const extra = actual.filter((k) => expected.indexOf(k) < 0);
  if (missing.length || extra.length) {
    const show = (keys) => keys.map((k) => "      " + k).join("\n");
    throw new Error(what + "\n      lost conflict pairs (in fixture, absent now):\n" + show(missing) +
      "\n      new conflict pairs (now, absent in fixture):\n" + show(extra));
  }
}

// ---- 特异性计算器的自检（选本仓库真实存在、易算错的选择器） ----

check("specificity sanity", () => {
  eq(specificity("html[data-theme=\"dark\"]"), [0, 1, 1], "html[data-theme]");
  eq(specificity(".logtab.active"), [0, 2, 0], ".logtab.active");
  eq(specificity("#page-log:not([hidden])"), [1, 1, 0], "#page-log:not([hidden])");
  eq(specificity(".nrow.applied.editing"), [0, 3, 0], ".nrow.applied.editing");
  eq(specificity("body.dialog-open"), [0, 1, 1], "body.dialog-open");
  eq(specificity(".prow.bad .pmeta"), [0, 3, 0], ".prow.bad .pmeta");
});

// ---- 现状：按 link 顺序拼接的 6 个文件 ----

const liveCss = LINK_ORDER.map((f) => fs.readFileSync(path.join(webroot, f), "utf8")).join("\n");
const liveRules = parseRules(liveCss);
const fixtureRules = parseRules(fs.readFileSync(path.join(__dirname, "fixtures", "app.css"), "utf8"));
assertUniqueSelectors(liveRules, "concatenated css/");
assertUniqueSelectors(fixtureRules, "fixtures/app.css");

// 逐字搬运的另一面：两边规则数与声明总量应一致。
check("rule and declaration counts match the fixture", () => {
  const count = (rules) => rules.reduce((n, r) => n + Object.keys(r.decls).length, 0);
  eq(liveRules.length, fixtureRules.length, "rule count");
  eq(count(liveRules), count(fixtureRules), "declaration count");
});

check("cascade winners match the pre-split stylesheet", () => {
  diffSets(conflictPairs(liveRules), conflictPairs(fixtureRules), "same-specificity conflict winner set");
});

// ---- 输出 ----

if (failures.length) {
  console.error(failures.length + " cascade test(s) failing:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(pass + " css cascade tests passing");
