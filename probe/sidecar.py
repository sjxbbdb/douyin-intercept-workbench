"""One-request JSONL sidecar for the trusted desktop host.

The sidecar owns no UI and never writes protocol logs to stdout.  One process
handles one request, which makes parent cancellation an unambiguous stop: a
started send remains durable and therefore is not retried automatically.
"""
import argparse
import contextlib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

import cdp as cdpmod
import crawl as crawlmod
import douyin
import douyin_selectors as S
import live
import live_flow
import winfocus
from send_actions import send_comment, send_private
from send_gate import SendGate
from url_policy import URLPolicyError, redact_url, safe_url


SOURCE_ROOT = os.path.realpath(os.path.dirname(__file__))
MAX_KEYWORD = 200


class SidecarError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


def _err_message(value):
    text = str(value or "error")
    text = text.replace("\r", " ").replace("\n", " ")[:500]
    # Never reflect query strings or obvious credential-shaped values.
    return redact_url(text) if "http://" in text or "https://" in text else text


def _iso(ts=None):
    return datetime.fromtimestamp(ts or time.time(), timezone.utc).isoformat().replace("+00:00", "Z")


def _fingerprint(source, room_id, author_id, text):
    raw = "\x1f".join(map(str, (source, room_id, author_id, text)))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _event(source, room_id, row):
    author_id = (row.get("authorId") or row.get("author_id") or
                 row.get("sec_uid") or row.get("author_sec_uid") or "")
    author_name = (row.get("authorName") or row.get("author_name") or
                   row.get("user") or row.get("nick") or row.get("author") or "")
    text = (row.get("text") or "").strip()
    identity = str(author_id or author_name or "anonymous")
    observed = _iso()
    return {
        "id": str(row.get("id") or row.get("cid") or row.get("comment_id") or
                  _fingerprint(source, room_id, identity, text)[:24]),
        "source": source,
        "roomId": room_id,
        "authorId": str(author_id),
        "authorName": str(author_name)[:120],
        "text": text[:1000],
        "observedAt": observed,
        "fingerprint": _fingerprint(source, room_id, identity, text),
    }


def _live_batch_items(params):
    """Validate the per-item send plan of one live batch phase.

    Every item carries the host-supplied idempotency key, so a retried request
    can only ever replay the same action.
    """
    batch_id = str(params.get("batchId") or "").strip()
    if not batch_id:
        raise SidecarError("invalid_input", "batchId is required")
    items = params.get("items")
    if not isinstance(items, list) or not items:
        raise SidecarError("invalid_input", "items must be a non-empty array")
    out = []
    for raw in items:
        if not isinstance(raw, dict):
            raise SidecarError("invalid_input", "each item must be an object")
        event_id = str(raw.get("eventId") or "").strip()
        send_id = str(raw.get("sendId") or "").strip()
        if not event_id or not send_id:
            raise SidecarError("invalid_input", "each item needs eventId and sendId")
        out.append({"eventId": event_id, "sendId": send_id, "text": raw.get("text")})
    return batch_id, out


def _find_browser():
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    ]
    return next((p for p in candidates if os.path.isfile(p)), None)


