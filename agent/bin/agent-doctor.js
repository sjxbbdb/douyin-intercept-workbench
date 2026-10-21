#!/usr/bin/env node
'use strict';

const config = require('../src/config');
const doctor = require('../src/doctor');

// 上手自检。给别人用的第一步就是跑它：
//   node agent/bin/agent-doctor.js --config agent/agent.config.json
//
// 它只读：不启动浏览器、不登录、不发送任何内容。
// 默认也不连浏览器（加 --probe-browser 才去查登录状态）。

const USAGE = [
  '用法: node agent/bin/agent-doctor.js [--config <json>] [--state-dir <dir>] [--profile-dir <dir>] [--port <n>]',
  '选项: --python <exe>  --probe-dir <dir>  --agent-state-dir <dir>',
  '      --probe-browser   一并检查浏览器与登录状态（只读）',
  '      --json            只输出 JSON（给脚本用）',
  '      --print-config    打印可粘贴的 MCP 客户端配置',
  '      --help'
].join('\n');

function pad(text, width) {
  const raw = String(text);
  // 中文按 2 列宽计算，尽量对齐（排不齐不影响可读性）。
  let width2 = 0;
  for (let i = 0; i < raw.length; i += 1) width2 += raw.charCodeAt(i) > 0x2e80 ? 2 : 1;
  return raw + ' '.repeat(Math.max(0, width - width2));
}

function main() {
  const cfg = config.fromEnvAndArgs(process.argv.slice(2), process.env);
  if (cfg.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (cfg.configFile && cfg.configLoaded === false) {
    process.stderr.write('配置文件读不了：' + cfg.configError + '\n');
    return 2;
  }

  const result = doctor.runChecks(cfg, { probeBrowser: cfg.probeBrowser === true || process.argv.indexOf('--probe-browser') !== -1 });

  if (cfg.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ready ? 0 : 1;
  }

  process.stdout.write('抖音截流 Agent 工具 · 上手自检\n');
  process.stdout.write('（只读：不启动浏览器、不登录、不发送任何内容）\n\n');
  result.checks.forEach(function (c) {
    process.stdout.write((c.ok ? '  [通过] ' : '  [未通过] ') + pad(c.id, 24) + String(c.detail == null ? '' : c.detail) + '\n');
    if (!c.ok && c.fix) process.stdout.write('           └─ 怎么办: ' + c.fix + '\n');
  });
  process.stdout.write('\n');
  if (result.ready) {
    process.stdout.write('自检通过：可以接了。把下面这段粘进你的 MCP 客户端配置：\n\n');
    process.stdout.write(JSON.stringify(result.mcpConfig, null, 2) + '\n');
  } else {
    process.stdout.write('还不能用，未通过：' + result.blocking.join(', ') + '\n');
    process.stdout.write('按上面每一项的"怎么办"修完再重跑。\n');
  }
  process.stdout.write('\n' + result.note + '\n');
  return result.ready ? 0 : 1;
}

const code = main();
if (typeof code === 'number') process.exit(code);
