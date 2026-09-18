
const fs = require("fs");
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
}
const sendT = (cdp, method, params, t = 12000) => Promise.race([
  cdp.send(method, params),
  new Promise((_, rej) => setTimeout(() => rej(new Error(method + " TO")), t)),
]);
(async () => {
  const list = await getJson("http://127.0.0.1:9222/json/list");
  const tab = list.find((t) => t.type === "page");
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await sendT(cdp, "Runtime.enable", {}, 8000);
  await sendT(cdp, "Page.enable", {}, 8000);
  await sendT(cdp, "Page.navigate", { url: "https://www.douyin.com/" }, 12000);
  await sleep(8000);
  // click the login button (top-right)
  const clicked = await sendT(cdp, "Runtime.evaluate", {
    expression: "JSON.stringify((function(){ var els=Array.from(document.querySelectorAll('div,button,span')).filter(function(e){ var t=(e.innerText||'').trim(); return t==='登录' && e.children.length===0; }); if(!els.length) return {clicked:false}; els[0].click(); return {clicked:true}; })())",
    returnByValue: true,
  }, 10000);
  console.log("LOGIN_CLICK:", clicked.result && clicked.result.value);
  await sleep(4000);
  // check for QR code image
  const qr = await sendT(cdp, "Runtime.evaluate", {
    expression: "JSON.stringify((function(){ var imgs=Array.from(document.querySelectorAll('img')).filter(function(i){ var s=(i.src||''); return /qrcode|qr_|scan|passport/i.test(s) || (i.width>150 && i.width<350); }); return imgs.slice(0,5).map(function(i){ return {src:i.src.slice(0,100), w:i.width, h:i.height, x:Math.round(i.getBoundingClientRect().x), y:Math.round(i.getBoundingClientRect().y)}; }); })())",
    returnByValue: true,
  }, 10000);
  console.log("QR_IMGS:", qr.result && qr.result.value);
  // screenshot whole viewport
  const shot = await sendT(cdp, "Page.captureScreenshot", { format: "png" }, 10000);
  fs.writeFileSync("D:\\deep seek\\reply_server\\qr.png", Buffer.from(shot.data, "base64"));
  console.log("QR_SCREENSHOT_SAVED");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
