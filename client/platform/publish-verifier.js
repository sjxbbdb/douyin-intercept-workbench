'use strict'

// client/platform/publish-verifier.js
//
// 发送成功的**唯一出口** —— 红线 2「只对平台确认成功的发送计费」的判定点。
//
// ⚠️⚠️ 这是全项目口径风险最高的一个文件。旧代码在这里犯过本项目史上最严重的
//      口径缺陷（docs/需求规格.md D-12）：它用"编辑器消失了 / 评论出现在列表里"
//      判定成功，于是**把页面崩溃记成了已发送**。后果是统计虚高、审计失真、
//      商家按一个假的成功数被计费——而这一切在界面上看起来完全正常。
//
//      所以本文件只做一件事：**把平台响应体翻译成 verdict**。
//      它不碰 DOM、不碰页面、不做任何推断。
//
// 契约依据：protocol.md §7.2 的四级口径
//   sent_confirmed      拿到平台响应体且 status_code === 0
//   sent_confirmed_dom  仅 DOM 判据确认（**默认不计费**）
//   sent_suspected      编辑器消失但没有任何响应（**不得计为成功**）
//   failed              平台返回非 0 码 / 空响应 / 网络层失败
//
// ⚠️ 三条最容易做错的判定：
//   1. **空响应 = 风控拒绝**，不是"没有结论"。必须写
//      `risk_control_signal: "empty_response"`，否则运营看不到风控信号，
//      熔断也统计不到（`platform_reject_count` 就是靠它累加的）。
//   2. **非 0 状态码映射成 `failure_reason`** 而不是笼统的 failed。
//      限流 → rate_limited、内容拒绝 → content_rejected、被拉黑 →
//      blocked_by_target。映射错了会导致"该熔断的没熔断"。
//   3. **HTTP 200 不等于业务成功**。平台的风控响应也是 HTTP 200，
//      必须解出 body 里的 `status_code`。只看 HTTP 状态码是本项目
//      另一个经典误实现。

const { CONFIRM_SIGNALS, PLATFORM_ENDPOINTS, FAILURE_REASONS } = require('../../shared/lib/protocol')

/** 平台业务状态码 → 失败归因（闭集，见 protocol.md §7.4） */
const STATUS_CODE_REASONS = Object.freeze({
  0: null, // 成功
  1: 'unknown',
  2: 'content_rejected',
  4: 'rate_limited',
  8: 'risk_control_rejected',
  9: 'blocked_by_target',
  2046: 'content_rejected',
  2154: 'risk_control_rejected',
})

/** 平台响应体里可能表示"被风控"的关键词（命中即升级归因） */
const RISK_HINTS = Object.freeze([
  'verify', 'captcha', 'risk', '风控', '验证', '滑块', '频繁', '限流',
])

class PublishVerifier {
  /**
   * @param {object} opts
   * @param {object} opts.browserHost  BrowserHost（唯一持有 CDP 的模块）
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    if (!opts || !opts.browserHost) throw new Error('PublishVerifier 需要 browserHost')
    this.host = opts.browserHost
    this.logger = opts.logger || null
    /** 最近一次判定的完整证据（供排障与审计） */
    this.lastEvidence = null
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  /**
   * 开始捕获目标接口的响应。
   *
   * ⚠️ 必须在**按下发送之前**开始捕获。反了就会漏掉响应——
   *    平台响应可能比我们的下一行代码还快，而这个漏洞的表现是
   *    "所有发送都变成 sent_suspected"，于是全部不计费。
   *    （对商家有利，但会让"到底发出去了没有"永远说不清。）
   *
   * @param {string} role 标签页角色
   * @param {string} endpoint 闭集白名单里的路径片段
   */
  async beginCapture(role, endpoint) {
    if (!PLATFORM_ENDPOINTS.includes(endpoint)) {
      // ⚠️ 闭集校验。传入完整 URL 或域名会被服务端拒（契约 §4.8），
      //    所以在这里就挡住，避免把脏值传到上报层。
      throw new Error(
        `platform_endpoint 必须是闭集白名单中的路径片段（收到：${endpoint}）。` +
        `允许：${PLATFORM_ENDPOINTS.join(' / ')}`
      )
    }
    this._endpoint = endpoint
    this._cursor = this.host.responseCursor ? this.host.responseCursor() : 0
    await this.host.startResponseCapture(role, { urlPatterns: [endpoint] })
    return { endpoint, cursor: this._cursor }
  }

