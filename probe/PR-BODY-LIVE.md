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

---

## 7. 评审意见修复记录（本修订）

评审列出的 7 项里，本次处理 **4 项**（3 个状态机缺陷 + 策略签发边界），每项都补了回归测试；
其余 3 项属于服务端接线与真机验收，**如实保持未完成**，不做任何"已完成"的表述。

> 说明：分支上曾出现一次并发写入（协作者 `8767c2e` 用另一套写法覆盖了 `live_flow.py` 与
> `tests/test_probe.py`，随后由同一作者用 `89464b6a` revert 回本 PR 的实现，并指出本实现的一个
> 可观测性缺口）。下表按分支**当前实际实现与用例名**描述；缺口已在本修订中修掉，经过见第 9 节。

| 评审项 | 处理结果 | 回归测试 |
|---|---|---|
| 1 空批次会永久复用 | 队列为空时**不再创建批次**（返回 `status: "empty"`、`batchId: null`）；已存在的空批次被关闭为 `expired` | `test_empty_batch_is_closed_instead_of_reused` |
| 2 过期批次仍可复用 | 取批次时把过了 `expiresAt` 的批次关闭为 `expired` 并作废其 `planned` 事件；两个阶段执行前都调用 `ensure_active`，超窗一律 `batch_expired`（且先于任何浏览器动作） | `test_open_batch_is_closed_once_its_window_passed`、`test_phase_methods_refuse_an_expired_batch`、`test_sidecar_refuses_an_expired_batch_without_touching_the_browser` |
| 3 私信结果没有持久化 | `mark_private` 按解析出的 `event_key` 更新（原实现选中了正确的行，却用调用方的 `event_id` 去写，于是接口返回成功、库里没记录） | `test_private_result_is_persisted` |
| 4 策略由客户端参数控制 | 边界**拒绝调用方自带 policy**（`policy_not_server_issued`），改用内置保守默认值；冻结计划记录 `policySource: "builtin_default"`；库层保留 `freeze_plan(policy=...)` 作为服务端接线的缝 | `test_sidecar_live_plan_and_guards_need_no_browser` |
| 5 积分 / 功能开关 / 服务端审计未接入 | **未做**：需要服务端协议；本 PR 不声称完成，本地 `send_gate.py` 仍是唯一本地闸 | —— |
| 6 只有离线验证 | **未做**：真机选择器、作者标识、公屏送达、私信送达均待验收；`live_batch.autoEligible` 保持 `false` | —— |
| 7 合并冲突 | 当前对照最新 `rewrite/v4-agent`（`e8a963a7`）为 `mergeable_state: clean`：该分支自 `6152cbe` 起未改动 `probe/`；若 #5 / #6 先合并且改到 `probe/tests/test_probe.py`，我会基于最新基线重整后再合 | —— |

离线回归（本机实测，第 9 节有同一次运行的输出）：

```text
LiveFlowTests + BoundaryTests 共 33 项：OK
```


---

## 8. 与「重新对齐后的直播间九步流程」逐条对照

| # | 流程步骤 | 落点 | 状态 |
|---|---|---|---|
| 1 | 持续监听直播间评论 | `live_listen`：一次调用做一轮可见采集并入队，由 host 反复调用形成持续监听 | ✅ |
| 2 | 按关键词匹配评论 | `live_plan` 的 `keywords` / `excludeKeywords` / `matchMode`（phrase/seg/all/any，**与评论链路同一个匹配器**）；**匹配发生在成批之前**，未命中的事件标 `filtered`，不占批次名额，响应里给 `filter` 计数 | ✅ **本次补齐** |
| 3 | 去重并形成批次 | 队列按 房间+作者+文本 去重 + `take_batch`（数量上限 50、时间窗 `windowSeconds`） | ✅ |
| 4 | Agent 根据向量话术库选择公屏回复 | 边界：host 在 `live_plan` 里下发 `scripts[eventId].publicText`；sidecar **不生成、不改写**话术 | ✅ |
| 5 | 执行公屏回复 | `live_reply` → `send_comment(source="live")`，逐条写状态 | ✅ |
| 6 | **只有公屏回复确认成功后，才进入私信阶段** | `private_candidates` 默认只放行 `sent_confirmed`；`unknown` 被拒（原因 `public_unknown`），`blocked` / `failed` 同样被拒 | ✅ |
| 7 | Agent 根据向量话术库选择私信内容 | 边界：host 下发 `scripts[eventId].privateText` | ✅ |
| 8 | 执行私信 | `live_private` → `send_private`，只对第 6 步得到的候选发送 | ✅ |
| 9 | 保存批次、事件、发送状态与恢复检查点 | `live_flow.sqlite3`（批次/事件/公屏状态/私信结果）+ `send_state.sqlite3`（幂等与本地额度）+ `live_result.checkpoint` | ✅ |

