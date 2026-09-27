# -*- coding: utf-8 -*-
"""搜索结果保存（找视频模块的候选池）。

架构依据 images/10-video-search-flow 第 3 步「保存视频池与搜索游标」，
以及 images/19（数据归属：池子与游标属于宿主，但探针要提供可持久的落库能力）。

为什么需要它：
  · 此前 search 只把候选放在【响应里】—— 宿主进程一重启，池子就只剩它自己内存里那份，
    翻页游标与已见集合随之断裂；
  · 「选择某个候选视频交给评论区」也缺一条正式链路：宿主只能自己拼 URL，
    于是"这条评论任务来自哪次搜索、哪个关键词、相关度多少"在数据上就断了。

多账号隔离：
  · 库是同一个文件，但每一行都带 account_scope，所有读写都按它过滤；
  · 游标同样带 account_scope（见 sidecar 的 _encode_cursor），跨账号复用会被拒绝
    （cursor_account_mismatch）—— 否则 A 的池子会被当成 B 的已见集合。
"""
import os
import sqlite3
import time
from contextlib import contextmanager

# 持久字段（评审 2026-09-26）：除了 videoId 与链接，池子还必须能回答
# "这个视频什么时候发的" —— create_time（epoch 秒）与 published_at（北京时间 ISO 串）。
# 老库没有这两列，由 _migrate 原地补；历史行留 NULL，不猜。
DB_NAME = "search_pool.sqlite3"


class SearchPoolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


