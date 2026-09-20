# docs(probe): 关键词链路的工作日志与真机证据（纯新增文件，不改任何既有文件）

> 目标分支：`rewrite/v4-agent` ｜ 来源分支：`docs/probe-worklog-keyword-chain`
> **本 PR 只新增 `probe/worklog/` 下的 8 个文件，不修改、不删除基线任何既有文件。**

---

## 1. 为什么只有证据、没有代码

这轮工作原本是要提交「关键词搜视频 → 评论采集 → 评论关键词筛选」这个功能。
提交后独立复核发现：**该功能的代码已经在 `rewrite/v4-agent` 的 `probe/` 里了**，而且比本地版本更完整 ——

| 能力 | 基线是否已有 |
|---|---|
| 关键词搜视频（`search_videos`，读 `general/search/single` 响应体） | ✅ 已有 |
| 评论采集（`comment/list` 响应体，`comments[].user.sec_uid`） | ✅ 已有 |
| 评论关键词四档语义（`MATCH_MODES`：phrase / seg / all / any） | ✅ 已有 |
| 评论去重（`dedupe_comments`） | ✅ 已有 |
| 额度闸按「尝试过」计数（`_attempted` / `ATTEMPTED_VERDICTS`） | ✅ 已有 |
| 平台拒绝文案判定（`DM_SEND_FAILED_TEXTS`） | ✅ 已有 |

基线还多了 `sidecar.py` / `send_gate.py` / `send_actions.py` / `url_policy.py` / `tests/` / `douyin_selectors.py` / `live.py`。

因此**代码部分不需要本 PR**；本 PR 只补上基线还没有的东西：**这条链路的真机证据、失败状态与踩坑记录**。
（原先那份会回退基线的 PR #3 已主动关闭并写明原因。）

---

## 2. 本 PR 新增的文件（8 个，全部新增）

```
probe/worklog/
  README.md                              工作日志正文（§2.5 关键词链路、§4.4 该链路专属问题）
  PR-BODY.md                             本文件
  evidence/08-screenshot-index.txt       截图索引（含每张图说明了什么）
  evidence/09-keyword-chain.txt          真机运行的真实输出（环境自检 + 搜视频 + 筛选参数 + 脱敏台账）
  evidence/10-push-attempt.txt           提交与开 PR 的完整经过，含一次「会回退基线」的误判复盘
  screenshots/04-真验证码证据-2026-09-19.png
  screenshots/05-关键词链路1-搜索页-按视频关键词搜视频.png
  screenshots/06-关键词链路2-视频页-评论区采集现场.png
```

---

## 3. 证据里有什么

### 3.1 原子链路（4 步）

| # | 步骤 | 实现 |
|---|---|---|
| 1 | 按视频**关键词**搜视频 | 导航搜索页 → **读平台接口响应体** `general/search/single`（`data[].aweme_info`）；DOM 瀑布流只做兜底 |
| 2 | 抓视频评论 | **读接口响应体** `comment/list`（`comments[].user.sec_uid` 直接可得）；DOM 采集兜底 |
| 3 | 按评论**关键词**筛评论 | 四档语义 `phrase` / `seg`（默认）/ `all` / `any`，**四档命中数一起打印** |
| 4 | 出私信队列 | 按 `sec_uid` 去重 + 点赞阈值 |

为什么读接口不读 DOM：

| 环节 | 接口 | DOM 的问题 |
|---|---|---|
| 搜视频 | `general/search/single` | 搜索卡片里**连 `<a>` 链接都没有**，标题被拆成一堆 span，日期/点赞混在 innerText 里 |
| 抓评论 | `comment/list` | DOM 能拿到 sec_uid，但接口字段更全（`cid` / `digg_count` / `reply_comment_total` / `ip_label`），且不受虚拟列表回收影响 |

> 记录器**锁死本次 `aweme_id`** —— 视频页会连带请求推荐视频的评论，不锁就会串味。

### 3.2 实测数字（2026-09-19 ~ 09-20，真实账号 · Chrome 153.0.8010.50）

