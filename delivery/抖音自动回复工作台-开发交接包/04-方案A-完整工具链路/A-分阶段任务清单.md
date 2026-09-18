# 方案 A：分阶段任务清单（P0~P6）

> **配套主文档**：`plans/A-工具链路开发指导.md`（先读它，理解设计与边界）
> **事实源**：`shared/protocol.md`（接口契约）＞ `docs/需求规格.md`（唯一验收依据）＞ `shared/术语与选型基准.md`（选型与目录）＞ `shared/开发规范.md`（编码规范）
> **用法**：按 P0→P6 顺序执行。"前置依赖"是**硬依赖**，未满足不得开工；"验收判据"必须客观可判定，不得用"功能正常"代替。
> **阶段划分说明**：`docs/架构说明.md` §九 的 P2 表述为"评论区自动回复"，`docs/需求规格.md` §十 的旧"P0 修基线缺陷"计划**已作废**（改为完全重写）。本清单按用户指定划分细化，与 `架构说明.md` §九 的阶段名一一对应。
> ⚠️ **"代码写完"不等于"完成"**（`AGENTS.md` §6）。涉及抖音页面操作的任务必须真机验证后才能标记完成；汇报时须区分"已真机验证"与"仅代码完成"。
> 🔴 **真机验证门**：P2-15（G-1~G-5）未通过，**不得进入 P3 及之后任何阶段**。

---

## 〇、任务总量与工作量估算

| 阶段 | 任务数 | 人日 | 并行度 | 主要风险 |
|---|---|---|---|---|
| **P0 准备** | 5 | **4–6** | 2 人并行（文档整理 / 测试骨架） | `legacy/` 搬迁遗漏 → 后续 DOM 对照无据 |
| **P1 契约与授权中心** | 10 | **12–18** | 契约与 DB 先行，之后 API 可并行 | 结算事务与幂等写错 → 直接违反红线 2 |
| **P2 客户端底座 + 评论区自动回复** | 15 | **25–40** | core/platform 可并行，之后必须串行 | **真机验证门**；DOM 知识迁移失败 |
| **P3 弹幕与私信** | 6 | **10–16** | 弹幕与私信可并行 | `sec_uid` 脱敏 → 私信大面积 `not_locatable` |
| **P4 数据看板与上报** | 5 | **8–12** | 双端看板可并行 | 口径不一致 → 对账纠纷 |
| **P5 多实例与商业闭环** | 5 | **10–15** | CLI 与多实例可并行 | 多实例资源争抢退化回旧代码问题 |
| **P6 界面精修与交付** | 5 | **12–18** | 界面与文档/打包可并行 | 72 小时长稳未通过即不可交付 |
| **合计** | **51** | **81–125 人日** | — | 不含甲方验收与商务流程时间 |

**估算假设**：① 团队 2–3 人（客户端/CDP、服务端、前端兼测试）；② 开发者已读完 `README-DEV.md`、`AGENTS.md`、主文档与清单，无需额外方案澄清；③ **已有可用抖音测试小号**，P2 真机验证可在 P2 内完成；④ 服务端在开发机本地跑通（`架构说明.md` §十 R-3 部署后置），部署联调计入 P6；⑤ 期间抖音页面**无结构性改版**（若改版，S-4 的收益是"只改 1 个文件"，但真机复验需额外 2–3 人日/次）；⑥ 人日 = 1 名熟练开发者 1 个标准工作日，不含需求变更与商务沟通。

---

## 一、阶段验收表

| 阶段 | 交付内容 | 验收方式 | 验收判据 |
|---|---|---|---|
| **P0** | `legacy/` 存档、`test/run.js`、`test/fixtures/`、`shared/lib/`、选择器骨架 | 离线自测 | `node test/run.js` 全绿；`node --check` 全量通过；生产代码不引用 `legacy/`；`selector`/`protocol`/`selector-registry` 三组单测通过 |
| **P1** | `license-server/` 全部接口 + 协议落地 | 接口自测 + 契约用例 | 验收标准 **1、2、3、8、19、20** 通过；`protocol.md` §6.6 的 **14 条边界用例**逐条有测试且全绿 |
| **P2** | `core/` + `platform/` + `adapters/reply-comment.js` + `safety/` + `license/` + 单实例闭环 | **真机验证门 G-1~G-5** + 离线回归 | 验收标准 **4、5、6、9、11、13、14、15、17、18** 通过；G-1~G-5 **全部通过** |
| **P3** | `page-live.js`、`page-profile.js`、`reply-danmaku.js`、`send-dm.js`、`sec_uid` 提取 | 真机验证 + 离线回归 | 验收标准 **16** 通过；三渠道独立限额有测试；`not_locatable` 被正确统计且不报成功 |
| **P4** | 双端看板、上报与离线补报、口径一致性 | 对账比对 | 验收标准 **7、10、21** 通过；双端同一区间三项指标数字**完全一致** |
| **P5** | 多实例隔离、管理后台 CLI、套餐、充值码批量生成 | 端到端演练 | 验收标准 **2、12、22** 通过；单实例故障不传播有可复现测试 |
| **P6** | 界面精修、文档重写、72 小时长稳、双端安装包 | 交付验收 | 验收标准 **23** 通过；S-1~S-6 全部达标；便携包解压即用 |

---

## 二、里程碑与阻塞点

| 里程碑 | 触发条件 | 阻塞下游 |
|---|---|---|
| **M0 可测** | P0-05 完成 | P1 起全部任务（没有自测入口就没有客观验收手段） |
| **M1 契约冻结** | P1-01 完成，且主文档 §9.2 的 14 项冲突**已由技术负责人裁定** | P1-02 起服务端全部、P2 起客户端全部 |
| **M2 能登录看余额** | P1-09 完成 | P2-08 起（客户端 `license/` 需真实可连的服务端） |
| **🔴 M3 真机验证门** | P2-15 完成且 G-1~G-5 全部通过 | **P3、P4、P5、P6 全部阻塞**。未通过只能：修 `core/`/`platform/` 后重验，或按 `架构说明.md` §十二 评估换语言 |
| **M4 三来源齐** | P3-06 完成 | P4-01（上报需三来源数据）、P5-05（商业闭环需完整能力） |
| **M5 口径一致** | P4-05 完成 | P6-05 打包交付（看板数字不一致不得交付） |
| **M6 72 小时长稳** | P6-04 完成 | P6-05 打包（S-1 未达标不得交付） |

**硬阻塞任务（一旦延期直接顶到交付日期）**

1. **P0-01** `legacy/` 搬迁 → 阻塞 P0-03、P2-04、P2-05、P2-06、P3-01、P3-03。旧代码是唯一的抖音 DOM 行为规格来源，缺失意味着每个 DOM 原语都要重新用真账号试错。
2. **P1-01** 契约落地 → 阻塞全部双端实现（契约是语言中立资产，必须先冻结）。
3. **P1-08** 结算与台账 → 阻塞 P2-10、P2-13、P4-03。结算写错直接违反红线 2。
4. **P2-06** `publish-verifier` → 阻塞 P2-09、P2-10、P2-13、P3-02、P3-04。它是 `sent_confirmed` 的唯一出口。
5. **P2-15** 真机验证门 → 阻塞 P3 及之后全部阶段。
6. **P6-04** 72 小时长稳 → 阻塞交付。**必须提前排期**（P2-15 通过后就规划窗口），不要放在最后一周才发现不达标。

---

## P0 准备（5 项 / 4–6 人日）

