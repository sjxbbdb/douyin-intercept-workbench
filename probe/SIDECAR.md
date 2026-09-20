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
automation gate. `private_reply` records the collaborator account flow
evidence from PR #1 but still reports delivery as `unknown` unless a response
is bound to that click. Video and live replies are fixture validated and
remain `autoEligible: false` until platform validation.

The send result is deliberately one of `unknown`, `failed`, or `blocked`.
Once a click is started, a process cancellation leaves the SQLite record
unresolved and a later request for the same target is blocked. DOM changes do
not become a success claim. Live capture and public reply are implemented
against visible DOM selectors and offline fixtures; real-platform selector and
delivery validation remains pending.

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
| `live_private` | phase two: private message per derived candidate | only when something is sendable |
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
