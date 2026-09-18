'use strict'

// test/unit/client-safety.test.js
// 安全护栏四模块测试：similarity / circuit / timing / audit。
//
// ⚠️ 本文件的核心命题有三条，每条都对应一个"写反了就完蛋"的方向：
//   1. **相似度方向**：相似度**超过**阈值才拒绝（AGENTS.md §2.4）。
//      写反 = 系统只发重复内容 = 灾难性缺陷。见 §1 的"方向守卫"。
//   2. **服务端冷却是权威下限**：本地递进不可因服务端给得短而回退（方案 §4.5）。
//   3. **审计记实际生效值 + applied:false 的拒绝证据**（红线 3）。
//
// ⚠️ 时间用法与 client-guard.test.js 一致：`now()` 注入固定时刻，
//    但所有业务方法**一律显式传 atMs**，避免注入时钟与真实时钟错位。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { Store } = require('../../client/host/store')
const G = require('../../client/safety/guard')
const S = require('../../client/safety/similarity')
const C = require('../../client/safety/circuit')
const T = require('../../client/safety/timing')
const A = require('../../client/safety/audit')
const { buildPolicy } = require('../../license-server/domain/policy')
const { AppError } = require('../../shared/lib/errors')

const NOW = 1758096000000
const TZ = 480 * 60 * 1000

/** 本地时间某日的某时刻（UTC+8）。 */
function localTime(dayOffset = 0, hour = 10, minute = 0) {
  const day = Math.floor((NOW + TZ) / 86400000) + dayOffset
  return day * 86400000 + (hour * 60 + minute) * 60000 - TZ
}

const BASE = localTime(0, 10, 0)

/** 稳定期策略（服务端下发，含 circuit_breaker 阈值与冷却时长） */
function stablePolicy() {
  return buildPolicy({ accountId: 1, accountDayIndex: 30, policyVersion: 9, nowMs: NOW })
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    // ⚠️ 不吞异常：清理失败本身不影响结论，但必须留痕（AGENTS.md §2.8）。
    process.stderr.write(`[test] 临时目录清理失败 ${dir}: ${e.message}\n`)
  }
}

/** 造一个 Store + Guard + CircuitBreaker + AuditLog 的测试夹具。 */
function makeFixture(opts = {}) {
  const dir = opts.dir || tmpDir('dsh-safety-')
  const store = new Store({ dir })
  let t = opts.nowMs === undefined ? BASE : opts.nowMs
  const guard = new G.Guard({ store, now: () => t })
  const circuit = new C.CircuitBreaker({ store, now: () => t })
  const warnings = []
  const audit = new A.AuditLog({
    store,
    now: () => t,
    maxBytes: opts.maxBytes,
    onWarn: (e) => warnings.push(e),
  })
  return {
    dir,
    store,
    guard,
    circuit,
    audit,
    warnings,
    at: () => t,
    setTime: (v) => { t = v },
    /** 模拟进程重启：关掉 store，再在同一目录打开一套新的 */
    restart: () => {
      store.close()
      return makeFixture({ dir, nowMs: t, maxBytes: opts.maxBytes })
    },
    cleanup: () => {
      store.close()
      rmDir(dir)
    },
  }
}

// ══════════════════════════════════════════════════════════
// §1 内容相似度
// ══════════════════════════════════════════════════════════

test('相似度：相同文案的指纹完全相同（相似度 1）', () => {
  const a = '这个商品多少钱呢，方便的话报个价'
  const b = '这个商品多少钱呢，方便的话报个价'
  assert.strictEqual(S.simhash(a), S.simhash(b))
  assert.strictEqual(S.hammingDistance(a, b), 0)
  assert.strictEqual(S.similarity(a, b), 1)
})

test('相似度：⚠️ 方向守卫 —— 相似度**超过**阈值即拒绝（0.85 的语义）', () => {
  const threshold = 0.85 // ⚠️ 由调用方传入；客户端不得硬编码（红线 1）
  const recent = ['这个商品多少钱呢，方便的话报个价']

  // ① 几乎一样（只差一个语气词）→ 相似度高于阈值 → **必须拒绝**
  const near = '这个商品多少钱呀，方便的话报个价'
  const simNear = S.similarity(near, recent[0])
  assert.ok(simNear > threshold,
    `近重复文案的相似度应高于阈值，实测 ${simNear}（阈值 ${threshold}）`)

  const rNear = S.checkContent(near, { recentTexts: recent, threshold })
  assert.strictEqual(rNear.allow, false, '⚠️ 近重复文案必须被拒绝')
  assert.strictEqual(rNear.reason, 'content_rejected')
  assert.strictEqual(rNear.matchedIndex, 0)
  assert.ok(rNear.similarity > threshold)

  // ② 明显不同的文案 → 相似度低于阈值 → **必须放行**
  const far = '请问发货时间是多久，我这边比较着急'
  const simFar = S.similarity(far, recent[0])
  assert.ok(simFar < threshold, `不同文案的相似度应低于阈值，实测 ${simFar}`)

  const rFar = S.checkContent(far, { recentTexts: recent, threshold })
  assert.strictEqual(rFar.allow, true, '不同文案必须放行')
  assert.strictEqual(rFar.reason, null)

  // ③ 方向守卫：若有人把 `>` 改成 `<`，上面两条必然有一条失败——
  //    这里再显式固化"高相似 ⇒ 拒、低相似 ⇒ 放"的相对关系，
  //    使得任何方向翻转都同时打破两条断言。
  assert.ok(simNear > simFar, '近重复的相似度必须高于不同文案')
  assert.ok(rNear.allow === false && rFar.allow === true,
    '⚠️ 高相似被拒、低相似被放行 —— 方向反了本条必然失败（AGENTS.md §2.4）')
})

test('相似度：恰好等于阈值时放行（语义是"超过"才拒绝）', () => {
  const recent = ['这个商品多少钱呢，方便的话报个价']
  const text = '这个商品多少钱呀，方便的话报个价'
  const sim = S.similarity(text, recent[0])
  // 用实测相似度当阈值 → 恰好等于 → 应放行
  const r = S.checkContent(text, { recentTexts: recent, threshold: sim })
  assert.strictEqual(r.allow, true, '等于阈值不算"超过"，必须放行')
  assert.strictEqual(r.similarity, sim)
})

test('相似度：findMostSimilar 返回最相似的一条及其下标', () => {
  const recent = [
    '请问发货时间是多久，我这边比较着急',
    '这个商品多少钱呢，方便的话报个价',
    '这个商品多少钱呀，方便的话报个价',
  ]
  const m = S.findMostSimilar('这个商品多少钱呢，方便的话报个价', recent)
  assert.ok(m !== null)
  assert.strictEqual(m.index, 1, '下标 1 是完全相同的那条')
  assert.strictEqual(m.similarity, 1)
})

