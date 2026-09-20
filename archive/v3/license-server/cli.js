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
  // ⚠️ 只 require 真正用到的导出：用不到却 require 进来，
  //    会让"这个数值到底从哪来"变得难以追查（而红线 1 恰恰要求可追查）。
  TIER_TABLE,
  MIN_INTERVAL_MS_RANGE,
  TZ_OFFSET_MINUTES,
  MS_PER_DAY,
  buildPolicy,
  buildEffectivePolicy,
  deriveDayIndex,
  tierForDayIndex,
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
const { SOURCE_TYPES, FAILURE_REASONS } = require('../shared/lib/protocol')

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

/** 已知命令组。未知组一律退出 2 并打印顶层帮助（不打印堆栈）。 */
const KNOWN_GROUPS = Object.freeze([
  'db', 'admin', 'account', 'credit', 'code', 'policy', 'audit', 'stats', 'session', 'plan',
])

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
 *   · `--help` / `--json` / `--all` / `--yes` / `--history` / `--unused` /
 *     `--is-default` / `--status` / `--dry-run` / `--password-stdin` 是布尔选项
 *   · **未知长选项直接报错退出 2**，不静默忽略。
 *
 * ⚠️ 为什么放着宽松解析不用：静默忽略会让 `--credits` 拼成 `--credit` 时
 *    表现为"命令成功但没发额度"，运维以为已经发过了；而 `--reason` 拼错时
 *    会变成一条没有原因的台账分录——这些都是事后无法复原的。
 *    未知键一律拒绝，宁可让人多打一次 `--help`。
 *
 * 位置参数约定（各命令组据此取值，**下标不要凭感觉数**）：
 *   parseArgs(argv).positional[0]  = 命令组名，如 'credit'
 *   parseArgs(argv).positional[1]  = 子命令，如 'ledger'
 *   parseArgs(argv).positional[2]  = 子命令的第二段，如 'tail'
 */
const BOOL_FLAGS = new Set([
  'help', 'json', 'password-stdin', 'history', 'all', 'yes', 'unused',
  'is-default', 'status', 'dry-run',
])

/** 需要取值的选项白名单（未列出的长选项一律拒绝）。 */
const VALUE_FLAGS = new Set([
  'user', 'password', 'note', 'plan', 'credits', 'expires', 'max-devices',
  'amount', 'reason', 'batch', 'out', 'code', 'set', 'file',
  'count', 'from', 'to', 'format', 'keep-days', 'days',
  'name', 'price', 'valid-days',
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
          if (!VALUE_FLAGS.has(key)) throw new UsageError(`无法识别的选项 --${key}`)
          const next = argv[i + 1]
          if (next === undefined || String(next).startsWith('--')) {
            throw new UsageError(`选项 --${key} 缺少取值`)
          }
          val = String(next)
          i++
        }
      }
      if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new UsageError(`无法识别的选项 --${key}`)
      if (!BOOL_FLAGS.has(key) && !VALUE_FLAGS.has(key)) {
        throw new UsageError(`无法识别的选项 --${key}`)
      }
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

  if (flags.n !== undefined && !/^\d+$/.test(flags.n)) {
    throw new UsageError(`-n 必须是整数，实际为 ${flags.n}`)
  }

  return { flags, lists, positional }
}

/**
 * 取必填选项；缺失即 UsageError（退出 2，不是堆栈）。
 *
 * ⚠️ 判空必须用 `undefined`，**不能用 falsy**：`--amount 0` 是合法输入
 *    （部署指南 §11.4 明确用 `credit grant --amount 0 --reason "对账修正"`
 *    走显式台账修正），用 `!v` 判空会把它当成"没给"。
 */
function requireFlag(flags, name) {
  const v = flags[name]
  if (v === undefined || v === true) {
    throw new UsageError(`缺少必填选项 --${name}`)
  }
  return String(v)
}

function optFlag(flags, name) {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  return String(v)
}

function intFlag(flags, name, { min, max, required = false } = {}) {
  let raw = flags[name]
  if (raw === undefined || raw === true) {
    if (required) throw new UsageError(`缺少必填选项 --${name}`)
    return undefined
  }
  raw = String(raw).trim()
  if (raw === '') {
    if (required) throw new UsageError(`缺少必填选项 --${name}`)
    return undefined
  }
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

/**
 * ⚠️ 除了"显式建库"的两条命令，其余命令都拒绝在**不存在的库路径**上执行。
 *
 * 为什么必须加这道闸门：`openDatabase()` 会自动建库并跑迁移。于是
 * `.env` 里 `DB_PATH` 写错（或忘了 `--env`／跑在错误的 cwd）时，
 * `stats` / `account list` 会**静默造出一个空库**，运维却以为在看生产数据——
 * 这比直接报错危险得多。部署指南 §7.2 的第一步本来就是 `db migrate`，
 * 所以"库不存在 → 让你先跑 db migrate"完全符合运维动线。
 */
function requireExistingDb(ctx) {
  if (!fs.existsSync(ctx.cfg.dbPath)) {
    throw new CliError(
      `数据库不存在：${ctx.cfg.dbPath}\n` +
      `  请先初始化：${RC} db migrate\n` +
      '  （若路径不符预期，请检查 .env 的 DATA_DIR / DB_PATH，或用 DATA_DIR=... 覆盖）'
    )
  }
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

/** 解析整数型环境变量（保留策略天数）。⚠️ 非法值必须报错，不能静默退回默认。 */
function parseIntEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`环境变量 ${name} 必须是正整数，实际为 ${raw}`)
  }
  return Math.trunc(n)
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
 * ⚠️ 与服务端 `routes-audit.js` 的 `heartbeat()` 用**同一套推导**：
 *    等级只由天数索引决定。这里不允许"顺手"用别的等级或自己算一个，
 *    否则 CLI 展示的策略与服务端下发的策略会不一致。
 *
 * 版本号取 `max(账号级覆盖版本, 全局版本)`：
 *    · 全局版本是服务端实际下发的那个（`policyVersionOf` 读 `account_id IS NULL` 行）；
 *    · 账号级覆盖版本由 `policy set` 自增，用于留痕与对齐。
 *    取较大值可避免"刚改过却显示旧版本"这种自相矛盾的展示。
 *
 * ⚠️ 目前 `server.js` 的 `buildPolicy()` **不读账号级覆盖**，只按等级表推导。
 *    因此 CLI 展示的"生效值"= 等级表基准 + 覆盖层（取更保守端），
 *    实际下发值仍以服务端为准；`policy set` 会把这一点显式告知操作者。
 *
 * @param {boolean} [withOverride=false] 是否读取账号级覆盖层（列表场景不必读）
 */
function currentPolicy(db, account, nowMs, withOverride = false) {
  const accountId = Number(account.account_id)
  let version = globalPolicyVersion(db)
  if (withOverride) {
    const row = db.prepare('SELECT policy_version FROM policy WHERE account_id = ?').get(accountId)
    if (row) version = Math.max(version, Number(row.policy_version))
  }
  // ⚠️ 用 `buildEffectivePolicy`（而非 `buildPolicy`）：`policy show` /
  //    `account show` 必须显示**实际会下发给客户端的**那份策略。
  //    只显示等级基准值会让运维以为"我刚收紧的限额没生效"——
  //    而真相是"显示了另一份策略"。
  // ⚠️ 版本号取 `max(全局, 账号级)`：账号级覆盖会自增版本，
  //    只读全局版本会让覆盖缓存命中错误的键（读到陈旧覆盖）。
  return buildEffectivePolicy(db, {
    accountId,
    accountDayIndex: dayIndexOf(account, nowMs),
    policyVersion: version,
    nowMs,
  })
}

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

const RC = 'node license-server/cli.js'

const TOP_HELP = `授权中心管理命令行（license-server/cli.js）

用法：
  ${RC} <group> <action> [选项]
  ${RC} --help            显示本帮助
  ${RC} <group> --help    显示某组帮助

命令组：
  db       数据库：迁移 / 版本 / 完整性检查 / 在线备份 / 回收 WAL
  admin    管理员：创建 / 改密 / 列表
  account  商家账号：开号 / 列表 / 详情 / 停用 / 启用 / 重置密码
  credit   积分：发放 / 扣减 / 查余额 / 看台账（只增不改）
  code     充值码：批量生成 / 查询 / 作废 / 代客兑换
  policy   安全策略：查看 / 调整（只能更保守）/ 下发状态
  audit    审计：导出（纠纷举证）/ 清理 / 用量
  stats    看板速查（全平台 / 单商家）
  session  会话：在线列表 / 踢下线
  plan     套餐：列表 / 设置

常用（部署指南 §7.2 首次初始化）：
  ${RC} db migrate && ${RC} db version && ${RC} db check
  ${RC} admin create --user admin
  ${RC} plan set --name "半年套餐" --credits ${planCreditsFor(180)} --is-default
  ${RC} account create --user demo001 --note "首批测试商家" --plan "半年套餐" --credits ${planCreditsFor(180)}
  ${RC} code batch --count 10 --credits ${planCreditsFor(180)} --plan "半年套餐" --batch "2026Q4"
  ${RC} stats --days 7

⚠️ 所有命令都以**服务用户**执行（data/ 是 0700）：
  bd=/opt/dy-license
  rc="sudo -u dylicense env HOME=/opt/dy-license node $bd/cli.js"
  $rc db migrate

退出码：0 成功 / 1 执行失败 / 2 命令或参数写错`

function groupHelp(group) {
  const G = {
    db: `用法：${RC} db <migrate|version|check|backup|checkpoint> [选项]

  db migrate [--to <版本>]     应用未执行的迁移（迁移前自动备份）
  db version                   打印当前库的 schema 版本与迁移列表
  db check                     完整性检查（integrity_check + foreign_key_check + 结构版本）
  db backup --out <目录>       在线备份（VACUUM INTO，单文件），产物已 chmod 600
  db checkpoint                回收 WAL（wal_checkpoint(TRUNCATE)）

⚠️ 绝不要用 cp 备份正在写入的库：WAL 里的最新数据不在主库里，
   cp 出来的副本会缺数据甚至损坏。用 db backup 或 sqlite3 .backup。`,

    admin: `用法：${RC} admin <create|passwd|list> [选项]

  admin create --user <名> [--password-stdin]
      创建后台管理员。密码优先级：--password-stdin > 交互输入（关闭回显）。
  admin passwd --user <名> [--password-stdin]
      重置管理员密码。
  admin list
      列出管理员。

⚠️ 不要用 --password 传密码：它会留在 shell history 与 ps 输出里。
   文档路径（部署指南 §7.2）：
     grep '^ADMIN_INIT_PASSWORD=' /opt/dy-license/.env | cut -d= -f2- \\
       | ${RC} admin create --user admin --password-stdin`,

    account: `用法：${RC} account <create|list|show|disable|enable|reset-password> [选项]

  account create --user <名> --note <备注> [--plan <套餐>] [--credits <n>]
                 [--expires <YYYY-MM-DD>] [--max-devices <n>] [--password-stdin]
      ⚠️ --credits 低于套餐最低积分（由 tier_table 推导，当前 ${minPlanCredit()}）
         会被 PLAN_QUOTA_BELOW_MIN 拒绝。不给 --credits 时按 --plan 的积分数发放。
  account list [--status active|disabled|expired] [--json]
  account show --user <名> [--json]
  account disable --user <名>      停用并踢掉全部会话
  account enable  --user <名>      启用
  account reset-password --user <名> [--password-stdin]   改密并踢掉全部会话

说明：不带 --password 时自动生成随机密码并打印一次（请立即抄给商家）。`,

    credit: `用法：${RC} credit <grant|revoke|balance|ledger> [选项]

  credit grant  --user <名> --amount <n> --reason <文本>   加分（写台账）
  credit revoke --user <名> --amount <n> --reason <文本>   扣分（写台账，不允许扣成负数）
  credit balance --user <名>
  credit ledger tail --user <名> [-n 50]

  --amount 0 合法：用于写一条 0 值"对账修正"分录（部署指南 §11.4）。
  --json 对 balance / ledger tail 有效。

⚠️ 台账 credit_ledger 是**只增不改**的账本：本命令只 INSERT，从不 UPDATE/DELETE。
   扣错了不要改历史，用反向分录纠正：
     ${RC} credit grant --user <名> --amount <相反数> --reason "对账修正：单号 ..."`,

    code: `用法：${RC} code <batch|list|revoke|redeem> [选项]

  code batch --count <n> --credits <n> [--plan <套餐>] [--batch <名>] [--out <文件>]
      生成充值码。⚠️ 明文只在这一次输出，库中只存 sha256，之后无法再取回。
      --out 产物已 chmod 600（失败会警告，请手工 chmod 600）。
  code list [--batch <名>] [--unused]
      列出充值码（显示哈希前 12 位，**不显示也无法还原明文**）
  code revoke --code <明文卡密>          作废
  code redeem --code <明文卡密> --user <名>   代客兑换（加积分 + 按 --plan 的有效期延长套餐）

⚠️ 需要明文卡密的命令必须由持有明文的人执行；库里只有哈希，无法从哈希反推。`,

    policy: `用法：${RC} policy <show|set|push> [选项]

  policy show --user <名> [--history] [--json]
  policy set  --user <名> --set k=v [--set k2=v2] --reason <文本>
  policy set  --user <名> --file policy.json --reason <文本>
  policy push --user <名> | --all | --status

⚠️ **只能更保守**（AGENTS.md 红线 1）。可改的键：
     limits.<comment|live_danmaku|dm>.daily_max              只能调低
     limits.<comment|live_danmaku|dm>.min_interval_ms        只能调高（且在允许区间内）
     limits.<comment|live_danmaku|dm>.content_similarity_max 只能调低
     active_hours.windows                                    只能调短、窗口数不得增加
     circuit_breaker.* / idle_pause_ms                       运维参数
  任何**放宽安全上限**的键（上限调高、间隔调短、阈值调高、时段调长、
  指定 account_tier 等）一律拒绝。正确路线是改 tier_table（厂商级、全体商家
  生效，且必须重算套餐积分与额度文案），或等天数自然推进等级。

   键名也接受扁平写法：--set "limits.comment.daily_max"=10`,

    audit: `用法：${RC} audit <export|prune|usage> [选项]

  audit export --user <名> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --format csv|json --out <文件>
      导出审计明细（纠纷举证）。⚠️ 目标标识是哈希，不可还原为身份；导出文件已 chmod 600。
  audit prune [--keep-days <n>] [--yes]
      按保留策略清理明细。不带 --yes 时**只打印将要删除的行数与日期范围**并中止。
  audit usage
      各表行数、日期范围与占用

⚠️ 清理顺序（部署指南 §5.5）：先聚合后删除；本命令不删 ledger / credit /
   plan / policy 这类"钱与配置"，只清理明细类表。`,

    stats: `用法：${RC} stats [--user <名>] [--days 7] [--json]

看板速查。数字由 shared/lib/stats.js 计算（与服务端、客户端同一份实现），
CLI 不做任何百分比/成功率算术。

  回复成功率 = 平台确认成功条数 / 回复尝试条数
  ⚠️ 分母为 0 时显示 “—”，**不是 100%**（避免"成功率为 0 条发送"这种误导）`,

    session: `用法：${RC} session <list|revoke> [选项]

  session list --user <名>
  session revoke --user <名>     踢掉该账号全部未失效会话
  session revoke --all           踢掉全平台全部未失效会话（⚠️ 全体商家需重新登录）

使用场景：商家换机器后被 MAX_DEVICES 挡住（部署指南 §11.2）。`,

    plan: `用法：${RC} plan <list|set> [选项]

  plan list
  plan set --name <名> --credits <n> [--price <元>] [--is-default] [--valid-days <n>]

⚠️ --credits 必须 ≥ 套餐最低积分（由 tier_table 推导，当前 ${minPlanCredit()}）。
   该值 = 稳定期三渠道日上限合计 ${stableDailyMaxTotal()} × 180 天。
   改 tier_table 后必须重算（protocol.md §8.2）。
   --price 以「元」为单位，落库为 price_cents 整数分；给 0 时保留占位标记。`,
  }
  return G[group] || null
}

// ═══════════════════════════════════════════════════════════
// db
// ═══════════════════════════════════════════════════════════

