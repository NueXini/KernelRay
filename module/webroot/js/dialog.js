import { T } from "./i18n.js";
import { els } from "./els.js";
import { busy, toast } from "./main.js";
import { hasBridge } from "./bridge.js";
import { linkOf, base64Link, alpnValue } from "./links.js";
import { nodeDialogModel } from "./nodelist-model.js";
import { switchTo, findNodeById, hostPort, pill, lastStateObj, lastApplied, editMode, confirmId } from "./nodelist.js";
import { lastKv } from "./status.js";

// 节点详情弹窗：点按行以只读方式打开；只有它的应用按钮会切换节点。
var dialogId = "";        // 弹窗显示的节点 id；关闭时为 ""
var dialogBusy = false;   // 从弹窗发起的一次应用正在进行
var dialogError = "";     // 弹窗上一次应用失败的信息，行内显示
var dialogMenuOpen = false;
var dialogLink = "";      // 为当前节点渲染出的规范链接

// 弹窗上次渲染的内容：没有变化时 2s 轮询绝不能重建它。
var dialogSig = "";

// ---- node detail dialog ----
// 点按行以只读方式打开它：显示节点字段与规范链接，但只有应用按钮
// 会写 `selected` 或触碰核心。与添加弹窗一样，它不持有路由或
// 历史记录条目。

function currentDialogNode() {
  return dialogId ? findNodeById(lastStateObj, dialogId) : null;
}

// 打开弹窗必须冻结背后的页面：否则遮罩上的触摸滚动会拖动底下的节点列表。
// 用 body.dialog-open（CSS）隐藏溢出；这个类还能保留滚动位置，
// 不像重置 body scrollTop 那样。
function syncDialogScrollLock() {
  document.body.classList.toggle("dialog-open",
    Boolean(dialogId || !els.overlay.hidden));
}

function openNodeDialog(n) {
  if (dialogId || dialogBusy || busy || !hasBridge || !lastStateObj || editMode || confirmId ||
      !els.overlay.hidden) {
    return;
  }
  if (!n || !n.id) { return; }
  dialogId = String(n.id);
  dialogBusy = false;
  dialogError = "";
  dialogMenuOpen = false;
  dialogLink = "";
  dialogSig = "";
  els.nodeOverlay.hidden = false;
  syncDialogScrollLock();
  renderDialog();
  if (els.ndClose && els.ndClose.focus) { els.ndClose.focus(); }
}

function closeNodeDialog() {
  if (dialogBusy) { return; }
  var id = dialogId;
  dialogId = "";
  dialogBusy = false;
  dialogError = "";
  dialogMenuOpen = false;
  dialogLink = "";
  els.nodeOverlay.hidden = true;
  syncDialogScrollLock();
  if (!id) { return; }
  var rows = els.nList.querySelectorAll(".nrow");
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute("data-id") === id) {
      if (rows[i].focus) { rows[i].focus(); }
      return;
    }
  }
}

