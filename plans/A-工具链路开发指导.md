# 方案 A：完整工具链路 · 开发指导（主文档）

> **读者**：接手本项目的开发者 / AI 编码智能体。
> **用途**：读完本文 + `plans/A-分阶段任务清单.md` 即可开工，无需再问设计问题。
> **事实源（冲突时以它们为准，本文只做转述与落地）**：
> `shared/protocol.md`（接口契约，`protocol_version = 2`）＞ `docs/需求规格.md`（唯一验收依据）＞ `shared/术语与选型基准.md`（技术事实源）＞ `docs/架构说明.md` ＞ `docs/部署指南-服务端.md`
> **本文不含 LLM**。方案 B（LLM 语义理解）在 A 的底座稳定后再叠加，A 必须先跑通。

---

## 1. 方案 A 是什么

### 1.1 一句话定位

> **把「裸 CDP 驱动商家本机已登录 Chrome」这套半成品脚本，重构为一个可交付、可计费、可举证的双端商用产品；不接大模型，用固定流水线 + 关键词规则匹配完成意图判断与话术生成。**

### 1.2 与现状的差别

| 维度 | 现状（别人的半成品脚本集） | 方案 A 目标 |
|---|---|---|
| 形态 | 8 个各自为政的脚本 + 一个零鉴权控制台 | host + N×browser-host 的单一进程树，全 IPC |
| 路径 | 硬编码 `D:\deep seek\`（D-1），换机器必然读不到请求文件 | 统一 `REPLY_WORKSPACE` / `path.join` 解析 |
| 存储 | 多进程无锁全量覆写同一 JSON（D-7），队列丢任务 | **单写者 + 原子写 + `schemaVersion`**，唯一写盘者是 `client/host/store.js` |
| 发送 | 入队即自动发（无频控、无日上限、无熔断） | `safety/` 独立护栏：频控 + 日上限 + 相似度 + 熔断 + 急停 + 活跃时段 |
| 成功判定 | "编辑器消失即已发送"（D-12），把页面崩溃记成功 | 只认平台响应体 `status_code = 0`；空响应 = 风控拒绝 |
| 计费 | 无 | 按 `sent_confirmed` 条数计费，逐条 `send_id` 幂等 |
| 授权 | 无 | 授权中心下发账号、积分、**安全策略**、套餐 |
| 审计 | 无 | 双写审计，记录**真实生效的策略值**，只传哈希与计数 |
| 分发 | 依赖原作者机器 | Windows 便携包（内置 `node_modules/ws`）+ Linux 授权中心 |
| 抖音知识 | 散落在 6 份 CDP 副本里 | `legacy/` 只读存档 + `platform/selectors.js` 唯一选择器来源 |

### 1.3 适用场景

- 商家自己有抖音账号、愿意用**专用 Chrome**（独立 `--user-data-dir`）承载登录态。
- 商家接受**节流**：安全上限由服务端下发，客户端只能更保守（红线 1）。
- 回复可以模板化：用「关键词 → 话术模板库」覆盖"多少钱 / 有什么功能"这类高频问法。
- 需要**按效果付费**：只有平台确认成功的回复才扣积分。

### 1.4 不适用场景（写进售前话术，别接这类单）

- 需要理解长尾语义（"这东西值不值"）→ 那是方案 B，A 只能靠关键词表堆。
- 想要"无限量发"→ **产品定位就是不给**（`POLICY_VIOLATION`）。
- 需要自动回复**图文帖（note post）**评论 → 面板结构特殊，本期标记 `note_post_panel_unsupported` 跳过。
- 需要无人值守绕过验证码/滑块 → 明确禁止，遇风控即熔断（`AGENTS.md` 红线）。
- 商家机器无法安装 Node ≥ 22.5 且不接受随包分发 → 需先解决分发形态（R-7）。

---

## 2. 系统全景

### 2.1 架构图

```
┌────────────────────────────────────────────┐        ┌──────────────────────────────────────────┐
│ 授权中心 license-server（厂商 Linux VPS）    │        │ 客户端 client（商家 Windows 机器）          │
│                                            │        │                                          │
│ api/      路由：login / heartbeat / audit   │ HTTPS  │ ┌ host 主进程 ─────────────────────────┐ │
│ domain/   auth · billing · policy · stats   │◄──────►│ │ api.js  HTTP:127.0.0.1（会话令牌）    │ │
│           redeem                           │  JSON  │ │ store.js ★唯一写盘者（原子写）        │ │
│ store/    node:sqlite（WAL，唯一写入者）     │  HMAC  │ │ scheduler.js 调度/频控/熔断/急停      │ │
│ crypto/   scrypt · HMAC 签名                │  签名  │ │ instances.js 多实例注册与端口分配      │ │
│ admin/    开号 · 充值 · 卡密 · 看板          │        │ └──────────────────────────────────────┘ │
│                                            │        │        │ 进程内事件总线 / IPC（core/ipc.js）│
│ ★ tier_table 唯一来源（protocol §4.6）       │        │ ┌──────┴───────┬──────────────┬───────┐ │
│ ★ 计费只认 audit_sends 明细                  │        │ │ browser-host │ adapters     │ safety│ │
│ ★ policy_ack_log 记录真实生效策略             │        │ │ ★独占 1 条 WS │ collect      │ guard │ │
└────────────────────────────────────────────┘        │ │  每实例一条   │ reply-comment│ sim   │ │
                                                       │ └──────┬───────┴──────────────┴───────┘ │
                                                       │        │ platform/ 选择器注册表（唯一）  │
                                                       │        │ core/cdp.js（全项目唯一一份）   │
                                                       └────────┼─────────────────────────────────┘
                                                                │ CDP WebSocket  127.0.0.1:9222+N
                                                                ▼
                                                    ┌────────────────────────────────┐
                                                    │ 专用 Chrome（每实例一个实例）    │
                                                    │ --user-data-dir=instances/<id> │
                                                    │   /chrome-profile              │
                                                    │ --remote-debugging-port=9222+N │
                                                    │ ★商家已扫码登录的抖音账号在这里  │
                                                    └────────────────────────────────┘
