# AI 协作开发指引

> **本文件的读者是 AI 编码智能体。** 人类开发者请先读 `shared/开发规范.md`，本文件是它的补充：本项目的领域知识（抖音 DOM 结构、防封规则、计费口径、责任边界）**无法从代码或常识推断**，你按常规直觉实现出来的东西大概率是错的。
>
> 写作方式：祈使句、清单化、每条可自检。
> 事实源优先级：`docs/需求规格.md` ＞ `shared/protocol.md` ＞ `shared/术语与选型基准.md` ＞ `shared/开发规范.md` ＞ 本文件。
> **本文件与 `docs/需求规格.md` 或 `shared/protocol.md` 冲突时，以后两者为准，并把冲突反馈给人。**

---

## 1. 使用说明

### 1.1 为什么需要这份文件

本项目的三类核心知识**不在代码里**：

| 知识 | 为什么推不出来 | 后果 |
|---|---|---|
| **抖音 DOM 知识** | 页面同时存在隐藏与可见两套结构；虚拟列表会重渲染；图文帖评论区是浮层。这些是旧作者用真账号真页面反复试错换来的（每个坑都消耗真实账号风险） | 写出的定位逻辑在真机上全错，或误命中隐藏元素拿到 0×0 坐标 |
| **防封规则** | 限额、等级预热曲线、间隔范围、相似度方向、熔断梯度，全部由业务与平台规则决定 | 账号被封——**这是真实损失，不是测试失败** |
| **计费口径** | "什么算一次成功发送"的定义不可从代码推断（旧代码有现成的错误示范） | 计费错、纠纷时无法自证、商家投诉 |

**默认行为准则：遇到不确定，先查文档，不要猜。** 猜错的代价在客户端是封号，在服务端是账目错乱。

### 1.2 必读顺序（按你被指派的任务选一条）

| 你的任务 | 必读（按顺序） |
|---|---|
| 任何任务 | ① `README-DEV.md` §二（三条红线）② 本文件全文 ③ `shared/开发规范.md` |
| 客户端 CDP / DOM / 回复 | 上述 + `shared/已知陷阱与平台知识.md`（**写 DOM 代码前必读**）、`shared/术语与选型基准.md` §一（术语表）、`legacy/reply_worker.js`（行为规格对照） |
| 服务端接口 / 计费 / 策略 | 上述 + `shared/protocol.md` 全文（尤其 §3/§4.6/§4.8/§5/§6） |
| 前端界面 | 上述 + `docs/需求规格.md` FR-1/FR-4 + `protocol.md` §4.14（额度文案必须原样展示） |
| 存储 / 队列 | 上述 + `shared/开发规范.md` §四/§五 + `docs/架构说明.md` §五 |

### 1.3 遇到不确定时必须先查文档的清单

**以下问题禁止凭常识回答，必须查表：**

| 问题 | 查哪里 |
|---|---|
| 这个渠道每天最多发几条？最小间隔多少？ | `protocol.md` §4.6 `tier_table`（**唯一来源，禁止硬编码**） |
| 什么情况算"发送成功"、可以计费？ | `protocol.md` §6.1 计费资格（五条必须**同时**成立）+ §7.2 四级口径 |
| 客户端能不能把上限调高？ | 不能。`protocol.md` §4.6「客户端只能更保守」的四个方向 |
| 相似度阈值是"超过拒绝"还是"低于拒绝"？ | `protocol.md` §4.6 `content_similarity_max_semantics`：**超过即拒绝** |
| 某个错误码客户端应该怎么做？ | `protocol.md` §3.2 错误码表「客户端动作」列 |
| 这个字段能不能上报？ | `protocol.md` §7.5 隐私边界（禁用字段出现即整条被拒） |
| `failure_reason` 有哪些合法值？ | `protocol.md` §7.4 闭集（未知键会被拒绝） |
| `platform_endpoint` 能写完整 URL 吗？ | 不能，闭集白名单只有 `comment/publish`、`comment/reply`、`im/send`、`live/comment/send` |
| 这个术语（如"工作台账号"）指什么？ | `shared/术语与选型基准.md` §一术语表 |
| 该用哪个依赖？ | `shared/术语与选型基准.md` §3.2；白名单**只有 `ws`** |
| 这个文件能否写盘？ | 只有 `host` 主进程可以。`shared/开发规范.md` §4.1 |
| 旧代码是怎么做的？ | `legacy/` 对应文件（**行为参考，不是照抄对象**） |

---

## 2. 三条红线（最容易违反，逐条给出正误对照）

### 红线 1：安全上限由服务端下发，客户端只能调低不能调高

**要求**：所有安全上限（日发送量、最小间隔、活跃时段、内容相似度）由服务端 `tier_table` 权威下发。客户端新账号前 3 天为观察期（`daily_max` 全 0，只采集不发送），**不可跳过**。上报的生效配置比策略更激进 → 服务端返回 `POLICY_VIOLATION(409)` 拒绝。

【错误实现】

```js
// ❌ 客户端硬编码限额；观察期可直接跳过
const LIMITS = { comment: { daily_max: 30, min_interval_ms: 60000 }, dm: { daily_max: 10 } }
function set_user_limit(source_type, value) {
  user_limits[source_type].daily_max = value        // 用户填 999 就真的按 999 发
}
if (policy.account_tier === 'observation') { /* 直接忽略，继续发 */ }
```

