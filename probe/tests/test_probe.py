import json
import multiprocessing
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import types
import unittest


PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import cdp  # noqa: E402
import dm  # noqa: E402
import douyin  # noqa: E402
import probe as cli  # noqa: E402
from send_gate import SendGate  # noqa: E402
from url_policy import URLPolicyError, safe_url  # noqa: E402


class Events:
    def __init__(self):
        self.handlers = {}

    def on(self, name, callback):
        self.handlers[name] = callback

    def emit(self, name, value):
        self.handlers[name](value)


def _reserve_worker(path, barrier, result_queue):
    gate = SendGate(path, "account-a")
    barrier.wait()
    result_queue.put(gate.reserve("send-%s" % os.getpid(), "same-target", "hello")["kind"])


class SendGateTests(unittest.TestCase):
    def test_recorder_callable_and_payload_redaction(self):
        events = Events()
        recorder = douyin.make_network_recorder(events, lambda url: "/send" in url)
        events.emit("Network.requestWillBeSent", {
            "requestId": "1", "request": {"url": "https://www.douyin.com/send", "method": "POST",
                                               "postData": "private message must not be retained"}})
        self.assertIn("1", recorder.pending)
        self.assertNotIn("postData", recorder.pending["1"])

    def test_restart_unknown_and_same_target_block(self):
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, "account-a")
            gate.reserve("s1", "target", "hello")
            gate.mark_started("s1")
            gate.finish("s1", "unknown", "parent_cancelled")
            restarted = SendGate(td, "account-a")
            self.assertEqual(restarted.reserve("s1", "target", "hello")["kind"], "existing")
            self.assertEqual(restarted.result(restarted.reserve("s1", "target", "hello")["row"])["status"], "unknown")
            self.assertEqual(restarted.reserve("s2", "target", "hello")["kind"], "blocked")

    def test_cross_process_same_target_only_one_reservation(self):
        with tempfile.TemporaryDirectory() as td:
            ctx = multiprocessing.get_context("spawn")
            barrier = ctx.Barrier(2)
            queue = ctx.Queue()
            processes = [ctx.Process(target=_reserve_worker, args=(td, barrier, queue)) for _ in range(2)]
            for process in processes:
                process.start()
            kinds = sorted(queue.get(timeout=15) for _ in processes)
            for process in processes:
                process.join(15)
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(kinds.count("reserved"), 1)
            self.assertEqual(kinds.count("blocked"), 1)

    def test_account_scopes_are_isolated(self):
        with tempfile.TemporaryDirectory() as td:
            a = SendGate(os.path.join(td, "a"), "account-a")
            b = SendGate(os.path.join(td, "b"), "account-b")
            self.assertEqual(a.reserve("same", "target", "hello")["kind"], "reserved")
            self.assertEqual(b.reserve("same", "target", "hello")["kind"], "reserved")


class BoundaryTests(unittest.TestCase):
    def test_url_policy_removes_query_and_rejects_other_hosts(self):
        self.assertEqual(safe_url("https://www.douyin.com/video/123?token=secret"),
                         "https://www.douyin.com/video/123")
        with self.assertRaises(URLPolicyError):
            safe_url("https://example.invalid/video/123")
        self.assertEqual(safe_url("https://www.douyin.com/?from=login", allow_root=True,
                                 keep_query=True), "https://www.douyin.com/?from=login")

    def test_open_returns_resolved_final_url_without_query(self):
        import sidecar

        class Page:
            def __init__(self):
                self.navigated = None

            def call(self, method, params, timeout=None):
                self.navigated = params["url"]

            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                return "https://www.douyin.com/video/123?session=opaque"

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19222)
            page = Page()
            instance._page = lambda: (page, {})
            result = instance.open({"url": "https://v.douyin.com/short?token=opaque"})
        self.assertEqual(result["url"], "https://www.douyin.com/video/123")
        self.assertIn("token=opaque", page.navigated)

    def test_text_is_passed_exactly_when_templates_are_not_explicit(self):
        class FakePage:
            def close(self):
                pass

        class FakeCDP:
            def new_tab(self, *_args, **_kwargs):
                return FakePage(), "tab"

            def activate_target(self, _target):
                pass

            def close_tab(self, _target):
                pass

        captured = []
        old_sleep, old_send, old_state = dm.time.sleep, dm.send_private, dm.STATE_DIR
        dm.time.sleep = lambda _seconds: None
        dm.send_private = lambda _page, _gate, _send_id, _target, text: (
            captured.append(text) or {"status": "unknown", "sendId": "s"})
        try:
            with tempfile.TemporaryDirectory() as td:
                dm.STATE_DIR = td
                dm.run_batch(FakeCDP(), [{"sec_uid": "uid", "nick": "N"}],
                             "requested", True, log=lambda *_args: None,
                             use_templates=False, gate=SendGate(td, "account-a"))
        finally:
            dm.time.sleep, dm.send_private, dm.STATE_DIR = old_sleep, old_send, old_state
        self.assertEqual(captured, ["requested"])

    def test_v4_send_uses_unified_gate_entry(self):
        class Page:
            def call(self, *_args, **_kwargs):
                return {}

            def close(self):
                pass

        class Browser:
            def close(self):
                pass

        page = Page()
        captured = []
        old = (cli.connect, cli.wait_document, cli.send_private,
               cli.time.sleep, cli.douyin.profile_url, cli.douyin.check_captcha,
               cli.douyin.check_login_required, cli.douyin.dm_entry)
        cli.connect = lambda _port: (Browser(), page)
        cli.wait_document = lambda *_args: None
        cli.time.sleep = lambda _seconds: None
        cli.douyin.profile_url = lambda uid: "https://www.douyin.com/user/" + uid
        cli.douyin.check_captcha = lambda _page: False
        cli.douyin.check_login_required = lambda _page: False
        cli.douyin.dm_entry = lambda _page: {"found": True, "blocked": False, "x": 1, "y": 1}
        cli.send_private = lambda _page, gate, send_id, target, text: (
            captured.append((gate, send_id, target, text)) or
            {"status": "unknown", "sendId": send_id})
        try:
            with tempfile.TemporaryDirectory() as td:
                args = types.SimpleNamespace(port=19222, sec_uid="author-1", send=True,
                                             text="exact", send_id="send-1", state_dir=td,
                                             profile_dir=os.path.join(td, "profile"))
                self.assertEqual(cli.cmd_v4(args), 0)
        finally:
            (cli.connect, cli.wait_document, cli.send_private,
             cli.time.sleep, cli.douyin.profile_url, cli.douyin.check_captcha,
             cli.douyin.check_login_required, cli.douyin.dm_entry) = old
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0][1:], ("send-1", {"authorId": "author-1", "authorName": ""}, "exact"))

    def test_comment_wrong_target_rejected_before_browser(self):
        import send_actions
        result = send_actions.send_comment(object(), None, "s", {
            "id": "comment", "roomId": "https://www.douyin.com/video/1",
            "authorId": "bad id", "text": "same"}, "same", "video")
        self.assertEqual(result["status"], "failed")

    def test_private_wrong_profile_is_rejected_without_click(self):
        import send_actions

        class Page:
            def __init__(self):
                self.clicks = []

            def call(self, *_args, **_kwargs):
                return {}

            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://www.douyin.com/user/other-user"
                return None

            def click_at(self, *args):
                self.clicks.append(args)

        old_sleep = send_actions.time.sleep
        send_actions.time.sleep = lambda _seconds: None
        try:
            with tempfile.TemporaryDirectory() as td:
                page = Page()
                gate = SendGate(td, "account-a")
                result = send_actions.send_private(page, gate, "wrong-profile", {
                    "authorId": "expected-user", "authorName": "A"}, "exact")
        finally:
            send_actions.time.sleep = old_sleep
        self.assertEqual(result["status"], "failed")
        self.assertEqual(page.clicks, [])

    def test_sidecar_maps_live_identity_fields(self):
        import sidecar

        class Page:
            def __init__(self):
                self.calls = []
            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://live.douyin.com/room-1"
                return None
            def call(self, method, *_args, **_kwargs):
                self.calls.append(method)
            def close(self):
                pass

        old = sidecar.live.collect_events, sidecar.douyin.login_state
        try:
            sidecar.live.collect_events = lambda _page, max_items=100: [
                {"id": "live-c1", "authorId": "live-u1", "authorName": "Alice", "text": "same"},
                {"id": "live-c2", "authorId": "live-u2", "authorName": "Bob", "text": "same"},
            ]
            sidecar.douyin.login_state = lambda _page: "verified"
            with tempfile.TemporaryDirectory() as td:
                instance = sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19223)
                page = Page()
                instance._page = lambda: (page, {"pid": 1})
                result = instance.collect_live({"url": "https://live.douyin.com/room-1", "maxItems": 10})
        finally:
            sidecar.live.collect_events, sidecar.douyin.login_state = old
        self.assertEqual([e["authorId"] for e in result["events"]], ["live-u1", "live-u2"])
        self.assertEqual([e["authorName"] for e in result["events"]], ["Alice", "Bob"])
        self.assertNotEqual(result["events"][0]["fingerprint"], result["events"][1]["fingerprint"])

    def test_sidecar_comment_collection_reuses_owned_tab_without_reload(self):
        import sidecar

        class Page:
            def __init__(self):
                self.calls = []
            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://www.douyin.com/video/123"
                return None
            def call(self, method, *_args, **_kwargs):
                self.calls.append(method)
            def close(self):
                pass

        old = sidecar.crawlmod.crawl_video_comments, sidecar.douyin.login_state
        invocations = []
        try:
            def crawl(page, video, **kwargs):
                invocations.append((video["aweme_id"], kwargs.get("navigate")))
                n = len(invocations)
                return ([{"id": "comment-%d" % n, "authorId": "u%d" % n,
                          "authorName": "A%d" % n, "text": "same"}], {"skipped": None})
            sidecar.crawlmod.crawl_video_comments = crawl
            sidecar.douyin.login_state = lambda _page: "verified"
            with tempfile.TemporaryDirectory() as td:
                instance = sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19224)
                page = Page()
                instance._page = lambda: (page, {"pid": 1})
                first = instance.collect_comments({"url": "https://www.douyin.com/video/123", "maxItems": 10, "scrollRounds": 0})
                second = instance.collect_comments({"url": "https://www.douyin.com/video/123", "maxItems": 10, "scrollRounds": 0})
        finally:
            sidecar.crawlmod.crawl_video_comments, sidecar.douyin.login_state = old
        self.assertEqual(invocations, [("123", False), ("123", False)])
        self.assertEqual([e["id"] for e in first["events"] + second["events"]], ["comment-1", "comment-2"])
        self.assertNotIn("Page.navigate", page.calls)




    def test_private_click_exception_is_unknown_and_never_retried(self):
        import send_actions

        class Recorder:
            def collect(self, **_kwargs):
                return []

        class Page:
            def __init__(self):
                self.clicks = 0

            def call(self, *_args, **_kwargs):
                return {}

            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://www.douyin.com/user/expected-user"
                return None

            def click_at(self, *_args):
                self.clicks += 1
                if self.clicks == 3:
                    raise RuntimeError("simulated click transport failure")

            def type_text(self, _text):
                pass

        old = (send_actions.time.sleep, send_actions.douyin.check_captcha,
               send_actions.douyin.login_state, send_actions.douyin.dm_entry,
               send_actions.douyin.dm_composer_for_recipient, send_actions.douyin.dm_send_button_for_recipient,
               send_actions.douyin.make_network_recorder, send_actions.douyin.recipient_context)
        send_actions.time.sleep = lambda _seconds: None
        send_actions.douyin.check_captcha = lambda _page: False
        send_actions.douyin.login_state = lambda _page: "verified"
        send_actions.douyin.dm_entry = lambda _page: {"found": True, "blocked": False, "x": 1, "y": 1}
        send_actions.douyin.dm_composer_for_recipient = lambda _page, *_args: {
            "found": True, "x": 2, "y": 2, "text": "exact", "containerKey": "target"}
        send_actions.douyin.dm_send_button_for_recipient = lambda _page, *_args: {
            "found": True, "disabled": False, "x": 3, "y": 3, "containerKey": "target"}
        send_actions.douyin.make_network_recorder = lambda *_args: Recorder()
        send_actions.douyin.recipient_context = lambda *_args, **_kwargs: {"verified": True}
        try:
            with tempfile.TemporaryDirectory() as td:
                page = Page()
                gate = SendGate(td, "account-a")
                first = send_actions.send_private(page, gate, "unknown-1", {
                    "authorId": "expected-user", "authorName": ""}, "exact")
                second = send_actions.send_private(page, gate, "unknown-2", {
                    "authorId": "expected-user", "authorName": ""}, "exact")
        finally:
            (send_actions.time.sleep, send_actions.douyin.check_captcha,
             send_actions.douyin.login_state, send_actions.douyin.dm_entry,
             send_actions.douyin.dm_composer_for_recipient, send_actions.douyin.dm_send_button_for_recipient,
             send_actions.douyin.make_network_recorder, send_actions.douyin.recipient_context) = old
        self.assertEqual(first["status"], "unknown")
        self.assertEqual(second["status"], "blocked")
        self.assertEqual(page.clicks, 3)

    def test_private_existing_draft_fails_before_typing(self):
        import send_actions

        class Page:
            def __init__(self): self.clicks = 0
            def call(self, *_args, **_kwargs): pass
            def evaluate(self, expression):
                if expression == "document.readyState": return "complete"
                if expression == "location.href": return "https://www.douyin.com/user/expected-user"
                return None
            def click_at(self, *_args): self.clicks += 1

        old = (send_actions.time.sleep, send_actions.douyin.check_captcha,
               send_actions.douyin.login_state, send_actions.douyin.dm_entry,
               send_actions.douyin.recipient_context, send_actions.douyin.dm_composer_for_recipient)
        send_actions.time.sleep = lambda _seconds: None
        send_actions.douyin.check_captcha = lambda _page: False
        send_actions.douyin.login_state = lambda _page: "verified"
        send_actions.douyin.dm_entry = lambda _page: {"found": True, "blocked": False, "x": 1, "y": 1}
        send_actions.douyin.recipient_context = lambda *_args, **_kwargs: {"verified": True}
        send_actions.douyin.dm_composer_for_recipient = lambda *_args: {
            "found": True, "x": 2, "y": 2, "text": "existing draft", "containerKey": "target"}
        try:
            with tempfile.TemporaryDirectory() as td:
                page = Page()
                result = send_actions.send_private(page, SendGate(td, "account-a"), "draft-1",
                                                   {"authorId": "expected-user"}, "new text")
        finally:
            (send_actions.time.sleep, send_actions.douyin.check_captcha,
             send_actions.douyin.login_state, send_actions.douyin.dm_entry,
             send_actions.douyin.recipient_context, send_actions.douyin.dm_composer_for_recipient) = old
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "composer_has_different_draft")
        self.assertEqual(page.clicks, 1)

    def test_video_comment_ambiguous_target_never_clicks(self):
        import send_actions

        class Page:
            def __init__(self):
                self.clicks = []

            def call(self, *_args, **_kwargs):
                return {}

            def evaluate(self, expression):
                return "complete" if expression == "document.readyState" else None

            def eval_json(self, _expression):
                # 模拟 douyin.comment_reply_button 真实会返回的歧义结果
                # （真机上它由 douyin.py 的 _REPLY_BUTTON_JS 产生）
                return {"found": False, "count": 2, "reason": "ambiguous_comment"}

            def click_at(self, *args):
                self.clicks.append(args)

        old = (send_actions.douyin.check_captcha, send_actions.douyin.login_state)
        send_actions.douyin.check_captcha = lambda _page: False
        send_actions.douyin.login_state = lambda _page: "verified"
        try:
            with tempfile.TemporaryDirectory() as td:
                page = Page()
                result = send_actions.send_comment(page, SendGate(td, "account-a"), "c1", {
                    "id": "comment-1", "roomId": "https://www.douyin.com/video/1",
                    "authorId": "author-1", "authorName": "A", "text": "same"},
                    "reply", "video")
        finally:
            send_actions.douyin.check_captcha, send_actions.douyin.login_state = old
        self.assertEqual(result["status"], "failed")
        # 归因必须明确指到【回复按钮定位】这一步，而不是笼统的 not_found
        self.assertEqual(result["reason"], "reply_ambiguous_comment")
        self.assertEqual(page.clicks, [])

    def test_sidecar_stdout_is_protocol_only(self):
        with tempfile.TemporaryDirectory() as td:
            state, profile = os.path.join(td, "state"), os.path.join(td, "profile")
            proc = subprocess.run(
                [sys.executable, str(PROBE / "sidecar.py"), "--state-dir", state,
                 "--profile-dir", profile, "--port", "19222"],
                input=json.dumps({"id": "p1", "method": "capabilities", "params": {}}) + "\n",
                text=True, capture_output=True, check=False)
            lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
            self.assertEqual(proc.returncode, 0)
            self.assertEqual([line["id"] for line in lines], ["p1", "p1"])
            self.assertEqual(lines[0]["type"], "progress")
            self.assertTrue(lines[1]["ok"])
            self.assertNotIn("Cookie", proc.stdout)

    def test_sidecar_jsonl_utf8_round_trip_with_chinese_and_emoji(self):
        with tempfile.TemporaryDirectory() as td:
            state, profile = os.path.join(td, "state"), os.path.join(td, "profile")
            env = dict(os.environ)
            env.pop("PYTHONUTF8", None)
            env["PYTHONIOENCODING"] = "cp1252"
            request_id = "中文🚀"
            proc = subprocess.run(
                [sys.executable, str(PROBE / "sidecar.py"), "--state-dir", state,
                 "--profile-dir", profile, "--port", "19225"],
                input=(json.dumps({"id": request_id, "method": "capabilities",
                                   "params": {"label": "中文🚀"}}, ensure_ascii=False) + "\n").encode("utf-8"),
                text=False, capture_output=True, check=False, env=env)
            lines = [json.loads(line.decode("utf-8")) for line in proc.stdout.splitlines() if line.strip()]
            self.assertEqual(proc.returncode, 0)
            self.assertEqual([line["id"] for line in lines], [request_id, request_id])

