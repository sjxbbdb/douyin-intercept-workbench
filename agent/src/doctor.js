'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ledger = require('./ledger');
const configMod = require('./config');
const { callOnce } = require('./sidecar-client');

// 上手自检：一个陌生人拿到这份代码后，到底缺什么。
//
// 硬约束：
//   · 【不】启动浏览器、【不】登录、【不】发送任何东西；
//   · 每一步失败都要给出"下一步照抄这行命令"，而不是只说"失败"。

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR_IF_22 = 13;

function check(id, ok, detail, fix, blocking) {
  return { id, ok, detail: detail || null, fix: ok ? null : (fix || null), blocking: blocking !== false };
}

function nodeVersionOk(version) {
  const parts = String(version).split('.').map(function (n) { return Number(n); });
  const major = parts[0];
  const minor = parts[1];
  if (!Number.isFinite(major)) return false;
  if (major > MIN_NODE_MAJOR) return true;
  if (major < MIN_NODE_MAJOR) return false;
  return minor >= MIN_NODE_MINOR_IF_22;
}

function defaultDeps() {
  return {
    nodeVersion: process.versions.node,
    sqliteAvailable: ledger.sqliteAvailable,
    sqliteReason: ledger.sqliteUnavailableReason,
    pythonVersion: function (python) {
      const result = spawnSync(python, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (result.error) return { ok: false, reason: String(result.error.message || result.error) };
      const text = String(result.stdout || '') + String(result.stderr || '');
      return { ok: true, version: text.trim().split(/\r?\n/)[0] || 'unknown' };
    },
    callSidecar: callOnce
  };
}

function sidecarCommand(cfg) {
  return 'node "' + path.join(__dirname, '..', 'bin', 'agent-tools.js') + '" --config "' +
    (cfg.configFile || '<你的配置文件>') + '"';
}

function launchHint(cfg) {
  return 'python "' + cfg.sidecarScript + '" --state-dir "' + cfg.stateDir +
    '" --profile-dir "' + cfg.profileDir + '" --port ' + cfg.port;
}

// 返回结构化结果，便于测试；bin 只负责排版。
function runChecks(cfg, options) {
  const opts = options || {};
  // 允许调用方只覆盖一部分依赖（测试常用），其余仍用真实实现。
  const deps = Object.assign(defaultDeps(), opts.deps || {});
  const checks = [];

  checks.push(check('node_version', nodeVersionOk(deps.nodeVersion),
    'Node ' + deps.nodeVersion + '（需要 >= 22.13）',
    '升级 Node 到 22.13 或更高（只读台账用了内置 node:sqlite）'));

  checks.push(check('node_sqlite', deps.sqliteAvailable(),
    deps.sqliteAvailable() ? '可用' : String(deps.sqliteReason()),
    '当前 Node 没有 node:sqlite；升级 Node，或改为让 sidecar 暴露只读额度方法'));

  const py = deps.pythonVersion(cfg.python);
  checks.push(check('python', py.ok, py.ok ? py.version : String(py.reason),
    '安装 Python 3.12/3.13，或用 --python 指定解释器路径'));

  const scriptExists = Boolean(cfg.sidecarScript) && fs.existsSync(cfg.sidecarScript);
  checks.push(check('sidecar_script', scriptExists,
    scriptExists ? cfg.sidecarScript : '找不到 ' + String(cfg.sidecarScript),
    '确认 --probe-dir 指向仓库里的 probe/ 目录'));

  const stateExists = Boolean(cfg.stateDir) && fs.existsSync(cfg.stateDir);
  checks.push(check('state_dir', stateExists,
    stateExists ? cfg.stateDir : '目录不存在: ' + String(cfg.stateDir),
    '先跑一次 sidecar（搜索或采集）让它建台账，或把 --state-dir 指向已有目录'));

  let agentDirOk = false;
  let agentDirDetail = '未配置';
  if (cfg.agentStateDir) {
    try {
      fs.mkdirSync(cfg.agentStateDir, { recursive: true });
      fs.accessSync(cfg.agentStateDir, fs.constants.W_OK);
      agentDirOk = true;
      agentDirDetail = cfg.agentStateDir;
    } catch (error) {
      agentDirDetail = '不可写: ' + (error && error.message ? error.message : String(error));
    }
  }
  checks.push(check('agent_state_dir', agentDirOk, agentDirDetail,
    '换一个可写目录：--agent-state-dir <目录>'));

  // 前 6 项都过了才去连 sidecar，避免在必然失败时报一堆噪音。
  const blockingSoFar = checks.filter(function (c) { return c.blocking && !c.ok; });
  if (blockingSoFar.length === 0) {
    const caps = deps.callSidecar(cfg, 'capabilities', {});
    if (caps.ok) {
      checks.push(check('sidecar_capabilities', true,
        'accountScope=' + String(caps.result.accountScope) +
        ' limits=' + JSON.stringify(caps.result.limits || {})));
    } else {
      checks.push(check('sidecar_capabilities', false,
        String((caps.error && caps.error.code) || 'unknown') + ': ' + String((caps.error && caps.error.message) || ''),
        '手工跑一次看报错：' + launchHint(cfg))); 
    }
  } else {
    checks.push(check('sidecar_capabilities', false, '前置项未通过，跳过',
      '先修这一项：' + blockingSoFar[0].id + '（' + String(blockingSoFar[0].detail || '') + '）', true));
  }

  // 浏览器/登录：只有显式要求才连，避免"自检把浏览器打开"这种副作用。
  if (opts.probeBrowser) {
    const doctor = deps.callSidecar(cfg, 'doctor', {});
    if (doctor.ok) {
      const login = String((doctor.result && doctor.result.login) || 'unknown');
      const captcha = Boolean(doctor.result && doctor.result.captcha);
      // 有验证码就等于不能干活 —— 登录态看着正常也不行（页面被风控拦住了）。
      // probe 的登录态只有 required / verified / unknown 三种（见 probe/douyin.py）。
      // 写成 'ok'/'authorized' 会【明明登录着却判不通过】。
      const loginOk = (login === 'verified' || login === 'ok' || login === 'authorized') && !captcha;
      checks.push(check('browser_login', loginOk,
        'login=' + login + ' captcha=' + captcha + ' url=' + String((doctor.result && doctor.result.url) || ''),
        captcha
          ? '页面出现验证码：请人工完成验证后重跑（本工具绝不绕过验证码）'
          : '请在那个 Chrome 里手工登录抖音，然后重跑自检'));
    } else {
      const code = String((doctor.error && doctor.error.code) || 'unknown');
      checks.push(check('browser_login', false, code,
        code === 'browser_not_owned' || code === 'browser_not_found' || code === 'page_visibility_unknown'
          ? '浏览器没连上。先启动专用 Chrome：' + launchHint(cfg) + '  然后把它放到前台并保持可见'
          : '看 sidecar 的原始报错：' + launchHint(cfg)));
    }
  }

  const blocking = checks.filter(function (c) { return c.blocking && !c.ok; });
  return {
    ok: blocking.length === 0,
    ready: blocking.length === 0,
    checks,
    blocking: blocking.map(function (c) { return c.id; }),
    mcpConfig: mcpConfigFor(cfg),
    note: opts.probeBrowser
      ? '已连过浏览器（只读，未发送任何内容）'
      : '未连浏览器；要一并检查登录状态，加 --probe-browser'
  };
}

// 直接给出一份可以粘贴到 MCP 客户端的配置（绝对路径）。
function mcpConfigFor(cfg) {
  const abs = configMod.absolutize(cfg);
  return {
    mcpServers: {
      'douyin-agent-tools': {
        command: process.execPath,
        args: [
          path.join(__dirname, '..', 'bin', 'agent-tools.js'),
          '--state-dir', String(abs.stateDir || ''),
          '--profile-dir', String(abs.profileDir || ''),
          '--port', String(abs.port || 9222)
        ]
      }
    }
  };
}

module.exports = { runChecks, mcpConfigFor, nodeVersionOk, defaultDeps };
