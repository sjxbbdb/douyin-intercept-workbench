# 方案 B · 工具契约与粒度设计

> ⚠️ **这是方案 B 成败的关键文档。**
>
> 工具粒度切得太细，Agent 就变成"操作员"——贵、慢、脆，且会为了完成一次回复调用几十次工具。
> 切得太粗，Agent 就变成"复读机"——只能执行固定指令，失去存在的意义。
> 本文档确定这条线在哪里，并给出完整的工具契约。

---

## 一、⚖️ 一条不可违背的架构原则

> ### Agent 永远不直接发送。它只能审批系统预筛过的队列。

这句话是方案 B 安全性的全部基础。展开说明：

```
❌ 错误设计：
   Agent → send_reply(lead_id, text)     ← Agent 直接决定"发给谁、发什么、发几条"
   后果：模型判断失误会直接产生真实发送，把安全护栏架空

✅ 正确设计：
   代码 → 预筛出符合条件的 N 条候选（含安全校验，全部通过）
   代码 → 生成候选回复（从商家话术池中匹配，含相似度检测）
   Agent → review_batch() 看到候选，做三件事：挑掉不该回的、选更合适的话术、批准发送
   代码 → 对批准项执行发送（仍然走完整安全护栏）
   后果：Agent 只能在"安全范围内"做语义优化，无法突破护栏
```

**为什么这样设计**：

| 理由 | 说明 |
|---|---|
| 硬规则不能交给概率模型 | 红线 1 要求"观察期禁发""日上限""最小间隔"是硬约束。**你不可能让一个概率模型来遵守硬规则**——总有一定概率它不遵守。护栏必须是代码里的 `if` |
| 成本可控 | 批处理一次决策处理 N 条，而不是每条一次推理 |
| 可审计 | 决策输入是有限的候选集，输出是"批准 + 选择"，可完整落盘 |
| 降级安全 | Agent 不可用时，系统可以退化为方案 A 继续工作 |

---

## 二、判断粒度是否合适的三条检验

实现时用这三条自查。**任何一条不满足，说明粒度切错了。**

| 检验 | 含义 | 不满足的表现 |
|---|---|---|
| **一次工具调用对应一个用户可理解的业务动作** | 用户会说"帮我回复这条"，不会说"帮我点击回复按钮然后输入文字" | 出现 `click_element`、`type_text`、`navigate` 这类工具 |
| **一次工具调用不产生几十次内部操作** | 返回时间在秒级到十几秒级，不是分钟级 | 一次调用内部有 40 轮滚动、6 轮重试 |
| **危险动作必须经过独立审批步骤** | "选谁、发什么、发几条"由代码决定，Agent 只审批 | Agent 能自由构造发送目标与内容 |

### ⚠️ 反模式清单（明确禁止）

| 禁止 | 为什么 |
|---|---|
| 把 CDP 操作暴露为工具（`click`/`type`/`scroll`/`evaluate`） | 让 Agent 操作像素。一次回复需要几十次 CDP 操作，每次过一遍模型是拿最贵的东西干最便宜的活 |
| 让 Agent 传"发送间隔""日上限""相似度阈值" | 这些是安全策略，由服务端下发，Agent 无权修改（违反红线 1） |
| 让 Agent 决定"是否发送"（`send_now: true/false`） | 应由代码根据策略判定，Agent 只能"批准/否决预筛结果" |
| 提供 `emergency_stop` 工具给 Agent | 急停是人在界面上的动作。让模型触发急停会造成混乱（模型可能误触，也可能在需要急停时反而不触发） |
| 让 Agent 自由生成话术后直接发送 | 内容级风控无法防范（内容级风控拦得住字面、拦不住语义）。**只能从候选池选** |
| 把任务状态放在对话历史里 | 对话崩溃或上下文超限即丢状态。真状态必须落盘（见第五节） |

---

## 三、工具清单

共 10 个工具。按危险程度分为三组。

### 3.1 只读查询类（无副作用，可自由调用）

