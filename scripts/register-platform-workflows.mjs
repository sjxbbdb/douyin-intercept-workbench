#!/usr/bin/env node
// 将桌面端固定业务契约登记到 Linux 授权端。
//
// 服务端不依赖 desktop 代码；首次部署由管理员显式执行本脚本，把同一份
// 客户端契约写入 workflow_definitions。脚本只新增缺失版本，绝不覆盖已有
// 定义，避免无意中改变正在运行的版本。
//
// 用法：
//   node scripts/register-platform-workflows.mjs --endpoint https://api.example.com \
//     --username admin --password '***'
//   node scripts/register-platform-workflows.mjs --endpoint ... --token '***' --dry-run

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = new Map([
  ['video.search', '关键词找视频'],
  ['comment.reply_then_private', '评论命中：公屏回复后私信'],
  ['live.reply_then_private', '直播间单条命中：公屏回复后私信'],
  ['live.batch', '直播间批次：关键词命中后公屏回复与私信'],
  ['comment.batch', '评论区批次：关键词命中后公屏回复与私信']
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next; index += 1;
  }
  return args;
}

async function request(endpoint, method, route, { token, body } = {}) {
  const response = await fetch(endpoint.replace(/\/$/, '') + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`${method} ${route} 失败：${parsed?.code || response.status} ${parsed?.message || ''}`.trim());
  return parsed;
}

function workflowPayloads() {
  const contracts = require(path.join(repoRoot, 'desktop', 'src', 'lib', 'workflow-contracts.js')).platformWorkflowDefinitions();
  return [...WORKFLOWS].map(([workflowId, name]) => {
    const definition = contracts.find((item) => item.workflowId === workflowId);
    if (!definition) throw new Error(`桌面端没有 ${workflowId} 固定契约`);
    return { workflowId, version: String(definition.version), name, status: 'active', contract: definition };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloads = workflowPayloads();
  if (args['dry-run'] || args['print-payload']) { process.stdout.write(JSON.stringify(payloads, null, 2) + '\n'); return 0; }
  const endpoint = args.endpoint || process.env.DSH_SERVER_ENDPOINT;
  if (!endpoint) throw new Error('需要 --endpoint（或 DSH_SERVER_ENDPOINT）');
  let token = args.token || process.env.DSH_ADMIN_TOKEN;
  if (!token) {
    const username = args.username || process.env.DSH_ADMIN_USERNAME;
    const password = args.password || process.env.DSH_ADMIN_PASSWORD;
    if (!username || !password) throw new Error('需要 --token，或 --username/--password（也可用 DSH_ADMIN_*）');
    token = (await request(endpoint, 'POST', '/v1/admin/auth/login', { body: { username, password } })).token;
  }
  const existing = await request(endpoint, 'GET', '/v1/admin/workflows', { token });
  const rows = Array.isArray(existing?.workflows) ? existing.workflows : [];
  for (const payload of payloads) {
    const present = rows.find((row) => row.workflowId === payload.workflowId && String(row.version) === payload.version);
    if (present) { process.stdout.write(`已注册，跳过：${payload.workflowId}@${payload.version} status=${present.status}\n`); continue; }
    const created = await request(endpoint, 'POST', '/v1/admin/workflows', { token, body: payload });
    process.stdout.write(`已注册：${payload.workflowId}@${payload.version} status=${created?.status || payload.status}\n`);
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`注册失败：${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
