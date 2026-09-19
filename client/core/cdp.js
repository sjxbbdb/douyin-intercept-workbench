'use strict'

// client/core/cdp.js
//
// 全项目**唯一**一份 CDP（Chrome DevTools Protocol）协议客户端。
//
// ─────────────────────────────────────────────────────────────
// 为什么必须有这个文件
// ─────────────────────────────────────────────────────────────
// 旧代码在 **6 个文件里各自复制了一份 `CDP` 类**
// （reply_worker.js:11-24、live_dom_collector.js:226-259、live_dm_worker.js:57-87、
//   pipeline.js:12-25、scan_comments.js:12-25、comment_worker.js:25-39、qr_capture.js:10-22），
// 于是 "6 个进程各自 `Target.getTargets` 并争抢同一个标签页" ——
// 页面互相导航、`Page.navigate` 超时、"标签页被抢走" 等一整套不稳定现象由此而来。
// 本项目把连接收敛为**每实例一条独占 WS**（plans/A §4.6），本文件是那条 WS 的协议层。
//
// 本文件是**传输层**：它对抖音一无所知。选择器、JS 表达式、URL 片段
// 一律由调用方以**参数**传入。⚠️ 这里出现任何平台选择器字面量、域名
// 或接口路径都是缺陷（AGENTS.md §3、平台知识 §6.4）。
//
// ─────────────────────────────────────────────────────────────
// ⚠️ 最容易忘记、代价最大的一条（本文件的头号存在理由）
// ─────────────────────────────────────────────────────────────
// WebSocket 断线重连之后，**必须重新 `Runtime.enable` / `Network.enable`**。
// CDP 的域启用状态绑定在**连接**上，不绑定在浏览器上：socket 一断，
// 之前发过的 enable 全部作废。忘记重发的表现是——
// 页面照常操作、日志一切正常，但 `Network.responseReceived` **永远不再上报**，
// 于是每一条回复都判定为"未捕获到平台响应"。按红线 2 的口径，
// 这只可能落到 `failed` / `sent_suspected`，而**实际是发出去了的**：
// 商家被多发少算（对账口径倒向商家不利），且没有任何报错提示。
// 所以 `#restoreAfterReconnect()` 是硬性的，不是优化项；
// test/unit/client-core.test.js 里有一条专门断言"重连后发出的帧包含这两个 enable"
// 的回归测试（旧缺陷 11：无重连、无心跳的 WebSocket）。
//
// ─────────────────────────────────────────────────────────────
// 另一条容易忘记的：socket 断掉时**在途命令必须被拒绝**
// ─────────────────────────────────────────────────────────────
// 旧代码的 `sendT` 只是 `Promise.race([send, timeout])`，超时后 pending 表里
// 仍然留着那个 promise，永远不会有结果。本实现于断线时**立即**以归因码
// `cdp_socket_closed` 拒绝所有在途命令，不给"悬着的 promise"任何存活空间
// （`pendingCount` 可观测，断线后必为 0）。

const ATTRIBUTION = Object.freeze({
  /** 连接建立失败（探活失败、端口不是调试端点等） */
  CONNECT_FAILED: 'cdp_connect_failed',
  /** 连接超时（Chrome 在超时窗口内没有完成握手） */
  CONNECT_TIMEOUT: 'cdp_connect_timeout',
  /** 单条命令超时 */
  CMD_TIMEOUT: 'cdp_cmd_timeout',
  /** 连接已显式 close，调用方仍在发命令 */
  CLOSED: 'cdp_closed',
  /** socket 断开时在途命令的统一归因（可重试） */
  SOCKET_CLOSED: 'cdp_socket_closed',
  /** socket 层 error 事件 */
  SOCKET_ERROR: 'cdp_socket_error',
  /** Chrome 返回了 CDP 协议级 error 对象 */
  PROTOCOL_ERROR: 'cdp_protocol_error',
  /** socket.send 同步抛错 */
  SEND_FAILED: 'cdp_send_failed',
  /** 收到无法解析的帧（协议层被破坏，不可静默忽略） */
  BAD_FRAME: 'cdp_bad_frame',
  /** `Runtime.evaluate` 里的页面 JS 抛了异常 */
  EVALUATE_EXCEPTION: 'cdp_evaluate_exception',
  /** `Network.getResponseBody` 取不到响应体（渲染器已回收 / 请求被取消） */
  BODY_UNAVAILABLE: 'cdp_body_unavailable',
  /** attach 目标失败 / 目标已消失 */
  ATTACH_FAILED: 'cdp_attach_failed',
  /** 缺少 `ws` 依赖（分发包里没有内置 node_modules/ws） */
  WS_MISSING: 'cdp_ws_missing',
})

/** 默认命令超时。契约要求"每个 CDP 命令设超时（默认 15 秒）"。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 15000
/**
 * `Page.navigate` 的超时。⚠️ 导航天然慢一个量级（首字节 + 整页加载），
 * 用 15 秒会在网络稍差时稳定误报失败，而失败又被计入环境类失败。
 * plans/A-工具链路开发指导.md §4.6 明确"默认 15 秒，Page.navigate 30 秒"。
 */
const NAVIGATE_TIMEOUT_MS = 30000
/** 导航重试时放大的超时（legacy reply_worker.js:130-138 的经验值 25s）。 */
const NAVIGATE_RETRY_TIMEOUT_MS = 25000
/** 重连指数退避的起点与上限（plans/A §4.6：1s/2s/4s/8s… 上限 60 秒）。 */
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 60000
/** 响应体缓存的环大小。⚠️ 只保留"最近"的，用于 `waitForResponse` 的迟到查询。 */
const DEFAULT_BODY_RING_SIZE = 64
/** 取响应体的超时。渲染器缓存随时可能回收，给得再长也没有意义。 */
const BODY_FETCH_TIMEOUT_MS = 8000
/** 重连后重新 enable 的超时。 */
const RESTORE_TIMEOUT_MS = 10000
/** 单帧上限：CDP 的响应体可能很大，但仍必须有个上限避免内存失控。 */
const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** 需要按方法名自动放大超时的方法表（键为 CDP 方法名）。 */
const TIMEOUT_BY_METHOD = Object.freeze({
  'Page.navigate': NAVIGATE_TIMEOUT_MS,
})

/**
 * 每个连接都必须重新启用的域。
 *
 * ⚠️ 顺序有意义：先 `Runtime.enable`（拿到 executionContext 事件），
 * 再 `Network.enable`（开始嗅探）。`Network.enable` 不带参数意味着
 * **不设缓冲上限**，即使用 Chrome 默认值；协议层不替调用方做取舍。
 */
const REQUIRED_DOMAINS = Object.freeze(['Runtime.enable', 'Network.enable'])

/**
 * 结构化 CDP 错误。
 *
 * ⚠️ 为什么不用裸 Error：上层（browser-host → IPC → 调度器）必须能按
 * **归因码**分支决定"重排任务"还是"记失败"。丢了 code 就只剩一句
 * 中文错误文案可读，归因统计（S-3）会整体失效。
 */
