'use strict'

// test/integration/api.test.js
// L4 集成测试：真实 HTTP + 真实签名，端到端验证授权中心。
//
// ⚠️ 这一层验证的是"三层拼起来还对不对"：
//   路由 / 中间件（鉴权+签名+防重放）/ 域逻辑（策略、计费、审计）

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { createServer } = require('../../license-server/server')
const { hashPassword } = require('../../license-server/crypto/password')
const { grantCredits } = require('../../license-server/domain/billing')
const { planCreditsFor } = require('../../license-server/domain/policy')
const { request, Client, makeSend } = require('./helpers')

// ── 夹具：起一个真实服务 ────────────────────────────────────

function makeServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-it-'))
  const inst = createServer({
    dataDir: dir,
    dbPath: path.join(dir, 'it.db'),
    host: '127.0.0.1',
    port: 0, // 由系统分配端口
    masterKey: 'test-master-key-0123456789abcdef0123456789abcdef',
    creditPerReplyMilli: 1000,
    minClientVersion: '3.0.0',
    logLevel: 'error',
    logSink: { write() {} }, // 静音
    backupBeforeMigrate: false,
    ...overrides,
  })
  return { inst, dir }
}

/** 建一个账号并发放积分。 */
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
  return { accountId, password, account, firstLogin }
}

async function withServer(fn, overrides) {
  const { inst, dir } = makeServer(overrides)
  const addr = await inst.listen()
  try {
    await fn({ inst, addr, dir })
  } finally {
    inst.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// ══════════════════════════════════════════════════════════
// 基础
// ══════════════════════════════════════════════════════════

test('集成：健康检查无需鉴权', async () => {
  await withServer(async ({ addr }) => {
    const r = await request(addr, 'GET', '/healthz')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.strictEqual(r.body.protocol_version, 2)
  })
})

test('集成：未知路径返回 404，方法不对返回 405', async () => {
  await withServer(async ({ addr }) => {
    const a = await request(addr, 'GET', '/api/v1/nope')
    assert.strictEqual(a.status, 404)
    // /healthz 存在但只支持 GET
    const b = await request(addr, 'POST', '/healthz', { rawBody: '{}' })
    assert.strictEqual(b.status, 405)
  })
})

test('集成：bootstrap 返回版本信息与强制升级标记', async () => {
  await withServer(async ({ addr }) => {
    const ok = await request(addr, 'GET', '/api/v1/client/bootstrap?client_version=3.0.0&protocol_version=2')
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.body.force_upgrade, false)

    const old = await request(addr, 'GET', '/api/v1/client/bootstrap?client_version=2.0.0&protocol_version=2')
    assert.strictEqual(old.body.force_upgrade, true, '低版本应要求强制升级')
  })
})

// ══════════════════════════════════════════════════════════
// 登录
// ══════════════════════════════════════════════════════════

test('集成：登录成功返回 token/sign_key/policy/额度文案，且 login_proof 可自证', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    const r = await c.login()

    assert.strictEqual(r.status, 200)
    assert.ok(r.body.token, '应返回 token')
    assert.ok(r.body.sign_key, '应返回 sign_key')
    assert.ok(r.body.policy, '应返回 policy')
    assert.ok(r.body.policy.account_tier, 'policy 应含等级')
    assert.ok(r.body.policy.policy_hash, 'policy 应含 policy_hash（供 ack 存证）')
    assert.ok(r.body.quota_notice, '应返回额度文案（红线 1 要求四处展示）')
    assert.ok(r.body.quota_notice.detail.includes('不'), '额度文案应说明限制')

    // login_proof 自证
    const { verifyLoginProof } = require('../../license-server/crypto/sign')
    assert.doesNotThrow(() =>
      verifyLoginProof('pw-123456', 'demo001', 'dev-test-1', r.body))

    // 稳定期账号的等级
    assert.strictEqual(r.body.policy.account_tier, 'stable')
    assert.strictEqual(r.body.policy.limits.comment.daily_max, 30)
  })
})

