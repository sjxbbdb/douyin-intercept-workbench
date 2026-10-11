# 给别人用的上手说明

> 这份文档面向"拿到这份代码的另一个人"。三步走完就能跑。
> 先说清楚它**不能**做什么，免得白装：**它不会替你发评论、发私信、点任何按钮。**
> BP0 只有 4 个只读工具（看台账、看额度、看线索、查归因）。

## 一、你需要准备什么

| 需要 | 版本/说明 |
| --- | --- |
| Node | **≥ 22.13**（只读台账用 Node 内置 `node:sqlite`；22.x 会打印一条 ExperimentalWarning，功能正常） |
| Python | **3.12 / 3.13**，纯标准库，不需要 pip install 任何东西 |
| 一个**你自己的、已登录的** Chrome | 本工具**不代办登录**，也用不了别人的登录态 |
| 一个状态目录 | 台账放在这里。不同的人用不同目录 = 天然隔离 |

**一个账号一个进程**：账号作用域由 Chrome profile 路径推导。两个人共用同一个 profile，就等于共用同一个账号。

## 二、三步

### 第 1 步：拿到代码

    git clone <仓库地址> && cd <仓库目录>

### 第 2 步：写配置 + 跑自检

复制示例配置，改成你自己的路径：

    cp agent/agent.config.example.json agent/agent.config.json
    # 编辑 agent/agent.config.json

然后跑自检（**只读：不启动浏览器、不登录、不发送任何内容**）：

    node agent/bin/agent-doctor.js --config agent/agent.config.json

它会逐项告诉你缺什么，并为每一项给出"怎么办"。全通过时会直接打印一段**可以粘贴的 MCP 客户端配置**。

想连浏览器一并检查登录状态（仍然是只读）：

    node agent/bin/agent-doctor.js --config agent/agent.config.json --probe-browser

> 有验证码时自检会判为**不可用**并提示人工处理 —— 本工具**绝不绕过验证码**。

### 第 3 步：接进你的客户端

把自检打印出来的那段 JSON 粘进客户端的 MCP 配置即可，形状是：

    {
      "mcpServers": {
        "douyin-agent-tools": {
          "command": "node",
          "args": ["<绝对路径>/agent/bin/agent-tools.js",
                   "--state-dir", "<你的状态目录>",
                   "--profile-dir", "<你的 Chrome 用户目录>",
                   "--port", "9222"]
        }
      }
    }

⚠️ **未验证边界**：协议只在 stdio 层用自制客户端验证过（`initialize` / `tools/list` / `tools/call`），
**还没接过真实的第三方 MCP 客户端**。"在 Claude Desktop / Cursor 里能不能跑"目前是 **unknown**。

## 三、自检报错对照表

| 报的项 | 什么意思 | 怎么办 |
| --- | --- | --- |
| `node_version` | Node 太老 | 升到 ≥ 22.13 |
| `node_sqlite` | 当前 Node 没有 node:sqlite | 同上（本工具不引第三方依赖，所以不装 sqlite 驱动） |
| `python` | 找不到 Python | 装 3.12/3.13，或用 `--python <路径>` |
| `sidecar_script` | 找不到 `probe/sidecar.py` | `--probe-dir` 指向仓库里的 `probe/` |
| `state_dir` | 状态目录不存在 | 先跑一次 sidecar 让它建台账，或指向已有目录 |
| `agent_state_dir` | 目录不可写 | `--agent-state-dir <一个可写目录>` |
| `sidecar_capabilities` | sidecar 起不来 | 照它给的那行命令手工跑一遍看原始报错 |
| `browser_login` | 浏览器没连上 / 没登录 / 有验证码 | 启动专用 Chrome 并把它放到前台保持可见；人工登录；人工过验证码 |

## 四、红线（这些不是可选项）

- **不发消息**：BP0 的工具表里没有发送能力，越权面为零。
- **不绕验证码**：命中验证码一律停机转人工。
- **隐私**：只出加盐哈希与计数，不出 `sec_uid`、昵称、头像、评论原文。
- **审计**：每次工具调用都落一行审计；写不进审计，调用就失败。
- **未知即未知**：读不到就报 `unknown`，绝不猜；`unknown` 一律不允许自动重试。

## 五、今天还没有的

- **分发方式**：代码目前只在开发者的本地分支上，还没有推送/打包；这一步没做之前，别人**拿不到**。
- **开箱即用**：现在需要使用者自己装 Node 与 Python。面向非技术用户的一键包应该走桌面端（那里已经把 sidecar 打成一个可执行文件），不在本工具的范围内。
- **真实客户端联调**：见上面的 unknown。
- **审批闭环与任何发送能力**：属于 BP1 及以后，当前版本故意没有。
