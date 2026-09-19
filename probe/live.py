"""直播间截流：弹幕采集 -> 关键词筛选 -> 意向打分 -> 私信队列。

数据来源与边界
--------------
· **只读 DOM**：不点击弹幕、不发弹幕、不参与直播间互动。采集与发送严格分开——
  私信发送只在 dm.py 里发生，本模块【没有任何发送动作】。
· **不解码、不重放弹幕数据帧**：弹幕走的是前端长连接的二进制帧（protobuf），
  本模块不去解析它，边界与 dm.py 的 WSFrameLog 一致（只记录方向/长度以便定位通道）。
· **取不到用户标识就如实记 skipped**：弹幕 DOM 常把用户 ID 脱敏成 *****，
  此时按 not_locatable 统计（需求规格 FR-2.4），
  **绝不用昵称冒充用户标识**去发私信（昵称可改、可重复）。

🔴 真机结论（2026-09-19，两个真实直播间，详见 ../../06-直播间截流私信.md）
------------------------------------------------------------------------
· 采集本身能跑：60 秒采到 56 条弹幕 / 49 个不同昵称，礼物与进场噪音被正确过滤，
  单行「昵称：正文」的拆分在真机数据上有效。
· **弹幕 DOM 文本里没有任何用户标识**：没有 data-sec-uid / data-user-id，也没有 a[href]。
  只读 DOM 时标识完整率 = 0.0%（这一步的结论当时是对的）。
· 🔴 **但页面内存里有**：弹幕虚拟列表组件的 React fiber props 里挂着 originalList（消息数组），
  每条 WebcastChatMessage 的 payload.user 里就有 sec_uid / nickname / 一堆风控相关字段。
  改从那里取之后，实测**标识完整率 100%**（见下方 "_LIVE_FEED_JS"）。
· 所以直播间 -> 私信是**闭环**的：抓弹幕即拿到 sec_uid，直接进队列。
  DOM 文本采集保留为兜底（React 内部结构会随平台构建变化）。

未真机验证的部分
------------------------------------------------------------------------
· 弹幕容器候选 = 7 个模糊 class 匹配（来自 archive/v3/legacy/live_dom_collector.js:349-357，
  archive/v3 的选择器不是当前平台事实）。
· 「容器回声」过滤是**本模块新增**的策略：legacy 把每个候选节点都当一行弹幕，
  于是 [class*="message"] 命中的外层容器会被解析成一条假弹幕
  （昵称=第一行、正文=其后所有行拼接）。这里改成「候选节点里取最深层」，
  已用离线 fixture 覆盖（live_selftest.py），真机仍需复核。
"""
import json
import re
import time
import urllib.parse

import crawl as crawlmod
import douyin
import dyselectors as S

ROOM_URL_TMPL = "https://live.douyin.com/%s"

DEFAULT_SECONDS = 90        # 默认采集时长（秒）
DEFAULT_LIMIT = 300         # 默认最多收多少条弹幕
PROBE_EVERY = 3.0           # 每轮读取间隔（秒，对数正态抖动）——比评论采集更慢，见 05 号的验证码教训
SNAPSHOT_KEEP = 200         # 单次快照最多回传多少行（legacy rows.slice(-100) 的同位置参数）
SHORT_LINK_HOSTS = ("v.douyin.com", "iesdouyin.com")

# ===================== 意向打分（可解释，FR-06-03） =====================
#
# ⚠️ 红线 1：这些数值与词表最终应由服务端下发。当前写在代码里 = 阶段性默认值。
#    规则命中会逐条记进 reasons，前端/日志可以解释「为什么这条是高意向」。
INTENT_RULES = [
    ("问价", 25, ["多少钱", "价格", "报价", "怎么卖", "贵不贵", "便宜", "优惠", "几块", "包邮"]),
    ("购买路径", 25, ["怎么买", "哪里买", "在哪买", "下单", "链接", "拍下", "订购", "现货"]),
    ("索取联系", 20, ["微信", "vx", "加我", "私信", "联系", "电话", "手机号"]),
    ("学习合作", 20, ["想学", "求带", "教教", "教程", "怎么做", "预算", "有偿", "付费", "合作"]),
    # 真机补充：直播间里大量是"操作/配方类提问"（最小火么、多少克、会不会糊）——
    # 这类人在买辅食工具/食材的场景里同样是高意向。
    ("配方操作", 15, ["多少克", "几分钟", "火候", "最小火", "大火", "会不会糊", "比例",
                      "要不要", "先熟", "冷水", "热水", "蒸多久"]),
    # 已经在别人直播间下单过的人：有线上购买习惯，是最暖的一类线索（注意：他们已经买过竞品）
    ("已成交", 20, ["已拍", "已下单", "拍了", "下了单", "付款", "回购"]),
]

