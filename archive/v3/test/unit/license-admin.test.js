'use strict'

// test/unit/license-admin.test.js
//
// 厂商管理后台（`license-server/admin/`）的回归防线。
//
// ⚠️ 本文件里最重要的几条，都是"删掉那行代码就再也测不出来"的：
//
//   ① **`ADMIN_PATH` 未配置 → 后台彻底不存在**。
//      这是全项目最高危的暴露面（部署指南 §9.3）。一个默认路径就等于
//      给公网扫描器一个固定入口。所以断言的不是"要登录"，而是"连路径都没有"。
//
//   ② **IP 白名单空列表 = 只允许回环**，不是"允许所有"。
//      方向必须是 fail-safe：运维漏配时后台应该连不上。
//
//   ③ **状态变更必须过 CSRF**（Origin/Referer 同源 + JSON Content-Type）。
//      只靠 SameSite=Strict 不够——"缺 Origin 头"的请求会被它放行。
//
//   ④ **发送明细只有哈希与判定**。种子数据里放的是**会被一眼看见**的
//      特征串（`SEC_UID_PLAINTEXT_LEAK` / `COMMENT_TEXT_LEAK`），
//      然后断言整份响应里搜不到它们。这比"检查字段名"强得多：
//      字段名改了它照样能抓到泄漏。
//
//   ⑤ **取证读的是 `policy_ack_log`（实际生效值），不是当前策略**。
//      种子里刻意让两者不同（生效 5 / 当前 10），断言响应给出的是 5——
//      这是红线 3 的全部意义：纠纷要回答"当时是什么"。
//
//   ⑥ **台账 append-only**。既有源扫描（不允许 `UPDATE credit_ledger`），
//      也做行为断言（`balance_after_milli` 必须等于链式累计）。
//
// ⚠️ 用真实服务（`createServer` + 端口 0 + 临时库），不 mock：
//    后台的安全属性（cookie 属性、CSRF、IP 白名单、路由是否存在）
//    只有在真实的 HTTP 栈上才测得出来。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { createServer } = require('../../license-server/server')
const { hashPassword } = require('../../license-server/crypto/password')
const { grantCredits } = require('../../license-server/domain/billing')
const { Client, request: rawRequest, makeSend } = require('../integration/helpers')
const cli = require('../../license-server/cli')

const ROOT = path.resolve(__dirname, '..', '..')
const ADMIN_PATH = '/admin-test-9f3c'
const ADMIN_USER = 'admin'
const ADMIN_PASS = 'admin-pw-12345678'
const MERCHANT = 'demo001'
const MERCHANT_PASS = 'merchant-pw-123456'

/** ⚠️ 会被"一眼看见"的隐私特征串：整份响应里绝不允许出现它们。 */
const LEAK_SEC_UID = 'SEC_UID_PLAINTEXT_LEAK_9f3c'
const LEAK_COMMENT = 'COMMENT_TEXT_PLAINTEXT_LEAK_7a1b'
const LEAK_REPLY = 'REPLY_TEXT_PLAINTEXT_LEAK_5e2d'

// ══════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-')) }

/**
 * 起一个**真实**服务。
 *
 * ⚠️ 通过 `options.config` 直接注入配置，而不是改 `process.env`
 *    （环境变量是进程级的，测试之间会互相污染；`loadConfig` 的 overrides
 *    也不含 admin 项）。`Config` 用 `loadConfig()` 造出来再覆盖后台三项，
 *    保证其它项与生产完全一致。
 */
async function makeServer(opts = {}) {
  const dir = opts.dir || tmpDir()
  const dbPath = path.join(dir, 'license.db')
  // eslint-disable-next-line global-require
  const { loadConfig } = require('../../license-server/config')
  const base = loadConfig({
    dataDir: dir,
    dbPath,
    masterKey: 'admin-test-master-key-0123456789abcdef0123456789abcdef',
  })
  const enabled = opts.admin !== false
  const config = {
    ...base,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'error',
    adminPath: enabled ? (opts.adminPath || ADMIN_PATH) : null,
    adminIpAllow: opts.adminIpAllow || base.adminIpAllow,
    adminSessionTtlHours: opts.adminSessionTtlHours || 12,
    adminCookieSecure: false, // 测试走纯 HTTP，等价于文档里的 SSH 隧道场景
    trustProxy: opts.trustProxy === true,
    // ⚠️ 测试里把每 IP 登录限流放大：多个用例都从 127.0.0.1 登录，
    //    用默认的 10 次/分钟会让它们互相把对方打成 423——那是**测试之间的耦合**，
    //    不是产品缺陷。限流本身由专门的用例（调小该值）单独验证。
    loginRatePerMinute: opts.loginRatePerMinute === undefined ? 100000 : opts.loginRatePerMinute,
  }

  const sinks = []
  const inst = createServer({
    config,
    logger: {
      log() {},
      debug() {}, info() {}, warn() {}, error() {},
    },
    logSink: { write() {} },
    backupBeforeMigrate: false,
  })
  // ⚠️ 不打印日志到 stdout：`node --test` 的输出要干净
  void sinks
  const addr = await inst.listen()
  const port = addr.port

  return {
    dir, dbPath, inst, port, config,
    base: `http://127.0.0.1:${port}`,
    async cleanup() {
      inst.close()
      // ⚠️ 幂等：第二次 close 不能抛（不然 finally 里会盖住真正的失败）
      inst.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {
        process.stderr.write(`清理临时目录失败（可忽略但需留痕）：${e.message}\n`)
      }
    },
  }
}

/** 建一个管理员（**故意走 CLI**，保证后台与 CLI 对同一张表的口径一致）。 */
async function seedAdmin(srv, { user = ADMIN_USER, password = ADMIN_PASS } = {}) {
  const code = await cli.run(
    ['admin', 'create', '--user', user, '--password-stdin'],
    {
      dataDir: srv.dir,
      nowMs: Date.now(),
      io: {
        stdin: makeStdin(`${password}\n`),
        stdinIsTTY: false,
        out: { write() {} },
        err: { write() {} },
      },
    }
  )
  assert.strictEqual(code, 0, 'CLI 建管理员应当成功')
  return { user, password }
}

/** 造一个可读流作为 CLI 的 stdin。 */
function makeStdin(text) {
  const { Readable } = require('node:stream')
  const r = new Readable({ read() {} })
  r.push(text)
  r.push(null)
  return r
}

/** 直接在库里造商家账号 + 余额（比 CLI 快，且能精确控制 `first_login_ms`）。 */
function seedMerchant(db, opts = {}) {
  const now = opts.nowMs === undefined ? Date.now() : opts.nowMs
  const dayIndex = opts.accountDayIndex === undefined ? 30 : opts.accountDayIndex
  // 第 N 天：first_login = now - (N-1) 天
  const firstLogin = now - (dayIndex - 1) * 86400000
  const r = db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, status, plan_expires_ms,
                         device_limit, first_login_ms, note, created_at_ms, updated_at_ms)
    VALUES (?,?,?,'active',?,1,?,?,?,?)
  `).run(
    opts.account || MERCHANT, opts.displayName || '测试店铺', hashPassword(opts.password || MERCHANT_PASS),
    now + 180 * 86400000, firstLogin,
    opts.note === undefined ? '备注：含用户输入的 <script>alert(1)</script> 也要被转义' : opts.note,
    now, now
  )
  const accountId = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?,0,?)').run(accountId, now)
  db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?,0,?,?)')
    .run(accountId, 'active', now)
  if (opts.credits) {
    grantCredits(db, {
      accountId, deltaMilli: opts.credits * 1000, kind: 'grant',
      operator: 'test', note: '初始额度', nowMs: now,
    })
  }
  return { accountId, now, firstLogin }
}

// ══════════════════════════════════════════════════════════
// HTTP 助手（后台不签名，所以直接发原始请求）
// ══════════════════════════════════════════════════════════

/**
 * 发一个请求。
 *
 * ⚠️ 用 `node:http` 而不是 `fetch`：测试要能构造"缺 Origin"、"外来 Origin"、
 *    "畸形 cookie"这类形态，而 fetch 会规范化掉一部分头。
 */
function req(srv, method, urlPath, opts = {}) {
  const headers = Object.assign({}, opts.headers || {})
  if (opts.cookie) headers.Cookie = opts.cookie
  let body = null
  if (opts.body !== undefined && opts.body !== null) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(body)
  }
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: srv.port, method, path: urlPath, headers,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let json = null
        try { json = raw ? JSON.parse(raw) : null } catch (e) {
          json = { __unparsable: raw.slice(0, 300), __error: e.message }
        }
        resolve({ status: res.statusCode, headers: res.headers, text: raw, json })
      })
    })
    r.on('error', reject)
    if (body !== null) r.write(body)
    r.end()
  })
}

/** 从 Set-Cookie 里取出会话 cookie 的 `name=value` 部分。 */
function cookieOf(res) {
  const sc = res.headers['set-cookie']
  if (!sc || !sc.length) return null
  const first = sc[0]
  const semi = first.indexOf(';')
  return semi < 0 ? first : first.slice(0, semi)
}

/** 登录后台，返回 { cookie, res }。 */
async function adminLogin(srv, user, password) {
  const res = await req(srv, 'POST', `${ADMIN_PATH}/api/login`, {
    headers: { Origin: srv.base, Host: `127.0.0.1:${srv.port}` },
    body: { user, password },
  })
  return { res, cookie: cookieOf(res) }
}

/** 带会话的 GET。 */
function adminGet(srv, cookie, urlPath) {
  return req(srv, 'GET', urlPath, { cookie })
}

/** 带会话 + 同源 Origin 的 POST（合法写操作的标准形态）。 */
function adminPost(srv, cookie, urlPath, body) {
  return req(srv, 'POST', urlPath, {
    cookie,
    headers: { Origin: srv.base, Host: `127.0.0.1:${srv.port}` },
    body: body || {},
  })
}

/** 从库中直接造一条发送明细（含策略快照，用于取证）。 */
function insertSend(db, accountId, over) {
  const o = over || {}
  db.prepare(`
    INSERT INTO send_log (
      account_id, instance_id, send_id, source_type,
      target_hash, user_key_hash, user_key_type, content_hash,
      verdict, confirm_signal, platform_endpoint, platform_status_code, failure_reason,
      billing_status, charged_milli, applied_policy_version, policy_snapshot_json,
      sent_at_ms, received_at_ms, client_version, device_id, report_id, over_limit
    ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?)
  `).run(
    accountId, o.instanceId || 'inst-test', o.sendId || `s-${Math.random().toString(16).slice(2, 10)}`,
    o.sourceType || 'comment',
    o.targetHash || 'th-hash-001', o.userKeyHash || 'uh-hash-001', o.userKeyType || 'sec_uid_hash',
    o.contentHash || 'ch-hash-001',
    o.verdict || 'sent_confirmed', o.confirmSignal === undefined ? 'platform_response' : o.confirmSignal,
    o.endpoint === undefined ? 'comment/publish' : o.endpoint,
    o.statusCode === undefined ? 0 : o.statusCode,
    o.failureReason === undefined ? null : o.failureReason,
    o.billingStatus || 'billed', o.chargedMilli === undefined ? 1000 : o.chargedMilli,
    o.policyVersion === undefined ? 7 : o.policyVersion,
    o.policySnapshot === undefined ? null : o.policySnapshot,
    o.sentAtMs || Date.now(), o.receivedAtMs || Date.now(),
    '3.0.0', 'dev-test-1', 'report-1', o.overLimit ? 1 : 0
  )
}

/** 造一条策略 ack（红线 3 的"实际生效值"来源）。 */
function insertAck(db, accountId, over) {
  const o = over || {}
  db.prepare(`
    INSERT INTO policy_ack_log (
      account_id, instance_id, policy_version, policy_hash, account_tier,
      account_day_index, applied_limits_json, first_ack_at_ms, last_seen_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    accountId, o.instanceId || 'inst-test', o.policyVersion === undefined ? 7 : o.policyVersion,
    o.policyHash || 'deadbeefdeadbeef', o.tier || 'stable',
    o.dayIndex === undefined ? 30 : o.dayIndex,
    typeof o.appliedLimits === 'string' ? o.appliedLimits : JSON.stringify(o.appliedLimits || {
      comment: { daily_max: 5, min_interval_ms: 120000, content_similarity_max: 0.8 },
    }),
    o.firstAckAtMs || Date.now(), o.lastSeenAtMs || Date.now()
  )
}

