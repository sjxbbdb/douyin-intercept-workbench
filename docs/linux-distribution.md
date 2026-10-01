# Linux 授权端候选分发包

此候选包运行当前 `server/` 的 Linux 授权、账号、功能开关和积分台账服务。它不包含 `node_modules`、SQLite 数据库或任何凭据；首次运行前请在受信主机上复制 `.env.example` 为 `.env` 并设置 `DB_PATH`。

运行时需要 Linux x64 Node.js `>=22.13.0`（建议使用组织批准的 Node 22 LTS）和 npm。安装前确认 `node --version`，不要把运行时依赖或数据库写入归档目录以外的临时位置。

## 构建

在仓库根目录执行：

```bash
node scripts/build-linux-package.mjs
```

输出位于 `release-local/linux-server-4.0.0/` 和同名 `.tar.gz`。构建会执行 `npm ci --ignore-scripts` 与 `npm run build`，并写入 `SHA256SUMS`。重复构建时归档顺序、文件时间戳、归档属主和 gzip 时间戳均固定，输入不变时归档内容可复现。

## Linux 安装与启动

```bash
tar -xzf linux-server-4.0.0.tar.gz
cd linux-server-4.0.0
cp .env.example .env
# 编辑 .env，至少设置 DB_PATH、HOST、PORT；生产环境不要把数据库放在临时目录
npm ci --omit=dev --ignore-scripts
ADMIN_USERNAME=owner ADMIN_PASSWORD='长度至少 8 位的临时密码' node --env-file=.env dist/bootstrap.js
node --env-file=.env dist/main.js
```

`/healthz` 用于存活检查。管理端登录后可创建商家账号、充值积分和读取台账；商家账号登录后通过 `/v1/me` 查看授权和余额。密码只在创建或重置响应中返回一次，请由管理员安全交付并立即按组织策略轮换。

## 验收与边界

候选包可用 `LINUX_PACKAGE_ROOT=/绝对路径/linux-server-4.0.0 node scripts/verify-linux-package.mjs` 做本地隔离验收。验收会使用临时 SQLite、随机本地端口和生成的临时账号，不访问真实抖音或生产凭据，并验证 bootstrap、健康检查、重启后数据、生成账号登录、积分充值和台账读取。真实 Linux 部署、反向代理、备份恢复、TLS、官方平台资质和真实抖音页面能力仍需单独验收。

在 WSL 中验证时，建议先把归档解压到 Linux 原生临时目录（例如 `/tmp/douyin-v4-linux-package`），再设置 `LINUX_PACKAGE_ROOT` 执行脚本；不要在 `/mnt/d` 目录直接安装临时 `node_modules`，以免跨文件系统的文件锁影响 npm 安装。
