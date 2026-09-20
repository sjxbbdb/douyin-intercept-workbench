# feat(probe): 关键词搜视频 → 评论采集 → 评论关键词筛选 → 私信队列

> 目标分支：`rewrite/v4-agent` ｜ 来源分支：`feat/keyword-video-comment-crawl`
> 关系说明：本 PR **取代** `feat/python-cdp-probe`（同一基线、同一套工具，本分支补上了工作日志证据与 `selectors` 模块改名修复）。
> 同系列的直播间链路在 `feat/live-intercept-automation`，与本 PR 相互独立，可分别审核。

---

## 1. 这个 PR 做什么

新增一个**独立、零第三方依赖**的 Python 工具包 `probe/`，实现截流链路最前面的四步：

| # | 能力 | 入口 |
|---|---|---|
| 1 | **按视频关键词搜视频** | `python probe.py search --keyword "宝宝辅食"` |
| 2 | **抓取视频评论**（带 `sec_uid`） | 同上 crawl 命令内部 |
| 3 | **按评论关键词筛选评论**（四档语义） | `--comment-keywords --match-mode` |
| 4 | 产出私信队列（按人去重） | `state/dm_queue.json` |

外加一个可选的私信执行器（第 5 步，默认**只预填不发送**）：`python probe.py dm --allow-send`。

`probe/` 与生产栈（Node `server/` `desktop/`）**没有构建关系**，是独立的可行性探针 + 执行器，
不参与 `npm run check` / `npm test`。

---

## 2. 怎么实现的（重点）

### 2.1 原则：以【平台接口响应体】为准，DOM 只做兜底

这是真机上试出来的，不是设计洁癖：

| 环节 | 用接口 | 为什么 DOM 不行 |
|---|---|---|
| 搜视频 | `www.douyin.com/aweme/v1/web/general/search/single/`，响应体 `{status_code, data[], cursor, has_more}`，每条 `data[i].aweme_info` | 搜索卡片 `[id^="waterfall_item_<aweme_id>"]` 里**连 `<a>` 链接都没有**，标题被拆成一堆 span，日期/点赞混在 `innerText` 里，解析极脆 |
| 抓评论 | `www-hj.douyin.com/aweme/v1/web/comment/list/?...&aweme_id=<id>&cursor=..&count=..`，响应体 `comments[]` | DOM 能拿到 `sec_uid`，但接口字段更全（`cid` / `digg_count` / `reply_comment_total` / `ip_label`），且**不受虚拟列表回收影响** |

实现：`cdp.py: NetworkRecorder` 监听 `Network.responseReceived` → `Network.getResponseBody` → `json.loads` 直接读字段。

> 🔴 **记录器锁死本次 `aweme_id`**：视频页会连带请求推荐视频的评论，不锁就会串味（真机验证过）。

### 2.2 翻页靠滚动驱动，且必须确认页面真的可见

搜索结果靠滚轮触发懒加载；实测（同一关键词）：

| 页面状态 | 搜到的视频 |
|---|---|
| `visibilityState == "visible"` | **83 条** |
| `visibilityState == "hidden"`（Chrome 窗口被其它窗口完全遮挡） | **9 条** |

**两者都不报错** —— 典型静默降级。因此：`douyin.ensure_visible()` 先判可见性并尝试置前；
`winfocus.py` 用 `ctypes` 调 `user32.ShowWindow(SW_RESTORE) + SetForegroundWindow` 真正把窗口拉到前台
（CDP 的 `Page.bringToFront` / `Target.activateTarget` **改不了 Windows 的遮挡判定**，实测无效）；
`douyin.scroll_by()` 在不可见时直接走 JS 滚动，不浪费超时。

### 2.3 评论关键词的四档语义

老实现（`pipeline.js`）是「任意**字**命中」：`求带` → 命中「求」或「带」。召回高，但噪声极大。
私信有额度、有账号风险，所以把档位摆到台面上，并且**每次运行都把四档命中数一起打出来**，
不用来回试参数就知道该松还是该紧：

| 档位 | 语义 |
|---|---|
| `phrase` | 评论里出现**任一关键词的原串**（最精确） |
| `seg` **（默认）** | 任一关键词的**全部分词**都出现，顺序无关 |
| `all` | **所有**关键词都必须命中 |
| `any` | 任意字命中（老语义，召回优先） |

实测同一批 284 条评论，关键词「怎么做,为啥,请问,几个月」：
**`phrase` 11 / `seg` 11 / `all` 0 / `any` 77** —— 老语义 27% 的命中率里绝大部分是噪声。

### 2.4 去重：接口与 DOM 的正文会差在表情上

