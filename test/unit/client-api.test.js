'use strict'

// test/unit/client-api.test.js
// 本地控制台 API 测试 —— **AGENTS.md §2.13（旧代码 D-6）的回归防线**。
//
// ⚠️ 本文件里最重要的几条，都是"删掉那行代码就再也测不出来"的：
//   ① 非白名单 `Origin` 必须被**拒绝**（不是"不回 CORS 头"）——
//      简单请求（POST + text/plain）本来就不触发预检，浏览器会把请求
//      真的发出去，副作用已经发生。所以必须显式 403。
//   ② `Host` 不是回环必须被拒绝 —— 这条挡的是 DNS rebinding，
//      而 rebinding 恰好能绕过 Origin 检查。
//   ③ `POST /api/emergency-stop` 在**未登录、无策略**时必须可用。
//      它是商家"一键停机"的唯一保证；挂在 license 状态上等于在最需要它
//      的时候把它关掉。
//   ④ 越权调高限额 → 响应里带拒绝原因 **且** 审计里有一条
//      `applied:false` + `rejectCode`。那条审计是红线 3 要求的举证材料。
//   ⑤ 密码绝不出现在实例目录的任何字节里；令牌与 sign_key 绝不出现在
//      `/api/state` 的响应里。
//
// ⚠️ 刻意用**真实的** Store / Guard / Queue / CircuitBreaker / AuditLog：
//    它们是红线命题（单写者、只调低、审计留痕）的载体，用假件就测不出
//    "护栏真的拒绝了"这类事实。只把 license 层替换成假件——
//    真实 license 需要跑起授权中心，那属于 L4 集成测试的范围
//    （见 test/integration/client-license.test.js）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')

const { Store } = require('../../client/host/store')
const { Queue } = require('../../client/host/queue')
const { Guard } = require('../../client/safety/guard')
const { CircuitBreaker } = require('../../client/safety/circuit')
const { AuditLog } = require('../../client/safety/audit')
const A = require('../../client/host/api')
const { buildPolicy } = require('../../license-server/domain/policy')

const ROOT = path.resolve(__dirname, '..', '..')
const NOW = 1758096000000

// ══════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════

function make_config(dir, extra) {
  return {
    uiHost: '127.0.0.1',
    uiPort: 0,
    instanceId: 'test-api',
    tmpSuffix: '.tmp',
    workspace: dir,
    instanceDir: dir,
    ...(extra || {}),
  }
}

/**
 * 假 license 层。
 *
 * ⚠️ 只实现 api.js 真正调用到的成员。**故意不做"万能 Proxy"**：
 *    Proxy 会让"api.js 调了一个不存在的方法"这件事静默通过，
 *    而那正是需要被测出来的缺陷。
 */
function fake_license(opts = {}) {
  const state = {
    logged_in: true,
    account_id: 7,
    device_id: 'd'.repeat(32),
    install_id: 'install-test',
    session_id: 'session-test',
    token_expires_at_ms: NOW + 86400000,
    clock_skew_ms: 0,
    policy_version: opts.policy_version === undefined ? 9 : opts.policy_version,
    policy_acked_version: 9,
    account_tier: 'stable',
    billing_state: 'active',
    last_heartbeat_ms: NOW,
    seq: { heartbeat: 3 },
    // ⚠️ 这一项是 `license-state.redacted()` 的真实形态：它已经是摘要，
    //    但**绝不允许**出现 `token` / `sign_key` 字段。
    key: '***abcd1234',
    quotaNotice: opts.quota_notice === undefined ? default_quota_notice() : opts.quota_notice,
    credit: opts.credit === undefined
      ? { balance_milli: 12600000, credit_per_reply_milli: 1000 } : opts.credit,
    policy: opts.policy === undefined ? null : opts.policy,
    dailyQuota: opts.daily_quota === undefined ? null : opts.daily_quota,
  }

  const auth = {
    credentialInvalid: null,
    login_calls: [],
    async login(account, password) {
      // ⚠️ 记录调用**参数个数**而不是密码本身——测试自己也不该持有密码。
      this.login_calls.push({ account, password_len: String(password).length })
      if (opts.login_throws) throw opts.login_throws
      return {
        body: { ok: true },
        policy: opts.login_policy || null,
        quotaNotice: state.quotaNotice,
        warnings: opts.login_warnings || [],
      }
    },
    async logout() {
      return { ok: true, revoked_session_count: 1 }
    },
  }

  const reporter = {
    pending_count_value: opts.pending_count === undefined ? 3 : opts.pending_count,
    report_sends_result: opts.report_sends_result === undefined ? null : opts.report_sends_result,
    report_sends_calls: 0,
    report_usage_calls: 0,
    pendingCount() { return this.pending_count_value },
    async reportSends() {
      this.report_sends_calls += 1
      return this.report_sends_result
    },
    async reportUsage() {
      this.report_usage_calls += 1
      return { ok: true }
    },
  }

  return {
    state: { ...state, redacted: () => ({ ...state }), isLoggedIn: Boolean(state.logged_in) },
    auth,
    reporter,
    raw_state: state,
  }
}

function default_quota_notice() {
  return {
    headline: '套餐是预付额度，不等于无限发送',
    detail: '平台安全上限由服务端下发且客户端无法调高：稳定期每日最多 70 条。',
    replies_affordable: 12600,
    daily_cap_total: 70,
    tier: 'stable',
    account_day_index: 30,
    sending_enabled: true,
    credits: 12600,
    valid_days: 180,
    estimated_days_at_cap: 180,
  }
}

/** 一个完整的测试实例：真实 store/guard/queue/circuit/audit + 真实 HTTP API。 */
async function make_api(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-'))
  const store = new Store({ dir })
  let t = opts.now_ms === undefined ? NOW : opts.now_ms
  const now = () => t

  const guard = new Guard({ store, now })
  const queue = new Queue({ store, now })
  const circuit = new CircuitBreaker({ store, now })
  // `audit: false` → 刻意**不注入**审计，用于验证"未接入时如实 501"。
  const audit = opts.audit === false ? null : new AuditLog({ store, now })

  let policy = null
  if (opts.with_policy !== false) {
    policy = buildPolicy({ accountId: 7, accountDayIndex: 30, policyVersion: 9, nowMs: t })
    guard.applyPolicy(policy)
    circuit.applyPolicy(policy)
  }

  const license = opts.license === null ? null : fake_license({
    policy, ...(opts.license || {}),
  })

  const api = A.create_local_api({
    config: make_config(dir, opts.config),
    store,
    guard,
    queue,
    circuit,
    audit,
    license_state: license ? license.state : null,
    license_auth: license ? license.auth : null,
    license_reporter: license ? license.reporter : null,
    port: 0,
    now,
    // ⚠️ 测试里不写 ui-token.txt：多个 API 实例共用同一个临时目录时，
    //    后写的会覆盖先写的（store 的原子写不带独占语义）。
    //    专门有另一个用例（"令牌写入实例目录"）单独验证它。
    write_token: opts.write_token === true,
    logger: null,
  })

  const info = await api.listen()

  return {
    dir, store, guard, queue, circuit, audit, license, api, info, policy,
    port: info.port,
    host: `127.0.0.1:${info.port}`,
    token: info.token,
    at: () => t,
    set_time: (v) => { t = v },
    async cleanup() {
      await api.close()
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {
        // ⚠️ 清理失败不能吞：临时目录残留会让下一次测试读到脏数据。
        //    但也不该让测试失败（Windows 上文件句柄释放有延迟）。
        process.stderr.write(`清理临时目录失败（可忽略，但需留痕）：${e.message}\n`)
      }
    },
  }
}

/**
 * 用 `node:http` 直接发请求。
 *
 * ⚠️ **不能用 `fetch`**：Node 的 fetch 会把自定义 `Host` 头覆盖成连接地址
 *    （WHATWG fetch 的 forbidden header 规则），于是"Host 不是回环 → 拒绝"
 *    这条用例永远测不出来——它会静默变成一条永远通过的假测试。
 */
