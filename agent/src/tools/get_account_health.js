'use strict';

const ledger = require('../ledger');
const { callOnce } = require('../sidecar-client');

// T-03：能否干活的【唯一】依据。
//
// fail-closed 设计：没有显式探查浏览器时，canWork 一律 false，
// 并把 blockedBy 报成 unknown/browser_not_probed —— 不允许"没查就当作能用"。
// 探查浏览器走 sidecar doctor（需要已启动且归属正确的浏览器）。

function fail(code, reason) {
  return { ok: false, code, reason };
}

function run(ctx, params) {
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

  const limits = (caps.result && caps.result.limits) || {};

  // 已用额度：Agent 层只读打开台账库（契约 §八 甲路）。
  const used = ledger.quotaUsed(ctx.config.stateDir, accountScope, atMs);
  const quota = {
    perUser: limits.per_user == null ? null : Number(limits.per_user),
    hourly: limits.hourly == null ? null : Number(limits.hourly),
    daily: limits.daily == null ? null : Number(limits.daily),
    usedHour: used.ok ? used.hourly : null,
    usedDay: used.ok ? used.daily : null,
    maxPerUser: used.ok ? used.maxPerUser : null,
    sourceOfLimits: 'local_gate_defaults',
    sourceOfUsed: used.ok ? 'ledger_read_only' : 'unavailable'
  };
  if (used.ok && quota.hourly != null) quota.remainingHour = Math.max(0, quota.hourly - used.hourly);
  if (used.ok && quota.daily != null) quota.remainingDay = Math.max(0, quota.daily - used.daily);

  // 熔断：probe 不持久化，只能从台账推连续失败数，并如实标注来源。
  const failures = ledger.consecutiveFailures(ctx.config.stateDir, accountScope, 50);
  const circuit = {
    level: 0,
    untilMs: null,
    hint: null,
    consecutiveFailures: failures.ok ? failures.consecutiveFailures : null,
    persisted: false,
    source: failures.ok ? 'ledger_derived' : 'unavailable'
  };

  // 浏览器/登录：只有显式要求才去连浏览器。
  let browser = { probed: false, connected: null, visibilityState: null };
  let login = 'unknown';
  let captcha = null;
  const unknowns = ['browser', 'login', 'captcha'];

  if (p.probeBrowser === true) {
    const doctor = callOnce(ctx.config, 'doctor', {});
    if (doctor.ok) {
      browser = {
        probed: true,
        connected: true,
        // doctor 只有在真的拿到页面之后才会返回，所以走到这里说明页面可达；
        // 可见性本身不在这里断言，交给后续发送动作自己判（page_visibility_unknown 是它的三态之一）。
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
      // doctor 自己会报 browser_not_owned / browser_not_found / page_visibility_unknown 等；
      // 这些是【状态】，不是工具故障，原样进 blockedBy。
      return finish({
        canWork: false,
        blockedBy: mapDoctor(code)
      });
    }
  }

  function mapDoctor(code) {
    if (code === 'browser_not_owned') return 'blocked/browser_not_owned';
    if (code === 'browser_not_visible' || code === 'browser_not_found') return 'blocked/browser_not_connected';
    if (code === 'page_visibility_unknown') return 'blocked/page_visibility_unknown';
    if (code === 'captcha_requires_manual_action') return 'blocked/captcha_requires_manual_action';
    return 'unknown/state_unavailable';
  }

  function finish(override) {
    const checked = p.probeBrowser === true && browser.connected ? ['quota', 'circuit', 'browser', 'login', 'captcha']
                                                                : ['quota', 'circuit'];
    let canWork = !override;
    let blockedBy = override ? override.blockedBy : null;
    if (!blockedBy) {
      if (captcha === true) { canWork = false; blockedBy = 'blocked/captcha_requires_manual_action'; }
      else if (browser.probed && login !== 'ok' && login !== 'authorized') {
        canWork = false; blockedBy = login === 'unknown' ? 'unknown/login_state_unconfirmed' : 'blocked/not_authorized';
      } else if (!browser.probed) {
        // 没查浏览器就不能声称"能干活"。
        canWork = false; blockedBy = 'unknown/browser_not_probed';
      } else if (quota.remainingHour != null && quota.remainingHour <= 0) {
        canWork = false; blockedBy = 'blocked/local_quota_hourly';
      } else if (quota.remainingDay != null && quota.remainingDay <= 0) {
        canWork = false; blockedBy = 'blocked/local_quota_daily';
      }
    }
    return { ok: true, result: {
      ok: true,
      accountScope,
      canWork,
      blockedBy,
      checked,
      unknowns: unknowns.slice(),
      observation: { active: false, untilMs: null, dailyLimit: null, source: 'absent_in_probe' },
      circuit,
      degradation: { level: 4, reason: 'rule_only_no_llm_tools_enabled', visible: true },
      quota,
      browser,
      login,
      captcha,
      atMs
    } };
  }

  return finish(null);
}

module.exports = { name: 'get_account_health', run };
