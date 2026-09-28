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
boundary: a cursor issued for another keyword or account, an unsupported
version, or a pool beyond the cap is rejected with `invalid_input`. A cursor is
also bound to the **normalized search filters** it was issued for
(`dateFrom` / `dateTo` as epoch bounds, `minRelevance` as an integer):
continuing a search with different filters is refused with
`cursor_filter_mismatch` instead of silently mixing two filter sets into one
result. When the caller has an account scope, the cursor must **prove** it
belongs to that account (`a` present and equal): a cursor without the account
field is refused with `cursor_account_mismatch` rather than accepted.
Non-numeric page sizes or filter values are rejected with `invalid_input`;
they never surface as a bare `ValueError`. `hasMore` is false when a page
yields no new video, which is the host signal to stop paging.
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

The send result is deliberately one of `unknown`, `failed`, or `blocked`.
Once a click is started, a process cancellation leaves the SQLite record
unresolved and a later request for the same target is blocked. DOM changes do
not become a success claim. Live capture and public reply are implemented
against visible DOM selectors and offline fixtures; real-platform selector and
delivery validation remains pending.

For an onedir Windows bundle, run `build_sidecar.cmd` from this directory.
It creates an isolated `.pyinstaller-venv` and writes
`dist\probe-agent\probe-agent.exe`; PyInstaller is a build-only dependency.

## Comment batch flow (images/11-comment-area-business)

The video comment area had a **single-target** send path only: `collect_comments`
returned candidates and the host called `send_comment` / `send_private` once per
target. That is not enough to hold the fixed workflow
「关键词匹配评论 -> 公开回复 -> **只有 sent_confirmed 才允许私信**」, because the
two-phase rule cannot be enforced by host discipline. Four methods now mirror the
live batch flow on the comment side:

| method | phase | needs a browser |
|---|---|---|
| `comment_plan` | collect one video, filter comments, form and freeze one batch | yes (collection only) |
| `comment_reply` | phase one: public reply per accepted item | only when something is sendable |
| `comment_private` | phase two: private message, bound to the recorded public send | only when something is sendable |
| `comment_result` | batch report, counts and resume checkpoint | no |

Differences from the live flow, all deliberate:

* the input is a **video URL plus filter parameters** (`commentKeywords`,
  `excludeKeywords`, `matchMode`, `minDigg`, `dedupeAuthors`) - the comment area
  has no continuous listening, so one collection is one batch;
* the host supplies **one** script pair (`publicText` / `privateText`) and
  `comment_flow.build_scripts()` expands it over every target, while the live flow
  takes per-target scripts;
* a collection that yields no matching comment returns `status: "empty"` and
  **creates no batch**, so the host changes video or keywords instead of holding an
  empty plan;
* `captcha` / `login_required` / `unsupported` are passed through as terminal
  statuses: no batch is created against a page that cannot be worked with.

`comment_plan` is fail-closed before any browser action: a missing
`publicText` / `privateText`, an out-of-range `maxItems` / `windowSeconds`, and a
caller-supplied `policy` are all refused (`invalid_input` /
`policy_not_server_issued`). Batch state lives in `comment_flow.sqlite3` - a
separate database from `live_flow.sqlite3`, so live-room and comment-area state
never mix and per-account scoping stays unambiguous.

Phase two keeps the same derived-candidate rule as `live_private`: only targets
whose recorded phase-one state is in `policy.allowPublicStates`
(default `["sent_confirmed"]`) are sendable; `unknown` / `failed` / `blocked`
are refused with `public_unknown` / `public_failed` / `public_blocked`, a missing
commenter id with `missing_author_id`. In addition the private item may carry the
`publicSendId` it believes succeeded: it is compared with the send id recorded on
that event, and a mismatch is refused with `public_send_id_mismatch` instead of
sending - so a confirmed reply to one person can never be spent on another.

The response of `comment_plan` reports two different filters, and they are not
interchangeable: `filter` is the **collection-side** comment statistics
(keywords / exclusions / like threshold / author dedupe) and `batchFilter` is the
event-level statistics of the batch window.

Unverified boundary, unchanged from the live batch: the mechanism is offline
tested, but it drives `video_reply` and `private_reply`, both of which still lack
platform delivery evidence - so `comment_batch.autoEligible` is `false`.

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

