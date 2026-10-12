'use strict';

const getAccountHealth = require('./tools/get_account_health');
const queryLeads = require('./tools/query_leads');
const getStats = require('./tools/get_stats');
const explainFailure = require('./tools/explain_failure');
const searchVideos = require('./tools/search_videos');
const listVideoPool = require('./tools/list_video_pool');
const collectComments = require('./tools/collect_comments');
const collectLive = require('./tools/collect_live');
const liveListen = require('./tools/live_listen');
const getBatchReport = require('./tools/get_batch_report');
const browserLifecycle = require('./tools/browser_lifecycle');
const exportLeads = require('./tools/export_leads');

// 工具注册表 = Agent 的全部能力边界。
//
// 抗越权靠的是【清单的完备性】，不是提示词：这里没有发送工具，
// 模型就无法把任何内容发出去。任何要把发送能力加进来的改动，
// 都必须先改 docs/agent-tools.md 的契约，而不是先改这个数组。
//
// 三层能力（按"离平台写入有多远"排）：
//   read      —— 只看本地台账/额度/线索，不碰浏览器
//   capture   —— 用浏览器【读】平台内容（搜视频、抓评论、抓直播互动），不写入任何内容
//   lifecycle —— 只管理 sidecar 启动的专用浏览器进程
// 发送层（sending）刻意不存在，见 FORBIDDEN_SIDECAR_METHODS。

const TOOLS = [
  // ---------- read ----------
  {
    name: 'get_account_health',
    tier: 'read',
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
    tier: 'read',
    description: '按意图/地域/时间查线索。只返回加盐哈希标识与计数，绝不返回 sec_uid、昵称、原文。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        region: { type: 'string' },
        sinceMs: { type: 'number' },
        untilMs: { type: 'number' },
        keyword: { type: 'string', description: '按正文摘要做子串筛选' },
        roomId: { type: 'string', description: '只看某条视频/某个直播间来的线索' },
        excludeComplaint: { type: 'boolean', description: 'true 时排除投诉（投诉一律转人工）' },
        limit: { type: 'number', description: '<= 200；超出即拒，调用方不可扩大上限' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: queryLeads
  },
  {
    name: 'export_leads',
    tier: 'read',
    description: '把线索导出成 CSV/JSON（只落在 agent 状态目录的 exports/ 下）。身份仍是加盐哈希。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['csv', 'json'] },
        intent: { type: 'string' },
        region: { type: 'string' },
        keyword: { type: 'string' },
        roomId: { type: 'string' },
        excludeComplaint: { type: 'boolean' },
        sinceMs: { type: 'number' },
        untilMs: { type: 'number' },
        limit: { type: 'number', description: '1..5000' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: exportLeads
  },
  {
    name: 'get_stats',
    tier: 'read',
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
    tier: 'read',
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
  },

  // ---------- capture ----------
  {
    name: 'search_videos',
    tier: 'capture',
    description: '按关键词搜视频（分页、带相关度与发布时间区间）。只发现与筛选，不回复也不私信。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '必填；最长 120 字' },
        maxVideos: { type: 'number', description: '1..200' },
        scrollRounds: { type: 'number', description: '0..40' },
        cursor: { type: 'string', description: '上一次返回的游标，用于翻页' },
        dateFrom: { type: 'string', description: 'YYYY-MM 或 YYYY-MM-DD' },
        dateTo: { type: 'string' },
        minRelevance: { type: 'number', description: '0..100' }
      },
      required: ['keyword'],
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: false, validation: 'real_device_capture_only' },
    handler: searchVideos
  },
  {
    name: 'list_video_pool',
    tier: 'capture',
    description: '读取已抓到的候选视频（本地池子，不碰浏览器）。给出的 videoId 可直接交给 collect_comments。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        minRelevance: { type: 'number' },
        limit: { type: 'number', description: '1..1000' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: listVideoPool
  },
  {
    name: 'collect_comments',
    tier: 'capture',
    description: '抓一条视频的评论区并按关键词/排除词/去重给出目标批次。只采集：不回复、不私信。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频地址；与 videoId 二选一' },
        videoId: { type: 'string', description: '搜索池里的 videoId；与 url 二选一' },
        commentKeywords: { type: 'string', description: '目标评论关键词（空格分隔）' },
        excludeKeywords: { type: 'string' },
        matchMode: { type: 'string', enum: ['seg', 'full'] },
        minDigg: { type: 'number' },
        maxTargets: { type: 'number', description: '1..500' },
        dedupeAuthors: { type: 'boolean' },
        maxItems: { type: 'number', description: '1..500' },
        scrollRounds: { type: 'number', description: '0..40' }
      },
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: false, validation: 'real_device_capture_only' },
    handler: collectComments
  },
  {
    name: 'collect_live',
    tier: 'capture',
    description: '抓一个直播间的可见互动（一次）。只看不入队。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '必填；https://live.douyin.com/...' },
        maxItems: { type: 'number', description: '1..500' }
      },
      required: ['url'],
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: false, validation: 'real_device_capture_only' },
    handler: collectLive
  },
  {
    name: 'live_listen',
    tier: 'capture',
    description: '直播间监听一轮：采集可见互动并并入队列（按房间/作者/正文去重）。可重复调用。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxItems: { type: 'number', description: '1..500' }
      },
      required: ['url'],
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: false, validation: 'real_device_capture_only' },
    handler: liveListen
  },
  {
    name: 'get_batch_report',
    tier: 'capture',
    description: '批次报告（只读）：逐条状态、检查点、以及"哪些已经够条件"的私信候选清单。',
    inputSchema: {
      type: 'object',
      properties: {
        batchId: { type: 'string' },
        sourceType: { type: 'string', enum: ['comment', 'live'] }
      },
      required: ['batchId'],
      additionalProperties: false
    },
    declaration: { implemented: true, autoEligible: true, validation: 'offline_unit_tests' },
    handler: getBatchReport
  },

  // ---------- lifecycle ----------
  {
    name: 'start_browser',
    tier: 'lifecycle',
    description: '启动（或连接）sidecar 持有的专用 Chrome。采集类工具的前提。不登录、不发送。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    declaration: { implemented: true, autoEligible: false, validation: 'real_device_lifecycle' },
    handler: { run: browserLifecycle.startRun }
  },
  {
    name: 'close_browser',
    tier: 'lifecycle',
    description: '关闭 sidecar 持有的专用 Chrome（不影响你自己的其他浏览器窗口）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    declaration: { implemented: true, autoEligible: false, validation: 'real_device_lifecycle' },
    handler: { run: browserLifecycle.closeRun }
  }
];