@unittest.skipUnless(__import__("sidecar")._find_browser(), "Chrome/Edge not installed")
class ChromiumFixtureTests(unittest.TestCase):
    """Run the real selector JavaScript against local HTML, never Douyin."""

    def setUp(self):
        import cdp as cdpmod
        import sidecar

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.tmp = tempfile.TemporaryDirectory()
        profile = os.path.join(self.tmp.name, "profile")
        os.makedirs(profile, exist_ok=True)
        browser = sidecar._find_browser()
        self.proc = subprocess.Popen(
            [browser, "--headless=new", "--disable-gpu", "--remote-debugging-address=127.0.0.1",
             "--remote-debugging-port=%d" % self.port, "--user-data-dir=%s" % profile,
             "--no-first-run", "--no-default-browser-check"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = __import__("time").time() + 15
        tab_info = None
        while __import__("time").time() < deadline:
            try:
                tabs = cdpmod.list_tabs(self.port)
                tab_info = next((t for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
                if tab_info:
                    break
            except Exception:
                pass
            __import__("time").sleep(0.2)
        if not tab_info:
            self.proc.kill()
            self.tmp.cleanup()
            self.fail("headless Chrome did not expose CDP")
        self.page = cdpmod.CDP(tab_info["webSocketDebuggerUrl"], port=self.port, timeout=15)

    def tearDown(self):
        try:
            self.page.call("Browser.close", {}, timeout=3)
        except Exception:
            pass
        try:
            self.page.close()
        except Exception:
            pass
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           check=False)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        else:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.tmp.cleanup()

    def _load(self, name):
        path = (pathlib.Path(__file__).parent / "fixtures" / name).resolve()
        self.page.call("Page.navigate", {"url": path.as_uri()}, timeout=10)
        for _ in range(30):
            if self.page.evaluate("document.readyState") == "complete":
                return
            __import__("time").sleep(0.1)
        self.fail("fixture did not load")

    def test_live_capture_and_single_public_click(self):
        import live
        self._load("live.html")
        rows = live.collect_events(self.page, 10)
        self.assertEqual([row["id"] for row in rows], ["live-1", "live-2"])
        composer = live.find_composer(self.page)
        self.assertTrue(composer["found"])
        self.page.click_at(composer["x"], composer["y"])
        self.page.type_text("fixture reply")
        self.assertEqual(live.find_composer(self.page)["text"], "fixture reply")
        button = live.find_send_button(self.page)
        self.assertTrue(button["found"])
        self.page.click_at(button["x"], button["y"])
        self.assertEqual(self.page.evaluate("document.querySelector('[data-e2e=live-chat-send]').dataset.clicks"), "1")

    def test_live_multiple_public_composers_are_rejected(self):
        import live
        self._load("live.html")
        self.page.evaluate("document.body.insertAdjacentHTML('beforeend','<div data-e2e=live-chat-input contenteditable=true></div>')")
        self.assertFalse(live.find_composer(self.page)["found"])
        self.page.evaluate("document.querySelectorAll('[data-e2e=live-chat-input]')[1].remove()")
        self.assertTrue(live.find_composer(self.page)["found"])

    def test_video_reply_never_relies_on_invented_data_e2e(self):
        """回归护栏：夹具里不许再出现真机不存在的那些 data-e2e。

        旧夹具靠 comment-content / comment-reply / comment-reply-input /
        comment-reply-submit 让测试全绿，而真机上一个都没有 —— 这正是
        video_reply 长期停在 autoEligible=false 的原因。把它们钉死在这里。
        """
        import pathlib
        html = (pathlib.Path(__file__).parent / "fixtures" / "comments.html").read_text(encoding="utf-8")
        for invented in ["comment-content", "comment-reply", "comment-reply-input",
                         "comment-reply-submit", "comment-reply-editor"]:
            self.assertNotIn('data-e2e="%s"' % invented, html,
                             "夹具不得再依赖真机不存在的 data-e2e：%s" % invented)

    def test_video_reply_button_locates_real_structure(self):
        """「回复」是真机上的裸 <span>，只能按文本定位。"""
        import douyin
        self._load("comments.html")
        target = {"id": "comment-1", "authorId": "author-1", "authorName": "Alice",
                  "text": "same question"}
        hit = douyin.comment_reply_button(self.page, target)
        self.assertTrue(hit["found"], hit)
        self.assertEqual(hit["tag"], "SPAN")
        self.assertGreaterEqual(hit["y"], 0)
        self.page.click_at(hit["x"], hit["y"])
        self.assertEqual(self.page.evaluate("document.querySelector('#comment-1').dataset.replyClicks"), "1")

    def test_video_reply_button_rejects_wrong_text(self):
        import douyin
        self._load("comments.html")
        target = {"id": "comment-1", "authorId": "author-1", "authorName": "Alice",
                  "text": "not the same question"}
        hit = douyin.comment_reply_button(self.page, target)
        self.assertFalse(hit["found"])
        self.assertEqual(hit["reason"], "comment_not_found")

    def test_video_reply_button_requires_scroll_when_out_of_viewport(self):
        """虚拟列表里出视口的行坐标是负的（真机实测 y=-1415）——必须先滚再读。"""
        import douyin
        self._load("comments.html")
        target = {"id": "comment-off", "authorId": "author-off", "authorName": "Carol",
                  "text": "offscreen question"}
        single = douyin.comment_reply_button(self.page, target, attempts=1, settle=0)
        self.assertFalse(single["found"])
        self.assertEqual(single["reason"], "scrolled_into_view")
        # 默认会重试，最终应当拿到视口内的坐标
        hit = douyin.comment_reply_button(self.page, target)
        self.assertTrue(hit["found"], hit)
        self.assertGreaterEqual(hit["y"], 0)

    def test_video_reply_button_falls_back_to_author_without_id(self):
        """没有 id 时退化为「正文 + 作者链接」；作者不符必须拒绝。"""
        import douyin
        self._load("comments.html")
        ok = douyin.comment_reply_button(self.page, {
            "authorId": "author-1", "authorName": "Alice", "text": "same question"})
        self.assertTrue(ok["found"], ok)
        bad = douyin.comment_reply_button(self.page, {
            "authorId": "author-nobody", "authorName": "Nobody", "text": "same question"})
        self.assertFalse(bad["found"])
        self.assertEqual(bad["reason"], "comment_not_found")

    def test_video_reply_composer_requires_replying_row(self):
        import douyin
        self._load("comments.html")
        target = {"id": "comment-1", "authorId": "author-1", "authorName": "Alice",
                  "text": "same question"}
        self.assertEqual(douyin.comment_reply_composer(self.page, target)["reason"], "reply_not_open")
        self.page.evaluate("openReply(document.querySelector('#comment-1'))")
        composer = douyin.comment_reply_composer(self.page, target)
        self.assertTrue(composer["found"], composer)
        self.assertEqual(composer["rowId"], "comment-1")

    def test_video_reply_ambiguous_open_rows_are_rejected(self):
        """同时有两行处于「回复中」时必须拒绝，不能猜一行。"""
        import douyin
        self._load("comments.html")
        target = {"id": "comment-1", "authorId": "author-1", "authorName": "Alice",
                  "text": "same question"}
        self.page.evaluate("openReply(document.querySelector('#comment-1'));openReply(document.querySelector('#comment-3'))")
        self.assertEqual(douyin.comment_reply_composer(self.page, target)["reason"], "ambiguous_reply_open")
        self.assertFalse(douyin.comment_reply_send_button(self.page, target)["found"])
        self.page.evaluate("document.querySelector('#comment-3 .replying-state').parentElement.querySelector('.comment-input-inner-container').remove();document.querySelector('#comment-3 .replying-state').remove()")
        self.assertTrue(douyin.comment_reply_composer(self.page, target)["found"])

    def test_video_reply_send_button_is_inactive_until_text_present(self):
        """空内容时发送键不是品牌红 —— "空内容不发送"由颜色判据自动保证。"""
        import douyin
        self._load("comments.html")
        target = {"id": "comment-1", "authorId": "author-1", "authorName": "Alice",
                  "text": "same question"}
        self.page.evaluate("openReply(document.querySelector('#comment-1'))")
        empty = douyin.comment_reply_send_button(self.page, target)
        self.assertFalse(empty["found"])
        self.assertEqual(empty["reason"], "send_button_inactive")

        composer = douyin.comment_reply_composer(self.page, target)
        self.page.click_at(composer["x"], composer["y"])
        self.page.type_text("谢谢提醒")
        active = douyin.comment_reply_send_button(self.page, target)
        self.assertTrue(active["found"], active)
        self.assertTrue(active["active"])
        self.page.click_at(active["x"], active["y"])
        self.assertEqual(
            self.page.evaluate("document.querySelector('#comment-1 .commentInput-right-ct .send').dataset.clicks"),
            "1")

    def test_video_reply_typing_into_wrong_row_is_never_attempted(self):
        """目标行的编辑器没开时，绝不能把文字打进别的行。"""
        import douyin
        self._load("comments.html")
        other = {"id": "comment-3", "authorId": "author-3", "authorName": "Bob",
                 "text": "different question"}
        self.page.evaluate("openReply(document.querySelector('#comment-1'))")
        self.assertEqual(douyin.comment_reply_composer(self.page, other)["reason"], "reply_row_mismatch")


    def test_private_async_target_context_excludes_wrong_history(self):
        import douyin
        self._load("private.html")
        self.assertFalse(douyin.dm_composer_for_recipient(self.page, "target-user", "Target User")["found"])
        button = self.page.eval_json("(function(){var e=document.querySelector('#open-dm'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()")
        self.page.click_at(button["x"], button["y"])
        found = {"found": False}
        for _ in range(15):
            found = douyin.dm_composer_for_recipient(self.page, "target-user", "Target User")
            if found.get("found"):
                break
            __import__("time").sleep(0.1)
        self.assertTrue(found["found"])
        self.assertEqual(found["containerKey"], "target-panel")
        self.assertFalse(douyin.dm_composer_for_recipient(self.page, "wrong-user", "Wrong")["found"])
        send = douyin.dm_send_button_for_recipient(self.page, "target-user", "Target User")
        self.assertTrue(send["found"])
        self.assertEqual(send["containerKey"], "target-panel")


class LiveFlowTests(unittest.TestCase):
    """Offline coverage for the live batch flow (images/12) and its two
    boundaries: host-provided scripts (images/09) and per-action idempotency
    with no replay of unresolved results (images/17)."""

    @staticmethod
    def _event(event_id, author_id=None, text=None, room="room-1"):
        """Build one live event.  Identity and text default to the event id so
        two different events never collapse into one fingerprint."""
        import sidecar
        author_id = "live-%s" % event_id if author_id is None else author_id
        text = "question %s" % event_id if text is None else text
        return sidecar._event("live", room, {"id": event_id, "authorId": author_id,
                                             "authorName": author_id.upper(), "text": text})

    @staticmethod
    def _scripts(event_ids, public="public reply text", private="private message text"):
        return {event_id: {"publicText": public, "privateText": private} for event_id in event_ids}

    def test_queue_dedupes_by_identity_and_enforces_capacity(self):
        import live_flow
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", capacity=3, clock=lambda: now[0])
            first = queue.append([self._event("e1"), self._event("e1"), self._event("e2")])
            self.assertEqual((first["added"], first["duplicates"]), (2, 1))
            for index in range(3, 7):
                now[0] += 1
                queue.append([self._event("e%d" % index)])
            states = queue.stats()["states"]
            self.assertEqual(states.get(live_flow.QUEUED), 3)
            self.assertEqual(states.get(live_flow.EXPIRED), 3)
            self.assertEqual(queue.find_event("e1")["state"], live_flow.EXPIRED)

    def test_batch_window_expires_old_events_and_never_replays_them(self):
        import live_flow
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: now[0])
            queue.append([self._event("old")])
            now[0] += 120
            queue.append([self._event("fresh")])
            batch = queue.take_batch(max_items=10, window_seconds=60)
            self.assertEqual([event["id"] for event in batch["events"]], ["fresh"])
            self.assertEqual(batch["expiredCount"], 1)
            self.assertEqual(queue.find_event("old")["state"], live_flow.EXPIRED)
            again = queue.take_batch(max_items=10, window_seconds=60)
            self.assertEqual([event["id"] for event in again["events"]], ["fresh"])
            self.assertEqual(again["expiredCount"], 0)

    def test_open_batch_is_reused_so_a_retry_cannot_plan_twice(self):
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
            queue.append([self._event("e1"), self._event("e2")])
            first = queue.take_batch(max_items=1, window_seconds=600)
            second = queue.take_batch(max_items=1, window_seconds=600)
            self.assertEqual(first["batchId"], second["batchId"])
            self.assertEqual(len(queue.batch_events(first["batchId"])), 1)

    def test_plan_requires_both_host_scripts(self):
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
            queue.append([self._event("e1"), self._event("e2")])
            batch = queue.take_batch(max_items=10, window_seconds=600)
            plan = queue.freeze_plan(batch["batchId"], {
                "e1": {"publicText": "ok reply", "privateText": "ok private"},
                "e2": {"publicText": "only public"},
            })
            self.assertEqual([item["eventId"] for item in plan["targets"]], ["e1"])
            self.assertEqual(plan["blocked"], [{"eventId": "e2", "reason": "private_text_missing"}])
            self.assertEqual(queue.find_event("e2")["state"], live_flow.BLOCKED)
            self.assertEqual(plan["scriptSource"], "host")

    def test_private_candidates_follow_phase_one_states(self):
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
            queue.append([self._event("confirmed"), self._event("unresolved"),
                          self._event("anonymous", author_id="")])
            batch = queue.take_batch(max_items=10, window_seconds=600)
            ids = ["confirmed", "unresolved", "anonymous"]
            queue.freeze_plan(batch["batchId"], self._scripts(ids))
            queue.mark("confirmed", live_flow.SENT_CONFIRMED, batch["batchId"])
            queue.mark("unresolved", live_flow.UNKNOWN, batch["batchId"])
            queue.mark("anonymous", live_flow.SENT_CONFIRMED, batch["batchId"])
            allowed, rejected = queue.private_candidates(batch["batchId"])
            self.assertEqual([item["eventId"] for item in allowed], ["confirmed"])
            reasons = {item["eventId"]: item["reason"] for item in rejected}
            self.assertEqual(reasons["unresolved"], "public_unknown")
            self.assertEqual(reasons["anonymous"], "missing_author_id")
            opt_in, opt_rejected = queue.private_candidates(
                batch["batchId"],
                {"allowPublicStates": ["sent_confirmed", "unknown"], "maxPrivate": 1})
            self.assertEqual([item["eventId"] for item in opt_in], ["confirmed"])

    def test_sidecar_live_plan_and_guards_need_no_browser(self):
        import sidecar

        def explode():
            raise AssertionError("browser must not be opened for planning or for guarded items")

        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19225)
            instance._page = explode
            instance.live_queue.append([self._event("e1"), self._event("e2")])
            planned = instance.dispatch("live_plan", {"maxItems": 10, "windowSeconds": 600,
                                                      "scripts": self._scripts(["e1", "e2"])})
            self.assertEqual(planned["status"], "ok")
            batch_id = planned["batch"]["batchId"]
            reply = instance.dispatch("live_reply", {"batchId": batch_id, "items": [
                {"eventId": "e1", "sendId": "s1", "text": "different text"}]})
            self.assertEqual(reply["status"], "blocked")
            self.assertEqual(reply["results"][0]["reason"], "script_mismatch")
            self.assertEqual(instance.live_queue.find_event("e1")["state"], "blocked")
            # 审核意见（2026-09-21）之后契约更严：私信必须【逐项绑定】那次确认成功的公屏回复。
            # 所以缺 publicSendId 时在打开浏览器之前就按 public_missing 拒绝（原来是按队列状态
            # public_planned 拒绝 —— 那条路径正是"可以绕过公屏门禁"的来源）。
            private = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                {"eventId": "e2", "sendId": "s2"}]})
            self.assertEqual(private["status"], "blocked")
            self.assertEqual(private["results"][0]["reason"], "public_missing")
            # 给了一个台账里不存在的 publicSendId -> 同样在打开浏览器之前拒绝
            private = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                {"eventId": "e2", "sendId": "s3", "publicSendId": "no-such-send"}]})
            self.assertEqual(private["results"][0]["reason"], "public_not_found")
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.dispatch("live_result", {"batchId": "does-not-exist"})
            self.assertEqual(raised.exception.code, "unknown_batch")

    def test_sidecar_live_result_reports_counts_and_checkpoint(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19226)
            caps = instance.dispatch("capabilities", {})
            self.assertIn("live_plan", caps["methods"])
            self.assertIn("live_result", caps["methods"])
            self.assertFalse(caps["capability"]["live_batch"]["autoEligible"])
            self.assertEqual(caps["capability"]["live_batch"]["validation"]["scripts"],
                             "host_provided_only")
            instance.live_queue.append([self._event("e1")])
            planned = instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 600,
                                                      "scripts": self._scripts(["e1"])})
            batch_id = planned["batch"]["batchId"]
            instance.live_queue.mark("e1", "sent_confirmed", batch_id)
            report = instance.dispatch("live_result", {"batchId": batch_id})
            self.assertEqual(report["counts"]["sent_confirmed"], 1)
            self.assertEqual(report["privateCandidates"], 1)
            self.assertEqual(report["checkpoint"]["planTargets"], 1)
            self.assertEqual(report["checkpoint"]["phase"], "private")

    def test_live_listen_enqueues_deduped_events(self):
        import sidecar

        class Page:
            def __init__(self):
                self.calls = []

            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://live.douyin.com/room-1"
                return None

            def call(self, method, *_args, **_kwargs):
                self.calls.append(method)

            def close(self):
                pass

        old = sidecar.live.collect_events, sidecar.douyin.login_state
        try:
            sidecar.live.collect_events = lambda _page, max_items=100: [
                {"id": "live-c1", "authorId": "u1", "authorName": "A", "text": "same"},
                {"id": "live-c1", "authorId": "u1", "authorName": "A", "text": "same"}]
            sidecar.douyin.login_state = lambda _page: "verified"
            with tempfile.TemporaryDirectory() as td:
                instance = sidecar.Sidecar(os.path.join(td, "state"),
                                           os.path.join(td, "profile"), 19227)
                page = Page()
                instance._page = lambda: (page, {"pid": 1})
                result = instance.dispatch("live_listen", {"url": "https://live.douyin.com/room-1",
                                                           "maxItems": 10})
        finally:
            sidecar.live.collect_events, sidecar.douyin.login_state = old
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["queue"]["added"], 1)
        self.assertEqual(result["queue"]["duplicates"], 1)
        self.assertEqual(result["queue"]["queued"], 1)

    def test_empty_batch_is_closed_instead_of_reused(self):
        """回归（评审 #1）：队列为空时不得留下可被永久复用的空批次。"""
        import live_flow
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: now[0])
            empty = queue.take_batch(max_items=10, window_seconds=600)
            self.assertEqual(empty["status"], "empty")
            self.assertIsNone(empty["batchId"])
            now[0] += 10
            queue.append([self._event("e1")])
            batch = queue.take_batch(max_items=10, window_seconds=600)
            self.assertNotEqual(batch["batchId"], empty["batchId"])
            self.assertEqual([event["id"] for event in batch["events"]], ["e1"])

    def test_open_batch_is_closed_once_its_window_passed(self):
        """回归（评审 #2）：未冻结的批次超窗后必须关闭，不能再被取回或发送。"""
        import live_flow
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: now[0])
            queue.append([self._event("e1")])
            first = queue.take_batch(max_items=10, window_seconds=60)
            self.assertEqual(first["status"], "ok")
            now[0] += 61
            second = queue.take_batch(max_items=10, window_seconds=60)
            self.assertIsNone(second["batchId"])
            self.assertEqual(second["status"], "empty")
            self.assertEqual(queue.batch(first["batchId"])["status"], "expired")
            self.assertEqual(queue.find_event("e1")["state"], live_flow.EXPIRED)

    def test_phase_methods_refuse_an_expired_batch(self):
        """回归（评审 #2）：超窗批次即使已被冻结，也不得再发公屏或私信。"""
        import live_flow
        import sidecar
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19228)
            instance.live_queue.clock = lambda: now[0]
            instance.live_queue.append([self._event("e1")])
            planned = instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 60,
                                                      "scripts": self._scripts(["e1"])})
            batch_id = planned["batch"]["batchId"]
            now[0] += 61
            instance._page = lambda: (_ for _ in ()).throw(AssertionError("no browser for expired batch"))
            for method in ("live_reply", "live_private"):
                with self.assertRaises(sidecar.SidecarError) as raised:
                    instance.dispatch(method, {"batchId": batch_id,
                                               "items": [{"eventId": "e1", "sendId": "s-1"}]})
                self.assertEqual(raised.exception.code, "batch_expired")
            self.assertEqual(instance.live_queue.batch(batch_id)["status"], "expired")

    def test_private_result_is_persisted(self):
        """回归（评审 #3）：私信结果必须真的落到库里，否则断点恢复与防重复都会失效。"""
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
            queue.append([self._event("e1")])
            batch = queue.take_batch(max_items=5, window_seconds=600)
            queue.freeze_plan(batch["batchId"], self._scripts(["e1"]))
            queue.mark("e1", live_flow.SENT_CONFIRMED, batch["batchId"])
            queue.mark_private("e1", live_flow.UNKNOWN, batch["batchId"], {"sendId": "s-1"})
            event = queue.find_event("e1")
            self.assertIn("unknown", str(event["private_json"]))
            self.assertEqual(event["state"], live_flow.SENT_CONFIRMED)
            reopened = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
            self.assertEqual(reopened.result(batch["batchId"])["privateCounts"], {"unknown": 1})

    def test_client_supplied_policy_is_refused(self):
        """回归（评审 #4）：策略必须由授权服务端签发，边界拒绝调用方自带策略。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19229)
            instance.live_queue.append([self._event("e1")])
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 600,
                                                "scripts": self._scripts(["e1"]),
                                                "policy": {"allowPublicStates": ["unknown"]}})
            self.assertEqual(raised.exception.code, "policy_not_server_issued")
            planned = instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 600,
                                                      "scripts": self._scripts(["e1"])})
            self.assertEqual(planned["policy"]["allowPublicStates"], ["sent_confirmed"])
            self.assertEqual(planned["policySource"], "builtin_default")

    def test_plan_matches_keywords_before_forming_a_batch(self):
        """回归（流程第 2 步）：关键词匹配发生在成批之前，未命中的事件不进批次。"""
        import live_flow
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19230)
            instance.live_queue.append([
                self._event("hit", text="这个蒸糕怎么做"),
                self._event("miss", text="主播晚上好"),
            ])
            planned = instance.dispatch("live_plan", {
                "maxItems": 10, "windowSeconds": 600, "matchMode": "seg",
                "keywords": "怎么做", "scripts": self._scripts(["hit", "miss"])})
            self.assertEqual(planned["status"], "ok")
            self.assertEqual([item["eventId"] for item in planned["targets"]], ["hit"])
            self.assertEqual(planned["filter"]["matched"], 1)
            self.assertEqual(planned["filter"]["missed"], 1)
            self.assertEqual(instance.live_queue.find_event("miss")["state"], live_flow.FILTERED)
            self.assertEqual(instance.live_queue.find_event("miss")["detail"]["reason"], "keyword_miss")

    def test_plan_exclude_keywords_take_precedence(self):
        """回归（流程第 2 步）：命中关键词但同时命中排除词的事件被丢弃。"""
        import live_flow
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19231)
            instance.live_queue.append([
                self._event("ok", text="求链接 谢谢"),
                self._event("ad", text="求链接 加微信广告"),
            ])
            planned = instance.dispatch("live_plan", {
                "maxItems": 10, "windowSeconds": 600, "matchMode": "seg",
                "keywords": "链接", "excludeKeywords": "广告",
                "scripts": self._scripts(["ok", "ad"])})
            self.assertEqual([item["eventId"] for item in planned["targets"]], ["ok"])
            self.assertEqual(planned["filter"]["excluded"], 1)
            self.assertEqual(planned["filter"]["matched"], 1)
            self.assertEqual(instance.live_queue.find_event("ad")["detail"]["reason"],
                             "keyword_excluded")

    def test_plan_without_keywords_keeps_every_event(self):
        """没给关键词时行为不变：队列里的事件全部可成批。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19232)
            instance.live_queue.append([self._event("a", text="任何一句话")])
            planned = instance.dispatch("live_plan", {"maxItems": 10, "windowSeconds": 600,
                                                      "scripts": self._scripts(["a"])})
            self.assertEqual([item["eventId"] for item in planned["targets"]], ["a"])
            self.assertEqual(planned["filter"]["matched"], 0)
            self.assertEqual(planned["filter"]["missed"], 0)


    # ---- 批次退休的对账与台账保护（协作者在 89464b6a 里指出的可观测性缺口）----

    def test_retired_batch_events_are_counted_in_the_response(self):
        """回归：因批次退休而作废的事件必须计入 expiredCount / expired。

        原实现只把"按时间窗过期"的事件放进返回的列表，批次退休时一并作废的那批
        planned 事件却凭空消失：宿主看到 expiredCount=0，无法对账"这次丢了多少"。
        """
        import live_flow
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: now[0])
            queue.append([self._event("e1")])
            first = queue.take_batch(max_items=10, window_seconds=60)
            self.assertEqual([event["id"] for event in first["events"]], ["e1"])
            now[0] += 61
            second = queue.take_batch(max_items=10, window_seconds=60)
            self.assertEqual(second["expiredCount"], 1)
            self.assertEqual(second["expired"][0]["id"], "e1")
            self.assertEqual(second["expired"][0]["expiredReason"], "batch_window_expired")
            self.assertEqual(queue.find_event("e1")["state"], live_flow.EXPIRED)
            self.assertEqual(queue.find_event("e1")["detail"]["reason"], "batch_window_expired")

    def test_expiry_never_rewrites_a_recorded_send_result(self):
        """回归：批次退休只能作废【还没发出去】的事件，已记录的结果不得被改写。

        台账（sent_confirmed / unknown / failed / blocked）是"到底做了什么"的唯一事实，
        如果窗口检查顺手把它改成 expired，就等于把已经发生的触达抹掉，
        之后的对账、去重与防重复触达都会失准。
        """
        import live_flow
        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: now[0])
            queue.append([self._event("sent"), self._event("pending")])
            batch_id = queue.take_batch(max_items=10, window_seconds=60)["batchId"]
            queue.mark("sent", live_flow.SENT_CONFIRMED, batch_id)
            now[0] += 61
            with self.assertRaises(live_flow.LiveFlowError) as raised:
                queue.ensure_active(batch_id)
            self.assertEqual(raised.exception.code, "batch_expired")
            self.assertIn("1 event(s) were expired", raised.exception.message)
            self.assertEqual(queue.find_event("sent")["state"], live_flow.SENT_CONFIRMED)
            self.assertEqual(queue.find_event("pending")["state"], live_flow.EXPIRED)

    def test_ensure_active_keeps_a_live_batch_and_refuses_unknown_ids(self):
        """窗口内的批次（含已冻结）继续可用；未知批次 fail-closed。"""
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
            queue.append([self._event("e1")])
            batch_id = queue.take_batch(max_items=10, window_seconds=600)["batchId"]
            queue.freeze_plan(batch_id, self._scripts(["e1"]))
            self.assertEqual(queue.ensure_active(batch_id)["batch_id"], batch_id)
            with self.assertRaises(live_flow.LiveFlowError) as raised:
                queue.ensure_active("does-not-exist")
            self.assertEqual(raised.exception.code, "unknown_batch")

    def test_sidecar_refuses_an_expired_batch_without_touching_the_browser(self):
        """边界：两个阶段都以 batch_expired 拒绝过期批次，且拒绝先于任何浏览器动作。"""
        import sidecar

        def explode():
            raise AssertionError("an expired batch must be refused before any browser work")

        now = [1000.0]
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19234)
            instance.live_queue.clock = lambda: now[0]
            instance.live_queue.append([self._event("e1")])
            planned = instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 60,
                                                      "scripts": self._scripts(["e1"])})
            batch_id = planned["batch"]["batchId"]
            instance._page = explode
            now[0] += 61
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.dispatch("live_reply", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "s1", "text": "public reply text"}]})
            self.assertEqual(raised.exception.code, "batch_expired")
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.dispatch("live_private", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "s2", "text": "private message text"}]})
            self.assertEqual(raised.exception.code, "batch_expired")


    # ---- 回复弹幕（公屏 @该观众）：真机结论 + 离线回归 ----

    def test_plan_freezes_the_reply_mode_and_rejects_unknown_modes(self):
        """落地方式在【冻结计划】时定稿；未知模式直接拒绝。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19240)
            instance.live_queue.append([self._event("e1", text="怎么做")])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600, "replyMode": "danmaku",
                "scripts": {"e1": {"publicText": "@LIVE-E1 这个我会，稍后私信你",
                                   "privateText": "private message text"}}})
            self.assertEqual(planned["replyMode"], "danmaku")
            self.assertEqual(
                instance.live_queue.plan(planned["batch"]["batchId"])["replyMode"], "danmaku")
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 600,
                                                "replyMode": "shout", "scripts": {}})
            self.assertEqual(raised.exception.code, "invalid_input")

    def test_danmaku_mode_blocks_a_target_without_a_nickname(self):
        """没有昵称就 @ 不到人：计划期直接 blocked，绝不用 ID 猜一个人名。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19241)
            instance.live_queue.append([self._event("e1", author_id="", text="怎么做")])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600, "replyMode": "danmaku",
                "scripts": {"e1": {"publicText": "@someone 稍后私信你",
                                   "privateText": "private message text"}}})
            self.assertEqual(planned["status"], "blocked")
            self.assertEqual(planned["blocked"][0]["reason"], "missing_author_name")

    def test_danmaku_mode_requires_the_mention_prefix_from_the_host_script(self):
        """话术归平台侧：没有 @昵称 前缀就 blocked —— 本模块不代写、不改写话术。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19242)
            instance.live_queue.append([self._event("e1", text="怎么做")])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600, "replyMode": "danmaku",
                "replyVia": "mention_text",
                "scripts": {"e1": {"publicText": "这个我会，稍后私信你",
                                   "privateText": "private message text"}}})
            self.assertEqual(planned["status"], "blocked")
            self.assertEqual(planned["blocked"][0]["reason"], "mention_prefix_missing")
            self.assertEqual(instance.live_queue.find_event("e1")["state"], "blocked")

    def test_reply_mode_cannot_change_after_the_plan_is_frozen(self):
        """同一批次里不允许两种触达方式：改口在打开浏览器之前就被拒绝。"""
        import sidecar

        def explode():
            raise AssertionError("a mode mismatch must be refused before any browser work")

        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19243)
            instance.live_queue.append([self._event("e1", text="怎么做")])
            planned = instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 600,
                                                      "scripts": self._scripts(["e1"])})
            batch_id = planned["batch"]["batchId"]
            instance._page = explode
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.dispatch("live_reply", {"batchId": batch_id, "mode": "danmaku",
                                                 "items": [{"eventId": "e1", "sendId": "s1"}]})
            self.assertEqual(raised.exception.code, "mode_mismatch")

    def test_danmaku_reply_refuses_before_typing_when_the_row_is_gone(self):
        """屏上没有那条弹幕就不发：绝不把 @ 认错人，也不产生任何输入与点击。"""
        import live
        import send_actions

        class Page:
            def __init__(self):
                self.clicks, self.typed = [], []

            def call(self, *_args, **_kwargs):
                return {}

            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://live.douyin.com/123"
                return None

            def click_at(self, *args):
                self.clicks.append(args)

            def type_text(self, *args, **_kwargs):
                self.typed.append(args)

        old = (live.find_danmaku, send_actions.douyin.check_captcha,
               send_actions.douyin.login_state, send_actions.time.sleep)
        live.find_danmaku = lambda _tab, _target: {"ok": False, "reason": "danmaku_not_found"}
        send_actions.douyin.check_captcha = lambda _tab: False
        send_actions.douyin.login_state = lambda _tab: "verified"
        send_actions.time.sleep = lambda _seconds: None
        try:
            with tempfile.TemporaryDirectory() as td:
                page = Page()
                gate = SendGate(td, "account-a")
                result = send_actions.send_danmaku_reply(page, gate, "s-live-1", {
                    "id": "evt-1", "roomId": "https://live.douyin.com/123",
                    "authorName": "LIVE-E1", "text": "怎么做"}, "@LIVE-E1 稍后私信你")
        finally:
            (live.find_danmaku, send_actions.douyin.check_captcha,
             send_actions.douyin.login_state, send_actions.time.sleep) = old
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "danmaku_not_found")
        self.assertEqual(page.typed, [])
        self.assertEqual(page.clicks, [])

    def test_danmaku_reply_input_guards_run_before_anything_else(self):
        """缺昵称 / 话术没带 @昵称：连浏览器都不碰就拒绝。"""
        import send_actions
        missing_nick = send_actions.send_danmaku_reply(object(), None, "s-live-2", {
            "id": "evt-2", "roomId": "https://live.douyin.com/123",
            "authorName": "", "text": "怎么做"}, "@谁 稍后私信你")
        self.assertEqual(missing_nick["status"], "failed")
        self.assertIn("authorName", missing_nick["reason"])
        no_prefix = send_actions.send_danmaku_reply(object(), None, "s-live-3", {
            "id": "evt-3", "roomId": "https://live.douyin.com/123",
            "authorName": "LIVE-E1", "text": "怎么做"}, "稍后私信你")
        self.assertEqual(no_prefix["status"], "failed")
        self.assertIn("@authorName", no_prefix["reason"])

    def test_human_typing_paces_every_character_between_0_1_and_0_9_seconds(self):
        """拟人节奏：每字 0.1-0.9 秒随机停顿，而不是固定节拍（真机要求）。"""
        import cdp
        sleeps, methods = [], []
        old_sleep, old_uniform = cdp.time.sleep, cdp.random.uniform
        cdp.time.sleep = lambda seconds: sleeps.append(round(float(seconds), 4))
        cdp.random.uniform = lambda lo, hi: (lo + hi) / 2.0

        class Tab(cdp.CDP):
            def __init__(self):
                pass

            def call(self, method, params=None, timeout=None):
                methods.append(method)
                return {}

        try:
            Tab().type_text("你好呀")                    # 3 个字，无标点
            self.assertEqual(len(sleeps), 3)
            for value in sleeps:
                self.assertGreaterEqual(value, 0.1)
                self.assertLessEqual(value, 0.9)
            self.assertEqual(methods, ["Input.dispatchKeyEvent"] * 3)
            sleeps[:] = []
            Tab().type_text("好的，明白了")               # 含标点：停顿仍在上限内
            for value in sleeps:
                self.assertGreaterEqual(value, 0.1)
                self.assertLessEqual(value, 0.9)
            sleeps[:] = []
            Tab().type_text("ab", per_char_delay=0.06)   # 显式固定节拍仍然可用
            self.assertEqual(sleeps, [0.06, 0.06])
        finally:
            cdp.time.sleep, cdp.random.uniform = old_sleep, old_uniform

    def test_live_capture_prefers_page_memory_and_falls_back_to_dom(self):
        """采集优先页面内存（带 sec_uid），不可用时才回落到 DOM 文本（无标识）。"""
        import live

        class Cdp:
            def __init__(self, feed, dom):
                self.feed, self.dom = feed, dom

            def eval_json(self, expression):
                if expression == live.FEED_JS:
                    return self.feed
                if expression == live.COLLECT_JS:
                    return self.dom
                return None

        memory = {"ok": True, "rows": [{"id": "m1", "sec_uid": "FAKE-SEC-UID", "uid": "9",
                                        "authorName": "N", "text": "怎么做", "atMs": 1,
                                        "roomId": "room", "userFlags": {}}]}
        rows = live.collect_events(Cdp(memory, {"rows": []}), max_items=5)
        self.assertEqual(rows[0]["authorId"], "FAKE-SEC-UID")
        self.assertEqual(rows[0]["source"], "page_memory")
        dom = {"rows": [{"id": "d1", "authorName": "N", "text": "怎么做", "onTop": True,
                         "source": "dom"}]}
        rows = live.collect_events(Cdp({"ok": False, "reason": "no_originalList"}, dom), max_items=5)
        self.assertEqual(rows[0]["authorName"], "N")
        self.assertEqual(rows[0]["authorId"], "")
        self.assertEqual(rows[0]["source"], "dom")

    def test_danmaku_locator_reports_the_reason_instead_of_guessing(self):
        """定位器把「没找到 / 多条命中 / 被遮挡」如实回报，绝不返回一个近似坐标。"""
        import live

        class Cdp:
            def __init__(self, payload):
                self.payload = payload

            def eval_json(self, _expression):
                return self.payload

        self.assertFalse(live.find_danmaku(Cdp({"ok": False, "count": 0,
                                                "reason": "danmaku_not_found"}),
                                          {"authorName": "N", "text": "怎么做"})["ok"])
        ambiguous = live.find_danmaku(Cdp({"ok": False, "count": 2,
                                           "reason": "danmaku_ambiguous"}),
                                     {"authorName": "N", "text": "怎么做"})
        self.assertEqual(ambiguous["reason"], "danmaku_ambiguous")
        self.assertNotIn("x", ambiguous)
        self.assertEqual(live.find_danmaku(Cdp(None), {"authorName": "N", "text": "x"})["reason"],
                         "danmaku_lookup_failed")


    def test_room_echo_is_recorded_as_sent_echoed_and_never_auto_privates(self):
        """真机证据分级：房间回声记为 sent_echoed，但默认策略不会因此自动私信。"""
        import sidecar

        class Page:
            def close(self):
                pass

        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19250)
            instance._page = lambda: (Page(), {"pid": 1})
            instance.live_queue.append([self._event("e1", text="怎么做")])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600, "replyMode": "danmaku",
                "replyVia": "mention_text",
                "scripts": {"e1": {"publicText": "@LIVE-E1 你好",
                                   "privateText": "private message text"}}})
            batch_id = planned["batch"]["batchId"]
            original = sidecar.send_danmaku_reply
            sidecar.send_danmaku_reply = lambda *_args, **_kwargs: {
                "status": "unknown", "reason": "platform_response_unavailable",
                "evidence": {"mechanism": "enter", "roomEcho": True}}
            try:
                reply = instance.dispatch("live_reply", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "s-echo"}]})
            finally:
                sidecar.send_danmaku_reply = original
            self.assertEqual(reply["replyMode"], "danmaku")
            self.assertEqual(reply["results"][0]["recordedState"], "sent_echoed")
            self.assertEqual(instance.live_queue.find_event("e1")["state"], "sent_echoed")
            # 默认策略只放行 sent_confirmed：回声不自动升级成私信
            self.assertEqual(reply["privateCandidates"], [])
            self.assertEqual(reply["privateRejected"][0]["reason"], "public_sent_echoed")

    def test_echo_requires_the_text_to_actually_appear(self):
        """没有回声时保持 unknown（不因为"点了发送"就当成成功）。"""
        import sidecar

        class Page:
            def close(self):
                pass

        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19251)
            instance._page = lambda: (Page(), {"pid": 1})
            instance.live_queue.append([self._event("e1", text="怎么做")])
            planned = instance.dispatch("live_plan", {
                "maxItems": 5, "windowSeconds": 600, "replyMode": "danmaku",
                "replyVia": "mention_text",
                "scripts": {"e1": {"publicText": "@LIVE-E1 你好",
                                   "privateText": "private message text"}}})
            batch_id = planned["batch"]["batchId"]
            original = sidecar.send_danmaku_reply
            sidecar.send_danmaku_reply = lambda *_args, **_kwargs: {
                "status": "unknown", "reason": "platform_response_unavailable",
                "evidence": {"mechanism": "enter", "roomEcho": False}}
            try:
                reply = instance.dispatch("live_reply", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "s-noecho"}]})
            finally:
                sidecar.send_danmaku_reply = original
            self.assertEqual(instance.live_queue.find_event("e1")["state"], "unknown")
            self.assertEqual(reply["results"][0]["recordedState"], "unknown")


class CommentFilterTests(unittest.TestCase):
    """流程一「关键词、排除词与去重」的离线回归（不碰浏览器、不建临时目录）。

    架构依据 images/11-comment-area-business：
        采集评论 -> 关联评论标识与评论者 -> 关键词、排除词与去重 -> 返回目标批次
    """

    def _rows(self):
        return [
            {"cid": "c1", "sec_uid": "SEC_A", "user": "A", "text": "肉可以这样做吗", "digg": 1},
            {"cid": "c2", "sec_uid": "SEC_A", "user": "A", "text": "几个月能吃", "digg": 9},
            {"cid": "c3", "sec_uid": "SEC_B", "user": "B", "text": "请问同行怎么报价 加我微信", "digg": 0},
            {"cid": "c4", "sec_uid": "SEC_C", "user": "C", "text": "请问米粉要泡吗", "digg": 2},
            {"cid": "c5", "sec_uid": "", "user": "", "text": "请问这个怎么做", "digg": 0},
        ]

    def test_exclude_keywords_drop_matched_comments(self):
        import crawl
        rows = self._rows()
        _, base_stats = crawl.filter_comments(rows, "可以,请问,几个月", mode="seg")
        matched, stats = crawl.filter_comments(rows, "可以,请问,几个月", mode="seg",
                                               exclude_keywords="微信")
        self.assertEqual(stats["excluded"], 1)
        self.assertEqual(stats["matched"], base_stats["matched"] - 1)
        self.assertTrue(all("微信" not in row["text"] for row in matched))
        self.assertEqual(stats["exclude_keywords"], ["微信"])

    def test_exclusion_only_counts_comments_that_would_have_matched(self):
        """excluded 只数「本来命中关键词、却被排除词挡掉」的条数 —— 这才是可调参的数字。"""
        import crawl
        rows = [{"cid": "x", "sec_uid": "S", "text": "同行勿扰", "digg": 0}]
        _, stats = crawl.filter_comments(rows, "怎么做", mode="seg", exclude_keywords="同行")
        self.assertEqual(stats["excluded"], 0)
        self.assertEqual(stats["matched"], 0)

    def test_exclude_takes_precedence_over_keyword(self):
        import crawl
        rows = [{"cid": "x", "sec_uid": "S", "text": "请问同行怎么报价", "digg": 0}]
        matched, stats = crawl.filter_comments(rows, "请问", mode="seg", exclude_keywords="同行")
        self.assertEqual(matched, [])
        self.assertEqual(stats["excluded"], 1)

    def test_build_queue_accepts_exclude_keywords(self):
        import crawl
        queue, stats = crawl.build_queue(self._rows(), "可以,请问,几个月", mode="seg",
                                         exclude_keywords="微信")
        self.assertTrue(queue)
        self.assertNotIn("SEC_B", [row["sec_uid"] for row in queue])
        self.assertEqual(stats["excluded"], 1)

    def test_dedupe_by_author_keeps_highest_digg_and_never_merges_anonymous(self):
        import sidecar
        kept, dropped = sidecar._dedupe_by_author(self._rows())
        self.assertEqual(dropped, 1)
        self.assertEqual(len(kept), 4)
        author_a = [row for row in kept if row["sec_uid"] == "SEC_A"]
        self.assertEqual(len(author_a), 1)
        self.assertEqual(author_a[0]["cid"], "c2")
        self.assertEqual(len([row for row in kept if not row["sec_uid"]]), 1)

    def test_filter_text_validates_external_input(self):
        import sidecar
        self.assertEqual(sidecar._filter_text(None, "k"), "")
        self.assertEqual(sidecar._filter_text("  可以 , 请问  ", "k"), "可以 , 请问")
        with self.assertRaises(sidecar.SidecarError):
            sidecar._filter_text(123, "k")
        with self.assertRaises(sidecar.SidecarError):
            sidecar._filter_text("x" * 500, "k")

    def test_sidecar_collect_comments_returns_filtered_targets(self):
        """targets 必须与 events 同形状 —— 下游两阶段发送直接拿它当 target 用。"""
        import sidecar
        rows = self._rows()

        class FakePage:
            def evaluate(self, expression):
                return "https://www.douyin.com/video/123"

            def close(self):
                pass

        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance._page = lambda: (FakePage(), {})
        original_navigate = sidecar._navigate
        original_login = sidecar.douyin.login_state
        original_crawl = sidecar.crawlmod.crawl_video_comments
        sidecar._navigate = lambda page, url: None
        sidecar.douyin.login_state = lambda page: "ok"
        sidecar.crawlmod.crawl_video_comments = lambda *a, **k: (
            rows, {"total": len(rows), "with_sec_uid": 3, "api_comments": len(rows)})
        try:
            result = instance.collect_comments({
                "url": "https://www.douyin.com/video/123",
                "commentKeywords": "可以,请问,几个月",
                "excludeKeywords": "微信",
                "matchMode": "seg",
            })
        finally:
            sidecar._navigate = original_navigate
            sidecar.douyin.login_state = original_login
            sidecar.crawlmod.crawl_video_comments = original_crawl

        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["events"]), len(rows))
        self.assertTrue(all("微信" not in row["text"] for row in result["targets"]))
        self.assertEqual(result["filter"]["excluded"], 1)
        self.assertEqual(result["filter"]["dedupedAuthors"], 1)
        self.assertEqual(result["filter"]["matchMode"], "seg")
        self.assertEqual(result["filter"]["excludeKeywords"], ["微信"])
        self.assertEqual(result["filter"]["targetCount"], len(result["targets"]))
        for key in ("id", "source", "roomId", "authorId", "authorName", "text"):
            self.assertIn(key, result["targets"][0])
        self.assertIn("matchedKeyword", result["targets"][0])

    def test_sidecar_rejects_bad_filter_params(self):
        import sidecar
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        with self.assertRaises(sidecar.SidecarError):
            instance.collect_comments({"url": "https://www.douyin.com/video/123", "matchMode": "nope"})



class SearchPagingTests(unittest.TestCase):
    """视频搜索分页（搜索游标）的离线回归。

    架构依据 images/10-video-search-flow：
        读取一页结果 -> 按固定条件筛选并去重 -> 保存视频池与搜索游标 -> 申请下一轮搜索
    这些用例不碰浏览器、不建临时目录。
    """

    def _instance(self, url=None):
        import sidecar
        page = FakeSearchPage(url)
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance._page = lambda: (page, {})
        return sidecar, instance, page

    def test_cursor_round_trip(self):
        import sidecar
        token = sidecar._encode_cursor("宝宝辅食", {"1", "2"}, 3)
        seen, page_no = sidecar._decode_cursor(token, "宝宝辅食")
        self.assertEqual(seen, {"1", "2"})
        self.assertEqual(page_no, 3)
        self.assertEqual(sidecar._decode_cursor(None, "宝宝辅食"), (set(), 1))
        self.assertEqual(sidecar._decode_cursor("", "宝宝辅食"), (set(), 1))

    def test_cursor_is_rejected_when_it_does_not_match(self):
        import sidecar
        token = sidecar._encode_cursor("宝宝辅食", {"1"}, 2)
        with self.assertRaises(sidecar.SidecarError):
            sidecar._decode_cursor(token, "别的关键词")
        with self.assertRaises(sidecar.SidecarError):
            sidecar._decode_cursor("!!!not-base64!!!", "宝宝辅食")
        with self.assertRaises(sidecar.SidecarError):
            sidecar._decode_cursor(12345, "宝宝辅食")

    def test_unsupported_cursor_version_is_rejected(self):
        import base64
        import json
        import sidecar
        raw = json.dumps({"v": 99, "k": "宝宝辅食", "n": 2, "seen": []}).encode("utf-8")
        token = base64.urlsafe_b64encode(raw).decode("ascii")
        with self.assertRaises(sidecar.SidecarError):
            sidecar._decode_cursor(token, "宝宝辅食")

    def test_first_page_navigates_and_second_page_reuses_the_tab(self):
        import sidecar
        sidecar_mod, instance, page = self._instance()
        calls = []
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state
        sidecar.douyin.login_state = lambda p: "ok"
        sidecar.crawlmod.search_videos = make_fake_search(calls)
        try:
            first = instance.search({"keyword": "宝宝辅食", "maxVideos": 5})
            second = instance.search({"keyword": "宝宝辅食", "maxVideos": 5,
                                      "cursor": first["cursor"]})
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login

        first_ids = [v["id"] for v in first["videos"]]
        second_ids = [v["id"] for v in second["videos"]]
        self.assertEqual(first_ids, ["1", "2", "3", "4", "5"])
        self.assertEqual(second_ids, ["6", "7", "8", "9", "10"])
        self.assertEqual(set(first_ids) & set(second_ids), set())
        self.assertEqual(first["page"], 1)
        self.assertEqual(second["page"], 2)
        self.assertEqual(first["poolSize"], 5)
        self.assertEqual(second["poolSize"], 10)
        self.assertTrue(first["hasMore"] and second["hasMore"])
        self.assertTrue(calls[0]["navigate"], "第一页必须自己导航")
        self.assertFalse(calls[1]["navigate"], "续页不能重新导航，否则又从第一页开始")
        self.assertEqual(calls[1]["seen"], {"1", "2", "3", "4", "5"})
        self.assertEqual(first["platformCursor"], "pc-1")

    def test_continuing_renavigates_when_the_tab_left_the_search_page(self):
        import sidecar
        sidecar_mod, instance, page = self._instance(url="https://www.douyin.com/video/123")
        calls = []
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state
        sidecar.douyin.login_state = lambda p: "ok"
        sidecar.crawlmod.search_videos = make_fake_search(calls)
        try:
            first = instance.search({"keyword": "宝宝辅食", "maxVideos": 5})
            instance.search({"keyword": "宝宝辅食", "maxVideos": 5, "cursor": first["cursor"]})
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login
        self.assertTrue(calls[1]["navigate"], "已经不在搜索页上时必须重新导航")

    def test_empty_page_means_the_pool_is_exhausted(self):
        import sidecar
        sidecar_mod, instance, page = self._instance()
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state
        sidecar.douyin.login_state = lambda p: "ok"
        sidecar.crawlmod.search_videos = lambda *a, **k: []
        try:
            result = instance.search({"keyword": "宝宝辅食"})
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login
        self.assertEqual(result["videos"], [])
        self.assertFalse(result["hasMore"], "一页都没有新视频 -> 告诉宿主可以停了")

    def test_search_rejects_cursor_from_another_keyword(self):
        import sidecar
        sidecar_mod, instance, page = self._instance()
        token = sidecar._encode_cursor("别的关键词", {"1"}, 2)
        with self.assertRaises(sidecar.SidecarError):
            instance.search({"keyword": "宝宝辅食", "cursor": token})


class FakeSearchPage:
    """search 只需要 location.href；续页时靠它判断"还在不在搜索页上"。"""

    def __init__(self, url=None):
        self.url = url or "https://www.douyin.com/search/x?type=general"

    def evaluate(self, expression):
        if expression == "location.href":
            return self.url
        return None

    def close(self):
        pass


def make_fake_search(calls):
    """假的 search_videos：池子固定 20 条，按 seen_ids 返回下一页的 5 条。"""

    def fake(page, keyword, scroll_rounds=12, max_videos=200, log=print,
             strict=False, meta=None, scroll_pause=2.0, navigate=True, seen_ids=None):
        seen = set(str(x) for x in (seen_ids or ()))
        calls.append({"navigate": navigate, "seen": seen})
        pool = [{"aweme_id": str(i), "url": "https://www.douyin.com/video/%d" % i,
                 "desc": "标题%d" % i, "author": "作者", "author_sec_uid": "SEC"}
                for i in range(1, 21)]
        out = [v for v in pool if v["aweme_id"] not in seen][:5]
        if isinstance(meta, dict):
            # 按【真实 crawl.search_videos 的 meta 契约】填：
            # 它会把平台的 api_cursor / api_has_more 映射成 platform_cursor / platform_has_more，
            # 并给出 skipped_seen。假函数必须照这个契约来，否则测的不是真东西。
            meta["skipped_seen"] = 0
            meta["api_cursor"] = "pc-1"
            meta["api_has_more"] = 1
            meta["platform_cursor"] = "pc-1"
            meta["platform_has_more"] = 1
        return out

    return fake


class VideoRelevanceTests(unittest.TestCase):
    """找视频模块的「相关度」回归（纯离线，不碰浏览器）。

    架构依据：找视频模块固定流程第 4 步要求返回
    「视频标题、作者、链接、相关度等候选结果」，模块职责是发现与筛选视频。
    """

    def test_exact_phrase_scores_by_position(self):
        import crawl
        head = crawl.video_relevance("宝宝辅食怎么做 一周不重样", "宝宝辅食")
        self.assertEqual(head["score"], 100)
        self.assertEqual(head["reason"], "exact_phrase")
        self.assertTrue(head["exact"])
        self.assertEqual(head["position"], 0)
        early = crawl.video_relevance("今天宝宝辅食吃什么", "宝宝辅食")
        self.assertEqual((early["score"], early["position"]), (90, 2))
        late = crawl.video_relevance("今天给大家分享一个我家一直在用的宝宝辅食做法", "宝宝辅食")
        self.assertEqual(late["score"], 80)
        self.assertGreater(early["score"], late["score"])

    def test_every_keyword_must_appear_contiguously_for_the_top_tier(self):
        import crawl
        both = crawl.video_relevance("教程 宝宝辅食做法", "宝宝辅食,教程")
        self.assertEqual((both["score"], both["reason"]), (100, "exact_phrase"))
        self.assertEqual(sorted(both["matchedKeywords"]), ["宝宝辅食", "教程"])
        only_one = crawl.video_relevance("宝宝辅食做法分享", "宝宝辅食,教程")
        self.assertEqual(only_one["reason"], "partial_segments")
        self.assertEqual(only_one["missingKeywords"], ["教程"])

    def test_falls_back_to_segments_when_the_phrase_never_appears(self):
        """抖音标题几乎不会连续包含「怎么充值codex」这种提问式关键词。"""
        import crawl
        rel = crawl.video_relevance("充值 codex 会员教程", "怎么充值codex")
        self.assertFalse(rel["exact"])
        self.assertEqual((rel["score"], rel["reason"]), (60, "all_segments"))
        self.assertEqual(sorted(rel["matchedSegments"]), ["codex", "充值"])
        self.assertEqual(rel["missingSegments"], [])

    def test_partial_segments_score_between_full_and_none(self):
        import crawl
        rel = crawl.video_relevance("codex 会员教程", "怎么充值codex")
        self.assertEqual(rel["reason"], "partial_segments")
        self.assertEqual(rel["matchedSegments"], ["codex"])
        self.assertEqual(rel["missingSegments"], ["充值"])
        self.assertTrue(0 < rel["score"] < 60)

    def test_no_match_and_edge_cases(self):
        import crawl
        none = crawl.video_relevance("完全无关的内容", "宝宝辅食")
        self.assertEqual((none["score"], none["reason"]), (0, "no_match"))
        self.assertFalse(none["exact"])
        self.assertIsNone(none["position"])
        self.assertEqual(crawl.video_relevance("", "宝宝辅食")["score"], 0)
        self.assertEqual(crawl.video_relevance("宝宝辅食", "")["reason"], "empty_keyword")


    def test_question_style_keyword_falls_back_to_content_core(self):
        """真机 2026-09-21：关键词「怎么做副业」搜出 80 条真实候选，79 条相关度 0。

        原因：分词只剩「做副业」，而抖音标题里写的是「副业」。
        中心语退一档之后这类标题拿到确定的分；完全无关的仍然是 0。
        """
        import crawl
        rel = crawl.video_relevance("今天分享三类无门槛副业！看到就是赚到！", "怎么做副业")
        self.assertEqual((rel["score"], rel["reason"]), (50, "core_segments"))
        self.assertEqual(rel["matchedCores"], ["副业"])
        self.assertEqual(rel["missingSegments"], ["做副业"])
        self.assertFalse(rel["exact"])
        none = crawl.video_relevance("完全无关的内容", "怎么做副业")
        self.assertEqual((none["score"], none["reason"]), (0, "no_match"))

    def test_content_core_is_order_insensitive(self):
        import crawl
        tail = crawl.video_relevance("在家搞副业，一个月多赚三千", "副业怎么做")
        self.assertEqual((tail["score"], tail["reason"]), (50, "core_segments"))
        learn = crawl.video_relevance("新手剪辑入门第一课", "怎么学剪辑")
        self.assertEqual((learn["score"], learn["reason"]), (50, "core_segments"))
        # 中心语也不在标题里 -> 仍然 0
        self.assertEqual(crawl.video_relevance("视频软件推荐", "怎么学剪辑")["score"], 0)

    def test_core_tier_never_outranks_a_real_segment_hit(self):
        import crawl
        core = crawl.video_relevance("今天分享三类无门槛副业", "怎么做副业")
        allseg = crawl.video_relevance("副业怎么做，顺带说说做副业的方法", "怎么做副业")
        self.assertEqual((allseg["score"], allseg["reason"]), (60, "all_segments"))
        self.assertLess(core["score"], allseg["score"])

    def test_plain_keyword_has_no_core_to_fall_back_to(self):
        import crawl
        rel = crawl.video_relevance("今天分享三类无门槛副业", "副业")
        self.assertEqual((rel["score"], rel["reason"]), (90, "exact_phrase"))
        none = crawl.video_relevance("完全无关的内容", "副业")
        self.assertEqual((none["score"], none["reason"]), (0, "no_match"))

    def test_real_titles_from_the_field_run(self):
        """真机回归：下面 6 条是 2026-09-21 用「怎么做副业」真实搜到的标题。"""
        import crawl
        titles = [
            "普通人怎么做副业赚的小钱#知识分享 #副业",
            "今天分享三类无门槛副业！看到就是赚到！#聚星超媒 #副业",
            "一天赚两个月工资的副业小方法，手把手教学#副业",
            "【建议收藏】三个副业，六个软件，做好生活费完全不是问题 #兼职 #副业",
            "适合普通人的0成本副业，代价就是吃苦熬夜，做好了闷声发大财#干货分享",
            "利润很吓人的4个副业。#干货分享 #副业",
        ]
        scores = [crawl.video_relevance(t, "怎么做副业")["score"] for t in titles]
        self.assertTrue(all(s > 0 for s in scores), scores)
        self.assertEqual(crawl.video_relevance(titles[0], "怎么做副业")["reason"], "exact_phrase")
        unrelated = crawl.video_relevance("我们输在学业上 可未必输在事业上#电商", "怎么做副业")
        self.assertEqual(unrelated["score"], 0)


class SearchRelevanceTests(unittest.TestCase):
    """search 把相关度放进候选结果，并支持按阈值筛选（模块内职责）。"""

    class _Page:
        def close(self):
            pass

    def _instance(self):
        import sidecar
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance._page = lambda: (self._Page(), {})
        return sidecar, instance

    @staticmethod
    def _videos():
        return [
            {"aweme_id": "1", "url": "https://www.douyin.com/video/1",
             "desc": "宝宝辅食怎么做", "author": "A", "author_sec_uid": "S1"},
            {"aweme_id": "2", "url": "https://www.douyin.com/video/2",
             "desc": "codex 会员教程", "author": "B", "author_sec_uid": "S2"},
            {"aweme_id": "3", "url": "https://www.douyin.com/video/3",
             "desc": "完全无关的内容", "author": "C", "author_sec_uid": "S3"},
        ]

    def _run(self, params):
        sidecar, instance = self._instance()
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state
        sidecar.douyin.login_state = lambda page: "ok"
        sidecar.crawlmod.search_videos = lambda *a, **k: self._videos()
        try:
            return instance.search(params)
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login

    def test_every_candidate_carries_a_relevance_record(self):
        result = self._run({"keyword": "宝宝辅食"})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["videos"]), 3)
        self.assertEqual(result["videos"][0]["relevance"]["score"], 100)
        self.assertEqual(result["videos"][0]["relevance"]["reason"], "exact_phrase")
        self.assertEqual(result["videos"][2]["relevance"]["reason"], "no_match")
        self.assertEqual(result["filter"], {"collected": 3, "returned": 3,
                                            "filteredByRelevance": 0, "minRelevance": 0})
        # 边界：只发现与筛选，不产生任何发送动作
        for key in ("sent", "sendId", "private", "reply"):
            self.assertNotIn(key, result)

    def test_min_relevance_filters_candidates_inside_the_module(self):
        result = self._run({"keyword": "宝宝辅食", "minRelevance": 60})
        self.assertEqual([v["id"] for v in result["videos"]], ["1"])
        self.assertEqual(result["filter"], {"collected": 3, "returned": 1,
                                            "filteredByRelevance": 2, "minRelevance": 60})

    def test_min_relevance_is_validated(self):
        import sidecar
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        with self.assertRaises(sidecar.SidecarError):
            instance.search({"keyword": "宝宝辅食", "minRelevance": 101})
        with self.assertRaises(sidecar.SidecarError):
            instance.search({"keyword": "宝宝辅食", "minRelevance": -1})


class SearchPagingRelevanceTests(unittest.TestCase):
    """回归：分页 x 相关度筛选的组合，以及终止状态的收敛。

    对应评审意见里找视频模块的两条：
      1. 相关度筛掉的视频没有完整计入分页游标池，后续分页会重复处理；
      2. 检测到验证码后应明确返回终止状态，不能继续给出可翻页信号。
    """

    def _instance(self, url=None):
        import sidecar
        page = FakeSearchPage(url)
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance._page = lambda: (page, {})
        return sidecar, instance

    @staticmethod
    def _videos():
        return [
            {"aweme_id": "1", "url": "https://www.douyin.com/video/1",
             "desc": "宝宝辅食怎么做", "author": "A", "author_sec_uid": "S1"},
            {"aweme_id": "2", "url": "https://www.douyin.com/video/2",
             "desc": "codex 会员教程", "author": "B", "author_sec_uid": "S2"},
            {"aweme_id": "3", "url": "https://www.douyin.com/video/3",
             "desc": "完全无关的内容", "author": "C", "author_sec_uid": "S3"},
        ]

    def _run(self, params, stopped=None):
        sidecar, instance = self._instance()
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state
        calls = []

        def fake(page, keyword, **kwargs):
            calls.append(kwargs)
            meta = kwargs.get("meta")
            if isinstance(meta, dict):
                meta["skipped_seen"] = 0
                meta["platform_cursor"] = "pc-1"
                meta["platform_has_more"] = 1
                if stopped:
                    meta["stopped_reason"] = stopped
            return self._videos()

        sidecar.douyin.login_state = lambda page: "ok"
        sidecar.crawlmod.search_videos = fake
        try:
            return instance.search(params), calls
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login

    def test_pool_records_videos_dropped_by_min_relevance(self):
        """回归 1：被相关度筛掉的视频也必须进游标池，否则下一页会重复处理。"""
        first, _ = self._run({"keyword": "宝宝辅食", "minRelevance": 60})
        self.assertEqual([v["id"] for v in first["videos"]], ["1"])
        self.assertEqual(first["filter"]["filteredByRelevance"], 2)
        self.assertEqual(first["poolSize"], 3)
        self.assertEqual(first["poolIds"], ["1", "2", "3"])

        second, calls = self._run({"keyword": "宝宝辅食", "cursor": first["cursor"]})
        self.assertEqual(second["page"], 2)
        # 续页时池子里必须已经有那两条被筛掉的视频，否则它们会被重新采集一遍
        self.assertEqual(calls[0]["seen_ids"], {"1", "2", "3"})

    def test_captcha_is_terminal_and_offers_no_paging_signal(self):
        """回归 2：验证码必须收敛成终止状态，不能继续给可翻页信号。"""
        result, _ = self._run({"keyword": "宝宝辅食"}, stopped="captcha")
        self.assertEqual(result["status"], "captcha")
        self.assertIsNone(result["cursor"])
        self.assertFalse(result["hasMore"])
        self.assertEqual(result["stoppedReason"], "captcha")
        # 熔断不丢数据：已经采到的候选照常返回
        self.assertEqual(len(result["videos"]), 3)
        # 游标没了，池子只能由宿主保存 —— 所以用数据字段把池子交出去
        self.assertEqual(result["poolIds"], ["1", "2", "3"])

    def test_login_required_is_also_terminal(self):
        """同一类缺陷：登录失效也不该继续给出可翻页信号。"""
        import sidecar
        sidecar_mod, instance = self._instance()
        original = sidecar.douyin.login_state
        sidecar.douyin.login_state = lambda page: "required"
        try:
            result = instance.search({"keyword": "宝宝辅食"})
        finally:
            sidecar.douyin.login_state = original
        self.assertEqual(result["status"], "login_required")
        self.assertIsNone(result["cursor"])
        self.assertFalse(result["hasMore"])
        self.assertEqual(result["stoppedReason"], "login_required")

    def test_normal_page_still_offers_a_cursor(self):
        """反向保护：别把"终止"语义误加到正常路径上。"""
        result, calls = self._run({"keyword": "宝宝辅食"})
        self.assertEqual(result["status"], "ok")
        self.assertIsNotNone(result["cursor"])
        self.assertTrue(result["hasMore"])
        self.assertIsNone(result["stoppedReason"])
        self.assertEqual(result["poolSize"], 3)
        self.assertEqual(calls[0]["navigate"], True)

    def test_page_record_carries_version_and_paging_outcome(self):
        """分页记录：页面版本 + 分页终止态（more / exhausted / captcha / login_required）。

        评审意见：找视频要记录「当前页面版本、分页终止态、登录/验证码/空结果」。
        只有 cursor/hasMore 时，宿主重启后分不清"到底了"和"被验证码打断了"，
        也认不出手里的游标是哪一版协议产出的 —— 这两件事的处置完全不同：
        前者停止翻页，后者要人工处理验证码再继续。
        """
        import sidecar
        normal, _ = self._run({"keyword": "宝宝辅食"})
        self.assertEqual(normal["cursorVersion"], sidecar.CURSOR_VERSION)
        self.assertEqual(normal["pageOutcome"], sidecar.PAGE_OUTCOME_MORE)
        self.assertEqual(normal["page"], 1)

        captcha, _ = self._run({"keyword": "宝宝辅食"}, stopped="captcha")
        self.assertEqual(captcha["pageOutcome"], sidecar.PAGE_OUTCOME_CAPTCHA)
        self.assertEqual(captcha["stoppedReason"], "captcha")
        self.assertIsNone(captcha["cursor"])
        self.assertFalse(captcha["hasMore"])
        self.assertEqual(captcha["cursorVersion"], sidecar.CURSOR_VERSION)

        sidecar_mod, instance = self._instance()
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state
        try:
            sidecar.douyin.login_state = lambda page: "required"
            login = instance.search({"keyword": "宝宝辅食"})
            sidecar.douyin.login_state = lambda page: "ok"
            sidecar.crawlmod.search_videos = lambda *args, **kwargs: []
            empty = instance.search({"keyword": "宝宝辅食"})
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login
        self.assertEqual(login["pageOutcome"], sidecar.PAGE_OUTCOME_LOGIN)
        self.assertIsNone(login["cursor"])
        self.assertFalse(login["hasMore"])
        self.assertEqual(empty["pageOutcome"], sidecar.PAGE_OUTCOME_EXHAUSTED)
        self.assertFalse(empty["hasMore"])
        self.assertEqual(empty["cursorVersion"], sidecar.CURSOR_VERSION)

    def test_paging_outcome_is_not_confused_with_the_platform_signal(self):
        """more/exhausted 说的是"我们这边还翻不翻"，platformHasMore 说的是"平台那边还有没有"。

        两者混用会让宿主在平台明明还有结果时提前收工，或者反过来对着验证码继续翻。
        """
        import sidecar
        more, _ = self._run({"keyword": "宝宝辅食"})
        self.assertEqual(more["pageOutcome"], sidecar.PAGE_OUTCOME_MORE)
        self.assertEqual(more["platformHasMore"], 1)
        # 本页一条新视频都没有，但平台那边【明明还有】（platform_has_more=1）：
        # 我们这边停，是因为这一页没有新东西，不是因为平台没有更多结果。
        sidecar_mod, instance = self._instance()
        original_search = sidecar.crawlmod.search_videos
        original_login = sidecar.douyin.login_state

        def empty_search(page, keyword, **kwargs):
            meta = kwargs.get("meta")
            if isinstance(meta, dict):
                meta["skipped_seen"] = 0
                meta["platform_has_more"] = 1
                meta["platform_cursor"] = "pc-1"
            return []

        try:
            sidecar.douyin.login_state = lambda p: "ok"
            sidecar.crawlmod.search_videos = empty_search
            exhausted = instance.search({"keyword": "宝宝辅食"})
        finally:
            sidecar.crawlmod.search_videos = original_search
            sidecar.douyin.login_state = original_login
        self.assertEqual(exhausted["pageOutcome"], sidecar.PAGE_OUTCOME_EXHAUSTED)
        self.assertEqual(exhausted["platformHasMore"], 1,
                         "我们这边没有新候选，不等于平台没有更多结果")


class CommentFlowContractTests(unittest.TestCase):
    """评论区两阶段契约（第 3 项）：公开回复确认成功之前，一律不许私信。

    架构依据：评论区固定流程 —— 关键词匹配评论 -> 公开回复 -> 只有 sent_confirmed
    才允许私信；unknown / failed / blocked 明确禁止进入私信，且拒绝必须发生在
    打开浏览器之前（fail-closed）。
    """

    class _Page:
        def __init__(self, url="https://www.douyin.com/user/other"):
            self.url = url

        def call(self, *_args, **_kwargs):
            return {}

        def evaluate(self, expression):
            if expression == "document.readyState":
                return "complete"
            if expression == "location.href":
                return self.url
            return None

        def close(self):
            pass

    def _instance(self, explode=False):
        import sidecar
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        if explode:
            def boom():
                raise AssertionError("契约不通过时不得打开浏览器")
            instance._page = boom
        else:
            instance._page = lambda: (self._Page(), {"pid": 1})
        return sidecar, instance

    @staticmethod
    def _public_reply(gate, send_id, status):
        gate.reserve(send_id, "comment:%s:author-1" % send_id, "public text", kind="comment")
        if status in ("unknown", "sent_confirmed"):
            # 这两类是"点下去之后"才可能有的结果；failed / blocked 属于开始之前就被拦下，
            # 不能先 mark_started —— send_gate 会把 started+failed 升级成 unknown（正确行为）。
            gate.mark_started(send_id)
        gate.finish(send_id, status, "platform_response_unavailable")
        return send_id

    def _refuse(self, status):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, "account-a")
            public_id = self._public_reply(gate, "pub-%s" % status, status)
            sidecar_mod, instance = self._instance(explode=True)
            instance.gate = gate
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.send_private({"sendId": "priv-1", "publicSendId": public_id,
                                       "target": {"authorId": "author-1"}, "text": "你好"})
            return raised.exception.code

    def test_missing_public_send_id_is_refused(self):
        """缺 publicSendId 必须拒绝 —— 它曾经是「可选」的，那等于没有守卫。

        「可选参数」在这个位置的真实含义是：任何调用方只要省略它，
        就绕过了「公开回复确认成功后才允许私信」这条契约，
        而偏偏执行发送的就是这条单发路径。批量清单一直强制这一条，
        两个入口口径不一致时，实际生效的是最弱的那条。
        （_instance(explode=True) 让 _page 抛异常，顺带证明门禁在开浏览器之前生效。）
        """
        import sidecar
        base = {"sendId": "priv-1", "target": {"authorId": "author-1"}, "text": "你好"}
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(explode=True)
            instance.gate = SendGate(td, "account-a")
            for extra in ({},                                  # 完全没有这个键
                          {"publicSendId": None},              # 显式 null
                          {"publicSendId": ""},                # 空串
                          {"publicSendId": "   "}):            # 只有空白
                params = dict(base)
                params.update(extra)
                with self.assertRaises(sidecar.SidecarError) as raised:
                    instance.send_private(params)
                self.assertEqual(raised.exception.code, "public_missing",
                                 "缺 publicSendId 必须按 public_missing 拒绝：%r" % (extra,))

    def test_confirmed_public_reply_is_the_only_way_through(self):
        """正例：公屏确认成功时放行（否则上面那条就变成了"永远发不出去"）。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, "account-a")
            public_id = self._public_reply(gate, "pub-ok", "sent_confirmed")
            sidecar_mod, instance = self._instance()
            instance.gate = gate
            instance._page = lambda: (self._Page(), {"pid": 1})
            # 走到真实发送分支即可；这里只断言门禁没有拦住它
            self.assertIsNone(sidecar._public_guard(gate, public_id))

    def test_unresolved_public_reply_blocks_the_private_message(self):
        """unknown（本通道常态）不得转成私信 —— 这是红线 2/3 的直接体现。"""
        self.assertEqual(self._refuse("unknown"), "public_unknown")

    def test_failed_and_blocked_public_replies_block_the_private_message(self):
        self.assertEqual(self._refuse("failed"), "public_failed")
        self.assertEqual(self._refuse("blocked"), "public_blocked")

    def test_unknown_send_id_and_wrong_kind_are_refused(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, "account-a")
            sidecar_mod, instance = self._instance(explode=True)
            instance.gate = gate
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.send_private({"sendId": "priv-2", "publicSendId": "does-not-exist",
                                       "target": {"authorId": "author-1"}, "text": "你好"})
            self.assertEqual(raised.exception.code, "public_not_found")
            # 把"私信记录"当成公屏回复来用 -> 也必须拒绝
            gate.reserve("dm-1", "author-1", "你好", kind="private")
            gate.mark_started("dm-1")
            gate.finish("dm-1", "sent_confirmed", "platform_response_recorded")
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.send_private({"sendId": "priv-3", "publicSendId": "dm-1",
                                       "target": {"authorId": "author-1"}, "text": "你好"})
            self.assertEqual(raised.exception.code, "public_not_a_reply")

    def test_confirmed_public_reply_lets_the_private_stage_start(self):
        """sent_confirmed 才放行：放行后确实进入了浏览器阶段（用假页面走到画像校验）。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, "account-a")
            public_id = self._public_reply(gate, "pub-ok", "sent_confirmed")
            sidecar_mod, instance = self._instance()
            instance.gate = gate
            result = instance.send_private({"sendId": "priv-ok", "publicSendId": public_id,
                                            "target": {"authorId": "author-1"}, "text": "你好"})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "target_profile_mismatch",
                         "放行后应当继续走到成像校验（证明守卫已通过）")

    def test_batch_listing_gives_stable_reasons(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            gate = SendGate(td, "account-a")
            ok = self._public_reply(gate, "pub-batch-ok", "sent_confirmed")
            unknown = self._public_reply(gate, "pub-batch-unknown", "unknown")
            sidecar_mod, instance = self._instance()
            instance.gate = gate
            listing = instance.dispatch("comment_private_candidates", {"items": [
                {"eventId": "e1", "authorId": "author-1", "authorName": "A", "publicSendId": ok},
                {"eventId": "e2", "authorId": "author-2", "publicSendId": unknown},
                {"eventId": "e3", "authorId": "author-3"},
                {"eventId": "e4", "authorId": "", "publicSendId": ok}]})
        self.assertEqual([item["eventId"] for item in listing["allowed"]], ["e1"])
        self.assertEqual([(item["eventId"], item["reason"]) for item in listing["rejected"]],
                         [("e2", "public_unknown"), ("e3", "public_missing"),
                          ("e4", "missing_author_id")])
        self.assertEqual(listing["policy"]["allowPublicStates"], ["sent_confirmed"])


    # ---- 用户卡片（学自用户真机演示的入口）：失败关闭语义 ----

    def test_user_card_is_not_guessed_when_the_nickname_is_missing(self):
        """昵称找不到时不许猜坐标：直接 nickname_not_found。"""
        import live

        class Cdp:
            def eval_json(self, _expression):
                return {"ok": False, "reason": "nickname_not_found"}

        result = live.open_user_card(Cdp(), {"authorName": "N", "text": "怎么做"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "nickname_not_found")

    def test_user_card_reports_when_it_never_opens(self):
        """卡片始终不出现 -> card_not_opened，且确实做过悬停动作。"""
        import live

        class Cdp:
            def __init__(self):
                self.moves = 0

            def eval_json(self, expression):
                if "userMenuPanel" in expression:
                    return []                      # 一直没有可见卡片
                return {"ok": True, "x": 100, "y": 200}

            def call(self, *_args, **_kwargs):
                self.moves += 1
                return {}

        cdp = Cdp()
        result = live.open_user_card(cdp, {"authorName": "N", "text": "怎么做"},
                                     wait_seconds=0.2, interval=0.05)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "card_not_opened")
        self.assertGreater(cdp.moves, 0, "应当真的把鼠标移到昵称上悬停")

    def test_user_card_action_requires_an_exact_label(self):
        """卡片条目按文案精确匹配；找不到就返回 card_action_not_found。"""
        import live
        card = {"items": [{"text": "关注", "x": 1, "y": 2},
                          {"text": "回复", "x": 3, "y": 4}]}
        hit = live.user_card_action(card, "回复")
        self.assertTrue(hit["ok"])
        self.assertEqual((hit["x"], hit["y"]), (3, 4))
        missing = live.user_card_action(card, "私信")
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["reason"], "card_action_not_found")
        self.assertFalse(live.user_card_action(card, "")["ok"])


class SearchPoolTests(unittest.TestCase):
    """找视频模块的三条缺口：搜索结果保存、videoId 交接、多账号池/游标隔离。

    此前 search 只把候选放在响应里 —— 宿主重启就只剩自己内存里那份池子，
    而且「选中某个候选交给评论区」没有正式链路，只能自己拼 URL。
    """

    KEYWORD = "怎么做副业"

    class _Page:
        def __init__(self, url=""):
            self.url = url

        def call(self, *_args, **_kwargs):
            return {}

        def evaluate(self, expression):
            if expression == "document.readyState":
                return "complete"
            if expression == "location.href":
                return self.url
            return None

        def eval_json(self, expression, timeout=None):
            # 登录态/验证码探针都走 eval_json：返回 None 表示"没看到弹窗、也没看到账号"
            # -> login_state 判 unknown（只有 required 才会中止搜索）。
            return None

        def close(self):
            pass

    @staticmethod
    def _videos():
        from crawl import video_relevance
        # 标题与相关度：整串命中 100 / 分词全命中 60 / 不命中 0。
        # （注：提问式关键词的「中心语档」修复属于另一个 PR，这里不依赖它。）
        rows = [("111", "怎么做副业赚的小钱", "甲", 100),
                ("222", "副业怎么做，顺带说说做副业的方法", "乙", 60),
                ("333", "完全无关的内容", "丙", 0)]
        out = []
        for video_id, title, author, _score in rows:
            video = {"aweme_id": video_id, "desc": title, "author": author,
                     "author_sec_uid": "sec-%s" % video_id,
                     "url": "https://www.douyin.com/video/%s" % video_id}
            video["_relevance"] = video_relevance(title, SearchPoolTests.KEYWORD)
            out.append(video)
        return out

    def _instance(self, state_dir, scope="account-a"):
        import search_pool
        import sidecar
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance.state_dir = state_dir
        instance.account_scope = scope
        instance.gate = SendGate(state_dir, scope)
        instance.video_pool = search_pool.SearchPool(state_dir, scope)
        instance._page = lambda: (self._Page(), {"pid": 1})
        return sidecar, instance

    def _search(self, instance, sidecar_mod, **params):
        original = sidecar_mod.crawlmod.search_videos
        sidecar_mod.crawlmod.search_videos = lambda *args, **kwargs: self._videos()
        try:
            return instance.search(dict({"keyword": self.KEYWORD}, **params))
        finally:
            sidecar_mod.crawlmod.search_videos = original

    def test_search_saves_every_collected_candidate_not_only_the_returned_ones(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td)
            result = self._search(instance, sidecar_mod, minRelevance=40)
            stats = instance.video_pool.stats()
        self.assertEqual([video["id"] for video in result["videos"]], ["111", "222"],
                         "低于 minRelevance 的候选不返回")
        self.assertEqual(result["poolSaved"]["inserted"], 3,
                         "池子必须记下【本次采集到的全部】视频，否则下一页会重复采集")
        self.assertEqual(result["poolSaved"]["total"], 3)
        self.assertEqual(stats["total"], 3)

    def test_repeat_search_upserts_instead_of_duplicating(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td)
            self._search(instance, sidecar_mod)
            second = self._search(instance, sidecar_mod)
            stats = instance.video_pool.stats()
        self.assertEqual(second["poolSaved"]["inserted"], 0)
        self.assertEqual(second["poolSaved"]["updated"], 3)
        self.assertEqual(stats["total"], 3)

    def test_saved_candidates_are_listed_by_the_pool_method(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td)
            self._search(instance, sidecar_mod)
            listing = instance.dispatch("search_pool", {"minRelevance": 40})
        self.assertEqual(listing["status"], "ok")
        self.assertEqual([video["videoId"] for video in listing["videos"]], ["111", "222"])
        self.assertEqual(listing["videos"][0]["relevance"]["score"], 100)
        self.assertEqual(listing["stats"]["keywords"], 1)

    def test_pool_is_isolated_per_account_scope(self):
        """同一个库文件，两个账号互不可见（多账号并行时这是数据正确性问题）。"""
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, account_a = self._instance(td, scope="account-a")
            self._search(account_a, sidecar_mod)
            _, account_b = self._instance(td, scope="account-b")
            listing_b = account_b.dispatch("search_pool", {})
            listing_a = account_a.dispatch("search_pool", {})
        self.assertEqual(len(listing_a["videos"]), 3)
        self.assertEqual(listing_b["videos"], [])
        self.assertEqual(listing_b["stats"]["total"], 0)

    def test_cursor_from_another_account_is_refused(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, account_a = self._instance(td, scope="account-a")
            result = self._search(account_a, sidecar_mod)
            _, account_b = self._instance(td, scope="account-b")
            with self.assertRaises(sidecar.SidecarError) as raised:
                account_b.search({"keyword": self.KEYWORD, "cursor": result["cursor"]})
        self.assertEqual(raised.exception.code, "cursor_account_mismatch")

    def test_video_id_is_the_formal_handoff_into_the_comment_area(self):
        """videoId 取自池子 —— 宿主不必自己拼 URL，来源关键词与相关度也不丢。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td)
            self._search(instance, sidecar_mod)
            resolved = sidecar._resolve_video_url(instance, {"videoId": "111"})
            with self.assertRaises(sidecar.SidecarError) as raised:
                sidecar._resolve_video_url(instance, {"videoId": "999"})
        self.assertEqual(resolved, "https://www.douyin.com/video/111")
        self.assertEqual(raised.exception.code, "unknown_video_id")


