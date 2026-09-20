"""私信自动化 —— 遵守平台自己的额度，只对平台确认成功的发送计数。

三条硬约束（来自 02-私信通与官方IM能力查证.md 的官方原文）：
  · 同一用户主动私信 ≤ 3 条
  · 每小时触达 ≤ 40 个用户
  · 每日触达 ≤ 100 个用户

红线 2：判定"发送成功"必须依据【平台响应体】，DOM 变化不算；空响应 = 风控拒绝。
红线 1：以上数值不得硬编码在逻辑里，统一从 LIMITS 读；实际部署时应由服务端下发。

本模块【不做】也不应做：验证码识别、指纹混淆、签名伪造、多账号轮换规避风控。
遇验证码一律熔断等人工。
"""
import json
import math
import os
import random
import time
import uuid

import douyin
import scripts as st
import winfocus
import dyselectors as S

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")

# 官方额度（红线 1：唯一来源，禁止散落硬编码）
LIMITS = {
    # ⚠️⚠️ 2026-09-19 纠正：非互关 + 非企业号，只能主动私信【1 条】！
    #
    # 抖音官方公告原文（2022-05-09）：
    #   "当接收到未关注人发来的私信时，将仅显示 1 条私信提醒。
    #    用户可选择是否回复，若回复则与对方开启单次临时会话，
    #    仅限文字交流，有效期为 24 小时。"
    #
    # ⚠️ 官方 enterprise.im 文档写的"不超过 3 条"是【企业号】的额度。
    #    把它套到个人号上是错的（我先前就是这么错的）。
    #    3 条的前提是：企业号 + 已开通 enterprise.im 能力。
    "per_user_max": 1,
    # 对方回复后开启的"单次临时会话"窗口（仅限文字）
    "reply_window_hours": 24,
    "per_hour_users": 40,
    "per_day_users": 100,
    "active_hours": (8, 23),
    # 单条间隔：对数正态（更像真人），但硬钳在区间内。
    # ⚠️ 用户要求 10-60s。注意这比原先（中位 45s）【更快】，
    #    真正的风控保护来自分批休息，不是把间隔调小。
    "interval_median_sec": 32.0,
    "interval_sigma": 0.55,
    "interval_range": (10.0, 60.0),
    # 分批：每批发 N 条，然后休息。
    # 真机/常识依据：连续一小时不停给陌生人发私信，本身就是最明显的机器特征，
    # 单靠间隔随机化盖不住。
    "batch_size": 12,
    "batch_rest_range": (300.0, 600.0),   # 用户选：批间休息 5-10 分钟
    "observation_days": 3,      # 新号观察期：只采集不发送
}

# 明显不是业务接口的 URL，避免把它们也抓下来
_URL_NOISE = ("slardar", "monitor", "log.", "logs", "/webcast/", ".js", ".css", ".png",
              ".jpg", ".jpeg", ".webp", ".woff", ".svg", "/service/", "bytedance", "toutiao",
              "byteimg", "douyinpic", "volces", "volcengine")


_STATIC_EXT = (".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff", ".woff2",
               ".svg", ".ico", ".mp4", ".m4s", ".ttf")


def _capture_any(url):
    """发送期间：抓所有非静态资源请求，不限域名。

    目的：在还不知道发送接口长什么样的时候，先把现场完整录下来。
    """
    u = (url or "").lower()
    if not u.startswith("http"):
        return False
    head = u.split("?", 1)[0]
    if head.endswith(_STATIC_EXT):
        return False
    return True


def is_candidate_url(url):
    u = (url or "").lower()
    if not u.startswith("http"):
        return False
    if any(tok in u for tok in _URL_NOISE):
        return False
    return "douyin.com" in u


