# -*- coding: utf-8 -*-
"""授权端下发的策略文件：校验 + 只对直播公屏"页面回声"这一条放行（2026-09-28）。

背景：直播公屏走 WebSocket，真机抓包实证**没有平台回执**（整段只有埋点请求），
所以台账状态只能是 unknown、队列里最多记到 sent_echoed —— "只有 sent_confirmed 才允许私信"
这条默认口径会让直播私信永远走不到。要打通只能由平台侧显式下发一条放行 sent_echoed 的策略。

这里钉住四件事：
  1) 策略文件的形状/完整性/有效期校验（任何一条不过都 fail-closed）；
  2) 没配置策略文件时行为与今天完全一致（内置保守默认值）；
  3) 只有【策略里显式列了该状态】+【sendId 精确绑定本事件】才放行；
  4) 放行记录里带得上策略身份与哈希，事后可审计。
"""
import json
import os
import pathlib
import sys
import tempfile
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import policy_file  # noqa: E402
import sidecar  # noqa: E402


def make_policy(**overrides):
    payload = {"policyId": "dy-intercept", "policyVersion": 3, "knowledgeSetVersion": 7,
               "allowPublicStates": ["sent_confirmed", "sent_echoed"],
               "maxPrivate": 20, "minTextLength": 2, "maxTextLength": 500}
    payload.update(overrides)
    payload["policySha256"] = policy_file.digest(payload)
    return payload


class PolicyFileTests(unittest.TestCase):
    def _write(self, payload, td, name="policy.json"):
        path = os.path.join(td, name)
        with open(path, "w", encoding="utf-8") as handle:
            if isinstance(payload, str):
                handle.write(payload)
            else:
                json.dump(payload, handle, ensure_ascii=False)
        return path

    def test_no_path_means_no_policy(self):
        self.assertIsNone(policy_file.load(None))
        self.assertIsNone(policy_file.load(""))

    def test_a_valid_file_yields_content_identity_and_hash(self):
        with tempfile.TemporaryDirectory() as td:
            path = self._write(make_policy(), td)
            loaded = policy_file.load(path)
        self.assertEqual(loaded["identity"], {"policyId": "dy-intercept", "policyVersion": 3,
                                              "knowledgeSetVersion": 7})
        self.assertIn("sent_echoed", loaded["content"]["allowPublicStates"])
        self.assertEqual(loaded["sha256"], policy_file.digest(make_policy()))

    def test_a_missing_file_is_refused(self):
        with self.assertRaises(policy_file.PolicyFileError) as raised:
            policy_file.load(os.path.join(tempfile.gettempdir(), "no-such-policy.json"))
        self.assertEqual(raised.exception.code, "policy_file_missing")

    def test_invalid_shapes_are_refused(self):
        cases = [("{not json", "policy_file_invalid"),
                 (json.dumps([1, 2, 3]), "policy_file_invalid"),
                 (json.dumps({"policyId": "p"}), "policy_file_invalid"),
                 (json.dumps(make_policy(allowPublicStates=[])), "policy_file_invalid"),
                 (json.dumps(make_policy(allowPublicStates="sent_echoed")),
                  "policy_file_invalid"),
                 (json.dumps(make_policy(expiresAt="soon")), "policy_file_invalid")]
        for body, code in cases:
            with tempfile.TemporaryDirectory() as td:
                path = self._write(body, td)
                with self.assertRaises(policy_file.PolicyFileError) as raised:
                    policy_file.load(path)
            self.assertEqual(raised.exception.code, code, body[:60])

    def test_a_tampered_policy_is_refused(self):
        """改一个字节就要被发现：否则"随手改 JSON 放开红线"就成立了。"""
        payload = make_policy()
        payload["allowPublicStates"] = ["sent_confirmed", "sent_echoed", "failed"]
        with tempfile.TemporaryDirectory() as td:
            path = self._write(payload, td)
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                policy_file.load(path)
        self.assertEqual(raised.exception.code, "policy_integrity_failed")

    def test_an_expired_policy_is_refused(self):
        payload = make_policy(expiresAt=1000)
        with tempfile.TemporaryDirectory() as td:
            path = self._write(payload, td)
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                policy_file.load(path, now=2000)
        self.assertEqual(raised.exception.code, "policy_expired")


