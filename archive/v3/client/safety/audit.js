'use strict'

// client/safety/audit.js
//
// 本地审计日志 —— **红线 3 的客户端一半**。
//
// ⚠️ 红线 3 的原文要求：审计须含**实际生效的策略版本与生效值**，
//    而不只是用户设置值。原因是纠纷时必须能回答三个问题：
//      ① 该账号当时实际生效的策略是什么？
//      ② 用户是否主动调高过？
//      ③ 系统是否拒绝过？
//    **只记设置值无法自证**——所以 `recordPolicyApplied()` 必须写
//    `guard.effectiveLimits()` 的**结果**，而不是服务端下发的原值，
//    也不是商家的输入值。
//
// ⚠️⚠️ 最容易"顺手写错"、且后果不可挽回的两点：
//
//   1. **绝不记原文**。评论原文、回复文案、弹幕、私信正文、`sec_uid`、
//      Cookie / token / `sign_key` 一律不得落进审计文件——本地文件会被
//      打包发给客服排障、被商家截图、被同步到工单系统。
//      写代码时的小心是靠不住的，所以本模块在**落盘前**统一过一遍
//      `sanitizeForAudit()`，并复用 `client/license/privacy.js` 的
//      `scanForPrivacyLeaks()` 作为禁用键清单（**不复制那份清单**，
//      否则两边迟早漂移）。`strict: true` 时发现禁用键直接抛错。
//
//   2. **`applied:false` + `rejectCode` 必须记下来**。这条是纠纷时的
//      关键证据："用户试图把日上限调高，系统拒绝了"。
//      早期实现只记成功的变更，于是"用户是否主动调高过"永远答不上来。
//      所以 `recordConfigChange()` 在 `applied === false` 时**强制要求**
//      `rejectCode`，缺了直接抛错——宁可报错，也不要静默丢证据。
//
// ⚠️ 写盘一律经 `store`（唯一写者），本模块**不得** require `node:fs`。
// ⚠️ 日志行损坏不能中断整份读取：`store.readLines` 会计数，本模块负责
//    把损坏数暴露出来（`onCorruptLine` 回调 / query 统计），绝不静默跳过。

const {
  scanForPrivacyLeaks, FORBIDDEN_KEYS, STRUCTURAL_KEY_PATHS,
} = require('../license/privacy')
const { AppError } = require('../../shared/lib/errors')
const {
  VERDICTS, CONFIRM_SIGNALS, FAILURE_REASONS, SOURCE_TYPES,
} = require('../../shared/lib/protocol')

/** 审计条目类型（红线 3 要求留痕的类别，缺一不可）。 */
const AUDIT_KINDS = Object.freeze([
  'send_attempt',     // 发送前的尝试（含 send_id，供崩溃后对账）
  'send_result',      // 发送结果（verdict / confirm_signal / platform_status_code）
  'config_change',    // 配置变更（含 applied:false 的拒绝记录）
  'policy_applied',   // 实际生效的策略版本与生效值（红线 3 的核心）
  'circuit',          // 熔断的升级 / 降级 / 解除 / 服务端下发
  'emergency_stop',   // 急停开与关
  'engine_state',     // 引擎启停/暂停/恢复（回答"当时为什么没在发"）
  'login',            // 登录 / 登出 / 令牌刷新
  'security_event',   // 验签失败、隐私拦截、跨端拒绝等
])

/** 配置变更来源（契约 §4.9） */
const CHANGE_SOURCES = Object.freeze(['user', 'server_policy', 'default'])
/** 配置变更行为主体（契约 §4.9） */
const CHANGE_ACTORS = Object.freeze(['local_user', 'license_server', 'system'])

/** 主审计文件与轮转文件名 */
const AUDIT_FILE = 'audit-log.jsonl'
const AUDIT_FILE_ROTATED = 'audit-log.1.jsonl'

/**
 * 轮转阈值（字节）。
 *
 * ⚠️ 这是**存储运维参数**，不是安全限额（不限制发多少条、不决定何时发送）。
 *    按每天几十~几百条审计估算，8 MB 大约覆盖数周到数月，
 *    足够"出纠纷时翻得到"，又不会让单文件大到打不开。
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** 禁用键集合（来自 privacy.js，**不是**本地复制的一份） */
const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS)

/**
 * 结构性路径（同样来自 privacy.js，**不复制**）。
 *
 * ⚠️ 豁免的原因见 privacy.js 的注释：契约 §4.8 的
 *    `policy_snapshot.applied_limits` 形如
 *    `{comment:{daily_max,...}, live_danmaku:{...}, dm:{...}}`——
 *    这里的 `comment` 是**渠道名**，不是评论内容。
 *    按键名一刀切会把每一条"实际生效策略"审计都拦下或脱敏掉，
 *    而那条审计正是红线 3 的核心证据（比漏报更严重）。
 *
 * ⚠️⚠️ 因此审计条目里的字段名**必须是契约原名 `applied_limits`**（蛇形），
 *    不能写成 `appliedLimits`：privacy.js 的豁免表按契约键名登记，
 *    写成驼峰时豁免**不会命中**，渠道名 `comment` 会被脱敏成 `[redacted]`，
 *    于是"实际生效值"这条审计就被悄悄毁了（测试会咬住这一点）。
 *
 * ⚠️ 但豁免**只对"值是普通对象"且**只对"容器的直接子键"**生效**：
 *    · `{comment: "这是一条评论原文"}` 的值是字符串 → 仍然脱敏；
 *    · `{applied_limits:{x:{comment:"正文"}}}` 嵌得更深 → 内层仍然脱敏。
 *    这样既不会误伤结构数据，也堵住了"把正文塞进 comment 键"的绕道。
 */
