const fs = require("fs");
const path = require("path");

const WORKSPACE = process.env.REPLY_WORKSPACE || path.resolve(__dirname);
const DEBUG_PORT = Number(process.env.REPLY_DEBUG_PORT || 9222);
const STATE_FILE = path.join(WORKSPACE, "live_dm_state.json");
const CONFIG_FILE = path.join(WORKSPACE, "live_config.json");
const MANUAL_WAIT_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readState() {
  return { active: null, last: null, history: [], updatedAt: 0, ...readJson(STATE_FILE, {}) };
}

function updateQueue(leadId, patch) {
  const config = readJson(CONFIG_FILE, {});
  const items = Array.isArray(config.pendingLeadItems) ? config.pendingLeadItems : [];
  const index = items.findIndex((item) => String(item && item.id) === String(leadId));
  if (index < 0) return;
  items[index] = { ...items[index], ...patch, updatedAt: Date.now() };
  config.pendingLeadItems = items;
  writeJson(CONFIG_FILE, config);
}

function saveTask(task, history) {
  const state = readState();
  const nextHistory = Array.isArray(history) ? history : state.history;
  writeJson(STATE_FILE, { ...state, active: task, last: task, history: nextHistory, updatedAt: Date.now() });
}

function patchTask(leadId, patch, stepPatch) {
  const state = readState();
  if (!state.active || String(state.active.leadId) !== String(leadId)) return null;
  const task = { ...state.active, ...patch };
  if (stepPatch) task.steps = task.steps.map((step) => ({ ...step, ...(stepPatch[step.key] || {}) }));
  saveTask(task);
  updateQueue(leadId, {
    dmStatus: task.status,
    dmReason: task.reason || "",
    preparedText: task.text,
    ...(task.sentAt ? { sentAt: task.sentAt, lastSentAt: task.sentAt } : {}),
  });
  return task;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP websocket error"));
    });
    this.ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.method && this.handlers.has(message.method)) {
        for (const fn of this.handlers.get(message.method)) { try { fn(message.params); } catch {} }
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() { try { this.ws.close(); } catch {} }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: true });
  if (result && result.exceptionDetails) throw new Error("直播页面执行准备动作失败");
  return result && result.result ? result.result.value : null;
}

async function waitForTarget(targetId) {
  for (let i = 0; i < 30; i++) {
    const targets = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const target = targets.find((item) => item.type === "page" && item.id === targetId);
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(500);
  }
  throw new Error("主页标签页未就绪");
}

async function openProfile(profileUrl) {
  const version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const browser = new CDP(version.webSocketDebuggerUrl);
  try {
    const result = await browser.send("Target.createTarget", { url: profileUrl });
    return waitForTarget(result.targetId);
  } finally {
    browser.close();
  }
}

// 抖音私信面板在「标签页不可见」时不会展开（宽度卡在 1px、输入框不渲染）。
// 先把浏览器窗口最小化再还原并置前，等 document.visibilityState 变成 visible 再操作。
async function wakeBrowser(targetId) {
  // 只保证两件事：窗口不是最小化状态、目标标签页是窗口内的活动标签。
  // （早期版本用「最小化→还原」唤醒，遇到还原失败会把窗口留在最小化，导致后续全部 hidden。）
  try {
    const version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const browser = new CDP(version.webSocketDebuggerUrl);
    try {
      const info = await browser.send("Browser.getWindowForTarget", { targetId });
      const windowId = info && info.windowId;
      if (windowId) {
        const current = await browser.send("Browser.getWindowBounds", { windowId }).catch(() => null);
        const state = current && current.bounds && current.bounds.windowState;
        if (state && state !== "normal") {
          await browser.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
          await sleep(800);
        }
      }
      await browser.send("Target.activateTarget", { targetId }).catch(() => {});
    } finally {
      browser.close();
    }
  } catch (error) {
    console.log("wakeBrowser 失败（继续尝试）:", error.message);
  }
}

