"""截图/证据采集：把当前浏览器页面存成 PNG，供工作日志与开发者审核。

用法：
    python probe.py shot --out worklog/screenshots/01.png [--tab live] [--url <要打开的页面>]

为什么需要它：本项目多次出现"看起来正常、其实静默降级"的问题（隐藏窗口、被遮挡的列表、
被搜索框盖住的按钮）。**截图是唯一能一眼看出"当时到底长什么样"的证据**，
比日志里的一行 "ok" 强得多。
"""
import base64
import os
import time

import cdp as cdpmod
import douyin


def find_tab(port=9222, match="live"):
    """按关键字挑一个页面标签：live / user / any。"""
    tabs = [t for t in cdpmod.list_tabs(port) if t.get("type") == "page"]
    if match == "live":
        for t in tabs:
            u = t.get("url") or ""
            if "live.douyin.com/" in u and any(ch.isdigit() for ch in u.split("/")[-1].split("?")[0]):
                return t
    if match == "user":
        for t in tabs:
            if "/user/MS4wLjABAAAA" in (t.get("url") or ""):
                return t
    return tabs[0] if tabs else None


MASK_JS = (
    "(function(){"
    "var names=%(names)s, n=0, map={};"
    "function ph(s){ if(!map[s]){ n++; map[s]='用户'+('0'+n).slice(-2); } return map[s]; }"
    # 自动收集：直播间弹幕昵称
    "if(%(auto_live)d){"
    " try{ Array.from(document.querySelectorAll('span.v8LY0gZF')).forEach(function(e){"
    "  var t=(e.innerText||'').replace(/：$/,'').trim(); if(t&&names.indexOf(t)<0) names.push(t); }); }catch(err){}"
    "}"
    "var walker=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);"
    "var nodes=[], node;"
    "while((node=walker.nextNode())){ var v=node.nodeValue; if(!v||!v.trim()) continue;"
    " var hit=false;"
    " for(var i=0;i<names.length;i++){ if(names[i] && v.indexOf(names[i])>=0){ v=v.split(names[i]).join(ph(names[i])); hit=true; } }"
    " if(hit) node.nodeValue=v; }"
    "return names.length;})()"
)


def mask_page(page, names=None, auto_live=True):
    """把页面上的昵称替换成"用户NN"，用于生成可入库的脱敏截图。"""
    import json as _json
    js = MASK_JS % {"names": _json.dumps(names or [], ensure_ascii=False),
                    "auto_live": 1 if auto_live else 0}
    try:
        return page.evaluate(js)
    except Exception:
        return 0


def shot(tab, out_path, url=None, wait=3.0, full_page=False, port=9222,
         mask=None, mask_auto_live=False):
    """截一张图，返回文件路径与字节数。mask=昵称列表，会先替换成"用户NN"再截。"""
    page = cdpmod.CDP(tab["webSocketDebuggerUrl"], port=port, timeout=40)
    try:
        try:
            page.call("Page.enable", {}, timeout=10)
        except Exception:
            pass
        if url:
            page.call("Page.navigate", {"url": url}, timeout=40)
            deadline = time.time() + 30
            while time.time() < deadline:
                try:
                    if page.evaluate("document.readyState") == "complete":
                        break
                except Exception:
                    pass
                time.sleep(0.5)
        # 页面可能被判定为遮挡（hidden）：先拉回 active，否则截图内容可能不更新
        douyin.ensure_visible(page)
        time.sleep(wait)
        if mask or mask_auto_live:
            mask_page(page, names=list(mask or []), auto_live=bool(mask_auto_live))
            time.sleep(0.8)
        res = page.call("Page.captureScreenshot",
                        {"format": "png", "captureBeyondViewport": bool(full_page)}, timeout=30)
        data = base64.b64decode(res.get("data") or "")
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "wb") as fh:
            fh.write(data)
        return out_path, len(data)
    finally:
        page.close()
