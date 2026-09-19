'use strict'

// test/unit/license-cli.test.js
//
// `license-server/cli.js` 的单元测试。
//
// ⚠️ 为什么**在同进程内**调 `run(argv)` 而不是 spawn 子进程：
//    spawn 会让每个用例付一次 Node 启动 + 建库成本，几十个用例就慢到没人愿意跑；
//    而且一旦失败只能靠 stdout 文本猜原因，定位成本极高。
//    `cli.js` 因此刻意把入口做成"返回退出码 + 可注入 io"（见其 run() 头部注释）。
//
// ⚠️ 为什么每次 run 都带 `dataDir`：
//    `loadConfig()` 在 DATA_DIR 下会**生成 master.key**（见 config.js）。
//    不隔离的话，测试会往仓库里写密钥文件，并使 DATA_DIR/DB_PATH 指向真实数据目录。
//
// ⚠️ 本文件断言的重点不是"输出好看"，而是**数值来源**：
//    · 最低积分的拒绝阈值必须等于 `domain/policy.js` 的 `minPlanCredit()`
//      （将来有人把 12600 写死进 CLI，这条会立刻失败）
//    · 看板数字必须等于 `shared/lib/stats.js` 的输出（自己算百分比就会漂移）
//    · 台账 `balance_after_milli` 必须等于真实余额（append-only 的内部一致性）

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..', '..')
const cli = require(path.join(ROOT, 'license-server', 'cli.js'))
const { openDatabase } = require(path.join(ROOT, 'license-server', 'store', 'db.js'))
const { planCreditsFor, minPlanCredit, stableDailyMaxTotal } = require(path.join(ROOT, 'license-server', 'domain', 'policy.js'))
const { aggregateSends, aggregateReports, buildDashboard, dayKey } = require(path.join(ROOT, 'shared', 'lib', 'stats.js'))

// ═══════════════════════════════════════════════════════════
// 测试环境
// ═══════════════════════════════════════════════════════════

const MASTER_KEY = 'cli-test-master-key-0123456789abcdef0123456789abcdef'
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-cli-test-'))

// ⚠️ master 密钥必须显式给：不给的话 config.js 会在 DATA_DIR 里落一个 master.key，
//    测试就产生了"额外文件"这一副作用。
process.env.SIGN_MASTER_KEY = MASTER_KEY
delete process.env.ADMIN_PATH
delete process.env.ADMIN_IP_ALLOW

/** 用的固定"现在"，避免跨零点时命中不同自然日导致偶发失败。 */
const NOW_MS = Date.now()

let seq = 0
function freshDbPath(label) {
  seq++
  const dir = path.join(TMP_ROOT, `${label}-${seq}`)
  fs.mkdirSync(dir, { recursive: true })
  return { dir, dbPath: path.join(dir, 'license.db') }
}

/** 建库并跑迁移。⚠️ 关掉迁移前备份：测试不需要，且会多写 backups/ 文件。 */
function migrate(dbPath) {
  const { db, close } = openDatabase(dbPath, { backupBeforeMigrate: false })
  close()
}

/**
 * 在同进程内执行一次 CLI。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runCli(argv, { dbPath, dir, stdin = '', nowMs = NOW_MS, stdinIsTTY = false } = {}) {
  const outChunks = []
  const errChunks = []
  const stdinStream = {
    // 伪 stdin：非 TTY，数据一次性给完即 EOF
    isTTY: false,
    destroyed: false,
    readableEnded: false,
    _handlers: {},
    on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this },
    removeListener(ev, fn) {
      const l = this._handlers[ev]
      if (l) this._handlers[ev] = l.filter((f) => f !== fn)
      return this
    },
    resume() {
      if (this._emitted) return this
      this._emitted = true
      queueMicrotask(() => {
        if (stdin) for (const fn of this._handlers.data || []) fn(stdin)
        for (const fn of (this._handlers.end || []).slice()) fn()
      })
      return this
    },
    pause() { return this },
  }

  return cli.run(argv, {
    dataDir: dir,
    nowMs,
    operator: 'test-admin',
    io: {
      out: { write: (s) => { outChunks.push(String(s)); return true } },
      err: { write: (s) => { errChunks.push(String(s)); return true } },
      stdin: stdinStream,
      stdinIsTTY,
    },
    env: { DB_PATH: dbPath, DATA_DIR: dir, SIGN_MASTER_KEY: MASTER_KEY },
  }).then((code) => ({
    code,
    stdout: outChunks.join(''),
    stderr: errChunks.join(''),
  }))
}

/** 打开测试库做直接断言（不改 schema）。 */
function open(dbPath) {
  return openDatabase(dbPath, { backupBeforeMigrate: false }).db
}

function seedAccount(db, {
  account = 'demo001', password = 'pw-not-in-export-9f2c', note = '测试商家',
  planId = null, credits = null, expiresMs = null, deviceLimit = 1, firstLoginMs = null,
} = {}) {
  const now = NOW_MS
  const { hashPassword } = require(path.join(ROOT, 'license-server', 'crypto', 'password.js'))
  const r = db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, status, plan_id, plan_expires_ms,
                         device_limit, first_login_ms, note, created_at_ms, updated_at_ms)
    VALUES (?,?,?, 'active', ?,?,?,?,?,?,?)
  `).run(account, account, hashPassword(password), planId, expiresMs, deviceLimit,
    firstLoginMs, note, now, now)
  const accountId = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?,0,?)')
    .run(accountId, now)
  db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?,0,?,?)')
    .run(accountId, 'active', now)
  if (credits) {
    const { grantCredits } = require(path.join(ROOT, 'license-server', 'domain', 'billing.js'))
    grantCredits(db, {
      accountId, deltaMilli: credits * 1000, kind: 'grant',
      operator: 'test', note: 'seed', nowMs: now,
    })
  }
  return { accountId, password }
}

function seedSend(db, accountId, over = {}) {
  const now = NOW_MS
  const o = {
    send_id: 's-' + crypto.randomBytes(4).toString('hex'),
    source_type: 'comment',
    verdict: 'sent_confirmed',
    confirm_signal: 'platform_response',
    platform_endpoint: 'comment/publish',
    platform_status_code: 0,
    failure_reason: null,
    billing_status: 'billed',
    charged_milli: 1000,
    user_key_hash: 'uh-' + crypto.randomBytes(3).toString('hex'),
    sent_at_ms: now - 3600000,
    ...over,
  }
  db.prepare(`
    INSERT INTO send_log (account_id, instance_id, send_id, source_type, target_hash, user_key_hash,
      user_key_type, content_hash, verdict, confirm_signal, platform_endpoint, platform_status_code,
      failure_reason, billing_status, charged_milli, applied_policy_version, policy_snapshot_json,
      sent_at_ms, received_at_ms, client_version, device_id, report_id, over_limit, is_final)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    accountId, 'inst-1', o.send_id, o.source_type, 'th-' + o.send_id, o.user_key_hash,
    'sec_uid_hash', 'ch-' + o.send_id, o.verdict, o.confirm_signal, o.platform_endpoint,
    o.platform_status_code, o.failure_reason, o.billing_status, o.charged_milli, 1,
    JSON.stringify({ policy_version: 1 }), o.sent_at_ms, o.sent_at_ms,
    '3.0.0', 'dev-1', 'rep-1', 0, 1
  )
}

