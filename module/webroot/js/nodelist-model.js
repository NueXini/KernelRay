// ---- node list model ----
// 由 state.json 与 runtime/applied 推导出节点页显示的行。纯函数、无 DOM，
// 使 tests/nodelist.test.js 无需浏览器即可运行。本版本不涉及订阅节点：
// 列表只渲染手工节点库。
function nodeListModel(state, appliedId) {
  var rows = [];
  var selectedId = state && typeof state.selected === "string" ? state.selected : "";
  var applied = appliedId ? String(appliedId) : "";
  var manual = state && Array.isArray(state.manual) ? state.manual : [];
  var selectedKnown = selectedId === "";
  var appliedKnown = applied === "";
  for (var i = 0; i < manual.length; i++) {
    var n = manual[i];
    if (!n || typeof n !== "object" || n.id === null || n.id === undefined || n.id === "") {
      continue;
    }
    var id = String(n.id);
    var row = {
      node: n, id: id,
      applied: applied !== "" && id === applied,
      selected: selectedId !== "" && id === selectedId,
      dirty: !!n.dirty
    };
    row.unapplied = row.selected && !row.applied;
    // 点按已应用节点不会动核心，除非重新导入改动了它的字段。
    row.noop = row.applied && !row.dirty;
    if (row.applied) { appliedKnown = true; }
    if (row.selected) { selectedKnown = true; }
    rows.push(row);
  }
  return {
    rows: rows, appliedId: applied, selectedId: selectedId,
    appliedKnown: appliedKnown, selectedKnown: selectedKnown, empty: rows.length === 0
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
    if (row.applied && !allowApplied) { continue; }
    checkable.push(row.id);
    if (set[row.id]) { checked.push(row.id); }
  }
  return {
    checkableIds: checkable, checkedIds: checked,
    allChecked: checkable.length > 0 && checked.length === checkable.length
  };
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
function applyAfterImport(state, appliedId) {
  if (appliedId) { return ""; }
  var manual = state && Array.isArray(state.manual) ? state.manual : [];
  var selected = state && typeof state.selected === "string" ? state.selected : "";
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

export { nodeListModel, deleteGate, emptiesList, willUnapply, batchModel, nodeDialogModel, applyAfterImport };
