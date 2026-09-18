-- 002_billing_state.sql
-- 计费状态与配额标记。
--
-- ⚠️ 为什么新加文件而不是改 001：
--    001 已发布，其 checksum 记在库中。改动会让 db.js 的校验失败
--    （这是刻意设计——防止已应用的迁移被偷改导致新旧环境 schema 静默不一致）。
--    **迁移只做加法**，修正一律新加文件。

-- 计费状态。与 credit 分表的原因：
--   credit 是"钱"，account_billing 是"状态"，两者写入时机不同
--   （钱只在充值/扣费时变，状态在心跳、停机、恢复时都可能变）。
CREATE TABLE IF NOT EXISTS account_billing (
  account_id     INTEGER PRIMARY KEY REFERENCES account(account_id) ON DELETE CASCADE,
  -- 1 表示已触及透支边界。此后不再允许透支，只留痕不扣费（protocol.md §6.5）
  insufficient   INTEGER NOT NULL DEFAULT 0,
  -- active | exhausted | suspended
  state          TEXT    NOT NULL DEFAULT 'active',
  updated_at_ms  INTEGER NOT NULL
);

-- ⚠️ 记录该条是否在超出当日策略上限时发生（含观察期上限为 0 的情形）。
--    单独成列而非从 billing_status 推断，是因为 policy_exceeded 的明细
--    仍可能因判定升级而被计费，届时需要保留"曾经越限"这一事实用于审计。
ALTER TABLE send_log ADD COLUMN over_limit INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_send_over_limit
  ON send_log(account_id, over_limit, sent_at_ms);