function cmdDb(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  const cfg = ctx.cfg
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'migrate': {
      const dbPath = cfg.dbPath
      if (!fs.existsSync(dbPath)) {
        out.write(`[db] 数据库不存在，将新建：${dbPath}\n`)
      }
      const db = openDb(ctx)
      const applied = ctx.appliedMigrations || []
      const target = optFlag(flags, 'to')

      if (target) {
        // ⚠️ `--to` 只支持"迁移到不超过该版本"。降级要恢复备份（§10.3），
        //    因为迁移是只做加法的，反向迁移不存在也不该存在。
        const known = knownMigrationVersions()
        if (!known.includes(target)) {
          throw new UsageError(`--to ${target} 不是已知迁移版本。已知：${known.join(', ')}`)
        }
        const appliedNow = migrationVersions(db)
        const extra = appliedNow.filter((v) => v > target)
        if (extra.length) {
          throw new CliError(
            `--to ${target} 是降级，不支持在线降级（已应用 ${extra.join(', ')}）。\n` +
            '  迁移只做加法：回滚请恢复迁移前备份（部署指南 §5.2/§10.3）。'
          )
        }
        if (!applied.includes(target)) {
          throw new CliError(`--to ${target}：该版本在本次执行中未被应用，请确认迁移文件是否存在`)
        }
      }

      if (applied.length === 0) {
        out.write('[db] 数据库结构已是最新，无待应用迁移\n')
      } else {
        out.write(`[db] 已应用 ${applied.length} 个迁移：${applied.join(', ')}\n`)
      }
      out.write(`[db] 当前结构版本：${schemaVersion(db) || '—'}\n`)
      return EXIT.OK
    }

    case 'version': {
      if (!fs.existsSync(cfg.dbPath)) {
        // ⚠️ 刻意不自动建库：静默造出一个空库会让运维以为在看生产数据
        throw new CliError(
          `数据库不存在：${cfg.dbPath}\n  请先执行：${RC} db migrate`
        )
      }
      const db = openDb(ctx)
      const applied = migrationVersions(db)
      if (applied.length === 0) {
        throw new CliError(
          `数据库存在但未初始化（没有迁移记录）：${cfg.dbPath}\n  请先执行：${RC} db migrate`
        )
      }
      const known = knownMigrationVersions()
      const pending = known.filter((v) => !applied.includes(v))

      out.write(`数据库：${cfg.dbPath}\n`)
      out.write(`结构版本：${applied[applied.length - 1]}（已应用 ${applied.length}/${known.length}）\n`)
      out.write(`已应用：${applied.join(', ')}\n`)
      if (pending.length) {
        out.write(`⚠️ 待应用：${pending.join(', ')} —— 请执行 ${RC} db migrate\n`)
        return EXIT.FAIL
      }
      out.write('代码与库结构一致\n')
      return EXIT.OK
    }

    case 'check': {
      // ⚠️ 部署指南 §8.3 的健康脚本用 `$rc db check` 判活，所以这里
      //    任何一项不合格都必须**退出非零**，且要说清是哪一项。
      if (!fs.existsSync(cfg.dbPath)) {
        ctx.io.err.write(`[db check] 失败：数据库不存在：${cfg.dbPath}\n`)
        ctx.io.err.write(`          请先执行：${RC} db migrate\n`)
        return EXIT.FAIL
      }
      const db = openDb(ctx)
      const integ = db.prepare('PRAGMA integrity_check').all()
        .map((r) => String(r.integrity_check))
      const fk = db.prepare('PRAGMA foreign_key_check').all()
      const applied = migrationVersions(db)
      const known = knownMigrationVersions()
      const pending = known.filter((v) => !applied.includes(v))

      const okIntegrity = integ.length === 1 && integ[0] === 'ok'
      const okSchema = applied.length > 0 && pending.length === 0

      out.write(`数据库：${cfg.dbPath}\n`)
      out.write(`integrity_check：${okIntegrity ? 'ok' : integ.join(' | ')}\n`)
      out.write(`foreign_key_check：${fk.length === 0 ? 'ok' : `${fk.length} 处违反`}\n`)
      out.write(`结构版本：${applied.length ? applied[applied.length - 1] : '（无迁移记录）'}` +
        `${pending.length ? `，待应用 ${pending.join(', ')}` : ''}\n`)

      if (!okIntegrity || fk.length > 0 || !okSchema) {
        ctx.io.err.write('[db check] 失败：\n')
        if (!okIntegrity) ctx.io.err.write('  · 完整性检查未通过（可能已损坏，请恢复备份：部署指南 §5.2）\n')
        if (fk.length > 0) ctx.io.err.write('  · 存在外键违反\n')
        if (!okSchema) ctx.io.err.write('  · 库结构未初始化或落后于代码，请执行 db migrate\n')
        return EXIT.FAIL
      }
      out.write('[db check] 通过\n')
      return EXIT.OK
    }

    case 'backup': {
      const outDir = requireFlag(flags, 'out')
      if (!fs.existsSync(cfg.dbPath)) {
        throw new CliError(`数据库不存在：${cfg.dbPath}（没有可备份的内容）\n  请先执行：${RC} db migrate`)
      }
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
        out.write(`[db] 已创建备份目录：${outDir}\n`)
      } else if (!fs.statSync(outDir).isDirectory()) {
        throw new CliError(`--out 不是目录：${outDir}`)
      }

      const db = openDb(ctx)
      const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
      const target = path.join(outDir, `license-${stamp}.db`)
      if (!SAFE_NAME_RE.test(path.basename(target))) {
        throw new CliError('备份文件名异常，已中止')
      }
      // ⚠️ VACUUM INTO 的目标必须不存在
      if (fs.existsSync(target)) throw new CliError(`备份目标已存在，请换目录或稍后重试：${target}`)

      // ⚠️ 先把 WAL 内容合并回主库，再 VACUUM INTO。顺序不能反：
      //    VACUUM INTO 本身是只读快照，但先 checkpoint 能让备份更小、更干净。
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (e) {
        // 有其他连接在写时 checkpoint 可能忙碌——不让它阻断备份，但必须留痕
        ctx.io.err.write(`[db] 警告：WAL 检查点未完成（${e && e.message}），继续备份\n`)
      }
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)

      const size = fs.statSync(target).size
      const chmod = chmod600(target)
      out.write(`[db] 备份完成：${target}（${fmtSize(size)}）\n`)
      writeChmodNote(ctx.io, chmod, target)

      // 备份必须可用才算成功——空文件 / 损坏文件比没有备份更危险
      const verify = openDatabaseReadOnly(target)
      try {
        const r = verify.db.prepare('PRAGMA integrity_check').all().map((x) => String(x.integrity_check))
        const c = verify.db.prepare('SELECT COUNT(*) AS c FROM account').get()
        out.write(`[db] 备份自检：integrity_check=${r.join('|')}，账号 ${Number(c.c)} 个\n`)
        if (!(r.length === 1 && r[0] === 'ok')) {
          throw new CliError(`备份自检未通过：${target}`)
        }
      } finally {
        verify.close()
      }
      return EXIT.OK
    }

    case 'checkpoint': {
      if (!fs.existsSync(cfg.dbPath)) {
        throw new CliError(`数据库不存在：${cfg.dbPath}\n  请先执行：${RC} db migrate`)
      }
      const db = openDb(ctx)
      const before = walBytes(cfg.dbPath)
      const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      const after = walBytes(cfg.dbPath)
      out.write(`[db] WAL 检查点完成：busy=${Number(row.busy)} ` +
        `log=${Number(row.log)} checkpointed=${Number(row.checkpointed)}\n`)
      out.write(`[db] WAL 文件：${fmtSize(before)} → ${fmtSize(after)}\n`)
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'db', action)
  }
}

function walBytes(dbPath) {
  let n = 0
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (fs.existsSync(dbPath + suffix)) n += fs.statSync(dbPath + suffix).size
    } catch (e) {
      // 只读探测；权限问题不该让 checkpoint 失败，但要看得到
      n += 0
    }
  }
  return n
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * chmod 600（平台允许时）。
 *
 * ⚠️ 部署指南是让运维手工 `sudo chmod 600`。进程内做掉更好，
 *    但**失败不能静默**：卡密文件与审计导出含全部卡密明文/全部发送行为，
 *    留在 644 上等于同机任何用户都能读走。
 */
function chmod600(file) {
  try {
    fs.chmodSync(file, 0o600)
    const mode = fs.statSync(file).mode & 0o777
    return mode === 0o600 ? { ok: true, mode } : { ok: false, mode }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function writeChmodNote(io, res, file) {
  if (res.ok) {
    io.out.write(`[权限] 已设为 600（仅属主可读）：${file}\n`)
    return
  }
  io.err.write(
    `⚠️  警告：无法把 ${file} 设为 600` +
    `${res.error ? `（${res.error}）` : `（当前权限 ${res.mode === undefined ? '未知' : res.mode.toString(8)}）`}\n` +
    '    请手工执行：chmod 600 ' + file + '\n' +
    '    该文件若被同机其他用户读到，等同于泄露。\n'
  )
}

/** 以只读方式打开一个已存在的库（用于校验备份产物，不跑迁移）。 */
function openDatabaseReadOnly(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  const handle = new DatabaseSync(dbPath, { readOnly: true })
  return { db: handle, close: () => handle.close() }
}

// ═══════════════════════════════════════════════════════════
// admin
// ═══════════════════════════════════════════════════════════

async function cmdAdmin(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'create': {
      const user = requireFlag(flags, 'user')
      const exists = db.prepare('SELECT id FROM admin_user WHERE username = ?').get(user)
      if (exists) throw new CliError(`管理员已存在：${user}（改密请用 ${RC} admin passwd --user ${user}）`)

      const password = await readPassword(flags, ctx.io)
      assertPasswordStrength(password)

      const r = db.prepare(`
        INSERT INTO admin_user (username, pass_hash, role, status, created_at_ms)
        VALUES (?, ?, 'admin', 'active', ?)
      `).run(user, hashPassword(password), nowMs)
      logAdminAction(db, { adminName: user, action: 'admin_create', target: user, nowMs })

      out.write(`✅ 管理员已创建：${user}（id=${Number(r.lastInsertRowid)}）\n`)
      out.write('   密码只保存 scrypt 哈希，无法找回；忘记请用 admin passwd 重置。\n')
      return EXIT.OK
    }

    case 'passwd': {
      const user = requireFlag(flags, 'user')
      const row = db.prepare('SELECT id FROM admin_user WHERE username = ?').get(user)
      if (!row) throw new CliError(`管理员不存在：${user}`)

      const password = await readPassword(flags, ctx.io)
      assertPasswordStrength(password)

      db.prepare('UPDATE admin_user SET pass_hash = ? WHERE username = ?')
        .run(hashPassword(password), user)
      logAdminAction(db, { adminName: user, action: 'admin_passwd', target: user, nowMs })
      out.write(`✅ 管理员密码已重置：${user}\n`)
      return EXIT.OK
    }

    case 'list': {
      const rows = db.prepare('SELECT * FROM admin_user ORDER BY id').all()
      if (flags.json) {
        printJson(out, rows.map((r) => ({
          id: Number(r.id), username: r.username, role: r.role, status: r.status,
          created_at_ms: Number(r.created_at_ms),
          last_login_ms: r.last_login_ms === null ? null : Number(r.last_login_ms),
        })))
        return EXIT.OK
      }
      if (!rows.length) {
        out.write('（暂无管理员）请先执行：' + `${RC} admin create --user admin\n`)
        return EXIT.OK
      }
      out.write(renderTable(
        ['ID', '用户名', '角色', '状态', '创建时间', '最后登录'],
        rows.map((r) => [
          Number(r.id), r.username, r.role, r.status,
          fmtTime(Number(r.created_at_ms)),
          r.last_login_ms === null ? '从未' : fmtTime(Number(r.last_login_ms)),
        ])
      ) + '\n')
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'admin', action)
  }
}

/**
 * 密码强度下限。
 *
 * ⚠️ 只做"明显弱密码"拦截，不引入复杂度规则（那会把运维逼回 --password）。
 *    这里的最低要求是长度，因为这是对抗暴力破解最有效的一维。
 */
function assertPasswordStrength(password) {
  const pw = String(password)
  if (pw.length < 8) {
    throw new CliError('密码太短（至少 8 位）。可用 openssl rand -base64 15 | tr -d \'/+=\' | cut -c1-18 生成')
  }
  if (/^\s|\s$/.test(pw)) {
    throw new CliError('密码首尾不能是空白字符（.env 与 shell 管道很容易带上）')
  }
}

// ═══════════════════════════════════════════════════════════
// account
// ═══════════════════════════════════════════════════════════

async function cmdAccount(ctx, action, args) {
  const { flags, lists } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'create': {
      const user = requireFlag(flags, 'user')
      if (!/^[A-Za-z0-9_.-]{2,64}$/.test(user)) {
        throw new UsageError('--user 只能是 2~64 位字母/数字/下划线/点/短横线（登录名会进 .env 与脚本）')
      }
      if (db.prepare('SELECT account_id FROM account WHERE account = ?').get(user)) {
        throw new CliError(`账号已存在：${user}`)
      }

      const note = requireFlag(flags, 'note')
      const planName = optFlag(flags, 'plan')
      const plan = planName ? findPlanByName(db, planName) : null
      const deviceLimit = intFlag(flags, 'max-devices', { min: 1, max: 64 })

      // ── 积分下限校验（PLAN_QUOTA_BELOW_MIN）─────────────────
      // ⚠️ 最低值是**推导**出来的，不是常量：min_plan_credit =
      //    stable_daily_max_total × 180 天。文档明确要求"旧版的 4500 / 4320
      //    都会直接失败"，这里是那道闸门。
      const minimum = minPlanCredit()
      let credits
      if (flags.credits !== undefined) {
        credits = intFlag(flags, 'credits', { min: 0, required: true })
        if (credits < minimum) throw quotaBelowMinError(credits, minimum)
      } else if (plan) {
        credits = Number(plan.credits)
        if (credits < minimum) throw quotaBelowMinError(credits, minimum, `套餐「${plan.name}」`)
      } else {
        credits = minimum
      }

      let expiresMs = null
      if (flags.expires !== undefined) {
        const parsed = parseDayArg(requireFlag(flags, 'expires'), 'expires')
        expiresMs = parsed.dayStart + MS_PER_DAY - 1
        if (expiresMs <= nowMs) {
          throw new UsageError(`--expires ${parsed.label} 已经过去，账号会立刻处于到期状态`)
        }
      } else if (plan) {
        expiresMs = nowMs + Number(plan.valid_days) * MS_PER_DAY
      }

      // 密码：不给就生成，且**必须打印一次**（哈希不可逆，不打印就再也拿不到）
      let password
      let generated = false
      if (flags['password-stdin'] || flags.password !== undefined) {
        password = await readPassword(flags, ctx.io)
      } else if (ctx.io.stdinIsTTY) {
        password = await promptPassword(ctx.io, `为账号 ${user} 设置密码（直接回车＝自动生成）：`)
      } else {
        password = generatePassword(20)
        generated = true
      }
      assertPasswordStrength(password)

      db.exec('BEGIN IMMEDIATE')
      let accountId
      try {
        const r = db.prepare(`
          INSERT INTO account (
            account, display_name, pass_hash, status, plan_id, plan_expires_ms,
            device_limit, first_login_ms, note, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?)
        `).run(
          user, user, hashPassword(password), plan ? Number(plan.plan_id) : null,
          expiresMs, deviceLimit === undefined ? 1 : deviceLimit, note, nowMs, nowMs
        )
        accountId = Number(r.lastInsertRowid)
        upsertCreditRow(db, accountId, nowMs)
        upsertBillingRow(db, accountId, 'active', nowMs)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      // ⚠️ 发积分必须走领域层：grantCredits 在**同一个事务**里写
      //    append-only 的 credit_ledger 与余额，绝不 UPDATE 余额了事。
      const granted = grantCredits(db, {
        accountId,
        deltaMilli: creditsToMilli(credits),
        kind: 'grant',
        operator: ctx.operator || 'cli',
        note: plan ? `开号初始额度（套餐：${plan.name}）` : '开号初始额度',
        nowMs,
      })
      logAdminAction(db, {
        adminName: ctx.operator, action: 'account_create', target: user, nowMs,
        detail: {
          account_id: accountId, plan: plan ? plan.name : null, credits,
          expires_ms: expiresMs, device_limit: deviceLimit === undefined ? 1 : deviceLimit,
        },
      })

      out.write(`✅ 商家账号已创建：${user}（account_id=${accountId}）\n`)
      out.write(`   套餐：${plan ? `${plan.name}（有效 ${Number(plan.valid_days)} 天）` : '未指定'}\n`)
      out.write(`   到期：${expiresMs ? fmtTime(expiresMs) : '不限期'}\n`)
      out.write(`   设备上限：${deviceLimit === undefined ? 1 : deviceLimit}\n`)
      out.write(`   积分：${credits}（余额 ${milliToCredits(granted.balance_milli)}）\n`)
      out.write(`   备注：${note}\n`)
      if (generated) {
        out.write(`\n🔑 初始密码（**只显示这一次**，请立即抄给商家）：${password}\n`)
      } else {
        out.write('   密码：已按你提供的内容设置\n')
      }
      return EXIT.OK
    }

    case 'list': {
      const status = optFlag(flags, 'status')
      if (status !== undefined && !ACCOUNT_STATUSES.includes(status)) {
        throw new UsageError(`--status 只能是 active|disabled|expired，实际为 ${status}`)
      }
      const rows = db.prepare(`
        SELECT a.*, c.balance_milli,
               (SELECT COUNT(*) FROM device_session s
                 WHERE s.account_id = a.account_id AND s.revoked_at_ms IS NULL
                   AND s.expires_at_ms > ?1) AS live_sessions
        FROM account a LEFT JOIN credit c ON c.account_id = a.account_id
        ${status ? 'WHERE a.status = ?2' : ''}
        ORDER BY a.account_id
      `).all(...(status ? [nowMs, status] : [nowMs]))

      const items = rows.map((r) => accountSummary(ctx, db, r, nowMs))
      if (flags.json) { printJson(out, items); return EXIT.OK }

      if (!items.length) {
        out.write('（没有符合条件的账号）\n')
        return EXIT.OK
      }
      out.write(renderTable(
        ['账号', '状态', '套餐', '到期', '余额', '可发条数', '等级', '第N天', '在线', '最后心跳'],
        items.map((i) => [
          i.account, statusLabel(i.status), i.plan_name || '—',
          i.plan_expires_ms ? fmtDay(i.plan_expires_ms) : '不限期',
          i.balance_credits, i.replies_affordable,
          `${i.account_tier}${i.sending_enabled ? '' : '(停发)'}`, i.account_day_index,
          i.live_sessions > 0 ? `${i.live_sessions} 台` : '离线',
          i.last_heartbeat_ms ? fmtTime(i.last_heartbeat_ms) : '从未',
        ])
      ) + '\n')
      return EXIT.OK
    }

    case 'show': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const row = db.prepare(`
        SELECT a.*, c.balance_milli,
               (SELECT COUNT(*) FROM device_session s
                 WHERE s.account_id = a.account_id AND s.revoked_at_ms IS NULL
                   AND s.expires_at_ms > ?) AS live_sessions
        FROM account a LEFT JOIN credit c ON c.account_id = a.account_id
        WHERE a.account_id = ?
      `).get(nowMs, Number(account.account_id))
      const item = accountSummary(ctx, db, row, nowMs)
      const policy = currentPolicy(db, row, nowMs)
      const quota = quotaOf(db, row, policy, nowMs)
      const pv = policyRow(db, Number(row.account_id))

      const full = {
        ...item,
        note: row.note,
        device_limit: Number(row.device_limit),
        created_at_ms: Number(row.created_at_ms),
        first_login_ms: row.first_login_ms === null ? null : Number(row.first_login_ms),
        policy_version: pv ? Number(pv.policy_version) : policy.policy_version,
        policy_override_version: pv ? Number(pv.policy_version) : null,
        policy_hash: policy.policy_hash,
        daily_quota: quota,
        limits: policy.limits,
        active_hours: policy.active_hours.windows,
        sending_enabled: policy.sending_enabled,
        ledger_entries: Number(db.prepare(
          'SELECT COUNT(*) AS c FROM credit_ledger WHERE account_id = ?'
        ).get(Number(row.account_id)).c),
      }
      if (flags.json) { printJson(out, full); return EXIT.OK }

      out.write(`账号：${item.account}（account_id=${item.account_id}）\n`)
      out.write(`状态：${statusLabel(item.status)}   设备上限：${item.device_limit}   在线会话：${item.live_sessions}\n`)
      out.write(`套餐：${item.plan_name || '未指定'}   到期：${item.plan_expires_ms ? fmtTime(item.plan_expires_ms) : '不限期'}\n`)
      out.write(`余额：${item.balance_credits} 积分（${item.balance_milli} 毫单位），可发 ${item.replies_affordable} 条\n`)
      out.write(`创建：${fmtTime(item.created_at_ms)}   首次登录：${item.first_login_ms ? fmtTime(item.first_login_ms) : '从未'}\n`)
      out.write(`最后心跳：${item.last_heartbeat_ms ? fmtTime(item.last_heartbeat_ms) : '从未'}\n`)
      out.write(`备注：${full.note || '—'}\n`)
      out.write(`策略：v${full.policy_version}  等级 ${policy.account_tier}（第 ${policy.account_day_index} 天）` +
        `  发送 ${policy.sending_enabled ? '已启用' : '已停用（观察期只采集）'}\n`)
      out.write('今日额度：\n')
      out.write(renderTable(
        ['渠道', '上限', '已用', '剩余'],
        SOURCE_TYPES.map((s) => [
          `${SOURCE_LABELS[s]}(${s})`, quota[s].max, quota[s].used, quota[s].remaining,
        ])
      ) + '\n')
      out.write(`活跃时段：${policy.active_hours.windows.map((w) => `${w[0]}–${w[1]}`).join('、')}` +
        `（UTC+${TZ_OFFSET_MINUTES / 60}）\n`)
      out.write('各渠道上限（含最小间隔毫秒 / 相似度上限）：\n')
      out.write(renderTable(
        ['渠道', '日上限', '最小间隔ms', '相似度上限'],
        SOURCE_TYPES.map((s) => [
          SOURCE_LABELS[s], policy.limits[s].daily_max,
          policy.limits[s].min_interval_ms, policy.limits[s].content_similarity_max,
        ])
      ) + '\n')
      out.write(`台账条数：${full.ledger_entries}（append-only，绝不修改）\n`)
      return EXIT.OK
    }

    case 'disable': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      if (account.status === 'disabled') {
        out.write(`账号 ${user} 已经是停用状态，未重复操作\n`)
        return EXIT.OK
      }
      db.prepare('UPDATE account SET status = ?, updated_at_ms = ? WHERE account_id = ?')
        .run('disabled', nowMs, accountId)
      const revoked = revokeSessions(db, { accountId, reason: 'account_disabled', nowMs })
      logAdminAction(db, {
        adminName: ctx.operator, action: 'account_disable', target: user, nowMs,
        detail: { revoked_sessions: revoked },
      })
      out.write(`✅ 已停用账号：${user}\n`)
      out.write(`   已吊销会话：${revoked} 个（该账号的客户端会立刻收到 403 AUTH_ACCOUNT_DISABLED）\n`)
      return EXIT.OK
    }

    case 'enable': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      const expires = Number(account.plan_expires_ms || 0)
      if (expires > 0 && expires <= nowMs) {
        throw new CliError(
          `账号 ${user} 的套餐已于 ${fmtTime(expires)} 到期，仅启用状态无法登录。\n` +
          '  请先续期（credit redeem / 手工改 plan_expires_ms 需运维确认），或重新开号。'
        )
      }
      db.prepare('UPDATE account SET status = ?, updated_at_ms = ? WHERE account_id = ?')
        .run('active', nowMs, accountId)
      logAdminAction(db, { adminName: ctx.operator, action: 'account_enable', target: user, nowMs })
      out.write(`✅ 已启用账号：${user}\n`)
      return EXIT.OK
    }

    case 'reset-password': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)

      let password
      let generated = false
      if (flags['password-stdin'] || flags.password !== undefined) {
        password = await readPassword(flags, ctx.io)
      } else if (ctx.io.stdinIsTTY) {
        password = await promptPassword(ctx.io, `为账号 ${user} 设置新密码（直接回车＝自动生成）：`)
      } else {
        password = generatePassword(20)
        generated = true
      }
      assertPasswordStrength(password)

      db.prepare('UPDATE account SET pass_hash = ?, updated_at_ms = ? WHERE account_id = ?')
        .run(hashPassword(password), nowMs, accountId)
      const revoked = revokeSessions(db, { accountId, reason: 'password_reset', nowMs })
      logAdminAction(db, {
        adminName: ctx.operator, action: 'account_reset_password', target: user, nowMs,
        detail: { revoked_sessions: revoked },
      })
      out.write(`✅ 已重置账号密码：${user}\n`)
      out.write(`   已吊销会话：${revoked} 个（旧客户端必须重新登录）\n`)
      if (generated) out.write(`\n🔑 新密码（**只显示这一次**）：${password}\n`)
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'account', action)
  }
}

