"""抖音页面操作原语。

这里沉淀的是 legacy/ 用真账号反复试错换来的知识，逐条对应：
  · 页面同时存在【隐藏与可见两套】comment-list —— 必须先筛出可见的那个，
    否则拿到的是 0x0 容器，按钮尺寸全为 0，必然失败。
  · scrollIntoView 之后虚拟列表会重渲染 —— 必须【延迟】再读按钮坐标，
    同步读会拿到 0x0。
  · 点击必须用 Input.dispatchMouseEvent 发真实鼠标事件；
    直接 element.click() 在很多控件上不生效。
  · 图文帖(note)网页版评论区是右侧小浮层，深评论会被回收 —— 判定为不支持，跳过。
"""
import json
import re
import time

import cdp as cdpmod
from cdp import NetworkRecorder
import douyin_selectors as S


# ===================== 状态判定 =====================

def page_text(cdp):
    return cdp.evaluate("(document.body && document.body.innerText) || ''") or ""


_CAPTCHA_PROBE_JS = (
    "(function(){"
    "function vis(e){try{var r=e.getBoundingClientRect();var cs=getComputedStyle(e);"
    " if(r.width<=0||r.height<=0) return false;"
    " if(cs.display==='none'||cs.visibility==='hidden') return false;"
    " if(parseFloat(cs.opacity||'1')<=0.05) return false;"
    " if(e.checkVisibility&&!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;"
    " return true;}catch(err){return false;}}"
    "var sels=" + json.dumps(S.CAPTCHA_DOM) + ";"
    "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
    " for(var j=0;j<ns.length;j++){var e=ns[j];"
    "  if(!vis(e)) continue;"
    "  var t=(e.innerText||'').replace(/\\s+/g,'');"
    "  if(t.length>=2) return {hit:true,why:'visible_text',sel:sels[i],text:t.slice(0,30)};"
    "  var inner=e.querySelectorAll('iframe,canvas,img,svg');"
    "  for(var k=0;k<inner.length;k++){"
    "   if(!vis(inner[k])) continue;"
    "   var fr=inner[k];"
    "   if(fr.tagName!=='IFRAME'){"
    "     if(fr.tagName==='CANVAS'&&fr.width>0&&fr.height>0)"
    "       return {hit:true,why:'visible_canvas',sel:sels[i]};"
    "     continue;}"
    "   var rf=fr.getBoundingClientRect();"
    "   if(rf.width<200||rf.height<100) continue;"   # 小挂件（如无感验证的角标）不算
    "   return {hit:true,why:'visible_big_iframe',sel:sels[i],"
    "           w:Math.round(rf.width),h:Math.round(rf.height)};}"
    "}}"
    "return {hit:false};})()"
)


def verify_frame_urls(cdp):
    """列出当前【已加载】的 frame URL（含 OOPIF）。

    为什么要它：真验证码是渲染在跨域 iframe 里的，主文档读不到它的文字，
    但 CDP 能看到这个 frame 已经加载 —— 而且它的 URL 与常驻的
    rmc-nocaptcha（无感验证）明显不同：真挑战是 verifycenter/captcha。
    """
    urls = []
    try:
        tree = cdp.call("Page.getFrameTree", {}, timeout=8)
        stack = [tree.get("frameTree") or {}]
        while stack:
            node = stack.pop()
            urls.append(((node.get("frame") or {}).get("url") or ""))
            stack.extend(node.get("childFrames") or [])
    except Exception:
        pass
    try:
        for t in cdpmod.list_tabs(cdp.port):
            if t.get("type") == "iframe":
                urls.append(t.get("url") or "")
    except Exception:
        pass
    return [u for u in urls if u]


def captcha_probe(cdp):
    """返回 {hit, why, ...}。why 说明命中的是哪条判据，便于复盘与排错。"""
    try:
        title = cdp.evaluate("document.title || ''") or ""
        if S.CAPTCHA_TITLE in title:
            return {"hit": True, "why": "title", "text": title[:40]}
    except Exception:
        pass
    try:
        dom = cdp.eval_json(_CAPTCHA_PROBE_JS)
        if isinstance(dom, dict) and dom.get("hit"):
            return dom
    except Exception:
        pass
    try:
        for u in verify_frame_urls(cdp):
            if any(m in u for m in S.VERIFY_FRAME_MARKS):
                box = cdp.eval_json(
                    "(function(){var e=document.getElementById('captcha_container');"
                    "if(!e) return null;var r=e.getBoundingClientRect();"
                    "return {w:Math.round(r.width),h:Math.round(r.height)};})()")
                if box and box.get("w", 0) > 0 and box.get("h", 0) > 0:
                    return {"hit": True, "why": "verify_frame", "url": u[:90]}
    except Exception:
        pass
    try:
        body = page_text(cdp)
        for tok in S.CAPTCHA_TEXT_STRONG:
            if tok in body:
                return {"hit": True, "why": "body_text", "text": tok}
    except Exception:
        pass
    return {"hit": False}


def check_captcha(cdp):
    """是否【真的】出现验证码。

    出现验证码一律【停止并交人工】，绝不做自动识别或绕过。

    真机事实（2026-09-19 之后实测）：抖音在页面里【预埋】了验证组件——
        <div id="captcha_container"> z-index:111111; 1036x850
        <iframe id="nocaptcha-container" src=".../rmc-nocaptcha/...">   ← 无感验证，平时 display:none
      平时它们不显示；风控真的触发时，容器里会出现一个【居中的 380x348 iframe】指向
        https://rmc.bytedance.com/verifycenter/captcha/v2?...
      并且作为一个 OOPIF target 真实加载。实测截图对比：该区域从 3.5KB 的纯色变成 288KB 的
      挑战画面 —— 那是【真验证码】，不是空壳。

    判据（任一条命中即熔断）：
      1) 标题含"验证码"
      2) 可见的验证容器里【有文字】(>=2 字)，
         或【有一个够大的可见 iframe】(>=200x100) / 有内容的 canvas
      3) 正文出现完整强提示句（请输入验证码 / 请完成安全验证 / 拖动滑块完成拼图）
      4) 已加载的 frame 里出现 verifycenter/captcha（区别于常驻的 rmc-nocaptcha 无感组件）

    ⚠️ 已知盲区：跨域 iframe 内部的正文在主文档里读不到，
       所以"没检测到"不等于"一定没验证码"。采集到 0 条等异常仍按风控处理。
    """
    return bool(captcha_probe(cdp).get("hit"))


