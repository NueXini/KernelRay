import { T } from "./i18n.js";
import { els } from "./els.js";
import { exec, CLI, SUBFETCH_URL, hasBridge, writeFile, subFile, readState, readJsonDir, SUBS_DIR } from "./bridge.js";
import { parseInput, identityOf, idOf, subIdOf } from "./parse.js";
import { mergeSubscriptionNodes, nodeListModel, subGroupRows, subDeleteAllowed } from "./nodelist-model.js";
import { busy, setBusy, toast, refreshPage } from "./main.js";
import { coreRunning, setButtons } from "./status.js";
import { lastStateObj, lastManual, lastSubs, lastApplied, setLastStateObj, renderNodeList, findNodeById, switchTo, deleteNodes, subErrorText, agoText } from "./nodelist.js";
import { copyText, syncDialogScrollLock } from "./dialog.js";
import { closeAdd } from "./import.js";

// 订阅：一个产出节点的 URL。抓取在 shell 里做（WebView 的 fetch 是跨域的，
// 机场不会给 CORS 头，而且 fetch 改不了 User-Agent），所以这里只负责：
// 把 URL 交给 shell、拿回 body、解析、合并进订阅自己的文件
// （config/subscriptions/<id>.json，节点内嵌其中）。state.json 与这里无关，
// 除非自动应用的链条（ADR 0012）需要写 selected。
// 刷新绝不渲染、绝不重启核心——只有用户按「应用」才会碰核心。

var subDialogId = "";     // 订阅详情弹窗显示的订阅 id
var subDialogError = "";  // 本地错误（例如写入失败）
var subDeleteConfirm = false;
var subReveal = false;    // URL 是否明文显示
var subSig = "";

function findSub(subs, id) {
  var list = Array.isArray(subs) ? subs : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === String(id)) { return list[i]; }
  }
  return null;
}

// 把一份订阅写盘：裸订阅对象（id/name/url/nodes/lastFetched/lastError），
// 节点内嵌其中。同一条订阅永远写在同一个文件里——改名只改内容，不改文件名。
function writeSubFile(sub) {
  var f = subFile(sub.id);
  if (!f) { return Promise.reject(new Error("subscription has no usable id")); }
  return writeFile(f, JSON.stringify(sub, null, 2) + "\n", "600");
}

// 名字的默认值：URL 的主机名。它通常没有信息量，但比一串哈希好，
// 用户可以在 ⋯ 里改。
function hostOf(url) {
  var m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || ""));
  var host = m ? m[1] : String(url || "");
  return host.replace(/^.*@/, "").replace(/:\d+$/, "");
}

function maskedUrl(url) {
  var m = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(String(url || ""));
  if (!m) { return "…"; }
  return m[1] + (m[2] ? "/…" : "");
}

// 订阅的日志行走自己的 Sub 标签；消息里永远不出现 URL。
function logSubLine(message) {
  exec(CLI + " mlog append Sub '" + message + "'").catch(function () {});
}

// 把 URL 交给 shell，拿回 body。URL 走 0600 的临时文件而不是 argv：
// 命令行会短暂出现在 /proc/<pid>/cmdline 里，而 URL 里通常带着令牌。
function fetchBody(url) {
  return writeFile(SUBFETCH_URL, String(url) + "\n", "600").then(function () {
    return exec(CLI + " sub fetch");
  }).then(function (r) {
    if (r.errno === 0) { return r.stdout; }
    var stderr = r.stderr || "";
    var reason = /reason=([a-z-]+)/i.exec(stderr);
    var http = /http=(\d+)/i.exec(stderr);
    var err = new Error((reason && reason[1]) || "network");
    err.code = (reason && reason[1]) || "network";
    err.http = http ? http[1] : "";
    throw err;
  });
}

// 解析失败的行不阻塞成功的行：与导入一致，部分失败按行报数。
function parseBody(body) {
  var rows = parseInput(body);
  var ok = rows.filter(function (x) { return x.ok; });
  var bad = rows.filter(function (x) { return !x.ok; });
  ok.forEach(function (x) {
    var n = x.node;
    n.id = n.id || idOf(n);
    delete n.dupOf;
  });
  return { nodes: ok.map(function (x) { return x.node; }), failed: bad.length };
}

