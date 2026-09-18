'use strict'

// license-server/api/logger.js
//
// 结构化日志。
//
// ⚠️ 脱敏是硬要求（shared/开发规范.md §三）：
//   绝不记录 Cookie、Token、密码、完整手机号、sec_uid 原文、评论原文。
//   本模块提供 scrub() 统一处理，调用方不必逐个记得。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** 需要脱敏的字段名（小写匹配）。 */
const SENSITIVE_KEYS = Object.freeze([
  'password', 'pass', 'passwd', 'pwd', 'token', 'sign_key', 'signkey',
  'cookie', 'authorization', 'secret', 'master_key', 'masterkey',
  'privacy_salt', 'sec_uid', 'secuid', 'phone', 'mobile',
  'text', 'content', 'reply_text', 'comment_text', 'raw',
  'nickname', 'nick', 'avatar_url', 'profile_url',
])

/**
 * 递归脱敏。
 * ⚠️ 值也要检查——有些字段名看不出敏感（如 `detail.reply`）。
 */
function scrub(value, depth = 0) {
  if (depth > 6) return '[deep]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.includes(k.toLowerCase())) {
        out[k] = '[redacted]'
      } else {
        out[k] = scrub(v, depth + 1)
      }
    }
    return out
  }
  return String(value)
}

/** 长字符串截断 + 疑似凭据自动脱敏。 */
function scrubString(s) {
  if (s.length > 200) return s.slice(0, 200) + `…(${s.length})`
  // 32+ 位连续 hex 或 base64 形态 → 疑似令牌/密钥
  if (/^[0-9a-f]{32,}$/i.test(s)) return '[redacted-hex]'
  // 手机号
  if (/^1[3-9]\d{9}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-2)
  return s
}

class Logger {
  constructor(level = 'info', sink = process.stdout) {
    this.threshold = LEVELS[level] || LEVELS.info
    this.sink = sink
  }

  log(level, event, fields) {
    if ((LEVELS[level] || 0) < this.threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(fields === undefined ? {} : scrub(fields)),
    })
    this.sink.write(line + '\n')
  }

  debug(e, f) { this.log('debug', e, f) }
  info(e, f) { this.log('info', e, f) }
  warn(e, f) { this.log('warn', e, f) }
  error(e, f) { this.log('error', e, f) }
}

module.exports = { Logger, scrub, scrubString, SENSITIVE_KEYS, LEVELS }
