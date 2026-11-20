import { T } from "./i18n.js";
import { els } from "./els.js";
import { exec, CLI, STATE, APPLIED, OUTBOUND, OUTBOUND_META, parseKv, hasBridge, writeFile, writeState } from "./bridge.js";
import { busy, setBusy, toast, refreshPage } from "./main.js";
import { coreRunning, setButtons } from "./status.js";
import { nodeListModel, deleteGate, batchModel, willUnapply } from "./nodelist-model.js";
import { identityOf } from "./parse.js";
import { outboundOf } from "./outbound.js";
import { dialogId, renderDialog } from "./dialog.js";
import { logNodeLine } from "./import.js";

var lastStateObj = null;

var lastApplied = "";
var lastMetaId = "";
var confirmId = null;

var listSig = "";

// 当前列表渲染所依据的运行状态事实：只有它翻转时 renderStatus 才重绘列表，
// 这样 2s 轮询就不会在手指底下重建工具栏。
var listRunning = null;
// 编辑模式的勾选集合：批量删除会移除哪些行。只存在内存中——勾选是
// 临时意图，不是像 `selected` 那样的愿望——编辑模式结束时清空。
var editMode = false;
var checkSet = {};
var batchConfirm = false;

// 已应用行拒绝删除的原因：列表里还有别的节点就不是死路（先切换再删除）；
// 核心正在运行才是。
function deleteRefusal(model) {
  return model.rows.length > 1 ? T.deleteApplied : T.deleteRunning;
}

// 编辑模式只有在删除门槛允许时才能勾选已应用行，这样批量删除与行上的 ✕
// 保持一致。
function canCheckNode(node) {
  if (!(lastApplied && lastApplied === node.id)) { return true; }
  return deleteGate(nodeListModel(lastStateObj, lastApplied, identityOf), coreRunning());
}

function findNodeById(state, id) {
  if (!state || !id) { return null; }
  var want = String(id);
  var manual = Array.isArray(state.manual) ? state.manual : [];
  for (var i = 0; i < manual.length; i++) {
    var n = manual[i];
    if (n && String(n.id) === want) { return n; }
  }
  // 订阅节点同样是节点：点开详情弹窗、复制链接、应用都不该因为它的
  // 来源而不同，只有删除例外（它们归订阅所有）。
  var subs = Array.isArray(state.subscriptions) ? state.subscriptions : [];
  for (var j = 0; j < subs.length; j++) {
    var nodes = subs[j] && Array.isArray(subs[j].nodes) ? subs[j].nodes : [];
    for (var k = 0; k < nodes.length; k++) {
      if (nodes[k] && String(nodes[k].id) === want) { return nodes[k]; }
    }
  }
  return null;
}

// 存储的 IPv6 地址不带方括号（Xray 要求如此），显示时必须补回去，
// 否则 "2001:db8::1:443" 根本没法读。
function hostPort(n) {
  var a = String(n.address || "");
  if (a.indexOf(":") >= 0) { a = "[" + a + "]"; }
  return a + (n.port ? ":" + n.port : "");
}

function nodeMeta(n) {
  var bits = [];
  if (n.protocol) { bits.push(n.protocol); }
  if (n.transport && n.transport !== "tcp") { bits.push(n.transport); }
  if (n.security) { bits.push(n.security); }
  if (n.address) { bits.push(hostPort(n)); }
  return bits.join(" · ");
}

function pill(text, cls) {
  var el = document.createElement("span");
  el.className = "pill " + cls;
  el.textContent = text;
  return el;
}

function listHint(model, state) {
  if (!state) { return { text: T.nodeNoState, cls: "" }; }
  if (state.schema && state.schema !== 1) {
    return { text: T.nodeSchema + state.schema, cls: "warn" };
  }
  if (!model.appliedKnown) { return { text: T.appliedMissing, cls: "warn" }; }
  if (!model.selectedKnown) { return { text: T.selectedMissing, cls: "warn" }; }
  for (var i = 0; i < model.rows.length; i++) {
    if (model.rows[i].applied && model.rows[i].dirty) {
      return { text: T.nodeReapply, cls: "warn" };
    }
  }
  if (model.empty) { return { text: T.emptyNodes, cls: "" }; }
  if (editMode) { return { text: T.editHint, cls: "" }; }
  return { text: T.listHint, cls: "" };
}

