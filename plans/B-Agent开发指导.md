# 方案 B · 专用 Agent 开发指导

> **本文件是方案 B 的主文档**，面向实施方案 B 的开发工程师与 AI 编码智能体。
> **前置条件（不可跳过）**：方案 A 的底座已完成，见 `README-DEV.md` §六 路径 3。
>
> **核心设计的唯一定稿来源是 `plans/B-工具契约与粒度设计.md`。** 本文只做展开与实现指导，
> **不新增、不删除、不修改任何工具语义**；两者冲突时以该文档为准。
>
> 配套：`plans/B-工具契约与粒度设计.md`（契约）· `plans/B-评估集与成本模型.md`（评估与成本）· `plans/B-与方案A的差异说明.md`（增量改动）

---

## 一、方案 B 是什么

### 1.1 定义

> **方案 B = 方案 A 的完整底座 + 一层"只审批、不发送"的对话式 Agent。**

商家从"填表单、点按钮"变为"用自然语言下指令"，由 Agent 编排一组**粗粒度业务工具**完成查询、分析、审批、汇报。
**所有真实发送仍由既有代码执行，走完整安全护栏。**

### 1.2 架构原则（唯一一条，也是全部安全性的基础）

> ### Agent 永远不直接发送。它只能审批系统预筛过的队列。

| 角色 | 职责 | 不允许做什么 |
|---|---|---|
| **代码** | 预筛候选（含全部安全校验）→ 生成候选回复（优先匹配商家话术池 + 相似度检测）→ 执行发送（走完整护栏） | 不把硬规则判定交给模型 |
| **Agent** | 挑掉不该回的、选更合适的话术、批准发送 | 不构造发送目标、不写文案直发、不改安全参数、不扩大批次 |

四条设计理由（`plans/B-工具契约与粒度设计.md` §一）：
① **硬规则不能交给概率模型**——观察期禁发、日上限、最小间隔是硬约束，护栏必须是代码里的 `if`；
② **成本可控**——批处理一次决策处理 N 条，而非每条一次推理；
③ **可审计**——决策输入是有限候选集，输出是"批准 + 选择"，可完整落盘；
④ **降级安全**——Agent 不可用时退化为方案 A 继续工作。

### 1.3 与方案 A 的关系：B ≈ A + Agent 层，共享约 80% 代码

| 组成 | A | B |
|---|---|---|
| 授权中心、契约、计费、审计、策略下发 | ✅ | ✅ **原样复用，零改动** |
| `client/core/` `client/platform/` `client/license/` | ✅ | ✅ **原样复用** |
| `client/adapters/` | 内部流水线 | 🔧 **暴露"预筛候选"能力供工具包装** |
| `client/safety/` | 护栏 | 🔧 **新增拦截 Agent 越权意图的一层** |
| `client/ui/` 图形界面 | ✅ | ✅ **保留，作为降级路径** |
| 对话界面 + Agent 运行时 + 工具层 | — | 🆕 **新增** |

> ### ⚠️ B 不能跳过 A 的底座
> ① Agent 调用的全部工具最终落到 `adapters/` 与 `safety/`；这些不存在，工具层无物可包。
> ② 计费与审计口径（红线 2、红线 3）已由 A 的服务端契约固化；B 的每次决策要挂到同一套审计上，
> 没有 A 就没有可挂载的审计通道。
> ③ **只有 A 能回答"裸 CDP 驱动抖音这条路走不走得通"**（P2 验证门 G-1~G-5）。
> B 用同一套 CDP 驱动，A 走不通则 B 一样走不通，且 B 还多一层成本。

### 1.4 适用与不适用

**适用**：已跑通 A 且有数据表明关键词规则召回不足；商家接受"Agent 审批 + 人工可介入"的形态；
定价空间能覆盖 token 成本（见评估集文档 §五）；团队具备 LLM 应用经验。
**不适用**：规则召回率已足够（先跑一个月 A，用导出数据判断，不要凭感觉）；商家对"模型参与决策"有合规或心理阻力；
单价空间无法覆盖 token 成本；P2 验证门未通过。

---

## 二、架构总览

### 2.1 分层关系

```
╔══════════════════════════════════════════════════════════════════════════╗
║  Agent 层（🆕 仅 B 有）—— 只产出「工具调用请求」与「汇报」，不产出发送动作    ║
║  client/agent/runtime.js      循环：指令 → 规划 → 调工具 → 观察 → 汇报      ║
║  client/agent/model-client.js 模型接入抽象（provider/model 可配）          ║
║  client/agent/prompts/        系统提示词与版本管理（prompt_version）        ║
║  client/agent/planner.js      决策记录构造与落盘（decision_id）             ║
║  client/agent/context.js      每轮从落盘状态重建上下文                       ║
║  client/agent/token-budget.js 单次交互 token 预算与熔断                     ║
╚═════════════════════════════════╤════════════════════════════════════════╝
                                  │ 结构化工具调用（JSON 参数）
╔═════════════════════════════════▼════════════════════════════════════════╗
║  工具层（🆕 仅 B 有）—— 是「包装」而非「重新实现」，内部只调既有模块         ║
║  client/tools/registry.js     工具注册表：名称/描述/JSON Schema/权限级别     ║
║  client/tools/  query-leads · get-stats · get-account-health              ║
║                 analyze-comments · draft-replies                          ║
║                 review-batch · approve-batch · explain-failure            ║
║  client/tools/validate.js     ⚠️ 参数校验（不信任模型传参）                  ║
║  client/tools/audit.js        ⚠️ 每次工具调用落审计                         ║
╚═════════════════════════════════╤════════════════════════════════════════╝
                                  │ 进程内调用（不经 HTTP 转发）
╔═════════════════════════════════▼════════════════════════════════════════╗
║  既有底座（方案 A 交付，B 零改动或微改）                                     ║
║  client/adapters/  collect · reply-comment · reply-danmaku · send-dm      ║
║  client/safety/    guard · similarity · circuit · audit                   ║
║  client/core/      cdp.js（全项目唯一一份）· browser-host.js · ipc.js      ║
║  client/platform/  selectors.js（唯一来源）· page-* · publish-verifier    ║
║  client/license/   auth · heartbeat · reporter · sign                     ║
║  client/host/      api · scheduler · store（单写者 + 原子写）· instances    ║
╚═════════════════════════════════╤════════════════════════════════════════╝
                                  │ CDP :9222+N
                                  ▼
                      商家本机专用 Chrome（已登录抖音账号）
```

### 2.2 一次交互的完整时序

用户说：**"帮我看看南京这边问价格的，挑几个回一下，别超过 10 个"**

```
┌──────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐    ┌────────────────┐
│ 用户 │    │ 对话界面 │    │  Agent  │    │  工具层  │    │ 底座 adapters  │
│      │    │ client/ui│    │ runtime │    │ client/  │    │ safety         │
│      │    │          │    │         │    │ tools/   │    │ host/scheduler │
└──┬───┘    └────┬─────┘    └────┬────┘    └────┬─────┘    └───────┬────────┘
   │"…别超过10个"│               │              │                  │
   ├────────────►│ POST /api/agent/chat         │                  │
   │             ├──────────────►│              │                  │
   │             │               │ ① 从落盘状态重建上下文（不依赖历史消息）
   │             │               │ ② 模型推理 → T-03 get_account_health()
   │             │               ├─────────────►├─────────────────►│ 读 policy.json
   │             │               │◄─────────────┤◄─────────────────┤
   │             │               │  {sending_enabled:true, remaining:{comment:28}}
   │             │               │ ③ T-01 query_leads({intent:"price_inquiry",
   │             │               │      region:"南京", limit:50})
   │             │               ├─────────────►├─────────────────►│ 只读线索库(脱敏)
   │             │               │◄─────────────┤  {total:17, leads:[…]}
   │             │               │ ④ T-06 review_batch({max_items:10})
   │             │               ├─────────────►│ ⚠️ 代码预筛：guard 额度/间隔、
   │             │               │              │  similarity 去重、circuit 熔断、
   │             │               │              │  排除 complaint / irrelevant
   │             │               │              ├─────────────────►│
   │             │               │◄─────────────┤◄─────────────────┤
   │             │               │  {batch_id:"b-8f2a", items:[10 条，每条含
   │             │               │   draft_options[3]、recommended_draft_id、
   │             │               │   safety 全通过], expires_at_ms}
   │             │               │ ⑤ 模型决策（一次推理覆盖整批 N 条）
   │             │               │    approve / reject / skip + 选 draft_id
   │             │               │ ⑥ T-07 approve_batch({batch_id, decisions})
   │             │               ├─────────────►│ ⚠️ 独立重新执行全部安全校验：
   │             │               │              │  draft_id ∈ 候选？批次过期？
   │             │               │              │  额度/间隔/熔断？（不信任 Agent 审批）
   │             │               │              ├─────────────────►│ 队列 → scheduler
   │             │               │              │                  │ 逐条走完整护栏：
   │             │               │              │                  │ send_id 发送前落盘
   │             │               │              │                  │ publish-verifier
   │             │               │              │                  │ 嗅探平台响应体
   │             │               │◄─────────────┤◄─────────────────┤
   │             │               │  {accepted, rejected, skipped, queued_send_ids, blocked[]}
   │             │               │ ⑦ 落盘 decision_id（含 model / prompt_version /
   │             │               │    policy_version / usage / latency_ms）
   │             │◄──────────────┤ ⑧ 自然语言汇报
   │◄────────────┤ "看了南京 17 条询价，挑了 7 条回复（已投递），3 条是投诉或
   │ 汇报+可展开  │  无关内容没有回，1 条因为发送间隔限制没发出去。"
   │ 的决策明细   │
```

### 2.3 数据流方向与职责边界