test('相似度：空文本 / 超短文本 / 非字符串输入都不抛异常', () => {
  const threshold = 0.85
  // 空文本：属于调用方缺陷，判 text_empty（也是拒绝——空文案不能发）
  for (const v of ['', '   ', null, undefined]) {
    const r = S.checkContent(v, { recentTexts: ['这个商品多少钱呢，方便的话报个价'], threshold })
    assert.strictEqual(r.allow, false, `空/缺失文本（${JSON.stringify(v)}）不得放行`)
    assert.strictEqual(r.reason, 'text_empty')
  }
  // 超短文本：特征数不足 → 无法评估 → 放行（不拿噪声去拒绝正常短回复）
  const short = S.checkContent('好的', { recentTexts: ['好的'], threshold })
  assert.strictEqual(short.allow, true)
  assert.strictEqual(short.reason, 'similarity_not_assessable')
  // 纯标点 / 纯 emoji / 数字：不抛错
  for (const v of ['！！！', '🙂🙂🙂', '123', 'a']) {
    assert.doesNotThrow(() => S.checkContent(v, { recentTexts: [], threshold }))
  }
  // 极值文本不抛错
  assert.doesNotThrow(() => S.simhash('啊'.repeat(5000)))
  assert.doesNotThrow(() => S.simhash(''))
  assert.strictEqual(S.simhash(''), 0n, '空文本指纹为 0（合法值，不得抛错）')
  assert.strictEqual(S.hammingDistance(0n, 0n), 0)
})

test('相似度：阈值缺失一律抛错（不猜默认值，不放行）', () => {
  assert.throws(() => S.checkContent('随便一段够长的中文文案内容', { recentTexts: [] }),
    /threshold/, '阈值必须由服务端 policy 传入，客户端不得假定默认值')
  assert.throws(() => S.checkContent('随便一段够长的中文文案内容',
    { recentTexts: [], threshold: 'abc' }), /threshold/)
  assert.throws(() => S.checkContent('随便一段够长的中文文案内容',
    { recentTexts: [], threshold: 1.5 }), /0~1/)
})

test('相似度：中文分词同时产出一元与二元特征', () => {
  const feats = S.tokenize('这个商品多少钱')
  // 7 个汉字 → 7 个一元 + 6 个二元 = 13
  assert.strictEqual(feats.length, 13, `实测特征数 ${feats.length}`)
  assert.ok(feats.includes('商'), '一元特征')
  assert.ok(feats.includes('商品'), '二元特征')
  // 字母数字整词小写
  assert.deepStrictEqual(S.tokenize('ABC 12x'), ['abc', '12x'])
})

test('相似度：模板池变体数不足即拒绝（需求要求至少 5 条变体）', () => {
  const ok = ['亲，这款现在有货哦', '这款目前库存充足呢', '有货的，可以下单啦',
    '现货哦，随时可以拍', '库存有货，拍下即可']
  const r1 = S.templateVariantsOk(ok)
  assert.strictEqual(r1.ok, true)
  assert.strictEqual(r1.distinct, 5)
  assert.strictEqual(r1.required, 5)

  const tooFew = S.templateVariantsOk(ok.slice(0, 4))
  assert.strictEqual(tooFew.ok, false)
  assert.strictEqual(tooFew.distinct, 4)

  // ⚠️ 去重后计数：写 5 条一模一样的不算变体
  const dup = S.templateVariantsOk(['一样的一句话文案', '一样的一句话文案', '一样的一句话文案',
    '一样的一句话文案', '一样的一句话文案'])
  assert.strictEqual(dup.ok, false, '重复模板不得计为变体')
  assert.strictEqual(dup.distinct, 1)

  // 空模板不计入；非数组不抛错
  assert.strictEqual(S.templateVariantsOk(['', '   ', null]).distinct, 0)
  assert.strictEqual(S.templateVariantsOk(undefined).ok, false)
  // 下限可由调用方指定（服务端策略优先）
  assert.strictEqual(S.templateVariantsOk(ok, { required: 6 }).ok, false)
  assert.throws(() => S.templateVariantsOk(ok, { required: 0 }), /非法/)
})

// ══════════════════════════════════════════════════════════
// §2 熔断状态机
// ══════════════════════════════════════════════════════════

test('熔断：风控触发逐级上升 l1 → l2 → l3，冷却时长为 30 分钟 / 1 小时 / 停到次日', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    const r1 = h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    assert.strictEqual(r1.level, 'l1')
    assert.strictEqual(r1.cooldown_ms, C.L1_COOLDOWN_MS, 'L1 = 30 分钟')
    assert.match(r1.hint, /30 分钟/)

    const r2 = h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 1000 })
    assert.strictEqual(r2.level, 'l2')
    assert.strictEqual(r2.cooldown_ms, C.L2_COOLDOWN_MS, 'L2 = 1 小时')
    assert.match(r2.hint, /1 小时/)

    const r3 = h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 2000 })
    assert.strictEqual(r3.level, 'l3')
    // L3 = 停到次日 00:00(UTC+8)，而不是固定毫秒数
    assert.strictEqual(r3.cooldown_ms, C.msUntilNextDay(BASE + 2000))
    assert.match(r3.hint, /次日/)

    // 已到最高级，继续触发不越界
    const r4 = h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 3000 })
    assert.strictEqual(r4.level, 'l3', 'L3 是最高级，不得越界')
  } finally { h.cleanup() }
})

test('熔断：验证码 / 滑块出现即触发升级', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    const r = h.circuit.recordFailure('captcha', { atMs: BASE })
    assert.strictEqual(r.escalated, true)
    assert.strictEqual(r.level, 'l1')
    assert.strictEqual(r.reason, 'captcha')
  } finally { h.cleanup() }
})

test('熔断：连续失败达阈值即触发', () => {
  const h = makeFixture()
  try {
    const pol = stablePolicy()
    h.circuit.applyPolicy(pol)
    const n = pol.circuit_breaker.platform_reject_threshold
    for (let i = 1; i <= n; i++) {
      const snap = h.circuit.recordFailure('element_timeout', { atMs: BASE + i })
      assert.strictEqual(snap.escalated === true, i >= n,
        `第 ${i} 次普通失败${i >= n ? '应' : '不应'}熔断`)
    }
    assert.strictEqual(h.circuit.snapshot(BASE + n).level, 'l1')
  } finally { h.cleanup() }
})

test('熔断：platform_reject_count 达阈值触发（默认 3）', () => {
  const h = makeFixture()
  try {
    const pol = stablePolicy()
    h.circuit.applyPolicy(pol)
    const threshold = pol.circuit_breaker.platform_reject_threshold
    assert.strictEqual(threshold, 3)

    for (let i = 1; i < threshold; i++) {
      const s = h.circuit.recordPlatformReject('risk_control_rejected', { atMs: BASE + i })
      assert.strictEqual(s.level, 'none', `第 ${i} 次还不应熔断`)
      assert.strictEqual(s.platformRejectCount, i)
    }
    const s = h.circuit.recordPlatformReject('risk_control_rejected', { atMs: BASE + threshold })
    assert.strictEqual(s.level, 'l1', '第 3 次平台拒绝应触发熔断')
    assert.strictEqual(s.reason, 'platform_reject_count')
  } finally { h.cleanup() }
})