class CommentBatchFlowTests(unittest.TestCase):
    """评论批次契约：评论批次 -> 逐条公开回复 -> 确认后私信。

    这是协作者侧缺口清单里的第 2 条：此前评论区只有【单条】发送路径，
    「评论批次 → 逐条公开回复 → 确认后私信」这条固定流程接不起来 ——
    单条发送可以靠宿主自觉，两阶段契约（只有 sent_confirmed 才允许私信）不行。

    全部离线：采集被替换成固定结果，发送函数被替换成假实现，
    所有边界校验必须在打开浏览器【之前】完成（用 explode 的 _page 证明）。
    """

    VIDEO = "https://www.douyin.com/video/7501633234145447202"
    PUBLIC = "需要的话看我主页，我整理了一份"
    PRIVATE = "你好，看到你在评论区留言了"

    class _Page:
        def call(self, *_args, **_kwargs):
            return {}

        def evaluate(self, expression):
            return "complete" if expression == "document.readyState" else None

        def close(self):
            pass

    @staticmethod
    def _targets(count=2):
        return [{"id": "e%d" % index, "source": "video",
                 "roomId": CommentBatchFlowTests.VIDEO,
                 "authorId": "author-%d" % index, "authorName": "用户%d" % index,
                 "text": "求带搞钱，在线等！", "observedAt": "2026-09-21T05:00:00Z",
                 "fingerprint": "fp%d" % index, "matchedKeyword": "求带", "digg": 3}
                for index in range(1, count + 1)]

    @staticmethod
    def _collected(targets):
        return {"status": "ok", "events": targets, "targets": targets,
                "filter": {"collected": 40, "matched": len(targets),
                           "targetCount": len(targets), "matchMode": "phrase",
                           "keywords": ["求带"], "modeCounts": {"phrase": len(targets)}}}

    def _instance(self, state_dir, collected, explode=False):
        import comment_flow
        import sidecar
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance.state_dir = state_dir
        instance.account_scope = "account-a"
        instance.gate = SendGate(state_dir, "account-a")
        instance.comment_queue = comment_flow.CommentQueue(state_dir, "account-a")
        instance.collect_comments = lambda params: collected
        if explode:
            def boom():
                raise AssertionError("这一阶段不该打开浏览器")
            instance._page = boom
        else:
            instance._page = lambda: (self._Page(), {"pid": 1})
        return sidecar, instance

    def _plan_params(self, **overrides):
        params = {"url": self.VIDEO, "publicText": self.PUBLIC, "privateText": self.PRIVATE,
                  "commentKeywords": "求带", "matchMode": "phrase"}
        params.update(overrides)
        return params

    def test_plan_refuses_missing_scripts_before_any_browser_action(self):
        """话术不完整就不建批次 —— fail-closed，连浏览器都不开。"""
        import sidecar
        for missing in ("publicText", "privateText"):
            with tempfile.TemporaryDirectory() as td:
                sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)),
                                                       explode=True)
                params = self._plan_params()
                params.pop(missing)
                with self.assertRaises(sidecar.SidecarError) as raised:
                    instance.comment_plan(params)
                self.assertEqual(raised.exception.code, "invalid_input")
                label = "public_text" if missing == "publicText" else "private_text"
                self.assertIn(label, str(raised.exception.message))

    def test_caller_supplied_policy_is_refused(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)),
                                                   explode=True)
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance.comment_plan(self._plan_params(policy={"maxPrivate": 50}))
            self.assertEqual(raised.exception.code, "policy_not_server_issued")

    def test_plan_freezes_one_host_script_for_every_target(self):
        """宿主给【一套】话术，套用到批次内每个目标上，并冻结成计划。"""
        import hashlib
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(3)))
            result = instance.comment_plan(self._plan_params())
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["targets"]), 3)
        self.assertEqual({target["publicText"] for target in result["targets"]}, {self.PUBLIC})
        self.assertEqual({target["privateText"] for target in result["targets"]}, {self.PRIVATE})
        self.assertEqual(result["scriptSource"], "host")
        self.assertTrue(result["batch"]["frozen"])
        self.assertEqual(result["filter"]["matched"], 3)
        self.assertEqual(result["publicTextSha256"],
                         hashlib.sha256(self.PUBLIC.encode("utf-8")).hexdigest())

    def test_plan_is_empty_without_a_single_matching_comment(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected([]))
            result = instance.comment_plan(self._plan_params())
        self.assertEqual(result["status"], "empty")
        self.assertIsNone(result["batch"])
        self.assertEqual(result["targets"], [])

    def test_terminal_collect_status_is_passed_through(self):
        """验证码/未登录/不支持的图文帖都是【终止态】：不建批次。"""
        for status in ("captcha", "login_required", "unsupported"):
            with tempfile.TemporaryDirectory() as td:
                collected = {"status": status, "events": [], "targets": [], "filter": {}}
                sidecar_mod, instance = self._instance(td, collected)
                result = instance.comment_plan(self._plan_params())
            self.assertEqual(result["status"], status)
            self.assertIsNone(result["batch"])

    def test_reply_blocks_a_rewritten_script_and_sends_nothing(self):
        """话术必须与冻结的那份逐字一致：改写就 blocked，且不打开浏览器。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)),
                                                   explode=True)
            original = sidecar.send_comment
            calls = []
            sidecar.send_comment = lambda *args, **kwargs: calls.append(args) or {"status": "unknown"}
            try:
                plan = instance.comment_plan(self._plan_params())
                out = instance.comment_reply({"batchId": plan["batch"]["batchId"], "items": [
                    {"eventId": "e1", "sendId": "pub-e1", "text": "我自己改写的话术"}]})
            finally:
                sidecar.send_comment = original
        self.assertEqual(calls, [], "改写话术时不得调用发送")
        self.assertEqual(out["status"], "blocked")
        self.assertEqual(out["results"][0]["reason"], "script_mismatch")

    def test_unknown_public_reply_never_becomes_a_private_message(self):
        """本通道常态是 unknown：必须挡在私信之外，且不打开浏览器。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            # 公屏那一步是【确实会打开浏览器】的（它就是发送动作），
            # 这里只在【私信那一步】要求 fail-closed。
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)))
            original = sidecar.send_comment
            def unknown_comment(*args, **kwargs):
                send_id = args[2]
                target = args[3]
                text = args[4]
                instance.gate.reserve(send_id, target["authorId"], text, kind="comment")
                instance.gate.finish(send_id, "unknown", "platform_response_unavailable")
                return {"status": "unknown", "reason": "platform_response_unavailable",
                        "sendId": send_id}
            sidecar.send_comment = unknown_comment
            try:
                plan = instance.comment_plan(self._plan_params())
                batch_id = plan["batch"]["batchId"]
                reply = instance.comment_reply({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "pub-e1"}]})
                private = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1", "publicSendId": "pub-e1"}]})
            finally:
                sidecar.send_comment = original
        self.assertEqual(reply["results"][0]["status"], "unknown")
        self.assertEqual(reply["privateCandidates"], [])
        self.assertEqual(reply["privateRejected"][0]["reason"], "public_unknown")
        self.assertEqual(private["status"], "blocked")
        self.assertEqual(private["results"][0]["reason"], "public_unknown")

    def test_confirmed_public_reply_opens_the_private_phase(self):
        """只有 sent_confirmed 放行私信；放行后私信阶段的 sendId 绑定要留痕。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)))
            original_comment = sidecar.send_comment
            original_private = sidecar.send_private
            def confirmed_comment(*args, **kwargs):
                send_id = args[2]
                target = args[3]
                text = args[4]
                instance.gate.reserve(send_id, target["authorId"], text, kind="comment")
                instance.gate.finish(send_id, "sent_confirmed", "platform_response_recorded")
                return {"status": "sent_confirmed", "reason": "platform_response_recorded",
                        "sendId": send_id}
            sidecar.send_comment = confirmed_comment
            sidecar.send_private = lambda *args, **kwargs: {
                "status": "unknown", "reason": "platform_response_unavailable",
                "sendId": args[2]}
            try:
                plan = instance.comment_plan(self._plan_params())
                batch_id = plan["batch"]["batchId"]
                reply = instance.comment_reply({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "pub-e1"}]})
                private = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1", "publicSendId": "pub-e1"}]})
                report = instance.comment_result({"batchId": batch_id})
            finally:
                sidecar.send_comment = original_comment
                sidecar.send_private = original_private
        self.assertEqual(reply["privateCandidates"][0]["eventId"], "e1")
        self.assertEqual(reply["privateCandidates"][0]["publicSendId"], "pub-e1")
        self.assertEqual(private["status"], "ok")
        self.assertEqual(private["results"][0]["status"], "unknown")
        self.assertEqual(report["counts"].get("sent_confirmed"), 1)
        self.assertEqual(report["privateCounts"].get("unknown"), 1)
        self.assertEqual(report["checkpoint"]["phase"], "private")

    def test_private_refuses_a_public_send_id_that_belongs_elsewhere(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)))
            original = sidecar.send_comment
            def confirmed_comment(*args, **kwargs):
                send_id = args[2]
                target = args[3]
                text = args[4]
                instance.gate.reserve(send_id, target["authorId"], text, kind="comment")
                instance.gate.finish(send_id, "sent_confirmed", "platform_response_recorded")
                return {"status": "sent_confirmed", "reason": "platform_response_recorded",
                        "sendId": send_id}
            sidecar.send_comment = confirmed_comment
            try:
                plan = instance.comment_plan(self._plan_params())
                batch_id = plan["batch"]["batchId"]
                instance.comment_reply({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "pub-e1"}]})
                out = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1", "publicSendId": "pub-OTHER"}]})
            finally:
                sidecar.send_comment = original
        self.assertEqual(out["results"][0]["reason"], "public_not_found")

    def test_private_requires_public_send_id_before_browser(self):
        """批次私信和单发入口一样，缺绑定 ID 时不能打开浏览器。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)))
            original_comment = sidecar.send_comment
            sidecar.send_comment = lambda *args, **kwargs: {
                "status": "sent_confirmed", "reason": "platform_response_recorded",
                "sendId": args[2]}
            try:
                plan = instance.comment_plan(self._plan_params())
                batch_id = plan["batch"]["batchId"]
                instance.comment_reply({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "pub-e1"}]})
                def boom():
                    raise AssertionError("缺 publicSendId 时不应打开浏览器")
                instance._page = boom
                out = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1"}]})
            finally:
                sidecar.send_comment = original_comment
        self.assertEqual(out["status"], "blocked")
        self.assertEqual(out["results"][0]["reason"], "public_missing")

    def test_private_requires_the_public_send_to_be_confirmed(self):
        """有绑定 ID 也必须是台账中的已确认公屏回复。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)))
            original_comment = sidecar.send_comment
            sidecar.send_comment = lambda *args, **kwargs: {
                "status": "sent_confirmed", "reason": "platform_response_recorded",
                "sendId": args[2]}
            try:
                plan = instance.comment_plan(self._plan_params())
                batch_id = plan["batch"]["batchId"]
                instance.comment_reply({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "pub-e1"}]})
                instance._page = lambda: (_ for _ in ()).throw(
                    AssertionError("未知 publicSendId 时不应打开浏览器"))
                out = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1", "publicSendId": "pub-other"}]})
            finally:
                sidecar.send_comment = original_comment
        self.assertEqual(out["status"], "blocked")
        self.assertEqual(out["results"][0]["reason"], "public_not_found")

    def test_private_refuses_a_public_send_id_that_belongs_to_another_target(self):
        """错误绑定：拿 B 的公屏成功去给 A 发私信，必须拒绝而不是发送。

        评审意见：确认每条私信都必须绑定【对应的】publicSendId。
        只校验"存在一个已确认的公屏回复"是不够的 —— 张冠李戴同样会触达错人。
        """
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(2)))
            original_comment = sidecar.send_comment
            original_private = sidecar.send_private
            sent = []
            # 基线的私信门禁会先在【本地台账】里查这个 publicSendId，
            # 所以这里要真的把两次公屏回复登记成 confirmed，否则会先撞上 public_not_found，
            # 覆盖不到"绑定张冠李戴"这条。
            for public_id in ("pub-e1", "pub-e2"):
                instance.gate.reserve(public_id, "comment:%s:author" % public_id,
                                      "public text", kind="comment")
                instance.gate.mark_started(public_id)
                instance.gate.finish(public_id, "sent_confirmed", "platform_response_recorded")
            sidecar.send_comment = lambda *args, **kwargs: {
                "status": "sent_confirmed", "reason": "platform_response_recorded",
                "sendId": args[2]}
            sidecar.send_private = lambda *args, **kwargs: sent.append(args) or {
                "status": "unknown", "reason": "platform_response_unavailable"}
            try:
                plan = instance.comment_plan(self._plan_params())
                batch_id = plan["batch"]["batchId"]
                instance.comment_reply({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "pub-e1"},
                    {"eventId": "e2", "sendId": "pub-e2"}]})
                wrong = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1", "publicSendId": "pub-e2"}]})
                right = instance.comment_private({"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "priv-e1b", "publicSendId": "pub-e1"}]})
            finally:
                sidecar.send_comment = original_comment
                sidecar.send_private = original_private
        self.assertEqual(wrong["results"][0]["reason"], "public_send_id_mismatch")
        self.assertEqual(len(sent), 1, "只有绑定正确的那一次才允许真的发出去")
        self.assertEqual(right["results"][0]["status"], "unknown")

    def test_private_without_a_public_send_id_is_refused_by_the_batch_view(self):
        """缺失绑定：批量清单里没有 publicSendId 的条目一律 public_missing。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            sidecar_mod, instance = self._instance(td, self._collected(self._targets(1)),
                                                   explode=True)
            listing = instance.dispatch("comment_private_candidates", {"items": [
                {"eventId": "e1", "authorId": "author-1", "authorName": "用户1"}]})
        self.assertEqual(listing["allowed"], [])
        self.assertEqual(listing["rejected"][0]["reason"], "public_missing")

    def test_expired_events_are_not_replayed_into_a_batch(self):
        """批次窗口：过期的候选不会重新进批次（评论区窗口远长于弹幕，但语义一致）。"""
        import comment_flow
        clock = {"now": 1000.0}
        with tempfile.TemporaryDirectory() as td:
            queue = comment_flow.CommentQueue(td, "account-a", clock=lambda: clock["now"])
            queue.append(self._targets(1))
            clock["now"] += comment_flow.WINDOW_DEFAULT + 1
            batch = queue.take_batch(max_items=5)
        self.assertEqual(batch["events"], [])
        self.assertEqual(batch["expiredCount"], 1)