/** 造一条配置变更审计。 */
function insertConfigChange(db, accountId, over) {
  const o = over || {}
  db.prepare(`
    INSERT INTO audit_config_changes (
      change_id, account_id, instance_id, changed_at_ms, source, actor,
      field_key, old_value, new_value, applied, reject_code, policy_version, received_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    o.changeId || `ch-${Math.random().toString(16).slice(2, 10)}`, accountId, o.instanceId || 'inst-test',
    o.changedAtMs || Date.now(), o.source || 'user', o.actor || 'local_user',
    o.fieldKey || 'limits.comment.daily_max', o.oldValue === undefined ? '10' : o.oldValue,
    o.newValue === undefined ? '100' : o.newValue,
    o.applied ? 1 : 0, o.rejectCode === undefined ? null : o.rejectCode,
    o.policyVersion === undefined ? 7 : o.policyVersion, o.receivedAtMs || Date.now()
  )
}

// ══════════════════════════════════════════════════════════
// 1. 未配置 ADMIN_PATH → 后台彻底不存在
// ══════════════════════════════════════════════════════════

test('后台：ADMIN_PATH 未配置时，后台路径**根本不存在**（不是"要求登录"）', async () => {
  const srv = await makeServer({ admin: false })
  try {
    assert.strictEqual(srv.config.adminPath, null, '前置条件：adminPath 必须是 null')
    assert.strictEqual(srv.inst.admin, null, 'createAdmin 应返回 null')

    // adminPath 为 null 时，后台的路径前缀无从谈起——用文档里的默认值试探
    for (const p of ['/admin', '/admin/', '/admin/api/overview', '/admin-7f3c91/']) {
      const r = await req(srv, 'GET', p)
      assert.strictEqual(r.status, 404, `${p} 必须 404，实际 ${r.status}`)
      assert.strictEqual(r.json.code, 'AUTH_INVALID_REQUEST',
        '未启用时必须是客户端路由的普通 404，不能是后台的错误信封')
    }

    // 登录接口同样不存在（不能出现"能登录但没有界面"的中间态）
    const login = await req(srv, 'POST', '/admin/api/login', {
      headers: { Origin: srv.base }, body: { user: 'admin', password: 'x' },
    })
    assert.strictEqual(login.status, 404)

    // 客户端契约必须完好
    const hz = await rawRequest({ address: '127.0.0.1', port: srv.port }, 'GET', '/healthz')
    assert.strictEqual(hz.status, 200)
    assert.strictEqual(hz.body.ok, true)
  } finally {
    await srv.cleanup()
  }
})

test('后台：ADMIN_PATH 为空串/空白/单个斜杠都归一成 null（拒绝任何默认值）', () => {
  const { normalizeAdminPath } = require('../../license-server/config')
  assert.strictEqual(normalizeAdminPath(''), null)
  assert.strictEqual(normalizeAdminPath('   '), null)
  assert.strictEqual(normalizeAdminPath('/'), null)
  assert.strictEqual(normalizeAdminPath('///'), null)
  assert.strictEqual(normalizeAdminPath(undefined), null)
  assert.strictEqual(normalizeAdminPath('admin-abc'), '/admin-abc', '缺前导斜杠要补上')
  assert.strictEqual(normalizeAdminPath('/admin-abc/'), '/admin-abc', '尾随斜杠必须去掉')
})

test('后台：IP 白名单为空 → 只允许回环（fail-safe，不是"允许所有"）', () => {
  const { parseIpAllow } = require('../../license-server/config')
  const A = require('../../license-server/admin/api')
  const empty = parseIpAllow('')
  assert.deepStrictEqual([...empty], ['127.0.0.1/32', '::1/128'])
  assert.strictEqual(A.ipAllowed(empty, '127.0.0.1'), true)
  assert.strictEqual(A.ipAllowed(empty, '::1'), true)
  assert.strictEqual(A.ipAllowed(empty, '::ffff:127.0.0.1'), true)
  assert.strictEqual(A.ipAllowed(empty, '8.8.8.8'), false, '空列表绝不能表示"全部允许"')
  assert.strictEqual(A.ipAllowed([], '203.0.113.9'), false, '即便传空数组也必须 fail-safe')
})

// ══════════════════════════════════════════════════════════
// 2. 登录：错误口令 / 锁定 / 不存在账号的时序等价
// ══════════════════════════════════════════════════════════

test('后台：密码错误 → 401 结构化信封；连续失败触发锁定（423）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    // ⚠️ `adminLogin` 返回 `{ res, cookie }`（它顺带把会话 cookie 取出来），
    //    断言必须走 `.res`。写成 `.status` 会得到 undefined，
    //    报出来是一句莫名其妙的 "undefined !== 401"，排查方向会被带偏。
    const badLogin = await adminLogin(srv, ADMIN_USER, 'wrong-password-xx')
    const bad = badLogin.res
    assert.strictEqual(bad.status, 401)
    assert.strictEqual(bad.json.ok, false)
    assert.strictEqual(bad.json.code, 'ADMIN_LOGIN_FAILED')
    assert.ok(bad.json.message.length > 0)
    assert.strictEqual(badLogin.cookie, null, '登录失败不得下发会话 cookie')
    assert.ok(!bad.text.includes('ADMIN_PASS'), '响应里绝不能出现密码')

    // 默认上限 5 次（LOGIN_FAIL_LIMIT）→ 第 6 次必须被锁
    let locked = null
    for (let i = 0; i < 6; i++) {
      const r = (await adminLogin(srv, ADMIN_USER, 'wrong-password-xx')).res
      if (r.status === 423) { locked = r; break }
    }
    assert.ok(locked, '连续失败后必须锁定（423）')
    assert.strictEqual(locked.json.code, 'ADMIN_LOCKED')
    assert.ok(Number(locked.json.detail.locked_until_ms) > Date.now(),
      'detail 必须给出解锁时刻，便于运维告知')

    // ⚠️ 锁定期间**即便密码正确**也必须被拒（否则锁定形同虚设）
    const goodWhileLocked = (await adminLogin(srv, ADMIN_USER, ADMIN_PASS)).res
    assert.strictEqual(goodWhileLocked.status, 423)
  } finally {
    await srv.cleanup()
  }
})

test('后台：管理员不存在与密码错误**响应不可区分**（防用户名枚举）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    // ⚠️ `adminLogin` 返回 `{ res, cookie }`（它要顺带把会话 cookie 取出来），
    //    所以断言必须走 `.res.status` / `.res.json`。
    //    写成 `.status` 会得到 `undefined`，报出来是一句莫名其妙的
    //    "undefined !== 401" —— 排查方向会被完全带偏。
    const noUser = (await adminLogin(srv, 'no-such-admin', ADMIN_PASS)).res
    const badPass = (await adminLogin(srv, ADMIN_USER, 'definitely-wrong-1')).res

    assert.strictEqual(noUser.status, badPass.status, '状态码必须一致')
    assert.strictEqual(noUser.json.code, badPass.json.code, '错误码必须一致')
    assert.strictEqual(noUser.json.message, badPass.json.message, '文案必须逐字一致')
    assert.deepStrictEqual(
      Object.keys(noUser.json).sort(), Object.keys(badPass.json).sort(),
      '响应字段集合也必须一致（多一个字段同样是枚举信道）'
    )
    // ⚠️ 不能出现任何能区分两者的字段（如 has_account / user_exists）
    assert.strictEqual(noUser.text.includes('not_exist'), false)
    assert.strictEqual(noUser.text.toLowerCase().includes('不存在'), false,
      '"账号不存在"这类文案本身就是枚举信道')

    // 时序对齐：两边的耗时应当是同一个量级（scrypt 成本占主导）。
    // ⚠️ 用宽松阈值（3 倍）而不是精确相等——精确相等在 CI 上必然抖动，
    //    而这条断言要抓的是"没跑哈希所以快一个数量级"那种缺陷。
    const t1 = await timed(() => adminLogin(srv, 'no-such-admin-2', ADMIN_PASS))
    const t2 = await timed(() => adminLogin(srv, ADMIN_USER, 'definitely-wrong-2'))
    const ratio = Math.max(t1, t2) / Math.max(1, Math.min(t1, t2))
    assert.ok(ratio < 4,
      `两种失败的耗时比 ${ratio.toFixed(2)} 过大（${t1}ms vs ${t2}ms）——` +
      '说明"账号不存在"的路径没有做等价代价的哈希比对（时序侧信道）')
  } finally {
    await srv.cleanup()
  }
})

test('后台：每 IP 登录限流独立于账号锁定（默认 10 次/分钟）', async () => {
  // ⚠️ 两层减速带必须**独立计**（部署指南 §9.4）：
  //    · 每 IP 限流挡住"同一来源撞很多账号"
  //    · 按账号锁定挡住"很多来源撞同一个账号"
  //    只有其中一层时，另一种攻击形状就是免费的。
  const srv = await makeServer({ loginRatePerMinute: 3 })
  try {
    await seedAdmin(srv)
    const codes = []
    // 每次换一个**不同的**用户名，确保不触发账号锁定，只触发 IP 限流
    for (let i = 0; i < 5; i++) {
      const r = (await adminLogin(srv, `probe-${i}`, 'whatever-pw-1')).res
      codes.push(r.status)
    }
    assert.deepStrictEqual(codes.slice(0, 3), [401, 401, 401], '前 3 次应是密码错误')
    assert.deepStrictEqual(codes.slice(3), [423, 423], '超限后必须是 423（限流），而不是继续放行')
  } finally {
    await srv.cleanup()
  }
})

test('后台：登录成功的 cookie 必须是 HttpOnly + SameSite=Strict + Path=<adminPath>', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { res, cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    assert.strictEqual(res.status, 200)
    assert.ok(cookie, '必须下发会话 cookie')
    assert.match(cookie, /^dy_admin_session=[0-9a-f]{64}$/, '令牌必须是 32 字节 hex')

    const sc = res.headers['set-cookie'][0]
    assert.match(sc, /HttpOnly/i, 'cookie 必须 HttpOnly（JS 读不到，XSS 拿不走）')
    assert.match(sc, /SameSite=Strict/i, 'cookie 必须 SameSite=Strict')
    assert.ok(sc.includes(`Path=${ADMIN_PATH}`), `cookie Path 必须是后台路径，实际：${sc}`)
    assert.match(sc, /Max-Age=\d+/, '必须有 Max-Age（会话要会过期）')

    // ⚠️ 令牌绝不回显在 JSON 体里（否则一次 console.log / 一次 XSS 就送出去了）
    const token = cookie.split('=')[1]
    assert.strictEqual(res.text.includes(token), false, '响应体里出现了会话令牌原文')
    assert.strictEqual(res.json.token, undefined)
    assert.strictEqual(res.json.session_token, undefined)

    // 库里只存 sha256，不存明文
    const row = srv.inst.db.prepare('SELECT token_hash FROM admin_session').get()
    const sha = require('node:crypto').createHash('sha256').update(token, 'utf8').digest('hex')
    assert.strictEqual(String(row.token_hash), sha, '库里必须只存 sha256(token)')
    assert.notStrictEqual(String(row.token_hash), token)

    // 会话可用
    const ok = await adminGet(srv, cookie, `${ADMIN_PATH}/api/session`)
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.json.ok, true)
    assert.strictEqual(ok.json.admin.username, ADMIN_USER)
    assert.strictEqual(ok.json.session_ttl_hours, 12, '默认 TTL 必须是 12 小时（§9.3）')
    assert.strictEqual(ok.text.includes(token), false, '/api/session 泄漏了令牌')
  } finally {
    await srv.cleanup()
  }
})

test('后台：过期会话被拒绝，并在鉴权路径上被清理', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    assert.strictEqual((await adminGet(srv, cookie, `${ADMIN_PATH}/api/overview`)).status, 200)

    // ⚠️ 直接把 expires_at_ms 拨到过去——这是唯一能确定性地测"过期"的方式
    //    （等 12 小时不现实；改 TTL 配置又测不到"已签发会话"的行为）。
    srv.inst.db.prepare('UPDATE admin_session SET expires_at_ms = ?').run(Date.now() - 1000)

    const expired = await adminGet(srv, cookie, `${ADMIN_PATH}/api/overview`)
    assert.strictEqual(expired.status, 401, '过期会话必须被拒')
    assert.strictEqual(expired.json.code, 'ADMIN_SESSION_INVALID')

    // 过期行应被顺手清掉（否则会话表会无声增长）
    const left = srv.inst.db.prepare('SELECT COUNT(*) AS c FROM admin_session').get()
    assert.strictEqual(Number(left.c), 0, '过期会话应在鉴权时被清理')

    // 无 cookie 与坏 cookie 分别给不同的码（便于前端区分"没登录"与"会话失效"）
    const none = await adminGet(srv, null, `${ADMIN_PATH}/api/overview`)
    assert.strictEqual(none.status, 401)
    assert.strictEqual(none.json.code, 'ADMIN_TOKEN_MISSING')
    const bogus = await adminGet(srv, 'dy_admin_session=' + 'a'.repeat(64), `${ADMIN_PATH}/api/overview`)
    assert.strictEqual(bogus.status, 401)
    assert.strictEqual(bogus.json.code, 'ADMIN_SESSION_INVALID')
  } finally {
    await srv.cleanup()
  }
})

test('后台：登出后会话立刻失效（且只失效自己那一个）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const a = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    const b = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    assert.notStrictEqual(a.cookie, b.cookie)

    const out = await adminPost(srv, a.cookie, `${ADMIN_PATH}/api/logout`, {})
    assert.strictEqual(out.status, 200)
    assert.strictEqual(out.json.revoked_count, 1)
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/, '登出必须清 cookie')

    assert.strictEqual((await adminGet(srv, a.cookie, `${ADMIN_PATH}/api/overview`)).status, 401)
    assert.strictEqual((await adminGet(srv, b.cookie, `${ADMIN_PATH}/api/overview`)).status, 200,
      '登出只应影响当前会话')
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 3. IP 白名单
// ══════════════════════════════════════════════════════════

test('后台：IP 不在白名单内 → 403，**即便会话有效**', async () => {
  // 白名单刻意只含一个不可能匹配本机测试流量的地址
  const srv = await makeServer({ adminIpAllow: ['203.0.113.7/32'] })
  try {
    await seedAdmin(srv)

    // 连登录都不行（白名单在鉴权之前）
    const login = (await adminLogin(srv, ADMIN_USER, ADMIN_PASS)).res
    assert.strictEqual(login.status, 403)
    assert.strictEqual(login.json.code, 'ADMIN_IP_DENIED')

    // 造一个"本来有效"的会话，证明拒绝发生在会话校验之前/之外
    const now = Date.now()
    const token = 'f'.repeat(64)
    srv.inst.db.prepare(`
      INSERT INTO admin_session (admin_id, token_hash, ip, user_agent, issued_at_ms, last_seen_ms, expires_at_ms)
      VALUES ((SELECT id FROM admin_user WHERE username = ?), ?, '203.0.113.7', 'test', ?, ?, ?)
    `).run(ADMIN_USER, require('node:crypto').createHash('sha256').update(token).digest('hex'),
      now, now, now + 3600000)

    const withValidSession = await adminGet(srv, `dy_admin_session=${token}`, `${ADMIN_PATH}/api/overview`)
    assert.strictEqual(withValidSession.status, 403, '有有效会话也不能绕过 IP 白名单')
    assert.strictEqual(withValidSession.json.code, 'ADMIN_IP_DENIED')

    // 静态资源同样被挡（否则界面加载出来但接口全 403，排障会走弯路）
    const asset = await adminGet(srv, null, `${ADMIN_PATH}/app.js`)
    assert.strictEqual(asset.status, 403)
  } finally {
    await srv.cleanup()
  }
})

test('后台：TRUST_PROXY=0 时伪造 X-Forwarded-For 无法进入白名单', async () => {
  const srv = await makeServer({ adminIpAllow: ['203.0.113.7/32'], trustProxy: false })
  try {
    const r = await req(srv, 'GET', `${ADMIN_PATH}/api/session`, {
      headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Real-IP': '203.0.113.7' },
    })
    assert.strictEqual(r.status, 403,
      'TRUST_PROXY=0 时必须忽略转发头——否则攻击者自己加一个头就进了白名单')
  } finally {
    await srv.cleanup()
  }
})

test('后台：TRUST_PROXY=1 时按反代给出的真实 IP 判定（并归一化 IPv4-mapped）', async () => {
  const A = require('../../license-server/admin/api')
  const cfgTrust = { trustProxy: true }
  const cfgDirect = { trustProxy: false }
  const mk = (remote, headers) => ({ socket: { remoteAddress: remote }, headers: headers || {} })

  assert.strictEqual(A.clientIpOf(mk('127.0.0.1', { 'x-real-ip': '203.0.113.7' }), cfgTrust), '203.0.113.7')
  assert.strictEqual(A.clientIpOf(mk('127.0.0.1', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), cfgTrust), '203.0.113.7')
  assert.strictEqual(A.clientIpOf(mk('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), cfgDirect), '127.0.0.1',
    '直连时必须忽略转发头')
  assert.strictEqual(A.clientIpOf(mk('::ffff:127.0.0.1'), cfgDirect), '127.0.0.1', 'IPv4-mapped 必须归一化')

  // CIDR 匹配
  assert.strictEqual(A.ipEntryMatches('10.0.0.0/8', '10.9.9.9'), true)
  assert.strictEqual(A.ipEntryMatches('10.0.0.0/8', '11.0.0.1'), false)
  assert.strictEqual(A.ipEntryMatches('192.168.1.0/24', '192.168.1.255'), true)
  assert.strictEqual(A.ipEntryMatches('192.168.1.0/24', '192.168.2.1'), false)
  assert.strictEqual(A.ipEntryMatches('2001:db8::/32', '2001:db8:1234::9'), true)
  assert.strictEqual(A.ipEntryMatches('2001:db8::/32', '2001:db9::9'), false)
  assert.strictEqual(A.ipEntryMatches('0.0.0.0/0', '8.8.8.8'), true)
})

// ══════════════════════════════════════════════════════════
// 4. CSRF
// ══════════════════════════════════════════════════════════

test('后台：状态变更 POST 带外来 Origin → 403（SameSite 之外的第二道门）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId } = seedMerchant(srv.inst.db, { credits: 100 })
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const before = srv.inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)

    const evil = await req(srv, 'POST', `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`, {
      cookie,
      headers: { Origin: 'https://evil.example', Host: `127.0.0.1:${srv.port}` },
      body: { amount: 999999, reason: 'csrf attack' },
    })
    assert.strictEqual(evil.status, 403)
    assert.strictEqual(evil.json.code, 'ADMIN_CSRF_REJECTED')

    // ⚠️ 必须"什么都没发生"——被拒的请求不得产生任何副作用
    const after = srv.inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(after.balance_milli), Number(before.balance_milli),
      '被 CSRF 拒绝的请求竟然改了余额')
    const ledger = srv.inst.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(ledger.c), 1, '只应有开号时那一条台账')

    // 同源但缺 Origin/Referer → 也必须拒（"缺失"不等于"可信"）
    const noOrigin = await req(srv, 'POST', `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`, {
      cookie, body: { amount: 1, reason: 'no origin' },
    })
    assert.strictEqual(noOrigin.status, 403)
    assert.strictEqual(noOrigin.json.code, 'ADMIN_CSRF_REJECTED')

    // Origin 为 null（沙箱 iframe / data: URL）→ 拒
    const nullOrigin = await req(srv, 'POST', `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`, {
      cookie, headers: { Origin: 'null' }, body: { amount: 1, reason: 'null origin' },
    })
    assert.strictEqual(nullOrigin.status, 403)

    // 表单编码（不触发预检的简单请求）→ 拒
    const formPost = await req(srv, 'POST', `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`, {
      cookie,
      headers: { Origin: srv.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'amount=1&reason=x',
    })
    assert.strictEqual(formPost.status, 403)
    assert.strictEqual(formPost.json.code, 'ADMIN_CSRF_REJECTED')

    // Referer 也算同源凭据（老浏览器不发 Origin）
    const viaReferer = await req(srv, 'POST', `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`, {
      cookie,
      headers: { Referer: `${srv.base}${ADMIN_PATH}/` },
      body: { amount: 50, reason: '通过 Referer 同源' },
    })
    assert.strictEqual(viaReferer.status, 200, 'Referer 同源应当被接受（Origin 缺失时的兼容路径）')
    assert.strictEqual(viaReferer.json.balance_credits, '150')

    // 同源 Origin 正常放行
    const ok = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`,
      { amount: 10, reason: '正常补发' })
    assert.strictEqual(ok.status, 200)
  } finally {
    await srv.cleanup()
  }
})

