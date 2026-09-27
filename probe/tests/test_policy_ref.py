# -*- coding: utf-8 -*-
"""服务端签发策略的【身份】冻结与校验（评审收尾项 7）。

背景：策略内容（放行哪些公开状态、条数上限、话术长度……）由授权服务端签发并校验，
本侧只按内置保守默认值执行，也一直拒绝调用方自带的 `policy` 对象。
但"这次执行到底用的是哪一版策略"必须能对上账 —— 所以本侧支持冻结身份：

  * `policyId` / `policyVersion` / `knowledgeSetVersion` 三个字段（或计划回显的
    `policyRef` 对象）一起冻结进计划；
  * 形状不对 -> `invalid_policy_ref`，而且必须在**建批次之前**拒绝（不产生队列副作用）；
  * 计划里记了身份，执行阶段就必须带回来且**完全一致**：
    缺 -> `policy_ref_missing`，不一致 -> `policy_ref_mismatch`；
  * 宿主完全不带身份时保持既有行为（授权端还没接线）。

授权端签发、策略存储与积分扣除都在平台侧，不在本 PR 范围内。
"""
import os
import pathlib
import sys
import tempfile
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import live_flow  # noqa: E402
import sidecar  # noqa: E402

VIDEO = "https://www.douyin.com/video/7501633234145447202"
REF = {"policyId": "dy-intercept", "policyVersion": 3, "knowledgeSetVersion": 7}


class PolicyRefShapeTests(unittest.TestCase):
    """live_flow.normalize_policy_ref 的形状校验（纯函数）。"""

    def test_all_absent_means_no_identity(self):
        for value in (None, "", {}):
            self.assertIsNone(live_flow.normalize_policy_ref(value))

    def test_a_complete_identity_is_normalized(self):
        ref = live_flow.normalize_policy_ref(dict(REF, policyVersion="3"))
        self.assertEqual(ref, REF)
        self.assertIsInstance(ref["policyVersion"], int)

    def test_the_knowledge_set_version_is_optional(self):
        ref = live_flow.normalize_policy_ref({"policyId": "p-1", "policyVersion": 1})
        self.assertEqual(ref, {"policyId": "p-1", "policyVersion": 1,
                               "knowledgeSetVersion": None})

    def test_malformed_identities_are_refused(self):
        bad = [
            ["p-1", 1],                                                  # 不是对象
            {"policyVersion": 3},                                        # 缺 policyId
            {"policyId": "", "policyVersion": 3},                        # 空 id
            {"policyId": "有空格 的 id", "policyVersion": 3},
            {"policyId": "p" * 129, "policyVersion": 1},
            {"policyId": "p-1"},                                         # 缺版本
            {"policyId": "p-1", "policyVersion": 0},
            {"policyId": "p-1", "policyVersion": -1},
            {"policyId": "p-1", "policyVersion": "abc"},
            {"policyId": "p-1", "policyVersion": True},
            {"policyId": "p-1", "policyVersion": 1, "knowledgeSetVersion": 0},
            {"policyId": "p-1", "policyVersion": 1, "allowPublicStates": ["unknown"]},
        ]
        for value in bad:
            with self.assertRaises(live_flow.LiveFlowError) as raised:
                live_flow.normalize_policy_ref(value)
            self.assertEqual(raised.exception.code, "invalid_policy_ref", repr(value))


class _FlowHarness(unittest.TestCase):
    """一个可用的 sidecar（state/profile 都在临时目录里），不打开浏览器。"""

    PORT = 19251

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.instance = sidecar.Sidecar(os.path.join(self.tmp.name, "state"),
                                        os.path.join(self.tmp.name, "profile"), self.PORT)

    def tearDown(self):
        self.tmp.cleanup()

    def _explode(self):
        raise AssertionError("策略身份没通过时不得打开浏览器")

    def _queue_live(self, event_id="e1"):
        self.instance.live_queue.append([
            sidecar._event("live", "https://live.douyin.com/room-1",
                           {"id": event_id, "authorId": "A" * 40, "authorName": "观众甲",
                            "text": "多少钱"})])
        return event_id

    def _plan_live(self, **extra):
        scripts = {event_id: {"publicText": "谢谢支持", "privateText": "私信话术"}
                   for event_id in ["e1"]}
        return self.instance.dispatch("live_plan", dict({
            "maxItems": 5, "windowSeconds": 600, "scripts": scripts}, **extra))