/** 账号列表/详情共用的派生字段。全部由 policy 层推导，不写死数值。 */
function accountSummary(ctx, db, row, nowMs) {
  const accountId = Number(row.account_id)
  const balanceMilli = row.balance_milli === null || row.balance_milli === undefined
    ? getBalanceMilli(db, accountId) : Number(row.balance_milli)
  const policy = currentPolicy(db, row, nowMs)
  const plan = row.plan_id
    ? db.prepare('SELECT name, credits, valid_days, plan_key FROM plan WHERE plan_id = ?').get(Number(row.plan_id))
    : null
  const hb = db.prepare('SELECT MAX(last_seen_ms) AS m FROM device_session WHERE account_id = ?')
    .get(accountId)
  const unit = ctx.unit

  let status = row.status
  if (status === 'active' && row.plan_expires_ms && Number(row.plan_expires_ms) <= nowMs) {
    status = 'expired'
  }

  return {
    account_id: accountId,
    account: row.account,
    status,
    plan_name: plan ? plan.name : null,
    plan_expires_ms: row.plan_expires_ms === null || row.plan_expires_ms === undefined
      ? null : Number(row.plan_expires_ms),
    balance_milli: balanceMilli,
    balance_credits: milliToCredits(balanceMilli),
    replies_affordable: Math.floor(Math.max(balanceMilli, 0) / unit),
    account_tier: policy.account_tier,
    account_day_index: policy.account_day_index,
    sending_enabled: policy.sending_enabled,
    policy_version: policy.policy_version,
    device_limit: Number(row.device_limit),
    created_at_ms: Number(row.created_at_ms),
    first_login_ms: row.first_login_ms === null || row.first_login_ms === undefined
      ? null : Number(row.first_login_ms),
    live_sessions: Number(row.live_sessions || 0),
    last_heartbeat_ms: hb && hb.m ? Number(hb.m) : null,
  }
}

function statusLabel(status) {
  return { active: '正常', disabled: '已停用', expired: '已到期' }[status] || status
}

/**
 * 单条成功回复的积分单价（毫单位）。
 *
 * ⚠️ 由 config 提供（`CREDIT_PER_REPLY_MILLI`），**不在本文件写 1000**。
 *    改价只影响之后的扣费，历史台账不动（protocol.md §6.7）。
 */

/** 某账号当日额度（上限来自等级表，已用来自 send_log 派生）。 */
function quotaOf(db, account, policy, nowMs) {
  const accountId = Number(account.account_id)
  const dayIndex = policy.account_day_index
  const out = {}
  for (const src of SOURCE_TYPES) {
    const tierDef = tierForDayIndex(dayIndex)
    const max = tierDef.limits[src].daily_max
    const used = Number(db.prepare(`
      SELECT COUNT(*) AS c FROM send_log
      WHERE account_id = ? AND source_type = ?
        AND sent_at_ms >= ? AND sent_at_ms < ?
        AND verdict = 'sent_confirmed' AND billing_status = 'billed'
    `).get(accountId, src, dayStartMs(nowMs), dayStartMs(nowMs) + MS_PER_DAY).c)
    out[src] = { max, used, remaining: Math.max(0, max - used) }
  }
  return out
}

function policyRow(db, accountId) {
  return db.prepare('SELECT * FROM policy WHERE account_id = ?').get(accountId) || null
}

function findPlanByName(db, name) {
  const row = db.prepare('SELECT * FROM plan WHERE name = ? AND active = 1').get(String(name))
  if (!row) {
    const all = db.prepare('SELECT name FROM plan WHERE active = 1 ORDER BY plan_id').all()
      .map((r) => r.name)
    throw new CliError(
      `套餐不存在或已停用：${name}\n` +
      (all.length ? `  现有套餐：${all.join('、')}` : `  尚未创建套餐，请先执行：${RC} plan set --name "..." --credits ${minPlanCredit()}`)
    )
  }
  return row
}

/** 吊销会话。返回受影响条数。 */
function revokeSessions(db, { accountId, all, reason, nowMs }) {
  if (all) {
    const r = db.prepare(`
      UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ?
      WHERE revoked_at_ms IS NULL
    `).run(nowMs, reason)
    return Number(r.changes)
  }
  const r = db.prepare(`
    UPDATE device_session SET revoked_at_ms = ?, revoked_reason = ?
    WHERE account_id = ? AND revoked_at_ms IS NULL
  `).run(nowMs, reason, accountId)
  return Number(r.changes)
}

/** 统一的"积分低于最低套餐积分"错误（消息里的数字全部推导而来）。 */
function quotaBelowMinError(credits, minimum, subject) {
  return new CliError(
    `拒绝：${subject ? `${subject}的积分为 ` : '发放积分 '}${credits}，` +
    `低于套餐最低积分 ${minimum}（PLAN_QUOTA_BELOW_MIN）\n` +
    `  最低值由 tier_table 推导：稳定期三渠道日上限合计 ${stableDailyMaxTotal()} × 180 天 = ${minimum}。\n` +
    '  旧值 4500 / 4320 属于已作废的按小时计费口径，现在会直接失败。\n' +
    `  请改用 ≥ ${minimum} 的积分数（例如半年套餐 ${planCreditsFor(180)}、年套餐 ${planCreditsFor(365)}）。`,
    { code: 'PLAN_QUOTA_BELOW_MIN', min_plan_credit: minimum, reported: credits }
  )
}

// ═══════════════════════════════════════════════════════════
// credit
// ═══════════════════════════════════════════════════════════

function cmdCredit(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  // `credit ledger tail --user <名>`：positional = ['credit','ledger','tail']。
  // 所以 action 是 'ledger'，真正的子动作在 positional[2]。
  if (action === 'ledger') {
    const sub = args.positional[2]
    if (sub !== 'tail') {
      ctx.io.err.write(`未知的 credit 子命令：ledger ${sub === undefined ? '（缺少 tail）' : sub}\n\n` +
        (groupHelp('credit') || '') + '\n')
      return EXIT.USAGE
    }
    return ledgerTail(ctx, db, flags, nowMs)
  }

  switch (action) {
    case 'grant':
    case 'revoke': {
      const user = requireFlag(flags, 'user')
      const amount = intFlag(flags, 'amount', { required: true })
      const reason = requireFlag(flags, 'reason')
      if (amount < 0) {
        throw new UsageError(`--amount 必须是正数（${action === 'revoke' ? '扣减方向由命令决定' : '加分'}），实际 ${amount}`)
      }
      if (amount === 0) {
        // 部署指南 §11.4：`credit grant --amount 0 --reason "对账修正"` 是
        // 文档里的显式台账修正入口，必须放行并落一条 0 分录。
        // ⚠️ 但 grantCredits 明确拒绝 0（deltaMilli === 0 → 抛错），
        //    所以 0 值走"只写一条 0 分录"的等价路径，仍然只 INSERT 台账。
      }
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      upsertCreditRow(db, accountId, nowMs)

      const deltaMilli = creditsToMilli(amount) * (action === 'revoke' ? -1 : 1)
      const kind = action === 'revoke' ? 'adjust' : 'grant'
      let balanceMilli

      if (deltaMilli === 0) {
        balanceMilli = getBalanceMilli(db, accountId)
        db.prepare(`
          INSERT INTO credit_ledger (
            account_id, kind, delta_milli, balance_after_milli, operator, note, settled_at_ms
          ) VALUES (?, ?, 0, ?, ?, ?, ?)
        `).run(accountId, kind, balanceMilli, ctx.operator || 'cli', `对账修正（0 值分录）：${reason}`, nowMs)
      } else {
        try {
          const r = grantCredits(db, {
            accountId,
            deltaMilli,
            kind,
            operator: ctx.operator || 'cli',
            note: reason,
            nowMs,
          })
          balanceMilli = Number(r.balance_milli)
        } catch (e) {
          // grantCredits 在余额将变负时抛 CREDIT_EXHAUSTED。
          // ⚠️ 不能"顺手改成扣到 0"：那会让台账与实际都不真实，
          //    运维以为扣干净了，其实账实不符。
          if (e && e.code === 'CREDIT_EXHAUSTED') {
            throw new CliError(
              `拒绝：扣减会让余额变成负数（当前 ${milliToCredits(e.detail && e.detail.balance_milli)} 积分，` +
              `本次扣 ${amount}）\n` +
              '  请先核对余额与台账（credit balance / credit ledger tail），再决定扣减额度。',
              e.detail || null
            )
          }
          throw e
        }
      }

      logAdminAction(db, {
        adminName: ctx.operator, action: action === 'revoke' ? 'credit_revoke' : 'credit_grant',
        target: user, nowMs, detail: { amount, reason, balance_milli: balanceMilli },
      })
      out.write(`${action === 'revoke' ? '✅ 已扣减' : '✅ 已发放'}：${user} ${action === 'revoke' ? '-' : '+'}${amount} 积分\n`)
      out.write(`   原因：${reason}\n`)
      out.write(`   当前余额：${milliToCredits(balanceMilli)} 积分（${balanceMilli} 毫单位）\n`)
      out.write(`   可发条数：${Math.floor(Math.max(balanceMilli, 0) / ctx.unit)}\n`)
      out.write('   台账已写入（append-only，历史分录不会被修改）\n')
      return EXIT.OK
    }

    case 'balance': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      const balanceMilli = getBalanceMilli(db, accountId)
      const billing = db.prepare('SELECT state, insufficient FROM account_billing WHERE account_id = ?')
        .get(accountId)
      const usedToday = Number(db.prepare(`
        SELECT COALESCE(-SUM(delta_milli), 0) AS m FROM credit_ledger
        WHERE account_id = ? AND kind = 'consume' AND settled_at_ms >= ? AND settled_at_ms < ?
      `).get(accountId, dayStartMs(nowMs), dayStartMs(nowMs) + MS_PER_DAY).m)
      const consumed = Number(db.prepare(`
        SELECT COALESCE(-SUM(delta_milli), 0) AS m FROM credit_ledger
        WHERE account_id = ? AND kind = 'consume'
      `).get(accountId).m)

      const info = {
        account: account.account,
        account_id: accountId,
        status: account.status,
        balance_milli: balanceMilli,
        balance_credits: milliToCredits(balanceMilli),
        credit_per_reply_milli: ctx.unit,
        replies_affordable: Math.floor(Math.max(balanceMilli, 0) / ctx.unit),
        used_today_milli: usedToday,
        consumed_total_milli: consumed,
        billing_state: billing ? billing.state : 'active',
        insufficient: billing ? Number(billing.insufficient) === 1 : false,
        plan_expires_ms: account.plan_expires_ms === null ? null : Number(account.plan_expires_ms),
      }
      if (flags.json) { printJson(out, info); return EXIT.OK }

      out.write(`账号：${info.account}\n`)
      out.write(`余额：${info.balance_credits} 积分（${balanceMilli} 毫单位）\n`)
      out.write(`单价：${milliToCredits(ctx.unit)} 积分/条（CREDIT_PER_REPLY_MILLI=${ctx.unit}）\n`)
      out.write(`可发条数：${info.replies_affordable}\n`)
      out.write(`今日消耗：${milliToCredits(usedToday)} 积分   累计消耗：${milliToCredits(consumed)} 积分\n`)
      out.write(`计费状态：${info.billing_state}${info.insufficient ? '（已触及透支边界）' : ''}\n`)
      out.write(`套餐到期：${info.plan_expires_ms ? fmtTime(info.plan_expires_ms) : '不限期'}\n`)
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'credit', action)
  }
}

