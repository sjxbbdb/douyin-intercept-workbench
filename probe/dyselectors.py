"""抖音选择器注册表 —— 全项目【唯一】允许出现抖音选择器字符串的地方。

⚠️ 文件名是 dyselectors.py 而不是 selectors.py，【不要改回去】：
   运行目录在 sys.path[0]，叫 selectors.py 会把标准库的 selectors 顶掉，
   http.server / socketserver（人工点击工作台要用）一 import 就报
   AttributeError: module 'selectors' has no attribute 'SelectSelector'。
   2026-09-19 实际踩到过，改名是唯一干净的修法。

来源与状态（严格遵守交接包 AGENTS.md §6 完成定义）：
  · 候选值来自 legacy/ 旧代码与 client/platform/selectors.js（P0 未验证骨架）
  · offline_verified_at：来自 P0 的离线 fixture 回归
  · live_verified_at：真机验证日期。【未验证就保持 None】——
    禁止填个日期让它"看起来完成"。

⚠️ 其他任何文件出现 data-e2e 等选择器字符串，都视为缺陷。
"""

# ---------- 评论区 ----------
COMMENT_LIST = '[data-e2e="comment-list"]'
COMMENT_ITEM = '[data-e2e="comment-item"]'
COMMENT_CONTENT = '[data-e2e="comment-content"]'
FEED_COMMENT_ICON = '[data-e2e="feed-comment-icon"]'
NOTE_DETAIL = '.note-detail-container'
CONTENTEDITABLE = '[contenteditable=true]'

# ---------- 私信 ----------
DM_PANEL_EDITORS = '[contenteditable=true],textarea,input'
# ---- 私信编辑器容器（2026-09-19 真机验证）----
# ⚠️ 教训：不能直接取页面第一个 contenteditable —— 抖音顶栏有搜索框
#    (data-e2e="searchbar-input")，会被误当成私信输入框。
#    必须先按私信容器限定作用域。
DM_EDITOR_SCOPES = [
    '[class*="messageEditor"]',
    '[class*="imChatEditorContainer"]',
    '[class*="messageMsgInput"]',
]
SEARCH_BAR = '[data-e2e="searchbar-input"]'

# ---- 私信发送按钮（2026-09-19 真机验证）----
# 真机上该按钮是【SVG 图标】，没有文字、没有 aria-label：
#   <svg class="messageMsgInputpublishBtn e2e-send-msg-btn" ...>  at (1651, 884) 32x32
# ⚠️ 教训：先前按"innerText === 发送"找，永远找不到；必须按 class 找。
DM_SEND_BUTTON = '[class*="e2e-send-msg-btn"]'
DM_SEND_FALLBACK = '[class*="publishBtn"]'
DM_SEND_TEXT = "发送"          # 兜底：某些版本可能有文字
DM_BUTTON_TEXT = "私信"      # innerText 去空白后严格相等
SEND_BUTTON_TEXT = "发送"

# ---- 发送【被平台拦下】的文案（2026-09-19 真机抓到的原文）----
# 🔴 为什么必须单独识别它：
#    "文案出现在会话面板里"这个判据，分不清两种情况——
#      ① 真的送达了
#      ② 被平台退回，但文案仍留在消息区（看起来一模一样）
#    实测（给某个用户发的第二条），面板原文是：
#      「用户A 大部分人第一步就走反了…」
#      「给对方发送的消息已达上限，对方回复或互关后才能继续发送消息」   ← 明确拒绝
#      「用户A 这块你是想自己弄还是找人做？…」                          ← 其实只有这一条送达了
#    当时被判成 sent_dom_confirmed（误报）。所以拦截文案必须直接否掉成功判定。
DM_SEND_FAILED_TEXTS = [
    "给对方发送的消息已达上限",
    "消息发送失败",
    "发送失败，请稍后重试",
]
# 这一条不等于"没发出去"——消息通常已经送达，但对方【回不了】，
# 于是整条漏斗断在"等回复"这一步。要单独记，不能和发送失败混为一谈。
DM_REPLY_BLOCKED_TEXT = "对方无法回复你的私信"

