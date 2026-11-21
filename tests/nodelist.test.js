// 针对 WebUI 节点列表、删除门控、导入时切换与节点详情弹窗状态的测试。
//
// 两个代码块都位于 module/webroot/js/nodelist-model.js 中；本测试框架从随包发布的文件里抽取带标记的
// 代码块，与 tests/parse.test.js 抽取解析器的做法完全一致。节点列表是
// 纯映射：state.json（selected）+ 节点文件列表 + 订阅文件列表 + runtime/applied
// → 行；删除门控与取消应用决策是这些行加上核心是否在运行这一事实的纯函数；
// 导入切换规则则是纯的决策：由节点列表 + selected + runtime/applied 得出 id；
// 弹窗按钮状态是纯的节点 + 指针映射，因此它们都无需浏览器即可运行。
//
// 新的存储布局下 state.json 不再持有节点库：手工节点是 nodes/<id>.json、
// 订阅是 subscriptions/<id>.json（节点内嵌），所以这里的输入是
// (state, manual[], subs[], applied) 四样东西，而不是一个胖 state 对象。
//
//   运行：node tests/nodelist.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const jsPath = path.join(__dirname, "..", "module", "webroot", "js", "nodelist-model.js");
const js = fs.readFileSync(jsPath, "utf8");

function marked(start, end) {
  const from = js.indexOf(start);
  const to = js.indexOf(end);
  if (from < 0 || to < 0) {
    console.error("could not find the " + start + " block markers in nodelist-model.js");
    process.exit(1);
  }
  return js.slice(from, to);
}

const block = marked("// ---- node list model ----", "// ---- end node list model ----") +
  marked("// ---- import switch rule ----", "// ---- end import switch rule ----");
const L = new Function(block +
  "\nreturn { nodeListModel: nodeListModel, batchModel: batchModel, deleteGate: deleteGate, " +
  "willUnapply: willUnapply, applyAfterImport: applyAfterImport, nodeDialogModel: nodeDialogModel, " +
  "subGroupRows: subGroupRows, subDeleteAllowed: subDeleteAllowed, " +
  "mergeSubscriptionNodes: mergeSubscriptionNodes };"
)();

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(name + "\n    " + e.message.replace(/\n/g, "\n    "));
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((what || "value") + "\n      expected " + b + "\n      actual   " + a);
  }
}

function node(id, extra) {
  return Object.assign({ id: id, name: "node-" + id, protocol: "vless", address: "h", port: 443 }, extra || {});
}

// state.json 只剩意图：selected 与 settings。节点库本体是 manual[]
// （nodes/ 目录的文件）与 subs[]（subscriptions/ 目录的文件，节点内嵌）。
function state(selected, extra) {
  return Object.assign({
    schema: 1, revision: 1, selected: selected || ""
  }, extra || {});
}

function sub(id, nodes) {
  return { id: id, name: "sub-" + id, url: "https://sub.example/" + id, nodes: nodes || [] };
}

// 把各行压缩成概要，这样失败时能看出究竟是什么发生了变化。
function rows(model) {
  return model.rows.map(function (row) {
    return [row.id, row.applied, row.selected, row.dirty, row.unapplied, row.noop];
  });
}

check("null state: no rows and no dangling pointers", () => {
  const model = L.nodeListModel(null, [], [], "");
  eq(rows(model), []);
  eq([model.empty, model.appliedKnown, model.selectedKnown], [true, true, true]);
});

check("empty store: no rows", () => {
  const model = L.nodeListModel(state(""), [], [], "");
  eq(rows(model), []);
  eq(model.empty, true);
});

check("store order is kept", () => {
  const model = L.nodeListModel(state(""), [node("a"), node("b"), node("c")], [], "");
  eq(model.rows.map(function (row) { return row.id; }), ["a", "b", "c"]);
  eq(model.empty, false);
});

check("applied node is marked and is a no-op tap", () => {
  const model = L.nodeListModel(state("a"), [node("a"), node("b")], [], "a");
  eq(rows(model), [
    ["a", true, true, false, false, true],
    ["b", false, false, false, false, false]
  ]);
  eq(model.appliedKnown, true);
});

check("a dirty applied node is not a no-op tap", () => {
  const model = L.nodeListModel(state("a"), [node("a", { dirty: true })], [], "a");
  eq(rows(model), [["a", true, true, true, false, false]]);
});

check("selected but not applied: the failed-switch state", () => {
  const model = L.nodeListModel(state("b"), [node("a"), node("b")], [], "a");
  eq(rows(model), [
    ["a", true, false, false, false, true],
    ["b", false, true, false, true, false]
  ]);
});

