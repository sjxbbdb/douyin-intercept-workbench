import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
const scrypt = (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => new Promise<Buffer>((resolve, reject) => {
  scryptCb(password, salt, keylen, options, (error, derived) => {
    if (error) reject(error); else resolve(derived as Buffer);
  });
});

export const randomId = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
export const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashPayload = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, keyText] = parts;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(keyText, 'base64url');
  const actual = await scrypt(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) }) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertSecret(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) throw new Error(`${field} must be 8-256 characters`);
}
