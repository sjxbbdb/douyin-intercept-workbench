'use strict'

// license-server/cli.js
//
// 厂商（甲方）运维命令行 —— **部署指南 §7 的可执行实现**。
//
// ═══════════════════════════════════════════════════════════
// 为什么需要这个文件
// ═══════════════════════════════════════════════════════════
// `docs/部署指南-服务端.md` §7.2 的首次初始化流程把本文件当作**第 0 步**：
//
//     $rc db migrate && $rc db version && $rc db check
//     $rc admin create --user admin
//     $rc plan set --name "半年套餐" --credits <推导值> --is-default
//     $rc account create --user demo001 --plan "半年套餐" --credits <推导值>
//     $rc code batch --count 10 --credits <推导值> --plan "半年套餐"
//     $rc stats --days 7
//
// 没有它，厂商**无法开号**：客户端登录不了、卡密发不出去、套餐建不起来，
// 整个产品在真实 VPS 上不可运营。所以这里不是"辅助脚本"，是运维入口。
//
// ═══════════════════════════════════════════════════════════
// ⚠️ 六个容易忘记、忘了就出事的地方
// ═══════════════════════════════════════════════════════════
//
// 1. **必须与服务端打开同一个库。** 经 `loadConfig()` + `openDatabase()`，
//    绝不自己拼路径、绝不自己 `new DatabaseSync`。两条不同的打开路径
//    迟早会指向两个库（`.env` 里 `DB_PATH` 与默认值不一致时就是事故），
//    表现为"CLI 说账号建好了，服务端说账号不存在"。
//
// 2. **`tier_table` 是唯一来源，本文件里不允许出现 70 / 30 / 10 / 12600 /
//    0.85 / 180000 这类字面量。** 日上限、最小间隔、相似度阈值、套餐积分、
//    `min_plan_credit`、额度文案数字全部由 `domain/policy.js` 推导。
//    理由见 AGENTS.md 误实现 2.2 与 protocol.md §8.2：写死之后，
//    改一次上限就会留下"界面写每日 70 条、套餐却按旧值折算"的错误告知，
//    而那正是售后纠纷与举证不利的起点。
//
// 3. **`credit_ledger` 是只增不改的账本。** 本文件对它**只有 INSERT**
//    （全部经 `domain/billing.js` 的 `grantCredits()`，与余额同事务）。
//    搜索本文件应搜不到 `UPDATE credit_ledger` / `DELETE FROM credit_ledger`。
//    ⚠️ 纠错一律用反向分录（`credit grant --amount -N --reason 对账修正`），
//    绝不 UPDATE 余额——那会让台账与余额对不上且无从追溯。
//
// 4. **密码绝不进 argv。** `--password` 能用，但会留在 shell history 与
//    `ps` 输出里，所以本文件对它**打印醒目警告**；文档路径是
//    `--password-stdin`（`grep '^ADMIN_INIT_PASSWORD=' .env | cut -d= -f2-`），
//    交互路径是关闭回显的提示符。任何情况下都不把密码写进日志或审计表。
//
// 5. **⚠️ `db backup` 绝不能 `cp` 正在写入的 db。** WAL 模式下最新数据可能
//    还在 `-wal` 里，`cp` 出来的副本会缺数据甚至 `database disk image is
//    malformed`。这里先 `wal_checkpoint(TRUNCATE)` 再 `VACUUM INTO`（SQLite
//    内置，零外部依赖），产物是整理好的单文件。
//
// 6. **CLI 不参与计费。** 本文件**不得调用** `settleSendBatch()`：
//    计费只能由 `POST /api/v1/audit/sends` 依据平台确认成功的明细产生
//    （红线 2）。CLI 能改的只有"发放/扣减积分"这类显式人工操作，且必须留台账。
//
// ⚠️ 单写者原则：CLI 与服务端不应同时长时间写同一个库。SQLite 会串行化，
//    但 CLI 的长事务（如 audit prune）会让服务端吃到 SQLITE_BUSY。
//    大批清理请在凌晨低峰执行（部署指南 §5.5 的 cron 就是这么排的）。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')