test('后台：登录接口同样过 CSRF（否则可拿厂商浏览器当撞库跳板）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const evil = await req(srv, 'POST', `${ADMIN_PATH}/api/login`, {
      headers: { Origin: 'https://evil.example', Host: `127.0.0.1:${srv.port}` },
      body: { user: ADMIN_USER, password: ADMIN_PASS },
    })
    assert.strictEqual(evil.status, 403)
    assert.strictEqual(evil.json.code, 'ADMIN_CSRF_REJECTED')
    assert.strictEqual(evil.headers['set-cookie'], undefined, '被拒的登录不得下发 cookie')
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 5. 静态资源与路径穿越
// ══════════════════════════════════════════════════════════

test('后台：静态资源白名单生效，路径穿越一律拒绝', async () => {
  const srv = await makeServer()
  try {
    // ⚠️ 静态资源**不需要登录**（登录页是首屏，否则形成"要登录先有后台"的死锁），
    //    但仍受 IP 白名单与文件名白名单约束。这一点由下面"IP 被拒时资源也 403"的
    //    用例单独钉住——见「IP 不在白名单内」那条。
    const index = await req(srv, 'GET', `${ADMIN_PATH}/`)
    assert.strictEqual(index.status, 200)
    assert.match(index.headers['content-type'], /text\/html/)
    assert.match(index.text, /<!DOCTYPE html>/i)
    assert.match(index.headers['cache-control'] || '', /no-store/)
    assert.strictEqual(index.headers['x-frame-options'], 'DENY')
    assert.match(index.headers['content-security-policy'] || '', /default-src 'self'/)
    // 页面源码里绝不能嵌任何凭据
    assert.strictEqual(index.text.includes('dy_admin_session'), false)
    assert.match(index.text, /app\.js/)
    assert.match(index.text, /app\.css/)

    const css = await req(srv, 'GET', `${ADMIN_PATH}/app.css`)
    assert.strictEqual(css.status, 200)
    assert.match(css.headers['content-type'], /text\/css/)
    assert.match(css.text, /:root\s*\{/)

    const js = await req(srv, 'GET', `${ADMIN_PATH}/app.js`)
    assert.strictEqual(js.status, 200)
    assert.match(js.headers['content-type'], /javascript/)

    // ── 穿越尝试：每一条都必须**不是 200** ────────────────────
    const traversals = [
      `${ADMIN_PATH}/../server.js`,
      `${ADMIN_PATH}/..%2fserver.js`,
      `${ADMIN_PATH}/..%2F..%2Fserver.js`,
      `${ADMIN_PATH}/%2e%2e%2fserver.js`,
      `${ADMIN_PATH}/%2e%2e/server.js`,
      `${ADMIN_PATH}/..%5cserver.js`,
      `${ADMIN_PATH}/....//server.js`,
      `${ADMIN_PATH}/web/../api.js`,
      `${ADMIN_PATH}/../admin/api.js`,
      `${ADMIN_PATH}/app.js/../../server.js`,
    ]
    for (const p of traversals) {
      const r = await req(srv, 'GET', p)
      assert.notStrictEqual(r.status, 200, `${p} 竟然返回 200（路径穿越）`)
      assert.strictEqual(r.text.includes('createServer'), false, `${p} 泄漏了源码`)
    }

    // 形态检查的纯函数层（不依赖 HTTP 栈的规范化行为）
    const A = require('../../license-server/admin/api')
    for (const bad of ['/a/../b', '/a/..%2fb', '/a\\b', '/a/%2e%2e/b']) {
      assert.throws(() => A.assertSafeAssetPath(bad), /资源路径/, `${bad} 应被拒绝`)
    }
    assert.doesNotThrow(() => A.assertSafeAssetPath(`${ADMIN_PATH}/app.js`))
  } finally {
    await srv.cleanup()
  }
})

test('后台：未实现的接口返回 501 结构化信封，绝不 200 + 空数据（D-14）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const unknown = await adminGet(srv, cookie, `${ADMIN_PATH}/api/definitely-not-here`)
    assert.strictEqual(unknown.status, 501)
    assert.strictEqual(unknown.json.ok, false)
    assert.strictEqual(unknown.json.code, 'NOT_IMPLEMENTED')
    assert.ok(unknown.json.message.length > 0)
    assert.strictEqual(unknown.json.detail.path, `${ADMIN_PATH}/api/definitely-not-here`)
    assert.notDeepStrictEqual(unknown.json, {}, '绝不能是 200 + {}')

    // 已实现路径用错方法 → 405（不是 200，也不是静默 404）
    const wrongMethod = await req(srv, 'POST', `${ADMIN_PATH}/api/overview`, {
      cookie, headers: { Origin: srv.base, Host: `127.0.0.1:${srv.port}` }, body: {},
    })
    assert.strictEqual(wrongMethod.status, 405)
    assert.strictEqual(wrongMethod.json.code, 'ADMIN_METHOD_NOT_ALLOWED')

    // ⚠️ 未实现接口的 501 **必须也要求登录**，否则它成了一个免鉴权的探测面
    //    （未登录的扫描器能靠 501/401 的差异把接口清单免费问出来）。
    const noAuth = await adminGet(srv, null, `${ADMIN_PATH}/api/definitely-not-here`)
    assert.strictEqual(noAuth.status, 401, '未登录时未知接口必须回 401，不能回 501')
    assert.strictEqual(noAuth.json.code, 'ADMIN_TOKEN_MISSING')
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 6. 隐私：发送明细只有哈希与判定
// ══════════════════════════════════════════════════════════

test('后台：/sends 与 /forensics 响应里没有原文、没有 sec_uid（红线 3）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId } = seedMerchant(srv.inst.db, { credits: 100 })

    // ⚠️ 种子数据里放"一眼可见"的特征串。
    //    它们**不该**出现在响应里——不是因为字段名不在白名单，
    //    而是因为上游（契约 §7.5）根本不接受这些字段。
    //    这里把它们塞进库，模拟"历史数据里已经混进了脏值"的最坏情况：
    //    后台的投影必须仍然不把它们带出去。
    insertSend(srv.inst.db, accountId, {
      sendId: 's-leak-1',
      userKeyHash: LEAK_SEC_UID,
      targetHash: LEAK_SEC_UID,
      contentHash: 'ch-hash-clean',
      verdict: 'failed',
      failureReason: 'risk_control_rejected',
      billingStatus: 'unbilled_risk_control',
      chargedMilli: 0,
    })
    // 库里再多塞几处"原文"——用**不会被字段语义误伤**的独立特征串。
    // ⚠️ 注意：`content_hash` 位上的值本来就允许出现在响应里（它就是哈希），
    //    所以不能拿同一个串既当哈希又当"泄漏标记"。这里用独立串，
    //    命中了就一定是真泄漏。
    insertConfigChange(srv.inst.db, accountId, {
      changeId: 'ch-leak-1', newValue: LEAK_REPLY, rejectCode: 'POLICY_VIOLATION', applied: false,
    })
    srv.inst.db.prepare('UPDATE account SET note = ? WHERE account_id = ?')
      .run(`备注里含 ${LEAK_SEC_UID}`, accountId)
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const sends = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/sends?limit=50`)
    assert.strictEqual(sends.status, 200)
    assert.strictEqual(sends.json.items.length, 1)
    assert.strictEqual(sends.json.items[0].send_id, 's-leak-1')
    assert.strictEqual(sends.json.items[0].verdict, 'failed')
    assert.strictEqual(sends.json.items[0].failure_reason, 'risk_control_rejected')
    assert.ok(sends.json.privacy.rule.includes('哈希'))
    assert.deepStrictEqual(sends.json.privacy.violations_stripped, [])

    // ── 关键断言：整份序列化响应里不得出现任何特征串 ────────────
    //    ⚠️ 用哈希值与"字段名"两种方式都不如直接搜字符串可靠：
    //       前者会被 LEAK_SEC_UID 这个名字误导（它是哈希位上的脏值），
    //       后者在字段改名后失效。
    //    ⚠️⚠️ 这里踩过一个"检查方式本身写错"的坑，值得记下来：
    //       原本写的是 `sends.text.includes('"sec_uid"')` —— 而合法字段
    //       `user_key_type` 的取值就是 `"sec_uid_hash"`（protocol.md §7.3
    //       明确要求），它**包含** `"sec_uid"` 这个子串。
    //       于是"红线 3 检查"在**完全合规**的响应上报了警报，
    //       而真正的泄漏反而可能被这个假阳性掩盖。
    //
    //       正确做法是判断"**键名**是不是 sec_uid"，而不是"文本里有没有这个子串"。
    //       这里用正则匹配 JSON 的键位置（`"sec_uid"` 后面紧跟冒号）。
    assert.strictEqual(/"sec_uid"\s*:/.test(sends.text), false,
      '/sends 响应里出现了 sec_uid **字段名**')
    assert.strictEqual(sends.text.includes('sec_uid_plain'), false)
    assert.strictEqual(sends.text.includes('"comment_text"'), false)
    assert.strictEqual(sends.text.includes('"reply_text"'), false)
    assert.strictEqual(sends.text.includes('"nickname"'), false)
    assert.strictEqual(sends.text.includes('"pass_hash"'), false)
    // 库里那些"脏哈希"本身**可以**出现（它们是哈希位上的值，不是原文），
    // 但评论/回复原文的特征串绝不能出现——它们根本没被投影。
    assert.strictEqual(sends.text.includes(LEAK_COMMENT), false,
      '/sends 泄漏了评论原文特征串')
    assert.strictEqual(sends.text.includes(LEAK_REPLY), false, '/sends 泄漏了回复原文特征串')

    // 每一行都只能有白名单字段
    const A = require('../../license-server/admin/api')
    for (const item of sends.json.items) {
      for (const k of Object.keys(item)) {
        assert.ok(A.SEND_DETAIL_FIELDS.includes(k), `字段 ${k} 不在投影白名单里`)
        assert.ok(!A.FORBIDDEN_RESPONSE_KEYS.includes(k.toLowerCase()), `字段 ${k} 在黑名单里`)
      }
    }

    // 取证页同理（它同时返回明细与变更历史）
    const forensics = await adminGet(srv, cookie, `${ADMIN_PATH}/api/forensics/${MERCHANT}`)
    assert.strictEqual(forensics.status, 200)
    assert.strictEqual(/"sec_uid"\s*:/.test(forensics.text), false,
      '/forensics 响应里出现了 sec_uid **字段名**')
    assert.strictEqual(forensics.text.includes(LEAK_COMMENT), false)
    // ⚠️ `LEAK_REPLY` **允许**出现在取证页里：它被种在 `audit_config_changes.new_value`
    //    上，而那一列本身就是 §4.9 规定的举证材料（"用户把上限从 10 报成 100"）。
    //    取证页要能回答"用户是否主动调高过"，就必须原样显示上报值。
    //    真正必须挡住的是**发送明细**里的原文——见下面 /sends 的断言。
    assert.ok(forensics.text.includes(LEAK_REPLY),
      '取证页必须原样显示配置变更的上报值（它是举证材料，不是泄漏）')
    assert.deepStrictEqual(forensics.json.privacy.violations_stripped, [])

    // 商家详情里也不许有（note 是用户输入，可以出现；但 sec_uid 不行）
    const detail = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}`)
    assert.strictEqual(detail.status, 200)
    assert.strictEqual(/"sec_uid"\s*:/.test(detail.text), false)
    assert.strictEqual(detail.text.includes('content_text'), false)

    // ── 投影的两道防线分别验证 ─────────────────────────────────
    // 第一道（主防线）：白名单之外的字段**根本进不来**。
    const violations = []
    const projected = A.projectSend({ send_id: 'x', sec_uid: 'leak', verdict: 'failed' }, violations)
    assert.strictEqual(projected.send_id, 'x', '白名单内字段必须保留')
    assert.strictEqual(projected.verdict, 'failed')
    assert.strictEqual(projected.sec_uid, undefined, '白名单外的字段不得出现在投影结果里')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projected, 'sec_uid'), false)
    assert.deepStrictEqual(violations, [], '未列入白名单的字段连"违规"都算不上——它根本没被取过')

    // 第二道（兜底防线）：万一有人把禁用字段**写进了白名单**，
    // 也必须被剥掉并计数上报，而不是静默放行。
    //
    // ⚠️ 这里**不能**直接改 `A.SEND_DETAIL_FIELDS`：它是 `Object.freeze` 过的
    //    （这是对的——白名单是编译期常量，不该被运行时改写）。
    //    早期写法是 push 进那个冻结数组、finally 里再 `length = 0` 复原，
    //    结果是 `Cannot assign to read only property 'length'` —— 测试自己在
    //    运行时炸掉，而"兜底防线会不会响"这件事根本没被验到。
    //    正确做法是用一个**局部副本**当白名单传进去。
    const listBackup = A.SEND_DETAIL_FIELDS.slice()
    const withLeak = listBackup.concat(['sec_uid'])
    const v2 = []
    const p2 = A.projectSend({ send_id: 'y', sec_uid: 'leak-2' }, v2, { fields: withLeak })
    assert.strictEqual(p2.sec_uid, undefined, '兜底防线没剥掉被误加进白名单的 sec_uid')
    assert.deepStrictEqual(v2, ['sec_uid'], '兜底剥离必须被计数上报，不能静默')

    // 冻结本身也是契约的一部分：白名单不该被运行时改写
    assert.ok(Object.isFrozen(A.SEND_DETAIL_FIELDS), '白名单必须是冻结的（防止被运行时改写）')
    assert.deepStrictEqual(A.SEND_DETAIL_FIELDS, listBackup, '导出常量未被测试改坏')
    assert.ok(A.FORBIDDEN_RESPONSE_KEYS.includes('sec_uid'))
    assert.ok(A.FORBIDDEN_RESPONSE_KEYS.includes('comment_text'))
    assert.ok(A.FORBIDDEN_RESPONSE_KEYS.includes('reply_text'))
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 7. 取证：四个 §4.10 问题 + 生效值来自 policy_ack_log
// ══════════════════════════════════════════════════════════

