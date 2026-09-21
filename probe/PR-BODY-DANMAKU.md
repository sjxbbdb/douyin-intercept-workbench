# feat(probe): 直播间「关键词命中 → 原生回复弹幕 → 滚动监测 → 私信」全链路（真机截图取证）

> 基线 `rewrite/v4-agent`；本文档按仓库 `AGENTS.md` 的要求给出：**真机证据、能力矩阵、失败状态、
> 脱敏测试、未验证边界、发行开关条件**。所有截图均来自真实运行，且**截图前已在页面内就地脱敏**
> （昵称只留首字、正文全部替换为全角星号），不含 sec_uid / 昵称原文 / 会话原文 / Cookie / token。

---

## 一、环境与截图

### 1.1 当前环境（程序从运行产物生成，非示意图）

![证据看板 1：环境 + 原子链路](probe/docs/evidence-2026-09-21/05-evidence-board-1.png)

* 浏览器 **Chrome/153.0.8010.50**（`Browser.getVersion` 自报），CDP 协议 **1.3**，`127.0.0.1:9222`
* Windows + Python 3.13 **纯标准库** sidecar；专用调试 profile，抖音账号由商家**手动扫码登录**
* 采集与操作全部走**可见页面**（页面内存 + DOM/交互），不读 Cookie、不逆向接口、不抓包重放

### 1.2 真实直播间截图（已脱敏）

| 截图 | 说明 |
|---|---|
| ![直播间整体](probe/docs/evidence-2026-09-21/01-live-room-overview.png) | 直播间整体：右侧公屏弹幕列表 + 底部输入框（**可见行**才可点，见 3.3） |
| ![原生回复菜单](probe/docs/evidence-2026-09-21/02-native-reply-menu.png) | 点击弹幕正文后弹出的原生菜单（「资料卡」/「回复 TA」）——**这就是用户要求的原生回复路径** |
| ![私信会话](probe/docs/evidence-2026-09-21/04-dm-conversations.png) | 平台自己的私信会话入口（会话列表已脱敏），私信通道就落在这里 |

---

## 二、原子链路：每一步怎么实现的

| 步骤 | 实现位置 | 关键约束（全部 fail-closed） |
|---|---|---|
| ① 监听弹幕 | `live.collect_feed`（页面内存，React fiber 的 `originalList`）/ 兜底 `live.collect_dom` | 页面内存给到 `sec_uid`；DOM 文本行**没有用户标识**，只作兜底 |
| ② 关键词匹配 | `live.match_danmaku` → 复用 `crawl.comment_matches` | 与视频评论链路**同一套匹配器**（phrase/seg/all/any + 排除词优先），语义一致 |
| ③ 去重成批 | `live_flow.LiveQueue` | 指纹去重、批次窗口、容量上限；过期事件**绝不重放** |
| ④ 话术选择 | `live_flow.freeze_plan` | 话术由平台侧下发；缺公屏或私信任一条 → `blocked`，本模块**不代写、不改写** |
| ⑤ 公屏回复 | `send_actions.send_danmaku_reply_native` | 点弹幕正文 → 菜单「回复 TA」→ 平台插入真实 @提及 → **校验提及对象就是该作者** → 真实按键输入 → 校验输入 → 回车 |
| ⑥ 才进私信 | `live_flow` 策略 | 默认只放行 `sent_confirmed`；`unknown` / `sent_echoed` **不自动升级**（红线 3） |
| ⑦ 私信话术 | `plan.privateText` | 同样由平台侧下发，发送前比对哈希 |
| ⑧ 私信 | `send_actions.send_private` | 主页 →「私信」入口（3 轮重取坐标）→ 会话头部标题校验收件人 → 真实按键输入 → 回车 |
| ⑨ 检查点 | `live_flow` 批次状态 + `send_gate` 台账 | 每个动作一个**幂等键**；不确定结果永不自重试 |

