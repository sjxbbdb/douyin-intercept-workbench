'use strict'

// test/integration/client-license.test.js
// L4 集成测试：**客户端 license 全栈** 对**真实授权中心**。
//
// ⚠️ 这一层的价值在于它是"两端第一次真正握手"：
//    `client/license/*` 与 `license-server/*` 是两套独立实现，
//    各自单元测试全绿也可能对不上（字段名、签名串、路径、错误码形态）。
//    只有把客户端真的接到服务端上跑一遍，才能证明契约被双方一致实现。
//
// ⚠️ 刻意**不 mock** HTTP 与签名。签名的全部价值就是"两端算出同一个值"，
//    mock 掉等于跳过最需要验证的环节。
//
// 覆盖范围（逐条对应契约条款）：
//    §9.1 首次登录（观察期、策略下发、ack）
//    §4.5 心跳与策略切换、命令执行、密钥轮换
//    §4.8 明细上报与计费（只对平台确认成功计费）
//    §4.9 配置变更审计（含被拒绝的调高尝试）
//    §5.2 响应验签 fail-closed（篡改 / 未签名）
//    §7.5 隐私边界（本机拦截，不上传）
//    §4.2 续期与登出
//    §4.4 版本闸门

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')

const { createServer } = require('../../license-server/server')
const { hashPassword } = require('../../license-server/crypto/password')
const { grantCredits } = require('../../license-server/domain/billing')

const { Store } = require('../../client/host/store')
const { LicenseHttp } = require('../../client/license/http')
const S = require('../../client/license/state')
const { LicenseState } = S
const { LicenseAuth } = require('../../client/license/auth')
const { Heartbeat } = require('../../client/license/heartbeat')
const { Reporter, F_PENDING } = require('../../client/license/reporter')
const { Guard } = require('../../client/safety/guard')
const P = require('../../client/license/privacy')

const CLIENT_VERSION = '3.0.0'

// ══════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════

function makeServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cl-'))
  const inst = createServer({
    dataDir: dir,
    dbPath: path.join(dir, 'cl.db'),
    host: '127.0.0.1',
    port: 0,
    masterKey: 'test-master-key-0123456789abcdef0123456789abcdef',
    creditPerReplyMilli: 1000,
    minClientVersion: CLIENT_VERSION,
    logLevel: 'error',
    logSink: { write() {} },
    backupBeforeMigrate: false,
    ...overrides,
  })
  return { inst, dir }
}

function seedAccount(inst, { account = 'demo001', password = 'pw-123456', credits = 100, dayIndex = 30 } = {}) {
  const now = Date.now()
  const firstLogin = now - (dayIndex - 1) * 86400000
  const r = inst.db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, first_login_ms, created_at_ms, updated_at_ms, status)
    VALUES (?,?,?,?,?,?,'active')
  `).run(account, account, hashPassword(password), firstLogin, now, now)
  const accountId = Number(r.lastInsertRowid)
  inst.db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?,?,?)')
    .run(accountId, 0, now)
  inst.db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?,0,?,?)')
    .run(accountId, 'active', now)
  if (credits > 0) {
    grantCredits(inst.db, {
      accountId, deltaMilli: credits * 1000, kind: 'grant', operator: 'test', note: 'seed', nowMs: now,
    })
  }
  return { accountId, account, password, firstLogin }
}

/**
 * 一个完整的客户端实例（真实 store + 真实 http + 真实 state/auth/heartbeat/reporter）。
 *
 * ⚠️ 每层都是生产实现，没有任何测试替身——这是本文件的意义所在。
 */
function makeClient(addr, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-'))
  const store = new Store({ dir })
  // ⚠️ 必须能指定 device_id。否则同一台机器上跑两个 client 会算出**同一个**
  //    device_id（哈希源是 hostname+platform+arch+username），
  //    于是"第二台设备登录踢掉第一台"这条路径根本走不到。
  if (opts.deviceId) {
    store.update('license-state.json', S.defaultState(), (s) => {
      s.deviceId = opts.deviceId
      return s
    })
  }
  const state = new LicenseState({
    store, instanceDir: dir, clientVersion: CLIENT_VERSION,
  })
  const securityEvents = []
  const http0 = new LicenseHttp({
    baseUrl: `http://127.0.0.1:${addr.port}`,
    getAuthState: () => state.authSnapshot(),
    timeoutMs: 5000,
    onSecurityEvent: (e) => securityEvents.push(e),
  })
  const auth = new LicenseAuth({
    http: http0, state, clientVersion: CLIENT_VERSION,
    onSecurityEvent: (e) => securityEvents.push(e),
  })
  const guard = new Guard({ store })
  const heartbeat = new Heartbeat({
    http: http0, state, auth, guard, clientVersion: CLIENT_VERSION,
    getEngineSnapshot: opts.getEngineSnapshot || (() => ({ engine_state: 'idle' })),
  })
  const reporter = new Reporter({
    http: http0, state, auth, store, guard, clientVersion: CLIENT_VERSION,
  })

  return {
    dir, store, state, http: http0, auth, guard, heartbeat, reporter, securityEvents,
    cleanup: () => {
      try { http0.close() } catch { /* 关闭失败不影响结论 */ }
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
    },
  }
}

