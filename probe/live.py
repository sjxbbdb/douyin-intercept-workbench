"""直播间弹幕适配：页面内存（首选，带用户标识）+ DOM 只读（兜底），以及「回复弹幕」的定位器。

真机结论（2026-09-19，两个真实直播间，详见 06-直播间截流私信.md）
------------------------------------------------------------------
* 采集能跑：60 秒 56 条弹幕 / 49 个不同昵称，礼物与进场噪音被正确过滤。
* **弹幕 DOM 文本里没有任何用户标识**：没有 data-sec-uid / data-user-id，也没有 a[href]。
  只读 DOM 的标识完整率 = 0.0%。
* 🔴 **页面内存里有**：弹幕虚拟列表组件的 React fiber props 挂着 originalList（消息数组），
  每条 WebcastChatMessage 的 payload.user 里有 sec_uid / nickname。改从那里取之后，
  实测标识完整率 100%（见 FEED_JS）。所以「直播间 → 私信」是闭环的。
* 边界：这是读**页面自己已经拿到的数据**（与读 innerText 同一性质），
  不是解码/重放长连接数据帧，不是伪造签名，也不直调内部接口。
  代价是 React 内部结构会随平台构建变化 —— 所以 DOM 文本采集保留为兜底。
* 「回复弹幕」：**原生入口存在，走它**（2026-09-20 更正）。
  早期结论（全页 hover 扫描「回复」类元素恒为 0）是扫描方式的问题：入口不在 hover 上，
  而是【点击弹幕正文】才弹出的浮层菜单（portal 到 body 的 ul.semi-dropdown-menu[role=menu]），
  菜单项含「资料卡」/「回复 TA」。点「回复 TA」后由平台插入真实 @提及。
  实现见 open_reply_menu / choose_reply_menu_item / composer_mention 与
  send_actions.send_danmaku_reply_native；@纯文本（send_danmaku_reply）保留为兜底通道。
  两条通道发出前都必须先在屏上定位到那条弹幕（唯一命中 + 未被遮挡），否则一律拒绝发送。
"""
import json
import re
import time
from urllib.parse import parse_qs, urlsplit

import click_guard
import douyin_selectors as S


# 房间号可能出现在路径（/423909340168）或查询串（?live_web_rid=423909340168）里。
LIVE_RID_KEYS = ("live_web_rid", "web_rid", "room_id", "rid")
LIVE_RID_RE = re.compile(r"^[0-9]{3,20}$")
# 抖音用户的真实主页标识（sec_uid）形如 MS4wLjABAAAA…。
SEC_UID_RE = re.compile(r"^MS4wLjABAAAA[A-Za-z0-9_\-]{8,}$")


def dm_capable(sec_uid, uid=""):
    """这条弹幕的作者能不能用来私信。

    🔴 真机事实（2026-09-20，两个真实直播间对比，房间号 689015985670 vs 423909340168）：
      · 有的房间 16/16 条弹幕都带真实 sec_uid，可以直接打开对方主页私信；
      · 有的房间观众行的 sec_uid 为空、uid 是占位值 111111、昵称已脱敏，
        只有主播自己的消息带 sec_uid —— 平台没有把观众身份给到页面。
    占位 uid 拼出来的 /user/<uid> 是错误页（data-e2e=error-page），
    所以这里宁可判"不可私信"，也不能拿数字 uid 去拼主页。
    """
    if SEC_UID_RE.match(str(sec_uid or "").strip()):
        return True
    return False


def room_id_from_url(url):
    """从直播间 URL 里取出房间号；取不到返回空串。

    🔴 真机事实（2026-09-20）：用户从抖音直播广场点进房间时，地址栏是
    https://live.douyin.com/?anchor_id=...&live_web_rid=423909340168&page_type=...
    —— 房间号在【查询串】里，路径是空的。只按路径解析会得到空字符串，
    后果是 target.roomId 直接校验失败（path is required），一条回复都发不出去。
    """
    try:
        parsed = urlsplit(str(url or "").strip())
    except ValueError:
        return ""
    if (parsed.hostname or "").lower() != "live.douyin.com":
        return ""
    path = (parsed.path or "").strip("/")
    if LIVE_RID_RE.match(path):
        return path
    try:
        query = parse_qs(parsed.query)
    except ValueError:
        return ""
    for key in LIVE_RID_KEYS:
        for value in query.get(key, []):
            if LIVE_RID_RE.match(str(value or "").strip()):
                return str(value).strip()
    return ""


def current_room_url(cdp):
    """当前标签页的规范直播间 URL：https://live.douyin.com/<房间号>；识别不了返回空串。

    为什么需要它：广场式地址（房间号在查询串）不能直接当 roomId 用，
    也不能用 split("?")[0] —— 那会得到 https://live.douyin.com/ （没有房间号），
    发送前的 URL 绑定校验必然失败。
    """
    try:
        here = cdp.evaluate("location.href") or ""
    except Exception:
        return ""
    rid = room_id_from_url(here)
    return "https://live.douyin.com/%s" % rid if rid else ""


def _js_array(values):
    return json.dumps(list(values), ensure_ascii=False)


# ===================== 数据源①：页面内存里的弹幕数据模型（首选） =====================

FEED_JS = (
    "(function(){"
    "function fiberOf(el){var ks=Object.keys(el);for(var i=0;i<ks.length;i++){"
    "if(ks[i].indexOf('__reactFiber$')===0)return el[ks[i]];}return null;}"
    "function propsOf(f){try{return f.memoizedProps||null;}catch(e){return null;}}"
    "var list=null;"
    "var rows=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_ROW_ANY) + ");"
    "for(var i=0;i<rows.length&&!list;i++){var f=fiberOf(rows[i]);var lvl=0;"
    "while(f&&lvl<" + str(int(S.LIVE_CHAT_FEED_MAX_HOPS)) + "){var p=propsOf(f);"
    "if(p&&p.originalList){list=p.originalList;break;}f=f.return;lvl++;}}"
    "if(!list)return {ok:false,reason:'no_originalList'};"
    "var arr=null;"
    "if(Array.isArray(list))arr=list;"
    "else if(typeof list.toJS==='function'){try{arr=list.toJS();}catch(e){}}"
    "else if(typeof list.toArray==='function'){try{arr=list.toArray();}catch(e){}}"
    "else if(typeof list.size==='number'){arr=[];"
    "for(var q=0;q<list.size;q++){try{arr.push(list.get(q));}catch(e){}}}"
    "if(!arr)return {ok:false,reason:'list_not_convertible'};"
    "var out=[],kinds={};"
    "for(var j=0;j<arr.length;j++){var it=arr[j];if(!it)continue;"
    "var m=String(it.method||'');kinds[m]=(kinds[m]||0)+1;"
    "if(m!=='WebcastChatMessage')continue;"
    "var pl=it.payload||{};var u=pl.user||{};"
    "var text=String(pl.content==null?'':pl.content);"
    "if(!text)continue;"
    "out.push({id:String(it.msg_id||(pl.common&&pl.common.msg_id)||''),"
    "sec_uid:String(u.sec_uid||''),uid:String(u.id||''),"
    "authorName:String(u.nickname||u.desensitized_nickname||''),text:text,"
    "atMs:Number(pl.event_time||0)*1000,"
    "roomId:String((pl.common&&pl.common.room_id)||''),"
    "userFlags:{private:Number(u.webcast_private||u.secret||0),"
    "ichatRestrict:Number(u.ichat_restrict_type||0),"
    "disableIchat:Number(u.disable_ichat||0),"
    "blockStatus:Number(u.block_status||0),"
    "anonymous:!!u.is_anonymous,mystery:Number(u.mystery_man||0),"
    "canceled:!!u.user_canceled}});}"
    "return {ok:true,count:out.length,kinds:kinds,rows:out};"
    "})()"
)


def collect_feed(cdp):
    """读页面内存里的弹幕数据模型。返回 {ok, rows, kinds, reason}。"""
    snap = cdp.eval_json(FEED_JS)
    if not isinstance(snap, dict):
        return {"ok": False, "rows": [], "reason": "eval_failed"}
    return snap


# ===================== 数据源②：弹幕行的 DOM 只读采集（兜底，无用户标识） =====================

