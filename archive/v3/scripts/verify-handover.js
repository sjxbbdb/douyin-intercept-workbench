// 交付前终检：文档体系完整性与一致性校验
// 用法：node scripts/verify-handover.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── 期望交付的文档清单 ──────────────────────────────────────────
const EXPECTED = [
  ['README-DEV.md', '开发总索引'],
  ['AGENTS.md', 'AI 智能体入口（红线 + 误实现清单）'],
  ['README.md', '面向使用者的说明'],
  // ── ① 机制层 ──────────────────────────────────────────────────
  ['docs/项目章程.md', '定位锚点（①机制层）'],
  ['docs/平台需求规格.md', '平台层唯一验收依据'],
  ['docs/架构说明.md', '分层架构与稳定指标（①机制层）'],
  ['docs/部署指南-服务端.md', '服务端部署（③运维层）'],
  ['docs/合作方须知.html', '渠道合作方文件（源）（③运维层）'],
  ['docs/抖音自动回复助手-合作方须知.pdf', '渠道合作方文件（交付）'],
  ['shared/protocol.md', '双端接口契约'],
  ['shared/术语与选型基准.md', '术语与选型事实源'],
  ['shared/开发规范.md', '编码与工程规范'],
  ['shared/安全与合规要求.md', '三条红线完整展开'],
  ['shared/测试策略.md', '测试分层与真机验证'],
  ['shared/AI协作开发指引.md', '面向编码智能体'],
  // ── ② 业务层 ──────────────────────────────────────────────────
  ['docs/抖音截流需求规格.md', '抖音包需求（②业务层）'],
  ['shared/已知陷阱与平台知识.md', '抖音 DOM 知识与踩坑（②业务层）'],
  // ── 平台机制与迁移 ────────────────────────────────────────────
  ['plans/ADR-001-Agent优先与框架选型.md', '定位修正与框架选型决策'],
  ['plans/D-重构迁移与验收.md', '迁移路径与验收'],
  ['plans/B-Agent开发指导.md', 'Agent 层主文档'],
  ['plans/B-工具契约与粒度设计.md', '工具粒度核心设计'],
  ['plans/B-评估集与成本模型.md', '评估与成本模型'],
  ['plans/B-与方案A的差异说明.md', 'Agent 层增量改动与降级路径'],
  ['plans/B-分阶段任务清单.md', 'Agent 层任务清单'],
];

// ── 一致性断言：这些数值/枚举必须在全体系保持一致 ──────────────
const CONSISTENCY = {
  '套餐积分（半年）': '12600',
  '套餐积分（年）': '25550',
  '稳定期日上限合计': '70',
  '策略版本协议': 'protocol_version=2',
  '最低客户端版本': '3.0.0',
  '服务端应用端口': '18080',
  '服务端对外端口': '9443',
};

// ── 陈旧值：不应再出现（作废说明中的提及除外）────────────────────
// ⚠️ 这里只放**本身就有语义**的标识符。裸数字不要放进来：
//    `61200` 曾是"按小时计费"时代的单价（秒数），但"61200 毫秒"是
//    一个完全正当的耗时值——把它当陈旧值扫描会误报
//    （实测：新写的工作流包契约文档里的 `wall_ms: 61200` 被误判为硬伤）。
//    数字类硬伤要连同**它的单位/字段名**一起匹配，见下方的 STALE_PAIRS。
const STALE = ['daily_total_max', 'min_interval_comment_sec',
               'creditPerHour', 'min_days', 'client_too_old'];

// 数字 + 上下文：只有出现在这些形式里才算硬伤。
// 左侧一条就是当年真正的问题（`creditPerHour = 61200` 秒 = 17 小时/积分）。
const STALE_PAIRS = [
  ['61200', 'creditPerHour'],
  ['124100', 'creditPerHour'],
];

