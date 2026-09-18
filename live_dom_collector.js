const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = process.env.REPLY_WORKSPACE || path.resolve(__dirname);
const DEBUG_PORT = Number(process.env.REPLY_DEBUG_PORT || 9222);
const API_BASE = process.env.REPLY_UI_BASE || "http://127.0.0.1:8090";
const CONFIG_FILE = path.join(WORKSPACE, "live_config.json");
const STATE_FILE = path.join(WORKSPACE, "live_state.json");
const STATUS_FILE = path.join(WORKSPACE, "live_monitor_status.json");
const DEFAULT_INTERVAL = 8;
const MAX_HITS = 500;
const MAX_ROWS_PER_PAGE = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 24);
}

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProfileUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://www.douyin.com");
    if (!/^https?:$/i.test(url.protocol) || !/(^|\.)douyin\.com$/i.test(url.hostname)) return "";
    if (!/^\/user\//i.test(url.pathname)) return "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function profileFromSecUid(value) {
  const secUid = cleanText(value);
  return secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : "";
}

function parseKeywords(value) {
  return [...new Set(String(value || "")
    .split(/[,\uff0c\n]/)
    .map(cleanText)
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function parseRooms(value) {
  const rows = String(value || "").split(/\r?\n/);
  const rooms = [];
  for (const row of rows) {
    const line = row.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s*[|｜]\s*/);
    const rawUrl = parts.length > 1 ? parts[parts.length - 1].trim() : line;
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/i.test(url.protocol) || !/(^|\.)douyin\.com$/i.test(url.hostname)) continue;
    if (!url.pathname || url.pathname === "/") continue;
    url.hash = "";
    url.search = "";
    const normalizedUrl = url.toString().replace(/\/$/, "");
    const name = parts.length > 1 ? parts.slice(0, -1).join(" | ").trim() : "";
    const key = hash(normalizedUrl);
    if (!rooms.some((item) => item.key === key)) rooms.push({ key, url: normalizedUrl, name });
  }
  return rooms;
}

function parseConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const interval = Math.max(5, Math.min(60, Number(config.interval) || DEFAULT_INTERVAL));
  const dailyLimit = Math.max(1, Math.min(1000, Number(config.dailyLimit) || 50));
  return {
    rooms: parseRooms(config.roomUrls),
    keywords: parseKeywords(config.keywords),
    interval,
    cooldown: Math.max(1, Math.min(1440, Number(config.cooldown) || 30)),
    dailyLimit,
    requireConfirm: config.requireConfirm !== false,
  };
}

function matchKeyword(text, keywords) {
  const source = cleanText(text);
  return keywords.find((keyword) => source.includes(keyword)) || "";
}

function calculateLeadLevel(hitCount, text) {
  if (hitCount >= 2 || /预算|有偿|付费|想学|教程|怎么做|求带/.test(text)) return "高意向";
  return "中意向";
}

function emptyState() {
  return { rooms: [], hits: [], leads: [], updatedAt: 0 };
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    rooms: Array.isArray(state.rooms) ? state.rooms : [],
    hits: Array.isArray(state.hits) ? state.hits : [],
    leads: Array.isArray(state.leads) ? state.leads : [],
    updatedAt: Number(state.updatedAt) || 0,
  };
}

function eventId(event) {
  const minuteBucket = Math.floor(Number(event.observedAt || Date.now()) / 600000);
  return "live-hit-" + hash([
    event.roomKey,
    event.secUid || event.userId || event.user,
    cleanText(event.text),
    minuteBucket,
  ].join("|"));
}