# 与 JS 同源的噪音判定（模式串来自 dyselectors，避免两处各写一份）
_NOISE_RE = re.compile(S.LIVE_NOISE_TEXT_RE)


def is_noise_text(text):
    """事件类消息（送礼/进场/点赞）不是用户意图。规则与采集 JS 的 isNoiseText 一致。"""
    text = text or ""
    if _NOISE_RE.match(text):
        return True
    tail = text.rsplit("：", 1)[-1].rsplit(":", 1)[-1].strip()
    return bool(_NOISE_RE.match(tail))
QUESTION_MARKS = ("?", "？", "怎么", "如何", "能不能", "可以吗", "有没有", "求")
LEVELS = ("低意向", "中意向", "高意向")
LEVEL_RANK = {name: i for i, name in enumerate(LEVELS)}


def score_lead(text, repeat=1):
    """规则打分。返回 (分数, 等级, 命中说明)。repeat = 同一人在本次采集里发言次数。

    等级口径（与 legacy calculateLeadLevel 的精神一致，但可解释）：
      >= 40 高意向 / >= 20 中意向 / 其余 低意向
    """
    text = text or ""
    score, reasons = 0, []
    for name, weight, words in INTENT_RULES:
        hit = [w for w in words if w in text]
        if hit:
            score += weight
            reasons.append("%s(%s)" % (name, "/".join(hit[:3])))
    if any(q in text for q in QUESTION_MARKS):
        score += 10
        reasons.append("疑问句")
    if repeat > 1:
        score += 10
        reasons.append("重复发言x%d" % repeat)
    level = "高意向" if score >= 40 else ("中意向" if score >= 20 else "低意向")
    return score, level, reasons


# ===================== 直播间链接 =====================

def web_rid_from_url(url):
    """从直播间 URL 里取 web_rid（短链重定向后要重新取一次）。"""
    url = url or ""
    m = re.search(r"live\.douyin\.com/(\d{4,})", url)
    if m:
        return m.group(1)
    try:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    except Exception:
        return ""
    for key in ("web_rid", "room_id", "roomId"):
        if q.get(key):
            return q[key][0]
    return ""


def normalize_room(value):
    """把用户给的直播间链接/房间号规范成可导航的 URL。

    支持：直播间链接（live.douyin.com/<rid>）、带 web_rid 的链接、纯房间号、
          短链（v.douyin.com/xxx —— 只能在页面里重定向后再解析 web_rid）。
    """
    raw = (value or "").strip()
    if not raw:
        raise ValueError("直播间链接为空")
    if re.fullmatch(r"\d{4,20}", raw):
        return {"raw": raw, "url": ROOM_URL_TMPL % raw, "web_rid": raw, "from": "bare_id"}
    if not raw.startswith("http"):
        raw = "https://" + raw
    parts = urllib.parse.urlsplit(raw)
    host = (parts.netloc or "").lower()
    if not host.endswith("douyin.com"):
        raise ValueError("不是抖音链接：%s（本模块只支持 douyin.com 域名）" % host)
    if any(host.endswith(h) for h in SHORT_LINK_HOSTS):
        return {"raw": raw, "url": raw, "web_rid": "", "from": "short_link"}
    rid = web_rid_from_url(raw)
    if not rid:
        raise ValueError(
            "从链接里解析不出直播间号：%s\n"
            "  直播间链接形如 https://live.douyin.com/<房间号>" % raw)
    return {"raw": raw, "url": ROOM_URL_TMPL % rid, "web_rid": rid, "from": "url"}