接口给的正文带表情「…谢谢了[握手][握手][握手]」，DOM 给的正文把表情丢了「…谢谢了」。
按 `(sec_uid, 全文)` 去重**漏掉这一对**，同一条评论进队列两次。
→ `dedupe_comments()` 改**前缀包含**判定，并保留信息更全的那条（优先接口记录）。实测 280 → **257**。

### 2.5 私信执行器（默认关闭）

| 机制 | 实现 |
|---|---|
| 额度 | 集中在 `dm.py: LIMITS`，**不散落硬编码**（对齐红线 1/2 精神：上限应由服务端下发） |
| 幂等 | `send_id` 在**发送前**生成并 `fsync` 落盘 |
| 台账 | append-only `jsonl`，崩溃后可恢复 |
| 熔断 | 验证码 / 登录失效 / 空响应 → 立即停止并交人工 |
| 节奏 | 单条间隔对数正态随机（10–60s），每 12 条休息 5–10 分钟 |
| 复核 | 发送后读会话列表 `[class*=MessageList]` 判定是否进入会话 |

**默认只预填不发送**，必须显式 `--allow-send` + 二次确认。

---

## 3. 依赖

**零第三方依赖。** 只用 Python 3.9+ 标准库（`socket` / `ssl` / `urllib` / `json` / `re` / `ctypes` / `zlib`）。

自带最小 RFC6455 WebSocket 实现（`dsh_ws.py`，含 64 位帧长与分片重组），
因此**不需要** `websockets` / `websocket-client`，也**不需要** `playwright` / `puppeteer` ——
保持「裸 CDP、不打自动化指纹」的设计前提。

---

## 4. 接入方式

前置：本机 Chrome 以 `--remote-debugging-port=9222` 启动，并在其中**手动登录**抖音账号。

```bash
cd probe
python probe.py doctor          # 自检：CDP 连通性 / 登录态(cookie) / 验证码 / 额度
python probe.py launch-chrome   # 用专用 user-data-dir 启动带调试端口的 Chrome（与日常浏览器隔离）

# 第 1 步：只搜视频（只读，不打开视频、不抓评论、零发送）
python probe.py search --keyword "宝宝辅食" --max-videos 60 --scroll 6 --show 20

# 第 1–4 步：搜视频 -> 抓评论 -> 按评论关键词筛评论 -> 出队列
python probe.py crawl --keyword "宝宝辅食" --comment-keywords "怎么做,为啥,请问" \
                      --match-mode seg --videos 3 --order comments

# 第 5 步（可选）：私信；默认只预填，不加 --allow-send 绝不发送
python probe.py dm --queue state/dm_queue.json --text ""
```

产物（均在 `probe/state/`，已被 `.gitignore` 排除、不入库）：
`search_videos.json` / `crawl_targets.json` / `crawl_comments.json` / `filtered_comments.json` / `dm_queue.json`。

---

## 5. 测试结果

### 5.1 离线（`python probe/selftest.py 9222`，真实 Chrome 153.0.8010.50）

```
tabs: 5            browser: Chrome/153.0.8010.50
evaluate 1+1        -> 2
eval_json object    -> {'a': 1, 'b': [2, 3]}
eval_json missing   -> None
large payload len   -> 200000      (64 位帧长 + 分片重组)
navigate            -> True
SELFTEST OK
```

### 5.2 真机端到端（真实账号 · 桌面 Chrome · 2026-09-19 / 09-20）

| 环节 | 结果 |
|---|---|
| 关键词搜视频 | 「宝宝辅食」**83 条**（10 个接口响应，`status_code` 非 0 的 0 个）；复跑 **61 条** |
| 搜索翻页 | 滚轮驱动；冷门词（「codex会员」）20 多条时页面出现「暂时没有更多了」 |
| 抓评论 | 3 条视频共 **284 条**评论，`sec_uid` 完整率 **100%**；单条 505 评论的视频实抓 **191 条** |
| 评论筛选 | `seg` 命中 **11 条** → 队列 **11 人**（按 `sec_uid` 去重） |
| 私信发送 | **9/9 送达**（`sent_dom_confirmed`），2 个面板未开的重试后成功 |
| 失败重试安全 | 失败**不占额度**，可安全重试；已发送者被 `quota_user_exceeded` 拦下 |

完整真实输出（含环境自检、搜索、筛选参数、脱敏台账）：
**`probe/worklog/evidence/09-keyword-chain.txt`**。

### 5.3 截图（`probe/worklog/screenshots/`）

| 文件 | 内容 |
|---|---|
| `05-关键词链路1-搜索页-按视频关键词搜视频.png` | 第 1 步现场：搜索页 |
| `06-关键词链路2-视频页-评论区采集现场.png` | 第 2 步现场：视频页 + 评论区 |
| `04-真验证码证据-2026-09-19.png` | 采集过密触发的平台真验证码（熔断证据） |