#### T-01 `query_leads`

| 项 | 内容 |
|---|---|
| **用途** | 查询线索库，支持按意图/地域/时间/关键词筛选 |
| **输入** | `{ intent?, region?, date_from?, date_to?, keyword?, source_type?, limit? }`（`limit` 默认 50，上限 200） |
| **输出** | `{ total, leads: [{ lead_id, source_type, intent, region, excerpt, first_seen_at_ms, replied }] }` |
| **幂等** | 是（只读） |
| **成本** | 无推理，纯查询 |
| **⚠️ 注意** | `excerpt` 是评论正文的截断，**不含 `sec_uid` 原文**（隐私边界） |

#### T-02 `get_stats`

| 项 | 内容 |
|---|---|
| **用途** | 获取经营数据（截流总量、已回复人数、成功率、分渠道明细、额度消耗） |
| **输入** | `{ date_from?, date_to?, source_type? }` |
| **输出** | `{ leads_total, replied_users, replies_sent, success_rate, by_source: {...}, credits_used, daily_quota: {...} }` |
| **幂等** | 是 |
| **⚠️ 注意** | 口径必须与客户端看板、服务端看板**完全一致**（共用同一份聚合逻辑） |

#### T-03 `get_account_health`

| 项 | 内容 |
|---|---|
| **用途** | 查询账号当前状态：等级、天数索引、各渠道今日剩余额度、是否熔断、是否观察期 |
| **输入** | `{ instance_id? }` |
| **输出** | `{ account_tier, account_day_index, sending_enabled, collect_only, next_tier_at_day, remaining: {comment, live_danmaku, dm}, circuit: {open, reason, cooldown_until_ms}, balance_credits }` |
| **幂等** | 是 |
| **⚠️ 注意** | 这是 Agent 判断"现在能不能干活"的唯一依据。**不得由 Agent 自行推断** |

### 3.2 生成与分析类（消耗推理，需成本控制）

#### T-04 `analyze_comments`

| 项 | 内容 |
|---|---|
| **用途** | 批量分析评论：识别意图、抽取结构化线索字段、给出是否值得回复的建议 |
| **输入** | `{ lead_ids: string[] }`（**单批上限 50 条**） |
| **输出** | `{ results: [{ lead_id, intent, confidence, extracted: {region?, budget?, product?, urgency?}, worth_replying, reason }] }` |
| **幂等** | 是（相同输入返回缓存结果，缓存 TTL 建议 24 小时） |
| **成本** | **批处理**：一次推理处理最多 50 条 |
| **⚠️ 注意** | `intent` 必须来自**闭集枚举**（见 3.4），不得自由文本，否则无法用于筛选与统计 |

#### T-05 `draft_replies`

| 项 | 内容 |
|---|---|
| **用途** | 为候选线索生成回复候选。**优先从商家话术池中匹配**，匹配不到时才由 LLM 生成新候选 |
| **输入** | `{ lead_ids: string[], intent_hint?, max_per_lead? }`（`max_per_lead` 默认 3，上限 5） |
| **输出** | `{ drafts: [{ draft_id, lead_id, candidates: [{ text, source: "template"\|"generated", template_id?, similarity_checked }] }] }` |
| **幂等** | 否（生成有随机性） |
| **成本** | 批处理；**优先命中话术池可显著降本** |
| **⚠️ 注意** | ① 每个候选**必须**经过相似度检测，`similarity_checked: true` 才可进入审批；② `source: "generated"` 的候选需商家在设置中显式开启（默认关闭）；③ 生成的候选**必须经人工或规则复核后**才进入长期话术池 |

### 3.3 执行审批类（有副作用，最危险）

#### T-06 `review_batch`

