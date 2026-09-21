# Python sidecar

`sidecar.py` handles exactly one UTF-8 JSON request line and then exits. Its
stdout contains only one progress object and one final object; diagnostics go
to stderr. The trusted host starts it with absolute, account-specific paths:

```text
python sidecar.py --state-dir C:\AgentData\account-a\state --profile-dir C:\AgentData\account-a\profile --port 19222
```

The supported methods are `capabilities`, `launch`, `doctor`, `open`,
`search`, `collect_comments`, `collect_live`, `send_private`,
`send_comment`, the live batch methods `live_listen`, `live_plan`, `live_reply`,
`live_private`, `live_result`, and owned-browser `close`. `v.douyin.com` query strings are
kept only while navigating a short link; the response returns the resolved
URL without its query string. `state-dir` and `profile-dir` must be absolute
and outside the source directory.

## Comment two-phase closure

Five methods drive the 评论 → 公开回复 → 私信 closure. They are thin wrappers
over `comment_flow.CommentQueue`, so the state machine is testable without a
browser:

| Method | Purpose |
| --- | --- |
| `comment_enqueue` | Append collected comment targets to the account-scoped queue. |
| `comment_plan` | Open a batch and freeze the scripts. Returns the phase-one candidates. |
| `comment_reply` | Phase one: public reply. Only a platform-confirmed result may be promoted. |
| `comment_private` | Phase two: private message. Refuses every target whose phase-one state is not `sent_confirmed`. |
| `comment_result` | Read back per-target and per-batch state. |

Phase two is gated by `policy.allowPublicStates`, which defaults to
`["sent_confirmed"]`. A target whose public reply came back `unknown` is
refused in **both** phases and is never blind-retried; `failed` honours the
`maxPublicAttempts` budget; `blocked` stops for a human. The frozen plan is
immutable: a policy passed to a later `comment_plan` call for the same batch
is ignored, and `plan.policySource` reports where the policy actually came
from.

`comment_private` writes to a separate `private_json` column so phase two
cannot overwrite phase-one state. `comment_result` never emits `charged`,
`price`, or `balance` — credits are the server's authority alone.

### Where precision belongs

The pipeline has two independent keyword gates, and they measure different
things:

- **Video relevance** (search-side, `minRelevance`) filters on the video
  title. It answers "is this video about what I sell".
- **Comment filtering** (upstream of `comment_enqueue`) matches on the
  comment text. It answers "is this person a customer".

These are not the same axis, and the second is the one that matters:
purchase intent lives in the comment ("求链接", "多少钱"), not in the title.
A loosely-matching video can still contain perfectly on-target commenters.

So the agreed split is: keep the video threshold **loose** — its job is only
to avoid spending collection budget on videos where nobody could plausibly
be a customer — and put the **precision burden on the comment filter**.
Tightening the video threshold instead is a blunt instrument: it discards
on-target commenters who happened to sit on an off-topic video.

The cost asymmetry behind this: missing a relevant video costs almost
nothing, while an off-target DM is irreversible, burns the recipient's
single pre-mutual-follow message slot, and spends account quota.

### Funnel (`comment_result.funnel`)

`funnel` exists so that "should the comment filter be tighter" can be
answered from data instead of vibes. It reports, for one batch:

- `planned` — frozen into the plan
- `blockedBeforeSend` — dropped before any send (missing scripts, etc.)
- `publicEligible` / `publicOutcome` — what phase one can still reach, and
  how the attempts actually landed; `publicOutcome` lists only targets that
  have a result, so `planned` never appears there
- `privateAllowed` / `privateRejected`
- `rejectedReasons` — phase-one and phase-two reasons **aggregated together**

That last point is the whole reason `funnel` exists. Phase-two rejections
alone tell you almost nothing, because most targets never reach phase two.
The two layers have to be read as one distribution.
`collect_comments` accepts the flow-1 filter inputs `commentKeywords`,
`excludeKeywords`, `matchMode` (`phrase` / `seg` / `all` / `any`), `minDigg`,
`maxTargets`, and `dedupeAuthors` (default true). Its response is additive:
`events` keeps the raw collected batch, while `targets` carries the filtered
batch and `filter` reports counts (`collected`, `matched`, `excluded`,
`lowDigg`, `noAuthor`, `dedupedAuthors`, `targetCount`, `modeCounts`). Each
entry in `targets` has the same shape as an `events` entry, so it can be passed
straight to `send_comment` / `send_private` in the two-stage flow.

