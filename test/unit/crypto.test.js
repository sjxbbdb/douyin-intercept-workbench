'use strict'

// test/unit/crypto.test.js
// 加密模块测试：密码哈希与 HMAC 签名。
//
// ⚠️ 这两块的错误后果最严重：
//   · 密码哈希写错 → 密码可被还原或无法登录
//   · 签名写错 → 全部请求被判无效（fail-closed 停机）
//
// ⚠️ 本文件按契约 §5.1 / §5.2 的 **header 式签名**编写：
//    签名字段走 X-Lic-Ts / X-Lic-Nonce / X-Lic-Sign，
//    签名覆盖 sha256(原始字节) 且路径含 query。

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

const { hashPassword, verifyPassword, generatePassword } = require('../../license-server/crypto/password')
const S = require('../../license-server/crypto/sign')

/** 生成一个合法 nonce（16~64 位 hex，契约 §5.1）。 */
function nonce() {
  return crypto.randomBytes(16).toString('hex')
}

// ══════════════════════════════════════════════════════════
// 密码哈希
// ══════════════════════════════════════════════════════════

test('密码：哈希结果不含明文', () => {
  const h = hashPassword('MySecret123')
  assert.ok(!h.includes('MySecret123'), '哈希中不得出现明文')
  assert.match(h, /^scrypt\$/)
})

test('密码：同一密码两次哈希不同（每次独立随机盐）', () => {
  const a = hashPassword('same-password')
  const b = hashPassword('same-password')
  assert.notStrictEqual(a, b, '盐必须每次随机，否则相同密码哈希相同')
  assert.ok(verifyPassword('same-password', a))
  assert.ok(verifyPassword('same-password', b))
})

test('密码：存储格式自带参数，便于日后升级强度', () => {
  const h = hashPassword('x')
  const parts = h.split('$')
  assert.strictEqual(parts.length, 6)
  assert.strictEqual(parts[0], 'scrypt')
  assert.ok(Number(parts[1]) >= 1 << 14, 'N 不应过小')
  assert.match(parts[4], /^[0-9a-f]+$/, '盐为 hex')
  assert.match(parts[5], /^[0-9a-f]+$/, '哈希为 hex')
})

test('密码：校验正确/错误密码', () => {
  const h = hashPassword('correct-horse')
  assert.strictEqual(verifyPassword('correct-horse', h), true)
  assert.strictEqual(verifyPassword('wrong-horse', h), false)
  assert.strictEqual(verifyPassword('', h), false)
  assert.strictEqual(verifyPassword('correct-horse ', h), false, '末尾空格应导致失败')
})

test('密码：拒绝非法输入而不抛异常', () => {
  const h = hashPassword('x')
  assert.strictEqual(verifyPassword(null, h), false)
  assert.strictEqual(verifyPassword(undefined, h), false)
  assert.strictEqual(verifyPassword(123, h), false)
  assert.strictEqual(verifyPassword('x', null), false)
  assert.strictEqual(verifyPassword('x', ''), false)
})

test('密码：哈希被篡改/损坏时返回 false，不抛异常', () => {
  const h = hashPassword('x')
  const parts = h.split('$')
  const tampered = [...parts]
  tampered[5] = tampered[5].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
  assert.strictEqual(verifyPassword('x', tampered.join('$')), false)
  assert.strictEqual(verifyPassword('x', 'garbage'), false)
  assert.strictEqual(verifyPassword('x', 'scrypt$1$2$3$4'), false)
  assert.strictEqual(verifyPassword('x', 'bcrypt$1$2$3$ab$cd'), false)
})

test('密码：被篡改成超大 N 时返回 false（不拖垮服务）', () => {
  const h = hashPassword('x')
  const parts = h.split('$')
  parts[1] = String(1 << 30) // 恶意放大计算量
  assert.strictEqual(verifyPassword('x', parts.join('$')), false)
})

test('密码：hashPassword 拒绝空密码', () => {
  assert.throws(() => hashPassword(''), TypeError)
  assert.throws(() => hashPassword(null), TypeError)
  assert.throws(() => hashPassword(undefined), TypeError)
})

