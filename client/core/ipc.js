'use strict'

// client/core/ipc.js
//
// 极简 IPC 传输层：**换行分隔的 JSON 帧（NDJSON）**。
//
// ─────────────────────────────────────────────────────────────
// 为什么需要它
// ─────────────────────────────────────────────────────────────
// 浏览器连接必须独占（`client/core/browser-host.js` 是唯一持有 CDP
// WebSocket 的模块），但拿浏览器干活的代码分散在调度器、适配器、
// UI 进程里。它们之间**只能通过 IPC** 请求高层操作
// （`{op:'evaluate'}` / `{op:'click'}` / …），不得各自 new 一条连接。
// 旧代码的形态是"6 个脚本 6 条 CDP 连接"，本文件是收敛它们的那条通道。
//
// ─────────────────────────────────────────────────────────────
// 为什么是 NDJSON 而不是别的
// ─────────────────────────────────────────────────────────────
// · 只用 Node 内置能力（`child_process` 的 stdio 本身就是流），
//   零新依赖 —— 依赖白名单只有 `ws`（AGENTS.md §2.14）。
// · 一行一帧：不存在"消息边界在哪"的歧义，抓包/日志里肉眼可读。
// · ⚠️ 代价是**必须**处理好分片：一个 `JSON.stringify(msg)+'\n'` 完全可能
//   被拆成多个 `data` 事件（大对象 / 管道缓冲），也可能两条帧挤在同一个
//   `data` 里。缓存 + 按 `\n` 切分是硬要求，不是优化。
//
// ─────────────────────────────────────────────────────────────
// ⚠️ 三条容易写错的规则
// ─────────────────────────────────────────────────────────────
// 1. **超长帧必须硬失败，不许静默截断**。截断后的 JSON 依然"看起来像
//    数据"，最坏情况是把半条指令当成完整指令执行（例如把一条发送请求的
//    后半段丢掉）。这里超过 MAX_FRAME_BYTES 直接报错 + 关流。
// 2. **每个错误都必须带归因码**（`error.attribution`）。IPC 是跨进程边界，
//    错误一旦只剩一句中文，排障就只能靠猜（S-3 可观测性要求）。
// 3. **请求必须有超时**。对端进程可能已死，stdio 却还开着——没有超时就是
//    永久挂起，而永久挂起在界面上表现为"什么都没发生"。
//
// ⚠️ 本文件对抖音一无所知：它只搬 `{id, op, args}`，不认识任何 op 的语义。

const { spawn } = require('node:child_process')

/** 单帧上限。⚠️ 超过即硬失败（见上文规则 1）。 */
const MAX_FRAME_BYTES = 1024 * 1024
/** 默认单请求超时。CDP 命令本身默认 15s，IPC 必须比它宽，否则先超时的总是 IPC。 */
const DEFAULT_TIMEOUT_MS = 30000

const IPC_ATTRIBUTION = Object.freeze({
  /** 帧超过上限 */
  FRAME_TOO_LARGE: 'ipc_frame_too_large',
  /** 帧不是合法 JSON */
  BAD_FRAME: 'ipc_bad_frame',
  /** 请求超时 */
  TIMEOUT: 'ipc_timeout',
  /** 对端关闭/退出时，在途请求的统一归因（可重试） */
  PEER_CLOSED: 'ipc_peer_closed',
  /** 写入失败 */
  WRITE_FAILED: 'ipc_write_failed',
  /** 未实现/不支持的操作 */
  UNSUPPORTED_OP: 'unsupported_op',
  /** 客户端已关闭 */
  CLIENT_CLOSED: 'ipc_client_closed',
  /** 非法参数 */
  BAD_ARGS: 'ipc_bad_args',
  /** 子进程启动失败 */
  SPAWN_FAILED: 'ipc_spawn_failed',
})

class IpcError extends Error {
  constructor(attribution, message, detail) {
    super(message || attribution)
    this.name = 'IpcError'
    this.attribution = attribution
    this.code = attribution
    this.detail = detail === undefined ? null : detail
    this.retryable = ![
      IPC_ATTRIBUTION.CLIENT_CLOSED,
      IPC_ATTRIBUTION.FRAME_TOO_LARGE,
      IPC_ATTRIBUTION.BAD_ARGS,
      IPC_ATTRIBUTION.UNSUPPORTED_OP,
    ].includes(attribution)
  }