class WSFrameLog:
    """记录 WebSocket 帧，用于发现私信发送的真实通道。

    2026-09-19 实测：私信发送【没有】走 HTTP POST
    （当时只捕获到 /im/get/online_feedback/entrance/ 与 cloudpush/update_sender/ 两个心跳），
    推断走 WebSocket。旧项目的 _ws*_frames.json 也是这么抓的。

    边界：只记录帧的方向/长度/头部片段用于定位接口，
    不做解码、不重放、不伪造签名。
    """

    def __init__(self, cdp, limit=80):
        self.frames = []
        self.limit = limit
        self.sockets = []
        cdp.on("Network.webSocketFrameSent", lambda p: self._push("sent", p))
        cdp.on("Network.webSocketFrameReceived", lambda p: self._push("recv", p))
        cdp.on("Network.webSocketCreated", self._created)

    def _created(self, p):
        if len(self.sockets) < 20:
            self.sockets.append((p.get("url") or "")[:120])

    def _push(self, direction, p):
        if len(self.frames) >= self.limit:
            return
        resp = p.get("response") or {}
        payload = resp.get("payloadData") or ""
        self.frames.append({"dir": direction, "op": resp.get("opcode"),
                            "len": len(payload), "head": payload[:100]})


# ===================== 落盘 =====================

def ensure_state_dir():
    os.makedirs(STATE_DIR, exist_ok=True)
    return STATE_DIR


class Ledger:
    """append-only 台账。

    红线 2：send_id 必须在【发送前】生成并落盘，崩溃后靠它幂等，
    否则会出现"重复发送 + 重复计费"。
    """

    def __init__(self, name="send_ledger.jsonl"):
        ensure_state_dir()
        self.path = os.path.join(STATE_DIR, name)

    def new_send_id(self):
        sid = uuid.uuid4().hex
        self._append({"kind": "intent", "send_id": sid, "at": time.time()})
        return sid

    def record(self, payload):
        self._append(payload)

    def _append(self, obj):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def all(self):
        if not os.path.exists(self.path):
            return []
        out = []
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        pass
        return out


class Quota:
    """按官方口径计额度。

    🔴 2026-09-19 修正（真机撞出来的严重 bug）：这里要计【真的占用过对方一次机会】的动作，
       而不是只计 sent_confirmed —— 见下面 _attempted()。
    """

    # 判定为"已经点过发送"的 verdict。
    # sent_dom_confirmed 是私信通道上能拿到的最强证据（文案出现在会话列表，见 04 文档 §十四），
    # 但原实现只认 sent_confirmed，于是它【一条都不计数】。
    ATTEMPTED_VERDICTS = ("sent_confirmed", "sent_dom_confirmed", "submitted", "unverified")

    def __init__(self, ledger):
        self.ledger = ledger

    def _confirmed(self):
        rows = [r for r in self.ledger.all() if r.get("kind") == "result" and r.get("verdict") == "sent_confirmed"]
        return rows

    def _attempted(self):
        """我们【真的点过发送】的记录。

        为什么按它算额度：
          · 漏判比误判贵。把"可能已经发出去了"算进去，最坏是少发一条；
            不算进去，就可能重复打扰同一个人 —— 而这正是平台最敏感的行为。
          · 实测后果（原实现）：暖暖💞 在 10 分钟内被同一个工具发了【两条】私信，
            额度闸一次都没拦住；每日 100 / 每小时 40 的上限也从来没生效过。
        """
        return [r for r in self.ledger.all()
                if r.get("kind") == "result" and r.get("verdict") in self.ATTEMPTED_VERDICTS]

    def used_today(self):
        start = time.time() - 24 * 3600
        seen = {r["target"] for r in self._attempted() if r.get("at", 0) >= start and r.get("target")}
        return len(seen)

    def used_last_hour(self):
        start = time.time() - 3600
        seen = {r["target"] for r in self._attempted() if r.get("at", 0) >= start and r.get("target")}
        return len(seen)

    def used_for_user(self, sec_uid):
        return len([r for r in self._attempted() if r.get("target") == sec_uid])

    def check(self, sec_uid):
        if self.used_today() >= LIMITS["per_day_users"]:
            return False, "quota_day_exceeded"
        if self.used_last_hour() >= LIMITS["per_hour_users"]:
            return False, "quota_hour_exceeded"
        if self.used_for_user(sec_uid) >= LIMITS["per_user_max"]:
            return False, "quota_user_exceeded"
        hour = time.localtime().tm_hour
        lo, hi = LIMITS["active_hours"]
        if not (lo <= hour < hi):
            return False, "outside_active_hours"
        return True, "ok"

    def snapshot(self):
        return {
            "day_used": self.used_today(),
            "day_limit": LIMITS["per_day_users"],
            "hour_used": self.used_last_hour(),
            "hour_limit": LIMITS["per_hour_users"],
            "per_user_max": LIMITS["per_user_max"],
        }