COLLECT_JS = (
    "(function(){"
    "var SEL=" + _js_array(S.LIVE_CHAT_NODE_SELECTORS) + ";"
    "var AUTHOR_SEL=" + _js_array(S.LIVE_CHAT_AUTHOR_NODES) + ";"
    "var CONTENT_SEL=" + _js_array(S.LIVE_CHAT_CONTENT_NODES) + ";"
    "var KEY_ATTRS=" + _js_array(S.LIVE_ROW_KEY_ATTRS) + ";"
    "var NICK_MAX=" + str(int(S.LIVE_NICK_MAX)) + ",TEXT_MAX=" + str(int(S.LIVE_TEXT_MAX)) + ";"
    "var NICK_FALLBACK=new RegExp(" + json.dumps(S.LIVE_NICK_FALLBACK_RE) + ");"
    "var NOISE_TEXT=new RegExp(" + json.dumps(S.LIVE_NOISE_TEXT_RE) + ");"
    "var NOISE_NICK=new RegExp(" + json.dumps(S.LIVE_NOISE_NICK_RE) + ");"
    "function textOf(el){return String((el&&(el.innerText||el.textContent))||'')"
    ".replace(/\\u00a0/g,' ').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();}"
    "function first(el,sels){for(var i=0;i<sels.length;i++){var n=el.querySelector(sels[i]);if(n)return n;}return null;}"
    "function attrOf(el,names){for(var i=0;i<names.length;i++){var v=el.getAttribute(names[i]);if(v)return v;}return '';}"
    "function visible(el){if(!el)return false;var r=el.getBoundingClientRect();"
    "if(!r.width||!r.height)return false;"
    "if(r.bottom<0||r.top>(window.innerHeight||0))return false;"
    "var s=getComputedStyle(el);"
    "return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}"
    "function onTop(el){try{var r=el.getBoundingClientRect();"
    "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);"
    "var h=document.elementFromPoint(x,y);"
    "return !!(h&&(el===h||el.contains(h)||h.contains(el)));}catch(e){return false;}}"
    "function getLines(el){var raw=String((el&&(el.innerText||el.textContent))||'').split(/\\n+/);"
    "var out=[];for(var i=0;i<raw.length;i++){"
    "var v=raw[i].replace(/\\u00a0/g,' ').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();"
    "if(v&&out.indexOf(v)<0)out.push(v);}return out;}"
    "function isNoiseText(t){if(NOISE_TEXT.test(t))return true;"
    "var k=Math.max(t.lastIndexOf('：'),t.lastIndexOf(':'));"
    "return k>=0&&NOISE_TEXT.test(t.slice(k+1).replace(/^\\s+/,''));}"
    "function parseRow(el){"
    "var user='',text='';"
    "var contentNode=first(el,CONTENT_SEL);"
    "if(contentNode)text=textOf(contentNode);"
    "var spans=el.querySelectorAll('span');"
    "for(var i=0;i<spans.length;i++){var sp=spans[i];"
    "if(sp.querySelector('span'))continue;"
    "if(contentNode&&(sp===contentNode||contentNode.contains(sp)))continue;"
    "var t=textOf(sp);if(/[:：]$/.test(t)){user=t.slice(0,-1).trim();break;}}"
    "if(!user){var authorNode=first(el,AUTHOR_SEL);if(authorNode)user=textOf(authorNode).replace(/^@/,'').trim();}"
    "if(!user||!text){var lines=getLines(el);"
    "if(lines.length===1){var m=lines[0].match(NICK_FALLBACK);if(m)lines=[m[1].trim(),m[2].trim()];}"
    "if(lines.length<2)return {why:'one_line'};"
    "if(!user)user=lines[0].replace(/^@/,'').trim();"
    "if(!text)text=lines.slice(1).join(' ').trim();}"
    "if(!user||!text)return {why:'empty'};"
    "if(user.length>NICK_MAX||text.length>TEXT_MAX)return {why:'shape'};"
    "if(isNoiseText(text))return {why:'noise_text'};"
    "if(NOISE_NICK.test(user))return {why:'noise_nick'};"
    "var key=attrOf(el,KEY_ATTRS)||el.id||'';"
    "if(!key)key=(user+'|'+text).slice(0,120);"
    "return {row:{id:key,authorName:user,text:text}};}"
    "var nodes=[],seen=[];"
    "for(var s=0;s<SEL.length;s++){var found=[];"
    "try{found=Array.prototype.slice.call(document.querySelectorAll(SEL[s]));}catch(e){continue;}"
    "for(var i=0;i<found.length;i++){if(seen.indexOf(found[i])<0){seen.push(found[i]);nodes.push(found[i]);}}}"
    "var vis=[];for(var j=0;j<nodes.length;j++){if(visible(nodes[j]))vis.push(nodes[j]);}"
    "var accepted=[],noiseEls=[],stats={candidates:nodes.length,visible:vis.length,parsed:0,"
    "drop_ancestor:0,covered:0,drop_noise:0,drop_other:0};"
    "for(var k=0;k<vis.length;k++){var got=parseRow(vis[k]);"
    "if(got.row){accepted.push({el:vis[k],row:got.row});continue;}"
    "if(got.why==='noise_text'||got.why==='noise_nick'){stats.drop_noise++;noiseEls.push(vis[k]);}"
    "else stats.drop_other++;}"
    "stats.parsed=accepted.length;"
    "var rows=[],seenKey={};"
    "for(var a=0;a<accepted.length;a++){var isAncestor=false;"
    "for(var b=0;b<accepted.length;b++){if(a===b)continue;"
    "if(accepted[a].el.contains(accepted[b].el)){isAncestor=true;break;}}"
    "if(!isAncestor){for(var c=0;c<noiseEls.length;c++){"
    "if(accepted[a].el.contains(noiseEls[c])){isAncestor=true;break;}}}"
    "if(isAncestor){stats.drop_ancestor++;continue;}"
    "var row=accepted[a].row;"
    "if(seenKey[row.id]){continue;}seenKey[row.id]=true;"
    "row.onTop=onTop(accepted[a].el);row.source='dom';"
    "rows.push(row);}"
    "return {rows:rows,diagnostics:stats};"
    "})()"
)


def collect_dom(cdp, max_items=100):
    """DOM 兜底采集。行形状与页面内存采集保持一致，但 authorId 一律为空。"""
    snap = cdp.eval_json(COLLECT_JS) or {}
    rows = snap.get("rows") if isinstance(snap, dict) else None
    out = []
    for row in (rows or [])[:int(max_items)]:
        if not row.get("text"):
            continue
        out.append({
            "id": row.get("id") or "",
            # DOM 行内没有 data-sec-uid / data-user-id，也没有 a[href]：
            # 拿不到就留空，绝不用昵称冒充用户标识（否则私信会发错人）。
            "authorId": "",
            "authorName": row.get("authorName") or "",
            "text": row.get("text") or "",
            "atMs": 0,
            "roomId": "",
            "userFlags": {},
            "onTop": bool(row.get("onTop")),
            "source": "dom",
        })
    return out


def collect_events(cdp, max_items=100):
    """一轮采集：优先页面内存（每条都带 sec_uid），不可用时退回 DOM 文本。

    返回值即宿主事件行的字段来源（sidecar._event 读 authorId/authorName/text/id）。
    """
    feed = collect_feed(cdp)
    if feed.get("ok") and feed.get("rows"):
        rows = []
        for row in feed["rows"][-int(max_items):]:
            rows.append({
                "id": row.get("id") or "",
                "authorId": row.get("sec_uid") or row.get("uid") or "",
                "authorName": row.get("authorName") or "",
                "text": row.get("text") or "",
                "atMs": row.get("atMs") or 0,
                "roomId": row.get("roomId") or "",
                "userFlags": row.get("userFlags") or {},
                "source": "page_memory",
                # 身份可见性：sec_uid 才是能打开主页的标识；占位 uid（111111）不行。
                "uid": row.get("uid") or "",
                "dmCapable": dm_capable(row.get("sec_uid"), row.get("uid")),
            })
        if rows:
            return rows
    return collect_dom(cdp, max_items)


# ===================== 定位某一条弹幕（「回复弹幕」的前提） =====================

