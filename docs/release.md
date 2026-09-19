# 发布草稿

当前没有正式 GitHub Release 或预发行版。已有本地 Windows 候选包在隔离的临时 `userData` 中通过启动、空态、授权、正常退出/重启授权保留和随包 sidecar IPC 检查；最终 CI 结果与哈希见 [`verification.md`](verification.md)。积分流水和错误态属于源码 Electron UI 验收，不能从包启动检查推导。能力优先开发不等于能力全部随包发布。

## 预发行清单

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