* **私信面板里"挑输入框"和"判回显"都不许被搜索框骗（2026-09-28 真机反馈）**：私信面板左上是
  【搜索】框，和发消息输入框一样是可见 editable；面板里还有会话列表。
  * 挑输入框：`searchish()` 守卫（placeholder / 自身或祖先 class / data-e2e 含 search）已加进
    `dm_composer` / `dm_composer_for_recipient` / `dm_panel_state` / `dm_send_button_for_recipient`，
    保证"发消息的输入框"永远唯一命中 —— 否则文字会打进搜索框，消息根本没发出去；
  * 判回显：旧实现把会话 scopes 里最长的一段 innerText 拼起来做【子串】匹配，
    而 `[class*="imChat"]` 会命中输入框容器 `messageEditorimChatEditorContainer`
    （真机实测 `editorInsideConversationScope: true`）——"刚敲进输入框、还没发出去"的文字
    也会被判成会话回显（假证据）。现在只在会话区找【叶子节点、全文相等】的元素，
    并显式排除输入框与搜索框子树。
  真机验证：把标记词打进输入框（不发送）-> `dm_conversation_echo` 返回 `False`；
  会话里真的存在的那条 -> 返回 `True`。
  回归：`test_probe.ChromiumFixtureTests` 新增 2 个用例（夹具里补了搜索框与会话列表）。
* **服务端签发策略的「身份」冻结（2026-09-26 评审收尾）**：本侧**不接收策略内容**
  （`policy` 对象继续以 `policy_not_server_issued` 拒绝），但支持把策略**身份**冻结进计划：
  `policyId` + `policyVersion`（+ 可选 `knowledgeSetVersion`），
  或直接把计划回显的 `policyRef` 对象原样带回来。
  * 形状不对 -> `invalid_policy_ref`，且**在建批次之前**拒绝（不产生队列副作用）；
  * 冻结之后，执行阶段（`live_reply` / `live_private` / `comment_reply` / `comment_private`）
    必须把同一身份带回来：缺 -> `policy_ref_missing`，不一致 -> `policy_ref_mismatch`；
  * 完全不带身份时保持既有行为（授权端还没接线），这条是加法能力。
  授权端签发、策略存储与积分扣除都在平台侧，本侧只做身份冻结与一致性校验。
  回归：`test_policy_ref`（形状 4 个用例 + 直播 7 个 + 评论 4 个）。
* **发布回执结构化绑定（2026-09-26 评审收尾）**：评论公开回复的回执不再用「原始串包含」判定，
  而是先**解析请求体**（form URL 编码 / JSON / 值里再套一层 JSON / 转义中文），再按字段比对：
  ① **白名单 id 字段**（reply_id / reply_comment_id / comment_id / cid / commentid /
     replyid / reply_cid）**精确等于**目标评论 id（结论性依据，短正文与编码差异都影响不到它）；
  ② **白名单正文字段**（text / content / comment / reply_text / replytext / comment_text /
     content_text）等于或包含本次正文（平台可能在正文里插入 @昵称 之类的内容）。
  🔴 字段名必须**精确命中白名单**：video_id / aweme_id / item_id / user_id / content_type
     这类无关字段即使值碰巧相同也不参与绑定（2026-09-27 评审：子串匹配会误绑定）。
  状态码按**数字形态**收：整数、整数值的 float、数字字符串（"0"）都算，
  于是平台用字符串回 0 时同样落成确认成功；缺失 / null / bool / 非数字串仍是读不出。
  请求体拿不到或解析不出字段 -> `unknown/platform_response_unbound`；
  **归属不明**（多条回执都能绑定、且没有唯一的 id 绑定）-> `unknown/platform_response_ambiguous` ——
  宁可停在 unknown 交人工，也不挑一条「看起来成功」的回执当结论。
  🔴 请求体只在内存里用于这一次绑定：`detail` / `evidence` / 台账 / 日志里都不出现 `postData`。
  回归：`test_comment_publish_binding`（解析层 10 个用例 + 决策层 6 个用例）。
* **评论去重按身份优先级，绝不合并不同用户（2026-09-26 评审收尾）**：抓取期的键与
  `dedupe_comments` 都改成 **评论 ID -> (作者标识 + 正文) -> (昵称 + 正文) -> 各自保留**。
  原来按 `(sec_uid or "", 正文)` 分组：没有 `sec_uid` 的评论全部落进同一个【空身份】桶，
  两个不同用户发同一句话（「求带」）会被判成同一条并丢掉其中一条 —— 下游是按人去私信的，
  丢错人就是给错人发消息。昵称那一档只是为了认出「DOM 兜底重读的同一行」，
  什么身份都没有时**各自保留**：宁可多留一条，也不合并两个用户。
  🔴 **两个不同的非空评论 ID 永远是两条记录**（2026-09-27 评审）：身份兜底只允许把
     "没有评论 ID 的那一份"（接口副本 / DOM 副本）并进另一条，绝不允许把两个有 ID 的
     评论并成一条 —— 否则下游会少一条目标，处理账也对不上。
  回归：`test_comment_dedupe_identity`（11 个身份用例 + 4 个抓取键用例 + 3 个 DOM 兜底集成用例）。
