'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 授权服务自己的库。零第三方依赖（Node 内置 node:sqlite）。
// 与 probe 的台账【分开】：那一份是执行器的账，这一份是权威的账。
// 两边口径必须一致（见 README），否则会对不上。

const DB_NAME = 'authority.sqlite3';

// 计数口径照抄 probe/send_gate.py：这四个状态算"占用了配额"。
const COUNTED_STATES = ['reserved', 'started', 'unknown', 'sent_confirmed'];
const TERMINAL_STATES = ['failed', 'blocked', 'unknown', 'sent_confirmed'];

function open(stateDir) {
  const dir = path.resolve(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, DB_NAME));
  db.exec('PRAGMA busy_timeout=15000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS send_authorizations (' +
    'tenant TEXT NOT NULL, authorization_id TEXT NOT NULL, send_id TEXT NOT NULL, ' +
    'account_scope TEXT NOT NULL, kind TEXT NOT NULL, target_key TEXT NOT NULL, ' +
    'phase TEXT NOT NULL, public_send_id TEXT, ' +
    'state TEXT NOT NULL, reason TEXT, policy_id TEXT NOT NULL, policy_version INTEGER NOT NULL, ' +
    'created_at REAL NOT NULL, expires_at REAL NOT NULL, finished_at REAL, ' +
    'PRIMARY KEY (tenant, authorization_id))'
  );
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS auth_send_idx ON send_authorizations(tenant, send_id)');
  db.exec('CREATE INDEX IF NOT EXISTS auth_count_idx ON send_authorizations(tenant, account_scope, created_at)');
  db.exec(
    'CREATE TABLE IF NOT EXISTS settings (' +
    'key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at REAL NOT NULL)'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS audit (' +
    'id TEXT PRIMARY KEY, tenant TEXT NOT NULL, action TEXT NOT NULL, ' +
    'metadata_json TEXT NOT NULL, created_at REAL NOT NULL)'
  );
  return db;
}

function id(prefix) {
  return prefix + '-' + crypto.randomBytes(12).toString('hex');
}

function readSetting(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch (error) {
    return fallback;
  }
}

function writeSetting(db, key, value, nowMs) {
  db.prepare('INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
    .run(key, JSON.stringify(value), nowMs / 1000);
}

function audit(db, tenant, action, metadata, nowMs) {
  db.prepare('INSERT INTO audit(id,tenant,action,metadata_json,created_at) VALUES(?,?,?,?,?)')
    .run(id('audit'), String(tenant), String(action), JSON.stringify(metadata || {}), nowMs / 1000);
}

// 与 probe 的 _quota_used 同口径：只算 4 个状态，小时/日都是滚动窗口。
function usage(db, tenant, accountScope, nowMs) {
  // 注意：node:sqlite 的语句方法必须带对接收者 —— 用 .apply(null, ...) 会抛
  // Illegal invocation。COUNTED_STATES 是常量，直接内联进 SQL 更安全也更清楚。
  const stateList = COUNTED_STATES.map(function (state) { return "'" + state + "'"; }).join(',');
  const rows = db.prepare(
    'SELECT target_key, created_at, state FROM send_authorizations ' +
    'WHERE tenant=? AND account_scope=? AND state IN (' + stateList + ')'
  ).all(tenant, accountScope);
  const nowSec = nowMs / 1000;
  let hourly = 0;
  let daily = 0;
  const perTarget = new Map();
  rows.forEach(function (row) {
    const createdAt = Number(row.created_at);
    if (createdAt >= nowSec - 3600) hourly += 1;
    if (createdAt >= nowSec - 86400) daily += 1;
    const key = String(row.target_key);
    perTarget.set(key, (perTarget.get(key) || 0) + 1);
  });
  return { hourly, daily, perTarget, total: rows.length };
}

function lastActionAt(db, tenant, accountScope) {
  const row = db.prepare(
    'SELECT MAX(created_at) AS at FROM send_authorizations WHERE tenant=? AND account_scope=?'
  ).get(tenant, accountScope);
  return row && row.at != null ? Number(row.at) * 1000 : null;
}

// 连续失败：从最近往回数，遇到 sent_confirmed 就停（与 probe 同口径）。
function consecutiveFailures(db, tenant, accountScope) {
  const rows = db.prepare(
    "SELECT state FROM send_authorizations WHERE tenant=? AND account_scope=? " +
    "AND state IN ('failed','blocked','unknown','sent_confirmed') " +
    'ORDER BY created_at DESC LIMIT 50'
  ).all(tenant, accountScope);
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i].state) === 'sent_confirmed') break;
    count += 1;
  }
  return count;
}

function findBySendId(db, tenant, sendId) {
  return db.prepare('SELECT * FROM send_authorizations WHERE tenant=? AND send_id=?').get(tenant, String(sendId)) || null;
}

function findById(db, tenant, authorizationId) {
  return db.prepare('SELECT * FROM send_authorizations WHERE tenant=? AND authorization_id=?')
    .get(tenant, String(authorizationId)) || null;
}

// 两阶段：服务端必须【见过】这个 publicSendId 被 commit 成 sent_confirmed。
function publicConfirmed(db, tenant, publicSendId) {
  const row = db.prepare(
    "SELECT * FROM send_authorizations WHERE tenant=? AND send_id=? AND state='sent_confirmed' AND phase='public'"
  ).get(tenant, String(publicSendId));
  return row || null;
}

module.exports = {
  DB_NAME, COUNTED_STATES, TERMINAL_STATES,
  open, id, readSetting, writeSetting, audit,
  usage, lastActionAt, consecutiveFailures,
  findBySendId, findById, publicConfirmed
};
