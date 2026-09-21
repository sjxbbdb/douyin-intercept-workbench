# -*- coding: utf-8 -*-
"""受限沙箱下的测试运行器：把临时目录放到工作区，并且不做清理（rmtree 会被沙箱拒绝）。"""
import os, sys, tempfile, unittest

BOX = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tbox"))
os.makedirs(BOX, exist_ok=True)
tempfile.tempdir = BOX
_counter = [0]


import shutil

_RUN = "%d-%d" % (os.getpid(), int(__import__("time").time()))


def _mkdtemp(suffix=None, prefix=None, dir=None):
    """每次调用一个全新目录。

    🔴 踩过的坑：目录如果不唯一，上一轮跑剩下的 send_state.sqlite3 / live_queue 还在里面，
    下一次运行会读到脏状态（表现是"状态还是 planned""候选列表为空"这类莫名其妙的失败）。
    """
    _counter[0] += 1
    path = os.path.join(BOX, "case-%s-%d" % (_RUN, _counter[0]))
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    return path


class _KeepDir:
    def __init__(self, *args, **kwargs):
        self.name = _mkdtemp()

    def __enter__(self):
        return self.name

    def __exit__(self, *exc):
        return False

    def cleanup(self):
        pass


tempfile.mkdtemp = _mkdtemp
tempfile.TemporaryDirectory = _KeepDir

if __name__ == "__main__":
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    import test_probe
    for name in sys.argv[1:] or [n for n in dir(test_probe) if n.endswith("Tests")]:
        suite.addTests(loader.loadTestsFromTestCase(getattr(test_probe, name)))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    print("总计 %d 个用例，失败 %d，错误 %d" % (result.testsRun, len(result.failures),
                                                len(result.errors)))
    sys.exit(0 if result.wasSuccessful() else 1)