function request(port, method, url_path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: url_path, headers: headers || {},
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let json = null
        try {
          json = raw ? JSON.parse(raw) : null
        } catch (e) {
          // ⚠️ 不吞异常：响应不是 JSON 本身就是被测的缺陷之一
          //    （"接口返回空数据假装成功"）。把原文带进断言消息。
          json = { __unparsable: raw.slice(0, 300), __error: e.message }
        }
        resolve({ status: res.statusCode, headers: res.headers, text: raw, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

/**
 * 带令牌 + 正确 Host 的请求（绝大多数用例的默认形态）。
 *
 * ⚠️ `token: null` 表示"**不带**令牌"，而不是"带一个 null 令牌"。
 *    Node 的 http 客户端对 `'X-UI-Token': undefined` 会直接抛
 *    ERR_HTTP_INVALID_HEADER_VALUE，那会把"缺令牌"这条用例变成一个
 *    测试自身的错误，而不是被测行为。
 */
function api_request(ctx, method, url_path, opts = {}) {
  const headers = {}
  const host = opts.host === undefined ? ctx.host : opts.host
  if (host) headers.Host = host
  const token = opts.token === undefined ? ctx.token : opts.token
  if (token !== null && token !== undefined && token !== '') headers['X-UI-Token'] = token
  Object.assign(headers, opts.headers || {})
  // 清掉显式传成 null/undefined 的头（用于"覆盖掉默认头"的用例）
  for (const k of Object.keys(headers)) {
    if (headers[k] === null || headers[k] === undefined) delete headers[k]
  }
  const body = opts.body === undefined
    ? undefined
    : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  if (body !== undefined && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body)
  return request(ctx.port, method, url_path, headers, body)
}

/** 递归读取一个目录下所有文件的文本（用于"密码有没有落盘"的全局扫描）。 */
function read_dir_recursive(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...read_dir_recursive(p))
    else out.push({ path: p, text: fs.readFileSync(p, 'utf8') })
  }
  return out
}

// ══════════════════════════════════════════════════════════
// 1. 健康检查与令牌
// ══════════════════════════════════════════════════════════

test('api：/healthz 不需要令牌（启动器靠它探活），且不泄漏任何凭据', async () => {
  const ctx = await make_api()
  try {
    const r = await api_request(ctx, 'GET', '/healthz', { token: null })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.ok, true)
    assert.strictEqual(r.json.instance_id, 'test-api')
    assert.ok(Number.isFinite(r.json.uptime_ms), 'uptime_ms 必须是数字')
    assert.ok(typeof r.json.version === 'string' && r.json.version.length > 0)
    // ⚠️ 健康检查是**不需要令牌**的接口，所以它绝不能带任何凭据或统计。
    assert.ok(!r.text.includes(ctx.token), '健康检查不得回显令牌')
    assert.strictEqual(r.json.token, undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('api：/api/state 不带令牌 → 401 且是结构化信封（不是空 200）', async () => {
  const ctx = await make_api()
  try {
    const r = await api_request(ctx, 'GET', '/api/state', { token: null })
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.json.ok, false)
    assert.strictEqual(r.json.code, 'AUTH_TOKEN_INVALID')
    assert.ok(r.json.message && r.json.message.length > 0, '必须带面向人的说明')
    assert.notDeepStrictEqual(r.json, {}, '绝不能是 200 + {}（D-14 的形态）')
  } finally {
    await ctx.cleanup()
  }
})

test('api：令牌三种携带方式都可用（Bearer / X-UI-Token / ?token=）', async () => {
  const ctx = await make_api()
  try {
    const via_header = await api_request(ctx, 'GET', '/api/state', {
      headers: { Authorization: `Bearer ${ctx.token}` }, token: null,
    })
    assert.strictEqual(via_header.status, 200)

    const via_x = await api_request(ctx, 'GET', '/api/state', { token: ctx.token })
    assert.strictEqual(via_x.status, 200)

    // ⚠️ query 形态是**首屏唯一可行**的传递方式：浏览器不会在地址栏
    //    导航上带自定义头。
    const via_query = await api_request(ctx, 'GET', `/api/state?token=${ctx.token}`, { token: null })
    assert.strictEqual(via_query.status, 200)

    const via_bad_bearer = await api_request(ctx, 'GET', '/api/state', {
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64) }, token: null,
    })
    assert.strictEqual(via_bad_bearer.status, 401)
  } finally {
    await ctx.cleanup()
  }
})

test('api：令牌比较走 timingSafeEqual —— 同长错值/不同长值都失败且不抛错', async () => {
  const ctx = await make_api()
  try {
    // 令牌必须是 32 字节 → 64 个 hex 字符
    assert.strictEqual(ctx.token.length, A.TOKEN_BYTES * 2)

    // ① 同长度的错误令牌：会走到 timingSafeEqual，返回 false
    const same_len = 'f'.repeat(64)
    assert.strictEqual(same_len.length, ctx.token.length)
    const r1 = await api_request(ctx, 'GET', '/api/state', { token: same_len })
    assert.strictEqual(r1.status, 401)
    assert.strictEqual(r1.json.code, 'AUTH_TOKEN_INVALID')

    // ② 不同长度的令牌：timingSafeEqual 会**抛错**（长度不等），
    //    所以实现必须先比长度直接返回 false。这里断言的是"没有抛错"。
    const r2 = await api_request(ctx, 'GET', '/api/state', { token: 'abc' })
    assert.strictEqual(r2.status, 401)
    assert.strictEqual(r2.json.code, 'AUTH_TOKEN_INVALID')

    const r3 = await api_request(ctx, 'GET', '/api/state', { token: 'f'.repeat(200) })
    assert.strictEqual(r3.status, 401)

    // ③ 纯函数层面：证明它确实用的是定长比较，且边界正确
    assert.strictEqual(A.token_matches('a'.repeat(64), 'a'.repeat(64)), true)
    assert.strictEqual(A.token_matches('a'.repeat(64), 'b'.repeat(64)), false)
    assert.strictEqual(A.token_matches('a'.repeat(64), 'a'.repeat(63)), false)
    assert.strictEqual(A.token_matches('a'.repeat(64), 'a'.repeat(65)), false)
    assert.strictEqual(A.token_matches('', ''), false)
    assert.strictEqual(A.token_matches(null, 'x'), false)

    // ④ 服务端在比较前**必须先比长度**，否则 timingSafeEqual 会抛。
    //    用一条不同长度的值直接调，断言不抛错。
    assert.doesNotThrow(() => A.token_matches(ctx.token, 'x'))
  } finally {
    await ctx.cleanup()
  }
})

test('api：令牌写入实例目录（启动器据此拼 ?token=），且经 store 原子写', async () => {
  const ctx = await make_api({ write_token: true })
  try {
    const file = path.join(ctx.dir, A.TOKEN_FILE)
    assert.ok(fs.existsSync(file), '令牌文件应存在：' + file)
    const content = fs.readFileSync(file, 'utf8').trim()
    assert.strictEqual(content, ctx.token)
    assert.strictEqual(content.length, 64)
    // ⚠️ 目录里不得残留临时文件（`.tmp-<pid>` 说明 rename 没走完）
    const leftovers = fs.readdirSync(ctx.dir).filter((n) => n.includes('.tmp-'))
    assert.deepStrictEqual(leftovers, [], '不应残留原子写的临时文件')
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 2. 跨站调用防护（Origin 白名单）与 DNS rebinding 防护（Host）
// ══════════════════════════════════════════════════════════

test('api：非白名单 Origin 被拒绝 —— 这是"任意网页可代商家发评论"的跨站防护', async () => {
  const ctx = await make_api()
  try {
    // ① 回环同源：放行，且**回显** Allow-Origin
    const good = await api_request(ctx, 'GET', '/api/state', {
      headers: { Origin: `http://127.0.0.1:${ctx.port}` },
    })
    assert.strictEqual(good.status, 200)
    assert.strictEqual(good.headers['access-control-allow-origin'], `http://127.0.0.1:${ctx.port}`)

    // ② 攻击者网页：**必须直接拒绝**。
    //    ⚠️ 只"不回 CORS 头"是不够的：简单请求本来就不触发预检，
    //    浏览器会把请求真的发出去，副作用（例如急停、改限额）已经发生，
    //    只是响应读不到而已。
    const evil = await api_request(ctx, 'GET', '/api/state', {
      headers: { Origin: 'https://evil.example' },
    })
    assert.strictEqual(evil.status, 403, '非白名单 Origin 必须 403')
    assert.strictEqual(evil.json.code, 'AUTH_FORBIDDEN')
    assert.strictEqual(evil.headers['access-control-allow-origin'], undefined,
      '被拒的来源绝不能拿到 Allow-Origin')

    // ③ 带 token 也照样拒（token 只在页面内存/sessionStorage 里，
    //    但纵深防御不能只依赖它）
    const evil_with_token = await api_request(ctx, 'POST', '/api/emergency-stop', {
      headers: { Origin: 'http://attacker.example' },
      body: { on: true },
    })
    assert.strictEqual(evil_with_token.status, 403)
    assert.strictEqual(ctx.guard.emergencyStop, false, '被拒的跨站请求不得产生任何副作用')

    // ④ 回环地址但端口不在白名单 → 拒
    const wrong_port = await api_request(ctx, 'GET', '/api/state', {
      headers: { Origin: 'http://127.0.0.1:1' },
    })
    assert.strictEqual(wrong_port.status, 403)
    assert.strictEqual(wrong_port.json.detail.reason, 'origin_port_not_whitelisted')

    // ⑤ `Origin: null`（沙箱 iframe / data: URL）→ 拒
    const null_origin = await api_request(ctx, 'GET', '/api/state', {
      headers: { Origin: 'null' },
    })
    assert.strictEqual(null_origin.status, 403)
    assert.strictEqual(null_origin.json.detail.reason, 'origin_null')

    // ⑥ 无 Origin（curl / 启动器探活）→ 放行（真正的鉴权是令牌）
    const no_origin = await api_request(ctx, 'GET', '/api/state')
    assert.strictEqual(no_origin.status, 200)
    assert.strictEqual(no_origin.headers['access-control-allow-origin'], undefined,
      '没有 Origin 就绝不回 Allow-Origin（避免通配语义）')

    // ⑦ localhost 形态也认
    const localhost = await api_request(ctx, 'GET', '/api/state', {
      headers: { Origin: `http://localhost:${ctx.port}` },
    })
    assert.strictEqual(localhost.status, 200)
  } finally {
    await ctx.cleanup()
  }
})

test('api：预检 OPTIONS 被显式应答，且只对白名单来源回 Allow-Origin', async () => {
  const ctx = await make_api()
  try {
    // ⚠️ 预检**不带**令牌（浏览器不会在预检里带自定义头），
    //    所以 `token: null` 是这里的正确形态——它也必须能通过。
    const pre = await api_request(ctx, 'OPTIONS', '/api/limits', {
      token: null,
      headers: {
        Origin: `http://127.0.0.1:${ctx.port}`,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-ui-token',
      },
    })
    assert.strictEqual(pre.status, 204)
    assert.strictEqual(pre.headers['access-control-allow-origin'], `http://127.0.0.1:${ctx.port}`)
    assert.ok(String(pre.headers['access-control-allow-methods']).includes('POST'))
    assert.ok(String(pre.headers['access-control-allow-headers']).toLowerCase().includes('x-ui-token'))
    assert.notStrictEqual(pre.headers['access-control-allow-origin'], '*')

    // 预检同样必须先过 Origin 白名单
    const bad_pre = await api_request(ctx, 'OPTIONS', '/api/limits', {
      token: null, headers: { Origin: 'https://evil.example' },
    })
    assert.strictEqual(bad_pre.status, 403)
    assert.strictEqual(bad_pre.headers['access-control-allow-origin'], undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('api：Host 头不是回环 → 拒绝（DNS rebinding 绕过 Origin 检查的那条路）', async () => {
  const ctx = await make_api()
  try {
    // ① 正常回环 Host：放行
    const ok = await api_request(ctx, 'GET', '/api/state', { host: `127.0.0.1:${ctx.port}` })
    assert.strictEqual(ok.status, 200)

    // ② 攻击者域名解析到 127.0.0.1：Origin 是攻击者域名（会被 Origin 检查挡），
    //    但如果攻击者把 Origin 也伪造成回环，Host 就是最后一道门。
    //    ⚠️ 这里刻意**不带 Origin**，模拟"只靠 Host 判断"的最坏情况。
    const rebind = await api_request(ctx, 'GET', '/api/state', { host: `evil.example:${ctx.port}` })
    assert.strictEqual(rebind.status, 403, 'Host 不是回环必须 403')
    assert.strictEqual(rebind.json.code, 'AUTH_FORBIDDEN')
    assert.strictEqual(rebind.json.detail.reason, 'host_not_loopback')

    // ③ 回环 IP 但端口不符 → 拒（只判主机名会漏掉这一种）
    const wrong_port = await api_request(ctx, 'GET', '/api/state', { host: '127.0.0.1:9999' })
    assert.strictEqual(wrong_port.status, 403)
    assert.strictEqual(wrong_port.json.detail.reason, 'host_port_mismatch')

    // ④ localhost / [::1] 都算回环
    const lh = await api_request(ctx, 'GET', '/api/state', { host: `localhost:${ctx.port}` })
    assert.strictEqual(lh.status, 200)
    const v6 = await api_request(ctx, 'GET', '/api/state', { host: `[::1]:${ctx.port}` })
    assert.strictEqual(v6.status, 200)

    // ⑤ 纯函数边界
    assert.strictEqual(A.check_host_header('127.0.0.1:8090', 8090).ok, true)
    assert.strictEqual(A.check_host_header('localhost', 8090).ok, true)
    assert.strictEqual(A.check_host_header('[::1]:8090', 8090).ok, true)
    assert.strictEqual(A.check_host_header('127.0.0.1.evil.example:8090', 8090).ok, false)
    assert.strictEqual(A.check_host_header('0.0.0.0:8090', 8090).ok, false)
    assert.strictEqual(A.check_host_header('', 8090).ok, false)
    assert.strictEqual(A.check_host_header(undefined, 8090).ok, false)
    assert.strictEqual(A.check_host_header('127.0.0.1:[', 8090).ok, false)
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 3. 绑定地址 / 静态资源 / 未知路由
// ══════════════════════════════════════════════════════════

test('api：只绑回环，并在监听后回读地址做断言（配置校验 != 实际绑定）', async () => {
  const ctx = await make_api()
  try {
    // ① 默认 host 来自 config.uiHost，而 config 的默认值就是回环
    const { DEFAULTS } = require('../../client/config')
    assert.strictEqual(DEFAULTS.uiHost, '127.0.0.1')
    assert.strictEqual(A.is_loopback_hostname(DEFAULTS.uiHost), true)

    // ② 实际绑定的地址必须是回环
    const addr = ctx.api.server.address()
    assert.ok(A.is_loopback_hostname(A.normalize_bound_host(addr.address)),
      `实际绑定地址不是回环：${addr.address}`)
    assert.strictEqual(addr.address, '127.0.0.1')
    assert.strictEqual(ctx.api.listening, true)
    assert.ok(ctx.port > 0, 'port=0 时应拿到内核分配的真实端口')
  } finally {
    await ctx.cleanup()
  }
})

test('api：拒绝绑到非回环地址（并在失败后不留监听）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-bind-'))
  const store = new Store({ dir })
  const guard = new Guard({ store, now: () => NOW })
  const api = A.create_local_api({
    config: make_config(dir),
    store, guard,
    // ⚠️ 显式传入非回环 host（模拟有人绕过 config 校验改代码）
    host: '0.0.0.0',
    port: 0,
    write_token: false,
  })
  try {
    await assert.rejects(() => api.listen(), (e) => {
      assert.ok(/拒绝|回环/.test(e.message), `错误信息应说明拒绝原因，收到：${e.message}`)
      return true
    })
    assert.strictEqual(api.listening, false, '失败后不得处于监听状态')
    assert.strictEqual(api.server.address(), null, '失败后必须真的关掉监听')
  } finally {
    await api.close()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('api：GET / 提供 UI 且不含任何令牌；静态资源不带令牌也可取（首屏必须能加载）', async () => {
  const ctx = await make_api()
  try {
    const index = await api_request(ctx, 'GET', '/', { token: null })
    assert.strictEqual(index.status, 200)
    assert.match(index.headers['content-type'], /text\/html/)
    assert.ok(index.text.includes('/app.js'), '首页必须引用 /app.js')
    assert.ok(index.text.includes('/app.css'), '首页必须引用 /app.css')
    assert.strictEqual(index.text.includes(ctx.token), false, '首页源码里不能嵌令牌')
    assert.match(index.headers['cache-control'] || '', /no-store/)

    const css = await api_request(ctx, 'GET', '/app.css', { token: null })
    assert.strictEqual(css.status, 200)
    assert.match(css.headers['content-type'], /text\/css/)
    assert.ok(css.text.includes(':root'), 'CSS 必须有 :root 设计 token')

    const js = await api_request(ctx, 'GET', '/app.js', { token: null })
    assert.strictEqual(js.status, 200)
    assert.match(js.headers['content-type'], /javascript/)

    // 目录穿越必须取不到（路径来自白名单，不拼接用户输入）
    const traversal = await api_request(ctx, 'GET', '/../client/config.js', { token: null })
    assert.ok(traversal.status === 501 || traversal.status === 400,
      `目录穿越必须被拒，实际 ${traversal.status}`)
    assert.notStrictEqual(traversal.status, 200)
  } finally {
    await ctx.cleanup()
  }
})

test('api：未知路由返回 501 结构化信封，绝不是 200 + 空对象（D-14）', async () => {
  const ctx = await make_api()
  try {
    const unknown = await api_request(ctx, 'GET', '/api/definitely-not-here')
    assert.strictEqual(unknown.status, 501)
    assert.strictEqual(unknown.json.ok, false)
    assert.strictEqual(unknown.json.code, 'NOT_IMPLEMENTED')
    assert.ok(unknown.json.message.length > 0)
    assert.ok(unknown.json.detail && unknown.json.detail.path === '/api/definitely-not-here')

    // ② 非 /api 路径同样不能静默 200
    const unknown_root = await api_request(ctx, 'GET', '/nope.txt', { token: null })
    assert.strictEqual(unknown_root.status, 501)
    assert.strictEqual(unknown_root.json.ok, false)

    // ③ 已实现路径用错方法：也走 501 并说明是方法/路径的组合
    const wrong_method = await api_request(ctx, 'DELETE', '/api/state')
    assert.strictEqual(wrong_method.status, 501)
    assert.strictEqual(wrong_method.json.detail.method, 'DELETE')

    // ④ 兑换接口刻意未实现，必须**说明原因**而不是假装成功
    const redeem = await api_request(ctx, 'POST', '/api/redeem', { body: { code: 'x' } })
    assert.strictEqual(redeem.status, 501)
    assert.strictEqual(redeem.json.code, 'NOT_IMPLEMENTED')
    assert.match(redeem.json.message, /兑换/)
  } finally {
    await ctx.cleanup()
  }
})

test('api：请求体超过上限 → 结构化 413，不是崩溃也不是静默截断', async () => {
  const ctx = await make_api()
  try {
    const huge = JSON.stringify({ padding: 'x'.repeat(A.MAX_BODY_BYTES + 4096) })
    const r = await api_request(ctx, 'POST', '/api/limits', { body: huge })
    assert.strictEqual(r.status, 413)
    assert.strictEqual(r.json.ok, false)
    assert.strictEqual(r.json.code, 'REPORT_TOO_LARGE')
    assert.strictEqual(r.json.detail.limit_bytes, A.MAX_BODY_BYTES)
    assert.ok(r.json.detail.received_bytes > A.MAX_BODY_BYTES)

    // ⚠️ 服务必须仍然活着（不能因为一个超大请求就崩掉）
    const after = await api_request(ctx, 'GET', '/api/state')
    assert.strictEqual(after.status, 200)

    // 边界：刚好不超限的体应该被正常处理（这里是 400 而不是 413）
    const ok_size = JSON.stringify({ source_type: 'comment', field: 'daily_max', value: 1 })
    const ok = await api_request(ctx, 'POST', '/api/limits', { body: ok_size })
    assert.strictEqual(ok.status, 200)

    // 非法 JSON → 400 结构化
    const bad = await api_request(ctx, 'POST', '/api/limits', { body: '{not json' })
    assert.strictEqual(bad.status, 400)
    assert.strictEqual(bad.json.code, 'REPORT_INVALID')
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 4. 急停（红线：不受 license 状态门控）
// ══════════════════════════════════════════════════════════

test('api：POST /api/emergency-stop 在**未登录、无策略**时依然生效（红线要求）', async () => {
  // ⚠️ license=null 且 with_policy=false 是最坏情况：没有策略、没有会话、
  //    没有审计、没有调度器。急停**必须**照样成功。
  const ctx = await make_api({ license: null, with_policy: false })
  try {
    assert.strictEqual(ctx.guard.policy, null, '前置条件：本轮确实没有策略')

    const on = await api_request(ctx, 'POST', '/api/emergency-stop', {
      body: { on: true, reason: '测试急停' },
    })
    assert.strictEqual(on.status, 200, '急停不能因为未登录而失败')
    assert.strictEqual(on.json.ok, true)
    assert.strictEqual(on.json.on, true)
    assert.strictEqual(ctx.guard.emergencyStop, true)

    // ⚠️ 急停必须落盘（重启后依然生效），而不是只在内存里
    const persisted = ctx.store.readJson('runtime-state.json', {})
    assert.strictEqual(persisted.emergencyStop, true, '急停状态必须落盘')

    // 护栏的 canSend 在任何来源上都应拒绝
    for (const src of ['comment', 'live_danmaku', 'dm']) {
      const gate = ctx.guard.canSend({ sourceType: src, atMs: ctx.at() })
      assert.strictEqual(gate.allow, false)
    }

    // 解除
    const off = await api_request(ctx, 'POST', '/api/emergency-stop', { body: { on: false } })
    assert.strictEqual(off.status, 200)
    assert.strictEqual(off.json.on, false)
    assert.strictEqual(ctx.guard.emergencyStop, false)

    // 参数校验：on 必须是布尔
    const bad = await api_request(ctx, 'POST', '/api/emergency-stop', { body: { on: 'yes' } })
    assert.strictEqual(bad.status, 400)
    assert.strictEqual(bad.json.code, 'REPORT_INVALID')
  } finally {
    await ctx.cleanup()
  }
})

test('api：急停写审计（谁按的、什么时候、什么状态）', async () => {
  const ctx = await make_api({ license: null, with_policy: false })
  try {
    await api_request(ctx, 'POST', '/api/emergency-stop', { body: { on: true, reason: '冒烟急停' } })
    const rows = ctx.audit.query({ kind: 'emergency_stop' })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].emergencyStop, true)
    assert.strictEqual(rows[0].actor, 'local_user')
    assert.strictEqual(rows[0].reason, '冒烟急停')
  } finally {
    await ctx.cleanup()
  }
})

test('api：急停状态下不允许通过"启动引擎"绕过（且未接调度器时如实 501）', async () => {
  const ctx = await make_api({ license: null, with_policy: false })
  try {
    await api_request(ctx, 'POST', '/api/emergency-stop', { body: { on: true } })
    // 没接调度器 → 501（明确说未接入，而不是假装成功）
    const r = await api_request(ctx, 'POST', '/api/engine', { body: { action: 'start' } })
    assert.strictEqual(r.status, 501)
    assert.strictEqual(r.json.code, 'NOT_IMPLEMENTED')
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 5. 限额（红线 1 + 红线 3 的举证链）
// ══════════════════════════════════════════════════════════

test('api：越权调高限额 → 拒绝原话返回 + 审计留痕 applied:false/reject_code', async () => {
  const ctx = await make_api()
  try {
    const server_value = ctx.policy.limits.comment.daily_max
    const r = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'daily_max', value: server_value + 1000 },
    })

    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.ok, true)
    assert.strictEqual(r.json.applied, false)
    assert.strictEqual(r.json.reject_code, 'POLICY_VIOLATION')
    // ⚠️ 护栏（guard.setOverride）抛出的原文必须原样回到界面：
    //    那句话就是产品要传达的核心——"客户端只能调得更保守"。
    assert.match(r.json.message, /更激进/)
    assert.match(r.json.message, /只能调得更保守/)
    assert.strictEqual(r.json.server_value, server_value)
    assert.strictEqual(r.json.effective_value, server_value, '被拒后生效值不变')
    assert.strictEqual(ctx.guard.overrides['comment.daily_max'], undefined, '被拒的值不能生效')

    // ⚠️ 红线 3 的举证材料：审计里必须有一条 applied:false + rejectCode。
    //    纠纷时要靠它回答"用户是否主动调高过、系统是否拒绝过"。
    const rows = ctx.audit.query({ kind: 'config_change' })
    assert.strictEqual(rows.length, 1, '必须留下一条 config_change 审计')
    const row = rows[0]
    assert.strictEqual(row.fieldKey, 'limits.comment.daily_max')
    assert.strictEqual(row.applied, false)
    assert.strictEqual(row.rejectCode, 'POLICY_VIOLATION')
    assert.strictEqual(row.source, 'user')
    assert.strictEqual(row.actor, 'local_user')
    assert.strictEqual(row.newValue, String(server_value + 1000))
    assert.ok(row.policyVersion === undefined || row.policyVersion === null
      || Number(row.policyVersion) === Number(ctx.policy.policy_version))

    // 三种"更激进"的方向都要被拒（最容易写反的是相似度那一条）
    const up = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'min_interval_ms', value: 1 },
    })
    assert.strictEqual(up.json.applied, false)
    const sim = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'content_similarity_max', value: 0.999 },
    })
    assert.strictEqual(sim.json.applied, false)
    assert.strictEqual(ctx.audit.query({ kind: 'config_change' }).length, 3,
      '三次越权尝试都要留痕（不能只记最后一次）')
  } finally {
    await ctx.cleanup()
  }
})

test('api：更保守的限额 → applied:true 审计 + 实际生效值变化', async () => {
  const ctx = await make_api()
  try {
    const server_value = ctx.policy.limits.comment.daily_max
    const conservative = Math.max(1, server_value - 5)

    const r = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'daily_max', value: conservative },
    })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.applied, true)
    assert.strictEqual(r.json.reject_code, null)
    assert.strictEqual(r.json.server_value, server_value)
    assert.strictEqual(r.json.effective_value, conservative)
    assert.strictEqual(ctx.guard.overrides['comment.daily_max'], conservative)
    assert.strictEqual(ctx.guard.effectiveLimits('comment').daily_max, conservative)

    const rows = ctx.audit.query({ kind: 'config_change' })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].applied, true)
    assert.strictEqual(rows[0].rejectCode, null)
    assert.strictEqual(rows[0].newValue, String(conservative))

    // ⚠️ 红线 3 的核心条目：必须记**实际生效值**（服务端策略与自定义取更保守者），
    //    而不是用户输入值，也不是服务端下发值。
    const applied = ctx.audit.query({ kind: 'policy_applied' })
    assert.strictEqual(applied.length, 1, '成功变更后要写一条 policy_applied')
    assert.strictEqual(applied[0].applied_limits.comment.daily_max, conservative)
    assert.strictEqual(applied[0].policyVersion, Number(ctx.policy.policy_version))

    // GET /api/limits 要同时给出服务端值与生效值（界面要并排显示）
    const limits = await api_request(ctx, 'GET', '/api/limits')
    assert.strictEqual(limits.status, 200)
    assert.strictEqual(limits.json.available, true)
    assert.strictEqual(limits.json.sources.comment.server.daily_max, server_value)
    assert.strictEqual(limits.json.sources.comment.effective.daily_max, conservative)
    assert.strictEqual(limits.json.sources.comment.override.daily_max, conservative)
    assert.strictEqual(limits.json.direction_hint, '只能更保守')
  } finally {
    await ctx.cleanup()
  }
})