| 项 | 结果 |
|---|---|
| 关键词搜视频 | 「宝宝辅食」**83 条**（10 个接口响应，`status_code` 非 0 的 0 个）；复跑 61 条 |
| 搜索翻页 | 滚轮驱动；冷门词（「codex会员」）20 多条时页面出现「暂时没有更多了」 |
| 抓评论 | 3 条视频共 **284 条**，`sec_uid` 完整率 **100%**；单条 505 评论的视频实抓 191 条 |
| 评论筛选 | 关键词「怎么做,为啥,请问,几个月」→ `seg` 命中 **11 条** |
| 四档对比（同一批 284 条） | `phrase` 11 / **`seg` 11** / `all` 0 / **`any` 77** |
| 私信队列 | **11 人**（按 sec_uid 去重） |

`any`（老 pipeline.js 语义：任意字命中）在 284 条里命中 77 条 —— **27% 的命中率里绝大部分是噪声**，
这正是把四档摆到台面上的理由。

### 3.3 该链路专属的踩坑（工作日志 §4.4，共 6 条）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 13 | 接口响应体**永远抓到 0 条**，且不报错 | `NetworkRecorder` 只是注册回调；Network 域没打开就一个事件都不来 | `connect()` 顺手 `Network.enable`，各模块再 `ensure_domains()` 兜底 |
| 14 | 明明登录着却判「需要登录」，全链路中止 | 正文匹配 `扫码登录|登录后`；搜索页一条视频简介写着「一旦**退出登录后**…」就命中 | 改 cookie 判据：`Network.getCookies` 里有 `sessionid/sid_tt/sid_guard`（均为 HttpOnly，`document.cookie` 读不到） |
| 15 | 正常页面被判「出现验证码」 | 抖音在**每个页面**预埋 `#captcha_container`（`position:fixed; z-index:111111; 1036x850`，**内容为空**） | 判据改为「可见**且里面有东西**」+ OOPIF frame URL 含 `verifycenter/captcha` |
| 16 | 滚轮滚了评论一条不多 | 滚轮固定在 `(900,500)`；新版视频页里可见的 comment-list 在页面下方（rect ≈ `72,745,673,677`） | 读可见容器真实 rect 打滚轮，再 JS 把容器及其可滚动祖先 `scrollTop` 拉到底；**不动 documentElement/body** |
| 17 | 同一条评论收两次 | 接口正文带表情「…谢谢了[握手]…」、DOM 正文丢表情；按全文去重漏掉 | `dedupe_comments()` 改**前缀包含**判定，保留信息更全者（实测 280 → 257） |
| 18 | 采集途中被弹**真验证码** | 连续十几轮、固定 2 秒间隔的滚动 | 间隔改**对数正态随机**；撞到验证码**先落盘再停**（`stopped_reason=captcha`），不丢数据 |

> 第 18 条的证据链：容器里出现居中的 **380×348 iframe** → 该 iframe 是**真的 OOPIF** →
> 该区域**确实在画东西**（截图 288,894 字节；把容器设为 `display:none` 后同一区域只剩 3,487 字节纯色）。

---

## 4. 脱敏说明

- 所有 `sec_uid` 只保留前 16 位 + 「…」，不可用于定位任何账号；
- 所有用户昵称替换为 `用户NN`；不含 Cookie / token / 凭据；
- **截图是页内替换昵称 + 模糊头像之后才截的**（搜索页替换 19 个作者名、糊 21 个头像；视频页替换 12 个昵称/42 处文本、糊 54 个头像）。

---

## 5. 请评审关注

1. **红线 3 在本通道上仍无法按原设计实现**：私信走 frontier IM 长连接，CDP Network 域抓不到发送请求
   （发送期间不限域名的 POST = 0 个、无带内容的 WS 发送帧），且最强判据 `sent_dom_confirmed` 会**误报**
   （实测有一条被判成功，会话原文其实写着「给对方发送的消息已达上限」）。证据见 `evidence/09`。
2. **采集类动作也消耗账号风险** —— 第 18 条就是实测被弹验证码；建议保持 `--scroll-pause` 不小于 2 秒。
3. `evidence/10-push-attempt.txt` 记录了一次**会回退基线的误提交**及其复盘：提交前必须先对齐远端基线。