| 层 | 输入 | 输出 | 明确不做什么 |
|---|---|---|---|
| 对话界面 | 用户自然语言 | HTTP → `client/host/api.js` | 不直连模型，不持有 API Key |
| Agent 运行时 | 用户指令 + 落盘状态 + 工具返回 | 工具调用请求 / 汇报文本 | **不产出发送动作**，不碰 CDP，不直接碰盘 |
| 工具层 | 结构化参数 | 结构化结果 | 不实现 CDP 逻辑；参数校验失败即拒绝；每次调用落审计 |
| 底座 | 业务动作 | `StepResult{ok, stage, reason}` | 不感知 Agent 存在 |

**三条不可逆的数据流规则**：
① **Agent → 工具**只有结构化 JSON，模型不能传任意字符串当"动作"。
② **工具 → 底座**读状态必须经 `client/host/store.js`（单写者 + 原子写），**禁止工具自己 `fs.writeFileSync`**
（违反 `shared/术语与选型基准.md` §3.4）。
③ **发送结果 → Agent**只能是**已发生的事实**（`queued_send_ids` / `blocked`），Agent 不能"要求"某条必须成功。

---

## 三、工具层实现

> **完整契约（工具清单、参数、返回结构、约束）见 `plans/B-工具契约与粒度设计.md` §三。本节只讲"怎么实现"，不重复契约。**

### 3.1 工具是包装既有 adapters，不是重新实现

```
❌ 错误：client/tools/review-batch.js 里自己写 Runtime.evaluate 去页面读评论
✅ 正确：工具只做三件事——取数 → 组织 → 校验
   review-batch.js
     → adapters/collect.js 的 listPendingCandidates()   // 取候选
     → safety/guard.js      checkSendable()             // 额度/间隔/时段/观察期
     → safety/circuit.js    isOpen()                    // 熔断
     → safety/similarity.js checkContent()              // 相似度
     → 组织成契约定义的 batch 结构返回
```

**为支持工具，`client/adapters/` 需要新增的读取型出口**（方案 A 中它们是流水线内部步骤）：

| 出口 | 建议位置 | 用途 | 工具 |
|---|---|---|---|
| `listPendingCandidates({source_type, max_items})` | `adapters/collect.js` | 已过规则筛选、待审批的候选线索 | T-06 |
| `listLeads({intent, region, …})` | `adapters/collect.js` | 只读线索库查询（脱敏摘要） | T-01 |
| `listFailures({…})` | `adapters/collect.js` | 读取失败归因记录 | T-08 |
| `enqueueApproved({batch_id, items})` | `adapters/reply-*.js` 统一入口 | 把批准项投递到发送队列 | T-07 |

> ⚠️ 这些是**新增读取型方法**，不是把 adapters 拆开重写。方案 A 的流水线逻辑保持原样，只是多一个入口暴露中间结果。

### 3.2 工具注册与 schema 定义

`client/tools/registry.js` 是**工具清单的唯一来源**，必须与契约 §三 逐条对应，**不多不少正好 8 个**。

```js
// client/tools/registry.js —— 普通 JavaScript（CommonJS），无 TypeScript
'use strict'

const TOOLS = [
  {
    name: 'get_account_health',
    tier: 'readonly',            // readonly | generate | execute
    danger: 0,                   // 0 只读 / 1 消耗推理 / 2 有副作用
    description: '查询账号当前状态：等级、天数索引、各渠道今日剩余额度、是否熔断、是否观察期。'
               + '这是判断"现在能不能干活"的唯一依据，不得自行推断。',
    inputSchema: {
      type: 'object',
      properties: { instance_id: { type: 'string', description: '省略则用当前实例' } },
      additionalProperties: false,
    },
    handler: require('./get-account-health'),
  },
  {
    name: 'review_batch',
    tier: 'readonly',
    danger: 0,
    description: '拉取系统预筛好的待发批次供审批。只返回已通过全部安全校验的候选。',
    inputSchema: {
      type: 'object',
      properties: {
        source_type: { type: 'string', enum: ['comment', 'live_danmaku', 'dm'] },
        max_items: { type: 'integer', minimum: 1, maximum: 'SERVER_POLICY' },  // 上限由服务端策略定
      },
      additionalProperties: false,
    },
    handler: require('./review-batch'),
  },
  {
    name: 'approve_batch',
    tier: 'execute',
    danger: 2,
    description: '提交审批结果。唯一的写入型执行工具。action 只有 approve/reject/skip。',
    inputSchema: {
      type: 'object',
      required: ['batch_id', 'decisions'],
      properties: {
        batch_id: { type: 'string' },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['item_id', 'action'],
            properties: {
              item_id: { type: 'string' },
              action: { type: 'string', enum: ['approve', 'reject', 'skip'] },
              draft_id: { type: 'string' },
              reason: { type: 'string', maxLength: 120 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: require('./approve-batch'),
  },
  // …T-01 T-02 T-04 T-05 T-08 同理
]

module.exports = { TOOLS }
```

**schema 实现注意**：
① 依赖白名单只有 `ws`，**不能引入 `ajv`**。用约 80 行手写校验器 `client/tools/validate.js`，只支持本项目用到的子集：
`type` / `required` / `enum` / `minimum` / `maximum` / `maxLength` / `items` / `additionalProperties`。
② `maximum: 'SERVER_POLICY'` 是占位标记，实现时替换为**运行时从 `policy` 读取的值**，
**绝不允许写成字面量**（红线 1；`AGENTS.md` §2.2）。

### 3.3 ⚠️ 参数校验在工具层：不信任模型传参

模型可能传错类型、传超范围、传候选外的 ID，甚至被提示注入诱导传恶意参数。
**校验必须在工具层做，且校验失败一律拒绝执行，不做"容错修正"。**

```js
// client/tools/validate.js（节选）
'use strict'

function validateArgs(schema, args) {
  const errors = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: ['args 必须是对象'] }
  }
  // ① 拒绝未声明字段：防止模型塞入 draft_text / send_now / daily_max 之类的越权字段
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(args)) {
      if (!schema.properties || !(k in schema.properties)) errors.push('未知字段: ' + k)
    }
  }
  // ② 逐字段类型与范围校验
  for (const [name, spec] of Object.entries(schema.properties || {})) {
    const v = args[name]
    if (v === undefined) {
      if ((schema.required || []).includes(name)) errors.push('缺少必填字段: ' + name)
      continue
    }
    if (spec.enum && !spec.enum.includes(v)) errors.push(name + ' 不在闭集枚举内')
    if (spec.type === 'integer' && !Number.isInteger(v)) errors.push(name + ' 必须是整数')
    if (spec.type === 'string' && typeof v !== 'string') errors.push(name + ' 必须是字符串')
    if (spec.type === 'string' && spec.maxLength && v.length > spec.maxLength) errors.push(name + ' 超长')
    if (typeof v === 'number') {
      const max = spec.maximum === 'SERVER_POLICY' ? Number.MAX_SAFE_INTEGER : spec.maximum
      if (spec.minimum !== undefined && v < spec.minimum) errors.push(name + ' 小于下限')
      if (max !== undefined && v > max) errors.push(name + ' 大于上限')
    }
  }
  return { ok: errors.length === 0, errors }
}

module.exports = { validateArgs }
```

**七个必须由工具层独立强制（不看模型脸色）的点**：

| # | 校验点 | 失败行为 |
|---|---|---|
| 1 | 未知参数一律拒绝（`additionalProperties:false`） | 返回参数错误，不执行 |
| 2 | `max_items` 超服务端策略上限 → **截断到上限**（不报错，但记审计） | 按上限执行 |
| 3 | `analyze_comments.lead_ids` 长度 > 50 → 拒绝 | 提示分批（单批上限 50） |
| 4 | `draft_replies.max_per_lead` > 5 → 拒绝；缺省填 3 | 拒绝 / 填默认 |
| 5 | `approve_batch.decisions` 的 `draft_id` 必须在**本批次** `draft_options` 内 | 该条 `blocked`，`AGENT_DRAFT_NOT_IN_CANDIDATES` |
| 6 | `intent` / `reason_code` 必须在闭集枚举内 | 拒绝 |
| 7 | 任何"疑似安全参数"字段名（`daily_max` / `min_interval_ms` / `similarity_max` / `send_now` / `pause_engine`） | 拒绝并记安全审计 |

### 3.4 权限与审计：所有工具调用都要落审计

**每一次工具调用**（无论成功、失败、被参数校验拒绝）都必须落一条审计记录。这是红线 3 在方案 B 的延伸。

```js
// client/tools/audit.js（节选）
'use strict'
const store = require('../host/store')

function recordToolCall({ tool, argsDigest, ok, code, latencyMs, promptVersion }) {
  return store.appendInstanceJson('tool_audit.json', {
    ts_ms: Date.now(),
    tool,                       // 工具名（闭集）
    args_digest: argsDigest,    // ⚠️ 只存参数摘要，不存原文
    ok,                         // 布尔
    code: code || null,         // 阻断码或参数错误码
    latency_ms: latencyMs,
    prompt_version: promptVersion,
    // 绝不写入：评论原文、回复原文、昵称、sec_uid、任何完整 URL
  })
}

module.exports = { recordToolCall }
```

| 审计项 | 记录内容 | 理由 |
|---|---|---|
| 工具名 + 参数摘要 | 白名单字段的取值/哈希，**不外传原文** | 可复现"Agent 当时传了什么" |
| 结果码 | `ok` 或阻断码（契约 §3.4 闭集） | 可统计"Agent 被拦了多少次" |
| 耗时 | `latency_ms` | 定位是工具慢还是模型慢 |
| `prompt_version` | 当时生效的提示词版本 | 与决策记录同源，保证可复现 |

**双写要求**：本地 `tool_audit.json` 保留全量；服务端只上报**计数与哈希**（红线 3 隐私边界）。
上报**复用既有通道**（`POST /api/v1/usage/report` 计数类、`POST /api/v1/audit/config-changes` 策略相关），
**不新增服务端接口**。详见 §7.2。

---

## 四、Agent 运行时

### 4.1 循环设计