```

**三者关系**：客户端**不**持有抖音密码、**不**碰 Cookie；它只是通过 CDP 操作商家已经登录好的那个 Chrome 窗口。授权中心**不**参与任何抖音侧动作，只负责"发号、发额度、发安全上限、收明细、出账"。

### 2.2 一次完整任务的端到端路径

以「商家配置关键词 → 评论回复发出并计费」为例，每步标注模块与失败归因点：

| # | 步骤 | 模块 | 失败归因点 |
|---|---|---|---|
| 0 | 商家在 UI 保存规则「多少钱 → 话术A/B/C」 | `client/ui` → `host/api.js` → `store.js` | 字段校验失败 `AUDIT_CONFIG_INVALID` |
| 1 | 配置落地前过安全校验：只允许**更保守** | `client/safety/guard.js` | 越权 → 本地拦截 + 审计 `applied:false` + `reject_code:POLICY_VIOLATION` |
| 2 | 策略与配额就绪（当前等级、日上限、活跃时段） | `client/license/heartbeat.js` → `host/store.js` | 未 ack → `POLICY_ACK_REQUIRED`；观察期 → `sending_enabled=false` |
| 3 | 采集：打开视频页、展开评论区、滚动抓取 | `adapters/collect.js` → `platform/page-comment.js` | `selector_miss:<key>` / `element_timeout` / 评论区不可见 |
| 4 | 命中判定：整词包含关键词 + 黑白名单 + 去重 | `adapters/collect.js`（规则引擎） | 未命中 → 计 `skipped`，**不回复**（无万能回复） |
| 5 | 线索落库（首次写入才计 `leads_new`） | `host/store.js`（`leads.json`） | 重复 → 只计 `hits` |
| 6 | 入队 → 调度取任务 → 前置检查 | `host/scheduler.js` + `safety/guard.js` | `quota_exceeded` / `emergency_stop` / `credit_exhausted` / `outside_active_hours` |
| 7 | 话术渲染：模板变量填充 + 多条随机 + 短期黑名单 | `adapters/reply-comment.js` | 模板池 < 5 条 → 配置期即拒绝 |
| 8 | 相似度闸门：与近期已发内容比对 | `safety/similarity.js` | 相似度 **> 0.85 即拒绝**，`failure_reason=content_rejected` |
| 9 | **发送前**生成 `send_id` 并落盘 `pending_sends.json` | `host/store.js` | 落盘失败 → **不得发送**（宁可漏发不可丢证） |
| 10 | 发送链路：定位 → 激活编辑器 → 输入 → Enter | `platform/page-comment.js` | 见 4.7，逐步骤有独立归因码 |
| 11 | 成功判定：嗅探 `comment/publish` 响应体 | `platform/publish-verifier.js` | 空响应 → `failed` + `risk_control_signal="empty_response"` |
| 12 | 判定回写本地明细（`verdict` + `evidence`） | `host/store.js` | — |
| 13 | 批量上报（5 分钟或满 50 条） | `client/license/reporter.js` | 离线 → 囤本地，恢复后按 `sent_at_ms` 升序补报 |
| 14 | 服务端逐条结算：幂等 → 策略存证 → 当日额度 → 计费资格 | `license-server/domain/billing.js` | `duplicate` / `not_billable` / `policy_exceeded` / `unbilled_insufficient_credit` |
| 15 | 扣费写台账（与余额同事务）→ 回 `daily_quota` + `commands` | `license-server/domain/billing.js` | 余额 ≤ 0 → `state="exhausted"` + `pause_engine` |
| 16 | 客户端 ≤60 秒执行命令 → 看板刷新 | `host/scheduler.js` + `ui/` | 命令未执行 → 告警 |

**关键点**：第 9 步在第 10 步**之前**；第 11 步是唯一能产生 `sent_confirmed` 的地方；第 14 步是唯一能产生扣费的地方。三者不能互换顺序。

### 2.3 进程模型

| 进程 | 数量 | 职责 | 明确不做 |
|---|---|---|---|
| `host/main.js` | 1 | HTTP API（绑 `127.0.0.1`）、静态 UI、调度器、**唯一写盘者**、实例注册表、授权客户端（心跳/上报/停机） | 不直接发 CDP 命令 |
| `browser-host` | 每实例 1 | **独占**该实例的一条 CDP WebSocket；标签页创建/存活检查/重建/重连；把高层请求翻译为 CDP 命令 | **不懂抖音**（不出现任何 `data-e2e`） |
| `task-runner`（逻辑上属 host，可同进程） | 每实例 1 条串行队列 | 任务状态机、重试与退避、取消句柄（消灭 D-10"无法停止"） | 不持有 WS |
| 专用 Chrome | 每实例 1 | 承载商家抖音登录态 | 不安装扩展、不改 UA |

**IPC 关系**：全部经 `core/ipc.js`，只有两种消息——`request(op, params)` 与 `event(name, payload)`。适配器/平台层**不得** `fs` 写入；需要落盘一律走 `host`。

---

## 3. 分层设计与职责边界

目录以 `shared/术语与选型基准.md` §四 为准（下同）。

### 3.1 `shared/lib/` — 双端共享（唯一允许双端共享的代码）

| 文件 | 职责 | 允许依赖 | 禁止 |
|---|---|---|---|
| `protocol.js` | 接口路径常量、字段名、枚举闭集（`source_type`/`verdict`/`confirm_signal`/`platform_endpoint`/`failure_reasons`）、`protocol_version=2`、`tier_table` 的**结构校验器** | 仅 Node 内置 | **禁止写入 0/10/25/30/70/12600 等具体限额数值**（唯一来源是服务端下发的 `tier_table`） |
| `stable-stringify.js` | 签名用确定性序列化：递归按 key 升序、无空格、`undefined` 跳过 | 无 | 不得改用 `JSON.stringify` 参与签名 |
| `errors.js` | 错误码与归因码常量（`POLICY_VIOLATION`/`AUDIT_SEND_CONFLICT`/`selector_miss`…） | 无 | 不得定义协议外的错误码 |

### 3.2 `license-server/` — 授权中心（厂商侧，Linux）

| 目录 | 职责 | 关键约束 |
|---|---|---|
| `api/` | 路由与信封（`{ok:true,...}` / `{ok:false,code,message,detail,server_time_ms}`）、鉴权中间件、签名中间件、限流 | 客户端判断成功**只看 `ok`**，不看 HTTP 状态码；错误响应**也必须签名** |
| `domain/auth.js` | 登录、会话、设备数、密码哈希（`scrypt(N=16384,r=8,p=1,keylen=32,salt=16B)` → `scrypt$N$r$p$salt_hex$hash_hex`，`timingSafeEqual` 比较） | 禁止明文/可逆加密；不提供注册接口 |
| `domain/policy.js` | **`tier_table` 唯一来源**、等级按 `account_day_index` 推导、`quota_notice` 实时生成 | 改一张表 → `stable_daily_max_total`/`plan.credits`/`min_plan_credit`/文案/看板同步重算 |
| `domain/billing.js` | 逐条结算、`credit_ledger` 追加写、`BEGIN IMMEDIATE` 事务 | 余额与台账必须**同事务**；批内严格按 `sent_at_ms` 升序 |
| `domain/stats.js` | 看板聚合（`stats_daily`） | 口径与客户端 `stats` 完全一致（见 4.9） |
| `domain/redeem.js` | 充值码兑换（`BEGIN IMMEDIATE` + `code_hash` 唯一索引） | 并发兑换同一码只能成功一个 |
| `store/` | `db.js`（连接 + PRAGMA：`journal_mode=WAL` / `synchronous=NORMAL` / `busy_timeout=8000` / `foreign_keys=ON`）、`migrations/`、`repo/` | **DDL 只做加法**；库版本 > 代码期望 → 拒绝启动 |
| `crypto/` | scrypt、HMAC 响应签名、`master_secret` 派生 `sign_key` | 只存 `key_epoch` 与 `sign_key_sha256`，不存 `sign_key` 明文 |
| `admin/` | 管理后台（商家列表、下钻、充值、卡密、审计导出） | 必须复用同一套计费与策略口径 |

### 3.3~3.9 客户端各层（`client/host|core|platform|adapters|license|safety|ui`）

| 层 | 文件与职责 | 一边界 |
|---|---|---|
| `host/` | `api.js`（本地 API，**绑 `127.0.0.1` + 会话令牌 + CORS 白名单**，修 D-6）、`scheduler.js`（调度、持有全部子句柄、幂等拒绝重复启动，修 D-13）、`store.js`（实例 JSON 读写的**唯一入口**：内存态 + 串行化写队列 + `.tmp-<pid>` → rename）、`instances.js`（实例注册与 `9222+N` 端口分配） | 唯一允许碰盘的层 |
| `core/` | `cdp.js`（**全项目唯一一份** CDP 客户端）、`browser-host.js`（独占 WS、标签页管理、重连、超时退避）、`ipc.js` | **不得出现任何抖音知识** |
| `platform/` | `selectors.js`（**选择器唯一来源**，每条带 `key`/`css`/`lastVerifiedAt`/`confidence`/`fallbacks[]`）、`page-comment.js`、`page-live.js`、`page-profile.js`、`publish-verifier.js` | 不得直接读写文件 |
| `adapters/` | `collect.js`（采集 + 关键词命中 + 去重键计算）、`reply-comment.js`、`reply-danmaku.js`、`send-dm.js`（含 `sec_uid` 提取失败 → `not_locatable` 跳过）。**薄编排层**：只把平台原语串成业务动作 | 不写选择器、不写频控 |
| `license/` | `auth.js`（登录、`login_proof` 验签、设备 ID、令牌续期）、`heartbeat.js`（60 秒心跳、策略接收与 ack、命令执行）、`reporter.js`（明细与聚合上报、离线补报）、`sign.js`（HMAC 请求签名与**响应验签**） | 不得绕过 `shared/lib/` 自造协议常量 |
| `safety/` | `guard.js`（日上限、最小间隔、活跃时段、观察期禁发、急停）、`similarity.js`（SimHash）、`circuit.js`（熔断状态机）、`audit.js`（本地审计落盘） | 独立模块，**不得散落在适配器里** |
| `ui/` | 原生 DOM、无框架、无构建；统一设计 token（CSS 变量）、暗色系、快捷键（`Esc` 急停、`Ctrl+K` 命令面板、`1-9` 切面板）；近 7 日趋势用纯 CSS/Canvas（不引图表库） | 不得直连 CDP 或直接改数据文件 |


### 3.10 ⚠️ 跨层禁止事项（违反即视为缺陷，PR 应直接打回）

1. `license-server/` 与 `client/` **不得互相 `require`**（含相对路径跨目录）。只能走 `shared/protocol.md` 定义的 HTTP 接口。
2. `legacy/` **不得被任何生产代码 `require`**；它只是只读行为规格。
3. **选择器只能定义在 `client/platform/selectors.js`**。其他任何文件出现 `data-e2e` 字符串即为缺陷（这是 S-4"改版只需改 1 个文件"的硬前提）。
4. `client/core/` **不得出现抖音知识**（无 `comment-list`、无 `data-e2e`、无 `comment/publish`）。core 只懂 CDP 协议与标签页；平台语义一律在 `platform/` 与 `adapters/`。
5. `platform/` 与 `adapters/` **不得直接读写文件**；需要落盘一律经 IPC 请求 `host`。
6. 除 `host/store.js` 外，**任何模块不得 `fs.writeFileSync` 业务数据**（消灭 D-7 类竞态）。
7. 任何地方**不得硬编码限额数值**（0/10/25/30/70/12600 等）；数值只能来自服务端下发的 `policy` / `tier_table`。
8. `shared/lib/` 之外**不得新增跨端共享代码**；`shared/lib/` 不得 `require` 服务端或客户端目录。
9. **全项目统一 `snake_case`**（含局部变量与函数名），模块文件名 `kebab-case.js`，类名 `PascalCase`，常量 `UPPER_SNAKE_CASE`。⚠️ 旧代码用 `camelCase`（`awemeId`/`commentId`），**在 `legacy/` 之外出现这类写法视为缺陷**。详见 `shared/开发规范.md` §1.1。
10. **禁止空 `catch {}`**（本项目最贵的一次教训：旧代码去重历史写盘失败被静默吞掉，导致同一评论被重复回复且无人发现）。禁止用 `process.exit(1)` 作为顶层异常处理（进程退出后无人重启，直接违反 S-1）。详见 `shared/开发规范.md` §2.2、§2.6。

---

## 4. 关键机制设计

### 4.1 授权与登录（`protocol.md` §2、§4.1~4.4、§5）

**设计意图**：把"这个商家有没有资格用、还能发多少、上限是多少"全部收敛到服务端；客户端本地文件被随意篡改都不影响真实授权（验收标准 8）。

**实现要点**

1. 首启生成 `device_id`（16 字节 hex）与 `install_id`（uuid v4）并持久化；重装视为新设备。
2. 启动先 `GET /client/bootstrap`（**不签名**）→ 校验 `force_upgrade` / `client_version < min_client_version` / `maintenance.active`；不通过则停机展示升级页。
3. `POST /auth/login`（**不签名**）→ 校验 `login_proof`（见下）→ 原子落盘凭据 → 立刻 `POST /auth/refresh` 静默续期。
4. 令牌：32 字节随机 hex，服务端只存 `sha256(token)`，TTL 7 天；剩余 < 24 小时续期；已过期但未超 30 天仍可 refresh；续期签发新 token，旧 token `token_overlap_ms=300000` 内在途可用。
5. 设备数：默认 `device_limit=1`；登录时踢掉**最早创建**的会话，响应带 `kicked_device_id`；被踢方立即停止发送、清 token，**不得自动踢回**（避免活锁）。
6. 密码错误：按账号累计 `login_fail_limit=5` 次 → 锁 `login_lock_ms=600000`，返回 `AUTH_ACCOUNT_LOCKED(423)` + `retry_after_ms`；成功清零。登录固定加 200–500ms 随机延迟。
7. 除登录与 bootstrap 外，**所有请求签名、所有响应验签**（含错误响应）。

**`login_proof` 验签（防登录响应被篡改）**

```js
// client/license/auth.js
const { pbkdf2Sync } = require('node:crypto')
const { hmacHex, sha256Hex } = require('./sign')
const { stableStringify } = require('../../shared/lib/stable-stringify')

