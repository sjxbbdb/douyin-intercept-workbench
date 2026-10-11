'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 只读访问 probe 的台账库。
//
// 为什么 Agent 层自己读库而不是加 sidecar 方法：契约 §八 选了"甲"路——
// 已用额度在 sidecar 里没有只读方法（拒绝只发生在 reserve()，不落库），
// 而 Node 内置 node:sqlite 已经够用，零第三方依赖。
//
// 红线：这里【只读】。任何写操作都不属于本模块。

let DatabaseSync = null;
let sqliteUnavailableReason = null;
try {
  // node:sqlite 在 Node 22.5+ 提供；缺失时必须如实报 unavailable，不能猜。
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  sqliteUnavailableReason = error && error.message ? error.message : 'node:sqlite unavailable';
}

const LEDGER_FILES = {
  sends: 'send_state.sqlite3',
  comment: 'comment_flow.sqlite3',
  live: 'live_flow.sqlite3',
  search: 'search_pool.sqlite3'
};

// 与 probe/send_gate.py 完全一致的口径：
//   计数只算 status in (reserved, started, unknown, sent_confirmed)
//   hourly = created_at >= now - 3600（滚动窗口，不是自然小时）
//   daily  = created_at >= now - 86400
const QUOTA_STATUSES = ['reserved', 'started', 'unknown', 'sent_confirmed'];

function ledgerPath(stateDir, name) {
  const file = LEDGER_FILES[name];
  if (!file) throw new Error('unknown ledger: ' + name);
  return path.join(stateDir, file);
}

function exists(stateDir, name) {
  return fs.existsSync(ledgerPath(stateDir, name));
}

// 打开只读连接。WAL 库在 -shm 缺失时只读打开会失败，这时退化成普通打开，
// 但本模块永远不会发出写语句；调用方会把 readMode 如实报出去。
function open(stateDir, name) {
  if (!DatabaseSync) {
    return { ok: false, code: 'unknown/state_unavailable', reason: sqliteUnavailableReason };
  }
  const file = ledgerPath(stateDir, name);
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'unknown/state_unavailable', reason: 'ledger missing: ' + path.basename(file) };
  }
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    return { ok: true, db, readMode: 'read_only' };
  } catch (error) {
    try {
      const db = new DatabaseSync(file);
      return { ok: true, db, readMode: 'shared_no_writes' };
    } catch (error2) {
      return { ok: false, code: 'unknown/state_unavailable',
               reason: 'cannot open ' + path.basename(file) + ': ' + (error2 && error2.message ? error2.message : String(error2)) };
    }
  }
}

function close(handle) {
  if (handle && handle.ok && handle.db) {
    try { handle.db.close(); } catch (error) { /* 关不掉不影响只读结果 */ }
  }
}

// 所有查询都走这里：出参一律是普通对象数组，绝不吃到列名约定。
function all(handle, sql, params) {
  if (!handle || !handle.ok) return [];
  try {
    const stmt = handle.db.prepare(sql);
    return stmt.all(...(params || []));
  } catch (error) {
    return [];
  }
}

function tableNames(handle) {
  if (!handle || !handle.ok) return [];
  try {
    const rows = all(handle, "SELECT name FROM sqlite_master WHERE type='table'");
    return rows.map(function (r) { return String(r.name); });
  } catch (error) {
    return [];
  }
}

function hasTable(handle, name) {
  return tableNames(handle).indexOf(name) !== -1;
}

// 与 SendGate._quota_used 同口径的已用计数。
function quotaUsed(stateDir, accountScope, nowMs) {
  const handle = open(stateDir, 'sends');
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    if (!hasTable(handle, 'sends')) {
      return { ok: false, code: 'unknown/state_unavailable', reason: 'sends table missing' };
    }
    const nowSeconds = Number(nowMs) / 1000;
    const rows = all(handle,
      'SELECT target_key, created_at, status FROM sends WHERE account_scope=? AND status IN (?,?,?,?)',
      [accountScope].concat(QUOTA_STATUSES));
    let hourly = 0;
    let daily = 0;
    const perUser = new Map();
    rows.forEach(function (row) {
      const createdAt = Number(row.created_at);
      if (createdAt >= nowSeconds - 3600) hourly += 1;
      if (createdAt >= nowSeconds - 86400) daily += 1;
      const key = String(row.target_key);
      perUser.set(key, (perUser.get(key) || 0) + 1);
    });
    let maxPerUser = 0;
    perUser.forEach(function (count) { if (count > maxPerUser) maxPerUser = count; });
    return { ok: true, hourly, daily, maxPerUser, readMode: handle.readMode, rows: rows.length };
  } finally {
    close(handle);
  }
}

