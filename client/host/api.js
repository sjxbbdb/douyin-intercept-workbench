'use strict'

// client/host/api.js
//
// 本地控制台的 HTTP API —— **AGENTS.md §2.13（旧代码 D-6）的唯一修复点**。
//
// ⚠️ 本文件存在的理由，一句话：
//     旧代码的本地接口绑 `0.0.0.0`、零鉴权、CORS 写 `*`。于是
//     **商家在浏览器里打开任意一个网页，那个网页就能 POST 到本机接口，
//     代替商家发出评论**；局域网内任何设备也能直接调用。
//     商家完全不知情，而且事后查不出是谁发的。
//
// ⚠️⚠️ 四道门，缺一不可。删掉任意一道都会让上面那段话重新成立：
//
//   1. **只绑回环**。地址来自 `config.uiHost`（默认 `127.0.0.1`），
//      `client/config.js` 已经拒绝非回环绑定（除非显式设 `REPLY_ALLOW_PUBLIC_BIND=1`），
//      本文件**不得**以任何方式弱化它。监听成功后还要把 `server.address()`
//      回读一遍并断言仍是回环——配置校验与实际绑定是两件事，只信实际。
//      删掉它 → 局域网内任何人可访问本地控制台。
//
//   2. **会话令牌**（32 字节 hex，落在 `<instanceDir>/ui-token.txt`）。
//      每个 `/api/*` 请求都必须带它：`Authorization: Bearer` / `X-UI-Token`
//      / `?token=`（首屏 `GET /` 只能走 query，浏览器不会在地址栏请求上带头）。
//      比较用 `crypto.timingSafeEqual`。删掉它 → 本机其它进程、以及
//      任何能访问回环的服务都能直接驱动发送。
//
//   3. **CORS 白名单**（绝不是 `*`）。白名单 = `http://127.0.0.1:<实际端口>` /
//      `http://localhost:<实际端口>` / `http://[::1]:<实际端口>`。
//      ⚠️ 关键的一半是**拒绝**：请求带了 `Origin` 但不在白名单里 → 直接 403。
//      只做"不回 CORS 头"是不够的——简单请求（`POST` + `text/plain`）
//      本来就**不需要**预检，浏览器会把请求真的发出来，副作用已经发生，
//      只是响应读不到而已。所以必须显式拒绝。
//      删掉它 → 商家访问的任意网页可跨站调用接口代发评论。
//
//   4. **Host 头校验**。`Origin` 检查挡不住 DNS rebinding：攻击者把自己的
//      域名解析到 `127.0.0.1`，页面就用**攻击者的域名**作 `Origin`，
//      但浏览器发出的 `Host` 头是攻击者域名——于是 Host 不是回环即拒。
//      删掉它 → DNS rebinding 绕过 origin 检查。
//
// ⚠️ 其余两条"容易忘"的细节：
//   · **急停不受任何状态门控**。`POST /api/emergency-stop` 在**未登录、
//     无策略、会话已死**时都必须生效。它是商家"一键停机"的唯一保证，
//     把 license 状态塞进它的前置条件里等于在最需要它的时候把它关掉。
//   · **绝不返回空数据假装成功**。旧代码 D-14 的形态是"接口返回全空 →
//     前端不清状态 → 看板一直挂着上一次的数字"。这里所有未实现的路由
//     一律 `501` + 结构化信封，绝不 200 + `{}`。
//
// ⚠️ 写盘边界（AGENTS.md §2.9 单写者）：
//    **运行数据**一律经 `store`（令牌经 `store.writeAtomic`）。
//    本文件里的 `node:fs` 一共只有两处，都不碰运行数据：
//      · `fs.readFile` —— 只读 `client/ui/` 下的静态前端资源（HTML/CSS/JS）。
//        那是**代码**（随分发包一起分发），不是运行数据，不参与单写者约束。
//      · `fs.chmodSync` —— 把令牌文件权限收紧到 0600。它**不写内容**
//        （内容由 `store.writeAtomic` 写），只是尽力限制可读范围；
//        Windows 上语义有限，失败只告警不阻断。
//    除此之外本文件不碰任何文件。
//
// ⚠️ `license-server/` 与 `client/` 不得互相 require（AGENTS.md §3）。
//    `read_json_body` 因此在本文件独立实现一份（服务端有它自己的一份），
//    而不是跨目录 require——跨端 require 一旦开了口子，两端就会开始
//    共享内部实现，"只能通过 HTTP 接口通信"这条约束随即失效。

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { AppError } = require('../../shared/lib/errors')
const { WorkbenchError, isKnownWorkbenchCode } = require('../core/workbench-error')
const { SOURCE_TYPES } = require('../../shared/lib/protocol')
const { buildDashboard, buildTrend, aggregateReports, emptySources } = require('../../shared/lib/stats')
const { isWithinActiveHours } = require('../safety/guard')
const { MAX_QUEUE_SIZE } = require('../host/queue')
const { AUDIT_KINDS } = require('../safety/audit')

/** 静态前端资源目录（相对本文件，不写死绝对路径）。 */
const UI_DIR = path.join(__dirname, '..', 'ui')

/** 令牌文件名。⚠️ 经 store 写入，所以必须是 store.file() 允许的字符集。 */
const TOKEN_FILE = 'ui-token.txt'

/** 请求体上限。控制台的请求体都是小 JSON（登录、限额、规则），256 KB 足够。 */
const MAX_BODY_BYTES = 256 * 1024

/** 单个令牌的比较窗口：32 字节 hex = 64 字符。 */
const TOKEN_BYTES = 32

/** 界面轮询周期（供 `/api/state` 回给前端，避免前端硬编码一个秒数）。 */
const POLL_INTERVAL_MS = 2000

/** 各处"最近 N 条"的默认与上限（防止一个 `?limit=999999` 把内存打爆）。 */
const LIMITS = Object.freeze({
  queue_items: 100,
  queue_items_max: 500,
  audit_rows: 100,
  audit_rows_max: 500,
  recent_sends: 50,
  recent_sends_max: 200,
  selector_drift_window_ms: 3600000,
  selector_drift_threshold: 3,
  clock_skew_warn_ms: 30000,
  alert_credit_low_replies: 10,
})

/**
 * 队列积压告警阈值：`MAX_QUEUE_SIZE` 的 80%。
 * ⚠️ 从队列模块的常量推导，**不另写一个数字**——两处各写一份迟早漂移。
 */
const QUEUE_BACKLOG_RATIO = 0.8

/** 静态资源表：路径 → 文件名 + MIME。⚠️ 白名单，不做目录穿越。 */
const STATIC_ASSETS = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
})

/**
 * 本地 API 错误码 → HTTP 状态。
 *
 * ⚠️ 为什么需要这一层：`AppError` 的码表是**跨端契约**（protocol.md §3），
 *    而本地控制台的码（令牌缺失、Host 非法…）既不上报也不该污染契约。
 *    所以本地码给一张**只属于本文件**的映射表。
 *
 * ⚠️⚠️ 键必须是从 `shared/lib/errors.js` 或 `client/core/workbench-error.js`
 *    **取常量**得来的已登记码，绝不能在此自造字面量——
 *    `test/contract/consistency.test.js` 会扫描 `client/**` 里所有
 *    `SERVER_*` / `AUTH_*` 形态的字符串字面量并要求它们出现在契约表中。
 *    "未实现"因此用 `WorkbenchError` 的本地码 `NOT_IMPLEMENTED`（501），
 *    而不是自造一个 `SERVER_NOT_IMPLEMENTED`——后者不在契约表里，会被判缺陷。
 */
const LOCAL_STATUS = Object.freeze({
  AUTH_INVALID_REQUEST: 400,      // 请求参数不完整（例如登录缺账号或密码）
  AUTH_TOKEN_MISSING: 401,        // 令牌缺失／格式不对
  AUTH_TOKEN_INVALID: 401,        // 令牌不匹配（timingSafeEqual 判否）
  AUTH_FORBIDDEN: 403,            // Origin / Host 不在白名单
  REPORT_INVALID: 400,            // 请求体/查询参数形态不对
  REPORT_TOO_LARGE: 413,          // 请求体超限
  POLICY_VIOLATION: 409,          // 限额比服务端更激进
  SERVER_INTERNAL: 500,
  RATE_TOO_MANY_REQUESTS: 429,
  AUDIT_SEND_INVALID: 400,
  AUDIT_CONFIG_INVALID: 400,
  POLICY_SENDING_DISABLED: 409,
  POLICY_CIRCUIT_OPEN: 409,
  AUTH_SIGN_INVALID: 401,
  CREDIT_EXHAUSTED: 402,
  SERVER_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,           // WorkbenchError 的本地码：路由/依赖未实现
  INTERNAL: 500,
  DISK_WRITE_FAILED: 500,
  CONFIG_INVALID: 400,
  SELECTOR_MISS: 500,
})

// ═══════════════════════════════════════════════════════════
// 纯函数工具（导出以便测试直接断言）
// ═══════════════════════════════════════════════════════════

/** 是否为回环主机名。⚠️ 白名单，不做"以 127. 开头"这类前缀判断。 */
function is_loopback_hostname(host) {
  if (typeof host !== 'string' || host === '') return false
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * 解析 `Host` / `Origin` 的 authority 部分。
 *
 * ⚠️ 刻意不用 `new URL()` 解析 Host：`Host` 头不是 URL，`new URL('127.0.0.1:8090')`
 *    会把它当成 scheme 而解析失败。手工切分反而更可控。
 * ⚠️ IPv6 必须按 `[::1]:8090` 形态解析——按最后一个冒号切分会把 `::1` 切坏。
 */
function parse_authority(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const v = value.trim()

  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    if (end < 0) return null
    const host = v.slice(0, end + 1).toLowerCase()
    const rest = v.slice(end + 1)
    if (rest === '') return { host, port: null }
    if (!rest.startsWith(':')) return null
    return { host, port: parse_port(rest.slice(1)) }
  }

  const idx = v.lastIndexOf(':')
  // 无端口（`localhost`）与有端口（`localhost:8090`）都要支持
  if (idx < 0) return { host: v.toLowerCase(), port: null }
  const host = v.slice(0, idx).toLowerCase()
  // `::1`（不带方括号）在这里会被切成 host=':' —— 显式放行它，
  // 因为部分客户端确实会发裸 IPv6。
  if (host.includes(':')) return { host: v.toLowerCase(), port: null }
  const port = parse_port(v.slice(idx + 1))
  // ⚠️ 有冒号但端口不是合法数字（例如 `127.0.0.1:` / `127.0.0.1:abc` /
  //    `127.0.0.1:[`）必须判为**畸形**并返回 null。
  //    若在这里放行，`check_host_header` 会因为 `port === null` 而跳过端口比对，
  //    于是畸形 Host 反而比合法 Host 更容易通过——把校验写成了后门。
  if (port === null) return null
  return { host, port }
}

function parse_port(s) {
  const n = Number(s)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null
}

/**
 * Host 头校验（**DNS rebinding 防线**）。
 *
 * ⚠️ 端口必须与**实际监听端口**一致。只判主机名会让
 *    `Host: 127.0.0.1:9999` 这类探测通过，且排查时看不出区别。
 *
 * @param {string|undefined} host_header
 * @param {number} listen_port 实际监听端口
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function check_host_header(host_header, listen_port) {
  if (host_header === undefined || host_header === null || host_header === '') {
    // HTTP/1.1 要求 Host，但 HTTP/1.0 客户端可能不发。缺失即拒——
    // 缺 Host 的请求恰好是"非浏览器"的典型特征，没有放行的理由。
    return { ok: false, reason: 'host_header_missing' }
  }
  const parsed = parse_authority(host_header)
  if (!parsed) return { ok: false, reason: 'host_header_malformed' }
  if (!is_loopback_hostname(parsed.host)) {
    return { ok: false, reason: 'host_not_loopback', host: parsed.host }
  }
  if (parsed.port !== null && Number(listen_port) > 0 && parsed.port !== Number(listen_port)) {
    return { ok: false, reason: 'host_port_mismatch', port: parsed.port, expected: listen_port }
  }
  return { ok: true }
}

/**
 * Origin 白名单校验（**跨站调用防线**）。
 *
 * @param {string|undefined} origin_header
 * @param {number[]} allowed_ports 允许的端口（配置端口 + 实际端口）
 * @returns {{ok:true, origin:string|null} | {ok:false, reason:string, origin:string}}
 */
