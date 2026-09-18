'use strict'

// license-server/api/routes-auth.js
//
// 认证相关路由：bootstrap / login / refresh / logout / me。
//
// 登录是整个系统里最敏感的一环：
//   · 密码必须是 scrypt 哈希比对（不是明文）
//   · 账号不存在与密码错误在**响应上不可区分**（防账号枚举）
//   · 连续失败要锁定（防暴力破解）
//   · 响应必须带 login_proof（防登录响应被篡改）

const { AppError } = require('../../shared/lib/errors')
const { hashPassword, verifyPassword } = require('../crypto/password')
const {
  generateToken, generateSignKey, sha256Hex, buildLoginProof,
} = require('../crypto/sign')
const { buildPolicy, deriveDayIndex, planCreditsFor, minPlanCredit } = require('../domain/policy')
const { buildQuotaNotice } = require('./quota-notice')

/** 登录失败阈值与锁定时长（protocol.md §1.4） */
const LOGIN_FAIL_LIMIT = 5
const LOGIN_LOCK_MS = 600000 // 10 分钟

/** 会话有效期 7 天 */
const TOKEN_TTL_MS = 604800000

/**
 * 账号不存在与密码错误返回**同一个**错误码与文案。
 *
 * ⚠️ 这是刻意的：若区分两者，攻击者可用"账号不存在"快速枚举出
 *    哪些账号已开通，为后续撞库提供目标。契约的
 *    `AUTH_ACCOUNT_NOT_FOUND` 状态码是 401 而非 404，正是同一考虑。
 */
const GENERIC_LOGIN_FAILURE = () => new AppError('AUTH_PASSWORD_WRONG', '账号或密码错误')

// ═══════════════════════════════════════════════════════════
// GET /client/bootstrap —— 无需鉴权、不签名
// ═══════════════════════════════════════════════════════════

function bootstrap(ctx) {
  const { query, config, nowMs } = ctx
  const clientVersion = String(query.client_version || '')
  const protocolVersion = Number(query.protocol_version || 0)

  if (protocolVersion && protocolVersion > config.protocolVersion) {
    throw new AppError('SERVER_VERSION_UNSUPPORTED',
      `客户端协议版本 ${protocolVersion} 高于服务端支持的 ${config.protocolVersion}，请升级服务端`)
  }

  const forceUpgrade = compareVersion(clientVersion, config.minClientVersion) < 0

  return {
    ok: true,
    server_time_ms: nowMs,
    protocol_version: config.protocolVersion,
    min_client_version: config.minClientVersion,
    latest_client_version: config.latestClientVersion,
    force_upgrade: forceUpgrade,
    upgrade_url: config.upgradeUrl,
    maintenance: { active: config.maintenanceActive, message: config.maintenanceMessage },
    credit_per_reply_milli: config.creditPerReplyMilli,
    limits: {
      heartbeat_interval_ms: 60000,
      sign_ts_tolerance_ms: 300000,
      audit_batch_max: 500,
      config_audit_batch_max: 200,
      max_body_bytes: 2 * 1024 * 1024,
    },
  }
}

/** 语义化版本比较。返回 -1 / 0 / 1。 */
function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => Number(x) || 0)
  const pb = String(b || '0').split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// ═══════════════════════════════════════════════════════════
// POST /auth/login
// ═══════════════════════════════════════════════════════════

