-- 006_admin_session.sql
-- 厂商管理后台的会话表。
--
-- 背景：`docs/部署指南-服务端.md` §7 把 `http://127.0.0.1:18080/admin-<随机串>/`
--   写成厂商看板入口，§9.3 规定了暴露面策略（SSH 隧道 > IP 白名单 > 随机路径 +
--   HTTPS + 会话 TTL）。但此前**没有任何后台会话存储**，于是"登录"只能退化成
--   HTTP Basic 或"前端记住一个口令"——两者都无法撤销、无法设 TTL、无法审计。
--
-- ⚠️ 三条设计约束（写在这里是为了让接手者知道哪些不能改）：
--
--   1. **只存 `sha256(token)`，绝不存明文令牌**。和 `device_session.token_hash`
--      同一立场：库被读走也无法直接冒用后台会话。
--      之所以不需要明文（不像 `sign_key_plain` 那样必须存），
--      是因为后台会话**不需要用令牌本身去校验 HMAC 签名**——
--      每次请求把 cookie 里的令牌做一次 sha256 查表即可。
--
--   2. **令牌与商家会话完全分表**。后台会话属于**厂商**，商家会话属于**商家**；
--      共用一张表会让"踢掉全部商家会话"这种运维动作有概率连自己也踢掉，
--      也会让 `MAX_DEVICES` 之类的商家侧规则莫名其妙地约束到后台。
--
--   3. **`expires_at_ms` 必须有值**（NOT NULL）。`ADMIN_SESSION_TTL_HOURS`
--      默认 12 小时；允许 NULL 就等于允许"永不过期的后台会话"，
--      而那正是 §9.3 想要避免的暴露面。
--
-- ⚠️ 加表而非改表，符合"迁移只做加法"（store/db.js 的硬约束 1）。

CREATE TABLE IF NOT EXISTS admin_session (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id       INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  -- ⚠️ sha256(token) 的 hex。明文令牌只在登录响应的 Set-Cookie 里出现一次。
  token_hash     TEXT    NOT NULL UNIQUE,
  -- 审计与排障用：登录时的来源 IP 与 User-Agent 摘要。
  -- ⚠️ 只存 IP 与 UA，绝不存密码、令牌、Cookie 全文。
  ip             TEXT    NOT NULL DEFAULT '',
  user_agent     TEXT    NOT NULL DEFAULT '',
  issued_at_ms   INTEGER NOT NULL,
  last_seen_ms   INTEGER NOT NULL,
  -- ⚠️ NOT NULL：后台会话必须会过期（部署指南 §9.3 的 ADMIN_SESSION_TTL_HOURS）
  expires_at_ms  INTEGER NOT NULL,
  -- 吊销：登出 / 改密 / 主动踢出。NULL 表示有效。
  revoked_at_ms  INTEGER,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_session_admin
  ON admin_session(admin_id, revoked_at_ms);

-- 过期清理按 expires_at_ms 扫描（服务端定时任务与每次鉴权时都会用到）
CREATE INDEX IF NOT EXISTS idx_admin_session_expires
  ON admin_session(expires_at_ms);