test('熔断：失败率超过阈值触发（窗口内 45% > 40%）', () => {
  const h = makeFixture()
  try {
    const pol = stablePolicy()
    h.circuit.applyPolicy(pol)
    const win = pol.circuit_breaker.failure_rate_window
    const thr = pol.circuit_breaker.failure_rate_threshold
    assert.strictEqual(win, 20)

    // 先塞满 20 条：11 条失败 + 9 条成功 = 55%，但中途必然已触发
    let escalatedAt = null
    for (let i = 0; i < win; i++) {
      const ok = i >= 11
      const snap = ok
        ? h.circuit.recordSuccess(BASE + i * 1000)
        : h.circuit.recordFailure('element_timeout', { atMs: BASE + i * 1000 })
      if (snap.escalated === true && escalatedAt === null) escalatedAt = i
    }
    assert.ok(escalatedAt !== null, '失败率超过阈值必须触发熔断')

    // 单测 recordFailureRate 的判定口径
    const h2 = makeFixture()
    try {
      h2.circuit.applyPolicy(stablePolicy())
      const before = h2.circuit.recordFailureRate({ atMs: BASE })
      assert.strictEqual(before.escalated, false, '窗口未满不得触发')
      assert.ok(h2.circuit.snapshot(BASE).failureRateThreshold <= thr)
      // 喂满窗口：8 失败 + 12 成功 = 40%，**不**超过阈值（边界：等于不触发）
      for (let i = 0; i < win; i++) {
        const at = BASE + i * 1000
        if (i < 8) h2.circuit.recordFailure('element_timeout', { atMs: at })
        else h2.circuit.recordSuccess(at)
      }
      const atRate = h2.circuit.recordFailureRate({ atMs: BASE + win * 1000 })
      assert.strictEqual(atRate.window, win)
      assert.strictEqual(atRate.failure_rate, 0.4)
      assert.strictEqual(atRate.escalated, false, '恰好等于阈值不算"超过"')
    } finally { h2.cleanup() }
  } finally { h.cleanup() }
})

test('熔断：isOpen 是纯查询，连续调用不改状态（也不在到期后自行降级）', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    const before = JSON.stringify(h.circuit.state)

    for (let i = 0; i < 5; i++) assert.strictEqual(h.circuit.isOpen(BASE), true)
    assert.strictEqual(JSON.stringify(h.circuit.state), before, '查询不得改变任何状态')

    // 到期后查询同样不得自行降级（必须显式 decay）
    const after = h.circuit.state.untilMs + 1
    for (let i = 0; i < 3; i++) assert.strictEqual(h.circuit.isOpen(after), false)
    assert.strictEqual(JSON.stringify(h.circuit.state), before,
      '到期后查询同样不得降级——降级只能由显式 decay() 触发')
    assert.strictEqual(h.circuit.state.level, 1)
  } finally { h.cleanup() }
})

test('熔断：decay 在到期后逐级下降，未到期不生效', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 1 })
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 2 })
    assert.strictEqual(h.circuit.state.level, 3)

    assert.strictEqual(h.circuit.decay(BASE + 3), false, '未到期不得降级')

    assert.strictEqual(h.circuit.decay(h.circuit.state.untilMs + 1), true)
    assert.strictEqual(h.circuit.state.level, 2, 'l3 到期应降到 l2')
    assert.strictEqual(h.circuit.state.untilMs, 0, '降级即关闭本次冷却')

    assert.strictEqual(h.circuit.decay(h.circuit.state.serverFloorMs + 1), true)
    assert.strictEqual(h.circuit.state.level, 1, 'l2 到期应降到 l1')

    assert.strictEqual(h.circuit.decay(BASE + 4), true)
    assert.strictEqual(h.circuit.state.level, 0, 'l1 到期应完全解除')

    assert.strictEqual(h.circuit.decay(BASE + 5), false, '已解除后不再降级')
    assert.strictEqual(h.circuit.isOpen(BASE + 5), false)
  } finally { h.cleanup() }
})

test('熔断：⚠️ 服务端冷却**更长**时以服务端为准', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE }) // L1 = 30 分钟
    const localUntil = h.circuit.state.untilMs

    const serverUntil = BASE + 6 * 3600000 // 服务端要 6 小时
    const r = h.circuit.applyServerCooldown(serverUntil, 'risk_code', { atMs: BASE + 1000 })
    assert.strictEqual(r.untilMs, serverUntil, '服务端更长 → 取服务端')
    assert.ok(r.untilMs > localUntil)
    assert.strictEqual(r.server_shorter_than_local, false)
    assert.strictEqual(h.circuit.isOpen(serverUntil - 1), true, '服务端给的时间内不得提前放行')
    assert.strictEqual(h.circuit.isOpen(serverUntil + 1), false)
  } finally { h.cleanup() }
})

test('熔断：⚠️ 服务端冷却**更短**时不得削弱本地级别（服务端是权威下限）', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 1 }) // L2 = 1 小时
    const before = { level: h.circuit.state.level, untilMs: h.circuit.state.untilMs }
    assert.strictEqual(before.level, 2)

    const at = BASE + 2000
    const serverUntil = at + 5 * 60000 // 服务端只给 5 分钟
    const r = h.circuit.applyServerCooldown(serverUntil, 'failure_rate', { atMs: at })

    assert.strictEqual(h.circuit.state.level, before.level, '⚠️ 本地 L2 不得被削弱')
    assert.strictEqual(h.circuit.state.untilMs, before.untilMs, '⚠️ 到期时刻不得被服务端缩短')
    assert.ok(r.untilMs > serverUntil)
    assert.strictEqual(r.server_shorter_than_local, true)

    // 服务端给的 5 分钟过去后，本地 L2 仍然生效
    assert.strictEqual(h.circuit.isOpen(serverUntil + 1), true,
      '⚠️ 服务端的短冷却过去后，本地递进必须仍拦着')
    // decay 也不得突破服务端下限（本例中本地更长，取本地）
    assert.strictEqual(h.circuit.decay(serverUntil + 2), false)
  } finally { h.cleanup() }
})

test('熔断：服务端 heartbeat 报 open:false 时不清除本地熔断', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    const before = JSON.stringify(h.circuit.state)

    const r1 = h.circuit.applyServerState({ open: false, cooldown_until_ms: null }, { atMs: BASE + 1 })
    assert.strictEqual(r1.applied, false)
    assert.strictEqual(JSON.stringify(h.circuit.state), before, '服务端说没熔断 ≠ 本地解除')

    // 服务端说熔断中 → 采纳（只可能更长）
    const r2 = h.circuit.applyServerState(
      { open: true, cooldown_until_ms: BASE + 3600000, trigger: 'failure_rate' },
      { atMs: BASE + 2 })
    assert.strictEqual(r2.applied, true)
    assert.strictEqual(h.circuit.isOpen(BASE + 3), true)
  } finally { h.cleanup() }
})

test('熔断：状态跨 Store 关闭 / 重开保持（模拟进程重启）', () => {
  let h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordSent({ sourceType: 'comment', atMs: BASE })
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE + 1 })
    const levelBefore = h.circuit.state.level
    const untilBefore = h.circuit.state.untilMs
    assert.strictEqual(levelBefore, 2)

    // ── 模拟进程重启 ──
    const h2 = h.restart()
    h = null
    try {
      assert.strictEqual(h2.circuit.state.level, levelBefore, '熔断级别必须跨重启保持')
      assert.strictEqual(h2.circuit.state.untilMs, untilBefore, '到期时刻必须跨重启保持')
      assert.strictEqual(h2.circuit.isOpen(BASE + 2), true,
        '⚠️ 重启即可绕过熔断 = 护栏失效')

      // ⚠️ 同时确认没有把 guard 的数据覆盖掉（同一个 runtime-state.json）
      assert.strictEqual(h2.guard.usedToday('comment', BASE + 2), 1,
        '⚠️ 熔断状态落盘不得清掉 guard 的日用量（全量覆写会重置日上限）')
      const raw = h2.store.readJson('runtime-state.json', {})
      assert.ok(raw.circuit && raw.circuitState, 'guard 的 circuit 与状态机的 circuitState 必须并存')
    } finally { h2.cleanup() }
  } finally { if (h) h.cleanup() }
})

