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
import comment_flow
import crawl as crawlmod
import douyin
import douyin_selectors as S
import live
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
        self.comment_queue = comment_flow.CommentQueue(self.state_dir, self.account_scope)
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
                         "comment_enqueue", "comment_plan", "comment_reply",
                         "comment_private", "comment_result", "close"],
            "sendStatuses": ["unknown", "failed", "blocked"],
            "capability": {
                "video_capture": {"implemented": True, "autoEligible": True,
                                   "validation": {"status": "api_or_visible_dom", "delivery": "capture_only"}},
                "private_reply": {"implemented": True, "autoEligible": True,
                                   "validation": {"status": "pr1_real_account_flow", "scope": "collaborator_account",
                                                   "delivery": "unknown_without_bound_platform_response"}},
                "video_reply": {"implemented": True, "autoEligible": False,
                                 "validation": {"status": "real_device_selectors_2026-09-20",
                                                "delivery": "platform_response_when_captured_else_unknown"}},
                # 评论区两阶段闭环（images/11-comment-area-business 固定流程二）。
                # autoEligible 保持 false：定位器已真机校正，但【没有一次真实的公开回复送达证据】，
                # 发行开关条件见 probe/EVIDENCE.md §11.8。
                "comment_batch": {"implemented": True, "autoEligible": False,
                                  "validation": {"status": "offline_fixture",
                                                 "delivery": "gated_on_phase_one_sent_confirmed"},
                                  # 目标状态与拒绝原因是对外契约：宿主按它们做人工转派和重试决策，
                                  # 所以在这里原样公布，宿主不必对着自由文本做匹配。
                                  "states": list(comment_flow.STATES),
                                  "rejectReasons": list(comment_flow.REJECT_REASONS)},
                "live_capture": {"implemented": True, "autoEligible": True,
                                  "validation": {"status": "offline_dom_fixture", "delivery": "capture_only"}},
                "live_reply": {"implemented": True, "autoEligible": False,
                                "validation": {"status": "offline_dom_fixture", "delivery": "unknown"}},
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

    # ---------------------------------------------------- 评论区两阶段闭环

    def comment_enqueue(self, params):
        """把【已经筛好的】候选目标放进队列。

        关键词匹配 / 排除词 / 点赞阈值 / 作者去重属于流程一
        （images/11-comment-area-business 的「固定流程一：评论采集与筛选」），
        由宿主完成后传进来；本方法只做去重入队，不重复实现筛选。
        """
        targets = params.get("targets")
        if targets is None:
            targets = []
        if not isinstance(targets, list):
            raise SidecarError("invalid_input", "targets must be an array")
        return {"queue": self.comment_queue.append(targets),
                "stats": self.comment_queue.stats()}

    def comment_plan(self, params):
        """取一批 + 冻结双渠道话术。话术由宿主提供，本模块从不自己生成。"""
        max_items = int(params.get("maxItems", comment_flow.MAX_BATCH))
        window_seconds = int(params.get("windowSeconds", comment_flow.WINDOW_DEFAULT))
        if not 1 <= max_items <= comment_flow.MAX_BATCH:
            raise SidecarError("invalid_input", "maxItems is out of range")
        if not 1 <= window_seconds <= 86400:
            raise SidecarError("invalid_input", "windowSeconds is out of range")
        batch = self.comment_queue.take_batch(max_items=max_items,
                                              window_seconds=window_seconds)
        if not batch.get("batchId"):
            return {"status": "empty", "batchId": None,
                    "expiredCount": batch.get("expiredCount", 0),
                    "expired": batch.get("expired") or []}
        plan = self.comment_queue.freeze_plan(batch["batchId"], params.get("scripts"),
                                              params.get("policy"))
        public, rejected = self.comment_queue.public_candidates(batch["batchId"])
        return {
            "status": "ok",
            "batchId": batch["batchId"],
            "createdAt": batch["createdAt"],
            "expiresAt": batch["expiresAt"],
            "expiredCount": batch.get("expiredCount", 0),
            "expired": batch.get("expired") or [],
            "targets": [{"targetKey": t["targetKey"], "targetId": t["targetId"],
                         "authorName": t["authorName"], "text": t["text"],
                         "publicText": t["publicText"], "privateText": t["privateText"]}
                        for t in plan.get("targets") or []],
            "blocked": plan.get("blocked") or [],
            "policySource": plan.get("policySource"),
            "publicCandidates": [t["targetKey"] for t in public],
            "publicRejected": rejected,
        }

    def comment_reply(self, params):
        """第一阶段：逐条公开回复。结果直接决定谁能进入第二阶段。"""
        batch_id, items = _flow_batch_items(params)
        self.comment_queue.ensure_active(batch_id)
        allowed, rejected = self.comment_queue.public_candidates(batch_id)
        by_key = {t["targetKey"]: t for t in allowed}
        results = []
        for item in items:
            key = item.get("targetKey") or item.get("targetId")
            target = by_key.get(key)
            if target is None:
                results.append({"targetKey": key, "status": "skipped",
                                "reason": "not_a_public_candidate"})
                continue
            page, _ = self._page()
            try:
                outcome = send_comment(
                    page, self.gate, str(item.get("sendId") or ""),
                    {"id": target.get("targetId") or target.get("targetKey"),
                     "roomId": target.get("roomId"), "authorId": target.get("authorId"),
                     "authorName": target.get("authorName"), "text": target.get("text")},
                    target.get("publicText"), "video")
            finally:
                page.close()
            status = str(outcome.get("status") or "unknown")
            self.comment_queue.mark_public(key, status, batch_id,
                                           {"reason": outcome.get("reason")})
            results.append({"targetKey": key, "status": status,
                            "reason": outcome.get("reason"), "sendId": outcome.get("sendId")})
        allowed2, rejected2 = self.comment_queue.private_candidates(batch_id)
        return {
            "batchId": batch_id,
            "results": results,
            "rejected": rejected,
            "privateCandidates": [{"targetKey": t["targetKey"], "authorName": t["authorName"]}
                                  for t in allowed2],
            "privateRejected": rejected2,
            "checkpoint": self.comment_queue.result(batch_id)["checkpoint"],
        }

    def comment_private(self, params):
        """第二阶段：只对第一阶段【确认成功】的目标私信。

        unknown 的公开回复在这里被明确拒绝 —— 点击已经发出、结果未定，
        架构与需求都禁止把它变成第二条盲目触达。
        """
        batch_id, items = _flow_batch_items(params)
        self.comment_queue.ensure_active(batch_id)
        allowed, rejected = self.comment_queue.private_candidates(batch_id)
        by_key = {t["targetKey"]: t for t in allowed}
        reject_reasons = {r.get("targetKey"): r.get("reason") for r in rejected}
        results = []
        for item in items:
            key = item.get("targetKey") or item.get("targetId")
            target = by_key.get(key)
            if target is None:
                reason = reject_reasons.get(key) or "not_a_private_candidate"
                self.comment_queue.mark_private(key, "blocked", batch_id, {"reason": reason})
                results.append({"targetKey": key, "status": "blocked", "reason": reason})
                continue
            page, _ = self._page()
            try:
                outcome = send_private(
                    page, self.gate, str(item.get("sendId") or ""),
                    {"authorId": target.get("authorId")},
                    target.get("privateText"))
            finally:
                page.close()
            status = str(outcome.get("status") or "unknown")
            self.comment_queue.mark_private(key, status, batch_id,
                                            {"reason": outcome.get("reason")})
            results.append({"targetKey": key, "status": status,
                            "reason": outcome.get("reason"), "sendId": outcome.get("sendId")})
        return {"batchId": batch_id, "results": results,
                "checkpoint": self.comment_queue.result(batch_id)["checkpoint"]}

    def comment_result(self, params):
        batch_id = str(params.get("batchId") or "")
        if not batch_id:
            raise SidecarError("invalid_input", "batchId is required")
        return {"result": self.comment_queue.result(batch_id),
                "stats": self.comment_queue.stats()}

    def dispatch(self, method, params):
        allowed = {"capabilities", "launch", "doctor", "open", "search",
                   "collect_comments", "collect_live", "send_private", "send_comment",
                   "comment_enqueue", "comment_plan", "comment_reply",
                   "comment_private", "comment_result", "close"}
        if method not in allowed:
            raise SidecarError("unknown_method", "method is not supported")
        fn = getattr(self, method)
        if not isinstance(params, dict):
            raise SidecarError("invalid_input", "params must be an object")
        return fn(params)


def _flow_batch_items(params):
    """两阶段方法共用的入参校验：必须给出 batchId 与非空 items。"""
    batch_id = str(params.get("batchId") or "")
    if not batch_id:
        raise SidecarError("invalid_input", "batchId is required")
    items = params.get("items")
    if not isinstance(items, list) or not items:
        raise SidecarError("invalid_input", "items must be a non-empty array")
    return batch_id, items


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
