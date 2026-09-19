"""抖音自动私信 / 可行性探针 —— 命令行入口。

用法：
    python probe.py doctor                       # 环境与账号自检（不发送任何东西）
    python probe.py launch-chrome                # 用专用配置目录启动带调试端口的 Chrome
    python probe.py v1 --url <视频URL>            # 采集别人视频的评论（只读）
    python probe.py search --keyword "宝宝辅食"    # 按视频关键词搜视频（只读）
    python probe.py crawl --keyword "宝宝辅食" --comment-keywords "怎么做,教程" --videos 3
                                                  # 搜视频 -> 抓评论 -> 按评论关键词筛评论 -> 出队列
    python probe.py live --url <直播间链接> --keywords "多少钱,怎么买" --seconds 90
                                                  # 直播间弹幕截流（只读）-> 出私信队列
    python probe.py v4 --sec-uid <sec_uid>        # 探测私信入口是否可用（只读）
    python probe.py v4 --sec-uid <id> --send --text "你好"   # 真发一条（消耗额度）
    python probe.py manual --queue q.json         # 人工点击工作台：我出清单/话术/记账，你点主页->私信->发送
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
import live as livemod       # noqa: E402
import manual as manualmod   # noqa: E402
import watch as watchmod     # noqa: E402
import harvest as harvestmod # noqa: E402
import shot as shotmod       # noqa: E402
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
        lo, hi = dmmod.LIMITS["typing_delay_range"]
        typed = page.type_text(text, lo=lo, hi=hi, log=lambda m: p(m))
        p("打字耗时          : %.1f 秒（每字 %.1f~%.1f 秒随机）" % (typed, lo, hi))
        time.sleep(1.2)
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


def cmd_live(args):
    """直播间截流：采集弹幕 -> 关键词筛 -> 意向打分 -> 出私信队列。

    🔴 本命令【只读】：不发弹幕、不点赞、不私信。私信交给 dm 子命令
       （额度闸、send_id 幂等、二次确认都在那里）。
    """
    try:
        room = livemod.normalize_room(args.url)
    except ValueError as exc:
        p("%s %s" % (BAD, exc))
        return 2
    if not args.no_focus:
        bring_chrome_front()
    browser, page = connect(args.port)
    try:
        p("直播间            : %s" % room["url"])
        if room["from"] == "short_link":
            p("（短链：真实房间号要等页面重定向之后再解析）")
        page.call("Page.navigate", {"url": room["url"]}, timeout=35)
        wait_document(page, 30)
        time.sleep(3.0)
        # 🔴 真机教训（2026-09-19）：窗口被遮挡时 visibilityState=hidden，
        #    弹幕虚拟列表【一条都不渲染】—— 看起来就像"直播间没人说话"。
        #    ensure_visible 会用 CDP 把页面拉回 active（实测 hidden -> visible）。
        douyin.ensure_visible(page, log=p)
        if douyin.check_captcha(page):
            p("%s 出现验证码，已停止。请人工处理后重试。" % WARN)
            return 2
        if douyin.check_login_required(page):
            p("%s 登录态失效，请先在该 Chrome 里人工登录。" % BAD)
            return 2

        info = livemod.room_info(page)
        rinfo = info["room"]
        diag = info["diagnostics"]
        if not rinfo.get("web_rid"):
            p("%s 解析不出房间号。当前页面：%s" % (BAD, rinfo.get("url")))
            p("   直播间链接形如 https://live.douyin.com/<房间号>")
            return 2
        p("房间              : %s（%s）" % (rinfo.get("room_title") or "(无标题)", rinfo.get("web_rid")))
        p("状态 / 在线       : %s / %s" % (rinfo.get("status"), rinfo.get("online_text") or "未知"))
        p("弹幕容器          : 候选节点 %s 个，可见 %s 个" % (diag.get("candidates"), diag.get("visible")))
        # 🔴 必须等到弹幕【真的渲染出第一行】再开采集：页面加载后容器很快就存在，
        #    但虚拟列表要等 IM 订阅建立才渲染，实测首次导航后可能 >20 秒。
        #    只等"容器可见"就开始，会先稳定采到 0 条（和"没人说话"分不清）。
        diag = livemod.wait_chat(page, timeout=args.wait, log=p)
        if not (diag.get("visible") or (diag.get("candidates") or 0)):
            p()
            p("%s 页面上找不到任何弹幕容器。可能是：未开播 / 需要登录 / 选择器失效" % BAD)
            p("   diagnostics: %s" % json.dumps(diag, ensure_ascii=False))
            return 1

        p()
        p("开始采集          : %d 秒 / 上限 %d 条（每轮约 %.1fs，对数正态抖动）"
          % (args.seconds, args.limit, livemod.PROBE_EVERY))
        res = livemod.collect(page, seconds=args.seconds, limit=args.limit, log=p)
        rows = res["rows"]
        p()
        p("=== 采集结果 ===")
        p("弹幕总数          : %d 条（%d 轮，停止原因：%s）" % (len(rows), res["rounds"], res["stopped_reason"]))
        if res["stopped_reason"] == "captcha":
            p("%s 撞到验证码：已保留已采集的数据，请人工处理后再跑。" % BAD)
        if not rows:
            p("%s 一条弹幕都没采到 —— 直播间可能没人说话，也可能选择器失效。" % BAD)
            p("   两者症状一样，这是本项目最怕的静默错误：请人工看一眼窗口里到底有没有弹幕。")
            return 1

        queue, scored, stats = livemod.build_queue(
            rows, room=res.get("room") or rinfo, keywords=args.keywords,
            mode=args.match_mode, min_level=args.min_level,
            require_sec_uid=not args.allow_no_uid,
            only_on_top=args.only_on_top)
        p("含可私信标识      : %d 条（%.1f%%）  <- 没有标识就发不了私信，这个比例就是漏斗天花板"
          % (stats["with_sec_uid"], stats["locatable_rate"]))
        if stats["with_sec_uid"] and stats["locatable_rate"] >= 99:
            p("      ✅ 数据来自页面内存里的弹幕数据模型（每条自带 sec_uid），这是当前的首选数据源。")
        elif stats.get("anonymized"):
            p("      ⚠️ 命中的 %d 条弹幕【全部被平台匿名化】了（uid=111111 / 昵称打码 / 无 sec_uid）——"
              % stats["anonymized"])
            p("         这个直播间在跑福袋或活动接龙，参与者被平台隐去了身份，拿不到人。")
            p("         换一个有人真实聊天的直播间再抓。")
        elif not stats["with_sec_uid"]:
            p("      🔴 一条标识都没拿到：页面数据模型没读到（React 结构变了？），")
            p("         现在退回 DOM 文本采集，而弹幕 DOM 里是没有 sec_uid 的 —— 见 06-直播间截流私信.md §十二。")
        p("关键词命中        : %d 条 / 共 %d 条" % (stats["matched"], stats["total"]))
        p("各档命中数对比（同一条弹幕：越往下越松）:")
        for m in crawlmod.MATCH_MODES:
            mark = "  <- 当前" if m == args.match_mode else ""
            p("  %-7s %5d   %s%s" % (m, stats["modes"][m], crawlmod.MATCH_MODE_LABELS[m], mark))
        p("意向分布          : 高 %d / 中 %d / 低 %d"
          % (stats["levels"]["高意向"], stats["levels"]["中意向"], stats["levels"]["低意向"]))
        p("进队列            : %d 人（跳过：拿不到标识 %d / 同一人重复 %d / 意向不足 %d）"
          % (len(queue), stats["skip"]["not_locatable"], stats["skip"]["duplicate_user"],
             stats["skip"]["low_level"]))
        if scored:
            p()
            p("=== 命中样例（按意向分降序）===")
            for r in scored[: args.show]:
                p("  %-3s %-4s %-12s %s" % (r["score"], r["level"], (r.get("user") or "")[:12],
                                           (r.get("text") or "")[:40]))
                why = "、".join(r.get("reasons") or []) or "（无）"
                p("      命中：%s" % why)

        dp = _dump("live_danmaku.json", rows)
        qp = _dump("live_queue.json", queue)
        p()
        p("弹幕明细 : %s  (%d 条)" % (dp, len(rows)))
        p("私信队列 : %s  (%d 人)" % (qp, len(queue)))
        if queue:
            p()
            p("下一步（dm 默认只预填，不加 --allow-send 绝不发送）：")
            p('  python probe.py dm --queue state/live_queue.json --text "您好{nick}，看到您在直播间提问..."')
            p()
            p("%s 提醒：未互关每人只有 1 条额度（平台明文规则），直播间来的人也一样。" % WARN)
        else:
            p()
            if not stats["with_sec_uid"] and not args.allow_no_uid:
                p("%s 队列为空：这轮没拿到 sec_uid（是不是退回 DOM 采集了？看上面那行提示）。" % WARN)
                p("   兜底：加 --allow-no-uid 用昵称做弱键，靠人工核对。")
            else:
                p("%s 队列为空（有标识的人都进了去重/意向/关键词闸），可放宽关键词或加大 --seconds。" % WARN)
        return 0 if queue else 1
    finally:
        page.close(); browser.close()


def cmd_requeue(args):
    """不联网，只用【已经抓下来的评论】重新筛人出队列。

    为什么要它：换关键词是纯本地计算，没必要再跑一遍搜索与抓评论
    （那会白白消耗账号风险，见 05 号文档的验证码教训）。
    默认还会剔除【台账里已经触达过的人】，清单里就不会再出现他们。
    """
    src = args.comments if os.path.isabs(args.comments) else os.path.join(HERE, args.comments)
    if not os.path.exists(src):
        p("%s 找不到评论文件：%s（先用 crawl 抓一次）" % (BAD, src))
        return 1
    with open(src, "r", encoding="utf-8") as fh:
        comments = json.load(fh)
    queue, stats = crawlmod.build_queue(comments, args.comment_keywords,
                                        min_digg=args.min_digg, mode=args.match_mode)
    excluded = 0
    if not args.keep_contacted:
        done = dmmod.contacted_targets()
        before = len(queue)
        queue = [x for x in queue if x["sec_uid"] not in done]
        excluded = before - len(queue)

    p("评论来源          : %s（%d 条）" % (src, len(comments)))
    p("关键词 / 档位     : %s / %s" % (stats["keywords"] or "(空=全收)", args.match_mode))
    p("命中评论          : %d 条" % stats["matched"])
    p("各档命中数        : %s" % json.dumps(stats["modes"], ensure_ascii=False))
    p("组成队列          : %d 人（同一个人多条已去重 %d）" % (len(queue), stats["dup_commenter"]))
    p("剔除已触达过的人  : %d 人%s" % (excluded, "（--keep-contacted 时不过滤）" if args.keep_contacted else ""))
    out = args.out if os.path.isabs(args.out) else os.path.join(HERE, args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(queue, fh, ensure_ascii=False, indent=2)
    p()
    p("已写入            : %s" % out)
    if queue:
        p()
        p("下一步： python probe.py manual --queue %s --open" % os.path.relpath(out, HERE).replace("\\", "/"))
    return 0 if queue else 1


def cmd_harvest(args):
    """收割 sec_uid：你在直播间点弹幕昵称，程序把新开的用户主页标签收进队列。

    只读标签页 URL 与页面昵称，不点击、不导航、不发送。
    """
    return 0 if harvestmod.run(args.port, args.queue, watch_seconds=args.watch,
                               close_tabs=args.close_tabs,
                               close_existing=args.close_existing, log=p) >= 0 else 1


def cmd_shot(args):
    """把当前页面截图存盘（证据采集，供工作日志/开发者审核）。"""
    tab = shotmod.find_tab(args.port, args.tab)
    if not tab:
        p("%s 找不到页面标签" % BAD)
        return 1
    path, size = shotmod.shot(tab, args.out, url=args.url, wait=args.wait,
                              full_page=args.full_page, port=args.port,
                              mask=(args.mask.split(",") if args.mask else None),
                              mask_auto_live=args.mask_live_nicks)
    p("已截图            : %s（%d KB）" % (path, size // 1024))
    p("来源页面          : %s" % (tab.get("url") or "")[:90])
    return 0


def cmd_watch(args):
    """观察学习模式：你在浏览器里点，我把点击目标 / 新出现的卡片 / 新标签全记下来。

    只监听，不点击、不导航、不发送。用来回答"从弹幕昵称到用户主页有没有可达路径"。
    """
    browser, page = connect(args.port)
    try:
        n = watchmod.watch(page, port=args.port, seconds=args.seconds,
                           out=args.out, log=p)
    finally:
        page.close(); browser.close()
    return 0 if n else 1


def cmd_manual(args):
    """人工点击工作台：程序出清单与话术并记账，人负责点【用户→主页→私信→发送】。

    🔴 本命令【不碰浏览器】：不导航、不点击、不发送。它只起一个本机网页（127.0.0.1）。
    """
    queue = manualmod.load_queue(args.queue)
    if not queue:
        p("%s 队列是空的：%s" % (BAD, args.queue))
        return 1
    ledger = dmmod.Ledger(name=args.ledger) if args.ledger else dmmod.Ledger()
    rows = manualmod.apply_ledger_status(manualmod.build_rows(queue, ledger), ledger)
    snap = dmmod.Quota(ledger).snapshot()
    p("目标数            : %d（已完成 %d）" % (len(rows), sum(1 for r in rows if r["done"])))
    p("台账              : %s" % os.path.basename(ledger.path))
    p("额度              : 今日 %d/%d，本小时 %d/%d，单人上限 %d 条"
      % (snap["day_used"], snap["day_limit"], snap["hour_used"], snap["hour_limit"], snap["per_user_max"]))
    return manualmod.serve(rows, ledger, port=args.port, open_browser=args.open, log=p)


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
        summary = dmmod.run_batch(page, queue, args.text, args.allow_send, log=p,
                                  use_templates=not args.literal_text)
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

    v = sub.add_parser("live", help="直播间弹幕截流：采集弹幕 -> 筛 -> 出私信队列（只读）")
    v.add_argument("--url", required=True, help="直播间链接或房间号（live.douyin.com/<房间号>）")
    v.add_argument("--keywords", default="", help="弹幕关键词，逗号分隔；留空则全收")
    v.add_argument("--match-mode", default="seg", choices=list(crawlmod.MATCH_MODES),
                   help="匹配档位，与评论截流同一套语义（默认 seg）")
    v.add_argument("--seconds", type=int, default=livemod.DEFAULT_SECONDS, help="采集时长（秒）")
    v.add_argument("--limit", type=int, default=livemod.DEFAULT_LIMIT, help="最多采集多少条弹幕")
    v.add_argument("--min-level", default="低意向", choices=list(livemod.LEVELS),
                   help="进队列的最低意向等级（默认低意向 = 不按意向淘汰）")
    v.add_argument("--wait", type=int, default=45, help="等弹幕开始渲染的超时（秒）")
    v.add_argument("--show", type=int, default=15, help="打印多少条命中样例")
    v.add_argument("--allow-no-uid", action="store_true",
                   help="弹幕里没有 sec_uid 也进队列（用昵称做弱键）—— 真机实测弹幕标识率 0%%，人工点击场景必须开这个")
    v.add_argument("--only-on-top", action="store_true",
                   help="只留【真的在最上层、能点到】的弹幕行（页面里有被面板盖住的重复列表）")
    v.add_argument("--no-focus", action="store_true",
                   help="不要自动把 Chrome 窗口置前（默认会置前，否则弹幕懒加载/点击都不生效）")
    v.set_defaults(func=cmd_live)

    rq = sub.add_parser("requeue", help="不联网重筛：用已抓到的评论换关键词再出队列")
    rq.add_argument("--comments", default="state/crawl_comments.json", help="已抓到的评论 JSON")
    rq.add_argument("--comment-keywords", default="", help="评论关键词，逗号分隔")
    rq.add_argument("--match-mode", default="seg", choices=list(crawlmod.MATCH_MODES))
    rq.add_argument("--min-digg", type=int, default=0)
    rq.add_argument("--out", default="state/dm_queue.json", help="输出的队列文件")
    rq.add_argument("--keep-contacted", action="store_true",
                    help="不要把已触达过的人剔除（默认剔除）")
    rq.set_defaults(func=cmd_requeue)

    hv = sub.add_parser("harvest", help="收割 sec_uid：你点弹幕昵称，我把新开的主页标签收进队列")
    hv.add_argument("--queue", default="state/live_queue.json", help="要回填的队列 JSON")
    hv.add_argument("--watch", type=int, default=0, help="持续收割多少秒（0 = 扫一遍就退出）")
    hv.add_argument("--close-tabs", action="store_true",
                    help="收完就关掉那些主页标签（默认【保留】，因为你要在上面点【私信】）")
    hv.add_argument("--close-existing", action="store_true",
                    help="扫一遍：把已经打开的主页标签收下来并关闭（收尾清理用）")
    hv.set_defaults(func=cmd_harvest)

    sh = sub.add_parser("shot", help="截图存盘（证据采集，供工作日志/审核）")
    sh.add_argument("--out", required=True, help="输出 PNG 路径")
    sh.add_argument("--tab", default="live", choices=["live", "user", "any"], help="截哪个标签")
    sh.add_argument("--url", default=None, help="先把该标签导航到这个 URL 再截")
    sh.add_argument("--wait", type=float, default=3.0, help="导航后等待秒数")
    sh.add_argument("--full-page", action="store_true", help="截整页（不只是视口）")
    sh.add_argument("--mask", default=None, help="逗号分隔的昵称，截图前替换成『用户NN』（脱敏入库用）")
    sh.add_argument("--mask-live-nicks", action="store_true", help="自动把直播间弹幕里的昵称也打码")
    sh.set_defaults(func=cmd_shot)

    w = sub.add_parser("watch", help="观察学习：你在浏览器里点，我把过程记下来（只监听）")
    w.add_argument("--seconds", type=int, default=1800, help="观察时长（秒，默认 30 分钟）")
    w.add_argument("--out", default=None, help="事件文件（默认 state/observe.jsonl）")
    w.set_defaults(func=cmd_watch)

    m = sub.add_parser("manual", help="人工点击工作台：我出清单+记账，你点主页->私信->发送")
    m.add_argument("--queue", required=True, help="JSON 文件：[{sec_uid,nick,comment},...]")
    m.add_argument("--port", type=int, default=8899, help="本机端口（仅监听 127.0.0.1）")
    m.add_argument("--open", action="store_true", help="自动用默认浏览器打开工作台")
    m.add_argument("--ledger", default=None, help="台账文件名（默认 send_ledger.jsonl，与自动发送共用）")
    m.set_defaults(func=cmd_manual)

    c = sub.add_parser("dm", help="批量私信（默认只预填）")
    c.add_argument("--queue", required=True, help="JSON 文件：[{sec_uid,nick},...]")
    c.add_argument("--text", required=True, help="话术，支持 {nick} 占位")
    c.add_argument("--allow-send", action="store_true")
    c.add_argument("--literal-text", action="store_true",
                   help="原样发送 --text（默认是从话术库 8 条模板里均衡轮换）")
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