* **游标绑定规范化后的筛选条件（2026-09-26 评审收尾）**：`cursor` 里新增 `f`，
  装的是**解析后**的 `dateFrom` / `dateTo`（epoch 秒）与 `minRelevance`。
  此前游标只绑定关键词与账号，于是宿主可以带着 `minRelevance=60` 采完第一页、
  第二页把条件改掉继续用同一个游标 —— 两页条件不同，却被当成「同一次搜索」，
  而「这批是按 6–9 月、相关度 60 以上采的」正是宿主决定给谁发消息的依据。
  条件一变就以 `cursor_filter_mismatch` 拒绝（**在打开浏览器之前**），
  让宿主重新发起一次搜索；**语义等价**的写法（`2026-06` 与 `2026-06-01`）解析后相同，
  不算变化。缺 `f`、`f` 不是对象、`f` 缺键，一律按不一致拒绝。
  协议版本随之升到 `cursorVersion: 2`：v1 游标里没有条件信息，无法判断它是怎么采的，
  继续接受等于把这条缺陷留在协议里，所以直接拒绝（`invalid_input`），
  宿主重新从第一页开始即可 —— 游标是不透明的临时状态，不是持久资产。
  响应 `filter` 新增 `cursorFilters`，把这组规范化条件回显给宿主对账。
  🔴 两处收紧（2026-09-27 评审）：
    · 带账号作用域时游标必须**证明**自己属于该账号 —— 缺 `a` 与 `a` 不符一样以
      `cursor_account_mismatch` 拒绝（原来 `payload.get("a") and ...` 会在缺字段时直接放行，
      于是不带账号信息的游标可以被任何账号拿去当已见集合）；
    · 参数与游标里的筛选值一律走**严格整数解析**：非数字给 `invalid_input`（请求参数）
      或 `cursor_filter_mismatch`（游标里的 `f`），绝不冒裸 `ValueError`，
      也不把非数字静默当成 0（那会让"条件变了"被判成"条件没变"）。
  回归：`test_search_cursor_filters.CursorFilterBindingTests` 与
  `SearchPaginationFilterTests`。
* **搜索池持久化发布时间（2026-09-26 评审收尾）**：`search_videos` 新增 `create_time` 与
  `published_at`，`search_pool` 返回的每条候选都带 `createTime` / `publishedAt`
  （取不到就是 `null`，**不拿采集时刻冒充发布日期**）。此前池子只存链接与相关度，
  宿主重启后「这个视频什么时候发的」就丢了 —— 而发布时间恰恰是「按 6–9 月筛」的依据。
  老库由 `SearchPool._migrate` **原地补列**（`ALTER TABLE`），已有的历史行留 NULL，
  由 `stats.unknownDate` 计数；重新采集时用 `COALESCE` 保留已知值
  （新一页没拿到发布时间，不该把已经知道的值擦掉）。
  `videoId -> 评论区` 的正式交接（`SearchPool.get`）语义不变。
  回归：`test_search_pool_persistence.SearchPoolPersistenceTests`。
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
  `allowed` / `rejected`；`send_private` **必须**带 `publicSendId` 且该公屏回复是
  `sent_confirmed`，否则在**打开浏览器之前**以稳定原因拒绝：
  `public_missing` / `public_not_found` / `public_not_a_reply` / `public_pending` /
  `public_unknown` / `public_failed` / `public_blocked` / `missing_author_id`。
  ⚠️ `send_gate.result()` 会把 `sent_confirmed` 映射成 `unknown`（避免过度宣称），
  所以契约判定读的是 **`SendGate.lookup()` 返回的原始状态**。
  🔴 **`publicSendId` 是必填，不是可选**。它曾经写成「可选：给出时校验」，
  那等于没有守卫 —— 任何调用方省略这个参数就绕过了整条契约，
  而偏偏执行发送的就是这条单发路径。批量入口一直强制 `public_missing`，
  两个入口口径不一致时，实际生效的是最弱的那条。现在两者一致。
  ⚠️ **对宿主是破坏性变更**：`desktop/src/lib/probe-client.js` 的 `send_private`
  目前不透传 `publicSendId`，不同步修改的话该调用会开始以 `public_missing` 失败。
  这是有意的 —— 那条路径本来就应该先拿到公屏回复的 `sendId`。
  回归：`CommentFlowContractTests`（含改前会失败的 `test_missing_public_send_id_is_refused`）。