```
client/agent/runtime.js

① 接收指令   从 client/host/api.js 收到 { session_id, user_text }
      │
② 重建上下文 ⚠️ 从落盘状态重建（agent_task.json / agent_batch.json / decision_log.jsonl），
      │         不依赖对话历史
③ 规划       组装 messages = [system(prompt_version), 状态摘要, 指令] → model-client.chat()
      │
④ 判定       模型返回 tool_call？ ├─ 是 → ⑤
      │                            └─ 否 → ⑧ 直接汇报
⑤ 校验+执行  validateArgs → registry 分发 → 工具执行
      │        ⚠️ 校验失败也回给模型一个结构化错误，让它自己纠正
⑥ 观察       把工具结果（已裁剪为最小必要字段）追加进 messages；round++
      │        若 round > MAX_TOOL_ROUNDS → ⑧ 以 ROUND_LIMIT 结束
⑦ 回到 ③
      │
⑧ 落盘+汇报 写 decision_log.jsonl → 生成汇报文本 → 返回前端
```

### 4.2 ⚠️ 循环上限（防止无限循环烧钱）

| 项 | 建议值 | 说明 |
|---|---|---|
| `MAX_TOOL_ROUNDS` | **12** | 单次用户交互内最多 12 轮工具调用，超出即停止并汇报已完成部分 |
| `SOFT_WARN_ROUNDS` | 8 | 到 8 轮时注入系统消息"请收敛，尽快给出结论" |
| `MAX_WALL_CLOCK_MS` | 180000（3 分钟） | 用 `process.hrtime.bigint()` 计算，不用墙钟时间 |
| `MAX_TOKENS_PER_INTERACTION` | 配置项 | 见 §8.4；耗尽即停止并汇报 |

```js
// client/agent/runtime.js（节选）
async function runInteraction({ sessionId, userText }) {
  const ctx = await rebuildContextFromDisk(sessionId)   // ③ 的状态来源
  const startedAt = process.hrtime.bigint()
  let round = 0
  const budget = budgetFor(ctx)

  while (true) {
    if (round >= MAX_TOOL_ROUNDS) return finish(ctx, 'ROUND_LIMIT')
    if (elapsedMs(startedAt) > MAX_WALL_CLOCK_MS) return finish(ctx, 'TIMEOUT')
    if (budget.exhausted()) return finish(ctx, 'BUDGET_EXHAUSTED')

    const reply = await modelClient.chat(ctx.messages)
    budget.consume(reply.usage)
    if (!reply.toolCall) return finish(ctx, 'DONE', reply.text)

    const verdict = tools.invoke(reply.toolCall, { promptVersion: ctx.promptVersion })
    ctx.messages.push(tools.asToolResult(reply.toolCall.id, verdict))
    round++
  }
}
```

**超限时的汇报要求**：必须明确告知"没做完"并给出已完成进度，**不得静默截断**。
例如："我只完成了 8 条中的 6 条审批，因为单次处理轮次已达上限。已批准并投递 6 条，剩余 2 条可以说'继续'。"

### 4.3 超时与中断处理

| 场景 | 行为 |
|---|---|
| 模型请求超时 | 退避重试 1 次（2 秒）；仍失败 → 汇报"模型服务无响应"，**不执行任何未经审批的发送** |
| 单个工具执行超时 | adapters 已有超时 → 返回结构化错误给模型，模型可换策略或汇报 |
| 用户点"停止" | `POST /api/agent/stop` 置中断标志；**当前工具调用跑完即停**（不中断 CDP 操作中途，避免留下半完成状态） |
| 进程崩溃 / 断电 | 状态已落盘；重启后提示"上次任务未完成，是否继续" |
| 审批过程中用户点了急停 | 急停优先级最高：`approve_batch` 的二次校验因 `POLICY_SENDING_DISABLED` 全部 `blocked`，Agent 汇报"发送已被急停关闭" |

> ⚠️ **Agent 没有急停工具**（契约 §二 反模式清单）。急停是人在界面上的动作，通过既有 UI 按钮触发。

### 4.4 错误处理：工具返回错误时 Agent 应如何反应

在**系统提示词**中约定（见 §5.2），并在**代码**中把错误结构化返回：

| 工具错误 | 期望 Agent 行为 | 代码层的保证 |
|---|---|---|
| 参数校验失败（如 `max_items` 超上限） | 用合法参数重试**一次** | 返回 `{ok:false, code:'INVALID_ARGS', hint:'max_items 上限为 N'}` |
| `AGENT_BATCH_EXPIRED` | **不重试**，重新调 `review_batch` 取新批次 | 工具层拒绝过期批次并给出新批次提示 |
| `POLICY_SENDING_DISABLED` | **立即停止**，向用户解释处于观察期/已停发 | `review_batch` 直接返回空批次；`approve_batch` 全部 `blocked` |
| `POLICY_CIRCUIT_OPEN` | **立即停止**，告知熔断原因与恢复时间 | `get_account_health().circuit` 提供 `reason` 与 `cooldown_until_ms` |
| `POLICY_DAILY_CAP` | 停止，告知今日额度已用完 | 二次校验拦截 |
| `SAFETY_SIMILARITY_BLOCKED` / `SAFETY_INTERVAL_TOO_SHORT` | 如实汇报"这条没发出去及原因"，**不得尝试绕过** | 主进程强制 |
| `AGENT_DRAFT_NOT_IN_CANDIDATES` | 从候选池重新选择，或 `reject` | 工具层拒绝候选外 draft |
| 工具内部异常 | 汇报"工具执行失败"并给出 `reason`，**不臆测原因** | 统一包装为 `{ok:false, code, message}` |
| 被限流（`RATE_TOO_MANY_REQUESTS`） | 按 `POLICY_DAILY_CAP` 语义汇报"系统繁忙，请稍后再试"，不密集重试 | 工具层退避 |

**代码侧的硬性保证**：无论模型怎么"想"，工具返回值只可能来自上述闭集；
`approve_batch` 的 `blocked[]` 是**最终事实**，Agent 无法通过多试几次改变它。

### 4.5 模型接入抽象（为将来换模型留口）

**目标**：可配置 provider/model，且**不引入白名单外的依赖**（`AGENTS.md` §2.14）。

```js
// client/agent/model-client.js
'use strict'
// ⚠️ 统一接口：任何 provider 都必须实现 chat() 与 describe()
// 输入输出均为纯 JSON 可序列化对象，不含任何厂商特有类型
async function chat({ messages, tools, temperature, maxTokens, timeoutMs }) {
  const cfg = require('../host/store').getAgentConfig()   // provider/base_url/model/api_key
  const adapter = ADAPTERS[cfg.provider]
  if (!adapter) throw new Error('未知 provider: ' + cfg.provider)
  const t0 = process.hrtime.bigint()
  const raw = await adapter.request({ ...cfg, messages, tools, temperature, maxTokens, timeoutMs })
  const usage = adapter.extractUsage(raw)
  return {
    text: adapter.extractText(raw),
    toolCall: adapter.extractToolCall(raw),          // { id, name, args } 或 null
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output },  // ⚠️ 归一化厂商差异
    model: { provider: cfg.provider, model: cfg.model, version: adapter.extractVersion(raw) },
    latency_ms: Number(process.hrtime.bigint() - t0) / 1e6,
  }
}

// 每个 adapter 只做三件事：拼请求体、发 HTTPS（内置 node:https）、把响应映射到统一结构
const ADAPTERS = { /* 具体路径与字段名按实际接入的 API 文档填写 */ }

module.exports = { chat }
```

**配置项**（`instances/<账号ID>/agent_config.json`，经 `store.js` 读写）：

| 字段 | 说明 |
|---|---|
| `enabled` | Agent 总开关。**默认 `false`**，需商家在设置中显式开启并勾选风险确认（见 §12 冲突项 C-1） |
| `provider` / `base_url` / `model` | 接入目标，可换 |
| `api_key` | ⚠️ 存本地受保护文件；**不得写入日志、不得上传、不得进入审计** |
| `temperature` | 建议 **0.2**（决策类任务要稳定，不要创造性） |
| `max_tokens_per_interaction` / `max_tokens_per_day` | 预算，见 §8.4 |
| `prompt_version` | 当前生效的提示词版本（§5.4） |
| `allow_generated_drafts` | 是否允许 `source:"generated"` 候选，**默认 `false`**（契约 §3.2 T-05 要求） |

### 4.6 ⚠️ Agent 不可用时的降级路径

Agent 是**增值层**，不是必需层。任何一环故障都必须能退回方案 A 继续工作。

```
                  ┌────────────────────────────┐
                  │ 正常运行：Agent 审批 + 发送 │
                  └──────────────┬─────────────┘
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│ L1 模型服务不可用 │  │ L2 成本超预算     │  │ L3 运行时报错/循环超限  │
│ 超时/鉴权失败/    │  │ 日预算耗尽        │  │ 工具异常/上下文异常     │
│ 配额耗尽          │  │                  │  │                        │
├──────────────────┤  ├──────────────────┤  ├────────────────────────┤
│ 自动切「无 Agent  │  │ 关闭 T-04/T-05   │  │ 单次交互终止，状态落盘，│
│ 审批模式」：       │  │ （LLM 生成能力）  │  │ 提示"本次未完成，进度  │
│ 候选仍由代码预筛 + │  │ 只保留规则候选 +  │  │ 已保留。可继续，或到    │
│ 规则选话术，人工   │  │ 人工在图形界面    │  │ 图形界面手动处理。"     │
│ 在图形界面一键     │  │ 一键批量确认      │  │                        │
│ 批量确认          │  │ → 等价于方案 A    │  │ → 不丢状态，不重复发送  │
└──────────────────┘  └──────────────────┘  └────────────────────────┘
        └────────────────────────┼────────────────────────┘
                                 ▼
              ┌────────────────────────────────────┐
              │ 最终兜底：完整方案 A 图形界面       │
              │ （保留原 UI，功能不缺失）           │
              └────────────────────────────────────┘
```

**降级的三条硬性要求**：
① **不丢数据**——候选批次、`send_id`、任务状态都在盘上；降级后人工审批走**同一份** `batch_id`。
② **不改口径**——无论谁审批，`approve_batch` 的二次校验与发送护栏完全一致，**不存在"人工审批就放松校验"**。
③ **必须可见**——UI 明确显示当前降级级别与原因，不许静默降级（旧代码 D-14"演示假数据不清除"就是静默失真的反面教材）。

