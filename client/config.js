'use strict'

// client/config.js
//
// 客户端配置。优先从实例目录的配置文件读取，其次环境变量，最后默认值。
//
// ⚠️ 三条硬约束：
//   1. **不存抖音凭据**。抖音登录态在商家自己的 Chrome 里，本项目任何
//      文件都不落 Cookie / token / 密码（红线 3）。
//   2. 工作台账号密码**只在内存中用于登录**，落盘的只有服务端签发的 token。
//   3. 所有路径经 REPLY_WORKSPACE / path.join 解析，**不写死绝对路径**
//      （旧代码的 D-1 缺陷就是硬编码路径导致换机器跑不通）。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULTS = Object.freeze({
  // ── 本地控制台 ──────────────────────────────────────────
  // ⚠️ 默认只绑回环。旧代码绑 0.0.0.0 + 零鉴权 + CORS 通配，
  //    导致局域网可访问、且任意网页可跨站调用接口代替商家发评论（D-6）。
  uiHost: '127.0.0.1',
  uiPort: 8090,

  // ── 授权中心 ────────────────────────────────────────────
  licenseBaseUrl: 'http://127.0.0.1:18080',
  /** 心跳间隔（契约规定 60 秒） */
  heartbeatIntervalMs: 60000,
  /** 上报周期 */
  reportIntervalMs: 300000,
  /** 单批上报上限（契约 audit_batch_max） */
  auditBatchMax: 500,

  // ── 浏览器（CDP）────────────────────────────────────────
  /** 调试端口基址。多实例按 +N 分配 */
  debugPortBase: 9222,
  /** 专用 Chrome 的配置目录名（相对实例目录） */
  chromeProfileDir: 'chrome-profile',
  /** Chrome 可执行文件路径；留空则自动探测 */
  chromePath: '',

  // ── 存储 ────────────────────────────────────────────────
  /** 原子写临时文件后缀 */
  tmpSuffix: '.tmp',

  // ── 日志 ────────────────────────────────────────────────
  logLevel: 'info',
  logMaxBytes: 5 * 1024 * 1024,
})

/**
 * 解析实例根目录。
 *
 * 目录结构（见 shared/术语与选型基准.md §四）：
 *   <workspace>/instances/<instanceId>/   ← 该抖音账号的数据与 Chrome profile
 *   <workspace>/client/                    ← 共享代码
 *
 * ⚠️ 多实例隔离的关键：数据与 profile 按实例分目录，
 *    一个账号出问题不影响其他账号。
 */
function resolveWorkspace(explicit) {
  return explicit
    || process.env.REPLY_WORKSPACE
    || path.resolve(__dirname, '..')
}

function resolveInstanceDir(workspace, instanceId) {
  if (!instanceId || !/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) {
    throw new Error(`非法的 instanceId：${instanceId}（只允许字母数字下划线连字符，1~64 字符）`)
  }
  return path.join(workspace, 'instances', instanceId)
}

/** 探测 Chrome 可执行文件。找不到返回 null（由调用方决定如何处理）。 */
function detectChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit
  if (process.env.REPLY_CHROME_PATH && fs.existsSync(process.env.REPLY_CHROME_PATH)) {
    return process.env.REPLY_CHROME_PATH
  }

  const candidates = []
  const unreadablePaths = []
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local')
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ⚠️ 系统路径探测时可能遇到权限拒绝（受保护目录）。
      //    这是**预期内**的情况，继续试下一个候选即可——
      //    但不能静默吞掉计数，否则"为什么探测不到 Chrome"无从排查。
      unreadablePaths.push(c)
    }
  }
  if (unreadablePaths.length) {
    // 由调用方通过返回的 null + 本数组判断是否需要提示用户手动指定路径
    detectChrome.lastUnreadable = unreadablePaths
  }
  return null
}
/** 上次探测时因权限无法读取的候选路径（排障用）。 */
detectChrome.lastUnreadable = []