function mergeEvents(previous, roomSnapshots, events, config, now) {
  const state = normalizeState(previous);
  const oldHits = state.hits.filter((hit) => now - Number(hit.createdAt || now) < 24 * 60 * 60 * 1000);
  const hitMap = new Map(oldHits.map((hit) => [String(hit.id), hit]));
  const leadMap = new Map(state.leads.map((lead) => [String(lead.id || lead.userId || lead.user || ""), lead]));

  for (const event of events) {
    const id = eventId(event);
    if (!hitMap.has(id)) {
      hitMap.set(id, {
        id,
        userId: event.userId || "",
        secUid: event.secUid || "",
        profileUrl: normalizeProfileUrl(event.profileUrl) || profileFromSecUid(event.secUid),
        avatarUrl: event.avatarUrl || "",
        user: event.user || "未知用户",
        keyword: event.keyword,
        text: cleanText(event.text),
        room: event.roomName || "未知直播间",
        roomKey: event.roomKey,
        createdAt: Number(event.observedAt || now),
        time: new Date(Number(event.observedAt || now)).toLocaleTimeString("zh-CN", { hour12: false }),
        source: "browser_dom",
        scope: "dom_pilot",
      });
    }

    const leadId = event.secUid || event.userId || "anon-" + hash(event.user || "未知用户");
    const existing = leadMap.get(leadId) || {
      id: leadId,
      userId: event.userId || "",
      secUid: event.secUid || "",
      profileUrl: normalizeProfileUrl(event.profileUrl) || profileFromSecUid(event.secUid),
      avatarUrl: event.avatarUrl || "",
      user: event.user || "未知用户",
      count: 0,
      rooms: [],
      keywords: [],
      createdAt: Number(event.observedAt || now),
    };
    existing.user = event.user || existing.user;
    existing.userId = event.userId || existing.userId || "";
    existing.secUid = event.secUid || existing.secUid || "";
    existing.profileUrl = normalizeProfileUrl(event.profileUrl) || existing.profileUrl || profileFromSecUid(existing.secUid);
    existing.avatarUrl = event.avatarUrl || existing.avatarUrl || "";
    existing.count = Number(existing.count || 0) + 1;
    existing.lastText = cleanText(event.text);
    existing.lastSeenAt = Number(event.observedAt || now);
    existing.room = event.roomName || existing.room || "未知直播间";
    existing.roomName = existing.room;
    existing.rooms = [...new Set([...(existing.rooms || []), event.roomName || "未知直播间"])].slice(-8);
    existing.keywords = [...new Set([...(existing.keywords || []), event.keyword])].filter(Boolean).slice(-8);
    existing.level = calculateLeadLevel(existing.count, existing.lastText);
    existing.detail = `命中 ${existing.count} 次 · 最近命中“${event.keyword}”`;
    existing.source = "browser_dom";
    existing.scope = "dom_pilot";
    existing.locatable = Boolean(existing.secUid && existing.profileUrl);
    if (!existing.locatable && !["sent", "skipped", "failed"].includes(existing.dmStatus)) {
      existing.dmStatus = "not_locatable";
      existing.dmReason = "未从弹幕 DOM 取得 sec_uid 或主页链接";
    } else if (existing.locatable && !existing.dmStatus) {
      existing.dmStatus = "pending";
      existing.dmReason = "";
    }
    leadMap.set(leadId, existing);
  }

  const hits = [...hitMap.values()]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, MAX_HITS);
  const leads = [...leadMap.values()]
    .sort((a, b) => Number(b.lastSeenAt || b.createdAt || 0) - Number(a.lastSeenAt || a.createdAt || 0))
    .slice(0, config.dailyLimit);

  return {
    rooms: roomSnapshots,
    hits,
    leads,
    updatedAt: now,
  };
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
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
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

  close() {
    try { this.ws.close(); } catch {}
  }
}