test('集成：错误密码与不存在的账号返回相同错误码（防账号枚举）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)

    const wrongPw = await request(addr, 'POST', '/api/v1/auth/login', {
      rawBody: JSON.stringify({ account: 'demo001', password: 'wrong', device_id: 'd1', protocol_version: 2 }),
    })
    const noAcc = await request(addr, 'POST', '/api/v1/auth/login', {
      rawBody: JSON.stringify({ account: 'ghost999', password: 'whatever', device_id: 'd1', protocol_version: 2 }),
    })

    assert.strictEqual(wrongPw.status, 401)
    assert.strictEqual(noAcc.status, 401)
    assert.strictEqual(wrongPw.body.code, noAcc.body.code,
      '两者错误码必须相同，否则可枚举账号是否存在')
    assert.strictEqual(wrongPw.body.message, noAcc.body.message, '文案也必须相同')
  })
})

test('集成：连续 5 次失败后锁定', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { account: 'lockme', password: 'right-pw' })
    for (let i = 0; i < 5; i++) {
      await request(addr, 'POST', '/api/v1/auth/login', {
        rawBody: JSON.stringify({ account: 'lockme', password: 'bad', device_id: 'd1', protocol_version: 2 }),
      })
    }
    const r = await request(addr, 'POST', '/api/v1/auth/login', {
      rawBody: JSON.stringify({ account: 'lockme', password: 'right-pw', device_id: 'd1', protocol_version: 2 }),
    })
    assert.strictEqual(r.status, 423, '锁定后即使密码正确也应拒绝')
    assert.strictEqual(r.body.code, 'AUTH_ACCOUNT_LOCKED')
  })
})

test('集成：登录响应被篡改时 login_proof 校验失败', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    const r = await c.login()
    const { verifyLoginProof } = require('../../license-server/crypto/sign')
    const forged = { ...r.body, credit: { balance_milli: 999999999 } }
    assert.throws(() => verifyLoginProof('pw-123456', 'demo001', 'dev-test-1', forged),
      /被篡改/)
  })
})

// ══════════════════════════════════════════════════════════
// 鉴权与防重放
// ══════════════════════════════════════════════════════════

test('集成：无 token 访问受保护接口返回 AUTH_TOKEN_MISSING', async () => {
  await withServer(async ({ addr }) => {
    const r = await request(addr, 'GET', '/api/v1/auth/me')
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, 'AUTH_TOKEN_MISSING')
  })
})

test('集成：伪造 token 返回 AUTH_TOKEN_INVALID', async () => {
  await withServer(async ({ addr }) => {
    const r = await request(addr, 'GET', '/api/v1/auth/me', {
      headers: { Authorization: 'Bearer deadbeef'.repeat(8) },
    })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, 'AUTH_TOKEN_INVALID')
  })
})

test('集成：签名错误被拒（篡改请求体）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 正常请求应通过
    const ok = await c.get('/api/v1/auth/me')
    assert.strictEqual(ok.status, 200)

    // 篡改：用合法签名，然后把 body 改掉（签名覆盖 body 哈希，故必然不匹配）
    const { signRequest } = require('../../license-server/crypto/sign')
    const ts = Date.now()
    const nonce = c.nextNonce()
    const seq = c.nextSeq()
    const signedBody = JSON.stringify({ online_seconds: 1, seq })
    const signature = signRequest({
      signKey: c.signKey, method: 'POST', pathWithQuery: '/api/v1/heartbeat',
      ts, nonce, rawBody: signedBody,
    })
    // 实际发送不同的 body
    const tamperedBody = JSON.stringify({ online_seconds: 999999, seq })

    const r = await request(addr, 'POST', '/api/v1/heartbeat', {
      rawBody: tamperedBody,
      headers: {
        Authorization: `Bearer ${c.token}`,
        'X-Lic-Ts': String(ts), 'X-Lic-Nonce': nonce, 'X-Lic-Sign': signature,
      },
    })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, 'AUTH_SIGN_INVALID')
  })
})

test('集成：nonce 复用被判重放（AUTH_REPLAY）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const { signRequest } = require('../../license-server/crypto/sign')
    const ts = Date.now()
    const nonce = c.nextNonce()
    const seq = c.nextSeq()
    const rawBody = JSON.stringify({ seq })
    const signature = signRequest({
      signKey: c.signKey, method: 'POST', pathWithQuery: '/api/v1/heartbeat',
      ts, nonce, rawBody,
    })
    const headers = {
      Authorization: `Bearer ${c.token}`,
      'X-Lic-Ts': String(ts), 'X-Lic-Nonce': nonce, 'X-Lic-Sign': signature,
    }

    const first = await request(addr, 'POST', '/api/v1/heartbeat', { rawBody, headers })
    assert.strictEqual(first.status, 200, '首次应通过')

    // 完全重放同一请求（同 nonce 同签名）
    const replay = await request(addr, 'POST', '/api/v1/heartbeat', { rawBody, headers })
    assert.strictEqual(replay.status, 401)
    assert.strictEqual(replay.body.code, 'AUTH_REPLAY')
  })
})