class ClickGuardTests(unittest.TestCase):
    """受约束点击的回归（2026-09-20 事故：点击落到了浏览器地址栏 / 页面头像）。"""

    class _Cdp:
        def __init__(self, probe):
            self.probe = probe
            self.clicks = []

        def eval_json(self, _expression):
            return self.probe

        def click_at(self, x, y):
            self.clicks.append((x, y))

    def test_refuses_when_the_point_is_not_the_expected_element(self):
        import click_guard
        cdp = self._Cdp({"ok": True, "expectHit": False, "textHit": None, "containerOk": None,
                         "hit": {"tag": "span", "cls": "semi-avatar", "textLen": 0}, "chain": []})
        result = click_guard.click_checked(cdp, 10, 10,
                                           expect_selectors=['[class*="content-with-emoji-text"]'],
                                           label="unit")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "click_target_mismatch")
        self.assertEqual(cdp.clicks, [], "被拒绝时绝不能真的点下去")

    def test_refuses_when_the_point_is_outside_the_container(self):
        import click_guard
        cdp = self._Cdp({"ok": True, "expectHit": True, "textHit": None, "containerOk": False,
                         "hit": {"tag": "div", "cls": "x", "textLen": 1}, "chain": []})
        result = click_guard.click_checked(cdp, 10, 10, container_box=[100, 200, 320, 500],
                                           label="unit")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "click_outside_container")
        self.assertEqual(cdp.clicks, [])

    def test_refuses_when_the_expected_text_is_missing(self):
        import click_guard
        cdp = self._Cdp({"ok": True, "expectHit": True, "textHit": False, "containerOk": True,
                         "hit": {"tag": "div", "cls": "y", "textLen": 3}, "chain": []})
        result = click_guard.click_checked(cdp, 10, 10, expect_text="私信", label="unit")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "click_text_mismatch")
        self.assertEqual(cdp.clicks, [])

    def test_nothing_at_point_is_refused(self):
        import click_guard
        cdp = self._Cdp({"ok": False, "reason": "nothing_at_point"})
        result = click_guard.click_checked(cdp, 10, 10, label="unit")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "nothing_at_point")
        self.assertEqual(cdp.clicks, [])

    def test_clicks_only_when_every_check_passes_and_records_an_audit_line(self):
        import json
        import click_guard
        with tempfile.TemporaryDirectory() as td:
            audit = os.path.join(td, "click_audit.jsonl")
            click_guard.set_audit_path(audit)
            try:
                cdp = self._Cdp({"ok": True, "expectHit": True, "textHit": True, "containerOk": True,
                                 "hit": {"tag": "li", "cls": "semi-dropdown-item", "textLen": 8},
                                 "chain": ["li.semi-dropdown-item"]})
                result = click_guard.click_checked(cdp, 1537, 360, expect_selectors=["li"],
                                                   expect_text="回复", label="choose_reply")
                self.assertTrue(result["ok"])
                self.assertEqual(cdp.clicks, [(1537, 360)])
                with open(audit, "r", encoding="utf-8") as fh:
                    lines = [json.loads(line) for line in fh if line.strip()]
            finally:
                click_guard.set_audit_path(None)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0]["clicked"])
        self.assertEqual(lines[0]["label"], "choose_reply")
        self.assertEqual(lines[0]["probe"]["hit"]["cls"], "semi-dropdown-item")

    def test_refused_click_is_also_audited(self):
        import json
        import click_guard
        with tempfile.TemporaryDirectory() as td:
            audit = os.path.join(td, "click_audit.jsonl")
            click_guard.set_audit_path(audit)
            try:
                cdp = self._Cdp({"ok": True, "expectHit": False, "textHit": None, "containerOk": None,
                                 "hit": {"tag": "div", "cls": "omnibox", "textLen": 0}, "chain": []})
                click_guard.click_checked(cdp, 1, 2, expect_selectors=["li"], label="refused")
                with open(audit, "r", encoding="utf-8") as fh:
                    lines = [json.loads(line) for line in fh if line.strip()]
            finally:
                click_guard.set_audit_path(None)
        self.assertFalse(lines[0]["clicked"])
        self.assertEqual(lines[0]["reason"], "click_target_mismatch")