class LivePolicyRefTests(_FlowHarness):
    """直播链路：冻结 + 执行阶段校验。"""

    def test_a_plan_without_an_identity_keeps_the_old_behaviour(self):
        self._queue_live()
        planned = self._plan_live()
        self.assertEqual(planned["status"], "ok")
        self.assertIsNone(planned["policyRef"], "不传身份时保持既有行为")

    def test_the_identity_is_frozen_and_echoed(self):
        self._queue_live()
        planned = self._plan_live(policyId="dy-intercept", policyVersion=3,
                                  knowledgeSetVersion=7)
        self.assertEqual(planned["policyRef"], REF)
        self.assertEqual(self.instance.live_queue.plan(planned["batch"]["batchId"])["policyRef"],
                         REF, "身份必须落在冻结计划里，重启后仍读得到")

    def test_a_malformed_identity_is_refused_before_any_batch_exists(self):
        self._queue_live()
        with self.assertRaises(sidecar.SidecarError) as raised:
            self._plan_live(policyId="dy-intercept")   # 缺版本
        self.assertEqual(raised.exception.code, "invalid_policy_ref")
        self.assertEqual(self.instance.live_queue.stats()["batches"], 0,
                         "身份不合法就不该产生批次")

    def test_the_raw_policy_object_is_still_refused(self):
        self._queue_live()
        with self.assertRaises(sidecar.SidecarError) as raised:
            self._plan_live(policy={"allowPublicStates": ["unknown"]})
        self.assertEqual(raised.exception.code, "policy_not_server_issued")

    def test_a_nested_policy_ref_object_is_accepted(self):
        self._queue_live()
        planned = self._plan_live(policyRef=dict(REF))
        self.assertEqual(planned["policyRef"], REF)

    def test_flat_and_nested_identities_must_agree(self):
        self._queue_live()
        with self.assertRaises(sidecar.SidecarError) as raised:
            self._plan_live(policyRef=dict(REF), policyVersion=9)
        self.assertEqual(raised.exception.code, "invalid_policy_ref")

    def test_the_second_phase_must_echo_the_frozen_identity(self):
        self._queue_live()
        planned = self._plan_live(policyId="dy-intercept", policyVersion=3,
                                  knowledgeSetVersion=7)
        batch_id = planned["batch"]["batchId"]
        self.instance._page = self._explode

        items = [{"eventId": "e1", "sendId": "d-1", "publicSendId": "pub-1"}]
        with self.assertRaises(sidecar.SidecarError) as missing:
            self.instance.dispatch("live_private", {"batchId": batch_id, "items": items})
        self.assertEqual(missing.exception.code, "policy_ref_missing")

        with self.assertRaises(sidecar.SidecarError) as mismatch:
            self.instance.dispatch("live_private", {
                "batchId": batch_id, "items": items,
                "policyId": "dy-intercept", "policyVersion": 4, "knowledgeSetVersion": 7})
        self.assertEqual(mismatch.exception.code, "policy_ref_mismatch")

        # 身份带对了就【不再】被策略门禁拦下：继续走既有的两阶段门禁
        # （这里没有公屏成功记录，所以按 public_not_found 拒绝 —— 那正是既有行为）。
        result = self.instance.dispatch("live_private", {
            "batchId": batch_id, "items": items, "policyRef": dict(REF)})
        self.assertEqual(result["results"][0]["reason"], "public_not_found")


class CommentPolicyRefTests(_FlowHarness):
    """评论区链路：同一套身份冻结与校验。"""

    PORT = 19252

    def setUp(self):
        super().setUp()
        # 不打开浏览器：采集这一步用替身返回一条命中评论。
        self.instance.collect_comments = lambda _params: {
            "status": "ok",
            "targets": [{"id": "c1", "roomId": VIDEO, "authorId": "sec-1",
                         "authorName": "观众甲", "text": "求带", "matchedKeyword": "求带",
                         "digg": 1}],
            "filter": {"collected": 1, "matched": 1, "targetCount": 1}}

    def _plan(self, **extra):
        return self.instance.dispatch("comment_plan", dict({
            "url": VIDEO, "publicText": "你好呀，需要的话我发你", "privateText": "私信话术"},
            **extra))

    def test_the_comment_plan_freezes_the_same_identity(self):
        planned = self._plan(policyId="dy-intercept", policyVersion=3, knowledgeSetVersion=7)
        self.assertEqual(planned["status"], "ok")
        self.assertEqual(planned["policyRef"], REF)

    def test_the_comment_plan_refuses_a_malformed_identity(self):
        with self.assertRaises(sidecar.SidecarError) as raised:
            self._plan(policyId="   ")
        self.assertEqual(raised.exception.code, "invalid_policy_ref")

    def test_the_comment_private_phase_must_echo_the_identity(self):
        planned = self._plan(policyRef=dict(REF))
        batch_id = planned["batch"]["batchId"]
        items = [{"eventId": "c1", "sendId": "d-1", "publicSendId": "pub-1"}]
        with self.assertRaises(sidecar.SidecarError) as raised:
            self.instance.dispatch("comment_private", {"batchId": batch_id, "items": items})
        self.assertEqual(raised.exception.code, "policy_ref_missing")
        with self.assertRaises(sidecar.SidecarError) as raised:
            self.instance.dispatch("comment_private", {
                "batchId": batch_id, "items": items,
                "policyId": "other-policy", "policyVersion": 3})
        self.assertEqual(raised.exception.code, "policy_ref_mismatch")

    def test_the_comment_reply_phase_must_echo_the_identity(self):
        planned = self._plan(policyRef=dict(REF))
        batch_id = planned["batch"]["batchId"]
        items = [{"eventId": "c1", "sendId": "d-1"}]
        with self.assertRaises(sidecar.SidecarError) as raised:
            self.instance.dispatch("comment_reply", {"batchId": batch_id, "items": items})
        self.assertEqual(raised.exception.code, "policy_ref_missing")


if __name__ == "__main__":
    unittest.main()
