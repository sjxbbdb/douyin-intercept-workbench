"""One-request JSONL sidecar for the trusted desktop host.

The sidecar owns no UI and never writes protocol logs to stdout.  One process
handles one request, which makes parent cancellation an unambiguous stop: a
started send remains durable and therefore is not retried automatically.
"""
import argparse
import base64
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
import click_guard
import live
import live_flow
import winfocus
from send_actions import (send_comment, send_danmaku_reply,
                            send_danmaku_reply_native, send_private)
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


# ---------- 搜索游标（架构依据 images/10-video-search-flow）----------
#
# 图 10 要求：「读取一页结果 -> 按固定条件筛选并去重 -> 保存视频池与搜索游标
# -> 尚未达到上限？ -> 申请下一轮搜索」。所以 search 必须能【续页】。
#
# 游标对宿主是【不透明】的：宿主只负责原样保存和回传，不解析内容。
# 但它仍然来自外部，所以和 url / sendId 一样必须在边界上做校验。
#
# 🔴 为什么不直接用平台响应体里的 cursor 去直调接口：那需要伪造签名，属红线，不碰。
#    分页靠的是「页面继续往下滚」；游标里记的是【视频池 + 页码】，
#    去重由 crawl.search_videos(seen_ids=...) 负责。平台自己的 has_more / cursor
#    只作为观测信号一起返回，供宿主记录，不作为翻页依据。

CURSOR_VERSION = 1
CURSOR_MAX_SEEN = 20000


def _encode_cursor(keyword, seen, page_no):
    payload = {"v": CURSOR_VERSION, "k": keyword, "n": int(page_no),
               "seen": sorted(str(x) for x in seen)}
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(value, keyword):
    """返回 (已见视频集合, 页码)。空游标 = 第一页。任何不合法都直接拒绝。"""
    if value in (None, ""):
        return set(), 1
    if not isinstance(value, str) or len(value) > 400000:
        raise SidecarError("invalid_input", "cursor is invalid")
    try:
        payload = json.loads(base64.urlsafe_b64decode(value.encode("ascii")).decode("utf-8"))
    except Exception:
        raise SidecarError("invalid_input", "cursor is not decodable")
    if not isinstance(payload, dict) or payload.get("v") != CURSOR_VERSION:
        raise SidecarError("invalid_input", "cursor version is not supported")
    if payload.get("k") != keyword:
        raise SidecarError("invalid_input", "cursor does not belong to this keyword")
    seen = payload.get("seen")
    if not isinstance(seen, list) or len(seen) > CURSOR_MAX_SEEN:
        raise SidecarError("invalid_input", "cursor pool is invalid")
    try:
        page_no = int(payload.get("n") or 1)
    except (TypeError, ValueError):
        page_no = 1
    return set(str(x) for x in seen), page_no


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


def _filter_text(value, label, limit=400):
    """筛选类参数的校验：可选字符串，去空白、限长。空 = 不做该步筛选。

    为什么单独抽出来：关键词/排除词来自宿主（客户端），属于【外部输入】，
    必须和 url、sendId 一样在边界上校验，不能让超长串顺着流程带下去。
    """
    if value in (None, ""):
        return ""
    if not isinstance(value, str):
        raise SidecarError("invalid_input", "%s must be a string" % label)
    value = value.strip()
    if len(value) > limit:
        raise SidecarError("invalid_input", "%s is too long" % label)
    return value


