"""收割：你点弹幕昵称，我自动把 sec_uid 收下来并回填队列。

为什么要有它（2026-09-19 用户演示后的结论）
------------------------------------------
用户手动点直播间弹幕里的昵称，浏览器会**新开一个标签**，URL 就是
    https://www.douyin.com/user/MS4wLjABAAAA...?enter_from=live_detail&from_tab_name=live
=> **sec_uid 就在 URL 里**。也就是说弹幕 -> 用户主页这条路**是通的**，
   只是程序合成的点击打不开它（真机三次实测：页面可见、坐标命中，仍不新开标签）。

所以分工是：
  · **你**：在直播间里点弹幕昵称（点 4 个大概 30 秒）
  · **程序**：盯着标签页，出现新的 /user/ 主页就自动收 sec_uid + 昵称，
    回填到弹幕队列里，并把标签关掉（省得堆一屏）

边界：只读标签页 URL 与页面上的昵称；不点击、不导航、不发送。
"""
import json
import os
import re
import time

import cdp as cdpmod

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
SEC_RE = re.compile(r"/user/(MS4wLjABAAAA[\w\-]+)")

NICK_JS = (
    "(function(){"
    "var sels=['[data-e2e=\"user-info\"] h1','h1','[class*=\"nickname\"]','[class*=\"Nickname\"]',"
    "'[class*=\"user-name\"]'];"
    "for(var i=0;i<sels.length;i++){var e=document.querySelector(sels[i]);"
    "if(e&&(e.innerText||'').trim())return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40);}"
    "return (document.title||'').replace(/\\s*[-|｜]\\s*抖音.*$/,'').trim().slice(0,40);})()"
)
PRIVATE_JS = ("(function(){var t=document.body?document.body.innerText:'';"
              "return /私密账号|私密账户|该用户已设置私密/.test(t);})()")


def norm(s):
    """昵称归一化：去掉 emoji/符号/空白，只留中英文数字 —— 用于把弹幕昵称与主页昵称对上。"""
    return re.sub(r"[^\w\u4e00-\u9fff]", "", (s or "")).lower()


def read_profile(port, tab):
    """读一个用户主页标签：昵称 / sec_uid / 是否私密。"""
    url = tab.get("url") or ""
    m = SEC_RE.search(url)
    if not m:
        return None
    out = {"sec_uid": m.group(1), "url": url, "nick": "", "private": None,
           "tab_id": tab.get("id"), "loaded": False}
    try:
        page = cdpmod.CDP(tab["webSocketDebuggerUrl"], port=port, timeout=20)
        try:
            # ⚠️ 必须等页面加载完再读昵称：刚新开的标签是空白页，
            #    这时候读到的昵称是空的，会把这条线索白白丢掉（而且我们随后就把标签关了）。
            deadline = time.time() + 8
            while time.time() < deadline:
                try:
                    if page.evaluate("document.readyState") == "complete" and (page.evaluate("document.title") or ""):
                        break
                except Exception:
                    pass
                time.sleep(0.4)
            out["nick"] = page.eval_json(NICK_JS) or ""
            out["private"] = bool(page.eval_json(PRIVATE_JS))
            out["loaded"] = bool(out["nick"])
        finally:
            page.close()
    except Exception as exc:
        out["error"] = str(exc)[:60]
    return out


def match_item(queue, prof):
    """把主页对回队列里的那一条（弹幕昵称 vs 主页昵称）。"""
    n = norm(prof.get("nick"))
    if not n:
        return None, "no_nick"
    exact = [it for it in queue if norm(it.get("nick")) == n]
    if len(exact) == 1:
        return exact[0], "exact"
    prefix = [it for it in queue
              if len(norm(it.get("nick"))) >= 3
              and (norm(it.get("nick")).startswith(n[:4]) or n.startswith(norm(it.get("nick"))[:4]))]
    if len(prefix) == 1:
        return prefix[0], "fuzzy"
    if len(exact) > 1 or len(prefix) > 1:
        return None, "ambiguous(%d)" % max(len(exact), len(prefix))
    return None, "not_in_queue"


