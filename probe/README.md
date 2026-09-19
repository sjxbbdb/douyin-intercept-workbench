# probe —— 抖音自动私信 / 可行性探针（Python）

零第三方依赖（自带最小 WebSocket，只用标准库）。

## 这套东西是什么

两条用途：

1. **可行性探针** —— 回答"企业号在网页端到底能不能私信陌生人"。这是整个方案的生死线，
   没有任何文档能替代真机验证。
2. **自动私信执行器** —— 验证通过后，直接用它按队列批量私信，遵守官方额度。

## 安全默认值（重要）

| 行为 | 默认 |
|---|---|
| 发送私信 | **关闭**。必须显式 `--allow-send` 且在真实发送前二次确认 |
| 未加 --allow-send 时 | 只做「打开主页 → 探测入口 → 预填话术」，**绝不点击发送** |
| 验证码 | 检测到即**熔断退出**，等人工。不做任何识别或绕过 |
| 登录失效 | 立即停止 |
| 空响应 | 判为风控拒绝，停止当日发送 |
| send_id | **发送前**生成并 fsync 落盘（红线 2 的幂等键） |

## 明确不做的事

- ❌ 验证码自动识别 / 滑块轨迹模拟
- ❌ 浏览器指纹混淆 / 反检测
- ❌ 伪造 a-bogus / msToken 签名直调内部接口
- ❌ 多账号轮换规避风控

理由见 `../03-自动私信实现路线.md` §三。一句话：**自动化"操作平台允许的功能"可以谈；
绕过"平台的技术保护措施"不碰。**

## 传输层已验证

手写的 WebSocket + CDP 客户端已在 **真实 Chrome 153.0.8010.50** 上跑通自检：

```
tabs: 5            browser: Chrome/153.0.8010.50
evaluate 1+1        -> 2
eval_json object    -> {'a': 1, 'b': [2, 3]}
eval_json missing   -> None
large payload len   -> 200000     (64 位帧长 + 分片重组)
navigate            -> True
SELFTEST OK
```

随时可复跑：

```bash
python probe.py launch-chrome        # 或手动起一个带 --remote-debugging-port 的 Chrome
python selftest.py 9222
```

> 注意：Chrome 的 Mojo IPC 需要命名管道，**在受限沙箱里无法启动**（报 `OpenProcess: 拒绝访问 (0x5)`）。
> 请在你自己的终端里跑本目录的脚本——它本来也需要你登录的抖音账号。

## 快速开始

```bash
# 1) 自检
python probe.py doctor

# 2) 用【专用配置目录】启动 Chrome（与日常浏览器隔离）
python probe.py launch-chrome
#    → 在弹出的窗口里【手动登录】测试号

# 3) 再自检，确认 CDP 连通、登录态有效、额度正常
python probe.py doctor
```

## 探针流程

### V1 · 采集别人视频的评论（只读，零风险）

```bash
python probe.py v1 --url "https://www.douyin.com/video/<aweme_id>" --limit 20
```

验收：≥10 条评论，且 `sec_uid` 字段完整（后续私信要用）。结果写入 `state/v1_comments.json`。

### V3 · 直播间弹幕截流（只读）

```bash
python probe.py live --url "https://live.douyin.com/<房间号>" \
                     --keywords "多少钱,怎么买,求带" --seconds 120
```

只读采集弹幕 -> 关键词筛 -> 意向打分 -> `state/live_queue.json`（与 `crawl` 产出的队列**同构**，
直接喂给 `dm`）。**不发弹幕、不点赞、不私信**；发送仍走 `dm` 的额度闸与二次确认。

> 🟢 **2026-09-19 晚更新：本入口已全自动闭环。**
> 弹幕数据不从 DOM 文本取，而是取**页面内存里的弹幕数据模型**
> （弹幕虚拟列表的 React fiber props 里的 `originalList`，每条 `WebcastChatMessage.payload.user` 里有 `sec_uid`）。
> 实测**标识完整率 100%**，队列直接能发私信。DOM 文本采集保留为兜底。
> 背景与边界见 `../06-直播间截流私信.md` §十二。

判读：

| 结果 | 含义 | 决策 |
|---|---|---|
| `候选节点 0 个` | 7 个模糊选择器全部失效（平台改版） | F12 找真实类名回填 `dyselectors.py` |
| 有弹幕但**标识完整率 0%** | **这就是真机实测结果**（两个房间都是 0%） | 这是死路：弹幕里没有 `sec_uid`，私信发不出去（见 `../06-直播间截流私信.md` §七） |
| 弹幕 0 条但窗口里明明有 | 优先怀疑**选择器**，别信「没人说话」 | 本项目最怕的静默错误 |

