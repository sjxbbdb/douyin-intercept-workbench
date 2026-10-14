'use strict';

const batches = require('../store/batches');
const leads = require('../store/leads');
const scope = require('../scope');
const capture = require('./_capture');
const authority = require('../authority-client');

// 审批前的一步：把【冻结好的批次】读成候选清单。只读，不发送。
//
// 候选来自冻结那一刻的事实（plan_batch 落盘的记录），不是事后再去平台反查。
//
// 代码预筛（不是提示词）：
//   · 投诉（intent=complaint）一律不进候选 —— 必须转人工，
//     不能让 Agent 一个 reject 就把它糊过去；
//   · 无关（irrelevant）同样排除。
// 意图来自线索库，靠【同一套加盐哈希】与批次候选对上。
//
// fail-closed：拿不到服务端策略就不返回候选 —— 一个"没有服务端约束"的
// 候选清单不该被送进任何审批流程。

function run(ctx, params) {
  const p = params || {};
  const batchId = typeof p.batchId === 'string' ? p.batchId.trim() : '';
  if (!batchId) return capture.fail('blocked/invalid_input', 'batchId is required');
  const maxItems = p.maxItems == null ? 20 : Number(p.maxItems);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) {
    return capture.fail('blocked/invalid_input', 'maxItems must be an integer between 1 and 100');
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  return authority.policy(ctx).then(function (serverPolicy) {
    if (!serverPolicy.available) {
      return capture.fail('blocked/' + String(serverPolicy.reason || 'authorization_unavailable'),
        'cannot review a batch without a server-issued policy: ' + String(serverPolicy.detail || serverPolicy.reason));
    }
    const loaded = batches.read(ctx.agentStateDir, resolved.accountScope, batchId);
    if (!loaded.ok) return loaded;
    if (!loaded.record) {
      return capture.fail('blocked/unknown_batch',
        'this batch has no frozen record in the agent state dir; run plan_batch first');
    }
    const record = loaded.record;

    // 意图：与线索库用同一套加盐哈希，所以能对上。
    const leadRows = leads.readAll(ctx.agentStateDir, resolved.accountScope);
    const intentByHash = new Map();
    if (leadRows.ok) {
      leadRows.leads.forEach(function (lead) {
        if (lead.leadId) intentByHash.set(String(lead.leadId), String(lead.intent || 'unknown'));
      });
    }

    const items = [];
    const excluded = [];
    (record.targets || []).forEach(function (target) {
      const intent = intentByHash.get(String(target.authorHash)) || 'unknown';
      if (intent === 'complaint' || intent === 'irrelevant') {
        excluded.push({
          eventId: target.eventId,
          intent,
          reason: intent === 'complaint' ? 'complaint_requires_human' : 'irrelevant'
        });
        return;
      }
      items.push({
        eventId: target.eventId,
        // sendId 是确定性的：同一批同一条反复 review 得到同一个值，
        // 重放不会变成第二次发送。
        sendId: batches.sendIdFor(batchId, target.eventId),
        authorHash: target.authorHash,
        intent,
        text: target.text,
        publicText: target.publicText,
        // 私信话术在公屏确认之前不给出去：两阶段不是一个建议，是硬契约。
        publicSendId: null,
        phase: 'public'
      });
    });

    return { ok: true, result: {
      ok: true,
      accountScope: resolved.accountScope,
      batchId,
      policyRef: record.policyRef || serverPolicy.policyRef,
      policySource: record.policySource || serverPolicy.source,
      replyMode: record.replyMode == null ? null : record.replyMode,
      items: items.slice(0, maxItems),
      truncated: items.length > maxItems,
      excludedByCode: excluded,
      blockedAtPlanTime: record.blocked || null,
      counts: { planned: (record.targets || []).length, reviewable: items.length,
                excludedByCode: excluded.length },
      note: '候选只代表"可以审批"；真正发不发由 approve_batch 逐条向服务端申请授权决定'
    } };
  });
}

module.exports = { name: 'review_batch', run };
