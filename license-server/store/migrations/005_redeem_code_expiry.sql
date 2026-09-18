-- 005_redeem_code_expiry.sql
-- 充值码有效期。
--
-- 背景：卡密是甲方批量生成、分发给渠道或客户的预付凭证。
--   若永久有效，一张流失的卡密会长期构成风险（如印在宣传单上被重复利用）。
--   因此需要可选的过期时间。
--
-- ⚠️ 加列而非改表，符合"迁移只做加法"。
ALTER TABLE redeem_code ADD COLUMN expires_at_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_code_expiry
  ON redeem_code(expires_at_ms, used_at_ms);
