'use strict'

// client/host/main.js
//
// 客户端主进程入口 —— 把各层装配起来并管理生命周期。
//
// ⚠️ 本文件是"谁来 new 谁"的唯一答案。装配顺序有真实依赖，不能随意调整：
//    1. 配置（校验失败即退出，不带病启动）
//    2. Store（**唯一写盘者**，必须最先建，后面每层都要它）
//    3. 实例注册与调试端口（要在起浏览器之前定下来）
//    4. 本地 API（**先于登录**起：急停按钮必须在任何情况下可用）
//    5. 授权链路（http / auth / state）
//    6. 安全层（guard / circuit / similarity / audit）
//    7. 平台层（browserHost / page / verifier）—— 需要端口
//    8. 适配器与调度器
//    9. 若已持有有效凭据 → 自动续期并启动调度；否则等用户在界面上登录
//
// ⚠️ 三条关于退出路径的要求：
//    · **必须**注册 SIGINT/SIGTERM/uncaughtException，且退出前
//      `scheduler.stop()`（清全部定时器）+ 上报一次明细（停机前的补报，
//      契约 §4.8 明确要求）+ 关掉浏览器连接与本地 API。
//    · 退出流程必须**幂等**：信号可能来两次（Ctrl+C 连按），
//      第二次不能再跑一遍清理——那会出现"上报两次""关两次服务器"。
//    · **不能吞异常**。未捕获异常要打印并落审计，然后才退出。
//      静默吞掉的表现是"程序自己没了"，而商家完全不知道发生了什么。
//
// ⚠️ 本进程不做任何页面操作以外的判断。限额判定在 `safety/guard.js`，
//    计费判定在服务端。这里只负责接线。

const { loadClientConfig, saveInstanceConfig } = require('../config')
const { Store } = require('./store')
const { InstanceRegistry } = require('./instances')
const { Queue } = require('./queue')
const { Scheduler } = require('./scheduler')

const { LicenseHttp } = require('../license/http')
const { LicenseState } = require('../license/state')
const { LicenseAuth } = require('../license/auth')
const { Heartbeat } = require('../license/heartbeat')
const { Reporter } = require('../license/reporter')
const { scanForPrivacyLeaks } = require('../license/privacy')

const { Guard } = require('../safety/guard')
const { CircuitBreaker } = require('../safety/circuit')
const { AuditLog } = require('../safety/audit')
const similarity = require('../safety/similarity')

const { BrowserHost } = require('../core/browser-host')

const { CommentPage } = require('../platform/page-comment')
const { LivePage } = require('../platform/page-live')
const { ProfilePage } = require('../platform/page-profile')
const { PublishVerifier } = require('../platform/publish-verifier')

const { Collector } = require('../adapters/collect')
const { SendOutbox } = require('../adapters/send-outbox')
const { ReplyCommentAdapter } = require('../adapters/reply-comment')

/**
 * 引擎状态相位 → 审计的 `engine_state.event` 取值。
 *
 * ⚠️ 为什么需要这张映射：审计的 `event` 是闭集，而 Scheduler 的相位名
 *    是另一套（面向日志的）命名。直接透传会让审计里出现
 *    `state_change_callback_threw` 那种"没人认识的类别"。
 *    映射表上没有的相位**不写审计**（只写日志），这是刻意的：
 *    硬塞一个语义不符的类型比不记更糟。
 */
const ENGINE_PHASE_TO_ENGINE_EVENT = Object.freeze({
  started: 'engine_start',
  stopped: 'engine_stop',
  paused: 'engine_pause',
  resumed: 'engine_resume',
})

/** 待上报的审计条目缓冲上限（本地文件已落盘，这里只是上报队列）。 */
const AUDIT_UPLOAD_QUEUE_MAX = 5000

/**
 * 极简日志器：写 stdout 与实例目录下的滚动文件，**绝不写敏感字段**。
 */
class Logger {
  constructor(store, level = 'info') {
    this.store = store
    this.level = level
    this.levels = { debug: 10, info: 20, warn: 30, error: 40 }
  }