test('后台：/forensics 返回 §4.10 的四个答案，且生效上限来自 policy_ack_log（红线 3）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId, now } = seedMerchant(srv.inst.db, { credits: 100, accountDayIndex: 30 })

    // ⚠️ 关键设计：让"实际生效值"与"当前策略值"**刻意不同**。
    //    第 30 天 = 稳定期 → 当前 comment.daily_max = 30（由 tier_table 推导）。
    //    而 ack 里记的是 5（用户自己调低了）。若实现是从当前策略倒推，
    //    它必然报 30 —— 这条断言就会失败。
    const APPLIED_DAILY_MAX = 5
    insertAck(srv.inst.db, accountId, {
      policyVersion: 7, dayIndex: 30, tier: 'stable',
      appliedLimits: {
        comment: { daily_max: APPLIED_DAILY_MAX, min_interval_ms: 180000, content_similarity_max: 0.6 },
        dm: { daily_max: 2 },
      },
      firstAckAtMs: now - 3600000, lastSeenAtMs: now - 600000,
    })

    // (c) 用户主动调高过 + 被拒绝过
    insertConfigChange(srv.inst.db, accountId, {
      changeId: 'ch-raise-1', changedAtMs: now - 7200000, source: 'user', actor: 'local_user',
      fieldKey: 'limits.comment.daily_max', oldValue: '10', newValue: '100',
      applied: false, rejectCode: 'POLICY_VIOLATION', policyVersion: 7,
    })
    // 服务端收紧过（来源应被区分出来）
    insertConfigChange(srv.inst.db, accountId, {
      changeId: 'ch-server-1', changedAtMs: now - 7000000, source: 'server_policy', actor: 'license_server',
      fieldKey: 'limits.comment.daily_max', oldValue: '30', newValue: '10',
      applied: true, rejectCode: null, policyVersion: 7,
    })

    // (d) 窗口内的发送（含一条风控失败）
    insertSend(srv.inst.db, accountId, {
      sendId: 's-f1', verdict: 'sent_confirmed', sentAtMs: now - 1800000,
    })
    insertSend(srv.inst.db, accountId, {
      sendId: 's-f2', verdict: 'failed', failureReason: 'risk_control_rejected',
      confirmSignal: 'none', statusCode: null, billingStatus: 'unbilled_risk_control',
      chargedMilli: 0, sentAtMs: now - 1700000,
    })
    insertSend(srv.inst.db, accountId, {
      sendId: 's-f3', verdict: 'sent_confirmed_dom', confirmSignal: 'dom_stable',
      billingStatus: 'unbilled_dom_only', chargedMilli: 0, sentAtMs: now - 1600000,
    })

    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    const r = await adminGet(srv, cookie, `${ADMIN_PATH}/api/forensics/${MERCHANT}?hours=24`)
    assert.strictEqual(r.status, 200)
    const f = r.json

    // ── 四个问题都在，且都有可读答案 ───────────────────────────
    for (const key of ['policy_at', 'change_origin', 'refusal', 'sends_at']) {
      assert.ok(f[key], `缺少 §4.10 的答案段：${key}`)
      assert.ok(typeof f[key].question === 'string' && f[key].question.length > 0, `${key}.question 缺失`)
      assert.ok(typeof f[key].answer_zh === 'string' && f[key].answer_zh.length > 0, `${key}.answer_zh 缺失`)
      assert.ok(typeof f[key].source === 'string' && f[key].source.length > 0, `${key}.source 缺失`)
    }
    assert.match(f.policy_at.question, /实际生效/)
    assert.match(f.change_origin.question, /服务端/)
    assert.match(f.refusal.question, /调高/)
    assert.match(f.sends_at.question, /发了什么|风控/)

    // ── (a) 生效值来自 policy_ack_log，**不是**当前策略 ────────
    assert.strictEqual(f.policy_at.source.includes('policy_ack_log'), true,
      'policy_at.source 必须点明数据来自 policy_ack_log')
    assert.strictEqual(f.policy_at.ack.policy_version, 7)
    assert.strictEqual(f.policy_at.effective_limits.comment.daily_max, APPLIED_DAILY_MAX,
      '生效上限必须来自 ack，而不是从当前策略倒推')
    assert.strictEqual(f.policy_at.from_send_snapshot, null, '没有快照时必须是 null，不能编一个')

    // ── 红线 3 的核心性质：生效值与当前值**不同**时必须被看见 ──
    assert.notStrictEqual(
      f.policy_at.effective_limits.comment.daily_max,
      f.policy_at.current_policy.limits.comment.daily_max,
      '前置条件：种子里两者必须不同，否则这条用例测不出"读的是哪一份"'
    )
    assert.strictEqual(f.policy_at.limits_differ, true, '两者不同时必须标记 limits_differ')

    // ── (b) 来源可区分 ────────────────────────────────────────
    assert.strictEqual(f.change_origin.counts.from_user, 1)
    assert.strictEqual(f.change_origin.counts.from_server, 1)
    assert.strictEqual(f.change_origin.verdict, 'both')

    // ── (c) 调高尝试与被拒都抓到 ──────────────────────────────
    assert.strictEqual(f.refusal.attempted_raise, true)
    assert.strictEqual(f.refusal.escalations.length, 1)
    assert.strictEqual(f.refusal.escalations[0].field_key, 'limits.comment.daily_max')
    assert.strictEqual(f.refusal.escalations[0].direction, 'loosen')
    assert.strictEqual(f.refusal.refusals.length, 1)
    assert.strictEqual(f.refusal.refusals[0].reject_code, 'POLICY_VIOLATION')
    assert.deepStrictEqual(f.refusal.refuse_codes, ['POLICY_VIOLATION'])

    // ── (d) 窗口内发送，四个判定分开 ──────────────────────────
    assert.strictEqual(f.sends_at.counts.reply_attempts, 3)
    assert.strictEqual(f.sends_at.counts.sent_confirmed, 1)
    assert.strictEqual(f.sends_at.counts.sent_confirmed_dom, 1)
    assert.strictEqual(f.sends_at.counts.failed, 1)
    assert.strictEqual(f.sends_at.risk_control_failures, 1)
    assert.strictEqual(f.sends_at.failure_reasons.risk_control_rejected, 1)
    // 成功率 = 1/3 → 由 stats.js 算成展示串
    assert.strictEqual(f.sends_at.success_rate_display, '33.3%')

    // ── 没有 ack 的账号必须**如实说没有**，不能假装有 ──────────
    const empty = seedMerchant(srv.inst.db, { account: 'demo-noack', credits: 10 })
    assert.ok(empty.accountId > 0)
    const r2 = await adminGet(srv, cookie, `${ADMIN_PATH}/api/forensics/demo-noack?hours=24`)
    assert.strictEqual(r2.status, 200)
    assert.strictEqual(r2.json.policy_at.ack, null)
    assert.strictEqual(r2.json.policy_at.effective_limits, null)
    assert.match(r2.json.policy_at.answer_zh, /没有任何策略确认记录/)
    assert.strictEqual(r2.json.sends_at.counts.reply_attempts, 0)
    assert.strictEqual(r2.json.sends_at.success_rate, null, '窗口内 0 条尝试 → 比率必须是 null')
  } finally {
    await srv.cleanup()
  }
})