test('集成：序号回退被判重放', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    await c.post('/api/v1/heartbeat', {})   // seq=1
    await c.post('/api/v1/heartbeat', {})   // seq=2

    // 用新 nonce、正确签名，但 seq 回退到 1
    const r = await c.post('/api/v1/heartbeat', {}, { seqOverride: 1 })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, 'AUTH_REPLAY')
  })
})

test('集成：各通道 seq 独立计数（心跳不挤掉上报的序号）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 心跳通道推到 seq=3
    await c.post('/api/v1/heartbeat', {})
    await c.post('/api/v1/heartbeat', {})
    await c.post('/api/v1/heartbeat', {})

    // 上报通道自己的 seq 从 1 开始，不应被判重放
    const r = await c.post('/api/v1/audit/sends', { sends: [makeSend()] })
    assert.strictEqual(r.status, 200, '不同通道的 seq 必须独立计数')
  })
})

test('集成：时间戳超窗返回 AUTH_TS_SKEW', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 时间戳偏差 10 分钟（签名本身是对的，只是过期）
    const r = await c.post('/api/v1/heartbeat', {}, { tsOffsetMs: -10 * 60 * 1000 })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, 'AUTH_TS_SKEW')

    // 偏差 4 分钟应通过（窗口内）
    const ok = await c.post('/api/v1/heartbeat', {}, { tsOffsetMs: 4 * 60 * 1000 })
    assert.strictEqual(ok.status, 200, '窗口内的时间戳应通过')
  })
})

test('集成：缺签名字段返回 AUTH_SIGN_MISSING', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 带 token 但不带签名字段
    const r = await request(addr, 'GET', '/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${c.token}` },
    })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.code, 'AUTH_SIGN_MISSING')
  })
})

// ══════════════════════════════════════════════════════════
// 心跳与策略
// ══════════════════════════════════════════════════════════

test('集成：心跳下发策略、额度、额度文案，并写 ack 存证', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r = await c.post('/api/v1/heartbeat', {
      online_seconds: 60,
      client_time_ms: Date.now(),
      applied_policy_version: 1,
      applied_limits: {
        comment: { daily_max: 10, min_interval_ms: 120000, content_similarity_max: 0.8 },
      },
      instance_id: 'inst-1',
      pending_send_count: 0,
      seq: undefined, // 由 Client 填
    })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.ok(r.body.daily_quota.comment, '应下发各渠道额度')
    assert.strictEqual(r.body.daily_quota.comment.max, 30)
    assert.strictEqual(r.body.daily_quota.comment.used, 0)
    assert.strictEqual(r.body.online_seconds_note, 'not_billable',
      '必须标注时长不参与计费')

    // ack 存证（红线 3）
    const ack = inst.db.prepare('SELECT * FROM policy_ack_log WHERE account_id = ?').get(accountId)
    assert.ok(ack, '应写入 policy_ack_log')
    assert.strictEqual(ack.instance_id, 'inst-1')
    assert.ok(ack.applied_limits_json.includes('daily_max'),
      'ack 必须记录**实际生效值**，而不只是下发值')
  })
})

test('集成：越权上报被拒并留痕（红线 1 + 红线 3）', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r = await c.post('/api/v1/heartbeat', {
      applied_policy_version: 1,
      applied_limits: { comment: { daily_max: 500 } }, // 策略上限是 30
      instance_id: 'inst-1',
    })

    assert.strictEqual(r.status, 200, '心跳本身不应失败')
    assert.ok(r.body.policy_violation, '应在响应中明确告知越权')
    assert.strictEqual(r.body.policy_violation.code, 'POLICY_VIOLATION')
    assert.strictEqual(r.body.policy_violation.detail.allowed, 30)

    // 越权尝试必须留痕（用于回答"用户是否主动调高过"）
    const ev = inst.db.prepare(
      "SELECT * FROM audit_config_changes WHERE account_id = ? AND reject_code = 'POLICY_VIOLATION'"
    ).get(accountId)
    assert.ok(ev, '越权尝试必须写入审计')
    assert.strictEqual(Number(ev.applied), 0)
  })
})

