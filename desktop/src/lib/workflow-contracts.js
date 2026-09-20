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
