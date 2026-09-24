# reference —— Node/CDP 参考实现（仅证据用途）

> ⚠️ **这不是 sidecar 代码，不要直接 require/引用。**
> 它与 `probe/*.py` 是两套并列实现，放进本目录只为**复现证据图与实验方法**。
> 未接入 `desktop/`、`server/`；不含任何运行数据（队列、历史、线索均为空）。

## 文件

| 文件 | 作用 |
|---|---|
| pipeline.js | 搜视频 → 拦网络响应抓评论 → 严格筛选（char/segment/phrase）→ 自动入队 |
| reply_worker.js | 评论回复：原子定位 + 回车发送 + publish status_code:0 校验 |
| dm_run.js | 私信调度：建任务、起 worker、日志落盘、单次上限与间隔可配 |
| live_dm_worker.js | 单条私信：主页 → 私密账号识别 → 私信面板 → 换行发送 → 双重校验 |

## 运行前提

- Node.js 20+（实测 v22）
- 已手动登录抖音的 Chrome，开启 `--remote-debugging-port=9222`
- 零第三方依赖（仅内置模块 + WebSocket）

## 安全默认（与仓库红线一致）

- 不逆向签名、不导出 Cookie、不抓包重放；
- 不绕过验证码/滑块/风控，遇限制即停；
- 每条发送都有可验证判据，无证据不得标记成功；
- 节奏可配（建议 REPLY_GAP_MIN_MS=45000、REPLY_MAX_PER_RUN=5）。

## 运行

    node pipeline.js          # 抓取与筛选（配置见 probe/evidence-atomic-chain/REFERENCE-CONFIG.md）
    node reply_worker.js      # 评论回复
    node dm_run.js            # 私信