### P0-01 旧代码移入 `legacy/`
- **前置依赖**：无 ｜ **交付内容**：`legacy/`（含 `legacy/README.md`）、`.gitignore` 补充运行数据忽略规则
- **实现要点**：① 用 `git mv` 移动 `pipeline.js`、`scan_comments.js`、`reply_worker.js`、`comment_worker.js`、`live_dom_collector.js`、`live_dm_worker.js`、`browser_session.js`、`qr_capture.js`、`filter_comments.js`、`filter_full.js`、`reply_server/`、`start.ps1`/`stop.ps1`/`启动.cmd`/`停止.cmd`/`Start-Workbench.cmd`/`Stop-Workbench.cmd`、`scrapling_bridge/`；② 旧的 `*.json` 运行数据（`replies_queue.json`、`replied_history.json`、`live_*.json`、`pipeline_*.json`、`videos.json` 等）移入 `legacy/` 或删除，**不得留在仓库根目录**；③ `legacy/README.md` 写明"**只读行为规格参考，不得被任何生产代码 `require`；每个新 DOM 原语须在此找到对应实现逐条对照，PR 里贴对照行号**"
- **⚠️ 易错点**：不要顺手"清理"`legacy/` 里的 `D:\deep seek\` 硬编码——它是 D-1 的证据，保留原样；`legacy/` 内禁止改逻辑。
- **验收判据**：根目录无 `.js` 业务文件与 `.json` 运行数据；`grep -rn "legacy/" client license-server shared --include=*.js` **0 命中**。
- **自测命令**：`find . -maxdepth 1 -name '*.js' | wc -l`（应为 0）；`grep -rn "legacy/" client license-server shared --include=*.js || echo OK`

### P0-02 建立 `test/fixtures/` 与离线回归骨架
- **前置依赖**：P0-01 ｜ **交付内容**：`test/fixtures/*.html` + `README.md`、`client/test/selector.test.js` 骨架
- **实现要点**：① 命名 `<page>-<场景>.html`，**必须包含"隐藏与可见双 `comment-list`"场景**（`AGENTS.md` §2.10 的误实现靠它拦住），另含 `note-post-panel.html`、`live-danmaku.html`、`profile-dm.html`；② 采集方式：真机打开页面后存 `document.documentElement.outerHTML`，**必须脱敏**（去 `sec_uid`、昵称、评论原文、Cookie）；③ 断言用正则/字符串解析校验选择器命中**且**可见性判据能区分两套结构（不引入 DOM 库）；④ 测试**不需要登录、不需要联网、不碰真账号**（`架构说明.md` §〇）
- **⚠️ 易错点**：不要用线上页面直接当快照而忘记脱敏。
- **验收判据**：断网状态下 `node test/run.js --group selector` 通过；脱敏检查 0 命中。
- **自测命令**：`node test/run.js --group selector`；`grep -rniE 'sec_uid|nickname|avatar_url|cookie' test/fixtures/*.html && echo FAIL || echo OK`

### P0-03 `shared/lib/` 协议常量
- **前置依赖**：P0-01 ｜ **交付内容**：`shared/lib/protocol.js`、`shared/lib/errors.js`、`shared/lib/stable-stringify.js`、`shared/test/*.test.js`
- **实现要点**：① `protocol.js`：`PROTOCOL_VERSION=2`、`protocol.md` §4 全部接口路径常量、枚举闭集（`SOURCE_TYPES`、`VERDICTS`、`CONFIRM_SIGNALS`、`PLATFORM_ENDPOINTS`=`comment/publish|comment/reply|im/send|live/comment/send`、`FAILURE_REASONS` 9 值、`BILLING_STATUS` 5 值）、`TIER_TABLE_SHAPE`（**仅结构校验器，不含任何限额数值**）；② `errors.js` **照抄 `开发规范.md` §2.1**（`STAGES` 8 阶段、`RETRY_CLASS`、`ERROR_CODES`、`WorkbenchError`、`fail()`）；契约错误码只允许照抄 `protocol.md` §3.2，本地归因码小写下划线；③ `stable-stringify.js` **照抄 `开发规范.md` §6.3**（递归 key 升序、无空格、`undefined` 丢弃、不排序数组）；④ 单测覆盖 key 排序、枚举完整性、`fail()` 产出含 `stage`/`reason`
- **⚠️ 易错点**：`stableStringify` **只用于 `login_proof`**；请求/响应签名串是对**原始字节**算 `sha256_hex`，不得反序列化后重新序列化。
- **验收判据**：`--group protocol` 通过；`grep -nE '\b(10|25|30|70|12600|60000|180000)\b' shared/lib/protocol.js` 0 命中；"key 顺序不同的两对象序列化相同"有断言。
- **自测命令**：`node test/run.js --group protocol`；`node -e "const{stableStringify}=require('./shared/lib/stable-stringify');console.log(stableStringify({b:1,a:2})===stableStringify({a:2,b:1}))"`（true）

### P0-04 选择器注册表骨架
- **前置依赖**：P0-01、P0-02 ｜ **交付内容**：`client/platform/selectors.js`（骨架 + 首批条目）、`client/test/selector-registry.test.js`
- **实现要点**：① 每条为结构化对象 `{key, css, purpose, fallbacks[], last_verified_at, confidence, visible_only}`，key 用小写 snake_case（`comment_list`/`reply_button`/`publish_editor`…）；② **从 `legacy/` 逐条提取**：`reply_worker.js`（可见 comment-list、回复按钮、编辑器、Enter 发送）、`live_dom_collector.js`（弹幕容器/节点）、`live_dm_worker.js`（私信入口/输入框）、`pipeline.js`（搜索页、视频卡片）——**每条注释里写来源文件与行号**；③ `last_verified_at` 初始 `null`（表示"来自 legacy、尚未在本项目真机验证"），P2 真机验证后逐条填日期；④ `visible_only: true` 为默认；提供 `resolve(key)` 与 `list_all()`，**不得**在此写任何 DOM 操作逻辑；⑤ 单测断言 key 唯一、格式合法、`confidence ∈ {high,medium,low}`，且每个 fixture 快照至少有一个选择器能命中
- **⚠️ 易错点**：**不要"顺手改进"选择器**——未真机验证的"改进"会让 G-4 无法判定。先原样搬过来。
- **验收判据**：条目数 ≥12 且每条都有指向 `legacy/` 文件与行号的注释；`grep -rn "data-e2e" client --include=*.js` 命中**只出现在 `selectors.js`**。
- **自测命令**：`node --check client/platform/selectors.js`；`grep -rn "data-e2e" client --include=*.js | grep -v "client/platform/selectors.js" || echo OK`

### P0-05 自测入口 `test/run.js`
- **前置依赖**：P0-02、P0-03 ｜ **交付内容**：`test/run.js`、`package.json`（`scripts.test`，`dependencies` 只含 `ws`）
- **实现要点**：① 零依赖运行器：递归发现 `test/**`、`client/test/**`、`license-server/test/**` 的 `*.test.js`，汇总 `PASS/FAIL`，失败非 0 退出；② 支持 `--group <name>`（`selector`/`protocol`/`billing`/`policy`…）与 `--gate`（P2 真机验证门清单）；③ 默认**不发起任何网络请求**，涉及服务端的测试须显式 `--with-server`；④ 内置 group `lint` 三项静态自检：无空 `catch {}`、`data-e2e` 只出现在 `selectors.js`、生产代码不 `require` `legacy/`；⑤ 末尾打印 `SUMMARY {tests, pass, fail, skipped}`
- **⚠️ 易错点**：不要引入 `jest`/`mocha`——白名单只有 `ws`。运行器自己写，控制在 200 行内。
- **验收判据**：`node test/run.js` 退出码 0 且末行有 `SUMMARY`；`--group lint` 三项全绿；`package.json` 的 dependencies 输出 `[ 'ws' ]`。
- **自测命令**：`node test/run.js && node test/run.js --group lint && node -e "console.log(Object.keys(require('./package.json').dependencies))"`

---

## P1 契约与授权中心（10 项 / 12–18 人日）

> **收口验收**：验收标准 **1、2、3、8、19、20**。
> **先决条件**：主文档 §9.2 的 14 项文档冲突**已由技术负责人裁定**，`docs/部署指南-服务端.md` §3.3/§5.4/§7.2、`docs/架构说明.md` §七、`docs/需求规格.md` §四/§六/§七 已按裁定修订。

### P1-01 `shared/protocol.md` 落地为代码
- **前置依赖**：P0-03 ｜ **交付内容**：扩充 `shared/lib/protocol.js`、`shared/lib/validate.js`、`shared/test/protocol-contract.test.js`
- **实现要点**：① 为 §4 每个接口定义请求必填字段表与响应字段表，校验器返回 `{ok, errors:[{field, expect, got}]}`；② 错误码表（§3.2）落地为 `{code:{http, client_action}}`，动作枚举化（`retry`/`no_retry`/`halt`/`relogin`/`backoff`）；③ 闭集校验：`failure_reasons`/`platform_endpoint`/`verdict`/`billing_status`/`source_type` 未知值处理；④ 隐私字段黑名单常量（§7.5 全部字段 + 任何完整 URL）；⑤ 契约测试：§6.6 的 **14 条边界用例**逐条一测（P1-08 完成后全绿）
- **⚠️ 易错点**：不要让校验器"顺手修正"类型（`"30"` → `30`），类型错必须报 `AUTH_INVALID_REQUEST`。
- **验收判据**：`--group protocol-contract` 通过；测试文件中 `case-` 条目数 = 14；含 `reply_text` 的请求体返回 `REPORT_PRIVACY_VIOLATION`。
- **自测命令**：`node test/run.js --group protocol-contract`；`grep -c "case-" test/protocol-contract.test.js`

### P1-02 服务端骨架、配置与 `node:sqlite` 连接
- **前置依赖**：P1-01 ｜ **交付内容**：`license-server/server.js`、`config.js`、`store/db.js`、`.env.example`
- **实现要点**：① 零第三方依赖，HTTP 用内置 `node:http`（**不引 express**）；② 配置从环境变量读取并做类型/必填校验，缺失或非法即**拒绝启动并打印是哪一项**；`HMAC_SECRET` 必须是 64 位 hex；③ `db.js` 模块单例 + 固定 PRAGMA（`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=8000`）并**断言 WAL 生效**，不生效拒绝启动；④ 统一信封：成功 `{ok:true,...}`，失败 `{ok:false, code, message, detail, server_time_ms}`；⑤ 请求体上限 2 MB（超出 `REPORT_TOO_LARGE(413)`）
- **⚠️ 易错点**：`DatabaseSync` 是同步 API，禁止在请求处理里 `new`；禁止在事务内 `await` 网络 I/O（会长时间持写锁）。
- **验收判据**：启动日志含 `listening on 127.0.0.1:18080` 且 WAL 断言通过；缺 `HMAC_SECRET` 时非 0 退出并打印该键名；`/healthz` 返回 `{"ok":true,...}`。
- **自测命令**：`node license-server/server.js & sleep 1; curl -sS http://127.0.0.1:18080/healthz; echo`；`env -u HMAC_SECRET node license-server/server.js; echo "exit=$?"`

### P1-03 数据库 schema 与自动迁移
- **前置依赖**：P1-02 ｜ **交付内容**：`store/migrations/001_init.sql`…、`store/migrate.js`、`cli.js` 的 `db migrate|version|check`
- **实现要点**：① 表：`schema_migration`、`account`、`device_session`、`credit`、`credit_ledger`、`plan`、`redeem_code`、`policy`、`policy_history`、**`policy_ack_log`**、`send_log`、`audit_config_changes`、`usage_report`、`used_nonce`、`seq_counter`、`stats_daily`；② **必须存在的唯一索引**（`开发规范.md` §5.4）：`send_log(account_id,send_id) UNIQUE`、`usage_report(report_id) UNIQUE`、`redeem_code(code_hash) UNIQUE`、`used_nonce(nonce) PRIMARY KEY`、`audit_config_changes(account_id,change_id) UNIQUE`；③ **时间一律整数 Unix 毫秒（`_ms`）、金额一律整数 milli（`_milli`）——禁止 `TEXT` 存时间、禁止 `REAL` 存余额**；④ 迁移：`NNN_<snake_case>.sql`、只增不改、单事务、可重复运行、迁移前自动备份；库版本 > 代码期望 → **拒绝启动**；⑤ `policy_ack_log` 字段照抄 `protocol.md` §4.10
- **⚠️ 易错点**：`docs/部署指南-服务端.md` §5.4 的 `audit_event(occurred_at TEXT, credit_delta REAL)` 是 **v1 遗留结构，不要照抄**（主文档 §9.2 冲突 #13）。
- **验收判据**：`db check` 输出 `integrity_check: ok` + `foreign_key_check: ok`；`send_log` 无 `REAL` 列；手工改大 `schema_migration.version` 后启动被拒且日志含 `schema newer than code`。
- **自测命令**：`node license-server/cli.js db migrate && node license-server/cli.js db version && node license-server/cli.js db check`

### P1-04 登录、密码哈希、`login_proof`
- **前置依赖**：P1-03 ｜ **交付内容**：`domain/auth.js`、`crypto/{password,sign}.js`、`api/auth.js`、`POST /api/v1/auth/login`
- **实现要点**：① `scrypt(N=16384,r=8,p=1,keylen=32,salt=16B)` 存 `scrypt$N$r$p$salt_hex$hash_hex`，比较用 `timingSafeEqual`（**先比长度**）；② 失败按**账号维度**计数，累计 5 次 → 锁 10 分钟，返回 `AUTH_ACCOUNT_LOCKED(423)` + `retry_after_ms`，成功清零；③ 错误码区分 `AUTH_ACCOUNT_NOT_FOUND`/`AUTH_PASSWORD_WRONG`(带 `remaining_attempts`)/`AUTH_ACCOUNT_DISABLED`/`AUTH_ACCOUNT_EXPIRED`；④ **`login_proof`**：`login_key=pbkdf2Sync(password,'dsh-login|'+account+'|'+device_id,100000,32,'sha256')`，覆盖范围 = 响应体去掉 `login_proof` 自身后 `stableStringify` 再 `hmacHex`；⑤ 登录**不签名**，响应含 `token`(32B hex，服务端只存 `sha256`)、`token_expires_ms`、`sign_key`、`sign_key_expires_ms`、`privacy_salt`、`account`、`credit`、`policy`、`quota_notice`、`limits`、`min_client_version`；⑥ 固定加 200–500ms 随机延迟，按 IP 限流 10 次/分钟；⑦ **不提供注册接口**
- **⚠️ 易错点**：`login_proof` 覆盖范围**必须排除自身**，否则永远验不过；`sign_key` 服务端只存 `key_epoch` 与 `sign_key_sha256`，**不得存明文、不得写日志**。
- **验收判据**：验收标准 1 通过（无注册入口）；连续 5 次错误后第 6 次返回 `AUTH_ACCOUNT_LOCKED` + `retry_after_ms`；客户端复算 `login_proof` 成功、改一位字段后失败。
- **自测命令**：`node test/run.js --group auth`；`curl -sS -X POST http://127.0.0.1:18080/api/v1/auth/login -H 'Content-Type: application/json' -d '{"account":"demo001","password":"wrong","device_id":"9f2c8a1d4e6b70c35a1f8d2e4b6c0a93","install_id":"uuid-v4","client_version":"3.0.0","protocol_version":2}'`

### P1-05 会话、续期、设备数上限
- **前置依赖**：P1-04 ｜ **交付内容**：`POST /auth/refresh`、`POST /auth/logout`、`GET /auth/me`、`domain/session.js`
- **实现要点**：① token TTL 7 天；续期窗口 30 天；轮换后旧 token 在 `token_overlap_ms=300000` 内仍可鉴权；② 续期**幂等**：同一旧 token 并发 refresh 返回同一个新 token；③ 设备数默认 1，登录时踢掉**最早创建**的会话并返回 `kicked_device_id`，被踢方返回 `AUTH_TOKEN_REVOKED`；异常仍无法落位 → `AUTH_DEVICE_LIMIT(409)`；④ 失效条件（§2.1）：登出、被踢、停用、到期、**余额耗尽停机**、密码重置；⑤ `logout` 幂等
- **⚠️ 易错点**：被踢客户端**不得自动踢回**（避免活锁），须商家手工重新登录——不要实现"最后登录者胜"。
- **验收判据**：同账号第二台设备登录后第一台返回 `AUTH_TOKEN_REVOKED` 且有 `kicked_device_id`；并发 10 次 refresh 只产生 1 个新 token；重复 logout 第二次 `revoked_session_count=0`。
- **自测命令**：`node test/run.js --group session`

### P1-06 HMAC 签名与防重放
- **前置依赖**：P1-04 ｜ **交付内容**：`crypto/sign.js`、签名/验签中间件、`test/sign.test.js`
- **实现要点**：① 请求签名串**精确拼接**（§5.1）：`METHOD\nPATH_WITH_QUERY\nString(ts_ms)\nnonce\nsha256_hex(raw_body_bytes)`，对**原始字节**算哈希；② 响应签名串（§5.2）：`"RESP"\nString(http_status)\nPATH_WITH_QUERY\nrequest_nonce\nString(server_time_ms)\nsha256_hex(raw_body_bytes)`，头 `X-Lic-Server-Ts`/`X-Lic-Sign`；③ **错误响应（402/409/4xx/5xx）也必须签名**；④ 时间戳容忍 ±300000ms，超出 `AUTH_TS_SKEW(401)`；`used_nonce(nonce PRIMARY KEY)` TTL 600000ms，重复 `AUTH_REPLAY(401)`；⑤ `seq` 按 `(account_id,device_id,session_id,channel)` 记 `max_seq`，`channel ∈ heartbeat/usage/sends/config_audit` **各通道独立计数**，新 `session_id` 允许从 1 重开；⑥ 密钥轮换按 `next`→`current`→`prev` 尝试，重叠 10 分钟，三把都不匹配 `AUTH_SIGN_KEY_UNKNOWN`；⑦ 除 `POST /auth/login` 与 `GET /client/bootstrap` 外**全部强制签名**
- **⚠️ 易错点**：签名对原始字节计算——反代压缩或改写响应体（`sub_filter`）会破坏签名；`/audit/sends` 与 `/usage/report` **每次请求必须新 nonce**（§5.4）。
- **验收判据**：`--group sign` 通过；重放同一 nonce 第二次返回 `AUTH_REPLAY`；偏移 6 分钟返回 `AUTH_TS_SKEW`；对 402 响应客户端验签通过。
- **自测命令**：`node test/run.js --group sign`

### P1-07 `tier_table`、策略下发与 ack
- **前置依赖**：P1-05、P1-06 ｜ **交付内容**：`domain/policy.js`（**唯一来源**）、`POST /heartbeat` 骨架、`GET /policy/current`、`test/policy.test.js`
- **实现要点**：① `tier_table` 四级照抄 §4.6：`observation` 1–3（全 0）、`warm_up` 4–7（评论 10/弹幕 10/私信 3）、`ramp_up` 8–14（25/25/8）、`stable` 15+（30/30/10）；`min_interval_ms_range` comment `[60000,180000]`、live_danmaku `[30000,90000]`、dm `[300000,900000]`；② `account_day_index = floor((今日 00:00(UTC+8) − 首次成功登录日 00:00(UTC+8)) / 86400000) + 1`；③ 派生量**全部由本表实时推导**：`stable_daily_max_total`(70)、`daily_cap_total_by_tier`(0/23/58/70)、`plan.credits=ceil(total×valid_days×ratio)`、`min_plan_credit=ceil(total×180×ratio)`(12600)、`quota_notice` 全部数字；④ `quota_notice` 在 `daily_cap_total=0` 时必须用观察期文案（headline `"当前处于观察期，仅采集线索，第 4 天开始可发送"`），含 `generated_from_policy_version`；⑤ **"只能更保守"四方向**：`daily_max` 只能调低、`min_interval_ms` 只能调高**且落在 range 内**、`content_similarity_max` 只能调低、`active_hours` 只能调短（不得新增窗口）；任一更激进 → `POLICY_VIOLATION(409)`，`detail` 带 `source_type/field/reported/allowed/policy_version`；⑥ `policy_ack_log` 在首次心跳 ack 写入；`POLICY_VERSION_UNKNOWN(409)` 与 `POLICY_ACK_REQUIRED(409)` 分文别类处理
- **⚠️ 易错点**：**`tier_table` 之外任何地方出现 0/10/25/30/70/12600 的硬编码都是缺陷**（红线 1）。改表后套餐积分、`min_plan_credit`、文案、`daily_cap_total_by_tier`、看板日上限必须同时自动变化。
- **验收判据**：验收标准 14 通过（改成 999 → `POLICY_VIOLATION` 且**记入审计**）；临时把 stable 评论上限改为 20 后，`plan.credits`/`min_plan_credit`/`quota_notice.detail` 数字**同时**变化（自动化断言）；`GET /policy/current` 结构与 §4.6 示例逐字段一致。
- **自测命令**：`node test/run.js --group policy`

### P1-08 积分、结算与台账（**红线 2 的核心**）
- **前置依赖**：P1-07 ｜ **交付内容**：`domain/billing.js`、`POST /api/v1/audit/sends`、`GET /credit/balance`、`GET /credit/ledger`、`test/billing.test.js`
- **实现要点**：① 逐条结算顺序**照抄 §6.4 伪代码**：幂等/冲突判定 → 策略存证 → 当日额度 → 计费资格 → 明细落库 → 扣费+台账 → 出结果；批内严格按 `sent_at_ms` 升序；② **计费资格五条同时成立**：`verdict='sent_confirmed'` ∧ `confirm_signal='platform_response'` ∧ `platform_status_code===0` ∧ 未超当日策略上限 ∧ 该 `send_id` 未计费过；③ **明细永远留痕**（审计优先于计费），不计费条目也写 `send_log`；④ 幂等：唯一索引 `(account_id,send_id)`，重复上报回放首次结果；**不得**按"内容相同/目标相同/时间相近"二次去重；⑤ 判定升级：`sent_suspected`/`sent_confirmed_dom`/`failed` → `sent_confirmed` + 平台证据 = 接受升级并**只计费一次**；降级或 `source_type`/`sent_at_ms` 不一致 → `AUDIT_SEND_CONFLICT(409)` 整条拒绝并保留首次记录；⑥ **余额不足 = 部分扣费**（§6.5）：升序扣到耗尽，**跨越零点的那一条全额入账**（最多透支一条单价），其后全部 `unbilled_insufficient_credit`，**不扣费、充值后不补扣**；⑦ `BEGIN IMMEDIATE` + `try/catch/ROLLBACK/throw`，**余额扣减、`send_log`、`credit_ledger` 同一事务**；⑧ 余额 ≤ 0 → 仍返回 200 + `settlement.state='exhausted'` + `commands:[pause_engine]`；⑨ `credit_ledger` **只增不改**；`credit_per_reply` 变更只对 `effective_ms` 之后生效，历史不回溯
- **⚠️ 易错点**：`docs/架构说明.md` §七 与 `docs/部署指南-服务端.md` §11.4 的"按小时计费/`online_seconds` 计费"口径**已作废**——心跳与时长**永不**换算成积分（§6.1）。
- **验收判据**：§6.6 的 **14 条边界用例**全部有测试且通过；验收标准 **19**（风控拒绝不扣费、台账无该笔）与 **20**（同 `send_id` 重复上报 10 次只扣 1 条）通过；`confirm_signal='dom_stable'` → `not_billable`；`platform_status_code=1` 但标 `sent_confirmed` → `not_billable` + `audit_flag:"evidence_invalid"`。
- **自测命令**：`node test/run.js --group billing && node test/run.js --group protocol-contract`

### P1-09 心跳、额度、`commands` 与离线降级
- **前置依赖**：P1-08 ｜ **交付内容**：完整 `POST /heartbeat`、`GET /client/bootstrap`、`domain/quota.js`
- **实现要点**：① 心跳响应含 `ack_seq`、`state`、`credit`、`policy`（变更时）、`policy_changed`、`policy_ack_required`、`daily_quota`（三渠道 `max/used/remaining`）、`circuit_breaker`、`commands[]`、`next_heartbeat_after_ms`、`sign_key_next`；② **同一 `seq` 重复提交幂等**：返回与首次相同响应体（缓存 10 分钟），不推进状态、不判重放；仅 `seq < max_seq` 且不在缓存内才判 `AUTH_REPLAY`；③ 心跳间隔 <30 秒 → `RATE_TOO_MANY_REQUESTS` 并忽略；④ 余额 ≤ 0 → **HTTP 402 + `CREDIT_EXHAUSTED`**（标准信封，**带签名**）；⑤ `commands[]`：`pause_engine`/`resume_engine`/`throttle`/`circuit_break`/`reload_policy`/`force_upgrade`；⑥ `bootstrap`（**不签名**）校验 `force_upgrade` 与 `client_version < min_client_version` → 必须停机展示升级页；`maintenance.active` → 离线降级；⑦ `state` 五值 `active/degraded/idle/exhausted/suspended`；连续零命中 `idle_pause_ms=7200000` 进 `idle`（**运营策略，与计费无关**）
- **⚠️ 易错点**：`bootstrap` 与 `login` **不签名**——客户端此时还没有 `sign_key`，不要图省事让它也验签。
- **验收判据**：验收标准 3（余额归零后 1 分钟内进入暂停态）通过；同 `seq` 心跳重发两次响应体完全相同且 `used` 未推进；抬高 `min_client_version` 后旧客户端收到 426 + `upgrade_url`。
- **自测命令**：`node test/run.js --group heartbeat`

### P1-10 充值码、套餐与健康检查
- **前置依赖**：P1-08 ｜ **交付内容**：`domain/redeem.js`、`POST /credit/redeem`、`GET /account/plan`、`/healthz`、`/readyz`、`/version`
- **实现要点**：① 兑换**原子**：`BEGIN IMMEDIATE` + `redeem_code(code_hash) UNIQUE`，并发只有一个成功，另一个 `CREDIT_REDEEM_CODE_USED(409)`（带 `used_at_ms`）；② 服务端**只存卡密哈希**；`code` 大小写不敏感；`request_id` + 唯一索引**双重幂等**，重复兑换 `CREDIT_REDEEM_ALREADY_DONE(200)` 并回放首次结果；③ 错误码区分 `_INVALID(404)`/`_USED(409)`/`_EXPIRED(410)`/`_DISABLED(403)`；④ `GET /account/plan` 的**所有数值由 `tier_table` + `credit_per_reply` 实时推导**，`plan.credits < min_plan_credit` → `PLAN_QUOTA_BELOW_MIN(400)`；⑤ `hours` 字段**恒返回 `null`**；⑥ `price_cents` 为占位 `0` + `price_is_placeholder:true`，**不得作为定价依据**；⑦ 健康检查**不放在 `/api/v1/` 下**（避免被鉴权/限流中间件拦）；⑧ 默认套餐半年 `valid_days=180`/`credits=12600`、年 `365`/`25550`
- **⚠️ 易错点**：`docs/部署指南-服务端.md` §7.2 的 `plan set --credits 4500` 会直接触发 `PLAN_QUOTA_BELOW_MIN`（<12600），**不要照抄**（主文档 §9.2 冲突 #5）。
- **验收判据**：验收标准 2 通过；并发 20 次兑换同一码恰好 1 次成功（断言 `success===1 && used===19`）；`tier_table` 变更后 `plan.credits` 自动变化；`/healthz` 与 `/readyz` 均 200。
- **自测命令**：`node test/run.js --group redeem && curl -sS http://127.0.0.1:18080/readyz; echo`

---

## P2 客户端底座 + 评论区自动回复（15 项 / 25–40 人日）

> **收口验收**：验收标准 **4、5、6、9、11、13、14、15、17、18**。🔴 **结束必须执行 P2-15 真机验证门，未通过不得进入 P3。**

### P2-01 客户端进程骨架与 IPC
- **前置依赖**：P0-05、P1-09 ｜ **交付内容**：`client/host/main.js`、`host/api.js`、`core/ipc.js`、`host/instances.js`、`客户端启动.cmd`/`停止.cmd`
- **实现要点**：① `main.js` 顶层兜底三层（`uncaughtException`/`unhandledRejection`/`main_loop` try-catch）：捕获 → 归因 → **任务回退 `queued`** → 继续，**禁止 `process.exit(1)`**；② `api.js` 绑 `127.0.0.1`（**非 `0.0.0.0`**）+ 会话令牌 + CORS 白名单（回显具体来源，**绝不写 `*`**），启动时断言是回环地址否则抛错；③ `ipc.js` 只有 `request(op, params)` 与 `event(name, payload)`；超时与取消句柄由调度器持有（消灭 D-10"无法停止"）；④ Node ≥22.5 自检 + `ws` 依赖自检，缺失时**明确提示而非崩溃**；⑤ `instances.js`：`9222+N` 端口**启动前探测占用**，冲突顺延并记录实际端口；⑥ 路径全部经 `REPLY_WORKSPACE`/`path.join` 解析
- **⚠️ 易错点**：不要用 `child_process.spawn` 起 6 个脚本（旧代码形态）；`browser-host` 每实例**一个**，句柄由调度器持有。
- **验收判据**：监听地址为 `127.0.0.1`；非白名单来源的 CORS 预检返回 403 且不回显 `*`（修复 D-6）；`grep -rn "0\.0\.0\.0" client --include=*.js` 0 命中；故意抛顶层异常后进程**仍存活**且任务回退 `queued`。
- **自测命令**：`grep -rn "0\.0\.0\.0" client --include=*.js || echo OK`；`netstat -ano | findstr :18081`

### P2-02 `client/core/cdp.js`（唯一一份 CDP 客户端）
- **前置依赖**：P2-01 ｜ **交付内容**：`core/cdp.js`、`client/test/cdp.test.js`（本地假 WS 服务端）
- **实现要点**：① 基于 `ws`：命令 `id` 自增、响应按 `id` 配对、事件按 `method` 分发；② 超时：CDP 命令 **8–10 秒**（`Page.navigate` 30 秒），超时 reject 并带 `stage`/`reason`；③ 断线重连指数退避 `1s/2s/4s/8s…` 上限 60 秒，**加 ±20% 抖动**（避免多实例同时重试成尖峰）；④ 重连成功后**必须重新 `Runtime.enable`/`Network.enable`/`Page.enable`**；⑤ **本文件不得出现任何抖音知识**（无 `data-e2e`、无 `comment-list`、无 `comment/publish`）；⑥ 全项目只有这一处 `new WebSocket(...)`
- **⚠️ 易错点**：忘记重连后重新 `enable` → `Network` 嗅探静默失效，表现为"发送成功但拿不到响应体"，最终把成功判成 `sent_suspected`。
- **验收判据**：`--group cdp` 通过（超时、重连、命令配对三组断言）；`grep -rn "new WebSocket" client --include=*.js` 只命中 `core/cdp.js`；`grep -rn "data-e2e\|comment-list" client/core/` 0 命中。
- **自测命令**：`node test/run.js --group cdp && grep -rn "new WebSocket" client --include=*.js`

### P2-03 `client/core/browser-host.js`（独占 WS）
- **前置依赖**：P2-02 ｜ **交付内容**：`core/browser-host.js`、`core/launcher.js`
- **实现要点**：① 每实例**独占一条** CDP WebSocket，其余模块经 IPC 请求，**不得**自建连接；② 启动：探测 `9222+N` → 拉起专用 Chrome（`--user-data-dir=instances/<id>/chrome-profile`、`--remote-debugging-port=9222+N`、`--disable-blink-features=AutomationControlled`）→ `GET /json/version` 取 `webSocketDebuggerUrl`；③ 维护 `targetId → 业务角色`（`comment`/`live`/`profile`）映射，每次操作前做**存活检查**（`Target.getTargets` 里还在且 `attached`）；④ 失效处理：标签页被关/Chrome 重启 → **重建标签页并把任务退回 `queued` 而非 `failed`**（S-2 自愈率 ≥95% 的关键）；⑤ 搜索页**必须用新标签页**（旧代码经验：长期复用的搜索标签会退化）；⑥ 高层 API：`open_page`/`eval_expr`/`wait_for`/`click_at`/`type_text`/`press_key`/`sniff_response`
- **⚠️ 易错点**：`eval_expr` 的表达式**必须来自 `platform/`**，不得内联选择器；不要假设标签页顺序稳定。
- **验收判据**：标签页存活检查有单测（模拟 target 消失 → 任务回 `queued`）；Chrome 命令行含 `--user-data-dir=.../chrome-profile`；重启 Chrome 后 30 秒内自动恢复且有日志。
- **自测命令**：`node test/run.js --group browser-host`

### P2-04 `platform/selectors.js` 第二轮：真机校正
- **前置依赖**：P0-04、P2-03 ｜ **交付内容**：更新后的 `selectors.js`（填 `last_verified_at`）、新增真机快照
- **实现要点**：① 逐条与 `legacy/` 对照（PR 贴对照行号）：可见 comment-list 判定、回复按钮、编辑器、`feed-comment-icon`、弹幕容器、私信入口；② `last_verified_at` 填**真机验证当天日期**，未验证的保持 `null`；③ 关键知识落地成"选择器 + 可见性判据"两部分：`visible_only` 元素解析走"非零尺寸 + 在视口内 + `display!=none` + `visibility!=hidden`"；④ 新增脱敏快照进 `test/fixtures/`；⑤ 提供 `resolve(key)` 返回 `{css, fallbacks, visible_only}`
- **⚠️ 易错点**：`AGENTS.md` §2.10——`document.querySelector('[data-e2e="comment-list"]')` 直接取第一个是**错的**（隐藏的那套里按钮尺寸为 0）。
- **验收判据**：`last_verified_at` 要么是真实日期、要么显式 `null`（不允许填虚假日期）；`--group selector` 全绿；真机上 `resolve('comment_list')` 返回**可见**容器（日志 `offsetWidth>0`）。
- **自测命令**：`node test/run.js --group selector`

### P2-05 评论区页面模型 `page-comment.js`
- **前置依赖**：P2-03、P2-04 ｜ **交付内容**：`platform/page-comment.js`、`client/test/page-comment.test.js`
- **实现要点**：① 只暴露**语义动作**、不暴露选择器字符串：`open`/`is_note_post`/`expand_panel`/`wait_panel_visible`/`scroll_to_comment`/`read_reply_button_rect`/`activate_editor`/`type_text`/`submit_by_enter`；② **重定向与帖型**：`/video/<id>` 会重定向到 `/jingxuan?modal_id=...`；`/note/<id>` 是图文帖 → **直接抛 `NOTE_POST_UNSUPPORTED`**（标记 `skipped(note_post_panel_unsupported)`，不刷失败）；③ 评论区必须等到**真正可见**（容器 `display` 由 `none` 变可见）才能操作；图文帖需先点 `feed-comment-icon` 展开浮层；④ ⚠️ **`scrollIntoView` 之后虚拟列表会重渲染，必须延迟再读按钮坐标**，否则拿到 `0×0`：实现为"读矩形 → 校验 `width>0 && height>0` → 不满足等 300–500ms 重读，最多 5 轮"，失败抛 `ELEMENT_ZERO_SIZE`；⑤ 每个动作产出 `StepResult{ok, stage, reason}`，失败时 `reason` **必须带选择器 key**（`selector_miss:comment_list`，S-4 的唯一线索）
- **⚠️ 易错点**：把"读不到坐标"当"元素不存在"→ 直接判 `failed` 而非重试，成功率虚低。
- **验收判据**：`--group page-comment` 全绿（含"双 comment-list 快照下选可见的那个"与"0×0 触发重读"两个断言）；`note` 帖返回 `NOTE_POST_UNSUPPORTED` 而非 `ELEMENT_TIMEOUT`。
- **自测命令**：`node test/run.js --group page-comment`

### P2-06 `platform/publish-verifier.js`（发送成功判定）
- **前置依赖**：P2-03、P2-05 ｜ **交付内容**：`platform/publish-verifier.js`、`client/test/publish-verifier.test.js`
- **实现要点**：① 通过 `Network` 域监听平台响应，匹配白名单 endpoint：`comment/publish`、`comment/reply`、`im/send`、`live/comment/send`；② `sent_confirmed` 的**唯一条件**：拿到响应体 ∧ `status_code===0` ∧ `confirm_signal='platform_response'`；③ **空响应/无响应** → `verdict='failed'` + `evidence.risk_control_signal='empty_response'` + `failure_reason='risk_control_rejected'`，`platform_reject_count += 1`；④ **编辑器消失但无响应** → `verdict='sent_suspected'`、`is_final=false`，**绝不是 `sent_confirmed`**；⑤ 回复节点稳定 ≥3000ms（连续 3 次 1 秒轮询仍在且文本一致）→ `sent_confirmed_dom` + `confirm_signal='dom_stable'`（**不可用于计费**）；⑥ 暴露 `wait_for_platform_response({timeout_ms:10000})`，**超时不重试**（判 `PUBLISH_NOT_CAPTURED`）；⑦ 本文件是 `sent_confirmed` 的**唯一出口**
- **⚠️ 易错点**：**这是红线 2 的落地文件**。`AGENTS.md` §2.1 的误实现（编辑器消失即成功）就靠它拦住。
- **验收判据**：单测覆盖四种判定（`status_code=0`→`sent_confirmed`；空响应→`failed`+`empty_response`；编辑器消失→`sent_suspected`；节点稳定 3 秒→`sent_confirmed_dom`）；`grep -rn "sent_confirmed" client --include=*.js | grep -v publish-verifier | grep -v test` 0 命中。
- **自测命令**：`node test/run.js --group publish-verifier && grep -rn "sent_confirmed" client --include=*.js | grep -v publish-verifier | grep -v test || echo OK`

### P2-07 `client/safety/` 护栏四件套
- **前置依赖**：P2-01、P1-07 ｜ **交付内容**：`safety/guard.js`、`safety/similarity.js`、`safety/circuit.js`、`safety/audit.js`、`client/test/safety.test.js`
- **实现要点**：① `guard.js`：日上限（按 `stats_tz_offset_minutes=480` 切自然日）、最小间隔（**对数正态分布**随机化，非固定值）、活跃时段（默认 `08:00–23:00` 单一窗口、只能调短）、单用户冷却（同 `user_key_hash` 默认 24 小时只回一次）、**观察期禁发**（`sending_enabled=false` → 直接返回 `POLICY_SENDING_DISABLED` 且**不生成 `send_id`**）、**急停**（原子标志位 + 每个步骤入口检查）；② `similarity.js`：SimHash，**相似度 > `content_similarity_max` 即拒绝**（comment/live_danmaku 0.85，dm 0.75），拒绝 → `failure_reason='content_rejected'`；③ `circuit.js`：三级递进 **30 分钟 → 1 小时 → 停到次日 00:00(UTC+8)**，触发源为验证码/滑块、连续失败、`platform_reject_count ≥ 3`、失败率 > `failure_rate_threshold=0.4`（窗口 20）；服务端 `cooldown_ms=1800000` 对应 L1、`risk_code_cooldown_ms=86400000` 对应 L3，**本地递进级别与服务端 `cooldown_until_ms` 取较长者**（服务端是权威下限）；④ `audit.js`：本地审计落盘（发送明细 + 配置变更），先落本地再进上报队列，含 `applied_policy_version` 与 `applied_limits`；⑤ 所有**数值一律从 `policy` 读**，文件内**不得出现任何限额字面量**
- **⚠️ 易错点**：相似度方向写反是灾难性缺陷（`AGENTS.md` §2.4）；固定间隔发送是最容易被识别的机器人特征（§2.11）。
- **验收判据**：验收标准 **5、6、13、15、17、18** 全部通过；`grep -nE '\b(10|25|30|70|60000|180000)\b' client/safety/*.js` 0 命中。
- **自测命令**：`node test/run.js --group safety && grep -nE '\b(10|25|30|70|60000|180000)\b' client/safety/*.js || echo OK`

### P2-08 `client/license/` 客户端授权
- **前置依赖**：P1-04~P1-06、P2-01 ｜ **交付内容**：`license/auth.js`、`license/sign.js`、`license/heartbeat.js`、`license/reporter.js`、`client/test/license.test.js`
- **实现要点**：① `auth.js`：`device_id`（16 字节 hex）+ `install_id`（uuid v4）持久化；`bootstrap` → `login` → **`login_proof` 验签**（失败则拒绝登录且**不落盘任何凭据**）→ 原子落盘凭据 + `clock_skew_ms` → 立即 `refresh` 静默续期；② `sign.js`：请求签名 + **响应验签**（**错误响应 402/409/4xx/5xx 也必须验签**）；验签失败 → **fail-closed 立即暂停发送** + 清密钥 + 重新登录；比较用 `timingSafeEqual` 且**先比长度**；③ `heartbeat.js`：60 秒心跳，带 `applied_policy_version`/`applied_policy_hash`/`applied_limits`/`daily_used`/`pending_send_count`/`instances[]`；`policy_changed=true` → **60 秒内**整体替换（不字段合并）并在**下一次心跳** ack；`commands` 的 `pause_engine`/`circuit_break` **60 秒内**执行；④ `reporter.js`：明细（5 分钟或满 50 条）与聚合（30 分钟）上报，每次请求**新 nonce**；离线囤 `pending_sends.json`（上限 `max_pending_sends=20000`，超出**丢最旧并告警**），恢复后按 `sent_at_ms` 升序单批补报（≤ `audit_batch_max=500`）；⑤ **影子额度**：`local_budget=floor(last_known_balance_milli/credit_per_reply_milli)×0.5`，**只减不增**；离线超 `offline_send_grace_ms=900000` 进 `degraded`，仍严守当日策略上限；耗尽立即暂停；断网超 `grace_ms=86400000` 进暂停态；⑥ `clock_skew_ms` 用 `server_time_ms` 校准（仅用于填上报字段），**时长一律用 `process.hrtime.bigint()`**
- **⚠️ 易错点**：验签失败时"认为余额充足、认为策略放宽"是最危险的误实现（§2.3）；`AUTH_TS_SKEW` **只允许重试一次**。
- **验收判据**：验收标准 **8**（改本地 JSON 余额为 9999，重启后仍显示服务端真实余额）通过；断网暂停且不扣积分（单测 + 联调）；验签失败的响应被拒绝且客户端进入暂停态（单测）；离线 3 小时补报 12 条按升序单批（断言请求体顺序）。
- **自测命令**：`node test/run.js --group license`

### P2-09 `adapters/collect.js`（评论区采集 + 规则引擎）
- **前置依赖**：P2-05、P2-07、P2-08 ｜ **交付内容**：`adapters/collect.js`、`client/rules.js`
- **实现要点**：① 去重键 `(account_id,'comment',video_id,comment_id)`；**`comment_id` 缺失则不计入 `hits`**（宁可少算不可多算）；② 命中判定按 FR-2.2：**自动回复场景用「整词包含」匹配**（区别于旧 pipeline 的"任意字命中"），界面**显式提示这一差异**；③ 模板变量 `{昵称}`/`{关键词}`/`{商品名}`/`{随机1-9}`/`{日期}`，**多条随机**且取过的进短期黑名单避免对同一用户重复同一句；④ 规则保存时校验模板池**至少 5 条变体**，变量填充须自然（禁止 `{随机1-9}` 产出 `"1"`/`"2"`）；⑤ 兜底：**未命中任何规则时不回复**（不做万能回复），记为 `skipped` 并进看板；⑥ `lead_key=sha256(account_id+'|'+source+'|'+biz_key)`，二次出现只计 `hits`，约束 `leads_new ≤ hits`；⑦ `guard.js` 在**入队前**检查，观察期不进队、不生成 `send_id`
- **⚠️ 易错点**：`dailyLimit` **不得**用数组 `slice` 截断线索（D-3：超限线索被静默丢弃）——应留待次日或明确标记 `skipped`。
- **验收判据**：同一规则连续 10 次渲染至少出现 3 种不同文案；`leads_new ≤ hits` 有断言；模板池 <5 条时保存被拒并给出明确错误。
- **自测命令**：`node test/run.js --group rules`

### P2-10 `adapters/reply-comment.js`（发送链路串联）
- **前置依赖**：P2-05~P2-07、P2-09 ｜ **交付内容**：`adapters/reply-comment.js`、`client/test/reply-comment.test.js`
- **实现要点**：① **强制顺序**（`开发规范.md` §6.4）：生成 `send_id` 并**原子落盘** `pending_sends.json`（`fsync` 后 rename）→ `guard.assert_can_send('comment')` 二次校验额度 → 才真正发起发送；② 按主文档 §4.7 的 15 步链路执行，每步 `step(STAGES.X, fn)` 记录阶段轨迹，失败日志输出 `{task_id, source_type, stage, reason, steps}`；③ 各步超时/重试严格按 §4.7 表（元素等待总预算 30 秒、平台响应等待 10 秒且**不重试**）；④ 命中相似度闸门 → 拒绝发送并提示补充文案；⑤ 判定结果回写同一条 `send_id` 记录，等上报 ACK 后才删除
- **⚠️ 易错点**：**`send_id` 必须在发送前落盘**（`AGENTS.md` §2.7）——发送成功后再生成 ID，崩溃或断网后无法幂等，会重复发送、重复计费。
- **验收判据**：单测断言"落盘先于发送调用"（mock 记录调用顺序）；发送中途杀进程重启后**不会重复发送同一条**（`send_id` 复用、`attempt_seq += 1`）。
- **自测命令**：`node test/run.js --group reply-comment`

### P2-11 `client/host/store.js`（单写者 + 原子写）
- **前置依赖**：P2-01 ｜ **交付内容**：`host/store.js`、`client/test/store.test.js`
- **实现要点**：① 唯一写入口 `load()`/`update()`，`mutator` 必须是**纯函数**；`update` 永远以**最新内存态**为基准，**绝不用陈旧对象全量覆写**（照抄 `开发规范.md` §4.1/§4.2）；② 原子写 `.tmp-<pid>` → `fsyncSync` → `renameSync`（**必须先 fsync 再 rename**，否则断电可能得到空文件）；③ 同文件写入**串行化**（Promise 链），失败不阻断后续；④ 损坏处理：`JSON.parse` 失败 → **备份现场**（`.corrupt-<ts>`）后报 `DISK_WRITE_FAILED`，**绝不静默当空文件**；⑤ `schema_version` 每个文件头必带，`> 代码支持版本` → **报错停机**，迁移链每步纯函数、禁止访问网络；⑥ `SCHEMA_VERSION` 覆盖 `license_state.json`(1)、`policy.json`(1)、`pending_sends.json`(2)、`reply_queue.json`(2)、`replied_history.json`(1)、`leads.json`(1)；⑦ **`sending` 态回退 `queued` 时保留原 `send_id` 与 `attempt_seq`**（`attempt_seq += 1`），**绝不重新生成 `send_id`**
- **⚠️ 易错点**：这是 D-7 的正解。`browser-host`/`platform`/`adapters`/`license`/UI **一律不得** `require('node:fs')` 去碰实例数据文件。
- **验收判据**：`grep -rn "writeFileSync" client --include=*.js | grep -v "client/host/store.js"` 0 命中；并发 100 次 `update` 同一文件后数据无丢失（断言最终数组长度 = 100）；模拟损坏后 `.corrupt-*` 备份存在。
- **自测命令**：`node test/run.js --group store && grep -rn "writeFileSync" client --include=*.js | grep -v "client/host/store.js" || echo OK`

### P2-12 `client/host/scheduler.js`（调度与幂等）
- **前置依赖**：P2-07、P2-10、P2-11 ｜ **交付内容**：`host/scheduler.js`、`client/test/scheduler.test.js`
- **实现要点**：① 任务状态机 `queued → sending → sent|failed|skipped`，**持有全部子句柄**可取消（消灭 D-10）；② **幂等**：已在跑的任务重复触发 → 拒绝并提示，**不得静默杀掉前一次**（消灭 D-13）；③ 前置检查顺序：急停 → 观察期 `sending_enabled` → 余额/影子额度 → 熔断 → 活跃时段 → 日上限 → 最小间隔，拒绝时记明确 `reason`；④ 进程启动时把 `sending` 态回退 `queued`（复用原 `send_id`），内存态 + 心跳超时自动归位（消灭 D-11）；⑤ 单实例异常**不阻塞**其他实例调度；只有全部实例停才把整机 `engine_state` 记为 `stopped`
- **⚠️ 易错点**：进度不能只在阶段边界写（D-11 的成因）；启动时回退必须复用崩溃前的 `send_id`。
- **验收判据**：连续两次点击"开始"第二次被拒且**第一次仍在跑**；强杀进程重启后 `running:true` 被复位；`engine_state` 与实例状态聚合关系有断言。
- **自测命令**：`node test/run.js --group scheduler`

### P2-13 单实例端到端闭环（离线可测部分）
- **前置依赖**：P2-08~P2-12、P1-08 ｜ **交付内容**：`adapters/` 与 `host/` 接线、`test/e2e-offline.test.js`
- **实现要点**：① 用**本地假 CDP 服务端**（回放 fixtures）跑通：采集 → 命中 → 过滤 → 入队 → 发送 → 判定 → 落盘 → 上报 → 结算；② 报表端用**真实 `license-server` 本地实例**（`127.0.0.1:18080`），验证真实签名与真实结算（`--with-server`）；③ 覆盖三条关键路径：成功（`sent_confirmed`→`billed`）、风控拒绝（`failed`→`not_billable`）、超上限（`policy_exceeded`）；④ 覆盖崩溃恢复：发送中途 `kill` → 重启 → 断言不重复发送、`send_id` 一致；⑤ 覆盖观察期：`account_day_index=2` → 断言**不生成任何 `send_id`**
- **⚠️ 易错点**：端到端测试**不得**连真实抖音（会消耗测试账号）；真实抖音验证属 P2-15。
- **验收判据**：`node test/run.js --group e2e-offline --with-server` 全绿；三条路径的 `billing_status` 断言分别命中；崩溃恢复后 `send_log` 中该 `send_id` **只有一行**。
- **自测命令**：`node license-server/server.js & sleep 1; node test/run.js --group e2e-offline --with-server`

### P2-14 客户端配置、策略 ack 与界面接线（最小可用）
- **前置依赖**：P2-08、P2-12 ｜ **交付内容**：`client/ui/`（登录页 + 主面板骨架）、`host/config.js`
- **实现要点**：① 登录页：账号 + 密码 + 记住账号，**无注册入口、无自助改密**（验收标准 1）；② 主面板显示当前账号、剩余积分、`replies_affordable`、**今日剩余额度 `daily_quota.*.remaining`**、到期时间、当前等级与"距下一档还需 N 天"；③ 首次登录弹窗必须展示 `quota_notice.headline` + `detail`（四处之一，另外三处在 P6-01）；④ 急停按钮常驻顶部（`Esc`）；⑤ 配置变更写审计 `{field_key, old_value, new_value, source:'user', applied, reject_code}`，**越权改动本地拦截 + `applied:false` + `reject_code:'POLICY_VIOLATION'`**；⑥ 原生 DOM、无框架、无构建、不引图表库
- **⚠️ 易错点**：前端**绝不允许**存在硬编码演示假数据（D-14：接口全空时 `liveState` 不清除，商家看到"3 房间/18 命中"的幻觉数据）。空态显示"暂无数据"。
- **验收判据**：验收标准 1 通过；`client/ui/` 中不存在用于展示的样例数字；改日上限为越权值 → 被拦截且本地审计出现 `applied:false` + `reject_code:"POLICY_VIOLATION"`。
- **自测命令**：`node test/run.js --group ui && grep -rniE '"sample|demo_|mock_' client/ui/ || echo OK`

### P2-15 🔴 真机验证门 G-1~G-5（**未通过不得进入 P3**）
- **前置依赖**：P2-01~P2-14 全部完成 ｜ **交付内容**：`test/gate/g1..g5.js`（可重复执行）、`docs/P2-真机验证报告.md`
- **实现要点**：① **必须使用专门的小号**，不要用主号；每日验证发送量受当日 `tier_table` 上限约束；② 逐项验证并留证据（日志、截图、`send_log` 导出）：
  - **G-1** 裸 CDP 接管专用 Chrome，评论区互动**全程无需重新登录**
  - **G-2** 连续 **20 次**自动回复成功且判定准确（**不误报、不谎报**——用 `platform_status_code` 与 `confirm_signal` 逐条核对）
  - **G-3** 无验证码拦截、无账号异常提示
  - **G-4** `legacy/` 中的定位技巧**全部**复现（逐条勾选：可见 comment-list、`scrollIntoView` 延迟读坐标、note 帖浮层、Enter 三段式、`status_code:0` 判据）
  - **G-5** 连续运行 **8 小时**无崩溃，**可自愈标签页关闭**（手工关掉标签页后 30 秒内自动重建并继续）
  ③ 报告须记录：测试账号（脱敏）、`policy_version`、`account_day_index`、每项实际观测值、**未通过项的具体表现**；④ **未通过时**：修 `core/`/`platform/` 后重验；若 G-1/G-2 因**语言能力**受限无法达成（预期不会发生），按 `架构说明.md` §十二 评估换 Python——此时 `protocol.md` 与 `test/fixtures/` 可平移，`core/`+`adapters/` 重写
- **⚠️ 易错点**：G-2 的"不谎报"是重点——若出现"编辑器消失即成功"被记为 `sent_confirmed`，说明 P2-06 有缺陷，**必须修复后重验**，不得带病进入 P3。
- **验收判据**：`node test/run.js --gate` 输出 G-1~G-5 全部 `PASS`；报告存在且每项 G 都有可核对原始数据；G-2 的 20 条明细中 `sent_confirmed` 条数与平台侧实际发出条数**完全一致**。
- **自测命令**：`node test/run.js --gate`；`node license-server/cli.js audit export --user demo001 --from <date> --to <date> --format csv --out ./p2-gate.csv`

---

## P3 弹幕与私信（6 项 / 10–16 人日）

> **收口验收**：验收标准 **16**（私信与评论使用不同日上限与最小间隔，私信显著低于评论）。

### P3-01 直播间页面模型 `page-live.js`
- **前置依赖**：P2-15 ｜ **交付内容**：`platform/page-live.js`、`client/test/page-live.test.js`
- **实现要点**：① 只读**可见**弹幕 DOM（`legacy/live_dom_collector.js` 的形态），选择器进 `selectors.js`；② 暴露 `open_room`/`wait_danmaku_visible`/`read_new_danmaku`/`locate_danmaku`/`send_reply`；③ 去重键优先 `(account_id,'live',room_id,msg_id)`，无稳定 `msg_id` 时退化为 `(account_id,'live',room_id,user_key_hash,content_hash)` 且 **5 分钟窗内只计一次**；④ endpoint 为 `live/comment/send`（闭集白名单内）
- **⚠️ 易错点**：`legacy/live_dom_collector.js` 的 `dailyLimit` 是**数组截断（D-3）**，不要照抄。
- **验收判据**：离线快照测试通过；可见弹幕定位技巧逐条复现（报告贴对照行号）。
- **自测命令**：`node test/run.js --group page-live`

### P3-02 `adapters/reply-danmaku.js`
- **前置依赖**：P3-01、P2-10、P2-07 ｜ **交付内容**：`adapters/reply-danmaku.js`
- **实现要点**：① 复用 P2-10 的强制顺序（`send_id` 先落盘 → 额度二次校验 → 发送）与 15 步链路，仅替换页面模型与 endpoint；② `source_type='live_danmaku'`，**独立日上限与最小间隔**（`tier_table`：10/25/30，间隔区间 `[30000,90000]`）；③ 命中后加**人工量级延迟**再回复，避免"秒回"特征（旧代码约 8 秒即回，需随机化）；④ 判定同样只认平台响应体，空响应 → `failed` + `risk_control_signal='empty_response'`；⑤ 熔断窗口与评论**独立**
- **⚠️ 易错点**：不要复用评论的计数器与熔断窗口——三渠道**独立限额、独立统计**（§7）。
- **验收判据**：单测断言弹幕与评论的 `daily_used` **互不影响**；`source_type` 上报为 `live_danmaku`；间隔取值落在 `[30000,90000]`。
- **自测命令**：`node test/run.js --group reply-danmaku`

### P3-03 `page-profile.js` + `sec_uid` 提取
- **前置依赖**：P3-01 ｜ **交付内容**：`platform/page-profile.js`、`adapters/sec-uid.js`
- **实现要点**：① **优先从弹幕数据帧/接口响应提取真实 `sec_uid`**（`Network` 域嗅探），DOM 兜底；② DOM 弹幕常把用户 ID 脱敏成 `*****` → 取不到时标记 **`not_locatable`**；③ `not_locatable` 语义：**跳过并计入"因风控跳过"统计，不报成功、不静默失败**（FR-2.4）；④ 主页模型暴露 `open_profile`/`click_dm_entry`/`wait_dm_editor`/`type_dm`/`submit_dm`；⑤ `user_key_source` 优先级 `sec_uid` > `conversation_id` > `uid_short`，**同一账号内不得混用类型**（混用记 `audit_flag:"user_key_type_mixed"`）
- **⚠️ 易错点**：`sec_uid` **绝不上报原文**（红线 3）——只上报 `user_key_hash = hex_lower(hmac_sha256(privacy_salt, user_key_source))`。
- **验收判据**：脱敏弹幕（`*****`）被标记 `not_locatable` 且计入 `skipped`；`sends[]` 内不出现 `sec_uid` 原文；`privacy_salt` 变化后同一 `sec_uid` 哈希随之变化。
- **自测命令**：`node test/run.js --group sec-uid`

### P3-04 `adapters/send-dm.js`
- **前置依赖**：P3-03、P2-10 ｜ **交付内容**：`adapters/send-dm.js`
- **实现要点**：① endpoint `im/send`，`source_type='dm'`，**独立限额最严**（`tier_table`：warm_up 3 / ramp_up 8 / stable 10），间隔 `[300000,900000]`（5–15 分钟）；② `content_similarity_max` 对 `dm` 默认 **0.75**（比评论更严）；③ 探测到平台 `stranger_dm_disabled` 分支 → 标记 `blocked_by_target`，**不重试**；④ 同一 `conversation_id` 短期冷却，`user_key_type` 用 `conversation_id`（无 `sec_uid` 时）；⑤ `policy.limits.dm.new_conversation_daily_max`（观察期为 0）参与判定
- **⚠️ 易错点**：私信的限额与间隔**远严于评论**——这是平台规则不是产品选择（`术语与选型基准.md` §1.2）。
- **验收判据**：验收标准 **16** 通过（私信与评论使用**不同**的日上限与最小间隔且私信显著更低，有断言）；`stranger_dm_disabled` 映射为 `blocked_by_target` 且**不重试**。
- **自测命令**：`node test/run.js --group send-dm`

### P3-05 三来源统计与失败归因对齐
- **前置依赖**：P3-02、P3-04 ｜ **交付内容**：`host/stats.js`（三来源聚合）、恒等式断言测试
- **实现要点**：① 恒等式写成断言：`sent_confirmed + sent_confirmed_dom + sent_suspected + failed = reply_attempts`（**每来源分别成立**）、`reply_attempts + skipped ≤ hits`、`leads_new ≤ hits`；② `unique_users` 只统计 `sent_confirmed` 对应去重用户数（同窗口同一 `user_key_hash` 只算 1），**疑似与 DOM 判据不计入**；③ `failure_reasons` 用闭集 9 值，⚠️ `editor_dismissed_unconfirmed` **不得**出现在 `failure_reasons` 里（它对应 `sent_suspected`）；④ `sum(failure_reasons.values) == sum(sources.*.failed)`，违反记 `audit_flag:"failure_sum_mismatch"`；⑤ 三来源的 `sources` 键**必须全部存在**，无数据填全 0 对象
- **⚠️ 易错点**：`reply_attempts` 必须与 `send_id` 明细**一一对应**，否则对账必然不匹配。
- **验收判据**：`--group stats` 全绿；构造含 `editor_dismissed_unconfirmed` 的 `failure_reasons` → 上报被拒并记 `REPORT_INVALID`；`leads_new > hits` 按 `hits` 截断 + 记 `audit_flag:"leads_gt_hits"`。
- **自测命令**：`node test/run.js --group stats`

### P3-06 🔴 三来源真机验证
- **前置依赖**：P3-01~P3-05 ｜ **交付内容**：`docs/P3-真机验证报告.md`
- **实现要点**：① 弹幕：真实直播间连续回复 **10 次**并逐条核对 `platform_status_code`；② 私信：真实账号连续发送 **3 次**（受当日上限约束），核对 endpoint 为 `im/send`；③ 至少复现一次 `sec_uid` 脱敏（`not_locatable`）并被正确统计；④ 记录三来源各自的 `daily_used` 与 `remaining`，确认**互不挤占**；⑤ 记录期间是否出现验证码/风控提示
- **⚠️ 易错点**：私信风险最高，**必须用专门小号**，在活跃时段内严格按当日上限执行。
- **验收判据**：报告含三来源各自成功/失败条数与原始证据；三来源上限互不挤占有数据支撑；无账号异常提示。
- **自测命令**：`node license-server/cli.js stats --user demo001 --days 1`

---

## P4 数据看板与上报（5 项 / 8–12 人日）

> **收口验收**：验收标准 **7、10、21**。

### P4-01 服务端看板聚合与接口
- **前置依赖**：P1-08、P1-09、P3-06 ｜ **交付内容**：`domain/stats.js`、`POST /usage/report`、`stats_daily` 聚合、看板查询接口
- **实现要点**：① `usage_report(report_id) UNIQUE` 保证补报幂等，`duplicate:true` 回放首次结果；② **对账**：比对同窗口 `audit_sends` 明细的 `sent_confirmed` 条数与本次 `sources.*.sent_confirmed` 之和，不符记 `audit_flags:["aggregate_mismatch"]`，**永远以明细为准**；③ 指标口径**逐条照抄 §7.6**：截流总量 `sum(leads_new)`；已回复人数 `COUNT(DISTINCT user_key_hash WHERE verdict='sent_confirmed')`；回复成功率 `sent_confirmed/reply_attempts`（分母 0 → `null`，前端显示 `—` 而非 100%）；④ 报表体 >2 MB 或批量 > `audit_batch_max=500` → `REPORT_TOO_LARGE(413)`/`AUDIT_BATCH_TOO_LARGE`；⑤ 含禁用字段 → `REPORT_PRIVACY_VIOLATION(400)` **整条拒绝**；未知字段按白名单丢弃并记审计（向前兼容）；⑥ 看板查询按 `stats_tz_offset_minutes`(480) 切自然日，`week` 以周一为起点
- **⚠️ 易错点**：不要用 `sources.*.sent_confirmed` 作为计费依据——**计费永远只依据明细**。
- **验收判据**：验收标准 21 通过；构造"明细 5 条成功、聚合报 6 条" → 返回 `match:false` + `audit_flags:["aggregate_mismatch"]` 且**计费仍按 5 条**。
- **自测命令**：`node test/run.js --group usage-report && node license-server/cli.js stats --days 7`

### P4-02 客户端看板
- **前置依赖**：P3-05、P4-01 ｜ **交付内容**：`client/ui/dashboard.*`（原生 DOM + 纯 CSS/Canvas 折线）、`host/api.js` 看板接口
- **实现要点**：① 指标：截流总量、已回复人数（**标注"仅平台确认送达"**）、回复条数（`sent_confirmed_dom`/`sent_suspected` **单列**）、回复成功率、分来源明细、失败原因分布、额度消耗、近 7 日趋势；② 余额展示**同时**含 `replies_affordable` 与 `daily_quota.*.remaining`；③ 近 7 日折线用纯 CSS/Canvas，**不引图表库**；④ 空态显示"暂无数据"，**不得**保留演示假数据（D-14）；⑤ 客户端**不得自行计算积分消耗**（§7.6：由服务端 `credit_ledger` 聚合提供）；⑥ 账号健康分可视化：今日已发/上限、连续无异常天数、当前等级阶段、最近一次熔断时间（FR-2.3.7）
- **⚠️ 易错点**：回复成功率分母为 0 时显示 `—`，**不是 100%**。
- **验收判据**：验收标准 7 通过（看板三项数字与手工核对一致）；分母为 0 时前端显示 `—`（单测断言）；`client/ui/` 无演示假数据。
- **自测命令**：`node test/run.js --group dashboard`

### P4-03 客户端上报与离线补报
- **前置依赖**：P2-08、P4-01 ｜ **交付内容**：`license/reporter.js` 完整实现（明细 + 聚合 + 离线队列）
- **实现要点**：① 明细每 `send_batch_interval_ms=300000` 或满 `send_batch_max=50` 上报，**停机前、进入暂停态前、离线恢复后立即上报**；② 聚合每 30 分钟；`policy_snapshot` 必带 `policy_version`+`policy_hash`+`applied_limits`+`captured_at_ms`；③ 离线队列 `pending_sends.json` 上限 `max_pending_sends=20000`，超出**丢最旧并告警**（不静默丢）；④ 恢复后按 `sent_at_ms` **升序**单批补报（≤500），按每条 `sent_at_ms` 所属自然日的等级与上限核算；⑤ 逐条删除已 ACK 明细，用响应 `balance_milli` 重算影子额度（**此处才允许刷新**）；⑥ 每次请求**新 nonce**（复用会被判 `AUTH_REPLAY` 并触发安全告警）；⑦ 熔断期间**不影响历史明细补报**，只拒绝新发送
- **⚠️ 易错点**：`unbilled_insufficient_credit` 的条目**不得重试、不得本地补扣**（`开发规范.md` §2.3）。
- **验收判据**：验收标准 10 通过；离线 3 小时囤 12 条的补报顺序为升序（断言）；`pending_sends.json` 超 20000 时丢最旧并产生告警日志（非静默）。
- **自测命令**：`node test/run.js --group reporter`

### P4-04 配置变更审计全链路
- **前置依赖**：P4-01、P2-14 ｜ **交付内容**：`POST /audit/config-changes`、`safety/audit.js` 配置审计部分
- **实现要点**：① 字段：`change_id`/`changed_at_ms`/`source`(`user`|`server_policy`|`default`)/`actor`(`local_user`|`license_server`|`system`)/`field_key`（**路径白名单**）/`old_value`/`new_value`（字符串）/`applied`/`reject_code`（`applied=false` 时必填）/`policy_version`；② 幂等键 `(account_id, change_id)`，`field_key` 非法 → `AUDIT_CONFIG_INVALID(400)`；③ **本地与服务端双写**，服务端副本客户端不可篡改；④ 必须覆盖：用户调低（`applied:true`）、**用户调高被拒（`applied:false` + `reject_code:"POLICY_VIOLATION"`）**、服务端下发导致的变化（`source:'server_policy'`, `actor:'license_server'`）、恢复默认（`source:'default'`）；⑤ 审计中**禁止**出现内容正文或隐私数据
- **⚠️ 易错点**：`applied=false` 时**必须**给 `reject_code`，否则 `AUDIT_CONFIG_INVALID`——这正是"系统是否拒绝过越权配置"的举证字段。
- **验收判据**：验收标准 14 的审计部分通过；`cli.js audit export` 能检索到"用户主动调高且被拒"的行。
- **自测命令**：`node test/run.js --group config-audit && node license-server/cli.js audit export --user demo001 --from <date> --to <date> --format json`

### P4-05 口径一致性对账
- **前置依赖**：P4-02~P4-04 ｜ **交付内容**：`test/consistency.test.js`
- **实现要点**：① 客户端 `stats.js` 与服务端 `domain/stats.js` **共用同一份明细输入结构**；对同一 fixture 断言截流总量、已回复人数、回复成功率、分来源明细、失败原因分布**逐字段相等**；② 覆盖边界：分母为 0（成功率 `null`）、`comment_id` 缺失（不计入 `hits`）、弹幕无稳定 `msg_id`（5 分钟窗只计一次）、`leads_new > hits`（按 `hits` 截断）；③ 端到端对账：客户端看板数字 == 服务端同一区间数字；④ 加入 `test/run.js` 默认分组（每次全量自测都跑）
- **⚠️ 易错点**：口径不一致会直接变成对账纠纷——这一项是验收标准 7 的判定手段，不是锦上添花。
- **验收判据**：`--group consistency` 全绿；手工核对一份 50 条明细样本，双端三项指标完全一致。
- **自测命令**：`node test/run.js --group consistency`

---

## P5 多实例与商业闭环（5 项 / 10–15 人日）

> **收口验收**：验收标准 **2、12、22**。

### P5-01 多实例隔离
- **前置依赖**：P2-15、P3-06 ｜ **交付内容**：`host/instances.js` 完整实现、`instances/<账号ID>/` 目录规范
- **实现要点**：① 隔离维度（`架构说明.md` §四）：Chrome 配置（独立 `--user-data-dir` 与 `--remote-debugging-port`）、数据（`instances/<id>/*.json`）、CDP 连接（每实例一条 WS，各自 `browser-host`）、调度（独立频控/日上限/熔断窗口）；② 端口基线 9222、实例 N 用 `9222+N`（可配），**启动前探测占用**并记录实际端口；③ 授权共享：实例归属商家账号、**共用积分池**，但**各自独立 ack 策略**；心跳 `instances[]` 上报各实例 `engine_state` 与 `daily_used_total`；④ **单实例故障不传播**（S-6）：`browser-host` 崩溃只重建该实例，`error` 态实例不阻塞其他实例调度；⑤ 启动前检查可用内存/磁盘，超过建议上限（单机 ≤3 实例）时给出明确提示
- **⚠️ 易错点**：多实例共享一个 Chrome profile、共享一个调试端口、或两个 `browser-host` 抢同一 Chrome，都会退化成旧代码的争抢问题。
- **验收判据**：验收标准 12（单用户冷却 30 分钟实际生效）通过；杀掉实例 A 的 Chrome 后实例 B 任务**不中断**（可复现测试）；两实例的 `daily_used` 互不污染。
- **自测命令**：`node test/run.js --group instances && ls instances/`

### P5-02 管理后台与 CLI
- **前置依赖**：P1-10 ｜ **交付内容**：`cli.js`（`account`/`credit`/`code`/`policy`/`audit`/`stats`/`session`/`plan`/`db` 命令组）、`admin/` 页面
- **实现要点**：① CLI 与服务**共用代码与同一个库**，所有命令以服务用户执行（`data/` 是 `0700`）；② `policy set` 必须自动写 `policy_history` 并 `policy_version + 1`（改前/改后 JSON + 操作人 + 原因）；③ `policy show --history` 能看到改前/改后、操作人、时间、原因；④ `audit export --format csv|json` 导出**哈希后的目标标识**与计数/原因，**不含评论原文**；⑤ 后台：商家列表（账号、状态、余额、已用积分、在线/离线、最后心跳）、单商家下钻、全平台汇总；⑥ 后台暴露面：SSH 隧道优先 + 随机 `ADMIN_PATH` + IP 白名单 + 强制 HTTPS（`部署指南-服务端.md` §9.3）；⑦ **后台必须复用同一套计费与策略口径**（§4.14 末）
- **⚠️ 易错点**：`docs/部署指南-服务端.md` §7.1 的 CLI 参数沿用旧策略字段（`daily_total_max`）与旧套餐积分（4500），需按新结构重写（主文档 §9.2 冲突 #14）。
- **验收判据**：验收标准 2 通过；`policy set` 后 `policy_version` 递增且有 `policy_history` 行；`curl -o /dev/null -w '%{http_code}' https://<host>/admin/` 返回 404/403；`audit export` 结果中评论原文关键词 0 命中。
- **自测命令**：`node license-server/cli.js account create --user demo002 --note "测试" --plan "半年套餐" --credits 12600 && node license-server/cli.js policy show --user demo002 --history`

### P5-03 套餐与额度展示
- **前置依赖**：P1-10、P4-02 ｜ **交付内容**：`GET /account/plan` 前端接线、套餐页、充值页、额度提示组件
- **实现要点**：① `plan.credits`/`min_plan_credit`/`stable_daily_max_total`/`quota_notice` **全部由 `tier_table` 实时推导**，前端**不得**硬编码任何数字；② 套餐页与充值页必须**原样展示** `quota_notice.headline` + `detail`（P6-01 补齐另外两处）；③ 必须展示 `estimated_days_at_cap` 与 `estimated_days_at_current_rate`（按最近 7 日实际日均消耗估算）；④ 余额展示**同时**含 `replies_affordable` 与 `daily_quota.*.remaining`；⑤ `hours` 字段恒为 `null`，**客户端必须忽略，禁止据此展示**；⑥ 低余额提醒：剩余可用条数 <100 条时界面变黄并提示
- **⚠️ 易错点**：文案不得改写、折叠或隐藏（§4.14 硬要求）；观察期 `daily_cap_total=0` 时必须切换为观察期文案。
- **验收判据**：验收标准 22 通过（"买了半年套餐 ≠ 半年内能无限发"在套餐页与充值页**原样**展示）；把 stable 评论上限改为 20 后前端数字**自动**变化（无需发版）。
- **自测命令**：`node test/run.js --group plan-ui && grep -rnE '\b(12600|25550|70)\b' client/ui/ || echo OK`

### P5-04 充值码批量生成
- **前置依赖**：P1-10、P5-02 ｜ **交付内容**：`cli.js code batch|list|revoke|redeem`、卡密导出文件（权限 `0600`）
- **实现要点**：① `code batch --count <n> --credits <n> [--plan <名>] [--batch <名>] [--out <文件>]`；② 卡密格式 `DSW-XXXX-XXXX-XXXX` 风格，**服务端只存哈希**，明文只在生成时输出一次；③ 导出文件权限 `0600`，`code list --batch <名> --unused` 可查未使用；④ `code revoke` 作废后兑换返回 `CREDIT_REDEEM_CODE_DISABLED(403)`；⑤ 并发兑换同一码只有一个成功（端到端复验 P1-10）
- **⚠️ 易错点**：批量生成的明文卡密文件**不得**留在仓库或 webroot 下。
- **验收判据**：生成 100 张后 `code list --unused` 计数为 100；并发兑换同一码恰好 1 次成功；导出文件权限 `0600`。
- **自测命令**：`node license-server/cli.js code batch --count 100 --credits 12600 --plan "半年套餐" --batch "2026Q4" --out ./codes.csv && stat -c '%a %n' ./codes.csv`

### P5-05 商业闭环端到端演练
- **前置依赖**：P5-01~P5-04 ｜ **交付内容**：`docs/商业闭环演练记录.md`（含全流程原始输出）
- **实现要点**：① 全流程：`db migrate` → `admin create` → `plan set`(credits=12600) → `account create` → `code batch` → **客户端兑换卡密** → 登录 → 采集+发送 → 看板出数 → `audit export` → `credit balance` 核对；② 验证兑换后余额变化与并发兑换同一码的互斥性；③ 验证**余额耗尽 → 客户端 1 分钟内进入暂停态**（验收标准 3）；④ 验证充值后 `resume_engine` 恢复发送，且**停机期间的明细不被补扣**；⑤ 验证篡改客户端本地任意文件（余额改成 9999）→ 重启后仍显示服务端真实余额（验收标准 8）
- **⚠️ 易错点**：`plan set --credits` 必须 ≥ `min_plan_credit`（默认 12600），否则 `PLAN_QUOTA_BELOW_MIN`。
- **验收判据**：演练记录含全部 5 项可核对输出；验收标准 2、3、8 在本环节复验通过。
- **自测命令**：`node license-server/cli.js credit balance --user demo001 && node license-server/cli.js ledger tail --user demo001 -n 50`

---

## P6 界面精修与交付（5 项 / 12–18 人日）

> **收口验收**：验收标准 **23** + 稳定指标 **S-1~S-6**。

### P6-01 额度文案四处原样展示 + 风险摘要
- **前置依赖**：P5-03 ｜ **交付内容**：套餐页、充值页、**首登弹窗**、**余额不足提示** 四处的 `quota_notice` 组件
- **实现要点**：① 四处**必须原样展示** `quota_notice.headline` 与 `detail`，**不得改写、折叠、隐藏**；② 观察期用观察期文案，`daily_cap_total=0` 时文案自动切换；③ **每日风险摘要持续提示**（不是签一次就完事）：今日已发/上限、连续无异常天数、当前等级、距下一档天数、最近一次熔断时间；④ 开启全自动档位时必须**主动勾选风险确认**（**不得默认勾选**）并记入审计（含时间、客户端版本）；⑤ **全部文案禁止"保证不封号"类表述**（验收标准 23）
- **⚠️ 易错点**：文案数字**由 `tier_table` 实时生成**，不得硬编码进模板字符串。
- **验收判据**：验收标准 22、23 通过；四处都渲染了 `headline` + `detail`（DOM 断言）；`grep -rniE "保证.{0,4}不封|永不封|绝对安全" client license-server docs shared` 0 命中。
- **自测命令**：`node test/run.js --group quota-notice && grep -rniE "保证.{0,4}不封|永不封|绝对安全" client license-server docs shared || echo OK`

### P6-02 界面精修（快捷键、暗色、状态可见性）
- **前置依赖**：P6-01 ｜ **交付内容**：`client/ui/` 完成态
- **实现要点**：① 统一设计 token（CSS 变量）+ 暗色系（NFR-5）；② 快捷键 `Esc` 急停、`Ctrl+K` 命令面板、`1-9` 切面板；③ 每处失败在 UI 直接显示"卡在哪一步、为什么"（用 `stage` + `reason`，S-3 的用户可见面）；④ 熔断状态显示当前级别与恢复时间；观察期显示"第 1-3 天，仅采集不发送"；⑤ 原生 DOM，无框架、无构建、无第三方图表库
- **⚠️ 易错点**：不要为好看引入 CSS 框架或图标字体（破坏"解压即用"与零构建）。
- **验收判据**：`Esc` 在任何面板下都能立即急停（手工 + 单测）；`Ctrl+K` 打开命令面板；暗色主题下文本可读；页面无外部 CDN 请求。
- **自测命令**：`node test/run.js --group ui-shortcuts && grep -rnE 'https?://[^"'"'"' ]+\.(js|css|woff|png)' client/ui/ || echo "OK: 无外部资源"`

### P6-03 文档复核与重写
- **前置依赖**：P6-01、P6-02 ｜ **交付内容**：重写的 `README.md`（面向商家）、`AGENTS.md` 复核、**5 份 `shared/` 规范与真机验证结果的对齐修订**、`docs/合作方须知`
- **实现要点**：① `README.md` 面向商家：依赖要求（Node ≥22.5）、快速开始、功能面板、**安全边界**、已知限制（如实说明：图文帖不支持、`sec_uid` 可能取不到、发送成功率受风控影响）、数据与隐私、目录结构、常见问题；② `shared/已知陷阱与平台知识.md` **复核**：文档阶段已产出初版，此处必须把 P2/P3 真机验证中**新发现或与初版不符**的 DOM 知识逐条回写（隐藏与可见双 comment-list、`scrollIntoView` 后延迟读坐标、note 帖浮层、Enter 三段式、`status_code:0` 判据）；③ `shared/测试策略.md` **复核**：确认 G-1~G-5 验证门流程与 72 小时长稳方法与 P6-04 实际执行方式一致；④ `docs/合作方须知`：能力边界与责任划分，**含"降低风险但不消除"的明确表述**；⑤ 全部文档不得出现"保证不封号"类表述
- **⚠️ 易错点**：不要把未真机验证的功能写成"已支持"——`AGENTS.md` §6 要求明确区分"已真机验证"与"仅代码完成"。文档与实际实现冲突时，**以 `legacy/` 与真机验证结果为准**并修订文档。
- **验收判据**：新接手者按 `README-DEV.md` "路径 2"能独立跑通全流程（至少 1 人实操验证）；`AGENTS.md` 行数 ≤120；`shared/` 5 份规范全部存在且**已合入真机验证的新发现**（修订记录有对应日期条目）。
- **自测命令**：`wc -l AGENTS.md && ls shared/*.md`

### P6-04 🔴 72 小时长稳测试（S-1~S-6）
- **前置依赖**：P6-01、P6-02 ｜ **交付内容**：`docs/长稳测试报告.md`（含 72 小时原始日志与指标）
- **实现要点**：① **S-1**：连续运行 **72 小时**不崩溃（无未捕获异常退出）；② **S-2 自愈**（自动恢复率 ≥95%，无需人工）——期间**故意**制造故障：关闭标签页、重启 Chrome、断网 5 分钟、杀掉 `browser-host`，每次记录恢复耗时与是否自动；③ **S-3**：抽查 20 条失败，每条都能定位到具体 `stage` + `reason`；④ **S-4 改版韧性**：统计期间因选择器问题需要改动的文件数，**必须 = 1**（只有 `selectors.js`）；⑤ **S-5 幂等**：制造 3 次进程重启 + 1 次重复上报，确认**零重复发送、零重复扣费**；⑥ **S-6 隔离**：多实例下杀掉一个实例的 Chrome，其他实例任务不中断；⑦ 记录内存/句柄增长曲线、`pending_sends.json` 积压峰值、`engine_state` 切换次数
- **⚠️ 易错点**：把 72 小时排在最后一周——**一旦不达标没有返工时间**。应在 P2-15 通过后就规划窗口。
- **验收判据**：报告含 72 小时连续运行证据（日志时间戳连续、无重启记录）；S-2 的四类故障**全部自动恢复**且自愈率 ≥95%；S-5 的重复发送与重复扣费均为 **0**；抽查 20 条失败全部可归因。
- **自测命令**：`node license-server/cli.js stats --days 3 && node license-server/cli.js audit usage`

### P6-05 打包与交付
- **前置依赖**：P5-05、P6-03、P6-04 ｜ **交付内容**：`douyin-workbench-client-<ver>.zip`、`license-server-<ver>.tar.gz`、`docs/交付说明.md`
- **实现要点**：① 便携包：`client/`、`shared/lib/`、**内置 `node_modules/ws`**（商家不需要 npm 环境）、`启动.cmd`/`停止.cmd`、面向商家的 `README.md`；② 启动自检：Node ≥22.5（不满足给明确提示而非崩溃）、`ws` 存在、端口占用探测、路径全部经 `REPLY_WORKSPACE` 解析；③ 便携包**必须清空**运行数据：`instances/`、`*.json` 运行数据、`chrome-profile`、二维码图片、任何账号痕迹；④ 服务端包：`server.js`、`cli.js`、`api/`、`domain/`、`store/`、`crypto/`、`admin/`、`migrations/`、`.env.example`、`docs/部署指南-服务端.md`；⑤ 跨机验证：把便携包拷到**任意路径**（如 `E:\test\wb\`）后跑通视频采集与增量扫描，**不再依赖 `D:\deep seek\`**（验收标准 11）；⑥ 服务端按 `部署指南-服务端.md` 部署到目标 VPS，全程 `sing-box` 保持 `active`，ufw 只加不删；⑦ 交付说明含版本号、`protocol_version=2`、`min_client_version`、升级方式、回滚方式（切软链）
- **⚠️ 易错点**：便携包**绝不能**带原作者的 `dy-main`/`chrome-profile`/登录态/历史评论记录；服务端部署时**绝不动** `443/tcp`、`8443/udp`，不重启网络服务，不改 `/etc/cron.d/vps-maintenance`。
- **验收判据**：验收标准 9（`node --check` 全量 + `node test/run.js` 全绿）与 11（换任意路径可跑通）通过；便携包解压后**无需 npm install** 即可启动；包内 `grep -rl "D:\\\\deep seek"` 0 命中；服务端 `systemctl is-active sing-box` = `active`，`/healthz` 与 `/readyz` 均 200。
- **自测命令**：`node test/run.js`；`grep -rl "D:\\\\deep seek" . --include=*.js --include=*.json --include=*.ps1 --include=*.cmd || echo OK`；`systemctl is-active dy-license sing-box`

---

## 附录：三条红线的对应验收（交付前逐条自查）

| 红线 | 对应任务 | 客观验收判据 | 验收标准 |
|---|---|---|---|
| **红线 1** 安全上限服务端下发、客户端只能调低 | P1-07、P2-07、P2-14 | ① 越权上报返回 `POLICY_VIOLATION(409)` 且 `detail` 给出 `field/reported/allowed/policy_version`；② 观察期通过任何界面操作**都无法**开始发送；③ 策略收紧后 60 秒内生效；④ 全仓 `grep` 无限额硬编码 | 13、14、5、6、18 |
| **红线 2** 只对平台确认成功的发送计费 | P1-08、P2-06、P2-10、P2-13 | ① 风控拒绝（空响应）不扣费且台账无该笔；② 同 `send_id` 重复上报 10 次只扣 1 条；③ `confirm_signal='dom_stable'` 永不产生 `billed`；④ `platform_status_code≠0` 但标 `sent_confirmed` → `not_billable` + `audit_flag:"evidence_invalid"`；⑤ `send_id` 落盘**先于**发送 | 19、20 |
| **红线 3** 审计记录真实生效的策略值 | P1-07、P2-07、P4-04、P5-02 | ① 审计含 `applied_policy_version` 与 `applied_limits`（非仅设置值）；② 上报体内无任何禁用隐私字段；③ `applied=false` 时必须带 `reject_code`；④ `audit export` 能检索到"用户主动调高且被拒"的行；⑤ 篡改本地文件无法改变服务端记录 | 21、8 |

---

*本清单与 `plans/A-工具链路开发指导.md` 配套使用。所有限额、字段、错误码、接口路径以 `shared/protocol.md` 为准；验收标准编号以 `docs/需求规格.md` §九 为准。发现文档矛盾时按 `AGENTS.md` §7 停下来问，不要自行决定。*