def login_state(cdp):
    """返回 ``required``、``verified`` 或 ``unknown``。

    🔴 真机教训（原实现是错的）：原来只看正文里有没有「扫码登录|登录后」，
       结果搜索页一条视频简介写着"一旦退出登录后，再次登录就要验证手机号"——
       正文命中「登录后」，于是【明明登录着却判定为未登录】。
       这和验证码那个误判是同一类 bug：拿正文关键词当状态机。

    只使用页面可见账号元素与登录弹窗。Cookie 存在本身不构成登录
    证明，因为 sidecar 不应读取或持久化凭据。
    """
    modal = bool(cdp.eval_json(
        "(function(){var sels=" + json.dumps(S.LOGIN_MODAL_DOM) + ";"
        "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
        " for(var j=0;j<ns.length;j++){var r=ns[j].getBoundingClientRect();"
        "  if(r.width>0&&r.height>0) return true;}}"
        "return false;})()"
    ))
    if modal:
        return "required"
    account = bool(cdp.eval_json(
        "(function(){var sels=" + json.dumps(S.LOGIN_ACCOUNT_DOM) + ";"
        "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
        "for(var j=0;j<ns.length;j++){var e=ns[j],r=e.getBoundingClientRect();"
        "if(r.width>0&&r.height>0&&e.innerText&&e.innerText.trim())return true;}}"
        "return false;})()"
    ))
    if account:
        return "verified"
    if live_room_signed_in(cdp):
        return "verified"
    return "unknown"


def live_room_signed_in(cdp):
    """直播间页面上的已登录判定（真机 2026-09-20）。

    为什么单独一条：www.douyin.com 的账号元素在 live.douyin.com 上不存在，
    只靠 LOGIN_ACCOUNT_DOM 会把"已登录"判成 unknown，于是公屏回复全被守卫拦下
    （真机实测：login_state() == unknown，而页面其实已登录）。

    判据（全部是页面可见 DOM，不读 Cookie、不看正文关键词）：
      · 登录弹窗不存在（调用方已先判过）；
      · 页首出现账号头像；
      · 公屏输入框已渲染。
    ⚠️ 残留风险：这是启发式判据。若未登录时平台仍渲染这几样，会被误判成已登录；
       后果是发送动作被平台拒绝、结果停在 unknown —— 不会产生假的"发送成功"。
    """
    try:
        return bool(cdp.eval_json(
            "(function(){"
            "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
            "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
            "if(location.hostname!=='live.douyin.com')return false;"
            "var avatars=" + json.dumps(S.LIVE_LOGIN_AVATAR_DOM) + ",n=0;"
            "for(var i=0;i<avatars.length;i++){var ns=document.querySelectorAll(avatars[i]);"
            "for(var j=0;j<ns.length;j++){var r=ns[j].getBoundingClientRect();"
            "if(vis(ns[j])&&r.top<90)n++;}}"
            "if(!n)return false;"
            "var box=document.querySelector(" + json.dumps(S.LIVE_CHAT_EDITOR_BOX) + ");"
            "return !!(box&&vis(box));"
            "})()"
        ))
    except Exception:
        return False


def check_login_required(cdp):
    return login_state(cdp) == "required"


def is_note_page(cdp):
    return bool(cdp.eval_json("(!!document.querySelector('%s')) || location.pathname.indexOf('/note/') >= 0" % S.NOTE_DETAIL))


# ===================== 页面可见性 / 滚动（🔴 真机踩坑点） =====================
#
# 真机实测（Chrome 153 / Windows）：当 Chrome 窗口被别的窗口【完全遮挡】或最小化时，
#   · document.visibilityState === "hidden"
#   · Input.dispatchMouseEvent(mouseWheel) 【不返回】——一直挂到我们自己的超时（实测 25s）
#   · IntersectionObserver 驱动的懒加载基本不触发（搜索结果 / 评论都翻不动页）
# 处置：开跑前先 ensure_visible()；滚轮一律给短超时并回退到 JS 滚动；
#       仍然不动就【明确报警】，而不是静默地"抓到 20 条就收工"。

def visibility_state(cdp):
    try:
        return cdp.evaluate("document.visibilityState") or "unknown"
    except Exception:
        return "unknown"


def force_page_active(cdp):
    """让浏览器把页面当【活跃】处理，返回实际生效的命令列表。

    🔴 真机教训（2026-09-19 采集 / 2026-09-20 私信各踩一次，工作日志第 7 条）：
      Chrome 窗口即使在前台，只要被别的窗口【遮挡】，document.visibilityState 仍是 "hidden"。
      后果有两类，都很隐蔽：
        · 直播间弹幕虚拟列表【一条都不渲染】（WS 还在收帧，DOM 恒空），采集看起来像"没人说话"；
        · **点击不送达渲染进程** —— 私信按钮点上去了、坐标也对，面板就是不开
          （人工点同一个页面却正常，最难查的就是这种）。
      这两条 CDP 命令可以解除：
        · Page.setWebLifecycleState(active)  把被冻结/降级的页面拉回 active
        · Emulation.setFocusEmulationEnabled 让页面认为自己在焦点上
      只影响浏览器自己的调度与页面状态，不触碰平台风控，也不改平台侧任何状态。
    """
    applied = []
    for method, params in (("Page.setWebLifecycleState", {"state": "active"}),
                           ("Emulation.setFocusEmulationEnabled", {"enabled": True})):
        try:
            cdp.call(method, params, timeout=8)
            applied.append(method)
        except Exception:
            pass
    return applied


def ensure_visible(cdp, log=None):
    """尽力把页面变成 visible。返回是否成功。不改变任何平台侧状态。"""
    if visibility_state(cdp) == "visible":
        return True
    try:
        cdp.call("Page.bringToFront", {}, timeout=5)
    except Exception:
        pass
    time.sleep(1.0)
    if visibility_state(cdp) != "visible" and force_page_active(cdp):
        time.sleep(0.8)
    ok = visibility_state(cdp) == "visible"
    if not ok and log:
        log("[!] 页面 visibilityState=%s —— Chrome 窗口被遮挡/最小化。" % visibility_state(cdp))
        log("    后果：滚轮事件会超时、懒加载不触发，结果会【静默变少】。")
        log("    请把 Chrome 窗口切到前台（本工具已尝试 bringToFront，通常需要人工点一下窗口）。")
    return ok


def scroll_by(cdp, dy=1600, x=900, y=500, timeout=6):
    """滚动页面。返回实际用的通道："wheel" / "js" / None。

    可见时用真实滚轮（最接近真人，能触发懒加载）；
    不可见时滚轮会挂住，于是【先判可见性】，不可见直接走 JS，不浪费超时时间。
    """
    if visibility_state(cdp) == "visible":
        try:
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mouseWheel", "deltaX": 0, "deltaY": int(dy), "x": int(x), "y": int(y)},
                     timeout=timeout)
            return "wheel"
        except Exception:
            pass
    try:
        cdp.evaluate("window.scrollBy(0,%d); 'ok'" % int(dy))
        return "js"
    except Exception:
        return None


def page_scroll_pos(cdp):
    return cdp.eval_json(
        "(function(){return {y:Math.round(window.scrollY),"
        " docH:document.documentElement.scrollHeight,"
        " winH:window.innerHeight,"
        " atBottom:(window.scrollY+window.innerHeight)>=document.documentElement.scrollHeight-4};})()"
    ) or {}


# ===================== 评论区 =====================

_VISIBLE_ROOT_JS = (
    "var __lists=Array.from(document.querySelectorAll('%s'));"
    "var __root=null;"
    "for(var __i=0;__i<__lists.length;__i++){"
    "  var __r=__lists[__i].getBoundingClientRect();"
    "  if(__r.width>0&&__r.height>0){__root=__lists[__i];break;}"
    "}"
    "if(!__root)__root=document;"
) % S.COMMENT_LIST


