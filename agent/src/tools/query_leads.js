'use strict';

const leads = require('../store/leads');
const scope = require('../scope');
const { INTENTS } = require('../blocked-codes');

// T-01：查线索。只白名单投影（leadId/sourceType/intent/region/时间/state），
// 绝不返回 sec_uid 原文、昵称、头像、评论原文。
function run(ctx, params) {
  const p = params || {};
  if (p.intent != null && INTENTS.indexOf(String(p.intent)) === -1) {
    return { ok: false, code: 'blocked/invalid_input',
             reason: 'intent must be one of: ' + INTENTS.join(', ') };
  }
  // 线索按 account_scope 隔离：先解析，解析不到就报 state_unavailable，绝不读到别的账号。
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;
  const queried = leads.query(ctx.agentStateDir, resolved.accountScope, p);
  if (!queried.ok) return queried;
  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    leads: queried.leads,
    total: queried.total == null ? queried.leads.length : queried.total,
    truncated: Boolean(queried.truncated),
    source: queried.source,
    intentCounts: queried.intentCounts || null,
    privacy: 'identity_hashed_comment_excerpt_included'
  } };
}

module.exports = { name: 'query_leads', run };
