# -*- coding: utf-8 -*-
"""找视频模块：分页游标必须绑定【规范化后的筛选条件】（评审 2026-09-26）。

游标此前只绑定关键词与账号。于是宿主可以带着 minRelevance=60 采完第一页，
第二页把条件改掉继续用同一个游标 —— 两页条件不同，却被当成"同一次搜索"，
而"这批是按 6–9 月、相关度 60 以上采的"正是宿主决定给谁发消息的依据。

这里钉住三条：
  1) 条件变了 -> cursor_filter_mismatch，而且必须在【打开浏览器之前】拒绝；
  2) 语义等价的写法（2026-06 与 2026-06-01）解析后相同，不算变化；
  3) 缺 "f" / "f" 形状不对 / v1 老游标一律拒绝，不猜它想表达什么。

这些用例都不碰浏览器：搜索用它自己的假 search_videos。
"""
import base64
import json
import pathlib
import sys
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import sidecar  # noqa: E402

KEYWORD = "怎么做副业"
SCOPE = "account-a"
# 2026-06-15T12:00:00+08:00
JUNE = 1781496000


def token_of(payload):
    """按 sidecar 的编码方式手搓一个游标（用来构造"协议外"的输入）。"""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


class FakeSearchPage:
    """search 只需要 location.href；续页时靠它判断"还在不在搜索页上"。"""

    def __init__(self):
        self.url = "https://www.douyin.com/search/x?type=general"

    def evaluate(self, expression):
        if expression == "location.href":
            return self.url
        return None

    def close(self):
        pass


def fake_search(pool):
    """假的 search_videos：池子里已有的先剔掉，剩下的按 maxVideos 给一页。"""

    def run(page, keyword, scroll_rounds=12, max_videos=200, log=print, strict=False,
            meta=None, navigate=True, seen_ids=None):
        seen = {str(x) for x in (seen_ids or ())}
        page_items = [v for v in pool if v["aweme_id"] not in seen][:max_videos]
        if isinstance(meta, dict):
            meta["skipped_seen"] = 0
            meta["platform_cursor"] = "pc-1"
            meta["platform_has_more"] = 1
        return [dict(v) for v in page_items]

    return run


class FakeSidecar(sidecar.Sidecar):
    """只装 search 需要的属性：不打开浏览器、不建真实页面。

    继承 Sidecar 是为了复用 _pool() 等取用口 —— 替身也要走同一条路径，
    否则测的就不是真实契约。opened 用来证明"拒绝发生在打开浏览器之前"。
    """

    def __init__(self, videos=None, scope=SCOPE):
        self.videos = videos or []
        self.account_scope = scope
        self.opened = 0

    def _page(self):
        self.opened += 1
        return FakeSearchPage(), {}


def run_search(instance, params):
    original_search = sidecar.crawlmod.search_videos
    original_login = sidecar.douyin.login_state
    sidecar.douyin.login_state = lambda _page: "ok"
    sidecar.crawlmod.search_videos = fake_search(instance.videos)
    try:
        return instance.search(params)
    finally:
        sidecar.crawlmod.search_videos = original_search
        sidecar.douyin.login_state = original_login


def demo_videos(count=20, relevant=14):
    out = []
    for index in range(1, count + 1):
        desc = "%s 第%d期" % (KEYWORD, index) if index <= relevant else "今晚吃火锅第%d期" % index
        out.append({"aweme_id": "v%02d" % index,
                    "url": "https://www.douyin.com/video/v%02d" % index,
                    "desc": desc, "author": "作者%d" % index,
                    "author_sec_uid": "sec-%02d" % index, "create_time": JUNE})
    return out


