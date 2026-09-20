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
automation gate. `private_reply` records the collaborator account flow
evidence from PR #1 but still reports delivery as `unknown` unless a response
is bound to that click. Video and live replies are fixture validated and
remain `autoEligible: false` until platform validation.

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
