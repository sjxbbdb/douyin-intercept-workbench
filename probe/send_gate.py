"""Durable, account-scoped send reservation and conservative local quotas.

The gate is deliberately independent from the browser.  A reservation is
written before any click is made, and a non-terminal reservation is never
silently retried.  SQLite's IMMEDIATE transaction is the cross-process lock.
"""
import hashlib
import json
import os
import sqlite3
import time
from contextlib import contextmanager


TERMINAL = {"failed", "blocked", "unknown", "sent_confirmed"}
ACTIVE = {"reserved", "started"}


class GateError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def text_digest(text):
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


class SendGate:
    """SQLite-backed send gate.

    ``limits`` is intentionally local policy.  It is not presented as an
    official platform quota and can be changed by the trusted caller.
    """

    def __init__(self, state_dir, account_scope, limits=None, clock=None):
        self.state_dir = os.path.abspath(os.fspath(state_dir))
        os.makedirs(self.state_dir, exist_ok=True)
        self.account_scope = str(account_scope)
        self.limits = {
            "per_user": 1,
            "hourly": 20,
            "daily": 50,
        }
        if limits:
            for key in self.limits:
                if key in limits:
                    value = limits[key]
                    if not isinstance(value, int) or value < 0:
                        raise ValueError("invalid quota %s" % key)
                    self.limits[key] = value
        self.clock = clock or time.time
        self.path = os.path.join(self.state_dir, "send_state.sqlite3")
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    @contextmanager
    def _connection(self):
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        new_db = not os.path.exists(self.path)
        schema = """
            CREATE TABLE IF NOT EXISTS sends (
                account_scope TEXT NOT NULL,
                send_id TEXT NOT NULL,
                target_key TEXT NOT NULL,
                text_sha256 TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL,
                detail_json TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (account_scope, send_id)
            );
            CREATE INDEX IF NOT EXISTS sends_target_idx
                ON sends(account_scope, target_key, created_at);
        """
        for attempt in range(5):
            try:
                with self._connection() as conn:
                    if new_db:
                        try:
                            conn.execute("PRAGMA journal_mode=WAL")
                        except sqlite3.OperationalError:
                            pass
                    conn.executescript(schema)
                return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))

    def _begin(self, conn):
        conn.execute("BEGIN IMMEDIATE")

    def _existing(self, conn, send_id):
        return conn.execute(
            "SELECT * FROM sends WHERE account_scope=? AND send_id=?",
            (self.account_scope, send_id),
        ).fetchone()

    @staticmethod
    def _row(row):
        if row is None:
            return None
        return dict(row)

    def _quota_used(self, conn, target_key, now):
        rows = conn.execute(
            "SELECT target_key, created_at, status FROM sends "
            "WHERE account_scope=? AND status IN ('reserved','started','unknown','sent_confirmed')",
            (self.account_scope,),
        ).fetchall()
        user = sum(1 for r in rows if r["target_key"] == target_key)
        hourly = sum(1 for r in rows if r["created_at"] >= now - 3600)
        daily = sum(1 for r in rows if r["created_at"] >= now - 86400)
        return user, hourly, daily

    def reserve(self, send_id, target_key, text, kind="private"):
        """Reserve an id before browser interaction.

        Replaying the same id with the same payload returns the persisted row;
        replaying it with different payload is a conflict.  Any prior
        unknown/started/reserved send to the same target is blocked.
        """
        send_id = str(send_id or "").strip()
        target_key = str(target_key or "").strip()
        if not send_id or len(send_id) > 160:
            raise GateError("invalid_send_id", "sendId is required")
        if not target_key or len(target_key) > 300:
            raise GateError("invalid_target", "target identity is required")
        digest = text_digest(text)
        now = float(self.clock())
        with self._connection() as conn:
            self._begin(conn)
            existing = self._existing(conn, send_id)
            if existing:
                if (existing["target_key"] != target_key or
                        existing["text_sha256"] != digest or existing["kind"] != str(kind)):
                    conn.rollback()
                    raise GateError("idempotency_conflict", "sendId payload differs")
                conn.commit()
                return {"kind": "existing", "idempotent": True, "row": self._row(existing)}

            prior = conn.execute(
                "SELECT * FROM sends WHERE account_scope=? AND target_key=? "
                "AND status IN ('reserved','started','unknown') ORDER BY created_at DESC LIMIT 1",
                (self.account_scope, target_key),
            ).fetchone()
            if prior:
                conn.commit()
                return {"kind": "blocked", "idempotent": False, "row": self._row(prior),
                        "reason": "target_has_unresolved_send"}

            user, hourly, daily = self._quota_used(conn, target_key, now)
            if user >= self.limits["per_user"]:
                conn.commit()
                return {"kind": "blocked", "reason": "local_quota_per_user"}
            if hourly >= self.limits["hourly"]:
                conn.commit()
                return {"kind": "blocked", "reason": "local_quota_hourly"}
            if daily >= self.limits["daily"]:
                conn.commit()
                return {"kind": "blocked", "reason": "local_quota_daily"}

            conn.execute(
                "INSERT INTO sends(account_scope,send_id,target_key,text_sha256,kind,status,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (self.account_scope, send_id, target_key, digest, str(kind), "reserved", now),
            )
            row = self._existing(conn, send_id)
            conn.commit()
            return {"kind": "reserved", "idempotent": False, "row": self._row(row)}

    def mark_started(self, send_id):
        now = float(self.clock())
        with self._connection() as conn:
            self._begin(conn)
            row = self._existing(conn, send_id)
            if row is None:
                conn.rollback()
                raise GateError("unknown_send", "sendId was not reserved")
            if row["status"] != "reserved":
                conn.commit()
                return self._row(row)
            conn.execute(
                "UPDATE sends SET status='started', started_at=? WHERE account_scope=? AND send_id=?",
                (now, self.account_scope, send_id),
            )
            row = self._existing(conn, send_id)
            conn.commit()
            return self._row(row)

    def finish(self, send_id, status, reason="", evidence=None):
        if status not in TERMINAL:
            raise ValueError("invalid terminal status")
        with self._connection() as conn:
            self._begin(conn)
            row = self._existing(conn, send_id)
            if row is None:
                conn.rollback()
                raise GateError("unknown_send", "sendId was not reserved")
            if row["status"] in TERMINAL:
                conn.commit()
                return self._row(row)
            if row["status"] == "started" and status == "failed":
                status = "unknown"
                reason = reason or "started_send_outcome_unknown"
            detail = {"reason": str(reason or "")[:300]}
            if evidence is not None:
                try:
                    encoded_evidence = json.dumps(evidence, ensure_ascii=False)
                    detail["evidence"] = evidence if len(encoded_evidence) <= 1800 else {
                        "truncated": True}
                except (TypeError, ValueError):
                    detail["evidence"] = {"type": type(evidence).__name__}
            encoded_detail = json.dumps(detail, ensure_ascii=False)
            conn.execute(
                "UPDATE sends SET status=?, finished_at=?, detail_json=? "
                "WHERE account_scope=? AND send_id=?",
                (status, float(self.clock()), encoded_detail,
                 self.account_scope, send_id),
            )
            row = self._existing(conn, send_id)
            conn.commit()
            return self._row(row)

    def result(self, row):
        detail = json.loads(row.get("detail_json") or "{}")
        status = row["status"]
        if status in ACTIVE:
            status = "unknown"
            detail.setdefault("reason", "send_pending_or_interrupted")
        elif status == "sent_confirmed":
            status = "unknown"
            detail.setdefault("reason", "platform_response_recorded")
        out = {"status": status, "sendId": row["send_id"]}
        if detail.get("reason"):
            out["reason"] = detail["reason"]
        if detail.get("evidence") is not None:
            out["evidence"] = detail["evidence"]
        return out\n