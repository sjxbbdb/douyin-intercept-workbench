'use strict'

// license-server/config.js
//
// 服务端配置。优先从环境变量读取，其次用默认值。
//
// ⚠️ 敏感项（`SIGN_MASTER_KEY`、`PRIVACY_SALT`）**必须显式提供**，
//    不允许有"方便开发"的默认值——否则生产部署会带着公开已知的密钥运行。

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname)

function envStr(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : String(v)
}
function envInt(name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 必须是数字，实际为 ${v}`)
  return Math.trunc(n)
}
function envBool(name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

/**
 * 载入或生成主密钥。
 *
 * ⚠️ 首次启动生成后写入 `data/master.key` 并 chmod 600。
 *    若该文件丢失，已签发的令牌与隐私盐全部失效（客户端需重新登录），
 *    但**不会影响余额与台账**——那些是明文存的钱，不依赖主密钥。
 */
function loadOrCreateMasterKey(dataDir) {
  const explicit = process.env.SIGN_MASTER_KEY
  if (explicit && explicit.length >= 32) return explicit

  const keyFile = path.join(dataDir, 'master.key')
  if (fs.existsSync(keyFile)) {
    const k = fs.readFileSync(keyFile, 'utf8').trim()
    if (k.length >= 32) return k
  }
  const generated = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(keyFile, generated, { mode: 0o600 })
  // eslint-disable-next-line no-console
  console.log(`[config] 已生成主密钥并写入 ${keyFile}（权限 600）。请务必备份，丢失后客户端需重新登录。`)
  return generated
}

function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir || envStr('DATA_DIR', path.join(ROOT, 'data'))

  const masterKey = overrides.masterKey || loadOrCreateMasterKey(dataDir)

  const cfg = {
    // ── 监听 ────────────────────────────────────────────────
    // ⚠️ 默认只绑回环。对外暴露必须经反向代理 + HTTPS，
    //    否则 token 与签名密钥会明文传输。
    host: overrides.host || envStr('HOST', '127.0.0.1'),
    port: overrides.port !== undefined ? Number(overrides.port) : envInt('PORT', 18080),

    // ── 数据 ────────────────────────────────────────────────
    dataDir,
    dbPath: overrides.dbPath || envStr('DB_PATH', path.join(dataDir, 'license.db')),

    // ── 密钥 ────────────────────────────────────────────────
    masterKey,
    privacySalt: overrides.privacySalt || envStr('PRIVACY_SALT', crypto.createHash('sha256')
      .update(`privacy|${masterKey}`).digest('hex').slice(0, 32)),
    privacySaltVersion: envInt('PRIVACY_SALT_VERSION', 1),

    // ── 协议 ────────────────────────────────────────────────
    protocolVersion: envInt('PROTOCOL_VERSION', 2),
    minClientVersion: envStr('MIN_CLIENT_VERSION', '3.0.0'),
    latestClientVersion: envStr('LATEST_CLIENT_VERSION', '3.1.0'),
    upgradeUrl: envStr('UPGRADE_URL', 'https://example.com/download'),

    // ── 安全 ────────────────────────────────────────────────
    deviceLimit: envInt('DEVICE_LIMIT', 1),
    loginFailLimit: envInt('LOGIN_FAIL_LIMIT', 5),
    loginLockMs: envInt('LOGIN_LOCK_MS', 600000),

    // ── 计费 ────────────────────────────────────────────────
    // ⚠️ 默认 1 积分/条。区间 0.1~1000（protocol.md §6.1）。
    creditPerReplyMilli: envInt('CREDIT_PER_REPLY_MILLI', 1000),
    // 仅 DOM 判据确认是否计费。**默认 false**——DOM 不是可信成功判据（红线 2）。
    billDomConfirmed: envBool('BILL_DOM_CONFIRMED', false),
    // 低余额告警阈值，单位是"还能发多少条"（部署指南 §3.1 的
    // `MIN_BALANCE_ALERT_REPLIES`，默认 500）。⚠️ 后台的"余额偏低"标记
    // 与 §8.3 的告警表都用它——两处各写一个数字迟早漂移。
    minBalanceAlertReplies: envInt('MIN_BALANCE_ALERT_REPLIES', 500),

    // ── 维护窗口 ────────────────────────────────────────────
    maintenanceActive: envBool('MAINTENANCE_ACTIVE', false),
    maintenanceMessage: envStr('MAINTENANCE_MESSAGE', ''),

    // ── 日志 ────────────────────────────────────────────────
    logLevel: envStr('LOG_LEVEL', 'info'),

    // ── 反代 ────────────────────────────────────────────────
    // ⚠️ 决定"客户端真实 IP"从哪里取，直接影响**后台 IP 白名单**与登录限流。
    //    · 反代后（Caddy/Nginx）→ 必须为 true，否则所有请求看起来都来自
    //      127.0.0.1，白名单形同虚设、限流把全平台算成一个人。
    //    · 直连（无反代）→ **必须为 false**。为 true 时攻击者只要自己加一个
    //      `X-Forwarded-For: <白名单里的 IP>` 就能绕过 IP 白名单。
    //    两个方向都会静默失效，所以这是一个必须显式想清楚的开关。
    trustProxy: envBool('TRUST_PROXY', false),

    // ── 管理后台 ────────────────────────────────────────────
    adminInitialPassword: envStr('ADMIN_INIT_PASSWORD', ''),

    // 后台路径前缀（`ADMIN_PATH`）。⚠️ **未设置即彻底关闭后台**——
    //    绝不给 `/admin` 这样的默认值。理由见部署指南 §9.3：
    //    后台是厂商侧最高危的暴露面，一个可猜的默认路径等于把它挂在公网上。
    //    空串归一成 null，让 server.js 只有一种"未启用"的表示。
    adminPath: normalizeAdminPath(envStr('ADMIN_PATH', '')),

    // 后台 IP 白名单（`ADMIN_IP_ALLOW`，逗号分隔的 IP 或 CIDR）。
    // ⚠️ 空列表 = **只允许回环**，不是"允许所有"。fail-safe 方向必须是拒绝：
    //    运维忘了配白名单时，后台应该连不上，而不是全网可访问。
    adminIpAllow: parseIpAllow(envStr('ADMIN_IP_ALLOW', '')),

    // 后台会话时长（`ADMIN_SESSION_TTL_HOURS`，默认 12 小时，见 §9.3）。
    adminSessionTtlHours: envInt('ADMIN_SESSION_TTL_HOURS', 12),

    // 后台 cookie 是否带 `Secure`。**默认 true**：§9.3 要求"必须公网可用时
    //    走 HTTPS"，而 Secure 是浏览器侧对"明文链路上别发这个 cookie"的唯一保证。
    //    只在"纯 HTTP 的 SSH 隧道 / 本机联调"场景下显式设 0——
    //    此时链路本身不出机器，Secure 会让浏览器直接不存这个 cookie。
    adminCookieSecure: envBool('ADMIN_COOKIE_SECURE', true),
  }

  validateConfig(cfg)
  return cfg
}

/**
 * 归一化后台路径前缀（`ADMIN_PATH`）。
 *
 * ⚠️ 返回 `null` 表示"后台未启用"，这是**唯一**的未启用表示。
 *    绝不在任何地方回退成 `/admin`——那等于给公网上的扫描器一个默认入口。
 *
 * 接受的写法：`/admin-7f3c91`、`admin-7f3c91`（自动补前导 `/`）。
 * 去掉尾随 `/`，因为下列两处都对尾随斜杠敏感：
 *   · cookie 的 `Path=` 属性
 *   · 路由挂载时的字符串拼接（会拼出 `//api/...`）
 */
function normalizeAdminPath(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim()
  if (v === '' || v === '/') return null
  const withSlash = v.startsWith('/') ? v : `/${v}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed === '' ? null : trimmed
}

/**
 * 解析后台 IP 白名单（`ADMIN_IP_ALLOW`，逗号分隔的 IP 或 CIDR）。
 *
 * ⚠️ 空串返回**只含回环的列表**，不是空数组。
 *    如果返回空数组并让上层解释成"不过滤"，那么"运维忘了配这一项"
 *    的直接后果就是后台对全网开放——而 §9.3 要求的正是相反的方向。
 *    语义写在这里，上层就不必再记得这条规则。
 */
function parseIpAllow(raw) {
  const items = String(raw === undefined || raw === null ? '' : raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (items.length === 0) return Object.freeze(['127.0.0.1/32', '::1/128'])
  return Object.freeze(items)
}

/**
 * 白名单条目形态检查（IP 或 CIDR）。
 *
 * ⚠️ 这里只做**启动期**的形态校验，不做匹配。
 *    真正的匹配在 `admin/api.js` 里（它需要拿到每个请求的实际 IP）。
 *    两处都要有：启动期拦住写错的 `.env`，请求期拦住不在名单里的来源。
 */
function isValidIpEntry(entry) {
  const s = String(entry)
  const slash = s.indexOf('/')
  const addr = slash < 0 ? s : s.slice(0, slash)
  const prefix = slash < 0 ? null : s.slice(slash + 1)

  if (!isIpLiteral(addr)) return false
  if (prefix === null) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  const n = Number(prefix)
  const maxBits = addr.includes(':') ? 128 : 32
  return n >= 0 && n <= maxBits
}

/** 是否为 IPv4 点分四段或含冒号的 IPv6 字面量。 */
function isIpLiteral(s) {
  if (typeof s !== 'string' || s === '') return false
  if (s.includes(':')) return /^[0-9a-fA-F:.]+$/.test(s)
  const parts = s.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function validateConfig(cfg) {
  const problems = []

  if (cfg.creditPerReplyMilli < 100 || cfg.creditPerReplyMilli > 1000000) {
    problems.push(`CREDIT_PER_REPLY_MILLI 必须在 100~1000000 之间（0.1~1000 积分/条），实际 ${cfg.creditPerReplyMilli}`)
  }
  if (cfg.deviceLimit < 1) problems.push('DEVICE_LIMIT 至少为 1')
  if (!/^\d+\.\d+\.\d+$/.test(cfg.minClientVersion)) {
    problems.push(`MIN_CLIENT_VERSION 必须是 x.y.z 格式，实际 ${cfg.minClientVersion}`)
  }
  if (cfg.masterKey.length < 32) {
    problems.push('masterKey 长度不足 32 字符——签名安全性不足')
  }
  // ── 管理后台 ────────────────────────────────────────────
  // ⚠️ 只校验"给了值之后是否合法"，**不校验"必须给"**。
  //    未配置 = 后台关闭，是合法且推荐的默认状态。
  if (cfg.adminPath !== null) {
    if (!/^\/[A-Za-z0-9._~-]+$/.test(cfg.adminPath)) {
      problems.push(
        `ADMIN_PATH 只允许"单段路径"形态（如 /admin-7f3c91），实际为 ${cfg.adminPath}。` +
        '路径里出现空格、问号、斜杠或百分号会让 cookie 的 Path 与路由拼接产生歧义。'
      )
    }
  }
  if (!Number.isFinite(cfg.adminSessionTtlHours) || cfg.adminSessionTtlHours <= 0) {
    problems.push(`ADMIN_SESSION_TTL_HOURS 必须是正整数小时，实际 ${cfg.adminSessionTtlHours}`)
  }
  for (const entry of cfg.adminIpAllow) {
    if (!isValidIpEntry(entry)) {
      problems.push(
        `ADMIN_IP_ALLOW 含无法解析的条目 "${entry}"。` +
        '只接受 IPv4/IPv6 地址或 CIDR（例如 127.0.0.1/32 或 10.0.0.0/8）。'
      )
    }
  }
  // ⚠️ 生产环境绑 0.0.0.0 是危险的：无 HTTPS 时 token 明文传输。
  //    这里只告警不阻断（本地开发可能需要），但必须显式可见。
  if (cfg.host === '0.0.0.0' && !envBool('ALLOW_PUBLIC_BIND', false)) {
    problems.push(
      '拒绝绑定 0.0.0.0：本服务不含 HTTPS，公网暴露会让 token 与签名密钥明文传输。' +
      '如需对外，请用反向代理 + HTTPS，并设置 ALLOW_PUBLIC_BIND=1 显式确认。'
    )
  }

  if (problems.length) {
    throw new Error('配置校验失败：\n  - ' + problems.join('\n  - '))
  }
}

module.exports = {
  loadConfig,
  validateConfig,
  normalizeAdminPath,
  parseIpAllow,
  isValidIpEntry,
  ROOT,
}
