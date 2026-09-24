
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
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
const PROGRESS = path.join(WORKSPACE, "pipeline_progress.json");
const COMMENT_FILE = path.join(WORKSPACE, "filtered_comments.json");
const PAUSE_FILE = path.join(WORKSPACE, "pipeline_pause.json");
const RAW_FILE = path.join(WORKSPACE, "pipeline_raw.json");
const CLEANED_FILE = path.join(WORKSPACE, "pipeline_cleaned.json");
const CLEANING_STATS_FILE = path.join(WORKSPACE, "pipeline_cleaning_report.json");
const CLEANER_FILE = path.join(WORKSPACE, "scrapling_bridge", "normalize_comments.py");
const QUEUE_FILE = path.join(WORKSPACE, "replies_queue.json");
const LIVE_CONFIG_FILE = path.join(WORKSPACE, "live_config.json");

function saveProgress(p) { fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2), "utf8"); }

function pauseRequested() {
  try { return JSON.parse(fs.readFileSync(PAUSE_FILE, "utf8")).paused === true; } catch { return false; }
}
const STOP = { flag: false };
async function checkPause() { if (STOP.flag || pauseRequested()) { STOP.flag = true; throw new Error("PAUSE"); } }
const IGNORED_KEYWORD_CHARS = new Set(Array.from(" \t\r\n,，、;；|｜/\\。.!！?？:：\"'“”‘’()[]{}<>《》【】（）-_=+~`@#$%^&*"));

function extractKeywordChars(value) {
  return [...new Set(Array.from(String(value || "").toLowerCase()).filter((ch) => !IGNORED_KEYWORD_CHARS.has(ch)))];
}

function matchesAnyKeywordChar(text, keywordChars) {
  const source = String(text || "").toLowerCase();
  return keywordChars.some((ch) => source.includes(ch));
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[\s\u200b]+/g, "");
}

// 关键词分词：按空白/标点切分，再在「中文↔英文数字」边界切分，并剥掉疑问/功能前缀
// 例："怎么充值codex" -> ["充值","codex"]；"副业怎么搞" -> ["副业怎么搞"]
const INTERROGATIVE_PREFIXES = ["怎么", "如何", "怎样", "咋样", "咋", "哪里", "在哪", "哪个", "什么", "有没有", "求", "教我", "请问", "想问", "麻烦"];
const FUNCTION_WORDS = new Set(["的", "了", "吗", "呢", "吧", "啊", "呀", "和", "与", "或", "在", "是", "我", "你", "他", "它", "要", "想", "会", "能", "可以", "这个", "那个", "一下"]);
function keywordSegments(keyword) {
  const raw = String(keyword || "").trim();
  if (!raw) return [];
  const rough = raw.split(/[\s,，。.!！?？、;；:：/|]+/).filter(Boolean);
  const parts = [];
  for (const piece of rough) {
    const chunks = piece.match(/[\u4e00-\u9fa5]+|[A-Za-z0-9]+/g) || [];
    chunks.forEach((c) => parts.push(c));
  }
  const out = [];
  for (const part of parts) {
    let lower = part.toLowerCase();
    if (/^[\u4e00-\u9fa5]+$/.test(part)) {
      for (const p of INTERROGATIVE_PREFIXES) {
        if (lower.startsWith(p) && lower.length > p.length) { lower = lower.slice(p.length); break; }
      }
      if (lower.length < 2) continue;
      if (FUNCTION_WORDS.has(lower)) continue;
      out.push(lower);
    } else {
      if (lower.length < 2) continue;
      out.push(lower);
    }
  }
  return Array.from(new Set(out));
}
// 视频匹配：优先整串连续命中；否则退化为「分词 AND 命中」（顺序无关）
// 修复背景：抖音标题几乎不会连续包含"怎么充值codex"，旧逻辑会把搜索结果全部过滤成 0
function videoMatchesSearchKeyword(videoText, keyword) {
  const source = normalizeSearchText(videoText);
  const target = normalizeSearchText(keyword);
  if (!target) return true;
  if (source.includes(target)) return true;
  const segs = keywordSegments(keyword);
  if (!segs.length) return false;
  return segs.every((s) => source.includes(s));
}

