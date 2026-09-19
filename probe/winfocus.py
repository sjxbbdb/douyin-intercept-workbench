"""Windows 窗口置前 —— 一个被反复踩的坑，单独成文件。

为什么需要它（真机两轮教训，都是"静默错误"）：

1) 采集侧：Chrome 窗口被别的窗口完全遮挡时，页面 document.visibilityState === "hidden"，
   此时 Input.dispatchMouseEvent(mouseWheel) 会一直挂到超时，IntersectionObserver 驱动的
   懒加载也不触发。同一个关键词：可见时 83 条视频，被遮挡时 9 条 —— 而且不报错。

2) 发送侧：批量私信时 worker 标签失去"活动标签"地位，visibilityState === "hidden"，
   点击【不会送达渲染进程】。症状是"私信面板成片打不开"，实测 1 成功 / 5 失败。

关键点：CDP 的 Page.bringToFront / Target.activateTarget 【改不了 Windows 的遮挡判定】，
        必须真的把窗口激活一次（user32 ShowWindow + SetForegroundWindow）。

放在这里而不是 probe.py：dm.py 也要用，放 probe.py 会形成循环 import。
零第三方依赖（ctypes 是标准库）。
"""
import ctypes
import os

_HITS = []


def find_chrome_windows():
    """返回 [(hwnd, title), ...]：可见、标题像 Chrome 的顶层窗口。"""
    if os.name != "nt":
        return []
    try:
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        hits = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            title = buf.value or ""
            if "Chrome" in title and ("- Google Chrome" in title or "抖音" in title):
                hits.append((hwnd, title))
            return True

        user32.EnumWindows(_cb, 0)
        return hits
    except Exception:
        return []


def bring_chrome_front(log=None):
    """把 Chrome 主窗口真正置前。返回是否成功。"""
    hits = find_chrome_windows()
    if not hits:
        return False
    try:
        user32 = ctypes.windll.user32
        for hwnd, _title in hits:
            user32.ShowWindow(hwnd, 9)          # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
        if log:
            log("已把 Chrome 窗口置前 : %s" % hits[0][1][:50])
        return True
    except Exception as exc:
        if log:
            log("[!] 置前失败（%s），若结果明显变少，请手动点一下 Chrome 窗口。" % str(exc)[:60])
        return False
