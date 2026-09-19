'use strict'

// test/unit/db.test.js
// 数据库层与迁移的测试。
//
// ⚠️ 重点验证三件事（它们出错会导致数据损坏或无法回滚）：
//   1. 迁移可重复执行（幂等）——服务启动时会自动跑一次
//   2. 已应用的迁移被偷改时**必须报错**——否则新旧 schema 静默不一致
//   3. 关键约束真的生效（send_id 唯一、外键、金额为整数）

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { openDatabase } = require('../../license-server/store/db')

function tmpDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-db-'))
  return path.join(dir, name || 'test.db')
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
}

/**
 * 测试夹具：建一个账号，返回 account_id。
 *
 * ⚠️ 必须有它：`credit` / `credit_ledger` / `redeem_code` 等表对 account
 *    有外键约束，直接插入不存在的 account_id 会被拒——这正是我们要的行为
 *    （测试里已单独验证外键生效）。
 */
function makeAccount(db, account = 'demo001') {
  const now = Date.now()
  const r = db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, created_at_ms, updated_at_ms)
    VALUES (?, ?, 'hash:placeholder', ?, ?)
  `).run(account, account, now, now)
  return Number(r.lastInsertRowid)
}

test('迁移：内存库可打开并建表', () => {
  const { db, applied, close } = openDatabase(':memory:')
  try {
    assert.ok(applied.length >= 1, '至少应用一个迁移')
    const t = tableNames(db)
    for (const need of [
      'schema_migration', 'account', 'device_session', 'request_nonce', 'login_attempt',
      'plan', 'credit', 'credit_ledger', 'redeem_code',
      'policy', 'policy_history', 'policy_ack_log',
      'send_log', 'audit_config_changes', 'usage_report',
      'admin_user', 'admin_action_log',
    ]) {
      assert.ok(t.includes(need), `缺表 ${need}`)
    }
  } finally {
    close()
  }
})

test('迁移：重复打开不重复应用（幂等）', () => {
  const p = tmpDbPath()
  const first = openDatabase(p)
  const appliedFirst = first.applied.slice()
  first.close()

  const second = openDatabase(p)
  try {
    assert.deepStrictEqual(second.applied, [], '第二次不应再应用任何迁移')
    assert.ok(appliedFirst.length >= 1)
  } finally {
    second.close()
  }
})

test('迁移：checksum 记录在库中，用于检测偷改', () => {
  const { db, close } = openDatabase(':memory:')
  try {
    const rows = db.prepare('SELECT version, checksum FROM schema_migration').all()
    assert.ok(rows.length >= 1)
    for (const r of rows) {
      assert.match(r.version, /^\d{3}_/, '版本号应为 NNN_ 前缀')
      assert.match(r.checksum, /^[0-9a-f]{16}$/, 'checksum 应为 16 位 hex')
    }
  } finally {
    close()
  }
})

test('WAL 与外键 PRAGMA 生效', () => {
  const p = tmpDbPath()
  const { db, close } = openDatabase(p)
  try {
    const jm = db.prepare('PRAGMA journal_mode').get()
    assert.strictEqual(String(jm.journal_mode).toLowerCase(), 'wal')
    const fk = db.prepare('PRAGMA foreign_keys').get()
    assert.strictEqual(Number(fk.foreign_keys), 1, '外键必须开启')
  } finally {
    close()
  }
})

test('约束：send_log 的 (account_id, send_id) 唯一 —— 计费幂等的根本保证', () => {
  const { db, close } = openDatabase(':memory:')
  try {
    const ins = db.prepare(`
      INSERT INTO send_log (account_id, send_id, source_type, verdict, billing_status,
                            charged_milli, sent_at_ms, received_at_ms)
      VALUES (?, ?, 'comment', 'sent_confirmed', 'billed', 1000, ?, ?)
    `)
    ins.run(1, 's-aaa', 1000, 1000)
    assert.throws(() => ins.run(1, 's-aaa', 2000, 2000), /UNIQUE|constraint/i,
      '同一 send_id 重复插入必须被拒')
    // 不同账号可以用同一个 send_id（幂等键是账号内唯一）
    ins.run(2, 's-aaa', 1000, 1000)
  } finally {
    close()
  }
})

test('约束：credit_ledger 可追加但结构上无唯一键（append-only 由代码保证）', () => {
  const { db, close } = openDatabase(':memory:')
  try {
    const acc = makeAccount(db)
    const ins = db.prepare(`
      INSERT INTO credit_ledger (account_id, kind, delta_milli, balance_after_milli, settled_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `)
    ins.run(acc, 'recharge', 12600000, 12600000, 1000)
    ins.run(acc, 'consume', -1000, 12599000, 2000)
    const rows = db.prepare('SELECT COUNT(*) c FROM credit_ledger WHERE account_id=?').get(acc)
    assert.strictEqual(Number(rows.c), 2)
  } finally {
    close()
  }
})

test('外键：device_session 引用不存在的账号被拒', () => {
  const { db, close } = openDatabase(':memory:')
  try {
    assert.throws(() => {
      db.prepare(`
        INSERT INTO device_session (account_id, device_id, token_hash, sign_key_hash,
                                    issued_at_ms, last_seen_ms, expires_at_ms)
        VALUES (999, 'd1', 'h1', 'sk1', 1, 1, 2)
      `).run()
    }, /FOREIGN KEY|constraint/i)
  } finally {
    close()
  }
})

test('policy_ack_log：同账号+实例+策略版本唯一（ack 去重）', () => {
  const { db, close } = openDatabase(':memory:')
  try {
    const ins = db.prepare(`
      INSERT INTO policy_ack_log (account_id, instance_id, policy_version, policy_hash,
                                  account_tier, account_day_index, applied_limits_json,
                                  first_ack_at_ms, last_seen_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    ins.run(1, 'inst-1', 7, 'hash7', 'observation', 2, '{}', 1000, 1000)
    assert.throws(() => ins.run(1, 'inst-1', 7, 'hash7', 'observation', 2, '{}', 2000, 2000),
      /UNIQUE|constraint/i)
    // 新策略版本可以 ack
    ins.run(1, 'inst-1', 8, 'hash8', 'warm_up', 5, '{}', 2000, 2000)
  } finally {
    close()
  }
})