class CdpError extends Error {
  /**
   * @param {string} attribution 归因码（ATTRIBUTION 之一或调用方自定义的小写 snake_case）
   * @param {string} message     面向人的中文说明
   * @param {object} [detail]    结构化上下文（禁止塞原始页面文本）
   */
  constructor(attribution, message, detail) {
    super(message || attribution)
    this.name = 'CdpError'
    this.attribution = attribution
    this.code = attribution // 别名：调用方习惯读 `code`
    this.detail = detail === undefined ? null : detail
    // ⚠️ 可重试的判定放在错误对象上，避免每个上层各写一遍"哪些码可重试"。
    this.retryable = ![
      ATTRIBUTION.CLOSED,
      ATTRIBUTION.WS_MISSING,
      ATTRIBUTION.EVALUATE_EXCEPTION,
    ].includes(attribution)
  }

  toJSON() {
    return { attribution: this.attribution, message: this.message, detail: this.detail }
  }
}

/** 指数退避：1s / 2s / 4s / 8s … 上限 60s。attempt 从 1 开始。 */
function reconnectDelayMs(attempt, base = RECONNECT_BASE_DELAY_MS, max = RECONNECT_MAX_DELAY_MS) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  // ⚠️ 先夹再乘：直接算 2**n 在 n 很大时会变成 Infinity，
  //    `Math.min(Infinity, max)` 虽然也等于 max，但一旦有人把 max 传成 Infinity
  //    就会给 setTimeout 一个 Infinity → Node 发出 TimeoutOverflowWarning 并退化成 1ms，
  //    变成"疯狂重连"。这里显式封顶到 30 次方以内。
  const capped = Math.min(n, 30)
  return Math.min(base * 2 ** (capped - 1), max)
}

/** 解析某条命令实际使用的超时。 */
function resolveCommandTimeoutMs(method, opts = {}, config = {}) {
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) return Number(opts.timeoutMs)
  const perMethod = config.timeoutsByMethod && config.timeoutsByMethod[method]
  if (Number.isFinite(perMethod) && perMethod > 0) return Number(perMethod)
  const fallback = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? Number(config.timeoutMs)
    : DEFAULT_COMMAND_TIMEOUT_MS
  const byMethod = TIMEOUT_BY_METHOD[method]
  // ⚠️ 方法级默认值只在"调用方与配置都没给"时生效，且取**较大者**：
  //    调用方把全局超时调小（例如测试里设 200ms）不应让导航提前失败。
  return byMethod ? Math.max(byMethod, fallback) : fallback
}

/** 归一化 socket 的 message 负载（ws 的 Buffer / 浏览器 API 的 string / 数组） */
function toText(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d)))).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data && typeof data.toString === 'function') return data.toString()
  return String(data)
}

/** 把任意形态的 error 事件归一成一段可读文本（不吞掉原始信息）。 */
function describeErrorEvent(e) {
  if (!e) return 'unknown'
  if (e.message) return e.message
  if (e.error && e.error.message) return e.error.message
  if (e.code) return String(e.code)
  return String(e.type || e)
}

/**
 * 惰性加载 `ws`。
 *
 * ⚠️ 不在模块顶层 require：这样 (1) 本文件在没装依赖的环境里仍可被
 * `node --check` 与单元测试加载（本项目的离线测试注入假 socket）；
 * (2) 缺依赖时抛出的是带归因码的结构化错误，而不是一句
 * `Cannot find module 'ws'` —— 商家机器上"解压即用"的失败必须能自解释。
 */
function loadWs() {
  try {
    return require('ws')
  } catch (e) {
    throw new CdpError(
      ATTRIBUTION.WS_MISSING,
      '缺少依赖 ws（唯一允许的第三方依赖）。请确认分发包含 node_modules/ws，或执行 npm i ws。',
      { cause: e && e.message ? e.message : String(e) }
    )
  }
}

class Cdp {
  /**
   * @param {object} opts
   * @param {string} opts.url                  webSocketDebuggerUrl
   * @param {Function} [opts.createSocket]     注入式 socket 工厂 `(url) => socket`
   *                                           （测试用假 socket；生产用 `ws`）
   * @param {Function} [opts.WebSocket]        与 createSocket 二选一
   * @param {number} [opts.timeoutMs]          命令默认超时
   * @param {object} [opts.timeoutsByMethod]   按方法覆盖超时
   * @param {number} [opts.connectTimeoutMs]   建立连接的超时
   * @param {boolean} [opts.autoReconnect]     默认 true
   * @param {number} [opts.reconnectBaseMs]    退避基数（测试可调小）
   * @param {number} [opts.maxReconnectDelayMs]
   * @param {number} [opts.maxReconnectAttempts] 默认 Infinity
   * @param {boolean} [opts.enableRuntime]     默认 true
   * @param {boolean} [opts.enableNetwork]     默认 true
   * @param {number} [opts.bodyRingSize]
   * @param {object}  [opts.logger]            需实现 debug/info/warn/error
   */
  constructor(opts = {}) {
    if (!opts.url) throw new CdpError(ATTRIBUTION.CONNECT_FAILED, 'Cdp 需要 webSocketDebuggerUrl')
    if (!opts.createSocket && !opts.WebSocket) {
      // 生产路径：惰性取 ws。⚠️ 这里就取一次并缓存，避免每帧都 require。
      const WS = loadWs()
      this.createSocket = (url) => new WS(url)
    } else {
      this.createSocket = opts.createSocket
        || ((url) => new opts.WebSocket(url))
    }

    this.url = opts.url
    this.logger = opts.logger || null
    this.config = {
      timeoutMs: opts.timeoutMs,
      timeoutsByMethod: opts.timeoutsByMethod || null,
    }
    this.connectTimeoutMs = Number(opts.connectTimeoutMs) > 0
      ? Number(opts.connectTimeoutMs)
      : DEFAULT_COMMAND_TIMEOUT_MS
    this.autoReconnect = opts.autoReconnect !== false
    this.reconnectBaseMs = Number(opts.reconnectBaseMs) > 0 ? Number(opts.reconnectBaseMs) : RECONNECT_BASE_DELAY_MS
    this.maxReconnectDelayMs = Number(opts.maxReconnectDelayMs) > 0
      ? Number(opts.maxReconnectDelayMs)
      : RECONNECT_MAX_DELAY_MS
    this.maxReconnectAttempts = Number.isFinite(opts.maxReconnectAttempts)
      ? Number(opts.maxReconnectAttempts)
      : Infinity
    this.enableRuntime = opts.enableRuntime !== false
    this.enableNetwork = opts.enableNetwork !== false
    this.bodyRingSize = Number(opts.bodyRingSize) > 0 ? Number(opts.bodyRingSize) : DEFAULT_BODY_RING_SIZE

    /** 单调递增的命令 id */
    this._nextId = 1
    /** id → { resolve, reject, timer, method, sessionId, atMs } */
    this._pending = new Map()
    /** eventName → { id, handler, sessionId, once }[] */
    this._eventListeners = new Map()
    /** 生命周期监听器（state / ready / closed） */
    this._lifecycleListeners = new Map()
    /** 角色名 → { role, targetId, sessionId } */
    this._sessions = new Map()
    /** 原子化状态变更：串行执行，避免并发 connect/close 交叉 */
    this._chain = Promise.resolve()

    this._socket = null
    this._timer = null
    this._intent = 'active'      // active | closed
    this._state = 'closed'
    this._connectAttempt = 0
    this._reconnectAttempt = 0
    this._lastError = null
    this._connecting = null
    this._readyWaiters = []
    this._closedEmitted = false

    /** 是否已启用 Network 域（重连后会重置为 false） */
    this._networkEnabled = false
    /** 是否已启用 Runtime 域 */
    this._runtimeEnabled = false
    /**
     * 响应体环。⚠️ 只放**已解码的响应体**，是"发送成功判定"的唯一证据来源
     * （红线 2：DOM 判断不算）。取体的时机见 `#onLoadingFinished`。
     */
    this._bodyRing = []
    /** 已捕获条目的累计数（单调递增；环 shift 不会让它回退） */
    this._bodySeq = 0
    /** requestId → { requestId, url, method, status, ... } */
    this._inflight = new Map()
    /** 正在取响应体的 promise（close/stop 时必须等它们落地，否则会产生未处理拒绝） */
    this._bodyFetches = new Set()

    this._wireNetworkCapture()
    // 立即发起首次连接；调用方无需 await（send 会等 ready）。
    this._spawn(() => this._connect('initial'))
  }

