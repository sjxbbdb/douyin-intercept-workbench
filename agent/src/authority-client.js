'use strict';

// 服务端权威（甲）的客户端：向授权服务要策略与放行。
//
// 🔴 本模块的每一条失败路径都是 fail-closed：
//    连不上 / 超时 / 非 200 / 返回畸形 —— 一律 available=false，
//    调用方必须【拒发】，绝不允许退回本地默认上限继续干活。
//    这就是 fail-closed：出故障时默认结果是"不放行"。

const DEFAULT_TIMEOUT_MS = 8000;

function unavailable(reason, detail) {
  return { available: false, reason, detail: detail || null };
}

function configured(config) {
  return Boolean(config && config.authorityUrl);
}

// 读取本账号当前生效的策略。返回 { available, policyRef, limits, observation, source }
async function policy(ctx, options) {
  const cfg = ctx.config || {};
  if (!configured(cfg)) {
    // 没有配置授权服务：这是"还没接"的状态，如实标注，不冒充服务端策略。
    return { available: false, reason: 'authorization_not_configured',
             detail: 'no --authority-url was provided', configured: false };
  }
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const scope = ctx.accountScope ? '?accountScope=' + encodeURIComponent(String(ctx.accountScope)) : '';
  const url = String(cfg.authorityUrl).replace(/\/+$/, '') + '/v1/policy/sending' + scope;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + String(cfg.authorityToken || '')
      },
      signal: controller.signal
    });
    if (response.status === 401) return { available: false, reason: 'authorization_not_authenticated', configured: true };
    if (!response.ok) return { available: false, reason: 'authorization_unavailable', detail: 'HTTP ' + response.status, configured: true };
    const body = await response.json();
    const policyRef = body && body.policyRef;
    const limits = body && body.limits;
    if (!policyRef || typeof policyRef.policyId !== 'string' || !Number.isSafeInteger(policyRef.policyVersion)) {
      // 形状不对等于没拿到 —— 不猜。
      return { available: false, reason: 'authorization_unavailable', detail: 'malformed policyRef', configured: true };
    }
    return {
      available: true,
      configured: true,
      source: body.source || 'server_settings',
      policyRef: { policyId: policyRef.policyId, policyVersion: policyRef.policyVersion },
      limits: limits || {},
      observation: body.observation || null,
      circuit: body.circuit || null,
      allowedPublicStates: Array.isArray(body.allowedPublicStates) ? body.allowedPublicStates : null,
      serverTimeMs: body.serverTimeMs == null ? null : Number(body.serverTimeMs)
    };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return { available: false, reason: 'authorization_unavailable',
             detail: aborted ? 'timeout after ' + timeoutMs + 'ms' : String(error && error.message ? error.message : error),
             configured: true };
  } finally {
    clearTimeout(timer);
  }
}

// 申请一次发送授权。与 policy() 同样的 fail-closed 纪律。
async function requestAuthorization(ctx, input, options) {
  const cfg = ctx.config || {};
  if (!configured(cfg)) {
    return { granted: false, reason: 'authorization_not_configured', configured: false };
  }
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const url = String(cfg.authorityUrl).replace(/\/+$/, '') + '/v1/send-authorizations';
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + String(cfg.authorityToken || '')
      },
      body: JSON.stringify({
        accountScope: ctx.accountScope,
        sendId: input.sendId,
        kind: input.kind,
        phase: input.phase,
        targetKey: input.targetKey,
        publicSendId: input.publicSendId == null ? null : input.publicSendId
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(function () { return {}; });
    if (body && body.status === 'granted') {
      return { granted: true, authorizationId: body.authorizationId, expiresAtMs: body.expiresAtMs,
               policyRef: body.policyRef || null, remaining: body.remaining || null, idempotent: Boolean(body.idempotent) };
    }
    return { granted: false, reason: String((body && body.reason) || 'authorization_unavailable'),
             detail: (body && body.detail) || null, configured: true };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return { granted: false, reason: 'authorization_unavailable',
             detail: aborted ? 'timeout after ' + timeoutMs + 'ms' : String(error && error.message ? error.message : error),
             configured: true };
  } finally {
    clearTimeout(timer);
  }
}

// 了结一次授权：把【真实结果】报回服务端。
//
// 🔴 这一步不是可选的：服务端只有见过某次公屏被 commit 成 sent_confirmed，
//    才会在私信授权时认这个 publicSendId。不 commit，私信永远拿不到授权。
//    state 必须是终态；上报的值要来自台账（页面回显不算）。
async function commitAuthorization(ctx, authorizationId, outcome, options) {
  const cfg = ctx.config || {};
  if (!configured(cfg)) return { ok: false, reason: 'authorization_not_configured', configured: false };
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const url = String(cfg.authorityUrl).replace(/\/+$/, '') +
    '/v1/send-authorizations/' + encodeURIComponent(String(authorizationId)) + '/commit';
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + String(cfg.authorityToken || '') },
      body: JSON.stringify({ state: outcome.state, reason: outcome.reason == null ? null : outcome.reason }),
      signal: controller.signal
    });
    const body = await response.json().catch(function () { return {}; });
    if (response.ok && body.ok !== false) return { ok: true, state: body.state || outcome.state, idempotent: Boolean(body.idempotent) };
    return { ok: false, reason: String((body && body.reason) || 'commit_failed') };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { policy, requestAuthorization, commitAuthorization, configured, DEFAULT_TIMEOUT_MS };
