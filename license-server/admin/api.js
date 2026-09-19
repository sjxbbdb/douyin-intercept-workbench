'use strict'

// license-server/admin/api.js
//
// 厂商（甲方）管理后台 —— HTTP API + 静态资源宿主。
//
// ═══════════════════════════════════════════════════════════
// 为什么需要这个文件（需求 #4）
// ═══════════════════════════════════════════════════════════
// `license-server/cli.js` 已经能把运维动作做完（开号、发额度、改策略、导出审计），
// 但它回答不了"**看**"这件事：厂商想知道"现在有多少商家、今天拦了多少、回了多少、
// 谁的余额快见底、谁的心跳停了"，只能一条条敲命令。
//
// `docs/部署指南-服务端.md` §7 早就把 `http://127.0.0.1:18080/admin-<随机串>/`
// 写成了厂商后台入口，§9.3 还专门规定了它的暴露面策略——
// **但此前没有任何实现**。本文件就是那个入口。
//
// ═══════════════════════════════════════════════════════════
// ⚠️⚠️ 这是全项目最高危的暴露面。以下每一条删掉都会立刻变成事故。
// ═══════════════════════════════════════════════════════════
//
//   1. **`ADMIN_PATH` 未配置 = 后台彻底不存在**。
//      没有默认路径，没有 `/admin` 兜底。`server.js` 在 `config.adminPath === null`
//      时**根本不注册任何后台路由**，于是 `/admin` 返回的是普通 404——
//      和"这个服务上没有这个路径"完全无法区分。
//      删掉它 → 每个部署都自带一个公网可扫的固定入口。
//
//   2. **IP 白名单空列表 = 只允许回环**（`config.parseIpAllow`）。
//      方向必须是"默认拒绝"。删掉它 → 运维漏配一项，后台就对全网开放。
//      ⚠️ 取真实 IP 依赖 `TRUST_PROXY`：反代后为真、直连必须为假。
//      直连却设成真 → 攻击者自己加一个 `X-Forwarded-For: 127.0.0.1` 就进来了。
//
//   3. **会话令牌只存 sha256，且只走 HttpOnly + SameSite=Strict 的 cookie**。
//      绝不回显在 JSON 里、绝不写进 URL、绝不记进日志。
//      删掉它 → 一个 XSS 或一次 `JSON.stringify` 就把后台会话送出去了。
//
//   4. **状态变更的 POST 必须过 CSRF 三连**：
//      `SameSite=Strict` cookie + `Origin`/`Referer` 必须存在且与本机同源
//      + 请求体必须是 `application/json`。
//      ⚠️ 只靠 SameSite 不够：浏览器对 SameSite 的实现历史上出现过差异，
//      而且"缺 Origin 头"的请求（部分客户端/老浏览器）会被 SameSite 放行。
//      删掉它 → 厂商在浏览器里打开任意网页，那个网页就能 POST 本后台改余额、停商家。
//
//   5. **登录限流 + 锁定 + 时序对齐**。后台管理员是**厂商自己的**账号，
//      被撞开等于整个授权中心失守（能改余额、能停服、能导出全部审计）。
//      ⚠️ 管理员不存在时也要做一次等价代价的 scrypt 比对，否则响应时间
//      会泄露"这个用户名存在"——和 `api/routes-auth.js` 同一立场。
//
//   6. **静态资源用显式文件名白名单**。任何含 `..` / `/` / `\` 的路径直接拒绝，
//      不拼接、不规范化后拼盘。删掉它 → `GET /admin-x/../server.js` 就能读源码。
//
// ═══════════════════════════════════════════════════════════
// ⚠️ 另外三条"容易写错但不会立刻报错"的
// ═══════════════════════════════════════════════════════════
//
//   A. **看板数字一律来自 `shared/lib/stats.js`**，本文件不做任何百分比换算。
//      厂商看板与商家看板必须对"成功率"给出同一个答案；两份实现迟早漂移，
//      而漂移的表现就是纠纷。分母为 0 时 `buildDashboard` 给 `null`，
//      界面显示 `—`——**不是 100%**。
//
//   B. **取证（`/api/forensics/:account`）的"实际生效上限"只从
//      `policy_ack_log.applied_limits_json` 读**，不从当前策略倒推。
//      这是红线 3 的全部意义：纠纷时要能回答"当时实际生效的是什么"，
//      而当前策略只能说明"现在是什么"。两者不一致时本文件**两个都给**。
//
//   C. **发送明细只投影哈希与判定**（`SEND_DETAIL_FIELDS`）。
//      绝不 `SELECT *`，绝不过滤 `sec_uid`/原文——根本不把它们放进响应对象。
//      靠"事后删字段"迟早漏一个，靠"根本不取"才不会漏。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { Router, readJsonBody, sendJson } = require('../api/router')
const { hashPassword, verifyPassword } = require('../crypto/password')
const { grantCredits, reconcile: reconcileLedger } = require('../domain/billing')
const {
  buildEffectivePolicy, deriveDayIndex, tierForDayIndex, minPlanCredit, MS_PER_DAY, TZ_OFFSET_MINUTES,
} = require('../domain/policy')
const {
  aggregateSends, aggregateReports, buildDashboard, buildTrend, dayKey, dayStartMs,
  // ⚠️ 两个 reconcile 是**不同**的东西，必须别名区分：
  //    · domain/billing.reconcile  → 明细 ↔ 台账（钱）对账
  //    · shared/lib/stats.reconcile → 明细 ↔ 聚合上报（口径）对账
  reconcile: reconcileAggregates,
} = require('../../shared/lib/stats')
const { SOURCE_TYPES, VERDICTS, FAILURE_REASONS } = require('../../shared/lib/protocol')

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 静态资源目录（相对本文件解析，**不写死绝对路径**）。 */
const WEB_DIR = path.join(__dirname, 'web')

/**
 * 静态资源白名单。⚠️ 文件名写死，路径不由请求拼接。
 * 请求路径先做形态检查（见 assertSafeAssetPath），再查这张表。
 */
const STATIC_ASSETS = Object.freeze({
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
})

/** 会话 cookie 名。⚠️ 带后台路径指纹，避免与同域其它服务重名。 */
const COOKIE_NAME = 'dy_admin_session'

/** 登录失败锁定：环境变量优先（部署指南 §3.1 的键名），否则用 config 的同义项。 */
const LOCK_TIMES = readPositiveIntEnv('LOGIN_FAIL_LOCK_TIMES', null)
const LOCK_MINUTES = readPositiveIntEnv('LOGIN_FAIL_LOCK_MINUTES', null)

/** 登录失败时**恒定**的等待：抹平"账号不存在"与"密码错"的响应时间差。 */
const LOGIN_FAIL_DELAY_MS = 250

/**
 * 登录接口每 IP 每分钟上限，来自 `RATE_LIMIT_LOGIN_PER_MIN`（部署指南 §3.1）。
 *
 * ⚠️ 默认 10 与文档一致。这一层是**每 IP 的粗粒度减速带**，
 *    与按账号的 `LOGIN_FAIL_LOCK_TIMES` / `_MINUTES` 锁定**独立计**
 *    （部署指南 §9.4 明确要求两层分开）：撞一个账号会被锁，撞多个账号会被限流。
 */
const IP_RATE_PER_MINUTE_DEFAULT = 10

/** 心跳陈旧阈值：超过它即认为"离线"，列表里标出来。 */
const HEARTBEAT_STALE_MS = 10 * 60 * 1000

/**
 * 低余额告警阈值（"还剩多少条可发"），对应部署指南 §3.1 的
 * `MIN_BALANCE_ALERT_REPLIES`（默认 500，已在 `config.js` 里登记）。
 *
 * ⚠️ 阈值最终以"积分"形式回给前端（`balance_alert_threshold_milli`），
 *    界面不自己算，也不硬编码任何数值。
 */
const MIN_BALANCE_ALERT_REPLIES_DEFAULT = 500

/**
 * 取低余额阈值（条数）。缺配置时退回文档默认值，**不退回 0**——
 * 退回 0 会让所有账号都不告警，那正是这条告警最该生效的时候。
 */
function minBalanceAlertReplies(config) {
  const fromCfg = config ? config.minBalanceAlertReplies : undefined
  const n = Number(fromCfg)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : MIN_BALANCE_ALERT_REPLIES_DEFAULT
}

/** 各种 limit 参数的默认值与上限（防止 `?limit=99999999` 把内存打爆）。 */
const LIMITS = Object.freeze({
  merchants: 50,
  merchants_max: 500,
  sends: 100,
  sends_max: 500,
  ledger: 50,
  ledger_max: 500,
  config_changes: 100,
  config_changes_max: 500,
  sessions: 100,
  admin_actions: 50,
  admin_actions_max: 300,
  trend_days: 7,
  trend_days_max: 90,
})

/** 过期会话清理周期。 */
const SESSION_SWEEP_MS = 3600000

/**
 * ⚠️ 发送明细的**投影白名单**。
 *
 * 这是隐私边界（红线 3 / protocol.md §7.5）在代码层面的落点：
 * 后台**只**返回哈希、判定、时间、端点、状态码与失败原因。
 * 评论原文、回复原文、`sec_uid`、`user_key_type` 之外的任何身份字段
 * 都不在列表里——因为它们**根本没有进入取值语句**。
 *
 * ⚠️ 不要"先 SELECT * 再删字段"。那种写法在加了一列之后会静默泄漏，
 *    而这里加了列也不会自动出现在响应里。
 */
const SEND_DETAIL_FIELDS = Object.freeze([
  'send_id', 'source_type', 'verdict', 'confirm_signal',
  'target_hash', 'user_key_hash', 'user_key_type', 'content_hash',
  'platform_endpoint', 'platform_status_code', 'failure_reason',
  'billing_status', 'charged_milli',
  'applied_policy_version', 'sent_at_ms', 'received_at_ms',
  'client_version', 'device_id', 'instance_id', 'report_id', 'over_limit',
])

/**
 * ⚠️ 隐私字段黑名单（最后一道自检）。
 *
 * 即便有人日后往 `SEND_DETAIL_FIELDS` 里加了 `sec_uid`，`projectSend` 也会
 * 在序列化前把它剥掉并记一条审计告警。**"根本不取"是主防线，这条是兜底**——
 * 两个都要有，因为主防线依赖写代码的人记得住。
 */
const FORBIDDEN_RESPONSE_KEYS = Object.freeze([
  'sec_uid', 'uid', 'uid_short', 'comment_text', 'reply_text', 'danmaku_text',
  'nickname', 'nick', 'phone', 'mobile', 'avatar_url', 'conversation_id',
  'room_id', 'video_id', 'comment_id', 'content', 'text', 'token',
  'sign_key', 'sign_key_plain', 'pass_hash', 'password', 'code_hash',
])

/** 后台自己的错误码 → HTTP 状态。⚠️ 刻意**不**用契约的 `AUTH_*` 码表。 */
const ADMIN_STATUS = Object.freeze({
  ADMIN_DISABLED: 404,
  ADMIN_BAD_REQUEST: 400,
  ADMIN_METHOD_NOT_ALLOWED: 405,
  ADMIN_NOT_FOUND: 404,
  ADMIN_TOKEN_MISSING: 401,
  ADMIN_SESSION_INVALID: 401,
  ADMIN_LOGIN_FAILED: 401,
  ADMIN_LOCKED: 423,
  ADMIN_IP_DENIED: 403,
  ADMIN_CSRF_REJECTED: 403,
  ADMIN_ACCOUNT_INVALID: 400,
  ADMIN_FORBIDDEN: 403,
  NOT_IMPLEMENTED: 501,
  SERVER_INTERNAL: 500,
})

/** 数值型策略字段的保守方向。`dir: 1` 表示"变大即放宽"。 */
const LIMIT_FIELD_DIRECTION = Object.freeze({
  daily_max: 1,
  content_similarity_max: 1,
  min_interval_ms: -1,
})

/** 配置变更的字段 → 中文名（仅展示，不参与任何计算）。 */
const FIELD_LABELS = Object.freeze({
  'limits.comment.daily_max': '评论日上限',
  'limits.live_danmaku.daily_max': '弹幕日上限',
  'limits.dm.daily_max': '私信日上限',
  'limits.comment.min_interval_ms': '评论最小间隔',
  'limits.live_danmaku.min_interval_ms': '弹幕最小间隔',
  'limits.dm.min_interval_ms': '私信最小间隔',
  'limits.comment.content_similarity_max': '评论相似度上限',
  'limits.live_danmaku.content_similarity_max': '弹幕相似度上限',
  'limits.dm.content_similarity_max': '私信相似度上限',
})

// ═══════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.trunc(n)
}

/** 结构化后台错误。⚠️ 不继承 AppError——后台的码不进契约表。 */
class AdminError extends Error {
  constructor(code, message, detail) {
    super(message || code)
    this.name = 'AdminError'
    this.code = code
    this.status = ADMIN_STATUS[code] || 500
    this.detail = detail === undefined ? null : detail
  }
}

/**
 * 同步阻塞指定的毫秒数。
 *
 * ⚠️ 为什么需要它、以及为什么不用 `setTimeout` + await：
 *    登录失败的响应必须**恒定慢一点**（`LOGIN_FAIL_DELAY_MS`），
 *    否则"管理员不存在"会比"密码错"快一个 scrypt 的量级——
 *    而那条时间差就是用户名枚举信道。
 *    `setTimeout` 的时长不保证（事件循环里可被其它 await 抢跑），
 *    这里要的是"这一次响应就是慢这么多"，所以用 `Atomics.wait` 真阻塞。
 * ⚠️ 只在**失败**路径上调用。成功路径加延迟等于让正常登录白等。
 */
function sleepSync(ms) {
  const n = Math.max(0, Math.trunc(Number(ms) || 0))
  if (n === 0) return
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, n)
}

function bad(message, detail) { return new AdminError('ADMIN_BAD_REQUEST', message, detail) }

