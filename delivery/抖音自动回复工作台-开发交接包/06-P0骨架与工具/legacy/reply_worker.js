
const fs = require("fs");
const path = require("path");
async function getJson(url, timeout = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.json(); }
  finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
}
const sendT = (cdp, method, params, t = 12000) => Promise.race([
  cdp.send(method, params),
  new Promise((_, rej) => setTimeout(() => rej(new Error(method + " TO")), t)),
]);

const PORT = Number(process.env.REPLY_DEBUG_PORT || 9222);
const WORKSPACE = process.env.REPLY_WORKSPACE || path.resolve(__dirname);
const QUEUE_FILE = path.join(WORKSPACE, "replies_queue.json");
const COMMENTS_FILE = path.join(WORKSPACE, "filtered_comments.json");

function readQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch { return { queued: [], done: [] }; }
}
function saveQueue(q) { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), "utf8"); }
function lookupComment(cid) {
  try {
    const list = JSON.parse(fs.readFileSync(COMMENTS_FILE, "utf8"));
    const c = list.find((x) => String(x.commentId) === String(cid));
    return c || null;
  } catch { return null; }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, "")
    .replace(/[，。,.!！?？:：;；、"'“”‘’()\[\]{}<>《》【】（）\-_=+~`@#$%^&*]/g, "")
    .toLowerCase();
}

async function createTab(url) {
  const version = await getJson("http://127.0.0.1:" + PORT + "/json/version");
  const browser = new CDP(version.webSocketDebuggerUrl);
  const { targetId } = await sendT(browser, "Target.createTarget", { url }, 15000);
  await sleep(1200);
  for (let i = 0; i < 20; i++) {
    const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
    const tab = list.find((t) => t.type === "page" && t.id === targetId);
    if (tab && tab.webSocketDebuggerUrl) {
      try { await sendT(browser, "Target.activateTarget", { targetId }, 8000); } catch {}
      return new CDP(tab.webSocketDebuggerUrl);
    }
    await sleep(500);
  }
  throw new Error("tab not ready");
}

// 「找到评论 -> 滚入视口 -> 取按钮坐标」合并成一次同步调用，避免两次调用之间
// 评论节点被虚拟列表回收，导致「评论找到了但按钮找不到」。
const BTN_NORM = "\\s\\[\\]，。,.!！?？:：;；、\\\"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~`@#$%^&*";
function btnCoordsExpression(q, n) {
  return "JSON.stringify((function(){ var q=" + JSON.stringify(q) + "; var n=" + JSON.stringify(n) +
    "; var RE=new RegExp(" + JSON.stringify(BTN_NORM) + ",'g');" +
    " var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]'));" +
    " for(var i=0;i<items.length;i++){" +
    " var norm=(items[i].innerText||'').replace(RE,'').toLowerCase();" +
    " if(norm.indexOf(q)<0 || (n && n.length>1 && norm.indexOf(n)<0)) continue;" +
    " items[i].scrollIntoView({block:'center'});" +
    " var els=Array.from(items[i].querySelectorAll('button,[role=\"button\"],a,div,span'));" +
    " var cand=els.filter(function(e){ var t=(e.innerText||e.textContent||'').replace(/\s+/g,'').trim();" +
    " var r=e.getBoundingClientRect(), s=getComputedStyle(e);" +
    " return t==='回复' && r.width>0 && r.height>0 && r.bottom>=0 && r.top<=innerHeight && s.visibility!=='hidden' && s.display!=='none'; });" +
    " cand.sort(function(a,b){ var ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();" +
    " var as=(a.tagName==='BUTTON'||a.getAttribute('role')==='button')?10:0;" +
    " var bs=(b.tagName==='BUTTON'||b.getAttribute('role')==='button')?10:0;" +
    " return (bs+br.width*br.height/1000)-(as+ar.width*ar.height/1000); });" +
    " if(cand.length){ var rr=cand[0].getBoundingClientRect();" +
    " return {x:Math.round(rr.x+rr.width/2), y:Math.round(rr.y+rr.height/2), tag:cand[0].tagName, count:cand.length}; } }" +
    " return null; })())";
}

// 只读「回复」按钮坐标（不滚动）：用于滚动后等页面重渲染再取坐标
function replyBtnFindExpression(q, n) {
  return "JSON.stringify((function(){ var q=" + JSON.stringify(q) + "; var n=" + JSON.stringify(n) +
    "; var RE=new RegExp(" + JSON.stringify(BTN_NORM) + ",'g');" +
    " var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]'));" +
    " for(var i=0;i<items.length;i++){" +
    " var norm=(items[i].innerText||'').replace(RE,'').toLowerCase();" +
    " if(norm.indexOf(q)<0 || (n && n.length>1 && norm.indexOf(n)<0)) continue;" +
    " var els=Array.from(items[i].querySelectorAll('button,[role=\"button\"],a,div,span'));" +
    " var cand=els.filter(function(e){ var t=(e.innerText||e.textContent||'').replace(/\s+/g,'').trim();" +
    " var r=e.getBoundingClientRect(), s=getComputedStyle(e);" +
    " return t==='回复' && r.width>0 && r.height>0 && r.bottom>=0 && r.top<=innerHeight && s.visibility!=='hidden' && s.display!=='none'; });" +
    " cand.sort(function(a,b){ var ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();" +
    " var as=(a.tagName==='BUTTON'||a.getAttribute('role')==='button')?10:0;" +
    " var bs=(b.tagName==='BUTTON'||b.getAttribute('role')==='button')?10:0;" +
    " return (bs+br.width*br.height/1000)-(as+ar.width*ar.height/1000); });" +
    " if(cand.length){ var rr=cand[0].getBoundingClientRect();" +
    " return {x:Math.round(rr.x+rr.width/2), y:Math.round(rr.y+rr.height/2), tag:cand[0].tagName, count:cand.length}; } }" +
    " return null; })())";
}
async function replyOne(cdp, item, comment) {
  if (!comment || !comment.text) return { ok: false, error: "comment text not found in filtered data" };
  const targetText = normalizeText(comment.text);
  const targetNick = normalizeText(comment.user);
  const qLiteral = JSON.stringify(targetText);
  const nickLiteral = JSON.stringify(targetNick);
  // bring tab to front (Enter-send requires active tab)
  try {
    const version = await getJson("http://127.0.0.1:" + PORT + "/json/version");
    const bws = new CDP(version.webSocketDebuggerUrl);
    const tlist = await getJson("http://127.0.0.1:" + PORT + "/json/list");
    const myTab = tlist.find((t) => t.type === "page" && t.webSocketDebuggerUrl === cdp.ws.url);
    if (myTab) await sendT(bws, "Target.activateTarget", { targetId: myTab.id }, 8000);
  } catch (e) {}
  // 导航带一次重试：瞬时超时（浏览器繁忙/刚重启）不应直接判失败
  const videoUrl = "https://www.douyin.com/video/" + item.awemeId;
  try {
    await sendT(cdp, "Page.navigate", { url: videoUrl }, 15000);
  } catch (e) {
    console.log("  step: navigate 超时，1.5s 后重试一次");
    await sleep(1500);
    await sendT(cdp, "Page.navigate", { url: videoUrl }, 25000);
  }
  // wait load
  const loaded = new Promise((resolve) => {
    const fn = () => { cdp.off("Page.loadEventFired", fn); resolve(true); };
    cdp.on("Page.loadEventFired", fn);
    setTimeout(() => { cdp.off("Page.loadEventFired", fn); resolve(false); }, 20000);
  });
  await loaded;
  // 等待评论区「真正可见」：节点存在不等于面板已展开——隐藏时容器是 display:none，
  // 内部所有按钮尺寸为 0，会导致「评论找到了但回复按钮找不到」。
  // 做法：先纯轮询；不可见则用真实鼠标点击评论入口一次，然后耐心等待（避免反复点击把面板开关来回切换）。
  async function panelVisible() {
    const r = await sendT(cdp, "Runtime.evaluate", { expression: "JSON.stringify((function(){ var ls=Array.from(document.querySelectorAll('[data-e2e=comment-list]')); for(var i=0;i<ls.length;i++){ var r=ls[i].getBoundingClientRect(); if(r.width>0&&r.height>0) return {visible:true}; } return {visible:false}; })())", returnByValue: true }, 8000).catch(() => null);
    try { return !!(r && r.result && JSON.parse(r.result.value).visible); } catch { return false; }
  }
  let panelReady = false;
  for (let attempt = 0; attempt < 3 && !panelReady; attempt++) {
    for (let i = 0; i < 4; i++) {
      if (await panelVisible()) { panelReady = true; break; }
      await sleep(1200);
    }
    if (panelReady) break;
    const entryRes = await sendT(cdp, "Runtime.evaluate", { expression: "JSON.stringify((function(){ var icon=document.querySelector('[data-e2e=feed-comment-icon]'); if(icon){ var r=icon.getBoundingClientRect(); if(r.width>0&&r.height>0) return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), kind:'feed-comment-icon'}; } var all=Array.from(document.querySelectorAll('div,span,button,a,[role=tab]')); for(var i=0;i<all.length;i++){ var e=all[i];   if(e.children&&e.children.length>0) continue;   if((e.innerText||'').trim()!=='评论') continue;   var rr=e.getBoundingClientRect(); if(rr.width<=0||rr.height<=0) continue;   return {x:Math.round(rr.x+rr.width/2), y:Math.round(rr.y+rr.height/2), kind:'评论tab'}; } return null; })())", returnByValue: true }, 8000).catch(() => null);
    let entry = null;
    try { entry = entryRes && entryRes.result && JSON.parse(entryRes.result.value); } catch {}
    if (!entry) { await sleep(1500); continue; }
    console.log("  step: 点击评论入口(" + entry.kind + ")展开评论区");
    await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: entry.x, y: entry.y }, 6000).catch(() => {});
    await sleep(200);
    await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: entry.x, y: entry.y, button: "left", buttons: 1, clickCount: 1 }, 6000).catch(() => {});
    await sleep(120);
    await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: entry.x, y: entry.y, button: "left", buttons: 0, clickCount: 1 }, 6000).catch(() => {});
    // 点击后耐心等待面板展开（最多约 18 秒），期间不再点击
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      if (await panelVisible()) { panelReady = true; console.log("  step: 评论区已展开"); break; }
    }
  }
  if (!panelReady) {
    const noteCheck = await sendT(cdp, "Runtime.evaluate", {
      expression: "(!!document.querySelector('.note-detail-container')) || location.pathname.indexOf('/note/') >= 0",
      returnByValue: true,
    }, 8000).catch(() => ({ result: { value: false } }));
    if (noteCheck && noteCheck.result && noteCheck.result.value) {
      return { ok: false, skip: true, error: "note_post_panel_unsupported (图文帖网页版评论区是小浮层，无法稳定展开并定位回复按钮)" };
    }
    return { ok: false, error: "comment panel not visible (评论区未展开)" };
  }
  await sleep(1500);
  // captcha detection: pause if 验证码 appears
  const capRes = await sendT(cdp, "Runtime.evaluate", {
    expression: "JSON.stringify((function(){ var t=(document.title||''); var b=(document.body?document.body.innerText:''); return (t.indexOf('验证码')>=0 || b.indexOf('验证码中间页')>=0 || b.indexOf('请输入验证码')>=0); })())",
    returnByValue: true,
  }, 8000).catch(() => ({ result: { value: "false" } }));
  if (capRes.result.value === "true") return { ok: false, error: "CAPTCHA", captcha: true };

  // infinite scroll to find comment (wheel + scrollAll + expand, proven to load deep comments)
  let found = false;
  const scrollBottom = async () => {
    await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseWheel", deltaX: 0, deltaY: 2000, x: 900, y: 500 }, 6000).catch(() => {});
    await sendT(cdp, "Runtime.evaluate", {
      expression: "(function(){ var all=Array.from(document.querySelectorAll('*')); for(var i=all.length-1;i>=0;i--){ var e=all[i]; if(e.scrollHeight > e.clientHeight + 200){ var cs=getComputedStyle(e); if(/scroll|auto/.test(cs.overflowY)){ e.scrollTop = e.scrollHeight; } } } return 'ok'; })()",
      returnByValue: true,
    }, 6000).catch(() => {});
  };
  for (let round = 0; round < 40; round++) {
    await scrollBottom().catch(() => {});
    await sleep(2500);
    // expand reply threads so nested comments become searchable
    if (round % 2 === 0) {
      await sendT(cdp, "Runtime.evaluate", {
        expression: "JSON.stringify((function(){ var btns=Array.from(document.querySelectorAll('*')).filter(function(e){ var t=(e.innerText||'').trim(); return /^展开[0-9]+条回复$/.test(t) && e.children.length===0; }); if(!btns.length) return 0; var n=0; for(var i=0;i<btns.length && i<15;i++){ btns[i].click(); n++; } return n; })())",
        returnByValue: true,
      }, 10000).catch(() => {});
      await sleep(2000);
    }
    const r = await sendT(cdp, "Runtime.evaluate", {
    expression: "JSON.stringify((function(){ var q=" + qLiteral + "; var n=" + nickLiteral + "; var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]')); for(var i=0;i<items.length;i++){ var txt=(items[i].innerText||''); var norm=txt.replace(/[\\s\\[\\]，。,.!！?？:：;；、\\\"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~`@#$%^&*]/g,'').toLowerCase(); if(norm.indexOf(q)>=0 && (!n || norm.indexOf(n)>=0 || n.length<=1)){ return {found:true, index:i, count:items.length}; } } return {found:false, count:items.length}; })())",
      returnByValue: true,
    }, 10000).catch(() => ({ result: { value: "{\"found\":false,\"count\":-1}" } }));
    try {
      const st = JSON.parse(r.result.value);
      if (round % 5 === 0) console.log("  scroll round", round, "count:", st.count);
      if (st.found) { found = true; break; }
    } catch {}
  }
  if (!found) {
    // 图文帖(note)的可见评论区是右侧小浮层，深评论常因虚拟列表回收而找不到；
    // 统一按「跳过」处理并写明原因，避免把平台布局差异当成失败刷屏。
    const noteCheck2 = await sendT(cdp, "Runtime.evaluate", {
      expression: "(!!document.querySelector('.note-detail-container')) || location.pathname.indexOf('/note/') >= 0",
      returnByValue: true,
    }, 8000).catch(() => ({ result: { value: false } }));
    if (noteCheck2 && noteCheck2.result && noteCheck2.result.value) {
      return { ok: false, skip: true, error: "note_post_panel_unsupported (图文帖网页版评论区是小浮层，评论无法稳定定位)" };
    }
    return { ok: false, error: "comment not found after 30 scroll rounds" };
  }

  // 定位「回复」按钮：把「找到评论 -> 滚入视口 -> 取按钮坐标」放在同一次调用里同步完成，
  // 避免两次调用之间评论节点被虚拟列表回收，导致「评论找到了但按钮找不到」。失败时重试若干次。
  let bp = null;
  for (let attempt = 0; attempt < 6 && !bp; attempt++) {
    if (attempt > 0) {
      console.log("  step: 回复按钮未找到，重试 " + attempt + "/6");
      // 轻微上滚再滚到底，促使列表重新渲染出该评论
      await sendT(cdp, "Runtime.evaluate", {
        expression: "JSON.stringify((function(){ var all=Array.from(document.querySelectorAll('*')); for(var i=0;i<all.length;i++){ var e=all[i]; if(e.scrollHeight>e.clientHeight+100){ var cs=getComputedStyle(e); if(/scroll|auto/.test(cs.overflowY)){ e.scrollTop=Math.max(0,e.scrollTop-600); } } } return 'ok'; })())",
        returnByValue: true,
      }, 8000).catch(() => {});
      await sleep(1200);
      await scrollBottom().catch(() => {});
      await sleep(1500);
    }
    const merged = await sendT(cdp, "Runtime.evaluate", { expression: btnCoordsExpression(targetText, targetNick), returnByValue: true }, 10000).catch(() => null);
    const mv = merged && merged.result && JSON.parse(merged.result.value);
    if (mv) { bp = mv; break; }
    // 合并调用已把评论滚入视口；等虚拟列表重渲染后再读一次按钮坐标（同步读会拿到 0×0）
    await sleep(1200);
    const again = await sendT(cdp, "Runtime.evaluate", { expression: replyBtnFindExpression(targetText, targetNick), returnByValue: true }, 10000).catch(() => null);
    const av = again && again.result && JSON.parse(again.result.value);
    if (av) { bp = av; break; }
  }
  if (!bp) {
    // 图文帖(note)网页版的评论区是右侧小浮层，深评论会被虚拟列表回收，无法稳定定位「回复」按钮。
    // 这类目标按「跳过」处理并写明原因，避免反复失败、污染队列。
    const isNote = await sendT(cdp, "Runtime.evaluate", {
      expression: "(!!document.querySelector('.note-detail-container')) || location.pathname.indexOf('/note/') >= 0",
      returnByValue: true,
    }, 8000).catch(() => ({ result: { value: false } }));
    if (isNote && isNote.result && isNote.result.value) {
      return { ok: false, skip: true, error: "note_post_panel_unsupported (图文帖网页版评论区是小浮层，无法稳定定位回复按钮)" };
    }
    return { ok: false, error: "reply button not found" };
  }
  console.log("  step: 回复 button at", bp.x, bp.y);
  // real trusted click on 回复 (activates inline reply composer)
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseMoved", x: bp.x, y: bp.y }, 8000).catch(() => {});
  await sleep(400);
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: bp.x, y: bp.y, button: "left", buttons: 1, clickCount: 1 }, 8000).catch(() => {});
  await sleep(180);
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: bp.x, y: bp.y, button: "left", buttons: 0, clickCount: 1 }, 8000).catch(() => {});
  await sleep(2500);

  // find the INLINE reply editor INSIDE the matched comment item (回复中 state)
  let inp = null;
  for (let attempt = 0; attempt < 3 && !inp; attempt++) {
    if (attempt > 0) {
      // retry the 回复 click (re-scroll to comment + click)
      const sc2 = await sendT(cdp, "Runtime.evaluate", {
        expression: "JSON.stringify((function(){ var q=" + qLiteral + "; var n=" + nickLiteral + "; var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]')); for(var i=0;i<items.length;i++){ var txt=(items[i].innerText||''); var norm=txt.replace(/[\\s\\[\\]，。,.!！?？:：;；、\\\"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~`@#$%^&*]/g,'').toLowerCase(); if(norm.indexOf(q)>=0 && (!n || norm.indexOf(n)>=0 || n.length<=1)){ items[i].scrollIntoView({block:'center'}); return true; } } return false; })())",
        returnByValue: true,
      }, 10000);
      await sleep(1800);
      const btn2 = await sendT(cdp, "Runtime.evaluate", {
        expression: "JSON.stringify((function(){ var q=" + qLiteral + "; var n=" + nickLiteral + "; var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]')); for(var i=0;i<items.length;i++){ var itemText=(items[i].innerText||''); var norm=itemText.replace(/[\\s\\[\\]，。,.!！?？:：;；、\\\"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~`@#$%^&*]/g,'').toLowerCase(); if(norm.indexOf(q)<0 || (n && n.length>1 && norm.indexOf(n)<0)) continue; var els=Array.from(items[i].querySelectorAll('button,[role=\"button\"],a,div,span')); var cand=els.filter(function(e){ var t=(e.innerText||e.textContent||'').replace(/\\s+/g,'').trim(); var r=e.getBoundingClientRect(), s=getComputedStyle(e); return t==='回复' && r.width>0 && r.height>0 && r.bottom>=0 && r.top<=innerHeight && s.visibility!=='hidden' && s.display!=='none'; }); if(cand.length){ var r=cand[0].getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; } } return null; })())",
        returnByValue: true,
      }, 10000);
      const b2 = btn2.result && JSON.parse(btn2.result.value);
      if (b2) {
        await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: b2.x, y: b2.y, button: "left", buttons: 1, clickCount: 1 }, 6000).catch(() => {});
        await sleep(150);
        await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: b2.x, y: b2.y, button: "left", buttons: 0, clickCount: 1 }, 6000).catch(() => {});
        await sleep(2500);
      }
    }
    const inpRes = await sendT(cdp, "Runtime.evaluate", {
      expression: "JSON.stringify((function(){ var q=" + qLiteral + "; var n=" + nickLiteral + "; var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]')); for(var i=0;i<items.length;i++){ var t=(items[i].innerText||''); var norm=t.replace(/[\\s\\[\\]，。,.!！?？:：;；、\\\"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~`@#$%^&*]/g,'').toLowerCase(); if(norm.indexOf(q)>=0 && (!n || norm.indexOf(n)>=0 || n.length<=1) && t.indexOf('回复中')>=0){ var ed=items[i].querySelector('[contenteditable=true]'); if(ed){ ed.focus(); var r=ed.getBoundingClientRect(); return {ok:true, x:Math.round(r.x+Math.min(100,Math.max(20,r.width/2))), y:Math.round(r.y+r.height/2)}; } } } return {ok:false}; })())",
      returnByValue: true,
    }, 10000);
    const it = inpRes.result && JSON.parse(inpRes.result.value);
    if (it && it.ok) inp = it;
    else await sleep(1500);
  }
  // 兜底（skill 规则）：1) 先点一下评论正文区域再重试「回复」控件；2) 若弹出操作菜单，点菜单里的「回复」
  if (!inp) {
    const probeExpr = "JSON.stringify((function(){ var main=document.querySelector('.comment-input-container'); var eds=Array.from(document.querySelectorAll('[contenteditable=true]')); for(var i=0;i<eds.length;i++){ var ed=eds[i]; var r=ed.getBoundingClientRect(); if(r.width<=0||r.height<=0) continue; if(main && main.contains(ed)) continue; ed.focus(); return {ok:true, x:Math.round(r.x+Math.min(100,Math.max(20,r.width/2))), y:Math.round(r.y+r.height/2)}; } return {ok:false}; })())";
    // 先探测是否已有内联编辑器（可能在评论项之外渲染）
    try {
      const pr = await sendT(cdp, "Runtime.evaluate", { expression: probeExpr, returnByValue: true }, 10000);
      const pv = pr.result && JSON.parse(pr.result.value);
      if (pv && pv.ok) { inp = pv; console.log("  step: 内联编辑器在评论项外找到"); }
    } catch {}

    if (!inp) {
      // 兜底1：点一下评论正文，再找「回复」
      console.log("  step: 兜底1 - 点击评论正文后重试回复控件");
      const tap = await sendT(cdp, "Runtime.evaluate", {
        expression: "JSON.stringify((function(){ var q=" + qLiteral + "; var n=" + nickLiteral + "; var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]')); for(var i=0;i<items.length;i++){ var t=(items[i].innerText||''); var norm=t.replace(/[\s\[\]，。,.!！?？:：;；、\"'“”‘’()\[\]{}<>《》【】（）\-_=+~`@#$%^&*]/g,'').toLowerCase(); if(norm.indexOf(q)<0) continue; if(n && n.length>1 && norm.indexOf(n)<0) continue; var body=items[i].querySelector('[data-e2e=\"comment-content\"]') || items[i]; var r=body.getBoundingClientRect(); if(r.width<=0) continue; return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; } return null; })())",
        returnByValue: true,
      }, 10000);
      const tp = tap.result && JSON.parse(tap.result.value);
      if (tp) {
        await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: tp.x, y: tp.y, button: "left", buttons: 1, clickCount: 1 }, 6000).catch(() => {});
        await sleep(150);
        await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tp.x, y: tp.y, button: "left", buttons: 0, clickCount: 1 }, 6000).catch(() => {});
        await sleep(1200);
      }
      // 再找并点「回复」（可能刚点正文后才出现，或在弹出的操作菜单里）
      const btn3 = await sendT(cdp, "Runtime.evaluate", {
        expression: "JSON.stringify((function(){ var all=Array.from(document.querySelectorAll('button,[role=\"button\"],a,div,span')); for(var i=0;i<all.length;i++){ var e=all[i]; if(e.children && e.children.length>0) continue; var t=(e.innerText||e.textContent||'').replace(/\s+/g,'').trim(); if(t!=='回复') continue; var r=e.getBoundingClientRect(), s=getComputedStyle(e); if(r.width<=0||r.height<=0||s.visibility==='hidden'||s.display==='none') continue; if(r.bottom<0||r.top>innerHeight) continue; var p=e.parentElement, pc=((p&&p.className)||'').toString(); if(pc.indexOf('danmaku')>=0) continue; return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), cls:(e.className||'').toString().slice(0,40)}; } return null; })())",
        returnByValue: true,
      }, 10000);
      const b3 = btn3.result && JSON.parse(btn3.result.value);
      if (b3) {
        console.log("  step: 兜底1 - 点击回复控件 at", b3.x, b3.y);
        await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: b3.x, y: b3.y, button: "left", buttons: 1, clickCount: 1 }, 6000).catch(() => {});
        await sleep(150);
        await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: b3.x, y: b3.y, button: "left", buttons: 0, clickCount: 1 }, 6000).catch(() => {});
        await sleep(2500);
        try {
          const pr2 = await sendT(cdp, "Runtime.evaluate", { expression: probeExpr, returnByValue: true }, 10000);
          const pv2 = pr2.result && JSON.parse(pr2.result.value);
          if (pv2 && pv2.ok) { inp = pv2; console.log("  step: 兜底1 成功激活编辑器"); }
        } catch {}
      }
    }
  }
  if (!inp) return { ok: false, error: "inline reply editor not found (reply mode not activated)" };
  console.log("  step: inline reply editor found");
  await sleep(1000);

  // click into the inline editor to place cursor
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mousePressed", x: inp.x, y: inp.y, button: "left", buttons: 1, clickCount: 1 }, 8000).catch(() => {});
  await sleep(120);
  await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseReleased", x: inp.x, y: inp.y, button: "left", buttons: 0, clickCount: 1 }, 8000).catch(() => {});
  await sleep(1200);

  // type the reply text
  const text = item.text || "";
  await sendT(cdp, "Input.insertText", { text }, 8000);
  await sleep(1500);

  // capture network for reply POST verification (must include comment/publish)
  const netHits = [];
  const onReq = (p) => {
    if (p.request.method === "POST" && p.request.url.includes("comment/publish")) netHits.push({ requestId: p.requestId, url: p.request.url, postData: p.request.postData || "" });
  };
  const onResp = async (p) => {
    const h = netHits.find((x) => x.requestId === p.requestId);
    if (h) {
      h.status = p.response.status;
      try { const b = await sendT(cdp, "Network.getResponseBody", { requestId: p.requestId }, 8000); h.body = b.body; } catch {}
    }
  };
  cdp.on("Network.requestWillBeSent", onReq);
  cdp.on("Network.responseReceived", onResp);
  // send with Enter key
  await sendT(cdp, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 5000).catch(() => {});
  await sendT(cdp, "Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 }, 5000).catch(() => {});
  await sendT(cdp, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, 5000).catch(() => {});
  await sleep(5000);
  console.log("  step: Enter pressed, posts captured:", netHits.length);
  // fallback: if no publish POST, click the inline composer send button (red arrow in comment item)
  if (!netHits.find((h) => h.status === 200)) {
    console.log("  step: trying send-button fallback");
    const fb = await sendT(cdp, "Runtime.evaluate", {
      expression: "JSON.stringify((function(){ var q=" + qLiteral + "; var n=" + nickLiteral + "; var __lists=Array.from(document.querySelectorAll('[data-e2e=\"comment-list\"]')); var __root=null; for(var __L=0;__L<__lists.length;__L++){ var __lr=__lists[__L].getBoundingClientRect(); if(__lr.width>0&&__lr.height>0){ __root=__lists[__L]; break; } } if(!__root) __root=document; var items=Array.from(__root.querySelectorAll('[data-e2e=\"comment-item\"]')); for(var i=0;i<items.length;i++){ var t=(items[i].innerText||''); var norm=t.replace(/[\\s\\[\\]，。,.!！?？:：;；、\\\"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~`@#$%^&*]/g,'').toLowerCase(); if(norm.indexOf(q)>=0 && (!n || norm.indexOf(n)>=0 || n.length<=1) && t.indexOf('回复中')>=0){ var svgs=items[i].querySelectorAll('svg'); for(var s=0;s<svgs.length;s++){ var p=svgs[s].querySelector('path[fill=\"#FE2C55\"]'); if(p){ var clickable=svgs[s].parentElement||svgs[s]; var r=clickable.getBoundingClientRect(); if(r.width>0&&r.height>0){ clickable.click(); return {clicked:true}; } } } } } return {clicked:false}; })())",
      returnByValue: true,
    }, 10000);
    console.log("  fallback send:", fb.result && fb.result.value);
    await sleep(6000);
  }
  cdp.off("Network.requestWillBeSent", onReq);
  cdp.off("Network.responseReceived", onResp);
  const okPost = netHits.find((h) => h.status === 200);
  if (!okPost) return { ok: false, error: "reply POST not captured (可能被风控拦截)" };
  const bodyText = okPost.body || "";
  const success = /"status_code"\s*:\s*0/.test(bodyText);
  if (!success) return { ok: false, error: "publish 被拒绝: " + (bodyText.slice(0, 80) || "(空响应，疑似风控/验证码)") };
  return { ok: true, sent: text.slice(0, 30), confirmed: true };
}

