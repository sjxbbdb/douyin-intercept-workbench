"""关键词搜视频 -> 抓评论 -> 关键词筛评论 -> 产出私信队列。

三轮真机验证后的实现（Chrome 153 / Windows / 已登录抖音号）：

1) 搜视频【以平台接口响应体为准】
   搜索页的数据来自 https://www.douyin.com/aweme/v1/web/general/search/single/
   响应体 {status_code, data[], cursor, has_more}，data[i].aweme_info 里
   aweme_id / desc / author.sec_uid / statistics(digg_count, comment_count...) 全是结构化字段。
   DOM 卡片（[id^="waterfall_item_<aweme_id>"]）里【没有 <a> 链接】，
   标题还被拆成一堆 span、连日期都混在 innerText 里 —— 只作兜底。

2) 抓评论【以平台接口响应体为准】同理
   https://www-hj.douyin.com/aweme/v1/web/comment/list/?...&aweme_id=<id>&cursor=..&count=..
   响应体里的 comments[] 直接带 user.sec_uid —— 私信环节最需要的字段。
   这也是红线 2 的正确姿势：以平台响应为准，不以 DOM 现象为准。

3) 关键词语义（移植自 pipeline.js，并补上精度档位）
   · 视频匹配：先整串连续命中，否则退化为「分词 AND 命中」（顺序无关）
     —— 抖音标题几乎不会连续包含"怎么充值codex"，整串匹配会把结果清成 0
   · 评论匹配：见 filter_comments 的 4 个档位，默认 seg（词级 AND），
     any 是 pipeline.js 的老语义（任意字命中，召回优先、噪声大）

4) 验证码：一律【暂停并等人工】，绝不自动识别。
5) 页面被遮挡（visibilityState=hidden）时滚轮会超时、懒加载不触发 —— 见 douyin.scroll_by。
"""
import json
import os
import random
import re
import time
from urllib.parse import quote

import cdp as cdpmod
import douyin

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")


# ===================== 节奏（风控相关，别乱调） =====================
#
# 🔴 真机教训：一口气连滚十几轮（固定 2 秒间隔）之后，抖音弹出了【真验证码】
#    （rmc.bytedance.com/verifycenter/captcha/v2 的居中 iframe）。
#    固定间隔 + 密集动作是最容易被识别的机器人特征（交接包 §2.11）。
#    这里的做法：间隔取对数正态随机（偶尔长、多数短），并可整体调慢。

def pause(base=2.0, sigma=0.35, lo=0.6, hi=3.0, log=None):
    """对数正态随机间隔。返回实际睡了多少秒。"""
    try:
        k = random.lognormvariate(0.0, sigma)
    except Exception:
        k = 1.0
    k = min(max(k, lo), hi)
    secs = max(0.2, base * k)
    time.sleep(secs)
    return secs

SEARCH_URL = "https://www.douyin.com/search/%s?type=general"
SEARCH_API_MARK = "general/search/single"
COMMENT_API_MARK = "comment/list"


# ===================== 关键词语义（移植自 pipeline.js） =====================

IGNORED_KEYWORD_CHARS = set(
    " \t\r\n,，、;；|｜/\\。.!！?？:：\"'“”‘’()[]{}<>《》【】（）-_=+~`@#$%^&*"
)

INTERROGATIVE_PREFIXES = ["怎么", "如何", "怎样", "咋样", "咋", "哪里", "在哪", "哪个", "什么",
                          "有没有", "求", "教我", "请问", "想问", "麻烦"]
FUNCTION_WORDS = {"的", "了", "吗", "呢", "吧", "啊", "呀", "和", "与", "或", "在", "是",
                  "我", "你", "他", "它", "要", "想", "会", "能", "可以", "这个", "那个", "一下"}

_SPLIT_RE = re.compile(r"[\s,，。.!！?？、;；:：/|]+")
_TOKEN_RE = re.compile(r"[\u4e00-\u9fa5]+|[A-Za-z0-9]+")


def extract_keyword_chars(value):
    """评论匹配的 any 档用：抽出关键词里的所有实义字符（去重），任意字命中即算命中。"""
    out = []
    seen = set()
    for ch in str(value or "").lower():
        if ch in IGNORED_KEYWORD_CHARS or ch in seen:
            continue
        seen.add(ch)
        out.append(ch)
    return out


def matches_any_keyword_char(text, keyword_chars):
    src = str(text or "").lower()
    return any(ch in src for ch in keyword_chars)