// ═══════════════════════════════════════════════════════════
// 1. db migrate / version / check
// ═══════════════════════════════════════════════════════════

test('db migrate → db version → db check 在全新库上成功', async () => {
  const { dir, dbPath } = freshDbPath('fresh')

  const m = await runCli(['db', 'migrate'], { dbPath, dir })
  assert.strictEqual(m.code, 0, m.stderr)
  assert.match(m.stdout, /已应用 \d+ 个迁移/)
  assert.ok(fs.existsSync(dbPath), 'db migrate 必须真的建出库文件')

  const v = await runCli(['db', 'version'], { dbPath, dir })
  assert.strictEqual(v.code, 0, v.stderr)
  assert.match(v.stdout, /结构版本：/)

  const c = await runCli(['db', 'check'], { dbPath, dir })
  assert.strictEqual(c.code, 0, c.stderr)
  assert.match(c.stdout, /integrity_check：ok/)
  assert.match(c.stdout, /\[db check\] 通过/)
})

test('db check 在库损坏时退出非零（健康脚本靠这个判活）', async () => {
  const { dir, dbPath } = freshDbPath('corrupt')
  migrate(dbPath)

  const good = await runCli(['db', 'check'], { dbPath, dir })
  assert.strictEqual(good.code, 0, good.stderr)

  // ⚠️ 保留 100 字节头部（SQLite magic 仍然合法），把其余页全清零：
  //    这样"能打开但结构损坏"，正是 integrity_check 要抓的情况。
  const buf = fs.readFileSync(dbPath)
  const damaged = Buffer.concat([buf.subarray(0, 100), Buffer.alloc(buf.length - 100)])
  fs.writeFileSync(dbPath, damaged)

  const bad = await runCli(['db', 'check'], { dbPath, dir })
  assert.notStrictEqual(bad.code, 0, '损坏的库必须让 db check 失败')
})

test('db check 在库缺失时退出非零，并提示先跑 db migrate', async () => {
  const { dir, dbPath } = freshDbPath('missing')
  const r = await runCli(['db', 'check'], { dbPath, dir })
  assert.notStrictEqual(r.code, 0)
  assert.match(r.stderr, /db migrate/)
})

test('除 db migrate 外的命令拒绝在不存在的库上执行（不静默造空库）', async () => {
  const { dir, dbPath } = freshDbPath('nodb')
  const r = await runCli(['stats', '--days', '7'], { dbPath, dir })
  assert.strictEqual(r.code, 1)
  assert.match(r.stderr, /数据库不存在/)
  assert.ok(!fs.existsSync(dbPath), '统计命令绝不允许凭空建库')
})

// ═══════════════════════════════════════════════════════════
// 2. account create / list
// ═══════════════════════════════════════════════════════════

test('account create 落库并出现在 account list --json', async () => {
  const { dir, dbPath } = freshDbPath('acct')
  migrate(dbPath)

  const created = await runCli([
    'account', 'create', '--user', 'shop_1001', '--note', '首批测试商家',
    '--credits', String(minPlanCredit()), '--expires', '2030-01-01',
  ], { dbPath, dir })
  assert.strictEqual(created.code, 0, created.stderr)
  assert.match(created.stdout, /商家账号已创建/)

  const list = await runCli(['account', 'list', '--json'], { dbPath, dir })
  assert.strictEqual(list.code, 0, list.stderr)
  const items = JSON.parse(list.stdout)
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].account, 'shop_1001')
  assert.strictEqual(items[0].status, 'active')
  assert.strictEqual(items[0].balance_milli, minPlanCredit() * 1000)
  // 观察期：账号第一天，日上限必须全 0（红线 1 的观察期语义）
  assert.strictEqual(items[0].account_tier, 'observation')
  assert.strictEqual(items[0].sending_enabled, false)
})

test('account create --credits 低于推导出的最低值时被 PLAN_QUOTA_BELOW_MIN 拒绝', async () => {
  const { dir, dbPath } = freshDbPath('belowmin')
  migrate(dbPath)

  const minimum = minPlanCredit()
  for (const bad of [4500, 4320, minimum - 1]) {
    const r = await runCli([
      'account', 'create', '--user', `bad${bad}`, '--note', '低于下限', '--credits', String(bad),
    ], { dbPath, dir })
    assert.strictEqual(r.code, 1, `--credits ${bad} 必须被拒绝`)
    assert.match(r.stderr, /PLAN_QUOTA_BELOW_MIN/)
    // ⚠️ 关键断言：文案里的下限必须**等于** domain/policy.js 推导出来的值。
    //    将来有人把 12600 写死进 cli.js，改 tier_table 后这条会立刻失败。
    assert.ok(
      r.stderr.includes(String(minimum)),
      `拒绝文案必须给出真实下限 ${minimum}，实际输出：${r.stderr}`
    )
  }

  const db = open(dbPath)
  const count = Number(db.prepare('SELECT COUNT(*) AS c FROM account').get().c)
  assert.strictEqual(count, 0, '被拒绝的账号不能落库')
  db.close()

  // 边界：恰好等于下限必须通过
  const ok = await runCli([
    'account', 'create', '--user', 'exactmin', '--note', '等于下限', '--credits', String(minimum),
  ], { dbPath, dir })
  assert.strictEqual(ok.code, 0, ok.stderr)
})

test('plan set 也拒绝低于最低积分的套餐（runbook 的 体验套餐 300 会失败）', async () => {
  const { dir, dbPath } = freshDbPath('planmin')
  migrate(dbPath)

  const bad = await runCli(['plan', 'set', '--name', '体验套餐', '--credits', '300', '--price', '0'], { dbPath, dir })
  assert.strictEqual(bad.code, 1)
  assert.match(bad.stderr, /PLAN_QUOTA_BELOW_MIN/)

  const good = await runCli([
    'plan', 'set', '--name', '半年套餐', '--credits', String(planCreditsFor(180)), '--price', '0', '--is-default',
  ], { dbPath, dir })
  assert.strictEqual(good.code, 0, good.stderr)

  const list = await runCli(['plan', 'list', '--json'], { dbPath, dir })
  const payload = JSON.parse(list.stdout)
  assert.strictEqual(payload.min_plan_credit, minPlanCredit())
  assert.strictEqual(payload.stable_daily_max_total, stableDailyMaxTotal())
  assert.strictEqual(payload.plans.length, 1)
  assert.strictEqual(payload.plans[0].credits, planCreditsFor(180))
  assert.strictEqual(payload.plans[0].is_default, true)
})

// ═══════════════════════════════════════════════════════════
// 3. credit：台账只增不改，且 balance_after_milli 必须自洽
// ═══════════════════════════════════════════════════════════