【为什么错】① 数值一旦硬编码，服务端调整策略时客户端不会同步，商家会按过期上限发送 → 封号；② 允许调高等于把"控制节奏、让账号活得久"这个核心产品价值删掉；③ 观察期是新号最关键的保护期，跳过就是拿新号去撞风控；④ 服务端会拒绝这类上报并留痕，等于给纠纷提供对己方不利的证据。

【正确做法】

```js
// ✅ 上限只能取"更保守"的一方；调高被本地拦截并记审计
function effective_limit(source_type, user_settings, server_policy) {
  const sp = server_policy.limits[source_type]
  return {
    daily_max: Math.min(user_settings.daily_max ?? sp.daily_max, sp.daily_max),          // 只能调低
    min_interval_ms: Math.max(user_settings.min_interval_ms ?? sp.min_interval_ms,
                              sp.min_interval_ms),                                        // 只能调高
    content_similarity_max: Math.min(user_settings.content_similarity_max ?? sp.content_similarity_max,
                                     sp.content_similarity_max),                          // 只能调低
  }
}
function assert_can_send(source_type) {
  if (!policy.sending_enabled || policy.collect_only) fail('POLICY_SENDING_DISABLED', { stage: STAGES.SCHEDULE, reason: 'sending_disabled' })
  if (daily_used[source_type] >= effective_limit(source_type).daily_max) fail('QUOTA_EXHAUSTED', { stage: STAGES.SCHEDULE, reason: 'daily_max_reached' })
  // active_hours 只能调短：本地窗口必须是服务端窗口的子区间，不得新增窗口
}
```

【自检方法】

```bash
# 静态：client/ 与 license-server/ 中不得出现限额常量
node test/lint-hardcoded-limits.js        # 期望 0 命中（10/25/30/70/12600/0.85 等）

# 人工：在客户端把 comment 日上限改成 999、间隔改成 30 秒
# 期望：本地拒绝 + UI 提示 + 写出一条 applied=false, reject_code=POLICY_VIOLATION 的审计
# 期望：观察期（第 1-3 天）任何操作都无法让引擎发起一次发送；send_id 为 0 个
```

### 红线 2：只对平台确认成功的发送计费

**要求**：计费资格**必须同时**满足：`verdict=sent_confirmed` + `confirm_signal=platform_response` + `platform_status_code=0` + 未超当日策略上限 + 该 `send_id` 未计费过。**DOM 判断不算成功。空响应 = 风控拒绝，不得标记成功。**

【错误实现】

```js
// ❌ 旧代码 live_dm_worker.js:211 的判据：编辑器消失/正文出现即认为已发送
if (!composer.hasEditor || (!composer.editorText && bodyText.includes(task.text))) {
  await markSent(leadId, "message_detected")        // ← 把"页面崩了"记为"已发送"
}
// ❌ 旧代码 reply_worker.js:406 之前的早期版本：只按 DOM 现象判成功
if (editor_gone) return { ok: true }
```

【为什么错】编辑器消失的原因可能是页面崩溃、标签页被杀、被风控静默拦截——三者都不是"发送成功"。按 DOM 判定会同时造成两个后果：**给商家虚高的统计（他要为此付钱）**，以及**服务端失去封号取证所需的真实明细**。本项目的计费与免责能力都建立在"平台确认"这一条上。

【正确做法】

```js
// ✅ platform/publish-verifier.js —— 唯一允许的成功判定入口
function judge_send({ captured_response, dom_stable_ms }) {
  if (captured_response === undefined) {                       // 没抓到任何平台响应
    return dom_stable_ms >= 3000
      ? { verdict: 'sent_confirmed_dom', is_final: true, evidence: { confirm_signal: 'dom_stable', dom_stable_ms } }  // 不计费
      : { verdict: 'sent_suspected', is_final: false, evidence: { confirm_signal: 'none' } }                         // 不计费
  }
  const raw = captured_response.body || ''
  if (raw.trim() === '') {                                     // 空响应 = 风控拒绝
    return { verdict: 'failed', is_final: true, failure_reason: 'risk_control_rejected',
             evidence: { confirm_signal: 'none', risk_control_signal: 'empty_response' } }      // 不计费
  }
  // ⚠️ 必须同时满足 HTTP 200 与 status_code:0；只匹配响应体是不够的
  const status_code = JSON.parse(raw).status_code                  // 解析失败按 unknown 失败处理
  if (captured_response.http_status === 200 && status_code === 0) {
    return { verdict: 'sent_confirmed', is_final: true,
             evidence: { confirm_signal: 'platform_response', platform_endpoint: 'comment/publish', platform_status_code: 0 } }
  }
  return { verdict: 'failed', is_final: true, failure_reason: 'content_rejected',
           evidence: { confirm_signal: 'platform_response', platform_status_code: status_code } }  // 不计费
}
```

**必须用 CDP `Network` 域被动嗅探，不得用 `Fetch` 域**（`shared/已知陷阱与平台知识.md` §3.1）：

```js
cdp.on('Network.requestWillBeSent', on_req)      // 只看 POST 且 url.includes('comment/publish')
cdp.on('Network.responseReceived', on_resp)      // 记录 http_status，并立刻 Network.getResponseBody
// ...此处才执行 Enter 发送动作...
cdp.off('Network.requestWillBeSent', on_req); cdp.off('Network.responseReceived', on_resp)
```

① `Fetch.enable` 会**拦截并暂停**请求，漏发 `Fetch.continueRequest` 会让商家真实页面永久挂起；`Network` 域是**纯监听**，不改变页面行为。② 监听**必须先于发送动作注册**，否则响应可能已到达而捕获不到。③ `Network.getResponseBody` 可能失败——**取失败要当作"未拿到平台响应"（`failed` + `unknown`），不得当作成功**。④ 匹配 `status_code` 的正则必须允许冒号两侧空白（`/"status_code"\s*:\s*0/`），不要简化成 `"status_code":0`。