FIND_DANMAKU_JS = (
    "(function(target){"
    "var ROW_SEL=" + json.dumps(S.LIVE_CHAT_ROW) + ";"
    "var CONTENT_SEL=" + json.dumps(S.LIVE_CHAT_CONTENT) + ";"
    "function vis(e){if(!e)return false;var r=e.getBoundingClientRect();"
    "if(!r.width||!r.height)return false;"
    "if(r.bottom<0||r.top>(window.innerHeight||0))return false;"
    "var s=getComputedStyle(e);"
    "return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}"
    "function onTop(e){try{var r=e.getBoundingClientRect();"
    "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);"
    "var h=document.elementFromPoint(x,y);"
    "return !!(h&&(e===h||e.contains(h)||h.contains(e)));}catch(e){return false;}}"
    "function norm(t){return String(t==null?'':t)"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\[[^\\[\\]]{1,10}\\]/g,'')"
    ".replace(/[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{2BFF}\\u{FE00}-\\u{FE0F}]/gu,'')"
    ".replace(/\\s+/g,'')"
    # 🔴 真机教训（2026-09-20）：平台会把过长的弹幕在列表里截断（"主播优秀优秀……"），
    #    而页面内存里是【完整正文】。原来要求两侧完全相等，长弹幕就永远定位不到
    #    （对外表现为 danmaku_not_found_in_list，看起来像"弹幕消失了"）。
    ".replace(/[.\\u2026]+$/,'').trim();}"
    # 宽容匹配：完全相同，或一方是另一方的前缀（截断）。前缀必须有足够长度，
    # 否则"好"这种短文本会匹配一大片行，点击就变成碰运气。
    "function textMatch(dom,want){var min=6;"
    "if(dom===want)return 'exact';"
    "if(!dom||!want)return '';"
    "if(dom.length>=min&&want.length>dom.length&&want.indexOf(dom)===0)return 'dom_truncated';"
    "if(want.length>=min&&dom.length>want.length&&dom.indexOf(want)===0)return 'target_prefix';"
    "return '';}"
    "function authorOf(row){var spans=row.querySelectorAll('span');"
    "for(var i=0;i<spans.length;i++){var sp=spans[i];if(sp.querySelector('span'))continue;"
    "var t=String(sp.innerText||sp.textContent||'')"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'').replace(/\\s+/g,' ').trim();"
    "if(/[:：]$/.test(t))return t.slice(0,-1).trim();}return '';}"
    "function contentOf(row){var node=row.querySelector(CONTENT_SEL);"
    "return node?String(node.innerText||node.textContent||''):'';}"
    "var wantText=norm(target.text),wantAuthor=String(target.authorName||'').trim(),matchedBy='';"
    "var rows=document.querySelectorAll(ROW_SEL),hits=[];"
    "for(var i=0;i<rows.length;i++){var el=rows[i];"
    "if(!vis(el))continue;"
    "if(!wantText)continue;"
    "var matched=textMatch(norm(contentOf(el)),wantText);"
    "if(!matched)continue;"
    "var author=authorOf(el);"
    "if(wantAuthor&&author!==wantAuthor&&author.indexOf(wantAuthor)<0)continue;"
    "var r=el.getBoundingClientRect();"
    "matchedBy=matched;"
    "hits.push({el:el,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}"
    "if(!hits.length)return {ok:false,count:0,reason:'danmaku_not_found'};"
    "if(hits.length>1)return {ok:false,count:hits.length,reason:'danmaku_ambiguous'};"
    "var hit=hits[0],top=onTop(hit.el);"
    "return {ok:true,count:1,onTop:top,x:hit.x,y:hit.y,matchedBy:matchedBy,"
    "reason:top?'':'danmaku_covered'};"
    "})"
)


def find_danmaku(cdp, target):
    """在屏上定位一条弹幕：唯一命中且未被遮挡才算找到。

    找不到 / 命中多条 / 被面板盖住都返回 ok=False —— 宁可拒发，也不要把 @ 认错人。
    """
    expression = "(%s)(%s)" % (FIND_DANMAKU_JS, json.dumps({
        "authorName": str((target or {}).get("authorName") or ""),
        "text": str((target or {}).get("text") or ""),
    }, ensure_ascii=False))
    found = cdp.eval_json(expression)
    if not isinstance(found, dict):
        return {"ok": False, "reason": "danmaku_lookup_failed"}
    return found


# ===================== 用户卡片（演示学到的入口） =====================
#
# 🔴 学自用户真机演示（2026-09-20 录制的交互序列）：
#   hover 弹幕行 (div.NkS2Invn) -> hover 昵称 (span.hts-live-text-user)
#   -> 页面新增 div.userMenuPanelShadowAnimation（用户卡片）
#   -> 点击昵称 -> 卡片内继续操作
#   也就是说：**昵称是入口**（不是我先前猜的"行内有个回复按钮"）。
# ⚠️ 卡片里的条目（回复 / 私信 / 关注…）尚未在真机上确认，因此这里只做到
#   "把卡片打开并把可点条目与坐标列出来"，由上层决定点哪一个；点不到就 fail-closed。

CARD_ROW_NICKNAME = 'span[class*="hts-live-text-user"]'
CARD_PANEL_SELECTORS = ['[class*="userMenuPanel"]', '[class*="UserCard"]', '[class*="userCard"]']

FIND_NICKNAME_JS = (
    "(function(target){"
    "var NICK=" + json.dumps(CARD_ROW_NICKNAME) + ";"
    "function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}"
    "function norm(t){return String(t==null?'':t)"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\[[^\\[\\]]{1,10}\\]/g,'').replace(/\\s+/g,'').trim();}"
    "var rows=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_ROW) + "),hits=[];"
    "for(var i=0;i<rows.length;i++){var el=rows[i];if(!vis(el))continue;"
    "var c=el.querySelector(" + json.dumps(S.LIVE_CHAT_CONTENT) + ");"
    "if(!c)continue;"
    "if(norm(c.innerText||c.textContent)!==norm(target.text))continue;"
    "var nick=el.querySelector(NICK);if(!nick)continue;"
    "if(target.authorName&&norm(nick.innerText||nick.textContent)!==norm(target.authorName))continue;"
    "var r=nick.getBoundingClientRect();"
    "hits.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}"
    "if(!hits.length)return {ok:false,reason:'nickname_not_found'};"
    "if(hits.length>1)return {ok:false,reason:'nickname_ambiguous',count:hits.length};"
    "return {ok:true,x:hits[0].x,y:hits[0].y};"
    "})"
)

CARD_JS = (
    "(function(){"
    "function cls(e){return String((e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className)||'');}"
    "function text(e){return String(e.innerText||e.textContent||'').replace(/[\\u200b]/g,'').replace(/\\s+/g,' ').trim();}"
    "var sels=" + json.dumps(CARD_PANEL_SELECTORS) + ",out=[];"
    "for(var s=0;s<sels.length;s++){var ps=document.querySelectorAll(sels[s]);"
    "for(var i=0;i<ps.length;i++){var p=ps[i],r=p.getBoundingClientRect(),st=getComputedStyle(p);"
    "if(st.visibility==='hidden'||st.display==='none'||r.width<30||r.height<30)continue;"
    "var items=[],nodes=p.querySelectorAll('*');"
    "for(var j=0;j<nodes.length&&items.length<25;j++){var e=nodes[j];"
    "if(e.children&&e.children.length>0)continue;"
    "var rr=e.getBoundingClientRect();if(rr.width<2||rr.height<2)continue;"
    "var t=text(e);if(!t)continue;"
    "items.push({text:t,label:(t.length<=14?t:'(len:'+t.length+')'),cls:cls(e).slice(0,40),"
    "x:Math.round(rr.x+rr.width/2),y:Math.round(rr.y+rr.height/2)});}"
    "out.push({sel:sels[s],cls:cls(p).slice(0,60),w:Math.round(r.width),h:Math.round(r.height),"
    "x:Math.round(r.x),y:Math.round(r.y),items:items});}}"
    "return out;})()"
)


def find_danmaku_nickname(cdp, target):
    """在屏上找到「那条弹幕的昵称」坐标（昵称是用户演示里的入口）。"""
    expression = "(%s)(%s)" % (FIND_NICKNAME_JS, json.dumps({
        "authorName": str((target or {}).get("authorName") or ""),
        "text": str((target or {}).get("text") or ""),
    }, ensure_ascii=False))
    found = cdp.eval_json(expression)
    if not isinstance(found, dict):
        return {"ok": False, "reason": "nickname_lookup_failed"}
    return found


def user_card_items(cdp):
    """列出当前【可见】用户卡片里的可点条目（文本 + 坐标）；没有可见卡片时返回空表。"""
    found = cdp.eval_json(CARD_JS)
    return found if isinstance(found, list) else []


