# 工作日志 · 直播间自动私信（2026-09-19）

> 给开发者审核用。**全部内容已脱敏**：不含 sec_uid 原值（只留前 16 位 + …）、
> 不含任何用户昵称（替换为 `用户NN`）、不含 Cookie / token。
> 截图里的用户名同样经过页内替换后再截。

---

> ⚠️ **本分支（`feat/keyword-video-comment-crawl`）只带「关键词视频/评论链路」的证据。**
> 索引表里标注「直播间链路」的 evidence 文件属于姊妹分支 `feat/live-intercept-automation`，**不在本 PR 内**；
> 本 PR 实际包含：`README.md`、`evidence/08-screenshot-index.txt`、`evidence/09-keyword-chain.txt`、
> `evidence/10-push-attempt.txt`，以及 `screenshots/04` `05` `06` 三张图。

---

## 1. 这份日志怎么读

| 目录/文件 | 内容 |
|---|---|
| `screenshots/01-直播间-弹幕采集.png` | 原子链路第 1–2 步：直播间 + 弹幕区（数据来源） |
| `screenshots/02-私信会话-已送达你好.png` | 第 7–8 步：私信面板里那条自动发出的「你好」 |
| `screenshots/03-人工点击工作台.png` | 半自动模式：程序出清单/话术/记账，人点发送 |
| `screenshots/04-反例-福袋房弹幕被匿名化.png` | 反例：某直播间跑福袋活动时，参与者被平台匿名化，抓不到人 |
| `evidence/01-environment.txt` | 运行环境（系统/版本/CDP/标签）+ 沙箱限制 |
| `evidence/02-live-collect.txt` | 弹幕采集真实输出（含标识完整率） |
| `evidence/02-conversation-text.txt` | 私信会话面板原文（送达证据） |
| `evidence/03-dm-send.txt` | 5 人发送测试的台账与汇总（含每条的耗时/可见性/入口命中） |
| `evidence/04-selftests.txt` | 两套离线回归输出 |
| `evidence/05-selector-registry.txt` | 选择器注册表（离线/真机双验证日期） |
| `evidence/06-git-and-network.txt` | 仓库状态 + 沙箱内无法推送的证据 |
| `evidence/07-quota.txt` | 额度快照 |
| `evidence/08-screenshot-index.txt` | 截图索引 |
| `screenshots/05-关键词链路1-搜索页-按视频关键词搜视频.png` | **关键词链路①**：搜索页（本 PR 主体功能的第 1 步） |
| `screenshots/06-关键词链路2-视频页-评论区采集现场.png` | **关键词链路②**：视频页 + 评论区（评论数据来源） |
| `logs/09-keyword-chain.txt` | **关键词链路**的真机运行输出（环境 + 搜视频 + 筛选参数 + 已脱敏台账） |
| `logs/10-push-attempt.txt` | 本 PR 的提交哈希、bundle 校验、以及**沙箱内推送失败**的原始证据 |

---

## 2. 原子链路（8 步，全部真机验证过）

| # | 步骤 | 实现 | 状态 | 证据 |
|---|---|---|---|---|
| 1 | 打开直播间 | `live.normalize_room` + CDP 导航，页面被遮挡时用 `force_page_active` 拉回 active | ✅ | 01 截图 |
| 2 | 取弹幕数据 | **读页面内存里的数据模型**：弹幕虚拟列表组件的 React fiber props.`originalList`，每条 `WebcastChatMessage.payload.user.sec_uid` | ✅ **标识完整率 100%** | 01 截图、02-live-collect |
| 3 | 关键词筛选 | 复用评论链路的四档语义（phrase/seg/all/any） | ✅ | 02-live-collect |
| 4 | 意向打分 + 出队列 | 可解释规则打分；剔除主播/同行/平台匿名化；按 sec_uid 去重 | ✅ | 02-live-collect |
| 5 | 打开目标主页 | 拟人鼠标：分 3 步移动 + ±8px 抖动 → 停顿 → 按下 | ✅ | 03-dm-send |
| 6 | 点【私信】 | **命中测试**（`elementFromPoint`）+ 在按钮矩形内 **5×5 采样**挑一个真能点到的点 | ✅ | 03-dm-send |
| 7 | 输入话术 | **逐字**按键，每字 **0.1~0.9 秒随机**（实测 2 字耗时 1.0~1.6 秒） | ✅ | 03-dm-send |
| 8 | 发送 + 复核 | 点发送 → 读会话面板确认文案已进入 → 写台账（`send_id` 幂等） | ✅ **5/5** | 02 截图、03-dm-send |

