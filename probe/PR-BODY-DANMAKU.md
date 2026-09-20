# PR：直播间「回复弹幕」（公屏 @观众）+ 采集真机适配

堆叠在 #7（`feat/live-batch-flow`）之上 —— 本 PR 的 base 就是 #7 的分支；#7 合并后 GitHub 会自动改基。

## 1. 这次解决什么

两件事，都是**真机取证**驱动的：

1. **采集在真机上拿不到用户标识**（也就进不了私信阶段）。原实现用的是离线 fixture 的
   `data-e2e` 占位选择器，真机命中数 0/0/0；即使换成真实 DOM 选择器，弹幕行内也**没有**任何
   用户标识属性。结果就是每条 live 事件 `authorId` 为空，第 6/8 步（私信）被
   `missing_author_id` 全部拦下。
2. **没有「回复弹幕」这个能力**。原 `live_reply` 只是在公屏发一条普通评论，不指向任何人。

## 2. 真机结论与证据（2026-09-20，Chrome 153，真实直播间，只读探针）

| 观察 | 结论 | 证据 |
|---|---|---|
| 弹幕行真实结构 | `div.webcast-chatroom___item` → `.___item-wrapper` → `[等级徽章][昵称：][正文]`，正文在 `.___content-with-emoji-text` | 只读结构 dump（`probe/live_danmaku_probe.py`） |
| 行内用户标识 | **没有** `data-sec-uid`/`data-user-id`，也没有 `a[href]` | 同上；DOM 采集作者标识 0% |
| 页面内存数据模型 | 弹幕虚拟列表组件 React fiber props 的 `originalList`，每条 `WebcastChatMessage.payload.user` 带 `sec_uid`/nickname | 采纳后实测 **42/42 带标识** |
| 「点弹幕回复」入口 | **不存在**：全页 hover 扫描「回复」类元素恒为 0；点击弹幕不进入回复态；输入框 `@` 无提及联想 | 三个只读诊断脚本的输出 |
| 输入框 | 富文本 `ace-line`（`webcast-chatroom___input-container`） | 输入 `@` 后 DOM 只有普通字符节点 |
| 发送控件 | 输入框容器内存在可点击控件（真机定位到 x=1036），无文字「发送」按钮 | `live.find_send_control` 真机返回 `mechanism: button` |

因此「回复弹幕」在本平台上的**真实落地形式**是：**公屏发一条以 `@昵称` 开头的消息**。
这不是取巧，而是当前网页端唯一能做到「让对方收到提醒」的方式（移动端的长按回复是客户端能力，
网页端对普通观众不开放）。

## 3. 改动清单

* `probe/douyin_selectors.py`：补上真机结构的选择器与噪音词表（并注明旧的 `LIVE_COMMENT_*` 只是
  fixture 占位值，不是平台事实）。
* `probe/live.py`：重写为「页面内存（首选，带 sec_uid）+ DOM 文本（兜底，无标识）」双数据源；
  新增 `find_danmaku`（唯一命中 + 未被遮挡才算找到）、`find_send_control`（按钮/回车两种机制）。
* `probe/send_actions.py`：新增 `send_danmaku_reply`（回复弹幕），幂等键
  `live-danmaku:<eventId>:<authorName>`，失败一律在**动浏览器之前**判定。
* `probe/live_flow.py`：计划冻结 `replyMode`；`danmaku` 模式在**计划期**校验昵称与 `@昵称` 前缀。
* `probe/sidecar.py`：`live_plan` 接受 `replyMode`；`live_reply` 按冻结模式分发并拒绝中途改口；
  `live_listen` 如实回报 `source` / `identityCoverage`；能力矩阵新增
  `live_danmaku_reply` / `live_capture_source`（`autoEligible` 均为 `false`）。
* `probe/cdp.py`：`type_text` 改为真人节奏（每字 0.1–0.9 秒随机，标点后略长）。
* `probe/live_danmaku_probe.py`：只读探针（只 hover、不点击、不输入、不发送），用于复核选择器。

## 4. 测试

```text
LiveFlowTests + BoundaryTests 共 42 项：OK
```

新增 8 项：`replyMode` 冻结与非法模式、无昵称 blocked、缺 `@昵称` 前缀 blocked、冻结后改口
`mode_mismatch`、弹幕不在屏上时**不输入不点击**、输入校验先于浏览器、拟人节奏落在 0.1–0.9 秒
（显式固定节拍仍可用）、采集双数据源与回落。另有一项锁死定位器"只回报原因、不给近似坐标"。

