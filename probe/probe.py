"""抖音自动私信 / 可行性探针 —— 命令行入口。

用法：
    python probe.py doctor                       # 环境与账号自检（不发送任何东西）
    python probe.py launch-chrome                # 用专用配置目录启动带调试端口的 Chrome
    python probe.py v1 --url <视频URL>            # 采集别人视频的评论（只读）
    python probe.py search --keyword "宝宝辅食"    # 按视频关键词搜视频（只读）
    python probe.py crawl --keyword "宝宝辅食" --comment-keywords "怎么做,教程" --videos 3
                                                  # 搜视频 -> 抓评论 -> 按评论关键词筛评论 -> 出队列
    python probe.py v4 --sec-uid <sec_uid>        # 探测私信入口是否可用（只读）
    python probe.py v4 --sec-uid <id> --send --text "你好"   # 真发一条（消耗额度）
    python probe.py dm --queue q.json --text "..." [--allow-send]   # 批量私信；默认只预填

安全默认值：
    · 不带 --allow-send 时【绝不点击发送】，只做预填与探测
    · 任何一次真实发送都会先落 send_id 台账，并计入官方额度
    · 检测到验证码 / 登录失效 / 空响应 -> 立即熔断退出，不做任何绕过

Windows 注意：输出统一强制 UTF-8（默认 GBK 控制台会直接崩），
             若控制台仍显示乱码，先执行 chcp 65001。
"""
import argparse
import json
import os
import subprocess
import sys
import time

# --- Windows 控制台编码兜底：必须在任何输出之前 ---
for _stream in ("stdout", "stderr"):
    _s = getattr(sys, _stream, None)
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import cdp as cdpmod          # noqa: E402
import winfocus              # noqa: E402
import crawl as crawlmod      # noqa: E402
import douyin                # noqa: E402
import dm as dmmod           # noqa: E402
import dyselectors as S        # noqa: E402

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]
PROFILE_DIR = os.path.join(HERE, "chrome-profile")

OK = "[OK]"
BAD = "[X]"
WARN = "[!]"


def p(msg=""):
    print(msg, flush=True)


def find_chrome():
    for c in CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    return None


def bring_chrome_front(log=p):
    """把 Chrome 主窗口真正置前。

    实现在 winfocus.py —— dm.py 也要用它（批量发送时标签失活是同一个坑），
    放这里会形成 probe.py <-> dm.py 的循环 import。
    """
    return winfocus.bring_chrome_front(log=log)



def connect(port, timeout=30.0):
    """连到浏览器级 CDP，并返回 (browser_cdp, page_cdp)。"""
    tab = cdpmod.find_page_tab(port)
    if not tab:
        raise SystemExit(
            "找不到可用的页面标签。请先运行：\n"
            "    python probe.py launch-chrome\n"
            "然后在该 Chrome 里手动登录抖音。"
        )
    browser_ws = cdpmod._http_json("http://127.0.0.1:%d/json/version" % port)["webSocketDebuggerUrl"]
    browser = cdpmod.CDP(browser_ws, port=port, timeout=timeout)
    page = cdpmod.CDP(tab["webSocketDebuggerUrl"], port=port, timeout=timeout)
    for t in (browser, page):
        for dom in ("Page.enable", "Runtime.enable"):
            try:
                t.call(dom, {}, timeout=10)
            except Exception:
                pass
    # 🔴 Network 必须开：NetworkRecorder 只是注册回调，域不打开就一个事件都不来，
    #    症状是"接口响应体抓到 0 条"且不报错（搜视频/抓评论都靠它）。
    try:
        page.call("Network.enable", {}, timeout=10)
    except Exception:
        pass
    return browser, page


