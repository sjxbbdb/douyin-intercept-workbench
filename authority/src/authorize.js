'use strict';

const store = require('./store');
const policyMod = require('./policy');

// 逐次动作授权：这是"甲"的核心。
//
// 计数在服务端 —— 客户端即使改了本地配置，这边的账也不会多给一次。
// 任何一条不过就拒，并且给出【稳定原因码】，不返回模糊的"失败"。

const KINDS = ['comment', 'private', 'danmaku_reply'];
const PHASES = ['public', 'private'];

function deny(reason, detail) {
  return { status: 'denied', reason, detail: detail || null };
}

// 按顺序裁决。order 本身是契约的一部分：先判主体，再判"这段时间根本不许发"，
// 最后才判配额 —— 否则观察期里的拒绝会被误报成"配额不足"。
function authorize(db, input, options) {
  const opts = options || {};
  const nowMs = opts.nowMs == null ? Date.now() : Number(opts.nowMs);
  const tenant = String(input.tenant || '');
  const accountScope = String(input.accountScope || '');
  const sendId = String(input.sendId || '').trim();
  const kind = String(input.kind || '');
  const phase = String(input.phase || '');
  const targetKey = String(input.targetKey || '').trim();
  const publicSendId = input.publicSendId == null ? null : String(input.publicSendId);

  if (!tenant) return deny('not_authenticated');
  if (!accountScope) return deny('account_not_linked');
  if (!sendId || sendId.length > 160) return deny('invalid_send_id');
  if (KINDS.indexOf(kind) === -1) return deny('unsupported_kind');
  if (PHASES.indexOf(phase) === -1) return deny('unsupported_phase');
  if (!targetKey || targetKey.length > 300) return deny('invalid_target');

  // 幂等：同一个 sendId 重放返回同一张授权（不重复计数）。
  const existing = store.findBySendId(db, tenant, sendId);
  if (existing) {
    if (String(existing.target_key) !== targetKey || String(existing.kind) !== kind || String(existing.phase) !== phase) {
      return deny('idempotency_conflict');
    }
    return {
      status: 'granted', idempotent: true,
      authorizationId: String(existing.authorization_id),
      expiresAtMs: Number(existing.expires_at) * 1000,
      policyRef: { policyId: String(existing.policy_id), policyVersion: Number(existing.policy_version) }
    };
  }

  const loaded = policyMod.current(db, tenant);
  const policy = loaded.policy;

  // 1) 观察期：上限为 0，且没有跳过入口。
  if (policyMod.observationActive(policy, nowMs)) {
    return deny('observation_period', { untilMs: policy.observation.untilMs });
  }

  // 2) 两阶段：私信必须绑一条【服务端见过并确认成功】的公屏。
  if (phase === 'private') {
    if (!publicSendId) return deny('public_missing');
    const confirmed = store.publicConfirmed(db, tenant, publicSendId);
    if (!confirmed) return deny('public_not_confirmed');
    if (String(confirmed.account_scope) !== accountScope) return deny('public_account_mismatch');
  }

  // 3) 熔断：连续失败达阈 -> 冷却。
  const failures = store.consecutiveFailures(db, tenant, accountScope);
  if (failures >= Number(policy.circuit.failureThreshold)) {
    const last = store.lastActionAt(db, tenant, accountScope);
    const until = last == null ? null : last + Number(policy.circuit.cooldownMs);
    if (until == null || until > nowMs) {
      return deny('circuit_open', { consecutiveFailures: failures, untilMs: until });
    }
  }

  // 4) 活跃时段
  if (!policyMod.withinActiveHours(policy, nowMs)) {
    return deny('outside_active_hours', { activeHours: policy.limits.activeHours });
  }

  // 5) 最小间隔
  const lastAt = store.lastActionAt(db, tenant, accountScope);
  if (lastAt != null && Number(policy.limits.minIntervalMs) > 0 && nowMs - lastAt < Number(policy.limits.minIntervalMs)) {
    return deny('min_interval', { nextAllowedAtMs: lastAt + Number(policy.limits.minIntervalMs) });
  }

  // 6) 配额：单用户 -> 小时 -> 日（与 probe 同顺序）
  const used = store.usage(db, tenant, accountScope, nowMs);
  const perTarget = used.perTarget.get(targetKey) || 0;
  if (perTarget >= Number(policy.limits.perUser)) {
    return deny('quota_per_user', { used: perTarget, limit: policy.limits.perUser });
  }
  if (used.hourly >= Number(policy.limits.hourly)) {
    return deny('quota_hourly', { used: used.hourly, limit: policy.limits.hourly });
  }
  if (used.daily >= Number(policy.limits.daily)) {
    return deny('quota_daily', { used: used.daily, limit: policy.limits.daily });
  }

  const authorizationId = store.id('auth');
  const expiresAtMs = nowMs + Number(policy.authorizationTtlMs);
  const policyRef = policyMod.policyRefFor(tenant, policy);
  db.prepare(
    'INSERT INTO send_authorizations(tenant,authorization_id,send_id,account_scope,kind,target_key,phase,' +
    'public_send_id,state,reason,policy_id,policy_version,created_at,expires_at) ' +
    "VALUES(?,?,?,?,?,?,?,?,'reserved',NULL,?,?,?,?)"
  ).run(tenant, authorizationId, sendId, accountScope, kind, targetKey, phase,
        publicSendId, policyRef.policyId, policyRef.policyVersion, nowMs / 1000, expiresAtMs / 1000);

  store.audit(db, tenant, 'send_authorization_granted', {
    authorizationId, sendId, kind, phase, policyId: policyRef.policyId, policyVersion: policyRef.policyVersion
  }, nowMs);

  return {
    status: 'granted', idempotent: false,
    authorizationId, expiresAtMs, policyRef,
    policySource: loaded.source,
    remaining: {
      hourly: Math.max(0, Number(policy.limits.hourly) - used.hourly - 1),
      daily: Math.max(0, Number(policy.limits.daily) - used.daily - 1)
    }
  };
}

