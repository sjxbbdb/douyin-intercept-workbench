# -*- coding: utf-8 -*-
"""直播公屏（composer 模式）的发送键：真机是【回车】，按钮只是快路径（2026-09-28）。

真机现象：在直播间里用 composer 模式发公屏消息，工具直接以
`failed/comment_send_button_unavailable` 收场 —— 而同一个房间里
弹幕「回复 TA」路径（走回车）是能发出去的，roomEcho 为证。
原因是 send_comment 的 live 分支要求必须找到发送按钮，找不到就判失败；
真机结论一直是"本通道的发送键是回车"。

这三条用例钉住：
  1) 找不到发送按钮 -> 必须回落到回车，而且【不点击】；
  2) 按钮可用 -> 仍然点按钮（快路径不能被删掉）；
  3) 回落路径下结果仍是 unknown（没有平台响应，不宣称成功）。
"""
import pathlib
import sys
import tempfile
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import send_actions  # noqa: E402
from send_gate import SendGate  # noqa: E402

ROOM = "https://live.douyin.com/42075947470"
TEXT = "关注我"
TARGET = {"id": "e1", "roomId": ROOM, "authorId": "A" * 40, "authorName": "小明"}


class FakeTab:
    def __init__(self):
        self.clicks = []
        self.typed = []
        self.keys = []
        self.calls = []

    def call(self, *args, **kwargs):
        self.calls.append(args)
        return {}

    def evaluate(self, expression):
        if expression == "location.href":
            return ROOM
        if expression == "document.readyState":
            return "complete"
        return None

    def click_at(self, *args):
        self.clicks.append(args)

    def type_text(self, value):
        self.typed.append(value)

    def press_key(self, *args, **kwargs):
        self.keys.append((args, kwargs))


class FakeRecorder:
    def __init__(self, records=None):
        self.records = records or []

    def collect(self, **kwargs):
        return list(self.records)


class LiveComposerSendTests(unittest.TestCase):
    def setUp(self):
        self.saved = (send_actions.douyin.visibility_state, send_actions.douyin.ensure_visible,
                      send_actions.douyin.check_captcha, send_actions.douyin.login_state,
                      send_actions.douyin.make_network_recorder,
                      send_actions.live.find_composer, send_actions.live.find_send_button)
        send_actions.douyin.visibility_state = lambda _tab: "visible"
        send_actions.douyin.ensure_visible = lambda *_a, **_k: True
        send_actions.douyin.check_captcha = lambda _tab: False
        send_actions.douyin.login_state = lambda _tab: "verified"
        send_actions.douyin.make_network_recorder = lambda *_a, **_k: FakeRecorder()
        send_actions.live.find_composer = lambda _tab: {"found": True, "x": 10, "y": 20, "text": TEXT}
        self.tab = FakeTab()
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        (send_actions.douyin.visibility_state, send_actions.douyin.ensure_visible,
         send_actions.douyin.check_captcha, send_actions.douyin.login_state,
         send_actions.douyin.make_network_recorder,
         send_actions.live.find_composer, send_actions.live.find_send_button) = self.saved
        self.tmp.cleanup()

    def _run(self, send_id):
        return send_actions.send_comment(self.tab, SendGate(self.tmp.name, "account-a"), send_id,
                                         TARGET, TEXT, "live")

    def test_a_missing_send_button_falls_back_to_enter(self):
        send_actions.live.find_send_button = lambda _tab: {"found": False}
        result = self._run("live-enter-1")
        self.assertEqual(len(self.tab.keys), 1, "找不到发送按钮时按一次回车")
        self.assertEqual(self.tab.keys[0][0][0], "Enter")
        self.assertEqual(len(self.tab.clicks), 1, "只允许点输入框那一次，不能乱点按钮")
        self.assertEqual(result["status"], "unknown", "没有平台响应就不能宣称成功")
        self.assertEqual(result["evidence"].get("mechanism"), "enter")

    def test_a_disabled_send_button_also_falls_back_to_enter(self):
        send_actions.live.find_send_button = lambda _tab: {"found": True, "disabled": True,
                                                           "x": 5, "y": 6}
        result = self._run("live-enter-2")
        self.assertEqual(len(self.tab.keys), 1)
        self.assertEqual(result["status"], "unknown")

    def test_an_available_send_button_is_still_clicked(self):
        send_actions.live.find_send_button = lambda _tab: {"found": True, "disabled": False,
                                                           "x": 33, "y": 44}
        result = self._run("live-enter-3")
        self.assertEqual(self.tab.keys, [], "按钮可用时不该改走回车")
        self.assertIn((33, 44), self.tab.clicks, "按钮可用时必须点它")
        self.assertEqual(result["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