class ChatScrollTests(unittest.TestCase):
    """聊天列表滚动的回归（直播间列表一直自动滚动，是点击打偏的根因）。"""

    def test_scroll_refuses_without_the_main_chat_list(self):
        import live

        class Cdp:
            def eval_json(self, _expression):
                return {"found": False, "reason": "main_chat_list_not_found"}

            def call(self, *_args, **_kwargs):
                raise AssertionError("没有主列表时不得发滚轮事件")

        result = live.scroll_chat_list(Cdp(), "up")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "main_chat_list_not_found")

    def test_scroll_up_sends_a_negative_wheel_delta_at_the_list_center(self):
        import live
        calls = []

        class Cdp:
            def eval_json(self, _expression):
                return {"found": True, "box": [1000, 300, 320, 500]}

            def call(self, method, params=None, timeout=None):
                calls.append((method, params))
                return {}

        result = live.scroll_chat_list(Cdp(), "up", amount=420, times=2)
        self.assertTrue(result["ok"])
        wheels = [item for item in calls if item[0] == "Input.dispatchMouseEvent"]
        self.assertEqual(len(wheels), 2)
        self.assertTrue(all(item[1]["deltaY"] == -420 for item in wheels), "上滚必须是负 deltaY")
        self.assertEqual((wheels[0][1]["x"], wheels[0][1]["y"]), (1160, 550))

    def test_pause_autoscroll_reports_whether_the_list_settled(self):
        import live
        original = (live.main_chat_list, live.chat_list_tail, live.scroll_chat_list)
        # 第一次调用：前后一致（停住了）；第二次调用：前后不一致（还在自动滚动）
        scripted = [{"ok": True, "key": "a"}, {"ok": True, "key": "a"},
                    {"ok": True, "key": "b"}, {"ok": True, "key": "c"}]
        live.main_chat_list = lambda _cdp: {"found": True, "box": [0, 0, 320, 500]}
        live.chat_list_tail = lambda _cdp, box=None: scripted.pop(0)
        live.scroll_chat_list = lambda *_a, **_k: {"ok": True}
        try:
            settled = live.pause_autoscroll(object(), settle=0.01)
            self.assertTrue(settled["ok"])
            self.assertTrue(settled["paused"])
            moving = live.pause_autoscroll(object(), settle=0.01)
        finally:
            live.main_chat_list, live.chat_list_tail, live.scroll_chat_list = original
        self.assertFalse(moving["paused"], "列表仍在动时必须如实报告，不能假装停住了")