function ledgerTail(ctx, db, flags, nowMs) {
  const { out } = ctx.io
  const user = requireFlag(flags, 'user')
  const account = getAccount(db, user)
  const limit = flags.n === undefined ? 50 : intFlag(flags, 'n', { min: 1, max: 1000 })
  const accountId = Number(account.account_id)

  const rows = db.prepare(`
    SELECT * FROM credit_ledger WHERE account_id = ?
    ORDER BY settled_at_ms DESC, id DESC LIMIT ?
  `).all(accountId, limit)

  const balanceMilli = getBalanceMilli(db, accountId)
  const items = rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    delta_milli: Number(r.delta_milli),
    delta_credits: milliToCredits(Number(r.delta_milli)),
    balance_after_milli: Number(r.balance_after_milli),
    ref_send_id: r.ref_send_id || null,
    ref_code_hash: r.ref_code_hash ? String(r.ref_code_hash).slice(0, 12) + '…' : null,
    operator: r.operator,
    note: r.note,
    settled_at_ms: Number(r.settled_at_ms),
  }))

  if (flags.json) {
    printJson(out, { account: account.account, balance_milli: balanceMilli, entries: items })
    return EXIT.OK
  }

  out.write(`账号：${account.account}   余额：${milliToCredits(balanceMilli)} 积分   ` +
    `（显示最近 ${items.length} 条，倒序）\n`)
  if (!items.length) {
    out.write('（该账号还没有任何台账记录）\n')
    return EXIT.OK
  }
  out.write(renderTable(
    ['ID', '类型', '变动(积分)', '落账后余额', '时间', '操作人', '说明'],
    items.map((i) => [
      i.id, i.kind, (i.delta_milli > 0 ? '+' : '') + i.delta_credits,
      milliToCredits(i.balance_after_milli), fmtTime(i.settled_at_ms), i.operator,
      truncate(i.note, 32),
    ])
  ) + '\n')

  // ⚠️ 台账自检：每条的 balance_after_milli 必须与"上一条 + 本条 delta"一致。
  //    不一致说明有人绕过领域层直接改了余额——这正是 append-only 要防的事。
  verifyLedgerChain(ctx, db, accountId)
  return EXIT.OK
}

/**
 * 台账链一致性自检。
 *
 * ⚠️ 只报告不修正。悄悄"抹平"会让真正的 bug 永远不被发现，
 *    而运维看到的台账看起来永远自洽——比不一致更危险（同 stats.js 的立场）。
 */
function verifyLedgerChain(ctx, db, accountId) {
  const rows = db.prepare(
    'SELECT id, delta_milli, balance_after_milli FROM credit_ledger WHERE account_id = ? ORDER BY id'
  ).all(accountId)
  let running = 0
  const bad = []
  for (const r of rows) {
    running += Number(r.delta_milli)
    if (running !== Number(r.balance_after_milli)) {
      bad.push(`#${Number(r.id)} 台账余额 ${Number(r.balance_after_milli)} ≠ 累计 ${running}`)
    }
  }
  const actual = getBalanceMilli(db, accountId)
  if (bad.length) {
    ctx.io.err.write(`⚠️  台账链不一致（${bad.length} 处）：\n`)
    for (const b of bad.slice(0, 10)) ctx.io.err.write(`     ${b}\n`)
    ctx.io.err.write('    这通常意味着有代码绕过 grantCredits 直接改了 credit.balance_milli。\n')
  }
  if (running !== actual) {
    ctx.io.err.write(
      `⚠️  台账合计 ${running} 与 credit.balance_milli ${actual} 不一致（差额 ${actual - running}）。\n` +
      '    请勿直接 UPDATE 余额：用 credit grant --amount <差额> --reason "对账修正" 走显式分录。\n'
    )
  }
}

function truncate(s, n) {
  const str = String(s === null || s === undefined ? '' : s)
  return displayWidth(str) <= n ? str : str.slice(0, n) + '…'
}

// ═══════════════════════════════════════════════════════════
// code（充值码）
// ═══════════════════════════════════════════════════════════

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_GROUPS = 4
const CODE_GROUP_LEN = 5