// 连续失败次数（熔断判据的一部分）。probe 侧不持久化熔断，这里只能从台账推。
// 只统计终态里带失败语义的，并且遇到最近一条成功就停。
function consecutiveFailures(stateDir, accountScope, limit) {
  const handle = open(stateDir, 'sends');
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    const rows = all(handle,
      'SELECT status, finished_at, created_at FROM sends WHERE account_scope=? ' +
      "AND status IN ('failed','blocked','unknown','sent_confirmed') " +
      'ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?',
      [accountScope, Number(limit) || 50]);
    let count = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const status = String(rows[i].status);
      if (status === 'sent_confirmed') break;
      count += 1;
    }
    return { ok: true, consecutiveFailures: count, considered: rows.length, readMode: handle.readMode };
  } finally {
    close(handle);
  }
}

// 发送台账按状态计数。sent_confirmed 取的是【落库原始状态】，
// 不是 send_gate.result() 的对外投影（后者故意把 sent_confirmed 写成 unknown）。
function sendsByStatus(stateDir, accountScope, sinceMs) {
  const handle = open(stateDir, 'sends');
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    const sinceSeconds = sinceMs == null ? null : Number(sinceMs) / 1000;
    const rows = sinceSeconds == null
      ? all(handle, 'SELECT status, kind, created_at FROM sends WHERE account_scope=?', [accountScope])
      : all(handle, 'SELECT status, kind, created_at FROM sends WHERE account_scope=? AND created_at>=?',
            [accountScope, sinceSeconds]);
    return { ok: true, rows: rows.map(function (r) {
      return { status: String(r.status), kind: String(r.kind), createdAt: Number(r.created_at) };
    }), readMode: handle.readMode };
  } finally {
    close(handle);
  }
}

// 批次与事件的原始状态。comment_flow.sqlite3 与 live_flow.sqlite3 表名相同。
function queueStates(stateDir, ledgerName, accountScope) {
  const handle = open(stateDir, ledgerName);
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    const events = hasTable(handle, 'live_events')
      ? all(handle, 'SELECT state, COUNT(*) AS n FROM live_events WHERE account_scope=? GROUP BY state', [accountScope])
      : [];
    const batches = hasTable(handle, 'live_batches')
      ? all(handle, 'SELECT status, COUNT(*) AS n FROM live_batches WHERE account_scope=? GROUP BY status', [accountScope])
      : [];
    const byEvent = {};
    events.forEach(function (r) { byEvent[String(r.state)] = Number(r.n); });
    const byBatch = {};
    batches.forEach(function (r) { byBatch[String(r.status)] = Number(r.n); });
    return { ok: true, events: byEvent, batches: byBatch, readMode: handle.readMode };
  } finally {
    close(handle);
  }
}

// 单条发送记录的原始行（explain_failure 用；绝不返回文本原文）。
function sendRow(stateDir, accountScope, sendId) {
  const handle = open(stateDir, 'sends');
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    const rows = all(handle,
      'SELECT send_id, target_key, kind, status, created_at, started_at, finished_at, detail_json ' +
      'FROM sends WHERE account_scope=? AND send_id=? LIMIT 1',
      [accountScope, String(sendId)]);
    if (!rows.length) return { ok: true, row: null, readMode: handle.readMode };
    return { ok: true, row: rows[0], readMode: handle.readMode };
  } finally {
    close(handle);
  }
}

function eventRow(stateDir, ledgerName, accountScope, eventId) {
  const handle = open(stateDir, ledgerName);
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    const rows = all(handle,
      'SELECT event_id, event_key, batch_id, state, room_id, author_id, detail_json, private_json, updated_at ' +
      'FROM live_events WHERE account_scope=? AND event_id=? LIMIT 1',
      [accountScope, String(eventId)]);
    if (!rows.length) return { ok: true, row: null, readMode: handle.readMode };
    return { ok: true, row: rows[0], readMode: handle.readMode };
  } finally {
    close(handle);
  }
}

function batchRow(stateDir, ledgerName, accountScope, batchId) {
  const handle = open(stateDir, ledgerName);
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason };
  try {
    const rows = all(handle,
      'SELECT batch_id, status, created_at, expires_at FROM live_batches WHERE account_scope=? AND batch_id=? LIMIT 1',
      [accountScope, String(batchId)]);
    if (!rows.length) return { ok: true, row: null, readMode: handle.readMode };
    return { ok: true, row: rows[0], readMode: handle.readMode };
  } finally {
    close(handle);
  }
}

module.exports = {
  LEDGER_FILES,
  QUOTA_STATUSES,
  sqliteAvailable: function () { return Boolean(DatabaseSync); },
  sqliteUnavailableReason: function () { return sqliteUnavailableReason; },
  ledgerPath,
  exists,
  open,
  close,
  all,
  hasTable,
  quotaUsed,
  consecutiveFailures,
  sendsByStatus,
  queueStates,
  sendRow,
  eventRow,
  batchRow
};
