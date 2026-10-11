# 把「抖音截流」做成 Agent 工具 —— 落地方案（基于仓库实测，2026-09-29）

> 事实基线：`D:\pr-work\douyin-intercept-workbench` @ `final/integration-2026-09-29` `2185ced`（工作区干净）。
> 全仓库检索 `T-0[1-8]|review_batch|approve_batch|query_leads|mcp|工具契约`：**非 archive 命中 0 处**。
> 结论：v4 目前**没有 Agent 工具层**。唯一的「agent」字样是 Electron 的 IPC 命名空间（`agent:chat` 等）。

## 一、先定义清楚「Agent 工具」是哪一种

| 形态 | 含义 | 本仓库适配度 |
| --- | --- | --- |
| A. **独立的工具服务（MCP / stdio JSON-RPC）**（推荐） | 把能力包装成 8 个受约束的工具，任何 LLM 客户端都能驱动 | 高：不碰 `desktop`/`server`，工具面里根本没有发送工具 |
| B. 工作台内置 Agent loop | Electron 进程内跑循环，UI 里聊天驱动 | 中：要改 `desktop/src`，且已存在「流程必须绑定服务端签发计划」的契约 |
| C. 全自动无人值守机器人 | 自己搜→自己回→自己私信 | **禁止**：章程明确 Agent 默认开启但**永不直接发送** |

选 A。理由不只是"干净"：**Agent 的越权面 = 工具清单**。工具清单里没有 click/type/evaluate/改策略/急停，模型就没有可越权的动作。

## 二、已经有的（可复用）

### 1) 唯一执行器：`probe/sidecar.py`
line-JSON 协议，`dispatch` 白名单 **21 个方法**（`sidecar.py:2160`，其中 `comment_private_candidates` 重复列了一次，实际 21 个）：
`capabilities, launch, doctor, open, search, search_pool, collect_comments, comment_plan, comment_reply, comment_private, comment_result, comment_private_candidates, collect_live, live_listen, live_plan, live_reply, live_private, live_result, send_private, send_comment, close`

已具备 Agent 层最需要的三件事：
- **回执分级**：`sent_confirmed` / `sent_echoed` / `unknown` / `failed` / `blocked`。
- **本地安全阀**：`probe/send_gate.py` 的 `SendGate`（per_user 1 / hourly 20 / daily 50，默认不变，可被授信调用方显式调高）。
- **验证码即停转人工**。

### 2) ⚠️ 一条必须先搞懂的语义（已经踩过，Agent 层会再踩）
`SendGate.result()` **故意把 `sent_confirmed` 投影成 `unknown`**（对外不过度宣称，`send_gate.py:249-257`）。
但两阶段契约**必须读落库的原始状态**（`sidecar.py:387 _public_guard` / `sidecar.py:61 _durable_send_state`），否则永远进不了私信。
→ Agent 层如果只看单发工具的返回，会得到 "unknown"，**不能据此判断公屏是否成功、更不能据此解锁私信**。必须走批次报告（`comment_result` / `live_result`）或直接读台账。

### 3) 编排骨架（若走 B 形态）
`desktop/src/lib/task-engine.js`(329)、`workflow-runtime.js`(589)、`probe-client.js`、`probe-bridge.js`、`account-runtime-manager.js`。
注意 `desktop/src/main.js:468 runAgentChat` **不是 LLM 工具循环**：它把一句人话交给平台规划器 `planFromIntent`，平台返回签发计划，客户端不能自造 `planId/params`（`server/src/workflow-routes.ts:375-389`）。这是一条独立权威链。

### 4) 契约文档链路
`docs/sidecar-protocol.md`（方法表 + capabilities，被 `test_protocol_doc_contract.py` 钉住）、`probe/SIDECAR.md`、`probe/EVIDENCE.md`。

### 5) 可复用的**设计**（只借设计，不借代码）
`archive/v3/client/safety/{guard,circuit,similarity,audit}.js`、`client/host/{store,queue,scheduler}.js`、`archive/v3/plans/{ADR-001,B-工具契约与粒度设计,B-分阶段任务清单}.md`。
`archive/v3/docs/可复用资产审计.md` 已定调：自动化层无可复用项目；`AGENTS.md` 禁止生产代码引用 `archive/v3/`。

## 三、缺的（「你需要哪些东西」的正面清单）