test('熔断：clear 是唯一解除路径，且没有任何禁用开关', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    assert.strictEqual(h.circuit.isOpen(BASE), true)

    const snap = h.circuit.clear(BASE + 1)
    assert.strictEqual(snap.level, 'none')
    assert.strictEqual(h.circuit.isOpen(BASE + 1), false)

    // ⚠️ 红线：不得存在任何"关闭熔断"的选项
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'client', 'safety', 'circuit.js'), 'utf8')
    assert.ok(!/process\.env/.test(src), '熔断模块不得读取环境变量（防止用 env 关闭熔断）')
    assert.ok(!/\b(?:disabled|disable|enabled|turnOff|switchOff)\s*[:=]/.test(src),
      '熔断模块不得提供启用/禁用开关')
  } finally { h.cleanup() }
})

test('熔断：snapshot 提供界面所需的级别 / 到期 / 剩余 / 提示', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    const idle = h.circuit.snapshot(BASE)
    assert.strictEqual(idle.level, 'none')
    assert.strictEqual(idle.open, false)
    assert.strictEqual(idle.remainingMs, 0)

    h.circuit.recordFailure('risk_control_rejected', { atMs: BASE })
    const s = h.circuit.snapshot(BASE + 60000)
    assert.strictEqual(s.level, 'l1')
    assert.strictEqual(s.open, true)
    assert.strictEqual(s.untilMs, BASE + C.L1_COOLDOWN_MS)
    assert.strictEqual(s.remainingMs, C.L1_COOLDOWN_MS - 60000)
    assert.ok(s.reason)
    assert.match(s.hint, /30 分钟/)
    assert.strictEqual(s.platformRejectThreshold, 3)
    assert.ok(typeof s.failureRate === 'number')
  } finally { h.cleanup() }
})

test('熔断：与 guard 的简化熔断合并时取更保守者（绝不互相削弱）', () => {
  const h = makeFixture()
  try {
    h.circuit.applyPolicy(stablePolicy())
    h.guard.applyPolicy(stablePolicy())

    // ① guard 升到 l3（走它自己的 recordResult 路径）
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(h.guard.circuit.level, 'l3')
    const guardUntil = h.guard.circuit.untilMs

    // ② 状态机只到 l1（普通失败：需累计到阈值才升级）
    h.circuit.recordFailure('element_timeout', { atMs: BASE })
    h.circuit.recordFailure('element_timeout', { atMs: BASE + 1 })
    const r = h.circuit.recordFailure('element_timeout', { atMs: BASE + 2 })
    assert.strictEqual(r.level, 'l1') // 普通失败走"连续失败阈值"，起步是 l1
    const circuitUntil = h.circuit.state.untilMs

    // 合并视图：级别取大、到期取大、任一 open 即 open
    const merged = h.circuit.guardCircuit(h.guard, BASE + 3)
    assert.strictEqual(merged.level, 3, '合并必须取更保守的一方（guard 的 l3）')
    assert.strictEqual(merged.untilMs, Math.max(guardUntil, circuitUntil))
    assert.strictEqual(merged.open, true)
    assert.strictEqual(merged.from, 'both')

    // ⚠️ 推进 guard：状态机说 l1 时**不得**把已经 l3 的 guard 降下来
    const applied = h.circuit.applyToGuard(h.guard)
    assert.strictEqual(h.guard.circuit.level, 'l3', '⚠️ 推进只允许收紧，绝不放宽')
    assert.strictEqual(h.guard.circuit.untilMs, Math.max(guardUntil, circuitUntil))
    assert.strictEqual(applied.persisted, false, 'guard 的落盘由它自己的方法负责')

    // 推进后 guard.canSend 必须拒发
    const deny = h.guard.canSend({ sourceType: 'comment', atMs: BASE + 4 })
    assert.strictEqual(deny.allow, false, 'guard 必须看到合并后的熔断')
    assert.strictEqual(deny.reason, 'circuit_open')

    // 没有 guard 时合并视图退化为自身状态
    const solo = h.circuit.guardCircuit(null, BASE + 5)
    assert.strictEqual(solo.level, 1)
    assert.strictEqual(solo.from, 'circuit')
  } finally { h.cleanup() }
})