test('集成：观察期心跳下发禁发指令', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100, dayIndex: 2 }) // 观察期
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    const login = await c.login()
    assert.strictEqual(login.body.policy.account_tier, 'observation')
    assert.strictEqual(login.body.policy.sending_enabled, false)

    const r = await c.post('/api/v1/heartbeat', { applied_policy_version: 1, instance_id: 'inst-1' })
    assert.ok(r.body.commands.some((x) => x.type === 'pause_engine' && x.reason === 'POLICY_SENDING_DISABLED'),
      '观察期必须下发停机指令')
  })
})

// ══════════════════════════════════════════════════════════
// 审计上报与计费（端到端）
// ══════════════════════════════════════════════════════════

test('集成：上报成功明细 → 扣费、写台账、响应带余额', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r = await c.post('/api/v1/audit/sends', { sends: [makeSend(), makeSend()] })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.settlement.billed_count, 2)
    assert.strictEqual(r.body.settlement.charged_milli, 2000)
    assert.strictEqual(r.body.settlement.balance_milli, 100 * 1000 - 2000)

    const bal = inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(bal.balance_milli), 98000)
    const ledger = inst.db.prepare('SELECT COUNT(*) c FROM credit_ledger WHERE account_id=? AND kind=?').get(accountId, 'consume')
    assert.strictEqual(Number(ledger.c), 2)
  })
})

test('集成：DOM 判据不计费（红线 2 端到端）', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r = await c.post('/api/v1/audit/sends', {
      sends: [makeSend({
        verdict: 'sent_confirmed',
        evidence: { confirm_signal: 'dom_stable', platform_status_code: 0 },
      })],
    })
    assert.strictEqual(r.body.settlement.billed_count, 0, 'DOM 判据不得计费')
    const bal = inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(bal.balance_milli), 100 * 1000, '余额不应变化')
  })
})

test('集成：隐私字段被拒（红线 3 —— 只传哈希不传原文）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    for (const bad of [{ text: '这是一条真实评论' }, { sec_uid: 'MS4wLjABAAAA...' }, { nickname: '张三' }]) {
      const r = await c.post('/api/v1/audit/sends', { sends: [makeSend(bad)] })
      assert.strictEqual(r.status, 400, `含隐私字段 ${Object.keys(bad)[0]} 应被拒`)
      assert.strictEqual(r.body.code, 'REPORT_PRIVACY_VIOLATION')
    }
  })
})

test('集成：非法枚举与完整 URL 被拒（闭集约束）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const badVerdict = await c.post('/api/v1/audit/sends', { sends: [makeSend({ verdict: 'skipped' })] })
    assert.strictEqual(badVerdict.status, 400, 'skipped 不是合法 verdict')

    const badEndpoint = await c.post('/api/v1/audit/sends', {
      sends: [makeSend({ evidence: { confirm_signal: 'platform_response', platform_endpoint: 'https://www.douyin.com/aweme/v1/web/comment/publish/', platform_status_code: 0 } })],
    })
    assert.strictEqual(badEndpoint.status, 400, '完整 URL 必须被拒（闭集白名单）')
  })
})

test('集成：同一 send_id 重复上报只扣一次（幂等端到端）', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const s = makeSend()
    const r1 = await c.post('/api/v1/audit/sends', { sends: [s] })
    assert.strictEqual(r1.body.settlement.billed_count, 1)

    for (let i = 0; i < 4; i++) {
      const r = await c.post('/api/v1/audit/sends', { sends: [s] })
      assert.strictEqual(r.body.settlement.billed_count, 0)
      assert.strictEqual(r.body.settlement.duplicate_count, 1)
    }
    const bal = inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(bal.balance_milli), 99 * 1000, '余额只应减一次')
  })
})

