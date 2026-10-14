'use strict';

const scope = require('../scope');
const capture = require('./_capture');
const authority = require('../authority-client');

// 建评论批次并【冻结】计划（S4）。
//
// 这一步【不发送任何内容】：它只采集评论、筛出目标、把话术与策略身份冻进计划。
// 但它是"发送"的前置，所以它必须带上服务端签发的策略身份 ——
// probe 的 _require_policy 会记住这个身份，之后任何一次执行都必须带回来且一致
// （缺失 policy_ref_missing、不一致 policy_ref_mismatch）。
//
// 🔴 只传【身份】，绝不传策略内容：probe 见到调用方自带策略内容会直接
//    policy_not_server_issued 拒绝。上限的权威在服务端，不在这个请求里。
//
// 🔴 fail-closed：拿不到服务端策略就不建批次 —— 否则会冻结出一个
//    "没有任何服务端策略约束"的计划，那是最坏的情况。

function run(ctx, params) {
  const p = params || {};
  const hasUrl = typeof p.url === 'string' && p.url.trim();
  const hasVideoId = typeof p.videoId === 'string' && p.videoId.trim();
  if (!hasUrl && !hasVideoId) {
    return capture.fail('blocked/invalid_input', 'one of url / videoId is required');
  }
  if (hasUrl && hasVideoId) {
    return capture.fail('blocked/invalid_input', 'give either url or videoId, not both');
  }
  for (const key of ['publicText', 'privateText']) {
    if (typeof p[key] !== 'string' || !p[key].trim()) {
      return capture.fail('blocked/invalid_input', key + ' is required');
    }
  }
  if (p.maxItems != null && (!Number.isInteger(p.maxItems) || p.maxItems < 1)) {
    return capture.fail('blocked/invalid_input', 'maxItems must be a positive integer');
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  return authority.policy(ctx).then(function (serverPolicy) {
    if (!serverPolicy.available) {
      // 拿不到服务端策略就不建批次。绝不用本地默认值凑一个计划出来。
      return capture.fail('blocked/' + (serverPolicy.reason || 'authorization_unavailable'),
        'cannot plan a batch without a server-issued policy: ' + String(serverPolicy.detail || serverPolicy.reason));
    }
    const sent = {
      // 策略【身份】原样回传；不是策略内容。
      policyRef: { policyId: serverPolicy.policyRef.policyId, policyVersion: serverPolicy.policyRef.policyVersion }
    };
    ['url', 'videoId', 'publicText', 'privateText', 'maxItems', 'windowSeconds',
     'scrollRounds', 'collectMaxItems', 'minDigg', 'matchMode', 'commentKeywords'].forEach(function (key) {
      if (p[key] != null) sent[key] = p[key];
    });

    const outcome = capture.invoke(ctx, 'comment_plan', sent);
    if (!outcome.ok) return outcome;

    const result = outcome.result || {};
    if (result.status === 'empty' || result.empty) {
      // 采不到命中目标就不建批次 —— 这是 probe 的既有语义，照实返回。
      return { ok: true, result: {
        ok: true, accountScope: resolved.accountScope, status: 'empty',
        batchId: null, matched: 0,
        emptyReason: result.reason || 'no_target_matched',
        policyRef: serverPolicy.policyRef,
        note: '这一批没有命中目标；换视频或换关键词，而不是放宽策略'
      } };
    }
    const batch = result.batch || {};
    const targets = capture.maskEvents(ctx, resolved.accountScope, result.targets || batch.targets);
    return { ok: true, result: {
      ok: true,
      accountScope: resolved.accountScope,
      status: outcome.status,
      batchId: batch.batchId == null ? null : String(batch.batchId),
      matched: targets.length,
      candidates: targets,
      blocked: result.blocked || null,
      filter: result.filter || null,
      // 冻结进计划的策略身份：之后执行必须带回来，probe 会校验。
      policyRef: serverPolicy.policyRef,
      policySource: serverPolicy.source,
      candidatesAreSendable: false,
      note: '计划已冻结，但这一层没有任何发送工具；执行阶段由审批层负责'
    } };
  });
}

// 名字里刻意【不含 reply】—— 注册表的名字守卫会把 "reply" 判成执行能力泄漏。
// 这个工具只冻结计划，不回复。
module.exports = { name: 'plan_batch', run };