# ===================== 弹幕采集（DOM 只读） =====================

_DANMAKU_JS = (
    "(function(){"
    "var SEL=" + json.dumps(S.LIVE_CHAT_NODE_SELECTORS, ensure_ascii=False) + ";"
    "var KEY_ATTRS=" + json.dumps(S.LIVE_ROW_KEY_ATTRS) + ";"
    "var SEC_ATTRS=" + json.dumps(S.LIVE_SEC_UID_ATTRS) + ";"
    "var UID_ATTRS=" + json.dumps(S.LIVE_USER_ID_ATTRS) + ";"
    "var NICK_MAX=" + str(int(S.LIVE_NICK_MAX)) + ",TEXT_MAX=" + str(int(S.LIVE_TEXT_MAX)) + ";"
    "var NICK_FALLBACK=new RegExp(" + json.dumps(S.LIVE_NICK_FALLBACK_RE) + ");"
    "var NOISE_TEXT=new RegExp(" + json.dumps(S.LIVE_NOISE_TEXT_RE) + ");"
    "var NOISE_NICK=new RegExp(" + json.dumps(S.LIVE_NOISE_NICK_RE) + ");"
    "var ONLINE=new RegExp(" + json.dumps(S.LIVE_ONLINE_RE) + ");"
    "var ENDED=new RegExp(" + json.dumps(S.LIVE_ENDED_RE) + ");"
    "var WAITING=new RegExp(" + json.dumps(S.LIVE_WAITING_RE) + ");"
    "function textOf(el){return String((el&&(el.innerText||el.textContent))||'')"
    ".replace(/\\u00a0/g,' ').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();}"
    # 可见性：legacy 的弹幕版（比评论区多一个 opacity 判定 + 视口判定）。
    # ⚠️ 视口判定意味着【滚出视口的行采不到】——这是 legacy 的既有取舍，保留并记录。
    "function visible(el){if(!el)return false;var r=el.getBoundingClientRect();"
    "if(!r.width||!r.height)return false;"
    "if(r.bottom<0||r.top>(window.innerHeight||0))return false;"
    "var s=getComputedStyle(el);"
    "return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}"
    # 命中测试：该元素中心点最上层是不是它自己（或它的子/父）。
    # 🔴 真机教训（2026-09-19）：直播间页面里同时存在【被面板盖住的】弹幕列表，
    #    它的行 rect 非零、样式也"可见"，但 elementFromPoint 拿到的是盖在上面的面板 ——
    #    照它的坐标去点，点的是面板，不是弹幕。
    "function onTop(el){try{var r=el.getBoundingClientRect();"
    "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);"
    "var h=document.elementFromPoint(x,y);"
    "return !!(h&&(el===h||el.contains(h)||h.contains(el)));}catch(e){return false;}}"
    "function attrOf(el,names){for(var i=0;i<names.length;i++){"
    "var v=el.getAttribute(names[i]);if(v)return v;}return '';}"
    # sec_uid 三级回退（legacy live_dom_collector.js:282-309）
    "function profileInfo(el){"
    "var secUid=attrOf(el,SEC_ATTRS);var profileUrl='';"
    "var links=el?el.querySelectorAll('a[href]'):[];"
    "for(var i=0;i<links.length;i++){var href=links[i].getAttribute('href')||'';"
    "var m=href.match(/\\/user\\/([^\\/?#]+)/i);"
    "if(m){try{profileUrl=new URL(href,location.origin).toString();}catch(e){profileUrl='';}"
    "if(!secUid)secUid=decodeURIComponent(m[1]);break;}}"
    "if(!secUid){var a=el;"
    "for(var d=0;d<4&&a;d++,a=a.parentElement){"
    "var h2=attrOf(a,['href','data-profile-url','data-user-url']);"
    "var m2=h2.match(/\\/user\\/([^\\/?#]+)/i);"
    "if(m2){try{profileUrl=profileUrl||new URL(h2,location.origin).toString();}"
    "catch(e){}secUid=decodeURIComponent(m2[1]);break;}}}"
    "if(secUid&&/^\\*+$/.test(secUid))secUid='';"
    "var img=el?el.querySelector('img[src]'):null;"
    "return {sec_uid:secUid||'',profile_url:profileUrl||'',"
    "avatar_url:img?(img.currentSrc||img.src||''):''};}"
    "function getLines(el){var raw=String((el&&(el.innerText||el.textContent))||'').split(/\\n+/);"
    "var out=[];for(var i=0;i<raw.length;i++){"
    "var v=raw[i].replace(/\\u00a0/g,' ').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'')"
    ".replace(/\\s+/g,' ').trim();"       # 零宽空格：JS 的 \\s 不匹配它，会让空行看起来"有内容"
    "if(v&&out.indexOf(v)<0)out.push(v);}return out;}"
    # 噪音判定：真机发现两种形态都要覆盖 ——
    #   ① 单行 "昵称：送出了 X × 1"            -> 拆出来后 text 以"送出了"开头
    #   ② 多行 "猪叫团\n半夏&：送出了 X × 1"   -> 昵称行后面还跟着"昵称：送出了…"
    # 所以除了整段，还要对"最后一个冒号之后"的那段再判一次。
    "function isNoiseText(t){"
    "if(NOISE_TEXT.test(t))return true;"
    "var k=Math.max(t.lastIndexOf('：'),t.lastIndexOf(':'));"
    "return k>=0&&NOISE_TEXT.test(t.slice(k+1).replace(/^\\s+/,''));}"
    "function parseRow(el){"
    "var lines=getLines(el);"
    "if(lines.length===1){var m=lines[0].match(NICK_FALLBACK);if(m)lines=[m[1].trim(),m[2].trim()];}"
    "if(lines.length<2)return {why:'one_line'};"
    "var user=lines[0].replace(/^@/,'').trim();"
    "var text=lines.slice(1).join(' ').trim();"
    "if(!user||!text)return {why:'empty'};"
    "if(user.length>NICK_MAX||text.length>TEXT_MAX)return {why:'shape'};"
    "if(isNoiseText(text))return {why:'noise_text'};"
    "if(NOISE_NICK.test(user))return {why:'noise_nick'};"
    "var key=attrOf(el,KEY_ATTRS);"
    "var rawUserId=attrOf(el,UID_ATTRS);"
    "var p=profileInfo(el);"
    "var r=el.getBoundingClientRect();"
    # 字段名一律 snake_case：与 crawl.py 的评论行、dm.py 的队列完全对齐。
    # ⚠️ 离线回归抓到的第一个真 bug 就是这里：JS 原本用 camelCase（secUid），
    #    Python 侧读 sec_uid 读不到 -> 所有人都被判成"取不到标识"、队列为空，
    #    而日志上看起来一切正常（静默错误）。
    "return {row:{user:user,text:text,row_key:key||(user+'|'+text).slice(0,240),"
    "user_id:rawUserId||'',sec_uid:p.sec_uid,profile_url:p.profile_url,avatar_url:p.avatar_url,"
    "x:Math.round(r.x),y:Math.round(r.y),on_top:onTop(el)}};}"
    "var nodes=[],seenNode=[];"
    "for(var s=0;s<SEL.length;s++){var found=[];"
    "try{found=Array.from(document.querySelectorAll(SEL[s]));}catch(e){continue;}"
    "for(var i=0;i<found.length;i++){"
    "if(seenNode.indexOf(found[i])<0){seenNode.push(found[i]);nodes.push(found[i]);}}}"
    "var vis=[];"
    "for(var j=0;j<nodes.length;j++){if(visible(nodes[j]))vis.push(nodes[j]);}"
    "var stats={candidates:nodes.length,visible:vis.length,parsed:0,drop_ancestor:0,covered:0,"
    "drop_dup:0,drop_one_line:0,drop_shape:0,drop_noise:0,drop_empty:0};"
    "var accepted=[],noiseEls=[];"
    "for(var k=0;k<vis.length;k++){var got=parseRow(vis[k]);"
    "if(got.row){accepted.push({el:vis[k],row:got.row});continue;}"
    "var w=got.why;"
    "if(w==='one_line')stats.drop_one_line++;"
    "else if(w==='shape')stats.drop_shape++;"
    "else if(w==='noise_text'||w==='noise_nick'){stats.drop_noise++;noiseEls.push(vis[k]);}"   # 它是一条"消息"，只是噪音
    "else stats.drop_empty++;}"
    "stats.parsed=accepted.length;"
    # 容器回声过滤：父节点若包含另一个【已解析】节点，它就不是一行弹幕
    "var rows=[],seen={};"
    # ⚠️ 真机踩坑：只认"解析成功的子节点"会漏 —— 送礼容器里的每一行都被判成噪音，
    #    于是容器里"没有已解析的子节点"，容器自己就被当成了一条弹幕
    #    （真机原样：昵称="꧁༺大洋༻꧂：送出了 粉丝团灯牌 × 1"，正文=其后 4 条送礼拼接）。
    #    所以"被判定为噪音的子节点"同样算行，一样能把父容器顶掉。
    "for(var a=0;a<accepted.length;a++){var isAncestor=false;"
    "for(var b=0;b<accepted.length;b++){if(a===b)continue;"
    "if(accepted[a].el.contains(accepted[b].el)){isAncestor=true;break;}}"
    "if(!isAncestor){for(var c=0;c<noiseEls.length;c++){"
    "if(accepted[a].el.contains(noiseEls[c])){isAncestor=true;break;}}}"
    "if(isAncestor){stats.drop_ancestor++;continue;}"
    "var row=accepted[a].row;"
    "var rk=row.row_key||(row.user+'|'+row.text);"
    "if(seen[rk]){stats.drop_dup++;continue;}seen[rk]=true;"
    "if(row.on_top===false)stats.covered++;"
    "rows.push(row);}"
    "var bodyText=textOf(document.body);"
    "var title=textOf(document.querySelector('h1'))||document.title||'';"
    "var om=bodyText.match(ONLINE);"
    "var status=ENDED.test(bodyText)?'已结束':'运行中';"
    "if(WAITING.test(bodyText)&&!rows.length)status='等待页面';"
    "var keep=" + str(int(SNAPSHOT_KEEP)) + ";"
    "return {room:{room_title:title.replace(/\\s*[-|｜]\\s*抖音.*$/i,'').slice(0,80),"
    "online_text:om?om[1]:'',status:status,url:location.href},"
    "rows:rows.slice(-keep),diagnostics:stats};"
    "})()"
)