test('熔断：非法输入一律抛错（不静默取默认值）', () => {
  const h = makeFixture()
  try {
    assert.throws(() => h.circuit.applyServerCooldown(0), /cooldown_until_ms/)
    assert.throws(() => h.circuit.applyServerCooldown(NaN), /cooldown_until_ms/)
    assert.throws(() => h.circuit.applyPolicy(null), /policy/)
    assert.throws(() => h.circuit.recordFailure('x', { atMs: 'abc' }), /非法时刻/)
    assert.throws(() => h.circuit.applyToGuard({}), /Guard/)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// §3 拟人化时序
// ══════════════════════════════════════════════════════════

const RANGE = { minMs: 60000, maxMs: 150000 }

test('时序：2000 个间隔全部落在 [min, max] 内', () => {
  const rng = T.makeSeededRng(20260918)
  for (let i = 0; i < 2000; i++) {
    const v = T.nextIntervalMs({ ...RANGE, rng })
    assert.ok(Number.isInteger(v), `间隔必须是整数毫秒，实测 ${v}`)
    assert.ok(v >= RANGE.minMs && v <= RANGE.maxMs, `第 ${i} 个间隔越界：${v}`)
  }
})

test('时序：分布不集中在单一取值上（标准差与分桶都达标）', () => {
  const d = T.describeIntervalDistribution(2000, { ...RANGE, rng: T.makeSeededRng(7) })
  assert.strictEqual(d.n, 2000)
  assert.strictEqual(d.outOfRange, 0)
  assert.strictEqual(d.inRange, 2000)

  // ① 标准差必须"有意义地大"：至少达到区间的 10%
  const span = RANGE.maxMs - RANGE.minMs
  assert.ok(d.stddev > span * 0.1,
    `标准差过小（${d.stddev}），说明间隔接近固定值——这正是旧代码被识别的特征`)

  // ② 单一分桶占比不得超过 40%
  assert.ok(d.maxBucketRatio < 0.4,
    `最大分桶占比 ${d.maxBucketRatio} 过高，分布仍然集中`)

  // ③ 不同取值数必须足够多（>100），排除"少数几个固定值轮换"
  assert.ok(d.distinct > 100, `不同取值仅 ${d.distinct} 个`)

  // ④ 反面样本：固定间隔的标准差为 0、取值只有 1 个——
  //    上述判据（标准差、不同取值数）必须能咬住它
  const flat = T.summarize(new Array(2000).fill(100000), RANGE)
  assert.strictEqual(flat.stddev, 0)
  assert.strictEqual(flat.distinct, 1)
  assert.ok(flat.stddev <= span * 0.1, '固定间隔必须被"标准差"判据咬住')
  assert.ok(!(flat.distinct > 100), '固定间隔必须被"不同取值数"判据咬住')
})

test('时序：可复现的种子随机源', () => {
  const a = T.makeSeededRng(123).constructor === Function
  assert.ok(a)
  const r1 = T.makeSeededRng(42)
  const r2 = T.makeSeededRng(42)
  const seq1 = Array.from({ length: 8 }, () => r1())
  const seq2 = Array.from({ length: 8 }, () => r2())
  assert.deepStrictEqual(seq1, seq2, '同种子必须复现')
  for (const v of seq1) assert.ok(v >= 0 && v < 1)
  assert.notDeepStrictEqual(seq1, Array.from({ length: 8 }, () => T.makeSeededRng(43)()))
})

test('时序：interval 参数缺失或非法一律抛错（不内置默认间隔）', () => {
  assert.throws(() => T.nextIntervalMs({}), /minMs/)
  assert.throws(() => T.nextIntervalMs({ minMs: 0 }), /minMs/)
  assert.throws(() => T.nextIntervalMs({ minMs: 1000, maxMs: 999 }), /区间非法/)
  assert.throws(() => T.nextIntervalMs({ minMs: 1000, rng: 5 }), /rng/)
  assert.throws(() => T.nextIntervalMs({ minMs: 1000, sigma: -1 }), /sigma/)
  // 上界缺省时由下界铺开（仍受服务端下界约束）
  const auto = T.nextIntervalMs({ minMs: 60000, rng: T.makeSeededRng(1) })
  assert.ok(auto >= 60000 && auto <= 60000 * T.INTERVAL_SPREAD_RATIO)
})

test('时序：operationDelayMs 落在 1–3 秒，且不是固定值', () => {
  const rng = T.makeSeededRng(99)
  const seen = new Set()
  for (let i = 0; i < 500; i++) {
    const v = T.operationDelayMs(rng)
    assert.ok(v >= T.OPERATION_DELAY_MIN_MS && v <= T.OPERATION_DELAY_MAX_MS, `越界：${v}`)
    seen.add(v)
  }
  assert.ok(seen.size > 100, `操作停顿的不同取值仅 ${seen.size} 个，过于固定`)
  // 自定义区间
  assert.strictEqual(T.operationDelayMs(() => 0, { minMs: 5, maxMs: 5 }), 5)
})

test('时序：typingPlan 分块拼接后严格等于原文', () => {
  const texts = [
    '你好，请问这个商品多少钱？我这边想了解一下哦～',
    'hello world, how are you? I am fine.',
    '收到',
    '1234567890',
    'a',
    '',
    '标点。停顿！测试？一二三四五',
  ]
  for (const t of texts) {
    const plan = T.typingPlan(t, { rng: T.makeSeededRng(11) })
    assert.strictEqual(plan.map((c) => c.text).join(''), t, `拼接必须等于原文：${t}`)
    if (t.length > 0) {
      assert.ok(plan.length >= 1)
      for (const chunk of plan) {
        assert.ok(chunk.text.length >= 1, '不得出现空块（会丢字符）')
        assert.ok(Number.isInteger(chunk.delayMs))
        assert.ok(chunk.delayMs >= 1, '每块之前必须有正数停顿')
      }
      // 块数必须显著少于字符数（逐字输入本身就是机器特征）
      assert.ok(plan.length < t.length || t.length <= 2,
        `块数 ${plan.length} 应少于字符数 ${t.length}（不是逐字输入）`)
    } else {
      assert.deepStrictEqual(plan, [])
    }
  }
})

test('时序：typingPlan 在标点后停顿更久', () => {
  // 以标点结尾的文本：最后一块结尾必然是标点，可以稳定断言
  const plan = T.typingPlan('你好，请问这个商品多少钱？', { rng: T.makeSeededRng(13) })
  const last = plan[plan.length - 1]
  assert.ok(T.PUNCT_CHARS.includes(last.text[last.text.length - 1]),
    `最后一块应以标点结尾，实测 ${JSON.stringify(last.text)}`)

  const median = [...plan.map((c) => c.delayMs)].sort((a, b) => a - b)[
    Math.floor(plan.length / 2)]
  assert.ok(last.delayMs > median,
    `标点后的停顿（${last.delayMs}）应明显长于中位停顿（${median}）`)
  assert.ok(last.delayMs > 0)
})

test('时序：非字符串输入不抛错', () => {
  for (const v of [null, undefined, 0, 12345]) {
    assert.doesNotThrow(() => T.typingPlan(v, { rng: T.makeSeededRng(1) }))
  }
  assert.deepStrictEqual(T.typingPlan(null), [])
})

test('时序：活跃时段抖动只向内收，绝不延长窗口', () => {
  const ah = { tz_offset_minutes: 480, windows: [['08:00', '23:00']] }
  const rng = T.makeSeededRng(2026)
  const sMin = G.toMinutes('08:00')
  const eMin = G.toMinutes('23:00')

  let drifted = 0
  for (let i = 0; i < 200; i++) {
    const w = T.dailyActiveHoursDrift(ah, rng)
    assert.strictEqual(w.length, 1)
    const s = G.toMinutes(w[0][0])
    const e = G.toMinutes(w[0][1])
    assert.ok(s >= sMin, `起点不得提前：${w[0][0]}`)
    assert.ok(e <= eMin, `终点不得延后：${w[0][1]}`)
    assert.ok(s < e, '抖动后仍需是有效窗口')
    drifted += (s > sMin || e < eMin) ? 1 : 0
  }
  assert.ok(drifted > 0, '抖动必须真的发生（否则等于固定时段）')

  // 极端 rng：全部取最大值 → 起止同时内收，但不得反转
  const wMax = T.dailyActiveHoursDrift(ah, () => 0.999999)
  const s2 = G.toMinutes(wMax[0][0])
  const e2 = G.toMinutes(wMax[0][1])
  assert.ok(s2 >= sMin && e2 <= eMin && s2 < e2)

  // 两小时的小窗口：抖动幅度受限，仍不得反转或超界
  const small = { tz_offset_minutes: 480, windows: [['09:00', '11:00']] }
  for (let i = 0; i < 50; i++) {
    const w = T.dailyActiveHoursDrift(small, rng)
    const s = G.toMinutes(w[0][0])
    const e = G.toMinutes(w[0][1])
    assert.ok(s >= G.toMinutes('09:00') && e <= G.toMinutes('11:00') && s < e,
      `小窗口抖动越界：${w[0][0]}~${w[0][1]}`)
  }

  // 未配置窗口 = 不限时段，原样返回空数组
  assert.deepStrictEqual(T.dailyActiveHoursDrift({ windows: [] }), [])
  assert.deepStrictEqual(T.dailyActiveHoursDrift(null), [])
  // 非法（跨天）窗口原样保留，交 guard 判定
  const wrap = T.dailyActiveHoursDrift({ windows: [['23:00', '01:00']] }, rng)
  assert.deepStrictEqual(wrap, [['23:00', '01:00']])
})

test('时序：pickDelayUntilActiveHours 窗口内返回 0，窗口外返回正数', () => {
  const ah = { tz_offset_minutes: 480, windows: [['08:00', '23:00']] }

  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 12, 0), ah), 0, '窗口内应为 0')
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 8, 0), ah), 0, '起点含')
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 22, 59), ah), 0, '终点前含')

  // 07:00 → 还有 1 小时
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 7, 0), ah), 3600000)
  // 23:30 → 明天的 08:00，共 8.5 小时
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 23, 30), ah), (8 * 60 + 30) * 60000)
  // 03:00 → 当天 08:00，5 小时
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 3, 0), ah), 5 * 3600000)

  // 返回值永远非负（负值会让 setTimeout 立刻触发 → 无间隔发送）
  for (const h of [0, 3, 7, 9, 15, 23]) {
    for (const m of [0, 30, 59]) {
      const v = T.pickDelayUntilActiveHours(localTime(0, h, m), ah)
      assert.ok(v >= 0, `${h}:${m} 返回了负值 ${v}`)
    }
  }

  // 未配置 = 不限时段
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 3, 0), { windows: [] }), 0)
  assert.strictEqual(T.pickDelayUntilActiveHours(localTime(0, 3, 0), null), 0)
  assert.throws(() => T.pickDelayUntilActiveHours('abc', ah), /非法时刻/)
})

