-- 001_init.sql
-- 授权中心初始表结构。
--
-- ⚠️ 约定（见 shared/开发规范.md §5）：
--   · 时间字段一律整数 Unix 毫秒，后缀 _ms
--   · 金额/积分一律整数毫单位，后缀 _milli（1000 milli = 1 积分）
--   · 表名与字段名用 snake_case，与 shared/protocol.md 字段一一对应
--   · 本文件一旦发布**禁止修改**，修正请新加 002_xxx.sql
--
-- ⚠️ 迁移只做加法：不删列、不改类型，保证回滚旧代码仍能跑。

-- ═══════════════════════════════════════════════════════════
-- 商家账号
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS account (
  account_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  account         TEXT    NOT NULL UNIQUE,          -- 登录名（厂商下发，不支持自助注册）
  display_name    TEXT    NOT NULL DEFAULT '',
  pass_hash       TEXT    NOT NULL,                 -- scrypt，格式见 crypto/password.js
  status          TEXT    NOT NULL DEFAULT 'active',-- active | disabled | expired
  plan_id         INTEGER,
  plan_expires_ms INTEGER,
  device_limit    INTEGER NOT NULL DEFAULT 1,       -- 并发设备上限
  -- 账号首次成功登录时刻。等级天数索引由它推导（protocol.md §4.6）
  first_login_ms  INTEGER,
  note            TEXT    NOT NULL DEFAULT '',
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_status ON account(status);

-- ═══════════════════════════════════════════════════════════
-- 会话与令牌
-- ═══════════════════════════════════════════════════════════
-- ⚠️ 只存 token 的 sha256，不存明文。DB 泄露也无法直接冒用会话。
CREATE TABLE IF NOT EXISTS device_session (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES account(account_id) ON DELETE CASCADE,
  device_id     TEXT    NOT NULL,
  token_hash    TEXT    NOT NULL UNIQUE,            -- sha256(token) hex
  sign_key_hash TEXT    NOT NULL,                   -- sha256(sign_key) hex
  -- 单调递增序号。服务端拒绝 seq <= max_seq 的请求（防重放，protocol.md §5.4）
  max_seq       INTEGER NOT NULL DEFAULT 0,
  issued_at_ms  INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_account ON device_session(account_id, revoked_at_ms);
CREATE INDEX IF NOT EXISTS idx_session_expires ON device_session(expires_at_ms);

-- nonce 去重（防重放）。过期由清理作业删除。
CREATE TABLE IF NOT EXISTS request_nonce (
  nonce       TEXT PRIMARY KEY,
  account_id  INTEGER NOT NULL,
  seen_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonce_seen ON request_nonce(seen_at_ms);

-- 登录失败计数与锁定（暴力破解防护）
CREATE TABLE IF NOT EXISTS login_attempt (
  account       TEXT PRIMARY KEY,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER,
  last_fail_ms  INTEGER
);

-- ═══════════════════════════════════════════════════════════
-- 套餐与积分
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plan (
  plan_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key      TEXT    NOT NULL UNIQUE,            -- 稳定标识，如 plan_half_year
  name          TEXT    NOT NULL,
  credits       INTEGER NOT NULL,                   -- 积分条数
  valid_days    INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL DEFAULT 0,         -- ⚠️ 占位，由商务配置
  price_is_placeholder INTEGER NOT NULL DEFAULT 1,  -- 1 表示尚未定价
  is_default    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  -- ⚠️ hours 已废弃（计费模型从按小时改为按条数）。恒为 NULL，禁止据此展示。
  hours         INTEGER DEFAULT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credit (
  account_id    INTEGER PRIMARY KEY REFERENCES account(account_id) ON DELETE CASCADE,
  -- ⚠️ balance_milli 是整数毫单位，禁止 REAL
  balance_milli INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

-- ⚠️ 只增不改的台账（append-only）。已落账条目不得 UPDATE/DELETE。
--    纠错由反向 adjust 分录实现，note 记录原因与操作人。
CREATE TABLE IF NOT EXISTS credit_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL REFERENCES account(account_id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL,   -- recharge | consume | grant | adjust | refund | redeem
  delta_milli       INTEGER NOT NULL,   -- 正为入账，负为出账
  balance_after_milli INTEGER NOT NULL, -- 落账后的余额快照（便于对账）
  ref_send_id       TEXT,               -- 消耗类关联的发送明细
  ref_code_hash     TEXT,               -- 兑换类关联的卡密
  operator          TEXT    NOT NULL DEFAULT 'system',
  note              TEXT    NOT NULL DEFAULT '',
  settled_at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account_time ON credit_ledger(account_id, settled_at_ms);
CREATE INDEX IF NOT EXISTS idx_ledger_kind ON credit_ledger(kind, settled_at_ms);

-- 充值码（卡密）
CREATE TABLE IF NOT EXISTS redeem_code (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ⚠️ 只存哈希，不存明文卡密。明文只在生成时返回一次。
  code_hash     TEXT    NOT NULL UNIQUE,
  plan_id       INTEGER REFERENCES plan(plan_id),
  kind          TEXT    NOT NULL,           -- plan | credits
  credits       INTEGER NOT NULL DEFAULT 0,
  valid_days    INTEGER,
  batch         TEXT    NOT NULL DEFAULT '',
  used_by       INTEGER REFERENCES account(account_id),
  used_at_ms    INTEGER,
  disabled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_batch ON redeem_code(batch, used_at_ms);

-- ═══════════════════════════════════════════════════════════
-- 安全策略（红线 1）
-- ═══════════════════════════════════════════════════════════
-- 每账号一行；account_id IS NULL 的行为全局默认。
CREATE TABLE IF NOT EXISTS policy (
  account_id     INTEGER PRIMARY KEY,
  policy_version INTEGER NOT NULL DEFAULT 1,
  account_tier   TEXT    NOT NULL DEFAULT 'observation',
  policy_hash    TEXT    NOT NULL,
  policy_json    TEXT    NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);

-- 策略版本历史（含全局调整），量极小，长期保留
CREATE TABLE IF NOT EXISTS policy_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_version INTEGER NOT NULL,
  account_id     INTEGER,
  before_json    TEXT,
  after_json     TEXT    NOT NULL,
  operator       TEXT    NOT NULL,
  reason         TEXT    NOT NULL DEFAULT '',
  created_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_history_version ON policy_history(policy_version);

-- ⚠️ 契约硬要求（protocol.md §4.10）：证明"客户端确认应用了哪一版策略"。
--    这是红线 3 责任划分的关键证据——出事后要能回答
--    "当时实际生效的策略是什么、用户有没有主动调高过"。
CREATE TABLE IF NOT EXISTS policy_ack_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL,
  instance_id         TEXT    NOT NULL,
  policy_version      INTEGER NOT NULL,
  policy_hash         TEXT    NOT NULL,
  account_tier        TEXT    NOT NULL,
  account_day_index   INTEGER NOT NULL,
  applied_limits_json TEXT    NOT NULL,   -- 客户端上报的**实际生效**上限（须 ≤ 策略值）
  first_ack_at_ms     INTEGER NOT NULL,
  last_seen_at_ms     INTEGER NOT NULL,
  UNIQUE(account_id, instance_id, policy_version)
);
CREATE INDEX IF NOT EXISTS idx_policy_ack_account ON policy_ack_log(account_id, last_seen_at_ms);

-- ═══════════════════════════════════════════════════════════
-- 审计（红线 2 + 红线 3）
-- ═══════════════════════════════════════════════════════════
-- 发送明细：计费与举证的核心。
-- ⚠️ 隐私：只存哈希（target_hash / user_key_hash / content_hash），
--    绝不存评论原文、回复原文、sec_uid 原文（需求 NFR-7）。
CREATE TABLE IF NOT EXISTS send_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL,
  instance_id           TEXT    NOT NULL DEFAULT '',
  -- ⚠️ send_id 是幂等键与计费键，客户端必须在**发送前**生成并落盘。
  --    UNIQUE 约束是"重复上报不重复扣费"的根本保证。
  send_id               TEXT    NOT NULL,
  source_type           TEXT    NOT NULL,   -- comment | live_danmaku | dm
  target_hash           TEXT,
  user_key_hash         TEXT,
  user_key_type         TEXT,
  content_hash          TEXT,
  verdict               TEXT    NOT NULL,   -- 闭集四值，见 shared/lib/protocol.js
  confirm_signal        TEXT,               -- platform_response | dom_stable | none
  platform_endpoint     TEXT,               -- 闭集白名单
  platform_status_code  INTEGER,
  failure_reason        TEXT,               -- 闭集，见 shared/lib/errors.js
  -- 计费结果。只有 billed 会写台账。
  billing_status        TEXT    NOT NULL,
  charged_milli         INTEGER NOT NULL DEFAULT 0,
  applied_policy_version INTEGER,
  -- 实际生效的策略值（非用户设置值）。红线 3 要求。
  policy_snapshot_json  TEXT,
  sent_at_ms            INTEGER NOT NULL,   -- 客户端事件时间（已按 clock_skew 校准）
  received_at_ms        INTEGER NOT NULL,   -- 服务端接收时间（权威）
  client_version        TEXT,
  device_id             TEXT,
  report_id             TEXT,               -- 批次幂等键
  UNIQUE(account_id, send_id)
);
CREATE INDEX IF NOT EXISTS idx_send_account_time ON send_log(account_id, sent_at_ms);
CREATE INDEX IF NOT EXISTS idx_send_billing ON send_log(billing_status, sent_at_ms);
CREATE INDEX IF NOT EXISTS idx_send_verdict ON send_log(verdict, sent_at_ms);

-- 配置变更审计：回答"用户是否主动调高过、系统是否拒绝过"（红线 3）
CREATE TABLE IF NOT EXISTS audit_config_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id      TEXT    NOT NULL UNIQUE,
  account_id     INTEGER NOT NULL,
  instance_id    TEXT,
  changed_at_ms  INTEGER NOT NULL,
  source         TEXT    NOT NULL,   -- user | server_policy | default
  actor          TEXT,               -- local_user | license_server | admin:<name>
  field_key      TEXT    NOT NULL,   -- 如 limits.dm.daily_max
  old_value      TEXT,
  new_value      TEXT,
  applied        INTEGER NOT NULL,   -- 1/0：是否实际生效
  reject_code    TEXT,               -- 被拒时的错误码，如 POLICY_VIOLATION
  policy_version INTEGER,
  received_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cfg_account_time ON audit_config_changes(account_id, changed_at_ms);

-- 聚合上报（统计用途，**不是计费依据**；计费只看 send_log 明细）
CREATE TABLE IF NOT EXISTS usage_report (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id     TEXT    NOT NULL UNIQUE,   -- 幂等键
  account_id    INTEGER NOT NULL,
  instance_id   TEXT    NOT NULL DEFAULT '',
  window_start_ms INTEGER,
  window_end_ms   INTEGER,
  -- 仅运营统计，**不用于计费**（protocol.md §6）
  online_seconds INTEGER NOT NULL DEFAULT 0,
  payload_json  TEXT    NOT NULL,
  received_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_account_time ON usage_report(account_id, window_end_ms);

-- ═══════════════════════════════════════════════════════════
-- 服务端自身
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  pass_hash     TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'admin',
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at_ms INTEGER NOT NULL,
  last_login_ms INTEGER
);

-- 管理员操作留痕（谁在什么时候改了谁的什么）
CREATE TABLE IF NOT EXISTS admin_action_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id      INTEGER,
  admin_name    TEXT    NOT NULL DEFAULT '',
  action        TEXT    NOT NULL,   -- create_account | recharge | plan_set | code_batch | policy_set ...
  target        TEXT    NOT NULL DEFAULT '',
  detail_json   TEXT,
  at_ms         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_action_time ON admin_action_log(at_ms);