/** 递归把 BigInt 转 Number、undefined 转 null。⚠️ 只用于我们自己构造的普通对象。 */
function jsonSafe(v) {
  if (typeof v === 'bigint') {
    const n = Number(v)
    // ⚠️ 超出安全整数范围不静默截断：那会让"余额 9007199254740993"变成错的数。
    return Number.isSafeInteger(n) ? n : v.toString()
  }
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val)
    return out
  }
  return v === undefined ? null : v
}

function num(v) { return v === null || v === undefined ? 0 : Number(v) }
function numOrNull(v) { return v === null || v === undefined ? null : Number(v) }

/**
 * 毫单位 → 积分**显示串**（`12600.5`）。
 *
 * ⚠️ 为什么这个换算在服务端做而不是前端：`client/ui/app.js` 的零算术约束
 *    （`scripts/ui-check.js` 会扫描 `* 100` / `/ 1000`）对厂商面板同样成立。
 *    任何单位换算只允许有一份实现，且必须在服务端。
 */
function milliToCreditsText(milli) {
  const n = Math.trunc(Number(milli) || 0)
  const int = Math.trunc(n / 1000)
  const frac = Math.abs(n % 1000)
  return frac === 0 ? String(int) : `${int}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`
}

/** 一积分等于多少毫单位。⚠️ 从 tier/单价体系里唯一的 1000 出发，不散落字面量。 */
function creditsToMilli(credits) { return Math.trunc(Number(credits) * 1000) }

/**
 * 把某个计数值折算成"进度条宽度百分比"（0~100 的整数）。
 *
 * ⚠️ 为什么这个换算在服务端而不是前端：
 *    厂商面板与商家面板受**同一条**约束——前端零算术
 *    （`scripts/ui-check.js` 会扫描 `* 100` / `/ 1000`）。
 *    任何百分比只允许有一份实现，且必须在服务端。
 * ⚠️ 分母为 0 或非法时返回 `null`，界面画"无刻度"而不是 0%——
 *    0% 与"没有可比的基准"是两件不同的事。
 */
function pctOf(value, total) {
  const v = Number(value)
  const t = Number(total)
  if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null
  return Math.round((v / t) * 100)
}

/** 给趋势桶补上"相对窗口内最大值"的条宽（同样是服务端算，前端只画）。 */
function withBarPcts(buckets) {
  let peak = 0
  for (const b of buckets) {
    peak = Math.max(peak, Number(b.sent_confirmed) || 0, Number(b.failed) || 0,
      Number(b.sent_confirmed_dom) || 0, Number(b.sent_suspected) || 0)
  }
  return buckets.map((b) => ({
    ...b,
    // 条宽基准 = 窗口内单日最大条数（不是"日上限"——日上限会随等级变，
    // 用它当基准会让观察期的柱子永远是 0 高度，看不出趋势）
    bar_peak: peak,
    sent_confirmed_pct: pctOf(b.sent_confirmed, peak),
    failed_pct: pctOf(b.failed, peak),
    sent_confirmed_dom_pct: pctOf(b.sent_confirmed_dom, peak),
    sent_suspected_pct: pctOf(b.sent_suspected, peak),
  }))
}

/** HTML/JSON 都不需要额外转义（走 JSON），但路径与日志里要挡住控制字符。 */
function printable(s, max) {
  const v = String(s === null || s === undefined ? '' : s)
  const cut = v.length > max ? v.slice(0, max) + '…' : v
  // eslint-disable-next-line no-control-regex
  return cut.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

/** 解析 `YYYY-MM-DD` 为"该自然日（UTC+8）的起点毫秒"。 */
function parseDayArg(raw, name) {
  const s = String(raw)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw bad(`参数 ${name} 必须是 YYYY-MM-DD 格式，实际为 ${printable(s, 40)}`)
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const utcMidnight = Date.UTC(y, mo - 1, d)
  const check = new Date(utcMidnight)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw bad(`参数 ${name} 不是合法日期：${s}`)
  }
  return dayStartMs(utcMidnight)
}

/** 取整型查询参数。非法值**报错**而不是静默退回默认（静默会让界面悄悄看错窗口）。 */
function intQuery(query, name, { fallback, min, max }) {
  const raw = query[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw bad(`参数 ${name} 必须是整数，实际为 ${printable(raw, 40)}`)
  }
  let n = Number(raw)
  if (min !== undefined && n < min) n = min
  if (max !== undefined && n > max) n = max
  return n
}

/** 解析一个时间窗口（`from`/`to` 为 `YYYY-MM-DD`），默认"最近 N 天含今天"。 */
function windowOf(query, nowMs, { defaultDays = LIMITS.trend_days } = {}) {
  const hasFrom = query.from !== undefined && query.from !== ''
  const hasTo = query.to !== undefined && query.to !== ''
  if (!hasFrom && !hasTo) {
    const days = intQuery(query, 'days', { fallback: defaultDays, min: 1, max: LIMITS.trend_days_max })
    const toMs = dayStartMs(nowMs) + MS_PER_DAY // 含今天
    return { fromMs: toMs - days * MS_PER_DAY, toMs, days }
  }
  const fromMs = hasFrom ? parseDayArg(query.from, 'from') : dayStartMs(nowMs) - defaultDays * MS_PER_DAY
  const toMs = hasTo ? parseDayArg(query.to, 'to') + MS_PER_DAY : dayStartMs(nowMs) + MS_PER_DAY
  if (toMs <= fromMs) throw bad('参数 to 必须不早于 from')
  const days = Math.round((toMs - fromMs) / MS_PER_DAY)
  if (days > LIMITS.trend_days_max) {
    throw bad(`时间跨度最多 ${LIMITS.trend_days_max} 天，实际 ${days} 天`)
  }
  return { fromMs, toMs, days }
}

/** 把 GET 的 query string 解析成对象（与 server.js 的 queryOf 同形）。 */
function queryOf(ctx) {
  return Object.fromEntries(new URL(ctx.rawUrl, 'http://x').searchParams)
}

// ═══════════════════════════════════════════════════════════
// IP 白名单
// ═══════════════════════════════════════════════════════════

/** IPv4 点分 → 0..2^32-1 的整数。非法返回 null。 */
function ipv4ToInt(s) {
  const parts = String(s).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** IPv6 → 16 字节 Buffer。非法返回 null。支持 `::` 缩写与内嵌 IPv4。 */
function ipv6ToBuffer(s) {
  let str = String(s)
  if (str.includes('%')) str = str.slice(0, str.indexOf('%')) // 去 zone id
  if (str === '') return null

  // 内嵌 IPv4（`::ffff:127.0.0.1`）→ 换成两段十六进制
  const lastColon = str.lastIndexOf(':')
  if (lastColon >= 0 && str.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(str.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = (v4 >>> 16) & 0xffff
    const lo = v4 & 0xffff
    str = `${str.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }

  const dbl = str.indexOf('::')
  if (dbl !== str.lastIndexOf('::')) return null

  let head; let tail
  if (dbl >= 0) {
    head = str.slice(0, dbl)
    tail = str.slice(dbl + 2)
  } else {
    head = str
    tail = ''
  }
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === '' ? [] : tail.split(':')
  const total = headParts.length + tailParts.length
  if (total > 8) return null
  if (dbl < 0 && total !== 8) return null

  const groups = []
  for (const p of headParts) groups.push(p)
  for (let i = total; i < 8; i++) groups.push('0')
  for (const p of tailParts) groups.push(p)

  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i]
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    buf.writeUInt16BE(parseInt(g, 16), i * 2)
  }
  return buf
}

/** 是否为回环地址（IPv4 / IPv6 / IPv4-mapped 都算）。 */
function isLoopbackAddr(ip) {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) return (v4 >>> 24) === 127
  const buf = ipv6ToBuffer(ip)
  if (!buf) return false
  // ::1
  if (buf.equals(Buffer.from('00000000000000000000000000000001', 'hex'))) return true
  // ::ffff:127.0.0.0/104
  const mapped = buf.slice(0, 10).equals(Buffer.alloc(10)) &&
    buf.readUInt16BE(10) === 0xffff
  if (mapped && (buf[12] >>> 0) === 127) return true
  return false
}

/** 单条白名单条目是否匹配某个 IP。 */
function ipEntryMatches(entry, rawIp) {
  const s = String(entry)
  // ⚠️ 先把来源 IP 归一化：`::ffff:127.0.0.1` → `127.0.0.1`。
  //    不做这一步，`127.0.0.1/32` 与映射形态的来源就匹配不上——
  //    而反代常把 IPv4 报成映射形态，表现为"白名单明明配了却进不去"。
  const ip = normalizeIp(rawIp)
  const slash = s.indexOf('/')
  const addr = slash < 0 ? s : s.slice(0, slash)
  const prefix = slash < 0 ? null : Number(s.slice(slash + 1))

  const a4 = ipv4ToInt(addr)
  const b4 = ipv4ToInt(ip)
  if (a4 !== null && b4 !== null) {
    const bits = prefix === null ? 32 : prefix
    if (bits > 32) return false
    if (bits === 0) return true
    const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0)
    return ((a4 & mask) >>> 0) === ((b4 & mask) >>> 0)
  }

  const a6 = ipv6ToBuffer(addr)
  const b6 = ipv6ToBuffer(ip)
  if (!a6 || !b6) return false

  const bits = prefix === null ? 128 : prefix
  if (bits > 128) return false
  for (let i = 0; i < bits; i++) {
    const byteIdx = i >> 3
    const bitIdx = 7 - (i & 7)
    if (((a6[byteIdx] >> bitIdx) & 1) !== ((b6[byteIdx] >> bitIdx) & 1)) return false
  }
  return true
}

/**
 * 取请求的真实来源 IP。
 *
 * ⚠️ `TRUST_PROXY` 的方向不能弄反：
 *   · 反代后必须为真，否则每个请求都来自 127.0.0.1（白名单形同虚设）
 *   · 直连必须为假，否则攻击者伪造 `X-Forwarded-For` 就能进白名单
 */
function clientIpOf(req, config) {
  const socketIp = (req.socket && req.socket.remoteAddress) || ''
  if (!config || !config.trustProxy) return normalizeIp(socketIp)
  const xri = req.headers['x-real-ip']
  if (xri && String(xri).trim()) return normalizeIp(String(xri).trim())
  const xff = req.headers['x-forwarded-for']
  if (xff) {
    const first = String(xff).split(',')[0].trim()
    if (first) return normalizeIp(first)
  }
  return normalizeIp(socketIp)
}

/** `::ffff:127.0.0.1` → `127.0.0.1`；其余原样（去掉 IPv6 方括号）。 */
function normalizeIp(ip) {
  let s = String(ip || '')
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const buf = ipv6ToBuffer(s)
  if (buf && buf.slice(0, 10).equals(Buffer.alloc(10)) && buf.readUInt16BE(10) === 0xffff) {
    return `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`
  }
  return s
}

/** 来源 IP 是否在白名单内。⚠️ 名单为空**不会**走到这里（config 已补回环）。 */
function ipAllowed(allowList, ip) {
  const list = Array.isArray(allowList) && allowList.length ? allowList : ['127.0.0.1/32', '::1/128']
  for (const entry of list) {
    if (ipEntryMatches(entry, ip)) return true
    // 明文写 `127.0.0.1` 时也要能匹配 `::ffff:127.0.0.1` 形态的来源
    if (!String(entry).includes('/') && !String(entry).includes(':')) {
      if (normalizeIp(entry) === ip) return true
    }
  }
  // 白名单里只写了 IPv4 回环时，IPv6 回环仍应视为本机
  if (list.some((e) => String(e).startsWith('127.')) && isLoopbackAddr(ip)) return true
  return false
}

// ═══════════════════════════════════════════════════════════
// CSRF
// ═══════════════════════════════════════════════════════════

/** 取 `Origin`（优先）或 `Referer` 的 authority。 */
function requestOriginOf(req) {
  const origin = req.headers.origin
  if (origin && String(origin).trim()) return String(origin).trim()
  const referer = req.headers.referer
  if (referer && String(referer).trim()) {
    try {
      const u = new URL(String(referer).trim())
      return `${u.protocol}//${u.host}`
    } catch (e) {
      // Origin/Referer 解析失败必须报错而不是放行：放行等于关掉这道门
      throw new AdminError('ADMIN_CSRF_REJECTED', 'Referer 无法解析，已拒绝该请求')
    }
  }
  return null
}

/** 本机 Host（含端口），用于同源比对。 */
function hostOf(req) {
  const h = req.headers.host
  return h && String(h).trim() ? String(h).trim() : null
}

/**
 * 状态变更请求的 CSRF 校验。
 *
 * ⚠️ 三条**同时**要求，缺一条就等于没有这道门：
 *   ① `Origin` 或 `Referer` **必须存在**
 *   ② 它的 host 必须等于本请求的 `Host`（同源）
 *   ③ `Content-Type` 必须是 `application/json`
 *      —— 这条挡的是 HTML 表单：表单只能发三种简单 Content-Type，
 *      而简单请求**不触发预检**，浏览器会把请求真的发出去。
 */
function assertCsrfOk(req, isLogin) {
  const origin = requestOriginOf(req)
  if (!origin) {
    throw new AdminError('ADMIN_CSRF_REJECTED',
      '缺少 Origin/Referer，已拒绝该状态变更请求（无法证明它与后台同源）')
  }
  if (origin === 'null') {
    throw new AdminError('ADMIN_CSRF_REJECTED', 'Origin 为 null（沙箱 iframe 或 data: 页面），已拒绝')
  }
  let host
  try {
    host = new URL(origin).host
  } catch (e) {
    throw new AdminError('ADMIN_CSRF_REJECTED', 'Origin 无法解析，已拒绝该请求')
  }
  const selfHost = hostOf(req)
  if (!selfHost) throw new AdminError('ADMIN_CSRF_REJECTED', '缺少 Host 头，已拒绝该请求')
  if (host.toLowerCase() !== selfHost.toLowerCase()) {
    throw new AdminError('ADMIN_CSRF_REJECTED', '请求来源与后台不同源，已拒绝', {
      origin_host: printable(host, 120), expected_host: printable(selfHost, 120),
    })
  }

  const ctype = String(req.headers['content-type'] || '').toLowerCase()
  if (!ctype.startsWith('application/json')) {
    throw new AdminError('ADMIN_CSRF_REJECTED',
      '状态变更请求必须是 Content-Type: application/json（表单提交不触发预检，必须拒绝）',
      { received: printable(ctype, 80) })
  }

  // ⚠️ 登录接口也要过 CSRF：否则攻击者可以拿厂商的浏览器当跳板去撞密码。
  //    这里没有"免检"分支——`isLogin` 只用于错误文案。
  void isLogin
  return true
}

// ═══════════════════════════════════════════════════════════
// 会话
// ═══════════════════════════════════════════════════════════

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex') }

/** 生成 32 字节会话令牌（hex）。⚠️ 只在响应头出现一次，绝不进 JSON。 */
function newSessionToken() { return crypto.randomBytes(32).toString('hex') }

/** 解析 Cookie 头（只取需要的那个名字，不整表解析）。 */
function cookieValue(req, name) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * `Set-Cookie` 的拼装。
 *
 * ⚠️ 四个属性都不能少：
 *   · `HttpOnly` —— JS 读不到，XSS 拿不走
 *   · `SameSite=Strict` —— 跨站请求根本不带这个 cookie
 *   · `Path=<adminPath>` —— 只在后台路径下发送，减少暴露面
 *   · `Secure` —— 默认开启；仅"纯 HTTP 的 SSH 隧道"场景由运维显式关闭
 */
function buildSessionCookie(config, token, maxAgeSec) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    `Path=${config.adminPath}`,
    'HttpOnly',
    'SameSite=Strict',
  ]
  if (config.adminCookieSecure) parts.push('Secure')
  parts.push(maxAgeSec === 0 ? 'Max-Age=0' : `Max-Age=${maxAgeSec}`)
  return parts.join('; ')
}

