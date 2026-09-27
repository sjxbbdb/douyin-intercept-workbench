# -*- coding: utf-8 -*-
"""直播监听的恢复语义（评审收尾项 6）。

监听是持续动作：宿主会重启、会换房间、平台会重发旧事件、批次会超窗。
这一组用例把"重启之后不会重复处理旧事件、也不会把未知结果自动重试"钉住，
全部离线（不碰浏览器）：队列、批次窗口与 checkpoint 都在 live_flow 里。

覆盖六条：
  1) 重启后队列还在，未冻结的批次【复用】而不是另起一个；
  2) 重启后平台重发同一条事件 -> 计成 duplicate，不会变成新事件；
  3) 已经出过结果（sent_confirmed / unknown）的事件不会回到队列；
  4) unknown 的公屏结果永远不进私信候选（红线：未知不得自动重试）；
  5) 换房间：事件各自绑自己的房间，同一个人在另一个房间说同一句话不算同一条；
  6) 批次超窗：重启后 ensure_active 报 batch_expired，计划中的事件作废、不会重发。
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

SCOPE = "account-a"
AUTHOR = "A" * 40
SCRIPTS_TEXT = {"publicText": "谢谢支持", "privateText": "私信话术"}


class LiveRecoveryTests(unittest.TestCase):
    """LiveQueue 在重启 / 换房间 / 超窗下的行为。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = [1000.0]
        self.queue = self._open()

    def tearDown(self):
        self.tmp.cleanup()

    def _open(self):
        """打开同一个 state-dir（宿主重启 = 新进程打开它，时钟继续往前走）。"""
        return live_flow.LiveQueue(self.tmp.name, SCOPE, clock=lambda: self.now[0])

    @staticmethod
    def _event(event_id, room="room-1", author=AUTHOR, text="多少钱"):
        return {"id": event_id, "source": "live", "roomId": room, "authorId": author,
                "authorName": "观众", "text": text}

    @staticmethod
    def _scripts(batch):
        return {event["id"]: dict(SCRIPTS_TEXT) for event in batch["events"]}

    def test_a_restart_keeps_the_queue_and_reuses_the_open_batch(self):
        self.queue.append([self._event("e1"), self._event("e2", author="B" * 40)])
        first = self.queue.take_batch(max_items=5, window_seconds=600)
        self.assertEqual(len(first["events"]), 2)

        restarted = self._open()
        self.assertEqual(restarted.stats()["states"].get(live_flow.PLANNED), 2)
        again = restarted.take_batch(max_items=5, window_seconds=600)
        self.assertEqual(again["batchId"], first["batchId"],
                         "未冻结的批次必须复用，否则重启会凭空多出一个批次")
        self.assertEqual([event["id"] for event in again["events"]], ["e1", "e2"])

    def test_replaying_the_same_event_after_a_restart_is_a_duplicate(self):
        self.queue.append([self._event("e1")])
        restarted = self._open()
        report = restarted.append([self._event("e1")])
        self.assertEqual((report["added"], report["duplicates"]), (0, 1))
        self.assertEqual(restarted.stats()["states"].get(live_flow.QUEUED), 1)

    def test_an_event_with_a_result_is_never_requeued(self):
        """已经出过结果的事件：平台重发也不能让它回到队列（否则会重复触达）。"""
        self.queue.append([self._event("e1"), self._event("e2", author="B" * 40)])
        batch = self.queue.take_batch(max_items=5, window_seconds=600)
        self.queue.freeze_plan(batch["batchId"], self._scripts(batch))
        self.queue.mark("e1", live_flow.SENT_CONFIRMED, batch["batchId"], {"sendId": "pub-1"})

        restarted = self._open()
        restarted.append([self._event("e1")])
        states = restarted.stats()["states"]
        self.assertEqual(states.get(live_flow.SENT_CONFIRMED), 1)
        self.assertEqual(states.get(live_flow.QUEUED, 0), 0)
        later = restarted.take_batch(max_items=5, window_seconds=1)
        self.assertEqual(later["events"], [], "有结果的旧事件不得再进批次")

    def test_an_unknown_public_result_never_becomes_a_private_candidate(self):
        self.queue.append([self._event("e1"), self._event("e2", author="B" * 40)])
        batch = self.queue.take_batch(max_items=5, window_seconds=600)
        self.queue.freeze_plan(batch["batchId"], self._scripts(batch))
        self.queue.mark("e1", live_flow.UNKNOWN, batch["batchId"], {"sendId": "pub-1"})
        self.queue.mark("e2", live_flow.SENT_CONFIRMED, batch["batchId"], {"sendId": "pub-2"})

        restarted = self._open()
        allowed, rejected = restarted.private_candidates(batch["batchId"])
        self.assertEqual([item["eventId"] for item in allowed], ["e2"])
        self.assertEqual(rejected, [{"eventId": "e1", "reason": "public_unknown"}])
        # 未知结果不会被"再听一轮"洗掉：重发同一条事件仍然停在 unknown。
        restarted.append([self._event("e1", author=AUTHOR)])
        self.assertEqual(restarted.stats()["states"].get(live_flow.UNKNOWN), 1)
        self.assertEqual(restarted.stats()["states"].get(live_flow.QUEUED, 0), 0)

    def test_a_room_switch_keeps_each_event_bound_to_its_own_room(self):
        self.queue.append([self._event("a1", room="live-a"), self._event("b1", room="live-b")])
        batch = self.queue.take_batch(max_items=5, window_seconds=600)
        plan = self.queue.freeze_plan(batch["batchId"], self._scripts(batch))
        rooms = {item["eventId"]: item["roomId"] for item in plan["targets"]}
        self.assertEqual(rooms, {"a1": "live-a", "b1": "live-b"})

        restarted = self._open()
        restored = {item["eventId"]: item["roomId"]
                    for item in restarted.plan(batch["batchId"])["targets"]}
        self.assertEqual(restored, rooms, "重启后每个目标仍然绑自己的房间")

    def test_the_same_person_and_text_in_another_room_is_not_the_same_event(self):
        first = self.queue.append([self._event("x", room="live-a", text="多少钱")])
        second = self.queue.append([self._event("y", room="live-b", text="多少钱")])
        self.assertEqual((first["added"], second["added"]), (1, 1))
        self.assertEqual(self.queue.stats()["states"].get(live_flow.QUEUED), 2)

    def test_an_expired_batch_cannot_be_executed_after_a_restart(self):
        self.queue.append([self._event("e1")])
        batch = self.queue.take_batch(max_items=5, window_seconds=60)
        self.now[0] += 61
        restarted = self._open()
        with self.assertRaises(live_flow.LiveFlowError) as raised:
            restarted.ensure_active(batch["batchId"])
        self.assertEqual(raised.exception.code, "batch_expired")
        self.assertEqual(restarted.stats()["states"].get(live_flow.EXPIRED), 1,
                         "超窗批次里计划中的事件必须作废，不能留到重启后再发")
        following = restarted.take_batch(max_items=5, window_seconds=60)
        self.assertEqual(following["events"], [])

    def test_the_checkpoint_survives_a_restart(self):
        self.queue.append([self._event("e1"), self._event("e2", author="B" * 40)])
        batch = self.queue.take_batch(max_items=5, window_seconds=600)
        plan = self.queue.freeze_plan(batch["batchId"], self._scripts(batch))
        self.queue.mark("e1", live_flow.SENT_CONFIRMED, batch["batchId"], {"sendId": "pub-1"})

        restarted = self._open()
        report = restarted.result(batch["batchId"])
        self.assertEqual(report["batchId"], batch["batchId"])
        self.assertEqual(report["status"], "frozen")
        self.assertEqual(report["checkpoint"]["phase"], "public")
        self.assertEqual(report["checkpoint"]["pendingEvents"], ["e2"])
        self.assertEqual(report["checkpoint"]["planTargets"], 2)
        self.assertEqual(report["checkpoint"]["frozenAt"], plan["frozenAt"])
        self.assertEqual(report["privateCandidates"], 1)
        # 还没出结果的公屏回复按状态给出稳定原因：planned -> public_planned
        self.assertEqual(report["privateRejected"],
                         [{"eventId": "e2", "reason": "public_planned"}])


