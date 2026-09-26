# -*- coding: utf-8 -*-
'''窗口焦点安全边界 —— 只允许操作 sidecar 标记的浏览器进程树。

平台侧要求（2026-09-26）：
  1) 只操作 sidecar 标记的 PID 及其子进程拥有的窗口；
  2) 没有可靠 PID 时直接返回 browser_not_visible 并等待人工，绝不遍历所有 Chrome 窗口；
  3) 禁止置顶类 API（HWND_TOPMOST / SetWindowPos）；
  4) 不改动其它账号、其它 Chrome 窗口的前台/置顶状态；
  5) 页面状态 unknown 不等于 hidden，且 unknown 不得自动重试发送。

这些用例在任意平台可跑：通过替换 winfocus 的注入点与 send_actions.douyin 构造场景。
'''
import ast
import pathlib
import sys
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import send_actions  # noqa: E402
import winfocus  # noqa: E402


class FakeUser32:
    '''只实现本模块用到的三个 API。'''

    def __init__(self, foreground_result=1):
        self.foreground_result = foreground_result
        self.show_window = []
        self.set_foreground = []

    def ShowWindow(self, hwnd, command):
        self.show_window.append((hwnd, command))
        return 1

    def SetForegroundWindow(self, hwnd):
        self.set_foreground.append(hwnd)
        return self.foreground_result


class FakeGate:
    '''只记录 finish/result，用于可见性守卫的单测。'''

    def __init__(self):
        self.finished = []

    def finish(self, send_id, status, reason='', evidence=None):
        row = {'sendId': send_id, 'status': status, 'reason': reason, 'evidence': evidence or {}}
        self.finished.append(row)
        return row

    def result(self, row):
        return {'status': row['status'], 'reason': row['reason'], 'evidence': row['evidence']}


class WindowFocusScopeTests(unittest.TestCase):
    def setUp(self):
        self._saved = (winfocus._is_windows, winfocus._user32, winfocus._list_windows,
                       winfocus._descendant_pids)
        winfocus._is_windows = lambda: True
        self.user32 = FakeUser32()
        winfocus._user32 = lambda: self.user32
        self.windows = []
        self.list_calls = []

        def _list():
            self.list_calls.append(True)
            return list(self.windows)

        winfocus._list_windows = _list
        self.trees = {}
        winfocus._descendant_pids = lambda pid: self.trees.get(int(pid), {int(pid)})

    def tearDown(self):
        (winfocus._is_windows, winfocus._user32, winfocus._list_windows,
         winfocus._descendant_pids) = self._saved

    def test_missing_pid_is_fail_closed_and_never_enumerates(self):
        '''没有可靠 PID：直接 browser_not_visible，且不得枚举任何窗口。'''
        self.windows = [(101, 4242, 'Chrome A - Google Chrome'),
                        (202, 9999, 'Chrome B - Google Chrome')]
        result = winfocus.focus_owned_window(None)
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'browser_not_visible')
        self.assertEqual(result['touched'], 0)
        self.assertEqual(self.list_calls, [], '无 PID 时不得遍历窗口')
        self.assertEqual(self.user32.set_foreground, [])
        self.assertEqual(self.user32.show_window, [])

    def test_only_owned_window_is_touched(self):
        '''两个 Chrome 窗口：只允许动 owned 的那个。'''
        self.windows = [(101, 4242, 'owned - Google Chrome'),
                        (202, 9999, 'other account - Google Chrome')]
        result = winfocus.focus_owned_window(4242)
        self.assertTrue(result['ok'])
        self.assertEqual(result['hwnd'], 101)
        self.assertEqual(self.user32.set_foreground, [101])
        self.assertNotIn(202, self.user32.set_foreground)
        self.assertEqual([hwnd for hwnd, _cmd in self.user32.show_window], [101])

    def test_child_process_window_is_accepted(self):
        '''Chrome 把可见窗口交给子进程时仍应命中（marker 存的是启动 PID）。'''
        self.windows = [(303, 4243, 'owned child - Google Chrome')]
        self.trees = {4242: {4242, 4243}}
        result = winfocus.focus_owned_window(4242)
        self.assertTrue(result['ok'])
        self.assertEqual(self.user32.set_foreground, [303])

    def test_multi_account_isolation(self):
        '''多账号：聚焦 B 不得触碰 A 的窗口。'''
        self.windows = [(11, 101, 'account A - Google Chrome'),
                        (22, 201, 'account B - Google Chrome')]
        self.trees = {100: {100, 101}, 200: {200, 201}}
        result = winfocus.focus_owned_window(200)
        self.assertTrue(result['ok'])
        self.assertEqual(self.user32.set_foreground, [22])
        self.assertNotIn(11, self.user32.set_foreground)

    def test_owned_tree_without_window_is_not_visible(self):
        '''owned 进程树里没有可见窗口 → 仍按 not visible 处置，不扩容到别的窗口。'''
        self.windows = [(202, 9999, 'other - Google Chrome')]
        result = winfocus.focus_owned_window(4242)
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'browser_not_visible')
        self.assertEqual(self.user32.set_foreground, [])

    def test_foreground_denied_reports_not_visible(self):
        '''系统拒绝置前 → 如实报 not visible，不假装成功。'''
        self.user32 = FakeUser32(foreground_result=0)
        winfocus._user32 = lambda: self.user32
        self.windows = [(101, 4242, 'owned - Google Chrome')]
        result = winfocus.focus_owned_window(4242)
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'browser_not_visible')
        self.assertEqual(result['touched'], 1)

    def test_legacy_entry_points_are_fail_closed_without_pid(self):
        '''旧的 bring_chrome_front() 无参调用必须 fail-closed。'''
        self.windows = [(101, 4242, 'Chrome A - Google Chrome')]
        self.assertFalse(winfocus.bring_chrome_front())
        self.assertEqual(self.list_calls, [])
        self.assertEqual(self.user32.set_foreground, [])
        self.assertFalse(winfocus.bring_process_front(None))
        self.assertTrue(winfocus.bring_process_front(4242))

    def test_source_forbids_topmost_and_scoped_enumeration(self):
        '''源码级红线（只看 AST，注释里提及不算）：不得调用置顶 API。'''
        source = pathlib.Path(winfocus.__file__).read_text(encoding='utf-8')
        used = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Attribute):
                used.add(node.attr)
            elif isinstance(node, ast.Name):
                used.add(node.id)
        forbidden = {'SetWindowPos', 'HWND_TOPMOST', 'HWND_NOTOPMOST',
                     'SetLayeredWindowAttributes', 'SetWindowLongW'}
        self.assertEqual(used & forbidden, set(), '不得调用置顶/层级 API')
        self.assertNotIn('find_chrome_windows', used, '不得按标题枚举所有 Chrome')
        self.assertNotIn('in title', source, '旧的按标题枚举实现必须移除')


