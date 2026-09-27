# -*- coding: utf-8 -*-
"""协议文档必须与实现一致（评审收尾项：文档和质量收尾）。

三件事钉住，任何一条漂移都会让这个文件失败：

  1) `docs/sidecar-protocol.md` 的**方法表**必须等于 `capabilities()` 实际暴露的方法集合 ——
     文档此前只列了 10 个方法，`search_pool` / `comment_*` / `live_*` 全都没有；
  2) 文档里的**能力示例取值**（`implemented` / `autoEligible`）必须等于代码里的真实取值 ——
     `private_reply` 曾被写成 `autoEligible: true`，那是错的；
  3) `capabilities` 返回的每一项都必须带 `implemented` / `autoEligible` / `validation`，
     且**发送类能力一律 `autoEligible: false`**。

这些都只读本地文件与纯函数，不需要浏览器。
"""
import inspect
import json
import os
import pathlib
import re
import sys
import tempfile
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
ROOT = PROBE.parent
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import cdp  # noqa: E402
import douyin  # noqa: E402
import sidecar  # noqa: E402

DOC = ROOT / "docs" / "sidecar-protocol.md"
# 发送类 / 发送闸门类能力：拿不到真实平台送达证据之前必须保持 fail-closed。
SEND_CAPABILITIES = ("private_reply", "video_reply", "live_reply", "live_danmaku_reply",
                     "live_private_reply", "comment_batch", "live_batch", "comment_flow",
                     "comment_private_candidates")
REQUIRED_KEYS = ("implemented", "autoEligible", "validation")


def documented_methods(text):
    """方法表里第一列是被反引号包住的方法名的那些行。"""
    return set(re.findall(r"^\| \`([a-z_]+)\` \|", text, re.MULTILINE))


def documented_capabilities(text):
    """能力和发行开关那一节里，第一个 json 代码块中的 capability 示例。"""
    tail = text.split("## 能力和发行开关", 1)[1]
    block = re.search(r"\`\`\`json\n(.*?)\`\`\`", tail, re.DOTALL).group(1)
    return json.loads(block)["result"]["capability"]


class ProtocolDocContractTests(unittest.TestCase):
    """文档与实现的一致性。"""

    @classmethod
    def setUpClass(cls):
        cls.text = DOC.read_text(encoding="utf-8")
        # capabilities 会带上本地限额（self.gate.limits），所以要用一个真实实例；
        # 这里只在临时目录里建实例，不打开浏览器。
        cls.tmp = tempfile.TemporaryDirectory()
        cls.instance = sidecar.Sidecar(os.path.join(cls.tmp.name, "state"),
                                       os.path.join(cls.tmp.name, "profile"), 19261)
        cls.caps = cls.instance.dispatch("capabilities", {})

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_document_exists(self):
        self.assertTrue(DOC.is_file(), "协议文档不见了：%s" % DOC)

    def test_the_method_table_matches_capabilities(self):
        documented = documented_methods(self.text)
        actual = set(self.caps["methods"])
        self.assertEqual(documented - actual, set(),
                         "文档里写了实现里没有的方法（会误导主进程去调用）")
        self.assertEqual(actual - documented, set(),
                         "实现里有文档没写的方法（评审要求补齐 search_pool / comment_* / live_*）")

    def test_the_capability_example_matches_the_real_values(self):
        documented = documented_capabilities(self.text)
        actual = self.caps["capability"]
        self.assertTrue(documented, "能力示例不能是空的")
        for name, value in sorted(documented.items()):
            self.assertIn(name, actual, "文档示例里的能力在实现里不存在：%s" % name)
            for key in ("implemented", "autoEligible"):
                self.assertEqual(value[key], actual[name][key],
                                 "文档与实现不一致：%s.%s" % (name, key))

    def test_the_private_reply_example_is_not_auto_eligible(self):
        """评审点名的错误示例：私信的 autoEligible 必须是 false。"""
        documented = documented_capabilities(self.text)
        self.assertFalse(documented["private_reply"]["autoEligible"])
        self.assertFalse(self.caps["capability"]["private_reply"]["autoEligible"])

    def test_every_capability_carries_the_three_keys(self):
        for name, value in sorted(self.caps["capability"].items()):
            for key in REQUIRED_KEYS:
                self.assertIn(key, value, "%s 缺少 %s" % (name, key))

    def test_send_capabilities_stay_fail_closed(self):
        actual = self.caps["capability"]
        for name in SEND_CAPABILITIES:
            self.assertIn(name, actual)
            self.assertFalse(actual[name]["autoEligible"],
                             "%s 必须保持 autoEligible=false（未拿到真实送达证据）" % name)


class CommentBodyGuardTests(unittest.TestCase):
    """评论正文提取：统计/操作行的排除只写一遍（评审要求删掉重复判断）。"""

    def test_the_stats_subtree_guard_appears_exactly_once(self):
        js = douyin._row_helpers_js()
        self.assertEqual(js.count("stats.contains(e)"), 1,
                         "同一个判定写两遍只会让人以为有两道不同的闸")

    def test_the_guards_that_the_review_asked_for_are_still_there(self):
        """删重复不等于删判断：统计行与「更多」菜单两道闸都必须还在。"""
        js = douyin._row_helpers_js()
        self.assertIn('querySelector(\'[class*="stats"]\')', js)
        self.assertIn('video-comment-more', js)


class PostDataBoundaryTests(unittest.TestCase):
    """请求体只在内存中用于绑定：默认不留、只有发布回执那条路径显式开启。"""

    class _Events:
        def __init__(self):
            self.handlers = {}

        def on(self, name, callback):
            self.handlers[name] = callback

        def emit(self, name, value):
            self.handlers[name](value)

    @staticmethod
    def _emit_request(events):
        events.emit("Network.requestWillBeSent", {
            "requestId": "1",
            "request": {"url": "https://www.douyin.com/aweme/v1/web/comment/publish/",
                        "method": "POST", "postData": "text=求带&reply_id=1"}})

    def test_the_recorder_default_is_not_to_retain_the_body(self):
        params = inspect.signature(cdp.NetworkRecorder.__init__).parameters
        self.assertIs(params["capture_post_data"].default, False)
        events = self._Events()
        recorder = douyin.make_network_recorder(events, lambda url: "comment/publish" in url)
        self._emit_request(events)
        self.assertNotIn("postData", recorder.pending["1"])

    def test_the_comment_publish_path_opts_in_explicitly(self):
        events = self._Events()
        recorder = douyin.make_network_recorder(events, lambda url: "comment/publish" in url,
                                                capture_post_data=True)
        self._emit_request(events)
        self.assertIn("postData", recorder.pending["1"],
                      "回执绑定需要请求体，但只在这一条路径上按需留档")


if __name__ == "__main__":
    unittest.main()
