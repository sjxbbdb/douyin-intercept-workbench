'use strict'

// client/core/workbench-error.js
//
// 客户端**本地**归因错误 —— 与 `shared/lib/errors.js` 的 `AppError` 是两套东西。
//
// ⚠️ 为什么必须分开，不能复用 AppError：
//
//    `AppError` 的码是**跨端接口契约**的一部分（protocol.md §3 的错误码总表），
//    它的构造函数会拒绝任何未登记在 `ERROR_CODES` 里的码。而客户端需要表达的是
//    **页面操作的失败归因**：选择器没命中、元素尺寸为 0、图文帖不支持、
//    平台响应没抓到……这些既不上报给服务端，也不该污染跨端契约。
//
//    早期如果把本地码塞进 `ERROR_CODES`，后果是：错误码总表里混进一堆
//    服务端永远不会返回的码，读契约的人无法分辨哪些是接口的一部分。
//
// ⚠️ 但两套码有一个**必须共享**的用途：判断"能不能重试"。
//    调度器（`client/host/scheduler.js`）按码决定 requeue 还是 fail，
//    而自愈率 ≥95% 完全依赖这个判断正确。所以本文件把可重试性
//    直接编码进码表（`retryable`），而不是让调度器维护一张平行名单——
//    两张名单迟早不一致，而后果是"该重试的判死了"或"坏任务无限重试"。

/** 本地归因码表。`retryable` = 调度器是否应把任务放回队列而不是判失败。 */
const WORKBENCH_CODES = Object.freeze({
  // ── 页面与元素（多数可重试：页面重渲染后就好了）────────────
  ELEMENT_TIMEOUT: { retryable: true, hint: '元素在预算时间内未出现' },
  ELEMENT_ZERO_SIZE: { retryable: true, hint: '元素尺寸为 0（通常是被虚拟列表回收或存在隐藏副本）' },
  ELEMENT_NOT_VISIBLE: { retryable: true, hint: '元素存在但不可见' },
  PANEL_NOT_EXPANDED: { retryable: true, hint: '评论面板未展开' },
  NAVIGATE_TIMEOUT: { retryable: true, hint: '页面导航超时' },
  SELECTOR_MISS: { retryable: true, hint: '选择器全部候选都未命中（页面可能改版）' },

  // ── 连接与标签页（可重试：这正是自愈率要覆盖的场景）────────
  TAB_LOST: { retryable: true, hint: '标签页已消失，需要重建' },
  CDP_DISCONNECTED: { retryable: true, hint: 'CDP 连接断开' },
  CDP_TIMEOUT: { retryable: true, hint: 'CDP 命令超时' },
  CDP_COMMAND_FAILED: { retryable: true, hint: 'CDP 命令返回错误' },
  PORT_OCCUPIED_BY_OTHER: { retryable: false, hint: '调试端口被非 Chrome 程序占用' },
  CHROME_NOT_READY: { retryable: true, hint: 'Chrome 调试端口未就绪' },
  ALREADY_HOSTED: { retryable: false, hint: '本实例已有浏览器连接持有者' },

  // ── 平台语义（不可重试：重试只是再撞一次墙）────────────────
  NOTE_POST_UNSUPPORTED: { retryable: false, hint: '图文帖网页版评论区是小浮层，无法稳定定位回复按钮' },
  PUBLISH_NOT_CAPTURED: { retryable: false, hint: '未捕获到平台发布响应' },
  PLATFORM_REJECTED: { retryable: false, hint: '平台明确拒绝了本次发送' },
  EMPTY_RESPONSE: { retryable: false, hint: '平台返回空响应（风控拒绝）' },
  RISK_CONTROL_REJECTED: { retryable: false, hint: '被平台风控拒绝' },
  ACCOUNT_RISK: { retryable: false, hint: '账号出现风控信号（验证码/滑块）' },
  CONTENT_REJECTED: { retryable: false, hint: '内容被平台拒绝' },
  RATE_LIMITED: { retryable: false, hint: '被平台限流' },
  BLOCKED_BY_TARGET: { retryable: false, hint: '被对方拉黑，无法回复' },
  LOGIN_EXPIRED: { retryable: false, hint: '抖音登录态已失效，需要在专用浏览器里重新登录' },
  NOT_LOCATABLE: { retryable: false, hint: '无法定位目标（缺少 sec_uid 或会话 ID）' },
  CONTENT_SIMILARITY_REJECTED: { retryable: false, hint: '回复文案与近期已发内容过于相似，已拒绝发送' },
  CONTENT_TOO_SHORT: { retryable: false, hint: '回复文案过短或为空' },

  // ── 本地环境（不可重试，需要人来处理）──────────────────────
  DISK_WRITE_FAILED: { retryable: false, hint: '本地写盘失败' },
  CONFIG_INVALID: { retryable: false, hint: '配置非法' },
  NOT_IMPLEMENTED: { retryable: false, hint: '该功能尚未实现' },
  INTERNAL: { retryable: false, hint: '客户端内部错误' },
})

