# 服务端权威（甲）· 发送授权契约草案

> **状态**：设计草案，未实现。基线 `main`（`5ea65f2`）。
> **决策背景**：使用者选定"上限权威 = 服务端"（甲）。本文把这句决定变成可实现的契约。

## 一、先说清楚一个反直觉的事实

**服务端目前没有"发送上限"这个权威。** 实测（`server/src`，37/37 测试通过）它有的是：

| 已有权威 | 位置 | 性质 |
| --- | --- | --- |
| 积分价格 | `creditActionPolicy()` + `settings` 表；`ACTION_PRICE_MISMATCH`「积分价格必须由服务端策略决定」 | 服务端裁决，客户端不能自定 |
| 动作级预留 | `POST /v1/credits/actions/reserve\|commit\|release`（含 TTL、幂等） | **已经是"服务端计数 + 客户端持引用"的形状** |
| workflow 策略身份 | `policyRef` = `workflow-policy:<id>`，带版本，冻结与执行必须一致 | 身份绑定 |
| 账号 / 设备 / 会话 / 审计 | `/v1/me`、`/v1/admin/users/:id/devices`、`/v1/audit` | 主体与留痕 |

**没有的**：日上限 / 最小间隔 / 观察期 / 相似度阈值 / 活跃时段（也就是 v3 规格里的 `tier_table`）。
所以"甲"不是"把已有的接过来"，而是**要新建这一层**。

## 二、为什么"下发一张限额表"是不够的

如果服务端只是返回 `{hourly: 20, daily: 50}`，那么一个被改过的客户端拿到之后**完全可以不遵守**——
本地配置里写 `hourly: 100000` 就行了。**客户端不可能自我约束**，这是"给别人用"的核心难点。

所以甲的正确形态是 **逐次动作授权（per-action authorization）**：

    客户端要发一条  ->  向服务端申请授权  ->  服务端【计数 + 裁决】->  准/不准
                                              （配额/观察期/熔断都在这判）
                     ->  拿到 authorizationId  ->  执行时把它带回来
                     ->  服务端记账 + 审计

关键点：**计数在服务端**。客户端即使改了本地配置，服务端那边的账也不会多给一次。

## 三、复用已有的形状，不要发明新的

`/v1/credits/actions/reserve | commit | release` 已经是"预留—执行—了结 + TTL + 幂等"，
**发送授权应当沿用同一形状**，而不是另起一套：

| 阶段 | 发送授权 | 与积分动作的关系 |
| --- | --- | --- |
| 申请 | `POST /v1/send-authorizations` | 与 reserve 同构：占用一次配额 |
| 了结 | `POST /v1/send-authorizations/:id/commit` | 记录真实结果（sent_confirmed / unknown / failed） |
| 放弃 | `POST /v1/send-authorizations/:id/release` | 未执行就退掉 |
| 对账 | `GET /v1/send-authorizations/:id` | 客户端重启后恢复 |

授权本身带 `authorizationId` + `expiresAtMs` + `policyRef`（`send-policy:<version>`），
**probe 侧已有的钩子正好接住**：`policy_not_server_issued` / `policy_ref_missing` / `policy_ref_mismatch`
—— 现在它们只能校验"身份一致"，接上服务端之后才真正有内容可校验。

## 四、服务端在这一层裁决什么

客户端问"我现在能发给这个人吗"，服务端按顺序判（**任何一条不过就拒绝，并给出稳定原因**）：

1. **主体**：账号/设备/会话有效；平台账号属于该用户名下
2. **计费与配额**：今日/本小时已用 vs 上限（**计数在服务端**）
3. **观察期**：新账号上限为 0，**无任何跳过入口**
4. **最小间隔**：与上一条同账号动作的间隔
5. **熔断**：连续失败达阈 -> 冷却
6. **两阶段**：私信授权必须带一个 `publicSendId`，且服务端认可它的公屏结果为确认成功
7. **活跃时段**

返回：`{ status: 'granted', authorizationId, expiresAtMs, policyRef }`
或 `{ status: 'denied', reason: <稳定码> }`。

## 五、客户端（agent 层）必须遵守的 fail-closed 规则

1. **拿不到授权就不发。** 服务端不可达 / 超时 / 返回畸形 -> 一律 `blocked/authorization_unavailable`，
   **绝不退回本地默认值**。
2. **本地默认值只在"没有服务端"时作为下限存在**，并且必须在出参里标明
   `sourceOfLimits: "local_default"`（现状）而不是冒充服务端策略。
3. **授权一次一用**：`authorizationId` 绑定 `sendId`；重放同一 `sendId` 返回同一结果。
4. **服务端说不行就是不行**：客户端**不允许**用自己的判断覆盖 deny。

## 六、分阶段（每一阶段都可独立验收）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **S1** | 服务端：`GET /v1/policy/sending`（只读，返回当前账号的上限与观察期，标注 `source: server`） | 认证后可读；未认证 401；上限来自 `settings`，**客户端不能传参覆盖** |
| **S2** | 服务端：`POST /v1/send-authorizations` + commit/release + 服务端计数 | 超限必拒；同 `sendId` 幂等；观察期一律拒；每次裁决有审计行 |
| **S3** | agent 层：`get_account_health` 改读服务端策略；拿不到就 `canWork=false` 且标 `sourceOfLimits` | 断网 -> fail-closed，绝不退回本地默认 |
| **S4** | probe 侧：发送路径要求 `authorizationId`，缺失即 `policy_not_server_issued` | 不给授权 -> 拒发；给错授权 -> `policy_ref_mismatch` |
| **S5** | 真机：走完整链路发一条，验证"本地改配置也多发不出去" | 真机证据 |

**S1 可以立刻做**，它不改变任何现有行为（纯新增只读端点 + 两条测试）。

## 七、还没定的

1. **上限存在哪**：`settings` 全局一份，还是按用户/tier 分级？——建议先全局一份（与现有 pricing 一致），分级留到有第二个客户再说。
2. **配额计数用什么口径**：现在 probe 的本地闸门数是 `reserved/started/unknown/sent_confirmed`。服务端计数应沿用同一口径，否则两边会对不上账。
3. **对账冲突**：本地闸门与服务端授权都可能拒绝。**以更严的那个为准**——两边都过才发。
