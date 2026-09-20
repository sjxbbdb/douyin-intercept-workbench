'use strict'

// test/unit/lib.test.js
// 地基模块的单元测试：确定性序列化、错误模型、协议常量。
//
// ⚠️ stable-stringify 是 HMAC 签名的基础。它一旦出错，**两端算出的签名
//    不一致，全部请求被判无效**。所以这里覆盖得比其他模块细。

const test = require('node:test')
const assert = require('node:assert')

const { stableStringify } = require('../../shared/lib/stable-stringify')
const { AppError, ERROR_CODES, FAILURE_REASONS, PLATFORM_ENDPOINTS, statusOf, isKnownErrorCode } =
  require('../../shared/lib/errors')
const P = require('../../shared/lib/protocol')

// ══════════════════════════════════════════════════════════
// stableStringify
// ══════════════════════════════════════════════════════════

test('stableStringify：key 递归排序，与书写顺序无关', () => {
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } }
  const b = { c: { y: 2, z: 1 }, a: 2, b: 1 }
  assert.strictEqual(stableStringify(a), stableStringify(b))
  assert.strictEqual(stableStringify(a), '{"a":2,"b":1,"c":{"y":2,"z":1}}')
})

test('stableStringify：无多余空格', () => {
  assert.strictEqual(stableStringify({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}')
  assert.ok(!stableStringify({ a: { b: 1 } }).includes(' '), '不应含空格')
})

test('stableStringify：数组保持原序（顺序有语义）', () => {
  assert.strictEqual(stableStringify([3, 1, 2]), '[3,1,2]')
  assert.notStrictEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

test('stableStringify：undefined 的键整体省略（与 JSON 一致）', () => {
  assert.strictEqual(stableStringify({ a: 1, b: undefined }), '{"a":1}')
})

test('stableStringify：数组中 undefined 转 null（与 JSON 一致）', () => {
  assert.strictEqual(stableStringify([1, undefined, 2]), '[1,null,2]')
})

test('stableStringify：显式区分 undefined 与 null', () => {
  // 这是签名不一致的常见根因：混同会让两端算出不同结果
  assert.notStrictEqual(stableStringify({ a: undefined }), stableStringify({ a: null }))
  assert.strictEqual(stableStringify({ a: null }), '{"a":null}')
})

test('stableStringify：字符串正确转义', () => {
  assert.strictEqual(stableStringify({ a: 'x"y' }), '{"a":"x\\"y"}')
  assert.strictEqual(stableStringify({ a: '换\n行' }), '{"a":"换\\n行"}')
  assert.strictEqual(stableStringify({ a: '反\\斜杠' }), '{"a":"反\\\\斜杠"}')
})

test('stableStringify：数字用 String(n)，不做格式化', () => {
  assert.strictEqual(stableStringify({ a: 1.5 }), '{"a":1.5}')
  assert.strictEqual(stableStringify({ a: 0.1 + 0.2 }), `{"a":${0.1 + 0.2}}`)
  assert.strictEqual(stableStringify({ a: -0 }), '{"a":0}')
  assert.strictEqual(stableStringify({ a: 1e21 }), '{"a":1e+21}')
})

test('stableStringify：非有限数字抛错（不静默产出不可校验的签名）', () => {
  assert.throws(() => stableStringify({ a: NaN }), TypeError)
  assert.throws(() => stableStringify({ a: Infinity }), TypeError)
})

test('stableStringify：布尔与 null 正确', () => {
  assert.strictEqual(stableStringify({ a: true, b: false, c: null }), '{"a":true,"b":false,"c":null}')
})

test('stableStringify：深层嵌套稳定', () => {
  const v = { z: [{ b: 1, a: 2 }], a: { d: { c: 3 } } }
  const expected = '{"a":{"d":{"c":3}},"z":[{"a":2,"b":1}]}'
  assert.strictEqual(stableStringify(v), expected)
})

test('stableStringify：等价对象多次调用结果一致（确定性）', () => {
  const v = { b: [1, { y: 2, x: 3 }], a: 'str' }
  const first = stableStringify(v)
  for (let i = 0; i < 50; i++) assert.strictEqual(stableStringify(v), first)
})

test('stableStringify：与 JSON.stringify 在已排序对象上等价', () => {
  const sorted = { a: 1, b: [1, 2, { c: 3 }], d: 'x' }
  assert.strictEqual(stableStringify(sorted), JSON.stringify(sorted))
})

// ══════════════════════════════════════════════════════════
// 错误模型
// ══════════════════════════════════════════════════════════

test('AppError：拒绝未登记的错误码（防止笔误静默放过）', () => {
  assert.throws(() => new AppError('POLICY_VIOLENT', '拼错了'), /未知错误码/)
  assert.throws(() => new AppError('NOT_A_REAL_CODE'), /未知错误码/)
})

test('AppError：登记的错误码可构造且携带 HTTP 状态', () => {
  const e = new AppError('POLICY_VIOLATION', '上报配置高于策略', { field: 'daily_max' })
  assert.strictEqual(e.code, 'POLICY_VIOLATION')
  assert.strictEqual(e.status, 409)
  assert.strictEqual(e.detail.field, 'daily_max')
})

test('AppError：toEnvelope 产出契约规定的错误信封', () => {
  const e = new AppError('AUTH_PASSWORD_WRONG', '账号或密码错误')
  assert.deepStrictEqual(e.toEnvelope(), {
    ok: false,
    code: 'AUTH_PASSWORD_WRONG',
    message: '账号或密码错误',
  })
})

test('AppError：detail 为 null 时信封中省略该字段', () => {
  const e = new AppError('SERVER_INTERNAL', '内部错误')
  assert.ok(!('detail' in e.toEnvelope()))
})

test('statusOf：未登记错误码抛错，不给默认值', () => {
  assert.strictEqual(statusOf('CREDIT_EXHAUSTED'), 402)
  assert.throws(() => statusOf('NOPE'), /未知错误码/)
})

test('isKnownErrorCode：正确判定', () => {
  assert.strictEqual(isKnownErrorCode('POLICY_VIOLATION'), true)
  assert.strictEqual(isKnownErrorCode('POLICY_VIOLENT'), false)
  assert.strictEqual(isKnownErrorCode(undefined), false)
  assert.strictEqual(isKnownErrorCode(123), false)
})

test('错误码表：POLICY_DAILY_CAP_EXCEEDED 是业务结果(200)，不是错误', () => {
  // 该条不计费但明细仍留痕，属正常业务分支
  assert.strictEqual(ERROR_CODES.POLICY_DAILY_CAP_EXCEEDED, 200)
})

test('错误码表：CREDIT_REDEEM_ALREADY_DONE 是幂等命中(200)', () => {
  assert.strictEqual(ERROR_CODES.CREDIT_REDEEM_ALREADY_DONE, 200)
})

// ══════════════════════════════════════════════════════════
// 协议常量
// ══════════════════════════════════════════════════════════

test('verdict 闭集恰好四种（不含 skipped）', () => {
  assert.deepStrictEqual(
    [...P.VERDICTS].sort(),
    ['failed', 'sent_confirmed', 'sent_confirmed_dom', 'sent_suspected']
  )
  assert.ok(!P.VERDICTS.includes('skipped'), 'skipped 无 send_id、不产生 send_log 行')
})

test('skipped 由聚合计数承载（否则该指标会丢失）', () => {
  assert.ok(P.SOURCE_COUNTERS.includes('skipped'))
})

test('失败归因码闭集：editor_dismissed_unconfirmed 不是失败原因', () => {
  // 它对应 sent_suspected，禁止出现在 failure_reasons 里
  assert.ok(!FAILURE_REASONS.includes('editor_dismissed_unconfirmed'))
})

test('平台接口是闭集白名单，且不含完整 URL 与域名', () => {
  for (const ep of PLATFORM_ENDPOINTS) {
    assert.ok(!ep.includes('://'), `${ep} 不应含协议头`)
    assert.ok(!ep.includes('douyin'), `${ep} 不应含域名`)
  }
})

test('等级天数边界：1-3 / 4-7 / 8-14 / 15+ 且连续无空隙', () => {
  const b = P.TIER_DAY_BOUNDARIES
  assert.strictEqual(b[0].day_from, 1)
  assert.strictEqual(b[b.length - 1].day_to, null, 'stable 无上限')
  for (let i = 1; i < b.length; i++) {
    assert.strictEqual(b[i].day_from, b[i - 1].day_to + 1, `${b[i].tier} 与前一级不连续`)
  }
})

test('协议版本为 2（与契约一致）', () => {
  assert.strictEqual(P.PROTOCOL_VERSION, 2)
})