| 项 | 内容 |
|---|---|
| **用途** | **核心工具。** 拉取系统预筛好的待发批次，供 Agent 审批 |
| **输入** | `{ source_type?, max_items? }`（`max_items` 默认 10，**上限由服务端策略决定**） |
| **输出** | `{ batch_id, items: [{ item_id, lead_id, source_type, excerpt, intent, draft_options: [{draft_id, text, source}], recommended_draft_id, safety: { within_daily_quota, interval_ok, similarity_ok, tier_allows_sending } }], expires_at_ms }` |
| **幂等** | 是（同一批次重复拉取返回同一 `batch_id`） |
| **成本** | 无推理 |
| **⚠️ 关键约束** | ① **只返回已通过全部安全校验的候选**；② 返回条数受服务端策略上限约束，**Agent 无法扩大**；③ `expires_at_ms` 到期未审批则该批次回滚（不发送） |

#### T-07 `approve_batch`

| 项 | 内容 |
|---|---|
| **用途** | 提交审批结果。**唯一的写入型执行工具。** |
| **输入** | `{ batch_id, decisions: [{ item_id, action: "approve"\|"reject"\|"skip", draft_id?, reason? }] }` |
| **输出** | `{ batch_id, accepted: n, rejected: n, skipped: n, queued_send_ids: [...], blocked: [{item_id, code, message}] }` |
| **幂等** | **是**（同一 `batch_id` 重复提交返回首次结果，不重复发送） |
| **成本** | 无推理 |
| **⚠️ 关键约束** | ① **`action` 只有三种，没有"换一个目标"或"改文案"**——Agent 不能引入候选外的内容；② `draft_id` 必须在 `review_batch` 返回的 `draft_options` 中，否则返回 `AGENT_DRAFT_NOT_IN_CANDIDATES`；③ 服务端**再次**执行全部安全校验，任一不过则该项 `blocked` 且不发送（**不信任 Agent 的审批**）；④ 实际发送仍走完整安全护栏（频控、随机间隔、熔断、审计） |

#### T-08 `explain_failure`

| 项 | 内容 |
|---|---|
| **用途** | 查询失败原因与归因码，用于向用户解释"为什么没发出去" |
| **输入** | `{ lead_id?, send_id?, batch_id?, date_from?, date_to?, limit? }` |
| **输出** | `{ failures: [{ send_id?, lead_id, stage, reason_code, reason_text, occurred_at_ms, suggestion }] }` |
| **幂等** | 是 |
| **⚠️ 注意** | `reason_code` 使用统一归因码（见 `shared/protocol.md` 与开发规范），**不得返回自由文本作为唯一依据** |

### 3.4 闭集枚举（必须严格实现）

`intent` 与 `reason_code` 必须是闭集，否则无法统计与筛选。

**`intent` 建议闭集**（可扩展但需与统计口径同步）：

| 值 | 含义 | 典型表述 |
|---|---|---|
| `price_inquiry` | 询价 | "多少钱""贵不贵""怎么卖" |
| `feature_inquiry` | 问功能 | "有什么功能""能做什么" |
| `purchase_intent` | 购买意向 | "怎么买""在哪下单" |
| `support_inquiry` | 售后/使用咨询 | "怎么用""坏了怎么办" |
| `complaint` | 投诉/负面 | "太差了""骗人" |
| `irrelevant` | 无关 | 闲聊、广告、灌水 |
| `unknown` | 无法判断 | 语义不明 |

> ⚠️ `complaint` 与 `irrelevant` 的项，**规则层应默认不进入待发批次**，避免 Agent 在负面评论下自动回复引发公关风险。此规则由代码保证，不由 Agent 判断。

**`approve_batch` 可能返回的阻断码**：

| 码 | 含义 |
|---|---|
| `AGENT_DRAFT_NOT_IN_CANDIDATES` | 提交了候选池外的文案 |
| `AGENT_BATCH_EXPIRED` | 批次已过期 |
| `POLICY_DAILY_CAP` | 已达当日上限 |
| `POLICY_SENDING_DISABLED` | 观察期禁发 |
| `POLICY_CIRCUIT_OPEN` | 熔断中 |
| `SAFETY_SIMILARITY_BLOCKED` | 相似度过高 |
| `SAFETY_INTERVAL_TOO_SHORT` | 间隔不足 |