function verifyLoginProof(account, deviceId, password, loginResponse) {
  const loginKey = pbkdf2Sync(password, 'dsh-login|' + account + '|' + deviceId, 100000, 32, 'sha256')
  const body = { ...loginResponse }
  delete body.login_proof                       // 覆盖范围排除自身
  const expect = hmacHex(loginKey, sha256Hex(stableStringify(body)))
  if (expect !== loginResponse.login_proof) throw new Error('登录响应被篡改')
}
```

**⚠️ 易错点**

- 验签失败必须**不落盘任何凭据**，并提示网络不安全（`fail-closed`）。
- `stableStringify` 必须是"递归按 key 升序、无空格"；用 `JSON.stringify` 会因 key 顺序不同而必然失败。
- 登录响应里的 `policy` 是**权威安全策略**，必须原样采纳或更保守，并在首次心跳里 ack。
- `sign_key` 持久化到受保护目录，**不得写入日志**（`NFR-6`）。
- 服务器时间：用每个响应的 `server_time_ms` 维护 `clock_skew_ms`；客户端上报的 `sent_at_ms` 必须校准到服务端时间轴；时长类字段一律用 `process.hrtime.bigint()`。

### 4.2 安全策略的下发与执行（红线 1 的落地）

**设计意图**：产品价值来自"让号活得久"，所以上限的**权威在服务端**，客户端只有"更保守"的自由度。

**实现要点**

1. 心跳（60 秒）响应携带完整 `policy`；`policy_changed=true` → 客户端 **60 秒内**整体替换（不做字段合并，避免新旧混合），并在**下一次心跳**回带新的 `applied_policy_version` / `applied_policy_hash` / `applied_limits` 完成 ack。
2. `tier_table` 唯一来源：`GET /policy/current` 返回全表；`domain/policy.js` 用它推导一切。**客户端不得自行推算等级**，等级只以服务端下发的 `account_tier` 为准。
3. **"只能更保守"的四个判定方向**（任一方向反了即 `POLICY_VIOLATION(409)`）：

| 字段 | 方向 | 额外约束 |
|---|---|---|
| `daily_max` | 只能**调低** | — |
| `min_interval_ms` | 只能**调高**（间隔更长） | 且必须落在 `min_interval_ms_range` 内：comment `[60000,180000]`、`live_danmaku` `[30000,90000]`、`dm` `[300000,900000]` |
| `content_similarity_max` | 只能**调低** | ⚠️ 语义是"相似度**超过**该值即拒绝"，调低 = 更严 |
| `active_hours` | 只能**调短** | 不得新增窗口；默认单一窗口 `08:00–23:00`，`tz_offset_minutes=480` |

4. 本地生效值取**交集的最保守侧**：`daily_max = min(policy, userSetting)`、`min_interval_ms = max(policy, userSetting)`、`content_similarity_max = min(policy, userSetting)`、`active_hours = 用户窗口 ∩ 策略窗口`。写进 `policy.json` 时同时记录 `policy_version` 与 `applied_limits`。
5. 等级推进按 `account_day_index`（服务端按 UTC+8 自然日计算并下发，客户端只展示）：

| 等级 | 天数 | 评论/天 | 弹幕/天 | 私信/天 | 日上限合计 | `sending_enabled` |
|---|---|---|---|---|---|---|
| `observation` | 1–3 | 0 | 0 | 0 | 0 | `false`，`collect_only=true` |
| `warm_up` | 4–7 | 10 | 10 | 3 | 23 | `true` |
| `ramp_up` | 8–14 | 25 | 25 | 8 | 58 | `true` |
| `stable` | 15+ | 30 | 30 | 10 | **70** | `true` |

6. **观察期禁发的实现**：`sending_enabled=false`（或 `collect_only=true`）→ `safety/guard.js` 在任何发送路径的入口直接返回 `{ok:false, reason:'POLICY_SENDING_DISABLED'}`；**不生成 `send_id`**；采集、心跳、历史明细补报照常。UI 原样展示观察期 `quota_notice`。**不得提供任何跳过入口**（不写开关、不写环境变量、不写"调试模式"）。
7. 离线降级：断网后 `offline_send_grace_ms=900000`（15 分钟）内不降级；超过则进 `degraded` 态，允许继续发送但用**影子额度**自限：
   - 初始化：`local_budget = floor(last_known_balance_milli / credit_per_reply_milli) × offline_budget_ratio(0.5)`；
   - **只减不增**，绝不凭空增加；每条尝试都扣（无论成功与否都消耗一次机会）；
   - 影子额度耗尽 → 立即暂停（本地 fail-closed）；
   - 离线仍**严格遵守当日策略上限**（离线不等于放宽）；
   - 断网超过 `grace_ms=86400000`（24 小时）→ 进暂停态，只保留本地采集与心跳重试；
   - 恢复联网并成功收到心跳响应后，才允许用响应 `balance_milli` 重算影子额度。

**⚠️ 易错点**

- `POLICY_VIOLATION` 是**整批拒绝**（心跳 ack 或明细上报），`detail` 会给出 `source_type`/`field`/`reported`/`allowed`/`policy_version`；收到后必须立即降到服务端值或更低并重新 ack，**不得继续按激进配置发送**。
- `POLICY_ACK_REQUIRED(409)` 表示没带 `applied_policy_version` 就报了明细 → 先发一次心跳完成 ack，再重报。
- `POLICY_VERSION_UNKNOWN(409)` → 先 `GET /policy/current` 对齐再重报；该批不落账不计费。
- `POLICY_SENDING_DISABLED(409)` → 立即停止一切发送，只保留采集。
- 观察期"不可跳过"是**验收标准 13** 的判定对象：任何界面操作、任何配置文件改写都不能让三来源上限变成非 0。

### 4.3 计费（红线 2 的落地）

**设计意图**：厂商与商家利益一致——号被封 → 发不出去 → 收不到钱。所以只有"平台确认成功"才配收钱。

**实现要点**

1. `send_id`（uuid v4 或 32 hex）必须在**发送动作发起前**生成并写入本地 `pending_sends.json`，**先落盘再发送**。这样进程崩溃后重发用的是同一个 ID。
2. 明细上报：每 `send_batch_interval_ms=300000`（5 分钟）或攒满 `send_batch_max=50` 条，或停机前/进入暂停态前/离线恢复后**立即**上报。
3. 每条明细必带 `policy_snapshot`（`policy_version` + `policy_hash` + `applied_limits` + `captured_at_ms`）。
4. 服务端逐条结算（严格按 `sent_at_ms` 升序）：

```js
// 计费资格：五个条件必须同时成立
const billable = s.verdict === 'sent_confirmed'
  && s.evidence.confirm_signal === 'platform_response'   // DOM 判断不算
  && s.evidence.platform_status_code === 0               // 空响应不得标成功
  && !overLimit                                          // 未超当日策略上限（观察期 max=0）
  && !alreadyBilled                                      // 该 send_id 未计费过
