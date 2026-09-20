
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
const PROGRESS_FILE = path.join(WORKSPACE, "scan_progress.json");
const COMMENT_FILE = path.join(WORKSPACE, "filtered_comments.json");
const SCAN_RAW_FILE = path.join(WORKSPACE, "scan_raw_batch.json");
const SCAN_CLEANED_FILE = path.join(WORKSPACE, "scan_cleaned_batch.json");
const SCAN_CLEANING_STATS_FILE = path.join(WORKSPACE, "scan_cleaning_report.json");
const CLEANER_FILE = path.join(WORKSPACE, "scrapling_bridge", "normalize_comments.py");
const KEYWORDS = ["求带", "带带我", "求带带", "求带飞", "带带吧"];
const IGNORED_KEYWORD_CHARS = new Set(Array.from(" \t\r\n,，、;；|｜/\\。.!！?？:：\"'“”‘’()[]{}<>《》【】（）-_=+~`@#$%^&*"));

function extractKeywordChars(value) {
  return [...new Set(Array.from(String(value || "").toLowerCase()).filter((ch) => !IGNORED_KEYWORD_CHARS.has(ch)))];
}

function matchesAnyKeywordChar(text, keywordChars) {
  const source = String(text || "").toLowerCase();
  return keywordChars.some((ch) => source.includes(ch));
}

function normalizeVideoText(value) {
  return String(value || "").toLowerCase().replace(/[\s\u200b]+/g, "");
}

function videoKey(video) {
  const id = String(video && video.awemeId || "").trim();
  return id ? "id:" + id : "text:" + normalizeVideoText(video && video.text) + "|url:" + String(video && video.url || "").trim();
}

function cleanScanBatchWithScrapling(entries) {
  if (!entries.length || !fs.existsSync(CLEANER_FILE)) return { ok: false, error: "清洗器不可用" };
  fs.writeFileSync(SCAN_RAW_FILE, JSON.stringify(entries, null, 2), "utf8");
  const python = process.env.SCRAPLING_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const args = process.platform === "win32" ? ["-3"] : [];
  args.push(CLEANER_FILE, "--input", SCAN_RAW_FILE, "--output", SCAN_CLEANED_FILE, "--stats", SCAN_CLEANING_STATS_FILE);
  const result = spawnSync(python, args, { cwd: WORKSPACE, encoding: "utf8", timeout: 120000, windowsHide: true });
  if (result.error || result.status !== 0) {
    return { ok: false, error: (result.error?.message || result.stderr || result.stdout || "清洗失败").trim().slice(0, 180) };
  }
  try {
    return { ok: true, entries: JSON.parse(fs.readFileSync(SCAN_CLEANED_FILE, "utf8")), stats: JSON.parse(fs.readFileSync(SCAN_CLEANING_STATS_FILE, "utf8")) };
  } catch (error) {
    return { ok: false, error: "清洗结果无效：" + error.message };
  }
}

