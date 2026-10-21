'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const intent = require('../src/intent');
const leads = require('../src/store/leads');
const queryLeads = require('../src/tools/query_leads');
const exportLeads = require('../src/tools/export_leads');
const helpers = require('./helpers');

// 评审项：线索要"能用"—— 使用者必须看得见这条线索在问什么、属于哪一类。
// 但身份仍然只出加盐哈希；投诉必须能被单独拎出来转人工。

const SCOPE = 'testscope000000000000000000000000';
const SEC_UID = 'MS4wLjABAAAAgy1IqwTz0xU2zIAYK9Xu58PXZPpYdQg_IkUoA8EeDxvGjtah-w_foWR4Jj6MPC0S';

function ctxFor(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: SCOPE };
}

function fakeSidecar(cfg) {
  return helpers.writeFakeSidecar(cfg, { accountScope: SCOPE });
}

test('意图只落在闭集里，判不出来就是 unknown', function () {
  const closed = ['price_inquiry', 'feature_question', 'purchase_intent',
                  'after_sales', 'complaint', 'irrelevant', 'unknown'];
  ['多少钱', '骗子', '怎么用', '哈哈', '', '今天天气不错'].forEach(function (text) {
    const out = intent.classify(text, intent.DEFAULT_RULES);
    assert.ok(closed.indexOf(out.intent) !== -1, text + ' -> ' + out.intent);
  });
});

test('投诉优先：同时像咨询又像投诉时，必须判成投诉', function () {
  // complaint 的召回是硬门槛（契约 §11.1 要求 >= 95%），
  // 所以它排在最前，一命中就停，不被后面的规则抢走。
  [
    '这个多少钱？你们就是骗子吧',
    '想买，但是退款太慢了',
    '怎么买？上次买的坏了还不给退',
    '教程挺好看，就是客服态度差'
  ].forEach(function (text) {
    assert.strictEqual(intent.classify(text, intent.DEFAULT_RULES).intent, 'complaint', text);
  });
});

test('判定必须可解释：说得出命中了哪个词', function () {
  const out = intent.classify('请问多少钱一年', intent.DEFAULT_RULES);
  assert.strictEqual(out.intent, 'price_inquiry');
  assert.ok(out.matched.length > 0);
  assert.ok(out.matched.indexOf('多少钱') !== -1);
  assert.strictEqual(out.reasonCode, 'rule_priority');
});

test('纯噪音判 irrelevant，不占用"咨询"这类意图', function () {
  ['哈哈', '哈哈哈', '第一', '路过', '  ', '', '。。。'].forEach(function (text) {
    assert.strictEqual(intent.classify(text, intent.DEFAULT_RULES).intent, 'irrelevant', JSON.stringify(text));
  });
});

test('商家可自配规则；配坏了整体退回默认，绝不带半套规则跑', function () {
  const cfg = helpers.makeConfig();
  const dir = path.join(cfg.agentStateDir, 'accounts', SCOPE);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'intent-rules.json');

  fs.writeFileSync(file, JSON.stringify({ rules: [{ intent: 'price_inquiry', priority: 10, keywords: ['几个钱'] }] }), 'utf8');
  const custom = intent.loadRules(cfg.agentStateDir, SCOPE);
  assert.strictEqual(custom.source, 'intent-rules.json');
  assert.strictEqual(intent.classify('这个几个钱', custom.rules).intent, 'price_inquiry');
  assert.strictEqual(intent.classify('多少钱', custom.rules).intent, 'unknown', '自定义规则应当替换默认规则');

  fs.writeFileSync(file, '{ 不是 json', 'utf8');
  const broken = intent.loadRules(cfg.agentStateDir, SCOPE);
  assert.strictEqual(broken.source, 'builtin_default');
  assert.ok(broken.warning);

  fs.writeFileSync(file, JSON.stringify({ rules: [{ intent: '想买', keywords: ['x'] }] }), 'utf8');
  const badEnum = intent.loadRules(cfg.agentStateDir, SCOPE);
  assert.strictEqual(badEnum.source, 'builtin_default', '闭集外的 intent 必须整体退回默认');
});

