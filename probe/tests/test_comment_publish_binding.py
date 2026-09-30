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
    def __init__(self, url=ROOM):
        self.clicks = []
        self.typed = []
        self.calls = []
        self.url = url

    def call(self, *args, **kwargs):
        self.calls.append(args)
        # 更忠实的替身：真的导航过一次之后，location.href 就是新地址
        # （否则"导航后校验目标页"这条永远拿到旧 URL，测不出真实行为）。
        if args and args[0] == 'Page.navigate' and len(args) > 1 and isinstance(args[1], dict):
            self.url = args[1].get('url') or self.url
        return {}

    def evaluate(self, expression):
        if expression == 'location.href':
            return self.url
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

    def test_unrelated_fields_are_not_used_for_binding(self):
        """白名单之外的字段名一律不参与绑定（评审 2026-09-27）。

        原来用子串匹配（"id" in name / "text" in name / "content" in name），
        于是 video_id / aweme_id / user_id / content_type 这类无关字段
        也会被当成"评论 id 字段 / 正文字段"，值碰巧相等就误绑定。
        """
        unrelated = [
            {"video_id": COMMENT_ID},
            {"aweme_id": COMMENT_ID, "item_id": COMMENT_ID},
            {"user_id": COMMENT_ID},
            {"device_id": COMMENT_ID},
            {"content_type": TEXT},
            {"note_text": TEXT},
        ]
        for body in unrelated:
            record = {"postData": json.dumps(body, ensure_ascii=False)}
            self.assertEqual(send_actions._publish_binding(record, TEXT, COMMENT_ID),
                             (False, None), body)

    def test_the_whitelisted_field_names_still_bind(self):
        """反向保护：白名单里的字段名照常绑定（不能因为收紧就整条路径失效）。"""
        id_fields = ("reply_id", "reply_comment_id", "comment_id", "cid",
                     "commentid", "replyid", "reply_cid")
        for name in id_fields:
            record = {"postData": json.dumps({name: COMMENT_ID})}
            self.assertEqual(send_actions._publish_binding(record, TEXT, COMMENT_ID),
                             (True, "comment_id"), name)
        text_fields = ("text", "content", "comment", "reply_text", "replytext",
                       "comment_text", "content_text")
        for name in text_fields:
            record = {"postData": json.dumps({name: TEXT}, ensure_ascii=False)}
            self.assertEqual(send_actions._publish_binding(record, TEXT, COMMENT_ID),
                             (True, "text"), name)

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

    def _run_with_status(self, send_id, raw, index):
        """每次换一个目标：同一个目标出过 unknown 之后，门禁会拦住后续发送
        （target_has_unresolved_send）—— 那是另一条契约，别在本用例里撞上。"""
        target_id = "%s-%d" % (COMMENT_ID, index)
        self.target = {"id": target_id, "roomId": ROOM, "authorId": "author-1"}
        self.records = [{"url": ROOM + "/" + MARK, "postData": "reply_id=" + target_id,
                         "parsed": {"status_code": raw}}]
        return self._run(send_id)

    def test_a_string_status_code_is_accepted(self):
        """平台把状态码给成字符串（"0"）时也必须算确认成功（评审 2026-09-27）。"""
        for index, raw in enumerate(("0", 0, " 0 ", 0.0)):
            result = self._run_with_status("receipt-status-ok-%d" % index, raw, index)
            self.assertEqual(result["reason"], "platform_response", repr(raw))
            self.assertEqual(result["evidence"]["platformStatusCodes"], [0], repr(raw))

    def test_a_string_rejection_is_recorded_as_rejected(self):
        self.records = [{"url": ROOM + "/" + MARK, "postData": "reply_id=" + COMMENT_ID,
                         "parsed": {"status_code": "5"}}]
        result = self._run("receipt-status-5")
        self.assertEqual(result["reason"], "platform_rejected")
        self.assertEqual(result["evidence"]["platformStatusCodes"], [5])

    def test_a_nested_data_status_code_is_accepted(self):
        self.records = [{"url": ROOM + "/" + MARK, "postData": "reply_id=" + COMMENT_ID,
                         "parsed": {"data": {"status_code": "0"}}}]
        result = self._run("receipt-status-nested")
        self.assertEqual(result["reason"], "platform_response")

    def test_a_non_numeric_status_code_is_unreadable(self):
        for index, raw in enumerate(("abc", "", None, True, [], "0.5")):
            result = self._run_with_status("receipt-status-bad-%d" % index, raw, index)
            self.assertEqual(result["reason"], "platform_response_unreadable", repr(raw))
            self.assertEqual(result["evidence"]["platformStatusCodes"], [None], repr(raw))

    def test_an_unknown_page_state_before_the_send_is_refused_too(self):
        """评审 2026-09-28：unknown 不是可恢复状态。

        发送键那一刻读不到可见性 -> 不点、不恢复、交人工（page_visibility_unknown），
        而不是 attempt 恢复后继续点。
        """
        self.states = ["visible"] + ["unknown"] * 4
        send_actions.douyin.ensure_visible = lambda tab, **kw: self.ensure_calls.append(tab) or True
        result = self._run("vis-unknown-late")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "page_visibility_unknown")
        self.assertTrue(result["evidence"]["manualAction"])
        self.assertEqual(self.ensure_calls, [], "unknown 不许拿去恢复")
        self.assertNotIn((5, 6), self.tab.clicks, "读不到状态时不得点发送键")

    def test_a_page_that_hides_before_the_click_is_refused(self):
        """真机结论（2026-09-28）：页面 hidden 时 Input 点击不送达渲染进程，
        发送键点了没反应。必须在【点击之前】拦住，并给出可重试的 page_not_visible，
        而不是让它变成"定位器找不到/发送键不可用"这种误导性的结论。
        """
        self.states = ["visible"] + ["hidden"] * 4
        send_actions.douyin.ensure_visible = lambda tab, **kw: self.ensure_calls.append(tab) or True
        result = self._run("vis-hide-late")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "page_not_visible")
        # 前置的两次点击（回复按钮、输入框）是流程本身，无害；
        # 真正要紧的是【发送键 (5,6)】—— 页面不可见时绝不能点它。
        self.assertNotIn((5, 6), self.tab.clicks, "页面不可见时不得点发送键")

    def test_a_page_that_hides_right_after_the_send_click_is_unknown(self):
        """真机结论的延伸（2026-09-28）：可见性检查 -> 真正点下去之间还有好几次 CDP 往返，
        页面完全可能在这一瞬间被切到后台。点完就不可见时，"可能送达了也可能没有" ——
        必须 unknown，不许猜成 failed（那会允许自动重试，等于重复发一条评论）。
        """
        sent = {"done": False}
        original_click = self.tab.click_at

        def click_at(x, y):
            original_click(x, y)
            if (x, y) == (5, 6):
                sent["done"] = True

        self.tab.click_at = click_at
        send_actions.douyin.visibility_state = lambda _tab: "hidden" if sent["done"] else "visible"
        result = self._run("race-after-click")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason"], "page_hidden_during_send")
        self.assertFalse(result["evidence"]["sendRace"]["visibleAfter"])
        self.assertTrue(result["evidence"]["sendRace"]["clicked"], "点击本身是发出去了的")

    def test_a_transport_failure_on_the_send_click_is_unknown_and_never_retried(self):
        """点击本身抛异常（CDP 传输失败）：也可能已经送达 —— unknown + 台账禁止自动重试。"""
        original_click = self.tab.click_at

        def click_at(x, y):
            if (x, y) == (5, 6):
                raise RuntimeError("simulated click transport failure")
            original_click(x, y)

        self.tab.click_at = click_at
        gate = SendGate(self.tmp.name, "account-a")
        result = send_actions.send_comment(self.tab, gate, "race-transport", self.target, TEXT, "video")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason"], "send_click_transport_failure")
        self.assertEqual(result["evidence"]["sendRace"]["error"], "RuntimeError")
        self.assertEqual(gate.lookup("race-transport")["status"], "unknown")
        again = send_actions.send_comment(self.tab, gate, "race-transport-2", self.target, TEXT, "video")
        self.assertEqual(again["status"], "blocked", "未知结果不得自动重试")

    def test_a_receipt_still_wins_over_the_race(self):
        """有回执就以回执为准：点完页面失焦不该把已经确认成功的回执丢掉。"""
        sent = {"done": False}
        original_click = self.tab.click_at

        def click_at(x, y):
            original_click(x, y)
            if (x, y) == (5, 6):
                sent["done"] = True

        self.tab.click_at = click_at
        send_actions.douyin.visibility_state = lambda _tab: "hidden" if sent["done"] else "visible"
        self.records = [{"url": ROOM + "/" + MARK, "postData": "reply_id=" + COMMENT_ID,
                         "parsed": {"status_code": 0}}]
        result = self._run("race-with-receipt")
        self.assertEqual(result["reason"], "platform_response")
        self.assertEqual(result["evidence"]["platformStatusCodes"], [0])
        self.assertFalse(result["evidence"]["sendRace"]["visibleAfter"])
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


    def test_it_does_not_reload_the_video_page_it_is_already_on(self):
        """真机（2026-09-28）：重新导航会把采集时滚动加载出来的评论列表清空，
        目标行于是再也找不到（reply_target_not_rendered）。已经在目标视频页上时不得重新导航。
        """
        self.records = [{"url": ROOM + "/" + MARK, "postData": "reply_id=" + COMMENT_ID,
                         "parsed": {"status_code": 0}}]
        result = self._run("no-reload")
        self.assertEqual(result["reason"], "platform_response")
        navigations = [c for c in self.tab.calls if c and c[0] == "Page.navigate"]
        self.assertEqual(navigations, [], "已经在目标视频页上时不得重新导航")

    def test_it_still_navigates_when_the_tab_is_somewhere_else(self):
        """反向保护：不在目标页上时必须照旧导航（安全校验不能少）。"""
        self.tab = FakeTab(url="https://www.douyin.com/video/999")
        self.records = [{"url": ROOM + "/" + MARK, "postData": "reply_id=" + COMMENT_ID,
                         "parsed": {"status_code": 0}}]
        result = self._run("needs-navigate")
        self.assertEqual(result["reason"], "platform_response")
        navigations = [c for c in self.tab.calls if c and c[0] == "Page.navigate"]
        self.assertEqual(len(navigations), 1, "不在目标页上必须导航过去")
        self.assertEqual(navigations[0][1], {"url": ROOM})
if __name__ == '__main__':
    unittest.main()