def open_user_card(cdp, target, wait_seconds=4.0, interval=0.4):
    """悬停那条弹幕的昵称，等用户卡片出现，返回卡片里的可点条目。

    fail-closed：昵称找不到 / 卡片始终没出现，都返回 ok=False，绝不去猜一个坐标点。
    """
    placed = find_danmaku_nickname(cdp, target)
    if not placed.get("ok"):
        return {"ok": False, "reason": placed.get("reason") or "nickname_not_found"}
    x, y = int(placed["x"]), int(placed["y"])
    deadline = time.time() + float(wait_seconds)
    cards = []
    while True:
        for step in range(3):                       # 真人是移动过去的，不是瞬移
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mouseMoved", "x": x - 6 + step * 4, "y": y}, timeout=10)
            time.sleep(0.25)
        cards = user_card_items(cdp)
        if cards:
            break
        if time.time() >= deadline:
            return {"ok": False, "reason": "card_not_opened"}
        time.sleep(interval)
    return {"ok": True, "nickname": {"x": x, "y": y}, "cards": cards}


def user_card_action(card, label):
    """在卡片条目里找指定文案（例如「回复」「私信」），返回坐标；找不到返回 ok=False。"""
    want = str(label or "").strip()
    if not want:
        return {"ok": False, "reason": "label_required"}
    for item in (card or {}).get("items") or []:
        if str(item.get("text") or "").strip() == want:
            return {"ok": True, "x": item["x"], "y": item["y"], "text": want}
    return {"ok": False, "reason": "card_action_not_found", "label": want}


# 🔴 页面上存在【两个】class 含 webcast-chatroom___list 的容器：右侧主聊天列表，
#    以及顶部 y<200 的弹幕条。按 class 选会同时命中，曾经导致我点到顶部那条里的
#    "同名元素"，落点跑到了页面中部（头像/资料卡一带）。这里用几何特征挑主列表：
#    在右侧、宽度 250-420、高度 >=250、顶部 y>=150。
MAIN_CHAT_LIST_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}"
    "var lists=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_LIST) + "),best=null;"
    "var vw=window.innerWidth||0;"
    "for(var i=0;i<lists.length;i++){var l=lists[i];if(!vis(l))continue;"
    "var r=l.getBoundingClientRect();"
    "if(r.width<250||r.width>420)continue;"
    "if(r.height<250)continue;"
    "if(r.x<vw*0.55)continue;"
    "if(r.y<150)continue;"
    "if(!best||r.height>best.score){best={score:r.height,"
    "box:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],"
    "cls:String(l.className||'').slice(0,60)};}}"
    "return best?{found:true,box:best.box,cls:best.cls}"
    ":{found:false,reason:'main_chat_list_not_found'};})()"
)


def main_chat_list(cdp):
    """几何挑选【主聊天列表】：右侧、宽 250-420、高>=250、y>=150（排除顶部弹幕条）。"""
    found = cdp.eval_json(MAIN_CHAT_LIST_JS)
    if not isinstance(found, dict):
        return {"found": False, "reason": "main_chat_list_lookup_failed"}
    return found


# ===================== 聊天列表滚动（真机必需）=====================
#
# 为什么必须自己做滚动：直播间的弹幕列表【一直在自动滚动】，新弹幕不断从底部顶上来。
# 于是"量到坐标 -> 点击"之间那一行就位移了（实测：点到相邻行，甚至点到别人的提及）。
# 真人是怎么解决的：**往上滚一点，列表就脱离底部、自动滚动停止**，然后再点。
# 这里照做：pause_autoscroll() 上滚 + 校验尾部不再变化；找不到目标时再上滚找更早的弹幕。
CHAT_TAIL_JS = (
    "(function(box){"
    "function inBox(r,b){var t=2;""return r.x+t>=b[0]&&r.right-t<=b[0]+b[2]&&r.y+t>=b[1]&&r.bottom-t<=b[1]+b[3];}"
    "var lists=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_LIST) + "),rows=[];"
    "for(var L=0;L<lists.length;L++){var list=lists[L];"
    "var lr=list.getBoundingClientRect();if(!inBox(lr,box))continue;"
    "var ns=list.querySelectorAll(" + json.dumps(S.LIVE_CHAT_ROW) + ");"
    "for(var i=0;i<ns.length;i++){var el=ns[i];if(el.closest('[class*=\"bottom-message\"]'))continue;"
    "rows.push(el);}}"
    "if(!rows.length)return {ok:false,reason:'no_rows'};"
    "var last=rows[rows.length-1];"
    "var key=last.getAttribute('data-id')||'';"
    "if(!key){var c=last.querySelector(" + json.dumps(S.LIVE_CHAT_CONTENT) + ");"
    "key=String((c&&c.innerText)||'').replace(/\\s+/g,'').length+':'+String(last.innerText||'').length;}"
    "return {ok:true,key:key,count:rows.length};})()"
)


def chat_list_tail(cdp, box=None):
    """主聊天列表尾部的稳定标识（判断自动滚动是否停了）。"""
    if box is None:
        picked = main_chat_list(cdp)
        if not picked.get("found"):
            return {"ok": False, "reason": picked.get("reason")}
        box = picked["box"]
    found = cdp.eval_json("(%s)(%s)" % (CHAT_TAIL_JS, json.dumps(list(box))))
    return found if isinstance(found, dict) else {"ok": False, "reason": "tail_lookup_failed"}


def scroll_chat_list(cdp, direction="up", amount=420, times=1, box=None):
    """用【真实滚轮】在主聊天列表上滚动：up = 看更早的弹幕，down = 回到最新。"""
    if box is None:
        picked = main_chat_list(cdp)
        if not picked.get("found"):
            return {"ok": False, "reason": picked.get("reason") or "main_chat_list_not_found"}
        box = picked["box"]
    x, y, w, h = box
    cx, cy = int(x + w / 2), int(y + h / 2)
    delta = -abs(int(amount)) if str(direction) == "up" else abs(int(amount))
    for _ in range(max(1, int(times))):
        cdp.call("Input.dispatchMouseEvent",
                 {"type": "mouseWheel", "x": cx, "y": cy, "deltaX": 0, "deltaY": delta},
                 timeout=10)
        time.sleep(0.25)
    return {"ok": True, "box": list(box), "delta": delta * max(1, int(times))}


def pause_autoscroll(cdp, settle=1.3, box=None):
    """上滚一点让列表脱离底部（真人的做法），再用"尾部是否不再变化"验证。

    返回 {"ok": bool, "paused": bool, "before": str, "after": str}。
    paused 为 False 时调用方应谨慎（列表仍在动），但不会因此就乱点 —— 定位仍然带命中测试。
    """
    if box is None:
        picked = main_chat_list(cdp)
        if not picked.get("found"):
            return {"ok": False, "reason": picked.get("reason") or "main_chat_list_not_found"}
        box = picked["box"]
    before = chat_list_tail(cdp, box)
    scroll_chat_list(cdp, "up", 420, 1, box)
    time.sleep(settle)
    after = chat_list_tail(cdp, box)
    paused = bool(before.get("ok") and after.get("ok") and before.get("key") == after.get("key"))
    return {"ok": True, "paused": paused, "box": list(box),
            "before": before.get("key"), "after": after.get("key")}


def scroll_to_danmaku(cdp, target, max_steps=4, amount=420):
    """上滚查找目标弹幕（最多 max_steps 次），找到就返回坐标；否则 fail-closed。"""
    picked = main_chat_list(cdp)
    if not picked.get("found"):
        return {"ok": False, "reason": picked.get("reason") or "main_chat_list_not_found"}
    box = picked["box"]
    for step in range(max(1, int(max_steps))):
        found = find_danmaku_in_list(cdp, target, box=box)
        if found.get("ok"):
            found["scrolled"] = step
            return found
        scroll_chat_list(cdp, "up", amount, 1, box)
        time.sleep(0.5)
    return {"ok": False, "reason": "danmaku_not_found_after_scroll"}


# ===================== 按关键词命中弹幕 -> 准备回复 =====================
#
# 用户要的顺序：先滚动，再按关键词命中某条弹幕（-> 它的作者就是要回复的人），然后回复。
# 关键词匹配【复用评论链路同一套匹配器】（crawl.comment_matches：phrase/seg/all/any，
# 排除词优先），保证"直播间弹幕"和"视频评论"两条链路的筛选语义一致。