// 一次刷新 = 整桶替换。0 个节点按失败处理：机场返回一个错误页不该被
// 当成"订阅真的空了"，那会静默清掉用户的节点。
function applyBody(sub, body) {
  var parsed = parseBody(body);
  if (!parsed.nodes.length) {
    var e = new Error("empty");
    e.code = "empty";
    throw e;
  }
  var res = mergeSubscriptionNodes(sub.nodes || [], parsed.nodes, identityOf);
  sub.nodes = res.nodes;
  sub.lastFetched = Date.now();
  delete sub.lastError;
  return { res: res, failed: parsed.failed };
}

// 失败时保留旧节点，只记下原因码；节点数为 0 的订阅由列表把原因
// 渲染成一行（有节点的订阅只 toast，卡上靠"上次刷新"时间说明新旧）。
// 成功与失败都重写整份订阅文件：节点内嵌，同身份的旧 id 由
// mergeSubscriptionNodes 保留，字段真的变了才标 dirty。
function runFetch(sub) {
  var fail = function (e) {
    var code = e && e.code ? e.code : "network";
    var detail = code === "http" ? "http " + (e.http || "?") : code;
    sub.lastError = detail;
    return writeSubFile(sub).then(function () {
      logSubLine("subscription refresh failed: " + detail);
      var err = new Error(detail);
      err.code = code;
      err.http = e && e.http;
      throw err;
    });
  };
  return fetchBody(sub.url).then(function (body) {
    var out;
    try {
      out = applyBody(sub, body);
    } catch (e) {
      return fail(e);
    }
    return writeSubFile(sub).then(function () {
      var msg = "subscription refresh: " + sub.nodes.length + " nodes (" +
        out.res.added + " new, " + out.res.updated + " updated, " +
        out.res.removed + " removed" +
        (out.failed ? ", " + out.failed + " failed" : "") + ")";
      logSubLine(msg);
      return out;
    });
  }).catch(function (e) {
    // 抓取/解析失败：旧节点保留，原因码写进同一份订阅文件。
    return fail(e);
  });
}

// ADR 0012 的规则同样适用于订阅：库里还没有已应用节点时，添加成功
// 顺带应用一条（当前节点仍能解析就用它，否则列表第一行）。
function firstApplyId(state) {
  if (lastApplied) { return ""; }
  if (state && typeof state.selected === "string" && state.selected &&
      findNodeById(state, state.selected)) {
    return state.selected;
  }
  var model = nodeListModel(state, lastManual, lastSubs, "", identityOf);
  return model.rows.length ? model.rows[0].id : "";
}

// 添加订阅：先建卡再抓取。抓取失败时卡片仍然在列表里，错误留在卡上，
// 用户点刷新重试（Q12=b）。先建卡也意味着失败不会丢掉用户刚输入的 URL。
function addSubscription(url, name) {
  if (busy || !hasBridge) { return; }
  var u = String(url || "").trim();
  if (!/^https?:\/\/\S+$/i.test(u)) {
    toast(T.subBadUrl);
    return;
  }
  var id = subIdOf(u);
  var label = String(name || "").trim();
  var applyId = "";
  setBusy(true);
  setButtons();
  els.sAdd.disabled = true;
  readState().then(function (state) {
    return readJsonDir(SUBS_DIR).then(function (subs) {
      var sub = findSub(subs, id);
      if (!sub) {
        sub = { id: id, name: label || hostOf(u), url: u, nodes: [], lastFetched: 0 };
        subs.push(sub);
      } else {
        // 同一个 URL 就是同一条订阅：重加是原地更新，不复制。
        if (label) { sub.name = label; }
        sub.url = u;
      }
      // 卡片先落盘再抓取（Q12=b）：失败时卡片已经在列表里，错误随后写进
      // 同一份文件。state.json 不参与：订阅是 subscriptions/ 下的文件。
      return writeSubFile(sub).then(function () {
        setLastStateObj(state, null, subs);
        return runFetch(sub);
      });
    });
  }).then(function (out) {
    var sub = findSub(lastSubs, id);
    var n = sub && Array.isArray(sub.nodes) ? sub.nodes.length : 0;
    applyId = firstApplyId(lastStateObj);
    var msg = T.subAdded.replace("{n}", String(n));
    if (out && out.failed) { msg += T.importFailedN.replace("{n}", String(out.failed)); }
    toast(msg);
    closeAdd();
  }).catch(function (e) {
    var sub = findSub(lastSubs, id);
    var detail = sub && sub.lastError ? sub.lastError : ((e && e.code) || "network");
    toast(T.subAddFailed + ": " + subErrorText(detail, e && e.http));
    // 卡片已经写进 subscriptions/ 时关掉弹窗：原因就在卡片上，用户点刷新
    // 重试即可。写盘本身失败则留在弹窗里，URL 不至于丢掉。
    if (sub) { closeAdd(); }
  }).then(function () {
    setBusy(false);
    setButtons();
    els.sAdd.disabled = false;
    renderNodeList();
    // 在 busy 清除之后：switchTo 在另一个操作占用页面时会拒绝运行。
    if (!applyId) { refreshPage(); return; }
    var node = findNodeById(lastStateObj, applyId);
    applyId = "";
    if (node) { switchTo(node); } else { refreshPage(); }
  });
}

