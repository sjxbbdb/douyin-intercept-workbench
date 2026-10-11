'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 配置只描述"去哪儿读"，不含任何安全数值：
// 上限只能来自 sidecar 的 SendGate / 将来的服务端策略，Agent 层不写死。
//
// 优先级：命令行 > 环境变量 > --config 指定的 JSON 文件 > 内置默认。
// 配置文件是为了让使用者只写一次路径（见 agent.config.example.json）。

const FILE_KEYS = ['stateDir', 'profileDir', 'port', 'python', 'probeDir', 'agentStateDir', 'sidecarScript'];

function readConfigFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'config file must be a JSON object' };
    }
    const out = {};
    FILE_KEYS.forEach(function (key) {
      if (parsed[key] !== undefined && parsed[key] !== null) out[key] = parsed[key];
    });
    if (out.port !== undefined) out.port = Number(out.port);
    return { ok: true, values: out };
  } catch (error) {
    return { ok: false, reason: 'cannot read config file ' + file + ': ' + (error && error.message ? error.message : String(error)) };
  }
}

function fromEnvAndArgs(argv, env) {
  const e = env || {};
  const args = argv || [];
  const out = {
    stateDir: null,
    profileDir: null,
    port: null,
    python: e.DOUYIN_AGENT_PYTHON || 'python',
    probeDir: e.DOUYIN_AGENT_PROBE_DIR || null,
    agentStateDir: e.DOUYIN_AGENT_STATE_ROOT || null,
    // sidecar 入口脚本。生产环境永远是 probe/sidecar.py；
    // 允许覆盖是为了让离线测试塞一个假 sidecar，避免测试依赖浏览器或 Python。
    sidecarScript: e.DOUYIN_AGENT_SIDECAR_SCRIPT || null
  };
  // 谁显式给过值，谁就压过配置文件。默认值不算"显式"。
  const explicit = {};
  if (e.DOUYIN_AGENT_PYTHON) explicit.python = true;
  if (e.DOUYIN_AGENT_PROBE_DIR) explicit.probeDir = true;
  if (e.DOUYIN_AGENT_STATE_ROOT) explicit.agentStateDir = true;
  if (e.DOUYIN_AGENT_SIDECAR_SCRIPT) explicit.sidecarScript = true;
  if (e.DOUYIN_AGENT_STATE_DIR) { out.stateDir = e.DOUYIN_AGENT_STATE_DIR; explicit.stateDir = true; }
  if (e.DOUYIN_AGENT_PROFILE_DIR) { out.profileDir = e.DOUYIN_AGENT_PROFILE_DIR; explicit.profileDir = true; }
  if (e.DOUYIN_AGENT_PORT) { out.port = Number(e.DOUYIN_AGENT_PORT); explicit.port = true; }
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const value = args[i + 1];
    if (key === '--state-dir') { out.stateDir = value; explicit.stateDir = true; i += 1; }
    else if (key === '--profile-dir') { out.profileDir = value; explicit.profileDir = true; i += 1; }
    else if (key === '--port') { out.port = Number(value); explicit.port = true; i += 1; }
    else if (key === '--python') { out.python = value; explicit.python = true; i += 1; }
    else if (key === '--probe-dir') { out.probeDir = value; explicit.probeDir = true; i += 1; }
    else if (key === '--agent-state-dir') { out.agentStateDir = value; explicit.agentStateDir = true; i += 1; }
    else if (key === '--sidecar-script') { out.sidecarScript = value; explicit.sidecarScript = true; i += 1; }
    else if (key === '--config') { out.configFile = value; i += 1; }
    else if (key === '--print-config') { out.printConfig = true; }
    else if (key === '--json') { out.json = true; }
    else if (key === '--help' || key === '-h') { out.help = true; }
  }
  // 配置文件只填"命令行与环境变量都没给"的键。
  if (!out.configFile && e.DOUYIN_AGENT_CONFIG) out.configFile = e.DOUYIN_AGENT_CONFIG;
  if (out.configFile) {
    const loaded = readConfigFile(out.configFile);
    out.configLoaded = loaded.ok;
    out.configError = loaded.ok ? null : loaded.reason;
    if (loaded.ok) {
      FILE_KEYS.forEach(function (key) {
        if (explicit[key]) return;
        if (loaded.values[key] === undefined) return;
        out[key] = loaded.values[key];
      });
    }
  }
  if (!out.probeDir) out.probeDir = path.resolve(__dirname, '..', '..', 'probe');
  if (!out.sidecarScript) out.sidecarScript = path.join(out.probeDir, 'sidecar.py');
  if (!out.agentStateDir && out.stateDir) out.agentStateDir = path.join(out.stateDir, 'agent');
  return out;
}

function missing(config) {
  const need = [];
  if (!config.stateDir) need.push('--state-dir');
  if (!config.profileDir) need.push('--profile-dir');
  if (!config.port || Number.isNaN(config.port)) need.push('--port');
  return need;
}

// 把路径补成绝对路径，方便别人把它原样粘进 MCP 客户端配置。
function absolutize(config) {
  const out = Object.assign({}, config);
  ['stateDir', 'profileDir', 'probeDir', 'agentStateDir', 'sidecarScript', 'configFile'].forEach(function (key) {
    if (out[key]) out[key] = path.resolve(String(out[key]));
  });
  return out;
}

module.exports = { fromEnvAndArgs, missing, readConfigFile, absolutize, FILE_KEYS };
