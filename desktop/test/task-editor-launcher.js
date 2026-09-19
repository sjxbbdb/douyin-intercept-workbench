'use strict';

// Starts Electron with an explicit absolute profile before Electron creates
// its app object, then removes exactly that fixture directory after exit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const electron = require('electron');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-editor-fixture-'));
const fixture = path.join(__dirname, 'task-editor-fixture.js');
const args = [`--user-data-dir=${userDataDir}`, fixture, ...process.argv.slice(2)];
let result;
try {
  result = spawnSync(electron, args, { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
} finally {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (error) { console.warn(`fixture cleanup failed: ${error.message}`); }
}
process.exitCode = result?.status ?? 1;
