# 发布草稿

当前没有正式发行版或预发行版。能力优先开发不等于能力全部随包发布；只有 Windows 产物能够在隔离的临时 `userData` 中启动并完成空态、登录、积分流水、错误态和退出重启检查，且每个发行开关都有对应证据，才允许创建预发行附件。

## 预发行清单

- Linux 授权端：Ubuntu Actions 上 `npm ci`、`npm run build`、`npm test`，并完成临时 SQLite 健康检查。
- Windows 桌面端：`npm ci`、`npm run check`、`npm test`、portable 和 NSIS 构建；两个产物必须使用不同文件名并分别启动一次。
- Electron 实际检查：临时随机 `userData`，不使用开发机默认 AppData；截图和日志不得包含密码、token、兑换码或 provider key。
- sidecar：发行包携带 PyInstaller onedir sidecar 和校验信息，用户不应被要求另行安装 Python。按 [`sidecar-protocol.md`](sidecar-protocol.md) 验收协议、权限、进程退出、超时取消、账号隔离和升级回滚。
- 真实抖音：按视频搜索、评论采集/筛选、评论回复、直播互动、私信触达分别记录页面版本、最终 URL、可见 DOM/API 候选、平台结果判据和未验证边界。未取得对应证据前，只发布探测/只读能力。

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
