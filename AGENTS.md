# 开发说明（AGENTS.md）

## 项目定位

本地 Windows 抖音线索采集与评论分发工作台。UI 由 `reply_server/server.js` 提供，入口页面 `reply_server/select.html`。
驱动方式为 Chrome 远程调试（CDP，默认端口 9222），无 npm 第三方依赖。

## 开发约定

- 运行时数据只放在包目录的 JSON 文件中；不要提交/分享账号数据、登录态（dy-main）、二维码、Cookie、历史评论与回复记录。
- 路径必须通过 `REPLY_WORKSPACE` 或 `path.join` 解析，不要写死开发机绝对路径。
- 修改后至少执行 `node --check`，并用 `http://127.0.0.1:8090/` 验证页面与 API。
- 抓取必须使用本人或明确授权的账号与页面；不要增加绕过验证码/风控/登录限制的逻辑。
- 回复分发必须保留人工确认，不要把队列改成无确认批量自动发送。

## 常用命令

```powershell
node --check .\pipeline.js
node --check .\reply_worker.js
node --check .\reply_server\server.js
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

## 关键模块

- `reply_server/server.js`：本地 API、队列、主题登记、静态页面、子进程编排
- `pipeline.js`：搜索视频（分词匹配）→ 多标签并行爬评论 → 关键词筛选 → 合并去重；支持暂停/验证码等待
- `scan_comments.js`：对已有视频集合增量扫描评论
- `reply_worker.js`：处理已人工确认的评论回复队列（串行、逐条；含标签页存活检查、导航重试、编辑器激活兜底、可见评论列表定位）
- `live_dom_collector.js`：读取已打开直播页可见 DOM 弹幕
- `live_dm_worker.js`：私信准备（开主页 → 点私信 → 预填文案 → 等待人工发送）
- `comment_worker.js`：给视频发新评论（实验性，未接入界面）
- `browser_session.js`：浏览器会话检测与二维码

## 重要实现细节（踩过的坑）

1. 搜索页在长期复用的标签里会退化（加载不出结果），必须用**新标签页**搜索。
2. 抖音会把 `/video/<id>` 重定向到 `/jingxuan?modal_id=...`；图文帖是 `/note/<id>` 布局。
3. 页面上可能同时存在**隐藏和可见两个 comment-list**：只能用可见的那个（隐藏的里面按钮尺寸为 0）。
4. 评论区需等到**真正可见**（容器 display 由 none 变可见）才能操作按钮；图文帖需点击 `[data-e2e=feed-comment-icon]` 展开。
5. `scrollIntoView` 之后虚拟列表会重渲染，必须**延迟再读**按钮坐标，否则拿到 0×0。
6. 回复发送以 Enter 为主路径，并以 `comment/publish` 的响应体 `status_code:0` 作为成功判据；空响应视为风控拒绝，不得标记成功。