### ⚠️ 阻断码 ↔ 协议错误码的映射（两个命名空间，勿混用）

上表是**工具层业务阻断码**（面向 Agent 与商家的可读结果），`shared/protocol.md` §3 里的 `POLICY_*` 是**协议层错误码**（面向 HTTP 响应的工程错误）。两者**不是同一套**，必须显式映射，否则 Agent 会拿到无法处理的错误码。

| 工具阻断码 | 对应协议错误码 | 说明 |
|---|---|---|
| `POLICY_DAILY_CAP` | `POLICY_DAILY_CAP_EXCEEDED`(200) | ⚠️ **名称不同**。协议里是 `..._EXCEEDED` 且返回 **200**（业务结果非错误）；工具层对外统一暴露为 `POLICY_DAILY_CAP` |
| `POLICY_SENDING_DISABLED` | `POLICY_SENDING_DISABLED`(409) | 同名 |
| `POLICY_CIRCUIT_OPEN` | 心跳下发的 `commands:[{type:"circuit_break"}]`（无独立错误码） | 熔断是**状态**而非单次错误，工具层需从账号状态判定 |
| `SAFETY_SIMILARITY_BLOCKED` | 无对应协议码（纯客户端护栏） | 客户端本地拦截，不上报为错误 |
| `SAFETY_INTERVAL_TOO_SHORT` | 无对应协议码（纯客户端护栏） | 同上 |
| `AGENT_DRAFT_NOT_IN_CANDIDATES` | `AGENT_DRAFT_NOT_IN_CANDIDATES`(400) | 同名 |
| `AGENT_BATCH_EXPIRED` | `AGENT_BATCH_EXPIRED`(409) | 同名 |
| （限流类，工具层未设独立码） | `RATE_TOO_MANY_REQUESTS`(429) | ⚠️ 限流属**传输层**，工具层不新增阻断码；客户端应自动退避重试，不作为业务阻断暴露给 Agent |

**实现要求**：工具层**不得**把协议错误码原样抛给 Agent。Agent 只应看到上表左列的业务阻断码，形如 `{item_id, code, message}`。协议细节（HTTP 状态、错误信封）留在客户端与授权中心之间。

---

## 四、一次完整交互的例子

用户说：**"帮我看看南京这边问价格的，挑几个回一下，别超过 10 个"**

```
用户 → Agent

Agent 调用 T-03 get_account_health()
  ← { account_tier: "stable", sending_enabled: true, remaining: {comment: 28}, ... }
  ✓ 确认可发送

Agent 调用 T-01 query_leads({ intent: "price_inquiry", region: "南京", limit: 50 })
  ← { total: 17, leads: [...] }
  ⚠️ 注意：Agent 没有"自己理解"意图，而是用闭集值查询
     （意图是之前由 T-04 批量分析入库的）

Agent 调用 T-06 review_batch({ source_type: "comment", max_items: 10 })
  ← { batch_id: "b-8f2a", items: [10 条，每条含 excerpt、intent、
       draft_options[3 条]、recommended_draft_id、safety 全通过] }
  ⚠️ 关键 1：这 10 条是代码预筛的，全部已通过配额/间隔/相似度校验
  ⚠️ 关键 2：批次里【不含】 complaint / irrelevant —— 那些在规则层就被
      排除了（见下文"两层过滤"）。所以 Agent 在批次里看不到投诉项。

Agent 决策：6 条 approve（其中 2 条选了比 recommended 更贴合语气的候选）
            4 条 reject（reason: "这条问的是售后，话术池里没有匹配的候选"）
            —— reject 是 Agent 的【合法否决权】：候选虽通过安全校验，
               但 Agent 认为语义上不该回，可以否决。

Agent 调用 T-07 approve_batch({ batch_id: "b-8f2a", decisions: [...10 条] })
  ← { accepted: 6, rejected: 4, queued_send_ids: [...],
      blocked: [{item_id: "it-7", code: "SAFETY_INTERVAL_TOO_SHORT"}] }
  ⚠️ 服务端二次校验拦掉了 1 条（该条刚好触发了间隔限制）
  ⚠️ 注意 accepted 与 queued_send_ids 的关系：accepted 含被二次校验拦下的项，
     queued_send_ids 只含真正入队待发的项

Agent 向用户汇报：
  "看了南京 17 条询价，挑了 6 条回复（已发出），
   4 条因为话术池没有匹配的候选没有回，1 条因为发送间隔限制没发出去。"
```

