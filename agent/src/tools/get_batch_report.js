'use strict';

const scope = require('../scope');
const capture = require('./_capture');
const { SOURCE_TYPES } = require('../blocked-codes');

// 批次报告（只读，不碰浏览器）。评论批次与直播批次的报告形状一致，用 sourceType 选。
//
// 注意：报告里的"私信候选"是【只读清单】。BP0 没有私信工具，
// 所以它在这里只是"哪些已经够条件了"的答案，不是可以执行的动作。
function run(ctx, params) {
  const p = params || {};
  const batchId = typeof p.batchId === 'string' ? p.batchId.trim() : '';
  if (!batchId) return capture.fail('blocked/invalid_input', 'batchId is required');
  const sourceType = p.sourceType == null ? 'comment' : String(p.sourceType);
  if (SOURCE_TYPES.indexOf(sourceType) === -1) {
    return capture.fail('blocked/invalid_input', 'sourceType must be one of: ' + SOURCE_TYPES.join(', '));
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  const method = sourceType === 'live' ? 'live_result' : 'comment_result';
  // 报告里的 status 是【批次状态】，不是操作结果，所以按 dataStatus 处理。
  const outcome = capture.invoke(ctx, method, { batchId }, { dataStatus: true });
  if (!outcome.ok) return outcome;

  const result = outcome.result || {};
  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    sourceType,
    batchId,
    batchStatus: outcome.status,
    counts: result.counts || null,
    privateCounts: result.privateCounts || null,
    checkpoint: result.checkpoint == null ? null : result.checkpoint,
    queue: result.queue || null,
    limits: result.limits || null,
    privateCandidates: capture.maskCandidates(ctx, resolved.accountScope, result.privateCandidates),
    privateRejected: capture.maskCandidates(ctx, resolved.accountScope, result.privateRejected),
    candidatesAreSendable: false,
    note: 'BP0 只有只读能力：这里给出"哪些够条件"，但没有发私信的工具'
  } };
}

module.exports = { name: 'get_batch_report', run };