test('后台：取证的时间点参数会挑出**该时刻之前**最后一条 ack，并标注回退', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId, now } = seedMerchant(srv.inst.db, { credits: 100 })
    insertAck(srv.inst.db, accountId, {
      policyVersion: 3, appliedLimits: { comment: { daily_max: 10 } },
      firstAckAtMs: now - 10 * 86400000, lastSeenAtMs: now - 10 * 86400000,
    })
    insertAck(srv.inst.db, accountId, {
      policyVersion: 9, appliedLimits: { comment: { daily_max: 25 } },
      firstAckAtMs: now - 3600000, lastSeenAtMs: now - 1800000,
    })
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    // 问"两天前" → 应是 v3（v9 那时还没确认过）
    const dayKeyStr = new Date(now - 2 * 86400000).toISOString().slice(0, 10)
    const past = await adminGet(srv, cookie, `${ADMIN_PATH}/api/forensics/${MERCHANT}?at=${dayKeyStr}`)
    assert.strictEqual(past.status, 200)
    assert.strictEqual(past.json.policy_at.ack.policy_version, 3)
    assert.strictEqual(past.json.policy_at.ack_is_fallback, false)
    assert.strictEqual(past.json.policy_at.effective_limits.comment.daily_max, 10)

    // 问"现在" → 应是 v9
    const nowq = await adminGet(srv, cookie, `${ADMIN_PATH}/api/forensics/${MERCHANT}`)
    assert.strictEqual(nowq.json.policy_at.ack.policy_version, 9)
    assert.strictEqual(nowq.json.policy_at.effective_limits.comment.daily_max, 25)

    // 问"20 天前" → 一条都没有 → 必须标 fallback，**不能假装它在那个时刻生效过**
    const ancientKey = new Date(now - 20 * 86400000).toISOString().slice(0, 10)
    const ancient = await adminGet(srv, cookie, `${ADMIN_PATH}/api/forensics/${MERCHANT}?at=${ancientKey}`)
    assert.strictEqual(ancient.status, 200)
    assert.strictEqual(ancient.json.policy_at.ack_is_fallback, true)
    assert.ok(ancient.json.policy_at.ack_fallback_note.length > 0)
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 8. 总览：成功率的分母为 0 → null（不是 100%）
// ══════════════════════════════════════════════════════════