---

## 五、提示词工程

### 5.1 提示词与代码的双重保证（先说结论）

> ### ⚠️ 只写提示词是不够的。

| | 提示词的作用 | 代码的作用 |
|---|---|---|
| 定位 | 让模型**知道**边界，减少无意义的越权尝试，提高决策质量 | **强制拦截**越界行为 |
| 特性 | 概率性，可能不遵守 | 确定性，一定拦得住 |
| 失效场景 | 提示注入、模型版本变化、长上下文遗忘 | 不会失效（除非代码有 bug） |

**§5.2 的每一条约束，都必须在 §7.1 的表格里找到对应的代码强制点。**
只有提示词 = 没有护栏；只有代码 = 模型反复撞墙，浪费轮次与 token。

### 5.2 系统提示词的完整内容

以下为可直接使用的系统提示词（`client/agent/prompts/system.p-1.0.0.md`）。
**修改它必须同步升 `prompt_version`**（§5.4）。

```text
# 角色

你是「抖音自动回复工作台」里的审批助手。你服务的对象是使用本工具的商家。

你的定位只有一句话：

    你不发送任何东西。你只审批系统已经替你筛好的队列。

系统（代码）已经完成了这些事：
  · 从评论区/直播间/私信里筛出值得回复的候选
  · 对每条候选做完配额、间隔、时段、熔断、相似度等全部安全校验
  · 从商家的话术池里为每条候选匹配好 1~3 条候选话术

你做的事只有三件：
  1. 挑掉不该回复的（例如负面情绪、无关灌水、语义明显不合适的）
  2. 在候选话术里挑一条最贴合这条评论语气的
  3. 批准、否决或跳过

# 三条红线（不可违背，也不可试探）

红线 1：安全上限由服务端下发，客户端只能调低。
  · 观察期（第 1-3 天）日上限为 0，只采集不发送，不可跳过。
  · 你无法、也不需要修改任何上限、间隔、相似度阈值。你没有这样的工具。
  · 如果你觉得"额度太少了"，请如实告诉商家当前额度，不要试图提高它。

红线 2：只对平台确认成功的发送计费。
  · 你不需要判断"是否发送成功"。发送由系统执行，成功判定由平台响应体决定。
  · 你只需要如实汇报系统告诉你的结果。

红线 3：审计记录真实生效的策略值。
  · 你的每一个决策都会被记录下来，用于事后举证。
  · 因此你的 reason 必须真实反映你的判断理由，不要写套话。

# 你的能力边界（硬约束）

你**只能**通过提供的工具工作。你没有、也不会有以下能力：
  · 点击页面、输入文字、滚动页面、执行页面脚本（没有这类工具）
  · 修改每日上限、发送间隔、相似度阈值、活跃时段（没有这类工具）
  · 直接写一条话术并发送（没有这类工具）
  · 扩大一个批次的数量上限（该上限由服务端策略决定，你传更大的值会被截断）
  · 紧急停止系统（急停是商家在界面上的按钮，不是你的工具）

具体约束：
  · approve 时必须给出 draft_id，且该 draft_id 必须来自本次 review_batch 返回的候选。
    你**不能**自己写文案，**不能**改写候选文案，**不能**拼接候选文案。
  · action 只有 approve / reject / skip 三种。没有"换一个目标"。
  · 你**不能**把同一批次里的 draft_id 挪给另一条 item。
  · 批次有 expires_at_ms，过期后必须重新拉取，不要复用旧批次。
  · 你的审批不等于发送。系统会对每一条独立重新执行全部安全校验；
    被拦下的会出现在 blocked 里，那是最终事实，请如实汇报，不要重试。

# 工作方法

1. 先确认现在能不能干活。
   在涉及发送的任务开始前，先调用 get_account_health。
   如果 sending_enabled 为 false、collect_only 为 true，或 circuit.open 为 true，
   **立即停止并如实告知商家**，不要继续调用审批工具。

2. 用量化的意图值，不要自己"理解"意图。
   线索的 intent 是之前由系统批量分析后入库的闭集值
   （price_inquiry / feature_inquiry / purchase_intent / support_inquiry / complaint /
     irrelevant / unknown）。查询时用这些值，不要用自然语言描述去猜。

3. 优先批量，不要逐条。
   一次 review_batch 可以拿到一批候选，一次决策给出这一批的全部结果。
   批量决策更省成本，也更一致。

4. 投诉与无关内容不回复。
   系统通常已经把 complaint 和 irrelevant 排除了；如果你仍然看到这类内容，
   用 reject 并写清楚原因。绝不在负面评论下自动回复。

5. 拿不准就 skip，不要 approve。
   skip 的意思是"跳过，交给商家人工看"，它比误批安全得多。

6. 遇到错误按类型处理。
   · 参数错误 → 用合法参数重试一次
   · 批次过期 → 重新拉取新批次
   · 策略类阻断（观察期/额度/熔断）→ 立即停止，如实告知
   · 安全类阻断（相似度/间隔/候选外文案）→ 如实汇报，绝不尝试绕过
   · 工具异常 → 汇报"工具执行失败"，不要猜测原因

7. 不要为了完成任务而降低标准。
   如果一批 10 条里有 8 条你都觉得不该回，就 reject 8 条。
   少回几条没有损失，回错一条有真实风险。

# 汇报格式

汇报面向商家，用中文，务实、简短、可核对。必须包含：
  1. 结论：批准了几条、否决了几条、跳过几条、实际投递几条
  2. 被拦下的：每条的原因（用系统返回的阻断原因，不要自己编）
  3. 未完成的：如果因为轮次/超时/预算没做完，明确说出来还剩多少

汇报示例：
  "看了 10 条候选，批准 7 条、否决 3 条，已投递 6 条。
   其中 1 条被系统拦下，原因是发送间隔不足，稍后会自动重试。
   否决的 3 条是投诉和无关内容。"

禁止在汇报里：
  · 说"已发出"除非系统返回的 queued_send_ids 里确实有它
  · 说"发送成功"（成功要等平台响应，你拿不到这个结论）
  · 承诺"不会被封号"
  · 复述评论原文超过 30 个字
```

### 5.3 ⚠️ 提示词与代码双重保证的逐条对照

实现完成后请逐行核对：

| 提示词约束 | 代码强制点 | 位置 |
|---|---|---|
| 不能改安全参数 | 工具清单里没有任何修改策略的工具；参数校验拒绝未知字段 | `registry.js` + `validate.js` |
| 不能自己写文案 | `approve_batch` 校验 `draft_id ∈ 本批次 draft_options` | `approve-batch.js` |
| 不能扩大批次 | `max_items` 按服务端策略截断 | `review-batch.js` |
| 观察期不能发 | `review_batch` 返回空批次；`approve_batch` → `POLICY_SENDING_DISABLED` | `review-batch.js` / `approve-batch.js` |
| 不能绕过间隔/相似度 | `approve_batch` 独立重跑 `guard` + `similarity` | `approve-batch.js` |
| 不能急停 / 不能碰 CDP | 无该工具 | `registry.js` |
| 汇报要如实 | 汇报文本与 `decision_log.jsonl` 同时落盘，UI 并列展示可核对 | `runtime.js` + 前端 |

### 5.4 提示词版本管理

```js
// client/agent/prompts/index.js
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PROMPT_VERSION = 'p-1.0.0'   // 语义化：主/次/修订
// 主版本：角色或安全边界变更 → 必须重跑评估集 + 人工复核
// 次版本：工作方法、汇报格式调整 → 必须重跑评估集
// 修订：措辞微调 → 可只跑冒烟

function loadSystemPrompt() {
  return fs.readFileSync(path.join(__dirname, 'system.' + PROMPT_VERSION + '.md'), 'utf8')
}
function promptDigest() {   // 审计用：证明"当时用的是哪一份提示词"
  return crypto.createHash('sha256').update(loadSystemPrompt()).digest('hex').slice(0, 16)
}

module.exports = { PROMPT_VERSION, loadSystemPrompt, promptDigest }
```

**版本纪律**：提示词文件按版本**留存历史**（`system.p-1.0.0.md` 与 `system.p-1.1.0.md` 并存），**不覆盖**；
`prompt_version` 必须写进每条决策记录（契约 §五）与每条工具审计；
**改提示词 = 必须重跑评估集**（评估集文档 §4.4）；提示词变更属"配置变更"，走既有审计通道留痕。

### 5.5 少样本示例（few-shot）建议

**建议 2~4 个，不要更多**（每多一条都进每轮固定成本，见 §8.1）。

| 示例 | 内容 | 目的 |
|---|---|---|
| F-1 典型批准 | 3 条候选评论 + 各自 3 个候选话术，其中一条语气明显更贴合 → 输出 `approve` + 正确的 `draft_id` | 教会"从候选池选最贴合的" |
| F-2 该否决不否决 | 一条语气带嘲讽的 `feature_inquiry` → `reject` + `reason:"语气负面，不宜自动回复"` | 教会语义判断的价值点 |
| F-3 该跳过不硬批 | 一条信息严重不足、无法判断语气的候选 → `skip` | 教会"拿不准就 skip" |
| F-4 被拦下的正确反应 | 工具返回 `blocked:[{code:'SAFETY_INTERVAL_TOO_SHORT'}]` → 汇报如实说明，**不重试** | 抑制"撞墙重试"烧钱 |

**放置位置**：放在系统提示词之后**独立的少量示例消息**里（不要塞进系统提示词正文，便于单独替换）。
**示例中的评论内容必须是伪造的脱敏样例**，不得使用真实用户内容（红线 3）。

---

## 六、状态管理

### 6.1 ⚠️ 反模式：把任务状态放在对话历史里

> 对话历史会被截断、会崩溃、会因上下文超限丢失。商家场景是"跑一整天、经常断网、浏览器会崩"——
> **把状态放在易失的地方等于任务会丢。**

