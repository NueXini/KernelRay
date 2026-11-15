import { T } from "./i18n.js";
import { els } from "./els.js";
import { busy, setBusy, toast, refreshPage } from "./main.js";
import { exec, CLI, STATE, hasBridge, writeState } from "./bridge.js";
import { parseInput, identityOf, idOf } from "./parse.js";
import { applyAfterImport } from "./nodelist-model.js";
import { lastStateObj, lastApplied, setLastStateObj, findNodeById, switchTo, renderNodeList } from "./nodelist.js";
import { setButtons } from "./status.js";
import { dialogId, dialogBusy, syncDialogScrollLock } from "./dialog.js";

// ---- node import UI ----

// 重新导入会原地更新节点并保留其 id，因此当前节点与所有指向它的引用
// 都能存活；只有真正新的身份才追加。对节点库建一份索引，
// 使导入 N 个节点是 O(N)，而不是每节点都扫一遍列表。
function mergeNodes(state, nodes) {
  if (!state.schema) { state.schema = 1; }
  if (!Array.isArray(state.manual)) { state.manual = []; }
  if (!Array.isArray(state.subscriptions)) { state.subscriptions = []; }
  var byIdentity = Object.create(null);
  state.manual.forEach(function (n) {
    if (!n || !n.protocol || !n.address) { return; }
    var ident = identityOf(n);
    if (!byIdentity[ident]) { byIdentity[ident] = n; }
  });
  var added = 0, updated = 0;
  nodes.forEach(function (n) {
    delete n.dupOf;
    var ident = identityOf(n);
    var existing = byIdentity[ident] || null;
    if (existing) {
      var keepId = existing.id || idOf(n);
      Object.keys(n).forEach(function (k) { if (k !== "id") { existing[k] = n[k]; } });
      existing.id = keepId;
      // 同一个 id，凭证/传输可能变了：已应用的配置就此过时。
      // 列表会一直标记它，直到下一次成功应用清除该标记。
      existing.dirty = true;
      updated++;
    } else {
      n.id = n.id || idOf(n);
      state.manual.push(n);
      byIdentity[ident] = n;
      added++;
    }
  });
  return { added: added, updated: updated };
}

function previewLine(text, cls) {
  var row = document.createElement("div");
  row.className = "prow " + cls;
  var num = document.createElement("span");
  num.className = "pnum";
  num.textContent = text.num;
  row.appendChild(num);
  var body = document.createElement("div");
  body.className = "pbody";
  var name = document.createElement("div");
  name.className = "pname";
  name.textContent = text.name;
  body.appendChild(name);
  if (text.meta) {
    var meta = document.createElement("div");
    meta.className = "pmeta";
    meta.textContent = text.meta;
    body.appendChild(meta);
  }
  row.appendChild(body);
  return row;
}

// 部分失败时弹窗仍盖在用户输入之上：导入成功的行已经完成，
// 失败的行列在这里，便于修改后重试。
function renderFailedRows(rows) {
  els.iPreview.textContent = "";
  rows.forEach(function (r) {
    els.iPreview.appendChild(previewLine(
      { num: r.line, name: r.error, meta: T.lineNo + r.line + T.lineNoEnd }, "bad"));
  });
}

// 模块日志里由 UI 侧节点库改动写下的导入/删除行：shell 看不到它们——
// 页面直接经桥接写节点库——因此 `mlog append` 是唯一入口。
// 尽力而为：一行日志写失败绝不能影响操作本身的结果。用单引号：
// 消息只含数字、空格和括号。
function logNodeLine(message) {
  exec(CLI + " mlog append Node '" + message + "'").catch(function () {});
}

// 日志行与 toast 的数字一致：全是新增时读作 (3 new)，
// 混合时读作 (2 updated, 1 failed)；既无失败也无更新时不带后缀段。
function importLogLine(added, updated, failed) {
  var msg = "imported " + (added + updated) + " nodes";
  var bits = [];
  if (added) { bits.push(String(added) + " new"); }
  if (updated) { bits.push(String(updated) + " updated"); }
  if (failed) { bits.push(String(failed) + " failed"); }
  if (bits.length) { msg += " (" + bits.join(", ") + ")"; }
  return msg;
}

// 一个手势：解析输入，把可解析的行合并进节点库。还没有已应用节点时，
// 同一手势也会切换到 applyAfterImport 指定的节点（ADR 0012）；
// 已经有已应用节点时，只有节点库发生变化。
function doImport() {
  if (busy || !hasBridge) { return; }
  var rows = parseInput(els.iText.value);
  var ok = rows.filter(function (r) { return r.ok; });
  if (!ok.length) {
    els.iPreview.textContent = "";
    toast(T.importEmpty);
    return;
  }
  var bad = rows.filter(function (r) { return !r.ok; });
  var nextId = "";

  setBusy(true);
  setButtons();
  els.iApply.disabled = true;
  exec("cat " + STATE + " 2>/dev/null").then(function (r) {
    var state = null;
    try { state = JSON.parse((r.stdout || "").trim()); } catch (e) { state = null; }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      state = { schema: 1, revision: 0, manual: [], subscriptions: [], selected: "" };
    }
    var res = mergeNodes(state, ok.map(function (x) { return x.node; }));
    state.revision = (Number(state.revision) || 0) + 1;
    return writeState(state).then(function () {
      // 页面必须持有刚写入的内容：switchTo 会读 lastStateObj，若拿着旧副本，
      // 重新导入的节点在自身应用成功后仍会被标记为有改动。
      setLastStateObj(state);
      nextId = applyAfterImport(state, lastApplied);
      logNodeLine(importLogLine(res.added, res.updated, bad.length));
      var msg = T.importDone + " " + res.added;
      if (res.updated) { msg += T.importUpdated + " " + res.updated; }
      if (!bad.length) {
        toast(msg);
        closeAdd();
        refreshPage();
      } else {
        // 文本保留以便编辑；重新导入是安全的，因为 mergeNodes 按身份更新，
        // 而不是复制出重复项。
        toast(msg + T.importFailedN.replace("{n}", String(bad.length)));
        renderFailedRows(bad);
      }
    });
  }).catch(function (e) {
    nextId = "";
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    setBusy(false);
    setButtons();
    els.iApply.disabled = !els.iText.value.trim();
    renderNodeList();
    // 在 busy 清除之后：switchTo 在另一个操作占用页面时会拒绝运行。
    if (!nextId) { return; }
    var node = findNodeById(lastStateObj, nextId);
    nextId = "";
    if (node) { switchTo(node); }
  });
}

// 添加弹窗不持有路由，也不产生历史记录：返回手势始终属于标签栏。
// 打开时重置内容，因为关闭会丢弃已输入的一切。
function openAdd() {
  if (dialogId || dialogBusy) { return; }
  els.iText.value = "";
  els.iPreview.textContent = "";
  els.iHint.textContent = T.notAppliedYet;
  els.iHint.className = "nodehint";
  els.iApply.disabled = true;
  els.overlay.hidden = false;
  syncDialogScrollLock();
}

function closeAdd() {
  els.overlay.hidden = true;
  syncDialogScrollLock();
}

export { mergeNodes, previewLine, renderFailedRows, logNodeLine, importLogLine, doImport, openAdd, closeAdd };