离线回归（不需要浏览器、不需要账号）：

```bash
python live_selftest.py     # Python 逻辑 + node DOM shim 跑真实采集 JS
```
### V4 · 私信入口探测（🔴 整个项目的生死线）

```bash
# 只读探测：有没有「私信」按钮、是不是被拦
python probe.py v4 --sec-uid <别人的sec_uid>

# 真发一条（消耗额度与账号风险，务必先用小号）
python probe.py v4 --sec-uid <id> --send --text "你好"
```

判读：

| 结果 | 含义 | 决策 |
|---|---|---|
| `found: true` | ✅ 网页端能私信该用户 | 路线 1 成立，继续 |
| `blocked: true` (stranger_dm_disabled) | ❌ 被平台拦 | 若非企业号，**换企业号重测**；企业号也被拦则路线 1 不成立 |
| `dm_button_not_found` | 选择器失效或页面结构变了 | 回填 `selectors.py` 后重试 |

真发模式下会打印**实际命中的 POST 接口**，用它回填 `selectors.py` 的 `DM_SEND_URL_MARK`。

### 完整链路：搜视频 -> 抓评论 -> 筛人 -> 私信

移植自 `D:/deep seek/pipeline.js`（已跑通的实现）。关键点：
**评论不从 DOM 抓，而是抓平台接口响应体**（`Network.getResponseBody` -> `j.comments[]`），
里面**直接带 `user.sec_uid`** —— 这正是私信环节最需要的字段，在评论路径上是白送的。

```bash
# 0) 只搜视频（只读，不打开视频、不抓评论）-> state/search_videos.json
python probe.py search --keyword "宝宝辅食" --max-videos 60 --scroll 6

# 1) 搜视频 + 抓评论 + 按评论关键词筛评论 -> state/dm_queue.json
python probe.py crawl --keyword "宝宝辅食" --comment-keywords "怎么做,教程" \
                      --match-mode seg --videos 3

# 2) 用队列私信（默认只预填）
python probe.py dm --queue state/dm_queue.json --text "您好{nick}，看到您评论..." --allow-send
```

> 🔴 采集也会触发风控：实测连续十几轮滚轮之后抖音弹出了真验证码。
> 跑慢一点用 `--scroll-pause 4`；撞到验证码会立即停止并保留已抓数据，需人工处理后重跑。
> 细节与证据链见 `../05-关键词搜索与评论筛选.md`。

关键词语义（与 pipeline.js 一致，已离线单测）：
- **视频匹配**：先整串连续命中，否则退化为「分词 AND 命中」（顺序无关）
  —— 因为抖音标题几乎不会连续包含「怎么充值codex」，整串匹配会把结果清成 0
- **评论匹配**：任意字命中（召回优先）。`"求带"` -> `['求','带']`，命中「能带带我吗」

### 人工点击工作台（程序出清单 + 记账，人负责点发送）

分工：**你**点用户 → 进主页 → 点【私信】→ 粘贴话术 → 点发送；**程序**抓评论、筛人、备话术、
给主页直达链接、记账、去重、卡额度。**程序不导航、不点击、不发送。**

```bash
python probe.py manual --queue state/dm_queue.json --open    # 浏览器打开 http://127.0.0.1:8899/
```

页面上每一行有：昵称 / 评论原文 / 建议话术（一键复制）/【打开主页】【已发送】【被拦/无入口】【跳过】；
页首有操作步骤与已知的坑；每次点击立刻写进 `state/send_ledger.jsonl`（**与自动发送共用同一本台账**，
所以同一个人不会被两条路各打扰一次）。

```bash
python manual_selftest.py     # 离线回归：渲染/记账/额度/去重/重启恢复（用测试台账，不碰真实台账）
```

细节与人工程序流程见 `../07-人工点击工作台.md`。
## 批量私信

```bash
# 队列格式：[{"sec_uid": "...", "nick": "..."}, ...]
python probe.py dm --queue queue.json --text "您好{nick}，看到您在评论区提问..."          # 只预填
python probe.py dm --queue queue.json --text "..." --allow-send                        # 真发
```

## 额度（官方口径，`dm.py: LIMITS`）

| 项 | 值 |
|---|---|
| 同一用户 | ≤ 3 条 |
| 每小时 | ≤ 40 人 |
| 每日 | ≤ 100 人 |
| 活跃时段 | 08:00–23:00 |
| 间隔 | 对数正态随机化 |

⚠️ 这些数值**只应有一处定义**。上生产时要改成服务端下发（红线 1）。