const DOM_CAPTURE_EXPRESSION = String.raw`(function() {
  function textOf(el) {
    return String(el && (el.innerText || el.textContent) || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return false;
    var s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function attr(el, names) {
    for (var i = 0; i < names.length; i++) {
      var value = el.getAttribute(names[i]);
      if (value) return value;
    }
    return "";
  }
  function profileInfo(el) {
    var secUid = attr(el, ["data-sec-uid", "data-secuid", "data-sec-open-id"]);
    var profileUrl = "";
    var links = el ? el.querySelectorAll("a[href]") : [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      var m = href.match(/\/user\/([^/?#]+)/i);
      if (m) {
        try { profileUrl = new URL(href, location.origin).toString(); } catch (e) { profileUrl = ""; }
        if (!secUid) secUid = decodeURIComponent(m[1]);
        break;
      }
    }
    if (!profileUrl) {
      var ancestor = el;
      for (var depth = 0; depth < 4 && ancestor; depth++, ancestor = ancestor.parentElement) {
        var href2 = attr(ancestor, ["href", "data-profile-url", "data-user-url"]);
        var m2 = href2.match(/\/user\/([^/?#]+)/i);
        if (m2) {
          try { profileUrl = new URL(href2, location.origin).toString(); } catch (e) { profileUrl = ""; }
          if (!secUid) secUid = decodeURIComponent(m2[1]);
          break;
        }
      }
    }
    var avatar = el ? el.querySelector("img[src]") : null;
    return { secUid: secUid || "", profileUrl: profileUrl || "", avatarUrl: avatar ? (avatar.currentSrc || avatar.src || "") : "" };
  }
  function getLines(el) {
    var raw = String(el && (el.innerText || el.textContent) || "").split(/\n+/);
    var out = [];
    raw.forEach(function(line) {
      var value = line.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      if (value && out.indexOf(value) < 0) out.push(value);
    });
    return out;
  }
  function parseRow(el) {
    var lines = getLines(el);
    if (lines.length < 2 && lines.length === 1) {
      var m = lines[0].match(/^(.{1,32})[:：]\s*(.{1,220})$/);
      if (m) lines = [m[1].trim(), m[2].trim()];
    }
    if (lines.length < 2) return null;
    var user = lines[0].replace(/^@/, "").trim();
    var text = lines.slice(1).join(" ").trim();
    if (!user || !text || user.length > 48 || text.length > 260) return null;
    if (/^(进入直播间|加入了直播间|点赞了|关注了主播|分享了直播间|送出|赠送|来了|拍了拍)/.test(text)) return null;
    if (/^(直播间|全部评论|互动消息|在线人数|发消息|说点什么)/.test(user)) return null;
    var key = attr(el, ["data-id", "data-msg-id", "data-message-id", "data-comment-id", "data-key"]);
    var rawUserId = attr(el, ["data-user-id", "data-uid", "data-sec-uid", "data-sec-open-id"]);
    var profile = profileInfo(el);
    var r = el.getBoundingClientRect();
    return {
      user: user,
      text: text,
      rowKey: key || (user + "|" + text).slice(0, 240),
      userKey: rawUserId || user,
      userId: rawUserId || "",
      secUid: profile.secUid,
      profileUrl: profile.profileUrl,
      avatarUrl: profile.avatarUrl,
      x: Math.round(r.x),
      y: Math.round(r.y)
    };
  }

  var selectors = [
    '[data-e2e*="chat"]',
    '[data-e2e*="comment"]',
    '[class*="webcast-chatroom"]',
    '[class*="chatroom"]',
    '[class*="danmu"]',
    '[class*="bullet"]',
    '[class*="message"]'
  ];
  var nodes = [];
  selectors.forEach(function(selector) {
    try { nodes = nodes.concat(Array.from(document.querySelectorAll(selector))); } catch (e) {}
  });
  var rows = [];
  var seen = {};
  nodes.forEach(function(node) {
    if (!visible(node)) return;
    var row = parseRow(node);
    if (!row) return;
    var key = row.user + "|" + row.text;
    if (seen[key]) return;
    seen[key] = true;
    rows.push(row);
  });

  var bodyText = textOf(document.body);
  var title = textOf(document.querySelector("h1")) || textOf(document.querySelector("title")) || document.title || "";
  var viewerMatch = bodyText.match(/(?:在线人数|在线|观看|人气)\s*[:：]?\s*([0-9.,万千]+)/);
  var status = /直播已结束|直播结束|回放/.test(bodyText) ? "已结束" : "运行中";
  if (/加载中|进入直播间/.test(bodyText) && !rows.length) status = "等待页面";
  return {
    roomName: title.replace(/\s*[-|｜]\s*抖音.*$/i, "").slice(0, 80),
    viewerText: viewerMatch ? viewerMatch[1] : "",
    status: status,
    rows: rows.slice(-100),
    diagnostics: {
      selectorCandidates: nodes.length,
      parsedRows: rows.length,
      url: location.href,
      title: document.title || ""
    }
  };
})()`;

async function getJson(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function listTargets() {
  return getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 5000);
}

async function createTarget(url) {
  const version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 5000);
  const browser = new CDP(version.webSocketDebuggerUrl);
  try {
    const result = await browser.send("Target.createTarget", { url });
    for (let i = 0; i < 20; i++) {
      const targets = await listTargets();
      const target = targets.find((item) => item.type === "page" && item.id === result.targetId);
      if (target && target.webSocketDebuggerUrl) return target;
      await sleep(300);
    }
    throw new Error("new browser tab did not become ready");
  } finally {
    browser.close();
  }
}

function sameRoom(targetUrl, configuredUrl) {
  try {
    const a = new URL(targetUrl);
    const b = new URL(configuredUrl);
    return a.hostname === b.hostname && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

async function postState(state) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(API_BASE + "/api/live-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    writeJsonAtomic(STATE_FILE, state);
  }
}

function updateStatus(patch) {
  const current = readJson(STATUS_FILE, {});
  writeJsonAtomic(STATUS_FILE, {
    route: "C1",
    scope: "dom_pilot",
    pid: process.pid,
    ...current,
    ...patch,
  });
}

async function capturePage(target) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const result = await cdp.send("Runtime.evaluate", {
      expression: DOM_CAPTURE_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result && result.exceptionDetails) throw new Error("page evaluation failed");
    return result && result.result ? result.result.value : null;
  } finally {
    cdp.close();
  }
}

