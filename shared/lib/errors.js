'use strict'

// shared/lib/errors.js
// 双端共享的错误码与归因码。
//
// ⚠️ 本文件是错误码的**唯一来源**。新增错误码必须同时更新：
//   · shared/protocol.md §3（契约表格）
//   · test/contract/consistency.test.js 会校验代码与契约一致
//
// 命名规则：<域>_<具体原因>，全大写蛇形。
//   AUTH_*    认证与会话
//   PLAN_*    套餐
//   CREDIT_*  积分与台账
//   POLICY_*  安全策略（红线 1）
//   AUDIT_*   审计上报（红线 3）
//   REPORT_*  聚合上报
//   RATE_*    限流
//   SERVER_*  服务端自身

// ⚠️ FAILURE_REASONS 与 PLATFORM_ENDPOINTS 是**闭集枚举**，唯一来源是
//    shared/lib/protocol.js。此处只做转出，**不得另行定义**——两份定义
//    迟早漂移，而闭集一旦漂移，上报校验会放行契约里不存在的值。
const { FAILURE_REASONS, PLATFORM_ENDPOINTS } = require('./protocol')

/** HTTP 状态码约定：业务结果用 200，真正的错误用 4xx/5xx。 */
const ERROR_CODES = Object.freeze({
  // ── 认证与会话 ────────────────────────────────────────────
  // ⚠️ 状态码必须与 shared/protocol.md §3.2 逐项一致，
  //    test/contract/consistency.test.js 会双向校验。
  AUTH_INVALID_REQUEST: 400,
  // ⚠️ 账号不存在的状态码是 **401 而非 404**。契约如此规定是为了
  //    **不让攻击者通过状态码枚举出哪些账号存在**（用户枚举防护）。
  //    响应文案统一为"账号或密码错误"。
  AUTH_ACCOUNT_NOT_FOUND: 401,
  AUTH_PASSWORD_WRONG: 401,
  AUTH_ACCOUNT_LOCKED: 423,
  AUTH_ACCOUNT_DISABLED: 403,
  AUTH_ACCOUNT_EXPIRED: 403,
  AUTH_FORBIDDEN: 403, // 无权访问该资源（与停用/到期同属 403）
  AUTH_DEVICE_LIMIT: 409,
  AUTH_TOKEN_MISSING: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_REVOKED: 401,
  AUTH_REPLAY: 401,
  AUTH_SIGN_MISSING: 401,
  AUTH_SIGN_INVALID: 401,
  // ⚠️ 时间戳偏离用 AUTH_TS_SKEW（语义比"签名过期"更准）。
  //    客户端收到后应用 server_time_ms 校准并**只重试一次**。
  AUTH_TS_SKEW: 401,
  AUTH_SIGN_KEY_UNKNOWN: 401,

  // ── 套餐 ──────────────────────────────────────────────────
  PLAN_NOT_FOUND: 404,
  PLAN_QUOTA_BELOW_MIN: 400,
  PLAN_INVALID_DURATION: 400,
  PLAN_ALREADY_ACTIVE: 409,

  // ── 积分与台账 ────────────────────────────────────────────
  CREDIT_EXHAUSTED: 402,
  // ⚠️ 状态码是 402（Payment Required）而非 403。语义是"欠费超宽限期，账号停用"，
  //    客户端应停机但**保留充值入口**。
  CREDIT_ACCOUNT_SUSPENDED: 402,
  CREDIT_REDEEM_CODE_INVALID: 404,
  CREDIT_REDEEM_CODE_USED: 409,
  CREDIT_REDEEM_CODE_EXPIRED: 410,
  CREDIT_REDEEM_CODE_DISABLED: 403,
  CREDIT_REDEEM_ALREADY_DONE: 200, // 幂等命中，属正常结果
  CREDIT_LEDGER_NOT_FOUND: 404,
  CREDIT_INSUFFICIENT: 402,

  // ── 安全策略（红线 1）────────────────────────────────────
  // ⚠️ POLICY_VIOLATION 的含义是"客户端上报的配置比服务端策略更激进"
  //    （上限更高 / 间隔更短 / 相似度阈值更高 / 时段更长），不是"配置非法"。
  POLICY_VIOLATION: 409,
  POLICY_VERSION_UNKNOWN: 409,
  POLICY_TIER_UNKNOWN: 400,
  POLICY_ACK_REQUIRED: 409,
  POLICY_SENDING_DISABLED: 409,
  POLICY_DAILY_CAP_EXCEEDED: 200, // 业务结果：该条不计费，但不是错误
  POLICY_CIRCUIT_OPEN: 409,

  // ── 审计上报（红线 3）────────────────────────────────────
  AUDIT_SEND_INVALID: 400,
  AUDIT_CONFIG_INVALID: 400, // 配置审计字段缺失/枚举非法/含禁用字段
  AUDIT_SEND_CONFLICT: 409,
  AUDIT_BATCH_TOO_LARGE: 413,
  REPORT_INVALID: 400,
  REPORT_PRIVACY_VIOLATION: 400,
  REPORT_TOO_LARGE: 413, // 批量条数超上限，或请求体 > 2 MB
  REPORT_ID_REUSED: 409,

  // ── 限流 ──────────────────────────────────────────────────
  RATE_TOO_MANY_REQUESTS: 429,

  // ── 服务端自身 ────────────────────────────────────────────
  SERVER_VERSION_UNSUPPORTED: 426,
  SERVER_INTERNAL: 500,
  SERVER_NOT_IMPLEMENTED: 501,
  SERVER_DB_BUSY: 503,
  SERVER_UNAVAILABLE: 503, // 维护中；客户端进入离线降级，明细囤本地后补报
})


/**
 * 结构化应用错误。
 *
 * ⚠️ 禁止用裸 Error 表达业务失败——那样无法归因（违反稳定指标 S-3 可观测）。
 * 每个抛出点都必须能回答"哪个阶段、什么原因"。
 */
class AppError extends Error {
  /**
   * @param {string} code   必须是 ERROR_CODES 中的键
   * @param {string} message 面向人的说明（中文，可直接展示给商家）
   * @param {object} [detail] 结构化上下文；⚠️ 不得含隐私原文（评论/回复/sec_uid）
   */
  constructor(code, message, detail) {
    if (!(code in ERROR_CODES)) {
      throw new Error(`未知错误码 ${code}：请先在 shared/lib/errors.js 与 protocol.md §3 中登记`)
    }
    super(message || code)
    this.name = 'AppError'
    this.code = code
    this.status = ERROR_CODES[code]
    this.detail = detail === undefined ? null : detail
    this.expose = true // 可安全返回给客户端
  }

  toEnvelope() {
    const out = { ok: false, code: this.code, message: this.message }
    if (this.detail !== null) out.detail = this.detail
    return out
  }
}

/** 是否为已登记的错误码。 */
function isKnownErrorCode(code) {
  return typeof code === 'string' && code in ERROR_CODES
}

/** 该错误码的 HTTP 状态。未登记则抛错——不给默认值，避免静默放过笔误。 */
function statusOf(code) {
  if (!isKnownErrorCode(code)) throw new Error(`未知错误码 ${code}`)
  return ERROR_CODES[code]
}

module.exports = {
  ERROR_CODES,
  FAILURE_REASONS,
  PLATFORM_ENDPOINTS,
  AppError,
  isKnownErrorCode,
  statusOf,
}