  toJSON() {
    return { attribution: this.attribution, message: this.message, detail: this.detail, retryable: this.retryable }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t.unref) t.unref()
  })
}

/**
 * 换行分帧器。
 *
 * ⚠️ 必须自己在 `data` 事件上做缓冲：`data` 的边界与"帧"的边界**毫无关系**
 * （可能半帧、可能多帧、也可能刚好一帧）。这里同时算出每帧的字节数，
 * 以便在收流方向也执行 MAX_FRAME_BYTES 限制。
 */
function createFrameReader({ maxFrameBytes = MAX_FRAME_BYTES, onFrame, onError, logger = null } = {}) {
  let buf = ''
  let frames = 0
  let bytes = 0
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        // 忽略心跳/空行（写端可能插入空行；空帧无信息量，不算错误）
        if (!line.trim()) continue
        const size = Buffer.byteLength(line, 'utf8')
        if (size > maxFrameBytes) {
          const err = new IpcError(IPC_ATTRIBUTION.FRAME_TOO_LARGE,
            `收到的 IPC 帧超过上限（${size} > ${maxFrameBytes} 字节）`, { bytes: size, max: maxFrameBytes })
          if (onError) onError(err)
          continue
        }
        let msg
        try {
          msg = JSON.parse(line)
        } catch (e) {
          const err = new IpcError(IPC_ATTRIBUTION.BAD_FRAME, `IPC 帧不是合法 JSON：${e.message}`,
            { bytes: size, head: line.slice(0, 80) })
          if (onError) onError(err)
          continue
        }
        frames += 1
        bytes += size
        onFrame(msg)
      }
      // ⚠️ 若缓冲区里已经积累出超长但**还没有换行**的内容，同样要立刻判失败：
      //    否则一个恶意/故障对端可以用"永远不发换行"的方式把内存撑爆。
      if (Buffer.byteLength(buf, 'utf8') > maxFrameBytes) {
        const pending = Buffer.byteLength(buf, 'utf8')
        buf = ''
        const err = new IpcError(IPC_ATTRIBUTION.FRAME_TOO_LARGE,
          `IPC 帧在换行之前就超过上限（${pending} > ${maxFrameBytes} 字节）`, { bytes: pending, max: maxFrameBytes })
        if (logger) logger.error('ipc_frame_overflow', err.toJSON())
        if (onError) onError(err)
      }
    },
    stats() {
      return { frames, bytes, buffered: Buffer.byteLength(buf, 'utf8') }
    },
    flush() {
      const rest = buf
      buf = ''
      return rest
    },
  }
}

/** 编码一帧。⚠️ 超限抛错，绝不截断。 */
function encodeFrame(msg, maxFrameBytes = MAX_FRAME_BYTES) {
  let text
  try {
    text = JSON.stringify(msg)
  } catch (e) {
    throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, `IPC 消息无法序列化：${e.message}`, { keys: msg ? Object.keys(msg) : null })
  }
  const size = Buffer.byteLength(text, 'utf8')
  if (size > maxFrameBytes) {
    throw new IpcError(IPC_ATTRIBUTION.FRAME_TOO_LARGE,
      `待发送的 IPC 帧超过上限（${size} > ${maxFrameBytes} 字节）`, { bytes: size, max: maxFrameBytes })
  }
  return text + '\n'
}

/** 把错误归一成可跨进程的错误对象（必须带归因码）。 */
function toWireError(e) {
  if (e instanceof IpcError) return e.toJSON()
  const attribution = (e && (e.attribution || e.code)) || 'ipc_unknown_error'
  return {
    attribution,
    message: (e && e.message) ? e.message : String(e),
    detail: (e && e.detail !== undefined) ? e.detail : null,
    retryable: Boolean(e && e.retryable),
  }
}

