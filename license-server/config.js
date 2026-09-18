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

    // ── 维护窗口 ────────────────────────────────────────────
    maintenanceActive: envBool('MAINTENANCE_ACTIVE', false),
    maintenanceMessage: envStr('MAINTENANCE_MESSAGE', ''),

    // ── 日志 ────────────────────────────────────────────────
    logLevel: envStr('LOG_LEVEL', 'info'),

    // ── 管理后台 ────────────────────────────────────────────
    adminInitialPassword: envStr('ADMIN_INIT_PASSWORD', ''),
  }

  validateConfig(cfg)
  return cfg
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

module.exports = { loadConfig, validateConfig, ROOT }
