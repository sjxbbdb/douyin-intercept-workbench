# 抖音截流工作台 — 客户端 ↔ 授权中心 接口契约

- 契约版本 `protocol_version = 2`（前缀 `/api/v1/`；相对 v1 不兼容：计费模型整体替换）｜适用：license-server（厂商部署）与 client（商家本机）｜命名：**全篇 JSON 字段统一 `snake_case`**
- 本文档是唯一权威口径。实现与本文冲突时以本文为准，并先改文档再改代码。
- **安全上限是产品核心交付价值**（"控制节奏、让账号活得久"）：§4.6 的 `tier_table` 是甲方已确认的权威安全规格，**任何实现都不得放宽、不得硬编码到客户端、不得在别处重复写死**；套餐积分与所有文案必须由该表实时推导（见 4.14、8.2）。

## 1. 概述
### 1.1 双方角色

| 角色 | 部署位置 | 职责 | 技术约束 |
|---|---|---|---|
| **license-server（授权中心）** | 厂商服务器 | 账号、积分、套餐、卡密、**安全策略下发**、发送计费、审计留痕、统计看板 | Node ≥ 22.5，内置 `node:sqlite`，零第三方依赖 |
| **client（客户端）** | 商家本机 Windows | CDP 驱动本机 Chrome；多抖音账号实例采集与自动回复；只展示与上报 | Node 运行时，允许极少量依赖（`ws` 等） |

### 1.2 四条不可动摇的边界
1. **积分是服务端权威数据**：客户端不存权威余额、不做本地加减分；本地只保留服务端下发的余额副本，用于展示与"欠费停机"。
2. **只对平台确认的成功回复计费**：失败、风控拒绝、被跳过、未命中规则一律不计费。计费依据是**逐条发送明细**（含平台响应证据），不是客户端自报的汇总数字。
3. **安全策略由服务端权威下发，客户端只能更保守**；上报的生效配置比服务端策略更激进即被拒绝（`POLICY_VIOLATION`）。
4. **严禁本地伪造积分继续跑**：离线期只能用"只减不增、由上次服务端下发值推导"的影子额度自限；签名校验失败一律 fail-closed（停止发送）。

### 1.3 通信方式与时间格式
- **HTTPS + JSON**；生产强制 TLS，客户端必须校验证书（禁止 `rejectUnauthorized: false`）。请求头 `Content-Type: application/json; charset=utf-8`、`Accept: application/json`；编码 **UTF-8 无 BOM**。
- 签名对**原始请求/响应字节**计算：服务端校验用原始 buffer，**不得反序列化后重新序列化再算哈希**。
- 可选增强：客户端可用 `ws` 接收"立即停机/策略变更"推送，但**所有关键状态必须以 HTTPS 响应为准**，不得依赖推送。
- **时间统一为 Unix 毫秒（int64，UTC 起算），所有时间字段以 `_ms` 结尾**。理由：需要大量整数比较与时间窗运算，ISO8601 会引入时区/解析歧义，`node:sqlite` 更适配整数；客户端展示时自行转本地时区。
- 统计"自然日"边界由 `stats_tz_offset_minutes` 决定，**默认 480（UTC+8）**；策略日上限、等级天数边界（`account_day_index`）同样按该时区计算。
- **以服务端时间为准**：每个响应带 `server_time_ms`；客户端维护 `clock_skew_ms` 并在填写上报 `*_ms` 前校准，该值本身仅作诊断。客户端时长类字段必须用单调时钟计算（Node：`process.hrtime.bigint()`）。
- 主版本在 URL 前缀 `/api/v1/`，仅在**不兼容变更**时递增；请求/响应均带 `protocol_version`(int)，高于服务端支持上限 → `SERVER_VERSION_UNSUPPORTED`；同一主版本内**只增不删**（§8）。

### 1.4 默认配置项（服务端可配，此处为出厂默认值）

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `credit_per_reply` / `bill_dom_confirmed` | `1`（`credit_per_reply_milli = 1000`） / `false` | **每条平台确认成功的回复**计费积分（0.1 ≤ x ≤ 1000，步进 0.1）/ 仅凭 DOM 稳定判据的确认是否计费（默认否） |
| `heartbeat_interval_ms` / `heartbeat_timeout_ms` | `60000` / `180000` | 心跳间隔 / 判离线阈值（连续 3 次未收到） |
| `send_batch_interval_ms` / `send_batch_max` / `audit_batch_max` / `config_audit_batch_max` | `300000` / `50` / `500` / `200` | 发送明细上报周期 5 分钟 / 常规单批 / 补报单批 / 配置审计单批上限 |
| `offline_send_grace_ms` / `offline_budget_ratio` | `900000` / `0.5` | 断网后可按已知余额继续发送 15 分钟 / 影子额度比例 |
| `grace_ms` / `idle_pause_ms` | `86400000` / `7200000` | 断网宽限 24 小时（超过进入暂停态）/ 连续零命中 2 小时进 `idle` 停发（**运营策略，与计费无关**） |
| `token_ttl_ms` / `token_refresh_window_ms` / `token_overlap_ms` | `604800000` / `2592000000` / `300000` | 会话 7 天 / 续期窗口 30 天 / 旧 token 在途宽限 5 分钟 |
| `device_limit` / `login_fail_limit` / `login_lock_ms` | `1` / `5` / `600000` | 并发设备上限 / 密码错误阈值 / 锁定 10 分钟 |

| `max_pending_sends` / `min_client_version` / `stats_tz_offset_minutes` / `sign_ts_tolerance_ms` / `nonce_ttl_ms` | `20000` / `3.0.0` / `480` / `300000` / `600000` | 本地待上报上限（超出丢最旧并告警）/ 最低客户端版本 / 统计时区 / 签名时间戳容忍 ±5 分钟 / nonce 保留 10 分钟 |
| `active_hours_default` / `min_interval_ms_range` | `[["08:00","23:00"]]` / comment `60000–180000` / live_danmaku `30000–90000` / dm `300000–900000` | 默认活跃时段（**单一窗口 08:00–23:00**；客户端只能调更短，不可延长或新增窗口） / 各渠道最小发送间隔的**允许区间**；服务端取值必须落在区间内，客户端只能取更长间隔 |
| `tier_day_boundaries` | observation 1–3 / warm_up 4–7 / ramp_up 8–14 / stable 15+ | 账号等级按**天数边界**判定（见 4.6），不得写成自定义区间 |
| `stable_daily_max_total` / `plan_credit_ratio` / `min_plan_credit` | `70` / `1.0` / `12600` | 稳定期三来源日上限合计（评论 30 + 弹幕 30 + 私信 10，区间取上限）/ 套餐折扣系数 / 半年套餐最低积分（**运行时由 tier_table 推导，不得写死**） |

## 2. 认证模型
### 2.1 会话、续期与失效
- `POST /auth/login` 用账号密码换 `token`（32 字节随机 hex，服务端只存 `sha256(token)`），有效期 `token_ttl_ms`（7 天）；**除登录、bootstrap 外所有接口**必须带 `Authorization: Bearer <token>`。
- 续期：**每次进程启动静默续期**，运行中剩余有效期 < 24 小时时续期；心跳响应若带新 `token_expires_ms` 亦须原子落盘。剩余有效期 > 0 → `POST /auth/refresh` 换新 token；已过期但未超 `token_refresh_window_ms`（30 天）→ 仍可用旧 token 调 refresh；超过 → 必须重新登录（`AUTH_TOKEN_EXPIRED`）。轮换：续期签发新 token，旧 token 标记 `rotated`，在 `token_overlap_ms`（5 分钟）内仍可鉴权，覆盖在途请求。 ｜ 失效：登出、被踢、账号停用、账号到期、**余额耗尽停机**、密码重置都立即失效。

### 2.2 设备数超限
客户端首启生成 `device_id`（16 字节 hex）持久化，重装视为新设备。登录时统计未失效会话数：未达 `device_limit`（默认 1）正常签发；已达上限则**踢掉最早创建的会话**（其调用返回 `AUTH_TOKEN_REVOKED`），响应带 `kicked_device_id`；异常仍无法落位 → `AUTH_DEVICE_LIMIT`(409)。被踢客户端**立即停止发送**、清除本地 token；**不得自动踢回**（避免活锁），须商家手工重新登录。

### 2.3 登录失败、密码存储与签名前置
- 按账号维度计数：累计失败 `login_fail_limit`（5）次 → 锁定 `login_lock_ms`（10 分钟），期间任何密码都返回 `AUTH_ACCOUNT_LOCKED`(423) + `retry_after_ms`；登录成功清零。账号不存在/密码错误/已停用/已到期必须返回不同错误码（见 §3）。 ｜ 密码：`scrypt(N=16384, r=8, p=1, keylen=32, salt=16B 随机)`，存 `scrypt$N$r$p$salt_hex$hash_hex`，比较用 `timingSafeEqual`；**禁止明文/可逆加密**。**不提供注册接口**，账号由厂商后台创建。
- 除 `POST /auth/login` 与 `GET /client/bootstrap` 外，**所有请求与响应都必须签名**。客户端收到带 token 的响应必须**先验签再解析业务字段**；验签失败一律按网络失败处理，**绝不认为余额充足、绝不认为策略放宽**（§5）。

## 3. 错误码总表
### 3.1 统一信封
失败：`{"ok":false,"code":"POLICY_VIOLATION","message":"客户端上报的生效配置高于服务端策略","detail":{"source_type":"dm","field":"daily_max","reported":30,"allowed":10,"policy_version":7},"server_time_ms":1758096060000}`
成功：`{"ok":true, ...}`，业务字段平铺顶层。客户端判断成功**只看 `ok`**，不看 HTTP 状态码。

### 3.2 错误码表

| code | HTTP | 含义 | 客户端动作 |
|---|---|---|---|
| `AUTH_INVALID_REQUEST` | 400 | 请求体缺字段/类型错/超长 | 记日志，不重试；本地 bug 需修复 |
| `AUTH_ACCOUNT_NOT_FOUND` | 401 | 账号不存在 | 提示"账号不存在，请联系客服开通" |
| `AUTH_PASSWORD_WRONG` | 401 | 密码错误（带 `remaining_attempts`） | 提示剩余次数；不得自动重试 |
| `AUTH_ACCOUNT_LOCKED` | 423 | 错误次数过多已锁定 | 按 `retry_after_ms` 倒计时，禁用登录 |
| `AUTH_ACCOUNT_DISABLED` / `AUTH_ACCOUNT_EXPIRED` / `AUTH_FORBIDDEN` | 403 | 账号已停用 / 账号或套餐已到期 / 无权访问该资源 | 停机 + 提示联系客服或续费；无权访问则停机并上报日志 |
| `AUTH_TOKEN_MISSING` / `AUTH_TOKEN_INVALID` | 401 | 未带 token / token 无法识别 | 走续期流程；仍失败则清本地 token 重新登录 |
| `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_REVOKED` | 401 | 过期且超出续期窗口 / 已被踢、登出或密码重置 | 重新输入密码登录 / 停止发送、清 token、提示"已在其他设备登录" |
| `AUTH_DEVICE_LIMIT` | 409 | 设备数超限且无法踢除 | 停止发送，提示联系客服 |
| `AUTH_SIGN_MISSING` / `AUTH_SIGN_INVALID` | 401 | 缺签名头 / 签名不匹配 | 本地 bug 或中间人攻击：fail-closed 停机、清密钥并重新登录 |
| `AUTH_SIGN_KEY_UNKNOWN` | 401 | 密钥已轮换且超出重叠窗口 | 重新登录获取新 `sign_key` |
| `AUTH_TS_SKEW` | 401 | 时间戳偏离超过 5 分钟 | 用 `server_time_ms` 校准后**只重试一次** |
| `AUTH_REPLAY` | 401 | nonce 重复或通道内序号回退 | 停止发送；重新登录重置会话后重试 |