test('时序：describeIntervalDistribution 暴露分布健康指标', () => {
  const d = T.describeIntervalDistribution(300, { ...RANGE, rng: T.makeSeededRng(3), buckets: 5 })
  assert.strictEqual(d.n, 300)
  assert.strictEqual(d.buckets, 5)
  assert.strictEqual(d.histogram.length, 5)
  assert.strictEqual(d.inRange + d.outOfRange, d.n)
  assert.ok(d.minSample >= RANGE.minMs && d.maxSample <= RANGE.maxMs)
  assert.ok(d.mean > RANGE.minMs && d.mean < RANGE.maxMs)
})

// ══════════════════════════════════════════════════════════
// §4 审计日志
// ══════════════════════════════════════════════════════════

/** 造一条够长的中文正文，用于验证"正文不得入库" */
const LONG_CN = '这是一条很长的中文评论原文，不应该出现在审计日志里'

test('审计：禁用字段被脱敏（非严格模式仍要落盘）', () => {
  const h = makeFixture()
  try {
    const rec = h.audit.append({
      kind: 'security_event',
      event: 'privacy_probe',
      detail: { comment: LONG_CN, sec_uid: 'MS4wLjABAAAA', cookie: 'sessionid=abc' },
    })
    assert.strictEqual(rec.detail.comment, '[redacted]')
    assert.strictEqual(rec.detail.sec_uid, '[redacted]')
    assert.strictEqual(rec.detail.cookie, '[redacted]')

    // ⚠️ 落盘内容里绝不能出现原文
    const raw = fs.readFileSync(path.join(h.dir, A.AUDIT_FILE), 'utf8')
    assert.ok(!raw.includes(LONG_CN), '⚠️ 评论原文不得出现在审计文件里')
    assert.ok(!raw.includes('MS4wLjABAAAA'), '⚠️ sec_uid 不得出现在审计文件里')
    assert.ok(!raw.includes('sessionid=abc'), '⚠️ cookie 不得出现在审计文件里')

    // 必须留痕（不静默）
    assert.ok(h.warnings.some((w) => w.event === 'audit_sanitized'), '脱敏必须告警')
  } finally { h.cleanup() }
})

test('审计：strict 模式下禁用字段直接抛错，且不写盘', () => {
  const h = makeFixture()
  try {
    assert.throws(() => h.audit.append({
      kind: 'security_event',
      event: 'probe',
      detail: { comment: LONG_CN },
    }, { strict: true }), (e) => {
      assert.ok(e instanceof AppError, '必须是登记过的 AppError')
      assert.strictEqual(e.code, 'REPORT_PRIVACY_VIOLATION')
      assert.strictEqual(e.status, 400)
      return true
    })

    const stats = h.audit.stats()
    assert.strictEqual(stats.byKind.security_event, 0, '被拒的条目不得落盘')
  } finally { h.cleanup() }
})

test('审计：sanitizeForAudit 是纯函数，且能处理环与非法类型', () => {
  const obj = { kind: 'security_event', event: 'x', nested: { reply: '回复原文' } }
  obj.self = obj // 环
  obj.big = 10n
  const { value, leakedKeys } = A.sanitizeForAudit(obj)
  assert.strictEqual(value.nested.reply, '[redacted]')
  assert.strictEqual(value.self, '[circular]')
  assert.strictEqual(value.big, '10', 'BigInt 必须转字符串（JSON.stringify 不支持）')
  assert.ok(leakedKeys.includes('nested.reply'))
  assert.doesNotThrow(() => JSON.stringify(value), '脱敏结果必须可 JSON 序列化')

  // 合法的哈希/计数字段不得被误判（privacy.js 的教训：精确键名匹配）
  const ok = A.sanitizeForAudit({
    kind: 'send_result', contentHash: 'abc', userKeyHash: 'def', targetHash: 'ghi',
    platformStatusCode: 0, verdict: 'sent_confirmed',
  })
  assert.deepStrictEqual(ok.leakedKeys, [], '合法哈希字段不得被判为隐私')
  assert.strictEqual(ok.value.contentHash, 'abc')

  // ⚠️ 结构性豁免只对"值是普通对象、且是该容器的直接子键"生效：
  //    applied_limits.comment 是**渠道名**（结构），不脱敏；
  //    comment: "正文" 是**内容**，必须脱敏；
  //    容器里再嵌一层同名键，也必须脱敏。
  const structural = A.sanitizeForAudit({
    kind: 'policy_applied',
    applied_limits: { comment: { daily_max: 5 }, dm: { daily_max: 10 } },
    note: { comment: LONG_CN },
    deeper: { applied_limits: { x: { comment: LONG_CN } } },
  })
  assert.deepStrictEqual(structural.leakedKeys, ['note.comment', 'deeper.applied_limits.x.comment'],
    '⚠️ 渠道名 comment 不得被判为隐私，但正文 comment 必须被判出（含嵌套）')
  assert.strictEqual(structural.value.applied_limits.comment.daily_max, 5)
  assert.strictEqual(structural.value.note.comment, '[redacted]',
    '⚠️ 值不是对象时，comment 键必须照常脱敏（堵住绕道）')
  assert.strictEqual(structural.value.deeper.applied_limits.x.comment, '[redacted]',
    '⚠️ 豁免不得无限向下传递（嵌套层仍要脱敏）')

  // 字符串形态的 comment（真正的正文）必须脱敏
  const strComment = A.sanitizeForAudit({ kind: 'security_event', comment: LONG_CN })
  assert.strictEqual(strComment.value.comment, '[redacted]')
  assert.ok(strComment.leakedKeys.includes('comment'))
})

test('审计：⚠️ applied:false + rejectCode 必须被记录（关键证据）', () => {
  const h = makeFixture()
  try {
    h.audit.recordConfigChange({
      fieldKey: 'limits.comment.daily_max',
      oldValue: 30,
      newValue: 200,
      source: 'user',
      actor: 'local_user',
      applied: false,
      rejectCode: 'POLICY_VIOLATION',
      policyVersion: 9,
      atMs: BASE,
    })
    const rows = h.audit.query({ kind: 'config_change' })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].applied, false)
    assert.strictEqual(rows[0].rejectCode, 'POLICY_VIOLATION')
    assert.strictEqual(rows[0].oldValue, '30', '取值一律字符串化')
    assert.strictEqual(rows[0].newValue, '200')
    assert.strictEqual(rows[0].source, 'user')
    assert.strictEqual(rows[0].actor, 'local_user')

    // ⚠️ applied=false 缺 rejectCode → 抛错（不允许静默丢掉这条证据）
    assert.throws(() => h.audit.recordConfigChange({
      fieldKey: 'limits.comment.daily_max', oldValue: 30, newValue: 200,
      source: 'user', actor: 'local_user', applied: false,
    }), /reject_code/)

    // 枚举闭集
    assert.throws(() => h.audit.recordConfigChange({
      fieldKey: 'x', oldValue: 1, newValue: 2, source: 'hacker', actor: 'local_user', applied: true,
    }), /source/)
    assert.throws(() => h.audit.recordConfigChange({
      fieldKey: 'x', oldValue: 1, newValue: 2, source: 'user', actor: 'nobody', applied: true,
    }), /actor/)
    assert.throws(() => h.audit.recordConfigChange({
      fieldKey: 'x', oldValue: 1, newValue: 2, source: 'user', actor: 'local_user',
    }), /applied/)

    // 成功的变更同样要记
    h.audit.recordConfigChange({
      fieldKey: 'limits.comment.min_interval_ms', oldValue: 60000, newValue: 120000,
      source: 'user', actor: 'local_user', applied: true, atMs: BASE + 1,
    })
    assert.strictEqual(h.audit.query('config_change').length, 2)
  } finally { h.cleanup() }
})

