// 订阅详情弹窗（节点页组头 `⋯` 按钮）回归测试。
//
// 弹窗逻辑与 DOM 深度耦合，无法用 tests/ 现有的标记块抽取（纯函数）来测；
// 这里搭一个最小 DOM shim + 假 window.ksu 桥，把 webroot 的**真实 ES 模块图**
// 跑起来：渲染节点列表，模拟 `⋯` 按钮的委托点击，断言订阅弹窗打开且内容正确。
// 曾经的回归：renderSubDialog 把 findSub 的第一个参数传成 state 对象而非订阅
// 数组，弹窗在同一 tick 内被关闭，点击看起来毫无反应。
//
//   node --test tests/subdialog.test.js
//
// 无需 Android 设备或网络。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function makeEl(id, tag) {
  const el = {
    id: id || "", tagName: (tag || "div").toUpperCase(),
    children: [], attrs: {}, listeners: {},
    textContent: "", value: "", checked: false, hidden: true,
    disabled: false, className: "", scrollTop: 0, scrollHeight: 100,
    style: {}, title: "",
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, f) {
        const w = f === undefined ? !this._set.has(c) : !!f;
        w ? this._set.add(c) : this._set.delete(c);
        return w;
      },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); }
      return c;
    },
    remove() {}, insertBefore(c) { this.children.push(c); return c; },
    closest() { return null; }, querySelectorAll() { return []; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, e) { (this.listeners[t] || []).slice().forEach((fn) => fn(e)); },
    focus() {}, blur() {},
    get firstChild() { return this.children[0] || null; },
    hasAttribute(k) { return k in this.attrs; }
  };
  return el;
}

test("subscription dialog opens on the group `...` click and counts its nodes", async (t) => {
  // 把 webroot/js 拷进临时目录并声明 type=module，仓库里的 .js 才能被 Node
  // 当 ESM 导入；测试的仍是发布的文件，只是换了个解析上下文。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-subdialog-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  fs.cpSync(path.join(root, "module", "webroot", "js"), path.join(tmp, "js"), { recursive: true });
  const js = (name) => import(pathToFileURL(path.join(tmp, "js", name)).href);

  const byId = Object.create(null);
  globalThis.document = {
    getElementById(id) { if (!byId[id]) { byId[id] = makeEl(id); } return byId[id]; },
    createElement(tag) { return makeEl("", tag); },
    createDocumentFragment() { return makeEl("", "#fragment"); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    docListeners: {},
    addEventListener(t, fn) { (this.docListeners[t] = this.docListeners[t] || []).push(fn); },
    removeEventListener() {},
    documentElement: makeEl("html"), body: makeEl("body"),
    visibilityState: "visible", title: ""
  };
  globalThis.location = { hash: "", href: "http://localhost/index.html", replace() {} };
  globalThis.history = { replaceState() {}, pushState() {} };
  Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.window = {
    KRTheme: { applyTheme() {} }, scrollTo() {},
    localStorage: { getItem() { return null; }, setItem() {} },
    addEventListener() {},
    ksu: {
      exec(cmd, optsJson, cbName) {
        const stdout = cmd.includes(" status") ? "pid=\nrunning=0\nuptime=0\nport=10808\n" : "";
        queueMicrotask(() => {
          if (globalThis.window[cbName]) { globalThis.window[cbName](0, stdout, ""); }
        });
      }
    }
  };

  // main.js 的轮询 interval 会挂住 node --test：让页面转入后台，触发 stopPolling。
  // 挂在 t.after 上，断言失败也能清理。
  t.after(() => {
    globalThis.document.visibilityState = "hidden";
    (globalThis.document.docListeners.visibilitychange || []).forEach((fn) => fn());
  });

  await js("main.js"); // 真实入口：事件绑定、busy 闸门都在这条链上
  const { els } = await js("els.js");
  const nodelist = await js("nodelist.js");

  // 一条订阅、一个节点、核心停止：点 `⋯` 应该打开订阅详情弹窗。
  const subs = [{
    id: "sub1", name: "Test Sub", url: "https://sub.example.com/token",
    lastFetched: Date.now() - 60000, lastError: "",
    nodes: [{ id: "n1", name: "node-a", type: "vless", host: "a.example.com", port: 443, uuid: "u", security: "tls" }]
  }];
  nodelist.setLastStateObj({ selected: "" }, [], subs);
  nodelist.renderNodeList();

  function findAction(node, action) {
    const stack = [...(node.children || [])];
    while (stack.length) {
      const n = stack.pop();
      if (n.attrs["data-action"] === action) { return n; }
      stack.push(...(n.children || []));
    }
    return null;
  }
  const more = findAction(els.nList, "submenu");
  assert.ok(more, "rendered group head has the `...` (submenu) button");
  assert.strictEqual(more.getAttribute("data-sub"), "sub1");

  els.nList.dispatch("click", { target: more });

  assert.strictEqual(els.subOverlay.hidden, false,
    "subscription dialog is visible right after the click (it used to be closed again in the same tick)");
  assert.strictEqual(els.sdTitle.textContent, "Test Sub");
  assert.ok(els.sdMeta.textContent.indexOf("1") >= 0,
    "dialog counts the subscription's own nodes, got: " + els.sdMeta.textContent);
});
