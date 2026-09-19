"""观察学习模式 —— 你在浏览器里点，我在旁边把过程原样记下来。

用途（2026-09-19 用户提的）：用户手动走一遍「点弹幕昵称 -> 点头像 -> 点私信」，
程序在**不干扰操作**的前提下记录：
  · 每一次点击落在哪个元素上（tag/class/文本/坐标），以及该坐标上最上层是不是它
  · 点击后 DOM 里**新出现**的卡片/弹窗（含其中出现的 /user/ 链接）
  · URL 变化与新标签页

学到的东西用来回答一个具体问题：**从弹幕昵称到用户主页，到底有没有可达路径。**
如果这条路存在，就能把 sec_uid 拿到手，直播间截流才有闭环。

边界：只监听，不点击、不导航、不发送。装的是页面里的事件监听 + MutationObserver。
"""
import json
import os
import time

import cdp as cdpmod

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")

RECORDER_JS = r"""
(function(){
  if (window.__dshObs && window.__dshObs.version === 2) return 'already';
  var KEY = '__dsh_obs_events';
  function load(){ try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch(e){ return []; } }
  function save(a){ try { sessionStorage.setItem(KEY, JSON.stringify(a.slice(-400))); } catch(e){} }
  var buf = load();
  function desc(el){
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    var t = '';
    try { t = (el.innerText || el.textContent || '').replace(/\s+/g,' ').slice(0,40); } catch(e){}
    var cls = '';
    try { cls = String((el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className||'')); } catch(e){}
    return { tag: el.tagName, cls: cls.slice(0,70), id: el.id || '',
             text: t, w: Math.round(r.width), h: Math.round(r.height),
             x: Math.round(r.x), y: Math.round(r.y) };
  }
  function push(o){
    o.t = Date.now(); o.url = location.href;
    buf.push(o); save(buf);
    if (buf.length > 400) buf = buf.slice(-400);
  }
  window.__dshObs = {
    version: 2,
    push: push,
    drain: function(){ var out = buf.slice(); buf = []; save(buf); return out; },
    count: function(){ return buf.length; }
  };
  document.addEventListener('click', function(e){
    var top = null;
    try { top = document.elementFromPoint(e.clientX, e.clientY); } catch(err){}
    var ptr = null, a = e.target, k = 0;
    try {
      while (a && k < 6) {
        if (getComputedStyle(a).cursor === 'pointer') { ptr = desc(a); break; }
        a = a.parentElement; k++;
      }
    } catch(err){}
    push({ kind:'click', x:e.clientX, y:e.clientY,
           target: desc(e.target), top: desc(top), pointerAncestor: ptr });
  }, true);
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') push({ kind:'key', key:'Escape' });
  }, true);
  var INT = /card|Card|popup|Popup|dialog|Dialog|profile|Profile|user|User|panel|Panel|modal|Modal|drawer|Drawer/;
  var mo = new MutationObserver(function(muts){
    for (var i=0;i<muts.length;i++){
      var added = muts[i].addedNodes || [];
      for (var j=0;j<added.length;j++){
        var n = added[j];
        if (!n || n.nodeType !== 1) continue;
        var cls = '';
        try { cls = String(n.className || ''); } catch(e){}
        var links = [];
        try {
          var as = n.querySelectorAll ? n.querySelectorAll('a[href*="/user/"]') : [];
          for (var q=0;q<as.length && q<4;q++) links.push(as[q].getAttribute('href'));
        } catch(e){}
        if (!INT.test(cls) && !links.length && n.tagName !== 'A') continue;
        var t = '';
        try { t = (n.innerText || '').replace(/\s+/g,' ').slice(0,60); } catch(e){}
        var html = '';
        try { html = (n.outerHTML || '').replace(/\s+/g,' ').slice(0,700); } catch(e){}
        push({ kind:'dom_add', tag:n.tagName, cls:cls.slice(0,80), text:t, links:links, html:html });
      }
    }
  });
  try { mo.observe(document.documentElement, { childList:true, subtree:true }); } catch(e){}
  return 'installed:' + location.href;
})()
"""