【自检方法】

1. 搜索成功判定路径：全项目**只有** `platform/publish-verifier.js` 能返回 `verdict`；其他地方出现 `ok: true` 表示发送成功即缺陷。
2. 跑离线 fixtures：`node test/run.js`，用例必须包含"空响应 → `failed` + `risk_control_signal=empty_response`"与"`status_code: 7` → `failed`"。
3. 真机：连发 3 条，其中 1 条故意让回复命中平台敏感词，确认该条判 `failed` 且**上报后 `billing_status=not_billable`**。

### 红线 3：审计必须记录真实生效的策略值

**要求**：每次发送与配置变更留痕，审计记录**实际生效的策略版本与生效值**（不只是用户设置值）。**只上传哈希与计数，绝不上传评论原文、回复内容原文、用户隐私字段。**

【错误实现】

```js
// ❌ 只上报用户设置值；审计里带上了原文
audit.push({ field: 'limits.comment.daily_max', new_value: String(user_settings.daily_max), applied: true })
report({ ..., comment_text: comment.text, reply_text, sec_uid: lead.sec_uid })     // 隐私泄露 + 整条被拒
```

【为什么错】纠纷时要回答的是"该账号当时**实际生效**的策略是什么、用户是否主动调高过、系统是否拒绝过"。只记设置值无法自证（用户设 10、系统只允许 5，实际发 5——记 10 就是自证失败）。带原文上报会触发 `REPORT_PRIVACY_VIOLATION`，整条被拒，等于明细全部丢失。

【正确做法】

```js
// ✅ 记录"设置值 + 策略值 + 实际生效值"，并区分来源
audit_config_change({
  field_key: 'limits.comment.daily_max',
  old_value: String(previous_effective), new_value: String(next_effective),   // 生效值，不是设置值
  source: 'user', actor: 'local_user',
  applied: false, reject_code: 'POLICY_VIOLATION',                            // 越权尝试必须留痕 + 给 reject_code
  policy_version: policy.policy_version,
})
// ✅ 上报只带哈希与计数
{ target_hash: hmac(privacy_salt, video_id + '|' + comment_id),
  user_key_hash: hmac(privacy_salt, sec_uid), user_key_type: 'sec_uid',
  content_hash: hmac(privacy_salt, reply_text) }
```

【自检方法】

```bash
# 静态：禁用字段名不得出现在上报/日志的构造处
node test/lint-forbidden-fields.js   # 期望 0 命中：comment_text/danmaku_text/reply_text/nickname/sec_uid/uid/phone/avatar_url/token/cookie/sign_key/password
# 人工：把客户端配置改到超上限 → 服务端必须拒绝且能导出 POLICY_VIOLATION 记录
```

---

## 3. ⚠️ 本项目最常见的 12 个误实现

> 每条都给出【错误实现】【为什么错】【正确做法】【如何自检】。**这一节是本文件最重要的部分。**

### 3.1 把"DOM 上看起来发出去了"判定为成功

【错误实现】`if (!composer.hasEditor) return { ok: true }` / `if (editor_gone) mark_sent()` / 把页面崩溃、标签页被杀一并记成成功。

【为什么错】旧代码 `live_dm_worker.js:211` 就是"编辑器消失即判 `message_detected`"，把**页面崩了**记成**已发送**（基线缺陷 D-12），统计虚高且服务端失去取证明细。DOM 现象与"平台已接受"之间没有必然因果关系。

【正确做法】见红线 2 的 `publish-verifier`。四级口径必须严格区分：

| verdict | 判据 | 计费 |
|---|---|---|
| `sent_confirmed` | `confirm_signal=platform_response` 且 `platform_status_code=0` | **是** |
| `sent_confirmed_dom` | 无平台响应，回复节点稳定存在 ≥3000 ms | 否 |
| `sent_suspected` | 无明确失败信号，也拿不到确认条件（编辑器消失属此类） | 否 |
| `failed` | 有明确失败信号（平台错误码、**空响应**、发送按钮报错、超时元素未出现） | 否 |

【如何自检】`grep -rn "ok: true" client/platform client/adapters` 应只在 `publish-verifier.js` 的 `sent_confirmed` 分支命中；`grep -rn "Fetch.enable" client/` 必须无输出（只能用 `Network` 域）；跑 fixtures 中的"空响应"用例必须得到 `failed`，另需两个用例：`http_status: 500 + status_code:0` → `failed`、`http_status: 200 + status_code:0` → `sent_confirmed`。

### 3.2 把日上限、最小间隔等安全数值硬编码在客户端

【错误实现】`const DAILY_MAX = { comment: 30, dm: 10 }`；`const TIER = day <= 3 ? 'observation' : 'warm_up'`（客户端自行推算等级）。

【为什么错】`protocol.md` §4.6 明确 `tier_table` 是**全系统唯一来源**，任何地方硬编码 `0/10/25/30/70/12600` 都会在策略调整后失去同步；等级**只以服务端下发为准**，客户端自行推算会在跨时区、时区偏移变化、账号启用日修正时算错。

【正确做法】所有限额取自心跳/登录/`GET /policy/current` 返回的 `policy`；本地只保存服务端下发的 `policy_version` + `policy_hash` + `applied_limits`（**实际生效值**）。`account_day_index`、`account_tier` 直接使用服务端值。

