"""Live-room batch pipeline (architecture: images/12-live-room-business).

This module owns the collaborator side of the live flow defined by
images/18-platform-collaborator-boundary and keeps the two boundaries of
images/09-knowledge-talk-preparation and images/17-action-ledger-idempotency
intact:

* Deduplicated, capacity-capped event queue.  Listening produces events; the
  same event (same room, author and text) is stored once, and the queue keeps
  at most 'capacity' queued events by dropping the oldest beyond that.
* Time-windowed batches.  A batch is taken by count, and every event older than
  the window is marked 'expired' and is never replayed later.
* Scripts come from the platform.  The trusted host supplies both channels per
  target - the public reply text and the private message text.  This module
  never writes, rewrites or repairs a script; a missing or out-of-bounds script
  moves that target to 'blocked' so the flow stops for human handling.
* Phase two follows phase one.  Only targets whose public reply reached a state
  listed in policy['allowPublicStates'] become private candidates.  The default
  list contains 'sent_confirmed' only, so an unresolved public reply never turns
  into a private message.
* Idempotency keys stay with the caller.  Every send keeps the host-supplied
  sendId; the durable reservation itself lives in send_gate.py.

State is stored per account scope next to the send gate so a restart resumes
instead of replaying.  Everything here works without a browser, which keeps the
queue, the batch window and the plan validation testable offline.
"""
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

import crawl as crawlmod

QUEUED = "queued"
FILTERED = "filtered"
PLANNED = "planned"
EXPIRED = "expired"
BLOCKED = "blocked"
FAILED = "failed"
UNKNOWN = "unknown"
SENT_CONFIRMED = "sent_confirmed"

# Conservative on purpose: an unresolved public reply must not produce a
# private message unless the platform explicitly allows that state.
POLICY_DEFAULTS = {
    "allowPublicStates": [SENT_CONFIRMED],
    "maxPrivate": 20,
    "minTextLength": 2,
    "maxTextLength": 500,
}

CAPACITY_DEFAULT = 500
WINDOW_DEFAULT = 900
MAX_BATCH = 50


class LiveFlowError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