const CODES = Object.freeze(Object.keys(WORKBENCH_CODES))

/**
 * 本地归因错误。
 *
 * ⚠️ `detail` 里**不得放评论/回复原文与 sec_uid**（红线 3）。
 *    要放定位信息就放"选择器 key"，例如 `selector: 'commentList'`——
 *    那才是改版时唯一有用的线索，而它不含任何隐私。
 */
class WorkbenchError extends Error {
  /**
   * @param {string} code 必须是 WORKBENCH_CODES 的键
   * @param {string} message 面向人的中文说明
   * @param {object} [detail] 结构化上下文（不含隐私原文）
   */
  constructor(code, message, detail) {
    if (!Object.prototype.hasOwnProperty.call(WORKBENCH_CODES, code)) {
      // ⚠️ 不给默认值。未知码直接抛，否则笔误会静默变成一个笼统的 INTERNAL，
      //    而"归因码写错了"这件事将永远查不出来。
      throw new Error(
        `未知的本地归因码 ${code}。请先在 client/core/workbench-error.js 中登记` +
        `（需要跨端上报的码应登记在 shared/lib/errors.js）。`
      )
    }
    super(message || WORKBENCH_CODES[code].hint)
    this.name = 'WorkbenchError'
    this.code = code
    this.detail = detail === undefined ? null : detail
    /** 该码是否可重试（调度器据此决定 requeue 还是 fail） */
    this.retryable = WORKBENCH_CODES[code].retryable
    /** 便于日志与界面统一展示，不外传 */
    this.hint = WORKBENCH_CODES[code].hint
  }

  toJSON() {
    return {
      name: this.name, code: this.code, message: this.message,
      retryable: this.retryable, detail: this.detail,
    }
  }
}

/** 是否为已登记的本地归因码。 */
function isKnownWorkbenchCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(WORKBENCH_CODES, code)
}

/**
 * 该归因码是否可重试。
 *
 * ⚠️ 对**未知码**返回 false。方向很重要：未知码当成"可重试"会让一条
 *    因为代码 bug 而永远失败的任务无限循环；当成"不可重试"则只是
 *    让任务进 failed 队列——人能看到、能查。宁可停下让人看。
 */
function isRetryable(code) {
  if (!isKnownWorkbenchCode(code)) return false
  return WORKBENCH_CODES[code].retryable
}

/** 把任意异常归一成带归因码的 WorkbenchError（未知码 → INTERNAL）。 */
function toWorkbenchError(e, fallbackCode = 'INTERNAL', detail) {
  if (e instanceof WorkbenchError) return e
  const code = isKnownWorkbenchCode(e && e.code) ? e.code : fallbackCode
  const merged = { ...(detail || {}) }
  if (e && e.message) merged.cause = e.message
  if (e && e.code && !isKnownWorkbenchCode(e.code)) merged.cause_code = e.code
  return new WorkbenchError(code, e && e.message, Object.keys(merged).length ? merged : undefined)
}

module.exports = {
  WorkbenchError,
  WORKBENCH_CODES,
  CODES,
  isKnownWorkbenchCode,
  isRetryable,
  toWorkbenchError,
}
