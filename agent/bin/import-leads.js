#!/usr/bin/env node
'use strict';

const config = require('../src/config');
const ledger = require('../src/ledger');
const leads = require('../src/store/leads');
const scope = require('../src/scope');

// 把现有台账【投影】成线索库。这是脚本，不是工具：
// 工具表必须是只读的（BP0 恰好 4 个），投影是离线的一次性动作。
//
// 隐私：只落【加盐哈希】与计数。作者原文、昵称、评论文本一律不落库。
// 平台有时把 sec_uid 脱敏成 *****（已知陷阱），这种行必须跳过 —— 否则会把
// 一堆不相干的观众哈希成同一条线索。

const MASKED = ['', '*****', '****', 'unknown'];

function isMasked(authorId) {
  const raw = String(authorId == null ? '' : authorId).trim();
  if (MASKED.indexOf(raw) !== -1) return true;
  return /^\*+$/.test(raw);
}

function rows(stateDir, ledgerName, scopeId) {
  const handle = ledger.open(stateDir, ledgerName);
  if (!handle.ok) return { ok: false, code: handle.code, reason: handle.reason, rows: [] };
  try {
    if (!ledger.hasTable(handle, 'live_events')) return { ok: true, rows: [] };
    const found = ledger.all(handle,
      'SELECT author_id, room_id, state, seen_at, updated_at FROM live_events WHERE account_scope=?',
      [scopeId]);
    return { ok: true, rows: found };
  } finally {
    ledger.close(handle);
  }
}

function main() {
  const cfg = config.fromEnvAndArgs(process.argv.slice(2), process.env);
  if (cfg.help) { process.stdout.write('用法: node bin/import-leads.js --state-dir <dir> --profile-dir <dir> --port <n>\n'); return 0; }
  const need = config.missing(cfg);
  if (need.length) {
    process.stderr.write('缺少必填参数: ' + need.join(', ') + '\n');
    return 2;
  }
  const ctx = { config: cfg, accountScope: null };
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) {
    process.stderr.write('拿不到 accountScope: ' + resolved.reason + '\n');
    return 1;
  }
  const accountScope = resolved.accountScope;
  const salt = leads.ensureSalt(cfg.agentStateDir, accountScope);

  const existing = leads.readAll(cfg.agentStateDir, accountScope);
  const seenIds = new Set((existing.leads || []).map(function (l) { return String(l.leadId); }));

  const sources = [
    { name: 'comment', ledger: 'comment' },
    { name: 'live', ledger: 'live' }
  ];
  const byLead = new Map();
  let skippedMasked = 0;

  sources.forEach(function (source) {
    const found = rows(cfg.stateDir, source.ledger, accountScope);
    if (!found.ok) return;
    found.rows.forEach(function (row) {
      if (isMasked(row.author_id)) { skippedMasked += 1; return; }
      const subject = source.name + ':' + String(row.author_id);
      const leadId = leads.hashSubject(salt, subject);
      // SQLite 里存的是浮点秒；对外一律整数毫秒，避免上游拿到 1790592755966.3857 这种时间戳。
      const seenAtMs = Math.round(Number(row.seen_at) * 1000);
      const updatedAtMs = Math.round(Number(row.updated_at) * 1000);
      const current = byLead.get(leadId);
      if (!current) {
        byLead.set(leadId, {
          leadId,
          sourceType: source.name,
          intent: 'unknown',   // BP0 没有意图分析；不猜。
          region: null,
          firstSeenMs: seenAtMs,
          lastSeenMs: updatedAtMs,
          state: String(row.state),
          observations: 1
        });
      } else {
        current.observations += 1;
        if (seenAtMs < current.firstSeenMs) current.firstSeenMs = seenAtMs;
        if (updatedAtMs > current.lastSeenMs) current.lastSeenMs = updatedAtMs;
      }
    });
  });

  const fresh = [];
  byLead.forEach(function (lead, leadId) {
    if (!seenIds.has(leadId)) fresh.push(lead);
  });
  if (fresh.length) leads.appendMany(cfg.agentStateDir, accountScope, fresh);

  process.stdout.write(JSON.stringify({
    ok: true,
    accountScope,
    scannedLedgers: sources.map(function (s) { return s.ledger; }),
    distinctLeads: byLead.size,
    imported: fresh.length,
    alreadyKnown: byLead.size - fresh.length,
    skippedMaskedAuthorIds: skippedMasked,
    leadsFile: leads.leadsFile(cfg.agentStateDir, accountScope),
    intent: 'unknown (no intent analysis in BP0)'
  }, null, 2) + '\n');
  return 0;
}

process.exit(main());
