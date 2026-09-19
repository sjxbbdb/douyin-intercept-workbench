'use strict'

// test/unit/client-core.test.js
// CDP 基础设施层测试 —— `client/core/cdp.js` / `browser-host.js` / `ipc.js`。
//
// ⚠️ 本环境没有真实 Chrome，因此**全部用注入式假 socket**跑：
//    Cdp 支持 `createSocket`，BrowserHost 支持 `cdpFactory`/`spawnImpl`/
//    `probePortImpl`/`getJsonImpl`，ipc 支持任意 `{write,on}` 流。
//    这不是"退而求其次"——断线重连、超时、会话复用这些行为**只能**用
//    可控的假 socket 精确验证（真机上没法精确制造"第 300ms 断线"）。
//
// 真机才能验证的部分见文件末尾的"真机验证清单"注释。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const { PassThrough } = require('node:stream')

const { Cdp, CdpError, ATTRIBUTION, reconnectDelayMs, resolveCommandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, NAVIGATE_TIMEOUT_MS } = require('../../client/core/cdp')
const host = require('../../client/core/browser-host')
const ipc = require('../../client/core/ipc')

const ROOT = path.join(__dirname, '..', '..')

// ══════════════════════════════════════════════════════════════
// 假 WebSocket：说 CDP 帧语言，可被测试完全控制
// ══════════════════════════════════════════════════════════════

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.sent = []
    this.closed = false
    this.closeCalls = 0
    this._listeners = new Map()
    this.openAtMs = Date.now()
  }

  on(name, fn) {
    if (!this._listeners.has(name)) this._listeners.set(name, [])
    this._listeners.get(name).push(fn)
    return this
  }

  emit(name, arg) {
    for (const fn of [...(this._listeners.get(name) || [])]) fn(arg)
  }

  send(text) {
    if (this.closed) throw new Error('socket 已关闭')
    this.sent.push(text)
    /**
     * ⚠️ 必须**异步**（宏任务，不是微任务）执行："同步"会让 reject 发生在
     * 调用方挂 `.catch`/`await` 之前，reject 直接变成 unhandledRejection，
     * Node 会把它当异常抛到 `socket.send` 的调用栈上（实测踩过）。
     * 微任务也不够稳妥：`pump()` 里可能连续处理多条命令，只要有一条的
     * promise 还没被挂上监听，就会漏一个未处理拒绝。
     * 宏任务一拍与真实 WebSocket 语义一致（响应不可能在 send() 返回前到达）。
     *
     * 早期实现还只在"测试显式 waitFor 某条命令"时才处理帧，后果是任何
     * 没被 wait 的命令（例如 `assert.rejects(cdp.send(...))` 直接等结果）
     * 永远得不到应答，只能靠 15 秒命令超时兜底——既慢又会把"协议报错"
     * 误判成"命令超时"。
     */
    if (this.onSend) setTimeout(this.onSend, 0)
  }

  close() {
    this.closeCalls += 1
    this.closed = true
    this.emit('close', { code: 1000, reason: 'test-close' })
  }

  // ── 测试侧动作 ────────────────────────────────────────────

  open() {
    this.emit('open')
  }

  /** 注入一帧（服务端 → 客户端）。⚠️ 真实 WS 是异步投递，这里也异步。 */
  push(obj) {
    this.emitAsync('message', Buffer.from(JSON.stringify(obj), 'utf8'))
  }

  /** 异步派发事件（与真实 WebSocket 的投递语义一致，见类头注释） */
  emitAsync(name, arg) {
    setTimeout(() => this.emit(name, arg), 0)
  }

  /** 模拟网络异常断开 */
  drop() {
    this.closed = true
    this.emit('close', { code: 1006, reason: 'abnormal' })
  }

  /** 解析出客户端发出的所有帧 */
  frames() {
    return this.sent.map((s) => JSON.parse(s))
  }

  methods() {
    return this.frames().filter((f) => typeof f.method === 'string').map((f) => f.method)
  }

  /** 已发出的命令帧（带 method 的） */
  commands() {
    return this.frames().filter((f) => typeof f.method === 'string')
  }
}

/**
 * 假 CDP 服务端：按浏览器语义应答。
 *
 * 必须模拟的两件事：
 *   · `Target.attachToTarget({flatten:true})` 返回一个新的 sessionId；
 *   · 带 sessionId 的命令要按会话路由（会话未知则报 -32001）。
 * 这两条正是"一条浏览器级 WS 服务多个标签页"的核心，不能省。
 */
/**
 * sessionId 计数器必须是**模块级**的：每个 FakeCdpServer 实例对应一条连接，
 * 而真实 Chrome 的 sessionId 是连接级唯一、跨连接不会重复。
 * 实例级计数器会让"重连后拿到新 sessionId"这类断言永远失败（新旧都是 S1），
 * 从而掩盖真正的回归（实测踩过）。
 */
let SESSION_SEQ = 0

class FakeCdpServer {
  constructor(ws, opts = {}) {
    this.ws = ws
    this.sessions = new Map()
    this.attachedTargets = []
    this.sessionSeq = 0
    this.routes = new Map()
    /** 已声明应答的方法名（未声明的方法**不自动应答**，见 #handle 末尾注释） */
    this.declaredMethods = new Set()
    this.respondedIds = []
    this.targets = []
    /** 未声明方法的记录（测试可断言其为空，用于发现"忘了声明"） */
    this.undeclared = []
    /** pump 处理过的方法名（排障用） */
    this.pumped = []
    this.onUndeclared = opts.onUndeclared || (() => {})
    /** 自动应答：客户端每写出一帧就（异步）处理一次，测试无需手动 pump */
    this.autoRespond = opts.autoRespond !== false
    if (this.autoRespond) ws.onSend = () => this.pump()
  }

  route(method, fn) {
    this.routes.set(method, fn)
    this.declaredMethods.add(method)
    return this
  }

  /**
   * 声明某方法返回什么结果（比 route 更省事）。
   *
   * ⚠️ 必须**在命令写出之前**声明：`pump()` 会应答它当时看到的所有命令，
   *    事后再 push 一条响应已经晚了（那一条 pending 早被默认结果结算掉了）。
   *    早期测试用"发命令 → 手工 push 响应"，在并发命令下必然踩这个坑。
   */
  serve(method, result, opts = {}) {
    return this.route(method, (f, s) => {
      if (opts.delayMs) {
        setTimeout(() => s.ws.push({ id: f.id, result }), opts.delayMs)
      } else {
        s.ws.push({ id: f.id, result })
      }
      return 'handled'
    })
  }

  /** 声明某方法返回 CDP 错误 */
  serveError(method, error) {
    return this.route(method, (f, s) => {
      s.ws.push({ id: f.id, error })
      return 'handled'
    })
  }

  /** 处理当前已收到的全部帧（幂等：同一条命令只应答一次） */
  pump() {
    for (const f of this.ws.frames()) {
      if (this.respondedIds.includes(f.id)) continue
      this.respondedIds.push(f.id)
      this.pumped.push(f.method)
      this.#handle(f, this.ws)
    }
  }