function refreshSubscription(subId) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var sub = findSub(lastSubs, subId);
  if (!sub) { return; }
  var applyId = "";
  setBusy(true);
  setButtons();
  renderNodeList();
  runFetch(sub).then(function (out) {
    applyId = firstApplyId(lastStateObj);
    var msg = T.subRefreshed.replace("{n}", String(sub.nodes.length));
    if (out && out.failed) { msg += T.importFailedN.replace("{n}", String(out.failed)); }
    toast(msg);
  }).catch(function (e) {
    toast(T.subRefreshFailed + ": " + subErrorText(e.code || "network", e.http));
  }).then(function () {
    setBusy(false);
    setButtons();
    renderNodeList();
    if (!applyId) { refreshPage(); return; }
    var node = findNodeById(lastStateObj, applyId);
    applyId = "";
    if (node) { switchTo(node); } else { refreshPage(); }
  });
}

function renameSubscription(subId, name) {
  var sub = findSub(lastSubs, subId);
  var v = String(name || "").trim();
  if (!sub || !v || v === sub.name) { return Promise.resolve(false); }
  sub.name = v;
  // 改名只重写内容：文件名由 id 定，不跟着改（id 是 url 的哈希，与
  // 名字无关）。
  return writeSubFile(sub).then(function () {
    renderNodeList();
    return true;
  });
}

function deleteSubscription(subId) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var sub = findSub(lastSubs, subId);
  if (!sub) { return; }
  var model = nodeListModel(lastStateObj, lastManual, lastSubs, lastApplied, identityOf);
  if (!subDeleteAllowed(model, subId, coreRunning())) {
    toast(T.subDeleteRefused);
    return;
  }
  var ids = (Array.isArray(sub.nodes) ? sub.nodes : [])
    .filter(function (n) { return n && n.id !== null && n.id !== undefined && n.id !== ""; })
    .map(function (n) { return String(n.id); });
  setBusy(true);
  setButtons();
  renderNodeList();
  deleteNodes(ids, [subId], { quiet: true }).then(function () {
    logSubLine("subscription deleted: " + ids.length + " nodes");
    toast(T.subDeleted.replace("{n}", String(ids.length)));
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    setBusy(false);
    setButtons();
    refreshPage();
  });
}

// ---- subscription dialog ----
// ⋯ 打开的订阅详情弹窗：改名、看（打码的）URL、复制 URL、删除。
// 与节点详情弹窗一样，打开它绝不写任何东西。

function openSubDialog(subId) {
  if (busy || !hasBridge || !lastStateObj || !els.overlay.hidden) { return; }
  subDialogId = String(subId);
  subDialogError = "";
  subDeleteConfirm = false;
  subReveal = false;
  subSig = "";
  els.subOverlay.hidden = false;
  syncDialogScrollLock();
  renderSubDialog();
}

