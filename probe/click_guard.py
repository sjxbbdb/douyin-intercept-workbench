# -*- coding: utf-8 -*-
"""受约束的点击：命中测试 + 容器矩形限制 + 审计日志。

🔴 为什么必须有这个模块（2026-09-20 真机事故复盘）：
   自动化是"先量坐标、后点击"，而页面在中间会滚动/重排，于是落点可能跑到别处 ——
   实测点偏到过**浏览器地址栏**（Chrome 的 omnibox 弹层）、也点中过页面上的**头像/资料卡**。
   从这以后，所有会改变页面状态的点击都必须满足三条：

   1. **命中测试**：elementFromPoint(x, y) 拿到的元素，必须落在【预期元素】里（或其祖先上）；
   2. **容器限制**：给了容器矩形时，落点必须在该矩形内 —— 用来把点击锁死在"主聊天列表"里，
      不许跑到页面顶部的弹幕条、头像区或浏览器 chrome 上；
   3. **审计**：每一次尝试（含被拒绝的）都写一行 JSONL，事后可以准确回答"刚才点了什么"。

被拒绝时返回 ok=False，**不点击**（fail-closed）。
"""
import json
import os
import time

_AUDIT = {"path": None}


def set_audit_path(path):
    """设置审计文件路径（一般用 state-dir 下的 click_audit.jsonl）。"""
    _AUDIT["path"] = str(path) if path else None


def audit_path():
    return _AUDIT["path"]


def _audit(entry):
    path = _AUDIT["path"]
    if not path:
        return
    try:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


HIT_JS = (
    "(function(x,y,expect,box,want){"
    "function cls(e){return String((e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className)||'').slice(0,60);}"
    "function chain(e){var out=[],n=e;for(var i=0;i<5&&n;i++){"
    "out.push(n.tagName.toLowerCase()+(cls(n)?'.'+cls(n):''));n=n.parentElement;}return out;}"
    "var hit=document.elementFromPoint(x,y);"
    "if(!hit)return {ok:false,reason:'nothing_at_point'};"
    "var expectHit=false;"
    "for(var i=0;i<expect.length;i++){try{if(hit.closest(expect[i])){expectHit=true;break;}}catch(e){}}"
    "var textHit=null;"
    "if(want){textHit=false;var n=hit;"
    "for(var k=0;k<5&&n;k++){var t=String(n.innerText||n.textContent||'').replace(/\\s+/g,'');"
    "if(t.indexOf(String(want).replace(/\\s+/g,''))>=0){textHit=true;break;}n=n.parentElement;}}"
    "var containerOk=null;"
    "if(box){containerOk=(x>=box[0]&&x<=box[0]+box[2]&&y>=box[1]&&y<=box[1]+box[3]);}"
    "return {ok:true,expectHit:expectHit,textHit:textHit,containerOk:containerOk,"
    "hit:{tag:hit.tagName.toLowerCase(),cls:cls(hit),"
    "textLen:((hit.innerText||'').trim().length)},chain:chain(hit)};})"
)


def probe_point(cdp, x, y, expect_selectors=(), container_box=None, expect_text=""):
    """只读：看 (x,y) 上到底是什么元素、是否命中预期文案/选择器、是否在容器内。"""
    expression = "(%s)(%d,%d,%s,%s,%s)" % (
        HIT_JS, int(x), int(y),
        json.dumps(list(expect_selectors or []), ensure_ascii=False),
        json.dumps(list(container_box)) if container_box else "null",
        json.dumps(str(expect_text or ""), ensure_ascii=False))
    result = cdp.eval_json(expression)
    if not isinstance(result, dict):
        return {"ok": False, "reason": "click_probe_failed"}
    return result


def click_checked(cdp, x, y, expect_selectors=(), container_box=None, label="", page_hint="",
                 expect_text=""):
    """受约束的点击：先验落点（选择器 / 文案 / 容器），通过才点；无论通过与否都写审计。

    返回 {"ok": bool, "reason": str(可选), "probe": {...}}
    """
    probe = probe_point(cdp, x, y, expect_selectors, container_box, expect_text)
    entry = {"ts": time.time(), "label": str(label), "page": str(page_hint),
             "x": int(x), "y": int(y), "expect": list(expect_selectors or []),
             "expectText": str(expect_text or ""),
             "container": list(container_box) if container_box else None,
             "probe": probe, "clicked": False}
    if not probe.get("ok"):
        entry["reason"] = probe.get("reason")
        _audit(entry)
        return {"ok": False, "reason": probe.get("reason") or "click_probe_failed", "probe": probe}
    if expect_selectors and not probe.get("expectHit"):
        entry["reason"] = "click_target_mismatch"
        _audit(entry)
        return {"ok": False, "reason": "click_target_mismatch", "probe": probe}
    if expect_text and probe.get("textHit") is False:
        entry["reason"] = "click_text_mismatch"
        _audit(entry)
        return {"ok": False, "reason": "click_text_mismatch", "probe": probe}
    if container_box and probe.get("containerOk") is False:
        entry["reason"] = "click_outside_container"
        _audit(entry)
        return {"ok": False, "reason": "click_outside_container", "probe": probe}
    cdp.click_at(int(x), int(y))
    entry["clicked"] = True
    _audit(entry)
    return {"ok": True, "probe": probe}
