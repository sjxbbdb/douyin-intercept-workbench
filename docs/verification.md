# v4 验证记录

更新时间：2026-09-19
分支：`rewrite/v4-agent`
记录提交：`18154fc`

## 已完成

- GitHub CLI 已登录并成功克隆私有参考仓库；旧实现已整体迁移到 `archive/v3/`，新根契约与旧运行时代码分离。
- 根 `package.json`、`server/package.json`、`desktop/package.json` 均可被 Node JSON 解析。
- 根级 `git diff --check` 与 staged diff 检查通过。
- 参考仓库在迁移前运行 `npm test`：L1 单元、L2 契约、L3 脱敏 DOM、L4 集成全部通过；入口明确说明 L5 真机与 L6 长稳不在其范围内。
- 官方抖音能力资料已完成一手文档核对，结论见 [`reference-audit.md`](reference-audit.md)。
- `server` TypeScript build 与 12 项服务端测试通过。修正 fixture 的 `roomId`、`authorId` 和整数 `observedAt` 后，`scripts/verify-integration.mjs` 的 A/B、并发、provider 失败、过期 hold、AI hold 和 D 会话隔离场景通过；E TaskEngine 场景仍失败，因为 desktop 把 `rule` 放入服务端不接受的 `/v1/agent/draft` 请求体，事件记录为 `VALIDATION_ERROR`。当前不能把完整集成入口写成 PASS。
- 独立 `scripts/verify-electron-login.mjs` 与完整 `scripts/verify-electron-ui.mjs` 已真实启动 Electron。UI 覆盖未授权浏览器操作拒绝、设置地址、错误登录、A 账号授权/积分流水/任务、聚焦表单 heartbeat 保留、退出后 B 账号空数据、回到 A 恢复数据；renderer 未显示密码或 token，截图写入被忽略的本地目录。
- 只读 Electron 页面检查已解析用户提供的分享链接到 `https://www.douyin.com/video/7682712994194722091`，主文档经历 302→200 且 `didFailLoad` 为空；标题匹配用户提供的视频，页面出现抖音登录弹窗。可见候选节点为 `commentNode=9`、`commentText=0`、`commentAuthor=0`、`commentId=0`、`sendButton=13`、`replyButton=13`；候选节点不等于已采集评论，未执行登录、采集或发送。证据写入被忽略的本地目录，检查时间为 `2026-09-19T09:35:12Z`。
- PR #1 合并了合作方独立 `probe/` 能力探索工具；合作方记录了视频搜索、评论采集/筛选和私信的实机探索，但该工具没有接入 `server/` 或 `desktop/`，也不改变当前授权和计费契约。PR 的 Linux server CI 成功；Windows desktop 和跨模块 CI 因基线缺少 `desktop/package-lock.json` 而未执行到桌面测试。该记录证明独立 probe 的探索路径，不等于本项目发行能力或服务端计费接线已通过。

## 当前环境

| 项目 | 结果 |
|---|---|
| Node | `v24.18.0` |
| npm | `11.16.0` |
| Python | `3.12.10` |
| WSL | Ubuntu `24.04` 可见；Node `18.19.1` / npm `9.2.0`，低于服务端要求，暂不能作为 v4 运行环境 |
| Docker | 暂不可用：Docker Desktop Linux engine pipe 不存在 |

## 尚未通过的验收

- `npm --prefix desktop run check` 通过，包含 15 项桌面基础测试；其中 JsonStore 的 revision/EXDEV fallback 测试通过。独立 `scripts/verify-electron-login.mjs` 已真实启动 Electron，在隔离临时 `userData` 中完成未授权空态和正确登录，renderer 未显示密码/token，错误日志未出现 `EXDEV`；匿名截图写入被忽略的本地目录。
- 真实 Python sidecar `capabilities` 已通过独立进程 JSONL 检查；真实 desktop `ProbeClient` 已连接真实 `probe/sidecar.py` 完成离线 capabilities 请求；fake sidecar integration 已覆盖搜索、评论、blocked/unknown、噪声、无终态、超时、忙拒绝和切账号取消，当前通过。
- 在新的 `AppData\Roaming` 临时目录中实测 JsonStore 写入、重启读取和清理通过，`originalAuthTouched=false`；这是实际文件系统检查，和 EXDEV fallback mock 单测分别记录。
- 候选 Windows 包已做隔离启动验收：portable 与 NSIS installer 均能启动到未授权空态，installer 可静默安装后启动；检查时移除了 `PATH` 与 `DOUYIN_PROBE_PYTHON`。portable 的登录、退出和再次登录通过，但同一 `userData` 重启后回到未授权，说明候选包会话持久化仍未通过。两个产物均缺少 `resources/probe/probe-agent.exe`，真实 sidecar capabilities 无法运行，按 fail-closed 判定候选包不通过。portable SHA-256 为 `E159893913F1D50096A5438004A6FD521B925C6F499DAAB3A8335A5EC4BBEC11`（2026-09-19 19:22:24，99,986,610 bytes），installer SHA-256 为 `C8943523780A451B4A0C103A96B8D93573187BCA86BBC07E8122EE1C3AED0EB0`（2026-09-19 19:20:05，111,397,015 bytes）。
- Linux 授权端候选分发包已生成到本地忽略目录，内容为 `dist/`、`package.json`、`package-lock.json`、`.env.example`、运行时 Dockerfile/Compose、`DEPLOY.md` 和 `SHA256SUMS`；未包含 `node_modules`、数据库、账号或凭据。按 `node --env-file=.env` 流程临时执行生产依赖安装、编译产物 bootstrap、`/healthz`、停机重启读同一 SQLite 均通过；Docker daemon 不可用，因此未运行容器。该包只代表本地构建和启动验证，不代表生产部署。
- Linux 包归档为 `linux-server-4.0.0.tar.gz`，压缩包内为清单 20 个文件加 `SHA256SUMS`，未带临时 `node_modules` 或 SQLite；归档 SHA-256 为 `216A5D6707BE1AB625D143737F981D2A370CCB88B1974CEA9123CB00E1DCADDF`，大小 36,260 bytes，生成时间 `2026-09-19 19:47:03`。
- 待确认卡完整展示作者/原评论/目标房间、暂停/停止/删除操作，以及已授权后的真实专用 Chrome 打开/搜索结果选择仍需独立 Electron fixture 回归；本脚本不把外部 Chrome 只读页面检查混入 UI 账号验收。
- Linux 真实运行需在 WSL Ubuntu 或 GitHub Actions Ubuntu 完成；Windows 安装包仍需实际启动并验证首次空态、登录、离线和错误状态。
- 视频搜索、评论采集与筛选、评论回复、直播互动和私信触达分别仍需按实际接入方式完成能力级真机验收；若采用官方 API，再单独完成对应资格核验。Electron 安装包、真实自动发送、真实支付和生产部署均未完成。

## 验收顺序

1. 两个子项目分别 `npm ci`、`check`、`test`、`build`。
2. Ubuntu 上用临时 SQLite 做 bootstrap、账号登录、积分兑换、evaluate/draft、幂等、禁用/过期/注销和 provider 失败回滚。
3. Windows 上启动 Electron 空态、未授权、授权、离线和服务端错误状态；再验证便携包可重复启动。
4. 按具体接入方式准备专用测试账号或官方 scope（适用时），逐能力记录页面版本、权限、采集/发送证据和未验证边界。