Exclusion runs after the keyword match: a comment that matches a keyword but
also matches any exclude keyword is dropped, and `filter.excluded` counts only
those. `dedupeAuthors` keeps one entry per commenter (highest `digg` wins);
entries without an `authorId` are never merged with each other. This is the
filter step of `images/11-comment-area-business`; it is covered by offline
regression tests and needs no browser.
`search` reads one page at a time. Call it without `cursor` to start from the
first page; the response carries `cursor`, `hasMore`, `page`, `poolSize`, and
`skippedSeen`. Pass that `cursor` back to read the next page: the tool keeps
scrolling the same owned tab instead of reloading the first page, and any video
already in the cursor pool is filtered out. The cursor is opaque to the host —
the host only stores and returns it — but it is still validated on the
boundary: a cursor issued for another keyword, an unsupported version, or a
pool beyond the cap is rejected with `invalid_input`. `hasMore` is false when a
page yields no new video, which is the host signal to stop paging.
`platformHasMore` / `platformCursor` mirror what the platform response body
reported; they are read-only telemetry and are never replayed against the API.

`search` returns one candidate per video with `id`, `url`, `title`, `author`,
`authorId`, and a `relevance` record. Relevance is computed locally from the
search keyword against the title and is deterministic: every keyword the user
typed appearing contiguously in the title scores 70-100 (a hit at the head of
the title scores highest), all keyword segments present scores 60, a partial
segment match scores at most 39, and no match scores 0. The record carries
`reason`, `matchedSegments` / `missingSegments`, `matchedKeywords` /
`missingKeywords`, `exact`, and `position`, so a host can explain a ranking
instead of trusting a bare number. `minRelevance` (0-100, default 0) filters
candidates inside this module, and `filter` reports `collected`, `returned`, and
`filteredByRelevance`.

Relevance is the textual relatedness of the title, not video quality;
popularity is a separate signal and is deliberately not mixed into the score.
This method only discovers and filters candidates — it never replies to a
comment and never sends a message.

`capabilities.result.capability` uses stable channel names. `implemented`
means the action path exists, while `autoEligible` is the host's explicit
automation gate. Every channel whose real delivery is still unproven reports
`autoEligible: false` — the live and DM channels only have page-side echo
(`roomEcho` / `conversationEcho`), and the IM channel rides a long-lived
connection that yields no HTTP response at all. That now includes
`private_reply`, which previously carried `autoEligible: true` from the PR #1
collaborator run; per `AGENTS.md` red line 6 an unverified capability must
fail closed, so it stays `false` until a platform response (or an explicit
server policy) is bound to the click. `comment_private_candidates` is listed
as well (read-only gate helper, not a send channel).

`comment_batch` covers the two-phase closure above. It reports
`validation.status: offline_fixture` and `autoEligible: false`, and must stay
that way until every release-gate condition in `EVIDENCE.md` §11.8 is met —
the gate is not a formality, it is the only thing standing between a DOM
observation and a claim that a merchant's customer was actually reached.

`video_reply` reports `validation.status: real_device_selectors_2026-09-20`.
That status covers **selector grounding only**, not delivery: on 2026-09-20 the
comment DOM was inspected on a real logged-in account and the previously
invented `data-e2e` names were removed. Delivery is still
`platform_response_when_captured_else_unknown`.

The send result is deliberately one of `unknown`, `failed`, or `blocked`.
Once a click is started, a process cancellation leaves the SQLite record
unresolved and a later request for the same target is blocked. DOM changes do
not become a success claim.

The public-reply channel can reach `sent_confirmed` only through an observed
`comment/publish` network response with a zero platform status code. A
non-zero code is `failed` with reason `platform_rejected`; no capture, or a
capture that cannot be bound to *this* click, stays `unknown`. Private
messages travel over a frontier WebSocket where the platform response is not
observable, so that channel remains `unknown` unless a response is bound to
the click.

For an onedir Windows bundle, run `build_sidecar.cmd` from this directory.
It creates an isolated `.pyinstaller-venv` and writes
`dist\probe-agent\probe-agent.exe`; PyInstaller is a build-only dependency.

## Live batch flow (images/12-live-room-business)

Five further methods implement the collaborator half of the live flow, between
the platform boundary of images/18 and the script boundary of images/09:

| method | phase | needs a browser |
|---|---|---|
| `live_listen` | collect one listening round and enqueue it | yes |
| `live_plan` | take a batch, check the window, freeze host scripts | no |
| `live_reply` | phase one: public reply per accepted item | only when something is sendable |
| `live_private` | phase two: private message, each item bound to its own confirmed public send | only when something is sendable |
| `live_result` | batch report, counts and resume checkpoint | no |

`live_plan` also takes the flow-step-2 filter: `keywords`, `excludeKeywords` and `matchMode`
(`phrase` / `seg` / `all` / `any`), using the same matcher as the video comment path. Matching
happens before a batch is formed: events that miss every keyword, or that match a keyword and an
exclude keyword, are marked `filtered` and never occupy a batch slot. The response reports the
counts under `filter` (`matched` / `missed` / `excluded`).