function rowSig(row) {
  var n = row.node;
  return [row.id, row.subId || "", n.name || "", n.protocol || "", n.transport || "", n.security || "",
    n.address || "", n.port || "", row.applied ? 1 : 0, row.selected ? 1 : 0,
    row.dirty ? 1 : 0].join("|");
}

// ---- subscription groups ----

// 折叠状态是 UI 偏好，不是意图：和主题、语言一样留在 localStorage，
// 不进 state.json。没有存储时退化为仅本次会话有效。
var COLLAPSE_KEY = "kernelray.collapsed";
var collapsedIds = (function () {
  try {
    var raw = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || "[]");
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch (e) { return []; }
})();

function isCollapsed(subId) { return collapsedIds.indexOf(String(subId)) >= 0; }

function toggleCollapse(subId) {
  var id = String(subId);
  var i = collapsedIds.indexOf(id);
  if (i >= 0) { collapsedIds.splice(i, 1); } else { collapsedIds.push(id); }
  try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedIds)); } catch (e) { /* 无存储 */ }
  renderNodeList();
}

// 相对时间只用于组头第二行；绝对时间戳对“上次刷新”这个判断没有帮助。
function agoText(ms) {
  var d = Date.now() - Number(ms);
  if (!isFinite(d) || d < 0) { d = 0; }
  var m = Math.floor(d / 60000);
  if (m < 1) { return T.timeNow; }
  if (m < 60) { return T.timeMin.replace("{n}", String(m)); }
  var h = Math.floor(m / 60);
  if (h < 24) { return T.timeHour.replace("{n}", String(h)); }
  return T.timeDay.replace("{n}", String(Math.floor(h / 24)));
}

// 订阅卡上的 lastError 存的是稳定的原因码（`http 404`、`timeout`…），
// 不是翻译后的句子：换语言后旧错误也能重新说对。
function subErrorText(code, http) {
  var c = String(code || "").trim().toLowerCase();
  if (c === "timeout") { return T.subTimeout; }
  if (c === "empty") { return T.subEmpty; }
  if (c === "too-large") { return T.subTooLarge; }
  if (c === "no url") { return T.subNoUrl; }
  if (c === "bad url") { return T.subBadUrl; }
  var m = /^http\s+(\d+)$/.exec(c);
  if (m) { return T.subHttp.replace("{n}", m[1]); }
  if (c === "http") { return T.subHttp.replace("{n}", String(http || "?")); }
  return T.subNetwork;
}

function groupMeta(group) {
  if (group.kind === "manual") {
    return T.nodeCount.replace("{n}", String(group.rows.length));
  }
  var sub = group.sub || {};
  var bits = [T.nodeCount.replace("{n}", String(group.rows.length))];
  bits.push(sub.lastFetched ? agoText(sub.lastFetched) : T.neverFetched);
  return bits.join(" · ");
}

