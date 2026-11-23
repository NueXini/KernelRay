import { T } from "./i18n.js";
import { els } from "./els.js";
import { busy, setBusy, toast, refreshPage } from "./main.js";
import { exec, CLI, STATE, SETTINGS, hasBridge, writeState, writeSettings } from "./bridge.js";
import { portsNormalize, portsValidate, portVal } from "./ports.js";
import { dnsVal, dnsValidate } from "./dns.js";
import { lastKv, setButtons } from "./status.js";
import { themePref, langPref, logLines } from "./prefs.js";

// 自上次同步以来用户碰过的端口字段：2s 轮询不能把用户正在填写另一个
// 字段时改过的值重置掉。保存成功后清空，
// 离开设置页时也清空。
var portsDirty = { socks: false, http: false };

// 下拉框直接按偏好渲染：切换语言会重新给 T 赋值，并改变自动选项的
// 标签，所以两者都要经过这里。
function renderPrefs() {
  els.selTheme.value = themePref;
  els.selLang.value = langPref;
  els.selLog.value = String(logLines);
}

// 设置页显示生效的端口（state.json 的取值，已套用默认值），让用户
// 看到的正是 shell 会渲染的结果，即使文件上次是手工写的。
// 状态轮询已经通过 shell 自己的逐字段回退带上了端口，所以本页
// 不再每 2s 读取并解析 state.json。用户正在编辑的字段保持不动：
// 而 2s 轮询也绝不能覆盖正在输入的内容。
function refreshSettings() {
  var kv = lastKv;
  var p = portsNormalize(kv ? { socksPort: kv.socks, httpPort: kv.http } : null);
  if (!portsDirty.socks && document.activeElement !== els.iSocks) {
    els.iSocks.value = String(p.socks);
  }
  if (!portsDirty.http && document.activeElement !== els.iHttp) {
    els.iHttp.value = String(p.http);
  }
}

// 一个手势：先校验并写入 state.json 的 settings（意图优先），再让 shell
// 渲染、校验并重启。渲染或重启失败时旧配置继续运行，并把 CLI 的
// 错误显示出来，与应用节点失败时一样。
function doSavePorts() {
  if (busy || !hasBridge) { return; }
  var err = portsValidate(els.iSocks.value, els.iHttp.value);
  if (err) { toast(T[err]); return; }
  setBusy(true);
  setButtons();
  toast(T.portsSaving);
  exec("cat " + STATE + " 2>/dev/null").then(function (r) {
    var state = null;
    try { state = JSON.parse((r.stdout || "").trim()); } catch (e) { state = null; }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      state = { schema: 1, revision: 0, manual: [], subscriptions: [], selected: "" };
    }
    if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) {
      state.settings = {};
    }
    state.settings.socksPort = portVal(els.iSocks.value);
    state.settings.httpPort = portVal(els.iHttp.value);
    state.revision = (Number(state.revision) || 0) + 1;
    return writeState(state).then(function () {
      return exec(CLI + " ports");
    }).then(function (r) {
      if (r.errno !== 0) { toast(T.actionFailed + ": " + (r.stderr || r.errno)); }
      else {
        // 保存的值现在就是生效值；让轮询再同步一次字段即可。
        portsDirty.socks = false;
        portsDirty.http = false;
        toast(T.portsSaved);
      }
    });
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    setBusy(false);
    setButtons();
    refreshPage();
  });
}

function resetPortsDirty() {
  portsDirty.socks = false;
  portsDirty.http = false;
}
function setPortDirty(field, val) { portsDirty[field] = val; }

// ---- dns upstream settings ----
// 直连DNS/远程DNS 的展示与保存。输入框为空 = 未配置，用 placeholder
// 提示 shell 的兜底值；保存时读-改-写 config/settings.json，再交给
// shell 的 `dns` 命令渲染/重启（与端口的手势同构）。
var dnsDirty = { direct: false, remote: false };

function parseSettings(text) {
  var s = null;
  try { s = JSON.parse((text || "").trim()); } catch (e) { s = null; }
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

// 状态轮询不经过 settings.json，本页自己拉：空值保持空输入框。
// 与端口一样，用户正在编辑的字段绝不被轮询覆盖。
function refreshDns() {
  if (!hasBridge) { return; }
  return exec("cat " + SETTINGS + " 2>/dev/null").then(function (r) {
    var s = parseSettings(r.stdout);
    var d = dnsVal(s.directDns);
    var w = dnsVal(s.remoteDns);
    if (!dnsDirty.direct && document.activeElement !== els.iDnsDirect) {
      els.iDnsDirect.value = d;
    }
    if (!dnsDirty.remote && document.activeElement !== els.iDnsRemote) {
      els.iDnsRemote.value = w;
    }
  });
}

function doSaveDns() {
  if (busy || !hasBridge) { return; }
  var d = dnsVal(els.iDnsDirect.value);
  var w = dnsVal(els.iDnsRemote.value);
  var err = dnsValidate(d, w);
  if (err) { toast(T[err]); return; }
  setBusy(true);
  setButtons();
  toast(T.dnsSaving);
  exec("cat " + SETTINGS + " 2>/dev/null").then(function (r) {
    var s = parseSettings(r.stdout);
    // 空值等于未配置：删键而不是留空串。
    if (d) { s.directDns = d; } else { delete s.directDns; }
    if (w) { s.remoteDns = w; } else { delete s.remoteDns; }
    return writeSettings(s).then(function () {
      return exec(CLI + " dns");
    }).then(function (r) {
      if (r.errno !== 0) { toast(T.actionFailed + ": " + (r.stderr || r.errno)); }
      else {
        dnsDirty.direct = false;
        dnsDirty.remote = false;
        toast(T.dnsSaved);
      }
    });
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    setBusy(false);
    setButtons();
    refreshPage();
  });
}

function resetDnsDirty() {
  dnsDirty.direct = false;
  dnsDirty.remote = false;
}
function setDnsDirty(field, val) { dnsDirty[field] = val; }
// ---- end dns upstream settings ----

export { portsDirty, renderPrefs, refreshSettings, doSavePorts, resetPortsDirty, setPortDirty, dnsDirty, refreshDns, doSaveDns, resetDnsDirty, setDnsDirty };
