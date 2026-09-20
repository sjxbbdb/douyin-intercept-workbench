'use strict'
// scripts/build-handover.js
//
// 生成"开发交接包"：把某个**提交状态的仓库**打成一个可直接交给下一位
// 开发者/智能体的目录 + zip。
//
// ⚠️ 为什么做成脚本而不是手工拷：
//    手工拷的包**一定会过期**——代码在动，包不动，而包里的说明还在
//    声称"当前是 P0 骨架"。上一位接手人如果照着过期的骨架说明去写，
//    会去重写已经存在的东西。让"生成包"变成一个命令，
//    才能保证包里的说明与包里的代码是同一时刻的。
//
// ⚠️ 这个包**不是给商家的发行包**，是给开发者/智能体的交接包：
//    它包含文档、契约、方案、源码、测试与验证脚本。
//    商家发行包（只含运行所需 + 启动脚本）另行处理。
//
// 用法：
//   node scripts/build-handover.js                 # 生成到 delivery/ 与仓库同级
//   node scripts/build-handover.js --no-zip        # 只生成目录
//   node scripts/build-handover.js --out D:\somewhere

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const PKG_NAME = '抖音截流自动回复Agent-开发交接包'

/** 交付包内**不包含**的东西：不是遗漏，是刻意的。 */
const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'delivery',        // 自己不能装自己
  'instances',       // 商家运行数据（含专用 Chrome 的登录 Cookie）
  'data',            // 服务端库与台账（含全部商家账号）
  'backups',
  '.vscode', '.idea',
])

/** 按文件名排除：运行产物与敏感文件。 */
const EXCLUDE_FILE_PATTERNS = [
  /\.db$/, /\.db-wal$/, /\.db-shm$/, /\.sqlite3?$/,
  /^master\.key$/, /^ui-token\.txt$/, /^client-config\.json$/,
  /^browser-host\.lock$/, /^instances\.json$/,
  /^queue\.json$/, /^pending-sends\.json$/, /^send-outbox\.json$/,
  /^report-quarantine\.json$/, /^runtime-state\.json$/,
  /^license-state\.json$/, /^replied-history\.json$/, /^leads\.json$/,
  /^audit-log.*\.jsonl$/, /^client-log\.jsonl$/,
  /^\.env(\..*)?$/, /^secrets.*\.json$/, /^credentials.*\.json$/,
  /\.tmp-\d+$/,
]

function shouldSkip(relPath, name) {
  const parts = relPath.split(path.sep)
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true
  return EXCLUDE_FILE_PATTERNS.some((re) => re.test(name))
}

function copyTree(srcDir, dstDir, stats) {
  fs.mkdirSync(dstDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name)
    const dst = path.join(dstDir, entry.name)
    const rel = path.relative(ROOT, src)
    if (shouldSkip(rel, entry.name)) { stats.skipped.push(rel); continue }

    if (entry.isDirectory()) {
      copyTree(src, dst, stats)
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
      stats.files += 1
      stats.bytes += fs.statSync(src).size
    } else {
      // 符号链接/设备文件：不复制，但**必须留痕**（不静默跳过）
      stats.skipped.push(`${rel}（非常规文件，已跳过）`)
    }
  }
}

/**
 * 把仓库里的文件/目录按角色分发到交付包。
 *
 * ⚠️⚠️ **可执行的东西必须在包根目录，文档才进编号目录。**
 *     这条规则是实测逼出来的：最初把所有内容都放进
 *     `01-先读这些/`…`07-测试与验证/` 这样的编号目录，结果包**解压后
 *     跑不起来** —— `node test/run.js` 找不到 `test/`，因为它在
 *     `07-测试与验证/test/`。而 `README-DEV.md` 里写的验证命令正是
 *     `node test/run.js`。接手人第一件事就是跑它，一跑就失败，
 *     然后会开始怀疑整个包是不是坏的。
 *
 *     所以布局分成两类：
 *       · **包根**：package.json / test/ / scripts/ / client/ / license-server/
 *         / shared/ —— 这些必须保持仓库里的相对位置，命令才跑得起来。
 *       · **编号目录**：只放文档（需求、契约、方案、须知）。
 *         它们不参与执行，编号是为了给人一个阅读顺序。
 *
 *     编号目录里的文档如果提到了路径（例如"见 shared/protocol.md"），
 *     指向的是**包根**的那份 —— 因为包根确实有 shared/。
 */
