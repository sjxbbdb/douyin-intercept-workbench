"""Validated browser actions backed by :mod:`send_gate`.

This module never treats a DOM change as delivery.  A click without a
platform response is recorded as ``unknown`` and blocks a later retry.
"""
import json
import re
import time
from urllib.parse import urlsplit

import click_guard
import douyin
import douyin_selectors as S
import live
from send_gate import GateError, SendGate


AUTHOR_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
MAX_TEXT = 2000


def _bad_result(send_id, status, reason, evidence=None):
    result = {"status": status, "reason": str(reason)[:300], "sendId": str(send_id)}
    if evidence is not None:
        result["evidence"] = evidence
    return result


def _gate_result(gate, reservation, send_id):
    row = reservation.get("row")
    if reservation.get("kind") == "existing" and row:
        return gate.result(row)
    evidence = None
    if row and row.get("send_id") != send_id:
        evidence = {"priorSendId": row.get("send_id")}
    return _bad_result(send_id, "blocked", reservation.get("reason", "send_blocked"), evidence)


def _internal_failure(gate, send_id, started, exc, stage):
    """内部异常也必须有【稳定枚举】的原因，异常类型放进 evidence 供排查。

    原来这里直接把 type(exc).__name__ 当 reason，于是宿主的失败归因表里
    会冒出任意 Python 类名（KeyError / TypeError / ...）。后果有两层：
      1) reason 不再是可枚举的契约，宿主无法据此决定重试还是放弃；
      2) 排查方向被带偏 —— 真机取证时看到 "KeyError" 只会以为是平台或契约问题，
         而它其实指向代码里一个未守卫的下标。
    未开始点击时按 failed（什么都没发出去），已点击则按 unknown（红线 3：
    未知结果不得自动重试）。真实异常类型与信息留在 evidence 里，不丢证据。
    """
    row = gate.finish(send_id, "unknown" if started else "failed", "internal_error",
                      {"stage": stage, "exception": type(exc).__name__,
                       "exceptionMessage": str(exc)[:200]})
    return gate.result(row)


def _clean_draft(value):
    """输入框里的零宽字符不算草稿。

    🔴 真机（2026-09-20）：抖音的富文本编辑器初始内容就是一个 ZWSP（​），
    直接拿它跟话术比较会得到 composer_has_different_draft —— 那是假草稿，不是真草稿。
    """
    text = str(value or "")
    for junk in ("\u200b", "\u200c", "\u200d", "\ufeff"):
        text = text.replace(junk, "")
    return text.strip()


_SEARCH_BOX_JS = (
    "(function(want){"
    "var ns=document.querySelectorAll('input,textarea');"
    "for(var i=0;i<ns.length;i++){var e=ns[i];var v=String(e.value||'');"
    "var ph=String(e.getAttribute('placeholder')||e.getAttribute('data-placeholder')||'');"
    "var cls=String(e.className||'');"
    "if(v&&v.indexOf(want)>=0&&/搜索|search/i.test(ph+' '+cls))return true;}"
    "return false;})"
)


def _text_in_search_box(tab, text):
    """输入后检查文字是不是落进了搜索框。

    🔴 真机教训（2026-09-20）：页面上同时存在搜索框时，坐标一旦点偏就会把话术打进搜索框。
    此时【绝不能按回车】（那会触发一次搜索），必须以 failed/typed_into_search_box 收手。
    """
    want = str(text or "").strip()
    if not want:
        return False
    try:
        return bool(tab.eval_json("(%s)(%s)" % (_SEARCH_BOX_JS, json.dumps(want))))
    except Exception:
        return False


def _await_login(tab, seconds=20.0):
    """等登录态就绪再判定。

    🔴 真机教训（2026-09-20，私信链路实测两次失败）：主页是 SPA，账号元素
    （data-e2e=user-info）是异步挂载的，导航后立刻查 login_state 会得到 unknown，
    于是"明明登录着"却把私信拦在 login_state_unknown。8 秒不够——真机私信页
    冷启动加载常常 10-18 秒。

    三重判定，仍然只依赖页面可见 DOM：
      · login_state()            —— www.douyin.com 的账号元素；
      · live_room_signed_in()    —— live.douyin.com 的页首头像 + 公屏输入框；
      · force_page_active()      —— 页面被别的窗口遮挡时会判 hidden，账号元素不挂载、
                                    点击也不送达渲染进程（工作日志第 7 条），所以等待期间
                                    周期性地把页面拉回 active。
    required 立即返回，交给上层风控处置；超时仍是 unknown，绝不假设已登录。
    """
    deadline = time.time() + float(seconds)
    attempts = 0
    while True:
        if attempts % 6 == 0:
            try:
                douyin.force_page_active(tab)
            except Exception:
                pass
        attempts += 1
        try:
            state = douyin.login_state(tab)
        except Exception:
            state = "unknown"
        if state == "required":
            return state
        if state == "unknown":
            try:
                if douyin.live_room_signed_in(tab):
                    return "verified"
            except Exception:
                pass
        if state != "unknown" or time.time() >= deadline:
            return state
        time.sleep(0.5)


def _validate_private(target, text):
    if not isinstance(target, dict):
        raise ValueError("target must be an object")
    author_id = str(target.get("authorId") or "")
    if not AUTHOR_ID_RE.fullmatch(author_id):
        raise ValueError("target.authorId is invalid")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError("text must be 1-%d characters" % MAX_TEXT)
    return author_id, text