# ===================== 间隔 =====================

def lognormal_delay():
    """对数正态随机化间隔。

    交接包 §2.11：固定间隔（每 10 秒一条）是最容易被识别的机器人特征。
    """
    mu = math.log(LIMITS["interval_median_sec"])
    value = random.lognormvariate(mu, LIMITS["interval_sigma"])
    lo, hi = LIMITS["interval_range"]
    return max(lo, min(hi, value))


def batch_rest_delay():
    lo, hi = LIMITS["batch_rest_range"]
    return random.uniform(lo, hi)


# ===================== 单个目标的发送 =====================

def _editor_cleared(tab):
    """输入框文字是否已被清空。

    这是【诊断信号】，不是"发送成功"的判据（红线 2 只认平台响应）。
    用途：区分"点了但没触发" 与 "触发了但响应没抓到"。
    """
    try:
        c = douyin.dm_composer(tab)
        if not c.get("found"):
            return None
        t = (c.get("text") or "").replace("\u200b", "").strip()
        return t == ""
    except Exception:
        return None


def _read_conversation(tab, limit=1200):
    """读私信会话区文字。

    为什么需要它（2026-09-19 实测结论）：
      发送走的是 IM 长连接，CDP Network 域【抓不到】发送请求
      （实测 POST=0、无带内容的 WS 发送帧）。
      所以红线 2 原来设想的"拿平台响应体 status_code=0"在这个通道上做不到。
      退而求其次：消息出现在【会话列表】里 —— 会话是从服务端拉的，
      能证明平台侧已记录。这比"输入框清空"强得多，但仍弱于响应码。
    """
    # 真机定位（2026-09-19）：会话消息在 messageMessageListwrapper（class 含 MessageList），
    # 不是输入框的祖先节点 —— 先前读输入框祖先，拿到的是空字符串，误判成"没发出去"。
    js = (
        "(function(){"
        "var el=document.querySelector('[class*=\"messageMessageListwrapper\"]')"
        "||document.querySelector('[class*=\"MessageList\"]');"
        "var t = el ? (el.innerText||'') : '';"
        "if(!t){ t = document.body ? document.body.innerText : ''; }"
        "return t.replace(/[ \t]+/g,' ').trim().slice(0,2000);})()"
    )
    try:
        return tab.evaluate(js) or ""
    except Exception:
        return ""