* **直播私信逐项绑定公屏成功（审核意见 2026-09-21）**：`live_private` 的每个 item 必须带
  `publicSendId`，且该 sendId 必须满足两条：①在台账里是"已确认成功的公屏回复"；
  ②就是这个事件自己那次回复（事件详情里记录的 `sendId`）。任一不满足就地 `blocked`，
  **在打开浏览器之前**拒绝：`public_missing` / `public_not_found` / `public_not_a_reply` /
  `public_pending` / `public_unknown` / `public_failed` / `public_blocked` /
  `public_send_mismatch`。
  只按批次候选清单放行会留下绕过路径（调用方不带 `publicSendId` 直接要私信），
  所以绑定检查必须落在**每个 item** 上；`_live_batch_items` 也不再丢弃该字段。
  回归：`LivePrivateBindingTests`（缺 sendId / 未确认 / 张冠李戴 / 缺队列绑定 / 正确绑定五条路径）。
  🔴 **事件自身必须存在绑定记录**（2026-09-26 收紧）：原来是
  `if recorded and recorded != public_send_id` —— 事件上没有记录时直接放行，
  等于说「任何一条已确认的公屏回复都能拿给一个从未公屏回复过的事件去发私信」。
  现在要求 **记录的 sendId 精确等于传入的 publicSendId**：缺记录与记录对不上
  同样以 `public_send_mismatch` 拒绝（两者都无法证明这次私信绑定的是本事件那次成功）。
  回归补充：`test_an_event_without_a_recorded_send_id_is_refused`、
  `test_a_record_without_the_send_id_key_is_refused_too`。
* **直播监听的恢复语义（2026-09-26 评审收尾）**：监听是持续动作，宿主会重启、会换房间、
  平台会重发旧事件、批次会超窗。这些情况下：
  ① 队列与未冻结的批次都还在，`take_batch` **复用同一个 batchId**（不会凭空多出批次）；
  ② 平台重发同一条事件只计 `duplicates`，不会变成新事件；
  ③ 已经出过结果的事件（`sent_confirmed` / `unknown` / `failed` / `blocked`）
  **不会回到队列**，也不会被后来的批次再发一次；
  ④ `unknown` 的公屏结果永远不进私信候选（红线：未知不得自动重试）；
  ⑤ 每个目标各自绑自己的房间：换房间不会把旧房间的事件当成新房间的，
  同一个人在另一个房间说同一句话也不算同一条事件；
  ⑥ 超窗批次在 `ensure_active` 处以 `batch_expired` 拒绝，计划中的事件一并作废、不重发；
  ⑦ checkpoint（`phase` / `pendingEvents` / `frozenAt` / `planTargets`）重启后照常可读。
  回归：`test_live_recovery`（8 个队列用例 + 1 个 sidecar 入口用例，全部离线）。

* **分页记录：页面版本与分页终止态（2026-09-21，评审要求固化）**：`search` 的每次响应都带
  * `cursorVersion`：产出该 `cursor` 的**协议版本**（当前 `2`；v2 起游标同时绑定筛选条件）。宿主重启后据此判断手里的游标
    是不是自己能解析的那一版；不是就重新从第一页开始，而不是拿着解析不了的游标继续请求。
  * `pageOutcome`：**分页终止态**，取值固定为

    | 取值 | 含义 | 宿主该做什么 |
    |---|---|---|
    | `more` | 本页有结果、游标可用 | 可以继续申请下一页 |
    | `exhausted` | 本页没有新视频（池子到头） | 停止翻页 |
    | `captcha` | 命中验证码 | **停止**，人工处理后再继续（`cursor=null`、`hasMore=false`） |
    | `login_required` | 登录失效 | **停止**，人工登录（同样不给游标） |

  ⚠️ `pageOutcome` 与 `platformHasMore` **不是一回事**：前者说的是"我们这边还翻不翻"，
  后者是平台响应体的观测值（"平台那边还有没有"）。混用会让宿主在平台明明还有结果时提前收工，
  或者反过来对着验证码继续翻。
  ⚠️ **桌面端当前没有完整透传这两个字段**（`desktop/` 侧只取 `videos` / `cursor` / `hasMore`）；
  透传由平台侧补齐，本侧只保证字段名与取值稳定。
  回归：`SearchPagingRelevanceTests.test_page_record_carries_version_and_paging_outcome`、
  `test_paging_outcome_is_not_confused_with_the_platform_signal`。
* **两个 mismatch 枚举不要混用（同义不同名，刻意的）**：公屏回复与私信的绑定校验在两条通道上
  各有自己的枚举 ——
  * 评论区：`public_send_id_mismatch`（`comment_private`）；
  * 直播间：`public_send_mismatch`（`live_private`）。

  两者含义相同（拿别人那次的公屏成功来给这个事件发私信），但**名字不同是有意的**：
  宿主只看枚举就能知道是哪条通道拒的。写文档、写测试、写桌面端映射时都必须用**准确的那个**，
  不要把两个名字相互替换。
  回归：`CommentBatchFlowTests.test_private_refuses_a_public_send_id_that_belongs_to_another_target`、
  `LivePrivateBindingTests`。

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