  /**
   * 等待并翻译平台响应。
   *
   * ⚠️ 无重试。重试的意义不大且危险：如果第一次没抓到响应，
   *    重按一次 Enter 可能**真的发出第二条评论**（重复回复），
   *    而重复回复恰好是最容易被平台识别为机器人的行为。
   *    所以抓不到就是抓不到，交给上层按 `sent_suspected` 处理。
   *
   * @returns {Promise<{verdict:string, evidence:object, failure_reason:string|null}>}
   */
  async verify({ timeoutMs = 10000, sentAtMs } = {}) {
    const observedAtMs = Date.now()
    let hit = null
    try {
      hit = await this.host.waitForResponse({
        urlPattern: this._endpoint,
        timeoutMs,
        sinceCursor: this._cursor,
      })
    } catch (e) {
      // 抓不到响应 —— 这**不是**异常路径，是正常的业务分支之一。
      // 留痕即可，不上抛（上抛会让调度器把它当"可重试故障"，
      // 而重试意味着再发一条评论）。
      this.#log('warn', 'publish_response_not_captured', {
        endpoint: this._endpoint, timeout_ms: timeoutMs, message: e && e.message,
      })
      hit = null
    } finally {
      await this.host.stopResponseCapture().catch((e) => {
        this.#log('warn', 'stop_response_capture_failed', { message: e && e.message })
      })
    }

    const out = this.#translate(hit, observedAtMs, sentAtMs)
    this.lastEvidence = out.evidence
    return out
  }

  /**
   * 中止捕获（异常路径用）。
   *
   * ⚠️ 存在的理由：抓不到响应时 `verify()` 内部会关掉捕获，但如果
   *    **调用方在 `verify()` 之前就抛错**了（例如输入文案失败），
   *    捕获会一直开着。而 `Network` 域的监听器是**累加**的——
   *    泄漏几次之后每个响应都会被处理多遍，内存与 CPU 都会慢慢涨上去，
   *    表现是"跑了一夜之后变卡"。所以异常路径必须能主动收尾。
   *
   * 幂等：重复调用不抛错。
   */
  async abortCapture() {
    try {
      await this.host.stopResponseCapture()
      return { ok: true }
    } catch (e) {
      this.#log('warn', 'abort_capture_failed', { message: e && e.message })
      return { ok: false, message: e && e.message }
    }
  }

  /**
   * 把抓到的响应翻译成 verdict。
   *
   * @param {object|null} hit  `{ status, rawBody, url, requestId }` 或 null
   */
  #translate(hit, observedAtMs, sentAtMs) {
    // ── 情况 A：完全没抓到任何响应 ────────────────────────────
    if (!hit) {
      return {
        // ⚠️ 刻意用 `sent_suspected` 而不是 failed。
        //    理由：编辑器确实消失过、Enter 确实按下去了，
        //    但我们**没有证据**。判 failed 会丢失后续升级为
        //    sent_confirmed 的可能（契约 §6.3 允许单向升级）；
        //    判 confirmed 就是旧代码那个致命缺陷。
        verdict: 'sent_suspected',
        is_final: false,
        evidence: {
          confirm_signal: 'none',
          platform_endpoint: this._endpoint,
          platform_status_code: null,
          observed_at_ms: observedAtMs,
          dom_stable_ms: 0,
          risk_control_signal: null,
          note: 'no_response_captured',
        },
        failure_reason: null,
      }
    }

    const status = Number(hit.status)
    const raw = typeof hit.rawBody === 'string' ? hit.rawBody : ''
    const parsed = parseJsonLoose(raw)

    // ── 情况 B：空响应体 = 风控拒绝 ──────────────────────────
    // ⚠️ 契约 §4.8 明写"空响应是风控拒绝，不得标记成功"。
    //    这里是最容易被写成"没有结论 → 当成成功"的地方。
    if (!raw.trim()) {
      return {
        verdict: 'failed',
        is_final: true,
        evidence: {
          confirm_signal: 'none',
          platform_endpoint: this._endpoint,
          platform_status_code: null,
          observed_at_ms: observedAtMs,
          dom_stable_ms: 0,
          risk_control_signal: 'empty_response',
          http_status: status,
        },
        failure_reason: 'risk_control_rejected',
      }
    }

    // ── 情况 C：HTTP 层就失败了 ──────────────────────────────
    if (status >= 400) {
      return {
        verdict: 'failed',
        is_final: true,
        evidence: {
          confirm_signal: 'none',
          platform_endpoint: this._endpoint,
          platform_status_code: extractStatusCode(parsed),
          observed_at_ms: observedAtMs,
          dom_stable_ms: 0,
          risk_control_signal: status === 429 ? 'rate_limited' : null,
          http_status: status,
        },
        failure_reason: status === 429 ? 'rate_limited' : 'network_error',
      }
    }

    // ── 情况 D：解不出 JSON ──────────────────────────────────
    // ⚠️ 不能当成功。平台有时返回一段 HTML 拦截页。
    if (parsed === null) {
      const risky = RISK_HINTS.some((h) => raw.toLowerCase().includes(h.toLowerCase()))
      return {
        verdict: 'failed',
        is_final: true,
        evidence: {
          confirm_signal: 'none',
          platform_endpoint: this._endpoint,
          platform_status_code: null,
          observed_at_ms: observedAtMs,
          dom_stable_ms: 0,
          risk_control_signal: risky ? 'interstitial_page' : null,
          http_status: status,
        },
        failure_reason: risky ? 'risk_control_rejected' : 'unknown',
      }
    }

    // ── 情况 E：有 JSON，看业务状态码 ────────────────────────
    const code = extractStatusCode(parsed)
    if (code === 0) {
      return {
        verdict: 'sent_confirmed',
        is_final: true,
        evidence: {
          confirm_signal: 'platform_response', // ← 计费的硬条件之一
          platform_endpoint: this._endpoint,
          platform_status_code: 0,
          observed_at_ms: observedAtMs,
          dom_stable_ms: 0,
          risk_control_signal: null,
          http_status: status,
          // ⚠️ 只记录耗时与体积这类**非隐私**指标。
          //    响应体本身**不入库**——里面有平台返回的评论 ID 与用户标识。
          response_bytes: raw.length,
          latency_ms: sentAtMs ? observedAtMs - sentAtMs : null,
        },
        failure_reason: null,
      }
    }

    if (code === null) {
      // 有 JSON 但没有 status_code → 无法判定。这是**契约外的形态**，
      // 必须留痕（说明平台改了响应结构），并保守地判 failed。
      this.#log('warn', 'publish_response_shape_unknown', {
        endpoint: this._endpoint, keys: Object.keys(parsed).slice(0, 12),
      })
      return {
        verdict: 'failed',
        is_final: true,
        evidence: {
          confirm_signal: 'none',
          platform_endpoint: this._endpoint,
          platform_status_code: null,
          observed_at_ms: observedAtMs,
          dom_stable_ms: 0,
          risk_control_signal: null,
          http_status: status,
          note: 'status_code_absent',
        },
        failure_reason: 'unknown',
      }
    }

    const reason = mapStatusCode(code, parsed)
    return {
      verdict: 'failed',
      is_final: true,
      evidence: {
        confirm_signal: 'none',
        platform_endpoint: this._endpoint,
        platform_status_code: code,
        observed_at_ms: observedAtMs,
        dom_stable_ms: 0,
        risk_control_signal: reason === 'risk_control_rejected' ? `status_code:${code}` : null,
        http_status: status,
      },
      failure_reason: reason,
    }
  }

  /**
   * DOM 判据确认。
   *
   * ⚠️ 这是**独立**的判定入口，且产出的 verdict 是 `sent_confirmed_dom`，
   *    **默认不计费**（契约 §6.1：`bill_dom_confirmed=false`）。
   *    它与 `verify()` 分开，就是为了让"用了 DOM 判据"这件事在代码里
   *    一眼可见——混在一个函数里迟早有人把它的结果当 confirmed 用。
   *
   * @param {object} p
   * @param {number} p.stableMs 节点连续稳定存在的毫秒数
   */
  static domConfirmed({ stableMs, sentAtMs }) {
    return {
      verdict: 'sent_confirmed_dom',
      is_final: true,
      evidence: {
        confirm_signal: 'dom_stable',
        platform_endpoint: null,
        platform_status_code: null,
        observed_at_ms: Date.now(),
        dom_stable_ms: Number(stableMs || 0),
        risk_control_signal: null,
        note: 'dom_only_not_billable',
      },
      failure_reason: null,
      latency_ms: sentAtMs ? Date.now() - sentAtMs : null,
    }
  }
}