【如何自检】`node test/lint-hardcoded-limits.js` 为 0 命中；断网后客户端**不得**自行推进等级或放宽上限。

### 3.3 允许客户端把上限调高

【错误实现】`daily_max = user_input`；`min_interval_ms = Math.min(user_input, policy_value)`（方向反了）；`active_hours` 允许用户新增窗口。

【为什么错】方向共四个，**任一方向反了都是 `POLICY_VIOLATION`**，服务端会整批拒绝并留痕。反向后你会得到"看起来能跑、被服务端拒绝、账目与统计全空"的假成功。

【正确做法】

| 项 | 唯一正确方向 |
|---|---|
| `daily_max` | 只能**调低** → `Math.min` |
| `min_interval_ms` | 只能**调高**（间隔更长，且必须落在 `min_interval_ms_range` 内） → `Math.max` |
| `content_similarity_max` | 只能**调低** → `Math.min` |
| `active_hours` | 只能**调短**（不得新增窗口），本地窗口必须是服务端窗口的子区间 |

【如何自检】写一个四象限单测：对每一项分别构造"用户值更激进"与"用户值更保守"两种输入，断言结果永远等于服务端值或更保守值。

### 3.4 实现"内容相似度"时把方向弄反

【错误实现】`if (similarity < content_similarity_max) reject('内容太相似')`；或 `if (similarity <= threshold) skip()`。

【为什么错】`protocol.md` §4.6：**与近期已发内容的相似度超过该值即拒绝发送（0.85 = 相似度 > 85% 拒绝）**。方向弄反的结果是：**高度相似的模板可以一直发（内容级 spam，正是平台判定的重点），而不同的话术反而被拒**——完全反向的防护。

【正确做法】

```js
// ✅ 相似度越高越危险：超过阈值即拒绝
function assert_content_acceptable(reply_text, recent_texts, threshold) {
  for (const prev of recent_texts) {
    if (simhash_similarity(reply_text, prev) > threshold) {          // > 而不是 <
      fail('POLICY_VIOLATION', { stage: STAGES.SCHEDULE, reason: 'content_too_similar',
                                 context: { similarity: round3(sim), threshold } })
    }
  }
}
```

同时：每条规则的模板池**至少 5 条变体**；变量填充禁止用 `{随机1-9}` 生成 `1` `2` 这类明显机器痕迹，须用自然语言变体（"这个""这款""它"）。

【如何自检】单测：构造两条相似度 0.95 的文本 → 必须拒绝；两条相似度 0.2 的文本 → 必须放行。断言里把阈值写成 `0.85` 并从 policy 注入，不要写字面量。

### 3.5 对失败的发送也计费

【错误实现】按"尝试次数"计费；`reply_attempts` 直接乘单价；把 `sent_suspected` 也算进去。

【为什么错】违反红线 2 的计费资格。计费公式是 `COUNT(verdict="sent_confirmed" 且资格成立 且未超上限) × credit_per_reply_milli`。**不计费清单**（对商家有利，须写入 UI 与客服话术）：失败、被平台风控拒绝、被跳过、未命中规则、`sent_suspected`、仅 DOM 判据确认且 `bill_dom_confirmed=false`、超出当日上限、余额耗尽后的发送。

【正确做法】

```js
// ✅ 服务端唯一计费判定（protocol.md §6.4）
const billable = s.verdict === 'sent_confirmed'
  && s.evidence.confirm_signal === 'platform_response'
  && s.evidence.platform_status_code === 0
  && !over_limit && !acc.insufficient
```

【如何自检】跑边界用例（`protocol.md` §6.6）：一批 10 条 = 4 `sent_confirmed` + 3 `failed` + 2 `sent_suspected` + 1 `sent_confirmed_dom` → **必须只扣 4 条**，其余 6 条 `not_billable`，且 10 条明细全部留痕。

### 3.6 客户端上报"成功"就计费

【错误实现】服务端信任客户端自报的汇总数字（如 `sent_ok: 12`）作为计费依据；或只要 `send_id` 没见过就扣费。

【为什么错】计费依据**只有** `POST /api/v1/audit/sends` 的逐条明细（含平台响应证据）。`/usage/report` 是聚合计数，明确"**不是计费依据**"，只用于看板与对账（明细与聚合不符时**以明细为准**）。信任汇总数字等于把计费权交给可被篡改的客户端。

【正确做法】服务端逐条结算：幂等键 `(account_id, send_id)` 唯一索引 + 校验 `confirm_signal=platform_response` + `platform_status_code=0` + 当日额度 + `applied_policy_version` 存证。聚合上报只做对账，不符记 `audit_flags:["aggregate_mismatch"]`。

【如何自检】§6.6 用例 4："平台返回 `status_code != 0` 但客户端标成 `sent_confirmed`" → 必须 `not_billable` + `audit_flag:"evidence_invalid"`，不扣费。用例 20（验收 20）：同一 `sendId` 重复上报 10 次只扣 1 条。

### 3.7 忘记在**发送前**生成并落盘 `send_id`

【错误实现】发送成功后再生成 `send_id`；或发送前生成但只放在内存变量里；崩溃恢复时重新生成。

【为什么错】`send_id` 是**幂等键与计费键**。若发送后才落盘，进程在"已发出、未落盘"的窗口内崩溃 → 重启后无法判断这条是否发过 → 重发时用了新 `send_id` → **同一发送被计费两次**（违反 S-5 零重复）。这正是旧代码"抢占用陈旧快照、崩溃后状态错乱"教训的同源问题。

