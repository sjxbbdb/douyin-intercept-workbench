const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_PORT = Number(process.env.REPLY_DEBUG_PORT || 9222);
const DEFAULT_WORKSPACE = process.env.REPLY_WORKSPACE || __dirname;
const DOUYIN_HOME = "https://www.douyin.com/";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, timeout = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function chromePath() {
  const candidates = [
    process.env.REPLY_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function cdpCall(webSocketDebuggerUrl, method, params = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timeout`)), timeout);
    socket.onerror = () => finish(new Error("CDP connection failed"));
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== 1) return;
      if (message.error) finish(new Error(message.error.message || "CDP call failed"));
      else finish(null, message.result);
    };
  });
}

async function listTargets(port) {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  return Array.isArray(targets) ? targets : [];
}

function findDouyinPage(targets) {
  return targets.find((target) => target.type === "page" && /(^|\.)douyin\.com$/i.test(safeHostname(target.url)))
    || targets.find((target) => target.type === "page" && String(target.url || "").includes("douyin.com"));
}

function safeHostname(value) {
  try { return new URL(value).hostname; } catch { return ""; }
}

async function createDouyinPage(port) {
  const version = await getJson(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome 调试接口不可用");
  const result = await cdpCall(version.webSocketDebuggerUrl, "Target.createTarget", { url: DOUYIN_HOME }, 10000);
  if (!result || !result.targetId) throw new Error("无法创建抖音标签页");
  return result.targetId;
}

async function activatePage(port, targetId) {
  if (!targetId) return;
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    await cdpCall(version.webSocketDebuggerUrl, "Target.activateTarget", { targetId }, 5000);
  } catch {}
}

async function inspectLogin(page) {
  if (!page || !page.webSocketDebuggerUrl) return { loggedIn: false, needsLogin: true, reason: "没有抖音页面" };
  const expression = `JSON.stringify((function(){
    var visible = function(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
    var body = document.body ? document.body.innerText : '';
    var loginPrompt = /扫码登录|手机号登录|密码登录|验证码登录/.test(body);
    var loginButton = Array.from(document.querySelectorAll('button,a,div,span')).some(function(el){ return visible(el) && (el.innerText||'').trim()==='登录' && el.children.length===0; });
    var avatar = Array.from(document.querySelectorAll('[data-e2e="user-avatar"],a[href*="/user/self"]')).some(visible);
    return { readyState: document.readyState, title: document.title||'', url: location.href, loginPrompt: loginPrompt, loginButton: loginButton, avatar: avatar };
  })())`;
  const runtime = await cdpCall(page.webSocketDebuggerUrl, "Runtime.evaluate", { expression, returnByValue: true }, 8000);
  let detail = {};
  try { detail = JSON.parse(runtime && runtime.result ? runtime.result.value : "{}"); } catch {}

  let authCookie = false;
  try {
    const cookies = await cdpCall(page.webSocketDebuggerUrl, "Network.getCookies", { urls: [DOUYIN_HOME] }, 8000);
    authCookie = (cookies.cookies || []).some((cookie) => /^(sessionid|sessionid_ss|sid_guard|uid_tt|uid_tt_ss)$/i.test(cookie.name) && cookie.value);
  } catch {}

  const loggedIn = detail.readyState === "complete" && !detail.loginPrompt && (detail.avatar || authCookie) && !detail.loginButton;
  return {
    loggedIn: !!loggedIn,
    needsLogin: !loggedIn,
    detail: { ...detail, authCookie: !!authCookie },
    reason: loggedIn ? "" : "请在打开的 Chrome 窗口中登录抖音",
  };
}

async function getBrowserSessionStatus(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const workspace = options.workspace || DEFAULT_WORKSPACE;
  let targets;
  try {
    targets = await listTargets(port);
  } catch {
    return { running: false, loggedIn: false, needsLogin: true, port, profile: process.env.REPLY_BROWSER_PROFILE || path.join(workspace, "dy-main"), reason: "采集浏览器未启动" };
  }
  const page = findDouyinPage(targets);
  if (!page) return { running: true, loggedIn: false, needsLogin: true, port, profile: process.env.REPLY_BROWSER_PROFILE || path.join(workspace, "dy-main"), reason: "浏览器中没有抖音页面" };
  try {
    const login = await inspectLogin(page);
    return { running: true, port, profile: process.env.REPLY_BROWSER_PROFILE || path.join(workspace, "dy-main"), pageUrl: page.url || "", targetId: page.id || "", ...login };
  } catch (error) {
    return { running: true, loggedIn: false, needsLogin: true, port, profile: process.env.REPLY_BROWSER_PROFILE || path.join(workspace, "dy-main"), pageUrl: page.url || "", reason: `登录状态检查失败：${error.message}` };
  }
}

async function ensureBrowserSession(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const workspace = options.workspace || DEFAULT_WORKSPACE;
  let started = false;
  let targets;
  try { targets = await listTargets(port); } catch {}

  if (!targets) {
    const executable = chromePath();
    if (!executable) throw new Error("没有找到 Google Chrome，请先安装 Chrome 或设置 REPLY_CHROME_PATH");
    const profile = process.env.REPLY_BROWSER_PROFILE || path.join(workspace, "dy-main");
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      DOUYIN_HOME,
    ], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    started = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(500);
      try { targets = await listTargets(port); break; } catch {}
    }
    if (!targets) throw new Error("Chrome 已启动，但调试端口未就绪");
  }

  let page = findDouyinPage(targets);
  if (!page) {
    const targetId = await createDouyinPage(port);
    await delay(1000);
    targets = await listTargets(port);
    page = findDouyinPage(targets) || targets.find((target) => target.id === targetId);
  }
  await activatePage(port, page && page.id);

  let status = await getBrowserSessionStatus({ port });
  for (let attempt = 0; attempt < 4 && status.running && status.detail && status.detail.readyState === "loading"; attempt++) {
    await delay(750);
    status = await getBrowserSessionStatus({ port });
  }
  return {
    ...status,
    started,
    message: status.loggedIn ? "已复用采集浏览器，抖音已登录，可以开始采集" : "已复用采集浏览器，请在这个 Chrome 窗口中完成登录",
  };
}

module.exports = { ensureBrowserSession, getBrowserSessionStatus };
