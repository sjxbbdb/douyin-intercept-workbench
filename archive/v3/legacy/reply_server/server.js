const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const WORKSPACE = process.env.REPLY_WORKSPACE || path.resolve(__dirname, "..");
const COMMENTS_FILE = path.join(WORKSPACE, "filtered_comments.json");
const PIPELINE_TOPICS_FILE = path.join(WORKSPACE, "pipeline_topics.json");
const QUEUE_FILE = path.join(WORKSPACE, "replies_queue.json");
const PAUSE_FILE = path.join(WORKSPACE, "pipeline_pause.json");
const CLEANING_STATS_FILE = path.join(WORKSPACE, "pipeline_cleaning_report.json");
const LIVE_STATE_FILE = path.join(WORKSPACE, "live_state.json");
const LIVE_CONFIG_FILE = path.join(WORKSPACE, "live_config.json");
const LIVE_STATUS_FILE = path.join(WORKSPACE, "live_monitor_status.json");
const LIVE_COLLECTOR_FILE = path.join(WORKSPACE, "live_dom_collector.js");
const LIVE_DM_STATE_FILE = path.join(WORKSPACE, "live_dm_state.json");
const LIVE_DM_WORKER_FILE = path.join(WORKSPACE, "live_dm_worker.js");
const { ensureBrowserSession, getBrowserSessionStatus } = require(path.join(WORKSPACE, "browser_session.js"));
const PORT = 8090;

let pipelineChild = null; // current running pipeline child (for pause fallback kill)
let liveCollectorChild = null;
let liveCollectorStopping = false;
let liveDmChild = null;

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
}
function writeJson(f, data) {
  fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
}
const PROVINCE_NAMES = ["北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门", "台湾"];

function cleanPlace(value) {
  return String(value || "").replace(/\s+/g, "").replace(/特别行政区$/u, "").trim();
}

function commentRegionParts(comment) {
  const raw = cleanPlace(comment.region || comment.ip_label || comment.ipLabel);
  let province = cleanPlace(comment.province || comment.regionProvince).replace(/省$/u, "");
  let city = cleanPlace(comment.city || comment.regionCity).replace(/市$/u, "");
  if (!province) province = PROVINCE_NAMES.find((name) => raw === name || raw.startsWith(name + "省") || raw.startsWith(name)) || "";
  if (!city && province && raw.length > province.length) {
    const remainder = raw.slice(province.length).replace(/^省/u, "").replace(/市$/u, "");
    if (remainder && !/^省$/u.test(remainder)) city = remainder;
  }
  if (["北京", "天津", "上海", "重庆"].includes(province) && !city && raw.includes(province + "市")) city = province;
  return { raw, province, city };
}
function registerPipelineTopic(name) {
  const topic = String(name || "").trim();
  if (!topic) return;
  const stored = readJson(PIPELINE_TOPICS_FILE, []);
  const topics = Array.isArray(stored) ? stored : [];
  const now = new Date().toISOString();
  const existing = topics.find((item) => item && item.name === topic);
  if (existing) {
    existing.lastRunAt = now;
    existing.runs = Math.max(0, Number(existing.runs) || 0) + 1;
  } else {
    topics.push({ name: topic, runs: 1, createdAt: now, lastRunAt: now });
  }
  writeJson(PIPELINE_TOPICS_FILE, topics);
}
function ensureLiveState() {
  const fallback = { rooms: [], hits: [], leads: [], updatedAt: 0 };
  const state = readJson(LIVE_STATE_FILE, null);
  if (state && typeof state === "object") return state;
  try { writeJson(LIVE_STATE_FILE, fallback); } catch {}
  return fallback;
}
function ensureLiveConfig() {
  const fallback = {
    roomUrls: "",
    keywords: "求带,想学,怎么做,教程",
    interval: "8",
    cooldown: "30",
    dailyLimit: "50",
    requireConfirm: true,
    template: "你好{昵称}，刚看到你在直播间提到这个问题。我整理了一份入门步骤，可以先发你参考。",
    pendingLeadItems: [],
  };
  const config = readJson(LIVE_CONFIG_FILE, null);
  if (config && typeof config === "object") return { ...fallback, ...config };
  try { writeJson(LIVE_CONFIG_FILE, fallback); } catch {}
  return fallback;
}
function liveStatus() {
  const fallback = {
    running: false,
    state: "stopped",
    route: "C1",
    scope: "dom_pilot",
    lastError: null,
  };
  const status = readJson(LIVE_STATUS_FILE, null);
  return status && typeof status === "object" ? { ...fallback, ...status } : fallback;
}