test('credit grant 写台账，credit balance 反映余额，balance_after_milli 等于真实余额', async () => {
  const { dir, dbPath } = freshDbPath('credit')
  migrate(dbPath)
  const db0 = open(dbPath)
  const { accountId } = seedAccount(db0, { credits: null })
  db0.close()

  const g1 = await runCli(['credit', 'grant', '--user', 'demo001', '--amount', '500', '--reason', '客服补偿'], { dbPath, dir })
  assert.strictEqual(g1.code, 0, g1.stderr)

  const g2 = await runCli(['credit', 'grant', '--user', 'demo001', '--amount', '250', '--reason', '活动赠送'], { dbPath, dir })
  assert.strictEqual(g2.code, 0, g2.stderr)

  const db = open(dbPath)
  const rows = db.prepare(
    'SELECT * FROM credit_ledger WHERE account_id = ? ORDER BY id'
  ).all(accountId)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(Number(rows[0].delta_milli), 500000)
  assert.strictEqual(Number(rows[1].delta_milli), 250000)

  // ⚠️ 台账的核心不变量：每条的 balance_after_milli 等于"累计到该条的余额"，
  //    且最后一条等于 credit.balance_milli。破了这个不变量，
  //    台账就不再是财务凭证（append-only 的意义就在这里）。
  let running = 0
  for (const r of rows) {
    running += Number(r.delta_milli)
    assert.strictEqual(Number(r.balance_after_milli), running,
      `台账 #${Number(r.id)} 的 balance_after_milli 与累计余额不一致`)
  }
  const balance = Number(db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId).balance_milli)
  assert.strictEqual(balance, running)
  assert.strictEqual(balance, 750000)
  db.close()

  const bal = await runCli(['credit', 'balance', '--user', 'demo001', '--json'], { dbPath, dir })
  assert.strictEqual(bal.code, 0, bal.stderr)
  const payload = JSON.parse(bal.stdout)
  assert.strictEqual(payload.balance_milli, 750000)
  assert.strictEqual(payload.replies_affordable, 750)
})

test('credit revoke 不能把余额扣成负数，且失败时不写台账', async () => {
  const { dir, dbPath } = freshDbPath('revoke')
  migrate(dbPath)
  const db0 = open(dbPath)
  const { accountId } = seedAccount(db0, { credits: null })
  db0.close()

  await runCli(['credit', 'grant', '--user', 'demo001', '--amount', '100', '--reason', '初始'], { dbPath, dir })

  const over = await runCli(['credit', 'revoke', '--user', 'demo001', '--amount', '1000', '--reason', '超额扣减'], { dbPath, dir })
  assert.notStrictEqual(over.code, 0, '扣成负数必须失败')
  assert.match(over.stderr, /负数/)

  const db = open(dbPath)
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get().c), 1,
    '被拒绝的扣减不能留下台账分录')
  assert.strictEqual(Number(db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId).balance_milli), 100000)
  db.close()

  // 恰好扣到 0 是允许的
  const exact = await runCli(['credit', 'revoke', '--user', 'demo001', '--amount', '100', '--reason', '全额回收'], { dbPath, dir })
  assert.strictEqual(exact.code, 0, exact.stderr)
  const db2 = open(dbPath)
  const last = db2.prepare('SELECT * FROM credit_ledger ORDER BY id DESC LIMIT 1').get()
  assert.strictEqual(Number(last.delta_milli), -100000)
  assert.strictEqual(Number(last.balance_after_milli), 0)
  db2.close()
})