  // ═══════════════════════════════════════════════════════════
  // 生命周期：连接 / 重连 / 关闭
  // ═══════════════════════════════════════════════════════════

  /** 把状态变更串行化（Promise 链），避免并发 connect/close 交叉执行。 */
  _spawn(fn) {
    this._chain = this._chain.then(fn).catch((e) => {
      // ⚠️ 绝不吞掉：这里能到的只有"本不该抛"的内部异常。
      this._log('error', 'cdp_internal_chain_error', {
        attribution: ATTRIBUTION.CONNECT_FAILED,
        message: e && e.message ? e.message : String(e),
        stack: e && e.stack ? e.stack : null,
      })
      this._emitState('error', { error: e })
    })
    return this._chain
  }

  _log(level, event, detail) {
    if (!this.logger) return
    const fn = typeof this.logger[level] === 'function' ? this.logger[level] : this.logger.info
    if (typeof fn === 'function') fn.call(this.logger, event, detail)
  }

  _emitState(state, extra) {
    this._state = state
    const payload = { state, attempt: this._connectAttempt, reconnect_attempt: this._reconnectAttempt, ...(extra || {}) }
    for (const rec of this._lifecycleListeners.get('state') || []) {
      this._safeCall(rec.handler, payload)
    }
  }

  _emitLifecycle(name, payload) {
    for (const rec of this._lifecycleListeners.get(name) || []) {
      this._safeCall(rec.handler, payload)
    }
  }

  /** 监听器抛错绝不能打断协议处理（否则一个坏监听器会毁掉整条连接）。 */
  _safeCall(handler, payload, meta) {
    try {
      handler(payload, meta)
    } catch (e) {
      this._log('error', 'cdp_listener_threw', {
        attribution: ATTRIBUTION.BAD_FRAME,
        message: e && e.message ? e.message : String(e),
      })
    }
  }

  /** 状态快照（可观测：engine_state / pendingCount / 会话与响应体计数） */
  get engineState() {
    return {
      state: this._state,
      connected: this._state === 'open',
      url: this.url,
      connect_attempt: this._connectAttempt,
      reconnect_attempt: this._reconnectAttempt,
      pending_count: this._pending.size,
      runtime_enabled: this._runtimeEnabled,
      network_enabled: this._networkEnabled,
      session_count: this._sessions.size,
      body_ring_count: this._bodyRing.length,
      last_error: this._lastError,
      closed: this._intent === 'closed',
    }
  }

  /** 在途命令数。⚠️ 断线后必须为 0（回归断言点）。 */
  get pendingCount() {
    return this._pending.size
  }

  /** 当前是否可用（已连接且未被显式关闭）。 */
  get isConnected() {
    return this._state === 'open' && this._intent === 'active'
  }

  /**
   * 显式连接。构造时已自动发起，本方法用于测试与重试。
   * @returns {Promise<void>} 连接可用（含重连后的重新 enable）后 resolve
   */
  connect() {
    this._intent = 'active'
    this._closedEmitted = false
    if (this.isConnected) return Promise.resolve()
    this._spawn(() => this._connect(this._socket ? 'reconnect' : 'initial'))
    return this.waitReady()
  }

