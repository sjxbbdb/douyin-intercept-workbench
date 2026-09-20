# feat(probe): 直播间「原生回复弹幕」+「关键词命中 → 回复 → 滚动监测 → 私信」全链路（真机验证）

> 基线：`rewrite/v4-agent`。本文按仓库 `AGENTS.md`「新增平台能力必须同时提交：真机证据、能力矩阵、
> 失败状态、脱敏测试、未验证边界和发行开关条件」的要求给出对应材料。

## 变更模块（按目录）

| 模块 | 文件 | 变更 |
|---|---|---|
| 直播间适配 | `probe/live.py` | 原生「回复 TA」全流程；屏上可见行采集；房间号解析；菜单可见性判定；截断容忍匹配 |
| 发送动作 | `probe/send_actions.py` | `send_danmaku_reply_native`（提及校验 + 真实按键输入 + 输入框残留清理 + 平台确认框处置） |
| 点击护栏 | `probe/click_guard.py`（新增） | 命中测试 + 容器限制 + 文案指纹 + 每次尝试写审计 JSONL |
| 流程编排 | `probe/live_flow.py` | `replyMode`/`replyVia` 冻结在计划里；`sent_echoed` 状态 |
| 边界服务 | `probe/sidecar.py` | `live_plan` 返回并校验 `replyVia`；`live_reply` 按计划分派通道；能力矩阵回填 |
| 选择器 | `probe/douyin_selectors.py` | 真机弹幕选择器；错误页选择器；直播间登录判据 |
| 浏览器层 | `probe/cdp.py` | `press_key` 支持修饰键（Ctrl+A 清空输入框） |
| 测试 | `probe/tests/test_probe.py` | 新增 `RoomUrlTests` / `RoomEchoTests` / `ReplyViaTests` / `SidecarReplyViaDispatchTests` / `IdentityVisibilityTests` / `ClickGuardTests` / `ChatScrollTests` |
| 证据 | `probe/EVIDENCE.md` | 第 12 节：本轮全部真机事实、失败状态与未验证边界 |

## 关键真机事实（本轮修正）

1. **广场式直播间地址**：房间号在 `?live_web_rid=…`，路径为空 —— 直接取 path 会让
   `target.roomId` 校验失败、并在"校验当前页面"处抛 `URLPolicyError`。现在按房间号归一。
2. **虚拟列表**：页面内存 79~200 条，DOM 只渲染 11~17 行；上滚找旧弹幕会让最新弹幕落到
   可视区下方。候选改从"此刻渲染在列表内"的行里取。
3. **长弹幕被平台截断**：内存是完整正文、DOM 是截断形式 —— 定位改为"完全相同或前缀匹配（≥6 字）"。
4. **隐藏浮层假阳性**：Semi 浮层隐藏时位于 `(-9947,-9941)` 但仍有尺寸，曾被当成"菜单已打开"。
5. **平台确认框**「单次只支持艾特一个人，艾特其他人会清空内容，是否继续？」：上一次失败残留的
   @提及会触发它，它是**全屏遮罩**，会挡住之后所有点击。现在回复前清空残留、插入提及后边等边看。
6. **观众身份不一定可见**：有的房间观众行 `sec_uid` 为空、`uid` 是占位值 `111111`（昵称脱敏），
   拼出来的主页是错误页（`data-e2e="error-page"`）。现在识别错误页并返回 `profile_not_found`，
   身份不可见就不私信（fail-closed）。
7. **真实按键输入**：正文逐字 `dispatchKeyEvent(type=char)`、每字 0.1~0.9 秒随机；不用 `insertText`。

## 真机执行结果（用户新开的直播间）

| 步骤 | 结果 |
|---|---|
| 关键词命中 | ✅ 自动派生关键词命中 2~9 行/轮 |
| 原生回复弹幕 | ✅ 多条 `mentionInserted=true` + `roomEcho=true` |
| 私信 | ✅ `conversationEcho=true`、`composerCleared=true`、收件人 `live_panel_header` 校验通过 |
| 点击审计 | ✅ 每次尝试一行；被拒绝的落点含输入框、未读分隔条、平台遮罩 |

## 测试

```
python tests/test_probe.py            # 需要写系统临时目录
python tests/_sandbox_runner.py       # 受限沙箱下用工作区临时目录
```

* 离线用例 **112 个全部通过**（`ChromiumFixtureTests` 需能派生 headless Chrome；
  多进程用例需能创建命名管道 —— 这两类在受限沙箱下按环境跳过）。
* 真机用例不放进自动回归：所有真机动作（点击/输入/发送）都需要授权，且结果一律保留 `unknown`。

## 未验证边界 / 发行开关

* 发送频率阈值未实测（已知连续约 10 条后平台静默丢弃）。
* 私信送达后的对方可见性（提醒、折叠、限流）未验证。
* `roomEcho` / `conversationEcho` 是页面观测证据，不是平台响应；两阶段默认只放行 `sent_confirmed`。
* 因此 `live_batch` / `live_danmaku_reply` / `live_private_reply` 继续保持 `autoEligible: false`。