def _dedupe_by_author(rows):
    """按【评论者】去重：同一个人只留一条（优先留点赞最高的那条）。返回 (保留行, 丢弃数)。

    架构依据 images/11-comment-area-business 流程一「关键词、排除词与去重」。
    为什么按人而不是按评论去重：目标批次的下游是两阶段 ——
      · 第一阶段逐条回复原评论：回复哪条都行，留曝光最高的那条更值；
      · 第二阶段向评论者逐个私信：同一个人只有一条私信额度（未互关仅 1 条），
        不去重就会把额度浪费在同一个人的多条评论上。

    没有 authorId 的评论【不参与合并】—— 否则会把不同人的评论错误地并成一条；
    它们按自身 id 各自保留（这类仍可用于公开回复，只是不能私信）。
    """
    best, order, dropped = {}, [], 0
    for row in rows:
        author = str(row.get("sec_uid") or row.get("author_sec_uid") or "")
        key = ("author", author) if author else ("row", str(row.get("cid") or id(row)))
        if key in best:
            dropped += 1
            if int(row.get("digg") or 0) > int(best[key].get("digg") or 0):
                best[key] = row
            continue
        best[key] = row
        order.append(key)
    return [best[k] for k in order], dropped


# 两阶段契约（评论区固定流程）：公屏回复确认成功之前，不允许进入私信阶段。
PUBLIC_CONFIRMED = "sent_confirmed"
PUBLIC_REPLY_KINDS = ("comment", "danmaku_reply")