/** 取会话（含管理员信息）。过期/吊销一律视为无效。 */
function loadAdminSession(db, token, nowMs) {
  if (!token || typeof token !== 'string') return null
  const row = db.prepare(`
    SELECT s.*, u.username, u.role, u.status AS admin_status
    FROM admin_session s JOIN admin_user u ON u.id = s.admin_id
    WHERE s.token_hash = ?
  `).get(sha256Hex(token))
  if (!row) return null
  if (row.revoked_at_ms) return null
  if (Number(row.expires_at_ms) <= nowMs) return null
  if (row.admin_status !== 'active') return null
  return row
}

/** 清理过期/已吊销的会话。返回删除条数。 */
function sweepAdminSessions(db, nowMs) {
  const r = db.prepare(
    'DELETE FROM admin_session WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL'
  ).run(nowMs)
  return Number(r.changes || 0)
}

/** 管理员操作留痕（复用 001 就有的 `admin_action_log`）。 */
function logAdminAction(db, { adminId, adminName, action, target, detail, nowMs }) {
  db.prepare(`
    INSERT INTO admin_action_log (admin_id, admin_name, action, target, detail_json, at_ms)
    VALUES (?,?,?,?,?,?)
  `).run(
    adminId === undefined ? null : adminId,
    adminName ? String(adminName) : '',
    String(action), String(target || ''),
    detail ? JSON.stringify(jsonSafe(detail)) : null, nowMs
  )
}

// ═══════════════════════════════════════════════════════════
// 登录限流与锁定（进程内，随服务生命周期）
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 为什么放内存而不是库表：
 *    这是**防爆破的减速带**，不是审计数据。重启后计数清零可以接受
 *    （服务重启本身极少见，且被撞的账号还有 scrypt 成本与 12 小时会话 TTL 兜着）。
 *    放库表反而会引入"每次登录写一次库"的写放大，而这台机器上
 *    SQLite 是单写者（部署指南 §12.1）。
 */
function createLoginGuard(config) {
  const perIp = new Map()   // ip → { count, windowStartMs }
  const perUser = new Map() // username → { failCount, lockedUntilMs }
  const failLimit = LOCK_TIMES !== null ? LOCK_TIMES : config.loginFailLimit
  const lockMs = LOCK_MINUTES !== null ? LOCK_MINUTES * 60000 : config.loginLockMs
  // ⚠️ 优先取 config（测试需要把它调大，否则同一台机器上的多个用例
  //    会互相把对方的登录打成 429/423——那是测试之间的耦合，不是产品缺陷）。
  const configured = Number(config.loginRatePerMinute)
  const perMinuteMax = Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : readPositiveIntEnv('RATE_LIMIT_LOGIN_PER_MIN', IP_RATE_PER_MINUTE_DEFAULT)

  return {
    failLimit,
    lockMs,
    /** 该用户名当前是否被锁。 */
    lockedUntil(username, nowMs) {
      const rec = perUser.get(String(username))
      if (!rec) return null
      return rec.lockedUntilMs && rec.lockedUntilMs > nowMs ? rec.lockedUntilMs : null
    },
    /** 每 IP 每分钟的粗粒度限流（与账号锁定独立计，和部署指南 §9.4 一致）。 */
    checkRate(ip, nowMs) {
      const rec = perIp.get(ip)
      if (!rec || nowMs - rec.windowStartMs >= 60000) {
        perIp.set(ip, { count: 1, windowStartMs: nowMs })
        return { ok: true, count: 1 }
      }
      rec.count += 1
      if (rec.count > perMinuteMax) {
        return { ok: false, count: rec.count, limit: perMinuteMax }
      }
      return { ok: true, count: rec.count }
    },
    recordFailure(username, nowMs) {
      const key = String(username)
      const rec = perUser.get(key) || { failCount: 0, lockedUntilMs: null }
      rec.failCount += 1
      if (rec.failCount >= failLimit) rec.lockedUntilMs = nowMs + lockMs
      perUser.set(key, rec)
      return { failCount: rec.failCount, lockedUntilMs: rec.lockedUntilMs }
    },
    clear(username) { perUser.delete(String(username)) },
    /** 清理限流窗口，避免长跑进程里 Map 无限增长。 */
    sweep(nowMs) {
      for (const [ip, rec] of perIp) {
        if (nowMs - rec.windowStartMs > 600000) perIp.delete(ip)
      }
      for (const [user, rec] of perUser) {
        if (rec.lockedUntilMs && rec.lockedUntilMs <= nowMs && rec.failCount === 0) perUser.delete(user)
      }
    },
  }
}

/**
 * 账号不存在时用于**时序对齐**的固定哈希。
 *
 * ⚠️ 与 `api/routes-auth.js` 的 `DUMMY_HASH` 同一理由（那里是对的，这里照抄推理）：
 *    不比对就返回，会让"管理员不存在"的响应明显更快，
 *    攻击者据此可以枚举出后台管理员用户名——而管理员用户名是撞库的第一步。
 *    这里**必须**跑一次等价代价的 scrypt。
 */
const ADMIN_DUMMY_HASH = hashPassword('dummy-admin-password-for-timing-equalization')

// ═══════════════════════════════════════════════════════════
// 策略与生效值
// ═══════════════════════════════════════════════════════════

function globalPolicyVersion(db) {
  const row = db.prepare('SELECT policy_version FROM policy WHERE account_id IS NULL').get()
  return row ? Number(row.policy_version) : 1
}

function policyRowOf(db, accountId) {
  return db.prepare('SELECT * FROM policy WHERE account_id = ?').get(accountId) || null
}

/**
 * 与服务端心跳、CLI 用同一套推导（等级只由天数索引决定 + 账号级覆盖）。
 *
 * ⚠️ 用 `buildEffectivePolicy` 而不是 `buildPolicy`：后台要展示的必须是
 *    **实际会下发给客户端的**策略。若这里退回等级基准值，运维在后台看到的
 *    与客户端实际生效的就会不一致 —— 而"举证时该看哪一份"正是红线 3
 *    要回答的问题（`policy_ack_log` 存的就是客户端 ack 的生效值）。
 */
function currentPolicyFor(db, account, nowMs) {
  const first = Number(account.first_login_ms || 0)
  const dayIndex = deriveDayIndex(first > 0 ? first : nowMs, nowMs)
  return buildEffectivePolicy(db, {
    accountId: Number(account.account_id),
    accountDayIndex: dayIndex,
    policyVersion: globalPolicyVersion(db),
    nowMs,
  })
}

function getAccountRow(db, accountName) {
  const row = db.prepare('SELECT * FROM account WHERE account = ?').get(String(accountName))
  if (!row) {
    throw new AdminError('ADMIN_NOT_FOUND', `账号不存在：${printable(accountName, 64)}`)
  }
  return row
}

/** 生效状态（`active` + 已过期 → `expired`），与 CLI 的 accountSummary 同口径。 */
function effectiveStatus(row, nowMs) {
  let status = row.status
  if (status === 'active' && row.plan_expires_ms && Number(row.plan_expires_ms) <= nowMs) {
    status = 'expired'
  }
  return status
}

function balanceOf(db, accountId) {
  const row = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
  return row ? Number(row.balance_milli) : 0
}

function lastHeartbeatOf(db, accountId) {
  const row = db.prepare('SELECT MAX(last_seen_ms) AS m FROM device_session WHERE account_id = ?')
    .get(accountId)
  return row && row.m !== null && row.m !== undefined ? Number(row.m) : null
}

function liveSessionsOf(db, accountId, nowMs) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM device_session
    WHERE account_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
  `).get(accountId, nowMs)
  return Number(row.c)
}

/** 某账号"今日已计费发送条数"（按渠道）。⚠️ 与 domain/billing.js 的 usedQuota 同口径。 */
function todayUsageOf(db, accountId, nowMs) {
  const start = dayStartMs(nowMs)
  const out = { total: 0, by_source: {} }
  for (const src of SOURCE_TYPES) {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM send_log
      WHERE account_id = ? AND source_type = ?
        AND sent_at_ms >= ? AND sent_at_ms < ?
        AND verdict = 'sent_confirmed' AND billing_status = 'billed'
    `).get(accountId, src, start, start + MS_PER_DAY)
    const c = Number(row.c)
    out.by_source[src] = c
    out.total += c
  }
  return out
}

/** 等级表给出的日上限（**唯一来源**，不硬编码任何数值）。 */
function dailyCapOf(accountDayIndex) {
  const tier = tierForDayIndex(accountDayIndex)
  const out = { total: 0, by_source: {} }
  for (const src of SOURCE_TYPES) {
    const max = tier.limits[src].daily_max
    out.by_source[src] = max
    out.total += max
  }
  return out
}

/** 最近一条策略 ack（红线 3 的取证入口）。 */
function latestAckOf(db, accountId) {
  return db.prepare(`
    SELECT * FROM policy_ack_log WHERE account_id = ?
    ORDER BY last_seen_at_ms DESC, id DESC LIMIT 1
  `).get(accountId) || null
}

