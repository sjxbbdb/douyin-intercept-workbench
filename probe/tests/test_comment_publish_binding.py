# -*- coding: utf-8 -*-
"""评论发布回执绑定 + 可见性门禁（2026-09-26 评审要求）。

覆盖四条：
  1) _publish_binding：回执必须【结构化地】绑定到本次评论 —— 认 form URL 编码、
     JSON、值里再套一层 JSON、转义中文；优先按评论 id 精确绑定；
  2) send_comment 复用 _visibility_gate：unknown 交人工，不点击、不重试；
  3) 回执映射：唯一绑定且 status_code==0 → 持久态 sent_confirmed（对外仍是 unknown）；
     命中接口但绑定不上 → unknown/platform_response_unbound；
     多条回执分不清归属 → unknown/platform_response_ambiguous —— 都不进私信；
  4) 请求体只在内存里用于绑定：不写台账、不进 evidence、不进日志。
"""
import json
import os
import pathlib
import sys
import tempfile
import unittest
from urllib.parse import quote

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


class StructuredReceiptBindingTests(unittest.TestCase):
    """回执绑定的解析层：三种请求体形状 + id 优先 + 解析不出就不认。"""

    def test_a_form_body_binds_by_the_comment_id(self):
        record = {'postData': 'reply_id=' + COMMENT_ID + '&text=' + quote(TEXT)}
        self.assertEqual(send_actions._publish_binding(record, TEXT, COMMENT_ID),
                         (True, 'comment_id'))

    def test_a_percent_encoded_form_body_binds_by_the_text(self):
        """form URL 编码：中文在请求体里是 %E5%85%B3...，不解析就永远比不上。"""
        record = {'postData': 'text=' + quote(TEXT) + '&reply_id=other'}
        self.assertEqual(send_actions._publish_binding(record, TEXT, COMMENT_ID),
                         (True, 'text'))

    def test_a_json_body_binds_by_the_comment_id(self):
        body = json.dumps({'reply_id': COMMENT_ID, 'text': TEXT}, ensure_ascii=False)
        self.assertEqual(send_actions._publish_binding({'postData': body}, TEXT, COMMENT_ID),
                         (True, 'comment_id'))

    def test_escaped_chinese_in_a_json_body_is_decoded(self):
        """ensure_ascii=True 会把中文转成 \\uXXXX —— 原来按原始串比对必然不命中。"""
        body = json.dumps({'text': TEXT, 'reply_id': 'other'}, ensure_ascii=True)
        self.assertIn('\\u', body)
        self.assertEqual(send_actions._publish_binding({'postData': body}, TEXT, COMMENT_ID),
                         (True, 'text'))

    def test_a_nested_json_value_inside_a_form_body_is_decoded(self):
        body = 'data=' + quote(json.dumps({'content': TEXT}, ensure_ascii=False))
        self.assertEqual(send_actions._publish_binding({'postData': body}, TEXT, COMMENT_ID),
                         (True, 'text'))

    def test_a_numeric_comment_id_in_json_still_binds(self):
        """平台把 id 给成 JSON 数字时不能因为"不是字符串"就丢掉。"""
        body = json.dumps({'reply_id': 7300000000000000001})
        self.assertEqual(
            send_actions._publish_binding({'postData': body}, TEXT, '7300000000000000001'),
            (True, 'comment_id'))

    def test_an_id_field_of_another_comment_is_not_credited(self):
        record = {'postData': 'reply_id=别的评论&text=' + quote(TEXT)}
        self.assertEqual(send_actions._publish_binding(record, TEXT, COMMENT_ID), (True, 'text'))
        other = {'postData': 'reply_id=别的评论&text=别人的正文'}
        self.assertEqual(send_actions._publish_binding(other, TEXT, COMMENT_ID), (False, None))

    def test_a_short_text_is_not_bound_inside_an_unrelated_field(self):
        """短正文（"111"）在原始串里到处都是：只在【正文字段】里判包含。"""
        body = json.dumps({'item_id': '111222', 'count': '1110', 'ts': '111'})
        self.assertEqual(send_actions._publish_binding({'postData': body}, '111', COMMENT_ID),
                         (False, None))
        bound = json.dumps({'content': '111'})
        self.assertEqual(send_actions._publish_binding({'postData': bound}, '111', COMMENT_ID),
                         (True, 'text'))

    def test_a_body_we_cannot_parse_is_not_credited(self):
        """解析不出字段 = 绑定不上：宁可 unknown，也不能"看着像"就算成功。"""
        self.assertEqual(send_actions._publish_binding({'postData': 'x' * 40}, TEXT, COMMENT_ID),
                         (False, None))
        self.assertEqual(send_actions._publish_binding({'postData': ''}, TEXT, COMMENT_ID),
                         (False, None))
        self.assertEqual(send_actions._publish_binding({'postData': 12345}, TEXT, COMMENT_ID),
                         (False, None))

    def test_the_legacy_wrapper_still_answers_yes_or_no(self):
        record = {'postData': 'reply_id=' + COMMENT_ID}
        self.assertTrue(send_actions._publish_record_matches(record, TEXT, COMMENT_ID))
        self.assertFalse(send_actions._publish_record_matches({'postData': 'x'}, TEXT, COMMENT_ID))


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

    def test_an_unreadable_status_stays_unknown(self):
        """绑定上了、接口也回了，但读不出状态码：证据不足 -> unknown，不进私信。"""
        self.records = [{'url': ROOM + '/' + MARK, 'postData': 'reply_id=' + COMMENT_ID,
                         'parsed': {}}]
        result = self._run('receipt-unreadable')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'platform_response_unreadable')
        self.assertEqual(result['evidence']['boundResponses'], 1)

    def test_a_rejected_status_keeps_the_reason_but_stays_unknown(self):
        """平台回了非 0 状态码：原因是确定的 platform_rejected，
        但点击已经发生 —— 持久态仍按 send_gate 的既有规则收口成 unknown
        （started + failed -> unknown），所以它同样进不了私信阶段。"""
        self.records = [{'url': ROOM + '/' + MARK, 'postData': 'reply_id=' + COMMENT_ID,
                         'parsed': {'status_code': 5}}]
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, 'account-a')
            result = send_actions.send_comment(self.tab, gate, 'receipt-rejected',
                                               self.target, TEXT, 'video')
            self.assertEqual(gate.lookup('receipt-rejected')['status'], 'unknown')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'platform_rejected')

    def test_two_bound_receipts_are_ambiguous(self):
        """两条都能绑定：分不清哪一条对应本次点击 -> unknown，绝不挑一条当结论。"""
        self.records = [
            {'url': ROOM + '/' + MARK, 'postData': 'text=' + quote(TEXT),
             'parsed': {'status_code': 0}},
            {'url': ROOM + '/' + MARK, 'postData': 'text=' + quote(TEXT),
             'parsed': {'status_code': 0}},
        ]
        result = self._run('receipt-ambiguous')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'platform_response_ambiguous')
        self.assertEqual(result['evidence']['boundResponses'], 2)
        # 观测照常留在 evidence 里（宿主能看到到底收到了什么），
        # 但【结论】停在 unknown：归属不明就不下结论。
        self.assertEqual(result['evidence']['platformStatusCodes'], [0, 0])

    def test_a_unique_id_binding_is_conclusive(self):
        """按评论 ID 精确绑定的那一条是结论性的：正文绑定的另一条不参与结论。"""
        self.records = [
            {'url': ROOM + '/' + MARK, 'postData': 'reply_id=' + COMMENT_ID,
             'parsed': {'status_code': 0}},
            {'url': ROOM + '/' + MARK, 'postData': 'text=' + quote(TEXT), 'parsed': {}},
        ]
        result = self._run('receipt-id-wins')
        self.assertEqual(result['reason'], 'platform_response')
        self.assertEqual(result['evidence']['boundByCommentId'], 1)
        self.assertEqual(result['evidence']['boundResponses'], 2)

    def test_the_request_body_is_never_persisted(self):
        """请求体只在内存里用于绑定：不写台账、不进 evidence、不写日志文件。"""
        marker = 'NONCE-abc123'
        self.records = [{'url': ROOM + '/' + MARK,
                         'postData': 'reply_id=' + COMMENT_ID + '&signature=' + marker,
                         'parsed': {'status_code': 0}}]
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, 'account-a')
            result = send_actions.send_comment(self.tab, gate, 'receipt-body', self.target,
                                               TEXT, 'video')
            blob = json.dumps(gate.lookup('receipt-body'), ensure_ascii=False)
            for name in os.listdir(td):
                path = os.path.join(td, name)
                if os.path.isfile(path):
                    with open(path, encoding='utf-8', errors='replace') as handle:
                        blob += handle.read()
        self.assertEqual(result['reason'], 'platform_response')
        self.assertNotIn('postData', blob)
        self.assertNotIn(marker, blob, '请求体不得进入任何持久化位置')


if __name__ == '__main__':
    unittest.main()
