import { T } from "./i18n.js";
import { els } from "./els.js";
import { exec, CLI, LOG_LEVELS, parseKv, hasBridge } from "./bridge.js";
import { PORT_DEFAULTS } from "./ports.js";
import { currentRoute } from "./nav.js";
import { busy, pending, diagBusy } from "./main.js";
import { clearBusy } from "./log.js";
import { dialogId, renderDialog } from "./dialog.js";
import { listRunning, renderNodeList } from "./nodelist.js";

var lastState = "unknown";

var lastKv = null;

function uptime(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) { return "–"; }
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  var m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) { return d + "d " + h + "h"; }
  if (h) { return h + "h " + m + "m"; }
  if (m) { return m + "m " + s + "s"; }
  return s + "s";
}

function setButtons() {
  var running = lastState === "running";
  // 没有已应用节点就不启动：shell 的启动闸门本来也会拒绝（ADR 0010）。
  els.start.disabled = busy || running || !(lastKv && lastKv.node);
  els.stop.disabled = busy || !running;
  els.clearLog.disabled = busy || clearBusy || !hasBridge;
  els.start.textContent = busy && pending === "start" ? T.startingMsg : T.start;
  els.stop.textContent = busy && pending === "stop" ? T.stoppingMsg : T.stop;
  els.iSocks.disabled = !hasBridge;
  els.iHttp.disabled = !hasBridge;
  els.portsSave.disabled = busy || !hasBridge;
  els.diagCollect.disabled = busy || diagBusy || !hasBridge;
  els.diagCollect.textContent = diagBusy ? T.diagCollecting : T.diagCollect;
  if (els.nList) { els.nList.classList.toggle("busy", busy); }
  if (dialogId) { renderDialog(); }
}

// 删除门槛与取消应用决策都需要实时事实，且只有状态读出来是 "stopped"
// 才能证明核心已停：未知或读不出的状态一律按运行中处理。
function coreRunning() {
  return !(lastKv && lastKv.state === "stopped");
}

// 运行提示里提到 socks 端口；shell 现在报告的是已配置的那个。
function hintText(t, kv) {
  return String(t || "").replace("{port}", kv && kv.socks ? String(kv.socks) : String(PORT_DEFAULTS.socks));
}

function renderStatus(kv) {
  lastKv = kv;
  var state = kv.state || "unknown";
  var phase = kv.phase || "";
  var failed = phase === "config-invalid" || phase === "no-core" || phase === "crashed"
    || phase === "no-config" || phase === "failed/rules" || phase === "failed/conflict";
  var cls = failed ? "failed" : state;
  var text = T[state] || state;
  if (failed) { text = T.failed + " · " + (T[phase] || phase); }
  els.badge.textContent = text;
  els.badge.className = "badge " + cls;

  if (document.visibilityState === "visible") { lastState = state; }
  els.pid.textContent = kv.pid && kv.pid !== "-" ? kv.pid : "–";
  els.up.textContent = state === "running" && kv.started
    ? uptime(Math.floor(Date.now() / 1000) - Number(kv.started))
    : "–";
  els.port.textContent = kv.socks ? "socks " + kv.socks + " · http " + kv.http : "–";
  els.conf.textContent = kv.conf || "–";
  if (state === "running") {
    // 运行中的核心一定带着接管规则（启动即接管，docs/adr/0011）：无法落实
    // 接管的启动会被拒绝，所以这是运行中的核心唯一可能得到的提示。
    els.hint.textContent = hintText(T.tpRunningHint, kv);
  } else {
    // 开机不自动启动，意味着核心停止时设备保持直连，而提示必须点明这一点
    // （见 docs/adr/0018）。
    els.hint.textContent = kv.node ? T.stoppedHintTp : T.stoppedHintNone;
  }

  // 状态卡片只用于失败：设置页里曾经有过的开关已经移除
  // （docs/adr/0011），所以失败是这张卡片唯一需要说的事。冲突或
  // 接管规则失败会让核心停机、设备保持直连；重试执行的就是按钮
  // 那次启动。
  var tpFailed = phase === "failed/conflict" || phase === "failed/rules";
  els.tpCard.hidden = !tpFailed;
  if (tpFailed) {
    els.tpHint.textContent = phase === "failed/conflict" ? T.tpConflict : T.tpRules;
  }
  els.tpRetry.hidden = !tpFailed || busy;

  // 分流模式取自偏好（kv.route）。卡片放在状态页，紧挨着它改变的状态；
  // 它下方的提示只用于告警：全局不需要地理数据，缺数据时大陆直连
  // 退化为全局（ADR 0014），大陆直连去广告则拒绝启动（ADR 0021）；
  // 因此正常模式什么都不说，只有缺文件时才出现这一行。
  var routeMode = routeValue(kv.route);
  els.selRoute.value = routeMode;
  var routeHint = "";
  if (kv.geodata === "missing") {
    if (routeMode === "cn") { routeHint = T.routeCnNoGeodata; }
    else if (routeMode === "cnadblock") { routeHint = T.routeGeoMissing; }
  }
  els.setRouteHint.textContent = routeHint;
  els.setRouteHint.className = routeHint ? "hint warn" : "hint";
  els.setRouteHint.hidden = !routeHint;

  // 日志等级来自 shell，而不是 localStorage：下拉框显示已保存的
  // 偏好，只有运行中的核心仍带着旧等级时才出现提示
  // （下次启动生效，docs/adr/0015）。
  var logLevel = LOG_LEVELS.indexOf(kv.loglevel) >= 0 ? kv.loglevel : "warning";
  els.selLogLevel.value = logLevel;
  els.setLogLevelHint.hidden = kv.loglevelpending !== "1";

  setButtons();
  // 删除门槛取决于运行状态，所以停止或启动都要重新判定列表。
  if (coreRunning() !== listRunning) { renderNodeList(); }
}

function refreshStatus() {
  // 按页面附加的参数：日志页带上日志大小，节点页带上渲染出的 meta id，
  // 这样两者都不必再读一次 state.json。
  var page = currentRoute === "log" ? " log" : (currentRoute === "nodes" ? " nodes" : "");
  var cmd = CLI + " status" + page;
  return exec(cmd).then(function (r) {
    if (r.errno !== 0 && !r.stdout) {
      els.banner.textContent = r.stderr || (T.actionFailed + " (status)");
      els.banner.className = "banner show";
      return null;
    }
    var kv = parseKv(r.stdout);
    renderStatus(kv);
    return kv;
  }).catch(function () { return null; /* 桥接错误已在启动时报告 */ });
}

// 三种分流模式取值对应 shell 能写入的值（docs/adr/0021）。本页不认识的值
// 一律读作全局，即无文件时的模式，这样手改 runtime/route 也绝不会
// 让下拉框空白。全局已不再是默认值：安装器写入的是 `cnadblock`。
var ROUTE_MODES = ["global", "cn", "cnadblock"];
function routeValue(v) { return ROUTE_MODES.indexOf(v) >= 0 ? v : "global"; }

export { lastState, lastKv, uptime, setButtons, coreRunning, hintText, renderStatus, refreshStatus, ROUTE_MODES, routeValue };
