// 视频评论分发 worker：打开视频 -> 打开评论区 -> 定位评论输入框 -> 预填文案 -> 人工/自动发送
// 与 reply_worker.js（回复具体评论）不同：本 worker 是给视频发「新评论」（顶层评论）
const fs = require("fs");
const path = require("path");

const WORKSPACE = process.env.REPLY_WORKSPACE || path.resolve(__dirname);
const DEBUG_PORT = Number(process.env.REPLY_DEBUG_PORT || 9222);
const QUEUE_FILE = path.join(WORKSPACE, "video_comment_queue.json");
const CONFIG_FILE = path.join(WORKSPACE, "video_comment_config.json");
const STATE_FILE = path.join(WORKSPACE, "video_comment_state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------- CDP ----------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("ws error")); });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      else if (msg.method) { (this.handlers.get(msg.method) || []).forEach((fn) => fn(msg.params)); }
    };
  }
  async send(method, params = {}) { await this.ready; return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  off(method, fn) { const arr = this.handlers.get(method) || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
  close() { try { this.ws.close(); } catch {} }
}
const sendT = (cdp, method, params, t = 12000) => Promise.race([
  cdp.send(method, params),
  new Promise((_, rej) => setTimeout(() => rej(new Error(method + " timeout")), t)),
]);

async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }

async function evaluate(cdp, expression) {
  const r = await sendT(cdp, "Runtime.evaluate", { expression, returnByValue: true, userGesture: true });
  if (r && r.exceptionDetails) throw new Error("页面脚本执行失败");
  return r && r.result ? r.result.value : null;
}

// 打开视频标签页（抖音会把 /video/xxx 重定向到 /jingxuan?modal_id=xxx）
async function openVideoTab(awemeId) {
  const ver = await getJson("http://127.0.0.1:" + DEBUG_PORT + "/json/version");
  const browser = new CDP(ver.webSocketDebuggerUrl);
  let targetId;
  try {
    const res = await sendT(browser, "Target.createTarget", { url: "https://www.douyin.com/video/" + awemeId }, 15000);
    targetId = res.targetId;
  } finally { browser.close(); }
  for (let i = 0; i < 30; i++) {
    const list = await getJson("http://127.0.0.1:" + DEBUG_PORT + "/json/list");
    const tab = list.find((t) => t.type === "page" && t.id === targetId);
    if (tab && tab.webSocketDebuggerUrl) return tab;
    await sleep(500);
  }
  throw new Error("视频标签页未就绪");
}

async function activateTab(cdp) {
  try {
    const list = await getJson("http://127.0.0.1:" + DEBUG_PORT + "/json/list");
    const tab = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl === cdp.ws.url);
    if (!tab) return;
    const ver = await getJson("http://127.0.0.1:" + DEBUG_PORT + "/json/version");
    const browser = new CDP(ver.webSocketDebuggerUrl);
    try { await sendT(browser, "Target.activateTarget", { targetId: tab.id }, 8000); } finally { browser.close(); }
  } catch {}
}

// 打开评论面板（点击「评论」标签）
async function openCommentPanel(cdp) {
  for (let round = 0; round < 12; round++) {
    const hasList = await evaluate(cdp, "!!document.querySelector('[data-e2e=comment-list]')").catch(() => false);
    if (hasList) return true;
    await evaluate(cdp, `(function(){
      var all=Array.from(document.querySelectorAll('div,span,button,a'));
      for (var i=0;i<all.length;i++){
        var el=all[i];
        if (el.children && el.children.length>0) continue;
        if ((el.innerText||'').trim()==='评论'){ var r=el.getBoundingClientRect(); if(r.width>0){ el.click(); return true; } }
      }
      return false;
    })()`).catch(() => {});
    await sleep(1500);
  }
  return false;
}