def normalize_search_text(value):
    return re.sub(r"[\s\u200b]+", "", str(value or "").lower())


def keyword_segments(keyword):
    """视频关键词分词：按空白/标点切，再按「中文↔英文数字」边界切，剥掉疑问/功能前缀。"""
    raw = str(keyword or "").strip()
    if not raw:
        return []
    parts = []
    for piece in _SPLIT_RE.split(raw):
        parts.extend(_TOKEN_RE.findall(piece))
    out = []
    for part in parts:
        low = part.lower()
        if re.fullmatch(r"[\u4e00-\u9fa5]+", part):
            for p in INTERROGATIVE_PREFIXES:
                if low.startswith(p) and len(low) > len(p):
                    low = low[len(p):]
                    break
            if len(low) < 2 or low in FUNCTION_WORDS:
                continue
            out.append(low)
        else:
            if len(low) < 2:
                continue
            out.append(low)
    seen, uniq = set(), []
    for s in out:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq


def comment_segments(keyword):
    """评论关键词的「词」。

    ⚠️ 与 keyword_segments 的区别：这里【不剥疑问前缀】。
       "求带" 属于评论关键词，剥掉"求"只剩一个"带"，会把整个关键词废掉。
    """
    out = []
    for piece in _SPLIT_RE.split(str(keyword or "")):
        out.extend(_TOKEN_RE.findall(piece))
    return [s.lower() for s in out if s]


def video_matches_keyword(video_text, keyword):
    """视频标题是否匹配关键词（bool）。保留给老调用方；新代码用 video_relevance。"""
    src = normalize_search_text(video_text)
    target = normalize_search_text(keyword)
    if not target:
        return True
    if target in src:
        return True
    segs = keyword_segments(keyword)
    if not segs:
        return False
    return all(s in src for s in segs)


# ===================== 视频相关度（找视频模块的「相关度」） =====================
#
# 架构依据：找视频模块固定流程第 4 步要求返回
#     「视频标题、作者、链接、【相关度】等候选结果」，
# 并且模块的职责就是「发现和筛选视频」。
#
# 基线只有 video_matches_keyword 的一个 bool —— 宿主既没法排序候选，
# 也没法按阈值筛选（要么全要、要么按 bool 一刀切）。
#
# 打分只用【我们自己就能观察到的信号】（搜索关键词 vs 视频标题），
# 不引入任何平台接口之外的推断；规则确定、可解释、纯离线可测。
#
#   1. 用户写的【每个关键词都整串连续】出现在标题里：基础 70，再按首次出现位置加分
#        （开头 +30 / 前 10 字 +20 / 其它 +10），最高 100；
#   2. 否则退化为分词命中：全部分词都出现（顺序无关）给 60；
#   3. 只命中部分分词：按命中比例给分（40 × 比例，四舍五入，上限 39）；
#   4. 一个都没命中：0。
#
# 为什么退化那一层必须存在：抖音标题几乎不会连续包含「怎么充值codex」这种提问式关键词，
# 只认整串会把结果清成 0（这条来自 pipeline.js 的真机结论）。
#
# ⚠️ 相关度衡量的是【标题与关键词的字面相关】，不是视频质量。
#    热度（点赞/评论数）是另一个维度，已经在候选结果里单独给出，不混进这个分数。
RELEVANCE_EXACT_BASE = 70
RELEVANCE_EXACT_BONUS_HEAD = 30
RELEVANCE_EXACT_BONUS_EARLY = 20
RELEVANCE_EXACT_BONUS_LATE = 10
RELEVANCE_ALL_SEGMENTS = 60
RELEVANCE_PARTIAL_BASE = 40
RELEVANCE_EARLY_CHARS = 10


