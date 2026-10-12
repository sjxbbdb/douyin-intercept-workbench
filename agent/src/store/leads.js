'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 线索库：JSONL + 可重建索引（契约 §五）。BP0 只读。
//
// 隐私红线：对外只出【加盐哈希】与计数，绝不出 sec_uid / 昵称 / 头像 / 原文。
// 因此这里的 read() 只白名单投影字段，不把整行原样透传。

const MAX_LIMIT = 200;
// 白名单投影。textExcerpt 是【有意】放行的：使用者必须看得见这条线索在问什么，
// 否则线索库没有意义。身份（sec_uid / 昵称）仍然只出加盐哈希。
const OUTPUT_FIELDS = ['leadId', 'sourceType', 'intent', 'intentMatched', 'reasonCode',
                       'region', 'textExcerpt', 'roomId',
                       'firstSeenMs', 'lastSeenMs', 'state'];

function saltFile(agentStateDir, accountScope) {
  return path.join(agentStateDir, 'accounts', String(accountScope), 'salt');
}

function loadSalt(agentStateDir, accountScope) {
  const file = saltFile(agentStateDir, accountScope);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw || null;
  } catch (error) {
    return null;
  }
}

function ensureSalt(agentStateDir, accountScope) {
  const existing = loadSalt(agentStateDir, accountScope);
  if (existing) return existing;
  const dir = path.join(agentStateDir, 'accounts', String(accountScope));
  fs.mkdirSync(dir, { recursive: true });
  const salt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(saltFile(agentStateDir, accountScope), salt + '\n', 'utf8');
  return salt;
}

// 加盐哈希：同一账号内稳定可关联，跨账号不可关联。
function hashSubject(salt, raw) {
  return crypto.createHmac('sha256', String(salt)).update(String(raw)).digest('hex').slice(0, 32);
}

function leadsFile(agentStateDir, accountScope) {
  return path.join(agentStateDir, 'accounts', String(accountScope), 'leads.jsonl');
}

function readAll(agentStateDir, accountScope) {
  const file = leadsFile(agentStateDir, accountScope);
  if (!fs.existsSync(file)) return { ok: true, leads: [], source: 'empty' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, code: 'unknown/state_unavailable',
             reason: error && error.message ? error.message : String(error) };
  }
  const leads = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      // 白名单投影：任何未列出的字段（含可能的原文）都不会离开这里。
      const projected = {};
      OUTPUT_FIELDS.forEach(function (field) {
        if (row[field] !== undefined) projected[field] = row[field];
      });
      if (projected.leadId) leads.push(projected);
    } catch (error) { /* 坏行跳过，不让一行脏数据毁掉整个查询 */ }
  }
  return { ok: true, leads, source: 'leads.jsonl' };
}

function query(agentStateDir, accountScope, params) {
  const p = params || {};
  const limit = p.limit == null ? MAX_LIMIT : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, code: 'blocked/invalid_input', reason: 'limit must be a positive integer' };
  }
  if (limit > MAX_LIMIT) {
    // 上限不可由调用方扩大（契约 T-01：limit <= 200）。
    return { ok: false, code: 'blocked/invalid_input', reason: 'limit must not exceed ' + MAX_LIMIT };
  }
  if (p.intent != null && typeof p.intent !== 'string') {
    return { ok: false, code: 'blocked/invalid_input', reason: 'intent must be a string' };
  }
  if (p.region != null && typeof p.region !== 'string') {
    return { ok: false, code: 'blocked/invalid_input', reason: 'region must be a string' };
  }
  if (p.keyword != null && typeof p.keyword !== 'string') {
    return { ok: false, code: 'blocked/invalid_input', reason: 'keyword must be a string' };
  }
  if (p.roomId != null && typeof p.roomId !== 'string') {
    return { ok: false, code: 'blocked/invalid_input', reason: 'roomId must be a string' };
  }
  if (p.excludeComplaint != null && typeof p.excludeComplaint !== 'boolean') {
    return { ok: false, code: 'blocked/invalid_input', reason: 'excludeComplaint must be a boolean' };
  }
  const all = readAll(agentStateDir, accountScope);
  if (!all.ok) return all;
  const filtered = all.leads.filter(function (lead) {
    if (p.intent && String(lead.intent || '') !== String(p.intent)) return false;
    if (p.region && String(lead.region || '') !== String(p.region)) return false;
    // 投诉必须转人工，默认不混进"可回复的线索"里。
    if (p.excludeComplaint === true && String(lead.intent || '') === 'complaint') return false;
    if (p.keyword && String(lead.textExcerpt || '').indexOf(String(p.keyword)) === -1) return false;
    if (p.roomId && String(lead.roomId || '') !== String(p.roomId)) return false;
    if (p.sinceMs != null && Number(lead.lastSeenMs || 0) < Number(p.sinceMs)) return false;
    if (p.untilMs != null && Number(lead.firstSeenMs || 0) > Number(p.untilMs)) return false;
    return true;
  });
  // 意图分布：使用者一眼看到"这批线索里有多少是投诉"。
  const intentCounts = {};
  filtered.forEach(function (lead) {
    const key = String(lead.intent || 'unknown');
    intentCounts[key] = (intentCounts[key] || 0) + 1;
  });
  return { ok: true, leads: filtered.slice(0, limit), total: filtered.length,
           truncated: filtered.length > limit, source: all.source, intentCounts };
}

function appendMany(agentStateDir, accountScope, rows) {
  const dir = path.join(agentStateDir, 'accounts', String(accountScope));
  fs.mkdirSync(dir, { recursive: true });
  const file = leadsFile(agentStateDir, accountScope);
  const lines = rows.map(function (row) { return JSON.stringify(row); }).join('\n');
  fs.appendFileSync(file, (lines ? lines + '\n' : ''), 'utf8');
  return file;
}

module.exports = {
  MAX_LIMIT,
  OUTPUT_FIELDS,
  saltFile,
  loadSalt,
  ensureSalt,
  hashSubject,
  leadsFile,
  readAll,
  query,
  appendMany
};
