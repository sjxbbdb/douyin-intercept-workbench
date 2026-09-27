# -*- coding: utf-8 -*-
"""评论发布回执绑定 + 可见性门禁（2026-09-26 评审要求）。

覆盖三条：
  1) _publish_record_matches：回执必须绑定到本次评论的正文或评论 id；
  2) send_comment 复用 _visibility_gate：unknown 交人工，不点击、不重试；
  3) 回执映射：绑定且 status_code==0 → 持久态 sent_confirmed（对外仍是 unknown）；
     命中接口但绑定不上 → unknown/platform_response_unbound，禁止进入私信。
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

ROOM = 'https://www.douyin.com/video/123'
MARK = 'comment/publish'
TEXT = '关注我'
COMMENT_ID = 'comment-1'


class FakeTab:
    def __init__(self):
        self.clicks = []
        self.typed = []
        self.calls = []

    def call(self, *args, **kwargs):
        self.calls.append(args)
        return {}

    def evaluate(self, expression):
        if expression == 'location.href':
            return ROOM
        if expression == 'document.readyState':
            return 'complete'
        return None

    def click_at(self, x, y):
        self.clicks.append((x, y))

    def type_text(self, value):
        self.typed.append(value)


class FakeRecorder:
    def __init__(self, records):
        self.records = records

    def collect(self, **kwargs):
        return list(self.records)


class PublishRecordBindingTests(unittest.TestCase):
    """回执绑定判定本身（纯函数）。"""

    def test_bound_by_reply_text(self):
        record = {'postData': 'text=' + TEXT + '&reply_id=9'}
        self.assertTrue(send_actions._publish_record_matches(record, TEXT, COMMENT_ID))

    def test_bound_by_comment_id(self):
        record = {'postData': 'reply_id=' + COMMENT_ID}
        self.assertTrue(send_actions._publish_record_matches(record, TEXT, COMMENT_ID))

    def test_unbound_without_request_body(self):
        self.assertFalse(send_actions._publish_record_matches({}, TEXT, COMMENT_ID))
        self.assertFalse(send_actions._publish_record_matches(None, TEXT, COMMENT_ID))

    def test_unbound_when_body_is_another_comment(self):
        record = {'postData': 'text=别人的回复&reply_id=other'}
        self.assertFalse(send_actions._publish_record_matches(record, TEXT, COMMENT_ID))


class SendCommentReceiptTests(unittest.TestCase):
    """send_comment 的可见性门禁与回执映射。"""

    def setUp(self):
        self._saved = (send_actions.douyin.visibility_state, send_actions.douyin.ensure_visible,
                       send_actions.douyin.check_captcha, send_actions.douyin.login_state,
                       send_actions.douyin.comment_reply_button,
                       send_actions.douyin.comment_reply_composer,
                       send_actions.douyin.comment_reply_send_button,
                       send_actions.douyin.make_network_recorder)
        self.states = []
        self.ensure_calls = []
        self.records = []
        self.tab = FakeTab()
        self.tmp = tempfile.TemporaryDirectory()
        self.target = {'id': COMMENT_ID, 'roomId': ROOM, 'authorId': 'author-1'}

        def _state(_tab):
            return self.states.pop(0) if self.states else 'visible'

        send_actions.douyin.visibility_state = _state
        send_actions.douyin.ensure_visible = lambda tab, **kw: self.ensure_calls.append(tab) or True
        send_actions.douyin.check_captcha = lambda _tab: False
        send_actions.douyin.login_state = lambda _tab: 'verified'
        send_actions.douyin.comment_reply_button = lambda _tab, _t: {'found': True, 'x': 1, 'y': 2}
        send_actions.douyin.comment_reply_composer = lambda _tab, _t: {
            'found': True, 'x': 3, 'y': 4, 'text': TEXT}
        send_actions.douyin.comment_reply_send_button = lambda _tab, _t: {'found': True, 'x': 5, 'y': 6}
        send_actions.douyin.make_network_recorder = lambda *args, **kwargs: FakeRecorder(self.records)

    def tearDown(self):
        (send_actions.douyin.visibility_state, send_actions.douyin.ensure_visible,
         send_actions.douyin.check_captcha, send_actions.douyin.login_state,
         send_actions.douyin.comment_reply_button,
         send_actions.douyin.comment_reply_composer,
         send_actions.douyin.comment_reply_send_button,
         send_actions.douyin.make_network_recorder) = self._saved
        self.tmp.cleanup()

    def _run(self, send_id):
        gate = SendGate(self.tmp.name, 'account-a')
        return send_actions.send_comment(self.tab, gate, send_id, self.target, TEXT, 'video')

    def test_unknown_visibility_blocks_without_clicking(self):
        """unknown 不等于 hidden：交人工，不许点、不许重试。"""
        self.states = ['unknown']
        result = self._run('vis-unknown')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['reason'], 'page_visibility_unknown')
        self.assertEqual(self.tab.clicks, [], 'unknown 时不得点击')
        self.assertEqual(self.ensure_calls, [], 'unknown 不当作 hidden 去置前')

    def test_hidden_but_cannot_recover_is_blocked(self):
        self.states = ['hidden', 'hidden']
        result = self._run('vis-hidden')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['reason'], 'browser_not_visible')
        self.assertEqual(self.tab.clicks, [])

    def test_bound_receipt_records_platform_response(self):
        """绑定到本次正文的回执 → 持久态 sent_confirmed（对外 unknown + platform_response_recorded）。"""
        self.records = [{'url': ROOM + '/' + MARK, 'postData': 'text=' + TEXT,
                         'parsed': {'status_code': 0}}]
        result = self._run('receipt-bound')
        # 对外仍是 unknown（send_gate.result 会把 sent_confirmed 收口成 unknown），
        # 但 reason 指向「已记录平台响应」，证据里能看到绑定了 1 条回执且状态码为 0。
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'platform_response')
        self.assertEqual(result['evidence']['boundResponses'], 1)
        self.assertEqual(result['evidence']['platformStatusCodes'], [0])

    def test_unbound_receipt_stays_unknown(self):
        """命中发布接口但绑定不上（没有请求体）→ unknown，禁止进入私信。"""
        self.records = [{'url': ROOM + '/' + MARK, 'parsed': {'status_code': 0}}]
        result = self._run('receipt-unbound')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'platform_response_unbound')
        self.assertEqual(result['evidence']['boundResponses'], 0)

    def test_no_receipt_at_all_stays_unknown(self):
        self.records = []
        result = self._run('receipt-none')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'platform_response_unavailable')


if __name__ == '__main__':
    unittest.main()
