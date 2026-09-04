// crypto.js — password hashing (scrypt) + session token helpers.
// Zero dependencies: node:crypto only. Parameters follow OWASP scrypt guidance.
import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALTLEN = 16;

// Stored format: scrypt$N$r$p$saltHex$keyHex
export async function hashPassword(password) {
  const salt = randomBytes(SALTLEN);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 32 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    if (salt.length !== SALTLEN || expected.length !== KEYLEN) return false;
    const actual = await scrypt(String(password), salt, KEYLEN, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Opaque bearer token (presented to the client); only its SHA-256 is stored.
export function newToken() {
  return randomBytes(32).toString('hex');
}

export function sha256hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

// Constant-time setup-token comparison that tolerates length mismatch.
export function setupTokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(sha256hex(provided), 'hex');
  const b = Buffer.from(sha256hex(expected), 'hex');
  return timingSafeEqual(a, b);
}