function layOut(srcSnapshotRoot, pkgRoot, stats) {
  /**
   * ⚠️⚠️ **根目录清单由 require 路径决定，不由"好不好看"决定。**
   *
   *     这一条是被实测连着教育了三次才定下来的：
   *       ① 把 `test/` 放进 `07-测试与验证/` → `node test/run.js` 找不到；
   *       ② 把 `client/` `license-server/` 放进 `源码/` →
   *          测试里的 `require('../../client/host/store')` 全部失败；
   *       ③ 把 `shared/` 也挪进去 → 同上。
   *
   *     这些相对路径在仓库里是对的（`test/unit` 往上两级就是仓库根），
   *     一旦改变了目标目录的**深度**，它们就全断。而"改几百个测试文件的
   *     相对路径"是绝不该做的事 —— 那会让包里的代码与仓库里的代码不一致，
   *     接手人改完还要再改回去。
   *
   *     所以：**凡是代码（含测试）引用到的目录，必须保持仓库里的位置**。
   *     只有纯文档可以挪进编号目录（没有任何代码 require 一篇 .md）。
   */
  const rootItems = [
    'package.json', 'test', 'scripts',
    'client', 'license-server', 'shared',
    '.gitignore', '.gitattributes',
  ]
  /**
   * ⚠️ `legacy/` 进包但**单独放**，目录名叫 `旧代码-只读参考`。
   *
   *    曾经把它排除过，理由是"旧代码不该被生产代码 require"。
   *    但那个理由只对了一半：`docs/可复用资产审计.md` 与
   *    `shared/已知陷阱与平台知识.md` 都明确写着 legacy 里的抖音 DOM 知识
   *    （隐藏/可见两套 comment-list、scrollIntoView 后必须延迟读坐标、
   *    Enter 才是提交主路径…）是**无法凭空复现**的，是每次真机试错
   *    （消耗真实账号风险）换来的。
   *
   *    排除它，接手人做 P2/P3 的 DOM 工作时就失去了唯一参考 —— 而
   *    `scripts/verify-handover.js` 会直接把这件事标成问题。
   *    改名字是为了让人一眼看出它**不参与执行**。
   */
  const legacyDir = 'legacy'
  const docItems = [
    // [包内子目录, [{ 源, 是否摊平 }]]
    ['01-先读这些', [{ src: 'README-DEV.md' }, { src: 'AGENTS.md' }, { src: 'README.md' }]],
    ['02-定位与需求', [
      { src: 'docs/项目章程.md' },
      { src: 'docs/平台需求规格.md' },
      { src: 'docs/抖音截流需求规格.md' },
    ]],
    ['03-架构与运维', [
      { src: 'docs/架构说明.md' },
      { src: 'docs/部署指南-服务端.md' },
      { src: 'docs/合作方须知.html' },
      { src: 'docs/抖音自动回复助手-合作方须知.pdf' },
      { src: 'docs/可复用资产审计.md' },
    ]],
    ['04-契约规范与平台知识', [
      { src: 'shared/protocol.md' }, { src: 'shared/术语与选型基准.md' },
      { src: 'shared/开发规范.md' }, { src: 'shared/安全与合规要求.md' },
      { src: 'shared/已知陷阱与平台知识.md' }, { src: 'shared/测试策略.md' },
      { src: 'shared/AI协作开发指引.md' },
    ]],
    ['05-平台机制与迁移', [{ src: 'plans', flatten: true }]],
  ]

  for (const item of rootItems) {
    const src = path.join(srcSnapshotRoot, item)
    if (!fs.existsSync(src)) { stats.skipped.push(`缺失：${item}`); continue }
    const dst = path.join(pkgRoot, path.basename(item))
    if (fs.statSync(src).isDirectory()) copyTree(src, dst, stats)
    else {
      fs.copyFileSync(src, dst)
      stats.files += 1
      stats.bytes += fs.statSync(src).size
    }
  }


  // 旧代码：进包但目录名明确标注"只读参考"
  {
    const s = path.join(srcSnapshotRoot, legacyDir)
    if (fs.existsSync(s)) copyTree(s, path.join(pkgRoot, '旧代码-只读参考'), stats)
    else stats.skipped.push(`缺失：${legacyDir}`)
  }

  for (const [sub, items] of docItems) {
    for (const item of items) {
      const src = path.join(srcSnapshotRoot, item.src)
      if (!fs.existsSync(src)) { stats.skipped.push(`缺失：${item.src}`); continue }
      if (fs.statSync(src).isDirectory()) {
        copyTree(src, path.join(pkgRoot, sub), stats)
      } else {
        const dst = path.join(pkgRoot, sub, path.basename(item.src))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        stats.files += 1
        stats.bytes += fs.statSync(src).size
      }
    }
  }
}

