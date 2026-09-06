-- 10_employee_auth.sql — General employee auth: contact email, password versioning,
-- refresh sessions (sliding inactivity), optional admin IP allowlist, settings, audit.
-- Depends on: 01_core (employees), 09_admin (admin_credentials).
-- Fully rerunnable (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- 1. Personal contact email: invite delivery only, never a login key.
ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS contact_email CITEXT
        CHECK (contact_email IS NULL OR contact_email LIKE '%@%');

-- 2. Password version: bumped on every set/reset to invalidate outstanding JWEs.
ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS password_version INTEGER NOT NULL DEFAULT 1;

-- 3. First-login enforcement flag on the credential row.
ALTER TABLE admin_credentials
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;

-- 4. App settings (single-row-per-key store).
CREATE TABLE IF NOT EXISTS auth_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO auth_settings (key, value) VALUES
    ('admin_ip_restriction_enabled', 'false'),
    ('inactivity_timeout_days', '7'),
    ('access_ttl_min', '15')
ON CONFLICT (key) DO NOTHING;

-- 5. Admin IP allowlist (empty + enabled=true means deny-all, fail closed).
CREATE TABLE IF NOT EXISTS admin_allowed_ips (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cidr       INET NOT NULL UNIQUE,
    label      TEXT,
    created_by BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Refresh sessions: opaque token hash, sliding last_seen_at window.
CREATE TABLE IF NOT EXISTS auth_refresh_sessions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT,
    ip          INET,
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_refresh_employee ON auth_refresh_sessions (employee_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON auth_refresh_sessions (expires_at);

-- 7. Lightweight audit log (admin-view only, no PII beyond employee id + action).
CREATE TABLE IF NOT EXISTS auth_audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    ip          TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_employee ON auth_audit_log (employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON auth_audit_log (created_at);
