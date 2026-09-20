# v4 开发入口

先读根 [`AGENTS.md`](AGENTS.md)，再按正在修改的边界阅读：

1. [`docs/architecture.md`](docs/architecture.md)：系统边界、状态和验收门；
2. [`docs/api.md`](docs/api.md)：授权、积分和 Agent HTTP 契约；
3. [`docs/server.md`](docs/server.md)：Linux 服务端运行与恢复；
4. [`docs/desktop.md`](docs/desktop.md)：Windows 桌面端、IPC 和浏览器边界；
5. [`docs/reference-audit.md`](docs/reference-audit.md)：旧仓库和抖音官方能力审计。

## 子项目

`server/` 与 `desktop/` 是独立 Node 项目，各自维护 lockfile、测试和构建产物。根目录只提供聚合脚本，不在根目录安装业务依赖。

## 提交前

```bash
npm ci --prefix server
npm ci --prefix desktop
npm run check
npm test
```

涉及平台页面或真实发送时，还必须记录真实账号/官方资格、日期、页面版本、请求证据和未验证项；本地模拟测试不能替代真机验收。涉及部署时，在 Linux 或 GitHub Actions Ubuntu 上运行服务端验证，并保留可复查日志，不提交数据库、token、账号密码和私有截图。
