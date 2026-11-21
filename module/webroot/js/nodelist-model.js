// ---- node list model ----
// 由 state.json（selected）、手工节点文件列表与订阅文件列表，加上
// runtime/applied，推导出节点页显示的行。纯函数、无 DOM，
// 使 tests/nodelist.test.js 无需浏览器即可运行。
//
// 订阅节点与手工节点共用一个 id 空间：id 由身份派生，所以同一条节点在
// 两边会算出同一个 id。渲染时手工优先——订阅是别人给的副本，用户手工
// 添加的那条才是他能编辑、能删除的那条。`keyOf` 由调用方注入
// （webroot 里是 parse.js 的 identityOf），本块因此不 import 任何东西。
function listKey(node, keyOf) {
  if (typeof keyOf === "function") {
    var k = keyOf(node);
    if (k) { return String(k); }
  }
  return String(node && node.id || "");
}

function listRow(node, applied, selectedId, subId) {
  var id = String(node.id);
  var row = {
    node: node, id: id, subId: subId || "",
    applied: applied !== "" && id === applied,
    selected: selectedId !== "" && id === selectedId,
    dirty: !!node.dirty
  };
  row.unapplied = row.selected && !row.applied;
  // 点按已应用节点不会动核心，除非重新导入改动了它的字段。
  row.noop = row.applied && !row.dirty;
  return row;
}

function nodeListModel(state, manual, subs, appliedId, keyOf) {
  var selectedId = state && typeof state.selected === "string" ? state.selected : "";
  var applied = appliedId ? String(appliedId) : "";
  manual = Array.isArray(manual) ? manual : [];
  subs = Array.isArray(subs) ? subs : [];
  var selectedKnown = selectedId === "";
  var appliedKnown = applied === "";
  // 身份在整份列表里只出现一次：先手工、再按订阅顺序。
  var seen = Object.create(null);
  var groups = [];
  var manualRows = [];
  var i, j, n, id, row;
  for (i = 0; i < manual.length; i++) {
    n = manual[i];
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") {
      continue;
    }
    id = String(n.id);
    seen[listKey(n, keyOf) || id] = true;
    row = listRow(n, applied, selectedId, "");
    if (row.applied) { appliedKnown = true; }
    if (row.selected) { selectedKnown = true; }
    manualRows.push(row);
  }
  if (manualRows.length) {
    groups.push({
      kind: "manual", id: "", name: "", sub: null,
      rows: manualRows, shadowed: 0, total: manualRows.length
    });
  }
  var rows = manualRows.slice();
  var subGroups = 0;
  for (i = 0; i < subs.length; i++) {
    var sub = subs[i];
    if (!sub || typeof sub !== "object") { continue; }
    var subId = sub.id === null || sub.id === undefined ? "" : String(sub.id);
    var nodes = Array.isArray(sub.nodes) ? sub.nodes : [];
    var subRows = [];
    var shadowed = 0;
    for (j = 0; j < nodes.length; j++) {
      n = nodes[j];
      if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") {
        continue;
      }
      id = String(n.id);
      var k = listKey(n, keyOf) || id;
      if (seen[k]) { shadowed++; continue; }
      seen[k] = true;
      row = listRow(n, applied, selectedId, subId);
      if (row.applied) { appliedKnown = true; }
      if (row.selected) { selectedKnown = true; }
      subRows.push(row);
      rows.push(row);
    }
    subGroups++;
    groups.push({
      kind: "sub", id: subId, name: String(sub.name || ""), sub: sub,
      rows: subRows, shadowed: shadowed, total: nodes.length
    });
  }
  var hasSubs = subGroups > 0;
  return {
    rows: rows, groups: groups, appliedId: applied, selectedId: selectedId,
    appliedKnown: appliedKnown, selectedKnown: selectedKnown,
    hasSubs: hasSubs, empty: rows.length === 0 && !hasSubs
  };
}

// 删除门槛：已应用节点只有在核心已停止、且它是最后一行时才可删除，
// 这样删除会清空节点库。行的 ✕ 与编辑模式批量删除共用一条规则。
// `running` 表示"无法证明确已停止"：调用方把读不出的状态算作运行中，
// 因此删除绝不会与刚启动的核心竞态。
function deleteGate(model, running) {
  return !running && model.rows.length === 1 && model.rows[0].applied;
}

// 删除 `ids` 时是否还要取消应用（移除 config.json、runtime/applied、渲染出的
// 出站和接管规则）。触发条件是删除后的状态，而不是被删的那一行：
// 核心已停止且列表被清空时已经无处可运行；悬空的已应用 id（没有
// 对应行的 id）否则会把凭证留在 config.json 里，而启动闸门仍会
// 让下次启动带着它运行（ADR 0013）。
function emptiesList(model, ids) {
  if (model.rows.length === 0) { return false; }
  var gone = {};
  ids.forEach(function (id) { gone[id] = true; });
  for (var i = 0; i < model.rows.length; i++) {
    if (!gone[model.rows[i].id]) { return false; }
  }
  return true;
}

function willUnapply(model, ids, running) {
  return !running && emptiesList(model, ids);
}

