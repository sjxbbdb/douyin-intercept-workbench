'use strict';

const ledger = require('../ledger');
const leads = require('../store/leads');
const scope = require('../scope');

// T-02：台账统计。
//
// 关键口径：sent_confirmed 取【落库原始状态】，不是 send_gate.result() 的对外投影
// （后者故意把 sent_confirmed 写成 unknown）。页面回显（sent_echoed）单独一列，
// 永远不并入成功。

const GROUPS = ['day', 'source_type', 'intent'];
const STATUSES = ['reserved', 'started', 'unknown', 'failed', 'blocked', 'sent_confirmed'];

function emptyCounters() {
  const out = { attempted: 0, dmConfirmed: 0 };
  STATUSES.forEach(function (s) { out[s] = 0; });
  return out;
}

function dayKey(createdAtMs) {
  const d = new Date(Number(createdAtMs));
  return String(d.getUTCFullYear()) + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(d.getUTCDate()).padStart(2, '0');
}

function run(ctx, params) {
  const p = params || {};
  const groupBy = p.groupBy == null ? 'day' : String(p.groupBy);
  if (GROUPS.indexOf(groupBy) === -1) {
    return { ok: false, code: 'blocked/invalid_input', reason: 'groupBy must be one of: ' + GROUPS.join(', ') };
  }
  if (p.fromMs != null && !Number.isFinite(Number(p.fromMs))) {
    return { ok: false, code: 'blocked/invalid_input', reason: 'fromMs must be a number' };
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  const sends = ledger.sendsByStatus(ctx.config.stateDir, resolved.accountScope, p.fromMs);
  if (!sends.ok) return sends;

  const comment = ledger.queueStates(ctx.config.stateDir, 'comment', resolved.accountScope);
  const live = ledger.queueStates(ctx.config.stateDir, 'live', resolved.accountScope);

  // intent 维度只能来自线索库：四套台账里没有 intent 字段。
  const leadRows = leads.readAll(ctx.agentStateDir, resolved.accountScope);
  const intentByLead = new Map();
  if (leadRows.ok) {
    leadRows.leads.forEach(function (lead) {
      if (lead.leadId) intentByLead.set(String(lead.leadId), String(lead.intent || 'unknown'));
    });
  }

  const buckets = new Map();
  function bucket(key) {
    if (!buckets.has(key)) buckets.set(key, emptyCounters());
    return buckets.get(key);
  }

  sends.rows.forEach(function (row) {
    // 只有发送终态才计入 attempted，避免把 reserved 当成"尝试过"。
    let key;
    if (groupBy === 'day') key = dayKey(row.createdAt * 1000);
    else if (groupBy === 'source_type') key = row.kind === 'comment' || row.kind === 'danmaku_reply' ? 'comment' : 'live';
    else key = 'unknown'; // intent 维度在下面按线索补
    const counters = bucket(key);
    counters.attempted += 1;
    if (Object.prototype.hasOwnProperty.call(counters, row.status)) counters[row.status] += 1;
  });

  if (groupBy === 'intent') {
    buckets.clear();
    intentByLead.forEach(function (intent) {
      const counters = bucket(intent);
      counters.attempted += 0; // 线索数是"看到的需求"，不是发送数
      counters.leads = (counters.leads || 0) + 1;
    });
  }

  const out = {};
  buckets.forEach(function (counters, key) { out[key] = counters; });

  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    groupBy,
    groups: out,
    ledger: {
      readMode: sends.readMode,
      sendsRows: sends.rows.length,
      commentBatches: comment.ok ? comment.batches : null,
      liveBatches: live.ok ? live.batches : null,
      commentEvents: comment.ok ? comment.events : null,
      liveEvents: live.ok ? live.events : null
    },
    sentEchoed: 0,
    note: 'sent_echoed is page observation only and is never merged into sent_confirmed'
  } };
}

module.exports = { name: 'get_stats', run };
