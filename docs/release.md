# 发布草稿

当前没有正式发行版或预发行版。只有 Windows 产物能够在隔离的临时 `userData` 中启动并完成空态、登录、积分流水、错误态和退出重启检查，才允许创建预发行附件。

## 预发行清单

- Linux 授权端：Ubuntu Actions 上 `npm ci`、`npm run build`、`npm test`，并完成临时 SQLite 健康检查。
- Windows 桌面端：`npm ci`、`npm run check`、`npm test`、portable 和 NSIS 构建；两个产物必须使用不同文件名并分别启动一次。
- Electron 实际检查：临时随机 `userData`，不使用开发机默认 AppData；截图和日志不得包含密码、token、兑换码或 provider key。
- 真实抖音：只记录页面版本、最终 URL、可见 DOM 候选和未验证边界。未取得官方资格或测试账号前，不把页面检查写成自动发送可用。

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

预发行说明必须明确：真实抖音评论/直播接入、官方开放平台资格、真实自动发送、真实支付和生产部署尚未完成时，不能使用“已支持”或“生产可用”表述。
