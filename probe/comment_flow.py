"""评论区两阶段流程（架构：images/11-comment-area-business）。

本模块承担 images/18-platform-collaborator-boundary 划给【协作者】的那一段：
    采集结果 -> 公开回复（第一阶段）-> 私信（第二阶段）

它刻意【不】做这几件事，以守住其它几张图的边界：

* 不做关键词匹配 / 排除词 / 点赞阈值（那是流程一，由宿主的筛选结果传进来）。
  本模块只接收【已经筛好的候选】，因此不依赖任何筛选实现。
* 不生成、不改写、不修补话术。两条渠道的话术都由受信宿主在流程边界
  （images/09-knowledge-talk-preparation）提供并冻结；缺一条就把该目标置
  blocked，流程停下等人工 —— 与 live_flow 的做法一致。
* 不计算积分、不写服务端审计。按 docs/api.md，服务端是账号、积分与审计的
  唯一权威，客户端提交的 charged/price 一律被忽略。本模块只产出【可上报的
  逐条状态与证据】，由宿主提交给授权端。

状态机（需求给定，逐条落地）：

    sent_confirmed  允许进入下一阶段
    unknown         结果不确定 —— 禁止自动私信，且【禁止盲目重试】
    failed          按重试策略处理（受 policy.maxPublicAttempts 限制）
    blocked         停止该目标，转人工

两条硬门控：

1. private_candidates() 只放行 public 状态 ∈ policy['allowPublicStates'] 的目标
   （默认只有 sent_confirmed）。unknown / failed / blocked / 未执行 全部拒绝。
2. public_candidates() 不会再发 unknown 的目标 —— 点击已经开始、结果未定，
   架构禁止把它变成第二次盲目触达（images/16-retry-recovery、images/17-action-ledger-idempotency）。

state 按账号隔离，落在 send_gate 旁边，重启后接着跑而不是重放。
整个模块不碰浏览器，所以队列、时间窗、冻结计划与两条门控都能离线测试。
"""
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

QUEUED = "queued"
PLANNED = "planned"
EXPIRED = "expired"
BLOCKED = "blocked"
FAILED = "failed"
UNKNOWN = "unknown"
SENT_CONFIRMED = "sent_confirmed"

# 目标的全部合法状态。对外契约的一部分，capabilities 会原样公布。
STATES = (QUEUED, PLANNED, SENT_CONFIRMED, UNKNOWN, FAILED, BLOCKED, EXPIRED)

# 🔴 拒绝原因是【对外契约】，不是内部日志文案。
#    宿主按它决定「转人工 / 放弃 / 重试」，所以必须是封闭集合，且只在这里声明一次。
#    散落各处拼字符串的后果：宿主只能对着自由文本做匹配，改动无人察觉。
#    新增原因必须同时更新本表 —— test_probe 会校验实际产生的每个原因都在表内。
REJECT_REASONS = (
    # 阶段一：公开回复
    "public_unknown_no_retry",     # 点过了、结果未定 —— 两阶段都拒绝，绝不重试
    "public_blocked",              # 需人工介入（缺话术、命中风控）
    "public_failed",               # 平台明确拒绝
    "public_attempts_exhausted",   # failed 且重试预算用尽
    "public_sent_confirmed",       # 已确认成功，阶段一无需再发
    "public_expired",              # 超出时间窗
    "public_pending",              # 尚无阶段一结果
    "public_planned",              # 已入批但未处理
    "public_queued",               # 仍待在队列里
    # 话术冻结（由 _script_error 按 label 生成，见 _script_error）
    "script_missing",
    "public_text_missing",
    "public_text_too_short",
    "public_text_too_long",
    "private_text_missing",
    "private_text_too_short",
    "private_text_too_long",
    # 阶段二：私信
    "missing_author_id",           # 没有作者标识，无法定位收件人
    "over_private_capacity",       # 超出 maxPrivate
)


def _public_reason(state):
    """状态 -> 阶段一拒绝原因。动态拼接只在这一处发生，保证闭集可枚举。"""
    return "public_%s" % (state or "pending")

