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

## Review fixes (PR #7 revision)

Three state-machine defects reported in review are fixed, each with a
regression test in `LiveFlowTests`:

1. An empty queue no longer leaves a reusable batch behind. `live_plan` on an
   empty queue returns `status: "empty"` with `batchId: null`; a later
   listening round therefore gets a fresh batch instead of inheriting the empty
   one (`test_empty_batch_is_closed_instead_of_reused`).
2. An open batch that ran past `expiresAt` is closed as `expired`, its events
   are marked `expired`, and it is never handed back or sent. `live_reply` and
   `live_private` call `ensure_active` before touching the browser and fail
   with `batch_expired` (`test_open_batch_is_closed_once_its_window_passed`,
   `test_phase_methods_refuse_an_expired_batch`).
3. `mark_private` now updates the row by the resolved `event_key`. It previously
   selected the right row and then wrote with the caller-facing event id, so the
   private result was reported as saved while the row stayed empty
   (`test_private_result_is_persisted`).

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