| 故障 | 后果 |
|---|---|
| 上下文超限被截断 | 早期"已审批 3 条"的记录消失 → Agent 重复审批同批次 |
| 进程崩溃 | 任务进行到一半，重启后不知道批到哪儿了 |
| 用户关闭对话窗口 | 任务状态一起消失 |
| 多标签页同时开对话 | 两份对话历史互相矛盾 |

### 6.2 落盘的状态清单与位置

全部经 `client/host/store.js`（**单写者 + 原子写 + `schemaVersion`**）读写，路径在实例目录下。

| 状态 | 文件 | 关键字段 | 写入时机 |
|---|---|---|---|
| 任务状态 | `instances/<ID>/agent_task.json` | `task_id, status(pending/running/done/failed), user_text, created_at_ms, updated_at_ms, rounds_used, tokens_used, locked_by` | 每轮工具调用后 |
| 审批批次 | `instances/<ID>/agent_batch.json` | `batch_id, item_ids[], expires_at_ms, pulled_at_ms, decisions[]` | `review_batch` 返回时、`approve_batch` 提交时 |
| 决策记录 | `instances/<ID>/decision_log.jsonl` | 契约 §五 全部字段 | 每次决策结束 |
| 工具审计 | `instances/<ID>/tool_audit.json` | §3.4 字段 | 每次工具调用 |
| 发送记录 | `instances/<ID>/pending_sends.json` | `send_id` 等（红线 2 要求**发送前**写入） | 发送前 |
| 对话历史 | 内存 + 可选 `agent_chat.json` | 消息数组 | **仅作推理材料，不承载状态** |

> ⚠️ `pending_sends.json` 是方案 A 的既有产物，**B 不得绕过**。Agent 审批只产生"入队"，
> 真正的 `send_id` 由发送执行层在发送前生成并落盘（`shared/protocol.md` §6.2）。

### 6.3 每轮对话如何从落盘状态重建上下文

```js
// client/agent/context.js（节选）
'use strict'
const store = require('../host/store')

// ⚠️ 核心原则：状态摘要由代码从盘上"算"出来，不是从历史消息里"回忆"出来
function rebuildContextFromDisk(sessionId) {
  const task   = store.readInstanceJson('agent_task.json')  || null
  const batch  = store.readInstanceJson('agent_batch.json') || null
  const health = require('../tools/get-account-health').peek()   // 只读缓存，不重新查 CDP

  const stateBrief = [
    '【当前落盘状态摘要｜由系统生成，请以此为准】',
    task  ? '任务：' + task.task_id + ' 状态 ' + task.status + '，已用 ' + task.rounds_used + ' 轮'
          : '任务：无进行中任务',
    batch ? '未完成批次：' + batch.batch_id + '，共 ' + batch.item_ids.length + ' 条，到期 '
            + new Date(batch.expires_at_ms).toLocaleString('zh-CN')
            + '，已决 ' + batch.decisions.length + ' 条'
          : '未完成批次：无',
    '账号：等级 ' + health.account_tier + '，第 ' + health.account_day_index + ' 天，可发送 '
      + health.sending_enabled + '，熔断 ' + health.circuit.open,
    '【注意：以上为系统生成的权威摘要。若历史对话与它冲突，以本摘要为准。】',
  ].join('\n')

  return { sessionId, stateBrief, promptVersion: require('./prompts').PROMPT_VERSION }
}

module.exports = { rebuildContextFromDisk }
```

**三条要求**：
① 状态摘要**由代码生成**，模型只读不改；与历史消息冲突时以摘要为准（提示词中已声明）。
② 摘要中**不得含隐私字段**（无 `sec_uid`、无昵称，评论摘要 ≤30 字，见 §7.4）。
③ 摘要长度可控（建议 ≤400 token），避免每轮固定成本膨胀。

### 6.4 决策记录格式

**字段定义见 `plans/B-工具契约与粒度设计.md` §五**，实现时逐字段落盘，不得缺项：

```json
{
  "decision_id": "dec-20260918-0007",
  "decided_at_ms": 1758096000000,
  "batch_id": "b-8f2a",
  "input_summary": { "lead_count": 10, "intents": ["price_inquiry", "complaint", "irrelevant"] },
  "candidates_offered": 30,
  "decisions": [
    { "item_id": "it-1", "action": "approve", "draft_id": "d-12", "rationale": "语气匹配" },
    { "item_id": "it-2", "action": "reject", "draft_id": null, "rationale": "负面评论不自动回复" }
  ],
  "model": { "provider": "<配置值>", "model": "<配置值>", "version": "<响应返回的版本>" },
  "policy_version": 9,
  "prompt_version": "p-1.0.0",
  "usage": { "prompt_tokens": 1820, "completion_tokens": 340 },
  "latency_ms": 2400
}
```

落盘为 **JSONL 追加写、不覆盖**，且必须经 store：

```js
// client/agent/planner.js（节选）
function appendDecision(rec) {
  // ⚠️ 禁止直接 fs.writeFileSync（单写者约束）
  return require('../host/store').appendInstanceLine('decision_log.jsonl', rec)
}
module.exports = { appendDecision }
```

### 6.5 会话与多实例的关系

| 维度 | 结论 |
|---|---|
| 会话粒度 | **一实例一 Agent 会话**，不同抖音账号实例的上下文不共享 |
| 状态落盘 | **按实例隔离**：`instances/<ID>/agent_*.json`（与 S-6 隔离目标一致） |
| 切换实例 | 必须**重新 `rebuildContextFromDisk`**，不得沿用上一个实例的上下文 |
| 多窗口 | 同一实例多个对话窗口共享**同一份落盘状态**；`agent_task.json` 带 `locked_by`，第二个窗口只能看不能改 |
| 与服务端 | **Agent 状态不上传服务端**，服务端只收计数与哈希（§7.2）；会话与状态完全留在商家本机 |

---

## 七、安全与合规（方案 B 特有部分）

### 7.1 Agent 不得绕过的硬规则（提示词 + 代码双重保证）

下表是契约 §六 在实现层面的展开。

| 硬规则 | 提示词 | 代码层的强制点 | 文件 |
|---|---|---|---|
| 观察期不得发送任何内容 | §5.2 红线 1 | `review_batch` 在 `sending_enabled=false` 时**直接返回空批次**；`approve_batch` 返回 `POLICY_SENDING_DISABLED` | `review-batch.js` / `approve-batch.js` |
| 不得超过日上限 | §5.2 能力边界 | `review_batch` 只返回额度内候选；`approve_batch` 二次校验 | 同上 + `safety/guard.js` |
| 不得绕过最小间隔 | §5.2 能力边界 | 发送执行层强制；`approve_batch` 提前拦截 `SAFETY_INTERVAL_TOO_SHORT` | `approve-batch.js` + `host/scheduler.js` |
| 不得发送候选池外内容 | §5.2 能力边界 | `approve_batch` 校验 `draft_id ∈ 该批次 candidates` | `approve-batch.js` |
| 不得扩大批次 | §5.2 能力边界 | `max_items` 上限由服务端策略决定，工具层截断 | `review-batch.js` |
| 不得修改安全策略 | §5.2 红线 1 | 工具清单里**没有**任何修改策略的工具；`validate.js` 拒绝未知字段 | `registry.js` |
| 不得触发急停 | §5.2 能力边界 | 工具清单里**没有**急停工具 | `registry.js` |
| 遇验证码必须停 | §5.2 工作方法 1 | `get_account_health` 返回 `circuit.open=true`；`review_batch` 返回空批次 | `safety/circuit.js` |
| 不得自由生成话术 | §5.2 能力边界 | `approve_batch` 只接受 `draft_id`；`source:"generated"` 默认关闭 | `draft-replies.js` + `approve-batch.js` |
| 不得把状态放对话历史 | §5.2 工作方法（隐式） | 每轮强制 `rebuildContextFromDisk()` | `runtime.js` |
| 不得接触隐私字段 | §5.2 汇报格式 | 工具返回结构中**没有** `sec_uid` 字段（§7.4） | 全部工具 |

**自检命令**：

```bash
node --check client/tools/registry.js
node -e "const{TOOLS}=require('./client/tools/registry');console.log(TOOLS.map(t=>t.name).join(' '))"
# 期望恰好 8 个：get_account_health query_leads get_stats analyze_comments \
#                draft_replies review_batch approve_batch explain_failure
# 不得出现：click / type / scroll / evaluate / pause_engine / set_policy / send_reply
```

### 7.2 决策留痕如何纳入既有审计体系（红线 3 的扩展）

红线 3 的既有机制：审计本地与服务端双写、只上传哈希与计数、记录真实生效的策略值。
**方案 B 不新增审计通道，而是把决策挂到既有通道上。**

| 内容 | 本地（全量） | 服务端（只传哈希与计数） | 走哪个既有接口 |
|---|---|---|---|
| 工具调用次数与结果码 | `tool_audit.json` | 计数 `agent_tool_calls{tool,code}` | `POST /usage/report`（计数类） |
| 决策条数 | `decision_log.jsonl` | 计数 `agent_decisions{approve,reject,skip}` | 同上 |
| 模型标识 | `model{provider,model,version}` | 哈希 `hmac(privacy_salt, provider+"|"+model+"|"+version)` 前 16 hex | 同上 |
| 提示词版本 | `prompt_version` | **明文**（非隐私，且举证必需） | `POST /audit/config-changes`（`field_key:"agent.prompt_version"`） |
| 策略版本 | `policy_version` | **明文**（既有字段，本就要上报） | 既有 `policy_snapshot` |
| 是否启用 Agent | `agent_config.json` | `source:"user"` 的配置变更 | `POST /audit/config-changes`（`field_key:"agent.enabled"`） |
| 是否允许 LLM 生成候选 | 同上 | `field_key:"agent.allow_generated_drafts"` | 同上 |

> ⚠️ `usage/report` 的字段白名单由服务端强校验（`shared/protocol.md` §7.5）。
> 上述 `agent_*` 计数属**新增字段**，按 §8.1「新增可选请求字段」规则：服务端先上线支持。
> 在此之前 Agent 计数**只落本地审计**。（见 §12 冲突项 C-6）

