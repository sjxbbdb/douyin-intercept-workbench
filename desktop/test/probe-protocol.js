'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ProbeError, ProbeClient, validateParams } = require('../src/lib/probe-client');
const { ProbeBridge } = require('../src/lib/probe-bridge');

const livePlan = validateParams('live_plan', {
  maxItems: 2, windowSeconds: 60, replyMode: 'danmaku', keywords: ['价格'],
  replyVia: 'native',
  scripts: { 'event-1': { publicText: '回复', privateText: '联系' } },
});
assert.equal(livePlan.replyMode, 'danmaku');
assert.equal(livePlan.replyVia, 'native');
assert.deepEqual(validateParams('live_reply', { batchId: 'batch-1', mode: 'danmaku', items: [{ eventId: 'event-1', sendId: 'send-1', text: '@用户 回复' }] }).items.length, 1);
assert.equal(validateParams('live_private', { batchId: 'batch-1', items: [{ eventId: 'event-1', sendId: 'send-2', publicSendId: 'public-1' }] }).items[0].publicSendId, 'public-1');
assert.equal(validateParams('send_private', { sendId: 'send-2', publicSendId: 'public-1', target: { authorId: 'author-1' }, text: '你好' }).publicSendId, 'public-1');
assert.equal(validateParams('search_pool', { keyword: '婚礼', limit: 10, minRelevance: 40 }).limit, 10);
const commentCollect = validateParams('collect_comments', { videoId: 'video-1', commentKeywords: ['价格'], excludeKeywords: ['投诉'], matchMode: 'seg', minDigg: 2, maxTargets: 5, dedupeAuthors: true });
assert.equal(commentCollect.videoId, 'video-1');
assert.deepEqual(commentCollect.commentKeywords, ['价格']);
const commentPlan = validateParams('comment_plan', { videoId: 'video-1', commentKeywords: ['价格'], maxItems: 2, publicText: '公屏回复', privateText: '私信回复' });
assert.equal(commentPlan.videoId, 'video-1');
assert.equal(commentPlan.publicText, '公屏回复');
assert.equal(validateParams('comment_private', { batchId: 'batch-1', items: [{ eventId: 'event-1', sendId: 'send-2', publicSendId: 'public-1' }] }).items[0].publicSendId, 'public-1');
assert.throws(() => validateParams('live_plan', { policy: { allowPublicStates: ['unknown'] } }), (error) => error instanceof ProbeError && error.code === 'SIDECAR_POLICY_NOT_SERVER_ISSUED');
assert.throws(() => validateParams('live_reply', { batchId: 'batch-1', items: [{ eventId: 'event-1', sendId: 'send-1', dangerous: 'x' }] }), /不受支持/);
assert.throws(() => validateParams('live_listen', { url: 'https://www.douyin.com/video/1' }), /live\.douyin\.com/);
assert.throws(() => validateParams('comment_private_candidates', { items: [{ eventId: 'event-1', publicSendId: 'public/1' }] }), /参数无效/);

(async () => {
  const bridge = new ProbeBridge({ accountDir: mkdtempSync(join(tmpdir(), 'probe-protocol-')), port: 19331 });
  bridge.source = 'live';
  bridge.client.request = async () => ({ capability: {
    private_reply: { implemented: true, autoEligible: true, validation: { delivery: 'unknown' } },
    live_reply: { implemented: true, autoEligible: true, validation: { delivery: 'platform_response_confirmed' } },
  } });
  await bridge.probe();
  assert.equal(bridge.canSend('private'), false, 'unknown delivery must remain fail-closed');
  assert.equal(bridge.canSend('live'), true, 'explicit platform response confirmation may qualify');
  const calls = [];
  bridge.client.request = async (method, params) => { calls.push({ method, params }); return { status: 'ok' }; };
  await bridge.commentPrivateCandidates([{ eventId: 'event-1', authorId: 'author-1', publicSendId: 'public-1' }]);
  await bridge.searchPool({ keyword: '婚礼', limit: 5 });
  await bridge.commentPlan({ videoId: 'video-1', commentKeywords: ['价格'], publicText: '公屏回复', privateText: '私信回复' });
  await bridge.commentReply({ batchId: 'batch-1', items: [{ eventId: 'event-1', sendId: 'send-1', text: '公屏回复' }] });
  await bridge.commentPrivate({ batchId: 'batch-1', items: [{ eventId: 'event-1', sendId: 'send-2', publicSendId: 'public-1', text: '私信回复' }] });
  await bridge.commentResult({ batchId: 'batch-1' });
  await bridge.livePlan({ maxItems: 1, replyVia: 'native' });
  await bridge.livePrivate({ batchId: 'batch-1', items: [{ eventId: 'event-1', sendId: 'send-2', publicSendId: 'public-1' }] });
  await bridge.liveResult({ batchId: 'batch-1' });
  assert.deepEqual(calls.map((call) => call.method), ['comment_private_candidates', 'search_pool', 'launch', 'comment_plan', 'comment_reply', 'comment_private', 'comment_result', 'live_plan', 'live_private', 'live_result']);
  assert.equal(calls[3].params.videoId, 'video-1');
  assert.equal(calls[7].params.replyVia, 'native');
  assert.equal(calls[8].params.items[0].publicSendId, 'public-1');
  console.log('Probe protocol PASS (PR#12 validation and capability gate)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
