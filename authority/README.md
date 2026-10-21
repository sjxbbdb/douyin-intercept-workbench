# authority/ —— 发送授权服务（服务端权威）

> 这是"甲"的落地：**上限与放行由服务端裁决，客户端只能更保守。**
> 全部是新增代码：**没有改动 `probe/`、`server/`、`desktop/` 的任何一行。**

## 为什么不能只下发一张限额表

客户端拿到 `{hourly: 20}` 之后完全可以不遵守。**客户端不可能自我约束。**
所以这里做的是**逐次动作授权**：发之前先申请，服务端【计数 + 裁决】，发出去之后回来报结果。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/policy/sending` | 返回本账号当前生效的策略与上限（**客户端不能传参覆盖**） |
| POST | `/v1/send-authorizations` | 申请一次发送授权（按 `sendId` 幂等） |
| POST | `/v1/send-authorizations/:id/commit` | 回报真实结果（`sent_confirmed` / `unknown` / `failed` / `blocked`） |
| POST | `/v1/send-authorizations/:id/release` | 未执行就退掉 |
| GET | `/v1/send-authorizations/:id` | 对账（客户端重启后恢复） |

鉴权：`Authorization: Bearer <token>`。token 在 `<state-dir>/tokens.json` 里配，一行一个租户。

## 它怎么和 probe 接上（不用改 probe）

`probe` 里早就有两个钩子：

1. `comment_plan` / `live_plan` 会**拒绝调用方自带的策略内容**（`policy_not_server_issued`）；
2. `_require_policy` 会强制：**冻结计划时记下的服务端策略身份，执行时必须带回来且一致**
   （缺失 `policy_ref_missing`、不一致 `policy_ref_mismatch`）。

所以 agent 建批次时把本服务签发的 `policyRef` 交给 `comment_plan`，
probe 从此**自动**开始校验——一行都不用改。

## 裁决顺序（任何一条不过就拒，并给出稳定原因）

主体 → 观察期 → 单用户上限 → 小时上限 → 日上限 → 最小间隔 → 熔断 → 活跃时段 → 两阶段

其中**两阶段**是：私信授权必须带一个 `publicSendId`，且服务端**见过**它的公屏结果被 commit 成
`sent_confirmed`。没见过的、或不是确认成功的，一律拒。

## 计数口径必须与 probe 的本地闸门一致

`reserved / started / unknown / sent_confirmed` 计入；`failed / blocked` 不计。
小时窗口 = 滚动 3600 秒，日窗口 = 滚动 86400 秒。
**两边口径不一致就会对不上账**，所以这里照抄了 `probe/send_gate.py` 的口径并写了测试。

## 跑起来

    node authority/bin/serve.js --state-dir <目录> --port 8790

测试：`node --test`（离线，零依赖，不需要网络也不需要浏览器）。