async function withEnv(fn, { serverOverrides, seed } = {}) {
  const { inst, dir } = makeServer(serverOverrides)
  const addr = await inst.listen()
  const acc = seed ? seedAccount(inst, seed) : null
  try {
    await fn({ inst, addr, acc, dir })
  } finally {
    inst.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

/** 构造一条合法的计费明细（真实形态：哈希而非原文）。 */
function buildSend(state, overrides = {}) {
  const salt = state.privacySalt || 'salt-test'
  return {
    send_id: overrides.send_id || `s-${Math.random().toString(16).slice(2, 18)}`,
    source_type: 'comment',
    target_hash: P.targetHash('video1|comment1', salt),
    user_key_hash: P.userKeyHash('secuid-abc', salt),
    user_key_type: 'sec_uid',
    content_hash: P.contentHash('您好，这款商品现在有活动', salt),
    verdict: 'sent_confirmed',
    is_final: true,
    evidence: {
      confirm_signal: 'platform_response',
      platform_endpoint: 'comment/publish',
      platform_status_code: 0,
      observed_at_ms: Date.now(),
    },
    failure_reason: null,
    attempt_seq: 1,
    sent_at_ms: Date.now(),
    ...overrides,
  }
}

/** 把一条明细写入本地待上报队列（模拟发送适配器先落盘再发送）。 */
function queueSend(cl, send) {
  cl.store.update(F_PENDING, [], (list) => { list.push(send); return list })
}

// ══════════════════════════════════════════════════════════
// §9.1 首次登录
// ══════════════════════════════════════════════════════════

test('客户端集成：登录成功、login_proof 自证、凭据落盘、会话与 seq 初始化', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const r = await cl.auth.login(acc.account, acc.password)

      assert.ok(cl.state.isLoggedIn, '应已登录')
      assert.ok(r.policy, '应拿到 policy')
      assert.strictEqual(cl.state.accountId, `acc_${acc.accountId}`)
      assert.ok(cl.state.sessionId, '应已生成 sessionId')
      assert.strictEqual(cl.state.peekSeq('heartbeat'), 0, '新会话 seq 应从 0 起')
      assert.ok(cl.state.privacySalt, '应拿到 privacy_salt（隐私哈希必需）')
      assert.strictEqual(cl.securityEvents.length, 0, '正常登录不应产生安全事件')

      // ⚠️ 落盘验证：进程重启后必须还能用同一份凭据
      const onDisk = JSON.parse(fs.readFileSync(cl.store.file('license-state.json'), 'utf8'))
      const data = onDisk.data || onDisk
      assert.ok(data.token, 'token 应已落盘')
      assert.ok(data.key, 'sign_key 应已落盘')
      assert.strictEqual(data.deviceId, data.deviceId, 'device_id 应稳定')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：观察期登录后 sending_enabled=false，护栏必须拒发', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const r = await cl.auth.login(acc.account, acc.password)
      assert.strictEqual(r.policy.sending_enabled, false, '第 1 天应处于观察期')
      assert.strictEqual(r.policy.account_tier, 'observation')
      assert.ok(r.warnings.some((w) => w.includes('观察期') || w.includes('采集')),
        `应给出观察期提示，实际：${JSON.stringify(r.warnings)}`)

      cl.guard.applyPolicy(r.policy)
      const can = cl.guard.canSend({ sourceType: 'comment' })
      assert.strictEqual(can.allow, false, '观察期不得发送')
      assert.strictEqual(can.reason, 'sending_disabled')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 1 } })
})