# ---------- 状态文案（真机撞出来的，不是猜的） ----------
# legacy/live_dm_worker.js:124,148 —— 陌生人私信被平台硬拦时的页面文案
STRANGER_DM_BLOCKED_RE = "仅关注的人可私信|只允许关注的人私信|暂不支持私信|无法私信|不能私信"
# legacy/reply_worker.js:189 —— 验证码中间页
#
# ⚠️ 2026-09-19 踩坑：原来只靠「正文里出现"验证码"」判定，
#    结果在搜索页被一条视频简介（"...手机号是收不到验证码的"）误判成验证码，
#    直接中止了整条链路。正文匹配太脆，必须加 DOM 判据。
#
# 判定优先级（见 douyin.check_captcha）：
#   1) document.title 含「验证码」          -> 强信号
#   2) 存在可见的验证码容器/iframe          -> 强信号
#   3) 正文出现【完整】的强提示句            -> 兜底（注意是完整句，不是单个词）
CAPTCHA_TITLE = "验证码"
CAPTCHA_DOM = [
    'iframe[src*="captcha"]',
    '[class*="captcha"]',
    '[class*="Captcha"]',
    '[id*="captcha"]',
    '[id*="Captcha"]',
]
# 真验证码的 frame URL 特征（区别于常驻的 rmc-nocaptcha 无感验证组件）
VERIFY_FRAME_MARKS = ["verifycenter/captcha", "captcha/v2"]
CAPTCHA_TEXT_STRONG = ["验证码中间页", "请输入验证码", "请完成安全验证", "拖动滑块完成拼图"]
# legacy/live_dm_worker.js:189 —— 登录态失效
#
# 🔴 2026-09-19 之后的真机教训：正文匹配「登录后」会把【已登录】误判成未登录——
#    搜索页里一条视频简介写着"一旦退出登录后，再次登录就要验证手机号"就触发了。
#    现在的主判据是 cookie（sessionid / sid_tt / sid_guard，均为 HttpOnly，JS 读不到），
#    下面这串正文只保留给「确实没有 Network 域可用」时的极弱兜底，且不再用于主判据。
LOGIN_REQUIRED_RE = "扫码登录"
# 登录弹窗（可见才算）：仅在拿不到 cookie 时使用的兜底判据
LOGIN_MODAL_DOM = [
    '[class*="login-mask"]',
    '[class*="loginMask"]',
    '[class*="login-panel"]',
    '[class*="loginPanel"]',
    '[class*="qrcode"]',
    '[class*="qr-code"]',
]

# ---------- 直播间（弹幕） ----------
# 候选值来源：archive/v3/legacy/live_dom_collector.js:349-357 的 7 个模糊匹配。
# ⚠️ archive/v3 的选择器【不是】当前平台事实（AGENTS.md §工程边界）——
#    这里一律 live_verified_at=None，第一次真机跑通后再回填日期。
# 教训（legacy 实测）：这些模糊匹配会同时命中【容器】与【行】，
#    所以不能"每个命中节点都当一行弹幕"，必须再取最深层（见 live.py 的容器回声过滤）。
# 🔴 2026-09-19 真机（两个真实直播间）抓到的真实结构：
#   div.webcast-chatroom
#     └ div.pZzS8QUV > div.Y3jYZAlL
#         └ div.webcast-chatroom___list            ← 虚拟列表（可滚动区）
#             └ div.gOr3NRD4 (撑高) > div[style*=translateY]
#                 └ div[data-index="13"]
#                     └ div.webcast-chatroom___item  ← 一行弹幕
#                         └ div.Cl4EfhXg.webcast-chatroom___item-wrapper
#                             └ div.NkS2Invn > span.(等级徽章) + span.(昵称"xx：") + span.(正文)
# ⚠️ 行内【没有 data-sec-uid / data-user-id，也没有 a[href]】——只有昵称文字。
LIVE_CHAT_BOX = '[class*="webcast-chatroom"]'
LIVE_CHAT_LIST = '[class*="webcast-chatroom___list"]'
LIVE_CHAT_ROW = '[class*="webcast-chatroom___item"]'
LIVE_CHAT_CONTENT = '[class*="webcast-chatroom___content-with-emoji-text"]'
# 弹幕行的正文里，正文与昵称是【同一行】的 "昵称：正文"（不是换行！）——
# 靠下面的 LIVE_NICK_FALLBACK_RE 拆开，真机已确认有效。
LIVE_CHAT_NODE_SELECTORS = [
    LIVE_CHAT_ROW,
    LIVE_CHAT_LIST,
    LIVE_CHAT_BOX,
    '[data-e2e*="chat"]',
    '[data-e2e*="comment"]',
    '[class*="webcast-chatroom"]',
    '[class*="chatroom"]',
    '[class*="danmu"]',
    '[class*="bullet"]',
    '[class*="message"]',
]
# 弹幕行的稳定键与用户标识属性（legacy live_dom_collector.js:331-332）
LIVE_ROW_KEY_ATTRS = ["data-id", "data-msg-id", "data-message-id", "data-comment-id", "data-key"]
LIVE_SEC_UID_ATTRS = ["data-sec-uid", "data-secuid", "data-sec-open-id"]
LIVE_USER_ID_ATTRS = ["data-user-id", "data-uid"]
# 昵称/正文长度上限。legacy 有两套互相矛盾的阈值（退化正则 32/220、parseRow 48/260），
# 新实现统一到这里，避免"同一件事两个标准"。
LIVE_NICK_MAX = 48
LIVE_TEXT_MAX = 260
# 一行弹幕通常是"昵称换行 正文"；退化成单行时可能是"昵称: 正文"
LIVE_NICK_FALLBACK_RE = "^(.{1,32})[:：]\\s*(.{1,220})$"
# 噪音：两条都是【行首锚定】，不能改成包含匹配（会把真实弹幕误杀，legacy 有注释留档）
# 2026-09-19 真机补充：为主播点赞了 / 加入了粉丝团 / 点亮了粉丝团（legacy 词表没有覆盖）
LIVE_NOISE_TEXT_RE = ("^(进入直播间|加入了直播间|点赞了|为主播点赞了|关注了主播|分享了直播间|"
                      "送出|赠送|来了|拍了拍|加入了粉丝团|点亮了粉丝团)")