/**
 * 载入配置。
 *
 * @param {object} [opts]
 * @param {string} [opts.workspace]  工作区根目录
 * @param {string} [opts.instanceId] 实例 ID（多账号时必填）
 * @param {object} [opts.overrides]  测试用覆盖
 */
function loadClientConfig(opts = {}) {
  const workspace = resolveWorkspace(opts.workspace)
  const instanceId = opts.instanceId || process.env.REPLY_INSTANCE_ID || 'default'
  const instanceDir = resolveInstanceDir(workspace, instanceId)

  // 实例配置文件（存在则读）
  let fileCfg = {}
  const cfgPath = path.join(instanceDir, 'client-config.json')
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    } catch (e) {
      throw new Error(`实例配置文件损坏：${cfgPath}\n${e.message}`)
    }
  }

  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    ...(opts.overrides || {}),
    workspace,
    instanceId,
    instanceDir,
  }

  // 环境变量优先于文件（便于运维临时覆盖）
  if (process.env.REPLY_UI_PORT) cfg.uiPort = Number(process.env.REPLY_UI_PORT)
  if (process.env.REPLY_DEBUG_PORT) cfg.debugPortBase = Number(process.env.REPLY_DEBUG_PORT)
  if (process.env.REPLY_LICENSE_URL) cfg.licenseBaseUrl = process.env.REPLY_LICENSE_URL

  cfg.chromePath = detectChrome(cfg.chromePath)
  cfg.chromeProfilePath = path.join(instanceDir, cfg.chromeProfileDir)

  validate(cfg)
  return cfg
}

function validate(cfg) {
  const problems = []

  if (!Number.isInteger(cfg.uiPort) || cfg.uiPort < 1 || cfg.uiPort > 65535) {
    problems.push(`uiPort 非法：${cfg.uiPort}`)
  }
  if (!Number.isInteger(cfg.debugPortBase) || cfg.debugPortBase < 1 || cfg.debugPortBase > 65535) {
    problems.push(`debugPortBase 非法：${cfg.debugPortBase}`)
  }
  if (!/^https?:\/\//.test(cfg.licenseBaseUrl)) {
    problems.push(`licenseBaseUrl 必须以 http(s):// 开头：${cfg.licenseBaseUrl}`)
  }
  // ⚠️ 本地控制台绑 0.0.0.0 是危险的（旧代码 D-6）。
  //    非回环绑定必须显式确认。
  if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.uiHost)
      && process.env.REPLY_ALLOW_PUBLIC_BIND !== '1') {
    problems.push(
      `拒绝把本地控制台绑到 ${cfg.uiHost}：这会让局域网内任何人访问，` +
      `且页面可被跨站调用。如确需，请设置 REPLY_ALLOW_PUBLIC_BIND=1 显式确认。`
    )
  }
  if (cfg.heartbeatIntervalMs < 10000) {
    problems.push('heartbeatIntervalMs 过小（<10 秒）会给服务端造成不必要的压力')
  }

  if (problems.length) {
    throw new Error('客户端配置校验失败：\n  - ' + problems.join('\n  - '))
  }
}

/** 保存实例配置（仅允许写非敏感项）。 */
function saveInstanceConfig(cfg, patch) {
  const forbidden = ['password', 'account_password', 'cookie', 'token', 'sign_key']
  for (const k of Object.keys(patch)) {
    if (forbidden.includes(k)) {
      throw new Error(`拒绝把敏感项 ${k} 写入实例配置文件（红线 3）`)
    }
  }
  const p = path.join(cfg.instanceDir, 'client-config.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
  const next = { ...cur, ...patch }
  // 原子写
  const tmp = p + cfg.tmpSuffix + '-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, p)
  return next
}

module.exports = {
  DEFAULTS,
  loadClientConfig,
  resolveWorkspace,
  resolveInstanceDir,
  detectChrome,
  saveInstanceConfig,
  validate,
}
