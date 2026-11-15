import { bytesToBase64 } from "./links.js";

var MOD = "/data/adb/modules/KernelRay";
var CLI = MOD + "/scripts/kernelray.sh";
// 配置、节点库和日志也都放在模块目录里——只有一个根，不写到它之外。
var STATE = MOD + "/state.json";
var APPLIED = MOD + "/runtime/applied";
var OUTBOUND = MOD + "/outbound.json";
var OUTBOUND_META = MOD + "/outbound.meta";

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
  var cmd = "printf '%s' '" + b64 + "' | base64 -d > " + path + ".tmp && chmod " + mode +
    " " + path + ".tmp && mv " + path + ".tmp " + path;
  return exec(cmd).then(function (r) {
    if (r.errno !== 0) { throw new Error(r.stderr || ("exit " + r.errno)); }
  });
}

function writeState(state) {
  return writeFile(STATE, JSON.stringify(state, null, 2) + "\n", "600");
}

export { MOD, CLI, STATE, APPLIED, OUTBOUND, OUTBOUND_META, LOG_LEVELS, hasBridge, exec, parseKv, writeFile, writeState };