def video_relevance(video_text, keyword):
    """视频与关键词的相关度（0-100）。返回 dict，字段见下面的注释。

    返回：
      score            0-100 的整数
      reason           exact_phrase / all_segments / partial_segments / no_match / empty_keyword
      matchedSegments  命中的分词
      missingSegments  未命中的分词
      exact            是否整串连续命中
      position         整串首次出现的字符位置（未整串命中时为 None）
    """
    parts = split_keywords(keyword)          # 用户实际写下的每个关键词
    segs = keyword_segments(keyword)         # 分词（中文↔英文边界 + 剥疑问前缀）
    out = {"score": 0, "reason": "no_match", "matchedSegments": [],
           "missingSegments": list(segs), "exact": False, "position": None,
           "matchedKeywords": [], "missingKeywords": list(parts)}
    if not normalize_search_text(keyword):
        out["reason"] = "empty_keyword"
        return out
    src = normalize_search_text(video_text)
    if not src:
        return out

    # 第 1 档：用户写的每个关键词都【整串连续】出现在标题里
    hits, miss = [], []
    for part in parts:
        (hits if normalize_search_text(part) in src else miss).append(part)
    if parts and not miss:
        position = min(src.find(normalize_search_text(part)) for part in hits)
        if position == 0:
            bonus = RELEVANCE_EXACT_BONUS_HEAD
        elif position <= RELEVANCE_EARLY_CHARS:
            bonus = RELEVANCE_EXACT_BONUS_EARLY
        else:
            bonus = RELEVANCE_EXACT_BONUS_LATE
        out.update({"score": min(100, RELEVANCE_EXACT_BASE + bonus),
                    "reason": "exact_phrase", "exact": True, "position": position,
                    "matchedSegments": list(segs), "missingSegments": [],
                    "matchedKeywords": hits, "missingKeywords": []})
        return out

    # 第 2/3 档：退化为分词命中（顺序无关）——视频标题几乎不会连续包含长提问式关键词
    if not segs:
        out.update({"matchedKeywords": hits, "missingKeywords": miss})
        return out
    seg_hit = [s for s in segs if s in src]
    seg_miss = [s for s in segs if s not in src]
    if not seg_miss:
        out.update({"score": RELEVANCE_ALL_SEGMENTS, "reason": "all_segments",
                    "matchedSegments": seg_hit, "missingSegments": [],
                    "matchedKeywords": hits, "missingKeywords": miss})
        return out
    if seg_hit:
        ratio = len(seg_hit) / float(len(segs))
        score = int(round(RELEVANCE_PARTIAL_BASE * ratio))
        out.update({"score": min(score, RELEVANCE_PARTIAL_BASE - 1),
                    "reason": "partial_segments",
                    "matchedSegments": seg_hit, "missingSegments": seg_miss,
                    "matchedKeywords": hits, "missingKeywords": miss})
        return out
    out.update({"matchedKeywords": hits, "missingKeywords": miss})
    return out


def split_keywords(raw):
    """把 "求带,多少钱 怎么买" 切成 ["求带","多少钱","怎么买"]。"""
    if isinstance(raw, (list, tuple, set)):
        return [str(x).strip() for x in raw if str(x).strip()]
    return [p for p in _SPLIT_RE.split(str(raw or "")) if p]


# ===================== 评论关键词筛选（4 个档位） =====================
#
# 为什么要分档：pipeline.js 的老语义是「任意【字】命中」（求带 -> 求 / 带 各算命中），
# 召回高但噪声极大（"多少钱" 会命中任何带"多"字的评论）。
# 私信是有额度、有账号风险的动作，把档位摆到台面上，由使用者按用途选。
#
#   phrase : 评论里出现【任意一个】关键词的原串        —— 最精确
#   seg    : 任意一个关键词的【全部分词】都出现        —— 默认，顺序无关
#   all    : 【所有】关键词都命中（每个按 seg 判）      —— 多词求交集
#   any    : 任意字命中                                —— pipeline.js 老语义，召回优先

MATCH_MODES = ("phrase", "seg", "all", "any")
MATCH_MODE_LABELS = {
    "phrase": "整串命中（任一关键词原样出现）",
    "seg": "词级命中（任一关键词的全部分词都出现）",
    "all": "全词命中（所有关键词都必须命中）",
    "any": "任意字命中（pipeline.js 老语义，召回优先）",
}


def comment_matches(text, keywords, mode="seg"):
    """命中返回【命中说明】(字符串)，未命中返回 None。keywords 为空 = 全收，返回 ""。"""
    if not keywords:
        return ""
    src = normalize_search_text(text)
    if not src:
        return None

    if mode == "any":
        chars = []
        for kw in keywords:
            chars.extend(extract_keyword_chars(kw))
        hit = sorted({c for c in chars if c in src})
        return "".join(hit) if hit else None

    if mode == "all":
        hits = []
        for kw in keywords:
            segs = comment_segments(kw) or [normalize_search_text(kw)]
            if not all(s in src for s in segs):
                return None
            hits.append(kw)
        return ",".join(hits)

    if mode == "phrase":
        for kw in keywords:
            if normalize_search_text(kw) in src:
                return kw
        return None

    # 默认 seg
    for kw in keywords:
        segs = comment_segments(kw) or [normalize_search_text(kw)]
        if segs and all(s in src for s in segs):
            return kw
    return None