class RoomUrlTests(unittest.TestCase):
    """真机回归（2026-09-20）：抖音直播广场点进来的房间，房间号在【查询串】里。

    症状：地址是 https://live.douyin.com/?anchor_id=...&live_web_rid=423909340168，路径为空。
    旧代码 split("?")[0] 只得到 https://live.douyin.com/（没有房间号），
    于是 target.roomId 校验失败（path is required），一条回复都发不出去；
    就算 roomId 拼对了，"校验当前页面"那一步还会抛 URLPolicyError。
    """

    SQUARE = ("https://live.douyin.com/?anchor_id=257730616498059&category_name=all"
              "&is_vs=0&live_web_rid=423909340168&page_type=main_category")
    PATH = "https://live.douyin.com/423909340168"

    def test_room_id_is_read_from_the_query_of_a_square_url(self):
        import live
        self.assertEqual(live.room_id_from_url(self.SQUARE), "423909340168")
        self.assertEqual(live.room_id_from_url(self.PATH), "423909340168")
        self.assertEqual(live.room_id_from_url(self.PATH + "?foo=1"), "423909340168")
        self.assertEqual(live.room_id_from_url("https://live.douyin.com/?web_rid=8888"), "8888")

    def test_room_id_refuses_addresses_without_a_room(self):
        import live
        for value in ("https://live.douyin.com/", "https://live.douyin.com/?anchor_id=1",
                      "https://www.douyin.com/user/abc", "https://live.douyin.com/rooms",
                      "https://live.douyin.com/?live_web_rid=abc", "", None):
            self.assertEqual(live.room_id_from_url(value), "", repr(value))

    def test_current_room_url_normalizes_the_open_tab(self):
        import live

        class Cdp:
            def __init__(self, href):
                self.href = href

            def evaluate(self, _expression):
                return self.href

        self.assertEqual(live.current_room_url(Cdp(self.SQUARE)), self.PATH)
        self.assertEqual(live.current_room_url(Cdp("https://www.douyin.com/user/abc")), "")

    def test_canonical_room_treats_both_address_forms_as_one_room(self):
        import send_actions
        square = send_actions._canonical_room(self.SQUARE)
        self.assertEqual(square, send_actions._canonical_room(self.PATH))
        self.assertEqual(square, ("live.douyin.com", "/423909340168"))
        self.assertIsNone(send_actions._canonical_room("https://live.douyin.com/"),
                          "没有房间号的地址不是合法房间，必须判不合法，而不是当成空路径的房间")
        self.assertEqual(send_actions._canonical_room("https://www.douyin.com/video/7"),
                         ("www.douyin.com", "/video/7"))

    def test_resolved_room_url_rebuilds_the_square_address_instead_of_raising(self):
        import send_actions
        self.assertEqual(send_actions._resolved_room_url(self.SQUARE), self.PATH)
        self.assertEqual(send_actions._resolved_room_url(self.PATH), self.PATH)
        self.assertEqual(send_actions._resolved_room_url("https://www.douyin.com/user/abc"),
                         "https://www.douyin.com/user/abc")
        with self.assertRaises(URLPolicyError):
            send_actions._resolved_room_url("https://live.douyin.com/")


