import { createInterface } from 'node:readline/promises';
import { createInterface as createReadline } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Store } from './store.js';
import { hashPassword } from './security.js';
import { randomId } from './security.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) if (process.argv[i]?.startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? '');
const rl = createInterface({ input, output });
const username = process.env.ADMIN_USERNAME ?? args.get('username') ?? await rl.question('Admin username: ');
async function secretPrompt(question: string) {
  if (!input.isTTY || !input.setRawMode) return rl.question(`${question} (input will be visible; prefer ADMIN_PASSWORD in automation): `);
  output.write(question);
  return new Promise<string>((resolve) => { let value = ''; const onData = (chunk: Buffer) => { const text = chunk.toString(); if (text === '\r' || text === '\n') { input.setRawMode?.(false); input.off('data', onData); output.write('\n'); resolve(value); } else if (text === '\u0003') { input.setRawMode?.(false); input.off('data', onData); process.exit(130); } else if (text === '\u007f') value = value.slice(0, -1); else value += text; }; input.setRawMode(true); input.resume(); input.on('data', onData); });
}
const password = process.env.ADMIN_PASSWORD ?? await secretPrompt('Admin password: ');
rl.close();
if (!username || password.length < 8) throw new Error('username required and password must be at least 8 characters');
const path = process.env.DB_PATH ?? './data/license.sqlite'; mkdirSync(dirname(path), { recursive: true });
const store = new Store(path);
try {
  const existing = store.get('SELECT id FROM admins WHERE username=?', username);
  if (existing) throw new Error('admin username already exists');
  const hash = await hashPassword(password);
  store.transaction(() => store.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', randomId('admin'), username, hash, Date.now()));
  console.log(JSON.stringify({ ok: true, username }));
} finally { store.close(); }