(async () => {
  console.log("REPLY_WORKER_START", new Date().toISOString());
  let cdp = null;
  let tabFails = 0;
  // A desktop/browser restart can leave a task in sending forever; make it recoverable.
  {
    const startupQueue = readQueue();
    let recovered = 0;
    for (const entry of (startupQueue.queued || [])) {
      if (entry.status === "sending") { entry.status = "queued"; entry.error = "上次运行中断，已自动重试"; recovered++; }
      if (entry.status === "sending" && entry.updatedAt && Date.now() - Number(entry.updatedAt) > 10 * 60 * 1000) {
        entry.status = "queued"; entry.error = "sending 超时，已自动回收";
        recovered++;
      }
    }
    if (recovered) saveQueue(startupQueue);
  }
  while (true) {
    const q = readQueue();
    const now = Date.now();
    const pending = (q.queued || []).filter((x) => x.status !== "done" && x.status !== "failed" && x.status !== "skipped" && (!x.scheduledAt || x.scheduledAt <= now));
    if (!pending.length) {
      // check if there are future-scheduled items to wait for
      const future = (q.queued || []).filter((x) => x.status !== "done" && x.status !== "failed" && x.scheduledAt && x.scheduledAt > now);
      if (future.length) {
        const waitMs = Math.min(future[0].scheduledAt - now, 600000);
        console.log(new Date().toISOString().slice(11,19), "scheduled batch at", new Date(future[0].scheduledAt).toLocaleString("zh-CN"), "waiting", Math.round(waitMs/1000), "s");
        await sleep(Math.max(waitMs, 10000));
      } else {
        await sleep(10000);
      }
      continue;
    }
    const item = pending[0];
    // 关键修复：浏览器重启后旧标签页连接会失效，导致 Page.navigate 一直超时；先做存活检查
    if (cdp) {
      try {
        const tlist = await getJson("http://127.0.0.1:" + PORT + "/json/list");
        const alive = tlist.some((t) => t.type === "page" && t.webSocketDebuggerUrl === cdp.ws.url);
        if (!alive) {
          console.log(new Date().toISOString().slice(11, 19), "TAB_GONE - 重新获取标签页");
          try { cdp.close(); } catch {}
          cdp = null;
        }
      } catch (e) {
        console.log(new Date().toISOString().slice(11, 19), "TAB_CHECK_FAIL - 重置连接");
        try { cdp.close(); } catch {}
        cdp = null;
      }
    }
    if (!cdp) {
      try {
        const tlist = await getJson("http://127.0.0.1:" + PORT + "/json/list");
        const existing = tlist.find((t) => t.type === "page" && (t.url || "").includes("douyin.com"));
        if (existing) {
          cdp = new CDP(existing.webSocketDebuggerUrl);
          await sendT(cdp, "Runtime.enable", {}, 10000);
          await sendT(cdp, "Page.enable", {}, 10000);
          await sendT(cdp, "Network.enable", {}, 10000);
        } else {
          cdp = await createTab("about:blank");
          await sendT(cdp, "Runtime.enable", {}, 10000);
          await sendT(cdp, "Page.enable", {}, 10000);
          await sendT(cdp, "Network.enable", {}, 10000);
        }
      }
      catch (e) { console.log("TAB_CREATE_FAIL", e.message.slice(0, 60)); await sleep(5000); continue; }
    }
    item.status = "sending";
    item.updatedAt = Date.now();
    try { saveQueue(q); } catch {}
    console.log(new Date().toISOString().slice(11, 19), "REPLYING", item.awemeId, "cid", item.commentId, "text:", (item.text || "").slice(0, 25));
    try {
      const commentText = lookupComment(item.commentId);
      const res = await replyOne(cdp, item, commentText);
      if (res.ok) {
        item.status = "done"; item.doneAt = Date.now();
        console.log(new Date().toISOString().slice(11, 19), "DONE", item.commentId, "->", res.sent);
        // persist replied cid to history (prevent future duplicate replies)
        try {
          let hist = [];
          try { hist = JSON.parse(fs.readFileSync("D:\\deep seek\\replied_history.json", "utf8")); } catch {}
          if (!hist.includes(String(item.commentId))) { hist.push(String(item.commentId)); fs.writeFileSync("D:\\deep seek\\replied_history.json", JSON.stringify(hist, null, 2), "utf8"); }
        } catch {}
        tabFails = 0;
      } else if (res.skip) {
        item.status = "skipped"; item.error = res.error; item.doneAt = Date.now();
        console.log(new Date().toISOString().slice(11, 19), "SKIP", item.commentId, "->", String(res.error).slice(0, 60));
        tabFails = 0;
      } else if (res.captcha) {
        item.status = "queued";
        console.log(new Date().toISOString().slice(11, 19), "⛔ 遇到验证码！已暂停，请你在 Chrome 窗口完成验证，60秒后自动重试...");
        await sleep(60000);
      } else {
        item.status = "failed"; item.error = res.error;
        console.log(new Date().toISOString().slice(11, 19), "FAIL", item.commentId, res.error);
        tabFails++;
        if (tabFails >= 2) { try { await cdp.close(); } catch {} cdp = null; tabFails = 0; }
      }
    } catch (e) {
      item.status = "failed"; item.error = e.message.slice(0, 80);
      console.log(new Date().toISOString().slice(11, 19), "FAIL", item.commentId, e.message.slice(0, 60));
      tabFails++;
      if (tabFails >= 2) { try { await cdp.close(); } catch {} cdp = null; tabFails = 0; }
    }
    // persist status correctly: update the item in the fresh queue (keeps new items added meanwhile)
    {
      const fresh = readQueue();
      const tgt = item.taskId
        ? fresh.queued.find((x) => String(x.taskId) === String(item.taskId))
        : fresh.queued.find((x) => String(x.commentId) === String(item.commentId) && String(x.awemeId) === String(item.awemeId) && x.status === "sending");
      if (tgt) { tgt.status = item.status; tgt.error = item.error; tgt.doneAt = item.doneAt; tgt.updatedAt = Date.now(); }
      saveQueue(fresh);
    }
    // 10-14s interval between replies
    const waitMs = 10000 + Math.floor(Math.random() * 4000);
    console.log(new Date().toISOString().slice(11, 19), "waiting", waitMs / 1000, "s before next");
    await sleep(waitMs);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