| `CREDIT_EXHAUSTED` | 402 | 余额 ≤ 0，拒绝心跳续期 | **≤60 秒内进入暂停态**，提示"积分不足，请联系客服充值" |
| `CREDIT_ACCOUNT_SUSPENDED` | 402 | 欠费超宽限期，账号停用 | 停机，仅保留充值入口 |
| `CREDIT_LEDGER_NOT_FOUND` / `CREDIT_REDEEM_CODE_INVALID` | 404 | 流水查询范围无数据 / 卡密不存在 | 展示空列表不弹错误 / 提示"卡密无效" |
| `CREDIT_REDEEM_CODE_USED` | 409 | 卡密已被使用（带 `used_at_ms`） | 提示已使用时间 |
| `CREDIT_REDEEM_CODE_EXPIRED` / `_DISABLED` | 410 / 403 | 卡密已过期 / 已作废或绑定其他账号 | 提示联系客服换新 / 提示不可用 |
| `CREDIT_REDEEM_ALREADY_DONE` | 200 | 同 `request_id` 重复兑换（幂等命中） | 展示首次结果 |
| `PLAN_NOT_FOUND` | 404 | 套餐不存在 | 展示错误，不重试 |
| `PLAN_QUOTA_BELOW_MIN` / `PLAN_INVALID_DURATION` | 400 | 发放积分低于 `min_plan_credit`（由策略表推导，默认 12600）/ `valid_days` ≤ 0 或 > 3650 | 提示管理员调整套餐或修正时长 |
| `PLAN_ALREADY_ACTIVE` | 409 | 同套餐已生效且未到期 | 提示剩余天数 |
| `POLICY_VIOLATION` | 409 | 上报的生效配置比服务端策略**更激进**（上限更高 / 间隔更短 / 相似度阈值更高 / 时段更长） | 立即改成服务端值或更保守并重新上报；**不得继续按激进配置发送** |
| `POLICY_VERSION_UNKNOWN` | 409 | `applied_policy_version` 服务端无记录 | 拉 `GET /policy/current` 对齐后重报；该批不落账不计费 |
| `POLICY_TIER_UNKNOWN` | 400 | 账号等级枚举非法或客户端伪造等级 | 等级**只以服务端下发为准**；停机告警 |
| `POLICY_ACK_REQUIRED` | 409 | 未携带生效策略版本就上报发送明细 | 先发一次心跳完成策略 ack，再重报 |
| `POLICY_SENDING_DISABLED` | 409 | 账号当前等级禁止发送（观察期，三来源 `daily_max` 全 0） | **立即停止一切发送，仅保留采集**；心跳与明细仍照常上报，服务端留痕但不计费 |
| `POLICY_DAILY_CAP_EXCEEDED` | 200 | 本批超出当日策略上限（`over_limit`，含观察期全 0） | 服务端接受明细但**超额部分不计费**；客户端立即降速至上限内 |
| `POLICY_CIRCUIT_OPEN` | 409 | 账号处于熔断冷却期，禁止发送 | 停止发送，等 `cooldown_until_ms`；不上报新明细 |
| `AUDIT_SEND_INVALID` / `AUDIT_CONFIG_INVALID` | 400 | 发送明细或配置审计字段缺失/枚举非法/含禁用字段 | 丢弃该条并记本地错误日志，不重试 |
| `AUDIT_SEND_CONFLICT` | 409 | 同 `send_id` 内容冲突（降级/来源或时间不一致） | 丢弃该条；客户端 bug，立即告警 |
| `AUDIT_BATCH_TOO_LARGE` / `REPORT_TOO_LARGE` | 413 | 审计或聚合上报的批量条数超上限，或请求体 > 2 MB | 拆小后重报 |
| `REPORT_INVALID` / `REPORT_PRIVACY_VIOLATION` | 400 | 聚合上报字段缺失/自相矛盾 / 出现禁用字段（见 7.5） | 丢弃该条并记日志 / 丢弃该条并立即修复客户端，不重试 |

| `RATE_TOO_MANY_REQUESTS` / `SERVER_INTERNAL` | 429 / 500 | 通用限流 / 心跳间隔 < 30 秒 / 服务端异常 | 按 `retry_after_ms` 退避重试；心跳过快则忽略本次 / 按网络失败处理，退避重试（1s/2s/4s，上限 60s） |
| `SERVER_DB_BUSY` / `SERVER_UNAVAILABLE` | 503 | SQLite 忙 / 维护中不可用 | 1 秒后重试最多 3 次 / 进入离线降级逻辑（见 9.3） |
| `SERVER_VERSION_UNSUPPORTED` | 426 | 客户端协议/版本过低 | 立即停机并展示强制升级页与 `upgrade_url` |

## 4. 接口清单
约定：所有响应含 `server_time_ms`；除登录与 bootstrap 外全部签名（§5）；金额一律 **`_milli` 整数**，`1000 milli = 1 积分`。

### 4.1 `POST /api/v1/auth/login`（无需鉴权，**不签名**）

| 字段 | 类型 | 必填 | 说明 / 示例 |
|---|---|---|---|
| `account` | string | 是 | 商家账号 `"shop_1001"` |
| `password` | string | 是 | 明文密码，仅出现在此请求体 |
| `device_id` | string | 是 | 设备指纹 32 hex `"9f2c8a1d4e6b70c35a1f8d2e4b6c0a93"` |
| `device_name` | string | 否 | 展示名 `"店面主机"` |
| `install_id` | string | 是 | 安装 ID（uuid v4），重装后变化 |
| `client_version` / `protocol_version` | string / int | 是 | `"3.0.0"` / `2` |
| `os` | string | 否 | `win32`/`darwin`/`linux` |

```json
{"ok":true,"server_time_ms":1758096000000,"protocol_version":2,"token":"b7f1c0...e4a9","token_expires_ms":1758700800000,
 "sign_key":"3d91ab...07fe","sign_key_expires_ms":1758700800000,"privacy_salt":"a41c9b...2d77","privacy_salt_version":1,
 "account":{"account_id":"acc_1001","display_name":"示例店铺","status":"active","plan_id":"plan_half_year","plan_expires_ms":1773676800000,"device_limit":1},
 "credit":{"balance_milli":12600000,"credit_per_reply_milli":1000,"updated_at_ms":1758096000000},
 "policy":{"policy_version":7,"account_tier":"observation","account_day_index":2,"tier_day_from":1,"tier_day_to":3,"sending_enabled":false,"collect_only":true,
   "next_tier":{"tier":"warm_up","day_from":4,"effective_at_ms":1758182400000},"active_hours":{"tz_offset_minutes":480,"windows":[["08:00","23:00"]]},
   "limits":{"comment":{"daily_max":0,"min_interval_ms":180000,"content_similarity_max":0.85},"live_danmaku":{"daily_max":0,"min_interval_ms":90000,"content_similarity_max":0.85},"dm":{"daily_max":0,"min_interval_ms":900000,"content_similarity_max":0.75,"new_conversation_daily_max":0}},
   "circuit_breaker":{"failure_rate_threshold":0.4,"failure_rate_window":20,"platform_reject_threshold":3,"cooldown_ms":1800000,"risk_code_cooldown_ms":86400000},"idle_pause_ms":7200000,"effective_from_ms":1758009600000,"expires_ms":1758700800000,"policy_hash":"5b2e...a10c"},
 "quota_notice":{"headline":"当前处于观察期，仅采集线索，第 4 天开始可发送","detail":"观察期（第 1–3 天）平台发送上限为 0：客户端只采集线索，不发送任何评论、弹幕或私信。第 4 天起进入预热期（评论 10 条/天、弹幕 10 条/天、私信 3 条/天）。积分只对平台确认成功的回复扣减，失败与被风控拒绝不扣费。","tier":"observation","account_day_index":2,"collect_only":true,"daily_cap_total":0,"daily_cap_detail":{"comment":0,"live_danmaku":0,"dm":0},"credits_per_day_at_cap":0,"valid_days":180,"credits":12600,"next_tier_at_day":4,"generated_from_policy_version":7},
 "limits":{"heartbeat_interval_ms":60000,"grace_ms":86400000,"send_batch_interval_ms":300000,"send_batch_max":50,"audit_batch_max":500,"offline_send_grace_ms":900000,"offline_budget_ratio":0.5,"sign_ts_tolerance_ms":300000,"max_pending_sends":20000},
 "kicked_device_id":null,"min_client_version":"3.0.0","force_upgrade":false,"upgrade_url":"https://license.example.com/download","login_proof":"c81f...9ab3"}
```
**`login_proof`（首次信任建立）**：登录响应本身不签名（密钥就在响应里），故用密码派生密钥证明未被篡改：
```js
const login_key = pbkdf2Sync(password, 'dsh-login|'+account+'|'+device_id, 100000, 32, 'sha256')
const body = { ...loginResponse }; delete body.login_proof          // 覆盖范围排除自身
if (hmacHex(login_key, sha256Hex(stableStringify(body))) !== loginResponse.login_proof) throw new Error('登录响应被篡改')
```
`stableStringify`：递归按 key 升序、无空格。校验失败 → 拒绝登录并提示网络不安全。**响应中的 `policy` 是权威安全策略**，客户端必须原样采纳（或更保守），并在首次心跳中 ack（4.5）；观察期（`sending_enabled=false`）客户端**不得发起任何发送动作**，只采集线索。
**错误码** `AUTH_INVALID_REQUEST` `AUTH_ACCOUNT_NOT_FOUND` `AUTH_PASSWORD_WRONG` `AUTH_ACCOUNT_LOCKED` `AUTH_ACCOUNT_DISABLED` `AUTH_ACCOUNT_EXPIRED` `AUTH_DEVICE_LIMIT` `SERVER_VERSION_UNSUPPORTED`｜**幂等**：非幂等（每次登录新建会话，可能踢掉旧会话）。

### 4.2 `POST /api/v1/auth/refresh` 与 `POST /api/v1/auth/logout`
- **refresh**：鉴权 `Bearer <token>`（允许已过期 token）+ 签名，请求 `{"device_id":"...","client_version":"3.0.0","protocol_version":2}`；响应为登录响应中的 `token`/`token_expires_ms`/`sign_key`/`sign_key_expires_ms`/`privacy_salt`/`account`/`credit`/`policy`/`quota_notice`/`limits` + `prev_token_expires_ms`。**幂等**：同一旧 token 的并发 refresh 幂等（`token_overlap_ms` 内返回同一个新 token，不重复轮换）。**错误码** `AUTH_TOKEN_INVALID` `AUTH_TOKEN_EXPIRED` `AUTH_TOKEN_REVOKED` `AUTH_ACCOUNT_DISABLED` `AUTH_ACCOUNT_EXPIRED` `AUTH_SIGN_*`。
- **logout**：鉴权+签名，请求 `{"device_id":"...","reason":"user_logout"}`（`reason` ∈ `user_logout`/`switch_account`/`uninstall`）；响应 `{"ok":true,"revoked_session_count":1}`。**幂等**：是（重复登出返回 `ok:true`、`revoked_session_count:0`）。**错误码** `AUTH_*`。

### 4.3 `GET /api/v1/auth/me`（鉴权+签名，无请求体）
```json
{"ok":true,"server_time_ms":1758096001000,"account":{"account_id":"acc_1001","display_name":"示例店铺","status":"active","plan_id":"plan_half_year","plan_expires_ms":1773676800000},
 "credit":{"balance_milli":12600000,"credit_per_reply_milli":1000,"used_today_milli":0,"used_week_milli":0,"used_month_milli":0},"billing_state":"active",
 "policy_summary":{"policy_version":7,"account_tier":"observation","account_day_index":2,"sending_enabled":false,"daily_cap_total":0,"daily_used_total":0,"daily_remaining_total":0,"next_tier_at_day":4},
 "quota_notice":{"headline":"当前处于观察期，仅采集线索，第 4 天开始可发送","detail":"……"},"last_heartbeat_ms":1758095940000}
```
`billing_state` ∈ `active`/`degraded`/`idle`/`exhausted`/`suspended`｜**错误码** `AUTH_*`｜**幂等**：是。