test('密码：generatePassword 长度与字符集合规', () => {
  const p = generatePassword(20)
  assert.strictEqual(p.length, 20)
  assert.match(p, /^[A-Za-z0-9]+$/)
  assert.ok(!/[0O1lI]/.test(p), '不应含易混淆字符 0/O/1/l/I')
  assert.notStrictEqual(generatePassword(16), generatePassword(16))
})

// ══════════════════════════════════════════════════════════
// 请求签名（契约 §5.1）
// ══════════════════════════════════════════════════════════

test('签名：HMAC 对相同输入确定', () => {
  const k = S.generateSignKey()
  assert.strictEqual(S.hmacHex(k, 'payload'), S.hmacHex(k, 'payload'))
})

test('签名：不同密钥产出不同签名', () => {
  const a = S.hmacHex(S.generateSignKey(), 'p')
  const b = S.hmacHex(S.generateSignKey(), 'p')
  assert.notStrictEqual(a, b)
})

test('签名：请求签名串严格按契约 §5.1 拼接', () => {
  const s = S.buildRequestSignString({
    method: 'post',
    pathWithQuery: '/api/v1/audit/sends?x=1',
    ts: 1758096060000,
    nonce: 'abcdef0123456789',
    rawBody: '{"a":1}',
  })
  const expected = [
    'POST',
    '/api/v1/audit/sends?x=1',
    '1758096060000',
    'abcdef0123456789',
    S.sha256Hex('{"a":1}'),
  ].join('\n')
  assert.strictEqual(s, expected)
})

test('签名：签的是原始字节哈希，而非重新序列化的对象', () => {
  // ⚠️ 最容易出错的地方：若两端各自 JSON.stringify，
  //    key 顺序或空格差异会让签名不一致。
  const base = { method: 'POST', pathWithQuery: '/p', ts: 1, nonce: 'aa'.repeat(8) }
  assert.notStrictEqual(
    S.buildRequestSignString({ ...base, rawBody: '{"a":1,"b":2}' }),
    S.buildRequestSignString({ ...base, rawBody: '{"b":2,"a":1}' }),
    '字节不同 → 签名必须不同（不做规范化）'
  )
})

test('签名：无 body 时按空字节哈希 sha256("")', () => {
  const s = S.buildRequestSignString({
    method: 'GET', pathWithQuery: '/api/v1/auth/me', ts: 1, nonce: 'aa'.repeat(8), rawBody: '',
  })
  assert.strictEqual(
    s.split('\n')[4],
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '空体哈希必须是 sha256("")'
  )
})

test('签名：路径必须含 query（否则可在参数上做手脚）', () => {
  const base = { method: 'GET', ts: 1, nonce: 'aa'.repeat(8), rawBody: '' }
  assert.notStrictEqual(
    S.buildRequestSignString({ ...base, pathWithQuery: '/api/v1/credit/ledger?granularity=raw' }),
    S.buildRequestSignString({ ...base, pathWithQuery: '/api/v1/credit/ledger' }),
    'query 不同 → 签名必须不同'
  )
})

test('签名：verifyRequestSignature 正确通过', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const p = {
    method: 'POST', pathWithQuery: '/api/v1/audit/sends',
    ts: now, nonce: nonce(), rawBody: '{"x":1}',
  }
  const signature = S.signRequest({ signKey: key, ...p })
  const r = S.verifyRequestSignature({ signKey: key, ...p, signature, nowMs: now })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.ts, now)
})

test('签名：篡改 body 后验签失败', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const n = nonce()
  const signature = S.signRequest({
    signKey: key, method: 'POST', pathWithQuery: '/p', ts: now, nonce: n, rawBody: '{"amount":100}',
  })
  const r = S.verifyRequestSignature({
    signKey: key, method: 'POST', pathWithQuery: '/p', ts: now, nonce: n,
    rawBody: '{"amount":999999}', signature, nowMs: now,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'AUTH_SIGN_INVALID')
})

