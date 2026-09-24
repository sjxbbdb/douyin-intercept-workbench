# PR：原子链路真机证据与方法沉淀（视频搜索 → 评论采集 → 严格筛选 → 评论回复 → 私信触达）

> 目标分支：`main`　来源分支：`feat/atomic-chain-evidence`
> 类型：**文档 + 脱敏证据 + 参考实现**（不改动 `server/`、`desktop/`、`probe/*.py` 运行时）

---

## 1. 功能（本次提交解决什么）

沉淀一套**已在真实账号与真实页面验证过**的抖音网页端原子链路方法，供 sidecar 后续接入时直接复用，避免重复踩坑。

| 环节 | 沉淀内容 |
|---|---|
| 视频搜索 | 新标签页搜索、分词 + 顺序无关匹配（整串匹配会把结果全过滤成 0） |
| 评论采集 | 拦 `Network.responseReceived` 取结构化数据（含 sec_uid），不抓 DOM |
| 评论筛选 | 三种匹配模式对比，推荐 `phrase`（字面包含）；入队前做断言 |
| 评论回复 | **原子定位**（定位+滚入+点击+检测同一次求值）、回车发送、以 publish status_code:0 为唯一判据 |
| 私信触达 | 输入框只在 im-dialog 内查找、回车发送、双重校验、**私密账号直接跳过** |
| 稳定性 | 防重复入队硬校验、失败状态分类、节奏与限流实测结论 |

---

## 2. 新增文件

    probe/EVIDENCE-ATOMIC-CHAIN.md              真机证据（账号资格/环境/能力矩阵/失败状态/未验证边界/发行开关）
    probe/PR-BODY-ATOMIC-CHAIN.md               本文件
    probe/COMMIT-MESSAGE-ATOMIC-CHAIN.txt       提交信息
    probe/evidence-atomic-chain/README.md       证据目录说明
    probe/evidence-atomic-chain/WORKLOG.md      工作日志（环境/问题/修复/验证）
    probe/evidence-atomic-chain/board.html      证据图生成源（可复现）
    probe/evidence-atomic-chain/01..05-*.png    5 张脱敏证据图
    probe/evidence-atomic-chain/reference/      Node/CDP 参考实现（仅证据用途）

**未改动**：`server/`、`desktop/`、`probe/*.py`、CI 配置。

---

## 3. 依赖

- 本次提交**不引入任何新依赖**：文档为 Markdown，证据图为 PNG，参考实现为零第三方依赖的 Node 脚本；
- 不影响 `npm ci --prefix server` / `npm ci --prefix desktop`；不影响 probe 的 Python 单元测试发现路径（`probe/tests/test_*.py`）。

---

## 4. 接入方式

**本 PR 不接线**。参考实现与 `probe/*.py` 是两套并列实现，接入需按下列步骤另行提交：

1. 把「定位三原则」「文本匹配三坑」「原子定位」落到 `probe/click_guard.py`、`probe/douyin_selectors.py`、`probe/send_actions.py`；
2. 把「严格筛选模式」落到 `probe/crawl.py` / `probe/search_pool.py` 的评论过滤入口；
3. 把「私密账号识别」「面板可见性」落到 `probe/dm.py`，失败状态写进现有台账；
4. 保持 sidecar 既有安全默认：发送默认关闭，`--allow-send` + 二次确认，验证码熔断，空响应熔断，幂等键 fsync。

---

## 5. 测试结果

### 5.1 已执行（真实账号 + 真实页面）

| 用例 | 结果 |
|---|---|
| 关键词搜视频 | 单关键词合并去重 154–179 个视频卡片 |
| 评论区采集 | 12 个视频 / 1165 条评论，sec_uid 齐全 |
| 严格筛选断言 | phrase 模式：1165 → 字面命中 9 条，入队后复核 **0 条不符** |
| 评论回复发送 | 慢速（45–80 秒）下**连续 5 条全部成功**（posts captured: 1 + status_code:0） |
| 私信发送 | 单批 9 条：**6 条成功**、2 条私密账号跳过、1 条面板未展开失败 |
| 私密账号识别 | 打开主页阶段命中 2 条并跳过，未点私信 |
| 防重复入队 | 同 cid 二次入队被拒 |

### 5.2 失败状态抽样（如实记录）

- `comment_not_rendered`：接口有、网页版不渲染（已删/折叠）→ 跳过，不重试；
- `reply POST not captured`：节奏过快导致平台静默拦截 → 放慢后同批全部成功；
- `私信输入框未出现`：标签页被判不可见 → 如实记失败并附原因。

### 5.3 未执行（不得视为通过）

- 未在 `server/` / `desktop/` / sidecar 上接线，**未跑仓库级 `npm run check` / `npm test` 的接入用例**；
- 未在企业号、官方开放 API、多账号并行下验证；
- 未验证独立 Chrome 实例启动参数对面板可见性的改善。

> 本 PR 只声明「方法经真机验证」，**不声明**「仓库已具备该能力」。

---

## 6. 与仓库契约的一致性

- 红线 1（不绕过验证码/风控/权限）：全程未绕过，遇限制即停并如实记录；
- 红线 3（不把 DOM 表象当成功）：发送以平台响应码或对话区实况为判据；
- 红线 6（自动发送默认关闭）：本 PR 未启用任何发送能力，并给出发行开关条件；
- 工程边界：未引用 `archive/v3/`，未改动运行时目录结构。