def filter_comments(comments, comment_keywords="", mode="seg", min_digg=0,
                    exclude_keywords=""):
    """按评论关键词筛评论。返回 (命中列表, 统计)。

    统计里 modes 字段会给出【全部 4 个档位】的命中数，方便一眼看出该松还是该紧，
    不必来回试参数。

    排除词（exclude_keywords）——架构依据 images/11-comment-area-business 流程一
    「关键词、排除词与去重」：

      · 语义：一条评论【先按关键词命中】，再看是否命中任一排除词；命中排除词就【丢弃】。
        排除词优先级高于关键词，且与关键词共用同一个档位（mode）。
      · 统计里的 excluded 只数【本来命中关键词、却被排除词挡掉】的条数 ——
        这才是可调参的数字；不命中关键词的评论本来就不会进来，数进去只会误导。
      · 为什么要排除词：关键词为了召回必然放宽（实测「可以」在 313 条里命中 44 条），
        但公开回复与私信必须避开同行、广告、无关人群 —— 那些由排除词兜底。
    """
    keywords = split_keywords(comment_keywords)
    exclude = split_keywords(exclude_keywords)
    if mode not in MATCH_MODES:
        raise ValueError("未知 match mode: %s（可选 %s）" % (mode, "/".join(MATCH_MODES)))

    stats = {
        "total": len(comments),
        "matched": 0,
        "empty_text": 0,
        "low_digg": 0,
        "no_sec_uid": 0,
        "excluded": 0,
        "mode": mode,
        "keywords": keywords,
        "exclude_keywords": exclude,
        "modes": {},
    }
    for m in MATCH_MODES:
        stats["modes"][m] = sum(1 for c in comments if comment_matches(c.get("text"), keywords, m))

    matched = []
    for c in comments:
        if not (c.get("text") or "").strip():
            stats["empty_text"] += 1
            continue
        hit = comment_matches(c.get("text"), keywords, mode)
        if hit is None:
            continue
        if exclude and comment_matches(c.get("text"), exclude, mode) is not None:
            stats["excluded"] += 1
            continue
        if (c.get("digg") or 0) < min_digg:
            stats["low_digg"] += 1
            continue
        row = dict(c)
        row["matched_keyword"] = hit
        row["match_mode"] = mode
        matched.append(row)
        if not row.get("sec_uid"):
            stats["no_sec_uid"] += 1
    stats["matched"] = len(matched)
    return matched, stats


# ===================== 搜索取视频（接口优先 + DOM 兜底） =====================

WATERFALL_JS = (
    "JSON.stringify(Array.from(document.querySelectorAll('[id^=\"waterfall_item_\"]'))"
    ".map(function(e){return {id:e.id,text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,200)};}))"
)


def parse_search_item(item):
    """把 general/search/single 响应体里的一条 data[i] 解析成视频记录。"""
    aw = item.get("aweme_info") or {}
    if not aw:
        lst = item.get("aweme_list") or []
        if lst:
            aw = lst[0] or {}
    aweme_id = aw.get("aweme_id")
    if not aweme_id:
        return None
    author = aw.get("author") or {}
    st = aw.get("statistics") or {}
    video = aw.get("video") or {}
    return {
        "aweme_id": str(aweme_id),
        "desc": (aw.get("desc") or "").strip(),
        "author": author.get("nickname") or "",
        "author_sec_uid": author.get("sec_uid") or "",
        "author_uid": str(author.get("uid") or ""),
        "digg_count": st.get("digg_count"),
        "comment_count": st.get("comment_count"),
        "collect_count": st.get("collect_count"),
        "share_count": st.get("share_count"),
        "create_time": aw.get("create_time"),
        "duration": video.get("duration"),
        "url": "https://www.douyin.com/video/" + str(aweme_id),
        "source": "api",
    }


def _absorb_search_api(rec, videos, stats):
    """把已到达的搜索接口响应体吃进 videos（按 aweme_id 去重）。返回新增条数。"""
    added = 0
    for r in rec.collect(wait_seconds=2.0, drain=True):
        parsed = r.get("parsed")
        if not isinstance(parsed, dict):
            continue
        stats["api_responses"] += 1
        if parsed.get("status_code") not in (0, None):
            stats["api_status_nonzero"] += 1
        for item in (parsed.get("data") or []):
            v = parse_search_item(item)
            if v and v["aweme_id"] not in videos:
                videos[v["aweme_id"]] = v
                added += 1
        stats["api_cursor"] = parsed.get("cursor")
        stats["api_has_more"] = parsed.get("has_more")
    return added