const { loadConfig } = require('./config')
const { openDatabase, MIGRATIONS_DIR } = require('./store/db')
const { hashPassword, generatePassword } = require('./crypto/password')
const { grantCredits } = require('./domain/billing')
const {
  TIER_TABLE,
  MIN_INTERVAL_MS_RANGE,
  ACTIVE_HOURS_DEFAULT,
  TZ_OFFSET_MINUTES,
  MS_PER_DAY,
  buildPolicy,
  deriveDayIndex,
  tierForDayIndex,
  daysUntilNextTier,
  nextTierName,
  stableDailyMaxTotal,
  planCreditsFor,
  minPlanCredit,
  isActiveHoursShorterOrEqual,
} = require('./domain/policy')
const {
  aggregateSends,
  aggregateReports,
  buildDashboard,
  buildTrend,
  dayKey,
  dayStartMs,
} = require('../shared/lib/stats')
const { SOURCE_TYPES, FAILURE_REASONS, ACCOUNT_TIERS, VERDICTS } = require('../shared/lib/protocol')

// ═══════════════════════════════════════════════════════════
// 常量（**只允许放与安全数值无关的东西**）
// ═══════════════════════════════════════════════════════════

/** 退出码。runbook 里用 `&&` 串联命令，非零即中断，语义必须准确。 */
const EXIT = {
  OK: 0,        // 成功
  FAIL: 1,      // 业务/环境失败（库坏了、余额不足、拒绝执行）
  USAGE: 2,     // 命令或参数写错了——与"执行失败"区分开，便于排障
}

const ACCOUNT_STATUSES = Object.freeze(['active', 'disabled', 'expired'])
const LEDGER_KINDS = Object.freeze(['recharge', 'consume', 'grant', 'adjust', 'refund', 'redeem'])

/** 渠道中文名。仅用于展示，不参与任何计算。 */
const SOURCE_LABELS = Object.freeze({
  comment: '评论', live_danmaku: '弹幕', dm: '私信',
})

/** 失败原因中文名（闭集，见 protocol.md §7.4）。仅展示。 */
const FAILURE_LABELS = Object.freeze({
  rate_limited: '平台限流', login_expired: '登录态失效', element_timeout: '元素未出现',
  network_error: '网络错误', risk_control_rejected: '风控拒绝', content_rejected: '内容被拒',
  blocked_by_target: '被拒收/拉黑', account_risk: '账号风控', unknown: '未知',
})

/** `audit prune` 的批大小。⚠️ 小批删除，避免巨大事务长时间持锁（§5.5）。 */
const PRUNE_BATCH = 5000

/** `db backup` 名字里允许的字符，防止 `--out` 里带奇怪东西拼出意外路径。 */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/

// ═══════════════════════════════════════════════════════════
// 输出：表格、JSON、宽度计算
// ═══════════════════════════════════════════════════════════

/**
 * 终端显示宽度。
 *
 * ⚠️ 不能直接用 `String.length`：中文一个字占两列，用 length 对齐会让
 *    表格在终端里彻底错位（而本文件的所有输出都是中文）。
 *    这里按码点判断东亚宽字符与全角形式，够用且无依赖。
 */
function displayWidth(s) {
  let w = 0
  for (const ch of String(s === null || s === undefined ? '' : s)) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115F) ||   // 韩文字母
      (cp >= 0x2E80 && cp <= 0xA4CF) ||   // 中日韩部首 ~ 注音
      (cp >= 0xAC00 && cp <= 0xD7A3) ||   // 韩文音节
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // 兼容表意文字
      (cp >= 0xFE30 && cp <= 0xFE6F) ||   // 全角形式
      (cp >= 0xFF00 && cp <= 0xFF60) ||   // 全角 ASCII
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x3FFFD)    // 扩展表意文字
    w += wide ? 2 : 1
  }
  return w
}

function padTo(s, width) {
  const str = String(s === null || s === undefined ? '' : s)
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)))
}

