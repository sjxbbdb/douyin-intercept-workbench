# v4 验证记录

更新时间：2026-09-19
分支：`rewrite/v4-agent`
记录提交：`ce9214b`

## 已完成

- 4.0.2 源码 UI 验证：`desktop` task-editor fixture 6 组通过；覆盖本轮读取数不等于命中数、今日判定/发送尝试分列、重新筛选显式触发与快速点击合并、不自动确认发送。部分结果与跨日归零逻辑由源码实现，未在该 fixture 中单独断言。渲染截图保存在被忽略的 `evidence-private/ui-4.0.2/task-quota-ui-wrapped.png`。
- 4.0.2 Windows 包验证：portable 与 NSIS 均通过 `scripts/verify-desktop-package.mjs` 的隔离 profile 启动、未授权空态、随包 sidecar probe、正常退出与重启授权检查；报告保存在被忽略的 `evidence-private/package/latest-package-check.json`。portable SHA-256 为 `C8A233F8F755FC31DA198074F5AC0D387FF295D86C37255363CAF7394B64AFD2`（106,976,656 bytes）；NSIS installer SHA-256 为 `914CAF62BBD8AD09F97F0BE2D80BED98D8A3084A64314F6084087821DC16BC06`（119,169,820 bytes）。
- 4.0.2 其它证据：desktop 22 项单元测试、独立 ProbeBridge 生命周期回归均通过；真实 HTTP 重筛验证仅新增 1 条 pending、扣 1 次匹配积分，再次重筛不重复扣费且不发送。上述验证使用隔离数据。

- 4.0.1 Windows 包回归：`desktop` check 16 项通过；portable 与 NSIS 均构建成功。实际包隔离验证覆盖新建空表单失焦、全字段填写、3 次 `refreshLicense` IPC、刷新按钮、35 秒自然 heartbeat、保存后列表、编辑/取消；任务保持 `manual/stopped`，未打开真实页面或调用生成/发送。portable 与 NSIS 均完成正常 `window.close()`、进程 `exitCode=0`、CDP 端口关闭和同一隔离 `userData` 重启授权恢复；随包 sidecar 五项能力与 installer `protocolVersion=1` 通过。源 Electron fixture 5 组回归通过；原 `344cb37` 可重现编辑器被后台状态更新退回，修复后后台刷新不保存草稿、保存成功才返回列表。
- 4.0.1 产物 SHA-256：portable `E0432AE440693E802A28A6361B512A19C345F3BEEB3A3514C6F3C316371A63CA`；NSIS installer `EBA8A4AF1B715969DCAE0239DBAF73EBF1E5E365DE4690E997CB90CF6538C8E4`。本次验证报告保存在被忽略的 `evidence-private/package/latest-package-check.json`；4.0.0 历史哈希记录保持不变。

- GitHub CLI 已登录并成功克隆私有参考仓库；旧实现已整体迁移到 `archive/v3/`，新根契约与旧运行时代码分离。
- 根 `package.json`、`server/package.json`、`desktop/package.json` 均可被 Node JSON 解析。
- 根级 `git diff --check` 与 staged diff 检查通过。
- 参考仓库在迁移前运行 `npm test`：L1 单元、L2 契约、L3 脱敏 DOM、L4 集成全部通过；入口明确说明 L5 真机与 L6 长稳不在其范围内。
- 官方抖音能力资料已完成一手文档核对，结论见 [`reference-audit.md`](reference-audit.md)。
- `server` TypeScript build 与 12 项服务端测试通过。`scripts/verify-integration.mjs` 的 A/B、并发、provider 失败、过期 hold、AI hold、真实 `ApiClient→TaskEngine` pending/unknown 和 D 会话隔离场景通过；E 已修复并通过，集成入口报告 `Integration contract PASS`。
- GitHub Actions `v4 CI` run `35442755342`（提交 `69242ea`）已成功：Ubuntu server build/tests、Ubuntu 跨模块集成和 Windows desktop check/tests 全部通过；Ubuntu probe 运行 21 项测试，其中 17 项执行、4 项因未安装 Chrome/Edge 跳过；runner 只报告 actions 使用 Node 20 的弃用提示。本机 probe fixture 回归为 21/21 通过。
- 独立 `scripts/verify-electron-login.mjs` 与完整 `scripts/verify-electron-ui.mjs` 已真实启动 Electron。UI 覆盖未授权浏览器操作拒绝、设置地址、错误登录、A 账号授权/积分流水/任务、聚焦表单 heartbeat 保留、退出后 B 账号空数据、回到 A 恢复数据；renderer 未显示密码或 token，截图写入被忽略的本地目录。
- 只读 Electron 页面检查已解析用户提供的分享链接到 `https://www.douyin.com/video/7682712994194722091`，主文档经历 302→200 且 `didFailLoad` 为空；标题匹配用户提供的视频，页面出现抖音登录弹窗。可见候选节点为 `commentNode=9`、`commentText=0`、`commentAuthor=0`、`commentId=0`、`sendButton=13`、`replyButton=13`；候选节点不等于已采集评论，未执行登录、采集或发送。证据写入被忽略的本地目录，检查时间为 `2026-09-19T09:35:12Z`。
- PR #1 合入了合作方独立 `probe/` 能力探索工具；合作方记录了视频搜索、评论采集/筛选和私信的实机探索。当前 Python sidecar 已由 desktop 主进程通过 `ProbeClient` 调用，server 仍独立掌握授权、积分和计费契约；这些记录证明探索路径与本地运行组件，不等于真实平台发送或服务端生产接线已通过。