/**
 * 创建 IPC 服务端。
 *
 * @param {object} opts
 * @param {{write:Function, on:Function, end?:Function}} [opts.stream] 读写同一个流
 *        （生产：stdin+stdout 的适配器；测试：PassThrough）
 * @param {{on:Function}} [opts.input]  只读端（与 `output` 成对使用）
 * @param {{write:Function, end?:Function}} [opts.output] 只写端
 * @param {(op:string, args:object, meta:object) => Promise<any>} opts.onRequest
 *        处理请求。**抛错即失败**，错误会被归一成带归因码的响应。
 * @param {object} [opts.logger]
 * @param {number} [opts.maxFrameBytes]
 * @param {boolean} [opts.autoEndOnOverflow] 超长帧后是否关流（默认 true：硬失败）
 * @returns {{handleFrame:Function, sendNotification:Function, close:Function, stats:Function}}
 */
function createIpcServer(opts = {}) {
  const input = opts.input || opts.stream
  const output = opts.output || opts.stream
  if (!output || typeof output.write !== 'function') {
    throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'createIpcServer 需要可写端（stream 或 output）')
  }
  if (!input || typeof input.on !== 'function') {
    throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'createIpcServer 需要可读端（stream 或 input）')
  }
  const onRequest = opts.onRequest
  if (typeof onRequest !== 'function') {
    throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'createIpcServer 需要 onRequest 函数')
  }
  const logger = opts.logger || null
  const maxFrameBytes = Number(opts.maxFrameBytes) > 0 ? Number(opts.maxFrameBytes) : MAX_FRAME_BYTES
  let closed = false
  let fatal = null

  const write = (msg) => {
    if (closed) return false
    try {
      output.write(encodeFrame(msg, maxFrameBytes))
      return true
    } catch (e) {
      // ⚠️ 回不了响应（对端已经不可写）：记日志，不抛——
      //    抛出去只会把宿主进程打挂，而请求本身已经无法完成。
      if (logger) logger.error('ipc_server_write_failed', { ...toWireError(e) })
      return false
    }
  }

  const reader = createFrameReader({
    maxFrameBytes,
    logger,
    onError: (err) => {
      // 帧级错误：能回就回一条结构化响应，然后按配置关流（硬失败）。
      if (logger) logger.error('ipc_server_frame_error', err.toJSON())
      fatal = err
      write({ id: null, ok: false, error: err.toJSON() })
      if (opts.autoEndOnOverflow !== false) {
        try {
          if (typeof output.end === 'function') output.end()
        } catch (e) {
          if (logger) logger.warn('ipc_server_end_failed', { message: e && e.message })
        }
      }
    },
    onFrame: (msg) => {
      void handleMessage(msg)
    },
  })

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      write({ id: null, ok: false, error: { attribution: IPC_ATTRIBUTION.BAD_FRAME, message: 'IPC 帧必须是对象' } })
      return
    }
    // 通知（无 id）：只处理，不回响应。
    if (msg.id === undefined || msg.id === null) {
      if (msg.op === 'ping') {
        write({ id: null, ok: true, result: { pong: true, at_ms: Date.now() } })
      }
      return
    }
    const meta = { id: msg.id, op: msg.op, atMs: Date.now() }
    let result
    try {
      if (typeof msg.op !== 'string' || !msg.op) {
        throw new IpcError(IPC_ATTRIBUTION.UNSUPPORTED_OP, 'IPC 请求缺少 op', { id: msg.id })
      }
      result = await onRequest(msg.op, msg.args || {}, meta)
    } catch (e) {
      write({ id: msg.id, ok: false, error: toWireError(e) })
      return
    }
    write({ id: msg.id, ok: true, result: result === undefined ? null : result })
  }

  input.on('data', (chunk) => reader.push(chunk))

  return {
    /** 供测试直接注入一帧（无需真实流） */
    handleFrame: (msg) => handleMessage(msg),
    sendNotification: (op, args) => write({ op, args: args || {} }),
    stats: () => reader.stats(),
    get fatalError() { return fatal },
    close: () => {
      closed = true
    },
  }
}