// 面板有时只展开到「会话列表」，需要再点一次与该用户的会话条目才会出现输入框
// 面板停在「会话列表」时，需要在列表里点开与该用户的会话才会出现输入框。
// 匹配策略：取昵称前 2 个字做包含匹配，选面积最小的那个节点点它；找不到就滚动列表再试。
async function openConversation(cdp, user) {
  return evaluate(cdp, `(function() {
    var nick = ${JSON.stringify(String(user || ""))};
    var dialog = (function(){var ds=Array.from(document.querySelectorAll("[data-e2e=im-dialog]"));var best=null,bw=-1;for(var i=0;i<ds.length;i++){var r=ds[i].getBoundingClientRect();if(r.width>bw){bw=r.width;best=ds[i];}}return best;})();
    if (!dialog) return { ok: false, reason: "no_dialog" };
    var head = nick.slice(0, 2);
    function pick() {
      var nodes = Array.from(dialog.querySelectorAll("*"));
      var best = null;
      var bestArea = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = (node.innerText || "").replace(/[\s]+/g, "");
        if (!text || text.length > nick.length + 14) continue;
        if (text.indexOf(head) < 0) continue;
        var rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        var area = rect.width * rect.height;
        if (area < bestArea) { bestArea = area; best = node; }
      }
      return best;
    }
    var target = pick();
    if (!target) {
      // 滚动会话列表再找
      var scrollers = Array.from(dialog.querySelectorAll("*")).filter(function(el) {
        return el.scrollHeight > el.clientHeight + 30;
      });
      for (var s = 0; s < scrollers.length; s++) scrollers[s].scrollTop = scrollers[s].scrollTop + 600;
      target = pick();
    }
    if (!target) return { ok: false, reason: "entry_not_found" };
    target.click();
    // 有些条目需要真实鼠标点击才生效
    var r = target.getBoundingClientRect();
    return { ok: true, reason: "entry_clicked", text: (target.innerText || "").slice(0, 20), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
}

async function clickDm(cdp) {
  return evaluate(cdp, String.raw`(function() {
    var blocked = /仅关注的人可私信|只允许关注的人私信|暂不支持私信|无法私信|不能私信/.test(document.body ? document.body.innerText : "");
    if (blocked) return { ok: false, blocked: true, reason: "stranger_dm_disabled" };
    var nodes = Array.from(document.querySelectorAll("button,[role=button],a"));
    var target = nodes.find(function(node) {
      var text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      var rect = node.getBoundingClientRect();
      return text === "私信" && rect.width > 0 && rect.height > 0;
    });
    if (!target) return { ok: false, blocked: false, reason: "dm_button_not_found" };
    if (target.disabled || target.getAttribute("aria-disabled") === "true") return { ok: false, blocked: true, reason: "stranger_dm_disabled" };
    target.click();
    return { ok: true };
  })()`);
}

// 重要修复：私信输入框只在 im-dialog 里找。
// 旧实现取「全页第一个可见 input/contenteditable」，在个人主页上命中的是顶部搜索框，
// 于是「你好」被输入到搜索框而不是私信框。
async function inspectComposer(cdp) {
  return evaluate(cdp, String.raw`(function() {
    var body = document.body ? document.body.innerText || "" : "";
    var dialog = (function(){var ds=Array.from(document.querySelectorAll("[data-e2e=im-dialog]"));var best=null,bw=-1;for(var i=0;i<ds.length;i++){var r=ds[i].getBoundingClientRect();if(r.width>bw){bw=r.width;best=ds[i];}}return best;})();
    var scope = dialog || document;
    var editors = Array.from(scope.querySelectorAll("[contenteditable=true],textarea"));
    var editor = null;
    for (var i = 0; i < editors.length; i++) {
      var rect = editors[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && !editors[i].disabled) { editor = editors[i]; break; }
    }
    var text = editor ? String(editor.innerText || editor.value || "").replace(/[\u200b]/g, "") : "";
    return {
      hasEditor: !!editor,
      inDialog: !!dialog,
      editorText: text,
      dialogText: dialog ? String(dialog.innerText || "").replace(/[\u200b]/g, "") : "",
      blocked: /仅关注的人可私信|只允许关注的人私信|暂不支持私信|无法私信|不能私信/.test(body)
    };
  })()`);
}

async function fillComposer(cdp, text) {
  const rectJson = await evaluate(cdp, String.raw`(function() {
    var dialog = (function(){var ds=Array.from(document.querySelectorAll("[data-e2e=im-dialog]"));var best=null,bw=-1;for(var i=0;i<ds.length;i++){var r=ds[i].getBoundingClientRect();if(r.width>bw){bw=r.width;best=ds[i];}}return best;})();
    var scope = dialog || document;
    var editors = Array.from(scope.querySelectorAll("[contenteditable=true],textarea"));
    for (var i = 0; i < editors.length; i++) {
      var r = editors[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && !editors[i].disabled) {
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
    }
    return null;
  })()`);
  if (!rectJson) return false;
  const point = JSON.parse(rectJson);
  // 用真实鼠标点击聚焦：Input.insertText 只对已聚焦元素生效，直接 focus() 在抖音编辑器上不可靠
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await sleep(150);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(100);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(600);
  await cdp.send("Input.insertText", { text });
  await sleep(700);
  const state = await inspectComposer(cdp);
  return String((state && state.editorText) || "").includes(text);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  const source = String(haystack || "");
  while (true) {
    const found = source.indexOf(needle, index);
    if (found < 0) break;
    count++;
    index = found + needle.length;
  }
  return count;
}

// 回车发送 + 双重确认：输入框已清空 且（对话里出现该文案 或 捕获到 message/send 成功响应）。
// 任一条件不满足一律返回 ok:false —— 绝不谎报发送成功。
async function sendComposer(cdp, text) {
  const before = await inspectComposer(cdp);
  if (!before.hasEditor) return { ok: false, reason: "composer_missing_before_send", netHits: 0 };
  const beforeCount = countOccurrences(before.dialogText, text);
  const netHits = [];
  cdp.on("Network.responseReceived", (params) => {
    const response = (params && params.response) || {};
    const url = response.url || "";
    if (/v1\/message\/send|im\/send/.test(url) && response.status < 400) netHits.push(response.status);
  });
  await cdp.send("Network.enable").catch(() => {});
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" }).catch(() => {});
  await sleep(150);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }).catch(() => {});
  await sleep(3500);
  const after = await inspectComposer(cdp);
  const cleared = !String(after.editorText || "").trim();
  const appeared = countOccurrences(after.dialogText, text) > beforeCount;
  if (cleared && appeared) return { ok: true, reason: "composer_cleared_and_message_visible", netHits: netHits.length };
  if (cleared && netHits.length) return { ok: true, reason: "composer_cleared_and_send_api_ok", netHits: netHits.length };
  return { ok: false, reason: cleared ? "input_cleared_but_message_not_visible" : "enter_did_not_send", netHits: netHits.length };
}

async function markSent(leadId, reason) {
  const state = readState();
  if (!state.active || String(state.active.leadId) !== String(leadId)) return;
  const task = { ...state.active, status: "sent", reason: reason || "message_detected", sentAt: Date.now(), completedAt: Date.now() };
  task.steps = task.steps.map((step) => ({ ...step, status: step.key === "manual" ? "done" : (step.status === "pending" ? "skipped" : "done") }));
  const history = [...(Array.isArray(state.history) ? state.history : []), task].slice(-100);
  saveTask(task, history);
  updateQueue(leadId, { dmStatus: "sent", dmReason: task.reason, sentAt: task.sentAt, lastSentAt: task.sentAt });
}

async function run(leadId) {
  const state = readState();
  const task = state.active;
  if (!task || String(task.leadId) !== String(leadId)) throw new Error("准备任务不存在");
  let cdp;
  try {
    const target = await openProfile(task.profileUrl);
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    // 关键：先让标签页真正可见，否则私信面板展不开
    await wakeBrowser(target.id);
    await cdp.send("Page.bringToFront").catch(() => {});
    let pageVisible = false;
    for (let i = 0; i < 12 && !pageVisible; i++) {
      await sleep(800);
      const visibility = await evaluate(cdp, "document.visibilityState");
      if (visibility === "visible") pageVisible = true;
    }
    console.log("页面可见:", pageVisible);
    await sleep(1200);
    const pageText = await evaluate(cdp, "document.body ? document.body.innerText || '' : ''");
    if (/扫码登录|登录后/.test(String(pageText || ""))) throw new Error("已登录会话失效，请先手动登录");
    // 私密账号/关闭私信：主页就能看出来，直接跳过，不用等点私信
    const privKeys = ["私密账号", "该用户已设置私密", "暂不公开"]; // 你说了：私密用户直接跳过
    const privText = String(pageText || "");
    const privHit = privKeys.filter(function (k) { return privText.indexOf(k) >= 0; });
    if (privHit.length) {
      patchTask(leadId, { status: "skipped", reason: "private_account (" + privHit.join("/") + ")", completedAt: Date.now() }, { profile: { status: "skipped" }, dm: { status: "skipped" }, prefill: { status: "skipped" } });
      console.log("跳过（私密账号）：", task.user);
      return;
    }
    patchTask(leadId, { status: "profile_opened", reason: "" }, { profile: { status: "done" }, dm: { status: "running" } });

    const clicked = await clickDm(cdp);
    if (!clicked || clicked.blocked) {
      patchTask(leadId, { status: "skipped", reason: "stranger_dm_disabled", completedAt: Date.now() }, { profile: { status: "done" }, dm: { status: "skipped" }, prefill: { status: "skipped" }, manual: { status: "skipped" } });
      return;
    }
    patchTask(leadId, { status: "dm_opened", reason: "" }, { dm: { status: "done" }, prefill: { status: "running" } });
    // 点「私信」后弹窗是异步渲染的，必须等输入框真正出现再填（否则会填到别处）
    let ready = false;
    for (let i = 0; i < 8 && !ready; i++) {
      await sleep(1000);
      const probe = await inspectComposer(cdp);
      if (probe && probe.hasEditor) ready = true;
    }
    if (!ready) {
      const opened = await openConversation(cdp, task.user);
      console.log("面板停在会话列表，尝试点开会话:", JSON.stringify(opened));
      if (opened && opened.ok && opened.x) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: opened.x, y: opened.y }).catch(() => {});
        await sleep(150);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: opened.x, y: opened.y, button: "left", buttons: 1, clickCount: 1 }).catch(() => {});
        await sleep(100);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: opened.x, y: opened.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
      }
      for (let i = 0; i < 8 && !ready; i++) {
        await sleep(1000);
        const probe = await inspectComposer(cdp);
        if (probe && probe.hasEditor) ready = true;
      }
    }
    if (!ready) {
      // 账号级限制：私密账号/对方关闭私信时，抖音不渲染私信面板。必须识别并标 skipped，而不是当失败重试。
      const sigKeys = ["私密账号", "仅关注的人可私信", "对方设置了隐私", "无法发送消息", "已关闭私信", "不支持私信", "无法私信"];
      const sigExpr = "(function(){var t=document.body?(document.body.innerText||''):'';var keys=" + JSON.stringify(sigKeys) + ";var hit=[];for(var i=0;i<keys.length;i++){if(t.indexOf(keys[i])>=0)hit.push(keys[i]);}return JSON.stringify({signals:hit});})()";
      const sig = await evaluate(cdp, sigExpr).catch(() => null);
      let signals = [];
      try { signals = (JSON.parse(sig || "{}").signals) || []; } catch (e) {}
      if (signals.length) {
        patchTask(leadId, { status: "skipped", reason: "stranger_dm_disabled (" + signals.join("/") + ")", completedAt: Date.now() }, { dm: { status: "skipped" }, prefill: { status: "skipped" } });
        console.log("跳过（账号限制）:", task.user, signals.join("/"));
        return;
      }
      throw new Error("私信输入框未出现（im-dialog 未展开或无输入框）");
    }
    const filled = await fillComposer(cdp, task.text);
    if (!filled) throw new Error("私信输入框不可编辑或文案未填入");
    patchTask(leadId, { status: "prefilled", reason: "已填入私信框，自动发送中" }, { prefill: { status: "done" } });

    // 默认自动发送；DM_AUTO_SEND=0 可退回「预填 + 人工点发送」
    if (process.env.DM_AUTO_SEND !== "0") {
      const sent = await sendComposer(cdp, task.text);
      if (sent.ok) {
        await markSent(leadId, sent.reason);
        console.log("DM_SENT", task.user, "|", sent.reason, "| netHits", sent.netHits);
        return;
      }
      console.log("自动发送未确认:", sent.reason, "-> 转人工确认");
      patchTask(leadId, { status: "waiting_manual_send", reason: "自动发送未确认：" + sent.reason }, { send: { status: "failed" }, manual: { status: "running" } });
    } else {
      patchTask(leadId, { status: "waiting_manual_send", reason: "已预填，等待人工点击发送" }, { prefill: { status: "done" }, manual: { status: "running" } });
      console.log("prefilled, waiting for human send:", task.user);
    }

    const deadline = Date.now() + MANUAL_WAIT_MS;
    while (Date.now() < deadline) {
      const current = readState();
      if (!current.active || String(current.active.leadId) !== String(leadId)) return;
      if (["skipped", "sent", "failed"].includes(current.active.status)) return;
      const composer = await inspectComposer(cdp);
      // 只在输入框已清空且正文区域出现文案时判定发送，不点击发送按钮。
      if (!composer.hasEditor || (!String(composer.editorText || "").trim() && String(composer.dialogText || "").includes(task.text))) {
        await markSent(leadId, "message_detected");
        return;
      }
      await sleep(1500);
    }
    patchTask(leadId, { status: "failed", reason: "manual_send_timeout", completedAt: Date.now() }, { manual: { status: "failed" } });
  } catch (error) {
    const reason = error.message.includes("登录") ? "login_required" : error.message;
    patchTask(leadId, { status: "failed", reason, completedAt: Date.now() }, { profile: { status: "failed" }, dm: { status: "failed" }, prefill: { status: "failed" }, manual: { status: "failed" } });
    console.error("live dm prepare failed:", reason);
  } finally {
    if (cdp) cdp.close();
  }
}

run(process.argv[2]).catch((error) => console.error("live dm worker fatal:", error.message));