def match_danmaku(rows, keywords=None, exclude_keywords=None, mode="seg"):
    """按关键词过滤弹幕，返回 (命中的行, 统计)。命中的行会带上 matchedKeyword。"""
    import crawl as crawlmod

    def split(value):
        if isinstance(value, str):
            return crawlmod.split_keywords(value)
        return [str(item).strip() for item in (value or []) if str(item).strip()]

    want = split(keywords)
    exclude = split(exclude_keywords)
    if mode not in crawlmod.MATCH_MODES:
        raise ValueError("matchMode must be one of %s" % ", ".join(crawlmod.MATCH_MODES))
    stats = {"total": len(rows or []), "matched": 0, "missed": 0, "excluded": 0,
             "keywords": want, "excludeKeywords": exclude, "mode": mode}
    matched = []
    for row in rows or []:
        text = str(row.get("text") or "")
        if not want and not exclude:
            stats["matched"] += 1
            matched.append(dict(row))
            continue
        hit = crawlmod.comment_matches(text, want, mode)
        if hit is None:
            stats["missed"] += 1
            continue
        source = crawlmod.normalize_search_text(text)
        if any(crawlmod.normalize_search_text(word) and
               crawlmod.normalize_search_text(word) in source for word in exclude):
            stats["excluded"] += 1
            continue
        stats["matched"] += 1
        row = dict(row)
        row["matchedKeyword"] = hit
        matched.append(row)
    return matched, stats


def collect_and_match(cdp, keywords=None, exclude_keywords=None, mode="seg",
                      max_items=80, scroll_steps=0):
    """采一轮弹幕 -> 按关键词命中；可选先上滚 scroll_steps 次以看到更早的弹幕。"""
    if scroll_steps:
        scroll_chat_list(cdp, "up", 420, scroll_steps)
        time.sleep(0.6)
    rows = collect_events(cdp, max_items=max_items)
    matched, stats = match_danmaku(rows, keywords, exclude_keywords, mode)
    return matched, stats


def pick_reply_target(cdp, matched, box=None):
    """从命中的弹幕里挑一条【当前就能定位到】的作为回复目标（新 -> 旧）。

    为什么要挑"能定位到的"：命中的弹幕可能早就滚出可视区（尤其是我们为了看更早的
    弹幕而上滚之后，最新那条反而到了屏幕下方）。回复只能对着屏上那条做，
    所以先按时间倒序逐个验证可见性，全都不可见时再由调用方决定是否滚动查找。
    """
    # 没有主列表矩形就退化成全页搜索，会命中页面顶部那条弹幕条（真机实测），所以先要矩形。
    if box is None:
        box = main_list_box(cdp)
    if not box:
        return {"ok": False, "reason": "main_chat_list_not_found"}
    for row in reversed(list(matched or [])):
        name = str(row.get("authorName") or "").strip()
        text = str(row.get("text") or "").strip()
        if not name or not text or not str(row.get("authorId") or "").strip():
            continue
        found = find_danmaku_in_list(cdp, {"authorName": name, "text": text}, box=box)
        if found.get("ok"):
            return {"ok": True, "row": row, "x": found["x"], "y": found["y"],
                    "box": found.get("box")}
    return {"ok": False, "reason": "no_visible_match"}


def prepare_danmaku_target(cdp, target, max_scroll=3):
    """把命中的那条弹幕准备好回复：先停住自动滚动，定位不到就上滚找（有上限）。

    只做"让它出现在屏上并可点"这件事，不点任何东西 —— 点击交给调用方的守卫点击。
    """
    # 先在【不动列表】的前提下找：最新那条命中的弹幕通常就在底部，随手滚一下反而把它挤走。
    # 但必须【只在主聊天列表内】找 —— 全页搜索会命中顶部那条弹幕条，
    # 于是"准备好了"是假的，真正去点的时候必然失败（真机实测）。
    box = main_list_box(cdp)
    if not box:
        return {"ok": False, "reason": "main_chat_list_not_found"}
    found = find_danmaku_in_list(cdp, target, box=box)
    paused = None
    scrolled = 0
    if not found.get("ok"):
        settled = pause_autoscroll(cdp)
        paused = settled.get("paused")
        box = settled.get("box")
        found = find_danmaku_in_list(cdp, target, box=box) if box else found
        if not found.get("ok"):
            found = scroll_to_danmaku(cdp, target, max_steps=max_scroll)
            scrolled = found.get("scrolled", 0)
    if not found.get("ok"):
        return {"ok": False, "reason": found.get("reason") or "danmaku_not_found"}
    return {"ok": True, "x": found["x"], "y": found["y"], "box": found.get("box"),
            "scrolled": scrolled, "paused": paused}


# ===================== 原生「回复 TA」（学自用户真机操作 2026-09-20）=====================
#
# 用户的真实路径（录屏交互序列取证）：
#   ① 点弹幕正文 span.webcast-chatroom___content-with-emoji-text
#   ② 弹出 ul.semi-dropdown-menu： 「资料卡」/「回复 TA」
#   ③ 点 li.semi-dropdown-item「回复 TA」
#   ④ 输入框自动出现 @昵称 —— 是平台插入的 mention（带 data-rect-container），不是纯文本
#   ⑤ 打字 -> 回车
#
# 🔴 复现失败的真实原因（踩了很久）：页面上【别处还有同名 class 的"弹幕条"元素】
#    （y≈60~240 那一带），点它们不会出菜单。必须点在【主聊天列表
#    webcast-chatroom___list】里的那一行。所以这里的定位器先锁列表，再锁行。
NATIVE_REPLY_MENU_SELECTOR = "ul.semi-dropdown-menu"
NATIVE_REPLY_LABELS = ("回复TA", "回复")

FIND_DANMAKU_IN_LIST_JS = (
    "(function(target,box){"
    "function vis(e){var r=e.getBoundingClientRect(),h=window.innerHeight||0;"
    "return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=h;}"
    "function norm(t){return String(t==null?'':t)"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\[[^\\[\\]]{1,10}\\]/g,'')"
    ".replace(/[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{2BFF}\\u{FE00}-\\u{FE0F}]/gu,'')"
    ".replace(/\\s+/g,'')"
    # 🔴 真机教训（2026-09-20）：平台会把过长的弹幕在列表里截断（"主播优秀优秀……"），
    #    而页面内存里是【完整正文】。原来要求两侧完全相等，长弹幕就永远定位不到
    #    （对外表现为 danmaku_not_found_in_list，看起来像"弹幕消失了"）。
    ".replace(/[.\\u2026]+$/,'').trim();}"
    # 宽容匹配：完全相同，或一方是另一方的前缀（截断）。前缀必须有足够长度，
    # 否则"好"这种短文本会匹配一大片行，点击就变成碰运气。
    "function textMatch(dom,want){var min=6;"
    "if(dom===want)return 'exact';"
    "if(!dom||!want)return '';"
    "if(dom.length>=min&&want.length>dom.length&&want.indexOf(dom)===0)return 'dom_truncated';"
    "if(want.length>=min&&dom.length>want.length&&dom.indexOf(want)===0)return 'target_prefix';"
    "return '';}"
    "function inBox(r,b){var t=2;""return r.x+t>=b[0]&&r.right-t<=b[0]+b[2]&&r.y+t>=b[1]&&r.bottom-t<=b[1]+b[3];}"
    "var lists=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_LIST) + "),hits=[];"
    "for(var L=0;L<lists.length;L++){var list=lists[L];"
    "var lr=list.getBoundingClientRect();"
    "if(!inBox(lr,box))continue;"
    "var rows=list.querySelectorAll(" + json.dumps(S.LIVE_CHAT_ROW) + ");"
    "for(var i=0;i<rows.length;i++){var el=rows[i];if(!vis(el))continue;"
    "if(el.closest('[class*=\"bottom-message\"]'))continue;"
    "var c=el.querySelector(" + json.dumps(S.LIVE_CHAT_CONTENT) + ");if(!c)continue;"
    "var how=textMatch(norm(c.innerText||c.textContent),norm(target.text));"
    "if(!how)continue;"
    "var r=c.getBoundingClientRect();"
    "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);"
    "var top=document.elementFromPoint(x,y);"
    "hits.push({x:x,y:y,how:how,onContent:!!(top&&(top===c||c.contains(top)||top.contains(c)))});}}"
    "if(!hits.length)return {ok:false,reason:'danmaku_not_found_in_list'};"
    "if(hits.length>1)return {ok:false,reason:'danmaku_ambiguous',count:hits.length};"
    "return {ok:true,x:hits[0].x,y:hits[0].y,onContent:hits[0].onContent,matchedBy:hits[0].how};"
    "})"
)


