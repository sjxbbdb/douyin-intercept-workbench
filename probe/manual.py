"""人工点击工作台 —— 程序出清单与记账，人来点【用户 -> 主页 -> 私信 -> 发送】。

分工（2026-09-19 用户明确）
--------------------------
· **人**：在浏览器里点用户 -> 进主页 -> 点【私信】-> 粘贴话术 -> 点发送。
  动作由真人完成，节奏自然，不产生"程序驱动发送"的痕迹。
· **程序**：抓评论 -> 筛人 -> 备话术 -> 给主页直达链接 -> **记账/去重/额度/漏斗**。

边界
----
本模块**不驱动浏览器做任何发送或导航动作**：它只起一个本机网页（127.0.0.1），
把清单和按钮摆出来，点不点、发不发、发什么，全部由人决定。
发送结果写进 dm.py 的【同一本台账】，因此额度闸与去重对自动/人工两条路都生效 ——
同一个人绝不会被重复打扰两次（平台最敏感的就是这个）。

用法
----
    python probe.py manual --queue state/dm_queue.json          # 起工作台（默认 127.0.0.1:8899）
    python probe.py manual --queue state/dm_queue.json --port 9000 --open
"""
import html
import json
import os
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import dm as dmmod
import scripts as st

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
PROFILE_URL = "https://www.douyin.com/user/%s"

# 人工结果的判定（写进同一本 ledger）
MARK_VERDICTS = {
    "sent":    ("manual_sent", "human_confirmed"),
    # 主页上找不到「私信」按钮、或点了出现陌生人拦截文案 —— 都算这一档：
    # 命中但没有发起触达，按 protocol 的口径属于 skipped，不是 failed。
    "blocked": ("skipped", "stranger_dm_disabled_manual"),
    "skip":    ("skipped", "human_skipped"),
}
MARK_LABELS = {"sent": "已发送", "blocked": "被拦/无入口", "skip": "跳过"}

OPERATION_STEPS = [
    "点【打开主页】——目标主页在新标签打开",
    "点主页右上角的【私信】（找不到 = 对方关闭了私信，回来点【被拦/无入口】）",
    "把话术粘进输入框（未互关只能发 1 条文字，发完就是最终效果）→ 点发送",
    "看会话里文案是否出现：出现 = 发出去了；出现「给对方发送的消息已达上限」= 被拦",
    "回来点【已发送】或【被拦/无入口】——程序据此记账，同一个人不会再出现在清单里",
]

KNOWN_TRAPS = [
    "私信面板有时点不开：把 Chrome 窗口真正切到前台，再点一次（实测窗口被遮挡时点击不会送达页面）",
    "未互关只能发 1 条文字（平台明文规则）；对方回复或关注后才解锁",
    "出现「对方无法回复你的私信」= 消息多半发出去了，但对方回不了，漏斗断在等回复",
    "出现「给对方发送的消息已达上限」= 这条没发出去，按被拦记",
]


# ===================== 清单 =====================

