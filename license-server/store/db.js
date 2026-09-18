'use strict'

// license-server/store/db.js
//
// SQLite 连接与迁移执行器。
//
// ⚠️ 三条硬约束（违反会导致数据损坏或无法回滚）：
//
//   1. **迁移只做加法**（CREATE TABLE / ADD COLUMN / CREATE INDEX），
//      不删列不改类型。这样回滚到旧版本代码时旧代码仍能跑。
//   2. **迁移前必须备份**。迁移失败时靠备份恢复，不靠"再写一个反向迁移"。
//   3. **时间一律整数 Unix 毫秒**（`_ms` 后缀），**金额一律整数毫单位**
//      （`_milli` 后缀）。禁止用 TEXT 存时间、用 REAL 存金额——
//      浮点误差会让台账对不上（见 shared/开发规范.md §5）。

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/**
 * 打开（必要时创建）数据库，并执行未应用的迁移。
 *
 * @param {string} dbPath 数据库文件路径。传 ':memory:' 用于测试。
 * @param {object} [opts]
 * @param {boolean} [opts.backupBeforeMigrate=true] 迁移前是否备份
 * @param {boolean} [opts.verbose=false] 是否打印迁移日志
 * @returns {{ db: DatabaseSync, applied: string[], close: () => void }}
 */
function openDatabase(dbPath, opts = {}) {
  const backupBeforeMigrate = opts.backupBeforeMigrate !== false
  const verbose = opts.verbose === true
  const inMemory = dbPath === ':memory:'

  if (!inMemory) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }

  const db = new DatabaseSync(dbPath)
  applyPragmas(db)

  const applied = migrate(db, dbPath, { backupBeforeMigrate, verbose, inMemory })

  return {
    db,
    applied,
    close: () => db.close(),
  }
}

/**
 * 连接级 PRAGMA。
 *
 * synchronous=NORMAL 是 WAL 下的推荐值：崩溃时可能丢最后一个事务，
 * 但不会损坏数据库。对本项目可接受——权威数据在服务端，
 * 客户端丢了补报即可（`pending_sends.json` 会重发）。
 */
function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 8000')
  db.exec('PRAGMA wal_autocheckpoint = 4000')
  db.exec('PRAGMA journal_size_limit = 67108864')
}

/** 读取已应用的迁移版本列表。 */
function readAppliedMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version     TEXT PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL,
      checksum    TEXT NOT NULL
    )
  `)
  return db.prepare('SELECT version, checksum, applied_at_ms FROM schema_migration ORDER BY version').all()
}

/**
 * 按文件名升序执行未应用的迁移。
 *
 * 文件名约定：`NNN_<描述>.sql`，序号三位补零、严格递增。
 * ⚠️ 已发布的迁移文件**禁止修改**——修正必须新加一个文件。
 *    校验 checksum 就是为了尽早发现"偷偷改了已应用的迁移"。
 */
function migrate(db, dbPath, { backupBeforeMigrate, verbose, inMemory }) {
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : []

  const already = readAppliedMigrations(db)
  const appliedMap = new Map(already.map((r) => [r.version, r.checksum]))

  // 校验已应用迁移的 checksum 未被篡改
  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (!appliedMap.has(version)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    const checksum = checksumOf(sql)
    if (checksum !== appliedMap.get(version)) {
      throw new Error(
        `迁移文件 ${file} 已被修改（checksum 不一致）。\n` +
        `已发布的迁移禁止修改——请新加一个迁移文件来修正。`
      )
    }
  }

  const pending = files.filter((f) => !appliedMap.has(f.replace(/\.sql$/, '')))
  if (pending.length === 0) return []

  // ⚠️ 迁移前备份：失败时靠它恢复，不靠反向迁移
  if (backupBeforeMigrate && !inMemory && fs.existsSync(dbPath)) {
    backupDatabase(db, dbPath)
  }

  const applied = []
  for (const file of pending) {
    const version = file.replace(/\.sql$/, '')
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    const checksum = checksumOf(sql)

    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare(
        'INSERT INTO schema_migration (version, applied_at_ms, checksum) VALUES (?, ?, ?)'
      ).run(version, Date.now(), checksum)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 ${file} 失败，已回滚：${e.message}`)
    }

    applied.push(version)
    if (verbose) console.log(`[migrate] applied ${version}`)
  }

  return applied
}

/**
 * 在线备份。
 *
 * ⚠️ **禁止直接 cp 正在写入的 db 文件**——WAL 模式下主库文件不含最新数据，
 *    cp 出来的副本会缺数据甚至损坏。必须用 SQLite 自己的备份机制。
 *    `VACUUM INTO` 是内置且无需外部工具的方案。
 */
function backupDatabase(db, dbPath) {
  const dir = path.join(path.dirname(dbPath), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `pre-migrate-${stamp}.db`)
  // VACUUM INTO 的目标文件必须不存在
  if (fs.existsSync(target)) fs.rmSync(target)
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  return target
}

/** 迁移文件内容指纹。用于检测"已应用的迁移被偷改"。 */
function checksumOf(text) {
  const crypto = require('node:crypto')
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

module.exports = { openDatabase, backupDatabase, applyPragmas, MIGRATIONS_DIR }