check("selected id that is not in the store is reported", () => {
  const model = L.nodeListModel(state("gone"), [node("a")], [], "a");
  eq(model.selectedKnown, false);
  eq(model.rows[0].selected, false);
});

check("applied id that is not in the store is reported", () => {
  const model = L.nodeListModel(state(""), [node("a")], [], "gone");
  eq(model.appliedKnown, false);
  eq(model.rows[0].applied, false);
});

check("malformed manual entries are ignored", () => {
  const model = L.nodeListModel(state(""),
    [null, {}, { id: "" }, { id: null }, node("a")], [], "");
  eq(model.rows.map(function (row) { return row.id; }), ["a"]);
});

check("malformed manual/sub lists are treated as empty", () => {
  const model = L.nodeListModel(state("nope"), "nope", "nope", "");
  eq(rows(model), []);
  eq(model.empty, true);
});

check("subscription nodes render under their own group", () => {
  const model = L.nodeListModel(state(""), [node("a")], [sub("s1", [node("x"), node("y")])], "");
  eq(model.rows.map(function (row) { return row.id; }), ["a", "x", "y"]);
  eq(model.groups.map(function (g) { return [g.kind, g.id, g.rows.length]; }),
    [["manual", "", 1], ["sub", "s1", 2]]);
  eq(model.rows.map(function (row) { return row.subId; }), ["", "s1", "s1"]);
});

check("a subscription node shadowed by a manual node renders once, in the manual group", () => {
  const model = L.nodeListModel(state(""), [node("same")], [sub("s1", [node("same"), node("y")])], "");
  eq(model.rows.map(function (row) { return row.id; }), ["same", "y"]);
  eq(model.groups[1].shadowed, 1);
});

check("the same node from two subscriptions renders once, the first one wins", () => {
  const model = L.nodeListModel(state(""), [], [sub("s1", [node("x")]), sub("s2", [node("x")])], "");
  eq(model.rows.map(function (row) { return row.id; }), ["x"]);
  eq(model.groups.map(function (g) { return g.rows.length; }), [1, 0]);
  eq(model.groups[1].shadowed, 1);
});

check("dedupe follows the injected identity, not the id", () => {
  const keyOf = function (n) { return n.name; };
  const model = L.nodeListModel(state(""), [node("old", { name: "same" })],
    [sub("s1", [node("new", { name: "same" })])], "", keyOf);
  eq(model.rows.map(function (row) { return row.id; }), ["old"]);
  eq(model.groups[1].shadowed, 1);
});

check("a subscription with no nodes still has a group and is not an empty store", () => {
  const model = L.nodeListModel(state(""), [], [sub("s1", [])], "");
  eq([model.empty, model.hasSubs, model.groups.length], [false, true, 1]);
});

check("an applied node that only exists in a subscription is still applied", () => {
  const model = L.nodeListModel(state("x"), [], [sub("s1", [node("x")])], "x");
  eq([model.rows[0].applied, model.rows[0].noop, model.appliedKnown, model.selectedKnown],
    [true, true, true, true]);
});

check("an applied node gone from every subscription reads as unknown", () => {
  const model = L.nodeListModel(state(""), [], [sub("s1", [node("x")])], "gone");
  eq([model.appliedKnown, model.appliedId], [false, "gone"]);
});

check("sub delete: allowed when the subscription holds no applied node", () => {
  const model = L.nodeListModel(state(""), [node("a")], [sub("s1", [node("x")])], "a");
  eq([L.subDeleteAllowed(model, "s1", false), L.subDeleteAllowed(model, "s1", true)], [true, true]);
});

check("sub delete: refused while the applied node lives in it and the core runs", () => {
  const model = L.nodeListModel(state("x"), [], [sub("s1", [node("x")])], "x");
  eq(L.subDeleteAllowed(model, "s1", true), false);
});

check("sub delete: the last subscription is deletable when the core is stopped", () => {
  const model = L.nodeListModel(state("x"), [], [sub("s1", [node("x")])], "x");
  eq(L.subDeleteAllowed(model, "s1", false), true);
});

check("sub delete: refused when other rows would survive the applied node's removal", () => {
  const model = L.nodeListModel(state("x"), [node("a")], [sub("s1", [node("x")])], "x");
  eq(L.subDeleteAllowed(model, "s1", false), false);
});

// ---- 刷新合并 ----

check("merge: a new node is added, a changed one keeps its id and turns dirty", () => {
  const existing = [
    { id: "keep", name: "old", protocol: "vless", address: "h", port: 443 },
    { id: "gone", name: "gone", protocol: "vless", address: "h", port: 443 }
  ];
  const incoming = [
    { id: "keep", name: "new", protocol: "vless", address: "h", port: 443 },
    { id: "fresh", name: "fresh", protocol: "vless", address: "h", port: 443 }
  ];
  const res = L.mergeSubscriptionNodes(existing, incoming, null);
  eq(res.nodes.map(function (n) { return n.id; }), ["keep", "fresh"]);
  eq([res.added, res.updated, res.removed], [1, 1, 1]);
  eq([res.nodes[0].name, res.nodes[0].dirty], ["new", true]);
});

