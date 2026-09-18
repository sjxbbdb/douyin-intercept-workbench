'use strict'

// test/unit/crypto.test.js
// 加密模块测试：密码哈希与 HMAC 签名。
//
// ⚠️ 这两块的错误后果最严重：
//   · 密码哈希写错 → 密码可被还原或无法登录
//   · 签名写错 → 全部请求被判无效（fail-closed 停机）

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

const { hashPassword, verifyPassword, generatePassword } = require('../../license-server/crypto/password')
const S = require('../../license-server/crypto/sign')

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
  // 但都能校验通过
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
  // 篡改哈希部分
  const tampered = [...parts]
  tampered[5] = tampered[5].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
  assert.strictEqual(verifyPassword('x', tampered.join('$')), false)
  // 结构不对
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
  // 不含易混淆字符
  assert.ok(!/[0O1lI]/.test(p), '不应含易混淆字符 0/O/1/l/I')
  // 两次生成不同
  assert.notStrictEqual(generatePassword(16), generatePassword(16))
})

// ══════════════════════════════════════════════════════════
// 签名
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

test('签名：signObject 对 key 顺序不敏感（依赖 stableStringify）', () => {
  const k = S.generateSignKey()
  const a = S.signObject(k, { b: 1, a: 2 })
  const b = S.signObject(k, { a: 2, b: 1 })
  assert.strictEqual(a, b, 'key 顺序不同但语义相同的对象必须签出相同结果')
})

test('签名：buildRequestSignString 字段顺序固定', () => {
  const s = S.buildRequestSignString({
    method: 'post', path: '/api/v1/x', body: { a: 1 }, ts: 123, nonce: 'n1', seq: 5,
  })
  assert.strictEqual(s, 'POST\n/api/v1/x\n{"a":1}\n123\nn1\n5')
})

test('签名：verifyRequestSignature 正确通过', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const req = { method: 'POST', path: '/api/v1/audit/sends', body: { x: 1 }, ts: now, nonce: 'abc', seq: 7 }
  const signature = S.hmacHex(key, S.buildRequestSignString(req))
  const r = S.verifyRequestSignature({ ...req, signKey: key, signature, nowMs: now })
  assert.deepStrictEqual(r, { ok: true })
})

test('签名：篡改 body 后验签失败', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const base = { method: 'POST', path: '/p', body: { amount: 100 }, ts: now, nonce: 'n', seq: 1 }
  const signature = S.hmacHex(key, S.buildRequestSignString(base))
  const r = S.verifyRequestSignature({
    ...base, body: { amount: 999999 }, signKey: key, signature, nowMs: now,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'AUTH_SIGN_INVALID')
})

test('签名：缺少签名字段返回 AUTH_SIGN_MISSING', () => {
  const r = S.verifyRequestSignature({
    signKey: 'k', method: 'POST', path: '/p', body: {}, ts: Date.now(), nonce: 'n',
    signature: null, nowMs: Date.now(),
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'AUTH_SIGN_MISSING')
})

test('签名：时间戳超出 ±5 分钟容忍窗返回 AUTH_TS_SKEW', () => {
  const key = S.generateSignKey()
  const now = Date.now()
  const req = { method: 'POST', path: '/p', body: {}, ts: now, nonce: 'n', seq: 1 }
  const signature = S.hmacHex(key, S.buildRequestSignString(req))

  // 时钟偏差 6 分钟 → 拒绝
  const r = S.verifyRequestSignature({ ...req, signKey: key, signature, nowMs: now + 6 * 60 * 1000 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'AUTH_TS_SKEW')
  assert.ok(r.detail.skew_ms > 0)

  // 偏差 4 分钟 → 通过（窗口内）
  const ok = S.verifyRequestSignature({ ...req, signKey: key, signature, nowMs: now + 4 * 60 * 1000 })
  assert.strictEqual(ok.ok, true)
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

test('签名：响应签名可被验签（防中间人伪造余额）', () => {
  const key = S.generateSignKey()
  const signed = S.signResponse(key, { ok: true, credit: { balance_milli: 12599000 } }, Date.now())
  assert.ok(signed.sign, '响应应带 sign')
  const verified = S.verifyResponseSignature(key, signed)
  assert.strictEqual(verified.credit.balance_milli, 12599000)
  assert.ok(!('sign' in verified), '验签后应剥离 sign 字段')
})

test('签名：响应被篡改（伪造成余额充足）时验签失败', () => {
  const key = S.generateSignKey()
  const signed = S.signResponse(key, { ok: true, credit: { balance_milli: 0 } }, Date.now())
  // 攻击者把余额改成很大
  const forged = { ...signed, credit: { balance_milli: 999999999 } }
  assert.throws(() => S.verifyResponseSignature(key, forged), /签名校验失败/)
})

test('签名：响应缺少 sign 时抛 AUTH_SIGN_MISSING', () => {
  const key = S.generateSignKey()
  assert.throws(() => S.verifyResponseSignature(key, { ok: true }), /缺少签名/)
})

test('login_proof：可自证且能检测篡改', () => {
  const password = 'pw-123'
  const account = 'demo001'
  const deviceId = 'dev-abc'
  const body = { ok: true, token: 't1', policy: { policy_version: 7 } }
  const proof = S.buildLoginProof(password, account, deviceId, body)
  const resp = { ...body, login_proof: proof }

  assert.strictEqual(S.verifyLoginProof(password, account, deviceId, resp), true)

  // 篡改 token
  const tampered = { ...resp, token: 't2' }
  assert.throws(() => S.verifyLoginProof(password, account, deviceId, tampered), /被篡改/)
})

test('login_proof：不同设备/账号/密码派生出不同密钥', () => {
  const a = S.deriveLoginKey('pw', 'acc1', 'dev1')
  const b = S.deriveLoginKey('pw', 'acc1', 'dev2')
  const c = S.deriveLoginKey('pw', 'acc2', 'dev1')
  const d = S.deriveLoginKey('pw2', 'acc1', 'dev1')
  const set = new Set([a, b, c, d])
  assert.strictEqual(set.size, 4)
})

test('login_proof：缺失时抛错', () => {
  assert.throws(() => S.verifyLoginProof('p', 'a', 'd', { ok: true }), /缺少 login_proof/)
})

test('令牌与密钥：长度与随机性', () => {
  const t1 = S.generateToken()
  const t2 = S.generateToken()
  assert.strictEqual(t1.length, 64, '32 字节 hex = 64 字符')
  assert.notStrictEqual(t1, t2)
  assert.match(S.generateSignKey(), /^[0-9a-f]{64}$/)
})

test('sha256Hex：确定性且不可逆推', () => {
  assert.strictEqual(S.sha256Hex('abc'), S.sha256Hex('abc'))
  assert.strictEqual(S.sha256Hex('abc').length, 64)
  const expected = crypto.createHash('sha256').update('abc', 'utf8').digest('hex')
  assert.strictEqual(S.sha256Hex('abc'), expected)
})
