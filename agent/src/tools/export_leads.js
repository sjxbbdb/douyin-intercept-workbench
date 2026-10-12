'use strict';

const fs = require('node:fs');
const path = require('node:path');

const leads = require('../store/leads');
const scope = require('../scope');
const capture = require('./_capture');
const { INTENTS } = require('../blocked-codes');

// 导出线索（CSV / JSON）。
//
// 为什么这是"写"但不违反"写盘不许散落"：导出文件只会落在
// <agent-state-dir>/exports/ 下，文件名由本工具生成，调用方给不了路径 ——
// 因此不存在路径穿越，也不会往仓库或别的地方写。
//
// 身份仍然是加盐哈希；正文摘要照常导出（否则这份表没用）。

const FORMATS = ['csv', 'json'];
const MAX_ROWS = 5000;

function csvCell(value) {
  const raw = value == null ? '' : String(value);
  // 公式注入防护：以 = + - @ 开头的单元格加一个前导单引号。
  const guarded = /^[=+\-@]/.test(raw) ? "'" + raw : raw;
  return '"' + guarded.replace(/"/g, '""') + '"';
}

function run(ctx, params) {
  const p = params || {};
  const format = p.format == null ? 'csv' : String(p.format);
  if (FORMATS.indexOf(format) === -1) {
    return capture.fail('blocked/invalid_input', 'format must be one of: ' + FORMATS.join(', '));
  }
  if (p.intent != null && INTENTS.indexOf(String(p.intent)) === -1) {
    return capture.fail('blocked/invalid_input', 'intent must be one of: ' + INTENTS.join(', '));
  }
  if (p.limit != null && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > MAX_ROWS)) {
    return capture.fail('blocked/invalid_input', 'limit must be an integer between 1 and ' + MAX_ROWS);
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  const queried = leads.query(ctx.agentStateDir, resolved.accountScope, {
    intent: p.intent,
    region: p.region,
    keyword: p.keyword,
    roomId: p.roomId,
    excludeComplaint: p.excludeComplaint,
    sinceMs: p.sinceMs,
    untilMs: p.untilMs,
    limit: p.limit == null ? leads.MAX_LIMIT : p.limit
  });
  if (!queried.ok) return queried;

  const dir = path.join(ctx.agentStateDir, 'exports');
  let file;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    file = path.join(dir, 'leads-' + stamp + '.' + format);
    if (format === 'json') {
      fs.writeFileSync(file, JSON.stringify({
        exportedAt: new Date().toISOString(),
        accountScope: resolved.accountScope,
        total: queried.total,
        intentCounts: queried.intentCounts,
        leads: queried.leads
      }, null, 2) + '\n', 'utf8');
    } else {
      const columns = ['leadId', 'sourceType', 'intent', 'textExcerpt', 'roomId',
                       'firstSeenMs', 'lastSeenMs', 'state'];
      const lines = [columns.join(',')];
      queried.leads.forEach(function (lead) {
        lines.push(columns.map(function (col) { return csvCell(lead[col]); }).join(','));
      });
      // BOM：Excel 打开中文 CSV 不乱码。
      fs.writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
    }
  } catch (error) {
    return capture.fail('unknown/state_unavailable',
      'cannot write export: ' + (error && error.message ? error.message : String(error)));
  }

  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    format,
    file,
    rows: queried.leads.length,
    total: queried.total,
    truncated: Boolean(queried.truncated),
    intentCounts: queried.intentCounts || null,
    privacy: 'identity_hashed_comment_excerpt_included',
    note: '导出文件只落在 agent 状态目录的 exports/ 下'
  } };
}

module.exports = { name: 'export_leads', run };