# ===================== 数据源②：页面内存里的弹幕数据模型（首选） =====================
#
# 🔴 2026-09-19 真机突破：直播间的弹幕数据本来就在页面内存里 ——
#    弹幕虚拟列表组件的 React fiber props 里有 originalList（消息数组），每条形如
#      { method:"WebcastChatMessage",
#        payload:{ content:"…", event_time:"…",
#                  user:{ sec_uid:"MS4wLjABAAAA…", nickname:"…", id:"…",
#                         webcast_private:0, disable_ichat:0, block_status:0, … } } }
#    也就是说【每条弹幕都自带 sec_uid】，根本不需要去点昵称（更不用人工点）。
#
# 边界（与项目红线一致）：这是读**页面自己已经拿到的数据**（和读 innerText 同一性质），
#   不是伪造签名、不是解码/重放网络帧、不是直调内部接口，也不碰验证码。
# ⚠️ 代价：React 内部结构会随平台构建变化 —— 所以 DOM 文本采集【保留为兜底】。
_LIVE_FEED_JS = (
    "(function(){"
    "function fiberOf(el){var ks=Object.keys(el);for(var i=0;i<ks.length;i++){"
    "if(ks[i].indexOf('__reactFiber$')===0)return el[ks[i]];}return null;}"
    "function propsOf(f){try{return f.memoizedProps||null;}catch(e){return null;}}"
    "var list=null;"
    "var rows=document.querySelectorAll('" + S.LIVE_CHAT_ROW + "');"
    "for(var i=0;i<rows.length && !list;i++){var f=fiberOf(rows[i]);var lvl=0;"
    "while(f&&lvl<30){var p=propsOf(f);"
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
    "out.push({user:String(u.nickname||u.desensitized_nickname||''),text:text,"
    "sec_uid:String(u.sec_uid||''),uid:String(u.id||''),"
    "webcast_uid:String(u.webcast_uid||''),"
    "msg_id:String(it.msg_id||(pl.common&&pl.common.msg_id)||''),"
    "room_id:String((pl.common&&pl.common.room_id)||''),"
    "at_ms:Number(pl.event_time||0)*1000,"
    "user_flags:{private:Number(u.webcast_private||u.secret||0),"
    "ichat_restrict:Number(u.ichat_restrict_type||0),"
    "disable_ichat:Number(u.disable_ichat||0),"
    "block_status:Number(u.block_status||0),"
    "anonym:!!u.is_anonymous,mystery:Number(u.mystery_man||0),"
    "canceled:!!u.user_canceled,follow:String(u.follow_status||'')},"
    "source:'fiber'});}"
    "return {ok:true,count:out.length,kinds:kinds,rows:out};"
    "})()"
)


