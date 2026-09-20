# Python sidecar

`sidecar.py` handles exactly one UTF-8 JSON request line and then exits. Its
stdout contains only one progress object and one final object; diagnostics go
to stderr. The trusted host starts it with absolute, account-specific paths:

```text
python sidecar.py --state-dir C:\AgentData\account-a\state --profile-dir C:\AgentData\account-a\profile --port 19222
```

The supported methods are `capabilities`, `launch`, `doctor`, `open`,
`search`, `collect_comments`, `collect_live`, `send_private`,
`send_comment`, and owned-browser `close`. `v.douyin.com` query strings are
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