test('query_leads 带出正文摘要与意图分布，但仍然不出 sec_uid 与昵称', function () {
  const cfg = fakeSidecar(helpers.makeConfig());
  helpers.writeLeads(cfg, SCOPE, [
    { leadId: 'h1', sourceType: 'comment', intent: 'price_inquiry', textExcerpt: '请问多少钱一年',
      roomId: 'video-1', authorId: SEC_UID, authorName: '某位观众', text: '请问多少钱一年', firstSeenMs: 1, lastSeenMs: 2, state: 'seen' },
    { leadId: 'h2', sourceType: 'comment', intent: 'complaint', textExcerpt: '你们就是骗子',
      roomId: 'video-1', authorId: SEC_UID, firstSeenMs: 1, lastSeenMs: 2, state: 'seen' }
  ]);
  const out = queryLeads.run(ctxFor(cfg), {});
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.total, 2);
  assert.deepStrictEqual(out.result.intentCounts, { price_inquiry: 1, complaint: 1 });
  const serialized = JSON.stringify(out);
  assert.ok(serialized.indexOf(SEC_UID) === -1, 'sec_uid 泄漏了');
  assert.ok(serialized.indexOf('某位观众') === -1, '昵称泄漏了');
  assert.ok(serialized.indexOf('请问多少钱一年') !== -1, '正文摘要应当保留');
});

test('query_leads：可以按正文/房间筛，也可以把投诉排除掉', function () {
  const cfg = fakeSidecar(helpers.makeConfig());
  helpers.writeLeads(cfg, SCOPE, [
    { leadId: 'a', intent: 'price_inquiry', textExcerpt: '多少钱', roomId: 'v1' },
    { leadId: 'b', intent: 'complaint', textExcerpt: '骗子', roomId: 'v1' },
    { leadId: 'c', intent: 'unknown', textExcerpt: '多少钱', roomId: 'v2' }
  ]);
  assert.strictEqual(queryLeads.run(ctxFor(cfg), { keyword: '多少钱' }).result.total, 2);
  assert.strictEqual(queryLeads.run(ctxFor(cfg), { roomId: 'v1' }).result.total, 2);
  const noComplaint = queryLeads.run(ctxFor(cfg), { excludeComplaint: true });
  assert.strictEqual(noComplaint.result.total, 2);
  assert.ok(!noComplaint.result.leads.some(function (l) { return l.intent === 'complaint'; }));
  assert.strictEqual(queryLeads.run(ctxFor(cfg), { keyword: 123 }).code, 'blocked/invalid_input');
});

test('export_leads：导出 CSV，只落在 agent 状态目录的 exports/ 下', function () {
  const cfg = fakeSidecar(helpers.makeConfig());
  helpers.writeLeads(cfg, SCOPE, [
    { leadId: 'a', sourceType: 'comment', intent: 'price_inquiry', textExcerpt: '多少钱, 一年',
      roomId: 'v1', firstSeenMs: 1, lastSeenMs: 2, state: 'seen', authorId: SEC_UID },
    { leadId: 'b', sourceType: 'live', intent: 'complaint', textExcerpt: '=cmd|calc', roomId: 'v1',
      firstSeenMs: 1, lastSeenMs: 2, state: 'seen' }
  ]);
  const out = exportLeads.run(ctxFor(cfg), { format: 'csv' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.rows, 2);
  const exportsDir = path.join(cfg.agentStateDir, 'exports');
  assert.ok(out.result.file.indexOf(exportsDir) === 0, '导出必须落在 exports/ 下');
  const text = fs.readFileSync(out.result.file, 'utf8');
  assert.ok(text.charCodeAt(0) === 0xfeff, 'CSV 应当带 BOM（Excel 打开中文不乱码）');
  assert.ok(text.indexOf('多少钱, 一年') !== -1, '含逗号的单元格要能原样保留');
  assert.ok(text.indexOf("'=cmd|calc") !== -1, '以 = 开头的单元格必须做公式注入防护');
  assert.ok(text.indexOf(SEC_UID) === -1, 'sec_uid 不该出现在导出里');
  assert.strictEqual(exportLeads.run(ctxFor(cfg), { format: 'xml' }).code, 'blocked/invalid_input');
  assert.strictEqual(exportLeads.run(ctxFor(cfg), { limit: 99999 }).code, 'blocked/invalid_input');
});

test('export_leads：JSON 格式带上意图分布', function () {
  const cfg = fakeSidecar(helpers.makeConfig());
  helpers.writeLeads(cfg, SCOPE, [{ leadId: 'a', intent: 'complaint', textExcerpt: '骗子' }]);
  const out = exportLeads.run(ctxFor(cfg), { format: 'json' });
  assert.strictEqual(out.ok, true, out.reason);
  const parsed = JSON.parse(fs.readFileSync(out.result.file, 'utf8'));
  assert.deepStrictEqual(parsed.intentCounts, { complaint: 1 });
  assert.strictEqual(parsed.accountScope, SCOPE);
});