def _public_guard(gate, public_send_id):
    """只有「公屏回复确认成功」才允许私信；返回 None 表示放行。

    为什么看原始状态：send_gate 的对外 result() 会把 sent_confirmed 映射成 unknown
    （避免过度宣称），但两阶段契约必须按【落库的原始状态】判断，否则永远进不了私信。

    稳定拒绝原因（宿主可直接据此决定重试或放弃）：
      public_missing    宿主没给 publicSendId（批量清单里属于必修项）
      public_not_found  这个 sendId 在本地台账里不存在
      public_not_a_reply 这个 sendId 不是公屏回复（比如私信记录）
      public_pending    公屏回复尚未有结论（reserved / started）
      public_unknown    公屏结果未知（红线：未知不得自动重试，更不得转私信）
      public_failed     公屏发送失败
      public_blocked    公屏被平台/校验拦下
    """
    send_id = str(public_send_id or "").strip()
    if not send_id:
        return None
    row = gate.lookup(send_id)
    if row is None:
        return ("public_not_found", "the public reply sendId is unknown; private is refused")
    if str(row.get("kind") or "") not in PUBLIC_REPLY_KINDS:
        return ("public_not_a_reply", "that sendId is not a public reply")
    status = str(row.get("status") or "")
    if status in ("reserved", "started"):
        status = "pending"
    if status != PUBLIC_CONFIRMED:
        return ("public_" + status,
                "public reply is %s; only %s allows a private message"
                % (status, PUBLIC_CONFIRMED))
    return None


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
        # 点击审计：每次（含被拒绝的）点击都写一行，便于事后复核落点
        click_guard.set_audit_path(os.path.join(self.state_dir, "click_audit.jsonl"))
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
                # 流程一「关键词、排除词与去重」的筛选能力。
                # 它不是发送动作，不涉及 autoEligible 的发送闸门；
                # 标 offline_fixture 是因为它的验证来自离线回归，不需要真机页面。
                "comment_filter": {"implemented": True, "autoEligible": True,
                                    "validation": {"status": "offline_fixture",
                                                   "delivery": "filter_only"}},
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
                # 回复弹幕（公屏 @该观众）。真机结论 2026-09-20：网页端没有「点弹幕回复」的
                # 原生入口，落地形式是公屏 @昵称；发送键经实测是【回车】。
                # 已有房间消息流回声作证据，但没有平台响应 -> delivery 仍不是 confirmed。
                "live_danmaku_reply": {"implemented": True, "autoEligible": False,
                                        "validation": {"status": "offline_unit_tests+real_run_2026_09_20",
                                                       "delivery": "room_echo_only_platform_response_unavailable",
                                                       "mention": "text_must_start_with_at_nickname",
                                                       "target": "danmaku_must_be_visible_and_unique",
                                                       "sendMechanism": "enter_verified_2026_09_20",
                                                       "realRuns": "9 sends, roomEcho true each time"}},
                # 私信（两阶段里的第二阶段）。真机 2026-09-20 首次跑通一条：
                # 收件人校验用会话头部标题，发送键回车，发送后会话里出现该条。
                # 仍然 autoEligible=false：没有平台响应，且"面板能否打开"是平台侧差异。
                "live_private_reply": {"implemented": True, "autoEligible": False,
                                        "validation": {"status": "offline_unit_tests+real_run_2026_09_20",
                                                       "delivery": "conversation_echo_only_platform_response_unavailable",
                                                       "recipientVerification": "live_panel_header",
                                                       "sendMechanism": "enter_verified_2026_09_20",
                                                       "panelMayNotOpen": "platform_side_difference"}},
                # 评论区固定流程：关键词匹配评论 -> 公开回复 -> 只有 sent_confirmed 才允许私信。
                # 拒绝原因是稳定枚举（见模块级 _public_guard），宿主可直接据此决策。
                "comment_flow": {"implemented": True, "autoEligible": False,
                                  "validation": {"status": "offline_unit_tests",
                                                 "delivery": "unknown",
                                                 "privateGate": "sent_confirmed_only",
                                                 "rejectReasons": ["public_missing",
                                                                   "public_not_found",
                                                                   "public_not_a_reply",
                                                                   "public_pending",
                                                                   "public_unknown",
                                                                   "public_failed",
                                                                   "public_blocked",
                                                                   "missing_author_id"]}},
                # 采集数据源：优先读页面内存里的弹幕数据模型（带 sec_uid），DOM 文本兜底。
                "live_capture_source": {"implemented": True, "autoEligible": False,
                                         "validation": {"status": "page_memory_verified_2026_09_19",
                                                        "identity": "page_memory_100_percent_dom_0_percent",
                                                        "fallback": "dom_text_nickname_only"}},
                # 图 10 的分页能力：search 支持不透明游标续页。
                # 只读/只翻页，不涉及发送，因此不参与发送闸门。
                "video_search_paging": {"implemented": True, "autoEligible": True,
                                        "cursorVersion": CURSOR_VERSION,
                                        "validation": {"status": "offline_fixture",
                                                       "delivery": "paging_only"}},
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
        """按关键词搜视频，支持【分页】（架构依据 images/10-video-search-flow）。

        一次调用 = 读取一页结果：
          · 不带 cursor        -> 从搜索页第一页开始，返回这一页 + 下一页的 cursor；
          · 带上一次返回的 cursor -> 接着往下读一页，池里已有的会先被去重掉。
        宿主负责保存视频池与游标（数据归属见 images/19），并据此判断是否申请下一轮。

        新增字段（都是加法式，老调用方只看 videos 也不受影响）：
          cursor / hasMore / page / poolSize / skippedSeen
          platformHasMore / platformCursor（平台响应体的观测值，只读，不用来直调接口）

        同时返回每条候选的【相关度】记录并支持 `minRelevance` 筛选。

        模块边界（找视频）：只负责【发现与筛选】视频 —— 不回复评论、不私信。
        固定流程第 4 步要求返回「标题、作者、链接、相关度等候选结果」；
        第 5 步「用户选择，或 Agent 按规则交给评论区模块」由宿主决定，
        所以这里只给候选和相关度，不做任何跨模块动作。

        相关度由 crawl.video_relevance 计算：整串命中 > 分词全命中 > 部分命中 > 不命中，
        规则确定、可解释、纯离线。宿主可以用 minRelevance 直接筛，也可以自己排序。

        注意：相关度衡量的是【标题与关键词的字面相关】，不是视频质量；
        热度（点赞/评论数）是另一个维度，需要时由宿主另行获取。
        """
        keyword = params.get("keyword")
        if not isinstance(keyword, str) or not keyword.strip() or len(keyword) > MAX_KEYWORD:
            raise SidecarError("invalid_input", "keyword is required")
        keyword = keyword.strip()
        max_videos = int(params.get("maxVideos", 50))
        rounds = int(params.get("scrollRounds", 6))
        if not 1 <= max_videos <= 200 or not 0 <= rounds <= 40:
            raise SidecarError("invalid_input", "search bounds are invalid")
        cursor_in = params.get("cursor")
        seen, page_no = _decode_cursor(cursor_in, keyword)

        min_relevance = int(params.get("minRelevance", 0) or 0)
        if not 0 <= min_relevance <= 100:
            raise SidecarError("invalid_input", "minRelevance must be between 0 and 100")
        page, _ = self._page()
        try:
            if douyin.login_state(page) == "required":
                return {"status": "login_required", "videos": [], "cursor": cursor_in,
                        "hasMore": False, "page": page_no, "poolSize": len(seen)}
            # 只有【第一页】或【已经不在搜索页上】才重新导航；
            # 否则保持页面原状、继续往下滚 —— 这才是"读取下一页"。
            first_page = cursor_in in (None, "")
            try:
                here = page.evaluate("location.href") or ""
            except Exception:
                here = ""
            navigate = first_page or ("/search/" not in here)
            meta = {}
            with contextlib.redirect_stdout(sys.stderr):
                videos = crawlmod.search_videos(page, keyword, scroll_rounds=rounds,
                                                max_videos=max_videos, log=lambda *a: None,
                                                strict=False, meta=meta,
                                                navigate=navigate, seen_ids=seen)
            out = []
            filtered = 0
            kept = 0
            # 🔴 游标池 = 本页【见过的全部视频】，包含被相关度筛掉的、以及超出 maxVideos 没返回的。
            #    原实现只把"保留下来的"放进池里：被筛掉的视频不在池中，续页时假源（或平台的
            #    滚动重渲染）再给出它们就会被当成新视频重复处理一遍 —— 相关度越高这类样本越多。
            pool = set(seen)
            for video in videos:
                video_id = str(video.get("aweme_id") or "")
                if video_id:
                    pool.add(video_id)
                relevance = crawlmod.video_relevance(video.get("desc"), keyword)
                if relevance["score"] < min_relevance:
                    filtered += 1
                    continue
                if len(out) >= max_videos:
                    # 超出本页返回上限：仍然留在池里（见过就不再当新视频），继续扫描以补全池子。
                    continue
                kept += 1
                out.append({"id": video_id,
                            "url": safe_url(video.get("url"), "video.url"),
                            "title": str(video.get("desc") or "")[:200],
                            "author": str(video.get("author") or "")[:120],
                            "authorId": str(video.get("author_sec_uid") or "")[:200],
                            "relevance": relevance})
            # 本页一条新视频都没有 -> 池子到头了，宿主可以停止翻页。
            captcha = meta.get("stopped_reason") == "captcha"
            if captcha:
                # 🔴 第 2 项：验证码是【终止状态】。原来这里仍然返回可续页的 cursor 与
                #    hasMore=true，上层会据此自动继续翻页，在风控点上越撞越深。
                #    现在明确：不给 cursor、hasMore 恒为 false，并给出停止原因。
                return {"status": "captcha",
                        "videos": out,
                        "cursor": None,
                        "hasMore": False,
                        "stoppedReason": "captcha_requires_manual_action",
                        "page": page_no,
                        "poolSize": len(pool),
                        "skippedSeen": int(meta.get("skipped_seen") or 0),
                        "platformHasMore": meta.get("platform_has_more"),
                        "platformCursor": meta.get("platform_cursor"),
                        "filter": {"collected": len(videos), "returned": len(out),
                                   "filteredByRelevance": filtered, "kept": kept,
                                   "poolAdded": len(pool) - len(seen),
                                   "minRelevance": min_relevance}}
            return {"status": "ok",
                    "videos": out,
                    "cursor": _encode_cursor(keyword, pool, page_no + 1),
                    "hasMore": bool(out),
                    "page": page_no,
                    "poolSize": len(pool),
                    "skippedSeen": int(meta.get("skipped_seen") or 0),
                    "platformHasMore": meta.get("platform_has_more"),
                    "platformCursor": meta.get("platform_cursor"),
                    "filter": {"collected": len(videos), "returned": len(out),
                               "filteredByRelevance": filtered, "kept": kept,
                               "poolAdded": len(pool) - len(seen),
                               "minRelevance": min_relevance}}
        finally:
            page.close()

    def collect_comments(self, params):
        """采集一条视频的评论，并按「关键词 / 排除词 / 去重」给出目标批次。

        架构依据 images/11-comment-area-business 固定流程一：
          「采集评论 → 关联评论标识与评论者 → 关键词、排除词与去重 → 返回目标批次」

        返回值是【加法式】的，老的调用方不受影响：
          · events   —— 原样：本次采集到的评论事件（未筛选），语义不变；
          · targets  —— 新增：筛选后的目标批次，每条与 events 同形状，
                        可直接喂给 send_comment / send_private（两阶段发送）；
          · filter   —— 新增：筛选统计，用来判断该松还是该紧。

        为什么不直接把 events 筛掉：events 是"采集事实"，宿主可能需要原始批次做审计；
        筛选是业务判断，必须能分开追溯（对应架构的审计与状态镜像）。
        """
        requested_url = safe_url(params.get("url"), "url", keep_query=True)
        max_items, rounds = int(params.get("maxItems", 100)), int(params.get("scrollRounds", 6))
        if not 1 <= max_items <= 500 or not 0 <= rounds <= 40:
            raise SidecarError("invalid_input", "comment bounds are invalid")

        # ---- 筛选参数（流程一的输入）----
        comment_keywords = _filter_text(params.get("commentKeywords"), "commentKeywords")
        exclude_keywords = _filter_text(params.get("excludeKeywords"), "excludeKeywords")
        match_mode = str(params.get("matchMode") or "seg")
        if match_mode not in crawlmod.MATCH_MODES:
            raise SidecarError("invalid_input",
                               "matchMode must be one of %s" % "/".join(crawlmod.MATCH_MODES))
        min_digg = int(params.get("minDigg", 0) or 0)
        if not 0 <= min_digg <= 1000000:
            raise SidecarError("invalid_input", "minDigg is out of range")
        max_targets = int(params.get("maxTargets", 200) or 200)
        if not 1 <= max_targets <= 500:
            raise SidecarError("invalid_input", "maxTargets is out of range")
        dedupe_authors = bool(params.get("dedupeAuthors", True))

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

            # 流程一：关键词 -> 排除词 -> 点赞阈值 -> 按评论者去重
            matched, fstats = crawlmod.filter_comments(
                rows, comment_keywords, mode=match_mode, min_digg=min_digg,
                exclude_keywords=exclude_keywords)
            if dedupe_authors:
                kept, deduped = _dedupe_by_author(matched)
            else:
                kept, deduped = matched, 0
            targets = []
            for row in kept[:max_targets]:
                item = _event("video", url, row)
                item["matchedKeyword"] = str(row.get("matched_keyword") or "")
                item["digg"] = int(row.get("digg") or 0)
                targets.append(item)
            filtered = {
                "collected": len(rows),
                "matched": int(fstats.get("matched") or 0),
                "excluded": int(fstats.get("excluded") or 0),
                "lowDigg": int(fstats.get("low_digg") or 0),
                "noAuthor": int(fstats.get("no_sec_uid") or 0),
                "dedupedAuthors": int(deduped),
                "targetCount": len(targets),
                "matchMode": match_mode,
                "keywords": list(fstats.get("keywords") or []),
                "excludeKeywords": list(fstats.get("exclude_keywords") or []),
                "modeCounts": dict(fstats.get("modes") or {}),
            }
            return {"status": status, "events": events, "targets": targets, "filter": filtered,
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
        """私信。可选 publicSendId：给出时必须已确认成功，否则在打开浏览器之前就拒绝。"""
        send_id = str(params.get("sendId") or "")
        target = params.get("target")
        text = params.get("text")
        # 🔴 两阶段契约在【打开浏览器之前】判定（fail-closed）：
        #    不该发的连页面都不开，既省一次风控暴露，也不会留下"点了一半"的现场。
        refusal = _public_guard(self.gate, params.get("publicSendId"))
        if refusal:
            raise SidecarError(refusal[0], refusal[1])
        page, _ = self._page()
        try:
            return send_private(page, self.gate, send_id, target, text)
        finally:
            page.close()

    def comment_private_candidates(self, params):
        """把一个批次按「公屏是否确认成功」分成 allowed / rejected（只读，不碰浏览器）。

        架构依据：评论区固定流程 —— 关键词匹配评论 -> 公开回复 -> **只有 sent_confirmed
        才允许私信**；unknown / failed / blocked 一律禁止进入私信。
        每条拒绝都给稳定的原因，宿主据它决定重试、人工处理还是放弃。

        items[i] 需要 {eventId, authorId, authorName, publicSendId}；缺 publicSendId 的按
        public_missing 拒绝 —— 批量清单的存在意义就是替宿主守住这条流程契约。
        （单发 send_private 仍可不带 publicSendId：那是宿主自己已经确认过时的低层入口。）
        """
        items = params.get("items")
        if not isinstance(items, list) or not items:
            raise SidecarError("invalid_input", "items must be a non-empty list")
        allowed, rejected = [], []
        for item in items:
            if not isinstance(item, dict):
                raise SidecarError("invalid_input", "each item must be an object")
            event_id = str(item.get("eventId") or "").strip()
            author_id = str(item.get("authorId") or "").strip()
            public_send_id = str(item.get("publicSendId") or "").strip()
            if not public_send_id:
                rejected.append({"eventId": event_id, "reason": "public_missing"})
                continue
            refusal = _public_guard(self.gate, public_send_id)
            if refusal:
                rejected.append({"eventId": event_id, "reason": refusal[0]})
                continue
            if not author_id:
                rejected.append({"eventId": event_id, "reason": "missing_author_id"})
                continue
            allowed.append({"eventId": event_id, "authorId": author_id,
                            "authorName": str(item.get("authorName") or "")[:120],
                            "publicSendId": public_send_id})
        return {"status": "ok", "allowed": allowed, "rejected": rejected,
                "policy": {"allowPublicStates": [PUBLIC_CONFIRMED]}}

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
            sources = {}
            for row in rows:
                key = str(row.get("source") or "unknown")
                sources[key] = sources.get(key, 0) + 1
            identified = len([row for row in rows if str(row.get("authorId") or "").strip()])
            return {"status": "ok", "events": events, "queue": queue,
                    "capability": {"verified": bool(events),
                                   # 首选页面内存（带 sec_uid），不可用时才回落到 DOM 文本。
                                   "source": ("page_memory" if sources.get("page_memory")
                                              else "visible_dom"),
                                   "sources": sources,
                                   "identityCoverage": "%d/%d" % (identified, len(rows)),
                                   "detail": "queue dedupes by room/author/text; the batch window is enforced at planning"}}
        finally:
            page.close()

    def live_plan(self, params):
        """Form one batch and freeze the host-provided two-channel scripts.

        Events outside the window are reported as expired and never replayed.
        Keywords - when the host supplies them - are matched before the batch is
        formed, so a comment that does not match is marked 'filtered' and never
        takes a batch slot.  A target whose scripts are missing or out of bounds
        is blocked here, before any browser action happens.
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
        reply_via = str(params.get("replyVia") or "native")
        if reply_via not in live_flow.REPLY_VIAS:
            raise SidecarError("invalid_input",
                               "replyVia must be one of %s" % ", ".join(live_flow.REPLY_VIAS))
        reply_mode = str(params.get("replyMode") or "composer")
        if reply_mode not in live_flow.REPLY_MODES:
            # composer = 公屏普通评论；danmaku = 公屏 @该观众 的评论（回复弹幕）
            raise SidecarError("invalid_input",
                               "replyMode must be one of %s" % ", ".join(live_flow.REPLY_MODES))
        spec = live_flow.normalize_filter(params.get("keywords"),
                                          params.get("excludeKeywords"),
                                          params.get("matchMode") or "seg")
        batch = self.live_queue.take_batch(
            max_items=max_items, window_seconds=window_seconds,
            filters=spec if live_flow.filter_is_active(spec) else None)
        summary = {key: batch[key] for key in
                   ("batchId", "createdAt", "expiresAt", "expiredCount", "frozen", "status")}
        summary["filter"] = batch.get("filter") or {}
        if not batch["events"]:
            # 关键词未命中或队列为空：都不建立批次，下一次监听到达后会形成新的批次
            return {"status": "empty", "batch": summary, "targets": [], "blocked": [],
                    "expired": batch["expired"], "filter": batch["filter"]}
        plan = self.live_queue.freeze_plan(batch["batchId"], params.get("scripts"),
                                           params.get("policy"), reply_mode=reply_mode,
                                           reply_via=reply_via)
        return {"status": "ok" if plan["targets"] else "blocked", "batch": summary,
                "targets": plan["targets"], "blocked": plan["blocked"],
                "expired": batch["expired"], "filter": batch["filter"],
                "replyMode": plan.get("replyMode"), "replyVia": plan.get("replyVia"),
                "policy": plan["policy"], "policySource": plan.get("policySource")}

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
        mode = str(plan.get("replyMode") or "composer")
        reply_via = str(plan.get("replyVia") or "native")
        requested = params.get("mode")
        if requested is not None and str(requested) != mode:
            # 落地方式在冻结计划时定稿。中途改口会让同一批次里出现两种触达方式，
            # 去重与审计都无法解释，所以这里一律拒绝。
            raise SidecarError("mode_mismatch",
                               "the frozen plan replies as %s, not %s" % (mode, requested))
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
                    if mode == "danmaku" and reply_via == "native":
                        # 原生「回复 TA」：点弹幕 -> 菜单 -> 回复 TA -> 平台插入 @昵称 -> 打字 -> 回车
                        outcome = send_danmaku_reply_native(page, self.gate, item["sendId"],
                                                            comment_target, text)
                    elif mode == "danmaku":
                        # 回落：公屏发一条 @该弹幕作者 的纯文本消息
                        outcome = send_danmaku_reply(page, self.gate, item["sendId"],
                                                     comment_target, text)
                    else:
                        outcome = send_comment(page, self.gate, item["sendId"], comment_target,
                                               text, "live")
                    status = str(outcome.get("status") or "unknown")
                    evidence = outcome.get("evidence") or {}
                    if mode == "danmaku" and evidence.get("roomEcho"):
                        # 房间消息流里出现了自己刚发的那条：本通道目前能拿到的最强证据（真机实测）。
                        # 它仍然不是平台响应，所以单独记一个状态，绝不冒充 sent_confirmed ——
                        # 默认策略 allowPublicStates 只放行 sent_confirmed，因此不会自动私信，
                        # 要不要按 sent_echoed 继续由平台侧的 policy 决定。
                        status = live_flow.SENT_ECHOED
                    self.live_queue.mark(item["eventId"], status, batch_id,
                                         {"sendId": item["sendId"],
                                          "reason": outcome.get("reason"),
                                          "mechanism": evidence.get("mechanism"),
                                          "roomEcho": evidence.get("roomEcho")})
                    results.append(dict(outcome, eventId=item["eventId"], recordedState=status))
            finally:
                page.close()
        allowed, rejected = self.live_queue.private_candidates(batch_id)
        return {"status": "ok" if sendable else "blocked", "phase": "public", "results": results,
                "replyMode": mode,
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
                   "comment_private_candidates",
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
