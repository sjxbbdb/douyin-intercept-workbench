# 参考仓库与平台能力审计

审计日期：2026-09-19
参考仓库：<https://github.com/sjxbbdb/douyin-intercept-workbench>

这份报告只用于重构决策。参考仓库已完整保留 Git 历史，后续重构可以从当前 `main` 继续演进；本报告不把旧仓库宣称为已经可分发或已通过抖音真机验收的产品。

## 1. 初始化与环境事实

- 克隆时当前目录为空，已用已登录的 GitHub CLI 执行 `gh repo clone sjxbbdb/douyin-intercept-workbench .`，未覆盖已有文件。
- 克隆时分支为 `main`，远程为 `origin`，HEAD 为 `4ba7a7d`（`P11 撤回过度设计：项目定稿为「一个专门做截流+自动回复的 Agent」`），与 `origin/main` 一致；本次重构随后切换到 `rewrite/v4-agent`。
- 远程仓库是私有仓库；审计不记录账号、令牌或任何凭据。远程默认分支为 `main`，仓库 URL 为 <https://github.com/sjxbbdb/douyin-intercept-workbench>。
- 本机环境：Node `v24.18.0`、npm `11.16.0`、Python `3.12.10`、Docker `29.6.1`。仓库声明 Node `>=22.5.0`，因为旧服务端依赖 `node:sqlite`。
- 根目录没有 `pnpm-lock.yaml`、`package-lock.json` 或现成 `node_modules`；旧仓库根 `package.json` 只声明 `ws`，服务端使用 Node 原生 HTTP/SQLite。
- 根目录和父目录没有发现更近的 `AGENTS.md`；旧仓库根 `AGENTS.md` 是旧项目局部规则，重构时已在新根契约中重新取舍。

## 2. 旧仓库的实际结构

旧项目不是只有文档，已经包含一个单仓库双端原型：

| 区域 | 事实 | 可迁移价值 |
|---|---|---|
| `client/core/cdp.js` | 裸 CDP WebSocket 客户端，含命令超时、重连、`Runtime.enable`/`Network.enable` 恢复、响应体环、结构化错误 | 高。可作为行为规格或迁移参考，但应在新客户端边界内重写/适配 |
| `client/core/browser-host.js` | Chrome 启动、实例锁、调试端口探活、Target attach、页面操作原语 | 高。浏览器独占与回环绑定是可靠性要点 |
| `client/platform/*` | 页面 profile、评论页、直播页、选择器、发布响应验证 | 中。代码可参考，抖音页面选择器与真实接口仍需重新真机确认 |
| `client/adapters/*` | 评论、弹幕、私信适配器，包含发送前落盘 `send_id`、内容相似度护栏、平台响应判定 | 中高。协议顺序和失败状态值得保留 |
| `client/license/*` | 客户端登录、心跳、签名、授权状态、额度上报 | 高。可作为授权端 API 契约和安全测试来源 |
| `license-server/*` | Node 原生 HTTP、`node:sqlite` 迁移、账户/积分/策略/审计/后台 CLI | 高。授权服务可以借设计，主模型决定是否迁移到 TypeScript/Fastify |
| `test/*` | 542 条单元测试，加契约、DOM、集成和后台测试；入口 L1–L4 全绿 | 高。测试意图、错误码和边界应迁移，测试代码本身不应当成为“平台可用”的证明 |
| `legacy/*` | 旧 worker 和页面行为考古档案 | 仅作只读行为规格，生产代码禁止引用 |

旧仓库的核心边界已经写得很清楚：授权中心与客户端只能通过 HTTP 协议通信；客户端单写者、原子落盘；`send_id` 在发送前生成；页面 DOM 现象不能直接算平台成功；不读取或导出 Cookie、密码和 token；不绕过验证码、滑块或风控。旧仓库的“只按平台确认成功发送计费”属于 v3 历史口径，v4 以新授权端契约为准，由服务端对生成回复动作计分。

## 3. 旧方向的问题和未完成项

### 3.1 产品与实现不一致

仓库最近几次提交反复在“工具”“多领域 Agent 平台”“专门做截流 Agent”之间改定位，留下了大量迁移文档和互相影响的约束。最新 `AGENTS.md` 已回到单领域 Agent，但代码仍是以工作台/调度器为主的原型。新的项目应先固定以下边界：Agent 负责领域内的理解与决策，浏览器执行器负责动作，授权端负责身份、积分和策略，三者之间使用稳定协议。

旧仓库还把 `@langchain/langgraph`、`zod` 写进 `AGENTS.md` 白名单，但根 `package.json` 实际只有 `ws`，Agent 编排尚未落地。不要把文档中的框架选型当成已交付事实。