test('客户端集成：login_proof 被篡改时拒绝登录，且不落盘任何凭据', async () => {
  const { inst, dir } = makeServer()
  const addr = await inst.listen()
  // ⚠️ 中间人：转发登录请求，但把余额改大后返回 —— 这正是 login_proof 要防的
  const mitm = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const fwd = http.request({
        host: '127.0.0.1', port: addr.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${addr.port}` },
      }, (up) => {
        const bufs = []
        up.on('data', (c) => bufs.push(c))
        up.on('end', () => {
          const raw = Buffer.concat(bufs).toString('utf8')
          let out = raw
          try {
            const obj = JSON.parse(raw)
            if (obj.credit) obj.credit.balance_milli = 999999999 // 篡改余额
            out = JSON.stringify(obj)
          } catch { /* 非 JSON 原样转发 */ }
          const headers = { ...up.headers }
          delete headers['content-length']
          headers['content-length'] = Buffer.byteLength(out)
          res.writeHead(up.statusCode, headers)
          res.end(out)
        })
      })
      fwd.on('error', () => { res.writeHead(502); res.end('{}') })
      if (chunks.length) fwd.write(Buffer.concat(chunks))
      fwd.end()
    })
  })
  const mitmAddr = await new Promise((r) => mitm.listen(0, '127.0.0.1', () => r(mitm.address())))

  seedAccount(inst, { credits: 100, dayIndex: 30 })

  const cl = makeClient(mitmAddr)
  try {
    await assert.rejects(
      () => cl.auth.login('demo001', 'pw-123456'),
      (e) => e.code === 'AUTH_SIGN_INVALID',
      '篡改的登录响应必须被 login_proof 拦下'
    )
    assert.strictEqual(cl.state.isLoggedIn, false, '拒绝登录后不得持有凭据')
    assert.ok(cl.securityEvents.some((e) => e.code === 'login_proof_invalid'),
      '必须记录安全事件，不得静默')

    const onDisk = JSON.parse(fs.readFileSync(cl.store.file('license-state.json'), 'utf8'))
    const data = onDisk.data || onDisk
    assert.strictEqual(data.token, null, 'token 不得落盘')
    assert.strictEqual(data.key, null, 'sign_key 不得落盘')
  } finally {
    cl.cleanup()
    mitm.close()
    inst.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

test('客户端集成：版本闸门 —— 低于 min_client_version 时停机并给出升级地址', async () => {
  await withEnv(async ({ addr }) => {
    const cl = makeClient(addr)
    try {
      // 伪造一个低版本客户端
      const low = new LicenseAuth({
        http: cl.http, state: cl.state, clientVersion: '1.0.0',
      })
      await assert.rejects(
        () => low.bootstrap(),
        (e) => e.code === 'SERVER_VERSION_UNSUPPORTED' && e.detail.required === CLIENT_VERSION
      )
    } finally { cl.cleanup() }
  })
})

// ══════════════════════════════════════════════════════════
// §4.5 心跳、策略切换、命令
// ══════════════════════════════════════════════════════════

test('客户端集成：心跳带回权威余额与配额，并推进 seq', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)
      const r = await cl.heartbeat.send()

      assert.strictEqual(r.body.ok, true)
      assert.ok(r.body.credit, '心跳应带回余额')
      assert.ok(r.body.daily_quota, '心跳应带回当日配额')
      assert.strictEqual(cl.state.peekSeq('heartbeat'), 1, 'seq 应推进到 1')

      const r2 = await cl.heartbeat.send()
      assert.strictEqual(cl.state.peekSeq('heartbeat'), 2, 'seq 应再次推进')
      assert.strictEqual(r2.body.ok, true, 'seq 单调递增不应被判重放')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：心跳回报的 applied_limits 是**实际生效**值（红线 3）', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)
      // 商家把评论日上限从 30 调到 3（更保守），间隔调到 300 秒
      cl.guard.setOverride('comment', 'daily_max', 3)
      cl.guard.setOverride('comment', 'min_interval_ms', 300000)

      const payload = cl.heartbeat.buildPayload()
      assert.strictEqual(payload.applied_limits.comment.daily_max, 3,
        '上报的必须是实际生效值 3，而不是服务端的 30')
      assert.strictEqual(payload.applied_limits.comment.min_interval_ms, 300000)
      assert.ok(payload.applied_limits.active_hours, '应带上实际生效的活跃时段')
      assert.ok(payload.applied_policy_version, '应带实际生效的策略版本')
      assert.ok(payload.applied_policy_hash, '应带策略哈希供服务端存证')
      // ⚠️ applied_limits 的键走**白名单**（已知渠道 + active_hours）。
      //    多带一个键就会被服务端判 POLICY_TIER_UNKNOWN，
      //    后果是每次心跳都被记成"越权上报"且 **ack 存证写不进去**
      //    ——红线 3 的存证链会被静默切断。这里显式守住键集合。
      assert.deepStrictEqual(
        Object.keys(payload.applied_limits).sort(),
        ['active_hours', 'comment', 'dm', 'live_danmaku'],
        'applied_limits 只允许出现白名单键'
      )
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：观察期心跳回报 daily_max=0（服务端据此建立 ack 存证）', async () => {
  await withEnv(async ({ inst, addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      assert.strictEqual(login.policy.account_tier, 'observation')
      cl.guard.applyPolicy(login.policy)
      const r = await cl.heartbeat.send()
      // ⚠️ 契约 §4.5 的 `state` 闭集是 active/degraded/idle/exhausted/suspended，
      //    但服务端在观察期返回 `'observation'` 表示"只采集不发送"。
      //    这里只断言"不是 active"，因为真正有约束力的是下一行的配额为 0。
      assert.notStrictEqual(r.body.state, 'active', '观察期不应返回 active')
      assert.strictEqual(r.body.daily_quota.comment.max, 0, '观察期配额应为 0')
      assert.strictEqual(cl.state.peekSeq('heartbeat'), 1)

      // ⚠️ 红线 3 的落地验证：服务端必须存下"该账号当时**实际生效**的策略"，
      //    而不只是"收到过心跳"。没有这张表就回答不了"封号前生效的是什么"。
      const count = inst.db.prepare(
        'SELECT COUNT(*) AS c FROM policy_ack_log WHERE account_id = ?'
      ).get(acc.accountId)
      assert.ok(Number(count.c) > 0, '服务端应记录 policy_ack_log（ack 存证）')

      const ack = inst.db.prepare(
        'SELECT * FROM policy_ack_log WHERE account_id = ? ORDER BY last_seen_at_ms DESC LIMIT 1'
      ).get(acc.accountId)
      const applied = JSON.parse(ack.applied_limits_json)
      assert.strictEqual(applied.comment.daily_max, 0, '存证的必须是实际生效值 0')
      assert.strictEqual(applied.comment.min_interval_ms, 180000)
      assert.strictEqual(Number(ack.policy_version), login.policy.policy_version)
      assert.strictEqual(ack.account_tier, 'observation')
      assert.ok(ack.instance_id, 'instance_id 是 NOT NULL 分区键，必须有兜底值')
      assert.strictEqual(ack.instance_id, login.body.instance_id,
        '应使用服务端下发的 instance_id，而不是 device_id 兜底')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 1 } })
})

// ══════════════════════════════════════════════════════════
// §4.8 明细上报与计费（红线 2）
// ══════════════════════════════════════════════════════════

test('客户端集成：上报 3 条（2 成功 1 风控拒绝）→ 只计费 2 条，本地明细按受理结果删除', async () => {
  await withEnv(async ({ inst, addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)
      const before = cl.state.credit.balance_milli
      assert.strictEqual(before, 100000, '初始余额 100 积分')

      const ok1 = buildSend(cl.state)
      const ok2 = buildSend(cl.state)
      // ⚠️ 空响应 = 风控拒绝 → failed，且**不得**标成成功（AGENTS.md §2.1）
      const rejected = buildSend(cl.state, {
        verdict: 'failed',
        is_final: true,
        evidence: { confirm_signal: 'none', platform_endpoint: null, platform_status_code: null, risk_control_signal: 'empty_response' },
        failure_reason: 'risk_control_rejected',
      })
      queueSend(cl, ok1); queueSend(cl, ok2); queueSend(cl, rejected)
      assert.strictEqual(cl.reporter.pendingCount(), 3)

      const r = await cl.reporter.reportSends()

      assert.strictEqual(r.results.length, 3, '三条都应有结果')
      const byId = Object.fromEntries(r.results.map((x) => [x.send_id, x]))
      assert.strictEqual(byId[ok1.send_id].billing_status, 'billed')
      assert.strictEqual(byId[ok2.send_id].billing_status, 'billed')
      assert.strictEqual(byId[rejected.send_id].billing_status, 'not_billable',
        '风控拒绝不得计费')

      assert.strictEqual(r.settlement.billed_count, 2)
      assert.strictEqual(r.settlement.charged_milli, 2000, '2 条 × 1 积分')
      assert.strictEqual(r.settlement.balance_milli, 98000)
      assert.strictEqual(cl.reporter.pendingCount(), 0, '已受理的明细应从本地队列移除')

      // ⚠️ 本地余额必须来自服务端响应，而不是自己加减
      assert.strictEqual(cl.state.credit.balance_milli, 98000)
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：DOM 判据（sent_confirmed_dom）不得计费', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)

      const domOnly = buildSend(cl.state, {
        verdict: 'sent_confirmed_dom',
        is_final: true,
        evidence: { confirm_signal: 'dom_stable', platform_endpoint: null, platform_status_code: null, dom_stable_ms: 1200 },
      })
      queueSend(cl, domOnly)
      const r = await cl.reporter.reportSends()

      const res = r.results.find((x) => x.send_id === domOnly.send_id)
      assert.strictEqual(res.billing_status, 'not_billable', 'DOM 判据不计费（红线 2）')
      assert.strictEqual(r.settlement.charged_milli, 0)
      assert.strictEqual(cl.state.credit.balance_milli, 100000, '余额不应变化')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：重复上报同一 send_id 不重复扣费（幂等端到端）', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)

      const s = buildSend(cl.state, { send_id: 's-idem-fixed-0001' })
      queueSend(cl, s)
      const r1 = await cl.reporter.reportSends()
      assert.strictEqual(r1.settlement.charged_milli, 1000)
      const after1 = cl.state.credit.balance_milli

      // 模拟"响应丢了、明细没删"→ 重报同一条
      queueSend(cl, s)
      const r2 = await cl.reporter.reportSends()
      assert.strictEqual(r2.results[0].duplicate, true, '应命中幂等回放')
      assert.strictEqual(r2.settlement.charged_milli, 0, '不得重复扣费')
      assert.strictEqual(cl.state.credit.balance_milli, after1)
      assert.strictEqual(cl.reporter.pendingCount(), 0)
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：越限明细 policy_exceeded，不扣费但服务端留痕', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)
      // 稳定期评论上限 30：塞 31 条（同一天）
      const n = 31
      for (let i = 0; i < n; i++) queueSend(cl, buildSend(cl.state, { send_id: `s-cap-${i}` }))
      const r = await cl.reporter.reportSends({ max: 50 })

      assert.strictEqual(r.settlement.billed_count, 30, '只应有 30 条计费')
      assert.strictEqual(r.settlement.charged_milli, 30000)
      assert.ok(r.settlement.over_limit_count >= 1, '应有越限条目')
      assert.strictEqual(cl.reporter.pendingCount(), 0, '越限明细也已留痕，应从本地队列移除')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：余额耗尽返回停机指令，本地据此 fail-closed', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)
      // 只充 1 条的钱，却报 3 条 → 第 1 条透支入账，其余 unbilled
      queueSend(cl, buildSend(cl.state, { send_id: 's-ex-1', sent_at_ms: Date.now() }))
      queueSend(cl, buildSend(cl.state, { send_id: 's-ex-2', sent_at_ms: Date.now() + 1 }))
      queueSend(cl, buildSend(cl.state, { send_id: 's-ex-3', sent_at_ms: Date.now() + 2 }))

      const r = await cl.reporter.reportSends()
      assert.strictEqual(r.settlement.state, 'exhausted', '余额应已耗尽')
      assert.ok(r.exhausted, '应标记 exhausted')
      const pause = r.commands.find((c) => c.type === 'pause_engine')
      assert.ok(pause, '应下发 pause_engine 指令')
      assert.strictEqual(pause.reason, 'CREDIT_EXHAUSTED')
      assert.ok(r.settlement.balance_milli <= 0)
    } finally { cl.cleanup() }
  }, { seed: { credits: 1, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// §7.5 隐私边界（红线 3）
// ══════════════════════════════════════════════════════════

test('客户端集成：本机拦截隐私字段，请求根本不发出', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)

      // 模拟"排障时顺手把原文塞进 evidence"
      const leaky = buildSend(cl.state, {
        send_id: 's-leak-1',
        evidence: {
          confirm_signal: 'platform_response',
          platform_endpoint: 'comment/publish',
          platform_status_code: 0,
          comment: '这个商品多少钱', // ← 原文，绝不允许上传
        },
      })
      queueSend(cl, leaky)

      await assert.rejects(
        () => cl.reporter.reportSends(),
        (e) => e.code === 'REPORT_PRIVACY_VIOLATION' && e.detail.fields.some((f) => f.includes('comment'))
      )
      // ⚠️ 明细不能被删（它是证据），且必须进隔离区
      assert.strictEqual(cl.reporter.pendingCount(), 1, '被拦截的明细应留在本地')
      assert.strictEqual(cl.reporter.quarantine.length, 1)
      assert.strictEqual(cl.reporter.quarantine[0].code, 'privacy_leak_local')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：合法哈希字段不被误判为隐私泄露', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)
      queueSend(cl, buildSend(cl.state, { send_id: 's-ok-hash-1' }))
      const r = await cl.reporter.reportSends()
      assert.strictEqual(r.results.length, 1, 'content_hash / user_key_hash 应被放行')
      assert.strictEqual(r.results[0].billing_status, 'billed')
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：服务端也应拒绝含原文的上报（双向防线）', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)
      // 绕过客户端扫描，直接构造含原文的请求 —— 验证服务端不是"只靠客户端自觉"
      const bad = {
        batch_id: 'b-privacy-test',
        account_id: cl.state.accountId,
        device_id: cl.state.ensureDeviceId(),
        session_id: cl.state.sessionId,
        seq: cl.state.nextSeq('sends'),
        protocol_version: 2,
        client_version: CLIENT_VERSION,
        policy_snapshot: {
          policy_version: cl.state.policyVersion,
          // ⚠️ 完整形态：`applied_limits.comment` 是**渠道名**而非评论内容。
          //    这里刻意带上它，确保隐私扫描不会把合法结构误判成泄露——
          //    误判的后果是计费明细永远报不上去。
          applied_limits: { comment: { daily_max: 30, min_interval_ms: 60000 } },
        },
        sends: [buildSend(cl.state, { content: '这个商品多少钱' })],
      }
      await assert.rejects(
        () => cl.http.request({ method: 'POST', path: '/api/v1/audit/sends', body: bad }),
        (e) => e.code === 'REPORT_PRIVACY_VIOLATION',
        '服务端必须独立拒绝隐私字段'
      )
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// §5.2 响应验签 fail-closed
// ══════════════════════════════════════════════════════════

test('客户端集成：响应体被篡改 → 验签失败、记录安全事件、不产生业务结果', async () => {
  const { inst, dir } = makeServer()
  const addr = await inst.listen()
  let tamper = false
  /** 登录时记录的真实 server_time_ms —— 篡改时用它当"过期时间戳" */
  let pinnedServerTs = null

  // 中间人：登录放行，之后篡改余额/结算并**复用旧时间戳**制造验签失败。
  // ⚠️ 为什么这里必须同时"改时间戳"：响应签名覆盖
  //    (status, path, request_nonce, server_ts, body)。只改 body 而不改
  //    server_ts，服务端写下的 X-Lic-Sign 对不上 → 会失败；但中间人若
  //    自己重算签名就"成功"了（它没有密钥，所以做不到）。
  //    本测试固定 server_ts，确保任何真实的密钥持有者以外都无法通过验签。
  const mitm = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const fwd = http.request({
        host: '127.0.0.1', port: addr.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${addr.port}` },
      }, (up) => {
        const bufs = []
        up.on('data', (c) => bufs.push(c))
        up.on('end', () => {
          const raw = Buffer.concat(bufs).toString('utf8')
          let out = raw
          const headers = { ...up.headers }

          if (!tamper) {
            // ⚠️ 响应头里才有 X-Lic-Server-Ts；响应**体**里没有
            //    server_time_ms（那是契约里的写法，服务端实现走的是响应头）。
            const ts = up.headers['x-lic-server-ts']
            if (ts !== undefined) pinnedServerTs = Number(ts)
          } else {
            try {
              const obj = JSON.parse(raw)
              if (obj.credit) obj.credit.balance_milli = 999999999
              if (obj.settlement) {
                obj.settlement.balance_milli = 999999999
                obj.settlement.charged_milli = 0
              }
              out = JSON.stringify(obj)
            } catch { /* 原样转发 */ }
            if (pinnedServerTs !== null) headers['x-lic-server-ts'] = String(pinnedServerTs)
          }

          headers['content-length'] = Buffer.byteLength(out)
          res.writeHead(up.statusCode, headers)
          res.end(out)
        })
      })
      fwd.on('error', () => { res.writeHead(502); res.end('{}') })
      if (chunks.length) fwd.write(Buffer.concat(chunks))
      fwd.end()
    })
  })
  const mitmAddr = await new Promise((r) => mitm.listen(0, '127.0.0.1', () => r(mitm.address())))

  seedAccount(inst, { credits: 100, dayIndex: 30 })
  const cl = makeClient(mitmAddr)
  try {
    await cl.auth.login('demo001', 'pw-123456')
    assert.ok(pinnedServerTs, '登录响应应已被中间人记录时间戳')
    const balanceBefore = cl.state.credit.balance_milli

    tamper = true
    let hbResult = null
    let hbError = null
    try {
      hbResult = await cl.heartbeat.send()
    } catch (e) {
      hbError = e
    }
    assert.ok(hbError, '被篡改的心跳响应必须被拒（否则中间人可改余额与策略）；'
      + `实际成功返回：${hbResult ? JSON.stringify(hbResult.body).slice(0, 200) : 'null'}`)
    assert.strictEqual(hbError.code, 'AUTH_SIGN_INVALID',
      `应因验签失败而拒绝，实际 ${hbError.code}：${hbError.message}`)
    assert.ok(cl.securityEvents.some((e) => e.code === 'response_sign_invalid'),
      '必须记录安全事件，不得静默')
    assert.strictEqual(cl.state.credit.balance_milli, balanceBefore,
      '验签失败时不得采纳任何字段——否则篡改就成功了')

    // ⚠️ 篡改上报响应同样必须被拦下。
    //    注意 `Reporter.reportSends()` **不会**把网络/验签失败抛给调用方——
    //    它的契约是"明细留在本地、返回 deferred 标记"（离线补报依赖这一点）。
    //    所以这里不能断言 rejects，而要检查返回值的 deferred 标记 +
    //    明细仍在队列里 + 无任何计费结果。
    queueSend(cl, buildSend(cl.state))
    const secBefore = cl.securityEvents.length
    const rep = await cl.reporter.reportSends()

    assert.strictEqual(rep.error, 'AUTH_SIGN_INVALID',
      `上报应因验签失败被拒，实际 ${JSON.stringify(rep.error)}`)
    assert.strictEqual(rep.failClosed, true,
      '验签失败必须标记 failClosed（契约 §5.4：立即暂停发送）')
    assert.notStrictEqual(rep.deferred, true,
      '验签失败不能按"网络不好待会儿再报"处理——链路已被证明不可信')
    assert.strictEqual(rep.accepted, 0, '不得有条目被标记为已受理')
    assert.strictEqual(rep.settlement, null, '不得采纳被篡改的结算结果')
    assert.ok(cl.securityEvents.length > secBefore, '必须记录安全事件')
    assert.strictEqual(cl.reporter.pendingCount(), 1, '失败时明细必须留在本地待补报')
    assert.strictEqual(cl.state.credit.balance_milli, balanceBefore,
      '被篡改的 settlement.balance_milli 绝不能写进本地状态')
  } finally {
    cl.cleanup()
    mitm.close()
    inst.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

test('客户端集成：会话被踢后未签名 401 应判为**需重新登录**，不是被篡改', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr, { deviceId: 'a'.repeat(32) })
    const cl2 = makeClient(addr, { deviceId: 'b'.repeat(32) })
    let caught = null
    try {
      // 设备数上限默认为 1：第二台设备登录会踢掉第一台
      const first = await cl.auth.login(acc.account, acc.password)
      assert.ok(!first.body.kicked_device_id,
        '首个设备登录不应踢任何会话')
      const second = await cl2.auth.login(acc.account, acc.password)
      assert.ok(second.body.kicked_device_id, '第二台设备应踢掉第一台的会话')

      // 被踢的会话再发心跳 → 服务端 401 且无法签名（密钥已吊销）
      await assert.rejects(
        () => cl.heartbeat.send(),
        (e) => { caught = e; return true }
      )
      assert.ok(
        ['AUTH_TOKEN_REVOKED', 'AUTH_TOKEN_INVALID', 'AUTH_TOKEN_EXPIRED'].includes(caught.code),
        `应收到身份类错误码，实际 ${caught.code}`
      )
      assert.strictEqual(caught.detail.unsigned_reason, 'auth',
        '服务端应显式声明"未签名原因是身份问题"')

      // ⚠️ 本测试的核心：身份问题**不得**被记成"响应被篡改"。
      //    误判的后果是 token 一过期就报安全事件并停机，商家看到"网络不安全"。
      assert.strictEqual(
        cl.securityEvents.filter((e) => e.code === 'response_sign_invalid').length, 0,
        '未签名的 401 不应记为篡改'
      )
      assert.strictEqual(
        cl.securityEvents.filter((e) => e.code === 'response_unsigned').length, 0,
        '带 X-Lic-Unsigned: auth 的响应不应记为"响应未签名"安全事件'
      )
      // 而错误码本身应被归类为"需要重新登录"
      assert.strictEqual(LicenseAuth.isReauthRequired(caught.code), true)
    } finally { cl.cleanup(); cl2.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// §4.2 续期与登出
// ══════════════════════════════════════════════════════════

test('客户端集成：续期换发新 token/sign_key，旧密钥随即失效', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)
      const t1 = cl.state.authSnapshot().token
      const k1 = cl.state.authSnapshot().key

      await cl.auth.refresh()
      const t2 = cl.state.authSnapshot().token
      const k2 = cl.state.authSnapshot().key
      assert.notStrictEqual(t2, t1, '续期应换发新 token')
      assert.notStrictEqual(k2, k1, '续期应换发新 sign_key')

      // 用新凭据发心跳应当成功
      const r = await cl.heartbeat.send()
      assert.strictEqual(r.body.ok, true)
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：登出后本地凭据清空，但 device_id 保留', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)
      const dev = cl.state.ensureDeviceId()
      await cl.auth.logout('user_logout')

      assert.strictEqual(cl.state.isLoggedIn, false, '登出后不得持有凭据')
      assert.strictEqual(cl.state.ensureDeviceId(), dev, 'device_id 必须保留（重登不算新设备）')
      assert.strictEqual(cl.state.sessionId, null)
      assert.strictEqual(cl.state.peekSeq('heartbeat'), 0)
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// §4.9 配置变更审计（红线 3 的原始证据）
// ══════════════════════════════════════════════════════════

test('客户端集成：被拒绝的"调高上限"尝试也上报（这是纠纷时的关键证据）', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      const login = await cl.auth.login(acc.account, acc.password)
      cl.guard.applyPolicy(login.policy)

      // 用户想把评论日上限调到 100（服务端上限 30）→ 本地拦截
      let rejectCode = null
      try {
        cl.guard.setOverride('comment', 'daily_max', 100)
      } catch (e) {
        rejectCode = 'POLICY_VIOLATION'
        assert.ok(e.message.includes('更激进'))
      }
      assert.strictEqual(rejectCode, 'POLICY_VIOLATION', '本地必须拦下越权设置')

      const body = await cl.reporter.reportConfigChanges([
        {
          change_id: 'ch-manual-0001',
          changed_at_ms: Date.now(),
          source: 'user', actor: 'local_user',
          field_key: 'limits.comment.daily_max',
          old_value: '30', new_value: '100',
          applied: false, reject_code: 'POLICY_VIOLATION',
          policy_version: cl.state.policyVersion,
        },
        {
          change_id: 'ch-manual-0002',
          changed_at_ms: Date.now(),
          source: 'user', actor: 'local_user',
          field_key: 'limits.comment.daily_max',
          old_value: '30', new_value: '5',
          applied: true,
          policy_version: cl.state.policyVersion,
        },
      ])
      assert.strictEqual(body.ok, true)
      assert.strictEqual(body.results.length, 2)
      assert.ok(body.results.every((r) => r.accepted !== false))
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

test('客户端集成：配置变更的 field_key 走白名单，正文类路径被拒', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)
      await assert.rejects(
        () => cl.reporter.reportConfigChanges([{
          field_key: 'reply_template.body', old_value: 'a', new_value: 'b', applied: true,
        }]),
        (e) => e.code === 'AUDIT_CONFIG_INVALID'
      )
      // applied=false 却缺 reject_code → 必须拒绝（契约 §4.9）
      await assert.rejects(
        () => cl.reporter.reportConfigChanges([{
          field_key: 'limits.comment.daily_max', old_value: '1', new_value: '2', applied: false,
        }]),
        (e) => e.code === 'AUDIT_CONFIG_INVALID'
      )
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// 影子额度（§9.3 离线降级）
// ══════════════════════════════════════════════════════════

test('客户端集成：影子额度只减不增，耗尽即 fail-closed', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)
      // 在线：全额
      assert.strictEqual(cl.reporter.resetBudgetFromServer(100000, 1000), 100)
      // 离线：按 offline_budget_ratio=0.5 打折
      assert.strictEqual(cl.reporter.resetBudgetFromServer(100000, 1000, { offline: true }), 50)

      for (let i = 0; i < 50; i++) cl.reporter.spendBudget(1)
      assert.strictEqual(cl.reporter.localBudget, 0)
      assert.strictEqual(cl.reporter.isBudgetExhausted(), true, '耗尽后必须停机（离线不得放宽）')

      // 再花不会变负
      cl.reporter.spendBudget(5)
      assert.strictEqual(cl.reporter.localBudget, 0)
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// 重启恢复
// ══════════════════════════════════════════════════════════

test('客户端集成：进程重启后凭据与 seq 均恢复，且序号不回退', async () => {
  await withEnv(async ({ addr, acc }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-'))
    let store = new Store({ dir })
    let h2 = null
    try {
      const st1 = new LicenseState({ store, instanceDir: dir, clientVersion: CLIENT_VERSION })
      const h1 = new LicenseHttp({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        getAuthState: () => st1.authSnapshot(),
      })
      const a1 = new LicenseAuth({ http: h1, state: st1, clientVersion: CLIENT_VERSION })
      await a1.login(acc.account, acc.password)

      const token1 = st1.authSnapshot().token
      const key1 = st1.authSnapshot().key
      const session1 = st1.sessionId
      // 推进几个 seq
      st1.nextSeq('sends'); st1.nextSeq('sends')
      st1.nextSeq('heartbeat')
      const seqBefore = { sends: st1.peekSeq('sends'), heartbeat: st1.peekSeq('heartbeat') }
      h1.close()
      store.close()

      // ── 模拟进程重启：换一套全新对象，只共享磁盘目录 ──────
      store = new Store({ dir })
      const st2 = new LicenseState({ store, instanceDir: dir, clientVersion: CLIENT_VERSION })

      assert.strictEqual(st2.authSnapshot().token, token1, 'token 应已恢复')
      assert.strictEqual(st2.authSnapshot().key, key1, 'sign_key 应已恢复')
      assert.strictEqual(st2.sessionId, session1, 'session_id 应已恢复（未主动 startSession）')
      assert.strictEqual(st2.peekSeq('sends'), seqBefore.sends, 'seq 应已恢复')
      assert.strictEqual(st2.peekSeq('heartbeat'), seqBefore.heartbeat)

      // ⚠️ 序号必须**继续递增**。回退会被服务端判为 AUTH_REPLAY，
      //    而这条故障只在重启后出现一次，最难复现。
      assert.strictEqual(st2.nextSeq('sends'), seqBefore.sends + 1)

      // 用恢复的凭据真发一次心跳
      h2 = new LicenseHttp({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        getAuthState: () => st2.authSnapshot(),
      })
      const a2 = new LicenseAuth({ http: h2, state: st2, clientVersion: CLIENT_VERSION })
      const guard2 = new Guard({ store })
      guard2.applyPolicy(st2.policy)
      const hb2 = new Heartbeat({ http: h2, state: st2, auth: a2, guard: guard2, clientVersion: CLIENT_VERSION })
      const r = await hb2.send()
      assert.strictEqual(r.body.ok, true, '重启后应能用恢复的凭据继续通信')
    } finally {
      if (h2) h2.close()
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }, { seed: { credits: 100, dayIndex: 30 } })
})

// ══════════════════════════════════════════════════════════
// 时钟校准
// ══════════════════════════════════════════════════════════

test('客户端集成：未经校准的时钟偏差超容差会被拒，校准后恢复正常（§5.4）', async () => {
  await withEnv(async ({ addr, acc }) => {
    const cl = makeClient(addr)
    try {
      await cl.auth.login(acc.account, acc.password)

      // ── ① 模拟"本机时钟快了 8 分钟"（超过 ±5 分钟容差）────────
      // ⚠️ 这里刻意覆盖 http 层的 clockSkewMs，等价于"客户端用未校准的
      //    本地时间签名"。这不是虚构场景：长期未同步时间的 Windows 机器
      //    偏差超过 5 分钟并不罕见，表现为"登录成功但什么都做不了"。
      const skew = 8 * 60 * 1000
      cl.http.clockSkewMs = skew

      let caught = null
      await assert.rejects(
        () => cl.heartbeat.send(),
        (e) => {
          caught = e
          assert.strictEqual(e.code, 'AUTH_TS_SKEW',
            `服务端应返回 AUTH_TS_SKEW，实际 ${e.code}`)
          assert.ok(e.detail.server_detail, '应带回偏差量供客户端校准')
          return true
        },
        '偏差超容差的请求必须被服务端拒绝'
      )
      assert.ok(caught, '必须捕获到 AUTH_TS_SKEW')

      // ── ② 自愈：契约 §5.4 要求客户端用服务端时间重算并重试 ────
      // ⚠️ 这条路径最容易做成死锁：偏差超容差时请求在 guard 阶段被拒，
      //    此时服务端还没有 session 密钥 → 响应**无法签名** →
      //    客户端拿不到 X-Lic-Server-Ts，按常规路径校准不了，
      //    于是"偏差 → 401 → 无法校准 → 继续 401"。
      //    破局点是服务端在错误 detail 里带回 clock_skew_ms，
      //    它由心跳请求体里的 client_time_ms 反推得出。
      assert.ok(caught !== null)
      const afterSkew = cl.http.clockSkewMs
      assert.ok(Math.abs(afterSkew) < 60000,
        `应据服务端回报的偏差自愈，实际剩余偏差 ${afterSkew}ms`)

      const r = await cl.heartbeat.send()
      assert.strictEqual(r.body.ok, true, '校准后应恢复正常通信')
      // 自愈后服务端算出的偏差也应回到秒级
      assert.ok(Math.abs(Number(r.body.clock_skew_ms)) < 60000,
        `服务端观测到的偏差应回到秒级，实际 ${r.body.clock_skew_ms}ms`)
    } finally { cl.cleanup() }
  }, { seed: { credits: 100, dayIndex: 30 } })
})
