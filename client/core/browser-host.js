'use strict'

// client/core/browser-host.js
//
// 浏览器宿主 —— 全客户端**唯一**持有 CDP WebSocket 的模块。
//
// ─────────────────────────────────────────────────────────────
// 为什么必须独占（这是本文件存在的全部理由）
// ─────────────────────────────────────────────────────────────
// 旧代码 6 个脚本各自 `new CDP("ws://127.0.0.1:9222"...)`，多进程同时
// `Target.getTargets` 并争抢同一个标签页，结果是：
//   · 页面互相导航（A 任务把 B 任务的页面导走）
//   · `Page.navigate` 超时、任务卡在 sending
//   · `Network` 嗅探漏事件（多个监听者抢同一个响应体）
// 因此本模块把连接收敛为**每实例一条独占 WS**（plans/A §4.6），
// 其余模块一律经 `core/ipc.js` 请求这里的高层操作。
//
// ⚠️ 独占是**两层**保证，缺一不可：
//   1. 进程内：`BrowserHost` 对 (instanceDir, port) 注册表，重复创建直接抛错；
//   2. 跨进程：实例目录下的 `browser-host.lock`（`wx` 独占创建 + 失效回收）。
//      第二条不能省——调度器与 UI 是不同进程，两个进程各起一个 host
//      就等于把旧缺陷原样搬回来，只不过换了个文件名。
//
// ⚠️ 锁文件也属于**运行数据**，因此它的读写一律走 `client/host/store.js`，
//    本模块自己**不做任何文件写入**（AGENTS.md §2.9 单写者）。
//    一旦 core/ 自己 writeFileSync，就等于开了第二个写盘点，
//    而"单写者"这条约束只要有一个例外，后面人人都会觉得自己的场景是例外。
//
// ─────────────────────────────────────────────────────────────
// ⚠️ 容易忘记的细节（逐条都有代码对应）
// ─────────────────────────────────────────────────────────────
// · 启动 Chrome 必须带 `--disable-blink-features=AutomationControlled`。
//   否则浏览器带自动化指纹 → 商家**已经登录好的**抖音账号等于白搭，
//   而且会在最敏感的地方（登录态）触发风控。参见 shared/术语与选型基准.md §3.3。
// · `spawn` 必须 `detached:true` + `unref()`：客户端进程退出时
//   **不能**顺手杀掉商家的登录窗口。反之，Chrome 活着而客户端重启，
//   也应能直接接管已有连接（登录态在 profile 里，不在进程里）。
// · `stdio:'ignore'` 是**刻意**的：详见 `spawnChrome()` 的注释。
// · 搜索页必须用**新标签页**：长期复用的搜索标签会退化（加载不出结果）。
// · `Input.*` 事件要求标签页处于前台，所以每次点击/按键前都激活标签页；
//   激活失败**不得**被吞掉（旧代码把它吞了，然后把"标签页不在前台"
//   误报成"被风控拦截"，进而在计费口径上造成假失败）。
//
// ⚠️ 本文件对抖音一无所知：选择器、JS 表达式、URL 片段、接口片段
// 一律是**参数**。这里出现任何平台选择器字面量即缺陷。

const net = require('node:net')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const { Cdp, CdpError, ATTRIBUTION } = require('./cdp')
const { Store } = require('../host/store')

// ═══════════════════════════════════════════════════════════════
// 归因码（小写 snake_case：本地归因码，见 shared/开发规范.md §2.1）
// ═══════════════════════════════════════════════════════════════
const HOST_ATTRIBUTION = Object.freeze({
  /** 同一实例已存在 host（进程内或跨进程） */
  ALREADY_HOSTED: 'browser_host_already_exists',
  /** 端口被**非** Chrome 调试端点的程序占用 */
  PORT_OCCUPIED_BY_OTHER: 'debug_port_occupied_by_other',
  /** Chrome 未找到 */
  CHROME_NOT_FOUND: 'chrome_executable_not_found',
  /** Chrome 起来了但调试端口一直没就绪 */
  CHROME_NOT_READY: 'chrome_debug_port_not_ready',
  /** 目标标签页已消失 */
  TAB_GONE: 'tab_gone',
  /** 标签页已消失 —— **可重试：调用方应把任务退回 queued 而不是记 failed** */
  TAB_GONE_REQUEUE: 'tab_gone_requeue',
  /** 元素命中但尺寸为 0（隐藏结构误命中，见平台知识 §1.2） */
  ELEMENT_ZERO_SIZE: 'element_zero_size',
  /** 元素在超时窗口内未出现 */
  ELEMENT_NOT_FOUND: 'element_not_found',
  /** 点击后编辑器里的文本与预期不一致（输入丢失） */
  TYPE_VERIFY_FAILED: 'type_verify_failed',
  /** 节点稳定判定不成立 */
  NODE_NOT_STABLE: 'node_not_stable',
  /** 激活标签页到前台失败 */
  ACTIVATE_FAILED: 'tab_activate_failed',
  /** 传入的参数非法 */
  BAD_ARGS: 'browser_host_bad_args',
  /** 未知的 IPC 操作 */
  UNSUPPORTED_OP: 'unsupported_op',
})

/**
 * ⚠️ 标签页消失时的归因码单独命名，就是为了让调度器一眼看出
 * "这是可自愈的抖动，任务要**退回 queued**"。
 * plans/A §4.6 与 S-2（自愈率 ≥95%）都建立在这一点上：
 * 把可自愈的抖动记成 failed，会同时污染成功率口径并触发假熔断。
 */
const RETRYABLE_REQUEUE = HOST_ATTRIBUTION.TAB_GONE_REQUEUE

// ═══════════════════════════════════════════════════════════════
// 参数常量（都来自 legacy 实测，不是拍脑袋）
// ═══════════════════════════════════════════════════════════════
const CONST = Object.freeze({
  /** 新建标签页后的**固定首等**（legacy reply_worker.js:59 / pipeline.js:130 都是 1200ms） */
  TAB_CREATE_INITIAL_WAIT_MS: 1200,
  /** 新建标签页后的轮询：最多 20 次 × 500ms = 10s（legacy reply_worker.js:60 同） */
  TAB_CREATE_POLL_MAX: 20,
  TAB_CREATE_POLL_MS: 500,
  /** 启动 Chrome 后等调试端口的轮询：30 次 × 500ms = 15s */
  CHROME_READY_POLL_MAX: 30,
  CHROME_READY_POLL_MS: 500,
  /**
   * ⚠️ `scrollIntoView` 之后必须延迟再读坐标：评论区是虚拟列表，
   * 滚动触发重渲染，**同步读到的 rect 是 0×0**（平台知识 §2.1）。
   * legacy 用的是 1200ms；这里是"5 轮 × 300~500ms"的读坐标重试预算。
   */
  RECT_RETRY_ROUNDS: 5,
  RECT_RETRY_MIN_MS: 300,
  RECT_RETRY_MAX_MS: 500,
  /** 滚动后等虚拟列表重渲染（legacy reply_worker.js:254 的 sleep(1200)） */
  SCROLL_RERENDER_WAIT_MS: 1200,
  /** 鼠标 pressed 与 released 之间的抖动（legacy: 120~200ms） */
  CLICK_JITTER_MIN_MS: 120,
  CLICK_JITTER_MAX_MS: 200,
  /**
   * "节点稳定存在 ≥3000ms"（连续 3 次 1 秒轮询仍在且文本一致）
   * → 只能映射到 `sent_confirmed_dom`，**不是** `sent_confirmed`
   * （红线 2：计费必须来自平台响应体）。
   */
  NODE_STABLE_MS: 3000,
  NODE_STABLE_POLL_MS: 1000,
  /** 输入计划的分段停顿区间（plans/A §4.5：点击/输入前插 1~3 秒随机停顿） */
  TYPE_PAUSE_MIN_MS: 1000,
  TYPE_PAUSE_MAX_MS: 3000,
})

/** 业务角色。仅这三个，避免各处自定义字符串。 */
const ROLES = Object.freeze(['comment', 'live', 'profile'])

/** 跨进程独占锁的文件名（相对实例目录；经 store.file() 校验，不含路径分隔符）。 */
const LOCK_FILE = 'browser-host.lock'

/** 进程内独占注册表：`<instanceDir>|<port>` → BrowserHost */
const hosts = new Map()

function hostKey(instanceDir, port) {
  return `${path.resolve(instanceDir)}|${Number(port)}`
}

/**
 * 结构化宿主错误。归因码语义同 `CdpError.attribution`。
 * `retryable` 与 `requeue` 两个布尔量是给调度器看的：
 * `requeue=true` 表示"任务退回队列，别记 failed"。
 */