class CursorFilterBindingTests(unittest.TestCase):
    """游标 = 关键词 + 账号 + 【规范化后的筛选条件】。"""

    def test_a_cursor_round_trips_with_its_filters(self):
        binding = sidecar._filter_binding(1000, 2000, 60)
        token = sidecar._encode_cursor(KEYWORD, {"1", "2"}, 3, SCOPE, binding)
        self.assertEqual(sidecar._decode_cursor(token, KEYWORD, SCOPE, binding),
                         ({"1", "2"}, 3))

    def test_changing_the_relevance_filter_is_refused(self):
        plain = sidecar._filter_binding(None, None, 0)
        strict = sidecar._filter_binding(None, None, 60)
        token = sidecar._encode_cursor(KEYWORD, {"1"}, 2, SCOPE, plain)
        with self.assertRaises(sidecar.SidecarError) as raised:
            sidecar._decode_cursor(token, KEYWORD, SCOPE, strict)
        self.assertEqual(raised.exception.code, "cursor_filter_mismatch")

    def test_changing_the_date_range_is_refused(self):
        june = sidecar._filter_binding(sidecar._date_bound_epoch("2026-06", "dateFrom"),
                                       sidecar._date_bound_epoch("2026-09", "dateTo", end=True), 0)
        july = sidecar._filter_binding(sidecar._date_bound_epoch("2026-07", "dateFrom"),
                                       sidecar._date_bound_epoch("2026-09", "dateTo", end=True), 0)
        token = sidecar._encode_cursor(KEYWORD, {"1"}, 2, SCOPE, june)
        with self.assertRaises(sidecar.SidecarError) as raised:
            sidecar._decode_cursor(token, KEYWORD, SCOPE, july)
        self.assertEqual(raised.exception.code, "cursor_filter_mismatch")

    def test_an_equivalent_date_written_differently_is_not_a_change(self):
        """2026-06 与 2026-06-01 是同一天开始：语义相同就不该判成"条件变了"。"""
        month = sidecar._filter_binding(sidecar._date_bound_epoch("2026-06", "dateFrom"), None, 0)
        day = sidecar._filter_binding(sidecar._date_bound_epoch("2026-06-01", "dateFrom"), None, 0)
        self.assertEqual(month, day)
        token = sidecar._encode_cursor(KEYWORD, {"1"}, 2, SCOPE, month)
        self.assertEqual(sidecar._decode_cursor(token, KEYWORD, SCOPE, day), ({"1"}, 2))

    def test_a_cursor_without_filter_bindings_is_refused(self):
        """缺 "f" / "f" 不是对象 / "f" 缺键：一律按不一致拒绝，不猜它想表达什么。"""
        base = {"v": sidecar.CURSOR_VERSION, "k": KEYWORD, "n": 2, "seen": ["1"], "a": SCOPE}
        for payload in (dict(base), dict(base, f="2026-06"), dict(base, f={"dateFrom": None}),
                        dict(base, f=dict(dateFrom=None, dateTo=None))):
            with self.assertRaises(sidecar.SidecarError) as raised:
                sidecar._decode_cursor(token_of(payload), KEYWORD, SCOPE)
            self.assertEqual(raised.exception.code, "cursor_filter_mismatch", payload)

    def test_the_default_expectation_is_a_cursor_without_filters(self):
        """忘了传 filters 的调用方是 fail-closed 的：它只会被拒绝，不会放行。"""
        plain = sidecar._encode_cursor(KEYWORD, {"1"}, 2, SCOPE)
        self.assertEqual(sidecar._decode_cursor(plain, KEYWORD, SCOPE), ({"1"}, 2))
        with self.assertRaises(sidecar.SidecarError) as raised:
            sidecar._decode_cursor(plain, KEYWORD, SCOPE,
                                   sidecar._filter_binding(None, None, 60))
        self.assertEqual(raised.exception.code, "cursor_filter_mismatch")

    def test_version_one_cursors_are_refused(self):
        """v1 游标里没有筛选条件，无法判断它是在什么条件下采的 —— 直接拒绝。"""
        self.assertEqual(sidecar.CURSOR_VERSION, 2)
        payload = {"v": 1, "k": KEYWORD, "n": 2, "seen": ["1"]}
        with self.assertRaises(sidecar.SidecarError) as raised:
            sidecar._decode_cursor(token_of(payload), KEYWORD, SCOPE)
        self.assertEqual(raised.exception.code, "invalid_input")