def wait_document(page, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if page.evaluate("document.readyState") == "complete":
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


# ===================== 子命令 =====================

def cmd_doctor(args):
    p("=== 抖音自动私信探针 · 自检 ===")
    chrome = find_chrome()
    p("Chrome            : %s" % (chrome or "未找到"))
    p("配置目录          : %s" % PROFILE_DIR)
    connected = False
    try:
        raw = cdpmod._http_json("http://127.0.0.1:%d/json/version" % args.port, timeout=6)
        p("CDP 端口 %-8d: %s 已连通" % (args.port, OK))
        p("  浏览器          : %s" % raw.get("Browser"))
        connected = True
    except Exception as exc:
        p("CDP 端口 %-8d: %s 未连通 (%s)" % (args.port, BAD, exc))
        p("  -> 请先运行 python probe.py launch-chrome 并完成登录")

    if connected:
        browser, page = connect(args.port)
        try:
            tabs = [t for t in cdpmod.list_tabs(args.port) if t.get("type") == "page"]
            p("页面标签          : %d 个" % len(tabs))
            p("当前标签 URL      : %s" % (page.evaluate("location.href") or ""))
            if douyin.check_login_required(page):
                p("登录态            : %s 需要登录（页面提示扫码登录）" % BAD)
            else:
                p("登录态            : %s 未发现登录提示" % OK)
            if douyin.check_captcha(page):
                p("验证码            : %s 检测到验证码，请人工处理" % WARN)
            else:
                p("验证码            : %s 未检测到" % OK)
            who = page.eval_json(
                "(function(){var e=document.querySelector('[data-e2e=\"user-info\"]');"
                "return e?(e.innerText||'').trim().slice(0,80):null;})()"
            )
            p("页面用户信息      : %s" % (who or "（未识别，请自行确认当前登录号是否为企业号）"))
        finally:
            page.close(); browser.close()

    ledger = dmmod.Ledger()
    quota = dmmod.Quota(ledger)
    snap = quota.snapshot()
    p()
    p("=== 额度（官方口径） ===")
    p("今日已触达        : %d / %d 人" % (snap["day_used"], snap["day_limit"]))
    p("本小时已触达      : %d / %d 人" % (snap["hour_used"], snap["hour_limit"]))
    p("单用户上限        : %d 条" % snap["per_user_max"])
    p()
    p("=== 选择器状态（诚实标注） ===")
    p(S.registry_report())
    p()
    p("%s 是否企业号、网页端能否私信陌生人，只有真机运行 v4 才能确认。" % WARN)
    return 0 if connected else 1


def cmd_launch_chrome(args):
    chrome = find_chrome()
    if not chrome:
        raise SystemExit("未找到 Chrome，请手动指定路径")
    os.makedirs(PROFILE_DIR, exist_ok=True)
    cmd = [
        chrome,
        "--remote-debugging-port=%d" % args.port,
        "--user-data-dir=%s" % PROFILE_DIR,
        "--no-first-run",
        "--no-default-browser-check",
        "https://www.douyin.com/",
    ]
    p("启动：")
    p("  " + " ".join('"%s"' % c if " " in c else c for c in cmd))
    p()
    p("%s 这是【专用配置目录】，与你的日常浏览器隔离。" % WARN)
    p("%s 请在该窗口里【手动登录】你要用于测试的抖音号（建议小号/企业号）。" % WARN)
    subprocess.Popen(cmd)
    return 0


def cmd_v1(args):
    browser, page = connect(args.port)
    try:
        page.call("Page.navigate", {"url": args.url}, timeout=25)
        wait_document(page, 25)
        time.sleep(2)
        if douyin.check_captcha(page):
            p("%s 出现验证码，已停止。请人工处理后重试。" % WARN)
            return 2
        ok = douyin.wait_comment_panel(page, timeout=20)
        p("评论区可见        : %s" % (OK if ok else BAD + " 未展开"))
        if not ok:
            return 2
        douyin.scroll_comment_panel(page, rounds=args.scroll, pause=1.6)
        rows = douyin.collect_comments(page, limit=args.limit)
        with_uid = [r for r in rows if r.get("sec_uid")]
        p("采集到评论        : %d 条" % len(rows))
        p("含 sec_uid 的     : %d 条" % len(with_uid))
        p()
        for i, r in enumerate(rows[: args.limit], 1):
            tag = "有UID" if r.get("sec_uid") else "无UID"
            p("%2d. [%s] %s" % (i, tag, (r.get("text") or "")[:60].replace("\n", " ")))
        out = os.path.join(HERE, "state", "v1_comments.json")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=2)
        p()
        p("已写入 %s" % out)
        return 0 if (rows and with_uid) else 1
    finally:
        page.close(); browser.close()


