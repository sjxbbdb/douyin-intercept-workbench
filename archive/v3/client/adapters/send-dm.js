'use strict'

// client/adapters/send-dm.js
//
// 私信发送的**薄编排层**。三条链路里它多两步"找人"的动作，
// 也因此多两类特有的危险：
//
// ⚠️ **危险一：猜错目标 = 给陌生人发私信。**
//    评论与弹幕的目标是"平台 ID 指向的那条内容"，位置是确定的；
//    私信的目标是**人**，而我们手上只有源页面上的一条正文（`anchorText`）。
//    从正文找到人的路径（`/user/<sec_uid>`）可能取不到——此时
//    `ProfilePage.resolveUserPath` 返回 `found: false`，本文件**必须**
//    判 `{ outcome: 'skipped', reason: 'not_locatable' }` 并停下。
//
//    ⚠️ **绝不猜**。猜错的后果不是"发错一条回复"这种可道歉的小事：
//       它既是**骚扰真人**，也是账号被判定为营销号**最可靠的途径**——
//       给毫无关联的人发私信，是被举报率最高、平台最敏感的行为。
//       一条没发出去的私信只是少一单；一条发错人的私信可能毁掉这个号。
//
// ⚠️ **危险二：`sec_uid` 是红线 3 最容易被违反的地方。**
//    私信必须知道"发给谁"，而"谁"在抖音里就是 `sec_uid`（legacy 直接把它
//    写进了本地 JSON）。本文件的处理是：
//      · `sec_uid` 只是本地常量 `secUid`，**用完即弃**——不落盘、不进日志、
//        不进 evidence、不进返回值；
//      · 落盘与上报一律用 `privacy.userKeyHash(secUid, salt)`（红线 3）。
//    源码扫描测试会扫 `sec_uid` 明文是否出现在盘上的文件里。
//
// ⚠️ 与评论/弹幕链路的**第三处不同：相似度阈值**。
//    私信是 0.75（比评论/弹幕的 0.85 更严格，因为私信是"一对一的打扰"）。
//    ⚠️ 本文件**不得出现任何字面阈值**，一律从
//       `guard.effectiveLimits('dm').content_similarity_max` 读——
//       商家还能在此基础上调得更低（红线 1：客户端只能更保守）。
//       `similarity.checkContent` 在阈值缺失时会抛错（fail-closed），
//       本文件把它翻成一个说得清原因的 CONFIG_INVALID。
//
// ⚠️ 与另两条链路**刻意相同**的两处顺序，同样错了就产生无法复现的缺陷：
//      · **先落盘 send_id，再发送**（AGENTS.md §2.7）
//      · **先开始响应捕获，再提交**（`publish-verifier.beginCapture`）
//        DM 与弹幕一样没有可靠的 DOM 回读（发出的私信会进入别人的会话，
//        商家自己的页面上看不到"对方收到了没有"），所以成功判定
//        只能来自 `im/send` 的响应体。
//
// ⚠️ 本文件**不做**私信的**独立日上限**判定（契约 §4.6 的
//    `new_conversation_daily_max` 是私信专有的"新会话"计数）。
//    为什么不做：准入控制是 `Guard.canSend` 与调度器的职责，
//    适配器里出现任何限额比较都是分层错误——而且"这条该不该发"必须在
//    **取任务之前**回答，放到这里已经太晚了（任务已经被取出、被计入 attempts）。
//    ⚠️ 所以本文件里**没有任何**上限/间隔/阈值的字面数字比较。

const { WorkbenchError, toWorkbenchError } = require('../core/workbench-error')
const { userKeyHash, targetHash, contentHash } = require('../license/privacy')
const { extractSecUidFromPath } = require('../platform/page-profile')
const { matchRules } = require('./keyword-match')
const { renderReply, validateTemplates } = require('./reply-renderer')
const timing = require('../safety/timing')

/** 私信发送的平台接口（闭集白名单里的值，契约 §4.8） */
const ENDPOINT = 'im/send'

/** 定位时扫描的源页面条目数上限 */
const LOCATE_SCAN_LIMIT = 200

class SendDmAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.profilePage ProfilePage
   * @param {object} opts.commentPage CommentPage（源页面是评论区时用）
   * @param {object} opts.livePage    LivePage（源页面是直播间时用）
   * @param {object} opts.verifier    PublishVerifier
   * @param {object} opts.outbox      SendOutbox
   * @param {object} opts.state       LicenseState（取 privacy_salt 与策略版本）
   * @param {object} [opts.similarity] client/safety/similarity.js
   * @param {object} [opts.guard]     只读，用于取**实际生效**的阈值
   * @param {object} [opts.logger]
   * @param {() => number} [opts.rng]
   */
  constructor(opts) {
    if (!opts || !opts.profilePage || !opts.verifier || !opts.outbox || !opts.state) {
      throw new Error('SendDmAdapter 需要 profilePage / verifier / outbox / state')
    }
    this.profilePage = opts.profilePage
    this.commentPage = opts.commentPage || null
    this.livePage = opts.livePage || null
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

  /** 取 privacy_salt（口径与另两条链路一致：无盐不降级，宁可不发）。 */
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
   * 执行一次私信发送。
   *
   * @param {object} task
   * @param {string} task.payload.sourceUrl     源页面 URL（评论页或直播间）
   * @param {string} [task.payload.sourceType]  源渠道（`live_danmaku` 表示源是直播间）
   * @param {string} task.payload.bodyKeyHash   源正文哈希（**定位锚点**，不是原文）
   * @param {string} [task.payload.bodyKeyPrefix] 正文展示截断（日志用）
   * @param {string} [task.payload.userKey]     昵称展示截断（提高定位精度）
   * @param {string} [task.payload.userKeyHash] 用户哈希（**仅当采集阶段拿得到 secUid 才有**）
   * @param {string} [task.payload.conversationId] 会话 ID（页面能给出时优先用它做 target_hash）
   * @param {Array}  task.payload.rules         规则列表 `[{id, keyword, templates}]`
   */
  async run(task) {
    const p = (task && task.payload) || {}
    if (!p.sourceUrl || !p.bodyKeyHash) {
      throw new WorkbenchError('NOT_LOCATABLE',
        '任务缺少 sourceUrl 或 bodyKeyHash，无法定位私信目标',
        { has_url: Boolean(p.sourceUrl), has_hash: Boolean(p.bodyKeyHash) })
    }

    const salt = this.#salt()

    // ── ① 回到源页面，把正文读回来（它**只**活在内存里）───────
    // ⚠️ `anchorText` 是明文，而它能拿到**仅仅因为源页面还留着那条内容**。
    //    这正是"队列不存原文"这个决定的完整闭环：
    //      入队只存哈希 → 出队时回页面按哈希找回明文 → 用完即弃。
    //    ⚠️ 任何人都不要"顺手"把 anchorText 塞进 payload 让它省一步扫描：
    //       `queue.json` 是长期留盘的，那等于在商家机器上留一份原文副本。
    const role = this.#sourceRole(task)
    const anchorText = await this.#locateAnchorText(p, salt, role)
    if (!anchorText) {
      // ⚠️ 源内容不在了（评论被删、弹幕滚走、视频被下架）。
      //    判 `skipped`：重试一万次也找不回来，不该计入熔断。
      this.#log('info', 'dm_source_anchor_not_found', {
        role,
        // ⚠️ 只记展示截断，不记任何正文（红线 3）
        prefix: p.bodyKeyPrefix || null,
      })
      return { outcome: 'skipped', reason: 'not_locatable' }
    }
    // ⚠️ `anchorText` 是明文，也是本文件**唯一**会持有明文的地方。
    //    它只活在本次调用的内存里：既回写进内存里的 `p`（供规则匹配用），
    //    也不随任何返回值/日志/落盘出去。
    p.anchorText = anchorText

    // ── ② 从源页面解析出目标用户的资料路径 ───────────────────
    // ⚠️ 这一步只拿"跳转目标"，不新开标签页（见 page-profile 文件头）。
    const resolved = await this.profilePage.resolveUserPath({
      role,
      anchorText,
      userName: p.userKey || null,
    })
    if (!resolved || !resolved.found || !resolved.profilePath) {
      // ⚠️⚠️ 取不到就是取不到，**绝不猜**（见文件头"危险一"）。
      //      页面上没有指向某个 `/user/<sec_uid>` 的链接，就意味着我们
      //      无法证明"那条评论/弹幕是这个人的"。
      //      此时唯一的正确动作是停下——猜一个目标就是给陌生人发私信，
      //      那是骚扰，也是账号被判定为营销号最可靠的途径。
      this.#log('info', 'dm_target_not_locatable', {
        // ⚠️ 不记 profilePath（它含 sec_uid），只记原因
        reason: (resolved && resolved.reason) || 'null',
        hint: '绝不猜目标：猜错 = 给陌生人发私信 = 骚扰 + 账号风险',
      })
      return { outcome: 'skipped', reason: 'not_locatable' }
    }
    const profilePath = resolved.profilePath

    // ── ③ 打开与该用户的私信会话 ─────────────────────────────
    // ⚠️ 私信页用**新标签页**（计划 §4.6 第 4 条）：长期复用的页面会退化，
    //    而且私信页与评论页共用标签会互相导航，出现"评论发到私信页"这类错乱。
    // ⚠️ 这一步抛错（登录态失效 / 用户不存在 / 输入框没出现）时，
    //    我们**还没有** outbox 记录，所以让它直接上抛由调度器判重排队——
    //    不能吞成一个 skipped，那会把"登录态失效"变成静默的"找不到人"。
    const opened = await this.profilePage.openConversation(profilePath)

    // ── ④ 渲染文案（命中规则才有得发）────────────────────────
    const rendered = this.#renderFor(p)
    if (!rendered) return { outcome: 'skipped', reason: 'no_rule_matched' }

    // ── ⑤ 相似度护栏（发送之前，阈值 0.75 来自 policy）──────
    const sim = this.#checkSimilarity(rendered.text)
    if (!sim.allow) {
      // ⚠️ 与评论/弹幕链路同形：`failed` + `content_rejected`（契约 §7.4）。
      //    不是 skipped——skipped 是"命中但按策略不回复"，
      //    这里是"本该回复、但内容不合格被护栏拦下"。
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

    // ── ⑥ 聚焦私信输入框 ──────────────────────────────────────
    // ⚠️ `ProfilePage.focusInput()` 已经排除了搜索框。这不是洁癖：
    //    私信页打开后会异步把焦点抢到搜索框之类的地方，不检查就输入，
    //    文字会进到**搜索框**里，而搜索框按 Enter 会**跳转页面**——
    //    表现是"发完私信页面就变了"，且那条私信从未发出。
    //
    // ⚠️⚠️ 这一步刻意放在 `outbox.begin` **之前**，与另两条链路不同。
    //      理由：聚焦失败发生在**任何平台动作之前**，我们确切地知道
    //      "什么都没发出去"。此时最干净的处置是**根本不留下 outbox 记录**：
    //        · 留下记录 → 恢复流程只能读到一条 unknown，判 sent_suspected
    //          上报 → 服务端多出一条"疑似已发送"，虚高且无法解释；
    //        · 不留记录 → 抛可重试的 ELEMENT_TIMEOUT，调度器重新排队，
    //          重试成功后再老老实实生成 send_id。
    //      "先落盘"保护的场景是"发送动作可能已经发生"，而这里还没有发生。
    //      判据很简单：**触碰 outbox 之前不做任何平台写操作，
    //      触碰之后就不许再"干净地失败"**。
    const focused = await this.profilePage.focusInput()
    if (!focused || focused.ok !== true) {
      throw new WorkbenchError('ELEMENT_TIMEOUT',
        '未能聚焦私信输入框，已放弃本次发送（文字可能进到搜索框）',
        { selector: 'inlineEditor', reason: focused ? focused.reason : 'null' })
    }

    // ── ⑦ 生成 send_id 并**先落盘**────────────────────────────
    // ⚠️ 落盘之后紧接着就是捕获与提交，中间不再插入可能长失败的步骤。
    // ⚠️ `target_hash` 的口径：契约 §4.8 写的是
    //    `hmac(salt, conversation_id)`。页面能给出 `conversationId` 时用它；
    //    给不出时退到 **profilePath**，理由：
    //      · `/user/<sec_uid>` 是页面暴露出来的、与该用户会话**一一对应**的
    //        稳定身份——同一个人的会话永远是同一个路径；
    //      · 它虽是明文形态，但这里只作为**哈希输入**，落盘的是 hmac，
    //        与 `userKeyHash(secUid)` 同一条红线口径（哈希可落盘，原文不落盘）；
    //      · 绝不能退到"昵称"或"第几条"这类会漂移的东西——那会让同一个
    //        会话在不同任务里得到不同的 target_hash，服务端无法按目标聚合，
    //        去重与 attempt_seq 一起失真。
    //    ⚠️ 与弹幕/评论不同，这里**不能**复用 payload 里预先算好的
    //       `targetHash`：采集阶段还没有"会话"这个概念，那时算出来的是
    //       评论/弹幕的 target_hash，不是一个东西。
    const conversationId = p.conversationId
      || (opened && opened.conversationId)
      || null
    const tHash = targetHash(conversationId || profilePath, salt)

    // ⚠️ `secUid` 的生命周期**只有这四行**：提取 → 哈希 → 丢弃。
    //    不写日志、不进 detail、不进返回值、不落盘（红线 3）。
    const secUid = extractSecUidFromPath(profilePath)
    const uHash = secUid ? userKeyHash(secUid, salt) : (p.userKeyHash || null)

    const record = this.outbox.begin({
      sourceType: 'dm',
      targetHash: tHash,
      userKeyHash: uHash,
      userKeyType: uHash ? 'sec_uid' : null,
      contentHash: contentHash(rendered.text, salt),
      applied_policy_version: this.state.policyVersion,
      instance_id: this.state.instanceIdValue,
    })
    const sentAtMs = record.sent_at_ms

    let result = null
    try {
      // ── ⑧ 开始捕获响应（**必须在提交之前**）──────────────
      await this.verifier.beginCapture('profile', ENDPOINT)

      // ── ⑨ 输入文案（真人化：分块 + 随机停顿 + 回读校验）──
      const plan = timing.typingPlan(rendered.text, { rng: this.rng })
      await this.profilePage.typeIntoInput(rendered.text, { plan })

      // ── ⑩ 提交（**按钮为主路径，Enter 为兜底** —— 与评论区相反）──
      // ⚠️ 顺序反了的理由见 `ProfilePage.submitMessage` 的注释：
      //    私信的 Enter 在部分版本里只插入换行，旧代码因此把"没发出去"
      //    记成了"发出去了"。两条路径后面都必须有响应捕获。
      await this.profilePage.submitMessage()

      // ── ⑪ 用**平台响应体**判定（唯一可计费来源）──────────
      const verified = await this.verifier.verify({ timeoutMs: 10000, sentAtMs })
      result = await this.#settleOutcome({ record, verified })
    } catch (e) {
      // ⚠️ 抛错时**不能**把 outbox 记录判成 failed：错误可能发生在
      //    "已经点了发送、读结果时出错"之后，那条私信其实已经发出去了。
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
   * ⚠️ 与评论区不同，这里**不补 DOM 判据**：私信发出去之后进入的是
   *    **对方**的会话列表，商家自己的页面上没有任何"我发成功了吗"的证据。
   *    抓不到响应就是 `sent_suspected`（`is_final: false`）——保留升级空间，
   *    但不假装确认过（红线 2：只有平台响应体算成功）。
   *
   * ⚠️ 也刻意**不重试、不重发**。私信重发就是给对方连发两条（骚扰），
   *    而且是平台最容易识别为营销号的行为。
   */
  async #settleOutcome({ record, verified }) {
    return this.outbox.settle(record.send_id, verified)
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
   * 源页面角色：私信的目标可能来自评论区，也可能来自直播间。
   *
   * ⚠️ 角色名要与 `BrowserHost.ensureTab` 用过的角色一致，否则
   *    `evaluate(role, …)` 会打在**另一个标签页**上——表现是"表达式明明
   *    没错，却什么也找不到"，而这类问题极易被误判成平台改版。
   */
  #sourceRole(task) {
    const st = (task && task.sourceType) || null
    const spt = (task && task.payload && task.payload.sourceType) || null
    return (st === 'live_danmaku' || spt === 'live_danmaku') ? 'live' : 'comment'
  }

  /**
   * 回到源页面，按正文哈希把目标正文读回来。
   *
   * ⚠️ 这是"队列不存原文"的代价，也是它的实现：扫描 → 本地算哈希 → 命中即锁定。
   * ⚠️ 两个源页面模型返回的行结构不同（评论区 `scan()` 的 `commentId` 对应
   *    采集时的 `payload.commentId`；直播间 `collect()` 的 `rowKey` 对应
   *    `payload.rowKey`/`msgId`），所以这里对"稳定 ID"的比法是**取并集**：
   *    哪个字段在、就跟哪个比。宁可多比一次，也不要因为字段名不同而漏掉
   *    一条本该能定位的评论。
   *
   * @returns {Promise<string|null>} 目标正文（**只在内存里**）
   */
  async #locateAnchorText(p, salt, role) {
    const page = this.#sourcePage(role)

    // ⚠️ 源页面要先打开。`CommentPage.open` / `LivePage.open` 都会把该角色
    //    的标签页导航到源 URL —— 这也是为什么本文件不像另两条链路那样
    //    需要一个额外的"打开"步骤：导航就发生在定位这一步里。
    await page.open(p.sourceUrl)

    const items = (role === 'live')
      ? await page.collect({ limit: LOCATE_SCAN_LIMIT })
      : await page.scan({ limit: LOCATE_SCAN_LIMIT })

    const stableIds = [p.commentId, p.msgId, p.rowKey].filter(Boolean).map(String)
    const idFields = role === 'live' ? ['rowKey'] : ['commentId', 'id']

    if (stableIds.length) {
      for (const it of items) {
        for (const f of idFields) {
          const v = it && it[f]
          if (v && stableIds.includes(String(v))) return String(it.text || '') || null
        }
      }
    }

    for (const it of items) {
      const text = it && it.text
      if (!text) continue
      if (contentHash(text, salt) !== p.bodyKeyHash) continue
      // 昵称展示截断只用于提高精度，不做硬性要求（采集时可能没取到昵称）
      if (p.userKey && it.user && !String(it.user).startsWith(String(p.userKey))) continue
      return String(text)
    }

    this.#log('info', 'locate_by_hash_miss', {
      role,
      scanned: items.length,
      prefix: p.bodyKeyPrefix || null,
    })
    return null
  }

  /** 取源页面模型。⚠️ 缺失时给出可行动的报错，而不是 `undefined.open`。 */
  #sourcePage(role) {
    const page = role === 'live' ? this.livePage : this.commentPage
    if (!page) {
      throw new WorkbenchError('INTERNAL',
        `私信源页面模型缺失（role=${role}），无法定位目标。装配时必须同时提供 commentPage 与 livePage。`,
        { role })
    }
    return page
  }

  /** 按规则挑模板并渲染。 */
  #renderFor(p) {
    const rules = Array.isArray(p.rules) ? p.rules : []
    if (!rules.length) return null

    // ⚠️ 私信侧同样用 **strict: true**。私信是"一对一打扰"，
    //    误发的代价（骚扰 + 举报）比评论区高一个量级，宁可漏掉也不误发。
    const hit = matchRules(p.anchorText, rules, { strict: true })
    if (!hit) return null

    // ⚠️ 模板池校验放在渲染处兜底：规则可能被绕过界面直接改文件，
    //    而"少于 5 条变体"会让相似度护栏频繁拒绝（私信阈值更低，更容易被拒）。
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
   * ⚠️ 私信的阈值是 **0.75**（比评论/弹幕的 0.85 更严格），
   *    但**必须**从 `guard.effectiveLimits('dm')` 读，不得写死——
   *    服务端可以按等级调整，商家还可以在此基础上调得更低（红线 1）。
   * ⚠️ 方向：相似度**超过**阈值即拒绝（AGENTS.md §2.4）。
   */
  #checkSimilarity(text) {
    if (!this.similarity) return { allow: true, similarity: 0, threshold: null }
    const limits = this.guard ? this.guard.effectiveLimits('dm') : null
    const raw = limits ? limits.content_similarity_max : undefined
    if (raw === undefined || raw === null) {
      // ⚠️⚠️ 与评论链路不同，这里**不能**"没有阈值就放行"。
      //      私信护栏的阈值缺失意味着策略没下发下来，而这时的失败方式
      //      必须是**拒绝发送**（fail-closed）：私信发错/发重的代价最高，
      //      而"猜一个默认阈值"等于在客户端硬编码安全限额（红线 1）。
      //      `similarity.checkContent` 本来就要求显式阈值，这里只是把它
      //      翻成一个说得清原因、可归因的错误。
      throw new WorkbenchError('CONFIG_INVALID',
        '策略里没有 dm 的 content_similarity_max，无法评估私信文案相似度，已拒绝发送。'
        + '（不猜默认值：客户端不得硬编码安全阈值）',
        { source_type: 'dm', field: 'content_similarity_max' })
    }
    return this.similarity.checkContent(text, {
      recentTexts: this.recentTexts,
      threshold: Number(raw),
    })
  }
}

module.exports = {
  SendDmAdapter,
  ENDPOINT,
  LOCATE_SCAN_LIMIT,
}