def collect_feed_once(page):
    """读页面内存里的弹幕数据模型。返回 {ok, rows, kinds, reason}。"""
    snap = page.eval_json(_LIVE_FEED_JS)
    if not isinstance(snap, dict):
        return {"ok": False, "rows": [], "reason": "eval_failed"}
    return snap


def collect_once(page):
    """读一次页面。返回 {room, rows, diagnostics}。"""
    snap = page.eval_json(_DANMAKU_JS)
    if not isinstance(snap, dict):
        return {"room": {}, "rows": [], "diagnostics": {"error": "eval_failed"}}
    snap.setdefault("room", {})
    snap.setdefault("rows", [])
    snap.setdefault("diagnostics", {})
    return snap


def room_info(page):
    """导航后读真实房间信息（短链会重定向，web_rid 要重新解析）。"""
    snap = collect_once(page)
    room = dict(snap.get("room") or {})
    room["web_rid"] = web_rid_from_url(room.get("url") or "")
    return {"room": room, "rows": snap.get("rows") or [], "diagnostics": snap.get("diagnostics") or {}}


def wait_chat(page, timeout=45, log=None):
    """等弹幕【真的渲染出第一行】。返回最后一次的 diagnostics。

    ⚠️ 真机教训（2026-09-19）：只等"容器可见"是不够的 ——
       直播间页面加载后，弹幕容器的 DOM 很快就在了，但虚拟列表要等 IM 订阅建立
       才渲染第一行，实测首次导航后可能超过 20 秒。
       如果这时候就开始采集，前几十秒会稳定采到 0 条 ——
       而"0 条"和"直播间没人说话"长得一模一样，正是本项目最怕的静默错误。
    """
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        snap = collect_once(page)
        last = snap.get("diagnostics") or {}
        if snap.get("rows"):
            if log:
                log("        弹幕开始渲染（候选节点 %s，可见 %s）"
                    % (last.get("candidates"), last.get("visible")))
            return last
        time.sleep(1.5)
    if log:
        log("[!] %ss 内没等到任何弹幕行（候选节点 %s，可见 %s）—— "
            "可能：未开播 / 需登录 / 页面还没渲染完 / 选择器失效" % (timeout, last.get("candidates"), last.get("visible")))
        log("    继续采集，但若结果一直是 0，请先人工看一眼窗口里到底有没有弹幕在滚。")
    return last