/** 解析 `applied_limits_json`，并只保留已知的渠道与数值字段。 */
function parseAppliedLimits(json) {
  if (!json) return null
  let parsed
  try {
    parsed = JSON.parse(String(json))
  } catch (e) {
    // ⚠️ 不吞异常：解析失败必须让人看见（否则取证会给出"没有生效值"的假结论）
    return { __unparsable: printable(json, 200) }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const out = {}
  for (const src of SOURCE_TYPES) {
    const given = parsed[src]
    if (!given || typeof given !== 'object') continue
    const one = {}
    for (const f of Object.keys(LIMIT_FIELD_DIRECTION)) {
      if (given[f] !== undefined && given[f] !== null) one[f] = given[f]
    }
    if (Object.keys(one).length) out[src] = one
  }
  return out
}

/** 从当前策略里取同一形态的上限，便于与生效值并排展示。 */
function policyLimitsOf(policy) {
  const out = {}
  for (const src of SOURCE_TYPES) {
    const l = policy.limits[src]
    out[src] = {
      daily_max: l.daily_max,
      min_interval_ms: l.min_interval_ms,
      content_similarity_max: l.content_similarity_max,
    }
  }
  return out
}

/** 生效值 vs 当前值是否有差异（用户调低过 / 策略变过）。 */
function limitsDiffer(a, b) {
  if (!a || !b) return null
  for (const src of SOURCE_TYPES) {
    if (!a[src] || !b[src]) continue
    for (const f of Object.keys(LIMIT_FIELD_DIRECTION)) {
      if (a[src][f] === undefined) continue
      if (Number(a[src][f]) !== Number(b[src][f])) return true
    }
  }
  return false
}

// ═══════════════════════════════════════════════════════════
// 发送明细的隐私投影
// ═══════════════════════════════════════════════════════════

/**
 * 把一行 `send_log` 投影成**只含允许字段**的普通对象。
 *
 * ⚠️ 这是隐私边界的主防线：字段来自 `SEND_DETAIL_FIELDS` 白名单，
 *    `SELECT *` 里多出来的列不会自动进入响应。
 * ⚠️ 第二道防线：`FORBIDDEN_RESPONSE_KEYS` 兜底剥离 + 计数上报，
 *    让"有人往白名单里加了 sec_uid"这件事**立刻可见**而不是静默泄漏。
 *
 * @param {object} row 数据库行（或任何含同名字段的对象）
 * @param {string[]} [violations] 兜底剥离的记录数组
 * @param {object} [opts]
 * @param {string[]} [opts.fields] 覆盖白名单。**只给测试用**——
 *   单测要能证明"兜底防线真的会响"，而唯一可靠的办法是把一个禁用字段
 *   塞进白名单跑一遍。导出常量本身是 `Object.freeze` 的（那是对的），
 *   所以这里开一个显式的注入口，而不是让测试去改冻结数组
 *   （改冻结数组会抛 `Cannot assign to read only property 'length'`，
 *    测试自己在运行时炸掉，而被测行为根本没验到）。
 */
function projectSend(row, violations, opts = {}) {
  const fields = Array.isArray(opts.fields) ? opts.fields : SEND_DETAIL_FIELDS
  const out = {}
  for (const f of fields) {
    if (row[f] === undefined) continue
    out[f] = jsonSafe(row[f])
  }
  for (const k of Object.keys(out)) {
    if (FORBIDDEN_RESPONSE_KEYS.includes(k.toLowerCase())) {
      delete out[k]
      if (violations) violations.push(k)
    }
  }
  return out
}

// ═══════════════════════════════════════════════════════════
// 处置动作（复用领域层，绝不自己写 SQL 改钱）
// ═══════════════════════════════════════════════════════════

/** 吊销会话。返回受影响条数。⚠️ 与 cli.js 的 revokeSessions 同语义。 */
function revokeSessions(db, { accountId, all, reason, nowMs }) {
  if (all) {
    const r = db.prepare(`
      UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ?
      WHERE revoked_at_ms IS NULL
    `).run(nowMs, reason)
    return Number(r.changes)
  }
  const r = db.prepare(`
    UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ?
    WHERE account_id = ? AND revoked_at_ms IS NULL
  `).run(nowMs, reason, accountId)
  return Number(r.changes)
}

function findPlanByName(db, name) {
  return db.prepare('SELECT * FROM plan WHERE name = ? AND active = 1').get(String(name)) || null
}

// ═══════════════════════════════════════════════════════════
// 各端点
// ═══════════════════════════════════════════════════════════

function login(ctx) {
  const { db, body, nowMs, config, log } = ctx
  const guard = ctx.admin.loginGuard
  const ip = ctx.admin.clientIp

  const username = String(body.user || body.username || '').trim()
  const password = String(body.password || '')
  if (!username || !password) {
    throw new AdminError('ADMIN_BAD_REQUEST', '用户名与密码均为必填')
  }

  const rate = guard.checkRate(ip, nowMs)
  if (!rate.ok) {
    log.warn('admin_login_rate_limited', { ip, limit: rate.limit })
    throw new AdminError('ADMIN_LOCKED',
      `该来源登录过于频繁（每分钟上限 ${rate.limit} 次），请稍后重试`)
  }

  const lockedUntil = guard.lockedUntil(username, nowMs)
  if (lockedUntil) {
    const waitSec = Math.ceil((lockedUntil - nowMs) / 1000)
    log.warn('admin_login_locked', { user_len: username.length, ip })
    throw new AdminError('ADMIN_LOCKED',
      `登录失败次数过多，请 ${waitSec} 秒后重试（登录名与密码错误）`, { locked_until_ms: lockedUntil })
  }

  const admin = db.prepare('SELECT * FROM admin_user WHERE username = ?').get(username)
  // ⚠️ 管理员不存在时**照样跑一次 scrypt**：否则响应时间会泄露"这个用户名存在"。
  const storedHash = admin ? admin.pass_hash : ADMIN_DUMMY_HASH
  const passOk = verifyPassword(password, storedHash)

  if (!admin || !passOk || admin.status !== 'active') {
    const rec = guard.recordFailure(username, nowMs)
    log.warn('admin_login_failed', { user_len: username.length, ip, fail_count: rec.failCount })
    sleepSync(LOGIN_FAIL_DELAY_MS)
    // ⚠️ 文案必须一致：区分"用户不存在/密码错/已停用"会把后台变成用户名枚举器。
    throw new AdminError('ADMIN_LOGIN_FAILED', '用户名或密码错误')
  }

  guard.clear(username)

  const token = newSessionToken()
  const ttlMs = config.adminSessionTtlHours * 3600000
  const expiresAt = nowMs + ttlMs
  db.prepare(`
    INSERT INTO admin_session (admin_id, token_hash, ip, user_agent, issued_at_ms, last_seen_ms, expires_at_ms)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    Number(admin.id), sha256Hex(token), printable(ip, 64),
    printable(ctx.req.headers['user-agent'] || '', 200), nowMs, nowMs, expiresAt
  )
  db.prepare('UPDATE admin_user SET last_login_ms = ? WHERE id = ?').run(nowMs, Number(admin.id))
  logAdminAction(db, {
    adminId: Number(admin.id), adminName: admin.username, action: 'admin_login',
    target: admin.username, nowMs, detail: { ip: printable(ip, 64) },
  })

  // ⚠️ 令牌只在 Set-Cookie 里出现一次。响应体里**绝不放** token。
  ctx.admin.extraHeaders['Set-Cookie'] = buildSessionCookie(
    config, token, Math.floor(ttlMs / 1000)
  )
  log.info('admin_login_ok', { user: admin.username, ip })

  return {
    ok: true,
    admin: { username: admin.username, role: admin.role },
    expires_at_ms: expiresAt,
    session_ttl_hours: config.adminSessionTtlHours,
    cookie_flags: {
      http_only: true, same_site: 'Strict', path: config.adminPath,
      secure: Boolean(config.adminCookieSecure),
    },
  }
}

function logout(ctx) {
  const { db, nowMs, config } = ctx
  const token = cookieValue(ctx.req, COOKIE_NAME)
  let revoked = 0
  if (token) {
    const r = db.prepare(`
      UPDATE admin_session SET revoked_at_ms = ?, revoked_reason = 'admin_logout'
      WHERE token_hash = ? AND revoked_at_ms IS NULL
    `).run(nowMs, sha256Hex(token))
    revoked = Number(r.changes || 0)
  }
  if (ctx.admin.session) {
    logAdminAction(db, {
      adminId: Number(ctx.admin.session.admin_id), adminName: ctx.admin.session.username,
      action: 'admin_logout', target: ctx.admin.session.username, nowMs,
    })
  }
  ctx.admin.extraHeaders['Set-Cookie'] = buildSessionCookie(config, '', 0)
  return { ok: true, revoked_count: revoked }
}

function overview(ctx) {
  const { db, nowMs } = ctx
  const query = queryOf(ctx)
  const win = windowOf(query, nowMs, { defaultDays: LIMITS.trend_days })

  // ── 商家计数（按生效状态分桶）────────────────────────────
  const accounts = db.prepare('SELECT account_id, status, plan_expires_ms, first_login_ms FROM account').all()
  const byStatus = { active: 0, disabled: 0, expired: 0, total: accounts.length }
  let online = 0
  for (const a of accounts) {
    byStatus[effectiveStatus(a, nowMs)] += 1
    if (liveSessionsOf(db, Number(a.account_id), nowMs) > 0) online += 1
  }

  // ── 明细（窗口内一次取出，交给 stats.js 聚合）────────────
  const rows = db.prepare(`
    SELECT source_type, verdict, sent_at_ms, user_key_hash
    FROM send_log WHERE sent_at_ms >= ? AND sent_at_ms < ?
  `).all(win.fromMs, win.toMs)
  const agg = aggregateSends(rows, { fromMs: win.fromMs, toMs: win.toMs })

  // failure_reasons 明细里没有分布信息（stats.js 明说由调用方补齐）
  const fr = db.prepare(`
    SELECT failure_reason, COUNT(*) AS c FROM send_log
    WHERE sent_at_ms >= ? AND sent_at_ms < ?
      AND verdict = 'failed' AND failure_reason IS NOT NULL
    GROUP BY failure_reason ORDER BY c DESC
  `).all(win.fromMs, win.toMs)
  for (const r of fr) {
    const key = String(r.failure_reason)
    // ⚠️ 闭集外的原因也要显示出来（否则"少算了一类失败"无从发现），
    //    但标注出来源，避免看板出现没有定义的原因标签。
    agg.failure_reasons[key] = (agg.failure_reasons[key] || 0) + Number(r.c)
    if (!FAILURE_REASONS.includes(key)) {
      agg.audit_flags = [...new Set(agg.audit_flags.concat(['unknown_failure_reason']))]
    }
  }

  const dailyQuota = dailyCapOf(deriveDayIndex(0, nowMs))

  // ── 额度消耗（按 settled_at_ms 切自然日，供趋势使用）──────
  const usageRows = db.prepare(`
    SELECT settled_at_ms, -delta_milli AS used FROM credit_ledger
    WHERE kind = 'consume' AND settled_at_ms >= ? AND settled_at_ms < ?
  `).all(win.fromMs, win.toMs)
  const usageByDay = {}
  let usedMilli = 0
  for (const u of usageRows) {
    const k = dayKey(Number(u.settled_at_ms))
    usageByDay[k] = (usageByDay[k] || 0) + Number(u.used)
    usedMilli += Number(u.used)
  }

  // ⚠️ leads_new 只在聚合上报里有（明细里推不出来，stats.js 明说"这里显式留 0，不猜"）。
  const leadRows = db.prepare(`
    SELECT received_at_ms, payload_json FROM usage_report
    WHERE received_at_ms >= ? AND received_at_ms < ?
  `).all(win.fromMs, win.toMs)
  const reports = []
  for (const r of leadRows) {
    let parsed
    try {
      parsed = JSON.parse(String(r.payload_json))
    } catch (e) {
      // ⚠️ 不吞异常：损坏的聚合上报必须可见，否则看板会静默少算
      agg.audit_flags = [...new Set(agg.audit_flags.concat(['usage_report_corrupt']))]
      continue
    }
    reports.push(parsed)
  }
  const reportAgg = aggregateReports(reports)
  for (const src of SOURCE_TYPES) {
    agg.sources[src].hits = reportAgg.sources[src].hits
    agg.sources[src].leads_new = reportAgg.sources[src].leads_new
    agg.sources[src].skipped = reportAgg.sources[src].skipped
  }
  agg.totals.hits = reportAgg.totals.hits
  agg.totals.leads_new = reportAgg.totals.leads_new
  agg.totals.skipped = reportAgg.totals.skipped
  agg.audit_flags = [...new Set(agg.audit_flags.concat(reportAgg.audit_flags))]
  // ⚠️ 两个口径的 sent_confirmed 不一致时必须显式暴露（stats.js 的 reconcile）
  const detailVsReport = reconcileAggregates(agg, reportAgg)

  const dashboard = buildDashboard(agg, {
    dailyQuota,
    extra: {
      积分消耗_milli: usedMilli,
      积分消耗_显示: milliToCreditsText(usedMilli),
    },
  })
  const trend = withBarPcts(buildTrend(rows, { days: win.days, nowMs, usageByDay }))

  // ── 今日 ─────────────────────────────────────────────────
  const todayStart = dayStartMs(nowMs)
  const todayRow = db.prepare(`
    SELECT
      COUNT(*) AS attempts,
      SUM(CASE WHEN verdict = 'sent_confirmed' THEN 1 ELSE 0 END) AS confirmed
    FROM send_log WHERE sent_at_ms >= ? AND sent_at_ms < ?
  `).get(todayStart, todayStart + MS_PER_DAY)
  const todayUsageRows = db.prepare(`
    SELECT COALESCE(-SUM(delta_milli), 0) AS m FROM credit_ledger
    WHERE kind = 'consume' AND settled_at_ms >= ? AND settled_at_ms < ?
  `).get(todayStart, todayStart + MS_PER_DAY)

  // ── 对账（全平台）────────────────────────────────────────
  const perAccount = []
  let matched = 0
  for (const a of accounts) {
    const id = Number(a.account_id)
    const r = reconcileLedger(db, id, win.fromMs, win.toMs)
    if (r.match) matched += 1
    else {
      perAccount.push({
        account_id: id,
        account: (db.prepare('SELECT account FROM account WHERE account_id = ?').get(id) || {}).account,
        ...r,
      })
    }
  }

  return {
    ok: true,
    server_time_ms: nowMs,
    window: { from_ms: win.fromMs, to_ms: win.toMs, days: win.days, from: dayKey(win.fromMs), to: dayKey(win.toMs - 1) },
    merchants: { ...byStatus, online, offline: byStatus.total - online, heartbeat_stale_ms: HEARTBEAT_STALE_MS },
    today: {
      from_ms: todayStart,
      to_ms: todayStart + MS_PER_DAY,
      day: dayKey(nowMs),
      reply_attempts: num(todayRow.attempts),
      sent_confirmed: num(todayRow.confirmed),
      credits_consumed_milli: num(todayUsageRows.m),
      credits_consumed: milliToCreditsText(num(todayUsageRows.m)),
    },
    range: {
      reply_attempts: dashboard.counts.reply_attempts,
      sent_confirmed: dashboard.counts.sent_confirmed,
      sent_confirmed_dom: dashboard.counts.sent_confirmed_dom,
      sent_suspected: dashboard.counts.sent_suspected,
      failed: dashboard.counts.failed,
      skipped: dashboard.counts.skipped,
      hits: dashboard.counts.hits,
      leads_new: dashboard.counts.leads_new,
      unique_users: dashboard.counts.unique_users,
      credits_consumed_milli: usedMilli,
      credits_consumed: milliToCreditsText(usedMilli),
    },
    // ⚠️ 成功率**只**来自 stats.js 的 buildDashboard。分母为 0 → null → 界面显示 `—`。
    success_rate: dashboard.display['回复成功率'],
    success_rate_display: dashboard.display['回复成功率显示'],
    dashboard,
    trend,
    failure_reasons: dashboard.failure_reasons,
    detail_vs_report: detailVsReport,
    reconcile: {
      checked_accounts: accounts.length,
      matched_accounts: matched,
      mismatched_accounts: perAccount.length,
      mismatches: perAccount.slice(0, 20),
      note: '以 send_log 明细为准（protocol.md §4.7）；不一致即需人工核查',
    },
    audit_flags: dashboard.audit_flags,
  }
}

function merchants(ctx) {
  const { db, nowMs, config } = ctx
  const query = queryOf(ctx)
  const status = query.status === undefined || query.status === '' ? null : String(query.status)
  if (status && !['active', 'disabled', 'expired'].includes(status)) {
    throw bad(`参数 status 只能是 active|disabled|expired，实际为 ${printable(status, 32)}`)
  }
  const q = query.q === undefined || query.q === '' ? null : String(query.q).slice(0, 64)
  const limit = intQuery(query, 'limit', { fallback: LIMITS.merchants, min: 1, max: LIMITS.merchants_max })
  const offset = intQuery(query, 'offset', { fallback: 0, min: 0 })

  const rows = db.prepare(`
    SELECT a.*, c.balance_milli, p.name AS plan_name, p.credits AS plan_credits
    FROM account a
    LEFT JOIN credit c ON c.account_id = a.account_id
    LEFT JOIN plan p ON p.plan_id = a.plan_id
    ORDER BY a.account_id
  `).all()

  const lowThresholdMilli = minBalanceAlertReplies(config) * config.creditPerReplyMilli

  const all = []
  for (const row of rows) {
    const id = Number(row.account_id)
    const st = effectiveStatus(row, nowMs)
    if (status && st !== status) continue
    if (q) {
      const hay = `${row.account} ${row.display_name || ''} ${row.note || ''}`.toLowerCase()
      if (!hay.includes(q.toLowerCase())) continue
    }
    const policy = currentPolicyFor(db, row, nowMs)
    const balanceMilli = row.balance_milli === null || row.balance_milli === undefined
      ? balanceOf(db, id) : Number(row.balance_milli)
    const hbMs = lastHeartbeatOf(db, id)
    const live = liveSessionsOf(db, id, nowMs)
    const stale = hbMs === null || nowMs - hbMs > HEARTBEAT_STALE_MS
    const balanceLow = balanceMilli < lowThresholdMilli
    const alerts = []
    if (balanceLow) alerts.push('balance_low')
    if (stale) alerts.push('heartbeat_stale')
    if (st === 'expired') alerts.push('plan_expired')
    if (st === 'disabled') alerts.push('account_disabled')
    if (!policy.sending_enabled) alerts.push('sending_disabled_observation')

    const todaySends = todayUsageOf(db, id, nowMs)
    const todayCap = dailyCapOf(policy.account_day_index)

    all.push({
      account_id: id,
      account: row.account,
      display_name: row.display_name || '',
      note: row.note || '',
      status: st,
      plan_name: row.plan_name || null,
      plan_expires_ms: numOrNull(row.plan_expires_ms),
      device_limit: num(row.device_limit),
      balance_milli: balanceMilli,
      // ⚠️ 换算在服务端做（前端零算术，与 client/ui 同一约束）
      balance_credits: milliToCreditsText(balanceMilli),
      replies_affordable: Math.floor(Math.max(balanceMilli, 0) / config.creditPerReplyMilli),
      balance_alert: balanceLow,
      balance_alert_threshold_milli: lowThresholdMilli,
      account_tier: policy.account_tier,
      account_day_index: policy.account_day_index,
      sending_enabled: policy.sending_enabled,
      policy_version: policy.policy_version,
      live_sessions: live,
      last_heartbeat_ms: hbMs,
      heartbeat_stale: stale,
      heartbeat_stale_ms: HEARTBEAT_STALE_MS,
      today_sends: todaySends,
      today_cap: todayCap,
      // ⚠️ 条宽百分比由服务端算（前端零算术）
      today_usage_pct: pctOf(todaySends.total, todayCap.total),
      alerts,
    })
  }

  return {
    ok: true,
    server_time_ms: nowMs,
    total: all.length,
    limit,
    offset,
    items: all.slice(offset, offset + limit),
    // 空结果不是错误：`total: 0` + `items: []` 让界面显示"暂无数据"
    empty: all.length === 0,
  }
}

function merchantDetail(ctx) {
  const { db, nowMs, config } = ctx
  const accountName = ctx.params.account
  const row = getAccountRow(db, accountName)
  const id = Number(row.account_id)
  const now = currentPolicyFor(db, row, nowMs)

  const ack = latestAckOf(db, id)
  const applied = ack ? parseAppliedLimits(ack.applied_limits_json) : null
  const currentLimits = policyLimitsOf(now)
  const pvRow = policyRowOf(db, id)

  const balanceMilli = balanceOf(db, id)
  const plan = row.plan_id
    ? db.prepare('SELECT name, credits, valid_days, plan_key FROM plan WHERE plan_id = ?')
      .get(Number(row.plan_id))
    : null

  // ── 近期发送摘要（只有计数与哈希聚合，没有原文）──────────
  const verdictRows = db.prepare(`
    SELECT verdict, COUNT(*) AS c FROM send_log WHERE account_id = ?
    GROUP BY verdict ORDER BY c DESC
  `).all(id)
  const byVerdict = {}
  for (const v of VERDICTS) byVerdict[v] = 0
  for (const r of verdictRows) byVerdict[String(r.verdict)] = Number(r.c)

  const billingRows = db.prepare(`
    SELECT billing_status, COUNT(*) AS c, COALESCE(SUM(charged_milli),0) AS m
    FROM send_log WHERE account_id = ? GROUP BY billing_status ORDER BY c DESC
  `).all(id)

  const lastSend = db.prepare(`
    SELECT send_id, verdict, sent_at_ms, source_type FROM send_log
    WHERE account_id = ? ORDER BY sent_at_ms DESC LIMIT 1
  `).get(id) || null

  // ── 配置变更历史（**含 applied=0**：那正是"用户是否被拒绝过"的证据）──
  const changeRows = db.prepare(`
    SELECT change_id, changed_at_ms, source, actor, field_key, old_value, new_value,
           applied, reject_code, policy_version, received_at_ms
    FROM audit_config_changes WHERE account_id = ?
    ORDER BY changed_at_ms DESC, id DESC LIMIT ?
  `).all(id, LIMITS.config_changes)

  const changeSummary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN applied = 0 THEN 1 ELSE 0 END) AS refused,
      SUM(CASE WHEN source = 'user' THEN 1 ELSE 0 END) AS from_user,
      SUM(CASE WHEN source = 'server_policy' THEN 1 ELSE 0 END) AS from_server
    FROM audit_config_changes WHERE account_id = ?
  `).get(id)

  // ── 会话 ─────────────────────────────────────────────────
  const sessionRows = db.prepare(`
    SELECT id, device_id, issued_at_ms, last_seen_ms, expires_at_ms, revoked_at_ms, revoked_reason
    FROM device_session WHERE account_id = ?
    ORDER BY last_seen_ms DESC LIMIT ?
  `).all(id, LIMITS.sessions)

  // ⚠️ 只算一次：这两个查询会各扫 3 个渠道，重复调用纯属浪费（且会让响应时间翻倍）
  const todaySendsDetail = todayUsageOf(db, id, nowMs)
  const todayCapDetail = dailyCapOf(now.account_day_index)

  return {
    ok: true,
    server_time_ms: nowMs,
    account: {
      account_id: id,
      account: row.account,
      display_name: row.display_name || '',
      note: row.note || '',
      status: effectiveStatus(row, nowMs),
      created_at_ms: num(row.created_at_ms),
      first_login_ms: numOrNull(row.first_login_ms),
      plan_expires_ms: numOrNull(row.plan_expires_ms),
      device_limit: num(row.device_limit),
      plan_name: plan ? plan.name : null,
      plan_credits: plan ? num(plan.credits) : null,
      plan_valid_days: plan ? num(plan.valid_days) : null,
    },
    credit: {
      balance_milli: balanceMilli,
      balance_credits: milliToCreditsText(balanceMilli),
      replies_affordable: Math.floor(Math.max(balanceMilli, 0) / config.creditPerReplyMilli),
      credit_per_reply_milli: config.creditPerReplyMilli,
      ledger_entries: Number(db.prepare(
        'SELECT COUNT(*) AS c FROM credit_ledger WHERE account_id = ?'
      ).get(id).c),
    },
    // ⚠️ 红线 3：生效值只从 policy_ack_log 读。`effective` 是**当时实际生效的**，
    //    `current` 是"现在按天数与全局版本会下发的"。两者不一致是要被看见的事实，
    //    不是要被抹平的噪声——所以两个都给，并给出 differs 标记。
    policy: {
      source_table: 'policy_ack_log',
      policy_version: ack ? num(ack.policy_version) : null,
      policy_hash: ack ? ack.policy_hash : null,
      account_tier: ack ? ack.account_tier : null,
      account_day_index: ack ? num(ack.account_day_index) : null,
      first_ack_at_ms: ack ? num(ack.first_ack_at_ms) : null,
      last_seen_at_ms: ack ? num(ack.last_seen_at_ms) : null,
      instance_id: ack ? ack.instance_id : null,
      effective_limits: applied,
      effective_limits_raw: ack ? ack.applied_limits_json : null,
      current_policy_version: now.policy_version,
      current_account_tier: now.account_tier,
      current_account_day_index: now.account_day_index,
      current_limits: currentLimits,
      sending_enabled: now.sending_enabled,
      active_hours: now.active_hours,
      limits_differ: limitsDiffer(applied, currentLimits),
      policy_override_version: pvRow ? num(pvRow.policy_version) : null,
      ack_present: Boolean(ack),
    },
    quota: {
      today_sends: todaySendsDetail,
      today_cap: todayCapDetail,
      today_usage_pct: pctOf(todaySendsDetail.total, todayCapDetail.total),
      source: 'send_log（verdict=sent_confirmed 且 billing_status=billed）',
    },
    sends_summary: {
      by_verdict: byVerdict,
      total: Object.values(byVerdict).reduce((a, b) => a + b, 0),
      by_billing: billingRows.map((r) => ({
        billing_status: String(r.billing_status), count: num(r.c), charged_milli: num(r.m),
        charged: milliToCreditsText(num(r.m)),
      })),
      last_send: lastSend ? {
        send_id: lastSend.send_id, verdict: lastSend.verdict,
        source_type: lastSend.source_type, sent_at_ms: num(lastSend.sent_at_ms),
      } : null,
      privacy: '仅返回哈希与判定；不含评论/回复原文，不含 sec_uid（红线 3）',
    },
    config_changes: {
      summary: {
        total: num(changeSummary.total),
        refused: num(changeSummary.refused),
        from_user: num(changeSummary.from_user),
        from_server: num(changeSummary.from_server),
      },
      items: changeRows.map((r) => ({
        change_id: r.change_id,
        changed_at_ms: num(r.changed_at_ms),
        received_at_ms: num(r.received_at_ms),
        source: r.source,
        actor: r.actor,
        field_key: r.field_key,
        field_label: FIELD_LABELS[r.field_key] || null,
        old_value: r.old_value,
        new_value: r.new_value,
        applied: num(r.applied) === 1,
        reject_code: r.reject_code,
        policy_version: numOrNull(r.policy_version),
      })),
      note: 'applied=false 的行是"用户主动调高过、系统拒绝过"的原始证据（protocol.md §4.9）',
    },
    sessions: sessionRows.map((s) => ({
      id: num(s.id),
      device_id: s.device_id,
      issued_at_ms: num(s.issued_at_ms),
      last_seen_ms: num(s.last_seen_ms),
      expires_at_ms: num(s.expires_at_ms),
      revoked_at_ms: numOrNull(s.revoked_at_ms),
      revoked_reason: s.revoked_reason,
      live: s.revoked_at_ms === null && Number(s.expires_at_ms) > nowMs,
    })),
  }
}

function merchantLedger(ctx) {
  const { db, nowMs } = ctx
  const query = queryOf(ctx)
  const accountName = ctx.params.account
  const row = getAccountRow(db, accountName)
  const id = Number(row.account_id)
  const limit = intQuery(query, 'limit', { fallback: LIMITS.ledger, min: 1, max: LIMITS.ledger_max })
  const kind = query.kind ? String(query.kind) : null

  const rows = kind
    ? db.prepare(`
        SELECT * FROM credit_ledger WHERE account_id = ? AND kind = ?
        ORDER BY settled_at_ms DESC, id DESC LIMIT ?
      `).all(id, kind, limit)
    : db.prepare(`
        SELECT * FROM credit_ledger WHERE account_id = ?
        ORDER BY settled_at_ms DESC, id DESC LIMIT ?
      `).all(id, limit)

  const total = db.prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE account_id = ?').get(id)
  const balanceMilli = balanceOf(db, id)

  return {
    ok: true,
    server_time_ms: nowMs,
    account: row.account,
    account_id: id,
    balance_milli: balanceMilli,
    balance_credits: milliToCreditsText(balanceMilli),
    total_entries: num(total.c),
    immutable: true,
    items: rows.map((r) => ({
      id: num(r.id),
      kind: r.kind,
      delta_milli: num(r.delta_milli),
      delta_credits: milliToCreditsText(num(r.delta_milli)),
      balance_after_milli: num(r.balance_after_milli),
      balance_after_credits: milliToCreditsText(num(r.balance_after_milli)),
      ref_send_id: r.ref_send_id || null,
      // ⚠️ 卡密只回哈希前缀，绝不回明文（库里本来也只有哈希）
      ref_code_hash_prefix: r.ref_code_hash ? String(r.ref_code_hash).slice(0, 12) : null,
      operator: r.operator,
      note: r.note,
      settled_at_ms: num(r.settled_at_ms),
    })),
    note: 'credit_ledger 只增不改：本接口与后台所有接口都不会 UPDATE/DELETE 它（纠错走反向分录）',
  }
}

function merchantSends(ctx) {
  const { db, nowMs } = ctx
  const query = queryOf(ctx)
  const row = getAccountRow(db, ctx.params.account)
  const id = Number(row.account_id)
  const limit = intQuery(query, 'limit', { fallback: LIMITS.sends, min: 1, max: LIMITS.sends_max })

  const win = (query.from !== undefined && query.from !== '') || (query.to !== undefined && query.to !== '')
    ? windowOf(query, nowMs, { defaultDays: LIMITS.trend_days })
    : { fromMs: -Infinity, toMs: Infinity, days: null }

  const verdict = query.verdict ? String(query.verdict) : null
  if (verdict && !VERDICTS.includes(verdict)) {
    throw bad(`参数 verdict 只能是 ${VERDICTS.join('|')}，实际为 ${printable(verdict, 32)}`)
  }
  const sourceType = query.source_type ? String(query.source_type) : null
  if (sourceType && !SOURCE_TYPES.includes(sourceType)) {
    throw bad(`参数 source_type 只能是 ${SOURCE_TYPES.join('|')}`)
  }

  // ⚠️⚠️ 隐私边界（红线 3 / protocol.md §7.5）：
  //     本查询**显式列出**要取的列，绝不 `SELECT *`。
  //     评论原文、回复原文、sec_uid 原文根本不在表里（上游就拒收），
  //     但 `policy_snapshot_json` 这类整块 JSON 也不该整份回给前端——
  //     它可能随着策略演进带上内部字段。所以这里一列一列写清楚。
  const sql = `
    SELECT send_id, source_type, verdict, confirm_signal,
           target_hash, user_key_hash, user_key_type, content_hash,
           platform_endpoint, platform_status_code, failure_reason,
           billing_status, charged_milli, applied_policy_version,
           sent_at_ms, received_at_ms, client_version, device_id, instance_id,
           report_id, over_limit
    FROM send_log
    WHERE account_id = ?
      ${Number.isFinite(win.fromMs) ? 'AND sent_at_ms >= ?' : ''}
      ${Number.isFinite(win.toMs) ? 'AND sent_at_ms < ?' : ''}
      ${verdict ? 'AND verdict = ?' : ''}
      ${sourceType ? 'AND source_type = ?' : ''}
    ORDER BY sent_at_ms DESC, id DESC LIMIT ?
  `
  const args = [id]
  if (Number.isFinite(win.fromMs)) args.push(win.fromMs)
  if (Number.isFinite(win.toMs)) args.push(win.toMs)
  if (verdict) args.push(verdict)
  if (sourceType) args.push(sourceType)
  args.push(limit)

  const rows = db.prepare(sql).all(...args)
  const violations = []
  const items = rows.map((r) => projectSend(r, violations))

  return {
    ok: true,
    server_time_ms: nowMs,
    account: row.account,
    account_id: id,
    window: Number.isFinite(win.fromMs)
      ? { from_ms: win.fromMs, to_ms: win.toMs, from: dayKey(win.fromMs), to: dayKey(win.toMs - 1) }
      : null,
    filters: { verdict, source_type: sourceType, limit },
    count: items.length,
    items,
    privacy: {
      rule: 'PD-3：只返回哈希、判定、时间、端点、状态码与失败原因',
      returned_fields: SEND_DETAIL_FIELDS,
      never_returned: ['评论原文', '回复原文', 'sec_uid 原文', '昵称', '手机号', '会话/房间/视频 ID 原文'],
      violations_stripped: violations,
    },
  }
}

function forensics(ctx) {
  const { db, nowMs } = ctx
  const query = queryOf(ctx)
  const row = getAccountRow(db, ctx.params.account)
  const id = Number(row.account_id)
  const atMs = query.at === undefined || query.at === ''
    ? nowMs
    : (() => {
      const raw = String(query.at).trim()
      if (/^\d{10,}$/.test(raw)) return Number(raw)
      return parseDayArg(raw, 'at') + MS_PER_DAY - 1
    })()
  const hours = intQuery(query, 'hours', { fallback: 24, min: 1, max: 720 })
  const windowFromMs = atMs - hours * 3600000

  const now = currentPolicyFor(db, row, nowMs)
  const pvRow = policyRowOf(db, id)

  // ── 问题 A：该时刻**实际生效**的策略（只从 policy_ack_log 读）────
  // ⚠️ 先找"最后确认时间在该时刻之前"的 ack；一个都没有时退回最近一条，
  //    并显式标注 fallback——绝不假装它在那个时刻生效过。
  const ackAt = db.prepare(`
    SELECT * FROM policy_ack_log WHERE account_id = ? AND first_ack_at_ms <= ?
    ORDER BY first_ack_at_ms DESC LIMIT 1
  `).get(id, atMs)
  const ackAnyLatest = ackAt || latestAckOf(db, id)
  const ackFallback = !ackAt && Boolean(ackAnyLatest)
  const applied = ackAnyLatest ? parseAppliedLimits(ackAnyLatest.applied_limits_json) : null
  const currentLimits = policyLimitsOf(now)

  // 该行明细自带的策略快照（冗余但独立：ack 丢失时它是唯一的生效值来源）
  const snapshotRow = db.prepare(`
    SELECT applied_policy_version, policy_snapshot_json, sent_at_ms FROM send_log
    WHERE account_id = ? AND policy_snapshot_json IS NOT NULL AND sent_at_ms <= ?
    ORDER BY sent_at_ms DESC LIMIT 1
  `).get(id, atMs)
  let snapshot = null
  if (snapshotRow && snapshotRow.policy_snapshot_json) {
    try {
      const parsed = JSON.parse(String(snapshotRow.policy_snapshot_json))
      snapshot = {
        policy_version: numOrNull(snapshotRow.applied_policy_version),
        sent_at_ms: num(snapshotRow.sent_at_ms),
        limits: parsed && parsed.limits ? parsed.limits : null,
        account_tier: parsed ? parsed.account_tier : null,
        sending_enabled: parsed ? parsed.sending_enabled : null,
      }
    } catch (e) {
      snapshot = { __unparsable: true, sent_at_ms: num(snapshotRow.sent_at_ms) }
    }
  }

  const policyAt = {
    question: '(a) 该时刻实际生效的策略是什么？',
    answer_zh: ackAnyLatest
      ? `策略 v${num(ackAnyLatest.policy_version)}（等级 ${ackAnyLatest.account_tier}，第 ${num(ackAnyLatest.account_day_index)} 天），` +
        `由客户端 instance「${printable(ackAnyLatest.instance_id, 64)}」于 ${new Date(num(ackAnyLatest.first_ack_at_ms)).toISOString()} 确认应用。`
      : '该账号没有任何策略确认记录（policy_ack_log 为空）——无法证明它应用过哪一版策略。',
    source: 'policy_ack_log.applied_limits_json（红线 3：只认实际生效值，不认设置值）',
    ack: ackAnyLatest ? {
      policy_version: num(ackAnyLatest.policy_version),
      policy_hash: ackAnyLatest.policy_hash,
      account_tier: ackAnyLatest.account_tier,
      account_day_index: num(ackAnyLatest.account_day_index),
      instance_id: ackAnyLatest.instance_id,
      first_ack_at_ms: num(ackAnyLatest.first_ack_at_ms),
      last_seen_at_ms: num(ackAnyLatest.last_seen_at_ms),
    } : null,
    ack_is_fallback: ackFallback,
    ack_fallback_note: ackFallback
      ? '该时刻之前没有任何确认记录，这里展示的是**时间上最近的一条**——它未必在询问时刻生效过。'
      : null,
    effective_limits: applied,
    effective_limits_raw: ackAnyLatest ? ackAnyLatest.applied_limits_json : null,
    from_send_snapshot: snapshot,
    current_policy: {
      policy_version: now.policy_version,
      account_tier: now.account_tier,
      account_day_index: now.account_day_index,
      sending_enabled: now.sending_enabled,
      limits: currentLimits,
    },
    limits_differ: limitsDiffer(applied, currentLimits),
    policy_override_version: pvRow ? num(pvRow.policy_version) : null,
  }

  // ── 问题 B/C：变化来自服务端还是用户；用户是否被拒绝过 ─────────
  const changes = db.prepare(`
    SELECT change_id, changed_at_ms, source, actor, field_key, old_value, new_value,
           applied, reject_code, policy_version
    FROM audit_config_changes WHERE account_id = ? AND changed_at_ms <= ?
    ORDER BY changed_at_ms DESC LIMIT ?
  `).all(id, atMs, LIMITS.config_changes_max)

  const byField = {}
  const refusals = []
  const escalations = []
  let fromUser = 0
  let fromServer = 0
  for (const c of changes) {
    const key = String(c.field_key)
    const item = {
      change_id: c.change_id,
      changed_at_ms: num(c.changed_at_ms),
      source: c.source,
      actor: c.actor,
      field_key: key,
      field_label: FIELD_LABELS[key] || null,
      old_value: c.old_value,
      new_value: c.new_value,
      applied: num(c.applied) === 1,
      reject_code: c.reject_code,
      policy_version: numOrNull(c.policy_version),
      direction: directionOf(key, c.old_value, c.new_value),
    }
    if (c.source === 'user') fromUser += 1
    if (c.source === 'server_policy') fromServer += 1
    if (!byField[key]) byField[key] = { field_key: key, field_label: item.field_label, rows: [] }
    byField[key].rows.push(item)

    // "主动调高过"：source=user 且方向是放宽
    if (item.source === 'user' && item.direction === 'loosen') escalations.push(item)
    // "系统拒绝过"：applied=0（协议 §4.9 要求此时必须带 reject_code）
    if (!item.applied) refusals.push(item)
  }

  const attemptedRaise = escalations.length > 0 || refusals.length > 0
  const origin = fromUser > 0 && fromServer > 0
    ? 'both'
    : fromUser > 0 ? 'user' : fromServer > 0 ? 'server_policy' : 'none'

  const originAt = {
    question: '(b) 变化来自服务端下发，还是用户自己调的？',
    answer_zh: origin === 'none'
      ? '该时刻之前没有任何配置变更记录。'
      : `用户侧 ${fromUser} 次、服务端下发 ${fromServer} 次（来源列 source 与操作者列 actor 直接给出）。`,
    source: 'audit_config_changes.source / .actor',
    counts: { from_user: fromUser, from_server: fromServer, total: changes.length },
    verdict: origin,
    by_field: Object.values(byField).map((g) => ({
      field_key: g.field_key, field_label: g.field_label, count: g.rows.length,
      rows: g.rows.slice(0, 50),
    })),
  }

  const refusalAt = {
    question: '(c) 用户是否主动调高过、系统是否拒绝过？',
    answer_zh: attemptedRaise
      ? `是。放宽方向的用户尝试 ${escalations.length} 次，被拒绝（applied=false）${refusals.length} 次。`
      : '没有记录到"用户主动调高上限"或"被系统拒绝"的行为。',
    source: 'audit_config_changes 中 source=user 且（applied=0 或 old→new 为放宽）的行',
    attempted_raise: attemptedRaise,
    escalations,
    refusals,
    refuse_codes: [...new Set(refusals.map((r) => r.reject_code).filter(Boolean))],
  }

  // ── 问题 D：此前 N 小时具体发了什么、有没有被风控 ──────────────
  const sends = db.prepare(`
    SELECT send_id, source_type, verdict, confirm_signal,
           target_hash, user_key_hash, content_hash,
           platform_endpoint, platform_status_code, failure_reason,
           billing_status, charged_milli, sent_at_ms, over_limit
    FROM send_log
    WHERE account_id = ? AND sent_at_ms >= ? AND sent_at_ms <= ?
    ORDER BY sent_at_ms DESC LIMIT ?
  `).all(id, windowFromMs, atMs, LIMITS.sends_max)

  const violations = []
  const sendItems = sends.map((s) => projectSend(s, violations))
  const agg = aggregateSends(sends)
  const frMap = {}
  for (const s of sends) {
    if (s.verdict === 'failed' && s.failure_reason) {
      const k = String(s.failure_reason)
      frMap[k] = (frMap[k] || 0) + 1
    }
  }
  agg.failure_reasons = frMap
  const dashboard = buildDashboard(agg, { extra: { window: { from_ms: windowFromMs, to_ms: atMs, hours } } })

  const riskCount = sends.filter((s) => String(s.failure_reason || '').includes('risk')).length
  const sendsAt = {
    question: `(d) 该时刻前 ${hours} 小时内具体发了什么、是否被风控过？`,
    answer_zh: sends.length
      ? `窗口内 ${sends.length} 条发送尝试：平台确认成功 ${dashboard.counts.sent_confirmed} 条，` +
        `DOM 判据 ${dashboard.counts.sent_confirmed_dom} 条，疑似 ${dashboard.counts.sent_suspected} 条，` +
        `失败 ${dashboard.counts.failed} 条；其中风控相关失败 ${riskCount} 条。`
      : `该时刻前 ${hours} 小时内没有发送记录。`,
    source: 'send_log（仅哈希与判定，无原文）',
    window: {
      from_ms: windowFromMs, to_ms: atMs, hours, at: dayKey(atMs),
    },
    counts: dashboard.counts,
    success_rate: dashboard.display['回复成功率'],
    success_rate_display: dashboard.display['回复成功率显示'],
    failure_reasons: frMap,
    risk_control_failures: riskCount,
    over_limit_count: sends.filter((s) => Number(s.over_limit) === 1).length,
    items: sendItems,
    truncated: sends.length >= LIMITS.sends_max,
  }

  return {
    ok: true,
    server_time_ms: nowMs,
    account: { account_id: id, account: row.account, display_name: row.display_name || '' },
    asked_at_ms: atMs,
    hours,
    policy_at: policyAt,
    change_origin: originAt,
    refusal: refusalAt,
    sends_at: sendsAt,
    privacy: {
      rule: 'PD-3：本响应只含哈希与判定；不含评论/回复原文，不含 sec_uid',
      never_returned: ['评论原文', '回复原文', 'sec_uid 原文', '昵称', '手机号'],
      violations_stripped: violations,
    },
  }
}

/** 判断一次配置变更的方向（放宽 / 收紧 / 未知）。 */
function directionOf(fieldKey, oldValue, newValue) {
  const field = String(fieldKey).split('.').pop()
  const dir = LIMIT_FIELD_DIRECTION[field]
  if (dir === undefined) return 'unknown'
  const a = Number(oldValue)
  const b = Number(newValue)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown'
  if (a === b) return 'same'
  const delta = b - a
  // dir = 1：变大即放宽；dir = -1：变小即放宽（间隔缩短 = 更激进）
  const loosened = dir === 1 ? delta > 0 : delta < 0
  return loosened ? 'loosen' : 'tighten'
}

function reconcileEndpoint(ctx) {
  const { db, nowMs } = ctx
  const query = queryOf(ctx)
  const win = windowOf(query, nowMs, { defaultDays: LIMITS.trend_days })

  const accounts = db.prepare('SELECT account_id, account FROM account ORDER BY account_id').all()
  const rows = []
  let matched = 0
  for (const a of accounts) {
    const r = reconcileLedger(db, Number(a.account_id), win.fromMs, win.toMs)
    if (r.match) matched += 1
    rows.push({ account_id: Number(a.account_id), account: a.account, ...r })
  }
  const mismatches = rows.filter((r) => !r.match)

  // 汇总级对账（全平台一行），任何不一致都必须在最外层可见
  const detail = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(charged_milli),0) AS m FROM send_log
    WHERE billing_status = 'billed' AND sent_at_ms >= ? AND sent_at_ms < ?
  `).get(win.fromMs, win.toMs)
  const ledger = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(-SUM(delta_milli),0) AS m FROM credit_ledger
    WHERE kind = 'consume' AND settled_at_ms >= ? AND settled_at_ms < ?
  `).get(win.fromMs, win.toMs)
  const globalMatch = Number(detail.c) === Number(ledger.c) && Number(detail.m) === Number(ledger.m)

  return {
    ok: true,
    server_time_ms: nowMs,
    window: { from_ms: win.fromMs, to_ms: win.toMs, from: dayKey(win.fromMs), to: dayKey(win.toMs - 1) },
    global: {
      match: globalMatch,
      detail_count: num(detail.c), detail_milli: num(detail.m),
      ledger_count: num(ledger.c), ledger_milli: num(ledger.m),
      delta_count: num(ledger.c) - num(detail.c),
      delta_milli: num(ledger.m) - num(detail.m),
    },
    accounts: { checked: rows.length, matched, mismatched: mismatches.length },
    mismatches: mismatches.slice(0, 50),
    authoritative_source: 'send_log',
    note: '以 send_log 明细为准（protocol.md §4.7 §6.7）。不一致说明有代码绕过了 grantCredits 或明细被清理过——必须人工核查。',
  }
}