/**
 * ⚠️ 本脚本要在**两种布局**下都能跑，因为这个仓库有两副面孔：
 *
 *   · **仓库布局**（开发时的样子）：
 *       README-DEV.md / AGENTS.md / docs/ / shared/ / plans/ / legacy/ / client/…
 *   · **交接包布局**（`node scripts/build-handover.js` 产出的样子）：
 *       00-交付包说明-先读我.md / 01-先读这些/ / 02-需求与架构/ /
 *       03-契约规范与平台知识/ / 04-开发方案与任务清单/ /
 *       源码/{client,license-server,shared} / 旧代码-只读参考/ / test/ / scripts/
 *
 *   接手人拿到包后的第一件事就是跑本脚本（它在 `00-交付包说明-先读我.md`
 *   的验证清单里）。如果它只认仓库布局，接手人会看到"缺失 16 份文档"
 *   加"legacy 不存在"——而包里其实什么都不缺。
 *   一个会在正确输入上报错的检查脚本，比没有检查更糟。
 *
 * 做法：对每个期望文件给出**候选路径列表**，命中任一即算在位。
 */
const PATH_ALIASES = {
  'README-DEV.md': ['README-DEV.md', '01-先读这些/README-DEV.md'],
  'AGENTS.md': ['AGENTS.md', '01-先读这些/AGENTS.md'],
  'README.md': ['README.md', '01-先读这些/README.md'],
  'docs/项目章程.md': ['docs/项目章程.md', '02-定位与需求/项目章程.md'],
  'docs/平台需求规格.md': ['docs/平台需求规格.md', '02-定位与需求/平台需求规格.md'],
  'docs/抖音截流需求规格.md': ['docs/抖音截流需求规格.md', '02-定位与需求/抖音截流需求规格.md'],
  'docs/架构说明.md': ['docs/架构说明.md', '03-架构与运维/架构说明.md'],
  'docs/部署指南-服务端.md': ['docs/部署指南-服务端.md', '03-架构与运维/部署指南-服务端.md'],
  'docs/合作方须知.html': ['docs/合作方须知.html', '03-架构与运维/合作方须知.html'],
  'docs/可复用资产审计.md': ['docs/可复用资产审计.md', '03-架构与运维/可复用资产审计.md'],
  'docs/抖音自动回复助手-合作方须知.pdf': [
    'docs/抖音自动回复助手-合作方须知.pdf', '03-架构与运维/抖音自动回复助手-合作方须知.pdf',
  ],
  'shared/protocol.md': ['shared/protocol.md', '源码/shared/protocol.md', '04-契约规范与平台知识/protocol.md'],
  'shared/术语与选型基准.md': ['shared/术语与选型基准.md', '源码/shared/术语与选型基准.md', '04-契约规范与平台知识/术语与选型基准.md'],
  'shared/开发规范.md': ['shared/开发规范.md', '源码/shared/开发规范.md', '04-契约规范与平台知识/开发规范.md'],
  'shared/安全与合规要求.md': ['shared/安全与合规要求.md', '源码/shared/安全与合规要求.md', '04-契约规范与平台知识/安全与合规要求.md'],
  'shared/已知陷阱与平台知识.md': ['shared/已知陷阱与平台知识.md', '源码/shared/已知陷阱与平台知识.md', '04-契约规范与平台知识/已知陷阱与平台知识.md'],
  'shared/测试策略.md': ['shared/测试策略.md', '源码/shared/测试策略.md', '04-契约规范与平台知识/测试策略.md'],
  'shared/AI协作开发指引.md': ['shared/AI协作开发指引.md', '源码/shared/AI协作开发指引.md', '04-契约规范与平台知识/AI协作开发指引.md'],
  'plans/ADR-001-Agent优先与框架选型.md': ['plans/ADR-001-Agent优先与框架选型.md', '05-平台机制与迁移/ADR-001-Agent优先与框架选型.md'],
  'plans/D-重构迁移与验收.md': ['plans/D-重构迁移与验收.md', '05-平台机制与迁移/D-重构迁移与验收.md'],
  'plans/B-Agent开发指导.md': ['plans/B-Agent开发指导.md', '05-平台机制与迁移/B-Agent开发指导.md'],
  'plans/B-工具契约与粒度设计.md': ['plans/B-工具契约与粒度设计.md', '05-平台机制与迁移/B-工具契约与粒度设计.md'],
  'plans/B-评估集与成本模型.md': ['plans/B-评估集与成本模型.md', '05-平台机制与迁移/B-评估集与成本模型.md'],
  'plans/B-与方案A的差异说明.md': ['plans/B-与方案A的差异说明.md', '05-平台机制与迁移/B-与方案A的差异说明.md'],
  'plans/B-分阶段任务清单.md': ['plans/B-分阶段任务清单.md', '05-平台机制与迁移/B-分阶段任务清单.md'],
}

