'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 离线夹具：临时目录 + 真的 sqlite 台账 + 假 sidecar。
// 全部不碰浏览器、不碰网络、不依赖 Python。

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'agent-tools-'));
}

function makeConfig(overrides) {
  const dir = (overrides && overrides.stateDir) || tempDir('agent-state-');
  const agentStateDir = path.join(dir, 'agent');
  fs.mkdirSync(agentStateDir, { recursive: true });
  return Object.assign({
    stateDir: dir,
    profileDir: path.join(dir, 'profile'),
    port: 9222,
    python: 'python',
    probeDir: path.join(dir, 'probe'),
    agentStateDir,
    sidecarScript: path.join(dir, 'probe', 'sidecar.py')
  }, overrides || {});
}

// 假 sidecar：只实现 capabilities / doctor，够 BP0 的只读工具用。
// 用 node 来跑（测试里把 config.python 设为 process.execPath）。
function writeFakeSidecar(cfg, plan) {
  const script = [
    "'use strict';",
    "const plan = " + JSON.stringify(plan || {}) + ';',
    "let raw = '';",
    "process.stdin.on('data', function (c) { raw += c; });",
    "process.stdin.on('end', function () {",
    "  const request = JSON.parse(raw.split(/\\r?\\n/)[0]);",
    "  const method = request.method;",
    "  if (method === 'capabilities') {",
    "    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {",
    "      protocolVersion: 1,",
    "      sendStatuses: ['unknown', 'failed', 'blocked'],",
    "      limits: plan.limits || { per_user: 1, hourly: 20, daily: 50 },",
    "      accountScope: plan.accountScope || 'testscope000000000000000000000000',",
    "      capability: {}",
    "    } }) + '\\n');",
    "    return;",
    "  }",
    "  if (method === 'doctor') {",
    "    if (plan.doctorError) {",
    "      process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: plan.doctorError }) + '\\n');",
    "      return;",
    "    }",
    "    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {",
    "      status: 'ok', url: 'https://www.douyin.com/', login: plan.login || 'ok', captcha: plan.captcha === true,",
    "      browser: { port: 9222, pid: 1234 }",
    "    } }) + '\\n');",
    "    return;",
    "  }",
    "  process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'unknown_method', message: method } }) + '\\n');",
    "});"
  ].join('\n');
  fs.mkdirSync(path.dirname(cfg.sidecarScript), { recursive: true });
  fs.writeFileSync(cfg.sidecarScript, script, 'utf8');
  cfg.python = process.execPath;
  return cfg;
}

function seedSends(cfg, rows) {
  const file = path.join(cfg.stateDir, 'send_state.sqlite3');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS sends (' +
    'account_scope TEXT NOT NULL, send_id TEXT NOT NULL, target_key TEXT NOT NULL, ' +
    'text_sha256 TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, ' +
    'created_at REAL NOT NULL, started_at REAL, finished_at REAL, ' +
    "detail_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (account_scope, send_id))");
  const insert = db.prepare('INSERT INTO sends(account_scope,send_id,target_key,text_sha256,kind,status,created_at,finished_at,detail_json) ' +
    'VALUES(?,?,?,?,?,?,?,?,?)');
  rows.forEach(function (row) {
    insert.run(row.accountScope, row.sendId, row.targetKey || 'target-1', 'sha', row.kind || 'comment',
               row.status, row.createdAtMs / 1000, row.finishedAtMs == null ? null : row.finishedAtMs / 1000,
               JSON.stringify(row.detail || {}));
  });
  db.close();
  return file;
}

function seedQueue(cfg, ledgerName, accountScope, events, batches) {
  const file = path.join(cfg.stateDir, ledgerName + '_flow.sqlite3');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS live_events (' +
    'account_scope TEXT NOT NULL, event_key TEXT NOT NULL, event_id TEXT NOT NULL DEFAULT \'\', ' +
    'batch_id TEXT, state TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT \'\', ' +
    'author_id TEXT NOT NULL DEFAULT \'\', author_name TEXT NOT NULL DEFAULT \'\', ' +
    'text TEXT NOT NULL DEFAULT \'\', payload_json TEXT NOT NULL DEFAULT \'{}\', ' +
    'detail_json TEXT NOT NULL DEFAULT \'{}\', private_json TEXT NOT NULL DEFAULT \'{}\', ' +
    'seen_at REAL NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (account_scope, event_key))');
  db.exec('CREATE TABLE IF NOT EXISTS live_batches (' +
    'account_scope TEXT NOT NULL, batch_id TEXT NOT NULL, status TEXT NOT NULL, ' +
    'created_at REAL NOT NULL, expires_at REAL NOT NULL, plan_json TEXT NOT NULL DEFAULT \'{}\', ' +
    'PRIMARY KEY (account_scope, batch_id))');
  const insertEvent = db.prepare('INSERT INTO live_events(' +
    'account_scope,event_key,event_id,batch_id,state,room_id,author_id,author_name,text,seen_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  (events || []).forEach(function (e) {
    insertEvent.run(accountScope, e.eventKey, e.eventId || '', e.batchId || null, e.state,
                    e.roomId || 'room-1', e.authorId || 'author-1', e.authorName || 'nick',
                    e.text || 'text', e.seenAtMs / 1000, (e.updatedAtMs || e.seenAtMs) / 1000);
  });
  const insertBatch = db.prepare('INSERT INTO live_batches(account_scope,batch_id,status,created_at,expires_at) VALUES(?,?,?,?,?)');
  (batches || []).forEach(function (b) {
    insertBatch.run(accountScope, b.batchId, b.status, b.createdAtMs / 1000, b.expiresAtMs / 1000);
  });
  db.close();
  return file;
}

function writeLeads(cfg, accountScope, rows) {
  const dir = path.join(cfg.agentStateDir, 'accounts', accountScope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'leads.jsonl'),
    rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n', 'utf8');
}

module.exports = { tempDir, makeConfig, writeFakeSidecar, seedSends, seedQueue, writeLeads };