function liveDmFallback() {
  return { active: null, last: null, history: [], updatedAt: 0 };
}

function ensureLiveDmState() {
  const value = readJson(LIVE_DM_STATE_FILE, null);
  if (value && typeof value === "object") return { ...liveDmFallback(), ...value };
  const fallback = liveDmFallback();
  try { writeJson(LIVE_DM_STATE_FILE, fallback); } catch {}
  return fallback;
}

function saveLiveDmState(state) {
  const value = { ...liveDmFallback(), ...state, updatedAt: Date.now() };
  writeJson(LIVE_DM_STATE_FILE, value);
  return value;
}

function updateLiveQueueItem(taskId, patch) {
  const config = ensureLiveConfig();
  const items = Array.isArray(config.pendingLeadItems) ? config.pendingLeadItems : [];
  const index = items.findIndex((item) => String(item && item.id) === String(taskId));
  if (index < 0) return null;
  items[index] = { ...items[index], ...patch, updatedAt: Date.now() };
  config.pendingLeadItems = items;
  writeJson(LIVE_CONFIG_FILE, config);
  return items[index];
}

function appendLiveDmHistory(state, task) {
  const history = Array.isArray(state.history) ? state.history : [];
  return [...history, task].slice(-100);
}

function startLiveDmWorker(taskId) {
  if (liveDmChild || !fs.existsSync(LIVE_DM_WORKER_FILE)) return false;
  const { spawn } = require("child_process");
  liveDmChild = spawn(process.execPath, [LIVE_DM_WORKER_FILE, String(taskId)], {
    cwd: WORKSPACE,
    env: { ...process.env, REPLY_WORKSPACE: WORKSPACE, REPLY_DEBUG_PORT: process.env.REPLY_DEBUG_PORT || "9222" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveDmChild.stdout.on("data", (chunk) => console.log("[live-dm]", String(chunk).trim()));
  liveDmChild.stderr.on("data", (chunk) => console.error("[live-dm]", String(chunk).trim()));
  liveDmChild.on("exit", () => { liveDmChild = null; });
  return true;
}
function startLiveCollector() {
  if (liveCollectorChild) return { ok: true, alreadyRunning: true };
  if (!fs.existsSync(LIVE_COLLECTOR_FILE)) return { ok: false, error: "live collector not found" };
  const { spawn } = require("child_process");
  liveCollectorStopping = false;
  liveCollectorChild = spawn(process.execPath, [LIVE_COLLECTOR_FILE], {
    cwd: WORKSPACE,
    env: { ...process.env, REPLY_WORKSPACE: WORKSPACE, REPLY_DEBUG_PORT: process.env.REPLY_DEBUG_PORT || "9222", REPLY_UI_BASE: "http://127.0.0.1:" + PORT },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveCollectorChild.stdout.on("data", (chunk) => console.log("[live]", String(chunk).trim()));
  liveCollectorChild.stderr.on("data", (chunk) => console.error("[live]", String(chunk).trim()));
  const child = liveCollectorChild;
  child.on("exit", (code, signal) => {
    console.log("live collector stopped", code, signal || "");
    const current = liveStatus();
    const stoppedIntentionally = liveCollectorStopping || signal;
    try {
      writeJson(LIVE_STATUS_FILE, {
        ...current,
        running: false,
        state: stoppedIntentionally ? "stopped" : (code === 0 ? "stopped" : "collector_error"),
        lastError: stoppedIntentionally || code === 0 ? null : (current.lastError || `collector exited with code ${code}`),
        stoppedAt: Date.now(),
      });
    } catch {}
    liveCollectorStopping = false;
    liveCollectorChild = null;
  });
  return { ok: true, started: true, pid: liveCollectorChild.pid };
}
function stopLiveCollector() {
  if (!liveCollectorChild) return { ok: true, alreadyStopped: true };
  liveCollectorStopping = true;
  try { liveCollectorChild.kill(); } catch {}
  try {
    const current = liveStatus();
    writeJson(LIVE_STATUS_FILE, { ...current, running: false, state: "stopping", stoppedAt: Date.now() });
  } catch {}
  liveCollectorChild = null;
  return { ok: true, stopped: true };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:" + PORT);
  const route = u.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && (route === "/" || route === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(ROOT, "select.html")));
    return;
  }
  if (req.method === "GET" && route === "/qr.png") {
    let qrFile = path.join(ROOT, "qr_big.png");
    if (!fs.existsSync(qrFile)) qrFile = path.join(ROOT, "qr_crop.png");
    if (!fs.existsSync(qrFile)) qrFile = path.join(ROOT, "qr.png");
    if (fs.existsSync(qrFile)) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(fs.readFileSync(qrFile));
    } else {
      res.writeHead(404); res.end("no qr yet");
    }
    return;
  }
  if (req.method === "GET" && route === "/api/live-state") {
    const state = ensureLiveState();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(state));
    return;
  }
  if (req.method === "POST" && route === "/api/live-state") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const state = {
          rooms: Array.isArray(payload.rooms) ? payload.rooms : [],
          hits: Array.isArray(payload.hits) ? payload.hits : [],
          leads: Array.isArray(payload.leads) ? payload.leads : [],
          updatedAt: payload.updatedAt || Date.now(),
        };
        writeJson(LIVE_STATE_FILE, state);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, updatedAt: state.updatedAt }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && route === "/api/live-config") {
    const config = ensureLiveConfig();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(config));
    return;
  }
  if (req.method === "POST" && route === "/api/live-config") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const config = {
          roomUrls: String(payload.roomUrls || "").trim(),
          keywords: String(payload.keywords || "").trim(),
          interval: String(payload.interval || "8"),
          cooldown: String(payload.cooldown || "30"),
          dailyLimit: String(payload.dailyLimit || "50"),
          requireConfirm: payload.requireConfirm !== false,
          template: String(payload.template || "").trim(),
          pendingLeadItems: Array.isArray(payload.pendingLeadItems) ? payload.pendingLeadItems : [],
        };
        writeJson(LIVE_CONFIG_FILE, config);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && route === "/api/live-queue") {
    const config = ensureLiveConfig();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ pendingLeadItems: Array.isArray(config.pendingLeadItems) ? config.pendingLeadItems : [] }));
    return;
  }
  if (req.method === "GET" && route === "/api/live-status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(liveStatus()));
    return;
  }
  if (req.method === "GET" && route === "/api/live-dm") {
    const state = ensureLiveDmState();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(state));
    return;
  }
  if (req.method === "POST" && route === "/api/live-dm/prepare") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const config = ensureLiveConfig();
        const items = Array.isArray(config.pendingLeadItems) ? config.pendingLeadItems : [];
        const item = items.find((entry) => String(entry && entry.id) === String(payload.id));
        if (!item) throw new Error("确认队列中找不到这条线索");
        if (!item.secUid || !/^https:\/\/(www\.)?douyin\.com\/user\//i.test(String(item.profileUrl || ""))) {
          const updated = updateLiveQueueItem(item.id, { dmStatus: "not_locatable", dmReason: "缺少真实 sec_uid 或主页链接" });
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, code: "not_locatable", error: "无法定位用户，缺少真实 sec_uid 或主页链接", item: updated }));
          return;
        }
        const current = ensureLiveDmState();
        if (current.active && ["opening_profile", "profile_opened", "opening_dm", "dm_opened", "prefilled", "waiting_manual_send"].includes(current.active.status)) {
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "已有一条私信准备任务，请先完成或跳过当前任务" }));
          return;
        }
        const template = String(item.template || config.template || "").trim();
        const text = template.split("{昵称}").join(String(item.user || item.nickname || "亲"));
        const task = {
          taskId: `live-dm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          leadId: String(item.id),
          user: item.user || item.nickname || "未知用户",
          secUid: item.secUid,
          profileUrl: item.profileUrl,
          avatarUrl: item.avatarUrl || "",
          room: item.room || item.roomName || "未知直播间",
          comment: item.lastText || item.text || "",
          template,
          text,
          status: "opening_profile",
          reason: "",
          steps: [
            { key: "captured", label: "采集：弹幕帧", status: "done" },
            { key: "profile", label: "打开用户主页", status: "running" },
            { key: "dm", label: "点击私信", status: "pending" },
            { key: "prefill", label: "预填文案", status: "pending" },
            { key: "manual", label: "人工点发送", status: "pending" },
          ],
          startedAt: Date.now(),
        };
        saveLiveDmState({ ...current, active: task, last: task });
        updateLiveQueueItem(item.id, { dmStatus: "opening_profile", dmReason: "正在准备主页和私信窗口", preparedText: text, taskId: task.taskId });
        if (!startLiveDmWorker(item.id)) throw new Error("私信准备器未找到或已有任务在运行");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, task }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && route === "/api/live-dm/action") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const state = ensureLiveDmState();
        const task = state.active;
        if (!task || (payload.taskId && payload.taskId !== task.taskId)) throw new Error("当前没有匹配的准备任务");
        const action = String(payload.action || "");
        if (!["skip", "mark-sent"].includes(action)) throw new Error("不支持的操作");
        const patch = action === "skip"
          ? { status: "skipped", reason: String(payload.reason || "manual_skip"), completedAt: Date.now() }
          : { status: "sent", reason: "manual_confirmed", completedAt: Date.now(), sentAt: Date.now() };
        task.status = patch.status;
        task.reason = patch.reason;
        task.completedAt = patch.completedAt;
        if (patch.sentAt) task.sentAt = patch.sentAt;
        task.steps = task.steps.map((step) => ({ ...step, status: step.key === "manual" ? (action === "skip" ? "skipped" : "done") : (step.status === "pending" ? "skipped" : "done") }));
        const itemPatch = action === "skip"
          ? { dmStatus: "skipped", dmReason: patch.reason }
          : { dmStatus: "sent", dmReason: "人工确认已发送", lastSentAt: patch.sentAt, sentAt: patch.sentAt };
        updateLiveQueueItem(task.leadId, itemPatch);
        saveLiveDmState({ active: task, last: task, history: appendLiveDmHistory(state, task) });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, task }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && route === "/api/live-monitor") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const result = payload.action === "stop" ? stopLiveCollector() : startLiveCollector();
        res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...result, status: liveStatus() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && route === "/api/live-queue") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const config = ensureLiveConfig();
        config.pendingLeadItems = Array.isArray(payload.pendingLeadItems) ? payload.pendingLeadItems : [];
        writeJson(LIVE_CONFIG_FILE, config);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, count: config.pendingLeadItems.length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && route === "/api/pipeline") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const parallelTabs = Math.min(4, Math.max(1, parseInt(payload.parallelTabs, 10) || 4));
        const browser = await getBrowserSessionStatus({ workspace: WORKSPACE });
        if (!browser.running || !browser.loggedIn) {
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, code: "login_required", error: browser.reason || "请先登录抖音", browser }));
          return;
        }
        registerPipelineTopic(payload.videoKeyword);
        fs.writeFileSync(path.join(WORKSPACE, "pipeline_request.json"), JSON.stringify({ ...payload, parallelTabs }, null, 2), "utf8");
        try { fs.writeFileSync(PAUSE_FILE, JSON.stringify({ paused: false }), "utf8"); } catch {}
        const progress = { stage: "start", done: 0, total: 0, found: 0, running: true, log: [] };
        fs.writeFileSync(path.join(WORKSPACE, "pipeline_progress.json"), JSON.stringify(progress, null, 2), "utf8");
        const { execFile } = require("child_process");
        if (pipelineChild) { try { pipelineChild.kill(); } catch {} pipelineChild = null; }
        pipelineChild = execFile(process.execPath, [path.join(__dirname, "..", "pipeline.js")], { timeout: 7200000 }, (err) => {
          pipelineChild = null;
          console.log("pipeline finished", err ? err.message.slice(0, 80) : "ok");
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && route === "/api/pipeline-pause") {
    // cooperative pause: pipeline checks this flag each loop; force-kill as fallback
    try { fs.writeFileSync(PAUSE_FILE, JSON.stringify({ paused: true }), "utf8"); } catch {}
    let progress = null;
    try { progress = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "pipeline_progress.json"), "utf8")); } catch {}
    const wasRunning = progress && progress.running;
    if (pipelineChild && wasRunning) {
      // give the pipeline a few seconds to exit gracefully, then force kill
      setTimeout(() => {
        if (pipelineChild) { try { pipelineChild.kill(); } catch {} console.log("pipeline force-killed after pause"); }
      }, 5000);
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, wasRunning: !!wasRunning }));
    return;
  }
  if (req.method === "GET" && route === "/api/pipeline-progress") {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "pipeline_progress.json"), "utf8"));
      const request = readJson(path.join(WORKSPACE, "pipeline_request.json"), {});
      const cleaning = readJson(CLEANING_STATS_FILE, null);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ...p, videoKeyword: String(request.videoKeyword || ""), cleaning }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ running: false, stage: "", done: 0, total: 0, found: 0, log: [], videoKeyword: "", cleaning: null }));
    }
    return;
  }
  if (req.method === "POST" && route === "/api/scan") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const keyword = payload.keyword || "求带";
        const videoLimit = parseInt(payload.videoLimit) || 30;
        const dateStart = payload.dateStart || "";
        const dateEnd = payload.dateEnd || "";
        const regionKeywords = payload.regionKeywords || "";
        const parallelTabs = Math.min(4, Math.max(1, parseInt(payload.parallelTabs, 10) || 4));
        fs.writeFileSync(path.join(WORKSPACE, "scan_request.json"), JSON.stringify({ keyword, videoLimit, dateStart, dateEnd, regionKeywords, parallelTabs }, null, 2), "utf8");
        try { fs.unlinkSync(path.join(WORKSPACE, "scan_new.json")); } catch {}
        const progress = { total: videoLimit, done: 0, found: 0, parallelTabs, running: true, log: [] };
        fs.writeFileSync(path.join(WORKSPACE, "scan_progress.json"), JSON.stringify(progress, null, 2), "utf8");
        const { execFile } = require("child_process");
        const node = process.execPath;
        execFile(node, [path.join(__dirname, "..", "scan_comments.js")], { timeout: 7200000 }, (err) => {
          console.log("scan finished", err ? err.message.slice(0, 60) : "ok");
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, keyword, videoLimit }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && route === "/api/scan-progress") {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "scan_progress.json"), "utf8"));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(p));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ running: false, done: 0, total: 0, found: 0, log: [] }));
    }
    return;
  }
  if (req.method === "GET" && route === "/api/qr-refresh") {
    const { execFile } = require("child_process");
    const node = process.execPath;
    execFile(node, [path.join(__dirname, "..", "qr_capture.js")], { timeout: 60000 }, (err) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: !err, err: err ? err.message.slice(0, 80) : null }));
    });
    return;
  }
  if (req.method === "POST" && route === "/api/browser/ensure") {
    (async () => {
      try {
        const status = await ensureBrowserSession({ workspace: WORKSPACE });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...status }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, running: false, loggedIn: false, needsLogin: true, error: error.message }));
      }
    })();
    return;
  }
  if (req.method === "GET" && route === "/api/browser/status") {
    (async () => {
      const status = await getBrowserSessionStatus({ workspace: WORKSPACE });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(status));
    })();
    return;
  }
  if (req.method === "GET" && route === "/api/login-status") {
    (async () => {
      const status = await getBrowserSessionStatus({ workspace: WORKSPACE });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(status));
    })();
    return;
  }
  if (req.method === "GET" && route === "/api/topics") {
    const comments = readJson(COMMENTS_FILE, []);
    const map = {};
    for (const c of comments) { const t = c.topic || "未分类"; map[t] = (map[t] || 0) + 1; }
    const stored = readJson(PIPELINE_TOPICS_FILE, []);
    const registry = Array.isArray(stored) ? stored : [];
    const names = new Set(registry.map((item) => item && item.name).filter(Boolean));
    for (const name of Object.keys(map)) {
      if (!names.has(name)) registry.push({ name, runs: 0, createdAt: "", lastRunAt: "" });
    }
    const topics = registry.map((item) => ({
      name: item.name,
      count: map[item.name] || 0,
      runs: Number(item.runs) || 0,
      lastRunAt: item.lastRunAt || "",
      hasRun: (Number(item.runs) || 0) > 0,
    })).sort((a, b) => b.count - a.count || String(b.lastRunAt).localeCompare(String(a.lastRunAt)));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ topics, total: comments.length }));
    return;
  }
  if (req.method === "GET" && route === "/api/regions") {
    const comments = readJson(COMMENTS_FILE, []);
    const provinceFilter = cleanPlace(u.searchParams.get("province") || "").replace(/省$/u, "");
    const provinces = new Map();
    const cities = new Map();
    let regionCount = 0;
    let cityCount = 0;
    for (const comment of comments) {
      const parts = commentRegionParts(comment || {});
      if (parts.raw || parts.province) regionCount++;
      if (parts.province) provinces.set(parts.province, (provinces.get(parts.province) || 0) + 1);
      if (parts.city) {
        cityCount++;
        if (!provinceFilter || parts.province === provinceFilter) cities.set(parts.city, (cities.get(parts.city) || 0) + 1);
      }
    }
    const sortRows = (map) => [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ total: comments.length, regionCount, cityCount, unknownRegionCount: comments.length - regionCount, provinces: sortRows(provinces), cities: sortRows(cities) }));
    return;
  }
  if (req.method === "GET" && route === "/api/comments") {
    const comments = readJson(COMMENTS_FILE, []);
    const kw = u.searchParams.get("q") || "";
    const ds = u.searchParams.get("dateStart") || "";
    const de = u.searchParams.get("dateEnd") || "";
    const region = u.searchParams.get("region") || "";
    const province = cleanPlace(u.searchParams.get("province") || "").replace(/省$/u, "");
    const city = cleanPlace(u.searchParams.get("city") || "").replace(/市$/u, "");
    const topic = u.searchParams.get("topic") || "";
    // search matches comment text AND video title (e.g. video keyword 猫抓板 finds its comments)
    let list = kw ? comments.filter((c) => ((c.text || "") + " " + (c.videoTitle || "")).includes(kw)) : comments;
    if (topic) list = list.filter((c) => (c.topic || "") === topic);
    if (ds || de) {
      const dsT = ds ? new Date(ds + "T00:00:00").getTime() / 1000 : 0;
      const deT = de ? new Date(de + "T23:59:59").getTime() / 1000 : Infinity;
      list = list.filter((c) => (c.createTime || 0) >= dsT && (c.createTime || 0) <= deT);
    }
    if (region) {
      const regs = region.split(",").map((s) => s.trim()).filter(Boolean);
      list = list.filter((c) => regs.some((r) => (c.region || "").indexOf(r) >= 0));
    }
    if (province) list = list.filter((c) => commentRegionParts(c).province === province);
    if (city) list = list.filter((c) => commentRegionParts(c).city === city);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ total: comments.length, shown: list.length, comments: list.map((comment) => ({ ...comment, ...commentRegionParts(comment), regionPrecision: commentRegionParts(comment).city ? "city" : (commentRegionParts(comment).province ? "province" : "unknown") })) }));
    return;
  }
  if (req.method === "GET" && route === "/api/queue") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(readJson(QUEUE_FILE, { queued: [], done: [] })));
    return;
  }
  if (req.method === "POST" && route === "/api/reply") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const items = payload.items || [];
        if (!items.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "empty" })); return; }
        const queue = readJson(QUEUE_FILE, { queued: [], done: [] });
        const now = Date.now();
        const scheduledAt = payload.scheduledAt ? new Date(payload.scheduledAt).getTime() : null;
        let queuedCount = 0;
        let skippedCount = 0;
        items.forEach((it) => {
          const sameTarget = queue.queued.filter((q) => String(q.commentId) === String(it.commentId) && String(q.awemeId) === String(it.awemeId));
          const active = sameTarget.find((q) => q.status !== "done" && q.status !== "failed");
          const failed = sameTarget.find((q) => q.status === "failed");
          if (active) {
            skippedCount++;
          } else if (failed) {
            Object.assign(failed, it, { taskId: failed.taskId || `${now}-${Math.random().toString(36).slice(2, 8)}`, status: "queued", error: null, createdAt: now, scheduledAt });
            queuedCount++;
          } else {
            queue.queued.push({ ...it, taskId: `${now}-${Math.random().toString(36).slice(2, 8)}`, status: "queued", createdAt: now, scheduledAt });
            queuedCount++;
          }
        });
        writeJson(QUEUE_FILE, queue);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, queuedCount, skippedCount, queue: queue.queued.length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, "0.0.0.0", () => console.log("reply-ui listening on http://0.0.0.0:" + PORT));