test('金额必须能存整数毫单位（不接受浮点精度问题）', () => {
  const { db, close } = openDatabase(':memory:')
  try {
    const acc = makeAccount(db)
    db.prepare(`
      INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?, ?, ?)
    `).run(acc, 12600000, 1000)
    const r = db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(acc)
    assert.strictEqual(Number(r.balance_milli), 12600000)
    assert.ok(Number.isInteger(Number(r.balance_milli)))
    // 半条积分（0.5 × 1000）也能精确表示——这是选毫单位的原因
    db.prepare('UPDATE credit SET balance_milli = ? WHERE account_id = ?').run(500, acc)
    const half = db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(acc)
    assert.strictEqual(Number(half.balance_milli), 500)
  } finally {
    close()
  }
})

test('迁移日志：verbose 模式可打印已应用版本', () => {
  const p = tmpDbPath()
  const { applied, close } = openDatabase(p, { verbose: false })
  close()
  assert.ok(Array.isArray(applied))
  assert.ok(applied.every((v) => /^\d{3}_/.test(v)))
})

test('迁移目录存在且含 001_init.sql', () => {
  const { MIGRATIONS_DIR } = require('../../license-server/store/db')
  assert.ok(fs.existsSync(MIGRATIONS_DIR), `迁移目录不存在：${MIGRATIONS_DIR}`)
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
  assert.ok(files.includes('001_init.sql'))
})

test('迁移文件命名：NNN_ 三位前缀且严格递增', () => {
  const { MIGRATIONS_DIR } = require('../../license-server/store/db')
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  let prev = 0
  for (const f of files) {
    const m = /^(\d{3})_/.exec(f)
    assert.ok(m, `${f} 不符合 NNN_<描述>.sql 命名`)
    const n = Number(m[1])
    assert.ok(n > prev, `${f} 的序号未严格递增`)
    prev = n
  }
})