function closeSubDialog() {
  subDialogId = "";
  subDialogError = "";
  subDeleteConfirm = false;
  subReveal = false;
  subSig = "";
  els.subOverlay.hidden = true;
  syncDialogScrollLock();
}

function renderSubDialog() {
  if (!subDialogId) { return; }
  var sub = findSub(lastSubs, subDialogId);
  if (!sub) { closeSubDialog(); return; }
  var model = nodeListModel(lastStateObj, lastManual, lastSubs, lastApplied, identityOf);
  var rows = subGroupRows(model, subDialogId);
  var sig = [sub.name || "", sub.url || "", sub.lastFetched || 0, sub.lastError || "",
    lastApplied || "", rows.length,
    subDeleteConfirm ? 1 : 0, subReveal ? 1 : 0, busy ? 1 : 0, subDialogError || ""].join("\n");
  if (sig === subSig) { return; }
  subSig = sig;
  els.sdTitle.textContent = sub.name || sub.id;
  els.sdName.value = sub.name || "";
  // 打码时用省略号截断而不是让输入框从右边吃掉：截断本身要让用户看见
  // "这里还有东西"，否则打码看起来就是完整地址。
  els.sdUrl.textContent = subReveal ? sub.url : maskedUrl(sub.url);
  els.sdUrl.classList.toggle("revealed", subReveal);
  els.sdReveal.textContent = subReveal ? T.hide : T.show;
  // 删除的第二次点按：问题写在说明行上，按钮保持"删除"，旁边多出取消。
  els.sdMeta.textContent = subDeleteConfirm
    ? T.deleteConfirmSub.replace("{n}", String(rows.length))
    : T.nodeCount.replace("{n}", String(rows.length)) + " · " +
      (sub.lastFetched ? agoText(sub.lastFetched) : T.neverFetched);
  var detail = sub.lastError ? subErrorText(sub.lastError) : subDialogError;
  els.sdError.textContent = detail;
  els.sdError.hidden = !detail;
  els.sdDelete.textContent = T.delete;
  els.sdCancel.hidden = !subDeleteConfirm;
  els.sdSave.disabled = busy;
  els.sdCopy.disabled = busy;
  els.sdDelete.disabled = busy;
  els.sdName.disabled = busy;
}

function saveSubName() {
  if (busy || !subDialogId) { return; }
  var id = subDialogId;
  renameSubscription(id, els.sdName.value).then(function (changed) {
    if (changed) { closeSubDialog(); }
  }).catch(function (e) {
    subDialogError = e.message || String(e);
    subSig = "";
    renderSubDialog();
  });
}

function copySubUrl() {
  var sub = findSub(lastStateObj, subDialogId);
  if (!sub) { return; }
  copyText(sub.url).then(function () {
    toast(T.copiedUrl);
  }).catch(function (e) {
    toast(T.copyFailed + ": " + (e.message || e));
  });
}

function confirmSubDelete() {
  if (busy || !subDialogId) { return; }
  var id = subDialogId;
  if (!subDeleteConfirm) {
    subDeleteConfirm = true;
    renderSubDialog();
    return;
  }
  closeSubDialog();
  deleteSubscription(id);
}

function cancelSubDelete() {
  if (!subDeleteConfirm) { return; }
  subDeleteConfirm = false;
  renderSubDialog();
}

// URL 默认打码：列表和弹窗都可能被旁边的人看到，而它是可用的凭据。
function toggleSubReveal() {
  subReveal = !subReveal;
  renderSubDialog();
}

function invalidateSubDialog() { subSig = ""; }

export {
  subDialogId, subDialogError, subDeleteConfirm, subReveal, subSig,
  findSub, hostOf, maskedUrl, logSubLine, fetchBody, parseBody, applyBody,
  runFetch, firstApplyId, readState, addSubscription, refreshSubscription,
  renameSubscription, deleteSubscription, openSubDialog, closeSubDialog,
  renderSubDialog, saveSubName, copySubUrl, confirmSubDelete, cancelSubDelete,
  toggleSubReveal, invalidateSubDialog
};