配套说明与脱敏证据：`probe/worklog/README.md`（§2.5 关键词链路、§4.4 该链路专属问题）、
`probe/worklog/evidence/08-screenshot-index.txt`。

---

## 6. 真机修正过的问题（每条都在源码注释里留档）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | **接口响应体永远抓到 0 条**，且不报错 | `NetworkRecorder` 只是注册回调；Network 域没打开就一个事件都不来 | `connect()` 顺手 `Network.enable`，各模块再 `ensure_domains()` 兜底 |
| 2 | 明明登录着却判「需要登录」，全链路中止 | 正文匹配 `扫码登录|登录后`；搜索页一条视频简介写着「一旦**退出登录后**…」就命中 | 改 **cookie 判据**：`Network.getCookies` 里有 `sessionid/sid_tt/sid_guard` = 已登录（均为 HttpOnly，`document.cookie` 读不到，必须走 CDP） |
| 3 | 正常页面被判「出现验证码」 | 抖音在**每个页面**预埋 `#captcha_container`（`position:fixed; z-index:111111; 1036x850`，**内容为空**） | 判据改为「可见**且里面有东西**」+ OOPIF frame URL 含 `verifycenter/captcha` |
| 4 | 滚轮滚了评论一条不多 | 老代码把滚轮固定在 `(900,500)`；新版视频页里可见的 comment-list 在页面下方（rect ≈ `72,745,673,677`） | 读可见容器真实 rect 打滚轮，再 JS 把容器及可滚动祖先 `scrollTop` 拉到底；**不动 documentElement/body**（整页下滚会切到下一个视频） |
| 5 | 同一条评论收两次 | 接口正文带表情、DOM 正文丢表情，按全文去重漏掉 | 前缀包含判定 + 保留信息更全者 |
| 6 | 稿件文案被打进顶栏搜索框（静默错误） | `dm_composer` 取「页面第一个可见输入框」，命中的是 `[data-e2e=searchbar-input]` | 按 `[class*=messageEditor]` 容器限定作用域，兜底也必须在私信容器内 |
| 7 | 发送键永远找不到 | 它是**无文字、无 aria-label 的 SVG 图标** | 按类名 `[class*=e2e-send-msg-btn]` 定位 |
| 8 | 批量跑时「私信面板成片打不开」 | worker 标签失去活动标签地位 → `visibilityState == hidden` → **点击不送达渲染进程**，且不报错 | 每次点击前重判可见性并 `activate_target` + 真正置前窗口；修后干跑 **9/9 通过**（修前 1/6） |
| 9 | 同一个人 10 分钟内被发两条；每日上限从未生效 | 额度闸只认 `sent_confirmed`，而本通道最强证据是 `sent_dom_confirmed` | 改按「**尝试过**」计数（含 `submitted`/`unverified`）：漏判比误判贵 |
| 10 | 把平台拒绝当成发送成功 | 「文案出现在面板里」分不清「已送达」与「被平台退回后仍在消息区」 | 先判拒绝文案（`给对方发送的消息已达上限` 等）再判成功；`对方无法回复你的私信` 单独记 `replies_blocked` |
| 11 | 本目录的 `selectors.py` 顶掉标准库同名模块 | 模块名与标准库冲突，实测报 `module 'selectors' has no attribute 'SelectSelector'` | 改名 `dyselectors.py` 并同步 import（文件头写明原因，别改回去） |

---

## 7. 请评审关注的设计问题（重要）

### 7.1 红线 3 在本通道上无法按原设计实现

私信走 **frontier IM 长连接**，CDP `Network` 域**抓不到发送请求**
（发送期间：不限域名的 HTTP POST = **0 个**；带内容的 WebSocket 发送帧 = **0 个**；
只观测到长连接的接收帧与 2 字节应用层心跳）。

因此 `AGENTS.md` 红线 3 要求的「**服务端确认的合法业务结果**」在本通道**不可得**。
探针采用的证据分级：

| 级别 | 判据 | 强度 |
|---|---|---|
| `sent_confirmed` | 平台响应码 `0` | 最强 —— **本通道不可得** |
| `sent_dom_confirmed` | 文案出现在会话列表（数据来自服务端，但仍经页面渲染） | 强 |
| `submitted` | 输入框被清空 | **弱，属 DOM 表象** |

⚠️ 而且 `sent_dom_confirmed` **会误报**：实测有一条被判成成功的发送，会话原文里其实写着
「给对方发送的消息已达上限…」—— 文案在面板里，但不是送达。这一条已修（见 §6 第 10 条），
但**只要判据还是 DOM 表象，它就不满足红线 3 的「可扣积分」标准**。

**这是需要上游决策的开放问题**：或改用会话列表复核 + 抽样人工核对，或走官方 API 通道
（`enterprise.im`，需企业号且当前暂停新增准入）。探针**不声称可计费**。

### 7.2 采集类动作也消耗账号风险