  #enabled(l) {
    return this.levels[l] >= this.levels[this.level]
  }

  #write(level, msg, detail) {
    if (!this.#enabled(level)) return
    const entry = { at_ms: Date.now(), level, msg }
    if (detail && typeof detail === 'object') {
      // ⚠️ 日志是"最容易泄露隐私的地方"——排障时顺手把整个对象打出来
      //    是本能动作。所以这里统一过一遍隐私扫描，命中就**替换**为
      //    路径列表而不是原样输出。
      const leaks = scanForPrivacyLeaks(detail)
      if (leaks.length) {
        entry.detail = { __privacy_redacted: leaks }
        entry.hint = '日志里出现了疑似隐私字段，已替换为字段路径列表（红线 3）'
      } else {
        entry.detail = detail
      }
    }
    const line = JSON.stringify(entry)
    process.stdout.write(line + '\n')
    if (this.store) {
      try {
        this.store.appendLine('client-log.jsonl', entry)
      } catch (e) {
        // ⚠️ 日志写盘失败不能影响主流程，但**必须**让人看到——
        //    否则"日志文件一直空着"会被误当成"程序没跑"。
        process.stderr.write(`[log] 写日志文件失败：${e.message}\n`)
      }
    }
  }

  debug(msg, d) { this.#write('debug', msg, d) }
  info(msg, d) { this.#write('info', msg, d) }
  warn(msg, d) { this.#write('warn', msg, d) }
  error(msg, d) { this.#write('error', msg, d) }
}

/**
 * 装配客户端。
 *
 * ⚠️ 拆成独立函数（而不是直接写在 `main()` 里）是为了让测试与
 *    "以库的方式嵌入"都可行。它**不监听端口、不启动调度**，
 *    只把对象建好并接线。
 *
 * @param {object} [opts]
 * @param {string} [opts.workspace]
 * @param {string} [opts.instanceId]
 * @param {object} [opts.overrides] 配置覆盖（测试用）
 * @param {boolean} [opts.startApi] 是否起本地 API（默认 true）
 */
async function bootstrap(opts = {}) {
  // ── 1. 配置 ────────────────────────────────────────────────
  const config = loadClientConfig(opts)

  // 待上报的审计条目缓冲（本地先落盘，再进这个队列）
  const auditUploadQueue = []

  // ── 2. Store（唯一写盘者）──────────────────────────────────
  const store = new Store({ dir: config.instanceDir })
  const logger = new Logger(store, config.logLevel)
  logger.info('boot_start', { instance_id: config.instanceId, workspace: config.workspace })

  // ── 3. 实例端口 ────────────────────────────────────────────
  const registry = new InstanceRegistry({
    store, debugPortBase: config.debugPortBase,
  })
  const pruned = registry.prune()
  if (pruned.removed) logger.info('instance_registry_pruned', pruned)
  const alloc = await registry.allocate(config.instanceId)
  logger.info('debug_port_ready', { port: alloc.debug_port, reason: alloc.reason })

  // ── 4. 安全层（越早越好：急停要能在登录之前生效）──────────
  //
  // ⚠️ AuditLog 的告警钩子是 `onWarn` / `onEntry`，不是 `logger`。
  //    传错的表现是"脱敏/隐私拦截发生了，但没有任何人被告知"——
  //    而审计的价值恰恰在于"出问题时有人能看到"。
  const audit = new AuditLog({
    store,
    onWarn: (evt) => logger.warn('audit_warn', evt),
    onEntry: (entry) => {
      // ⚠️ 本地先落盘再进上报队列（红线 3 的双写要求）。
      //    这里只做"进队列"的动作，真正的上报节奏由 scheduler 控制。
      auditUploadQueue.push(entry)
      if (auditUploadQueue.length > AUDIT_UPLOAD_QUEUE_MAX) {
        // 队列有上限：无限堆积会让内存涨上去，而审计条目本身
        // 已经在本地文件里了，丢掉最旧的只是延迟上报。
        auditUploadQueue.splice(0, auditUploadQueue.length - AUDIT_UPLOAD_QUEUE_MAX)
      }
    },
  })
  const guard = new Guard({ store })
  const circuit = new CircuitBreaker({ store, logger })

  // ── 5. 授权链路 ────────────────────────────────────────────
  const state = new LicenseState({
    store, instanceDir: config.instanceDir,
    clientVersion: readVersion(),
  })
  const securityEvents = []
  const http = new LicenseHttp({
    baseUrl: config.licenseBaseUrl,
    getAuthState: () => state.authSnapshot(),
    logger,
    onSecurityEvent: (e) => {
      securityEvents.push(e)
      audit.securityEvent(e)
    },
  })
  const auth = new LicenseAuth({
    http, state, clientVersion: readVersion(), logger,
    onSecurityEvent: (e) => {
      securityEvents.push(e)
      audit.securityEvent(e)
    },
  })
  const heartbeat = new Heartbeat({
    http, state, auth, guard, logger,
    clientVersion: readVersion(),
    getEngineSnapshot: () => engineSnapshotRef.current,
  })
  const reporter = new Reporter({
    http, state, auth, store, guard, logger,
    clientVersion: readVersion(),
  })

  // ── 6. 队列与发送链路 ──────────────────────────────────────
  const queue = new Queue({ store })
  const outbox = new SendOutbox({ store, logger: logger })
  const collector = new Collector({ queue, state, logger })

  // ── 7. 平台层（需要端口，所以放在这里）────────────────────
  // ⚠️ BrowserHost 接收**整个 config**（而不是逐个字段）：它需要
  //    `instanceDir` / `chromeProfilePath` / `chromePath` / `debugPortBase`，
  //    逐个传递只会在新增配置项时漏传，而漏传的表现是"浏览器起在了
  //    错误的 profile 目录"——那会让商家看到一个未登录的浏览器。
  const browserHost = await BrowserHost.create({
    ...config,
    debugPort: alloc.debug_port,
    logger,
  })
  const commentPage = new CommentPage({ host: browserHost, logger })
  const livePage = new LivePage({ host: browserHost, logger })
  const profilePage = new ProfilePage({ host: browserHost, logger })
  const verifier = new PublishVerifier({ browserHost, logger })

  const executors = {
    reply_comment: new ReplyCommentAdapter({
      page: commentPage, verifier, outbox, state, guard,
      similarity, logger,
    }),
    // ⚠️ 弹幕与私信适配器尚未实现。**不提供空实现**——空实现会让
    //    任务被当成"执行成功"从而被计费/被消费掉。宁可判
    //    NOT_IMPLEMENTED（不可重试、进 failed、界面可见）。
    reply_danmaku: null,
    send_dm: null,
  }

  /** 引擎快照（心跳要上报）。用 ref 避免循环依赖：heartbeat 先建，scheduler 后建。 */
  const engineSnapshotRef = {
    current: { engine_state: 'idle', instances: [], pending_send_count: 0 },
  }

  const scheduler = new Scheduler({
    store, guard, queue, auth, heartbeat, reporter, http, logger,
    executor: makeExecutor({ executors, schedulerRef: null }),
    onStateChange: (phase, detail) => {
      // ⚠️ 审计条目类型是**闭集**（`AUDIT_KINDS`），且**没有** `record()`
      //    这个通用方法——早期版本这里写成 `audit.record('engine_state', …)`，
      //    而 Scheduler 的 #emit 会 try/catch 把异常吞成一条 warn，
      //    于是**审计里永远没有引擎状态条目**，且没有任何人会发现。
      //    这类"审计静默失效"是最危险的一种：不报错、不留痕，
      //    只有真去查"当时为什么没在发"时才知道少了东西。
      const engineEvent = ENGINE_PHASE_TO_ENGINE_EVENT[phase]
      if (!engineEvent) {
        // 不是引擎状态相位（例如 credit_exhausted / clock_skew_warning），
        // 那些由各自的调用点记更贴切的类型。这里只记日志，不硬塞进审计。
        logger.info('scheduler_state', { phase, detail })
        return
      }
      try {
        audit.recordEngineState({
          event: engineEvent,
          reason: detail && detail.reason ? String(detail.reason) : null,
          actor: 'system',
          policyVersion: state.policyVersion,
          atMs: Date.now(),
        })
      } catch (e) {
        // ⚠️ 不吞。审计写失败是要暴露的问题（磁盘满/权限），
        //    但它**不能**打断调度——记日志继续跑。
        logger.error('audit_engine_state_failed', {
          phase, code: e && e.code, message: e && e.message,
        })
      }
      logger.info('scheduler_state', { phase, detail })
    },
  })

  // ── 8. 本地 API（**先于登录**起，急停必须随时可用）─────────
  let api = null
  if (opts.startApi !== false) {
    const { create_local_api: createLocalApi } = require('./api')
    api = createLocalApi({
      config, store, guard, circuit, audit, queue, scheduler,
      state, auth, reporter, collector, logger,
      livePage, commentPage, profilePage,
      getEngineSnapshot: () => engineSnapshotRef.current,
    })
    if (opts.listenApi !== false) await api.listen()
  }

  // 引擎快照刷新
  const refreshSnapshot = () => {
    const snap = scheduler.snapshot()
    const used = snap.guard && snap.guard.used ? snap.guard.used : {}
    engineSnapshotRef.current = {
      engine_state: snap.engine_state,
      instances: [{ instance_id: config.instanceId, engine_state: snap.engine_state, daily_used_total: sumOf(used) }],
      daily_used: used,
      pending_send_count: queue.pendingSendCount(),
      last_error_code: snap.stats && snap.stats.lastError ? snap.stats.lastError.code : null,
    }
  }
  refreshSnapshot()
  const snapshotTimer = setInterval(refreshSnapshot, 2000)
  if (snapshotTimer.unref) snapshotTimer.unref()

  return {
    config, store, logger, registry, guard, circuit, audit, state, http, auth,
    heartbeat, reporter, queue, outbox, collector, browserHost,
    commentPage, livePage, profilePage, verifier, scheduler, api,
    securityEvents, refreshSnapshot, auditUploadQueue,
    timers: [snapshotTimer],
  }
}

/** 执行器分发。⚠️ 未实现的任务类型必须显式失败，不能返回成功。 */
function makeExecutor({ executors }) {
  return async function execute(task) {
    const fn = executors[task.kind]
    if (!fn) {
      const e = new Error(`任务类型 ${task.kind} 尚未实现`)
      e.code = 'NOT_IMPLEMENTED'
      throw e
    }
    return fn.run(task)
  }
}

/**
 * 启动（会起本地 API 与调度器）。
 *
 * ⚠️ 自动登录/续期的分支：
 *    · 有凭据 → 先 `bootstrap()` 过版本闸门，再 `refresh()` 换新 token
 *      （凭据可能已过期，而续期接口允许用过期 token）。
 *    · 续期失败且是身份类错误 → **不阻塞启动**：本地 API 与采集链路
 *      照常起来，界面提示重新登录。理由：商家打开程序的第一件事
 *      往往是看数据，而不是登录；直接拒绝启动会让他以为程序坏了。
 */
async function start(app) {
  const { logger, auth, state, scheduler, config, api } = app

  if (api) {
    const desc = api.describe()
    logger.info('api_listening', {
      url: desc.url || `http://${config.uiHost}:${api.port}/`,
      host: config.uiHost,
      port: api.port,
    })
    // ⚠️ 启动后**断言**实际绑定的地址是回环。config.js 已经拦过一次，
    //    但"配置写的是回环"与"真的绑到回环"是两件事（例如 host 传了
    //    `localhost` 而系统解析到非回环地址）。这里再确认一次，
    //    因为这条错误一旦漏出，局域网内任何人都能代替商家发评论。
    if (!desc.loopback_asserted && !isLoopbackHost(desc.host || config.uiHost)) {
      logger.warn('api_bound_non_loopback', {
        host: desc.host || config.uiHost,
        hint: '本地控制台未绑定回环地址。局域网内任何人都能访问，' +
              '且任意网页可跨站调用它代替你发送评论（旧代码的 D-6 缺陷）。',
      })
    }
  }

  if (state.isLoggedIn) {
    try {
      await auth.bootstrap()
      await auth.refresh()
      logger.info('silent_relogin_ok', { account_id: state.accountId })
    } catch (e) {
      logger.warn('silent_relogin_failed', { code: e && e.code, message: e && e.message })
      if (auth.constructor.isReauthRequired(e.code)) {
        auth.markCredentialInvalid(e.code, e.detail)
      }
    }
  } else {
    logger.info('not_logged_in', { hint: '本地界面照常可用；采集与发送将在登录后开始' })
  }

  // 崩溃留下的"结果未知"发送先转成待上报明细（不计费，且**不重发**）
  const drained = app.reporter.drainOutbox()
  if (drained) logger.warn('outbox_drained_on_boot', { count: drained })

  if (state.isLoggedIn) {
    scheduler.start()
  } else {
    // ⚠️ 不启动调度器：没有策略就没有准入依据，护栏会 fail-closed
    //    逐条拒绝。启动它只会空转并刷日志。
    logger.info('scheduler_not_started', { reason: 'no_credentials' })
  }

  return app
}

/**
 * 优雅退出。
 *
 * ⚠️ 幂等：信号可能来两次（Ctrl+C 连按）。第二次必须**立即**返回，
 *    否则会出现"上报两次""关两次服务器"这类难以解释的现象。
 */
function makeShutdown(app) {
  let running = null

  return function shutdown(reason) {
    if (running) {
      app.logger.warn('shutdown_already_running', { reason })
      return running
    }
    running = (async () => {
      app.logger.info('shutdown_begin', { reason })

      // ① 先停调度：清掉全部定时器，不再产生新的发送与上报
      try {
        app.scheduler.stop(`shutdown:${reason}`)
      } catch (e) {
        app.logger.error('shutdown_scheduler_failed', { message: e && e.message })
      }

      // ② 停机前补报一次明细（契约 §4.8 明确要求）
      try {
        const r = await app.reporter.reportSends()
        if (r) app.logger.info('shutdown_final_report', { accepted: r.accepted, error: r.error || null })
      } catch (e) {
        app.logger.warn('shutdown_final_report_failed', { code: e && e.code, message: e && e.message })
      }

      // ③ 关掉浏览器连接与本地 API
      try {
        await app.browserHost.close({ silent: true })
      } catch (e) {
        app.logger.warn('shutdown_browser_failed', { message: e && e.message })
      }
      try {
        if (app.api) await app.api.close()
      } catch (e) {
        app.logger.warn('shutdown_api_failed', { message: e && e.message })
      }

      // ④ 释放端口注册与 Store（Store 必须最后关：前面几步还要写盘）
      try {
        app.registry.release(app.config.instanceId)
      } catch (e) {
        app.logger.warn('shutdown_registry_failed', { message: e && e.message })
      }
      for (const t of app.timers || []) {
        try { clearInterval(t) } catch (e) {
          app.logger.warn('shutdown_timer_clear_failed', { message: e && e.message })
        }
      }
      try {
        app.store.close()
      } catch (e) {
        process.stderr.write(`[shutdown] Store 关闭失败：${e.message}\n`)
      }

      app.logger.info('shutdown_done', { reason })
    })()
    return running
  }
}

async function main() {
  let app = null
  let shutdown = null

  try {
    app = await bootstrap()
    await start(app)
    shutdown = makeShutdown(app)
  } catch (e) {
    process.stderr.write(`[fatal] 启动失败：${e && e.message}\n`)
    if (e && e.stack) process.stderr.write(e.stack + '\n')
    process.exit(1)
  }

  // ⚠️ 三个信号都要处理。Windows 上 Ctrl+C 走 SIGINT，
  //    而关窗口走的是进程被杀（无法捕获）——所以持久化必须靠
  //    "每次操作后立即落盘"而不是"退出时统一保存"。
  const onSignal = (sig) => {
    shutdown(sig).then(() => process.exit(0)).catch((e) => {
      process.stderr.write(`[fatal] 退出流程失败：${e && e.message}\n`)
      process.exit(1)
    })
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  // ⚠️ 未捕获异常**不能吞**。落审计 + 打印，然后退出。
  //    静默吞掉的表现是"程序自己没了"，商家完全不知道发生了什么。
  process.on('uncaughtException', (e) => {
    app.logger.error('uncaught_exception', { message: e && e.message, stack: e && e.stack })
    onSignal('uncaughtException')
  })
  process.on('unhandledRejection', (r) => {
    app.logger.error('unhandled_rejection', {
      message: r && r.message ? r.message : String(r),
      stack: r && r.stack,
    })
    // ⚠️ 未处理的 Promise 拒绝不退出进程：它多半是某次网络请求没接住，
    //    而退出会让商家的采集/发送全部中断。留痕足以排查。
  })

  app.logger.info('boot_done', {
    instance_id: app.config.instanceId,
    ui_url: app.api ? app.api.url : null,
    debug_port: app.registry.get(app.config.instanceId).debug_port,
  })

  return app
}

// ── 直接运行时启动 ──────────────────────────────────────────
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[fatal] 未预期的启动异常：${e && e.message}\n`)
    process.exit(1)
  })
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

function readVersion() {
  try {
    // eslint-disable-next-line global-require
    return require('../../package.json').version || '0.0.0'
  } catch (e) {
    // package.json 读不到不影响运行，但版本上报会退化。
    // 留一个显式的标记，便于在服务端看到"这个客户端没报版本"。
    return '0.0.0-unknown'
  }
}

function sumOf(obj) {
  let n = 0
  for (const v of Object.values(obj || {})) n += Number(v || 0)
  return n
}

/** 回环判定（与 api.js 的判据保持一致，但不复用它的内部实现）。 */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '::ffff:127.0.0.1'
}

module.exports = {
  bootstrap, start, main, makeShutdown, Logger, makeExecutor,
  saveInstanceConfig,
}