补充：还有一条**半自动**链路（`probe.py manual`）—— 程序出清单/话术/记账，人点【打开主页】→【私信】→发送，见 03 截图。

---

## 2.5 关键词视频/评论链路（2026-09-20 补 · 本次 PR 的主体）

> 这条链路就是本 PR 提交的功能：**按视频关键词搜视频 → 抓评论 → 按评论关键词筛评论 → 出私信队列**。

| # | 步骤 | 实现 | 证据 |
|---|---|---|---|
| 1 | 按视频**关键词**搜视频 | 导航搜索页，**读平台搜索接口响应体** `general/search/single`（`data[].aweme_info`）；DOM 瀑布流只做兜底 | 05 截图、logs/09 §B |
| 2 | 抓视频评论 | **读平台接口响应体** `comment/list`（`comments[].user.sec_uid` 直接就有）；DOM 采集兜底 | 06 截图、logs/09 §D |
| 3 | 按评论**关键词**筛评论 | 四档语义 `phrase` / `seg`（默认）/ `all` / `any`，**四档命中数一起打印** | logs/09 §C、§D |
| 4 | 出私信队列 | 按 `sec_uid` 去重 + 点赞阈值 | logs/09 §D |

### 为什么"读接口响应体"而不是读 DOM

| 环节 | 接口 | 不用 DOM 的原因 |
|---|---|---|
| 搜视频 | `aweme/v1/web/general/search/single/`<br>`{status_code, data[], cursor, has_more}` | 搜索卡片 DOM 里**没有 `<a>` 链接**，标题被拆成一堆 span、日期/点赞混在 innerText 里；接口里 `aweme_id / desc / author.sec_uid / statistics` 全是结构化字段 |
| 抓评论 | `aweme/v1/web/comment/list/?...&aweme_id=<id>&cursor=..` | DOM 能拿到 sec_uid，但接口字段更全（`cid / digg_count / reply_comment_total / ip_label`），而且**不受虚拟列表回收影响** |

> 🔴 记录器**锁死本次 `aweme_id`**：视频页会连带请求推荐视频的评论，不锁 aweme_id 就会串味。

### 评论关键词的四档语义（`--match-mode`）

老实现（pipeline.js）是"任意**字**命中"（`求带` → 命中"求"或"带"），召回高但噪声极大。
私信有额度、有账号风险，所以把档位摆到台面上，并且**每次运行都把四档命中数一起打出来**：

| 档位 | 语义 |
|---|---|
| `phrase` | 评论里出现**任一关键词的原串** |
| `seg` **（默认）** | 任一关键词的**全部分词**都出现，顺序无关 |
| `all` | **所有**关键词都必须命中 |
| `any` | 任意字命中（老语义，召回优先） |

实测同一批 284 条评论：`phrase` 11 / **`seg` 11** / `all` 0 / `any` **77** —— 老语义 27% 的命中率里绝大部分是噪声。

### 实测数据（2026-09-20 现场重跑）

关键词「宝宝辅食」→ **61 条视频**（8 个接口响应，`status_code` 非 0 的 0 个）；`--order comments` 挑评论最多的视频抓；
单条 505 评论的视频实抓 **191 条**评论、`sec_uid` 完整率 **100%**。完整输出见 `logs/09-keyword-chain.txt`。

---

## 3. 当前环境

| 项 | 值 |
|---|---|
| 系统 | Windows（Administrator 会话） |
| Python | 3.13 |
| 浏览器 | Chrome 153（**由使用者手动启动并登录**，CDP 端口 9222） |
| 依赖 | **零第三方依赖**（只用 Python 标准库；自带最小 WebSocket 实现） |
| 仓库 | `sjxbbdb/douyin-intercept-workbench` 的本地克隆，基线分支 `rewrite/v4-agent` |
| 工具链 | git 2.55（PortableGit） |

### 沙箱限制（阻塞 PR 推送，需要在沙箱外执行）

