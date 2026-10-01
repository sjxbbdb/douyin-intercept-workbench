'use strict';

const assert = require('node:assert/strict');
const { createWorkflowAdapter } = require('../src/lib/workflow-adapter');
const { requestForWorkflow, planMatchesRequest } = require('../src/lib/workflow-request');
const { platformWorkflowDefinitions } = require('../src/lib/workflow-contracts');

const runFor = (id) => ({ runId: id, workflowId: 'comment.batch' });
const baseParams = {
  url: 'https://www.douyin.com/video/123',
  keywords: ['价格'],
  excludeKeywords: ['广告'],
  publicReply: '谢谢关注',
  privateReply: '请查看详情',
  policyRef: { policyId: 'workflow-policy', policyVersion: 1 },
  maxComments: 10,
  maxSends: 10
};

function target(eventId, text = '价格') {
  return { eventId, authorId: `author-${eventId}`, authorName: `用户-${eventId}`, roomId: baseParams.url, text, publicText: baseParams.publicReply, privateText: baseParams.privateReply };
}

async function executeFive(adapter, run, plan, actionId = 'comment-action-1') {
  await adapter.execute({ run, plan, step: { stepId: 'collect' } });
  await adapter.execute({ run, plan, step: { stepId: 'plan' } });
  const pub = await adapter.execute({ run, plan, step: { stepId: 'reply_public' }, action: { idempotencyKey: actionId } });
  const priv = await adapter.execute({ run, plan, step: { stepId: 'private_message' }, action: { idempotencyKey: actionId } });
  const report = await adapter.execute({ run, plan, step: { stepId: 'report' } });
  return { pub, priv, report };
}

(async () => {
  const definition = platformWorkflowDefinitions().find((item) => item.workflowId === 'comment.batch');
  assert.deepEqual(definition.steps.map((step) => step.stepId), ['collect', 'plan', 'reply_public', 'private_message', 'report']);
  const request = requestForWorkflow({ workflowId: 'comment.batch', params: baseParams });
  assert.equal(request.version, '1');
  assert.equal(planMatchesRequest({ planId: 'p-comment', workflowId: 'comment.batch', version: '1', params: baseParams }, request).ok, true);

  // 公屏 unknown 时，私信阶段不调用侧车。
  {
    const calls = [];
    const browser = {
      commentCollect: async (params) => { calls.push(['collect', params]); return { status: 'ok', events: [{ id: 'e1', text: '价格' }] }; },
      commentPlan: async (params) => { calls.push(['plan', params]); return { status: 'ok', batch: { batchId: 'batch-unknown' }, targets: [target('e1')] }; },
      commentReply: async (params) => { calls.push(['public', params]); return { status: 'ok', results: [{ eventId: 'e1', sendId: params.items[0].sendId, status: 'unknown', reason: 'platform_response_unavailable' }] }; },
      commentPrivate: async () => { calls.push(['private']); return { status: 'ok', results: [] }; },
      commentResult: async ({ batchId }) => ({ batchId })
    };
    const adapter = createWorkflowAdapter({ browser });
    const { pub, priv } = await executeFive(adapter, runFor('comment-unknown'), { params: baseParams });
    assert.equal(pub.status, 'unknown');
    assert.equal(priv.error.code, 'PUBLIC_DELIVERY_NOT_CONFIRMED');
    assert.equal(calls.filter(([kind]) => kind === 'private').length, 0);
  }

  // 部分批次只给本批次已确认的目标发私信，并保留计数。
  {
    const calls = [];
    const browser = {
      commentCollect: async () => ({ status: 'ok', events: [{ id: 'e1', text: '价格' }, { id: 'e2', text: '价格' }] }),
      commentPlan: async () => ({ status: 'ok', batch: { batchId: 'batch-partial' }, targets: [target('e1'), target('e2')] }),
      commentReply: async ({ items }) => { calls.push(['public', items]); return { status: 'ok', results: [
        { eventId: 'e1', sendId: items[0].sendId, status: 'sent_confirmed' },
        { eventId: 'e2', sendId: items[1].sendId, status: 'blocked', reason: 'comment_not_visible' }
      ] }; },
      commentPrivate: async ({ items }) => { calls.push(['private', items]); return { status: 'ok', results: [{ eventId: 'e1', sendId: items[0].sendId, status: 'sent_confirmed' }] }; },
      commentResult: async ({ batchId }) => ({ batchId, checkpoint: { cursor: 'cursor-2', operationId: 'op-report' } })
    };
    const adapter = createWorkflowAdapter({ browser });
    const { pub, priv, report } = await executeFive(adapter, runFor('comment-partial'), { params: baseParams }, 'action-partial');
    assert.equal(pub.status, 'wait_human');
    assert.equal(priv.status, 'completed');
    assert.deepEqual(calls[1][1].map((item) => item.eventId), ['e1']);
    assert.equal(calls[1][1][0].publicSendId, 'action-partial~public~e1');
    assert.equal(report.result.counts.publicConfirmed, 1);
    assert.equal(report.result.counts.publicFailed, 1);
    assert.equal(report.result.counts.privateSent, 1);
  }

  // 恢复只能沿用冻结的计划和原动作 ID；不会重调 plan，也不会突破 maxSends 计数。
  {
    let plans = 0;
    let publicCalls = 0;
    const browser = {
      commentCollect: async () => ({ status: 'ok', events: [{ id: 'e1', text: '价格' }, { id: 'e2', text: '价格' }] }),
      commentPlan: async () => { plans += 1; return { status: 'ok', batch: { batchId: 'batch-resume' }, targets: [target('e1'), target('e2')] }; },
      commentReply: async ({ items }) => { publicCalls += 1; return { status: 'ok', results: [{ eventId: items[0].eventId, sendId: items[0].sendId, status: 'sent_confirmed' }] }; },
      commentPrivate: async () => ({ status: 'ok', results: [] }),
      commentResult: async ({ batchId }) => ({ batchId })
    };
    const adapter = createWorkflowAdapter({ browser });
    const plan = { params: { ...baseParams, maxSends: 1 } };
    const run = runFor('comment-resume');
    await adapter.execute({ run, plan, step: { stepId: 'collect' } });
    await adapter.execute({ run, plan, step: { stepId: 'plan' } });
    const first = await adapter.execute({ run, plan, step: { stepId: 'reply_public' }, action: { idempotencyKey: 'action-resume' } });
    assert.equal(first.status, 'completed');
    const resumedPlan = await adapter.execute({ run, plan, step: { stepId: 'plan' } });
    assert.equal(resumedPlan.status, 'completed');
    assert.equal(plans, 1);
    const changed = await adapter.execute({ run, plan: { params: { ...baseParams, maxSends: 2 } }, step: { stepId: 'reply_public' }, action: { idempotencyKey: 'action-resume' } });
    assert.equal(changed.error.code, 'COMMENT_PLAN_PARAMS_FROZEN');
    const wrongAction = await adapter.execute({ run, plan, step: { stepId: 'reply_public' }, action: { idempotencyKey: 'different-action' } });
    assert.equal(wrongAction.error.code, 'COMMENT_ACTION_ID_MISMATCH');
    assert.equal(publicCalls, 1);
  }

  console.log('PASS comment batch behavior');
})().catch((error) => { console.error('FAIL comment batch behavior'); console.error(error); process.exitCode = 1; });