第 6 步有一处**需要平台侧知晓**的现实约束：本通道的公屏回复结果通常是 `unknown`
（DOM 现象不算确认，只有把平台响应绑定到那次点击才能给出 `sent_confirmed`）。
默认策略下这种情况**会停在阶段一、不进入私信** —— 这是按第 6 步刻意设计的 fail-closed 行为，
不是缺陷；若要让它继续，需要平台侧先提供可绑定的响应证据。

### 第 2 步新增的回归测试

`test_plan_matches_keywords_before_forming_a_batch`（**先匹配再成批**：`maxItems=1` 时拿到的是命中
关键词的那条，而不是队列里的第一条）、`test_plan_exclude_keywords_take_precedence`（排除词优先）、
`test_plan_without_keywords_keeps_every_event`（不给关键词时行为不变）。

### 本次新增的窗口与台账回归测试

`test_retired_batch_events_are_counted_in_the_response`（协作者指出的对账缺口：批次退休作废的事件
必须计入 `expiredCount` / `expired`，并带 `expiredReason`）、
`test_expiry_never_rewrites_a_recorded_send_result`（窗口检查只能作废仍处 `planned` 的事件，
`sent_confirmed` 等台账事实不得被改写）、
`test_ensure_active_keeps_a_live_batch_and_refuses_unknown_ids`（窗口内的批次可用；未知批次
fail-closed）、`test_sidecar_refuses_an_expired_batch_without_touching_the_browser`（两个阶段的拒绝
先于任何浏览器动作）。

离线回归：LiveFlowTests + BoundaryTests 共 **33 项通过**。

---

## 9. 本次修订：并发写入的经过与最终状态

### 分支上发生了什么（如实记录）

1. `8767c2e`（协作者）：在 `7ec3d4d3` 之上用**另一套写法**重做了第 1/2/3 条，覆盖了
   `probe/live_flow.py` 与 `probe/tests/test_probe.py`（本 PR 的实现与其 86 行回归测试被换掉）。
2. `89464b6a`（同一作者）：**revert** 了上一条，把这两个文件原样恢复到 `7ec3d4d3` 的内容，
   理由是那次覆盖会丢掉已有的修复与回归测试；同时指出本实现的一个**可观测性缺口**：
   因批次退休而作废的事件没有计入返回的 `expiredCount` / `expired`，宿主无法对账"这次丢了多少"。
3. `2248d953`（本 PR 作者）：基于**过期的 HEAD 读取**（当时看到的是 `8767c2e`）做了一次推送，
   又把被 revert 掉的那版内容带了回来。这是本 PR 作者的失误：推送前没有重新核对分支是否已被推进。
4. 本提交：把 `live_flow.py` 与 `tests/test_probe.py` 恢复到 revert 之后的实现（即本 PR 的实现），
   在其之上补齐九步流程第 2 步，并修掉协作者指出的缺口与一处台账风险。**全程没有 force push。**

### 本提交做的事

1. **补齐九步流程第 2 步（关键词匹配）**：`take_batch(filters=...)` 在成批**之前**匹配；未命中或
   命中排除词的事件标 `filtered`（终态），不占批次名额。`live_plan` 接受 `keywords` /
   `excludeKeywords` / `matchMode`，响应给出 `filter` 计数（`matched` / `missed` / `excluded`）。
   匹配语义直接复用评论链路的匹配器（`phrase` / `seg` / `all` / `any`，排除词优先），
   两条链路保持一致。
2. **修掉协作者指出的对账缺口**：批次退休时被作废的事件现在计入同一份 `expiredCount` / `expired`
   列表，并逐条带 `expiredReason`；`ensure_active` 的 `batch_expired` 消息里也报出数量
   （`N event(s) were expired, not replayed`）。
3. **修掉一处台账风险**：`_close_batch` 原先会把批次名下**所有**事件置为 `expired`，包括已经记录
   了 `sent_confirmed` / `unknown` 的 —— 那等于把"确实发生过的触达"抹掉，之后的去重与防重复触达
   都会失准。现在只作废仍处 `planned` 的事件，已记录的结果原样保留。

### 过期语义

过期是**绝对**的：`expiresAt` 一过，批次连同仍处 `planned` 的事件一起作废，`live_reply` /
`live_private` 都以 `batch_expired` 拒绝，且拒绝发生在**打开浏览器之前**。冻结批次不例外 ——
`live_plan` 在取下批次的同一次调用里就冻结，"已冻结"并不代表新鲜；若对冻结批次放行，
一个几小时前过期的批次仍然可以发出，这正是评审第 2 条要拦住的情况。代价（公屏阶段跨过窗口后
私信阶段会被拒，需要用新鲜事件重新成批）是显式的。

### 本机离线回归（真实输出）

```text
Ran 33 tests in 1.231s

OK
```

仍未完成、如实标注的部分与第 5/6 节一致：积分 / 功能开关 / 服务端审计未接入；真机验收
（选择器、作者标识、公屏送达、私信送达）未进行；`live_batch.autoEligible` 保持 `false`。