/** 生成形如 XXXX-XXXX-XXXX-XXXX 的卡密（与服务端 routes-credit.js 同格式）。 */
function makeCode() {
  const groups = []
  for (let g = 0; g < CODE_GROUPS; g++) {
    const bytes = crypto.randomBytes(CODE_GROUP_LEN)
    let s = ''
    for (let i = 0; i < CODE_GROUP_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    groups.push(s)
  }
  return groups.join('-')
}

function normalizeCode(raw) {
  return String(raw).trim().toUpperCase()
}

/** 卡密掩码：只显示末 4 位（库里只有哈希，本来就取不回明文）。 */
function maskCode(code) {
  const c = normalizeCode(code)
  return `****-****-****-${c.slice(-4)}`
}

function cmdCode(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'batch': {
      const count = intFlag(flags, 'count', { min: 1, max: 10000, required: true })
      const credits = intFlag(flags, 'credits', { min: 1, required: true })
      const minimum = minPlanCredit()
      if (credits < minimum) throw quotaBelowMinError(credits, minimum, '本批卡密')
      const planName = optFlag(flags, 'plan')
      const plan = planName ? findPlanByName(db, planName) : null
      const batch = optFlag(flags, 'batch') || ''
      const outFile = optFlag(flags, 'out')
      const validDays = flags['valid-days'] !== undefined
        ? intFlag(flags, 'valid-days', { min: 1, max: 3650 })
        : (plan ? Number(plan.valid_days) : undefined)

      // ⚠️ 明文只在这一次出现在内存里，库中只存 sha256。
      //    因此落盘失败就是永久损失，必须在插入前先确认可写。
      if (outFile && fs.existsSync(outFile)) {
        throw new CliError(`--out 目标已存在，拒绝覆盖（卡密文件覆盖即丢失）：${outFile}`)
      }

      const codes = []
      const ins = db.prepare(`
        INSERT INTO redeem_code (
          code_hash, plan_id, kind, credits, valid_days, batch, created_at_ms, expires_at_ms
        ) VALUES (?,?,?,?,?,?,?,?)
      `)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (let i = 0; i < count; i++) {
          let code = null
          for (let tries = 0; tries < 8; tries++) {
            const candidate = makeCode()
            if (!db.prepare('SELECT id FROM redeem_code WHERE code_hash = ?').get(sha256Hex(candidate))) {
              code = candidate
              break
            }
          }
          if (!code) throw new CliError('卡密生成冲突过多，已回滚，请重试')
          ins.run(
            sha256Hex(code), plan ? Number(plan.plan_id) : null,
            plan ? 'plan' : 'credits', credits,
            validDays === undefined ? null : validDays,
            batch, nowMs, null
          )
          codes.push(code)
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      logAdminAction(db, {
        adminName: ctx.operator, action: 'code_batch', target: batch || '(无批次名)', nowMs,
        detail: { count, credits, plan: plan ? plan.name : null, valid_days: validDays === undefined ? null : validDays },
      })

      out.write(`✅ 已生成 ${codes.length} 张充值码\n`)
      out.write(`   面额：${credits} 积分/张   套餐：${plan ? plan.name : '（未绑定）'}` +
        `   有效期：${validDays === undefined ? '（未绑定）' : `${validDays} 天`}   批次：${batch || '（无）'}\n`)
      out.write('⚠️  明文卡密只在本行输出一次；库中只存 sha256，之后无法再取回。\n\n')
      for (const c of codes) out.write(`${c}\n`)

      if (outFile) {
        const header = [
          `# 充值码批次：${batch || '(无)'}`,
          `# 生成时间：${fmtTime(nowMs)}（UTC+8）  面额：${credits} 积分/张  数量：${codes.length}`,
          `# 套餐：${plan ? plan.name : '（未绑定）'}  有效期：${validDays === undefined ? '（未绑定）' : `${validDays} 天`}`,
          '# ⚠️ 本文件含卡密明文，等价于现金：请 chmod 600、勿进 git、勿走群聊/邮件。',
          '# 库中只存 sha256(code)，此文件丢失后无法再生成同样的卡密。',
          'code,credits,batch',
        ].join('\n')
        const body = codes.map((c) => `${c},${credits},${csvEscape(batch)}`).join('\n')
        fs.writeFileSync(outFile, header + '\n' + body + '\n', { encoding: 'utf8', mode: 0o600 })
        const res = chmod600(outFile)
        out.write(`\n[文件] 已写入：${outFile}（${codes.length} 行）\n`)
        writeChmodNote(ctx.io, res, outFile)
      } else {
        out.write('\n[提示] 未指定 --out，明文仅存在于本次标准输出。建议加 --out 落盘并 chmod 600。\n')
      }
      return EXIT.OK
    }

    case 'list': {
      const batch = optFlag(flags, 'batch')
      const onlyUnused = flags.unused === true
      const rows = db.prepare(`
        SELECT c.*, p.name AS plan_name
        FROM redeem_code c LEFT JOIN plan p ON p.plan_id = c.plan_id
        WHERE 1 = 1
          ${batch !== undefined ? 'AND c.batch = ?' : ''}
          ${onlyUnused ? 'AND c.used_at_ms IS NULL AND c.disabled_at_ms IS NULL' : ''}
        ORDER BY c.id
      `).all(...(batch !== undefined ? [batch] : []))

      const items = rows.map((r) => ({
        id: Number(r.id),
        code_hash_prefix: String(r.code_hash).slice(0, 12),
        plan_name: r.plan_name || null,
        kind: r.kind,
        credits: Number(r.credits),
        valid_days: r.valid_days === null ? null : Number(r.valid_days),
        batch: r.batch,
        state: r.disabled_at_ms ? 'disabled' : (r.used_at_ms ? 'used' : 'unused'),
        used_by: r.used_by === null ? null : Number(r.used_by),
        used_at_ms: r.used_at_ms === null ? null : Number(r.used_at_ms),
        created_at_ms: Number(r.created_at_ms),
      }))
      if (flags.json) { printJson(out, items); return EXIT.OK }

      if (!items.length) {
        out.write('（没有符合条件的充值码）\n')
        return EXIT.OK
      }
      const stateLabel = { unused: '未使用', used: '已使用', disabled: '已作废' }
      out.write(renderTable(
        ['ID', '哈希前12位', '面额', '套餐', '批次', '状态', '使用于', '使用时间'],
        items.map((i) => [
          i.id, i.code_hash_prefix, i.credits, i.plan_name || '—', i.batch || '—',
          stateLabel[i.state], i.used_by === null ? '—' : `#${i.used_by}`,
          i.used_at_ms ? fmtTime(i.used_at_ms) : '—',
        ])
      ) + '\n')
      out.write(`共 ${items.length} 张。⚠️ 只存哈希，无法从哈希还原明文卡密。\n`)
      return EXIT.OK
    }

    case 'revoke': {
      const code = normalizeCode(requireFlag(flags, 'code'))
      const hash = sha256Hex(code)
      const row = db.prepare('SELECT * FROM redeem_code WHERE code_hash = ?').get(hash)
      if (!row) throw new CliError('卡密不存在（库中只存哈希；请核对明文是否抄错）')
      if (row.used_at_ms) {
        throw new CliError(
          `该卡密已于 ${fmtTime(Number(row.used_at_ms))} 被账号 #${Number(row.used_by)} 使用，不能作废。\n` +
          '  已兑换的积分在 append-only 台账里，如需扣回请走 credit revoke 并说明原因。'
        )
      }
      if (row.disabled_at_ms) {
        out.write(`卡密 ${maskCode(code)} 已经是作废状态，未重复操作\n`)
        return EXIT.OK
      }
      db.prepare('UPDATE redeem_code SET disabled_at_ms = ? WHERE id = ?').run(nowMs, Number(row.id))
      logAdminAction(db, {
        adminName: ctx.operator, action: 'code_revoke', target: maskCode(code), nowMs,
        detail: { code_hash_prefix: hash.slice(0, 12), credits: Number(row.credits), batch: row.batch },
      })
      out.write(`✅ 已作废卡密：${maskCode(code)}（面额 ${Number(row.credits)} 积分，批次 ${row.batch || '（无）'}）\n`)
      out.write('   该卡密此后兑换会返回 CREDIT_REDEEM_CODE_DISABLED。\n')
      return EXIT.OK
    }

    case 'redeem': {
      const code = normalizeCode(requireFlag(flags, 'code'))
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      const hash = sha256Hex(code)

      const row = db.prepare('SELECT * FROM redeem_code WHERE code_hash = ?').get(hash)
      if (!row) throw new CliError('卡密无效（请核对明文）')
      if (row.disabled_at_ms) throw new CliError('该卡密已作废，请联系客服换新')
      if (row.used_by) {
        throw new CliError(
          `该卡密已被使用：账号 #${Number(row.used_by)}，时间 ${fmtTime(Number(row.used_at_ms))}\n` +
          '  同一卡密只能兑换一次（唯一索引 + BEGIN IMMEDIATE 保证并发下也只成功一个）。'
        )
      }
      if (row.expires_at_ms && Number(row.expires_at_ms) < nowMs) {
        throw new CliError(`该卡密已于 ${fmtTime(Number(row.expires_at_ms))} 过期`)
      }

      upsertCreditRow(db, accountId, nowMs)
      upsertBillingRow(db, accountId, 'active', nowMs)

      // 原子占用：条件更新，并发下只有一个成功
      db.exec('BEGIN IMMEDIATE')
      try {
        const upd = db.prepare(`
          UPDATE redeem_code SET used_by = ?, used_at_ms = ?
          WHERE code_hash = ? AND used_by IS NULL AND disabled_at_ms IS NULL
        `).run(accountId, nowMs, hash)
        if (Number(upd.changes) === 0) {
          throw new CliError('该卡密已被使用（并发兑换）')
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      const credits = Number(row.credits)
      const g = grantCredits(db, {
        accountId,
        deltaMilli: creditsToMilli(credits),
        kind: 'redeem',
        operator: ctx.operator || 'cli',
        note: `代客兑换卡密 ${maskCode(code)}`,
        nowMs,
        refCodeHash: hash,
      })

      let expiresMs = account.plan_expires_ms === null ? null : Number(account.plan_expires_ms)
      if (row.valid_days) {
        const base = Math.max(Number(account.plan_expires_ms || 0), nowMs)
        expiresMs = base + Number(row.valid_days) * MS_PER_DAY
        db.prepare(`
          UPDATE account SET plan_id = COALESCE(?, plan_id), plan_expires_ms = ?,
                             status = 'active', updated_at_ms = ?
          WHERE account_id = ?
        `).run(row.plan_id === null ? null : Number(row.plan_id), expiresMs, nowMs, accountId)
      }

      logAdminAction(db, {
        adminName: ctx.operator, action: 'code_redeem', target: user, nowMs,
        detail: { code_hash_prefix: hash.slice(0, 12), credits, balance_milli: Number(g.balance_milli) },
      })

      out.write(`✅ 已为 ${user} 兑换卡密 ${maskCode(code)}\n`)
      out.write(`   入账：+${credits} 积分   余额：${milliToCredits(g.balance_milli)} 积分\n`)
      if (row.valid_days) out.write(`   套餐有效期延长 ${Number(row.valid_days)} 天 → ${fmtTime(expiresMs)}\n`)
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'code', action)
  }
}

function csvEscape(v) {
  const s = String(v === null || v === undefined ? '' : v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// ═══════════════════════════════════════════════════════════
// session
// ═══════════════════════════════════════════════════════════

function cmdSession(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'list': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      const rows = db.prepare(`
        SELECT * FROM device_session WHERE account_id = ? ORDER BY last_seen_ms DESC
      `).all(accountId)

      const items = rows.map((r) => ({
        id: Number(r.id),
        device_id: r.device_id,
        issued_at_ms: Number(r.issued_at_ms),
        last_seen_ms: Number(r.last_seen_ms),
        expires_at_ms: Number(r.expires_at_ms),
        revoked_at_ms: r.revoked_at_ms === null ? null : Number(r.revoked_at_ms),
        revoked_reason: r.revoked_reason || null,
        max_seq: Number(r.max_seq),
        state: r.revoked_at_ms !== null ? 'revoked'
          : (Number(r.expires_at_ms) <= nowMs ? 'expired' : 'online'),
      }))
      if (flags.json) { printJson(out, items); return EXIT.OK }

      if (!items.length) {
        out.write(`账号 ${user} 还没有任何会话记录（从未登录成功）\n`)
        return EXIT.OK
      }
      const stateLabel = { online: '在线', expired: '已过期', revoked: '已吊销' }
      out.write(renderTable(
        ['会话ID', '设备', '状态', '签发时间', '最后心跳', '到期时间', '吊销原因'],
        items.map((i) => [
          i.id, i.device_id.slice(0, 12) + '…', stateLabel[i.state],
          fmtTime(i.issued_at_ms), fmtTime(i.last_seen_ms), fmtTime(i.expires_at_ms),
          i.revoked_reason || '—',
        ])
      ) + '\n')
      out.write(`账号 ${user}：共 ${items.length} 个会话，其中在线 ${items.filter((i) => i.state === 'online').length} 个\n`)
      return EXIT.OK
    }

    case 'revoke': {
      if (flags.all === true) {
        const n = revokeSessions(db, { all: true, reason: 'admin_revoke_all', nowMs })
        logAdminAction(db, {
          adminName: ctx.operator, action: 'session_revoke_all', target: '*', nowMs,
          detail: { revoked: n },
        })
        out.write(`✅ 已吊销全平台全部未失效会话：${n} 个\n`)
        out.write('⚠️  所有商家客户端会立刻被踢（AUTH_TOKEN_REVOKED），需重新登录。\n')
        return EXIT.OK
      }
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const n = revokeSessions(db, { accountId: Number(account.account_id), reason: 'admin_revoke', nowMs })
      logAdminAction(db, {
        adminName: ctx.operator, action: 'session_revoke', target: user, nowMs,
        detail: { revoked: n },
      })
      out.write(`✅ 已吊销账号 ${user} 的全部未失效会话：${n} 个\n`)
      if (n === 0) out.write('   （该账号当前没有有效会话）\n')
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'session', action)
  }
}

// ═══════════════════════════════════════════════════════════
// policy —— 红线 1 的运维入口
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 安全上限字段：**任何**以它们为目标的放宽都必须拒绝。
 *
 *   `limits.<渠道>.daily_max`              只能调低
 *   `limits.<渠道>.min_interval_ms`        只能调高（且在允许区间内）
 *   `limits.<渠道>.content_similarity_max` 只能调低
 *   `active_hours`                         只能调短、窗口数不得增加
 *
 * 为什么连"厂商自己"也不让放开：`AGENTS.md` 红线 1 的措辞是
 * "客户端只能更保守"，而 tier_table 是**全系统唯一来源**。
 * 一旦允许按账号放宽，就等于给了一条绕过等级表的暗门：
 * 出事时无法解释"为什么这个账号的上限与规格不一致"，而且
 * 商家会以此为范例要求同样放宽。正确路线只有两条：
 *   ① 改 tier_table（厂商级、全体商家同步生效，且必须重算
 *      stable_daily_max_total / plan.credits / min_plan_credit /
 *      quota_notice 文案 —— protocol.md §8.2）
 *   ② 等天数自然推进等级（观察期→预热期→爬坡期→稳定期）
 */
const SAFETY_FIELDS = Object.freeze([
  'daily_max', 'min_interval_ms', 'content_similarity_max',
])

/** 明确**不允许**出现的键前缀/整键（给出针对性的拒绝消息）。 */
const FORBIDDEN_POLICY_KEYS = Object.freeze([
  'account_tier', 'tier', 'sending_enabled', 'collect_only',
  'policy_hash', 'policy_version', 'account_id', 'generated_at_ms',
  'tier_day_from', 'tier_day_to', 'days_until_next_tier', 'next_tier',
  'min_interval_ms_range', 'content_similarity_max_semantics',
])

/** 允许改的键（白名单）。方向由 `checkConservative` 逐个判定。 */
const ALLOWED_POLICY_KEYS = Object.freeze([
  'limits.comment.daily_max', 'limits.comment.min_interval_ms', 'limits.comment.content_similarity_max',
  'limits.live_danmaku.daily_max', 'limits.live_danmaku.min_interval_ms', 'limits.live_danmaku.content_similarity_max',
  'limits.dm.daily_max', 'limits.dm.min_interval_ms', 'limits.dm.content_similarity_max',
  'active_hours', 'active_hours.windows',
  'circuit_breaker.failure_rate_threshold', 'circuit_breaker.failure_rate_window',
  'circuit_breaker.platform_reject_threshold', 'circuit_breaker.cooldown_ms',
  'circuit_breaker.cooldown_l2_ms', 'circuit_breaker.risk_code_cooldown_ms',
  'idle_pause_ms',
])

/** 扁平别名 → 规范键（`limits.comment.daily_max` ≡ `comment.daily_max`）。 */
function canonicalPolicyKey(rawKey) {
  let k = String(rawKey).trim()
  if (/^(comment|live_danmaku|dm)\.(daily_max|min_interval_ms|content_similarity_max)$/.test(k)) {
    k = `limits.${k}`
  }
  return k
}

const REDLINE1_HINT =
  '⚠️ 这属于**安全上限**（AGENTS.md 红线 1）：安全上限由服务端按 tier_table 下发，' +
  '只能朝更保守的方向调整。按账号放开等于给等级表开了一条暗门——\n' +
  '   出事时无法解释"为什么这个账号的上限与规格不一致"，且其他商家会据此要求同样放宽。\n' +
  '   正确路线只有两条：\n' +
  '     ① 厂商级统一调整 tier_table（全体商家同步生效）。⚠️ 改表后必须重算\n' +
  '        stable_daily_max_total / plan.credits / min_plan_credit / quota_notice 文案\n' +
  '        与看板日上限（shared/protocol.md §8.2），并重新执行 plan set。\n' +
  '     ② 等天数自然推进等级：观察期(1-3天,上限0) → 预热期 → 爬坡期 → 稳定期。'

/**
 * 判定一项变更是否"更保守或等价"。
 *
 * ⚠️ 四个方向分开判定，最容易写反的是 content_similarity_max：
 *    语义是"相似度**超过**该值即拒绝"（AGENTS.md 误实现 2.4），
 *    所以**调低**它才是更保守。
 *
 * @returns {string|null} null 表示合规；否则返回拒绝原因
 */
function checkConservative(key, newValue, base) {
  if (key === 'active_hours' || key === 'active_hours.windows') {
    const windows = normalizeWindows(newValue)
    if (!windows) return 'active_hours 必须是 [[\"HH:MM\",\"HH:MM\"]] 形式的窗口数组'
    if (!isActiveHoursShorterOrEqual({ windows }, base.active_hours)) {
      return 'active_hours 只能调短：不得延长窗口、不得新增窗口、不得跨天（服务端窗口 ' +
        `${base.active_hours.windows.map((w) => `${w[0]}–${w[1]}`).join('、')}）`
    }
    return null
  }

  const m = /^limits\.(\w+)\.(\w+)$/.exec(key)
  if (m) {
    const src = m[1]
    const field = m[2]
    if (!SOURCE_TYPES.includes(src)) return `未知渠道 ${src}（可选：${SOURCE_TYPES.join('/')}）`
    const allowed = base.limits[src][field]

    if (field === 'daily_max') {
      if (!Number.isInteger(newValue) || newValue < 0) return 'daily_max 必须是 ≥0 的整数'
      if (newValue > allowed) {
        return `${src}.daily_max 只能调低：当前等级(${base.account_tier})上限为 ${allowed}，试图改为 ${newValue}`
      }
      return null
    }
    if (field === 'min_interval_ms') {
      if (!Number.isInteger(newValue) || newValue <= 0) return 'min_interval_ms 必须是正整数（毫秒）'
      if (newValue < allowed) {
        return `${src}.min_interval_ms 只能调高：当前等级(${base.account_tier})为 ${allowed}ms，试图改为 ${newValue}ms`
      }
      const range = MIN_INTERVAL_MS_RANGE[src]
      if (newValue < range[0] || newValue > range[1]) {
        return `${src}.min_interval_ms 必须落在允许区间 ${range[0]}~${range[1]}ms 内，试图改为 ${newValue}ms`
      }
      return null
    }
    if (field === 'content_similarity_max') {
      if (typeof newValue !== 'number' || !(newValue > 0 && newValue <= 1)) {
        return 'content_similarity_max 必须是 (0, 1] 之间的小数'
      }
      if (newValue > allowed) {
        return `${src}.content_similarity_max 只能调低（语义：相似度**超过**该值即拒绝）：` +
          `当前为 ${allowed}，试图改为 ${newValue}`
      }
      return null
    }
    return `未知字段 ${field}（安全上限只允许 ${SAFETY_FIELDS.join(' / ')}）`
  }

  // circuit_breaker / idle_pause_ms：运维参数，允许改，但必须落在合法范围
  if (key.startsWith('circuit_breaker.')) {
    const f = key.slice('circuit_breaker.'.length)
    if (typeof newValue !== 'number' || !Number.isFinite(newValue)) return `${key} 必须是数字`
    if (f === 'failure_rate_threshold' && !(newValue > 0 && newValue <= 1)) {
      return 'failure_rate_threshold 必须是 (0, 1] 的小数'
    }
    if (f === 'failure_rate_window' && (!Number.isInteger(newValue) || newValue < 1)) {
      return 'failure_rate_window 必须是 ≥1 的整数'
    }
    if (f.endsWith('_ms') && (!Number.isInteger(newValue) || newValue < 0)) {
      return `${f} 必须是 ≥0 的整数（毫秒）`
    }
    if (f === 'platform_reject_threshold' && (!Number.isInteger(newValue) || newValue < 1)) {
      return 'platform_reject_threshold 必须是 ≥1 的整数'
    }
    return null
  }
  if (key === 'idle_pause_ms') {
    if (!Number.isInteger(newValue) || newValue < 0) return 'idle_pause_ms 必须是 ≥0 的整数（毫秒）'
    return null
  }
  return `不允许修改的键：${key}`
}

function normalizeWindows(v) {
  const arr = Array.isArray(v) ? v : (v && Array.isArray(v.windows) ? v.windows : null)
  if (!arr) return null
  const out = []
  for (const w of arr) {
    if (!Array.isArray(w) || w.length !== 2) return null
    if (!/^\d{1,2}:\d{2}$/.test(String(w[0])) || !/^\d{1,2}:\d{2}$/.test(String(w[1]))) return null
    out.push([String(w[0]), String(w[1])])
  }
  return out
}

/** 把 `k=v` 或 JSON 文件解析成 { key: value }（值做类型推断）。 */
function parseSetPairs(pairs) {
  const out = {}
  for (const raw of pairs) {
    const s = String(raw)
    const eq = s.indexOf('=')
    if (eq <= 0) throw new UsageError(`--set 需要 k=v 形式，实际为 ${s}`)
    const k = canonicalPolicyKey(s.slice(0, eq))
    const vRaw = s.slice(eq + 1).trim()
    out[k] = coerceValue(vRaw)
  }
  return out
}

/**
 * 字符串 → 值。
 *
 * ⚠️ 只接受 JSON 字面量（数字/布尔/数组/对象/带引号字符串）或裸字符串。
 *    绝不用 `eval`/`Function`——策略输入来自运维命令行，
 *    在这里执行任意代码等于把服务端配置面变成 RCE 面。
 */
function coerceValue(vRaw) {
  const s = String(vRaw).trim()
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (s === 'true' || s === 'false') return s === 'true'
  if (s === 'null') return null
  if (s.startsWith('[') || s.startsWith('{')) {
    try { return JSON.parse(s) } catch (e) {
      // ⚠️ 不吞异常：JSON 写错必须让运维看到"哪里错了"，
      //    否则会表现为"策略没生效"这种最难查的现象
      throw new UsageError(`值不是合法 JSON：${s}\n  ${e.message}`)
    }
  }
  return s
}

function cmdPolicy(ctx, action, args) {
  const { flags, lists } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'show': {
      const user = requireFlag(flags, 'user')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      const base = currentPolicy(db, account, nowMs, true)
      const stored = policyRow(db, accountId)
      const override = stored ? safeParseJson(stored.policy_json) : null
      const effective = mergeOverride(base, override)
      const globalVersion = globalPolicyVersion(db)
      const effectiveVersion = stored
        ? Math.max(globalVersion, Number(stored.policy_version))
        : globalVersion

      const history = flags.history
        ? db.prepare(
          'SELECT * FROM policy_history WHERE account_id = ? ORDER BY id DESC LIMIT 50'
        ).all(accountId)
        : []

      const payload = {
        account: account.account,
        account_id: accountId,
        account_tier: effective.account_tier,
        account_day_index: effective.account_day_index,
        sending_enabled: effective.sending_enabled,
        collect_only: effective.collect_only,
        days_until_next_tier: effective.days_until_next_tier,
        next_tier: effective.next_tier,
        policy_version: effectiveVersion,
        global_policy_version: globalVersion,
        policy_hash: effective.policy_hash,
        active_hours: effective.active_hours,
        limits: effective.limits,
        min_interval_ms_range: effective.min_interval_ms_range,
        circuit_breaker: effective.circuit_breaker,
        idle_pause_ms: effective.idle_pause_ms,
        override_json: override,
        override_updated_at_ms: stored ? Number(stored.updated_at_ms) : null,
        tier_table: TIER_TABLE,
        history: history.map((h) => ({
          id: Number(h.id),
          policy_version: Number(h.policy_version),
          operator: h.operator,
          reason: h.reason,
          created_at_ms: Number(h.created_at_ms),
          before: safeParseJson(h.before_json),
          after: safeParseJson(h.after_json),
        })),
      }

      if (flags.json) { printJson(out, payload); return EXIT.OK }

      out.write(`账号：${account.account}（account_id=${accountId}）\n`)
      out.write(`等级：${effective.account_tier}（第 ${effective.account_day_index} 天）` +
        `${effective.next_tier ? `，第 ${effective.account_day_index + (effective.days_until_next_tier || 0)} 天进入 ${effective.next_tier}` : '（已是最高档）'}\n`)
      out.write(`发送：${effective.sending_enabled ? '已启用' : '❌ 已停用（观察期只采集，客户端不可跳过）'}` +
        `   仅在采集：${effective.collect_only}\n`)
      out.write(`策略版本：v${effectiveVersion}` +
        `${effectiveVersion !== globalVersion ? `（账号级覆盖 v${effectiveVersion}，全局 v${globalVersion}）` : `（全局）`}` +
        `   哈希：${effective.policy_hash}` +
        `${override ? '   ⚠️ 存在账号级覆盖（见下）' : ''}\n`)
      out.write('各渠道上限（来自 tier_table，客户端只能更保守）：\n')
      out.write(renderTable(
        ['渠道', 'daily_max', 'min_interval_ms', 'content_similarity_max'],
        SOURCE_TYPES.map((s) => [
          `${SOURCE_LABELS[s]}(${s})`,
          effective.limits[s].daily_max,
          effective.limits[s].min_interval_ms,
          effective.limits[s].content_similarity_max,
        ])
      ) + '\n')
      out.write(`活跃时段：${effective.active_hours.windows.map((w) => `${w[0]}–${w[1]}`).join('、')}` +
        `（tz_offset_minutes=${effective.active_hours.tz_offset_minutes}）\n`)
      out.write(`熔断：失败率阈值 ${effective.circuit_breaker.failure_rate_threshold}` +
        ` / 窗口 ${effective.circuit_breaker.failure_rate_window}` +
        ` / 平台拒绝阈值 ${effective.circuit_breaker.platform_reject_threshold}` +
        ` / 冷却 ${effective.circuit_breaker.cooldown_ms}ms\n`)
      out.write(`空闲停扣：${effective.idle_pause_ms}ms\n`)
      if (override) {
        out.write('\n账号级覆盖（policy 表 policy_json）：\n')
        out.write(JSON.stringify(override, null, 2) + '\n')
      }
      if (flags.history) {
        out.write('\n变更历史（最近 50 条）：\n')
        if (!history.length) out.write('（无变更记录）\n')
        else {
          out.write(renderTable(
            ['ID', '版本', '操作人', '时间', '原因'],
            history.map((h) => [
              h.id, h.policy_version, h.operator, fmtTime(Number(h.created_at_ms)),
              truncate(h.reason, 40),
            ])
          ) + '\n')
        }
      }
      return EXIT.OK
    }

    case 'set': {
      const user = requireFlag(flags, 'user')
      const reason = requireFlag(flags, 'reason')
      const account = getAccount(db, user)
      const accountId = Number(account.account_id)
      const base = currentPolicy(db, account, nowMs)

      let changes = {}
      const file = optFlag(flags, 'file')
      if (file) {
        if (lists.set) throw new UsageError('--file 与 --set 不能同时使用')
        if (!fs.existsSync(file)) throw new CliError(`--file 不存在：${file}`)
        let parsed
        try {
          parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (e) {
          // ⚠️ 不吞：JSON 语法错必须报出文件与位置，否则表现为"策略没生效"
          throw new CliError(`--file 不是合法 JSON：${file}\n  ${e.message}`)
        }
        changes = flattenPolicyObject(parsed)
      } else {
        if (!lists.set || !lists.set.length) {
          throw new UsageError('policy set 至少需要一个 --set k=v（或 --file policy.json）')
        }
        changes = parseSetPairs(lists.set)
      }
      if (!Object.keys(changes).length) throw new UsageError('没有解析出任何变更项')

      // ── 逐项判定：白名单 + 更保守 ─────────────────────────
      const refusals = []
      const accepted = {}
      for (const [key, value] of Object.entries(changes)) {
        const flat = key.split('.')[0]
        if (FORBIDDEN_POLICY_KEYS.includes(key) || FORBIDDEN_POLICY_KEYS.includes(flat)) {
          refusals.push({
            key, value,
            message: `${key} 不可手工指定（等级只由天数推导、版本与哈希由服务端计算）。\n   ${REDLINE1_HINT}`,
          })
          continue
        }
        if (!ALLOWED_POLICY_KEYS.includes(key)) {
          refusals.push({
            key, value,
            message: `未知的配置项 ${key}。可改的键：\n     ${ALLOWED_POLICY_KEYS.join('\n     ')}\n   ${REDLINE1_HINT}`,
          })
          continue
        }
        const why = checkConservative(key, value, base)
        if (why) {
          refusals.push({ key, value, message: `${why}\n   ${REDLINE1_HINT}` })
          continue
        }
        accepted[key] = value
      }

      if (refusals.length) {
        out.write(`❌ 拒绝 ${refusals.length} 项变更（未写入 policy_history，策略版本未变）：\n\n`)
        for (const r of refusals) {
          out.write(`  · --set ${r.key}=${JSON.stringify(r.value)}\n    ${r.message}\n\n`)
        }
        if (!Object.keys(accepted).length) {
          throw new CliError(
            'policy set 未做任何修改（全部被拒）。\n' +
            '  安全上限的调整必须走 tier_table（厂商级）或等天数推进。'
          )
        }
        out.write(`将继续应用其余 ${Object.keys(accepted).length} 项保守变更。\n\n`)
      }

      // ── 写入：账号级覆盖 + policy_history + 版本自增 ────────
      const stored = policyRow(db, accountId)
      const beforeOverride = stored ? safeParseJson(stored.policy_json) : null
      const afterOverride = applyOverride(beforeOverride, accepted, base, nowMs)
      const nextVersion = Math.max(
        Number(stored ? stored.policy_version : 0),
        base.policy_version
      ) + 1

      const effectiveAfter = mergeOverride(base, afterOverride)
      effectiveAfter.policy_version = nextVersion

      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          INSERT INTO policy (account_id, policy_version, account_tier, policy_hash, policy_json, updated_at_ms)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(account_id) DO UPDATE SET
            policy_version = excluded.policy_version,
            account_tier   = excluded.account_tier,
            policy_hash    = excluded.policy_hash,
            policy_json    = excluded.policy_json,
            updated_at_ms  = excluded.updated_at_ms
        `).run(
          accountId, nextVersion, effectiveAfter.account_tier, effectiveAfter.policy_hash,
          JSON.stringify(afterOverride), nowMs
        )
        db.prepare(`
          INSERT INTO policy_history (
            policy_version, account_id, before_json, after_json, operator, reason, created_at_ms
          ) VALUES (?,?,?,?,?,?,?)
        `).run(
          nextVersion, accountId,
          beforeOverride ? JSON.stringify(beforeOverride) : null,
          JSON.stringify(afterOverride),
          ctx.operator || 'cli', reason, nowMs
        )
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      logAdminAction(db, {
        adminName: ctx.operator, action: 'policy_set', target: user, nowMs,
        detail: { policy_version: nextVersion, changes: accepted, reason },
      })

      out.write(`✅ 已更新账号策略：${user}\n`)
      out.write(`   策略版本：v${base.policy_version} → v${nextVersion}（已写入 policy_history）\n`)
      out.write(`   原因：${reason}\n`)
      out.write('   变更项（全部为更保守方向）：\n')
      for (const [k, v] of Object.entries(accepted)) {
        out.write(`     ${k} = ${JSON.stringify(v)}\n`)
      }
      out.write('\n生效后的各渠道上限：\n')
      out.write(renderTable(
        ['渠道', 'daily_max', 'min_interval_ms', 'content_similarity_max'],
        SOURCE_TYPES.map((s) => [
          SOURCE_LABELS[s],
          effectiveAfter.limits[s].daily_max,
          effectiveAfter.limits[s].min_interval_ms,
          effectiveAfter.limits[s].content_similarity_max,
        ])
      ) + '\n')
      out.write('⚠️  现状说明（知情项）：当前 server.js 的 buildPolicy() 每次请求都按\n' +
        '   "天数索引 + 全局策略版本"重新推导下发值，**尚未读取本表的账号级覆盖**。\n' +
        '   因此这条覆盖是"已登记、已留痕、已升版本"，要真正下发需要服务端在\n' +
        '   buildPolicy 时合并 policy_json（属另一处代码改动）。\n' +
        '   客户端最迟会在下一次心跳（≤60 秒）拉到新的 policy_version。\n')
      return EXIT.OK
    }

    case 'push': {
      if (flags.status === true) {
        return policyPushStatus(ctx, db, nowMs)
      }
      const all = flags.all === true
      if (!all) requireFlag(flags, 'user')

      const rows = all
        ? db.prepare('SELECT * FROM account ORDER BY account_id').all()
        : [getAccount(db, requireFlag(flags, 'user'))]

      const now = nowMs
      const items = rows.map((a) => {
        const accountId = Number(a.account_id)
        const stored = policyRow(db, accountId)
        const base = currentPolicy(db, a, now)
        const ack = db.prepare(`
          SELECT MAX(policy_version) AS v, MAX(last_seen_at_ms) AS t
          FROM policy_ack_log WHERE account_id = ?
        `).get(accountId)
        const session = db.prepare(`
          SELECT MAX(last_seen_ms) AS t FROM device_session
          WHERE account_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
        `).get(accountId, now)
        const target = stored ? Number(stored.policy_version) : base.policy_version
        const acked = ack && ack.v !== null ? Number(ack.v) : null
        return {
          account: a.account,
          account_id: accountId,
          account_tier: base.account_tier,
          account_day_index: base.account_day_index,
          policy_version: target,
          override: Boolean(stored),
          last_ack_version: acked,
          last_ack_at_ms: ack && ack.t !== null ? Number(ack.t) : null,
          last_seen_ms: session && session.t !== null ? Number(session.t) : null,
          lag: acked === null ? null : target - acked,
        }
      })

      if (flags.json) { printJson(out, items); return EXIT.OK }

      out.write('下发状态（客户端每次心跳都会重新拉取策略；版本落后即整体替换，正常 ≤60 秒生效）：\n')
      out.write(renderTable(
        ['账号', '等级', '第N天', '策略版本', '客户端已ack', '落后', '最后心跳'],
        items.map((i) => [
          i.account, i.account_tier, i.account_day_index,
          `${i.policy_version}${i.override ? '(有覆盖)' : ''}`,
          i.last_ack_version === null ? '从未 ack' : i.last_ack_version,
          i.lag === null ? '—' : (i.lag > 0 ? `落后 ${i.lag}` : '已同步'),
          i.last_seen_ms ? fmtTime(i.last_seen_ms) : '从未',
        ])
      ) + '\n')
      const behind = items.filter((i) => i.lag !== null && i.lag > 0)
      if (behind.length) {
        out.write(`⚠️  ${behind.length} 个账号的 ack 落后于当前版本（多为客户端长期离线）。\n`)
        out.write('   下发失败计数：journalctl -u dy-license | grep -c policy_push_fail\n')
      } else {
        out.write('所有已知会话的账号 ack 均不低于当前版本。\n')
      }
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'policy', action)
  }
}

function policyPushStatus(ctx, db, nowMs) {
  const { out } = ctx.io
  const global = globalPolicyVersion(db)
  const rows = db.prepare(`
    SELECT a.account, a.account_id, p.policy_version, p.updated_at_ms,
           (SELECT MAX(policy_version) FROM policy_ack_log k WHERE k.account_id = a.account_id) AS ack_v,
           (SELECT MAX(last_seen_at_ms) FROM policy_ack_log k WHERE k.account_id = a.account_id) AS ack_t
    FROM account a LEFT JOIN policy p ON p.account_id = a.account_id
    ORDER BY a.account_id
  `).all()
  const items = rows.map((r) => ({
    account: r.account,
    policy_version: r.policy_version === null ? global : Number(r.policy_version),
    has_override: r.policy_version !== null,
    override_updated_at_ms: r.updated_at_ms === null ? null : Number(r.updated_at_ms),
    last_ack_version: r.ack_v === null ? null : Number(r.ack_v),
    last_ack_at_ms: r.ack_t === null ? null : Number(r.ack_t),
  }))
  const payload = { global_policy_version: global, accounts: items }

  if (ctx.args && ctx.args.flags && ctx.args.flags.json) {
    printJson(out, payload)
    return EXIT.OK
  }
  out.write(`全局策略版本：v${global}（服务端每次心跳据此重新推导下发值）\n`)
  if (!items.length) {
    out.write('（还没有商家账号）\n')
    return EXIT.OK
  }
  out.write(renderTable(
    ['账号', '目标版本', '账号级覆盖', '最后 ack 版本', '最后 ack 时间'],
    items.map((i) => [
      i.account, i.policy_version, i.has_override ? '是' : '否',
      i.last_ack_version === null ? '从未' : i.last_ack_version,
      i.last_ack_at_ms ? fmtTime(i.last_ack_at_ms) : '—',
    ])
  ) + '\n')
  const never = items.filter((i) => i.last_ack_version === null)
  if (never.length) {
    out.write(`⚠️  ${never.length} 个账号从未 ack 过策略（未成功登录或客户端过旧）。\n`)
  }
  out.write('下发失败计数：journalctl -u dy-license | grep -c policy_push_fail\n')
  return EXIT.OK
}

/** 把任意嵌套对象摊平成 `a.b.c` → value。 */
function flattenPolicyObject(obj, prefix = '') {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new UsageError('--file 的根必须是一个对象（例如 {"limits":{"comment":{"daily_max":5}}}）')
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenPolicyObject(v, key))
    } else {
      out[canonicalPolicyKey(key)] = v
    }
  }
  return out
}

/**
 * 把变更合并进账号级覆盖层。
 *
 * ⚠️ 覆盖层存的是**账号级差异**，不是完整 policy 快照。理由：完整快照会在
 *    等级按天数推进后变成过期数据（例如观察期的 0 上限被"钉"住），
 *    而差异层可以与新等级安全地重新合并。
 */
function applyOverride(before, changes, base, nowMs) {
  const out = before ? JSON.parse(JSON.stringify(before)) : {}
  if (!out.limits) out.limits = {}
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'active_hours' || key === 'active_hours.windows') {
      out.active_hours = { tz_offset_minutes: TZ_OFFSET_MINUTES, windows: normalizeWindows(value) }
      continue
    }
    if (key.startsWith('limits.')) {
      const [, src, field] = key.split('.')
      if (!out.limits[src]) out.limits[src] = {}
      out.limits[src][field] = value
      continue
    }
    if (key.startsWith('circuit_breaker.')) {
      if (!out.circuit_breaker) out.circuit_breaker = {}
      out.circuit_breaker[key.slice('circuit_breaker.'.length)] = value
      continue
    }
    if (key === 'idle_pause_ms') { out.idle_pause_ms = value; continue }
    throw new CliError(`内部错误：未处理的键 ${key}`)
  }
  out.base_tier_at_change = base.account_tier
  out.updated_at_ms = nowMs
  return out
}

/**
 * 合并"等级基准"与"账号级覆盖"，得到实际生效值。
 *
 * ⚠️ 覆盖只可能更保守，所以这里直接取覆盖值即可（合法性已在 set 时判定）。
 *    但仍要走一遍 max/min 方向，防止**手工写库**塞进更激进的值。
 */
function mergeOverride(base, override) {
  const out = JSON.parse(JSON.stringify(base))
  if (!override || typeof override !== 'object') return out
  if (override.limits) {
    for (const src of SOURCE_TYPES) {
      const o = override.limits[src]
      if (!o) continue
      if (Number.isFinite(Number(o.daily_max))) {
        out.limits[src].daily_max = Math.min(out.limits[src].daily_max, Number(o.daily_max))
      }
      if (Number.isFinite(Number(o.min_interval_ms))) {
        out.limits[src].min_interval_ms = Math.max(out.limits[src].min_interval_ms, Number(o.min_interval_ms))
      }
      if (Number.isFinite(Number(o.content_similarity_max))) {
        out.limits[src].content_similarity_max =
          Math.min(out.limits[src].content_similarity_max, Number(o.content_similarity_max))
      }
    }
  }
  if (override.active_hours && Array.isArray(override.active_hours.windows)) {
    const w = normalizeWindows(override.active_hours.windows)
    if (w && isActiveHoursShorterOrEqual({ windows: w }, base.active_hours)) {
      out.active_hours = { tz_offset_minutes: TZ_OFFSET_MINUTES, windows: w }
    }
  }
  if (override.circuit_breaker) {
    for (const [k, v] of Object.entries(override.circuit_breaker)) {
      if (k in out.circuit_breaker && Number.isFinite(Number(v))) out.circuit_breaker[k] = Number(v)
    }
  }
  if (Number.isFinite(Number(override.idle_pause_ms))) out.idle_pause_ms = Number(override.idle_pause_ms)
  return out
}

function safeParseJson(text) {
  if (text === null || text === undefined) return null
  try {
    return JSON.parse(String(text))
  } catch (e) {
    // ⚠️ 不吞：库里 JSON 坏掉必须让运维看见（否则表现为"策略莫名其妙"）
    return { __parse_error: e.message, __raw_prefix: String(text).slice(0, 200) }
  }
}

// ═══════════════════════════════════════════════════════════
// audit
// ═══════════════════════════════════════════════════════════

/**
 * 审计明细导出的字段清单。
 *
 * ⚠️ **红线 3 的隐私边界**：这张表里**只有哈希**——`target_hash` /
 *    `user_key_hash` / `content_hash` 是 HMAC 后的值，**不可反查**。
 *    本导出因此"天然"不含评论/回复原文，因为它压根不存在于库里。
 *    ⚠️ 绝不要"顺手"JOIN 任何别的表去补明文——库里也没有，
 *    但将来若有人加了明文列，JOIN 就会把隐私泄进导出件。
 */
const EXPORT_COLUMNS = Object.freeze([
  ['id', '记录ID'],
  ['account_id', '账号ID'],
  ['account', '账号名'],
  ['send_id', '发送ID(幂等键)'],
  ['source_type', '渠道'],
  ['verdict', '判定'],
  ['confirm_signal', '确认信号'],
  ['platform_endpoint', '平台接口'],
  ['platform_status_code', '平台状态码'],
  ['failure_reason', '失败原因'],
  ['billing_status', '计费状态'],
  ['charged_milli', '扣费(毫积分)'],
  ['over_limit', '超当日上限'],
  ['applied_policy_version', '生效策略版本'],
  ['policy_snapshot_json', '生效策略快照'],
  ['sent_at_ms', '发送时刻(ms)'],
  ['received_at_ms', '接收时刻(ms)'],
  ['target_hash', '目标哈希(不可反查)'],
  ['user_key_hash', '用户哈希(不可反查)'],
  ['user_key_type', '用户哈希类型'],
  ['content_hash', '内容哈希(不可反查)'],
  ['client_version', '客户端版本'],
  ['device_id', '设备ID'],
  ['instance_id', '实例ID'],
  ['report_id', '批次ID'],
])

const PRIVACY_HEADER =
  '目标标识（target_hash / user_key_hash / content_hash）为 HMAC 哈希值，' +
  '用于证明发送行为与时间，**不可还原为评论原文、回复原文或用户身份**（隐私约束，红线 3）。'

async function cmdAudit(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'export': {
      const user = requireFlag(flags, 'user')
      const from = parseDayArg(requireFlag(flags, 'from'), 'from')
      const to = parseDayArg(requireFlag(flags, 'to'), 'to')
      const format = (optFlag(flags, 'format') || 'csv').toLowerCase()
      const outFile = optFlag(flags, 'out')
      if (!['csv', 'json'].includes(format)) {
        throw new UsageError(`--format 只能是 csv|json，实际为 ${format}`)
      }
      if (!outFile) throw new UsageError('缺少必填选项 --out（导出必须落盘；stdout 会污染日志与终端历史）')
      const fromMs = from.dayStart
      const toMs = to.dayStart + MS_PER_DAY // 含 to 当天（[from, to+1day)）
      if (toMs <= fromMs) throw new UsageError('--to 必须不早于 --from')

      const account = getAccount(db, user)
      const accountId = Number(account.account_id)

      const total = Number(db.prepare(`
        SELECT COUNT(*) AS c FROM send_log
        WHERE account_id = ? AND sent_at_ms >= ? AND sent_at_ms < ?
      `).get(accountId, fromMs, toMs).c)

      // ⚠️ 覆盖写用户明确指定的 --out 是允许的（这是唯一允许 CLI 写的文件），
      //    但先断言不是目录、且父目录存在，避免写到一半才发现路径不对。
      const dir = path.dirname(path.resolve(outFile))
      if (!fs.existsSync(dir)) throw new CliError(`--out 的目录不存在：${dir}`)
      if (fs.existsSync(outFile) && fs.statSync(outFile).isDirectory()) {
        throw new CliError(`--out 指向一个目录：${outFile}`)
      }

      const chunks = []
      if (format === 'json') {
        chunks.push(JSON.stringify({
          type: 'meta',
          exported_at_ms: nowMs,
          account: account.account,
          account_id: accountId,
          from: from.label,
          to: to.label,
          rows: total,
          note: PRIVACY_HEADER,
          privacy: 'only_hashes_no_plaintext',
        }))
      } else {
        chunks.push(`# 授权中心审计导出（${account.account}，${from.label} ~ ${to.label}，共 ${total} 行）`)
        chunks.push(`# 导出时间：${fmtTime(nowMs)}（UTC+8）`)
        chunks.push(`# ${PRIVACY_HEADER}`)
        chunks.push(`# 时间字段为整数 Unix 毫秒；金额字段为整数毫单位（1000 毫 = 1 积分）。`)
        chunks.push(EXPORT_COLUMNS.map((c) => c[1]).join(','))
      }

      let written = 0
      const PAGE = 5000
      for (let offset = 0; offset < total; offset += PAGE) {
        const rows = db.prepare(`
          SELECT s.*, a.account AS account
          FROM send_log s LEFT JOIN account a ON a.account_id = s.account_id
          WHERE s.account_id = ? AND s.sent_at_ms >= ? AND s.sent_at_ms < ?
          ORDER BY s.sent_at_ms, s.id
          LIMIT ? OFFSET ?
        `).all(accountId, fromMs, toMs, PAGE, offset)
        for (const r of rows) {
          const obj = {}
          for (const [col] of EXPORT_COLUMNS) obj[col] = r[col] === undefined ? null : r[col]
          if (format === 'json') {
            chunks.push(JSON.stringify(jsonSafe(obj)))
          } else {
            chunks.push(EXPORT_COLUMNS
              .map(([col]) => csvCell(obj[col]))
              .join(','))
          }
          written++
        }
      }

      fs.writeFileSync(outFile, chunks.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
      const res = chmod600(outFile)
      out.write(`✅ 已导出审计明细：${outFile}\n`)
      out.write(`   账号：${account.account}   区间：${from.label} ~ ${to.label}   条数：${written}   格式：${format}\n`)
      out.write(`   文件大小：${fmtSize(fs.statSync(outFile).size)}\n`)
      writeChmodNote(ctx.io, res, outFile)
      out.write('   提示：目标标识为哈希，不可反查用户身份；举证时请一并说明这一点。\n')
      logAdminAction(db, {
        adminName: ctx.operator, action: 'audit_export', target: account.account, nowMs,
        detail: { from: from.label, to: to.label, rows: written, format, file: path.basename(outFile) },
      })
      return EXIT.OK
    }

    case 'prune': {
      const keepDaysDefault = ctx.auditKeepDays
      const keepDays = flags['keep-days'] !== undefined
        ? intFlag(flags, 'keep-days', { min: 1, max: 3650 })
        : keepDaysDefault
      const cutoff = dayStartMs(nowMs) - keepDays * MS_PER_DAY

      // ⚠️ 先算清楚"要删什么"，再让运维确认。破坏性命令不能先删后报。
      const plan = PRUNE_TABLES.map((t) => {
        const where = t.timeColumn
          ? `WHERE ${t.timeColumn} < ?`
          : ''
        const params = t.timeColumn ? [cutoff] : []
        const c = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t.table} ${where}`).get(...params).c)
        let range = null
        if (t.timeColumn && c > 0) {
          const r = db.prepare(
            `SELECT MIN(${t.timeColumn}) AS a, MAX(${t.timeColumn}) AS b FROM ${t.table} ${where}`
          ).get(...params)
          range = { from: Number(r.a), to: Number(r.b) }
        }
        return { ...t, count: c, range }
      }).filter((p) => p.count > 0)

      const total = plan.reduce((s, p) => s + p.count, 0)

      out.write('审计清理（保留策略，部署指南 §5.5）：\n')
      out.write(`  保留天数：${keepDays} 天（截止 ${fmtTime(cutoff)} 之前的数据）\n`)
      out.write(`  将删除合计 ${total} 行：\n\n`)
      if (!plan.length) {
        out.write('  （没有超出保留期的明细，无需清理）\n')
        return EXIT.OK
      }
      out.write(renderTable(
        ['表', '将删除行数', '最早', '最晚'],
        plan.map((p) => [
          p.table, p.count,
          p.range ? fmtTime(p.range.from) : '—',
          p.range ? fmtTime(p.range.to) : '—',
        ])
      ) + '\n')
      out.write('\n⚠️  不会删除：credit_ledger / credit / plan / policy / account\n' +
        '   （钱与配置永久保留，见 §5.5：ledger / credit 是财务凭证）。\n')
      out.write('⚠️  清理前请确认 stats_daily 已聚合该窗口——本仓库尚未内置聚合任务，\n' +
        '   删除明细后该窗口的看板数字将无法从明细重算。\n\n')

      if (flags['dry-run'] === true) {
        out.write('[dry-run] 仅演练，未删除任何数据。\n')
        return EXIT.OK
      }

      if (flags.yes !== true) {
        if (!ctx.io.stdinIsTTY) {
          throw new CliError(
            'audit prune 需要确认，但当前不是终端。\n' +
            '  确认无误请显式加 --yes（cron 用法即如此：audit prune --yes）。\n' +
            '  仅想预览请加 --dry-run。'
          )
        }
        const answer = await askYesNo(ctx.io, `确认删除以上 ${total} 行？输入 yes 继续：`)
        if (!answer) {
          out.write('已中止，未删除任何数据。\n')
          return EXIT.OK
        }
      }

      const deleted = {}
      for (const p of plan) {
        deleted[p.table] = 0
        // ⚠️ 小批删除（每批 LIMIT 5000）并逐批 checkpoint：
        //    一个巨大事务会长时间持写锁，让服务端持续 SQLITE_BUSY（§5.5 实现要点）
        for (;;) {
          const inner = `SELECT rowid FROM ${p.table}` +
            `${p.timeColumn ? ` WHERE ${p.timeColumn} < ?` : ''} LIMIT ?`
          const params = p.timeColumn ? [cutoff, PRUNE_BATCH] : [PRUNE_BATCH]
          const r = db.prepare(`DELETE FROM ${p.table} WHERE rowid IN (${inner})`).run(...params)
          const n = Number(r.changes)
          deleted[p.table] += n
          if (n < PRUNE_BATCH) break
          try {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
          } catch (e) {
            ctx.io.err.write(`[prune] 警告：批次间检查点未完成（${e && e.message}），继续\n`)
          }
        }
      }

      out.write('✅ 清理完成：\n')
      for (const [t, n] of Object.entries(deleted)) out.write(`   ${t}: 删除 ${n} 行\n`)
      out.write('\n建议随后执行：' + `${RC} db checkpoint && ${RC} audit usage\n`)
      logAdminAction(db, {
        adminName: ctx.operator, action: 'audit_prune', target: '*', nowMs,
        detail: { keep_days: keepDays, deleted },
      })
      return EXIT.OK
    }

    case 'usage': {
      const stats = []
      for (const t of USAGE_TABLES) {
        let count = 0
        let range = null
        try {
          count = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t.table}`).get().c)
          if (t.timeColumn && count > 0) {
            const r = db.prepare(
              `SELECT MIN(${t.timeColumn}) AS a, MAX(${t.timeColumn}) AS b FROM ${t.table}`
            ).get()
            range = { from: Number(r.a), to: Number(r.b) }
          }
        } catch (e) {
          // ⚠️ 不吞：表缺失说明迁移没跑完，必须让运维看见而不是显示 0 行
          ctx.io.err.write(`[usage] 读取 ${t.table} 失败：${e && e.message}\n`)
          count = -1
        }
        stats.push({ table: t.table, desc: t.desc, count, range, keep: t.keep })
      }

      const page = db.prepare('PRAGMA page_count').get()
      const pageSize = db.prepare('PRAGMA page_size').get()
      const freelist = db.prepare('PRAGMA freelist_count').get()
      const dbsize = Number(page.page_count) * Number(pageSize.page_size)
      const walSize = walBytes(ctx.cfg.dbPath)

      const payload = {
        db_path: ctx.cfg.dbPath,
        db_size_bytes: dbsize,
        wal_size_bytes: walSize,
        free_pages: Number(freelist.freelist_count),
        tables: stats,
        schema_version: schemaVersion(db),
        audit_keep_days: ctx.auditKeepDays,
      }
      if (flags.json) { printJson(out, payload); return EXIT.OK }

      out.write(`数据库：${ctx.cfg.dbPath}\n`)
      out.write(`主库大小：${fmtSize(dbsize)}   WAL+SHM：${fmtSize(walSize)}   空闲页：${Number(freelist.freelist_count)}\n`)
      out.write(`结构版本：${payload.schema_version}   审计保留：${ctx.auditKeepDays} 天\n\n`)
      out.write(renderTable(
        ['表', '用途', '行数', '最早', '最晚', '保留'],
        stats.map((s) => [
          s.table, s.desc, s.count < 0 ? '读取失败' : s.count,
          s.range ? fmtTime(s.range.from) : '—',
          s.range ? fmtTime(s.range.to) : '—',
          s.keep,
        ])
      ) + '\n')
      out.write('权威行数查询（只读，与服务端同库）：\n')
      out.write('  sudo -u dylicense sqlite3 -readonly ' + ctx.cfg.dbPath +
        ' "select \'send_log\',count(*) from send_log union all select \'ledger\',count(*) from credit_ledger;"\n')
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'audit', action)
  }
}

