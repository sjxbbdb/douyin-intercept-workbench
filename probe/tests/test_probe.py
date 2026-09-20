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
            # 必须显式 utf-8：sidecar 的 stdout 契约就是 UTF-8，而中文 Windows 的
            # 默认 locale 是 GBK，父进程不指定 encoding 会在读取线程里解码失败，
            # 表现为 proc.stdout 变成 None 而不是断言失败。
            proc = subprocess.run(
                [sys.executable, str(PROBE / "sidecar.py"), "--state-dir", state,
                 "--profile-dir", profile, "--port", "19222"],
                input=json.dumps({"id": "p1", "method": "capabilities", "params": {}}) + "\n",
                text=True, encoding="utf-8", errors="replace",
                capture_output=True, check=False)
            self.assertIsNotNone(
                proc.stdout,
                "父进程未指定 encoding，中文 Windows 下会用 GBK 解码 UTF-8 输出并静默失败")
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


class CommentFlowTests(unittest.TestCase):
    """评论区两阶段流程的状态机（images/11-comment-area-business）。

    纯离线：不碰浏览器，因此跑得很快，而且能在任何环境复现。
    重点覆盖需求给死的四条状态规则与两条硬门控。
    """

    def setUp(self):
        import comment_flow
        self.CF = comment_flow
        self.T = [1000000.0]
        self.tmp = tempfile.TemporaryDirectory()
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()

    def _queue(self):
        self.n += 1
        return self.CF.CommentQueue(
            os.path.join(self.tmp.name, "c%d" % self.n), "account-a",
            capacity=500, clock=lambda: self.T[0])

    @staticmethod
    def _target(i, text="求链接"):
        return {"id": "tg-%s" % i, "roomId": "https://www.douyin.com/video/1",
                "authorId": "author-%s" % i, "authorName": "用户%s" % i, "text": text}

    def _prep(self, count=3, policy=None):
        """建批并一次性冻结（frozen 不可变，策略必须在这时给）。"""
        queue = self._queue()
        queue.append([self._target(i) for i in range(1, count + 1)], now=self.T[0])
        batch = queue.take_batch(now=self.T[0])
        scripts = {("tg-%d" % i): {"publicText": "看到你说求链接", "privateText": "细节在我主页"}
                   for i in range(1, count + 1)}
        queue.freeze_plan(batch["batchId"], scripts, policy=policy)
        return queue, batch["batchId"]

    # ---------------------------------------------------------------- 队列/批次

    def test_empty_queue_creates_no_batch_and_later_targets_get_one(self):
        """空队列不得建批次，否则空批次被永久复用。"""
        queue = self._queue()
        first = queue.take_batch(now=self.T[0])
        self.assertEqual(first["status"], "empty")
        self.assertIsNone(first["batchId"])
        self.assertEqual(queue.stats()["batches"], 0)
        queue.append([self._target(1)], now=self.T[0])
        second = queue.take_batch(now=self.T[0])
        self.assertEqual(second["status"], "ok")
        self.assertEqual([t["targetId"] for t in second["targets"]], ["tg-1"])

    def test_expired_batch_is_closed_and_never_reused(self):
        """超窗批次不得再被返回，也不得再允许发送。"""
        queue = self._queue()
        queue.append([self._target(1)], now=self.T[0])
        batch = queue.take_batch(window_seconds=900, now=self.T[0])
        batch_id = batch["batchId"]
        self.T[0] += 901
        again = queue.take_batch(window_seconds=900, now=self.T[0])
        self.assertNotEqual(again["batchId"], batch_id)
        with self.assertRaises(self.CF.CommentFlowError) as ctx:
            queue.ensure_active(batch_id, now=self.T[0])
        self.assertEqual(ctx.exception.code, "batch_expired")
        self.assertTrue(all(t["state"] == "expired" for t in queue.batch_targets(batch_id)))

    def test_queue_dedupes_and_caps_capacity(self):
        queue = self._queue()
        first = queue.append([self._target(1), self._target(1)], now=self.T[0])
        self.assertEqual((first["added"], first["duplicates"]), (1, 1))

    # ------------------------------------------------- 门控一：只有确认成功才私信

    def test_phase_two_only_accepts_sent_confirmed(self):
        queue, batch_id = self._prep(4)
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        queue.mark_public("tg-2", self.CF.UNKNOWN, batch_id)
        queue.mark_public("tg-3", self.CF.FAILED, batch_id)
        queue.mark_public("tg-4", self.CF.BLOCKED, batch_id)
        allowed, rejected = queue.private_candidates(batch_id)
        self.assertEqual([t["targetId"] for t in allowed], ["tg-1"])
        reasons = {r["reason"] for r in rejected}
        self.assertIn("public_unknown_no_retry", reasons)
        self.assertIn("public_failed", reasons)
        self.assertIn("public_blocked", reasons)

    def test_phase_two_honors_max_private(self):
        queue, batch_id = self._prep(3, policy={"maxPrivate": 1})
        for i in (1, 2, 3):
            queue.mark_public("tg-%d" % i, self.CF.SENT_CONFIRMED, batch_id)
        allowed, rejected = queue.private_candidates(batch_id)
        self.assertEqual(len(allowed), 1)
        self.assertIn("over_private_capacity", {r["reason"] for r in rejected})

    def test_phase_two_requires_author_id(self):
        """没有作者标识就不能私信。

        门控读的是【冻结计划】里的 authorId，所以必须在冻结前就缺失；
        事后改数据库行不会影响已经不认那个字段的判定。
        """
        queue = self._queue()
        no_author = self._target(1)
        no_author["authorId"] = ""
        queue.append([no_author], now=self.T[0])
        batch_id = queue.take_batch(now=self.T[0])["batchId"]
        queue.freeze_plan(batch_id, {"tg-1": {"publicText": "看到你说求链接",
                                            "privateText": "细节在我主页"}})
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        allowed, rejected = queue.private_candidates(batch_id)
        self.assertEqual(allowed, [])
        self.assertIn("missing_author_id", {r["reason"] for r in rejected})

    # ------------------------------------------- 门控二：unknown 禁止盲目重试

    def test_unknown_public_reply_is_never_retried(self):
        """点击已发出、结果未定 —— 不得再发第二次。"""
        queue, batch_id = self._prep(1, policy={"maxPublicAttempts": 99})
        queue.mark_public("tg-1", self.CF.UNKNOWN, batch_id)
        candidates, rejected = queue.public_candidates(batch_id)
        self.assertEqual(candidates, [])
        self.assertIn("public_unknown_no_retry", {r["reason"] for r in rejected})

    def test_failed_public_reply_respects_retry_budget(self):
        """failed 才进重试预算；预算=1 表示含首次只试一次。"""
        queue, batch_id = self._prep(1)
        queue.mark_public("tg-1", self.CF.FAILED, batch_id)
        self.assertEqual(queue.public_candidates(batch_id)[0], [])

        queue3, batch3 = self._prep(1, policy={"maxPublicAttempts": 3})
        for expected in (1, 1, 0):
            queue3.mark_public("tg-1", self.CF.FAILED, batch3)
            self.assertEqual(len(queue3.public_candidates(batch3)[0]), expected)

    def test_frozen_plan_ignores_a_later_policy(self):
        """冻结不可变：事后传 policy 是空操作，不能借此放宽策略。"""
        queue, batch_id = self._prep(1)
        queue.freeze_plan(batch_id, {"tg-1": {"publicText": "x", "privateText": "y"}},
                          policy={"maxPublicAttempts": 99})
        queue.mark_public("tg-1", self.CF.FAILED, batch_id)
        self.assertEqual(queue.public_candidates(batch_id)[0], [])

    # ------------------------------------------------------------- 计划与记录

    def test_both_channel_scripts_are_required(self):
        """缺任一条渠道话术 -> blocked，停下等人工；本模块从不自己补话术。"""
        queue = self._queue()
        queue.append([self._target(1), self._target(2)], now=self.T[0])
        batch = queue.take_batch(now=self.T[0])
        plan = queue.freeze_plan(batch["batchId"], {
            "tg-1": {"publicText": "公开话术", "privateText": "私信话术"},
            "tg-2": {"publicText": "只有公开话术"},
        })
        self.assertEqual([t["targetId"] for t in plan["targets"]], ["tg-1"])
        self.assertEqual(plan["blocked"][0]["reason"], "private_text_missing")
        self.assertEqual(queue.find_target("tg-2")["state"], self.CF.BLOCKED)

    def test_mark_private_does_not_overwrite_phase_one_state(self):
        queue, batch_id = self._prep(1)
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        queue.mark_private("tg-1", "unknown", batch_id)
        row = queue.find_target("tg-1")
        self.assertEqual(row["state"], self.CF.SENT_CONFIRMED)
        self.assertEqual(json.loads(row["private_json"])["status"], "unknown")

    # ------------------------------------------------- 对外契约：状态与拒绝原因

    def test_every_rejection_reason_is_declared(self):
        """拒绝原因是【对外契约】：实际产生的每一个都必须在声明表内。

        宿主按拒绝原因决定转人工 / 放弃 / 重试。原因一旦是散落的自由文本，
        宿主只能靠字符串匹配，改动无人察觉 —— 这个用例就是防止那种漂移。
        """
        produced = set()

        # 阶段一：unknown / blocked / failed(预算用尽) / 已确认 / 未处理
        queue, batch_id = self._prep(5)
        queue.mark_public("tg-1", self.CF.UNKNOWN, batch_id)
        queue.mark_public("tg-2", self.CF.BLOCKED, batch_id)
        queue.mark_public("tg-3", self.CF.FAILED, batch_id)
        queue.mark_public("tg-4", self.CF.SENT_CONFIRMED, batch_id)
        _, rejected = queue.public_candidates(batch_id)
        produced |= {r["reason"] for r in rejected}

        # 阶段二：unknown / blocked / failed / 缺作者 / 超容量
        _, rejected = queue.private_candidates(batch_id)
        produced |= {r["reason"] for r in rejected}
        tight, tight_batch = self._prep(2, policy={"maxPrivate": 1})
        for i in (1, 2):
            tight.mark_public("tg-%d" % i, self.CF.SENT_CONFIRMED, tight_batch)
        _, rejected = tight.private_candidates(tight_batch)
        produced |= {r["reason"] for r in rejected}

        # 话术冻结：缺话术 / 公话术缺失 / 私话术缺失 / 过短
        queue2 = self._queue()
        queue2.append([self._target(i) for i in (1, 2, 3, 4)], now=self.T[0])
        b2 = queue2.take_batch(now=self.T[0])["batchId"]
        plan = queue2.freeze_plan(b2, {
            "tg-2": {"publicText": "只有公开" },
            "tg-3": {"privateText": "只有私信" },
            "tg-4": {"publicText": "看", "privateText": "细"}})
        produced |= {b["reason"] for b in plan.get("blocked") or []}

        declared = set(self.CF.REJECT_REASONS)
        self.assertTrue(produced, "场景没有产生任何拒绝原因，用例本身失效了")
        self.assertEqual(produced - declared, set(),
                         "产生了未在 REJECT_REASONS 中声明的原因，宿主无法依赖")

    def test_only_public_reasons_appear_where_expected(self):
        """阶段二只应出现「阶段一不合格」与「无法私信」两类原因，不得自造新词。"""
        queue, batch_id = self._prep(4)
        queue.mark_public("tg-1", self.CF.UNKNOWN, batch_id)
        queue.mark_public("tg-2", self.CF.BLOCKED, batch_id)
        queue.mark_public("tg-3", self.CF.FAILED, batch_id)
        queue.mark_public("tg-4", self.CF.SENT_CONFIRMED, batch_id)
        allowed, rejected = queue.private_candidates(batch_id)
        reasons = {r["reason"] for r in rejected}
        self.assertIn("public_unknown_no_retry", reasons)
        self.assertIn("public_blocked", reasons)
        self.assertIn("public_failed", reasons)
        self.assertEqual([t["targetKey"] for t in allowed],
                         [queue.plan(batch_id)["targets"][3]["targetKey"]])

    def test_declared_states_cover_every_state_constant(self):
        constants = {self.CF.QUEUED, self.CF.PLANNED, self.CF.EXPIRED, self.CF.BLOCKED,
                     self.CF.FAILED, self.CF.UNKNOWN, self.CF.SENT_CONFIRMED}
        self.assertEqual(constants - set(self.CF.STATES), set(),
                         "有状态常量没有出现在对外公布的 STATES 里")


    def test_states_keep_targets_that_already_have_a_result(self):
        """有结果的目标不得从统计里消失（回归）。

        batch_targets 的 SQL 是 state IN (planned, expired)，所以目标一旦被标记为
        sent_confirmed / unknown / failed 就会从它的结果里消失。统计建在它上面，
        就会永远只统计到「还没发过」的那部分 —— 看起来永远没有进展。
        （states 的键是 targetKey，不是 targetId。）
        """
        queue, batch_id = self._prep(3)
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        queue.mark_public("tg-2", self.CF.UNKNOWN, batch_id)

        by_id = {t["targetId"]: t["targetKey"] for t in queue.plan(batch_id)["targets"]}
        states = queue.states(batch_id)
        self.assertEqual(len(states), 3, "三个目标都必须还在统计里")
        self.assertEqual(states[by_id["tg-1"]], self.CF.SENT_CONFIRMED)
        self.assertEqual(states[by_id["tg-2"]], self.CF.UNKNOWN)
        self.assertEqual(states[by_id["tg-3"]], self.CF.PLANNED)

        counts = queue.result(batch_id)["counts"]
        self.assertEqual(counts.get(self.CF.SENT_CONFIRMED), 1)
        self.assertEqual(counts.get(self.CF.UNKNOWN), 1)
        self.assertEqual(counts.get(self.CF.PLANNED), 1)

    def test_result_funnel_aggregates_both_phases(self):
        """漏斗必须把两阶段的拒绝原因【合起来】。

        只看阶段二等于没有依据：绝大多数目标根本走不到阶段二。
        调评论筛选松紧靠的就是这个合起来的分布。
        """
        queue, batch_id = self._prep(4)
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        queue.mark_public("tg-2", self.CF.UNKNOWN, batch_id)
        queue.mark_public("tg-3", self.CF.FAILED, batch_id)
        # tg-4 保持 planned，没有阶段一结果
        result = queue.result(batch_id)
        funnel = result["funnel"]

        self.assertEqual(funnel["planned"], 4)
        # publicOutcome 只列【已经有结果】的，planned 表示还没发过，不该混进来
        self.assertEqual(funnel["publicOutcome"],
                         {self.CF.SENT_CONFIRMED: 1, self.CF.UNKNOWN: 1,
                          self.CF.FAILED: 1})
        # 还能进阶段一的只剩尚未处理的 planned ——
        # tg-3 是 failed，而 _mark 会把 attempts 累计到 1，默认预算 maxPublicAttempts=1
        # 表示「含首次只试一次」，所以它已经用尽，不再放行。
        self.assertEqual(funnel["publicEligible"], 1)
        self.assertEqual(funnel["privateAllowed"], 1)
        self.assertEqual(funnel["privateRejected"], 3)

        reasons = funnel["rejectedReasons"]
        # 同时出现在两个阶段 -> 计数必须是 2，这才证明两阶段都被聚合了
        self.assertEqual(reasons.get("public_unknown_no_retry"), 2)
        # 只在阶段一出现的原因
        self.assertEqual(reasons.get("public_sent_confirmed"), 1)
        # 只在阶段二出现的原因
        self.assertEqual(reasons.get("public_planned"), 1)
        self.assertEqual(reasons.get("public_failed"), 1)
        # 漏斗要能区分「失败但还能重试」和「失败且预算耗尽」——
        # 这两者对操作者的含义完全不同，混成一个数字就没法调策略了。
        self.assertEqual(reasons.get("public_attempts_exhausted"), 1)
        # 聚合出来的一切都必须仍在声明的闭集内
        self.assertEqual(set(reasons) - set(self.CF.REJECT_REASONS), set())

    def test_result_carries_no_client_side_credit_fields(self):
        """docs/api.md：服务端是积分唯一权威，客户端不得提交 charged/price/balance。"""
        queue, batch_id = self._prep(1)
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        result = queue.result(batch_id)
        for forbidden in ("charged", "price", "balance"):
            self.assertNotIn(forbidden, result)
        self.assertEqual(result["channel"], "comment")
        self.assertEqual(result["source"], "video_comment")
        self.assertIn("phase", result["checkpoint"])


if __name__ == "__main__":
    unittest.main()