test('集成：余额耗尽返回停机指令，后续上报只留痕不扣费', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 1, dayIndex: 30 }) // 只够 1 条
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 发 5 条：1 条余额 + 1 条透支 = 2 条可支付
    const sends = []
    for (let i = 0; i < 5; i++) sends.push(makeSend())
    const r = await c.post('/api/v1/audit/sends', { sends })
    assert.strictEqual(r.body.settlement.state, 'exhausted')
    assert.ok(r.body.commands.some((x) => x.type === 'pause_engine' && x.reason === 'CREDIT_EXHAUSTED'))
    assert.strictEqual(r.body.settlement.billed_count, 2, '1 条余额 + 1 条透支')

    // 后续心跳应返回 402
    const hb = await c.post('/api/v1/heartbeat', { applied_policy_version: 1, instance_id: 'inst-1' })
    assert.strictEqual(hb.status, 402)
    assert.strictEqual(hb.body.code, 'CREDIT_EXHAUSTED')
  })
})

test('集成：观察期上报明细留痕但不计费', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100, dayIndex: 2 }) // 观察期
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r = await c.post('/api/v1/audit/sends', { sends: [makeSend()] })
    assert.strictEqual(r.body.settlement.billed_count, 0, '观察期一律不计费')
    assert.ok(r.body.audit_flags.includes('tier_sending_disabled'))

    const rows = inst.db.prepare('SELECT COUNT(*) c FROM send_log WHERE account_id=?').get(accountId)
    assert.strictEqual(Number(rows.c), 1, '明细必须留痕（审计优先）')
  })
})

test('集成：单批超上限返回 AUDIT_BATCH_TOO_LARGE', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 10000, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()
    const sends = []
    for (let i = 0; i < 501; i++) sends.push(makeSend())
    const r = await c.post('/api/v1/audit/sends', { sends })
    assert.strictEqual(r.status, 413)
    assert.strictEqual(r.body.code, 'AUDIT_BATCH_TOO_LARGE')
  })
})

// ══════════════════════════════════════════════════════════
// 配置变更审计 / 聚合上报
// ══════════════════════════════════════════════════════════

test('集成：配置变更审计上报并幂等', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const change = {
      change_id: 'ch-test-1',
      changed_at_ms: Date.now(),
      source: 'user',
      actor: 'local_user',
      field_key: 'limits.comment.daily_max',
      old_value: '30',
      new_value: '10',
      applied: true,
    }
    const r1 = await c.post('/api/v1/audit/config-changes', { changes: [change], instance_id: 'inst-1' })
    assert.strictEqual(r1.status, 200)
    assert.strictEqual(r1.body.results[0].accepted, true)
    assert.strictEqual(r1.body.results[0].duplicate, false)

    const r2 = await c.post('/api/v1/audit/config-changes', { changes: [change], instance_id: 'inst-1' })
    assert.strictEqual(r2.body.results[0].duplicate, true, '重复上报应幂等')

    const n = inst.db.prepare('SELECT COUNT(*) c FROM audit_config_changes WHERE change_id=?').get('ch-test-1')
    assert.strictEqual(Number(n.c), 1)
  })
})

test('集成：聚合上报幂等且明确不参与计费', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const payload = {
      report_id: 'rep-1',
      instance_id: 'inst-1',
      window_start_ms: Date.now() - 300000,
      window_end_ms: Date.now(),
      online_seconds: 99999, // 故意很大
      sources: {
        comment: { hits: 5, leads_new: 4, reply_attempts: 3, sent_confirmed: 2, sent_confirmed_dom: 0, sent_suspected: 1, failed: 0, skipped: 1, unique_users: 2 },
        live_danmaku: { hits: 0, leads_new: 0, reply_attempts: 0, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 0, unique_users: 0 },
        dm: { hits: 0, leads_new: 0, reply_attempts: 0, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 0, unique_users: 0 },
      },
    }
    const r = await c.post('/api/v1/usage/report', payload)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.credit_consumed_milli, 0, '时长绝不计费')
    assert.ok(r.body.note.includes('不参与计费'))

    const dup = await c.post('/api/v1/usage/report', payload)
    assert.strictEqual(dup.body.duplicate, true)

    const bal = inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(accountId)
    assert.strictEqual(Number(bal.balance_milli), 100 * 1000, '余额不应变化')
  })
})

// ══════════════════════════════════════════════════════════
// 积分查询与卡密
// ══════════════════════════════════════════════════════════

