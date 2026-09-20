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

    def test_queue_dedupes_by_identity(self):
        queue = self._queue()
        first = queue.append([self._target(1), self._target(1)], now=self.T[0])
        self.assertEqual((first["added"], first["duplicates"]), (1, 1))
        self.assertEqual(first["queued"], 1)
        # 同一目标再次入队仍算重复，不会新增
        again = queue.append([self._target(1)], now=self.T[0])
        self.assertEqual((again["added"], again["duplicates"]), (0, 1))
        self.assertEqual(again["queued"], 1)

    def test_queue_caps_at_capacity_and_reports_the_drop(self):
        """容量上限必须真的生效，且必须把丢弃数如实报出来。

        语义（照 _trim 的实际行为，不是猜的）：
          added   = 本次【插入的行数】，不是最终留存数
          dropped = 因超容量被标为 expired 的条数 —— 是【丢弃】，不是延后
          queued  = 最终留在队列里的条数
        静默丢目标等于静默丢客户，所以三个数字都要断言。
        """
        import comment_flow
        tiny = comment_flow.CommentQueue(os.path.join(self.tmp.name, "cap"), "account-a",
                                         capacity=2, clock=lambda: self.T[0])
        out = tiny.append([self._target(i) for i in (1, 2, 3)], now=self.T[0])
        self.assertEqual(out["capacity"], 2)
        self.assertEqual(out["added"], 3, "added 是插入行数，不是留存数")
        self.assertEqual(out["dropped"], 1)
        self.assertEqual(out["queued"], 2)
        self.assertEqual(tiny.stats()["states"], {"queued": 2, "expired": 1})
        # 被容量挤掉的是【丢弃】而非延后：expired 是终态，永不复用。
        # 不指定是哪一条 —— 三条 seen_at 相同，排序并列时不该假定具体顺序。
        expired = [i for i in (1, 2, 3)
                   if tiny.find_target("tg-%d" % i)["state"] == self.CF.EXPIRED]
        self.assertEqual(len(expired), 1)

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
        # 冻结时用的是内建默认；第二次传 99 必须被忽略，策略来源如实回报
        plan = queue.plan(batch_id)
        self.assertEqual(plan["policy"]["maxPublicAttempts"],
                         self.CF.POLICY_DEFAULTS["maxPublicAttempts"])
        self.assertEqual(plan["policySource"], "builtin_default")
        # 空列表本身说明不了问题，必须断言【为什么】空
        queue.mark_public("tg-1", self.CF.FAILED, batch_id)
        items, rejected = queue.public_candidates(batch_id)
        self.assertEqual(items, [])
        self.assertEqual([r["reason"] for r in rejected], ["public_attempts_exhausted"])

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
        """docs/api.md：服务端是积分唯一权威，客户端不得提交 charged/price/balance。

        🔴 两处比原来严格：
          1) 深度遍历而不是只看顶层键 —— 嵌套结构里混进一个 charged，
             只看 result.keys() 发现不了。
          2) 先断言结果【确实被填充过】—— 否则一个空结果或坏掉的结果，
             同样能让「不含积分字段」成立，用例会在什么都没验证的情况下变绿。
             （上一轮那两个静默 bug 就是这么活下来的。）
        """
        queue, batch_id = self._prep(2)
        queue.mark_public("tg-1", self.CF.SENT_CONFIRMED, batch_id)
        queue.mark_public("tg-2", self.CF.UNKNOWN, batch_id)
        result = queue.result(batch_id)

        self.assertEqual(set(_iter_keys(result)) & {"charged", "price", "balance"}, set(),
                         "结果树的任意层级都不得出现客户端可提交的积分字段")

        # 结果必须真的有内容，上面那条「不含」才有意义
        self.assertEqual(result["counts"].get(self.CF.SENT_CONFIRMED), 1)
        self.assertEqual(result["counts"].get(self.CF.UNKNOWN), 1)
        self.assertEqual(result["funnel"]["planned"], 2)
        self.assertTrue(result["funnel"]["rejectedReasons"], "漏斗不能是空的")
        self.assertEqual(result["channel"], "comment")
        self.assertEqual(result["source"], "video_comment")
        self.assertIn("phase", result["checkpoint"])


def _iter_keys(node):
    """递归产出嵌套结构里的所有字典键（用于「不得出现某字段」的深度断言）。"""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            for nested in _iter_keys(value):
                yield nested
    elif isinstance(node, (list, tuple)):
        for item in node:
            for nested in _iter_keys(item):
                yield nested
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
            private = instance.dispatch("live_private", {"batchId": batch_id, "items": [
                {"eventId": "e2", "sendId": "s2"}]})
            self.assertEqual(private["status"], "blocked")
            self.assertEqual(private["results"][0]["reason"], "public_planned")
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


if __name__ == "__main__":
    unittest.main()