# 保守为上：公开回复结果未确定时，绝不产生第二条触达。
POLICY_DEFAULTS = {
    "allowPublicStates": [SENT_CONFIRMED],
    "maxPrivate": 20,
    # 公开回复【最多尝试几次（含首次）】。
    # 默认 1 = 首次失败后不自动重试 —— fail-closed。
    # 只有 failed（明确未提交或被拒绝）才计入重试预算；
    # unknown（点击已发出、结果未定）【永远不重试】，无论此值多大。
    "maxPublicAttempts": 1,
    "minTextLength": 2,
    "maxTextLength": 500,
}

CAPACITY_DEFAULT = 500
WINDOW_DEFAULT = 900
MAX_BATCH = 50


class CommentFlowError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


def _iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def target_key(target):
    """一条评论目标的稳定身份：视频 + 作者 + 评论正文。

    宿主已算出 fingerprint 时直接复用，这样平台换一个瞬时 DOM id 也能认出是同一条。
    """
    fingerprint = str(target.get("fingerprint") or "").strip()
    if fingerprint:
        return fingerprint
    raw = "\x1f".join(str(target.get(field) or "") for field in
                      ("roomId", "authorId", "authorName", "text"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def normalize_policy(value):
    policy = dict(POLICY_DEFAULTS)
    if value:
        if not isinstance(value, dict):
            raise CommentFlowError("invalid_input", "policy must be an object")
        for key, item in value.items():
            if key == "allowPublicStates":
                policy[key] = [str(s) for s in item] if isinstance(item, (list, tuple)) else []
            elif key in ("maxPrivate", "maxPublicAttempts"):
                policy[key] = max(0, int(item))
            elif key in ("minTextLength", "maxTextLength"):
                policy[key] = max(0, int(item))
    return policy


def _script_error(text, policy, label):
    if not isinstance(text, str) or not text.strip():
        return label + "_missing"
    stripped = text.strip()
    if len(stripped) < policy["minTextLength"]:
        return label + "_too_short"
    if len(stripped) > policy["maxTextLength"]:
        return label + "_too_long"
    return ""


class CommentQueue:
    """评论目标的队列、时间窗批次与冻结计划。"""

    def __init__(self, state_dir, account_scope, capacity=CAPACITY_DEFAULT, clock=None):
        self.state_dir = os.path.abspath(os.fspath(state_dir))
        os.makedirs(self.state_dir, exist_ok=True)
        self.account_scope = str(account_scope)
        self.capacity = max(1, int(capacity))
        self.clock = clock or time.time
        self.path = os.path.join(self.state_dir, "comment_flow.sqlite3")
        self._init_db()

    # ------------------------------------------------------------- 连接与建表

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _connection(self):
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self._connection() as conn:
            conn.executescript(
                "CREATE TABLE IF NOT EXISTS comment_targets("
                " account_scope TEXT NOT NULL,"
                " target_key TEXT NOT NULL,"
                " target_id TEXT,"
                " room_id TEXT,"
                " author_id TEXT,"
                " author_name TEXT,"
                " text TEXT,"
                " state TEXT NOT NULL,"
                " detail_json TEXT,"
                " private_json TEXT,"
                " seen_at REAL NOT NULL,"
                " updated_at REAL NOT NULL,"
                " PRIMARY KEY(account_scope, target_key));"
                "CREATE INDEX IF NOT EXISTS idx_comment_targets_state"
                " ON comment_targets(account_scope, state, seen_at);"
                "CREATE TABLE IF NOT EXISTS comment_batches("
                " account_scope TEXT NOT NULL,"
                " batch_id TEXT NOT NULL,"
                " status TEXT NOT NULL,"
                " created_at REAL NOT NULL,"
                " expires_at REAL NOT NULL,"
                " plan_json TEXT,"
                " PRIMARY KEY(account_scope, batch_id));")

    @staticmethod
    def _row(row):
        return dict(row) if row is not None else None

    def _set_state(self, conn, key, state, detail=None, batch_id=None, now=None):
        now = float(now if now is not None else self.clock())
        conn.execute(
            "UPDATE comment_targets SET state=?, detail_json=?, updated_at=?"
            " WHERE account_scope=? AND target_key=?",
            (str(state), json.dumps(detail or {}, ensure_ascii=False), now,
             self.account_scope, str(key)))
        if batch_id:
            conn.execute(
                "UPDATE comment_targets SET target_id=COALESCE(target_id, target_id)"
                " WHERE account_scope=? AND target_key=?", (self.account_scope, str(key)))

    # ------------------------------------------------------------------ 入队

    def append(self, targets, now=None):
        """去重入队，并把队列裁到 capacity。"""
        now = float(now if now is not None else self.clock())
        added = duplicates = 0
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for target in targets or []:
                    if not isinstance(target, dict):
                        continue
                    key = target_key(target)
                    payload_ok = bool(str(target.get("text") or "").strip())
                    if not payload_ok:
                        continue
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO comment_targets"
                        "(account_scope,target_key,target_id,room_id,author_id,author_name,text,"
                        " state,detail_json,private_json,seen_at,updated_at)"
                        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        (self.account_scope, key, str(target.get("id") or ""),
                         str(target.get("roomId") or ""),
                         str(target.get("authorId") or ""),
                         str(target.get("authorName") or "")[:120],
                         str(target.get("text") or "")[:1000],
                         QUEUED, "{}", "{}", now, now))
                    if cur.rowcount:
                        added += 1
                    else:
                        duplicates += 1
                dropped = self._trim(conn, now)
                queued = conn.execute(
                    "SELECT COUNT(*) AS n FROM comment_targets WHERE account_scope=? AND state=?",
                    (self.account_scope, QUEUED)).fetchone()["n"]
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return {"added": added, "duplicates": duplicates, "dropped": dropped,
                "queued": int(queued), "capacity": self.capacity}

    def _trim(self, conn, now):
        excess = conn.execute(
            "SELECT COUNT(*) AS n FROM comment_targets WHERE account_scope=? AND state=?",
            (self.account_scope, QUEUED)).fetchone()["n"] - self.capacity
        if excess <= 0:
            return 0
        stale = conn.execute(
            "SELECT target_key FROM comment_targets WHERE account_scope=? AND state=?"
            " ORDER BY seen_at ASC LIMIT ?", (self.account_scope, QUEUED, excess)).fetchall()
        for row in stale:
            self._set_state(conn, row["target_key"], EXPIRED,
                            {"reason": "queue_capacity_exceeded"}, now=now)
        return len(stale)

    # -------------------------------------------------------------- 取批次

    def take_batch(self, max_items=MAX_BATCH, window_seconds=WINDOW_DEFAULT, now=None):
        """按数量取一批，并把超窗的旧目标标为 expired（永不复用）。"""
        now = float(now if now is not None else self.clock())
        max_items = max(1, min(int(max_items), MAX_BATCH))
        window_seconds = max(1, int(window_seconds))
        expired = []
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                expired_rows = conn.execute(
                    "SELECT target_key, text FROM comment_targets"
                    " WHERE account_scope=? AND state=? AND seen_at <= ? ORDER BY seen_at ASC",
                    (self.account_scope, QUEUED, now - window_seconds)).fetchall()
                for row in expired_rows:
                    self._set_state(conn, row["target_key"], EXPIRED,
                                    {"reason": "window_expired"}, now=now)
                expired = [row["text"] for row in expired_rows]

                batch_id = None
                open_batch = conn.execute(
                    "SELECT * FROM comment_batches WHERE account_scope=? AND status=?"
                    " ORDER BY created_at DESC LIMIT 1",
                    (self.account_scope, "planned")).fetchone()
                if open_batch is not None:
                    planned = conn.execute(
                        "SELECT COUNT(*) AS n FROM comment_targets WHERE account_scope=?"
                        " AND state=?", (self.account_scope, PLANNED)).fetchone()["n"]
                    if planned and now <= open_batch["expires_at"]:
                        batch_id = open_batch["batch_id"]
                    else:
                        # 空批次与超窗批次一律关闭：
                        # 否则空批次被永久复用、超窗批次还能继续发送，两者都违反时间窗规则。
                        reason = "batch_window_expired" if planned else "batch_left_empty"
                        self._close_batch(conn, open_batch["batch_id"], reason, now)
                if batch_id is None:
                    rows = conn.execute(
                        "SELECT target_key FROM comment_targets WHERE account_scope=? AND state=?"
                        " ORDER BY seen_at ASC LIMIT ?",
                        (self.account_scope, QUEUED, max_items)).fetchall()
                    if rows:   # 队列为空时不建批次
                        batch_id = uuid.uuid4().hex[:32]
                        conn.execute(
                            "INSERT INTO comment_batches(account_scope,batch_id,status,created_at,expires_at)"
                            " VALUES(?,?,?,?,?)",
                            (self.account_scope, batch_id, "planned", now, now + window_seconds))
                        for row in rows:
                            conn.execute(
                                "UPDATE comment_targets SET state=? WHERE account_scope=? AND target_key=?",
                                (PLANNED, self.account_scope, row["target_key"]))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        batch = self.batch(batch_id) if batch_id else None
        targets = self.batch_targets(batch_id) if batch_id else []
        return {
            "status": "ok" if targets else "empty",
            "batchId": batch_id,
            "createdAt": _iso(batch["created_at"]) if batch else None,
            "expiresAt": _iso(batch["expires_at"]) if batch else None,
            "frozen": bool(batch and batch["status"] == "frozen"),
            "expiredCount": len(expired),
            "expired": expired[:50],
            "targets": targets,
        }

    def _close_batch(self, conn, batch_id, reason, now):
        """关闭批次并让其目标过期：超窗批次永不复用。"""
        conn.execute("UPDATE comment_batches SET status=? WHERE account_scope=? AND batch_id=?",
                     ("expired", self.account_scope, str(batch_id)))
        for row in conn.execute(
                "SELECT target_key FROM comment_targets WHERE account_scope=? AND state=?",
                (self.account_scope, PLANNED)).fetchall():
            self._set_state(conn, row["target_key"], EXPIRED, {"reason": reason}, now=now)

    def ensure_active(self, batch_id, now=None):
        """批次不再允许执行时 fail-closed。

        两个阶段的方法在碰浏览器【之前】都要调它，这样超窗批次永远不会事后被发出去。
        """
        now = float(now if now is not None else self.clock())
        batch = self.batch(batch_id)
        if batch is None:
            raise CommentFlowError("unknown_batch", "batch does not exist")
        if batch["status"] == "expired" or now > batch["expires_at"]:
            with self._connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    self._close_batch(conn, batch_id, "batch_window_expired", now)
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
            raise CommentFlowError("batch_expired", "batch time window has passed")
        return batch

    def batch(self, batch_id):
        if not batch_id:
            return None
        with self._connection() as conn:
            return self._row(conn.execute(
                "SELECT * FROM comment_batches WHERE account_scope=? AND batch_id=?",
                (self.account_scope, str(batch_id))).fetchone())

    @staticmethod
    def _target_item(row):
        """数据库行 -> 对外目标对象。

        🔴 必须只有这一处映射。曾经 batch_targets 用映射后的形状、
           batch_states 直接用数据库原始行（列名 target_key 而非 targetKey），
           形状不一致让调用方静默拿到一堆 None —— 不报错，只是数据全空。
        """
        return {"targetId": row["target_id"], "targetKey": row["target_key"],
                "roomId": row["room_id"], "authorId": row["author_id"],
                "authorName": row["author_name"], "text": row["text"],
                "state": row["state"],
                "detail": json.loads(row["detail_json"] or "{}"),
                "private": json.loads(row["private_json"] or "{}")}

    def batch_targets(self, batch_id):
        if not batch_id:
            return []
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM comment_targets WHERE account_scope=? AND state IN (?,?)"
                " ORDER BY seen_at ASC", (self.account_scope, PLANNED, EXPIRED)).fetchall()
        return [self._target_item(row) for row in rows]

    def batch_states(self, batch_id):
        """批次【计划内】每个目标的当前状态。

        🔴 统计绝不能建在 batch_targets 上：它的 SQL 是 state IN (planned, expired)，
           目标一旦被标记为 sent_confirmed/unknown/failed 就会从结果里消失，
           于是「结果统计」永远只统计到还没发过的那部分 —— 看起来永远没有进展。
           batch_targets 服务于「取一批」和「冻结计划」，那是另一个用途，不要复用。
        """
        keys = [t.get("targetKey") for t in self.plan(batch_id).get("targets") or []
                if t.get("targetKey")]
        if not keys:
            # 尚未冻结：没有计划可依，退回按状态取（此时目标确实都还在 planned/expired）。
            return self.batch_targets(batch_id)
        rows = []
        with self._connection() as conn:
            for start in range(0, len(keys), 400):   # 避开 SQLite 的变量数上限
                chunk = keys[start:start + 400]
                marks = ",".join("?" * len(chunk))
                rows.extend(conn.execute(
                    "SELECT * FROM comment_targets WHERE account_scope=?"
                    " AND target_key IN (%s)" % marks,
                    (self.account_scope, *chunk)).fetchall())
        return [self._target_item(r) for r in rows]

    # ------------------------------------------------------------ 第一阶段

    def public_candidates(self, batch_id, policy=None):
        """第一阶段待发清单。

        🔴 关键门控：**unknown 的目标不会再被返回**。
        点击已经发出、结果未定，架构禁止把它变成第二次盲目触达
        （images/16-retry-recovery 的「发送结果未知 -> 隔离该动作，禁止自动重发」）。
        failed 只有在 policy['maxPublicAttempts'] 余量内才放行。
        """
        batch = self.batch(batch_id)
        if batch is None:
            raise CommentFlowError("unknown_batch", "batch does not exist")
        plan = self.plan(batch_id)
        policy = normalize_policy(policy or plan.get("policy"))
        items = []
        rejected = []
        for target in plan.get("targets") or []:
            row = self.find_target(target.get("targetKey") or target.get("targetId"))
            state = str((row or {}).get("state") or "")
            detail = json.loads((row or {}).get("detail_json") or "{}")
            attempts = int(detail.get("attempts") or 0)
            reason = ""
            if state == UNKNOWN:
                reason = "public_unknown_no_retry"
            elif state == BLOCKED:
                reason = "public_blocked"
            elif state in (SENT_CONFIRMED, EXPIRED):
                reason = _public_reason(state)
            elif state == FAILED and attempts >= policy["maxPublicAttempts"]:
                reason = "public_attempts_exhausted"
            elif state not in (PLANNED, FAILED):
                reason = _public_reason(state)
            if reason:
                rejected.append({"targetKey": target.get("targetKey"),
                                 "authorName": target.get("authorName"), "reason": reason})
                continue
            items.append(target)
        return items, rejected

    def mark_public(self, target_key_or_id, state, batch_id=None, detail=None):
        """记录第一阶段（公开评论回复）结果。"""
        return self._mark(target_key_or_id, state, batch_id, detail, private=False)

    def mark_private(self, target_key_or_id, status, batch_id=None, detail=None):
        """记录第二阶段（私信）结果，【不覆盖】第一阶段状态。

        第一阶段的状态决定该目标能不能被私信，覆盖它会静默改掉那个判断。
        """
        payload = dict(detail or {})
        payload["status"] = str(status)
        payload["at"] = _iso(self.clock())
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT target_key FROM comment_targets WHERE account_scope=?"
                    " AND (target_id=? OR target_key=?)",
                    (self.account_scope, str(target_key_or_id), str(target_key_or_id))).fetchone()
                if row is None:
                    conn.rollback()
                    raise CommentFlowError("unknown_target", "target is not in the queue")
                conn.execute(
                    "UPDATE comment_targets SET private_json=?, updated_at=?"
                    " WHERE account_scope=? AND target_key=?",
                    (json.dumps(payload, ensure_ascii=False), float(self.clock()),
                     self.account_scope, row["target_key"]))
                conn.commit()
            except CommentFlowError:
                raise
            except Exception:
                conn.rollback()
                raise
        return {"targetKey": row["target_key"], "status": str(status)}

    def _mark(self, key_or_id, state, batch_id, detail, private):
        payload = dict(detail or {})
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT target_key, detail_json FROM comment_targets WHERE account_scope=?"
                    " AND (target_id=? OR target_key=?)",
                    (self.account_scope, str(key_or_id), str(key_or_id))).fetchone()
                if row is None:
                    conn.rollback()
                    raise CommentFlowError("unknown_target", "target is not in the queue")
                previous = json.loads(row["detail_json"] or "{}")
                attempts = int(previous.get("attempts") or 0)
                if str(state) in (FAILED, UNKNOWN):
                    attempts += 1
                payload["attempts"] = attempts
                self._set_state(conn, row["target_key"], state, payload, batch_id)
                conn.commit()
            except CommentFlowError:
                raise
            except Exception:
                conn.rollback()
                raise
        return {"targetKey": row["target_key"], "state": str(state), "detail": payload}

    def find_target(self, key_or_id):
        with self._connection() as conn:
            return self._row(conn.execute(
                "SELECT * FROM comment_targets WHERE account_scope=?"
                " AND (target_id=? OR target_key=?)",
                (self.account_scope, str(key_or_id), str(key_or_id))).fetchone())

    # ---------------------------------------------------------------- 计划

    def freeze_plan(self, batch_id, scripts, policy=None):
        """冻结该批的双渠道话术。

        scripts 把 targetId（或 targetKey）映射到 {publicText, privateText}。
        两条渠道缺一不可；本模块从不自己补话术。
        """
        policy_source = "request" if policy else "builtin_default"
        policy = normalize_policy(policy)
        batch = self.batch(batch_id)
        if batch is None:
            raise CommentFlowError("unknown_batch", "batch does not exist")
        if batch["status"] == "frozen":
            # 冻结即不可变：重复调用是幂等的，【传入的新 policy 不会生效】。
            # 这是有意的 —— 否则"已冻结的计划"可以被事后放宽策略。
            # 需要不同策略时应当建新批次。
            return json.loads(batch["plan_json"] or "{}")
        if not isinstance(scripts, dict):
            raise CommentFlowError("invalid_input", "scripts must be an object")
        targets, blocked = [], []
        for item in self.batch_targets(batch_id):
            if item.get("state") == EXPIRED:
                continue
            entry = scripts.get(item.get("targetId")) or scripts.get(item.get("targetKey"))
            reason = ""
            if not isinstance(entry, dict):
                reason = "script_missing"
            else:
                reason = (_script_error(entry.get("publicText"), policy, "public_text") or
                          _script_error(entry.get("privateText"), policy, "private_text"))
            if reason:
                blocked.append({"targetKey": item.get("targetKey"),
                                "authorName": item.get("authorName"), "reason": reason})
                self._mark(item.get("targetKey"), BLOCKED, batch_id, {"reason": reason}, private=False)
                continue
            targets.append({
                "targetKey": item.get("targetKey"),
                "targetId": item.get("targetId"),
                "roomId": item.get("roomId") or "",
                "authorId": item.get("authorId") or "",
                "authorName": item.get("authorName") or "",
                "text": item.get("text") or "",
                "publicText": entry["publicText"],
                "privateText": entry["privateText"],
                "publicTextSha256": hashlib.sha256(
                    entry["publicText"].encode("utf-8")).hexdigest(),
                "privateTextSha256": hashlib.sha256(
                    entry["privateText"].encode("utf-8")).hexdigest(),
            })
        plan = {"batchId": str(batch_id), "frozenAt": _iso(self.clock()), "policy": policy,
                "targets": targets, "blocked": blocked, "scriptSource": "host",
                "policySource": policy_source}
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "UPDATE comment_batches SET status='frozen', plan_json=?"
                " WHERE account_scope=? AND batch_id=?",
                (json.dumps(plan, ensure_ascii=False), self.account_scope, str(batch_id)))
            conn.commit()
        return plan

    def plan(self, batch_id):
        batch = self.batch(batch_id)
        if batch is None:
            raise CommentFlowError("unknown_batch", "batch does not exist")
        return json.loads(batch["plan_json"] or "{}")

    def target(self, batch_id, key_or_id):
        for item in self.plan(batch_id).get("targets") or []:
            if item.get("targetKey") == key_or_id or item.get("targetId") == key_or_id:
                return item
        return None

    def states(self, batch_id):
        return {item.get("targetKey"): item.get("state")
                for item in self.batch_states(batch_id)}

    # ------------------------------------------------------------ 第二阶段

    def private_candidates(self, batch_id, policy=None):
        """第二阶段清单，**只**由第一阶段已记录的状态推导出来。

        🔴 默认只放行 sent_confirmed。unknown 明确拒绝 —— 公开点击已经开始、
        结果未定，架构不允许把它变成第二条盲目触达。
        """
        plan = self.plan(batch_id)
        policy = normalize_policy(policy or plan.get("policy"))
        allowed, rejected = [], []
        for item in plan.get("targets") or []:
            row = self.find_target(item.get("targetKey") or item.get("targetId"))
            state = str((row or {}).get("state") or "")
            reason = ""
            if state == UNKNOWN:
                reason = "public_unknown_no_retry"
            elif state == BLOCKED:
                reason = "public_blocked"
            elif state == FAILED:
                reason = "public_failed"
            elif state not in policy["allowPublicStates"]:
                reason = _public_reason(state)
            elif not str(item.get("authorId") or "").strip():
                reason = "missing_author_id"
            if reason:
                rejected.append({"targetKey": item.get("targetKey"),
                                 "authorName": item.get("authorName"), "reason": reason})
                continue
            allowed.append(item)
        over = allowed[policy["maxPrivate"]:]
        allowed = allowed[:policy["maxPrivate"]]
        for item in over:
            rejected.append({"targetKey": item.get("targetKey"),
                             "authorName": item.get("authorName"),
                             "reason": "over_private_capacity"})
        return allowed, rejected

    # -------------------------------------------------------------- 结果

    def result(self, batch_id):
        batch = self.batch(batch_id)
        if batch is None:
            raise CommentFlowError("unknown_batch", "batch does not exist")
        plan = self.plan(batch_id)
        items = self.batch_states(batch_id)
        counts = {}
        for item in items:
            state = str(item.get("state"))
            counts[state] = counts.get(state, 0) + 1
        private_counts = {}
        for item in items:
            status = str((item.get("private") or {}).get("status") or "")
            if status:
                private_counts[status] = private_counts.get(status, 0) + 1
        public_pending = [i.get("targetKey") for i in items if str(i.get("state")) == PLANNED]
        allowed, rejected = self.private_candidates(batch_id)
        public_items, public_rejected = self.public_candidates(batch_id)

        # 🔴 漏斗：把「人是在哪一层掉的」一次算清。
        #    只看阶段二的拒绝原因是没用的 —— 绝大多数目标根本走不到阶段二。
        #    调评论筛选的松紧，靠的就是这两层合起来的分布；
        #    分散在两个字段里各看一半，等于没有依据。
        reason_counts = {}
        for entry in list(public_rejected) + list(rejected):
            code = str(entry.get("reason") or "")
            if code:
                reason_counts[code] = reason_counts.get(code, 0) + 1
        funnel = {
            "planned": len(plan.get("targets") or []),
            "blockedBeforeSend": len(plan.get("blocked") or []),
            "publicEligible": len(public_items),
            "publicOutcome": {state: counts[state]
                              for state in (SENT_CONFIRMED, UNKNOWN, FAILED, BLOCKED)
                              if counts.get(state)},
            "privateAllowed": len(allowed),
            "privateRejected": len(rejected),
            "rejectedReasons": reason_counts,
        }
        return {
            "batchId": str(batch_id),
            "status": batch["status"],
            "createdAt": _iso(batch["created_at"]),
            "expiresAt": _iso(batch["expires_at"]),
            "targets": len(plan.get("targets") or []),
            "counts": counts,
            "privateCounts": private_counts,
            # 过期目标不进计划，所以不能从 items 里数 —— 那是两个不同的集合。
            "expiredCount": len([i for i in self.batch_targets(batch_id)
                                 if str(i.get("state")) == EXPIRED]),
            "privateCandidates": len(allowed),
            "privateRejected": rejected,
            "funnel": funnel,
            "channel": "comment",
            "source": "video_comment",
            "checkpoint": {
                "phase": "private" if not public_pending else "public",
                "frozenAt": plan.get("frozenAt"),
                "pendingTargets": public_pending,
                "planTargets": len(plan.get("targets") or []),
                "blockedBeforeSend": [b.get("targetKey") for b in plan.get("blocked") or []],
            },
        }

    def stats(self):
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT state, COUNT(*) AS n FROM comment_targets WHERE account_scope=?"
                " GROUP BY state", (self.account_scope,)).fetchall()
            batches = conn.execute(
                "SELECT COUNT(*) AS n FROM comment_batches WHERE account_scope=?",
                (self.account_scope,)).fetchone()["n"]
        return {"states": {row["state"]: int(row["n"]) for row in rows},
                "batches": int(batches), "capacity": self.capacity}