def prepare_and_maybe_send(cdp, tab_id, target, text, allow_send, ledger, quota):
    """对单个目标：开主页 -> 探测私信入口 -> 预填 -> (可选)发送并验证。

    allow_send=False 时【只预填不发送】——这是默认，最安全。
    """
    sec_uid = target["sec_uid"]
    result = {
        "target": sec_uid, "nick": target.get("nick"), "at": time.time(),
        "verdict": "unknown", "reason": "",
    }

    ok, reason = quota.check(sec_uid)
    if not ok:
        result.update(verdict="skipped", reason=reason)
        return result

    # 复用调用方传入的 worker 标签（cdp 参数保留兼容；tab_id 未使用）。
    # 真机观察（2026-09-19）：每个目标都新建标签时，私信面板约 1/3 概率打不开；
    # 复用同一个已激活的标签更稳，也更快。
    tab = cdp
    try:
        # 每个目标开始前重新激活：上一次发送/导航之后，标签很可能已经失活（见下面的说明）。
        if tab_id:
            cdp.activate_target(tab_id)
            time.sleep(0.4)
        tab.call("Page.navigate", {"url": douyin.profile_url(sec_uid)}, timeout=35)
        deadline = time.time() + 35
        while time.time() < deadline:
            try:
                if tab.evaluate("document.readyState") == "complete":
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(3.0)
        if douyin.check_captcha(tab):
            result.update(verdict="failed", reason="CAPTCHA")
            result["_circuit_break"] = "captcha"
            return result
        if douyin.check_login_required(tab):
            result.update(verdict="failed", reason="login_required")
            result["_circuit_break"] = "login_required"
            return result

        entry = douyin.dm_entry(tab)
        if entry.get("blocked"):
            result.update(verdict="skipped", reason="stranger_dm_disabled")
            return result
        if not entry.get("found"):
            result.update(verdict="skipped", reason=entry.get("reason") or "dm_button_not_found")
            return result

        # 点击「私信」。
        # 🔴 真机定位到的真正原因（2026-09-19 第二轮）：
        #    不是"平台限流"，而是【worker 标签失去了活动标签地位】——
        #    此时 document.visibilityState === "hidden"，
        #    Input.dispatchMouseEvent 的点击【不会送达渲染进程】，而且不报错。
        #    症状：批量跑时第 1 个目标正常，之后频繁"面板打不开"。
        #    对照实验：用唯一的活动标签连测 3 次，3 次都在 1.5s 内打开。
        #    处置：每次点击前先把标签重新激活并确认可见性。
        composer = {"found": False}
        for _attempt in range(3):
            if tab_id and douyin.visibility_state(tab) != "visible":
                cdp.activate_target(tab_id)
                try:
                    tab.call("Page.bringToFront", {}, timeout=5)
                except Exception:
                    pass
                # CDP 的置前改不了 Windows 的遮挡判定 —— 真机日志里出现过
                # visibility 仍是 hidden 的情况，只能真的把窗口激活一次。
                if douyin.visibility_state(tab) != "visible":
                    winfocus.bring_chrome_front()
                time.sleep(0.8)
            result["visibility"] = douyin.visibility_state(tab)
            # ⚠️ 每次重试都【重新读取】按钮坐标：页面可能位移，
            #    用缓存的旧坐标点击会点空（真机观察：面板时开时不开）。
            fresh_entry = douyin.dm_entry(tab)
            if fresh_entry.get("found"):
                entry = fresh_entry
            tab.click_at(entry["x"], entry["y"])
            for _ in range(10):
                time.sleep(1.5)
                composer = douyin.dm_composer(tab)
                if composer.get("found"):
                    break
            if composer.get("found"):
                break
        if not composer.get("found"):
            result.update(verdict="failed", reason="dm_composer_not_open_after_retries")
            return result
        result["composer_scope"] = composer.get("scope")

        # 预填前先落 send_id（红线 2：发送前生成）
        send_id = ledger.new_send_id()
        result["send_id"] = send_id

        tab.click_at(composer["x"], composer["y"])
        time.sleep(0.8)
        # 逐字真实按键输入（见 cdp.type_text 的说明：insertText 可能不更新 React 状态）
        tab.type_text(text)
        time.sleep(1.5)

        after = douyin.dm_composer(tab)
        filled = text[:12] in (after.get("text") or "")
        if not filled:
            result.update(verdict="failed", reason="text_not_inserted")
            return result

        if not allow_send:
            result.update(verdict="prepared_only", reason="dry_run_no_send")
            return result

        # ---- 真正发送：必须抓平台响应体 ----
        # 捕获范围【不限 douyin.com】。
        # 真机教训（2026-09-19）：只匹配 douyin.com 时，某次发送连一个 POST 都没抓到，
        # 说明发送请求可能落在别的域（或走了别的通道）。宁可多抓，再人工筛。
        recorder = douyin.make_network_recorder(tab, _capture_any)
        wslog = WSFrameLog(tab)
        for evt in ("Network.enable",):
            try:
                tab.call(evt, {}, timeout=10)
            except Exception:
                pass

        # 找发送按钮。
        # 真机发现（2026-09-19）：输入文字后按钮【不是立刻出现】（React 重渲染），
        # 且面板本身打开不稳定。必须耐心轮询，4 次×1s 不够。
        btn = {"found": False}
        for _ in range(12):
            btn = douyin.dm_send_button(tab)
            if btn.get("found"):
                break
            time.sleep(1.5)
        if not btn.get("found"):
            # 把现场信息带回去，避免下次还要靠猜
            result["diag"] = {"composer": douyin.dm_composer(tab),
                              "editor_text": (douyin.dm_composer(tab) or {}).get("text")}
            result.update(verdict="failed", reason="send_button_not_found")
            return result
        if btn.get("disabled"):
            result.update(verdict="failed", reason="send_button_disabled")
            return result

        # ⚠️ 真机发现：输入文字后面板会位移（输入框 x 由 1465 变到 1485）。
        #    必须【在点击前重新读取坐标】，不能用早先的缓存值，否则点错位置。
        fresh = douyin.dm_send_button(tab)
        if fresh.get("found"):
            btn = fresh
        time.sleep(0.4)
        tab.click_at(btn["x"], btn["y"])

        # 诊断：点完发送后，输入框应当被清空。
        # 若文字还在，说明这次点击【没有触发发送】。
        time.sleep(1.8)
        cleared = _editor_cleared(tab)
        result["editor_cleared_after_click"] = cleared

        if not cleared:
            # 备选通道：Enter 发送
            # legacy reply_worker.js 明确提过 "Enter-send requires active tab"。
            try:
                tab.press_key("Enter", code="Enter", key_code=13)
            except Exception as exc:
                result["enter_error"] = str(exc)
            time.sleep(2.0)
            cleared2 = _editor_cleared(tab)
            result["editor_cleared_after_enter"] = cleared2

        time.sleep(1.5)
        conv = _read_conversation(tab)
        result["conversation_has_text"] = text in conv if conv else None
        result["conversation_tail"] = conv[-260:] if conv else ""

        records = recorder.collect(wait_seconds=10.0)

        posts = [r for r in records if (r.get("method") or "").upper() == "POST"]

        # 逐条记录，供发现真实发送接口
        details = []
        for r in posts:
            parsed = r.get("parsed") or {}
            status = None
            if isinstance(parsed, dict):
                data = parsed.get("data") if isinstance(parsed.get("data"), dict) else parsed
                status = data.get("status_code", parsed.get("status_code"))
            details.append({"url": (r.get("url") or "")[:150], "http": r.get("httpStatus"),
                            "status_code": status})
        result["observed_posts"] = details
        result["ws_frames"] = wslog.frames[:20]
        result["ws_sockets"] = wslog.sockets

        mark = S.DM_SEND_URL_MARK
        matched = [d for d in details if mark and mark in (d["url"] or "")]
        confirmed = any(d.get("status_code") == 0 for d in matched)

        # 证据分级（2026-09-19 实测后的结论）：
        #   私信走 IM 长连接，CDP Network 域【抓不到发送请求】
        #   （实测 POST=0、无带内容的 WS 发送帧），
        #   所以红线 2 原设想的 platform_response + status_code 在此通道上不可得。
        #   现实可用证据，由强到弱：
        #     sent_confirmed      平台响应码 = 0            （本通道拿不到）
        #     sent_dom_confirmed  文案出现在【会话列表】里   （会话来自服务端，较强）
        #     submitted           输入框被清空              （仅证明前端提交，最弱）
        # 🔴 先判"平台明确拒绝"，再判成功。
        #    会话面板里出现拦截文案 = 这条【没发出去】，哪怕文案本身也在面板里。
        conv_text = result.get("conversation_tail") or ""
        blocked = next((t for t in S.DM_SEND_FAILED_TEXTS if t in conv_text), None)
        result["replies_blocked"] = S.DM_REPLY_BLOCKED_TEXT in conv_text
        if blocked:
            result.update(verdict="blocked", reason="platform_rejected:%s" % blocked)
            return result

        if mark and confirmed:
            result.update(verdict="sent_confirmed", reason="platform_response")
        elif result.get("conversation_has_text") is True:
            result.update(verdict="sent_dom_confirmed",
                          reason="message_in_conversation_panel")
        elif result.get("editor_cleared_after_click") or result.get("editor_cleared_after_enter"):
            result.update(verdict="submitted", reason="editor_cleared_only")
        else:
            result.update(verdict="failed", reason="not_submitted")
        return result

    except Exception as exc:
        result.update(verdict="failed", reason="exception:%s" % exc)
        return result