### 4.4 `GET /api/v1/client/bootstrap`（无需鉴权，**不签名**）
参数：`client_version`（必填）、`protocol_version`（必填）、`os`、`account`（可选）。
```json
{"ok":true,"server_time_ms":1758096000000,"protocol_version":2,"min_client_version":"3.0.0","latest_client_version":"3.1.0","force_upgrade":false,
 "upgrade_url":"https://license.example.com/download","upgrade_notes":"新增发送明细审计上报","server_status":"ok","maintenance":{"active":false,"starts_at_ms":null,"ends_at_ms":null},
 "limits":{"heartbeat_interval_ms":60000,"grace_ms":86400000,"send_batch_interval_ms":300000,"send_batch_max":50,"audit_batch_max":500,"offline_send_grace_ms":900000,"offline_budget_ratio":0.5,"sign_ts_tolerance_ms":300000,"max_pending_sends":20000}}
```
`force_upgrade=true` 或 `client_version < min_client_version` → **必须停机**并展示升级页，不允许登录｜**错误码** `AUTH_INVALID_REQUEST` `SERVER_UNAVAILABLE`｜**幂等**：是。

### 4.5 `POST /api/v1/heartbeat`
鉴权+签名，每 60 秒一次。**心跳不参与计费**，用途仅三项：在线状态、策略下发、会话续期。

| 字段 | 类型 | 必填 | 说明 / 示例 |
|---|---|---|---|
| `account_id` / `device_id` | string | 是 | `"acc_1001"` / `"9f2c...0a93"` |
| `session_id` / `seq` | string / int | 是 | 本次进程启动生成（uuid v4，重启后变化）/ 本 session 内自 1 递增、不得重复或回退 `1287` |
| `client_version` / `protocol_version` | — | 是 | `"3.0.0"` / `2` |
| `engine_state` / `online_seconds` | string / int | 是 / 是 | 任一实例在跑即 `running`（`running`/`paused`/`idle`/`stopped`/`error`）/ 本 session 在线秒数。**仅运营统计，明确不用于计费** `3600` |
| `monotonic_ms` / `wall_clock_ms` / `clock_skew_ms` | int | 是/是/否 | 单调时钟原值 / 墙上时间（仅参考） / 最近校准偏移 |
| `applied_policy_version` / `applied_policy_hash` | int / string | 是 | 客户端**当前实际生效**的策略版本与哈希 `9` / `"5b2e...a10c"` |
| `applied_limits` | object | 是 | 实际生效上限（只能比服务端更保守）：`{"comment":{"daily_max":5,"min_interval_ms":240000,"content_similarity_max":0.85,"active_hours_ok":true},"live_danmaku":{"daily_max":10,"min_interval_ms":90000,"content_similarity_max":0.85},"dm":{"daily_max":3,"min_interval_ms":900000,"content_similarity_max":0.75}}` |
| `daily_used` / `pending_send_count` | object / int | 是 | 当日已发计数 `{"comment":1,"live_danmaku":0,"dm":1}` / 本地待上报明细条数 `12` |
| `instances` / `last_error_code` | array / string | 是 / 否 | `[{"instance_id":"dy_8848","engine_state":"running","daily_used_total":2}]` / 最近一次本地错误码 `"element_timeout"` |

```json
{"ok":true,"server_time_ms":1758096060000,"protocol_version":2,"ack_seq":1287,"state":"active","state_reason":null,
 "credit":{"balance_milli":12600000,"credit_per_reply_milli":1000,"updated_at_ms":1758096060000},
 "policy":{"policy_version":9,"account_tier":"warm_up","account_day_index":5,"tier_day_from":4,"tier_day_to":7,"sending_enabled":true,"collect_only":false,"…":"结构同 4.1 的 policy 对象"},"policy_changed":true,"policy_ack_required":true,
 "daily_quota":{"comment":{"max":10,"used":1,"remaining":9},"live_danmaku":{"max":10,"used":0,"remaining":10},"dm":{"max":3,"used":1,"remaining":2}},
 "circuit_breaker":{"open":false,"cooldown_until_ms":null,"trigger":null},
 "commands":[],"next_heartbeat_after_ms":60000,"sign_key_next":null,"sign_key_next_effective_ms":null}
```
- `state` ∈ `active`/`degraded`/`idle`/`exhausted`/`suspended`；`policy_changed=true` → 客户端必须在 **60 秒内**切到新 `policy`，并在下一次心跳回带新的 `applied_policy_version`/`applied_limits`（完成 ack）。
- **"只能更保守"的判定方向**（任一方向反了即 `POLICY_VIOLATION`）：`daily_max` 只能**调低**；`min_interval_ms` 只能**调高**（间隔更长，且必须落在 `min_interval_ms_range` 内）；`content_similarity_max` 只能**调低**；`active_hours` 只能**调短**（不得新增窗口）。 ｜ `commands[]`：`{"type":"pause_engine","reason":"CREDIT_EXHAUSTED"}` / `{"type":"pause_engine","reason":"POLICY_SENDING_DISABLED"}` / `resume_engine` / `{"type":"throttle","limits":{…},"reason":"POLICY_DAILY_CAP"}` / `{"type":"circuit_break","cooldown_until_ms":…,"reason":"failure_rate"}` / `reload_policy` / `{"type":"force_upgrade","url":"…"}`。客户端须在 **60 秒内**执行 `pause_engine` 与 `circuit_break`。
- **观察期（`sending_enabled=false`）**：三来源 `daily_max` 全 0，客户端**不得发起任何发送**（不产生新 `send_id`），只采集线索；心跳、采集计数与历史明细补报照常。 ｜ **余额 ≤ 0 → HTTP 402 + `CREDIT_EXHAUSTED`**（标准错误信封，**带签名**，客户端必须验签后处理）。
- **错误码** `AUTH_*` `CREDIT_EXHAUSTED` `CREDIT_ACCOUNT_SUSPENDED` `POLICY_VIOLATION` `POLICY_TIER_UNKNOWN` `POLICY_SENDING_DISABLED`（等级转观察/停发时随 `commands` 下发）`RATE_TOO_MANY_REQUESTS` `SERVER_*`｜**幂等**：**同一 `seq` 重复提交幂等**——返回与首次相同的响应体（缓存 10 分钟），不推进状态、不判重放；仅当 `seq < max_seq` 且不在缓存内才判 `AUTH_REPLAY`。

### 4.6 `GET /api/v1/policy/current`（鉴权+签名，参数 `account_id`）
用于启动、`POLICY_VERSION_UNKNOWN`、收到 `reload_policy` 时按需拉取。**`tier_table` 是甲方已确认的权威安全规格，全系统唯一来源。**
```json
{"ok":true,"server_time_ms":1758096060000,"policy":{"policy_version":9,"account_tier":"warm_up","account_day_index":5,"sending_enabled":true,"…":"结构同 4.1"},
 "tier_table":[
  {"tier":"observation","day_from":1,"day_to":3,"sending_enabled":false,"collect_only":true,"limits":{"comment":{"daily_max":0,"min_interval_ms":180000},"live_danmaku":{"daily_max":0,"min_interval_ms":90000},"dm":{"daily_max":0,"min_interval_ms":900000}}},
  {"tier":"warm_up","day_from":4,"day_to":7,"sending_enabled":true,"collect_only":false,"limits":{"comment":{"daily_max":10,"min_interval_ms":180000},"live_danmaku":{"daily_max":10,"min_interval_ms":90000},"dm":{"daily_max":3,"min_interval_ms":900000}}},
  {"tier":"ramp_up","day_from":8,"day_to":14,"sending_enabled":true,"collect_only":false,"limits":{"comment":{"daily_max":25,"min_interval_ms":120000},"live_danmaku":{"daily_max":25,"min_interval_ms":60000},"dm":{"daily_max":8,"min_interval_ms":600000}}},
  {"tier":"stable","day_from":15,"day_to":null,"sending_enabled":true,"collect_only":false,"limits":{"comment":{"daily_max":30,"min_interval_ms":60000},"live_danmaku":{"daily_max":30,"min_interval_ms":30000},"dm":{"daily_max":10,"min_interval_ms":300000}}}],
 "min_interval_ms_range":{"comment":[60000,180000],"live_danmaku":[30000,90000],"dm":[300000,900000]},
 "daily_cap_total_by_tier":{"observation":0,"warm_up":23,"ramp_up":58,"stable":70},
 "stable_daily_max_total":70,"stable_daily_max_total_basis":"稳定期各渠道日上限之和，区间取上限：评论 30 + 弹幕 30（区间 25–30 取 30）+ 私信 10 = 70",
 "content_similarity_max_semantics":"与近期已发内容的相似度**超过**该值即拒绝发送（0.85 = 相似度 > 85% 拒绝）",
 "client_may_only_be_more_conservative":true}
```
- **等级判定按天数边界**：`account_day_index = floor((今日 00:00(UTC+8) − 账号首次成功登录日 00:00(UTC+8)) / 86400000) + 1`；落在 `day_from..day_to` 的等级即当前等级（`stable` 的 `day_to = null` 表示无上限）。**天数边界与服务端下发的等级是唯一依据，客户端不得自行推算或改写。**
- **客户端只能更保守**：`daily_max` 只能调低、`min_interval_ms` 只能调高（且落在 `min_interval_ms_range` 内）、`content_similarity_max` 只能调低、`active_hours` 只能调短。任一项比服务端策略更激进 → 心跳 ack 或上报返回 `POLICY_VIOLATION`。 ｜ **`sending_enabled=false`（观察期）语义**：三来源 `daily_max` 全 0，客户端禁止发送任何内容，只采集；若仍上报新发送明细 → `POLICY_SENDING_DISABLED`，明细留痕但不计费，服务端下发 `pause_engine`。
- **数值唯一来源**：套餐积分、`min_plan_credit`、`quota_notice`、看板日上限等所有展示与计算**必须由本表 + `credit_per_reply` 实时推导，任何地方不得硬编码 0/10/25/30/70/12600 等常量**（改表即全链路同步，见 4.14 与 8.2）。｜**幂等**：是。

### 4.7 `POST /api/v1/usage/report`（聚合计数，**不是计费依据**）
每 30 分钟一次，用于看板与对账。请求字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `report_id` | string | 是 | 唯一幂等键（uuid v4 或 32 hex） |
| `account_id`/`device_id`/`session_id`/`seq` | — | 是 | 标识；`seq` 同 session 内自 1 递增 |
| `window_start_ms`/`window_end_ms` | int | 是 | 聚合窗口（默认 30 分钟），`end > start` |
| `sources` | object | 是 | 三来源计数（见 7.1）：`{"comment":{"hits":9,"leads_new":8,"reply_attempts":4,"sent_confirmed":3,"sent_confirmed_dom":0,"sent_suspected":1,"failed":0,"skipped":5,"unique_users":3},"live_danmaku":{"hits":3,"leads_new":3,"reply_attempts":2,"sent_confirmed":1,"sent_confirmed_dom":1,"sent_suspected":0,"failed":0,"skipped":1,"unique_users":1},"dm":{"hits":1,"leads_new":1,"reply_attempts":1,"sent_confirmed":1,"sent_confirmed_dom":0,"sent_suspected":0,"failed":0,"skipped":0,"unique_users":1}}` |
| `failure_reasons` / `unique_users_total` | object / int | 是 / 是 | 失败原因 → 次数，无失败传 `{}` / 本窗口去重用户数（仅平台确认，见 7.3）`5` |
| `policy_snapshot` | object | 是 | **实际生效策略快照**：`{"policy_version":9,"policy_hash":"…","applied_limits":{…},"captured_at_ms":…}` |
| `client_version`/`protocol_version` | — | 是 | 版本 |

