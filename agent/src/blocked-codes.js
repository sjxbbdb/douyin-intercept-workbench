'use strict';

// Agent 层对外只暴露【业务阻断码】（闭集），sidecar 抛的是【协议错误码】。
// 两者是两个命名空间，必须显式映射；不得把协议码原样透传给上层。
// 依据：docs/agent-tools.md §六。

// 闭集枚举。任何自由文本都会让上层无法据此决策，因此一律收敛到这里。
const SOURCE_TYPES = ['comment', 'live'];
const ACTIONS = ['approve', 'reject', 'skip'];
const INTENTS = ['price_inquiry', 'feature_question', 'purchase_intent',
                 'after_sales', 'complaint', 'irrelevant', 'unknown'];
const REASON_CODES = ['keyword_matched', 'rule_priority', 'llm_intent', 'manual'];
const EVIDENCE_STATES = ['sent_confirmed', 'sent_echoed', 'unknown',
                         'failed', 'blocked', 'reserved', 'started'];

// 只有平台回执才算"确认成功"；页面回显（sent_echoed）只是队列证据。
const PLATFORM_CONFIRMED = 'sent_confirmed';

// 协议错误码 -> 业务阻断码。出处逐条核实过，见契约 §6.1。
const PROTOCOL_TO_BLOCKED = {
  invalid_input: 'blocked/invalid_input',
  unsupported: 'blocked/unsupported',
  invalid_request: 'unknown/internal',
  invalid_config: 'unknown/internal',
  request_too_large: 'unknown/internal',
  unknown_method: 'unknown/internal',
  unknown_send: 'blocked/unknown_send',
  invalid_send_id: 'blocked/invalid_input',
  invalid_target: 'blocked/invalid_input',
  idempotency_conflict: 'blocked/idempotency_conflict',
  local_quota_per_user: 'blocked/local_quota_per_user',
  local_quota_hourly: 'blocked/local_quota_hourly',
  local_quota_daily: 'blocked/local_quota_daily',
  public_missing: 'blocked/public_missing',
  public_not_found: 'blocked/public_not_found',
  public_not_a_reply: 'blocked/public_not_a_reply',
  public_pending: 'blocked/public_pending',
  public_unknown: 'blocked/public_unknown',
  public_failed: 'blocked/public_failed',
  public_blocked: 'blocked/public_blocked',
  public_send_id_mismatch: 'blocked/public_send_id_mismatch',
  policy_not_server_issued: 'blocked/policy_not_server_issued',
  policy_ref_missing: 'blocked/policy_ref_missing',
  policy_ref_mismatch: 'blocked/policy_ref_mismatch',
  plan_not_frozen: 'blocked/plan_not_frozen',
  mode_mismatch: 'blocked/mode_mismatch',
  browser_not_owned: 'blocked/browser_not_owned',
  browser_not_visible: 'blocked/browser_not_visible',
  page_visibility_unknown: 'blocked/page_visibility_unknown',
  browser_not_found: 'blocked/browser_not_found',
  // 浏览器生命周期类（真机实测踩过：page_not_ready 没映射，被降级成 unknown/internal，
  // 上层就看不出"只是页面还没就绪"）。
  page_not_ready: 'blocked/page_not_ready',
  browser_start_timeout: 'blocked/browser_start_timeout',
  browser_unavailable: 'blocked/browser_unavailable',
  port_owned_elsewhere: 'blocked/port_owned_elsewhere',
  port_owner_mismatch: 'blocked/port_owner_mismatch',
  invalid_port: 'blocked/invalid_input',
  invalid_path: 'blocked/invalid_input',
  // 批次/事件类
  unknown_batch: 'blocked/unknown_batch',
  unknown_event: 'blocked/unknown_event',
  batch_expired: 'blocked/batch_expired',
  target_not_found: 'blocked/target_not_found',
  invalid_policy_ref: 'blocked/policy_ref_invalid',
  unknown_video_id: 'blocked/unknown_video_id',
  cursor_account_mismatch: 'blocked/cursor_account_mismatch',
  event_not_in_plan: 'blocked/event_not_in_plan',
  no_replyable_comment: 'empty/no_replyable_comment',
  captcha_requires_manual_action: 'blocked/captcha_requires_manual_action',
  target_live_room_mismatch: 'blocked/target_live_room_mismatch',
  typed_into_search_box: 'blocked/typed_into_search_box'
};

// result 体里的 blocked reason（不是错误码）。只看 ok 会漏掉这一类。
const RESULT_REASON_TO_BLOCKED = {
  target_has_unresolved_send: 'blocked/target_has_unresolved_send',
  send_pending_or_interrupted: 'blocked/send_pending_or_interrupted'
};

function toBlocked(code) {
  const key = String(code == null ? '' : code);
  if (PROTOCOL_TO_BLOCKED[key]) return PROTOCOL_TO_BLOCKED[key];
  return 'unknown/internal';
}

// 未知一律 fail-closed：上层拿到 unknown/* 时不允许自动重试。
function isRetryAllowed(nextAction) {
  return nextAction === 'retry_allowed';
}

module.exports = {
  SOURCE_TYPES,
  ACTIONS,
  INTENTS,
  REASON_CODES,
  EVIDENCE_STATES,
  PLATFORM_CONFIRMED,
  PROTOCOL_TO_BLOCKED,
  RESULT_REASON_TO_BLOCKED,
  toBlocked,
  isRetryAllowed
};