### 两层过滤（⚠️ 最容易误读的一处，务必分清）

`complaint` / `irrelevant` 的排除与 Agent 的 `reject` 是**两个不同层次**，不是一回事：

| 层 | 谁来做 | 作用对象 | 说明 |
|---|---|---|---|
| **第一层：规则层排除** | **代码**（不由 Agent 判断） | `complaint`、`irrelevant` 等高风险意图 | 在**生成待发批次之前**就排除，**这些项根本不会出现在 `review_batch` 的返回里**。理由：在负面评论下自动回复有公关风险，这个判断**不能依赖概率模型** |
| **第二层：Agent 否决权** | **Agent** | 批次内已通过安全校验的候选 | Agent 看到候选后，可因**语义不匹配**（如话术池没有合适候选、语气不对）而 `reject` |

**为什么这样分层**：第一层管"不该碰的"（高风险，硬规则，代码强制）；第二层管"该不该由这条回复"（语义判断，Agent 擅长）。

⚠️ **实现要求**：`review_batch` 的返回中**不得出现** `complaint` / `irrelevant` 的项。若测试发现批次里出现这两类意图，说明第一层过滤缺失，属缺陷（验收项见 §八）。

⚠️ **反过来说**：Agent 的 `reject` **不是**用来兜底高风险意图的。不能因为"Agent 会 reject 掉投诉"就省掉第一层过滤——那等于把公关风险交给概率模型。

**这个例子里 Agent 做了三件有价值的事**：① 理解"别超过 10 个"并映射到 `max_items`；② 把负面评论挑出来不回复（语义判断，规则难做）；③ 在候选里选更贴合语气的文案。

**Agent 没有做、也不允许做的事**：决定发送上限、决定发送间隔、自己写文案、扩大批次、绕过任何校验。

---

## 五、状态管理

### ⚠️ 反模式：把任务状态放在对话历史里

对话历史会被截断、会崩溃、会因上下文超限丢失。商家场景是"跑一整天、经常断网、浏览器会崩"——**把状态放在易失的地方等于任务会丢**。

### ✅ 正确做法：状态落盘，对话历史只是推理材料

| 状态 | 存放位置 | 说明 |
|---|---|---|
| 任务状态（待办/进行中/已完成） | **落盘**（`client/host/store.js`） | 每步写入，可恢复 |
| 审批批次 | **落盘**（含 `batch_id` 与 `expires_at_ms`） | 进程重启后仍可续 |
| 发送记录 `send_id` | **落盘，发送前写入** | 幂等键，红线 2 要求 |
| 审计记录 | **本地 + 服务端双写** | 红线 3 要求 |
| 对话历史 | 内存 + 可选落盘 | **仅作推理材料，不承载状态** |

**每轮对话开始时，Agent 必须从落盘状态重建上下文**，而不是依赖历史消息。

### 决策记录格式（红线 3 的扩展）

每次 Agent 决策必须落盘以下字段：

```json
{
  "decision_id": "dec-...",
  "decided_at_ms": 1758096000000,
  "batch_id": "b-8f2a",
  "input_summary": { "lead_count": 10, "intents": ["price_inquiry","complaint","irrelevant"] },
  "candidates_offered": 30,
  "decisions": [
    { "item_id": "it-1", "action": "approve", "draft_id": "d-12",
      "rationale": "语气匹配" }
  ],
  "model": { "provider": "...", "model": "...", "version": "..." },
  "policy_version": 9,
  "prompt_version": "p-1.2.0",
  "usage": { "prompt_tokens": 1820, "completion_tokens": 340 },
  "latency_ms": 2400
}
```