test('api：尚未取得策略时 /api/limits 明确说明，而不是回一份空限额', async () => {
  const ctx = await make_api({ with_policy: false, license: null })
  try {
    const r = await api_request(ctx, 'GET', '/api/limits')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.available, false)
    assert.strictEqual(r.json.reason, 'policy_missing')
    assert.ok(r.json.message.length > 0)

    // 没有策略时设置限额要如实报错（guard 会抛"尚未采纳服务端策略"）
    const set = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'daily_max', value: 5 },
    })
    assert.strictEqual(set.json.applied, false)
    assert.strictEqual(set.json.reject_code, 'POLICY_VIOLATION')
  } finally {
    await ctx.cleanup()
  }
})

test('api：限额参数非法 → 400 结构化（未知渠道/字段/非数字）', async () => {
  const ctx = await make_api()
  try {
    const bad_source = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'weibo', field: 'daily_max', value: 5 },
    })
    assert.strictEqual(bad_source.status, 400)
    assert.strictEqual(bad_source.json.code, 'REPORT_INVALID')

    const bad_field = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'daily_max_total', value: 5 },
    })
    assert.strictEqual(bad_field.status, 400)

    const bad_value = await api_request(ctx, 'POST', '/api/limits', {
      body: { source_type: 'comment', field: 'daily_max', value: 'lots' },
    })
    assert.strictEqual(bad_value.status, 400)

    assert.strictEqual(ctx.audit.query({ kind: 'config_change' }).length, 0,
      '参数非法的请求不该产生审计条目（它连字段路径都不成立）')
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 6. /api/state 聚合
// ══════════════════════════════════════════════════════════