```

5. 幂等：唯一索引 `send_log(account_id, send_id)`；重发/补报**永不重复扣费**，回放首次结果（`duplicate:true`）。服务端**不得**按"内容相同/目标相同/时间相近"做二次去重（会误杀合法重试）。
6. 判定升级：`sent_suspected` / `sent_confirmed_dom` / `failed` → `sent_confirmed` + 平台证据 = **接受升级并只计费一次**；降级或 `source_type`/`sent_at_ms` 与首次不一致 → `AUDIT_SEND_CONFLICT(409)` 整条拒绝，保留首次记录。
7. **余额不足 = 部分扣费**：按 `sent_at_ms` 升序扣到耗尽为止；**跨越零点的那一条全额入账**（允许最多透支一条单价），其后所有条目仍写 `send_log` 但 `billing_status="unbilled_insufficient_credit"`，**不扣费、充值后也不补扣**。结算后余额 ≤ 0 → 仍返回 200，`settlement.state="exhausted"` + `commands:[{type:"pause_engine",reason:"CREDIT_EXHAUSTED"}]`。
8. `billing_status` 五值语义：`billed`（扣）/ `duplicate`（不扣）/ `not_billable`（不扣）/ `policy_exceeded`（不扣，明细仍留痕）/ `unbilled_insufficient_credit`（不扣）。

**⚠️ 绝不允许 DOM 判断计入费**

- `verdict=sent_confirmed` **只能**由 `platform/publish-verifier.js` 在拿到平台响应体且 `platform_status_code === 0` 时产生。
- `confirm_signal` 三值：`platform_response`（可信）/ `dom_stable`（**不可用于计费**）/ `none`。默认 `bill_dom_confirmed=false`。
- 历史遗留的"编辑器消失即判成功"必须改写为 `sent_suspected`，走**不同字段**上报，不得混为一谈。
- **空响应 = 风控拒绝**：`verdict=failed` + `evidence.risk_control_signal="empty_response"` + `failure_reason="risk_control_rejected"`，并且计入 `platform_reject_count`（达 3 次触发熔断）。
- `sent_confirmed + sent_confirmed_dom + sent_suspected + failed = reply_attempts`（每个来源分别成立），这条恒等式要写进自测。

### 4.4 审计（红线 3 的落地）

**设计意图**：纠纷时能回答"该账号当时**实际生效**的策略是什么、用户是否主动调高过、系统是否拒绝过"。只记设置值无法自证。

**实现要点**

1. 两类上报：
   - **配置变更** `POST /audit/config-changes`：`change_id` / `changed_at_ms` / `source`（`user`/`server_policy`/`default`）/ `actor`（`local_user`/`license_server`/`system`）/ `field_key`（配置点路径白名单）/ `old_value` / `new_value` / `applied` / `reject_code`（`applied=false` 时必填）/ `policy_version`。
   - **发送明细** `POST /audit/sends`：见 4.3。
2. **本地与服务端双写**：客户端 `safety/audit.js` 先落本地，再进上报队列；服务端副本客户端不可篡改。
3. **只传哈希与计数**：
   - `target_hash = hmac(privacy_salt, video_id + "|" + comment_id)`（弹幕用 `room_id+"|"+msg_id`，私信用 `conversation_id`）；
   - `user_key_hash = hex_lower(hmac_sha256(privacy_salt, user_key_source))`，`user_key_source` 优先级 `sec_uid` > `conversation_id` > `uid_short`，同一账号内**不得混用类型**；
   - `content_hash = hmac(privacy_salt, reply_text)`，**绝不上传原文**；
   - `privacy_salt` 由登录响应下发，每账号固定，客户端不得自定义。
   - 出现 `comment_text`/`reply_text`/`nickname`/`sec_uid`/`phone`/`conversation_id`/`room_id`/`video_id`/`comment_id` 原文或任何完整 URL → `REPORT_PRIVACY_VIOLATION`，**整条拒绝**。
4. **策略快照必须含版本号**：`policy_ack_log(account_id, policy_version, policy_hash, account_tier, account_day_index, applied_limits_json, first_ack_at_ms, last_seen_at_ms)` 是"封号前实际生效策略"的唯一数据源。每次心跳 ack 都要写。
5. `evidence.platform_endpoint` 是**闭集白名单**：`comment/publish`、`comment/reply`、`im/send`、`live/comment/send`。禁止完整 URL 与域名。
6. `failure_reasons` 是**闭集**：`rate_limited`、`login_expired`、`element_timeout`、`network_error`、`risk_control_rejected`、`content_rejected`、`blocked_by_target`、`account_risk`、`unknown`。⚠️ `editor_dismissed_unconfirmed` **不是**失败原因（它对应 `sent_suspected`），出现在 `failure_reasons` 里即判非法。

### 4.5 安全护栏（`client/safety/`）

**设计意图**：把"发得像人"做成确定性代码，而不是散落在发送循环里的 `sleep`。

| 护栏 | 实现要点 | ⚠️ 易错点 |
|---|---|---|
| **频控**（`guard.js`） | 三渠道独立计数、独立间隔、独立熔断窗口（`comment`/`live_danmaku`/`dm` 互不挤占）；日上限按**服务端 `stats_tz_offset_minutes`(480)** 切分自然日，跨零点按 `sent_at_ms` 归属；同一 `user_key_hash` 在 `N` 小时内（默认 24）只回复一次（验收标准 12） | **为什么不能用固定间隔**：旧代码是 `10000 + rand(4000)`，每个周期都是整齐的 10–14 秒，这是最典型的机器人特征。必须改为**对数正态分布**（多数偏短、偶尔长间隔），并在每次点击/输入前插入 1–3 秒随机停顿；弹幕命中到回复之间也要加人工量级延迟，避免"秒回" |
| **内容相似度**（`similarity.js`） | 发送前把渲染好的文案与**近期已发内容**（建议最近 50 条 + 该规则模板池）做 SimHash 比对；阈值取策略 `content_similarity_max`（`comment`/`live_danmaku` 默认 0.85，`dm` 默认 0.75）；命中拒绝 → `verdict=skipped`/`failed` + `failure_reason=content_rejected`，UI 提示补充文案；规则保存时校验模板池**至少 5 条变体** | ⚠️ **超过阈值即拒绝**（0.85 = 相似度 > 85% 拒绝）。**方向反了会变成"只发相似内容"，是灾难性缺陷**（`AGENTS.md` §2.4）。另外禁止用 `{随机1-9}` 生成 `"1"`/`"2"` 这类明显机器痕迹，应使用"这个""这款""它"等语言变体 |
| **熔断状态机**（`circuit.js`） | 递进：**L1 暂停 30 分钟 → L2 暂停 1 小时 → L3 停到次日 00:00(UTC+8)**；触发源为验证码/滑块出现、连续失败达阈值、平台风控拒绝（`platform_reject_count` 达 3）、失败率超 `failure_rate_threshold=0.4`（窗口 `failure_rate_window=20`）；服务端下发 `cooldown_ms=1800000` 与 `risk_code_cooldown_ms=86400000`；收到 `POLICY_CIRCUIT_OPEN(409)` 或 `commands:[circuit_break]` → **60 秒内**停止全部发送 | UI 必须明确显示"当前处于第几级熔断、何时恢复"（验收标准 17：退避必须是 **30 分钟级**，不是旧代码的 60 秒）。熔断期间**不影响历史明细补报**（已发生的事实照常受理与计费），只拒绝新发送 |
| **急停**（`guard.js`） | UI 顶部常驻按钮，快捷键 `Esc`；语义是**立即生效、不可被排队任务绕过**——实现为"原子标志位 + 在发送链路每个步骤入口检查"，而不是"等当前任务跑完" | 急停与熔断机制**不可被关闭、不可被移除**（`AGENTS.md` 红线）。不得提供任何禁用开关或环境变量 |
| **活跃时段**（`guard.js`） | 默认 `08:00–23:00` 单一窗口，`tz_offset_minutes=480`；客户端只能调更短、不得新增窗口；每天在窗口内随机起止 | 夜间完全停发（验收标准 18）；时段外**照常采集**，命中计 `skipped` 而非丢弃线索 |

### 4.6 CDP 层与 browser-host

**设计意图**：旧代码有 6 份独立的 CDP WebSocket 副本（`pipeline.js`/`reply_worker.js`/`scan_comments.js`/`live_dom_collector.js`/`live_dm_worker.js`/`comment_worker.js` 各自 `ws://127.0.0.1:9222`），多个进程同时 `Target.getTargets` 并争抢同一个标签页 → 页面互相导航、`Page.navigate` 超时、"标签页被抢走"等一整套不稳定现象。**必须收敛为每实例一条独占 WS。**

**实现要点**

1. `browser-host` 是唯一持有 WS 的模块。其余模块经 IPC 请求 `{op:'open', url}` / `{op:'evaluate', expr}` / `{op:'click', selectorKey}` 等高层操作。
2. 启动流程：探测 `9222+N` 端口是否被占 → 未被占则拉起专用 Chrome（`--user-data-dir=instances/<id>/chrome-profile`、`--remote-debugging-port=9222+N`、`--disable-blink-features=AutomationControlled`）→ `http://127.0.0.1:<port>/json/version` 拿 `webSocketDebuggerUrl` → 建立 WS。
3. 标签页管理：维护 `targetId → 业务角色`（`comment`/`live`/`profile`）映射；每次操作前做**存活检查**（`Target.getTargets` 里还在且 `attached`），失效则重建标签页并把任务**退回 `queued` 而非 `failed`**（这是 S-2 自愈率 ≥95% 的关键）。
4. 搜索页必须用**新标签页**：旧代码经验——长期复用的搜索标签会退化（加载不出结果）。
5. 超时与退避：每个 CDP 命令设超时（默认 15 秒，`Page.navigate` 30 秒）；失败按 `1s/2s/4s/8s…` 指数退避，上限 60 秒；连接断开自动重建，重建期间任务保留在队列。
6. **与 `platform/` 的边界**：`core/` 只管协议——它接收 CSS 选择器与 JS 表达式作为**参数**，自身不得内联任何抖音知识。`platform/selectors.js` 提供 key，`platform/page-*.js` 负责把 key 翻译成具体表达式。

**⚠️ 易错点**