## 5. 真机验收（只读部分已做）

* 采集：`42/42` 带 `sec_uid`，数据源 `page_memory`；昵称 `42/42`。
* 定位器：连续 3 次在真实弹幕里精确命中（`onTop: true`）。
* 输入框与发送控件：均能定位。

## 6. 未验证边界（如实标注，fail-closed）

1. **没有真机执行过一次发送**：本 PR 只做了只读验收。`@昵称` 是否真的让对方收到提醒、
   发送到底该点按钮还是回车、以及发送后的平台响应证据，都还没有。
2. 弹幕行会随虚拟列表滚动位移：定位是"发送前此刻仍然在屏上"，不做滚动回溯（找不到就拒发）。
3. 昵称可能被平台脱敏（匿名/福袋场次）——此时 `danmaku` 模式会因匹配不到目标弹幕而拒发，
   而不是退化成随便 @ 一个人。
4. 仍未完成：积分 / 功能开关 / 服务端审计接线；`live_batch`、`live_danmaku_reply` 的
   `autoEligible` 保持 `false`。

---

## 7. 重整到最新 `rewrite/v4-agent`（2026-09-20）

上游在 PR #7 合并后又合入了协作者的多个模块（视频搜索分页、找视频相关度、评论筛选等），
本 PR 原先基于已合并的 `feat/live-batch-flow`，**如果直接合会覆盖上游的新实现**（第 6 条协作纪律）。
本次按正确做法重整：

* 以最新 `rewrite/v4-agent`（`b687484`）为基线，用**合并提交**（父提交 = 本分支原 head + 上游 head）
  把两边合到一起，**没有 force push**，历史保留。
* 对本 PR 改过、且上游也改过的 6 个文件做**三方合并**（base = PR #7 head，ours = 本 PR，theirs = 上游）：
  `sidecar.py`、`send_actions.py`、`douyin.py`、`douyin_selectors.py`、`SIDECAR.md`、
  `tests/test_probe.py`；两处冲突（能力矩阵新增项、测试新增块）按"两边都保留"解决。
* 上游改过、本 PR 没碰的文件（`crawl.py`、`EVIDENCE.md`、`tests/fixtures/comments.html`）**原样取上游**。
* 本地全量离线回归：**71 项，70 通过**；唯一未通过的是
  `SendGateTests.test_cross_process_same_target_only_one_reservation`，
  原因是本机沙箱禁止多进程（`PermissionError: [WinError 5]`），属于环境限制而非代码缺陷。

## 8. 真机结论补充（2026-09-20 实发）

| 结论 | 证据 |
|---|---|
| 公屏发送键是**回车**，不是输入框右侧的图标 | 点那个图标后输入框内容原样留在框里；改回车后输入框立刻清空 |
| 发送后能在**房间消息流**里看到自己那条 | 7 次真实发送，每次 `roomEcho: true`（数据源 `page_memory`） |
| 直播间页面的登录判定必须单独一条 | `data-e2e=user-info` 在 live 域不存在，只靠它会得到 unknown 并拦掉所有公屏回复 |
| 部分直播间把昵称脱敏成 `小***` | fiber 里 `nickname == desensitized_nickname` 且含星号；此时一律 `nickname_masked` 拒绝，不 @ 假名字 |
| 页面被遮挡时点击**不送达渲染进程** | 私信面板"成片打不开"、按钮命中正常却无反应（见工作日志第 7 条）；已用 `force_page_active` 处置 |
| 私信面板没有 `data-recipient-id`，也没有指向 `/user/<sec_uid>` 的链接 | 面板头部 `ChatHeadertitle` 是唯一可用的收件人信号（脱敏昵称按可见前缀比较） |
| 私信要在**独立标签页**打开主页 | 从直播间标签页直接导航过去时，同样的按钮点不开面板（面板 `dm_panel_not_open`） |
| 富文本输入框初始内容是一个零宽字符 | 会被误判成"已有草稿"（`composer_has_different_draft`），需归一化后再比较 |

**状态如实标注**：公屏回复已有真实送达证据（房间消息流回声）；私信链路已能打开面板并校验收件人，
但**"私信真实送达"还没有拿到证据**（上一轮被零宽字符草稿判定挡住，已修，待再跑一次真机）。
两者 `autoEligible` 均保持 `false`。

