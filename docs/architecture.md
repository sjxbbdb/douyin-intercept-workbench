# v4 架构与验收边界

## 目标

桌面 Agent 接收商家配置和可见互动事件，完成截流判断、回复候选和发送门控；授权端负责账号、设备、功能 entitlement、积分和审计。两端不共享运行时实现，只共享稳定的 HTTP 数据契约。

```text
商家 Windows
  Electron renderer
        │ 窄 IPC
  Electron main ── HTTPS + Bearer session ── Linux authorization server
        │
        └── 单命令受控 Python sidecar（只连接专用 Chrome）
                    │
              专用 Chrome / 可见 DOM-CDP
Linux
  Fastify authorization server ── SQLite ledger/audit
```

## 关键状态

- 授权：`active`、`expired`、`disabled`、`device_revoked`、`offline`；
- 任务：`paused`、`running`、`stopped`、`needs_calibration`、`license_required`、`offline`；
- 事件：`observed`、`matched`、`awaiting_confirmation`、`charged`、`sent_unknown`、`skipped`、`failed`；
- 未知结果不自动重试。发送动作必须先落盘幂等键；发送是生成回复之后的独立状态，未知发送不得改写成成功。

## 能力探索与适配器分层

当前允许并行探索以下能力：视频搜索、评论采集与筛选、评论回复、直播互动和私信触达。运行时固定为 Electron 主进程、专用 Chrome 和随包 Python sidecar；旧 DOM 适配器仅用于开发诊断与离线 fixture。官方 API、专用 Chrome 和 sidecar 适配器都必须报告 `capability_source`、`verification_status`、`failure_code`、`release_gate` 和 `runtime_version`。选择器、endpoint、成功码或频控没有证据时，状态为 `unverified`，自动发送拒绝。

Python sidecar 以 PyInstaller onedir 随 Electron `extraResources` 分发，生产分发不能要求商家自行安装 Python。主进程通过单命令 stdin JSON / stdout JSONL 协议调用 sidecar；固定方法、状态事件、取消、超时、账号隔离和未知发送结果见 [`sidecar-protocol.md`](sidecar-protocol.md)。

发行开关按能力分别设置：`video_search`、`comment_capture`、`comment_filter`、`comment_reply`、`live_interaction`、`private_message`。每个开关按实际接入方式记录账号/页面或官方 scope（适用时）、平台结果判据、幂等恢复、停止/撤销和脱敏回归；浏览器路径不因未采用官方 API 而被预先排除。未知发送结果必须保留并禁止自动重试或冒充成功，但不能据此关闭所有发送能力。

## 积分与授权

服务端是唯一计费权威。客户端不能提交 `price`、`charged`、`balance` 或策略上限作为事实；模板或 AI 回复成功生成时，服务端在 SQLite 事务中依据幂等键追加生成服务台账并扣分，生成失败不扣分。发送是后续独立状态：未知发送不得改写为成功，也不自动退款；客户端网络断开时必须用同一幂等键查询恢复生成结果，不能笼统地把网络错误当成未生成。兑换、充值和 Agent 动作都必须可审计、可重放而不重复扣费。

## 验收分层

1. 静态检查：两端语法、TypeScript 编译、依赖锁定和敏感文件忽略。
2. 离线测试：授权、设备、积分事务、幂等、输入校验、IPC 和状态机。
3. Linux 验证：真实 Linux/Ubuntu 上安装依赖、迁移 SQLite、启动健康检查、测试和重启恢复。
4. Windows 验证：真实 Windows 上构建并启动桌面包，检查首次空态、登录失败、登录成功、离线和服务端 API 契约。
5. 平台验证：按视频搜索、评论采集、评论筛选、评论回复、直播互动、私信触达逐项验证可见采集、发送前门控、平台响应和停止/撤销。
6. 商业验证：支付/充值接入另设里程碑；在真实支付未接入前，产品不得声称已支持购买积分。

每一层都必须单独汇报。通过第 1–2 层不能推出第 3–6 层通过。
