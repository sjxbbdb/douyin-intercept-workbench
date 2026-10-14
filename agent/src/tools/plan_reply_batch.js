'use strict';

const batches = require('../store/batches');
const scope = require('../scope');
const capture = require('./_capture');
const authority = require('../authority-client');

// 建评论批次并【冻结】计划（S4）。
//
// 这一步【不发送任何内容】：它只采集评论、筛出目标、把话术与策略身份冻进计划，
// 并把这一批【落盘】—— 审批阶段要按冻结时的事实来判断，而不是事后再去平台反查。
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
      return capture.fail('blocked/' + String(serverPolicy.reason || 'authorization_unavailable'),
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
      return { ok: true, result: {
        ok: true, accountScope: resolved.accountScope, status: 'empty',
        batchId: null, matched: 0,
        emptyReason: result.reason || 'no_target_matched',
        policyRef: serverPolicy.policyRef,
        note: '这一批没有命中目标；换视频或换关键词，而不是放宽策略'
      } };
    }

    const batch = result.batch || {};
    const batchId = batch.batchId == null ? null : String(batch.batchId);
    const rawTargets = Array.isArray(result.targets) ? result.targets
      : (Array.isArray(batch.targets) ? batch.targets : []);
    const masked = capture.maskEvents(ctx, resolved.accountScope, rawTargets);
    // 落盘：审批阶段据此判断"谁在计划里、话术是什么"。
    const record = {
      batchId,
      accountScope: resolved.accountScope,
      sourceType: 'comment',
      frozenAtMs: Date.now(),
      policyRef: serverPolicy.policyRef,
      policySource: serverPolicy.source,
      replyMode: batch.replyMode == null ? null : String(batch.replyMode),
      replyVia: batch.replyVia == null ? null : String(batch.replyVia),
      blocked: result.blocked || null,
      targets: masked.map(function (event, index) {
        const raw = rawTargets[index] || {};
        return {
          eventId: String(event.id || raw.eventId || ''),
          authorHash: event.authorHash,
          text: String(raw.text || event.text || ''),
          publicText: String(raw.publicText || ''),
          privateText: String(raw.privateText || '')
        };
      })
    };
    let file = null;
    try {
      file = batches.write(ctx.agentStateDir, resolved.accountScope, record);
    } catch (error) {
      return capture.fail('unknown/state_unavailable',
        'cannot persist the frozen batch: ' + (error && error.message ? error.message : String(error)));
    }

    return { ok: true, result: {
      ok: true,
      accountScope: resolved.accountScope,
      status: outcome.status,
      batchId,
      matched: record.targets.length,
      recordFile: file,
      blocked: record.blocked,
      policyRef: serverPolicy.policyRef,
      policySource: serverPolicy.source,
      candidatesAreSendable: false,
      note: '计划已冻结并落盘；用 review_batch 看候选，approve_batch 才可能发送'
    } };
  });
}

module.exports = { name: 'plan_batch', run };