/**
 * 创建 IPC 客户端。
 *
 * @param {object} opts
 * @param {{write:Function, on:Function}} [opts.output] 写端
 * @param {{on:Function}} [opts.input]                  读端
 * @param {{write:Function, on:Function}} [opts.stream] 读写同一个流（测试用 PassThrough）
 * @param {object} [opts.spawn]  `{command, args, options}`：内部用 child_process.spawn，
 *                               并以 `child.stdout` 为读端、`child.stdin` 为写端。
 *                               ⚠️ 明说：不捕获/不使用 `child.stderr`（见 README/规范：
 *                               本运行环境用管道捕获子进程输出可能失败），子进程的诊断
 *                               信息应由它自己的日志文件承载。
 * @param {object} [opts.logger]
 * @param {number} [opts.timeoutMs] 单请求默认超时
 * @returns {object} 客户端
 */
function createIpcClient(opts = {}) {
  const logger = opts.logger || null
  const maxFrameBytes = Number(opts.maxFrameBytes) > 0 ? Number(opts.maxFrameBytes) : MAX_FRAME_BYTES
  const defaultTimeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS

  let child = null
  let output = opts.output || null
  let input = opts.input || null

  if (!output && !input && opts.stream) {
    output = opts.stream
    input = opts.stream
  }

  if (!output && !input && opts.spawn) {
    const spec = opts.spawn
    if (!spec.command) throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'opts.spawn 需要 command')
    child = spawn(spec.command, spec.args || [], {
      cwd: spec.options && spec.options.cwd,
      env: (spec.options && spec.options.env) || process.env,
      stdio: ['pipe', 'pipe', spec.options && spec.options.stderr === 'inherit' ? 'inherit' : 'ignore'],
      windowsHide: true,
    })
    // ⚠️ 必须挂 error：spawn 失败（命令不存在）是异步报的，
    //    不监听会变成未处理事件把客户端进程打挂。
    child.on('error', (e) => {
      const err = new IpcError(IPC_ATTRIBUTION.SPAWN_FAILED, `IPC 子进程启动失败：${e.message}`, { command: spec.command })
      if (logger) logger.error('ipc_spawn_failed', err.toJSON())
      failAll(err)
    })
    output = child.stdin
    input = child.stdout
  }

  if (!output || typeof output.write !== 'function') {
    throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'createIpcClient 需要可写端（output/stream/spawn 之一）')
  }
  if (!input || typeof input.on !== 'function') {
    throw new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'createIpcClient 需要可读端（input/stream/spawn 之一）')
  }

  let nextId = 1
  let closed = false
  const pending = new Map()

  function failAll(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  const reader = createFrameReader({
    maxFrameBytes,
    logger,
    onError: (err) => {
      if (logger) logger.error('ipc_client_frame_error', err.toJSON())
      // 收流被破坏：在途请求不可能再被正确应答，直接全拒（不要挂着）。
      failAll(err)
    },
    onFrame: (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.id === undefined || msg.id === null) return
      const p = pending.get(msg.id)
      if (!p) {
        if (logger) logger.warn('ipc_response_for_unknown_id', { id: msg.id })
        return
      }
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok === false || msg.error) {
        const e = msg.error || {}
        p.reject(new IpcError(e.attribution || 'ipc_remote_error', e.message || '远端返回错误', e.detail))
        return
      }
      p.resolve(msg.result === undefined ? null : msg.result)
    },
  })

  input.on('data', (chunk) => reader.push(chunk))

  input.on('end', () => {
    if (closed) return
    closed = true
    failAll(new IpcError(IPC_ATTRIBUTION.PEER_CLOSED, 'IPC 对端已关闭（在途请求已全部拒绝）'))
  })
  if (child) {
    child.on('exit', (code, signal) => {
      if (closed) return
      closed = true
      failAll(new IpcError(IPC_ATTRIBUTION.PEER_CLOSED, `IPC 子进程已退出（code=${code} signal=${signal}）`, { code, signal }))
    })
  }

  /**
   * 发一个请求。
   * @param {string} op
   * @param {object} [args]
   * @param {object} [o] `{timeoutMs}`
   * @returns {Promise<any>}
   */
  function request(op, args = {}, o = {}) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new IpcError(IPC_ATTRIBUTION.CLIENT_CLOSED, 'IPC 客户端已关闭'))
        return
      }
      if (typeof op !== 'string' || !op) {
        reject(new IpcError(IPC_ATTRIBUTION.BAD_ARGS, 'IPC 请求需要 op'))
        return
      }
      const id = nextId++
      const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : defaultTimeoutMs
      let frame
      try {
        frame = encodeFrame({ id, op, args: args || {} }, maxFrameBytes)
      } catch (e) {
        reject(e)
        return
      }
      // ⚠️ 先登记再写：写是同步的，若对端在同一 tick 内回包（PassThrough 测试就是
      //    这种情况），响应处理可能**早于**本行之后的登记，导致"响应无人认领"。
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new IpcError(IPC_ATTRIBUTION.TIMEOUT,
          `IPC 请求超时（op=${op}，${timeoutMs}ms）——对端可能已死或卡住`, { op, timeout_ms: timeoutMs, id }))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      pending.set(id, { resolve, reject, timer, op, startedAtMs: Date.now() })

      try {
        output.write(frame)
      } catch (e) {
        pending.delete(id)
        clearTimeout(timer)
        reject(new IpcError(IPC_ATTRIBUTION.WRITE_FAILED, `IPC 写入失败：${e && e.message ? e.message : String(e)}`, { op }))
      }
    })
  }

  return {
    request,
    get pendingCount() { return pending.size },
    get closed() { return closed },
    stats: () => reader.stats(),
    /** 关闭：拒掉在途请求并结束子进程（若由本客户端启动）。 */
    close: async () => {
      if (closed) return
      closed = true
      failAll(new IpcError(IPC_ATTRIBUTION.CLIENT_CLOSED, 'IPC 客户端已关闭'))
      if (child) {
        try {
          if (typeof child.kill === 'function') child.kill()
        } catch (e) {
          // ⚠️ 子进程可能已经退出：kill 抛错是预期内的，但必须留痕。
          if (logger) logger.warn('ipc_child_kill_failed', { message: e && e.message })
        }
      }
      if (typeof output.end === 'function' && !child) {
        try {
          output.end()
        } catch (e) {
          if (logger) logger.warn('ipc_output_end_failed', { message: e && e.message })
        }
      }
    },
  }
}