/** 保留策略清理涉及的表（⚠️ 只含"证据/明细"，绝不含钱与配置）。 */
const PRUNE_TABLES = Object.freeze([
  { table: 'send_log', timeColumn: 'sent_at_ms', keep: 'AUDIT_KEEP_DAYS' },
  { table: 'audit_config_changes', timeColumn: 'changed_at_ms', keep: 'AUDIT_KEEP_DAYS' },
  { table: 'usage_report', timeColumn: 'received_at_ms', keep: 'USAGE_KEEP_DAYS' },
  { table: 'policy_history', timeColumn: 'created_at_ms', keep: 'POLICY_HISTORY_KEEP_DAYS' },
])

/** `audit usage` 展示的表清单。 */
const USAGE_TABLES = Object.freeze([
  { table: 'account', timeColumn: 'created_at_ms', desc: '商家账号', keep: '永久' },
  { table: 'credit', timeColumn: null, desc: '余额', keep: '永久' },
  { table: 'credit_ledger', timeColumn: 'settled_at_ms', desc: '积分台账（只增不改）', keep: '永久' },
  { table: 'plan', timeColumn: null, desc: '套餐', keep: '永久' },
  { table: 'redeem_code', timeColumn: 'created_at_ms', desc: '充值码', keep: '永久' },
  { table: 'device_session', timeColumn: 'issued_at_ms', desc: '设备会话', keep: '到期后清理' },
  { table: 'send_log', timeColumn: 'sent_at_ms', desc: '发送明细（计费依据）', keep: 'AUDIT_KEEP_DAYS' },
  { table: 'audit_config_changes', timeColumn: 'changed_at_ms', desc: '配置变更审计', keep: 'AUDIT_KEEP_DAYS' },
  { table: 'policy_history', timeColumn: 'created_at_ms', desc: '策略变更留痕', keep: 'POLICY_HISTORY_KEEP_DAYS' },
  { table: 'policy_ack_log', timeColumn: 'last_seen_at_ms', desc: '策略 ack 存证（红线 3）', keep: '永久' },
  { table: 'usage_report', timeColumn: 'received_at_ms', desc: '聚合上报（非计费依据）', keep: 'USAGE_KEEP_DAYS' },
  { table: 'admin_action_log', timeColumn: 'at_ms', desc: '管理员操作留痕', keep: '永久' },
])

