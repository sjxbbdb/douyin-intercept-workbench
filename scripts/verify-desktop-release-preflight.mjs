import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const desktopRoot = join(root, 'desktop');
const packagePath = join(desktopRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const runtimeRoot = resolve(process.env.DESKTOP_PROBE_ROOT || join(desktopRoot, 'build', 'probe'));
const releaseRoot = resolve(process.env.DESKTOP_RELEASE_ROOT || join(desktopRoot, 'release'));
const checkArtifacts = process.argv.includes('--artifacts');

function fail(message) {
  console.error(`Desktop release preflight failed: ${message}`);
  process.exitCode = 1;
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) fail(`${label} directory is missing: ${path}`);
}

function requireFile(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile() || statSync(path).size === 0) fail(`${label} file is missing or empty: ${path}`);
}

requireDirectory(runtimeRoot, 'sidecar runtime');
requireFile(join(runtimeRoot, process.platform === 'win32' ? 'probe-agent.exe' : 'probe-agent'), 'sidecar executable');
requireDirectory(join(runtimeRoot, '_internal'), 'sidecar onedir _internal');

const resources = Array.isArray(packageJson.build?.extraResources) ? packageJson.build.extraResources : [];
if (!resources.some((item) => item?.from === 'build/probe' && item?.to === 'probe')) {
  fail('desktop/package.json must copy build/probe to the packaged probe resource');
}
for (const scriptName of ['build:portable', 'build:nsis']) {
  if (typeof packageJson.scripts?.[scriptName] !== 'string' || !packageJson.scripts[scriptName].includes('check-probe-runtime.js')) {
    fail(`desktop package script ${scriptName} must run check-probe-runtime.js`);
  }
}

const artifactSummary = {};
if (checkArtifacts) {
  const version = String(packageJson.version);
  const product = String(packageJson.build?.productName || packageJson.name).replace(/[\\/:*?"<>|]/g, '_');
  const required = {
    portable: join(releaseRoot, `${product}-${version}-x64-portable.exe`),
    installer: join(releaseRoot, `${product}-${version}-x64-installer.exe`),
  };
  for (const [kind, path] of Object.entries(required)) {
    requireFile(path, `${kind} artifact`);
    if (existsSync(path)) artifactSummary[kind] = { path, bytes: statSync(path).size };
  }
}

if (process.exitCode) process.exit();
console.log(JSON.stringify({
  pass: true,
  version: packageJson.version,
  runtimeRoot,
  artifacts: checkArtifacts ? artifactSummary : undefined,
}, null, 2));