function grantCredit(ctx) {
  const { db, body, nowMs, config, log } = ctx
  const row = getAccountRow(db, ctx.params.account)
  const id = Number(row.account_id)
  const adminName = ctx.admin.session ? ctx.admin.session.username : 'admin'

  const amountRaw = body.amount
  if (amountRaw === undefined || amountRaw === null || amountRaw === '') {
    throw new AdminError('ADMIN_ACCOUNT_INVALID', '缺少必填字段 amount（整数积分）')
  }
  const amount = Number(amountRaw)
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new AdminError('ADMIN_ACCOUNT_INVALID', `amount 必须是整数积分，实际为 ${printable(amountRaw, 32)}`)
  }
  if (amount === 0) {
    throw new AdminError('ADMIN_ACCOUNT_INVALID',
      'amount 不能为 0（0 值分录是 CLI 的对账修正入口，后台不做）')
  }
  const reason = String(body.reason || '').trim()
  if (!reason) throw new AdminError('ADMIN_ACCOUNT_INVALID', '必须填写 reason（会写进台账，供日后对账）')
  if (reason.length > 200) throw new AdminError('ADMIN_ACCOUNT_INVALID', 'reason 过长（最多 200 字）')

  // ⚠️ 只经 `grantCredits()`。它在一个事务里同写 append-only 的 credit_ledger
  //    与余额快照——**绝不 UPDATE 余额**，否则台账链会与余额漂移。
  const result = grantCredits(db, {
    accountId: id,
    deltaMilli: creditsToMilli(amount),
    // 加分用 grant、减分用 adjust（与 cli.js 的 `credit revoke` 同口径）
    kind: amount > 0 ? 'grant' : 'adjust',
    operator: `admin:${adminName}`,
    note: reason,
    nowMs,
  })

  const minimum = minPlanCredit()
  logAdminAction(db, {
    adminId: ctx.admin.session ? Number(ctx.admin.session.admin_id) : null,
    adminName, action: amount > 0 ? 'credit_grant' : 'credit_revoke',
    target: row.account, nowMs,
    detail: { amount, reason, balance_milli: result.balance_milli },
  })
  log.info('admin_credit_grant', { account: row.account, amount, by: adminName })

  return {
    ok: true,
    account: row.account,
    account_id: id,
    granted_credits: amount,
    balance_milli: Number(result.balance_milli),
    balance_credits: milliToCreditsText(Number(result.balance_milli)),
    replies_affordable: Math.floor(Math.max(Number(result.balance_milli), 0) / config.creditPerReplyMilli),
    warning: amount > 0 && amount < minimum
      ? `本次发放 ${amount} 积分，低于套餐最低积分 ${minimum}（PLAN_QUOTA_BELOW_MIN）。` +
        '开号时低于该值会被 CLI 拒绝；后台补发不受限，但请确认这是有意的。'
      : null,
    ledger: '已写入 credit_ledger（append-only，历史分录不会被修改）',
  }
}