function videoDedupeKey(video) {
  const id = String(video && video.awemeId || "").trim();
  if (id) return "id:" + id;
  return "text:" + normalizeSearchText(video && video.text) + "|url:" + String(video && video.url || "").trim();
}

function cleanCommentsWithScrapling() {
  if (!fs.existsSync(CLEANER_FILE)) return { ok: false, error: "清洗器文件不存在" };
  const python = process.env.SCRAPLING_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const args = process.platform === "win32" ? ["-3"] : [];
  args.push(CLEANER_FILE, "--input", RAW_FILE, "--output", CLEANED_FILE, "--stats", CLEANING_STATS_FILE);
  const result = spawnSync(python, args, { cwd: WORKSPACE, encoding: "utf8", timeout: 120000, windowsHide: true });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || "未知错误").trim().slice(0, 240) };
  try {
    const stats = JSON.parse(fs.readFileSync(CLEANING_STATS_FILE, "utf8"));
    return { ok: true, stats };
  } catch (error) {
    return { ok: false, error: "清洗统计文件无效：" + error.message };
  }
}

async function createTab(url) {
  const version = await getJson("http://127.0.0.1:" + PORT + "/json/version");
  const browser = new CDP(version.webSocketDebuggerUrl);
  const { targetId } = await sendT(browser, "Target.createTarget", { url }, 15000);
  await sleep(1000);
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
async function closeTab(cdp) {
  try {
    const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
    const tab = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl === cdp.ws.url);
    if (tab) {
      const version = await getJson("http://127.0.0.1:" + PORT + "/json/version");
      const browser = new CDP(version.webSocketDebuggerUrl);
      await sendT(browser, "Target.closeTarget", { targetId: tab.id }, 8000);
    }
  } catch {}
  try { cdp.ws.close(); } catch {}
}

