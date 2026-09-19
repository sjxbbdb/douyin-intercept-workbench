'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'build', 'probe');
const executable = path.join(runtime, process.platform === 'win32' ? 'probe-agent.exe' : 'probe-agent');

if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
  console.error(`缺少可分发侧车运行时: ${executable}`);
  console.error('请先构建 probe/dist/probe-agent onedir，并复制整个目录到 desktop/build/probe。');
  process.exit(1);
}
const internal = path.join(runtime, '_internal');
if (!fs.existsSync(internal) || !fs.statSync(internal).isDirectory()) {
  console.error(`侧车 onedir 不完整，缺少 _internal: ${internal}`);
  process.exit(1);
}
console.log(`probe runtime OK: ${path.relative(root, executable)}`);