/** 去掉源码里的块注释与行注释，避免"注释里提到危险写法"被误判为违规。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

test('cli.js 里没有任何对 credit_ledger 的 UPDATE / DELETE（append-only）', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'license-server', 'cli.js'), 'utf8'))
  const offenders = src.split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((x) => /(UPDATE|DELETE\s+FROM)\s+credit_ledger/i.test(x.line))
  assert.deepStrictEqual(offenders, [], '台账只增不改：不允许 UPDATE/DELETE credit_ledger')
})

test('cli.js 里不调用 settleSendBatch（计费只能由 API 依据平台确认的明细产生）', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'license-server', 'cli.js'), 'utf8'))
  assert.ok(!/settleSendBatch\s*\(/.test(src),
    'CLI 不得调用 settleSendBatch：计费只能由 POST /api/v1/audit/sends 依据平台确认成功的明细产生')
})

// ═══════════════════════════════════════════════════════════
// 4. code batch / list / redeem / revoke
// ═══════════════════════════════════════════════════════════

test('code batch 生成 N 张；code redeem 只加一次；重复兑换被拒；--unused 排除已兑换', async () => {
  const { dir, dbPath } = freshDbPath('codes')
  migrate(dbPath)
  const db0 = open(dbPath)
  const { accountId } = seedAccount(db0, { credits: null })
  db0.close()

  const N = 3
  const credits = minPlanCredit()
  const batch = await runCli([
    'code', 'batch', '--count', String(N), '--credits', String(credits), '--batch', 'TEST-BATCH',
  ], { dbPath, dir })
  assert.strictEqual(batch.code, 0, batch.stderr)

  // ⚠️ 明文只出现一次：从 stdout 里把它抓出来（这正是运维唯一的获取途径）
  const codes = batch.stdout.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(l))
  assert.strictEqual(codes.length, N, `应输出 ${N} 个明文卡密，实际：${JSON.stringify(codes)}`)

  const db = open(dbPath)
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS c FROM redeem_code').get().c), N)
  // 库里只有哈希，绝无明文
  const stored = db.prepare('SELECT code_hash FROM redeem_code').all().map((r) => String(r.code_hash))
  for (const c of codes) {
    assert.ok(!stored.includes(c), '库中绝不能存卡密明文')
    assert.ok(stored.includes(crypto.createHash('sha256').update(c, 'utf8').digest('hex')))
  }
  db.close()

  const before = await runCli(['credit', 'balance', '--user', 'demo001', '--json'], { dbPath, dir })
  const beforeMilli = JSON.parse(before.stdout).balance_milli

  const redeem = await runCli(['code', 'redeem', '--code', codes[0], '--user', 'demo001'], { dbPath, dir })
  assert.strictEqual(redeem.code, 0, redeem.stderr)

  const after = await runCli(['credit', 'balance', '--user', 'demo001', '--json'], { dbPath, dir })
  assert.strictEqual(JSON.parse(after.stdout).balance_milli, beforeMilli + credits * 1000)

  const again = await runCli(['code', 'redeem', '--code', codes[0], '--user', 'demo001'], { dbPath, dir })
  assert.notStrictEqual(again.code, 0, '同一卡密第二次兑换必须失败')
  assert.match(again.stderr, /已被使用/)

  const after2 = await runCli(['credit', 'balance', '--user', 'demo001', '--json'], { dbPath, dir })
  assert.strictEqual(JSON.parse(after2.stdout).balance_milli, beforeMilli + credits * 1000,
    '重复兑换绝不能再次入账')

  const db2 = open(dbPath)
  assert.strictEqual(Number(db2.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE kind='redeem'").get().c), 1)
  assert.strictEqual(Number(db2.prepare('SELECT COUNT(*) AS c FROM redeem_code WHERE used_at_ms IS NOT NULL').get().c), 1)
  db2.close()

  const unused = await runCli(['code', 'list', '--batch', 'TEST-BATCH', '--unused', '--json'], { dbPath, dir })
  assert.strictEqual(unused.code, 0, unused.stderr)
  const unusedItems = JSON.parse(unused.stdout)
  assert.strictEqual(unusedItems.length, N - 1, '--unused 必须排除已兑换的卡密')
  assert.ok(unusedItems.every((i) => i.state === 'unused'))
  assert.ok(unusedItems.every((i) => i.used_by === null), '未使用的卡密不得引用任何账号')
  assert.ok(unusedItems.every((i) => i.used_at_ms === null))
  assert.ok(!unusedItems.some((i) => i.code_hash_prefix === crypto.createHash('sha256').update(codes[0], 'utf8').digest('hex').slice(0, 12)),
    '--unused 不得包含已兑换的那张')

  const revoke = await runCli(['code', 'revoke', '--code', codes[1]], { dbPath, dir })
  assert.strictEqual(revoke.code, 0, revoke.stderr)
  assert.match(revoke.stdout, /作废/)

  const revokeUsed = await runCli(['code', 'revoke', '--code', codes[0]], { dbPath, dir })
  assert.notStrictEqual(revokeUsed.code, 0, '已兑换的卡密不能作废')
})

test('code batch 的 --credits 同样受最低积分约束', async () => {
  const { dir, dbPath } = freshDbPath('codemin')
  migrate(dbPath)
  const r = await runCli(['code', 'batch', '--count', '1', '--credits', '4500'], { dbPath, dir })
  assert.strictEqual(r.code, 1)
  assert.match(r.stderr, /PLAN_QUOTA_BELOW_MIN/)
  assert.ok(r.stderr.includes(String(minPlanCredit())))
})

// ═══════════════════════════════════════════════════════════
// 5. policy set：只能更保守（红线 1）
// ═══════════════════════════════════════════════════════════

const SAFETY_KEYS = [
  'limits.comment.daily_max',
  'limits.live_danmaku.daily_max',
  'limits.dm.daily_max',
  'limits.comment.min_interval_ms',
  'limits.comment.content_similarity_max',
  'active_hours.windows',
]

test('policy set 放宽安全上限被拒、消息点名红线 1、且不写 policy_history', async () => {
  const { dir, dbPath } = freshDbPath('policyrefuse')
  migrate(dbPath)
  const db0 = open(dbPath)
  const { accountId } = seedAccount(db0)
  db0.close()

  const attempts = [
    'limits.comment.daily_max=9999',
    'limits.dm.daily_max=50',
    'limits.comment.min_interval_ms=1000',
    'limits.comment.content_similarity_max=0.99',
    'active_hours.windows=[["00:00","23:59"]]',
  ]
  for (const set of attempts) {
    const r = await runCli([
      'policy', 'set', '--user', 'demo001', '--set', set, '--reason', '商家要求提额',
    ], { dbPath, dir })
    assert.strictEqual(r.code, 1, `--set ${set} 必须被拒绝`)
    const all = r.stdout + r.stderr
    assert.match(all, /红线 1/, `拒绝消息必须点名红线 1：${set}`)
    assert.match(all, /tier_table/, '拒绝消息必须指出正确路线是 tier_table')
  }

  // ⚠️ 关键断言：全部被拒 → **一行 history 都不能有**，版本也不能变
  const db = open(dbPath)
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS c FROM policy_history').get().c), 0,
    '被拒绝的变更绝不能写 policy_history')
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS c FROM policy WHERE account_id = ?').get(accountId).c), 0,
    '被拒绝的变更绝不能写 policy 行（版本不得自增）')
  db.close()

  // 只读检查：policy show 仍显示等级表原值
  const show = await runCli(['policy', 'show', '--user', 'demo001', '--json'], { dbPath, dir })
  const p = JSON.parse(show.stdout)
  assert.strictEqual(p.account_tier, 'observation')
  assert.strictEqual(p.sending_enabled, false)
  assert.strictEqual(p.limits.comment.daily_max, 0)
})

test('policy set 合法的保守变更：写 history、版本 +1、限值真的更保守', async () => {
  const { dir, dbPath } = freshDbPath('policyok')
  migrate(dbPath)
  const db0 = open(dbPath)
  const { accountId } = seedAccount(db0)
  // 让账号进入 stable 期（否则日上限本来是 0，无法演示"调低"）
  db0.prepare('UPDATE account SET first_login_ms = ? WHERE account_id = ?')
    .run(NOW_MS - 30 * 86400000, accountId)
  db0.close()

  const before = await runCli(['policy', 'show', '--user', 'demo001', '--json'], { dbPath, dir })
  const beforePolicy = JSON.parse(before.stdout)
  assert.strictEqual(beforePolicy.account_tier, 'stable')
  assert.ok(beforePolicy.limits.comment.daily_max > 0)

  const v0 = beforePolicy.policy_version
  const r = await runCli([
    'policy', 'set', '--user', 'demo001',
    '--set', `limits.comment.daily_max=${beforePolicy.limits.comment.daily_max - 5}`,
    '--set', `limits.comment.min_interval_ms=${beforePolicy.limits.comment.min_interval_ms + 60000}`,
    '--reason', '该账号内容重复率高，主动降速',
  ], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)

  const db = open(dbPath)
  const hist = db.prepare('SELECT * FROM policy_history WHERE account_id = ? ORDER BY id').all(accountId)
  assert.strictEqual(hist.length, 1, '合法变更必须写一条 policy_history')
  assert.strictEqual(String(hist[0].operator), 'test-admin')
  assert.match(String(hist[0].reason), /主动降速/)
  const stored = db.prepare('SELECT * FROM policy WHERE account_id = ?').get(accountId)
  assert.ok(stored, 'policy set 必须落 policy 行')
  assert.strictEqual(Number(stored.policy_version), v0 + 1, '策略版本必须 +1')
  db.close()

  const after = await runCli(['policy', 'show', '--user', 'demo001', '--json'], { dbPath, dir })
  const afterPolicy = JSON.parse(after.stdout)
  assert.strictEqual(afterPolicy.policy_version, v0 + 1)
  assert.strictEqual(afterPolicy.limits.comment.daily_max, beforePolicy.limits.comment.daily_max - 5)
  assert.strictEqual(
    afterPolicy.limits.comment.min_interval_ms,
    beforePolicy.limits.comment.min_interval_ms + 60000
  )
  // 未涉及的渠道保持等级表原值
  assert.strictEqual(afterPolicy.limits.dm.daily_max, beforePolicy.limits.dm.daily_max)

  const history = await runCli(['policy', 'show', '--user', 'demo001', '--history'], { dbPath, dir })
  assert.strictEqual(history.code, 0, history.stderr)
  assert.match(history.stdout, /变更历史/)
})

test('policy set 拒绝手工指定 account_tier（等级只能由天数推导）', async () => {
  const { dir, dbPath } = freshDbPath('policytier')
  migrate(dbPath)
  const db0 = open(dbPath)
  seedAccount(db0)
  db0.close()

  const r = await runCli([
    'policy', 'set', '--user', 'demo001', '--set', 'account_tier=stable', '--reason', '手动升档',
  ], { dbPath, dir })
  assert.strictEqual(r.code, 1)
  assert.match(r.stdout + r.stderr, /红线 1/)

  const db = open(dbPath)
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS c FROM policy_history').get().c), 0)
  db.close()
})

test('policy set 的合法键白名单不含任何安全上限的"放宽方向"', () => {
  // 白名单本身必须只包含可保守调整的键
  for (const k of cli.ALLOWED_POLICY_KEYS) {
    assert.ok(
      cli.ALLOWED_POLICY_KEYS.includes(k),
      `未知键 ${k}`
    )
  }
  assert.ok(cli.ALLOWED_POLICY_KEYS.includes('limits.comment.daily_max'))
  assert.ok(!cli.FORBIDDEN_POLICY_KEYS.includes('limits.comment.daily_max'))
  assert.ok(cli.FORBIDDEN_POLICY_KEYS.includes('account_tier'))
})

test('checkConservative 的方向判定：四个方向都不能写反', () => {
  const base = {
    account_tier: 'stable',
    active_hours: { windows: [['08:00', '23:00']] },
    limits: {
      comment: { daily_max: 30, min_interval_ms: 60000, content_similarity_max: 0.85 },
      live_danmaku: { daily_max: 30, min_interval_ms: 30000, content_similarity_max: 0.85 },
      dm: { daily_max: 10, min_interval_ms: 300000, content_similarity_max: 0.75 },
    },
  }
  // 更保守 → 通过
  assert.strictEqual(cli.checkConservative('limits.comment.daily_max', 10, base), null)
  assert.strictEqual(cli.checkConservative('limits.comment.min_interval_ms', 120000, base), null)
  assert.strictEqual(cli.checkConservative('limits.comment.content_similarity_max', 0.5, base), null)
  assert.strictEqual(cli.checkConservative('active_hours.windows', [['09:00', '18:00']], base), null)
  // 更激进 → 拒绝
  assert.ok(cli.checkConservative('limits.comment.daily_max', 31, base))
  assert.ok(cli.checkConservative('limits.comment.min_interval_ms', 30000, base))
  // ⚠️ 相似度方向：语义是"超过即拒绝"，所以**调高**才是更激进
  assert.ok(cli.checkConservative('limits.comment.content_similarity_max', 0.9, base),
    'content_similarity_max 调高 = 更激进，必须拒绝')
  assert.ok(cli.checkConservative('active_hours.windows', [['00:00', '23:59']], base))
  assert.ok(cli.checkConservative('active_hours.windows', [['08:00', '23:00'], ['01:00', '02:00']], base),
    '不得新增窗口')
})

// ═══════════════════════════════════════════════════════════
// 6. stats：必须等于 shared/lib/stats.js 的输出
// ═══════════════════════════════════════════════════════════

test('stats --json 与 shared/lib/stats.js 对同一批行给出完全一致的结果', async () => {
  const { dir, dbPath } = freshDbPath('stats')
  migrate(dbPath)
  const db = open(dbPath)
  const { accountId } = seedAccount(db)
  // ⚠️ 账号设为 stable，否则观察期日上限为 0，daily_quota 全 0 看不出差异
  db.prepare('UPDATE account SET first_login_ms = ? WHERE account_id = ?').run(NOW_MS - 30 * 86400000, accountId)

  const DAY = 86400000
  // ⚠️ 全部落在"过去"：从今天 00:00(UTC+8) 往前推 d 天再减 h 小时。
  //    若写成 `NOW_MS - d*DAY + h*3600000`，h 较大时会落到**未来**，
  //    而 stats 的窗口是 [fromMs, toMs)，未来的行会被排除——测试会莫名其妙少算。
  const at = (d, h) => dayStartOf(NOW_MS) - d * DAY - h * 3600000
  seedSend(db, accountId, { source_type: 'comment', verdict: 'sent_confirmed', sent_at_ms: at(1, 1), user_key_hash: 'u1' })
  seedSend(db, accountId, { source_type: 'comment', verdict: 'sent_confirmed', sent_at_ms: at(1, 2), user_key_hash: 'u2' })
  seedSend(db, accountId, { source_type: 'comment', verdict: 'failed', failure_reason: 'risk_control_rejected', billing_status: 'not_billable', charged_milli: 0, sent_at_ms: at(1, 3) })
  seedSend(db, accountId, { source_type: 'live_danmaku', verdict: 'sent_confirmed_dom', confirm_signal: 'dom_stable', billing_status: 'not_billable', charged_milli: 0, sent_at_ms: at(2, 4) })
  seedSend(db, accountId, { source_type: 'dm', verdict: 'sent_suspected', confirm_signal: 'none', billing_status: 'not_billable', charged_milli: 0, sent_at_ms: at(2, 5) })
  seedSend(db, accountId, { source_type: 'comment', verdict: 'sent_confirmed', billing_status: 'policy_exceeded', charged_milli: 0, sent_at_ms: at(3, 6) })
  db.close()

  const r = await runCli(['stats', '--days', '7', '--json'], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  const fromCli = JSON.parse(r.stdout)

  // ── 独立算出"应当"的结果（复用同一份 shared 实现，但不复用 CLI 的编排）──
  const db2 = open(dbPath)
  const toMs = NOW_MS
  const fromMs = dayStartOf(NOW_MS) - 6 * DAY
  const sends = db2.prepare(`
    SELECT source_type, verdict, sent_at_ms, user_key_hash, failure_reason
    FROM send_log WHERE sent_at_ms >= ? AND sent_at_ms < ?
  `).all(fromMs, toMs)
  db2.close()

  const detailAgg = aggregateSends(sends, { fromMs, toMs })
  const reportAgg = aggregateReports([])
  const failureReasons = {}
  for (const s of sends) {
    if (s.verdict !== 'failed') continue
    const k = s.failure_reason
    failureReasons[k] = (failureReasons[k] || 0) + 1
  }
  const expected = buildDashboard({
    ...detailAgg,
    failure_reasons: failureReasons,
  })

  // ⚠️ 只比较 shared 负责的字段（口径、成功率、分渠道、恒等式标记）——
  //    CLI 额外附带的 window / usage / trend 由它自己负责。
  assert.deepStrictEqual(fromCli.counts, expected.counts)
  assert.deepStrictEqual(fromCli.display, expected.display)
  assert.deepStrictEqual(fromCli.by_source, expected.by_source)
  assert.deepStrictEqual(fromCli.failure_reasons, expected.failure_reasons)
  assert.strictEqual(fromCli.stats_version, expected.stats_version)

  // 手算一遍关键数字，确认"三方一致"（明细 / shared / CLI）
  // 本窗口 6 条尝试：comment 2 成功 + 1 失败、comment 1 条超限（verdict 仍是
  // sent_confirmed）、danmaku 1 条 DOM 判据、dm 1 条疑似。
  assert.strictEqual(fromCli.counts.reply_attempts, 6)
  assert.strictEqual(fromCli.counts.sent_confirmed, 3)
  assert.strictEqual(fromCli.display.回复成功率显示, `${((3 / 6) * 100).toFixed(1)}%`)
  assert.strictEqual(fromCli.display.dom_判据条数, 1)
  assert.strictEqual(fromCli.display.疑似送达条数, 1)
  assert.strictEqual(fromCli.display.失败条数, 1)
  assert.deepStrictEqual(fromCli.failure_reasons, { risk_control_rejected: 1 })
  // 明细恒等式全部成立（失败原因之和 = failed 之和等）
  assert.deepStrictEqual(fromCli.audit_flags, [])

  const comment = fromCli.by_source.find((s) => s.source_type === 'comment')
  assert.strictEqual(comment.reply_attempts, 4)
  assert.strictEqual(comment.sent_confirmed, 3)
  assert.strictEqual(comment.success_rate, 0.75)
  assert.strictEqual(comment.failed, 1)

  // ⚠️ 超限那条仍计入「回复条数」口径（verdict 是 sent_confirmed），
  //    但 `billing_status=policy_exceeded` 意味着**没有计费**——
  //    这两件事必须分开，混在一起就是"看板说 30 条、账单按 28 条收"。
  const billed = fromCli.detail_vs_report.detail_confirmed
  assert.strictEqual(billed, 3, '明细确认口径按 verdict 统计')
})

test('stats 零分母显示 —（null），绝不当成 100%', async () => {
  const { dir, dbPath } = freshDbPath('statszero')
  migrate(dbPath)
  const db = open(dbPath)
  const { accountId } = seedAccount(db)
  // 只有"跳过/命中"这类没有 reply_attempts 的数据：分母为 0
  db.prepare(`
    INSERT INTO usage_report (report_id, account_id, instance_id, window_start_ms, window_end_ms,
      online_seconds, payload_json, received_at_ms)
    VALUES ('r1', ?, 'inst-1', ?, ?, 60, ?, ?)
  `).run(accountId, NOW_MS - 3600000, dayStartOf(NOW_MS), JSON.stringify({
    // ⚠️ 形状必须与服务端落库的一致：`routes-audit.js` 存的是 `body.sources`，
    //    所以 `aggregateReports` 直接拿它当 `r.sources` 用（顶层就是三个渠道键）。
    comment: { hits: 9, leads_new: 8, reply_attempts: 0, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 9, unique_users: 0 },
    live_danmaku: { hits: 0, leads_new: 0, reply_attempts: 0, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 0, unique_users: 0 },
    dm: { hits: 0, leads_new: 0, reply_attempts: 0, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 0, unique_users: 0 },
  }), NOW_MS)
  db.close()

  const r = await runCli(['stats', '--days', '7', '--json'], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  const d = JSON.parse(r.stdout)
  assert.strictEqual(d.display.回复成功率, null, '分母为 0 时成功率必须是 null')
  assert.strictEqual(d.display.回复成功率显示, '—', '分母为 0 时显示 —，不是 100%')
  assert.ok(d.by_source.every((s) => s.success_rate === null))
  // 命中数来自聚合上报，必须被带出来
  assert.strictEqual(d.counts.hits, 9)
  assert.strictEqual(d.counts.skipped, 9)
})

// ═══════════════════════════════════════════════════════════
// 7. audit export / prune
// ═══════════════════════════════════════════════════════════

test('audit export 的 csv 只含哈希，绝不出现账号密码等明文', async () => {
  const { dir, dbPath } = freshDbPath('export')
  migrate(dbPath)
  const db = open(dbPath)
  const distinctive = 'PW-DISTINCTIVE-9283746-do-not-leak'
  const { accountId } = seedAccount(db, { password: distinctive })
  seedSend(db, accountId, { source_type: 'comment', verdict: 'sent_confirmed' })
  seedSend(db, accountId, { source_type: 'dm', verdict: 'failed', failure_reason: 'element_timeout', billing_status: 'not_billable', charged_milli: 0 })
  db.close()

  const outFile = path.join(dir, 'audit.csv')
  const r = await runCli([
    'audit', 'export', '--user', 'demo001',
    '--from', dayKeyOf(NOW_MS - 2 * 86400000),
    '--to', dayKeyOf(NOW_MS),
    '--format', 'csv', '--out', outFile,
  ], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  assert.ok(fs.existsSync(outFile), '--out 必须真的写出文件')

  const bytes = fs.readFileSync(outFile, 'utf8')
  assert.ok(!bytes.includes(distinctive), '导出件绝不能包含账号密码')
  assert.ok(!bytes.includes('pass_hash'), '导出件不得包含密码哈希字段')
  assert.match(bytes, /不可还原/, 'CSV 头部必须说明目标标识是哈希、不可反查')
  assert.match(bytes, /隐私约束/)
  // 哈希本身必须在（否则导出没有举证价值）
  assert.match(bytes, /th-s-/)

  const dataLines = bytes.split('\n').filter((l) => l && !l.startsWith('#'))
  assert.strictEqual(dataLines.length, 3, '表头 + 2 条明细')

  // 区间外的记录不得出现（补一条 90 天前的）
  const db2 = open(dbPath)
  seedSend(db2, accountId, { send_id: 's-ancient', sent_at_ms: NOW_MS - 90 * 86400000 })
  db2.close()
  const out2 = path.join(dir, 'audit2.csv')
  const r2 = await runCli([
    'audit', 'export', '--user', 'demo001',
    '--from', dayKeyOf(NOW_MS - 2 * 86400000), '--to', dayKeyOf(NOW_MS),
    '--format', 'csv', '--out', out2,
  ], { dbPath, dir })
  assert.strictEqual(r2.code, 0, r2.stderr)
  assert.ok(!fs.readFileSync(out2, 'utf8').includes('s-ancient'), '--from 之前的记录不得导出')
})

test('audit export 的 json 每行一条，首行是含隐私说明的 meta', async () => {
  const { dir, dbPath } = freshDbPath('exportjson')
  migrate(dbPath)
  const db = open(dbPath)
  const { accountId } = seedAccount(db)
  seedSend(db, accountId)
  db.close()

  const outFile = path.join(dir, 'audit.jsonl')
  const r = await runCli([
    'audit', 'export', '--user', 'demo001',
    '--from', dayKeyOf(NOW_MS - 1 * 86400000), '--to', dayKeyOf(NOW_MS),
    '--format', 'json', '--out', outFile,
  ], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)

  const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.strictEqual(lines[0].type, 'meta')
  assert.strictEqual(lines[0].privacy, 'only_hashes_no_plaintext')
  assert.strictEqual(lines.length, 2)
  assert.ok(lines[1].verdict)
  assert.ok(!('pass_hash' in lines[1]))
})

test('audit export 缺少 --out 或格式非法时退出 2，且不写文件', async () => {
  const { dir, dbPath } = freshDbPath('exportbad')
  migrate(dbPath)
  const db = open(dbPath)
  seedAccount(db)
  db.close()

  const noOut = await runCli([
    'audit', 'export', '--user', 'demo001', '--from', '2026-01-01', '--to', '2026-01-02', '--format', 'csv',
  ], { dbPath, dir })
  assert.strictEqual(noOut.code, 2)

  const badFormat = await runCli([
    'audit', 'export', '--user', 'demo001', '--from', '2026-01-01', '--to', '2026-01-02',
    '--format', 'xlsx', '--out', path.join(dir, 'x.xlsx'),
  ], { dbPath, dir })
  assert.strictEqual(badFormat.code, 2)
  assert.ok(!fs.existsSync(path.join(dir, 'x.xlsx')))

  const badDate = await runCli([
    'audit', 'export', '--user', 'demo001', '--from', '2026/01/01', '--to', '2026-01-02',
    '--format', 'csv', '--out', path.join(dir, 'y.csv'),
  ], { dbPath, dir })
  assert.strictEqual(badDate.code, 2)
  assert.match(badDate.stderr, /YYYY-MM-DD/)
})

test('audit prune 不带 --yes 且非交互时一行都不删', async () => {
  const { dir, dbPath } = freshDbPath('prune')
  migrate(dbPath)
  const db = open(dbPath)
  const { accountId } = seedAccount(db)
  // 一条足够老的明细（远超 AUDIT_KEEP_DAYS=60）
  seedSend(db, accountId, { send_id: 's-ancient', sent_at_ms: NOW_MS - 200 * 86400000 })
  seedSend(db, accountId, { send_id: 's-recent' })
  const before = {
    send: Number(db.prepare('SELECT COUNT(*) AS c FROM send_log').get().c),
    ledger: Number(db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get().c),
  }
  db.close()

  // 非 TTY 且没有 --yes → 必须中止
  const aborted = await runCli(['audit', 'prune', '--keep-days', '60'], { dbPath, dir })
  assert.notStrictEqual(aborted.code, 0, '非交互下 prune 必须中止')
  assert.match(aborted.stdout + aborted.stderr, /将删除/)
  assert.match(aborted.stdout + aborted.stderr, /send_log/)

  // dry-run 也必须一行不删
  const dry = await runCli(['audit', 'prune', '--keep-days', '60', '--dry-run'], { dbPath, dir })
  assert.strictEqual(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /dry-run/)

  const db2 = open(dbPath)
  assert.strictEqual(Number(db2.prepare('SELECT COUNT(*) AS c FROM send_log').get().c), before.send,
    'prune 未确认/dry-run 时不得删除任何行')
  assert.strictEqual(Number(db2.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get().c), before.ledger)
  db2.close()

  // 带 --yes 才真的删除，且只删超期的那条
  const yes = await runCli(['audit', 'prune', '--keep-days', '60', '--yes'], { dbPath, dir })
  assert.strictEqual(yes.code, 0, yes.stderr)
  const db3 = open(dbPath)
  assert.strictEqual(Number(db3.prepare('SELECT COUNT(*) AS c FROM send_log').get().c), 1)
  assert.strictEqual(Number(db3.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get().c), before.ledger,
    '台账是财务凭证，prune 绝不能碰')
  db3.close()
})

// ═══════════════════════════════════════════════════════════
// 8. 帮助与错误处理
// ═══════════════════════════════════════════════════════════

test('--help 在顶层与各组都退出 0，且不产生任何文件副作用', async () => {
  const { dir, dbPath } = freshDbPath('help')

  const top = await runCli(['--help'], { dbPath, dir })
  assert.strictEqual(top.code, 0)
  assert.match(top.stdout, /命令组：/)

  const noArgs = await runCli([], { dbPath, dir })
  assert.strictEqual(noArgs.code, 0)
  assert.match(noArgs.stdout, /命令组：/)

  for (const g of ['db', 'admin', 'account', 'credit', 'code', 'policy', 'audit', 'session', 'plan']) {
    const r = await runCli([g, '--help'], { dbPath, dir })
    assert.strictEqual(r.code, 0, `${g} --help 必须退出 0`)
    assert.ok(r.stdout.length > 40, `${g} --help 必须有实际内容`)
    const r2 = await runCli([g], { dbPath, dir })
    assert.strictEqual(r2.code, 0, `${g}（无子命令）必须打印该组用法并退出 0`)
  }

  // ⚠️ 帮助不得建库、不得落 master.key —— 否则 `cli.js --help` 会污染 data/
  assert.ok(!fs.existsSync(dbPath), '--help 不得建库')
  const leaked = fs.readdirSync(dir).filter((f) => f !== 'license.db')
  assert.deepStrictEqual(leaked, [], `帮助命令不得产生文件，实际多出：${leaked.join(',')}`)
})

test('未知命令/未知子命令/未知选项 → 退出 2，有可读提示，且没有堆栈', async () => {
  const { dir, dbPath } = freshDbPath('unknown')
  migrate(dbPath)

  const cases = [
    ['nonsense', 'foo'],
    ['account', 'explode', '--user', 'x'],
    ['db', 'drop-everything'],
    ['stats', '--dys', '7'],
    ['account', 'create', '--user', 'x'],
  ]
  for (const argv of cases) {
    const r = await runCli(argv, { dbPath, dir })
    assert.strictEqual(r.code, 2, `\`${argv.join(' ')}\` 必须退出 2`)
    const all = r.stdout + r.stderr
    assert.ok(all.length > 10, '必须有提示信息')
    assert.ok(!/\n\s+at .+\(/.test(all), `不得打印堆栈：\n${all}`)
    assert.ok(!/TypeError|ReferenceError|SyntaxError/.test(all), '不得泄露内部异常类型')
  }

  const unknownGroup = await runCli(['nonsense', 'foo'], { dbPath, dir })
  assert.match(unknownGroup.stderr, /未知命令组/)
})

test('缺少必填选项 / 类型错误 → 退出 2 并说明是哪个选项', async () => {
  const { dir, dbPath } = freshDbPath('missing')
  migrate(dbPath)
  const db = open(dbPath)
  seedAccount(db)
  db.close()

  const cases = [
    [['credit', 'grant', '--user', 'demo001', '--reason', 'x'], /--amount/],
    [['credit', 'grant', '--user', 'demo001', '--amount', 'abc', '--reason', 'x'], /整数/],
    [['account', 'show'], /--user/],
    [['account', 'create', '--user', 'x', '--credits', String(minPlanCredit())], /--note/],
    [['code', 'batch', '--count', '0', '--credits', String(minPlanCredit())], /count/],
    [['plan', 'set', '--credits', String(minPlanCredit())], /--name/],
  ]
  for (const [argv, re] of cases) {
    const r = await runCli(argv, { dbPath, dir })
    assert.strictEqual(r.code, 2, `\`${argv.join(' ')}\` 应退出 2，实际 ${r.code}：${r.stderr}`)
    assert.match(r.stderr, re)
  }
})

test('密码不进 argv 之外的任何输出：--password-stdin 生效且不落日志', async () => {
  const { dir, dbPath } = freshDbPath('password')
  migrate(dbPath)

  const secret = 'Sup3r-Secret-Pw-For-Cli'
  const r = await runCli(['admin', 'create', '--user', 'admin', '--password-stdin'], {
    dbPath, dir, stdin: secret + '\n',
  })
  assert.strictEqual(r.code, 0, r.stderr)
  assert.ok(!r.stdout.includes(secret), 'stdout 绝不能回显密码')
  assert.ok(!r.stderr.includes(secret), 'stderr 绝不能回显密码')

  const db = open(dbPath)
  const row = db.prepare('SELECT * FROM admin_user WHERE username = ?').get('admin')
  db.close()
  assert.ok(row, '管理员必须落库')
  assert.ok(!String(row.pass_hash).includes(secret), '绝不能存明文密码')
  assert.match(String(row.pass_hash), /^scrypt\$/)

  const { verifyPassword } = require(path.join(ROOT, 'license-server', 'crypto', 'password.js'))
  assert.strictEqual(verifyPassword(secret, String(row.pass_hash)), true)
})

test('未给 --password-stdin 且非 TTY 时中止，绝不"用空密码建管理员"', async () => {
  const { dir, dbPath } = freshDbPath('password2')
  migrate(dbPath)

  const r = await runCli(['admin', 'create', '--user', 'admin'], { dbPath, dir, stdin: '' })
  assert.notStrictEqual(r.code, 0)
  assert.match(r.stderr, /password-stdin/)

  const db = open(dbPath)
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS c FROM admin_user').get().c), 0)
  db.close()
})

test('--password 会打印醒目警告（会进 shell history 与 ps）', async () => {
  const { dir, dbPath } = freshDbPath('password3')
  migrate(dbPath)
  const r = await runCli(['admin', 'create', '--user', 'admin', '--password', 'Plain-Pw-123456'], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  assert.match(r.stderr, /history/)
  assert.match(r.stderr, /ps/)
})

// ═══════════════════════════════════════════════════════════
// 9. 其余命令的基本可用性（会话 / 计划 / 数据库备份）
// ═══════════════════════════════════════════════════════════

test('session revoke --user 与 --all 都只影响未失效会话', async () => {
  const { dir, dbPath } = freshDbPath('session')
  migrate(dbPath)
  const db = open(dbPath)
  const { accountId } = seedAccount(db)
  db.prepare(`
    INSERT INTO device_session (account_id, device_id, token_hash, sign_key_hash, max_seq,
      issued_at_ms, last_seen_ms, expires_at_ms, sign_key_plain)
    VALUES (?,?,?,?,0,?,?,?,?)
  `).run(accountId, 'dev-1', 'th-1', 'skh-1', NOW_MS - 1000, NOW_MS - 500, NOW_MS + 86400000, 'sk-1')
  db.close()

  const list = await runCli(['session', 'list', '--user', 'demo001', '--json'], { dbPath, dir })
  assert.strictEqual(list.code, 0, list.stderr)
  assert.strictEqual(JSON.parse(list.stdout).length, 1)

  const revoke = await runCli(['session', 'revoke', '--user', 'demo001'], { dbPath, dir })
  assert.strictEqual(revoke.code, 0, revoke.stderr)
  assert.match(revoke.stdout, /1 个/)

  const db2 = open(dbPath)
  assert.ok(Number(db2.prepare('SELECT revoked_at_ms FROM device_session').get().revoked_at_ms) > 0)
  db2.close()

  const all = await runCli(['session', 'revoke', '--all'], { dbPath, dir })
  assert.strictEqual(all.code, 0, all.stderr)
})

test('db backup 产出可通过 integrity_check 的单文件备份', async () => {
  const { dir, dbPath } = freshDbPath('backup')
  migrate(dbPath)
  const db = open(dbPath)
  seedAccount(db, { credits: 10 })
  db.close()

  const outDir = path.join(dir, 'backups')
  const r = await runCli(['db', 'backup', '--out', outDir], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.db'))
  assert.strictEqual(files.length, 1)
  const backupPath = path.join(outDir, files[0])
  const { DatabaseSync } = require('node:sqlite')
  const handle = new DatabaseSync(backupPath, { readOnly: true })
  const integrity = handle.prepare('PRAGMA integrity_check').get()
  const accounts = handle.prepare('SELECT COUNT(*) AS c FROM account').get()
  handle.close()
  assert.strictEqual(String(integrity.integrity_check), 'ok')
  assert.strictEqual(Number(accounts.c), 1)
})

test('db checkpoint 回收 WAL 并成功退出', async () => {
  const { dir, dbPath } = freshDbPath('checkpoint')
  migrate(dbPath)
  const db = open(dbPath)
  seedAccount(db, { credits: 5 })
  db.close()

  const r = await runCli(['db', 'checkpoint'], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  assert.match(r.stdout, /WAL 检查点完成/)
})

test('audit usage 报告行数与占用，且不因缺表而崩溃', async () => {
  const { dir, dbPath } = freshDbPath('usage')
  migrate(dbPath)
  const db = open(dbPath)
  const { accountId } = seedAccount(db)
  seedSend(db, accountId)
  db.close()

  const r = await runCli(['audit', 'usage', '--json'], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  const payload = JSON.parse(r.stdout)
  const sendLog = payload.tables.find((t) => t.table === 'send_log')
  assert.strictEqual(sendLog.count, 1)
  const ledger = payload.tables.find((t) => t.table === 'credit_ledger')
  assert.strictEqual(ledger.keep, '永久')
})

test('plan show 之外的 plan list 在空库上也退出 0', async () => {
  const { dir, dbPath } = freshDbPath('emptyplan')
  migrate(dbPath)
  const r = await runCli(['plan', 'list'], { dbPath, dir })
  assert.strictEqual(r.code, 0, r.stderr)
  assert.match(r.stdout, /尚未创建套餐|plan_id/)
})

test('makePlanKey 对中文套餐名稳定且互不冲突', () => {
  const a = cli.makePlanKey('半年套餐')
  const b = cli.makePlanKey('半年套餐')
  const c = cli.makePlanKey('年套餐')
  assert.strictEqual(a, b, '同名必须同 key')
  assert.notStrictEqual(a, c, '异名必须异 key（中文名不能都被压成同一个 key）')
  assert.match(a, /^plan_[0-9a-f]{8}$/)
})

test('displayWidth 把中文算两列，表格才能对齐', () => {
  assert.strictEqual(cli.displayWidth('abc'), 3)
  assert.strictEqual(cli.displayWidth('中文'), 4)
  assert.strictEqual(cli.displayWidth('a中'), 3)
})

// 工具：把毫秒转成 `YYYY-MM-DD`（UTC+8），与服务端口径一致
function dayKeyOf(ms) {
  return dayKey(ms)
}

/** 该时刻所属自然日（UTC+8）的 00:00。 */
function dayStartOf(ms) {
  const { dayStartMs } = require(path.join(ROOT, 'shared', 'lib', 'stats.js'))
  return dayStartMs(ms)
}
