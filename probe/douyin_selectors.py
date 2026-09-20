"""抖音选择器注册表 —— 全项目【唯一】允许出现抖音选择器字符串的地方。

来源与状态（严格遵守交接包 AGENTS.md §6 完成定义）：
  · 候选值来自 legacy/ 旧代码与 client/platform/selectors.js（P0 未验证骨架）
  · offline_verified_at：来自 P0 的离线 fixture 回归
  · live_verified_at：真机验证日期。【未验证就保持 None】——
    禁止填个日期让它"看起来完成"。

⚠️ 其他任何文件出现 data-e2e 等选择器字符串，都视为缺陷。
"""

# ---------- 评论区 ----------
#
# 🔴 2026-09-20 真机校正（video/7686815808756020563，Chrome 153，window.__ 只读探测）
#
#   可见评论容器里【只存在三个】data-e2e：
#       comment-item (x16) / video-comment-more (x16) / live-avatar (x4)
#
#   也就是说，下面这些曾经写进来的名字，真机上【一个都不存在】：
#       comment-content / comment-input / comment-submit
#       comment-reply / comment-item-reply
#       comment-reply-input / comment-reply-submit ...
#   它们只在自己的离线夹具里成立 —— 这正是 video_reply 一直 autoEligible=false 的原因。
#
#   真机上的实际形态：
#     · 评论正文 = 【裸节点】，时间/地区/点赞/「分享」「回复」是它的兄弟节点
#       -> 只能用「兄弟节点排除法」提取（见 douyin.body_text_js）
#     · 「回复」按钮 = 【裸 <span>】，无 class、无 data-e2e
#       -> 只能按文本严格匹配
#     · 点「回复」后，同一评论项内出现【恰好 1 个】[contenteditable=true]（Draft.js）
#     · 发送键 = 编辑器同行右侧的图标，激活时 path 填充为抖音品牌红
#       -> 按颜色判定，比类名稳；且内容为空时它不是红色（天然的"空内容不发送"保护）
#
#   ⚠️ 这些是【结构锚点】而非平台承诺；平台改版会失效，所以每项都带 live_verified_at。
COMMENT_LIST = '[data-e2e="comment-list"]'
COMMENT_ITEM = '[data-e2e="comment-item"]'
COMMENT_MORE = '[data-e2e="video-comment-more"]'
# ⚠️ 已证实真机不存在，仅为兼容历史离线夹具而保留；禁止用于真机定位。
COMMENT_CONTENT = '[data-e2e="comment-content"]'
FEED_COMMENT_ICON = '[data-e2e="feed-comment-icon"]'
NOTE_DETAIL = '.note-detail-container'
CONTENTEDITABLE = '[contenteditable=true]'

# 回复按钮 / 回复中状态：真机上是裸 spandiv，只能按文本定位
COMMENT_REPLY_BUTTON_TEXT = "回复"
COMMENT_REPLYING_TEXT = "回复中"
# 行内回复编辑器（Draft.js），必须限定在处于「回复中」的那一项内
COMMENT_REPLY_EDITOR_SELECTOR = CONTENTEDITABLE
# 编辑器右侧操作区（语义类名，真机存在）
COMMENT_INPUT_RIGHT_CT = '[class*="commentInput-right"]'
# 发送键激活色 = 抖音品牌红
COMMENT_SEND_ACTIVE_FILL = "rgb(254, 44, 85)"
# 正文提取时要排除的操作文案（时间/地区/纯数字另有规则）
COMMENT_NOISE_TEXTS = ["分享", "回复", "回复中", "作者", "置顶", "收起"]

# 顶层评论输入框（发布一条新评论，不是回复某个人）
COMMENT_EDITORS = [
    '[data-e2e="comment-input"]',
    '[data-e2e="comment-input-inner"]',
    '[contenteditable="true"]',
]
COMMENT_SEND_BUTTONS = [
    '[data-e2e="comment-submit"]',
    '[data-e2e="comment-send"]',
]
# ⚠️ 以下三项保留【仅为历史离线夹具】。真机定位请用
#    douyin.comment_reply_button / comment_reply_composer / comment_reply_send_button。
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

# ---------- 直播间弹幕：真机结构（2026-09-19，两个真实直播间） ----------
# 上面 LIVE_COMMENT_* / LIVE_PUBLIC_* 是【离线 fixture 的占位值】，不是当前平台事实：
# 真机上 [data-e2e="live-chat-item"] 等一个都不存在（实测命中数 0/0/0）。以下才是真机结构。
#   div.webcast-chatroom
#     └ div.webcast-chatroom___list            ← 虚拟列表（可滚动区）
#         └ div[data-index] > div.webcast-chatroom___item   ← 一行弹幕
#             └ div.<hash>.webcast-chatroom___item-wrapper
#                 └ div.<hash> > span.<等级徽章> + span.<"昵称："> + span.<正文>
# 正文节点：span.webcast-chatroom___content-with-emoji-text
# ⚠️ 行内【没有 data-sec-uid / data-user-id，也没有 a[href]】——DOM 只给得出昵称；
#    用户标识（sec_uid）只能从页面内存的弹幕数据模型里取，见 live.py 的 FEED_JS。
LIVE_CHAT_BOX = '[class*="webcast-chatroom"]'
LIVE_CHAT_LIST = '[class*="webcast-chatroom___list"]'
LIVE_CHAT_ROW = '[class*="webcast-chatroom___item"]:not([class*="item-wrapper"])'
LIVE_CHAT_ROW_ANY = '[class*="webcast-chatroom___item"]'
LIVE_CHAT_WRAPPER = '[class*="webcast-chatroom___item-wrapper"]'
LIVE_CHAT_CONTENT = '[class*="webcast-chatroom___content-with-emoji-text"]'
LIVE_CHAT_EDITOR = '[class*="webcast-chatroom___input-container"] [contenteditable=true]'
LIVE_CHAT_EDITOR_BOX = '[class*="webcast-chatroom___input-container"]'
LIVE_CHAT_SEND_CANDIDATES = [
    '[class*="webcast-chatroom___send"]',
    '[data-e2e*="chat-send"]',
    '[data-e2e*="send-btn"]',
]
# 作者/正文专用节点：真机结构把正文放在专用 span 里；离线夹具（tests/fixtures/live.html）
# 用 data-e2e 占位值把作者与正文分成两个节点。两条路都支持，顺序都是"真机在前、夹具在后"。
# 行标识属性（真机行上没有这些属性，夹具用 id/data-comment-id；取不到时才退化成 昵称|正文 指纹）
LIVE_ROW_KEY_ATTRS = ["data-comment-id", "data-id", "data-msg-id", "data-message-id", "data-key"]
LIVE_CHAT_AUTHOR_NODES = ['[data-e2e="live-chat-author"]', '[data-e2e="chat-author"]']
LIVE_CHAT_CONTENT_NODES = ['[data-e2e="live-chat-content"]', '[data-e2e="chat-content"]',
                           LIVE_CHAT_CONTENT]
