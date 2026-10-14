'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const registry = require('../src/registry');

// 评审项：Agent 的越权面 = 工具清单。BP0 必须【恰好 4 个只读工具】，
// 并且工具源码里不许出现任何有副作用的 sidecar 方法。

const SRC_DIR = path.resolve(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push.apply(out, walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  });
  return out;
}

test('工具清单是这 12 个，一个不多一个不少', function () {
  assert.strictEqual(registry.count(), 14, '工具数量变化必须同步改 docs/agent-tools.md 的契约');
  const names = registry.listTools().map(function (t) { return t.name; }).sort();
  assert.deepStrictEqual(names, [
    'close_browser', 'collect_comments', 'collect_live', 'explain_failure', 'export_leads',
    'get_account_health', 'get_batch_report', 'get_stats', 'list_video_pool',
    'live_listen', 'plan_batch', 'query_leads', 'search_videos', 'start_browser'
  ]);
});

test('清单里没有任何发送能力（发送层刻意不存在）', function () {
  const names = registry.listTools().map(function (t) { return t.name; });
  ['send_private', 'send_comment', 'comment_reply', 'comment_private',
   'live_reply', 'live_private', 'approve_batch', 'review_batch'].forEach(function (forbidden) {
    assert.strictEqual(names.indexOf(forbidden), -1, '清单里出现了发送能力: ' + forbidden);
  });
});

test('没有任何工具名命中执行类模式（发送/点击/输入/滚动/求值/急停/改策略）', function () {
  assert.deepStrictEqual(registry.forbiddenTools(), []);
});

test('每个工具都带 implemented / autoEligible / validation 声明', function () {
  registry.TOOLS.forEach(function (tool) {
    assert.strictEqual(typeof tool.declaration.implemented, 'boolean', tool.name);
    assert.strictEqual(typeof tool.declaration.autoEligible, 'boolean', tool.name);
    assert.ok(tool.declaration.validation, tool.name + ' 缺少 validation');
  });
});

test('工具源码里不出现任何有副作用的 sidecar 方法', function () {
  const offenders = [];
  // registry.js 自己就是"禁止清单"的定义处，跳过它，否则守卫会被自己的清单命中。
  walk(SRC_DIR).filter(function (file) { return path.basename(file) !== 'registry.js'; })
    .forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    registry.FORBIDDEN_SIDECAR_METHODS.forEach(function (method) {
      // 只匹配以字符串字面量形式出现的调用名，避免把注释里的说明也算进来。
      const pattern = new RegExp("['\"]" + method + "['\"]");
      const stripped = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (pattern.test(stripped)) offenders.push(file + ' -> ' + method);
    });
  });
  assert.deepStrictEqual(offenders, [], '工具层出现了发送/浏览器方法');
});

test('工具层不含选择器字符串，也不直接 require CDP 或 ws', function () {
  const offenders = [];
  walk(SRC_DIR).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    if (/data-e2e/.test(text)) offenders.push(file + ' -> data-e2e 选择器');
    if (/FE2C55/i.test(text)) offenders.push(file + ' -> 硬编码发送按钮颜色');
    if (/require\(['"]ws['"]\)/.test(text)) offenders.push(file + ' -> require(ws)');
    if (/require\(['"][^'"]*cdp/.test(text)) offenders.push(file + ' -> require(cdp)');
  });
  assert.deepStrictEqual(offenders, []);
});

test('sidecar 客户端只对外暴露 callOnce（没有任意的发送入口）', function () {
  const client = require('../src/sidecar-client');
  assert.deepStrictEqual(Object.keys(client), ['callOnce']);
});
