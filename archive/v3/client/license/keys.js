'use strict'

// client/license/keys.js
//
// 签名密钥的生命周期管理（契约 §5.4 的"密钥轮换"部分）。
//
// ⚠️ 为什么单独一个模块：
//    轮换逻辑看起来只是"存一把新钥匙"，但漏掉任何一步都会产生**间歇性**故障——
//    只在轮换窗口内出现、只在部分请求上出现，且故障表现是"签名不匹配"，
//    排查者会先怀疑算法而不是密钥选择。所以把"该用哪把钥匙"收敛成一处纯函数。
//
// 契约要点（§5.4）：
//   · 心跳/续期响应可带 `sign_key_next` + `sign_key_next_effective_ms`
//   · 客户端对 `ts >= sign_key_next_effective_ms` 的请求改用新密钥
//   · 服务端按 next（已生效）→ current → prev 顺序尝试，重叠窗口 10 分钟
//
// ⚠️ 客户端**只需**保存两把：current 与 next（未生效的）。
//    已生效后 next 变成 current，旧的 current 变成 prev——但客户端**不需要**
//    主动发 prev 签名的请求（服务端只是"愿意接受"），所以不保留第三把，
//    减少密钥在盘上的留存面（红线 3 的最小化原则）。

const crypto = require('node:crypto')

/** 轮换重叠窗口（契约 §5.4）：服务端在此窗口内同时接受新旧密钥 */
const KEY_OVERLAP_MS = 10 * 60 * 1000

/**
 * 合并服务端下发的轮换信息。
 *
 * @param {object} cur      当前密钥状态
 * @param {object} resp     心跳/续期响应体（可能含 sign_key_next*）
 * @param {number} nowMs
 * @returns {{state: object, changed: boolean, reason: string|null}}
 */
function mergeRotation(cur, resp, nowMs) {
  const next = { ...cur }
  let changed = false
  let reason = null

  const nextKey = resp && resp.sign_key_next
  const nextAt = resp && resp.sign_key_next_effective_ms

  if (typeof nextKey === 'string' && nextKey.length === 64) {
    if (next.pendingKey !== nextKey || Number(next.pendingAtMs) !== Number(nextAt)) {
      next.pendingKey = nextKey
      next.pendingAtMs = Number(nextAt) || 0
      changed = true
      reason = 'rotation_received'
    }
  }

  // 生效：把 pending 提升为 current。
  // ⚠️ 判定用**服务端时间**而不是本地时间：本地时钟若偏快，会提前切到
  //    尚未生效的密钥，而服务端此时仍用旧密钥校验 → 签名全失败。
  if (next.pendingKey && Number(next.pendingAtMs) > 0 && nowMs >= Number(next.pendingAtMs)) {
    next.prevKey = next.key
    next.prevKeyExpiresAtMs = Number(next.pendingAtMs) + KEY_OVERLAP_MS
    next.key = next.pendingKey
    next.pendingKey = null
    next.pendingAtMs = 0
    changed = true
    reason = 'rotation_activated'
  }

  return { state: next, changed, reason }
}

/**
 * 选出为时刻 `tsMs` 签名应使用的密钥。
 *
 * ⚠️ 纯函数、无副作用：传输层每次请求都调它，必须便宜且可预测。
 *
 * @returns {{key: string|null, which: 'current'|'next'|'prev'|null}}
 */
function selectKey(state, tsMs) {
  if (!state || !state.key) return { key: null, which: null }

  // 未生效的新密钥：目标时刻已越过生效点才使用。
  // ⚠️ 要求 `tsMs >= pendingAtMs`，与契约"对 ts ≥ effective 的请求改用新密钥"一致。
  if (state.pendingKey && Number(state.pendingAtMs) > 0 && tsMs >= Number(state.pendingAtMs)) {
    return { key: state.pendingKey, which: 'next' }
  }

  return { key: state.key, which: 'current' }
}

/**
 * 密钥是否已过期（与 token 同寿命，契约 §5）。
 * 过期后必须重新登录——**不是**降级到不签名继续跑。
 */
function isKeyExpired(state, nowMs) {
  if (!state || !state.key) return true
  const exp = Number(state.keyExpiresAtMs || 0)
  return exp > 0 && nowMs >= exp
}

/**
 * 保护密钥不被日志打印。
 *
 * ⚠️ 契约 §5 明令"不得写入日志"。做法不是"记得别打"，而是让
 *    `JSON.stringify(state)` 本身就不含明文——这样任何一次
 *    `log.info('state', state)` 都不可能泄露。
 */
function redactKeyState(state) {
  if (!state) return null
  return {
    has_key: Boolean(state.key),
    key_fingerprint: state.key ? fingerprint(state.key) : null,
    key_expires_at_ms: Number(state.keyExpiresAtMs || 0),
    pending_at_ms: Number(state.pendingAtMs || 0),
    has_pending: Boolean(state.pendingKey),
  }
}

/** 密钥指纹：前 8 位 sha256。足以比对"是不是同一把"，无法反推密钥。 */
function fingerprint(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 8)
}

module.exports = {
  KEY_OVERLAP_MS,
  mergeRotation,
  selectKey,
  isKeyExpired,
  redactKeyState,
  fingerprint,
}