  /**
   * 等待连接可用。
   * ⚠️ 有超时：不允许出现"等一个永远不会来的连接"。
   */
  waitReady(timeoutMs) {
    if (this.isConnected) return Promise.resolve()
    if (this._intent === 'closed') {
      return Promise.reject(new CdpError(ATTRIBUTION.CLOSED, 'CDP 连接已关闭，无法等待就绪'))
    }
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.connectTimeoutMs
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this._readyWaiters = this._readyWaiters.filter((w) => w !== waiter)
        reject(new CdpError(ATTRIBUTION.CONNECT_TIMEOUT, `等待 CDP 连接就绪超时（${limit}ms）`, {
          url: this.url, state: this._state, attempt: this._connectAttempt,
        }))
      }, limit)
      if (waiter.timer.unref) waiter.timer.unref()
      this._readyWaiters.push(waiter)
    })
  }

  _flushReadyWaiters() {
    const waiters = this._readyWaiters
    this._readyWaiters = []
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve()
    }
  }

  _rejectReadyWaiters(err) {
    const waiters = this._readyWaiters
    this._readyWaiters = []
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(err)
    }
  }

  async _connect(kind) {
    if (this._intent === 'closed') return
    if (this._socket) return // 已有连接（或正在关闭）

    this._connectAttempt += 1
    if (kind !== 'reconnect') this._emitState('connecting', {})
    else this._emitState('reconnecting', { delay_ms: 0 })

    let socket
    try {
      socket = this.createSocket(this.url)
    } catch (e) {
      this._lastError = { attribution: ATTRIBUTION.CONNECT_FAILED, message: e && e.message ? e.message : String(e) }
      this._emitState('error', { error: this._lastError })
      this._scheduleReconnect(new CdpError(ATTRIBUTION.CONNECT_FAILED, `建立 CDP 连接失败：${this._lastError.message}`, { url: this.url }))
      return
    }

    this._socket = socket
    this._runtimeEnabled = false
    this._networkEnabled = false

    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this._log('warn', 'cdp_connect_timeout', { url: this.url, timeout_ms: this.connectTimeoutMs })
        // 超时的 socket 必须主动关掉，否则它可能稍后自己 open，
        // 而那时我们已经把它当失败处理了（出现"幽灵连接"）。
        this._teardownSocket(new CdpError(ATTRIBUTION.CONNECT_TIMEOUT, `CDP 连接超时（${this.connectTimeoutMs}ms）`, { url: this.url }))
        finish()
      }, this.connectTimeoutMs)
      if (timer.unref) timer.unref()

      this._bind(socket, {
        onOpen: () => {
          finish()
          this._onOpen(socket)
        },
        onClose: (info) => {
          finish()
          this._onSocketGone(socket, new CdpError(
            ATTRIBUTION.SOCKET_CLOSED,
            'CDP WebSocket 已断开（in-flight 命令已全部拒绝，任务应退回队列重试）',
            { url: this.url, code: info && info.code, reason: info && info.reason }
          ))
        },
        onError: (e) => {
          this._lastError = { attribution: ATTRIBUTION.SOCKET_ERROR, message: describeErrorEvent(e) }
          finish()
          this._onSocketGone(socket, new CdpError(ATTRIBUTION.SOCKET_ERROR, `CDP WebSocket 错误：${this._lastError.message}`, { url: this.url }))
        },
      })
    })
  }

  /** 绑定 socket 事件（兼容 ws 的 on()/once() 与浏览器风格 addEventListener）。 */
  _bind(socket, handlers) {
    const on = (name, fn) => {
      if (typeof socket.addEventListener === 'function') socket.addEventListener(name, fn)
      else if (typeof socket.on === 'function') socket.on(name, fn)
      else throw new CdpError(ATTRIBUTION.CONNECT_FAILED, `socket 不支持事件绑定（缺少 on/addEventListener）`)
    }
    on('open', () => handlers.onOpen())
    on('close', (a, b) => {
      // ws: close(code, reason)；浏览器: close(CloseEvent)
      const info = (a && typeof a === 'object') ? { code: a.code, reason: a.reason } : { code: a, reason: b }
      handlers.onClose(info)
    })
    on('error', (e) => handlers.onError(e))
    on('message', (data) => this._onMessage(data))
  }

  _onOpen(socket) {
    if (socket !== this._socket) return // 迟到的 open（已被 teardown 的旧 socket）
    this._reconnectAttempt = 0
    this._emitState('open', {})
    this._log('info', 'cdp_connected', { url: this.url, attempt: this._connectAttempt })
    // ⚠️ 顺序：先恢复域与会话，再放行等待者。
    //    若先放行，调用方会在 Runtime/Network 尚未 enable 时发命令，
    //    那一刻发出去的点击/输入可能已经产生响应，而嗅探还没开始
    //    → "请求已发出但没捕获到" → 误判 failed（红线 2 的计费口径）。
    this._spawn(async () => {
      try {
        await this._restoreAfterReconnect()
        this._flushReadyWaiters()
        this._emitLifecycle('ready', { reconnected: this._connectAttempt > 1 })
      } catch (e) {
        this._log('error', 'cdp_restore_after_reconnect_failed', {
          attribution: (e && e.attribution) || ATTRIBUTION.PROTOCOL_ERROR,
          message: e && e.message ? e.message : String(e),
        })
        this._emitState('error', { error: { attribution: (e && e.attribution) || ATTRIBUTION.PROTOCOL_ERROR, message: e && e.message } })
        // ⚠️ 不重连：socket 是好的，坏的只是域未启用。但**也不能放行**
        //    等待者——放行等于让调用方在"嗅探没开"的状态下发送。
        this._rejectReadyWaiters(e instanceof CdpError ? e : new CdpError(ATTRIBUTION.PROTOCOL_ERROR, String(e && e.message)))
      }
    })
  }

  /**
   * ⚠️⚠️ 重连后的恢复动作 —— 本文件最不能省的一段。
   *
   * 1. 重新 `Runtime.enable` / `Network.enable`（域状态绑定在连接上）；
   * 2. 重新 attach 之前登记过的业务标签页（flatten session 也是连接级的，
   *    断线后旧 sessionId 全部失效）。
   *
   * 不做第 1 步：响应嗅探静默停止，所有发送被判为"未捕获到平台响应"，
   *            按红线 2 只能记 failed/sent_suspected —— 商家多发少算。
   * 不做第 2 步：重连后第一次操作会报 session 不存在，
   *            表现为"Chrome 明明还在跑，但每个任务都失败"。
   */
  async _restoreAfterReconnect() {
    // 会话先失效：旧 sessionId 在断线后必然不被 Chrome 认识。
    for (const rec of this._sessions.values()) rec.sessionId = null

    if (this.enableRuntime) {
      await this.send('Runtime.enable', {}, { timeoutMs: RESTORE_TIMEOUT_MS })
      this._runtimeEnabled = true
    }
    if (this.enableNetwork) {
      await this.send('Network.enable', {}, { timeoutMs: RESTORE_TIMEOUT_MS })
      this._networkEnabled = true
    }
    this._log('debug', 'cdp_domains_reenabled', {
      runtime: this._runtimeEnabled, network: this._networkEnabled,
    })

    // 重新 attach 已知角色对应的 target（targetId 本身跨连接稳定）。
    const roles = [...this._sessions.values()].filter((r) => r.targetId)
    for (const rec of roles) {
      try {
        const r = await this.send('Target.attachToTarget', { targetId: rec.targetId, flatten: true }, { timeoutMs: RESTORE_TIMEOUT_MS })
        rec.sessionId = r && r.sessionId ? r.sessionId : null
      } catch (e) {
        // ⚠️ 不吞：目标可能已被关闭，上层在下次操作时会做存活检查并重建标签页。
        rec.sessionId = null
        this._log('warn', 'cdp_reattach_failed', {
          attribution: (e && e.attribution) || ATTRIBUTION.ATTACH_FAILED,
          role: rec.role,
          target_id: rec.targetId,
          message: e && e.message ? e.message : String(e),
        })
      }
    }
  }

  /** socket 断了/错了：拒绝在途命令，清理状态，安排重连。 */
  _onSocketGone(socket, err) {
    if (socket !== this._socket) return // 旧 socket 的迟到事件
    const pending = this._pending.size
    this._teardownSocket(err)
    // ⚠️ 在途命令必须**立即**被拒绝。悬着的 promise = 任务卡在 sending 态，
    //    而调度器只能靠超时兜底——那时商家界面上什么都不显示。
    this._rejectAllPending(err)
    this._networkEnabled = false
    this._runtimeEnabled = false
    for (const rec of this._sessions.values()) rec.sessionId = null
    if (pending > 0) {
      this._log('warn', 'cdp_pending_rejected_on_disconnect', {
        attribution: err.attribution, count: pending,
      })
    }
    this._emitLifecycle('disconnected', { error: { attribution: err.attribution, message: err.message } })
    this._emitState('closed', { error: { attribution: err.attribution, message: err.message } })
    this._scheduleReconnect(err)
  }

  /** 只解开当前 socket 的引用并尽力关闭它（不触碰 pending / 不安排重连）。 */
  _teardownSocket(err) {
    const socket = this._socket
    this._socket = null
    if (!socket) return
    try {
      socket.close()
    } catch (e) {
      // ⚠️ 关一个已经死掉的 socket 会抛，这是预期内的：
      //    但要留痕，否则"为什么重连前多了一次 close 报错"无从排查。
      this._log('debug', 'cdp_socket_close_threw', {
        attribution: ATTRIBUTION.SOCKET_ERROR,
        message: e && e.message ? e.message : String(e),
      })
    }
    if (err) this._lastError = { attribution: err.attribution, message: err.message }
  }

  _scheduleReconnect(err) {
    if (this._intent === 'closed') return
    if (!this.autoReconnect) {
      this._rejectReadyWaiters(err)
      this._emitLifecycle('give_up', { reason: 'autoReconnect_disabled', error: { attribution: err.attribution, message: err.message } })
      return
    }
    if (this._timer) return // 已有计划中的重连
    if (this._reconnectAttempt >= this.maxReconnectAttempts) {
      const giveUp = new CdpError(ATTRIBUTION.SOCKET_CLOSED, `CDP 重连次数已达上限（${this.maxReconnectAttempts}），放弃重连`, { url: this.url })
      this._rejectReadyWaiters(giveUp)
      this._emitLifecycle('give_up', { reason: 'max_attempts', error: { attribution: err.attribution, message: err.message } })
      return
    }

    this._reconnectAttempt += 1
    const delay = reconnectDelayMs(this._reconnectAttempt, this.reconnectBaseMs, this.maxReconnectDelayMs)
    this._log('warn', 'cdp_reconnect_scheduled', {
      attribution: err.attribution, attempt: this._reconnectAttempt, delay_ms: delay,
    })
    this._emitState('reconnecting', { delay_ms: delay, error: { attribution: err.attribution, message: err.message } })

    const timer = setTimeout(() => {
      this._timer = null
      this._spawn(() => this._connect('reconnect'))
    }, delay)
    // ⚠️ unref：重连定时器不应阻止进程退出（客户端可能正在被关闭）。
    if (timer.unref) timer.unref()
    this._timer = timer
  }

  /** 拒绝所有在途命令。归因码固定为传入的 err（默认 cdp_socket_closed）。 */
  _rejectAllPending(err) {
    const entries = [...this._pending.values()]
    this._pending.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
    return entries.length
  }

  /**
   * 关闭连接。**幂等、不抛**。
   * ⚠️ 语义是"永久关闭"：会停掉自动重连。恢复请用 `connect()`。
   */
  close() {
    this._intent = 'closed'
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    const err = new CdpError(ATTRIBUTION.CLOSED, 'CDP 连接已被显式关闭')
    this._teardownSocket(null)
    this._rejectAllPending(err)
    this._rejectReadyWaiters(err)
    this._sessions.clear()
    this._eventListeners.clear()
    this._bodyRing = []
    this._inflight.clear()
    this._networkEnabled = false
    this._runtimeEnabled = false
    this._emitState('closed', {})
    if (!this._closedEmitted) {
      this._closedEmitted = true
      this._emitLifecycle('closed', {})
    }
    return Promise.resolve()
  }

  // ═══════════════════════════════════════════════════════════
  // 命令
  // ═══════════════════════════════════════════════════════════

  /**
   * 发一条 CDP 命令。
   *
   * @param {string} method            如 `Runtime.evaluate`
   * @param {object} [params]
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]  覆盖超时（默认 15s，Page.navigate 30s）
   * @param {string} [opts.sessionId]  会话级命令（flatten 模式）
   * @param {string} [opts.role]       按角色登记过的会话（与 sessionId 二选一）
   * @param {number} [opts.atMs]       便于测试注入时间
   * @returns {Promise<object>} result
   */
  send(method, params = {}, opts = {}) {
    const timeoutMs = resolveCommandTimeoutMs(method, opts, this.config)
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const entry = { method, sessionId: undefined, atMs: Date.now() }

      const done = (fn, arg) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this._pending.delete(id)
        fn(arg)
      }

      const id = this._nextId++
      entry.resolve = (v) => done(resolve, v)
      entry.reject = (e) => done(reject, e)

      // ⚠️ 计时器**先于**等待就绪启动：调用方给的超时是"这条命令的总预算"，
      //    否则"断线 5 分钟后再发命令"会变成无限等待。
      timer = setTimeout(() => {
        entry.reject(new CdpError(ATTRIBUTION.CMD_TIMEOUT, `${method} 超时（${timeoutMs}ms）`, {
          method, timeout_ms: timeoutMs, url: this.url, state: this._state,
        }))
      }, timeoutMs)
      if (timer.unref) timer.unref()

      this._pending.set(id, entry)

      const sessionId = opts.sessionId || (opts.role ? this.sessionIdOf(opts.role) : undefined)
      entry.sessionId = sessionId || undefined

      this._dispatchWait(id, method, params, opts, sessionId, timeoutMs)
    })
  }

  /** 等连接就绪后再真正写帧（与 send 的计时器并行）。 */
  _dispatchWait(id, method, params, opts, sessionId, timeoutMs) {
    const finishFail = (err) => {
      const entry = this._pending.get(id)
      if (entry) entry.reject(err)
    }
    if (this._intent === 'closed') {
      finishFail(new CdpError(ATTRIBUTION.CLOSED, `连接已关闭，拒绝发送 ${method}`))
      return
    }
    if (this.isConnected) {
      this._write(id, method, params, sessionId)
      return
    }
    this.waitReady(timeoutMs).then(
      () => {
        if (!this._pending.has(id)) return // 已超时
        this._write(id, method, params, sessionId)
      },
      (e) => finishFail(e)
    )
  }

  _write(id, method, params, sessionId) {
    const socket = this._socket
    const entry = this._pending.get(id)
    if (!entry) return
    if (!socket) {
      entry.reject(new CdpError(ATTRIBUTION.SOCKET_CLOSED, `连接不可用，${method} 未发出`, { method }))
      return
    }
    const frame = { id, method, params: params || {} }
    if (sessionId) frame.sessionId = sessionId
    let text
    try {
      text = JSON.stringify(frame)
    } catch (e) {
      entry.reject(new CdpError(ATTRIBUTION.SEND_FAILED, `命令参数无法序列化：${e.message}`, { method }))
      return
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
      entry.reject(new CdpError(ATTRIBUTION.SEND_FAILED, `命令帧超过上限 ${MAX_FRAME_BYTES} 字节（${method}）`, { method }))
      return
    }
    try {
      socket.send(text)
    } catch (e) {
      entry.reject(new CdpError(ATTRIBUTION.SEND_FAILED, `写 CDP 帧失败：${e && e.message ? e.message : String(e)}`, { method }))
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 帧处理
  // ═══════════════════════════════════════════════════════════

  _onMessage(data) {
    const text = toText(data)
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
      // ⚠️ 超限帧直接丢弃并留痕；不静默截断（截断会产生"看起来合法的坏 JSON"）。
      this._log('error', 'cdp_frame_too_large', { attribution: ATTRIBUTION.BAD_FRAME, bytes: Buffer.byteLength(text, 'utf8') })
      return
    }
    let msg
    try {
      msg = JSON.parse(text)
    } catch (e) {
      this._log('error', 'cdp_bad_frame', { attribution: ATTRIBUTION.BAD_FRAME, message: e.message, bytes: text.length })
      return
    }
    if (msg.error && msg.id !== undefined) {
      const entry = this._pending.get(msg.id)
      const detail = { method: entry ? entry.method : null, cdp_error: msg.error }
      const err = new CdpError(ATTRIBUTION.PROTOCOL_ERROR, `CDP 报错：${msg.error.message || JSON.stringify(msg.error)}`, detail)
      if (entry) entry.reject(err)
      else this._log('warn', 'cdp_error_for_unknown_id', { attribution: ATTRIBUTION.PROTOCOL_ERROR, id: msg.id })
      return
    }
    if (msg.id !== undefined && msg.result !== undefined) {
      const entry = this._pending.get(msg.id)
      if (entry) entry.resolve(msg.result)
      // 迟到的响应（已超时）静默丢弃，但留一条 debug 便于排查"超时但实际成功"
      else this._log('debug', 'cdp_late_response_dropped', { id: msg.id })
      return
    }
    if (msg.method) {
      this._dispatchEvent(msg.method, msg.params || {}, msg.sessionId)
      return
    }
    this._log('warn', 'cdp_unrecognized_frame', { attribution: ATTRIBUTION.BAD_FRAME, keys: Object.keys(msg) })
  }

  /**
   * 事件分发。
   *
   * ⚠️ 两类事件必须都能到：
   *   · 浏览器级（无 sessionId，如 `Target.targetDestroyed`）→ 只投给"未限定会话"的监听器；
   *   · 会话级（带 sessionId，如某个标签页的 `Network.responseReceived`）→ 投给
   *     订阅了**该 sessionId** 的监听器，以及所有未限定会话的监听器。
   * 漏掉任何一类，都会让"事件静默不到"这类问题在真机上极难定位。
   */
  _dispatchEvent(eventName, params, sessionId) {
    const records = this._eventListeners.get(eventName)
    if (!records || records.length === 0) return
    for (const rec of [...records]) {
      if (rec.sessionId && rec.sessionId !== sessionId) continue
      if (rec.once) this._removeEventListener(eventName, rec)
      this._safeCall(rec.handler, params, { event: eventName, sessionId: sessionId || null })
    }
  }

  _removeEventListener(eventName, rec) {
    const arr = this._eventListeners.get(eventName)
    if (!arr) return
    const i = arr.indexOf(rec)
    if (i >= 0) arr.splice(i, 1)
    if (arr.length === 0) this._eventListeners.delete(eventName)
  }

  /**
   * 订阅 CDP 事件。
   * @param {string} eventName
   * @param {Function} handler
   * @param {object} [opts]
   * @param {string} [opts.sessionId] 只收该会话的事件
   * @param {string} [opts.role]      只收该角色标签页的事件
   * @param {boolean} [opts.once]
   * @returns {Function} 退订函数（幂等，可重复调用）
   */
  on(eventName, handler, opts = {}) {
    if (typeof handler !== 'function') throw new CdpError(ATTRIBUTION.BAD_FRAME, `on(${eventName}) 需要一个函数`)
    const rec = {
      id: this._nextId++,
      handler,
      sessionId: opts.sessionId || (opts.role ? this.sessionIdOf(opts.role) : null),
      once: Boolean(opts.once),
    }
    if (!this._eventListeners.has(eventName)) this._eventListeners.set(eventName, [])
    this._eventListeners.get(eventName).push(rec)
    let off = false
    return () => {
      if (off) return
      off = true
      this._removeEventListener(eventName, rec)
    }
  }

  /** 订阅生命周期事件：state / ready / disconnected / closed / give_up。 */
  onLifecycle(name, handler) {
    if (!this._lifecycleListeners.has(name)) this._lifecycleListeners.set(name, [])
    const rec = { handler }
    this._lifecycleListeners.get(name).push(rec)
    return () => {
      const arr = this._lifecycleListeners.get(name) || []
      const i = arr.indexOf(rec)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 会话复用（flatten 模式：一条浏览器级 WS 服务多个标签页）
  // ═══════════════════════════════════════════════════════════

  /**
   * attach 一个 target 并登记为业务角色。
   *
   * ⚠️ 用 flatten 模式（`flatten:true`）的意义：返回的 `sessionId` 可以
   * 直接在**同一条**浏览器级 WebSocket 上作用域化命令，**不需要**再去
   * `/json/list` 取该标签页自己的 `webSocketDebuggerUrl` 另开一条连接。
   * 旧代码正是每处理一个标签页就 `new CDP(tab.webSocketDebuggerUrl)`
   * —— 一个任务两条连接，多个 worker 叠加就是"多进程争抢同一标签页"。
   */
  async attach(role, targetId) {
    if (!role || !targetId) throw new CdpError(ATTRIBUTION.ATTACH_FAILED, 'attach 需要 role 与 targetId')
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = r && r.sessionId
    if (!sessionId) throw new CdpError(ATTRIBUTION.ATTACH_FAILED, `attach 未返回 sessionId（role=${role}）`, { role, target_id: targetId })
    this._sessions.set(role, { role, targetId, sessionId })
    return sessionId
  }

  /** 把已存在的 sessionId 登记为角色（用于重连后接管等场景）。 */
  registerSession(role, targetId, sessionId) {
    this._sessions.set(role, { role, targetId, sessionId: sessionId || null })
    return sessionId
  }

  detach(role) {
    this._sessions.delete(role)
  }

  sessionIdOf(role) {
    const rec = this._sessions.get(role)
    return rec && rec.sessionId ? rec.sessionId : null
  }

  targetIdOf(role) {
    const rec = this._sessions.get(role)
    return rec && rec.targetId ? rec.targetId : null
  }

  roleOf(targetId) {
    for (const rec of this._sessions.values()) if (rec.targetId === targetId) return rec.role
    return null
  }

  listSessionRoles() {
    return [...this._sessions.keys()]
  }

  // ═══════════════════════════════════════════════════════════
  // 高频原语（仍然是抖音无关的）
  // ═══════════════════════════════════════════════════════════

  /**
   * 求值一个 JS 表达式。
   *
   * ⚠️ 页面 JS 抛出的异常**必须**转成结构化错误，而不是把
   * `exceptionDetails` 塞进 result 让上层自己发现——旧代码就是
   * `r.result.value` 直接 `JSON.parse`，异常时得到 `undefined`，
   * 然后一层层退化成"没找到元素"，最终归因到错误的方向上。
   */
  async evaluate(role, expression, opts = {}) {
    const params = {
      expression,
      returnByValue: opts.returnByValue !== false,
      awaitPromise: opts.awaitPromise === true,
    }
    if (opts.userGesture !== undefined) params.userGesture = Boolean(opts.userGesture)
    if (opts.contextId !== undefined) params.contextId = opts.contextId
    if (opts.includeCommandLineAPI !== undefined) params.includeCommandLineAPI = Boolean(opts.includeCommandLineAPI)

    const r = await this.send('Runtime.evaluate', params, {
      role,
      timeoutMs: opts.timeoutMs,
    })

    if (r && r.exceptionDetails) {
      const ex = r.exceptionDetails
      const desc = (ex.exception && (ex.exception.description || ex.exception.value))
        || ex.text || '页面脚本抛出异常'
      throw new CdpError(ATTRIBUTION.EVALUATE_EXCEPTION, `页面脚本异常：${String(desc).split('\n')[0]}`, {
        role,
        line: ex.lineNumber,
        column: ex.columnNumber,
        text: ex.text || null,
        // ⚠️ 只带首行摘要：完整堆栈可能含页面原文，禁止外传（红线 3 隐私边界）。
        description_head: String(desc).split('\n').slice(0, 3).join(' | '),
      })
    }
    return {
      value: r ? r.result && 'value' in r.result ? r.result.value : undefined : undefined,
      type: r && r.result ? r.result.type : undefined,
      unserializableValue: r && r.result ? r.result.unserializableValue : undefined,
      raw: r,
    }
  }

  /**
   * `Runtime.evaluate` 取**字符串**并按 JSON 解析（legacy 的写法是
   * `JSON.stringify(...)` 后 `JSON.parse(r.result.value)`）。
   * 解析失败会明确抛出，不会退化成 null。
   */
  async evaluateJson(role, expression, opts = {}) {
    const r = await this.evaluate(role, expression, { ...opts, returnByValue: true })
    const v = r.value
    if (v === null || v === undefined || v === '') return null
    if (typeof v === 'object') return v
    try {
      return JSON.parse(String(v))
    } catch (e) {
      throw new CdpError(ATTRIBUTION.EVALUATE_EXCEPTION, `求值结果不是合法 JSON：${e.message}`, { role })
    }
  }

  /**
   * 轮询等待某个表达式返回真值。
   *
   * ⚠️ 抛出的超时错误**必须带上"轮询了几次"与"最后一次看到的值"**：
   * 排障时这两项直接回答"是选择器失效（一直 null）还是时序不够
   * （值在变但总不满足）"。旧代码只报一句 `panel not visible`，
   * 每次真机排障都要重新加日志。
   */
  async waitFor(role, { expression, timeoutMs = 30000, pollMs = 500 } = {}) {
    if (!expression) throw new CdpError(ATTRIBUTION.EVALUATE_EXCEPTION, 'waitFor 需要 expression')
    const started = Date.now()
    let polls = 0
    let last = null
    let lastError = null
    for (;;) {
      polls += 1
      try {
        const r = await this.evaluate(role, expression, { returnByValue: true, timeoutMs: Math.max(1000, Math.min(timeoutMs, 10000)) })
        last = r.value
        lastError = null
        if (last) return { value: last, polls, elapsedMs: Date.now() - started }
      } catch (e) {
        // ⚠️ 求值异常（页面正在导航/上下文被销毁）**不能**当成"还没就绪"就直接
        //    吞掉，必须记录下来，最后作为超时错误的一部分抛给调用方。
        lastError = { attribution: e && e.attribution, message: e && e.message }
        if (e && e.attribution === ATTRIBUTION.CLOSED) throw e
      }
      if (Date.now() - started >= timeoutMs) {
        throw new CdpError(ATTRIBUTION.CMD_TIMEOUT, `等待条件超时（${timeoutMs}ms，已轮询 ${polls} 次）`, {
          role, polls, timeout_ms: timeoutMs, last_value: sanitizeForLog(last), last_error: lastError,
        })
      }
      await sleep(Math.max(50, Math.min(pollMs, timeoutMs - (Date.now() - started))))
    }
  }

  /** `Page.navigate`（自动使用放大后的超时） */
  async navigate(role, url, opts = {}) {
    return this.send('Page.navigate', { url }, { role, timeoutMs: opts.timeoutMs })
  }

  /** 真实鼠标事件（按下 + 抬起）。⚠️ 不做任何合成点击。 */
  async dispatchMouseClick(role, x, y, opts = {}) {
    const jitterMs = Number.isFinite(opts.jitterMs) ? Number(opts.jitterMs) : 120
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0,
    }, { role, timeoutMs: opts.timeoutMs })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: opts.clickCount || 1,
    }, { role, timeoutMs: opts.timeoutMs })
    await sleep(jitterMs)
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: opts.clickCount || 1,
    }, { role, timeoutMs: opts.timeoutMs })
  }

  /**
   * Enter 三段式按键。
   *
   * ⚠️ 三个细节都不能省（legacy reply_worker.js:386-388 逐字保留）：
   *   ① 第一段是 `rawKeyDown`（**不是** `keyDown`）；
   *   ② 第二段 `char` 必须带 `text: "\r"`；
   *   ③ `windowsVirtualKeyCode` / `nativeVirtualKeyCode` 必须为 13。
   * 缺 `char` 段时富文本编辑器（DraftJS 类）收不到输入，
   * 表现是"看起来按键了，但什么都没发出去"。
   */
  async pressEnterKey(role, opts = {}) {
    const key = opts.key || 'Enter'
    const code = opts.code || 'Enter'
    const vk = Number.isFinite(opts.virtualKeyCode) ? opts.virtualKeyCode : 13
    const t = opts.timeoutMs
    const text = opts.text !== undefined ? opts.text : '\r'
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    }, { role, timeoutMs: t })
    await this.send('Input.dispatchKeyEvent', {
      type: 'char', key, code, text, windowsVirtualKeyCode: vk,
    }, { role, timeoutMs: t })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: vk,
    }, { role, timeoutMs: t })
  }

  /** 写入文本（走 Input 域，等价于真实输入法插入）。 */
  async insertText(role, text, opts = {}) {
    return this.send('Input.insertText', { text: String(text) }, { role, timeoutMs: opts.timeoutMs })
  }

  /**
   * 滚轮滚动（懒加载列表靠它把目标评论滚出来）。
   * ⚠️ 滚动锚点必须由调用方传入（注册表参数）：视频页评论区与搜索页
   *    要滚的容器不同，legacy 分别用了 (900,500) 与 (1150,550)。
   */
  async mouseWheel(role, { x, y, deltaX = 0, deltaY, opts = {} } = {}) {
    return this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY,
    }, { role, timeoutMs: opts.timeoutMs })
  }

  // ═══════════════════════════════════════════════════════════
  // 响应嗅探（发送成功判定的唯一证据来源）
  // ═══════════════════════════════════════════════════════════

  /** 内部：把 Network 事件接到响应体环上（只在构造时挂一次）。 */
  _wireNetworkCapture() {
    // ⚠️ 监听必须在**发送动作之前**就绪（legacy reply_worker.js:383-384 在 Enter
    //    之前注册监听）。本方法在构造时执行，早于任何调用方动作。
    this.on('Network.requestWillBeSent', (p, meta) => {
      if (!p || !p.requestId) return
      this._inflight.set(p.requestId, {
        requestId: p.requestId,
        url: p.request ? p.request.url : null,
        method: p.request ? p.request.method : null,
        postData: p.request ? p.request.postData : undefined,
        sessionId: meta ? meta.sessionId : null,
        atMs: Date.now(),
      })
      if (this._inflight.size > 512) {
        // 只保留最近 512 条在途记录（异常页面可能持续发请求）
        const first = this._inflight.keys().next()
        if (!first.done) this._inflight.delete(first.value)
      }
    })

    this.on('Network.responseReceived', (p) => {
      if (!p || !p.requestId) return
      const rec = this._inflight.get(p.requestId) || { requestId: p.requestId, atMs: Date.now() }
      rec.url = p.response ? p.response.url : rec.url
      rec.status = p.response ? p.response.status : undefined
      rec.mimeType = p.response ? p.response.mimeType : undefined
      rec.headers = p.response ? p.response.headers : undefined
      rec.fromDiskCache = p.response ? p.response.fromDiskCache : undefined
      rec.responseAtMs = Date.now()
      this._inflight.set(p.requestId, rec)
    })

    // ⚠️ 取响应体必须在 `Network.loadingFinished` **立刻**做：
    //    渲染器的响应体缓存随时可能被回收，晚一步就只剩
    //    `Network.getResponseBody` 的报错。旧代码在 responseReceived 里就取，
    //    但那时 body 可能还没接收完（对分块响应尤其），因此这里选 loadingFinished。
    this.on('Network.loadingFinished', (p) => {
      if (!p || !p.requestId) return
      const rec = this._inflight.get(p.requestId)
      if (!rec) return
      this._inflight.delete(p.requestId)
      const task = this._captureBody(rec)
        .catch((e) => {
          // ⚠️ 取体失败**不是**发送成功，也**不是**发送失败：它是"未拿到平台响应"，
          //    上层按红线 2 只能记 failed/sent_suspected。这里必须留痕。
          this._log('warn', 'cdp_response_body_unavailable', {
            attribution: (e && e.attribution) || ATTRIBUTION.BODY_UNAVAILABLE,
            request_id: p.requestId, url: rec.url, status: rec.status,
          })
        })
      this._bodyFetches.add(task)
      task.then(() => this._bodyFetches.delete(task), () => this._bodyFetches.delete(task))
    })

    this.on('Network.loadingFailed', (p) => {
      if (!p || !p.requestId) return
      this._inflight.delete(p.requestId)
      this._log('debug', 'cdp_network_loading_failed', {
        request_id: p.requestId, error_text: p.errorText || null, canceled: p.canceled === true,
      })
    })
  }

  async _captureBody(rec) {
    const r = await this.send('Network.getResponseBody', { requestId: rec.requestId }, { timeoutMs: BODY_FETCH_TIMEOUT_MS })
    const body = r && r.base64Encoded
      ? Buffer.from(String(r.body || ''), 'base64').toString('utf8')
      : String((r && r.body) || '')
    const entry = {
      requestId: rec.requestId,
      url: rec.url || null,
      method: rec.method || null,
      status: rec.status === undefined ? null : rec.status,
      mimeType: rec.mimeType || null,
      body,
      body_bytes: Buffer.byteLength(body, 'utf8'),
      base64_encoded: Boolean(r && r.base64Encoded),
      capturedAtMs: Date.now(),
      sessionId: rec.sessionId || null,
      postData: rec.postData === undefined ? null : rec.postData,
    }
    this._pushBody(entry)
    return entry
  }

  _pushBody(entry) {
    /**
     * ⚠️ 每个条目带一个**单调递增的序号** `cursor`，而不是靠数组下标。
     * 环满了会 shift 掉旧条目，下标会整体前移；序号不会。
     * `waitForResponse({sinceCursor})` 依赖它把"这一次发送之后"的窗口钉死。
     */
    this._bodySeq += 1
    entry.cursor = this._bodySeq
    this._bodyRing.push(entry)
    while (this._bodyRing.length > this.bodyRingSize) this._bodyRing.shift()
    return entry.cursor
  }

  /**
   * 启用响应嗅探。
   *
   * ⚠️ 只用 `Network` 域，**绝不用 `Fetch` 域**：`Fetch.enable` 会拦截并
   * 暂停请求，需要显式 `Fetch.continueRequest`，一旦漏发就让页面请求
   * 永久挂起——而这是商家真实的登录窗口。`Network` 是纯监听，不改变页面行为。
   */
  async enableResponseCapture(role, opts = {}) {
    if (!this._networkEnabled) {
      await this.send('Network.enable', {}, { role, timeoutMs: opts.timeoutMs })
      this._networkEnabled = true
    }
    return {
      enabled: true,
      sessionId: role ? this.sessionIdOf(role) : null,
      ring_size: this.bodyRingSize,
    }
  }

  /** 当前环中已捕获的响应（副本，避免调用方改到内部状态）。 */
  get capturedResponses() {
    return this._bodyRing.map((e) => ({ ...e }))
  }

  clearCapturedResponses() {
    const n = this._bodyRing.length
    this._bodyRing = []
    return n
  }

  /**
   * 按 URL 匹配已捕获的响应体。
   *
   * @param {string|RegExp|Function} pattern 子串 / 正则 / 谓词
   * @returns {object[]} 命中的响应体条目（新→旧）
   */
  findCapturedResponses(pattern) {
    return this._bodyRing.filter((e) => matchUrl(pattern, e.url)).slice().reverse()
  }

  /**
   * 当前捕获环的游标（纯读取）。
   *
   * ⚠️ 游标是**累计序号**（单调递增），不是数组下标：
   * 环满了会丢最旧的条目，下标会整体前移导致"同一批响应算出不同窗口"。
   * 用它划窗口比时间戳可靠：本地时钟回拨、事件与取体的时间差不影响它。
   * "我们要证明的是**这一次发送之后**出现了平台响应"，窗口必须钉死。
   */
  get responseCursor() {
    return this._bodySeq
  }

  /**
   * 等待一个匹配 `urlPattern` 的响应被完整捕获。
   *
   * ⚠️ 返回的是**原始证据**（状态码 + 响应体），本层**不做成功判定**：
   * "哪个字段等于 0 才算成功"是平台知识，属于 adapters。
   * 本层只保证"拿到了就是拿到了，没拿到就明确地说没拿到"。
   *
   * @param {object} p
   * @param {string|RegExp|Function} p.urlPattern
   * @param {number} [p.timeoutMs]
   * @param {number} [p.pollMs]
   * @param {number} [p.sinceMs]     只接受该时刻之后捕获的（与 sinceCursor 并存）
   * @param {number} [p.sinceCursor] 只接受该游标之后捕获的（**优先于 sinceMs**）
   * @param {string} [p.sessionId]   限定会话
   */
  async waitForResponse({ urlPattern, timeoutMs = 15000, pollMs = 100, sinceMs = 0, sinceCursor, sessionId = null } = {}) {
    if (!urlPattern) throw new CdpError(ATTRIBUTION.BODY_UNAVAILABLE, 'waitForResponse 需要 urlPattern')
    const started = Date.now()
    const requireCursor = Number.isFinite(sinceCursor) && sinceCursor >= 0 ? Number(sinceCursor) : null
    let polls = 0
    for (;;) {
      polls += 1
      const hit = this._bodyRing.find((e) => {
        // ⚠️ sinceCursor 优先：它按**累计序号**划窗口，不受时钟与环回收影响。
        if (requireCursor !== null) { if (Number(e.cursor || 0) <= requireCursor) return false }
        else if (e.capturedAtMs < sinceMs) return false
        if (sessionId && e.sessionId !== sessionId) return false
        return matchUrl(urlPattern, e.url)
      })
      if (hit) return { ...hit, polls, elapsedMs: Date.now() - started }
      if (Date.now() - started >= timeoutMs) {
        throw new CdpError(ATTRIBUTION.CMD_TIMEOUT, `等待平台响应超时（${timeoutMs}ms，已轮询 ${polls} 次）`, {
          url_pattern: String(urlPattern),
          polls,
          timeout_ms: timeoutMs,
          since_cursor: requireCursor,
          since_ms: sinceMs,
          captured_count: this._bodyRing.length,
          cursor: this._bodySeq,
          // ⚠️ 只回传"最近捕获到的 URL 列表"，用于人工确认 urlPattern 是否写错。
          //    这是排查"是风控还是关键字写错"的关键区分（平台知识 §3.5）。
          recent_urls: this._bodyRing.slice(-5).map((e) => e.url),
        })
      }
      await sleep(Math.max(20, Math.min(pollMs, timeoutMs - (Date.now() - started))))
    }
  }

  /** 等待所有在途的 getResponseBody 落地（关闭/停止捕获前调用，避免未处理拒绝）。 */
  async drainBodyFetches() {
    const inflight = [...this._bodyFetches]
    if (inflight.length === 0) return 0
    await Promise.allSettled(inflight)
    return inflight.length
  }
}