【正确做法】

```
① 生成 send_id（'s-' + 32 hex）
② 原子写 pending_sends.json（.tmp-<pid> → fsync → rename）   ← 必须先于发送
③ 才发起发送动作
④ 拿到平台响应后更新同一条记录的 verdict / evidence
⑤ 收到服务端 ACK 后才删除该条
崩溃恢复：复用落盘的 send_id，attempt_seq += 1，绝不重新生成
```

【如何自检】单测：模拟"② 之后、④ 之前"杀进程 → 重启后断言 `pending_sends.json` 中存在该 `send_id`，且重试复用它。`grep -n "randomUUID" client/adapters` 应出现在任何 `send_*` 调用**之前**。

### 3.8 用空 catch 吞异常

【错误实现】`try { fs.writeFileSync(path, data) } catch {}`。

【为什么错】**本项目最贵的一次教训**：旧代码 `reply_worker.js:490-494` 写去重历史时用了 `catch {}`，而路径因 D-1 硬编码在非原作者机器上不存在，写盘**每次都失败却无人知晓** → 去重历史从未落盘 → **同一评论被重复回复** → 触发风控，且排障时没有任何线索。

【正确做法】三选一：① 升级为带 `stage`/`reason` 的 `WorkbenchError` 由调用方决定降级；② 确属可忽略的清理动作，必须打 `warn` 日志 + 计数，并写明忽略理由；③ 可选功能缺失走"显式跳过 + `info` 日志 + 返回 null"。**禁止第四种**（裸 catch）。

【如何自检】

```bash
node test/lint-empty-catch.js      # 期望 EMPTY_CATCH_TOTAL 0
grep -rn "catch {}\|catch (e) {}" client license-server shared/lib    # 期望无输出
```

### 3.9 多个进程各自读写同一个 JSON 文件

【错误实现】`reply_worker` 抢单时全量覆写队列，同时 `server.js` 也在读-改-写追加新任务；`live_config.json` 被三个模块同时写。

【为什么错】旧代码因此产生 D-7（**新任务被静默抹掉**）、D-10（评论库丢数据）、`live_config.json` 回退。根因统一为"多进程无锁覆写同一个文件"。旧实现里"回写路径有重读保护、抢占用没有"这种不一致，正是靠人工纪律无法守住的证据。

【正确做法】**单写者**：只有 `client/host/` 主进程读写实例文件；其他模块经 IPC 请求。所有写入走 `store.js`：以最新内存态为基准 + 纯函数改动 + 原子写（`.tmp-<pid>` → `fsyncSync` → `renameSync`）+ 同文件写入串行化。JSON 头带 `schema_version`。

【如何自检】

```bash
# 只有 host/ 可以 require node:fs 去碰实例数据文件
grep -rn "require('node:fs')\|require(\"fs\")" client | grep -v "^client/host/"
# 期望：只出现在 core/browser-host.js（标签页/进程管理）等明确不碰实例数据的文件
node test/store-race.test.js     # 并发入队 200 次，断言零丢任务
```

### 3.10 忽略"页面上同时存在隐藏与可见两套 DOM 结构"

【错误实现】`document.querySelectorAll('[data-e2e="comment-list"]')[0]` 直接用第一个；用隐藏结构里的按钮坐标点击。

【为什么错】抖音页面常同时存在隐藏与可见两套 `comment-list`，**隐藏的那套里按钮尺寸为 0**。取到隐藏结构 → 坐标 0×0 → 点击落到页面左上角或无效 → 表现为"点击无效/找不到编辑器"的诡异失败。旧作者用真账号试错才确认这条。

【正确做法】

```js
// ✅ 只用可见元素：尺寸非 0 且在视口内；选择器集中定义
const COMMENT_LIST = { key: 'comment_list', expr: '[data-e2e="comment-list"]', require_visible: true }
function pick_visible(selector_key) {
  const lists = Array.from(document.querySelectorAll(SELECTORS[selector_key].expr))
  return lists.find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }) || null
}
```

配套两条：**评论区必须等到真正可见**（容器 `display` 由 `none` 变为可见）才能操作按钮；**图文帖（`/note/<id>`）** 的评论区是右侧小浮层，需点击 `[data-e2e=feed-comment-icon]` 展开，旧版不支持回复该类时标记 `note_post_panel_unsupported`。

【如何自检】`test/fixtures/` 中放入"同时含隐藏与可见 comment-list"的真实快照，断言 `pick_visible` 返回可见那个；断言隐藏结构的 `getBoundingClientRect().width === 0`（用断言把这个坑固化下来）。

### 3.11 用固定间隔发送

【错误实现】`await sleep(10000 + Math.random() * 4000)`（旧代码 `reply_worker.js:526` 的写法）；或用固定 `setInterval`。

【为什么错】固定节奏（尤其是"固定值 + 均匀抖动"）是机器行为的强特征。需求 FR-2.3.4 明确要求：发送间隔改为**对数正态分布**（多数偏短、偶尔长间隔）；每次点击/输入前加 **1-3 秒随机停顿**；仅在活跃时段工作且**每天随机起止**；弹幕命中后加入人工量级延迟，避免"秒回"特征。

【正确做法】

```js
// ✅ 对数正态分布：多数偏短、偶尔长间隔；且永不小于服务端最小间隔
function next_interval_ms(min_interval_ms) {
  const mu = Math.log(min_interval_ms * 1.4), sigma = 0.45
  const u1 = Math.random() || 1e-9, u2 = Math.random()
  const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(min_interval_ms, Math.round(Math.exp(mu + sigma * gauss)))
}
async function human_pause() { await sleep(1000 + Math.random() * 2000) }   // 点击/输入前 1-3 秒
```

