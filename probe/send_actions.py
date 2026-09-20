"""Validated browser actions backed by :mod:`send_gate`.

This module never treats a DOM change as delivery.  A click without a
platform response is recorded as ``unknown`` and blocks a later retry.
"""
import re
import time
from urllib.parse import urlsplit

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


def _canonical_room(url):
    """Return a query-free canonical Douyin room tuple for exact binding."""
    try:
        parsed = urlsplit(str(url or ""))
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in ("www.douyin.com", "live.douyin.com"):
        return None
    path = parsed.path.rstrip("/") or "/"
    return parsed.hostname, path


def _response_status(record):
    parsed = record.get("parsed") or {}
    if not isinstance(parsed, dict):
        return None
    data = parsed.get("data") if isinstance(parsed.get("data"), dict) else parsed
    return data.get("status_code", parsed.get("status_code"))


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
        if douyin.check_captcha(tab):
            row = gate.finish(send_id, "blocked", "captcha_requires_manual_action")
            return gate.result(row)
        login = douyin.login_state(tab)
        if login != "verified":
            row = gate.finish(send_id, "failed", "login_required" if login == "required" else "login_state_unknown")
            return gate.result(row)

        entry = douyin.dm_entry(tab)
        if entry.get("blocked"):
            row = gate.finish(send_id, "blocked", "target_dm_not_available")
            return gate.result(row)
        if not entry.get("found"):
            row = gate.finish(send_id, "failed", "target_session_not_found")
            return gate.result(row)
        author_name = str(target.get("authorName") or "").strip()
        context = douyin.recipient_context(tab, author_id, author_name)
        if not context.get("verified"):
            row = gate.finish(send_id, "failed", "target_context_not_confirmed")
            return gate.result(row)
        tab.click_at(entry["x"], entry["y"])
        # The panel is mounted asynchronously.  Wait for the composer and
        # its own recipient container together; a profile link or old chat
        # history elsewhere on the page cannot prove the active recipient.
        composer = {"found": False}
        for _ in range(12):
            time.sleep(0.4)
            composer = douyin.dm_composer_for_recipient(tab, author_id, author_name)
            if composer.get("found"):
                break
        if not composer.get("found"):
            row = gate.finish(send_id, "failed", "composer_not_found")
            return gate.result(row)
        existing_text = str(composer.get("text") or "")
        if existing_text and existing_text != text:
            row = gate.finish(send_id, "failed", "composer_has_different_draft")
            return gate.result(row)
        tab.click_at(composer["x"], composer["y"])
        tab.type_text(text)
        time.sleep(0.3)
        after = douyin.dm_composer_for_recipient(tab, author_id, author_name)
        if (after.get("text") or "") != text:
            row = gate.finish(send_id, "failed", "text_verification_failed")
            return gate.result(row)
        button = douyin.dm_send_button_for_recipient(tab, author_id, author_name)
        if not button.get("found") or button.get("disabled"):
            row = gate.finish(send_id, "failed", "send_button_unavailable")
            return gate.result(row)

        final_composer = douyin.dm_composer_for_recipient(tab, author_id, author_name)
        if not final_composer.get("found") or final_composer.get("containerKey") != composer.get("containerKey"):
            row = gate.finish(send_id, "failed", "target_session_changed")
            return gate.result(row)
        button = douyin.dm_send_button_for_recipient(tab, author_id, author_name)
        if not button.get("found") or button.get("disabled"):
            row = gate.finish(send_id, "failed", "send_button_context_changed")
            return gate.result(row)
        # The durable started marker is the last operation before the click.
        gate.mark_started(send_id)
        started = True
        recorder = douyin.make_network_recorder(tab, getattr(S, "DM_SEND_URL_MARK", ""))
        try:
            tab.call("Network.enable", {}, timeout=10)
        except Exception:
            pass
        tab.click_at(button["x"], button["y"])
        records = recorder.collect(wait_seconds=8.0)
        mark = getattr(S, "DM_SEND_URL_MARK", "")
        matched = [r for r in records if mark and mark in (r.get("url") or "")]
        statuses = [_response_status(r) for r in matched]
        row = gate.finish(send_id, "unknown", "platform_response_unavailable",
                          {"httpResponses": len(records), "matchedResponses": len(matched),
                           "platformStatusCodes": statuses[:5]})
        return gate.result(row)
    except Exception as exc:
        if started:
            row = gate.finish(send_id, "unknown", type(exc).__name__)
        else:
            row = gate.finish(send_id, "failed", type(exc).__name__)
        return gate.result(row)


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
    """Build the scoped, exact video-comment locator expression."""
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
        from url_policy import safe_url as normalize_url
        current_url = normalize_url(tab.evaluate("location.href") or room_url, "resolved room url")
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
            expression = build_comment_target_expression(target)
            found = tab.eval_json(expression) or {"ok": False, "reason": "comment_not_found"}
            if not found.get("ok"):
                row = gate.finish(send_id, "failed", found.get("reason", "comment_not_found"))
                return gate.result(row)
            tab.click_at(found["x"], found["y"])
            time.sleep(0.6)
            composer = douyin.comment_reply_composer(tab, target)
        if not composer.get("found"):
            row = gate.finish(send_id, "failed", "comment_composer_not_found")
            return gate.result(row)
        tab.click_at(composer["x"], composer["y"])
        tab.type_text(text)
        button = live.find_send_button(tab) if source == "live" else douyin.comment_reply_send_button(tab, target)
        if not button.get("found") or button.get("disabled"):
            row = gate.finish(send_id, "failed", "comment_send_button_unavailable")
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
        row = gate.finish(send_id, "unknown" if started else "failed", type(exc).__name__)
        return gate.result(row)