check("merge: an unchanged node keeps its dirty flag and is not counted as updated", () => {
  const fields = { id: "a", name: "n", protocol: "vless", address: "h", port: 443 };
  const res = L.mergeSubscriptionNodes([Object.assign({}, fields, { dirty: true })],
    [Object.assign({}, fields)], null);
  eq([res.added, res.updated, res.removed, res.nodes[0].dirty], [0, 0, 0, true]);
});

check("merge: identity keeps the stored (legacy) id", () => {
  const keyOf = function (n) { return n.name; };
  const res = L.mergeSubscriptionNodes(
    [{ id: "legacy", name: "same", port: 1 }],
    [{ id: "hash", name: "same", port: 2 }], keyOf);
  eq(res.nodes.map(function (n) { return [n.id, n.port]; }), [["legacy", 2]]);
  eq([res.added, res.updated, res.removed], [0, 1, 0]);
});

check("merge: duplicates inside one feed are dropped", () => {
  const n = { id: "a", name: "n", port: 1 };
  const res = L.mergeSubscriptionNodes([], [n, Object.assign({}, n, { name: "n2" })], null);
  eq(res.nodes.length, 1);
  eq(res.added, 1);
});

check("applied comparison uses the string form of the id", () => {
  const model = L.nodeListModel(state("7"), [node("7")], [], "7");
  eq(model.rows[0].applied, true);
  eq(model.rows[0].noop, true);
});

// ---- 批量勾选集合（编辑模式） ----

function batch(model, checks, allowApplied) {
  const bm = L.batchModel(model, checks, allowApplied);
  return [bm.checkableIds, bm.checkedIds, bm.allChecked];
}

check("batch: subscription rows are never checkable", () => {
  const model = L.nodeListModel(state(""), [node("a")], [sub("s1", [node("x")])], "");
  eq(batch(model, { x: true, a: true }, false), [["a"], ["a"], true]);
});

check("batch: the applied node never joins the checkable set", () => {
  const model = L.nodeListModel(state("a"), [node("a"), node("b"), node("c")], [], "a");
  eq(batch(model, {}), [["b", "c"], [], false]);
});

check("batch: checked ids follow the check set", () => {
  const model = L.nodeListModel(state(""), [node("a"), node("b"), node("c")], [], "");
  eq(batch(model, { b: true, c: true }), [["a", "b", "c"], ["b", "c"], false]);
});

check("batch: every checkable id checked means allChecked", () => {
  const model = L.nodeListModel(state("a"), [node("a"), node("b")], [], "a");
  eq(batch(model, { b: true }), [["b"], ["b"], true]);
});

check("batch: stale check ids that lost their row are ignored", () => {
  const model = L.nodeListModel(state(""), [node("a")], [], "");
  eq(batch(model, { a: true, gone: true }), [["a"], ["a"], true]);
});

check("batch: no checkable rows is never allChecked", () => {
  const model = L.nodeListModel(state("a"), [node("a")], [], "a");
  eq(batch(model, {}), [[], [], false]);
});

check("batch: empty list is never allChecked", () => {
  const model = L.nodeListModel(state(""), [], [], "");
  eq(batch(model, {}), [[], [], false]);
});

check("batch: the delete gate lets the applied last row join", () => {
  const model = L.nodeListModel(state("a"), [node("a")], [], "a");
  eq(batch(model, {}, true), [["a"], [], false]);
  eq(batch(model, { a: true }, true), [["a"], ["a"], true]);
});

// ---- 删除门控（ADR 0013） ----

check("gate: the applied node is deletable when it is the last row and the core is stopped", () => {
  const model = L.nodeListModel(state("a"), [node("a")], [], "a");
  eq(L.deleteGate(model, false), true);
});

check("gate: a running core refuses the applied node", () => {
  const model = L.nodeListModel(state("a"), [node("a")], [], "a");
  eq(L.deleteGate(model, true), false);
});

check("gate: a list with another node still in it refuses the applied node", () => {
  const model = L.nodeListModel(state("a"), [node("a"), node("b")], [], "a");
  eq(L.deleteGate(model, false), false);
});

check("gate: a last row that is not applied is deleted without the gate", () => {
  const model = L.nodeListModel(state(""), [node("a")], [], "gone");
  eq(L.deleteGate(model, false), false);
  eq(L.deleteGate(model, true), false);
});

