# -*- coding: utf-8 -*-
"""评论去重不得误合并不同用户（评审 2026-09-26）。

原来的键是 (sec_uid or "", 正文)：没有 sec_uid 的评论全部落进【同一个空身份的桶】，
于是两个不同用户发同一句话（"求带"）会被判成同一条评论并丢掉其中一条。
下游是按人去私信的 —— 丢错人就是给错人发消息。

这里钉住四条性质：
  1) 有评论 ID 时按 ID 合并（同一条评论的两次采集只留一条，留信息更全的那条）；
  2) 有作者标识时按 (作者 + 正文) 合并（接口带表情、DOM 丢表情的同一条）；
  3) 只有昵称时按 (昵称 + 正文) 合并 —— 认得出"还是那一行"，但不会并掉别人的行；
  4) 什么身份都没有时【各自保留】，绝不因为正文相同而丢弃。
"""
import pathlib
import sys
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import crawl  # noqa: E402
import sidecar  # noqa: E402

AWEME = "7300000000000000000"
TEXT = "求带"


def row(text=TEXT, cid=None, sec_uid=None, nick=None, source="dom", digg=0):
    return {"cid": cid, "aweme_id": AWEME, "text": text, "user": nick or "",
            "sec_uid": sec_uid or "", "digg": digg, "video_title": "怎么做副业",
            "source": source}


class FakeDomPage:
    def __init__(self, aweme_id=AWEME):
        self.url = "https://www.douyin.com/video/%s" % aweme_id

    def evaluate(self, expression):
        if expression == "location.href":
            return self.url
        return None