**为什么这样就够了**——纠纷时需要回答的三个问题在方案 B 下依然可答：

| 问题 | 数据来源 |
|---|---|
| 当时为什么发了这一句？ | `decision_log.jsonl` 的 `rationale` + `draft_id` + `candidates_offered` |
| 当时的模型和提示词是什么版本？ | `model.version` + `prompt_version`（**这两个字段是"可复现"的全部关键**） |
| 系统有没有试图阻止过？ | `blocked[]` 的阻断码计数 + 配置审计中被拒的越权变更 |

### 7.3 ⚠️ 内容风控：为什么禁止自由生成、候选池机制如何运作

**问题**（`plans/00-两方案对比与选型建议.md` §四 风险 1）：
现有安全机制要求"与近期已发内容相似度 > 85% 即拒绝发送"。但 LLM 可以生成
**字面完全不同、语义相同**的话术——相似度检测挡得住字面，**挡不住语义**。而平台判 spam 看的是模式。

**对策（已定稿）**：Agent **不得自由生成话术**，只能**从候选池中选择**。

```
商家话术池（商家自己写的，已确认合规）
   │  T-05 draft_replies：按意图匹配
   ▼
候选池（每条线索 1~3 个候选；max_per_lead 默认 3、上限 5）
   │  ⚠️ 每个候选必须过 safety/similarity；similarity_checked=true 才能进审批
   ▼
T-06 review_batch → draft_options[{draft_id, text, source}]
   │  Agent：只能选 draft_id，不能改 text
   ▼
T-07 approve_batch → 只接受 draft_id（二次校验：必须在候选内）
   ▼
发送（走完整护栏）
```

**四条硬性实现要求**：
① 候选池在 `review_batch` 返回时**固定**；`approve_batch` 不能引入新文案。
② `source:"generated"` 需商家在设置中**显式开启**，默认关闭（`agent_config.allow_generated_drafts`）。
③ 生成的候选**必须经人工或规则复核后**才进入长期话术池（契约 §3.2 T-05 注意 ③）。
④ `similarity_checked` 为 `false` 的候选**不得**出现在 `draft_options` 中。

> ⚠️ 内容风控的**真实防线是候选池由商家提供**，相似度检测是第二道。实现时不要把顺序搞反。

### 7.4 隐私：Agent 只接受脱敏摘要

| 字段 | Agent 能看到吗 | 说明 |
|---|---|---|
| `sec_uid` 原文 | ❌ **绝不** | 契约 §3.1 T-01 明确"不含 `sec_uid` 原文" |
| 昵称 | ❌ | 不进入任何工具返回结构 |
| 评论正文 | ⚠️ 截断摘要（`excerpt`，≤80 字） | 决策必须看内容，但只给截断 |
| `user_key_hash` | ❌ | Agent 不需要，且它是跨线索关联键 |
| 完整 URL / `video_id` / `comment_id` 原文 | ❌ | 契约 §7.5 禁止上报，工具返回结构中亦不提供 |
| `lead_id` / `draft_id` / `batch_id` / `item_id` | ✅ | 仅本机内部 ID，不含用户信息 |
| 计数、额度、策略版本 | ✅ | 无隐私 |

**三条实现要求**：
① 工具返回结构必须**白名单构造**——显式挑字段，**不要 `return {...row}` 全量透传**
（图省事的全量透传是隐私泄漏最常见的入口）。
② `excerpt` 截断在**工具层**完成，不依赖模型自律。
③ 发往模型服务的请求体本身就要脱敏——**模型服务是第三方**，这与"是否上传到自家服务端"是两件事，都要守。

```js
// client/tools/query-leads.js（节选）—— 白名单构造，不要全量透传
function toSafeLead(row) {
  return {
    lead_id: row.lead_id,
    source_type: row.source_type,
    intent: row.intent,
    region: row.region || null,
    excerpt: String(row.excerpt || '').slice(0, 80),
    first_seen_at_ms: row.first_seen_at_ms,
    replied: !!row.replied,
    // 明确不返回：sec_uid / nickname / user_key_hash / video_id / comment_id / 完整正文
  }
}
```

---

## 八、成本控制

### 8.1 批处理是降本关键

`plans/00-两方案对比与选型建议.md` §三 已给出结论：

| 设计方式 | 每条回复的推理次数 | 相对成本 |
|---|---|---|
| ❌ 逐条推理（每条单独决策） | 1 次/条 + 多轮工具调用 | **基准 × 1** |
| ✅ 批处理（一次决策处理一批，如 20 条） | 1 次 / 20 条 | **基准 × 1/10 ~ 1/5** |

**为什么逐条贵 5-10 倍**：每一轮推理都要**重新传一遍**系统提示词 + 工具定义 + 上下文摘要。
这部分是**固定成本**，逐条推理时被重复支付 N 次，批处理时只支付 1 次。
详细测算见 `plans/B-评估集与成本模型.md` §五。

**三条实现要求**：
① `review_batch` 的 `max_items` 默认 10；提示词主动鼓励模型取一批（§5.2 工作方法 3）。
② `analyze_comments` 单批上限 50 —— **用满它，不要 10 条一批发 5 次**。
③ **禁止在循环里对单条线索反复调工具**：runtime 检测到"同一 `lead_id` 在单次交互内被查询 ≥3 次"时
注入提示"减少重复查询"，并把该模式记入成本监控。

### 8.2 缓存策略

| 缓存对象 | TTL | 键 | 说明 |
|---|---|---|---|
| `analyze_comments` 结果 | **24 小时**（契约 §3.2 T-04） | `hash(lead_ids + intent_model_version)` | 相同输入返回缓存结果（`幂等:是`） |
| 系统提示词 | 进程内常驻 | `prompt_version` | 不要每轮读盘 |
| 工具定义（schema） | 进程内常驻 | — | 同上 |
| `get_account_health` 快照 | **5 秒** | `instance_id` | 短时间重复调用直接返回缓存 |
| `query_leads` 结果 | **不建议缓存** | — | 线索库随时在变，缓存会导致决策基于过期数据 |

> ⚠️ `analyze_comments` 的缓存键必须包含**模型版本**：换了模型仍返回旧缓存 = 评估失真。

### 8.3 优先命中话术池可显著降本

`draft_replies` 的实现顺序必须是：**先匹配话术池，匹配不到才调 LLM**。

```js
// client/tools/draft-replies.js（节选）—— 成本优先的实现顺序
async function draftReplies({ lead_ids, intent_hint, max_per_lead }) {
  const out = []
  for (const leadId of lead_ids) {
    const lead = loadLead(leadId)
    // ① 先查商家话术池（本地匹配，零 token）
    const hit = matchTemplatePool(lead, intent_hint)
    if (hit.length >= 1) {
      out.push({ lead_id: leadId, candidates: hit.slice(0, max_per_lead).map(withSimilarity) })
      continue                                     // ⚠️ 命中即返回，不进 LLM
    }
    // ② 只有匹配不到、且商家显式开启 generated，才调 LLM
    if (!require('../host/store').getAgentConfig().allow_generated_drafts) {
      out.push({ lead_id: leadId, candidates: [] })  // 无候选 → 不进入审批
      continue
    }
    out.push(await llmDraftOne(lead, max_per_lead))
  }
  return { drafts: out }
}
```

**目标指标**：话术池命中率 ≥ 80%。它是**成本监控的核心指标之一**
（命中率每下降 10%，token 成本大约上升同比例）。

### 8.4 单次交互的 token 预算与超限处理

```json
// instances/<ID>/agent_config.json 片段
{
  "max_tokens_per_interaction": 120000,
  "max_tokens_per_day": 2000000,
  "max_rounds_per_interaction": 12,
  "soft_warn_rounds": 8
}
```

> ⚠️ 上表数值需按实际模型单价与定价空间反算填入（见评估集文档 §5.4）。
> **不要在代码里硬编码这些数字**——它们必须来自配置。

| 触发 | 行为 |
|---|---|
| 单次交互消耗 > 预算 80% | 注入系统消息"预算即将耗尽，请尽快给出结论" |
| 单次交互 ≥ 预算 | **立即停止**，汇报已完成部分，返回 `BUDGET_EXHAUSTED` |
| 当日累计 ≥ 日预算 | Agent 进入**只读模式**（仅 T-01/T-02/T-03/T-08 可用），T-04/T-05/T-06/T-07 关闭 |
| 连续 3 日超预算 | 写告警记录并在 UI 显著提示"Agent 成本异常，建议检查提示词或改用方案 A 模式" |

### 8.5 与成本模型文档的关系

**本文不重复测算过程。** 完整的成本拆解、三档估算、每条回复摊薄成本、与定价的比例阈值，
见 **`plans/B-评估集与成本模型.md` §五（成本模型）**。本文只强调一条：

> ### 成本能否接受取决于是否做了批处理设计。逐条推理贵 5-10 倍且毫无必要。

---

## 九、开发顺序

> **顺序已定稿（`plans/B-工具契约与粒度设计.md` §七），不得调整。上一步未通过，不进下一步。**

### 第 0 步：前置检查（不写代码）

| 项 | 判据 |
|---|---|
| 方案 A 已完成 | `docs/需求规格.md` §九 的 23 条全部通过，`node test/run.js` 全绿 |
| P2 验证门通过 | G-1~G-5 全部通过（`shared/术语与选型基准.md` §5.2） |
| 有真实运行数据 | A 至少跑满 1 周，能导出真实评论以判断规则召回率 |

**未通过则停止**：B 建立在 A 之上，A 不稳则 B 必不稳。

### 第 1 步：只读工具（T-01 `query_leads`、T-02 `get_stats`、T-03 `get_account_health`）

