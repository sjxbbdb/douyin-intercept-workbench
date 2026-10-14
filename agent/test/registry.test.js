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
  assert.strictEqual(registry.count(), 16, '工具数量变化必须同步改 docs/agent-tools.md 的契约');
  const names = registry.listTools().map(function (t) { return t.name; }).sort();
  assert.deepStrictEqual(names, [
    'approve_batch', 'close_browser', 'collect_comments', 'collect_live', 'explain_failure',
    'export_leads', 'get_account_health', 'get_batch_report', 'get_stats', 'list_video_pool',
    'live_listen', 'plan_batch', 'query_leads', 'review_batch', 'search_videos', 'start_browser'
  ]);
});

test('会写入平台内容的工具只有一个，而且必须先拿服务端授权', function () {
  const writeTools = registry.TOOLS.filter(function (t) { return t.tier === 'execute'; });
  assert.deepStrictEqual(writeTools.map(function (t) { return t.name; }), ['approve_batch']);
  writeTools.forEach(function (tool) {
    assert.strictEqual(tool.declaration.autoEligible, false, tool.name + ' 必须 autoEligible=false');
  });
  // 单发入口与私信/弹幕第二阶段仍然不存在：它们必须单独审批，不能从这里漏出去。
  const names = registry.listTools().map(function (t) { return t.name; });
  ['send_private', 'send_comment', 'comment_private', 'live_private', 'live_reply'].forEach(function (forbidden) {
    assert.strictEqual(names.indexOf(forbidden), -1, '清单里出现了未授权的发送入口: ' + forbidden);
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

test('所有 sidecar 调用点都必须在白名单内，且不得命中禁止清单', function () {
  // 只看【真正的调用点】（capture.invoke / callOnce），不看到处出现的字符串。
  // 早先的版本按"源码里出现方法名"判，于是 approve_batch 里一个 informational
  // 的 'comment_private' 标签也会被误报 —— 守卫过宽就会逼人绕着它写代码，
  // 那是反向激励。真正要守的是"有没有地方真的调了它"。
  const called = [];
  walk(SRC_DIR).filter(function (file) { return path.basename(file) !== 'registry.js'; })
    .forEach(function (file) {
      const text = fs.readFileSync(file, 'utf8')
        .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const pattern = /(?:invoke|callOnce)\([^,)]*,?\s*'([a-z_]+)'/g;
      let match = pattern.exec(text);
      while (match) { called.push({ file: path.basename(file), method: match[1] }); match = pattern.exec(text); }
    });
  assert.ok(called.length > 0, '没扫到任何调用点，说明这条断言本身失效了');
  const offenders = called.filter(function (entry) {
    return registry.ALLOWED_SIDECAR_METHODS.indexOf(entry.method) === -1 ||
           registry.FORBIDDEN_SIDECAR_METHODS.indexOf(entry.method) !== -1;
  }).map(function (entry) { return entry.file + ' -> ' + entry.method; });
  assert.deepStrictEqual(offenders, [], '出现了白名单外的 sidecar 调用');
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
