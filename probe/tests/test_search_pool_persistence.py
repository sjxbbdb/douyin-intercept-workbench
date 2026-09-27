# -*- coding: utf-8 -*-
"""搜索池必须持久保存发布时间，并且能从老库原地迁移（评审 2026-09-26）。

池子是 `videoId -> 评论区` 的正式交接依据（见 SearchPool.get 的说明）。
重启后"这个视频什么时候发的"必须还在，否则"按 6–9 月筛的这批"无从复查：
宿主重启一次，池子里就只剩链接和相关度，发布时间这道筛选依据等于丢失。

三条性质：
  1) createTime / publishedAt 落库，新进程打开同一个库读得到；
  2) 老库（没有这两列）原地补列，历史行留 NULL —— 不编一个时间出来；
  3) 新一次采集没拿到发布时间时，用 COALESCE 保留已知值，不擦掉。
"""
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import search_pool  # noqa: E402
import sidecar  # noqa: E402

KEYWORD = "怎么做副业"
SCOPE = "account-a"
# 2026-06-15T12:00:00+08:00
JUNE = 1781496000
OLD_SCHEMA = (
    "CREATE TABLE search_videos ("
    "account_scope TEXT NOT NULL, keyword TEXT NOT NULL, aweme_id TEXT NOT NULL,"
    "url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',"
    "author TEXT NOT NULL DEFAULT '', author_id TEXT NOT NULL DEFAULT '',"
    "relevance_score INTEGER NOT NULL DEFAULT 0,"
    "relevance_reason TEXT NOT NULL DEFAULT '',"
    "first_seen_at REAL NOT NULL, updated_at REAL NOT NULL,"
    "PRIMARY KEY (account_scope, keyword, aweme_id))")


class FakeSearchPage:
    def __init__(self):
        self.url = "https://www.douyin.com/search/x?type=general"

    def evaluate(self, expression):
        if expression == "location.href":
            return self.url
        return None

    def close(self):
        pass


def fake_search(pool):
    def run(page, keyword, scroll_rounds=12, max_videos=200, log=print, strict=False,
            meta=None, navigate=True, seen_ids=None):
        seen = {str(x) for x in (seen_ids or ())}
        page_items = [v for v in pool if v["aweme_id"] not in seen][:max_videos]
        if isinstance(meta, dict):
            meta["skipped_seen"] = 0
        return [dict(v) for v in page_items]

    return run


class FakeSidecar(sidecar.Sidecar):
    """只装搜索需要的属性，并挂一个真实的池子：不打开浏览器。"""

    def __init__(self, videos, state_dir, scope=SCOPE):
        self.videos = videos
        self.account_scope = scope
        self.video_pool = search_pool.SearchPool(state_dir, scope)

    def _page(self):
        return FakeSearchPage(), {}


def demo_videos(count=3):
    return [{"aweme_id": "v%d" % i,
             "url": "https://www.douyin.com/video/v%d" % i,
             "desc": "%s 第%d期" % (KEYWORD, i), "author": "作者%d" % i,
             "author_sec_uid": "sec-%d" % i, "create_time": JUNE}
            for i in range(1, count + 1)]