test('审计：policy_applied 记录**实际生效值**而非服务端下发值（红线 3）', () => {
  const h = makeFixture()
  try {
    h.guard.applyPolicy(stablePolicy())
    // 商家把日上限调低 → 实际生效 5，服务端下发 30
    h.guard.setOverride('comment', 'daily_max', 5)
    h.guard.setOverride('comment', 'min_interval_ms', 300000)
    const eff = h.guard.effectiveLimits('comment')
    assert.strictEqual(eff.daily_max, 5)
    assert.notStrictEqual(eff.daily_max, h.guard.policy.limits.comment.daily_max,
      '测试前提：生效值必须与服务端下发值不同')

    h.audit.recordPolicyApplied({
      policyVersion: h.guard.policy.policy_version,
      policyHash: h.guard.policy.policy_hash,
      appliedLimits: {
        comment: eff,
        live_danmaku: h.guard.effectiveLimits('live_danmaku'),
        dm: h.guard.effectiveLimits('dm'),
        active_hours: h.guard.policy.active_hours,
      },
      accountTier: h.guard.policy.account_tier,
      atMs: BASE,
    })

    const rows = h.audit.query('policy_applied')
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].policyVersion, 9)
    // ⚠️ 字段名是契约原名 applied_limits，不是 appliedLimits
    //    （写成驼峰会让 privacy.js 的结构豁免失效，值被脱敏成 [redacted]）
    assert.strictEqual(A.APPLIED_LIMITS_KEY, 'applied_limits')
    assert.strictEqual(rows[0].applied_limits.comment.daily_max, 5,
      '⚠️ 必须记实际生效值（5），不是服务端下发值（30）')
    assert.strictEqual(rows[0].applied_limits.comment.min_interval_ms, 300000)
    assert.strictEqual(rows[0].applied_limits.dm.content_similarity_max,
      h.guard.policy.limits.dm.content_similarity_max)
    assert.strictEqual(rows[0].accountTier, 'stable')
    assert.ok(rows[0].activeHours, '活跃时段也要留痕（它同样是"只能调短"的项）')

    // 缺失字段一律拒绝
    assert.throws(() => h.audit.recordPolicyApplied({ appliedLimits: {} }), /policy_version/)
    assert.throws(() => h.audit.recordPolicyApplied({ policyVersion: 9 }), /applied_limits/)
  } finally { h.cleanup() }
})

test('审计：八类条目都能写，未知类型被拒', () => {
  const h = makeFixture()
  try {
    h.audit.recordSendAttempt({ sendId: 's-1', sourceType: 'comment', atMs: BASE })
    h.audit.recordSendResult({
      sendId: 's-1', sourceType: 'comment', verdict: 'sent_confirmed',
      confirmSignal: 'platform_response', platformStatusCode: 0, atMs: BASE + 1,
    })
    h.audit.recordConfigChange({
      fieldKey: 'active_hours', oldValue: 'a', newValue: 'b',
      source: 'server_policy', actor: 'license_server', applied: true, atMs: BASE + 2,
    })
    h.audit.recordPolicyApplied({
      policyVersion: 9, appliedLimits: { comment: { daily_max: 30 } }, atMs: BASE + 3,
    })
    h.audit.recordCircuit({
      event: 'escalate', level: 'l1', untilMs: BASE + 1800000,
      reason: 'risk_control_rejected', atMs: BASE + 4,
    })
    h.audit.recordEmergencyStop({ on: true, reason: '商家手动急停', atMs: BASE + 5 })
    h.audit.recordLogin({ event: 'login', ok: true, atMs: BASE + 6 })
    h.audit.recordSecurityEvent({ event: 'sign_verify_failed', atMs: BASE + 7 })

    const stats = h.audit.stats()
    assert.strictEqual(stats.total, 8)
    for (const k of A.AUDIT_KINDS) {
      assert.strictEqual(stats.byKind[k], 1, `${k} 应各有一条`)
    }

    // 未知类型 / 缺失类型一律拒绝（闭集）
    assert.throws(() => h.audit.append({ kind: 'nope', tsMs: BASE }), /未知的审计条目类型/)
    assert.throws(() => h.audit.append({ tsMs: BASE }), /未知的审计条目类型/)
    assert.throws(() => h.audit.append(null), /必须是对象/)
    assert.throws(() => h.audit.append({ kind: 'login', tsMs: 'x' }), /时间戳非法/)
    assert.throws(() => h.audit.query({ kind: 'nope' }), /未知的审计条目类型/)

    // 业务侧的会籍校验
    assert.throws(() => h.audit.recordSendResult({
      sendId: 's-2', sourceType: 'comment', verdict: 'made_up',
    }), /verdict/)
    assert.throws(() => h.audit.recordSendResult({
      sendId: 's-2', sourceType: 'comment', verdict: 'failed',
    }), /failure_reason/)
    assert.throws(() => h.audit.recordSendAttempt({ sourceType: 'comment' }), /send_id/)
    assert.throws(() => h.audit.recordSendAttempt({ sendId: 's-3', sourceType: 'weibo' }), /未知渠道/)
    assert.throws(() => h.audit.recordCircuit({ event: 'wat' }), /未知熔断事件/)
    assert.throws(() => h.audit.recordSecurityEvent({}), /event/)
  } finally { h.cleanup() }
})

test('审计：query 按类型与时间过滤，limit 取最新 N 条', () => {
  const h = makeFixture()
  try {
    for (let i = 0; i < 5; i++) {
      h.audit.recordLogin({ event: 'login', ok: true, atMs: BASE + i * 1000 })
    }
    for (let i = 0; i < 3; i++) {
      h.audit.recordSecurityEvent({ event: 'probe', atMs: BASE + 10000 + i * 1000 })
    }

    assert.strictEqual(h.audit.query().length, 8, '无参数返回全部')
    assert.strictEqual(h.audit.query('login').length, 5, '字符串参数按 kind 过滤')
    assert.strictEqual(h.audit.query({ kind: 'security_event' }).length, 3)
    assert.strictEqual(h.audit.count('login'), 5)

    const win = h.audit.query({ fromMs: BASE + 2000, toMs: BASE + 4000 })
    assert.deepStrictEqual(win.map((r) => r.tsMs), [BASE + 2000, BASE + 3000, BASE + 4000],
      '时间窗过滤应含两端')

    const last2 = h.audit.query({ kind: 'login', limit: 2 })
    assert.deepStrictEqual(last2.map((r) => r.tsMs), [BASE + 3000, BASE + 4000], 'limit 取最新 N 条')

    const asc = h.audit.query()
    for (let i = 1; i < asc.length; i++) {
      assert.ok(asc[i].tsMs >= asc[i - 1].tsMs, '结果必须按时间升序')
    }
  } finally { h.cleanup() }
})

test('审计：单行损坏不中断读取，且损坏数被计数上报', () => {
  const h = makeFixture()
  try {
    h.audit.recordLogin({ event: 'login', atMs: BASE })
    h.audit.recordLogin({ event: 'login', atMs: BASE + 1000 })
    // 手工插入两行坏数据（模拟上次写入被中断留下的半行）
    fs.appendFileSync(path.join(h.dir, A.AUDIT_FILE), '{ 这不是 JSON\n', 'utf8')
    fs.appendFileSync(path.join(h.dir, A.AUDIT_FILE), 'also-bad\n', 'utf8')
    h.audit.recordLogin({ event: 'login', atMs: BASE + 2000 })

    const rows = h.audit.query('login')
    assert.strictEqual(rows.length, 3, '坏行不得影响其余条目的读取')
    assert.strictEqual(rows.corruptLines, 2, '⚠️ 损坏行必须被计数（不静默吞掉）')
    assert.ok(h.warnings.some((w) => w.event === 'audit_corrupt_line'), '损坏必须告警')

    const stats = h.audit.stats()
    assert.strictEqual(stats.corruptLines, 2)
    assert.strictEqual(stats.byKind.login, 3)
  } finally { h.cleanup() }
})