def _absorb_search_dom(page, videos, stats):
    """DOM 兜底：接口一条都没抓到（或域没开）时，从瀑布流卡片里捞 aweme_id。"""
    added = 0
    try:
        raw = page.evaluate(WATERFALL_JS)
        items = json.loads(raw or "[]")
    except Exception:
        return 0
    for item in items:
        text = (item.get("text") or "").strip()
        if not text or text.startswith("相关搜索"):
            continue
        aweme_id = str(item["id"]).replace("waterfall_item_", "")
        if aweme_id in videos:
            continue
        videos[aweme_id] = {
            "aweme_id": aweme_id,
            "desc": text,
            "author": "",
            "author_sec_uid": "",
            "digg_count": None,
            "comment_count": None,
            "create_time": None,
            "url": "https://www.douyin.com/video/" + aweme_id,
            "source": "dom",
        }
        added += 1
    stats["dom_cards"] += added
    return added


def search_videos(page, keyword, scroll_rounds=12, max_videos=200, log=print,
                  strict=False, meta=None, scroll_pause=2.0, navigate=True, seen_ids=None):
    """按关键词搜视频。返回 [{aweme_id, desc, author, url, ...}]。

    逐轮：吃接口响应体 -> 吃 DOM 兜底 -> 滚一屏。连续 idle_rounds 轮没新增，
    且页面出现「暂时没有更多了」，才判定到底。

    strict=True 时只保留 desc 命中关键词的视频（用 video_matches_keyword），
    默认 False —— 搜索本身已经是关键词匹配，再筛一遍属于可选收紧。
    meta（传 dict 时）会回填本轮的真实统计。

    —— 分页（架构依据 images/10-video-search-flow：「读取一页结果 ->
       按固定条件筛选并去重 -> 保存视频池与搜索游标 -> 申请下一轮搜索」）——

    navigate=False：不自己导航，由调用方保证当前就停在该关键词的搜索页上。
        这样重复调用会【从当前滚动位置继续往下】，一次调用就是「读取一页」。
        （基线写死了每次都要 Page.navigate，等于每次都从第一页重来，没法翻页。）
    seen_ids：视频池里已经有的 aweme_id，返回前全部剔掉 —— 这就是「筛选并去重」。
        宿主把每页结果并进视频池，游标由宿主保存（数据归属见 images/19）。
        统计里 skipped_seen 给出被去重掉的条数，方便判断是不是到头了。
    """
    info = meta if isinstance(meta, dict) else {}
    info.setdefault("api_responses", 0)
    info.setdefault("api_status_nonzero", 0)
    info.setdefault("dom_cards", 0)
    info.setdefault("rounds", 0)
    info.setdefault("scroll_via", {})
    info.setdefault("visible", None)
    info.setdefault("stopped_reason", None)

    cdpmod.ensure_domains(page, "Network")
    rec = cdpmod.NetworkRecorder(page, lambda u: SEARCH_API_MARK in (u or ""))

    info["navigated"] = bool(navigate)
    if navigate:
        page.call("Page.navigate", {"url": SEARCH_URL % quote(keyword)}, timeout=25)
        deadline = time.time() + 25
        while time.time() < deadline:
            try:
                if page.evaluate("document.readyState") == "complete":
                    break
            except Exception:
                pass
            time.sleep(0.5)

    info["visible"] = douyin.ensure_visible(page, log=log)
    # 续页（navigate=False）时页面已经渲染好了，不用再等首屏；重新导航才给足懒加载时间。
    time.sleep(6.0 if navigate else 1.5)

    seen = set(str(x) for x in (seen_ids or ()))
    videos, idle = {}, 0
    for i in range(scroll_rounds + 1):
        cap = douyin.captcha_probe(page)
        if cap.get("hit"):
            # 🔴 不抛异常丢数据：先把已经拿到的存下来，再带 stopped_reason 返回。
            info["stopped_reason"] = "captcha"
            info["captcha"] = cap
            log("[X] 检测到验证码（判据 %s），已停止滚动。请人工处理后重跑。" % cap.get("why"))
            break
        info["rounds"] = i + 1
        api_added = _absorb_search_api(rec, videos, info)
        dom_added = 0
        if not videos or info["api_responses"] == 0:
            dom_added = _absorb_search_dom(page, videos, info)
        fresh_n = sum(1 for k in videos if k not in seen)
        if fresh_n >= max_videos:
            log("本页已收集到 %d 条新视频（max_videos=%d），停止滚动" % (fresh_n, max_videos))
            break
        if api_added + dom_added == 0:
            idle += 1
        else:
            idle = 0
        via = douyin.scroll_by(page, dy=1800)
        info["scroll_via"][via] = info["scroll_via"].get(via, 0) + 1
        pause(scroll_pause)
        if idle >= 3 and _page_says_no_more(page):
            log("页面显示「暂时没有更多了」，提前停止")
            break

    _absorb_search_api(rec, videos, info)
    if not videos:
        _absorb_search_dom(page, videos, info)

    all_videos = list(videos.values())
    for v in all_videos:
        v["keyword_hit"] = video_matches_keyword(v.get("desc"), keyword)
    info["collected"] = len(all_videos)
    info["keyword_hit"] = sum(1 for v in all_videos if v["keyword_hit"])
    info["segments"] = keyword_segments(keyword)

    kept = [v for v in all_videos if v["keyword_hit"]] if strict else all_videos
    # 「按固定条件筛选并去重」：池里已有的全部剔掉，返回的才是这一页的新结果
    fresh = [v for v in kept if v["aweme_id"] not in seen]
    info["skipped_seen"] = len(kept) - len(fresh)
    info["kept"] = len(fresh)
    # 平台响应体里的分页信号：只作为【观测】返回，不用来直调接口
    # （直调需要伪造签名，属红线，不碰）。
    info["platform_cursor"] = info.get("api_cursor")
    info["platform_has_more"] = info.get("api_has_more")

    log("搜索关键词          : %s" % keyword)
    log("关键词分词          : %s" % (info["segments"] or "(无)"))
    log("搜索接口响应        : %d 个 (status_code!=0 的 %d 个)"
        % (info["api_responses"], info["api_status_nonzero"]))
    log("响应体里的视频      : %d 个" % info["collected"])
    log("DOM 兜底卡片        : %d 个" % info["dom_cards"])
    log("标题命中关键词      : %d 个" % info["keyword_hit"])
    log("滚动通道            : %s" % info["scroll_via"])
    log("池内已去重          : %d 个" % info["skipped_seen"])
    log("本页新视频          : %d 个%s" % (len(fresh), "（strict）" if strict else ""))
    log("平台分页信号        : has_more=%s cursor=%s"
        % (info.get("platform_has_more"), str(info.get("platform_cursor"))[:24]))
    return fresh


