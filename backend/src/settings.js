// settings.js — auth_settings reader with tiny TTL cache (avoids a DB hit per request
// while still picking up admin policy changes within ~30s).
import { pool } from './db.js';

const cache = new Map(); // key -> { value, at }
const CACHE_MS = 30_000;

export async function getSetting(key, fallback) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const { rows } = await pool.query('SELECT value FROM auth_settings WHERE key = $1', [key]);
    const v = rows[0]?.value ?? fallback;
    cache.set(key, { value: v, at: Date.now() });
    return v;
  } catch {
    return fallback; // table missing (pre-10 migration): fall back to defaults
  }
}

export function _clearSettingsCache() {
  cache.clear();
}

export async function getInactivityDays() {
  const v = Number(await getSetting('inactivity_timeout_days', '7'));
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), 90) : 7;
}

export async function getAccessTtlMin() {
  const v = Number(await getSetting('access_ttl_min', '15'));
  return Number.isFinite(v) ? Math.min(Math.max(v, 5), 120) : 15;
}

export async function isIpRestrictionEnabled() {
  return (await getSetting('admin_ip_restriction_enabled', 'false')) === 'true';
}

// App-level check so it works with or without the 10_ migration (fail-open when
// restriction disabled, fail-closed when enabled but table missing).
export async function isAdminIpAllowed(ip) {
  if (!(await isIpRestrictionEnabled())) return true;
  if (!ip) return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM admin_allowed_ips WHERE $1::inet <<= cidr LIMIT 1',
      [String(ip)]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function audit(employeeId, action, ip) {
  try {
    await pool.query('INSERT INTO auth_audit_log (employee_id, action, ip) VALUES ($1, $2, $3)', [
      employeeId ?? null,
      action,
      ip ? String(ip).slice(0, 64) : null,
    ]);
  } catch {
    /* audit must never break auth */
  }
}
