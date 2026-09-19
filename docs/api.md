# 授权端 HTTP 契约（v1）

授权端是 Linux 上独立部署的 Fastify 服务，所有路由以 `/v1` 为前缀。服务端是账号、功能 entitlement、积分与审计的唯一权威；客户端提交的 `price`、`features`、`charged` 等字段一律忽略或拒绝。

## 认证

普通账号和管理员账号使用不同的会话域。普通接口使用 `Authorization: Bearer <user-token>`，管理员接口使用 `Authorization: Bearer <admin-token>`；两者不能互换。token 是随机 opaque 值，数据库只保存 SHA-256 hash；密码只保存 scrypt hash，服务端日志不记录密码、token、兑换码原文或 AI key。

### `POST /v1/auth/login`

请求：`{ username, password, deviceId, deviceName }`。成功返回 `{ token, expiresAt, user, device }`。账号 disabled、过期、设备数超限、密码错误均返回统一的 `AUTH_INVALID` 或相应 401/403，不泄露账号是否存在。设备由 `(user_id, device_id)` 识别，重复登录复用设备记录；达到 `maxDevices` 拒绝新设备。

### `POST /v1/auth/logout`

撤销当前普通会话。重复调用幂等。

### `GET /v1/me`

返回：

```json
{
  "user": { "id": "u_…", "username": "shop", "expiresAt": 1770000000000, "status": "active" },
  "balance": 12,
  "features": { "evaluate": true, "draft": false },
  "device": { "id": "d_…", "name": "店铺电脑" }
}
```

每次受保护请求在线检查会话、账号状态、有效期和设备撤销状态。

### `GET /v1/credits/ledger`

返回当前用户 append-only 流水：`{ entries: [{id,delta,balanceAfter,kind,metadata,createdAt}], balance }`。金额是非负整数积分；客户端不可提交余额或余额后的值。

### `POST /v1/credits/redeem`

请求：`{ code, idempotencyKey }`。兑换码只可成功消费一次，兑换和流水写入同一事务。相同用户、相同 key、相同请求体重放原响应；相同 key 搭配不同 code 返回 `409 IDEMPOTENCY_CONFLICT`。兑换码过期、禁用或已兑换不改变余额。

## Agent 业务

### `POST /v1/agent/evaluate`

请求：

```json
{
  "event": { "id": "e1", "source": "video_comment", "roomId": "r1", "authorId": "a1", "authorName": "小王", "text": "多少钱", "observedAt": 1770000000000 },
  "rule": { "keywords": ["多少钱"], "excludeKeywords": ["售后"], "replyTemplate": "您好，{{authorName}}，请问您想了解哪个型号？" },
  "idempotencyKey": "event-e1-v1"
}
```

`source` 仅接受 `video_comment`、`live_comment`、`live_danmaku`。基础过滤不收费；不命中返回 `{matched:false,reply:null,charged:0,balance,eventId}`。命中后使用服务端 feature entitlement 与管理员配置的 `evaluateReplyPrice` 计费，客户端不能指定价格或强行启用 feature；默认价为 1 积分。成功返回 `{matched:true,reply,charged,balance,eventId,actionId}`。`actionId` 是服务端生成的审计动作 ID。相同 key 相同 payload 重放相同结果，不同 event/rule 返回 409。

### `POST /v1/agent/draft`

请求：`{ event, businessContext?, targetCustomer?, replyInstructions?, idempotencyKey }`。仅在用户拥有 `draft` entitlement 且服务端配置了 OpenAI-compatible `baseUrl`、`model`、API key 时可用；缺少任一项明确返回 503，不默认为某个模型。服务端从配置读取价格，不接受客户端覆盖。服务端先在事务中创建带 owner 的积分 hold，AI 成功后 capture 并追加收费流水，失败、超时、provider 503 或响应无法解析时 release，不扣积分。模型输出必须解析为 `{matched, intent: "purchase"|"question"|"other", confidence: 0..1, reason, reply}`；不符合结构也视为失败。响应 `{matched,intent,confidence,reason,reply,charged,balance,eventId,actionId}`。并发请求不能突破可用余额，过期 hold 会在请求前回收。评论内容会发送到本授权端配置的 provider，服务端不把原文写入日志或审计。

## 管理员

首次用 `npm run bootstrap -- --username <name>` 或环境变量 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 创建管理员；密码不会写入参数回显或日志。管理接口全部位于 `/v1/admin`，只能用 admin token：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/auth/login` | 管理员登录 |
| POST | `/auth/logout` | 撤销管理员会话 |
| GET | `/users` | 账号列表（不含密码） |
| POST | `/users` | 生成用户账号与一次性随机密码，响应返回一次 |
| PATCH | `/users/:id` | 启用/禁用、续期、设备数与 feature entitlement |
| POST | `/users/:id/renew` | 设置 `expiresAt` |
| POST | `/users/:id/disable` | 禁用账号并撤销会话 |
| POST | `/users/:id/reset-password` | 生成新随机密码并撤销旧会话 |
| GET | `/users/:id/devices` | 查看设备 |
| POST | `/users/:id/devices/:deviceId/revoke` | 解绑设备并撤销其会话 |
| POST | `/users/:id/credits` | 正整数充值，必须带 idempotencyKey |
| POST | `/redeem-codes` | 发行兑换码，响应仅显示一次原文 |
| GET | `/users/:id/ledger` | 查询用户流水 |
| PUT | `/settings/pricing` | 设置服务端 `evaluateReplyPrice`、`draftPrice` |

充值、兑换、扣费都使用 SQLite `BEGIN IMMEDIATE` 事务和唯一幂等键。管理员 API 返回的用户创建密码和兑换码只在创建响应中出现，不写日志；生产环境必须通过 HTTPS 反向代理提供服务。

## 错误体

统一为 `{ ok:false, code, message }`，不返回 stack。常见 code：`AUTH_INVALID`、`AUTH_EXPIRED`、`ACCOUNT_DISABLED`、`DEVICE_LIMIT`、`INSUFFICIENT_CREDITS`、`IDEMPOTENCY_CONFLICT`、`FEATURE_DISABLED`、`PROVIDER_NOT_CONFIGURED`、`PROVIDER_FAILED`、`VALIDATION_ERROR`、`INVALID_JSON`、`UNSUPPORTED_MEDIA_TYPE`、`BODY_TOO_LARGE`、`RATE_LIMITED`。