def _page_says_no_more(page):
    try:
        return "暂时没有更多了" in (douyin.page_text(page) or "")
    except Exception:
        return False


# ===================== 抓评论（走接口响应体） =====================

EXPAND_THREADS_JS = (
    "JSON.stringify((function(){var btns=Array.from(document.querySelectorAll('*'))"
    ".filter(function(e){var t=(e.innerText||'').trim();"
    "return /^展开[0-9]+条回复$/.test(t)&&e.children.length===0;});"
    "if(!btns.length)return 0;var n=0;"
    "for(var i=0;i<btns.length&&i<10;i++){btns[i].click();n++;}return n;})())"
)


def _parse_comment(c, aweme_id, video_title, source="api"):
    user = c.get("user") or {}
    avatar = ""
    for key in ("avatar_thumb", "avatar_larger"):
        lst = (user.get(key) or {}).get("url_list") or []
        if lst:
            avatar = lst[0]
            break
    province = str(c.get("province") or user.get("province") or c.get("region_province") or "").strip()
    city_raw = c.get("city_name") or user.get("city_name") or user.get("cityName") or c.get("region_city") or ""
    city = "" if re.fullmatch(r"\d+", str(city_raw or "")) else str(city_raw or "").strip()
    sec_uid = user.get("sec_uid") or user.get("secUid") or ""
    return {
        "cid": c.get("cid"),
        "aweme_id": aweme_id,
        "text": c.get("text") or "",
        "user": user.get("nickname") or "",
        "sec_uid": sec_uid,
        "avatar_url": avatar,
        "avatar_collected": bool(user.get("avatar_thumb") or user.get("avatar_larger")),
        "works_count": user.get("aweme_count"),
        "profile_private": user.get("secret") if isinstance(user.get("secret"), bool) else None,
        "digg": c.get("digg_count") or 0,
        "reply_count": c.get("reply_comment_total"),
        "is_author": bool(c.get("is_author")),
        "create_time": c.get("create_time") or 0,
        "reply_to_user": ((c.get("reply_to_user") or {}).get("nickname") or ""),
        "video_title": (video_title or "")[:40],
        "region": c.get("ip_label") or " ".join(x for x in (province, city) if x),
        "province": province,
        "city": city,
        "source": source,
    }


