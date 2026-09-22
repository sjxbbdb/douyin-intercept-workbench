'use strict';

// These definitions describe the platform orchestration boundary.  They do
// not claim that a browser adapter is verified or that a send succeeded.  A
// registered adapter must return a structured delivery result for every
// side-effect step; WorkflowRuntime uses that result to gate the next step.

const CONFIRMED_DELIVERY = Object.freeze(['sent_confirmed']);

const PLATFORM_WORKFLOW_CONTRACTS = Object.freeze([
  {
    workflowId: 'video.search',
    version: '1',
    kind: 'video_search',
    steps: [
      { stepId: 'search', action: 'video.search', phase: 'discover', sideEffect: false }
    ]
  },
  {
    workflowId: 'comment.reply_then_private',
    version: '1',
    kind: 'comment_reply_then_private',
    steps: [
      {
        stepId: 'reply_comment',
        action: 'comment.public_reply',
        phase: 'public',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY
      },
      {
        stepId: 'private_message',
        action: 'comment.private_message',
        phase: 'private',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY,
        requiresPrevious: { stepId: 'reply_comment', resultStatuses: CONFIRMED_DELIVERY }
      }
    ]
  },
  {
    // 评论区【批次】固定工作流：采集并筛选评论，逐条公屏回复，确认后再私信。
    // 单条 comment.reply_then_private 保留给兼容旧任务；新任务应使用批次契约。
    workflowId: 'comment.batch',
    version: '1',
    kind: 'comment_batch',
    steps: [
      { stepId: 'plan', action: 'comment.plan', phase: 'plan', sideEffect: false },
      {
        stepId: 'reply_public',
        action: 'comment.public_reply',
        phase: 'public',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY
      },
      {
        stepId: 'private_message',
        action: 'comment.private_message',
        phase: 'private',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY,
        requiresPrevious: { stepId: 'reply_public', resultStatuses: CONFIRMED_DELIVERY }
      },
      { stepId: 'report', action: 'comment.result', phase: 'report', sideEffect: false }
    ]
  },
  {
    workflowId: 'live.reply_then_private',
    version: '1',
    kind: 'live_reply_then_private',
    steps: [
      {
        stepId: 'reply_public',
        action: 'live.public_reply',
        phase: 'public',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY
      },
      {
        stepId: 'private_message',
        action: 'live.private_message',
        phase: 'private',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY,
        requiresPrevious: { stepId: 'reply_public', resultStatuses: CONFIRMED_DELIVERY }
      }
    ]
  },
  {
    // 直播间【批次】固定工作流：显式调用侧车的五个 live_* 方法，而不是走通用单发适配器。
    //
    //   ① live_listen  监听一轮弹幕并入队（去重/时间窗在侧车队列里完成）
    //   ② live_plan    冻结批次计划：关键词过滤、排除词、过期处理、公屏/私信话术、回复通道
    //   ③ live_reply   公屏回复（原生「回复 TA」；平台不返回响应 -> 结果如实保留 unknown）
    //   ④ live_private 私信；逐项绑定"那次已确认成功的公屏回复"，私密账号/面板打不开按跳过处理
    //   ⑤ live_result  批次检查点 + 统一台账（公屏与私信的结果在同一份账上）
    //
    // 为什么单独立一个 contract：原 live.reply_then_private 只按"单个目标 + 通用单发"驱动，
    // 批次语义（关键词过滤/时间窗/去重/过期/检查点/统一台账）根本没有地方表达。
    workflowId: 'live.batch',
    version: '1',
    kind: 'live_batch',
    steps: [
      { stepId: 'listen', action: 'live.listen', phase: 'listen', sideEffect: false },
      { stepId: 'plan', action: 'live.plan', phase: 'plan', sideEffect: false },
      {
        stepId: 'reply_public',
        action: 'live.public_reply',
        phase: 'public',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY
      },
      {
        stepId: 'private_message',
        action: 'live.private_message',
        phase: 'private',
        sideEffect: true,
        resultRequired: true,
        successStatuses: CONFIRMED_DELIVERY,
        requiresPrevious: { stepId: 'reply_public', resultStatuses: CONFIRMED_DELIVERY }
      },
      { stepId: 'report', action: 'live.result', phase: 'report', sideEffect: false }
    ]
  }
]);

function clone(value) { return structuredClone(value); }

function platformWorkflowDefinitions() { return clone(PLATFORM_WORKFLOW_CONTRACTS); }

function workflowContractKey(workflowId, version) { return `${workflowId}@${version}`; }

function findPlatformWorkflow(workflowId, version) {
  return PLATFORM_WORKFLOW_CONTRACTS.find((definition) => definition.workflowId === workflowId && String(definition.version) === String(version)) || null;
}

function deliveryStatus(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const candidate = result.deliveryStatus ?? result.status ?? result.verdict;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

module.exports = {
  CONFIRMED_DELIVERY,
  PLATFORM_WORKFLOW_CONTRACTS,
  platformWorkflowDefinitions,
  workflowContractKey,
  findPlatformWorkflow,
  deliveryStatus
};