function login(ctx) {
  const { db, body, nowMs, config, log } = ctx

  const account = String(body.account || '').trim()
  const password = String(body.password || '')
  const deviceId = String(body.device_id || '').trim()
  const instanceId = String(body.instance_id || deviceId || '').trim()

  if (!account || !password) {
    throw new AppError('AUTH_INVALID_REQUEST', '账号与密码均为必填')
  }
  if (!deviceId) {
    throw new AppError('AUTH_INVALID_REQUEST', '缺少 device_id')
  }

  // ── 锁定检查（在查账号之前，避免用锁定状态区分账号是否存在）
  const attempt = db.prepare('SELECT * FROM login_attempt WHERE account = ?').get(account)
  if (attempt && attempt.locked_until_ms && Number(attempt.locked_until_ms) > nowMs) {
    const waitSec = Math.ceil((Number(attempt.locked_until_ms) - nowMs) / 1000)
    throw new AppError('AUTH_ACCOUNT_LOCKED', `登录失败次数过多，请 ${waitSec} 秒后重试`, {
      locked_until_ms: Number(attempt.locked_until_ms),
    })
  }

  const acc = db.prepare('SELECT * FROM account WHERE account = ?').get(account)

  // ⚠️ 账号不存在时也要走一次哈希比对，使**响应时间不泄露账号是否存在**
  //    （时序侧信道）。用一个固定假哈希，成本与真实比对相当。
  const storedHash = acc ? acc.pass_hash : DUMMY_HASH
  const passOk = verifyPassword(password, storedHash)

  if (!acc || !passOk) {
    recordLoginFailure(db, account, nowMs)
    if (log) log.warn('login_failed', { account, has_account: Boolean(acc) })
    throw GENERIC_LOGIN_FAILURE()
  }

  if (acc.status === 'disabled') throw new AppError('AUTH_ACCOUNT_DISABLED', '账号已停用，请联系客服')
  if (acc.status === 'expired') throw new AppError('AUTH_ACCOUNT_EXPIRED', '账号或套餐已到期，请联系客服续费')
  if (acc.plan_expires_ms && Number(acc.plan_expires_ms) < nowMs) {
    db.prepare("UPDATE account SET status='expired', updated_at_ms=? WHERE account_id=?")
      .run(nowMs, acc.account_id)
    throw new AppError('AUTH_ACCOUNT_EXPIRED', '套餐已到期，请联系客服续费')
  }

  // ── 首次登录：记录起点，等级天数由它推导
  let firstLoginMs = Number(acc.first_login_ms || 0)
  if (!firstLoginMs) {
    firstLoginMs = nowMs
    db.prepare('UPDATE account SET first_login_ms = ?, updated_at_ms = ? WHERE account_id = ?')
      .run(firstLoginMs, nowMs, acc.account_id)
  }

  // ── 设备数上限（超限踢最早会话）
  enforceDeviceLimit(db, acc, deviceId, nowMs, config.deviceLimit)

  // ── 签发令牌与会话密钥
  const token = generateToken()
  const signKey = generateSignKey()
  const expiresAt = nowMs + TOKEN_TTL_MS

  db.prepare(`
    INSERT INTO device_session (
      account_id, device_id, token_hash, sign_key_hash, sign_key_plain,
      issued_at_ms, last_seen_ms, expires_at_ms
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    acc.account_id, deviceId, sha256Hex(token), sha256Hex(signKey), signKey,
    nowMs, nowMs, expiresAt
  )

  // 登录成功 → 清除失败计数
  db.prepare('DELETE FROM login_attempt WHERE account = ?').run(account)

  // ── 策略与额度
  const policyVersion = currentPolicyVersion(db)
  const dayIndex = deriveDayIndex(firstLoginMs, nowMs)
  const policy = buildPolicy({
    accountId: acc.account_id, accountDayIndex: dayIndex, policyVersion, nowMs,
  })

  const credit = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(acc.account_id)
  const balanceMilli = credit ? Number(credit.balance_milli) : 0
  const plan = acc.plan_id
    ? db.prepare('SELECT * FROM plan WHERE plan_id = ?').get(acc.plan_id)
    : null

  const quotaNotice = buildQuotaNotice({
    policy, config, plan, balanceMilli, nowMs,
  })

  const responseBody = {
    ok: true,
    protocol_version: config.protocolVersion,
    token,
    token_expires_ms: expiresAt,
    sign_key: signKey,
    sign_key_expires_ms: expiresAt,
    privacy_salt: config.privacySalt,
    privacy_salt_version: config.privacySaltVersion,
    account: {
      account_id: `acc_${acc.account_id}`,
      display_name: acc.display_name || acc.account,
      status: acc.status,
      plan_id: plan ? plan.plan_key : null,
      plan_expires_ms: acc.plan_expires_ms ? Number(acc.plan_expires_ms) : null,
      device_limit: Number(acc.device_limit || config.deviceLimit),
    },
    credit: {
      balance_milli: balanceMilli,
      credit_per_reply_milli: config.creditPerReplyMilli,
      updated_at_ms: nowMs,
    },
    policy,
    quota_notice: quotaNotice,
    limits: {
      heartbeat_interval_ms: 60000,
      send_batch_interval_ms: 300000,
      send_batch_max: 50,
      audit_batch_max: 500,
      config_audit_batch_max: 200,
      max_pending_sends: 20000,
      sign_ts_tolerance_ms: 300000,
      nonce_ttl_ms: 600000,
      offline_send_grace_ms: 900000,
    },
    min_client_version: config.minClientVersion,
    force_upgrade: compareVersion(body.client_version, config.minClientVersion) < 0,
    upgrade_url: config.upgradeUrl,
    kicked_device_id: ctx.kickedDeviceId || null,
    instance_id: instanceId,
  }

  // ⚠️ login_proof：登录响应自身携带 sign_key，无法用它给自己签名。
  //    改用密码派生密钥，客户端用同一派生方式复算即可确认响应未被篡改。
  responseBody.login_proof = buildLoginProof(password, account, deviceId, responseBody)

  if (log) log.info('login_ok', { account, device_id: deviceId, tier: policy.account_tier })
  return responseBody
}

/** 账号不存在时用于时序对齐的固定哈希（对应一个随机密码，永不匹配）。 */
const DUMMY_HASH = hashPassword('dummy-password-for-timing-equalization')

function recordLoginFailure(db, account, nowMs) {
  const row = db.prepare('SELECT * FROM login_attempt WHERE account = ?').get(account)
  const failCount = (row ? Number(row.fail_count) : 0) + 1
  const lockedUntil = failCount >= LOGIN_FAIL_LIMIT ? nowMs + LOGIN_LOCK_MS : null
  db.prepare(`
    INSERT INTO login_attempt (account, fail_count, locked_until_ms, last_fail_ms)
    VALUES (?,?,?,?)
    ON CONFLICT(account) DO UPDATE SET fail_count = excluded.fail_count,
                                       locked_until_ms = excluded.locked_until_ms,
                                       last_fail_ms = excluded.last_fail_ms
  `).run(account, failCount, lockedUntil, nowMs)
}

/**
 * 并发设备数上限。
 * ⚠️ 超限时踢**最早活跃**的会话（而不是最新的），保证当前登录成功。
 *    若踢不动（例如同设备重复登录），抛 AUTH_DEVICE_LIMIT。
 */
function enforceDeviceLimit(db, acc, deviceId, nowMs, defaultLimit) {
  const limit = Number(acc.device_limit || defaultLimit || 1)
  const live = db.prepare(`
    SELECT id, device_id, last_seen_ms FROM device_session
    WHERE account_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
    ORDER BY last_seen_ms ASC
  `).all(acc.account_id, nowMs)

  // 同设备重复登录：直接吊销旧会话（不算新增设备）
  const sameDevice = live.filter((s) => s.device_id === deviceId)
  for (const s of sameDevice) {
    db.prepare('UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ? WHERE id = ?')
      .run(nowMs, 'replaced_by_new_login', s.id)
  }

  const others = live.filter((s) => s.device_id !== deviceId)
  if (others.length >= limit) {
    // 踢最早的，直到剩余数 < limit
    const need = others.length - limit + 1
    for (let i = 0; i < need && i < others.length; i++) {
      db.prepare('UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ? WHERE id = ?')
        .run(nowMs, 'kicked_by_device_limit', others[i].id)
    }
  }
}

/** 当前全局策略版本。取 policy 表中全局行的版本，默认 1。 */
function currentPolicyVersion(db) {
  const row = db.prepare('SELECT policy_version FROM policy WHERE account_id IS NULL').get()
  return row ? Number(row.policy_version) : 1
}

// ═══════════════════════════════════════════════════════════
// POST /auth/refresh
// ═══════════════════════════════════════════════════════════

function refresh(ctx) {
  const { db, session, body, nowMs, config } = ctx

  const newToken = generateToken()
  const newKey = generateSignKey()
  const expiresAt = nowMs + TOKEN_TTL_MS

  db.prepare(`
    UPDATE device_session
    SET token_hash = ?, sign_key_hash = ?, sign_key_plain = ?,
        issued_at_ms = ?, last_seen_ms = ?, expires_at_ms = ?,
        revoked_reason = NULL, revoked_at_ms = NULL
    WHERE id = ?
  `).run(sha256Hex(newToken), sha256Hex(newKey), newKey, nowMs, nowMs, expiresAt, session.id)

  const dayIndex = deriveDayIndex(Number(session.first_login_ms || nowMs), nowMs)
  const policy = buildPolicy({
    accountId: session.account_id, accountDayIndex: dayIndex,
    policyVersion: currentPolicyVersion(db), nowMs,
  })
  const credit = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(session.account_id)

  return {
    ok: true,
    protocol_version: config.protocolVersion,
    token: newToken,
    token_expires_ms: expiresAt,
    sign_key: newKey,
    sign_key_expires_ms: expiresAt,
    privacy_salt: config.privacySalt,
    privacy_salt_version: config.privacySaltVersion,
    account: {
      account_id: `acc_${session.account_id}`,
      display_name: session.display_name || session.account,
      status: session.account_status,
      plan_expires_ms: session.plan_expires_ms ? Number(session.plan_expires_ms) : null,
    },
    credit: {
      balance_milli: credit ? Number(credit.balance_milli) : 0,
      credit_per_reply_milli: config.creditPerReplyMilli,
      updated_at_ms: nowMs,
    },
    policy,
    prev_token_expires_ms: Number(session.expires_at_ms),
  }
}

// ═══════════════════════════════════════════════════════════
// POST /auth/logout
// ═══════════════════════════════════════════════════════════

function logout(ctx) {
  const { db, session, body, nowMs } = ctx
  const reason = String(body.reason || 'user_logout')
  const r = db.prepare(`
    UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ?
    WHERE id = ? AND revoked_at_ms IS NULL
  `).run(nowMs, reason, session.id)
  return { ok: true, revoked_session_count: Number(r.changes || 0) }
}

// ═══════════════════════════════════════════════════════════
// GET /auth/me
// ═══════════════════════════════════════════════════════════

function me(ctx) {
  const { db, session, nowMs, config } = ctx
  const dayIndex = deriveDayIndex(Number(session.first_login_ms || nowMs), nowMs)
  const policy = buildPolicy({
    accountId: session.account_id, accountDayIndex: dayIndex,
    policyVersion: currentPolicyVersion(db), nowMs,
  })
  const credit = db.prepare('SELECT * FROM credit WHERE account_id = ?').get(session.account_id)
  const billing = db.prepare('SELECT state FROM account_billing WHERE account_id = ?').get(session.account_id)

  return {
    ok: true,
    account: {
      account_id: `acc_${session.account_id}`,
      display_name: session.display_name || session.account,
      status: session.account_status,
      plan_expires_ms: session.plan_expires_ms ? Number(session.plan_expires_ms) : null,
    },
    credit: {
      balance_milli: credit ? Number(credit.balance_milli) : 0,
      credit_per_reply_milli: config.creditPerReplyMilli,
      replies_affordable: Math.floor(
        (credit ? Number(credit.balance_milli) : 0) / config.creditPerReplyMilli
      ),
      updated_at_ms: credit ? Number(credit.updated_at_ms) : nowMs,
    },
    billing_state: billing ? billing.state : 'active',
    policy_summary: {
      policy_version: policy.policy_version,
      account_tier: policy.account_tier,
      account_day_index: policy.account_day_index,
      sending_enabled: policy.sending_enabled,
      daily_cap_total: Object.values(policy.limits).reduce((s, l) => s + l.daily_max, 0),
    },
    last_heartbeat_ms: Number(session.last_seen_ms),
  }
}

module.exports = {
  LOGIN_FAIL_LIMIT,
  LOGIN_LOCK_MS,
  TOKEN_TTL_MS,
  bootstrap,
  login,
  refresh,
  logout,
  me,
  compareVersion,
}