def comment_panel_visible(cdp):
    return bool(cdp.eval_json(
        "(function(){var ls=Array.from(document.querySelectorAll('%s'));"
        "for(var i=0;i<ls.length;i++){var r=ls[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true;}"
        "return false;})()" % S.COMMENT_LIST
    ))


def collect_comments(cdp, limit=20):
    """从【可见】容器采集评论，精确区分昵称与正文。

    DOM 结构（2026-09-19 真机确认）：
      <a href="//www.douyin.com/user/<sec_uid>"><span>昵称</span></a>
      <div>...</div>
      <span>评论正文</span>          <- 独立 SPAN
      <span>14小时前·山东</span>      <- 兄弟节点，不是正文
      <span>0</span>                 <- 点赞数
      <div>分享</div> <span>回复</span>

    ⚠️ 先前直接取 comment-item.innerText，把时间/地区/点赞/分享/回复全吞进去了，
       导致 {comment} 变量会带一堆垃圾。这里改为：排除链接内、排除时间/纯数字/固定标签，
       再取【最长】的候选作为正文。
    """
    expr = (
        "(function(){"
        "var lists=Array.from(document.querySelectorAll('" + S.COMMENT_LIST + "'));"
        "var root=null;"
        "for(var i=0;i<lists.length;i++){var r=lists[i].getBoundingClientRect();"
        "if(r.width>0&&r.height>0){root=lists[i];break;}}"
        "if(!root) root=document;"
        "var items=Array.from(root.querySelectorAll('" + S.COMMENT_ITEM + "'));"
        "var out=[];"
        "for(var k=0;k<items.length && out.length<" + str(int(limit)) + ";k++){"
        "  var it=items[k];"
        "  var link=it.querySelector('a[href*=\"/user/\"]');"
        "  var secUid=null, nick='';"
        "  if(link){var m=(link.getAttribute('href')||'').match(/\\/user\\/([^\\/?]+)/);"
        "    if(m) secUid=m[1]; nick=(link.innerText||'').replace(/\\s+/g,' ').trim();}"
        "  var cands=[];"
        "  var leaves=Array.from(it.querySelectorAll('span,div'));"
        "  for(var j=0;j<leaves.length;j++){"
        "    var e=leaves[j];"
        "    if(e.children.length>0) continue;"
        "    if(link && link.contains(e)) continue;"
        "    var t=(e.innerText||'').replace(/\\s+/g,' ').trim();"
        "    if(!t) continue;"
        "    if(/^\\d+$/.test(t)) continue;"
        "    if(/^\\d+(秒|分钟|小时|天|周|月|年)前/.test(t)) continue;"
        "    if(t.indexOf('·')>=0 && /\\d/.test(t)) continue;"
        "    if(/^(分享|回复|作者|置顶|展开\\d+条回复|收起)$/.test(t)) continue;"
        "    cands.push(t);"
        "  }"
        "  var text='';"
        "  for(var c=0;c<cands.length;c++){ if(cands[c].length>text.length) text=cands[c]; }"
        "  out.push({nick:nick, text:text, sec_uid:secUid});"
        "}"
        "return out;})()"
    )
    return cdp.eval_json(expr) or []


def comment_panel_rect(cdp):
    """【可见】评论容器的 rect。页面同时存在隐藏与可见两套 comment-list。"""
    return cdp.eval_json(
        "(function(){var ls=Array.from(document.querySelectorAll('%s'));"
        "for(var i=0;i<ls.length;i++){var r=ls[i].getBoundingClientRect();"
        " if(r.width>0&&r.height>0) return {x:Math.round(r.x),y:Math.round(r.y),"
        "  width:Math.round(r.width),height:Math.round(r.height)};}"
        "return null;})()" % S.COMMENT_LIST
    )


_COMMENT_SCROLL_JS = (
    "(function(){var ls=Array.from(document.querySelectorAll('%s'));"
    "var root=null;"
    "for(var i=0;i<ls.length;i++){var r=ls[i].getBoundingClientRect();"
    " if(r.width>0&&r.height>0){root=ls[i];break;}}"
    "if(!root) return {ok:false,reason:'no_visible_panel'};"
    "var n=0,e=root;"
    "while(e&&e!==document.body&&e!==document.documentElement){"
    "  if(e.scrollHeight>e.clientHeight+40){"
    "    var cs=getComputedStyle(e);"
    "    if(/scroll|auto/.test(cs.overflowY)){e.scrollTop=e.scrollHeight;n++;}}"
    "  e=e.parentElement;}"
    "var items=root.querySelectorAll('%s').length;"
    "return {ok:true,scrolled:n,items:items};})()"
) % (S.COMMENT_LIST, S.COMMENT_ITEM)


def comment_item_count(cdp):
    r = cdp.eval_json(_COMMENT_SCROLL_JS) or {}
    return r.get("items", 0)


