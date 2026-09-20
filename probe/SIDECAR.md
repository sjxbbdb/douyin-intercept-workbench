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
