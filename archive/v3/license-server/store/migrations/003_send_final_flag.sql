-- 003_send_final_flag.sql
-- 判定终局标记。
--
-- 背景：契约 §6.3 规定同一 send_id 的判定可以**单向升级**
--   （sent_suspected / sent_confirmed_dom / failed → sent_confirmed 且带平台证据），
--   升级后该条即"终局"，不再接受任何后续判定。
--   而"已终局"这个事实本身需要被记录，否则无法区分
--   "本条是首次上报的 suspected" 与 "本条是升级后的 confirmed"。
--
-- ⚠️ 这是加列而非改表，符合"迁移只做加法"约束。
ALTER TABLE send_log ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;

-- 已计费或已升级的条目视为终局（历史数据回填）
UPDATE send_log SET is_final = 1
WHERE verdict = 'sent_confirmed' OR billing_status = 'billed';

CREATE INDEX IF NOT EXISTS idx_send_final
  ON send_log(account_id, is_final, received_at_ms);