响应：`{"ok":true,"duplicate":false,"server_time_ms":…,"reconciliation":{"detail_confirmed":5,"reported_confirmed":5,"match":true,"audit_flags":[],"authoritative_source":"audit_sends"},"credit":{"balance_milli":12595000,"credit_per_reply_milli":1000},"commands":[]}`
**对账**：服务端比对同窗口 `audit_sends` 明细中 `sent_confirmed` 条数与本次 `sources.*.sent_confirmed` 之和；不符记 `audit_flags:["aggregate_mismatch"]`，**以明细为准**（计费永远只依据明细）。`duplicate:true` 表示同 `report_id` 重发，回放首次结果。
**错误码** `REPORT_INVALID` `REPORT_PRIVACY_VIOLATION` `REPORT_TOO_LARGE` `AUTH_*` `SERVER_*`｜**幂等**：由 `report_id` 唯一索引强制。

### 4.8 `POST /api/v1/audit/sends`（**计费依据**）
每 `send_batch_interval_ms`（5 分钟）或攒满 `send_batch_max`（50）条上报一次；停机前、进入暂停态前、离线恢复后立即上报。
```json
{"batch_id":"b-2f1c9a4e6b70c35a1f8d2e4b6c0a9317","account_id":"acc_1001","device_id":"9f2c...0a93","session_id":"2c9a...7f10","seq":41,"protocol_version":2,"client_version":"3.0.0",
 "policy_snapshot":{"policy_version":9,"policy_hash":"5b2e...a10c","applied_limits":{"comment":{"daily_max":5,"min_interval_ms":240000},"…":"…"},"captured_at_ms":1758096060000},
 "sends":[{"send_id":"s-3f1c9a4e6b70c35a1f8d2e4b6c0a9317","sent_at_ms":1758096060120,"source_type":"comment","target_hash":"9c1f…e4d2","user_key_hash":"7ab3…91ce","user_key_type":"sec_uid","content_hash":"d41e…08ba","verdict":"sent_confirmed","is_final":true,
   "evidence":{"confirm_signal":"platform_response","platform_endpoint":"comment/publish","platform_status_code":0,"observed_at_ms":1758096060320,"dom_stable_ms":0,"risk_control_signal":null},"failure_reason":null,"attempt_seq":1,"applied_policy_version":9}]}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `send_id` | string | 是 | 客户端生成的全局唯一 ID（uuid v4 或 32 hex）。**幂等键与计费键**，必须在**发送前**生成并落盘 |
| `sent_at_ms` / `source_type` | int / string | 是 | 发送发生时刻（已按 `clock_skew_ms` 校准到服务端时间轴）/ `comment`/`live_danmaku`/`dm`，**三者独立限额** |
| `target_hash` / `user_key_hash`/`user_key_type` | string / string | 是 / 是 | 评论=`hmac(salt, video_id+"\|"+comment_id)`；弹幕=`hmac(salt, room_id+"\|"+msg_id)`；私信=`hmac(salt, conversation_id)` / 对方用户哈希与类型（见 7.3），**绝不上传原始 `sec_uid`** |
| `content_hash` | string | 是 | `hmac(privacy_salt, reply_text)`，**绝不上传原文** |
| `verdict` | string | 是 | `sent_confirmed`/`sent_confirmed_dom`/`sent_suspected`/`failed`/`skipped`（口径见 7.2） |
| `is_final` | bool | 是 | 是否最终判定；`false` 表示后续可能升级为 `sent_confirmed` |
| `evidence` | object | 是 | `confirm_signal` ∈ `platform_response`/`dom_stable`/`none`；`platform_endpoint` 为**闭集白名单** `comment/publish`、`comment/reply`、`im/send`、`live/comment/send`（禁止完整 URL 与域名） |
| `failure_reason` | string\|null | 条件 | `verdict="failed"` 时必填（枚举见 7.4），其余必须为 `null` |
| `attempt_seq` / `applied_policy_version` | int | 是 | 同一 `target_hash` 的第几次尝试（从 1 开始）/ 本条发送时实际生效的策略版本 |

```json
{"ok":true,"server_time_ms":1758096360000,"batch_id":"b-2f1c…9317",
 "results":[{"send_id":"s-3f1c…9317","accepted":true,"duplicate":false,"billing_status":"billed","charged_milli":1000,"reject_code":null},{"send_id":"s-4a2d…77e1","accepted":true,"duplicate":false,"billing_status":"not_billable","charged_milli":0,"reject_code":null},{"send_id":"s-5b3e…88f2","accepted":true,"duplicate":false,"billing_status":"policy_exceeded","charged_milli":0,"reject_code":"POLICY_DAILY_CAP_EXCEEDED"}],
 "settlement":{"billed_count":1,"charged_milli":1000,"balance_milli":12599000,"unbilled_count":0,"over_limit_count":1,"state":"active","audit_flags":[]},
 "daily_quota":{"comment":{"max":10,"used":11,"remaining":0},"live_danmaku":{"max":10,"used":3,"remaining":7},"dm":{"max":3,"used":1,"remaining":2}},
 "commands":[{"type":"throttle","reason":"POLICY_DAILY_CAP","limits":{"comment":{"daily_max":10,"min_interval_ms":180000}}}]}
```

| `billing_status` | 含义 | 是否扣费 |
|---|---|---|
| `billed` | 计费成功（`verdict=sent_confirmed` 且平台响应证据成立） | 是，`charged_milli = credit_per_reply_milli` |
| `duplicate` | 同 `send_id` 已结算，回放首次结果 | 否 |
| `not_billable` | 失败/风控拒绝/疑似送达/跳过/仅 DOM 判据确认（`bill_dom_confirmed=false`） | 否 |
| `policy_exceeded` | 超出当日策略上限（含观察期全 0；明细仍留痕） | 否 |
| `unbilled_insufficient_credit` | 余额已耗尽，该条已发生但**不扣费、充值后也不补扣** | 否 |

- **逐条独立幂等**，键 `(account_id, send_id)`；重发/补报不重复扣费。 ｜ **单向升级**：同 `send_id` 由 `sent_suspected`/`sent_confirmed_dom`/`failed` 升级为 `sent_confirmed` 且带平台证据 → 接受并**只计费一次**；降级或 `source_type`/`sent_at_ms` 不一致 → `AUDIT_SEND_CONFLICT`(409) 整条拒绝，保留首次记录。
- **余额不足按 §6.5 部分扣费**；结算后余额 ≤ 0 → 仍 200，`settlement.state="exhausted"` + `commands:[pause_engine]`，客户端 **≤60 秒**进入暂停态。熔断期间**不影响历史明细补报**（已发生的事实照常受理与计费），只拒绝新发送。
- **错误码** `AUDIT_SEND_INVALID` `AUDIT_SEND_CONFLICT` `AUDIT_BATCH_TOO_LARGE` `POLICY_VIOLATION` `POLICY_VERSION_UNKNOWN` `POLICY_ACK_REQUIRED` `POLICY_TIER_UNKNOWN` `POLICY_SENDING_DISABLED` `POLICY_DAILY_CAP_EXCEEDED`(200) `REPORT_PRIVACY_VIOLATION` `AUTH_*` `SERVER_*`｜**幂等**：由 `(account_id, send_id)` 唯一索引强制。

### 4.9 `POST /api/v1/audit/config-changes`（鉴权+签名）
配置变更审计：谁、何时、把哪项从什么改成什么、来源是"用户操作"还是"服务端策略"。
```json
{"batch_id":"c-7d2e…41af","account_id":"acc_1001","device_id":"9f2c…0a93","seq":9,"protocol_version":2,
 "changes":[{"change_id":"ch-1a2b…9c0d","changed_at_ms":1758096000000,"source":"user","actor":"local_user","field_key":"limits.comment.daily_max","old_value":"10","new_value":"100","applied":false,"reject_code":"POLICY_VIOLATION","policy_version":9},
            {"change_id":"ch-2b3c…0d1e","changed_at_ms":1758096200000,"source":"server_policy","actor":"license_server","field_key":"limits.comment.daily_max","old_value":"10","new_value":"25","applied":true,"policy_version":10}]}
```
- `source` ∈ `user`（商家在客户端改了配置）/`server_policy`（服务端下发导致）/`default`（恢复默认）；`actor` ∈ `local_user`/`license_server`/`system`；`field_key` 为配置点路径白名单，`old_value`/`new_value` 为字符串，**禁止写入内容正文或隐私数据**。
- `applied=false` 时必须给出 `reject_code`。**这就是"用户是否主动调高过、系统是否拒绝过"的原始证据。**
- 响应 `{"ok":true,"results":[{"change_id":"ch-1a2b…9c0d","accepted":true,"duplicate":false}],"audit_flags":[]}`｜**错误码** `AUDIT_CONFIG_INVALID` `AUDIT_BATCH_TOO_LARGE` `AUTH_*`｜**幂等**：键 `(account_id, change_id)`。

### 4.10 服务端取证能力（管理后台范围，契约硬要求）

| 问题 | 数据来源 |
|---|---|
| 某次封号前该账号**实际生效的策略**是什么？ | `policy_ack_log(account_id, policy_version, policy_hash, account_tier, account_day_index, applied_limits_json, first_ack_at_ms, last_seen_at_ms)` |
| 变化来自**服务端下发**还是**用户自己调低**？ | `audit_config_changes.source/actor` 与 `policy.version_history` 对比 |
| 用户是否**主动调高过**、系统是否**拒绝过**？ / 封号前 N 小时具体发了什么、是否被风控过？ | `audit_config_changes` 中 `source=user` 且（`applied=false` 或 old→new 为调高上限/缩短间隔）的行 / `audit_sends`（仅哈希与判定，无原文），按 `source_type`/`verdict`/`sent_at_ms` 检索；`evidence.risk_control_signal` 与 `failure_reason` 聚合 |

### 4.11 `GET /api/v1/credit/balance`（鉴权+签名，参数 `refresh=1` 可选）
```json
{"ok":true,"server_time_ms":1758096060000,"credit":{"balance_milli":12595000,"credit_per_reply_milli":1000,"replies_affordable":12595,"updated_at_ms":1758096060000},"billing_state":"active",
 "used":{"today_milli":5000,"week_milli":5000,"month_milli":5000,"today_confirmed_count":5,"month_confirmed_count":5},
 "daily_quota":{"comment":{"max":10,"used":4,"remaining":6},"live_danmaku":{"max":10,"used":1,"remaining":9},"dm":{"max":3,"used":1,"remaining":2}},
 "plan":{"plan_id":"plan_half_year","plan_name":"半年套餐","valid_days":180,"expires_ms":1773676800000},"quota_notice":{"headline":"套餐是预付额度，不等于无限发送","detail":"……"}}
```
`replies_affordable = floor(balance_milli / credit_per_reply_milli)`，仅供展示｜**幂等**：是。

### 4.12 `GET /api/v1/credit/ledger`（鉴权+签名）
参数：`from_ms`/`to_ms`（必填，跨度 ≤ 366 天）、`granularity`（`raw`/`hour`/`day`/`week`/`month`，默认 `day`）、`kind`（`usage,redeem,adjust,plan_grant`）、`limit`（默认 200，最大 1000）、`cursor`。
```json
{"ok":true,"server_time_ms":1758096060000,"granularity":"day","tz_offset_minutes":480,
 "buckets":[{"bucket_start_ms":1758038400000,"usage_milli":1000,"redeem_milli":0,"adjust_milli":0,"net_milli":-1000},{"bucket_start_ms":1758124800000,"usage_milli":2000,"redeem_milli":5000000,"adjust_milli":0,"net_milli":4998000}],
 "summary":{"usage_milli":3000,"redeem_milli":5000000,"adjust_milli":0,"net_milli":4997000,"confirmed_count":3},"entries":[],"next_cursor":null}