| # | 限制 | 证据 |
|---|---|---|
| 1 | git 用 schannel 后端：`SEC_E_NO_CREDENTIALS`（拿不到 TLS 凭据） | evidence/06 |
| 2 | git 用 openssl 后端：MSYS `couldn't create signal pipe, Win32 error 5`（命名管道被禁） | evidence/06 |
| 3 | 无 GitHub 凭据：无 GITHUB_TOKEN / GH_TOKEN / ~/.git-credentials / ~/.ssh / gh CLI | evidence/06 |
| 4 | （背景）Chrome 无法在本沙箱内**启动**（Mojo 命名管道同样被拒），但可以**连接**已运行的 Chrome —— 全部真机验证都是这样做的 | evidence/01 |

> Python 的 HTTPS 可以出网（github.com → 200），所以**唯一缺的是 git 的传输与推送凭据**。

---

## 4. 已解决的问题（每条：现象 → 根因 → 修法）

### 4.1 数据源类

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 弹幕里 **sec_uid 完整率 0%**，私信环节无解 | 只读 DOM 文本，而弹幕 DOM 里**根本没有**用户标识（无 `data-sec-uid` / 无 `a[href]`，头像位是等级徽章图） | 改读**页面内存数据模型**（React fiber props.`originalList`）→ **100%** |
| 2 | 某直播间一个人都拿不到 | 该房在跑福袋/活动，弹幕被平台**匿名化**：`uid=111111`、昵称打码、无 sec_uid | 新增 `is_anonymized` 识别并在 CLI 明确提示"换一间房" |
| 3 | 采到的"弹幕"是多条消息拼接的假行 | 模糊选择器同时命中容器与行；容器被当成一行 | 容器回声过滤：**已解析节点里取最深层**；**被判为噪音的子节点也算行**，一样顶掉父容器 |
| 4 | 粉丝团前缀行被解析成"昵称=猪叫团" | 前缀独占一行；噪音判定只看第一行之后的文本 | 噪音判定对"最后一个冒号之后"再判一次 |
| 5 | 出现 text=`\u200b` 的空弹幕 | JS 的 `\s` 不匹配零宽空格 | 显式剥掉 `\u200b \u200c \u200d \ufeff` |
| 6 | 导航后前 20 秒稳定 0 条 | 容器很快可见，但虚拟列表要等 IM 订阅才渲染第一行 | `wait_chat` 改为等**第一行弹幕真的出现** |

### 4.2 交互与稳定性类

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 7 | 批量跑时"私信面板成片打不开"，人工点同一个页面却正常 | ① 页面 `visibilityState==hidden` 时点击**不送达渲染进程**；② 按钮**中心点被搜索框盖住** | ① `force_page_active`（`Page.setWebLifecycleState(active)` + `Emulation.setFocusEmulationEnabled`），实测 hidden→visible；② `entry` 增加命中测试 + 按钮矩形内 5×5 采样 |
| 8 | 页面里存在**被面板盖住的重复弹幕列表**，照坐标点会点到面板 | 与该平台"隐藏与可见两套 comment-list"同类 | 每行打 `on_top` 标记（`--only-on-top` 只留真能点到的行） |
| 9 | 用户点开主页"闪退" | 我方的收割脚本读完后**把标签关掉了**（默认值选错） | 默认**不关**标签（`--close-tabs` 才关），收割只读不打扰 |
| 10 | `import http.server` 报 `module 'selectors' has no attribute 'SelectSelector'` | 本地 `selectors.py` **顶掉了标准库同名模块** | 改名 `dyselectors.py`（文件头写明原因） |

### 4.3 合规与记账类

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 11 | 同一个人 10 分钟内被发了两条；每日上限从未生效 | 额度闸只认 `sent_confirmed`，而本通道最强证据是 `sent_dom_confirmed` | 改为按"**尝试过**"计（含人工发送 `manual_sent`）；漏判比误判贵 |
| 12 | 把平台拒绝当成发送成功 | "文案出现在面板里"分不清"已送达"与"被退回" | 先判拒绝文案（`给对方发送的消息已达上限` 等），再判成功 |

---