const STRUCTURAL_SET = new Set(STRUCTURAL_KEY_PATHS)

/** 审计条目里承载"实际生效值"的字段名。⚠️ 必须是契约原名，见上。 */
const APPLIED_LIMITS_KEY = 'applied_limits'

/** 是否是"普通对象"（而非字符串/数组/类实例）。 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * 按 JSONL 序列化后的字节数保留**最近的整条**记录，超出预算的从最旧的开始丢。
 *
 * ⚠️ 必须"按整条"裁：截断到字节数会把最后一行切成半行，
 *    而半行在读取时就是一条损坏行——审计文件自己制造损坏数据。
 *
 * @param {object[]} rows 时间升序的记录
 * @param {number} budgetBytes 预算
 * @returns {object[]} 保留下来的尾部记录（时间仍升序）
 */
function trimToBytes(rows, budgetBytes) {
  const budget = Math.max(0, Number(budgetBytes) || 0)
  const kept = []
  let used = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const size = JSON.stringify(rows[i]).length + 1
    if (used + size > budget && kept.length > 0) break
    used += size
    kept.push(rows[i])
  }
  return kept.reverse()
}

/** 键名本身就必须写的字段：即使与禁用键同名也不做脱敏（见 sanitizeForAudit） */
const REQUIRED_KEYS = new Set([
  'tsMs', 'kind', 'schema', 'source', 'actor', 'applied', 'rejectCode',
  'policyVersion', 'policyHash', 'appliedLimits', 'sendId', 'sourceType',
  'verdict', 'confirmSignal', 'platformStatusCode', 'failureReason',
  'circuitLevel', 'circuitUntilMs', 'circuitReason', 'emergencyStop', 'atMs',
  'contactHash', 'userKeyHash', 'targetHash', 'contentHash', 'orderId', 'ruleId',
])

/**
 * "长得像中文正文"的启发式：**只告警，不抛错**。
 *
 * ⚠️ 为什么要有它：禁用键清单只能拦住"键名对得上"的泄漏。真正的漏法是
 *    把正文塞进一个没被列入清单的键名（例如 `hint`、`evidence.detail`）。
 *    中文是评论/私信正文的强烈特征：Cookie、哈希、状态码里不会出现 CJK。
 *    但**不能**据此拒绝写入——`hint`、`note` 这类字段本来就该是中文，
 *    误拒会让审计缺条目（比多一条告警严重得多）。所以只记 attribution
 *    告警，交由调用方决定是否上报。
 */
const CJK_TEXT_RE = /[\u4e00-\u9fff]/
const TEXT_LIKE_MIN_LEN = 12

/**
 * 深度脱敏：把禁用键的值换掉。
 *
 * ⚠️ 与 `privacy.js` 的差异（刻意的）：那边是"发现即拒绝上报"，
 *    这边是"发现即替换为占位符"——审计文件必须在任何情况下都能写下去，
 *    因为**缺失的审计等于没有审计**。
 *
 * ⚠️ 两个实现细节：
 *    · 命中禁用键后**停在该键上**（不再深入它的值），避免把原文带进
 *      `leakedKeys` 之外的任何地方。
 *    · 用 `WeakSet` 防环：审计对象里出现过 `obj.self = obj` 这类结构，
 *      没有防环会直接爆栈，而爆栈的位置没人会想到是审计模块。
 *
 * @param {any} value
 * @returns {{value:any, redactedKeys:string[], leakedKeys:string[]}}
 *          redactedKeys: 被替换的键路径；leakedKeys: 若强制解析会泄漏的键路径
 */