// 点击评论输入框容器，激活 DraftJS 编辑器
async function focusCommentInput(cdp) {
  const pos = await evaluate(cdp, `(function(){
    var box=document.querySelector('.comment-input-container') || document.querySelector('[class*=comment-input-container]');
    if(!box) return null;
    var r=box.getBoundingClientRect();
    if(r.width<=0) return null;
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (!pos) return false;
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y }, 6000).catch(() => {});
  await sleep(rand(120, 300));
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, 6000).catch(() => {});
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 }, 6000).catch(() => {});
  await sleep(rand(700, 1200));
  // 确认编辑器已出现且可见
  const ok = await evaluate(cdp, `(function(){
    var eds=Array.from(document.querySelectorAll('[contenteditable=true]'));
    for (var i=0;i<eds.length;i++){ var r=eds[i].getBoundingClientRect(); if(r.width>0&&r.height>0) return true; }
    return false;
  })()`).catch(() => false);
  return !!ok;
}

// 向可见编辑器写入文案
async function fillComment(cdp, text) {
  const focused = await evaluate(cdp, `(function(){
    var eds=Array.from(document.querySelectorAll('[contenteditable=true]'));
    for (var i=0;i<eds.length;i++){ var r=eds[i].getBoundingClientRect(); if(r.width>0&&r.height>0){ eds[i].focus(); return true; } }
    return false;
  })()`).catch(() => false);
  if (!focused) return false;
  await sleep(rand(200, 400));
  await sendT(cdp, "Input.insertText", { text }, 8000);
  await sleep(rand(400, 700));
  const state = await evaluate(cdp, `(function(){
    var eds=Array.from(document.querySelectorAll('[contenteditable=true]'));
    for (var i=0;i<eds.length;i++){ var r=eds[i].getBoundingClientRect(); if(r.width>0&&r.height>0) return (eds[i].innerText||'').trim(); }
    return '';
  })()`).catch(() => "");
  return String(state || "").includes(text.slice(0, 12));
}

// 发送：Enter 主路径，失败再找发送按钮
async function submitComment(cdp, text) {
  const netHits = [];
  const onReq = (p) => { if (p.request && p.request.method === "POST" && /comment\/publish/i.test(p.request.url)) netHits.push({ requestId: p.requestId }); };
  let respHandler = null;
  cdp.on("Network.requestWillBeSent", onReq);
  respHandler = (p) => { const hit = netHits.find((h) => h.requestId === p.requestId); if (hit) hit.status = p.response.status; };
  cdp.on("Network.responseReceived", respHandler);
  await activateTab(cdp);
  await sleep(rand(300, 600));
  await sendT(cdp, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 8000).catch(() => {});
  await sendT(cdp, "Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 }, 8000).catch(() => {});
  await sendT(cdp, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, 8000).catch(() => {});
  await sleep(2500);
  // 兜底：Enter 无效则点发送按钮
  if (!netHits.length) {
    const btn = await evaluate(cdp, `(function(){
      var cands=Array.from(document.querySelectorAll('button,div,span'));
      for (var i=0;i<cands.length;i++){
        var el=cands[i];
        if (el.children.length>0) continue;
        if ((el.innerText||'').trim() !== '发送') continue;
        var r=el.getBoundingClientRect();
        if (r.width<=0) continue;
        var p=el.parentElement, cls=((p&&p.className)||'').toString();
        if (cls.indexOf('danmaku')>=0 || cls.indexOf('chat-send')>=0) continue; // 排除弹幕/AI 发送
        return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) };
      }
      return null;
    })()`).catch(() => null);
    if (btn) {
      await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y }, 6000).catch(() => {});
      await sleep(200);
      await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 }, 6000).catch(() => {});
      await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 }, 6000).catch(() => {});
      await sleep(2500);
    }
  }
  cdp.off("Network.requestWillBeSent", onReq);
  if (respHandler) cdp.off("Network.responseReceived", respHandler);
  return netHits;
}

// 校验结果
async function verifyPublish(cdp, hits) {
  if (!hits.length) {
    const cleared = await evaluate(cdp, `(function(){
      var eds=Array.from(document.querySelectorAll('[contenteditable=true]'));
      for (var i=0;i<eds.length;i++){ var r=eds[i].getBoundingClientRect(); if(r.width>0&&r.height>0) return (eds[i].innerText||'').trim(); }
      return null;
    })()`).catch(() => null);
    if (cleared === "") return { ok: true, note: "输入框已清空（推断发送成功）" };
    return { ok: false, error: "未捕获到 comment/publish 请求" };
  }
  for (const h of hits) {
    try {
      const b = await sendT(cdp, "Network.getResponseBody", { requestId: h.requestId }, 8000);
      const body = b && b.body ? b.body : "";
      if (/"status_code"\s*:\s*0/.test(body)) return { ok: true, note: "publish status_code=0" };
      if (body) return { ok: false, error: "被拒绝: " + body.slice(0, 100) };
      return { ok: false, error: "publish 空响应（疑似风控）" };
    } catch {}
  }
  return { ok: false, error: "publish 响应读取失败" };
}

// ---------------- 主流程 ----------------
async function processOne(cdp, job, config) {
  const text = String(job.text || "").trim();
  if (!text) return { ok: false, error: "文案为空" };

  const opened = await openCommentPanel(cdp);
  if (!opened) return { ok: false, error: "评论区未打开（可能需要登录）" };
  await sleep(rand(800, 1500));

  const focused = await focusCommentInput(cdp);
  if (!focused) return { ok: false, error: "未找到评论输入框（comment-input-container）" };
  await sleep(rand(500, 900));

  const filled = await fillComment(cdp, text);
  if (!filled) return { ok: false, error: "文案未写入输入框" };

  const mode = config.mode === "auto" ? "auto" : "manual";
  if (mode === "manual") {
    // 半自动：填好停下，等人工点发送
    return { ok: true, pending: true, note: "已预填，等待人工发送" };
  }
  const hits = await submitComment(cdp, text);
  return await verifyPublish(cdp, hits);
}

(async () => {
  const config = Object.assign({ mode: "manual", stepIntervalSec: 8, dailyLimit: 50 }, readJson(CONFIG_FILE, {}));
  const queue = readJson(QUEUE_FILE, { queued: [], done: [] });
  const job = queue.queued.find((x) => x.status !== "done" && x.status !== "failed");
  if (!job) { console.log("VIDEO_COMMENT_IDLE"); process.exit(0); }
  job.status = "sending";
  writeJson(QUEUE_FILE, queue);

  let cdp = null;
  try {
    const tab = await openVideoTab(job.awemeId);
    cdp = new CDP(tab.webSocketDebuggerUrl);
    await sendT(cdp, "Runtime.enable", {}, 10000);
    await sendT(cdp, "Network.enable", {}, 10000);
    await sleep(rand(2500, 4000)); // 等页面渲染
    const res = await processOne(cdp, job, config);
    const idx = queue.queued.findIndex((x) => x.id === job.id);
    if (res.ok) {
      queue.queued[idx] = Object.assign({}, queue.queued[idx], { status: res.pending ? "waiting_manual" : "done", result: res.note || "ok", finishedAt: Date.now() });
      console.log(res.pending ? "VIDEO_COMMENT_PREFILLED" : "VIDEO_COMMENT_DONE");
    } else {
      queue.queued[idx] = Object.assign({}, queue.queued[idx], { status: "failed", error: res.error, finishedAt: Date.now() });
      console.log("VIDEO_COMMENT_FAILED:", res.error);
    }
    writeJson(QUEUE_FILE, queue);
  } catch (e) {
    const idx = queue.queued.findIndex((x) => x.id === job.id);
    if (idx >= 0) { queue.queued[idx] = Object.assign({}, queue.queued[idx], { status: "failed", error: e.message.slice(0, 120), finishedAt: Date.now() }); writeJson(QUEUE_FILE, queue); }
    console.log("VIDEO_COMMENT_ERROR:", e.message);
  } finally {
    if (cdp) cdp.close();
  }
  process.exit(0);
})();
