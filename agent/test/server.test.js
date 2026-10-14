'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const helpers = require('./helpers');

// 评审项：stdio 服务只暴露只读工具；未知工具必须被拒；
// 每次调用必须落审计，审计写不进去就让调用失败（红线，不是尽力而为）。

const BIN = path.resolve(__dirname, '..', 'bin', 'agent-tools.js');
const SCOPE = 'testscope000000000000000000000000';

function runServer(cfg, requests) {
  const input = requests.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n';
  const result = spawnSync(process.execPath, [BIN,
    '--state-dir', cfg.stateDir,
    '--profile-dir', cfg.profileDir,
    '--port', String(cfg.port),
    '--sidecar-script', cfg.sidecarScript,
    '--python', cfg.python,
    '--agent-state-dir', cfg.agentStateDir
  ], { input, encoding: 'utf8', timeout: 30000 });
  const lines = String(result.stdout || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  return { responses: lines.map(function (l) { return JSON.parse(l); }), stderr: String(result.stderr || '') };
}

test('initialize 声明能力边界：12 个工具、0 个会写入平台内容的工具', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = runServer(cfg, [{ jsonrpc: '2.0', id: 1, method: 'initialize' }]);
  const result = out.responses[0].result;
  assert.strictEqual(result.toolCount, 16);
  // 唯一会写入平台内容的工具是 approve_batch。
  assert.strictEqual(result.writableTools, 1);
});

test('initialize 按规范协商协议版本：支持的回同一个，不支持的回自己的', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  ['2024-11-05', '2025-06-18'].forEach(function (version) {
    const out = runServer(cfg, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } }]);
    assert.strictEqual(out.responses[0].result.protocolVersion, version);
  });
  const other = runServer(cfg, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }]);
  assert.strictEqual(other.responses[0].result.protocolVersion, '2024-11-05');
});

test('tools/list 只列只读工具，且都带声明字段', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = runServer(cfg, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const registry = require('../src/registry');
  const tools = out.responses[0].result.tools;
  assert.strictEqual(tools.length, 16);
  const declared = registry.listTools().map(function (t) { return t.name; });
  tools.forEach(function (tool) {
    assert.ok(tool.declaration && tool.declaration.validation, tool.name);
    assert.ok(tool.declaration.tier, tool.name + ' 缺少 tier');
    assert.ok(declared.indexOf(tool.name) !== -1, '出现了契约外的工具: ' + tool.name);
  });
});

test('调用只读工具：成功并写入审计', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = runServer(cfg, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'query_leads', arguments: { limit: 10 } } }
  ]);
  const result = out.responses[0].result;
  assert.strictEqual(result.isError, false, JSON.stringify(result));
  const auditFile = path.join(cfg.agentStateDir, 'accounts', SCOPE, 'decisions.jsonl');
  assert.ok(fs.existsSync(auditFile), '审计文件没有生成');
  const last = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim().split('\n').pop());
  assert.strictEqual(last.tool, 'query_leads');
  assert.strictEqual(last.ok, true);
  assert.strictEqual(last.modelVersion, null);
  assert.ok(last.toolVersion, '审计必须带 toolVersion');
});

test('审计里不出现参数值原文（只留形状）', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  runServer(cfg, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'query_leads', arguments: { region: '这是一个很长的地域描述' } } }
  ]);
  const auditFile = path.join(cfg.agentStateDir, 'accounts', SCOPE, 'decisions.jsonl');
  const text = fs.readFileSync(auditFile, 'utf8');
  assert.ok(text.indexOf('这是一个很长的地域描述') === -1, '审计里出现了参数原文');
});

test('未注册的工具名一律被拒（不存在的工具就是不存在的能力）', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  ['send_private', 'approve_batch', 'review_batch', 'click', 'evaluate'].forEach(function (name) {
    const out = runServer(cfg, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }
    ]);
    const result = out.responses[0].result;
    assert.strictEqual(result.isError, true, name + ' 竟然被接受了');
    const payload = JSON.parse(result.content[0].text);
    assert.ok(payload.code.indexOf('unknown/') === 0 || payload.code.indexOf('blocked/') === 0,
      name + ' 的拒绝码不在闭集里: ' + payload.code);
  });
});

test('未知 JSON-RPC 方法被拒', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = runServer(cfg, [{ jsonrpc: '2.0', id: 1, method: 'tools/execute_everything' }]);
  assert.strictEqual(out.responses[0].error.code, -32601);
});

test('审计写不进去 -> 调用失败，不允许"没审计也算成功"', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  // 用一个文件占住 agent-state-dir 的位置，让 mkdir 必然失败。
  const blocker = path.join(cfg.stateDir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x', 'utf8');
  cfg.agentStateDir = blocker;
  const out = runServer(cfg, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'query_leads', arguments: {} } }
  ]);
  const result = out.responses[0].result;
  assert.strictEqual(result.isError, true, '没有审计却成功了');
  assert.strictEqual(JSON.parse(result.content[0].text).code, 'unknown/audit_unavailable');
});

test('缺少必填参数时进程直接拒绝启动，而不是猜一个状态目录', function () {
  const result = spawnSync(process.execPath, [BIN], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.status, 2);
  assert.ok(String(result.stderr).indexOf('缺少必填参数') !== -1);
});