class RoomEchoTests(unittest.TestCase):
    """roomEcho 的匹配语义：它只是【证据】，不能变成送达判据（红线 2）。"""

    @staticmethod
    def _echo(rows, text, composer_text=""):
        import live
        original = (live.collect_feed, live.find_composer)
        live.collect_feed = lambda _cdp: {"rows": rows}
        live.find_composer = lambda _cdp: {"found": True, "text": composer_text}
        try:
            return live.wait_room_echo(object(), text, seconds=0.01, interval=0.01)
        finally:
            live.collect_feed, live.find_composer = original

    def test_identical_text_is_reported_as_a_full_match(self):
        result = self._echo([{"text": "公共回复文案", "authorName": "me"}], "公共回复文案")
        self.assertTrue(result["row"])
        self.assertEqual(result["matchedBy"], "full")

    def test_platform_rendered_mention_still_matches_on_the_body(self):
        # 平台会把提及渲染成 [@某人] 这类 token，整条比不出来，正文必须能兜住。
        result = self._echo([{"text": "[@某人]你好呀", "authorName": "me"}], "@某人 你好呀")
        self.assertTrue(result["row"])
        self.assertEqual(result["matchedBy"], "body")

    def test_missing_echo_reports_no_row(self):
        result = self._echo([{"text": "别人的弹幕"}], "我们没发过这条", composer_text="")
        self.assertIsNone(result["row"])

    def test_a_one_character_body_is_not_enough_to_claim_an_echo(self):
        # 只发一个字时"正文包含"会误报（房间里到处都是这个字），必须拒绝。
        result = self._echo([{"text": "好", "authorName": "other"}], "@某人 好")
        self.assertIsNone(result["row"])

    def test_composer_state_is_reported_even_without_an_echo(self):
        result = self._echo([], "发出去的文案", composer_text="")
        self.assertTrue(result["composerCleared"])


class ReplyViaTests(unittest.TestCase):
    """公屏回复的两条通道（native / mention_text）在【冻结计划时】定稿。"""

    @staticmethod
    def _queue(td, author_name="小***"):
        import live_flow
        queue = live_flow.LiveQueue(td, "account-a", clock=lambda: 1000.0)
        queue.append([{"kind": "live", "roomId": "room-1", "id": "e1", "authorId": "u1",
                       "authorName": author_name, "text": "问一下"}])
        return queue

    def _plan(self, td, public, via="native", name="小***"):
        queue = self._queue(td, author_name=name)
        batch = queue.take_batch(max_items=10, window_seconds=600)
        return queue, queue.freeze_plan(batch["batchId"],
                                        {"e1": {"publicText": public, "privateText": "私信话术"}},
                                        reply_mode="danmaku", reply_via=via)

    def test_native_reply_rejects_a_script_that_starts_with_at(self):
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue, plan = self._plan(td, "@小*** 你好")
            self.assertEqual(plan["targets"], [])
            self.assertEqual(plan["blocked"], [{"eventId": "e1",
                                                "reason": "body_must_not_start_with_at"}])
            self.assertEqual(plan["replyVia"], "native")
            self.assertEqual(queue.find_event("e1")["state"], live_flow.BLOCKED)

    def test_native_reply_allows_a_masked_nickname(self):
        # 原生通道里提及由平台插入，昵称读不全（小***）照样能 @ 到人。
        with tempfile.TemporaryDirectory() as td:
            _queue, plan = self._plan(td, "你好呀")
            self.assertEqual([item["eventId"] for item in plan["targets"]], ["e1"])
            self.assertEqual(plan["replyVia"], "native")

    def test_mention_text_reply_requires_the_at_prefix_and_rejects_masked_names(self):
        with tempfile.TemporaryDirectory() as td:
            _queue, plan = self._plan(td, "你好呀", via="mention_text", name="小明")
            self.assertEqual(plan["blocked"][0]["reason"], "mention_prefix_missing")
        with tempfile.TemporaryDirectory() as td:
            _queue, plan = self._plan(td, "@小*** 你好呀", via="mention_text")
            self.assertEqual(plan["blocked"][0]["reason"], "nickname_masked")
        with tempfile.TemporaryDirectory() as td:
            _queue, plan = self._plan(td, "@小明 你好呀", via="mention_text", name="小明")
            self.assertEqual([item["eventId"] for item in plan["targets"]], ["e1"])
            self.assertEqual(plan["replyVia"], "mention_text")

    def test_reply_via_is_rejected_for_other_modes_and_unknown_values(self):
        import live_flow
        with tempfile.TemporaryDirectory() as td:
            queue = self._queue(td)
            batch = queue.take_batch(max_items=10, window_seconds=600)
            with self.assertRaises(live_flow.LiveFlowError):
                queue.freeze_plan(batch["batchId"], {"e1": {"publicText": "x", "privateText": "y"}},
                                  reply_mode="composer", reply_via="mention_text")
            with self.assertRaises(live_flow.LiveFlowError):
                queue.freeze_plan(batch["batchId"], {"e1": {"publicText": "x", "privateText": "y"}},
                                  reply_mode="danmaku", reply_via="guessed")


class SidecarReplyViaDispatchTests(unittest.TestCase):
    """sidecar 必须按冻结计划里的 replyVia 分派到对应发送通道（不是按调用方参数）。"""

    EVENT = {"id": "e1", "authorId": "u1", "authorName": "小***", "text": "问一下"}

    class Page:
        def close(self):
            pass

    def _instance(self, td):
        import sidecar
        instance = sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19226)
        instance._page = lambda: (self.Page(), {"pid": 1})
        return instance

    def _run(self, via, public="你好呀", author_name="小***"):
        import live_flow
        import sidecar
        calls = []
        originals = (sidecar.send_danmaku_reply_native, sidecar.send_danmaku_reply,
                     sidecar.send_comment)
        sidecar.send_danmaku_reply_native = lambda *a, **k: (
            calls.append("native") or {"status": "unknown", "evidence": {"roomEcho": True}})
        sidecar.send_danmaku_reply = lambda *a, **k: (
            calls.append("mention_text") or {"status": "unknown", "evidence": {"roomEcho": True}})
        sidecar.send_comment = lambda *a, **k: (
            calls.append("comment") or {"status": "unknown"})
        try:
            with tempfile.TemporaryDirectory() as td:
                instance = self._instance(td)
                event = dict(self.EVENT, authorName=author_name)
                instance.live_queue.append([sidecar._event("live", "room-1", event)])
                planned = instance.dispatch("live_plan", {
                    "maxItems": 10, "windowSeconds": 600, "replyMode": "danmaku",
                    "replyVia": via, "scripts": {"e1": {"publicText": public,
                                                        "privateText": "私信话术"}}})
                self.assertEqual(planned["status"], "ok", planned)
                self.assertEqual(planned["replyVia"], via)
                batch_id = planned["batch"]["batchId"]
                reply = instance.dispatch("live_reply", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "s-%s" % via}]})
                self.assertEqual(reply["status"], "ok", reply)
                self.assertEqual(instance.live_queue.find_event("e1")["state"],
                                 live_flow.SENT_ECHOED)
        finally:
            (sidecar.send_danmaku_reply_native, sidecar.send_danmaku_reply,
             sidecar.send_comment) = originals
        return calls

    def test_native_plan_dispatches_to_the_native_sender(self):
        self.assertEqual(self._run("native"), ["native"])

    def test_mention_text_plan_dispatches_to_the_text_sender(self):
        self.assertEqual(self._run("mention_text", public="@小明 你好呀", author_name="小明"),
                         ["mention_text"])

    def test_unknown_via_is_rejected_before_any_browser_work(self):
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = self._instance(td)
            with self.assertRaises(sidecar.SidecarError):
                instance.dispatch("live_plan", {"maxItems": 10, "windowSeconds": 600,
                                                "replyMode": "danmaku", "replyVia": "guessed",
                                                "scripts": {}})