| 项 | 内容 |
|---|---|
| **目标** | 打通"Agent 能看数据"：用户问"今天回复了几条""现在能不能发"，Agent 能查到真实数字 |
| **交付** | `registry.js` + 三个只读工具 + `validate.js` + `tool_audit.json` + 最小对话界面 |
| **验证方式** | ① 单元测试：schema 校验（含未知字段拒绝）；② 真机问 5 个问题，数字与图形界面看板**逐项一致** |
| **通过判据** | 1. 工具清单恰好 3 个，无任何写操作<br>2. `query_leads` 返回结构中**不含** `sec_uid`/昵称（代码断言）<br>3. `get_account_health` 数值与 `policy.json` 一致，非自行推算<br>4. 每次调用都产生一条 `tool_audit.json` 记录 |
| **风险** | 低。无副作用、无推理成本 |

### 第 2 步：`review_batch` + `approve_batch` —— ⭐ 核心闭环，**先不做 LLM 生成**

| 项 | 内容 |
|---|---|
| **目标** | 验证整个方案 B 的**核心假设**：商家接受"审批式 Agent"这个交互形态，且系统稳定 |
| **交付** | T-06 + T-07；`adapters/` 暴露 `listPendingCandidates()` / `enqueueApproved()`；候选由**纯规则**生成（话术池匹配 + 相似度检测），**不接 LLM 生成** |
| **验证方式** | ① 构造边界用例，使 7 个阻断码各触发一次；② 真机跑一批真实候选，观察审批 → 发送 → 结果回报全链路；③ 断网/重启后批次仍可续 |
| **通过判据** | 1. **手工篡改 Agent 提交的 `draft_id` 为候选外值，必须 `blocked`**<br>2. 同一 `batch_id` 重复提交 → 返回首次结果，**不重复发送**（幂等）<br>3. 观察期下 `review_batch` 返回空批次、`approve_batch` 返回 `POLICY_SENDING_DISABLED`<br>4. 7 个阻断码全部可被构造并正确返回<br>5. 发送仍走完整护栏：`send_id` 发送前落盘、平台响应体判成功、审计双写<br>6. **商家反馈"愿意用"** ← 这一条是核心假设的验证，不是技术判据 |

> ### 第 2 步"先不做 LLM 生成"的意义
> 方案 B 有一个**与 LLM 能力无关**的假设：商家愿意接受"Agent 替我做审批"。
> 即使 Agent 只做规则级审批，这个形态是否被接受也是同一个问题。
>
> 而 LLM 生成内容恰恰是**风险最高、成本最高、最难回退**的一块：
> 内容可能被平台判营销（风险 1）、决策依赖模型版本（风险 2）、token 成本不可预测。
>
> 所以先用"纯规则候选 + Agent 审批"把**形态与链路**验证完，在最小风险下回答"这条路走不走得通"。
> 走不通，及时止损，成本仅为工具层的一部分；走得通，再逐层加 LLM 能力，每一层都是可控增量。
>
> **反过来做（先上 LLM 生成）的代价**：若形态最终不被接受，LLM 那部分工作全部作废，
> 且期间已产生真实的内容风控风险与 token 支出。

### 第 3 步：`analyze_comments`（T-04，第一个 LLM 能力）

| 项 | 内容 |
|---|---|
| **目标** | 引入语义意图识别，解决"贵不贵"与"多少钱"字面不同的问题 |
| **交付** | T-04 + 24h 缓存 + 意图闭集校验 + 评估集 V1（≥200 条） |
| **验证方式** | 跑评估集，出意图分类准确率报告与混淆矩阵；与方案 A 的关键词规则做基线对比 |
| **通过判据** | 1. 意图分类**整体准确率 ≥ 85%**（目标值，见评估集文档 §3.1）<br>2. **`complaint` 召回率 ≥ 95%**（漏判为 `price_inquiry` 会导致在投诉下自动回复，风险最高）<br>3. 相对规则基线的召回增益**可量化**<br>4. 缓存命中时**零 token 消耗**（实测）<br>5. 未知意图一律落 `unknown`，**不得自由文本** |
| **风险** | 低（只读分析，不产生发送） |

### 第 4 步：评估集与成本监控

| 项 | 内容 |
|---|---|
| **目标** | 建立"改提示词/换模型后能量化对比"的能力，并让成本可见 |
| **交付** | `test/eval/` 评估集（脱敏数据 + 标注）+ 评估 runner + 成本看板 |
| **验证方式** | ① 用两版提示词跑同一评估集，能产出可对比报告；② 成本看板数字与实际 token 账单核对一致 |
| **通过判据** | 1. 评估集已脱敏（**逐条人工确认无真实用户信息**）<br>2. 误批率（`approve` 后仍不该回的比例）**< 5%**<br>3. 每条回复的摊薄 token 成本已算出，且占单价比例 **< 15%**（见评估集文档 §5.4）<br>4. 成本超预算时**自动降级可触发**（实测） |
| **风险** | 中。评估集建设是纯成本，但**没有它就无法安全地改提示词** |

### 第 5 步：`draft_replies`（T-05，最后做）

| 项 | 内容 |
|---|---|
| **目标** | 话术池匹配不到时提供候选（默认关闭），提升覆盖率 |
| **交付** | T-05 + `allow_generated_drafts` 开关 + 生成候选的相似度检测强制 + 候选进池的复核流程 |
| **验证方式** | ① 构造语义雷同但字面不同的生成内容，验证相似度检测拦截；② 人工评审生成候选的可用率 |
| **通过判据** | 1. `similarity_checked:false` 的候选**不出现**在任何 `draft_options` 中<br>2. 商家未显式开启时，**没有任何** `source:"generated"` 候选<br>3. 生成候选的人工评审通过率 ≥ 70%（见评估集文档 §3.2）<br>4. 生成候选**未复核不得进入长期话术池** |
| **风险** | **最高**（内容风控）。放最后就是因为它最可能出问题 |

### 第 6 步：`explain_failure`（T-08，随时可加）

目标：让 Agent 能回答"为什么没发出去"。验证：构造各 `failure_reason` 枚举各一次，确认正确归因。
判据：归因码来自闭集（`shared/protocol.md` §7.4），**不返回自由文本作为唯一依据**。

---

## 十、与方案 A 的关系

**本文只给概览。完整的复用矩阵、改造清单、增量工作量与迁移路径见 `plans/B-与方案A的差异说明.md`。**

| 项 | 结论 |
|---|---|
| 共享代码比例 | 约 **80%** |
| 原样复用（零改动） | `client/core/`、`client/platform/`、`client/license/`、`shared/lib/`、授权中心**全部**、接口契约 |
| 需改造 | `client/safety/`（新增拦 Agent 越权）、`client/adapters/`（暴露预筛能力）、审计（扩展决策记录）、`client/ui/`（新增对话界面但**保留图形界面**）、看板（新增 Agent 指标） |
| 全新 | Agent 运行时、工具封装层、提示词与版本管理、评估集与评估流程、决策记录与成本监控、对话界面 |
| 增量工作量 | 约为方案 A 自身工作量的 **30%–50%** |
| 迁移性质 | **增量式，不是重做** |

---

## 十一、交付物与验收

### 11.1 交付物清单

| # | 交付物 | 路径 | 步骤 |
|---|---|---|---|
| 1 | 工具注册表与参数校验 | `client/tools/registry.js`、`validate.js` | 1 |
| 2 | 八个工具实现 | `client/tools/*.js`（T-01~T-08） | 1/2/3/5/6 |
| 3 | 工具审计 | `client/tools/audit.js` + `instances/<ID>/tool_audit.json` | 1 |
| 4 | Agent 运行时 | `client/agent/runtime.js`、`model-client.js`、`planner.js`、`context.js`、`token-budget.js` | 1 |
| 5 | 系统提示词与历史版本 | `client/agent/prompts/system.p-*.md`、`index.js` | 1 |
| 6 | 决策记录 | `instances/<ID>/decision_log.jsonl` | 2 |
| 7 | 任务与批次状态 | `instances/<ID>/agent_task.json`、`agent_batch.json` | 2 |
| 8 | 对话界面 + 决策明细查看 | `client/ui/`（Agent 面板） | 1/2 |
| 9 | 评估集与评估 runner | `test/eval/` | 4 |
| 10 | 成本监控与告警 | `client/agent/token-budget.js` + 看板指标 | 4 |
| 11 | 降级路径实现与验证记录 | `runtime.js`（降级分支）+ UI 状态提示 | 4 |
| 12 | 本文档及三份配套文档 | `plans/B-*.md` | — |

### 11.2 验收标准

**通用验收**：`docs/需求规格.md` §九 的 23 条**全部仍然适用**（B 不得让任何一条失效）。
其中与 B 最相关：第 3 条（余额归零停机）、第 5 条（达上限不发送）、第 15 条（相似度 >85% 拒绝）、
第 18 条（夜间不发送）、第 21 条（审计可导出）。

**方案 B 特有的四条验收**：

| # | 验收项 | 判据 | 验证方式 |
|---|---|---|---|
| **B-1** | **Agent 无法越权** | ① 工具清单恰好 8 个，无 CDP 类、无策略修改类、无急停类工具<br>② 篡改 `draft_id` 为候选外值 → `AGENT_DRAFT_NOT_IN_CANDIDATES`<br>③ 传 `max_items` 超服务端上限 → 被截断<br>④ 传未知字段（如 `daily_max`）→ 被拒绝<br>⑤ 让 Agent"想办法多发几条" → 无法实现 | 代码断言 + 提示注入对抗测试 |
| **B-2** | **决策可复现** | 导出任意一条历史决策，能回答"当时用的模型版本、提示词版本、策略版本、候选集、选中项、理由" | `decision_log.jsonl` 导出 + 抽样人工复核 |
| **B-3** | **成本在预算内** | ① 每条成功回复的摊薄 token 成本占单价 **< 15%**<br>② 成本超预算时自动降级实测生效<br>③ 逐条推理与批处理的成本差实测在 5-10 倍区间 | 成本看板 + 实际账单核对 |
| **B-4** | **降级路径可用** | ① 断网/断模型服务 → 自动切无 Agent 审批模式，商家仍能完成回复<br>② 降级期间人工审批走**同一份** `batch_id`，不丢状态<br>③ UI 明确显示降级级别与原因，无静默降级 | 拔网线 / 改错 API Key 的故障注入测试 |