/**
 * 渲染终端表格。
 *
 * @param {string[]} headers 表头（中文）
 * @param {Array<Array<any>>} rows 数据行
 * @param {object} [opts]
 * @param {string} [opts.title] 表前标题
 */
function renderTable(headers, rows, opts = {}) {
  const all = [headers, ...rows.map((r) => r.map(cellText))]
  const widths = headers.map((_, i) => Math.max(...all.map((r) => displayWidth(r[i]))))
  const sep = '  '

  const lines = []
  if (opts.title) lines.push(opts.title)
  lines.push(headers.map((h, i) => padTo(h, widths[i])).join(sep).trimEnd())
  lines.push(widths.map((w) => '─'.repeat(w)).join(sep))
  for (const r of rows) {
    lines.push(r.map((c, i) => padTo(cellText(c), widths[i])).join(sep).trimEnd())
  }
  return lines.join('\n')
}

function cellText(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number' && !Number.isFinite(v)) return '—'
  return String(v)
}

/** 把任意值安全地转成可 JSON 序列化的形式（BigInt → string，undefined → null）。 */
function jsonSafe(v) {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val)
    return out
  }
  return v === undefined ? null : v
}

/** `--json` 输出：打印**纯 JSON**，便于 `| jq`。 */
function printJson(out, obj) {
  out.write(JSON.stringify(jsonSafe(obj), null, 2) + '\n')
}

/** 时间格式化（UTC+8，与全系统统计口径一致）。 */
function fmtTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—'
  const d = new Date(Number(ms) + TZ_OFFSET_MINUTES * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function fmtDay(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—'
  return dayKey(Number(ms))
}

/** 毫单位 → 积分（展示用，整数毫单位不丢精度）。 */
function milliToCredits(milli) {
  const n = Number(milli || 0)
  const int = Math.trunc(n / 1000)
  const frac = Math.abs(n % 1000)
  return frac === 0 ? String(int) : `${int}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`
}

/** 积分（整数）× 1000 → 毫单位。 */
function creditsToMilli(credits) {
  return Math.trunc(Number(credits) * 1000)
}

// ═══════════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════════

class UsageError extends Error {
  constructor(message, extra) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = EXIT.USAGE
    this.extra = extra || null
  }
}

class CliError extends Error {
  constructor(message, extra) {
    super(message)
    this.name = 'CliError'
    this.exitCode = EXIT.FAIL
    this.extra = extra || null
  }
}

/**
 * 解析 argv。
 *
 * 规则刻意保守：
 *   · `--k v` 与 `--k=v` 都接受（运维手写两种都会出现）
 *   · `--password-stdin` / `--history` / `--json` / `--all` / `--yes` /
 *     `--unused` / `--is-default` 视为布尔
 *   · **未知长选项直接报错退出 2**，不静默忽略——静默忽略会让
 *     `--credits` 拼错成 `--credit` 时"命令成功但没发额度"，
 *     而运维以为已经发过了
 */
const BOOL_FLAGS = new Set([
  'help', 'json', 'password-stdin', 'history', 'all', 'yes', 'unused',
  'is-default', 'status', 'dry-run',
])

function parseArgs(argv) {
  const flags = {}
  const lists = {}
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      let key
      let val
      const eq = a.indexOf('=')
      if (eq >= 0) {
        key = a.slice(2, eq)
        val = a.slice(eq + 1)
      } else {
        key = a.slice(2)
        if (BOOL_FLAGS.has(key)) {
          val = true
        } else {
          const next = argv[i + 1]
          if (next === undefined || String(next).startsWith('--')) {
            throw new UsageError(`选项 --${key} 缺少取值`)
          }
          val = String(next)
          i++
        }
      }
      if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new UsageError(`无法识别的选项 --${key}`)
      if (key === 'set') {
        // 可重复：policy set --set k=v --set k2=v2
        if (!lists.set) lists.set = []
        lists.set.push(val)
      } else {
        flags[key] = val
      }
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      if (key === 'n') {
        const next = argv[i + 1]
        if (next === undefined) throw new UsageError('选项 -n 缺少取值')
        flags.n = String(next)
        i++
        continue
      }
      if (key === 'h') { flags.help = true; continue }
      throw new UsageError(`无法识别的选项 -${key}（长选项请用 --key value）`)
    }
    positional.push(a)
  }

  return { flags, lists, positional }
}

