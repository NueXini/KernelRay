// WebUI 的语法与引用检查（parse + link，不执行任何模块代码）。
//
// webroot/js/ 是 ES 模块且没有构建步骤，`node --check` 认不出 .js 里的
// import/export，因此用 vm.SourceTextModule 处理：先逐文件 parse，再把
// 整个模块图 link 起来——link 会解析每个相对 import 指向的文件与导出的
// 绑定名，写错路径或导出名在这里失败，而不是装到设备上才暴露。theme.js
// 是经典脚本，用 vm.Script。最后校验 index.html 引用的每个 css/js 文件
// 都存在。
//
//   运行：node --experimental-vm-modules scripts/check-webui.js [webroot]
//
// 可选的 webroot 参数用于变异测试：把 module/webroot 复制一份、故意改坏
// 一个 import，指向副本运行应当变红——证明检查器真能拦住它声称拦的错误。

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const webroot = path.resolve(process.argv[2] || path.join(__dirname, "..", "module", "webroot"));
let failures = 0;
let checks = 0;

function fail(name, e) {
  failures++;
  console.error("fail " + name + "\n    " + e.message);
}

async function main() {
// 1. js/ 下每个模块按 ES 模块解析（parse-only）。
const jsDir = path.join(webroot, "js");
const moduleNames = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort();
const modules = new Map(); // "js/<name>" -> SourceTextModule
for (const f of moduleNames) {
  const id = "js/" + f;
  try {
    modules.set(id, new vm.SourceTextModule(fs.readFileSync(path.join(jsDir, f), "utf8"), { identifier: id }));
    console.log("ok " + id);
    checks++;
  } catch (e) { fail(id, e); }
}

// 2. 整图 link：解析每个 import 的目标模块与绑定名。不 evaluate——
//    模块顶层会触碰 DOM 与 ksu 桥接，浏览器之外执行不了，也不该执行。
function resolveModule(specifier, referrer) {
  const from = referrer.identifier;
  if (!specifier.startsWith(".")) {
    throw new Error(from + " has a non-relative import: " + specifier);
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (!modules.has(target)) {
    throw new Error(from + " imports " + specifier + ", which does not resolve to " + target);
  }
  return modules.get(target);
}
try {
  // 顺序 link：并发 Promise.all 会在 vm 里撞出竞态（"module that is not linked"）。
  // 跳过已随前一次 link 递归链接过的模块，否则报 "already been linked"。
  for (const m of modules.values()) {
    if (m.status === "unlinked") { await m.link(resolveModule); }
  }
  console.log("ok module graph (" + modules.size + " modules linked)");
  checks++;
} catch (e) { fail("module graph", e); }

// 3. theme.js 按经典脚本解析（它在 <head> 里先于模块执行）。
try {
  new vm.Script(fs.readFileSync(path.join(webroot, "theme.js"), "utf8"),
                { identifier: "theme.js" });
  console.log("ok theme.js");
  checks++;
} catch (e) { fail("theme.js", e); }

// 4. index.html 引用的 css/js 文件都存在。
const html = fs.readFileSync(path.join(webroot, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  .filter((ref) => !/^(https?:)?\/\//.test(ref) && !ref.startsWith("#"));
  for (const ref of refs) {
    if (fs.existsSync(path.join(webroot, ref))) {
      console.log("ok " + ref);
      checks++;
    } else {
      fail(ref, new Error("file referenced by index.html does not exist"));
    }
  }
}

main().then(() => {
  if (failures) {
    console.error(failures + " failure(s)");
    process.exit(1);
  }
  console.log(checks + " check(s) passed");
}, (e) => {
  console.error("check-webui crashed: " + (e && e.stack || e));
  process.exit(1);
});
