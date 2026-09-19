"""抖音选择器注册表 —— 全项目【唯一】允许出现抖音选择器字符串的地方。

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
COMMENT_EDITORS = [
    '[data-e2e="comment-input"]',
    '[data-e2e="comment-input-inner"]',
    '[contenteditable="true"]',
]
COMMENT_SEND_BUTTONS = [
    '[data-e2e="comment-submit"]',
    '[data-e2e="comment-send"]',
]
COMMENT_REPLY_BUTTONS = [
    '[data-e2e="comment-reply"]',
    '[data-e2e="comment-item-reply"]',
]
COMMENT_REPLY_EDITORS = [
    '[data-e2e="comment-reply-input"]',
    '[data-e2e="comment-reply-editor"] [contenteditable="true"]',
    '[data-e2e="comment-item"] [data-e2e="comment-input-inner"]',
]
COMMENT_REPLY_SEND_BUTTONS = [
    '[data-e2e="comment-reply-submit"]',
    '[data-e2e="comment-reply-send"]',
]

# ---------- 直播公开评论（DOM 适配，live_verified_at remains None） ----------
LIVE_COMMENT_ITEMS = [
    '[data-e2e="live-chat-item"]',
    '[data-e2e="chat-item"]',
    '[class*="webcast-chatroom___item"]',
]
LIVE_COMMENT_CONTENT = [
    '[data-e2e="live-chat-content"]',
    '[data-e2e="chat-content"]',
]
LIVE_COMMENT_AUTHORS = [
    '[data-e2e="live-chat-author"]',
    '[data-e2e="chat-author"]',
]
LIVE_PUBLIC_EDITORS = [
    '[data-e2e="live-chat-input"]',
    '[data-e2e="chat-input"]',
]
LIVE_PUBLIC_SEND_BUTTONS = [
    '[data-e2e="live-chat-send"]',
    '[data-e2e="chat-send"]',
]

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
#    实测（给「暖暖💞」发的第二条），面板原文是：
#      「暖暖💞 大部分人第一步就走反了…」
#      「给对方发送的消息已达上限，对方回复或互关后才能继续发送消息」   ← 明确拒绝
#      「暖暖💞 这块你是想自己弄还是找人做？…」                        ← 其实只有这一条送达了
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
#    sidecar 不读取 cookie；登录态只由可见账号元素或登录弹窗判定，
#    无法确认时返回 unknown，不能把未知状态当成已登录。
LOGIN_REQUIRED_RE = "扫码登录"
# 登录弹窗（可见才算）
LOGIN_MODAL_DOM = [
    '[class*="login-mask"]',
    '[class*="loginMask"]',
    '[class*="login-panel"]',
    '[class*="loginPanel"]',
    '[class*="qrcode"]',
    '[class*="qr-code"]',
]
LOGIN_ACCOUNT_DOM = [
    '[data-e2e="user-info"]',
    '[data-e2e="user-avatar"]',
    '[data-e2e="nav-user"]',
]

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
}


def registry_report():
    """给 doctor 用：明确区分"离线过"与"真机过"。"""
    rows = []
    for key, meta in REGISTRY.items():
        live = meta["live_verified_at"] or "[未真机验证]"
        rows.append("%-16s confidence=%-6s live=%s  %s" % (key, meta["confidence"], live, meta["value"]))
    return "\n".join(rows)\n