'use strict'

// client/adapters/collect.js
//
// 采集 + 关键词命中 + 去重键计算 —— 三条链路的共同入口。
//
// ⚠️ 本文件的责任边界很容易被越界，所以说清楚：
//
//   ✅ 它做：读页面 → 按关键词筛 → 算隐私哈希与去重键 → 入队
//   ❌ 它不做：不判断"能不能发"（那是 `safety/guard.js`）、
//             不做频率控制（那是 `safety/timing.js` 与调度器）、
//             不碰 CDP（那是 `core/browser-host.js`）
//
// ⚠️ 观察期（`sending_enabled === false`）下采集**必须照常进行**。
//    这一点写在契约 §4.6 与 §9.1 里：观察期"只采集线索，不发送任何内容"。
//    所以本文件**不检查**发送开关——检查它是调度器的职责。
//    如果这里也判一次，就会出现"观察期连线索都不采集"的缺陷，
//    而商家买这个工具的第一诉求恰恰是"看看能截多少流"（原始需求 4）。
//
// ⚠️ 去重键的构成决定 `hits` 计数是否正确（契约 §7.1 / 计划 §4.9 第 4 条），
//    规则是**宁可少算不可多算**：
//      · 评论：`(account_id, 'comment', video_id, comment_id)`；
//        `comment_id` 缺失时**不计入 hits**（因为无法保证不重复回复）。
//      · 弹幕：优先 `(account_id, 'live', room_id, msg_id)`；
//        没有稳定 `msg_id` 时退化为 `(..., room_id, user_key_hash, content_hash)`
//        且 5 分钟窗内只计一次。
//      · 私信：`(account_id, 'dm', conversation_id, msg_id)`。

const { userKeyHash, contentHash, targetHash } = require('../license/privacy')
const { matchRules } = require('./keyword-match')

/** 弹幕无稳定 msg_id 时的退化去重窗口（契约 §7.1 的 5 分钟） */
const DANMAKU_FALLBACK_WINDOW_MS = 5 * 60 * 1000

// ⚠️⚠️ **队列条目的 payload 里不得出现任何正文原文或有身份的标识**（红线 3）。
//    这一点当初写错过，代价很大，所以写清楚：
//
//      错法：把评论文本放进 `payload.bodyKey` 供页面定位，把 `secUid` 放进
//            `payload.secUid` 供私信定位。看起来合理——适配器确实需要它们。
//            但 `queue.json` 是**长期留在盘上**的，于是商家机器上就躺着
//            一份完整的评论原文副本和 `sec_uid` 原文。红线 3 的第一句是
//            "绝不上传"，第二层意思是"不留存"。
//
//      正法：payload 只存**哈希 + 平台 ID + 显示截断**：
//              · `targetHash` / `userKeyHash` —— 隐私哈希
//              · `videoId` / `commentId` / `roomId` / `msgId` —— 平台 ID，
//                它们标识"位置"而不是"人"，本来就在 URL 里
//              · `bodyKeyHash` —— 正文哈希，**用于从页面重新读回正文**
//              · `bodyKeyPrefix` —— 正文前 N 字的展示截断
//                （界面上要显示"准备回复：这个商品多少钱…"，
//                 否则运营看到的是 64 位十六进制，根本没法用）
//
//            定位因此变成两步：入队时算哈希 → 出队时扫页面、对每条评论
//            算同样的哈希、命中即锁定。多一次页面扫描，换来盘上永远没有原文。
//            这个交换划算：扫描是本地操作，原文落盘是不可逆的。
//
// ⚠️ `bodyKeyPrefix` 是刻意保留的**唯一一处明文**，长度上限 12 字符。
//    它是产品功能（运营要看得懂）与隐私边界之间显式的妥协，不是疏漏。

/** 展示用正文前缀的最大长度。⚠️ 不要调大——它是隐私边界上的显式妥协。 */
const DISPLAY_PREFIX_LEN = 12