| # | 缺什么 | 落点 | 为什么必须 |
| --- | --- | --- | --- |
| 1 | **工具契约文档 + 闭集枚举** | `docs/agent-tools.md` | T-01..T-08 入参/出参/阻断码必须先冻结；阻断码与协议错误码是**两个命名空间** |
| 2 | **工具适配层** | `agent/`（Node，零第三方依赖，stdio） | sidecar 是"执行器"，Agent 要的是"意图级"工具，中间必须有翻译层 |
| 3 | **线索库 leads store** | `agent/store/` | 实测：sends / live_events+live_batches / comment_flow / search_videos **四套 SQLite 里根本没有 lead**；唯一实现是 desktop 本地 JSON `task-engine.js:334 #upsertLead`，无状态推进 |
| 4 | **健康度 / 配额 / 熔断聚合** | `get_account_health` / `get_stats` | 实测：配额只在 `send_gate.limits` 与 `*_result.limits`，**拒绝原因不落库**；账号健康只在 `doctor` 与 `_page()` 错误码；熔断只有瞬时 `status=captcha`（判据 `douyin.py:132`），**不持久化** |
| 5 | **审批状态机** | `agent/batch/` | 实测：没有审批状态机。只有评论/直播两套批次队列（`comment_flow.CommentQueue` / `live_flow.LiveQueue`） |
| 6 | **决策审计（含 model.version / prompt_version）** | `agent/audit/` | 红线 3 扩展：每次审批可回溯"谁、依据什么、模型与提示词版本" |
| 7 | **两层过滤的代码实现** | 代码内，不在提示词里 | 投诉/无关由**代码**预筛；意图与 `reason_code` 闭集枚举 |
| 8 | **幂等 + 账号隔离** | 复用 `sendId` / `account_scope`=`sha256(realpath(profile))[:32]` | 串号/重放是已发生过的真实缺陷类别 |
| 9 | **LLM 调用（仅 T-04/T-05）** | 默认关闭的特性开关 | 内容生成风险最高，最后做、默认 off |
| 10 | **越权回归测试** | `agent/test/` | 钉死"调不到发送工具""approve 前必须 review""unknown 不放行" |

## 四、必须原样继承的红线（写进代码，不是提示词）

- Agent **永不直接发送**：`review_batch` → `approve/reject/skip`；工具清单**禁止** click / type / scroll / evaluate / 改策略 / 急停。
- `review_batch` 在**观察期 / 熔断 / 配额不足**时返回**空批次**（返回空是正确行为，不是故障）。
- `approve_batch` 必须**独立重跑全部校验**，不能信 `review_batch` 的结论；`max_items` 受服务端策略上限约束。
- 只有 `sent_confirmed` 可进入私信阶段；`sent_echoed`（页面回显）**只是队列证据，台账仍记 unknown**；`unknown` 禁止自动重试。
- 判断"公屏是否成功"必须读**原始台账**，不能用对外 `result()`（见 §2.2）。
- 状态**落盘**，不放对话历史；对话历史只是推理材料。
- 验证码 / 登录未知 → 停机转人工，**绝不绕过**。
- 投诉类必须转人工，不能被 Agent reject 掉。
- 话术**只能选不能造**（每场景 ≥5 变体、禁 URL）；内容生成默认关闭。

## 五、动手顺序（第一阶段完全不碰 LLM）

阶段编号与验收判据已统一到 `agent-tools.md` §十一（**BP0–BP5**），此处只留一句话版：

| 阶段 | 一句话 | 碰 LLM | 能否立刻开工 |
| --- | --- | --- | --- |
| **BP0** | 只读打通：骨架 + stdio + T-03 / T-01 / T-02 / T-08 | 否 | ✅ **不依赖 #55** |
| **BP1** | 审批闭环：T-06 + T-07（候选由规则生成，不接 LLM） | 否 | 需 #55 合并 |
| **BP2** | 意图分析：T-04（默认关） | 是 | 需 #55 合并 |
| **BP3** | 评估集与成本门槛（`agent/eval/`、降级 L1–L4） | 否 | 需 #55 合并 |
| **BP4** | 话术生成：T-05（默认关，只产草稿） | 是 | 需 #55 合并 |
| **BP5** | 审批可视化 + 灰发 + 回滚演练 | 否 | 需 #55 合并 |

（原 P0–P3 的说法已作废，避免出现两套编号。）

## 六、已拍板的三个决策（2026-09-29）

1. **形态 = A**：独立零依赖 stdio 工具服务，落在 `agent/`（不是 Electron 内进程）。
2. **权威链 = 本地批次链**：`comment_plan/comment_reply/comment_private`、`live_plan/live_reply/live_private`。**不接**服务端 workflow 链（`planFromIntent` + 租约），避免双权威。
3. **今天只写契约**：先冻结工具契约，代码等 #55 合并后写。

→ 契约本体见同目录 `agent-tools.md`（草案 v0.2，含 8 个工具的入参出参、闭集枚举、阻断码映射、离线验收断言、CI/PR 约束）。

### 已定：不开 PR

用户决定**不开 PR**，直接做 Agent。因此：
- 契约已随 BP0 一起进仓库（`docs/agent-tools.md`），分支 `feat/agent-bp0`，**本地、未推送**；
- BP0 代码已落地（`agent/`，46 个离线测试全绿，并对真实台账做过只读实测）；
- 已核实：`probe/tests/test_protocol_doc_contract.py` 只读 `docs/sidecar-protocol.md` 一个文件，新增本文不会触发它。
