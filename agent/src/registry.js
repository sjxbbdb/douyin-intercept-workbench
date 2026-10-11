'use strict';

const getAccountHealth = require('./tools/get_account_health');
const queryLeads = require('./tools/query_leads');
const getStats = require('./tools/get_stats');
const explainFailure = require('./tools/explain_failure');

// 工具注册表 = Agent 的全部能力边界。
//
// 抗越权靠的是【清单的完备性】，不是提示词：这里没有 click / type / evaluate /
// send / approve / 改策略 / 急停，模型就无法越权。任何要把发送能力加进来的改动，
// 都必须先改 docs/agent-tools.md 的契约，而不是先改这个数组。

// 声明字段沿用 probe capabilities 的既有约定。
const TOOLS = [
  {
    name: 'get_account_health',
    description: '能否干活的唯一依据：额度、熔断迹象、浏览器与登录状态。未显式探查浏览器时 canWork 一律 false。',
    inputSchema: {
      type: 'object',
      properties: {
        platformAccountId: { type: 'string' },
        atMs: { type: 'number' },
        probeBrowser: { type: 'boolean', description: 'true 时才连接浏览器（需要已启动且归属正确的 Chrome）' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: getAccountHealth
  },
  {
    name: 'query_leads',
    description: '按意图/地域/时间查线索。只返回加盐哈希标识与计数，绝不返回 sec_uid、昵称、原文。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        region: { type: 'string' },
        sinceMs: { type: 'number' },
        untilMs: { type: 'number' },
        limit: { type: 'number', description: '<= 200；超出即拒，调用方不可扩大上限' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: queryLeads
  },
  {
    name: 'get_stats',
    description: '台账统计。sent_confirmed 取落库原始状态；页面回显单独一列且永不并入成功。',
    inputSchema: {
      type: 'object',
      properties: {
        fromMs: { type: 'number' },
        toMs: { type: 'number' },
        groupBy: { type: 'string', enum: ['day', 'source_type', 'intent'] }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: getStats
  },
  {
    name: 'explain_failure',
    description: '归因：给 sendId / batchId / eventId。unknown 一律 nextAction=none（未知不得自动重试）。',
    inputSchema: {
      type: 'object',
      properties: {
        sendId: { type: 'string' },
        batchId: { type: 'string' },
        eventId: { type: 'string' },
        itemId: { type: 'string' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: explainFailure
  }
];

// 名字里出现这些词 = 执行能力泄漏，注册表直接判定为越权。
//
// 注意：这里【不】禁止 approve / review / draft / analyze 这类词 ——
// 它们是契约里明确存在的审批与推理工具（BP1/BP2/BP4），禁止的是
// 真正能碰浏览器的动作（发送/点击/输入/滚动/求值/急停/改策略）。
const FORBIDDEN_NAME_PATTERNS = [
  /send/i, /click/i, /type/i, /scroll/i, /evaluate/i, /cdp/i, /browser_/i,
  /emergency/i, /^set_/i, /configure/i, /policy_write/i
];

// BP0 允许调用的 sidecar 方法（只读）。工具源码里出现其余方法即视为越界，
// 由 test/registry.test.js 静态断言。
const ALLOWED_SIDECAR_METHODS = ['capabilities', 'doctor'];

// 明确禁止出现在工具源码里的 sidecar 方法（有副作用或会碰浏览器）。
const FORBIDDEN_SIDECAR_METHODS = [
  'launch', 'open', 'close', 'search', 'collect_comments', 'collect_live',
  'live_listen', 'comment_plan', 'comment_reply', 'comment_private',
  'live_plan', 'live_reply', 'live_private', 'send_private', 'send_comment'
];

function forbiddenTools() {
  return TOOLS.filter(function (tool) {
    return FORBIDDEN_NAME_PATTERNS.some(function (re) { return re.test(tool.name); });
  }).map(function (tool) { return tool.name; });
}

function listTools() {
  return TOOLS.map(function (tool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      declaration: tool.declaration
    };
  });
}

function find(name) {
  return TOOLS.find(function (tool) { return tool.name === name; }) || null;
}

module.exports = {
  TOOLS,
  FORBIDDEN_NAME_PATTERNS,
  ALLOWED_SIDECAR_METHODS,
  FORBIDDEN_SIDECAR_METHODS,
  forbiddenTools,
  listTools,
  find,
  count: function () { return TOOLS.length; }
};