function renderGroupHead(group) {
  var collapsed = group.kind === "sub" && isCollapsed(group.id);
  var head = document.createElement("div");
  head.className = "nghead";
  if (group.kind === "sub") {
    var chev = document.createElement("button");
    chev.type = "button";
    chev.className = "ngchev";
    chev.setAttribute("data-action", "subcollapse");
    chev.setAttribute("data-sub", group.id);
    chev.setAttribute("aria-expanded", collapsed ? "false" : "true");
    chev.setAttribute("aria-label", collapsed ? T.expand : T.collapse);
    chev.textContent = collapsed ? "▸" : "▾";
    head.appendChild(chev);
  }
  // 组头两行：第一行是名称（可省略号）与动作，第二行是计数、时间与
  // 状态标记。挤成一行时，长域名会把计数和时间挤没——而它们正是折叠
  // 之后唯一还看得见的东西。
  var main = document.createElement("div");
  main.className = "ngmain";
  var top = document.createElement("div");
  top.className = "ngtop";
  var name = document.createElement("div");
  name.className = "ngname";
  name.textContent = group.kind === "manual" ? T.manualGroup : (group.name || group.id);
  top.appendChild(name);
  if (group.kind === "sub") {
    var refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "ngicon";
    refresh.setAttribute("data-action", "subrefresh");
    refresh.setAttribute("data-sub", group.id);
    refresh.setAttribute("aria-label", T.subRefresh);
    refresh.textContent = "⟳";
    refresh.disabled = busy;
    top.appendChild(refresh);
    var more = document.createElement("button");
    more.type = "button";
    more.className = "ngicon";
    more.setAttribute("data-action", "submenu");
    more.setAttribute("data-sub", group.id);
    more.setAttribute("aria-label", T.subActions);
    more.textContent = "⋯";
    more.disabled = busy;
    top.appendChild(more);
  }
  main.appendChild(top);
  var bot = document.createElement("div");
  bot.className = "ngbot";
  var meta = document.createElement("div");
  meta.className = "ngmeta";
  meta.textContent = groupMeta(group);
  bot.appendChild(meta);
  // 折叠后组头是唯一还看得见的东西：正在跑或刚选中的节点必须在它上面
  // 留个痕迹，否则“哪条在跑”就被一次折叠藏起来了。
  if (collapsed) {
    var hasApplied = group.rows.some(function (r) { return r.applied; });
    var hasSelected = group.rows.some(function (r) { return r.unapplied; });
    if (hasApplied) { bot.appendChild(pill(T.nodeApplied, "ok")); }
    else if (hasSelected) { bot.appendChild(pill(T.nodePending, "warn")); }
  }
  main.appendChild(bot);
  head.appendChild(main);
  return head;
}

// 一组 = 组头 + 它自己的卡片网格。没有订阅时手工组不渲染组头，
// 列表和旧版一模一样（Q8）。
function renderGroup(group, model, gate) {
  var sec = document.createElement("section");
  sec.className = "ngroup" + (group.kind === "sub" ? " ngsub" : " ngmanual");
  sec.setAttribute("data-sub", group.id);
  if (group.kind === "sub" || model.hasSubs) { sec.appendChild(renderGroupHead(group)); }
  if (group.kind === "sub" && isCollapsed(group.id)) { return sec; }
  if (group.rows.length === 0) {
    var hint = document.createElement("div");
    var err = group.sub && group.sub.lastError;
    hint.className = "nghint" + (err ? " warn" : "");
    hint.textContent = err ? subErrorText(err) : (group.shadowed ? T.subAllInManual : T.subNoNodes);
    sec.appendChild(hint);
    return sec;
  }
  var rowsEl = document.createElement("div");
  rowsEl.className = "ngrows";
  group.rows.forEach(function (row) { rowsEl.appendChild(renderRow(row, gate)); });
  sec.appendChild(rowsEl);
  return sec;
}

// ---- end subscription groups ----

