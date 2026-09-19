"""人工点击工作台的离线回归 —— 不需要浏览器、不需要抖音账号。

验证的是"程序这一半"：清单渲染、话术渲染、主页链接、记账、额度闸、去重、重启恢复。
"人那一半"（点用户 -> 主页 -> 私信 -> 发送）不需要也无法自动化验证。

    python manual_selftest.py
"""
import json
import os
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
os.chdir(HERE)

import dm as dmmod          # noqa: E402
import manual as manualmod  # noqa: E402
import scripts as st        # noqa: E402

QUEUE = "state/dm_queue.json"
TEST_LEDGER = "test_ledger.jsonl"


def main():
    bad = []

    def check(cond, what):
        if not cond:
            bad.append(what)

    if not os.path.exists(QUEUE):
        print("找不到 %s —— 先跑一次 crawl 生成队列。" % QUEUE)
        return 1

    queue = manualmod.load_queue(QUEUE)
    ledger = dmmod.Ledger(name=TEST_LEDGER)
    if os.path.exists(ledger.path):
        os.remove(ledger.path)

    rows = manualmod.apply_ledger_status(manualmod.build_rows(queue, ledger), ledger)
    wb = manualmod.Workbench(rows, ledger, log=lambda _m: None)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), manualmod.make_handler(wb))
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def get(path):
        with urllib.request.urlopen(base + path, timeout=10) as r:
            return r.read().decode("utf-8")

    try:
        page = get("/")
        expect = st.render(st.TEMPLATES[0], nick=queue[0].get("nick") or "",
                           comment=queue[0].get("comment") or "")
        check("人工点击工作台" in page, "页面标题没渲染出来")
        check(page.count("class='btn go'") == len(queue),
              "行数不对：页面 %d 行，队列 %d 人" % (page.count("class='btn go'"), len(queue)))
        check(expect in page, "第 1 行的话术不是模板渲染结果")
        check("https://www.douyin.com/user/" in page, "主页链接没渲染出来")
        check("点主页右上角的【私信】" in page, "操作步骤没渲染出来")
        check("未互关只能发 1 条" in page, "已知的坑没渲染出来")
        check("今日已触达" in page, "额度条没渲染出来")

        get("/mark?i=0&s=sent")
        page2 = get("/")
        check("[已发送]" in page2, "标记后没有显示已发送")
        check("已完成 <b>1</b>" in page2, "已完成计数不对")

        rec = [json.loads(l) for l in open(ledger.path, encoding="utf-8") if l.strip()][-1]
        check(rec.get("verdict") == "manual_sent", "台账 verdict 不对：%s" % rec.get("verdict"))
        check(rec.get("source") == "manual_workbench", "台账来源标记不对")
        check(rec.get("target") == queue[0].get("sec_uid"), "台账 target 不是 sec_uid")

        q = dmmod.Quota(ledger)
        check(q.used_today() == 1, "额度没算上人工发送：%s" % q.used_today())
        check(q.check(queue[0]["sec_uid"])[1] == "quota_user_exceeded",
              "同一个人竟然还能再发一次（去重失效）")
        check(q.check(queue[1]["sec_uid"])[0] is True, "第二个人被误拦")

        get("/mark?i=0&s=sent")     # 重复点击
        check(dmmod.Quota(ledger).used_today() == 1, "重复标记被重复计数")

        get("/mark?i=1&s=blocked")
        recs = [json.loads(l) for l in open(ledger.path, encoding="utf-8") if l.strip()]
        check(recs[-1].get("verdict") == "skipped", "被拦应当记 skipped：%s" % recs[-1].get("verdict"))
        check(dmmod.Quota(ledger).used_today() == 1, "被拦不该计入已触达")

        rows3 = manualmod.apply_ledger_status(
            manualmod.build_rows(manualmod.load_queue(QUEUE), ledger), ledger)
        check(rows3[0]["status"] == "sent" and rows3[1]["status"] == "blocked",
              "重启后没有从台账恢复状态")
    finally:
        httpd.shutdown()
        if os.path.exists(ledger.path):
            os.remove(ledger.path)

    print("=== manual_selftest：人工点击工作台 ===")
    print("  失败 %d 项" % len(bad))
    for b in bad:
        print("   [X] %s" % b)
    print()
    print("SELFTEST FAILED" if bad else "SELFTEST OK")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
