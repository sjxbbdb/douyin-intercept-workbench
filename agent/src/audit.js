'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOOL_VERSION = 'agent-tools/0.1.0';

// 每次工具调用都要有一条审计行。写不进去就让调用失败——
// 审计是红线，不是"尽力而为"。（契约 §十 断言 11 的同族要求。）
function record(agentStateDir, entry) {
  if (!agentStateDir) {
    return { ok: false, code: 'unknown/audit_unavailable', reason: 'agent state dir is not configured' };
  }
  const scope = entry && entry.accountScope ? String(entry.accountScope) : '_unscoped';
  const dir = path.join(agentStateDir, 'accounts', scope);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(Object.assign({
      toolVersion: TOOL_VERSION,
      modelVersion: null,
      promptVersion: null
    }, entry)) + '\n';
    fs.appendFileSync(path.join(dir, 'decisions.jsonl'), line, 'utf8');
    return { ok: true, path: path.join(dir, 'decisions.jsonl') };
  } catch (error) {
    return { ok: false, code: 'unknown/audit_unavailable',
             reason: error && error.message ? error.message : String(error) };
  }
}

module.exports = { record, TOOL_VERSION };