/** CSV 单元格：数字原样，其余加引号转义；null → 空串。 */
function csvCell(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'bigint') return v.toString()
  const s = String(v)
  return `"${s.replace(/"/g, '""')}"`
}

/** 交互式 yes/no（默认否——破坏性操作必须显式同意）。 */
function askYesNo(io, prompt) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: io.stdin, output: io.out, terminal: true })
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(/^(y|yes|是|确认)$/i.test(String(answer).trim()))
    })
    rl.on('SIGINT', () => {
      rl.close()
      io.err.write('\n已取消\n')
      reject(new CliError('用户取消'))
    })
  })
}

// ═══════════════════════════════════════════════════════════
// stats —— 必须复用 shared/lib/stats.js
// ═══════════════════════════════════════════════════════════

/**
 * 看板数据（**唯一实现**，CLI 与 `stats --json` 都走这里）。
 *
 * ⚠️ 为什么不在这里写 `confirmed / attempts`：
 *    "回复成功率"这类式子的口径必须双端一致。写第二份实现就意味着
 *    "商家看板说 30 条、厂商看板说 28 条"必然出现，而两边的单测都会通过
 *    （因为它们测的是各自的实现）。`shared/lib/stats.js` 就是为消灭这种
 *    漂移而存在的，见该文件头部注释与 AGENTS.md §3。
 *
 * ⚠️ 分母为 0 时 `buildDashboard` 返回 `null`，界面显示 `—` 而**不是 100%**。
 *    这里也不允许把它"顺手"改成 0 —— 那是最典型的误导（发 0 条显示 100%）。
 *
 * @param {object} db
 * @param {object} opts { accountId|null, days, nowMs }
 */
function buildStatsDashboard(db, opts) {
  const { accountId = null, days = 7, nowMs } = opts
  if (!Number.isFinite(nowMs)) throw new CliError('buildStatsDashboard 需要 nowMs')
  const toMs = nowMs
  const fromMs = dayStartMs(nowMs) - (days - 1) * MS_PER_DAY

  const accFilter = accountId === null ? '' : 'AND s.account_id = ?'
  const params = accountId === null ? [fromMs, toMs] : [fromMs, toMs, accountId]

  const sends = db.prepare(`
    SELECT s.account_id, s.source_type, s.verdict, s.sent_at_ms, s.user_key_hash,
           s.failure_reason, s.billing_status, s.charged_milli
    FROM send_log s
    WHERE s.sent_at_ms >= ? AND s.sent_at_ms < ? ${accFilter}
    ORDER BY s.sent_at_ms
  `).all(...params)

  const detailAgg = aggregateSends(sends, { fromMs, toMs })

  // 聚合上报（看板/对账来源，可能缺失）。⚠️ 与明细数字不一致时**以明细为准**。
  //
  // ⚠️ 形状要对上：`routes-audit.js` 落库的是 `JSON.stringify(body.sources)`，
  //    即**顶层就是三个渠道键**；而 `aggregateReports()` 期望
  //    `{sources, failure_reasons, unique_users_total}`。少了这层包装，
  //    它会把每条上报都当成"没有 sources"而静默跳过 ——
  //    表现为看板"截流总量"永远 0，而 usage_report 里明明有数据。
  const reports = db.prepare(`
    SELECT payload_json, account_id FROM usage_report
    WHERE window_end_ms >= ? AND window_start_ms < ? ${accountId === null ? '' : 'AND account_id = ?'}
    ORDER BY window_end_ms
  `).all(...(accountId === null ? [fromMs, toMs] : [fromMs, toMs, accountId]))
  const reportAgg = aggregateReports(reports.map((r) => {
    const sources = safeParseJson(r.payload_json)
    if (!sources || typeof sources !== 'object') return {}
    return {
      sources,
      // 失败原因分布不在 payload 里（闭集校验在上报时做），由明细补齐，见下。
      failure_reasons: {},
      unique_users_total: SOURCE_TYPES.reduce(
        (n, s) => n + Number((sources[s] && sources[s].unique_users) || 0), 0
      ),
    }
  }))

  // ⚠️ 明细里没有 failure_reasons 分布（那是聚合层的事），
  //    这里从明细的 failure_reason 列补齐，仍然是计数不是算术。
  const failureReasons = {}
  for (const r of sends) {
    if (r.verdict !== 'failed') continue
    const k = FAILURE_REASONS.includes(r.failure_reason) ? r.failure_reason : 'unknown'
    failureReasons[k] = (failureReasons[k] || 0) + 1
  }

  const agg = {
    ...detailAgg,
    failure_reasons: Object.keys(failureReasons).length ? failureReasons : reportAgg.failure_reasons,
    // ⚠️ 明细里推不出「命中 / 沉淀 / 跳过」——`send_log` 只有**回复尝试**，
    //    没有"命中但没回复"的那部分（见 shared/lib/stats.js §7.1 的说明）。
    //    这三个计数只能来自聚合上报（usage_report），因此必须显式补进 totals，
    //    否则 `buildDashboard` 会把它们一律算成 0，看板显示"截流总量 0"
    //    而聚合上报里明明有数据——这正是"两边数字不一致"的典型来源。
    totals: {
      ...detailAgg.totals,
      hits: Number(reportAgg.totals.hits || 0),
      leads_new: Number(reportAgg.totals.leads_new || 0),
      skipped: Number(reportAgg.totals.skipped || 0),
    },
  }

  // 当日额度：上限来自等级表，已用来自 send_log 派生
  const accountRow = accountId === null ? null
    : db.prepare('SELECT * FROM account WHERE account_id = ?').get(accountId)
  let dailyQuota = null
  if (accountRow) {
    const policy = currentPolicy(db, accountRow, nowMs)
    dailyQuota = quotaOf(db, accountRow, policy, nowMs)
  } else {
    const tierDef = tierForDayIndex(1)
    dailyQuota = {}
    for (const src of SOURCE_TYPES) {
      dailyQuota[src] = { max: tierDef.limits[src].daily_max, used: 0, remaining: 0 }
    }
  }

  const usageRows = db.prepare(`
    SELECT settled_at_ms, delta_milli FROM credit_ledger
    WHERE kind = 'consume' AND settled_at_ms >= ? AND settled_at_ms < ?
    ${accountId === null ? '' : 'AND account_id = ?'}
  `).all(...(accountId === null ? [fromMs, toMs] : [fromMs, toMs, accountId]))
  const usageByDay = {}
  let usageMilli = 0
  for (const r of usageRows) {
    const k = dayKey(Number(r.settled_at_ms))
    const v = -Number(r.delta_milli)
    usageByDay[k] = (usageByDay[k] || 0) + v
    usageMilli += v
  }

  const dashboard = buildDashboard(agg, {
    dailyQuota,
    extra: {
      window: { from_ms: fromMs, to_ms: toMs, days, tz_offset_minutes: TZ_OFFSET_MINUTES },
      usage_milli: usageMilli,
      usage_credits: milliToCredits(usageMilli),
      source_of_truth: 'send_log（明细口径；聚合上报仅用于看板对账，不一致时以明细为准）',
      detail_vs_report: {
        detail_confirmed: detailAgg.totals.sent_confirmed,
        reported_confirmed: reportAgg.totals.sent_confirmed,
        match: detailAgg.totals.sent_confirmed === reportAgg.totals.sent_confirmed,
        audit_flags: reportAgg.audit_flags,
        authoritative_source: 'audit_sends',
      },
    },
  })
  dashboard.trend = buildTrend(sends, { days, nowMs, usageByDay })
  return dashboard
}

function cmdStats(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  if (action !== undefined) return helpOrUsage(ctx, 'stats', action)

  const days = flags.days === undefined ? 7 : intFlag(flags, 'days', { min: 1, max: 400 })
  let accountId = null
  let accountName = null
  if (flags.user !== undefined) {
    const account = getAccount(db, requireFlag(flags, 'user'))
    accountId = Number(account.account_id)
    accountName = account.account
  }

  const dashboard = buildStatsDashboard(db, { accountId, days, nowMs })
  if (flags.json) { printJson(out, dashboard); return EXIT.OK }

  const d = dashboard.display
  out.write(`看板${accountName ? `（账号 ${accountName}）` : '（全平台）'}   ` +
    `窗口：近 ${days} 天（${fmtDay(dashboard.window.from_ms)} ~ ${fmtDay(dashboard.window.to_ms)}，UTC+8）\n`)
  out.write('─'.repeat(56) + '\n')
  out.write(`  截流总量：${d.截流总量}（sum(leads_new)，仅聚合上报可得）\n`)
  out.write(`  已回复人数：${d.已回复人数}（${d.已回复人数口径}）\n`)
  out.write(`  回复条数：${d.回复条数}（${d.回复条数口径}）\n`)
  out.write(`  回复成功率：${d.回复成功率显示}` +
    `${d.回复成功率 === null ? '（本窗口没有回复尝试，不做比例计算）' : ''}\n`)
  out.write(`  DOM 判据：${d.dom_判据条数}   疑似送达：${d.疑似送达条数}   ` +
    `失败：${d.失败条数}   跳过：${d.跳过条数}\n`)
  out.write(`  回复尝试合计：${dashboard.counts.reply_attempts}\n`)
  out.write(`  积分消耗：${dashboard.usage_credits}（${dashboard.usage_milli} 毫单位）\n`)
  if (dashboard.empty) out.write('  （本窗口无数据）\n')

  out.write('\n分渠道：\n')
  out.write(renderTable(
    ['渠道', '命中', '回复尝试', '成功', 'DOM', '疑似', '失败', '成功率'],
    dashboard.by_source.map((s) => [
      `${SOURCE_LABELS[s.source_type]}(${s.source_type})`,
      s.hits, s.reply_attempts, s.sent_confirmed, s.sent_confirmed_dom,
      s.sent_suspected, s.failed,
      s.success_rate === null ? '—' : `${(s.success_rate * 100).toFixed(1)}%`,
    ])
  ) + '\n')

  const fr = Object.entries(dashboard.failure_reasons)
  if (fr.length) {
    out.write('失败原因分布：\n')
    out.write(renderTable(
      ['原因', '次数'],
      fr.map(([k, v]) => [`${FAILURE_LABELS[k] || k}(${k})`, v])
    ) + '\n')
  }

  if (dashboard.daily_quota) {
    out.write('当日额度（上限由 tier_table 推导；观察期为 0 表示只采集不发送）：\n')
    out.write(renderTable(
      ['渠道', '上限', '已用', '剩余'],
      SOURCE_TYPES.map((s) => [
        SOURCE_LABELS[s], dashboard.daily_quota[s].max,
        dashboard.daily_quota[s].used, dashboard.daily_quota[s].remaining,
      ])
    ) + '\n')
    out.write('  注：额度按账号当前等级计算；全平台视图展示的是观察期上限（0）。\n')
  }

  out.write('近 N 日趋势：\n')
  out.write(renderTable(
    ['日期', '成功回复', 'DOM', '疑似', '失败', '积分消耗'],
    dashboard.trend.map((t) => [
      t.day, t.sent_confirmed, t.sent_confirmed_dom, t.sent_suspected, t.failed,
      milliToCredits(t.usage_milli),
    ])
  ) + '\n')

  const dv = dashboard.detail_vs_report
  out.write(`明细 vs 聚合：明细确认 ${dv.detail_confirmed} / 聚合上报 ${dv.reported_confirmed}` +
    `（${dv.match ? '一致' : '不一致 —— 以明细为准'}）\n`)
  if (dashboard.audit_flags.length) {
    out.write(`⚠️  审计标记：${dashboard.audit_flags.join(', ')}\n`)
  }
  out.write('低余额告警阈值：MIN_BALANCE_ALERT_REPLIES（见 .env）；' +
    '积分为负/为 0 的账号请用 account list 复核。\n')
  return EXIT.OK
}