function parseVideoDate(text) {
  const m = String(text || "").match(/[·•]\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return new Date(m[1] ? parseInt(m[1]) : 2026, parseInt(m[2]) - 1, parseInt(m[3])).getTime();
}

const scrollWheel = async (cdp, times) => {
  for (let i = 0; i < times; i++) {
    if (pauseRequested()) throw new Error("PAUSE");
    // wheel over the comment area (right side) plus scrollTop fallback
    await sendT(cdp, "Input.dispatchMouseEvent", { type: "mouseWheel", deltaX: 0, deltaY: 2200, x: 1150, y: 550 }, 6000).catch(() => {});
    await sendT(cdp, "Runtime.evaluate", {
      expression: "(function(){ var all=Array.from(document.querySelectorAll('*')); for(var i=0;i<all.length;i++){ var e=all[i]; if(e.scrollHeight>e.clientHeight+100){ var cs=getComputedStyle(e); if(/scroll|auto/.test(cs.overflowY)){ e.scrollTop=e.scrollHeight; } } } return 'ok'; })()",
      returnByValue: true,
    }, 6000).catch(() => {});
    await sleep(2500);
  }
};
const scrollPage = async (cdp, steps) => scrollWheel(cdp, steps);

(async () => {
  const req = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "pipeline_request.json"), "utf8"));
  const videoKeyword = req.videoKeyword || "副业怎么搞";
  const commentKeywordChars = extractKeywordChars(req.commentKeywords || "求带");
  // 评论匹配模式（重要）：
  //   char    = 任意字命中（默认，召回优先但噪音大：有/1/么 这种单字会把无关评论全捞进来）
  //   segment = 整串命中 或 二字词命中（推荐：既能召回，又不会被单字带偏）
  //   phrase  = 必须整串命中（最严，量少）
  const commentKeywords = String(req.commentKeywords || "求带").replace(/[，、]/g, " ").split(" ").filter(Boolean);
  const commentMatchMode = String(req.commentMatchMode || "char");
  const commentSegments = (function () {
    var set = new Set();
    commentKeywords.forEach(function (k) {
      var allDigits = k.length > 0 && k.split("").every(function (ch) { return ch >= "0" && ch <= "9"; });
      if (allDigits) { set.add(k); return; }   // 纯数字关键词不切分：111 不该匹配 211
      if (k.length <= 2) { set.add(k); return; }
      for (var i = 0; i + 2 <= k.length; i++) set.add(k.slice(i, i + 2));
    });
    return Array.from(set);
  })();
  const matchesCommentKeywords = function (text) {
    var t = String(text || "");
    if (commentMatchMode === "phrase") return commentKeywords.some(function (k) { return t.indexOf(k) >= 0; });
    if (commentMatchMode === "segment") return commentKeywords.some(function (k) { return t.indexOf(k) >= 0; }) || commentSegments.some(function (s) { return t.indexOf(s) >= 0; });
    return matchesAnyKeywordChar(t, commentKeywordChars);
  };
  const maxVideos = req.maxVideos || 30;
  const parallelTabs = Math.min(4, Math.max(1, Number(req.parallelTabs) || 4));
  const ds = req.dateStart ? new Date(req.dateStart + "T00:00:00").getTime() : 0;
  const de = req.dateEnd ? new Date(req.dateEnd + "T23:59:59").getTime() : Infinity;
  const regionList = (req.regionKeywords || "").split(",").map((s) => s.trim()).filter(Boolean);

  try { fs.writeFileSync(PAUSE_FILE, JSON.stringify({ paused: false }), "utf8"); } catch {}
  let p = { stage: "search", done: 0, total: 0, found: 0, parallelTabs, running: true, log: [] };
  saveProgress(p);
  let allRaw = [];
  let searchTabsRef = [];
  let crawlTabsRef = []; // parallel crawl tabs (closed on pause/exit)

  async function pauseExit(reason) {
    p.stage = "paused";
    p.running = false;
    p.log.push(reason);
    if (allRaw.length > 0) {
      try {
        fs.writeFileSync(RAW_FILE, JSON.stringify(allRaw, null, 2), "utf8");
        p.log.push("已保存当前 " + allRaw.length + " 条原始评论 -> pipeline_raw.json");
      } catch {}
    }
    saveProgress(p);
    for (const t of searchTabsRef) { try { await closeTab(t); } catch {} }
    for (const t of crawlTabsRef) { try { await closeTab(t); } catch {} }
    console.log("PIPELINE_PAUSED");
    process.exit(0);
  }

  const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
  const tab = list.find((t) => t.type === "page" && (t.url || "").includes("douyin.com"));
  if (!tab) { p.log.push("ERROR: no douyin tab"); p.running = false; saveProgress(p); process.exit(1); }
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await sendT(cdp, "Runtime.enable", {}, 8000);
  await sendT(cdp, "Network.enable", {}, 8000);

  // ============ STAGE 1: search videos ============
  p.log.push("STAGE1 搜索视频关键词: " + videoKeyword);
  p.log.push("评论匹配模式 " + commentMatchMode + "：" + commentKeywords.join("/") + (commentMatchMode === "char" ? ("（任意字: " + commentKeywordChars.join("/") + "）") : (commentMatchMode === "segment" ? ("（二字词: " + commentSegments.join("/") + "）") : "")));
  p.log.push("抓取模式：" + (parallelTabs > 1 ? parallelTabs + " 个网页并行" : "单网页串行"));
  saveProgress(p);
  const kwEnc = encodeURIComponent(videoKeyword);
  const searchTabs = [];
  for (let i = 0; i < parallelTabs; i++) {
    const page = await createTab("https://www.douyin.com/search/" + kwEnc + "?type=general");
    await sendT(page, "Runtime.enable", {}, 8000);
    await sendT(page, "Network.enable", {}, 8000);
    searchTabs.push(page);
  }
  searchTabsRef = searchTabs;
  p.log.push("已打开 " + searchTabs.length + " 个并行搜索标签页");
  saveProgress(p);
  await sleep(10000);
  // collect waterfall items with scrolling
  const all = new Map();
  const collectSearchPage = async (searchTab, tabIndex) => {
    for (let s = 0; s < 20; s++) {
    if (pauseRequested()) await pauseExit("已暂停（搜索阶段，已发现 " + all.size + " 个视频）");
    try { await scrollPage(searchTab, 1); } catch (e) { if (e.message === "PAUSE") await pauseExit("已暂停（搜索阶段，已发现 " + all.size + " 个视频）"); throw e; }
    const res = await sendT(searchTab, "Runtime.evaluate", {
      expression: "JSON.stringify(Array.from(document.querySelectorAll('[id^=\"waterfall_item_\"]')).map(function(e){ return { id: e.id, text: (e.innerText||'').replace(/\s+/g,' ').slice(0,200) }; }))",
      returnByValue: true,
    }, 10000).catch(() => ({ result: { value: "[]" } }));
    try {
      JSON.parse(res.result.value).forEach((it) => { if (!all.has(it.id)) all.set(it.id, it); });
    } catch {}
    if (s % 5 === 4) { p.log.push("搜索网页 " + (tabIndex + 1) + " 已发现合并视频 " + all.size + " 个..."); saveProgress(p); }
    if (all.size >= 200) break;
    }
  }
  await Promise.all(searchTabs.map((page, index) => collectSearchPage(page, index)));
  // 关键词优化：统计「整串命中」与「分词命中」，并把优化结果写进进度，供工作台展示
  const normalizedKw = normalizeSearchText(videoKeyword);
  const kwSegments = keywordSegments(videoKeyword);
  const kwOptimized = kwSegments.length > 0 && !(kwSegments.length === 1 && kwSegments[0] === normalizedKw);
  let exactHits = 0;
  let segmentHits = 0;
  const baseVideos = Array.from(all.values())
    .filter((v) => !(v.text || "").startsWith("相关搜索") && v.text)
    .map((v) => ({ awemeId: v.id.replace("waterfall_item_", ""), text: v.text, url: "https://www.douyin.com/video/" + v.id.replace("waterfall_item_", "") }));
  // 可选：跳过图文帖（图文帖的网页版评论区是小浮层，无法回复评论；用于「评论回复」场景）
  const candidateVideos = req.skipNotes ? baseVideos.filter((v) => !String(v.text || "").trim().startsWith("图文")) : baseVideos;
  const matchedVideos = candidateVideos.filter((video) => {
    const source = normalizeSearchText(video.text);
    if (source.includes(normalizedKw)) { exactHits++; return true; }
    if (kwSegments.length && kwSegments.every((s) => source.includes(s))) { segmentHits++; return true; }
    return false;
  });
  p.keyword = {
    original: videoKeyword,
    normalized: normalizedKw,
    segments: kwSegments,
    optimized: kwOptimized,
    strategy: kwOptimized ? "分词匹配（顺序无关）" : "整串匹配",
    scanned: candidateVideos.length,
    exactHits,
    segmentHits,
    matched: matchedVideos.length,
  };
  if (kwOptimized) {
    p.log.push("关键词优化：搜索词 “" + videoKeyword + "” 拆为 [" + kwSegments.join(" + ") + "] 顺序无关匹配（整串命中 " + exactHits + " 个，分词命中 " + segmentHits + " 个）");
  } else {
    p.log.push("关键词匹配：整串匹配 “" + videoKeyword + "”，命中 " + exactHits + " 个" + (req.skipNotes ? "（已跳过图文帖）" : ""));
  }
  saveProgress(p);
  const uniqueVideos = [];
  const videoKeys = new Set();
  for (const video of matchedVideos) {
    const key = videoDedupeKey(video);
    if (videoKeys.has(key)) continue;
    videoKeys.add(key);
    uniqueVideos.push(video);
  }
  const selectedVideos = uniqueVideos.slice(0, maxVideos);
  p.log.push("关键词筛选后去重得到 " + uniqueVideos.length + " 个视频，本次抓取 " + selectedVideos.length + " 个");
  const videos = selectedVideos;
  p.total = videos.length;
  saveProgress(p);
  if (!videos.length) { p.log.push("ERROR: no videos found"); p.running = false; saveProgress(p); process.exit(0); }
  const savedVideos = [];
  const savedVideoKeys = new Set();
  const previousVideos = (() => { try { return JSON.parse(fs.readFileSync("D:\\deep seek\\pipeline_videos.json", "utf8")); } catch { return []; } })();
  for (const video of [...previousVideos, ...videos]) {
    const key = videoDedupeKey(video);
    if (savedVideoKeys.has(key)) continue;
    savedVideoKeys.add(key);
    savedVideos.push(video);
  }
  fs.writeFileSync("D:\\deep seek\\pipeline_videos.json", JSON.stringify(savedVideos, null, 2), "utf8");
  p.log.push("视频已去重并写入工作台记录：当前任务 " + videos.length + " 个，累计 " + savedVideos.length + " 个");
  for (const page of searchTabsRef) { try { await closeTab(page); } catch {} }
  searchTabsRef = [];

  // ============ STAGE 2: crawl comments in PARALLEL tabs + captcha hold ============
  p.stage = "crawl";
  saveProgress(p);

  // ---- shared captcha state: any tab that hits a captcha pauses ALL tabs ----
  let captchaWait = false;       // true while a captcha is being shown
  const CAPTCHA_EXPR = "JSON.stringify((function(){ var t=(document.title||''); var b=(document.body?document.body.innerText:''); return (t.indexOf('验证码')>=0 || b.indexOf('验证码中间页')>=0 || b.indexOf('请输入验证码')>=0 || b.indexOf('安全验证')>=0 || b.indexOf('拖动滑块')>=0); })())";
  const detectCaptcha = async (c) => {
    try {
      const r = await sendT(c, "Runtime.evaluate", { expression: CAPTCHA_EXPR, returnByValue: true }, 6000);
      return !!(r.result && r.result.value === "true");
    } catch { return false; }
  };
  const activateTab = async (c) => {
    try {
      const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
      const tab = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl === c.ws.url);
      if (!tab) return;
      const ver = await getJson("http://127.0.0.1:" + PORT + "/json/version");
      const browser = new CDP(ver.webSocketDebuggerUrl);
      await sendT(browser, "Target.activateTarget", { targetId: tab.id }, 8000);
    } catch {}
  };
  // blocks until the user completes the captcha in the visible Chrome window
  async function holdForCaptcha(c, awemeId) {
    if (captchaWait) { while (captchaWait) await sleep(2000); return; }
    captchaWait = true;
    p.log.push("⛔ 遇到验证码（视频 " + awemeId + "）！已暂停全部抓取，请你在 Chrome 窗口完成验证，完成前我会一直等待...");
    p.stage = "captcha";
    saveProgress(p);
    await activateTab(c);
    const started = Date.now();
    while (Date.now() - started < 1800000) { // wait up to 30 min for the user
      if (pauseRequested()) await pauseExit("已暂停（验证码等待期间点了暂停）");
      await sleep(3000);
      const still = await detectCaptcha(c);
      if (!still) { captchaWait = false; p.log.push("✅ 验证已通过，继续抓取..."); p.stage = "crawl"; saveProgress(p); return; }
    }
    captchaWait = false;
    p.log.push("⛔ 等待验证码超时(30分钟)，流程停止，请重新运行");
    p.running = false;
    saveProgress(p);
    for (const t of crawlTabsRef) { try { await closeTab(t); } catch {} }
    process.exit(0);
  }

  // ---- one video on one tab ----
  async function crawlOne(tab, v) {
    const hits = [];
    const netHandler = (p2) => { const u = p2.response.url; if (u.includes("comment")) hits.push({ requestId: p2.requestId }); };
    try {
      if (captchaWait) { while (captchaWait) await sleep(2000); }
      if (pauseRequested()) await pauseExit("已暂停（第 " + p.done + "/" + p.total + " 个视频前）");
      tab.on("Network.responseReceived", netHandler);
      await sendT(tab, "Page.navigate", { url: v.url }, 15000);
      // after navigation the page may show a captcha instead of comments
      for (let i = 0; i < 8; i++) {
        if (await detectCaptcha(tab)) { await holdForCaptcha(tab, v.awemeId); return { ok: false, captcha: true }; }
        const has = await sendT(tab, "Runtime.evaluate", { expression: "!!document.querySelector('[data-e2e=\"comment-list\"]')", returnByValue: true }, 8000).catch(() => ({ result: { value: false } }));
        if (has.result && has.result.value) break;
        await sleep(2000);
      }
      await sleep(3000);
      await activateTab(tab); // bring to front so scroll triggers comment lazy-load
      await sleep(800);
      await scrollPage(tab, 7);
      // expand threads
      for (let er = 0; er < 3; er++) {
        const ex = await sendT(tab, "Runtime.evaluate", {
          expression: "JSON.stringify((function(){ var btns=Array.from(document.querySelectorAll('*')).filter(function(e){ var t=(e.innerText||'').trim(); return /^展开[0-9]+条回复$/.test(t) && e.children.length===0; }); if(!btns.length) return 0; var n=0; for(var i=0;i<btns.length && i<10;i++){ btns[i].click(); n++; } return n; })())",
          returnByValue: true,
        }, 10000).catch(() => ({ result: { value: 0 } }));
        const n = parseInt(ex.result.value) || 0;
        if (!n) break;
        await sleep(2500);
      }
      const bodies = [];
      for (const h of hits) {
        try { const b = await sendT(tab, "Network.getResponseBody", { requestId: h.requestId }, 8000); bodies.push(JSON.parse(b.body)); } catch {}
      }
      const seen = new Set();
      let n = 0;
      for (const j of bodies) for (const c of j.comments || []) {
        if (seen.has(c.cid)) continue;
        seen.add(c.cid);
        n++;
        const user = c.user || {};
        const avatarUrl = user.avatar_thumb?.url_list?.[0] || user.avatar_larger?.url_list?.[0] || "";
        const province = String(c.province || user.province || c.region_province || "").trim();
        const cityCandidate = c.city_name || user.city_name || user.cityName || c.region_city || "";
        const city = /^\d+$/.test(String(cityCandidate || "")) ? "" : String(cityCandidate || "").trim();
        allRaw.push({
          cid: c.cid,
          awemeId: v.awemeId,
          text: c.text || "",
          user: user.nickname || "",
          userSecUid: user.sec_uid || user.secUid || "",
          sec_uid: user.sec_uid || user.secUid || "",
          avatarUrl,
          avatarCollected: Boolean(user.avatar_thumb || user.avatar_larger),
          worksCount: Number.isFinite(Number(user.aweme_count)) ? Number(user.aweme_count) : null,
          profilePrivate: typeof user.secret === "boolean" ? user.secret : null,
          digg: c.digg_count || 0,
          createTime: c.create_time || 0,
          videoTitle: v.text.slice(0, 40),
          region: c.ip_label || [province, city].filter(Boolean).join(" "),
          province,
          city,
        });
      }
      p.log.push("视频 " + v.awemeId + " 评论 " + n + " 条");
      return { ok: true, count: n };
    } catch (e) {
      if (e.message === "PAUSE") await pauseExit("已暂停（视频 " + v.awemeId + " 处理中）");
      p.log.push("fail " + v.awemeId + ": " + e.message.slice(0, 40));
      return { ok: false, error: e.message.slice(0, 40) };
    } finally {
      tab.off("Network.responseReceived", netHandler);
    }
  }

  // ---- open parallel tabs（并让用户能在 Chrome 里看到）----
  const TAB_COUNT = parallelTabs;
  const tabs = [];
  for (let i = 0; i < TAB_COUNT; i++) {
    const c = await createTab("about:blank");
    await sendT(c, "Runtime.enable", {}, 8000);
    await sendT(c, "Network.enable", {}, 8000);
    tabs.push(c);
  }
  crawlTabsRef = tabs;
  p.parallelTabs = TAB_COUNT;
  p.log.push("已打开 " + TAB_COUNT + " 个并行爬取标签页（可在 Chrome 窗口直接看到同时爬取）");
  saveProgress(p);
  // 把 Chrome 窗口提到前台，方便观察并行过程
  try {
    const list0 = await getJson("http://127.0.0.1:" + PORT + "/json/list");
    const first = list0.find((t) => t.type === "page" && t.webSocketDebuggerUrl === tabs[0].ws.url);
    if (first) {
      const ver0 = await getJson("http://127.0.0.1:" + PORT + "/json/version");
      const bw = new CDP(ver0.webSocketDebuggerUrl);
      await sendT(bw, "Target.activateTarget", { targetId: first.id }, 8000).catch(() => {});
      bw.ws.close();
    }
  } catch {}


  // ---- parallel dispatch: round-robin over videos ----
  let idx = 0;
  const interrupted = []; // videos interrupted by captcha (retried after)
  const workers = tabs.map(async (tab) => {
    while (true) {
      if (pauseRequested()) await pauseExit("已暂停（并行抓取中，已完成 " + p.done + "/" + p.total + "）");
      const myIdx = idx++;
      if (myIdx >= videos.length) break;
      const v = videos[myIdx];
      const r = await crawlOne(tab, v);
      if (r && r.captcha) { interrupted.push(v); p.log.push("⚠️ 视频 " + v.awemeId + " 因验证码中断，稍后重试"); saveProgress(p); continue; }
      p.done++;
      saveProgress(p);
      await sleep(500 + Math.random() * 800);
    }
  });
  await Promise.all(workers);

  // ---- retry videos interrupted by captcha (captcha already cleared) ----
  for (const v of interrupted) {
    if (pauseRequested()) await pauseExit("已暂停（重试中断视频前）");
    const tab = tabs[Math.floor(Math.random() * tabs.length)];
    const r = await crawlOne(tab, v);
    if (r && r.captcha) { p.log.push("⚠️ 视频 " + v.awemeId + " 再次遇到验证码，跳过"); }
    p.done++;
    saveProgress(p);
    await sleep(800);
  }
  // persist raw crawl so re-filtering never requires a re-crawl
  fs.writeFileSync(RAW_FILE, JSON.stringify(allRaw, null, 2), "utf8");
  p.log.push("原始评论已存 " + allRaw.length + " 条 -> pipeline_raw.json");
  const cleaning = cleanCommentsWithScrapling();
  if (cleaning.ok) {
    allRaw = JSON.parse(fs.readFileSync(CLEANED_FILE, "utf8"));
    const s = cleaning.stats;
    p.log.push("Scrapling 清洗完成：保留 " + s.outputCount + " 条，去重 " + s.duplicateCount + " 条，剔除异常 " + s.droppedCount + " 条，低价值标记 " + s.lowValueCount + " 条");
  } else {
    p.log.push("Scrapling 清洗未执行，继续使用原始评论：" + cleaning.error);
  }
  saveProgress(p);
  for (const t of crawlTabsRef) { try { await closeTab(t); } catch {} }
  crawlTabsRef = [];