class BrowserHostError extends Error {
  constructor(attribution, message, detail) {
    super(message || attribution)
    this.name = 'BrowserHostError'
    this.attribution = attribution
    this.code = attribution
    this.detail = detail === undefined ? null : detail
    this.requeue = attribution === RETRYABLE_REQUEUE
      || attribution === ATTRIBUTION.SOCKET_CLOSED
      || attribution === ATTRIBUTION.CMD_TIMEOUT
      || attribution === HOST_ATTRIBUTION.ACTIVATE_FAILED
      || attribution === HOST_ATTRIBUTION.CHROME_NOT_READY
    this.retryable = this.requeue || attribution === HOST_ATTRIBUTION.ELEMENT_NOT_FOUND
  }

  toJSON() {
    return {
      attribution: this.attribution, message: this.message,
      requeue: this.requeue, retryable: this.retryable, detail: this.detail,
    }
  }
}

/** 把内部错误统一成 BrowserHostError（保留归因码，绝不吞掉）。 */
function toHostError(e, attribution, message) {
  if (e instanceof BrowserHostError) return e
  const code = (e && (e.attribution || e.code)) || attribution || 'browser_host_error'
  const err = new BrowserHostError(code, message || (e && e.message) || String(e), {
    cause: e && e.message ? e.message : undefined,
  })
  if (e && e.retryable !== undefined && err.retryable === false) err.retryable = Boolean(e.retryable)
  return err
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t.unref) t.unref()
  })
}

/** 随机化延迟：固定节奏是最容易被识别的机器人特征（AGENTS.md §2.11）。 */
function jitter(min, max) {
  if (max <= min) return min
  return Math.round(min + Math.random() * (max - min))
}

// ═══════════════════════════════════════════════════════════════
// 纯函数工具（可离线单测）
// ═══════════════════════════════════════════════════════════════

/**
 * 探测端口是否有程序在监听。
 * ⚠️ 用 `net.connect` 而不是外部命令（netstat/tasklist）：分发到商家机器上
 * 不能假设有额外工具；而且这个判断是**启动前置条件**，失败要快。
 * @returns {Promise<boolean>} true = 有程序在监听
 */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (listening, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      try {
        socket.destroy()
      } catch (e) {
        // ⚠️ destroy 一个已销毁的 socket 在极端竞态下会抛，属预期：
        //    但要留痕，否则"探测偶尔报错"无从解释。
        process.emitWarning(`probePort destroy 失败：${e && e.message}`, 'BrowserHostWarning')
      }
      if (err) reject(err)
      else resolve(listening)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    if (timer.unref) timer.unref()
    socket.once('connect', () => finish(true))
    socket.once('error', (e) => {
      // ECONNREFUSED = 端口空着（正常路径）；其他错误（EACCES 等）要暴露出来。
      if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) finish(false)
      else finish(false, e)
    })
    // ⚠️ 对端"接受连接后立刻关闭"（例如只做端口占位转发）时既不会 connect
    //    也不会 error，只有 close。不监听就会白等到超时才判 false——
    //    在启动路径上等于给每次启动加 800ms 无谓延迟。
    socket.once('close', () => finish(false))
  })
}

/** 取一段 HTTP JSON（Chrome 的 /json/* 端点）。只用内置 http，不引依赖。 */
function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = http.get(url, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}（${url}）`))
            return
          }
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            reject(new Error(`响应不是合法 JSON（${url}）：${e.message}`))
          }
        })
        res.on('error', (e) => reject(e))
      })
    } catch (e) {
      reject(e)
      return
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`请求超时（${timeoutMs}ms）：${url}`), { code: 'ETIMEDOUT' }))
    })
    req.on('error', (e) => reject(e))
  })
}

/**
 * 等一个"Chrome 调试端点"出现。
 *
 * ⚠️ 判定标准是 `/json/version` 返回了 `webSocketDebuggerUrl`。
 * 只看端口通不通是不够的：9222 可能被别的软件占用，
 * 那时贸然把 WS 连上去会得到一堆无法解释的协议错误。
 */
async function waitForDebugEndpoint(port, {
  attempts = CONST.CHROME_READY_POLL_MAX,
  intervalMs = CONST.CHROME_READY_POLL_MS,
  host = '127.0.0.1',
  getJsonImpl = getJson,
} = {}) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      const version = await getJsonImpl(`http://${host}:${port}/json/version`, 3000)
      if (version && version.webSocketDebuggerUrl) {
        return { ok: true, attempts: i + 1, version }
      }
      lastError = '响应里没有 webSocketDebuggerUrl（不是 Chrome 调试端点？）'
    } catch (e) {
      lastError = e && e.message ? e.message : String(e)
    }
    await sleep(intervalMs)
  }
  return { ok: false, attempts, lastError }
}

/**
 * 等某个 targetId 出现在 `Target.getTargets` 里。
 *
 * ⚠️ 先固定等 1200ms **再**轮询（legacy reply_worker.js:55-70 的协议）。
 * 直接用 `Target.createTarget` 的返回立刻 attach，在真机上会偶发失败：
 * 目标还没登记进 target 列表。
 */
async function waitForTarget({ listTargets, targetId, attempts = CONST.TAB_CREATE_POLL_MAX, intervalMs = CONST.TAB_CREATE_POLL_MS, initialWaitMs = CONST.TAB_CREATE_INITIAL_WAIT_MS, onTick = null }) {
  if (initialWaitMs > 0) await sleep(initialWaitMs)
  for (let i = 0; i < attempts; i++) {
    const targets = await listTargets()
    const hit = targets.find((t) => t.targetId === targetId && t.type === 'page')
    if (hit) return { ok: true, target: hit, attempts: i + 1 }
    if (onTick) onTick(i, targets)
    await sleep(intervalMs)
  }
  return { ok: false, attempts }
}

/**
 * 构造 Chrome 启动参数。
 *
 * ⚠️ 每一面旗子都有出处，**不得自行发明**：
 *   · `--user-data-dir`            → 每实例独立 profile，登录态在这里（术语与选型基准.md §2.1）
 *   · `--remote-debugging-port`    → plans/A §4.6 启动流程
 *   · `--disable-blink-features=AutomationControlled`
 *                                  → 术语与选型基准.md §3.3 / 开发规范.md「自动化指纹」
 *   · `--no-first-run` / `--no-default-browser-check` → legacy browser_session.js:152-153
 *   · `--start-maximized`          → legacy browser_session.js:155：商家要能看见窗口
 *                                    （验证码必须人工处理，窗口不可见 = 流程卡死）
 */
function buildChromeArgs({ profilePath, debugPort, startUrl, extraArgs }) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
  ]
  for (const a of extraArgs || []) args.push(String(a))
  // 起始页放最后（Chrome 把非旗子参数当作要打开的 URL）
  if (startUrl) args.push(String(startUrl))
  return args
}

/** 可见性判据（页面内使用的唯一一份，作为字符串常量注入 evaluate）。 */
const VISIBILITY_HELPER = `
var __vis = function (el, needViewport) {
  if (!el) return false;
  var r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  var s;
  try { s = window.getComputedStyle(el); } catch (e) { return false; }
  if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  if (needViewport && !(r.bottom >= 0 && r.top <= (window.innerHeight || 0))) return false;
  return true;
};
var __round = function (n) { return Math.round(n); };
`.trim()

/**
 * 生成"读取元素中心坐标"的表达式。
 *
 * ⚠️ 判据与 legacy reply_worker.js:83-92 完全一致（去空白后 rect 非零、
 * 与视口有交集、display/visibility 正常）。这里**额外**返回候选数量与
 * 选中信息，是为了"改版后能一眼看出是没命中还是一个都没可见"。
 */
function elementRectExpression(selector, { needViewport = false, scrollIntoView = false } = {}) {
  return `(function () {
  ${VISIBILITY_HELPER}
  var sel = ${JSON.stringify(String(selector))};
  var nodes = [];
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return JSON.stringify({ ok: false, bad_selector: true, reason: String(e && e.message || e) }); }
  var visible = [];
  for (var i = 0; i < nodes.length; i++) { if (__vis(nodes[i], ${needViewport ? 'true' : 'false'})) visible.push(nodes[i]); }
  var meta = { candidateCount: nodes.length, visibleCount: visible.length,
    scrollHeight: (document.scrollingElement ? document.scrollingElement.scrollHeight : 0),
    innerHeight: window.innerHeight || 0 };
  if (!visible.length) return JSON.stringify(Object.assign({ ok: false, found: false }, meta));
  var el = visible[0];
  ${scrollIntoView ? "try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 滚动失败不致命：后续仍会读一次坐标 */ }" : ''}
  var r = el.getBoundingClientRect();
  return JSON.stringify(Object.assign({
    ok: true, found: true,
    x: __round(r.x + r.width / 2), y: __round(r.y + r.height / 2),
    width: __round(r.width), height: __round(r.height),
    tag: el.tagName || '', text: String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
  }, meta));
})()`
}