// 名字里出现这些词 = 执行能力泄漏，注册表直接判定为越权。
//
// 注意：这里【不】禁止 capture / lifecycle 这类词 —— 搜索、采集、开关浏览器
// 都不写入平台内容，是这几项功能的本体。禁止的是真正能"发出去"或
// "像人一样操作"的能力：发送、点击、输入、滚动、求值、急停、改策略。
const FORBIDDEN_NAME_PATTERNS = [
  /send/i, /click/i, /type/i, /scroll_/i, /evaluate/i, /cdp/i,
  /emergency/i, /^set_/i, /configure/i, /policy_write/i, /reply/i, /private_message/i
];

// 允许调用的 sidecar 方法。分三层，任何一层之外的方法都不许出现在工具层。
const READ_SIDECAR_METHODS = ['capabilities', 'doctor', 'search_pool', 'comment_result', 'live_result'];
const CAPTURE_SIDECAR_METHODS = ['search', 'collect_comments', 'collect_live', 'live_listen'];
const LIFECYCLE_SIDECAR_METHODS = ['launch', 'close'];
const ALLOWED_SIDECAR_METHODS = READ_SIDECAR_METHODS
  .concat(CAPTURE_SIDECAR_METHODS)
  .concat(LIFECYCLE_SIDECAR_METHODS);

// 明确禁止出现在工具源码里的 sidecar 方法：写入平台内容，或与发送批次有关。
// open 也在其中 —— 任意跳转不是任何一项功能需要的，暴露它只是白白扩大攻击面。
const FORBIDDEN_SIDECAR_METHODS = [
  'open', 'comment_plan', 'comment_reply', 'comment_private',
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
      declaration: Object.assign({ tier: tool.tier }, tool.declaration)
    };
  });
}

function find(name) {
  return TOOLS.find(function (tool) { return tool.name === name; }) || null;
}

function countByTier() {
  return TOOLS.reduce(function (acc, tool) {
    acc[tool.tier] = (acc[tool.tier] || 0) + 1;
    return acc;
  }, {});
}

module.exports = {
  TOOLS,
  FORBIDDEN_NAME_PATTERNS,
  READ_SIDECAR_METHODS,
  CAPTURE_SIDECAR_METHODS,
  LIFECYCLE_SIDECAR_METHODS,
  ALLOWED_SIDECAR_METHODS,
  FORBIDDEN_SIDECAR_METHODS,
  forbiddenTools,
  listTools,
  find,
  countByTier,
  count: function () { return TOOLS.length; }
};
