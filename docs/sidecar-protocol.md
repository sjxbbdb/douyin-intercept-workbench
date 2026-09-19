# Python sidecar 进程协议

这是 Electron 主进程与随桌面端分发的 Python sidecar 之间的内部进程契约。协议只定义进程边界和状态语义，不授权 sidecar 绕过登录、验证码、风控或平台权限。sidecar 不读取或导出 Cookie、localStorage、access token、密码或 provider key；商家在专用 Chrome 中手动完成平台登录。

## 进程模型

- 每个命令启动一个 sidecar 子进程。主进程通过固定 CLI 参数 `--state-dir <dir> --profile-dir <dir> --port <port>` 传入账号作用域状态、专用 Chrome profile 和调试端口；请求 `params` 不重复携带这些路径。
- 主进程通过 stdin 写入一行 JSON，关闭 stdin 后等待 stdout 的 JSONL 响应。sidecar 不得跨账号复用 CLI 传入的目录，也不自行选择全局用户目录。
- Windows 发行包将 PyInstaller onedir 放在 Electron `extraResources`，主进程只启动固定包内入口和固定参数。开发环境可以用 Python 入口，但生产测试必须覆盖随包 runtime。
- stdout 只能输出协议 JSONL；诊断文本写 stderr。stderr 由主进程截断、脱敏后记录，不得包含凭据、页面完整 HTML、Cookie 或 token。
- sidecar 退出码只表示进程是否异常退出；平台发送结果必须以终态 `result.status` 为准。进程崩溃、超时或连接中断可能对应 `unknown`，不能被主进程当成成功或自动重试。

## 请求

每个命令只有一个请求对象：

```json
{"id":"cmd-uuid","method":"capabilities","params":{}}
```

`id` 是主进程生成的随机请求标识，在该进程生命周期内唯一；`method` 必须是下列之一：

| method | 目的 | 默认写操作 |
| --- | --- | --- |
| `capabilities` | 返回 sidecar/页面适配器能力和版本 | 否 |
| `launch` | 启动或连接专用 Chrome | 否 |
| `doctor` | 检查运行时、浏览器和页面前置条件 | 否 |
| `open` | 打开商家指定的目标页面 | 否 |
| `search` | 执行视频搜索并返回可见结果 | 否 |
| `collect_comments` | 采集可见评论；规则匹配由服务端完成 | 否 |
| `collect_live` | 采集可见直播互动 | 否 |
| `send_private` | 在人工确认和授权闸门之后发送私信 | 是 |
| `send_comment` | 在人工确认和授权闸门之后发送评论回复 | 是 |
| `close` | 关闭本账号 sidecar 持有的浏览器和命令资源 | 否 |

所有 `params` 都必须经过主进程 schema 校验。发送方法必须携带主进程生成的 `sendId`、实际 `target` 对象和实际待发送 `text`；`mode` 可以由 desktop 作为任务属性传入，但不是 sidecar 协议的必填字段。是否允许自动发送由桌面任务配置和授权闸门决定。积分扣减发生在服务端生成回复阶段，sidecar 不接收或修改余额、价格、charged 等计费事实。

## 响应

sidecar 按事件顺序输出 JSONL，每行一个对象，且都带同一个 `id`：

```json
{"id":"cmd-uuid","type":"progress","data":{"phase":"collecting","message":"visible page ready"}}
{"id":"cmd-uuid","ok":true,"result":{"items":[]}}
```

唯一允许的带 `type` 事件是 `progress`；成功或失败终态不带 `type`，且必须是最后一行。主进程收到终态后关闭 stdin 并回收子进程。失败示例：

```json
{"id":"cmd-uuid","ok":false,"error":{"code":"login_required","message":"专用窗口需要商家登录"}}
```

`error.code` 使用稳定的小写标识，例如 `invalid_params`、`runtime_missing`、`browser_unavailable`、`login_required`、`permission_denied`、`rate_limited`、`cancelled`、`timeout`、`platform_error`、`unknown`。`message` 面向日志和 UI，不能包含秘密或原始平台 token。

发送方法成功返回的 `result` 至少包含 `status`、`reason` 和 `sendId`，其中 `status` 为 `unknown`、`failed` 或 `blocked`，可以附带脱敏的 `evidence`。`unknown` 表示平台是否接受动作无法确认：主进程必须保留该状态、阻止同一 `sendId` 自动重试；不得改写成成功，也不能据此把所有发送能力关闭。

## 取消、超时和恢复

- renderer 只能请求主进程取消，不能直接操作 sidecar PID。主进程调用 ProbeClient 的 `cancel()`，立即杀死自己创建的 child，并等待 child 的 `close`；不得杀死其他 Chrome 或 sidecar。协议没有虚构的取消标记。
- 超时统一由主进程计时。超时后的发送结果为 `unknown`，非发送操作可以为 `timeout`；两者都不得隐式重试。
- 主进程重启后根据 `sendId` 恢复本地动作状态和生成请求幂等键；当前没有服务端发送查询 API，不能承诺查询平台发送状态。恢复动作不重新调用平台发送。
- sidecar 的临时文件和浏览器 profile 必须位于账号作用域目录；退出时清理命令临时文件，但保留经脱敏的诊断摘要和幂等状态。

## 能力和发行开关

`capabilities` 的 `result.capability` 至少包含以下固定五键，且每项都必须有 `implemented`、`autoEligible`、`validation`：

```json
{
  "result": {"capability": {
    "video_capture": {"implemented": true, "autoEligible": true, "validation": {"status": "api_or_visible_dom", "delivery": "capture_only"}},
    "private_reply": {"implemented": true, "autoEligible": true, "validation": {"status": "pr1_real_account_flow", "scope": "collaborator_account", "delivery": "unknown_without_bound_platform_response"}},
    "video_reply": {"implemented": true, "autoEligible": false, "validation": {"status": "offline_dom_fixture", "delivery": "unknown"}},
    "live_capture": {"implemented": true, "autoEligible": true, "validation": {"status": "offline_dom_fixture", "delivery": "capture_only"}},
    "live_reply": {"implemented": true, "autoEligible": false, "validation": {"status": "offline_dom_fixture", "delivery": "unknown"}}
  }}
}
```

`implemented` 表示运行组件存在，`autoEligible` 表示是否允许任务自动发送，`validation` 记录证据来源和范围；能力探测不能把 `implemented` 显示成“已真机验证”。收集事件的 `observedAt` 可在 sidecar 内部使用 ISO 字符串，但 desktop 发往授权端前必须转换为有限的整数毫秒。`collect_comments` 和 `collect_live` 只采集，关键词、排除词和意向判断由服务端规则或 AI draft 完成。官方 API 能力必须额外报告 scope/资格；未达到对应能力的发行开关时，主进程拒绝自动发送，但可以保留探测、人工预检和离线 fixture。

协议实现必须配套 fake sidecar 测试，覆盖正常 JSONL、无效响应、断进程、离线、切换账号、超时取消、`unknown` 不重试和两个账号的 state/profile 隔离。真实抖音验证另行记录，不能用 fake sidecar 结果替代。