def _wait_ready(tab, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if tab.evaluate("document.readyState") == "complete":
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def _exact_profile_url(url, author_id):
    """Require the visible tab to be exactly the requested profile path."""
    try:
        parsed = urlsplit(str(url or ""))
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.hostname != "www.douyin.com":
        return False
    return parsed.path.rstrip("/") == "/user/" + author_id


def _resolved_room_url(raw):
    """把页面地址规范化成严格校验能接受的 URL。

    🔴 真机教训（2026-09-20，第二次踩同一个根因）：抖音直播广场点进来的房间地址是
    https://live.douyin.com/?anchor_id=...&live_web_rid=<房间号> —— 路径为空，
    直接交给 safe_url 会抛 URLPolicyError（path is required）。
    整条发送就停在"校验当前页面"这一步，对外只留下一个 reason=URLPolicyError，
    看起来像"发送失败"，其实是地址形态没归一。
    live 房间一律重建为 https://live.douyin.com/<房间号>。
    """
    from url_policy import safe_url
    try:
        return safe_url(raw, "resolved room url", keep_query=True)
    except Exception:
        room_id = live.room_id_from_url(raw)
        if room_id:
            return "https://live.douyin.com/%s" % room_id
        raise


def _canonical_room(url):
    """Return a query-free canonical Douyin room tuple for exact binding.

    🔴 真机教训（2026-09-20）：抖音直播广场点进来的房间地址是
    https://live.douyin.com/?anchor_id=...&live_web_rid=<房间号> ，路径为空。
    只比对路径会把「同一个房间」判成不同房间，或把空路径当成合法房间。
    所以 live 房间一律按【房间号】归一（live.room_id_from_url），拿不到房间号就判不合法。
    """
    try:
        parsed = urlsplit(str(url or ""))
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in ("www.douyin.com", "live.douyin.com"):
        return None
    if parsed.hostname == "live.douyin.com":
        room_id = live.room_id_from_url(url)
        return (parsed.hostname, "/" + room_id) if room_id else None
    path = parsed.path.rstrip("/") or "/"
    return parsed.hostname, path


def _response_status(record):
    parsed = record.get("parsed") or {}
    if not isinstance(parsed, dict):
        return None
    data = parsed.get("data") if isinstance(parsed.get("data"), dict) else parsed
    return data.get("status_code", parsed.get("status_code"))


def _visibility_gate(tab, gate, send_id):
    """页面可见性守卫。返回 None 表示可继续；否则返回已落账的结果。

    🔴 口径（平台侧要求 2026-09-26）：
      · visibilityState == "unknown" 【不等于 hidden】—— 判定不了就交给人工，
        不得当成"需要置前"，更不得自动重试发送（重试会造成重复触达）；
      · 只有明确 hidden 才尝试恢复可见性；恢复失败同样交给人工。
    """
    state = douyin.visibility_state(tab)
    if state == "unknown":
        row = gate.finish(send_id, "blocked", "page_visibility_unknown",
                          {"skipped": True, "manualAction": True})
        return gate.result(row)
    if state != "visible":
        douyin.ensure_visible(tab)
        if douyin.visibility_state(tab) != "visible":
            row = gate.finish(send_id, "blocked", "browser_not_visible",
                              {"skipped": True, "manualAction": True})
            return gate.result(row)
    return None


def send_private(tab, gate, send_id, target, text):
    """Send one private message after a durable preflight reservation."""
    try:
        author_id, text = _validate_private(target, text)
    except ValueError as exc:
        return _bad_result(send_id, "failed", str(exc))

    try:
        reservation = gate.reserve(send_id, author_id, text, kind="private")
    except GateError as exc:
        return _bad_result(send_id, "failed", exc.message)
    if reservation.get("kind") != "reserved":
        return _gate_result(gate, reservation, send_id)

    started = False
    try:
        tab.call("Page.navigate", {"url": douyin.profile_url(author_id)}, timeout=25)
        if not _wait_ready(tab):
            row = gate.finish(send_id, "failed", "page_not_ready")
            return gate.result(row)
        current = tab.evaluate("location.href") or ""
        if not _exact_profile_url(current, author_id):
            row = gate.finish(send_id, "failed", "target_profile_mismatch")
            return gate.result(row)
        if douyin.profile_error_page(tab):
            # 身份不可见时的占位 id（真机实测 111111）会打开错误页；错误页上没有账号元素，
            # 旧代码会把它误报成 login_state_unknown。主页不存在 = 这个目标不可触达 ->
            # 跳过并换下一个（同样不消费任何发送动作）。
            row = gate.finish(send_id, "blocked", "profile_not_found",
                              {"skipped": True, "blockedBy": "profile_missing"})
            return gate.result(row)
        # 🔴 真机教训（工作日志第 7 条）：页面 visibilityState=hidden 时点击不送达渲染进程，
        #    表现就是"私信按钮点上去、面板死活不开"（人工点却正常）。先拉活页面。
        # 🔴 unknown 不等于 hidden：交给人工，不自动重试（平台侧要求 2026-09-26）。
        gated = _visibility_gate(tab, gate, send_id)
        if gated is not None:
            return gated
        if douyin.check_captcha(tab):
            row = gate.finish(send_id, "blocked", "captcha_requires_manual_action")
            return gate.result(row)
        login = _await_login(tab)
        if login != "verified":
            row = gate.finish(send_id, "failed", "login_required" if login == "required" else "login_state_unknown")
            return gate.result(row)

        entry = douyin.dm_entry(tab)
        if entry.get("blocked"):
            # 平台明确表示"这个人不能私信"（未互关 / 私密账号 / 已关闭私信）。
            # 这是【跳过】而不是失败：我们一条消息都没发，失败状态会误导成通道故障。
            row = gate.finish(send_id, "blocked", "dm_not_available",
                              {"skipped": True, "platform": entry.get("reason"),
                               "blockedBy": "platform_dm_restriction"})
            return gate.result(row)
        if not entry.get("found"):
            row = gate.finish(send_id, "blocked", "dm_entry_not_found",
                              {"skipped": True, "blockedBy": "no_dm_entry"})
            return gate.result(row)
        author_name = str(target.get("authorName") or "").strip()
        context = douyin.recipient_context(tab, author_id, author_name)
        if not context.get("verified"):
            row = gate.finish(send_id, "failed", "target_context_not_confirmed")
            return gate.result(row)
        # 🔴 真机教训（2026-09-20）：主页从直播间跳过来时头部还在渲染，按旧坐标点一次
        #    「私信」经常点空（面板根本没打开）。所以这里改成【重新取入口 -> 点 -> 校验面板】
        #    的循环，最多 3 轮；每一轮都用当下最新的按钮坐标，避免用过期坐标点击。
        composer = {"found": False}
        context_mode = "recipient_scoped"
        for attempt in range(3):
            entry = douyin.dm_entry(tab)
            if entry.get("blocked"):
                row = gate.finish(send_id, "blocked", "target_dm_not_available")
                return gate.result(row)
            if not entry.get("found"):
                break
            tab.click_at(entry["x"], entry["y"])
            # 面板是异步挂载的：同时等「收件人作用域内的输入框」和「会话头部标题」，
            # 两者都指向同一个收件人才算打开成功。
            for _ in range(10):
                time.sleep(0.5)
                composer = douyin.dm_composer_for_recipient(tab, author_id, author_name)
                if composer.get("found"):
                    break
                panel = douyin.dm_panel_state(tab, author_name)
                if panel.get("found") and panel.get("headerMatch"):
                    context_mode = "live_panel_header"
                    composer = {"found": True, "x": panel["x"], "y": panel["y"],
                                "text": panel.get("text") or "",
                                "containerKey": panel.get("panelKey") or "messageEditor"}
                    break
            if composer.get("found"):
                break
        if not composer.get("found"):
            # 🔴 真机回退（2026-09-20，真实主页实测）：真机私信面板里【没有】data-recipient-id /
            #    data-user-id，也没有指向 /user/<sec_uid> 的链接（实测 count=0），所以上面那套
            #    严格校验在真机上永远匹配不到，私信会一直停在 composer_not_found。
            #    真机可用的收件人信号是【会话头部标题 = 对方昵称】（脱敏昵称按可见前缀比较）。
            panel = douyin.dm_panel_state(tab, author_name)
            if not (panel.get("found") and panel.get("headerMatch")):
                # 🔴 真机与用户反馈（2026-09-21）：有的目标私信入口点得动、面板却始终不开
                #    （对方未互关 / 私密账号 / 关闭了陌生人私信）。这时我们一条消息都没发，
                #    应当【跳过并换下一个目标】，而不是把它记成"发送失败"。
                #    注意：这里只影响"能否触达"的判定，不影响任何发送门槛。
                row = gate.finish(send_id, "blocked", "dm_panel_unavailable",
                                  {"skipped": True, "blockedBy": "panel_not_opened",
                                   "entryClicks": 3})
                return gate.result(row)
            context_mode = "live_panel_header"
            composer = {"found": True, "x": panel["x"], "y": panel["y"],
                        "text": panel.get("text") or "",
                        "containerKey": panel.get("panelKey") or "messageEditor"}
        existing_text = _clean_draft(composer.get("text"))
        if existing_text and existing_text != _clean_draft(text):
            row = gate.finish(send_id, "failed", "composer_has_different_draft")
            return gate.result(row)
        tab.click_at(composer["x"], composer["y"])
        tab.type_text(text)
        time.sleep(0.3)
        if context_mode == "live_panel_header":
            after = douyin.dm_panel_state(tab, author_name)
            after_ok = bool(after.get("found") and after.get("headerMatch"))
            after_text = after.get("text") or ""
        else:
            after = douyin.dm_composer_for_recipient(tab, author_id, author_name)
            after_ok = bool(after.get("found"))
            after_text = after.get("text") or ""
        if not after_ok or _clean_draft(after_text) != _clean_draft(text):
            row = gate.finish(send_id, "failed", "text_verification_failed")
            return gate.result(row)

        button = douyin.dm_send_button_for_recipient(tab, author_id, author_name)
        mechanism = "button"
        if not button.get("found") or button.get("disabled"):
            # 🔴 真机回退：私信编辑器与直播间公屏是同一套富文本编辑器（zone-container /
            #    editor-kit），公屏经真机确认是【回车发送】；私信这里同样用回车，
            #    并在证据里记录机制、输入框是否清空、会话里是否出现这条。
            mechanism = "enter"
            button = {"found": False}

        if mechanism == "button":
            final_composer = douyin.dm_composer_for_recipient(tab, author_id, author_name)
            if (not final_composer.get("found") or
                    final_composer.get("containerKey") != composer.get("containerKey")):
                row = gate.finish(send_id, "failed", "target_session_changed")
                return gate.result(row)
            button = douyin.dm_send_button_for_recipient(tab, author_id, author_name)
            if not button.get("found") or button.get("disabled"):
                row = gate.finish(send_id, "failed", "send_button_context_changed")
                return gate.result(row)
        else:
            # 回车发送前再确认一次收件人没变（头部标题仍匹配）
            confirm = douyin.dm_panel_state(tab, author_name)
            if not (confirm.get("found") and confirm.get("headerMatch")):
                row = gate.finish(send_id, "failed", "target_session_changed")
                return gate.result(row)

        # The durable started marker is the last operation before the send.
        gate.mark_started(send_id)
        started = True
        recorder = douyin.make_network_recorder(tab, getattr(S, "DM_SEND_URL_MARK", ""))
        try:
            tab.call("Network.enable", {}, timeout=10)
        except Exception:
            pass
        if mechanism == "button":
            tab.click_at(button["x"], button["y"])
        else:
            tab.press_key("Enter", code="Enter", key_code=13)
        records = recorder.collect(wait_seconds=8.0)
        mark = getattr(S, "DM_SEND_URL_MARK", "")
        matched = [r for r in records if mark and mark in (r.get("url") or "")]
        statuses = [_response_status(r) for r in matched]
        echo = douyin.dm_conversation_echo(tab, text)
        cleared = None
        try:
            state = douyin.dm_panel_state(tab, author_name)
            if state.get("found"):
                cleared = not str(state.get("text") or "").strip()
        except Exception:
            cleared = None
        row = gate.finish(send_id, "unknown", "platform_response_unavailable",
                          {"httpResponses": len(records), "matchedResponses": len(matched),
                           "platformStatusCodes": statuses[:5], "mechanism": mechanism,
                           "recipientVerification": context_mode,
                           "composerCleared": cleared, "conversationEcho": bool(echo)})
        return gate.result(row)
    except Exception as exc:
        return _internal_failure(gate, send_id, started, exc, "send_private")


def _validate_comment(target, text, source):
    if source not in ("video", "live"):
        raise ValueError("source must be video or live")
    if not isinstance(target, dict):
        raise ValueError("target must be an object")
    target_id = str(target.get("id") or "")
    room_id = str(target.get("roomId") or "")
    author_id = str(target.get("authorId") or "")
    if not target_id or len(target_id) > 300:
        raise ValueError("target.id is required")
    if not room_id or len(room_id) > 2048:
        raise ValueError("target.roomId is required")
    if source == "video" and not AUTHOR_ID_RE.fullmatch(author_id):
        raise ValueError("target.authorId is invalid")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError("text must be 1-%d characters" % MAX_TEXT)
    return target_id, room_id, author_id, text


COMMENT_TARGET_JS = """(function(target){
  function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
  var rows=Array.from(document.querySelectorAll(ITEM_SELECTOR)).filter(vis);
  function exactText(e){var ns=e.querySelectorAll(CONTENT_SELECTOR),text=(target.text||'').trim();
    if(!text)return false; for(var i=0;i<ns.length;i++)if((ns[i].innerText||ns[i].textContent||'').trim()===text)return true;
    return false;}
  function authorOk(e){if(!target.authorId)return true;var as=e.querySelectorAll('a[href]');
    for(var i=0;i<as.length;i++){var href=as[i].getAttribute('href')||'',name=(as[i].innerText||as[i].textContent||'').trim(),path='';
      try{path=new URL(href,location.href).pathname.replace(/\\/$/,'');}catch(err){continue;}
      if(path==='/user/'+target.authorId&&(!target.authorName||name===target.authorName))return true;}
    return false;}
  var byId=rows.filter(function(e){return e.id===target.id||e.getAttribute('data-comment-id')===target.id;});
  var hit=(byId.length?byId:rows).filter(function(e){return exactText(e)&&authorOk(e);});
  if(hit.length!==1)return {ok:false,count:hit.length,reason:hit.length?'ambiguous_comment':'comment_not_found'};
  var e=hit[0], b=Array.from(e.querySelectorAll(REPLY_SELECTORS.join(','))).find(function(x){return vis(x)&&((x.innerText||x.textContent||'').replace(/\\s/g,'')==='回复');});
  if(!b)b=Array.from(e.querySelectorAll('button,[role=button]')).find(function(x){return vis(x)&&((x.innerText||x.textContent||'').replace(/\\s/g,'')==='回复');});
  if(!b)return {ok:false,count:1,reason:'reply_button_not_found'};
  var r=b.getBoundingClientRect(); return {ok:true,count:1,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
})(TARGET)"""


def build_comment_target_expression(target):
    """⚠️ 已废弃（2026-09-20）：真机上不再可用。

    它依赖 [data-e2e="comment-content"] 与 [data-e2e="comment-reply"]，
    这两个名字在真实抖音页面上【都不存在】（真机可见评论容器里只有
    comment-item / video-comment-more / live-avatar 三个 data-e2e）。
    send_comment 已改用 douyin.comment_reply_button。

    保留仅为兼容历史调用；新代码不要使用。
    """
    import json
    return COMMENT_TARGET_JS.replace("ITEM_SELECTOR", json.dumps(S.COMMENT_ITEM)) \
        .replace("CONTENT_SELECTOR", json.dumps(S.COMMENT_CONTENT)) \
        .replace("REPLY_SELECTORS", json.dumps(S.COMMENT_REPLY_BUTTONS)) \
        .replace("TARGET", json.dumps({
            "id": str(target.get("id") or ""),
            "authorName": target.get("authorName") or "",
            "authorId": target.get("authorId") or "",
            "text": target.get("text") or "",
        }))


def _validate_danmaku_reply(target, text):
    """回复弹幕的输入校验：没有昵称、没有原文、话术没带 @昵称 —— 一律拒绝。

    为什么这三条是硬要求：
      · 真机确认网页端没有「点弹幕回复」的原生入口，"回复"的落地形式就是公屏里的 @昵称；
      · 昵称只能来自平台（target.authorName），不允许用 ID 或调用方拼出来的名字代替；
      · 话术由平台侧下发（红线：本模块不写、不改话术），所以 @昵称 前缀必须已经写在话术里。
    """
    if not isinstance(target, dict):
        raise ValueError("target must be an object")
    target_id = str(target.get("id") or "")
    room_id = str(target.get("roomId") or "")
    author_name = str(target.get("authorName") or "").strip()
    danmaku_text = str(target.get("text") or "").strip()
    if not target_id or len(target_id) > 300:
        raise ValueError("target.id is required")
    if not room_id or len(room_id) > 2048:
        raise ValueError("target.roomId is required")
    if not author_name:
        raise ValueError("target.authorName is required to mention the author")
    if "*" in author_name:
        # 脱敏昵称（真机实测："小***"）不能用来 @：那是一个指不到人的假名字。
        raise ValueError("target.authorName is masked and cannot be mentioned")
    if not danmaku_text:
        raise ValueError("target.text is required to locate the danmaku")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError("text must be 1-%d characters" % MAX_TEXT)
    if not text.lstrip().startswith("@" + author_name):
        raise ValueError("text must start with @authorName")
    return target_id, room_id, author_name, danmaku_text, text


def _validate_native_reply(target, text):
    """原生「回复 TA」的输入校验。

    与 @纯文本路径最大的不同：**昵称不需要我们能读全**（提及由平台插入），
    所以脱敏昵称（小***）在这里是允许的 —— 这正是原生路径的实际优势。
    """
    if not isinstance(target, dict):
        raise ValueError("target must be an object")
    target_id = str(target.get("id") or "")
    room_id = str(target.get("roomId") or "")
    author_name = str(target.get("authorName") or "").strip()
    danmaku_text = str(target.get("text") or "").strip()
    if not target_id or len(target_id) > 300:
        raise ValueError("target.id is required")
    if not room_id or len(room_id) > 2048:
        raise ValueError("target.roomId is required")
    if not author_name:
        raise ValueError("target.authorName is required to confirm the mention")
    if not danmaku_text:
        raise ValueError("target.text is required to locate the danmaku")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError("text must be 1-%d characters" % MAX_TEXT)
    if text.lstrip().startswith("@"):
        # 提及由平台插入；话术里再带 @ 会变成"@某人 @某人 内容"这种双提及。
        raise ValueError("text must be the reply body without the @ prefix")
    return target_id, room_id, author_name, danmaku_text, text


def _mention_matches(composer_text, author_name):
    """输入框里的提及是不是这个人：去掉 @ 与空白后按可见名包含匹配（脱敏名也适用）。"""
    def norm(value):
        text = str(value or "")
        for junk in ("*", "＊"):
            text = text.replace(junk, "")
        return re.sub(r"\s+", "", text.replace("@", ""))
    want = norm(author_name)
    return bool(want) and want in norm(composer_text)


def send_danmaku_reply_native(tab, gate, send_id, target, text, placed=None):
    """原生「回复 TA」：点弹幕 → 菜单 →「回复 TA」→ 平台插入 @昵称 → 打字 → 回车。

    学自用户 2026-09-20 的真机操作（交互序列取证），与 send_danmaku_reply 的区别：
      · text 是【回复正文】，不含 @ 前缀（提及由平台插入，是真实 mention 实体）；
      · 因此发出前必须确认输入框进入了提及状态，且提及对象就是那条弹幕的作者。
    平台没有响应证据时结果仍是 unknown，并记录房间回声作为证据。
    """
    try:
        target_id, room_id, author_name, danmaku_text, text = _validate_native_reply(target, text)
    except ValueError as exc:
        return _bad_result(send_id, "failed", str(exc))
    try:
        from url_policy import safe_url
        room_url = safe_url(room_id, "target.roomId", keep_query=True)
    except Exception as exc:
        return _bad_result(send_id, "failed", str(exc))
    gate_key = "live-danmaku-native:%s:%s" % (target_id, author_name)
    try:
        reservation = gate.reserve(send_id, gate_key, text, kind="danmaku_reply")
    except GateError as exc:
        return _bad_result(send_id, "failed", exc.message)
    if reservation.get("kind") != "reserved":
        return _gate_result(gate, reservation, send_id)

    started = False
    try:
        requested_room = _canonical_room(room_url)
        current_raw = tab.evaluate("location.href") or ""
        if not current_raw or _canonical_room(current_raw) != requested_room:
            tab.call("Page.navigate", {"url": room_url}, timeout=25)
            if not _wait_ready(tab):
                return gate.result(gate.finish(send_id, "failed", "page_not_ready"))
            current_raw = tab.evaluate("location.href") or room_url
        current_url = _resolved_room_url(current_raw)
        resolved_room = _canonical_room(current_url)
        if (not resolved_room or resolved_room[0] != "live.douyin.com" or
                (requested_room and requested_room[0] == "live.douyin.com" and
                 resolved_room != requested_room)):
            return gate.result(gate.finish(send_id, "failed", "target_live_room_mismatch"))
        # 页面被遮挡时点击不送达渲染进程（真机踩过），先拉活
        if douyin.visibility_state(tab) != "visible":
            douyin.ensure_visible(tab)
        if douyin.check_captcha(tab):
            return gate.result(gate.finish(send_id, "blocked", "captcha_requires_manual_action"))
        login = _await_login(tab)
        if login != "verified":
            return gate.result(gate.finish(
                send_id, "failed", "login_required" if login == "required" else "login_state_unknown"))

        # 🔴 真机教训（2026-09-20，房间 689015985670）：上一次回复失败会在输入框里留下
        #    没被清掉的 @提及；下一次点「回复 TA」时平台会弹确认框
        #    （"单次只支持艾特一个人，艾特其他人会清空内容，是否继续？"），
        #    这个框是全屏遮罩 —— 出现之后本房间后续所有点击都会被挡住。
        #    所以每轮回复前先确认输入框是干净的；有残留就清掉（只操作输入框，不发送）。
        leftover = live.clear_composer(tab)
        if not leftover.get("ok"):
            return gate.result(gate.finish(send_id, "failed",
                                           leftover.get("reason") or "composer_not_cleared",
                                           {"cleared": False}))
        # 平台自己弹的确认框（如果有）：按提示点"确定"继续，而不是干等
        modal = live.dismiss_confirm_modal(tab)
        if modal.get("handled") and not modal.get("dismissed"):
            return gate.result(gate.finish(send_id, "blocked", "platform_confirm_modal_stuck",
                                           {"modalText": modal.get("text")}))

        # 弹幕是"此刻屏上"的东西：chat 列表一直在滚动，所以整段做成重试。
        # 聊天列表滚动会让"点到的行"与"定位到的行"不是同一条 —— 真机上用户也是连点几次。
        # 所以整段（定位->点正文->菜单->回复 TA->校验提及对象）做成重试，
        # 只有每一轮都失败才收手；任何一轮提及对不上都立刻重新来过（fail-closed）。
        state = None
        refusal = None
        last_mismatch = None
        for attempt in range(3):
            # placed：调用方刚读到的"此刻可见坐标"。第一次点击直接用它 ——
            # 重新定位要多花几百毫秒，高流量房间里那条弹幕已经被顶走了（真机实测）。
            menu = live.open_reply_menu(tab, {"authorName": author_name, "text": danmaku_text},
                                        placed=placed if attempt == 0 else None)
            if not menu.get("ok"):
                refusal = menu.get("reason") or "reply_menu_not_opened"
                continue
            chosen = live.choose_reply_menu_item(tab, menu)
            if not chosen.get("ok"):
                refusal = chosen.get("reason") or "reply_menu_item_not_found"
                continue
            # 插入提及之后必须【边等边看】：平台可能立刻弹
            # "单次只支持艾特一个人，艾特其他人会清空内容，是否继续？"
            # （真机实测，点击审计里能一步步看到）。这个确认框是全屏遮罩：
            # 顺序搞反了会把"弹窗挡着输入框"读成"提及没插进来"，
            # 于是再插一次 -> 又弹一次 -> 越弹越多，最后什么也点不动。
            # 正确做法：先关掉它（点平台给的"确定"），再读输入框；读到提及为止。
            state = {"found": False}
            for _ in range(6):
                modal = live.dismiss_confirm_modal(tab)
                if modal.get("handled"):
                    time.sleep(0.5)
                    continue
                state = live.composer_mention(tab)
                if state.get("found") and state.get("startsAt"):
                    break
                time.sleep(0.4)
            if not state.get("found"):
                refusal = "composer_not_found"
                continue
            if not state.get("startsAt"):
                # 平台没把提及插进来 —— 这条就不是"回复某人"，直接收手
                refusal = "reply_mention_not_inserted"
                continue
            if not _mention_matches(state.get("text") or "", author_name):
                refusal = "reply_mention_target_mismatch"
                # 诊断用：只记长度与首字符类别，不落昵称原文
                last_mismatch = {
                    "mentionLen": len(str(state.get("text") or "").strip()),
                    "mentionHead": str(state.get("text") or "").strip()[:1],
                    "mentionCount": state.get("mentionCount"),
                    "expectedLen": len(author_name),
                    "expectedHead": author_name[:1],
                }
                state = None
                continue
            # 提及已经对上了，接着输入正文。输入同样放在重试循环里：
            # 输入万一没落进输入框，就清掉残留整段重来 —— 带提及的残留留在框里，
            # 下一次「回复 TA」会触发平台的"单次只支持艾特一个人"确认框（全屏遮罩）。
            composer = live.find_composer(tab)
            if not composer.get("found"):
                refusal = "composer_not_found_after_menu"
                state = None
                continue
            focus = click_guard.click_checked(
                tab, composer["x"], composer["y"],
                expect_selectors=[S.LIVE_CHAT_EDITOR_BOX, "[contenteditable=true]"],
                label="composer_focus", page_hint="live_room")
            if not focus.get("ok"):
                refusal = focus.get("reason") or "click_refused"
                state = None
                continue
            # 真实按键输入：逐字派发 char 事件，每字 0.1-0.9 秒随机停顿（真人节奏）。
            # 绝不用 Input.insertText —— 那只会改 DOM，React 受控编辑器可能收不到，
            # 表面上"填好了"，回车却发不出去（工作日志第 7 条）。
            tab.type_text(text)
            if _text_in_search_box(tab, text):
                return gate.result(gate.finish(send_id, "failed", "typed_into_search_box"))
            after = live.find_composer(tab)
            if text.strip() not in (after.get("text") or ""):
                live.clear_composer(tab)
                refusal = "text_verification_failed"
                state = None
                continue
            refusal = None
            break
        if state is None:
            return gate.result(gate.finish(send_id, "failed", refusal or "reply_menu_not_opened",
                                           {"mismatch": last_mismatch} if last_mismatch else None))
        control = live.find_send_control(tab)
        mechanism = str(control.get("mechanism") or "enter")
        gate.mark_started(send_id)
        started = True
        if control.get("found") and not control.get("disabled"):
            tab.click_at(control["x"], control["y"])
        else:
            tab.press_key("Enter", code="Enter", key_code=13)
        echo = live.wait_room_echo(tab, text)
        row = gate.finish(send_id, "unknown", "platform_response_unavailable",
                          {"mechanism": mechanism, "via": "native_reply_ta",
                           "mentionInserted": True, "danmakuLocated": True,
                           "composerCleared": echo.get("composerCleared"),
                           "roomEcho": bool(echo.get("row")),
                           "roomEchoSource": "page_memory" if echo.get("row") else None})
        return gate.result(row)
    except Exception as exc:
        return _internal_failure(gate, send_id, started, exc, "danmaku_reply")


def send_danmaku_reply(tab, gate, send_id, target, text):
    """回复弹幕：在公屏发一条以 @昵称 开头的消息，且必须先定位到那条弹幕。

    真机事实（2026-09-20，见 live.py 顶部结论）：网页端对普通观众没有
    「点某条弹幕 -> 回复」的原生入口（全页 hover 扫描恒为 0；点击弹幕不进入回复态；
    输入框 @ 也没有提及联想）。所以本函数把"回复弹幕"落地为：公屏消息里 @该观众。

    为了确保"确实是在回这一条"，发出前逐项校验，任何一项不过就拒绝发送：
      1. 目标弹幕此刻仍在屏上、唯一命中、未被面板遮挡（live.find_danmaku）；
      2. 话术必须以 @该弹幕的昵称 开头（话术由平台侧下发，本模块不自己拼）；
      3. 输入框内容与期望文本完全一致后才按发送。
    平台响应不可得 -> 结果保留 unknown（红线 2/3），绝不自动重试。
    """
    try:
        target_id, room_id, author_name, danmaku_text, text = _validate_danmaku_reply(target, text)
    except ValueError as exc:
        return _bad_result(send_id, "failed", str(exc))
    try:
        from url_policy import safe_url
        room_url = safe_url(room_id, "target.roomId", keep_query=True)
    except Exception as exc:
        return _bad_result(send_id, "failed", str(exc))
    gate_key = "live-danmaku:%s:%s" % (target_id, author_name)
    try:
        reservation = gate.reserve(send_id, gate_key, text, kind="danmaku_reply")
    except GateError as exc:
        return _bad_result(send_id, "failed", exc.message)
    if reservation.get("kind") != "reserved":
        return _gate_result(gate, reservation, send_id)

    started = False
    try:
        # 🔴 真机教训（2026-09-20）：这里原来【无条件】重新导航到直播间，结果刚在屏上
        #    确认过的那条弹幕被页面刷新冲掉，发送永远停在 danmaku_not_found。
        #    弹幕是"此刻屏上"的东西，所以已经在目标房间时绝不刷新。
        requested_room = _canonical_room(room_url)
        current_raw = tab.evaluate("location.href") or ""
        if not current_raw or _canonical_room(current_raw) != requested_room:
            tab.call("Page.navigate", {"url": room_url}, timeout=25)
            if not _wait_ready(tab):
                return gate.result(gate.finish(send_id, "failed", "page_not_ready"))
            current_raw = tab.evaluate("location.href") or room_url
        current_url = _resolved_room_url(current_raw)
        resolved_room = _canonical_room(current_url)
        if (not resolved_room or resolved_room[0] != "live.douyin.com" or
                (requested_room and requested_room[0] == "live.douyin.com" and
                 resolved_room != requested_room)):
            return gate.result(gate.finish(send_id, "failed", "target_live_room_mismatch"))
        # 🔴 真机教训（工作日志第 7 条）：页面被遮挡时 visibilityState=hidden，点击【不送达渲染进程】。
        #    私信面板"成片打不开"、弹幕定位后点不动，根因都是这个；先把页面拉活再继续。
        # 🔴 unknown 不等于 hidden：交给人工，不自动重试（平台侧要求 2026-09-26）。
        gated = _visibility_gate(tab, gate, send_id)
        if gated is not None:
            return gated
        if douyin.check_captcha(tab):
            return gate.result(gate.finish(send_id, "blocked", "captcha_requires_manual_action"))
        login = _await_login(tab)
        if login != "verified":
            return gate.result(gate.finish(
                send_id, "failed", "login_required" if login == "required" else "login_state_unknown"))

        placed = live.find_danmaku(tab, {"authorName": author_name, "text": danmaku_text})
        if not placed.get("ok"):
            return gate.result(gate.finish(send_id, "failed",
                                           placed.get("reason") or "danmaku_not_found"))
        composer = live.find_composer(tab)
        if not composer.get("found"):
            return gate.result(gate.finish(send_id, "failed",
                                           composer.get("reason") or "comment_composer_not_found"))
        if composer.get("onTop") is False:
            # 命中测试不过：输入框被别的东西盖住（真机上常见的是搜索框/面板），点了会打偏。
            return gate.result(gate.finish(send_id, "failed", "composer_covered"))
        tab.click_at(composer["x"], composer["y"])
        tab.type_text(text)                      # 真人节奏：每字 0.1-0.9 秒
        if _text_in_search_box(tab, text):
            # 文字落进搜索框：立刻收手，绝不按回车（否则会触发一次搜索）。
            return gate.result(gate.finish(send_id, "failed", "typed_into_search_box"))
        after = live.find_composer(tab)
        if (after.get("text") or "").strip() != text.strip():
            return gate.result(gate.finish(send_id, "failed", "text_verification_failed"))
        control = live.find_send_control(tab)
        mechanism = str(control.get("mechanism") or "enter")
        gate.mark_started(send_id)
        started = True
        if control.get("found") and not control.get("disabled"):
            tab.click_at(control["x"], control["y"])
        else:
            # 🔴 真机确认（2026-09-20）：本通道的发送键是【回车】。输入框右侧的图标不是发送键
            #    （点它之后内容原样留在框里），所以这里只走回车。
            tab.press_key("Enter", code="Enter", key_code=13)
        # 发送后的观测：输入框是否清空 + 房间消息流里有没有出现这条。
        # 这是证据，不是"送达"判据 —— 状态仍是 unknown（红线 2 只认平台响应）；
        # sidecar 会据 roomEcho 把事件记为 sent_echoed，由策略决定要不要进入下一阶段。
        echo = live.wait_room_echo(tab, text)
        row = gate.finish(send_id, "unknown", "platform_response_unavailable",
                          {"mechanism": mechanism, "danmakuLocated": True, "mentioned": True,
                           "composerCleared": echo.get("composerCleared"),
                           "roomEcho": bool(echo.get("row")),
                           "roomEchoSource": "page_memory" if echo.get("row") else None})
        return gate.result(row)
    except Exception as exc:
        return _internal_failure(gate, send_id, started, exc, "danmaku_reply")


def send_comment(tab, gate, send_id, target, text, source):
    """Safely locate one visible comment before a single click.

    The current private response contract is also used here: absent a
    confirmed platform response, the durable result is ``unknown``.
    """
    try:
        target_id, room_id, author_id, text = _validate_comment(target, text, source)
    except ValueError as exc:
        return _bad_result(send_id, "failed", str(exc))
    try:
        from url_policy import safe_url
        room_url = safe_url(room_id, "target.roomId", keep_query=True)
    except Exception as exc:
        return _bad_result(send_id, "failed", str(exc))
    gate_key = "%s:%s:%s" % (source, target_id, author_id)
    try:
        reservation = gate.reserve(send_id, gate_key, text, kind="comment")
    except GateError as exc:
        return _bad_result(send_id, "failed", exc.message)
    if reservation.get("kind") != "reserved":
        return _gate_result(gate, reservation, send_id)

    started = False
    try:
        tab.call("Page.navigate", {"url": room_url}, timeout=25)
        if not _wait_ready(tab):
            row = gate.finish(send_id, "failed", "page_not_ready")
            return gate.result(row)
        current_url = _resolved_room_url(tab.evaluate("location.href") or room_url)
        requested_room = _canonical_room(room_url)
        resolved_room = _canonical_room(current_url)
        if source == "video" and (
            not resolved_room or resolved_room[0] != "www.douyin.com" or
            not re.fullmatch(r"/video/[0-9]+", resolved_room[1]) or
            (requested_room and requested_room[0] == "www.douyin.com" and resolved_room != requested_room)
        ):
            row = gate.finish(send_id, "failed", "target_room_mismatch")
            return gate.result(row)
        if source == "live" and (
            not resolved_room or resolved_room[0] != "live.douyin.com" or
            (requested_room and requested_room[0] == "live.douyin.com" and resolved_room != requested_room)
        ):
            row = gate.finish(send_id, "failed", "target_live_room_mismatch")
            return gate.result(row)
        if douyin.check_captcha(tab):
            row = gate.finish(send_id, "blocked", "captcha_requires_manual_action")
            return gate.result(row)
        login = douyin.login_state(tab)
        if login != "verified":
            row = gate.finish(send_id, "failed", "login_required" if login == "required" else "login_state_unknown")
            return gate.result(row)

        if source == "live":
            # Live is a public room composer.  It never clicks a particular
            # person's row and does not require authorId.
            composer = live.find_composer(tab)
        else:
            # 真机校正（2026-09-20）：改用 douyin.comment_reply_button。
            # 旧路径 build_comment_target_expression 依赖 [data-e2e="comment-content"]
            # 与 [data-e2e="comment-reply"]，这两个名字在真机上都不存在，
            # 于是永远停在 comment_not_found —— 这是 video_reply 长期不可自动化的原因。
            # 新定位器还会先 scrollIntoView 再重读坐标（虚拟列表里出视口的行坐标是负的）。
            found = douyin.comment_reply_button(tab, target)
            if not found.get("found"):
                row = gate.finish(send_id, "failed",
                                  "reply_" + str(found.get("reason") or "not_found"))
                return gate.result(row)
            tab.click_at(found["x"], found["y"])
            time.sleep(0.6)
            composer = douyin.comment_reply_composer(tab, target)
        if not composer.get("found"):
            row = gate.finish(send_id, "failed", "comment_composer_not_found")
            return gate.result(row)
        tab.click_at(composer["x"], composer["y"])
        tab.type_text(text)
        if source == "live":
            button = live.find_send_button(tab)
            if not button.get("found") or button.get("disabled"):
                row = gate.finish(send_id, "failed", "comment_send_button_unavailable")
                return gate.result(row)
        else:
            # ⚠️ 语义变化：comment_reply_send_button 的 found 表示【处于激活态】。
            # 真机上发送键是 <svg>，没有 disabled 属性，旧判据永远为假；
            # 现在按颜色判定 —— 内容为空时它不是品牌红，于是"空内容不发送"自动成立。
            button = douyin.comment_reply_send_button(tab, target)
            if not button.get("found"):
                row = gate.finish(send_id, "failed",
                                  "comment_send_button_" + str(button.get("reason") or "not_found"))
                return gate.result(row)
        after = live.find_composer(tab) if source == "live" else douyin.comment_reply_composer(tab, target)
        if (after.get("text") or "") != text:
            row = gate.finish(send_id, "failed", "text_verification_failed")
            return gate.result(row)
        gate.mark_started(send_id)
        started = True
        tab.click_at(button["x"], button["y"])
        row = gate.finish(send_id, "unknown", "platform_response_unavailable")
        return gate.result(row)
    except Exception as exc:
        return _internal_failure(gate, send_id, started, exc, "send_comment")