### 3.2 三渠道状态被文档包装得比代码更完整

- `client/host/main.js` 当前将 `reply_danmaku` 和 `send_dm` 设置为 `null`，执行时返回 `NOT_IMPLEMENTED`。
- 评论发送链路有较完整的协议顺序与测试，但 `client/platform/selectors.js` 的 9 个选择器全部 `liveVerifiedAt: null`，只通过脱敏 fixture 离线回归。
- `shared/已知陷阱与平台知识.md` 明确记录：legacy 只真正验证过视频评论 `comment/publish`；私信 worker 只预填、不发请求；直播采集只读 DOM、不发送。因此私信、直播弹幕的 endpoint、成功响应字段和真实页面动作都不可从旧代码推断。
- 旧测试中的假 CDP、fixture 和集成模拟证明协议逻辑能工作，不能证明抖音当前页面、当前账号权限或开放接口可用。

### 3.3 授权端与客户端的生产化边界仍需重做

旧服务端的积分和审计实现有较好的事务/幂等测试，但它是单仓库原型：默认配置、密钥生命周期、Linux 部署、备份恢复、租户隔离、升级回滚和可观测性需要按新授权端重新审查。积分扣减应继续只基于服务端验证的成功发送事实，不能由桌面端自行扣分或自行改变上限。

### 3.4 Electron 窗口与平台接入必须分层

Electron 自带 Chromium 窗口，可以承载桌面 UI 和专用抖音窗口。用户需要在该窗口中手动登录；是否兼容当前抖音页面、是否能稳定完成可见 DOM 操作，仍必须由真机验证。平台接入仍应有明确的两类适配器：

1. 开放平台适配器：只调用已获批、已授权的官方 API；
2. 浏览器可见 DOM/CDP 适配器：只操作用户手动登录的专用窗口，不读取 Cookie、localStorage 或密码；
3. 两种适配器均必须经过同一个策略闸门、发送前 outbox 和服务端计费确认。

## 4. 已验证的可复用浏览器资产

可以复用的“事实”集中在工程机制，而不是平台可用性：

- `client/core/cdp.js` 已测试乱序响应、命令超时、连接断开时拒绝在途请求、重连后重新启用 Runtime/Network、响应体抓取和结构化归因。
- `client/core/browser-host.js` 已测试同一实例单进程/跨进程独占、端口被非 Chrome 占用时失败、Target attach 延迟、页面可见性判定和急停边界。
- 评论适配器已测试“捕获响应先于提交”“`send_id` 先落盘”“DOM 稳定只能产生 `sent_confirmed_dom`，不能计费”“空响应按风控拒绝”“提交后异常保留 unknown，不重发”。
- `test/fixtures/` 与 `test/dom/` 提供了脱敏页面快照和可见/隐藏 DOM 选择逻辑的离线回归基础。

不能当作已验证资产的部分：

- 当前抖音页面选择器的真实有效性；
- 私信和直播弹幕的真实发送路径、成功码和限频表现；
- 通过 CDP 驱动当前抖音版本的稳定性；
- 任意账号的开放平台权限、企业号/品牌号/员工号/合作号资质；
- “自动回复不会触发限制”或“账号安全”的任何保证。

## 5. 官方平台能力核查（2026-09-19）

以下只采用抖音开放平台一手文档。官方能力和申请资格会变化，开发阶段必须再次核对控制台实际可申请权限。

### 5.1 视频评论

官方小程序/经营授权文档提供视频评论列表、评论回复列表和“回复视频评论”能力，scope 为 `ma.item.comment`。回复接口的明确限制是：只能回复授权用户自己发布的视频；图集目前不支持评论；接口需要申请“视频评论数据”能力并使用授权产生的 token。见：

- [视频评论数据能力概述](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/basic-capacities/douyin)
- [评论列表](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/video-review-data/comment-list)
- [回复视频评论](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/video-review-data/video-comment-reply)
- [获取视频评论数据（经营授权）](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-recent-video-data/get-comment-bc)

因此，官方 API 路线可以作为受资质和授权约束的适配器，不能假设普通抖音账号都能使用，也不能把“开放平台能回复自己视频”扩展成“可任意截取全站评论”。

### 5.2 私信

官方文档确实公开了 IM Webhook 和发送私信 OpenAPI，但前置条件较重：小程序经营者需要在控制台申请发送私信能力；事件和发送接口使用 `im.direct_message`；主动私信还涉及经营者绑定、用户授权、消息库存和频控。官方线索业务规范还要求第三方应用正式上线、经营者账号完成认证与授权，并要求服务商明确展示由哪个账号向哪些用户发送什么内容，且支持客户随时取消自动发送/回复。见：