class SearchPoolPersistenceTests(unittest.TestCase):
    """池子的持久字段与迁移。"""

    @staticmethod
    def _rows():
        return [
            {"id": "v1", "url": "https://www.douyin.com/video/1", "title": "怎么做副业 第1期",
             "author": "作者1", "authorId": "sec-1", "createTime": JUNE,
             "publishedAt": "2026-06-15T12:00:00+08:00",
             "relevance": {"score": 100, "reason": "exact_phrase"}},
            {"id": "v2", "url": "https://www.douyin.com/video/2", "title": "怎么做副业 第2期",
             "author": "作者2", "authorId": "sec-2", "createTime": None, "publishedAt": None,
             "relevance": {"score": 80, "reason": "all_segments"}},
        ]

    def test_publish_time_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as td:
            search_pool.SearchPool(td, SCOPE).save(KEYWORD, self._rows())
            # 宿主重启 = 新进程打开同一个库：读得到才算持久化。
            reopened = search_pool.SearchPool(td, SCOPE)
            rows = {row["videoId"]: row for row in reopened.list()}
            self.assertEqual(rows["v1"]["createTime"], JUNE)
            self.assertEqual(rows["v1"]["publishedAt"], "2026-06-15T12:00:00+08:00")
            self.assertIsNone(rows["v2"]["createTime"], "取不到发布时间就是 None，不编一个")
            self.assertIsNone(rows["v2"]["publishedAt"])
            self.assertEqual(reopened.stats()["unknownDate"], 1)

    def test_a_resave_without_a_publish_time_keeps_the_known_one(self):
        """发布时间是筛选依据：新一次采集没拿到，不该把已知的值擦掉。"""
        with tempfile.TemporaryDirectory() as td:
            pool = search_pool.SearchPool(td, SCOPE)
            pool.save(KEYWORD, self._rows())
            pool.save(KEYWORD, [dict(self._rows()[0], createTime=None, publishedAt=None)])
            self.assertEqual(pool.get("v1")["createTime"], JUNE)
            self.assertEqual(pool.stats()["unknownDate"], 1)

    def test_an_old_database_is_migrated_in_place(self):
        """老库（没有这两列）必须原地补列，已有行留 NULL。"""
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, search_pool.DB_NAME)
            conn = sqlite3.connect(path)
            conn.execute(OLD_SCHEMA)
            conn.execute("INSERT INTO search_videos VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (SCOPE, KEYWORD, "old-1", "https://www.douyin.com/video/old-1",
                          "老库里的视频", "作者", "sec-old", 80, "exact_phrase", 1.0, 1.0))
            conn.commit()
            conn.close()

            pool = search_pool.SearchPool(td, SCOPE)
            conn = sqlite3.connect(path)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(search_videos)")}
            conn.close()
            self.assertLessEqual({"create_time", "published_at"}, columns)

            old = pool.get("old-1")
            self.assertIsNone(old["createTime"], "历史行没有发布时间，不能编")
            self.assertIsNone(old["publishedAt"])
            # 迁移后写入必须带上新字段，否则补列等于白补。
            pool.save(KEYWORD, self._rows())
            self.assertEqual(pool.get("v1")["createTime"], JUNE)
            # old-1（历史行）+ v2（本次没采到时间）= 2 条 unknownDate。
            self.assertEqual(pool.stats()["unknownDate"], 2)

    def test_an_empty_pool_reports_zero_unknown_dates(self):
        """空池的 SUM() 是 NULL：不能让它变成 None 顺着协议发给宿主。"""
        with tempfile.TemporaryDirectory() as td:
            stats = search_pool.SearchPool(td, SCOPE).stats()
            self.assertEqual(stats["total"], 0)
            self.assertEqual(stats["unknownDate"], 0)

    def test_the_video_id_handoff_back_to_the_comment_area_is_unchanged(self):
        """videoId -> 评论区 的正式交接不变：get() 仍按 videoId 回查整行。"""
        with tempfile.TemporaryDirectory() as td:
            pool = search_pool.SearchPool(td, SCOPE)
            pool.save(KEYWORD, self._rows())
            row = pool.get("v1")
            self.assertEqual(row["url"], "https://www.douyin.com/video/1")
            self.assertEqual(row["keyword"], KEYWORD)
            self.assertEqual(row["authorId"], "sec-1")
            self.assertEqual(row["relevance"]["score"], 100)
            self.assertEqual(row["createTime"], JUNE)
            self.assertIsNone(pool.get("not-in-the-pool"))

    def test_the_pool_method_exposes_the_publish_time(self):
        """宿主读池子的正式入口（search_pool）也要带上发布时间。"""
        with tempfile.TemporaryDirectory() as td:
            instance = FakeSidecar(demo_videos(), td)
            original_search = sidecar.crawlmod.search_videos
            original_login = sidecar.douyin.login_state
            sidecar.douyin.login_state = lambda _page: "ok"
            sidecar.crawlmod.search_videos = fake_search(instance.videos)
            try:
                instance.search({"keyword": KEYWORD, "maxVideos": 3})
            finally:
                sidecar.crawlmod.search_videos = original_search
                sidecar.douyin.login_state = original_login
            listing = instance.search_pool({})
            self.assertEqual(len(listing["videos"]), 3)
            self.assertEqual(listing["videos"][0]["createTime"], JUNE)
            self.assertEqual(listing["videos"][0]["publishedAt"], "2026-06-15T12:00:00+08:00")
            self.assertEqual(listing["stats"]["unknownDate"], 0)

    def test_another_account_reads_its_own_pool_only(self):
        """补字段不能带走多账号隔离：新列同样按 account_scope 过滤。"""
        with tempfile.TemporaryDirectory() as td:
            search_pool.SearchPool(td, SCOPE).save(KEYWORD, self._rows())
            other = search_pool.SearchPool(td, "account-b")
            self.assertEqual(other.list(), [])
            self.assertIsNone(other.get("v1"))
            self.assertEqual(other.stats()["total"], 0)


if __name__ == "__main__":
    unittest.main()