- 不要在多处 `new WebSocket(...)`。任何新增的直连 WS 都是回归缺陷。
- 端口占用探测必须做：多实例时 `9222+N` 可能被别的软件或其他实例占用。
- 不要用 `Target.createTarget` 之外的方式"复用"标签页；不要假设标签页顺序稳定。
- WS 断线重连后**必须重新 `Runtime.enable` / `Network.enable`**，否则嗅探不到响应体。

### 4.7 发送链路（最容易出错，逐步说明）

以评论区回复为例。**每一步都有独立判据、超时、重试与归因码**；DOM 判据只用于"继续下一步"，**成功判定必须来自平台响应体**。

| 步 | 动作 | 判据（继续下一步的条件） | 超时 | 重试 | 失败归因码 |
|---|---|---|---|---|---|
| 1 | 打开视频页 | `Page.navigate` 返回且 `document.readyState === 'complete'` | 30s | 2（退避 2s/4s） | `NET_TIMEOUT` / `network_error` |
| 2 | 处理重定向与帖型 | `/video/<id>` 会被重定向到 `/jingxuan?modal_id=...`；`/note/<id>` 是图文帖 → **直接跳过** | 5s | 0 | `NOTE_POST_UNSUPPORTED` |
| 3 | 等评论面板**真正可见** | 容器 `display` 由 `none` 变可见，且 `offsetWidth>0 && offsetHeight>0`。⚠️ 页面上常同时存在**隐藏与可见两个 `comment-list`**，必须选可见的那个（隐藏的里面按钮尺寸为 0） | 总预算 30s | ≤3 次（每步 5–8s） | `ELEMENT_TIMEOUT` |
| 4 | 图文帖展开（如适用） | 点击 `feed-comment-icon` 后右侧浮层出现 | 8s | 2 | `PANEL_NOT_EXPANDED` |
| 5 | 滚动找到目标评论 | 目标 `comment_id` 对应节点出现在**可见**列表中 | 总预算 30s | 滚动重试 ≤ 5 次 | `ELEMENT_TIMEOUT` |
| 6 | **`scrollIntoView` 后延迟读回复按钮坐标** | ⚠️ **必须延迟**：虚拟列表会重渲染，立即读会拿到 `0×0`。判据是 `rect.width>0 && rect.height>0`；拿到 `0×0` 就再等一轮重读 | 每轮 300–500ms，共 5 轮 | 5 | `ELEMENT_ZERO_SIZE` |
| 7 | 激活编辑器 | 编辑器获得焦点且 `contenteditable` 可写（`document.activeElement` 命中） | 8s | 3 | `ELEMENT_TIMEOUT` |
| 8 | 输入文案 | 输入后回读文本与预期一致（防输入丢失）；用真人化逐字/分段输入 + 1–3 秒随机停顿 | 10s | 2 | `unknown` |
| 9 | 发送（Enter 三段式） | Enter 触发提交；⚠️ 旧代码经验是"Enter 为主路径"，不是直接点发送按钮 | 10s | 1（**不盲目重试**，先看第 10 步） | `unknown` |
| 10 | **嗅探平台响应体判定** | `Network` 域监听 `comment/publish`（弹幕 `live/comment/send`，私信 `im/send`）：拿到响应体且 `status_code === 0` → `verdict=sent_confirmed`，`confirm_signal=platform_response` | 10s | **0 次** | `PUBLISH_NOT_CAPTURED` |
| 11 | 空响应 / 无响应 | 视为**风控拒绝**：`verdict=failed` + `risk_control_signal="empty_response"` + `failure_reason="risk_control_rejected"`，`platform_reject_count+1` | — | 0 | `EMPTY_RESPONSE` |
| 12 | 编辑器消失但无任何响应 | `verdict=sent_suspected`（**不是** `sent_confirmed`！）+ `is_final=false`，保留后续升级为 `sent_confirmed` 的可能 | — | 0 | — |
| 13 | 回复节点稳定存在 ≥3000ms | 连续 3 次 1 秒轮询节点仍在且文本一致 → `verdict=sent_confirmed_dom`，`confirm_signal=dom_stable` | 3s | — | — |
| 14 | 平台返回非 0 错误码 | `verdict=failed` + `failure_reason` 按码映射（限流→`rate_limited`、内容拒绝→`content_rejected`、被拉黑→`blocked_by_target`） | — | 0 | `PLATFORM_REJECTED` |
| 15 | 写入明细 | `send_id` + `sent_at_ms` + `verdict` + `evidence` + `failure_reason`（`failed` 时必填，其余必须为 `null`） | — | — | `DISK_WRITE_FAILED` |

> 归因码的完整定义、`STAGES` 阶段枚举与 `RETRY_CLASS` 分类见 `shared/开发规范.md` §2.1；上表的 `CODE` 为 `WorkbenchError.code`，同名列的 `reason` 为更细的本地归因码（如 `selector_miss:comment_list` 必须带选择器 key，这是 S-4 改版定位的唯一线索）。

**⚠️ 必须强调的三条**

1. **DOM 判据只用于"继续下一步"**。第 3–9 步的所有判断都只决定"要不要往下走"，它们**不得**产生 `sent_confirmed`。
2. **成功判定必须来自平台响应体**（第 10 步，`publish-verifier.js` 是唯一出口）。旧代码的"编辑器消失即成功"把页面崩溃记成成功，是本项目史上最严重的口径缺陷（D-12）。
3. **空响应 = 风控拒绝**，不是成功、也不是"未知"。第 11 步必须写 `risk_control_signal`，并触发熔断计数。

### 4.8 多实例隔离

**设计意图**：一个进程管多个抖音号（`NFR-8`），且**单实例故障不传播**（S-6）。

**实现要点**

1. 目录隔离：`client/instances/<账号ID>/`，内含 `chrome-profile/`（独立 `--user-data-dir`）、队列、历史、统计、运行态、审计、`pending_sends.json`（上限 `max_pending_sends=20000`，超出丢最旧并告警）。
2. 端口分配：基线 `9222`，实例 N 用 `9222 + N`（可配），**启动前探测占用**，冲突则顺延并记录实际端口。
3. CDP 连接：每实例一条独立 WS，由该实例的 `browser-host` 持有；`browser-host` 崩溃只重建该实例。
4. 调度隔离：每实例独立频控、日上限计数、熔断窗口、活跃时段判定。
5. 授权共享：实例归属商家账号，**共用该商家的积分池**，但**各自独立 ack 策略**（心跳可按实例聚合，`instances[]` 字段上报）。
6. 单实例异常处理：`error` 态的实例**不得**阻塞其他实例的调度；也不得把整机 `engine_state` 从 `running` 拉下来（只有全部实例停才算 `stopped`）。
7. 文件所有权：`client/host/store.js` 是唯一写盘者；不同实例写不同文件，写队列可按实例分片，但**同一文件只有一个写者**。

**⚠️ 易错点**：多实例共享一个 Chrome profile、共享一个调试端口、或让两个 `browser-host` 抢同一 Chrome，都会退化成旧代码的争抢问题。

### 4.9 数据看板

**设计意图**：商家看"截了多少流、有多少人回复他"（原始需求 4）；甲方看全部商家。**口径必须双端一致**，否则对账会变成纠纷源。

**指标口径定义（与 `protocol.md` §7.6 一一对应，客户端与服务端共用同一份聚合逻辑）**

| 看板指标 | 数据来源 / 公式 |
|---|---|
| 截流总量 | `sum(leads_new)`（三来源合计） |
| 已回复人数 | `COUNT(DISTINCT user_key_hash WHERE verdict='sent_confirmed')`，展示必须标注"仅平台确认送达" |
| 回复条数 | `COUNT(verdict='sent_confirmed')`；`sent_confirmed_dom` 与 `sent_suspected` **单列**，不并入 |
| 回复成功率 | `COUNT(sent_confirmed) / COUNT(reply_attempts)`；分母为 0 时返回 `null`，前端显示 `—` 而**不是 100%** |
| 分渠道明细 | `send_log` 按 `source_type` 聚合的 `reply_attempts/sent_confirmed/failed` |
| 失败原因分布 | `failure_reasons` 聚合（闭集 9 值） |
| 额度消耗 | `credit_ledger` 按 `settled_at_ms` + `stats_tz_offset_minutes` 聚合，**客户端不得自行计算** |
| 近 7 日趋势 | 按自然日聚合 `leads_new` / `sent_confirmed` / `usage_milli` |
| 当日额度使用率 | `daily_quota.*` 使用率、`policy_exceeded` 与 `tier_sending_disabled` 条数 |

**实现要点**

1. **共用同一份聚合逻辑**：客户端 `client/host/stats.js` 与服务端 `license-server/domain/stats.js` 保持**相同算法**，并各有一份单元自测；两者的输入都是同一份明细结构（`sends[]` 与 `sources`）。
2. 恒等式约束（要写成断言）：
   - `sent_confirmed + sent_confirmed_dom + sent_suspected + failed = reply_attempts`（每来源）；
   - `reply_attempts + skipped ≤ hits`；
   - `leads_new ≤ hits`（违反记 `audit_flag:"leads_gt_hits"` 并按 `hits` 截断）；
   - `sum(failure_reasons.values) == sum(sources.*.failed)`（违反记 `audit_flag:"failure_sum_mismatch"`）。
