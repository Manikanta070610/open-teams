// tokens.js — Encrypted JWT (JWE) access tokens via `jose`.
// alg: dir, enc: A256GCM. Same symmetric secret encrypts + decrypts.
// Secret: AUTH_SECRET env (hex string >= 32 bytes preferred, else utf8 >= 32 chars).
import { CompactEncrypt, compactDecrypt } from 'jose';

function secretKey() {
  const raw = process.env.AUTH_SECRET || '';
  let key;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length >= 64) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'utf8');
  }
  if (key.length < 32) {
    throw new Error('AUTH_SECRET must be at least 32 bytes (64 hex chars)');
  }
  return key.subarray(0, 32);
}

export async function issueAccessToken(user, ttlMin = 15) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    sub: String(user.id),
    email: user.email,
    rank: user.rank,
    dept: user.dept_name || user.department || null,
    isAdmin: !!user.isAdmin,
    pwdVer: Number(user.password_version ?? 1),
    mustChange: !!user.must_change_password,
    iat: now,
    exp: now + Math.max(1, Number(ttlMin) || 15) * 60,
  });
  const jwe = await new CompactEncrypt(Buffer.from(payload, 'utf8'))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(secretKey());
  return jwe;
}

export async function verifyAccessToken(token) {
  const { plaintext } = await compactDecrypt(token, secretKey());
  let p;
  try {
    p = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    throw new Error('invalid token payload');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!p.sub || !p.exp || p.exp <= now) throw new Error('token expired');
  return {
    id: Number(p.sub),
    email: p.email,
    rank: p.rank,
    dept_name: p.dept,
    isAdmin: !!p.isAdmin,
    password_version: Number(p.pwdVer ?? 1),
    must_change_password: !!p.mustChange,
    exp: p.exp,
  };
}
