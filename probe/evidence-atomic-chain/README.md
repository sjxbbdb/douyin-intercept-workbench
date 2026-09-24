# evidence-atomic-chain —— 原子链路证据目录

本目录存放「视频搜索 → 评论采集 → 严格筛选 → 评论回复 → 私信触达」链路的**真机验证证据**与**方法沉淀**。

## 文件

| 文件 | 说明 |
|---|---|
| WORKLOG.md | 工作日志：环境、14 条问题→原因→修复、验证结果 |
| board.html | 证据图生成源（HTML，经 CDP 截图产出下列 PNG） |
| 01..05-*.png | 脱敏证据图（2 倍分辨率） |
| reference/ | Node/CDP 参考实现，**仅用于复现证据，未接入 sidecar** |

## 与 sidecar 的关系

`reference/` 与 `probe/*.py` 是**两套并列实现**，本目录不代表 sidecar 已具备这些能力。
接入步骤见 `probe/PR-BODY-ATOMIC-CHAIN.md` §4；未验证边界见 `probe/EVIDENCE-ATOMIC-CHAIN.md` §6。

## 复现

    1) 用 Chrome 打开 board.html（或经 CDP 载入）
    2) Page.captureScreenshot（deviceScaleFactor=2，裁剪到内容高度）
    3) 参考实现运行见 reference/README.md

## 脱敏

所有图形与文本均不含昵称、sec_uid、cid、Cookie、token、会话原文。