3. 对账：服务端比对同窗口 `audit_sends` 明细中 `sent_confirmed` 条数与本次 `sources.*.sent_confirmed` 之和；不符记 `audit_flags:["aggregate_mismatch"]`，**永远以明细为准**（计费只依据明细）。
4. 去重键（决定 `hits` 计数）：`comment` = `(account_id,'comment',video_id,comment_id)`，`comment_id` 缺失则**不计入 hits**（宁可少算不可多算）；`live_danmaku` 优先 `(account_id,'live',room_id,msg_id)`，无稳定 `msg_id` 时退化为 `(account_id,'live',room_id,user_key_hash,content_hash)` 且 **5 分钟窗内只计一次**；`dm` = `(account_id,'dm',conversation_id,msg_id)`。
5. 历史遗留的演示假数据（D-14：接口返回全空时前端 `liveState` 不清除）**必须彻底删除**——看板上不允许存在任何硬编码样例数字。空态显示"暂无数据"。

### 4.10 额度文案 `quota_notice`

**设计意图**：商家最容易误解的一点是"买了半年套餐 = 半年内能无限发"。平台日上限才是真正的量级约束，套餐只是预付额度。**这个误解必须在四处被同一段文案反复拦住。**

**实现要点**

1. 文案**由 `tier_table` + `credit_per_reply` 实时生成**，禁止硬编码到客户端或模板字符串：

```
stable_daily_max_total = tier_table[stable].comment.daily_max
                       + tier_table[stable].live_danmaku.daily_max
                       + tier_table[stable].dm.daily_max        // 区间取上限：30 + 30 + 10 = 70
plan.credits           = ceil(stable_daily_max_total × valid_days × plan_credit_ratio)  // ratio 默认 1.0
min_plan_credit        = ceil(stable_daily_max_total × 180 × plan_credit_ratio)          // 默认 12600
estimated_days_at_cap  = credits / credits_per_day_at_cap                                // 分母 0 → null
```

2. **四处原样展示** `quota_notice.headline` + `quota_notice.detail`，**不得改写、折叠、隐藏**（验收标准 22，`protocol.md` §4.14 硬要求）：
   - ① 套餐展示页；② 充值页；③ 首次登录弹窗；④ 余额不足提示。
3. `daily_cap_total = 0`（观察期）时必须切换为观察期文案：headline `"当前处于观察期，仅采集线索，第 4 天开始可发送"`，detail 说明观察期只采集不发送、第 4 天起进入预热期（评论 10 条/天、弹幕 10 条/天、私信 3 条/天）。
4. 余额展示必须**同时**显示两项：剩余可发条数 `replies_affordable = floor(balance_milli / credit_per_reply_milli)` 与今日剩余额度 `daily_quota.*.remaining`。
5. `estimated_days_at_current_rate`（按最近 7 日实际日均消耗估算）必须与实际消耗一起展示，避免商家误判。
6. `hours` 字段已废弃，服务端恒返回 `null`，**客户端必须忽略，禁止据此展示**。

---

## 5. 关键决策与理由

| # | 决策 | 理由 | 被否决的方案 | 否决理由 |
|---|---|---|---|---|
| 1 | 裸 CDP + `ws` 驱动商家专用 Chrome | 登录态真实可用；`navigator.webdriver` 等指纹更可控 | `puppeteer-core` / `playwright` | ① 会设置自动化指纹，风控可识别；② 现有 DOM 表达式围绕裸 CDP 的 `Runtime.evaluate` 写，换 `page.evaluate` 模型要重写全部交互原语；③ 绑定特定 Chrome 版本、分发包更大；④ 默认启动**全新浏览器上下文**，用不上商家已扫码登录的账号，而在自动化浏览器里重新登录恰是风控最敏感的特征 |
| 2 | 客户端存储用 JSON 文件 | 数据量小、可读可调试、单机排障方便、零依赖 | 客户端也用 `node:sqlite` | 引入原生模块分发风险；客户端数据量（每实例几 MB）不需要 SQL 能力 |
| 3 | 客户端**单写者**（`host/store.js` + 原子写） | 旧代码 3 处"多进程读-改-写同一 JSON"竞态已实际造成丢任务（D-7） | 各进程加文件锁自行写 | 锁只解决并发写，不解决"陈旧内存态全量覆写"；锁的粒度与超时在 Windows 上不可靠 |
| 4 | 选择器集中在 `platform/selectors.js` | S-4 要求"抖音改版后修复只需改 1 个文件"；选择器散落则此指标永远达不到 | 选择器就近写在页面模型里 | 抖音一改版要改 N 处，且容易漏改造成静默失效 |
| 5 | CDP 独占一条 WS（`browser-host`） | 旧代码 6 份 CDP 副本 + 多进程争抢标签页，导致页面互相导航、`Page.navigate` 超时 | 每个 worker 自建连接 | 争抢同一标签页无法通过重试解决；且 `Network` 域嗅探需要单一监听者，多连接会漏事件 |
| 6 | 积分用 `_milli` 整数表示 | 浮点数在"0.1 积分/条"下会产生累加误差，账务不容许；`node:sqlite` 也更适配整数 | 用浮点 `REAL` 或字符串小数 | 累加误差会在对账时暴露为"余额差 0.0000001"，且无法用整数比较做幂等 |
| 7 | 纯 JavaScript（CommonJS），不用 TypeScript | 商家机器"解压即用"，不需要装构建工具；与 `node:sqlite` 和现有代码风格一致 | TypeScript | 引入构建步骤与分发包变化，违背零构建分发目标；若确需引入必须报备并更新 `术语与选型基准.md` |
| 8 | 服务端 `node:sqlite`（内置） | 真事务（余额扣减与流水必须同事务）、支持聚合查询、零依赖 | `better-sqlite3` | 需编译原生模块，服务器环境易失败；`sqlite3` 包的异步 API 让"同事务"变复杂 |
| 9 | 计费按"平台确认成功的回复条数" | 厂商与商家利益一致（号被封 → 收不到钱）；封号争议小 | 按挂钟时长计费（v1 模型） | 激励冲突："跑得越久赚得越多、账号寿命越短"；且无法举证"这段时间真发了多少" |
| 10 | 安全上限由服务端下发，客户端只能更保守 | 这是产品的**核心交付价值**与责任划分的技术依据（厂商已尽合理限制义务） | 客户端本地配置上限 | 客户端可被改文件绕过；纠纷时无法举证厂商拒绝过激进配置 |
| 11 | 默认档位 = 半自动（自动填充 + 一键确认），全自动需显式勾选风险确认 | 默认最安全；全自动勾选记录本身是审计证据 | 默认全自动 | 新装即自动发送，风险与责任都不合理 |
| 12 | 重启后队列任务退回 `queued` 而非 `failed` | 单点故障（标签页被关、Chrome 重启、网络抖动）后能自愈，S-2 自愈率 ≥95% | 断连即标失败 | 会把"可自愈的抖动"记成失败，污染成功率口径并触发假熔断 |
| 13 | 审计只上传哈希与计数 | 隐私边界（`NFR-7`）：不上传评论原文、回复原文、用户隐私字段 | 上传原文便于排查 | 数据泄漏风险与合规风险不可接受；排查可用本地日志（脱敏） |
| 14 | 离线用"影子额度"（只减不增） | 断网不能成为绕过余额的手段；同时避免"停机后还在扣钱"的投诉 | 离线期间继续按本地余额发送 | 本地余额可被改文件伪造，等于授权失效 |
| 15 | 余额不足时**部分扣费**（允许一条透支，后续不补扣） | ① 明细已发生，全拒会让服务端缺少封号取证数据；② 全拒会导致客户端无休止重试并丢最旧明细；③ 透支上限清晰（= 一条单价）；④ 不补扣杜绝"停机后还在扣钱"投诉 | 全拒整批 | 会产生重试风暴，且审计出现空洞（详见 `protocol.md` §6.5） |

---

## 6. 开发顺序与依赖关系

| 阶段 | 目标 | 前置依赖 | 为什么是这个顺序 |
|---|---|---|---|
| **P0 准备** | 旧代码移入 `legacy/`；`test/fixtures/` 与选择器注册表骨架；`shared/lib/` 协议常量；`node test/run.js` 入口 | 无 | ① 先把"行为规格"和"离线回归防线"固定下来，后面所有 DOM 代码都有对照物；② 协议常量是双端共同的编译期基础；③ 没有 `test/run.js` 就没有客观验收手段 |
| **P1 契约与授权中心** | 协议落地为代码；服务端库与迁移；登录/令牌/密码；`tier_table` 与策略下发；心跳；积分与台账；充值码；健康检查 | P0 | 契约是**语言中立资产**，先定它可以让后续语言决策不阻塞进度；客户端未必要先于服务端；缺服务端则客户端无法验证红线 1/2 |
| **P2 客户端底座 + 评论区自动回复**（含**真机验证门**） | `core/cdp.js`、`browser-host`、`platform/selectors.js`、评论区页面模型、发送判定、`safety/`、`license/` 客户端、单实例闭环 | P0、P1 | 评论区是最主要的来源、也是 DOM 知识最完整的一条链路；先用它验证"裸 CDP 驱动抖音"这条路真的走得通。**未通过 G-1~G-5 不得进入 P3** |
| **P3 弹幕与私信** | 直播弹幕采集与回复、私信发送、`sec_uid` 提取与 `not_locatable` 处理 | P2（发送链路原语与判定层已稳定） | 弹幕与私信复用 P2 建立的原语与判定层，只是换页面模型与目标定位；私信风险最高（限额最严），放在原语稳定之后 |
| **P4 数据看板与上报** | 客户端看板、服务端看板、上报与离线补报、口径一致性 | P1（上报接口）+ P2/P3（有真实明细可统计） | 没有明细就看不出对账问题；先有数据再建看板，能立刻暴露口径不一致 |
| **P5 多实例与商业闭环** | 多实例隔离、管理后台 CLI、套餐、充值码批量生成 | P1（服务端）+ P2/P3（单实例稳定） | 多实例会把"单实例能跑"放大成并发问题；商业闭环（开号收钱）应在技术链路可验证之后 |
| **P6 界面精修与交付** | 界面（快捷键、暗色、额度文案四处展示）、文档重写、72 小时长稳、打包 | 全部 | 界面精修依赖功能全部到位；长稳测试必须在功能冻结后跑才有意义 |