/** 生成"在渲染容器内往下滚"的表达式（懒加载列表靠它把目标滚出来）。 */
function scrollExpression(selector, deltaY) {
  return `(function () {
  ${VISIBILITY_HELPER}
  var sel = ${JSON.stringify(String(selector))};
  var delta = ${Number(deltaY) || 0};
  var candidates = [];
  if (sel) { try { candidates = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { candidates = []; } }
  var container = null;
  for (var i = 0; i < candidates.length; i++) { if (__vis(candidates[i], false)) { container = candidates[i]; break; } }
  if (!container) {
    var all = Array.prototype.slice.call(document.querySelectorAll('*'));
    for (var j = 0; j < all.length; j++) {
      var r = all[j].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (all[j].scrollHeight <= all[j].clientHeight + 200) continue;
      var st;
      try { st = window.getComputedStyle(all[j]); } catch (e) { continue; }
      if (!st || (st.overflowY !== 'scroll' && st.overflowY !== 'auto')) continue;
      container = all[j];
      break;
    }
  }
  var before = 0, after = 0;
  if (container) {
    before = container.scrollTop;
    container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + delta);
    after = container.scrollTop;
  } else if (document.scrollingElement) {
    before = document.scrollingElement.scrollTop;
    document.scrollingElement.scrollTop = document.scrollingElement.scrollTop + delta;
    after = document.scrollingElement.scrollTop;
  }
  var rect = container ? container.getBoundingClientRect() : { x: 0, y: 0, width: window.innerWidth || 0, height: window.innerHeight || 0 };
  return JSON.stringify({
    ok: true, usedContainer: Boolean(container),
    x: __round(rect.x + rect.width / 2), y: __round(rect.y + rect.height / 2),
    before: before, after: after,
    atBottom: container ? (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) : true
  });
})()`
}

/** 生成"读回编辑器文本"的表达式（输入后必须回读校验，平台知识 §1.7）。 */
function readTextExpression(selector) {
  return `(function () {
  ${VISIBILITY_HELPER}
  var sel = ${JSON.stringify(String(selector))};
  var nodes = [];
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return JSON.stringify({ ok: false, bad_selector: true, text: '' }); }
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!__vis(el, false)) continue;
    var t = (el.value !== undefined && el.value !== null && String(el.value).length)
      ? String(el.value)
      : String(el.innerText || el.textContent || '');
    return JSON.stringify({ ok: true, text: t, length: t.length, tag: el.tagName || '', candidateCount: nodes.length });
  }
  return JSON.stringify({ ok: false, text: '', candidateCount: nodes.length });
})()`
}

/** 生成"节点存在且文本摘要"的表达式（稳定判定的采样点）。 */
function nodeSnapshotExpression(selector) {
  return `(function () {
  ${VISIBILITY_HELPER}
  var sel = ${JSON.stringify(String(selector))};
  var nodes = [];
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return JSON.stringify({ ok: false, bad_selector: true }); }
  var visible = 0, sample = '';
  for (var i = 0; i < nodes.length; i++) {
    if (!__vis(nodes[i], false)) continue;
    visible += 1;
    if (!sample) sample = String(nodes[i].innerText || nodes[i].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  }
  return JSON.stringify({ ok: visible > 0, visibleCount: visible, candidateCount: nodes.length, sample: sample });
})()`
}

/** 生成"页面就绪"探测表达式（⚠️ 不能靠 URL：/video/<id> 会被重定向）。 */
function readyStateExpression() {
  return `JSON.stringify({ readyState: document.readyState, hasBody: Boolean(document.body) })`
}

/**
 * 调用方给文本时的默认输入计划。
 *
 * ⚠️ 为什么不用 `Input.insertText` 一次性写入：`insertText` 不产生键盘事件，
 * 依赖 `keydown/keyup` 的富文本编辑器（DraftJS 类）收不到输入。
 * 这里按段生成 `{text, delayMs}`，由 `type()` 逐段用 `Input.dispatchKeyEvent`
 * 写入（带 `text` 的 keyDown 会真正插入字符并触发键盘事件），
 * 段间插入 1~3 秒随机停顿——固定节奏是机器人特征（AGENTS.md §2.11）。
 */
function defaultTypingPlan(text, { minPauseMs = CONST.TYPE_PAUSE_MIN_MS, maxPauseMs = CONST.TYPE_PAUSE_MAX_MS, segments } = {}) {
  const s = String(text === undefined || text === null ? '' : text)
  if (!s) return []
  const count = Math.max(1, Math.min(Number(segments) || 3, s.length))
  const size = Math.ceil(s.length / count)
  const plan = []
  for (let i = 0; i < s.length; i += size) {
    plan.push({ text: s.slice(i, i + size), delayMs: jitter(minPauseMs, maxPauseMs) })
  }
  return plan
}

// ═══════════════════════════════════════════════════════════════
// BrowserHost
// ═══════════════════════════════════════════════════════════════