def run_batch(cdp, targets, text_template, allow_send, log=print,
              use_templates=True):
    """批量执行。返回汇总。

    use_templates=True（默认）：从 scripts.TEMPLATES 里【均衡轮换】取模板，注入 {nick}。
      同时把 template_id 记进账本，便于事后按回复率比较。
      ⚠️ 2026-09-19 起模板【不再引用对方评论】，同一模板对不同人几乎同一句话——
         唯一性下降，所以节奏（间隔/分批）比话术本身更关键。
    use_templates=False：对所有目标用同一段 text_template（仅调试用）。
    """
    if use_templates:
        log("话术库：%d 条模板，均衡轮换（已不再引用对方评论，见 scripts.py 文件头第 2 条）"
            % len(st.TEMPLATES))
        log("节奏  ：每批 %d 条，单条 %.0f-%.0fs，批间休息 %.0f-%.0f 分钟"
            % (LIMITS["batch_size"], LIMITS["interval_range"][0], LIMITS["interval_range"][1],
               LIMITS["batch_rest_range"][0] / 60, LIMITS["batch_rest_range"][1] / 60))
    ledger = Ledger()
    quota = Quota(ledger)
    summary = {"total": len(targets), "sent_confirmed": 0, "sent_dom_confirmed": 0,
               "submitted": 0, "skipped": 0, "failed": 0,
               "prepared_only": 0, "unverified": 0, "stopped_reason": None, "results": []}

    # 复用【同一个】worker 标签（真机观察：每个目标新建标签时面板约 1/3 概率打不开）
    worker, wid = cdp.new_tab("about:blank", wait_ready=False, timeout=25)
    cdp.activate_target(wid)
    time.sleep(2.0)

    for idx, target in enumerate(targets, 1):
        ok, reason = quota.check(target["sec_uid"])
        if not ok:
            log("[%d/%d] 跳过 %s —— %s" % (idx, len(targets), target.get("nick") or target["sec_uid"], reason))
            row = {"target": target["sec_uid"], "nick": target.get("nick"),
                   "verdict": "skipped", "reason": reason, "at": time.time()}
            summary["skipped"] += 1
            summary["results"].append(row)
            ledger.record(dict(row, kind="result"))
            if reason in ("quota_day_exceeded", "outside_active_hours"):
                summary["stopped_reason"] = reason
                break
            continue

        tpl = None
        if use_templates:
            tpl = st.pick_template(ledger)
            text = st.render(tpl,
                             nick=target.get("nick") or "",
                             comment=target.get("comment") or "",
                             video_title=target.get("video_title") or "")
            safe, why = st.assert_safe(text)
            if not safe:
                row = {"target": target["sec_uid"], "nick": target.get("nick"),
                       "verdict": "skipped", "reason": why, "at": time.time()}
                summary["skipped"] += 1
                summary["results"].append(row)
                ledger.record(dict(row, kind="result"))
                log("[%d/%d] 跳过 —— 话术安全检查未通过：%s" % (idx, len(targets), why))
                continue
        else:
            text = text_template.replace("{nick}", target.get("nick") or "")

        tag = ("[%s/%s] " % (tpl["id"], tpl["angle"])) if tpl else ""
        log("[%d/%d] %s%s" % (idx, len(targets), tag, (target.get("nick") or target["sec_uid"])[:20]))
        log("      文案：%s" % text[:60])
        row = prepare_and_maybe_send(worker, wid, target, text, allow_send, ledger, quota)
        if tpl:
            row["template_id"] = tpl["id"]
            row["angle"] = tpl["angle"]
        verdict = row.get("verdict")
        if verdict == "sent_confirmed":
            summary["sent_confirmed"] += 1
        elif verdict == "sent_dom_confirmed":
            summary["sent_dom_confirmed"] += 1
        elif verdict == "submitted":
            summary["submitted"] += 1
        elif verdict == "unverified":
            summary["unverified"] += 1
        elif verdict == "skipped":
            summary["skipped"] += 1
        elif verdict == "prepared_only":
            summary["prepared_only"] += 1
        else:
            summary["failed"] += 1
        summary["results"].append(row)
        ledger.record(dict(row, kind="result"))
        log("      -> %s %s" % (verdict, row.get("reason")))

        # 熔断
        if row.get("_circuit_break"):
            summary["stopped_reason"] = "circuit_break:" + str(row["_circuit_break"])
            log("!! 熔断：%s —— 已停止后续发送，请人工检查账号" % row["_circuit_break"])
            break

        if idx < len(targets):
            if LIMITS["batch_size"] and idx % LIMITS["batch_size"] == 0:
                rest = batch_rest_delay()
                log("      == 本批 %d 条发完，休息 %.1f 分钟（避免连续动作）" % (LIMITS["batch_size"], rest / 60))
                time.sleep(rest)
            else:
                delay = lognormal_delay()
                log("      .. 间隔 %.1fs" % delay)
                time.sleep(delay)

    try:
        worker.close()
    except Exception:
        pass
    try:
        cdp.close_tab(wid)
    except Exception:
        pass
    return summary
