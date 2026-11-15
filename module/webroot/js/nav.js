import { els, tabs, pages } from "./els.js";
import { refreshPage } from "./main.js";
import { updateLogNav } from "./log.js";
import { resetPortsDirty } from "./settings.js";
import { editMode, resetEditMode } from "./nodelist.js";

// ---- navigation ----
// 用 hash 路由作为唯一的导航状态：刷新会回到同一个标签页，链接也能
// 直接深链到某个标签页。点按用 replace 而不是 push，
// 这样长期存活的 WebView 不会为每次切换标签都堆出一条历史记录。
var DEFAULT_ROUTE = "status";
var currentRoute = null;
var scrollByRoute = { status: 0, nodes: 0, log: 0, settings: 0 };
var ROUTES = ["status", "nodes", "log", "settings"];

function routeOf(value) {
  var route = String(value == null ? "" : value)
    .replace(/^#\/?/, "").replace(/\/+$/, "").toLowerCase();
  if (ROUTES.indexOf(route) >= 0) { return route; }
  return DEFAULT_ROUTE;
}

function routeHash(route) { return "#/" + route; }

function showRoute(route, opts) {
  route = routeOf(route);
  // 勾选集合只是临时意图：经标签栏离开节点页时丢弃它，而不是带到别处。
  // 添加弹窗以遮罩形式出现，不改变路由。已输入但未保存的端口同理：
  // 离开页面就丢弃。
  if (route !== "settings") {
    resetPortsDirty();
  }
  if (route !== "nodes" && editMode) {
    resetEditMode();
  }
  if (currentRoute && currentRoute !== route) {
    scrollByRoute[currentRoute] = window.scrollY || window.pageYOffset || 0;
  }
  currentRoute = route;
  Object.keys(pages).forEach(function (key) { pages[key].hidden = key !== route; });
  tabs.forEach(function (tab) {
    var tr = tab.getAttribute("data-route");
    var active = tr === route;
    tab.classList.toggle("active", active);
    if (active) { tab.setAttribute("aria-current", "page"); }
    else { tab.removeAttribute("aria-current"); }
  });
  // 隐藏页面没有布局，所以要等选中的页面存在之后再恢复滚动位置。
  var y = scrollByRoute[route] || 0;
  window.scrollTo(0, y);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () { window.scrollTo(0, y); });
  }
  // 即使文本自上次访问以来没有变化，带着"跟随"进入日志页也应落在
  // 最新几行。
  if (route === "log") { updateLogNav(); }
  if (route === "log" && els.follow.checked) {
    var toBottom = function () { els.log.scrollTop = els.log.scrollHeight; };
    if (typeof requestAnimationFrame === "function") { requestAnimationFrame(toBottom); }
    else { toBottom(); }
  }
  if (!opts || opts.refresh !== false) { refreshPage(); }
}

function go(route) {
  route = routeOf(route);
  if (route === currentRoute) { refreshPage(); return; }
  var hash = routeHash(route);
  var replaced = false;
  try { history.replaceState(null, "", hash); replaced = true; } catch (e) { /* 走下面的回退路径 */ }
  if (replaced) { showRoute(route, { refresh: true }); }
  else { location.hash = hash; }
}

function initNav() {
  var start = routeOf(location.hash);
  var hash = routeHash(start);
  if (location.hash !== hash) {
    try { history.replaceState(null, "", hash); } catch (e) { /* 异常的 hash 仍由 routeOf 处理 */ }
  }
  showRoute(start, { refresh: false });
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function (e) {
      e.preventDefault();
      go(tab.getAttribute("data-route"));
    });
  });
  window.addEventListener("hashchange", function () {
    var route = routeOf(location.hash);
    var normalized = routeHash(route);
    if (location.hash !== normalized) {
      try { history.replaceState(null, "", normalized); } catch (e) {}
    }
    if (route === currentRoute) { return; }
    showRoute(route, { refresh: true });
  });
}

export { DEFAULT_ROUTE, currentRoute, scrollByRoute, ROUTES, routeOf, routeHash, showRoute, go, initNav };