test('后台：/overview 成功率分母为 0 → null，界面渲染为 —（不是 100%）', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    seedMerchant(srv.inst.db, { credits: 100 })
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const empty = await adminGet(srv, cookie, `${ADMIN_PATH}/api/overview?days=7`)
    assert.strictEqual(empty.status, 200)
    assert.strictEqual(empty.json.success_rate, null, '零分母必须是 null')
    assert.strictEqual(empty.json.success_rate_display, '—', '零分母必须显示 —')
    assert.strictEqual(empty.json.dashboard.empty, true, '必须显式标出空态')
    assert.strictEqual(empty.json.range.reply_attempts, 0)
    assert.strictEqual(empty.json.trend.length, 7)
    assert.strictEqual(empty.json.reconcile.mismatched_accounts, 0)

    // 有数据之后：1 成功 / 3 尝试 → 33.3%
    const { accountId, now } = seedMerchant(srv.inst.db, { account: 'demo002', credits: 100 })
    insertSend(srv.inst.db, accountId, { sendId: 'a1', sentAtMs: now - 1000 })
    insertSend(srv.inst.db, accountId, {
      sendId: 'a2', verdict: 'failed', failureReason: 'rate_limited',
      billingStatus: 'unbilled_failed', chargedMilli: 0, sentAtMs: now - 900,
    })
    insertSend(srv.inst.db, accountId, {
      sendId: 'a3', verdict: 'sent_suspected', confirmSignal: 'none',
      billingStatus: 'not_billable', chargedMilli: 0, sentAtMs: now - 800,
    })

    const withData = await adminGet(srv, cookie, `${ADMIN_PATH}/api/overview?days=7`)
    assert.strictEqual(withData.json.range.reply_attempts, 3)
    assert.strictEqual(withData.json.range.sent_confirmed, 1)
    assert.strictEqual(withData.json.range.sent_confirmed_dom, 0)
    assert.strictEqual(withData.json.range.sent_suspected, 1)
    assert.strictEqual(withData.json.range.failed, 1)
    assert.strictEqual(withData.json.success_rate_display, '33.3%')
    assert.strictEqual(withData.json.dashboard.empty, false)
    // 失败原因分布必须带上（stats.js 的 aggregateSends 不产出它，由后台补齐）
    assert.strictEqual(withData.json.failure_reasons.rate_limited, 1)
    assert.deepStrictEqual(withData.json.dashboard.audit_flags, [])
  } finally {
    await srv.cleanup()
  }
})