// 编辑模式的勾选集合 → 批量删除可以作用于哪些行。纯函数，便于
// 让 tests/nodelist.test.js 无需浏览器运行；只有调用方的删除门槛允许时，
// 已应用行才加入（✕ 在完全相同的情形下拒绝），已没有对应行的勾选 id
// （刷新后的陈旧集合）直接忽略。
function batchModel(model, checks, allowApplied) {
  var set = checks || {};
  var checkable = [];
  var checked = [];
  for (var i = 0; i < model.rows.length; i++) {
    var row = model.rows[i];
    // 订阅节点不归节点库所有：它们随下一次刷新整体替换，单条删除没有
    // 意义（删掉也会回来）。勾选只作用于手工添加的行。
    if (row.subId) { continue; }
    if (row.applied && !allowApplied) { continue; }
    checkable.push(row.id);
    if (set[row.id]) { checked.push(row.id); }
  }
  return {
    checkableIds: checkable, checkedIds: checked,
    allChecked: checkable.length > 0 && checked.length === checkable.length
  };
}
// 一个订阅组里渲染出来的行 id：删除订阅要按这批 id 判断删除门槛。
function subGroupRows(model, subId) {
  var want = subId === null || subId === undefined ? "" : String(subId);
  for (var i = 0; i < (model.groups || []).length; i++) {
    var g = model.groups[i];
    if (g.kind === "sub" && g.id === want) { return g.rows; }
  }
  return [];
}

// 删除订阅的门槛与删除单个节点一致：只有含已应用节点、且删完会清空
// 列表并让模块退回从未应用状态时，才允许在核心停止的情况下删。
function subDeleteAllowed(model, subId, running) {
  var ids = subGroupRows(model, subId).map(function (r) { return r.id; });
  if (ids.indexOf(model.appliedId) < 0) { return true; }
  return willUnapply(model, ids, running);
}

// 刷新合并：订阅的桶整体替换成这次抓到的节点，但同身份的旧条目保留
// 原 id，字段真的变了才标 dirty（与导入同一条规则）。removed 只用于
// 日志，不参与写入。纯函数，便于测试。
function mergeSubscriptionNodes(existing, incoming, keyOf) {
  var byKey = Object.create(null);
  (existing || []).forEach(function (n) {
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") { return; }
    var k = listKey(n, keyOf) || String(n.id);
    if (!byKey[k]) { byKey[k] = n; }
  });
  var out = [];
  var seen = Object.create(null);
  var added = 0, updated = 0, removed = 0;
  (incoming || []).forEach(function (n) {
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") { return; }
    var k = listKey(n, keyOf) || String(n.id);
    if (seen[k]) { return; }
    seen[k] = true;
    var ex = byKey[k];
    if (!ex) { out.push(n); added++; return; }
    var changed = false;
    Object.keys(n).forEach(function (f) {
      if (f === "id" || f === "dirty") { return; }
      if (JSON.stringify(ex[f]) !== JSON.stringify(n[f])) { changed = true; }
    });
    Object.keys(ex).forEach(function (f) {
      if (f === "id" || f === "dirty") { return; }
      if (!(f in n)) { changed = true; }
    });
    var next = {};
    Object.keys(n).forEach(function (f) {
      if (f !== "id" && f !== "dirty") { next[f] = n[f]; }
    });
    next.id = ex.id;
    if (changed) { next.dirty = true; updated++; }
    else if (ex.dirty) { next.dirty = true; }
    out.push(next);
  });
  (existing || []).forEach(function (n) {
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") { return; }
    var k = listKey(n, keyOf) || String(n.id);
    if (!seen[k]) { removed++; }
  });
  return { nodes: out, added: added, updated: updated, removed: removed };
}

// 节点详情弹窗的按钮状态：已应用且干净是唯一无操作的点按（切换失败后
// 它仍可能重新同步 `selected`）；已应用但有改动则重新应用，当前节点却
// 未应用则是重试。纯函数，便于 tests/nodelist.test.js 运行。
function nodeDialogModel(node, appliedId, selectedId) {
  var id = node && node.id !== null && node.id !== undefined ? String(node.id) : "";
  var applied = id !== "" && appliedId !== null && appliedId !== undefined &&
    String(appliedId) !== "" && id === String(appliedId);
  var selected = id !== "" && selectedId !== null && selectedId !== undefined &&
    String(selectedId) !== "" && id === String(selectedId);
  var dirty = !!(node && node.dirty);
  var action = "apply";
  if (applied && dirty) { action = "reapply"; }
  else if (selected && !applied) { action = "retry"; }
  return {
    id: id, applied: applied, selected: selected, dirty: dirty,
    action: action, noop: applied && !dirty
  };
}
// ---- end node list model ----

// ---- import switch rule ----

// 只有存在已应用节点，一次导入之后节点库才是可用的；首次导入正是用户
// 希望刚粘贴的节点跑起来的时刻。要切换到的节点是已设好且仍能解析的指针
// （切换失败会把它留在那里），否则取列表能显示的第一个节点。
// "" 表示"什么都不切换"：已经有已应用节点。纯函数，便于导入测试
// 在无需浏览器的情况下运行。
function applyAfterImport(manual, selected, appliedId) {
  if (appliedId) { return ""; }
  manual = Array.isArray(manual) ? manual : [];
  selected = typeof selected === "string" ? selected : "";
  var first = "";
  for (var i = 0; i < manual.length; i++) {
    var n = manual[i];
    // 与 nodeListModel 相同的过滤：没有 id 的节点没有可标记为已应用的行。
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") {
      continue;
    }
    var id = String(n.id);
    if (first === "") { first = id; }
    if (selected !== "" && id === selected) { return id; }
  }
  return first;
}

// ---- end import switch rule ----

export { nodeListModel, deleteGate, emptiesList, willUnapply, batchModel, nodeDialogModel, applyAfterImport, subGroupRows, subDeleteAllowed, mergeSubscriptionNodes };
