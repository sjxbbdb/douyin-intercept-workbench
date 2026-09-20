# -*- coding: utf-8 -*-
"""只读探针：直播间弹幕行的「回复」入口到底长什么样。

严格遵守只读：只做 mouseMoved(hover) 与 DOM 读取，**不点击、不输入、不发送、不滚动**。
用途：真机选择器取证。输出已脱敏（昵称/ID 一律掩码，只保留 UI 文案与结构）。

用法：
    python live_danmaku_probe.py [直播间URL]
不给 URL 时：优先复用已打开的直播间标签页，否则打开直播广场并进入第一个房间。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cdp as cdpmod
import douyin_selectors as S

PORT = 9222
KEEP_LABELS = ("回复", "举报", "@", "分享", "复制", "关注", "取消", "发送", "说点什么")

ROW_DUMP_JS = r"""(function(){var max=MAXROWS;
  function vis(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
  function all(sels){var out=[];for(var i=0;i<sels.length;i++){var ns=document.querySelectorAll(sels[i]);
    for(var j=0;j<ns.length;j++)out.push(ns[j]);}return out;}
  function first(e,sels){for(var i=0;i<sels.length;i++){var n=e.querySelector(sels[i]);if(n)return n;}}
  function box(e){var r=e.getBoundingClientRect();
    return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}
  function label(t){var v=(t||'').replace(/\u200b/g,' ').trim();if(!v)return '';
    v=v.replace(/\s+/g,' ');return v.length<=6?v:('(masked:'+v.length+')');}
  var items=all(ITEMS).filter(vis), out=[];
  for(var i=0;i<items.length&&out.length<max;i++){
    var e=items[i], descs=[], nodes=e.querySelectorAll('*');
    for(var j=0;j<nodes.length;j++){
      var n=nodes[j];
      if(!vis(n))continue;
      var t=label(n.innerText||n.textContent||'');
      var cls=(n.className||'').toString();
      var d=n.getAttribute('data-e2e')||n.getAttribute('data-e2e-type')||'';
      var role=n.getAttribute('role')||'';
      var isCandidate=/reply/i.test(cls)||/reply/i.test(d)||t==='回复'||role==='button';
      if(!isCandidate)continue;
      var r=n.getBoundingClientRect();
      var top=document.elementFromPoint(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2));
      descs.push({tag:n.tagName.toLowerCase(),cls:cls.slice(0,50),e2e:d.slice(0,40),
                  role:role,text:t,box:box(n),
                  top:(top?(top===n||n.contains(top)||top.contains(n)):'none')});
      if(descs.length>=8)break;
    }
    var row=first(e,CONTENTS)||e;
    out.push({rowBox:box(e),rowText:label((row.innerText||'')),candidates:descs});
  }
  return out;
})()"""


def dump_rows(tab, limit=6):
    js = (ROW_DUMP_JS.replace("ITEMS", json.dumps(list(S.LIVE_COMMENT_ITEMS), ensure_ascii=False))
                   .replace("CONTENTS", json.dumps(list(S.LIVE_COMMENT_CONTENT), ensure_ascii=False))
                   .replace("MAXROWS", str(limit)))
    return tab.eval_json(js) or []


def hover(tab, x, y):
    """只发 mouseMoved：不动鼠标按键，不产生任何点击。"""
    for step in range(3):
        tab.call("Input.dispatchMouseEvent",
                 {"type": "mouseMoved", "x": int(x + step), "y": int(y + step)}, timeout=10)
        time.sleep(0.25)


def browser_cdp():
    tabs = [item for item in cdpmod.list_tabs(PORT) if item.get("webSocketDebuggerUrl")]
    if not tabs:
        raise SystemExit("没有可用的调试目标，Chrome 可能未以 --remote-debugging-port=9222 启动")
    seed = cdpmod.CDP(tabs[0]["webSocketDebuggerUrl"], port=PORT)
    return cdpmod.CDP(seed.version_ws(), port=PORT)


def find_live_tab():
    for item in cdpmod.list_tabs(PORT):
        if item.get("type") == "page" and "live.douyin.com" in (item.get("url") or ""):
            return item
    return None


ROOM_LINK_JS = r"""(function(){
  var links=Array.prototype.slice.call(document.querySelectorAll('a[href]'));
  for(var i=0;i<links.length;i++){
    var h=links[i].getAttribute('href')||'';
    if(/^\/[0-9]{6,}$/.test(h))return h;
    if(/^https?:\/\/live\.douyin\.com\/[0-9]{6,}$/.test(h))return h;
  }
  return '';
})()"""


def open_room(url=None):
    browser = browser_cdp()
    if url:
        return browser.new_tab(url)
    tab, target_id = browser.new_tab("https://live.douyin.com/")
    deadline = time.time() + 20
    href = ""
    while time.time() < deadline:
        href = tab.evaluate(ROOM_LINK_JS) or ""
        if href.startswith("/") or href.startswith("http"):
            break
        time.sleep(1)
    if href:
        full = href if href.startswith("http") else ("https://live.douyin.com" + href)
        tab.call("Page.navigate", {"url": full}, timeout=25)
        time.sleep(2)
    return tab, target_id


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else None
    existing = find_live_tab()
    opened = False
    target_id = None
    if existing:
        tab = cdpmod.CDP(existing["webSocketDebuggerUrl"], port=PORT)
        print("复用已打开的直播间标签页:", (existing.get("url") or "")[:80])
    else:
        tab, target_id = open_room(url)
        opened = True
        print("新开标签页:", (tab.evaluate("location.href") or "")[:90])
    try:
        deadline = time.time() + 45
        rows = []
        while time.time() < deadline:
            rows = dump_rows(tab, limit=6)
            if rows:
                break
            time.sleep(2)
        print("可见弹幕行数:", len(rows))
        if not rows:
            print(json.dumps({"status": "no_danmaku_visible",
                              "url": (tab.evaluate("location.href") or "")[:110]},
                             ensure_ascii=False))
            return
        for index, row in enumerate(rows[:3]):
            print("---- 第 %d 行 (初始) ----" % (index + 1))
            print(json.dumps(row, ensure_ascii=False))
            x = row["rowBox"][0] + max(4, row["rowBox"][2] // 2)
            y = row["rowBox"][1] + max(4, row["rowBox"][3] // 2)
            hover(tab, x, y)
            after = dump_rows(tab, limit=6)
            same = after[index] if index < len(after) else None
            print("---- 第 %d 行 (hover 后) ----" % (index + 1))
            print(json.dumps(same, ensure_ascii=False))
    finally:
        if opened and target_id:
            try:
                browser_cdp().call("Target.closeTarget", {"targetId": target_id}, timeout=10)
                print("已关闭探针标签页")
            except Exception as exc:
                print("关闭标签页失败:", exc)


if __name__ == "__main__":
    main()