test('api：/api/state 绝不含令牌原文或 sign_key（红线 3 的隐私边界）', async () => {
  const ctx = await make_api()
  try {
    const r = await api_request(ctx, 'GET', '/api/state')
    assert.strictEqual(r.status, 200)

    assert.strictEqual(r.text.includes(ctx.token), false, '/api/state 泄漏了会话令牌')
    assert.strictEqual(r.text.includes('ui-token.txt'), false, '不该暴露令牌文件路径')
    assert.strictEqual(r.text.toLowerCase().includes('sign_key'), false, '响应里出现了 sign_key')
    assert.strictEqual(r.text.toLowerCase().includes('"token"'), false, '响应里出现了 token 字段')
    // 断言"整份响应里没有任何层级的 password 键"
    assert.deepStrictEqual(A.find_nested_password(r.json), [])

    // 聚合字段齐全
    for (const key of ['engine', 'guard', 'circuit', 'queue', 'license', 'dashboard',
      'trend', 'quota_notice', 'credit', 'alerts', 'recent_sends']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r.json, key), `缺少字段 ${key}`)
    }
    assert.ok(Array.isArray(r.json.alerts))
    assert.strictEqual(r.json.poll_interval_ms, A.POLL_INTERVAL_MS)
  } finally {
    await ctx.cleanup()
  }
})