```
`entries[]` 仅 `granularity=raw` 时填充：`{"entry_id":"le_…","kind":"usage","delta_milli":-1000,"balance_after_milli":12599000,"ref_send_id":"s-3f1c…9317","credit_per_reply_milli":1000,"settled_at_ms":1758096360000,"note":null}`。日/周/月边界按 `tz_offset_minutes` 划分（`week` 以周一为起点）；`net_milli = redeem + adjust + plan_grant - usage`｜**错误码** `AUTH_*` `CREDIT_LEDGER_NOT_FOUND`｜**幂等**：是。

### 4.13 `POST /api/v1/credit/redeem`（鉴权+签名）
请求 `{"request_id":"rd-…","code":"DSW-XXXX-XXXX-9A3F","account_id":"acc_1001","device_id":"9f2c…0a93"}`；`code` 大小写不敏感，服务端只存哈希；`account_id` 必须等于 token 所属账号。
```json
{"ok":true,"server_time_ms":1758096060000,"redeemed_milli":5000000,"balance_milli":17600000,"code_masked":"DSW-****-****-9A3F",
 "redeemed_at_ms":1758096060000,"ledger_entry_id":"le_7c1a…","plan_extended_ms":15552000000,"duplicate":false}
```
卡密面额 = `credits`（积分）+ 可选 `valid_days`（延长有效期）。兑换**原子**：唯一索引 `redeem_code.code_hash` + `BEGIN IMMEDIATE`，并发兑换同一码只有一个成功，另一个返回 `CREDIT_REDEEM_CODE_USED`。
**错误码** `CREDIT_REDEEM_CODE_INVALID` `_USED` `_EXPIRED` `_DISABLED` `CREDIT_REDEEM_ALREADY_DONE`(200) `RATE_TOO_MANY_REQUESTS` `AUTH_*`｜**幂等**：是（`request_id` + 卡密唯一索引双重保证）。

### 4.14 `GET /api/v1/account/plan`（鉴权+签名）
**本接口所有数值必须由 `tier_table` + `credit_per_reply` 实时推导**，实现侧禁止硬编码（改上限 → 套餐积分与文案自动同步）。
```json
{"ok":true,"server_time_ms":1758096060000,"credit_per_reply_milli":1000,"stable_daily_max_total":70,"min_plan_credit":12600,"plan_credit_formula":"stable_daily_max_total × valid_days × plan_credit_ratio","generated_from_policy_version":12,
 "quota_notice":{"headline":"套餐是预付额度，不等于无限发送","detail":"平台安全上限由服务端下发且客户端无法调高：稳定期每日最多 70 条（评论 30 / 弹幕 30 / 私信 10）。半年套餐 12600 积分 = 按每日上限连续用满 180 天折算；实际发送量受当日上限约束，未用完的额度不会顺延为额外发送量。积分只对平台确认成功的回复扣减，失败与被风控拒绝不扣费。","tier":"stable","daily_cap_total":70,"daily_cap_detail":{"comment":30,"live_danmaku":30,"dm":10},"credits_per_day_at_cap":70,"valid_days":180,"estimated_days_at_cap":180,"estimated_days_at_current_rate":245,"note":"安全上限会限制实际消耗速度，因此套餐按期而非按量承诺；额度按积分计量，有效期按 valid_days 计算。"},
 "plans":[{"plan_id":"plan_half_year","name":"半年套餐","valid_days":180,"credits":12600,"credits_milli":12600000,"price_cents":0,"price_is_placeholder":true,"active":true,"hours":null},{"plan_id":"plan_year","name":"年套餐","valid_days":365,"credits":25550,"credits_milli":25550000,"price_cents":0,"price_is_placeholder":true,"active":true,"hours":null}],
 "current":{"plan_id":"plan_half_year","expires_ms":1773676800000,"remaining_days":176,"credits_remaining_milli":12595000}}
```

| 套餐字段 | 类型 | 说明 |
|---|---|---|
| `valid_days` | int | 有效期天数（业务期限），必填 |
| `credits` | int | 套餐包含积分 = 可计费"平台确认成功回复"条数 × `credit_per_reply` 的积分值；**必须按下面的公式从策略表实时算出** |
| `price_cents` / `price_is_placeholder` | int / bool | **价格由商务配置，此处为占位值（`0`），不得作为定价依据**；真实价格由管理后台下发 |
| `hours` | int\|null | **已废弃**：历史字段，服务端恒返回 `null`，客户端必须忽略，禁止据此展示 |

```
stable_daily_max_total = tier_table[stable].comment.daily_max + tier_table[stable].live_danmaku.daily_max
                       + tier_table[stable].dm.daily_max      // 区间取上限：30 + 30 + 10 = 70（唯一来源，不得写死）
plan.credits           = ceil(stable_daily_max_total × valid_days × plan_credit_ratio)   // ratio 默认 1.0
min_plan_credit        = ceil(stable_daily_max_total × 180 × plan_credit_ratio)          // 默认 12600
plan.credits < min_plan_credit → PLAN_QUOTA_BELOW_MIN（半年套餐不得低于 6 个月折算额度）
```
默认数值：半年套餐 `valid_days=180`、`credits=70×180=12600`；年套餐 `valid_days=365`、`credits=70×365=25550`。**这些数字是策略表当前值的推导结果，不是常量**：`tier_table` 一旦调整，套餐积分、`min_plan_credit`、`quota_notice` 文案与看板日上限必须同时自动变化（见 8.2）。
**文案取值口径**：`quota_notice` 的所有数字（日上限、`daily_cap_total`、`credits`、`valid_days`、估算天数）**必须由策略表实时生成，不得硬编码到客户端或模板字符串**；`daily_cap_total = 0`（观察期）时必须改用观察期文案：headline `"当前处于观察期，仅采集线索，第 4 天开始可发送"`，detail 说明观察期只采集不发送、第 4 天起进入预热期（评论 10 条/天、弹幕 10 条/天、私信 3 条/天）。 ｜ **必须写进产品文案的一条**：买了半年套餐 ≠ 半年内能无限发。平台的日上限才是真正的量级约束，套餐只是预付额度。因此：① 客户端在**套餐展示页、充值页、首次登录弹窗、余额不足提示**四处必须原样显示 `quota_notice.headline` 与 `detail`，不得改写、折叠或隐藏；② 余额展示必须同时显示"剩余可发条数 `replies_affordable`"与"今日剩余额度 `daily_quota.*.remaining`"；③ 兼容：`protocol_version=1` 的旧客户端请求本接口时服务端额外返回按废弃汇率折算的 `hours` 并记 `audit_flag:"legacy_hours_served"`，新客户端忽略该字段。
**错误码** `AUTH_*` `PLAN_NOT_FOUND`｜**幂等**：是。

> 管理后台（厂商侧）的商家列表、下钻、全平台汇总、手工充值、卡密生成等接口不在本契约范围内，但**必须复用本章同一套计费与策略口径**。

## 5. HMAC 签名规范
**算法与密钥**：`HMAC-SHA256`，输出 64 位小写 hex。`sign_key` 由登录/续期响应下发（64 hex = 32 字节）；服务端存储 `sign_key = hmac_sha256(master_secret, account_id+"|"+device_id+"|"+key_epoch)`，只存 `key_epoch` 与 `sign_key_sha256`。`sign_key_expires_ms` 与 token 同寿命；客户端持久化到受保护目录，**不得写入日志**。

### 5.1 请求签名串（精确拼接）
```
canonical_request =
    METHOD_UPPERCASE + "\n" +
    PATH_WITH_QUERY  + "\n" +     // 原样：从 "/api/" 开始，含 query，不含 scheme/host，不做 URL 重编码
    String(ts_ms)    + "\n" +     // 固定 13 位 Unix 毫秒
    nonce            + "\n" +     // 16–32 位小写 hex，每次请求必须唯一
    sha256_hex(raw_body_bytes)    // 无 body 时 = sha256_hex("") = e3b0c442...b855
signature = hex_lower(hmac_sha256(sign_key, utf8_bytes(canonical_request)))
```
请求头：`Authorization: Bearer <token>`、`X-Lic-Ts: 1758096060000`、`X-Lic-Nonce: 9c1f4a7b2e8d0356`、`X-Lic-Sign: <signature>`、`Content-Type: application/json; charset=utf-8`。

### 5.2 响应签名串
```
canonical_response = "RESP" + "\n" + String(http_status) + "\n" + PATH_WITH_QUERY + "\n" +
    request_nonce + "\n" + String(server_time_ms) + "\n" + sha256_hex(raw_body_bytes)
signature = hex_lower(hmac_sha256(sign_key, utf8_bytes(canonical_response)))
```
响应头：`X-Lic-Server-Ts`、`X-Lic-Sign`。**错误响应（含 402/409/4xx/5xx）也必须签名**，否则客户端无法区分"服务端说余额不足/策略收紧"与"中间人伪造"。

### 5.3 可直接照做的伪代码
```js
const crypto = require('node:crypto')
const sha256Hex = b => crypto.createHash('sha256').update(b).digest('hex')
const hmacHex = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex')

function signedFetch(method, pathWithQuery, bodyObject, ctx) {          // 客户端发请求
  const rawBody = bodyObject === undefined ? '' : JSON.stringify(bodyObject)   // 只序列化一次！
  const ts = Date.now() + ctx.clockSkewMs                                      // 由最近一次 server_time_ms 校准
  const nonce = crypto.randomBytes(8).toString('hex')                          // 每次请求必须新生成
  const canonical = [method.toUpperCase(), pathWithQuery, String(ts), nonce, sha256Hex(Buffer.from(rawBody, 'utf8'))].join('\n')
  return httpRequest({ method, path: pathWithQuery, body: rawBody,             // 原样发送 rawBody 字符串
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + ctx.token,
      'X-Lic-Ts': String(ts), 'X-Lic-Nonce': nonce, 'X-Lic-Sign': hmacHex(ctx.signKey, canonical) } })
    .then(res => ({ ...res, requestNonce: nonce, key: ctx.signKey, path: pathWithQuery }))
}

