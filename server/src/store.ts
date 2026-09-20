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
CREATE TABLE IF NOT EXISTS workflow_definitions (
  workflow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  contract_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES admins(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workflow_id, version)
);
CREATE TABLE IF NOT EXISTS knowledge_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS knowledge_sets_user_idx ON knowledge_sets(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  knowledge_set_id TEXT NOT NULL REFERENCES knowledge_sets(id) ON DELETE CASCADE,
  knowledge_set_version INTEGER NOT NULL CHECK(knowledge_set_version > 0),
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_documents_scope_idx ON knowledge_documents(user_id, knowledge_set_id, knowledge_set_version);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  knowledge_set_id TEXT NOT NULL REFERENCES knowledge_sets(id) ON DELETE CASCADE,
  knowledge_set_version INTEGER NOT NULL CHECK(knowledge_set_version > 0),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  text TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_scope_idx ON knowledge_chunks(user_id, knowledge_set_id, knowledge_set_version);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  platform_account_id TEXT,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  knowledge_set_id TEXT REFERENCES knowledge_sets(id),
  knowledge_set_version INTEGER,
  status TEXT NOT NULL CHECK(status IN ('PLANNED','RUNNING','CHECKPOINT','UNKNOWN','WAITING_HUMAN','PAUSED','COMPLETED','FAILED','STOPPED')),
  current_step TEXT,
  checkpoint_version INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_version >= 0),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  failure_json TEXT,
  human_wait_json TEXT,
  recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts >= 0),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_device_id TEXT,
  lease_expires_at INTEGER,
  UNIQUE(user_id, idempotency_key),
  FOREIGN KEY(workflow_id, workflow_version) REFERENCES workflow_definitions(workflow_id, version)
);
CREATE INDEX IF NOT EXISTS workflow_runs_user_idx ON workflow_runs(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS workflow_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','consumed','expired','revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY(workflow_id, workflow_version) REFERENCES workflow_definitions(workflow_id, version)
);
CREATE INDEX IF NOT EXISTS workflow_plans_user_idx ON workflow_plans(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS platform_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, platform, account_ref)
);
CREATE INDEX IF NOT EXISTS platform_accounts_user_idx ON platform_accounts(user_id, status);
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL,
  step_id TEXT,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  target_state_json TEXT NOT NULL DEFAULT '{}',
  failure_json TEXT,
  human_wait_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, version)
);
CREATE INDEX IF NOT EXISTS workflow_checkpoints_run_idx ON workflow_checkpoints(run_id, version DESC);
CREATE TABLE IF NOT EXISTS credit_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
  ledger_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, action_key)
);
CREATE INDEX IF NOT EXISTS credit_actions_active_idx ON credit_actions(user_id, status);
`;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(schema);
    // Keep databases created before the workflow slice readable. SQLite cannot
    // add a NOT NULL column without a default, so the migration uses an empty
    // value for legacy rows; new runs always provide a plan id.
    const columns = this.all<{ name: string }>('PRAGMA table_info(workflow_runs)');
    if (!columns.some((column) => column.name === 'plan_id')) this.db.exec("ALTER TABLE workflow_runs ADD COLUMN plan_id TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === 'platform_account_id')) this.db.exec("ALTER TABLE workflow_runs ADD COLUMN platform_account_id TEXT");
    if (!columns.some((column) => column.name === 'lease_owner')) this.db.exec("ALTER TABLE workflow_runs ADD COLUMN lease_owner TEXT");
    if (!columns.some((column) => column.name === 'lease_device_id')) this.db.exec("ALTER TABLE workflow_runs ADD COLUMN lease_device_id TEXT");
    if (!columns.some((column) => column.name === 'lease_expires_at')) this.db.exec("ALTER TABLE workflow_runs ADD COLUMN lease_expires_at INTEGER");
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