def _iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def event_key(event):
    """Stable identity of one live event: room + author + text.

    The fingerprint produced by sidecar._event is reused when present so a
    redelivered event is recognised even if the platform hands out a new
    transient DOM id.
    """
    fingerprint = str(event.get("fingerprint") or "").strip()
    if fingerprint:
        return fingerprint
    raw = "\x1f".join(str(event.get(field) or "") for field in
                      ("source", "roomId", "authorId", "authorName", "text"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def normalize_policy(value):
    policy = dict(POLICY_DEFAULTS)
    if value:
        if not isinstance(value, dict):
            raise LiveFlowError("invalid_input", "policy must be an object")
        for key, item in value.items():
            if key == "allowPublicStates":
                policy[key] = [str(s) for s in item] if isinstance(item, (list, tuple)) else []
            elif key == "maxPrivate":
                policy[key] = max(0, int(item))
            elif key in ("minTextLength", "maxTextLength"):
                policy[key] = max(0, int(item))
    return policy


def normalize_filter(keywords=None, exclude_keywords=None, mode="seg"):
    """Keyword spec for one batch (same four modes as the video comment path).

    Reusing crawl's matcher keeps one matching semantics across both chains:
    phrase / seg / all / any, with exclude keywords taking precedence.
    """
    if mode not in crawlmod.MATCH_MODES:
        raise LiveFlowError("invalid_input",
                            "matchMode must be one of %s" % ", ".join(crawlmod.MATCH_MODES))
    return {
        "keywords": crawlmod.split_keywords(keywords) if not isinstance(keywords, (list, tuple))
                    else [str(item).strip() for item in keywords if str(item).strip()],
        "excludeKeywords": crawlmod.split_keywords(exclude_keywords)
                           if not isinstance(exclude_keywords, (list, tuple))
                           else [str(item).strip() for item in exclude_keywords if str(item).strip()],
        "mode": mode,
    }


def filter_is_active(spec):
    return bool(spec and (spec.get("keywords") or spec.get("excludeKeywords")))


def match_event(text, spec):
    """Return (matched, reason): reason is '', 'keyword_miss' or 'keyword_excluded'."""
    source = crawlmod.normalize_search_text(text)
    hit = crawlmod.comment_matches(text, spec["keywords"], spec["mode"])
    if hit is None:
        return False, "keyword_miss"
    for word in spec.get("excludeKeywords") or []:
        if crawlmod.normalize_search_text(word) and crawlmod.normalize_search_text(word) in source:
            return False, "keyword_excluded"
    return True, ""


def _script_error(text, policy, label):
    if not isinstance(text, str) or not text.strip():
        return label + "_missing"
    stripped = text.strip()
    if len(stripped) < policy["minTextLength"]:
        return label + "_too_short"
    if len(stripped) > policy["maxTextLength"]:
        return label + "_too_long"
    return ""


class LiveQueue:
    """SQLite-backed live event queue, batch window and frozen plans."""

    def __init__(self, state_dir, account_scope, capacity=CAPACITY_DEFAULT, clock=None):
        self.state_dir = os.path.abspath(os.fspath(state_dir))
        os.makedirs(self.state_dir, exist_ok=True)
        self.account_scope = str(account_scope)
        self.capacity = max(1, int(capacity))
        self.clock = clock or time.time
        self.path = os.path.join(self.state_dir, "live_flow.sqlite3")
        self._init_db()

    # ----------------------------------------------------------------- sqlite

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    @contextmanager
    def _connection(self):
        """Open, use and always close one connection.

        sqlite3's own connection context manager only commits or rolls back; it
        does not close, which keeps the WAL file locked on Windows.
        """
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        schema = """
            CREATE TABLE IF NOT EXISTS live_events (
                account_scope TEXT NOT NULL,
                event_key TEXT NOT NULL,
                event_id TEXT NOT NULL DEFAULT '',
                batch_id TEXT,
                state TEXT NOT NULL,
                room_id TEXT NOT NULL DEFAULT '',
                author_id TEXT NOT NULL DEFAULT '',
                author_name TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                detail_json TEXT NOT NULL DEFAULT '{}',
                private_json TEXT NOT NULL DEFAULT '{}',
                seen_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (account_scope, event_key)
            );
            CREATE INDEX IF NOT EXISTS live_events_state_idx
                ON live_events(account_scope, state, seen_at);
            CREATE TABLE IF NOT EXISTS live_batches (
                account_scope TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                plan_json TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (account_scope, batch_id)
            );
        """
        for attempt in range(5):
            try:
                with self._connection() as conn:
                    conn.executescript(schema)
                return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))

    @staticmethod
    def _row(row):
        return dict(row) if row is not None else None

    def _set_state(self, conn, event_key_value, state, detail=None, batch_id=None, now=None):
        conn.execute(
            "UPDATE live_events SET state=?, batch_id=COALESCE(?, batch_id), detail_json=?, "
            "updated_at=? WHERE account_scope=? AND event_key=?",
            (str(state), batch_id, json.dumps(detail or {}, ensure_ascii=False),
             float(now if now is not None else self.clock()),
             self.account_scope, str(event_key_value)))

    # ------------------------------------------------------------------ queue

    def append(self, events, now=None):
        """Store deduplicated events and trim the queue to 'capacity'."""
        now = float(now if now is not None else self.clock())
        added = duplicates = 0
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for event in events or []:
                    if not isinstance(event, dict):
                        continue
                    key = event_key(event)
                    payload = json.dumps(event, ensure_ascii=False)
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO live_events"
                        "(account_scope,event_key,event_id,state,room_id,author_id,author_name,text,"
                        " payload_json,seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (self.account_scope, key, str(event.get("id") or ""), QUEUED,
                         str(event.get("roomId") or ""),
                         str(event.get("authorId") or ""), str(event.get("authorName") or "")[:120],
                         str(event.get("text") or "")[:1000], payload, now, now))
                    if cur.rowcount:
                        added += 1
                    else:
                        duplicates += 1
                dropped = self._trim(conn, now)
                queued = conn.execute(
                    "SELECT COUNT(*) AS n FROM live_events WHERE account_scope=? AND state=?",
                    (self.account_scope, QUEUED)).fetchone()["n"]
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return {"added": added, "duplicates": duplicates, "dropped": dropped,
                "queued": int(queued), "capacity": self.capacity}

    def _trim(self, conn, now):
        excess = conn.execute(
            "SELECT COUNT(*) AS n FROM live_events WHERE account_scope=? AND state=?",
            (self.account_scope, QUEUED)).fetchone()["n"] - self.capacity
        if excess <= 0:
            return 0
        stale = conn.execute(
            "SELECT event_key FROM live_events WHERE account_scope=? AND state=? "
            "ORDER BY seen_at ASC LIMIT ?", (self.account_scope, QUEUED, excess)).fetchall()
        for row in stale:
            self._set_state(conn, row["event_key"], EXPIRED,
                            {"reason": "queue_capacity_exceeded"}, now=now)
        return len(stale)

    def take_batch(self, max_items=MAX_BATCH, window_seconds=WINDOW_DEFAULT, now=None,
                   filters=None):
        """Take a count-bounded batch inside a time window.

        Events older than the window are marked 'expired' first and can never be
        replayed by a later batch.  An open (planned, not yet frozen) batch is
        returned as-is so a host retry cannot create two batches at once.
        """
        now = float(now if now is not None else self.clock())
        max_items = max(1, min(int(max_items), MAX_BATCH))
        window_seconds = max(1, int(window_seconds))
        spec = filters if isinstance(filters, dict) else None
        filter_stats = {"keywords": list((spec or {}).get("keywords") or []),
                        "excludeKeywords": list((spec or {}).get("excludeKeywords") or []),
                        "mode": (spec or {}).get("mode") or "",
                        "matched": 0, "missed": 0, "excluded": 0}
        expired = []
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                expired_rows = conn.execute(
                    "SELECT event_key, payload_json FROM live_events "
                    "WHERE account_scope=? AND state=? AND seen_at <= ? ORDER BY seen_at ASC",
                    (self.account_scope, QUEUED, now - window_seconds)).fetchall()
                for row in expired_rows:
                    self._set_state(conn, row["event_key"], EXPIRED,
                                    {"reason": "window_expired"}, now=now)
                expired = [json.loads(row["payload_json"] or "{}") for row in expired_rows]

                # 关键词匹配发生在成批之前：不命中的事件标 filtered，不再占用批次名额
                if filter_is_active(spec):
                    pending = conn.execute(
                        "SELECT event_key, payload_json FROM live_events "
                        "WHERE account_scope=? AND state=? ORDER BY seen_at ASC",
                        (self.account_scope, QUEUED)).fetchall()
                    for row in pending:
                        event = json.loads(row["payload_json"] or "{}")
                        matched, reason = match_event(event.get("text") or "", spec)
                        if matched:
                            filter_stats["matched"] += 1
                            continue
                        filter_stats["excluded" if reason == "keyword_excluded" else "missed"] += 1
                        self._set_state(conn, row["event_key"], FILTERED, {"reason": reason}, now=now)

                batch_id = None
                open_batch = conn.execute(
                    "SELECT * FROM live_batches WHERE account_scope=? AND status=? "
                    "ORDER BY created_at DESC LIMIT 1",
                    (self.account_scope, "planned")).fetchone()
                if open_batch is not None:
                    planned = conn.execute(
                        "SELECT COUNT(*) AS n FROM live_events WHERE account_scope=? "
                        "AND batch_id=? AND state=?",
                        (self.account_scope, open_batch["batch_id"], PLANNED)).fetchone()["n"]
                    if planned and now <= open_batch["expires_at"]:
                        batch_id = open_batch["batch_id"]
                    else:
                        # 空批次或已超窗的批次一律关闭：否则空批次会被永久复用，
                        # 超窗批次还能继续发送，两者都违反时间窗规则。
                        reason = "batch_window_expired" if planned else "batch_left_empty"
                        for event in self._close_batch(conn, open_batch["batch_id"], reason, now):
                            # 因批次退休而作废的事件【也要计入本轮的 expiredCount】：
                            # 否则宿主只看到 expiredCount=0，无法对账"这次到底丢了多少"。
                            event["expiredReason"] = reason
                            expired.append(event)
                if batch_id is None:
                    rows = conn.execute(
                        "SELECT event_key FROM live_events "
                        "WHERE account_scope=? AND state=? ORDER BY seen_at ASC LIMIT ?",
                        (self.account_scope, QUEUED, max_items)).fetchall()
                    if rows:
                        batch_id = uuid.uuid4().hex[:32]
                        conn.execute(
                            "INSERT INTO live_batches(account_scope,batch_id,status,created_at,expires_at) "
                            "VALUES(?,?,?,?,?)",
                            (self.account_scope, batch_id, "planned", now, now + window_seconds))
                        for row in rows:
                            self._set_state(conn, row["event_key"], PLANNED, {}, batch_id, now)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        batch = self.batch(batch_id) if batch_id else None
        events = self.batch_events(batch_id) if batch_id else []
        return {
            "status": "ok" if events else "empty",
            "batchId": batch_id,
            "createdAt": _iso(batch["created_at"]) if batch else None,
            "expiresAt": _iso(batch["expires_at"]) if batch else None,
            "frozen": bool(batch and batch["status"] == "frozen"),
            "expiredCount": len(expired),
            "expired": expired[:50],
            "filter": filter_stats,
            "events": events,
        }

    def _close_batch(self, conn, batch_id, reason, now):
        """Close a batch and expire the events it never got to send.

        Only events still in the 'planned' state are expired: an event that
        already recorded a result (sent_confirmed / unknown / failed / blocked)
        is a ledger fact and must survive the batch being retired, otherwise a
        late window check would silently erase what was actually sent.

        Returns the payloads it expired, so the caller can report how much this
        round dropped instead of leaving the host with an unexplained count.
        """
        conn.execute("UPDATE live_batches SET status=? WHERE account_scope=? AND batch_id=?",
                     ("expired", self.account_scope, str(batch_id)))
        dropped = []
        rows = conn.execute(
            "SELECT event_key, payload_json FROM live_events WHERE account_scope=? "
            "AND batch_id=? AND state=? ORDER BY seen_at ASC",
            (self.account_scope, str(batch_id), PLANNED)).fetchall()
        for row in rows:
            self._set_state(conn, row["event_key"], EXPIRED, {"reason": reason}, now=now)
            dropped.append(json.loads(row["payload_json"] or "{}"))
        return dropped

    def ensure_active(self, batch_id, now=None):
        """Fail closed when a batch may no longer be executed.

        The phase methods call this before touching the browser, so a batch that
        ran out of its window can never be sent after the fact.
        """
        now = float(now if now is not None else self.clock())
        batch = self.batch(batch_id)
        if batch is None:
            raise LiveFlowError("unknown_batch", "batch does not exist")
        if batch["status"] == "expired" or now > batch["expires_at"]:
            with self._connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    dropped = self._close_batch(conn, batch_id, "batch_window_expired", now)
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
            # 报出被作废的数量：宿主需要知道"这次丢了多少"，而不是只拿到一句拒绝。
            raise LiveFlowError("batch_expired",
                                "batch time window has passed; %d event(s) were expired, "
                                "not replayed" % len(dropped))
        return batch

    def batch(self, batch_id):
        if not batch_id:
            return None
        with self._connection() as conn:
            return self._row(conn.execute(
                "SELECT * FROM live_batches WHERE account_scope=? AND batch_id=?",
                (self.account_scope, str(batch_id))).fetchone())

    def batch_events(self, batch_id):
        if not batch_id:
            return []
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM live_events WHERE account_scope=? AND batch_id=? "
                "ORDER BY seen_at ASC", (self.account_scope, str(batch_id))).fetchall()
        out = []
        for row in rows:
            event = json.loads(row["payload_json"] or "{}")
            event["state"] = row["state"]
            event["detail"] = json.loads(row["detail_json"] or "{}")
            event["private"] = json.loads(row["private_json"] or "{}")
            out.append(event)
        return out

    def mark(self, event_id, state, batch_id=None, detail=None):
        """Record one per-target result for the batch."""
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT event_key FROM live_events WHERE account_scope=? "
                    "AND (event_id=? OR event_key=?)",
                    (self.account_scope, str(event_id), str(event_id))).fetchone()
                if row is None:
                    conn.rollback()
                    raise LiveFlowError("unknown_event", "event is not in the queue")
                self._set_state(conn, row["event_key"], state, detail, batch_id)
                conn.commit()
            except LiveFlowError:
                raise
            except Exception:
                conn.rollback()
                raise
        return {"eventId": str(event_id), "state": str(state), "detail": detail or {}}

    def mark_private(self, event_id, status, batch_id=None, detail=None):
        """Record the phase-two result without touching the phase-one state.

        Phase one decides whether a target may be private-messaged at all, so
        overwriting its state here would silently change that decision.
        """
        payload = dict(detail or {})
        payload["status"] = str(status)
        payload["at"] = _iso(self.clock())
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT event_key FROM live_events WHERE account_scope=? "
                    "AND (event_id=? OR event_key=?)",
                    (self.account_scope, str(event_id), str(event_id))).fetchone()
                if row is None:
                    conn.rollback()
                    raise LiveFlowError("unknown_event", "event is not in the queue")
                conn.execute(
                    "UPDATE live_events SET private_json=?, updated_at=? "
                    "WHERE account_scope=? AND event_key=?",
                    (json.dumps(payload, ensure_ascii=False), float(self.clock()),
                     self.account_scope, row["event_key"]))
                conn.commit()
            except LiveFlowError:
                raise
            except Exception:
                conn.rollback()
                raise
        return {"eventId": str(event_id), "status": str(status)}

    def find_event(self, event_id):
        """Look one event up by the host-facing id or by its queue fingerprint.

        Parsed 'detail' / 'private' / 'payload' are included so callers do not
        have to decode the stored JSON themselves.
        """
        with self._connection() as conn:
            row = self._row(conn.execute(
                "SELECT * FROM live_events WHERE account_scope=? AND (event_id=? OR event_key=?)",
                (self.account_scope, str(event_id), str(event_id))).fetchone())
        if row is None:
            return None
        row["detail"] = json.loads(row.get("detail_json") or "{}")
        row["private"] = json.loads(row.get("private_json") or "{}")
        row["payload"] = json.loads(row.get("payload_json") or "{}")
        return row

    # ------------------------------------------------------------------- plan

    def freeze_plan(self, batch_id, scripts, policy=None):
        """Freeze the two-channel plan for one batch.

        'scripts' maps an event id (or fingerprint) to an object carrying
        'publicText' and 'privateText'.  Both channels are required for a target
        to stay sendable; this module never fills them itself.
        """
        policy_source = "request" if policy else "builtin_default"
        policy = normalize_policy(policy)
        batch = self.batch(batch_id)
        if batch is None:
            raise LiveFlowError("unknown_batch", "batch does not exist")
        if batch["status"] == "frozen":
            return json.loads(batch["plan_json"] or "{}")
        if not isinstance(scripts, dict):
            raise LiveFlowError("invalid_input", "scripts must be an object")
        targets, blocked = [], []
        for event in self.batch_events(batch_id):
            entry = scripts.get(event.get("id")) or scripts.get(event.get("fingerprint"))
            reason = ""
            if not isinstance(entry, dict):
                reason = "script_missing"
            else:
                reason = (_script_error(entry.get("publicText"), policy, "public_text") or
                          _script_error(entry.get("privateText"), policy, "private_text"))
            if reason:
                blocked.append({"eventId": event.get("id"), "reason": reason})
                self.mark(event["id"], BLOCKED, batch_id, {"reason": reason})
                continue
            targets.append({
                "eventId": event.get("id"),
                "eventKey": event_key(event),
                "roomId": event.get("roomId") or "",
                "authorId": event.get("authorId") or "",
                "authorName": event.get("authorName") or "",
                "text": event.get("text") or "",
                "publicText": entry["publicText"],
                "privateText": entry["privateText"],
                "publicTextSha256": hashlib.sha256(
                    entry["publicText"].encode("utf-8")).hexdigest(),
            })
        plan = {"batchId": str(batch_id), "frozenAt": _iso(self.clock()), "policy": policy,
                "targets": targets, "blocked": blocked, "scriptSource": "host",
                "policySource": policy_source}
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "UPDATE live_batches SET status='frozen', plan_json=? "
                "WHERE account_scope=? AND batch_id=?",
                (json.dumps(plan, ensure_ascii=False), self.account_scope, str(batch_id)))
            conn.commit()
        return plan

    def plan(self, batch_id):
        batch = self.batch(batch_id)
        if batch is None:
            raise LiveFlowError("unknown_batch", "batch does not exist")
        return json.loads(batch["plan_json"] or "{}")

    def target(self, batch_id, event_id):
        for item in self.plan(batch_id).get("targets") or []:
            if item.get("eventId") == event_id or item.get("eventKey") == event_id:
                return item
        return None

    def states(self, batch_id):
        return {event.get("id"): event.get("state") for event in self.batch_events(batch_id)}

    def private_candidates(self, batch_id, policy=None):
        """Phase-two list derived from the recorded phase-one states.

        'unknown' public replies are rejected by default: the public click was
        started but its outcome is unresolved, and the architecture forbids
        turning that into a second, blind contact.
        """
        plan = self.plan(batch_id)
        policy = normalize_policy(policy or plan.get("policy"))
        states = self.states(batch_id)
        allowed, rejected = [], []
        for item in plan.get("targets") or []:
            state = states.get(item.get("eventId"))
            reason = ""
            if state == BLOCKED:
                reason = "public_blocked"
            elif state == FAILED:
                reason = "public_failed"
            elif state not in policy["allowPublicStates"]:
                reason = "public_%s" % (state or "pending")
            elif not str(item.get("authorId") or "").strip():
                reason = "missing_author_id"
            if reason:
                rejected.append({"eventId": item.get("eventId"), "reason": reason})
                continue
            allowed.append(item)
        over = allowed[policy["maxPrivate"]:]
        allowed = allowed[:policy["maxPrivate"]]
        for item in over:
            rejected.append({"eventId": item.get("eventId"), "reason": "over_private_capacity"})
        return allowed, rejected

    def result(self, batch_id):
        batch = self.batch(batch_id)
        if batch is None:
            raise LiveFlowError("unknown_batch", "batch does not exist")
        plan = self.plan(batch_id)
        events = self.batch_events(batch_id)
        counts = {}
        for event in events:
            state = str(event.get("state"))
            counts[state] = counts.get(state, 0) + 1
        pending = [e.get("id") for e in events if str(e.get("state")) == PLANNED]
        private_counts = {}
        for event in events:
            status = str((event.get("private") or {}).get("status") or "")
            if status:
                private_counts[status] = private_counts.get(status, 0) + 1
        allowed, rejected = self.private_candidates(batch_id)
        return {
            "batchId": str(batch_id),
            "status": batch["status"],
            "createdAt": _iso(batch["created_at"]),
            "expiresAt": _iso(batch["expires_at"]),
            "targets": len(plan.get("targets") or []),
            "counts": counts,
            "privateCounts": private_counts,
            "expiredCount": len([e for e in events if str(e.get("state")) == EXPIRED]),
            "privateCandidates": len(allowed),
            "privateRejected": rejected,
            "checkpoint": {
                "phase": "private" if not pending else "public",
                "frozenAt": plan.get("frozenAt"),
                "pendingEvents": pending,
                "planTargets": len(plan.get("targets") or []),
                "blockedBeforeSend": [b.get("eventId") for b in plan.get("blocked") or []],
            },
        }

    def stats(self):
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT state, COUNT(*) AS n FROM live_events WHERE account_scope=? "
                "GROUP BY state", (self.account_scope,)).fetchall()
            batches = conn.execute(
                "SELECT COUNT(*) AS n FROM live_batches WHERE account_scope=?",
                (self.account_scope,)).fetchone()["n"]
        return {"states": {row["state"]: int(row["n"]) for row in rows},
                "batches": int(batches), "capacity": self.capacity}