  /**
   * 等第 n 条**客户端发来的命令**出现，并处理它。
   *
   * ⚠️ 计数必须基于"命令帧"而不是"流里的第 n 条帧"：
   *    测试经常手工 `ws.push({id, result})` 注入响应帧，那些帧也在
   *    `sent`/`frames` 的视野里。早期实现按帧序号等待，结果把注入的
   *    响应帧当成了"第 1 条命令"，于是永远等不到 Runtime.enable 被应答
   *    ——表现为所有 CDP 测试在 waitReady 上超时 15 秒。
   */
  waitFor(ws, n, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => {
        const commands = ws.frames().filter((f) => typeof f.method === 'string')
        if (commands.length >= n) {
          this.pump()
          const f = commands[n - 1]
          if (f) { resolve(f); return }
        }
        if (Date.now() - t0 > timeoutMs) {
          reject(new Error(`等第 ${n} 条客户端命令超时（当前 ${commands.length} 条：${commands.map((c) => c.method).join(',')}）`))
          return
        }
        setTimeout(tick, 5)
      }
      tick()
    })
  }

  /** 等待某个方法名的命令出现（比序号稳定，推荐） */
  waitForMethod(ws, method, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => {
        const f = ws.frames().find((x) => x.method === method)
        if (f) { this.pump(); resolve(f); return }
        if (Date.now() - t0 > timeoutMs) {
          reject(new Error(`等待命令 ${method} 超时（已发出：${ws.methods().join(',')}）`))
          return
        }
        setTimeout(tick, 5)
      }
      tick()
    })
  }

  /** 等待某个方法名的命令**累计出现 n 次**（比"第一个匹配"稳定） */
  waitForMethodCount(ws, method, n, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => {
        const hits = ws.commands().filter((x) => x.method === method)
        if (hits.length >= n) { this.pump(); resolve(hits[n - 1]); return }
        if (Date.now() - t0 > timeoutMs) {
          reject(new Error(`等待第 ${n} 次 ${method} 超时（当前 ${hits.length} 次；已发出：${ws.methods().join(',')}）`))
          return
        }
        setTimeout(tick, 5)
      }
      tick()
    })
  }

  /** 等某个角色的 attach 完成（ensureTab/attach 之后必须 pump 才会被应答） */
  async attachRole(cdp, ws, role, targetId, nth = 1) {
    const p = cdp.attach(role, targetId)
    await this.waitForMethodCount(ws, 'Target.attachToTarget', nth)
    // ⚠️ 必须 await attach 本身：waitForMethodCount 只保证"帧已发出并被处理"，
    //    attach 的 promise 还要等一个微任务才会结算。直接 return p 会让调用方
    //    拿到 undefined（实测踩过）。
    const sessionId = await p
    await this.waitReady(cdp, ws)
    return sessionId
  }

  /**
   * 等客户端连接**完全**就绪。
   *
   * ⚠️ 这里断言的不是"waitReady 返回了"，而是 `runtime_enabled &&
   *    network_enabled` 都为 true。原因是域启用是**串行**的：
   *    Runtime.enable 有响应之后才发 Network.enable。
   *    早期实现只 pump 一次 / 只看 waitReady，导致：
   *      · 第二条 enable 还没写完就进入测试体；
   *      · 上一个用例的连接在**下一个用例**里才完成握手，
   *        于是"残留 pending"之类的断言会看到别的用例的命令（实测踩过）。
   *    这两个坑都表现为"莫名其妙超时 15 秒"，排查成本极高。
   *
   * ⚠️ 不断言 `pending_count === 0`：调用方自己发出的命令本来就在途，
   *    把它算作"没就绪"会让 waitReady 与调用方互相等待。
   */
  async waitReady(cdp, ws, timeoutMs = 3000) {
    const t0 = Date.now()
    for (;;) {
      this.pump()
      const st = cdp.engineState
      if (st.state === 'open' && st.runtime_enabled && st.network_enabled) return
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等 CDP 就绪超时：${JSON.stringify({
          state: st.state,
          runtime: st.runtime_enabled,
          network: st.network_enabled,
          pending: st.pending_count,
          commands: ws.commands().map((f) => f.method),
        })}`)
      }
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  #handle(f, ws) {
    // ⚠️ 会话校验必须**先于**自定义路由与内建分支：否则"未知 sessionId
    //    必须报 -32001"这类用例会被自定义应答顺手放过
    //    （实测踩过：断言从"应当报错"变成"没有报错"）。
    //    这也与真实 Chrome 一致：未知 sessionId 在协议层就被拒。
    if (f.sessionId && !this.sessions.has(f.sessionId)) {
      ws.push({ id: f.id, error: { code: -32001, message: `Session with given id not found: ${f.sessionId}` } })
      return
    }
    const custom = this.routes.get(f.method)
    if (custom) {
      const r = custom(f, this)
      if (r === 'handled') return
    }
    switch (f.method) {
      case 'Runtime.enable':
      case 'Network.enable':
      case 'Page.enable':
        ws.push({ id: f.id, result: {} })
        return
      case 'Target.getTargets':
        ws.push({ id: f.id, result: { targetInfos: this.targets.slice() } })
        return
      case 'Target.attachToTarget': {
        const targetId = f.params && f.params.targetId
        if (!targetId) {
          ws.push({ id: f.id, error: { code: -32602, message: 'targetId required' } })
          return
        }
        this.sessionSeq += 1
        SESSION_SEQ += 1
        const sessionId = `S${SESSION_SEQ}`
        this.sessions.set(sessionId, targetId)
        this.attachedTargets.push(targetId)
        if (!this.targets.some((t) => t.targetId === targetId)) {
          this.targets.push({ targetId, type: 'page', url: 'about:blank', title: '', attached: true })
        }
        ws.push({ id: f.id, result: { sessionId } })
        return
      }
      case 'Target.createTarget': {
        const n = this.targets.length + 1
        const targetId = `T${n}`
        this.targets.push({ targetId, type: 'page', url: (f.params && f.params.url) || 'about:blank', title: '', attached: false })
        ws.push({ id: f.id, result: { targetId } })
        return
      }
      case 'Target.closeTarget': {
        const id = f.params && f.params.targetId
        this.targets = this.targets.filter((t) => t.targetId !== id)
        ws.push({ id: f.id, result: { success: true } })
        return
      }
      case 'Target.activateTarget':
        ws.push({ id: f.id, result: {} })
        return
      default: {
        /**
         * ⚠️ 未声明的方法**一律不应答**（保持挂起），并记录在 `undeclared` 里。
         *
         * 早期实现给未知方法回一个 `{}`，后果是：任何"我想让它超时/挂住"
         * 的用例都会被 `pump()` 顺手应答掉（`pump` 会把当时看到的所有命令
         * 都处理一遍），于是 `assert.rejects(..., 超时)` 直接变成
         * "Missing expected rejection"。默认乱应答是**测试自己制造假阳性**
         * 的经典形态。
         *
         * 这里也**不**回一条 -32601：那会把"我故意让它挂着"变成"协议报错"，
         * 同样破坏超时语义。需要报错的用例请显式 `serveError`。
         * 忘记声明的用例用 `assert.deepStrictEqual(server.undeclared, [])` 兜住。
         */
        // ⚠️ 会话校验已在 #handle 开头完成（见那里的说明），这里只处理
        //    "方法未声明"与"故意不应答"两种情况。
        if (!this.declaredMethods.has(f.method)) {
          this.undeclared.push({ method: f.method, id: f.id })
        }
        // 故意不回，交由调用方的超时逻辑处理
      }
    }
  }
}

function makeCdp(overrides = {}) {
  const sockets = []
  const cdp = new Cdp({
    url: 'ws://127.0.0.1:9222/devtools/browser/fake',
    createSocket: (url) => {
      const s = new FakeWebSocket(url)
      sockets.push(s)
      return s
    },
    logger: null,
    ...overrides,
  })
  return {
    cdp,
    sockets,
    ws: () => sockets[sockets.length - 1],
    server: () => new FakeCdpServer(sockets[sockets.length - 1]),
  }
}

/**
 * 构造后构造器是异步发起首次连接的（Promise 链串行化），
 * 因此 socket 要等一个 tick 才存在。
 */
async function makeCdpReady(overrides = {}) {
  const h = makeCdp(overrides)
  for (let i = 0; i < 100 && h.sockets.length === 0; i++) await wait(2)
  assert.ok(h.sockets.length > 0, '构造后应自动发起首次连接')
  return h
}

/** 打开连接并让构造时发出的 enable 帧得到应答 */
async function connected(cdp, ws, server) {
  ws.open()
  await server.waitReady(cdp, ws)
  return server
}

/** 等某个角色的 attach 完成（ensureTab/attach 之后必须 pump 才会被应答） */
async function attachRole(cdp, server, ws, role, targetId) {
  const p = cdp.attach(role, targetId)
  await server.waitForMethod(ws, 'Target.attachToTarget')
  await server.waitReady(cdp, ws)
  return p
}
/**
 * 造一个"自动握手 + 自动应答"的 BrowserHost 依赖集。
 *
 * ⚠️ 为什么需要它：`BrowserHost.create` 内部会 `cdp.connect()` 并等就绪，
 *    而 `Cdp` 只有在 socket **真正 open 并拿到 enable 响应**之后才算就绪。
 *    如果注入的 socket 永远不 open，`create()` 会挂在 15 秒连接超时上
 *    （实测踩过：四条 browser-host 用例全部 15s 超时）。
 *
 * 这里的桩：
 *   · `on('open', fn)` 在第一拍后触发 open；
 *   · 上层的 `sendText`（由 BrowserHost 注入）负责应答 enable 等基础设施命令。
 */
function makeHostSocket() {
  const s = {
    url: 'ws://127.0.0.1/fake',
    sent: [],
    closed: false,
    _listeners: new Map(),
    on(name, fn) {
      if (!this._listeners.has(name)) this._listeners.set(name, [])
      this._listeners.get(name).push(fn)
      if (name === 'open' && !this._opened) {
        this._opened = true
        setTimeout(() => this.emit('open'), 0)
      }
      return this
    },
    emit(name, arg) {
      for (const fn of [...(this._listeners.get(name) || [])]) fn(arg)
    },
    send(text) {
      this.sent.push(text)
      if (this.onSend) setTimeout(this.onSend, 0)
    },
    close() {
      this.closed = true
      this.emit('close', { code: 1000 })
    },
    open() { this._opened = true; this.emit('open') },
    drop() { this.closed = true; this.emitAsync('close', { code: 1006 }) },
    emitAsync(name, arg) { setTimeout(() => this.emit(name, arg), 0) },
    push(obj) { this.emitAsync('message', Buffer.from(JSON.stringify(obj), 'utf8')) },
    frames() { return this.sent.map((x) => JSON.parse(x)) },
    commands() { return this.frames().filter((f) => typeof f.method === 'string') },
    methods() { return this.commands().map((f) => f.method) },
  }
  return s
}

/** 浏览器级 socket 上必须自动应答的基础设施命令（其余按需 route） */
function installHostInfra(socket, opts = {}) {
  const routes = opts.routes || {}
  /**
   * ⚠️ 已应答的 id 必须存在一个**集合**里，不能往解析出来的帧对象上打标记：
   * `frames()` 每次都重新 JSON.parse，标记丢在副本上，于是每来一帧就会把
   * 之前所有帧**再应答一遍**。后果是 `Target.getTargets` 被塞回一堆重复
   * 响应，`isTargetAlive` 读到过期结果 → 明明活着却判死/判活不定，
   * 表现为随机的 15 秒命令超时（实测踩过）。
   */
  const answered = new Set()
  socket.onSend = () => {
    for (const f of socket.frames()) {
      if (answered.has(f.id)) continue
      answered.add(f.id)
      if (routes[f.method]) { routes[f.method](f); continue }
      if (f.method === 'Runtime.enable' || f.method === 'Network.enable' || f.method === 'Page.enable') {
        socket.push({ id: f.id, result: {} })
      } else if (f.method === 'Target.getTargets') {
        socket.push({ id: f.id, result: { targetInfos: (opts.getTargets ? opts.getTargets() : [{ targetId: 'T1', type: 'page', url: 'about:blank', attached: true }]) } })
      } else if (f.method === 'Target.attachToTarget') {
        socket.push({ id: f.id, result: { sessionId: opts.sessionId || 'S1' } })
      } else if (f.method === 'Target.activateTarget' || f.method === 'Target.closeTarget') {
        socket.push({ id: f.id, result: {} })
      }
      // 其余方法故意不应答（由测试按需 route）
    }
  }
  return socket
}

/** BrowserHost.create 的测试用依赖（真实 Store + 桩 socket + 桩 Chrome） */
function hostDeps(socket, overrides = {}) {
  return {
    probePortImpl: async () => false,
    getJsonImpl: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1/fake/devtools/browser/x', Browser: 'FakeChrome' }),
    spawnImpl: () => ({ pid: 999999, on() {}, unref() {} }),
    cdpFactory: (cdpOpts) => new Cdp({ ...cdpOpts, createSocket: () => socket }),
    ...overrides,
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 造一个临时实例目录。
 * ⚠️ 这是**测试自己的**工具：`core/` 不得自己建目录/写盘
 * （锁文件走 host/store.js，见 AGENTS.md §2.9 单写者）。
 */
function tempInstance(prefix = 'dsh-core-') {
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    instanceDir,
    profilePath: path.join(instanceDir, 'chrome-profile'),
    lockPath: path.join(instanceDir, 'browser-host.lock'),
    cleanup: () => {
      try { fs.rmSync(instanceDir, { recursive: true, force: true }) } catch (e) { void e }
    },
  }
}

// ══════════════════════════════════════════════════════════════
// cdp.js：命令相关性
// ══════════════════════════════════════════════════════════════

test('CDP：命令按 id 关联，且能处理乱序响应', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  // ⚠️ 乱序只能靠"延迟应答"来构造：先声明的慢、后声明的快。
  server.serve('Test.alpha', { which: 'a' }, { delayMs: 60 })
  server.serve('Test.beta', { which: 'b' }, { delayMs: 90 })
  server.serve('Test.gamma', { which: 'c' })
  await connected(cdp, w, server)

  const pa = cdp.send('Test.alpha', { n: 1 })
  const pb = cdp.send('Test.beta', { n: 2 })
  const pc = cdp.send('Test.gamma', { n: 3 })

  // 等三条命令都写出去（id 必须各不相同）
  await server.waitFor(w, 3)
  const frames = w.commands().filter((f) => f.method.startsWith('Test.'))
  assert.strictEqual(frames.length, 3, '三条命令都应写出')
  assert.strictEqual(new Set(frames.map((f) => f.id)).size, 3, '每条命令的 id 必须唯一')

  // ⚠️ gamma 最快、beta 最慢 → 响应顺序与发送顺序不同，仍然必须正确配对
  assert.deepStrictEqual(await pc, { which: 'c' })
  assert.deepStrictEqual(await pa, { which: 'a' })
  assert.deepStrictEqual(await pb, { which: 'b' })
  await wait(20)
  assert.deepStrictEqual(server.undeclared, [], '所有命令都应有明确应答声明')
  assert.strictEqual(cdp.pendingCount, 0, '三条命令都应已结算')
  await cdp.close()
})

test('CDP：CDP 协议级 error 转成带归因码的结构化错误', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  server.serveError('Runtime.evaluate', { code: -32000, message: 'Cannot find context' })
  await connected(cdp, w, server)

  /**
   * ⚠️ 断言必须**紧接着** send 挂上，中间不能 await 任何东西。
   * 踩过的坑：写成 `const p = send(); await wait(30); await assert.rejects(p)`
   * —— 那 30ms 里 p 已经 reject 而无人接手，Node 判为未处理拒绝并把它当异常
   * 抛出，测试以"抛出 CdpError"失败，而真正的断言根本没跑到。
   * 这不是被测代码的问题，是测试自己制造的假失败。
   */
  await assert.rejects(cdp.send('Runtime.evaluate', { expression: '1' }), (e) => {
    assert.ok(e instanceof CdpError, '必须是 CdpError')
    assert.strictEqual(e.attribution, ATTRIBUTION.PROTOCOL_ERROR)
    assert.match(e.message, /Cannot find context/)
    assert.strictEqual(e.detail.method, 'Runtime.evaluate')
    return true
  })
  assert.deepStrictEqual(server.undeclared, [], '所有命令都应有明确应答声明')
  assert.strictEqual(cdp.pendingCount, 0, '失败的 pending 条目必须被清掉')
  await cdp.close()
})

// ══════════════════════════════════════════════════════════════
// cdp.js：超时
// ══════════════════════════════════════════════════════════════

test('CDP：命令超时以 cdp_cmd_timeout 拒绝，且不残留 pending 条目', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  await connected(cdp, w, server)

  // 'Test.never' 没有声明应答 → 对端永远不回（这正是超时场景）
  const p = cdp.send('Test.never', {}, { timeoutMs: 60 })
  const sent = await server.waitForMethod(w, 'Test.never') // 确认命令真的写出去了
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.attribution, ATTRIBUTION.CMD_TIMEOUT)
    assert.match(e.message, /超时/)
    assert.strictEqual(e.detail.method, 'Test.never')
    return true
  })
  assert.strictEqual(cdp.pendingCount, 0, '⚠️ 超时后 pending 必须清零（旧代码的 promise 会永远悬着）')

  // 迟到的响应不能把已结算的 promise 再动一次（也不应抛）
  w.push({ id: sent.id, result: { late: true } })
  await wait(20)
  assert.strictEqual(cdp.pendingCount, 0)
  await cdp.close()
})

test('CDP：Page.navigate 默认拿到 30 秒超时，普通命令 15 秒', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  server.serve('Page.navigate', { frameId: 'F1' })
  await connected(cdp, w, server)

  assert.strictEqual(DEFAULT_COMMAND_TIMEOUT_MS, 15000)
  assert.strictEqual(NAVIGATE_TIMEOUT_MS, 30000)
  assert.strictEqual(resolveCommandTimeoutMs('Runtime.evaluate', {}, {}), 15000)
  assert.strictEqual(resolveCommandTimeoutMs('Page.navigate', {}, {}), 30000)
  // 调用方显式给的超时优先
  assert.strictEqual(resolveCommandTimeoutMs('Page.navigate', { timeoutMs: 1234 }, {}), 1234)
  // 配置可覆盖
  assert.strictEqual(resolveCommandTimeoutMs('Runtime.evaluate', {}, { timeoutMs: 20000 }), 20000)
  assert.strictEqual(resolveCommandTimeoutMs('Test.x', {}, { timeoutsByMethod: { 'Test.x': 7000 } }), 7000)
  // ⚠️ 导航的方法级下限不得被全局调小（否则网络稍差就稳定误报失败）
  assert.strictEqual(resolveCommandTimeoutMs('Page.navigate', {}, { timeoutMs: 5000 }), 30000)

  // 真发一条 navigate，走完整链路
  const p = cdp.send('Page.navigate', { url: 'about:blank' })
  const f = await server.waitForMethod(w, 'Page.navigate')
  const r = await p
  assert.strictEqual(r.frameId, 'F1')
  assert.strictEqual(f.method, 'Page.navigate')
  await cdp.close()
})

test('CDP：显式关闭后发命令立即以 cdp_closed 失败，不会静默丢弃', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  await connected(cdp, w, new FakeCdpServer(w))
  await cdp.close()
  await assert.rejects(cdp.send('Runtime.evaluate', { expression: '1' }), (e) => {
    assert.strictEqual(e.attribution, ATTRIBUTION.CLOSED)
    return true
  })
})

// ══════════════════════════════════════════════════════════════
// cdp.js：会话复用（flatten）
// ══════════════════════════════════════════════════════════════

test('CDP：Target.attachToTarget(flatten) 后命令按 sessionId 路由', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  server.serve('Runtime.evaluate', { result: { type: 'number', value: 2 } })
  await connected(cdp, w, server)

  const attachP = cdp.attach('comment', 'TARGET-A')
  await server.waitForMethod(w, 'Target.attachToTarget')
  const sessionId = await attachP
  assert.ok(sessionId, 'attach 必须返回 sessionId')

  // 会话级命令带 sessionId
  const p1 = cdp.send('Runtime.evaluate', { expression: '1+1' }, { role: 'comment' })
  const f1 = await server.waitForMethod(w, 'Runtime.evaluate')
  assert.strictEqual(f1.sessionId, sessionId, '按 role 解析出的命令必须带 sessionId')
  const r1 = await p1
  assert.strictEqual(r1.result.value, 2)

  // 浏览器级命令不带 sessionId（Target.* 只能在浏览器级发）
  const p2 = cdp.send('Target.getTargets', {})
  const f2 = await server.waitForMethod(w, 'Target.getTargets')
  assert.strictEqual(f2.sessionId, undefined, '浏览器级命令不得带 sessionId')
  await p2

  // 未知会话必须报 -32001（证明服务端确实在按会话路由，不是我们自说自话）
  const p3 = cdp.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S-does-not-exist' })
  await assert.rejects(p3, /Session with given id not found/)
  assert.deepStrictEqual(server.undeclared, [], '所有命令都应有明确应答声明')

  assert.strictEqual(cdp.sessionIdOf('comment'), sessionId)
  assert.strictEqual(cdp.targetIdOf('comment'), 'TARGET-A')
  assert.strictEqual(cdp.roleOf('TARGET-A'), 'comment')
  await cdp.close()
})

// ══════════════════════════════════════════════════════════════
// cdp.js：事件分发
// ══════════════════════════════════════════════════════════════

test('CDP：浏览器级事件与会话级事件都能分发，on() 返回可用的退订函数', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  await connected(cdp, w, server)

  const sessionId = await server.attachRole(cdp, w, 'comment', 'TARGET-A')
  assert.ok(sessionId, `第一次 attach 必须返回 sessionId（实际 ${sessionId}）`)
  const otherSession = await server.attachRole(cdp, w, 'live', 'TARGET-B', 2)
  assert.ok(otherSession, `第二次 attach 必须返回 sessionId（实际 ${otherSession}；已发送 ${JSON.stringify(w.methods())}）`)
  assert.notStrictEqual(sessionId, otherSession, '两个角色必须是不同会话')

  const browserHits = []
  const sessionHits = []
  const otherHits = []
  const offBrowser = cdp.on('Target.targetDestroyed', (p, meta) => browserHits.push({ p, meta }))
  const offSession = cdp.on('Runtime.consoleAPICalled', (p) => sessionHits.push(p), { sessionId })
  cdp.on('Runtime.consoleAPICalled', (p) => otherHits.push(p), { role: 'live' })

  // 浏览器级事件（无 sessionId）
  w.push({ method: 'Target.targetDestroyed', params: { targetId: 'T1' } })
  // 会话级事件（带 sessionId）→ 只有订阅了该会话的收到
  w.push({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId })
  // ⚠️ 帧是异步投递的（与真实 WS 一致），断言前必须让出一拍
  await wait(30)

  assert.strictEqual(browserHits.length, 1, `浏览器级事件应恰好收到 1 次（实际 ${browserHits.length}；帧=${JSON.stringify(w.frames().filter((f) => f.method))}）`)
  assert.ok(browserHits[0] && browserHits[0].p, '浏览器级事件应带 params')
  assert.strictEqual(browserHits[0].p.targetId, 'T1')
  assert.ok(browserHits[0].meta, '监听器应拿到 meta')
  assert.strictEqual(browserHits[0].meta.sessionId, null, '浏览器级事件的 meta.sessionId 必须是 null')
  assert.strictEqual(sessionHits.length, 1, '订阅该会话的监听器必须收到')
  assert.strictEqual(sessionHits[0].type, 'log')
  assert.strictEqual(otherHits.length, 0, '⚠️ 别的会话的事件不得串台')

  // 退订后不再收到
  offBrowser()
  offSession()
  w.push({ method: 'Target.targetDestroyed', params: { targetId: 'T2' } })
  w.push({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: otherSession })
  await wait(30)
  assert.strictEqual(browserHits.length, 1, '退订后不应再收到浏览器级事件')
  assert.strictEqual(sessionHits.length, 1, '退订后不应再收到会话级事件')

  // 退订函数幂等
  offBrowser()
  offSession()
  await cdp.close()
})

// ══════════════════════════════════════════════════════════════
// cdp.js：断线重连（本项目最贵的一条回归）
// ══════════════════════════════════════════════════════════════

test('CDP：断线后重连，并**重新发出 Runtime.enable 与 Network.enable**（静默失效回归）', async () => {
  const caps = []
  const { cdp, sockets } = await makeCdpReady({
    reconnectBaseMs: 10,
    maxReconnectDelayMs: 20,
  })
  cdp.onLifecycle('state', (p) => caps.push(p.state))

  const w1 = sockets[0]
  const s1 = new FakeCdpServer(w1)
  await connected(cdp, w1, s1)
  await s1.attachRole(cdp, w1, 'comment', 'TARGET-A')
  /** 断线前的 sessionId —— 用来断言重连后**换过**了一次（而不是沿用旧值）。 */
  const firstSession = cdp.sessionIdOf('comment')
  assert.ok(firstSession, '断线前必须已建立会话，否则本用例的前提不成立')

  // 断线
  w1.drop()
  assert.ok(caps.includes('reconnecting'), `应进入 reconnecting（实际：${caps.join(',')}）`)

  // 等新 socket 出现（指数退避 10ms 起）
  const t0 = Date.now()
  while (sockets.length < 2 && Date.now() - t0 < 2000) await wait(10)
  assert.strictEqual(sockets.length, 2, '断线后必须自动重连（旧代码缺陷 11：无重连）')

  const w2 = sockets[1]
  assert.ok(w2 !== w1, '重连必须建立新连接')
  const s2 = new FakeCdpServer(w2)
  s2.serve('Runtime.evaluate', { result: { type: 'number', value: 2 } })
  w2.open()

  // ⚠️⚠️ 核心断言：重连后**必须**重新 enable 这两个域。
  // 不做的话 Network 嗅探静默停止 → 每条回复都被判"未捕获平台响应"
  // → 按红线 2 只能记 failed/sent_suspected → 商家多发少算、且毫无报错。
  await s2.waitFor(w2, 2)
  await wait(20)
  s2.pump()
  assert.deepStrictEqual(w2.methods().slice(0, 2), ['Runtime.enable', 'Network.enable'],
    `重连后必须先重新启用这两个域（实际：${JSON.stringify(w2.methods())}）`)

  // 重新 attach 回原 targetId（targetId 跨连接稳定）
  await s2.waitForMethod(w2, 'Target.attachToTarget')
  // ⚠️ 等"帧发出"不等于等"响应落地"：响应是异步投递的，attach 的
  //    sessionId 要等客户端处理完那帧才会写回角色记录。
  //    少了这一步就会读到 sessionId=null，把正常流程误判成回归（实测踩过）。
  await s2.waitReady(cdp, w2)
  await wait(40)
  assert.deepStrictEqual(w2.methods().slice(0, 3),
    ['Runtime.enable', 'Network.enable', 'Target.attachToTarget'])
  const attachFrame = w2.commands()[2]
  assert.strictEqual(attachFrame.params.targetId, 'TARGET-A', '必须重新 attach 原 targetId')
  assert.strictEqual(attachFrame.params.flatten, true)

  // 重连后命令能正常走（会话已恢复）
  //
  // ⚠️ 必须按"第 N 次"取帧，不能用 `waitForMethod`（它返回**第一个**匹配）：
  //    重连恢复期间可能已经有别的同名命令发出，取错了就会看到一条不带
  //    sessionId 的旧帧，把"会话已恢复"误判成失败（实测踩过）。
  const newSession = cdp.sessionIdOf('comment')
  assert.ok(newSession, `重连后必须重新 attach 出新的 sessionId（实际 ${newSession}；w2 命令=${JSON.stringify(w2.methods())}；roles=${JSON.stringify([...cdp._sessions.entries()])}）`)
  const beforeCount = w2.commands().filter((f) => f.method === 'Runtime.evaluate').length
  const p = cdp.send('Runtime.evaluate', { expression: '1+1' }, { role: 'comment' })
  const evalFrame = await s2.waitForMethodCount(w2, 'Runtime.evaluate', beforeCount + 1)
  const r = await p
  assert.strictEqual(r.result.value, 2)
  assert.strictEqual(evalFrame.sessionId, newSession,
    `重连后的命令必须带新 sessionId（实际 ${evalFrame.sessionId}，期望 ${newSession}）`)
  // ⚠️ 断言方式很重要：`sessionId` 是 FakeCdpServer 的**全局**计数器产物
  //    （S1/S2/S3… 跨用例累加），所以写死 `=== 'S2'` 会因为前面用例多挂过
  //    几次 attach 而随机失败——那是**测试自身的脆弱**，不是被测行为的问题。
  //    真正要验的命题有两条，都不依赖具体编号：
  //      ① 重连后确实**换过**一次 sessionId（旧的在断线时已失效）
  //      ② 新值确实被记进了角色映射（否则命令会不带 sessionId 发出去）
  const oldSession = firstSession
  assert.ok(newSession !== oldSession,
    `重连必须重新 attach：新 sessionId 不得沿用旧的（旧 ${oldSession}，新 ${newSession}）`)
  assert.match(String(newSession), /^S\d+$/, 'sessionId 必须来自服务端的 attach 结果')
  assert.strictEqual(cdp.sessionIdOf('comment'), newSession, '角色映射必须指向新会话')

  assert.ok(caps.includes('open'), '重连成功后状态应回到 open')
  await cdp.close()
})

test('CDP：退避序列为 1s/2s/4s/8s…且上限 60s', () => {
  assert.strictEqual(reconnectDelayMs(1), 1000)
  assert.strictEqual(reconnectDelayMs(2), 2000)
  assert.strictEqual(reconnectDelayMs(3), 4000)
  assert.strictEqual(reconnectDelayMs(4), 8000)
  assert.strictEqual(reconnectDelayMs(5), 16000)
  assert.strictEqual(reconnectDelayMs(6), 32000)
  assert.strictEqual(reconnectDelayMs(7), 60000, '不得超过 60 秒上限')
  assert.strictEqual(reconnectDelayMs(100), 60000)
  // ⚠️ 不允许出现 Infinity（会给 setTimeout 一个退化值 → 疯狂重连）
  assert.ok(Number.isFinite(reconnectDelayMs(1e6)))
})

test('CDP：socket 断开时在途命令被立即拒绝（不留悬空 promise）', async () => {
  const { cdp, sockets, ws } = await makeCdpReady({ autoReconnect: false })
  const w = ws()
  const server = new FakeCdpServer(w)
  await connected(cdp, w, server)

  const p1 = cdp.send('Test.never1', {})
  await server.waitForMethod(w, 'Test.never1')
  const p2 = cdp.send('Test.never2', {})
  await server.waitForMethod(w, 'Test.never2')
  assert.strictEqual(cdp.pendingCount, 2)

  w.drop()

  for (const p of [p1, p2]) {
    await assert.rejects(p, (e) => {
      assert.strictEqual(e.attribution, ATTRIBUTION.SOCKET_CLOSED)
      assert.strictEqual(e.retryable, true, '断线导致的失败必须可重试（任务退回队列）')
      return true
    })
  }
  assert.strictEqual(cdp.pendingCount, 0, '⚠️ 断线后 pendingCount 必须为 0')
  await cdp.close()
})

// ══════════════════════════════════════════════════════════════
// cdp.js：关闭幂等 + 响应体环
// ══════════════════════════════════════════════════════════════

test('CDP：close() 幂等且不抛', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  await connected(cdp, w, new FakeCdpServer(w))

  await cdp.close()
  await cdp.close()
  await cdp.close()
  assert.strictEqual(cdp.isConnected, false)
  assert.strictEqual(cdp.engineState.closed, true)
  assert.strictEqual(cdp.engineState.pending_count, 0)
  // 关闭后再 close 不应抛，也不应重复广播 closed
  let closedEvents = 0
  cdp.onLifecycle('closed', () => { closedEvents += 1 })
  await cdp.close()
  assert.strictEqual(closedEvents, 0, '已关闭的实例不应再广播 closed')
})

test('CDP：Network 响应体在 loadingFinished 时立刻抓取并进入环', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  server.route('Network.getResponseBody', (f) => {
    w.push({ id: f.id, result: { body: JSON.stringify({ status_code: 0, extra: 'x' }), base64Encoded: false } })
    return 'handled'
  })
  await connected(cdp, w, server)

  const t0 = Date.now()
  w.push({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'R1', request: { url: 'https://example.invalid/api/thing', method: 'POST', postData: 'a=1' } },
  })
  w.push({
    method: 'Network.responseReceived',
    params: { requestId: 'R1', response: { url: 'https://example.invalid/api/thing', status: 200, mimeType: 'application/json' } },
  })
  w.push({ method: 'Network.loadingFinished', params: { requestId: 'R1', encodedDataLength: 42 } })

  const hit = await cdp.waitForResponse({ urlPattern: '/api/thing', timeoutMs: 1500, sinceMs: t0 })
  assert.strictEqual(hit.status, 200)
  assert.match(hit.body, /"status_code":0/)
  assert.strictEqual(hit.method, 'POST')
  assert.strictEqual(hit.postData, 'a=1')

  // 匹配规则：子串 / 正则 / 谓词
  assert.strictEqual(cdp.findCapturedResponses('/api/thing').length, 1)
  assert.strictEqual(cdp.findCapturedResponses(/api\/thi/).length, 1)
  assert.strictEqual(cdp.findCapturedResponses((u) => u.includes('example.invalid')).length, 1)
  assert.strictEqual(cdp.findCapturedResponses('不存在的片段').length, 0)

  // 拿不到响应体时必须**明确失败**，不得退化成"成功但空 body"
  await assert.rejects(
    cdp.waitForResponse({ urlPattern: '/never-happened', timeoutMs: 80, sinceMs: t0 }),
    (e) => {
      assert.strictEqual(e.attribution, ATTRIBUTION.CMD_TIMEOUT)
      assert.ok(Array.isArray(e.detail.recent_urls), '必须回传最近捕获的 URL，便于区分"风控"与"关键字写错"')
      return true
    }
  )

  cdp.clearCapturedResponses()
  assert.strictEqual(cdp.capturedResponses.length, 0)
  await cdp.close()
})

test('CDP：Runtime.evaluate 的页面异常转成结构化错误（不是裸字符串）', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  server.route('Runtime.evaluate', (f) => {
    w.push({
      id: f.id,
      result: {
        result: { type: 'object', subtype: 'error', description: 'TypeError: x is not a function\n    at <anonymous>:1:1' },
        exceptionDetails: { text: 'Uncaught', lineNumber: 0, columnNumber: 12, exception: { description: 'TypeError: x is not a function' } },
      },
    })
    return 'handled'
  })
  await connected(cdp, w, server)
  await server.attachRole(cdp, w, 'comment', 'TARGET-A')

  await assert.rejects(cdp.evaluate('comment', 'x()'), (e) => {
    assert.strictEqual(e.attribution, ATTRIBUTION.EVALUATE_EXCEPTION)
    assert.match(e.message, /TypeError/)
    assert.strictEqual(e.detail.role, 'comment')
    assert.ok(!String(e.detail.description_head).includes('\n'), '只带首行摘要，不外传完整堆栈')
    return true
  })
  await cdp.close()
})

// ══════════════════════════════════════════════════════════════
// cdp.js：分帧读取器（ipc 与 cdp 共用的边界逻辑）
// ══════════════════════════════════════════════════════════════

test('CDP：无法解析的帧被丢弃并归因，连接仍可用（不静默截断）', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  await connected(cdp, w, server)
  const before = cdp.engineState.state
  // 直接推一个坏 JSON 帧
  w.emitAsync('message', Buffer.from('{这不是 JSON}\n', 'utf8'))
  await wait(20)
  assert.strictEqual(cdp.engineState.state, before, '坏帧不得改变连接状态')
  // 坏帧之后连接必须仍可用（一次性坏帧不能毁掉整条通道）
  const p = cdp.send('Target.getTargets', {})
  await server.waitForMethod(w, 'Target.getTargets')
  const ok = await p
  assert.ok(ok)
  await cdp.close()})

// ══════════════════════════════════════════════════════════════
// browser-host.js：纯函数与独占性
// ══════════════════════════════════════════════════════════════

test('browser-host：Chrome 启动参数包含全部必需的旗子（含反自动化指纹）', () => {
  const args = host.buildChromeArgs({
    profilePath: path.join('instances', 'acc1', 'chrome-profile'),
    debugPort: 9223,
    startUrl: 'about:blank',
  })
  assert.ok(args.includes('--remote-debugging-port=9223'), '必须有调试端口')
  assert.ok(args.includes(`--user-data-dir=${path.join('instances', 'acc1', 'chrome-profile')}`), '必须有独立 profile')
  // ⚠️ 没有这一条，浏览器带自动化指纹 → 商家已登录的账号等于白搭
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'), '必须去掉自动化指纹')
  assert.ok(args.includes('--no-first-run'))
  assert.ok(args.includes('--no-default-browser-check'))
  assert.ok(args.includes('--start-maximized'), '窗口必须可见（验证码要人工处理）')
  assert.strictEqual(args[args.length - 1], 'about:blank', '起始 URL 必须在最后')
  // 不得出现被否决的方案痕迹
  assert.ok(!args.some((a) => /puppeteer|playwright|headless/i.test(a)), '不得引入自动化框架或 headless')
  // 额外参数可注入
  const args2 = host.buildChromeArgs({ profilePath: 'p', debugPort: 1, extraArgs: ['--lang=zh-CN'] })
  assert.ok(args2.includes('--lang=zh-CN'))
})

test('browser-host：probePort 能区分"端口被占"与"端口空闲"', async () => {
  const server = net.createServer(() => { /* 只占位，不回任何东西 */ })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    assert.strictEqual(await host.probePort(port), true, '有监听者应返回 true')
  } finally {
    await new Promise((r) => server.close(r))
  }
  // 刚关掉的端口：正常返回 false（ECONNREFUSED → false）
  const free = await host.probePort(port, '127.0.0.1', 300)
  assert.strictEqual(free, false, '端口空闲应返回 false')
})

test('browser-host：同一实例第二个 host 必须被拒绝（进程内独占）', async () => {
  const t = tempInstance('dsh-host-lock-')
  const cfg = { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19222, chromePath: '/fake/chrome' }
  const sock = installHostInfra(makeHostSocket())
  const deps = hostDeps(sock)
  const h1 = await host.BrowserHost.create({ config: cfg, ...deps })
  try {
    assert.strictEqual(fs.existsSync(t.lockPath), true, '必须落独占锁文件')
    assert.ok(sock.commands().some((f) => f.method === 'Runtime.enable'), '应已连上并启用域')
    await assert.rejects(
      host.BrowserHost.create({ config: cfg, ...deps }),
      (e) => {
        assert.strictEqual(e.code, host.HOST_ATTRIBUTION.ALREADY_HOSTED)
        assert.match(e.message, /ipc/i, '错误信息必须告诉调用方改用 IPC')
        return true
      }
    )
    // ⚠️ 失败的第二次创建不得把**活着**的 h1 从进程内注册表里摘掉
    assert.strictEqual(host.hosts.get(host.hostKey(t.instanceDir, 19222)), h1,
      '启动失败的一方不得摘除别人的登记（否则进程内独占失效）')
  } finally {
    await h1.close()
  }
  // 关闭后应能重新创建（锁与 store 登记都已释放）
  const sock2 = installHostInfra(makeHostSocket())
  const h2 = await host.BrowserHost.create({ config: cfg, ...hostDeps(sock2) })
  assert.strictEqual(fs.existsSync(t.lockPath), true)
  await h2.close()
  assert.strictEqual(fs.existsSync(t.lockPath), false, '关闭后必须释放锁')
  t.cleanup()
})

test('browser-host：检测到别的进程持有实例锁时拒绝启动（跨进程独占）', async () => {
  const t = tempInstance('dsh-host-xproc-')
  const { Store } = require('../../client/host/store')
  const store = new Store({ dir: t.instanceDir })

  // 找一个"确实活着"的其他 pid（当前 pid 会被视为自己，不触发拒绝）
  const candidates = [process.ppid, 4, 1000, 1234, 5678, 20000]
  const livePid = candidates.find((p) => Number.isInteger(p) && p > 0 && p !== process.pid && host.isProcessAlive(p))
  if (!livePid) {
    store.close()
    t.cleanup()
    return // 环境里找不到别的活进程：跳过（不能伪造，否则测试自己就是错的）
  }
  const r = store.createExclusive('browser-host.lock', JSON.stringify({ pid: livePid, port: 19223, instance_dir: t.instanceDir }))
  assert.strictEqual(r.ok, true, '测试前置：锁文件必须写入成功')
  store.close()

  try {
    await assert.rejects(
      host.BrowserHost.create({
        config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19223, chromePath: '/fake/chrome' },
        probePortImpl: async () => false,
        getJsonImpl: async () => ({ webSocketDebuggerUrl: 'ws://x/y' }),
        spawnImpl: () => ({ pid: 1, on() {}, unref() {} }),
        cdpFactory: () => new Cdp({ url: 'ws://x/y', createSocket: () => new FakeWebSocket('x') }),
      }),
      (e) => {
        assert.strictEqual(e.code, host.HOST_ATTRIBUTION.ALREADY_HOSTED)
        assert.match(e.message, new RegExp(String(livePid)))
        return true
      }
    )
  } finally {
    t.cleanup()
  }
})

test('browser-host：损坏的锁文件按失效锁回收，但必须留痕（不静默）', async () => {
  const t = tempInstance('dsh-host-corrupt-')
  const { Store } = require('../../client/host/store')
  const store = new Store({ dir: t.instanceDir })
  store.createExclusive('browser-host.lock', '{这不是合法 JSON')
  store.close()

  const logs = []
  const logger = {
    debug: (e, d) => logs.push({ level: 'debug', e, d }),
    info: (e, d) => logs.push({ level: 'info', e, d }),
    warn: (e, d) => logs.push({ level: 'warn', e, d }),
    error: (e, d) => logs.push({ level: 'error', e, d }),
  }
  const h = await host.BrowserHost.create({
    config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19227, chromePath: '/fake/chrome' },
    logger,
    ...hostDeps(installHostInfra(makeHostSocket())),
  })
  try {
    assert.ok(logs.some((l) => l.e === 'browser_host_lock_corrupt'), '锁损坏必须留痕，不得静默回收')
    assert.ok(logs.some((l) => l.e === 'browser_host_lock_stale'))
    assert.strictEqual(h.lockAcquired, true, '回收后应成功取得锁')
  } finally {
    await h.close()
    t.cleanup()
  }
})

test('browser-host：端口被非 Chrome 程序占用时必须大声失败，不得默默复用', async () => {
  const t = tempInstance('dsh-host-port-')
  try {
    await assert.rejects(
      host.BrowserHost.create({
        config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19224, chromePath: '/fake/chrome' },
        probePortImpl: async () => true,                 // 端口被占
        getJsonImpl: async () => { throw new Error('HTTP 404') }, // 但不是调试端点
      }),
      (e) => {
        assert.strictEqual(e.code, host.HOST_ATTRIBUTION.PORT_OCCUPIED_BY_OTHER)
        assert.match(e.message, /19224/)
        return true
      }
    )
    assert.strictEqual(fs.existsSync(t.lockPath), false,
      '启动失败必须释放独占锁（否则一次偶发失败会变成永久故障）')
  } finally {
    t.cleanup()
  }
})

test('browser-host：tab 消失 → 抛可重排队错误（requeue=true，不是 failed）', async () => {
  const t = tempInstance('dsh-host-tab-')
  // ⚠️ 真实 Store（锁走 host/store.js）+ 桩 socket：socket 自己会 open，
  //    避免 create() 卡在 15 秒连接超时上。
  const state = { created: false, alive: true }
  const sock = installHostInfra(makeHostSocket(), {
    getTargets: () => (state.created && state.alive
      ? [{ targetId: 'T1', type: 'page', url: 'about:blank', attached: true }]
      : []),
    routes: {
      'Target.createTarget': (f) => {
        state.created = true
        state.alive = true
        sock.push({ id: f.id, result: { targetId: 'T1' } })
      },
    },
  })
  const h = await host.BrowserHost.create({
    config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19225, chromePath: '/fake/chrome' },
    ...hostDeps(sock),
  })
  try {
    // 未经 ensureTab 就操作：应报"可重排队"
    await assert.rejects(h.click('comment', '#x'), (e) => {
      assert.strictEqual(e.code, host.RETRYABLE_REQUEUE)
      assert.strictEqual(e.requeue, true, '⚠️ 标签页消失必须让调度器把任务退回队列，而不是记 failed')
      return true
    })

    // ensureTab 建页 → 必须走 createTarget → getTargets → attach(flatten)
    const ensured = await h.ensureTab('comment', 'about:blank', { initialWaitMs: 0, pollMax: 3 })
    assert.strictEqual(ensured.targetId, 'T1')
    const attach = sock.commands().find((f) => f.method === 'Target.attachToTarget')
    assert.ok(attach, `必须 attach 到目标（实际命令：${sock.methods().join(',')}）`)
    assert.strictEqual(attach.params.flatten, true, '必须用 flatten 模式（不开第二条 WS）')
    assert.strictEqual(host.hosts.get(host.hostKey(t.instanceDir, 19225)), h)

    // ⚠️ 关键：一个实例**只能有一条** CDP WebSocket（旧代码 6 条互相争抢）
    assert.strictEqual(sock.commands().filter((f) => f.method === 'Runtime.enable').length, 1,
      '不得出现第二次 enable —— 那意味着开了第二条连接')

    // tab 被外部关掉 → 再操作必须 requeue
    state.alive = false
    await assert.rejects(h.evaluate('comment', '1+1'), (e) => {
      assert.strictEqual(e.code, host.RETRYABLE_REQUEUE)
      assert.strictEqual(e.requeue, true)
      return true
    })
  } finally {
    await h.close()
    t.cleanup()
  }
})

test('browser-host：未知 IPC op 返回结构化错误而不是崩溃', async () => {
  const fakeHost = { listTabs: async () => [] }
  const r = await host.handleOp(fakeHost, 'no_such_op', {})
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.error.attribution, host.HOST_ATTRIBUTION.UNSUPPORTED_OP)
  assert.ok(Array.isArray(r.error.detail.supported))
  assert.ok(r.error.detail.supported.includes('evaluate'))

  // 已登记的 op 正常执行；op 内部抛错时错误带归因码
  const ok = await host.handleOp(fakeHost, 'list_tabs', {})
  assert.strictEqual(ok.ok, true)
  assert.deepStrictEqual(ok.result, [])

  const bad = await host.handleOp({ engineState: () => { throw new Error('boom') } }, 'engine_state', {})
  assert.strictEqual(bad.ok, false)
  assert.match(bad.error.message, /boom/)
  assert.ok(bad.error.attribution, 'IPC 错误必须带归因码')
})

test('browser-host：DOM 稳定判定的返回值钉死"不是 sent_confirmed"', async () => {
  const t = tempInstance('dsh-host-dom-')
  const sock = installHostInfra(makeHostSocket(), {
    routes: {
      'Runtime.evaluate': (f) => {
        sock.push({
          id: f.id,
          result: { result: { type: 'string', value: JSON.stringify({ ok: true, visibleCount: 1, candidateCount: 1, sample: '固定文本' }) } },
        })
      },
    },
  })
  const h = await host.BrowserHost.create({
    config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19226, chromePath: '/fake/chrome' },
    ...hostDeps(sock),
  })
  try {
    h.cdp.registerSession('comment', 'T1', 'S1')
    h.roles.set('comment', 'T1')

    const r = await h.waitForNodeStable('comment', { selector: '#reply', stableMs: 60, pollMs: 20 })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.verdict_hint, 'sent_confirmed_dom', '⚠️ DOM 稳定只能映射到 sent_confirmed_dom')
    assert.strictEqual(r.confirm_signal, 'dom_stable')
    assert.strictEqual(r.billable, false, '⚠️ DOM 判定不得计费（红线 2）')
    assert.match(r.note, /不得作为 sent_confirmed/, '判定口径必须写在返回值里，防止上层图省事当成功')
  } finally {
    await h.close()
    t.cleanup()
  }
})

test('browser-host：响应游标单调递增，sinceCursor 优先于 sinceMs', async () => {
  const t = tempInstance('dsh-host-cursor-')
  const sock = installHostInfra(makeHostSocket(), {
    routes: {
      'Network.getResponseBody': (f) => { sock.push({ id: f.id, result: { body: '{"status_code":0}', base64Encoded: false } }) },
    },
  })
  const h = await host.BrowserHost.create({
    config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19228, chromePath: '/fake/chrome' },
    ...hostDeps(sock),
  })
  try {
    assert.strictEqual(h.responseCursor(), 0, '空环游标应为 0')
    const cursor0 = h.responseCursor()

    // 注入一条"开始捕获之前"的响应 → 用 cursor0 划窗口时必须**看不到**它
    sock.push({ method: 'Network.requestWillBeSent', params: { requestId: 'OLD', request: { url: 'https://x.invalid/old', method: 'POST' } } })
    sock.push({ method: 'Network.responseReceived', params: { requestId: 'OLD', response: { url: 'https://x.invalid/old', status: 200 } } })
    sock.push({ method: 'Network.loadingFinished', params: { requestId: 'OLD' } })
    await wait(40)
    assert.strictEqual(h.responseCursor(), 1, '捕获到 1 条后游标应变成 1')
    assert.strictEqual(h.capturedResponses().length, 1)
    await assert.rejects(
      h.waitForResponse({ urlPattern: '/old', sinceCursor: cursor0 + 1, timeoutMs: 80 }),
      (e) => {
        // ⚠️ browser-host 会把 cdp 的归因码原样透传（cdp_cmd_timeout），
        //    结构化的 detail 必须保留下来用于排障。
        assert.strictEqual(e.code, ATTRIBUTION.CMD_TIMEOUT)
        assert.strictEqual(e.detail.since_cursor, cursor0 + 1, '错误里必须带上游标，便于判断窗口是否划错')
        return true
      }
    )

    // ⚠️ stopResponseCapture 必须幂等：平台层在 finally 里盲调
    const s1 = await h.stopResponseCapture()
    const s2 = await h.stopResponseCapture()
    assert.strictEqual(s2.already_stopped, true, '重复 stop 必须成功返回（幂等）')
    assert.ok(s1.captured >= 1)
  } finally {
    await h.close()
    t.cleanup()
  }
})

test('browser-host：坐标读取表达式含可见性判定与滚动合并（平台知识 §1.2 / §2.1）', () => {
  const withScroll = host.elementRectExpression('#x', { scrollIntoView: true })
  assert.match(withScroll, /getBoundingClientRect/)
  assert.match(withScroll, /scrollIntoView/)
  assert.match(withScroll, /width > 0 && r\.height > 0/, '必须做非零尺寸判定（隐藏结构里按钮尺寸为 0）')
  assert.match(withScroll, /candidateCount/, '必须回传候选数量，便于区分改版与未命中')
  // 不滚动版本：第二轮重读坐标时不得再滚动（否则列表一直重渲染）
  assert.ok(!/scrollIntoView/.test(host.elementRectExpression('#x', { scrollIntoView: false })))
  // 滚动表达式：只允许参数化的选择器，不得出现具体站点选择器
  const scroll = host.scrollExpression('#container', 2000)
  assert.match(scroll, /scrollTop/)
  assert.match(scroll, /atBottom/)
})

test('browser-host：默认输入计划分段且段间停顿在 1~3 秒', () => {
  const plan = host.defaultTypingPlan('这是一条测试回复文案')
  assert.ok(plan.length >= 2, '必须分段输入（一次性插入不产生键盘事件）')
  assert.strictEqual(plan.map((p) => p.text).join(''), '这是一条测试回复文案', '分段拼接必须等于原文')
  for (const seg of plan) {
    assert.ok(seg.delayMs >= 1000 && seg.delayMs <= 3000, `段间停顿必须在 1~3 秒（实际 ${seg.delayMs}）`)
  }
  assert.deepStrictEqual(host.defaultTypingPlan(''), [])
})

test('browser-host：samePage 按 hostname 边界比较（不用 includes 域名）', () => {
  // ⚠️ 旧代码缺陷 19：includes('域名') 会把 evil-<域名>.attacker.cn 也算命中
  assert.strictEqual(host.samePage('https://a.example.com/video/1', 'https://a.example.com/video/1?x=2'), true)
  assert.strictEqual(host.samePage('https://a.example.com/video/1/', 'https://a.example.com/video/1'), true)
  assert.strictEqual(host.samePage('https://evil-a.example.com.attacker.cn/video/1', 'https://a.example.com/video/1'), false)
  assert.strictEqual(host.samePage('https://a.example.com/video/1', 'https://a.example.com/video/2'), false)
  assert.strictEqual(host.samePage('about:blank', 'about:blank'), true)
})

test('browser-host：waitForTarget 先固定等再轮询（legacy 的新建标签页协议）', async () => {
  let calls = 0
  const t0 = Date.now()
  const r = await host.waitForTarget({
    listTargets: async () => {
      calls += 1
      return calls >= 2 ? [{ targetId: 'T1', type: 'page' }] : []
    },
    targetId: 'T1',
    attempts: 5,
    intervalMs: 5,
    initialWaitMs: 30,
  })
  assert.strictEqual(r.ok, true)
  assert.ok(Date.now() - t0 >= 30, '必须先固定等待（立即 attach 在真机上会偶发失败）')
})

// ══════════════════════════════════════════════════════════════
// ipc.js：分帧
// ══════════════════════════════════════════════════════════════

test('IPC：分片与粘连的帧都能正确重组（NDJSON 的核心）', async () => {
  /**
   * ⚠️ 分帧必须测在 `createFrameReader` 这一层，**不能**靠"往连接的
   *    up 流里手写字节"：那是双向流，服务端和客户端**都**在监听同一个
   *    流，手写的请求字节会被客户端自己的读端再吃一遍 → 同一请求处理两次。
   *    这是测试构造错误，不是被测代码的缺陷（实测踩过）。
   *    这里两层都测：分帧器单测 + 真实两端的往返。
   */
  const frames = []
  const errors = []
  const reader = ipc.createFrameReader({
    maxFrameBytes: 4096,
    onFrame: (m) => frames.push(m),
    onError: (e) => errors.push(e),
  })

  // 一条帧被拆成 3 段写入
  const raw = JSON.stringify({ id: 101, op: 'split', args: { v: 'x'.repeat(50) } }) + '\n'
  reader.push(raw.slice(0, 10))
  reader.push(raw.slice(10, 30))
  reader.push(raw.slice(30))
  // 两条帧粘在一个 chunk 里
  reader.push(JSON.stringify({ id: 102, op: 'joined_a', args: {} }) + '\n'
    + JSON.stringify({ id: 103, op: 'joined_b', args: {} }) + '\n')
  // 空行必须被忽略（写端可能插空行）
  reader.push('\n')
  // 半条帧留在缓冲里，不能提前投递
  reader.push('{"id":104,"op":"partial"')

  assert.strictEqual(errors.length, 0, `不应有分帧错误：${JSON.stringify(errors.map((e) => e.attribution))}`)
  assert.deepStrictEqual(frames.map((f) => f.op), ['split', 'joined_a', 'joined_b'],
    '分片与粘连都只应产生一条请求；空行不产生请求；半条帧不得提前投递')
  assert.strictEqual(frames[0].args.v.length, 50, '被拆分的帧内容必须完整还原')
  assert.ok(reader.stats().buffered > 0, '未闭合的半条帧应留在缓冲区里等后续字节')
  assert.strictEqual(reader.stats().frames, 3)

  // 补齐后半条 → 立刻投递
  reader.push('}\n')
  assert.deepStrictEqual(frames.map((f) => f.op), ['split', 'joined_a', 'joined_b', 'partial'])
  assert.strictEqual(reader.stats().buffered, 0)

  // 真实两端的往返（保证上面测的分帧器确实被两端用上）
  const pair = ipc.createInProcessPair({ onRequest: async (op) => ({ echoed: op }), timeoutMs: 1000 })
  try {
    assert.deepStrictEqual(await pair.client.request('round_trip', {}), { echoed: 'round_trip' })
    assert.strictEqual(pair.server.stats().frames, 1, '一次请求应恰好产生一条帧')
  } finally {
    await pair.close()
  }
})

test('IPC：单帧超过上限 → 客户端硬失败，服务端也硬失败（不静默截断）', async () => {
  const pair = ipc.createInProcessPair({
    onRequest: async () => 'never',
    timeoutMs: 1000,
    logger: null,
  })
  try {
    // 客户端侧：超过上限直接拒绝，且**不写出**任何东西
    await assert.rejects(
      pair.client.request('big', { blob: 'z'.repeat(ipc.MAX_FRAME_BYTES + 10) }),
      (e) => {
        assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.FRAME_TOO_LARGE)
        assert.strictEqual(e.retryable, false)
        return true
      }
    )
    assert.strictEqual(pair.up.writableLength, 0, '超限帧不得被写出去')
  } finally {
    await pair.close()
  }

  // 服务端侧：直接注入一条超长帧（模拟老版本/故障对端）
  const errors = []
  const frames = []
  const reader = ipc.createFrameReader({
    maxFrameBytes: 128,
    onFrame: (m) => frames.push(m),
    onError: (e) => errors.push(e),
  })
  reader.push(JSON.stringify({ id: 1, op: 'x', args: { big: 'y'.repeat(500) } }) + '\n')
  assert.strictEqual(errors.length, 1)
  assert.strictEqual(errors[0].attribution, ipc.IPC_ATTRIBUTION.FRAME_TOO_LARGE)
  assert.strictEqual(frames.length, 0, '超限帧不得被当成合法帧投递')

  // "永远不发换行"也必须被判失败，否则可以用它撑爆内存
  const errors2 = []
  const reader2 = ipc.createFrameReader({ maxFrameBytes: 64, onFrame: () => {}, onError: (e) => errors2.push(e) })
  reader2.push('a'.repeat(200))
  assert.strictEqual(errors2.length, 1)
  assert.strictEqual(errors2[0].attribution, ipc.IPC_ATTRIBUTION.FRAME_TOO_LARGE)

  // 坏 JSON 单独归因
  const errors3 = []
  const reader3 = ipc.createFrameReader({ maxFrameBytes: 1024, onFrame: () => {}, onError: (e) => errors3.push(e) })
  reader3.push('{不是 JSON}\n')
  assert.strictEqual(errors3[0].attribution, ipc.IPC_ATTRIBUTION.BAD_FRAME)
})

test('IPC：按 id 关联请求与响应（含乱序）', async () => {
  const order = []
  const pair = ipc.createInProcessPair({
    onRequest: async (op) => {
      order.push(op)
      // 故意让先到的请求后返回，制造乱序
      await wait(op === 'slow' ? 60 : 5)
      return { op, at: op === 'slow' ? 'late' : 'early' }
    },
    timeoutMs: 1000,
  })
  try {
    const pSlow = pair.client.request('slow', {})
    const pFast = pair.client.request('fast', {})
    const fast = await pFast
    const slow = await pSlow
    assert.deepStrictEqual(fast, { op: 'fast', at: 'early' })
    assert.deepStrictEqual(slow, { op: 'slow', at: 'late' })
    assert.deepStrictEqual(order, ['slow', 'fast'], '服务端收到顺序应与发送顺序一致')
    assert.strictEqual(pair.client.pendingCount, 0)
  } finally {
    await pair.close()
  }
})

test('IPC：请求超时以 ipc_timeout 拒绝，且不残留 pending', async () => {
  const pair = ipc.createInProcessPair({
    onRequest: async () => { await wait(500); return 'too-late' },
    timeoutMs: 60,
  })
  try {
    await assert.rejects(pair.client.request('hangs', {}), (e) => {
      assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.TIMEOUT)
      assert.match(e.message, /hangs/)
      assert.strictEqual(e.retryable, true)
      return true
    })
    assert.strictEqual(pair.client.pendingCount, 0, '超时后必须清掉 pending 条目')
  } finally {
    await pair.close()
  }
})

test('IPC：不支持的操作返回结构化错误（带归因码），且不崩服务端', async () => {
  const pair = ipc.createInProcessPair({
    onRequest: async (op) => {
      if (op !== 'known') {
        const e = new Error(`不支持的浏览器操作：${op}`)
        e.attribution = ipc.IPC_ATTRIBUTION.UNSUPPORTED_OP
        e.detail = { op }
        throw e
      }
      return 'fine'
    },
    timeoutMs: 1000,
  })
  try {
    const ok = await pair.client.request('known', {})
    assert.strictEqual(ok, 'fine')

    await assert.rejects(pair.client.request('nope', {}), (e) => {
      assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.UNSUPPORTED_OP)
      assert.match(e.message, /不支持的浏览器操作/)
      assert.deepStrictEqual(e.detail, { op: 'nope' })
      return true
    })

    // 服务端仍然可用（一次错误 op 不能把宿主打死）
    assert.strictEqual(await pair.client.request('known', {}), 'fine')

    // 非 Error 抛出（例如字符串）也必须带归因码，不能裸奔
    await assert.rejects(
      ipc.createInProcessPair({ onRequest: async () => { throw 'plain-string' }, timeoutMs: 500 })
        .client.request('x', {}),
      (e) => {
        assert.ok(e.attribution, '任何 IPC 失败都必须有归因码')
        return true
      }
    )
  } finally {
    await pair.close()
  }
})

test('IPC：对端关闭时在途请求被拒绝，而不是永远挂着', async () => {
  const pair = ipc.createInProcessPair({
    onRequest: async () => { await wait(5000); return 'never' },
    timeoutMs: 5000,
  })
  const p = pair.client.request('hangs', {})
  await wait(20)
  assert.strictEqual(pair.client.pendingCount, 1)
  pair.down.end()   // 服务端 → 客户端 的方向断掉
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.PEER_CLOSED)
    return true
  })
  assert.strictEqual(pair.client.pendingCount, 0)
  await pair.close()
})

test('IPC：close() 幂等，关闭后请求立即失败', async () => {
  const pair = ipc.createInProcessPair({ onRequest: async () => 1, timeoutMs: 200 })
  await pair.close()
  await pair.close()
  await assert.rejects(pair.client.request('x', {}), (e) => {
    assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.CLIENT_CLOSED)
    return true
  })
})

test('IPC：createIpcServer/createIpcClient 参数缺失时报带归因码的错误', () => {
  assert.throws(() => ipc.createIpcServer({}), (e) => {
    assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.BAD_ARGS)
    return true
  })
  assert.throws(() => ipc.createIpcServer({ stream: new PassThrough() }), /onRequest/)
  assert.throws(() => ipc.createIpcClient({}), (e) => {
    assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.BAD_ARGS)
    return true
  })
})

test('IPC：encodeFrame 超限抛错、正常帧以换行结尾', () => {
  assert.strictEqual(ipc.encodeFrame({ a: 1 }), '{"a":1}\n')
  assert.throws(() => ipc.encodeFrame({ big: 'x'.repeat(100) }, 32), (e) => {
    assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.FRAME_TOO_LARGE)
    return true
  })
  // 循环引用：必须是可读的结构化错误，不是 TypeError 裸奔
  const cyc = {}
  cyc.self = cyc
  assert.throws(() => ipc.encodeFrame(cyc), (e) => {
    assert.strictEqual(e.attribution, ipc.IPC_ATTRIBUTION.BAD_ARGS)
    return true
  })
})

// ══════════════════════════════════════════════════════════════
// 源码级回归：选择器唯一来源 + 唯一 WS 构造点
// ══════════════════════════════════════════════════════════════

function collectJsFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'legacy') continue
      out.push(...collectJsFiles(p))
    } else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

test('回归：client/core 不得含任何抖音知识（选择器/域名/接口片段）', () => {
  // ⚠️ 命令要求的原始判据：
  //    grep -iE "data-e2e|douyin|comment/publish|live/comment/send|im/send" client/core/ 必须为空
  // 这里补齐同类泄漏面（属性、类名、品牌色、平台接口白名单片段）。
  const BANNED = [
    /data-e2e/i,
    /data-sec-uid/i,
    /data-secuid/i,
    /comment-list/i,
    /comment-item/i,
    /comment-input-container/i,
    /note-detail-container/i,
    /feed-comment-icon/i,
    /douyin/i,
    /FE2C55/i,
    /comment\/publish/i,
    /comment\/reply/i,
    /live\/comment\/send/i,
    /im\/send/i,
  ]
  const offenders = []
  for (const f of collectJsFiles(path.join(ROOT, 'client', 'core'))) {
    const src = fs.readFileSync(f, 'utf8')
    for (const re of BANNED) {
      if (re.test(src)) offenders.push(`${path.relative(ROOT, f)} 命中 ${re}`)
    }
  }
  assert.deepStrictEqual(offenders, [],
    'core/ 是抖音无关的传输层：选择器与接口片段必须由参数传入（AGENTS.md §3）：\n' + offenders.join('\n'))
})

test('回归：全客户端只有 cdp.js 允许构造 WebSocket', () => {
  const ALLOWED = new Set([
    path.join('client', 'core', 'cdp.js'),
  ])
  const offenders = []
  for (const f of collectJsFiles(path.join(ROOT, 'client'))) {
    const rel = path.relative(ROOT, f)
    if (ALLOWED.has(rel)) continue
    const src = fs.readFileSync(f, 'utf8')
    // 只看代码，不看注释：注释里讨论"不要 new WebSocket"是允许的
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    if (/new\s+WebSocket\s*\(/.test(code) || /require\(\s*['"]ws['"]\s*\)/.test(code)) {
      offenders.push(rel)
    }
  }
  assert.deepStrictEqual(offenders, [],
    '⚠️ 除 client/core/cdp.js 外任何地方构造 WebSocket 都是回归缺陷（旧代码 6 条连接互相争抢）：\n' +
    offenders.join('\n') + '\n请改为经 core/ipc.js 请求 browser-host。')
})

test('回归：core 的三个模块都能被 require（无顶层依赖副作用）', () => {
  // ⚠️ 顶层 require('ws') 会让"缺依赖"变成加载期崩溃；cdp.js 必须惰性加载。
  const cdpSrc = fs.readFileSync(path.join(ROOT, 'client', 'core', 'cdp.js'), 'utf8')
  assert.ok(!/^const\s+.*=\s*require\(['"]ws['"]\)/m.test(cdpSrc),
    'ws 必须惰性加载（loadWs），不得在模块顶层 require')
  assert.ok(/function loadWs/.test(cdpSrc), '必须保留惰性加载入口')
  // 三个模块都应能加载
  assert.strictEqual(typeof host.BrowserHost, 'function')
  assert.strictEqual(typeof ipc.createIpcServer, 'function')
})

// ─────────────────────────────────────────────────────────────
// ⚠️ 以下是**真机才能验证**的部分（AGENTS.md §6：代码写完 ≠ 完成）
// 本文件用假 socket 证明的是"协议层行为正确"，不包括：
//   1. Chrome 真的能被拉起、调试端口能连上（需真机 + 真实 Chrome）；
//   2. 真实鼠标/键盘事件能否激活抖音的内联编辑器；
//   3. 响应嗅探能否真的抓到 comment/publish 的响应体（以及 urlPattern 是否写对）；
//   4. 选择器在真实页面上是否命中（P2 验证门 G-4）；
//   5. `--disable-blink-features=AutomationControlled` 的实际效果（navigator.webdriver）;
//   6. 滚动 5 轮读坐标是否足够（虚拟列表重渲染时序，参数可能要按真机调整）。
// 这些必须在 P2 真机验证门通过后才能声明"完成"。
// ─────────────────────────────────────────────────────────────
