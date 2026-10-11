#!/usr/bin/env node
'use strict';

const path = require('node:path');
const registry = require('../src/registry');
const config = require('../src/config');
const audit = require('../src/audit');
const { toBlocked } = require('../src/blocked-codes');

// stdio JSON-RPC 2.0，方法名与 MCP 对齐（initialize / tools/list / tools/call）。
// 不监听任何端口 —— 因此不存在被远端调用的面。

const PROTOCOL_VERSION = '2024-11-05';
// 规范要求：客户端报的版本如果我们支持，就必须回同一个；否则回自己支持的一个。
// 这里只支持工具类语义，三个版本在 tools/list 与 tools/call 上没有差异。
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

function negotiateVersion(requested) {
  const raw = String(requested == null ? '' : requested);
  return SUPPORTED_PROTOCOL_VERSIONS.indexOf(raw) === -1 ? PROTOCOL_VERSION : raw;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function usage() {
  return [
    '用法: node bin/agent-tools.js --state-dir <dir> --profile-dir <dir> --port <n>',
    '可选: --python <exe> --probe-dir <dir> --agent-state-dir <dir>',
    '环境: DOUYIN_AGENT_STATE_DIR / DOUYIN_AGENT_PROFILE_DIR / DOUYIN_AGENT_PORT /',
    '      DOUYIN_AGENT_PYTHON / DOUYIN_AGENT_PROBE_DIR / DOUYIN_AGENT_STATE_ROOT'
  ].join('\n');
}

// 已经是业务码（blocked/* empty/* unknown/*）的原样透传；
// 其余（sidecar 协议码）必须显式映射，不允许把协议码直接抛给上层。
function blockedError(code, reason) {
  const raw = String(code == null ? '' : code);
  const isBusiness = raw.indexOf('blocked/') === 0 || raw.indexOf('empty/') === 0 || raw.indexOf('unknown/') === 0;
  return { code: isBusiness ? raw : toBlocked(raw), message: reason || raw };
}

function handleCall(cfg, name, args) {
  const tool = registry.find(name);
  if (!tool) {
    // 未注册的工具 = 不存在的能力。这里必须拒绝，而不是"尽力而为"。
    return { isError: true, error: blockedError('unknown_method', 'tool is not registered: ' + String(name)) };
  }
  const ctx = {
    config: cfg,
    agentStateDir: cfg.agentStateDir,
    accountScope: null
  };
  let outcome;
  try {
    outcome = tool.handler.run(ctx, args || {});
  } catch (error) {
    outcome = { ok: false, code: 'unknown/internal', reason: error && error.message ? error.message : String(error) };
  }

  // 审计：每次调用一条。写不进审计就让调用失败（红线，不是尽力而为）。
  const audited = audit.record(cfg.agentStateDir, {
    atMs: Date.now(),
    accountScope: ctx.accountScope,
    tool: name,
    args: redactArgs(args || {}),
    ok: Boolean(outcome && outcome.ok),
    code: outcome && outcome.ok ? null : String((outcome && outcome.code) || 'unknown/internal')
  });
  if (!audited.ok) {
    return { isError: true, error: blockedError(audited.code, audited.reason) };
  }

  if (outcome && outcome.ok) {
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
             structuredContent: outcome.result };
  }
  return { isError: true, error: blockedError((outcome && outcome.code) || 'request_failed',
                                              outcome && outcome.reason) };
}

// 审计里只留参数名与形状，不留任何可能含原文的值。
function redactArgs(args) {
  const out = {};
  Object.keys(args).forEach(function (key) {
    const value = args[key];
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) out[key] = value;
    else out[key] = '<' + typeof value + ':' + String(value).length + '>';
  });
  return out;
}

function main() {
  const cfg = config.fromEnvAndArgs(process.argv.slice(2), process.env);
  if (cfg.help) { process.stdout.write(usage() + '\n'); return 0; }
  const need = config.missing(cfg);
  if (need.length) {
    process.stderr.write('缺少必填参数: ' + need.join(', ') + '\n' + usage() + '\n');
    return 2;
  }
  cfg.agentStateDir = cfg.agentStateDir || path.join(cfg.stateDir, 'agent');

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatch(cfg, line);
      index = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', function () { process.exit(0); });
  return null;
}

function dispatch(cfg, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const id = request.id;
  const method = String(request.method || '');
  const params = request.params || {};

  if (method === 'initialize') {
    emit({ jsonrpc: '2.0', id, result: {
      protocolVersion: negotiateVersion(params.protocolVersion),
      capabilities: { tools: {} },
      serverInfo: { name: 'douyin-agent-tools', version: '0.1.0' },
      // 让客户端一眼看到这一版的边界。
      stage: 'BP0',
      toolCount: registry.count(),
      writableTools: 0
    } });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'tools/list') {
    emit({ jsonrpc: '2.0', id, result: { tools: registry.listTools() } });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    const outcome = handleCall(cfg, name, args);
    if (outcome.isError) {
      emit({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(outcome.error) }] } });
    } else {
      emit({ jsonrpc: '2.0', id, result: outcome });
    }
    return;
  }
  emit({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

const exitCode = main();
if (typeof exitCode === 'number') process.exit(exitCode);