// ============ STAGE 3: filter by comment keywords + dedupe + merge ============
  p.stage = "filter";
  saveProgress(p);
  const existing = JSON.parse(fs.readFileSync(COMMENT_FILE, "utf8"));
  const existingIds = new Set(existing.map((c) => String(c.commentId || c.cid || "")));
  const existingTexts = new Set(existing.map((c) => (c.user || "") + "|" + (c.text || "") + "|" + (c.awemeId || "")));
  let added = 0;
  const seen = new Set();
  for (const c of allRaw) {
    const commentKey = String(c.cid || "") || (String(c.user || "") + "|" + String(c.text || "") + "|" + String(c.awemeId || ""));
    if (seen.has(commentKey)) continue;
    seen.add(commentKey);
    if (c.low_value) continue;
    if (!matchesCommentKeywords(c.text)) continue;
    if (c.createTime * 1000 < ds || c.createTime * 1000 > de) continue;
    if (regionList.length && !regionList.some((rk) => (c.region || "").indexOf(rk) >= 0)) continue;
    if (existingIds.has(String(c.cid))) continue;
    // content-based dedupe (same user + same text)
    const key = c.user + "|" + c.text + "|" + c.awemeId;
    if (existingTexts.has(key)) continue;
    existingTexts.add(key);
    added++;
    existing.push({
      commentId: c.cid, awemeId: c.awemeId, replyId: "",
      user: c.user, text: c.text,
      likeCount: c.digg || 0, createTime: c.createTime,
      time: c.createTime ? new Date(c.createTime * 1000).toLocaleDateString("zh-CN") : "",
      videoTitle: c.videoTitle,
      region: c.region,
      province: c.province || "",
      city: c.city || "",
      regionPrecision: c.regionPrecision || (c.city ? "city" : (c.province ? "province" : "unknown")),
      sec_uid: c.sec_uid || c.userSecUid || "",
      userSecUid: c.sec_uid || c.userSecUid || "",
      profileUrl: c.profileUrl || (c.sec_uid ? "https://www.douyin.com/user/" + encodeURIComponent(c.sec_uid) : ""),
      avatarUrl: c.avatarUrl || "",
      worksCount: c.worksCount ?? null,
      low_value: false,
      qualityFlags: c.qualityFlags || [],
      userLocatorReady: Boolean(c.sec_uid || c.userSecUid),
      source: "pipeline", topic: videoKeyword,
    });
  }
  fs.writeFileSync(COMMENT_FILE, JSON.stringify(existing, null, 2), "utf8");
  p.found = added;
  p.log.push("筛选新增 " + added + " 条（关键词任意字: " + commentKeywordChars.join("/") + (regionList.length ? " 地域: " + regionList.join("/") : "") + "）");

  // ============ 自动链路：入队评论回复 + 排队私信 ============
  if (req.autoReply || req.autoDm) {
    try {
      const newlyAdded = existing.slice(existing.length - added);
      // 2.1 评论回复入队（文案默认「关注我」）
      if (req.autoReply && newlyAdded.length) {
        const replyText = String(req.autoReplyText || "关注我");
        const queue = (() => { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch { return { queued: [], done: [] }; } })();
        queue.queued = Array.isArray(queue.queued) ? queue.queued : [];
        // 硬校验：只要该 cid 在队列里出现过（含 done/failed/skipped）或已写进回复历史，就绝不再入队，
        // 避免同一条评论被回复两次。
        const seen = new Set(queue.queued.map((x) => String(x.commentId)));
        (queue.done || []).forEach((x) => seen.add(String(x.commentId)));
        try {
          const hist = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "replied_history.json"), "utf8"));
          (Array.isArray(hist) ? hist : Object.keys(hist || {})).forEach((x) => seen.add(String(x)));
        } catch {}
        let n = 0;
        for (const c of newlyAdded) {
          if (seen.has(String(c.commentId))) continue;
          seen.add(String(c.commentId));
          queue.queued.push({
            commentId: String(c.commentId), awemeId: String(c.awemeId), replyId: c.replyId || "",
            nick: c.user, text: replyText, status: "queued",
            createdAt: Date.now(), updatedAt: Date.now(), scheduledAt: null,
            taskId: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          });
          n++;
        }
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
        p.log.push("已自动入队评论回复 " + n + " 条（文案：" + replyText + "）");
      }
      // 2.2 私信任务排队（写 live_config.pendingLeadItems，由 dm_queue_runner 逐条准备）
      if (req.autoDm && newlyAdded.length) {
        const dmText = String(req.autoDmText || "你好");
        const cfg = (() => { try { return JSON.parse(fs.readFileSync(LIVE_CONFIG_FILE, "utf8")); } catch { return {}; } })();
        cfg.pendingLeadItems = Array.isArray(cfg.pendingLeadItems) ? cfg.pendingLeadItems : [];
        const seenDm = new Set(cfg.pendingLeadItems.map((x) => String(x.id)));
        let n = 0;
        for (const c of newlyAdded) {
          const sec = c.sec_uid || c.userSecUid || "";
          if (!sec) continue; // 无 sec_uid 无法定位用户，跳过（不伪造）
          const id = "dm-" + String(c.commentId);
          if (seenDm.has(id)) continue;
          cfg.pendingLeadItems.push({
            id, secUid: sec,
            profileUrl: c.profileUrl || ("https://www.douyin.com/user/" + encodeURIComponent(sec)),
            user: c.user, avatarUrl: c.avatarUrl || "", room: "视频评论",
            lastText: c.text || "", template: dmText,
            dmStatus: "queued", dmReason: "等待逐条准备",
            source: "pipeline", topic: videoKeyword, createdAt: Date.now(),
          });
          n++;
        }
        fs.writeFileSync(LIVE_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
        p.log.push("已排队私信任务 " + n + " 条（文案：" + dmText + "）");
      }
    } catch (e) { p.log.push("自动链路失败：" + String(e.message).slice(0, 60)); }
  }
  p.running = false;
  saveProgress(p);
  console.log("PIPELINE_DONE found:", added);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