class BrowserHost {
  /**
   * ⚠️ 请用 `await BrowserHost.create(opts)`，不要直接 new：
   * 构造函数不能 await 端口探测与 Chrome 启动。
   */
  constructor(opts, deps) {
    if (!opts || !opts.config) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'BrowserHost 需要 config（loadClientConfig 的结果）')
    const cfg = opts.config
    if (!cfg.instanceDir) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'config.instanceDir 缺失，请用 client/config.js 的 loadClientConfig()')
    if (!cfg.chromeProfilePath) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'config.chromeProfilePath 缺失')

    this.config = cfg
    this.instanceDir = cfg.instanceDir
    /** 调试端口基数 + N（多实例隔离，plans/A §4.8） */
    this.debugPort = Number(opts.debugPort || cfg.debugPortBase)
    if (!Number.isInteger(this.debugPort) || this.debugPort < 1 || this.debugPort > 65535) {
      throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, `调试端口非法：${this.debugPort}`)
    }
    this.chromePath = cfg.chromePath || null
    this.profilePath = cfg.chromeProfilePath
    this.logger = opts.logger || cfg.logger || null
    this.deps = deps

    this.key = hostKey(this.instanceDir, this.debugPort)
    this.lockPath = path.join(this.instanceDir, LOCK_FILE)
    this.lockAcquired = false
    /** 惰性创建、进程内复用的实例 Store（唯一写盘入口） */
    this._store = null
    this.chromeChild = null
    this.chromePid = null
    this.startedChrome = false
    this.closed = false

    /** 角色 → targetId */
    this.roles = new Map()
    /** 最近一次激活结果（纳入可观测量，不再像旧代码那样吞掉） */
    this.lastActivate = null

    this.cdp = null
  }

  /**
   * 创建并连接。
   * @param {object} opts 见构造函数；另支持
   *   · `debugPort`          覆盖端口（默认 config.debugPortBase）
   *   · `cdpFactory`         `(cdpOpts) => Cdp`（测试注入）
   *   · `spawnImpl`          `(cmd, args, opts) => child`（测试注入）
   *   · `probePortImpl` / `getJsonImpl` / `now`: 便于离线测试
   * @returns {Promise<BrowserHost>}
   */
  static async create(opts = {}) {
    const deps = {
      spawnImpl: opts.spawnImpl || spawn,
      probePortImpl: opts.probePortImpl || probePort,
      getJsonImpl: opts.getJsonImpl || getJson,
      cdpFactory: opts.cdpFactory || ((cdpOpts) => new Cdp(cdpOpts)),
      // ⚠️ 锁文件属于运行数据，读写一律经 store（唯一写盘者）。
      storeFactory: opts.storeFactory || ((dir) => new Store({ dir })),
      sleepImpl: opts.sleepImpl || sleep,
      now: opts.now || (() => Date.now()),
    }
    const host = new BrowserHost(opts, deps)
    try {
      await host.start()
    } catch (e) {
      // ⚠️ 启动失败必须把已经拿到的独占锁与进程内登记放掉，否则下一次启动
      //    会误报"已有 host 在运行"，把一次偶发失败变成永久故障。
      //    ⚠️ 但**不能**动别人的登记：close() 只在本次确实登记成功时才摘除
      //    （见 close() 末尾的同一性判断），否则会把同进程中真正活着的
      //    host 从注册表里摘掉，进程内独占随之失效。
      await host.close({ silent: true })
      throw toHostError(e)
    }
    return host
  }

  _log(level, event, detail) {
    if (!this.logger) return
    const fn = typeof this.logger[level] === 'function' ? this.logger[level] : this.logger.info
    if (typeof fn === 'function') fn.call(this.logger, event, detail)
  }

  // ── 启动 ────────────────────────────────────────────────────

  async start() {
    this.#claimInProcess()
    this.#claimCrossProcess()

    const port = this.debugPort
    const occupied = await this.deps.probePortImpl(port)

    if (occupied) {
      // ⚠️ 端口被占用**不等于**可以复用：可能是别的软件（或别的实例配错了端口）。
      //    只有确认它是 Chrome 调试端点才接管；否则大声失败，
      //    绝不能"默默连上去"然后在协议层报一堆无法解释的错。
      const probe = await waitForDebugEndpoint(port, {
        attempts: 1, intervalMs: 0, getJsonImpl: this.deps.getJsonImpl,
      })
      if (!probe.ok) {
        throw new BrowserHostError(
          HOST_ATTRIBUTION.PORT_OCCUPIED_BY_OTHER,
          `调试端口 ${port} 已被占用，但它不是 Chrome 调试端点（${probe.lastError}）。` +
          `请关闭占用该端口的程序，或为本实例指定另一个端口（config.debugPortBase / REPLY_DEBUG_PORT）。`,
          { port, last_error: probe.lastError }
        )
      }
      this.browserVersion = probe.version
      this._log('info', 'chrome_reused', { port, browser: probe.version.Browser || null })
    } else {
      await this.#spawnChrome()
      const probe = await waitForDebugEndpoint(port, { getJsonImpl: this.deps.getJsonImpl })
      if (!probe.ok) {
        throw new BrowserHostError(
          HOST_ATTRIBUTION.CHROME_NOT_READY,
          `已启动 Chrome，但调试端口 ${port} 在 ${Math.round(CONST.CHROME_READY_POLL_MAX * CONST.CHROME_READY_POLL_MS / 1000)} 秒内未就绪` +
          `（${probe.lastError}）。若 Chrome 窗口里提示"用户数据目录已被占用"，请先关闭其他实例的 Chrome。`,
          { port, last_error: probe.lastError }
        )
      }
      this.browserVersion = probe.version
      this._log('info', 'chrome_started', { port, pid: this.chromePid, browser: probe.version.Browser || null })
    }

    const wsUrl = this.browserVersion.webSocketDebuggerUrl
    this.cdp = this.deps.cdpFactory({
      url: wsUrl,
      logger: this.logger,
      timeoutMs: this.config.cdpCommandTimeoutMs,
    })
    this.cdp.onLifecycle('disconnected', (p) => {
      this._log('warn', 'browser_host_disconnected', { attribution: p.error && p.error.attribution, message: p.error && p.error.message })
    })
    this.cdp.onLifecycle('ready', () => {
      // ⚠️ 重连后必须让角色映射回到"未 attach"状态：cdp.js 已经 reset 了
      //    sessionId，这里同步清掉本层的 targetId 缓存会让存活检查白跑一遍，
      //    所以**保留 targetId**（targetId 跨连接稳定），只记一条日志。
      this._log('info', 'browser_host_reconnected', { roles: [...this.roles.keys()] })
    })
    await this.cdp.connect()
    return this
  }

  /** 进程内独占。 */
  #claimInProcess() {
    const existing = hosts.get(this.key)
    if (existing && existing !== this) {
      throw new BrowserHostError(
        HOST_ATTRIBUTION.ALREADY_HOSTED,
        `本实例（${this.instanceDir}，端口 ${this.debugPort}）已经有 BrowserHost 在运行。` +
        `同一个 Chrome 上开两条 CDP WebSocket 正是旧代码页面互相导航、Page.navigate 超时的根因；` +
        `请通过 core/ipc.js 请求已有的 host，而不要新建连接。`
      )
    }
    hosts.set(this.key, this)
  }

  /**
   * 跨进程独占（尽力而为）。
   *
   * ⚠️ 用 `wx`（独占创建，由 store.createExclusive 落地）而不是"先 exists 再写"：
   * 两步之间存在竞态，两个进程可以同时通过检查。`wx` 由操作系统保证原子性。
   * 读到旧锁时用 `process.kill(pid, 0)` 探活——进程没了就回收锁。
   *
   * ⚠️ 所有落盘都经 `client/host/store.js`，本模块不直接碰 fs 写接口。
   */
  #claimCrossProcess() {
    const store = this.#lockStore()
    const payload = JSON.stringify({
      pid: process.pid, port: this.debugPort, instance_dir: this.instanceDir, acquired_at_ms: this.deps.now(),
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      const r = store.createExclusive(LOCK_FILE, payload)
      if (r.ok) {
        this.lockAcquired = true
        return
      }
      if (r.reason !== 'exists') {
        // 不是"已存在"就是真错误（磁盘满/权限），必须抛出。
        throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS,
          `写独占锁失败（${this.lockPath}）：${r.code || ''} ${r.message || ''}`.trim(),
          { code: r.code || null })
      }

      const holder = store.readLock(LOCK_FILE)
      // readLock 在"不存在"与"损坏"两种情况下都返回 null。这里文件明明存在
      // （刚才是 EEXIST），所以 null 只能意味着**锁内容损坏**——必须留痕，
      // 不能静默当成"没有持有者"。
      if (holder === null) {
        this._log('warn', 'browser_host_lock_corrupt', {
          path: this.lockPath,
          hint: '锁文件存在但无法解析（可能是上次写入被中断），按失效锁回收',
        })
      }

      const holderPid = holder && Number(holder.pid)
      if (holderPid && holderPid !== process.pid && isProcessAlive(holderPid)) {
        throw new BrowserHostError(
          HOST_ATTRIBUTION.ALREADY_HOSTED,
          `实例 ${this.instanceDir} 已有进程 ${holderPid} 持有浏览器连接（端口 ${holder.port}）。` +
          `请通过 core/ipc.js 请求它，不要另建 CDP 连接——两条连接会让两个任务争抢同一个标签页。`,
          { holder_pid: holderPid, holder_port: holder.port }
        )
      }

      // 失效锁：回收（持有者进程已退出，或锁内容损坏且无法归属到活进程）
      this._log('warn', 'browser_host_lock_stale', { path: this.lockPath, holder_pid: holderPid || null })
      const rm = store.removeLock(LOCK_FILE)
      if (!rm.ok) {
        throw new BrowserHostError(HOST_ATTRIBUTION.ALREADY_HOSTED,
          `回收失效锁失败（${this.lockPath}）：${rm.code || ''} ${rm.message || ''}`.trim() +
          '。请确认没有其他实例进程后手动删除该文件再重试。')
      }
    }
    throw new BrowserHostError(HOST_ATTRIBUTION.ALREADY_HOSTED, `无法取得实例独占锁：${this.lockPath}`)
  }

  /**
   * 惰性创建并**复用**实例 Store。
   *
   * ⚠️ 必须复用而不是每次 new：`client/host/store.js` 有进程内单写者守卫
   * （同一目录打开两次直接抛错），重复 new 会把"防双写"的保护变成自伤。
   * ⚠️ Store 的构造函数会 `mkdirSync(instanceDir)`，所以实例目录的存在性
   * 由它保证，本模块无需也不应自己建目录。
   */
  #lockStore() {
    if (!this._store) this._store = this.deps.storeFactory(this.instanceDir)
    return this._store
  }

  /**
   * 拉起专用 Chrome。
   *
   * ⚠️ `detached:true` + `unref()` 的理由：Chrome 是**商家的登录窗口**，
   * 不是客户端进程的附属物。客户端崩溃/重启/升级时都不应该顺带把
   * 商家的浏览器关掉——那会让商家以为"工具把我的浏览器搞崩了"，
   * 而且每次重启都要重新登录（登录动作本身是风控最敏感的行为）。
   *
   * ⚠️ `stdio:'ignore'` 也是刻意的：本项目运行环境（含沙箱）中，
   * 用管道捕获子进程输出可能直接失败（EPERM），而 Chrome 的
   * stdout/stderr 对我们**没有任何用途**——所有需要的信息都通过
   * CDP 与 `/json/*` 端点拿。因此这里明确**不捕获**子进程 stdio，
   * 需要排障时看的是 CDP 侧的日志，而不是 Chrome 的控制台。
   */
  async #spawnChrome() {
    if (!this.chromePath) {
      throw new BrowserHostError(
        HOST_ATTRIBUTION.CHROME_NOT_FOUND,
        '未找到 Google Chrome。请安装 Chrome，或设置 REPLY_CHROME_PATH 指向 chrome.exe。'
      )
    }
    // ⚠️ 不自己建 profile 目录：Chrome 会用 `--user-data-dir` 指定的路径，
    //    目录不存在时它自己会创建。我们只需保证 instanceDir 存在，
    //    而这一点由 Store 的构造函数保证（见 #lockStore）。
    const args = buildChromeArgs({
      profilePath: this.profilePath,
      debugPort: this.debugPort,
      startUrl: this.startUrl || 'about:blank',
      extraArgs: this.config.chromeExtraArgs,
    })
    let child
    try {
      child = this.deps.spawnImpl(this.chromePath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (e) {
      throw new BrowserHostError(HOST_ATTRIBUTION.CHROME_NOT_FOUND, `启动 Chrome 失败：${e.message}`, {
        chrome_path: this.chromePath,
      })
    }
    // ⚠️ 必须挂 error 监听：spawn 失败（ENOENT/EACCES）是**异步**报的，
    //    不监听就变成未处理的 'error' 事件，直接把客户端进程打挂。
    child.on('error', (e) => {
      this._log('error', 'chrome_spawn_error', { attribution: HOST_ATTRIBUTION.CHROME_NOT_FOUND, message: e && e.message })
    })
    if (typeof child.unref === 'function') child.unref()
    this.chromeChild = child
    this.chromePid = child.pid === undefined ? null : child.pid
    this.startedChrome = true
    return child
  }

  // ── 标签页与角色 ────────────────────────────────────────────

  /** 浏览器级命令（**不带** sessionId）。 */
  send(method, params = {}, opts = {}) {
    if (!this.cdp) throw new BrowserHostError(HOST_ATTRIBUTION.CHROME_NOT_READY, 'CDP 尚未建立')
    return this.cdp.send(method, params, opts)
  }

  /** 当前所有 page 类型目标。⚠️ 绝不假设顺序：一律按 targetId 解析。 */
  async listTabs() {
    const r = await this.send('Target.getTargets', {})
    const infos = (r && r.targetInfos) || []
    return infos.map((t) => ({
      targetId: t.targetId,
      type: t.type,
      url: t.url,
      title: t.title,
      attached: Boolean(t.attached),
      role: this.roleOfTarget(t.targetId),
    }))
  }

  roleOfTarget(targetId) {
    for (const [role, id] of this.roles.entries()) if (id === targetId) return role
    return null
  }

  /**
   * 目标是否仍然存在（每次操作前的存活检查）。
   * ⚠️ 只是"在 Target.getTargets 里且 type=page"，**不**要求 attached：
   * 断线重连后 attached 会短暂为 false，那时判死会把好标签页全部重建。
   */
  async isTargetAlive(targetId) {
    const r = await this.send('Target.getTargets', {})
    const infos = (r && r.targetInfos) || []
    return infos.some((t) => t.targetId === targetId && t.type === 'page')
  }

  /**
   * 确保某个业务角色有一个可用标签页。
   *
   * @param {'comment'|'live'|'profile'|string} role
   * @param {string} url
   * @param {object} [opts]
   * @param {boolean} [opts.fresh] 强制新标签页
   *
   * ⚠️⚠️ `fresh:true` 对**搜索页**是硬要求，不是优化：
   * 长期复用的搜索标签会退化——页面还在、也不报错，但**加载不出结果**。
   * 这个失败模式极难归因（DOM 完全正常，只是列表永远为空），
   * 所以这里把它做成**行为**而不是文档约定：
   * `ensureTab(role, url, { fresh: true })` 会先关掉原标签页再新建，
   * 调用方不需要记得"搜索要新建"这件事。
   */
  async ensureTab(role, url, opts = {}) {
    if (typeof role !== 'string' || !role) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'ensureTab 需要 role')
    const existing = this.roles.get(role)
    const wantFresh = opts.fresh === true

    if (existing && !wantFresh) {
      const alive = await this.isTargetAlive(existing)
      if (alive) {
        const navigated = await this.#maybeNavigate(role, existing, url, opts)
        return { targetId: existing, reused: true, navigated, fresh: false }
      }
      // 目标没了：清掉映射并记一条（自愈路径必须可观测）
      this._log('warn', 'tab_gone_recreate', { role, target_id: existing })
      this.roles.delete(role)
      if (this.cdp.sessionIdOf(role)) this.cdp.detach(role)
    }

    if (existing && wantFresh) {
      // 新标签页先行、旧的后关：中间窗口宁可多一个标签页，
      // 也不要出现"旧已关、新未成"的空档。
      const created = await this.#createTab(role, url, opts)
      await this.closeTab(role, { silent: true }).catch(() => { /* 已捕获：closeTab 内部已留痕 */ })
      this.roles.set(role, created.targetId)
      this.cdp.registerSession(role, created.targetId, created.sessionId)
      return { targetId: created.targetId, reused: false, navigated: false, fresh: true }
    }

    const created = await this.#createTab(role, url, opts)
    this.roles.set(role, created.targetId)
    this.cdp.registerSession(role, created.targetId, created.sessionId)
    return { targetId: created.targetId, reused: false, navigated: false, fresh: true }
  }

  async #maybeNavigate(role, targetId, url, opts) {
    if (!url) return false
    const targets = await this.listTabs()
    const cur = targets.find((t) => t.targetId === targetId)
    if (cur && samePage(cur.url, url) && opts.forceNavigate !== true) return false
    await this.send('Page.navigate', { url }, { role, timeoutMs: opts.navigateTimeoutMs })
    return true
  }

  async #createTab(role, url, opts = {}) {
    const r = await this.send('Target.createTarget', { url: url || 'about:blank' }, { timeoutMs: opts.createTimeoutMs })
    const targetId = r && r.targetId
    if (!targetId) throw new BrowserHostError(HOST_ATTRIBUTION.TAB_GONE, 'Target.createTarget 未返回 targetId')

    // ⚠️ "先固定等 1200ms、再轮询最多 20×500ms"（legacy reply_worker.js:55-70）。
    //    创建即用会在真机上偶发失败：目标还没登记进 target 列表。
    const wait = await waitForTarget({
      listTargets: () => this.listTabs(),
      targetId,
      attempts: opts.pollMax || CONST.TAB_CREATE_POLL_MAX,
      intervalMs: CONST.TAB_CREATE_POLL_MS,
      initialWaitMs: opts.initialWaitMs === undefined ? CONST.TAB_CREATE_INITIAL_WAIT_MS : opts.initialWaitMs,
    })
    if (!wait.ok) {
      throw new BrowserHostError(HOST_ATTRIBUTION.TAB_GONE, `新标签页在等待窗口内未就绪（targetId=${targetId}）`, { targetId })
    }

    const sessionId = await this.cdp.attach(role, targetId)
    await this.cdp.enableResponseCapture(role)
    return { targetId, sessionId }
  }

  /**
   * 关闭某个角色的标签页。
   * ⚠️ 幂等：角色不存在时静默成功（调用方常在 cleanup 路径里盲调）。
   */
  async closeTab(role, opts = {}) {
    const targetId = this.roles.get(role)
    if (!targetId) return { closed: false, reason: 'role_not_found' }
    this.roles.delete(role)
    this.cdp.detach(role)
    try {
      await this.send('Target.closeTarget', { targetId })
      return { closed: true, targetId }
    } catch (e) {
      if (opts.silent) {
        this._log('warn', 'close_tab_failed', { attribution: (e && e.attribution) || HOST_ATTRIBUTION.TAB_GONE, role, targetId, message: e && e.message })
        return { closed: false, reason: 'close_failed', targetId }
      }
      throw toHostError(e, HOST_ATTRIBUTION.TAB_GONE, `关闭标签页失败（role=${role}）：${e && e.message}`)
    }
  }

  /**
   * 把标签页激活到前台。
   *
   * ⚠️ 为什么必须要：Enter 发送**要求标签页处于前台**（legacy reply_worker.js:122
   * 注释原话 "Enter-send requires active tab"）。旧代码把激活整段包在
   * `try{}catch(e){}` 里，激活失败后按键打空，最后报"可能被风控拦截"——
   * 把"标签页不在前台"误判成风控，进而触发错误的熔断。
   * 这里把结果**结构化返回**，让上层能单独归因。
   */
  async activateTab(role) {
    const targetId = await this.#resolveTarget(role)
    try {
      await this.send('Target.activateTarget', { targetId }, { timeoutMs: 8000 })
      this.lastActivate = { ok: true, role, targetId, atMs: this.deps.now() }
      return this.lastActivate
    } catch (e) {
      this.lastActivate = {
        ok: false, role, targetId, atMs: this.deps.now(),
        attribution: HOST_ATTRIBUTION.ACTIVATE_FAILED,
        message: (e && e.message) || String(e),
      }
      this._log('warn', 'tab_activate_failed', this.lastActivate)
      return this.lastActivate
    }
  }

  /**
   * 解析角色 → 存活 targetId。目标已消失时抛**可重排队**错误。
   *
   * ⚠️ 归因码 `tab_gone_requeue` + `requeue:true` 就是给调度器的指令：
   * **把任务退回 queued，不要记 failed**。这是 S-2 自愈率 ≥95% 的关键
   * （plans/A 关键决策 12：重启后队列任务退回 queued 而非 failed）。
   */
  async #resolveTarget(role) {
    const targetId = this.roles.get(role)
    if (!targetId) {
      throw new BrowserHostError(
        RETRYABLE_REQUEUE,
        `角色 ${role} 当前没有标签页，请先 ensureTab（任务应退回队列重试，不要记失败）`,
        { role }
      )
    }
    let alive = false
    try {
      alive = await this.isTargetAlive(targetId)
    } catch (e) {
      // 连接层错误（断线/超时）同样是"可重排队"，不能当成"标签页死了"。
      throw toHostError(e, RETRYABLE_REQUEUE, `存活检查失败（role=${role}）：${e && e.message}`)
    }
    if (!alive) {
      this.roles.delete(role)
      this.cdp.detach(role)
      throw new BrowserHostError(
        RETRYABLE_REQUEUE,
        `角色 ${role} 的标签页 ${targetId} 已消失（Chrome 重启 / 被手动关闭 / 页面崩溃）。` +
        `任务请退回 queued：重建标签页后重试通常即可成功。`,
        { role, targetId }
      )
    }
    return targetId
  }

  // ── 高层操作（IPC 暴露的就是这些） ──────────────────────────

  /**
   * 求值。JS 异常会以 `cdp_evaluate_exception` 归因码抛出（不是裸字符串）。
   * @returns {Promise<{value: any, type: string, raw: object}>}
   */
  async evaluate(role, expression, opts = {}) {
    await this.#resolveTarget(role)
    try {
      return await this.cdp.evaluate(role, expression, opts)
    } catch (e) {
      throw toHostError(e, ATTRIBUTION.EVALUATE_EXCEPTION)
    }
  }

  /** 求值并解析 JSON（页面侧 `JSON.stringify(...)` 的配套）。 */
  async evaluateJson(role, expression, opts = {}) {
    await this.#resolveTarget(role)
    try {
      return await this.cdp.evaluateJson(role, expression, opts)
    } catch (e) {
      throw toHostError(e, ATTRIBUTION.EVALUATE_EXCEPTION)
    }
  }

  /**
   * 轮询等待条件成立。
   * 超时错误带 `polls` 与 `last_value`——排障时直接回答
   * "是选择器彻底失效，还是时序不够"。
   */
  async waitFor(role, { expression, timeoutMs, pollMs } = {}) {
    if (!expression) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'waitFor 需要 expression')
    await this.#resolveTarget(role)
    try {
      return await this.cdp.waitFor(role, { expression, timeoutMs, pollMs })
    } catch (e) {
      throw toHostError(e, ATTRIBUTION.CMD_TIMEOUT)
    }
  }

  /** 页面是否加载完成（⚠️ 判据是 readyState，不是 URL——会被重定向）。 */
  async waitForPageReady(role, { timeoutMs = 30000, pollMs = 500 } = {}) {
    const r = await this.waitFor(role, {
      expression: `(function(){ return document.readyState === 'complete' && Boolean(document.body); })()`,
      timeoutMs,
      pollMs,
    })
    return r.value === true
  }

  /**
   * 点击一个选择器命中的元素。
   *
   * ── 为什么不是 `element.click()` ───────────────────────────
   * 合成点击（DOM 的 `.click()`）不带鼠标轨迹、没有 pressed/released 间隔、
   * `isTrusted=false`，是最容易被识别为自动化的行为之一；
   * 而且它绕过真实命中测试（点被遮挡的元素也会"成功"）。
   * 所以这里一律用 `Input.dispatchMouseEvent` 发真实鼠标事件。
   *
   * ── ⚠️ 为什么读坐标要重试 5 轮（每轮 300~500ms）──────────
   * `scrollIntoView()` 触发滚动后，**虚拟列表会重渲染**：同步读到的
   * `getBoundingClientRect()` 是 `0×0`（元素已被回收或换成新节点）。
   * 这正是 legacy 踩过的坑（reply_worker.js:250-255），它在滚动后
   * 固定 `sleep(1200)` 再读一次。这里把"等重渲染 → 重读"做成
   * 方法内部的固定预算：先滚动一次，之后每轮只读坐标、**不再滚动**
   * （反复滚动会让列表一直在重渲染，永远读不到稳定坐标）。
   * 5 轮全失败才抛 `element_zero_size`——它对应归因码
   * `ELEMENT_ZERO_SIZE`（隐藏结构误命中，plans/A 第 6 步）。
   */
  async click(role, selector, opts = {}) {
    if (!selector) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'click 需要 selector')
    const targetId = await this.#resolveTarget(role)

    // ⚠️ 输入事件前先激活标签页（Enter/鼠标事件要求前台）。
    const act = await this.activateTab(role)
    if (!act.ok && opts.requireForeground === true) {
      throw new BrowserHostError(HOST_ATTRIBUTION.ACTIVATE_FAILED,
        `标签页未能激活到前台（${act.message}），点击可能落空`, { role, targetId })
    }

    const rounds = opts.rounds || CONST.RECT_RETRY_ROUNDS
    let last = null
    for (let i = 0; i < rounds; i++) {
      // 第 1 轮带 scrollIntoView；之后只读（见上面的注释）。
      const expr = elementRectExpression(selector, { scrollIntoView: i === 0, needViewport: false })
      last = await this.evaluateJson(role, expr, { timeoutMs: opts.timeoutMs })
      if (last && last.ok && last.width > 0 && last.height > 0) {
        await this.cdp.dispatchMouseClick(role, last.x, last.y, {
          jitterMs: jitter(CONST.CLICK_JITTER_MIN_MS, CONST.CLICK_JITTER_MAX_MS),
          timeoutMs: opts.timeoutMs,
        })
        return {
          ok: true, x: last.x, y: last.y, width: last.width, height: last.height,
          tag: last.tag || null, candidate_count: last.candidateCount, round: i + 1,
          activated: act.ok,
        }
      }
      if (i < rounds - 1) await sleep(jitter(CONST.RECT_RETRY_MIN_MS, CONST.RECT_RETRY_MAX_MS))
    }

    // 区分两种失败：元素压根没命中 vs 命中了但尺寸为 0（隐藏结构）。
    const candidateCount = last && last.candidateCount ? last.candidateCount : 0
    if (candidateCount === 0) {
      throw new BrowserHostError(HOST_ATTRIBUTION.ELEMENT_NOT_FOUND,
        `选择器未命中任何元素：${selector}（rounds=${rounds}）`, { selector, rounds, candidate_count: 0 })
    }
    throw new BrowserHostError(HOST_ATTRIBUTION.ELEMENT_ZERO_SIZE,
      `元素命中但尺寸为 0（隐藏结构误命中，平台知识 §1.2）：${selector}` +
      `（候选 ${candidateCount} 个，已重试 ${rounds} 轮仍未拿到非零尺寸）`,
      { selector, rounds, candidate_count: candidateCount, last })
  }

  /**
   * 输入文本并**回读校验**。
   *
   * @param {string} role
   * @param {string} selector 编辑器选择器（用于回读）
   * @param {string} text
   * @param {object} [opts]
   * @param {Array<{text:string,delayMs:number}>} [opts.plan] 分段输入计划
   * @param {boolean} [opts.verify] 默认 true（plans/A 第 8 步要求回读）
   *
   * ⚠️ 逐段用 `Input.dispatchKeyEvent`（type:'keyDown' 带 text）而不是
   * `Input.insertText`：`insertText` 不产生键盘事件，DraftJS 类富文本
   * 编辑器收不到输入。段间 1~3 秒随机停顿——真人不会 200ms 打完一句话。
   */
  async type(role, selector, text, opts = {}) {
    if (!selector) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'type 需要 selector')
    await this.#resolveTarget(role)
    await this.activateTab(role)

    const full = String(text === undefined || text === null ? '' : text)
    const plan = Array.isArray(opts.plan) && opts.plan.length
      ? opts.plan
      : defaultTypingPlan(full, { minPauseMs: opts.minPauseMs, maxPauseMs: opts.maxPauseMs, segments: opts.segments })

    let typed = ''
    for (let i = 0; i < plan.length; i++) {
      const seg = plan[i]
      const segText = String(seg && seg.text !== undefined ? seg.text : '')
      if (segText) {
        // keyDown 带 text：Chrome 会真正把字符插入编辑器，并派发 keydown 事件。
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', text: segText, unmodifiedText: segText, key: segText,
        }, { role, timeoutMs: opts.timeoutMs })
      }
      typed += segText
      const delay = Number(seg && seg.delayMs)
      if (Number.isFinite(delay) && delay > 0 && i < plan.length - 1) await sleep(delay)
    }

    // ⚠️ 回读校验：不能拿"编辑器存在"替代"内容已写入"
    //    （平台知识 §1.7 的预填校验要求）。输入丢失在此处暴露，
    //    比等到"发送后没捕获到响应"再排查便宜得多。
    const readBack = await this.readText(role, selector, { timeoutMs: opts.timeoutMs })
    const actual = readBack.text || ''
    const expectNorm = normalizeForCompare(full)
    const actualNorm = normalizeForCompare(actual)
    const matched = expectNorm.length > 0 && actualNorm.includes(expectNorm)
    if (opts.verify !== false && !matched) {
      throw new BrowserHostError(HOST_ATTRIBUTION.TYPE_VERIFY_FAILED,
        `输入回读校验失败：编辑器内容与预期不一致（输入丢失）`,
        {
          selector,
          // ⚠️ 只回传长度与末尾片段，不回传原文（红线 3 隐私边界）。
          expected_len: full.length, actual_len: actual.length,
          actual_tail: actual.slice(-20), plan_segments: plan.length,
        })
    }
    return {
      ok: true, typed_len: typed.length, expected_len: full.length, actual_len: actual.length,
      matched, plan_segments: plan.length, read_back: opts.returnText === true ? actual : undefined,
    }
  }

  /** 读回某选择器命中的可见元素文本（输入校验/编辑器状态探测用）。 */
  async readText(role, selector, opts = {}) {
    if (!selector) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'readText 需要 selector')
    const r = await this.evaluateJson(role, readTextExpression(selector), { timeoutMs: opts.timeoutMs })
    return r || { ok: false, text: '' }
  }

  /**
   * Enter 发送。
   *
   * ⚠️⚠️ **Enter 是主路径，点击发送按钮只是兜底**（legacy reply_worker.js:385-400
   * 的顺序，平台知识 §1.5 明确要求不得颠倒）。这不是偏好问题：
   * 发送按钮的兜底定位依赖**硬编码品牌色**（写在选择器注册表里的
   * 最低置信度候选），一旦平台换肤/A-B 实验换色就静默失效，
   * 而它只在 Enter 失败后才执行，所以坏掉的表现是"偶发发送失败"，极难定位。
   * 三段式按键的三个细节（rawKeyDown / char 带 "\r" / vk=13）
   * 在 `cdp.js#pressEnterKey` 里，不能省任何一段。
   */
  async pressEnter(role, opts = {}) {
    await this.#resolveTarget(role)
    // ⚠️ 必须在前台：后台标签页收不到 Enter（平台知识 §2.4）。
    const act = await this.activateTab(role)
    if (!act.ok) {
      throw new BrowserHostError(HOST_ATTRIBUTION.ACTIVATE_FAILED,
        `标签页未能激活到前台，Enter 会打空（这不是风控！）：${act.message}`, { role })
    }
    await this.cdp.pressEnterKey(role, opts)
    return { ok: true, activated: true, atMs: this.deps.now() }
  }

  /**
   * 滚动（把懒加载的目标滚进视口 / 到底部）。
   * @param {object} p
   * @param {string} [p.selector] 滚动容器选择器（省略则自动找可滚容器）
   * @param {number} [p.deltaY]
   * @param {number} [p.times]
   */
  async scrollTo(role, { selector, deltaY = 2000, times = 1, waitMs = 0, timeoutMs } = {}) {
    await this.#resolveTarget(role)
    const times2 = Math.max(1, Math.min(Number(times) || 1, 200))
    const results = []
    for (let i = 0; i < times2; i++) {
      const info = await this.evaluateJson(role, scrollExpression(selector || '', deltaY), { timeoutMs })
      // 同时发一个真实滚轮事件：部分容器只响应 wheel（`scrollTop` 赋值被忽略）。
      // ⚠️ 坐标取容器中心（legacy 用 (900,500)/(1150,550)，那是注册表参数）。
      if (info && Number.isFinite(info.x) && Number.isFinite(info.y)) {
        await this.cdp.mouseWheel(role, { x: info.x, y: info.y, deltaY, opts: { timeoutMs } })
      }
      results.push(info)
      if (i < times2 - 1) await sleep(waitMs > 0 ? waitMs : 600)
    }
    return { times: times2, results, at_bottom: results.length ? Boolean(results[results.length - 1].atBottom) : false }
  }

  // ── 响应嗅探（发送成功判定的唯一证据来源） ──────────────────

  /**
   * 开始捕获平台响应。
   *
   * ⚠️ 只用 `Network` 域（纯监听），**绝不用 `Fetch` 域**：`Fetch.enable`
   * 会暂停请求，漏发 `Fetch.continueRequest` 就让页面永久挂起
   * ——那是商家的真实登录窗口（平台知识 §3.1）。
   *
   * @param {string} role
   * @param {object} [opts]
   * @param {string[]} [opts.urlPatterns] 关心的 URL 片段（仅用于日志标注，不用于过滤）
   * @returns {Promise<{markMs:number, urlPatterns:string[], network_enabled:boolean}>}
   */
  async startResponseCapture(role, { urlPatterns = [], clear = true } = {}) {
    await this.#resolveTarget(role)
    if (clear) this.cdp.clearCapturedResponses()
    await this.cdp.enableResponseCapture(role)
    const markMs = this.deps.now()
    this._log('info', 'response_capture_started', {
      role, url_patterns: urlPatterns, mark_ms: markMs, network_enabled: this.cdp.engineState.network_enabled,
    })
    return { markMs, urlPatterns, network_enabled: this.cdp.engineState.network_enabled, sessionId: this.cdp.sessionIdOf(role) }
  }

  /** 结束捕获。⚠️ 会等在途的取体落地，避免留下未处理的拒绝。 */
  async stopResponseCapture() {
    const drained = await this.cdp.drainBodyFetches()
    const captured = this.cdp.capturedResponses.length
    this._log('info', 'response_capture_stopped', { inflight_body_fetches: drained, captured_count: captured })
    return { drained, captured }
  }

  /**
   * 等一条匹配 `urlPattern` 的响应被完整捕获。
   *
   * ⚠️ 本层**不做成功判定**：哪个字段等于 0 才算成功是平台知识，
   * 属于 adapters（红线 2 的判定出口只有一个，放在适配器里）。
   * 本层保证的是"证据可得性"：拿到了就是拿到了，没拿到就明确报没拿到，
   * 并把最近捕获的 URL 一并回传（用于区分"真被风控"与"关键字写错"）。
   */
  async waitForResponse({ urlPattern, timeoutMs = 15000, pollMs = 100, sinceMs = 0, role = null } = {}) {
    if (!urlPattern) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'waitForResponse 需要 urlPattern')
    const sessionId = role ? this.cdp.sessionIdOf(role) : null
    try {
      return await this.cdp.waitForResponse({ urlPattern, timeoutMs, pollMs, sinceMs, sessionId })
    } catch (e) {
      throw toHostError(e, ATTRIBUTION.CMD_TIMEOUT)
    }
  }

  /** 已捕获的响应（副本）。 */
  capturedResponses() {
    return this.cdp.capturedResponses
  }

  /**
   * "节点存在且内容 ≥ stableMs 不变"的 DOM 判定。
   *
   * ⚠️⚠️ 这个结果**只能**映射到 `sent_confirmed_dom`（`confirm_signal=dom_stable`），
   * **绝不能**当作 `sent_confirmed`。红线 2 的计费资格要求
   * `confirm_signal === 'platform_response'`；DOM 稳定只证明"页面上有东西"，
   * 证明不了平台收了这条回复（页面崩溃/离线也会呈现"节点稳定"）。
   * 本方法在返回值里显式带上 `verdict_hint`，把这个口径钉在代码里，
   * 防止上层图省事直接当成成功。
   */
  async waitForNodeStable(role, {
    selector, stableMs = CONST.NODE_STABLE_MS, pollMs = CONST.NODE_STABLE_POLL_MS, timeoutMs,
  } = {}) {
    if (!selector) throw new BrowserHostError(HOST_ATTRIBUTION.BAD_ARGS, 'waitForNodeStable 需要 selector')
    await this.#resolveTarget(role)
    const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : stableMs + 10000
    const started = this.deps.now()
    let lastSample = null
    let sameSince = null
    let polls = 0
    for (;;) {
      polls += 1
      const snap = await this.evaluateJson(role, nodeSnapshotExpression(selector))
      const sig = snap && snap.ok ? `n=${snap.visibleCount}|t=${snap.sample}` : 'absent'
      if (sig !== 'absent' && sig === lastSample && sameSince === null) sameSince = this.deps.now()
      if (sig !== lastSample) {
        lastSample = sig
        sameSince = sig === 'absent' ? null : this.deps.now()
      }
      const stableFor = sameSince === null ? 0 : this.deps.now() - sameSince
      if (sameSince !== null && stableFor >= stableMs) {
        return {
          ok: true, stable_ms: stableFor, polls, snapshot: snap,
          verdict_hint: 'sent_confirmed_dom',
          confirm_signal: 'dom_stable',
          billable: false,
          note: 'DOM 稳定不是平台确认：不得作为 sent_confirmed 计费（红线 2）',
        }
      }
      if (this.deps.now() - started >= budget) break
      await sleep(Math.max(50, pollMs))
    }
    throw new BrowserHostError(HOST_ATTRIBUTION.NODE_NOT_STABLE,
      `节点在 ${budget}ms 内未达到 ${stableMs}ms 稳定（polls=${polls}，last=${lastSample}）`,
      { selector, polls, last_sample: lastSample, stable_ms: stableMs })
  }

  /** 状态快照（心跳上报/排障用）。 */
  engineState() {
    const cdp = this.cdp ? this.cdp.engineState : null
    return {
      instance_dir: this.instanceDir,
      debug_port: this.debugPort,
      chrome_pid: this.chromePid,
      started_chrome: this.startedChrome,
      chrome_alive: this.chromePid ? isProcessAlive(this.chromePid) : false,
      closed: this.closed,
      roles: Object.fromEntries(this.roles.entries()),
      role_count: this.roles.size,
      last_activate: this.lastActivate,
      cdp,
    }
  }

  /**
   * 关闭宿主。
   * ⚠️ 幂等、不抛（cleanup 路径会盲调）。
   * ⚠️ **不杀 Chrome**：它是商家的登录窗口，登录态在 profile 里。
   *    杀掉它等于让商家每次重启工具都要重新扫码登录，
   *    而"重新登录"恰是风控最敏感的动作。要停浏览器请由 UI 显式触发。
   */
  async close(opts = {}) {
    if (this.closed) return { closed: true, already_closed: true }
    this.closed = true
    try {
      if (this.cdp) {
        await this.cdp.drainBodyFetches()
        await this.cdp.close()
      }
    } catch (e) {
      if (!opts.silent) this._log('warn', 'cdp_close_failed', { message: e && e.message })
    }
    this.roles.clear()
    if (this.lockAcquired) {
      const rm = this._store
        ? this._store.removeLock(LOCK_FILE)
        : { ok: false, code: 'NO_STORE', message: 'store 未创建' }
      if (!rm.ok) {
        // ⚠️ 不吞：残留锁会让下次启动以为"已有 host"，必须留痕。
        this._log('warn', 'browser_host_lock_unlink_failed', {
          path: this.lockPath, code: rm.code || null, message: rm.message || null,
        })
      }
      this.lockAcquired = false
    }
    // ⚠️ 必须释放 store 的进程内登记：store.js 的 openStores 守卫会拒绝
    //    同一目录的第二次打开，不释放就等于"关掉 host 后永远无法再启动"。
    if (this._store) {
      try {
        this._store.close()
      } catch (e) {
        this._log('warn', 'store_close_failed', { message: e && e.message })
      }
      this._store = null
    }
    if (hosts.get(this.key) === this) hosts.delete(this.key)
    return { closed: true, chrome_left_running: Boolean(this.chromePid) }
  }
}