// 每一行都用 createElement/textContent 构建：节点名来自导入的链接，
// 绝不能进入 innerHTML。
function renderRow(row, allowDelete) {
  var el = document.createElement("div");
  el.className = "nrow" + (row.applied ? " applied" : "") +
    (confirmId === row.id && !editMode ? " confirming" : "") +
    (editMode ? " editing" : "");
  el.setAttribute("data-id", row.id);
  if (row.subId) { el.setAttribute("data-sub", row.subId); }

  var main = document.createElement("div");
  main.className = "nrow-main";
  var name = document.createElement("div");
  name.className = "nrow-name";
  name.textContent = row.node.name || row.node.protocol || "node";
  main.appendChild(name);
  var meta = document.createElement("div");
  meta.className = "nrow-meta";
  meta.textContent = nodeMeta(row.node);
  main.appendChild(meta);
  el.appendChild(main);

  if (confirmId === row.id) {
    var q = document.createElement("div");
    q.className = "nrow-q";
    q.textContent = row.applied ? T.deleteConfirmApplied : T.deleteConfirm;
    main.appendChild(q);
    var actions = document.createElement("div");
    actions.className = "nactions";
    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "small danger";
    yes.setAttribute("data-action", "confirm");
    yes.textContent = T.delete;
    var no = document.createElement("button");
    no.type = "button";
    no.className = "small";
    no.setAttribute("data-action", "cancel");
    no.textContent = T.cancel;
    actions.appendChild(yes);
    actions.appendChild(no);
    el.appendChild(actions);
    return el;
  }

  if (!editMode) {
    el.setAttribute("role", "button");
    el.tabIndex = 0;
  } else if (!row.subId) {
    // 编辑模式下整行都是勾选开关；已应用行的复选框遵循与 ✕ 相同的
    // 删除门槛。节点详情弹窗只在编辑模式之外打开。
    var check = document.createElement("input");
    check.type = "checkbox";
    check.className = "ncheck";
    check.setAttribute("data-action", "check");
    check.setAttribute("aria-label", row.node.name || row.id);
    // 门槛关闭前留下的勾选（核心在别处启动了）不能显示为已勾选，
    // 因为该复选框现已禁用；batchModel 无论如何都会忽略它。
    check.checked = !!checkSet[row.id] && !(row.applied && !allowDelete);
    if (row.applied && !allowDelete) { check.disabled = true; }
    el.insertBefore(check, el.firstChild);
  }

  var pills = document.createElement("div");
  pills.className = "npills";
  if (row.applied) { pills.appendChild(pill(T.nodeApplied, "ok")); }
  else if (row.unapplied) { pills.appendChild(pill(T.nodePending, "warn")); }
  if (row.dirty) { pills.appendChild(pill(T.nodeDirty, "warn")); }
  main.appendChild(pills);

  if (editMode) { return el; }
  // 订阅节点没有 ✕：它们归订阅所有，删掉也会在下次刷新时回来；
  // 删除的入口是订阅自己的 ⋯ 菜单。
  if (row.subId) { return el; }

  var del = document.createElement("button");
  del.type = "button";
  del.className = "ndel" + (row.applied && !allowDelete ? " muted" : "");
  del.setAttribute("data-action", "delete");
  del.setAttribute("aria-label", T.delete);
  del.textContent = "✕";
  el.appendChild(del);
  return el;
}

// 编辑模式工具栏：全选、批量删除以及行内确认。与每一行一样，
// 它用 createElement/textContent 构建；数量取自勾选集合。
function renderBatchBar(model, bm, unapplies) {
  var bar = els.nToolbar;
  if (!editMode || model.empty) {
    bar.hidden = true;
    bar.textContent = "";
    return;
  }
  bar.hidden = false;
  bar.textContent = "";
  if (batchConfirm) {
    var q = document.createElement("span");
    q.className = "nbatch-q";
    q.textContent = (unapplies ? T.deleteConfirmNApplied : T.deleteConfirmN)
      .replace("{n}", String(bm.checkedIds.length));
    bar.appendChild(q);
    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "small danger";
    yes.setAttribute("data-action", "batchconfirm");
    yes.textContent = T.delete;
    var no = document.createElement("button");
    no.type = "button";
    no.className = "small";
    no.setAttribute("data-action", "batchcancel");
    no.textContent = T.cancel;
    bar.appendChild(yes);
    bar.appendChild(no);
    return;
  }
  var all = document.createElement("button");
  all.type = "button";
  all.className = "small";
  all.setAttribute("data-action", "checkall");
  all.textContent = bm.allChecked ? T.uncheckAll : T.checkAll;
  all.disabled = bm.checkableIds.length === 0;
  var del = document.createElement("button");
  del.type = "button";
  del.className = "small danger";
  del.setAttribute("data-action", "batchdel");
  del.textContent = bm.checkedIds.length > 0
    ? T.batchDelete + " (" + bm.checkedIds.length + ")"
    : T.batchDelete;
  del.disabled = bm.checkedIds.length === 0;
  bar.appendChild(all);
  bar.appendChild(del);
}