function verifyResponse(resp) {          // 校验通过前不得解析 resp.rawBody 里的业务字段
  const got = resp.headers['x-lic-sign'], serverTs = Number(resp.headers['x-lic-server-ts'])
  if (!got || !Number.isFinite(serverTs)) return { ok: false, reason: 'missing_sign' }
  if (Math.abs(Date.now() - serverTs) > resp.signTsToleranceMs) return { ok: false, reason: 'ts_skew' }
  const canonical = ['RESP', String(resp.status), resp.path, resp.requestNonce, String(serverTs), sha256Hex(Buffer.from(resp.rawBody, 'utf8'))].join('\n')
  const a = Buffer.from(hmacHex(resp.key, canonical), 'hex'), b = Buffer.from(got, 'hex')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_sign' }
  return { ok: true, body: JSON.parse(resp.rawBody) }
}
```

### 5.4 时间戳、防重放、轮换
- **时间戳容忍窗口** `sign_ts_tolerance_ms = 300000`（±5 分钟）。超出 → `AUTH_TS_SKEW`(401)，客户端用 `server_time_ms` 重算 `clockSkewMs` 后**只重试一次**。
- **防重放**：服务端表 `used_nonce(nonce PRIMARY KEY, account_id, ts_ms)`，TTL `nonce_ttl_ms = 600000`（10 分钟），定时清理；重复 nonce → `AUTH_REPLAY`。
- **序号防重放**：`seq` 按 `(account_id, device_id, session_id, channel)` 记录 `max_seq`，`channel` ∈ `heartbeat`/`usage`/`sends`/`config_audit`，**各通道独立计数**；`seq ≤ max_seq` 且不在响应缓存内 → `AUTH_REPLAY`，新 `session_id` 允许 `seq` 从 1 重新开始。
- **密钥轮换**：心跳/续期响应可带 `sign_key_next` + `sign_key_next_effective_ms`；客户端持久化后对 `ts ≥ sign_key_next_effective_ms` 的请求改用新密钥。服务端校验按 `next`（已生效）→ `current` → `prev` 顺序尝试，重叠窗口 10 分钟；三把都不匹配 → `AUTH_SIGN_KEY_UNKNOWN`，必须重新登录。
- **批量上报的 nonce 纪律**：`/audit/sends` 与 `/usage/report` 频率高，**每次请求必须生成新 nonce**，复用会被判 `AUTH_REPLAY` 并触发安全告警。 ｜ **签名失败的客户端行为**：任何一次请求签名被拒或响应验签失败 → 记录安全事件、**立即进入暂停态**（fail-closed）、退避重试登录；禁止在验签失败时继续发送。

## 6. 计费算法规范（按成功回复条数）
### 6.1 计费公式
```
积分消耗 = COUNT(send 明细中 verdict="sent_confirmed" 且计费资格成立 且 未超当日策略上限 的条数) × credit_per_reply_milli
```
- `credit_per_reply` 默认 `1` 积分/条，服务端可配（0.1–1000，步进 0.1，存为 `credit_per_reply_milli`，单位 milli，1000 milli = 1 积分）。
- **计费资格**（必须同时成立）：① `verdict="sent_confirmed"`；② `evidence.confirm_signal="platform_response"`；③ `evidence.platform_status_code=0`（`comment/publish` 等成功码，**空响应/风控响应不得标成功**）；④ 该 `send_id` 未被计费过；⑤ 未超当日策略上限（观察期上限为 0，故观察期发送一律不计费）。任一不成立 → `not_billable` 或 `policy_exceeded`，**不扣费**。 ｜ **不计费清单**（对商家有利，须写入客户端 UI 与客服话术）：失败、被平台风控拒绝、被跳过、未命中规则、`sent_suspected`（含"编辑器消失即成功"这类旧判据）、仅 DOM 判据确认且 `bill_dom_confirmed=false`、超出当日策略上限的发送（含观察期）、余额耗尽后的发送（`unbilled_insufficient_credit`，充值后不补扣）。
- **心跳与时长不参与计费**：`online_seconds` 仅供运营统计（在线时长、活跃商家数），任何情况下不得换算成积分；v1 的按挂钟时长计费模型自 `protocol_version=2` 起作废。
- **欠费停机语义 = 禁止发送**（不再是"停止计时"）：余额 ≤ 0 → 服务端拒绝心跳续期（HTTP 402 `CREDIT_EXHAUSTED`）→ 客户端 ≤60 秒进入暂停态，停止评论、弹幕、私信三类发送。

### 6.2 幂等与去重
- 唯一索引 `send_log(account_id, send_id) UNIQUE`：同一 `send_id` 重复上报**永不重复扣费**，直接回放首次结果（`duplicate:true`）。
- 客户端责任：`send_id` 必须在**发送动作发起前**生成并写入本地 `pending_sends.json`（先落盘再发送），保证进程崩溃后重发用的是同一个 ID。服务端责任：只认 `send_id`；**不得**按"内容相同/目标相同/时间相近"做二次去重（会误杀合法重试），也**不得**基于客户端汇总数字计费。 ｜ **批量上报的键序**：一批内按 `sent_at_ms` 升序串行结算；同批出现两条相同 `send_id` → 后者按幂等/冲突规则处理，不得重复计费。

### 6.3 判定升级（suspected → confirmed）
```
同 (account_id, send_id) 再次上报：
  原 verdict = sent_confirmed                                  → 幂等回放，不扣费
  原 verdict ∈ {sent_suspected, sent_confirmed_dom, failed} 且新 verdict = sent_confirmed 且带平台证据 → 接受升级，is_final=true，扣费一次
  新 verdict 为降级，或 source_type / sent_at_ms 与首次不一致    → AUDIT_SEND_CONFLICT(409)，拒绝并保留首次记录
