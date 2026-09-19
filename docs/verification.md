# v4 验证记录

更新时间：2026-09-19
分支：`rewrite/v4-agent`
基准提交：`09c8cda`

## 已完成

- GitHub CLI 已登录并成功克隆私有参考仓库；旧实现已整体迁移到 `archive/v3/`，新根契约与旧运行时代码分离。
- 根 `package.json`、`server/package.json`、`desktop/package.json` 均可被 Node JSON 解析。
- 根级 `git diff --check` 与 staged diff 检查通过。
- 参考仓库在迁移前运行 `npm test`：L1 单元、L2 契约、L3 脱敏 DOM、L4 集成全部通过；入口明确说明 L5 真机与 L6 长稳不在其范围内。
- 官方抖音能力资料已完成一手文档核对，结论见 [`reference-audit.md`](reference-audit.md)。
- `server` TypeScript build 通过；`scripts/verify-integration.mjs` 已通过真实回环 HTTP + `desktop/src/lib/api-client.js` + `TaskEngine` 黑盒契约：管理员建号、桌面登录、赠额/兑换、生成扣分、幂等冲突、并发余额、AI hold、provider 失败释放、过期 hold、注销、过期/禁用/设备撤销、跨用户隔离和 `sent_unknown` 闸门。

## 当前环境

| 项目 | 结果 |
|---|---|
| Node | `v24.18.0` |
| npm | `11.16.0` |
| Python | `3.12.10` |
| WSL | Ubuntu `24.04` 可见；Node `18.19.1` / npm `9.2.0`，低于服务端要求，暂不能作为 v4 运行环境 |
| Docker | 暂不可用：Docker Desktop Linux engine pipe 不存在 |

## 尚未通过的验收

- `server` build 与 4 个服务端测试通过；`desktop` 的三个入口脚本语法检查通过，但完整 check 仍被缺失的 `desktop/test/run.js` 阻塞，待桌面代理补齐测试后复跑。
- Linux 真实运行需在 WSL Ubuntu 或 GitHub Actions Ubuntu 完成；Windows 桌面包需在 Windows 实际启动并验证首次空态、登录、离线和错误状态。
- Electron 安装包、真实抖音页面、官方开放平台资格、真实自动发送、真实支付和生产部署均未验证。

## 验收顺序

1. 两个子项目分别 `npm ci`、`check`、`test`、`build`。
2. Ubuntu 上用临时 SQLite 做 bootstrap、账号登录、积分兑换、evaluate/draft、幂等、禁用/过期/注销和 provider 失败回滚。
3. Windows 上启动 Electron 空态、未授权、授权、离线和服务端错误状态；再验证便携包可重复启动。
4. 获得官方资质或测试账号后，逐渠道记录页面版本、权限、采集/发送证据和未验证边界。