**注意区分两类随机**：这里是为了规避机器行为特征的**发送节奏**随机；`开发规范.md` §6.5 的网络重试退避抖动是**可用性**手段。两者不得混用同一函数。

【如何自检】采样 1000 次 `next_interval_ms(60000)`，断言：全部 ≥ 60000（不小于服务端最小间隔）、分布有明显长尾（P99 > 3×P50）、不集中在单一值附近（`new Set(samples).size > 500`）。

### 3.12 把工作台账号与抖音账号搞混

【错误实现】用商家登录客户端的账号密码去登录抖音；把抖音昵称当 `account_id`；把 `sec_uid` 当工作台账号上报。

【为什么错】这是**两个完全不同的东西**：

| | 工作台账号 `account_id` | 抖音账号 |
|---|---|---|
| 谁创建 | 厂商创建并下发（账号+密码） | 商家自己的，登录在专用 Chrome 里 |
| 用途 | 登录客户端、计费、策略下发、审计归属 | 工具以它的身份在抖音上操作 |
| 存储 | 服务端数据库；客户端存 token | 在商家本机 Chrome 的 `--user-data-dir`（`dy-main`）里 |
| 能否注册 | **不能**，无注册接口 | 不适用 |
| 是否上报 | 是（`account_id`） | **否，绝不上报原始标识**（只上报 `user_key_hash`） |

搞混的后果：登录失败、策略下发到错误账号、审计归属错乱、把抖音用户标识上报造成隐私违规。

【正确做法】严格按术语表（`shared/术语与选型基准.md` §一）使用；变量命名不得含糊（禁止 `account`、`user` 这类二义名，必须写 `workbench_account_id` 或 `douyin_user_key_hash`）。

【如何自检】`grep -rn "\baccount\b" client/` 检查是否有二义用法；上报体字段用 schema 校验，出现 `sec_uid`/`uid` 即拒绝。

---

## 4. 写 CDP 代码前的必查清单

**每个 DOM 操作前逐条确认，并在 PR 描述里贴出对照的 `legacy/` 行号。**

| # | 必查项 | 判定标准 | 不确认的后果 |
|---|---|---|---|
| 1 | **元素是否可见** | `getBoundingClientRect()` 的 `width > 0 && height > 0` 且在视口内 | 命中隐藏结构，坐标为 0×0，点击无效 |
| 2 | **是否需要等待渲染** | 评论区容器 `display` 由 `none` 变可见后才操作按钮；展开后再等一个渲染帧 | 提前操作 → 元素不存在 → `element_timeout` |
| 3 | **`scrollIntoView` 后是否延迟读坐标** | 滚动后**必须延迟**（≥300ms）再读按钮坐标 | 虚拟列表重渲染，读到旧坐标或 0×0 |
| 4 | **当前标签页是否是目标页** | 操作前 `Target.activateTarget`；并校验当前 URL 属于目标页类型 | 在错误的标签页上操作，或操作了商家正在看的页面 |
| 5 | **评论面板是否真正展开** | 需要点击展开时（如图文帖 `feed-comment-icon`）确认展开完成 | 在未展开的面板上找元素 → 永远找不到 |
| 6 | **是否图文帖（note 帖）** | URL 含 `/note/<id>` 即为图文帖，评论区是右侧浮层；不支持时标记 `note_post_panel_unsupported` 并跳过 | 按视频帖逻辑操作 → 全部失败 |
| 7 | **URL 形态是否符合预期** | 抖音会把 `/video/<id>` 重定向到 `/jingxuan?modal_id=...`，判定逻辑要能识别两种形态 | URL 判定失败 → 误判"页面未打开" |
| 8 | **搜索页是否用了新标签页** | 搜索页在长期复用标签里会退化（加载不出结果），**必须用新标签页**；用后关闭 | 搜索结果为空，误判"无数据" |
| 9 | **平台响应是否已开始嗅探** | 发送**之前**就 `Network.enable` 并挂上 `requestWillBeSent`/`responseReceived` 监听，且监听目标接口路径片段；**不得用 `Fetch.enable`** | 发送后才发现没监听 → 拿不到证据 → 只能判 `sent_suspected`（不计费）；用 `Fetch` 漏 continue 会让商家页面卡死 |
| 10 | **选择器是否来自注册表** | 只能从 `client/platform/selectors.js` 取，且带 `key` / `lastVerifiedAt` / `confidence` / `notes` | 选择器散落 → 改版时要改 N 个文件（S-4 失败） |
| 11 | **失败是否带 stage + reason** | 每步产出 `StepResult{ok, stage, reason}`；`selector_miss` 必须带选择器 key | 失败无法定位（S-3 失败），改版时无从下手 |
| 12 | **是否用了 Enter 三段式按键** | `rawKeyDown` → `char` → `keyUp` 三段（旧代码已验证的必要形式），并有发送按钮兜底；**标签页必须在前台**（`Input.dispatchKeyEvent` 只对活动标签生效） | 单段按键在部分页面不触发提交；标签页不在前台则按键丢失 |
| 13 | **标签页存活检查** | 操作前确认目标标签页仍存在；`tabFails ≥ 2` 时重建连接而非继续重试 | 在已关闭的标签页上操作 → 连续失败 → 误触熔断 |
| 14 | **弹幕 `sec_uid` 是否被脱敏** | 直播弹幕 DOM 常把用户 ID 脱敏为 `*****`；取不到真实 `sec_uid` 时标记 `not_locatable` 并**计入跳过** | 拿 `*****` 去构造主页 URL → 私信必然失败 |
| 15 | **该渠道的真实接口路径片段是否已确认** | `comment/publish` 已验证。**私信与直播弹幕的真实接口名 legacy 从未验证过**，必须先手工用 DevTools Network 面板发一条、记录路径片段与成功码字段 | 凭猜测写 `im/send` / `live/comment/send` → 判定永远为 false，看起来像风控，实际是自己写错了关键字，白耗真机验证配额 |