// parse video publish date from search card text
function parseVideoDate(text) {
  const m = String(text || "").match(/[·•]\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const year = m[1] ? parseInt(m[1]) : 2026;
  const month = parseInt(m[2]);
  const day = parseInt(m[3]);
  const d = new Date(year, month - 1, day);
  return d.getTime();
}

(async () => {
  const req = JSON.parse(fs.readFileSync("D:\\deep seek\\scan_request.json", "utf8"));
  const keyword = req.keyword || "求带";
  const limit = req.videoLimit || 50;
  const ds = req.dateStart ? new Date(req.dateStart + "T00:00:00").getTime() : 0;
  const de = req.dateEnd ? new Date(req.dateEnd + "T23:59:59").getTime() : Infinity;
  const keywordChars = extractKeywordChars(keyword === "求带" ? KEYWORDS.join(",") : keyword);
  const regionList = (req.regionKeywords || "").split(",").map((s) => s.trim()).filter(Boolean);
  const parallelTabs = Math.min(4, Math.max(1, Number(req.parallelTabs) || 4));

  const allVideos = JSON.parse(fs.readFileSync("D:\\deep seek\\videos.json", "utf8"));
  const uniqueVideos = [];
  const videoKeys = new Set();
  for (const video of allVideos) {
    const key = videoKey(video);
    if (videoKeys.has(key)) continue;
    videoKeys.add(key);
    uniqueVideos.push(video);
  }
  let videos = uniqueVideos.slice(0, limit);
  if (req.dateStart || req.dateEnd) {
    videos = videos.filter((v) => {
      const t = parseVideoDate(v.text);
      if (!t) return false; // cannot verify date when filtering by date
      return t >= ds && t <= de;
    });
    console.log("video date filter: kept", videos.length, "of", Math.min(limit, allVideos.length));
  }
  let progress = { total: videos.length, done: 0, found: 0, parallelTabs, running: true, log: ["抓取模式：" + (parallelTabs > 1 ? parallelTabs + " 个网页并行" : "单网页串行")] };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");

  const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
  const tab = list.find((t) => t.type === "page" && (t.url || "").includes("douyin.com"));
  if (!tab) { console.log("NO_DOUYIN_TAB"); progress.running = false; fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8"); process.exit(1); }
  let newFound = 0;
  const existing = JSON.parse(fs.readFileSync(COMMENT_FILE, "utf8"));
  const existingIds = new Set(existing.map((c) => String(c.commentId || c.cid || "")));
  const existingKeys = new Set(existing.map((c) => String(c.user || "") + "|" + String(c.text || "") + "|" + String(c.awemeId || "")));
  const freshEntries = [];

  const tabs = [];
  const createdTabSockets = [];
  for (let i = 0; i < parallelTabs; i++) {
    const current = i === 0 ? tab : (await getJson("http://127.0.0.1:" + PORT + "/json/list")).find((t) => t.type === "page" && (t.url || "").includes("douyin.com"));
    if (i === 0) {
      tabs.push(new CDP(current.webSocketDebuggerUrl));
    } else {
      const version = await getJson("http://127.0.0.1:" + PORT + "/json/version");
      const browser = new CDP(version.webSocketDebuggerUrl);
      const created = await sendT(browser, "Target.createTarget", { url: "about:blank" }, 10000);
      await sleep(500);
      const targets = await getJson("http://127.0.0.1:" + PORT + "/json/list");
      const createdPage = targets.find((t) => t.type === "page" && t.id === created.targetId);
      if (createdPage) {
        tabs.push(new CDP(createdPage.webSocketDebuggerUrl));
        createdTabSockets.push(createdPage.webSocketDebuggerUrl);
      }
    }
  }
  for (const cdp of tabs) { await sendT(cdp, "Runtime.enable", {}, 8000); await sendT(cdp, "Network.enable", {}, 8000); }

  const processVideo = async (cdp, v, workerIndex) => {
  const scrollAll = async () => sendT(cdp, "Runtime.evaluate", {
    expression: "(function(){ var all=Array.from(document.querySelectorAll('*')); var cl=document.querySelector('[data-e2e=\"comment-list\"]'); for(var i=0;i<all.length;i++){ var e=all[i]; if(e.scrollHeight>e.clientHeight+100){ var cs=getComputedStyle(e); if(/scroll|auto/.test(cs.overflowY)){ e.scrollTop=e.scrollHeight; } } } return 'ok'; })()",
    returnByValue: true,
  }, 8000);

  {
    const awemeId = v.awemeId;
    const hits = [];
    const netHandler = (p) => {
      const u = p.response.url;
      if (u.includes("comment")) hits.push({ requestId: p.requestId });
    };
    try {
      cdp.on("Network.responseReceived", netHandler);
      await sendT(cdp, "Page.navigate", { url: "https://www.douyin.com/video/" + awemeId }, 12000);
      // wait for comment list
      for (let i = 0; i < 8; i++) {
        const has = await sendT(cdp, "Runtime.evaluate", { expression: "!!document.querySelector('[data-e2e=\"comment-list\"]')", returnByValue: true }, 8000).catch(() => ({ result: { value: false } }));
        if (has.result && has.result.value) break;
        await sleep(2000);
      }
      await sleep(3000);
      // scroll to load comments
      for (let s = 0; s < 5; s++) { await scrollAll().catch(() => {}); await sleep(2200); }
      // auto-expand reply threads (click 展开N条回复 buttons, up to 4 rounds)
      for (let er = 0; er < 4; er++) {
        const ex = await sendT(cdp, "Runtime.evaluate", {
          expression: "JSON.stringify((function(){ var btns=Array.from(document.querySelectorAll('*')).filter(function(e){ var t=(e.innerText||'').trim(); return /^展开[0-9]+条回复$/.test(t) && e.children.length===0; }); if(!btns.length) return 0; var n=0; for(var i=0;i<btns.length && i<12;i++){ btns[i].click(); n++; } return n; })())",
          returnByValue: true,
        }, 10000).catch(() => ({ result: { value: 0 } }));
        const nEx = parseInt(ex.result.value) || 0;
        if (nEx === 0) break;
        console.log("  expanded", nEx, "threads (round", er + 1 + ")");
        await sleep(3500);
        // capture newly fired reply-list requests
        for (const h of hits) {
          try {
            const b = await sendT(cdp, "Network.getResponseBody", { requestId: h.requestId }, 6000);
            const j = JSON.parse(b.body);
            if (j.comments && Array.isArray(j.comments) && j.comments.length) { /* already collected below */ }
          } catch {}
        }
      }
      // fetch comment API bodies
      const bodies = [];
      for (const h of hits) {
        try { const b = await sendT(cdp, "Network.getResponseBody", { requestId: h.requestId }, 8000); bodies.push(JSON.parse(b.body)); } catch {}
      }
      // collect + filter
      let got = 0;
      const seenC = new Set();
      for (const j of bodies) {
        for (const c of j.comments || []) {
          if (seenC.has(c.cid)) continue;
          seenC.add(c.cid);
          const text = c.text || "";
          if (!matchesAnyKeywordChar(text, keywordChars)) continue;
          const ct = (c.create_time || 0) * 1000;
          if (ct < ds || ct > de) continue;
          if (regionList.length && !regionList.some((rk) => (c.ip_label || "").indexOf(rk) >= 0)) continue;
          const fallbackKey = String(c.user?.nickname || "") + "|" + text + "|" + awemeId;
          if (existingIds.has(String(c.cid)) || existingKeys.has(fallbackKey)) continue;
          existingIds.add(String(c.cid));
          existingKeys.add(fallbackKey);
          const user = c.user || {};
          const province = String(c.province || user.province || c.region_province || "").trim();
          const cityCandidate = c.city_name || user.city_name || user.cityName || c.region_city || "";
          const city = /^\d+$/.test(String(cityCandidate || "")) ? "" : String(cityCandidate || "").trim();
          got++; newFound++;
          freshEntries.push({
            commentId: c.cid, awemeId, replyId: "",
            user: user.nickname || "",
            sec_uid: user.sec_uid || user.secUid || "",
            userSecUid: user.sec_uid || user.secUid || "",
            avatarUrl: user.avatar_thumb?.url_list?.[0] || user.avatar_larger?.url_list?.[0] || "",
            avatarCollected: Boolean(user.avatar_thumb || user.avatar_larger),
            worksCount: Number.isFinite(Number(user.aweme_count)) ? Number(user.aweme_count) : null,
            profilePrivate: typeof user.secret === "boolean" ? user.secret : null,
            text,
            likeCount: c.digg_count || 0,
            createTime: c.create_time || 0,
            time: c.create_time ? new Date(c.create_time * 1000).toLocaleDateString("zh-CN") : "",
            videoTitle: (v.text || "").replace(/\s+/g, " ").slice(0, 40),
            region: c.ip_label || [province, city].filter(Boolean).join(" "),
            province,
            city,
            source: "live-scan",
            topic: "副业怎么搞",
          });
        }
      }
      progress.log.push("网页 " + (workerIndex + 1) + " · video " + awemeId + ": +" + got);
      console.log("video", awemeId, "found:", got);
    } catch (e) {
      progress.log.push("fail " + awemeId + ": " + e.message.slice(0, 50));
    } finally {
      cdp.off("Network.responseReceived", netHandler);
    }
    progress.done++;
    progress.found = newFound;
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
    console.log("progress", progress.done + "/" + progress.total, "total found:", newFound);
    await sleep(1200);
  }
  };
  let cursor = 0;
  await Promise.all(tabs.map(async (cdp, workerIndex) => {
    while (true) {
      const index = cursor++;
      if (index >= videos.length) break;
      await processVideo(cdp, videos[index], workerIndex);
    }
  }));
  // 只关闭本次创建的临时标签页，保留用户原来的抖音登录页。
  try {
    const version = await getJson("http://127.0.0.1:" + PORT + "/json/version");
    const browser = new CDP(version.webSocketDebuggerUrl);
    const targets = await getJson("http://127.0.0.1:" + PORT + "/json/list");
    for (const socketUrl of createdTabSockets) {
      const target = targets.find((item) => item.webSocketDebuggerUrl === socketUrl);
      if (target) await sendT(browser, "Target.closeTarget", { targetId: target.id }, 8000);
    }
  } catch {}
  const cleanedBatch = cleanScanBatchWithScrapling(freshEntries);
  if (cleanedBatch.ok) {
    freshEntries.splice(0, freshEntries.length, ...cleanedBatch.entries.filter((entry) => !entry.low_value));
    const s = cleanedBatch.stats;
    progress.log.push("Scrapling 清洗：保留 " + s.outputCount + " 条，去重 " + s.duplicateCount + " 条，剔除无效 " + s.droppedCount + " 条，低价值过滤 " + s.lowValueCount + " 条");
  } else if (freshEntries.length) {
    progress.log.push("Scrapling 清洗未执行，实时扫描使用原结果：" + cleanedBatch.error);
  }
  // merge
  if (freshEntries.length) {
    const updated = JSON.parse(fs.readFileSync(COMMENT_FILE, "utf8"));
    const ids = new Set(updated.map((c) => String(c.commentId || c.cid || "")));
    const keys = new Set(updated.map((c) => String(c.user || "") + "|" + String(c.text || "") + "|" + String(c.awemeId || "")));
    const toAdd = freshEntries.filter((e) => {
      const key = String(e.user || "") + "|" + String(e.text || "") + "|" + String(e.awemeId || "");
      if (ids.has(String(e.commentId)) || keys.has(key)) return false;
      ids.add(String(e.commentId)); keys.add(key); return true;
    });
    fs.writeFileSync(COMMENT_FILE, JSON.stringify([...updated, ...toAdd], null, 2), "utf8");
    console.log("MERGED:", toAdd.length);
  }
  progress.running = false;
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
  console.log("SCAN_DONE");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
