'use strict';

const ledger = require('../ledger');
const authority = require('../authority-client');
const { callOnce } = require('../sidecar-client');

// T-03：能否干活的【唯一】依据。
//
// fail-closed 设计（三条，缺一不可）：
//   1) 没有显式探查浏览器时，canWork 一律 false（unknown/browser_not_probed）；
//   2) 配了授权服务但拿不到策略 -> canWork=false，blockedBy=blocked/authorization_unavailable
//      —— 绝不允许"服务端挂了就先用本地默认上限继续发"；
//   3) 没有配授权服务时，如实标注 sourceOfLimits="local_default"，不冒充服务端策略。

// probe 的登录态只有这三种取值（probe/douyin.py:login_state 的 docstring 写明）。
const LOGIN_OK_STATES = new Set(['verified', 'ok', 'authorized']);
const LOGIN_REQUIRED_STATES = new Set(['required']);

function fail(code, reason) {
  return { ok: false, code, reason };
}

async function run(ctx, params) {
  const p = params || {};
  const atMs = p.atMs == null ? Date.now() : Number(p.atMs);
  if (!Number.isFinite(atMs)) return fail('blocked/invalid_input', 'atMs must be a number');

  const caps = callOnce(ctx.config, 'capabilities', {});
  if (!caps.ok) {
    return fail('unknown/state_unavailable',
      'sidecar capabilities unavailable: ' + String((caps.error && caps.error.code) || 'unknown'));
  }
  const accountScope = String((caps.result && caps.result.accountScope) || '');
  if (!accountScope) return fail('unknown/state_unavailable', 'sidecar did not report accountScope');
  ctx.accountScope = accountScope;

  // ---- 上限的权威：优先服务端；服务端不可达就停机（fail-closed）----
  const localLimits = (caps.result && caps.result.limits) || {};
  const serverPolicy = await authority.policy(ctx);
  const authorityState = {
    configured: Boolean(serverPolicy.configured),
    available: Boolean(serverPolicy.available),
    source: serverPolicy.available ? serverPolicy.source : null,
    reason: serverPolicy.available ? null : String(serverPolicy.reason),
    detail: serverPolicy.available ? null : (serverPolicy.detail || null),
    policyRef: serverPolicy.available ? serverPolicy.policyRef : null
  };

  const limits = serverPolicy.available
    ? { perUser: serverPolicy.limits.perUser, hourly: serverPolicy.limits.hourly, daily: serverPolicy.limits.daily }
    : { perUser: localLimits.per_user, hourly: localLimits.hourly, daily: localLimits.daily };

  // 已用额度：Agent 层只读打开台账库（契约 §八 甲路）。
  const used = ledger.quotaUsed(ctx.config.stateDir, accountScope, atMs);
  const quota = {
    perUser: limits.perUser == null ? null : Number(limits.perUser),
    hourly: limits.hourly == null ? null : Number(limits.hourly),
    daily: limits.daily == null ? null : Number(limits.daily),
    usedHour: used.ok ? used.hourly : null,
    usedDay: used.ok ? used.daily : null,
    maxPerUser: used.ok ? used.maxPerUser : null,
    sourceOfLimits: serverPolicy.available ? 'server_policy'
      : (serverPolicy.configured ? 'unavailable' : 'local_default'),
    sourceOfUsed: used.ok ? 'ledger_read_only' : 'unavailable'
  };
  if (used.ok && quota.hourly != null) quota.remainingHour = Math.max(0, quota.hourly - used.hourly);
  if (used.ok && quota.daily != null) quota.remainingDay = Math.max(0, quota.daily - used.daily);

  // 熔断：probe 不持久化，只能从台账推连续失败数，并如实标注来源。
  const failures = ledger.consecutiveFailures(ctx.config.stateDir, accountScope, 50);
  const threshold = serverPolicy.available && serverPolicy.circuit
    ? Number(serverPolicy.circuit.failureThreshold) : null;
  const circuit = {
    level: 0,
    untilMs: null,
    hint: null,
    consecutiveFailures: failures.ok ? failures.consecutiveFailures : null,
    threshold,
    persisted: false,
    source: failures.ok ? 'ledger_derived' : 'unavailable'
  };

  // 观察期：只有服务端说得出来；没有服务端时如实标注 absent。
  const observation = serverPolicy.available && serverPolicy.observation
    ? {
        active: Boolean(serverPolicy.observation.active),
        untilMs: serverPolicy.observation.untilMs == null ? null : Number(serverPolicy.observation.untilMs),
        dailyLimit: serverPolicy.observation.dailyLimit == null ? null : Number(serverPolicy.observation.dailyLimit),
        source: 'server_policy'
      }
    : { active: false, untilMs: null, dailyLimit: null, source: 'absent_in_probe' };

  // 浏览器/登录：只有显式要求才去连浏览器。
  let browser = { probed: false, connected: null, visibilityState: null };
  let login = 'unknown';
  let captcha = null;
  const unknowns = ['browser', 'login', 'captcha'];

  function mapDoctor(code) {
    if (code === 'browser_not_owned') return 'blocked/browser_not_owned';
    if (code === 'browser_not_visible' || code === 'browser_not_found') return 'blocked/browser_not_connected';
    if (code === 'page_visibility_unknown') return 'blocked/page_visibility_unknown';
    if (code === 'captcha_requires_manual_action') return 'blocked/captcha_requires_manual_action';
    return 'unknown/state_unavailable';
  }

  let forcedBlock = null;
  if (p.probeBrowser === true) {
    const doctor = callOnce(ctx.config, 'doctor', {});
    if (doctor.ok) {
      browser = {
        probed: true,
        connected: true,
        visibilityState: 'reachable',
        pageUrl: doctor.result ? doctor.result.url : null,
        pid: doctor.result && doctor.result.browser ? doctor.result.browser.pid : null
      };
      login = String((doctor.result && doctor.result.login) || 'unknown');
      captcha = Boolean(doctor.result && doctor.result.captcha);
      unknowns.length = 0;
    } else {
      const code = String((doctor.error && doctor.error.code) || '');
      browser = { probed: true, connected: false, visibilityState: null, error: code || 'request_failed' };
      forcedBlock = mapDoctor(code);
    }
  }

  function finish() {
    const checked = browser.probed && browser.connected
      ? ['quota', 'circuit', 'browser', 'login', 'captcha']
      : ['quota', 'circuit'];
    let canWork = true;
    let blockedBy = null;
    if (forcedBlock) {
      canWork = false; blockedBy = forcedBlock;
    } else if (serverPolicy.configured && !serverPolicy.available) {
      // 🔴 甲的核心：服务端策略拿不到就不放行。
      canWork = false;
      blockedBy = 'blocked/' + String(serverPolicy.reason || 'authorization_unavailable');
    } else if (captcha === true) {
      canWork = false; blockedBy = 'blocked/captcha_requires_manual_action';
    } else if (observation.active && Number(observation.dailyLimit) === 0) {
      // 观察期上限为 0，且没有跳过入口。
      canWork = false; blockedBy = 'blocked/observation_period';
    } else if (browser.probed && !LOGIN_OK_STATES.has(login)) {
      // 🔴 真机踩过：probe 的 login_state 只返回 required / verified / unknown，
      //    写成 'ok' / 'authorized' 两个都不存在 —— 结果是【明明登录着却报未授权】。
      //    这种假阴性最坑：它把"能用"说成"不能用"，还让人去查登录。
      canWork = false; blockedBy = login === 'unknown' ? 'unknown/login_state_unconfirmed' : 'blocked/not_authorized';
    } else if (!browser.probed) {
      canWork = false; blockedBy = 'unknown/browser_not_probed';
    } else if (quota.remainingHour != null && quota.remainingHour <= 0) {
      canWork = false; blockedBy = 'blocked/local_quota_hourly';
    } else if (quota.remainingDay != null && quota.remainingDay <= 0) {
      canWork = false; blockedBy = 'blocked/local_quota_daily';
    }
    return { ok: true, result: {
      ok: true,
      accountScope,
      canWork,
      blockedBy,
      checked,
      unknowns: unknowns.slice(),
      authority: authorityState,
      observation,
      circuit,
      degradation: { level: 4, reason: 'rule_only_no_llm_tools_enabled', visible: true },
      quota,
      browser,
      login,
      captcha,
      atMs
    } };
  }

  return finish();
}

module.exports = { name: 'get_account_health', run };