LIVE_NOISE_NICK_RE = "^(直播间|全部评论|互动消息|在线人数|发消息|说点什么)"
# 房间状态与在线人数（legacy live_dom_collector.js:376-378）
LIVE_ONLINE_RE = "(?:在线人数|在线|观看|人气)\\s*[:：]?\\s*([0-9.,万千]+)"
LIVE_ENDED_RE = "直播已结束|直播结束|回放"
LIVE_WAITING_RE = "加载中|进入直播间"

# ---------- 网络接口（判定发送成功的唯一依据，红线 2） ----------
COMMENT_PUBLISH_URL_MARK = "comment/publish"
# 🔴 私信发送接口【尚未确认】
# 2026-09-19 实测：捕获到的两个 POST 都不是发送接口
#   /aweme/v1/web/im/get/online_feedback/entrance/   <- 入口/心跳
#   www-hj.douyin.com/cloudpush/update_sender/       <- 心跳
# 推断：真正的发送很可能走 WebSocket（旧项目的 _ws*_frames.json 即为此类抓取）。
# ⚠️ 在确认之前，【不得】用"任意 POST 返回 status_code=0"来判定发送成功 —— 那是误报。
DM_SEND_URL_MARK = ""          # 空 = 未确认；此时不允许宣告 sent_confirmed

REGISTRY = {
    "commentList":    {"value": COMMENT_LIST,   "offline_verified_at": "2026-09-18", "live_verified_at": None, "confidence": "high"},
    "commentItem":    {"value": COMMENT_ITEM,   "offline_verified_at": "2026-09-18", "live_verified_at": None, "confidence": "high"},
    "commentContent": {"value": COMMENT_CONTENT,"offline_verified_at": "2026-09-18", "live_verified_at": None, "confidence": "high"},
    "dmPanelEditors": {"value": DM_PANEL_EDITORS,"offline_verified_at": None,        "live_verified_at": None, "confidence": "medium"},
    "dmEditorScope":  {"value": DM_EDITOR_SCOPES[0],"offline_verified_at": None,      "live_verified_at": "2026-09-19", "confidence": "high"},
    "searchBar":      {"value": SEARCH_BAR,      "offline_verified_at": None,        "live_verified_at": "2026-09-19", "confidence": "high"},
    "dmSendButton":   {"value": DM_SEND_BUTTON,  "offline_verified_at": None,        "live_verified_at": "2026-09-19", "confidence": "high"},
    "noteDetail":     {"value": NOTE_DETAIL,    "offline_verified_at": "2026-09-18", "live_verified_at": None, "confidence": "high"},
    # ---- 直播间：offline = live_selftest.py 的 fixture 回归；live = 2026-09-19 两个真实直播间 ----
    # ⚠️ live_verified_at 只表示"这个字符串在真机上命中/生效过"，
    #    【不表示】这条链路能跑通 —— 弹幕行里根本没有用户标识（见下 liveSecUidAttrs）。
    "liveChatBox":    {"value": LIVE_CHAT_BOX, "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "high"},
    "liveChatList":   {"value": LIVE_CHAT_LIST, "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "high"},
    "liveChatRow":    {"value": LIVE_CHAT_ROW, "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "high"},
    "liveChatContent": {"value": LIVE_CHAT_CONTENT, "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "high"},
    "liveChatNodes":  {"value": "（模糊全集，含未观察到的 danmu/bullet/message 等）", "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "low"},
    "liveRowKeyAttrs": {"value": ",".join(LIVE_ROW_KEY_ATTRS), "offline_verified_at": "2026-09-19", "live_verified_at": None, "confidence": "low"},
    # 🔴 真机实测：弹幕行【没有】这些属性（也没有 a[href]），所以取不到 sec_uid。
    #    保留候选值是为了平台改版后能自动恢复，不是因为现在有效。
    "liveSecUidAttrs": {"value": ",".join(LIVE_SEC_UID_ATTRS) + "（真机实测：弹幕行内不存在）", "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "low"},
    "liveNoiseRe":    {"value": LIVE_NOISE_TEXT_RE, "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "medium"},
    "liveNickFallbackRe": {"value": LIVE_NICK_FALLBACK_RE, "offline_verified_at": "2026-09-19", "live_verified_at": "2026-09-19", "confidence": "high"},
    "liveRoomStatus": {"value": LIVE_ONLINE_RE, "offline_verified_at": "2026-09-19", "live_verified_at": None, "confidence": "low"},
}


def registry_report():
    """给 doctor 用：明确区分"离线过"与"真机过"。"""
    rows = []
    for key, meta in REGISTRY.items():
        live = meta["live_verified_at"] or "[未真机验证]"
        rows.append("%-16s confidence=%-6s live=%s  %s" % (key, meta["confidence"], live, meta["value"]))
    return "\n".join(rows)