实测：连续十几轮、**固定 2 秒间隔**的滚动之后，账号被弹出**真验证码**
（`rmc.bytedance.com/verifycenter/captcha/v2` 的居中 iframe）。
⚠️ 注意：**本次会话的用户已确认其账号没有隐私设置问题**，
早前看到的「由于你的隐私设置，对方无法回复你的私信」提示后来自行消失 —— 不要再据此下结论。

处置：间隔改**对数正态随机**（`--scroll-pause` 可调慢）；撞到验证码**先把已抓到的落盘再停**
（`stopped_reason=captcha`），不丢数据、不触碰、不绕过。

### 7.3 数据源依赖页面实现

平台改版会让接口路径/字段变化。程序在抓不到时会**明确提示**，不会静默降级；
但需要人工介入回填。

---

## 8. 未验证边界（明确不声称）

- ❌ **企业号行为未验证**：额度（3 条/用户）、私信通后台、官方 API 均未接入或测试。
- ❌ **官方开放 API 未使用**，也不在本工具范围内。
- ❌ **不声称可计费**：见 §7.1，缺平台侧确定成功信号。
- ❌ **长期稳定性未验证**：仅单日、少量样本；送达率与回复率样本量不足以得出比例结论。
- ❌ **未做压力验证**：每小时/每日触达上限**刻意不压测**，避免消耗账号风险。

---

## 9. 合规声明（对照 `AGENTS.md` 安全红线 1）

- ✅ **未**实现验证码 / 滑块识别或绕过；检测到即熔断并交人工。
- ✅ **未**实现逆向 API、签名伪造（`a-bogus` / `msToken` 一律不碰）。
- ✅ **未**导出 Cookie / localStorage；**未**做抓包重放。
- ✅ **未**做浏览器指纹混淆或反检测。
- ✅ **未**做多账号轮换规避风控。
- ✅ 程序运行在商家**手动登录**的可见浏览器中，操作的是平台自身界面。

---

## 10. 文件清单

```
probe/
  .gitignore            运行时数据不入库（state/ *.jsonl __pycache__/ _*.py）
  README.md             工具包说明
  EVIDENCE.md           真机证据（按 README-DEV.md「提交前」要求：账号/日期/页面版本/失败状态/未验证边界）
  PR-BODY.md            本文件
  COMMIT-MESSAGE.txt    提交信息
  cdp.py                CDP 客户端 + Network 响应体录制（红线 3 的基础）
  dsh_ws.py             自研最小 RFC6455 WebSocket（仅标准库）
  dyselectors.py        选择器注册表（唯一来源，带离线/真机双验证日期）
  douyin.py             页面操作原语（可见容器筛选、评论采集、私信入口/编辑器/发送键、可见性与滚动）
  winfocus.py           Windows 窗口置前（ctypes；解决遮挡导致的静默降级）
  crawl.py              关键词搜视频 -> 抓评论 -> 评论关键词筛选 -> 出队列
  scripts.py            话术库（8 条角度模板 + 均衡轮换 + 敏感模式兜底校验）
  dm.py                 私信执行器（额度/台账/幂等/熔断/分批节奏/送达复核）
  probe.py              命令行入口（doctor/launch-chrome/v1/v4/search/crawl/dm）
  selftest.py           传输层自检
  worklog/              工作日志（README + evidence/ + screenshots/，全部脱敏）
```

---

## 11. 如何完成推送与开 PR

本机（沙箱）内**无法推送**，已留证据：

| # | 限制 | 现象 |
|---|---|---|
| 1 | git 默认 schannel 后端 | `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` |
| 2 | git 改 openssl 后端 | 能连通 GitHub，但需要凭据；本机**无任何 GitHub 凭据**（无 `GITHUB_TOKEN` / `~/.git-credentials` / `~/.ssh` / `gh`） |
| 3 | 目标仓库为**私有** | `api.github.com/repos/sjxbbdb/douyin-intercept-workbench` 返回 404（匿名不可读） |

在有凭据的机器上执行：

```bash
git fetch origin
git checkout -b feat/keyword-video-comment-crawl origin/rewrite/v4-agent
# 把本 PR 的文件放到 probe/（或用附带的 bundle 直接拉取提交）
git add probe/
git status            # 确认没有 state/、*.jsonl、__pycache__、_*.py
git commit -F probe/COMMIT-MESSAGE.txt
git push -u origin feat/keyword-video-comment-crawl
```

然后在 GitHub 上向 `rewrite/v4-agent` 发起 PR，正文即本文件。

> 附带的 `keyword-video-comment-crawl.bundle` 可直接把提交搬到有凭据的机器：
> `git fetch /path/to/keyword-video-comment-crawl.bundle feat/keyword-video-comment-crawl:feat/keyword-video-comment-crawl`