class LiveRestartThroughSidecarTests(unittest.TestCase):
    """同一件事从 sidecar 入口再看一遍：重启后拿到的是同一个队列与同一个批次。"""

    def test_a_restarted_sidecar_sees_the_same_queue_and_batch(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            state = os.path.join(td, "state")
            profile = os.path.join(td, "profile")
            first = sidecar.Sidecar(state, profile, 19241)
            first.live_queue.append([
                sidecar._event("live", "https://live.douyin.com/room-1",
                               {"id": "e1", "authorId": AUTHOR, "authorName": "观众甲",
                                "text": "多少钱"})])
            planned = first.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600,
                "scripts": {"e1": dict(SCRIPTS_TEXT)}})
            batch_id = planned["batch"]["batchId"]

            second = sidecar.Sidecar(state, profile, 19241)
            report = second.dispatch("live_result", {"batchId": batch_id})
            self.assertEqual(report["batchId"], batch_id)
            self.assertEqual(report["queue"]["states"].get(live_flow.PLANNED), 1)
            self.assertEqual(report["checkpoint"]["pendingEvents"], ["e1"])
            self.assertEqual(report["checkpoint"]["planTargets"], 1)
            # 重放同一批事件：只是 duplicate，不会变成第二个可发送的批次
            replay = second.dispatch.__self__.live_queue.append([
                sidecar._event("live", "https://live.douyin.com/room-1",
                               {"id": "e1", "authorId": AUTHOR, "authorName": "观众甲",
                                "text": "多少钱"})])
            self.assertEqual((replay["added"], replay["duplicates"]), (0, 1))


if __name__ == "__main__":
    unittest.main()