test('后台：界面源码里 null 比率渲染为 —，且不做任何百分比/单位换算', () => {
  const js = fs.readFileSync(path.join(ROOT, 'license-server/admin/web/app.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'license-server/admin/web/index.html'), 'utf8')
  // ⚠️ 先剥注释与字符串之外的说明文字再扫（本项目在 ui-check.js 上踩过同一个坑：
  //    注释里写着"不做 * 100 换算"反而被判成违规）。这里刻意剥掉块注释。
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, ' ')

  assert.ok(jsCode.includes('暂无数据'), '必须有"暂无数据"空态文案')
  assert.ok(jsCode.includes('—'), '必须把 null 渲染成 —')
  assert.match(jsCode, /function show\(/, '必须有统一的空值渲染函数')
  // 空值渲染函数的实现里必须是 '—' 而不是 0
  const showFn = jsCode.slice(jsCode.indexOf('function show('))
  assert.ok(showFn.slice(0, 400).includes("'—'"), 'show() 必须返回 —')

  assert.strictEqual(/\*\s*100\b/.test(jsCode), false, '前端不得做 * 100 百分比换算')
  assert.strictEqual(/\/\s*1000\b/.test(jsCode), false, '前端不得做 / 1000 单位换算')
  assert.strictEqual(/\/\s*[a-zA-Z_.]*reply_attempts/.test(jsCode), false, '前端不得自己算成功率')
  assert.strictEqual(/localStorage/.test(jsCode), false, '不得把后台数据留在浏览器磁盘上')

  // 静态资源与后台代码里不得有 CDN / 通配 CORS / eval
  const A = require('../../license-server/admin/api')
  const adminApi = fs.readFileSync(path.join(ROOT, 'license-server/admin/api.js'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'license-server/admin/web/app.css'), 'utf8')
  // ⚠️ 必须**先剥注释**再扫。HEAD 的 index.html 里就有
  //    "无框架、无构建、无 CDN、无外部字体"这句自我约束，
  //    直接扫全文会把那句约束本身判成违规——本项目在 scripts/ui-check.js
  //    上踩过同一个坑（那里的注释里写着"HTML 的说明性注释里写着…"）。
  const stripAll = (s) => s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  const all = [adminApi, js, html, css].map(stripAll)
  for (const src of all) {
    assert.strictEqual(/Access-Control-Allow-Origin/i.test(src), false, '后台不得出现 CORS 头')
    assert.strictEqual(/cdn|unpkg|jsdelivr|googleapis|fonts\.google/i.test(src), false, '不得引用 CDN/外部字体')
    assert.strictEqual(/\beval\s*\(/.test(src), false, '不得使用 eval')
    assert.strictEqual(/new Function\s*\(/.test(src), false, '不得使用 new Function')
  }
  // 静态资源表必须是显式白名单（不是目录遍历）
  assert.deepStrictEqual(Object.keys(A.STATIC_ASSETS).sort(),
    ['', '/', '/app.css', '/app.js', '/index.html'])
})

// ══════════════════════════════════════════════════════════
// 9. 商家列表与详情
// ══════════════════════════════════════════════════════════

test('后台：/merchants 列出余额/等级/心跳/今日用量，并给出告警标记', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    // 余额 1 积分 → 远低于 MIN_BALANCE_ALERT_REPLIES(500) × 单价(1000)
    const low = seedMerchant(srv.inst.db, { account: 'low-bal', credits: 1, accountDayIndex: 30 })
    const fine = seedMerchant(srv.inst.db, { account: 'fine-bal', credits: 12600, accountDayIndex: 30 })
    assert.ok(low.accountId && fine.accountId)

    // 给 fine-bal 造一个"新鲜心跳"的会话，low-bal 则完全没有会话
    const now = Date.now()
    srv.inst.db.prepare(`
      INSERT INTO device_session (account_id, device_id, token_hash, sign_key_hash, sign_key_plain,
                                  issued_at_ms, last_seen_ms, expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(fine.accountId, 'dev-1', 'th-1', 'skh-1', 'sk-1', now, now, now + 86400000)

    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    const r = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchants?limit=50`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.total, 2)
    const byName = {}
    for (const it of r.json.items) byName[it.account] = it

    assert.strictEqual(byName['low-bal'].balance_alert, true, '余额低必须标记')
    assert.deepStrictEqual(byName['low-bal'].alerts.includes('balance_low'), true)
    assert.strictEqual(byName['low-bal'].heartbeat_stale, true, '从未心跳 = 陈旧')
    assert.deepStrictEqual(byName['low-bal'].alerts.includes('heartbeat_stale'), true)
    assert.strictEqual(byName['fine-bal'].heartbeat_stale, false)
    assert.strictEqual(byName['fine-bal'].live_sessions, 1)
    assert.strictEqual(byName['fine-bal'].balance_credits, '12600')
    assert.strictEqual(byName['fine-bal'].replies_affordable, 12600)
    assert.strictEqual(byName['fine-bal'].account_tier, 'stable')
    assert.strictEqual(byName['fine-bal'].account_day_index, 30)
    // 今日上限来自 tier_table（稳定期 30+30+10），不是硬编码
    assert.strictEqual(byName['fine-bal'].today_cap.total, 70)
    assert.strictEqual(byName['fine-bal'].today_cap.by_source.comment, 30)

    // 过滤
    const q = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchants?q=low`)
    assert.strictEqual(q.json.total, 1)
    assert.strictEqual(q.json.items[0].account, 'low-bal')
    const badStatus = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchants?status=nonsense`)
    assert.strictEqual(badStatus.status, 400)
    assert.strictEqual(badStatus.json.code, 'ADMIN_BAD_REQUEST')

    // 空列表不是错误
    const none = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchants?q=zzzz-no-match`)
    assert.strictEqual(none.status, 200)
    assert.strictEqual(none.json.total, 0)
    assert.deepStrictEqual(none.json.items, [])
    assert.strictEqual(none.json.empty, true)
  } finally {
    await srv.cleanup()
  }
})

test('后台：/merchant/:account 详情含生效值、配额、变更历史（含 applied=0）与会话', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId, now } = seedMerchant(srv.inst.db, { credits: 500, accountDayIndex: 30 })
    insertAck(srv.inst.db, accountId, { appliedLimits: { comment: { daily_max: 5 } } })
    insertConfigChange(srv.inst.db, accountId, {
      changeId: 'ch-refused', applied: false, rejectCode: 'POLICY_VIOLATION', fieldKey: 'limits.dm.daily_max',
    })
    insertSend(srv.inst.db, accountId, { sendId: 'd1', sentAtMs: now - 1000 })

    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    const r = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.account.account, MERCHANT)
    assert.strictEqual(r.json.credit.balance_credits, '500')
    assert.strictEqual(r.json.policy.source_table, 'policy_ack_log')
    assert.strictEqual(r.json.policy.ack_present, true)
    assert.strictEqual(r.json.policy.effective_limits.comment.daily_max, 5)
    assert.strictEqual(r.json.policy.current_limits.comment.daily_max, 30)
    assert.strictEqual(r.json.policy.limits_differ, true)
    assert.strictEqual(r.json.quota.today_sends.total, 1)
    assert.strictEqual(r.json.config_changes.summary.refused, 1)
    assert.strictEqual(r.json.config_changes.items.length, 1)
    assert.strictEqual(r.json.config_changes.items[0].applied, false)
    assert.strictEqual(r.json.config_changes.items[0].reject_code, 'POLICY_VIOLATION')
    assert.strictEqual(r.json.config_changes.items[0].field_label, '私信日上限')
    assert.strictEqual(r.json.sends_summary.by_verdict.sent_confirmed, 1)
    assert.strictEqual(r.json.sends_summary.last_send.send_id, 'd1')
    assert.strictEqual(r.json.sessions.length, 0)

    // 不存在的账号 → 404 结构化信封
    const missing = await adminGet(srv, cookie, `${ADMIN_PATH}/api/merchant/no-such-account`)
    assert.strictEqual(missing.status, 404)
    assert.strictEqual(missing.json.code, 'ADMIN_NOT_FOUND')
    assert.ok(missing.json.message.includes('no-such-account'))
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 10. 台账 append-only + 积分发放走领域层
// ══════════════════════════════════════════════════════════

test('后台：发放积分写出的台账行 balance_after_milli 等于链式累计，且只增不改', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId } = seedMerchant(srv.inst.db, { credits: 100 })
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const add = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`,
      { amount: 25, reason: '商家投诉重复计费，人工补发' })
    assert.strictEqual(add.status, 200)
    assert.strictEqual(add.json.granted_credits, 25)
    assert.strictEqual(add.json.balance_credits, '125')
    assert.strictEqual(add.json.replies_affordable, 125)

    const sub = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`,
      { amount: -5, reason: '对账修正：撤销误发' })
    assert.strictEqual(sub.status, 200)
    assert.strictEqual(sub.json.balance_credits, '120')

    // ⚠️ 台账链自检：每行 balance_after_milli 必须等于该行之前的累计
    const rows = srv.inst.db.prepare(
      'SELECT id, kind, delta_milli, balance_after_milli, operator, note FROM credit_ledger WHERE account_id = ? ORDER BY id'
    ).all(accountId)
    assert.strictEqual(rows.length, 3, '开号 1 条 + 后台 2 条')
    let running = 0
    for (const row of rows) {
      running += Number(row.delta_milli)
      assert.strictEqual(Number(row.balance_after_milli), running,
        `#${row.id} 的 balance_after_milli 与链式累计不一致——说明有代码绕过了 grantCredits`)
    }
    const credit = srv.inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(credit.balance_milli), running, '余额快照必须等于台账累计')

    // 操作人必须带 admin: 前缀（便于日在凭证上区分人工与系统）
    assert.strictEqual(rows[1].operator, `admin:${ADMIN_USER}`)
    assert.strictEqual(rows[1].note, '商家投诉重复计费，人工补发')
    assert.strictEqual(rows[2].kind, 'adjust', '扣减走 adjust（与 CLI 的 credit revoke 同口径）')

    // 操作留痕
    const log = srv.inst.db.prepare(
      "SELECT action, target FROM admin_action_log WHERE action IN ('credit_grant','credit_revoke')"
    ).all()
    assert.strictEqual(log.length, 2)
    assert.strictEqual(log[0].target, MERCHANT)

    // 参数校验
    for (const bad of [{ amount: 0, reason: 'x' }, { amount: 'abc', reason: 'x' }, { amount: 1 }]) {
      const r = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`, bad)
      assert.strictEqual(r.status, 400, `${JSON.stringify(bad)} 应被拒`)
      assert.strictEqual(r.json.code, 'ADMIN_ACCOUNT_INVALID')
    }

    // 扣成负数必须被拒（且不能"顺手扣到 0"）
    const overdraft = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/credit`,
      { amount: -999999, reason: '试图扣成负数' })
    assert.strictEqual(overdraft.status, 402, 'CREDIT_EXHAUSTED 是 402')
    assert.strictEqual(overdraft.json.code, 'CREDIT_EXHAUSTED')
    const after = srv.inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
    assert.strictEqual(Number(after.balance_milli), 120000, '被拒的扣减不得改变余额')
  } finally {
    await srv.cleanup()
  }
})

test('后台：源码里对 credit_ledger 只有 INSERT（append-only 红线）', () => {
  const files = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
      else if (e.name.endsWith('.js')) files.push(p)
    }
  })(path.join(ROOT, 'license-server'))

  const offenders = []
  for (const f of files) {
    // ⚠️ 先剥注释：文件头往往写着"本文件不得 UPDATE credit_ledger"，
    //    直接扫全文会把那句**自我约束**判成违规（本项目在 ui-check.js 踩过）。
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    if (/UPDATE\s+credit_ledger/i.test(src)) offenders.push(`${path.relative(ROOT, f)}: UPDATE credit_ledger`)
    if (/DELETE\s+FROM\s+credit_ledger/i.test(src)) offenders.push(`${path.relative(ROOT, f)}: DELETE FROM credit_ledger`)
  }
  assert.deepStrictEqual(offenders, [],
    '台账是只增不改的账本（AGENTS.md 红线 2 的载体）：\n' + offenders.join('\n'))
})

