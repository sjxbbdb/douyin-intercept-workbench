import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  expires_at INTEGER NOT NULL, max_devices INTEGER NOT NULL DEFAULT 1 CHECK(max_devices > 0),
  features_json TEXT NOT NULL DEFAULT '{"evaluate":true,"draft":false}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, device_name TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, revoked_at INTEGER, UNIQUE(user_id, device_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL, balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
  kind TEXT NOT NULL, idempotency_key TEXT, payload_hash TEXT, metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger(user_id, id);
CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, code_hint TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK(credits > 0), status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','redeemed','disabled')), expires_at INTEGER NOT NULL,
  redeemed_by TEXT REFERENCES users(id), redeemed_at INTEGER
);
CREATE TABLE IF NOT EXISTS idempotency (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, idem_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  response_json TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id, scope, idem_key)
);
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner TEXT NOT NULL, hold_key TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','captured','released')),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, hold_key)
);
CREATE INDEX IF NOT EXISTS holds_active_idx ON holds(status, expires_at);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, target_user_id TEXT, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(schema);
  }
  now() { return Date.now(); }
  exec(sql: string) { this.db.exec(sql); }
  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: any[]) { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: any[]) { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch (rollbackError) { console.error('sqlite rollback failed', rollbackError); } throw error; }
  }
  close() { this.db.close(); }
}