`live_listen` deduplicates by room plus author plus text and trims the queue to
its capacity, so the host may call it repeatedly. `live_plan` takes a
count-bounded batch inside `windowSeconds`; anything older is marked `expired`
and is never replayed by a later batch (the platform rule 过期处理，不集中补发).
An open batch is reused on retry, so a repeated request cannot create two
batches at once - but only while it is still inside its own window: a batch past
`expiresAt` is retired, its still-planned events are expired with it, and
`live_reply` / `live_private` refuse it with `batch_expired` before any browser
work. A `filtered` event is terminal: matching happens before a batch exists, so
it never occupies a slot and is never picked up by a later batch.

Scripts are the platform artifact. `live_plan` accepts `scripts` keyed by
event id (or fingerprint), each carrying `publicText` and `privateText`; a
missing or out-of-bounds script moves that target to `blocked` before any
browser action and the plan reports it under `blocked`. The sidecar never
writes, rewrites or repairs a script, and `live_reply` / `live_private` refuse
a text that differs from the frozen script (`script_mismatch`) instead of
sending it.

Phase two is derived, never assumed. `live_private` only sends for targets the
queue returns as private candidates: the phase-one public reply must be in
`policy.allowPublicStates` (default `["sent_confirmed"]`), the target must
carry an author id, and `policy.maxPrivate` caps the list. Everything else is
refused with a reason - `public_unknown`, `public_blocked`, `public_failed`,
`missing_author_id`, `over_private_capacity` - so an unresolved public click
never turns into a second, blind contact.

Each item carries the host-supplied `sendId`; the durable reservation, the local
quotas and the never-retry-an-unresolved-click rule stay in `send_gate.py`.
Batch state lives in `live_flow.sqlite3` next to `send_state.sqlite3`.
`live_result` returns per-state counts, the private candidate list and a
checkpoint (phase, pending events, frozen plan size), which is what the host
needs to resume after a restart.

Unverified boundaries, to be resolved before any release switch: the live
selectors remain fixture-validated only, the platform has not been observed to
publish an author id for every live comment, and phase-two delivery keeps the
same `unknown` semantics as the other send paths.

## 分页 / 验证码 / 两阶段契约（2026-09-20 协作修复）

* **游标池 = 本页见过的全部视频**：`search` 的 cursor 里装的池子包含被 `minRelevance` 筛掉的、
  以及超出 `maxVideos` 未返回的视频。原实现只把"保留下来的"放进池里 —— 被筛掉的视频不在池中，
  续页时数据源（或平台滚动重渲染）再把它们摆出来就会被当成新视频重复处理，相关度阈值越高越明显。
  响应 `filter` 新增 `kept`（实际返回条数）与 `poolAdded`（本页新增进池的条数）便于对账。
  回归：`test_relevance_filtered_videos_stay_in_the_cursor_pool`。
* **验证码是终止状态**：命中验证码时返回 `status: "captcha"`、`hasMore: false`、`cursor: null`
  与 `stoppedReason: "captcha_requires_manual_action"` —— 不再给可翻页信号，
  避免上层据此自动继续请求、在风控点上越撞越深。
  回归：`test_captcha_is_terminal_and_offers_no_next_page`。
* **评论区两阶段契约**：`comment_private_candidates` 把一个批次按「公屏是否确认成功」分成
  `allowed` / `rejected`；`send_private` 也接受 `publicSendId`，给出时**必须**是
  `sent_confirmed`，否则在**打开浏览器之前**以稳定原因拒绝：
  `public_missing` / `public_not_found` / `public_not_a_reply` / `public_pending` /
  `public_unknown` / `public_failed` / `public_blocked` / `missing_author_id`。
  ⚠️ `send_gate.result()` 会把 `sent_confirmed` 映射成 `unknown`（避免过度宣称），
  所以契约判定读的是 **`SendGate.lookup()` 返回的原始状态**。
  回归：`CommentFlowContractTests`（5 项，含"不通过就不许打开浏览器"）。
* **直播私信逐项绑定公屏成功（审核意见 2026-09-21）**：`live_private` 的每个 item 必须带
  `publicSendId`，且该 sendId 必须满足两条：①在台账里是"已确认成功的公屏回复"；
  ②就是这个事件自己那次回复（事件详情里记录的 `sendId`）。任一不满足就地 `blocked`，
  **在打开浏览器之前**拒绝：`public_missing` / `public_not_found` / `public_not_a_reply` /
  `public_pending` / `public_unknown` / `public_failed` / `public_blocked` /
  `public_send_mismatch`。
  只按批次候选清单放行会留下绕过路径（调用方不带 `publicSendId` 直接要私信），
  所以绑定检查必须落在**每个 item** 上；`_live_batch_items` 也不再丢弃该字段。
  回归：`LivePrivateBindingTests`（缺 sendId / 未确认 / 张冠李戴 / 正确绑定四条路径）。

