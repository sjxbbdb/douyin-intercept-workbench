"""直播间截流模块的【离线回归】——不需要浏览器、不需要抖音账号。

为什么要它
----------
真机验证要消耗账号风险，而且这台机器上 Chrome 起不来（Mojo 命名管道被沙箱拒绝）。
但 JS 采集表达式一旦写错，症状是"抓不到弹幕"——和"直播间没人说话"长得一模一样，
属于本项目反复吃亏的**静默错误**。所以：

  · JS 部分：用 node 起一个**极简 DOM shim**，把 live._DANMAKU_JS 这句**实际要执行的表达式**
    原样拿来跑，用构造的直播间 DOM 断言解析结果（含容器回声、脱敏 *****、三级 sec_uid 回退）。
  · Python 部分：房间链接解析 / 打分 / 队列组装 / not_locatable 处置。

这不是"真机可用"的证据，只是"代码没写错"的证据。真机状态仍以 selectors.py 的
live_verified_at=None 为准。

用法：
    python live_selftest.py            # 自动找 node；找不到就跳过 JS 部分并明确说明
    python live_selftest.py --node "C:\\path\\to\\node.exe"
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import live          # noqa: E402
import dyselectors as S  # noqa: E402

NODE_CANDIDATES = [
    r"C:\Program Files\nodejs\node.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs\node.exe"),
]
NODE_SEARCH_ROOTS = [
    os.path.expandvars(r"%USERPROFILE%\.workbuddy\binaries\node\versions"),
    os.path.expandvars(r"%LOCALAPPDATA%\OpenAI\Codex\runtimes"),
    os.path.expandvars(r"%USERPROFILE%\.cache\codex-runtimes"),
]


def find_node(explicit=None):
    if explicit:
        return explicit if os.path.exists(explicit) else None
    for c in NODE_CANDIDATES:
        if os.path.exists(c):
            return c
    for root in NODE_SEARCH_ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            if "node.exe" in files:
                return os.path.join(dirpath, "node.exe")
    return None


# ===================== 一、Python 纯逻辑 =====================

def test_python():
    bad = []

    def eq(got, want, what):
        if got != want:
            bad.append("%s: 得到 %r，期望 %r" % (what, got, want))

    eq(live.normalize_room("https://live.douyin.com/123456789")["web_rid"], "123456789", "URL 解析 web_rid")
    eq(live.normalize_room("123456789")["url"], "https://live.douyin.com/123456789", "纯房间号")
    eq(live.normalize_room("https://www.douyin.com/follow?web_rid=987654")["web_rid"], "987654", "query 里的 web_rid")
    eq(live.normalize_room("https://v.douyin.com/abcdEF/")["from"], "short_link", "短链标记")
    try:
        live.normalize_room("https://www.douyin.com/user/MS4wLjABAAAAxyz")
        bad.append("非直播间链接应当报错，但没报错")
    except ValueError:
        pass

    eq(live.is_plausible_sec_uid("MS4wLjABAAAA_abc-123"), True, "正常 sec_uid")
    eq(live.is_plausible_sec_uid("*****"), False, "脱敏 ***** 不算标识")
    eq(live.is_plausible_sec_uid("1234567890"), False, "纯数字 uid 不算 sec_uid")
    eq(live.is_plausible_sec_uid(""), False, "空值")

    score, level, reasons = live.score_lead("这个多少钱？")
    eq(level, "中意向", "问价+疑问句 = 中意向(35)")
    if not reasons:
        bad.append("打分必须给出可解释的 reasons")
    eq(live.score_lead("怎么买，有优惠吗，微信多少")[1], "高意向", "购买+优惠+联系 = 高意向")
    eq(live.score_lead("主播唱歌真好听")[1], "低意向", "闲聊 = 低意向")
    eq(live.score_lead("多少钱", repeat=3)[0] - live.score_lead("多少钱")[0], 10, "重复发言加分")

    rows = [
        {"user": "张三", "text": "这个多少钱", "sec_uid": "MS4wLjABAAAA_zhang"},
        {"user": "李四", "text": "怎么买", "sec_uid": ""},          # 拿不到标识
        {"user": "王五", "text": "求带教程", "sec_uid": "*****"},     # 脱敏
        {"user": "张三", "text": "有优惠吗", "sec_uid": "MS4wLjABAAAA_zhang"},  # 同一个人再说一句
        {"user": "赵六", "text": "主播好", "sec_uid": "MS4wLjABAAAA_zhao"},
    ]
    queue, scored, stats = live.build_queue(rows, room={"web_rid": "123", "room_title": "测试直播间"},
                                            keywords="多少钱,怎么买,求带,优惠", mode="phrase")
    eq(len(queue), 1, "同一人只进队列一次（张三）")
    eq(queue[0]["sec_uid"], "MS4wLjABAAAA_zhang", "队列里的标识")
    eq(queue[0]["source"], "live_danmaku", "来源标记")
    # 李四没有标识、王五是脱敏 ***** —— 两个人都算 not_locatable，都不许进队列
    eq(stats["skip"]["not_locatable"], 2, "拿不到标识的记 not_locatable")
    eq(stats["skip"]["duplicate_user"], 1, "同一个人第二条记 duplicate")
    if stats["queue"] != 1:
        bad.append("stats.queue 应为 1")
    # 关键词不命中的人不该进队列（赵六的"主播好"）
    if any(q["nick"] == "赵六" for q in queue):
        bad.append("没命中关键词的人进了队列")
    # 高意向门槛
    q2, _s2, st2 = live.build_queue(rows, keywords="多少钱,怎么买,求带,优惠",
                                    mode="phrase", min_level="高意向")
    if q2:
        bad.append("min_level=高意向 时应为空（张三 35 分未达标）")
    return bad


# ===================== 二、JS 采集表达式（node + DOM shim） =====================

DOM_SHIM_JS = r"""
// ---------- 极简 DOM shim：只实现 live._DANMAKU_JS 真正用到的 API ----------
// 支持的"选择器"只有本模块实际会用的三种形态：
//   tag  /  [attr]  /  [attr*="value"]  /  tag[attr]
function selMatch(el, sel) {
  var m;
  if ((m = sel.match(/^([a-zA-Z0-9]+)?\[([a-zA-Z-]+)\*="([^"]*)"\]$/))) {
    if (m[1] && el.tag !== m[1].toLowerCase()) return false;
    var v = el.getAttribute(m[2]);
    return !!v && String(v).indexOf(m[3]) >= 0;
  }
  if ((m = sel.match(/^([a-zA-Z0-9]+)?\[([a-zA-Z-]+)\]$/))) {
    if (m[1] && el.tag !== m[1].toLowerCase()) return false;
    var v2 = el.getAttribute(m[2]);
    return v2 !== null && v2 !== undefined && v2 !== "";
  }
  if (/^[a-zA-Z0-9]+$/.test(sel)) return el.tag === sel.toLowerCase();
  throw new Error("shim 不支持的选择器: " + sel);
}

class El {
  constructor(tag, cls, opts) {
    opts = opts || {};
    this.tag = tag.toLowerCase();
    this.cls = cls || "";
    this.attrs = opts.attrs || {};
    this.lines = opts.lines || [];
    this.href = opts.href || null;
    this.style = Object.assign({ display: "block", visibility: "visible", opacity: "1" }, opts.style || {});
    this.rect = Object.assign({ x: 10, y: 100, width: 260, height: 22, top: 100, bottom: 122 }, opts.rect || {});
    this.children = [];
    this._parent = null;
  }
  get parentElement() { return this._parent; }
  // 真实 DOM 的 innerText 会聚合后代文本（并跳过 display:none 的子树）。
  // shim 必须照做，否则"容器回声"这条被测路径根本不会出现。
  get innerText() {
    if (this.lines.length) return this.lines.join("\n");
    return this.children
      .filter(function (c) { return c.style.display !== "none"; })
      .map(function (c) { return c.innerText; })
      .filter(Boolean).join("\n");
  }
  get textContent() { return this.innerText; }
  getAttribute(name) {
    if (name === "class") return this.cls || null;
    if (name === "href") return this.href;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  getBoundingClientRect() { return this.rect; }
  contains(other) {
    for (var p = other; p; p = p._parent) if (p === this) return true;
    return false;
  }
  appendChild(child) { child._parent = this; this.children.push(child); return child; }
  querySelectorAll(sel) {
    var out = [];
    (function walk(node) {
      node.children.forEach(function (c) {
        if (selMatch(c, sel)) out.push(c);
        walk(c);
      });
    })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function makeDoc(root, bodyText, title) {
  return {
    body: { innerText: bodyText },
    title: title || "",
    querySelectorAll: function (sel) {
      var out = [];
      (function walk(node) {
        node.children.forEach(function (c) {
          if (selMatch(c, sel)) out.push(c);
          walk(c);
        });
      })(root);
      return out;
    },
    querySelector: function (sel) { return this.querySelectorAll(sel)[0] || null; },
  };
}

// ---------- 构造一个"像真的"直播间弹幕 DOM ----------
var SEC_ATTR = "MS4wLjABAAAA_attrUser_0001";
var SEC_LINK = "MS4wLjABAAAA_linkUser_0002";
var SEC_ANC  = "MS4wLjABAAAA_ancestorUser_0003";

var root = new El("div", "app-root");

// 1) 容器（[class*=chatroom] 命中）——它自己也能被解析成"一行"，必须被容器回声过滤掉
var room = new El("div", "webcast-chatroom");
root.appendChild(room);

var row1 = new El("div", "webcast-chatroom__item", {
  lines: ["张三", "这个多少钱"], attrs: { "data-id": "m1", "data-sec-uid": SEC_ATTR },
});
room.appendChild(row1);

var row2 = new El("div", "webcast-chatroom__item", {
  lines: ["李四", "怎么买"], attrs: { "data-id": "m2", "data-sec-uid": "*****" },
});
room.appendChild(row2);

var noise = new El("div", "chat-message", { lines: ["系统提示", "进入直播间"] });
room.appendChild(noise);

// 2) 昵称在 a[href] 里，行元素本身没有属性 -> 走"祖先 href"回退（第 3 级）
var linkWrap = new El("a", "", { href: "/user/" + SEC_ANC });
var row3 = new El("span", "chat-message", { lines: ["王五", "求带教程"] });
linkWrap.appendChild(row3);
root.appendChild(linkWrap);

// 3) 行元素含 a[href] 后代 -> 走"后代链接"回退（第 2 级）；
//    且内部还有一个只有 1 行的 span —— 它不能被当成"更深的行"把外层挤掉
var row4 = new El("div", "bullet-outer", { lines: ["钱七", "有优惠吗"] });
var innerLink = new El("a", "", { href: "/user/" + SEC_LINK });
row4.appendChild(innerLink);
row4.appendChild(new El("span", "bullet-inner", { lines: ["有优惠吗"] }));
root.appendChild(row4);

// 4) 单行 "昵称: 正文" 退化路径；没有 sec_uid -> not_locatable
var row5 = new El("div", "danmu-item", { lines: ["赵六: 价格多少"] });
root.appendChild(row5);

// 5) 隐藏行（display:none）—— 不能出现在结果里
var hidden = new El("div", "danmu-hidden", { lines: ["孙七", "看不见我"], style: { display: "none" } });
root.appendChild(hidden);

// 6) 昵称位置噪音（"直播间..."开头）
var noisy2 = new El("div", "danmu-item", { lines: ["直播间断线重连", "请稍后"] });
root.appendChild(noisy2);

// 7) 【真机暴露的形态】送礼容器：子里每一条都是送礼事件（噪音），
//    容器自己的文本却是多行拼接 —— 修好之前它会被当成"一条弹幕"混进结果。
var giftList = new El("div", "gift-message-list");
giftList.appendChild(new El("div", "gift-message", { lines: ["꧁大洋꧂：送出了 粉丝团灯牌 × 1"] }));
giftList.appendChild(new El("div", "gift-message", { lines: ["寒川·明岳：送出了 为你闪耀 × 1"] }));
root.appendChild(giftList);

// 8) 【真机暴露的形态】粉丝团前缀独占一行，事件正文在下一行的"昵称："之后
var fanRow = new El("div", "danmu-fan", { lines: ["猪叫团", "半夏&：送出了 星光闪耀 × 1"] });
root.appendChild(fanRow);

// 9) 【真机暴露的形态】进场提示：第一行"xx 来了"，第二行是零宽空格（\u200b）
//    —— JS 的 \s 不匹配零宽空格，不显式剥掉就会把空弹幕当成有内容
var toast = new El("div", "danmu-toast", { lines: ["可可 来了", "\u200b"] });
root.appendChild(toast);

__PRELUDE__
var OUT = __DANMAKU_JS__;
console.log(JSON.stringify({
  rows: OUT.rows, room: OUT.room, diagnostics: OUT.diagnostics,
  title: (typeof document !== "undefined" && document.title) || "",
}));
"""


def build_js_harness():
    """把真实要执行的采集表达式套进 shim 里。

    ⚠️ 顺序有讲究：全局环境（document / window / location / getComputedStyle）
       必须在采集表达式【执行之前】注入。写在后面会被 var 提升成 undefined，
       报"读不到 undefined 的属性"—— 那是测试脚手架自己的 bug，不是采集逻辑的问题。
    """
    body = "在线人数: 1.2万 进入直播间 抖音直播 - 抖音直播"
    prelude = (
        "var document = makeDoc(root, %s, '测试直播间 - 抖音直播');\n"
        "var window = { innerHeight: 900 };\n"
        "var location = { href: 'https://live.douyin.com/123456789', origin: 'https://www.douyin.com' };\n"
        "function getComputedStyle(el) { return el.style; }"
    ) % json.dumps(body)
    return (DOM_SHIM_JS
            .replace("__PRELUDE__", prelude)
            .replace("__DANMAKU_JS__", live._DANMAKU_JS))


def test_js(node, keep_temp=False):
    bad = []
    harness = build_js_harness()
    fd, path = tempfile.mkstemp(suffix=".js", prefix="live_selftest_")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(harness)
    try:
        proc = subprocess.run([node, path], capture_output=True, text=True, encoding="utf-8", timeout=60)
        if proc.returncode != 0:
            return ["node 执行失败（JS 表达式有语法/运行错误）：\n%s" % (proc.stderr or "")[:1500]]
        out = json.loads(proc.stdout.strip().splitlines()[-1])
    finally:
        if not keep_temp:
            try:
                os.remove(path)
            except OSError:
                pass

    rows = out["rows"]
    got = {r["user"]: r for r in rows}

    if set(got) != {"张三", "李四", "王五", "钱七", "赵六"}:
        bad.append("解析出的用户集合不对：%s（期望 张三/李四/王五/钱七/赵六）" % sorted(got))
    if "孙七" in got:
        bad.append("display:none 的隐藏行不该被采集")
    if "直播间断线重连" in got or "系统提示" in got:
        bad.append("噪音行不该被采集")

    if got.get("张三", {}).get("sec_uid") != "MS4wLjABAAAA_attrUser_0001":
        bad.append("第 1 级（行属性 data-sec-uid）没生效：%r" % got.get("张三", {}).get("sec_uid"))
    if got.get("钱七", {}).get("sec_uid") != "MS4wLjABAAAA_linkUser_0002":
        bad.append("第 2 级（后代 a[href]）没生效：%r" % got.get("钱七", {}).get("sec_uid"))
    if got.get("王五", {}).get("sec_uid") != "MS4wLjABAAAA_ancestorUser_0003":
        bad.append("第 3 级（祖先 href）没生效：%r" % got.get("王五", {}).get("sec_uid"))
    if got.get("李四", {}).get("sec_uid") != "":
        bad.append("脱敏 ***** 必须被当成取不到标识：%r" % got.get("李四", {}).get("sec_uid"))
    if got.get("赵六", {}).get("text") != "价格多少":
        bad.append("单行 昵称: 正文 的退化解析不对：%r" % got.get("赵六", {}))
    if got.get("钱七", {}).get("text") != "有优惠吗":
        bad.append("容器回声过滤把带 1 行子节点的行也误杀了：%r" % got.get("钱七"))

    # 真机暴露的三种形态：送礼容器 / 粉丝团前缀行 / 零宽空行
    if any("送出了" in (r.get("text") or "") or "送出了" in (r.get("user") or "") for r in rows):
        bad.append("送礼事件（送出了…）漏进了结果：%r"
                   % [r.get("user") for r in rows if "送出了" in (r.get("text") or "") + (r.get("user") or "")])
    if "可可 来了" in got or "猪叫团" in got:
        bad.append("进场提示/粉丝团前缀行漏进了结果：%s" % sorted(got))

    diag = out["diagnostics"]
    if diag.get("drop_ancestor", 0) < 1:
        bad.append("没有过滤掉容器回声（drop_ancestor=%s）" % diag.get("drop_ancestor"))
    # 系统提示(进入直播间) + 直播间断线重连 + 两条送礼 + 粉丝团送礼行
    if diag.get("drop_noise", 0) < 4:
        bad.append("噪音行没有被充分统计（drop_noise=%s，期望 >=4）" % diag.get("drop_noise"))
    if diag.get("drop_one_line", 0) < 1:
        bad.append("单行内部节点没有被统计（drop_one_line=%s）" % diag.get("drop_one_line"))

    room = out["room"]
    if room.get("status") != "运行中":
        bad.append("房间状态判定不对：%r" % room.get("status"))
    if room.get("online_text") != "1.2万":
        bad.append("在线人数解析不对：%r" % room.get("online_text"))
    if room.get("room_title") != "测试直播间":
        bad.append("房间标题没有剥掉 '- 抖音直播' 后缀：%r" % room.get("room_title"))
    if room.get("url") != "https://live.douyin.com/123456789":
        bad.append("房间 URL 不对：%r" % room.get("url"))

    # 队列口径：拿不到标识的人不进队列
    queue, _scored, stats = live.build_queue(rows, room=room, keywords="多少钱,怎么买,求带,优惠",
                                             mode="phrase")
    nicks = {q["nick"] for q in queue}
    if "李四" in nicks or "赵六" in nicks:
        bad.append("not_locatable 的人进了队列：%s" % sorted(nicks))
    # 命中的 4 条里，只有「李四」拿不到标识（脱敏 *****）；赵六那条"价格多少"没命中关键词
    if stats["skip"]["not_locatable"] != 1:
        bad.append("not_locatable 计数应为 1，实际 %s" % stats["skip"]["not_locatable"])
    if "钱七" not in nicks:
        bad.append("有标识且有优惠意图的人没进队列：%s" % sorted(nicks))
    return bad


# ===================== 三、采集循环（假页面，不需要浏览器） =====================
#
# 采集循环里有几件事只有跑起来才看得出来：跨轮去重、房间号落到每一行、
# 以及【未登录必须熔断】。用假页面把这条路径跑一遍，成本几乎为零。

class _FakePage:
    """只实现 live.collect() 与 douyin.check_* 真正会碰到的方法。"""

    def __init__(self, snap, cookies=("sessionid",)):
        self.snap = snap
        self.cookies = cookies
        self.rounds = 0

    def eval_json(self, expr, timeout=None):
        self.rounds += 1
        # 每一轮都返回【同一条弹幕】—— 用来验证跨轮去重
        return json.loads(json.dumps(self.snap))

    def evaluate(self, expr, timeout=None, user_gesture=False):
        return ""

    def call(self, method, params=None, timeout=None):
        # 登录态以 cookie 为准（sessionid 是 HttpOnly，JS 读不到）
        if method == "Network.getCookies":
            return {"cookies": [{"name": n} for n in self.cookies]}
        return {}


_SNAP = {
    "room": {"room_title": "测试直播间", "online_text": "1.2万", "status": "运行中",
             "url": "https://live.douyin.com/123456"},
    "rows": [
        {"user": "张三", "text": "这个多少钱", "row_key": "m1",
         "sec_uid": "MS4wLjABAAAA_zhang", "profile_url": "", "avatar_url": "", "user_id": ""},
        {"user": "李四", "text": "怎么买呀", "row_key": "m2",
         "sec_uid": "", "profile_url": "", "avatar_url": "", "user_id": ""},
    ],
    "diagnostics": {"candidates": 7, "visible": 6, "parsed": 2, "drop_ancestor": 1,
                    "drop_dup": 0, "drop_one_line": 1, "drop_shape": 0, "drop_noise": 2},
}


def test_collect_loop():
    bad = []

    def eq(got, want, what):
        if got != want:
            bad.append("%s: 得到 %r，期望 %r" % (what, got, want))

    page = _FakePage(_SNAP)
    res = live.collect(page, seconds=1.2, limit=50, every=0.3, log=lambda _m: None)
    eq(res["stopped_reason"], "time", "正常跑完的停止原因")
    eq(len(res["rows"]), 2, "跨轮重复的同一条弹幕必须去重")
    if res["rounds"] < 2:
        bad.append("只跑了 %d 轮，去重路径没被覆盖" % res["rounds"])
    eq(res["room"].get("web_rid"), "123456", "房间号要从 url 回填（队列归属要用）")
    eq(res["rows"][0].get("room_id"), "123456", "每一行都要带 room_id")

    queue, _scored, stats = live.build_queue(res["rows"], room=res["room"],
                                             keywords="多少钱,怎么买", mode="phrase")
    eq(len(queue), 1, "只有张三拿得到标识")
    if queue:
        eq(queue[0]["source"], "live_danmaku", "来源标记")
        eq(queue[0]["room_id"], "123456", "队列里的 room_id")
        eq(queue[0]["room_title"], "测试直播间", "队列里的房间标题")
        if not queue[0].get("reasons"):
            bad.append("队列条目必须带可解释的命中理由")

    # 未登录必须【熔断】，而且一条都不许采
    page2 = _FakePage(_SNAP, cookies=())
    res2 = live.collect(page2, seconds=0.5, limit=50, every=0.3, log=lambda _m: None)
    eq(res2["stopped_reason"], "login_required", "未登录时停止原因")
    eq(len(res2["rows"]), 0, "未登录时不许采到任何数据")
    return bad


def main():
    ap = argparse.ArgumentParser(description="直播间截流模块离线回归")
    ap.add_argument("--node", default=None, help="node.exe 路径（默认自动查找）")
    ap.add_argument("--keep-temp", action="store_true", help="保留生成的 JS 临时文件便于排错")
    args = ap.parse_args()

    print("=== live_selftest：Python 逻辑 ===")
    bad = test_python()
    print("  失败 %d 项" % len(bad))
    for b in bad:
        print("   [X] %s" % b)

    print()
    print("=== 采集循环（假页面：去重 / room_id / 未登录熔断） ===")
    loop_bad = test_collect_loop()
    print("  失败 %d 项" % len(loop_bad))
    for b in loop_bad:
        print("   [X] %s" % b)
    bad = bad + loop_bad

    node = find_node(args.node)
    js_bad = []
    if not node:
        print()
        print("=== JS 采集表达式（离线 DOM shim） ===")
        print("  [SKIP] 本机找不到 node.exe —— JS 部分【未验证】。")
        print("         可显式指定：python live_selftest.py --node \"<node.exe 路径>\"")
    else:
        print()
        print("=== JS 采集表达式（离线 DOM shim，node=%s） ===" % node)
        js_bad = test_js(node, keep_temp=args.keep_temp)
        print("  失败 %d 项" % len(js_bad))
        for b in js_bad:
            print("   [X] %s" % b)

    print()
    if bad or js_bad:
        print("SELFTEST FAILED")
        return 1
    print("SELFTEST OK" + ("" if node else "（JS 部分被跳过，不算通过）"))
    return 0 if node else 0


if __name__ == "__main__":
    sys.exit(main())
