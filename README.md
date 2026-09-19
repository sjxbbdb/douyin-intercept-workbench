# 抖音截流与自动回复 Agent v4

这是一个专门做抖音截流的 Agent。探索范围包括视频搜索、评论采集与筛选、评论回复、直播互动和私信触达；v4 采用两端架构：Linux 上的授权积分服务 `server/`，以及商家 Windows 电脑上的可分发桌面端 `desktop/`。旧工作台代码和文档已移到 [`archive/v3/`](archive/v3/)，只作为历史参考。

## 当前状态

已经落地并通过本地验证的 v4 功能：

- 独立 `server/` 和 `desktop/` 包边界；
- Linux 授权端的账号、设备、会话、功能开关、积分台账、兑换码、幂等和 AI provider hold；
- Electron 桌面端的 API client、任务状态机、人工确认队列、可见 DOM/CDP 专用窗口和输入校验；
- 服务端 12 项测试，以及真实回环 HTTP + desktop `ApiClient` + `TaskEngine` 黑盒集成验收；
- 旧仓库完整 Git 历史和平台能力审计，见 [`docs/reference-audit.md`](docs/reference-audit.md)。

能力开发按证据推进。视频搜索、评论采集与筛选、评论回复、直播互动和私信触达都可以继续开发。能力先在独立探针、专用 Chrome 或 Python sidecar 中取得与具体接入方式相匹配的证据，再决定是否接入桌面端和发行开关；官方 API 路径单独核验 scope/资格，浏览器路径记录页面、账号和操作边界，不凭空要求官方 API 资格。

尚未宣称完成的内容：

- 当前抖音版本的各能力接入仍按能力矩阵逐项验收；合作方独立 `probe/` 已有视频搜索、评论采集/筛选和私信的实机探索记录，但尚未接入本项目授权、积分和桌面运行时；
- 官方开放平台资质申请、正式 API 生产接入和平台审核；
- 真实账号上的评论/直播/私信发送与平台响应确认；
- 真实支付、充值渠道和商业套餐结算；
- Windows 安装包在本机的最终发布验收；
- Linux 生产部署和跨模块端到端验收。

代码测试、模拟 provider、脱敏 fixture 和本地构建只能证明程序边界，不证明抖音线上能力或账号安全。模板或 AI 回复成功生成时按服务端价格扣积分；生成失败不扣积分。发送是后续独立状态，平台未知结果不得改写为成功，也不自动退款。任何候选能力都必须通过同一授权、积分、幂等和停止闸门。

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
cd desktop
npm ci
npm run check
npm test
npm run build:portable
```

根目录聚合命令：

```bash
npm run check
npm test
npm run build
```

服务端部署说明见 [`docs/server.md`](docs/server.md)，桌面端说明见 [`docs/desktop.md`](docs/desktop.md)，HTTP 契约见 [`docs/api.md`](docs/api.md)，架构和验收边界见 [`docs/architecture.md`](docs/architecture.md)。

## 平台接入原则

官方开放 API 受账号类型、经营关系、scope、应用审核和业务频控约束，只有采用官方 API 的能力需要核验相应资格；浏览器接入只允许商家主动登录的专用窗口，Python sidecar 作为随桌面端分发的受控运行时。项目不读取或导出 Cookie、密码、localStorage、access token，也不绕过验证码、滑块和风控。平台能力的最新一手资料和旧实现的验证边界记录在 [`docs/reference-audit.md`](docs/reference-audit.md)。