function renderNodeList() {
  var state = lastStateObj;
  var model = nodeListModel(state, lastApplied, identityOf);
  var running = coreRunning();
  listRunning = running;
  var gate = deleteGate(model, running);
  var bm = batchModel(model, checkSet, gate);
  // 编辑模式只作用于手工行：最后一条手工节点没了，这个模式就无处可用。
  var hasManual = model.rows.some(function (row) { return !row.subId; });
  if (!hasManual && editMode) {
    editMode = false;
    checkSet = {};
    batchConfirm = false;
  }
  // 门槛跟随运行状态，所以停止/启动也必须让列表失效重绘。
  var sig = [String(state && state.schema), lastApplied, confirmId || "",
    editMode ? "edit" : "", batchConfirm ? "batch" : "", gate ? "gate" : ""];
  bm.checkedIds.forEach(function (id) { sig.push(id); });
  model.groups.forEach(function (g) {
    var sub = g.sub || {};
    sig.push([g.kind, g.id, g.name, g.rows.length, g.shadowed, sub.lastFetched || 0,
      sub.lastError || "", g.kind === "sub" && isCollapsed(g.id) ? 1 : 0].join("|"));
  });
  model.rows.forEach(function (row) { sig.push(rowSig(row)); });
  var signature = sig.join("\n");
  if (signature !== listSig) {
    listSig = signature;
    els.nList.textContent = "";
    model.groups.forEach(function (g) { els.nList.appendChild(renderGroup(g, model, gate)); });
    if (model.empty) {
      // 空列表也必须提供能填满它的手势，而不只是卡片标题里的 +：
      // 初次使用的用户会看向页面中间。
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "primary nempty";
      addBtn.setAttribute("data-action", "add");
      addBtn.textContent = T.addTitle;
      els.nList.appendChild(addBtn);
    }
  }
  renderBatchBar(model, bm, willUnapply(model, bm.checkedIds, running));
  els.editNode.textContent = editMode ? T.done : T.edit;
  els.editNode.hidden = !hasManual;
  els.editNode.disabled = busy;
  var hint = listHint(model, state);
  els.nHint.textContent = hint.text;
  els.nHint.className = "nodehint" + (hint.cls ? " " + hint.cls : "");
  if (els.nList) { els.nList.classList.toggle("busy", busy); }
  if (dialogId) { renderDialog(); }
}

// 先写 selected，再写 outbound.meta/outbound.json/CLI：这样崩溃或应用失败
// 留下的是诚实的"selected B, applied A"状态，而不是比指针更新的配置。
function writeSelected(id) {
  if (!lastStateObj || lastStateObj.selected === id) { return Promise.resolve(false); }
  lastStateObj.selected = id;
  lastStateObj.revision = (Number(lastStateObj.revision) || 0) + 1;
  return writeState(lastStateObj).then(function () { return true; });
}

function switchTo(n, opts) {
  opts = opts || {};
  var done = typeof opts.done === "function" ? opts.done : null;
  function finish(err) {
    if (!done) { return; }
    try { done(err || null); } catch (e) { /* 弹窗回调不能中断应用链路 */ }
  }
  function fail(msg) {
    if (!opts.fromDialog) { toast(msg); }
    finish(new Error(msg));
  }
  if (busy || !hasBridge) { finish(new Error(T.actionFailed)); return; }
  if (!lastStateObj) { fail(T.nodeNoState); return; }
  if (lastStateObj.schema && lastStateObj.schema !== 1) {
    fail(T.nodeSchema + lastStateObj.schema);
    return;
  }
  if (!n || !n.id || !/^[0-9A-Za-z_-]+$/.test(n.id)) {
    fail(T.actionFailed + ": node has no usable id");
    return;
  }

  // 已经是已应用节点：无需动核心。切换失败时 selected 仍可能指向这里。
  if (lastApplied && lastApplied === n.id && !n.dirty) {
    setBusy(true);
    setButtons();
    renderNodeList();
    writeSelected(n.id).then(function () {
      if (opts.fromDialog) { toast(T.appliedMsg); }
      finish(null);
    }).catch(function (e) {
      if (!opts.fromDialog) { toast(T.actionFailed + ": " + e.message); }
      finish(e);
    }).then(function () {
      setBusy(false);
      setButtons();
      refreshPage();
    });
    return;
  }

  var out;
  try {
    out = outboundOf(n);
  } catch (e) {
    fail(T.actionFailed + ": " + e.message);
    return;
  }

  confirmId = null;
  setBusy(true);
  setButtons();
  renderNodeList();
  if (!opts.fromDialog) { toast(T.applyingMsg); }

  writeSelected(n.id).then(function () {
    var meta = "id=" + n.id + "\nhost=" + String(n.address || "") + "\n";
    return writeFile(OUTBOUND_META, meta, "600");
  }).then(function () {
    return writeFile(OUTBOUND, JSON.stringify(out), "600");
  }).then(function () {
    return exec(CLI + " apply " + n.id);
  }).then(function (r) {
    if (r.errno !== 0) {
      throw new Error((r.stderr || "").trim() || ("exit " + r.errno));
    }
    if (n.dirty) {
      // 只有当节点仍渲染出与刚应用时完全相同的出站，才清除该标记；
      // 更新的编辑必须继续保持未应用标记。
      var cur = findNodeById(lastStateObj, n.id);
      var current = "";
      if (cur) {
        try { current = JSON.stringify(outboundOf(cur)); } catch (e) { current = ""; }
      }
      if (cur && current === JSON.stringify(out)) {
        cur.dirty = false;
        lastStateObj.revision = (Number(lastStateObj.revision) || 0) + 1;
        return writeState(lastStateObj);
      }
    }
  }).then(function () {
    toast(T.appliedMsg);
    finish(null);
  }).catch(function (e) {
    if (!opts.fromDialog) { toast(T.actionFailed + ": " + e.message); }
    finish(e);
  }).then(function () {
    setBusy(false);
    setButtons();
    refreshPage();
  });
}

function askDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var model = nodeListModel(lastStateObj, lastApplied, identityOf);
  if (lastApplied && lastApplied === n.id && !deleteGate(model, coreRunning())) {
    toast(deleteRefusal(model));
    return;
  }
  confirmId = n.id;
  renderNodeList();
}

// 单个、多个或整条订阅共用一条删除路径：过滤手工节点库、过滤订阅桶里的
// 节点、丢掉 dropSubIds 里的订阅对象；若被删节点是当前节点就清掉
// selected 指针，渲染出的出站若属于被删节点就丢弃，然后持久化。
// 先执行 rm 再写入：rm 失败必须让节点留在库里，以便删除可以重试。
// 核心已停止时清空列表的删除就是一次取消应用（ADR 0013），出于同样
// 的原因它也最先执行。
function deleteNodes(ids, dropSubIds, opts) {
  var state = lastStateObj;
  var model = nodeListModel(state, lastApplied, identityOf);
  var unapply = willUnapply(model, ids, coreRunning());
  var gone = {};
  ids.forEach(function (id) { gone[String(id)] = true; });
  state.manual = (Array.isArray(state.manual) ? state.manual : []).filter(function (x) {
    return !x || !gone[x.id];
  });
  var drop = {};
  (dropSubIds || []).forEach(function (id) { drop[String(id)] = true; });
  state.subscriptions = (Array.isArray(state.subscriptions) ? state.subscriptions : [])
    .filter(function (s) { return !s || !drop[String(s.id)]; })
    .map(function (s) {
      if (!s || !Array.isArray(s.nodes)) { return s; }
      s.nodes = s.nodes.filter(function (n) { return !n || !gone[n.id]; });
      return s;
    });
  if (gone[state.selected]) { state.selected = ""; }
  state.revision = (Number(state.revision) || 0) + 1;
  setBusy(true);
  setButtons();
  renderNodeList();
  var chain;
  if (unapply) {
    chain = exec(CLI + " unapply").then(function (r) {
      if (r.errno !== 0) { throw new Error((r.stderr || "").trim() || ("exit " + r.errno)); }
      lastApplied = "";
      lastMetaId = "";
    });
  } else {
    var removeRendered = lastMetaId && gone[lastMetaId];
    chain = removeRendered ? exec("rm -f " + OUTBOUND + " " + OUTBOUND_META).then(function (r) {
      if (r.errno !== 0) { throw new Error((r.stderr || "").trim() || ("exit " + r.errno)); }
      lastMetaId = "";
    }) : Promise.resolve();
  }
  return chain.then(function () {
    return writeState(state).then(function () {
      setLastStateObj(state);
      if (!(opts && opts.quiet)) { logNodeLine("deleted " + ids.length + " nodes"); }
    });
  });
}

function confirmDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var model = nodeListModel(lastStateObj, lastApplied, identityOf);
  if (lastApplied && lastApplied === n.id && !deleteGate(model, coreRunning())) {
    confirmId = null;
    renderNodeList();
    toast(deleteRefusal(model));
    return;
  }
  deleteNodes([n.id]).then(function () {
    confirmId = null;
    toast(T.deleted);
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    setBusy(false);
    setButtons();
    refreshPage();
  });
}