**通用禁忌**：不要在 `Runtime.evaluate` 的表达式里拼接用户输入（XSS 式注入到页面上下文）；不要把 `data-e2e` 字符串写到 `selectors.js` 以外的文件；不要用 `document` 全局搜索代替可见性判定。

---

## 5. 智能体的自检方法

### 5.1 每实现完一个功能，先自问自答这 12 个问题

把答案写进你的汇报（§7 模板）：

1. 这个功能的**安全上限**来自哪里？是从服务端 `policy` 取的，还是我写死的？
2. 有没有任何路径能让**上限被调高**？四个方向（`daily_max`↓ / `min_interval_ms`↑ / `content_similarity_max`↓ / `active_hours` 缩短）我逐个检查了吗？
3. 这个功能在**观察期**（`sending_enabled=false`）会发生什么？会不会生成 `send_id` 或发起发送？
4. 我的成功判定依据是**平台响应**还是 DOM 现象？如果是 DOM 现象，我把它标成哪个 verdict？
5. 空响应 / 非 0 `status_code` 走的是哪条分支？会不会被标成成功？
6. `send_id` 在**发送前**落盘了吗？崩溃恢复时是复用还是重新生成？
7. 我的代码里有没有 `catch {}`？每个失败带 `stage` + `reason` 吗？
8. 我写盘的模块是 `host` 吗？是原子写吗？有没有拿陈旧快照全量覆盖？
9. 我上报/打日志的字段里有没有禁用字段（原文、`sec_uid`、token、完整手机号、完整 URL）？
10. 我的选择器来自 `selectors.js` 吗？我确认过元素**可见**吗？
11. 我的间隔/延迟是随机化的吗？会不会小于服务端最小间隔？
12. 这段代码如果进程被杀、网络断开、标签页关闭，会怎样？会不会产生重复发送或重复计费？

### 5.2 必须运行的命令

```bash
# 1) 语法检查（改动涉及的每个文件，至少包括入口）
node --check client/host/main.js
node --check license-server/server.js

# 2) 项目统一自测入口
node test/run.js

# 3) 门禁脚本（任一非 0 即不得声称完成）
node test/lint-empty-catch.js
node test/lint-hardcoded-limits.js
node test/lint-selector-centralization.js
node test/lint-forbidden-fields.js

# 4) 离线回归（不登录、不联网、不碰真账号）
node test/run.js --suite fixtures

# 5) 环境自检
node -e "const s=require('node:sqlite');console.log(Object.keys(s))"     # node:sqlite 可用
curl -sS http://127.0.0.1:18080/healthz                                  # 服务端健康（开发环境）
```

### 5.3 什么情况下应当停下来问人，而不是继续猜

**硬性触发条件（满足任一条即停止实现并提问）：**

| # | 触发条件 | 为什么不能猜 |
|---|---|---|
| 1 | 需要**真实抖音账号**才能验证（DOM 定位、发送链路、风控表现） | 你没有账号，猜出来的实现无法验证；而"未验证"与"已完成"是两件事 |
| 1b | 需要确认真实的**平台接口路径片段与成功码字段**（私信、直播弹幕 legacy 从未验证过） | 猜错会让成功判定永远为 false，看起来像风控，实际是关键字写错，白耗真机验证配额 |
| 2 | 涉及**任何限额数值**（日上限、最小间隔、相似度阈值、活跃时段、等级天数） | 权威来源只有服务端 `tier_table`；写死或猜错即违反红线 1 |
| 3 | 涉及**计费口径**（什么算成功、扣多少、失败怎么算、余额不足怎么处理） | 计费直接对应商家付款与厂商收入，猜错要退钱并失去信任 |
| 4 | 需要**引入白名单外依赖** | 白名单只有 `ws`；引入需报备（`开发规范.md` §8.1） |
| 5 | 需要**改动 `legacy/`** 或删除它 | 红线：`legacy/` 只读存档，是唯一的行为规格来源 |
| 6 | 需要**放宽**任何安全限制或绕过验证码/风控 | 红线 1 与 FR-6.2；这是产品存在的前提 |
| 7 | 发现**两份文档互相矛盾** | 你无权裁定哪个为准；擅自选择可能反向实现（例如"按小时计费"vs"按条计费"） |
| 8 | 需要**改动公网服务器**（部署、防火墙、端口） | 目标机与 sing-box 共用 443/8443；错误改动会中断现有代理服务 |
| 9 | 需要**真实账号密码 / 生产密钥 / 商家数据** | 凭据由甲方提供；自行索取或猜测属越界 |
| 10 | 验收标准本身**不可判定**（如"界面要高级"） | 需要人给出可判定标准，否则你永远无法证明完成 |

**提问的格式**：一句话说明卡点 + 你已查过哪些文档（章节号）+ 你倾向的选项及理由 + 需要对方给出的具体决定。不要提"我应该怎么做"这种没有信息量的问题。

---

## 6. 不要做的事