// ═══════════════════════════════════════════════════════════
// plan
// ═══════════════════════════════════════════════════════════

function cmdPlan(ctx, action, args) {
  const { flags } = args
  const { out } = ctx.io
  requireExistingDb(ctx)
  const db = openDb(ctx)
  assertMigrated(db, ctx)
  const nowMs = nowOf(ctx)

  switch (action) {
    case 'list': {
      const rows = db.prepare('SELECT * FROM plan ORDER BY is_default DESC, plan_id').all()
      const items = rows.map((p) => planView(db, p))
      if (flags.json) {
        printJson(out, {
          min_plan_credit: minPlanCredit(),
          stable_daily_max_total: stableDailyMaxTotal(),
          plan_credit_formula: 'stable_daily_max_total × valid_days × plan_credit_ratio',
          plans: items,
        })
        return EXIT.OK
      }
      if (!items.length) {
        out.write('（尚未创建套餐）\n')
        out.write(`  建议：${RC} plan set --name "半年套餐" --credits ${planCreditsFor(180)} --is-default\n`)
        return EXIT.OK
      }
      out.write(renderTable(
        ['plan_id', '名称', '积分', '有效天数', '价格(元)', '默认', '启用', '账号数'],
        items.map((i) => [
          i.plan_id, i.name, i.credits, i.valid_days, i.price_yuan,
          i.is_default ? '是' : '', i.active ? '是' : '否', i.accounts,
        ])
      ) + '\n')
      out.write(`套餐最低积分：${minPlanCredit()}（= 稳定期日上限合计 ${stableDailyMaxTotal()} × 180 天，` +
        '由 tier_table 推导，改表后必须重算）\n')
      const placeholder = items.filter((i) => i.price_is_placeholder)
      if (placeholder.length) {
        out.write(`⚠️  ${placeholder.length} 个套餐价格仍是占位值（0 元），` +
          '不得作为定价依据；请用 --price 设置真实价格。\n')
      }
      return EXIT.OK
    }

    case 'set': {
      const name = requireFlag(flags, 'name')
      const validDays = flags['valid-days'] !== undefined
        ? intFlag(flags, 'valid-days', { min: 1, max: 3650 })
        : 180

      // ⚠️ --credits 未给时按 tier_table 推导（不是写死的 12600）
      const derived = planCreditsFor(validDays)
      const credits = flags.credits !== undefined
        ? intFlag(flags, 'credits', { min: 1, required: true })
        : derived
      const minimum = minPlanCredit()
      if (credits < minimum) throw quotaBelowMinError(credits, minimum, `套餐「${name}」`)

      const priceRaw = optFlag(flags, 'price')
      let priceCents = 0
      let pricePlaceholder = 1
      if (priceRaw !== undefined) {
        if (!/^\d+(\.\d{1,2})?$/.test(priceRaw)) {
          throw new UsageError(`--price 必须是元为单位的最多两位小数，实际为 ${priceRaw}`)
        }
        priceCents = Math.round(Number(priceRaw) * 100)
        pricePlaceholder = priceCents === 0 ? 1 : 0
      }
      const isDefault = flags['is-default'] === true

      const existing = db.prepare('SELECT * FROM plan WHERE name = ?').get(name)
      let planId
      db.exec('BEGIN IMMEDIATE')
      try {
        if (isDefault) {
          db.prepare('UPDATE plan SET is_default = 0 WHERE is_default = 1').run()
        }
        if (existing) {
          db.prepare(`
            UPDATE plan SET credits = ?, valid_days = ?, price_cents = ?, price_is_placeholder = ?,
                            is_default = ?, active = 1
            WHERE plan_id = ?
          `).run(
            credits, validDays, priceCents, pricePlaceholder,
            isDefault ? 1 : Number(existing.is_default), Number(existing.plan_id)
          )
          planId = Number(existing.plan_id)
        } else {
          const key = makePlanKey(name)
          const dup = db.prepare('SELECT plan_id FROM plan WHERE plan_key = ?').get(key)
          if (dup) throw new CliError(`plan_key 冲突（${key}），请换一个套餐名`)
          const r = db.prepare(`
            INSERT INTO plan (plan_key, name, credits, valid_days, price_cents,
                              price_is_placeholder, is_default, active, hours, created_at_ms)
            VALUES (?,?,?,?,?,?,?,1,NULL,?)
          `).run(key, name, credits, validDays, priceCents, pricePlaceholder, isDefault ? 1 : 0, nowMs)
          planId = Number(r.lastInsertRowid)
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      logAdminAction(db, {
        adminName: ctx.operator, action: 'plan_set', target: name, nowMs,
        detail: { plan_id: planId, credits, valid_days: validDays, price_cents: priceCents, is_default: isDefault },
      })

      const row = db.prepare('SELECT * FROM plan WHERE plan_id = ?').get(planId)
      const v = planView(db, row)
      out.write(`${existing ? '✅ 已更新' : '✅ 已创建'}套餐：${v.name}（plan_id=${v.plan_id}，plan_key=${v.plan_key}）\n`)
      out.write(`   积分：${v.credits}（有效天数 ${v.valid_days} 天${flags.credits === undefined ? '，由 tier_table 推导' : ''}）\n`)
      out.write(`   价格：${v.price_yuan} 元${v.price_is_placeholder ? '（占位值，不得作为定价依据）' : ''}\n`)
      out.write(`   默认套餐：${v.is_default ? '是' : '否'}\n`)
      out.write(`   套餐最低积分：${minimum}（stable 日上限合计 ${stableDailyMaxTotal()} × 180 天）\n`)
      return EXIT.OK
    }

    default:
      return helpOrUsage(ctx, 'plan', action)
  }
}

function planView(db, p) {
  const accounts = Number(db.prepare('SELECT COUNT(*) AS c FROM account WHERE plan_id = ?')
    .get(Number(p.plan_id)).c)
  return {
    plan_id: Number(p.plan_id),
    plan_key: p.plan_key,
    name: p.name,
    credits: Number(p.credits),
    valid_days: Number(p.valid_days),
    price_cents: Number(p.price_cents),
    price_yuan: (Number(p.price_cents) / 100).toFixed(2),
    price_is_placeholder: Number(p.price_is_placeholder) === 1,
    is_default: Number(p.is_default) === 1,
    active: Number(p.active) === 1,
    // ⚠️ hours 已废弃（计费由按小时改为按条数），恒为 null，禁止据此展示
    hours: null,
    accounts,
  }
}

/**
 * 由套餐名生成稳定的 plan_key。
 *
 * ⚠️ 不能用 `name.toLowerCase().replace(/\W/g,'_')`：中文名会被整段吃掉，
 *    所有中文套餐都会得到同一个 key（`___`）→ 唯一索引冲突。
 *    这里对非 ASCII 名做哈希后缀，保证"同名同 key、异名异 key"且稳定可重现。
 */
function makePlanKey(name) {
  const ascii = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const suffix = crypto.createHash('sha256').update(String(name), 'utf8').digest('hex').slice(0, 8)
  return ascii ? `plan_${ascii}_${suffix}` : `plan_${suffix}`
}

// ═══════════════════════════════════════════════════════════
// 帮助/用法出口
// ═══════════════════════════════════════════════════════════

/**
 * 未知命令 / 未知动作的统一出口。
 *
 * ⚠️ 一律退出 2 并给"可照着抄"的提示，**绝不打印堆栈**：
 *    堆栈对运维没有信息量，还会让人以为程序崩了。
 */
function helpOrUsage(ctx, group, action) {
  const { out, err } = ctx.io
  const gh = groupHelp(group)
  if (!gh) {
    err.write(`未知命令组：${group}\n\n${TOP_HELP}\n`)
    return EXIT.USAGE
  }
  if (action === undefined) {
    out.write(gh + '\n')
    return EXIT.OK
  }
  err.write(`未知的 ${group} 子命令：${action}\n\n${gh}\n`)
  return EXIT.USAGE
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

/**
 * 执行一次 CLI 调用。
 *
 * ⚠️ 刻意做成"返回退出码"而不是 `process.exit()`：
 *    单测要在**同进程内**调它（spawn 出进程会让测试又慢又不稳），
 *    而 `process.exit()` 会连带杀掉测试进程。
 *    另外 stdout 走 `console.log`（同步写管道），所以返回后输出一定已落盘。
 *
 * @param {string[]} argv 不含 node / 脚本路径
 * @param {object} [options]
 * @param {string} [options.dataDir] 覆盖 DATA_DIR（测试用，避免污染真实 .env）
 * @param {object} [options.env]     覆盖 process.env 的部分键
 * @param {number} [options.nowMs]   固定"现在"（测试用）
 * @param {string} [options.operator] 操作人（写入 admin_action_log / policy_history）
 * @param {object} [options.io]      { out, err, stdin } 注入（测试用）
 * @returns {Promise<number>} 退出码
 */
async function run(argv, options = {}) {
  const io = options.io || {}
  const out = io.out || process.stdout
  const err = io.err || process.stderr
  const stdin = io.stdin || process.stdin

  const cliIo = {
    out, err, stdin,
    stdinIsTTY: io.stdinIsTTY !== undefined ? io.stdinIsTTY : Boolean(stdin.isTTY),
  }

  const args = { flags: {}, lists: {}, positional: [] }
  let group
  let action

  try {
    // ⚠️ 帮助与纯用法解析必须在 `loadConfig()` **之前**完成。
    //    理由：loadConfig 会顺手生成 `data/master.key`（见 config.js），
    //    于是 `cli.js --help` 这种零副作用的命令会凭空造出密钥文件——
    //    既不必要，又可能被误提交。参数写错时同理：先给用法，不碰任何文件。
    let parsed
    try {
      parsed = parseArgs(argv)
    } catch (e) {
      if (e instanceof UsageError) {
        err.write(`❌ 参数错误：${e.message}\n\n${TOP_HELP}\n`)
        return EXIT.USAGE
      }
      throw e
    }
    args.flags = parsed.flags
    args.lists = parsed.lists
    args.positional = parsed.positional
    group = parsed.positional[0]
    action = parsed.positional[1]

    if (group === undefined || group === '--help') {
      out.write(TOP_HELP + '\n')
      return EXIT.OK
    }
    if (group === 'help') {
      if (!action) { out.write(TOP_HELP + '\n'); return EXIT.OK }
      const gh = groupHelp(action)
      if (!gh) {
        err.write(`未知命令组：${action}\n\n${TOP_HELP}\n`)
        return EXIT.USAGE
      }
      out.write(gh + '\n')
      return EXIT.OK
    }
    if (args.flags.help === true) {
      const gh = groupHelp(group)
      if (!gh) {
        err.write(`未知命令组：${group}\n\n${TOP_HELP}\n`)
        return EXIT.USAGE
      }
      out.write(gh + '\n')
      return EXIT.OK
    }
    if (!KNOWN_GROUPS.includes(group)) {
      err.write(`未知命令组：${group}\n\n${TOP_HELP}\n`)
      return EXIT.USAGE
    }

    const saved = {}
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        saved[k] = process.env[k]
        if (v === undefined) delete process.env[k]
        else process.env[k] = String(v)
      }
    }
    try {
      const cfg = loadConfig(options.dataDir ? { dataDir: options.dataDir } : {})
      const ctx = {
        cfg,
        io: cliIo,
        unit: cfg.creditPerReplyMilli,
        auditKeepDays: parseIntEnv('AUDIT_KEEP_DAYS', 60),
        usageKeepDays: parseIntEnv('USAGE_KEEP_DAYS', 90),
        policyHistoryKeepDays: parseIntEnv('POLICY_HISTORY_KEEP_DAYS', 730),
        operator: options.operator || 'cli',
        nowMs: options.nowMs,
        db: null,
        args,
      }

      try {
        return await dispatch(ctx, group, action, args)
      } finally {
        // ⚠️ 不用空 catch（AGENTS.md 2.8）：关闭失败要留痕，但**不能**让它
        //    盖掉命令本身的结果——否则会出现"命令成功却退出码非零"这种最难查的现象。
        if (ctx.closeDb) {
          try {
            ctx.closeDb()
          } catch (e) {
            err.write(`[警告] 关闭数据库连接失败：${e && e.message}\n`)
          }
        }
      }
    } finally {
      if (options.env) {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    }
  } catch (e) {
    if (e instanceof UsageError || (e && e.exitCode === EXIT.USAGE)) {
      err.write(`❌ 参数错误：${e.message}\n`)
      const gh = group ? groupHelp(group) : null
      err.write('\n' + (gh || TOP_HELP) + '\n')
      return EXIT.USAGE
    }
    if (e instanceof CliError || (e && e.exitCode === EXIT.FAIL && e.name === 'CliError')) {
      err.write(`❌ ${e.message}\n`)
      return EXIT.FAIL
    }
    // AppError（shared/lib/errors.js）与其它领域层错误：打印 code + message，
    // ⚠️ 非预期异常才打堆栈——堆栈是给"这是 bug"用的信号，不是给参数写错用的。
    if (e && e.code && e.message && e.name === 'AppError') {
      err.write(`❌ [${e.code}] ${e.message}\n`)
      if (e.detail) err.write(`   ${JSON.stringify(jsonSafe(e.detail))}\n`)
      return EXIT.FAIL
    }
    err.write(`❌ 内部错误：${e && e.message ? e.message : e}\n`)
    if (e && e.stack) err.write(e.stack + '\n')
    return EXIT.FAIL
  }
}

/** 命令分发。 */
async function dispatch(ctx, group, action, args) {
  // ⚠️ 只给了命令组（如 `cli.js account`）时打印该组用法并**退出 0**。
  //    这与 `account --help` 等价，且必须在 openDb() 之前完成——
  //    否则"看用法"会因为库不存在而失败，逼着运维先建库才能看文档。
  //    ⚠️ `stats` 是例外：它本身就是动作（`stats --days 7`），不受此规则影响。
  if (action === undefined && group !== 'stats') {
    const gh = groupHelp(group)
    if (!gh) return helpOrUsage(ctx, group, undefined)
    ctx.io.out.write(gh + '\n')
    return EXIT.OK
  }

  switch (group) {
    case 'db': return cmdDb(ctx, action, args)
    case 'admin': return cmdAdmin(ctx, action, args)
    case 'account': return cmdAccount(ctx, action, args)
    case 'credit': return cmdCredit(ctx, action, args)
    case 'code': return cmdCode(ctx, action, args)
    case 'policy': return cmdPolicy(ctx, action, args)
    case 'audit': return cmdAudit(ctx, action, args)
    case 'stats': return cmdStats(ctx, action, args)
    case 'session': return cmdSession(ctx, action, args)
    case 'plan': return cmdPlan(ctx, action, args)
    default:
      return helpOrUsage(ctx, group, undefined)
  }
}

module.exports = {
  run,
  // 导出内部件：单测要断言"列出的数值确实来自 tier_table/领域层"，
  // 而不是从 CLI 里抄一份常量。
  buildStatsDashboard,
  renderTable,
  displayWidth,
  parseArgs,
  canonicalPolicyKey,
  checkConservative,
  ALLOWED_POLICY_KEYS,
  FORBIDDEN_POLICY_KEYS,
  makePlanKey,
  makeCode,
  EXIT,
  UsageError,
  CliError,
}

// ── 直接运行时执行 ──────────────────────────────────────────
if (require.main === module) {
  // ⚠️ 不用 process.exit()：先让 stdout 冲刷完，否则管道里会丢输出。
  //    （上述 run() 全程用同步 console/流写，返回时已落盘。）
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((e) => {
    // ⚠️ 空 catch 是禁止的（AGENTS.md 2.8）；这里必须让人看见失败原因。
    process.stderr.write(`❌ 未捕获异常：${e && e.stack ? e.stack : e}\n`)
    process.exitCode = EXIT.FAIL
  })
}

