'use strict';

const { callOnce } = require('./sidecar-client');

// account_scope 只从 sidecar 的 capabilities 读，不在 Node 侧重算路径哈希。
// 理由：跨账号串号是已经发生过的真实缺陷类别，宁可少一个"聪明"的实现。
function resolve(ctx) {
  if (ctx && ctx.accountScope) return { ok: true, accountScope: ctx.accountScope };
  const caps = callOnce(ctx.config, 'capabilities', {});
  if (!caps.ok) {
    return { ok: false, code: 'unknown/state_unavailable',
             reason: 'sidecar capabilities unavailable: ' + String((caps.error && caps.error.code) || 'unknown') };
  }
  const scope = String((caps.result && caps.result.accountScope) || '');
  if (!scope) return { ok: false, code: 'unknown/state_unavailable', reason: 'sidecar did not report accountScope' };
  ctx.accountScope = scope;
  return { ok: true, accountScope: scope };
}

module.exports = { resolve };
