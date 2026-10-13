'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
const policyMod = require('./policy');
const authorize = require('./authorize');

// 最小 HTTP 面。零第三方依赖。
//
// 安全默认：
//   · 只绑 127.0.0.1（本地/内网部署由反代决定，不改这里）；
//   · 每条请求都要 Bearer token；token 在 <state-dir>/tokens.json 里配；
//   · 请求体上限 64KB；
//   · 上限【只从服务端 settings 读】—— 请求体里带上限一律忽略（并记审计）。

const MAX_BODY = 64 * 1024;
const POLICY_OVERRIDE_FIELDS = ['limits', 'policy', 'policyVersion', 'hourly', 'daily', 'perUser',
                                'observation', 'minIntervalMs', 'activeHours'];

function loadTokens(stateDir) {
  const file = path.join(path.resolve(stateDir), 'tokens.json');
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function readBody(request) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    request.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error('body must be JSON')); }
    });
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function createServer(options) {
  const opts = options || {};
  const stateDir = path.resolve(opts.stateDir || path.join(process.cwd(), 'authority-state'));
  const db = store.open(stateDir);
  const tokens = opts.tokens || loadTokens(stateDir);
  const clock = opts.clock || function () { return Date.now(); };

  // 租户从 token 反查 —— 客户端不能自称是别人。
  function tenantFor(request) {
    const header = String(request.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/.exec(header.trim());
    if (!match) return null;
    const token = match[1].trim();
    for (const tenant of Object.keys(tokens)) {
      if (tokens[tenant] === token) return tenant;
    }
    return null;
  }

  const server = http.createServer(async function (request, response) {
    const tenant = tenantFor(request);
    if (!tenant) { send(response, 401, { ok: false, reason: 'not_authenticated' }); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    const nowMs = clock();

    try {
      if (request.method === 'GET' && url.pathname === '/v1/policy/sending') {
        const loaded = policyMod.current(db, tenant);
        const used = store.usage(db, tenant, String(url.searchParams.get('accountScope') || ''), nowMs);
        send(response, 200, {
          ok: true,
          tenant,
          policyRef: policyMod.policyRefFor(tenant, loaded.policy),
          source: loaded.source,
          limits: loaded.policy.limits,
          observation: loaded.policy.observation,
          circuit: { failureThreshold: loaded.policy.circuit.failureThreshold, consecutiveFailures: used.total ? store.consecutiveFailures(db, tenant, String(url.searchParams.get('accountScope') || '')) : 0 },
          allowedPublicStates: loaded.policy.allowedPublicStates,
          serverTimeMs: nowMs
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/send-authorizations') {
        const body = await readBody(request);
        const ignored = POLICY_OVERRIDE_FIELDS.filter(function (key) { return body[key] !== undefined; });
        if (ignored.length) {
          // 客户端想把上限塞进来：忽略它，并留一条审计。
          store.audit(db, tenant, 'policy_override_attempt', { fields: ignored }, nowMs);
        }
        const result = authorize.authorize(db, {
          tenant,
          accountScope: body.accountScope,
          sendId: body.sendId,
          kind: body.kind,
          phase: body.phase,
          targetKey: body.targetKey,
          publicSendId: body.publicSendId
        }, { nowMs });
        if (result.status !== 'granted') authorize.denyAudit(db, tenant, result.reason, body, nowMs);
        send(response, result.status === 'granted' ? 200 : 409, Object.assign({ ok: result.status === 'granted' }, result));
        return;
      }

      const commitMatch = /^\/v1\/send-authorizations\/([^/]+)\/(commit|release)$/.exec(url.pathname);
      if (request.method === 'POST' && commitMatch) {
        const body = await readBody(request);
        const result = commitMatch[2] === 'commit'
          ? authorize.commit(db, tenant, commitMatch[1], body, { nowMs })
          : authorize.release(db, tenant, commitMatch[1], { nowMs });
        send(response, result.ok ? 200 : 409, result);
        return;
      }

      const getMatch = /^\/v1\/send-authorizations\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && getMatch) {
        const row = store.findById(db, tenant, getMatch[1]);
        if (!row) { send(response, 404, { ok: false, reason: 'unknown_authorization' }); return; }
        send(response, 200, { ok: true, authorization: {
          authorizationId: String(row.authorization_id), sendId: String(row.send_id),
          state: String(row.state), reason: row.reason == null ? null : String(row.reason),
          phase: String(row.phase), kind: String(row.kind),
          policyRef: { policyId: String(row.policy_id), policyVersion: Number(row.policy_version) },
          createdAtMs: Number(row.created_at) * 1000, expiresAtMs: Number(row.expires_at) * 1000
        } });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/healthz') {
        send(response, 200, { ok: true, tenant });
        return;
      }

      send(response, 404, { ok: false, reason: 'not_found' });
    } catch (error) {
      send(response, 400, { ok: false, reason: 'bad_request', detail: error && error.message ? error.message : String(error) });
    }
  });

  return { server, db, stateDir };
}

module.exports = { createServer, loadTokens, MAX_BODY, POLICY_OVERRIDE_FIELDS };