test('集成：查询余额与台账', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 50, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()
    await c.post('/api/v1/audit/sends', { sends: [makeSend(), makeSend()] })

    const bal = await c.get('/api/v1/credit/balance')
    assert.strictEqual(bal.status, 200)
    assert.strictEqual(bal.body.credit.balance_milli, 50 * 1000 - 2000)
    assert.strictEqual(bal.body.credit.replies_affordable, 48)
    assert.strictEqual(bal.body.credit.used_today_milli, 2000)

    const led = await c.get('/api/v1/credit/ledger?granularity=raw')
    assert.strictEqual(led.status, 200)
    assert.ok(Array.isArray(led.body.entries))
    assert.ok(led.body.entries.length >= 3, '应有 1 条发放 + 2 条消耗')
    assert.strictEqual(led.body.summary.usage_milli, 2000)
  })
})

test('集成：套餐接口数字由策略表推导（禁止硬编码）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst)
    const now = Date.now()
    inst.db.prepare(`
      INSERT INTO plan (plan_key, name, credits, valid_days, price_cents, price_is_placeholder, is_default, active, created_at_ms)
      VALUES ('plan_half_year','半年套餐',?,180,0,1,1,1,?)
    `).run(planCreditsFor(180), now)

    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()
    const r = await c.get('/api/v1/account/plan')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.stable_daily_max_total, 70)
    assert.strictEqual(r.body.min_plan_credit, 12600)
    assert.strictEqual(r.body.plans[0].credits, 12600)
    assert.strictEqual(r.body.plans[0].price_is_placeholder, true,
      '价格必须标记为占位值')
    assert.strictEqual(r.body.plans[0].hours, null, 'hours 已废弃，恒为 null')
  })
})

test('集成：卡密兑换成功、幂等、二次兑换被拒', async () => {
  await withServer(async ({ inst, addr }) => {
    const { accountId } = seedAccount(inst, { credits: 0, dayIndex: 30 })
    const { generateRedeemCodes } = require('../../license-server/api/routes-credit')
    const gen = generateRedeemCodes(inst.db, {
      count: 1, credits: 12600, validDays: 180, batch: 'TEST', nowMs: Date.now(),
    })
    const code = gen.codes[0]
    assert.match(code, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/, '卡密格式应为 XXXX-XXXX-XXXX-XXXX 形态')

    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r1 = await c.post('/api/v1/credit/redeem', { code, request_id: 'req-1' })
    assert.strictEqual(r1.status, 200)
    assert.strictEqual(r1.body.credits, 12600)
    assert.strictEqual(r1.body.balance_milli, 12600 * 1000)

    // 幂等：同一账号再兑一次返回已兑换
    const r2 = await c.post('/api/v1/credit/redeem', { code, request_id: 'req-2' })
    assert.strictEqual(r2.body.code, 'CREDIT_REDEEM_ALREADY_DONE')
    assert.strictEqual(r2.body.balance_milli, undefined, '幂等路径不应重复入账')

    // 另一个账号兑换同一卡密 → 已被使用
    seedAccount(inst, { account: 'demo002', password: 'pw-2', credits: 0 })
    const c2 = new Client(addr, { account: 'demo002', password: 'pw-2', deviceId: 'dev-2' })
    await c2.login()
    const r3 = await c2.post('/api/v1/credit/redeem', { code, request_id: 'req-3' })
    assert.strictEqual(r3.status, 409)
    assert.strictEqual(r3.body.code, 'CREDIT_REDEEM_CODE_USED')

    // 无效卡密
    const r4 = await c2.post('/api/v1/credit/redeem', { code: 'AAAA-BBBB-CCCC-DDDD', request_id: 'req-4' })
    assert.strictEqual(r4.status, 404)
    assert.strictEqual(r4.body.code, 'CREDIT_REDEEM_CODE_INVALID')

    // 库中只存哈希，不存明文
    const row = inst.db.prepare('SELECT code_hash FROM redeem_code WHERE used_by = ?').get(accountId)
    assert.ok(row.code_hash !== code, '库中不得存卡密明文')
    assert.strictEqual(row.code_hash.length, 64)
  })
})

// ══════════════════════════════════════════════════════════
// 设备数限制
// ══════════════════════════════════════════════════════════

