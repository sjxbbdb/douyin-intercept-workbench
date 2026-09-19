"""CDP（Chrome DevTools Protocol）客户端。

设计要点：
  · 单线程同步：命令响应与事件在同一条 WS 上到达，call() 内部循环丢弃事件直到拿到自己的响应。
  · Network 域录制：用于红线 2——必须拿到【平台响应体】判定发送成功，DOM 变化不算。
  · 全部 IO 走 127.0.0.1，不对外暴露（交接包 §2.13 的反面教材就是绑 0.0.0.0）。
"""
import json
import random
import time
import urllib.request

from dsh_ws import RawWebSocket


class CDPError(Exception):
    pass


def _http_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class CDP:
    def __init__(self, ws_url, port=9222, timeout=60.0):
        self.ws_url = ws_url
        self.port = port
        self.timeout = timeout
        self._id = 0
        self.events = []
        self._listeners = {}
        self.ws = RawWebSocket(ws_url, timeout=timeout).connect()

    # ---------- 基础 ----------

    def on(self, method, callback):
        self._listeners.setdefault(method, []).append(callback)

    def call(self, method, params=None, timeout=None):
        self._id += 1
        mid = self._id
        self.ws.send_text(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + (timeout if timeout is not None else self.timeout)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CDPError("timeout waiting for %s" % method)
            self.ws.set_timeout(max(0.5, remaining))
            try:
                msg = json.loads(self.ws.recv_message())
            except Exception as exc:
                raise CDPError("transport error on %s: %s" % (method, exc))
            if "id" in msg and msg["id"] == mid:
                if "error" in msg:
                    raise CDPError("%s -> %s" % (method, json.dumps(msg["error"], ensure_ascii=False)))
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)
                for cb in self._listeners.get(msg["method"], []):
                    try:
                        cb(msg.get("params", {}))
                    except Exception:
                        pass

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass

    # ---------- 求值 ----------

    def evaluate(self, expression, timeout=None, user_gesture=False):
        res = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True, "userGesture": user_gesture},
            timeout=timeout,
        )
        if res.get("exceptionDetails"):
            raise CDPError("JS exception: %s" % json.dumps(res["exceptionDetails"], ensure_ascii=False)[:400])
        return res.get("result", {}).get("value")

    def eval_json(self, expression, timeout=None):
        """把表达式包成 JSON.stringify，避免 returnByValue 对复杂对象的坑。"""
        wrapped = "JSON.stringify((function(){" + "try{return (" + expression + ")}catch(e){return null}" + "})())"
        raw = self.evaluate(wrapped, timeout=timeout)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    # ---------- 真实鼠标/键盘（trusted events） ----------

    def move_mouse(self, x, y, steps=3, jitter=8):
        """分几步把鼠标移过去（真人不会瞬移），并在路径上加轻微抖动。"""
        try:
            cx, cy = self._mouse
        except AttributeError:
            cx, cy = x - random.uniform(60, 200), y - random.uniform(40, 160)
        for i in range(1, steps + 1):
            t = i / float(steps)
            nx = cx + (x - cx) * t + random.uniform(-jitter, jitter)
            ny = cy + (y - cy) * t + random.uniform(-jitter, jitter)
            self.call("Input.dispatchMouseEvent",
                      {"type": "mouseMoved", "x": int(round(nx)), "y": int(round(ny))}, timeout=10)
            time.sleep(random.uniform(0.02, 0.09))
        self._mouse = (float(x), float(y))

    def click_at(self, x, y, jitter=3, human=True):
        """点一下。human=True 时按真人节奏来：移过去 -> 停一下 -> 按下 -> 松开。

        抖动默认只有 ±3px：按钮常常只有 32x32（比如私信的发送图标），
        抖大了会点到旁边 —— "拟人"不能把功能点坏。
        """
        if human:
            self.move_mouse(x, y)
            x += random.uniform(-jitter, jitter)
            y += random.uniform(-jitter, jitter)
            time.sleep(random.uniform(0.08, 0.28))
        x, y = int(round(x)), int(round(y))
        self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y}, timeout=10)
        time.sleep(random.uniform(0.06, 0.2) if human else 0.15)
        self.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1}, timeout=10)
        time.sleep(random.uniform(0.06, 0.16) if human else 0.12)
        self.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1}, timeout=10)

    def insert_text(self, text):
        """一次性插入整段文字（像粘贴）。⚠️ 拟人场景【不要】用它，用 type_text。"""
        self.call("Input.insertText", {"text": text}, timeout=10)

    def type_text(self, text, lo=0.1, hi=0.9, per_char_delay=None, log=None):
        """逐字输入，节奏像真人。返回实际耗时（秒）。

        🔴 2026-09-19 用户要求：每个字母/字的间隔**在 0.1~0.9 秒之间随机**。
           算一下代价：一条 30 字的话术要打 3~27 秒（平均 ~15 秒）。
           这是刻意的 —— "文字瞬间整段出现"是最容易被识别的机器特征之一，
           而这个通道上一旦被识别，代价是账号（见 03 号文档冲突 3）。

        为什么用 Input.dispatchKeyEvent 而不是 insertText（2026-09-19 真机观察）：
          面板正常打开、编辑器里也有文字、发送按钮也点到了，
          但整轮【零个 HTTP 请求、零个带内容的 WS 发送帧】——消息没真的发出去。
          推断：insertText 只改 DOM，富文本编辑器（React 受控组件）的内部状态可能没更新。
          type=char 的按键事件会产生 beforeinput/input，React 收得到。

        per_char_delay 保留兼容：给了它就按固定间隔打（只用于调试/自检）。
        """
        started = time.time()
        total = len(text)
        for i, ch in enumerate(text, 1):
            if ord(ch) > 0xFFFF:
                # emoji 这类非 BMP 字符没法用单个按键事件表达，退回 insertText
                self.insert_text(ch)
            else:
                self.call("Input.dispatchKeyEvent",
                          {"type": "char", "text": ch, "unmodifiedText": ch, "key": ch}, timeout=10)
            if log and (i == 1 or i % 10 == 0 or i == total):
                log("          打字中 %d/%d …" % (i, total))
            time.sleep(per_char_delay if per_char_delay is not None else random.uniform(lo, hi))
        return time.time() - started

    def press_key(self, key, code=None, key_code=None):
        base = {"key": key, "code": code or key, "windowsVirtualKeyCode": key_code or 0, "nativeVirtualKeyCode": key_code or 0}
        self.call("Input.dispatchKeyEvent", dict(base, type="keyDown"), timeout=10)
        self.call("Input.dispatchKeyEvent", dict(base, type="keyUp"), timeout=10)

    # ---------- 标签页 ----------

    def new_tab(self, url, wait_ready=True, timeout=25):
        browser = CDP(self.version_ws(), port=self.port, timeout=timeout)
        try:
            created = browser.call("Target.createTarget", {"url": url}, timeout=15)
            target_id = created["targetId"]
        finally:
            browser.close()
        deadline = time.time() + timeout
        while time.time() < deadline:
            for t in list_tabs(self.port):
                if t.get("id") == target_id and t.get("webSocketDebuggerUrl"):
                    tab = CDP(t["webSocketDebuggerUrl"], port=self.port, timeout=timeout)
                    if wait_ready:
                        self._wait_load(tab, deadline)
                    return tab, target_id
            time.sleep(0.4)
        raise CDPError("new tab not ready")

    def _wait_load(self, tab, deadline):
        done = {"v": False}
        tab.on("Page.loadEventFired", lambda _p: done.__setitem__("v", True))
        try:
            tab.call("Page.enable", timeout=10)
        except Exception:
            pass
        while not done["v"] and time.time() < deadline:
            try:
                tab.call("Runtime.evaluate", {"expression": "1", "returnByValue": True}, timeout=3)
            except Exception:
                break
            time.sleep(0.3)

    def activate_target(self, target_id):
        """把标签页切到前台。

        legacy reply_worker.js 的明确教训："bring tab to front
        (Enter-send requires active tab)" —— 后台标签里点击/懒加载都不可靠。
        """
        try:
            browser = CDP(self.version_ws(), port=self.port, timeout=12)
            try:
                browser.call("Target.activateTarget", {"targetId": target_id}, timeout=10)
            finally:
                browser.close()
        except Exception:
            pass

    def close_tab(self, target_id):
        try:
            browser = CDP(self.version_ws(), port=self.port, timeout=10)
            try:
                browser.call("Target.closeTarget", {"targetId": target_id}, timeout=8)
            finally:
                browser.close()
        except Exception:
            pass

    def version_ws(self):
        version = _http_json("http://127.0.0.1:%d/json/version" % self.port)
        return version["webSocketDebuggerUrl"]


