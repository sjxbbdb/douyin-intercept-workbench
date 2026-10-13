'use strict';

const store = require('./store');

// 策略与上限由服务端持有。
//
// 🔴 客户端【不能传参覆盖】：本模块只读 settings，任何来自请求体的上限都会被忽略。
//    这是"甲"的第一条 —— 上限的权威在服务端，客户端只能更保守。

const POLICY_KEY = 'sending_policy';

// 默认值与 probe 的本地闸门保持一致（per_user 1 / hourly 20 / daily 50）。
// 正式部署应当用 admin 接口改这里的值；客户端无从干预。
const DEFAULT_POLICY = {
  policyVersion: 1,
  limits: {
    perUser: 1,
    hourly: 20,
    daily: 50,
    minIntervalMs: 0,
    activeHours: null            // null = 不限时段；否则 { start: '09:00', end: '22:00', tzOffsetMinutes: 480 }
  },
  observation: { active: false, untilMs: null, dailyLimit: 0 },
  circuit: { failureThreshold: 3, cooldownMs: 30 * 60 * 1000 },
  allowedPublicStates: ['sent_confirmed'],
  authorizationTtlMs: 10 * 60 * 1000
};

function policyIdFor(tenant) {
  return 'send-policy:' + String(tenant);
}

// 读当前生效策略。形状不对就退回默认（宁可保守），并说明来源。
function current(db, tenant) {
  const raw = store.readSetting(db, POLICY_KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: DEFAULT_POLICY, source: 'builtin_default' };
  }
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const merged = {
    policyVersion: Number.isSafeInteger(raw.policyVersion) && raw.policyVersion >= 1 ? raw.policyVersion : DEFAULT_POLICY.policyVersion,
    limits: {
      perUser: Number.isSafeInteger(limits.perUser) && limits.perUser >= 0 ? limits.perUser : DEFAULT_POLICY.limits.perUser,
      hourly: Number.isSafeInteger(limits.hourly) && limits.hourly >= 0 ? limits.hourly : DEFAULT_POLICY.limits.hourly,
      daily: Number.isSafeInteger(limits.daily) && limits.daily >= 0 ? limits.daily : DEFAULT_POLICY.limits.daily,
      minIntervalMs: Number.isSafeInteger(limits.minIntervalMs) && limits.minIntervalMs >= 0 ? limits.minIntervalMs : DEFAULT_POLICY.limits.minIntervalMs,
      activeHours: limits.activeHours && typeof limits.activeHours === 'object' ? limits.activeHours : null
    },
    observation: raw.observation && typeof raw.observation === 'object'
      ? { active: Boolean(raw.observation.active),
          untilMs: Number.isFinite(Number(raw.observation.untilMs)) ? Number(raw.observation.untilMs) : null,
          dailyLimit: Number.isSafeInteger(raw.observation.dailyLimit) ? raw.observation.dailyLimit : 0 }
      : DEFAULT_POLICY.observation,
    circuit: raw.circuit && typeof raw.circuit === 'object'
      ? { failureThreshold: Number.isSafeInteger(raw.circuit.failureThreshold) ? raw.circuit.failureThreshold : DEFAULT_POLICY.circuit.failureThreshold,
          cooldownMs: Number.isSafeInteger(raw.circuit.cooldownMs) ? raw.circuit.cooldownMs : DEFAULT_POLICY.circuit.cooldownMs }
      : DEFAULT_POLICY.circuit,
    allowedPublicStates: Array.isArray(raw.allowedPublicStates) && raw.allowedPublicStates.length
      ? raw.allowedPublicStates.map(String)
      : DEFAULT_POLICY.allowedPublicStates,
    authorizationTtlMs: Number.isSafeInteger(raw.authorizationTtlMs) && raw.authorizationTtlMs > 0
      ? raw.authorizationTtlMs
      : DEFAULT_POLICY.authorizationTtlMs
  };
  return { policy: merged, source: 'server_settings' };
}

// 给客户端的策略【身份】。probe 的 _require_policy 认这三个字段。
function policyRefFor(tenant, policy) {
  return { policyId: policyIdFor(tenant), policyVersion: Number(policy.policyVersion) };
}

// 观察期：到期后自动失效。上限为 0，且【没有跳过入口】。
function observationActive(policy, nowMs) {
  const obs = policy.observation || {};
  if (!obs.active) return false;
  if (obs.untilMs == null) return true;
  return Number(obs.untilMs) > Number(nowMs);
}

function withinActiveHours(policy, nowMs) {
  const hours = policy.limits.activeHours;
  if (!hours || !hours.start || !hours.end) return true;
  const offsetMinutes = Number.isFinite(Number(hours.tzOffsetMinutes)) ? Number(hours.tzOffsetMinutes) : 480;
  const shifted = new Date(Number(nowMs) + offsetMinutes * 60 * 1000);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const toMinutes = function (text) {
    const parts = String(text).split(':');
    return Number(parts[0]) * 60 + Number(parts[1] || 0);
  };
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  return start <= end ? (minutes >= start && minutes <= end) : (minutes >= start || minutes <= end);
}

module.exports = {
  POLICY_KEY, DEFAULT_POLICY,
  policyIdFor, current, policyRefFor, observationActive, withinActiveHours
};
