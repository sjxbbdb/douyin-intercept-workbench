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
import time

import cdp as cdpmod
from cdp import NetworkRecorder
import dyselectors as S


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


def _cookie_names(cdp):
    """拿本站 cookie 名集合。Network 域没开时返回 None（而不是抛错）。

    为什么不用 document.cookie：sessionid / sid_tt 都是 HttpOnly，
    JS 读不到——用它们判登录态反而会得到"永远未登录"的假信号。
    """
    try:
        res = cdp.call("Network.getCookies", {"urls": ["https://www.douyin.com"]}, timeout=10)
    except Exception:
        return None
    return {c.get("name") for c in (res.get("cookies") or [])}


LOGIN_COOKIE_MARKS = ("sessionid", "sessionid_ss", "sid_tt", "sid_guard")


def check_login_required(cdp):
    """是否未登录。

    🔴 真机教训（原实现是错的）：原来只看正文里有没有「扫码登录|登录后」，
       结果搜索页一条视频简介写着"一旦退出登录后，再次登录就要验证手机号"——
       正文命中「登录后」，于是【明明登录着却判定为未登录】。
       这和验证码那个误判是同一类 bug：拿正文关键词当状态机。

    判定顺序：
      1) cookie：有 sessionid/sid_tt 等 -> 已登录（权威）
      2) cookie 拿不到时，才回退到「可见的扫码登录弹窗」DOM（不是正文关键词）
    """
    names = _cookie_names(cdp)
    if names is not None:
        return not any(m in names for m in LOGIN_COOKIE_MARKS)
    return bool(cdp.eval_json(
        "(function(){var sels=" + json.dumps(S.LOGIN_MODAL_DOM) + ";"
        "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
        " for(var j=0;j<ns.length;j++){var r=ns[j].getBoundingClientRect();"
        "  if(r.width>0&&r.height>0) return true;}}"
        "return false;})()"
    ))


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


def ensure_visible(cdp, log=None):
    """尽力把页面变成 visible。返回是否成功。不改变任何平台侧状态。"""
    if visibility_state(cdp) == "visible":
        return True
    try:
        cdp.call("Page.bringToFront", {}, timeout=5)
    except Exception:
        pass
    time.sleep(1.0)
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
    for _ in range(rounds):
        rect = comment_panel_rect(cdp) or {}
        vw = cdp.eval_json("(function(){return {w:window.innerWidth,h:window.innerHeight};})()") or {}
        w, h = int(vw.get("w") or 1680), int(vw.get("h") or 876)
        if rect:
            x = min(max(rect["x"] + rect["width"] // 2, 20), w - 20)
            y = min(max(rect["y"] + rect["height"] // 2, 60), h - 60)
        else:
            x, y = w - 200, h // 2
        via = scroll_by(cdp, dy=dy, x=x, y=y)
        try:
            info = cdp.eval_json(_COMMENT_SCROLL_JS) or {}
        except Exception:
            info = {}
        info["wheel"] = via
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


def dm_entry(cdp):
    """探测「私信」入口。

    ⚠️ 这是整个方案的关键未知数：企业号在网页端能否私信未互关用户。
    本函数只做【只读探测】，不点击、不发送。
    """
    return cdp.eval_json(_DM_ENTRY_JS) or {"found": False, "blocked": False, "reason": "eval_failed"}


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
    return NetworkRecorder(cdp, lambda u: url_mark in (u or ""))