| # | 禁止 | 说明 |
|---|---|---|
| 1 | **不要为了"让功能跑通"而放宽安全限制或绕过风控** | 包括：把观察期改成 1 天、把日上限调高、把 `POLICY_VIOLATION` 改成警告继续发、遇验证码后自动重试而不是熔断。红线 1 与 FR-6.2：**限制本身就是产品价值**。遇风控只做一件事——**熔断**（30 分钟 → 1 小时 → 停到次日） |
| 2 | **不要删除 `legacy/`，也不要让生产代码 `require` 它** | 它是用真账号试错换来的行为规格，是重写后唯一能对照的基线。删除等于永久丢失 DOM 知识 |
| 3 | **不要引入白名单外的依赖** | 白名单只有 `ws`；服务端零第三方依赖。明确排除 `puppeteer-core`/`playwright`（指纹、用不上已登录账号、绑定 Chrome 版本） |
| 4 | **不要重构无关代码** | 改造范围控制：只改与任务相关的文件。发现无关缺陷 → 记录到汇报里，不要顺手改（会让评审与回滚失控）。旧代码的问题记录在 `docs/需求规格.md` §七之二，是"设计反面教材"而非待修清单 |
| 5 | **不要在没有真实账号验证的情况下声称"已完成"** | 必须区分三档：**代码写完**（语法与单测通过）/ **离线验证通过**（fixtures 全绿）/ **真机验证通过**（真实账号真页面）。涉及 CDP 的功能，只有第三档才算完成，前两档必须显式声明"未真机验证" |
| 6 | 不要把 Token / Cookie / 密码 / `sec_uid` / 评论与回复原文写进日志、上报或提交 | 见红线 3 与 `开发规范.md` §3.3 |
| 7 | 不要把 `0.0.0.0` 当本地控制台绑定地址 | 只允许 `127.0.0.1`（旧代码 D-6：局域网可访问 + 跨站可直接发评论） |
| 8 | 不要提交 `node_modules`、`data/`、`instances/`、登录态（`dy-main`）、二维码、真实凭据 | 只提交 `.env.example`（键名 + 占位值） |
| 9 | 不要用 `process.exit(1)` 处理运行期异常 | 顶层异常必须捕获 → 归因 → 任务回退 → 继续运行（S-1） |
| 10 | 不要把"未识别的响应字段"当成错误 | 契约要求客户端忽略未知字段（§8.1），否则服务端新增字段会导致旧客户端全线失败 |
| 11 | 不要自行推算账号等级或天数 | `account_day_index` / `account_tier` 只以服务端下发为准 |
| 12 | 不要用聚合上报的数字计费 | 计费只依据 `/audit/sends` 逐条明细；聚合用于看板与对账 |

---

## 7. 沟通模板

每次完成任务后，**按以下格式**汇报。缺项视为未完成。

```markdown
## 任务：<一句话说明做了什么>

### 改动的文件
| 文件 | 改动类型 | 说明 |
|---|---|---|
| `client/safety/guard.js` | 新增 | 四方向限额判定 + 越权本地拦截 |
| `client/adapters/reply-comment.js` | 修改 | 发送前落盘 send_id |

### 为什么这样改
<3-5 行。引用依据的文档章节号，例如 `protocol.md` §4.6、`docs/需求规格.md` FR-2.3.4。
若与旧代码行为不同，说明差异与理由，并贴 legacy 对照行号（如 `legacy/reply_worker.js:479-481`）。>

### 跑了什么验证
| 命令 | 结果 |
|---|---|
| `node --check client/safety/guard.js` | 通过 |
| `node test/run.js` | 通过（42/42） |
| `node test/lint-hardcoded-limits.js` | 0 命中 |
| `node test/guard-directions.test.js` | 通过（8 个方向用例） |

### 哪些没验证（必须诚实列出）
- **未真机验证**：`adapters/reply-comment.js` 的发送链路改动需要真实抖音测试账号，
  当前只跑了 `test/fixtures/comment-list.html` 的离线断言。
- 未验证：断网 3 小时后的补报路径（需要可控的网络中断环境）。

### 不确定 / 需要人确认
1. `<具体问题>`。已查：`protocol.md` §4.8、§6.5；未找到明确答案的是 `<具体点>`。
   倾向选项 A（理由：…），但需确认。
2. `<具体问题>`。这涉及限额数值，按规则不自作决定，等确认后实现。

### 红线自查（逐条打勾）
- [ ] 限值全部来自服务端 policy，无硬编码（`node test/lint-hardcoded-limits.js` 0 命中）
- [ ] 未新增任何"调高上限"的路径；越权尝试写审计且带 `applied=false` + `reject_code`
- [ ] 成功判定只用平台响应；空响应/非 0 状态码均为 `failed` 且不计费
- [ ] `send_id` 发送前落盘，崩溃恢复复用
- [ ] 无空 catch；每个失败带 `stage` + `reason`
- [ ] 日志与上报无禁用字段（原文/`sec_uid`/token/完整手机号/完整 URL）
- [ ] 未引入白名单外依赖；未改动 `legacy/`；未重构无关代码
```

**汇报时的三条纪律**：

1. **不夸大**：把"代码写完""离线验证通过""真机验证通过"分清楚，不要用"已完成"含混过去。
2. **不隐瞒不确定性**：不确定项主动列出。隐瞒的代价在客户端是封号、在服务端是账目错乱。
3. **不擅自扩大范围**：顺手改的东西必须单独列在"额外改动"里并说明理由，否则评审无法判断风险面。
