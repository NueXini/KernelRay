// Node list model tests for the WebUI.
//
// The model lives inside module/webroot/app.js; this harness extracts the marked block from
// the shipped file, exactly like tests/parse.test.js does for the parser. The list is a pure
// state.json + runtime/applied → rows mapping, so it can be tested without a browser.
//
//   node tests/nodelist.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const jsPath = path.join(__dirname, "..", "module", "webroot", "app.js");
const js = fs.readFileSync(jsPath, "utf8");

const START = "// ---- node list model ----";
const END = "// ---- end node list model ----";
const from = js.indexOf(START);
const to = js.indexOf(END);
if (from < 0 || to < 0) {
  console.error("could not find the node list model block markers in app.js");
  process.exit(1);
}

const block = js.slice(from, to);
const L = new Function(block + "\nreturn { nodeListModel: nodeListModel, batchModel: batchModel };")();

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

function state(manual, selected, extra) {
  return Object.assign({
    schema: 1, revision: 1, manual: manual, subscriptions: [], selected: selected || ""
  }, extra || {});
}

// Compact projection of the rows, so a failure shows what actually changed.
function rows(model) {
  return model.rows.map(function (row) {
    return [row.id, row.applied, row.selected, row.dirty, row.unapplied, row.noop];
  });
}

check("null state: no rows and no dangling pointers", () => {
  const model = L.nodeListModel(null, "");
  eq(rows(model), []);
  eq([model.empty, model.appliedKnown, model.selectedKnown], [true, true, true]);
});

check("empty store: no rows", () => {
  const model = L.nodeListModel(state([], ""), "");
  eq(rows(model), []);
  eq(model.empty, true);
});

check("store order is kept", () => {
  const model = L.nodeListModel(state([node("a"), node("b"), node("c")], ""), "");
  eq(model.rows.map(function (row) { return row.id; }), ["a", "b", "c"]);
  eq(model.empty, false);
});

check("applied node is marked and is a no-op tap", () => {
  const model = L.nodeListModel(state([node("a"), node("b")], "a"), "a");
  eq(rows(model), [
    ["a", true, true, false, false, true],
    ["b", false, false, false, false, false]
  ]);
  eq(model.appliedKnown, true);
});

check("a dirty applied node is not a no-op tap", () => {
  const model = L.nodeListModel(state([node("a", { dirty: true })], "a"), "a");
  eq(rows(model), [["a", true, true, true, false, false]]);
});

check("selected but not applied: the failed-switch state", () => {
  const model = L.nodeListModel(state([node("a"), node("b")], "b"), "a");
  eq(rows(model), [
    ["a", true, false, false, false, true],
    ["b", false, true, false, true, false]
  ]);
});

check("selected id that is not in the store is reported", () => {
  const model = L.nodeListModel(state([node("a")], "gone"), "a");
  eq(model.selectedKnown, false);
  eq(model.rows[0].selected, false);
});

check("applied id that is not in the store is reported", () => {
  const model = L.nodeListModel(state([node("a")], ""), "gone");
  eq(model.appliedKnown, false);
  eq(model.rows[0].applied, false);
});

check("malformed manual entries are ignored", () => {
  const model = L.nodeListModel(
    state([null, {}, { id: "" }, { id: null }, node("a")], ""), "");
  eq(model.rows.map(function (row) { return row.id; }), ["a"]);
});

check("a non-array manual store is treated as empty", () => {
  const model = L.nodeListModel({ schema: 1, selected: "", manual: "nope" }, "");
  eq(rows(model), []);
  eq(model.empty, true);
});

check("subscription nodes are not rendered", () => {
  const model = L.nodeListModel({
    schema: 1, selected: "s1", manual: [node("a")],
    subscriptions: [{ name: "sub", nodes: [node("s1"), node("s2")] }]
  }, "");
  eq(model.rows.map(function (row) { return row.id; }), ["a"]);
});

check("applied comparison uses the string form of the id", () => {
  const model = L.nodeListModel(state([node("7")], "7"), "7");
  eq(model.rows[0].applied, true);
  eq(model.rows[0].noop, true);
});

// ---- batch check set (edit mode) ----

function batch(model, checks) {
  const bm = L.batchModel(model, checks);
  return [bm.checkableIds, bm.checkedIds, bm.allChecked];
}

check("batch: the applied node never joins the checkable set", () => {
  const model = L.nodeListModel(state([node("a"), node("b"), node("c")], "a"), "a");
  eq(batch(model, {}), [["b", "c"], [], false]);
});

check("batch: checked ids follow the check set", () => {
  const model = L.nodeListModel(state([node("a"), node("b"), node("c")], ""), "");
  eq(batch(model, { b: true, c: true }), [["a", "b", "c"], ["b", "c"], false]);
});

check("batch: every checkable id checked means allChecked", () => {
  const model = L.nodeListModel(state([node("a"), node("b")], "a"), "a");
  eq(batch(model, { b: true }), [["b"], ["b"], true]);
});

check("batch: stale check ids that lost their row are ignored", () => {
  const model = L.nodeListModel(state([node("a")], ""), "");
  eq(batch(model, { a: true, gone: true }), [["a"], ["a"], true]);
});

check("batch: no checkable rows is never allChecked", () => {
  const model = L.nodeListModel(state([node("a")], "a"), "a");
  eq(batch(model, {}), [[], [], false]);
});

check("batch: empty list is never allChecked", () => {
  const model = L.nodeListModel(state([], ""), "");
  eq(batch(model, {}), [[], [], false]);
});

if (failures.length) {
  console.error(failures.length + " node list test(s) failed:\n");
  for (const failure of failures) { console.error("  - " + failure); }
  process.exit(1);
}
console.log(pass + " node list tests passing");
