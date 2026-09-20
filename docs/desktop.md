# Windows Agent 桌面端设计与 API 约定

本文档只描述 `desktop/`，服务端实现以服务端代理的契约和接口为准。桌面端是商家电脑上的 Electron 分发包，负责任务配置、专用抖音窗口、事件去重、人工确认或自动发送前的硬门槛，以及与 Linux 授权中心通信。

## 边界

- 工作台账号由授权中心签发；抖音账号由商家在专用窗口内手动登录。桌面端不读取、导出或上传 Cookie、Token、密码。
- renderer 只通过窄白名单 IPC 取得脱敏状态，不持有授权 token。token 使用 Electron `safeStorage` 写入 `app.getPath('userData')` 下的本地文件。
- 目标窗口只允许 `https://douyin.com`、`https://www.douyin.com`、`https://live.douyin.com`、`https://v.douyin.com`；外部链接交给系统浏览器前仍需通过同一 allowlist，其他子域名会在任务保存或侧车调用前拒绝。
- 生产路径默认通过随包 `resources/probe/probe-agent.exe` 使用专用 Chrome；开发时才允许固定的 `DOUYIN_PROBE_PYTHON` 调用仓库 `probe/sidecar.py`。安装包缺少 sidecar 会明确报运行时缺失，不回退到用户任意 Python。
- 评论采集以 sidecar 返回的真实事件为输入；目标房间、作者标识和原文必须来自采集结果。视频评论回复要求唯一目标，直播只能发送公屏。Electron DOM bridge 只保留作离线 fixture 与回退，默认选择器为空且状态为“未校准”。
- 桌面端不会把“按钮消失”或“评论出现在列表”当作成功。由于此首版禁止臆造抖音私有接口，实际发送确认必须由后续平台适配器提供；不确定时记录 `unknown`，不重试。
- 余额、扣费、授权状态由服务端权威决定。客户端离线、授权过期或服务端拒绝时，停止收费动作和自动发送。

## 模块结构

```text
desktop/
  package.json                 Electron + electron-builder 元数据
  src/
    main.js                    主进程、IPC、窗口生命周期与调度
    preload.js                 contextBridge 窄 API
    lib/
      api-client.js            fetch API 客户端，不向 renderer 暴露 token
      auth-store.js             safeStorage 加密 token 与本地设备标识
      json-store.js             单写者、fsync、原子 JSON 存储与 Windows EXDEV 版本记录恢复
      task-engine.js            任务状态、事件去重、评估、冷却与发送门槛
      workflow-runtime.js       Agent 计划冻结、固定步骤、检查点、恢复与账号级锁
      browser-bridge.js         allowlist BrowserWindow 与固定 DOM 采集脚本
      probe-client.js           单飞 JSONL sidecar 客户端、超时/取消/输出边界
      probe-bridge.js           专用 Chrome 侧车适配、采集调度与发送未知态
      selectors.js              默认选择器 profile 与校准/可见匹配
      validation.js              IPC/API 输入校验
    renderer/
      index.html                语义化壳层
      app.js                    仅调用 window.agentApi，不接触 token
      styles.css                工具型桌面 UI 样式与状态
  test/
    run.js                      无网络契约与状态机测试
  build/probe/                  打包前放置 probe-agent.exe 与整个 onedir（含 _internal），映射到 resources/probe/
  release/                      本地产物，默认被 .gitignore 忽略
```

## 服务端 API 约定

桌面端默认读取环境变量 `DOUYIN_LICENSE_API`，未配置时使用 `http://127.0.0.1:18080`，方便与 Linux 服务端的本地反向代理联调。

| 方法 | 路径 | 请求 | 客户端用途 |
| --- | --- | --- | --- |
| POST | `/v1/auth/login` | `{ username, password, deviceId, deviceName }` | 登录，响应 `token` 与可选用户状态 |
| GET | `/v1/me` | 无 | 授权心跳；响应 `{ user, balance, features, device }` |
| POST | `/v1/auth/logout` | 无 | 注销当前设备会话 |
| GET | `/v1/credits/ledger` | 无 | 积分台账 |
| POST | `/v1/credits/redeem` | `{ code, idempotencyKey }` | 兑换卡密，必须幂等 |
| POST | `/v1/agent/evaluate` | `{ event, rule, idempotencyKey }` | 规则筛选与模板回复，服务端重验规则并按 `features.prices.evaluateReplyPrice` 扣积分，响应 `{ matched, intent, confidence, reason, reply, charged, balance, eventId, actionId? }` |
| POST | `/v1/agent/draft` | `{ event, businessContext, targetCustomer, replyInstructions, idempotencyKey }` | AI 意向判断和回复草稿，只有账号开通 `features.draft` 才可调用，按 `features.prices.draftPrice` 扣积分 |

`event.observedAt` 在发送给授权中心前统一为毫秒整数；桌面端把完整请求方法和原始 payload 与事件一起持久化，恢复生成始终复用该方法和幂等键，不随后来修改的任务模式改路由。

所有请求使用 `Authorization: Bearer <token>`。响应不是 2xx 时客户端不得把操作显示为成功；网络失败统一进入离线状态。`charged` 是服务端返回的整数积分，零费用也可能是合法结果，客户端不会本地扣积分，也不会在未得到服务端判定结果时发送。

## Python sidecar JSONL 约定