// ═══════════════════════════════════════════════════════════════
// IPC 操作表 —— 其余模块只能通过这些 op 请求浏览器
// ═══════════════════════════════════════════════════════════════
//
// ⚠️ 这些 op 是"进程间"的稳定接口（多个实例/调度器/UI 都走它），
//    因此：
//      · op 名与参数名一旦发布就不要随手改（属于跨进程契约）；
//      · 每个 op 的错误必须带 attribution，否则 IPC 失败无法归因；
//      · 不做业务判断（成功/失败判定在 adapters），只暴露证据与动作。
//
// op 一览（全部是抖音无关的：选择器/表达式/URL 片段都是参数）：
//   engine_state        → 状态快照
//   list_tabs           → 标签页列表（含角色）
//   ensure_tab          → { role, url, fresh } 确保角色标签页
//   close_tab           → { role }
//   activate_tab        → { role }
//   evaluate            → { role, expression, returnByValue, awaitPromise }
//   wait_for            → { role, expression, timeoutMs, pollMs }
//   wait_for_page_ready → { role, timeoutMs }
//   click               → { role, selector, rounds }
//   type                → { role, selector, text, plan, verify }
//   read_text           → { role, selector }
//   press_enter         → { role }
//   scroll_to           → { role, selector, deltaY, times }
//   start_capture       → { role, urlPatterns, clear }
//   stop_capture        → {}
//   wait_for_response   → { role, urlPattern, timeoutMs, sinceMs }
//   captured_responses  → {}
//   wait_for_node_stable→ { role, selector, stableMs, pollMs, timeoutMs }

