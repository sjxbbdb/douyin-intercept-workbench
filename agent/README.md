# agent/ —— 抖音截流 Agent 工具服务（形态 A）

> **第一次拿到这份代码？先看 [USER-GUIDE.md](USER-GUIDE.md)**（三步上手 + 报错对照表）。
> 只想确认环境行不行：`node agent/bin/agent-doctor.js --config agent/agent.config.json`

零第三方依赖的 stdio 工具服务（JSON-RPC 2.0，方法名与 MCP 对齐：`initialize` / `tools/list` / `tools/call`）。
契约见 `docs/agent-tools.md`（**BP0 阶段的唯一实现依据**）。

## 三条不可违背

1. **Agent 永不直接发送。** BP0 的工具表里**只有 4 个只读工具**，连发送方法都调不到。
2. **状态落盘，不入对话历史。** 每次工具调用都追加一行审计，写不进审计就让调用失败（`unknown/audit_unavailable`）。
3. **读不到就报 unknown，不猜。** 台账缺失、sqlite 打不开、字段形状不对，一律 `unknown/state_unavailable`。

## 跑起来

    node bin/agent-tools.js --state-dir <probe 状态目录> --profile-dir <Chrome 用户目录> --port <CDP 端口>

可选：`--python <解释器>`（默认 `python`）、`--probe-dir <probe 目录>`（默认从本仓库定位）、`--agent-state-dir <目录>`（默认 `<state-dir>/agent`）。

也支持环境变量：`DOUYIN_AGENT_STATE_DIR` / `DOUYIN_AGENT_PROFILE_DIR` / `DOUYIN_AGENT_PORT` / `DOUYIN_AGENT_PYTHON` / `DOUYIN_AGENT_STATE_ROOT`。

## 接到一个 MCP 客户端

服务本身是 stdio JSON-RPC，任何人只要在客户端配置里指向这个入口即可：

    {
      "mcpServers": {
        "douyin-agent-tools": {
          "command": "node",
          "args": [
            "<仓库路径>/agent/bin/agent-tools.js",
            "--state-dir", "<probe 状态目录>",
            "--profile-dir", "<Chrome 用户目录>",
            "--port", "9222"
          ]
        }
      }
    }

⚠️ **未验证边界**：只在 stdio 层用自制客户端验证过协议（`initialize` / `tools/list` / `tools/call`），
**还没有接过任何真实的第三方 MCP 客户端**（Claude Desktop / Cursor 等）。版本协商按规范实现
（客户端报的版本在支持集合里就回同一个），但"在真实客户端里能不能跑"目前是 **unknown**。

## 别人要用它，需要什么

| 需要 | 说明 |
| --- | --- |
| Node ≥ 22.13 | 只读台账用了内置 `node:sqlite`（22.x 会打印一条 ExperimentalWarning，功能正常） |
| Python 3.12 / 3.13 | 真正的执行器是 `probe/sidecar.py`，纯标准库 |
| **自己的、已登录的** Chrome | 本工具不代办登录；用它自己的账号 + 自己的 profile，绝不共用别人的登录态 |
| 一个 probe 状态目录 | 台账就在这里；不同的人用不同目录 = 天然隔离 |

**一个账号一个进程**：`account_scope` 由 profile 路径推导，两个人共用同一个 profile 就等于共用同一个账号作用域。

## 工具（BP0 恰好 4 个，全部只读）

| 工具 | 作用 |
| --- | --- |
| `get_account_health` | 唯一"能否干活"的依据：额度、熔断迹象、浏览器/登录（仅在显式要求时才连浏览器） |
| `query_leads` | 查线索（**只回哈希后的标识，绝不回 sec_uid / 昵称 / 原文**） |
| `get_stats` | 台账统计（`sent_confirmed` 只来自**落库原始状态**） |
| `explain_failure` | 归因；`unknown` 一律 `nextAction: "none"` |

## 线索从哪里来

`query_leads` 只读 Agent 自己的线索库（`<agent-state-dir>/accounts/<scope>/leads.jsonl`）。
线索由**独立脚本**从现有台账投影而来，不是工具：

    node bin/import-leads.js --state-dir <...> --profile-dir <...> --port <...>

导入时对作者标识做**加盐哈希**（盐存 `<agent-state-dir>/accounts/<scope>/salt`），只落哈希与计数，不落原文。