/** 在候选路径里找第一个存在的，返回相对路径或 null。 */
function resolveDoc(rel) {
  const cands = PATH_ALIASES[rel] || [rel]
  for (const c of cands) {
    if (fs.existsSync(path.join(ROOT, c))) return c
  }
  return null
}

/** legacy 的两副面孔。 */
function resolveLegacyDir() {
  for (const c of ['legacy', '旧代码-只读参考']) {
    if (fs.existsSync(path.join(ROOT, c))) return c
  }
  return null
}

function main() {
  let fail = 0;
  console.log('═'.repeat(72));
  console.log('  可承载多种专业分化工作流的 Agent 平台 · 交接文档终检');
  console.log('═'.repeat(72));

  // 1. 文档到位
  console.log('\n【1】文档到位情况');
  const missing = [];
  for (const [rel, desc] of EXPECTED) {
    const hit = resolveDoc(rel);
    if (hit) {
      const kb = (fs.statSync(path.join(ROOT, hit)).size / 1024).toFixed(1);
      // 命中别名时把真实位置也打出来，避免"我以为它在 docs/ 其实在编号目录"
      const shown = hit === rel ? rel : `${rel} → ${hit}`;
      console.log(`  ✓ ${shown.padEnd(60)} ${kb.padStart(8)} KB  ${desc}`);
    } else {
      console.log(`  ✗ ${rel.padEnd(44)} ${'—'.padStart(8)}     ${desc}`);
      missing.push(rel);
    }
  }
  if (missing.length) { fail++; console.log(`  → 缺失 ${missing.length} 份`); }

  // 2. legacy 存档
  console.log('\n【2】legacy/ 只读存档');
  const legacyName = resolveLegacyDir();
  const legacyDir = legacyName ? path.join(ROOT, legacyName) : null;
  if (legacyDir) {
    let n = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
      }
    })(legacyDir);
    console.log(`  ✓ 存在，${n} 个文件（旧代码行为规格参考）`);
  } else { fail++; console.log('  ✗ 不存在 —— P2/P3 的 DOM 工作将失去唯一参考'); }

  // 3. 根目录整洁
  //    ⚠️ 两种布局的根目录**允许清单不同**：仓库布局是 docs/shared/plans，
  //       交接包布局是编号目录 + 旧代码-只读参考。本脚本要在两处都能跑
  //       （接手人拿到包后第一件事就是跑它），所以两条清单取并集。
  //       漏掉包布局的那几条会表现为"非预期条目"警告——正是上一版犯的错。
  console.log('\n【3】根目录');
  const allowed = new Set([
    // 仓库布局
    '.git', '.gitignore', '.gitattributes', 'docs', 'shared', 'plans',
    'legacy', 'AGENTS.md', 'README.md', 'README-DEV.md', 'client',
    'license-server', 'test', 'scripts', 'package.json', 'node_modules', 'packs',
    // 交接包布局
    '00-交付包说明-先读我.md',
    '01-先读这些', '02-定位与需求', '03-架构与运维',
    '04-契约规范与平台知识', '05-平台机制与迁移',
    '旧代码-只读参考',
  ]);
  const stray = fs.readdirSync(ROOT).filter((n) => !allowed.has(n));
  if (stray.length === 0) console.log('  ✓ 无游离文件');
  else console.log(`  ⚠ 非预期条目：${stray.join(', ')}`);

  // 4. 三条红线覆盖
  console.log('\n【4】三条红线在文档体系中的覆盖');
  const docs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'legacy', 'node_modules'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|html)$/.test(e.name)) docs.push(p);
    }
  })(ROOT);
  const texts = docs.map((f) => ({ f: path.relative(ROOT, f), t: fs.readFileSync(f, 'utf8') }));
  const REDLINES = {
    '红线1 安全上限服务端下发': ['tier_table', '只能调低', 'POLICY_VIOLATION'],
    '红线2 只对平台确认成功计费': ['sent_confirmed', 'platform_response', 'send_id'],
    '红线3 审计记录生效策略值': ['policy_snapshot', 'applied_policy_version'],
  };
  for (const [name, kws] of Object.entries(REDLINES)) {
    const parts = kws.map((k) => {
      const n = texts.filter((x) => x.t.includes(k)).length;
      return `${k}=${n}`;
    });
    const ok = kws.every((k) => texts.some((x) => x.t.includes(k)));
    if (!ok) fail++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}: ${parts.join('  ')}`);
  }

  // 5. 关键数值一致性
  console.log('\n【5】关键数值一致性');
  for (const [label, val] of Object.entries(CONSISTENCY)) {
    const hits = texts.filter((x) => x.t.includes(val)).length;
    console.log(`  ${hits > 0 ? '✓' : '⚠'} ${label.padEnd(20)} "${val}"  出现于 ${hits} 份`);
    if (hits === 0) fail++;
  }

  // 6. 陈旧值扫描
  console.log('\n【6】陈旧值扫描');
  for (const s of STALE) {
    const files = texts.filter((x) => x.t.includes(s)).map((x) => x.f);
    if (files.length === 0) console.log(`  ✓ ${s.padEnd(26)} 无残留`);
    else console.log(`  ⚠ ${s.padEnd(26)} ${files.join(', ')}（若在"作废说明"中属正常）`);
  }
  // 数值型陈旧值单独判：必须**同时**出现数字与它的字段名才算硬伤
  // （裸数字会误报——"61200 毫秒"是完全正当的耗时值）
  for (const [num, ctx] of STALE_PAIRS) {
    const hit = texts.filter((x) => x.t.includes(num) && x.t.includes(ctx)).map((x) => x.f);
    if (hit.length) { fail++; console.log(`  ✗ ${ctx}=${num} 仍是硬伤，必须清零：${hit.join(', ')}`); }
    else console.log(`  ✓ ${ctx}=${num}`.padEnd(30) + ' 无残留');
  }

  // 7. 契约自检
  console.log('\n【7】接口契约自检');
  const proto = texts.find((x) => x.f.endsWith('protocol.md'));
  if (proto) {
    const blocks = [...proto.t.replace(/\r\n/g, '\n').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    let okj = 0;
    const badj = [];
    blocks.forEach((b, i) => { try { JSON.parse(b); okj++; } catch (e) { badj.push(`块${i + 1}: ${e.message}`); } });
    console.log(`  ${okj === blocks.length ? '✓' : '✗'} JSON 示例 ${okj}/${blocks.length} 可解析`);
    if (badj.length) { fail++; badj.forEach((b) => console.log(`      ${b}`)); }

    const fences = (proto.t.match(/```/g) || []).length;
    console.log(`  ${fences % 2 === 0 ? '✓' : '✗'} 代码围栏成对（${fences} 个）`);
    if (fences % 2 !== 0) fail++;

    for (const need of ['tier_table', 'content_similarity_max', 'POLICY_SENDING_DISABLED',
                        'policy_ack_log', 'settleSendBatch']) {
      const has = proto.t.includes(need);
      if (!has) fail++;
      console.log(`  ${has ? '✓' : '✗'} 含 ${need}`);
    }
  } else { fail++; console.log('  ✗ 未找到 protocol.md'); }

  // 8. 文档规模
  console.log('\n【8】文档规模');
  let lines = 0, bytes = 0;
  for (const x of texts) { lines += x.t.split('\n').length; bytes += Buffer.byteLength(x.t); }
  console.log(`  文档 ${texts.length} 份 · ${lines} 行 · ${(bytes / 1024).toFixed(0)} KB`);

  console.log('\n' + '═'.repeat(72));
  if (fail === 0) console.log('  终检通过 ✅  可以交付');
  else console.log(`  终检发现 ${fail} 类问题 ⚠  请见上方标 ✗ 项`);
  console.log('═'.repeat(72));
  process.exit(fail === 0 ? 0 : 1);
}

main();