## 拟人化（2026-09-19 用户要求）

| 项 | 值 | 位置 |
|---|---|---|
| 打字：每个字的间隔 | **0.1 ~ 0.9 秒随机** | `cdp.py: type_text(lo, hi)`，数值来自 `dm.LIMITS["typing_delay_range"]` |
| 鼠标：分 3 步移动 + ±8px 抖动，落点偏离中心 ±3px | 拟人但不点坏按钮 | `cdp.py: click_at / move_mouse` |
| 点输入框后 / 打完字后停顿 | 0.4~0.9s / 0.5~1.4s | `dm.py` |

代价：**30 字的话术要打 3~27 秒（平均 ~15 秒）** —— 这是刻意的，
因为"整段文字瞬间出现"是这个通道上最明显的机器特征。详见 `../03-自动私信实现路线.md` §六。

## 文件

| 文件 | 作用 |
|---|---|
| `dsh_ws.py` | 最小 RFC6455 WebSocket 客户端（标准库） |
| `cdp.py` | CDP 客户端 + Network 响应体录制（红线 2 的基础） |
| `dyselectors.py` | 选择器唯一来源，带"离线/真机"双验证日期（**不叫 selectors.py**：会顶掉标准库同名模块，见文件头） |
| `douyin.py` | 页面操作原语（可见容器筛选、私信入口、编辑器） |
| `crawl.py` | 关键词搜视频（接口优先）-> 抓评论（接口优先）-> 按关键词筛评论（4 档）-> 出私信队列 |
| `live.py` | 直播间弹幕采集（只读）-> 关键词筛 -> 意向打分 -> 私信队列 |
| `dm.py` | 私信执行器（额度 / 台账 / 熔断 / 间隔） |
| `manual.py` | 人工点击工作台：本机网页清单 + 话术 + 记账（不驱动浏览器） |
| `probe.py` | 命令行入口 |
| `selftest.py` | 传输层自检（WebSocket / CDP / 大包 / 导航） |
| `live_selftest.py` | 直播间模块的离线回归（Python 逻辑 + node DOM shim 跑**真实采集 JS**） |
| `manual_selftest.py` | 人工点击工作台的离线回归（渲染 / 记账 / 额度 / 去重 / 重启恢复） |
| `state/` | 台账与结果（jsonl 追加写 + fsync） |

## 已沉淀的抖音 DOM 知识（来自 legacy 真机试错）

- 页面同时存在**隐藏与可见两套** `comment-list`，必须取 `rect` 非零的那个，否则按钮尺寸全是 0
- `scrollIntoView` 之后虚拟列表会重渲染，必须**延迟**再读按钮坐标，同步读会拿到 0×0
- 点击必须用 `Input.dispatchMouseEvent` 发真实鼠标事件；`element.click()` 常不生效
- 填文本用 `Input.insertText`
- 图文帖（note）网页版评论区是右侧小浮层，深评论会被回收 → 判为不支持并跳过
- 陌生人私信被拦的页面文案：`仅关注的人可私信|只允许关注的人私信|暂不支持私信|无法私信|不能私信`
- 直播间的 7 个模糊选择器会**同时命中容器与行**；容器会被解析成一条假弹幕（昵称=第一行、正文=其后所有行拼接）。本项目用「**已解析**节点里取最深层」过滤，且不能简单取最深处（内层只有一行的 span 会把外层行挤掉）
- 🔴 真机实测（2026-09-19，两个直播间）：弹幕行**没有任何用户标识**（无 `data-sec-uid` / `data-user-id` / `a[href]`），头像位是等级徽章图；右侧"在线观众/贡献用户"面板同样只有昵称。**拿不到 `sec_uid` 就发不了私信**
- 弹幕行的文本是**单行** `昵称：正文`（不是昵称换行正文），靠 `LIVE_NICK_FALLBACK_RE` 拆分；福袋接龙、`xx：送出了 X × 1`、`xx 来了` 都要当噪音过滤
- 窗口被遮挡时 `visibilityState=hidden`，直播间的弹幕虚拟列表**一条都不渲染**（WebSocket 还在收帧，DOM 始终为空）→ `douyin.force_page_active` 用 `Page.setWebLifecycleState(active)` + `Emulation.setFocusEmulationEnabled` 把它拉回来

## 接线到 Node 版交接包

如果最终生产栈仍用交接包的 Node（`client/core/cdp.js` 等），
本目录的 JS 表达式与额度模型可以**逐条对照移植**——先在这里把真机结论跑出来，
再决定生产栈用哪个，比反过来便宜得多。