# 候选顺序：真机结构在前，夹具/legacy 的 data-e2e 占位值在后 —— 同一段采集 JS 同时兼容两者，
# 不需要为夹具单独维护一套解析逻辑。
LIVE_CHAT_NODE_SELECTORS = [LIVE_CHAT_ROW, LIVE_CHAT_LIST, LIVE_CHAT_BOX,
                            '[data-e2e="live-chat-item"]', '[data-e2e="chat-item"]',
                            '[class*="webcast-chatroom___item"]']
LIVE_CHAT_FEED_MAX_HOPS = 30      # 从弹幕行沿 fiber.return 往上找 originalList 的最大层数
LIVE_NICK_MAX = 48
LIVE_TEXT_MAX = 260
LIVE_NICK_FALLBACK_RE = "^(.{1,32})[:：]\\s*(.{1,220})$"
LIVE_NOISE_TEXT_RE = ("^(进入直播间|加入了直播间|点赞了|为主播点赞了|关注了主播|分享了直播间|"
                      "送出|赠送|来了|拍了拍|加入了粉丝团|点亮了粉丝团)")
LIVE_NOISE_NICK_RE = "^(直播间|全部评论|互动消息|在线人数|发消息|说点什么)"

# ---------- 直播公开评论（离线 fixture 占位值，live_verified_at remains None） ----------
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
# 直播间页面的「已登录」信号（真机 2026-09-20）：live.douyin.com 上没有上面那些
# www.douyin.com 的账号元素，所以只靠它们会得到 unknown，进而拦掉所有公屏回复。
# 真机观察到：未登录会弹登录弹窗；已登录时页首出现账号头像，且公屏输入框已渲染。
# 主页不可用时的错误页（真机 2026-09-20：/user/<占位数字 uid> 会渲染它）
PROFILE_ERROR_DOM = [
    '[data-e2e="error-page"]',
]
LIVE_LOGIN_AVATAR_DOM = [
    '[class*="semi-avatar"] img',
    '[class*="avatar"] img',
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
    "commentMore":    {"value": COMMENT_MORE,   "offline_verified_at": None,        "live_verified_at": "2026-09-20", "confidence": "high"},
    "replyButton":    {"value": "text:" + COMMENT_REPLY_BUTTON_TEXT, "offline_verified_at": None, "live_verified_at": "2026-09-20", "confidence": "medium"},
    "replyEditor":    {"value": COMMENT_REPLY_EDITOR_SELECTOR + " @ " + COMMENT_REPLYING_TEXT, "offline_verified_at": None, "live_verified_at": "2026-09-20", "confidence": "high"},
    "replySendFill":  {"value": COMMENT_SEND_ACTIVE_FILL, "offline_verified_at": None,    "live_verified_at": "2026-09-20", "confidence": "medium"},
    # ⚠️ commentContent 真机不存在 —— 标 None 并在 note 里写明，避免被误用
    "commentContent": {"value": COMMENT_CONTENT,"offline_verified_at": "2026-09-18", "live_verified_at": None, "confidence": "low"},
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
    return "\n".join(rows)

# ---------- 私信面板：真机结构（2026-09-20，真实主页实测） ----------
# 真机事实：点开「私信」后面板里【没有】data-recipient-id / data-user-id，
# 也【没有】指向 /user/<sec_uid> 的链接（只有 客户端 / self / 下载 三个链接），
# 所以"按 data 属性或头部链接校验收件人"在真机上永远匹配不到（实测 count=0）。
# 真机可用的收件人信号是【会话头部标题 = 对方昵称】：
#   div.componentsEntrywrapper.imContainer
#     └ div.StackLayoutStackChatHeader... (标题 + 关注按钮)
#     └ div.messageMsgInputcontainer / messageEditor...  ← 输入框（占位符「发送消息」）
DM_MESSAGE_EDITOR_SCOPE = '[class*="messageEditor"]'
DM_CHAT_HEADER_TITLE = '[class*="ChatHeadertitle"]'
DM_CONVERSATION_SCOPES = ['[class*="messageMessageList"]', '[class*="MessageBox"]',
                          '[class*="messageList"]', '[class*="imChat"]']