test('api：/api/state 的额度文案是服务端原文（红线 1 要求逐字展示）', async () => {
  const notice = {
    headline: '当前处于观察期，仅采集线索，第 4 天开始可发送',
    detail: '观察期（第 1–3 天）平台发送上限为 0：客户端只采集线索，不发送任何评论、弹幕或私信。',
    replies_affordable: 0,
    daily_cap_total: 0,
    sending_enabled: false,
    tier: 'observation',
  }
  // ⚠️ 观察期告警的判据是**服务端下发的 policy**（sending_enabled=false），
  //    不是 quota_notice 里的同名字段——文案可以被改写，策略不能。
  //    所以这里要用真实的观察期策略（第 1 天）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-obs-'))
  const store = new Store({ dir })
  const guard = new Guard({ store, now: () => NOW })
  const queue = new Queue({ store, now: () => NOW })
  const circuit = new CircuitBreaker({ store, now: () => NOW })
  const audit = new AuditLog({ store, now: () => NOW })
  const obs_policy = buildPolicy({ accountId: 7, accountDayIndex: 1, policyVersion: 9, nowMs: NOW })
  assert.strictEqual(obs_policy.sending_enabled, false, '前置条件：观察期策略必须禁发')
  guard.applyPolicy(obs_policy)
  const license = fake_license({ policy: obs_policy, quota_notice: notice })
  const api = A.create_local_api({
    config: make_config(dir), store, guard, queue, circuit, audit,
    license_state: license.state, license_auth: license.auth, license_reporter: license.reporter,
    port: 0, now: () => NOW, write_token: false,
  })
  const info = await api.listen()
  const ctx = { port: info.port, host: `127.0.0.1:${info.port}`, token: info.token }
  try {
    const r = await api_request(ctx, 'GET', '/api/state')
    assert.deepStrictEqual(r.json.quota_notice, notice,
      'quota_notice 必须原样透传，不得改写、截断或加工')
    // 观察期必须出现在告警里，且副标题用服务端 headline
    const alert = r.json.alerts.find((a) => a.code === 'observation_period')
    assert.ok(alert, '观察期必须产生一条告警')
    assert.strictEqual(alert.detail, notice.headline)
    // 观察期日上限为 0 → 使用率必须是 null（界面画"无使用率"而不是 0%）
    const usage = r.json.dashboard.daily_quota_usage
    assert.ok(usage, '观察期也应有额度结构（上限 0）')
    for (const src of Object.keys(usage)) {
      assert.strictEqual(usage[src].max, 0, `${src} 观察期上限必须是 0`)
      assert.strictEqual(usage[src].usage_ratio, null, `${src} 上限为 0 时比率必须是 null`)
    }
    const disp = r.json.dashboard.quota_usage_display
    assert.strictEqual(disp[0].width_percent, null, '上限为 0 时不得给出进度条宽度')
    assert.strictEqual(disp[0].ratio_display, '—')
  } finally {
    await api.close()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('api：/api/state 的空看板不给样例数字，且 null 比率显示为 —', async () => {
  const ctx = await make_api()
  try {
    const r = await api_request(ctx, 'GET', '/api/state')
    const dash = r.json.dashboard
    assert.strictEqual(dash.empty, true, '没有明细时必须显式标出空态')
    assert.strictEqual(dash.display['回复成功率'], null, '分母为 0 时比率必须是 null')
    assert.strictEqual(dash.display['回复成功率显示'], '—')
    // 所有计数为 0（而不是任何样例数字）
    for (const [k, v] of Object.entries(dash.counts)) {
      assert.strictEqual(v, 0, `空看板的 ${k} 必须是 0，实际 ${v}`)
    }
    // 前端要用的展示文本也必须是 —
    for (const src of ['comment', 'live_danmaku', 'dm']) {
      assert.strictEqual(dash.by_source_display[src].success_rate_display, '—')
    }
    assert.strictEqual(r.json.trend.length, 7, '默认 7 日趋势')
    assert.ok(dash.quota_usage_display.length > 0)
    assert.strictEqual(dash.quota_usage_display[0].ratio_display !== undefined, true)
  } finally {
    await ctx.cleanup()
  }
})

test('api：/api/state 的看板数字来自真实明细（不是硬编码）', async () => {
  const ctx = await make_api()
  try {
    // 造两条明细：一条平台确认成功、一条失败
    ctx.store.update('pending-sends.json', [], (list) => {
      list.push({ send_id: 's-1', source_type: 'comment', verdict: 'sent_confirmed', sent_at_ms: ctx.at(), user_key_hash: 'u-1' })
      list.push({ send_id: 's-2', source_type: 'comment', verdict: 'failed', sent_at_ms: ctx.at(), failure_reason: 'rate_limited' })
      return list
    })
    ctx.audit.recordSendResult({
      sendId: 's-1', sourceType: 'comment', verdict: 'sent_confirmed',
      confirmSignal: 'platform_response', platformStatusCode: 0, atMs: ctx.at(), userKeyHash: 'u-1',
    })
    ctx.audit.recordSendResult({
      sendId: 's-2', sourceType: 'comment', verdict: 'failed',
      failureReason: 'rate_limited', atMs: ctx.at() + 1, userKeyHash: 'u-2',
    })

    const r = await api_request(ctx, 'GET', '/api/state')
    const counts = r.json.dashboard.counts
    assert.strictEqual(counts.sent_confirmed, 1)
    assert.strictEqual(counts.failed, 1)
    assert.strictEqual(counts.reply_attempts, 2)
    assert.strictEqual(r.json.dashboard.empty, false)
    // 成功率 1/2 = 0.5
    assert.strictEqual(r.json.dashboard.display['回复成功率显示'], '50.0%')
    assert.strictEqual(r.json.dashboard.by_source_display.comment.success_rate_display, '50.0%')
    assert.deepStrictEqual(r.json.dashboard.failure_reasons, { rate_limited: 1 })

    // recent_sends 只有哈希与判定，没有原文
    assert.strictEqual(r.json.recent_sends.length, 2)
    const one = r.json.recent_sends[0]
    assert.ok(one.verdict)
    assert.strictEqual(one.user_key_hash, 'u-2')
    assert.strictEqual(one.send_id, 's-2')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(one, 'content'), false)
  } finally {
    await ctx.cleanup()
  }
})

test('api：/api/dashboard 支持 days 参数并校验非法值', async () => {
  const ctx = await make_api()
  try {
    const r = await api_request(ctx, 'GET', '/api/dashboard?days=3')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.trend.length, 3)
    assert.ok(r.json.dashboard)
    assert.ok(Object.prototype.hasOwnProperty.call(r.json, 'quota_notice'))

    const bad = await api_request(ctx, 'GET', '/api/dashboard?days=abc')
    assert.strictEqual(bad.status, 400)
    assert.strictEqual(bad.json.code, 'REPORT_INVALID')

    // 超范围要夹取而不是抛错（防止 days=100000 变成一次内存放大）
    const clamped = await api_request(ctx, 'GET', '/api/dashboard?days=100000')
    assert.strictEqual(clamped.status, 200)
    assert.strictEqual(clamped.json.trend.length, 90)
  } finally {
    await ctx.cleanup()
  }
})

test('api：/api/queue 与 /api/state 的队列部分反映真实队列', async () => {
  const ctx = await make_api()
  try {
    ctx.queue.add({ kind: 'reply_comment', sourceType: 'comment', dedupKey: 'dk-1' })
    ctx.queue.add({ kind: 'reply_comment', sourceType: 'comment', dedupKey: 'dk-2' })

    const r = await api_request(ctx, 'GET', '/api/queue?state=queued')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.stats.total, 2)
    assert.strictEqual(r.json.stats.queued, 2)
    assert.strictEqual(r.json.items.length, 2)
    assert.strictEqual(r.json.max_queue_size, 5000)

    const bad = await api_request(ctx, 'GET', '/api/queue?state=nonsense')
    assert.strictEqual(bad.status, 400)

    const state = await api_request(ctx, 'GET', '/api/state')
    assert.strictEqual(state.json.queue.stats.total, 2)
    assert.strictEqual(state.json.queue.items.length, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('api：队列积压超过 80% 容量 → queue_backlog 告警（阈值由常量推导）', async () => {
  const ctx = await make_api()
  try {
    const { MAX_QUEUE_SIZE } = require('../../client/host/queue')
    assert.strictEqual(A.QUEUE_BACKLOG_RATIO, 0.8)
    // 直接往盘上灌到阈值（走 store，保持单写者约束）
    const backlog = Math.ceil(MAX_QUEUE_SIZE * A.QUEUE_BACKLOG_RATIO)
    ctx.store.update('queue.json', [], (list) => {
      for (let i = 0; i < backlog; i++) {
        list.push({
          id: `t-${i}`, kind: 'reply_comment', sourceType: 'comment',
          dedupKey: `dk-${i}`, payload: {}, state: 'queued', attempts: 0,
          enqueuedAtMs: NOW, takenAtMs: 0, finishedAtMs: 0, priority: 0,
        })
      }
      return list
    })
    const r = await api_request(ctx, 'GET', '/api/state')
    const alert = r.json.alerts.find((a) => a.code === 'queue_backlog')
    assert.ok(alert, '积压到 80% 必须产生告警')
    assert.strictEqual(alert.limit, MAX_QUEUE_SIZE)
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 7. 审计 / 上报 / 告警
// ══════════════════════════════════════════════════════════

test('api：/api/audit 支持 kind/limit 过滤，并带出损坏行计数', async () => {
  const ctx = await make_api()
  try {
    ctx.audit.recordEmergencyStop({ on: true, reason: 'r1', atMs: ctx.at() })
    ctx.audit.recordLogin({ event: 'login', ok: true, atMs: ctx.at() + 1 })
    ctx.audit.append({ kind: 'security_event', event: 'selector_miss', code: 'SELECTOR_MISS', tsMs: ctx.at() + 2 })

    const all = await api_request(ctx, 'GET', '/api/audit')
    assert.strictEqual(all.status, 200)
    assert.strictEqual(all.json.entries.length, 3)
    assert.strictEqual(all.json.corrupt_lines, 0)
    assert.ok(all.json.stats && all.json.stats.total === 3)

    const only = await api_request(ctx, 'GET', '/api/audit?kind=emergency_stop')
    assert.strictEqual(only.json.entries.length, 1)
    assert.strictEqual(only.json.entries[0].kind, 'emergency_stop')

    const limit = await api_request(ctx, 'GET', '/api/audit?limit=2')
    assert.strictEqual(limit.json.entries.length, 2)

    const bad_kind = await api_request(ctx, 'GET', '/api/audit?kind=not_a_kind')
    assert.strictEqual(bad_kind.status, 400)
    assert.strictEqual(bad_kind.json.code, 'AUDIT_SEND_INVALID')

    const bad_time = await api_request(ctx, 'GET', '/api/audit?from=abc')
    assert.strictEqual(bad_time.status, 400)

    const bad_limit = await api_request(ctx, 'GET', '/api/audit?limit=nope')
    assert.strictEqual(bad_limit.status, 400)

    // 未接入审计时**如实 501**，而不是回 `entries: []`（那正是 D-14 的形态）
    const no_audit = await make_api({ license: null, audit: false })
    try {
      assert.strictEqual(no_audit.api.audit, null, '前置条件：本轮确实没有注入审计')
      const r = await api_request(no_audit, 'GET', '/api/audit')
      assert.strictEqual(r.status, 501)
      assert.strictEqual(r.json.code, 'NOT_IMPLEMENTED')
      assert.strictEqual(r.json.ok, false)
    } finally {
      await no_audit.cleanup()
    }
  } finally {
    await ctx.cleanup()
  }
})

test('api：选择器未命中在近 1 小时内累计 → selector_drift 告警', async () => {
  const ctx = await make_api()
  try {
    for (let i = 0; i < A.LIMITS.selector_drift_threshold; i++) {
      ctx.audit.append({ kind: 'security_event', event: 'selector_miss', code: 'SELECTOR_MISS', tsMs: ctx.at() - i })
    }
    const r = await api_request(ctx, 'GET', '/api/state')
    const alert = r.json.alerts.find((a) => a.code === 'selector_drift')
    assert.ok(alert, '累计到阈值必须报选择器漂移')
    assert.strictEqual(alert.count, A.LIMITS.selector_drift_threshold)
  } finally {
    await ctx.cleanup()
  }
})

test('api：熔断开时告警必须回答"第几级、何时恢复"', async () => {
  const ctx = await make_api()
  try {
    for (let i = 0; i < 5; i++) ctx.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    const r = await api_request(ctx, 'GET', '/api/state')
    assert.ok(r.json.guard.circuit.level !== 'none', '前置条件：应当已熔断')
    const alert = r.json.alerts.find((a) => a.code === 'circuit_open')
    assert.ok(alert, '熔断必须产生告警')
    assert.ok(alert.level_index >= 1, '必须给出级别序号')
    assert.ok(Number(alert.until_ms) > ctx.at(), '必须给出恢复时刻')
    assert.ok(Number(alert.remaining_ms) > 0, '必须给出剩余时间')
    // 熔断面板要的数据也在 circuit 快照里
    assert.strictEqual(r.json.circuit.open, true)
    assert.ok(r.json.circuit.remainingMs > 0)
    assert.ok(typeof r.json.circuit.failureRateDisplay === 'string')
  } finally {
    await ctx.cleanup()
  }
})

test('api：余额耗尽 → credit_exhausted 告警；未登录 → credential_invalid 告警', async () => {
  const ctx = await make_api({ license: { credit: { balance_milli: 0, credit_per_reply_milli: 1000 } } })
  try {
    const r = await api_request(ctx, 'GET', '/api/state')
    assert.ok(r.json.alerts.some((a) => a.code === 'credit_exhausted'))
  } finally {
    await ctx.cleanup()
  }

  const anon = await make_api({
    license: { quota_notice: null }, with_policy: false,
  })
  try {
    anon.license.raw_state.logged_in = false
    const r = await api_request(anon, 'GET', '/api/state')
    assert.ok(r.json.alerts.some((a) => a.code === 'credential_invalid'))
  } finally {
    await anon.cleanup()
  }
})

test('api：GET /api/sends/pending-count 与 POST /api/report/now 如实返回', async () => {
  const ctx = await make_api({ license: { pending_count: 7 } })
  try {
    const c = await api_request(ctx, 'GET', '/api/sends/pending-count')
    assert.strictEqual(c.status, 200)
    assert.strictEqual(c.json.pending_count, 7)

    // ⚠️ 无明细时 reportSends 返回 null 且**不发请求**（契约 §9.1）。
    //    接口必须如实说"没发"，而不是伪装成"上报成功 0 条"。
    const r = await api_request(ctx, 'POST', '/api/report/now', { body: {} })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.sends.sent, false)
    assert.strictEqual(r.json.sends.reason, 'no_pending_sends')
    assert.match(r.json.message, /没有待上报/)
    assert.strictEqual(ctx.license.reporter.report_sends_calls, 1)

    // 未接上报器时 → 501（不假装成功）
    const bare = await make_api({ license: null })
    try {
      const no = await api_request(bare, 'GET', '/api/sends/pending-count')
      assert.strictEqual(no.status, 501)
      const no2 = await api_request(bare, 'POST', '/api/report/now', { body: {} })
      assert.strictEqual(no2.status, 501)
    } finally {
      await bare.cleanup()
    }
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 8. 登录 / 登出 —— 密码的处置
// ══════════════════════════════════════════════════════════

test('api：POST /api/login 的密码绝不落进审计日志或实例目录', async () => {
  // ⚠️ 用一个"磁盘上不可能自然出现"的串。只要它在实例目录的任何字节里
  //    出现，就说明密码被写进了日志/审计/配置文件。
  const password = 'ZZQQ-PASSWORD-CANARY-9f3a7c21'
  const ctx = await make_api({ write_token: true })
  try {
    const r = await api_request(ctx, 'POST', '/api/login', {
      body: { account: 'demo001', password },
    })
    assert.strictEqual(r.status, 200, '登录桩件应当成功')
    assert.strictEqual(r.json.ok, true)
    assert.strictEqual(r.json.logged_in, true)
    assert.strictEqual(r.text.includes(password), false, '响应体里出现了密码')
    assert.deepStrictEqual(A.find_nested_password(r.json), [], '响应里不应有 password 字段')

    // auth 层确实收到了密码（长度对得上），说明不是被提前吞掉了
    assert.strictEqual(ctx.license.auth.login_calls.length, 1)
    assert.strictEqual(ctx.license.auth.login_calls[0].account, 'demo001')
    assert.strictEqual(ctx.license.auth.login_calls[0].password_len, password.length)

    // ── 全目录扫描 ──────────────────────────────────────
    const files = read_dir_recursive(ctx.dir)
    assert.ok(files.length > 1, '实例目录应当有文件（审计 + 令牌 + 运行态）')
    for (const f of files) {
      assert.strictEqual(f.text.includes(password), false,
        `密码出现在了 ${path.relative(ctx.dir, f.path)}`)
    }

    // ── 审计里也不能有（即使被脱敏成别的形态也不该出现原文）──
    const login_rows = ctx.audit.query({ kind: 'login' })
    assert.strictEqual(login_rows.length, 1)
    assert.strictEqual(login_rows[0].ok, true)
    assert.strictEqual(JSON.stringify(login_rows[0]).includes(password), false)
    assert.deepStrictEqual(A.find_nested_password(login_rows[0]), [])

    // 登录成功的审计里也不该有 token / sign_key
    const lower = JSON.stringify(login_rows[0]).toLowerCase()
    assert.strictEqual(lower.includes('sign_key'), false)
    assert.strictEqual(lower.includes('"token"'), false)
  } finally {
    await ctx.cleanup()
  }
})

test('api：登录失败时密码同样不落盘，且错误信封被抹过一遍', async () => {
  const password = 'FAILED-LOGIN-CANARY-4b8e'
  // ⚠️ 构造一个**故意把密码塞进 message 和 detail** 的异常——
  //    模拟底层某个模块不守规矩时，出口的 scrub 能不能兜住。
  const leaky = new Error(`认证失败：password=${password}`)
  leaky.code = 'AUTH_PASSWORD_WRONG'
  leaky.detail = { echo: password, nested: { also: password } }

  const ctx = await make_api({ license: { login_throws: leaky } })
  try {
    const r = await api_request(ctx, 'POST', '/api/login', {
      body: { account: 'demo001', password },
    })
    assert.notStrictEqual(r.status, 200)
    assert.strictEqual(r.json.ok, false)
    assert.strictEqual(r.json.code, 'AUTH_PASSWORD_WRONG')
    // ⚠️ 出口必须把密码抹掉（兜底），否则它会被截图、被贴进工单
    assert.strictEqual(r.text.includes(password), false, '错误响应里泄漏了密码')
    assert.match(r.json.message, /\[redacted\]/)

    // 审计里记的是失败事件与错误码，不含密码
    const rows = ctx.audit.query({ kind: 'login' })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].ok, false)
    assert.strictEqual(rows[0].code, 'AUTH_PASSWORD_WRONG')
    for (const f of read_dir_recursive(ctx.dir)) {
      assert.strictEqual(f.text.includes(password), false,
        `密码出现在了 ${path.relative(ctx.dir, f.path)}`)
    }

    // 缺账号/密码 → 400，且不带密码
    const missing = await api_request(ctx, 'POST', '/api/login', { body: { account: 'a' } })
    assert.strictEqual(missing.status, 400)
    assert.strictEqual(missing.json.code, 'AUTH_INVALID_REQUEST')
  } finally {
    await ctx.cleanup()
  }
})

test('api：POST /api/login 返回授权层的 warnings 与 quota_notice（原样）', async () => {
  const notice = { headline: '服务端原文 headline', detail: '服务端原文 detail' }
  const ctx = await make_api({
    license: {
      login_warnings: ['设备数已达上限，已顶替设备 xxx 上的会话'],
      quota_notice: notice,
    },
  })
  try {
    const r = await api_request(ctx, 'POST', '/api/login', {
      body: { account: 'demo001', password: 'pw' },
    })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json.warnings, ['设备数已达上限，已顶替设备 xxx 上的会话'])
    assert.deepStrictEqual(r.json.quota_notice, notice)
  } finally {
    await ctx.cleanup()
  }
})

test('api：/api/login 未接授权层 → 501 且明确说急停仍可用', async () => {
  const ctx = await make_api({ license: null, with_policy: false })
  try {
    const r = await api_request(ctx, 'POST', '/api/login', { body: { account: 'a', password: 'b' } })
    assert.strictEqual(r.status, 501)
    assert.strictEqual(r.json.code, 'NOT_IMPLEMENTED')
    assert.match(r.json.message, /急停/)
  } finally {
    await ctx.cleanup()
  }
})

test('api：POST /api/logout 清会话并记审计', async () => {
  const ctx = await make_api()
  try {
    const r = await api_request(ctx, 'POST', '/api/logout', { body: {} })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.logged_in, false)
    assert.strictEqual(r.json.was_logged_in, true)
    const rows = ctx.audit.query({ kind: 'login' })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].event, 'logout')
    // ⚠️ 登出后本地审计与队列必须保留（它们是举证依据）
    assert.ok(ctx.audit.stats().total >= 1)
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 9. 规则（模板池变体数 / 占位符）
// ══════════════════════════════════════════════════════════

test('api：规则保存要求模板池至少 5 条不同变体，并拒绝 {随机N} 占位符', async () => {
  const ctx = await make_api({ license: null, with_policy: false })
  try {
    const too_few = await api_request(ctx, 'POST', '/api/rules', {
      body: { rules: [{ source_type: 'comment', keywords: ['多少钱'], templates: ['这个多少钱', '这款多少钱'] }] },
    })
    assert.strictEqual(too_few.status, 400)
    assert.match(too_few.json.message, /变体/)

    // ⚠️ 5 条一模一样的模板不算 5 条变体
    const dup = await api_request(ctx, 'POST', '/api/rules', {
      body: {
        rules: [{
          source_type: 'comment', keywords: ['多少钱'],
          templates: ['这个多少钱', '这个多少钱', '这个多少钱', '这个多少钱', '这个多少钱'],
        }],
      },
    })
    assert.strictEqual(dup.status, 400)
    assert.match(dup.json.message, /不同的变体|变体/)

    // {随机1-9} 这类占位符必须被明确拒绝并给出替代方案
    const placeholder = await api_request(ctx, 'POST', '/api/rules', {
      body: {
        rules: [{
          source_type: 'comment', keywords: ['多少钱'],
          templates: ['这个多少钱{随机1-9}', '这款什么价', '它怎么卖', '价格是多少呢', '方便报个价吗'],
        }],
      },
    })
    assert.strictEqual(placeholder.status, 400)
    assert.match(placeholder.json.message, /随机/)
    assert.match(placeholder.json.message, /语言变体/)

    // 合法规则：5 条语言变体
    const ok = await api_request(ctx, 'POST', '/api/rules', {
      body: {
        rules: [{
          source_type: 'comment', keywords: ['多少钱', '什么价'],
          templates: ['这个多少钱呀', '这款什么价格', '它怎么卖呢', '方便报个价吗', '价格是多少呢'],
        }],
      },
    })
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.json.count, 1)
    assert.strictEqual(ok.json.rules[0].templates.length, 5)
    assert.ok(ok.json.rules[0].id)

    const back = await api_request(ctx, 'GET', '/api/rules')
    assert.strictEqual(back.json.rules.length, 1)
    assert.deepStrictEqual(back.json.rules[0].keywords, ['多少钱', '什么价'])
  } finally {
    await ctx.cleanup()
  }
})

// ══════════════════════════════════════════════════════════
// 10. 源码静态扫描（防止约束被后续改动破坏）
// ══════════════════════════════════════════════════════════

function read_repo_file(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function list_files(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...list_files(p))
    else out.push(p)
  }
  return out
}

test('源码扫描：api.js 默认绑回环，且全客户端不出现 Access-Control-Allow-Origin 通配', () => {
  const api_src = read_repo_file('client/host/api.js')

  // ① 默认 host 来自 config，且 config 的默认值是回环
  assert.match(api_src, /opts\.host \|\| this\.config\.uiHost/)
  const { DEFAULTS } = require('../../client/config')
  assert.strictEqual(DEFAULTS.uiHost, '127.0.0.1')

  // ② 全 client/ 下**不得**出现通配 CORS 字面量（AGENTS.md §2.13 的 D-6 形态）
  const client_files = list_files(path.join(ROOT, 'client'))
  for (const f of client_files) {
    if (!/\.(js|html|css)$/.test(f)) continue
    const text = fs.readFileSync(f, 'utf8')
    assert.strictEqual(/Access-Control-Allow-Origin\s*['"`]?\s*[:=]\s*['"`]\*/.test(text), false,
      `${path.relative(ROOT, f)} 出现了通配 CORS`)
    assert.strictEqual(text.includes("'Access-Control-Allow-Origin': '*'"), false,
      `${path.relative(ROOT, f)} 出现了通配 CORS`)
    assert.strictEqual(text.includes('"Access-Control-Allow-Origin": "*"'), false,
      `${path.relative(ROOT, f)} 出现了通配 CORS`)
  }
  // api.js 里必须是"按白名单回显"，不是常量
  // ⚠️ 两种写法都要认（对象字面量 / 索引赋值），任一处缺失都算缺陷。
  assert.match(api_src, /['"]Access-Control-Allow-Origin['"]:\s*origin_check\.origin/)
  // 预检路径上必须按白名单回显，而**不是**照抄请求里的 Origin
  assert.match(api_src, /['"]Access-Control-Allow-Origin['"]\]\s*=\s*cors_origin/)
  assert.strictEqual(/Allow-Origin['"]\]\s*=\s*(req|request)\.headers/.test(api_src), false,
    '不得把请求里的 Origin 原样回显')

  // ③ 不得出现 0.0.0.0 作为绑定地址
  assert.strictEqual(/listen\([^)]*['"]0\.0\.0\.0['"]/.test(api_src), false,
    'api.js 里出现了 0.0.0.0 绑定')
})

test('源码扫描：client/ui/ 无 CDN、无框架、无 eval、无外部字体', () => {
  const ui_files = list_files(path.join(ROOT, 'client', 'ui'))
  assert.ok(ui_files.length >= 3, 'client/ui 至少应有 index.html / app.css / app.js')

  const forbidden = [
    { re: /\beval\s*\(/, why: 'eval(' },
    { re: /new\s+Function\s*\(/, why: 'new Function(' },
    { re: /cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|googleapis\.com|fonts\.googleapis/, why: 'CDN 外链' },
    { re: /\bvue\b|\breact\b|\balpinejs\b|\bjquery\b|\becharts\b|\bchart\.js\b/i, why: '前端框架/图表库' },
    { re: /@import\s+url\(/, why: 'CSS 外链 @import' },
    { re: /<script[^>]+src\s*=\s*["']https?:/i, why: '外部脚本' },
    { re: /<link[^>]+href\s*=\s*["']https?:/i, why: '外部样式' },
    { re: /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/, why: '外部 http(s) 地址' },
  ]

  for (const f of ui_files) {
    const text = fs.readFileSync(f, 'utf8')
    const rel = path.relative(ROOT, f)
    for (const rule of forbidden) {
      const m = rule.re.exec(text)
      assert.strictEqual(m, null, `${rel} 命中禁用模式「${rule.why}」：${m ? m[0] : ''}`)
    }
    // 不得引用任何**别的**本地端口（只能用相对路径调用本服务）
    assert.strictEqual(/127\.0\.0\.1:\d+/.test(text), false, `${rel} 出现了写死的回环端口`)
    assert.strictEqual(/localhost:\d+\/api/.test(text), false, `${rel} 出现了写死的本地 API 地址`)
  }
})

test('源码扫描：client/ui/app.js 不做任何看板算术（口径只有 shared/lib/stats.js 一份）', () => {
  const app_src = read_repo_file('client/ui/app.js')

  // ① 不得出现比率计算形态
  const arithmetic = [
    { re: /\*\s*100\b/, why: '* 100（比率换算）' },
    { re: /\/\s*reply_attempts\b/, why: '/ reply_attempts（成功率）' },
    { re: /\/\s*sent_confirmed\b/, why: '/ sent_confirmed' },
    { re: /\/\s*1000\b/, why: '/ 1000（积分换算）' },
    { re: /Math\.round\s*\(\s*[^)]*\*\s*100/, why: 'Math.round(...*100)' },
  ]
  for (const rule of arithmetic) {
    const m = rule.re.exec(app_src)
    assert.strictEqual(m, null, `app.js 里出现了看板算术「${rule.why}」：${m ? m[0] : ''}`)
  }

  // ② 必须从接口的 dashboard 对象取展示值（而不是自己算）
  assert.match(app_src, /dashboard\.display/)
  assert.match(app_src, /by_source_display/)
  assert.match(app_src, /quota_usage_display/)
  assert.match(app_src, /trend_display/)
  assert.match(app_src, /\.success_rate_display/)

  // ③ 不得出现任何硬编码样例数字（D-14）
  //    ⚠️ 只扫"像是被渲染出来的数字"：直接写进 text 的计数形态。
  assert.strictEqual(/text:\s*['"]?\d{2,}['"]?\s*[,)]/.test(app_src), false,
    'app.js 里出现了硬编码的数字文本')
  assert.strictEqual(app_src.includes('暂无数据'), true, '空态必须显示"暂无数据"')
  // 前端绝不能把 null 画成 0%
  assert.strictEqual(/'0%'/.test(app_src), false, "app.js 里出现了字面量 '0%'")
  assert.strictEqual(/"0%"/.test(app_src), false, 'app.js 里出现了字面量 "0%"')
  assert.strictEqual(/'100%'/.test(app_src), false, "app.js 里出现了字面量 '100%'")

  // ④ 不得用 innerHTML 拼接数据（XSS 路径）
  assert.strictEqual(/\.innerHTML\s*=/.test(app_src), false, 'app.js 不得给 innerHTML 赋值')
  assert.strictEqual(/insertAdjacentHTML/.test(app_src), false)
  assert.match(app_src, /textContent/)

  // ⑤ 令牌只经 sessionStorage + 请求头；不得用**持久化**的 Web Storage
  //    （关闭标签页后仍留存的凭据，不该出现在商家机器上）。
  //    ⚠️ 禁用词用拼接写，否则这条断言会把自己扫出来。
  const persistent_storage = 'local' + 'Storage'
  assert.match(app_src, /sessionStorage/)
  assert.strictEqual(app_src.includes(persistent_storage), false,
    '令牌不得进持久化的 Web Storage（长期留存）')
  assert.match(app_src, /replaceState/, '令牌必须从地址栏抹掉')
  assert.match(app_src, /X-UI-Token/)

  // ⑥ 轮询失败必须清状态并告警（不能冻结旧数字）
  assert.match(app_src, /state\.data = null/)
  assert.match(app_src, /本地服务未响应|未响应/)
})

test('源码扫描：client/ui 不得碰磁盘，api.js 的 fs 只用于静态资源与 chmod', () => {
  const app_src = read_repo_file('client/ui/app.js')
  const html_src = read_repo_file('client/ui/index.html')
  assert.strictEqual(/fs\./.test(app_src), false, 'app.js 不得出现 fs.')
  assert.strictEqual(/require\s*\(/.test(app_src), false, 'app.js 不应 require 任何模块')

  const api_src = read_repo_file('client/host/api.js')
  const fs_lines = api_src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((x) => /fs\./.test(x.line) && !/^\s*(\/\/|\*)/.test(x.line))
  // 许可证：只有读静态资源 + chmod 收紧令牌权限
  for (const x of fs_lines) {
    assert.ok(/fs\.readFile\(|fs\.chmodSync\(/.test(x.line),
      `api.js:${x.n} 出现了白名单外的 fs 用法：${x.line}`)
  }
  assert.strictEqual(/fs\.writeFileSync|fs\.appendFileSync|fs\.rmSync|fs\.unlinkSync|fs\.mkdirSync/.test(api_src),
    false, 'api.js 不得直接写盘（运行数据必须经 store）')
  // 静态资源只来自白名单表
  assert.match(api_src, /const STATIC_ASSETS = Object\.freeze\(/)
  assert.match(api_src, /path\.join\(UI_DIR, asset\.file\)/)
})

test('源码扫描：无空 catch（本项目最贵的一次教训）', () => {
  for (const rel of ['client/host/api.js', 'client/ui/app.js', 'test/unit/client-api.test.js']) {
    const src = read_repo_file(rel)
    // 允许 `catch {` 但体内必须至少有一条语句（不能紧跟 `}`）
    const empty = /catch\s*(\([^)]*\))?\s*\{\s*\}/g
    const m = empty.exec(src)
    assert.strictEqual(m, null, `${rel} 出现了空 catch：${m ? m[0] : ''}`)
  }
})

// ══════════════════════════════════════════════════════════
// 11. 生命周期
// ══════════════════════════════════════════════════════════

test('api：close() 幂等，且重复调用不抛错、不留监听', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-close-'))
  const store = new Store({ dir })
  const guard = new Guard({ store, now: () => NOW })
  const api = A.create_local_api({
    config: make_config(dir), store, guard, port: 0, write_token: false,
  })
  try {
    await api.listen()
    const first = await api.close()
    assert.strictEqual(first.closed, true)
    assert.strictEqual(first.had_listener, true)
    assert.strictEqual(api.listening, false)

    const second = await api.close()
    assert.strictEqual(second.already_closed, true)

    const third = await api.close()
    assert.strictEqual(third.already_closed, true)

    // 关掉之后再请求应当连不上（ECONNREFUSED），而不是"还能用"
    await assert.rejects(
      () => api_request({ port: api.port, host: `127.0.0.1:${api.port}`, token: api.token },
        'GET', '/healthz', { token: null }),
      (e) => e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET',
    )
  } finally {
    await api.close()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('api：未 listen 就 close() 也必须成功（停机路径上不能抛错）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-nolisten-'))
  const store = new Store({ dir })
  const guard = new Guard({ store, now: () => NOW })
  const api = A.create_local_api({
    config: make_config(dir), store, guard, port: 0, write_token: false,
  })
  try {
    const r = await api.close()
    assert.strictEqual(r.closed, true)
    assert.strictEqual(r.had_listener, false)
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('api：handler 抛异常时返回结构化 500，绝不崩进程', async () => {
  const ctx = await make_api()
  try {
    // 造一个"读取时抛错"的 guard：模拟依赖内部坏了。
    // ⚠️ 必须实现全部会被调用的方法——测试替身缺方法会抛 TypeError，
    //    那测的就不再是"api.js 的兜底"，而是"替身写漏了"。
    const original = ctx.api.guard
    ctx.api.guard = {
      emergencyStop: false,
      emergencyReason: null,
      policy: null,
      overrides: {},
      snapshot() { throw new Error('护栏内部炸了') },
      effectiveLimits() { return null },
      usedToday() { return 0 },
      isCircuitOpen() { return false },
      canSend() { return { allow: false, reason: 'policy_missing' } },
      setEmergencyStop() { throw new Error('不该被调用') },
    }
    const r = await api_request(ctx, 'GET', '/api/state')
    assert.strictEqual(r.status, 500, `期望结构化 500，实际 ${r.status}：${r.text.slice(0, 200)}`)
    assert.strictEqual(r.json.ok, false)
    assert.strictEqual(r.json.code, 'INTERNAL')
    // ⚠️ 出口**不回**内部异常的原文（那可能带路径、SQL、凭据片段），
    //    只回一句通用说明 + 异常类型。真实原因留在 `last_error` 里供排障。
    assert.strictEqual(r.json.message.includes('本地接口内部错误'), true)
    assert.strictEqual(r.json.message.includes('护栏内部炸了'), false,
      '内部异常原文不得出现在响应里')
    assert.strictEqual(r.json.detail.cause, 'Error')

    // 进程还活着，其他路由还能用
    ctx.api.guard = original
    const after = await api_request(ctx, 'GET', '/healthz', { token: null })
    assert.strictEqual(after.status, 200)
    assert.ok(ctx.api.last_error, '兜底异常必须留痕（last_error）')
    assert.strictEqual(ctx.api.last_error.code, 'INTERNAL')
    assert.match(ctx.api.last_error.message, /护栏内部炸了/)
  } finally {
    await ctx.cleanup()
  }
})
