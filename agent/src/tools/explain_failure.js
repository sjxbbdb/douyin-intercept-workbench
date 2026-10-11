'use strict';

const ledger = require('../ledger');
const leads = require('../store/leads');
const scope = require('../scope');

// T-08：归因。
//
// 红线：unknown 一律 nextAction="none"（未知不得自动重试）。
// 只有明确 failed/blocked 且原因可判定的，才允许 retry_allowed。

// 原始状态 -> 归因。
const STATE_TO_REASON = {
  reserved: { reasonCode: 'send_reserved_unfinished', nextAction: 'none' },
  started: { reasonCode: 'send_started_outcome_unknown', nextAction: 'none' },
  unknown: { reasonCode: 'send_pending_or_interrupted', nextAction: 'none' },
  sent_confirmed: { reasonCode: 'platform_response_recorded', nextAction: 'none' },
  failed: { reasonCode: 'send_failed', nextAction: 'manual' },
  blocked: { reasonCode: 'send_blocked', nextAction: 'manual' }
};

// 明细里的稳定原因 -> 可否重试。captcha 与配额类一律转人工/等待，不自动重试。
const RETRYABLE_DETAIL = {
  page_not_ready: true,
  reply_menu_not_opened: true
};

// 台账里的 targetKey / eventKey 是 probe 的内部标识，【内含 sec_uid 原文】
// （真机实测：video:<id>:MS4wLjABAAAA...）以及"房间+作者+正文"。
// 这些绝不能出 Agent 层 —— 必须换成账号内加盐哈希。
// 没有盐时宁可不给这个字段，也不原样透传（也不在这里偷偷写盘建盐）。
function hashIdentity(ctx, accountScope, raw) {
  if (raw == null || raw === '') return null;
  const salt = leads.loadSalt(ctx.agentStateDir, accountScope);
  if (!salt) return null;
  return leads.hashSubject(salt, String(raw));
}

function pickLedgerFor(value) {
  const raw = String(value || '');
  if (raw.indexOf('cmt') === 0 || raw.indexOf('comment') === 0) return 'comment';
  if (raw.indexOf('live') === 0) return 'live';
  return 'comment';
}

function run(ctx, params) {
  const p = params || {};
  const sendId = p.sendId == null ? null : String(p.sendId);
  const batchId = p.batchId == null ? null : String(p.batchId);
  // 契约里既接受 eventId 也接受 itemId；两者都给时以 eventId 为准。
  const eventId = p.eventId == null ? p.itemId : p.eventId;
  if (!sendId && !batchId && !(eventId == null ? null : String(eventId))) {
    return { ok: false, code: 'blocked/invalid_input', reason: 'one of sendId / batchId / eventId is required' };
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  if (sendId) {
    const found = ledger.sendRow(ctx.config.stateDir, resolved.accountScope, sendId);
    if (!found.ok) return found;
    if (!found.row) {
      return { ok: true, result: { ok: true, subject: { sendId }, evidenceState: 'unknown',
        reasonCode: 'send_id_not_found', detail: null, nextAction: 'none',
        note: 'not found in this account scope is NOT a failure of the ledger' } };
    }
    const state = String(found.row.status);
    const mapped = STATE_TO_REASON[state] || { reasonCode: 'unrecognized_state', nextAction: 'none' };
    let detail = null;
    try { detail = JSON.parse(String(found.row.detail_json || '{}')); } catch (error) { detail = null; }
    let nextAction = mapped.nextAction;
    if (state === 'failed' && detail && RETRYABLE_DETAIL[detail.reason] === true) {
      nextAction = 'retry_allowed';
    }
    // 未知永不放行，即使明细里写了可重试。
    if (state === 'unknown' || state === 'reserved' || state === 'started') nextAction = 'none';
    return { ok: true, result: {
      ok: true,
      subject: { sendId, kind: String(found.row.kind),
                 targetIdentityHash: hashIdentity(ctx, resolved.accountScope, found.row.target_key),
                 targetIdentityNote: 'targetKey is hashed; the raw value embeds sec_uid and never leaves the ledger' },
      evidenceState: state,
      reasonCode: mapped.reasonCode,
      detailReason: detail ? (detail.reason || null) : null,
      nextAction,
      ledgerReadMode: found.readMode
    } };
  }

  if (batchId) {
    const name = pickLedgerFor(batchId);
    const found = ledger.batchRow(ctx.config.stateDir, name, resolved.accountScope, batchId);
    if (!found.ok) return found;
    if (!found.row) {
      return { ok: true, result: { ok: true, subject: { batchId }, evidenceState: 'unknown',
        reasonCode: 'batch_not_found', detail: null, nextAction: 'none' } };
    }
    const status = String(found.row.status);
    const expired = Number(found.row.expires_at) * 1000 < Date.now();
    return { ok: true, result: {
      ok: true,
      subject: { batchId, ledger: name },
      evidenceState: status,
      reasonCode: expired ? 'batch_expired' : 'batch_' + status,
      detail: { expiresAtMs: Number(found.row.expires_at) * 1000, expired },
      nextAction: expired ? 'none' : 'manual',
      ledgerReadMode: found.readMode
    } };
  }

  const name = pickLedgerFor(null);
  const found = ledger.eventRow(ctx.config.stateDir, name, resolved.accountScope, String(eventId));
  if (!found.ok) return found;
  if (!found.row) {
    return { ok: true, result: { ok: true, subject: { eventId: String(eventId) }, evidenceState: 'unknown',
      reasonCode: 'event_not_found', detail: null, nextAction: 'none' } };
  }
  const state = String(found.row.state);
  return { ok: true, result: {
    ok: true,
    subject: { eventId: String(found.row.event_id),
               eventIdentityHash: hashIdentity(ctx, resolved.accountScope, found.row.event_key),
               batchId: found.row.batch_id == null ? null : String(found.row.batch_id) },
    evidenceState: state,
    reasonCode: 'event_' + state,
    detail: null,
    nextAction: state === 'sent_confirmed' ? 'none' : 'manual',
    ledgerReadMode: found.readMode
  } };
}

module.exports = { name: 'explain_failure', run };