def load_queue(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("targets") or []
    return data


def build_rows(queue, ledger):
    """把队列变成工作台的行：话术（模板均衡轮换）+ 主页链接 + 是否已触达。"""
    quota = dmmod.Quota(ledger)
    rows = []
    for i, item in enumerate(queue):
        sec_uid = item.get("sec_uid") or ""
        nick = item.get("nick") or ""
        comment = item.get("comment") or ""
        tpl = st.TEMPLATES[i % len(st.TEMPLATES)]
        text = st.render(tpl, nick=nick, comment=comment)
        # 🔴 弹幕来源没有 sec_uid（真机实测 0%），此时只能用昵称做【弱键】记账：
        #    昵称可改、可重复，所以它是"线索"不是"身份" —— 页面会明确提示这一点。
        key = sec_uid or ("nick:" + nick)
        rows.append({
            "i": i,
            "key": key,
            "key_type": "sec_uid" if sec_uid else "nick_weak",
            "sec_uid": sec_uid,
            "nick": nick,
            "comment": comment,
            "keyword": item.get("matched_keyword") or "",
            # 来源视频/直播间标题：人来做判断时，"这条评论是在谁的内容下说的"很关键
            "source_title": item.get("video_title") or item.get("room_title") or "",
            "source_id": item.get("aweme_id") or item.get("room_id") or "",
            "profile_url": PROFILE_URL % sec_uid if sec_uid else "",
            "text": text,
            "template_id": tpl.get("id"),
            "level": item.get("level") or "",
            "score": item.get("score"),
            "reasons": item.get("reasons") or [],
            "status": "",
            # 已经占用过对方机会的人：直接标出来并禁用按钮（去重，绝不重复打扰）
            "done": bool(key) and quota.used_for_user(key) > 0,
        })
    return rows


def apply_ledger_status(rows, ledger):
    """重启后从台账恢复：谁已经发过、谁被拦过。"""
    latest = {}
    for r in ledger.all():
        if r.get("kind") == "result" and r.get("source") == "manual_workbench":
            latest[r.get("target")] = r.get("verdict")
    for row in rows:
        v = latest.get(row["key"])
        if v == "manual_sent":
            row["status"], row["done"] = "sent", True
        elif v == "skipped":
            row["status"], row["done"] = "blocked", True
    return rows


# ===================== 页面 =====================

def render_page(rows, snapshot, note=""):
    def esc(v):
        return html.escape(str(v or ""))

    css = (
        "body{font:14px/1.6 'Microsoft YaHei',system-ui;margin:24px;background:#f6f7f9;color:#222}"
        "h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:22px 0 6px}"
        ".bar{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:12px 14px;margin:10px 0}"
        ".ok{color:#0a7d32}.warn{color:#b8860b}.bad{color:#c0392b}"
        "table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden}"
        "th,td{border-bottom:1px solid #eceff2;padding:8px 10px;text-align:left;vertical-align:top}"
        "th{background:#f0f2f5;font-weight:600}"
        "tr.done{opacity:.5}"
        "a.btn,button{display:inline-block;padding:4px 10px;margin:1px 2px;border:1px solid #c9ced6;"
        "border-radius:6px;background:#fff;cursor:pointer;font-size:13px;text-decoration:none;color:#222}"
        "a.go{background:#1f6feb;border-color:#1f6feb;color:#fff}"
        "button.sent{background:#0a7d32;border-color:#0a7d32;color:#fff}"
        "button.block{background:#c0392b;border-color:#c0392b;color:#fff}"
        ".q{color:#666}.mono{font-family:Consolas,monospace;font-size:12px}"
        "ul{margin:6px 0 0 18px;padding:0}li{margin:2px 0}"
    )

    out = ["<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>",
           "<title>截流 · 人工点击工作台</title><style>%s</style></head><body>" % css,
           "<h1>人工点击工作台</h1>",
           "<div class='bar'>你负责：<b>点用户 → 进主页 → 点私信 → 发送</b>；"
           "程序负责：<b>清单 / 话术 / 记账 / 去重</b>。</div>",
           "<div class='bar'>今日已触达 <b>%d/%d</b> 人 ｜ 本小时 <b>%d/%d</b> 人 ｜ "
           "单人上限 <b>%d</b> 条 ｜ 清单 <b>%d</b> 人，已完成 <b>%d</b> 人%s</div>"
           % (snapshot["day_used"], snapshot["day_limit"], snapshot["hour_used"], snapshot["hour_limit"],
              snapshot["per_user_max"], len(rows), sum(1 for r in rows if r["done"]),
              (" ｜ <span class='ok'>%s</span>" % esc(note)) if note else "")]

    out.append("<div class='bar'><b>操作步骤</b><ul>")
    for s in OPERATION_STEPS:
        out.append("<li>%s</li>" % esc(s))
    out.append("</ul><b>已知的坑</b><ul>")
    for s in KNOWN_TRAPS:
        out.append("<li>%s</li>" % esc(s))
    out.append("</ul></div>")

    weak = sum(1 for r in rows if r["key_type"] == "nick_weak")
    if weak:
        out.append(
            "<div class='bar warn'><b>⚠️ 这份清单里有 %d 人只有【昵称】没有用户标识</b>"
            "（弹幕来源，真机实测标识率 0%%）：程序给不了主页链接，需要你在直播间里找到这个人。<br>"
            "昵称<b>可以改、可以重复</b> —— 它只是线索，不是身份，找人时请自己核对清楚"
            "（对不上就点【被拦/找不到】，别赌）。其余 %d 人有标识，可以直接点【打开主页】。</div>"
            % (weak, len(rows) - weak))

    out.append("<h2>清单</h2><table><tr><th>#</th><th>昵称 / 评论（弹幕）</th><th>话术（复制后粘贴）</th>"
               "<th>操作</th></tr>")
    for r in rows:
        cls = " class='done'" if r["done"] else ""
        status = ""
        if r["status"] == "sent":
            status = " <span class='ok'>[已发送]</span>"
        elif r["status"] == "blocked":
            status = " <span class='bad'>[被拦/未找到]</span>"
        nick = esc(r["nick"]) or "<span class='q'>(昵称空)</span>"
        intent = ""
        if r["level"]:
            intent = "<br><span class='q'>意向 %s / %s · %s</span>" % (
                esc(r["score"]), esc(r["level"]), esc("、".join(r["reasons"]) or "无"))
        if r["profile_url"]:
            action = ("<a class='btn go' href='%s' target='_blank' rel='noreferrer'>打开主页</a>"
                      % esc(r["profile_url"]))
        else:
            action = ("<span class='bad'>没有 sec_uid（弹幕来源）</span><br>"
                      "<span class='q'>去直播间按昵称找人</span><br>"
                      "<button onclick=\"navigator.clipboard.writeText(%s)\">复制昵称</button>"
                      % json.dumps(r["nick"], ensure_ascii=False))
        out.append(
            "<tr%s><td>%d</td><td><b>%s</b>%s%s<br><span class='q'>%s</span><br>"
            "<span class='mono q'>%s</span>%s</td>"
            "<td><span class='mono'>%s</span><br>"
            "<button onclick=\"navigator.clipboard.writeText(%s)\">复制话术</button> "
            "<span class='q'>模板 %s</span></td>"
            "<td>%s<br>"
            "<a class='btn' href='/mark?i=%d&s=sent'>已发送</a>"
            "<a class='btn' href='/mark?i=%d&s=blocked'>被拦/找不到</a>"
            "<a class='btn' href='/mark?i=%d&s=skip'>跳过</a>"
            "</td></tr>"
            % (cls, r["i"] + 1, nick, status, intent, esc(r["comment"])[:80], esc(r["keyword"]),
               ("<br><span class='q'>来源：%s</span>" % esc(r["source_title"])[:46]) if r["source_title"] else "",
               esc(r["text"]), json.dumps(r["text"], ensure_ascii=False), esc(r["template_id"]),
               action, r["i"], r["i"], r["i"]))
    out.append("</table>")
    out.append("<div class='bar q'>点【已发送/被拦/跳过】会立刻写进台账（send_ledger.jsonl），"
               "额度闸与自动发送共用同一本。刷新页面不会丢状态。</div>")
    out.append("</body></html>")
    return "\n".join(out)


# ===================== 服务 =====================

class Workbench:
    def __init__(self, rows, ledger, log=print):
        self.rows = rows
        self.ledger = ledger
        self.log = log
        self.lock = threading.Lock()
        # ⚠️ 2026-09-19 踩坑：本来把提示串塞进 Set-Cookie 回传给页面，
        #    但昵称是中文 —— HTTP 头必须是 latin-1，直接 500 并把连接打断。
        #    改成存在服务端内存里，重定向后渲染一次。
        self.last_note = ""

    def snapshot(self):
        return dmmod.Quota(self.ledger).snapshot()

    def mark(self, i, status):
        verdict, reason = MARK_VERDICTS[status]
        with self.lock:
            row = self.rows[i]
            if row["done"] and status == "sent":
                return "已记过账，忽略（避免重复计数）"
            self.ledger.record({
                "kind": "result", "target": row["key"], "target_key_type": row["key_type"],
                "nick": row["nick"],
                "verdict": verdict, "reason": reason, "source": "manual_workbench",
                "template_id": row["template_id"], "at": time.time(),
            })
            row["status"] = status
            row["done"] = status in ("sent", "blocked")
        msg = "%s -> %s（%s）" % (row["nick"] or row["key"][:12], MARK_LABELS[status], verdict)
        self.log("  [记账] " + msg)
        return msg


def make_handler(wb):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):        # 静音默认访问日志，改成我们自己的
            pass

        def _send(self, body, code=200):
            data = body.encode("utf-8") if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/mark":
                q = parse_qs(u.query)
                try:
                    i = int(q.get("i", ["-1"])[0])
                    s = q.get("s", ["skip"])[0]
                    assert 0 <= i < len(wb.rows) and s in MARK_VERDICTS
                except Exception:
                    self._send("参数不对", 400)
                    return
                wb.last_note = wb.mark(i, s)
                # 303 回到清单，避免刷新重复提交
                self.send_response(303)
                self.send_header("Location", "/")
                self.end_headers()
                return
            self._send(render_page(wb.rows, wb.snapshot(), note=wb.last_note))

    return Handler


def serve(rows, ledger, port=8899, open_browser=False, log=print):
    wb = Workbench(rows, ledger, log=log)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(wb))
    url = "http://127.0.0.1:%d/" % port
    log("工作台：%s" % url)
    log("  （只监听 127.0.0.1，仅本机可访问；Ctrl+C 结束）")
    if open_browser:
        threading.Thread(target=lambda: (time.sleep(0.4), webbrowser.open(url)), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("已停止。")
    finally:
        httpd.server_close()
    return 0