### 2.1 公屏回复为什么必须走原生「回复 TA」

* 早期结论（"网页端没有回复入口"）是**扫描方式错了**：入口不在 hover 上，而是**点击弹幕正文**才弹出的浮层菜单
  （portal 到 body 的 `ul.semi-dropdown-menu`，菜单项「资料卡」/「回复 TA」）。
* 点「回复 TA」后，**提及由平台插入**（输入框出现带 `data-rect-container` 的 mention 实体）——
  因此**脱敏昵称（小\*\*\*）也能 @ 到人**，这是原生通道相对"手写 @昵称"的实际优势。
* 发送前必须逐项校验：目标弹幕此刻仍在屏上、唯一命中、未被遮挡、提及对象一致、输入框内容一致。

### 2.2 点击护栏（`probe/click_guard.py`，本 PR 新增）

所有会改变页面状态的点击都必须过三道闸，**任何一道不过就不点**：

1. **命中测试**：`elementFromPoint(x,y)` 必须落在预期元素内（或其祖先上）；
2. **容器限制**：给了矩形时落点必须在矩形内（把点击锁死在"主聊天列表"里，不许跑到顶部弹幕条/地址栏）；
3. **文案指纹**：落点所在元素的文本必须包含该条弹幕的前 6 个字（避开平台对长弹幕的截断）；
4. **审计**：每次尝试（含被拒绝的）写一行 JSONL —— 事后能准确回答"刚才点了什么"。

---

## 三、本轮真机解决的问题（含方法）

![证据看板 2：点击审计 + 发送台账](probe/docs/evidence-2026-09-21/05-evidence-board-2.png)

| # | 现象 | 真机根因 | 解决方法 |
|---|---|---|---|
| 1 | `target.roomId path is required` / `URLPolicyError` | 直播广场点进来的地址是 `live.douyin.com/?…&live_web_rid=<房间号>`，**房间号在查询串里**，路径为空 | `live.room_id_from_url` 同时解析路径与查询串；`_canonical_room` 按房间号归一；`_resolved_room_url` 重建规范地址 |
| 2 | 回复"点在菜单上"却打不开 | Semi 浮层**隐藏时位于 `(-9947,-9941)`**，但 `getBoundingClientRect` 仍有尺寸 → 隐藏菜单被误判成已打开 | 菜单/菜单项判定改为：**必须落在视口内且中心点命中自己** |
| 3 | 弹幕成片定位不到 | **虚拟列表**：页面内存 79~200 条，DOM 只渲染 11~17 行；上滚找旧弹幕还会把最新弹幕顶到可视区下方 | 新增 `live.visible_chat_rows`：只返回"行中心在列表矩形内"的**可见行**，候选从可见行里取 |
| 4 | 长弹幕永远定位不到 | 平台把长弹幕在列表里**截断渲染**（内存"主播优秀优秀优秀优秀" vs DOM"主播优秀优秀优秀"） | 归一化去掉尾部省略号；匹配改为"完全相同 或 一方是另一方的前缀（较短一方 ≥ 6 字）" |
| 5 | 回复失败后整屏点不动 | 上一次失败在输入框里**残留 @提及** → 下一次点「回复 TA」触发平台确认框「单次只支持艾特一个人…」，它是**全屏遮罩** | ① 每次回复前 `live.clear_composer` 清空残留（Ctrl+A + Delete，受守卫点击）；② 插入提及后**边等边看**：先点平台的"确定"再读输入框 |
| 6 | 私信被判成"登录未知" | 观众身份不一定可见：有的房间观众行 `sec_uid` 为空、`uid` 是占位值 `111111` → 拼出的主页是**错误页**（`data-e2e="error-page"`），错误页上没有账号元素 | 先判错误页并如实返回 `profile_not_found`；`live.collect_events` 每行带 `dmCapable`，身份不可见**不私信** |
| 7 | 对方不可私信时记成失败 | 私密账号 / 未互关 / 关闭陌生人私信：入口点得动、面板始终不开 | 统一按**跳过**处理：`blocked` + `dm_not_available` / `dm_panel_unavailable` / `profile_not_found`，带 `evidence.skipped=true`，**换下一个目标**；`live_private` 响应单列 `skipped` |
| 8 | "私信 2 条"其实只发了 1 条 | 两个目标共用了同一个 `sendId`，台账把第二次当**重复请求**直接返回第一次结果 | 调用方必须为每个目标派生独立 `sendId`（幂等门禁正确，是报表失真） |