> **为什么必须记 `model.version` 与 `prompt_version`**：模型或提示词更新后，历史决策无法复现。记录它们才能回答"当时为什么这么判断"。

---

## 六、Agent 不得绕过的硬规则（提示词与代码双重保证）

以下规则**必须同时**写在系统提示词里（让模型知道）**和**代码里（强制拦截）。**只写提示词是不够的**——模型可能不遵守。

| 硬规则 | 代码层的强制点 |
|---|---|
| 观察期不得发送任何内容 | `review_batch` 在 `sending_enabled=false` 时**直接返回空批次**；`approve_batch` 返回 `POLICY_SENDING_DISABLED` |
| 不得超过日上限 | `review_batch` 只返回额度内的候选；`approve_batch` 二次校验 |
| 不得绕过最小间隔 | 发送执行层强制；`approve_batch` 提前拦截并返回 `SAFETY_INTERVAL_TOO_SHORT` |
| 不得发送候选池外的内容 | `approve_batch` 校验 `draft_id` 必须来自该批次候选 |
| 不得扩大批次 | `max_items` 上限由服务端策略决定，工具层截断 |
| 不得修改安全策略 | 工具清单里**没有**任何修改策略的工具 |
| 不得触发急停 | 工具清单里**没有**急停工具 |
| 遇验证码必须停 | `get_account_health` 返回 `circuit.open=true`；`review_batch` 返回空批次 |

---

## 七、实现顺序建议

工具不要一次全做。按依赖与风险排序：

| 顺序 | 工具 | 理由 |
|---|---|---|
| 1 | T-03 `get_account_health`、T-01 `query_leads`、T-02 `get_stats` | 只读、无风险，先把"Agent 能看数据"打通 |
| 2 | T-06 `review_batch` + T-07 `approve_batch` | **核心闭环**。先不做 LLM 生成，只用规则生成候选，验证"Agent 审批"这条路走得通 |
| 3 | T-04 `analyze_comments` | 引入第一个 LLM 能力（意图识别），风险低、收益直接 |
| 4 | T-05 `draft_replies` | 最后做，因为涉及内容生成的风险最高 |
| 5 | T-08 `explain_failure` | 随时可加 |

> **建议第 2 步先不做任何 LLM 生成。** 让 Agent 在纯规则生成的候选上做审批，先确认"审批式 Agent"这个交互形态商家接受、且系统稳定。**这能让你在最小风险下验证整个方案 B 的核心假设。**

---

## 八、自检清单

实现完成后逐项确认：

- [ ] 工具清单里**没有**细粒度 CDP 操作（无 `click`/`type`/`scroll`/`evaluate`）
- [ ] 工具清单里**没有**修改安全策略的工具
- [ ] 工具清单里**没有**急停工具
- [ ] `approve_batch` 的 `action` 只有 `approve`/`reject`/`skip`，**不能改内容、不能换目标**
- [ ] `approve_batch` 会**独立重新执行**全部安全校验，不信任 Agent 审批结果
- [ ] `review_batch` 只返回已通过安全校验的候选，且条数受服务端策略约束
- [ ] 所有有副作用的工具**幂等**（尤其 `approve_batch` 按 `batch_id` 幂等）
- [ ] 每次决策落盘完整记录，含 `model.version` 与 `prompt_version`
- [ ] 任务状态**落盘**，不依赖对话历史
- [ ] `intent` 与 `reason_code` 是**闭集枚举**
- [ ] `complaint` / `irrelevant` 由**代码**排除出待发批次，不依赖 Agent 判断
- [ ] 内容生成默认关闭，`source: "generated"` 需商家显式开启
- [ ] 所有生成的候选**经过相似度检测**才能进入审批

---

*本文件是方案 B 的核心设计。改动工具粒度前请重新评估第二节的三条检验与第六节的硬规则。*