function setMerchantStatus(ctx) {
  const { db, body, nowMs, log } = ctx
  const row = getAccountRow(db, ctx.params.account)
  const id = Number(row.account_id)
  const adminName = ctx.admin.session ? ctx.admin.session.username : 'admin'
  const status = String(body.status || '').trim()
  if (!['active', 'disabled'].includes(status)) {
    throw new AdminError('ADMIN_ACCOUNT_INVALID',
      'status 只能是 active（启用）或 disabled（停用）；expired 由到期时间自动推导，不能手工设置')
  }
  const reason = String(body.reason || '').trim()
  if (!reason) throw new AdminError('ADMIN_ACCOUNT_INVALID', '必须填写 reason（会写进审计，说明为什么停/启用）')

  let revoked = 0
  if (status === 'disabled') {
    if (row.status === 'disabled') {
      return { ok: true, account: row.account, status, changed: false, revoked_sessions: 0, message: '已经是停用状态，未重复操作' }
    }
    // ⚠️ 与 `cli.js account disable` 同路径：停用必须**同时踢会话**，
    //    否则客户端能靠已签发的 7 天 token 继续跑（授权中心失去停机能力）。
    db.prepare('UPDATE account SET status = ?, updated_at_ms = ? WHERE account_id = ?')
      .run('disabled', nowMs, id)
    revoked = revokeSessions(db, { accountId: id, reason: 'account_disabled', nowMs })
    logAdminAction(db, {
      adminId: ctx.admin.session ? Number(ctx.admin.session.admin_id) : null,
      adminName, action: 'account_disable', target: row.account, nowMs,
      detail: { reason, revoked_sessions: revoked },
    })
    log.warn('admin_account_disable', { account: row.account, by: adminName, revoked })
    return {
      ok: true, account: row.account, account_id: id, status, changed: true,
      revoked_sessions: revoked, reason,
      message: `已停用；吊销 ${revoked} 个会话（该账号客户端会立刻收到 403 AUTH_ACCOUNT_DISABLED）`,
    }
  }

  const expires = Number(row.plan_expires_ms || 0)
  if (expires > 0 && expires <= nowMs) {
    throw new AdminError('ADMIN_ACCOUNT_INVALID',
      `账号套餐已到期（${new Date(expires).toISOString()}），仅启用状态无法登录。请先续期（发放积分并延长套餐）再启用。`)
  }
  db.prepare('UPDATE account SET status = ?, updated_at_ms = ? WHERE account_id = ?')
    .run('active', nowMs, id)
  logAdminAction(db, {
    adminId: ctx.admin.session ? Number(ctx.admin.session.admin_id) : null,
    adminName, action: 'account_enable', target: row.account, nowMs, detail: { reason },
  })
  log.info('admin_account_enable', { account: row.account, by: adminName })
  return { ok: true, account: row.account, account_id: id, status, changed: true, revoked_sessions: 0, reason, message: '已启用' }
}

