# 平台运行时契约

这份文档描述 v4 平台层。视频搜索、评论区和直播间适配器只实现步骤执行器，不改变本契约。

## 边界

```text
Agent Chat / planner
        │ 只返回 workflowId + version + params
        ▼
固定 Workflow Runtime
        │ 读取冻结计划，不再调用模型
        ▼
业务步骤适配器（协作者实现）
        │ 返回 completed / retryable / unknown / checkpoint / wait_human / failed
        ▼
运行结果与 checkpoint ──► planner 判断下一项工作、重试或等待人工
```

模型不能在 `RUNNING` 状态插入步骤、修改已冻结参数、直接调用浏览器或发送消息。执行器不能自行调用模型。

## 工作流计划

计划必须包含：

```json
{
  "planId": "plan_…",
  "workflowId": "comment.reply_then_private",
  "version": "1",
  "params": { "accountId": "local-account-1", "knowledgeSetId": "kb_…" }
}
```

服务端注册的 workflow 定义决定步骤顺序和每步最多重试次数。客户端只能从服务端能力目录选择已启用版本；模型返回未知 workflow、未知版本或额外步骤时必须拒绝。

首批平台挂载点使用以下语义名称，是否可发行由适配器证据和服务端 feature 决定：

- `video.search`：查找候选视频；
- `comment.reply_then_private`：评论区先回复评论，再按冻结批次私信；
- `live.reply_then_private`：直播公屏先回复，再按冻结批次私信。

## 运行状态

`PLANNED → RUNNING → COMPLETED` 是正常路径。步骤结果可以转入：

- `retryable`：短退避重试，最多三次；耗尽后进入 `UNKNOWN`；
- `unknown`：网络、超时、发送已开始但结果未确认，必须保留同一 operation/idempotency key，不得换 key 重发；
- `checkpoint`：持久化游标和目标状态，等待下一轮恢复；
- `wait_human`：验证码、登录、授权、积分不足、平台页面变化等需要人工处理；
- `failed`：不可恢复的参数或契约错误。

人工处理完成后，运行时必须经过两次健康检查并确认授权、页面和额度条件满足，才能从同一 checkpoint 继续。手动暂停只接受用户显式继续。

## 租户知识库

知识库检索必须同时带 `userId/tenant`、`knowledgeSetId` 和冻结的 `knowledgeSetVersion`。查询不得跨用户回退到默认库；没有匹配或版本已失效时返回空结果或人工等待，不静默使用其他租户内容。服务端只保存必要的元数据和向量引用，provider key 不下发桌面端。

## 发送与积分

- 生成话术和发送动作是两个阶段；生成成功才按服务端价格扣积分。
- 每个生成、发送、checkpoint 都有幂等键；未知结果必须先查询原 operation，再决定人工确认或继续。
- 客户端不提交余额、价格、成功状态或 feature；服务端是唯一权威。
- 自动发送默认关闭，直到对应适配器有真实账号/页面或官方权限证据；未验证步骤只能返回 `wait_human` 或 `failed`。

## 多账号

不同抖音账号的运行上下文必须按账号隔离，并由账号级运行管理器调度；同一账号的浏览器上下文、页面动作和目标发送使用账号级锁。结果决策只能在服务端持久化非 `RUNNING` 状态后发生，模型返回的 `retry` 只是下一步建议，不得直接触发盲重发。账号凭据只留在本机专用 Chrome profile，服务端只管理工作台用户、设备、授权、积分和审计。