test('集成：超出设备数上限时踢掉最早会话', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c1 = new Client(addr, { account: 'demo001', password: 'pw-123456', deviceId: 'dev-A' })
    await c1.login()
    assert.strictEqual((await c1.get('/api/v1/auth/me')).status, 200)

    // 第二台设备登录（device_limit 默认 1）
    const c2 = new Client(addr, { account: 'demo001', password: 'pw-123456', deviceId: 'dev-B' })
    await c2.login()
    assert.strictEqual((await c2.get('/api/v1/auth/me')).status, 200, '新设备应可用')

    const kicked = await c1.get('/api/v1/auth/me')
    assert.strictEqual(kicked.status, 401, '旧设备应被踢')
    assert.strictEqual(kicked.body.code, 'AUTH_TOKEN_REVOKED')
  })
})

test('集成：同设备重复登录不算新增设备（不触发踢除）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c1 = new Client(addr, { account: 'demo001', password: 'pw-123456', deviceId: 'dev-SAME' })
    await c1.login()
    const c2 = new Client(addr, { account: 'demo001', password: 'pw-123456', deviceId: 'dev-SAME' })
    await c2.login()
    assert.strictEqual((await c2.get('/api/v1/auth/me')).status, 200)
    // 旧 token 被替换
    assert.strictEqual((await c1.get('/api/v1/auth/me')).status, 401)
  })
})

// ══════════════════════════════════════════════════════════
// 响应签名
// ══════════════════════════════════════════════════════════

test('集成：受保护接口的响应带签名，且篡改可被发现', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 不自动验签，取原始响应查看签名头
    const r = await c.get('/api/v1/credit/balance', { })
    assert.ok(r.headers['x-lic-sign'], '受保护接口的响应必须带 X-Lic-Sign')
    assert.ok(r.headers['x-lic-server-ts'], '必须带 X-Lic-Server-Ts')

    const { verifyResponseSignature } = require('../../license-server/crypto/sign')
    // 正确响应可通过
    assert.doesNotThrow(() => verifyResponseSignature({
      signKey: c.signKey,
      httpStatus: r.status,
      pathWithQuery: '/api/v1/credit/balance',
      requestNonce: r.requestNonce,
      serverTsHeader: r.headers['x-lic-server-ts'],
      signatureHeader: r.headers['x-lic-sign'],
      rawBody: r.raw,
    }))

    // 篡改响应体（伪造余额）后验签必须失败
    const forgedRaw = r.raw.replace(/"balance_milli":\d+/, '"balance_milli":999999999')
    assert.notStrictEqual(forgedRaw, r.raw, '构造的伪造响应应与原文不同')
    assert.throws(() => verifyResponseSignature({
      signKey: c.signKey,
      httpStatus: r.status,
      pathWithQuery: '/api/v1/credit/balance',
      requestNonce: r.requestNonce,
      serverTsHeader: r.headers['x-lic-server-ts'],
      signatureHeader: r.headers['x-lic-sign'],
      rawBody: forgedRaw,
    }), /签名校验失败/, '篡改响应体后验签必须失败')
  })
})

test('集成：响应签名绑定 request_nonce（旧响应不能重放给新请求）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 100 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    const r = await c.get('/api/v1/credit/balance')
    const { verifyResponseSignature } = require('../../license-server/crypto/sign')

    // 用**另一个** nonce 去验同一份响应 → 必须失败
    assert.throws(() => verifyResponseSignature({
      signKey: c.signKey,
      httpStatus: r.status,
      pathWithQuery: '/api/v1/credit/balance',
      requestNonce: 'ffffffffffffffffffffffffffffffff', // 不是本次请求的 nonce
      serverTsHeader: r.headers['x-lic-server-ts'],
      signatureHeader: r.headers['x-lic-sign'],
      rawBody: r.raw,
    }), /签名校验失败/, 'nonce 不匹配时必须验签失败——否则旧响应可被重放')
  })
})

test('集成：错误响应也带签名（客户端能区分真伪）', async () => {
  await withServer(async ({ inst, addr }) => {
    seedAccount(inst, { credits: 0, dayIndex: 30 })
    const c = new Client(addr, { account: 'demo001', password: 'pw-123456' })
    await c.login()

    // 余额为 0 → 心跳返回 402
    const r = await c.post('/api/v1/heartbeat', { applied_policy_version: 1 })
    assert.strictEqual(r.status, 402)
    assert.strictEqual(r.body.code, 'CREDIT_EXHAUSTED')
    assert.ok(r.verified, '错误响应也必须能被验签（否则无法区分中间人伪造）')
  })
})