class SidecarPolicyWiringTests(unittest.TestCase):
    def _instance(self, td, policy_path=None):
        return sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19291,
                               policy_path=policy_path)

    def _event(self, recorded_state, send_id, via_state_column=False):
        """公开状态的两处写法都要认：评论区批次在 detail.recordedState，直播批次在 state 列。"""
        if via_state_column:
            return {"state": recorded_state, "detail": {"sendId": send_id}}
        return {"detail": {"recordedState": recorded_state, "sendId": send_id}}

    def test_the_live_state_column_is_recognised_too(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "policy.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(make_policy(), handle, ensure_ascii=False)
            instance = self._instance(td, policy_path=path)
            allowed = sidecar._policy_public_echo(
                instance._server_policy(), self._event("sent_echoed", "s1", via_state_column=True), "s1")
        self.assertEqual(allowed["recordedState"], "sent_echoed")

    def test_without_a_policy_file_nothing_changes(self):
        with tempfile.TemporaryDirectory() as td:
            instance = self._instance(td)
            self.assertIsNone(instance._server_policy())
            self.assertIsNone(sidecar._policy_public_echo(
                instance._server_policy(), self._event("sent_echoed", "s1"), "s1"))

    def test_a_broken_policy_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "policy.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"policyId": "p"}, handle)
            instance = self._instance(td, policy_path=path)
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance._server_policy()
        self.assertEqual(raised.exception.code, "policy_file_invalid")

    def test_a_server_policy_can_allow_the_page_echo_for_the_bound_event(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "policy.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(make_policy(), handle, ensure_ascii=False)
            instance = self._instance(td, policy_path=path)
            allowed = sidecar._policy_public_echo(
                instance._server_policy(), self._event("sent_echoed", "s1"), "s1")
        self.assertEqual(allowed["policySource"], "server_file")
        self.assertEqual(allowed["recordedState"], "sent_echoed")
        self.assertEqual(allowed["policyId"], "dy-intercept")
        self.assertEqual(allowed["policySha256"], policy_file.digest(make_policy()))

    def test_a_server_policy_never_allows_a_different_send_or_state(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "policy.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(make_policy(), handle, ensure_ascii=False)
            instance = self._instance(td, policy_path=path)
            server = instance._server_policy()
            # sendId 对不上
            self.assertIsNone(sidecar._policy_public_echo(
                server, self._event("sent_echoed", "other"), "s1"))
            # 状态不在策略里
            self.assertIsNone(sidecar._policy_public_echo(
                server, self._event("failed", "s1"), "s1"))
            # 没有记录
            self.assertIsNone(sidecar._policy_public_echo(server, {}, "s1"))
            # sent_confirmed 走原来的口径，不需要这条放行
            self.assertIsNone(sidecar._policy_public_echo(
                server, self._event("sent_confirmed", "s1"), "s1"))

    def test_the_frozen_plan_records_the_server_policy_source(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "policy.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(make_policy(), handle, ensure_ascii=False)
            instance = self._instance(td, policy_path=path)
            instance.live_queue.append([sidecar._event("live", "room-1", {
                "id": "e1", "authorId": "A" * 40, "authorName": "小明", "text": "问一下"})])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600,
                "scripts": {"e1": {"publicText": "关注我", "privateText": "你好"}}})
            self.assertEqual(planned["policySource"], "server_file")
            self.assertIn("sent_echoed", planned["policy"]["allowPublicStates"])

    def test_without_a_policy_file_the_plan_keeps_the_conservative_default(self):
        with tempfile.TemporaryDirectory() as td:
            instance = self._instance(td)
            instance.live_queue.append([sidecar._event("live", "room-1", {
                "id": "e1", "authorId": "A" * 40, "authorName": "小明", "text": "问一下"})])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600,
                "scripts": {"e1": {"publicText": "关注我", "privateText": "你好"}}})
            self.assertEqual(planned["policySource"], "builtin_default")
            self.assertEqual(planned["policy"]["allowPublicStates"], ["sent_confirmed"])


if __name__ == "__main__":
    unittest.main()