function check_origin(origin_header, allowed_ports) {
  if (origin_header === undefined || origin_header === null || origin_header === '') {
    // 无 Origin：同源导航 / curl / 启动器探活。不是跨站调用，放行。
    // ⚠️ 这不构成缺口——真正的鉴权是令牌，Origin 只是纵深防御的一层。
    return { ok: true, origin: null }
  }
  const raw = String(origin_header).trim()
  // `Origin: null`（沙箱 iframe、data: URL）一律当作**不可信**来源。
  if (raw.toLowerCase() === 'null') return { ok: false, reason: 'origin_null', origin: raw }

  let parsed
  try {
    parsed = new URL(raw)
  } catch (e) {
    // ⚠️ 不吞异常：Origin 解析失败说明对方发的不是合法 Origin，
    //    必须归因后拒绝，绝不"解析不了就当没有"。
    return { ok: false, reason: `origin_unparsable:${e.name || 'Error'}`, origin: raw }
  }
  if (parsed.protocol !== 'http:') {
    return { ok: false, reason: 'origin_scheme_not_http', origin: raw }
  }
  // URL 会把 IPv6 主机规范化成 `[::1]`
  if (!is_loopback_hostname(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: 'origin_not_loopback', origin: raw }
  }
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  const allowed = (allowed_ports || []).filter((p) => Number.isInteger(p) && p > 0)
  if (!allowed.includes(port)) {
    return { ok: false, reason: 'origin_port_not_whitelisted', origin: raw, port, allowed }
  }
  // ⚠️ 回显的是**规范化后的** origin，不是客户端原始字符串——
  //    绝不把未经验证的输入直接写进响应头。
  return { ok: true, origin: parsed.origin }
}

/**
 * 令牌比较 —— 定长、无短路。
 *
 * ⚠️ 长度不等时 `timingSafeEqual` 会**抛错**，所以必须先比长度、直接返回 false。
 *    "先比长度"本身会泄漏长度信息，但令牌长度是固定的 64 字符（公开信息），
 *    不构成泄漏。内容比较一律走 `timingSafeEqual`。
 *
 * @param {string} expected 服务端持有的令牌
 * @param {string} provided 请求带来的令牌
 * @returns {boolean}
 */
function token_matches(expected, provided) {
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * 从请求里取出令牌。
 *
 * 三种形态都要支持：
 *   · `Authorization: Bearer <token>`（前端 fetch 的默认形态）
 *   · `X-UI-Token: <token>`（便于 curl 与排障）
 *   · `?token=<token>`（**首屏 `GET /` 只能用它**——浏览器不会在地址栏
 *     导航上带自定义头）
 *
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @returns {string|null}
 */
function extract_token(req, url) {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.length > 0) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m) return m[1].trim()
  }
  const header_token = req.headers['x-ui-token']
  if (typeof header_token === 'string' && header_token.trim() !== '') return header_token.trim()
  const q = url.searchParams.get('token')
  if (typeof q === 'string' && q !== '') return q
  return null
}

/**
 * 读取并解析 JSON 请求体。
 *
 * ⚠️ 与 `license-server/api/middleware.js` 的同名逻辑**各自实现一份**，
 *    刻意不共享：两端不得互相 require（AGENTS.md §3），而且服务端那份
 *    还要处理签名验签相关的原始字节。共享只会让两边都不敢改。
 *
 * ⚠️ 超限必须**硬失败**，绝不静默截断：截断后的 JSON 解析失败会伪装成
 *    "客户端发了坏数据"，把真正的攻击特征藏起来。
 *
 * @returns {Promise<object>} 空体 → `{}`
 * @throws {AppError} REPORT_TOO_LARGE（超限）/ REPORT_INVALID（非法 JSON）
 */
function read_json_body(req, max_bytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      // ⚠️ 不再累积数据，但要继续把流读完再销毁，否则部分客户端
      //    （Node 的 keep-alive agent）会看到 ECONNRESET 而不是我们的错误信封。
      req.resume()
      reject(err)
    }

    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > max_bytes) {
        fail(new AppError('REPORT_TOO_LARGE',
          `请求体超过上限（${max_bytes} 字节），已拒绝。请勿提交超大 JSON。`,
          { limit_bytes: max_bytes, received_bytes: total }))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new AppError('REPORT_INVALID', '请求体必须是 JSON 对象'))
        }
        return resolve(parsed)
      } catch (e) {
        return reject(new AppError('REPORT_INVALID', `请求体不是合法 JSON：${e.message}`))
      }
    })

    req.on('error', (e) => {
      // ⚠️ 不吞异常：连接层错误也要归因，否则表现为"请求永远不返回"。
      if (settled) return
      settled = true
      reject(new AppError('SERVER_INTERNAL', `读取请求体失败：${e.message}`))
    })
  })
}

/** 统一的成功信封。⚠️ 不加 `server_time_ms`：本地接口的时钟就是本机时钟。 */
function ok_envelope(extra) {
  return { ok: true, ...(extra || {}) }
}

/** 渠道中文名（与 `license-server/api/quota-notice.js` 的口径一致）。 */
const SOURCE_LABELS_LOCAL = Object.freeze({
  comment: '评论',
  live_danmaku: '弹幕',
  dm: '私信',
})

/**
 * 比率 → 展示文本。
 *
 * ⚠️ 为什么连"格式化"都放在服务端：`null` 必须变成 `—` 而**不是** `0%`
 *    或 `100%`（计划 §4.9 明确要求）。这个判断只要出现在两个地方，
 *    就会出现"接口的 dashboard 显示 —、前端却画成 100%"这种最危险的
 *    不一致。所以前端拿到的直接是**可渲染的字符串**。
 */
function format_ratio(value, digits = 1) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

/** 毫积分 → 积分展示文本。⚠️ 前端不做这个除法（见 format_ratio 的理由）。 */
function format_credit(milli) {
  if (milli === null || milli === undefined) return null
  const n = Number(milli)
  if (!Number.isFinite(n)) return null
  return `${Math.floor(n / 1000)} 积分`
}

/**
 * 给 `buildDashboard()` 的结果补上**只读展示字段**。
 *
 * ⚠️ 语义边界（很重要）：本函数**不改动任何已有字段**，也不重算任何口径。
 *    `counts` / `display` / `by_source` / `failure_reasons` 全部原样来自
 *    `shared/lib/stats.js`（那仍是唯一的口径实现）。这里只**新增**两份
 *    渲染用的派生结构：
 *      · `by_source_display[src].success_rate_display`
 *      · `quota_usage_display[]`、`trend_display{}`、`display_meta`
 *    这样前端可以做到"零算术、零格式化"——它拿到的就是可写进 DOM 的文本。
 *
 * @param {object} dashboard `buildDashboard()` 的返回值
 * @param {object} p
 * @param {Array} p.trend `buildTrend()` 的返回值
 * @param {object|null} p.credit 服务端下发的 credit
 */
function with_display_fields(dashboard, p) {
  const out = { ...dashboard }

  // ── 分渠道成功率（服务端已算好的 `success_rate`，这里只格式化）────
  const by_source_display = {}
  for (const s of out.by_source || []) {
    by_source_display[s.source_type] = {
      success_rate_display: format_ratio(s.success_rate),
      // ⚠️ 保留原始值，便于对账时确认"文本没有说谎"
      success_rate: s.success_rate === undefined ? null : s.success_rate,
    }
  }
  out.by_source_display = by_source_display

  // ── 额度使用率（`usage_ratio === null` → 无进度条，不画 0%）────────
  const quota_display = []
  const usage = out.daily_quota_usage
  if (usage && typeof usage === 'object') {
    for (const src of SOURCE_TYPES) {
      const u = usage[src]
      if (!u) continue
      const known = u.usage_ratio !== null && u.usage_ratio !== undefined
      quota_display.push({
        source_type: src,
        label: SOURCE_LABELS_LOCAL[src] || src,
        max: u.max,
        used: u.used,
        remaining: u.remaining,
        usage_ratio: u.usage_ratio,
        ratio_display: known ? format_ratio(u.usage_ratio, 0) : '—',
        // 进度条宽度百分比。⚠️ `null` = 不画进度条（观察期上限为 0）
        width_percent: known ? Math.round(Number(u.usage_ratio) * 100) : null,
        high: known ? Number(u.usage_ratio) >= 0.8 : false,
        text: `${u.used} / ${u.max}（剩余 ${u.remaining}）`,
      })
    }
  }
  out.quota_usage_display = quota_display

  // ── 趋势柱高（四类计数按同一峰值等比缩放到 0–100）────────────────
  const trend = Array.isArray(p && p.trend) ? p.trend : []
  let peak = 0
  for (const t of trend) {
    for (const k of ['sent_confirmed', 'sent_confirmed_dom', 'sent_suspected', 'failed']) {
      const v = Number(t[k]) || 0
      if (v > peak) peak = v
    }
  }
  const trend_display = {}
  for (const t of trend) {
    const row = {}
    for (const k of ['sent_confirmed', 'sent_confirmed_dom', 'sent_suspected', 'failed']) {
      const v = Number(t[k]) || 0
      // ⚠️ 峰值为 0（全空）时一律 0 —— 绝不画出一根"看似有数据"的柱子。
      row[`${k}_height`] = peak === 0 ? 0 : Number(((v / peak) * 100).toFixed(1))
    }
    trend_display[t.day] = row
  }
  out.trend_display = trend_display

  // ── 其它展示元数据 ───────────────────────────────────────────────
  out.display_meta = {
    quota_usage_display: quota_display.map((q) => `${q.label} ${q.used}/${q.max}（${q.ratio_display}）`),
    credit_display: format_credit(p && p.credit ? p.credit.balance_milli : null),
    credit_milli: p && p.credit && Number.isFinite(Number(p.credit.balance_milli))
      ? Number(p.credit.balance_milli) : null,
    rate_null_hint: '分母为 0 时比率为 null，展示为 —；不得显示为 0% 或 100%',
  }
  return out
}

/**
 * 给熔断快照补上展示字段（前端不做比率换算）。
 * ⚠️ 同样只**新增**字段，不改 `snapshot()` 的任何原值。
 */
function with_circuit_display(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  return {
    ...snapshot,
    failureRateDisplay: format_ratio(snapshot.failureRate),
    failureRateThresholdDisplay: format_ratio(snapshot.failureRateThreshold),
  }
}

/** 统一的失败信封。`code`/`message` 永远存在，`detail` 可选。 */
function error_envelope(code, message, detail) {
  const out = { ok: false, code: String(code || 'SERVER_INTERNAL'), message: String(message || '') }
  if (detail !== undefined && detail !== null) out.detail = detail
  return out
}

/**
 * 把任意异常归一成 `{status, envelope}`。绝不把未知异常原样抛给调用方。
 *
 * ⚠️ 未知异常**不回 200**、也不回空数据：那是 D-14 的形态。
 *    一律 500 + 结构化信封，并保留 `name`/`code` 便于排障（不含堆栈）。
 */
function to_error_response(e) {
  if (e instanceof AppError) {
    return {
      status: e.status || LOCAL_STATUS[e.code] || 500,
      envelope: error_envelope(e.code, e.message, e.detail),
    }
  }
  if (e instanceof WorkbenchError) {
    return {
      status: LOCAL_STATUS[e.code] || 500,
      envelope: error_envelope(e.code, e.message, e.detail),
    }
  }
  // 已登记但非 AppError 的错误（例如 http 层透传的带 code 对象）
  if (e && is_known_app_error_code(e.code)) {
    // eslint-disable-next-line global-require
    const { statusOf } = require('../../shared/lib/errors')
    return {
      status: LOCAL_STATUS[e.code] || statusOf(e.code),
      envelope: error_envelope(e.code, e.message, e.detail),
    }
  }
  const code = isKnownWorkbenchCode(e && e.code) ? e.code : 'INTERNAL'
  return {
    status: LOCAL_STATUS[code] || 500,
    // ⚠️ 未知异常**不回原文**：内部异常消息里可能带文件路径、SQL 片段，
    //    甚至（在更糟的实现里）带凭据。回一句通用说明 + 异常类型即可，
    //    真正的原因由调用方写进 `last_error`（本地可读，不出接口）。
    envelope: error_envelope(code, '本地接口内部错误，请查看本地日志的归因码。', {
      cause: (e && e.name) || 'Error',
    }),
  }
}

/** 取值域整数参数（带默认与上下限）。非法值**不静默取默认**，而是抛错。 */
function int_param(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AppError('REPORT_INVALID', `查询参数 ${name} 必须是整数，收到：${raw}`)
  }
  return Math.min(max, Math.max(min, n))
}

/**
 * 把敏感字符串从一段文本里抹掉（登录密码的 fail-safe）。
 *
 * ⚠️ 这是**兜底**，不是主防线：主防线是"密码从不进入任何持久化字段"
 *    （见 `client/license/state.js` 的 `loginPayload`）。但如果底层某个
 *    异常消息里恰好带上了请求体，它会顺着错误信封回到浏览器、
 *    被截图、被贴进工单。所以出口再抹一遍。
 */