const OPS = Object.freeze({
  engine_state: (host) => host.engineState(),
  list_tabs: (host) => host.listTabs(),
  ensure_tab: (host, a) => host.ensureTab(a.role, a.url, a),
  close_tab: (host, a) => host.closeTab(a.role, a),
  activate_tab: (host, a) => host.activateTab(a.role),
  evaluate: (host, a) => host.evaluate(a.role, a.expression, a),
  evaluate_json: (host, a) => host.evaluateJson(a.role, a.expression, a),
  wait_for: (host, a) => host.waitFor(a.role, a),
  wait_for_page_ready: (host, a) => host.waitForPageReady(a.role, a),
  click: (host, a) => host.click(a.role, a.selector, a),
  type: (host, a) => host.type(a.role, a.selector, a.text, a),
  read_text: (host, a) => host.readText(a.role, a.selector, a),
  press_enter: (host, a) => host.pressEnter(a.role, a),
  scroll_to: (host, a) => host.scrollTo(a.role, a),
  start_capture: (host, a) => host.startResponseCapture(a.role, a),
  stop_capture: (host) => host.stopResponseCapture(),
  wait_for_response: (host, a) => host.waitForResponse(a),
  captured_responses: (host) => host.capturedResponses(),
  wait_for_node_stable: (host, a) => host.waitForNodeStable(a.role, a),
})

