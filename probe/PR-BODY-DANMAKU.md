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