def harvest_once(port, queue, close_tabs=True, seen=None, log=print):
    """扫一遍所有标签，把新的用户主页收进队列。返回本次收获数。"""
    seen = seen if seen is not None else set()
    got = 0
    for tab in cdpmod.list_tabs(port):
        if tab.get("type") != "page" or not tab.get("webSocketDebuggerUrl"):
            continue
        if tab.get("id") in seen:
            continue
        prof = read_profile(port, tab)
        if not prof:
            continue
        if not prof.get("loaded"):
            continue          # 主页还没加载完：先不标记 seen，下一轮再看
        seen.add(tab.get("id"))
        item, how = match_item(queue, prof)
        tag = "[%s]" % how
        if item is None:
            log("  跳过 %s %s（%s）" % (tag, prof.get("nick") or "(无昵称)", how))
        else:
            item["sec_uid"] = prof["sec_uid"]
            item["key_type"] = "sec_uid"
            item["match_confidence"] = how
            item["profile_private"] = prof.get("private")
            got += 1
            log("  收下 %s %-16s -> %s%s" % (tag, prof.get("nick"), prof["sec_uid"][:28] + "...",
                                            "  ⚠️ 私密账号" if prof.get("private") else ""))
        if close_tabs:
            try:
                _close(port, tab["id"])
            except Exception:
                pass
    return got


def _close(port, tab_id):
    browser = cdpmod.CDP(cdpmod._http_json("http://127.0.0.1:%d/json/version" % port)["webSocketDebuggerUrl"],
                         port=port, timeout=10)
    try:
        browser.call("Target.closeTarget", {"targetId": tab_id}, timeout=8)
    finally:
        browser.close()


def save_queue(path, queue):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(queue, fh, ensure_ascii=False, indent=2)


def load_queue(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data if isinstance(data, list) else (data.get("targets") or [])


def run(port, queue_path, watch_seconds=0, close_tabs=False, close_existing=False, log=print):
    """收割。

    ⚠️ 2026-09-19 踩坑：close_tabs 默认 True 时，用户点昵称刚打开的主页会被程序立刻关掉 ——
       在用户眼里就是"打开主页就闪退"，而且他还要在那个页面上点【私信】，等于把路堵死了。
       所以默认【不关】：只读走 sec_uid，标签留着给人用。想清理时加 --close-tabs / --close-existing。
    """
    queue = load_queue(queue_path)
    log("队列: %s（%d 人，其中已有 sec_uid 的 %d 人）"
        % (queue_path, len(queue), sum(1 for it in queue if it.get("sec_uid"))))
    log("请你在直播间里点弹幕昵称 —— 每点一个，这里就会收下一条。")
    log("主页标签【会保留】：你还要在它上面点【私信】。收完想清理，用 --close-existing。")
    seen = set()
    total = 0
    if close_existing:
        close_tabs = True
        log("本次会把扫到的主页标签收完后关闭。")
    deadline = time.time() + watch_seconds if watch_seconds else None
    try:
        while True:
            total += harvest_once(port, queue, close_tabs=close_tabs, seen=seen, log=log)
            if total:
                save_queue(queue_path, queue)
            if deadline is None or time.time() >= deadline:
                break
            time.sleep(2.0)
    except KeyboardInterrupt:
        log("（停止收割）")
    save_queue(queue_path, queue)
    done = sum(1 for it in queue if it.get("sec_uid"))
    log("本次收获 %d 条；队列里现在有 sec_uid 的：%d/%d 人" % (total, done, len(queue)))
    log("已写回 %s" % queue_path)
    if done:
        log("下一步： python probe.py manual --queue %s --open" % os.path.relpath(queue_path))
    return total