def _rect_center(rect, w, h):
    """把 rect 折成可用坐标；形状不完整就返回 None（绝不猜、绝不抛）。

    评论容器是平台 DOM，改版会让 getBoundingClientRect 的字段缺席或变成非数字。
    这里要求四个键齐全且宽高为正，否则交给调用方走固定坐标兜底。
    """
    if not isinstance(rect, dict):
        return None
    try:
        x0 = float(rect["x"])
        y0 = float(rect["y"])
        rw = float(rect["width"])
        rh = float(rect["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if rw <= 0 or rh <= 0:
        return None
    return (min(max(int(x0 + rw // 2), 20), int(w) - 20),
            min(max(int(y0 + rh // 2), 60), int(h) - 60))


def scroll_comment_panel(cdp, rounds=4, pause=1.6, dy=2000):
    """把评论容器往下滚一轮。返回最后一次的结果 {ok, scrolled, items, wheel}。

    🔴 真机教训：原来固定 wheel 在 (900,500)。新版的视频页里评论容器在【页面下方】
       （实测 rect 约 72,745,673,677），固定坐标滚的是整页而不是评论列表；
       而页面可见性为 hidden 时 wheel 调用会直接挂到超时。
    现在的做法：
      1) 取可见评论容器的真实 rect，把滚轮打进去（仅在可见时）
      2) 再把【该容器及可滚动祖先】的 scrollTop 拉到底（JS 兜底，覆盖虚拟列表）
      3) 不动 documentElement/body —— 视频页整页下滚可能切到下一个视频，会污染数据
    """
    info = {}
    fallback_reason = None
    for _ in range(rounds):
        rect = comment_panel_rect(cdp)
        vw = cdp.eval_json("(function(){return {w:window.innerWidth,h:window.innerHeight};})()") or {}
        try:
            w, h = int(vw.get("w") or 1680), int(vw.get("h") or 876)
        except (TypeError, ValueError):
            w, h = 1680, 876
        # 🔴 不能只看 rect 的真假：rect 非空【不代表】它有 x/y/width/height。
        #    原来直接 rect["x"]，一旦页面返回的形状不是这四个键（DOM 改版，
        #    或夹具/替身返回别的结构），就抛 KeyError 冒到调用方；
        #    而调用方只会把它记成一句 "KeyError"，看不出是评论容器定位失败。
        center = _rect_center(rect, w, h)
        if center is None:
            x, y = w - 200, h // 2
            fallback_reason = "panel_rect_unavailable" if rect else "panel_rect_absent"
        else:
            x, y = center
            fallback_reason = None
        via = scroll_by(cdp, dy=dy, x=x, y=y)
        try:
            info = cdp.eval_json(_COMMENT_SCROLL_JS) or {}
        except Exception:
            info = {}
        info["wheel"] = via
        if fallback_reason:
            info["wheelFallback"] = fallback_reason
        time.sleep(pause)
    return info


# ===================== 私信入口 =====================

_DM_ENTRY_JS = (
    "(function(){"
    "var body=document.body?document.body.innerText:'';"
    "if(/%s/.test(body)) return {found:false,blocked:true,reason:'stranger_dm_disabled'};"
    "var nodes=Array.from(document.querySelectorAll('button,[role=button],a'));"
    "for(var i=0;i<nodes.length;i++){"
    "  var n=nodes[i];"
    "  var t=(n.innerText||n.textContent||'').replace(/\\s+/g,'').trim();"
    "  if(t!=='%s') continue;"
    "  var r=n.getBoundingClientRect(),cs=getComputedStyle(n);"
    "  if(r.width<=0||r.height<=0) continue;"
    "  if(cs.visibility==='hidden'||cs.display==='none') continue;"
    "  if(n.disabled||n.getAttribute('aria-disabled')==='true')"
    "    return {found:false,blocked:true,reason:'stranger_dm_disabled'};"
    "  return {found:true,blocked:false,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};"
    "}"
    "return {found:false,blocked:false,reason:'dm_button_not_found'};"
    "})()"
) % (S.STRANGER_DM_BLOCKED_RE, S.DM_BUTTON_TEXT)


def profile_error_page(cdp):
    """"内容不存在" 错误页判定。

    🔴 真机事实（2026-09-20，两个真实直播间对比）：
      房间 689015985670 —— 16/16 条弹幕都带真实 sec_uid（MS4wLjABAAAA…），可私信；
      房间 423909340168 —— 观众行的 sec_uid 为空、uid 是占位值 111111（昵称也已脱敏），
      只有主播自己的消息带 sec_uid。拿占位数字拼出的 /user/111111 打开就是错误页。
    错误页上当然没有账号元素 —— 于是私信会被判成 login_state_unknown，
    真正的原因（对方主页根本不存在）被掩盖，排查时会误以为是登录态问题。
    所以这里先识别错误页，让失败原因如实。
    """
    try:
        return bool(cdp.eval_json(
            "(function(){var sels=" + json.dumps(S.PROFILE_ERROR_DOM) + ";"
            "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
            " for(var j=0;j<ns.length;j++){var r=ns[j].getBoundingClientRect();"
            "  if(r.width>0&&r.height>0)return true;}}"
            "return false;})()"
        ))
    except Exception:
        return False


def dm_entry(cdp):
    """探测「私信」入口。

    ⚠️ 这是整个方案的关键未知数：企业号在网页端能否私信未互关用户。
    本函数只做【只读探测】，不点击、不发送。
    """
    return cdp.eval_json(_DM_ENTRY_JS) or {"found": False, "blocked": False, "reason": "eval_failed"}


_RECIPIENT_CONTEXT_JS = (
    "(function(expectedId,expectedName){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "function exactPath(h){try{var p=new URL(h,location.href).pathname.replace(/\\/$/,'');"
    "return p==='/user/'+expectedId;}catch(e){return false;}}"
    "var links=Array.from(document.querySelectorAll('a[href]'));"
    "for(var i=0;i<links.length;i++){var a=links[i];if(!vis(a)||!exactPath(a.href))continue;"
    "if(!ALLOW_PROFILE&&!a.closest('[class*=message],[class*=chat],[class*=imChat],[data-e2e*=message]'))continue;"
    "var name=(a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim();"
    "if(!expectedName||name===expectedName)return {verified:true,via:'profile_link',name:name};}"
    "var nodes=Array.from(document.querySelectorAll('[data-recipient-id],[data-user-id],[data-author-id]'));"
    "for(var j=0;j<nodes.length;j++){var n=nodes[j];if(!vis(n))continue;"
    "var id=n.getAttribute('data-recipient-id')||n.getAttribute('data-user-id')||n.getAttribute('data-author-id');"
    "var name=(n.innerText||n.textContent||'').replace(/\\s+/g,' ').trim();"
    "if(id===expectedId&&(!expectedName||name===expectedName))return {verified:true,via:'recipient_context',name:name};}"
    "return {verified:false};})(EXPECTED_ID,EXPECTED_NAME)"
)


def recipient_context(cdp, author_id, author_name="", allow_profile=True):
    """Verify the visible recipient identity without trusting page body text."""
    profile_fallback = (
        "var p=location.pathname.replace(/\\/$/,'');"
        "if(" + json.dumps(bool(allow_profile)) + "&&p==='/user/'+expectedId)"
        "return {verified:true,via:'exact_profile_url'};"
    )
    expr = _RECIPIENT_CONTEXT_JS.replace("EXPECTED_ID", json.dumps(str(author_id))) \
        .replace("EXPECTED_NAME", json.dumps(str(author_name or "").strip())) \
        .replace("ALLOW_PROFILE", json.dumps(bool(allow_profile))) \
        .replace("return {verified:false};", profile_fallback + "return {verified:false};")
    try:
        return cdp.eval_json(expr) or {"verified": False}
    except Exception:
        return {"verified": False}


_DM_COMPOSER_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),cs=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none';}"
    "var scopes=" + json.dumps(S.DM_EDITOR_SCOPES) + ";"
    "for(var s=0;s<scopes.length;s++){"
    "  var box=document.querySelector(scopes[s]);"
    "  if(!box) continue;"
    "  var eds=Array.from(box.querySelectorAll('[contenteditable=true],textarea,input'));"
    "  for(var i=0;i<eds.length;i++){var e=eds[i];"
    "    if(!vis(e)) continue;"
    "    if(e.disabled||e.getAttribute('aria-disabled')==='true') continue;"
    "    var r=e.getBoundingClientRect();"
    "    return {found:true,scope:scopes[s],"
    "            x:Math.round(r.x+Math.min(120,Math.max(30,r.width/2))),"
    "            y:Math.round(r.y+r.height/2),text:(e.innerText||e.value||''),"
    "            cls:String(e.className||'').slice(0,60)};"
    "  }"
    "}"
    # ⚠️ 兜底必须【仍在私信容器内】。
    #    2026-09-19 真机教训：先前这里是"页面任意可见输入框"，
    #    结果面板没打开时它把私信文案打进了别的输入框，filled 判定还返回 True
    #    —— 典型静默错误。宁可找不到，也不能打错地方。
    "var all=Array.from(document.querySelectorAll('[contenteditable=true],textarea,input'));"
    "for(var j=0;j<all.length;j++){var el=all[j];"
    "  if(!vis(el)) continue;"
    "  var anc=el.closest('[class*=\"message\"],[class*=\"chat\"],[class*=\"imChat\"],[class*=\"MsgInput\"]');"
    "  if(!anc) continue;"
    "  var r2=el.getBoundingClientRect();"
    "  return {found:true,scope:'im-scoped-fallback',"
    "          x:Math.round(r2.x+Math.min(120,Math.max(30,r2.width/2))),"
    "          y:Math.round(r2.y+r2.height/2),text:(el.innerText||el.value||''),"
    "          cls:String(el.className||'').slice(0,60)};"
    "}"
    "return {found:false};"
    "})()"
)

def dm_composer(cdp):
    return cdp.eval_json(_DM_COMPOSER_JS) or {"found": False}


_DM_COMPOSER_FOR_RECIPIENT_JS = (
    "(function(expectedId,expectedName){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}"
    "function pathOk(a){try{return new URL(a.href,location.href).pathname.replace(/\\/$/,'')==='/user/'+expectedId;}"
    "catch(e){return false;}}"
    "function ctxOk(editor){var box=editor.closest('[data-recipient-id],[data-user-id],[data-author-id],[class*=message],[class*=chat],[class*=imChat],[class*=MsgInput]');"
    "if(!box)return null;var ids=[box.getAttribute('data-recipient-id'),box.getAttribute('data-user-id'),box.getAttribute('data-author-id')];"
    "var idOk=ids.indexOf(expectedId)>=0;var explicit=ids.some(function(v){return !!v;});"
    "if(explicit&&!idOk)return null;"
    "var links=Array.from(box.querySelectorAll('[data-e2e*=header] a[href],[class*=header] a[href]')).filter(function(a){return vis(a)&&pathOk(a);});"
    "var nameOk=!expectedName||links.some(function(a){return (a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim()===expectedName;});"
    "if(!idOk&&!links.length)return null;if(expectedName&&!nameOk)return null;"
    "return {box:box,key:box.id||box.getAttribute('data-recipient-id')||box.getAttribute('data-user-id')||box.className||'im-container'};}"
    "var scopes=" + json.dumps(S.DM_EDITOR_SCOPES) + ",hits=[];"
    "for(var s=0;s<scopes.length;s++){var box=document.querySelector(scopes[s]);if(!box)continue;"
    "var eds=Array.from(box.querySelectorAll('[contenteditable=true],textarea,input'));"
    "for(var i=0;i<eds.length;i++){var e=eds[i];if(!vis(e)||e.disabled||e.getAttribute('aria-disabled')==='true')continue;"
    "var context=ctxOk(e);if(!context)continue;var r=e.getBoundingClientRect();"
    "hits.push({found:true,scope:scopes[s],containerKey:String(context.key).slice(0,160),"
    "x:Math.round(r.x+Math.min(120,Math.max(30,r.width/2))),y:Math.round(r.y+r.height/2),text:(e.innerText||e.value||'')});}}"
    "if(hits.length!==1)return {found:false,reason:hits.length?'ambiguous_recipient_composer':'recipient_composer_not_found',count:hits.length};"
    "return hits[0];})(EXPECTED_ID,EXPECTED_NAME)"
)


def dm_composer_for_recipient(cdp, author_id, author_name=""):
    expr = _DM_COMPOSER_FOR_RECIPIENT_JS.replace("EXPECTED_ID", json.dumps(str(author_id))) \
        .replace("EXPECTED_NAME", json.dumps(str(author_name or "").strip()))
    return cdp.eval_json(expr) or {"found": False}


_DM_PANEL_JS = (
    "(function(expected){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}"
    "function norm(t){return String(t==null?'':t).replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/[*＊]/g,'').replace(/\\s+/g,'').trim();}"
    "var box=document.querySelector(" + json.dumps(S.DM_MESSAGE_EDITOR_SCOPE) + ");"
    "if(!(box&&vis(box)))return {found:false,reason:'dm_panel_not_open'};"
    "var ed=null,eds=box.querySelectorAll('[contenteditable=true],textarea,input');"
    "for(var i=0;i<eds.length;i++){if(vis(eds[i])){ed=eds[i];break;}}"
    "if(!ed)return {found:false,reason:'dm_editor_not_found'};"
    "var r=ed.getBoundingClientRect();"
    "var head=document.querySelector(" + json.dumps(S.DM_CHAT_HEADER_TITLE) + ");"
    "var headText=head?norm(head.innerText||head.textContent||''):'';"
    "var full=norm(expected.full||''),prefix=norm(expected.prefix||'');"
    "var panel=box.closest('[class*=imContainer],[class*=componentsEntry]');"
    "return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),"
    "text:String(ed.innerText||ed.value||'').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,''),headerFound:!!head,headerLen:headText.length,"
    "headerFull:!!(full&&headText===full),headerPrefix:!!(prefix&&headText.indexOf(prefix)===0),"
    "headerMatch:!!((full&&headText===full)||(prefix&&headText.indexOf(prefix)===0)),"
    "panelKey:panel?String(panel.className||'').slice(0,60):''};"
    "})"
)


def _norm_name(value):
    """昵称归一化：零宽字符、脱敏星号、空白都不参与比较（与页面侧同一套口径）。"""
    text = str(value or "")
    for junk in ("\u200b", "\u200c", "\u200d", "\ufeff"):
        text = text.replace(junk, "")
    for star in ("*", "＊"):
        text = text.replace(star, "")
    return re.sub(r"\s+", "", text)


def dm_panel_state(cdp, author_name=""):
    """私信面板状态（真机可用信号：编辑器 + 会话头部标题）。

    🔴 真机实测（2026-09-20）：面板里没有 data-recipient-id / data-user-id，也没有指向
    /user/<sec_uid> 的链接，所以严格校验收件人的那套选择器在真机上 count=0。
    真机可用信号是【会话头部标题 = 对方昵称】（脱敏昵称按可见前缀比较）。
    返回里只给长度与匹配布尔值，昵称原文不出页面。
    """
    expected = {"full": _norm_name(author_name),
                "prefix": _norm_name(str(author_name or "").split("*")[0])}
    payload = json.dumps(expected, ensure_ascii=False)
    return cdp.eval_json("(%s)(%s)" % (_DM_PANEL_JS, payload)) or {"found": False}


_CONVERSATION_ECHO_JS = (
    "(function(){"
    "function textOf(el){return String((el&&(el.innerText||el.textContent))||'')"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'').replace(/\\s+/g,'');}"
    "var scopes=" + json.dumps(S.DM_CONVERSATION_SCOPES) + ",out='';"
    "for(var i=0;i<scopes.length;i++){var ns=document.querySelectorAll(scopes[i]);"
    "for(var j=0;j<ns.length;j++){var t=textOf(ns[j]);if(t.length>out.length)out=t;}}"
    "return out.slice(0,4000);})()"
)


def dm_conversation_echo(cdp, text, seconds=6.0, interval=1.2):
    """等会话区里出现刚发的那条（诊断证据，不是"送达"判据本身）。"""
    want = re.sub(r"\s+", "", str(text or ""))
    deadline = time.time() + float(seconds)
    while True:
        try:
            body = cdp.evaluate(_CONVERSATION_ECHO_JS) or ""
        except Exception:
            body = ""
        if want and want in body:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(interval)


_DM_SEND_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),cs=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none';}"
    "function pick(el,why){var r=el.getBoundingClientRect();"
    "return {found:true,via:why,"
    "        x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),"
    "        w:Math.round(r.width),h:Math.round(r.height),"
    "        cls:String(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className||'').slice(0,70),"
    "        disabled:!!(el.disabled||el.getAttribute('aria-disabled')==='true')};}"
    # 1) 真机验证过的类名（SVG 图标，无文字）
    "var a=document.querySelector('" + S.DM_SEND_BUTTON + "');"
    "if(a&&vis(a)) return pick(a,'class:e2e-send-msg-btn');"
    # 2) 在私信容器内找 publishBtn
    "var scopes=" + json.dumps(S.DM_EDITOR_SCOPES) + ";"
    "for(var s=0;s<scopes.length;s++){"
    "  var box=document.querySelector(scopes[s]);"
    "  if(!box) continue;"
    "  var root=box; for(var u=0;u<4&&root.parentElement;u++) root=root.parentElement;"
    "  var b=root.querySelector('" + S.DM_SEND_FALLBACK + "');"
    "  if(b&&vis(b)) return pick(b,'class:publishBtn');"
    "}"
    # 3) 兜底：文字为「发送」的叶子节点
    "var all=Array.from(document.querySelectorAll('button,[role=button],div,span'));"
    "for(var i=0;i<all.length;i++){var e=all[i];"
    "  if(e.children&&e.children.length>0) continue;"
    "  var t=(e.innerText||e.textContent||'').replace(/\\s+/g,'').trim();"
    "  if(t!=='" + S.DM_SEND_TEXT + "') continue;"
    "  if(!vis(e)) continue;"
    "  return pick(e,'text:'+t);"
    "}"
    "return {found:false};"
    "})()"
)

def dm_send_button(cdp):
    return cdp.eval_json(_DM_SEND_JS) or {"found": False}


_DM_SEND_FOR_RECIPIENT_JS = (
    "(function(expectedId,expectedName){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}"
    "function pathOk(a){try{return new URL(a.href,location.href).pathname.replace(/\\/$/,'')==='/user/'+expectedId;}catch(e){return false;}}"
    "var scopes=" + json.dumps(S.DM_EDITOR_SCOPES) + ",hits=[];"
    "for(var s=0;s<scopes.length;s++){var box=document.querySelector(scopes[s]);if(!box)continue;"
    "var eds=Array.from(box.querySelectorAll('[contenteditable=true],textarea,input'));"
    "for(var i=0;i<eds.length;i++){var ed=eds[i];if(!vis(ed))continue;"
    "var root=ed.closest('[data-recipient-id],[data-user-id],[data-author-id],[class*=message],[class*=chat],[class*=imChat],[class*=MsgInput]');"
    "if(!root)continue;var ids=[root.getAttribute('data-recipient-id'),root.getAttribute('data-user-id'),root.getAttribute('data-author-id')];"
    "var explicit=ids.some(function(v){return !!v;});if(explicit&&ids.indexOf(expectedId)<0)continue;"
    "var links=Array.from(root.querySelectorAll('[data-e2e*=header] a[href],[class*=header] a[href]')).filter(function(a){return vis(a)&&pathOk(a);});"
    "if(ids.indexOf(expectedId)<0&&!links.length)continue;"
    "if(expectedName&&!links.some(function(a){return (a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim()===expectedName;}))continue;"
    "var bs=Array.from(root.querySelectorAll('" + S.DM_SEND_BUTTON + "," + S.DM_SEND_FALLBACK + ",button,[role=button]')).filter(function(b){"
    "var t=(b.innerText||b.textContent||'').replace(/\\s+/g,'').trim();return vis(b)&&(b.matches('" + S.DM_SEND_BUTTON + "," + S.DM_SEND_FALLBACK + "')||t==='" + S.DM_SEND_TEXT + "');});"
    "for(var j=0;j<bs.length;j++){var r=bs[j].getBoundingClientRect();hits.push({found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),"
    "disabled:!!(bs[j].disabled||bs[j].getAttribute('aria-disabled')==='true'),containerKey:String(root.id||root.getAttribute('data-recipient-id')||root.getAttribute('data-user-id')||root.className||'im-container').slice(0,160)});}}}"
    "if(hits.length!==1)return {found:false,reason:hits.length?'ambiguous_recipient_send_button':'recipient_send_button_not_found',count:hits.length};return hits[0];})(EXPECTED_ID,EXPECTED_NAME)"
)


def dm_send_button_for_recipient(cdp, author_id, author_name=""):
    expr = _DM_SEND_FOR_RECIPIENT_JS.replace("EXPECTED_ID", json.dumps(str(author_id))) \
        .replace("EXPECTED_NAME", json.dumps(str(author_name or "").strip()))
    return cdp.eval_json(expr) or {"found": False}


_COMMENT_COMPOSER_JS = (
    "(function(){function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "var sels=" + json.dumps(S.COMMENT_EDITORS) + ";"
    "for(var i=0;i<sels.length;i++){var es=document.querySelectorAll(sels[i]);"
    "for(var j=0;j<es.length;j++){var e=es[j];if(!vis(e))continue;"
    "var r=e.getBoundingClientRect();return {found:true,x:Math.round(r.x+r.width/2),"
    "y:Math.round(r.y+r.height/2),text:(e.innerText||e.value||'')};}}"
    "return {found:false};})()"
)


def comment_composer(cdp):
    return cdp.eval_json(_COMMENT_COMPOSER_JS) or {"found": False}


# ===================== 评论区回复：真机验证过的定位原语 =====================
#
# 🔴 2026-09-20 真机校正（video/7686815808756020563，Chrome 153）
#
# 旧实现用 [data-e2e="comment-content"] / comment-reply / comment-reply-input /
# comment-reply-submit 定位 —— 这些名字【真机上都不存在】，只在离线夹具里成立。
# 结果 video_reply 一直停在 autoEligible=false：夹具全绿，真机一个也匹配不到。
#
# 真机上的实际形态与对应策略：
#   1) 评论正文   裸节点           -> 兄弟节点排除法（bodyText）
#   2) 「回复」    裸 <span>        -> 文本严格等于「回复」
#   3) 回复编辑器  恰好 1 个 Draft  -> 在含「回复中」的那一项内取 [contenteditable=true]
#   4) 发送键      编辑器右侧图标    -> path 填充 == 抖音红（激活态）
#   5) 虚拟列表    出视口坐标为负    -> 先 scrollIntoView，再等重渲染后重读
#
# ⚠️ 这些是【结构锚点】而非平台承诺；平台改版会失效。每项都带 live_verified_at，
#    失效时应当 fail-closed（返回 not_found / inactive），绝不放宽成"随便点一个"。


def _row_helpers_js():
    """评论区共用的 JS 前置：可见根、行枚举、正文提取、目标匹配。"""
    return (
        "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
        "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
        "function inView(e){var r=e.getBoundingClientRect();"
        "return r.bottom>=0&&r.top<=innerHeight&&r.right>=0&&r.left<=innerWidth;}"
        "function visibleRoot(){var ls=Array.from(document.querySelectorAll(" + json.dumps(S.COMMENT_LIST) + "));"
        "for(var i=0;i<ls.length;i++){var r=ls[i].getBoundingClientRect();"
        "if(r.width>0&&r.height>0)return ls[i];}return null;}"
        "function rows(){var root=visibleRoot();if(!root)return [];"
        "return Array.from(root.querySelectorAll(" + json.dumps(S.COMMENT_ITEM) + ")).filter(vis);}"
        # 正文提取：排除作者链接内、时间/地区、纯数字、固定操作文案，取最长候选
        "function bodyText(row){var noise=" + json.dumps(S.COMMENT_NOISE_TEXTS) + ";"
        "var link=row.querySelector('a[href*=\"/user/\"]');var best='';"
        # 🔴 真机（2026-09-21 评审）：过滤纯数字是为了避开时间/计数这类噪声，
        #    但【整条评论就是数字】的情况真实存在（例如「111」「666」「+1」的场景里用户只发数字）。
        #    原来一律 continue，于是 best 为空 -> rowMatches 永远匹配不到 ->
        #    采集里有这条、定位恒失败，看起来像定位器坏了。
        #    所以留一个纯数字兜底：只有在没有任何其它候选时才用它。
        "var digits='';"
        "var all=row.querySelectorAll('span,div');"
        "for(var i=0;i<all.length;i++){var e=all[i];"
        "if(e.children&&e.children.length>0)continue;"
        "if(link&&link.contains(e))continue;"
        "var t=(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim();"
        "if(!t)continue;"
        "if(/^\\d+$/.test(t)){if(!digits)digits=t;continue;}"
        "if(/^\\d+(秒|分钟|小时|天|周|月|年)前/.test(t))continue;"
        "if(t.indexOf('·')>=0&&/\\d/.test(t))continue;"
        # 🔴 真机（2026-09-21）：行处于「回复中」时会多出一个「回复@某人」元素，
        #    它比评论正文长，会被下面「取最长候选」选中 -> bodyText 变成「回复@xxx」
        #    -> rowMatches 的正文比对失败 -> 报 reply_row_mismatch，
        #    看起来像「编辑器认不出属于哪一行」，实际是正文提取被污染。
        #    实测该行 innerText：...求带学PR剪辑 / 回复中 / 回复@风卷残叶飘
        "if(/^回复@/.test(t))continue;"
        "if(noise.indexOf(t)>=0)continue;"
        "if(t.length>best.length)best=t;}"
        "return best||digits;}"
        # 目标匹配：正文必须一致；id 命中即可，否则要求作者链接一致
        "function rowMatches(row,t){"
        "if(t.text&&bodyText(row)!==t.text)return false;"
        "if(t.id&&(row.id===t.id||row.getAttribute('data-comment-id')===t.id))return true;"
        "if(!t.text)return false;"
        "if(!t.authorId)return true;"
        "var as=row.querySelectorAll('a[href]');"
        "for(var i=0;i<as.length;i++){var p='';"
        "try{p=new URL(as[i].getAttribute('href')||'',location.href).pathname.replace(/\\/$/,'');}catch(e){continue;}"
        "var n=(as[i].innerText||as[i].textContent||'').trim();"
        "if(p==='/user/'+t.authorId&&(!t.authorName||n===t.authorName))return true;}"
        "return false;}"
        "function replyingRow(){var rs=rows();"
        "var open=rs.filter(function(r){return (r.innerText||'').indexOf(" + json.dumps(S.COMMENT_REPLYING_TEXT) + ")>=0;});"
        "return open;}"
    )


def _target_json(target):
    return json.dumps({
        "id": str(target.get("id") or ""),
        "authorId": str(target.get("authorId") or ""),
        "authorName": str(target.get("authorName") or ""),
        "text": str(target.get("text") or ""),
    })


# --- 1) 「回复」按钮：先滚入视口，再读坐标 ---
#
# 🔴 判定口径必须只有一处（2026-09-21 评审）：采集阶段标注"这条能不能回"、
#    发送阶段决定"能不能点"，如果各写一套匹配逻辑，就会出现
#    "标注说可以回、发送却必被拒（或反过来）"的不一致 —— 宿主据此挑的目标全是废的。
#    所以下面把【行匹配 + 按钮查找】抽成共用片段，两处结论都从同一份判定里来：
#      matches      命中几条（>1 就是 ambiguous_comment，绝不能随便挑一条）
#      replyReady   唯一命中 且 回复按钮存在、可见、已在视口内
#      reason       与发送阶段的拒绝原因【同一个枚举】
_REPLY_BUTTON_LOOKUP_JS = (
    "function replyButtonIn(row){"
    "var all=row.querySelectorAll('span,div,button,[role=button]');"
    "for(var i=0;i<all.length;i++){var e=all[i];"
    "if(e.children&&e.children.length>0)continue;"
    "var s=(e.innerText||e.textContent||'').replace(/\\s+/g,'').trim();"
    "if(s!==" + json.dumps(S.COMMENT_REPLY_BUTTON_TEXT) + ")continue;"
    "if(!vis(e))continue;return e;}"
    "return null;}"
)

_REPLY_BUTTON_JS = (
    "(function(t){" + _row_helpers_js() + _REPLY_BUTTON_LOOKUP_JS +
    "var rs=rows();"
    "var hits=rs.filter(function(r){return rowMatches(r,t);});"
    "if(hits.length!==1)return {found:false,count:hits.length,"
    "reason:hits.length?'ambiguous_comment':'comment_not_found'};"
    "var row=hits[0];"
    "var btn=replyButtonIn(row);"
    "if(!btn)return {found:false,count:1,reason:'reply_button_not_found'};"
    "if(!inView(btn)){row.scrollIntoView({block:'center'});"
    "return {found:false,count:1,reason:'scrolled_into_view'};}"
    "var r=btn.getBoundingClientRect();"
    "return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),tag:btn.tagName};})(TARGET)"
)


def comment_reply_button(cdp, target, attempts=4, settle=1.2):
    """定位目标评论的「回复」按钮，必要时先滚入视口再重读坐标。

    为什么必须重试：评论在虚拟列表里，出视口的行坐标是负的
    （真机实测某行「回复」按钮 y=-1415）。直接按坐标点会点到别处。
    legacy reply_worker.js 的既有做法就是 scrollIntoView -> 等重渲染 -> 再读一次。
    """
    expression = _REPLY_BUTTON_JS.replace("TARGET", _target_json(target))
    result = {"found": False, "reason": "not_attempted"}
    for _ in range(max(1, attempts)):
        result = cdp.eval_json(expression) or {"found": False, "reason": "eval_failed"}
        if result.get("found"):
            return result
        if result.get("reason") != "scrolled_into_view":
            return result
        time.sleep(settle)
    return result


# --- 2) 行内回复编辑器：在含「回复中」的那一项内取唯一的 [contenteditable] ---
_REPLY_COMPOSER_JS = (
    "(function(t){" + _row_helpers_js() +
    "var open=replyingRow();"
    "if(open.length!==1)return {found:false,count:open.length,"
    "reason:open.length?'ambiguous_reply_open':'reply_not_open'};"
    "var row=open[0];"
    "if(!rowMatches(row,t))return {found:false,count:1,reason:'reply_row_mismatch'};"
    "var eds=Array.from(row.querySelectorAll(" + json.dumps(S.COMMENT_REPLY_EDITOR_SELECTOR) + ")).filter(vis);"
    "if(eds.length!==1)return {found:false,count:eds.length,"
    "reason:eds.length?'ambiguous_reply_editor':'reply_editor_not_found'};"
    "var e=eds[0],r=e.getBoundingClientRect();"
    "return {found:true,scope:'reply',rowId:row.id||row.getAttribute('data-comment-id')||'',"
    "x:Math.round(r.x+Math.min(80,Math.max(20,r.width/2))),y:Math.round(r.y+r.height/2),"
    "text:(e.innerText||'').replace(/\\u200b/g,'')};})(TARGET)"
)


# 目标行【此刻】的回复可用性：只读、不滚动、不点击。
# 分类与 comment_reply_button 完全一致（同一个 reason 枚举），所以"标注"与"发送"不会互相打脸：
#   present       行是否命中（唯一或歧义都算命中）
#   matches       命中条数
#   replyReady    唯一命中 且 回复按钮存在、可见、已在视口内 -> 发送阶段可以直接点
#   reason        '' | comment_not_found | ambiguous_comment | reply_button_not_found | needs_scroll
_ROW_PRESENT_JS = (
    "(function(t){" + _row_helpers_js() + _REPLY_BUTTON_LOOKUP_JS +
    "var rs=rows();"
    "var hits=rs.filter(function(r){return rowMatches(r,t);});"
    "if(hits.length===0)return {present:false,matches:0,total:rs.length,replyReady:false,"
    "reason:'comment_not_found'};"
    "if(hits.length>1)return {present:true,matches:hits.length,total:rs.length,replyReady:false,"
    "reason:'ambiguous_comment'};"
    "var row=hits[0];"
    "var btn=replyButtonIn(row);"
    "if(!btn)return {present:true,matches:1,total:rs.length,replyReady:false,"
    "reason:'reply_button_not_found'};"
    "if(!inView(btn))return {present:true,matches:1,total:rs.length,replyReady:false,"
    "reason:'needs_scroll'};"
    "return {present:true,matches:1,total:rs.length,replyReady:true,reason:''};})(TARGET)"
)


def comment_row_present(cdp, target):
    """目标行【此刻】的回复可用性分类（采集标注与发送判定共用这一份结论）。

    返回：{present, matches, total, replyReady, reason}
      present      行是否命中（唯一或歧义都算命中）
      matches      命中条数（>1 = 歧义，绝不能随便挑一条去点）
      replyReady   唯一命中 且 回复按钮存在、可见、已在视口内 —— 发送阶段可直接点击
      reason       与 comment_reply_button 同一枚举：
                   '' | comment_not_found | ambiguous_comment | reply_button_not_found | needs_scroll

    🔴 为什么必须同源（2026-09-21 评审）：采集走接口、回复走 DOM，两个集合本来就不重合；
       如果"标注能不能回"和"实际能不能点"各写一套判断，就会出现
       "标注 visible=true、发送却必被拒"（例如目标行有两条相同内容 -> 歧义），
       宿主据此挑出来的候选全是废的。现在两边共用 replyButtonIn + 同一套 reason。

    🔴 为什么采集阶段就需要它（真机 2026-09-21）：
       采集走接口（/aweme/v1/web/comment/list/），一次能拿 100~200 条；
       回复走 DOM，页面只渲染几十条。两个集合【不重合】。
       采集到的目标很可能压根不在页面上，回复时必然失败 ——
       而失败发生在「点不到」这一步，看起来像定位器坏了，其实是目标够不到。
       所以采集时就标出哪些【当前可见】，让宿主只挑可见的，
       而不是先选一个再反复重试。
    只读、不滚动、不点击，因此可以安全地对多条候选调用。
    """
    return cdp.eval_json(_ROW_PRESENT_JS.replace("TARGET", _target_json(target))) \
        or {"present": False}


def comment_reply_composer(cdp, target):
    """Find exactly one editor inside the confirmed target comment row."""
    return cdp.eval_json(_REPLY_COMPOSER_JS.replace("TARGET", _target_json(target))) or {"found": False}


# --- 3) 发送键：编辑器右侧操作区里 path 填充为品牌红的那个图标（激活态） ---
_REPLY_SEND_JS = (
    "(function(t){" + _row_helpers_js() +
    "var open=replyingRow();"
    "if(open.length!==1)return {found:false,count:open.length,"
    "reason:open.length?'ambiguous_reply_open':'reply_not_open'};"
    "var row=open[0];"
    "if(!rowMatches(row,t))return {found:false,count:1,reason:'reply_row_mismatch'};"
    "var ct=row.querySelector(" + json.dumps(S.COMMENT_INPUT_RIGHT_CT) + ");"
    "if(!ct)return {found:false,count:0,reason:'comment_input_right_not_found'};"
    "var cands=Array.from(ct.querySelectorAll('span,div,svg'));"
    "var best=null;"
    "for(var i=0;i<cands.length;i++){var e=cands[i];"
    "if(!vis(e))continue;"
    "var ps=Array.from(e.querySelectorAll('path'));"
    "var active=false;"
    "for(var j=0;j<ps.length;j++){"
    "if(getComputedStyle(ps[j]).fill===" + json.dumps(S.COMMENT_SEND_ACTIVE_FILL) + "){active=true;break;}}"
    "if(!active)continue;"
    "var r=e.getBoundingClientRect();"
    # ⚠️ 取【面积最小】的那个，不能取最右。
    #    原因：外层 div 也包含同一个红色 path，同样"是激活的"，
    #    而它的中心点落在图标【外面】—— 按最右选中它会点空
    #    （真机与夹具都会踩，测试已抓到）。
    "var area=r.width*r.height;"
    "if(!best||area<best.area)best={area:area,"
    "x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};}"
    "if(!best)return {found:false,count:0,reason:'send_button_inactive'};"
    "return {found:true,active:true,x:best.x,y:best.y};})(TARGET)"
)


def comment_reply_send_button(cdp, target):
    """发送键是否处于【激活】态，以及它的坐标。

    ⚠️ 语义与旧实现不同：旧实现返回的是"元素存在且未 disabled（DOM 属性）"，
    真机上发送键是 <svg>，没有 disabled 属性 —— 那个判据永远为假。
    现在的判据是【颜色】：内容为空时它不显示品牌红，因此
    "空内容不发送"这道保护是自动获得的，不需要额外判断。
    """
    return cdp.eval_json(_REPLY_SEND_JS.replace("TARGET", _target_json(target))) or {"found": False}


# ===================== 导航 =====================

def profile_url(sec_uid):
    return "https://www.douyin.com/user/%s" % sec_uid


def video_url(aweme_id):
    return "https://www.douyin.com/video/%s" % aweme_id


def wait_comment_panel(cdp, timeout=25):
    """等评论区真正可见。节点存在不等于面板已展开——隐藏时容器 display:none。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if comment_panel_visible(cdp):
            return True
        time.sleep(1.2)
    return False


def make_network_recorder(cdp, url_mark):
    if callable(url_mark):
        return NetworkRecorder(cdp, url_mark)
    mark = str(url_mark or "")
    return NetworkRecorder(cdp, lambda u: bool(mark) and mark in (u or ""))