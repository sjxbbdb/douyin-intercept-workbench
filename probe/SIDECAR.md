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

`live_listen` deduplicates by room plus author plus text and trims the queue to
its capacity, so the host may call it repeatedly. `live_plan` takes a
count-bounded batch inside `windowSeconds`; anything older is marked `expired`
and is never replayed by a later batch (the platform rule 过期处理，不集中补发).
An open batch is reused on retry, so a repeated request cannot create two
batches at once.

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