// ══════════════════════════════════════════════════════════
// 纯函数（可离线测试）
// ══════════════════════════════════════════════════════════

/** 宽松解析：失败返回 null（调用方必须显式处理，不得当成空对象）。 */
function parseJsonLoose(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

/**
 * 从平台响应里取业务状态码。
 *
 * ⚠️ 平台的响应结构有两层可能：顶层 `status_code`，或包在
 *    `data.status_code` / `statusCode` 里。三个都试，取第一个数字。
 *    取不到返回 null —— **绝不能默认成 0**，那等于把所有异常响应
 *    都判成成功，正是要防的事。
 */
function extractStatusCode(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const candidates = [
    parsed.status_code,
    parsed.statusCode,
    parsed.data && parsed.data.status_code,
    parsed.data && parsed.data.statusCode,
  ]
  for (const c of candidates) {
    if (c === undefined || c === null) continue
    const n = Number(c)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 业务状态码 → failure_reason（闭集）。未知码保守归到 unknown。 */
function mapStatusCode(code, parsed) {
  if (Object.prototype.hasOwnProperty.call(STATUS_CODE_REASONS, code)) {
    return STATUS_CODE_REASONS[code] || 'unknown'
  }
  // 未知码：先看响应里有没有风控关键词，有就按风控处理
  // （宁可多触发一次熔断，也不要漏掉一个真正的风控信号）。
  const text = parsed ? JSON.stringify(parsed).toLowerCase() : ''
  if (RISK_HINTS.some((h) => text.includes(h.toLowerCase()))) return 'risk_control_rejected'
  return 'unknown'
}

/** 校验一个 failure_reason 是否在闭集内（上报前自检用）。 */
function isKnownFailureReason(r) {
  return r === null || r === undefined || FAILURE_REASONS.includes(r)
}

/** 校验 confirm_signal 是否在闭集内。 */
function isKnownConfirmSignal(s) {
  return CONFIRM_SIGNALS.includes(s)
}

module.exports = {
  PublishVerifier,
  STATUS_CODE_REASONS,
  RISK_HINTS,
  parseJsonLoose,
  extractStatusCode,
  mapStatusCode,
  isKnownFailureReason,
  isKnownConfirmSignal,
}
