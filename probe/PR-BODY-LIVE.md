# PR：直播间批次流程（协作方实现）

> 目标分支：`rewrite/v4-agent`　来源分支：`feat/live-batch-flow`
> 依据架构图：**images/12-live-room-business**（主），以及它依赖的两张边界图
> images/09-knowledge-talk-preparation（话术由平台准备）与
> images/17-action-ledger-idempotency（动作账本与幂等），
> 边界划分遵循 images/18-platform-collaborator-boundary。

---

## 1. 功能

把架构图 12 的直播间流程落到 sidecar 上，形成"持续监听 → 批次 → 边界准备话术 → 两阶段触达 → 结果与检查点"的可复核实现。

| 环节（架构图 12 节点） | 实现 |
|---|---|
| 按固定规则持续监听 | `live_listen`：每一次调用做一轮可见 DOM 采集，把事件写入持久化队列 |
| 去重、有容量上限的事件队列 | 按 **房间 + 作者 + 文本** 去重；队列容量上限，超出时丢最旧并记 `expired`（附原因 `queue_capacity_exceeded`） |
| 按时间或数量形成批次 | `live_plan`：按 `maxItems` 取一批（上限 50），并给出 `createdAt` / `expiresAt` |
| 批次仍在有效时间窗口内？ | 取批次前先把超窗事件标 `expired`（原因 `window_expired`）；**过期事件之后永不复用**，不集中补发 |
| （重试安全） | 未冻结的批次在重复请求时**复用**，一次重试不会产生两个批次 |
| 流程边界：模型判断与话术准备 | `live_plan` 接收平台下发的 `scripts`（每个目标 **publicText + privateText** 双渠道）；缺失或超界 → 该目标 `blocked`，**sidecar 从不代写/改写话术** |
| 固化本批公屏与私信计划 | `freeze_plan` 把计划（含 `publicTextSha256`）写进 `live_flow.sqlite3`；重复调用返回同一份冻结计划 |
| 第一阶段：公屏回复 | `live_reply`：逐条发送，逐条记录状态（经 `send_gate` 的幂等键） |
| 记录每条公屏回复状态 | 状态写回队列；阶段二只读这份状态 |
| 按固定策略形成私信清单 | `private_candidates`：默认只放行 `sent_confirmed`；`unknown` / `blocked` / `failed` / 缺作者标识 / 超 `maxPrivate` 一律拒绝并给出原因 |
| 第二阶段：逐个私信 | `live_private`：只对候选清单发送，非候选直接拒绝（附原因） |
| 返回本批结果 | `live_result`：分状态计数、私信候选与拒绝原因、可恢复检查点（阶段/未决事件/冻结计划规模） |

新增/修改文件：

* `probe/live_flow.py`（新）：队列、批次窗口、计划冻结、候选推导、结果与检查点
* `probe/sidecar.py`：新增 5 个方法 + `capabilities` 声明 + 参数校验助手
* `probe/tests/test_probe.py`：新增 `LiveFlowTests`（8 个用例）
* `probe/SIDECAR.md`：契约文档补充

## 2. 依赖

**零新增依赖。** 只使用 Python 标准库（`sqlite3` / `uuid` / `hashlib` / `json` / `contextlib`）。

sidecar 既有约定不变：一次请求一行 JSON、stdout 只输出协议对象、诊断走 stderr、
`state-dir` / `profile-dir` 必须是源码目录之外的绝对路径。

## 3. 接入方式

```text
python sidecar.py --state-dir C:\AgentData\account-a\state --profile-dir C:\AgentData\account-a\profile --port 19222

{"id":1,"method":"live_listen","params":{"url":"https://live.douyin.com/<room>","maxItems":100}}
{"id":2,"method":"live_plan","params":{"maxItems":20,"windowSeconds":900,
    "scripts":{"<eventId>":{"publicText":"<平台准备的公屏文案>","privateText":"<平台准备的私信文案>"}}}}
{"id":3,"method":"live_reply","params":{"batchId":"<id>","items":[{"eventId":"<id>","sendId":"<host 幂等键>"}]}}
{"id":4,"method":"live_private","params":{"batchId":"<id>","items":[{"eventId":"<id>","sendId":"<host 幂等键>"}]}}
{"id":5,"method":"live_result","params":{"batchId":"<id>"}}
```

