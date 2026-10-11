'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const config = require('../src/config');
const doctor = require('../src/doctor');
const helpers = require('./helpers');

// 评审项：给别人用的第一步是自检。它必须【只读】、必须给出可照抄的下一步，
// 且缺什么就报什么 —— 不允许"环境不全还说 ready"。

const SCOPE = 'testscope000000000000000000000000';

function fakeDeps(overrides) {
  return Object.assign({
    nodeVersion: '22.23.2',
    sqliteAvailable: function () { return true; },
    sqliteReason: function () { return null; },
    pythonVersion: function () { return { ok: true, version: 'Python 3.12.10' }; }
  }, overrides || {});
}

test('环境齐全 -> ready，并给出可粘贴的 MCP 配置', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const result = doctor.runChecks(cfg, { deps: fakeDeps() });
  assert.strictEqual(result.ready, true, JSON.stringify(result.blocking));
  const server = result.mcpConfig.mcpServers['douyin-agent-tools'];
  assert.strictEqual(server.command, process.execPath);
  assert.ok(server.args.indexOf('--state-dir') !== -1);
  assert.ok(server.args.indexOf(cfg.stateDir) !== -1, '配置里必须带使用者的真实路径');
  assert.ok(path.isAbsolute(server.args[0]), '入口脚本应当是绝对路径（使用者可能从任意工作目录启动）');
  assert.ok(path.isAbsolute(cfg.profileDir), 'profile 路径也必须是绝对的');
});

test('Node 版本太低 -> 明确不 ready，并说清楚为什么', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  ['20.11.0', '22.12.0', '18.20.0'].forEach(function (version) {
    const result = doctor.runChecks(cfg, { deps: fakeDeps({ nodeVersion: version }) });
    assert.strictEqual(result.ready, false, version + ' 不该被判为可用');
    assert.ok(result.blocking.indexOf('node_version') !== -1);
  });
  ['22.13.0', '22.23.2', '24.0.0'].forEach(function (version) {
    assert.strictEqual(doctor.nodeVersionOk(version), true, version + ' 应当被接受');
  });
});

test('没有 Python -> 报出来并给出安装指引，不去连 sidecar', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  let called = false;
  const result = doctor.runChecks(cfg, { deps: fakeDeps({
    pythonVersion: function () { return { ok: false, reason: 'spawn python ENOENT' }; },
    callSidecar: function () { called = true; return { ok: false, error: { code: 'x' } }; }
  }) });
  assert.strictEqual(result.ready, false);
  assert.ok(result.blocking.indexOf('python') !== -1);
  assert.strictEqual(called, false, '前置项没过就不该再去连 sidecar');
});

test('状态目录不存在 -> 明确指出来，而不是当成空台账继续跑', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  cfg.stateDir = path.join(cfg.stateDir, 'not-there');
  const result = doctor.runChecks(cfg, { deps: fakeDeps() });
  assert.strictEqual(result.ready, false);
  assert.ok(result.blocking.indexOf('state_dir') !== -1);
});

test('sidecar 连不上 -> 给出可以照抄的命令', function () {
  // 前置项都满足（有个真的存在的 sidecar 脚本），但执行失败。
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const result = doctor.runChecks(cfg, { deps: fakeDeps({
    callSidecar: function () {
      return { ok: false, error: { code: 'sidecar_spawn_failed', message: 'python not found' } };
    }
  }) });
  assert.strictEqual(result.ready, false);
  const item = result.checks.find(function (c) { return c.id === 'sidecar_capabilities'; });
  assert.strictEqual(item.ok, false);
  assert.ok(item.fix.indexOf('sidecar.py') !== -1, '必须给出可照抄的命令');
  assert.ok(item.detail.indexOf('sidecar_spawn_failed') !== -1, '要保留原始错误码');
});

