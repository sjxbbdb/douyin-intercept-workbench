# 抖音截流与自动回复 Agent v4

这是一个专门做抖音截流的 Agent。探索范围包括视频搜索、评论采集与筛选、评论回复、直播互动和私信触达；v4 采用两端架构：Linux 上的授权积分服务 `server/`，以及商家 Windows 电脑上的可分发桌面端 `desktop/`。旧工作台代码和文档已移到 [`archive/v3/`](archive/v3/)，只作为历史参考。

## 当前状态

已经落地并通过本地验证的 v4 功能：

- 独立 `server/` 和 `desktop/` 包边界；
- Linux 授权端的账号、设备、会话、功能开关、积分台账、兑换码、幂等和 AI provider hold；
- Electron 桌面端的 API client、任务状态机、人工确认队列、可见 DOM/CDP 专用窗口和输入校验；
- 平台层的版本化固定 workflow、Agent 规划契约、运行实例 checkpoint/人工恢复、账号级锁和 Agent 对话入口；桌面端已把协作者 sidecar 挂到平台适配层，评论/直播固定为“公屏回复确认后再私信”；
- 服务端测试，以及真实回环 HTTP + desktop `ApiClient` 的授权/积分/幂等/会话隔离验收；TaskEngine 到规则 `/evaluate` 和 AI `/draft` 的 HTTP A–E 集成均已通过，二者请求体按服务端契约分离，时间字段在授权端使用整数毫秒；
- 旧仓库完整 Git 历史和平台能力审计，见 [`docs/reference-audit.md`](docs/reference-audit.md)。桌面端已接入受控 Python sidecar 的 JSONL 主链路；sidecar 以 PyInstaller onedir 随包分发，不能把“本地 capabilities 联通”误读为线上平台能力已验证。

能力开发按证据推进。视频搜索、评论采集与筛选、评论回复、直播互动和私信触达都可以继续开发。能力先在独立探针、专用 Chrome 或 Python sidecar 中取得与具体接入方式相匹配的证据，再决定是否接入桌面端和发行开关；官方 API 路径单独核验 scope/资格，浏览器路径记录页面、账号和操作边界，不凭空要求官方 API 资格。

尚未宣称完成的内容：

- 当前抖音版本的各能力接入仍按能力矩阵逐项验收；合作方独立 `probe/` 有视频搜索、评论采集/筛选和私信的实机探索记录。sidecar 的 capability 已实现并随包联通，但评论/直播发送仍因缺少 `sent_confirmed` 的真实平台响应证据而 fail-closed；
- 官方开放平台资质申请、正式 API 生产接入和平台审核；
- 真实账号上的评论/直播/私信发送与平台响应确认；
- 真实支付、充值渠道和商业套餐结算；
- 正式 GitHub Release；最终 CI、包 hash 和本地验收记录见 [`docs/verification.md`](docs/verification.md)；
- Linux 生产部署和真实抖音平台结果确认。

代码测试、模拟 provider、脱敏 fixture 和本地构建只能证明程序边界，不证明抖音线上能力或账号安全。模板或 AI 回复成功生成时按服务端价格扣积分；生成失败不扣积分。发送是后续独立状态，平台未知结果不得改写为成功，也不自动退款。任何候选能力都必须通过同一授权、积分、幂等和停止闸门。

平台运行时契约见 [`docs/platform-runtime-contract.md`](docs/platform-runtime-contract.md)：模型只选择服务端注册的 `workflowId + version + params`，固定流程运行后不再调用模型。三个业务流程已由平台适配层接入 sidecar；未获得 `sent_confirmed` 证据的步骤默认进入 `UNKNOWN` 或人工等待。

## 运行与验证

服务端（Linux）：

```bash
cd server
npm ci
npm run build
npm test
npm run start
```

桌面端（Windows）：

```powershell
cd probe
.\build_sidecar.cmd
cd ..\desktop
New-Item .\build\probe -ItemType Directory -Force | Out-Null
Copy-Item ..\probe\dist\probe-agent\* .\build\probe -Recurse -Force
npm ci
npm run check
npm test
npm run build
```

`build_sidecar.cmd` 产出的是完整 PyInstaller onedir；必须复制整个目录（包括 `_internal`）到 `desktop/build/probe`。发行包自带 sidecar，用户无需安装 Python。构建前置检查会在 runtime 缺失时失败。

根目录聚合命令：

```bash
npm run check
npm test
npm run build
```

服务端部署说明见 [`docs/server.md`](docs/server.md)，桌面端说明见 [`docs/desktop.md`](docs/desktop.md)，HTTP 契约见 [`docs/api.md`](docs/api.md)，架构和验收边界见 [`docs/architecture.md`](docs/architecture.md)。

## 平台接入原则

官方开放 API 受账号类型、经营关系、scope、应用审核和业务频控约束，只有采用官方 API 的能力需要核验相应资格；浏览器接入只允许商家主动登录的专用窗口，Python sidecar 作为随桌面端分发的受控运行时。项目不读取或导出 Cookie、密码、localStorage、access token，也不绕过验证码、滑块和风控。平台能力的最新一手资料和旧实现的验证边界记录在 [`docs/reference-audit.md`](docs/reference-audit.md)。
