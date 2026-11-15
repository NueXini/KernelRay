// WebUI 的语法与引用检查（parse-only，不执行任何模块代码）。
//
// webroot/js/ 是 ES 模块且没有构建步骤，`node --check` 认不出 .js 里的
// import/export，因此用 vm.SourceTextModule 逐个解析；theme.js 是经典脚本，
// 用 vm.Script。顺带校验 index.html 引用的每个 css/js 文件都存在——
// 没有构建步骤兜底，引用错误只能装到设备上才暴露，在这里提前拦住。
//
//   运行：node --experimental-vm-modules scripts/check-webui.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const webroot = path.join(__dirname, "..", "module", "webroot");
let failures = 0;
let checked = 0;

function fail(name, e) {
  failures++;
  console.error("fail " + name + "\n    " + e.message);
}

// 1. js/ 下每个模块按 ES 模块解析。
const jsDir = path.join(webroot, "js");
const modules = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort();
for (const f of modules) {
  const src = fs.readFileSync(path.join(jsDir, f), "utf8");
  try {
    new vm.SourceTextModule(src, { identifier: "js/" + f });
    console.log("ok js/" + f);
    checked++;
  } catch (e) { fail("js/" + f, e); }
}

// 2. theme.js 按经典脚本解析（它在 <head> 里先于模块执行）。
try {
  new vm.Script(fs.readFileSync(path.join(webroot, "theme.js"), "utf8"),
                { identifier: "theme.js" });
  console.log("ok theme.js");
  checked++;
} catch (e) { fail("theme.js", e); }

// 3. index.html 引用的 css/js 文件都存在。
const html = fs.readFileSync(path.join(webroot, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  .filter((ref) => !/^(https?:)?\/\//.test(ref) && !ref.startsWith("#"));
for (const ref of refs) {
  if (fs.existsSync(path.join(webroot, ref))) {
    console.log("ok " + ref);
    checked++;
  } else {
    fail(ref, new Error("index.html 引用的文件不存在"));
  }
}

if (failures) {
  console.error(failures + " failure(s)");
  process.exit(1);
}
console.log(checked + " file(s) checked");