function revokeSessionEndpoint(ctx) {
  const { db, body, nowMs, log } = ctx
  const adminName = ctx.admin.session ? ctx.admin.session.username : 'admin'
  const all = body.all === true
  const reason = String(body.reason || (all ? 'admin_revoke_all' : 'admin_revoke')).trim()

  let revoked
  let target
  if (all) {
    revoked = revokeSessions(db, { all: true, reason, nowMs })
    target = '*'
  } else {
    const accountName = String(body.account || '').trim()
    if (!accountName) throw new AdminError('ADMIN_BAD_REQUEST', '缺少 account，或显式传 all:true 以吊销全部会话')
    const row = getAccountRow(db, accountName)
    revoked = revokeSessions(db, { accountId: Number(row.account_id), reason, nowMs })
    target = row.account
  }

  logAdminAction(db, {
    adminId: ctx.admin.session ? Number(ctx.admin.session.admin_id) : null,
    adminName, action: all ? 'session_revoke_all' : 'session_revoke', target, nowMs,
    detail: { reason, revoked },
  })
  log.warn('admin_session_revoke', { target, revoked, by: adminName })
  return {
    ok: true, target, revoked_sessions: revoked, reason,
    note: all
      ? '已吊销全平台未失效会话——**全体商家需要重新登录**'
      : '已吊销该账号未失效会话，客户端会在下一个请求收到 401 并重新登录',
  }
}

function listPlans(ctx) {
  const { db, nowMs } = ctx
  const rows = db.prepare('SELECT * FROM plan ORDER BY active DESC, plan_id').all()
  return {
    ok: true,
    server_time_ms: nowMs,
    min_plan_credit: minPlanCredit(),
    min_plan_credit_basis: 'stable_daily_max_total × 180 天（由 tier_table 实时推导，不可硬编码）',
    items: rows.map((p) => ({
      plan_id: num(p.plan_id),
      plan_key: p.plan_key,
      name: p.name,
      credits: num(p.credits),
      valid_days: num(p.valid_days),
      price_cents: num(p.price_cents),
      price_is_placeholder: num(p.price_is_placeholder) === 1,
      is_default: num(p.is_default) === 1,
      active: num(p.active) === 1,
      created_at_ms: num(p.created_at_ms),
    })),
  }
}

function adminActions(ctx) {
  const { db, nowMs } = ctx
  const query = queryOf(ctx)
  const limit = intQuery(query, 'limit', { fallback: LIMITS.admin_actions, min: 1, max: LIMITS.admin_actions_max })
  const rows = db.prepare(`
    SELECT id, admin_name, action, target, detail_json, at_ms
    FROM admin_action_log ORDER BY at_ms DESC, id DESC LIMIT ?
  `).all(limit)
  return {
    ok: true,
    server_time_ms: nowMs,
    count: rows.length,
    items: rows.map((r) => {
      let detail = null
      if (r.detail_json) {
        try { detail = JSON.parse(String(r.detail_json)) } catch (e) { detail = { __unparsable: true } }
      }
      return {
        id: num(r.id), admin_name: r.admin_name, action: r.action,
        target: r.target, detail, at_ms: num(r.at_ms),
      }
    }),
  }
}

function sessionInfo(ctx) {
  const { nowMs, config } = ctx
  const s = ctx.admin.session
  return {
    ok: true,
    server_time_ms: nowMs,
    admin: { username: s.username, role: s.role },
    session: {
      issued_at_ms: num(s.issued_at_ms),
      last_seen_ms: num(s.last_seen_ms),
      expires_at_ms: num(s.expires_at_ms),
      ip: s.ip,
    },
    admin_path: config.adminPath,
    session_ttl_hours: config.adminSessionTtlHours,
    ip_allow: config.adminIpAllow,
    ip_allow_note: '空列表 = 只允许回环（config.parseIpAllow 已补回环，绝不表示"全部允许"）',
    cookie_secure: Boolean(config.adminCookieSecure),
    trust_proxy: Boolean(config.trustProxy),
    // ⚠️ 这里**没有** token 字段，永远不会有
  }
}

// ═══════════════════════════════════════════════════════════
// 路由装配
// ═══════════════════════════════════════════════════════════

/**
 * 构造后台路由器。
 *
 * ⚠️ 所有路径都带 `config.adminPath` 前缀，因此 `router.match(pathname)`
 *    能直接返回 `params`，不必手工切前缀（手工切前缀是路径穿越的经典入口）。
 */
function buildAdminRouter(config) {
  const r = new Router()
  const A = config.adminPath

  r.get(`${A}`, (ctx) => serveAsset(ctx, ''))
  r.get(`${A}/`, (ctx) => serveAsset(ctx, '/'))
  r.get(`${A}/index.html`, (ctx) => serveAsset(ctx, '/index.html'))
  r.get(`${A}/app.css`, (ctx) => serveAsset(ctx, '/app.css'))
  r.get(`${A}/app.js`, (ctx) => serveAsset(ctx, '/app.js'))

  // ── 公开（仅登录）────────────────────────────────────────
  r.post(`${A}/api/login`, (ctx) => login(ctx))

  // ── 需会话 ───────────────────────────────────────────────
  r.post(`${A}/api/logout`, (ctx) => logout(ctx))
  r.get(`${A}/api/session`, (ctx) => sessionInfo(ctx))
  r.get(`${A}/api/overview`, (ctx) => overview(ctx))
  r.get(`${A}/api/merchants`, (ctx) => merchants(ctx))
  r.get(`${A}/api/merchant/:account`, (ctx) => merchantDetail(ctx))
  r.get(`${A}/api/merchant/:account/ledger`, (ctx) => merchantLedger(ctx))
  r.get(`${A}/api/merchant/:account/sends`, (ctx) => merchantSends(ctx))
  r.get(`${A}/api/forensics/:account`, (ctx) => forensics(ctx))
  r.get(`${A}/api/reconcile`, (ctx) => reconcileEndpoint(ctx))
  r.get(`${A}/api/plans`, (ctx) => listPlans(ctx))
  r.get(`${A}/api/admin-actions`, (ctx) => adminActions(ctx))
  r.post(`${A}/api/merchant/:account/credit`, (ctx) => grantCredit(ctx))
  r.post(`${A}/api/merchant/:account/status`, (ctx) => setMerchantStatus(ctx))
  r.post(`${A}/api/session/revoke`, (ctx) => revokeSessionEndpoint(ctx))

  return r
}

/** 静态资源：显式白名单 + 形态检查，**不做路径拼接**。 */
function serveAsset(ctx, key) {
  const asset = STATIC_ASSETS[key]
  if (!asset) throw new AdminError('ADMIN_NOT_FOUND', '资源不存在')
  assertSafeAssetPath(ctx.pathname)
  const full = path.join(WEB_DIR, asset.file)
  // ⚠️ 二次确认：拼出来的绝对路径必须仍在 WEB_DIR 之内。
  //    这是"万一白名单被人改成 '..\\server.js'"时的最后一道门。
  const resolved = path.resolve(full)
  if (resolved !== path.resolve(WEB_DIR, asset.file) || !resolved.startsWith(path.resolve(WEB_DIR) + path.sep)) {
    throw new AdminError('ADMIN_NOT_FOUND', '资源不存在')
  }
  let body
  try {
    body = fs.readFileSync(resolved)
  } catch (e) {
    ctx.log.error('admin_asset_read_failed', { file: asset.file, message: e && e.message })
    throw new AdminError('SERVER_INTERNAL', '后台静态资源不可读，请检查部署产物是否完整')
  }
  ctx.res.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': body.length,
    // ⚠️ 后台页面绝不缓存：这是厂商侧的敏感界面，缓存会把"上一次登录的
    //    页面与数据"留在共享机器的磁盘上。
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // 后台只用同源资源；一旦出现外链，说明有人往 web/ 里塞了 CDN 引用
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  })
  ctx.res.end(body)
}