function scrub(text, secret) {
  if (typeof text !== 'string' || !text) return text || ''
  if (typeof secret !== 'string' || secret.length < 4) return text
  return text.split(secret).join('[redacted]')
}

/** 把对象里所有字符串字段里的敏感串抹掉（浅层 + detail 一层）。 */
function scrub_object(obj, secret, depth = 0) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'string') return scrub(obj, secret)
  if (typeof obj !== 'object' || depth > 3) return obj
  if (Array.isArray(obj)) return obj.map((v) => scrub_object(v, secret, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = scrub_object(v, secret, depth + 1)
  return out
}

// ═══════════════════════════════════════════════════════════
// 告警推导（**在服务端算**，前端不重复实现一遍）
// ═══════════════════════════════════════════════════════════

/**
 * 从各模块快照推导告警列表。
 *
 * ⚠️ 为什么放在这里而不是浏览器里：如果浏览器自己算，那么
 *    "什么算异常"就有了两份定义，漂移的表现是"接口说没事、界面报警"
 *    （或更糟：接口在报警、界面一片绿）。告警是**判定**，判定只能有一份。
 *
 * @param {object} p
 * @returns {Array<{code:string, level:'error'|'warn'|'info', title:string, detail:string}>}
 */
function derive_alerts(p) {
  const alerts = []
  const now = p.now_ms
  const guard = p.guard || {}
  const circuit = p.circuit || null
  const queue_stats = p.queue_stats || { total: 0, queued: 0 }
  const license = p.license || {}
  const quota_notice = p.quota_notice || null
  const selector_misses = Number(p.selector_miss_count || 0)
  const policy = p.policy || null

  // ── 急停 ────────────────────────────────────────────────
  if (guard.emergency_stop) {
    alerts.push({
      code: 'emergency_stop',
      level: 'error',
      title: '已急停',
      detail: '所有发送已停止。确认账号状态后再解除急停。',
    })
  }

  // ── 熔断（必须能回答"第几级、何时恢复"）─────────────────
  if (circuit && circuit.open) {
    const level_label = { l1: '第 1 级（30 分钟）', l2: '第 2 级（1 小时）', l3: '第 3 级（停到次日）' }[circuit.level]
      || String(circuit.level || 'unknown')
    alerts.push({
      code: 'circuit_open',
      level: 'error',
      title: `熔断中 · ${level_label}`,
      detail: circuit.hint || '冷却中，暂不发送。',
      level_index: circuit.level_index,
      until_ms: circuit.untilMs,
      remaining_ms: circuit.remainingMs,
      reason: circuit.reason,
    })
  }

  // ── 余额 ────────────────────────────────────────────────
  const credit = p.credit || null
  const balance_milli = credit && Number.isFinite(Number(credit.balance_milli))
    ? Number(credit.balance_milli) : null
  const affordable = quota_notice && Number.isFinite(Number(quota_notice.replies_affordable))
    ? Number(quota_notice.replies_affordable) : null
  if (license.billing_state === 'exhausted' || (balance_milli !== null && balance_milli <= 0)) {
    alerts.push({
      code: 'credit_exhausted',
      level: 'error',
      title: '余额已耗尽',
      detail: '积分不足，发送已停止。请充值后再启动。',
    })
  } else if (affordable !== null && affordable <= LIMITS.alert_credit_low_replies) {
    alerts.push({
      code: 'credit_low',
      level: 'warn',
      title: `余额偏低（还可发 ${affordable} 条）`,
      detail: '按当前消耗速度，余额即将不足以继续发送。',
    })
  }

  // ── 凭据失效 ────────────────────────────────────────────
  if (license.credential_invalid) {
    alerts.push({
      code: 'credential_invalid',
      level: 'error',
      title: '登录凭据已失效',
      detail: `需要重新登录（${license.credential_invalid.code || 'unknown'}）。`,
    })
  } else if (!license.logged_in) {
    alerts.push({
      code: 'credential_invalid',
      level: 'warn',
      title: '未登录',
      detail: '未登录授权中心，发送不会开始。急停按钮仍然可用。',
    })
  }

  // ── 观察期（用**服务端原文**做副标题，不改写）───────────
  if (policy && policy.sending_enabled === false) {
    alerts.push({
      code: 'observation_period',
      level: 'info',
      title: '观察期：仅采集，不发送',
      detail: (quota_notice && quota_notice.headline) || '当前处于观察期，仅采集线索。',
    })
  }

  // ── 活跃时段 ────────────────────────────────────────────
  if (policy && policy.active_hours) {
    const within = isWithinActiveHours(now, policy.active_hours)
    if (!within) {
      const windows = (policy.active_hours.windows || [])
        .map((w) => `${w[0]}–${w[1]}`).join('、')
      alerts.push({
        code: 'outside_active_hours',
        level: 'info',
        title: '当前不在活跃时段',
        detail: `发信时段为 ${windows || '（未配置）'}，时段外不发送。`,
      })
    }
  }

  // ── 队列积压 ────────────────────────────────────────────
  const backlog_limit = Math.floor(MAX_QUEUE_SIZE * QUEUE_BACKLOG_RATIO)
  if (Number(queue_stats.total || 0) >= backlog_limit) {
    alerts.push({
      code: 'queue_backlog',
      level: 'warn',
      title: `队列积压（${queue_stats.total}/${MAX_QUEUE_SIZE}）`,
      detail: '待处理任务已超过队列容量的 80%。继续积压会开始拒绝新任务——'
        + '那些评论就不会被回复了。',
      total: Number(queue_stats.total || 0),
      limit: MAX_QUEUE_SIZE,
    })
  }

  // ── 时钟偏差 ────────────────────────────────────────────
  const skew = Number(license.clock_skew_ms || 0)
  if (Math.abs(skew) > LIMITS.clock_skew_warn_ms) {
    alerts.push({
      code: 'clock_skew',
      level: 'warn',
      title: `本机时钟偏差约 ${Math.round(skew / 1000)} 秒`,
      detail: '签名时间戳超窗会让所有请求被判 AUTH_TS_SKEW。请同步系统时间。',
      clock_skew_ms: skew,
    })
  }

  // ── 选择器漂移 ──────────────────────────────────────────
  if (selector_misses >= LIMITS.selector_drift_threshold) {
    alerts.push({
      code: 'selector_drift',
      level: 'warn',
      title: `选择器命中失败 ${selector_misses} 次（近 1 小时）`,
      detail: '抖音页面可能已改版。选择器集中在 client/platform/selectors.js，'
        + '改一处即可，请核对后更新并标注最后验证日期。',
      count: selector_misses,
    })
  }

  return alerts
}

// ═══════════════════════════════════════════════════════════
// 本地控制台 API
// ═══════════════════════════════════════════════════════════

/**
 * 本地控制台 HTTP 服务。
 *
 * 依赖全部**注入**（store / guard / queue / scheduler / circuit / audit / license），
 * 因为它是唯一需要把各层拼在一起的地方；任何一层缺失都退化成
 * "接口返回空数据"，那正是 D-14 的形态，所以缺依赖时相关路由直接 501。
 */
class LocalControlApi {
  /**
   * @param {object} opts
   * @param {object} opts.config            `loadClientConfig()` 的结果
   * @param {object} opts.store             客户端 Store（唯一写盘者）
   * @param {object} [opts.guard]           Guard 实例
   * @param {object} [opts.queue]           Queue 实例
   * @param {object} [opts.scheduler]       Scheduler 实例
   * @param {object} [opts.circuit]         CircuitBreaker 实例
   * @param {object} [opts.audit]           AuditLog 实例
   * @param {object} [opts.license]         { state, auth, reporter } 或分项传入
   * @param {object} [opts.logger]          需实现 info/warn/error
   * @param {() => number} [opts.now]
   * @param {number} [opts.port]            覆盖端口（测试用 0 = 随机端口）
   * @param {string} [opts.host]            覆盖绑定地址（测试用，仍会断言回环）
   * @param {boolean} [opts.write_token]    是否把令牌写进实例目录（默认 true）
   */
  constructor(opts) {
    if (!opts || !opts.config) throw new Error('LocalControlApi 需要 config')
    if (!opts.store) throw new Error('LocalControlApi 需要 store（唯一写盘者）')

    this.config = opts.config
    this.store = opts.store
    this.guard = opts.guard || null
    this.queue = opts.queue || null
    this.scheduler = opts.scheduler || null
    this.circuit = opts.circuit || null
    this.audit = opts.audit || null
    // ⚠️ 授权层的三个成员有**两组**合法键名：`license_*`（本模块的显式命名）
    //    与 `state`/`auth`/`reporter`（`main.js` 组合根里的自然命名）。
    //    两组都要认——`main.js` 传的是后者，只认前者会让三个依赖静默变成
    //    null，表现是"登录、上报、凭据面板全部 501"，而根因是键名。
    this.license_state = opts.license_state || opts.state || (opts.license && opts.license.state) || null
    this.license_auth = opts.license_auth || opts.auth || (opts.license && opts.license.auth) || null
    this.license_reporter = opts.license_reporter || opts.reporter
      || (opts.license && opts.license.reporter) || null
    this.logger = opts.logger || null
    this.now = opts.now || (() => Date.now())

    this.host = opts.host || this.config.uiHost
    // ⚠️ 端口取 `opts.port` → `config.uiPort`。`0` 是**合法**值（让内核分配），
    //    测试与多实例都靠它，所以判据是 `Number.isInteger` 而不是真值。
    const want_port = Number.isInteger(opts.port) ? opts.port : Number(this.config.uiPort)
    if (!Number.isInteger(want_port) || want_port < 0 || want_port > 65535) {
      throw new Error(`本地控制台端口非法：${want_port}`)
    }
    this.requested_port = want_port
    /** 实际监听端口。listen 之前为 0。 */
    this.port = 0

    this.write_token = opts.write_token !== false
    this.token = generate_token()
    this.token_file = TOKEN_FILE

    /** 启动时刻（`/healthz` 的 uptime 用它） */
    this.started_at_ms = this.now()
    /** 运行时观测到的最近一次错误（可观测面板要展示"上次错误"） */
    this.last_error = null

    this.server = null
    this.listening = false
    this.closed = false
    /** @type {Set<import('node:http').ServerResponse>} 未完成的响应（close 时要收掉） */
    this.open_responses = new Set()
    this.request_count = 0
    this.rejected_auth_count = 0
    this.rejected_origin_count = 0
    this.rejected_host_count = 0

    /**
     * 单次请求内的重读缓存。
     *
     * ⚠️ 存在的理由很实际：`/api/state` 要在看板聚合、趋势、最近发送三处
     *    读同一份审计文件。每处都重读一遍会让每 2 秒的轮询把整个审计文件
     *    解析 3 次（审计文件可以有 8 MB）。而缓存**必须按请求失效**——
     *    跨请求缓存会让界面永远看到第一次的快照。
     */
    this.read_cache = new Map()

    this.server = http.createServer((req, res) => this.#on_request(req, res))
    // ⚠️ 显式设置：默认 keep-alive 超时会让 close() 挂住 5 秒以上，
    //    测试里表现为"测试跑完了进程不退"。
    this.server.keepAliveTimeout = 5000
    this.server.headersTimeout = 10000
    this.server.on('clientError', (err, socket) => {
      // ⚠️ 不吞异常：畸形请求必须留痕（否则表现为"偶尔有请求没响应"）。
      this.#record_error('client_error', err && err.message ? err.message : String(err))
      if (socket && !socket.destroyed && socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } else if (socket && !socket.destroyed) {
        socket.destroy()
      }
    })
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /**
   * 开始监听。
   *
   * ⚠️ 监听成功后**必须回读** `server.address()` 并断言仍是回环。
   *    配置校验（`config.validate`）与实际绑定是两件事：
   *    只信实际，才不会出现"配置写 127.0.0.1、实际绑 0.0.0.0"这种
   *    谁都没看出来的暴露。
   *
   * @returns {Promise<{host:string, port:number, origin:string, token:string}>}
   */
  listen() {
    return new Promise((resolve, reject) => {
      const on_error = (e) => {
        this.server.removeListener('listening', on_listening)
        reject(new AppError('SERVER_UNAVAILABLE', `本地控制台无法监听 ${this.host}:${this.requested_port}：${e.message}`))
      }
      const on_listening = () => {
        this.server.removeListener('error', on_error)
        let addr
        try {
          addr = this.server.address()
        } catch (e) {
          // ⚠️ 不吞异常：拿不到监听地址就无法做回环断言，必须失败而不是"假设它是对的"。
          this.#record_error('address_read_failed', e.message)
          return reject(new AppError('SERVER_INTERNAL', `无法读取监听地址：${e.message}`))
        }
        const bound_host = addr && addr.address ? addr.address : this.host
        if (!is_loopback_hostname(normalize_bound_host(bound_host))) {
          // ⚠️ 回滚：绝不留下一个对外的监听。
          this.server.close()
          this.#record_error('non_loopback_bind', `实际绑定到 ${bound_host}，已拒绝并关闭监听`)
          return reject(new AppError('SERVER_UNAVAILABLE',
            `拒绝把本地控制台绑到 ${bound_host}：本地 API 只能监听回环地址。`,
            { bound_host }))
        }
        this.port = Number(addr && addr.port) || this.requested_port
        this.listening = true
        if (this.write_token) this.#persist_token()
        this.#log('info', 'local_api_listening', {
          host: bound_host, port: this.port, loopback_asserted: true,
        })
        const desc = this.describe()
        // ⚠️ 一并回 `origin`：调用方（启动器与测试）需要的是可直接拼接的
        //    源串，而不是自己从 host/port 拼一遍（拼错就是 CORS 白名单错位）。
        return resolve({ ...desc, origin: desc.url_base.replace(/\/$/, '') })
      }
      this.server.once('error', on_error)
      this.server.once('listening', on_listening)
      this.server.listen(this.requested_port, this.host)
    })
  }

  /**
   * 供启动器拼浏览器地址。
   *
   * ⚠️ `?token=` 是首屏**唯一**可行的令牌传递方式（浏览器不会在地址栏导航上
   *    带自定义头），所以 `url` 里带令牌；`url_base` 是不带令牌的形态，
   *    留给日志与"手工排障时自己拼"。
   * ⚠️ `loopback_asserted` 必须是**回读实际绑定地址**得出的结论，
   *    而不是"配置里写的是回环"。`main.js` 会拿这个字段决定要不要告警。
   */
  describe() {
    const host_for_url = is_ipv6_literal(this.host) ? `[${this.host}]` : this.host
    const bound = this.server ? this.server.address() : null
    const bound_host = bound && bound.address ? normalize_bound_host(bound.address) : null
    return {
      host: this.host,
      port: this.port,
      loopback_asserted: this.listening ? is_loopback_hostname(bound_host || this.host) : false,
      bound_address: bound_host,
      url_base: `http://${host_for_url}:${this.port}/`,
      url: `http://${host_for_url}:${this.port}/?token=${this.token}`,
      token: this.token,
      token_file: this.store.file(this.token_file),
    }
  }

  /**
   * 关闭。**幂等**——重复调用、未监听时调用都必须成功。
   *
   * ⚠️ 除了 server.close()，还要主动收掉 keep-alive 连接，
   *    否则 `node --test` 会因为句柄未释放而挂住。
   */
  close() {
    if (this.closed) return Promise.resolve({ already_closed: true })
    this.closed = true
    const had_listener = this.listening
    this.listening = false

    for (const res of this.open_responses) {
      try {
        res.destroy()
      } catch (e) {
        // ⚠️ 不吞异常：销毁失败说明有响应卡住，但**不能**因此让 close 抛错
        //    （调用方是在停机路径上调它的）。归因记录即可。
        this.#record_error('response_destroy_failed', e.message)
      }
    }
    this.open_responses.clear()

    return new Promise((resolve) => {
      if (!this.server) return resolve({ closed: true, had_listener: false })
      this.server.close(() => resolve({ closed: true, had_listener }))
      // Node 18+ 有 closeAllConnections；没有就退回 closeIdleConnections。
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections()
      else if (typeof this.server.closeIdleConnections === 'function') this.server.closeIdleConnections()
      return undefined
    })
  }

  // ── 请求入口 ──────────────────────────────────────────────

  async #on_request(req, res) {
    this.request_count += 1
    // ⚠️ 每个请求开头清缓存：必须按请求失效，否则界面看到的是旧快照。
    this.read_cache.clear()
    this.open_responses.add(res)
    res.on('close', () => this.open_responses.delete(res))

    let url
    try {
      url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    } catch (e) {
      // ⚠️ 不吞异常：非法 URL 必须以结构化错误回绝。
      return this.#send(res, 400, error_envelope('REPORT_INVALID', `请求路径非法：${e.message}`))
    }

    try {
      // ① Host（DNS rebinding 防线）—— 最先判，因为它不依赖任何业务状态
      const host_check = check_host_header(req.headers.host, this.port || this.requested_port)
      if (!host_check.ok) {
        this.rejected_host_count += 1
        this.#log('warn', 'local_api_host_rejected', {
          reason: host_check.reason, host: req.headers.host || null,
        })
        return this.#send(res, 403, error_envelope('AUTH_FORBIDDEN',
          '请求的 Host 不是本机回环地址，已拒绝（防 DNS rebinding）。',
          { reason: host_check.reason }))
      }

      // ② Origin（跨站调用防线）
      const origin_check = check_origin(req.headers.origin, this.#allowed_ports())
      if (!origin_check.ok) {
        this.rejected_origin_count += 1
        this.#log('warn', 'local_api_origin_rejected', {
          reason: origin_check.reason, origin: origin_check.origin || null,
        })
        // ⚠️ 这里**不回**任何 CORS 头：连"这个来源被拒了"都不告诉它。
        return this.#send(res, 403, error_envelope('AUTH_FORBIDDEN',
          '请求来源不在本地白名单内，已拒绝。', { reason: origin_check.reason }))
      }

      // ③ 预检：显式应答，且只回白名单里的方法/头
      if (req.method === 'OPTIONS') return this.#handle_preflight(res, origin_check.origin)

      const cors = origin_check.origin
        ? { 'Access-Control-Allow-Origin': origin_check.origin, Vary: 'Origin' }
        : {}

      // ④ 静态资源（`/`、`/app.css`、`/app.js`）—— 不含任何运行数据，
      //    因而**不需要令牌**：浏览器首屏导航带不了自定义头，
      //    而首页只负责把 `?token=` 交给 app.js。
      if (req.method === 'GET' && STATIC_ASSETS[url.pathname]) {
        return this.#serve_static(res, url.pathname, cors)
      }

      // ⑤ 健康检查 —— **不需要令牌**（回环 + Host 校验就是边界），
      //    启动器靠它探活；它也不泄漏任何运行数据。
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return this.#send(res, 200, this.#healthz(), cors)
      }

      // ⑥ `/api/*`：令牌是硬门
      if (url.pathname.startsWith('/api/')) {
        const provided = extract_token(req, url)
        if (!token_matches(this.token, provided)) {
          this.rejected_auth_count += 1
          // ⚠️ 日志里**不记令牌本身**，只记"有几次失败"。令牌是凭据。
          this.#log('warn', 'local_api_token_rejected', {
            path: url.pathname,
            had_token: provided !== null,
          })
          return this.#send(res, 401, error_envelope('AUTH_TOKEN_INVALID',
            '本地控制台令牌缺失或不正确。请从启动器打开的页面进入。'), cors)
        }
        return await this.#route_api(req, res, url, cors)
      }

      // ⑦ 其余一律 501（**绝不** 200 + 空数据：那是 D-14 的形态）
      return this.#send(res, 501, error_envelope('NOT_IMPLEMENTED',
        `本地控制台未实现该路径：${url.pathname}`, { path: url.pathname }), cors)
    } catch (e) {
      // ⚠️ 兜底：任何 handler 抛出都不能让进程挂掉，必须变成结构化信封。
      //    真实异常先记进 `last_error`（接口回的是通用文案，不含原文）。
      const raw_message = (e && e.message) || String(e)
      const { status, envelope } = to_error_response(e)
      this.#record_error(envelope.code, raw_message)
      if (!res.headersSent) return this.#send(res, status, envelope)
      // 头已发出（例如静态文件流到一半出错）→ 只能断开，但要留痕。
      this.#log('error', 'local_api_late_failure', { code: envelope.code })
      return res.destroy()
    }
  }

  /** 允许的端口集合：配置端口 + 实际端口（测试用 0 时两者不同）。 */
  #allowed_ports() {
    const ports = []
    if (Number.isInteger(this.port) && this.port > 0) ports.push(this.port)
    if (Number.isInteger(this.requested_port) && this.requested_port > 0) ports.push(this.requested_port)
    return [...new Set(ports)]
  }

  #handle_preflight(res, cors_origin) {
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-UI-Token',
      'Access-Control-Max-Age': '600',
    }
    // ⚠️ 只有白名单来源才回 Allow-Origin。到这一步还没被拒，说明它在白名单里；
    //    但仍然按"有 origin 才回"的规则走，避免给出通配语义。
    if (cors_origin) {
      headers['Access-Control-Allow-Origin'] = cors_origin
      headers.Vary = 'Origin'
    }
    return this.#send_raw(res, 204, headers, null)
  }

  /**
   * 读静态前端资源。
   *
   * ⚠️ **这是本文件里唯一的 `fs` 用法**，且只读 `client/ui/` 下的三个文件。
   *    它们属于**代码**（随包分发），不是运行数据，因此不受
   *    "只有 store 能碰盘"（AGENTS.md §2.9 单写者）约束——那条约束针对的是
   *    `queue.json` / `runtime-state.json` 这类会被多个进程读写的运行数据。
   *    本文件对运行数据的读写**全部**经 `store`。
   * ⚠️ 路径来自 `STATIC_ASSETS` 白名单，不拼接用户输入 → 无目录穿越。
   */
  #serve_static(res, pathname, cors) {
    const asset = STATIC_ASSETS[pathname]
    const full = path.join(UI_DIR, asset.file)
    fs.readFile(full, (err, buf) => {
      if (err) {
        this.#record_error('static_asset_missing', `${asset.file}: ${err.message}`)
        return this.#send(res, 500, error_envelope('SERVER_INTERNAL',
          `前端资源缺失：${asset.file}。请确认 client/ui/ 目录完整。`,
          { file: asset.file, cause: err.code || err.name }), cors)
      }
      const headers = {
        'Content-Type': asset.type,
        // ⚠️ 控制台是本地单机工具，前端资源不做缓存：否则改了 app.js
        //    商家要按 Ctrl+F5 才生效，而"界面没更新"会被误判成服务没起。
        'Cache-Control': 'no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(buf.length),
        ...cors,
      }
      return this.#send_raw(res, 200, headers, buf)
    })
    return undefined
  }

  // ── 路由 ──────────────────────────────────────────────────

  async #route_api(req, res, url, cors) {
    const route = `${req.method} ${url.pathname}`

    switch (route) {
      case 'GET /api/state':
        return this.#send(res, 200, ok_envelope(this.build_state()), cors)
      case 'GET /api/dashboard':
        return this.#send(res, 200, ok_envelope(this.build_dashboard_payload(
          int_param(url, 'days', 7, 1, 90)
        )), cors)
      case 'GET /api/audit':
        return this.#send(res, 200, ok_envelope(this.#audit_payload(url)), cors)
      case 'GET /api/queue':
        return this.#send(res, 200, ok_envelope(this.#queue_payload(url)), cors)
      case 'GET /api/limits':
        return this.#send(res, 200, ok_envelope(this.#limits_payload()), cors)
      case 'GET /api/rules':
        return this.#send(res, 200, ok_envelope({ rules: this.#read_rules() }), cors)
      case 'GET /api/sends/pending-count':
        return this.#send(res, 200, ok_envelope({ pending_count: this.#pending_count() }), cors)
      case 'POST /api/rules':
        return this.#send(res, 200, ok_envelope(await this.#save_rules(req)), cors)
      case 'POST /api/emergency-stop':
        return this.#send(res, 200, ok_envelope(await this.#emergency_stop(req)), cors)
      case 'POST /api/engine':
        return this.#send(res, 200, ok_envelope(await this.#engine_action(req)), cors)
      case 'POST /api/limits':
        return this.#send(res, 200, ok_envelope(await this.#set_limit(req)), cors)
      case 'POST /api/redeem':
        // ⚠️ 刻意不实现：兑换必须走授权中心的 `credit/redeem`，由服务端
        //    做幂等与并发控制（`BEGIN IMMEDIATE` + `code_hash` 唯一索引）。
        //    客户端自己实现一份，会让"同一个兑换码被兑换两次"变成可能。
        //    返回 501 并**说明原因**，而不是 200 + 空数据。
        return this.#send(res, 501, error_envelope('NOT_IMPLEMENTED',
          '本地控制台未实现兑换接口。兑换必须经授权中心的 credit/redeem 接口完成，'
          + '以保证并发兑换同一个码时只有一个成功。',
          { upstream: 'credit/redeem' }), cors)
      case 'POST /api/report/now':
        return this.#send(res, 200, ok_envelope(await this.#report_now()), cors)
      case 'POST /api/login':
        return this.#send(res, 200, ok_envelope(await this.#login(req)), cors)
      case 'POST /api/logout':
        return this.#send(res, 200, ok_envelope(await this.#logout()), cors)
      default:
        // ⚠️ 501 而不是 404：这里的语义是"路径存在但本版本没实现"与
        //    "完全没有这个路径"共用一个答复。无论哪种，**回空数据都是错的**。
        //    支持 GET 的路径被用 POST 调用时也走这里，并在 detail 里点明。
        return this.#send(res, 501, error_envelope('NOT_IMPLEMENTED',
          `本地控制台未实现接口：${req.method} ${url.pathname}`,
          { method: req.method, path: url.pathname }), cors)
    }
  }

  #healthz() {
    return {
      ok: true,
      instance_id: this.config.instanceId || null,
      uptime_ms: Math.max(0, this.now() - this.started_at_ms),
      version: this.#client_version(),
      // ⚠️ 健康检查**不带任何凭据**，也不带任何统计数字。
      //    它是启动器的探活口，回环 + Host 校验就是它的边界。
    }
  }

  #client_version() {
    try {
      // eslint-disable-next-line global-require
      return require('../../package.json').version || '0.0.0'
    } catch (e) {
      // ⚠️ 不吞异常：读不到版本说明分发包不完整，必须留痕（否则健康检查
      //    会静默显示 0.0.0，排障时以为是版本没升）。
      this.#record_error('package_version_unreadable', e.message)
      return '0.0.0'
    }
  }

  // ── GET /api/state（界面每 2 秒轮询的唯一聚合）──────────────

  /**
   * 构造界面所需的完整聚合。
   *
   * ⚠️ 三处红线相关的要求：
   *   ① `license` 必须是 `state.redacted()` 的结果 —— **绝不**带
   *      `token` / `sign_key` 原文（红线 3 的隐私边界）。
   *   ② `quota_notice` **原样**透传服务端文本（红线 1 的文案要求），
   *      本文件不加工、不截断、不改写。
   *   ③ 所有看板算术走 `shared/lib/stats.js`（`buildDashboard` / `buildTrend`），
   *      本文件与前端都**不做**自己的除法。
   */
  build_state() {
    const now = this.now()
    const guard_snapshot = this.guard ? this.guard.snapshot() : null
    const engine = this.scheduler ? this.scheduler.snapshot() : null
    const circuit_snapshot = this.#circuit_snapshot()
    const queue_stats = this.queue ? this.queue.stats() : null
    const license_redacted = this.#license_redacted()
    const quota_notice = this.license_state ? (this.license_state.quotaNotice || null) : null
    const credit = this.license_state ? (this.license_state.credit || null) : null
    const policy = this.license_state ? (this.license_state.policy || null) : null
    const daily_quota = this.#daily_quota(guard_snapshot, quota_notice)
    const dashboard_payload = this.build_dashboard_payload(7, { daily_quota })
    const selector_miss_count = this.#selector_miss_count(now)

    const alerts = derive_alerts({
      now_ms: now,
      guard: guard_snapshot,
      circuit: circuit_snapshot,
      queue_stats: queue_stats || { total: 0, queued: 0 },
      license: license_redacted || {},
      quota_notice,
      policy,
      credit,
      selector_miss_count,
    })

    return {
      now_ms: now,
      poll_interval_ms: POLL_INTERVAL_MS,
      instance_id: this.config.instanceId || null,
      // ── 引擎（调度器快照；未接调度器时为 null，前端显示"未接入"）──
      engine,
      // ── 护栏（红线 1 的客户端落地状态）────────────────────
      guard: guard_snapshot,
      // ── 熔断（必须能回答"第几级、何时恢复"）───────────────
      circuit: circuit_snapshot,
      // ── 队列 ──────────────────────────────────────────────
      queue: queue_stats
        ? { stats: queue_stats, items: this.queue.list({ limit: LIMITS.queue_items }) }
        : null,
      // ── 授权（脱敏）──────────────────────────────────────
      license: license_redacted,
      license_present: Boolean(this.license_state),
      // ── 看板（算术全部来自 shared/lib/stats.js）────────────
      dashboard: dashboard_payload.dashboard,
      trend: dashboard_payload.trend,
      // ── 额度文案：**原样**，红线 1 要求逐字展示 ────────────
      quota_notice: quota_notice,
      credit,
      // ── 告警（判定只在这一处）─────────────────────────────
      alerts,
      // ── 最近发送（只有哈希与判定，没有原文）──────────────
      recent_sends: this.#recent_sends(LIMITS.recent_sends),
      // ── 上次错误（可观测面板的"上次错误 + 归因码"）────────
      last_error: this.#last_error(),
      // ── 审计健康度（损坏行数必须可见）────────────────────
      audit_stats: this.#audit_stats(),
      // ── 未接入的依赖（让前端能明确说"未接入"而不是画 0）──
      missing_dependencies: this.#missing_dependencies(),
    }
  }

  /**
   * 当日额度。**优先用服务端下发的 `daily_quota`**（契约 §4.5 心跳带回，
   * 由 `state.js` 的 `adoptHeartbeatResult` 落到 `state.dailyQuota`），
   * 缺失时才用护栏的生效限额与本地已用量兜底（离线时的唯一可用依据）。
   *
   * ⚠️ 两者顺序不能反：服务端是**权威**，本地用量只反映本机。
   *    反了会出现"服务端说今日还剩 5 条、界面说还剩 28 条"。
   */
  #daily_quota(guard_snapshot, quota_notice) {
    const from_server = this.#server_daily_quota()
    if (from_server) return from_server
    if (!guard_snapshot || !guard_snapshot.limits) return null
    const out = {}
    for (const src of SOURCE_TYPES) {
      const l = guard_snapshot.limits[src]
      if (!l) continue
      out[src] = { max: Number(l.daily_max || 0), used: Number((guard_snapshot.used || {})[src] || 0) }
    }
    return out
  }

  /**
   * 服务端下发的当日额度（`heartbeat.daily_quota`）。
   *
   * ⚠️ 白名单式重建（只取 `max` / `used`），**不 spread 服务端对象**：
   *    心跳体的其余字段属于服务端内部结构，不该顺着控制台接口漏到页面。
   *    ⚠️ 且 `reports` 里可能没有 `used`（服务端只给上限），此时整体返回 null
   *    由护栏兜底——填 0 会让看板显示"今日一条都没发"。
   */
  #server_daily_quota() {
    if (!this.license_state) return null
    const raw = this.license_state.dailyQuota
    if (!raw || typeof raw !== 'object') return null
    const out = {}
    for (const src of SOURCE_TYPES) {
      const q = raw[src]
      if (!q || typeof q !== 'object') continue
      const max = Number(q.max)
      if (!Number.isFinite(max)) continue
      const used = Number(q.used)
      if (!Number.isFinite(used)) return null
      out[src] = { max, used }
    }
    return Object.keys(out).length > 0 ? out : null
  }

  #circuit_snapshot() {
    if (!this.circuit) return null
    // ⚠️ 用合并视图：`circuit.js` 的完整状态机与 `guard.js` 的简化熔断
    //    是两份状态，取"级别更大、到期更晚、任一 open 即 open"。
    //    只报其中一份会让商家看到"界面说正常、实际在熔断"。
    if (this.guard && typeof this.circuit.guardCircuit === 'function') {
      const merged = this.circuit.guardCircuit(this.guard, this.now())
      return with_circuit_display({
        ...this.circuit.snapshot(this.now()),
        level: merged.levelName,
        level_index: merged.level,
        open: merged.open,
        untilMs: merged.untilMs,
        remainingMs: merged.remainingMs,
        reason: merged.reason,
        source: merged.from,
        guard_circuit: merged.guard,
        state_machine: merged.own,
      })
    }
    return with_circuit_display(this.circuit.snapshot(this.now()))
  }

  // ── 看板与趋势 ────────────────────────────────────────────

  /**
   * @param {number} days 趋势天数
   * @param {object} [pre] 预计算的 daily_quota（避免 /api/state 里算两遍）
   */
  build_dashboard_payload(days = 7, pre = {}) {
    const now = this.now()
    const guard_snapshot = this.guard ? this.guard.snapshot() : null
    const quota_notice = this.license_state ? (this.license_state.quotaNotice || null) : null
    const daily_quota = pre.daily_quota !== undefined ? pre.daily_quota : this.#daily_quota(guard_snapshot, quota_notice)

    // ── 聚合口径：**明细优先**（契约 §4.7），没有明细才退回聚合上报 ──
    const sends = this.#send_details()
    const reports = this.#usage_reports()
    const agg = reports.length > 0
      ? aggregateReports(reports)
      : this.#aggregate_from_details(sends)

    const dashboard = buildDashboard(agg, {
      dailyQuota: daily_quota,
      extra: {
        // ⚠️ 注明数据来源，便于对账时判断"看板为什么和明细不一样"。
        aggregation_source: reports.length > 0 ? 'usage_reports' : 'send_details',
        window: { from_ms: null, to_ms: null, days },
      },
    })

    const trend = buildTrend(sends, { days, nowMs: now })
    // ⚠️ 只在**新增**的展示字段上做派生，口径仍全部来自 `buildDashboard`。
    const with_display = with_display_fields(dashboard, {
      trend,
      credit: this.license_state ? this.license_state.credit : null,
    })
    return { dashboard: with_display, trend, quota_notice }
  }

  /**
   * 把本地明细（待上报的 + 已上报审计里的）归一成 `stats.js` 要的结构。
   *
   * ⚠️ 为什么不直接读 `pending-sends.json` 就完事：明细上报成功后本地记录
   *    会被删除（服务端已受理），只看待上报文件会让看板在每次上报后
   *    **数字归零**——商家会以为数据丢了。所以把审计里的 `send_result`
   *    一并取回。审计是只追加的，覆盖面更完整。
   */
  #send_details() {
    const out = []
    const seen = new Set()

    const push = (r, at_field) => {
      if (!r || typeof r !== 'object') return
      const send_id = r.send_id || r.sendId || null
      if (send_id) {
        if (seen.has(send_id)) return
        seen.add(send_id)
      }
      const at = Number(r[at_field] !== undefined ? r[at_field] : r.sent_at_ms)
      if (!Number.isFinite(at)) return
      const verdict = r.verdict || (r.is_final === false ? 'sent_suspected' : null)
      if (!verdict) return
      out.push({
        send_id,
        source_type: r.source_type || r.sourceType || null,
        verdict,
        sent_at_ms: at,
        user_key_hash: r.user_key_hash || r.userKeyHash || null,
      })
    }

    for (const r of this.store.readJson('pending-sends.json', [])) push(r, 'sent_at_ms')
    for (const r of this.#audit_query({ kind: 'send_result' })) push(r, 'tsMs')

    return out
  }

  /**
   * 从明细直接聚合（没有聚合上报时的兜底）。
   *
   * ⚠️ 用 `stats.js` 的 `emptySources()` 起手，保证三来源齐全——
   *    少一个来源会让对账出现永久性的 `aggregate_mismatch`。
   */
  #aggregate_from_details(sends) {
    const sources = emptySources()
    const failure_reasons = {}
    const audit_flags = []
    const users_by_source = {}
    const all_users = new Set()
    for (const src of SOURCE_TYPES) users_by_source[src] = new Set()

    for (const s of sends) {
      const src = s.source_type
      if (!SOURCE_TYPES.includes(src)) { audit_flags.push('unknown_source_type'); continue }
      const b = sources[src]
      if (s.verdict === 'sent_confirmed') {
        b.sent_confirmed += 1
        b.reply_attempts += 1
        if (s.user_key_hash) { users_by_source[src].add(s.user_key_hash); all_users.add(s.user_key_hash) }
      } else if (s.verdict === 'sent_confirmed_dom') {
        b.sent_confirmed_dom += 1
        b.reply_attempts += 1
      } else if (s.verdict === 'sent_suspected') {
        b.sent_suspected += 1
        b.reply_attempts += 1
      } else if (s.verdict === 'failed') {
        b.failed += 1
        b.reply_attempts += 1
      } else {
        audit_flags.push('unknown_verdict')
      }
    }

    // 失败归因从审计的 send_result 里取（明细不带原因分布）
    for (const r of this.#audit_query({ kind: 'send_result' })) {
      if (!r || r.verdict !== 'failed' || !r.failureReason) continue
      failure_reasons[r.failureReason] = (failure_reasons[r.failureReason] || 0) + 1
    }

    for (const src of SOURCE_TYPES) sources[src].unique_users = users_by_source[src].size

    const sum = (f) => SOURCE_TYPES.reduce((a, s) => a + Number(sources[s][f] || 0), 0)
    return {
      sources,
      totals: {
        hits: sum('hits'), leads_new: sum('leads_new'), reply_attempts: sum('reply_attempts'),
        sent_confirmed: sum('sent_confirmed'), sent_confirmed_dom: sum('sent_confirmed_dom'),
        sent_suspected: sum('sent_suspected'), failed: sum('failed'), skipped: sum('skipped'),
        unique_users: sum('unique_users'),
      },
      failure_reasons,
      audit_flags: [...new Set(audit_flags)],
    }
  }

  /** 本地留存的聚合上报（若有）。⚠️ 只读，不改本地计数（契约 §4.7）。 */
  #usage_reports() {
    const rows = this.store.readJson('usage-reports.json', [])
    return Array.isArray(rows) ? rows : []
  }

  // ── 审计 ──────────────────────────────────────────────────

  #audit_query(q) {
    if (!this.audit || typeof this.audit.query !== 'function') return []
    const cache_key = JSON.stringify(q || {})
    if (this.read_cache.has(cache_key)) return this.read_cache.get(cache_key)
    try {
      const rows = this.audit.query(q) || []
      this.read_cache.set(cache_key, rows)
      return rows
    } catch (e) {
      // ⚠️ 不吞异常：审计读不出来必须归因并显式暴露。
      //    但**不抛**——审计故障不该让整个控制台打不开（急停还得能用）。
      this.#record_error('audit_query_failed', e.message)
      return []
    }
  }

  #audit_payload(url) {
    if (!this.audit) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '本地审计未接入（audit 未注入），无法提供审计查询。')
    }
    // ⚠️⚠️ `kind` 的校验必须放在**这里**，不能指望底层抛错：
    //    `#audit_query` 出于"审计故障不该让控制台打不开"的考虑会捕获异常并
    //    返回空数组，于是"未知 kind"会变成 `200 + entries: []`——
    //    正是 D-14 的形态（接口返回空数据，界面渲染成 0）。
    //    参数校验属于**调用方**的责任，必须在进入容错层之前完成。
    const kind = url.searchParams.get('kind') || undefined
    if (kind !== undefined && !AUDIT_KINDS.includes(kind)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知的审计条目类型：${kind}`,
        { allowed: AUDIT_KINDS })
    }
    const from_raw = url.searchParams.get('from')
    const to_raw = url.searchParams.get('to')
    const parse_time = (raw, name) => {
      if (raw === null || raw === '') return undefined
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        throw new AppError('REPORT_INVALID', `查询参数 ${name} 必须是毫秒时间戳，收到：${raw}`)
      }
      return n
    }
    const rows = this.#audit_query({
      kind,
      fromMs: parse_time(from_raw, 'from'),
      toMs: parse_time(to_raw, 'to'),
      limit: int_param(url, 'limit', LIMITS.audit_rows, 1, LIMITS.audit_rows_max),
      includeRotated: url.searchParams.get('rotated') === '1',
    })
    return {
      entries: rows,
      count: rows.length,
      // ⚠️ 损坏行数必须随查询一起返回（`audit.query` 把它挂在数组上）：
      //    "审计少了几条"这种事不能只在日志里。
      corrupt_lines: Number(rows.corruptLines || 0),
      read_files: Array.isArray(rows.readFiles) ? rows.readFiles : [],
      stats: this.#audit_stats(),
    }
  }

  #audit_stats() {
    if (!this.audit || typeof this.audit.stats !== 'function') return null
    try {
      return this.audit.stats()
    } catch (e) {
      this.#record_error('audit_stats_failed', e.message)
      return null
    }
  }

  /** 近 1 小时内选择器未命中的次数（选择器漂移的信号）。 */
  #selector_miss_count(now_ms) {
    const rows = this.#audit_query({
      fromMs: now_ms - LIMITS.selector_drift_window_ms,
      limit: LIMITS.audit_rows_max,
    })
    let n = 0
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      if (r.code === 'SELECTOR_MISS' || r.reason === 'selector_miss' || r.event === 'selector_miss') n += 1
    }
    return n
  }

  // ── 最近发送（只有哈希与判定）─────────────────────────────

  /**
   * ⚠️ 四个 verdict **绝不合并**（计划 §4.9："sent_confirmed_dom 与
   *    sent_suspected 单列，不并入"）。前端按四个名字分别渲染。
   * ⚠️ 不带评论原文、回复原文、sec_uid —— 只带哈希与判定（红线 3）。
   */
  #recent_sends(limit) {
    const rows = this.#audit_query({ kind: 'send_result', limit })
    const out = []
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (!r || typeof r !== 'object') continue
      out.push({
        send_id: r.sendId || null,
        source_type: r.sourceType || null,
        verdict: r.verdict || null,
        confirm_signal: r.confirmSignal || null,
        platform_status_code: r.platformStatusCode === undefined ? null : r.platformStatusCode,
        failure_reason: r.failureReason || null,
        risk_control_signal: r.riskControlSignal || null,
        target_hash: r.targetHash || null,
        user_key_hash: r.userKeyHash || null,
        at_ms: Number(r.tsMs) || 0,
      })
      if (out.length >= limit) break
    }
    return out
  }

  // ── 队列 ──────────────────────────────────────────────────

  #queue_payload(url) {
    if (!this.queue) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '队列未接入（queue 未注入），无法提供队列查询。')
    }
    const state = url.searchParams.get('state') || undefined
    if (state && !['queued', 'processing', 'done', 'skipped', 'failed'].includes(state)) {
      throw new AppError('REPORT_INVALID', `未知的队列状态：${state}`,
        { allowed: ['queued', 'processing', 'done', 'skipped', 'failed'] })
    }
    const limit = int_param(url, 'limit', LIMITS.queue_items, 1, LIMITS.queue_items_max)
    return {
      stats: this.queue.stats(),
      items: this.queue.list({ state, limit }),
      limit,
      max_queue_size: MAX_QUEUE_SIZE,
    }
  }

  // ── 限额 ──────────────────────────────────────────────────

  /** 每渠道的**服务端值**与当前生效值（界面要在输入框旁展示服务端值）。 */
  #limits_payload() {
    if (!this.guard) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '安全护栏未接入（guard 未注入），无法提供限额查询。')
    }
    const policy = this.guard.policy
    if (!policy) {
      return {
        policy_version: null,
        available: false,
        // ⚠️ 明确说明"还没拿到策略"，而不是回一份空限额让界面画 0。
        reason: 'policy_missing',
        message: '尚未从服务端取得策略。没有策略就没有上限依据，发送已被拒绝（fail-closed）。',
        sources: {},
      }
    }
    const sources = {}
    for (const src of SOURCE_TYPES) {
      const server = (policy.limits && policy.limits[src]) || null
      const effective = this.guard.effectiveLimits(src)
      if (!server || !effective) continue
      sources[src] = {
        server: {
          daily_max: Number(server.daily_max),
          min_interval_ms: Number(server.min_interval_ms),
          content_similarity_max: Number(server.content_similarity_max),
        },
        effective: {
          daily_max: Number(effective.daily_max),
          min_interval_ms: Number(effective.min_interval_ms),
          content_similarity_max: Number(effective.content_similarity_max),
        },
        override: {
          daily_max: this.guard.overrides[`${src}.daily_max`],
          min_interval_ms: this.guard.overrides[`${src}.min_interval_ms`],
          content_similarity_max: this.guard.overrides[`${src}.content_similarity_max`],
        },
        used: this.guard.usedToday(src),
      }
    }
    return {
      policy_version: policy.policy_version === undefined ? null : Number(policy.policy_version),
      account_tier: policy.account_tier || null,
      available: true,
      // ⚠️ 界面据此显示"只能更保守"，这句话的方向由服务端给出而不是前端写死。
      direction_hint: '只能更保守',
      fields: {
        daily_max: '只能调低',
        min_interval_ms: '只能调高',
        content_similarity_max: '只能调低（越低越严格）',
      },
      active_hours: policy.active_hours || null,
      sources,
    }
  }

  // ── 动作 ──────────────────────────────────────────────────

  /**
   * 急停开/关。
   *
   * ⚠️⚠️ **绝不受 license 状态门控**：未登录、无策略、会话已失效时
   *    都必须能成功。这是商家"一键停机"的唯一保证；把它挂在
   *    "已登录 + 有策略"上，等于在最需要它的时候把它关掉。
   *    因此本方法**不读** `license_state`、**不调** `guard.canSend()`。
   */
  async #emergency_stop(req) {
    if (!this.guard) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '安全护栏未接入（guard 未注入），无法执行急停。')
    }
    const body = await read_json_body(req)
    if (typeof body.on !== 'boolean') {
      throw new AppError('REPORT_INVALID', '急停接口需要 body.on（true=急停，false=解除）')
    }
    const reason = body.reason === undefined || body.reason === null
      ? null : String(body.reason).slice(0, 200)

    this.guard.setEmergencyStop(body.on, reason || (body.on ? '用户手动急停' : undefined))

    // 急停同时停调度器。⚠️ 顺序：先立护栏（防止这一瞬间还有任务被放行），
    //    再停循环。反过来会有一个"护栏还没生效、循环又取走一条任务"的窗口。
    let scheduler_result = null
    if (this.scheduler && body.on) {
      scheduler_result = this.scheduler.stop(reason || 'emergency_stop')
    }

    if (this.audit) {
      try {
        this.audit.recordEmergencyStop({
          on: body.on, reason, actor: 'local_user', atMs: this.now(),
        })
      } catch (e) {
        // ⚠️ 不吞异常：审计写不进去必须显式暴露。但**不能**因此让急停失败——
        //    护栏状态已经生效，报错会让商家以为没停成。
        this.#record_error('audit_emergency_stop_failed', e.message)
      }
    }

    return {
      on: Boolean(this.guard.emergencyStop),
      reason: this.guard.emergencyReason,
      engine: scheduler_result,
      // ⚠️ 明确回一句"停的是发送，不是程序"——商家最容易误解这一点。
      message: body.on
        ? '已急停：所有发送立即停止。采集与心跳不受影响，程序不会退出。'
        : '已解除急停。若仍在观察期或熔断中，发送依然不会开始。',
    }
  }

  /** 引擎启停。 */
  async #engine_action(req) {
    if (!this.scheduler) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '调度器未接入（scheduler 未注入），无法控制引擎。')
    }
    const body = await read_json_body(req)
    const action = String(body.action || '')
    if (!['start', 'stop', 'pause', 'resume'].includes(action)) {
      throw new AppError('REPORT_INVALID',
        `未知的引擎动作：${body.action}（允许：start/stop/pause/resume）`)
    }
    const reason = body.reason === undefined || body.reason === null
      ? null : String(body.reason).slice(0, 200)

    let result
    let engine_state
    if (action === 'start') {
      // ⚠️ 急停生效时**不许**通过"启动引擎"绕过它。急停必须先解除。
      if (this.guard && this.guard.emergencyStop) {
        throw new AppError('POLICY_SENDING_DISABLED',
          '急停生效中，无法启动引擎。请先解除急停。', { emergency_stop: true })
      }
      result = this.scheduler.start()
    } else if (action === 'stop') {
      result = this.scheduler.stop(reason || 'user_stop')
    } else if (action === 'pause') {
      // 暂停 30 分钟是**界面手势**的默认值；真正的时长仍由护栏与策略决定。
      const until = Number(body.until_ms) > 0 ? Number(body.until_ms) : this.now() + 1800000
      result = this.scheduler.pauseUntil(until, reason || 'user_pause')
    } else {
      if (this.guard && this.guard.emergencyStop) {
        throw new AppError('POLICY_SENDING_DISABLED',
          '急停生效中，无法恢复。请先解除急停。', { emergency_stop: true })
      }
      const gate = this.guard ? this.guard.canSend({ sourceType: 'comment', atMs: this.now() }) : { allow: true }
      if (!gate.allow) {
        // ⚠️ 恢复被护栏拒绝时**照样如实返回**（不是静默成功）。
        //    商家看到"已恢复"但一条也发不出去，会以为程序坏了。
        return {
          action, applied: false, engine: this.scheduler.snapshot(),
          denied_by_guard: gate.reason, detail: gate.detail || null,
          message: `护栏拒绝了本次恢复：${gate.reason}`,
        }
      }
      result = this.scheduler.resume(reason || 'user_resume')
    }

    if (this.audit) {
      try {
        this.audit.recordConfigChange({
          fieldKey: 'engine_state',
          oldValue: null,
          newValue: action,
          source: 'user',
          actor: 'local_user',
          applied: true,
          atMs: this.now(),
        })
      } catch (e) {
        this.#record_error('audit_engine_action_failed', e.message)
      }
    }

    engine_state = this.scheduler.snapshot()
    return {
      action,
      applied: true,
      result,
      engine_state: engine_state.state,
      engine: engine_state,
      message: engine_message(action, engine_state),
    }
  }

  /**
   * 设置某渠道的自定义限额（**只能更保守**）。
   *
   * ⚠️⚠️ 红线 3 的关键路径：越权尝试**必须留痕**且带 `applied:false`
   *    + `rejectCode`。纠纷时要回答"用户是否主动调高过、系统是否拒绝过"——
   *    只记成功的变更永远答不上来。
   *    guard 的拒绝原因（`setOverride` 抛出的原文）**原样**返回给界面，
   *    因为那句话正是要让商家看到的："客户端只能调得更保守"。
   */
  async #set_limit(req) {
    if (!this.guard) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '安全护栏未接入（guard 未注入），无法设置限额。')
    }
    const body = await read_json_body(req)
    const source_type = String(body.source_type || '')
    const field = String(body.field || '')
    const allowed_fields = ['daily_max', 'min_interval_ms', 'content_similarity_max']
    if (!SOURCE_TYPES.includes(source_type)) {
      throw new AppError('REPORT_INVALID',
        `未知渠道：${body.source_type}（允许：${SOURCE_TYPES.join('/')}）`,
        { allowed: SOURCE_TYPES })
    }
    if (!allowed_fields.includes(field)) {
      throw new AppError('REPORT_INVALID',
        `未知限额字段：${body.field}（允许：${allowed_fields.join('/')}）`,
        { allowed: allowed_fields })
    }
    const value = Number(body.value)
    if (!Number.isFinite(value)) {
      throw new AppError('REPORT_INVALID', `限额值必须是数字，收到：${body.value}`)
    }

    const field_key = `limits.${source_type}.${field}`
    const policy_version = this.guard.policy ? this.guard.policy.policy_version : null
    const old_value = this.guard.overrides[`${source_type}.${field}`]

    let rejection = null
    try {
      this.guard.setOverride(source_type, field, value)
    } catch (e) {
      rejection = e
    }

    if (rejection) {
      // ⚠️ 拒绝原因原样保留（含"比服务端策略更激进"与"客户端只能调得更保守"）。
      const message = String(rejection.message || rejection)
      this.#write_config_change({
        field_key, old_value, new_value: value, applied: false,
        reject_code: 'POLICY_VIOLATION', policy_version, reason: message,
      })
      // ⚠️ 用 AppError 抛出会让"拒绝"看起来像"接口坏了"。这里明确区分：
      //    业务上被拒绝是**正常结果**，所以返回 200 + applied:false，
      //    同时把 reject_code 放在顶层便于前端与审计对齐。
      return {
        applied: false,
        reject_code: 'POLICY_VIOLATION',
        field_key,
        requested_value: value,
        server_value: this.#server_value(source_type, field),
        effective_value: this.#effective_value(source_type, field),
        message,
        hint: '客户端只能更保守：日上限只能调低，最小间隔只能调高，相似度上限只能调低。',
        audit_recorded: Boolean(this.audit),
      }
    }

    this.#write_config_change({
      field_key, old_value, new_value: value, applied: true,
      reject_code: null, policy_version, reason: '用户调低限额（更保守）',
    })

    // ⚠️ 生效值也留一条 `policy_applied`（红线 3 的核心条目：
    //    "实际生效的策略值"而不是"用户设置值"）。
    this.#write_policy_applied()

    return {
      applied: true,
      reject_code: null,
      field_key,
      requested_value: value,
      server_value: this.#server_value(source_type, field),
      effective_value: this.#effective_value(source_type, field),
      message: `${field_key} 已设为 ${this.#effective_value(source_type, field)}（更保守，已生效）`,
      limits: this.#limits_payload(),
      audit_recorded: Boolean(this.audit),
    }
  }

  #server_value(source_type, field) {
    if (!this.guard || !this.guard.policy) return null
    const l = this.guard.policy.limits && this.guard.policy.limits[source_type]
    if (!l) return null
    return l[field] === undefined ? null : Number(l[field])
  }

  #effective_value(source_type, field) {
    if (!this.guard) return null
    const l = this.guard.effectiveLimits(source_type)
    if (!l) return null
    return l[field] === undefined ? null : Number(l[field])
  }

  /**
   * 写一条 `config_change` 审计。
   *
   * ⚠️ 走 `audit.append()` 而不是 `audit.recordConfigChange()`：后者会自动
   *    补 `changeId` 并做 `CHANGE_SOURCES` 校验，而这里需要额外带上
   *    被拒绝的**原话**（`reason`），否则"系统为什么拒绝"在审计里会丢。
   *    字段名与 `recordConfigChange` 保持一致，便于同一套查询处理两者。
   * ⚠️ 审计写不进去**不能**让接口失败：护栏已经生效，
   *    报错会让商家以为设置没成功。但必须归因记录（AGENTS.md §2.8）。
   */
  #write_config_change({
    field_key, old_value, new_value, applied, reject_code, policy_version, reason,
  }) {
    if (!this.audit) return null
    try {
      return this.audit.append({
        kind: 'config_change',
        tsMs: this.now(),
        changeId: `ch-${crypto.randomBytes(8).toString('hex')}`,
        fieldKey: field_key,
        oldValue: old_value === undefined || old_value === null ? null : String(old_value),
        newValue: new_value === undefined || new_value === null ? null : String(new_value),
        source: 'user',
        actor: 'local_user',
        applied: applied === true,
        rejectCode: applied === true ? null : (reject_code || null),
        policyVersion: policy_version === undefined ? null : Number(policy_version),
        reason: reason || null,
      })
    } catch (e) {
      this.#record_error('audit_config_change_failed', e.message)
      return null
    }
  }

  /** 记一条"实际生效的策略"（红线 3 核心）。 */
  #write_policy_applied() {
    if (!this.audit || !this.guard || !this.guard.policy) return null
    const applied_limits = {}
    for (const src of SOURCE_TYPES) {
      const l = this.guard.effectiveLimits(src)
      if (!l) continue
      applied_limits[src] = {
        daily_max: Number(l.daily_max),
        min_interval_ms: Number(l.min_interval_ms),
        content_similarity_max: Number(l.content_similarity_max),
      }
    }
    applied_limits.active_hours = this.guard.policy.active_hours || null
    try {
      return this.audit.recordPolicyApplied({
        policyVersion: this.guard.policy.policy_version,
        policyHash: this.guard.policy.policy_hash || null,
        appliedLimits: applied_limits,
        accountTier: this.guard.policy.account_tier || null,
        atMs: this.now(),
        source: 'user',
      })
    } catch (e) {
      this.#record_error('audit_policy_applied_failed', e.message)
      return null
    }
  }

  // ── 规则（关键词 → 回复模板池）────────────────────────────

  /**
   * ⚠️ 规则存在 `runtime-state.json` 的 `rules` 键下，**经 store 单写者**。
   *    ⚠️ 关键词与文案是**本地数据**，绝不上报（红线 3：只上传哈希与计数）。
   *    上报侧用的是 `keyword_hash`，原文永远留在本机——这是刻意的隐私边界。
   */
  #read_rules() {
    const st = this.store.readJson('runtime-state.json', {})
    const rules = st.rules
    return Array.isArray(rules) ? rules : []
  }

  async #save_rules(req) {
    const body = await read_json_body(req)
    if (!Array.isArray(body.rules)) {
      throw new AppError('REPORT_INVALID', '规则保存需要 body.rules 数组')
    }
    if (body.rules.length > 200) {
      throw new AppError('REPORT_INVALID', '规则条数超过上限（200）', { count: body.rules.length })
    }

    const normalized = []
    for (let i = 0; i < body.rules.length; i++) {
      const r = body.rules[i]
      if (!r || typeof r !== 'object') {
        throw new AppError('REPORT_INVALID', `第 ${i + 1} 条规则不是对象`)
      }
      const source_type = String(r.source_type || 'comment')
      if (!SOURCE_TYPES.includes(source_type)) {
        throw new AppError('REPORT_INVALID', `第 ${i + 1} 条规则的渠道非法：${r.source_type}`)
      }
      const keywords = (Array.isArray(r.keywords) ? r.keywords : [])
        .map((k) => String(k).trim()).filter(Boolean)
      const templates = (Array.isArray(r.templates) ? r.templates : [])
        .map((t) => String(t).trim()).filter(Boolean)

      // ⚠️ 模板池**至少 5 条变体**（计划 §4.5）。这里用界面同一份判定函数
      //    （`client/safety/similarity.js` 的 templateVariantsOk），
      //    避免"界面放行、后端拒绝"或反过来。
      const variants = template_variants_ok(templates)
      if (!variants.ok) {
        throw new AppError('REPORT_INVALID',
          `第 ${i + 1} 条规则的模板池只有 ${variants.distinct} 条不同变体，`
          + `至少需要 ${variants.required} 条。`
          + '原因：相似度关卡会拒绝与近期已发内容过像的文案，变体太少会让这条规则几乎发不出去。',
          { index: i, distinct: variants.distinct, required: variants.required })
      }
      const rand = find_random_placeholder(templates)
      if (rand) {
        throw new AppError('REPORT_INVALID',
          `第 ${i + 1} 条规则里使用了 ${rand} 这类占位符。`
          + '请改用**语言变体**（例如"这个/这款/它"、"多少钱/什么价"）——'
          + '占位符生成的是同一条文案的机械替换，相似度关卡会全部拒绝，'
          + '而且平台侧看起来就是复读机。',
          { index: i, placeholder: rand })
      }
      if (keywords.length === 0) {
        throw new AppError('REPORT_INVALID', `第 ${i + 1} 条规则没有关键词`)
      }

      normalized.push({
        id: r.id ? String(r.id).slice(0, 64) : `rule-${crypto.randomBytes(6).toString('hex')}`,
        source_type,
        keywords: keywords.slice(0, 50).map((k) => k.slice(0, 100)),
        templates: templates.slice(0, 50).map((t) => t.slice(0, 500)),
        enabled: r.enabled !== false,
        updated_at_ms: this.now(),
      })
    }

    this.store.update('runtime-state.json', {}, (st) => {
      st.rules = normalized
      st.updatedAtMs = this.now()
      return st
    })

    return {
      rules: normalized,
      count: normalized.length,
      message: `已保存 ${normalized.length} 条规则（仅存本机，关键词语文案不会上报）。`,
    }
  }

  // ── 上报 ──────────────────────────────────────────────────

  #pending_count() {
    // ⚠️ 只认上报器：它与"待上报明细"是同一份数据的持有者。
    //    不去兜底读队列（那是另一种语义），也不回 0——
    //    回 0 会让界面显示"没有待上报"，而实际上报器可能根本没接上。
    if (this.license_reporter && typeof this.license_reporter.pendingCount === 'function') {
      return this.license_reporter.pendingCount()
    }
    throw new WorkbenchError('NOT_IMPLEMENTED',
      '上报器未接入（reporter 未注入），无法统计待上报条数。')
  }

  async #report_now() {
    if (!this.license_reporter) {
      throw new WorkbenchError('NOT_IMPLEMENTED',
        '上报器未接入（reporter 未注入），无法立即上报。')
    }
    const body_pending = this.#pending_count()
    const out = { pending_before: body_pending, sends: null, usage: null }

    // ⚠️ 上报结果如实返回。`reportSends` 在无明细时返回 null 且**不发请求**
    //    （契约 §9.1），这时界面应显示"无待上报明细"，而不是"上报成功 0 条"。
    const sends_result = await this.license_reporter.reportSends()
    out.sends = sends_result === null || sends_result === undefined
      ? { sent: false, reason: 'no_pending_sends', accepted: 0 }
      : {
        sent: true,
        accepted: Number(sends_result.accepted || 0),
        settlement: sends_result.settlement || null,
        error: sends_result.error || null,
        deferred: Boolean(sends_result.deferred),
        quarantined: Boolean(sends_result.quarantined),
        exhausted: Boolean(sends_result.exhausted),
      }

    // 聚合上报：把当前窗口封口后上报（窗口由调度器持有）。
    if (this.scheduler && typeof this.scheduler.closeWindowNow === 'function') {
      const win = this.scheduler.closeWindowNow()
      if (win && win.total > 0) {
        const r = await this.license_reporter.reportUsage(win.window)
        out.usage = { sent: true, window_start_ms: win.window.window_start_ms, response: r || null }
      } else {
        out.usage = { sent: false, reason: 'empty_window' }
      }
    } else {
      out.usage = { sent: false, reason: 'scheduler_not_available' }
    }

    out.pending_after = this.#pending_count()
    out.message = out.sends.sent
      ? `已上报 ${out.sends.accepted} 条明细（本机剩余待上报 ${out.pending_after} 条）`
      : '没有待上报的明细，未发起请求。'
    return out
  }

  // ── 登录 / 登出 ───────────────────────────────────────────

  /**
   * 登录。
   *
   * ⚠️⚠️ **密码的处置是本方法的核心**（红线 3 / config.js 的硬约束 2）：
   *    · 只在 `auth.login()` 的这一次调用里存在，随后立即置空局部变量；
   *    · **不写日志、不写审计、不写任何文件、不进错误消息**；
   *    · 出口再抹一遍（`scrub`），防止底层某个异常消息里恰好带了请求体。
   *    密码一旦落进实例目录，商家把目录打包发来排障就等于明文交出密码。
   */
  async #login(req) {
    if (!this.license_auth) {
      throw new WorkbenchError('NOT_IMPLEMENTED',
        '授权层未接入（auth 未注入），无法登录。急停按钮不受影响，仍然可用。')
    }
    let body = await read_json_body(req)
    const account = typeof body.account === 'string' ? body.account.trim() : ''
    let password = typeof body.password === 'string' ? body.password : ''
    // ⚠️ 读完就断开对请求体的引用：后面任何一处打印 `body` 都不会带出密码。
    body = null

    if (!account || !password) {
      password = ''
      throw new AppError('AUTH_INVALID_REQUEST', '请填写工作台账号与密码')
    }

    try {
      const result = await this.license_auth.login(account, password)
      if (this.audit) {
        try {
          this.audit.recordLogin({
            event: 'login', actor: 'local_user', ok: true,
            deviceIdHash: this.license_state ? this.license_state.deviceIdValue : null,
            atMs: this.now(),
          })
        } catch (e) {
          this.#record_error('audit_login_failed', e.message)
        }
      }
      return {
        logged_in: true,
        account_id: this.license_state ? this.license_state.accountId : null,
        // ⚠️ warnings 与 quota_notice 由授权层产生，**原样**返回
        //    （红线 1：服务端文案不得改写）。
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        quota_notice: result.quotaNotice || null,
        policy_version: result.policy ? result.policy.policy_version : null,
        account_tier: result.policy ? result.policy.account_tier : null,
        message: '登录成功。密码只在本次请求内使用，未写入磁盘。',
      }
    } catch (e) {
      if (this.audit) {
        try {
          this.audit.recordLogin({
            event: 'login', actor: 'local_user', ok: false,
            code: isKnownWorkbenchCode(e && e.code) ? e.code : (e && e.code) || null,
            atMs: this.now(),
          })
        } catch (inner) {
          this.#record_error('audit_login_failed', inner.message)
        }
      }
      // ⚠️ 出口抹一遍密码。这是**兜底**，主防线是"密码从不进入持久化字段"。
      const message = scrub((e && e.message) || '登录失败', password)
      const detail = e && e.detail ? scrub_object(e.detail, password) : null
      const raw_code = e && e.code
      const code = is_known_app_error_code(raw_code) ? raw_code : 'AUTH_INVALID_REQUEST'
      throw new AppError(code, message, detail)
    } finally {
      // ⚠️ 无论成败都清掉局部引用。
      password = ''
    }
  }

  async #logout() {
    if (!this.license_auth) {
      throw new WorkbenchError('NOT_IMPLEMENTED', '授权层未接入（auth 未注入），无法登出。')
    }
    const was_logged_in = Boolean(this.license_state && this.license_state.isLoggedIn)
    const result = await this.license_auth.logout('user_logout')
    if (this.scheduler) this.scheduler.stop('user_logout')
    if (this.audit) {
      try {
        this.audit.recordLogin({ event: 'logout', actor: 'local_user', ok: true, atMs: this.now() })
      } catch (e) {
        this.#record_error('audit_logout_failed', e.message)
      }
    }
    return {
      logged_in: false,
      was_logged_in,
      server: result || null,
      message: '已登出并停止引擎。本地审计与队列数据保留（它们是举证依据）。',
    }
  }

  // ── 依赖与错误 ────────────────────────────────────────────

  #license_redacted() {
    if (!this.license_state) return null
    const base = typeof this.license_state.redacted === 'function'
      ? this.license_state.redacted()
      : null
    if (!base) return null
    // ⚠️ 防御性再抹一遍：`redacted()` 是脱敏快照，但"凭据原文绝不出接口"
    //    这条约束太重要，值得在出口再断一次引用（白名单式重建，不 spread）。
    return {
      logged_in: Boolean(base.logged_in),
      account_id: base.account_id === undefined ? null : base.account_id,
      device_id: base.device_id === undefined ? null : base.device_id,
      install_id: base.install_id === undefined ? null : base.install_id,
      session_id: base.session_id === undefined ? null : base.session_id,
      token_expires_at_ms: Number(base.token_expires_at_ms || 0),
      clock_skew_ms: Number(base.clock_skew_ms || 0),
      policy_version: base.policy_version === undefined ? null : base.policy_version,
      policy_acked_version: base.policy_acked_version === undefined ? null : base.policy_acked_version,
      account_tier: base.account_tier === undefined ? null : base.account_tier,
      billing_state: base.billing_state === undefined ? null : base.billing_state,
      last_heartbeat_ms: Number(base.last_heartbeat_ms || 0),
      seq: base.seq && typeof base.seq === 'object' ? { ...base.seq } : {},
      // `key` 只是脱敏摘要（`redactKeyState()` 的产物，形如 ***abc123），
      // ⚠️ 断言：这里绝不能出现 `token` 或 `sign_key` 的原文键。
      key: base.key === undefined ? null : base.key,
      credential_invalid: this.license_auth && this.license_auth.credentialInvalid
        ? { code: this.license_auth.credentialInvalid.code, at_ms: this.license_auth.credentialInvalid.at_ms }
        : null,
    }
  }

  #last_error() {
    if (this.last_error) return this.last_error
    if (this.scheduler && this.scheduler.stats && this.scheduler.stats.lastError) {
      const e = this.scheduler.stats.lastError
      return { code: e.code || null, message: e.message || null, at_ms: Number(e.at_ms || 0), from: 'scheduler' }
    }
    return null
  }

  #missing_dependencies() {
    const out = []
    if (!this.guard) out.push('guard')
    if (!this.queue) out.push('queue')
    if (!this.scheduler) out.push('scheduler')
    if (!this.circuit) out.push('circuit')
    if (!this.audit) out.push('audit')
    if (!this.license_state) out.push('license_state')
    if (!this.license_auth) out.push('license_auth')
    if (!this.license_reporter) out.push('license_reporter')
    return out
  }

  #record_error(code, message) {
    this.last_error = {
      code: code || null,
      message: message || null,
      at_ms: this.now(),
      from: 'local_api',
    }
    this.#log('error', 'local_api_error', { code, message })
  }

  // ── 令牌 ──────────────────────────────────────────────────

  #persist_token() {
    try {
      // ⚠️ 经 store 写（唯一写者 + 原子写）。启动器从这里读令牌去拼
      //    `?token=`。令牌是**会话凭据**，不是长期密钥：进程重启即更换。
      this.store.writeAtomic(this.token_file, this.token + '\n')
      // 尽力收紧权限（Windows 上 chmod 语义有限，Unix 上有效）。
      try {
        fs.chmodSync(this.store.file(this.token_file), 0o600)
      } catch (e) {
        // ⚠️ 不吞异常：权限没收紧不该阻断启动，但必须留痕。
        this.#log('warn', 'ui_token_chmod_failed', { message: e.message })
      }
    } catch (e) {
      // ⚠️ 写不进令牌文件**不阻断**监听（页面还能用 query 里的令牌），
      //    但必须显式告警——否则启动器会拿不到令牌而打不开页面，
      //    而日志里什么都没有。
      this.#record_error('ui_token_write_failed',
        `令牌写入失败：${e.message}。启动器将无法自动带上令牌，请手工使用接口返回的 url。`)
    }
  }

  // ── 发送 ──────────────────────────────────────────────────

  #send(res, status, body, cors) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8')
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // ⚠️ 本地控制台不需要被 iframe 嵌入；禁掉可省掉一整类点击劫持面。
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(cors || {}),
    }
    if (status >= 400 && body && body.ok === false) {
      this.#log('warn', 'local_api_error_response', { status, code: body.code })
    }
    return this.#send_raw(res, status, headers, buf)
  }

  #send_raw(res, status, headers, buf) {
    if (res.writableEnded || res.destroyed) return undefined
    try {
      res.writeHead(status, headers)
      if (buf === null || buf === undefined) res.end()
      else res.end(buf)
    } catch (e) {
      // ⚠️ 不吞异常：写响应失败通常意味着客户端提前断开，属预期内，
      //    但必须归因（否则"偶发 500"永远查不出来）。
      this.#record_error('response_write_failed', e.message)
    }
    return undefined
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }
}