主进程为每个授权中心 URL + 工作台用户派生独立的 `state-dir`、Chrome `profile-dir` 和 loopback 端口。每次调用单独启动 sidecar，stdin/stdout 各一条 JSONL；命令行固定为 `--state-dir <...> --profile-dir <...> --port <...>`，renderer 不能提供命令路径或端口。请求方法白名单还包括用于释放自有 Chrome 的 `close`。输出支持同一请求 ID 的 progress，客户端以 `close` 事件确认 stdout 已排空；最终结果、子进程退出、超时和取消必须同时收敛，无最终结果、超时和取消都不会自动重试，发送记为 `unknown`。

`capabilities` 的能力键是 `video_capture`、`live_capture`、`video_reply`、`live_reply`、`private_reply`，每项形如 `{ implemented, autoEligible, validation, evidence }`。`implemented` 只表示动作已实现；自动模式还必须同时满足 `autoEligible=true`，二者都不能代替本次发送的平台响应确认。发送前仍做目标、房间、编辑器和授权预检，点击后没有平台响应只能记录 `unknown`。缺少 `autoEligible` 按 `false` 处理，避免把旧或不完整能力声明误当自动资格。

发送前由桌面端落盘 `sendId`。视频评论目标优先使用 sidecar 返回的稳定评论 ID，缺失时必须同时核对房间、作者和原文；私信目标必须带采集事件提供的 `authorId`，不按昵称猜测。`captcha`、`login_required`、`unsupported` 会停止本轮采集并暂停任务，等待人工处理或后续适配。

## IPC 约定

renderer 可调用的 API 只有以下语义化方法：

```js
window.agentApi = {
  getState(), login({ username, password }), logout(), refreshLicense(),
  listTasks(), saveTask(task), setTaskStatus({ id, status }), deleteTask(id),
  listLeads(), listLogs(), getLedger(), redeem(code),
  openTarget(url), closeTarget(), probeSelectors(profile), saveSelectors(profile),
  searchTargets({ keyword, maxVideos, scrollRounds })
}
```

主进程对每次 IPC 校验 `event.sender` 必须是主窗口的 `webContents.id`，并再次校验 URL、字段长度和任务状态。没有通用 `executeJavaScript` IPC；DOM 脚本只能由 `browser-bridge.js` 使用固定脚本执行。

## 任务与状态

任务最少包含：

```json
{
  "id": "task_...",
  "url": "https://www.douyin.com/video/...",
  "source": "video",
  "contactMode": "comment",
  "keywords": ["价格", "怎么买"],
  "excludeKeywords": ["投诉"],
  "replyTemplate": "您好，已看到您的问题，我们会尽快联系您。",
  "businessContext": "商家配置的商品或服务",
  "targetCustomer": "商家配置的目标客户",
  "replyInstructions": "话术要求与禁止承诺",
  "mode": "manual",
  "intervalMs": 60000,
  "dailyLimit": 0,
  "status": "paused",
  "selectorProfileId": "default-unverified"
}
```

`contactMode` 可选 `comment` 或 `private`。私信目标只能使用采集事件提供的 `authorId`，不能根据昵称猜测；自动模式只在 sidecar 声明当前渠道已实现时可选，人工动作仍要做目标预检，点击后没有平台响应也只能记录为 `unknown`。任务暂停、切换授权账号或关闭专用 Chrome 时会递增操作世代并取消自有侧车命令，旧发送结果不能恢复旧采集器。

任务状态为 `paused`、`running`、`stopped`、`needs_calibration`、`license_required` 或 `offline`。事件状态为 `observed`、`matched`、`awaiting_confirmation`、`charged`、`sent_unknown`、`skipped`、`failed`。采集事件以 `source + event.id` 去重；每次评估带客户端生成的幂等键，重启后复用 pending 记录，防止重复收费或重复发送。

## UI 设计规格

采用 ADS utility profile。界面是中文的轻量工作台：固定左侧导航（Agent、任务、线索、回复记录、积分、设置），顶部显示授权状态、抖音窗口连接状态和当前余额；Agent 页只负责提交意图、展示冻结的流程实例和人工恢复入口，任务/事件主区继续使用数据表，不把聊天内容当作执行控制。背景为冷白，正文使用系统无衬线字体，蓝紫色只表示可执行动作或选中状态，状态必须同时显示文字。

必须实现的真实状态：首次空数据、加载、已加载、局部失败、网络错误、离线、未授权、选择器未校准、积分不足、任务暂停和发送结果 `unknown`。演示数据若启用只能显式带“演示数据”标记，并且不会开放评估、扣费或发送绕过。

## 验证边界

- 单元测试覆盖输入校验、原子写、事件去重、授权门槛、幂等键和状态迁移。
- 本地数据先写临时文件并 `fsync`。若 Windows 当前用户数据目录拒绝同目录 rename，使用带 `revision + checksum` 的限量版本记录；读取按 revision 校验，检测到主记录或更高版本记录损坏时任务进入离线恢复状态，不会静默继续自动发送。
- `npm run build` 会先检查 `build/probe/probe-agent.exe` 与 `_internal` onedir 是否完整，再构建 Electron 包；它只验证 Electron 包和随包侧车运行时可分发，不代表抖音 DOM 兼容或真实账号发送成功。
- 当前没有真实抖音账号和经过校准的页面快照，因此选择器、评论采集和发送按钮操作均标记为“未真机验证”。