def cmd_v4(args):
    browser, page = connect(args.port)
    try:
        page.call("Page.navigate", {"url": douyin.profile_url(args.sec_uid)}, timeout=25)
        wait_document(page, 25)
        time.sleep(2.5)
        if douyin.check_captcha(page):
            p("%s 出现验证码，已停止。" % WARN)
            return 2
        if douyin.check_login_required(page):
            p("%s 登录态失效，请先人工登录。" % BAD)
            return 2
        entry = douyin.dm_entry(page)
        p("私信入口          : %s" % json.dumps(entry, ensure_ascii=False))
        if entry.get("blocked"):
            p()
            p("%s 结论：该账号在网页端【无法】私信此用户 (stranger_dm_disabled)" % BAD)
            p("   若当前登录的不是企业号，这一条不能代表企业号的行为，请换企业号重测。")
            return 1
        if not entry.get("found"):
            p("%s 未找到「私信」按钮，原因：%s" % (BAD, entry.get("reason")))
            return 1
        p("%s 找到私信入口 —— 这是路线 1 能否成立的关键信号" % OK)
        if not args.send:
            p("（未加 --send，只探测不发送）")
            return 0
        text = args.text or "你好"
        page.click_at(entry["x"], entry["y"])
        time.sleep(2.5)
        comp = {"found": False}
        for _ in range(4):
            comp = douyin.dm_composer(page)
            if comp.get("found"):
                break
            time.sleep(1.5)
        if not comp.get("found"):
            p("%s 未找到输入框" % BAD)
            return 1
        page.click_at(comp["x"], comp["y"]); time.sleep(0.6)
        page.insert_text(text); time.sleep(1.2)
        p("已预填            : %s" % text)
        btn = douyin.dm_send_button(page)
        p("发送按钮          : %s" % json.dumps(btn, ensure_ascii=False))
        if not btn.get("found"):
            p("%s 未找到发送按钮（selectors.py 里的发送按钮判据需按真机回填）" % BAD)
            return 1
        try:
            page.call("Network.enable", {}, timeout=10)
        except Exception:
            pass
        rec = douyin.make_network_recorder(page, "douyin.com")
        page.click_at(btn["x"], btn["y"])
        records = rec.collect(wait_seconds=10.0)
        posts = [r for r in records if (r.get("method") or "").upper() == "POST"]
        p()
        p("捕获到的 POST 接口（用于回填 DM_SEND_URL_MARK）：")
        for r in posts:
            sc = None
            parsed = r.get("parsed") or {}
            if isinstance(parsed, dict):
                data = parsed.get("data") if isinstance(parsed.get("data"), dict) else parsed
                sc = data.get("status_code", parsed.get("status_code"))
            p("  %s  http=%s status_code=%s" % (r.get("url"), r.get("httpStatus"), sc))
        if not posts:
            p("  %s 未捕获到任何 POST —— 无法确认发送结果（红线 2 不成立）" % WARN)
        return 0
    finally:
        page.close(); browser.close()


def _dump(name, obj):
    out_dir = os.path.join(HERE, "state")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
    return path