### 采集数据源与「回复弹幕」（2026-09-20 真机）

* **采集优先读页面内存**：弹幕虚拟列表组件的 React fiber props 里有 originalList（消息数组），
  每条 WebcastChatMessage 的 payload.user 带 `sec_uid` / nickname —— 真机实测 42/42 带标识。
  DOM 文本采集保留为兜底，但**行内没有用户标识**（真机 0%），此时 `authorId` 一律留空，
  绝不拿昵称冒充标识。`live_listen` 的响应如实回报 `source` 与 `identityCoverage`。
* **回复弹幕**：真机确认网页端没有「点某条弹幕 → 回复」的原生入口（全页 hover 扫描恒为 0；
  点击弹幕不进入回复态；输入框 `@` 也没有提及联想）。因此「回复弹幕」= 公屏发一条以
  `@昵称` 开头的消息，边界规则：
  1. `live_plan` 新增 `replyMode`（`composer` 默认 / `danmaku`），在**冻结计划时定稿**；
     之后 `live_reply` 传别的 mode 会被 `mode_mismatch` 拒绝 —— 同一批次里不允许两种触达方式；
  2. `danmaku` 模式下，**计划期**就要求每个目标有昵称（否则 `missing_author_name`）且话术自带
     `@昵称` 前缀（否则 `mention_prefix_missing`）：话术仍归平台侧，本模块不代写、不改写；
  3. 发出前必须先在屏上**定位到那条弹幕**（唯一命中 + 未被面板遮挡），否则以
     `danmaku_not_found` / `danmaku_ambiguous` / `danmaku_covered` 拒绝，且不产生任何输入；
  4. 输入框内容与话术完全一致后才发送；用的是按钮还是回车记录在结果的 `mechanism` 里。
* **拟人输入**：`type_text` 默认逐字真人节奏（每字 **0.1–0.9 秒**随机，标点后略长），
  不再使用固定 60ms 节拍；显式传 `per_char_delay` 时保留固定节拍（离线回归与兼容旧调用）。
  输入仍走 `Input.dispatchKeyEvent(type=char)`（真机验证过：`insertText` 对受控富文本编辑器无效）。
* 未验证边界（fail-closed）：`@昵称` 的送达证据（对方是否收到提醒）、发送机制是按钮还是回车、
  以及弹幕定位在虚拟列表滚动中的稳定性，都需要真机确认；`autoEligible` 保持 `false`。

## Review fixes (PR #7 revision)

Three state-machine defects reported in review are fixed, each with a
regression test in `LiveFlowTests`:

1. An empty queue no longer leaves a reusable batch behind. `live_plan` on an
   empty queue returns `status: "empty"` with `batchId: null`, and an open batch
   that holds no planned event is closed as `expired` instead of being reused
   (`test_empty_batch_is_closed_instead_of_reused`).
2. A batch that ran past `expiresAt` is closed as `expired`, its still-planned
   events are expired with it, and it is never handed back or sent. `live_reply`
   and `live_private` call `LiveQueue.ensure_active` before touching the browser
   and fail with `batch_expired`
   (`test_open_batch_is_closed_once_its_window_passed`,
   `test_phase_methods_refuse_an_expired_batch`,
   `test_sidecar_refuses_an_expired_batch_without_touching_the_browser`).
   Expiry is absolute, a frozen batch included: `live_plan` freezes in the same
   call that takes the batch, so "frozen" is not evidence of freshness.
3. `mark_private` now updates the row by the resolved `event_key`. It previously
   selected the right row and then wrote with the caller-facing event id, so the
   private result was reported as saved while the row stayed empty
   (`test_private_result_is_persisted`).

Two follow-ups reported by the reviewer and fixed here:

* Retiring a batch now reports what it dropped. The events expired because the
  batch left its window are counted in the same `expiredCount` / `expired` list
  as the time-window expiries, each carrying `expiredReason`
  (`test_retired_batch_events_are_counted_in_the_response`); `ensure_active`
  also reports the number in its `batch_expired` message.
* Retiring a batch only expires events that were still `planned`. An event that
  already recorded a result is a ledger fact and survives the batch being closed
  (`test_expiry_never_rewrites_a_recorded_send_result`), so a late window check
  cannot erase a send that really happened.

Policy is refused at the boundary until the authorization service signs it:
`live_plan` rejects a caller-supplied `policy` with
`policy_not_server_issued` and the frozen plan records
`policySource: "builtin_default"` (`test_client_supplied_policy_is_refused`).
The library-level seam (`LiveQueue.freeze_plan(policy=...)`) stays in place for
the server wiring.

Still open and deliberately not claimed as done: server-issued policy,
credits / feature-switch / audit integration (the local `send_gate.py` remains
the only local authority), and real-platform acceptance for live selectors,
author identity, public reply delivery and private delivery.