/** 取必填选项；缺失即 UsageError（退出 2，不是堆栈）。 */
function requireFlag(flags, name) {
  const v = flags[name]
  if (v === undefined || v === true || v === '') {
    throw new UsageError(`缺少必填选项 --${name}`)
  }
  return String(v)
}

function optFlag(flags, name) {
  const v = flags[name]
  if (v === undefined || v === true || v === '') return undefined
  return String(v)
}

function intFlag(flags, name, { min, max, required = false } = {}) {
  let raw = flags[name]
  if (raw === undefined || raw === true || raw === '') {
    if (required) throw new UsageError(`缺少必填选项 --${name}`)
    return undefined
  }
  raw = String(raw)
  if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} 必须是整数，实际为 ${raw}`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new UsageError(`--${name} 超出安全整数范围：${raw}`)
  if (min !== undefined && n < min) throw new UsageError(`--${name} 不能小于 ${min}（实际 ${n}）`)
  if (max !== undefined && n > max) throw new UsageError(`--${name} 不能大于 ${max}（实际 ${n}）`)
  return n
}

// ═══════════════════════════════════════════════════════════
// 密码输入
// ═══════════════════════════════════════════════════════════

/**
 * 读取一行密码。
 *
 * ⚠️ 顺序即优先级：
 *   1. `--password-stdin`（文档路径，`grep ... | cut` 直接喂）
 *   2. `--password`（**能不用就不用**，会进 shell history 与 `ps`）
 *   3. 交互提示（关闭回显）
 *   4. 非 TTY 且没给 --password-stdin → 明确报错，绝不"用空密码建管理员"
 */
async function readPassword(flags, io) {
  const password = optFlag(flags, 'password')

  if (flags['password-stdin']) {
    if (password !== undefined) {
      throw new UsageError('--password-stdin 与 --password 不能同时使用')
    }
    const line = await readLineFromStdin(io)
    if (line === null) {
      throw new CliError('--password-stdin 已指定，但标准输入没有可读内容')
    }
    const pw = stripEol(line)
    if (!pw) throw new CliError('从标准输入读到的密码为空，已中止')
    return pw
  }

  if (password !== undefined) {
    warnPasswordOnArgv(io)
    return password
  }

  if (!io.stdinIsTTY) {
    throw new CliError(
      '当前标准输入不是终端，无法交互输入密码。\n' +
      '  请用文档路径：--password-stdin（例：grep \'^ADMIN_INIT_PASSWORD=\' /opt/dy-license/.env | cut -d= -f2- | ...）'
    )
  }

  return promptPassword(io)
}

/** 去掉行尾 CR/LF。⚠️ Windows 上管道会带 `\r`，不剥掉就变成密码的一部分。 */
function stripEol(s) {
  return String(s).replace(/[\r\n]+$/, '')
}

/** 从 stdin 读第一行。返回 null 表示没有可读内容（不阻塞、不抛栈）。 */
function readLineFromStdin(io) {
  const stdin = io.stdin
  if (!stdin || stdin.destroyed || stdin.readableEnded) return Promise.resolve(null)

  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(v)
    }
    const onData = (chunk) => {
      buf += typeof chunk === 'string' ? chunk : String(chunk)
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        finish(buf.slice(0, nl))
        // ⚠️ 用 pause 让上层继续消费剩余数据，不 destroy（管道还有后续内容时不能吞掉）
        if (typeof stdin.pause === 'function') stdin.pause()
      } else if (buf.length > 4096) {
        finish(buf)
      }
    }
    const onEnd = () => finish(buf.length ? buf : null)
    const onError = (e) => {
      // ⚠️ 不吞异常：读 stdin 失败必须让运维看见原因，否则表现为"命令卡住"
      io.err.write(`[警告] 读取标准输入失败：${e && e.message ? e.message : e}\n`)
      finish(null)
    }
    function cleanup() {
      if (typeof stdin.removeListener === 'function') {
        stdin.removeListener('data', onData)
        stdin.removeListener('end', onEnd)
        stdin.removeListener('error', onError)
      }
    }

    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.on('error', onError)
    if (typeof stdin.resume === 'function') stdin.resume()
  })
}

/** 关闭回显的交互式密码输入（无依赖，用 readline 的 terminal 模式 + 静音流）。 */
function promptPassword(io, label = '请输入密码：') {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: io.stdin,
      output: muteStream(io.out),
      terminal: true,
    })
    rl.stdoutMuted = true
    rl.question(label, (answer) => {
      rl.close()
      io.out.write('\n')
      if (!answer) reject(new CliError('未输入密码，已中止'))
      else resolve(answer)
    })
    rl.on('SIGINT', () => {
      rl.close()
      io.err.write('\n已取消\n')
      reject(new CliError('用户取消输入'))
    })
  })
}

/** 只吞掉回显、不影响真正输出的流包装。 */
function muteStream(stream) {
  return {
    write(str) {
      // readline 会写入提示符与回显字符；这里只放行换行，其余丢弃
      if (typeof str === 'string' && /^\s*$/.test(str)) stream.write(str)
      return true
    },
    get columns() { return stream.columns || 80 },
  }
}

/** ⚠️ `--password` 的醒目警告：argv 会进 history 与 ps。 */
function warnPasswordOnArgv(io) {
  io.err.write(
    '⚠️  警告：已通过 --password 传入明文密码，它会留在 shell history 与 `ps` 输出里。\n' +
    '    生产环境请改用 --password-stdin（或直接交互输入），并事后执行：history -c\n'
  )
}

// ═══════════════════════════════════════════════════════════
// 数据库打开（唯一路径）
// ═══════════════════════════════════════════════════════════

/** 已发布的迁移版本（由文件名推导，不写死版本号）。 */
function knownMigrationVersions() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => f.replace(/\.sql$/, ''))
}

function openDb(ctx) {
  const cfg = ctx.cfg
  if (!ctx.db) {
    const opened = openDatabase(cfg.dbPath, { backupBeforeMigrate: true, verbose: false })
    ctx.db = opened.db
    ctx.appliedMigrations = opened.applied
    ctx.closeDb = opened.close
  }
  return ctx.db
}

/** 已应用的迁移版本（字符串数组）。 */
function migrationVersions(db) {
  const tbl = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration'"
  ).get()
  if (!tbl) return []
  return db.prepare('SELECT version FROM schema_migration ORDER BY version').all()
    .map((r) => String(r.version))
}

/**
 * 拒绝在未迁移/落后于代码的库上执行运维命令。
 *
 * ⚠️ 这是刻意的 fail-loud：`openDatabase()` 会自动建库，若不加这道闸门，
 *    一个路径写错的 `stats` 就会**静默造出一个空库**，运维以为在看生产数据。
 */
function assertMigrated(db, ctx) {
  const applied = migrationVersions(db)
  const known = knownMigrationVersions()
  if (applied.length === 0) {
    throw new CliError(
      `数据库尚未初始化（无可用的表结构）：${ctx.cfg.dbPath}\n` +
      '  请先执行：node license-server/cli.js db migrate'
    )
  }
  const pending = known.filter((v) => !applied.includes(v))
  if (pending.length) {
    throw new CliError(
      `数据库结构落后于代码（未应用：${pending.join(', ')}）：${ctx.cfg.dbPath}\n` +
      '  请先执行：node license-server/cli.js db migrate'
    )
  }
}

function schemaVersion(db) {
  const rows = migrationVersions(db)
  return rows.length ? rows[rows.length - 1] : null
}

/** 解析 `YYYY-MM-DD`（按 UTC+8 自然日）。 */
function parseDayArg(raw, name) {
  const s = String(raw)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw new UsageError(`--${name} 必须是 YYYY-MM-DD 格式，实际为 ${s}`)
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new UsageError(`--${name} 不是合法日期：${s}`)
  }
  const utcMidnight = Date.UTC(y, mo - 1, d)
  const check = new Date(utcMidnight)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new UsageError(`--${name} 不是合法日期：${s}`)
  }
  // dayStartMs 会把"UTC 午夜"换算成"该日 UTC+8 的 00:00"的等价时刻
  return { dayStart: dayStartMs(utcMidnight), label: s }
}

function nowOf(ctx) {
  return ctx.nowMs === undefined || ctx.nowMs === null ? Date.now() : Number(ctx.nowMs)
}

// ═══════════════════════════════════════════════════════════
// 账号/凭证小工具
// ═══════════════════════════════════════════════════════════

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** 按用户名取账号；找不到即明确报错（不返回 undefined 让上层猜）。 */
function getAccount(db, username) {
  const row = db.prepare('SELECT * FROM account WHERE account = ?').get(String(username))
  if (!row) {
    throw new CliError(`账号不存在：${username}\n  可用 account list 查看现有账号`)
  }
  return row
}

function getBalanceMilli(db, accountId) {
  const row = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
  return row ? Number(row.balance_milli) : 0
}

function upsertCreditRow(db, accountId, nowMs) {
  db.prepare(`
    INSERT INTO credit (account_id, balance_milli, updated_at_ms)
    VALUES (?, 0, ?)
    ON CONFLICT(account_id) DO NOTHING
  `).run(accountId, nowMs)
}

function upsertBillingRow(db, accountId, state, nowMs) {
  db.prepare(`
    INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms)
    VALUES (?, 0, ?, ?)
    ON CONFLICT(account_id) DO NOTHING
  `).run(accountId, state, nowMs)
}

/**
 * 写管理员操作留痕。
 *
 * ⚠️ 只记"谁在什么时候对谁做了什么"，**绝不记密码、令牌、卡密明文**。
 *    卡密类操作只记哈希前缀，密码类操作只记"已重置"。
 */
function logAdminAction(db, { adminName, action, target, detail, nowMs }) {
  let adminId = null
  if (adminName) {
    const row = db.prepare('SELECT id FROM admin_user WHERE username = ?').get(String(adminName))
    if (row) adminId = Number(row.id)
  }
  db.prepare(`
    INSERT INTO admin_action_log (admin_id, admin_name, action, target, detail_json, at_ms)
    VALUES (?,?,?,?,?,?)
  `).run(
    adminId, adminName ? String(adminName) : '', String(action), String(target || ''),
    detail ? JSON.stringify(jsonSafe(detail)) : null, nowMs
  )
}

/** 当前全局策略版本（服务端也是这么取的）。 */
function globalPolicyVersion(db) {
  const row = db.prepare('SELECT policy_version FROM policy WHERE account_id IS NULL').get()
  return row ? Number(row.policy_version) : 1
}

/** 某账号的天数索引；首次登录时间缺失时按"今天注册"处理（与登录逻辑一致）。 */
function dayIndexOf(account, nowMs) {
  const first = Number(account.first_login_ms || 0)
  return deriveDayIndex(first > 0 ? first : nowMs, nowMs)
}

/**
 * 解析账号当前生效的策略。
 *
 * ⚠️ 与服务端 `routes-audit.js` 的 `heartbeat()` **用同一套推导**：
 *    等级只由天数索引决定，版本取全局行。这里不允许"顺手"用别的版本号，
 *    否则 CLI 展示的策略与服务端下发的策略会不一致。
 */
function currentPolicy(db, account, nowMs) {
  return buildPolicy({
    accountId: Number(account.account_id),
    accountDayIndex: dayIndexOf(account, nowMs),
    policyVersion: globalPolicyVersion(db),
    nowMs,
  })
}

module.exports = {}
