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

  // 🔴 真机踩过：probe 报告里的 privateCandidates 是【一个数字】（允许进入私信的条数），
  //    不是列表（probe/live_flow.py:759 "privateCandidates": len(allowed)）。
  //    之前把它当列表去 mask，Array.isArray(1)===false -> 变成 []，
  //    于是"两阶段闸门已经放行 1 条"被误报成"一条都没有"。
  //    这种把成功伪装成失败的错，比报错更危险：它会让人去改本来是对的东西。
  const privateCandidateCount = typeof result.privateCandidates === 'number'
    ? result.privateCandidates
    : null;

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
    // 条数来自 probe；被拒的明细是列表，可以逐条看原因。
    privateCandidateCount,
    privateRejected: capture.maskCandidates(ctx, resolved.accountScope, result.privateRejected),
    privatePhaseUnlocked: privateCandidateCount != null && privateCandidateCount > 0,
    candidatesAreSendable: false,
    note: '私信候选是"够条件"，不是"可以发"：本层没有私信工具，私信必须单独审批'
  } };
}

module.exports = { name: 'get_batch_report', run };
