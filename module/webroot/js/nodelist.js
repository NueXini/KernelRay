import { T } from "./i18n.js";
import { els } from "./els.js";
import { exec, CLI, STATE, APPLIED, OUTBOUND, OUTBOUND_META, parseKv, hasBridge, writeFile, writeState } from "./bridge.js";
import { busy, setBusy, toast, refreshPage } from "./main.js";
import { coreRunning, setButtons } from "./status.js";
import { nodeListModel, deleteGate, batchModel, willUnapply } from "./nodelist-model.js";
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
  return deleteGate(nodeListModel(lastStateObj, lastApplied), coreRunning());
}

function findNodeById(state, id) {
  if (!state || !id || !Array.isArray(state.manual)) { return null; }
  for (var i = 0; i < state.manual.length; i++) {
    var n = state.manual[i];
    if (n && String(n.id) === String(id)) { return n; }
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
  return [row.id, n.name || "", n.protocol || "", n.transport || "", n.security || "",
    n.address || "", n.port || "", row.applied ? 1 : 0, row.selected ? 1 : 0,
    row.dirty ? 1 : 0].join("|");
}

// 每一行都用 createElement/textContent 构建：节点名来自导入的链接，
// 绝不能进入 innerHTML。
function renderRow(row, allowDelete) {
  var el = document.createElement("div");
  el.className = "nrow" + (row.applied ? " applied" : "") +
    (confirmId === row.id && !editMode ? " confirming" : "") +
    (editMode ? " editing" : "");
  el.setAttribute("data-id", row.id);

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
  } else {
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
  var model = nodeListModel(state, lastApplied);
  var running = coreRunning();
  listRunning = running;
  var gate = deleteGate(model, running);
  var bm = batchModel(model, checkSet, gate);
  // 门槛跟随运行状态，所以停止/启动也必须让列表失效重绘。
  var sig = [String(state && state.schema), lastApplied, confirmId || "",
    editMode ? "edit" : "", batchConfirm ? "batch" : "", gate ? "gate" : ""];
  bm.checkedIds.forEach(function (id) { sig.push(id); });
  model.rows.forEach(function (row) { sig.push(rowSig(row)); });
  var signature = sig.join("\n");
  if (signature !== listSig) {
    listSig = signature;
    els.nList.textContent = "";
    model.rows.forEach(function (row) { els.nList.appendChild(renderRow(row, gate)); });
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
  els.editNode.disabled = busy || model.empty;
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
  var model = nodeListModel(lastStateObj, lastApplied);
  if (lastApplied && lastApplied === n.id && !deleteGate(model, coreRunning())) {
    toast(deleteRefusal(model));
    return;
  }
  confirmId = n.id;
  renderNodeList();
}

// 单个或多个 id 共用一条删除路径：过滤手工节点库，若被删节点是当前节点
// 就清掉 selected 指针，渲染出的出站若属于被删节点就丢弃，然后持久化。
// 先执行 rm 再写入：rm 失败必须让节点留在库里，以便删除可以重试。
// 核心已停止时清空列表的删除就是一次取消应用（ADR 0013），出于同样
// 的原因它也最先执行。
function deleteNodes(ids) {
  var state = lastStateObj;
  var unapply = willUnapply(nodeListModel(state, lastApplied), ids, coreRunning());
  var gone = {};
  ids.forEach(function (id) { gone[id] = true; });
  state.manual = (Array.isArray(state.manual) ? state.manual : []).filter(function (x) {
    return !x || !gone[x.id];
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
      logNodeLine("deleted " + ids.length + " nodes");
    });
  });
}

function confirmDelete(n) {
  if (busy || !hasBridge || !lastStateObj) { return; }
  var model = nodeListModel(lastStateObj, lastApplied);
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
  var model = nodeListModel(lastStateObj, lastApplied);
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

export { lastStateObj, lastApplied, lastMetaId, confirmId, listSig, listRunning, editMode, checkSet, batchConfirm, nodeMeta, pill, listHint, rowSig, renderRow, renderBatchBar, renderNodeList, writeSelected, switchTo, deleteRefusal, canCheckNode, findNodeById, hostPort, askDelete, deleteNodes, confirmDelete, confirmBatchDelete, refreshNodes, invalidateList, setLastStateObj, setConfirmId, setEditMode, setCheck, toggleCheck, clearChecks, setBatchConfirm, toggleEditMode, resetEditMode };