function addInfoRow(dl, key, val) {
  if (val === null || val === undefined || String(val) === "") { return; }
  var dt = document.createElement("dt");
  dt.textContent = key;
  var dd = document.createElement("dd");
  dd.textContent = String(val);
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function renderDialog() {
  if (!dialogId) { return; }
  var node = currentDialogNode();
  if (!node) {
    if (dialogBusy) {
      els.ndError.textContent = T.nodeGone;
      els.ndError.hidden = false;
      els.ndApply.disabled = true;
      els.ndCopy.disabled = true;
      els.ndCopyMenu.disabled = true;
      dialogLink = "";
      dialogMenuOpen = false;
      els.ndMenu.hidden = true;
      return;
    }
    closeNodeDialog();
    toast(T.nodeGone);
    return;
  }

  var selectedId = lastStateObj && typeof lastStateObj.selected === "string"
    ? lastStateObj.selected : "";
  var model = nodeDialogModel(node, lastApplied, selectedId);
  // 每次 2s 轮询，renderNodeList 与 setButtons 都会走到这里。只在弹窗
  // 展示的某个事实变化时才重绘；切换语言会重置 dialogSig。
  var sig = [
    String(node.id), JSON.stringify(node), lastApplied || "", selectedId,
    model.applied ? 1 : 0, model.selected ? 1 : 0, model.dirty ? 1 : 0,
    model.action, model.noop ? 1 : 0,
    lastKv && lastKv.state ? lastKv.state : "",
    dialogBusy ? 1 : 0, busy ? 1 : 0, dialogError || "", dialogMenuOpen ? 1 : 0
  ].join("\n");
  if (sig === dialogSig) { return; }
  dialogSig = sig;

  els.ndTitle.textContent = node.name || node.protocol || "node";

  els.ndPills.textContent = "";
  if (model.applied) { els.ndPills.appendChild(pill(T.nodeApplied, "ok")); }
  else if (model.selected) { els.ndPills.appendChild(pill(T.nodePending, "warn")); }
  if (model.dirty) { els.ndPills.appendChild(pill(T.nodeDirty, "warn")); }

  els.ndInfo.textContent = "";
  addInfoRow(els.ndInfo, T.fieldProtocol, node.protocol);
  // 在 ss 的链接模型里没有传输/安全字段；显示默认值等于凭空造出字段。
  if (node.protocol !== "ss") {
    addInfoRow(els.ndInfo, T.fieldTransport, node.transport || "tcp");
    addInfoRow(els.ndInfo, T.fieldSecurity, node.security || "none");
  }
  addInfoRow(els.ndInfo, T.fieldAddress, hostPort(node));
  addInfoRow(els.ndInfo, T.fieldSni, node.sni);
  addInfoRow(els.ndInfo, T.fieldHost, node.host);
  addInfoRow(els.ndInfo, T.fieldPath, node.path);
  addInfoRow(els.ndInfo, T.fieldServiceName, node.serviceName);
  addInfoRow(els.ndInfo, T.fieldFingerprint, node.fingerprint);
  addInfoRow(els.ndInfo, T.fieldFlow, node.flow);
  addInfoRow(els.ndInfo, T.fieldAlpn, alpnValue(node));
  addInfoRow(els.ndInfo, T.fieldPublicKey, node.publicKey);
  addInfoRow(els.ndInfo, T.fieldShortId, node.shortId);
  if (node.allowInsecure !== undefined && node.allowInsecure !== null) {
    addInfoRow(els.ndInfo, T.fieldAllowInsecure, node.allowInsecure ? T.yes : T.no);
  }

  els.ndCred.textContent = "";
  if (node.protocol === "vless" || node.protocol === "vmess") {
    addInfoRow(els.ndCred, T.fieldUuid, node.uuid);
  }
  if (node.protocol === "vless") {
    addInfoRow(els.ndCred, T.fieldEncryption, node.encryption || "none");
  }
  if (node.protocol === "vmess") {
    addInfoRow(els.ndCred, T.fieldAlterId, node.alterId !== undefined ? node.alterId : 0);
    addInfoRow(els.ndCred, T.fieldCipher, node.cipher || "auto");
  }
  if (node.protocol === "trojan" || node.protocol === "ss") {
    addInfoRow(els.ndCred, T.fieldPassword, node.password);
  }
  if (node.protocol === "ss") {
    addInfoRow(els.ndCred, T.fieldMethod, node.method);
  }
  els.ndCredSection.hidden = els.ndCred.childNodes.length === 0;

  var link = "";
  var linkErr = "";
  try { link = linkOf(node); } catch (e) { linkErr = e.message || String(e); }
  dialogLink = link;
  if (!link) { dialogMenuOpen = false; }
  els.ndCopy.disabled = !link;
  els.ndCopyMenu.disabled = !link;
  if (linkErr) {
    els.ndCopyHint.textContent = T.linkError + ": " + linkErr;
    els.ndCopyHint.className = "nodehint warn";
  } else {
    els.ndCopyHint.textContent = T.copyIncludesCreds;
    els.ndCopyHint.className = "nodehint";
  }

  var hint;
  if (model.noop) { hint = T.dialogAppliedHint; }
  else if (model.action === "retry") { hint = T.dialogRetryHint; }
  else if (lastKv && lastKv.state === "running") { hint = T.dialogRunningHint; }
  else { hint = T.dialogStoppedHint; }
  els.ndHint.textContent = hint;

  if (dialogError) {
    els.ndError.textContent = dialogError;
    els.ndError.hidden = false;
  } else {
    els.ndError.textContent = "";
    els.ndError.hidden = true;
  }

  var label = model.action === "reapply" ? T.reapply
    : model.action === "retry" ? T.retryApply : T.apply;
  els.ndApply.textContent = dialogBusy ? T.applyingMsg : label;
  els.ndApply.disabled = dialogBusy || busy;
  els.ndClose.disabled = dialogBusy;

  els.ndMenu.hidden = !dialogMenuOpen;
  els.ndCopyMenu.setAttribute("aria-expanded", dialogMenuOpen ? "true" : "false");
}

function applyFromDialog() {
  var node = currentDialogNode();
  if (!node || dialogBusy || busy) { return; }
  dialogBusy = true;
  dialogError = "";
  dialogMenuOpen = false;
  renderDialog();
  try {
    switchTo(node, {
      fromDialog: true,
      done: function (err) {
        dialogBusy = false;
        if (err) {
          dialogError = err.message || String(err);
          renderDialog();
        } else {
          closeNodeDialog();
        }
      }
    });
  } catch (e) {
    dialogBusy = false;
    dialogError = e.message || String(e);
    renderDialog();
  }
}

function toggleDialogMenu() {
  if (!dialogId || !dialogLink) { return; }
  dialogMenuOpen = !dialogMenuOpen;
  renderDialog();
}

function legacyCopy(text) {
  return new Promise(function (resolve, reject) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    var active = document.activeElement;
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand("copy");
    } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (active && active.focus) { active.focus(); }
    if (ok) { resolve(); } else { reject(new Error("copy failed")); }
  });
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var p = navigator.clipboard.writeText(text);
      if (p && typeof p.then === "function") {
        return p.catch(function () { return legacyCopy(text); });
      }
    }
  } catch (e) { /* 继续走 textarea 的回退路径 */ }
  return legacyCopy(text);
}

function copyDialogLink(kind) {
  var link = dialogLink;
  if (!link) { toast(T.copyFailed); return; }
  var text = link;
  if (kind === "base64") {
    try { text = base64Link(link); } catch (e) {
      toast(T.copyFailed + ": " + (e.message || e));
      return;
    }
  }
  copyText(text).then(function () {
    toast(kind === "base64" ? T.copiedBase64 : T.copiedLink);
    dialogMenuOpen = false;
    if (dialogId) { renderDialog(); }
  }).catch(function (e) {
    toast(T.copyFailed + ": " + (e.message || e));
  });
}
// ---- end node detail dialog ----

function invalidateDialog() { dialogSig = ""; }
function closeDialogMenu() {
  dialogMenuOpen = false;
  if (dialogId) { renderDialog(); }
}

export { dialogId, dialogBusy, dialogError, dialogMenuOpen, dialogLink, dialogSig, currentDialogNode, syncDialogScrollLock, openNodeDialog, closeNodeDialog, addInfoRow, renderDialog, applyFromDialog, toggleDialogMenu, legacyCopy, copyText, copyDialogLink, invalidateDialog, closeDialogMenu };
