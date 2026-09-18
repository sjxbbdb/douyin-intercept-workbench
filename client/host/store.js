'use strict'

// client/host/store.js
//
// 客户端存储：**单写者 + 原子写 + schemaVersion**。
//
// ⚠️ 这是全客户端唯一允许碰盘的地方（除日志）。
//    旧代码的核心缺陷就是"多个进程各自无锁全量覆写同一个 JSON"，
//    导致队列丢任务、配置回退（见 docs/需求规格.md 的 D-7）。
//    本模块用三条规则根治：
//
//      1. **单写者**：只有 host 主进程调用本模块。其他模块（browser-host、
//         adapters）不得直接读写文件，必须经 IPC。
//      2. **原子写**：写 `.tmp-<pid>` 再 rename。避免写入中断产生半截文件。
//      3. **读-改-写**：每次修改都重新读最新内容再改，**绝不用陈旧对象
//         全量覆盖**——那正是丢任务的原因。
//
// ⚠️ 为什么客户端用 JSON 而不用 SQLite：
//    数据量小、需要可读可调试、单机排障方便。而"单写者 + 原子写"
//    已经消除了并发问题，不需要数据库的事务能力。

const fs = require('node:fs')
const path = require('node:path')

/** 各文件的 schema 版本。升级时按需递增并写迁移逻辑。 */
const SCHEMA_VERSIONS = Object.freeze({
  'queue.json': 1,
  'pending-sends.json': 1,
  'replied-history.json': 1,
  'leads.json': 1,
  'stats.json': 1,
  'license-state.json': 1,
  'runtime-state.json': 1,
  'audit-log.jsonl': 1,
})

/**
 * 单写者守卫。
 *
 * ⚠️ 进程内记录"谁在用这个 store"。若检测到第二个实例（同进程内重复创建），
 *    说明有人绕过了约定——直接报错比静默双写安全。
 */
const openStores = new Set()

class Store {
  /**
   * @param {object} opts
   * @param {string} opts.dir 实例目录
   */
  constructor(opts) {
    if (!opts || !opts.dir) throw new Error('Store 需要 dir')
    this.dir = opts.dir
    this.tag = path.resolve(opts.dir)
    if (openStores.has(this.tag)) {
      throw new Error(
        `检测到同一实例目录被打开两次：${this.tag}\n` +
        `客户端的硬约束是**单写者**——只有 host 主进程可以碰盘。\n` +
        `若确需并发访问，请通过 IPC 请求 host，而不是各自打开 store。`
      )
    }
    openStores.add(this.tag)
    fs.mkdirSync(this.dir, { recursive: true })
  }

  close() {
    openStores.delete(this.tag)
  }

  file(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`非法文件名：${name}`)
    return path.join(this.dir, name)
  }

  /**
   * 原子写。
   *
   * ⚠️ 必须是"同目录下的临时文件 + rename"：
   *    跨盘 rename 会失败，且 rename 在同一文件系统内是原子操作。
   */
  writeAtomic(name, content) {
    const target = this.file(name)
    const tmp = `${target}.tmp-${process.pid}`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, content)
      // ⚠️ fsync 后再 rename：否则断电时可能 rename 成功但内容仍在页缓存
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
    return target
  }

  /** 读 JSON。文件不存在返回 fallback；内容损坏抛错（不静默返回默认值）。 */
  readJson(name, fallback) {
    const p = this.file(name)
    let raw
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return fallback
      // ⚠️ 不吞异常。旧代码用 try{}catch{} 静默吞掉写盘失败，
      //    导致去重历史从未落盘、同一评论被重复回复。
      throw new Error(`读取 ${name} 失败：${e.message}`)
    }
    if (!raw.trim()) return fallback

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(
        `${name} 内容损坏，无法解析：${e.message}\n` +
        `路径：${p}\n` +
        `请人工检查该文件（可能是上次写入被中断）。不要直接删除——` +
        `它可能包含唯一的队列或历史数据。`
      )
    }
    return migrate(name, parsed)
  }

  writeJson(name, value) {
    const version = SCHEMA_VERSIONS[name]
    const payload = version === undefined
      ? value
      : { __schemaVersion: version, data: value }
    this.writeAtomic(name, JSON.stringify(payload, null, 2))
    return payload
  }

  /**
   * 读-改-写。
   *
   * ⚠️ 这是本模块**最重要的方法**。所有修改都必须走它：
   *    mutator 收到的是**刚刚从盘上读出的最新值**，而不是调用方
   *    持有的（可能已陈旧的）对象。
   *    旧代码的丢任务 bug 就是因为写了循环开头读到的旧对象。
   */
  update(name, fallback, mutator) {
    const current = this.readJson(name, fallback)
    const next = mutator(current)
    if (next === undefined) {
      throw new Error(`update(${name}) 的 mutator 必须返回值（返回 undefined 说明忘了 return）`)
    }
    this.writeJson(name, next)
    return next
  }

  /** 追加 JSONL（审计日志用）。append 是原子性足够的操作。 */
  appendLine(name, obj) {
    const line = JSON.stringify(obj) + '\n'
    fs.appendFileSync(this.file(name), line, 'utf8')
    return line.length
  }

  readLines(name, { limit } = {}) {
    const p = this.file(name)
    if (!fs.existsSync(p)) return []
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const out = []
    let corrupt = 0
    for (const l of lines) {
      try {
        out.push(JSON.parse(l))
      } catch {
        // ⚠️ 单行损坏不应中断整体读取（审计日志可能因上次写入中断留下半行），
        //    但**必须计数并上报**——静默跳过会让"审计日志少了几条"无从发现。
        corrupt++
      }
    }
    if (corrupt > 0 && typeof this.onCorruptLine === 'function') {
      this.onCorruptLine(name, corrupt, lines.length)
    }
    return limit ? out.slice(-limit) : out
  }

  exists(name) {
    return fs.existsSync(this.file(name))
  }

  /** 列出实例目录内容（排障用）。 */
  list() {
    return fs.readdirSync(this.dir).map((n) => {
      const st = fs.statSync(this.file(n))
      return { name: n, bytes: st.size, mtime_ms: st.mtimeMs }
    })
  }
}

/** schema 迁移。当前均为 v1，占位以便将来扩展。 */
function migrate(name, parsed) {
  const want = SCHEMA_VERSIONS[name]
  if (want === undefined) return parsed

  // 兼容旧格式：无 __schemaVersion 的裸对象
  if (parsed === null || typeof parsed !== 'object' || !('__schemaVersion' in parsed)) {
    return parsed
  }
  if (parsed.__schemaVersion === want) return parsed.data

  throw new Error(
    `${name} 的 schemaVersion=${parsed.__schemaVersion}，本版本期望 ${want}。\n` +
    `请先升级客户端，或查看 CHANGELOG 了解迁移方式。`
  )
}

module.exports = { Store, SCHEMA_VERSIONS }
