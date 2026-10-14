'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 冻结批次的本地记录（契约 §五 的状态布局）。
//
// 为什么要落盘：审批要回答"这一批里谁可以批"，而答案必须来自
// 【冻结那一刻的事实】—— 计划里的话术、身份哈希、策略身份。
// 事后再去平台反查是另一回事（那边只有当前可见的评论）。
//
// 🔴 身份一律只落加盐哈希，不落 sec_uid / 昵称。

function dirFor(agentStateDir, accountScope) {
  return path.join(agentStateDir, 'accounts', String(accountScope), 'batches');
}

function fileFor(agentStateDir, accountScope, batchId) {
  return path.join(dirFor(agentStateDir, accountScope), String(batchId) + '.json');
}

function write(agentStateDir, accountScope, record) {
  const dir = dirFor(agentStateDir, accountScope);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(agentStateDir, accountScope, record.batchId);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return file;
}

function read(agentStateDir, accountScope, batchId) {
  const file = fileFor(agentStateDir, accountScope, batchId);
  if (!fs.existsSync(file)) return { ok: true, record: null };
  try {
    return { ok: true, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, code: 'unknown/state_unavailable',
             reason: 'batch record is unreadable: ' + (error && error.message ? error.message : String(error)) };
  }
}

// sendId 必须【确定性】：同一批同一条，反复 review 得到同一个值，
// 这样重放不会变成第二次发送（probe 的台账按 sendId 幂等）。
function sendIdFor(batchId, eventId) {
  return 'agent:' + String(batchId) + ':' + String(eventId);
}

module.exports = { dirFor, fileFor, write, read, sendIdFor };