/**
 * 执行一个 IPC 操作。
 *
 * ⚠️ 未知 op **返回结构化错误**而不是抛崩溃：IPC 两端版本可能短暂不一致
 * （升级过程中），一个不认识的 op 不该把整个宿主进程带走。
 *
 * @returns {Promise<{ok:true, result:any}|{ok:false, error:object}>}
 */
async function handleOp(host, op, args) {
  const fn = OPS[op]
  if (typeof fn !== 'function') {
    return {
      ok: false,
      error: {
        attribution: HOST_ATTRIBUTION.UNSUPPORTED_OP,
        message: `不支持的浏览器操作：${op}（可用：${Object.keys(OPS).join('/')}）`,
        detail: { op, supported: Object.keys(OPS) },
      },
    }
  }
  try {
    const result = await fn(host, args || {})
    return { ok: true, result: result === undefined ? null : result }
  } catch (e) {
    const he = toHostError(e)
    return { ok: false, error: he.toJSON() }
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════

/** 进程是否还活着（信号 0 只做存在性检查）。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH = 进程不存在（正常的"已退出"）；EPERM = 进程存在但无权限（也算活着）。
    if (e && e.code === 'EPERM') return true
    if (e && e.code === 'ESRCH') return false
    // 其他错误（如 Windows 上的 EINVAL）：保守判"活着"，避免误删别人正在用的锁。
    return true
  }
}

/**
 * 粗略的"同一个页面"判定。
 *
 * ⚠️ 只比 origin + pathname（忽略 query 与 hash）：视频页会被重定向成
 * `/jingxuan?modal_id=...`，用完整 URL 相等判定会**永远不相等**，
 * 于是每次 ensureTab 都重新导航（页面互相导航的经典成因）。
 * ⚠️ 域名比较用 hostname 边界（`new URL().hostname`），
 * 不用 `includes('域名')`——那会把 `evil-<domain>.attacker.cn` 也算命中
 * （旧代码缺陷 19）。
 */
function samePage(a, b) {
  if (!a || !b) return false
  const A = safeUrl(a)
  const B = safeUrl(b)
  if (!A || !B) return String(a) === String(b)
  const norm = (p) => (p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p)
  return A.hostname === B.hostname && norm(A.pathname) === norm(B.pathname)
}

function safeUrl(u) {
  try {
    return new URL(String(u))
  } catch (e) {
    // 不是合法 URL（about:blank、chrome://newtab 等）：返回 null，
    // 由调用方退化成字符串比较。不抛：URL 形态不可控，抛会把流程打断。
    return null
  }
}

/** 文本归一化（仅用于回读比较；匹配目标评论的归一化在平台层）。 */
function normalizeForCompare(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')     // ⚠️ 抖音大量使用 &nbsp;（平台知识 §4.1）
    .replace(/\s+/g, '')
}

module.exports = {
  BrowserHost,
  BrowserHostError,
  HOST_ATTRIBUTION,
  RETRYABLE_REQUEUE,
  ROLES,
  OPS,
  handleOp,
  CONST,
  hosts,
  hostKey,
  probePort,
  waitForDebugEndpoint,
  waitForTarget,
  buildChromeArgs,
  elementRectExpression,
  scrollExpression,
  readTextExpression,
  nodeSnapshotExpression,
  readyStateExpression,
  defaultTypingPlan,
  samePage,
  normalizeForCompare,
  isProcessAlive,
  getJson,
}