class IdentityVisibilityTests(unittest.TestCase):
    """真机事实（2026-09-20，两个房间对比）：观众身份不一定可见，不可见时必须 fail-closed。

    房间 689015985670：16/16 条弹幕带真实 sec_uid，可打开主页私信。
    房间 423909340168：观众行 sec_uid 为空、uid 是占位值 111111、昵称已脱敏，
    只有主播自己的消息带 sec_uid；拿 111111 拼出来的主页是错误页。
    """

    SEC = "MS4wLjABAAAAbp6Jd7TQ3H0LiKYb8wBlRCQHY5dBGQlFEA1__xMq5VBmNHWPHlJUNBP5xt3fZdyS"

    def test_sec_uid_is_dm_capable_and_a_placeholder_uid_is_not(self):
        import live
        self.assertTrue(live.dm_capable(self.SEC, "452620235059355"))
        for bad in ("", None, "111111", "abc", "MS4wLj"):
            self.assertFalse(live.dm_capable(bad, "111111"), repr(bad))
            self.assertFalse(live.dm_capable("", bad), repr(bad))

    def test_collected_rows_carry_identity_visibility(self):
        import live
        original = live.collect_feed
        live.collect_feed = lambda _cdp: {"ok": True, "rows": [
            {"id": "m1", "sec_uid": self.SEC, "uid": "42", "authorName": "A", "text": "hi"},
            {"id": "m2", "sec_uid": "", "uid": "111111", "authorName": "B***", "text": "hi"}]}
        try:
            rows = live.collect_events(object(), max_items=10)
        finally:
            live.collect_feed = original
        self.assertTrue(rows[0]["dmCapable"])
        self.assertFalse(rows[1]["dmCapable"], "占位 uid 不能当成可私信身份")
        self.assertEqual(rows[1]["uid"], "111111")

    def test_profile_error_page_is_reported_instead_of_login_unknown(self):
        import douyin

        class Cdp:
            def __init__(self, value):
                self.value = value

            def eval_json(self, _expression):
                return self.value

        self.assertTrue(douyin.profile_error_page(Cdp(True)))
        self.assertFalse(douyin.profile_error_page(Cdp(False)))

    def test_profile_error_page_lookup_never_raises(self):
        import douyin

        class Boom:
            def eval_json(self, _expression):
                raise RuntimeError("boom")

        class NoEval:
            pass

        self.assertFalse(douyin.profile_error_page(Boom()))
        self.assertFalse(douyin.profile_error_page(NoEval()))

    def test_private_send_reports_a_missing_profile_before_any_click(self):
        import send_actions

        class Page:
            def __init__(self):
                self.clicks = []

            def call(self, *_args, **_kwargs):
                return {}

            def evaluate(self, expression):
                if expression == "document.readyState":
                    return "complete"
                if expression == "location.href":
                    return "https://www.douyin.com/user/111111"
                return None

            def eval_json(self, expression):
                # 只回答"是不是错误页"这一个问题，其余保持沉默。
                return True if "error-page" in expression else None

            def click_at(self, *args):
                self.clicks.append(args)

        old_sleep = send_actions.time.sleep
        send_actions.time.sleep = lambda _seconds: None
        try:
            with tempfile.TemporaryDirectory() as td:
                page = Page()
                result = send_actions.send_private(page, SendGate(td, "account-a"),
                                                   "gone-profile", {"authorId": "111111"}, "你好")
        finally:
            send_actions.time.sleep = old_sleep
        # 主页不存在 = 这个目标不可触达 -> 跳过（blocked + skipped），不是"发送失败"：
        # 我们一条消息都没发出去，失败状态会误导成通道故障（用户 2026-09-21 要求）。
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "profile_not_found")
        self.assertTrue(result["evidence"]["skipped"])
        self.assertEqual(page.clicks, [], "主页不存在时一个点击都不许发出去")


class PrivateSkipTests(unittest.TestCase):
    """私密账号 / 不接受陌生人私信的目标：跳过，不记成发送失败（用户 2026-09-21 要求）。

    判据来自真机：有的目标「私信」入口点得动、面板却始终不开（对方未互关 / 私密账号）。
    这时我们一条消息都没发出去 —— 失败状态会误导成"通道坏了"，而且会挡住后面的目标。
    """

    class Page:
        def __init__(self):
            self.clicks = []

        def call(self, *_args, **_kwargs):
            return {}

        def evaluate(self, expression):
            if expression == "document.readyState":
                return "complete"
            if expression == "location.href":
                return "https://www.douyin.com/user/" + ("A" * 40)
            return None

        def click_at(self, *args):
            self.clicks.append(args)

        def close(self):
            pass

    def _patched(self, entry, panel=None, clicks_expected=0):
        import douyin
        import send_actions
        page = self.Page()
        saved = (send_actions.douyin.login_state, send_actions.douyin.check_captcha,
                 send_actions.douyin.visibility_state, send_actions.douyin.dm_entry,
                 send_actions.douyin.dm_panel_state, send_actions.douyin.dm_composer_for_recipient,
                 send_actions.douyin.recipient_context, send_actions.douyin.profile_error_page,
                 send_actions.douyin.make_network_recorder, send_actions.time.sleep)
        send_actions.douyin.login_state = lambda _cdp: "verified"
        send_actions.douyin.check_captcha = lambda _cdp: False
        send_actions.douyin.visibility_state = lambda _cdp: "visible"
        send_actions.douyin.dm_entry = lambda _cdp: dict(entry)
        send_actions.douyin.dm_panel_state = lambda _cdp, _name: dict(panel or {"found": False})
        send_actions.douyin.dm_composer_for_recipient = lambda *_a, **_k: {"found": False}
        send_actions.douyin.recipient_context = lambda *_a, **_k: {"verified": True}
        send_actions.douyin.profile_error_page = lambda _cdp: False
        send_actions.time.sleep = lambda _seconds: None
        return page, saved

    def _restore(self, saved):
        import send_actions
        (send_actions.douyin.login_state, send_actions.douyin.check_captcha,
         send_actions.douyin.visibility_state, send_actions.douyin.dm_entry,
         send_actions.douyin.dm_panel_state, send_actions.douyin.dm_composer_for_recipient,
         send_actions.douyin.recipient_context, send_actions.douyin.profile_error_page,
         send_actions.douyin.make_network_recorder, send_actions.time.sleep) = saved

    def test_a_blocked_dm_entry_is_skipped_without_any_click(self):
        import send_actions
        author = "A" * 40
        page, saved = self._patched({"found": False, "blocked": True,
                                     "reason": "stranger_dm_disabled"})
        try:
            with tempfile.TemporaryDirectory() as td:
                result = send_actions.send_private(page, SendGate(td, "account-a"), "skip-1",
                                                   {"authorId": author, "authorName": "小明"}, "你好")
        finally:
            self._restore(saved)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "dm_not_available")
        self.assertTrue(result["evidence"]["skipped"])
        self.assertEqual(page.clicks, [], "对方不可私信时一个点击都不许发出去")

    def test_a_panel_that_never_opens_is_skipped_not_failed(self):
        import send_actions
        author = "A" * 40
        page, saved = self._patched({"found": True, "blocked": False, "x": 10, "y": 20},
                                    panel={"found": False})
        try:
            with tempfile.TemporaryDirectory() as td:
                result = send_actions.send_private(page, SendGate(td, "account-a"), "skip-2",
                                                   {"authorId": author, "authorName": "小明"}, "你好")
        finally:
            self._restore(saved)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "dm_panel_unavailable")
        self.assertTrue(result["evidence"]["skipped"])
        self.assertEqual(len(page.clicks), 3, "面板打不开时按入口重试次数上报，且不发消息")

    def test_sidecar_returns_the_skipped_list_separately(self):
        import live_flow
        import send_actions
        import sidecar
        author = "A" * 40
        page, saved = self._patched({"found": False, "blocked": True,
                                     "reason": "stranger_dm_disabled"})
        original_send = sidecar.send_private
        sidecar.send_private = send_actions.send_private
        try:
            with tempfile.TemporaryDirectory() as td:
                instance = sidecar.Sidecar(os.path.join(td, "state"),
                                           os.path.join(td, "profile"), 19227)
                instance._page = lambda: (page, {"pid": 1})
                instance.live_queue.append([sidecar._event("live", "room-1", {
                    "id": "e1", "authorId": author, "authorName": "小明", "text": "问一下"})])
                planned = instance.dispatch("live_plan", {
                    "maxItems": 5, "windowSeconds": 600,
                    "scripts": {"e1": {"publicText": "公开话术", "privateText": "私信话术"}}})
                batch_id = planned["batch"]["batchId"]
                instance.live_queue.mark("e1", live_flow.SENT_CONFIRMED, batch_id,
                                         {"sendId": "pub-skip"})
                instance.gate.reserve("pub-skip", "live-danmaku-native:e1:小明", "公开话术",
                                      kind="danmaku_reply")
                instance.gate.mark_started("pub-skip")
                instance.gate.finish("pub-skip", "sent_confirmed", "platform_response_recorded")
                result = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "skip-3", "publicSendId": "pub-skip"}]})
                self.assertEqual(result["skipped"], [{"eventId": "e1", "reason": "dm_not_available"}])
                self.assertEqual(result["results"][0]["status"], "blocked")
        finally:
            sidecar.send_private = original_send
            self._restore(saved)


class LivePrivateBindingTests(unittest.TestCase):
    """审核意见（2026-09-21）：直播私信必须逐项绑定"那一次已确认成功的公屏回复"。

    只靠批次候选清单（按事件状态放行）会留下一条绕过路径：调用方不带 publicSendId
    直接要私信，公屏成功门禁就形同虚设。下面把三条绕过路径都钉住。
    """

    class _Page:
        def close(self):
            pass

    def _setup(self, td, recorded_send_id="pub-1"):
        import live_flow
        import sidecar
        instance = sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19231)

        def explode():
            raise AssertionError("契约不通过时不得打开浏览器")

        instance._page = explode
        instance.live_queue.append([sidecar._event("live", "room-1", {
            "id": "e1", "authorId": "A" * 40, "authorName": "小明", "text": "问一下"})])
        planned = instance.dispatch("live_plan", {
            "maxItems": 5, "windowSeconds": 600, "replyMode": "danmaku",
            "scripts": {"e1": {"publicText": "谢谢支持", "privateText": "私信话术"}}})
        batch_id = planned["batch"]["batchId"]
        # 公屏这一phase确实确认成功（并记录那次的 sendId）
        instance.live_queue.mark("e1", live_flow.SENT_CONFIRMED, batch_id,
                                 {"sendId": recorded_send_id})
        return sidecar, instance, batch_id

    @staticmethod
    def _confirmed_public(gate, send_id):
        gate.reserve(send_id, "live-danmaku-native:e1:小明", "谢谢支持", kind="danmaku_reply")
        gate.mark_started(send_id)
        gate.finish(send_id, "sent_confirmed", "platform_response_recorded")
        return send_id

    def test_missing_public_send_id_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar, instance, batch_id = self._setup(td)
            reply = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                {"eventId": "e1", "sendId": "p-1"}]})
            self.assertEqual(reply["results"][0]["reason"], "public_missing")
            self.assertEqual(reply["results"][0]["status"], "blocked")

    def test_unconfirmed_public_send_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar, instance, batch_id = self._setup(td)
            instance.gate.reserve("pub-unconfirmed", "live-danmaku-native:e1:小明", "谢谢支持",
                                  kind="danmaku_reply")
            instance.gate.mark_started("pub-unconfirmed")
            instance.gate.finish("pub-unconfirmed", "unknown", "platform_response_unavailable")
            reply = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                {"eventId": "e1", "sendId": "p-2", "publicSendId": "pub-unconfirmed"}]})
            self.assertEqual(reply["results"][0]["reason"], "public_unknown")

    def test_a_public_send_from_another_event_is_refused(self):
        """拿别人那次的公屏成功来给这个事件开私信 -> public_send_mismatch。"""
        with tempfile.TemporaryDirectory() as td:
            sidecar, instance, batch_id = self._setup(td, recorded_send_id="pub-own")
            self._confirmed_public(instance.gate, "pub-other")
            reply = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                {"eventId": "e1", "sendId": "p-3", "publicSendId": "pub-other"}]})
            self.assertEqual(reply["results"][0]["reason"], "public_send_mismatch")

    def test_the_bound_public_send_lets_the_private_phase_reach_the_page(self):
        """绑定正确时确实进入浏览器阶段（用假页面验证走通了门禁，而不是被别的规则拦下）。"""
        with tempfile.TemporaryDirectory() as td:
            sidecar, instance, batch_id = self._setup(td, recorded_send_id="pub-ok")
            self._confirmed_public(instance.gate, "pub-ok")
            instance._page = lambda: (self._Page(), {"pid": 1})
            calls = []
            original = sidecar.send_private
            sidecar.send_private = lambda *_a, **_k: (calls.append(1) or
                                                      {"status": "unknown",
                                                       "evidence": {"conversationEcho": True}})
            try:
                reply = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                    {"eventId": "e1", "sendId": "p-4", "publicSendId": "pub-ok"}]})
            finally:
                sidecar.send_private = original
            self.assertEqual(calls, [1])
            self.assertEqual(reply["results"][0]["status"], "unknown")

    def test_capabilities_keep_unverified_channels_fail_closed(self):
        """未验证的能力必须 fail-closed；只读的门禁辅助方法也要出现在能力清单里。"""
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"),
                                       os.path.join(td, "profile"), 19232)
            caps = instance.dispatch("capabilities", {})
            capability = caps["capability"]
            # 🔴 评审明确的四个必须保持 fail-closed 的发送/批次能力：
            #    私信(private_reply)、视频公开回复(video_reply)、评论批次(comment_batch)、
            #    直播间批次(live_batch)。在拿到真实平台响应与送达证据之前，
            #    谁都不许把它们翻成 true —— 更不能对外声称"真实抖音自动发送可用"。
            for name in ("private_reply", "video_reply", "comment_batch", "live_batch",
                         "live_reply", "live_danmaku_reply", "live_private_reply",
                         "comment_flow", "comment_private_candidates"):
                self.assertIn(name, capability, name)
                self.assertFalse(capability[name]["autoEligible"],
                                 "%s 未验证却标记为可自动发送" % name)
            self.assertIn("comment_private_candidates", caps["methods"])


class LivePrivateLedgerGatingTests(unittest.TestCase):
    """真实台账上的【逐条】门禁：同一批次里只有公屏确认成功的那条才允许私信。

    与 LivePrivateBindingTests 的分工：那边每条绕过路径单独验一个事件；这里把
    【同一批次里的两条弹幕】放进一次真实调用，证明门禁是逐条的、不是整批放行：

      * 两条事件的批次状态都是 sent_confirmed（候选清单允许两条）——
        所以本用例单独钉的是"逐项台账绑定"，而不是候选清单；
      * 真实台账里只有一条公屏回复是 sent_confirmed，另一条停在 unknown（真机常态）；
      * 结果：确认的那条进入浏览器阶段，unknown 的那条在【打开浏览器之前】被拒绝。

    另外钉住一条容易搞错的细节：契约判定读的是 SendGate.lookup() 的【原始状态】，
    而不是 result() 映射后的对外状态 —— 后者会把 sent_confirmed 映射成 unknown，
    照它判定就永远进不了私信。
    """

    class _Page:
        def close(self):
            pass

    @staticmethod
    def _public_reply(gate, send_id, status):
        gate.reserve(send_id, "live-danmaku-native:%s" % send_id, "谢谢支持", kind="danmaku_reply")
        if status in ("unknown", "sent_confirmed"):
            gate.mark_started(send_id)
        gate.finish(send_id, status, "platform_response_unavailable")
        return send_id

    def test_only_the_confirmed_item_reaches_the_private_phase(self):
        import live_flow
        import sidecar
        with tempfile.TemporaryDirectory() as td:
            instance = sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19233)

            # 注意：混合批次里"有一条可发"就会打开浏览器 —— 那是正确的。
            # 这里要钉的是【逐条】：未确认的那条绝不能进到发送路径里。
            instance._page = lambda: (self._Page(), {"pid": 1})
            instance.live_queue.append([
                sidecar._event("live", "room-1", {"id": "e-ok", "authorId": "A" * 40,
                                                  "authorName": "观众甲", "text": "多少钱"}),
                sidecar._event("live", "room-1", {"id": "e-unknown", "authorId": "B" * 40,
                                                  "authorName": "观众乙", "text": "多少钱"}),
            ])
            scripts = {"e-ok": {"publicText": "谢谢支持", "privateText": "私信话术"},
                       "e-unknown": {"publicText": "谢谢支持", "privateText": "私信话术"}}
            planned = instance.dispatch("live_plan", {"maxItems": 5, "windowSeconds": 600,
                                                      "replyMode": "danmaku", "scripts": scripts})
            batch_id = planned["batch"]["batchId"]
            self.assertEqual(sorted(item["eventId"] for item in planned["targets"]),
                             ["e-ok", "e-unknown"])

            self._public_reply(instance.gate, "pub-ok", "sent_confirmed")
            self._public_reply(instance.gate, "pub-unknown", "unknown")
            for event_id, send_id in (("e-ok", "pub-ok"), ("e-unknown", "pub-unknown")):
                instance.live_queue.mark(event_id, live_flow.SENT_CONFIRMED, batch_id,
                                         {"sendId": send_id})
            candidates, _rejected = instance.live_queue.private_candidates(batch_id)
            self.assertEqual(len(candidates), 2, "本用例验的是逐项台账门禁，不是候选清单")

            raw = instance.gate.lookup("pub-ok")
            self.assertEqual(raw["status"], "sent_confirmed")
            self.assertEqual(instance.gate.result(raw)["status"], "unknown",
                             "对外 result() 会把 sent_confirmed 映射成 unknown")

            sent = []
            original = sidecar.send_private
            sidecar.send_private = lambda _page, _gate, send_id, target, text: (
                sent.append((send_id, target["authorId"], text)) or
                {"status": "unknown", "reason": "platform_response_unavailable",
                 "evidence": {"conversationEcho": True}})
            try:
                result = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                    {"eventId": "e-ok", "sendId": "d-ok", "publicSendId": "pub-ok"},
                    {"eventId": "e-unknown", "sendId": "d-unknown",
                     "publicSendId": "pub-unknown"}]})
            finally:
                sidecar.send_private = original

            by_event = {item["eventId"]: item for item in result["results"]}
            self.assertEqual(by_event["e-unknown"]["status"], "blocked")
            self.assertEqual(by_event["e-unknown"]["reason"], "public_unknown")
            self.assertEqual(by_event["e-ok"]["status"], "unknown")
            self.assertEqual([item[1] for item in sent], ["A" * 40], "只有确认过的那条进入浏览器阶段")
            self.assertEqual(sent[0][0], "d-ok")
            # 拒绝要留痕：台账里能查到原因，不是静默跳过
            self.assertEqual(instance.live_queue.find_event("e-unknown")["private"]["reason"],
                             "public_unknown")
            self.assertEqual(instance.live_queue.find_event("e-ok")["private"]["status"], "unknown")
            self.assertEqual(result["skipped"], [], "被门禁拒绝不等于对方不可私信，不能计成跳过")


if __name__ == "__main__":
    unittest.main()