def cmd_search(args):
    """只做第一步：按【视频关键词】搜视频。不打开任何视频、不抓评论、零发送。"""
    if not args.no_focus:
        bring_chrome_front()
    browser, page = connect(args.port)
    try:
        meta = {}
        videos = crawlmod.search_videos(page, args.keyword, scroll_rounds=args.scroll,
                                        max_videos=args.max_videos, log=p,
                                        strict=args.strict, meta=meta,
                                        scroll_pause=args.scroll_pause)
        if meta.get("stopped_reason") == "captcha":
            p()
            p("%s 检测到验证码，已提前停止。请人工处理后再跑（不处理会一直只拿到这么点）。" % BAD)
        p()
        if not videos:
            p("%s 一个视频都没搜到。可放宽关键词、加大 --scroll，或检查窗口是否被遮挡。" % BAD)
            return 1
        path = _dump("search_videos.json", videos)
        p("=== 前 %d 条 ===" % min(args.show, len(videos)))
        for i, v in enumerate(videos[: args.show], 1):
            p("%2d. %s | %-14s | 赞%-7s 评%-7s | %s" % (
                i, v["aweme_id"], (v.get("author") or "")[:14],
                v.get("digg_count"), v.get("comment_count"),
                (v.get("desc") or "").replace("\n", " ")[:46]))
        p()
        p("共 %d 条，已写入 %s" % (len(videos), path))
        p("下一步： python probe.py crawl --keyword \"%s\" --comment-keywords \"...\" --videos 5" % args.keyword)
        return 0
    finally:
        page.close(); browser.close()


def cmd_crawl(args):
    """搜视频 -> 抓评论 -> 按【评论关键词】筛评论 -> 出私信队列。"""
    if not args.no_focus:
        bring_chrome_front()
    browser, page = connect(args.port)
    try:
        smeta = {}
        videos = crawlmod.search_videos(page, args.keyword, scroll_rounds=args.scroll,
                                        max_videos=args.max_videos, log=p,
                                        strict=args.strict, meta=smeta,
                                        scroll_pause=args.scroll_pause)
        if smeta.get("stopped_reason") == "captcha":
            p("%s 搜索阶段就撞到验证码，请先人工处理。" % BAD)
        if not videos:
            p("未搜到视频，结束。可放宽关键词或加大 --scroll。")
            return 1
        _dump("search_videos.json", videos)      # 完整搜索结果
        if args.order == "comments":
            videos.sort(key=lambda v: -(v.get("comment_count") or 0))
        elif args.order == "digg":
            videos.sort(key=lambda v: -(v.get("digg_count") or 0))
        videos = videos[: args.videos]
        _dump("crawl_targets.json", videos)      # 本次真正抓评论的那几条
        p()
        p("=== 本次要抓评论的 %d 条视频（按 %s 排）===" % (len(videos), args.order))
        for i, v in enumerate(videos, 1):
            p("  %d. %s | 评%-6s 赞%-7s | %s" % (
                i, v["aweme_id"], v.get("comment_count"), v.get("digg_count"),
                (v.get("desc") or "")[:36]))
        p()
        all_comments = []
        for i, v in enumerate(videos, 1):
            p("[%d/%d] 抓评论 %s  %s" % (i, len(videos), v["aweme_id"],
                                        (v.get("desc") or "")[:28]))
            try:
                comments, cmeta = crawlmod.crawl_video_comments(
                    page, v, log=p, scroll_pause=args.scroll_pause)
            except RuntimeError as exc:
                p("%s %s" % (BAD, exc))
                break
            extra = cmeta.get("skipped") or ""
            p("        评论 %d 条（接口 %d / DOM %d），含 sec_uid %d 条  %s" % (
                len(comments), cmeta.get("api_comments", 0), cmeta.get("dom_rows", 0),
                cmeta.get("with_sec_uid", 0), extra))
            if not getattr(args, "quiet", False):
                for c in comments[:5]:
                    p("          · %-12s %s" % ((c.get("user") or "")[:12],
                                               (c.get("text") or "")[:42]))
            all_comments.extend(comments)
            if cmeta.get("stopped_reason") == "captcha":
                p("%s 撞到验证码：已保留上面这些评论，但停止继续抓。请人工处理。" % BAD)
                break
            time.sleep(2.0)

        if not all_comments:
            p("%s 一条评论都没抓到 —— 检查窗口是否被遮挡、视频是否有评论。" % BAD)
            return 1

        matched, stats = crawlmod.filter_comments(all_comments, args.comment_keywords,
                                                  mode=args.match_mode, min_digg=args.min_digg)
        queue, qstats = crawlmod.build_queue(all_comments, args.comment_keywords,
                                             min_digg=args.min_digg, mode=args.match_mode)
        p()
        p("=== 评论筛选（模式 %s：%s）===" % (args.match_mode,
                                             crawlmod.MATCH_MODE_LABELS.get(args.match_mode, "")))
        p("关键词            : %s" % (stats["keywords"] or "(空 = 全收)"))
        p("评论总数          : %d" % stats["total"])
        p("命中（当前模式）  : %d" % stats["matched"])
        p("点赞不足被剔除    : %d" % stats["low_digg"])
        p("命中但无 sec_uid  : %d  <- 这些筛出来也没法私信" % stats["no_sec_uid"])
        p()
        p("各模式命中数对比（同一条评论：越往下越松）:")
        for m in crawlmod.MATCH_MODES:
            mark = "  <- 当前" if m == args.match_mode else ""
            p("  %-7s %5d   %s%s" % (m, stats["modes"][m],
                                     crawlmod.MATCH_MODE_LABELS[m], mark))

        cp = _dump("crawl_comments.json", all_comments)
        fp = _dump("filtered_comments.json", matched)
        qp = _dump("dm_queue.json", queue)
        p()
        p("视频列表 : %s" % os.path.join(HERE, "state", "search_videos.json"))
        p("评论明细 : %s  (%d 条)" % (cp, len(all_comments)))
        p("命中评论 : %s  (%d 条)" % (fp, len(matched)))
        p("私信队列 : %s  (%d 人，去重掉同一个人 %d)" % (qp, len(queue), qstats["dup_commenter"]))
        if queue:
            p()
            p("下一步（默认只预填，不加 --allow-send 绝不发送）：")
            p('  python probe.py dm --queue state/dm_queue.json --text "您好{nick}，看到您在评论区..."')
        return 0
    finally:
        page.close(); browser.close()


