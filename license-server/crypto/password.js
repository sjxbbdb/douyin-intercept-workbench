'use strict'

// license-server/crypto/password.js
//
// 密码哈希。用 Node 内置 scrypt，不引入额外依赖。
//
// ⚠️ 三条硬要求：
//   1. **禁止明文或可逆加密存储密码**
//   2. 每个密码独立随机盐（不是全局盐）
//   3. 校验必须用**定时安全比较**，防止通过响应时间差推断密码

const crypto = require('node:crypto')

// scrypt 参数。N 越大越慢越安全，但登录会变慢。
// N=2^15 在普通 VPS 上约 100ms，对登录接口可接受。
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32
const SALT_LEN = 16
// ⚠️ scrypt 的内存上限必须显式给足，否则 N=2^15 会报 "memory limit exceeded"
const MAX_MEM = 64 * 1024 * 1024

/** 存储格式：scrypt$N$r$p$<salt-hex>$<hash-hex>。自带参数，便于日后升级强度。 */
function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('密码必须是非空字符串')
  }
  const salt = crypto.randomBytes(SALT_LEN)
  const hash = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  })
  return [
    'scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString('hex'), hash.toString('hex'),
  ].join('$')
}

/**
 * 校验密码。定时安全比较。
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt, expected
  try {
    salt = Buffer.from(parts[4], 'hex')
    expected = Buffer.from(parts[5], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N, r, p, maxmem: MAX_MEM,
    })
  } catch {
    return false // 参数异常（如被篡改成超大 N）→ 视为校验失败，不抛给调用方
  }

  // ⚠️ 定时安全比较。用 === 会因为提前返回而泄露信息（虽然哈希比较的
  //    时序攻击难度高，但没有理由不用正确的方式）
  return crypto.timingSafeEqual(actual, expected)
}

/** 生成随机密码（厂商开号时用）。避免易混淆字符。 */
function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

module.exports = { hashPassword, verifyPassword, generatePassword }
