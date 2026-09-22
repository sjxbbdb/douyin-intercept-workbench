#!/usr/bin/env node
// 把固定批次流程注册进授权中心（平台侧 catalog）。默认注册直播批次；
// 传 --workflow-id comment.batch 可注册评论区批次，保持同一套鉴权和幂等逻辑。
//
// 为什么需要它：Agent 聊天（desktop/src/main.js -> runAgentChat）只允许启动
// 【授权中心 catalog 里 status=active】的流程；catalog 来自服务端 workflow_definitions 表，
// 而该表只有 admin API 能写入（server/src/workflow-routes.ts: POST /v1/admin/workflows），
// 代码里没有播种。桌面端的 live.batch 契约已经就位，缺的就是这一行注册数据。
//
// 幂等：已注册过（同 workflowId+version）就跳过，不重复注册、不覆盖。
//
// 用法：
//   node scripts/register-live-batch-workflow.mjs --endpoint https://api.example.com \
//        --username admin --password '***'          # 用管理员账号登录换 token
//   node scripts/register-live-batch-workflow.mjs --endpoint ... --token '***'
//   node scripts/register-live-batch-workflow.mjs --workflow-id comment.batch --dry-run
//
// 环境变量等价写法：DSH_SERVER_ENDPOINT / DSH_ADMIN_USERNAME / DSH_ADMIN_PASSWORD / DSH_ADMIN_TOKEN
//
// 契约来源：desktop/src/lib/workflow-contracts.js 里的 live.batch（单一事实来源，
// 避免脚本里的契约与桌面端漂移）。

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const VERSION = '1';
const WORKFLOW_NAMES = Object.freeze({
  'live.batch': '直播间批次：关键词命中 → 原生回复 → 私信',
  'comment.batch': '评论区批次：关键词命中 → 评论回复 → 私信'
});

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

function contractFromDesktop(workflowId) {
  const contracts = require(path.join(repoRoot, 'desktop', 'src', 'lib', 'workflow-contracts.js'));
  const definition = contracts.platformWorkflowDefinitions().find((item) => item.workflowId === workflowId);
  if (!definition) throw new Error('桌面端没有 ' + workflowId + ' 契约；请先合并对应批次工作流改动');
  if (String(definition.version) !== VERSION) throw new Error(workflowId + ' 版本不是 ' + VERSION);
  const steps = definition.steps.map((step) => ({ ...step }));
  return { workflowId, version: VERSION, name: WORKFLOW_NAMES[workflowId] || workflowId, status: 'active', contract: { ...definition, steps } };
}

async function request(endpoint, method, route, { token, body } = {}) {
  const response = await fetch(endpoint.replace(/\/$/, '') + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    const code = parsed && parsed.code ? parsed.code : response.status;
    throw new Error(method + ' ' + route + ' 失败：' + code + ' ' + (parsed && parsed.message ? parsed.message : ''));
  }
  return parsed;
}

async function adminToken(endpoint, args) {
  const direct = args.token || process.env.DSH_ADMIN_TOKEN;
  if (direct) return String(direct);
  const username = args.username || process.env.DSH_ADMIN_USERNAME;
  const password = args.password || process.env.DSH_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('需要 --token，或 --username/--password（也可用 DSH_ADMIN_* 环境变量）');
  const login = await request(endpoint, 'POST', '/v1/admin/auth/login', { body: { username, password } });
  if (!login || typeof login.token !== 'string' || !login.token) throw new Error('管理员登录没有返回 token');
  return login.token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workflowId = String(args['workflow-id'] || process.env.DSH_WORKFLOW_ID || 'live.batch');
  if (!WORKFLOW_NAMES[workflowId]) throw new Error('不支持的批次流程：' + workflowId + '（仅支持 live.batch / comment.batch）');
  const payload = contractFromDesktop(workflowId);
  if (args.status === 'disabled') payload.status = 'disabled';

  if (args['dry-run'] || args['print-payload']) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }

  const endpoint = args.endpoint || process.env.DSH_SERVER_ENDPOINT;
  if (!endpoint) throw new Error('需要 --endpoint（或 DSH_SERVER_ENDPOINT 环境变量）');
  const token = await adminToken(endpoint, args);

  const existing = await request(endpoint, 'GET', '/v1/admin/workflows', { token });
  const rows = Array.isArray(existing && existing.workflows) ? existing.workflows : [];
  const present = rows.find((row) => row.workflowId === workflowId && String(row.version) === VERSION);
  if (present) {
    process.stdout.write('已注册，跳过：' + workflowId + '@' + VERSION + ' status=' + present.status + '\n');
    return 0;
  }

  const created = await request(endpoint, 'POST', '/v1/admin/workflows', { token, body: payload });
  process.stdout.write('已注册：' + workflowId + '@' + VERSION + ' status=' + (created && created.status) + '\n');
  process.stdout.write('提示：客户端能否启动它，还取决于账号功能开关；服务端按流程前缀校验对应能力。\n');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write('注册失败：' + (error && error.message ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