```

### 6.4 伪代码
```js
function settleSendBatch(acc, batch, nowMs) {
  const unit = acc.credit_per_reply_milli            // 每条成功回复的 milli
  const out = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const s of sortBySentAt(batch.sends)) {     // 严格按 sent_at_ms 升序
      const prev = findSend(acc.account_id, s.send_id)
      if (prev) {                                    // 1) 幂等 / 冲突
        if (prev.verdict === 'sent_confirmed') { out.push(result(s, 'duplicate', 0)); continue }
        if (!isUpgrade(prev, s)) { out.push(reject(s, 'AUDIT_SEND_CONFLICT')); continue }
      }
      const pol = verifyPolicy(acc, s)               // 2) 策略存证：先校验后计费；返回 POLICY_VIOLATION /
      if (pol.code) { out.push(reject(s, pol.code)); continue }   // POLICY_VERSION_UNKNOWN / POLICY_ACK_REQUIRED / null
      const quota = dayQuota(acc, s.source_type, s.sent_at_ms)    // 3) 当日额度（UTC+8，按来源独立；观察期 max=0）
      const overLimit = quota.max === 0 || quota.used >= quota.max
      if (overLimit) acc.audit_flags.push(quota.max === 0 ? 'tier_sending_disabled' : 'policy_daily_cap_exceeded')
      const billable = s.verdict === 'sent_confirmed' && s.evidence.confirm_signal === 'platform_response'
                    && s.evidence.platform_status_code === 0 && !overLimit && !acc.insufficient   // 4) 计费资格
      insertSendRow(acc, s, overLimit)               // 明细永远留痕（审计优先）
      let charged = 0
      if (billable) {                                // 5) 扣费：跨零点那一条全额入账，其后只留痕不扣费
        if (acc.balance_milli >= unit) { acc.balance_milli -= unit; charged = unit }
        else if (!acc.insufficient) { acc.balance_milli -= unit; charged = unit; acc.insufficient = true }
      }
      const status = overLimit ? 'policy_exceeded' : charged > 0 ? 'billed'
                   : billable ? 'unbilled_insufficient_credit' : 'not_billable'
      if (charged > 0) insertLedger(acc, s, charged, nowMs)
      out.push(result(s, status, charged))
    }
    if (acc.balance_milli <= 0) acc.state = 'exhausted'         // 下一次心跳返回 402
    persist(acc); db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return out
}
```

### 6.5 余额不足以支付一批上报：**建议部分扣费**
**结论**：按 `sent_at_ms` 升序逐条结算，扣到余额耗尽为止；**跨越零点的那一条全额入账**（允许最多透支 `credit_per_reply_milli`，即一条），其后所有条目落 `send_log` 但 `billing_status="unbilled_insufficient_credit"`，不扣费、**充值后也不补扣**。
理由：① 这些发送已真实发生，是事实而非申请；全拒会让服务端永远缺少封号取证所需明细，统计与审计出现空洞。② 全拒会导致客户端无休止重试、`pending_sends.json`（上限 20000）被丢最旧，反而丢证据。③ 恰好允许一条透支使欠费上限清晰可预测（= 一条单价），且对商家有利。④ 未计费部分不补扣，杜绝"停机后还在扣钱""充值后被追溯补扣"的投诉。⑤ 响应用 `settlement.unbilled_count` + `commands:[pause_engine]` 明确告知已耗尽，客户端 ≤60 秒停机，闭环。
（若甲方坚持全拒：必须同时放大 `pending_sends.json` 上限并在响应返回 `CREDIT_EXHAUSTED` 让客户端立刻停机，否则会形成重试风暴。本文档默认按部分扣费实现。）

### 6.6 边界用例（必须一致实现）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 同一 `send_id` 重复上报 10 次 | 首次扣 1 条；其余 9 次 `duplicate:true` 回放首次结果；余额只减一次 |
| 2 | 一批 10 条：4 条 `sent_confirmed`、3 条 `failed`、2 条 `sent_suspected`、1 条 `sent_confirmed_dom`（`bill_dom_confirmed=false`） | 扣 4 条积分；其余 6 条 `not_billable` 不扣费；明细全部留痕 |
| 3 | 风控拒绝：`verdict=failed`、`risk_control_signal="empty_response"` | 不扣费；`platform_reject_count+1`，达阈值触发 `circuit_break` |
| 4 | 平台返回 `status_code != 0` 但客户端标成 `sent_confirmed` | 服务端判 `not_billable` 并记 `audit_flag:"evidence_invalid"`；不扣费 |
| 5 | 离线 3 小时囤 12 条明细，恢复后补报 | 按 `sent_at_ms` 升序单批上报（≤ `audit_batch_max=500`）并逐条结算；同 `send_id` 重发不重复扣费 |
| 6 | 补报中某条 `send_id` 由首次 `sent_suspected` 升级为 `sent_confirmed` | 升级计费一次（§6.3）；同批不得出现两条同 `send_id` |
| 7 | 补报明细跨天（`sent_at_ms` 属不同自然日） | 按该条 `sent_at_ms` 所属自然日的等级与上限核算；超额部分 `policy_exceeded` 不扣费 |
| 8 | 一批 10 条，余额恰好够 3 条 | 前 3 条 `billed`；第 4 条起 `unbilled_insufficient_credit`；响应 `state="exhausted"` + `pause_engine` |
| 9 | 余额剩 0.3 条，来 1 条成功 | 该条全额入账（跨零点唯一一次透支），余额变 -0.7 条积分，`state="exhausted"` |
| 10 | 同一 `send_id` 先报 `sent_confirmed`，后报 `failed` | `AUDIT_SEND_CONFLICT`(409)，拒绝且保留首次计费记录 |
| 11 | 服务端重启 | 状态全在 SQLite（`send_log` UNIQUE/`credit_ledger`/`account_billing`）；未 ACK 明细按原 `send_id` 重发，唯一索引保证只扣一次 |
| 12 | 客户端把 `applied_limits.dm.daily_max` 上报为 60（策略 10） | `POLICY_VIOLATION`(409) 整批拒绝，`detail` 给出 `field/reported/allowed/policy_version`；客户端必须降到 10 或更低 |
| 13 | 观察期（三来源 `daily_max` 全 0）客户端仍上报新发送明细 | 明细留痕但 `policy_exceeded` **不计费** + `reject_code:"POLICY_SENDING_DISABLED"` + `audit_flag:"tier_sending_disabled"` + `commands:[pause_engine]`；等级只以服务端下发为准 |
| 14 | `online_seconds` 很大但无任何发送明细 | 消耗 0 积分（时长不计费）；仅影响"在线时长"运营统计 |

### 6.7 幂等与重算规则
- **不可变账本**：`credit_ledger` 追加写（append-only），已落账条目不得 UPDATE/DELETE。**重算**：`credit_per_reply` 变更只对变更 `effective_ms` 之后的明细生效，历史已落账不回溯；纠错由管理后台写反向 `adjust` 分录，`note` 记录原因与操作人。 ｜ **并发**：所有账务写在 `BEGIN IMMEDIATE` 事务内；SQLite 忙 → `SERVER_DB_BUSY`（客户端 1 秒后重试）。**对账**：服务端每日比对 `send_log` 明细与 `credit_ledger` 中 `kind='usage'` 的条数/金额，不一致写 `billing_reconcile_alert`。 ｜ 
## 7. 字段字典（口径定义）
**三来源枚举**：`comment`（视频评论区）、`live_danmaku`（直播间弹幕）、`dm`（陌生人私信）。三者**独立限额、独立统计**；上报 `sources` 的三个键必须全部存在，无数据填全 0 对象。

### 7.1 `hits` / `leads_new` / `skipped` / `reply_attempts`
- **命中 `hits`**：一条平台原始消息通过本地筛选规则（关键词/黑白名单/频控），被判定为"值得回复的线索"。重复渲染不算多次，按去重键计数：`comment` = `(account_id,'comment',video_id,comment_id)`，`comment_id` 缺失则**不计入** hits（宁可少算不可多算）；`live_danmaku` 优先 `(account_id,'live',room_id,msg_id)`，无稳定 `msg_id` 时退化为 `(account_id,'live',room_id,user_key_hash,content_hash)` 且 **5 分钟窗内只计一次**；`dm` = `(account_id,'dm',conversation_id,msg_id)`。
- **沉淀 `leads_new`**：命中并去重后**首次写入本地线索库**的条数；`lead_key = sha256(account_id+'|'+source+'|'+biz_key)`，二次出现只计 `hits`。约束 `leads_new ≤ hits`，违反记 `audit_flag:"leads_gt_hits"` 并按 `hits` 截断。
- **跳过 `skipped`**：命中但**没有发起回复**的条数（黑名单、当日额度已满、频控、该用户已回复过、观察期禁发）。`reply_attempts + skipped ≤ hits`。 ｜ **回复尝试 `reply_attempts`**：真正向平台发起发送动作的次数，每个都必须对应一条 `send_id` 明细。**`skipped` 与 `reply_attempts` 都不计费，只有成功的那部分计费。**

### 7.2 发送判定：四级口径（**本契约最关键的口径**）

| 字段 | 判定条件（必须全部满足） | 是否计费 | 是否计入"已回复人数" |
|---|---|---|---|
| `sent_confirmed` | `confirm_signal="platform_response"` 且 `platform_status_code=0`（如 `comment/publish` 成功码） | **是** | 是 |
| `sent_confirmed_dom` | 无平台响应，但回复节点稳定存在 ≥3000 ms（连续 3 次 1 秒轮询仍在且文本一致） | 否（`bill_dom_confirmed=false`） | 否（单列展示） |
| `sent_suspected` | 无明确失败信号，也拿不到上面任一确认条件。典型：编辑器/输入框消失、节点出现后立刻消失 | 否 | 否 |
| `failed` | 有明确失败信号：平台错误码、**空响应（视为风控拒绝）**、发送按钮报错、超时且元素未出现 | 否 | 否 |

- 约束 `sent_confirmed + sent_confirmed_dom + sent_suspected + failed = reply_attempts`（每个来源分别成立）。 ｜ **禁止**把 `sent_suspected` 或 `sent_confirmed_dom` 计入 `sent_confirmed`。历史遗留的"编辑器消失即判成功"必须改写为 `sent_suspected` 并在上报中走**不同字段**，不得混为一谈。空响应（无 `platform_status_code`）一律 `failed` + `risk_control_signal="empty_response"`，不得标记成功。
- 四个字段在聚合上报中各自独立，不设合并字段，避免下游误用。

### 7.3 去重用户数 `unique_users`
用户标识一律用 **`user_key_hash`**，**绝不上传原始 `sec_uid`**：`user_key_hash = hex_lower(hmac_sha256(privacy_salt, user_key_source))`。`privacy_salt` 由登录响应下发、每账号固定（保证服务端跨日去重一致），客户端不得自定义。`user_key_source` 优先级：`sec_uid` > `conversation_id`（私信无 `sec_uid` 时）> `uid_short`；同一账号内**不得混用类型**，混用记 `audit_flag:"user_key_type_mixed"`。
`sources.<src>.unique_users` = 本窗口该来源 `sent_confirmed` 对应的**去重用户数**（同窗口同一 `user_key_hash` 只算 1）；**只统计平台确认的成功**，疑似与 DOM 判据不计入，避免虚高。**已回复人数（看板定义）= `COUNT(DISTINCT user_key_hash WHERE verdict='sent_confirmed')`**，按查询区间与 `stats_tz_offset_minutes` 切分，展示必须标注"仅平台确认送达"。单列指标 `unique_users_confirmed_dom` 只做透明展示，不进入"已回复人数"。

### 7.4 `failure_reasons` 枚举（闭集）
`rate_limited`（平台限流）、`login_expired`（登录态失效）、`element_timeout`（元素未出现）、`network_error`、`risk_control_rejected`（风控拒绝，含空响应）、`content_rejected`（内容被平台拒绝）、`blocked_by_target`（被拒收/拉黑）、`account_risk`（账号风控）、`unknown`。**`editor_dismissed_unconfirmed` 不是失败原因**——它对应 `sent_suspected`，禁止出现在 `failure_reasons` 里。未知键 → 拒绝整条上报（`REPORT_INVALID`）。约束 `sum(failure_reasons.values) == sum(sources.*.failed)`，违反记 `audit_flag:"failure_sum_mismatch"`。

### 7.5 隐私边界（强约束）
**允许上报**：计数、时长、枚举码、`*_hash`、策略版本与上限值、`platform_endpoint` 白名单值、技术性错误摘要。**禁止上报**（出现即 `REPORT_PRIVACY_VIOLATION`，整条拒绝）：`comment_text`、`danmaku_text`、`reply_text`、`nickname`、`sec_uid`、`uid`、`phone`、`avatar_url`、`conversation_id`/`room_id`/`video_id`/`comment_id` 原文、任何完整 URL、任何可反查用户的内容片段。白名单优先：服务端按字段白名单校验，未知字段丢弃并记审计（向前兼容）；禁用字段直接拒绝整条。

### 7.6 看板指标 ↔ 服务端字段

| 看板指标 | 数据来源 |
|---|---|
| 截流总量 | `sum(leads_new)`（三来源合计） |
| 已回复人数 | `COUNT(DISTINCT user_key_hash WHERE verdict='sent_confirmed')` |
| 回复条数 | `COUNT(verdict='sent_confirmed')`；疑似与 DOM 判据单列 |
| 回复成功率 | `COUNT(sent_confirmed)/COUNT(reply_attempts)`（明细口径；分母为 0 时 `null`，前端显示 `—` 而非 100%） |
| 分来源明细 / 失败原因分布 | `send_log` 按 `source_type` 聚合的 `reply_attempts/sent_confirmed/failed`；`failure_reasons` 聚合 |

| 积分消耗（日/周/月）/ 近 7 日趋势 | `credit_ledger` 按 `settled_at_ms` + `stats_tz_offset_minutes` 聚合（**客户端不得自行计算**）；近 7 日按自然日聚合 `leads_new/sent_confirmed/usage_milli` |
| 近 7 日趋势 | 按自然日聚合 `leads_new/sent_confirmed/usage_milli` |
| 当日额度使用率 / 策略合规 | `daily_quota` 使用率、`policy_exceeded` 与 `tier_sending_disabled` 条数、`audit_config_changes` 中被拒的激进配置尝试 |

### 7.7 产品文案字段 `quota_notice`

| 字段 | 类型 | 说明 |
|---|---|---|
| `headline` / `detail` | string | 套餐页/充值页/首登弹窗/欠费提示四处必须原样展示；`daily_cap_total=0` 时必须用观察期文案 |
| `tier` / `account_day_index` / `collect_only` / `next_tier_at_day` | string / int / bool / int | 当前等级 / 账号第几天 / 是否只采集 / 下个等级生效日 |
| `daily_cap_total` / `daily_cap_detail` / `credits_per_day_at_cap` / `valid_days` / `estimated_days_at_cap` | int / object / int | 当前等级三来源日上限合计 / 分来源明细（观察期为 0） / 按日上限用满每天的积分消耗 / 套餐有效天数 / 按日上限估的可用天数 = `credits / credits_per_day_at_cap`（分母为 0 时 `null`） |
| `estimated_days_at_current_rate` | int | 按最近 7 日实际日均消耗估算的可用天数 |
| `note` / `generated_from_policy_version` | string / int | 默认 `"安全上限会限制实际消耗速度，因此套餐按期而非按量承诺"` / 本文案由哪个策略版本生成；**所有数字必须由 `tier_table` 实时生成，禁止硬编码** |

客户端必须原样展示 `headline` + `detail`；`estimated_days_at_current_rate` 必须与实际消耗一起展示，避免商家误判。

## 8. 版本与兼容
### 8.1 变更规则（`/api/v1/` 内）

| 变更类型 | 是否允许 | 处理方式 |
|---|---|---|
| 新增可选请求字段 | 允许 | 服务端忽略未识别请求字段（记审计），旧客户端不受影响 |
| 新增响应字段 | 允许 | 客户端必须忽略未识别字段，**不得因未知字段报错** |
| 新增枚举值 | 允许 | 客户端遇未知枚举按 `unknown` 处理并计数；`failure_reasons` 与 `platform_endpoint` 例外（闭集，见 8.2） |
| 字段语义变更 / 删除重命名 | 禁止 | 语义变更必须新增字段名并保留旧字段；删除或重命名先标 `deprecated_since`，**至少保留 90 天且跨 3 个客户端版本**，双写期内同时返回新旧字段 |
| 新增必填请求字段 | 禁止 | 只能新增可选字段 + 服务端默认值 |
| 改签名串/时间格式/金额单位/计费模型 | 禁止 | 不兼容变更，必须递增主版本 |

**已知不兼容变更**：`protocol_version 1 → 2` 把计费模型由"按挂钟时长"替换为"按平台确认的成功回复条数"，并移除上报体中的时长与分段字段（`duration_ms`/`segment_*`/`run_boundary`/`uptime_ms`）。v1 客户端必须升级，服务端对 v1 请求返回 `SERVER_VERSION_UNSUPPORTED`(426)。

### 8.2 最低版本、闭集、策略演进与上限同步
- 服务端维护 `min_client_version`（默认 `3.0.0`），bootstrap、login、heartbeat 三处都返回。`force_upgrade=true` 或 `client_version < min_client_version` → 客户端立即停机展示升级页、拒绝登录与心跳续期；服务端返回 `SERVER_VERSION_UNSUPPORTED`(426) + `upgrade_url`。
- `failure_reasons` 与 `platform_endpoint` 是**闭集**：未知键拒绝整条上报；扩充时必须先上线服务端支持，再把 `min_client_version` 提到引入新键的客户端版本之后。
- **策略版本演进**：服务端新增策略字段时，旧客户端不认识该字段 → 必须忽略并继续用已知字段限流，上报仍带它认识的 `policy_version`；服务端对旧版本客户端只返回其已知字段。**服务端不得因客户端不认识新字段而放宽任何已有上限。**
- **安全上限调整必须全链路同步**：`tier_table` 的 `daily_max`/`min_interval_ms`/天数边界一旦调整，`stable_daily_max_total`、`plan.credits`、`min_plan_credit`、`quota_notice` 文案、`daily_cap_total_by_tier` 与看板日上限**必须由同一张表实时重算**（禁止在多处硬编码）；调整后旧客户端只需重新拉取 `policy` 即可生效，无需发版。 ｜ **策略版本未知**（上报了服务端无记录的 `policy_version`）→ `POLICY_VERSION_UNKNOWN`(409)，客户端拉 `GET /policy/current` 对齐后重报；该批不落账不计费。
- 服务端维护中 → `SERVER_UNAVAILABLE`/`maintenance.active`：客户端进入离线降级（9.3），明细囤本地，恢复后补报。
- **客户端降级安装**：允许，但必须清空本地影子额度缓存（强制重取一次服务端余额）；只要 `client_version ≥ min_client_version`，补报正常受理。

## 9. 完整交互时序
### 9.1 场景一：首次登录（观察期，含策略下发与 ack）
1. `GET /client/bootstrap` → 校验版本与维护窗口；`force_upgrade=true` 则停机展示升级页，结束；`POST /auth/login`：服务端 scrypt 校验密码 → 设备数检查（超限则踢最早会话）→ 写 `device_session` → 计算 `account_day_index=2` → 命中 `observation`（第 1–3 天，`sending_enabled=false`，三来源 `daily_max=0`）→ 冻结 `policy v7` → 生成 `quota_notice` → 返回 `token`/`sign_key`/`privacy_salt`/`credit`/`policy`/`quota_notice`/`limits`/`login_proof`。
3. 客户端用 `PBKDF2(password)` 校验 `login_proof`，失败则拒绝登录且**不落盘**任何凭据；采纳 `policy v7` 写入本地 `policy.json` 并记录 `policy_hash`；原子落盘凭据与 `clock_skew_ms`；初始化影子额度 `local_budget = floor(balance_milli / credit_per_reply_milli)`；**观察期行为**：客户端进入"只采集不发送"——不生成任何 `send_id`、不发起评论/弹幕/私信；UI 原样展示观察期文案（"当前处于观察期，仅采集线索，第 4 天开始可发送"）。`POST /auth/refresh` 立即静默续期（旧 token 保留 5 分钟在途宽限）。
5. `POST /heartbeat`（`seq=1`、`applied_policy_version=7`、`applied_limits` 三来源 `daily_max` 全 0）→ 服务端建立 `policy_ack_log{first_ack_at_ms, account_tier, account_day_index, applied_limits_json}`，返回 `{state:"active", policy_changed:false, daily_quota{...remaining:0}, commands:[]}`；验签通过 → 启动采集引擎（不启动发送）；定时器：心跳 60s / 发送明细上报 5min（无发送则空批不上报）/ 聚合上报 30min；套餐页必须含 `quota_notice.headline` + `detail`。

### 9.2 场景二：正常运行与按条计费（预热期，含策略调低）
1. `t=0` 账号 `account_day_index=5` → `warm_up`（评论 10 / 弹幕 10 / 私信 3，最小间隔 180s / 90s / 900s）；本地上限 = `min(policy, 用户自定义)`，用户把 comment 降到 5/日 → 写审计 `{field:"limits.comment.daily_max", old:"10", new:"5", source:"user", applied:true}`；`t=1` HB `seq=1 {online_seconds:60, applied_limits{comment:{daily_max:5, min_interval_ms:240000}}, daily_used{comment:0}}` → `200 {state:"active", daily_quota{comment:{max:10,used:0,remaining:10}, live_danmaku:{max:10,used:0,remaining:10}, dm:{max:3,used:0,remaining:3}}, policy_changed:false}`（服务端额度按策略 10 计；客户端自限 5 且间隔拉长到 240s，属"更保守"合规）。
3. `t=2` 发送评论回复 #1：**发起前**生成 `send_id=s-aaaa` 并落盘 `pending_sends.json`；平台响应 `comment/publish {status_code:0}` → `verdict=sent_confirmed`，evidence 完整（暂存本地）。
4. `t=3` 发送私信 #1：平台返回**空响应** → `verdict=failed`、`evidence{confirm_signal:"none", risk_control_signal:"empty_response"}`、`failure_reason=risk_control_rejected` → **不计费**。
5. `t=6` 到达上报周期 → `POST /audit/sends {batch_id:b-1, sends:[s-aaaa, s-bbbb], policy_snapshot:{policy_version:9, applied_limits:{comment:{daily_max:5, min_interval_ms:240000}}}}` → `200 {results:[{s-aaaa, billed, 1000}, {s-bbbb, not_billable, 0}], settlement:{billed_count:1, charged_milli:1000, balance_milli:12599000}, daily_quota:{comment:{max:10,used:1,remaining:9}, dm:{max:3,used:1,remaining:2}}}`；客户端删除已 ACK 明细，`local_budget -= 1`。
6. `t=11` 用户想把 comment 调到 100/日、间隔缩到 30 秒（比策略更激进）→ 本地拦截并写审计 `{old:"5", new:"100", source:"user", applied:false, reject_code:"POLICY_VIOLATION"}` ← **"主动调高且被拒"的证据**。
7. `t=31` HB `seq=31` → `200 {policy:{policy_version:10, account_tier:"ramp_up", account_day_index:8, limits:{comment:{daily_max:25, min_interval_ms:120000}}}, policy_changed:true}`；客户端 60 秒内切换，本地上限 = `min(25, 用户设置 5) = 5`、间隔 = `max(120000, 240000) = 240000`，写审计 `{old:"10", new:"25", source:"server_policy", actor:"license_server", applied:true}`。
8. `t=32` HB `seq=32 {applied_policy_version:10, applied_policy_hash:"…"}` → `200 {policy_changed:false}`，ack 完成，`policy_ack_log` 记录 v10；`t=36` `POST /usage/report` → `200 {reconciliation:{detail_confirmed:1, reported_confirmed:1, match:true}}`。本小时实际消耗：**1.0 积分**（1 条平台确认成功；1 条风控失败 0 积分）。

### 9.3 场景三：断网 3 小时后恢复（补报与结算）
1. `t=0` 正常（预热期，评论上限 10/日）；最后一次成功心跳 `seq=100`，已知 `balance=12599000` → `local_budget=12599`；`t=1` 网络中断：心跳按退避重试（1s/2s/4s/8s…上限 60s），不阻断本地运行；发送明细只写本地 `pending_sends.json`（上限 `max_pending_sends=20000`）；影子额度按 `last_known_balance` 初始化 `local_budget = floor(12599000/1000) × 0.5 ≈ 6299` ← **只减不增，绝不凭空增加**。
3. `t=16` 离线超过 `offline_send_grace_ms`(15min) → 进入 `degraded`：允许继续发送但每条尝试都扣 `local_budget`，且**仍严格遵守当日策略上限**（离线不等于放宽）；影子额度耗尽 → 立即暂停（本地 fail-closed）。
4. `t=180` 恢复联网（离线 180 分钟，期间尝试 12 条、其中 10 条平台确认成功，全部在当日上限内）：① `GET /client/bootstrap` → 用 `server_time_ms` 重算 `clock_skew_ms`；② `POST /heartbeat (seq=101, pending_send_count=12, applied_policy_version=10)` → `200 {state:"active", policy_changed:true(v11, ramp_up 评论 25/日), daily_quota{...}}`（服务端此刻不知道离线期间发生了什么，余额仍显示 12599000）；③ 客户端 60 秒内切换策略并在下一次心跳 ack；④ `POST /usage/report`（聚合，窗口拆成 6 条）；⑤ 补报明细 `POST /audit/sends`（12 条按 `sent_at_ms` 升序单批，≤ `audit_batch_max=500`）→ `{results:[{billed,1000}×10, {not_billable,0}×2], settlement:{billed_count:10, charged_milli:10000, balance_milli:12589000}}`，服务端按每条 `sent_at_ms` 所属自然日的**等级与上限**核算，**风控拒绝不计费、超当日上限部分不计费、同 `send_id` 重发不重复扣费**；⑥ 客户端逐条删除已 ACK 明细，用响应 `balance_milli` 重算 `local_budget`（此处才允许刷新）；⑦ 若某批余额耗尽：剩余条目返回 `unbilled_insufficient_credit` + `commands[pause_engine]` → 客户端 ≤60 秒停机（见 9.4）。
5. 若离线超过 `grace_ms`(24h) 仍未恢复：客户端进入暂停态（停止发送），只保留本地采集与心跳重试。

### 9.4 场景四：余额耗尽停机（语义 = 禁止发送）
1. `t=0` `balance_milli = 300`（不足 1 条）；`t=1` HB `seq=N` → `200 active`（余额仍 > 0）；`t=2` 发送评论回复 → 平台确认成功 → `send_id=s-zzzz` 入 `pending_sends.json`。
3. `t=6` `POST /audit/sends {sends:[s-zzzz]}`：余额 300 < 1000 → 按 §6.5 跨零点那一条**全额入账**（唯一允许的一条透支）→ `balance_milli = 300-1000 = -700 ≤ 0` → `state="exhausted"`；响应 `200 {results:[{s-zzzz, billed, 1000}], settlement:{billed_count:1, charged_milli:1000, balance_milli:-700, state:"exhausted", unbilled_count:0}, commands:[{type:"pause_engine", reason:"CREDIT_EXHAUSTED"}]}`。
4. 客户端 ≤60 秒内：停止评论/弹幕/私信三类发送（`engine_state → paused`）、不再发起任何 `send`、UI 弹窗"积分不足，请联系客服充值"（同时展示 `quota_notice.headline`）。
5. `t=7` HB `seq=N+1` → **402** `{ok:false, code:"CREDIT_EXHAUSTED", detail:{balance_milli:-700, credit_per_reply_milli:1000}, sign}`；客户端验签通过 → 维持暂停态，每 5 分钟退避重试心跳。
6. 采集仍在本地继续（只读不发送），计数照常累加但不产生新 `send`。充值后（管理后台手工充值 或 `POST /credit/redeem`）→ `200 {balance_milli:5000300}` → 下一次心跳 ← `200 {state:"active", commands:[{type:"resume_engine"}]}` → 恢复发送（仍受当日上限约束）；**余额耗尽期间未计费的明细不被补扣**。
7. fail-closed 补充规则：以下任一成立时必须停止发送，不等待用户确认——a) 距上次成功心跳 > `offline_send_grace_ms` 且影子额度已耗尽；b) 任意一次响应验签失败；c) 收到 `POLICY_CIRCUIT_OPEN`、`POLICY_SENDING_DISABLED` 或 `circuit_break`/`pause_engine` 命令（按 `cooldown_until_ms` 等待）；d) 收到 `SERVER_VERSION_UNSUPPORTED`/`AUTH_TOKEN_REVOKED`/`AUTH_ACCOUNT_DISABLED`/`AUTH_ACCOUNT_EXPIRED`。

### 9.5 场景五：等级跃迁、策略收紧与熔断（服务端主动干预）
1. `t=0` 账号 `account_day_index=14`（`ramp_up`，评论 25/日、间隔 120s）；次日 `account_day_index=15` → 心跳下发 `policy v11 {account_tier:"stable", limits:{comment:{daily_max:30, min_interval_ms:60000}}}`（**甲方规格的天数边界与上限**），客户端切到 `min(30, 用户设置 5)`。
2. 服务端风控发现该账号近 20 条发送失败率 45% > `failure_rate_threshold`(0.4) → 心跳响应携带 `{policy:{policy_version:12, limits:{comment:{daily_max:15, min_interval_ms:120000}, live_danmaku:{daily_max:15, min_interval_ms:60000}, dm:{daily_max:5, min_interval_ms:600000}}}, policy_changed:true, circuit_breaker:{open:true, cooldown_until_ms:t+1800000, trigger:"failure_rate"}, commands:[{type:"circuit_break", cooldown_until_ms:…, reason:"failure_rate"}, {type:"throttle", limits:{comment:{daily_max:15, min_interval_ms:120000}}, reason:"POLICY_DAILY_CAP"}]}`（**收紧后的值仍落在甲方规格区间内**：评论日上限 ≤30、间隔 60–180 秒）；客户端 ≤60 秒内停止全部发送、切到新策略，写审计 `{field:"limits.comment.daily_max", old:"30", new:"15", source:"server_policy", applied:true}`。
3. `t=31` 冷却结束 → HB 响应 `circuit_breaker.open=false`、`commands:[{type:"resume_engine"}]` → 恢复发送（继续受 15/日、120 秒间隔约束）。
4. 若客户端在熔断期间上报新发送明细 → `409 POLICY_CIRCUIT_OPEN` 整批拒绝（但**已发生的**历史明细补报不受影响）；若客户端把 `comment.daily_max` 上报为 30（高于收紧后的策略 15）→ `409 POLICY_VIOLATION {detail:{source_type:"comment", field:"daily_max", reported:30, allowed:15, policy_version:12}}`；客户端必须降到 15 或更低并重新 ack，否则后续上报持续被拒。
