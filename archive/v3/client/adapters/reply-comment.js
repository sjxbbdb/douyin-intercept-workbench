'use strict'

// client/adapters/reply-comment.js
//
// 评论回复的**薄编排层**：把平台原语串成一次业务动作，并保证红线 2 的顺序。
//
// ⚠️ 本文件是"发送链路"的落点，其正确性由**步骤顺序**决定，
//    而不是由任何一行代码的复杂度决定。计划文档 §4.7 的 15 步里，
//    有 3 步的顺序错了就会产生无法复现的缺陷：
//
//      ① **先落盘 send_id，再发送**（AGENTS.md §2.7）
//         反了 → 崩溃后重发 → 重复回复 + 重复计费。
//
//      ② **先开始响应捕获，再按 Enter**（`publish-verifier.beginCapture`）
//         反了 → 平台响应比下一行代码还快 → 全部变成 sent_suspected
//         → 一条都不计费。对商家"有利"，但"到底发出去没有"永远说不清。
//
//      ③ **相似度检查在渲染之后、发送之前**
//         放到发送之后就是"发完才发现不该发"，护栏失去意义。
//
// ⚠️ 本文件**不做**准入判定（`guard.canSend` 由调度器在取任务前做）。
//    这里出现的任何 daily_max / min_interval 比较都是分层错误。
//
// ⚠️ DOM 判据的使用被限制在一处：`waitForReplyStable` 的结果只能用于
//    产出 `sent_confirmed_dom`（**默认不计费**）。本文件不接受任何
//    "编辑器消失了所以应该算成功"的推断——那是旧代码最严重的缺陷（D-12）。
//
// ⚠️⚠️ **队列里没有评论原文，只有哈希**（见 `collect.js` 文件头的说明）。
//    所以定位流程是两步：入队时算正文哈希 → 出队时扫页面、对每条评论
//    算同样的哈希、命中即锁定。多一次页面扫描，换来盘上永远没有原文。

const { WorkbenchError, toWorkbenchError } = require('../core/workbench-error')
const { userKeyHash, targetHash, contentHash } = require('../license/privacy')
const { matchRules } = require('./keyword-match')
const { renderReply, validateTemplates } = require('./reply-renderer')
const timing = require('../safety/timing')

/** 评论回复的平台接口（闭集白名单里的值） */
const ENDPOINT = 'comment/publish'

/** 定位时扫描的评论条数上限 */
const LOCATE_SCAN_LIMIT = 200

class ReplyCommentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.page         CommentPage
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
      throw new Error('ReplyCommentAdapter 需要 page / verifier / outbox / state')
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
   *    这时**不能**退化用明文或不用盐——前者泄露原文，后者可被彩虹表反查
   *    （抖音用户 ID 空间可枚举，无盐哈希等于"换个写法上传原文"）。
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
   * 执行一次评论回复。
   *
   * @param {object} task
   * @param {string} task.payload.videoUrl
   * @param {string} task.payload.videoId
   * @param {string} task.payload.commentId
   * @param {string} task.payload.bodyKeyHash    正文哈希（**定位锚点**，不是原文）
   * @param {string} [task.payload.bodyKeyPrefix] 正文展示截断（日志用）
   * @param {string} [task.payload.userKey]      昵称（可选，提高定位精度）
   * @param {Array}  task.payload.rules          规则列表 `[{id, keyword, templates}]`
   */
  async run(task) {
    const p = (task && task.payload) || {}
    if (!p.videoUrl || !p.bodyKeyHash) {
      throw new WorkbenchError('NOT_LOCATABLE',
        '任务缺少 videoUrl 或 bodyKeyHash，无法定位评论',
        { has_url: Boolean(p.videoUrl), has_hash: Boolean(p.bodyKeyHash) })
    }

    const salt = this.#salt()

    // ── ① 打开页面并把正文从页面读回来 ───────────────────────
    await this.page.open(p.videoUrl)
    const located = await this.#locateInPage(p, salt)
    if (!located) {
      // ⚠️ 找不到 = 评论可能已被删除、被折叠、或已滚出可及范围。
      //    判 `skipped` 而不是 failed：不需要重试（重试一万次也找不到），
      //    也不该计入熔断。
      return { outcome: 'skipped', reason: 'comment_not_found' }
    }
    // 正文只活在本次调用的内存里，不会写回队列（红线 3）
    p.bodyKey = located.text

    const scrolled = await this.page.scrollToComment({ bodyKey: p.bodyKey, userKey: p.userKey })
    if (!scrolled.found) {
      return { outcome: 'skipped', reason: 'comment_not_found' }
    }

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
    // ⚠️ 刻意放在"激活编辑器"**之前**。契约只要求"发送前"，
    //    更早落盘更安全：崩溃恢复时宁可多一条 unknown（判 suspected、
    //    不计费），也不愿意少一条（那笔就彻底消失了）。
    const record = this.outbox.begin({
      sourceType: 'comment',
      // 契约 §4.8：target_hash = hmac(salt, video_id + "|" + comment_id)
      targetHash: targetHash(`${p.videoId || ''}|${p.commentId || ''}`, salt),
      // ⚠️ 队列里没有 secUid（也不该有）。用户哈希由 collect 阶段算好带下来。
      userKeyHash: p.userKeyHash || null,
      userKeyType: p.userKeyHash ? 'sec_uid' : null,
      contentHash: contentHash(rendered.text, salt),
      applied_policy_version: this.state.policyVersion,
      instance_id: this.state.instanceIdValue,
    })
    const sentAtMs = record.sent_at_ms

    // ── ⑤ 激活内联编辑器（做错会把回复发成顶级评论）──────────
    await this.page.activateInlineEditor({ bodyKey: p.bodyKey, userKey: p.userKey })

    let result = null
    try {
      // ── ⑥ 开始捕获响应（**必须在按 Enter 之前**）──────────
      await this.verifier.beginCapture('comment', ENDPOINT)

      // ── ⑦ 输入文案（真人化：分块 + 随机停顿 + 回读校验）──
      // ⚠️ 打字计划来自 `safety/timing.js` 的 `typingPlan()`，不是自造的
      //    "每字符 sleep 50ms"。旧代码的固定节奏是典型机器人特征，
      //    而"人味"只应该有一份实现（散落各处必然漂移）。
      const plan = timing.typingPlan(rendered.text, { rng: this.rng })
      await this.page.typeIntoEditor(rendered.text, { plan })

      // ── ⑧ 提交（Enter 为主路径，见 legacy 经验）──────────
      await this.page.submitReply()

      // ── ⑨ 用**平台响应体**判定（唯一可计费来源）──────────
      const verified = await this.verifier.verify({ timeoutMs: 10000, sentAtMs })
      result = await this.#settleOutcome({ record, verified, p, sentAtMs })
    } catch (e) {
      // ⚠️ 抛错时**不能**把 outbox 记录判成 failed：错误可能发生在
      //    "已经按了 Enter、读结果时出错"之后，那笔其实成功了。
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
   * 判定收敛：平台响应 → 是否需要补 DOM 判据 → 写回 outbox。
   *
   * ⚠️ 这里刻意**不重试、不重发**。抓不到响应时唯一的补救是看一眼 DOM，
   *    而那只能产出 `sent_confirmed_dom`（默认不计费）。
   *    重按一次 Enter 可能真的发出第二条评论——重复回复是最容易被
   *    平台识别为机器人的行为，代价远大于"少算一条"。
   */
  async #settleOutcome({ record, verified, p, sentAtMs }) {
    if (verified.verdict !== 'sent_suspected') {
      return this.outbox.settle(record.send_id, verified)
    }

    const dom = await this.page
      .waitForReplyStable({ bodyKey: p.bodyKey, userKey: p.userKey, stableMs: 3000, pollMs: 1000 })
      .catch((e) => {
        this.#log('warn', 'dom_stability_check_failed', { message: e && e.message })
        return { stable: false, stableMs: 0 }
      })

    if (dom.stable) {
      const domEvidence = this.verifier.constructor
        .domConfirmed({ stableMs: dom.stableMs, sentAtMs }).evidence
      return this.outbox.settle(record.send_id, {
        verdict: 'sent_confirmed_dom',
        is_final: true,
        evidence: domEvidence,
        failure_reason: null,
      })
    }

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
   * 在页面上按正文哈希找回目标评论的正文。
   *
   * ⚠️ 这是"队列不存原文"这个决定的代价，也是它的实现：
   *    扫描 → 本地算哈希 → 命中即锁定。
   *
   * @returns {Promise<{text:string, index:number}|null>}
   */
  async #locateInPage(p, salt) {
    // ⚠️ 扫描失败**不能**静默返回 null —— 那会让"页面没加载出来"与
    //    "评论真的不在了"混为一谈，而两者的处置完全不同
    //    （前者应重排队，后者应跳过）。
    const items = await this.page.scan({ limit: LOCATE_SCAN_LIMIT })

    // 优先按平台 commentId 判别（同一句话被多人复读时哈希会撞在一起）
    if (p.commentId) {
      for (const it of items) {
        if (it.commentId && String(it.commentId) === String(p.commentId)) {
          return { text: it.text, index: it.index }
        }
      }
    }
    for (const it of items) {
      if (contentHash(it.text, salt) === p.bodyKeyHash) {
        return { text: it.text, index: it.index }
      }
    }
    this.#log('info', 'locate_by_hash_miss', {
      scanned: items.length,
      // ⚠️ 只记展示截断，不记任何正文（红线 3）
      prefix: p.bodyKeyPrefix || null,
    })
    return null
  }

  /** 按规则挑模板并渲染。 */
  #renderFor(p) {
    const rules = Array.isArray(p.rules) ? p.rules : []
    if (!rules.length) return null

    // ⚠️ 评论侧用 **strict: true**。宽松匹配会给不相关的人发回复，
    //    而"答非所问"最容易招致举报（见 keyword-match.js 的说明）。
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
   * ⚠️ 阈值来自**策略**（`content_similarity_max`，评论 0.85），
   *    取的是护栏的**实际生效值**（商家可以调更低）。
   * ⚠️ 方向：相似度**超过**阈值即拒绝（AGENTS.md §2.4）。
   */
  #checkSimilarity(text) {
    if (!this.similarity) return { allow: true, similarity: 0, threshold: null }
    const limits = this.guard ? this.guard.effectiveLimits('comment') : null
    const raw = limits ? limits.content_similarity_max : undefined
    if (raw === undefined || raw === null) {
      // ⚠️ 没有阈值就不做相似度判定，但要留痕——静默跳过会让
      //    "为什么这条没被拦"无从回答。
      this.#log('warn', 'similarity_threshold_missing', { source_type: 'comment' })
      return { allow: true, similarity: 0, threshold: null }
    }
    return this.similarity.checkContent(text, {
      recentTexts: this.recentTexts,
      threshold: Number(raw),
    })
  }
}

module.exports = {
  ReplyCommentAdapter,
  ENDPOINT,
  LOCATE_SCAN_LIMIT,
}