def install(page):
    """在当前文档装监听，并保证【以后导航/刷新出来的新文档】也自动装上。"""
    states = []
    try:
        page.call("Page.enable", {}, timeout=10)
    except Exception:
        pass
    try:
        page.call("Page.addScriptToEvaluateOnNewDocument", {"source": RECORDER_JS}, timeout=10)
        states.append("new-document hook")
    except Exception:
        pass
    try:
        states.append(str(page.evaluate(RECORDER_JS)))
    except Exception as exc:
        states.append("install failed: %s" % exc)
    return states


def watch(page, port=9222, seconds=1800, out=None, log=print):
    out = out or os.path.join(STATE_DIR, "observe.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    log("观察模式已开启（只监听，不点击、不导航）")
    for s in install(page):
        log("  注入: %s" % s)
    log("  记录到: %s" % out)
    log("  现在请你在浏览器里操作：点弹幕昵称 -> 点头像 -> 点私信 …")

    known_tabs = {t.get("id"): t for t in cdpmod.list_tabs(port) if t.get("type") == "page"}
    sessions = {page.ws_url: page}
    # 已打开的其他标签也装上：用户很可能在另一个标签/窗口里操作
    for t in cdpmod.list_tabs(port):
        if t.get("type") != "page" or not t.get("webSocketDebuggerUrl"):
            continue
        if t["webSocketDebuggerUrl"] == page.ws_url:
            continue
        try:
            extra = cdpmod.CDP(t["webSocketDebuggerUrl"], port=port, timeout=20)
            sessions[t["webSocketDebuggerUrl"]] = extra
            install(extra)
            log("  已在其他标签装上: %s" % (t.get("url") or "")[:80])
        except Exception:
            pass
    last_url = None
    events = 0
    deadline = time.time() + seconds
    fh = open(out, "a", encoding="utf-8")
    try:
        while time.time() < deadline:
            # 新标签也要装监听（点昵称有可能新开标签）
            for t in cdpmod.list_tabs(port):
                if t.get("type") != "page" or t.get("id") in known_tabs:
                    continue
                known_tabs[t.get("id")] = t
                if not t.get("webSocketDebuggerUrl"):
                    continue
                try:
                    tab = cdpmod.CDP(t["webSocketDebuggerUrl"], port=port, timeout=20)
                    sessions[t["webSocketDebuggerUrl"]] = tab
                    install(tab)
                    log("[新标签] %s" % (t.get("url") or "")[:90])
                    fh.write(json.dumps({"kind": "new_tab", "url": t.get("url"), "at": time.time()},
                                        ensure_ascii=False) + "\n")
                    fh.flush()
                except Exception:
                    pass

            for sess in list(sessions.values()):
                try:
                    if sess.evaluate("location.href") != last_url:
                        last_url = sess.evaluate("location.href")
                except Exception:
                    pass
                try:
                    got = sess.eval_json("(window.__dshObs? window.__dshObs.drain() : null)")
                except Exception:
                    got = None
                for ev in (got or []):
                    events += 1
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
                    fh.flush()
                    log(format_event(ev))
            time.sleep(0.6)
    except KeyboardInterrupt:
        log("（收到中断，停止观察）")
    finally:
        fh.close()
    log("观察结束，共记录 %d 个事件 -> %s" % (events, out))
    return events


def format_event(ev):
    k = ev.get("kind")
    if k == "click":
        t = ev.get("target") or {}
        top = ev.get("top") or {}
        ptr = ev.get("pointerAncestor") or {}
        same = (t.get("tag") == top.get("tag") and t.get("cls") == top.get("cls"))
        return ("[点击] (%s,%s) %s.%s «%s» | 最上层 %s.%s%s | 可点祖先 %s"
                % (ev.get("x"), ev.get("y"), t.get("tag"), (t.get("cls") or "")[:40],
                   (t.get("text") or "")[:26], top.get("tag"), (top.get("cls") or "")[:30],
                   "" if same else "  ⚠️与点击目标不同", (ptr.get("cls") or ptr.get("tag") or "-")[:30]))
    if k == "dom_add":
        return ("[新增DOM] %s.%s «%s»%s"
                % (ev.get("tag"), (ev.get("cls") or "")[:46], (ev.get("text") or "")[:40],
                   ("  链接:" + str(ev.get("links"))) if ev.get("links") else ""))
    if k == "new_tab":
        return "[新标签] %s" % (ev.get("url") or "")[:80]
    if k == "key":
        return "[按键] %s" % ev.get("key")
    return "[事件] %s" % json.dumps(ev, ensure_ascii=False)[:120]