MENU_ITEMS_JS = (
    "(function(){"
    # 🔴 真机教训（2026-09-20，点击审计抓到的）：Semi Design 的浮层在【隐藏】时
    #    被放到屏幕外（实测坐标 -9947,-9941），但 getBoundingClientRect 仍然有尺寸。
    #    只看尺寸会把"隐藏菜单"当成"菜单已打开"，接着点在屏幕外，
    #    守卫如实拒绝（nothing_at_point），整条回复就失败在一个假阳性上。
    #    判定必须要求：元素真实落在视口内，且中心点命中的就是它自己。
    "function vis(e){var r=e.getBoundingClientRect();"
    "if(!(r.width>10&&r.height>10))return false;"
    "var w=window.innerWidth||0,h=window.innerHeight||0;"
    "if(r.right<=0||r.bottom<=0||r.left>=w||r.top>=h)return false;"
    "var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);"
    "if(x<0||y<0||x>w||y>h)return false;"
    "var hit=document.elementFromPoint(x,y);"
    "return !!(hit&&(hit===e||e.contains(hit)));}"
    "var menus=document.querySelectorAll(" + json.dumps(NATIVE_REPLY_MENU_SELECTOR) + ",[role=\"menu\"]);"
    "for(var i=0;i<menus.length;i++){var m=menus[i];if(!vis(m))continue;"
    "var items=[],lis=m.querySelectorAll('li,[role=menuitem]');"
    "for(var j=0;j<lis.length;j++){var li=lis[j];if(!vis(li))continue;"
    "var r=li.getBoundingClientRect();"
    "var t=String(li.innerText||'').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();"
    "if(!t)continue;"
    "items.push({text:t,label:t.replace(/\\s+/g,'').toUpperCase(),"
    "x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}"
    "if(items.length)return {found:true,items:items};}"
    "return {found:false,reason:'menu_not_found'};})()"
)

COMPOSER_MENTION_JS = (
    "(function(){"
    "var box=document.querySelector(" + json.dumps(S.LIVE_CHAT_EDITOR_BOX) + ");"
    "if(!box)return {found:false,reason:'composer_not_found'};"
    "var ed=box.querySelector('[contenteditable=true]');"
    "if(!ed)return {found:false,reason:'editor_not_found'};"
    "var text=String(ed.innerText||'').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'');"
    "var mention=!!ed.querySelector('[data-rect-container],[data-mention],span[data-string] span');"
    "var trimmed=text.trim();"
    "return {found:true,text:trimmed,startsAt:(trimmed.indexOf('@')===0),mention:mention,"
    "mentionCount:ed.querySelectorAll('[data-rect-container]').length};})()"
)


def find_danmaku_in_list(cdp, target, box=None):
    """只在【主聊天列表】里定位那条弹幕的正文坐标。

    页面上别处存在同名 class 的元素（顶部弹幕条），所以先按几何特征确定主列表盒子，
    再只在该盒子内的行里做匹配；box 可由调用方复用，避免每次重复测量。
    """
    if box is None:
        picked = main_chat_list(cdp)
        if not picked.get("found"):
            return {"ok": False, "reason": picked.get("reason") or "main_chat_list_not_found"}
        box = picked["box"]
    found = cdp.eval_json("(%s)(%s,%s)" % (
        FIND_DANMAKU_IN_LIST_JS,
        json.dumps({"authorName": str((target or {}).get("authorName") or ""),
                    "text": str((target or {}).get("text") or "")}, ensure_ascii=False),
        json.dumps(list(box))))
    if not isinstance(found, dict):
        return {"ok": False, "reason": "danmaku_lookup_failed"}
    found["box"] = box
    return found


VISIBLE_ROWS_JS = (
    "(function(box){"
    "function norm(t){return String(t==null?'':t)"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\[[^\\[\\]]{1,10}\\]/g,'')"
    ".replace(/[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{2BFF}\\u{FE00}-\\u{FE0F}]/gu,'')"
    ".replace(/\\s+/g,'').replace(/[.\\u2026]+$/,'').trim();}"
    "function inBox(r,b){var t=2;"
    "return r.x+t>=b[0]&&r.right-t<=b[0]+b[2]&&r.y+t>=b[1]&&r.bottom-t<=b[1]+b[3];}"
    "var lists=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_LIST) + "),out=[];"
    "for(var L=0;L<lists.length;L++){var list=lists[L];"
    "if(!inBox(list.getBoundingClientRect(),box))continue;"
    "var rows=list.querySelectorAll(" + json.dumps(S.LIVE_CHAT_ROW) + ");"
    "for(var i=0;i<rows.length;i++){var el=rows[i];"
    "if(el.closest('[class*=\"bottom-message\"]'))continue;"
    "var c=el.querySelector(" + json.dumps(S.LIVE_CHAT_CONTENT) + ");if(!c)continue;"
    "var text=norm(c.innerText||c.textContent);if(!text)continue;"
    "var rr=el.getBoundingClientRect();"
    # 行的中心必须落在列表矩形内部 —— 否则它是被滚动裁掉的（真机：最新弹幕会落在列表下方）
    "var cx=Math.round(rr.x+rr.width/2),cy=Math.round(rr.y+rr.height/2);"
    "if(!inBox({x:cx,y:cy,right:cx,bottom:cy},box))continue;"
    "var nick='';var spans=el.querySelectorAll('span');"
    "for(var s=0;s<spans.length;s++){var sp=spans[s];if(sp.querySelector('span'))continue;"
    "var t=String(sp.innerText||sp.textContent||'')"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'').replace(/\\s+/g,' ').trim();"
    "if(/[:：]$/.test(t)){nick=t.slice(0,-1).trim();break;}}"
    "var cr=c.getBoundingClientRect();"
    "out.push({text:text,raw:String(c.innerText||c.textContent||'').trim(),authorName:nick,"
    "x:Math.round(cr.x+cr.width/2),y:Math.round(cy),rowTop:Math.round(rr.top)});}}"
    "return out;})"
)


def visible_chat_rows(cdp, box=None, max_items=60):
    """列出【此刻真的渲染在聊天列表可视区内】的弹幕行（带作者名与点击坐标）。

    🔴 真机教训（2026-09-20，高流量房间，房间号 689015985670）：
      页面内存里有一百多条弹幕，DOM 只渲染十几行；而且一旦为了"找更早的弹幕"上滚，
      最新弹幕会全部落在列表可视区【下方】（实测 top≈885+，而列表矩形是 y 236~859）。
      所以"先在内存里匹配关键词、再去屏上定位"这个顺序在高流量房间会成片失败
      （对外表现 danmaku_not_found_in_list）。能被点到的只有此刻在可视区里的行 ——
      候选必须直接从渲染中的行里取。
    """
    if box is None:
        box = main_list_box(cdp)
    if not box:
        return {"ok": False, "reason": "main_chat_list_not_found", "rows": []}
    rows = cdp.eval_json("(%s)(%s)" % (VISIBLE_ROWS_JS, json.dumps(list(box))))
    if not isinstance(rows, list):
        return {"ok": False, "reason": "visible_rows_lookup_failed", "rows": []}
    rows = [row for row in rows if isinstance(row, dict) and row.get("text")]
    return {"ok": True, "box": list(box), "rows": rows[-int(max_items):]}


def match_visible_rows(rows, keywords=None, exclude_keywords=None, mode="seg"):
    """在【可见行】上做关键词匹配（与 match_danmaku 同一套匹配器，语义一致）。"""
    return match_danmaku(rows, keywords=keywords, exclude_keywords=exclude_keywords, mode=mode)


def main_list_box(cdp, attempts=3, interval=0.3):
    """反复取主聊天列表矩形；取不到返回 None（绝不返回全页搜索的结果）。"""
    for index in range(max(1, int(attempts))):
        picked = main_chat_list(cdp)
        if picked.get("found"):
            return picked["box"]
        if index + 1 < attempts:
            time.sleep(interval)
    return None


CONFIRM_MODAL_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "var wraps=document.querySelectorAll('.semi-modal-wrap,[class*=\"modal-wrap\"],[role=dialog]');"
    "for(var i=0;i<wraps.length;i++){var w=wraps[i];if(!vis(w))continue;"
    "var text=String(w.innerText||'').replace(/\\s+/g,' ').trim();"
    "if(!text)continue;"
    "var bs=w.querySelectorAll('button,[role=button],.semi-button');"
    "var items=[];"
    "for(var j=0;j<bs.length;j++){var b=bs[j];if(!vis(b))continue;"
    "var t=String(b.innerText||'').replace(/\\s+/g,'').trim();if(!t||t.length>6)continue;"
    "var r=b.getBoundingClientRect();"
    "items.push({label:t,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}"
    "if(items.length)return {found:true,text:text.slice(0,120),buttons:items};}"
    "return {found:false};})()"
)