function confirmBatchDelete() {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var model = nodeListModel(lastStateObj, lastApplied, identityOf);
  var gate = deleteGate(model, coreRunning());
  var ids = batchModel(model, checkSet, gate).checkedIds;
  if (ids.length === 0) {
    batchConfirm = false;
    renderNodeList();
    return;
  }
  // 除非门槛允许，勾选集合里不会有已应用行；但勾选与确认之间的一次
  // 刷新也不能让它混进来。
  if (!gate && lastApplied && ids.indexOf(lastApplied) >= 0) {
    batchConfirm = false;
    renderNodeList();
    toast(deleteRefusal(model));
    return;
  }
  var n = ids.length;
  deleteNodes(ids).then(function () {
    checkSet = {};
    batchConfirm = false;
    toast(T.deletedN.replace("{n}", String(n)));
  }).catch(function (e) {
    toast(T.actionFailed + ": " + e.message);
  }).then(function () {
    setBusy(false);
    setButtons();
    refreshPage();
  });
}

// 意图写在 state.json；runtime/applied 指向当前配置由之生成的节点。
// 一次 exec 里同时读取状态、已应用 id 与渲染出站的 meta；切换失败后列表必须
// 显示"已选中未应用"，而不是假装已经切换成功。
// 状态轮询带着 state revision、已应用 id 和 meta id：三者都没动时，
// 整个文件已经在 lastStateObj 里，无需再读、也无需重绘。
function refreshNodes(kv) {
  var known = lastStateObj;
  if (kv && known && kv.revision !== undefined && known.revision !== undefined &&
      String(kv.revision) === String(known.revision) &&
      String(kv.node || "") === String(lastApplied || "") &&
      String(kv.meta || "") === String(lastMetaId || "")) {
    renderNodeList();
    return Promise.resolve();
  }
  return exec("cat " + STATE + " 2>/dev/null; echo '@@APPLIED@@'; cat " + APPLIED +
    " 2>/dev/null; echo '@@META@@'; cat " + OUTBOUND_META + " 2>/dev/null")
    .then(function (r) {
      var parts = r.stdout.split("@@APPLIED@@");
      var state = null;
      try { state = JSON.parse((parts[0] || "").trim()); } catch (e) { state = null; }
      if (!state || typeof state !== "object" || Array.isArray(state)) { state = null; }
      var rest = (parts[1] || "").split("@@META@@");
      lastStateObj = state;
      lastApplied = (rest[0] || "").trim().split("\n")[0];
      lastMetaId = parseKv(rest[1] || "").id || "";
      renderNodeList();
    }).catch(function () {});
}

function invalidateList() { listSig = ""; }
function setLastStateObj(v) { lastStateObj = v; }
function setConfirmId(v) { confirmId = v; }
function setEditMode(v) { editMode = v; }
function setCheck(id, on) {
  if (on) { checkSet[id] = true; } else { delete checkSet[id]; }
}
function toggleCheck(id) {
  if (checkSet[id]) { delete checkSet[id]; } else { checkSet[id] = true; }
}
function clearChecks() { checkSet = {}; }
function setBatchConfirm(v) { batchConfirm = v; }
function toggleEditMode() {
  editMode = !editMode;
  checkSet = {};
  batchConfirm = false;
  confirmId = null;
}
function resetEditMode() {
  editMode = false;
  checkSet = {};
  batchConfirm = false;
}

export { lastStateObj, lastApplied, lastMetaId, confirmId, listSig, listRunning, editMode, checkSet, batchConfirm, nodeMeta, pill, listHint, rowSig, renderRow, renderBatchBar, renderNodeList, writeSelected, switchTo, deleteRefusal, canCheckNode, findNodeById, hostPort, askDelete, deleteNodes, confirmDelete, confirmBatchDelete, refreshNodes, invalidateList, setLastStateObj, setConfirmId, setEditMode, setCheck, toggleCheck, clearChecks, setBatchConfirm, toggleEditMode, resetEditMode, isCollapsed, toggleCollapse, agoText, subErrorText, renderGroup, renderGroupHead };
