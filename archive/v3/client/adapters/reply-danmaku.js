'use strict'

// client/adapters/reply-danmaku.js
//
// 直播间弹幕回复的**薄编排层**。结构与 `reply-comment.js` 同形，
// 但有一处**本质区别**，它决定了整个文件的写法：
//
// ⚠️⚠️ 弹幕发出去之后就**消失在滚动流里**，事后**没有任何 DOM 证据**。
//      评论区可以滚回去看"我那条回复在不在"，弹幕不行——它已经滚走了，
//      直播间也不会为某一条弹幕保留可回读的节点。
//
//      所以对本文件而言，**唯一可接受的成功证据是平台响应体**
//      （`live/comment/send` 的 `status_code === 0`，由 `PublishVerifier` 捕获）。
//      推论有三条，每一条都写在对应的代码位置上：
//
//        ① **绝不回落 DOM 判据**。`sent_confirmed_dom` 对弹幕是
//           **不可获得**的形态，不是"暂时拿不到"。抓不到响应就是
//           `sent_suspected`（`is_final: false`），到此为止。
//           ⚠️ 给弹幕加 DOM 兜底不是"补上一个缺失的功能"，而是**缺陷**：
//              它只能产出一个无法证伪的假证据，把"不知道"伪装成"确认过"，
//              而红线 2 的计费依据正是这份证据。
//        ② 因此**不得**调用 `waitForReplyStable` 这类以 DOM 为准的接口
//           （`LivePage` 上也刻意没有这个方法）。源码扫描测试会守住这条。
//        ③ 捕获窗口**必须在提交之前**打开，且中间不得插入长等待：
//           弹幕漏掉捕获窗口是**不可挽回**的——评论还能靠 DOM 兜一下，
//           弹幕连兜的机会都没有，结果就是"这条到底发出去没有"永远说不清。
//
// ⚠️ 另外两处顺序与评论链路完全一致，同样是"错了就产生无法复现的缺陷"：
//
//      · **先落盘 send_id，再发送**（AGENTS.md §2.7）
//        反了 → 崩溃后重发 → 重复弹幕 + 重复计费。
//      · **相似度检查在渲染之后、发送之前**
//        放到发送之后就是"发完才发现不该发"，护栏失去意义。
//
// ⚠️ 本文件**不做**准入判定（`guard.canSend` 由调度器在取任务前做）。
//    这里出现的任何 `daily_max` / `min_interval_ms` 比较都是分层错误。
//    `live_danmaku` 的独立限额、活跃时段、冷却全部不归本文件管。
//
// ⚠️⚠️ **队列里没有弹幕原文，只有哈希**（见 `collect.js` 文件头的红线说明）。
//     定位因此是两步：入队时算正文哈希 → 出队时扫当前弹幕、对每条算同样的
//     哈希、命中即锁定。弹幕还会不断滚出可及范围，所以"扫不到"是常态而非异常，
//     判 `skipped` 而不是 failed（重试一万次也扫不到一条已经滚走的弹幕）。

const { WorkbenchError, toWorkbenchError } = require('../core/workbench-error')
const { userKeyHash, targetHash, contentHash } = require('../license/privacy')
const { matchRules } = require('./keyword-match')
const { renderReply, validateTemplates } = require('./reply-renderer')
const timing = require('../safety/timing')

/** 弹幕回复的平台接口（闭集白名单里的值，契约 §4.8） */
const ENDPOINT = 'live/comment/send'

/** 定位时扫描的弹幕条数上限 */
const LOCATE_SCAN_LIMIT = 200

class ReplyDanmakuAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.page         LivePage
   * @param {object} opts.verifier     PublishVerifier
   * @param {object} opts.outbox       SendOutbox
   * @param {object} opts.state        LicenseState（取 privacy_salt 与策略版本）
   * @param {object} [opts.similarity] client/safety/similarity.js
   * @param {object} [opts.guard]      只读，用于取**实际生效**的相似度阈值
   * @param {object} [opts.logger]
   * @param {() => number} [opts.rng]
   */
  constructor(opts) {
    if (!opts || !opts.page || !opts.verifier || !opts.outbox || !opts.state) {
      throw new Error('ReplyDanmakuAdapter 需要 page / verifier / outbox / state')
    }
    this.page = opts.page
    this.verifier = opts.verifier
    this.outbox = opts.outbox
    this.similarity = opts.similarity || null
    this.guard = opts.guard || null
    this.state = opts.state
    this.logger = opts.logger || null
    this.rng = opts.rng || Math.random
    /** 近期已发文案（内存环形缓冲，用于相似度比对） */
    this.recentTexts = []
    this.recentLimit = 50
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  /**
   * 取 privacy_salt。
   *
   * ⚠️ 没有盐就无法生成隐私哈希（红线 3 要求只上传哈希）。
   *    这时**不能**退化用明文或不用盐——前者泄露原文，后者可被彩虹表反查。
   *    与 `reply-comment.js` / `collect.js` 保持同一个口径：宁可不发。
   */
  #salt() {
    const s = this.state.privacySalt
    if (!s) {
      throw new WorkbenchError(
        'INTERNAL',
        '缺少 privacy_salt，无法生成隐私哈希，已拒绝发送。请重新登录以获取服务端下发的盐。',
        { field: 'privacy_salt', hint: '不进行降级：无盐哈希等于泄露原文' }
      )
    }
    return s
  }

  /** 记一条已发文案进环形缓冲（相似度护栏的依据）。 */
  rememberSent(text) {
    this.recentTexts.push(String(text))
    if (this.recentTexts.length > this.recentLimit) {
      this.recentTexts = this.recentTexts.slice(-this.recentLimit)
    }
  }

  /**
   * 执行一次弹幕回复。
   *
   * @param {object} task
   * @param {string} task.payload.roomUrl
   * @param {string} task.payload.roomId
   * @param {string|null} task.payload.msgId        平台弹幕 ID（**首选定位身份**）
   * @param {string} [task.payload.rowKey]          采集时该行的稳定键（msgId 的退化形态）
   * @param {string} task.payload.bodyKeyHash       正文哈希（**定位锚点**，不是原文）
   * @param {string} [task.payload.bodyKeyPrefix]   正文展示截断（日志用）
   * @param {string} [task.payload.userKey]         昵称展示截断（提高定位精度）
   * @param {string} [task.payload.userKeyHash]     用户哈希（采集阶段算好带下来的）
   * @param {string} task.payload.targetHash        采集阶段算好的 target_hash（**原样复用**）
   * @param {Array}  task.payload.rules             规则列表 `[{id, keyword, templates}]`
   */
  async run(task) {
    const p = (task && task.payload) || {}
    if (!p.roomUrl || !p.bodyKeyHash) {
      throw new WorkbenchError('NOT_LOCATABLE',
        '任务缺少 roomUrl 或 bodyKeyHash，无法定位弹幕',
        { has_url: Boolean(p.roomUrl), has_hash: Boolean(p.bodyKeyHash) })
    }

    const salt = this.#salt()

    // ── ① 打开直播间并把正文从页面读回来 ─────────────────────
    // ⚠️ `LivePage.open` 在"直播已结束/正在回放"时抛 NOT_LOCATABLE——
    //    那是不可重试的语义（回放页永远不会有新弹幕），不该由本文件吞掉重试。
    await this.page.open(p.roomUrl)
    const located = await this.#locateInPage(p, salt)
    if (!located) {
      // ⚠️ 找不到 = 弹幕可能已经滚出可及范围、直播间被切走、或内容已被删除。
      //    判 `skipped` 而不是 failed：不需要重试（弹幕滚走了就不会回来），
      //    也不该计入熔断——把它算成"发送失败"会让风控统计凭空变脏。
      this.#log('info', 'danmaku_not_found', {
        scanned: LOCATE_SCAN_LIMIT,
        // ⚠️ 只记展示截断，不记任何正文（红线 3）
        prefix: p.bodyKeyPrefix || null,
      })
      return { outcome: 'skipped', reason: 'danmaku_not_found' }
    }
    // 正文只活在本次调用的内存里，不会写回队列（红线 3）
    p.bodyKey = located.text

    // ── ② 渲染文案（命中规则才有得发）────────────────────────
    const rendered = this.#renderFor(p)
    if (!rendered) return { outcome: 'skipped', reason: 'no_rule_matched' }

    // ── ③ 相似度护栏（发送之前）──────────────────────────────
    const sim = this.#checkSimilarity(rendered.text)
    if (!sim.allow) {
      // ⚠️ 相似度被拒 → `failed` + `content_rejected`（契约 §7.4 的闭集值）。
      //    它**不是** skipped：skipped 是"命中但按策略不回复"，
      //    而这里是"本该回复、但内容不合格被护栏拦下"——两者在看板上的
      //    含义完全不同，混用会让运营看不出"需要补充文案"。
      return {
        outcome: 'failed',
        verdict: 'failed',
        failureReason: 'content_rejected',
        evidence: {
          confirm_signal: 'none',
          platform_endpoint: null,
          platform_status_code: null,
          risk_control_signal: null,
          similarity: sim.similarity,
          threshold: sim.threshold,
          note: 'content_similarity_rejected',
        },
      }
    }

    // ── ④ 生成 send_id 并**先落盘**────────────────────────────
    // ⚠️ 刻意放在"聚焦公屏输入框"**之前**。契约只要求"发送前"，
    //    更早落盘更安全：崩溃恢复时宁可多一条 unknown（判 suspected、
    //    不计费），也不愿意少一条（那笔就彻底消失了）。
    const record = this.outbox.begin({
      sourceType: 'live_danmaku',
      // ⚠️ target_hash 直接**复用采集阶段算好的值**，不在适配器里重算。
      //    理由：`collect.js` 在没有稳定 msg_id 时会退化成
      //    `room_id|rowKey|content_hash` 的口径，适配器看不到 rowKey 的来源，
      //    重算必然与队列的去重键不一致——那会让"同一条弹幕的两次尝试"
      //    在服务端聚合成两个目标，attempt_seq 与去重统计一起失真。
      //    兜底（理论上不可达）用 msgId → bodyKeyHash 的同口径重算。
      targetHash: p.targetHash || targetHash(`${p.roomId || ''}|${p.msgId || p.bodyKeyHash}`, salt),
      // ⚠️ 队列里没有 secUid（也不该有）。用户哈希由 collect 阶段算好带下来。
      userKeyHash: p.userKeyHash || null,
      userKeyType: p.userKeyHash ? 'sec_uid' : null,
      contentHash: contentHash(rendered.text, salt),
      applied_policy_version: this.state.policyVersion,
      instance_id: this.state.instanceIdValue,
    })
    const sentAtMs = record.sent_at_ms

    // ── ⑤ 聚焦直播间公屏输入框（做错会把弹幕打进搜索框之类的别处）──
    const focused = await this.page.focusInput()
    if (!focused || focused.ok !== true) {
      // ⚠️ 这里**已经在 outbox 里留了记录**，所以不能悄悄返回 skipped——
      //    那会留下一条永远 unknown 的账，恢复时被判 sent_suspected 上报，
      //    凭空多出一条"疑似已发送"。抛错让上层走异常路径，
      //    由 `recoverUnknown()` 统一处置（不重发、可升级）。
      throw new WorkbenchError('ELEMENT_TIMEOUT',
        '未能聚焦直播间公屏输入框，已放弃本次发送（弹幕会打到别处）',
        { selector: 'danmakuRow', reason: focused ? focused.reason : 'null', send_id: record.send_id })
    }

    let result = null
    try {
      // ── ⑥ 开始捕获响应（**必须在按 Enter 之前**）──────────
      // ⚠️ 对弹幕而言这一步比评论链路更关键：漏掉捕获窗口**不可挽回**，
      //    因为没有任何 DOM 证据可以事后补判（见文件头 ①）。
      await this.verifier.beginCapture('live', ENDPOINT)

      // ── ⑦ 输入文案（真人化：分块 + 随机停顿 + 回读校验）──
      // ⚠️ 打字计划来自 `safety/timing.js` 的 `typingPlan()`，不是自造的
      //    "每字符 sleep 50ms"。旧代码的固定节奏是典型机器人特征，
      //    而"人味"只应该有一份实现（散落各处必然漂移）。
      const plan = timing.typingPlan(rendered.text, { rng: this.rng })
      await this.page.typeIntoInput(rendered.text, { plan })

      // ── ⑧ 提交（Enter 为主路径；`submitDanmaku` 内部等待刻意很短，
      //        否则会把下面的捕获窗口耗掉）────────────────────
      await this.page.submitDanmaku()

      // ── ⑨ 用**平台响应体**判定（弹幕唯一可用的判据）──────
      const verified = await this.verifier.verify({ timeoutMs: 10000, sentAtMs })
      result = await this.#settleOutcome({ record, verified })
    } catch (e) {
      // ⚠️ 抛错时**不能**把 outbox 记录判成 failed：错误可能发生在
      //    "已经按了 Enter、读结果时出错"之后，那条弹幕其实已经发出去了。
      //    统一按 unknown 保留，交给 recoverUnknown() 以 sent_suspected
      //    上报（is_final:false，之后仍可升级）。判 failed 会让它永久
      //    失去升级机会。
      this.#log('warn', 'send_aborted_after_begin', {
        send_id: record.send_id, code: e && e.code, message: e && e.message,
        hint: 'outbox 保留为 unknown；不重发，稍后按 sent_suspected 上报',
      })
      await this.#abortCapture()
      throw toWorkbenchError(e, 'INTERNAL', { send_id: record.send_id })
    }

    this.rememberSent(rendered.text)

    return {
      outcome: result.verdict === 'failed' ? 'failed' : 'done',
      verdict: result.verdict,
      failureReason: result.failure_reason,
      evidence: result.evidence,
      sendId: result.send_id,
      userKeyHash: result.user_key_hash,
      detail: {
        template_index: rendered.templateIndex,
        // ⚠️ 只记长度不记原文。回复原文属隐私内容，日志与上报都不得包含。
        text_length: rendered.text.length,
        rule_id: rendered.ruleId,
      },
    }
  }

  /**
   * 判定收敛：写回 outbox。
   *
   * ⚠️⚠️ 与评论链路的 `#settleOutcome` **关键差别**：这里**没有 DOM 分支**。
   *      评论区在抓不到响应时会退一步看"回复节点是否稳定存在"，产出
   *      `sent_confirmed_dom`（默认不计费）；弹幕**没有这个退路**——
   *      弹幕已经滚走了，去看 DOM 只能得到"页面上没有这条弹幕"，
   *      而那既不能证明发出去了、也不能证明没发出去。
   *
   *      ⚠️ 所以这里**不得**新增任何"看看页面上有没有"的兜底。
   *         给弹幕加 DOM 兜底不是补功能，而是制造假证据：
   *         它会把"我们不知道"包装成"确认过"，而这份证据是计费依据。
   *
   * ⚠️ 也刻意**不重试、不重发**。抓不到响应时唯一的"补救"是再按一次
   *    Enter，而那可能真的发出第二条弹幕——重复发言是最容易被平台
   *    识别为机器人的行为，代价远大于"少算一条"。
   */
  async #settleOutcome({ record, verified }) {
    if (verified.verdict !== 'sent_suspected') {
      return this.outbox.settle(record.send_id, verified)
    }

    // ⚠️ 显式重申 `is_final: false` 与证据原样保留。
    //    `verify()` 已经给过这个值，这里再走一遍 `settle` 是为了让
    //    "弹幕的疑似**必然**不可终局"这件事在代码里看得见——
    //    将来有人给 `verify()` 加默认值也不会静默把弹幕判成终局。
    return this.outbox.settle(record.send_id, {
      verdict: 'sent_suspected',
      is_final: false,
      evidence: verified.evidence,
      failure_reason: null,
    })
  }

  /** 收尾响应捕获。⚠️ 异常路径也要调，否则 Network 监听器泄漏。 */
  async #abortCapture() {
    if (this.verifier && typeof this.verifier.abortCapture === 'function') {
      await this.verifier.abortCapture().catch((e2) => {
        this.#log('warn', 'abort_capture_failed', { message: e2 && e2.message })
      })
    }
  }

  /**
   * 在当前可见弹幕里按身份/正文哈希找回目标那条。
   *
   * ⚠️ 这是"队列不存原文"这个决定的代价，也是它的实现：
   *    扫描 → 本地算哈希 → 命中即锁定。
   *
   * ⚠️ 顺序是**稳定身份优先，内容哈希兜底**：
   *    `collect.js` 给弹幕的 `payload.msgId` 来自采集时的行属性
   *    （`data-msg-id` / `data-id` …），而 `LivePage.collect()` 把**同一组属性**
   *    归到 `rowKey` 上——两者是同一个稳定身份，只是落在了不同的字段名里。
   *    所以这里先比 `msgId === rowKey`，再退到内容哈希。
   *
   *    ⚠️ 为什么必须优先用身份而不是文本：同一句话在直播间会被大量复读
   *       （"多少钱"会被几十个人各刷一遍），只按哈希匹配会锁定到**别人**的
   *       那条弹幕，于是回复给了不相干的人。身份命中不了时才退到哈希，
   *       此时再叠一层昵称展示截断提高精度。
   *
   * @returns {Promise<{rowKey:string, text:string, user:string}|null>}
   */
  async #locateInPage(p, salt) {
    // ⚠️ 扫描失败**不能**静默返回 null —— 那会让"页面没加载出来"与
    //    "弹幕真的滚走了"混为一谈，而两者的处置完全不同
    //    （前者应重排队，后者应跳过）。
    const rows = await this.page.collect({ limit: LOCATE_SCAN_LIMIT })

    // ① 稳定身份：msgId / rowKey（两者同源，见上）
    const stableKey = p.msgId || p.rowKey || null
    if (stableKey) {
      for (const row of rows) {
        if (row.rowKey && String(row.rowKey) === String(stableKey)) return row
      }
    }

    // ② 内容哈希（+ 昵称展示截断）
    for (const row of rows) {
      if (contentHash(row.text, salt) !== p.bodyKeyHash) continue
      if (p.userKey && row.user && !String(row.user).startsWith(String(p.userKey))) continue
      return row
    }
    return null
  }

  /** 按规则挑模板并渲染。 */
  #renderFor(p) {
    const rules = Array.isArray(p.rules) ? p.rules : []
    if (!rules.length) return null

    // ⚠️ 弹幕侧同样用 **strict: true**。宽松匹配会给不相关的人发弹幕，
    //    而"答非所问"在直播间是**公开可见**的（弹幕所有人都看得到），
    //    比评论区误回复更容易招致举报。
    //    匹配用的是从页面读回来的正文，不是队列里的哈希——
    //    关键词匹配无法在哈希上做。
    const hit = matchRules(p.bodyKey, rules, { strict: true })
    if (!hit) return null

    // ⚠️ 模板池校验放在渲染处兜底：规则可能被绕过界面直接改文件，
    //    而"少于 5 条变体"会让相似度护栏频繁拒绝（表现为"配好了但不回复"）。
    const check = validateTemplates(hit.rule.templates)
    if (!check.ok) {
      throw new WorkbenchError('CONFIG_INVALID',
        `规则「${hit.rule.keyword}」的模板池不合格：${check.problems.join('；')}`,
        { rule_id: hit.rule.id, problems: check.problems })
    }
    const r = renderReply({ templates: hit.rule.templates, rng: this.rng })
    return { ...r, ruleId: hit.rule.id, keyword: hit.rule.keyword }
  }

  /**
   * 相似度护栏。
   *
   * ⚠️ 阈值来自**策略**（`content_similarity_max`），取的是护栏的
   *    **实际生效值**（商家可以调更低，红线 1）。弹幕与评论共用同一个字段，
   *    但必须按 `live_danmaku` 这个渠道去取——将来三个渠道的阈值分叉时，
   *    写死渠道名之外的任何东西都会静默取错值。
   * ⚠️ 方向：相似度**超过**阈值即拒绝（AGENTS.md §2.4）。
   */
  #checkSimilarity(text) {
    if (!this.similarity) return { allow: true, similarity: 0, threshold: null }
    const limits = this.guard ? this.guard.effectiveLimits('live_danmaku') : null
    const raw = limits ? limits.content_similarity_max : undefined
    if (raw === undefined || raw === null) {
      // ⚠️ 没有阈值就不做相似度判定，但要留痕——静默跳过会让
      //    "为什么这条没被拦"无从回答。
      this.#log('warn', 'similarity_threshold_missing', { source_type: 'live_danmaku' })
      return { allow: true, similarity: 0, threshold: null }
    }
    return this.similarity.checkContent(text, {
      recentTexts: this.recentTexts,
      threshold: Number(raw),
    })
  }
}

module.exports = {
  ReplyDanmakuAdapter,
  ENDPOINT,
  LOCATE_SCAN_LIMIT,
}
