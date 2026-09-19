# 发布草稿

当前没有正式 GitHub Release 或预发行版。已有本地 Windows 候选包在隔离的临时 `userData` 中通过启动、空态、授权、正常退出/重启授权保留和随包 sidecar IPC 检查；最终 CI 结果与哈希见 [`verification.md`](verification.md)。积分流水和错误态属于源码 Electron UI 验收，不能从包启动检查推导。能力优先开发不等于能力全部随包发布。

## 预发行清单

### 4.0.3 本地候选包

4.0.3 修复长 URL 在任务表格中的布局挤压，以及浏览器 owned target 失效后的恢复路径。portable 与 NSIS 已使用 `desktop/.builder-cache` 和同盘临时目录构建；portable 通过 `PACKAGE_DIAG_ONLY=portable` 隔离验收。portable SHA-256 为 `C969FC3F1387D3FC731B8A812E4F846E9622D2BDEDD781C93E335D76B1D170C1`（118,940,263 bytes）；NSIS SHA-256 为 `2B5E59C1127F0D8E9AC50EF6F3472185A8E6BC7DDD36A2A6CD96F0FB6FC830EB`（119,170,261 bytes）。报告见被忽略的 [`package-4.0.3-portable-diagnostic.json`](../evidence-private/package/package-4.0.3-portable-diagnostic.json)。NSIS 构建完成，未运行安装验收。

portable 隔离验收覆盖未授权空态、随包 sidecar、隐藏窗口、临时 HTTP 授权、正常退出（`exitCode=0`、CDP 端口关闭）和同一隔离 userData 重启授权恢复。未验证真实抖音页面、发送、NSIS 安装运行或生产部署；未启动真实 profile。

### 4.0.2 本地候选包

4.0.2 修正任务运行面板的本轮读取、近期事件与今日判定/发送尝试口径；规则任务支持显式重新筛选本地跳过评论，结果进入人工确认队列，不自动发送。当前 UI fixture 已验证额度分列、空关键词草稿提示、筛选中防重复和读取数不等于命中数。portable SHA-256 为 `C8A233F8F755FC31DA198074F5AC0D387FF295D86C37255363CAF7394B64AFD2`（106,976,656 bytes）；NSIS installer SHA-256 为 `914CAF62BBD8AD09F97F0BE2D80BED98D8A3084A64314F6084087821DC16BC06`（119,169,820 bytes）。

### 4.0.1 本地候选包

4.0.1 修复后台授权刷新时新建/编辑任务表单被退回的问题：空表单失焦、重复刷新和自然 heartbeat 都保留草稿，保存成功后才返回列表，失败时保留输入。portable 与 NSIS installer 已在 Windows 构建，并通过隔离临时 `userData` 的登录、表单回归、正常退出和重启授权恢复验证。portable SHA-256 为 `E0432AE440693E802A28A6361B512A19C345F3BEEB3A3514C6F3C316371A63CA`；NSIS SHA-256 为 `EBA8A4AF1B715969DCAE0239DBAF73EBF1E5E365DE4690E997CB90CF6538C8E4`。启动器已更新为 4.0.1 portable 路径。

- Linux 授权端：Ubuntu Actions 上 `npm ci`、`npm run build`、`npm test`，并完成临时 SQLite 健康检查。
- Windows 桌面端：先构建并复制完整 sidecar onedir，再执行 `npm ci`、`npm run check`、`npm test`、portable 和 NSIS 构建；两个产物必须使用不同文件名并分别启动一次。
- 源码 Electron UI 实际检查：临时随机 `userData`，不使用开发机默认 AppData；覆盖积分流水、错误态、账号切换和离线状态，截图和日志不得包含密码、token、兑换码或 provider key。
- sidecar：发行包携带完整 PyInstaller onedir（包含 `_internal`）和校验信息，用户不应被要求另行安装 Python。构建前置检查发现 `desktop/build/probe` 缺 runtime 时必须失败。按 [`sidecar-protocol.md`](sidecar-protocol.md) 验收协议、权限、进程退出、超时取消、账号隔离和升级回滚；取消只回收主进程自己创建的 child，unknown 不自动重试。
- 真实抖音：按视频搜索、评论采集/筛选、评论回复、直播互动、私信触达分别记录页面版本、最终 URL、可见 DOM/API 候选、平台结果判据和未验证边界。视频/直播发送当前仅有 fixture 证据并保持自动发送关闭；私信自动资格依据已接受的 PR1 协作者账号流程证据。未取得对应证据前，保留开发和人工预检入口，不宣称生产可用。

## Windows 构建步骤

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

必须复制 `probe-agent` 整个 onedir；只复制 exe 会缺少 `_internal`。构建出的 portable 和 NSIS 都使用随包 runtime，用户无需安装 Python。

## 产物记录模板

```text
版本：4.0.0
提交：<git sha>
文件：<artifact filename>
SHA-256：<sha256>
构建平台：<runner>
验证：<portable/nsis 启动结果>
```

生成校验值：

```powershell
Get-FileHash .\release\<artifact> -Algorithm SHA256
```

预发行说明必须按能力开关逐项说明具体接入方式、证据状态和限制。采用官方 API 的能力还要说明官方 scope/资格；浏览器路径说明页面、账号和操作边界。没有对应证据的能力不能使用“已支持”或“生产可用”表述。
