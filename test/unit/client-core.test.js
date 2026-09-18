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

  /** 注入一帧（服务端 → 客户端） */
  push(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj), 'utf8'))
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
    return this.frames().map((f) => f.method)
  }

  lastId() {
    const f = this.frames()
    return f.length ? f[f.length - 1].id : null
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
class FakeCdpServer {
  constructor(ws) {
    this.ws = ws
    this.sessions = new Map()
    this.attachedTargets = []
    this.sessionSeq = 0
    this.routes = new Map()
    this.respondedIds = []
    this.targets = []
  }

  route(method, fn) {
    this.routes.set(method, fn)
    return this
  }

  /** 处理当前已收到的全部帧 */
  pump() {
    for (const f of this.ws.frames()) {
      if (this.respondedIds.includes(f.id)) continue
      this.respondedIds.push(f.id)
      this.#handle(f, this.ws)
    }
  }

  /** 等到客户端发出第 n 条命令（n 从 1 开始），然后处理它 */
  waitFor(ws, n, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => {
        if (ws.frames().length >= n) {
          this.pump()
          const f = ws.frames()[n - 1]
          if (f) { resolve(f); return }
        }
        if (Date.now() - t0 > timeoutMs) {
          reject(new Error(`等第 ${n} 条命令超时（当前 ${ws.frames().length} 条）`))
          return
        }
        setTimeout(tick, 5)
      }
      tick()
    })
  }

  #handle(f, ws) {
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
        const sessionId = `S${this.sessionSeq}`
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
      case 'Runtime.evaluate':
        ws.push({ id: f.id, result: { result: { type: 'string', value: '"ok"' } } })
        return
      default: {
        if (f.sessionId && !this.sessions.has(f.sessionId)) {
          ws.push({ id: f.id, error: { code: -32001, message: `Session with given id not found: ${f.sessionId}` } })
          return
        }
        ws.push({ id: f.id, result: { echoed: f.method, sessionId: f.sessionId || null } })
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
  await server.waitFor(ws, 1)
  await cdp.waitReady(1000)
  return server
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
  server.route('Test.alpha', (f) => { void f; return 'handled' })
  await connected(cdp, w, server)

  const pa = cdp.send('Test.alpha', { n: 1 })
  const pb = cdp.send('Test.beta', { n: 2 })
  const pc = cdp.send('Test.gamma', { n: 3 })

  // 等三条命令都写出去
  const frames = w.frames().filter((f) => f.method.startsWith('Test.'))
  assert.strictEqual(frames.length, 3, '三条命令都应写出')
  const [fa, fb, fc] = frames

  // ⚠️ 故意乱序：先回第三条，再回第一条，最后第二条
  w.push({ id: fc.id, result: { which: 'c' } })
  w.push({ id: fa.id, result: { which: 'a' } })
  w.push({ id: fb.id, result: { which: 'b' } })

  assert.deepStrictEqual(await pc, { which: 'c' })
  assert.deepStrictEqual(await pa, { which: 'a' })
  assert.deepStrictEqual(await pb, { which: 'b' })
  assert.strictEqual(cdp.pendingCount, 0)
  await cdp.close()
})

test('CDP：CDP 协议级 error 转成带归因码的结构化错误', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  const server = new FakeCdpServer(w)
  await connected(cdp, w, server)

  const p = cdp.send('Runtime.evaluate', { expression: '1' })
  const f = await server.waitFor(w, 2)
  w.push({ id: f.id, error: { code: -32000, message: 'Cannot find context' } })

  await assert.rejects(p, (e) => {
    assert.ok(e instanceof CdpError, '必须是 CdpError')
    assert.strictEqual(e.attribution, ATTRIBUTION.PROTOCOL_ERROR)
    assert.match(e.message, /Cannot find context/)
    assert.strictEqual(e.detail.method, 'Runtime.evaluate')
    return true
  })
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

  const p = cdp.send('Test.never', {}, { timeoutMs: 60 })
  await server.waitFor(w, 2)              // 确认命令真的写出去了（对端就是不应答）
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.attribution, ATTRIBUTION.CMD_TIMEOUT)
    assert.match(e.message, /超时/)
    assert.strictEqual(e.detail.method, 'Test.never')
    return true
  })
  assert.strictEqual(cdp.pendingCount, 0, '⚠️ 超时后 pending 必须清零（旧代码的 promise 会永远悬着）')

  // 迟到的响应不能把已结算的 promise 再动一次（也不应抛）
  w.push({ id: w.frames()[1].id, result: { late: true } })
  await wait(20)
  assert.strictEqual(cdp.pendingCount, 0)
  await cdp.close()
})