def cmd_dm(args):
    with open(args.queue, "r", encoding="utf-8") as fh:
        queue = json.load(fh)
    if isinstance(queue, dict):
        queue = queue.get("targets") or []
    if args.limit:
        queue = queue[: args.limit]
    p("目标数            : %d" % len(queue))
    p("模式              : %s" % ("真实发送" if args.allow_send else "仅预填（不发送）"))
    if args.allow_send:
        p()
        p("%s 真实发送会消耗账号风险，且会计入官方额度。未互关上限 = 1 条/人，发了就收不回。" % WARN)
        if not getattr(args, "yes", False):
            p("   连续输入 yes 确认：")
            if input("   > ").strip().lower() != "yes":
                p("已取消。")
                return 1
        else:
            p("   （--yes：已跳过交互确认）")
    if not getattr(args, "no_focus", False):
        bring_chrome_front()
    browser, page = connect(args.port)
    try:
        summary = dmmod.run_batch(page, queue, args.text, args.allow_send, log=p)
    finally:
        page.close(); browser.close()
    p()
    p("=== 汇总 ===")
    for k in ("total", "sent_confirmed", "sent_dom_confirmed", "submitted", "unverified",
              "prepared_only", "skipped", "failed", "stopped_reason"):
        p("%-16s: %s" % (k, summary.get(k)))
    out = os.path.join(HERE, "state", "dm_summary.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    p("明细已写入 %s" % out)
    return 0


def build_parser():
    ap = argparse.ArgumentParser(description="抖音自动私信 / 可行性探针")
    ap.add_argument("--port", type=int, default=9222)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="自检（不发送）").set_defaults(func=cmd_doctor)
    sub.add_parser("launch-chrome", help="用专用配置目录启动 Chrome").set_defaults(func=cmd_launch_chrome)

    a = sub.add_parser("v1", help="采集别人视频的评论（只读）")
    a.add_argument("--url", required=True)
    a.add_argument("--limit", type=int, default=20)
    a.add_argument("--scroll", type=int, default=4)
    a.set_defaults(func=cmd_v1)

    b = sub.add_parser("v4", help="探测私信入口（默认只读）")
    b.add_argument("--sec-uid", required=True)
    b.add_argument("--send", action="store_true", help="真实发送一条（消耗额度与账号风险）")
    b.add_argument("--text", default=None)
    b.set_defaults(func=cmd_v4)

    s = sub.add_parser("search", help="按视频关键词搜视频（只读，不打开视频、不抓评论）")
    s.add_argument("--keyword", required=True, help="视频搜索关键词")
    s.add_argument("--max-videos", type=int, default=200, help="最多收集多少条视频")
    s.add_argument("--scroll", type=int, default=12, help="搜索页滚动轮数")
    s.add_argument("--show", type=int, default=20, help="打印前多少条")
    s.add_argument("--strict", action="store_true",
                   help="只保留标题命中关键词的视频（默认保留搜索结果全部）")
    s.add_argument("--scroll-pause", type=float, default=2.0,
                   help="每屏之间基础停顿秒数（对数正态抖动；调大更安全、更慢）")
    s.add_argument("--no-focus", action="store_true",
                   help="不要自动把 Chrome 窗口置前（默认会置前，否则懒加载不触发、结果静默变少）")
    s.set_defaults(func=cmd_search)

    d = sub.add_parser("crawl", help="搜视频 -> 抓评论 -> 按评论关键词筛评论 -> 出私信队列")
    d.add_argument("--keyword", required=True, help="视频搜索关键词")
    d.add_argument("--comment-keywords", default="",
                   help="评论关键词，逗号分隔；留空则全收")
    d.add_argument("--match-mode", default="seg", choices=list(crawlmod.MATCH_MODES),
                   help="评论匹配档位：seg(默认,词级) / phrase(整串) / all(全词) / any(任意字)")
    d.add_argument("--videos", type=int, default=10, help="最多抓几条视频的评论")
    d.add_argument("--max-videos", type=int, default=200, help="搜索页最多收集多少条视频")
    d.add_argument("--scroll", type=int, default=12, help="搜索页滚动轮数")
    d.add_argument("--min-digg", type=int, default=0, help="评论最低点赞数（过滤零互动）")
    d.add_argument("--strict", action="store_true", help="视频先按标题命中关键词收紧")
    d.add_argument("--quiet", action="store_true", help="不逐条打印评论样例")
    d.add_argument("--scroll-pause", type=float, default=2.0,
                   help="每屏之间基础停顿秒数（对数正态抖动；调大更安全、更慢）")
    d.add_argument("--no-focus", action="store_true",
                   help="不要自动把 Chrome 窗口置前（默认会置前，否则懒加载不触发、结果静默变少）")
    d.add_argument("--order", default="comments", choices=["comments", "digg", "default"],
                   help="挑哪几条视频抓评论：comments(评论数降序,默认) / digg / default(发现顺序)")
    d.set_defaults(func=cmd_crawl)

    c = sub.add_parser("dm", help="批量私信（默认只预填）")
    c.add_argument("--queue", required=True, help="JSON 文件：[{sec_uid,nick},...]")
    c.add_argument("--text", required=True, help="话术，支持 {nick} 占位")
    c.add_argument("--allow-send", action="store_true")
    c.add_argument("--yes", action="store_true", help="跳过交互确认（等价于输入 yes）")
    c.add_argument("--no-focus", action="store_true", help="不要自动把 Chrome 窗口置前")
    c.add_argument("--limit", type=int, default=0)
    c.set_defaults(func=cmd_dm)
    return ap


def main():
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