class SearchPool:
    """按【账号 + 关键词】保存候选视频，支持按 videoId 回查。"""

    def __init__(self, state_dir, account_scope, clock=None):
        self.state_dir = os.path.abspath(os.fspath(state_dir))
        os.makedirs(self.state_dir, exist_ok=True)
        self.account_scope = str(account_scope)
        self.clock = clock or time.time
        self.path = os.path.join(self.state_dir, DB_NAME)
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    @contextmanager
    def _connection(self):
        """打开、使用、**总是关闭**。

        sqlite3 自己的连接上下文管理器只提交/回滚，不关闭连接 ——
        在 Windows 上会一直锁着库文件（临时目录删不掉、并发写会撞锁）。
        """
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self._connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS search_videos (
                    account_scope TEXT NOT NULL,
                    keyword TEXT NOT NULL,
                    aweme_id TEXT NOT NULL,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    author TEXT NOT NULL DEFAULT '',
                    author_id TEXT NOT NULL DEFAULT '',
                    relevance_score INTEGER NOT NULL DEFAULT 0,
                    relevance_reason TEXT NOT NULL DEFAULT '',
                    first_seen_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    create_time INTEGER,
                    published_at TEXT,
                    PRIMARY KEY (account_scope, keyword, aweme_id)
                )
                """)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_search_videos_scope_keyword "
                "ON search_videos(account_scope, keyword, relevance_score DESC)")
            self._migrate(conn)

    @staticmethod
    def _migrate(conn):
        """给【老库】补列：CREATE TABLE IF NOT EXISTS 对已存在的表什么都不做。

        create_time / published_at 是 2026-09-26 评审要求补的持久字段：
        此前池子只存链接与相关度，宿主重启后"这个视频什么时候发的"就丢了，
        而发布时间恰恰是"按 6–9 月筛"的依据，也是交给评论区时必须能复查的事实。

        老库里已有的行补不到历史值（那时根本没采），一律留 NULL，
        由 sidecar 按 unknownDate 计数 —— 不猜、不编。
        """
        have = {row["name"] for row in conn.execute("PRAGMA table_info(search_videos)")}
        added = []
        for name, kind in (("create_time", "INTEGER"), ("published_at", "TEXT")):
            if name not in have:
                conn.execute("ALTER TABLE search_videos ADD COLUMN %s %s" % (name, kind))
                added.append(name)
        return added

    @staticmethod
    def _publish_time(video):
        """(create_time, published_at)：取不到就是 None。

        🔴 不拿采集时刻冒充发布日期：池子里的时间字段是【筛选依据】，
           编一个出来会让"这批是按 6–9 月筛的"变成假话。
        """
        raw = video.get("createTime")
        try:
            create_time = int(raw) if raw not in (None, "") else None
        except (TypeError, ValueError):
            create_time = None
        published = str(video.get("publishedAt") or "")[:40] or None
        return (create_time or None), published

    @staticmethod
    def _row(row):
        if row is None:
            return None
        create_time = row["create_time"]
        return {"videoId": str(row["aweme_id"]), "url": row["url"], "title": row["title"],
                "author": row["author"], "authorId": row["author_id"], "keyword": row["keyword"],
                "relevance": {"score": int(row["relevance_score"]),
                              "reason": row["relevance_reason"]},
                # 发布时间：重启后也必须读得到（评审 2026-09-26）。
                # 拿不到就是 None —— 宿主据此把它归到 unknownDate，而不是当成【不限时间】。
                "createTime": int(create_time) if create_time is not None else None,
                "publishedAt": row["published_at"] or None,
                "firstSeenAt": row["first_seen_at"], "updatedAt": row["updated_at"]}

    def save(self, keyword, videos, now=None):
        """把一页候选写进池子（同一账号+关键词+视频 只保留一行，更新相关度与时间）。

        保存的是【本次采集到的全部视频】，包括被 minRelevance 筛掉的那些：
        它们同样"已经见过"，漏掉就会在下一页被当成新视频重复采集。
        """
        keyword = str(keyword or "").strip()
        if not keyword:
            raise SearchPoolError("invalid_input", "keyword is required")
        stamp = float(now if now is not None else self.clock())
        inserted = updated = 0
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for video in videos or []:
                    video_id = str(video.get("id") or video.get("aweme_id") or "").strip()
                    if not video_id:
                        continue
                    relevance = video.get("relevance") or {}
                    create_time, published_at = self._publish_time(video)
                    row = conn.execute(
                        "SELECT aweme_id FROM search_videos WHERE account_scope=? AND keyword=? "
                        "AND aweme_id=?", (self.account_scope, keyword, video_id)).fetchone()
                    if row is None:
                        inserted += 1
                    else:
                        updated += 1
                    # 发布时间用 COALESCE：它是【筛选依据】。新一次采集没拿到的话，
                    # 不该把已经知道的那个值擦掉 —— 否则重启后反而比重启前丢信息。
                    conn.execute(
                        "INSERT INTO search_videos(account_scope,keyword,aweme_id,url,title,"
                        "author,author_id,relevance_score,relevance_reason,create_time,"
                        "published_at,first_seen_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
                        "ON CONFLICT(account_scope,keyword,aweme_id) DO UPDATE SET "
                        "url=excluded.url, title=excluded.title, author=excluded.author, "
                        "author_id=excluded.author_id, relevance_score=excluded.relevance_score, "
                        "relevance_reason=excluded.relevance_reason, "
                        "create_time=COALESCE(excluded.create_time, search_videos.create_time), "
                        "published_at=COALESCE(excluded.published_at, search_videos.published_at), "
                        "updated_at=excluded.updated_at",
                        (self.account_scope, keyword, video_id, str(video.get("url") or ""),
                         str(video.get("title") or "")[:200], str(video.get("author") or "")[:120],
                         str(video.get("authorId") or "")[:200],
                         int(relevance.get("score") or 0),
                         str(relevance.get("reason") or "")[:60],
                         create_time, published_at, stamp, stamp))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return {"keyword": keyword, "inserted": inserted, "updated": updated,
                "saved": inserted + updated}

    def list(self, keyword=None, limit=200, min_relevance=0):
        clause = "account_scope=? AND relevance_score>=?"
        args = [self.account_scope, int(min_relevance or 0)]
        if keyword:
            clause += " AND keyword=?"
            args.append(str(keyword))
        args.append(max(1, min(int(limit), 1000)))
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM search_videos WHERE " + clause +
                " ORDER BY relevance_score DESC, updated_at DESC LIMIT ?", tuple(args)).fetchall()
        return [self._row(row) for row in rows]

    def get(self, video_id):
        """按 videoId 回查（不限关键词）—— 这是「选择视频交给评论区」的正式入口。"""
        video_id = str(video_id or "").strip()
        if not video_id:
            return None
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM search_videos WHERE account_scope=? AND aweme_id=? "
                "ORDER BY updated_at DESC LIMIT 1", (self.account_scope, video_id)).fetchone()
        return self._row(row)

    def stats(self):
        with self._connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS total, COUNT(DISTINCT keyword) AS keywords, "
                "SUM(CASE WHEN create_time IS NULL THEN 1 ELSE 0 END) AS unknown_date "
                "FROM search_videos WHERE account_scope=?", (self.account_scope,)).fetchone()
            by_keyword = conn.execute(
                "SELECT keyword, COUNT(*) AS n FROM search_videos WHERE account_scope=? "
                "GROUP BY keyword ORDER BY n DESC LIMIT 20", (self.account_scope,)).fetchall()
        return {"total": int(row["total"]), "keywords": int(row["keywords"]),
                # 取不到发布时间的条数：宿主据此判断"按时间筛过的池子到底干不干净"。
                "unknownDate": int(row["unknown_date"] or 0),
                "byKeyword": [{"keyword": r["keyword"], "count": int(r["n"])} for r in by_keyword],
                "db": DB_NAME}