/** URL 匹配：支持子串 / 正则 / 谓词（URL 片段永远是参数，不在这里写死）。 */
function matchUrl(pattern, url) {
  if (pattern === undefined || pattern === null) return false
  if (url === undefined || url === null) return false
  const u = String(url)
  if (pattern instanceof RegExp) return pattern.test(u)
  if (typeof pattern === 'function') return Boolean(pattern(u))
  return u.includes(String(pattern))
}

/** 日志用的值摘要：⚠️ 截断，避免把整段页面文本写进日志（红线 3）。 */
function sanitizeForLog(v) {
  if (v === undefined) return null
  if (v === null) return null
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}…(${v.length})` : v
  if (typeof v === 'number' || typeof v === 'boolean') return v
  try {
    const s = JSON.stringify(v)
    return s && s.length > 120 ? `${s.slice(0, 120)}…` : s
  } catch (e) {
    // ⚠️ 循环引用等无法序列化的值：回一句类型名，不抛（日志不该改变控制流）。
    return `<unserializable ${typeof v}: ${e && e.message ? e.message : 'unknown'}>`
  }
}

/** 可 unref 的 sleep（重试/轮询不应阻止进程退出）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t.unref) t.unref()
  })
}

module.exports = {
  Cdp,
  CdpError,
  ATTRIBUTION,
  REQUIRED_DOMAINS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  NAVIGATE_RETRY_TIMEOUT_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  BODY_FETCH_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  reconnectDelayMs,
  resolveCommandTimeoutMs,
  matchUrl,
  loadWs,
}