### P2 真机验证门（Gate，`docs/架构说明.md` §十二）

P2 完成后，**必须**用**真实抖音测试账号**（专门小号，不要用主号）回答以下问题，**未通过不得继续 P3**：

| 编号 | 问题 | 通过标准 | 不通过的含义 |
|---|---|---|---|
| G-1 | 裸 CDP 接管专用 Chrome 后，评论区互动是否全程无需重新登录？ | 无需重新登录 | 方案本身有风险，换语言也无效 |
| G-2 | 自动回复是否能连续 20 次成功且判定准确？ | 不误报、不谎报 | 定位逻辑需重做 |
| G-3 | 风控表现如何？ | 无验证码拦截、无账号异常提示 | 需下调频控参数或重估方案 |
| G-4 | 旧代码中的 DOM 定位技巧能否全部复现？ | 全部复现 | 说明知识高度依赖具体实现 |
| G-5 | 连续运行 8 小时是否稳定？ | 无崩溃，可自愈标签页关闭 | 需加强 core 层 |

> 换 Python 的触发条件**仅有** G-1/G-2 因**语言能力**受限而无法达成（预期不会发生，裸 CDP 在两种语言下等价）。G-1~G-5 全通过则维持 Node。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **抖音改版导致定位失效** | 自动回复全部失败 | ① 选择器集中在 `platform/selectors.js`，每条带 `lastVerifiedAt`/`confidence`/`fallbacks[]`（S-4：修复只改 1 个文件）；② `test/fixtures/*.html` 离线回归，改版时先跑测试定位失效项；③ 每步失败带 `selector_miss:<key>`，UI 直接显示卡在哪 |
| **风控封号** | 商家账号损失，是本项目最大商业风险 | ① 默认半自动；② 预热曲线客户端不可跳过、观察期日上限 0；③ 服务端下发上限，客户端只能更保守；④ 熔断 30 分钟 → 1 小时 → 停到次日；⑤ 活跃时段限制；⑥ 内容相似度闸门；⑦ 界面常驻"每日风险摘要"与账号健康分；⑧ **全部文案禁止"保证不封号"**（验收标准 23），只承诺"持续更新风控策略" |
| **真机验证依赖测试账号** | 没有测试账号则 P2 无法收口，后续阶段全部阻塞 | ① P0 就确认测试小号可用并写进开工检查表；② 验证脚本化、可重复（`test/run.js` 的 `gate` 子命令），避免反复手工试错消耗账号；③ 明确"不要用主号"，并限制每日验证发送量 |
| **服务端部署环境与现有代理服务共存** | 误操作可能打断厂商自己的出口代理（sing-box 占用 443/tcp、8443/udp） | ① 授权服务用 `127.0.0.1:18080` + 对外 `9443/tcp`，**不碰 443/8443**；② ufw **只加不删**，改前备份；③ 禁止 `systemctl restart systemd-networkd`/`netplan apply`/`reboot`；④ systemd 资源上限 `MemoryMax=384M`、`CPUQuota=60%`；⑤ 每个关键步骤后跑"代理不受影响"自查（`docs/部署指南-服务端.md` §12.3） |
| **多实例资源占用** | 每实例一个 Chrome，内存/CPU/端口线性增长 | ① 端口 `9222+N` 启动前探测；② 单实例故障不传播（S-6）；③ 空闲实例自动降频采集；④ 打包文档给出建议上限（如单机 ≤ 3 实例）并做资源自检提示 |
| **CDP 层不稳定（标签页被关/Chrome 重启/网络抖动）** | 任务失败率虚高、假熔断 | ① 独占 WS + 存活检查 + 自动重建；② 任务退回 `queued` 而非 `failed`；③ 指数退避 1s/2s/4s…上限 60s；④ G-5 8 小时长稳、S-1 72 小时长稳 |
| **客户端本地文件被篡改伪造余额** | 授权失效、收不到钱 | ① 余额只存服务端；② 所有响应 HMAC 验签，验签失败 fail-closed 停机；③ 影子额度只减不增；④ 验收标准 8 直接测试这一点 |
| **`sec_uid` 取不到导致私信失效** | 部分弹幕线索无法私信 | 优先从弹幕数据帧/接口响应提取真实 `sec_uid`；提取不到时**跳过并计入"因风控跳过"统计**，标记 `not_locatable`，不报成功、不静默失败（FR-2.4） |
| **基线文档缺失导致返工** | 影响 DOM 编码质量与测试设计 | 见本文 §9：`shared/已知陷阱与平台知识.md`、`测试策略.md`、`开发规范.md`、`安全与合规要求.md`、`AI协作开发指引.md` 当前不存在，需在 P0 补齐（至少补齐陷阱与测试策略两份） |

---

## 8. 交付物清单

### 8.1 交付物

