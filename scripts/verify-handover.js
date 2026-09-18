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
  ['docs/需求规格.md', '唯一验收依据'],
  ['docs/架构说明.md', '目标架构与稳定指标'],
  ['docs/部署指南-服务端.md', '服务端部署'],
  ['docs/合作方须知.html', '渠道合作方文件（源）'],
  ['docs/抖音自动回复助手-合作方须知.pdf', '渠道合作方文件（交付）'],
  ['shared/protocol.md', '双端接口契约'],
  ['shared/术语与选型基准.md', '术语与选型事实源'],
  ['shared/开发规范.md', '编码与工程规范'],
  ['shared/安全与合规要求.md', '三条红线完整展开'],
  ['shared/已知陷阱与平台知识.md', '抖音 DOM 知识与踩坑'],
  ['shared/测试策略.md', '测试分层与真机验证'],
  ['shared/AI协作开发指引.md', '面向编码智能体'],
  ['plans/00-两方案对比与选型建议.md', '选型决策'],
  ['plans/A-工具链路开发指导.md', '方案 A 主文档'],
  ['plans/A-分阶段任务清单.md', '方案 A 任务清单'],
  ['plans/B-Agent开发指导.md', '方案 B 主文档'],
  ['plans/B-工具契约与粒度设计.md', '方案 B 核心设计'],
  ['plans/B-评估集与成本模型.md', '方案 B 评估与成本'],
  ['plans/B-与方案A的差异说明.md', '方案 B 增量改动'],
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
const STALE = ['61200', '124100', 'daily_total_max', 'min_interval_comment_sec',
               'creditPerHour', 'min_days', 'client_too_old'];

function main() {
  let fail = 0;
  console.log('═'.repeat(72));
  console.log('  抖音自动回复工作台 · 交接文档终检');
  console.log('═'.repeat(72));

  // 1. 文档到位
  console.log('\n【1】文档到位情况');
  const missing = [];
  for (const [rel, desc] of EXPECTED) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) {
      const kb = (fs.statSync(p).size / 1024).toFixed(1);
      console.log(`  ✓ ${rel.padEnd(44)} ${kb.padStart(8)} KB  ${desc}`);
    } else {
      console.log(`  ✗ ${rel.padEnd(44)} ${'—'.padStart(8)}     ${desc}`);
      missing.push(rel);
    }
  }
  if (missing.length) { fail++; console.log(`  → 缺失 ${missing.length} 份`); }

  // 2. legacy 存档
  console.log('\n【2】legacy/ 只读存档');
  const legacyDir = path.join(ROOT, 'legacy');
  if (fs.existsSync(legacyDir)) {
    let n = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
      }
    })(legacyDir);
    console.log(`  ✓ 存在，${n} 个文件（旧代码行为规格参考）`);
  } else { fail++; console.log('  ✗ 不存在 —— P2/P3 的 DOM 工作将失去唯一参考'); }

  // 3. 根目录整洁
  console.log('\n【3】仓库根目录');
  const allowed = new Set(['.git', '.gitignore', '.gitattributes', 'docs', 'shared', 'plans',
                           'legacy', 'AGENTS.md', 'README.md', 'README-DEV.md', 'client',
                           'license-server', 'test', 'scripts', 'package.json', 'node_modules']);
  const stray = fs.readdirSync(ROOT).filter((n) => !allowed.has(n));
  if (stray.length === 0) console.log('  ✓ 无游离文件');
  else { console.log(`  ⚠ 非预期条目：${stray.join(', ')}`); }

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
  // 数值型陈旧值单独判（可能出现在作废对照中）
  for (const s of ['61200', '124100']) {
    if (texts.some((x) => x.t.includes(s))) { fail++; console.log(`  ✗ ${s} 仍是硬伤，必须清零`); }
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