test('签名：缺签名字段返回 AUTH_SIGN_MISSING', () => {
  const r = S.verifyRequestSignature({
    signKey: 'k', method: 'POST', pathWithQuery: '/p', rawBody: '',
    ts: Date.now(), nonce: nonce(), signature: null, nowMs: Date.now(),
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'AUTH_SIGN_MISSING')
})

test('签名：nonce 长度不合法被拒（契约要求 16~64 位 hex）', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  for (const bad of ['short', 'zzzzzzzzzzzzzzzz', 'a'.repeat(65)]) {
    const r = S.verifyRequestSignature({
      signKey: key, method: 'GET', pathWithQuery: '/p', rawBody: '',
      ts: now, nonce: bad, signature: 'aa'.repeat(32), nowMs: now,
    })
    assert.strictEqual(r.ok, false, `nonce=${bad} 应被拒`)
    assert.strictEqual(r.code, 'AUTH_SIGN_INVALID')
  }
})

test('签名：时间戳超出 ±5 分钟容忍窗返回 AUTH_TS_SKEW', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const n = nonce()
  const signature = S.signRequest({
    signKey: key, method: 'GET', pathWithQuery: '/p', ts: now, nonce: n, rawBody: '',
  })

  const r = S.verifyRequestSignature({
    signKey: key, method: 'GET', pathWithQuery: '/p', ts: now, nonce: n,
    rawBody: '', signature, nowMs: now + 6 * 60 * 1000,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'AUTH_TS_SKEW')
  assert.ok(r.detail.skew_ms > 0)

  const ok = S.verifyRequestSignature({
    signKey: key, method: 'GET', pathWithQuery: '/p', ts: now, nonce: n,
    rawBody: '', signature, nowMs: now + 4 * 60 * 1000,
  })
  assert.strictEqual(ok.ok, true, '窗口内应通过')
})

test('签名：容忍窗口常量与契约一致（±5 分钟）', () => {
  assert.strictEqual(S.SIGN_TS_TOLERANCE_MS, 5 * 60 * 1000)
})

test('签名：safeEqualHex 长度不同返回 false，不抛异常', () => {
  assert.strictEqual(S.safeEqualHex('aabb', 'aabb'), true)
  assert.strictEqual(S.safeEqualHex('aabb', 'aabbcc'), false)
  assert.strictEqual(S.safeEqualHex(null, 'aabb'), false)
  assert.strictEqual(S.safeEqualHex('zz', 'zz'), false, '非法 hex 应返回 false')
})

// ══════════════════════════════════════════════════════════
// 响应签名（契约 §5.2）
// ══════════════════════════════════════════════════════════

test('响应签名：按契约 §5.2 拼接且可验签', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const n = nonce()
  const rawBody = JSON.stringify({ ok: true, credit: { balance_milli: 12599000 } })
  const sign = S.signResponseRaw({
    signKey: key, httpStatus: 200, pathWithQuery: '/api/v1/credit/balance',
    requestNonce: n, serverTimeMs: now, rawBody,
  })
  assert.doesNotThrow(() => S.verifyResponseSignature({
    signKey: key, httpStatus: 200, pathWithQuery: '/api/v1/credit/balance',
    requestNonce: n, serverTsHeader: String(now), signatureHeader: sign, rawBody,
  }))
})

test('响应签名：篡改响应体（伪造成余额充足）时验签失败', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const n = nonce()
  const rawBody = JSON.stringify({ ok: true, credit: { balance_milli: 0 } })
  const sign = S.signResponseRaw({
    signKey: key, httpStatus: 200, pathWithQuery: '/p',
    requestNonce: n, serverTimeMs: now, rawBody,
  })
  const forged = rawBody.replace('"balance_milli":0', '"balance_milli":999999999')
  assert.notStrictEqual(forged, rawBody)
  assert.throws(() => S.verifyResponseSignature({
    signKey: key, httpStatus: 200, pathWithQuery: '/p',
    requestNonce: n, serverTsHeader: String(now), signatureHeader: sign, rawBody: forged,
  }), /签名校验失败/)
})