| 交付物 | 内容 | 完成定义（Definition of Done） |
|---|---|---|
| **① Windows 客户端便携包** | `douyin-workbench-client-<ver>.zip`：`client/`、`shared/lib/`、内置 `node_modules/ws`、`启动.cmd`/`停止.cmd`、`README.md`（面向商家） | 解压到任意路径（如 `E:\test\wb\`）后双击 `启动.cmd` 即可运行；不需要 `npm install`；不出现任何绝对路径；Node < 22.5 时给出明确提示而非崩溃 |
| **② Linux 授权中心** | `license-server/` + `cli.js` + `admin/` + 迁移脚本 + `.env.example` | 按 `docs/部署指南-服务端.md` 在 Ubuntu 22.04 / 2核3GB 上部署成功；`/healthz` 与 `/readyz` 返回 200；`sing-box` 全程 `active`；`ufw` 规则只增不减 |
| **③ 文档** | 重写的 `README.md`（商家）、`AGENTS.md`（红线 + 索引，≤120 行）、`docs/开发规范.md`、`shared/已知陷阱与平台知识.md`、`shared/测试策略.md`，以及本方案的开发指导与任务清单 | 新接手者按 `README-DEV.md` 的"路径 2"能独立跑通全流程；P0 遗留的 5 份缺失文档补齐 |
| **④ 测试资产** | `test/run.js`（统一自测入口）、`test/fixtures/*.html`（真实页面快照）、服务端与客户端各自的自测 | `node test/run.js` 全绿（验收标准 9）；`node --check` 全量通过；离线回归不需要登录、不需要联网、不碰真账号 |
| **⑤ 审计导出能力** | `license-server/cli.js audit export` | 能导出某账号完整审计记录，其中可看出"实际生效的策略值"与"用户是否主动调高过配置"（验收标准 21） |

### 8.2 全项目完成定义

1. `docs/需求规格.md` §九 的 **23 条验收标准**逐条可复现、可举证。
2. `docs/架构说明.md` §一 的 **S-1~S-6** 稳定指标全部达标：72 小时不崩溃 / 自愈率 ≥95% / 每个失败可定位到阶段与原因 / 改版修复只改 1 个文件 / 零重复发送与零重复扣费 / 故障不跨实例传播。
3. **三条红线有对应的自动化测试**：
   - 红线 1：越权上报返回 `POLICY_VIOLATION`；观察期无法通过任何界面操作开始发送；策略收紧后 60 秒内生效。
   - 红线 2：风控拒绝的发送不扣费且台账无消耗记录；同 `send_id` 重复上报 10 次只扣 1 条；`confirm_signal=dom_stable` 永不产生 `billed`。
   - 红线 3：审计记录含 `applied_policy_version` 与 `applied_limits`；上报体内不含任何禁用隐私字段；`POLICY_VIOLATION` 的越权尝试可在导出中检索到。
4. 全仓无 `data-e2e` 字符串出现在 `client/platform/selectors.js` 之外；无生产代码 `require('../../legacy/...')`；`license-server/` 与 `client/` 之间无 `require`。

---

## 9. ⚠️ 开工前必须处理的文档缺口与矛盾

以下是编写本文时**逐份核对**发现的问题。事实源之间出现冲突时，按 `README-DEV.md` 的裁定：**以 `docs/需求规格.md` 与 `shared/protocol.md` 为准**。请技术负责人先裁定下表，再让开发团队按裁定开工。

### 9.1 事实源缺口（会直接影响编码质量）

`README-DEV.md` §七 与"阅读路径"引用的文件，**截至本文编写时**在仓库中的实际状态如下（文档正在被并行补齐，请以 P0-01 的核查结果为准）：

| 文件 | 状态 | 影响 | 建议 |
|---|---|---|---|
| `shared/开发规范.md` | ✅ 已存在 | — | 已确认全项目 `snake_case`（含局部变量与函数名）、单文件 ≤500 行、错误对象与 `STAGES` 定义 |
| `shared/已知陷阱与平台知识.md` | ❌ 不存在 | **写 CDP 代码前必读的那份不存在**。抖音 DOM 知识目前只能从 `legacy/` 源码重新考古 | **P0 必补**（P0-03 的产出之一）；在此之前以 `AGENTS.md` §2.10/§2.11 与 `legacy/` 对照为准 |
| `shared/测试策略.md` | ❌ 不存在 | 离线 fixtures 方案与长稳测试方法无据可依 | P0 必补（P0-02 需要它定义断言形式） |
| `shared/安全与合规要求.md` | ❌ 不存在 | 红线展开与审计字段的完整定义缺失（`README-DEV.md` §二引用了它） | P1 前补 |
| `shared/AI协作开发指引.md` | ❌ 不存在 | 智能体误实现清单缺失 | P0 补；可先以 `AGENTS.md` §2 的 14 条替代 |
| `plans/00-两方案对比与选型建议.md`、`plans/B-*.md` | 🚧 部分存在 | 非本方案阻塞项 | 不阻塞 |

核查命令（P0-01 执行）：

```bash
ls -1 shared/ docs/ plans/
```

### 9.2 文档之间的矛盾（需技术负责人裁定）

| # | 冲突点 | 出处 A | 出处 B | 本文取用的口径 |
|---|---|---|---|---|
| 1 | **服务端策略字段名与取值完全不同** | `docs/部署指南-服务端.md` §3.3：`daily_total_max=50`、`daily_comment_max=30`、`min_interval_comment_sec=60`、`level` ∈ `basic/standard/vip` | `shared/protocol.md` §4.6：`limits.comment.daily_max`（稳定期 30、预热期 10）、`min_interval_ms`（60000–180000）、`account_tier` ∈ `observation/warm_up/ramp_up/stable` | **按 `protocol.md`**：协议是 `protocol_version=2` 的唯一权威；部署指南 §3.3 的策略默认值是 v1 遗留，需重写 |
| 2 | 同上，`policy` 表 DDL 与 `policy_ack_log` 冲突 | 部署指南 §5.4：`policy(account_id, policy_version, level, policy_json, applied_at)`、`policy_history` | `protocol.md` §4.10 硬要求 `policy_ack_log(account_id, policy_version, policy_hash, account_tier, account_day_index, applied_limits_json, first_ack_at_ms, last_seen_at_ms)` | **按 `protocol.md`**：`policy_ack_log` 是契约硬要求，部署指南的表结构需补 |
| 3 | 错误码命名不同 | 部署指南 §10.4、§11.9：`client_too_old`、`reportId`、`username`、`deviceId`、`hmacSecret`（camelCase） | `protocol.md` §3：`SERVER_VERSION_UNSUPPORTED(426)`、`report_id`、`account`、`device_id`、`sign_key`（snake_case） | **按 `protocol.md`**：全篇 JSON 字段统一 `snake_case` |
| 4 | 最低客户端版本初值不同 | 部署指南 §3.1：`MIN_CLIENT_VERSION=0.1.0` | `protocol.md` §1.4：`min_client_version` 默认 `3.0.0` | **按 `protocol.md`**（`3.0.0`） |
| 5 | **半年套餐积分基数不同** | `docs/架构说明.md` §十 R-4：`plan` 表默认占位"半年套餐 = 4320 积分"；部署指南 §7.2：`$rc plan set --credits 4500`（日均 25 × 180） | `protocol.md` §4.14 + `需求规格.md` FR-3.3：`credits = stable_daily_max_total(70) × 180 × plan_credit_ratio = 12600`，且 <`min_plan_credit`(12600) 时返回 `PLAN_QUOTA_BELOW_MIN` | **按 `protocol.md`/`需求规格.md`**：`12600`；4320/4500 都会直接触发 `PLAN_QUOTA_BELOW_MIN`，部署指南 §7.2 的命令需改 |
| 6 | **计费模型** | `docs/架构说明.md` §七"积分协议"：按"自动回复引擎处于运行态的挂钟时长"分段计费、空闲计入、断网暂停扣费 | `protocol.md` §1.2/§6、`需求规格.md` FR-3.1：按**平台确认成功的回复条数**计费，`online_seconds` **不用于计费** | **按 `protocol.md`**：架构说明 §七 已作废，需重写（该节标题下应直接标注 deprecated） |
| 7 | FR-2.3.2 的"默认日上限/间隔"与 `tier_table` 不一致 | `需求规格.md` FR-2.3.2 表：评论 20–30 条、间隔 60–180 秒随机；弹幕 30–50 条、间隔 30–90 秒随机；私信 5–10 条、间隔 300–900 秒随机 | `protocol.md` §4.6 `tier_table`：评论 10/25/30、弹幕 10/25/30、私信 3/8/10；`min_interval_ms_range` 上界与 FR 一致（评论 180000、弹幕 90000、私信 900000） | **按 `tier_table`**：`需求规格.md` FR-2.3.2 表格的区间是"设计区间"，日上限的实际阶梯必须取 `tier_table`；建议在该表加注"实际阶梯见 FR-2.3.1 与 `tier_table`" |
| 8 | `docs/需求规格.md` §四 表格前残留一行孤立 NFR-1 | 第 317 行 `| NFR-1 依赖 | 客户端**保持零 npm 依赖**…` 位于 §四 标题之前，与第 322 行正式 NFR-1（允许 `ws`）矛盾 | 正式 NFR-1 允许 `ws` | 文档编辑缺陷，建议删除第 317 行 |
| 9 | `docs/需求规格.md` §六 目录规划与 `术语与选型基准.md` §四 目录结构完全不同 | 需求规格 §六：`license-server/lib/*.js`、`client/services/autoreply/`、`client/workers/`、`client/reply_server/`、服务端默认端口 8787 | 术语与选型基准 §四：`license-server/api|domain|store|crypto|admin`、`client/host|core|platform|adapters|license|safety|ui`；部署指南：应用 `127.0.0.1:18080` | **按 `术语与选型基准.md` §四**（它自称目录结构事实源）；需求规格 §六该节建议标注"已被取代" |
| 10 | 旧包 README 的 Node 版本与端口 | `README.md`：Node **20 或更高**、控制台 8090 | `术语与选型基准.md`：Node **≥ 22.5**；部署指南/协议：服务端 `18080` | 按新口径（≥ 22.5）；`README.md` 属 P6 重写范围 |
| 11 | `docs/架构说明.md` §三 的进程模型里出现 `task-runner` 与 `services/` | 架构说明 §三/§二：`browser-host`/`task-runner`/`platform` 三进程并列 | 术语与选型基准 §四 只有 `host/core/platform/adapters/license/safety/ui`；`需求规格.md` FR-5 又要求 `client/services/video_edit_service.js` 占位 | 本文按 `术语与选型基准.md` 的目录组织，把 `task-runner` 视为 `host/scheduler.js` 的逻辑角色；`services/` 占位建议改为 `client/adapters/video-edit.js`（需负责人裁定，否则 FR-5 的"预留接口"没有落点） |

| 12 | `docs/需求规格.md` 仍保留"不推倒重来、复用旧 worker"的表述 | §六 末"迁移策略：**不推倒重来**…核心 CDP 逻辑原样保留"、§七"可原样复用" | `README-DEV.md` §三、`架构说明.md` §〇、`需求规格.md` §十 均已决定**完全重写** | **按完全重写**：旧代码进 `legacy/` 只读参考，新代码不得 `require` 它 |
| 13 | 服务端审计/金额的表结构与类型口径 | `docs/部署指南-服务端.md` §5.4：`audit_event(occurred_at TEXT, credit_delta REAL)` 按 ISO8601 与浮点 | `shared/开发规范.md` §5.4 与 `protocol.md` §1.3：时间一律整数 Unix 毫秒（`_ms`）、金额一律整数 milli（`_milli`）、**禁止 REAL 存余额** | **按 `protocol.md` + `开发规范.md`**：部署指南 §5.4 的审计表 DDL 属 v1 遗留，需重写为 `send_log` + `audit_config_changes` + `policy_ack_log` |
| 14 | 部署指南引用的 CLI 与协议能力不匹配 | §7.1：`policy set --set daily_total_max=120`、`plan set --credits 4500` | `protocol.md` §4.6：策略字段是 `limits.<source>.daily_max`；§4.14：`credits < min_plan_credit` → `PLAN_QUOTA_BELOW_MIN` | CLI 命令名可保留，但参数与默认值需按新结构重写（P5-05 的交付内容） |

### 9.3 开工前检查表

- [ ] 技术负责人已对 §9.2 的 14 项冲突逐条裁定，并同步修改 `docs/部署指南-服务端.md` §3.3/§5.4/§7.2、`docs/架构说明.md` §七、`docs/需求规格.md` §四/§六/§七
- [ ] P0 已排入缺失文档中最关键的两份（`已知陷阱与平台知识.md`、`测试策略.md`）
- [ ] 已确认可用的**抖音测试小号**（P2 真机验证门 G-1~G-5 必需）
- [ ] 已确认服务端部署机可访问，且 `sing-box` 全程 `active`
- [ ] 已确认 Node ≥ 22.5 且 `node:sqlite` 可用：`node -e "const{DatabaseSync}=require('node:sqlite');console.log('ok')"`

---

*本文档为方案 A 的开发主文档。与 `shared/protocol.md` 或 `docs/需求规格.md` 冲突时，以那两份为准，并先改文档再改代码。*