def collect(page, seconds=DEFAULT_SECONDS, limit=DEFAULT_LIMIT, log=print, every=PROBE_EVERY,
            source="auto"):
    """按轮次采集弹幕，直到时间用完 / 达到上限 / 撞到风控。

    返回 {rows, room, diagnostics, rounds, stopped_reason}。
    stopped_reason ∈ time / limit / captcha / login_required。
    """
    rows, order = {}, []
    room, last, rounds = {}, {}, 0
    stopped = "time"
    feed_ok = feed_fail = 0
    feed_kinds = {}
    deadline = time.time() + max(1.0, float(seconds))
    while time.time() < deadline:
        if douyin.check_captcha(page):
            stopped = "captcha"
            break
        if douyin.check_login_required(page):
            stopped = "login_required"
            break
        added = 0
        rounds += 1

        # ① 首选：页面内存里的弹幕数据模型（每条都带 sec_uid）
        feed = collect_feed_once(page) if source in ("auto", "fiber") else {"ok": False}
        if feed.get("ok"):
            feed_ok += 1
            for k, v in (feed.get("kinds") or {}).items():
                feed_kinds[k] = feed_kinds.get(k, 0) + v
            for r in feed.get("rows") or []:
                key = r.get("msg_id") or ("%s|%s" % (r.get("user"), r.get("text")))
                if key in rows:
                    continue
                r["at"] = time.time()
                rows[key] = r
                order.append(key)
                added += 1
        else:
            feed_fail += 1

        # ② 兜底/补充：DOM 文本（同时拿房间标题、状态、在线人数）
        snap = collect_once(page)
        last = snap.get("diagnostics") or {}
        if snap.get("room"):
            room = snap["room"]
            # 队列要带 room_id（来源内容归属，FR-04-04）；JS 只回传 url，这里补 web_rid
            room.setdefault("web_rid", web_rid_from_url(room.get("url") or ""))
        if not feed.get("ok"):
            for r in snap.get("rows") or []:
                key = r.get("row_key") or ("%s|%s" % (r.get("user"), r.get("text")))
                if key in rows:
                    continue
                r["at"] = time.time()
                r["room_id"] = room.get("web_rid")
                rows[key] = r
                order.append(key)
                added += 1

        if log and (rounds == 1 or added):
            log("        第 %2d 轮：新增 %2d 条 | 累计 %3d 条 | 数据源 %s"
                % (rounds, added, len(order), "页面数据模型" if feed.get("ok") else "DOM 兜底"))
        if len(order) >= limit:
            stopped = "limit"
            break
        crawlmod.pause(base=every, sigma=0.3, lo=0.7, hi=2.5)

    for r in rows.values():
        r.setdefault("room_id", room.get("web_rid"))
    return {"rows": [rows[k] for k in order], "room": room, "diagnostics": last,
            "rounds": rounds, "stopped_reason": stopped,
            "feed": {"ok_rounds": feed_ok, "fail_rounds": feed_fail, "kinds": feed_kinds}}


