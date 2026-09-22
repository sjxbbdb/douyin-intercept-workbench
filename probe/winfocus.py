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
import time

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
            log("[!] 置前失败（%s），若结果明显变少，请手动点一下窗口。" % str(exc)[:60])
        return False


def bring_process_front(pid, log=None):
    """Bring only windows owned by ``pid`` to the foreground."""
    if os.name != "nt" or not pid:
        return False
    try:
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        target = int(pid)
        owned_pids = _descendant_pids(target)
        hits = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value not in owned_pids:
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(max(1, n + 1))
            user32.GetWindowTextW(hwnd, buf, len(buf))
            hits.append((hwnd, buf.value or ""))
            return True

        user32.EnumWindows(_cb, 0)
        if not hits:
            return False
        hwnd = hits[0][0]
        user32.ShowWindow(hwnd, 9)
        return bool(user32.SetForegroundWindow(hwnd))
    except Exception as exc:
        if log:
            log("[!] owned browser window activation failed (%s)" % type(exc).__name__)
        return False


def force_front_any(log=None):
    """不知道 pid 时的强刷：对【所有可见的 Chrome 顶层窗口】做最小化->还原。

    为什么需要：send_actions 那边只有 page（CDP），拿不到 owner pid，
    而它原来用的 douyin.ensure_visible() 是 CDP 那套（Page.setWebLifecycleState
    + 焦点模拟）—— 实测【改不了 Windows 的遮挡判定】。页面 hidden 时点击不送达
    渲染进程，表现就是"私信按钮点上去、面板死活不开"，还容易被误判成平台限制。
    """
    if os.name != "nt":
        return False
    hits = find_chrome_windows()
    if not hits:
        return False
    try:
        user32 = ctypes.windll.user32
        for hwnd, _title in hits:
            user32.ShowWindow(hwnd, 6)
            time.sleep(0.3)
            user32.ShowWindow(hwnd, 9)
            user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.4)
        if log:
            log("force_front_any: %d 个窗口" % len(hits))
        return True
    except Exception as exc:
        if log:
            log("[!] force_front_any failed (%s)" % type(exc).__name__)
        return False


def force_process_front(pid, log=None):
    """更强的一档：遍历 owner 的所有可见顶层窗口，用【最小化->还原】刷新遮挡判定。

    🔴 真机实测（2026-09-21）：
        · GetForegroundWindow() 【已经是】那个 Chrome 窗口时，页面仍可能
          visibilityState === "hidden"，而普通 ShowWindow(9)+SetForegroundWindow
          连试 8 次全部无效、却仍返回 True；
        · 只有最小化->还原能刷新过来；
        · 且有【多个】owner 窗口时（实测出现过两个可见顶层窗口），
          只处理 hits[0] 会漏掉真正承载页面的那个窗口。
    代价是一次闪烁；但按铁律 1，hidden 下的测量全部不可信，代价更大。
    """
    if os.name != "nt" or not pid:
        return False
    try:
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        owned_pids = _descendant_pids(int(pid))
        hits = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value in owned_pids:
                hits.append(hwnd)
            return True

        user32.EnumWindows(_cb, 0)
        if not hits:
            return False
        ok = False
        for hwnd in hits:
            user32.ShowWindow(hwnd, 6)
            time.sleep(0.3)
            user32.ShowWindow(hwnd, 9)
            user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
            ok = bool(user32.SetForegroundWindow(hwnd)) or ok
            time.sleep(0.4)
        if log:
            log("force_process_front: %d 个窗口, ok=%s" % (len(hits), ok))
        return ok
    except Exception as exc:
        if log:
            log("[!] force_process_front failed (%s)" % type(exc).__name__)
        return False


def _descendant_pids(root_pid):
    """Return the launched browser PID plus its own child processes.

    Chrome commonly hands the visible HWND to a child browser process.  The
    sidecar marker stores the launcher PID, so checking that PID alone misses
    the window and incorrectly reports ``browser_not_visible``.  Toolhelp is
    a read-only process table query and keeps the foreground operation scoped
    to the sidecar's process tree.
    """
    root = int(root_pid)
    if os.name != "nt":
        return {root}
    try:
        from ctypes import wintypes
        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
            ]
        kernel = ctypes.windll.kernel32
        snap = kernel.CreateToolhelp32Snapshot(0x00000002, 0)
        if snap in (0, -1):
            return {root}
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            rows = []
            if kernel.Process32FirstW(snap, ctypes.byref(entry)):
                while True:
                    rows.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID)))
                    if not kernel.Process32NextW(snap, ctypes.byref(entry)):
                        break
            owned = {root}
            changed = True
            while changed:
                changed = False
                for child, parent in rows:
                    if parent in owned and child not in owned:
                        owned.add(child)
                        changed = True
            return owned
        finally:
            kernel.CloseHandle(snap)
    except Exception:
        return {root}
