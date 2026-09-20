const args = process.argv.slice(2);
const command = args[0];
const value = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const baseUrl = (process.env.LICENSE_SERVER_URL ?? 'http://127.0.0.1:18080').replace(/\/$/, '');

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({ ok: false, code: 'INVALID_RESPONSE', message: '服务端返回不是 JSON' }));
  if (!response.ok) throw new Error(`${body.code ?? 'HTTP_ERROR'}: ${body.message ?? 'request failed'}`);
  return body;
}

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password) throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required');
const login = await request('/v1/admin/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
const authHeaders = { authorization: `Bearer ${login.token}` };

try {
  if (command === 'user-create') {
    console.log(JSON.stringify(await request('/v1/admin/users', { method: 'POST', headers: authHeaders, body: JSON.stringify({ username: value('username'), expiresAt: value('expires-at') ? Number(value('expires-at')) : undefined, maxDevices: value('max-devices') ? Number(value('max-devices')) : undefined, features: { evaluate: true, draft: value('draft') === 'true' } }) })));
  } else if (command === 'user-disable') {
    const id = value('id'); if (!id) throw new Error('--id is required'); console.log(JSON.stringify(await request(`/v1/admin/users/${encodeURIComponent(id)}/disable`, { method: 'POST', headers: authHeaders, body: '{}' })));
  } else if (command === 'user-renew') {
    const id = value('id'); const expiresAt = Number(value('expires-at')); if (!id || !Number.isSafeInteger(expiresAt)) throw new Error('--id and --expires-at are required'); console.log(JSON.stringify(await request(`/v1/admin/users/${encodeURIComponent(id)}/renew`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ expiresAt }) })));
  } else if (command === 'credit-add') {
    const id = value('id'); const amount = Number(value('amount')); const idempotencyKey = value('idempotency-key') ?? `cli-${Date.now()}`; if (!id || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('--id and positive --amount are required'); console.log(JSON.stringify(await request(`/v1/admin/users/${encodeURIComponent(id)}/credits`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ amount, idempotencyKey, reason: value('reason') }) })));
  } else if (command === 'code-create') {
    const credits = Number(value('credits')); const count = Number(value('count') ?? 1); const expiresAt = value('expires-at') ? Number(value('expires-at')) : undefined; if (!Number.isSafeInteger(credits) || credits <= 0 || !Number.isSafeInteger(count) || count <= 0) throw new Error('--credits and --count are required'); console.log(JSON.stringify(await request('/v1/admin/redeem-codes', { method: 'POST', headers: authHeaders, body: JSON.stringify({ credits, count, expiresAt }) })));
  } else if (command === 'ledger') {
    const id = value('id'); if (!id) throw new Error('--id is required'); console.log(JSON.stringify(await request(`/v1/admin/users/${encodeURIComponent(id)}/ledger`, { headers: authHeaders })));
  } else {
    throw new Error('commands: user-create, user-disable, user-renew, credit-add, code-create, ledger');
  }
} finally {
  await request('/v1/admin/auth/logout', { method: 'POST', headers: authHeaders, body: '{}' }).catch(() => undefined);
}