/**
 * 便捷封装：在同一进程内把两端直连起来（两个 PassThrough 交叉对接）。
 *
 * ⚠️ 用途仅限两种情况：
 *   1. UI 进程与宿主同进程时的零成本调用；
 *   2. 测试。
 * 生产里"宿主 + 调度器分进程"请用 `createIpcClient({spawn})`，
 * 让子进程用 stdio 当通道。
 *
 * @returns {{client:object, server:object, up:import('node:stream').PassThrough, down:import('node:stream').PassThrough, close:Function}}
 */
function createInProcessPair({ onRequest, logger = null, serverLogger = null, clientLogger = null, timeoutMs } = {}) {
  const { PassThrough } = require('node:stream')
  const up = new PassThrough()    // 客户端 → 服务端
  const down = new PassThrough()  // 服务端 → 客户端

  const server = createIpcServer({
    stream: up,          // 服务端从 up 读请求
    output: down,        // 服务端往 down 写响应
    onRequest,
    logger: serverLogger || logger,
  })
  const client = createIpcClient({
    input: down,         // 客户端从 down 读响应
    output: up,          // 客户端往 up 写请求
    logger: clientLogger || logger,
    timeoutMs,
  })

  return {
    client,
    server,
    up,
    down,
    close: async () => {
      server.close()
      await client.close()
      up.destroy()
      down.destroy()
    },
  }
}

module.exports = {
  createIpcServer,
  createIpcClient,
  createInProcessPair,
  createFrameReader,
  encodeFrame,
  toWireError,
  IpcError,
  IPC_ATTRIBUTION,
  MAX_FRAME_BYTES,
  DEFAULT_TIMEOUT_MS,
}