class VisibilityGateTests(unittest.TestCase):
    '''unknown 不等于 hidden；unknown 不得自动重试发送。'''

    def setUp(self):
        self._saved = (send_actions.douyin.visibility_state, send_actions.douyin.ensure_visible)
        self.states = []
        self.ensure_calls = []
        self.gate = FakeGate()

        def _state(_tab):
            return self.states.pop(0) if self.states else 'unknown'

        send_actions.douyin.visibility_state = _state
        send_actions.douyin.ensure_visible = lambda tab, **kwargs: self.ensure_calls.append(tab) or True

    def tearDown(self):
        (send_actions.douyin.visibility_state, send_actions.douyin.ensure_visible) = self._saved

    def test_unknown_is_not_hidden_and_never_retries(self):
        self.states = ['unknown']
        result = send_actions._visibility_gate(object(), self.gate, 'send-1')
        self.assertIsNotNone(result, 'unknown 必须交人工，不得继续发送')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['reason'], 'page_visibility_unknown')
        self.assertTrue(result['evidence'].get('manualAction'))
        self.assertEqual(self.ensure_calls, [], 'unknown 不得被当成 hidden 去置前')
        self.assertEqual(len(self.gate.finished), 1, 'unknown 只落一条账，不重试')

    def test_hidden_recovers_when_window_becomes_visible(self):
        self.states = ['hidden', 'visible']
        result = send_actions._visibility_gate(object(), self.gate, 'send-2')
        self.assertIsNone(result)
        self.assertEqual(len(self.ensure_calls), 1)
        self.assertEqual(self.gate.finished, [])

    def test_hidden_that_cannot_recover_is_blocked_not_retried(self):
        self.states = ['hidden', 'hidden']
        result = send_actions._visibility_gate(object(), self.gate, 'send-3')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['reason'], 'browser_not_visible')
        self.assertEqual(len(self.gate.finished), 1)


if __name__ == '__main__':
    unittest.main()