def dismiss_confirm_modal(cdp, labels=("确定", "继续", "确认")):
    """关掉平台自己弹的确认框（点"确定"），返回它是什么。

    🔴 真机事实（2026-09-20，房间 689015985670）：上一次回复失败会在输入框里留下
    【未被清掉的 @提及】，下一次再点「回复 TA」时平台弹出确认框：
      "单次只支持艾特一个人，艾特其他人会清空内容，是否继续？"
    这个框是【全屏遮罩】：一旦出现，后续所有对公屏的点击都会被挡住
    （点击审计里成片 click_target_mismatch，命中元素是 div.semi-modal-wrap）。
    正确处理有两层：
      ① 每次回复前先把输入框清空（不留残提及，就不会弹）；
      ② 万一还是弹了，就按平台的提示点"确定"继续，而不是干等着。
    这里只点平台自己给出的按钮，不做任何绕过。
    """
    wanted = tuple(str(item).strip() for item in labels)
    try:
        state = cdp.eval_json(CONFIRM_MODAL_JS)
    except Exception as exc:
        # 探测不了就当"没有弹窗"：这是卫生步骤，不是发送门槛，
        # 绝不能因为一次探测失败把整条回复拦死（红线是"不误发"，不是"不发送"）。
        return {"handled": False, "reason": "modal_probe_failed:%s" % type(exc).__name__}
    if not isinstance(state, dict) or not state.get("found"):
        return {"handled": False}
    button = next((item for item in state.get("buttons") or []
                   if str(item.get("label") or "") in wanted), None)
    if button is None:
        return {"handled": False, "reason": "confirm_button_not_found",
                "text": state.get("text"), "buttons": [b.get("label") for b in state.get("buttons") or []]}
    clicked = click_guard.click_checked(cdp, button["x"], button["y"],
                                        expect_selectors=["button", "[role=button]", ".semi-button"],
                                        label="dismiss_confirm_modal", page_hint="live_room",
                                        expect_text=str(button.get("label") or ""))
    if not clicked.get("ok"):
        return {"handled": False, "reason": clicked.get("reason") or "click_refused",
                "text": state.get("text")}
    time.sleep(0.6)
    after = cdp.eval_json(CONFIRM_MODAL_JS)
    gone = not (isinstance(after, dict) and after.get("found"))
    return {"handled": True, "dismissed": gone, "text": state.get("text"),
            "button": button.get("label")}


def clear_composer(cdp, box=None, attempts=2):
    """清空公屏输入框（含残留的 @提及），返回清理前后状态。

    🔴 真机教训（2026-09-20）：输入框里残留的 @提及会让下一次「回复 TA」触发平台的
    确认框（"单次只支持艾特一个人…"），随后整屏被遮罩挡住。所以回复前先清干净。
    只操作输入框，不动聊天列表，也不发送任何东西。
    """
    try:
        composer = find_composer(cdp) or {}
    except Exception as exc:
        # 探测不了输入框 -> 跳过清理（不拦发送）。真正的门槛是下面的发送前校验。
        return {"ok": True, "cleared": False, "skipped": True,
                "reason": "composer_probe_failed:%s" % type(exc).__name__}
    if not composer.get("found"):
        return {"ok": True, "cleared": False, "skipped": True, "reason": "composer_not_found"}
    before = str(composer.get("text") or "")
    if not before.strip():
        return {"ok": True, "cleared": False, "before": ""}
    focus = click_guard.click_checked(
        cdp, composer["x"], composer["y"],
        expect_selectors=[S.LIVE_CHAT_EDITOR_BOX, "[contenteditable=true]"],
        label="clear_composer_focus", page_hint="live_room")
    if not focus.get("ok"):
        return {"ok": False, "reason": focus.get("reason") or "click_refused", "before": before}
    for _ in range(max(1, int(attempts))):
        cdp.press_key("a", code="KeyA", key_code=65, modifiers=2)   # Ctrl+A
        time.sleep(0.15)
        cdp.press_key("Delete", code="Delete", key_code=46)
        time.sleep(0.25)
        state = find_composer(cdp) or {}
        if not str(state.get("text") or "").strip():
            return {"ok": True, "cleared": True, "before": before, "after": ""}
    state = find_composer(cdp) or {}
    return {"ok": False, "reason": "composer_not_cleared", "before": before,
            "after": str(state.get("text") or "")}


def _row_fingerprint(text, size=6):
    """给点击守卫用的"这条弹幕的指纹"（归一化后的前若干字）。

    为什么是前缀而不是整条：平台的 DOM 会把过长的弹幕截断，
    整条比对会把"其实点对了"的点击也拒掉。太短又会混淆，故取前 6 个字。
    """
    value = _normalize_text(text)
    return value[:int(size)] if len(value) >= 2 else ""


def open_reply_menu(cdp, target, wait_seconds=3.0, interval=0.4, placed=None):
    """点那条弹幕的正文，等「对话菜单」（资料卡 / 回复 TA）出现，返回其条目。

    fail-closed：定位不到 / 点了不出菜单，都返回 ok=False，绝不猜坐标。
    """
    # 聊天列表一直在滚动：定位到的坐标可能在点击前就移走了（真机上用户也是连点几次才出菜单）。
    # 所以这里"重新定位 -> 立刻点击 -> 短查菜单"循环，最多 attempts 轮，绝不复用过期坐标。
    #
    # 🔴 真机教训（2026-09-20，高流量房间）：原来【一上来】就 pause_autoscroll
    #    （上滚一点让列表脱离底部）。在快房间里这会把最新弹幕顶到列表可视区下方，
    #    于是刚定位到的行立刻点不到。现在先就地定位+点击，只有点了不出菜单才停滚动重试。
    box = main_list_box(cdp)
    if not box:
        # 🔴 真机教训（2026-09-20，点击审计抓到的）：拿不到主聊天列表时，
        #    定位器会退化成【全页搜索】，命中的是页面顶部那条「弹幕条」（实测 y≈57 和 y≈106）——
        #    点它不会出菜单，而且那不是我们要回复的那条弹幕。守卫把这类点击全拦下来了
        #    （审计里 reason=click_target_mismatch），对外表现为 danmaku_not_found_in_list。
        #    正确做法是 fail-closed：没有主列表矩形就不点。
        return {"ok": False, "reason": "main_chat_list_not_found"}
    last = None
    pending = placed if isinstance(placed, dict) and placed.get("x") is not None else None
    for index in range(4):
        if index == 1:
            settled = pause_autoscroll(cdp)
            box = settled.get("box") or box
        if pending is not None:
            # 🔴 真机教训（2026-09-20，高流量房间）：先读"此刻可见的行"拿到坐标，
            #    再重新定位会多花几百毫秒到几秒 —— 期间那条弹幕已经被新弹幕顶走，
            #    点击直接落空（审计里是 nothing_at_point / danmaku_not_found_in_list）。
            #    所以第一次就用【刚读到的坐标】点，失败再回退到定位重试。
            found = dict(pending, ok=True)
            pending = None
        else:
            found = find_danmaku_in_list(cdp, target, box=box)
        if not found.get("ok"):
            last = found.get("reason") or "danmaku_not_found_in_list"
            time.sleep(0.4)
            continue
        # 受约束点击：落点必须在正文/行内、必须越不出主聊天列表矩形，
        # 而且【必须确实是这一条】—— 用文案指纹兜住"坐标在点击前就过期"的情况。
        #
        # 🔴 真机教训（2026-09-20，高流量房间）：弹幕每秒好几条，等我们点下去时
        #    原来那一行已经上移了几十像素。实测落点跑到过输入框（ace-line）上：
        #    点击"成功"了，但点到的是别的东西，菜单自然不出来（reply_menu_not_opened）。
        #    指纹只能取【前缀】：平台的 DOM 会把长弹幕截断，整条比对会天天误拒。
        clicked = click_guard.click_checked(
            cdp, found["x"], found["y"],
            expect_selectors=[S.LIVE_CHAT_CONTENT, S.LIVE_CHAT_ROW],
            container_box=box, label="open_reply_menu", page_hint="live_room",
            expect_text=_row_fingerprint((target or {}).get("text")))
        if not clicked.get("ok"):
            last = clicked.get("reason") or "click_refused"
            time.sleep(0.3)
            continue
        deadline = time.time() + float(wait_seconds)
        while True:
            menu = cdp.eval_json(MENU_ITEMS_JS)
            if isinstance(menu, dict) and menu.get("found"):
                return {"ok": True, "items": menu["items"], "placed": found,
                        "attempts": index + 1}
            if time.time() >= deadline:
                break
            time.sleep(interval)
        last = "reply_menu_not_opened"
    return {"ok": False, "reason": last or "reply_menu_not_opened"}


