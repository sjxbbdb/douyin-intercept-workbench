"""话术库 —— 模板 + 变量 + 均衡轮换。

设计依据（2026-09-19 讨论结论）：

1. 【方向】落点是「引导对方看我主页 / 关注我」。
   平台自己的提示是「对方**回复或关注**你之前，只能发送一条文字消息」——
   所以"关注"和"回复"一样能解锁，引导关注是成立的。

2. 【为什么不是纯随机的 N 选 1】
   随机轮换只打散【字面】相似度，打不散【语义】相似度。
   平台判定 spam 看的是模式（见交接包 plans/B-Agent开发指南 的论证）。
   所以本库的每条模板是【结构/角度】不同，而不是换词。

   🔴 2026-09-19 改动：模板里【不再引用对方评论】（原先是「{comment}」这种框起来的写法）。
      原因：引用出来的效果是这样的——
          "ActI 「我就喜欢codex，对claude code…」这块我熟，主页有整理，需要了看一眼就行"
      把对方的评论原样框回去，既生硬，截断后还带个省略号，很像机器人。
      代价（必须知道）：少了 {comment} 之后，同一条模板对不同人几乎是同一句话，
      只剩 {nick} 不一样 —— 唯一性下降，spam 特征上升。
      → 因此发送节奏（间隔、每日条数）比话术本身更关键，别为了快把间隔压短。

3. 【为什么用均衡轮换而不是纯随机】
   只有 1 条机会/人，所以必须能比较"哪条话术回复率高"。
   纯随机会让样本分布不均，无法统计。改为"最少使用的优先、并列时随机"，
   并把 template_id 写进账本 → 跑够样本后可按回复率淘汰尾部。

4. 【红线】模板里不许出现联系方式。
   诱导第三方是平台明确打击项。_assert_safe() 作为兜底校验。
"""
import random
import re

# 每条模板：id / angle（角度，用于复盘）/ text（含变量）
# 变量：{nick} 昵称、{comment} 引用对方评论、{video_title} 视频标题
TEMPLATES = [
    {
        "id": "T1",
        "angle": "共情踩坑",
        "text": "{nick}，这个坑我当初也踩过，后来把绕开的办法整理在自己主页了",
    },
    {
        "id": "T2",
        "angle": "直接给答案",
        "text": "{nick} 你问的这个我刚好写过，细节放主页了，有空可以去翻下",
    },
    {
        "id": "T3",
        "angle": "反问式（换回复）",
        "text": "{nick} 这块你是想自己弄还是找人做？两种走法差别挺大，我主页写了对比",
    },
    {
        "id": "T4",
        "angle": "同好口吻",
        "text": "{nick} 也在研究这个啊，我折腾这问题折腾了挺久，主页留了点记录",
    },
    {
        "id": "T5",
        "angle": "避坑提醒",
        "text": "{nick} 提醒一句，这里有个容易忽略的点，我主页写了怎么避开",
    },
    {
        "id": "T6",
        "angle": "简短直接",
        "text": "{nick} 这块我熟，主页有整理，需要了看一眼就行",
    },
    {
        "id": "T7",
        "angle": "反常识钩子",
        "text": "{nick} 大部分人第一步就走反了，我把正确顺序放主页了",
    },
    {
        "id": "T8",
        "angle": "顺手分享",
        "text": "{nick} 刚好刷到你这条，这正好是我在做的事，主页放了些资料可以去看看",
    },
]

# 兜底：这些模式一律拒绝（诱导第三方 / 直接给联系方式）
_FORBIDDEN = [
    r"微信", r"VX", r"\bvx\b", r"加我", r"私聊", r"扣扣", r"\bQQ\b",
    r"1[3-9]\d{9}",                       # 手机号
    r"[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+",   # 邮箱
    r"二维码", r"扫码",
]

MAX_COMMENT_CHARS = 22       # 引用对方评论时截断长度
MAX_TEXT_CHARS = 120         # 整条消息上限（平台单条 500 字，我们保持短）


def _clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _shorten(value, limit):
    t = _clean(value)
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "…"


def usage_counts(ledger):
    """从账本统计每条模板用过多少次。"""
    counts = {}
    try:
        rows = ledger.all()
    except Exception:
        return counts
    for r in rows:
        if r.get("kind") == "result" and r.get("template_id"):
            counts[r["template_id"]] = counts.get(r["template_id"], 0) + 1
    return counts


def pick_template(ledger):
    """均衡轮换：最少使用的优先；并列时随机。

    这样每条模板曝光次数接近，跑够样本后可以按回复率比较、淘汰尾部。
    """
    counts = usage_counts(ledger)
    lowest = min(counts.get(t["id"], 0) for t in TEMPLATES)
    pool = [t for t in TEMPLATES if counts.get(t["id"], 0) == lowest]
    return random.choice(pool)


def render(template, nick="", comment="", video_title=""):
    """渲染话术。{comment} 仍然支持，但当前模板库【都不再使用它】（见文件头第 2 条）。"""
    text = template["text"]
    text = text.replace("{nick}", _shorten(nick, 12) or "朋友")
    text = text.replace("{comment}", _shorten(comment, MAX_COMMENT_CHARS) or "这个")
    text = text.replace("{video_title}", _shorten(video_title, 14))
    text = _clean(text)
    return text[:MAX_TEXT_CHARS]


def assert_safe(text):
    """兜底校验：命中禁止模式就返回 (False, 原因)。

    ⚠️ 这是最后一道闸。话术是人工写的，但变量来自采集数据，
       理论上可能被注入奇怪内容，所以发送前仍要过一遍。
    """
    for pat in _FORBIDDEN:
        if re.search(pat, text, re.IGNORECASE):
            return False, "forbidden_pattern:%s" % pat
    if not text or len(text) < 6:
        return False, "text_too_short"
    return True, "ok"


def stats(ledger):
    """给界面/日志用：每条模板用了多少次。"""
    counts = usage_counts(ledger)
    return [(t["id"], t["angle"], counts.get(t["id"], 0)) for t in TEMPLATES]