### 4.4 关键词链路专属（2026-09-20 补）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 13 | 接口响应体**永远抓到 0 条**，且**不报错** | `NetworkRecorder` 只是**注册回调**；Network 域没打开就一个事件都不来 | `probe.connect()` 顺手 `Network.enable`，`crawl` 内部再 `ensure_domains()` 兜底 |
| 14 | 明明登录着，却被判成「需要登录」，全链路中止 | 正文匹配 `扫码登录|登录后`；搜索页一条视频简介写着「一旦**退出登录后**…」就命中 | 改 **cookie 判据**：`Network.getCookies` 里有 `sessionid/sid_tt/sid_guard` = 已登录（这几个 cookie 都是 **HttpOnly**，`document.cookie` 读不到，必须走 CDP） |
| 15 | 正常页面被判成「出现验证码」，全链路中止 | 抖音在**每个页面**都预埋 `#captcha_container`（`position:fixed; z-index:111111; 1036x850`，**内容为空**） | 判据改为「可见**且里面有东西**」（≥2 字文字 / ≥200×100 的 iframe / canvas），另加 OOPIF frame URL 含 `verifycenter/captcha` |
| 16 | 滚轮滚了，评论一条都不多 | 老代码把滚轮固定在 `(900,500)`；新版视频页里**可见的** comment-list 在页面下方（实测 rect ≈ `72,745,673,677`） | 读可见容器真实 rect 打滚轮，再用 JS 把该容器及可滚动祖先的 `scrollTop` 拉到底；**不动 documentElement/body**（整页下滚会切到下一个视频，污染数据） |
| 17 | 同一条评论被收了两次（同一个人进队列两次） | 接口正文带表情「…谢谢了[握手][握手][握手]」，DOM 正文把表情丢了「…谢谢了」；按全文去重漏掉 | `dedupe_comments()` 改**前缀包含**判定，保留信息更全的那条（优先接口记录）。实测 280 → **257** |
| 18 | 采集途中账号被弹**真验证码** | 连续十几轮、固定 2 秒间隔的滚动（交接包 §2.11：固定间隔是最易识别的机器人特征） | 间隔改**对数正态随机**（`--scroll-pause` 可整体调慢）；撞到验证码**先把已抓到的落盘再停**（带 `stopped_reason=captcha`），不丢数据。证据见 `screenshots/04-真验证码证据-2026-09-19.png` |

> 第 18 条的证据链（不是靠猜）：容器里出现居中的 **380×348 iframe** → 该 iframe 是**真的 OOPIF**（`json/list` 里作为 iframe target 存在）→ 该区域**确实在画东西**（截图 288,894 字节；把容器设为 `display:none` 后同一区域只剩 3,487 字节的纯色）。

---

## 5. 验证结果

| 项 | 结果 | 证据 |
|---|---|---|
| 弹幕采集 | 120 秒 8 条，**标识完整率 100%** | evidence/02 |
| 私信发送 | **5/5 送达**（首次 3/5，2 个因按钮被搜索框盖住失败 → 修完重试成功） | evidence/03、02 截图 |
| 打字节奏 | 每字 0.1~0.9 秒随机；"你好"2 字实测 1.0~1.6 秒 | evidence/03 |
| 目标间隔 | 15.5 / 16.0 / 22.0 / 27.9 / 36.2 秒（对数正态 10~60 秒） | evidence/03 |
| 额度与去重 | 失败**不占额度**可安全重试；已发送者被 `quota_user_exceeded` 拦下，**未重复打扰** | evidence/03、07 |
| 离线回归 | `live_selftest.py`（含 node DOM shim 跑真实采集 JS）、`manual_selftest.py` 全过 | evidence/04 |
| 额度消耗 | 今日 28/100 人，本小时 5/40 | evidence/07 |

---

## 6. 未解决 / 边界 / 风险（请在审核时重点看）

1. **成功判据**：本通道抓不到平台响应码，最强证据是 `sent_dom_confirmed`（文案出现在会话面板）。
   与红线 2 原设想的 `confirm_signal=platform_response` 不一致 —— 需要产品侧确认计费口径。
2. **数据源依赖页面实现**：弹幕只在页面内存里，平台改版会让采集退回 DOM（0% 标识）。
   程序会在日志里**明确提示**，不会静默降级；但需要人工介入回填选择器。
3. **匿名化房间无解**：福袋/活动房的参与者在平台侧就是匿名的，拿不到人。
4. **账号风控**：未互关每人仅 1 条、每日 100 人、每小时 40 人；遇验证码即熔断交人工。
5. 官方通道（`enterprise.im` / 用户触达计划）门槛未变，仍不在本实现范围内。