## 当前环境

| 项目 | 结果 |
|---|---|
| Node | `v24.18.0` |
| npm | `11.16.0` |
| Python | `3.12.10` |
| WSL | Ubuntu `24.04` 可见；Node `18.19.1` / npm `9.2.0`，低于服务端要求，暂不能作为 v4 运行环境 |
| Docker | 暂不可用：Docker Desktop Linux engine pipe 不存在 |

## 限制与未验证项

- `npm --prefix desktop run check` 通过，包含 16 项桌面基础测试；其中 JsonStore 的 revision/EXDEV fallback 与 persisted running task 恢复测试通过。独立 `scripts/verify-electron-login.mjs` 已真实启动 Electron，在隔离临时 `userData` 中完成未授权空态和正确登录，renderer 未显示密码/token，错误日志未出现 `EXDEV`；匿名截图写入被忽略的本地目录。
- 真实 Python sidecar `capabilities` 已通过独立进程 JSONL 检查；真实 desktop `ProbeClient` 已连接真实 `probe/sidecar.py` 完成离线 capabilities 请求；fake sidecar integration 已覆盖搜索、评论、blocked/unknown、噪声、无终态、超时、忙拒绝和切账号取消，当前通过。
- 在新的 `AppData\Roaming` 临时目录中实测 JsonStore 写入、重启读取和清理通过，`originalAuthTouched=false`；这是实际文件系统检查，和 EXDEV fallback mock 单测分别记录。
- 最终 Windows 包已完成隔离验收：portable 与 NSIS installer 均完成未授权空态、登录、退出、再次登录、`window.close()` 正常退出、同一 `userData` 重启恢复授权；正常退出时进程 `exitCode=0` 且 CDP 端口关闭。两种包都通过真实 `window.agentApi.probeSelectors({})` 走到随包 sidecar，并返回五项能力键。检查时移除了 `PATH` 与 `DOUYIN_PROBE_PYTHON`；installer 安装目录含 `resources/probe/probe-agent.exe`，真实 capabilities 返回 `protocolVersion=1`、无 stderr。最终 portable SHA-256 为 `1C4BBE416582E54561C0D75A39CFD83A1067F0F52E35609EBA8CAAF630F53232`（118,936,472 bytes），installer SHA-256 为 `81B671A89D8C8E2BD780E18E368BB151BEE933BFCF71291AD72F545817353275`（119,166,462 bytes），随包 sidecar SHA-256 为 `F1CF743F58F5310F28F4F2999119997322A0635538B067AEB630E209A4F6DACA`（1,958,494 bytes）。
- 另以 `PACKAGE_EXIT_MODE=force` 对 portable 做独立强杀观察：终止前 `auth.json` 的 token 类型为 string 且有值，终止后文件保持，重启后会话回到未授权并清空本地授权显示。该结果仅记录强制终止路径，不能等同于正常退出失败；当前仍不把强杀后的会话恢复宣称为已支持。
- Linux 授权端候选分发包已生成到本地忽略目录，内容为 `dist/`、`package.json`、`package-lock.json`、`.env.example`、运行时 Dockerfile/Compose、`DEPLOY.md` 和 `SHA256SUMS`；未包含 `node_modules`、数据库、账号或凭据。本机 Windows Node 按 `node --env-file=.env` 流程临时执行生产依赖安装、编译产物 bootstrap、`/healthz`、停机重启读同一 SQLite 均通过；Docker daemon 不可用，因此未运行容器。该包只代表本机流程验证，不代表真实 Linux 运行或生产部署。
- Linux 包归档为 `linux-server-4.0.0.tar.gz`，压缩包内为清单 20 个文件加 `SHA256SUMS`，未带临时 `node_modules` 或 SQLite；归档 SHA-256 为 `216A5D6707BE1AB625D143737F981D2A370CCB88B1974CEA9123CB00E1DCADDF`，大小 36,260 bytes，生成时间 `2026-09-19 19:47:03`。
- 待确认卡完整展示作者/原评论/目标房间、暂停/停止/删除操作，已有源码 Electron UI 检查；已授权后的真实专用 Chrome 打开和搜索结果选择仍需在平台页面上操作验证。本脚本不把外部 Chrome 只读页面检查混入 UI 账号验收。
- 真实 Ubuntu 运行证据来自 GitHub Actions `35442755342` 的 server build/tests 和跨模块集成；本机分发包流程使用 Windows Node，不能替代 Ubuntu 或生产部署。Docker daemon 不可用，因此未运行容器。
- 视频搜索、评论采集与筛选、评论回复、直播互动和私信触达分别仍需按实际接入方式完成能力级真机验收；若采用官方 API，再单独完成对应资格核验。真实自动发送、真实支付和生产部署仍未完成。

## 验收顺序

1. 两个子项目分别 `npm ci`、`check`、`test`、`build`。
2. Ubuntu 上用临时 SQLite 做 bootstrap、账号登录、积分兑换、evaluate/draft、幂等、禁用/过期/注销和 provider 失败回滚。
3. Windows 上启动 Electron 空态、未授权、授权、离线和服务端错误状态；再验证便携包可重复启动。
4. 按具体接入方式准备专用测试账号或官方 scope（适用时），逐能力记录页面版本、权限、采集/发送证据和未验证边界。