// ═══════════════════════════════════════════════════════════
// 模块级工具
// ═══════════════════════════════════════════════════════════

/** 生成 32 字节 hex 会话令牌。 */
function generate_token() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex')
}

/** 监听地址回读后的归一化（`::ffff:127.0.0.1` 这类形态要认）。 */
function normalize_bound_host(host) {
  const h = String(host || '').toLowerCase()
  if (h.startsWith('::ffff:')) return h.slice('::ffff:'.length)
  return h
}

function is_ipv6_literal(host) {
  return typeof host === 'string' && host.includes(':') && host !== 'localhost'
}

/** 引擎动作的面向商家说明。 */
function engine_message(action, snapshot) {
  const state = snapshot && snapshot.state ? snapshot.state : 'unknown'
  if (action === 'start') {
    return state === 'running'
      ? '引擎已启动。能否真正发出取决于护栏（观察期/日上限/活跃时段/熔断/急停）。'
      : `引擎启动请求已提交，当前状态：${state}`
  }
  if (action === 'stop') return '引擎已停止。队列与审计数据保留，重启后可继续。'
  if (action === 'pause') {
    const until = snapshot && snapshot.paused_until_ms
    return until ? `已暂缓至 ${new Date(until).toLocaleString('zh-CN')}` : '已暂缓'
  }
  return '已恢复。仍需护栏放行才会发送。'
}