def _comment_key(row):
    return (row.get("sec_uid") or "", normalize_search_text(row.get("text")))


def _absorb_comments(rec, comments, aweme_id, video_title, stats):
    """把已到达的评论接口响应体吃进 comments。返回新增条数。"""
    added = 0
    for r in rec.collect(wait_seconds=2.0, drain=True):
        parsed = r.get("parsed")
        if not isinstance(parsed, dict):
            continue
        stats["api_responses"] += 1
        batch = parsed.get("comments") or []
        stats["api_batches"] += 1
        stats["api_comments"] += len(batch)
        stats["has_more"] = parsed.get("has_more")
        for c in batch:
            row = _parse_comment(c, aweme_id, video_title, source="api")
            key = _comment_key(row)
            if key in comments:
                continue
            comments[key] = row
            added += 1
    return added


def _absorb_dom_comments(page, comments, aweme_id, video_title, stats, limit=120):
    """DOM 兜底。⚠️ 只在页面【还在目标视频上】时合并，避免把下一个视频的评论混进来。"""
    try:
        href = page.evaluate("location.href") or ""
    except Exception:
        return 0
    if aweme_id and aweme_id not in href:
        stats["dom_skipped_off_target"] += 1
        return 0
    added = 0
    try:
        rows = douyin.collect_comments(page, limit=limit)
    except Exception:
        return 0
    for r in rows:
        row = {
            "cid": None,
            "aweme_id": aweme_id,
            "text": r.get("text") or "",
            "user": r.get("nick") or "",
            "sec_uid": r.get("sec_uid") or "",
            "digg": 0,
            "video_title": (video_title or "")[:40],
            "source": "dom",
        }
        key = _comment_key(row)
        if key in comments or not row["text"]:
            continue
        comments[key] = row
        added += 1
    stats["dom_rows"] += added
    return added


def _same_comment(a, b):
    """两条正文是不是【同一条评论】。

    实测的重复来源：接口给的正文带表情（"谢谢了[握手][握手][握手]"），
    DOM 给的正文把表情丢了（"谢谢了"）——按 (sec_uid, 全文) 去重会漏掉，
    于是同一条评论被收两次。这里改成前缀包含判定。
    """
    if not a or not b:
        return a == b
    return a == b or a.startswith(b) or b.startswith(a)


def _richer(a, b):
    """哪条记录信息更全。接口记录有 cid / digg / 地区 / 头像，优先它。"""
    if (a.get("source") == "api") != (b.get("source") == "api"):
        return a.get("source") == "api"
    return len(a.get("text") or "") > len(b.get("text") or "")


def dedupe_comments(rows):
    """同一用户在同一视频下的同一条评论只留一条（留信息更全的那条）。"""
    out, by_uid = [], {}
    for row in rows:
        uid = row.get("sec_uid") or ""
        norm = normalize_search_text(row.get("text"))
        dup = None
        for idx in by_uid.get(uid, []):
            if _same_comment(norm, out[idx].get("_norm", "")):
                dup = idx
                break
        if dup is None:
            row["_norm"] = norm
            by_uid.setdefault(uid, []).append(len(out))
            out.append(row)
        elif _richer(row, out[dup]):
            row["_norm"] = norm
            out[dup] = row
    for r in out:
        r.pop("_norm", None)
    return out


