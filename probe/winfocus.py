"""Windows 窗口置前 —— 只允许操作 sidecar 自己启动的浏览器进程树。

安全边界（平台侧要求，2026-09-26 收紧）：

1) 只允许操作 sidecar 在 browser-owner.json 标记的 PID 及其【子进程】拥有的窗口；
2) 没有可靠 PID（缺失或非法）时直接返回 browser_not_visible 并等待人工 ——
   不得枚举/激活系统上其它 Chrome 窗口（多账号下会抢走别的账号的前台状态）；
3) 禁止 HWND_TOPMOST / SetWindowPos 置顶：不改变任何窗口的置顶状态；
4) 除目标窗口外，不改动其它窗口的前台状态。

职责归属（避免两套可见性恢复机制）：

  · 本模块 = 【窗口级】恢复（Windows user32），唯一调用方是 Sidecar._page()；
  · douyin.ensure_visible() = 【页面级】激活（纯 CDP），发送守卫只调它；
  · 两侧都不得自行枚举窗口，也不得在没有 PID 时"猜"一个窗口。

为什么需要它（真机两轮教训，都是「静默错误」）：

1) 采集侧：Chrome 窗口被别的窗口完全遮挡时 document.visibilityState === "hidden"，
   此时 Input.dispatchMouseEvent(mouseWheel) 会一直挂到超时，懒加载也不触发。
   同一个关键词：可见时 83 条视频，被遮挡时 9 条 —— 而且不报错。

2) 发送侧：worker 标签失去「活动标签」地位时点击【不会送达渲染进程】，
   症状是「私信面板成片打不开」。

关键点：CDP 的 Page.bringToFront / Target.activateTarget 【改不了 Windows 的遮挡判定】，
        必须真的把窗口激活一次（user32 ShowWindow + SetForegroundWindow）。

零第三方依赖（ctypes 是标准库）。
"""
import ctypes
import os

REASON_NOT_VISIBLE = "browser_not_visible"
REASON_UNSUPPORTED = "unsupported_platform"
REASON_NO_WINDOW = "browser_not_visible"  # owned 树里没有窗口时同样交人工，不扩容到别的窗口
SW_RESTORE = 9


def _is_windows():
    """测试注入点：默认按平台判定。"""
    return os.name == "nt"


def _user32():
    """测试注入点：默认取真实 user32。"""
    return ctypes.windll.user32


def _kernel32():
    """测试注入点：默认取真实 kernel32。"""
    return ctypes.windll.kernel32


def coerce_pid(pid):
    """严格解析 PID：只接受正整数；非法值返回 None（由调用方 fail-closed）。

    🔴 修掉旧实现的二次异常：第一处 int(pid) 抛错后，except 分支里再 int(pid) 会二次抛错。
    """
    if isinstance(pid, bool) or pid is None:
        return None
    if isinstance(pid, int):
        return pid if pid > 0 else None
    if isinstance(pid, float):
        return int(pid) if pid.is_integer() and pid > 0 else None
    if isinstance(pid, str):
        text = pid.strip()
        if not text or not text.isdigit():
            return None
        value = int(text)
        return value if value > 0 else None
    return None


def _list_windows():
    """返回 [(hwnd, owner_pid, title), ...]，仅可见顶层窗口。

    单独抽出来是为了让测试可以替换掉它（CI 在 Linux 上跑，不能依赖 WIN 类型）。
    """
    if not _is_windows():
        return []
    from ctypes import wintypes
    user32 = _user32()
    hits = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(max(1, n + 1))
        user32.GetWindowTextW(hwnd, buf, len(buf))
        hits.append((int(hwnd), int(owner.value), buf.value or ""))
        return True

    user32.EnumWindows(_cb, 0)
    return hits


def _descendant_pids(root_pid):
    """返回启动 PID 及其子进程。

    Chrome 常把可见 HWND 交给子进程，而 marker 存的是启动 PID，
    只看 PID 本身会漏掉窗口并误报 browser_not_visible。
    Toolhelp 是只读进程表查询，不触碰任何窗口状态。
    """
    root = int(root_pid)
    if not _is_windows():
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

        kernel = _kernel32()
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


def focus_owned_window(pid, log=None):
    """把 owned pid（或其后代）拥有的窗口置前。

    返回 {"ok": bool, "reason": str, "hwnd": int|None, "touched": int}。
    reason 为空串表示成功；失败一律 fail-closed，由调用方交给人工处理。
    """
    if not _is_windows():
        return {"ok": False, "reason": REASON_UNSUPPORTED, "hwnd": None, "touched": 0}
    root = coerce_pid(pid)
    if root is None:
        # 非法/缺失 PID：直接 fail-closed，不做任何窗口操作，也绝不枚举所有 Chrome
        if log:
            log("[!] 浏览器 PID 非法或缺失（%r）—— browser_not_visible，等待人工置前。" % (pid,))
        return {"ok": False, "reason": REASON_NOT_VISIBLE, "hwnd": None, "touched": 0}
    try:
        owned = _descendant_pids(root)
    except Exception:
        owned = {root}
    try:
        windows = [w for w in _list_windows() if w[1] in owned]
    except Exception:
        windows = []
    if not windows:
        if log:
            log("[!] owned 浏览器进程树里没有可见窗口 —— browser_not_visible")
        return {"ok": False, "reason": REASON_NO_WINDOW, "hwnd": None, "touched": 0}
    hwnd = windows[0][0]
    try:
        user32 = _user32()
        user32.ShowWindow(hwnd, SW_RESTORE)
        ok = bool(user32.SetForegroundWindow(hwnd))
    except Exception as exc:
        if log:
            log("[!] owned browser window activation failed (%s)" % type(exc).__name__)
        return {"ok": False, "reason": REASON_NOT_VISIBLE, "hwnd": hwnd, "touched": 1}
    if not ok and log:
        log("[!] SetForegroundWindow 被系统拒绝 —— 请人工点一下窗口。")
    return {"ok": ok, "reason": "" if ok else REASON_NOT_VISIBLE, "hwnd": hwnd, "touched": 1}


def bring_process_front(pid, log=None):
    """兼容旧调用：只返回是否成功。"""
    return bool(focus_owned_window(pid, log=log).get("ok"))


def bring_chrome_front(pid=None, log=None):
    """兼容旧调用名（历史遗留）。

    🔴 已收紧：**必须**传入 sidecar 标记的 PID。不传或非法时直接 fail-closed ——
    历史上这里会枚举【所有】Chrome 窗口并把它们全部置前，多账号下会互相抢焦点。
    """
    if coerce_pid(pid) is None:
        if log:
            log("[!] bring_chrome_front() 缺少或非法 PID —— 已 fail-closed，不再遍历所有 Chrome 窗口。")
        return False
    return bool(focus_owned_window(pid, log=log).get("ok"))
