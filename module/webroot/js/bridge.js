import { bytesToBase64 } from "./links.js";

var MOD = "/data/adb/modules/KernelRay";
var CLI = MOD + "/scripts/kernelray.sh";
// 所有用户可见的配置都收敛到 config/ 里（目录 0700、文件 0600），只有一个根，
// 不写到它之外：state.json 只剩愿望（selected/settings），节点库与订阅
// 各自一个文件，UI 偏好单独一个子目录，运行时文件在 config/runtime/ 下。
var CONFIG = MOD + "/config";
var STATE = CONFIG + "/state.json";
var APPLIED = CONFIG + "/runtime/applied";
var OUTBOUND = CONFIG + "/outbound.json";
var OUTBOUND_META = CONFIG + "/outbound.meta";
// 节点库：一个手工节点一个文件，文件名是 <id>.json；节点存在 = 文件存在。
var NODES_DIR = CONFIG + "/nodes";
// 订阅：一条订阅一个文件，节点内嵌其中；改内容不改文件名。
var SUBS_DIR = CONFIG + "/subscriptions";
// WebUI 偏好（主题/语言/日志行数），取代 WebView 的 localStorage。
var PREFS_FILE = CONFIG + "/webui/preferences.json";
// 订阅抓取的一次性输入：URL 从 UI 交给 shell，shell 读完立刻删除。
// 走文件而不是命令行参数，因为 /proc/<pid>/cmdline 对 URL 里的令牌
// 没有保护。
var SUBFETCH_URL = CONFIG + "/runtime/subfetch.url";

// 日志等级是核心意图，不是 WebView 偏好：下拉框跟随 shell 的
// 状态（runtime/loglevel），保存的值在下次启动核心时生效（docs/adr/0015）。
var LOG_LEVELS = ["none", "error", "warning", "info", "debug"];

var hasBridge = typeof window.ksu !== "undefined" && typeof window.ksu.exec === "function";

// 桥接的 ksu.exec 是回调式的：ksu.exec(cmd, optionsJson, callbackName)，
// 注入的 WebView 会调用 window[callbackName](errno, stdout, stderr)。
function exec(cmd) {
  return new Promise(function (resolve, reject) {
    if (!hasBridge) { reject(new Error("no bridge")); return; }
    var name = "kc_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    window[name] = function (errno, stdout, stderr) {
      delete window[name];
      resolve({ errno: errno, stdout: stdout || "", stderr: stderr || "" });
    };
    try {
      window.ksu.exec(cmd, JSON.stringify({}), name);
    } catch (e) {
      delete window[name];
      reject(e);
    }
  });
}

function parseKv(text) {
  var out = {};
  (text || "").split("\n").forEach(function (line) {
    var i = line.indexOf("=");
    if (i > 0) { out[line.slice(0, i).trim()] = line.slice(i + 1); }
  });
  return out;
}

function writeFile(path, text, mode) {
  var b64 = bytesToBase64(new TextEncoder().encode(text));
  // 用 tmp + mv，杜绝写了一半的文件；这些文件含凭证，所以权限是 0600。
  // 先 mkdir -p 父目录：config/runtime/ 等子目录由 shell 创建，而页面可能
  // 在它们存在之前就要写订阅抓取用的临时 URL 或节点文件。
  var dir = path.slice(0, path.lastIndexOf("/"));
  var cmd = "mkdir -p " + dir + " && printf '%s' '" + b64 + "' | base64 -d > " + path + ".tmp && chmod " + mode +
    " " + path + ".tmp && mv " + path + ".tmp " + path;
  return exec(cmd).then(function (r) {
    if (r.errno !== 0) { throw new Error(r.stderr || ("exit " + r.errno)); }
  });
}

function writeState(state) {
  return writeFile(STATE, JSON.stringify(state, null, 2) + "\n", "600");
}

// 节点/订阅的文件路径。id 由身份哈希派生，只可能是 [0-9A-Za-z_-]+：
// 拼进路径前再校验一次，它同时是文件名，也等于防御路径注入。
function nodeFile(id) {
  if (!/^[0-9A-Za-z_-]+$/.test(String(id || ""))) { return ""; }
  return NODES_DIR + "/" + id + ".json";
}

function subFile(id) {
  if (!/^[0-9A-Za-z_-]+$/.test(String(id || ""))) { return ""; }
  return SUBS_DIR + "/" + id + ".json";
}

// state.json 的解析与骨架：缺失/损坏时给出最小可用状态。节点库与订阅
// 已经各自是 config/ 下的文件，state.json 里不再有 manual/subscriptions，
// 解析结果也永远不会重新引入它们。
function parseState(text) {
  var s = null;
  try { s = JSON.parse((text || "").trim()); } catch (e) { s = null; }
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    s = { schema: 1, revision: 0, selected: "", settings: {} };
  }
  if (typeof s.selected !== "string") { s.selected = ""; }
  if (!s.settings || typeof s.settings !== "object" || Array.isArray(s.settings)) { s.settings = {}; }
  if (typeof s.revision !== "number" || !isFinite(s.revision)) { s.revision = 0; }
  return s;
}

function readState() {
  return exec("cat " + STATE + " 2>/dev/null").then(function (r) {
    return parseState(r.stdout);
  });
}

function pushJson(out, text) {
  try {
    var v = JSON.parse(text);
    // 只要对象：节点与订阅都是裸对象，数组或其他垃圾视为坏文件。
    if (v && typeof v === "object" && !Array.isArray(v)) { out.push(v); }
  } catch (e) { /* 一个坏文件绝不拖垮整个节点库 */ }
}

// 列出目录下每份 .json：一条记录 = "@@F@@<路径>" 行 + 文件原文。
// 记录用行首标记分隔，而 JSON.stringify 绝不产生裸换行，所以文件内容
// 永远不会冒充标记。目录不存在（glob 不匹配）时返回 []。
function readJsonDir(dir) {
  return exec("for f in " + dir + "/*.json; do [ -f \"$f\" ] && { echo \"@@F@@$f\"; cat \"$f\"; echo; }; done; true")
    .then(function (r) {
      var out = [];
      var cur = null; // null = 还没见到第一条记录，之前的输出忽略
      String(r.stdout || "").split("\n").forEach(function (line) {
        if (line.slice(0, 5) === "@@F@@") {
          if (cur !== null) { pushJson(out, cur); }
          cur = "";
        } else if (cur !== null) {
          cur += line + "\n";
        }
      });
      if (cur !== null && cur.trim() !== "") { pushJson(out, cur); }
      return out;
    });
}

export { MOD, CLI, STATE, APPLIED, OUTBOUND, OUTBOUND_META, SUBFETCH_URL, NODES_DIR, SUBS_DIR, PREFS_FILE, LOG_LEVELS, hasBridge, exec, parseKv, writeFile, writeState, nodeFile, subFile, parseState, readState, readJsonDir };
