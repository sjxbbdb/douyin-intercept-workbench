# Linux 授权端

`server/` 是独立 Node.js 项目，要求 Node.js >= 22.13。运行时使用 Fastify 与内置 `node:sqlite`，数据库为单文件，适合 Docker Compose 持久卷挂载。服务端不接触抖音页面，也不向抖音发送消息；Windows 客户端只把筛选事件和服务端生成的回复带回本地可见页面操作。

## 启动

```bash
cd server
npm ci
npm run build
NODE_ENV=production DB_PATH=/data/license.sqlite node dist/main.js
```

容器部署使用 `docker compose up -d --build`。`server/Dockerfile` 是多阶段构建，运行层只安装 production 依赖、以 `node` 非 root 用户运行并把 `/data` 作为持久卷；`docker-compose.yml` 默认只把端口绑定到宿主机回环地址。生产入口应由 Nginx/Caddy 终止 HTTPS 后反代到 `127.0.0.1:18080`，不要直接公开 Node HTTP 端口。

健康检查：`GET /healthz` 只返回数据库可读状态，不泄露配置、账号、积分或 provider 信息。

## Bootstrap 与运营 CLI

首次启动前：

```bash
ADMIN_USERNAME=owner ADMIN_PASSWORD='从密码管理器注入' npm run bootstrap
```

也可省略环境变量后交互输入。CLI 支持管理员生成账号、禁用/续期、积分调整、兑换码发行、流水查询。密码、token、兑换码与 AI key 不写日志。新用户创建时随机密码只在命令输出中显示一次。

生产镜像不含 `tsx`，使用编译后的 CLI：

```bash
docker compose exec license-server node dist/bootstrap.js
docker compose exec license-server node dist/cli.js user-create --username shop-a
docker compose exec license-server node dist/cli.js credit-add --id <user-id> --amount 100 --idempotency-key initial-001
docker compose exec license-server node dist/cli.js code-create --credits 100 --count 10
docker compose exec license-server node dist/cli.js ledger --id <user-id>
```

管理 CLI 通过正在运行的 HTTPS/回环 HTTP API 执行操作，因此先在受保护 shell 中设置 `ADMIN_USERNAME`、`ADMIN_PASSWORD`；CLI 不支持把密码放在命令参数里，也不直接绕过服务端事务与审计。

## 配置

| 环境变量 | 用途 |
|---|---|
| `DB_PATH` | SQLite 文件路径，默认 `./data/license.sqlite` |
| `HOST` / `PORT` | 监听地址与端口，默认 `127.0.0.1:18080` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | bootstrap 初始管理员，仅 bootstrap 使用 |
| `OPENAI_COMPATIBLE_BASE_URL` | AI provider 地址；未配置时 draft 返回 503 |
| `OPENAI_COMPATIBLE_API_KEY` | AI provider key，不写数据库或日志 |
| `OPENAI_COMPATIBLE_MODEL` | provider 模型名 |
| `DRAFT_TIMEOUT_MS` | AI 请求超时，默认 30 秒 |

生产环境应由 Nginx/Caddy 终止 TLS，并仅将 `/v1` 与 `/healthz` 反代到回环监听的 Node 进程。不要把 HTTP 明文端口暴露到公网。数据库目录必须挂载持久卷并限制权限。应用层已启用请求体限制、输入校验和基于 IP 的 rate limit。

Fastify 默认不信任 `X-Forwarded-For`，因此不会无条件把客户端提供的头当作真实来源；保持这一默认值，或只在反向代理地址固定且受控时配置精确的 trusted proxy。若多个商家共用同一个回环反代而不传可信来源，登录限流会按代理 IP 汇总，这是预期的保守行为，应在受控代理层按租户/IP 做限流。

## 数据与恢复

积分余额不直接作为可被覆盖的字段使用；每次变化追加 ledger，事务内维护余额快照，余额永不小于零。AI draft 的 hold 带 owner、幂等键、过期时间和状态；每次请求前回收过期 hold。进程在 provider 成功后崩溃时，hold 会在过期后释放，客户端可用同 key 重试，服务端不会再次创建并行扣款。

备份优先在停服后复制数据库文件；需要在线备份时使用 Node `node:sqlite` 的一致性 backup 能力或 SQLite 官方 backup API，不能只复制仍在 WAL 写入的 `.sqlite` 文件。恢复前停止服务、替换整个数据库文件与 WAL/SHM 文件，再启动并检查 `/healthz`。

## 验证

```bash
npm test
npm run build
```

测试使用临时 SQLite 文件与 Fastify `inject`，覆盖未授权、过期/禁用、设备限制、跨用户余额、并发扣款、重复兑换、幂等冲突、负数、持久化、session 撤销与 provider 失败回滚。AI 测试使用本地 stub，不调用真实付费模型。
