# PR：直播间截流 → 自动私信（Python 探针/执行器）

> 目标分支：`rewrite/v4-agent`　来源分支：`feat/live-intercept-automation`
> 提交人：DSH Agent（在真实账号 + 真实浏览器上完成真机验证）
> 配套证据：`probe/worklog/`（截图 + 原始输出，**已脱敏**）

---

## 1. 功能

新增一个**独立、零第三方依赖**的 Python 工具包（仓库内 `probe/`），
把「**直播间弹幕 → 找意向用户 → 打开主页 → 私信触达**」这条链路做成可运行、可复核的实现。

| 模块 | 功能 |
|---|---|
| `live.py` | 直播间弹幕采集（**读页面内存里的数据模型**，每条自带 `sec_uid`）→ 关键词筛 → 意向打分 → 私信队列 |
| `dm.py` | 私信执行器：额度闸 / 台账与 `send_id` 幂等 / 熔断 / 分批节奏 / 送达复核 |
| `manual.py` | 人工点击工作台（本机网页）：程序出清单+话术+记账，**人**点【打开主页】→【私信】→发送 |
| `crawl.py` | 视频评论链路：关键词搜视频 → 抓评论 → 筛人 → 出队列 |
| `harvest.py` `watch.py` | 备用：人工点昵称时收割 `sec_uid`；观察模式记录人工操作 |
| `cdp.py` `dsh_ws.py` | CDP 客户端（含**拟人化**鼠标/键盘）+ 自研最小 RFC6455 WebSocket（仅标准库） |
| `dyselectors.py` | 选择器注册表（**唯一来源**，带离线/真机双验证日期） |
| `*_selftest.py` | 离线回归（含用 node DOM shim 跑**真实采集 JS**） |

**关键设计**：

1. **数据源**：弹幕数据本来就在页面内存里（弹幕虚拟列表组件的 React fiber props.`originalList`，
   每条 `WebcastChatMessage.payload.user` 带 `sec_uid` / 昵称 / 风控标记）。
   只读 DOM 文本时标识完整率是 **0%**，改读内存数据模型后实测 **100%**。
   这是**读页面自己已经拿到的数据**（与读 `innerText` 同性质），不是伪造签名、不是解码/重放网络帧、不调用内部接口。
2. **拟人化**：打字逐字进行，每字 **0.1~0.9 秒随机**；鼠标分 3 步移动 + 抖动，落点偏离中心 ±3px；
   目标之间对数正态 10~60 秒；每 12 条休息 5~10 分钟；仅 08:00–23:00 活跃。
3. **护栏**：服务端/配置单一来源的额度、发送前落 `send_id`、撞验证码/登录失效立即熔断、
   发送成功判定先判"平台拒绝文案"再判成功。

---

## 2. 依赖

**零第三方依赖。** 仅 Python 3.9+ 标准库（socket / ssl / urllib / json / re / http.server）。
自带最小 WebSocket 实现（`dsh_ws.py`），因此不需要 websockets / websocket-client / playwright / puppeteer ——
保持"裸 CDP、不注入自动化指纹"的设计前提。

运行前置：本机 Windows + Chrome（由使用者手动启动并登录，CDP 端口 9222）。

---

## 3. 接入方式

`@bash
cd probe

python probe.py doctor            # 自检：CDP 连通性 / 登录态 / 验证码 / 额度
python probe.py launch-chrome     # 专用 user-data-dir 启动 Chrome（与日常浏览器隔离），手动登录

# ① 直播间截流（只读采集）
python probe.py live --url "https://live.douyin.com/<房间号>" --seconds 120 --min-level 中意向
#    -> state/live_queue.json（每条自带 sec_uid）

# ② 触达（二选一）
python probe.py manual --queue state/live_queue.json --open          # 人到环：你点发送
python probe.py dm --queue state/live_queue.json --text "…" --allow-send   # 自动发送（默认只预填）

# ③ 评论链路（同样可用）
python probe.py crawl --keyword "宝宝辅食" --comment-keywords "几个月,怎么做" --videos 3
python probe.py manual --queue state/dm_queue.json --open
`@

安全默认：`dm` **不加 `--allow-send` 绝不发送**（只预填）；真实发送前需二次确认。

---

## 4. 测试结果

### 4.1 真机（真实账号 + 真实浏览器，2026-09-19）