# ===================== 用户标识 =====================

_MASKED_RE = re.compile(r"^\*+$")

# 平台把"福袋/活动接龙"类弹幕的发送者匿名化：uid 固定 "111111"、昵称打码（聆***）、
# 且 payload.user 里根本没有 sec_uid。2026-09-19 在某亲子直播间实测：
# 3 分钟 21 条弹幕【全部】是这种（同一句活动文案），一个真人都拿不到。
ANON_UID = "111111"


def is_anonymized(row):
    """这条弹幕的发送者是不是被平台匿名化了（拿不到人，不是我们读不到）。"""
    if (row.get("uid") or "").strip() == ANON_UID:
        return True
    if not (row.get("sec_uid") or "").strip() and "***" in (row.get("user") or ""):
        return True
    return False


def is_plausible_sec_uid(value):
    """能不能拿它去开主页发私信。

    ⚠️ 弹幕 DOM 常给脱敏值（*****）或纯数字 uid —— 两者都【不是】sec_uid，
       拿去拼 /user/<x> 会打不开主页。宁可标记 not_locatable，也不发错人。
    """
    v = (value or "").strip()
    if len(v) < 8 or _MASKED_RE.match(v):
        return False
    if v.isdigit() or re.search(r"\s", v):
        return False
    return True


# ===================== 筛选 -> 队列 =====================

