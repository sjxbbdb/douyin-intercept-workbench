# v4 Agent 工程契约

本仓库从旧版工作台完全重建。`archive/v3/` 只保存历史参考，不是 v4 的运行时依赖。所有新代码必须围绕 `server/`、`desktop/` 和共享 HTTP 契约演进。

## 产品边界

- 产品只做抖音截流、线索判断和自动回复；Agent 是桌面端的主交互形态。
- Linux `server/` 是账号、授权、功能开关、积分、审计和策略的唯一权威。
- Windows `desktop/` 是可分发客户端：工作台账号由授权端提供，抖音账号由商家在专用窗口中手动登录。
- 当前桌面端使用商家手动登录的可见 DOM/CDP 接入；官方开放 API 不在当前实现范围，未来接入必须单独记录来源、资格和验证状态。

## 安全红线

1. 不绕过验证码、滑块、登录、风控或平台权限；不实现逆向 API、Cookie/localStorage 导出和抓包重放。
2. 授权端决定 feature、策略和积分价格。客户端不能伪造余额、价格、成功状态或上限。
3. 只有服务端确认的合法业务结果才能扣积分；网络错误、未知结果和 DOM 表象必须保留为不确定状态，不得自动重试造成重复触达。
4. token 与 provider key 不暴露给 renderer，也不写日志或审计；用户输入的密码/兑换码只在请求期间使用，不持久化；数据库只保存必要的 hash/加密值。
5. 每个动作必须有幂等键和审计记录。账号、设备、积分台账和会话必须隔离。
6. 自动发送默认关闭，直到适配器拥有真实账号、真实页面或官方权限的验证证据；未验证能力必须 fail-closed。

## 工程边界

- `server/` 在 Linux 上独立安装和运行；不得 require `desktop/`。
- `desktop/` 只通过公开 HTTP API 与服务端通信；renderer 只能走 preload 暴露的窄 IPC。
- `archive/v3/` 禁止被生产代码引用；其中的选择器、endpoint 和测试夹具不能直接当作当前平台事实。
- 新增平台能力必须同时提交：官方文档或真机证据、能力矩阵、失败状态、脱敏测试，以及未验证边界。
- 不将“构建成功”“模拟测试通过”汇报成“真实抖音可用”。真实抖音账号、官方资质、真实支付和生产部署分别单独验收。

## 验证

```bash
npm ci --prefix server
npm ci --prefix desktop
npm run check
npm test
```

Linux 服务端必须在真实 Linux 或 GitHub Actions Ubuntu 上执行 build/test；Windows 桌面端必须在 Windows 执行 check，并在需要发布时实际启动构建产物做空态/登录/API 契约验收。禁止 force push；提交只包含当前里程碑明确的文件。
