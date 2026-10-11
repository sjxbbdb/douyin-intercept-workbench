'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// probe/sidecar.py 是【一次进程一次请求】的 line-JSON 协议：
// 主循环读一行、dispatch、回一行、退出。所以这里按调用起进程，不做长连接。
//
// 这里刻意只暴露 call()：Agent 层能不能做某件事，取决于工具清单，
// 不取决于它能不能拼出 sidecar 方法名。

const DEFAULT_TIMEOUT_MS = 60000;

function callOnce(config, method, params, options) {
  const opts = options || {};
  const args = [
    config.sidecarScript || path.join(config.probeDir, 'sidecar.py'),
    '--state-dir', config.stateDir,
    '--profile-dir', config.profileDir,
    '--port', String(config.port)
  ];
  const result = spawnSync(config.python, args, {
    input: JSON.stringify({ id: 'agent-tools-1', method: method, params: params || {} }) + '\n',
    encoding: 'utf8',
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) {
    return { ok: false, error: { code: 'sidecar_spawn_failed', message: String(result.error.message || result.error) } };
  }
  const stdout = String(result.stdout || '');
  // 进度行（type: progress）不是结果，跳过；取最后一行带 ok 的。
  const lines = stdout.split(/\r?\n/).filter(function (line) { return line.trim(); });
  let payload = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) { payload = parsed; break; }
    } catch (error) { /* 非 JSON 行忽略 */ }
  }
  if (!payload) {
    const stderr = String(result.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    return { ok: false, error: { code: 'sidecar_no_result',
      message: 'sidecar returned no result (exit=' + String(result.status) + ')' + (stderr ? ': ' + stderr : '') } };
  }
  if (payload.ok) return { ok: true, result: payload.result };
  return { ok: false, error: payload.error || { code: 'request_failed', message: 'unknown sidecar error' } };
}

module.exports = { callOnce };