function denyAudit(db, tenant, reason, input, nowMs) {
  store.audit(db, tenant, 'send_authorization_denied', {
    reason,
    sendId: input && input.sendId ? String(input.sendId) : null,
    kind: input && input.kind ? String(input.kind) : null,
    phase: input && input.phase ? String(input.phase) : null
  }, nowMs);
}

// 了结：commit 记录真实结果（未知一律记 unknown，绝不冒充成功），release 退掉未执行的授权。
function commit(db, tenant, authorizationId, outcome, options) {
  const opts = options || {};
  const nowMs = opts.nowMs == null ? Date.now() : Number(opts.nowMs);
  const row = store.findById(db, tenant, authorizationId);
  if (!row) return { ok: false, reason: 'unknown_authorization' };
  const state = String((outcome || {}).state || '').trim();
  if (store.TERMINAL_STATES.indexOf(state) === -1) {
    // 🔴 只接受终态；没给终态就按 unknown 记 —— 不允许"没结果也算成功"。
    return { ok: false, reason: 'outcome_must_be_terminal' };
  }
  if (String(row.state) === state) return { ok: true, idempotent: true, state };
  db.prepare('UPDATE send_authorizations SET state=?, finished_at=? WHERE tenant=? AND authorization_id=?')
    .run(state, nowMs / 1000, tenant, authorizationId);
  store.audit(db, tenant, 'send_authorization_committed', {
    authorizationId, sendId: String(row.send_id), state,
    reason: (outcome && outcome.reason) ? String(outcome.reason) : null
  }, nowMs);
  return { ok: true, idempotent: false, state };
}

function release(db, tenant, authorizationId, options) {
  const opts = options || {};
  const nowMs = opts.nowMs == null ? Date.now() : Number(opts.nowMs);
  const row = store.findById(db, tenant, authorizationId);
  if (!row) return { ok: false, reason: 'unknown_authorization' };
  if (String(row.state) !== 'reserved') return { ok: false, reason: 'not_reserved' };
  db.prepare("UPDATE send_authorizations SET state='blocked', reason=?, finished_at=? WHERE tenant=? AND authorization_id=?")
    .run('released_before_execution', nowMs / 1000, tenant, authorizationId);
  store.audit(db, tenant, 'send_authorization_released', { authorizationId }, nowMs);
  return { ok: true, state: 'blocked' };
}

module.exports = { KINDS, PHASES, authorize, denyAudit, commit, release };