test('响应签名：绑定 request_nonce（旧响应不能重放给新请求）', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const rawBody = '{}'
  const sign = S.signResponseRaw({
    signKey: key, httpStatus: 200, pathWithQuery: '/p',
    requestNonce: nonce(), serverTimeMs: now, rawBody,
  })
  assert.throws(() => S.verifyResponseSignature({
    signKey: key, httpStatus: 200, pathWithQuery: '/p',
    requestNonce: nonce(), // 不同的 nonce
    serverTsHeader: String(now), signatureHeader: sign, rawBody,
  }), /签名校验失败/)
})

test('响应签名：绑定 httpStatus 与 path（跨接口重放无效）', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const n = nonce()
  const rawBody = '{}'
  const sign = S.signResponseRaw({
    signKey: key, httpStatus: 200, pathWithQuery: '/p', requestNonce: n, serverTimeMs: now, rawBody,
  })
  for (const wrong of [{ httpStatus: 402 }, { pathWithQuery: '/q' }]) {
    assert.throws(() => S.verifyResponseSignature({
      signKey: key, httpStatus: 200, pathWithQuery: '/p',
      requestNonce: n, serverTsHeader: String(now), signatureHeader: sign, rawBody,
      ...wrong,
    }), /签名校验失败/)
  }
})

test('响应签名：缺签名头时抛 AUTH_SIGN_MISSING', () => {
  assert.throws(() => S.verifyResponseSignature({
    signKey: 'k', httpStatus: 200, pathWithQuery: '/p', requestNonce: 'n', rawBody: '{}',
  }), /缺少 X-Lic-Sign/)
})

// ══════════════════════════════════════════════════════════
// login_proof（契约 §4.1）
// ══════════════════════════════════════════════════════════

test('login_proof：可自证且能检测篡改', () => {
  const password = 'pw-123'
  const account = 'demo001'
  const deviceId = 'dev-abc'
  const body = { ok: true, token: 't1', policy: { policy_version: 7 } }
  const proof = S.buildLoginProof(password, account, deviceId, body)
  const resp = { ...body, login_proof: proof }

  assert.strictEqual(S.verifyLoginProof(password, account, deviceId, resp), true)

  const tampered = { ...resp, token: 't2' }
  assert.throws(() => S.verifyLoginProof(password, account, deviceId, tampered), /被篡改/)
})

test('login_proof：不同设备/账号/密码派生出不同密钥', () => {
  const a = S.deriveLoginKey('pw', 'acc1', 'dev1')
  const b = S.deriveLoginKey('pw', 'acc1', 'dev2')
  const c = S.deriveLoginKey('pw', 'acc2', 'dev1')
  const d = S.deriveLoginKey('pw2', 'acc1', 'dev1')
  assert.strictEqual(new Set([a, b, c, d]).size, 4)
})

test('login_proof：缺失时抛错', () => {
  assert.throws(() => S.verifyLoginProof('p', 'a', 'd', { ok: true }), /缺少 login_proof/)
})

test('stableJson：key 顺序不敏感（login_proof 依赖它）', () => {
  assert.strictEqual(S.stableJson({ b: 1, a: 2 }), S.stableJson({ a: 2, b: 1 }))
  assert.strictEqual(S.stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.strictEqual(S.stableJson({ a: undefined }), '{}')
  assert.strictEqual(S.stableJson([1, undefined, 2]), '[1,null,2]')
})

// ══════════════════════════════════════════════════════════
// 令牌与哈希工具
// ══════════════════════════════════════════════════════════

test('令牌与密钥：长度与随机性', () => {
  const t1 = S.generateToken()
  const t2 = S.generateToken()
  assert.strictEqual(t1.length, 64, '32 字节 hex = 64 字符')
  assert.notStrictEqual(t1, t2)
  assert.match(S.generateSignKey(), /^[0-9a-f]{64}$/)
})

test('sha256Hex：确定性且与 node:crypto 一致', () => {
  assert.strictEqual(S.sha256Hex('abc'), S.sha256Hex('abc'))
  assert.strictEqual(S.sha256Hex('abc').length, 64)
  const expected = crypto.createHash('sha256').update('abc', 'utf8').digest('hex')
  assert.strictEqual(S.sha256Hex('abc'), expected)
})