def crawl_video_comments(page, video, log=print, scroll_rounds=7, settle=3.0, want_dom=True,
                         scroll_pause=2.0, navigate=True):
    """抓一条视频的评论。返回 (comments, meta)。

    评论里带 sec_uid —— 这是私信环节的输入。

    ⚠️ 记录器只认【URL 里带本次 aweme_id 的 comment/list 响应】。
       视频页会连带请求推荐视频的评论，不锁 aweme_id 就会串味。
    """
    aweme_id = str(video.get("aweme_id") or "")
    video_title = video.get("desc") or video.get("text") or ""
    stats = {"api_responses": 0, "api_batches": 0, "api_comments": 0, "dom_rows": 0,
             "dom_skipped_off_target": 0, "has_more": None, "rounds": 0, "skipped": None,
             "scroll": []}

    cdpmod.ensure_domains(page, "Network")
    rec = cdpmod.NetworkRecorder(
        page, lambda u: COMMENT_API_MARK in (u or "") and ("aweme_id=%s" % aweme_id) in (u or ""))

    # Callers that already performed a controlled navigation (the sidecar's
    # persistent owned tab) can opt out to avoid a reload and losing the
    # accumulated comment view.  The legacy CLI keeps navigate=True.
    if navigate:
        page.call("Page.navigate", {"url": video["url"]}, timeout=25)

    appeared = False
    for _ in range(10):
        cap = douyin.captcha_probe(page)
        if cap.get("hit"):
            stats["skipped"] = "captcha"
            stats["captcha"] = cap
            stats["stopped_reason"] = "captcha"
            return [], stats
        if douyin.comment_panel_visible(page):
            appeared = True
            break
        time.sleep(2)
    if not appeared:
        if douyin.is_note_page(page):
            stats["skipped"] = "note_post_panel_unsupported"
        else:
            stats["skipped"] = "comment_panel_not_visible"
        return [], stats

    time.sleep(settle)
    comments = {}
    idle = 0
    _absorb_comments(rec, comments, aweme_id, video_title, stats)

    for i in range(scroll_rounds):
        stats["rounds"] = i + 1
        cap = douyin.captcha_probe(page)
        if cap.get("hit"):
            stats["stopped_reason"] = "captcha"
            stats["captcha"] = cap
            log("[X] 检测到验证码（判据 %s），停止抓评论并保留已抓到的 %d 条。"
                % (cap.get("why"), len(comments)))
            break
        before = len(comments)
        if want_dom:
            _absorb_dom_comments(page, comments, aweme_id, video_title, stats)
        info = douyin.scroll_comment_panel(page, rounds=1, pause=pause(scroll_pause))
        stats["scroll"].append({"round": i + 1,
                                "items": info.get("items"),
                                "scrolled": info.get("scrolled"),
                                "wheel": info.get("wheel")})
        _absorb_comments(rec, comments, aweme_id, video_title, stats)
        if len(comments) <= before:
            idle += 1
        else:
            idle = 0
        if idle >= 3:
            break
        if i in (1, scroll_rounds - 1):
            try:
                n = int(page.evaluate(EXPAND_THREADS_JS) or 0)
            except Exception:
                n = 0
            if n:
                stats["expanded_threads"] = stats.get("expanded_threads", 0) + n
                time.sleep(2.5)

    if want_dom:
        _absorb_dom_comments(page, comments, aweme_id, video_title, stats)
    _absorb_comments(rec, comments, aweme_id, video_title, stats)

    rows = dedupe_comments(list(comments.values()))
    stats["after_dedupe"] = len(rows)
    stats["total"] = len(rows)
    stats["with_sec_uid"] = sum(1 for c in rows if c.get("sec_uid"))
    return rows, stats


# ===================== 组装：关键词筛评论 -> 私信队列 =====================

def build_queue(comments, comment_keywords, min_digg=0, mode="seg", exclude_keywords=""):
    """按评论关键词筛人，产出私信队列（按 sec_uid 去重）。

    exclude_keywords 语义见 filter_comments：命中排除词的评论在出队列前就被丢掉 ——
    这是避免给同行/广告人群发私信的最后一道闸。
    """
    matched, stats = filter_comments(comments, comment_keywords, mode=mode, min_digg=min_digg,
                                     exclude_keywords=exclude_keywords)
    queue, seen = [], set()
    for c in matched:
        uid = c.get("sec_uid")
        if not uid or uid in seen:
            continue
        seen.add(uid)
        queue.append({
            "sec_uid": uid,
            "nick": c.get("user"),
            "comment": (c.get("text") or "")[:200],
            "matched_keyword": c.get("matched_keyword"),
            "aweme_id": c.get("aweme_id"),
            "video_title": c.get("video_title"),
            "region": c.get("region"),
            "digg": c.get("digg"),
            "avatar_url": c.get("avatar_url"),
            "works_count": c.get("works_count"),
            "profile_private": c.get("profile_private"),
        })
    stats["queue"] = len(queue)
    stats["dup_commenter"] = len(matched) - len(queue)
    return queue, stats