def choose_reply_menu_item(cdp, menu, labels=NATIVE_REPLY_LABELS):
    """在菜单里按文案选「回复 TA」（去掉空白并大写后精确匹配）。"""
    wanted = tuple(str(item).replace(" ", "").upper() for item in labels)
    for item in (menu or {}).get("items") or []:
        if str(item.get("label") or "").replace(" ", "").upper() in wanted:
            clicked = click_guard.click_checked(
                cdp, item["x"], item["y"],
                expect_selectors=["li", "[role=\"menuitem\"]"],
                label="choose_reply_menu_item", page_hint="live_room")
            if not clicked.get("ok"):
                return {"ok": False, "reason": clicked.get("reason") or "click_refused"}
            return {"ok": True, "label": item.get("text"), "x": item["x"], "y": item["y"]}
    return {"ok": False, "reason": "reply_menu_item_not_found"}


def composer_mention(cdp):
    """读输入框：是否已进入「回复某人」状态（平台插入 @昵称 的 mention 实体）。"""
    found = cdp.eval_json(COMPOSER_MENTION_JS)
    if not isinstance(found, dict):
        return {"found": False, "reason": "composer_lookup_failed"}
    return found


# ===================== 公屏输入框与发送控件 =====================

COMPOSER_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "var sels=" + _js_array([S.LIVE_CHAT_EDITOR]) + ".concat(" + _js_array(S.LIVE_PUBLIC_EDITORS) + ");"
    "function isSearch(el){var ph=String((el.getAttribute&&(el.getAttribute('placeholder')||el.getAttribute('data-placeholder')))||'');"
    "var cls=String((el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className)||'');"
    "return /搜索|search/i.test(ph+' '+cls);}"
    "function onTop(el){try{var r=el.getBoundingClientRect();"
    "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);"
    "var h=document.elementFromPoint(x,y);"
    "return !!(h&&(el===h||el.contains(h)||h.contains(el)));}catch(e){return false;}}"
    "var found=[];"
    "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
    "for(var j=0;j<ns.length;j++){var e=ns[j];"
    "if(vis(e)&&!isSearch(e)&&found.indexOf(e)<0)found.push(e);}}"
    "if(found.length!==1)return {found:false,reason:found.length?'ambiguous_public_composer':'composer_not_found',count:found.length};"
    "var r=found[0].getBoundingClientRect();"
    "return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),onTop:onTop(found[0]),"
    "text:String(found[0].innerText||found[0].value||'').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')};"
    "})()"
)


def find_composer(cdp):
    return cdp.eval_json(COMPOSER_JS) or {"found": False, "reason": "composer_not_found"}


SEND_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "function label(e){return String((e&&(e.innerText||e.textContent))||'')"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'').replace(/\\s+/g,'').trim();}"
    "var sels=" + _js_array(S.LIVE_CHAT_SEND_CANDIDATES) + ".concat(" + _js_array(S.LIVE_PUBLIC_SEND_BUTTONS) + ");"
    "var nodes=[],seen=[];"
    "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
    "for(var j=0;j<ns.length;j++){if(seen.indexOf(ns[j])<0){seen.push(ns[j]);nodes.push(ns[j]);}}}"
    # 🔴 真机结论（2026-09-20）：输入框右侧只有 emoji 与 svg 图标，**没有文字发送键**；
    #    按候选坐标点下去内容原样留在框里。所以这里【只认带文字标签的发送键】，
    #    图标一律不认（宁可回落到回车，也不乱点一个不知道干什么的控件）。
    "for(var k=0;k<nodes.length;k++){var e=nodes[k];if(!vis(e))continue;"
    "var t=label(e);if(t!=='" + S.DM_SEND_TEXT + "'&&t!=='Send'&&t!=='send')continue;"
    "var r=e.getBoundingClientRect();"
    "return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),"
    "disabled:!!(e.disabled||e.getAttribute('aria-disabled')==='true'),label:t};}"
    "return {found:false,reason:'send_control_not_found',enterFallback:true};"
    "})()"
)


def find_send_control(cdp):
    """公屏发送方式。

    🔴 真机实测（2026-09-20，真实直播间）：
      · 输入框右侧只有 emoji 与两个 svg 图标，**没有**文字发送键；
      · 按候选控件的坐标点下去之后，输入框内容【原样留在框里】= 它根本不是发送键；
      · 改用回车发送，输入框立刻清空，随后能在房间消息流里看到自己发的那条。
    因此规则是：**只认带文字标签（发送 / Send）的发送键**，图标一律不认；
    没有可用的文字发送键时机制为回车，候选控件只作为诊断信息返回
    （宁可发不出去，也不要乱点一个不知道干什么的控件）。
    """
    found = cdp.eval_json(SEND_JS) or {"found": False}
    if found.get("found") and not found.get("disabled"):
        found["mechanism"] = "button"
        return found
    return {"found": False, "mechanism": "enter",
            "reason": found.get("reason") or "send_control_disabled",
            "diagnostic": {"candidateFound": bool(found.get("found")),
                           "candidateDisabled": bool(found.get("disabled")),
                           "note": "只认带文字标签的发送键；真机上没有，故用回车"}}


def find_send_button(cdp):
    """兼容旧调用名：返回发送方式（有文字发送键时是 button，否则 enter）。"""
    return find_send_control(cdp)


def _normalize_text(text):
    """发送前后比对用的归一化：零宽字符、[表情名]、表情字符、空白都不参与比较。

    与 FIND_DANMAKU_JS 里的 norm() 同一套口径 —— 页面上的表情是图片，内置数据里是文字，
    不归一化就永远对不上。
    """
    value = str(text or "")
    for junk in ("\u200b", "\u200c", "\u200d", "\ufeff"):
        value = value.replace(junk, "")
    value = re.sub(r"\[[^\[\]]{1,10}\]", "", value)
    value = "".join(ch for ch in value
                    if not (0x1F000 <= ord(ch) <= 0x1FAFF or 0x2190 <= ord(ch) <= 0x2BFF
                            or 0xFE00 <= ord(ch) <= 0xFE0F))
    return re.sub(r"\s+", "", value)


def _strip_mention(text):
    """把"@昵称 正文"里的提及前缀去掉，只留正文（用于回声比对）。"""
    value = str(text or "").strip()
    if not value.startswith("@"):
        return value
    parts = value[1:].split(None, 1)
    return parts[1] if len(parts) > 1 else ""


def wait_room_echo(cdp, text, seconds=22.0, interval=1.5):
    """等房间消息流里出现自己刚发的那条（诊断证据，不是"送达"判据本身）。

    价值：把"发送后什么都看不见"变成"平台的消息流里确实出现了这条"。
    是否把它当作该通道的确认由 host/服务端决定 —— live_flow 记作 sent_echoed，
    绝不冒充 sent_confirmed。
    """
    want_full = _normalize_text(text)
    want_body = _normalize_text(_strip_mention(text))
    body_ok = len(want_body) >= 2            # 正文太短（1 个字）不足以判定，避免误报
    deadline = time.time() + float(seconds)
    composer_cleared = None
    while True:
        composer = find_composer(cdp) or {}
        if composer.get("found"):
            composer_cleared = not str(composer.get("text") or "").strip()
        for row in (collect_feed(cdp).get("rows") or []):
            row_norm = _normalize_text(row.get("text"))
            if not row_norm:
                continue
            # 平台可能把提及渲染成"[@某人]"之类，所以按【包含】比对：
            # 先比整条，再比"去掉 @前缀后的正文"。
            if want_full and want_full in row_norm:
                return {"row": row, "composerCleared": composer_cleared, "matchedBy": "full"}
            if body_ok and want_body in row_norm:
                return {"row": row, "composerCleared": composer_cleared, "matchedBy": "body"}
        if time.time() >= deadline:
            return {"row": None, "composerCleared": composer_cleared}
        time.sleep(interval)
