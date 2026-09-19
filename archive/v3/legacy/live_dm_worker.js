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
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP websocket error"));
    });
    this.ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
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

async function inspectComposer(cdp) {
  return evaluate(cdp, String.raw`(function() {
    var body = document.body ? document.body.innerText || "" : "";
    var editors = Array.from(document.querySelectorAll("[contenteditable=true],textarea,input"));
    var editor = editors.find(function(node) {
      var rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled && node.getAttribute("aria-disabled") !== "true";
    });
    var text = editor ? (editor.innerText || editor.value || "") : "";
    return { hasEditor: !!editor, editorText: text, blocked: /仅关注的人可私信|只允许关注的人私信|暂不支持私信|无法私信|不能私信/.test(body), bodyText: body.slice(-3000) };
  })()`);
}

async function fillComposer(cdp, text) {
  const focused = await evaluate(cdp, String.raw`(function() {
    var editors = Array.from(document.querySelectorAll("[contenteditable=true],textarea,input"));
    var editor = editors.find(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !node.disabled; });
    if (!editor) return false;
    editor.focus();
    editor.click();
    return true;
  })()`);
  if (!focused) return false;
  await cdp.send("Input.insertText", { text });
  await sleep(500);
  const state = await inspectComposer(cdp);
  return String(state && state.editorText || "").includes(text);
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
    await sleep(1200);
    const pageText = await evaluate(cdp, "document.body ? document.body.innerText || '' : ''");
    if (/扫码登录|登录后/.test(String(pageText || ""))) throw new Error("已登录会话失效，请先手动登录");
    patchTask(leadId, { status: "profile_opened", reason: "" }, { profile: { status: "done" }, dm: { status: "running" } });

    const clicked = await clickDm(cdp);
    if (!clicked || clicked.blocked) {
      patchTask(leadId, { status: "skipped", reason: "stranger_dm_disabled", completedAt: Date.now() }, { profile: { status: "done" }, dm: { status: "skipped" }, prefill: { status: "skipped" }, manual: { status: "skipped" } });
      return;
    }
    patchTask(leadId, { status: "dm_opened", reason: "" }, { dm: { status: "done" }, prefill: { status: "running" } });
    await sleep(1200);
    const filled = await fillComposer(cdp, task.text);
    if (!filled) throw new Error("私信输入框不存在或不可编辑");
    patchTask(leadId, { status: "waiting_manual_send", reason: "已预填，等待人工点击发送" }, { prefill: { status: "done" }, manual: { status: "running" } });
    console.log("prefilled, waiting for human send:", task.user);

    const deadline = Date.now() + MANUAL_WAIT_MS;
    while (Date.now() < deadline) {
      const current = readState();
      if (!current.active || String(current.active.leadId) !== String(leadId)) return;
      if (["skipped", "sent", "failed"].includes(current.active.status)) return;
      const composer = await inspectComposer(cdp);
      // 只在输入框已清空且正文区域出现文案时判定发送，不点击发送按钮。
      if (!composer.hasEditor || (!composer.editorText && String(composer.bodyText || "").includes(task.text))) {
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