async function collectOnce(config, previous) {
  const now = Date.now();
  const targets = await listTargets();
  const roomSnapshots = [];
  const events = [];

  for (const room of config.rooms) {
    let target = targets.find((item) =>
      item.type === "page" &&
      item.webSocketDebuggerUrl &&
      sameRoom(item.url || "", room.url)
    );
    if (!target) {
      try {
        target = await createTarget(room.url);
      } catch (error) {
        roomSnapshots.push({
          id: room.key,
          key: room.key,
          name: room.name || room.url,
          url: room.url,
          status: "待打开",
          viewers: "-",
          hits: 0,
          synced: "未连接",
          diagnostic: error.message.slice(0, 100),
          route: "C1",
          scope: "dom_pilot",
        });
        continue;
      }
    }

    try {
      const captured = await capturePage(target);
      const rows = captured && Array.isArray(captured.rows) ? captured.rows : [];
      let hitCount = 0;
      for (const row of rows) {
        const keyword = matchKeyword(row.text, config.keywords);
        if (!keyword) continue;
        hitCount++;
        events.push({
          roomKey: room.key,
          roomName: room.name || captured.roomName || room.url,
          text: row.text,
          user: row.user,
          userId: row.userId || "",
          secUid: row.secUid || "",
          profileUrl: row.profileUrl || "",
          avatarUrl: row.avatarUrl || "",
          keyword,
          observedAt: now,
        });
      }
      roomSnapshots.push({
        id: room.key,
        key: room.key,
        name: room.name || captured.roomName || room.url,
        title: captured.roomName || room.name || room.url,
        url: room.url,
        status: captured.status || "运行中",
        viewers: captured.viewerText || "-",
        hits: hitCount,
        synced: "刚刚",
        lastSynced: new Date(now).toLocaleTimeString("zh-CN", { hour12: false }),
        selectorCandidates: captured.diagnostics ? captured.diagnostics.selectorCandidates : 0,
        parsedRows: captured.diagnostics ? captured.diagnostics.parsedRows : 0,
        diagnostic: rows.length ? "已读取页面可见弹幕" : "页面未发现可解析弹幕",
        route: "C1",
        scope: "dom_pilot",
      });
    } catch (error) {
      roomSnapshots.push({
        id: room.key,
        key: room.key,
        name: room.name || room.url,
        url: room.url,
        status: "采集异常",
        viewers: "-",
        hits: 0,
        synced: "失败",
        diagnostic: error.message.slice(0, 100),
        route: "C1",
        scope: "dom_pilot",
      });
    }
  }

  return mergeEvents(previous, roomSnapshots, events, config, now);
}

async function run() {
  updateStatus({ running: true, startedAt: Date.now(), lastError: null });
  let state = normalizeState(readJson(STATE_FILE, emptyState()));
  let stopped = false;
  const stop = () => {
    stopped = true;
    updateStatus({ running: false, stoppedAt: Date.now() });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    const config = parseConfig(readJson(CONFIG_FILE, {}));
    if (!config.rooms.length || !config.keywords.length) {
      updateStatus({
        running: true,
        state: "waiting_config",
        roomCount: config.rooms.length,
        keywordCount: config.keywords.length,
        configHint: "请在工作台填写抖音直播间链接和弹幕关键词",
        lastTickAt: Date.now(),
        lastError: null,
      });
      await sleep(3000);
      continue;
    }

    try {
      state = await collectOnce(config, state);
      await postState(state);
      updateStatus({
        running: true,
        state: "observing",
        roomCount: config.rooms.length,
        keywordCount: config.keywords.length,
        lastTickAt: state.updatedAt,
        lastError: null,
        lastSummary: {
          rooms: state.rooms.length,
          hits: state.hits.length,
          leads: state.leads.length,
        },
      });
    } catch (error) {
      updateStatus({
        running: true,
        state: "collector_error",
        lastTickAt: Date.now(),
        lastError: error.message.slice(0, 180),
      });
    }
    await sleep(config.interval * 1000);
  }
}

if (require.main === module) {
  run().catch((error) => {
    updateStatus({ running: false, state: "fatal", lastError: error.message.slice(0, 180) });
    console.error("live collector fatal:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  calculateLeadLevel,
  emptyState,
  eventId,
  matchKeyword,
  mergeEvents,
  normalizeState,
  parseConfig,
  parseKeywords,
  parseRooms,
};