test('后台：没有空 catch（AGENTS.md §2.8）', () => {
  const files = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) files.push(p)
    }
  })(path.join(ROOT, 'license-server/admin'))

  const offenders = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    const re = /catch\s*(?:\([^)]*\))?\s*\{/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      let depth = 1
      let i = m.index + m[0].length
      const start = i
      while (i < stripped.length && depth > 0) {
        const ch = stripped[i]
        if (ch === '{') depth++
        else if (ch === '}') depth--
        i++
      }
      if (stripped.slice(start, i - 1).trim() === '') {
        offenders.push(`${path.relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
  }
  assert.deepStrictEqual(offenders, [], '发现空 catch：\n' + offenders.join('\n'))
})

// ══════════════════════════════════════════════════════════
// 11. 账号状态 / 会话吊销 / 对账
// ══════════════════════════════════════════════════════════

test('后台：停用账号会同时吊销会话；启用时到期账号被拒', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId } = seedMerchant(srv.inst.db, { credits: 100 })
    const now = Date.now()
    srv.inst.db.prepare(`
      INSERT INTO device_session (account_id, device_id, token_hash, sign_key_hash, sign_key_plain,
                                  issued_at_ms, last_seen_ms, expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(accountId, 'dev-x', 'th-x', 'skh-x', 'sk-x', now, now, now + 86400000)

    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const missingReason = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/status`,
      { status: 'disabled' })
    assert.strictEqual(missingReason.status, 400)

    const disable = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/status`,
      { status: 'disabled', reason: '商家申请暂停' })
    assert.strictEqual(disable.status, 200)
    assert.strictEqual(disable.json.revoked_sessions, 1, '停用必须同时踢会话')
    const acct = srv.inst.db.prepare('SELECT status FROM account WHERE account_id = ?').get(accountId)
    assert.strictEqual(acct.status, 'disabled')
    const sess = srv.inst.db.prepare('SELECT revoked_at_ms, revoked_reason FROM device_session WHERE account_id = ?')
      .get(accountId)
    assert.ok(Number(sess.revoked_at_ms) > 0)
    assert.strictEqual(sess.revoked_reason, 'account_disabled')

    // 幂等：再停一次不报错也不重复踢
    const again = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/status`,
      { status: 'disabled', reason: '重复操作' })
    assert.strictEqual(again.status, 200)
    assert.strictEqual(again.json.changed, false)

    // 启用
    const enable = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/status`,
      { status: 'active', reason: '恢复服务' })
    assert.strictEqual(enable.status, 200)
    assert.strictEqual(enable.json.status, 'active')

    // 到期账号不能启用
    const expired = seedMerchant(srv.inst.db, { account: 'exp-acct', credits: 10 })
    srv.inst.db.prepare('UPDATE account SET plan_expires_ms = ? WHERE account_id = ?')
      .run(Date.now() - 86400000, expired.accountId)
    const badEnable = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/exp-acct/status`,
      { status: 'active', reason: '试图启用到期账号' })
    assert.strictEqual(badEnable.status, 400)
    assert.match(badEnable.json.message, /到期/)

    // expired 不能手工设置（它是推导值）
    const manualExpired = await adminPost(srv, cookie, `${ADMIN_PATH}/api/merchant/${MERCHANT}/status`,
      { status: 'expired', reason: 'x' })
    assert.strictEqual(manualExpired.status, 400)

    // 操作留痕
    const actions = srv.inst.db.prepare(
      "SELECT action FROM admin_action_log WHERE action LIKE 'account_%' ORDER BY id"
    ).all().map((r) => r.action)
    assert.deepStrictEqual(actions, ['account_disable', 'account_enable'])
  } finally {
    await srv.cleanup()
  }
})

test('后台：/session/revoke 支持单账号与全平台，并留痕', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const a = seedMerchant(srv.inst.db, { account: 'rev-a', credits: 10 })
    const b = seedMerchant(srv.inst.db, { account: 'rev-b', credits: 10 })
    const now = Date.now()
    const ins = srv.inst.db.prepare(`
      INSERT INTO device_session (account_id, device_id, token_hash, sign_key_hash, sign_key_plain,
                                  issued_at_ms, last_seen_ms, expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)
    `)
    ins.run(a.accountId, 'd1', 't1', 'h1', 'k1', now, now, now + 86400000)
    ins.run(a.accountId, 'd2', 't2', 'h2', 'k2', now, now, now + 86400000)
    ins.run(b.accountId, 'd3', 't3', 'h3', 'k3', now, now, now + 86400000)

    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    const one = await adminPost(srv, cookie, `${ADMIN_PATH}/api/session/revoke`,
      { account: 'rev-a', reason: '换机器' })
    assert.strictEqual(one.status, 200)
    assert.strictEqual(one.json.revoked_sessions, 2)
    assert.strictEqual(
      srv.inst.db.prepare("SELECT COUNT(*) AS c FROM device_session WHERE account_id = ? AND revoked_at_ms IS NULL")
        .get(b.accountId).c, 1, '不应影响其它账号'
    )

    const all = await adminPost(srv, cookie, `${ADMIN_PATH}/api/session/revoke`, { all: true })
    assert.strictEqual(all.status, 200)
    assert.strictEqual(all.json.revoked_sessions, 1)
    assert.match(all.json.note, /全体商家/)

    const noTarget = await adminPost(srv, cookie, `${ADMIN_PATH}/api/session/revoke`, {})
    assert.strictEqual(noTarget.status, 400)

    const actions = srv.inst.db.prepare(
      "SELECT action FROM admin_action_log WHERE action LIKE 'session_%' ORDER BY id"
    ).all().map((r) => r.action)
    assert.deepStrictEqual(actions, ['session_revoke', 'session_revoke_all'])
  } finally {
    await srv.cleanup()
  }
})

test('后台：/reconcile 把 send_log 与 credit_ledger 的不一致**大声**报出来', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId, now } = seedMerchant(srv.inst.db, { credits: 1000 })
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)

    // 一致时
    insertSend(srv.inst.db, accountId, {
      sendId: 'r1', billingStatus: 'billed', chargedMilli: 1000, sentAtMs: now - 5000,
    })
    srv.inst.db.prepare(`
      INSERT INTO credit_ledger (account_id, kind, delta_milli, balance_after_milli, ref_send_id, operator, note, settled_at_ms)
      VALUES (?, 'consume', -1000, ?, 'r1', 'system', 'send r1 comment', ?)
    `).run(accountId, 999000, now - 5000)

    const good = await adminGet(srv, cookie, `${ADMIN_PATH}/api/reconcile?days=7`)
    assert.strictEqual(good.status, 200)
    assert.strictEqual(good.json.global.match, true)
    assert.strictEqual(good.json.accounts.mismatched, 0)
    assert.strictEqual(good.json.global.detail_count, 1)
    assert.strictEqual(good.json.global.ledger_count, 1)

    // 制造不一致：再插一条已计费明细但不写台账
    insertSend(srv.inst.db, accountId, {
      sendId: 'r2', billingStatus: 'billed', chargedMilli: 1000, sentAtMs: now - 4000,
    })
    const bad = await adminGet(srv, cookie, `${ADMIN_PATH}/api/reconcile?days=7`)
    assert.strictEqual(bad.json.global.match, false, '不一致必须被标出来')
    // ⚠️ 差值的符号必须写对：台账里**少**了一条，
    //    所以 delta = 台账 − 明细 = 1 − 2 = −1（"少扣费"的方向）。
    //    把符号写成 +1 会让运维朝"多扣了"的方向排查，白费一整轮。
    assert.strictEqual(bad.json.global.delta_count, -1, '台账比明细少 1 条 → 差值必须是 −1')
    assert.strictEqual(bad.json.global.delta_milli, -1000, '台账比明细少 1000 毫单位')
    assert.strictEqual(bad.json.global.detail_count, 2)
    assert.strictEqual(bad.json.global.ledger_count, 1)
    assert.strictEqual(bad.json.accounts.mismatched, 1)
    assert.strictEqual(bad.json.mismatches[0].account, MERCHANT)

    // 总览里也要显眼
    const ov = await adminGet(srv, cookie, `${ADMIN_PATH}/api/overview?days=7`)
    assert.strictEqual(ov.json.reconcile.mismatched_accounts, 1)
    assert.strictEqual(ov.json.reconcile.mismatches[0].account, MERCHANT)
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 12. 客户端契约回归：后台开着也不能影响 /api/v1/*
// ══════════════════════════════════════════════════════════

test('回归：后台启用时 /api/v1/auth/login 与心跳/上报全链路仍然可用', async () => {
  const srv = await makeServer()
  try {
    await seedAdmin(srv)
    const { accountId } = seedMerchant(srv.inst.db, { credits: 500 })
    assert.ok(accountId)

    // ⚠️ 用**真实的签名客户端**（test/integration/helpers.js 的 Client），
    //    不是裸 HTTP：客户端契约的价值就在签名字节一致。
    const c = new Client(
      { address: '127.0.0.1', port: srv.port },
      { account: MERCHANT, password: MERCHANT_PASS, deviceId: 'reg-dev-1', instanceId: 'reg-inst-1' }
    )
    const login = await c.login()
    assert.strictEqual(login.status, 200, '后台启用后客户端登录必须仍然成功')
    assert.strictEqual(login.body.ok, true)
    assert.strictEqual(login.body.policy.account_tier, 'stable')
    assert.strictEqual(login.body.policy.limits.comment.daily_max, 30)
    assert.ok(login.body.token, '登录必须下发 token')

    // 心跳（带签名 + 防重放 + 策略 ack）
    const hb = await c.post('/api/v1/heartbeat', {
      instance_id: 'reg-inst-1',
      online_seconds: 60,
      client_time_ms: Date.now(),
      applied_policy_version: login.body.policy.policy_version,
      applied_limits: { comment: { daily_max: 10, min_interval_ms: 120000, content_similarity_max: 0.8 } },
    })
    assert.strictEqual(hb.status, 200)
    assert.strictEqual(hb.body.ok, true)
    assert.strictEqual(hb.body.daily_quota.comment.max, 30)

    // 计费依据接口
    const rep = await c.post('/api/v1/audit/sends', { sends: [makeSend(), makeSend()] })
    assert.strictEqual(rep.status, 200)
    assert.strictEqual(rep.body.settlement.billed_count, 2, '两条平台确认成功必须都计费')

    // 健康检查与就绪探针不受影响
    const hz = await rawRequest({ address: '127.0.0.1', port: srv.port }, 'GET', '/healthz')
    assert.strictEqual(hz.status, 200)
    assert.strictEqual(hz.body.ok, true)

    // 后台确实在同一进程里活着（否则上面的"不受影响"没有意义）
    const { cookie } = await adminLogin(srv, ADMIN_USER, ADMIN_PASS)
    const ov = await adminGet(srv, cookie, `${ADMIN_PATH}/api/overview?days=1`)
    assert.strictEqual(ov.status, 200)
    assert.strictEqual(ov.json.range.sent_confirmed, 2, '后台应能看到刚才上报的两条')

    // 关掉服务后再 close 一次必须不抛（幂等 teardown）
    srv.inst.close()
    srv.inst.close()
  } finally {
    await srv.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 13. 启动日志
// ══════════════════════════════════════════════════════════

test('后台：启动时记录挂载路径、白名单状态，并对可猜路径告警', () => {
  const { logAdminStartup } = require('../../license-server/server')
  const lines = []
  const log = {
    info: (e, f) => lines.push({ level: 'info', event: e, fields: f }),
    warn: (e, f) => lines.push({ level: 'warn', event: e, fields: f }),
  }

  const guessy = logAdminStartup({
    adminPath: '/admin', adminIpAllow: ['127.0.0.1/32'], adminSessionTtlHours: 12,
    adminCookieSecure: true, trustProxy: false,
  }, log)
  assert.strictEqual(guessy.guessable, true, '/admin 必须被判为可猜')
  assert.strictEqual(guessy.ip_allow_active, false)
  assert.ok(guessy.warnings.some((w) => w.includes('容易被猜到')))
  const mounted = lines.find((l) => l.event === 'admin_mounted')
  assert.ok(mounted, '必须记录一条 admin_mounted')
  assert.strictEqual(mounted.fields.path, '/admin')
  assert.strictEqual(mounted.fields.guessable, true)
  assert.deepStrictEqual(mounted.fields.ip_allow, ['127.0.0.1/32'])
  assert.strictEqual(mounted.fields.ip_allow_active, false)

  const good = logAdminStartup({
    adminPath: '/admin-7f3c91', adminIpAllow: ['127.0.0.1/32', '203.0.113.7/32'],
    adminSessionTtlHours: 12, adminCookieSecure: true, trustProxy: true,
  }, log)
  assert.strictEqual(good.guessable, false, '随机路径不应被告警')
  assert.strictEqual(good.ip_allow_active, true)
  assert.deepStrictEqual(good.warnings, [])

  // 关掉 Secure 必须告警（那是把会话暴露在明文链路上）
  const insecure = logAdminStartup({
    adminPath: '/admin-7f3c91', adminIpAllow: ['203.0.113.7/32'],
    adminSessionTtlHours: 12, adminCookieSecure: false, trustProxy: false,
  }, log)
  assert.ok(insecure.warnings.some((w) => w.includes('ADMIN_COOKIE_SECURE')))
})

// ── 小工具 ─────────────────────────────────────────────────

async function timed(fn) {
  const t0 = process.hrtime.bigint()
  await fn()
  const t1 = process.hrtime.bigint()
  return Number(t1 - t0) / 1e6
}