check("gate: an empty list has nothing to delete", () => {
  const model = L.nodeListModel(state(""), [], [], "");
  eq(L.deleteGate(model, false), false);
});

// ---- 取消应用决策 ----

check("unapply: deleting the whole list while the core is stopped", () => {
  const model = L.nodeListModel(state("a"), [node("a")], [], "a");
  eq(L.willUnapply(model, ["a"], false), true);
});

check("unapply: a running core is never unapplied", () => {
  const model = L.nodeListModel(state("a"), [node("a")], [], "a");
  eq(L.willUnapply(model, ["a"], true), false);
});

check("unapply: deleting one of several nodes leaves the applied one alone", () => {
  const model = L.nodeListModel(state("a"), [node("a"), node("b")], [], "a");
  eq(L.willUnapply(model, ["b"], false), false);
});

check("unapply: an emptied list with a dangling applied id is unapplied too", () => {
  const model = L.nodeListModel(state("b"), [node("b")], [], "gone");
  eq(L.willUnapply(model, ["b"], false), true);
});

check("unapply: a partial delete with a dangling applied id does not unapply", () => {
  const model = L.nodeListModel(state("b"), [node("b"), node("c")], [], "gone");
  eq(L.willUnapply(model, ["b"], false), false);
});

check("unapply: an already empty list has nothing to unapply", () => {
  const model = L.nodeListModel(state(""), [], [], "");
  eq(L.willUnapply(model, [], false), false);
});

// ---- 导入切换规则（ADR 0012） ----

check("import into a store with nothing applied switches the first node", () => {
  eq(L.applyAfterImport([node("a"), node("b")], "", ""), "a");
});

check("import with a node already applied switches nothing", () => {
  eq(L.applyAfterImport([node("a"), node("b")], "", "a"), "");
});

check("import into an empty store switches nothing", () => {
  eq(L.applyAfterImport([], "", ""), "");
});

check("import skips entries the list cannot render", () => {
  eq(L.applyAfterImport([{ id: "" }, null, node("b")], "", ""), "b");
});

check("a selection that still resolves wins over the first node", () => {
  eq(L.applyAfterImport([node("a"), node("b")], "b", ""), "b");
});

check("a dangling selection falls back to the first node", () => {
  eq(L.applyAfterImport([node("a")], "gone", ""), "a");
});

check("a selection pointing at a subscription node falls back to the first node", () => {
  // 订阅节点在切换规则里不参与：selected 若指向订阅里的节点（例如刚导入
  // 时的 "x"），而手工库里没有它，就回落到第一行。
  eq(L.applyAfterImport([node("a")], "x", ""), "a");
});

check("a malformed manual list switches nothing", () => {
  eq(L.applyAfterImport("nope", "", ""), "");
});

// ---- 节点详情弹窗的按钮状态 ----

check("dialog: an applied clean node is a no-op tap", () => {
  const m = L.nodeDialogModel(node("a"), "a", "a");
  eq([m.applied, m.selected, m.dirty, m.action, m.noop], [true, true, false, "apply", true]);
});

check("dialog: an applied dirty node is a re-apply", () => {
  const m = L.nodeDialogModel(node("a", { dirty: true }), "a", "a");
  eq([m.applied, m.selected, m.dirty, m.action, m.noop], [true, true, true, "reapply", false]);
});

check("dialog: selected but not applied is a retry", () => {
  const m = L.nodeDialogModel(node("b"), "a", "b");
  eq([m.applied, m.selected, m.dirty, m.action, m.noop], [false, true, false, "retry", false]);
});

check("dialog: a plain node is an apply", () => {
  const m = L.nodeDialogModel(node("c"), "a", "a");
  eq([m.applied, m.selected, m.dirty, m.action, m.noop], [false, false, false, "apply", false]);
});

check("dialog: applied + dirty + a stale selection still re-applies", () => {
  const m = L.nodeDialogModel(node("a", { dirty: true }), "a", "b");
  eq([m.applied, m.selected, m.dirty, m.action, m.noop], [true, false, true, "reapply", false]);
});

check("dialog: applied clean + a stale selection is still a no-op apply", () => {
  const m = L.nodeDialogModel(node("a"), "a", "b");
  eq([m.applied, m.selected, m.dirty, m.action, m.noop], [true, false, false, "apply", true]);
});

check("dialog: the id comparison uses the string form", () => {
  const m = L.nodeDialogModel(node("a"), "a", "");
  eq([m.applied, m.noop], [true, true]);
});

if (failures.length) {
  console.error(failures.length + " node list test(s) failed:\n");
  for (const failure of failures) { console.error("  - " + failure); }
  process.exit(1);
}
console.log(pass + " node list tests passing");