---

## 四、发送的证据分级（不把页面表象当成功）

| 证据 | 含义 | 是否自动进入下一阶段 |
|---|---|---|
| 平台 HTTP 响应 | 评论区有 `comment/publish`；**私信与弹幕无 HTTP 响应**（长连接） | —— |
| `mentionInserted` | 输入框里出现了平台插入的提及实体 | 否 |
| `roomEcho` | 房间消息流里出现了这条（公屏） | 记 `sent_echoed`，默认策略**不放行**私信 |
| `conversationEcho` | 会话里出现了这条（私信） | 记 `sent_echoed` |
| 平台确认 | 只有平台给出确认才记 `sent_confirmed` | 是（默认策略唯一放行项） |

因此真机上所有发送结果都保留 `status=unknown`（`platform_response_unavailable`），
并把 `roomEcho` / `conversationEcho` 作为可复查证据记录 —— **不谎报成功**。

---

## 五、真机验证结果

| 环节 | 结果 |
|---|---|
| 关键词命中（屏上可见弹幕） | ✅ 自动派生关键词命中 2~9 行/轮 |
| 原生「回复 TA」公屏回复 | ✅ 多轮成功：`mentionInserted=true` + `roomEcho=true` |
| 私信 | ✅ 成功：`conversationEcho=true`、`composerCleared=true`、收件人 `live_panel_header` 校验通过 |
| 私信跳过 | ✅ 对方不可私信时按跳过处理并**换下一个目标**（不发送、不重试） |
| 点击审计 | ✅ 每次尝试一行；被拒绝的落点含输入框（`ace-line`）、未读分隔条、平台遮罩（`semi-modal-wrap`） |

![证据看板 3：离线回归 + 问题清单](probe/docs/evidence-2026-09-21/05-evidence-board-3.png)

---

## 六、测试

```
python tests/test_probe.py         # 正常环境（需能写系统临时目录）
python tests/run_tests_sandbox.py  # 受限沙箱：临时目录放到工作区且不做清理
```

* 离线用例 **115 个**：`RoomUrlTests` / `RoomEchoTests` / `ReplyViaTests` /
  `SidecarReplyViaDispatchTests` / `IdentityVisibilityTests` / `PrivateSkipTests` /
  `ClickGuardTests` / `ChatScrollTests` 等，**0 失败**
* 两类用例依赖环境能力，受限沙箱下按环境跳过：`ChromiumFixtureTests`（需能派生 headless Chrome）、
  多进程幂等用例（需能创建命名管道）
* 真机动作（点击/输入/发送）**不进自动回归**：需要真实账号授权，且结果一律保留 `unknown`

---

## 七、未验证边界与发行开关

* ❌ 发送频率阈值未实测（已知连续约 10 条后平台**静默丢弃**：输入框清空、房间消息流无该条）
* ❌ 私信送达后的**对方可见性**（提醒、折叠、限流）未验证
* ❌ 房间若不给观众身份（占位 `uid`），网页端**没有可用的私信路径** —— 这是平台限制，不是实现缺陷
* ❌ `roomEcho` / `conversationEcho` 仍是页面观测证据，不是平台响应

**发行开关**：以上未验证项逐条有可复查证据之前，`live_batch` / `live_danmaku_reply` /
`live_private_reply` 继续保持 `autoEligible: false`。