/**
 * 静态资源路径的形态检查。
 *
 * ⚠️ 任何含 `..` / `/`（除首尾）/ `\` 的路径直接拒绝，**不做规范化后放行**。
 *    `..%2f` 这类编码穿越在到达这里之前已被 `new URL()` 解码，
 *    因此比较的是解码后的形态——这正是我们想要的。
 */
function assertSafeAssetPath(pathname) {
  const raw = String(pathname || '')
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch (e) {
    throw new AdminError('ADMIN_NOT_FOUND', '资源路径编码非法')
  }
  const bad = decoded.includes('..') || decoded.includes('\\') ||
    decoded.includes('\u0000') || /%2e|%2f|%5c/i.test(raw)
  if (bad) throw new AdminError('ADMIN_NOT_FOUND', '资源路径非法')
}

// ═══════════════════════════════════════════════════════════
// 挂载点
// ═══════════════════════════════════════════════════════════

/**
 * 创建后台挂载件。
 *
 * @returns {null|object} `config.adminPath === null` 时返回 `null` —— **后台不存在**。
 *   调用方（server.js）拿到 null 就什么都不挂，于是后台路径返回普通 404。
 */
function createAdmin(config, log) {
  if (!config || !config.adminPath) return null

  const router = buildAdminRouter(config)
  const loginGuard = createLoginGuard(config)

  // ⚠️ 过期会话清理：既在每次鉴权时按需删（见 loadAdminSession 路径），
  //    也由这个定时任务兜底。**定时器必须有 teardown**（dispose 里 clearInterval），
  //    否则 close() 之后进程会因为这个 handle 而挂着不退出。
  let disposed = false
  const sweepTimer = setInterval(() => {
    if (disposed || !depsRef.db) return
    try {
      const removed = sweepAdminSessions(depsRef.db, Date.now())
      if (removed > 0) log.info('admin_session_sweep', { removed })
    } catch (e) {
      // ⚠️ 不吞异常：清理失败必须可见，否则会话表会无声增长
      log.warn('admin_session_sweep_failed', { message: e && e.message })
    }
  }, SESSION_SWEEP_MS)
  sweepTimer.unref()

  /**
   * 定时任务需要 db，但 db 由 `createServer` 在**构造后台之后**才交进来。
   * 用一个小盒子传递，避免"为了拿 db 而把后台构造推迟到装配链末端"——
   * 后台路由必须在 createServer 返回之前就建好。
   */
  const depsRef = { db: null }

  /**
   * ⚠️⚠️ 下面三个函数**必须定义在 createAdmin 内部**，不能挪到文件末尾。
   *
   *     这里踩过一个会让"后台完全打不开"的坑：它们原本写在 `createAdmin`
   *     闭合花括号**之后**（缩进看着像在函数里，其实在模块作用域）。
   *     而 `handle()` 里调用了它们 —— 调用点在内层作用域，声明在外层，
   *     本应没问题……但当时的实际形态是**声明落在了 createAdmin 内部、
   *     调用点也在内部**，于是函数声明被提升到 `createAdmin` 的**函数体顶部**，
   *     而 `return { ... }` 之前还有个 `const depsRef`。
   *     具体症状：任何静态资源请求都返回 500，
   *     日志里是 `ReferenceError: assetAuthError is not defined`
   *     ——**整个后台一个页面都打不开**，而接口测试却能通过
   *     （因为接口走的是另一条分支）。
   *
   *     所以：这三个函数跟着 createAdmin 走，放在 return 之前，
   *     并在单测里补一条"GET 后台首页必须 200"的用例把它钉住。
   */
  function dbTouchSession(db, session, nowMs) {
    db.prepare('UPDATE admin_session SET last_seen_ms = ? WHERE id = ?').run(nowMs, Number(session.id))
  }

  /**
   * 静态资源未通过鉴权时的响应。
   *
   * ⚠️ 必须是 HTML。浏览器在首屏导航里**不会**解析 JSON 错误体，
   *    回一个 `{"ok":false,...}` 的结果是用户在控制台里看到一个
   *    JSON 解析报错、页面上什么也没有——而真正的原因是"未登录"。
   *    这类"界面加载不出来但接口都正常"的排障弯路必须从源头消掉。
   */
  function assetAuthError(ctx, err) {
    if (ctx.res.writableEnded) return true
    const body = Buffer.from(
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>需要登录 · 授权中心管理后台</title></head><body>' +
      '<p>需要登录后才能打开管理后台。</p>' +
      `<p>（${printable(err.message, 120)} / ${printable(err.code, 40)}）</p>` +
      '<p>请先访问本机端口上的后台登录页，或经 SSH 隧道打开后重新登录。</p>' +
      '</body></html>', 'utf8')
    ctx.res.writeHead(err.status || 401, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    })
    ctx.res.end(body)
    return true
  }

  /**
   * 统一的后台错误信封。
   *
   * ⚠️ 两类错误要分开：
   *   · `AdminError` —— 后台自己的码（不进契约表），message 面向运维，直接回显。
   *   · `AppError`（shared/lib/errors.js）—— **领域层**抛的（如 grantCredits 的
   *     `CREDIT_EXHAUSTED` 402）。它的 status 来自契约表，必须原样透出：
   *     否则"余额会变负"这种**可预期的业务拒绝**会变成 500，
   *     运维看到的是一句"后台内部错误"，完全无从判断该怎么做。
   *   · 其它异常 —— 一律 500 且**不回显原始 message**（SQL 错误/路径会泄漏内部结构）。
   */
  function adminError(ctx, err, opts = {}) {
    const isAdmin = err instanceof AdminError
    const isDomain = !isAdmin && err && err.name === 'AppError' && Number.isFinite(err.status)

    const code = isAdmin ? err.code : (isDomain ? err.code : 'SERVER_INTERNAL')
    const status = isAdmin ? err.status : (isDomain ? err.status : 500)
    const message = isAdmin ? err.message
      : (isDomain ? err.message : '后台内部错误，请查看服务端日志')

    if (isDomain) {
      // 领域层的拒绝是**正常业务流**（余额不足、余额会变负），只记 warn
      ctx.log.warn('admin_domain_error', {
        code, status, path: printable(ctx.pathname, 200), message,
      })
    } else if (!isAdmin) {
      ctx.log.error('admin_unhandled_error', {
        path: printable(ctx.pathname, 200),
        message: err && err.message,
        stack: err && err.stack,
      })
    } else if (status >= 500) {
      ctx.log.error('admin_error', { code, path: printable(ctx.pathname, 200), message })
    }
    // ⚠️ 501（未实现）是**预期**结果，不记 error——否则日志里全是噪声，
    //    真正的异常会被淹掉。

    if (ctx.res.writableEnded) return true
    const payload = { ok: false, code, message }
    const detail = isAdmin ? err.detail : (isDomain ? err.detail : null)
    if (detail !== null && detail !== undefined) payload.detail = jsonSafe(detail)
    sendJson(ctx.res, status, payload, opts.headers || {})
    return true
  }

  return {
    router,
    loginGuard,
    config,
    /** 由 server.js 在拿到 db 后注入。 */
    attachDb(db) { depsRef.db = db },
    async handle(ctx, parsedPath) {
      const nowMs = ctx.nowMs
      const isPost = ctx.req.method === 'POST'

      // ① URL 形态检查（在任何鉴权之前：畸形路径不配得到有信息量的响应）
      assertSafeAssetPath(parsedPath)

      const isApi = parsedPath === `${config.adminPath}/api` ||
        parsedPath.startsWith(`${config.adminPath}/api/`)

      // ② IP 白名单（fail-safe：名单为空时 config 已补成只允许回环）
      const ip = clientIpOf(ctx.req, config)
      if (!ipAllowed(config.adminIpAllow, ip)) {
        log.warn('admin_ip_denied', { ip: printable(ip, 64), path: printable(parsedPath, 120) })
        return adminError(ctx, new AdminError('ADMIN_IP_DENIED',
          '来源 IP 不在 ADMIN_IP_ALLOW 白名单内'), { post: isPost })
      }

      const hit = router.match(ctx.req.method, parsedPath)
      const params = hit ? (hit.params || {}) : {}
      const isLogin = parsedPath === `${config.adminPath}/api/login`

      /**
       * ⚠️ 静态资源（登录页本身）**不要求会话**，但仍受 IP 白名单与路径白名单约束。
       *
       * 为什么必须这样：登录页是首屏，浏览器要先拿到 HTML/CSS/JS 才能渲染出
       * 登录表单。若它也要会话，就形成死锁——"要用后台先登录，要登录先有后台"。
       *
       * 这不会削弱防护，因为：
       *   · 资源是**代码**，不含任何数据（无令牌、无商家信息、无样例数字）；
       *   · 仍受 `ADMIN_IP_ALLOW` 约束（上面第 ② 步已过）；
       *   · 仍受显式文件名白名单约束（`STATIC_ASSETS`，天然挡住路径穿越）；
       *   · 真正的数据接口**全部**要求会话（下面第 ⑤ 步）。
       */
      const staticAsset = STATIC_ASSETS[parsedPath === config.adminPath
        ? ''
        : parsedPath.slice(config.adminPath.length)]

      // ⑤ 会话鉴权（登录接口与静态资源除外）
      let authSession = null
      if (!isLogin && !staticAsset) {
        const token = cookieValue(ctx.req, COOKIE_NAME)
        const session = token ? loadAdminSession(ctx.db, token, nowMs) : null
        if (!session) {
          // 过期会话顺手清掉（否则会话表会无声增长）
          if (token) sweepAdminSessions(ctx.db, nowMs)
          return adminError(ctx, new AdminError(
            token ? 'ADMIN_SESSION_INVALID' : 'ADMIN_TOKEN_MISSING',
            token ? '后台会话已失效或已过期，请重新登录' : '未登录'
          ), { post: isPost })
        }
        authSession = session
        dbTouchSession(ctx.db, session, nowMs)
      }

      // ⑥ 状态变更：CSRF 三连（登录接口也要过，否则可拿厂商浏览器当撞库跳板）
      if (isPost) {
        try {
          assertCsrfOk(ctx.req, isLogin)
        } catch (e) {
          return adminError(ctx, e, { post: true })
        }
      }

      // ⑦ 已达鉴权要求后再谈"路由实现没实现、方法对不对"
      if (!hit) {
        if (router.hasPath(parsedPath)) {
          return adminError(ctx, new AdminError('ADMIN_METHOD_NOT_ALLOWED',
            `${ctx.req.method} 不被支持`), { post: isPost })
        }
        // ⚠️ 未实现的接口一律 501 + 结构化信封，**绝不 200 + 空数据**。
        //    旧代码 D-14 的形态正是"接口返回全空 → 前端不清状态 →
        //    看板一直挂着上一次的数字"，比报错更难发现。
        if (isApi) {
          return adminError(ctx, new AdminError('NOT_IMPLEMENTED',
            `后台尚未实现该接口：${ctx.req.method} ${parsedPath}`,
            { method: ctx.req.method, path: printable(parsedPath, 200) }), { post: isPost })
        }
        // 非 API 路径：普通 404，不暴露"这里有个后台"
        return sendJson(ctx.res, 404, { ok: false, code: 'ADMIN_NOT_FOUND', message: 'not found' })
      }

      // ⑦ 解析请求体（POST）。⚠️ 必须在 handler 之前，
      //    否则 handler 拿到的是空 body —— 表现为"提交了但什么都没变"。
      let body = {}
      if (isPost) {
        try {
          const { parsed } = await readJsonBody(ctx.req)
          body = parsed
        } catch (e) {
          return adminError(ctx, new AdminError('ADMIN_BAD_REQUEST',
            e && e.code === 'REPORT_TOO_LARGE' ? '请求体超过上限' : `请求体不是合法 JSON：${e && e.message}`),
          { post: true })
        }
      }

      const admin = {
        clientIp: ip,
        loginGuard,
        session: authSession,
        /** handler 通过它追加响应头（Set-Cookie）。 */
        extraHeaders: {},
      }
      const actx = { ...ctx, params, body, admin }

      try {
        const payload = hit.handler(actx)
        const resolved = payload && typeof payload.then === 'function' ? await payload : payload
        if (ctx.res.writableEnded) return true
        sendJson(ctx.res, 200, jsonSafe(resolved), admin.extraHeaders)
        return true
      } catch (e) {
        return adminError(ctx, e, { post: true, headers: admin.extraHeaders })
      }
    },
    /** 幂等 teardown。⚠️ 必须可重复调用（server.close 可能被调多次）。 */
    dispose() {
      clearInterval(sweepTimer)
    },
  }
}

module.exports = {
  createAdmin,
  buildAdminRouter,
  // 供单测直接断言纯函数
  clientIpOf,
  normalizeIp,
  ipAllowed,
  ipEntryMatches,
  isLoopbackAddr,
  ipv4ToInt,
  ipv6ToBuffer,
  assertCsrfOk,
  assertSafeAssetPath,
  buildSessionCookie,
  loadAdminSession,
  sweepAdminSessions,
  projectSend,
  directionOf,
  parseAppliedLimits,
  milliToCreditsText,
  pctOf,
  withBarPcts,
  windowOf,
  limitsDiffer,
  revokeSessions,
  SEND_DETAIL_FIELDS,
  FORBIDDEN_RESPONSE_KEYS,
  STATIC_ASSETS,
  COOKIE_NAME,
  ADMIN_STATUS,
  AdminError,
}
