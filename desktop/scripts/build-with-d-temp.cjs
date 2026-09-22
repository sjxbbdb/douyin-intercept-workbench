'use strict';

// electron-builder/NSIS extracts and stages large files through TEMP.  Keep
// those transient files on the developer's D: drive instead of silently
// consuming the system disk.  The path is configurable for another machine.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.env.DOUYIN_AGENT_BUILD_ROOT || (process.platform === 'win32'
  ? 'D:\\DevTools\\douyin-agent'
  : path.join(require('node:os').tmpdir(), 'douyin-agent'));
const temp = path.join(root, 'temp');
const electronCache = path.join(root, 'electron-cache');
const builderCache = path.join(root, 'electron-builder-cache');
for (const directory of [root, temp, electronCache, builderCache]) fs.mkdirSync(directory, { recursive: true });

const env = {
  ...process.env,
  TEMP: temp,
  TMP: temp,
  ELECTRON_CACHE: electronCache,
  ELECTRON_BUILDER_CACHE: builderCache
};
const cli = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
if (result.error) throw result.error;
process.exitCode = result.status == null ? 1 : result.status;