- [接入 IM 消息收发能力](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/tutorial/open-capabilities/management/im-messaging-access)
- [线索业务 ISV 管理及 IM 接口开放规范](https://partner.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/isv-im-standards)
- [主动私信](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/operation/private-account/private-message)
- [移动/网站应用能力申请及使用规范](https://partner.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/usage-spec)

这支持“官方 IM 适配器”方向，但不支持把桌面浏览器的普通会话自动推断为官方 IM 资格。新项目需把“已获批官方 IM”与“浏览器可见 DOM 试验适配器”分开，分别展示资格、覆盖范围和未验证状态。

### 5.3 直播评论/弹幕

官方开放能力提供的是“挂载直播玩法后获取包含特殊指令的直播间评论”或直播互动数据推送，并要求在控制台申请能力、启动任务和接收服务端推送。直播互动工具文档还指出互动工具需入驻/评审，部分插件业务可能暂不准入；平台规范要求合理、必要、善意使用能力。见：

- [直播间评论互动能力](https://partner.open-douyin.com/docs/resource/zh-CN/interaction/jierushuoming/hudongshuju/pinglunshuju)
- [直播玩法开放能力概述](https://partner.open-douyin.com/docs/resource/zh-CN/interaction/introduction/introduction/capabilitieslist)
- [接入指南](https://partner.open-douyin.com/docs/resource/zh-CN/interaction/develop/douyincloud/guide)
- [互动工具接入指南](https://partner.open-douyin.com/docs/resource/zh-CN/live-interactive-tools/introduction/interactive-tools-guide)
- [平台开放能力规范](https://partner.open-douyin.com/docs/resource/zh-CN/interaction/operation/rules/abilities)

这些文档证明“受审核的直播玩法/互动工具”有官方数据通道，不证明一个 Windows 桌面工具可以读取或自动发送任意直播间弹幕。旧仓库的 `live/comment/send` 只是内部契约候选值，必须经过真实请求与响应证据后才能进入生产适配器。

### 5.4 账号、权限与平台限制

官方角色概述区分普通开发者、系统服务商和企业号认证开发者，具体能力需要在控制台申请；开放平台能力申请规范还明确了数据合规、第三方服务商的数据隔离、自动私信展示与取消要求。见 [角色概述](https://partner.open-douyin.com/docs/resource/zh-CN/developer/introduction/type-and-permission)、[能力申请及使用规范](https://partner.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/usage-spec)。

## 6. 对新重构的具体建议

1. 保留旧 Git 历史，把旧代码标成参考实现；生产代码只按当前 `server/` 与 `desktop/` 两个子项目演进，避免客户端直接依赖授权服务实现。
2. 先定义“能力矩阵”：每个渠道、账号资质、适配器类型、读/写能力、官方授权条件、真机验证状态、计费资格必须分别记录。默认状态应是 fail-closed，而不是“接口猜对就发送”。
3. 复用旧项目的协议测试意图：令牌轮换、重放保护、积分原子扣减、发送幂等、平台响应判定、隐私哈希和审计。新实现若采用 TypeScript/Fastify/SQLite，应保留同等行为，不要机械搬运旧 Node 原生模块。
4. Linux 授权端可以采用 TypeScript + Fastify + SQLite，但要明确运行时、迁移、备份、密钥管理和单实例策略；若决定服务端零依赖，则不要在迁移中半引入 Fastify。两种方案都可行，关键是 API 契约和验证证据一致。
5. Windows 分发端使用 Electron 时，应先证明安装包、自动更新、崩溃恢复、专用窗口接入和凭据隔离；用户在专用窗口中手动登录。当前页面兼容性和真实操作仍标记为未验证。
6. 第一阶段建议只交付授权登录、策略/积分、官方能力探测、采集与人工确认/预览；评论自动回复和私信/弹幕自动发送分别设真机验证门。没有真实账号和官方测试资格时，不能对外宣称三渠道可用。
7. 不实现逆向 API、Cookie/localStorage 导出、验证码/风控绕过、抓包重放或伪装成官方开放能力的路径。官方 API 返回错误、权限不足、频控和能力封禁都应变成明确的产品状态。

## 7. 本次验证记录

在克隆后的工作树运行 `npm test`，旧仓库入口结果为：L1 单元、L2 契约、L3 离线 DOM、L4 集成全部 PASS；最终一组集成输出为 60/60。入口明确写出 L5 真机验证和 L6 长稳不在测试范围内。

因此本报告的结论边界是：旧项目的授权、计费、CDP 协议和安全护栏有可复用实现依据；抖音三渠道的当前线上可用性、开放平台资质和真实发送成功率仍未被本地测试证明，必须由后续专门的真机/官方账号验证完成。