function sanitizeForAudit(value) {
  const redactedKeys = []
  const leakedKeys = []
  const seen = new WeakSet()
  /** 被结构性豁免的**完整路径**（例如 `applied_limits.comment`）。 */
  const exemptPaths = new Set()

  const walk = (node, path) => {
    if (node === null || node === undefined) return node
    const t = typeof node
    if (t === 'bigint') return node.toString() // JSON.stringify 不支持 BigInt
    if (t !== 'object') return node
    if (seen.has(node)) return '[circular]'
    seen.add(node)

    if (Array.isArray(node)) {
      return node.map((v, i) => walk(v, `${path}[${i}]`))
    }

    // Date 等非普通对象：交给 JSON（Date 会变 ISO 串）
    const proto = Object.getPrototypeOf(node)
    if (proto !== Object.prototype && proto !== null) {
      try {
        return JSON.parse(JSON.stringify(node))
      } catch (e) {
        // ⚠️ 不吞异常：无法序列化的对象必须显式降级为可读字符串并归因。
        return `[unserializable:${e.name || 'Error'}]`
      }
    }

    const out = {}
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k
      // ⚠️ 结构性豁免（见 STRUCTURAL_SET）：值是普通对象时，该键是**结构容器**，
      //    其**直接子键**是渠道名等结构性标识，不是正文。
      //    ⚠️ 豁免必须严格限定在"该容器的直接子键"这一层：
      //       容器里再嵌一层普通对象（例如 `{applied_limits:{x:{comment:"正文"}}}`）
      //       时，里面的 comment 仍然是禁用的正文键，必须照常脱敏。
      //       把豁免无限往下传（"路径之后全部豁免"）会开出一个隐私缺口。
      if (STRUCTURAL_SET.has(k) && isPlainObject(v)) {
        const container = {}
        for (const [ck, cv] of Object.entries(v)) {
          container[ck] = walk(cv, `${p}.${ck}`)
          // ⚠️ 记录**被豁免的完整路径**（例如 `applied_limits.comment`）：
          //    二次扫描要用它把 privacy.js 的宽口径误报滤掉。
          exemptPaths.add(`${p}.${ck}`)
        }
        out[k] = container
        continue
      }
      if (FORBIDDEN_SET.has(k) && !REQUIRED_KEYS.has(k)) {
        if (!leakedKeys.includes(p)) leakedKeys.push(p)
        out[k] = '[redacted]'
        continue
      }
      out[k] = walk(v, p)
    }
    return out
  }

  const clean = walk(value, '')
  // ⚠️ 二次扫描用 privacy.js 的权威实现再确认一遍。
  //    两套实现（本地替换 + 权威扫描）互为交叉校验：任何一边漏了，
  //    另一边仍会把路径暴露在 leakedKeys 里。
  //
  // ⚠️ 必须滤掉**本模块已判定豁免**的路径。privacy.js 的豁免范围比本地更宽
  //    （它不区分值是不是普通对象），所以它会把渠道名 `applied_limits.comment`
  //    也报出来。豁免判定的**唯一出处**是本模块上面那一段（要求值是普通对象），
  //    否则一条合法的策略审计会被标记成"隐私泄露"，排查时全是噪声。
  //    注意：只滤掉被豁免的那一层，更深层的路径照常上报。
  for (const p of scanForPrivacyLeaks(clean, { allow: [...REQUIRED_KEYS] })) {
    if (exemptPaths.has(p)) continue
    if (!leakedKeys.includes(p)) leakedKeys.push(p)
  }
  for (const p of leakedKeys) if (!redactedKeys.includes(p)) redactedKeys.push(p)

  return { value: clean, redactedKeys, leakedKeys }
}

/** 按键名收集"像正文"的字符串路径（只告警）。 */
function findTextLikeStrings(node, path = '', out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    if (node.length >= TEXT_LIKE_MIN_LEN && CJK_TEXT_RE.test(node)) out.push(path)
    return out
  }
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((v, i) => findTextLikeStrings(v, `${path}[${i}]`, out))
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    findTextLikeStrings(v, path ? `${path}.${k}` : k, out)
  }
  return out
}

class AuditLog {
  /**
   * @param {object} opts
   * @param {object} opts.store               客户端 Store（唯一写盘者）
   * @param {() => number} [opts.now]         取时函数，便于测试注入
   * @param {number} [opts.maxBytes]          轮转阈值（字节）
   * @param {(evt:object) => void} [opts.onWarn] 告警回调（脱敏/正文启发式）
   * @param {(entry:object) => void} [opts.onEntry] 上报队列挂钩（本地先落，再进队列）
   * @param {string} [opts.file]              审计文件名（多实例分片时用）
   */
  constructor(opts) {
    if (!opts || !opts.store) throw new Error('AuditLog 需要 store')
    this.store = opts.store
    this.now = opts.now || (() => Date.now())
    this.maxBytes = Number.isFinite(Number(opts.maxBytes))
      ? Math.max(1024, Number(opts.maxBytes)) : DEFAULT_MAX_BYTES
    this.onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null
    this.onEntry = typeof opts.onEntry === 'function' ? opts.onEntry : null
    this.file = opts.file || AUDIT_FILE
    this.rotatedFile = opts.rotatedFile || AUDIT_FILE_ROTATED
    /** 已轮转次数（本次进程内），供 UI 与排障展示 */
    this.rotations = 0
  }

  // ── 写入 ──────────────────────────────────────────────────

