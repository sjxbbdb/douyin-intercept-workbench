-- 004_seq_counter_and_sign_key.sql
-- 序号计数器 + 签名密钥存储方式说明。
--
-- ═══════════════════════════════════════════════════════════
-- 1) 序号计数器（防重放，protocol.md §5.4）
-- ═══════════════════════════════════════════════════════════
-- ⚠️ 为什么不用 device_session.max_seq 一个字段：
--    契约要求 seq 按 (account_id, device_id, session_id, channel) 记录，
--    **各通道独立计数**。心跳与上报共用同一个计数器会互相挤压——
--    心跳把 seq 推到 100，上报的 seq=5 就会被误判为重放。
CREATE TABLE IF NOT EXISTS seq_counter (
  counter_key   TEXT PRIMARY KEY,   -- accountId:sessionId:channel
  account_id    INTEGER NOT NULL,
  session_id    INTEGER NOT NULL,
  channel       TEXT    NOT NULL,   -- heartbeat | usage | sends | config_audit
  max_seq       INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seq_account ON seq_counter(account_id, updated_at_ms);

-- ═══════════════════════════════════════════════════════════
-- 2) 签名密钥存储
-- ═══════════════════════════════════════════════════════════
-- ⚠️ **权衡说明（必须知情）**：
--
-- HMAC 是对称签名——服务端要验签，就必须持有与客户端相同的密钥明文。
-- 因此 `sign_key_plain` 无法只存哈希。这带来一个取舍：
--
--   · 存明文 → DB 泄露时攻击者可伪造任意请求
--   · 不存明文 → 无法验签（HMAC 的性质决定），除非改用非对称签名
--
-- 本项目选择**存明文**，理由：
--   1. 授权中心是厂商自建、仅自己访问的私有服务，不是多租户 SaaS
--   2. 会话密钥有效期 7 天（token_ttl_ms），泄露窗口有限
--   3. 改用 Ed25519 需引入密钥对管理，复杂度上升而收益有限
--      （真正的防线是"客户端本地不存可信数据"，见红线 1）
--
-- ⚠️ 若将来部署到非受信环境，应改存密文（用服务器主密钥加密）
--    或改用非对称签名。此处留痕以便接手者知情。
ALTER TABLE device_session ADD COLUMN sign_key_plain TEXT;

-- 已有会话无明文密钥（迁移前建立的），标记为需要重新登录
UPDATE device_session SET revoked_at_ms = COALESCE(revoked_at_ms, 0),
                          revoked_reason = COALESCE(revoked_reason, 'pre_migration_key_unavailable')
WHERE sign_key_plain IS NULL AND revoked_at_ms IS NULL;
