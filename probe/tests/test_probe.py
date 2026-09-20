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
                return {"ok": False, "count": 2, "reason": "ambiguous_comment"}

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

    def test_video_target_exact_id_author_text_and_reply_button(self):
        import send_actions
        self._load("comments.html")
        good = self.page.eval_json(send_actions.build_comment_target_expression({
            "id": "comment-1", "authorId": "author-1", "authorName": "Alice", "text": "same question"}))
        self.assertTrue(good["ok"])
        self.page.click_at(good["x"], good["y"])
        self.assertEqual(self.page.evaluate("document.querySelector('#comment-1 [data-e2e=comment-reply]').dataset.clicks"), "1")
        import douyin
        comment_target = {"id": "comment-1", "authorId": "author-1", "authorName": "Alice", "text": "same question"}
        composer = douyin.comment_reply_composer(self.page, comment_target)
        self.assertTrue(composer["found"])
        self.assertEqual(composer["rowId"], "comment-1")
        reply_send = douyin.comment_reply_send_button(self.page, comment_target)
        self.assertTrue(reply_send["found"])
        self.assertEqual(douyin.comment_composer(self.page)["found"], True)
        wrong_author = self.page.eval_json(send_actions.build_comment_target_expression({
            "id": "comment-1", "authorId": "author-10", "authorName": "Alice", "text": "same question"}))
        self.assertFalse(wrong_author["ok"])
        wrong_text = self.page.eval_json(send_actions.build_comment_target_expression({
            "id": "comment-1", "authorId": "author-1", "authorName": "Alice", "text": "different"}))
        self.assertFalse(wrong_text["ok"])

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


if __name__ == "__main__":
    unittest.main()