function gitInfo() {
  const run = (args) => {
    try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() } catch (e) {
      return `(取不到：${e.message})`
    }
  }
  return {
    commit: run(['rev-parse', 'HEAD']),
    short: run(['rev-parse', '--short', 'HEAD']),
    subject: run(['log', '-1', '--pretty=%s']),
    date: run(['log', '-1', '--pretty=%ci']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    commits: run(['rev-list', '--count', 'HEAD']),
  }
}

function countLoc(dir, exts, out = { files: 0, lines: 0 }) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { countLoc(p, exts, out); continue }
    if (!exts.some((x) => e.name.endsWith(x))) continue
    out.files += 1
    out.lines += fs.readFileSync(p, 'utf8').split('\n').length
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const noZip = args.includes('--no-zip')
  const outIdx = args.indexOf('--out')
  const outRoot = outIdx >= 0 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.join(ROOT, 'delivery')

  const pkgRoot = path.join(outRoot, PKG_NAME)
  fs.rmSync(pkgRoot, { recursive: true, force: true })
  fs.mkdirSync(pkgRoot, { recursive: true })

  const git = gitInfo()
  const stats = { files: 0, bytes: 0, skipped: [] }

  layOut(ROOT, pkgRoot, stats)

  // ── 统计（写进说明，让接手人一眼知道规模）────────────────
  const src = countLoc(path.join(pkgRoot, 'license-server'), ['.js', '.sql'])
  const cli = countLoc(path.join(pkgRoot, 'client'), ['.js', '.html', '.css', '.cmd'])
  const tst = countLoc(path.join(pkgRoot, 'test'), ['.js'])
  const doc = countLoc(pkgRoot, ['.md', '.html'])

  const readme = `# 开发交接包 · 先读我

> **这是给开发者 / 编码智能体的交接包，不是给商家的发行包。**
> 生成时间：${new Date().toISOString()}
> 对应提交：\`${git.short}\`（${git.branch} 分支，历史共 ${git.commits} 个提交）
> 提交时间：${git.date}
> 提交说明：${git.subject}

---

## 一、这个项目是什么（先读，否则会误判方向）

> ### 一个可承载多种「专业分化工作流」的 Agent 平台。
>
> 每个专业领域（本地生活、家居、教育、房产、医美…）是**一个工作流包**：
> 它声明该领域的**线索判据、业务规则、话术策略、合规边界、成功定义**，由 **Agent 编排执行**。
> **「抖音截流自动回复」是内置的第一个工作流包，不是产品的全部。**

| 要点 | 说明 |
|---|---|
| **Agent 是承载形态** | 默认开启。关闭后退化为图形界面的工具链路（**降级路径**） |
| **行业知识由包声明** | 加一个新领域 = 加一个包，**核心代码零改动** |
| **包是声明式的** | 包内出现 \`.js\`、或声明任何安全数值键名 → **拒绝加载**。包来源不可信是前提 |
| **硬规则不交给模型** | 观察期禁发、日上限、最小间隔必须是代码里的 \`if\`，在状态图固定位置、不可跳过 |

> ⚠️ **本项目不是"抖音自动回复工具"。** 若按工具方向开发，
> 会把行业知识硬编码进核心，最终每加一个领域都要改核心——
> 那就不是平台了。请先读 \`02-定位与需求/项目章程.md\`。

---

## 二、包里有什么

| 目录 | 内容 |
|---|---|
| \`01-先读这些\` | **先读这个**：开发总索引（README-DEV）、三条红线（AGENTS.md）、面向商家的说明 |
| \`02-定位与需求\` | **项目章程（定位锚点）**、平台需求规格（①机制层验收依据）、抖音截流需求规格（②业务层） |
| \`03-架构与运维\` | 架构说明（三层骨架 + 降级路径）、服务端部署指南、合作方须知、legacy 资产审计 |
| \`04-契约规范与平台知识\` | **双端接口契约**（protocol.md）、术语与选型基准（含依赖白名单与前端硬约束）、开发规范、安全合规、抖音 DOM 知识、测试策略、AI 协作开发指引 |
| \`05-平台机制与迁移\` | ADR-001（定位修正与框架选型）、**工作流包契约**、迁移与验收、Agent 开发指导、工具粒度设计、评估与成本 |
| \`client/\` \`license-server/\` \`shared/\` \`test/\` \`scripts/\` | **全部源码**（在包根，因为 require 路径决定它们必须在这里） |
| \`旧代码-只读参考/\` | 原半成品源码。**唯一**记录着用真账号试错换来的平台 DOM 知识，不得被生产代码 require |

**规模**：服务端 ${src.files} 个文件 / ${src.lines} 行（含 SQL 迁移），
客户端 ${cli.files} 个文件 / ${cli.lines} 行，测试 ${tst.files} 个文件 / ${tst.lines} 行，
文档 ${doc.files} 个 / ${doc.lines} 行。

> ⚠️ **\`client/\` \`license-server/\` \`shared/\` \`test/\` \`scripts/\` 为什么在包根而不在编号目录里？**
> 因为**它们被代码 require**。这些相对路径（如测试里的
> \`require('../../client/host/store')\`）在仓库里是对的，一旦改变目标目录的**深度**就全断。
> 只有纯文档可以进编号目录（没有任何代码 require 一篇 .md）。
> —— 这条规则是被实测连着教育了三次才定下来的。

---

## 三、⚠️ 现在完成到什么程度（**别跳过这一节**）

**已完成**：授权中心（登录/心跳/计费/审计/策略/卡密/管理 CLI/管理后台）、
客户端（本地控制台、CDP 层、三条发送链路、安全护栏）、双端共享契约与看板口径、
**厂商管理后台**、**交接包生成与终检**。

**代码完成但未真机验证**：所有涉及平台页面操作的能力（采集、回复评论、回复弹幕、发私信）。

**尚未开始**（依 \`05-平台机制与迁移/D-重构迁移与验收.md\` 的 P11–P15）：
\`client/understanding/\`（**意图理解——"专业"的核心**）、\`client/agent/\`（Agent 运行时）、
\`client/tools/\`（工具层）、\`action_kind\` 计费契约扩展、业务规则配置页。

> ⚠️ 按 \`01-先读这些/AGENTS.md\` §6 的完成定义，
> **未在真实账号上验证过之前不得声明完成。**
> 汇报时请明确区分"已真机验证"与"仅代码完成"。

真机上的风险按严重程度排序：

1. **能否稳定嗅探到三个平台响应体**（\`comment/publish\`、\`live/comment/send\`、\`im/send\`）
   —— 这是**计费的唯一依据**，抓不到就一条都不计费。
2. **选择器是否还有效** —— \`client/platform/selectors.js\` 里全部
   \`liveVerifiedAt: null\`。
3. **专用 Chrome 的登录态能否被复用**，会不会被判成自动化浏览器。

---

## 四、怎么跑起来验证

\`\`\`bash
# 1) 环境：Node.js >= 22.5（服务端用到 22.5 引入的 node:sqlite）
node -v

# 2) 依赖：ws + @langchain/langgraph + zod。若目录里没有 node_modules：
npm install --omit=dev

# 3) 一次性跑完全部自动化验证
node test/run.js                    # L1 单元 / L2 契约 / L3 离线 DOM / L4 集成
node scripts/smoke-server.js        # 服务端冒烟（真实 HTTP + 真实签名）
node scripts/boot-client-smoke.js   # 客户端启动冒烟（装配 + 控制台 + 安全门）
node scripts/ui-check.js            # 界面结构与接口契约
node scripts/ui-render-check.js     # 无头浏览器真实渲染
node scripts/verify-handover.js     # 交付终检
\`\`\`

> ⚠️ **不要**用 \`node test/run.js\` 之外的方式零散跑测试——
> 它是统一入口，会按 L1→L4 分层并在失败时快速停下。

### 服务端：从零开号（照抄即可）

\`\`\`bash
# 在包根目录执行
rc="node license-server/cli.js"

$rc db migrate && $rc db check                    # 建表 + 完整性检查
$rc admin create --user admin --password-stdin    # 第一个管理员（口令走 stdin）
$rc plan set --name "半年套餐" --credits 12600 --is-default
$rc account create --user demo001 --note "测试商家" --plan "半年套餐" --credits 12600
$rc account show --user demo001
$rc stats --days 7
\`\`\`

> ⚠️ \`--credits\` 低于 \`min_plan_credit\`（由 \`tier_table\` 推导，当前 12600）
> 会被 \`PLAN_QUOTA_BELOW_MIN\` 拒绝 —— 这是刻意的：发少了商家买到的
> "半年套餐"会提前耗尽，属于必输的告知错误。

### 客户端：双击启动

Windows 上双击 \`client\\启动.cmd\`（含 Node 版本与依赖自检）。
它会拉起专用 Chrome、启动本地控制台并打开界面。

---

## 五、⚠️ 三条红线（改任何代码之前先读 \`01-先读这些/AGENTS.md\`）

1. **安全上限由服务端下发，客户端只能调低。** 观察期（第 1–3 天）日上限为 0，
   客户端不可跳过。权威数值在 \`shared/protocol.md\` §4.6 的 \`tier_table\`，
   全系统唯一来源，**禁止硬编码**。
   🆕 **工作流包同样只能更保守**，且无权读写任何安全数值。
2. **只对平台确认成功的发送计费。** 必须同时满足 \`verdict=sent_confirmed\`
   ＋ \`confirm_signal=platform_response\` ＋ \`platform_status_code=0\`。
   **DOM 判断不算**；空响应 = 风控拒绝。
   🆕 算力类动作（如自动剪辑）按 \`action_kind=compute\` 走实测消耗计费，
   但「失败不计费」「服务端核算」这两条不放宽。
3. **审计必须记录真实生效的策略值。** 只上传哈希与计数，
   **绝不上传**评论原文、回复原文、\`sec_uid\`。
   🆕 Agent 参与决策后，还须记录 \`prompt_version\` / \`model.version\`。

---

## 六、包里**没有**的东西（刻意排除，不是遗漏）

| 排除项 | 原因 |
|---|---|
| \`client/instances/\` | 商家运行数据，**含专用 Chrome 的登录 Cookie**。绝对不该进任何包 |
| \`license-server/data/\` | 服务端库与台账，含全部商家账号与密码哈希 |
| \`node_modules/\` | 依赖体积大且平台相关；按上面第 2 步自行安装 |
| \`.env\` / \`master.key\` / 各种 \`*.json\` 运行态 | 凭据与运行数据 |

> ⚠️ **\`legacy/\` 不在上表里** —— 它**进包**，目录名叫 \`旧代码-只读参考/\`。
> 曾经排除过，理由是"旧代码不该被生产代码 require"。那个理由只对了一半：
> 它记录着**无法凭空复现**的平台 DOM 知识（隐藏与可见两套列表、
> \`scrollIntoView\` 后必须延迟读坐标、Enter 才是提交主路径），
> 是拿真账号反复试错换来的。排除它，接手人做页面操作时失去唯一参考。

---

## 七、接手建议（按顺序做）

1. 读 \`02-定位与需求/项目章程.md\`（**定位锚点，先读它**）。
2. 读 \`01-先读这些/README-DEV.md\` §五（定位修正）与 \`AGENTS.md\`。
3. 跑一遍上面第四节的全部验证命令。**先确认基线是绿的**，
   否则后面分不清是你改坏的还是本来就坏。
4. 读 \`05-平台机制与迁移/D-重构迁移与验收.md\`，按 **P9 → P14** 执行。
   P9（文档与契约）与 P10（依赖与框架落地）已完成，从 **P11（意图理解与评估集）** 开始。
5. **要一个真实测试账号**，跑通真机验证门
   （\`02-定位与需求/抖音截流需求规格.md\` §七 G-1~G-7）。
   在那之前，任何"采集/回复已经能用"的说法都是不成立的。
6. 真机验证通过后，再做界面精修与 72 小时长稳测试。

> ### ⚠️ 最容易被做错的一件事
>
> **不要把"专用 Agent"实现成"关键词规则的一层包装"。**
> 如果意图判断仍是关键词整词匹配、线索仍只存原文，
> 这个 Agent 就没有存在的理由。
>
> **"专业"的全部可验收内容在 \`client/understanding/\`**：
> 意图识别准确率 ≥85%、**投诉召回率 ≥95%**、线索结构化字段可筛。
> **先把它做对，工具层才有意义。**
>
> 反过来也要注意：P11 的第 2 步（用现有关键词规则跑同一份评估集得基线）
> 可能得出"关键词已经够用"的结论。**那个结论同样有价值**——
> 它是在大规模花钱之前得到的，此时应当停下来重新评估，而不是硬上 LLM。

---

*本包由 \`node scripts/build-handover.js\` 生成。改动源码后请重新生成，
不要手工往包里拷贝文件——手工拷的包一定会与代码脱节。*
`
  fs.writeFileSync(path.join(pkgRoot, '00-交付包说明-先读我.md'), readme, 'utf8')

  console.log('\n' + '='.repeat(64))
  console.log('  开发交接包已生成')
  console.log('='.repeat(64))
  console.log(`  目录：${pkgRoot}`)
  console.log(`  文件：${stats.files} 个 · ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  提交：${git.short} ${git.subject}`)
  if (stats.skipped.length) {
    console.log(`  跳过 ${stats.skipped.length} 项（前 10）：`)
    for (const s of stats.skipped.slice(0, 10)) console.log(`    · ${s}`)
  }

  if (!noZip) {
    const zipPath = path.join(outRoot, `${PKG_NAME}-${git.short}.zip`)
    try {
      fs.rmSync(zipPath, { force: true })
      // ⚠️ 用 PowerShell 的 Compress-Archive：Node 内置没有 zip 能力，
      //    而项目依赖白名单里只有 ws（不允许为打包引入 archiver 之类）。
      const ps = `Compress-Archive -Path '${pkgRoot}\\*' -DestinationPath '${zipPath}' -Force`
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' })
      console.log(`  zip ：${zipPath}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB）`)
    } catch (e) {
      // ⚠️ 打包失败不算致命（目录已生成可用），但必须让人看到。
      console.log(`  ⚠️ zip 生成失败：${e.message}`)
      console.log(`     目录已生成，可手工压缩：${pkgRoot}`)
    }
  }
  console.log('='.repeat(64) + '\n')
}

main()