---

## 十二、风险与对策

### 12.1 方案 B 的两个特有风险（必须解决）

| # | 风险 | 后果 | 对策（已定稿） | 验证方式 |
|---|---|---|---|---|
| **R1** | LLM 生成内容**字面不同但语义雷同**，可绕过相似度检测 → 被判内容级 spam | 账号风险 | **Agent 只能从候选池选，不得自由生成**；候选池由商家提供并经相似度检测；`generated` 默认关闭 | 构造语义雷同、字面不同的候选，确认其来源只能是话术池；`generated` 关闭时无生成候选 |
| **R2** | **决策不可复现**，影响举证 | 纠纷时无法自证 | 落盘决策记录，**含 `model.version` 与 `prompt_version`** | 验收 B-2 |

### 12.2 其余风险

| 风险 | 可能性 | 影响 | 对策 |
|---|---|---|---|
| Agent 循环不收敛，烧钱 | 中 | 中 | 轮次上限 12 + 墙钟 3 分钟 + 预算熔断；超限必须如实汇报 |
| 模型不遵守提示词，反复撞墙重试 | 中 | 中 | §5.3 双重保证；few-shot F-4 专门训练"被拦下不重试" |
| 提示注入（评论正文里写"忽略以上指令"） | 中 | **高** | 工具返回的 `excerpt` 截断；工具层参数校验独立；**Agent 无论被怎么诱导都造不出候选外内容**（架构级防护） |
| 商家误以为"Agent 批准 = 一定发出" | 高 | 低 | UI 并列展示 `decisions` 与 `blocked[]`；汇报格式强制区分"已投递"与"被拦下" |
| 成本随对话变长而膨胀 | 中 | 中 | 状态摘要 ≤400 token；对话历史**不回灌全文**，只回灌摘要 + 最近 N 轮 |
| 换模型后行为漂移 | 中 | 中 | 换模型 = 必须重跑评估集（评估集文档 §4.4）；`model.version` 落盘 |
| 工具层偷偷重新实现 adapters 逻辑 | 中 | **高** | PR 检查：`client/tools/` 下不得出现 `data-e2e` 字符串、不得 `require('ws')`、不得直接 `fs.writeFileSync` |
| Agent 与图形界面同时操作同一批线索 | 低 | 中 | `agent_batch.json` 带 `locked_by`；UI 提示"Agent 正在处理" |
| 商家在观察期反复让 Agent"试试发一条" | 中 | 中 | 工具层硬拦（空批次 + `POLICY_SENDING_DISABLED`）；提示词明确说明；UI 显示观察期文案 |

### 12.3 ⚠️ 实现前需确认的文档冲突项

> 以下为编写本文档时发现的**与既有文档不一致之处**。按 `AGENTS.md` §7「发现文档之间互相矛盾」应停下确认。
> 这些**不改变已定稿的工具设计**，但会影响实现细节，需在开工前定稿。

| # | 冲突 | 既有文档说法 | 定稿设计说法 | 建议处置 |
|---|---|---|---|---|
| **C-1** | Agent 默认开关 | `docs/需求规格.md` FR-2.5：默认档位 = `半自动`；FR-6.2：默认安全 | 方案 B 的 Agent 会自主 `approve` 并投递发送 | Agent **默认关闭**（`agent_config.enabled=false`），需商家显式开启并勾选风险确认（复用 FR-2.5 全自动档位的确认记录机制）。**不得默认开启** |
| **C-2** | 阻断码命名 | `shared/protocol.md` §3.2 只有 `POLICY_DAILY_CAP_EXCEEDED`，无 `POLICY_DAILY_CAP` | 契约 §3.4 阻断码为 `POLICY_DAILY_CAP` | 工具契约的阻断码是**业务阻断码**，与协议**错误码**不是同一空间。工具层做显式映射 `POLICY_DAILY_CAP` ↔ `POLICY_DAILY_CAP_EXCEEDED`，并在契约文档补一张映射表 |
| **C-3** | 缺少限流类阻断码 | 契约 §3.4 的 7 个阻断码里**没有**"被限流/请求过频" | `shared/protocol.md` 有 `RATE_TOO_MANY_REQUESTS` | **不改已定稿的 7 个阻断码**；实现时按 `POLICY_DAILY_CAP` 语义汇报"系统繁忙，请稍后再试"（§4.4 已覆盖） |
| **C-4** | `max_items` 上限的数值来源 | 契约 §3.3 T-06：「上限由服务端策略决定」 | `shared/protocol.md` §1.4 的默认配置项里**没有**这一项 | 需在服务端配置项中**新增**（建议 `agent_batch_max_items`），由 `policy` 下发。**不得写死在客户端**（红线 1） |
| **C-5** | `complaint`/`irrelevant` 的排除位置 | 契约 §3.4 注：「规则层应默认不进入待发批次」 | 契约 §四示例中，Agent 在 `review_batch` 返回的 10 条里 `reject` 了 2 条 `complaint` + 1 条 `irrelevant` | 两处**语义不同、并存不矛盾**：① `intent=complaint/irrelevant` 的线索在**预筛**阶段即被排除（代码保证）；② 示例中 Agent `reject` 的是**意图被判为询价但语气负面**的内容（语义级判断）。建议在契约文档补一句说明 |
| **C-6** | `agent_*` 计数上报字段 | `shared/protocol.md` §7.5 字段白名单强校验，未知字段被丢弃 | 方案 B 需上报 Agent 计数与哈希 | 按 §8.1「新增可选请求字段」流程：**服务端先上线支持**。在此之前 Agent 计数**只落本地审计**。需在 `shared/protocol.md` 增补字段 |
| **C-7** | 依赖白名单 | `AGENTS.md` §2.14 与 `shared/术语与选型基准.md` §3.2：唯一允许的第三方依赖是 `ws` | 接入 LLM 需要 HTTP(S) 客户端 | **用内置 `node:https` 自研**（约 80 行），**不引入任何 SDK**。引入官方 SDK 会违反依赖白名单，必须先报备 |
| **C-8** | `plans/` 与 `shared/` 文档缺失 | `README-DEV.md` §七 声明 7 份 `plans/` 文档与 7 份 `shared/` 文档均 ✅ | 实际仓库中只有 `00-两方案对比与选型建议.md` 与 `B-工具契约与粒度设计.md` | 本文档引用的 `plans/A-工具链路开发指导.md`、`plans/A-分阶段任务清单.md`，以及 `shared/开发规范.md`、`测试策略.md`、`安全与合规要求.md`、`已知陷阱与平台知识.md`、`AI协作开发指引.md` **尚未创建**。第 0 步前置检查需要它们 |

### 12.4 已发现的其他文档陈旧点（不阻塞，但应修正）

| # | 位置 | 问题 | 说明 |
|---|---|---|---|
| S-1 | `docs/架构说明.md` §七「积分协议」 | 仍写"计费触发 = 自动回复引擎运行态的挂钟时长""分段计费 36 分钟 = 0.5" | 该模型已作废：`shared/protocol.md` §8.1 已将 `protocol_version 1→2` 改为**按成功回复条数计费**，§6.1 明确"心跳与时长不参与计费" |
| S-2 | `docs/架构说明.md` R-4 与 §五 | 半年套餐"4320 积分"、`plan.hours` 字段 | 与 `shared/protocol.md` §4.14 及 `docs/需求规格.md` FR-3.3 的 **12600**（= 70×180，运行时由 `tier_table` 推导）不一致；`hours` 已废弃、服务端恒返回 `null` |
| S-3 | `docs/需求规格.md` D4 | "回复内容来源 = 关键词规则 + 话术模板库，**本期不接大模型**" | 该条是**方案 A 的范围界定**；方案 B 正是"接大模型"的增值升级。两者不矛盾，但需在 D4 注明"方案 B 另行评估"以免误读 |
| S-4 | `docs/需求规格.md` §四 | 出现**两个 `NFR-1`**（依赖条目重复且措辞不同："保持零 npm 依赖" vs "允许极少量依赖（`ws`）"） | 后者才是定稿口径（`shared/术语与选型基准.md` §3.2）。建议删除前者 |
| S-5 | `docs/架构说明.md` §八 目录 | 写 `shared/protocol.js`、`shared/errors.js` | 定稿目录为 `shared/lib/protocol.js`、`shared/lib/errors.js`（`shared/lib/` 是唯一允许双端共享的代码目录） |
| S-6 | `docs/需求规格.md` FR-2.3.2 | 评论 20-30 条 / 弹幕 30-50 条 | 与 `shared/protocol.md` §4.6 `tier_table`（评论 10/25/30、弹幕 10/25/30）范围不一致。**以 `tier_table` 为唯一来源**（红线 1） |

---

## 十三、相关文档

| 文档 | 关系 |
|---|---|
| `plans/B-工具契约与粒度设计.md` | ⭐ **工具契约的唯一定稿来源**。本文不重复其内容 |
| `plans/B-评估集与成本模型.md` | 评估集设计、误批率上限、token 成本测算与降级熔断 |
| `plans/B-与方案A的差异说明.md` | 复用矩阵、改造清单、增量工作量、迁移路径 |
| `plans/00-两方案对比与选型建议.md` | 两方案对比、选型建议、B 的两个特有风险 |
| `README-DEV.md` · `AGENTS.md` | 开发总索引、三条红线、14 条必须避免的误实现 |
| `shared/protocol.md` | 双端接口契约（认证 / 计费 / 策略 / 审计 / 错误码） |
| `shared/术语与选型基准.md` | 术语、技术选型、目录结构、依赖白名单 |
| `docs/需求规格.md` | 23 条验收标准、FR-2.3 安全体系、FR-4 看板口径、FR-6 责任边界 |
| `docs/架构说明.md` | 分层、稳定指标 S-1~S-6、P2 验证门 |

---

*本文档是方案 B 的实现指导。工具语义以 `plans/B-工具契约与粒度设计.md` 为准；
接口字段与错误码以 `shared/protocol.md` 为准；术语与技术选型以 `shared/术语与选型基准.md` 为准。*
