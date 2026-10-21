#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const config = require('../src/config');
const ledger = require('../src/ledger');
const leads = require('../src/store/leads');
const scope = require('../src/scope');
const intentRules = require('../src/intent');

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
      'SELECT author_id, room_id, state, text, seen_at, updated_at FROM live_events WHERE account_scope=?',
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
  const rules = intentRules.loadRules(cfg.agentStateDir, accountScope);
  if (rules.warning) process.stderr.write('提示: ' + rules.warning + '\n');
  const intentCounts = {};

  // --rebuild：整份重建。身份哈希口径变过（旧版本带 source 前缀），
  // 旧文件里的 leadId 与现在的口径对不上，只追加会留下永远匹配不上的陈数据。
  const rebuild = process.argv.indexOf('--rebuild') !== -1;
  if (rebuild) {
    const old = leads.leadsFile(cfg.agentStateDir, accountScope);
    if (fs.existsSync(old)) fs.renameSync(old, old + '.bak');
  }
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
      // 身份哈希口径与 agent 侧 maskEvent 一致：只用 author_id，不带 source 前缀，
      // 这样审批层才能把"批次候选"和"线索意图"按同一个哈希对上。
      const leadId = leads.hashSubject(salt, String(row.author_id));
      // SQLite 里存的是浮点秒；对外一律整数毫秒，避免上游拿到 1790592755966.3857 这种时间戳。
      const seenAtMs = Math.round(Number(row.seen_at) * 1000);
      const updatedAtMs = Math.round(Number(row.updated_at) * 1000);
      const judged = intentRules.classify(row.text, rules.rules);
      intentCounts[judged.intent] = (intentCounts[judged.intent] || 0) + 1;
      const current = byLead.get(leadId);
      if (!current) {
        byLead.set(leadId, {
          leadId,
          sourceType: source.name,
          // 规则判据（商家可自配 intent-rules.json）；判不出来就是 unknown，不猜。
          intent: judged.intent,
          intentMatched: judged.matched.slice(0, 5),
          reasonCode: judged.reasonCode,
          region: null,
          // 正文摘要：只留前 120 字。身份仍是加盐哈希，原文不外传。
          textExcerpt: String(row.text || '').slice(0, 120),
          roomId: String(row.room_id || ''),
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
    rebuilt: rebuild,
    scannedLedgers: sources.map(function (s) { return s.ledger; }),
    distinctLeads: byLead.size,
    imported: fresh.length,
    alreadyKnown: byLead.size - fresh.length,
    skippedMaskedAuthorIds: skippedMasked,
    leadsFile: leads.leadsFile(cfg.agentStateDir, accountScope),
    intentRules: rules.source,
    intentCounts
  }, null, 2) + '\n');
  return 0;
}

process.exit(main());
