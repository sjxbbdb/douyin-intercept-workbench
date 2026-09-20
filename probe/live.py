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
* 「回复弹幕」：真机确认网页端**没有**「点某条弹幕 → 回复」的原生入口
  （全页 hover 扫描「回复」类元素恒为 0；点击弹幕不会进入回复态；输入框 @ 也没有提及联想）。
  因此本模块把「回复弹幕」定义为：**在公屏发一条以 @昵称 开头的消息**，
  并且发出前必须先在屏上定位到那条弹幕（唯一命中 + 未被遮挡），否则一律拒绝发送。
"""
import json

import douyin_selectors as S


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
    "var NICK_MAX=" + str(int(S.LIVE_NICK_MAX)) + ",TEXT_MAX=" + str(int(S.LIVE_TEXT_MAX)) + ";"
    "var NICK_FALLBACK=new RegExp(" + json.dumps(S.LIVE_NICK_FALLBACK_RE) + ");"
    "var NOISE_TEXT=new RegExp(" + json.dumps(S.LIVE_NOISE_TEXT_RE) + ");"
    "var NOISE_NICK=new RegExp(" + json.dumps(S.LIVE_NOISE_NICK_RE) + ");"
    "function textOf(el){return String((el&&(el.innerText||el.textContent))||'')"
    ".replace(/\\u00a0/g,' ').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();}"
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
    "function parseRow(el){var lines=getLines(el);"
    "if(lines.length===1){var m=lines[0].match(NICK_FALLBACK);if(m)lines=[m[1].trim(),m[2].trim()];}"
    "if(lines.length<2)return {why:'one_line'};"
    "var user=lines[0].replace(/^@/,'').trim();"
    "var text=lines.slice(1).join(' ').trim();"
    "if(!user||!text)return {why:'empty'};"
    "if(user.length>NICK_MAX||text.length>TEXT_MAX)return {why:'shape'};"
    "if(isNoiseText(text))return {why:'noise_text'};"
    "if(NOISE_NICK.test(user))return {why:'noise_nick'};"
    "return {row:{authorName:user,text:text,id:(user+'|'+text).slice(0,120)}};}"
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
    "if(!onTop(accepted[a].el))stats.covered++;"
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
            })
        if rows:
            return rows
    return collect_dom(cdp, max_items)


# ===================== 定位某一条弹幕（「回复弹幕」的前提） =====================

FIND_DANMAKU_JS = (
    "(function(target){"
    "var NICK_FALLBACK=new RegExp(" + json.dumps(S.LIVE_NICK_FALLBACK_RE) + ");"
    "function textOf(el){return String((el&&(el.innerText||el.textContent))||'')"
    ".replace(/\\u00a0/g,' ').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();}"
    "function visible(el){if(!el)return false;var r=el.getBoundingClientRect();"
    "if(!r.width||!r.height)return false;"
    "if(r.bottom<0||r.top>(window.innerHeight||0))return false;"
    "var s=getComputedStyle(el);"
    "return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}"
    "function onTop(el){try{var r=el.getBoundingClientRect();"
    "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);"
    "var h=document.elementFromPoint(x,y);"
    "return !!(h&&(el===h||el.contains(h)||h.contains(el)));}catch(e){return false;}}"
    "function parts(el){var lines=String((el&&(el.innerText||el.textContent))||'')"
    ".replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'').split(/\\n+/);"
    "var out=[];for(var i=0;i<lines.length;i++){var v=lines[i].replace(/\\s+/g,' ').trim();"
    "if(v&&out.indexOf(v)<0)out.push(v);}"
    "if(out.length===1){var m=out[0].match(NICK_FALLBACK);if(m)out=[m[1].trim(),m[2].trim()];}"
    "if(out.length<2)return null;"
    "return {authorName:out[0].replace(/^@/,'').trim(),text:out.slice(1).join(' ').trim()};}"
    "var rows=document.querySelectorAll(" + json.dumps(S.LIVE_CHAT_ROW) + "),hits=[];"
    "for(var i=0;i<rows.length;i++){var el=rows[i];if(!visible(el))continue;"
    "var p=parts(el);if(!p)continue;"
    "if(p.text!==target.text)continue;"
    "if(target.authorName&&p.authorName!==target.authorName)continue;"
    "hits.push({el:el,x:Math.round(el.getBoundingClientRect().x),"
    "y:Math.round(el.getBoundingClientRect().y),"
    "w:Math.round(el.getBoundingClientRect().width),"
    "h:Math.round(el.getBoundingClientRect().height)});}"
    "if(!hits.length)return {ok:false,count:0,reason:'danmaku_not_found'};"
    "if(hits.length>1)return {ok:false,count:hits.length,reason:'danmaku_ambiguous'};"
    "var hit=hits[0],top=onTop(hit.el);"
    "return {ok:true,count:1,onTop:top,x:Math.round(hit.x+hit.w/2),y:Math.round(hit.y+hit.h/2),"
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


# ===================== 公屏输入框与发送控件 =====================

COMPOSER_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "var sels=" + _js_array([S.LIVE_CHAT_EDITOR]) + ".concat(" + _js_array(S.LIVE_PUBLIC_EDITORS) + ");"
    "var found=[];"
    "for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);"
    "for(var j=0;j<ns.length;j++){var e=ns[j];if(vis(e)&&found.indexOf(e)<0)found.push(e);}}"
    "if(found.length!==1)return {found:false,reason:found.length?'ambiguous_public_composer':'composer_not_found',count:found.length};"
    "var r=found[0].getBoundingClientRect();"
    "return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),"
    "text:String(found[0].innerText||found[0].value||'').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')};"
    "})()"
)


def find_composer(cdp):
    return cdp.eval_json(COMPOSER_JS) or {"found": False, "reason": "composer_not_found"}


SEND_JS = (
    "(function(){"
    "function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);"
    "return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}"
    "var box=document.querySelector(" + json.dumps(S.LIVE_CHAT_EDITOR_BOX) + ");"
    "if(!box)return {found:false,reason:'composer_box_not_found'};"
    "var sels=" + _js_array(S.LIVE_CHAT_SEND_CANDIDATES) + ".concat(" + _js_array(S.LIVE_PUBLIC_SEND_BUTTONS) + ");"
    "for(var i=0;i<sels.length;i++){var ns=box.querySelectorAll(sels[i]);"
    "for(var j=0;j<ns.length;j++){var e=ns[j];if(!vis(e))continue;"
    "var r=e.getBoundingClientRect();"
    "return {found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),"
    "disabled:!!(e.disabled||e.getAttribute('aria-disabled')==='true')};}}"
    "return {found:false,reason:'send_control_not_found',enterFallback:true};"
    "})()"
)


def find_send_control(cdp):
    """公屏发送控件。

    真机现状（2026-09-20）：输入框右侧只有 emoji 与两个 svg 图标，**没有**文字「发送」按钮，
    所以这里优先找受控按钮，找不到时回落到 Enter 发送，并在结果里标明用的是哪种机制
    （审计与真机验收都需要区分）。
    """
    found = cdp.eval_json(SEND_JS) or {"found": False}
    if found.get("found") and not found.get("disabled"):
        found["mechanism"] = "button"
        return found
    return {"found": False, "mechanism": "enter", "reason": found.get("reason") or "send_control_disabled",
            "enterFallback": True}


def find_send_button(cdp):
    """兼容旧调用名：返回发送控件（找不到时 mechanism='enter'）。"""
    return find_send_control(cdp)