test('前置项没过时，明确指向第一个卡住的项，不产生噪音', function () {
  const cfg = helpers.makeConfig(); // sidecar 脚本不存在
  const result = doctor.runChecks(cfg, { deps: fakeDeps() });
  assert.strictEqual(result.ready, false);
  const item = result.checks.find(function (c) { return c.id === 'sidecar_capabilities'; });
  assert.ok(item.fix.indexOf('sidecar_script') !== -1, '应当指向真正卡住的那一项');
});

test('默认不连浏览器；要求时才连，且登录失败给人工指引', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const notProbed = doctor.runChecks(cfg, { deps: fakeDeps() });
  assert.ok(!notProbed.checks.some(function (c) { return c.id === 'browser_login'; }));
  assert.ok(notProbed.note.indexOf('未连浏览器') !== -1);

  const probed = doctor.runChecks(cfg, { deps: fakeDeps(), probeBrowser: true });
  const item = probed.checks.find(function (c) { return c.id === 'browser_login'; });
  assert.ok(item, '要求探查时必须有一项浏览器检查');

  // 登录态看着正常、但页面有验证码 —— 仍然必须判为不可用（真机踩过：只判 login 会漏）。
  const captchaCfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE, captcha: true, login: 'ok' });
  const captcha = doctor.runChecks(captchaCfg, { deps: fakeDeps(), probeBrowser: true });
  const captchaItem = captcha.checks.find(function (c) { return c.id === 'browser_login'; });
  assert.strictEqual(captchaItem.ok, false, '有验证码却判通过');
  assert.strictEqual(captcha.ready, false, '有验证码时整体不能 ready');
  assert.ok(captchaItem.fix.indexOf('验证码') !== -1);
  assert.ok(captchaItem.fix.indexOf('绝不绕过') !== -1, '必须写明不绕过验证码');
});

test('配置文件优先级：命令行 > 环境变量 > 配置文件', function () {
  const dir = helpers.tempDir('agent-config-');
  const file = path.join(dir, 'agent.config.json');
  fs.writeFileSync(file, JSON.stringify({
    stateDir: 'C:/from-file', profileDir: 'C:/from-file-profile', port: 1111, python: 'python-file'
  }), 'utf8');

  const fromFile = config.fromEnvAndArgs(['--config', file], {});
  assert.strictEqual(fromFile.stateDir, 'C:/from-file');
  assert.strictEqual(fromFile.port, 1111);
  assert.strictEqual(fromFile.python, 'python-file');

  const envWins = config.fromEnvAndArgs(['--config', file], { DOUYIN_AGENT_STATE_DIR: 'C:/from-env' });
  assert.strictEqual(envWins.stateDir, 'C:/from-env', '环境变量应压过配置文件');

  const cliWins = config.fromEnvAndArgs(['--config', file, '--state-dir', 'C:/from-cli'],
    { DOUYIN_AGENT_STATE_DIR: 'C:/from-env' });
  assert.strictEqual(cliWins.stateDir, 'C:/from-cli', '命令行应压过环境变量');
});

test('配置文件坏掉 -> 明确报错，不静默用默认值', function () {
  const dir = helpers.tempDir('agent-config-bad-');
  const file = path.join(dir, 'agent.config.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  const cfg = config.fromEnvAndArgs(['--config', file], {});
  assert.strictEqual(cfg.configLoaded, false);
  assert.ok(String(cfg.configError).indexOf('cannot read config file') !== -1);
});

test('自检只允许调 capabilities / doctor 这两个只读方法', function () {
  const registry = require('../src/registry');
  const text = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'doctor.js'), 'utf8');
  const called = [];
  const pattern = /callSidecar\([^,]+,\s*'([a-z_]+)'/g;
  let match = pattern.exec(text);
  while (match) { called.push(match[1]); match = pattern.exec(text); }
  assert.ok(called.length > 0, '没找到任何 callSidecar 调用，说明检查本身失效了');
  called.forEach(function (method) {
    assert.ok(registry.ALLOWED_SIDECAR_METHODS.indexOf(method) !== -1,
      '自检调用了不允许的方法: ' + method);
  });
  assert.deepStrictEqual(called.slice().sort(), ['capabilities', 'doctor']);
});