test('审计：超过大小阈值时轮转到 audit-log.1.jsonl，且保留窗口连续不空洞', () => {
  // 8KB 阈值 + ~1.1KB 条目 ≈ 每代 8 条。24 条 → 必然多代轮转。
  const h = makeFixture({ maxBytes: 8 * 1024 })
  try {
    const filler = 'x'.repeat(1000)
    const TOTAL = 24
    for (let i = 0; i < TOTAL; i++) {
      h.audit.append({
        kind: 'security_event', event: 'bulk', detail: { note: filler }, tsMs: BASE + i,
      })
    }
    assert.ok(h.audit.rotations >= 1, '应发生过轮转')
    assert.ok(h.store.exists(A.AUDIT_FILE_ROTATED), '轮转文件必须存在')

    const mainBytes = fs.statSync(path.join(h.dir, A.AUDIT_FILE)).size
    assert.ok(mainBytes <= 8 * 1024 + 200,
      `轮转后主文件不得超过阈值太多，实测 ${mainBytes}`)

    const all = h.audit.query({ includeRotated: true })
    const bulk = all.filter((r) => r.event === 'bulk').map((r) => r.tsMs - BASE)
    // 生成的条目必须全部出现（没有凭空消失），且保留下来的必须是**连续的最近一段**
    assert.deepStrictEqual(bulk, [...new Set(bulk)].sort((a, b) => a - b),
      '⚠️ 不得出现重复条目（轮转把同一条写两次）')
    const newest = TOTAL - 1
    assert.strictEqual(bulk[bulk.length - 1], newest, '最新一条必须还在')
    for (let k = 0; k < bulk.length; k++) {
      assert.strictEqual(bulk[bulk.length - 1 - k], newest - k,
        '⚠️ 保留窗口必须是连续的最近 N 条，不得出现空洞（空洞=静默丢条目）')
    }
    // 保留窗口受 maxBytes 约束：至少 2 代，且不会无限增长
    assert.ok(bulk.length >= 8, `保留窗口过小：${bulk.length} 条`)
    assert.ok(bulk.length * 1100 <= 2 * 8 * 1024 + 4096,
      `保留窗口超出 2×maxBytes 的有界约束：${bulk.length} 条`)

    assert.ok(all.some((r) => r.event === 'audit_log_rotated'), '轮转动作本身要留痕')

    // 默认（不含轮转文件）只能读到主文件里的那部分，且按时间升序
    const main = h.audit.query()
    assert.ok(main.length < all.length)
    for (let i = 1; i < main.length; i++) assert.ok(main[i].tsMs >= main[i - 1].tsMs)
  } finally { h.cleanup() }
})

test('审计：阈值足够大时轮转**不丢任何条目**（关键证据不能被清掉）', () => {
  // 40 条 × ~1.1KB ≈ 44KB；阈值取 24KB（约 21 条/代）→ 两代足以装下全部 40 条
  const h = makeFixture({ maxBytes: 24 * 1024 })
  try {
    const filler = 'x'.repeat(1000)
    const TOTAL = 40
    for (let i = 0; i < TOTAL; i++) {
      h.audit.append({
        kind: 'security_event', event: 'bulk', detail: { note: filler }, tsMs: BASE + i,
      })
    }
    assert.ok(h.audit.rotations >= 1, '应发生过轮转')
    const all = h.audit.query({ includeRotated: true })
    const bulk = all.filter((r) => r.event === 'bulk')
    assert.strictEqual(bulk.length, TOTAL,
      `⚠️ 保留窗口足够时轮转不得丢条目：实测 ${bulk.length}/${TOTAL}`)
    // 轮转本身报出来的 dropped 也必须是 0
    const markers = all.filter((r) => r.event === 'audit_log_rotated')
    assert.ok(markers.every((m) => m.dropped === 0), '保留窗口足够时 dropped 必须为 0')
  } finally { h.cleanup() }
})

test('审计：本地先落盘，再进上报队列；队列挂钩抛错不影响本地落盘', () => {
  const h = makeFixture()
  try {
    const queued = []
    const dir2 = tmpDir('dsh-safety-q-')
    const store2 = new Store({ dir: dir2 })
    try {
      const log = new A.AuditLog({
        store: store2, now: () => BASE, onEntry: (r) => queued.push(r),
      })
      log.recordLogin({ event: 'login', atMs: BASE })
      assert.strictEqual(queued.length, 1, '本地落盘后必须进上报队列')
      assert.strictEqual(queued[0].kind, 'login')

      // 挂钩抛错：本地仍必须留下这条（审计不能因为上报层故障而缺失）
      const warnings = []
      const log2 = new A.AuditLog({
        store: store2, now: () => BASE,
        onEntry: () => { throw new Error('queue full') },
        onWarn: (e) => warnings.push(e),
      })
      log2.recordLogin({ event: 'login', atMs: BASE + 1 })
      assert.strictEqual(log2.query('login').length, 2)
      assert.ok(warnings.some((w) => w.event === 'audit_enqueue_failed'), '上报入库失败必须告警')
    } finally {
      store2.close()
      rmDir(dir2)
    }
  } finally { h.cleanup() }
})

test('审计：绝不 require node:fs 写盘（单写者约束）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'safety', 'audit.js'), 'utf8')
  assert.ok(!/require\(\s*['"](?:node:)?fs['"]\s*\)/.test(src),
    '审计模块不得直接 require fs —— 写盘一律经 store（AGENTS.md §2.9）')
  assert.ok(!/writeFileSync|appendFileSync|mkdirSync/.test(src),
    '审计模块不得直接调用 fs 写 API')
})

// ══════════════════════════════════════════════════════════
// §5 全局红线自查（四个模块一起看）
// ══════════════════════════════════════════════════════════

test('红线自查：四个模块无空 catch、无 fs、无第三方依赖、无硬编码限额', () => {
  const files = ['similarity.js', 'circuit.js', 'timing.js', 'audit.js']
  for (const f of files) {
    const p = path.join(__dirname, '..', '..', 'client', 'safety', f)
    const src = fs.readFileSync(p, 'utf8')
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    assert.ok(src.startsWith("'use strict'"), `${f} 必须有 'use strict' 头`)
    assert.ok(!/[^a-zA-Z]catch\s*(\([^)]*\))?\s*\{\s*\}/.test(code), `${f} 不得有空 catch`)
    assert.ok(!/require\(\s*['"]fs['"]\s*\)|require\(\s*['"]node:fs['"]\s*\)/.test(src),
      `${f} 不得 require fs`)
    assert.ok(!/\bimport\s|\bexport\s+(const|function|default)/.test(src), `${f} 必须是 CommonJS`)
    assert.ok(!/\b(?:daily_?max|min_?interval\w*)\s*[:=]\s*\d/.test(src),
      `${f} 不得硬编码日上限 / 最小间隔`)
    // 只允许内置模块与项目内相对路径
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1]
      assert.ok(spec.startsWith('.') || spec.startsWith('node:'),
        `${f} 引入了白名单外的依赖：${spec}`)
    }
  }
})