class SearchPaginationFilterTests(unittest.TestCase):
    """分页集成：条件变化必须在【打开浏览器之前】被拒绝。"""

    def test_the_page_cursor_is_bound_to_the_filters(self):
        instance = FakeSidecar(demo_videos())
        first = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10, "minRelevance": 60})
        self.assertEqual(first["page"], 1)
        self.assertEqual(first["cursorVersion"], 2)
        bound = first["filter"]["cursorFilters"]
        self.assertEqual(bound["minRelevance"], 60)
        self.assertIsNone(bound["dateFrom"])
        second = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10, "minRelevance": 60,
                                       "cursor": first["cursor"]})
        self.assertEqual(second["page"], 2)
        self.assertEqual([v["id"] for v in first["videos"]],
                         ["v%02d" % i for i in range(1, 11)])
        self.assertEqual([v["id"] for v in second["videos"]],
                         ["v%02d" % i for i in range(11, 15)])
        self.assertEqual(second["filter"]["filteredByRelevance"], 6,
                         "低相关度的那些仍然进了池子，只是不返回")

    def test_changing_the_relevance_midway_is_refused_before_the_browser(self):
        instance = FakeSidecar(demo_videos())
        first = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10})
        with self.assertRaises(sidecar.SidecarError) as raised:
            run_search(instance, {"keyword": KEYWORD, "maxVideos": 10, "minRelevance": 60,
                                  "cursor": first["cursor"]})
        self.assertEqual(raised.exception.code, "cursor_filter_mismatch")
        self.assertEqual(instance.opened, 1, "条件不一致必须在打开浏览器之前拒绝")

    def test_changing_the_date_range_midway_is_refused(self):
        instance = FakeSidecar(demo_videos())
        first = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10, "dateFrom": "2026-06"})
        with self.assertRaises(sidecar.SidecarError) as raised:
            run_search(instance, {"keyword": KEYWORD, "maxVideos": 10, "dateFrom": "2026-07",
                                  "cursor": first["cursor"]})
        self.assertEqual(raised.exception.code, "cursor_filter_mismatch")
        self.assertEqual(instance.opened, 1)

    def test_the_same_filters_still_continue_the_same_search(self):
        """反向保护：条件没变时不许误判 —— 否则分页功能整体失效。"""
        instance = FakeSidecar(demo_videos())
        first = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10,
                                      "dateFrom": "2026-06", "dateTo": "2026-09"})
        second = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10,
                                       "dateFrom": "2026-06", "dateTo": "2026-09",
                                       "cursor": first["cursor"]})
        self.assertEqual(second["status"], "ok")
        self.assertEqual(second["page"], 2)


    def test_a_cursor_without_an_account_field_is_refused_when_a_scope_is_expected(self):
        """带 account_scope 时必须【证明】游标是本账号的：缺 a 与 a 不符一样拒绝。

        原来写成 `if account_scope and payload.get("a") and ...` —— 缺字段直接放行，
        于是一个不带账号信息的游标可以被任何账号拿去当已见集合。
        """
        payload = {"v": sidecar.CURSOR_VERSION, "k": KEYWORD, "n": 2, "seen": ["1"],
                   "f": sidecar._filter_binding()}
        with self.assertRaises(sidecar.SidecarError) as raised:
            sidecar._decode_cursor(token_of(payload), KEYWORD, SCOPE)
        self.assertEqual(raised.exception.code, "cursor_account_mismatch")
        # 反向保护：调用方自己也没有账号作用域时不额外要求（它没在声称某个账号）。
        self.assertEqual(sidecar._decode_cursor(token_of(payload), KEYWORD, None), ({"1"}, 2))

    def test_a_cursor_with_an_empty_account_field_is_refused(self):
        payload = {"v": sidecar.CURSOR_VERSION, "k": KEYWORD, "n": 2, "seen": ["1"],
                   "a": "", "f": sidecar._filter_binding()}
        with self.assertRaises(sidecar.SidecarError) as raised:
            sidecar._decode_cursor(token_of(payload), KEYWORD, SCOPE)
        self.assertEqual(raised.exception.code, "cursor_account_mismatch")

    def test_malformed_filter_values_in_a_cursor_are_refused_not_raised(self):
        """游标里的 "f" 塞了非数字：按【不一致】拒绝，绝不冒裸 ValueError/TypeError。"""
        bad_values = ({"dateFrom": "abc", "dateTo": None, "minRelevance": 0},
                      {"dateFrom": None, "dateTo": [], "minRelevance": 0},
                      {"dateFrom": None, "dateTo": None, "minRelevance": "abc"},
                      {"dateFrom": [], "dateTo": None, "minRelevance": {}})
        for bad in bad_values:
            payload = {"v": sidecar.CURSOR_VERSION, "k": KEYWORD, "n": 2, "seen": ["1"],
                       "a": SCOPE, "f": bad}
            with self.assertRaises(sidecar.SidecarError) as raised:
                sidecar._decode_cursor(token_of(payload), KEYWORD, SCOPE)
            self.assertEqual(raised.exception.code, "cursor_filter_mismatch", bad)


class SearchParameterHardeningTests(unittest.TestCase):
    """写错/恶意的搜索参数必须给稳定错误码，不能冒裸异常（评审 2026-09-27）。"""

    def test_a_non_numeric_min_relevance_is_invalid_input(self):
        instance = FakeSidecar(demo_videos())
        for bad in ("abc", [], {}, True, "1.5", ["60"]):
            with self.assertRaises(sidecar.SidecarError) as raised:
                run_search(instance, {"keyword": KEYWORD, "minRelevance": bad})
            self.assertEqual(raised.exception.code, "invalid_input", repr(bad))
        self.assertEqual(instance.opened, 0, "参数不合法就不该打开浏览器")

    def test_a_non_numeric_page_size_is_invalid_input(self):
        instance = FakeSidecar(demo_videos())
        for name in ("maxVideos", "scrollRounds"):
            for bad in ("abc", [], {}, True):
                with self.assertRaises(sidecar.SidecarError) as raised:
                    run_search(instance, {"keyword": KEYWORD, name: bad})
                self.assertEqual(raised.exception.code, "invalid_input", "%s=%r" % (name, bad))
        self.assertEqual(instance.opened, 0)

    def test_numeric_strings_are_still_accepted_and_bound_as_integers(self):
        """宿主原样透传字符串是常态：字符串数字要继续能用，并按整数绑定。"""
        instance = FakeSidecar(demo_videos())
        first = run_search(instance, {"keyword": KEYWORD, "maxVideos": "10",
                                      "minRelevance": "60"})
        self.assertEqual(first["filter"]["cursorFilters"]["minRelevance"], 60)
        second = run_search(instance, {"keyword": KEYWORD, "maxVideos": 10,
                                       "minRelevance": 60, "cursor": first["cursor"]})
        self.assertEqual(second["page"], 2, "字符串与整数写法代表同一组条件")
        self.assertEqual(instance.opened, 2)


if __name__ == "__main__":
    unittest.main()
