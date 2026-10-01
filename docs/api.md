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
  "features": { "evaluate": true, "draft": false, "workflow": true, "prices": { "evaluateReplyPrice": 1, "draftPrice": 2, "workflows": { "video.search": 1, "comment.batch": 2, "live.batch": 2 } } },
  "device": { "id": "d_…", "name": "店铺电脑" }
}
```

每次受保护请求在线检查会话、账号状态、有效期和设备撤销状态。

### 平台账号与积分动作

`POST/GET /v1/platform-accounts` 管理当前工作台用户自己的抖音账号标识；`PATCH /v1/platform-accounts/:id` 只允许更新显示名或 `active/disabled` 状态。平台账号停用后，绑定它的固定流程不能继续写 checkpoint、续租或恢复。

`POST /v1/credits/actions/reserve` 只接受服务端登记的 owner 和价格，返回带过期时间的预留动作；`GET /v1/credits/actions/:id` 查询动作状态；`POST /v1/credits/actions/:id/commit` 或 `.../release` 使用幂等键完成结算。过期预留由服务端释放并写审计。客户端不能指定任意 owner、余额或成功状态。

### `GET /v1/credits/ledger`

返回当前用户 append-only 流水：`{ entries: [{id,delta,balanceAfter,kind,metadata,createdAt}], balance }`。金额是非负整数积分；客户端不可提交余额或余额后的值。

### `POST /v1/credits/redeem`

请求：`{ code, idempotencyKey }`。兑换码只可成功消费一次，兑换和流水写入同一事务。相同用户、相同 key、相同请求体重放原响应；相同 key 搭配不同 code 返回 `409 IDEMPOTENCY_CONFLICT`。兑换码过期、禁用或已兑换不改变余额。

## Agent 业务

### `POST /v1/agent/plan`

Agent 规划只返回已注册固定流程的 `workflowId`、`version` 和 `params`，不会返回步骤、浏览器动作或发送内容。请求还必须带 `idempotencyKey`；服务端使用账号 feature、活动 workflow 目录和服务端 provider 重验结果。provider 未配置、目录为空或模型返回未注册版本时分别返回 `PLANNER_NOT_CONFIGURED`、`WORKFLOW_CATALOG_EMPTY` 或 `PLANNER_INVALID_WORKFLOW`。规划结果只是冻结计划，不能直接发送。

### `POST /v1/reply-plans`

评论区和直播间的回复流程在启动前使用两阶段计划：客户端提交已选固定流程、租户自己的 `knowledgeSetId`/可选版本、检索问题和幂等键；授权端完成租户隔离的向量检索，再调用服务端 provider 生成 `publicReply` 与 `privateReply`。服务端只接受这两个字段，写入带 `policyRef`、知识集版本和片段引用的冻结 `workflow_plans`，返回 `status: "issued"` 后客户端才能创建运行实例。没有命中知识返回 `WAITING_HUMAN`；provider 超时、连接中断或输出不确定返回 `UNKNOWN`，同一幂等键只允许查询原结果，不会再次调用模型。回复生成发生在固定流程启动前；流程进入 `RUNNING` 后执行器不再调用模型。

### 固定流程运行与恢复

管理员通过 `POST /v1/admin/workflows` 注册带步骤契约的版本，普通账号通过 `GET /v1/workflows` 查看已启用目录。`POST /v1/workflow-runs` 使用 `planId + workflowId + version + params` 创建幂等运行实例；视频搜索、评论和直播的正式流程必须绑定当前用户的 active `platformAccountId`，服务端同时冻结契约 hash、功能 entitlement、账号作用域和积分价格策略。运行器通过 `POST /v1/workflow-runs/:id/checkpoints` 上报 `RUNNING`、`CHECKPOINT`、`UNKNOWN`、`WAITING_HUMAN`、`PAUSED`、`COMPLETED` 等状态，使用 `expectedVersion` 防止旧客户端覆盖新检查点。

平台固定目录包括 `video.search`、`comment.reply_then_private`、`comment.batch`、`live.reply_then_private` 和 `live.batch`。`comment.batch` 的批量私信只能使用同一批次里 `sent_confirmed` 的公屏 `sendId`，部分成功可以生成报告，`unknown` 目标不会盲目重发。

需要人工处理的运行实例使用 `.../human-wait` 记录脱敏原因和上下文。`.../recover` 或 `.../human-wait/resolve` 必须带连续两次健康检查结果；手动暂停还需要 `userConfirmed=true`。服务端不会因为恢复请求自动重发未知发送动作。

发送结果没有平台可验证回执时，运行实例会停在人工状态。操作者确认已在专用抖音页面处理后，可在持有租约的设备上调用 `POST /v1/workflow-runs/:id/manual-complete`（`note`、`idempotencyKey`、可选 `expectedVersion`）。授权端在事务中生成一次性 `manual_proof_*`、写入审计、完成服务端积分结算并把流程置为 `COMPLETED`；普通 checkpoint 不能伪造这个证明。

同一个运行实例在多设备之间由任务租约保护：`POST /v1/workflow-runs/:id/lease/acquire`、`.../lease/renew`、`.../lease/release` 以当前登录会话的 `deviceId` 作为租约身份，默认 120 秒、允许 5 到 600 秒。持有有效租约的设备才能写入检查点、恢复流程和请求结果决策；其他设备收到 `LEASE_HELD` 或 `LEASE_OWNER_MISMATCH`。客户端异常退出后租约自然过期，其他设备可以接管；租约操作都需要幂等键并写入审计。完整请求和桌面生命周期见 [workflow-lease.md](contracts/workflow-lease.md)。

流程上报非 `RUNNING` 结果后，客户端可调用 `POST /v1/workflow-runs/:id/result-decision`，请求携带当前服务端状态、脱敏 `summary` 和幂等键。服务端只接受与数据库运行状态一致的 `FAILED`、`COMPLETED`、`STOPPED`、`UNKNOWN`、`CHECKPOINT`、`WAITING_HUMAN` 或 `PAUSED`；运行中的流程返回 `RESULT_DECISION_RUNNING`。结果模型只能返回 `continue`、`retry`、`complete` 或 `wait_human`，该响应不会直接修改流程状态。桌面端把 `retry` 作为下一步建议，未知发送结果和人工等待继续保持人工门控，不会自动重发。

### `GET /v1/audit`

普通账号只能读取自己的脱敏审计条目（流程、检查点、积分结算、策略/知识版本和恢复原因）；原文、密码、token、provider key 和其他租户身份不会返回。管理员使用独立的 `/v1/admin/audit`。

### `knowledge-sets`

`POST/GET/PATCH /v1/knowledge-sets` 只管理当前工作台账号的知识集元数据和版本。运行实例可冻结 `knowledgeSetId + knowledgeSetVersion`；任何跨账号访问返回 `KNOWLEDGE_SET_NOT_FOUND`。向量内容和 provider key 不通过桌面端接口暴露。

`POST /v1/agent/plan` 的 `context` 可带 `knowledgeSetId`、可选 `knowledgeSetVersion`、`knowledgeQuery` 和 `knowledgeTopK`。授权端先按租户和版本检索，再把片段作为不可信参考交给规划器；成功计划会把同一知识集 ID/版本写回 `params`，客户端不能替换它。每个计划还会写入服务端生成的 `params.policyRef`（策略 ID、策略版本和可选知识集版本）；桌面端和 sidecar 必须在计划、公开回复、私信三个阶段原样回传，缺失或不一致直接暂停人工。服务端默认使用确定性的 `deterministic-token-bag`，配置 `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL` 后才启用 OpenAI-compatible `/embeddings`；不同 embedding 版本不会混用向量。

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

请求：`{ event, businessContext?, targetCustomer?, replyInstructions?, idempotencyKey }`。仅在用户拥有 `draft` entitlement 且服务端配置了 OpenAI-compatible `baseUrl`、`model`、API key 时可用；缺少任一项明确返回 503，不默认为某个模型。服务端从配置读取价格，不接受客户端覆盖。服务端先在事务中创建带 owner 的积分 hold，AI 成功后 capture 并追加收费流水。provider 超时、连接中断、响应无法解析或进程在 provider 返回前退出都保留 pending/hold 为 `unknown`，不删除幂等记录，也不换 key 自动重试；使用 `GET /v1/agent/draft/:idempotencyKey` 查询原操作，过期预留由服务端回收。模型输出必须解析为 `{matched, intent: "purchase"|"question"|"other", confidence: 0..1, reason, reply}`；不符合结构也视为不确定。成功响应 `{matched,intent,confidence,reason,reply,charged,balance,eventId,actionId}`。并发请求不能突破可用余额。评论内容会发送到本授权端配置的 provider，服务端不把原文写入日志或审计。

### `GET /v1/agent/draft/:idempotencyKey`

返回草稿操作的 `completed` 或 `unknown` 状态，以及脱敏的 hold 状态和过期时间。`unknown` 只提供核对依据，不会触发 provider 重试或积分扣除。

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