def build_queue(rows, room=None, keywords="", mode="seg", min_level="低意向",
                require_sec_uid=True, only_on_top=False):
    """弹幕 -> 私信队列（与 crawl.build_queue 产出的队列【同构】，dm.py 可直接吃）。

    关键词匹配直接复用 crawl.comment_matches（四档语义与评论截流保持一致），
    不另写一套匹配逻辑。
    """
    room = room or {}
    # 采集 JS 已经过滤过噪音，这里再过一遍：① 双保险；② 让【已抓到】的数据可以离线重筛
    noise = [r for r in rows if is_noise_text(r.get("text"))]
    rows = [r for r in rows if not is_noise_text(r.get("text"))]
    # 主播自己发的消息不是目标：房间标题里通常就含主播昵称
    title = (room.get("room_title") or "").strip()
    host = [r for r in rows
            if len((r.get("user") or "").strip()) >= 2 and (r.get("user") or "").strip() in title]
    rows = [r for r in rows if r not in host]
    matched, stats = crawlmod.filter_comments(rows, keywords, mode=mode)
    stats["noise_dropped"] = len(noise)
    stats["host_dropped"] = len(host)

    speak = {}
    for r in rows:
        nick = r.get("user") or ""
        speak[nick] = speak.get(nick, 0) + 1

    if only_on_top:
        # 只留"真的在最上层、能点到"的行：否则人工照着坐标去点会点到面板上
        matched = [r for r in matched if r.get("on_top") is not False]

    scored = []
    for r in matched:
        score, level, reasons = score_lead(r.get("text") or "", repeat=speak.get(r.get("user"), 1))
        scored.append(dict(r, score=score, level=level, reasons=reasons))
    scored.sort(key=lambda x: -x["score"])

    skip = {"not_locatable": 0, "duplicate_user": 0, "low_level": 0}
    queue, seen = [], set()
    for r in scored:
        if LEVEL_RANK[r["level"]] < LEVEL_RANK.get(min_level, 0):
            skip["low_level"] += 1
            continue
        uid = (r.get("sec_uid") or "").strip()
        if not is_plausible_sec_uid(uid):
            skip["not_locatable"] += 1
            if require_sec_uid:
                continue
            # 弹幕里拿不到标识是常态（真机 0%）：人工模式下仍然放行，
            # 用昵称做【弱键】占位，并明确标注它不能当身份用。
            uid = ""
        # 去重键：有 sec_uid 用 sec_uid；没有就用昵称（弱键，人工核对时要注意重名）
        dedupe_key = uid or ("nick:" + (r.get("user") or ""))
        if dedupe_key in seen:
            skip["duplicate_user"] += 1
            continue
        seen.add(dedupe_key)
        queue.append({
            "sec_uid": uid,
            "nick": r.get("user"),
            # 字段名沿用 comment（话术变量 {comment} 与 dm.py 都认这个名字），值是弹幕原文
            "comment": (r.get("text") or "")[:200],
            "matched_keyword": r.get("matched_keyword"),
            "source": "live_danmaku",
            "room_id": room.get("web_rid") or r.get("room_id"),
            "room_title": room.get("room_title"),
            "danmaku_at": r.get("at"),
            "score": r.get("score"),
            "level": r.get("level"),
            "reasons": r.get("reasons"),
            "on_top": r.get("on_top"),
            # 🔴 弹幕里没有用户标识（真机 0%），所以这条队列的键是【昵称】——
            #    它可改、可重复，只能当"人工核对时的一个线索"，不能当身份用。
            "key_type": "sec_uid" if uid else "nick_weak",
        })

    out = dict(stats)
    out["queue"] = len(queue)
    out["skip"] = skip
    out["anonymized"] = sum(1 for r in matched if is_anonymized(r))
    out["with_sec_uid"] = sum(1 for r in rows if is_plausible_sec_uid(r.get("sec_uid")))
    out["locatable_rate"] = (round(100.0 * out["with_sec_uid"] / len(rows), 1) if rows else 0.0)
    out["levels"] = {lv: sum(1 for r in scored if r["level"] == lv) for lv in LEVELS}
    return queue, scored, out
