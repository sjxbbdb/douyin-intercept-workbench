# v4 验证记录

更新时间：2026-09-19
分支：`rewrite/v4-agent`
基准提交：`c575f38`

## 已完成

- GitHub CLI 已登录并成功克隆私有参考仓库；旧实现已整体迁移到 `archive/v3/`，新根契约与旧运行时代码分离。
- 根 `package.json`、`server/package.json`、`desktop/package.json` 均可被 Node JSON 解析。
- 根级 `git diff --check` 与 staged diff 检查通过。
- 参考仓库在迁移前运行 `npm test`：L1 单元、L2 契约、L3 脱敏 DOM、L4 集成全部通过；入口明确说明 L5 真机与 L6 长稳不在其范围内。
- 官方抖音能力资料已完成一手文档核对，结论见 [`reference-audit.md`](reference-audit.md)。
- `server` TypeScript build 与 12 项服务端测试通过；`scripts/verify-integration.mjs` 已通过真实回环 HTTP + `desktop/src/lib/api-client.js` + `TaskEngine` 黑盒契约：管理员建号、桌面登录、赠额/兑换、生成扣分、幂等冲突、并发余额、AI hold、provider 失败释放、过期 hold、注销、过期/禁用/设备撤销、跨用户隔离和 `sent_unknown` 闸门。
- 只读 Electron 页面检查已解析用户提供的分享链接到 `https://www.douyin.com/video/7682712994194722091`，记录标题、页面完成状态和可见候选匹配计数；当前页面出现抖音登录弹窗，候选评论节点 5 个，候选评论文本/作者节点 0 个，未执行登录、采集或发送。证据写入被忽略的本地目录。
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

- 桌面三个入口脚本语法检查通过；`scripts/verify-electron-ui.mjs` 已真实启动 Electron 并覆盖未授权、设置地址、错误登录路径，但正确登录被桌面主进程的登录顺序问题阻断：当前实现先请求 `me`、后保存登录 token。启动首屏还需把 IPC 错误作为失败处理。桌面 worker 修复后必须重跑该脚本。
- 桌面账号 A/B 的本地数据隔离、任务草稿在刷新/heartbeat 后保留、待确认卡完整展示作者/原评论/目标房间，以及暂停/停止/删除操作仍需真实 Electron 回归。
- Linux 真实运行需在 WSL Ubuntu 或 GitHub Actions Ubuntu 完成；Windows 桌面包需在 Windows 实际启动并验证首次空态、登录、离线和错误状态。
- 视频搜索、评论采集与筛选、评论回复、直播互动和私信触达分别仍需按实际接入方式完成能力级真机验收；若采用官方 API，再单独完成对应资格核验。Electron 安装包、真实自动发送、真实支付和生产部署均未完成。

## 验收顺序

1. 两个子项目分别 `npm ci`、`check`、`test`、`build`。
2. Ubuntu 上用临时 SQLite 做 bootstrap、账号登录、积分兑换、evaluate/draft、幂等、禁用/过期/注销和 provider 失败回滚。
3. Windows 上启动 Electron 空态、未授权、授权、离线和服务端错误状态；再验证便携包可重复启动。
4. 按具体接入方式准备专用测试账号或官方 scope（适用时），逐能力记录页面版本、权限、采集/发送证据和未验证边界。
