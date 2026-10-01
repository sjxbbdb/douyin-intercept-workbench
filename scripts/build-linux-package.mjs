import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverRoot = join(root, 'server');
const releaseRoot = join(root, 'release-local');
const packageName = 'linux-server-4.0.0';
const packageRoot = join(releaseRoot, packageName);
const archivePath = join(releaseRoot, `${packageName}.tar.gz`);
const stagingRoot = join(releaseRoot, '.staging-linux-server');
const deploymentGuide = join(root, 'docs', 'linux-distribution.md');
const skipBuild = process.argv.includes('--skip-build');

function assertInside(parent, candidate) {
  const p = resolve(parent); const c = resolve(candidate);
  if (c !== p && !c.startsWith(`${p}${sep}`)) throw new Error(`refusing path outside ${p}: ${c}`);
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
}

function npmInvocation(args) {
  if (process.platform !== 'win32') return ['npm', args];
  return [process.execPath, [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]];
}

function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name); const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path, name) : [{ path, name }];
  });
}

function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  return `${text}\0`;
}

function tarHeader(name, size, mode = 0o644) {
  const header = Buffer.alloc(512, 0);
  const put = (offset, length, value) => header.write(String(value), offset, length, 'utf8');
  put(0, 100, name); put(100, 8, octal(mode, 8)); put(108, 8, octal(0, 8)); put(116, 8, octal(0, 8)); put(124, 12, octal(size, 12)); put(136, 12, octal(0, 12));
  header.fill(0x20, 148, 156); put(156, 1, '0'); put(257, 6, 'ustar\0'); put(263, 2, '00'); put(265, 32, 'root'); put(297, 32, 'root');
  let sum = 0; for (const byte of header) sum += byte;
  header.write(octal(sum, 8), 148, 8, 'ascii');
  return header;
}

function deterministicArchive(sourceRoot, output) {
  const files = walk(sourceRoot).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const chunks = [];
  for (const file of files) {
    const body = readFileSync(file.path);
    chunks.push(tarHeader(`${packageName}/${file.name}`, body.length, 0o644), body);
    const padding = (512 - (body.length % 512)) % 512; if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(output, gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
}

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

if (!existsSync(join(serverRoot, 'package.json')) || !existsSync(join(serverRoot, 'package-lock.json'))) throw new Error('server package metadata is missing');
if (!existsSync(deploymentGuide)) throw new Error(`deployment guide is missing: ${deploymentGuide}`);
assertInside(releaseRoot, packageRoot); assertInside(releaseRoot, stagingRoot); assertInside(releaseRoot, archivePath);
mkdirSync(releaseRoot, { recursive: true });
rmSync(stagingRoot, { recursive: true, force: true }); rmSync(packageRoot, { recursive: true, force: true }); rmSync(archivePath, { force: true });
mkdirSync(join(stagingRoot, 'dist'), { recursive: true });

if (!skipBuild) {
  const [npmCommand, ciArgs] = npmInvocation(['ci', '--ignore-scripts']); run(npmCommand, ciArgs, serverRoot);
  const [npmBuildCommand, buildArgs] = npmInvocation(['run', 'build']); run(npmBuildCommand, buildArgs, serverRoot);
}
if (!existsSync(join(serverRoot, 'dist', 'main.js'))) throw new Error('server build did not produce dist/main.js');

cpSync(join(serverRoot, 'dist'), join(stagingRoot, 'dist'), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) cpSync(join(serverRoot, file), join(stagingRoot, file));
cpSync(join(serverRoot, '.env.example'), join(stagingRoot, '.env.example'));
cpSync(join(serverRoot, 'Dockerfile'), join(stagingRoot, 'Dockerfile'));
cpSync(deploymentGuide, join(stagingRoot, 'DEPLOYMENT.md'));

const forbidden = /(^|\/)(node_modules|data|runtime|state|tokens|secrets)(\/|$)|\.sqlite(?:-|$)|(^|\/)\.env$|credentials/i;
const payload = walk(stagingRoot).map((x) => x.name).sort();
if (payload.some((name) => forbidden.test(name))) throw new Error(`forbidden release file: ${payload.find((name) => forbidden.test(name))}`);
const sums = payload.map((name) => `${sha256(join(stagingRoot, ...name.split('/')))}  ${name}`).join('\n') + '\n';
writeFileSync(join(stagingRoot, 'SHA256SUMS'), sums, 'utf8');
deterministicArchive(stagingRoot, archivePath);
cpSync(stagingRoot, packageRoot, { recursive: true });
rmSync(stagingRoot, { recursive: true, force: true });
const archiveHash = sha256(archivePath);
console.log(JSON.stringify({ packageRoot, archivePath, archiveSha256: archiveHash, files: payload.length + 1, bytes: statSync(archivePath).size }, null, 2));
