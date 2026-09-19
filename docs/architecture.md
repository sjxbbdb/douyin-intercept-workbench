# v4 架构与验收边界

## 目标

桌面 Agent 接收商家配置和可见互动事件，完成截流判断、回复候选和发送门控；授权端负责账号、设备、功能 entitlement、积分和审计。两端不共享运行时实现，只共享稳定的 HTTP 数据契约。

```text
商家 Windows
  Electron renderer
        │ 窄 IPC
  Electron main ── 可见 DOM-CDP adapter（官方 API 作为未来扩展）
        │ HTTPS + Bearer session
Linux
  Fastify authorization server ── SQLite ledger/audit
```

## 关键状态

- 授权：`active`、`expired`、`disabled`、`device_revoked`、`offline`；
- 任务：`paused`、`running`、`stopped`、`needs_calibration`、`license_required`、`offline`；
- 事件：`observed`、`matched`、`awaiting_confirmation`、`charged`、`sent_unknown`、`skipped`、`failed`；
- 未知结果不自动重试。发送动作必须先落盘幂等键；发送是生成回复之后的独立状态，未知发送不得改写成成功。

## 适配器分层

官方 API 适配器属于未来扩展；浏览器适配器只使用商家手动登录的专用窗口和可见 DOM/CDP。适配器必须报告 `capability_source`、`verification_status` 和 `failure_code`。选择器、endpoint、成功码或频控没有证据时，状态为 `unverified`，自动发送拒绝。

## 积分与授权

服务端是唯一计费权威。客户端不能提交 `price`、`charged`、`balance` 或策略上限作为事实；模板或 AI 回复成功生成时，服务端在 SQLite 事务中依据幂等键追加生成服务台账并扣分，生成失败不扣分。发送是后续独立状态：未知发送不得改写为成功，也不自动退款；客户端网络断开时必须用同一幂等键查询恢复生成结果，不能笼统地把网络错误当成未生成。兑换、充值和 Agent 动作都必须可审计、可重放而不重复扣费。

## 验收分层

1. 静态检查：两端语法、TypeScript 编译、依赖锁定和敏感文件忽略。
2. 离线测试：授权、设备、积分事务、幂等、输入校验、IPC 和状态机。
3. Linux 验证：真实 Linux/Ubuntu 上安装依赖、迁移 SQLite、启动健康检查、测试和重启恢复。
4. Windows 验证：真实 Windows 上构建并启动桌面包，检查首次空态、登录失败、登录成功、离线和服务端 API 契约。
5. 平台验证：具有明确官方资格或测试账号后，逐渠道验证可见采集、发送前门控、平台响应和停止/撤销。
6. 商业验证：支付/充值接入另设里程碑；在真实支付未接入前，产品不得声称已支持购买积分。

每一层都必须单独汇报。通过第 1–2 层不能推出第 3–6 层通过。
