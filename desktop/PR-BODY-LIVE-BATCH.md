# feat(desktop): 固定工作流接入直播间【批次】协议（五个 live_* 方法 + 统一台账）

> 对应评审意见（只看代码/契约/平台接线，不含实机）：固定工作流没有调用
> `live_listen` / `live_plan` / `live_reply` / `live_private` / `live_result`；
> 关键词过滤、时间窗、去重、过期处理、原生「回复 TA」、私密账号跳过这些能力**没有地方被驱动**。

## 问题定位（不是"没实现"，是"没接线"）

| 层 | 现状 |
|---|---|
| 侧车（Python） | 五个 `live_*` 方法都已实现并有真机证据 |
| `probe-bridge` | 已暴露 `liveListen` / `livePlan` / `liveReply` / `livePrivate` / `liveResult` |
| **固定工作流** | **只用通用单发**（`collectOnce` / `sendReply` / `sendPrivate`），五个批次方法**零调用** |
| 平台运行时 | 有 `workflow_checkpoints` / `ledger`，但直播批次没有产生可消费的检查点与台账 |

## 本次改动

### 1. 新契约 `live.batch`（`desktop/src/lib/workflow-contracts.js`）

```
listen  -> live_listen    监听一轮并入队（去重与容量在侧车队列里）
plan    -> live_plan      冻结批次：关键词/排除词过滤、时间窗、过期处理、双渠道话术、回复通道
reply_public   -> live_reply    公屏回复（原生「回复 TA」），sideEffect + 必须 sent_confirmed
private_message-> live_private  私信，sideEffect + requiresPrevious(公屏确认成功)
report  -> live_result    批次检查点 + 统一台账
```

原来的 `live.reply_then_private` 只按"单个目标 + 通用单发"驱动，批次语义（关键词过滤/时间窗/
去重/过期/检查点/统一台账）没有地方表达，因此单独立一个 contract（保留旧的，不动它的语义）。

### 2. 适配器实现（`desktop/src/lib/workflow-adapter.js`）

* `listen`：`liveListen` → 检查点 `{phase:'listen', count, queue}`；登录/验证码转人工；无弹幕 wait_human。
* `plan`：把关键词、排除词、matchMode、时间窗、回复通道与**平台侧下发的话术**交给 `livePlan`
  （批次语义留在侧车里，适配器不重写过滤逻辑）；检查点带 `batchId / targets / blocked / expired / filter / replyMode / replyVia`；
  缺话术、批次为空、目标全被拦下一律 fail-closed。
* `reply_public`：`liveReply`（`mode=danmaku` = 原生「回复 TA」），每个目标派生稳定幂等 sendId
  （```<actionKey>~public~<eventId>```，重试不重复触达）；平台没有响应时如实保留 `unknown`，**绝不冒充成功**。
* `private_message`：只对**公屏已确认成功**的目标发私信，并逐项绑定那一次的 `publicSendId`
  （侧车会再校验：`public_missing` / `public_*` / `public_send_mismatch`，两侧一致）；
  私密账号 / 面板打不开的"跳过"（`evidence.skipped`）单独记账，不混进"发送失败"。
* `report`：`liveResult` → 批次检查点（含平台侧 `checkpoint` 与队列快照）+ 统一台账。

### 3. 统一台账（本次的核心交付）

同一条目标记录上同时挂公屏与私信的结果：

```
{ eventId, public: {status, reason, sendId, recordedState, roomEcho}, private: {status, reason, sendId, conversationEcho, skipped} }
```

并给出 `counts`：`publicConfirmed / publicUnknown / publicFailed / privateSent / privateUnknown / privateSkipped / privateBlocked`；
私信步骤另给 `skipped` 清单。检查点通过运行时既有链路自动上报平台运行时
（`main.js` → `api.checkpointWorkflow` → 服务端 `workflow_checkpoints`），
所以直播批次现在有了可恢复的检查点（`batchId` + 队列/过滤/计数快照）。

## 验证

```
npm run check      # 49 desktop tests + probe protocol 校验
npm test
```

新增两个用例（`desktop/test/run.js`）：
1. 五个方法按顺序被调用且参数正确（关键词/排除词/时间窗/话术/模式）；公屏 `unknown` 时**不发私信**；
   统一台账与平台检查点都出现在结果里；
2. 公屏确认成功后私信逐项绑定 `publicSendId`；被跳过的那条单独进 `skipped` 与计数。


## 附：为什么 Agent 聊天还起不了直播批次（以及怎么打开）

桌面端契约已经就位，但 `main.js -> runAgentChat` 只允许启动**授权中心 catalog 里 status=active**
的流程，catalog 来自服务端 `workflow_definitions` 表 —— 该表**只有 admin API 能写入**
（`server/src/workflow-routes.ts`: `POST /v1/admin/workflows`），代码里没有播种。

本 PR 附带一个幂等的注册脚本（契约直接取自 `desktop/src/lib/workflow-contracts.js`，避免两边漂移）：

```
node scripts/register-live-batch-workflow.mjs --dry-run            # 只打印 payload
node scripts/register-live-batch-workflow.mjs --endpoint https://api.example.com \
     --username admin --password '***'                             # 登录换 token 并注册
node scripts/register-live-batch-workflow.mjs --endpoint ... --token '***'
```

* 幂等：已注册同 `workflowId+version` 就跳过，不覆盖；
* 服务端已经支持把 `live.*` 映射到 `liveInteraction` 功能开关
  （`workflow-routes.ts` 的 `ensureWorkflowFeature`），所以注册后还要给账号开这个开关。

## 仍未接线（下一步）

* **Agent 聊天与任务面板**：还没有入口启动/监视 `live.batch` 运行（当前 UI 驱动的是评论流程）。
* **服务端台账**：统一台账已经在运行结果与检查点里，但服务端 `ledger` 还没有为直播公屏/私信
  生成按次条目（需要与积分/审计策略一起定）。