  /**
   * 写一条审计。
   *
   * @param {object} entry 必须含 kind（AUDIT_KINDS 之一）
   * @param {object} [opts]
   * @param {boolean} [opts.strict] true = 发现禁用键/正文直接抛错
   *                                （用于"绝不允许泄漏"的调用点）
   * @returns {object} 实际落盘的那一条
   */
  append(entry, opts = {}) {
    if (!entry || typeof entry !== 'object') {
      throw new AppError('AUDIT_SEND_INVALID', '审计条目必须是对象')
    }
    if (!AUDIT_KINDS.includes(entry.kind)) {
      // ⚠️ 闭集：未知类型一律拒绝。放行未知类型等于"审计里出现了没人认识的类别"，
      //    统计与对账都会静默漏掉它。
      throw new AppError('AUDIT_SEND_INVALID', `未知的审计条目类型：${entry.kind}`, {
        kind: entry.kind === undefined ? null : String(entry.kind),
        allowed: AUDIT_KINDS,
      })
    }

    const tsMs = entry.tsMs === undefined ? this.now() : Number(entry.tsMs)
    if (!Number.isFinite(tsMs)) {
      throw new AppError('AUDIT_SEND_INVALID', `审计条目的时间戳非法：${entry.tsMs}`)
    }

    // ⚠️ 先过一遍脱敏器（替换禁用键），再用 privacy.js 的权威扫描复核。
    //    两套实现互为交叉校验：任何一边漏了，另一边仍会把路径暴露在 leakedKeys 里。
    const { value: clean, redactedKeys, leakedKeys } = sanitizeForAudit(entry)
    const textLike = findTextLikeStrings(clean)

    if (opts.strict === true && leakedKeys.length > 0) {
      // ⚠️ fail-closed：调用方声明"这里绝不允许出现隐私字段"，
      //    那就必须报错，让问题在开发/自测阶段暴露，而不是进了文件才发现。
      throw new AppError('REPORT_PRIVACY_VIOLATION',
        `审计条目含禁用字段，已拒绝写入：${leakedKeys.join(', ')}`, {
          kind: entry.kind, fields: leakedKeys,
        })
    }
    if (leakedKeys.length > 0 || textLike.length > 0) {
      this.#warn('audit_sanitized', {
        kind: entry.kind,
        redacted: redactedKeys,
        text_like_fields: textLike,
      })
    }

    // ⚠️ schema / tsMs / kind 由本模块**强制**给出：条目自身带的同名字段
    //    不得覆盖它们（否则调用方能把时间戳改到任意位置，审计就失去时序意义）。
    const record = { ...clean, schema: 1, tsMs, kind: entry.kind }

    // ⚠️ 预估"追加后"的大小再决定是否轮转。
    //    若只在追加**前**看当前大小，文件会稳定超出阈值整整一条——
    //    阈值就不再是上界，"有界增长"这个前提也就不成立了。
    this.#rotateIfNeeded(JSON.stringify(record).length + 1)
    this.store.appendLine(this.file, record)

    if (this.onEntry) {
      try {
        this.onEntry(record)
      } catch (e) {
        // ⚠️ 不吞异常：本地已落盘，但上报队列挂钩失败意味着**服务端副本会缺这条**。
        //    必须归因并告警，绝不静默。
        this.#warn('audit_enqueue_failed', { kind: record.kind, error: e.message })
      }
    }
    return record
  }

  // ── 各类条目 ──────────────────────────────────────────────

  /**
   * 发送前的尝试。
   *
   * ⚠️ 必须在**发送前**写（协议 §7.3 / AGENTS.md §2.7）：`send_id` 是幂等键
   *    也是计费键，崩溃或断网后要靠它避免重复发送与重复计费。
   *    所以这里**只记标识与计数字段**，绝不记文案原文。
   */
  recordSendAttempt({ sendId, sourceType, atMs, targetHash, userKeyHash, contentHash, ruleId } = {}) {
    if (!sendId) {
      throw new AppError('AUDIT_SEND_INVALID', '发送尝试必须带 send_id（幂等键，发送前生成）')
    }
    if (!SOURCE_TYPES.includes(sourceType)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知渠道 ${sourceType}`, { allowed: SOURCE_TYPES })
    }
    return this.append({
      kind: 'send_attempt', tsMs: atMs, sendId, sourceType,
      targetHash: targetHash || null,
      userKeyHash: userKeyHash || null,
      contentHash: contentHash || null,
      ruleId: ruleId || null,
    })
  }

  /**
   * 发送结果。
   *
   * ⚠️ `verdict` 必须是协议闭集里的值；`sent_confirmed` 只允许来自
   *    平台响应体（`confirmSignal === 'platform_response'`）。
   *    这里做一次本地一致性校验，**不替代**服务端的计费校验（红线 2）。
   */
  recordSendResult({
    sendId, sourceType, verdict, confirmSignal, platformStatusCode,
    failureReason, atMs, riskControlSignal, targetHash, userKeyHash,
  } = {}) {
    if (!sendId) throw new AppError('AUDIT_SEND_INVALID', '发送结果必须带 send_id')
    if (!SOURCE_TYPES.includes(sourceType)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知渠道 ${sourceType}`, { allowed: SOURCE_TYPES })
    }
    if (!VERDICTS.includes(verdict)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知 verdict：${verdict}`, { allowed: VERDICTS })
    }
    if (confirmSignal !== undefined && confirmSignal !== null && !CONFIRM_SIGNALS.includes(confirmSignal)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知 confirm_signal：${confirmSignal}`,
        { allowed: CONFIRM_SIGNALS })
    }
    if (failureReason !== undefined && failureReason !== null && !FAILURE_REASONS.includes(failureReason)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知 failure_reason：${failureReason}`,
        { allowed: FAILURE_REASONS })
    }
    if (verdict === 'failed' && !failureReason) {
      throw new AppError('AUDIT_SEND_INVALID', 'verdict=failed 时必须给出 failure_reason')
    }
    // ⚠️ 空响应 = 风控拒绝（协议 §7.4）。这里只做**记录**，
    //    判定与触发熔断由 circuit.js 负责。
    return this.append({
      kind: 'send_result', tsMs: atMs, sendId, sourceType, verdict,
      confirmSignal: confirmSignal || null,
      platformStatusCode: platformStatusCode === undefined ? null : Number(platformStatusCode),
      failureReason: failureReason || null,
      riskControlSignal: riskControlSignal || null,
      targetHash: targetHash || null,
      userKeyHash: userKeyHash || null,
    })
  }

  /**
   * 配置变更 —— **`applied:false` + `rejectCode` 是最关键的一条证据**。
   *
   * ⚠️ 它回答的是"用户是否主动调高过、系统是否拒绝过"。
   *    早期实现只在变更成功时记一条，于是纠纷时无法自证。
   *    因此 `applied === false` 时**强制** `rejectCode`：缺了直接抛错，
   *    逼调用方把拒绝原因带上，而不是静默丢掉这条证据。
   *
   * @param {object} p
   * @param {string} p.fieldKey  配置点路径（如 `limits.comment.daily_max`）
   * @param {*} p.oldValue
   * @param {*} p.newValue
   * @param {'user'|'server_policy'|'default'} p.source
   * @param {'local_user'|'license_server'|'system'} p.actor
   * @param {boolean} p.applied
   * @param {string} [p.rejectCode] applied=false 时必填
   * @param {number} [p.policyVersion]
   * @param {number} [p.atMs]
   */
  recordConfigChange({
    fieldKey, oldValue, newValue, source, actor, applied, rejectCode,
    policyVersion, atMs, changeId,
  } = {}) {
    if (!fieldKey) throw new AppError('AUDIT_CONFIG_INVALID', '配置变更必须带 field_key')
    if (!CHANGE_SOURCES.includes(source)) {
      throw new AppError('AUDIT_CONFIG_INVALID', `未知 source：${source}`, { allowed: CHANGE_SOURCES })
    }
    if (!CHANGE_ACTORS.includes(actor)) {
      throw new AppError('AUDIT_CONFIG_INVALID', `未知 actor：${actor}`, { allowed: CHANGE_ACTORS })
    }
    if (applied === undefined || applied === null) {
      throw new AppError('AUDIT_CONFIG_INVALID', '配置变更必须显式给出 applied（true/false）')
    }
    if (applied === false && !rejectCode) {
      throw new AppError('AUDIT_CONFIG_INVALID',
        `applied=false 时必须给出 reject_code（field_key=${fieldKey}）——` +
        '这是"用户尝试越权、系统拒绝"的关键证据，不允许省略')
    }
    return this.append({
      kind: 'config_change', tsMs: atMs,
      changeId: changeId || null,
      fieldKey,
      // ⚠️ 一律转字符串：契约要求字符串形态，且数字/布尔混用会让对账失败
      oldValue: oldValue === undefined || oldValue === null ? null : String(oldValue),
      newValue: newValue === undefined || newValue === null ? null : String(newValue),
      source, actor,
      applied: applied === true,
      rejectCode: applied === true ? null : rejectCode,
      policyVersion: policyVersion === undefined ? null : Number(policyVersion),
    })
  }

  /**
   * 实际生效的策略 —— **红线 3 的核心条目**。
   *
   * ⚠️ 必须传 `guard.effectiveLimits()` 的结果（服务端策略与商家自定义
   *    取更保守者之后的**真实生效值**），不是服务端下发值、也不是用户输入值。
   *    只记设置值在纠纷时无法自证。
   *
   * @param {object} p
   * @param {number} p.policyVersion
   * @param {string} [p.policyHash]
   * @param {object} p.appliedLimits {comment:{...}, live_danmaku:{...}, dm:{...}, active_hours}
   * @param {string} [p.accountTier]
   * @param {number} [p.atMs]
   */
  recordPolicyApplied({
    policyVersion, policyHash, appliedLimits, accountTier, atMs, source,
  } = {}) {
    if (policyVersion === undefined || policyVersion === null || !Number.isFinite(Number(policyVersion))) {
      throw new AppError('AUDIT_CONFIG_INVALID', '策略快照必须带 policy_version')
    }
    if (!appliedLimits || typeof appliedLimits !== 'object') {
      throw new AppError('AUDIT_CONFIG_INVALID',
        '策略快照必须带 applied_limits（**实际生效值**，取自 guard.effectiveLimits()）')
    }
    // ⚠️ 逐渠道展开成显式字段：`appliedLimits.comment` 里的键名 `comment`
    //    是**渠道名**，语义上不是评论内容。privacy.js 的 STRUCTURAL_KEY_PATHS
    //    已为报告路径豁免它，但审计本地文件用显式字段更不容易被误读。
    const limits = {}
    for (const src of SOURCE_TYPES) {
      const l = appliedLimits[src]
      if (!l || typeof l !== 'object') continue
      limits[src] = {
        daily_max: Number(l.daily_max),
        min_interval_ms: Number(l.min_interval_ms),
        content_similarity_max: Number(l.content_similarity_max),
      }
    }
    return this.append({
      kind: 'policy_applied', tsMs: atMs,
      policyVersion: Number(policyVersion),
      policyHash: policyHash || null,
      accountTier: accountTier || null,
      // ⚠️ 字段名用契约原名 `applied_limits`（见 APPLIED_LIMITS_KEY 的说明）
      [APPLIED_LIMITS_KEY]: limits,
      activeHours: appliedLimits.active_hours || null,
      source: source || 'server_policy',
    })
  }

  /**
   * 熔断事件。
   *
   * ⚠️ 升级、降级、解除、服务端下发**都要记**。只记升级的话，
   *    "为什么今天停了 3 小时"在审计里会变成空白。
   */
  recordCircuit({
    event, level, untilMs, reason, atMs, source, failureRate, platformRejectCount, hint,
  } = {}) {
    const EVENTS = ['escalate', 'decay', 'clear', 'server_cooldown']
    if (!EVENTS.includes(event)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知熔断事件：${event}`, { allowed: EVENTS })
    }
    return this.append({
      kind: 'circuit', tsMs: atMs, event,
      circuitLevel: level || 'none',
      circuitUntilMs: untilMs === undefined ? 0 : Number(untilMs),
      circuitReason: reason || null,
      circuitSource: source || null,
      failureRate: failureRate === undefined ? null : Number(failureRate),
      platformRejectCount: platformRejectCount === undefined ? null : Number(platformRejectCount),
      hint: hint || null,
    })
  }

  /** 急停开/关。⚠️ 必须记 actor——"谁按的"是复盘时的第一个问题。 */
  recordEmergencyStop({ on, reason, actor, atMs } = {}) {
    return this.append({
      kind: 'emergency_stop', tsMs: atMs,
      emergencyStop: Boolean(on),
      reason: reason || null,
      actor: actor || 'local_user',
    })
  }

  /**
   * 引擎状态迁移（启动/停止/暂停/恢复/收到停机指令）。
   *
   * ⚠️ 为什么值得单列一类，而不是塞进 `circuit` 或只写日志：
   *    红线 3 要求审计能回答"**为什么当时没在发**"。而这个问题的答案
   *    往往就是"引擎被停了"，原因可能是用户按了停止、余额耗尽、
   *    服务端下发停机指令、或凭据失效。只写日志的话，日志会滚动、
   *    会被清理，而审计是留痕用的。
   *
   * ⚠️ `event` 是**闭集**。放行任意字符串等于放弃统计能力
   *    （"engine_stoped" 与 "engine_stopped" 会变成两个不同的类别，
   *     而这种拼写差异在统计里完全看不出来）。
   *
   * ⚠️ 与 `recordCircuit` 的分工：熔断的**级别变化**记在 `circuit`；
   *    这里是"发送这个行为整体被允许与否"的迁移。两者会同时出现
   *    （熔断触发 → 引擎暂停），这不是重复记录，而是两个不同的事实。
   */
  recordEngineState({ event, reason, actor, policyVersion, atMs } = {}) {
    const EVENTS = ['engine_start', 'engine_stop', 'engine_pause', 'engine_resume']
    if (!EVENTS.includes(event)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知引擎状态事件：${event}`, { allowed: EVENTS })
    }
    return this.append({
      kind: 'engine_state', tsMs: atMs, event,
      reason: reason || null,
      actor: actor || 'system',
      policyVersion: policyVersion === undefined ? null : Number(policyVersion),
    })
  }

  /** 登录 / 登出 / 令牌刷新。⚠️ 只记结果与设备标识，**不记 token**。 */
  recordLogin({ event, actor, ok, code, deviceIdHash, atMs } = {}) {
    return this.append({
      kind: 'login', tsMs: atMs,
      event: event || 'login',
      actor: actor || 'local_user',
      ok: ok !== false,
      code: code || null,
      deviceIdHash: deviceIdHash || null,
    })
  }

  /**
   * 安全事件（验签失败、隐私拦截、隐私上报被拒…）。
   * ⚠️ 这类事件**不得**被静默处理（AGENTS.md §2.8），因此必定落一条。
   */
  recordSecurityEvent({ event, detail, atMs } = {}) {
    if (!event) throw new AppError('AUDIT_SEND_INVALID', '安全事件必须带 event 名称')
    return this.append({
      kind: 'security_event', tsMs: atMs, event,
      detail: detail === undefined ? null : detail,
    })
  }

  // ── 读取 ──────────────────────────────────────────────────

  /**
   * 查询审计条目（供 UI 与排障）。
   *
   * ⚠️ 单行损坏**不中断整体读取**：`store.readLines` 会解析出可用的行并
   *    通过 `onCorruptLine` 回报坏行数，这里把它带进返回值
   *    （`corruptLines`），绝不静默跳过——"审计日志少了几条"必须看得见。
   *
   * @param {object|string} [q] kind 字符串或 {kind, fromMs, toMs, limit, includeRotated}
   * @returns {Array<object>} 时间升序
   */
  query(q) {
    let qq = q
    if (typeof qq === 'string') qq = { kind: qq }
    if (qq === undefined || qq === null) qq = {}
    if (!qq.kind && qq.kind !== undefined && qq.kind !== null && qq.kind !== '') {
      throw new AppError('AUDIT_SEND_INVALID', `未知的审计条目类型：${qq.kind}`)
    }
    if (qq.kind !== undefined && qq.kind !== null && qq.kind !== '' && !AUDIT_KINDS.includes(qq.kind)) {
      throw new AppError('AUDIT_SEND_INVALID', `未知的审计条目类型：${qq.kind}`,
        { allowed: AUDIT_KINDS })
    }

    const stats = { corruptLines: 0, readFiles: [] }
    const rows = []
    // ⚠️ 轮转文件里的条目时间**更早**，必须放在前面才能保持时间升序
    if (qq.includeRotated === true && this.store.exists(this.rotatedFile)) {
      rows.push(...this.#readFile(this.rotatedFile, stats))
    }
    rows.push(...this.#readFile(this.file, stats))

    let out = rows
    if (qq.kind) out = out.filter((r) => r && r.kind === qq.kind)
    const fromMs = qq.fromMs === undefined ? null : Number(qq.fromMs)
    const toMs = qq.toMs === undefined ? null : Number(qq.toMs)
    if (fromMs !== null && Number.isFinite(fromMs)) out = out.filter((r) => Number(r.tsMs) >= fromMs)
    if (toMs !== null && Number.isFinite(toMs)) out = out.filter((r) => Number(r.tsMs) <= toMs)

    out = out.slice().sort((a, b) => Number(a.tsMs) - Number(b.tsMs))
    const limit = qq.limit === undefined ? null : Math.max(0, Math.floor(Number(qq.limit)))
    if (limit !== null && Number.isFinite(limit)) out = out.slice(-limit)

    // 让调用方能读到损坏计数（数组本身带属性，不破坏 Array 语义）
    Object.defineProperty(out, 'corruptLines', { value: stats.corruptLines, enumerable: false })
    Object.defineProperty(out, 'readFiles', { value: stats.readFiles, enumerable: false })
    return out
  }

  /** 某类条目的数量（含轮转文件）。 */
  count(kind, opts = {}) {
    return this.query({ kind, includeRotated: opts.includeRotated === true }).length
  }

  /** 只读统计，供 UI 展示"审计是否健康"。 */
  stats() {
    const stats = { corruptLines: 0, readFiles: [] }
    const rows = []
    if (this.store.exists(this.rotatedFile)) {
      rows.push(...this.#readFile(this.rotatedFile, stats))
    }
    rows.push(...this.#readFile(this.file, stats))
    const byKind = {}
    for (const k of AUDIT_KINDS) byKind[k] = 0
    let earliest = null
    let latest = null
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      if (byKind[r.kind] === undefined) byKind[r.kind] = 0
      byKind[r.kind]++
      const t = Number(r.tsMs)
      if (Number.isFinite(t)) {
        if (earliest === null || t < earliest) earliest = t
        if (latest === null || t > latest) latest = t
      }
    }
    return {
      total: rows.length,
      byKind,
      earliestMs: earliest,
      latestMs: latest,
      corruptLines: stats.corruptLines,
      rotations: this.rotations,
      maxBytes: this.maxBytes,
      fileBytes: this.store.exists(this.file) ? this.#sizeOf(this.file) : 0,
    }
  }

  // ── 轮转 ──────────────────────────────────────────────────

  /**
   * 轮转：把主文件的内容并入 `audit-log.1.jsonl`，并保证**没有条目凭空消失**。
   *
   * ⚠️ 用 `store.readLines` + 重新 `appendLine`，**不直接用 fs**——
   *    客户端只有 store 可以碰盘（AGENTS.md §2.9 单写者）。
   *
   * ⚠️⚠️ 这里最容易写错的一点：**不能"用这一代覆盖上一代"**。
   *    那样每轮转一次就丢掉整整一代条目——而这一代恰恰是
   *    "用户上周试图调高上限被拒绝"的关键证据。
   *    旧代码正是这么丢数据的（AGENTS.md §2.8 的去重历史写盘失败）。
   *
   * 正确做法（两代 + 有界保留）：
   *   1. 把主文件的内容**追加**到 `audit-log.1.jsonl`（不是覆盖）；
   *   2. 若第 1 步之后 `.1` 超出 `maxBytes`，就只保留**能装下的最近若干条**，
   *      被裁掉的条数记在返回值与告警里（丢弃必须留痕，绝不静默）；
   *   3. 清空主文件，并写入一条极小的轮转标记。
   *
   * 保留窗口由两代共同决定：**最多约 2 × maxBytes** 的条目
   * （`.1` 恰好 maxBytes + 主文件尚未轮转的那部分），
   * 因此磁盘占用有界，而"最近一段时间"的审计不会因为轮转而缺失。
   * `audit-log.1.jsonl` 里的条目时间更早，`query` 会把它排在主文件之前。
   *
   * ⚠️ 轮转标记**只放少量数字、不放 detail 对象**：它是整个文件里时间戳最大
   *    的一条，会被保留窗口优先留住；写得太胖会挤掉真正有价值的审计条目。
   *
   * @returns {{rotated:boolean, entries:number, dropped:number, record?:object}}
   */
  rotate() {
    const rows = this.#readFile(this.file, { corruptLines: 0, readFiles: [] })
    if (rows.length === 0) return { rotated: false, entries: 0, dropped: 0 }

    // ① 追加（不是覆盖）到轮转文件
    for (const r of rows) this.store.appendLine(this.rotatedFile, r)
    this.store.writeAtomic(this.file, '')

    // ② 轮转文件仍有界：按整条裁掉最旧的，并记录裁掉了多少
    const merged = this.store.exists(this.rotatedFile)
      ? this.#readFile(this.rotatedFile, { corruptLines: 0, readFiles: [] })
      : []
    const kept = trimToBytes(merged, this.maxBytes)
    const dropped = merged.length - kept.length
    if (dropped > 0) {
      this.store.writeAtomic(this.rotatedFile, '')
      for (const r of kept) this.store.appendLine(this.rotatedFile, r)
    }

    this.rotations += 1
    // ③ 轮转（以及可能的丢弃）都必须留痕，但标记本身要尽可能小
    const rec = {
      schema: 1, tsMs: this.now(), kind: 'security_event',
      event: 'audit_log_rotated',
      rotated: rows.length,
      retained: kept.length,
      dropped,
      maxBytes: this.maxBytes,
    }
    this.store.appendLine(this.file, rec)
    this.#warn('audit_rotated', { entries: rows.length, retained: kept.length, dropped })
    return { rotated: true, entries: rows.length, dropped, record: rec }
  }

  /**
   * 按"追加后的大小"判断是否需要轮转。
   *
   * ⚠️ 只看当前大小是不够的：那会让文件稳定超出阈值一条，
   *    阈值就不再是上界。因此把即将追加的字节数加进来一起判断。
   *
   * @param {number} incomingBytes 即将追加的字节数
   */
  #rotateIfNeeded(incomingBytes) {
    if (!this.store.exists(this.file)) return false
    const projected = this.#sizeOf(this.file) + Math.max(0, Number(incomingBytes) || 0)
    if (projected <= this.maxBytes) return false
    this.rotate()
    return true
  }

  // ── 内部 ──────────────────────────────────────────────────

  /**
   * 读一个 JSONL 文件并统计损坏行。
   *
   * ⚠️ store 的 `readLines` 会把"解析失败的行数"通过 `onCorruptLine` 回调报出，
   *    但它默认没有挂这个回调——不挂就等于**静默丢行**（AGENTS.md §2.8）。
   *    这里临时挂上自己的统计回调，读完**恢复原来的回调**，
   *    再把损坏计数带进返回值。
   */
  #readFile(name, stats) {
    if (!this.store.exists(name)) return []
    stats.readFiles.push(name)

    const holder = { n: 0 }
    const previous = this.store.onCorruptLine
    this.store.onCorruptLine = (file, corrupt) => {
      holder.n += corrupt
      this.#warn('audit_corrupt_line', { file, corrupt })
    }
    let rows
    try {
      rows = this.store.readLines(name)
    } finally {
      // ⚠️ 必须恢复：调用方可能自己装了回调（例如上报队列），不能被本模块吃掉。
      if (previous === undefined) delete this.store.onCorruptLine
      else this.store.onCorruptLine = previous
    }

    stats.corruptLines += holder.n
    return rows
  }

  /** 文件字节数（经 store.file 解析路径；用 store.list 以免直接碰 fs）。 */
  #sizeOf(name) {
    try {
      const item = this.store.list().find((x) => x.name === name)
      return item ? Number(item.bytes) : 0
    } catch (e) {
      // ⚠️ 不吞异常：统计不到大小不等于"没有超标"，必须归因并告警。
      this.#warn('audit_size_probe_failed', { file: name, error: e.message })
      return 0
    }
  }

  #warn(event, detail) {
    if (this.onWarn) {
      try {
        this.onWarn({ event, atMs: this.now(), ...detail })
      } catch (e) {
        // ⚠️ 告警回调自己抛错不能影响审计写入；但也不许静默——
        //    挂到实例上供排障读取（这是本地可观测的最小代价）。
        this.lastWarnError = `${e.name || 'Error'}: ${e.message}`
      }
    } else {
      this.lastWarnEvent = event
    }
  }
}

module.exports = {
  AuditLog,
  sanitizeForAudit,
  findTextLikeStrings,
  AUDIT_KINDS,
  CHANGE_SOURCES,
  CHANGE_ACTORS,
  AUDIT_FILE,
  AUDIT_FILE_ROTATED,
  DEFAULT_MAX_BYTES,
  FORBIDDEN_SET,
  REQUIRED_KEYS,
  STRUCTURAL_SET,
  APPLIED_LIMITS_KEY,
  trimToBytes,
  isPlainObject,
}