def list_tabs(port=9222):
    return _http_json("http://127.0.0.1:%d/json/list" % port)


def find_page_tab(port=9222, url_contains=None):
    for t in list_tabs(port):
        if t.get("type") != "page":
            continue
        if url_contains and url_contains not in (t.get("url") or ""):
            continue
        if t.get("webSocketDebuggerUrl"):
            return t
    return None


class NetworkRecorder:
    """监听 Network 域，抓取指定 URL 的【响应体】。

    这是红线 2 的实现基础：判定"发送成功"必须依据平台响应，
    而不是"编辑器消失了 / 评论出现在列表里"这类 DOM 现象。
    """

    def __init__(self, cdp, url_predicate):
        self.cdp = cdp
        self.pred = url_predicate
        self.pending = {}   # requestId -> {url, method, status}
        self.finished = {}  # requestId -> record
        cdp.on("Network.requestWillBeSent", self._on_req)
        cdp.on("Network.responseReceived", self._on_resp)
        cdp.on("Network.loadingFinished", self._on_done)

    def _on_req(self, p):
        try:
            if self.pred(p["request"]["url"]):
                self.pending[p["requestId"]] = {
                    "url": p["request"]["url"],
                    "method": p["request"].get("method"),
                    "postData": p["request"].get("postData"),
                }
        except Exception:
            pass

    def _on_resp(self, p):
        rid = p.get("requestId")
        if rid in self.pending:
            self.pending[rid]["httpStatus"] = p.get("response", {}).get("status")

    def _on_done(self, p):
        rid = p.get("requestId")
        if rid in self.pending:
            self.finished[rid] = self.pending.pop(rid)

    def collect(self, wait_seconds=8.0, min_records=0, drain=False):
        """等待并拉取响应体。返回记录列表。

        min_records: 至少等到这么多条【已完成】的响应再返回（0 = 有一条就走）。
                     搜索/评论翻页是多次请求，靠它避免"抓到第一页就收工"。
        drain      : 读完就清空，便于在滚动循环里【反复调用】而不重复拉同一个响应体。
        """
        deadline = time.time() + wait_seconds
        while time.time() < deadline and len(self.finished) < max(1, min_records):
            try:
                self.cdp.call("Runtime.evaluate", {"expression": "1", "returnByValue": True}, timeout=1.5)
            except Exception:
                pass
        items = list(self.finished.items())
        if drain:
            self.finished.clear()
        out = []
        for rid, rec in items:
            body = None
            try:
                got = self.cdp.call("Network.getResponseBody", {"requestId": rid}, timeout=8)
                body = got.get("body")
                if got.get("base64Encoded") and body:
                    import base64 as _b64
                    body = _b64.b64decode(body).decode("utf-8", "replace")
            except Exception as exc:
                rec["bodyError"] = str(exc)
            parsed = None
            if body:
                try:
                    parsed = json.loads(body)
                except Exception:
                    parsed = None
            rec["body"] = body
            rec["parsed"] = parsed
            out.append(rec)
        return out


def ensure_domains(cdp, *domains):
    """幂等地打开 CDP 域。

    🔴 真机教训：NetworkRecorder 只是【注册回调】，域不打开就【一个事件都不会来】——
       症状是"接口响应体抓到 0 条"，而且不报错。抓评论/抓搜索接口前必须确保 Network 已开。
    """
    opened = []
    for dom in domains:
        try:
            cdp.call("%s.enable" % dom, {}, timeout=10)
            opened.append(dom)
        except Exception:
            pass
    return opened