test('CDP：Page.navigate 默认拿到 30 秒超时，普通命令 15 秒', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  await connected(cdp, w, new FakeCdpServer(w))

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

  // 真发一条 navigate，验证用的就是 30 秒预算（40ms 内不应超时）
  const p = cdp.send('Page.navigate', { url: 'about:blank' })
  const f = await (new FakeCdpServer(w)).waitFor(w, 2)
  w.push({ id: f.id, result: { frameId: 'F1' } })
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
  await connected(cdp, w, server)

  const sessionId = await cdp.attach('comment', 'TARGET-A')
  assert.ok(sessionId, 'attach 必须返回 sessionId')

  // 会话级命令带 sessionId
  const p1 = cdp.send('Runtime.evaluate', { expression: '1+1' }, { role: 'comment' })
  const f1 = await server.waitFor(w, 3)
  assert.strictEqual(f1.sessionId, sessionId, '按 role 解析出的命令必须带 sessionId')
  w.push({ id: f1.id, result: { result: { type: 'number', value: 2 } } })
  const r1 = await p1
  assert.strictEqual(r1.result.value, 2)

  // 浏览器级命令不带 sessionId（Target.* 只能在浏览器级发）
  const p2 = cdp.send('Target.getTargets', {})
  const f2 = await server.waitFor(w, 4)
  assert.strictEqual(f2.sessionId, undefined, '浏览器级命令不得带 sessionId')
  server.pump()
  await p2

  // 未知会话必须报 -32001（证明服务端确实在按会话路由，不是我们自说自话）
  const p3 = cdp.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S-does-not-exist' })
  await assert.rejects(p3, /Session with given id not found/)

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
  const sessionId = await cdp.attach('comment', 'TARGET-A')
  const otherSession = await cdp.attach('live', 'TARGET-B')

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

  assert.strictEqual(browserHits.length, 1)
  assert.strictEqual(browserHits[0].p.targetId, 'T1')
  assert.strictEqual(browserHits[0].meta.sessionId, null, '浏览器级事件的 meta.sessionId 必须是 null')
  assert.strictEqual(sessionHits.length, 1, '订阅该会话的监听器必须收到')
  assert.strictEqual(sessionHits[0].type, 'log')
  assert.strictEqual(otherHits.length, 0, '⚠️ 别的会话的事件不得串台')

  // 退订后不再收到
  offBrowser()
  offSession()
  w.push({ method: 'Target.targetDestroyed', params: { targetId: 'T2' } })
  w.push({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: otherSession })
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
  await cdp.attach('comment', 'TARGET-A')
  s1.pump()
  await wait(20)

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
  w2.open()

  // ⚠️⚠️ 核心断言：重连后**必须**重新 enable 这两个域。
  // 不做的话 Network 嗅探静默停止 → 每条回复都被判"未捕获平台响应"
  // → 按红线 2 只能记 failed/sent_suspected → 商家多发少算、且毫无报错。
  const t1 = Date.now()
  while (w2.frames().length < 2 && Date.now() - t1 < 2000) await wait(5)
  s2.pump()
  assert.deepStrictEqual(w2.methods().slice(0, 2), ['Runtime.enable', 'Network.enable'],
    `重连后必须先重新启用这两个域（实际：${JSON.stringify(w2.methods())}）`)

  // 重新 attach 回原 targetId（targetId 跨连接稳定）
  const t2 = Date.now()
  while (w2.frames().length < 3 && Date.now() - t2 < 2000) await wait(5)
  s2.pump()
  await cdp.waitReady(500)
  assert.deepStrictEqual(w2.methods().slice(0, 3),
    ['Runtime.enable', 'Network.enable', 'Target.attachToTarget'])
  const attachFrame = w2.frames()[2]
  assert.strictEqual(attachFrame.params.targetId, 'TARGET-A', '必须重新 attach 原 targetId')
  assert.strictEqual(attachFrame.params.flatten, true)

  // 重连后命令能正常走（会话已恢复）
  const p = cdp.send('Runtime.evaluate', { expression: '1+1' }, { role: 'comment' })
  const t3 = Date.now()
  while (w2.frames().length < 4 && Date.now() - t3 < 2000) await wait(5)
  s2.pump()
  const r = await p
  assert.strictEqual(r.result.value, 2)
  assert.strictEqual(r.echoed, undefined)
  assert.strictEqual(w2.frames()[3].sessionId, cdp.sessionIdOf('comment'), '重连后仍应使用新的 sessionId')

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
  await server.waitFor(w, 2)
  const p2 = cdp.send('Test.never2', {})
  await server.waitFor(w, 3)
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
  await cdp.attach('comment', 'TARGET-A')
  server.pump()
  await wait(10)

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

test('CDP：超长帧被丢弃并归因（不静默截断）', async () => {
  const { cdp, sockets, ws } = await makeCdpReady()
  const w = ws()
  await connected(cdp, w, new FakeCdpServer(w))
  const before = cdp.engineState.state
  // 直接推一个超大字符串帧
  w.emit('message', Buffer.from(JSON.stringify({ method: 'X', params: { big: 'y'.repeat(1024) } }), 'utf8'))
  await wait(10)
  assert.strictEqual(cdp.engineState.state, before, '坏帧不得改变连接状态')
  const ok = await cdp.send('Target.getTargets', {})
  assert.ok(ok, '坏帧之后连接仍应可用')
  await cdp.close()
})

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
  const hostDeps = {
    probePortImpl: async () => false,
    getJsonImpl: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/browser/x', Browser: 'FakeChrome' }),
    spawnImpl: () => ({ pid: 999999, on() {}, unref() {} }),
    cdpFactory: () => new Cdp({ url: 'ws://127.0.0.1:19222/devtools/browser/x', createSocket: () => new FakeWebSocket('x') }),
  }
  const h1 = await host.BrowserHost.create({ config: cfg, ...hostDeps })
  try {
    assert.strictEqual(fs.existsSync(t.lockPath), true, '必须落独占锁文件')
    await assert.rejects(
      host.BrowserHost.create({ config: cfg, ...hostDeps }),
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
  // 关闭后应能重新创建（锁与注册表都已释放）
  const h2 = await host.BrowserHost.create({ config: cfg, ...hostDeps })
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
    probePortImpl: async () => false,
    getJsonImpl: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:19227/devtools/browser/x' }),
    spawnImpl: () => ({ pid: 999996, on() {}, unref() {} }),
    cdpFactory: () => new Cdp({ url: 'ws://127.0.0.1:19227/devtools/browser/x', createSocket: () => new FakeWebSocket('x') }),
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
  const sockets = []
  const h = await host.BrowserHost.create({
    config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19225, chromePath: '/fake/chrome' },
    probePortImpl: async () => false,
    getJsonImpl: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:19225/devtools/browser/x', Browser: 'FakeChrome' }),
    spawnImpl: () => ({ pid: 999998, on() {}, unref() {} }),
    cdpFactory: () => new Cdp({
      url: 'ws://127.0.0.1:19225/devtools/browser/x',
      createSocket: () => { const s = new FakeWebSocket('x'); sockets.push(s); return s },
    }),
  })
  try {
    const w = sockets[0]
    const server = new FakeCdpServer(w)
    w.open()
    await server.waitFor(w, 1)
    await h.cdp.waitReady(500)

    // 未经 ensureTab 就操作：应报"可重排队"
    await assert.rejects(h.click('comment', '#x'), (e) => {
      assert.strictEqual(e.code, host.RETRYABLE_REQUEUE)
      assert.strictEqual(e.requeue, true, '⚠️ 标签页消失必须让调度器把任务退回队列，而不是记 failed')
      return true
    })

    // ensureTab 建页
    const p = h.ensureTab('comment', 'about:blank', { initialWaitMs: 0, pollMax: 2 })
    let f = await server.waitFor(w, 2)
    assert.strictEqual(f.method, 'Target.createTarget')
    w.push({ id: f.id, result: { targetId: 'T1' } })
    // Target.getTargets（waitForTarget）
    await wait(20)
    server.pump()
    f = w.frames().find((x) => x.method === 'Target.getTargets')
    assert.ok(f, '必须等 target 出现在 Target.getTargets 里再 attach')
    // Target.attachToTarget
    await wait(40)
    server.pump()
    const attach = w.frames().find((x) => x.method === 'Target.attachToTarget')
    assert.ok(attach, '必须 attach 到目标（flatten 模式，不开第二条 WS）')
    assert.strictEqual(attach.params.flatten, true)
    await wait(40)
    server.pump()
    const ensured = await p
    assert.strictEqual(ensured.targetId, 'T1')
    assert.strictEqual(host.hosts.get(host.hostKey(t.instanceDir, 19225)), h)

    // 关键：**不得**出现第二个 WebSocket（那正是旧代码的缺陷）
    assert.strictEqual(sockets.length, 1, '一个实例只能有一条 CDP WebSocket')

    // tab 被外部关掉 → 再操作必须 requeue
    server.targets = []
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
  const sockets = []
  const h = await host.BrowserHost.create({
    config: { instanceDir: t.instanceDir, chromeProfilePath: t.profilePath, debugPortBase: 19226, chromePath: '/fake/chrome' },
    probePortImpl: async () => false,
    getJsonImpl: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:19226/devtools/browser/x' }),
    spawnImpl: () => ({ pid: 999997, on() {}, unref() {} }),
    cdpFactory: () => new Cdp({
      url: 'ws://127.0.0.1:19226/devtools/browser/x',
      createSocket: () => { const s = new FakeWebSocket('x'); sockets.push(s); return s },
    }),
  })
  try {
    const w = sockets[0]
    const server = new FakeCdpServer(w)
    server.route('Runtime.evaluate', (f) => {
      w.push({ id: f.id, result: { result: { type: 'string', value: JSON.stringify({ ok: true, visibleCount: 1, candidateCount: 1, sample: '固定文本' }) } } })
      return 'handled'
    })
    w.open()
    await server.waitFor(w, 1)
    await h.cdp.waitReady(500)
    h.cdp.registerSession('comment', 'T1', 'S1')
    h.roles.set('comment', 'T1')

    const r = await h.waitForNodeStable('comment', { selector: '#reply', stableMs: 60, pollMs: 20 })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.verdict_hint, 'sent_confirmed_dom', '⚠️ DOM 稳定只能映射到 sent_confirmed_dom')
    assert.strictEqual(r.confirm_signal, 'dom_stable')
    assert.strictEqual(r.billable, false, '⚠️ DOM 判定不得计费（红线 2）')
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
  // ⚠️ 这里**手动**建两端（而不是用 createInProcessPair）：
  //    要精确控制"字节怎么进流"，就必须自己拿 `up`（请求方向）与
  //    `down`（响应方向）两个流，否则客户端写请求时会与被测的
  //    手写字节混在同一个流上。
  const up = new PassThrough()
  const down = new PassThrough()
  const seen = []
  const server = ipc.createIpcServer({
    input: up,
    output: down,
    onRequest: async (op, args) => { seen.push({ op, args }); return { ok: op } },
  })
  const client = ipc.createIpcClient({ input: down, output: up, timeoutMs: 1000 })

  try {
    // 一条帧被拆成 3 段写入
    const raw = JSON.stringify({ id: 101, op: 'split', args: { v: 'x'.repeat(50) } }) + '\n'
    up.write(raw.slice(0, 10))
    up.write(raw.slice(10, 30))
    up.write(raw.slice(30))
    // 两条帧粘在一个 chunk 里
    up.write(JSON.stringify({ id: 102, op: 'joined_a', args: {} }) + '\n'
      + JSON.stringify({ id: 103, op: 'joined_b', args: {} }) + '\n')
    // 空行必须被忽略（写端可能插空行）
    up.write('\n')

    const r1 = await client.request('split', { v: 'x'.repeat(50) })
    assert.deepStrictEqual(r1, { ok: 'split' })
    const r2 = await client.request('joined_a', {})
    assert.deepStrictEqual(r2, { ok: 'joined_a' })
    const r3 = await client.request('joined_b', {})
    assert.deepStrictEqual(r3, { ok: 'joined_b' })

    assert.deepStrictEqual(seen.map((s) => s.op), ['split', 'joined_a', 'joined_b'],
      '分片与粘连都只应产生一条请求；空行不产生请求')
    assert.strictEqual(server.stats().frames, 4, '只应有 4 条有效帧（空行不算）')
  } finally {
    server.close()
    await client.close()
    up.destroy()
    down.destroy()
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
