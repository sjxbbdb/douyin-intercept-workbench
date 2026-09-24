// 独立私信执行器：不依赖工作台服务，直接建任务 + 起 live_dm_worker.js，日志落盘
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WORKSPACE = process.env.REPLY_WORKSPACE || path.resolve(__dirname);
const CONFIG = path.join(WORKSPACE, "live_config.json");
const STATE = path.join(WORKSPACE, "live_dm_state.json");
const WORKER = path.join(WORKSPACE, "live_dm_worker.js");
const LOG = path.join(WORKSPACE, "dm_run.log");
const WORKER_LOG = path.join(WORKSPACE, "dm_worker.log");
const TERMINAL = ["sent", "skipped", "failed"];
const ACTIVE = ["opening_profile", "profile_opened", "opening_dm", "dm_opened", "prefilled", "waiting_manual_send"];
const GAP_MS = Number(process.env.DM_GAP_MS || 25000);
const MAX_PER_RUN = Number(process.env.DM_MAX_PER_RUN || 0); // 0 = 不限
const WORKER_TIMEOUT_MS = Number(process.env.DM_WORKER_TIMEOUT_MS || 5 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const writeJson = (f, v) => { const t = f + ".tmp-" + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 2), "utf8"); fs.renameSync(t, f); };
const log = (...a) => { const line = new Date().toISOString().slice(11, 19) + " " + a.join(" "); console.log(line); try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch {} };

// 用系统 API 把 Chrome 窗口置前：标签页被判定不可见时，抖音私信面板不会展开。
function foregroundChrome() {
  try {
    const { execSync } = require("child_process");
    execSync('powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'Chrome\')"', { stdio: "ignore", timeout: 15000 });
  } catch (error) {}
}

function patchItem(id, patch) {
  const cfg = readJson(CONFIG, {});
  const items = Array.isArray(cfg.pendingLeadItems) ? cfg.pendingLeadItems : [];
  const i = items.findIndex((x) => String(x && x.id) === String(id));
  if (i < 0) return null;
  items[i] = { ...items[i], ...patch, updatedAt: Date.now() };
  cfg.pendingLeadItems = items;
  writeJson(CONFIG, cfg);
  return items[i];
}

function nextItem() {
  const cfg = readJson(CONFIG, {});
  const items = Array.isArray(cfg.pendingLeadItems) ? cfg.pendingLeadItems : [];
  return items.find((x) => x && x.secUid && /^https:\/\/(www\.)?douyin\.com\/user\//i.test(String(x.profileUrl || "")) && !TERMINAL.includes(x.dmStatus || "queued"));
}

async function runOne(item) {
  const cfg = readJson(CONFIG, {});
  const template = String(item.template || cfg.template || "你好").trim();
  const text = template.split("{昵称}").join(String(item.user || "亲"));
  const task = {
    taskId: "live-dm-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8),
    leadId: String(item.id),
    user: item.user || "未知用户",
    secUid: item.secUid,
    profileUrl: item.profileUrl,
    avatarUrl: item.avatarUrl || "",
    room: item.room || "视频评论",
    comment: item.lastText || item.text || "",
    template,
    text,
    status: "opening_profile",
    reason: "",
    steps: [
      { key: "profile", label: "打开用户主页", status: "running" },
      { key: "dm", label: "点击私信", status: "pending" },
      { key: "prefill", label: "填入文案", status: "pending" },
      { key: "send", label: "自动发送", status: "pending" },
    ],
    startedAt: Date.now(),
  };
  const state = readJson(STATE, {});
  writeJson(STATE, { ...state, active: task, last: task, updatedAt: Date.now() });
  patchItem(item.id, { dmStatus: "opening_profile", dmReason: "正在打开主页与私信窗口", preparedText: text, taskId: task.taskId });

  foregroundChrome();
  await sleep(1500);
  log("开始私信:", task.user, "| 文案:", text);
  const out = fs.openSync(WORKER_LOG, "a");
  const child = spawn(process.execPath, [WORKER, String(item.id)], {
    cwd: WORKSPACE,
    env: { ...process.env, REPLY_WORKSPACE: WORKSPACE, REPLY_DEBUG_PORT: process.env.REPLY_DEBUG_PORT || "9222" },
    windowsHide: true,
    detached: false,
    stdio: ["ignore", out, out],
  });
  const started = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (child.exitCode !== null || Date.now() - started > WORKER_TIMEOUT_MS) { clearInterval(timer); resolve(); }
    }, 1000);
  });
  try { if (child.exitCode === null) child.kill(); } catch {}
  try { fs.closeSync(out); } catch {}

  const st = readJson(STATE, {});
  const active = st.active;
  const finished = active && String(active.leadId) === String(item.id) ? active : null;
  const status = finished ? finished.status : "unknown";
  if (finished && typeof finished.status === "string" && ACTIVE.includes(finished.status)) {
    // worker 退出但任务仍停在中间态：如实标记失败，避免谎报
    patchItem(item.id, { dmStatus: "failed", dmReason: "worker 退出但任务停在 " + finished.status });
    log("异常结束:", task.user, finished.status);
    return { ok: false, status: finished.status };
  }
  if (finished && finished.status === "sent") {
    log("已发送:", task.user, "|", finished.reason || "");
    return { ok: true, status: "sent" };
  }
  log("未发送:", task.user, "|", status, "|", (finished && finished.reason) || "");
  return { ok: false, status };
}

(async () => {
  log("DM_RUN_START 独立执行器", WORKSPACE, "| 单次上限:", MAX_PER_RUN || "不限", "| 间隔:", GAP_MS + "ms");
  let doneThisRun = 0;
  for (let i = 0; i < 200; i++) {
    const item = nextItem();
    if (!item) { log("没有待发送的私信任务了"); break; }
    const res = await runOne(item);
    doneThisRun++;
    if (MAX_PER_RUN > 0 && doneThisRun >= MAX_PER_RUN) { log("DM_RUN_LIMIT_REACHED 本次已处理 " + doneThisRun + " 条，按配置停止"); break; }
    await sleep(GAP_MS);
  }
  log("DM_RUN_END");
})().catch((e) => { log("FATAL", e.message); process.exit(1); });