/** 是否已在 `shared/lib/errors.js` 登记（用于把未知码归一到 AUTH_INVALID_REQUEST）。 */
function is_known_app_error_code(code) {
  try {
    // eslint-disable-next-line global-require
    const { isKnownErrorCode } = require('../../shared/lib/errors')
    return isKnownErrorCode(code)
  } catch (e) {
    // ⚠️ 不吞异常：登记表读不到时保守返回 false（归一到通用码），并留痕。
    if (typeof is_known_app_error_code.on_failure === 'function') {
      is_known_app_error_code.on_failure(e)
    }
    return false
  }
}
is_known_app_error_code.on_failure = null

/**
 * 模板池变体数校验。⚠️ 转发 `client/safety/similarity.js` 的实现，
 * **不在这里重写一份**——两份判定迟早漂移，而漂移的表现是
 * "界面放行、后端拒绝"或更糟的反向。
 */
function template_variants_ok(texts, opts) {
  // eslint-disable-next-line global-require
  const { templateVariantsOk } = require('../safety/similarity')
  return templateVariantsOk(texts, opts)
}

/** 找出 `{随机1-9}` / `{随机词}` 这类占位符（计划明确禁止的写法）。 */
function find_random_placeholder(texts) {
  for (const t of texts || []) {
    const m = /\{\s*随机[^}]*\}/.exec(String(t))
    if (m) return m[0]
  }
  return null
}

