// ratelimit.js — shared per-IP rate limiter (single-instance, in-memory).
const buckets = new Map(); // name:ip -> { count, resetAt }

export function _resetRateLimits() {
  buckets.clear();
}

export function rateLimited(name, ip, maxAttempts, windowMs) {
  const now = Date.now();
  const k = `${name}:${ip}`;
  const cur = buckets.get(k);
  if (!cur || now >= cur.resetAt) {
    buckets.set(k, { count: 1, resetAt: now + windowMs });
    return false;
  }
  cur.count += 1;
  return cur.count > maxAttempts;
}