| 方法 | 需要浏览器 | 说明 |
|---|---|---|
| `live_listen` | 是 | 采集一轮并入队 |
| `live_plan` | 否 | 取批次 + 冻结双渠道话术（可离线规划） |
| `live_reply` | 仅当确有可发项 | 话术不一致等情况在打开浏览器**之前**就拦掉 |
| `live_private` | 仅当确有候选 | 非候选在打开浏览器**之前**就拦掉 |
| `live_result` | 否 | 结果与检查点 |

`policy` 可选，用于覆盖默认策略：`allowPublicStates`（默认 `["sent_confirmed"]`）、`maxPrivate`、`minTextLength`、`maxTextLength`。
把 `unknown` 放进白名单等于"公屏结果未知也继续私信"，必须由平台策略显式授权。

## 4. 测试结果

新增 `tests/test_probe.py::LiveFlowTests`（离线，不需要浏览器）：

| 用例 | 断言 |
|---|---|
| `test_queue_dedupes_by_identity_and_enforces_capacity` | 同一事件重复入队只存一条；容量 3 时第 4~6 条挤掉最旧 3 条并记为 expired |
| `test_batch_window_expires_old_events_and_never_replays_them` | 超窗事件不进批次、状态为 expired；第二次取批次不再出现该事件 |
| `test_open_batch_is_reused_so_a_retry_cannot_plan_twice` | 连续两次取批次得到同一 batchId，批次内事件数不翻倍 |
| `test_plan_requires_both_host_scripts` | 缺 `privateText` 的目标被 blocked（原因 `private_text_missing`）且不进计划；`scriptSource=host` |
| `test_private_candidates_follow_phase_one_states` | 只有 `sent_confirmed` 进候选；`unknown` 拒绝原因为 `public_unknown`；无作者标识拒绝原因为 `missing_author_id` |
| `test_sidecar_live_plan_and_guards_need_no_browser` | 规划与拦截全程不打开浏览器；话术不一致 → `script_mismatch`；非候选 → `public_planned`；未知批次 → `unknown_batch` |
| `test_sidecar_live_result_reports_counts_and_checkpoint` | `capabilities` 声明 `live_batch` 且 `autoEligible=false`；结果含状态计数、候选数与检查点 |
| `test_live_listen_enqueues_deduped_events` | 采集重复事件时 `added=1 / duplicates=1` |

离线回归（本机实测）：

```text
LiveFlowTests + BoundaryTests 共 21 项：OK
```

回归方式：

```text
cd probe
python tests/test_probe.py LiveFlowTests BoundaryTests
```

说明：`ChromiumFixtureTests` 需要真实浏览器，不在本次离线回归范围内；本机沙箱无法启动 Chrome，
真实平台（选择器与送达）验证仍未进行。

## 5. 失败状态与发行开关

* 发送结果沿用既有语义：`unknown` / `failed` / `blocked`；点击一旦开始，结果未知就保留为 `unknown`，
  同一目标的后续请求由 `send_gate` 拦住。
* `live_private` 的拒绝原因：`public_unknown`、`public_blocked`、`public_failed`、
  `public_pending`/`public_planned`、`missing_author_id`、`over_private_capacity`、
  `script_mismatch`、`not_a_private_candidate`。
* `capabilities.result.capability.live_batch`：`implemented: true`、`autoEligible: false`、
  `validation.status: offline_unit_tests`、`scripts: host_provided_only`、
  `window: expired_events_are_not_replayed` —— 未拿到真实平台证据前不进入发行开关。

## 6. 未验证边界（fail-closed）

1. 直播间选择器仍只经离线 fixture 校验，真实平台未验证。
2. 平台是否对每条弹幕都给出作者标识尚未确认；拿不到作者标识的目标不会进入私信清单
   （`missing_author_id`），而不是用昵称兜底。
3. 阶段二送达沿用其他发送通道的 `unknown` 语义，不把 DOM 表象当作成功。
4. 本 PR 不含真实账号证据；需要真机验证后才能评估 `autoEligible` 的开启条件。