class CommentDedupeIdentityTests(unittest.TestCase):
    """dedupe_comments 的身份优先级。"""

    def test_two_users_with_the_same_text_are_not_merged(self):
        rows = crawl.dedupe_comments([row(nick="甲"), row(nick="乙")])
        self.assertEqual(len(rows), 2, "同一句话的不同用户是两条评论")
        self.assertEqual([r["user"] for r in rows], ["甲", "乙"])

    def test_two_anonymous_rows_with_the_same_text_are_both_kept(self):
        """连昵称都没有：宁可留重复，也不能合并 —— 无从证明是同一条。"""
        rows = crawl.dedupe_comments([row(), row()])
        self.assertEqual(len(rows), 2)

    def test_the_same_comment_id_is_merged_and_the_richer_copy_wins(self):
        api = row(text="谢谢了[握手]", cid="cid-1", sec_uid="sec-1", source="api", digg=3)
        dom = row(text="谢谢了", cid="cid-1", nick="甲")
        rows = crawl.dedupe_comments([dom, api])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source"], "api", "接口记录更全（有 cid/digg/地区）")

    def test_a_dom_copy_of_the_same_comment_is_still_merged_by_author(self):
        """真机上的老问题：接口正文带表情、DOM 正文把表情丢了。"""
        rows = crawl.dedupe_comments([
            row(text="谢谢了[握手][握手]", sec_uid="sec-1", source="api", digg=2),
            row(text="谢谢了", sec_uid="sec-1", nick="甲"),
        ])
        self.assertEqual(len(rows), 1)

    def test_the_same_author_still_keeps_two_different_comments(self):
        rows = crawl.dedupe_comments([
            row(text="求带", sec_uid="sec-1", nick="甲"),
            row(text="怎么做", sec_uid="sec-1", nick="甲"),
        ])
        self.assertEqual(len(rows), 2, "两条正文不同的评论本来就是两条")

    def test_a_nick_carrying_a_comment_id_wins_over_a_nick_only_one(self):
        rows = crawl.dedupe_comments([
            row(text="求带", nick="甲"),
            row(text="求带", cid="cid-9", nick="甲"),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["cid"], "cid-9", "留下能被下游正式引用的那条")


    def test_two_different_comment_ids_are_never_merged(self):
        """两个【不同的非空评论 ID】必须是两条记录：作者与正文相同也不行。

        评审 2026-09-27：身份兜底逻辑会把"同作者 + 同正文"并成一条，
        但评论 ID 不同就是两条不同的评论 —— 合并会让下游漏掉一条目标，
        也会让"这条评论有没有被处理过"的账对不上。
        """
        rows = crawl.dedupe_comments([
            row(text=TEXT, cid="cid-1", sec_uid="sec-1", nick="甲", source="api"),
            row(text=TEXT, cid="cid-2", sec_uid="sec-1", nick="甲", source="api"),
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(sorted(r["cid"] for r in rows), ["cid-1", "cid-2"])

    def test_two_different_comment_ids_are_kept_without_any_author_id(self):
        """只有昵称、但有不同评论 ID：同样不能合并（昵称不是身份，ID 才是）。"""
        rows = crawl.dedupe_comments([
            row(text=TEXT, cid="cid-1", nick="甲"),
            row(text=TEXT, cid="cid-2", nick="甲"),
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual([r.get("_cid") for r in rows], [None, None],
                         "内部去重键不得泄漏到调用方")

    def test_a_dom_copy_still_merges_into_the_id_bearing_record(self):
        """反向保护：没有评论 ID 的那一份（DOM 副本）仍然要并进有 ID 的记录。"""
        rows = crawl.dedupe_comments([
            row(text="谢谢了", sec_uid="sec-1", nick="甲"),
            row(text="谢谢了[握手]", cid="cid-1", sec_uid="sec-1", source="api", digg=2),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["cid"], "cid-1", "留下能被下游正式引用的那条")

    def test_two_ids_and_a_dom_copy_produce_two_records(self):
        """混合场景：两条不同 ID 的评论 + 一条 DOM 副本 = 两条记录（副本并进其中一条）。"""
        rows = crawl.dedupe_comments([
            row(text=TEXT, cid="cid-1", sec_uid="sec-1", nick="甲", source="api"),
            row(text=TEXT, cid="cid-2", sec_uid="sec-1", nick="甲", source="api"),
            row(text=TEXT, sec_uid="sec-1", nick="甲"),
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(sorted(r["cid"] for r in rows), ["cid-1", "cid-2"])


class CommentAbsorbKeyTests(unittest.TestCase):
    """抓取期的键：_comment_key 是 comments 字典的键，撞了就直接丢。"""

    def test_the_absorb_key_prefers_the_comment_id(self):
        self.assertEqual(crawl._comment_key(row(cid="cid-1", nick="甲"))[0], "cid")

    def test_the_absorb_key_never_collides_on_an_empty_identity(self):
        first = crawl._comment_key(row())
        second = crawl._comment_key(row())
        self.assertNotEqual(first, second, "空身份 + 相同正文不能再撞键")

    def test_the_absorb_key_uses_the_author_when_there_is_one(self):
        self.assertEqual(crawl._comment_key(row(sec_uid="sec-1")),
                         crawl._comment_key(row(text="求带" + " ", sec_uid="sec-1")))
        self.assertNotEqual(crawl._comment_key(row(text="求带", sec_uid="sec-1")),
                            crawl._comment_key(row(text="怎么做", sec_uid="sec-1")))

    def test_the_absorb_key_uses_the_nick_as_a_last_resort(self):
        self.assertNotEqual(crawl._comment_key(row(nick="甲")), crawl._comment_key(row(nick="乙")))
        self.assertEqual(crawl._comment_key(row(nick="甲")), crawl._comment_key(row(nick="甲")))


class DomAbsorbIntegrationTests(unittest.TestCase):
    """DOM 兜底每轮都会重读可见行：既不能重复收，也不能并掉不同用户。"""

    def _absorb(self, rows, rounds=1):
        comments, stats = {}, {"dom_rows": 0, "dom_skipped_off_target": 0}
        original = crawl.douyin.collect_comments
        crawl.douyin.collect_comments = lambda page, limit=120: list(rows)
        try:
            for _ in range(rounds):
                crawl._absorb_dom_comments(FakeDomPage(), comments, AWEME, "怎么做副业", stats)
        finally:
            crawl.douyin.collect_comments = original
        return list(comments.values())

    def test_two_users_saying_the_same_thing_are_both_kept(self):
        kept = self._absorb([{"nick": "甲", "text": TEXT, "sec_uid": None},
                             {"nick": "乙", "text": TEXT, "sec_uid": None}])
        self.assertEqual(len(kept), 2, "两个用户各留一条，不能只剩一条")

    def test_an_anonymous_row_is_kept_even_without_any_identity(self):
        kept = self._absorb([{"nick": "", "text": TEXT, "sec_uid": None},
                             {"nick": "", "text": TEXT, "sec_uid": None}])
        self.assertEqual(len(kept), 2, "没有任何身份字段时也不许合并")

    def test_a_reread_row_is_not_collected_twice(self):
        kept = self._absorb([{"nick": "甲", "text": TEXT, "sec_uid": "sec-1"}], rounds=3)
        self.assertEqual(len(kept), 1, "同一行被重读三次仍然只有一条")


class SidecarAuthorDedupeTests(unittest.TestCase):
    """目标批次那一层（sidecar._dedupe_by_author）同样不得并掉不同用户。"""

    def test_anonymous_rows_are_never_merged_with_each_other(self):
        kept, dropped = sidecar._dedupe_by_author([
            {"text": TEXT, "cid": "cid-1", "digg": 0},
            {"text": TEXT, "cid": "cid-2", "digg": 0},
        ])
        self.assertEqual(len(kept), 2)
        self.assertEqual(dropped, 0)

    def test_the_same_author_is_still_deduped_to_the_highest_digg(self):
        kept, dropped = sidecar._dedupe_by_author([
            {"text": TEXT, "sec_uid": "sec-1", "cid": "cid-1", "digg": 1},
            {"text": "怎么做", "sec_uid": "sec-1", "cid": "cid-2", "digg": 9},
        ])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["cid"], "cid-2")
        self.assertEqual(dropped, 1)


if __name__ == "__main__":
    unittest.main()