def _wait_document(page, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if page.evaluate("document.readyState") == "complete":
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def _navigate(page, url):
    """Reuse the owned tab when already at the requested canonical URL."""
    try:
        current = safe_url(page.evaluate("location.href") or "", "current url", allow_root=True)
    except Exception:
        current = ""
    requested = safe_url(url, "navigation url", allow_root=True, keep_query=True)
    if current != requested:
        page.call("Page.navigate", {"url": requested}, timeout=25)
    if not _wait_document(page):
        raise SidecarError("page_not_ready", "page did not finish navigation")


class Sidecar:
    def __init__(self, state_dir, profile_dir, port):
        self.state_dir = self._external_dir(state_dir, "state-dir")
        self.profile_dir = self._external_dir(profile_dir, "profile-dir")
        self.port = int(port)
        if not 1024 <= self.port <= 65535:
            raise SidecarError("invalid_port", "port must be between 1024 and 65535")
        os.makedirs(self.state_dir, exist_ok=True)
        self.account_scope = hashlib.sha256(self.profile_dir.encode("utf-8")).hexdigest()[:32]
        self.gate = SendGate(self.state_dir, self.account_scope)
        self.live_queue = live_flow.LiveQueue(self.state_dir, self.account_scope)
        self.marker_path = os.path.join(self.state_dir, "browser-owner.json")

    @staticmethod
    def _external_dir(value, label):
        if not isinstance(value, str) or not os.path.isabs(value):
            raise SidecarError("invalid_path", "%s must be absolute" % label)
        path = os.path.realpath(value)
        try:
            inside = os.path.commonpath((path, SOURCE_ROOT)) == SOURCE_ROOT
        except ValueError:
            inside = False
        if inside:
            raise SidecarError("invalid_path", "%s cannot be inside probe" % label)
        return path

    def _marker(self):
        try:
            with open(self.marker_path, "r", encoding="utf-8") as fh:
                marker = json.load(fh)
            if marker.get("port") != self.port or marker.get("accountScope") != self.account_scope:
                return None
            return marker
        except (OSError, ValueError):
            return None

    def _page(self):
        marker = self._marker()
        if not marker or not marker.get("targetId"):
            raise SidecarError("browser_not_owned", "launch this account browser first")
        try:
            tabs = cdpmod.list_tabs(self.port)
        except Exception:
            raise SidecarError("browser_unavailable", "owned browser is not reachable")
        tab = next((t for t in tabs if t.get("id") == marker["targetId"] and
                    t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
        if not tab:
            raise SidecarError("target_not_found", "owned browser target is unavailable")
        page = cdpmod.CDP(tab["webSocketDebuggerUrl"], port=self.port, timeout=30)
        if douyin.visibility_state(page) != "visible":
            try:
                page.call("Page.bringToFront", {}, timeout=5)
            except Exception:
                pass
            winfocus.bring_process_front(marker.get("pid"), log=lambda msg: print(msg, file=sys.stderr))
            time.sleep(0.4)
        if douyin.visibility_state(page) != "visible":
            page.close()
            raise SidecarError("browser_not_visible", "owned browser window must be visible")
        return page, marker

    def capabilities(self, _params):
        return {
            "protocolVersion": 1,
            "methods": ["capabilities", "launch", "doctor", "open", "search",
                         "collect_comments", "collect_live", "send_private", "send_comment",
                         "live_listen", "live_plan", "live_reply", "live_private", "live_result",
                         "close"],
            "sendStatuses": ["unknown", "failed", "blocked"],
            "capability": {
                "video_capture": {"implemented": True, "autoEligible": True,
                                   "validation": {"status": "api_or_visible_dom", "delivery": "capture_only"}},
                "private_reply": {"implemented": True, "autoEligible": True,
                                   "validation": {"status": "pr1_real_account_flow", "scope": "collaborator_account",
                                                   "delivery": "unknown_without_bound_platform_response"}},
                "video_reply": {"implemented": True, "autoEligible": False,
                                 "validation": {"status": "offline_dom_fixture", "delivery": "unknown"}},
                "live_capture": {"implemented": True, "autoEligible": True,
                                  "validation": {"status": "offline_dom_fixture", "delivery": "capture_only"}},
                "live_reply": {"implemented": True, "autoEligible": False,
                                "validation": {"status": "offline_dom_fixture", "delivery": "unknown"}},
                "live_batch": {"implemented": True, "autoEligible": False,
                                "validation": {"status": "offline_unit_tests",
                                               "delivery": "queued_batch_two_phase",
                                               "scripts": "host_provided_only",
                                               "window": "expired_events_are_not_replayed"}},
            },
            "limits": dict(self.gate.limits),
            "accountScope": self.account_scope,
        }

    def launch(self, _params):
        browser = _find_browser()
        if not browser:
            raise SidecarError("browser_not_found", "Chrome or Edge was not found")
        try:
            existing = cdpmod._http_json("http://127.0.0.1:%d/json/version" % self.port, timeout=1)
        except Exception:
            existing = None
        if existing and not self._marker():
            raise SidecarError("port_owned_elsewhere", "CDP port is already in use")
        if existing and self._marker().get("webSocketDebuggerUrl") != existing.get("webSocketDebuggerUrl"):
            raise SidecarError("port_owner_mismatch", "CDP port belongs to another browser")
        os.makedirs(self.profile_dir, exist_ok=True)
        args = [browser, "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=%d" % self.port,
                "--user-data-dir=%s" % self.profile_dir,
                "--no-first-run", "--no-default-browser-check",
                "https://www.douyin.com/"]
        if not existing:
            kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                      "stderr": subprocess.DEVNULL, "close_fds": True}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            proc = subprocess.Popen(args, **kwargs)
            deadline = time.time() + 12
            while time.time() < deadline:
                try:
                    cdpmod._http_json("http://127.0.0.1:%d/json/version" % self.port, timeout=1)
                    break
                except Exception:
                    time.sleep(0.25)
            else:
                raise SidecarError("browser_start_timeout", "browser did not expose CDP")
            pid = proc.pid
        else:
            pid = self._marker().get("pid")
        tabs = cdpmod.list_tabs(self.port)
        marker = self._marker()
        page = next((t for t in tabs if marker and t.get("id") == marker.get("targetId") and
                     t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
        if not page:
            page = next((t for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
        if not page:
            raise SidecarError("target_not_found", "browser has no page target")
        version = cdpmod._http_json("http://127.0.0.1:%d/json/version" % self.port, timeout=3)
        with open(self.marker_path, "w", encoding="utf-8") as fh:
            json.dump({"pid": pid, "port": self.port, "targetId": page["id"],
                       "accountScope": self.account_scope,
                       "webSocketDebuggerUrl": version.get("webSocketDebuggerUrl")}, fh)
        return {"status": "ok", "url": redact_url(page.get("url")),
                "browser": {"name": os.path.basename(browser), "pid": pid, "port": self.port}}

    def close(self, _params):
        marker = self._marker()
        if not marker or not marker.get("pid"):
            return {"status": "not_running"}
        pid = int(marker["pid"])
        try:
            version = cdpmod._http_json("http://127.0.0.1:%d/json/version" % self.port, timeout=2)
            if version.get("webSocketDebuggerUrl") != marker.get("webSocketDebuggerUrl"):
                return {"status": "not_owner"}
            browser = cdpmod.CDP(version["webSocketDebuggerUrl"], port=self.port, timeout=5)
            try:
                browser.call("Browser.close", {}, timeout=5)
            finally:
                browser.close()
        except Exception:
            return {"status": "unknown"}
        try:
            os.unlink(self.marker_path)
        except OSError:
            pass
        return {"status": "closed", "pid": pid}

    def doctor(self, _params):
        page, marker = self._page()
        try:
            url = page.evaluate("location.href") or ""
            login = douyin.login_state(page)
            captcha = douyin.captcha_probe(page)
            return {"status": "ok", "url": redact_url(url),
                    "browser": {"port": self.port, "pid": marker.get("pid")},
                    "login": login, "captcha": bool(captcha.get("hit"))}
        finally:
            page.close()

    def open(self, params):
        url = safe_url(params.get("url"), "url", allow_root=True, keep_query=True)
        page, _ = self._page()
        try:
            _navigate(page, url)
            final_url = safe_url(page.evaluate("location.href") or url, "final url", allow_root=True)
            return {"status": "ok", "url": final_url}
        finally:
            page.close()

    def search(self, params):
        keyword = params.get("keyword")
        if not isinstance(keyword, str) or not keyword.strip() or len(keyword) > MAX_KEYWORD:
            raise SidecarError("invalid_input", "keyword is required")
        max_videos = int(params.get("maxVideos", 50))
        rounds = int(params.get("scrollRounds", 6))
        if not 1 <= max_videos <= 200 or not 0 <= rounds <= 40:
            raise SidecarError("invalid_input", "search bounds are invalid")
        page, _ = self._page()
        try:
            if douyin.login_state(page) == "required":
                return {"status": "login_required", "videos": []}
            meta = {}
            with contextlib.redirect_stdout(sys.stderr):
                videos = crawlmod.search_videos(page, keyword, scroll_rounds=rounds,
                                                max_videos=max_videos, log=lambda *a: None,
                                                strict=False, meta=meta)
            out = []
            for video in videos[:max_videos]:
                out.append({"id": str(video.get("aweme_id") or ""),
                            "url": safe_url(video.get("url"), "video.url"),
                            "title": str(video.get("desc") or "")[:200],
                            "author": str(video.get("author") or "")[:120],
                            "authorId": str(video.get("author_sec_uid") or "")[:200]})
            return {"status": "captcha" if meta.get("stopped_reason") == "captcha" else "ok",
                    "videos": out}
        finally:
            page.close()

    def collect_comments(self, params):
        requested_url = safe_url(params.get("url"), "url", keep_query=True)
        max_items, rounds = int(params.get("maxItems", 100)), int(params.get("scrollRounds", 6))
        if not 1 <= max_items <= 500 or not 0 <= rounds <= 40:
            raise SidecarError("invalid_input", "comment bounds are invalid")
        page, _ = self._page()
        try:
            if douyin.login_state(page) == "required":
                return {"status": "login_required", "events": [],
                        "capability": {"verified": False, "source": "visible_login_modal",
                                       "detail": "manual login required"}}
            _navigate(page, requested_url)
            url = safe_url(page.evaluate("location.href") or requested_url, "final video url")
            if "www.douyin.com" not in url or "/video/" not in url:
                raise SidecarError("unsupported", "collect_comments requires a video URL")
            aweme_id = url.rsplit("/video/", 1)[1].split("/", 1)[0]
            if not aweme_id.isdigit():
                raise SidecarError("invalid_input", "resolved video id is invalid")
            video = {"aweme_id": aweme_id, "url": url, "desc": ""}
            with contextlib.redirect_stdout(sys.stderr):
                rows, meta = crawlmod.crawl_video_comments(page, video, log=lambda *a: None,
                                                            scroll_rounds=rounds, navigate=False)
            status = "captcha" if meta.get("stopped_reason") == "captcha" else "ok"
            if meta.get("skipped") and status == "ok":
                status = "unsupported"
            events = [_event("video", url, row) for row in rows[:max_items]]
            return {"status": status, "events": events,
                    "capability": {"verified": bool(events), "source": "api_or_dom",
                                   "detail": "response bodies plus visible DOM fallback"}}
        finally:
            page.close()

    def collect_live(self, params):
        url = safe_url(params.get("url"), "url")
        if not url.startswith("https://live.douyin.com/"):
            raise SidecarError("unsupported", "collect_live requires a live.douyin.com URL")
        max_items = int(params.get("maxItems", 100))
        if not 1 <= max_items <= 500:
            raise SidecarError("invalid_input", "live comment bounds are invalid")
        page, _ = self._page()
        try:
            if douyin.login_state(page) == "required":
                return {"status": "login_required", "events": [],
                        "capability": {"verified": False, "source": "visible_login_modal",
                                       "detail": "manual login required"}}
            _navigate(page, url)
            final_url = safe_url(page.evaluate("location.href") or url, "final live url")
            if not final_url.startswith("https://live.douyin.com/"):
                raise SidecarError("unsupported", "resolved page is not a live room")
            rows = live.collect_events(page, max_items=max_items)
            events = [_event("live", final_url, row) for row in rows]
            return {"status": "ok", "events": events,
                    "capability": {"verified": bool(events), "source": "visible_dom",
                                   "detail": "live selectors are fixture-validated; platform validation pending"}}
        finally:
            page.close()

    def send_private(self, params):
        send_id = str(params.get("sendId") or "")
        target = params.get("target")
        text = params.get("text")
        page, _ = self._page()
        try:
            return send_private(page, self.gate, send_id, target, text)
        finally:
            page.close()

    def send_comment(self, params):
        send_id = str(params.get("sendId") or "")
        target = params.get("target")
        text = params.get("text")
        source = params.get("source")
        page, _ = self._page()
        try:
            return send_comment(page, self.gate, send_id, target, text, source)
        finally:
            page.close()

    # ---- live batch flow: images/12-live-room-business ----

    def live_listen(self, params):
        """One listening round: collect visible live comments and enqueue them.

        The queue deduplicates by room/author/text and trims itself to its
        configured capacity, so the host may call this repeatedly and plan a
        batch from the accumulated events afterwards.
        """
        url = safe_url(params.get("url"), "url")
        if not url.startswith("https://live.douyin.com/"):
            raise SidecarError("unsupported", "live_listen requires a live.douyin.com URL")
        max_items = int(params.get("maxItems", 100))
        if not 1 <= max_items <= 500:
            raise SidecarError("invalid_input", "live comment bounds are invalid")
        page, _ = self._page()
        try:
            if douyin.login_state(page) == "required":
                return {"status": "login_required", "events": [],
                        "queue": self.live_queue.stats(),
                        "capability": {"verified": False, "source": "visible_login_modal",
                                       "detail": "manual login required"}}
            _navigate(page, url)
            final_url = safe_url(page.evaluate("location.href") or url, "final live url")
            if not final_url.startswith("https://live.douyin.com/"):
                raise SidecarError("unsupported", "resolved page is not a live room")
            rows = live.collect_events(page, max_items=max_items)
            events = [_event("live", final_url, row) for row in rows]
            queue = self.live_queue.append(events)
            return {"status": "ok", "events": events, "queue": queue,
                    "capability": {"verified": bool(events), "source": "visible_dom",
                                   "detail": "queue dedupes by room/author/text; the batch window is enforced at planning"}}
        finally:
            page.close()

    def live_plan(self, params):
        """Form one batch and freeze the host-provided two-channel scripts.

        Events outside the window are reported as expired and never replayed.
        A target whose scripts are missing or out of bounds is blocked here,
        before any browser action happens.
        """
        try:
            max_items = int(params.get("maxItems", 20))
            window_seconds = int(params.get("windowSeconds", live_flow.WINDOW_DEFAULT))
        except (TypeError, ValueError):
            raise SidecarError("invalid_input", "livePlan bounds are invalid")
        if not 1 <= max_items <= live_flow.MAX_BATCH:
            raise SidecarError("invalid_input", "livePlan maxItems is out of range")
        if params.get("policy") is not None:
            # 策略（allowPublicStates / maxPrivate 等）必须由授权服务端签发并校验；
            # 在这个接线完成之前，边界一律拒绝调用方自带策略，改用内置的保守默认值。
            raise SidecarError("policy_not_server_issued",
                               "policy must be issued by the authorization service, not by the caller")
        batch = self.live_queue.take_batch(max_items=max_items, window_seconds=window_seconds)
        summary = {key: batch[key] for key in
                   ("batchId", "createdAt", "expiresAt", "expiredCount", "frozen", "status")}
        if not batch["events"]:
            return {"status": "empty", "batch": summary, "targets": [], "blocked": [],
                    "expired": batch["expired"]}
        plan = self.live_queue.freeze_plan(batch["batchId"], params.get("scripts"),
                                           params.get("policy"))
        return {"status": "ok" if plan["targets"] else "blocked", "batch": summary,
                "targets": plan["targets"], "blocked": plan["blocked"],
                "expired": batch["expired"], "policy": plan["policy"],
                "policySource": plan.get("policySource")}

    def live_reply(self, params):
        """Phase one: public reply for accepted items of a frozen batch.

        The text must equal the frozen public script.  A different text is
        blocked instead of sent, because the scripts are the platform artifact
        (images/09) and this side never rewrites them.
        """
        batch_id, items = _live_batch_items(params)
        self.live_queue.ensure_active(batch_id)
        plan = self.live_queue.plan(batch_id)
        if not plan.get("targets"):
            raise SidecarError("plan_not_frozen", "freeze the batch plan before replying")
        results, sendable = [], []
        for item in items:
            target = self.live_queue.target(batch_id, item["eventId"])
            if target is None:
                results.append({"eventId": item["eventId"], "status": "blocked",
                                "reason": "event_not_in_plan"})
                continue
            text = item.get("text") or target["publicText"]
            if text != target["publicText"]:
                self.live_queue.mark(item["eventId"], live_flow.BLOCKED, batch_id,
                                     {"reason": "script_mismatch"})
                results.append({"eventId": item["eventId"], "status": "blocked",
                                "reason": "script_mismatch"})
                continue
            sendable.append((item, target, text))
        if sendable:
            page, _ = self._page()
            try:
                for item, target, text in sendable:
                    comment_target = {"id": target["eventId"], "roomId": target["roomId"],
                                      "authorId": target["authorId"],
                                      "authorName": target["authorName"], "text": target["text"]}
                    outcome = send_comment(page, self.gate, item["sendId"], comment_target, text, "live")
                    self.live_queue.mark(item["eventId"], str(outcome.get("status") or "unknown"),
                                         batch_id, {"sendId": item["sendId"],
                                                    "reason": outcome.get("reason")})
                    results.append(dict(outcome, eventId=item["eventId"]))
            finally:
                page.close()
        allowed, rejected = self.live_queue.private_candidates(batch_id)
        return {"status": "ok" if sendable else "blocked", "phase": "public", "results": results,
                "privateCandidates": [{"eventId": t["eventId"], "authorId": t["authorId"],
                                       "authorName": t["authorName"]} for t in allowed],
                "privateRejected": rejected,
                "checkpoint": self.live_queue.result(batch_id)["checkpoint"]}

    def live_private(self, params):
        """Phase two: private message, only for the derived candidate list.

        Anything outside that list - unresolved public reply, blocked target,
        missing author id, over the private capacity - is refused with a reason
        instead of being sent.
        """
        batch_id, items = _live_batch_items(params)
        self.live_queue.ensure_active(batch_id)
        allowed, rejected = self.live_queue.private_candidates(batch_id)
        by_id = {item["eventId"]: item for item in allowed}
        results, sendable = [], []
        for item in items:
            target = by_id.get(item["eventId"])
            if target is None:
                reason = next((r["reason"] for r in rejected
                               if r["eventId"] == item["eventId"]), "not_a_private_candidate")
                results.append({"eventId": item["eventId"], "status": "blocked", "reason": reason})
                continue
            text = item.get("text") or target["privateText"]
            if text != target["privateText"]:
                self.live_queue.mark_private(item["eventId"], "blocked", batch_id,
                                             {"reason": "script_mismatch"})
                results.append({"eventId": item["eventId"], "status": "blocked",
                                "reason": "script_mismatch"})
                continue
            sendable.append((item, target, text))
        if sendable:
            page, _ = self._page()
            try:
                for item, target, text in sendable:
                    profile_target = {"authorId": target["authorId"],
                                      "authorName": target["authorName"]}
                    outcome = send_private(page, self.gate, item["sendId"], profile_target, text)
                    self.live_queue.mark_private(item["eventId"],
                                                 str(outcome.get("status") or "unknown"), batch_id,
                                                 {"sendId": item["sendId"],
                                                  "reason": outcome.get("reason")})
                    results.append(dict(outcome, eventId=item["eventId"]))
            finally:
                page.close()
        return {"status": "ok" if sendable else "blocked", "phase": "private", "results": results,
                "checkpoint": self.live_queue.result(batch_id)["checkpoint"]}

    def live_result(self, params):
        """Batch report: per-phase states, the private list and the checkpoint."""
        batch_id = str(params.get("batchId") or "").strip()
        if not batch_id:
            raise SidecarError("invalid_input", "batchId is required")
        report = self.live_queue.result(batch_id)
        report["queue"] = self.live_queue.stats()
        report["limits"] = dict(self.gate.limits)
        return report

    def dispatch(self, method, params):
        allowed = {"capabilities", "launch", "doctor", "open", "search",
                   "collect_comments", "collect_live", "send_private", "send_comment",
                   "live_listen", "live_plan", "live_reply", "live_private", "live_result",
                   "close"}
        if method not in allowed:
            raise SidecarError("unknown_method", "method is not supported")
        fn = getattr(self, method)
        if not isinstance(params, dict):
            raise SidecarError("invalid_input", "params must be an object")
        try:
            return fn(params)
        except live_flow.LiveFlowError as exc:
            raise SidecarError(exc.code, exc.message)


def _emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _configure_stdio():
    """Make JSONL encoding independent of the Windows user code page."""
    for stream, errors in ((sys.stdin, "strict"), (sys.stdout, "strict"),
                           (sys.stderr, "replace")):
        try:
            stream.reconfigure(encoding="utf-8", errors=errors)
        except (AttributeError, ValueError):
            # Test doubles and embedded hosts may expose plain file objects.
            pass


def main(argv=None):
    _configure_stdio()
    parser = argparse.ArgumentParser(description="Douyin agent sidecar")
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--profile-dir", required=True)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args(argv)
    try:
        sidecar = Sidecar(args.state_dir, args.profile_dir, args.port)
    except Exception as exc:
        _emit({"id": None, "ok": False, "error": {"code": getattr(exc, "code", "invalid_config"),
                                                      "message": _err_message(getattr(exc, "message", exc))}})
        return 2
    line = sys.stdin.readline(1024 * 1024 + 1)
    if not line:
        return 0
    if len(line) > 1024 * 1024:
        _emit({"id": None, "ok": False, "error": {"code": "request_too_large", "message": "request too large"}})
        return 1
    request = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(request_id, (str, int)) or not isinstance(method, str):
            raise SidecarError("invalid_request", "id and method are required")
        _emit({"id": request_id, "type": "progress", "data": {"stage": "started", "method": method}})
        with contextlib.redirect_stdout(sys.stderr):
            result = sidecar.dispatch(method, params)
        _emit({"id": request_id, "ok": True, "result": result})
        return 0
    except Exception as exc:
        request_id = request.get("id") if isinstance(request, dict) else None
        _emit({"id": request_id, "ok": False,
               "error": {"code": getattr(exc, "code", "request_failed"),
                          "message": _err_message(getattr(exc, "message", exc))}})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