/**
 * 在任意嵌套结构里找出"看起来像密码"的键（**测试用**，不参与生产逻辑）。
 *
 * ⚠️ 它存在的理由是：密码泄漏的形式往往是"藏在某个 detail 里"，
 *    而不是顶层一个 `password` 字段。测试需要能对整份 JSON 做
 *    递归断言（"实例目录里任何一层的 password 都必须为空"）。
 */
function find_nested_password(node, depth = 0, hits = []) {
  if (node === null || node === undefined || depth > 8) return hits
  if (typeof node !== 'object') return hits
  if (Array.isArray(node)) {
    for (const v of node) find_nested_password(v, depth + 1, hits)
    return hits
  }
  for (const [k, v] of Object.entries(node)) {
    if (/password|passwd|pwd/i.test(k)) hits.push(k)
    find_nested_password(v, depth + 1, hits)
  }
  return hits
}

/** 工厂：便于 `main.js` 一行接入。 */
function create_local_api(opts) {
  return new LocalControlApi(opts)
}

module.exports = {
  LocalControlApi,
  create_local_api,
  // 纯函数（测试直接断言）
  is_loopback_hostname,
  parse_authority,
  check_host_header,
  check_origin,
  token_matches,
  extract_token,
  read_json_body,
  derive_alerts,
  generate_token,
  find_random_placeholder,
  find_nested_password,
  scrub,
  // 常量
  TOKEN_FILE,
  TOKEN_BYTES,
  MAX_BODY_BYTES,
  POLL_INTERVAL_MS,
  QUEUE_BACKLOG_RATIO,
  STATIC_ASSETS,
  LIMITS,
  LOCAL_STATUS,
  UI_DIR,
  // 内部工具的可见性（供测试断言/排障，非业务 API）
  is_known_app_error_code,
  engine_message,
  normalize_bound_host,
}
