# 抖音截流与自动回复 Agent v4

这是一个专门做抖音截流、线索判断和自动回复的 Agent。v4 采用两端架构：Linux 上的授权积分服务 `server/`，以及商家 Windows 电脑上的可分发桌面端 `desktop/`。旧工作台代码和文档已移到 [`archive/v3/`](archive/v3/)，只作为历史参考。

## 当前状态

已经落地的 v4 骨架：

- 独立 `server/` 和 `desktop/` 包边界；
- 授权端 HTTP 契约、账号/设备/会话/积分/幂等方向；
- Electron 桌面端的安全边界、任务状态和输入校验方向；
- 根级构建、检查和测试脚本；
- 旧仓库完整 Git 历史和平台能力审计，见 [`docs/reference-audit.md`](docs/reference-audit.md)。

尚未宣称完成的内容：

- 当前抖音版本的真实评论、直播弹幕和私信页面接入；
- 官方开放平台资质申请、正式 API 生产接入和平台审核；
- 真实账号上的自动发送与平台响应确认；
- 真实支付、充值渠道和商业套餐结算；
- Windows 安装包在本机的最终发布验收；
- Linux 生产部署和跨模块端到端验收。

代码测试、模拟 provider、脱敏 fixture 和本地构建只能证明程序边界，不证明抖音线上能力或账号安全。任何未有真实证据的发送结果都必须显示为未确认，并保持不扣积分。

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

官方开放 API 受账号类型、经营关系、scope、应用审核和业务频控约束；浏览器接入只允许商家主动登录的专用窗口。项目不读取或导出 Cookie、密码、localStorage、access token，也不绕过验证码、滑块和风控。平台能力的最新一手资料和旧实现的验证边界记录在 [`docs/reference-audit.md`](docs/reference-audit.md)。