| 项 | 结果 | 证据 |
|---|---|---|
| 弹幕采集 | 120 秒 8 条，**标识完整率 100%** | `worklog/evidence/02-live-collect.txt` |
| 私信发送 | **5/5 送达**（首次 3/5，2 条因"按钮被搜索框盖住"失败 → 修完重试成功） | `worklog/evidence/03-dm-send.txt` |
| 打字节奏 | 每字 0.1~0.9 秒随机；"你好"2 字实测 1.0~1.6 秒 | 同上 |
| 目标间隔 | 15.5 / 16.0 / 22.0 / 27.9 / 36.2 秒 | 同上 |
| 额度与去重 | 失败**不占额度**（可安全重试）；已发送者被 `quota_user_exceeded` 拦下，**未重复打扰** | 同上 + `07-quota.txt` |
| 送达复核 | 会话面板内出现文案 + 平台规则提示 | `worklog/screenshots/02-私信会话-已送达你好.png` |

### 4.2 离线回归（无需浏览器/账号）

`@bash
cd probe
python live_selftest.py      # 直播间模块：Python 逻辑 + node DOM shim 跑真实采集 JS
python manual_selftest.py    # 人工工作台：渲染 / 记账 / 额度 / 去重 / 重启恢复
`@

两者全过（输出见 `worklog/evidence/04-selftests.txt`）。

---

## 5. 合规与边界

| 我们做的 | 我们不做的 |
|---|---|
| 读**页面自己已经拿到**并存在内存里的数据 | ❌ 伪造 `a-bogus` / `msToken` 签名直调内部接口 |
| 只读：不改写、不注入、不回放数据帧 | ❌ 解码 / 重放 WebSocket 数据帧 |
| 守平台额度（未互关 1 条/人、40 人/时、100 人/天） | ❌ 多账号轮换规避风控 |
| 撞验证码/登录失效**立即熔断交人工** | ❌ 验证码识别 / 滑块模拟 / 指纹对抗 |
| 入库内容**全部脱敏**（无 sec_uid 原值、无昵称、无凭据） | ❌ 提交任何真实用户数据 |

---

## 6. 未验证 / 风险（请审核重点看）

1. **成功判据**：本通道抓不到平台响应码，最强证据是 `sent_dom_confirmed`（文案出现在会话面板）。
   与红线 2 原设想的 `confirm_signal=platform_response` 不一致 —— **需要产品侧确认计费口径**。
2. **数据源依赖页面实现**：弹幕只在页面内存里，平台改版会让采集退回 DOM（0% 标识）。
   程序会在日志里明确提示并继续用 DOM 兜底，不会静默降级；但需要人工回填选择器。
3. **匿名化房间无解**：福袋/活动房的参与者在平台侧即匿名（`uid=111111`、昵称打码、无 `sec_uid`），拿不到人。
4. **真实账号风险**：本工具在真实账号上执行真实触达，账号存活由使用者承担；额度与节奏参数应改为服务端下发。
5. 本次未覆盖：多账号并发、服务端下发配置、计费与授权中心（属后续里程碑）。

---

## 7. 如何完成推送与开 PR（提交环境受限，请在沙箱外执行）

本次提交已在本地完成（分支 @@feat/live-intercept-automation@@，提交 @@ba4688e@@），
但**提交环境无法访问 GitHub**：

| 尝试 | 结果 |
|---|---|
| git（schannel 后端） | @@SEC_E_NO_CREDENTIALS@@ —— 拿不到 TLS 凭据 |
| git（openssl 后端） | MSYS @@couldn't create signal pipe, Win32 error 5@@ —— 命名管道被禁 |
| 凭据检查 | 无 GITHUB_TOKEN / GH_TOKEN / ~/.git-credentials / ~/.ssh / gh CLI |

@@@bash
# 在有 GitHub 凭据的机器上：
git fetch origin
git checkout -b feat/live-intercept-automation origin/rewrite/v4-agent
# 把本机 probe/ 整目录覆盖进来（.gitignore 会自动挡掉 state/ 等运行时数据）
#   Windows:      xcopy /E /I "<本机路径>probe" "probe"
#   macOS/Linux:  cp -r "<本机路径>/probe" ./probe
git add probe/
git status            # 确认没有 state/、*.jsonl、__pycache__
git commit -F probe/COMMIT-MESSAGE.txt
git push -u origin feat/live-intercept-automation
@@@

然后在 GitHub 上向 @@rewrite/v4-agent@@ 发起 PR，正文用本文件（@@probe/PR-BODY.md@@）。