class Collector {
  /**
   * @param {object} opts
   * @param {object} opts.quote        Queue（`client/host/queue.js`）
   * @param {object} opts.state        LicenseState（取 privacy_salt 与 accountId）
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    if (!opts || !opts.queue || !opts.state) throw new Error('Collector 需要 queue 与 state')
    this.queue = opts.queue
    this.state = opts.state
    this.logger = opts.logger || null
    this.now = opts.now || (() => Date.now())

    /**
     * 弹幕退化去重用的近期缓存：`key → lastCountedAtMs`
     * ⚠️ 只在进程内有效。跨重启的重复由 `queue.add` 的 dedupKey 兜底。
     */
    this.recentDanmaku = new Map()
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  #salt() {
    const s = this.state.privacySalt
    if (!s) {
      // 没有盐就无法生成隐私哈希（红线 3）。采集可以继续做关键词匹配，
      // 但**不能入队**——因为入队就要落盘，而落盘的内容必须是哈希。
      throw new Error(
        '缺少 privacy_salt，无法生成隐私哈希。请先完成登录再采集' +
        '（不进行降级：无盐哈希等于把原文换个写法存下来）。'
      )
    }
    return s
  }

  // ══════════════════════════════════════════════════════════
  // 评论
  // ══════════════════════════════════════════════════════════

  /**
   * 处理一批扫描到的评论。
   *
   * @param {object} p
   * @param {string} p.videoId
   * @param {string} p.videoUrl
   * @param {Array<{index:number,text:string,user:string,replyable:boolean}>} p.items
   * @param {Array<{id,keyword,templates}>} p.rules
   * @param {(sourceType:string, opts:object) => void} [p.onHit] 命中回调（用于统计）
   * @returns {{scanned:number, hits:number, enqueued:number, skipped:number, reasons:object}}
   */
  async collectComments(p) {
    const salt = this.#salt()
    const rules = Array.isArray(p.rules) ? p.rules : []
    const out = { scanned: 0, hits: 0, enqueued: 0, skipped: 0, reasons: {} }

    for (const item of p.items || []) {
      out.scanned += 1
      const text = String(item.text || '')
      if (!text) continue

      // ⚠️ 评论侧用 **strict: true**。宽松匹配会给不相关的人发回复，
      //    而"答非所问"最容易招致举报（见 keyword-match.js 的说明）。
      const hit = matchRules(text, rules, { strict: true })
      if (!hit) {
        bump(out.reasons, 'no_keyword_match')
        continue
      }
      out.hits += 1
      if (typeof p.onHit === 'function') p.onHit('comment', { isNewLead: true })

      // 不可回复（没有「回复」按钮的评论，例如已删除、或平台折叠）
      if (item.replyable === false) {
        out.skipped += 1
        bump(out.reasons, 'not_replyable')
        continue
      }

      // ⚠️ comment_id 缺失 → **不计入 hits 的去重链路**，直接跳过。
      //    理由：没有稳定 ID 就无法保证"同一条评论不被回复两次"，
      //    而重复回复是最容易被平台识别为机器人的行为。
      //    契约 §7.1 的原话是"宁可少算不可多算"。
      const commentId = item.commentId || item.id || null
      if (!commentId) {
        out.skipped += 1
        bump(out.reasons, 'comment_id_missing')
        this.#log('warn', 'collect_comment_id_missing', {
          video_id: p.videoId,
          hint: '没有稳定 comment_id 就无法保证不重复回复，已跳过',
        })
        continue
      }

      const targetHashValue = targetHash(`${p.videoId}|${commentId}`, salt)
      const userHash = item.secUid ? userKeyHash(item.secUid, salt) : null
      const bodyKeyHash = contentHash(text, salt)

      const res = this.queue.add({
        kind: 'reply_comment',
        sourceType: 'comment',
        // 去重键用 target_hash：同一条评论永远只入队一次
        dedupKey: `comment:${targetHashValue}`,
        payload: {
          videoId: p.videoId,
          videoUrl: p.videoUrl,
          commentId,
          // ⚠️ 只存哈希与展示截断，**不存正文**（见文件头说明）。
          //    适配器会拿 bodyKeyHash 去页面上重新定位那条评论。
          bodyKeyHash,
          bodyKeyPrefix: displayPrefix(text),
          userKey: displayPrefix(item.user || '', 16),
          targetHash: targetHashValue,
          userKeyHash: userHash,
          ruleId: hit.rule.id,
          keyword: hit.rule.keyword,
        },
      })

      if (res.added) {
        out.enqueued += 1
        this.queue.addLead({ userKeyHash: userHash, sourceType: 'comment' })
      } else {
        out.skipped += 1
        bump(out.reasons, res.reason || 'duplicate')
      }
    }

    return out
  }

  // ══════════════════════════════════════════════════════════
  // 弹幕
  // ══════════════════════════════════════════════════════════

  /**
   * 处理一批直播弹幕。
   *
   * @param {object} p
   * @param {string} p.roomId
   * @param {string} p.roomUrl
   * @param {Array<{rowKey,user,text,userId,rect}>} p.rows
   * @param {Array} p.rules
   * @param {(sourceType:string, opts:object) => void} [p.onHit]
   */
  async collectDanmaku(p) {
    const salt = this.#salt()
    const rules = Array.isArray(p.rules) ? p.rules : []
    const now = this.now()
    const out = { scanned: 0, hits: 0, enqueued: 0, skipped: 0, reasons: {} }

    for (const row of p.rows || []) {
      out.scanned += 1
      const text = String(row.text || '')
      if (!text) continue

      const hit = matchRules(text, rules, { strict: true })
      if (!hit) {
        bump(out.reasons, 'no_keyword_match')
        continue
      }
      out.hits += 1
      if (typeof p.onHit === 'function') p.onHit('live_danmaku', { isNewLead: true })

      const msgId = row.msgId || null
      const userHash = row.secUid
        ? userKeyHash(row.secUid, salt)
        : (row.user ? userKeyHash(`nick:${row.user}`, salt) : null)
      const cHash = contentHash(text, salt)

      let dedupKey
      if (msgId) {
        // 稳定 msg_id → 最可靠
        dedupKey = `danmaku:${targetHash(`${p.roomId}|${msgId}`, salt)}`
      } else {
        // ⚠️ 退化为"房间 + 用户 + 内容"，并在 5 分钟窗内只计一次。
        //    不加窗口的话，"同一个用户重复刷同一句话"会被当成新弹幕，
        //    于是被回复多次——而刷屏的恰恰就是这类内容。
        const fallback = `${p.roomId}|${userHash || 'anon'}|${cHash}`
        const last = this.recentDanmaku.get(fallback)
        if (last !== undefined && now - last < DANMAKU_FALLBACK_WINDOW_MS) {
          out.skipped += 1
          bump(out.reasons, 'danmaku_within_dedupe_window')
          continue
        }
        this.recentDanmaku.set(fallback, now)
        pruneMap(this.recentDanmaku, now - DANMAKU_FALLBACK_WINDOW_MS)
        dedupKey = `danmaku:${targetHash(fallback, salt)}`
      }

      const res = this.queue.add({
        kind: 'reply_danmaku',
        sourceType: 'live_danmaku',
        dedupKey,
        payload: {
          roomId: p.roomId,
          roomUrl: p.roomUrl,
          msgId: msgId || null,
          rowKey: row.rowKey || null,
          // ⚠️ 同样只存哈希与展示截断（见文件头的红线说明）
          bodyKeyHash: cHash,
          bodyKeyPrefix: displayPrefix(text),
          userKey: displayPrefix(row.user || '', 16),
          targetHash: targetHash(`${p.roomId}|${msgId || row.rowKey || cHash}`, salt),
          userKeyHash: userHash,
          ruleId: hit.rule.id,
          keyword: hit.rule.keyword,
          rect: row.rect || null,
        },
      })

      if (res.added) {
        out.enqueued += 1
        this.queue.addLead({ userKeyHash: userHash, sourceType: 'live_danmaku' })
      } else {
        out.skipped += 1
        bump(out.reasons, res.reason || 'duplicate')
      }
    }

    return out
  }

  // ══════════════════════════════════════════════════════════
  // 线索（不回复，只沉淀）
  // ══════════════════════════════════════════════════════════

  /**
   * 只记线索、不入回复队列。
   *
   * ⚠️ 观察期（`sending_enabled === false`）就该走这条路径：
   *    契约 §4.6 要求观察期"不生成任何 send_id"，但**线索照常采集**。
   *    这也是原始需求 4「后台可以看见商家截了多少流」的数据来源。
   *
   * @returns {{hits:number, newLeads:number}}
   */
  leadsOnly({ sourceType, items, rules, onHit }) {
    const salt = this.#salt()
    let hits = 0
    let newLeads = 0
    for (const it of items || []) {
      const text = String((it && (it.text || it.bodyKey)) || '')
      if (!text) continue
      const hit = matchRules(text, rules || [], { strict: true })
      if (!hit) continue
      hits += 1
      if (typeof onHit === 'function') onHit(sourceType, { isNewLead: true })
      const uh = it.secUid ? userKeyHash(it.secUid, salt) : null
      if (uh && this.queue.addLead({ userKeyHash: uh, sourceType }).added) newLeads += 1
    }
    return { hits, newLeads }
  }
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1
}

/**
 * 展示用截断。
 *
 * ⚠️ 这是本项目里**唯一**允许把页面文本的片段写进本地文件的地方，
 *    所以刻意做成一个小函数并限制长度——集中一处才好审计，
 *    散落各处的 `slice(0, N)` 迟早有人写成 `slice(0, 500)`。
 *
 * 默认 12 个字符：够运营认出"这条是问价格的"，又不足以还原整句话。
 */
function displayPrefix(text, limit = DISPLAY_PREFIX_LEN) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function pruneMap(map, cutoffMs) {
  for (const [k, v] of map) {
    if (v < cutoffMs) map.delete(k)
  }
}

module.exports = {
  Collector,
  DANMAKU_FALLBACK_WINDOW_MS,
  DISPLAY_PREFIX_LEN,
  displayPrefix,
  pruneMap,
}
