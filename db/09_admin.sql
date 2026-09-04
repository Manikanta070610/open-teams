-- 09_admin.sql — Admin panel support: email domain allowlist, admin credentials, sessions
-- Depends on: 01_core (employees, departments), 05_triggers (set_updated_at)
-- Fully rerunnable (IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING).
--
-- 1. allowed_email_domains: exact domains (e.g. company.com) permitted in employees.email.
--    Enforced by trigger below; fails closed (no match = reject). Seed 'example.com'
--    so 07_seed.sql addresses keep applying.

CREATE TABLE IF NOT EXISTS allowed_email_domains (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain     CITEXT NOT NULL UNIQUE
               CHECK (domain LIKE '%.%' AND domain NOT LIKE '%@%' AND domain NOT LIKE '% %'),
    created_by BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enforce_employee_email_domain()
RETURNS trigger AS $$
DECLARE
    v_domain TEXT;
BEGIN
    IF NEW.email IS NULL OR NEW.email::text NOT LIKE '%@%' THEN
        RAISE EXCEPTION 'enforce_employee_email_domain: email (%) must contain @', NEW.email;
    END IF;
    v_domain := split_part(lower(NEW.email::text), '@', 2);
    IF NOT EXISTS (SELECT 1 FROM allowed_email_domains WHERE domain = v_domain::CITEXT) THEN
        RAISE EXCEPTION 'enforce_employee_email_domain: domain (%) is not in the allowed list', v_domain;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employees_email_domain ON employees;
CREATE TRIGGER trg_employees_email_domain
    BEFORE INSERT OR UPDATE OF email ON employees
    FOR EACH ROW EXECUTE FUNCTION enforce_employee_email_domain();

-- Grandfather the seed domain so 01..09 applies cleanly in order.
INSERT INTO allowed_email_domains (domain) VALUES ('example.com')
ON CONFLICT (domain) DO NOTHING;

-- 2. admin_credentials: one scrypt password hash per employee (app layer hashes;
--    DB just stores the opaque string). CASCADE so departed employees lose login.
--    Only rank-6 (Owner) or IT-department employees may hold a credential (app-enforced
--    at login/bootstrap; re-checked on every request).

CREATE TABLE IF NOT EXISTS admin_credentials (
    employee_id BIGINT PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_admin_credentials_updated_at ON admin_credentials;
CREATE TRIGGER trg_admin_credentials_updated_at
    BEFORE UPDATE ON admin_credentials
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. admin_sessions: opaque bearer tokens, stored as SHA-256 hex (never plaintext).
--    Expiry enforced by the app on every request. Logout = DELETE the row.

CREATE TABLE IF NOT EXISTS admin_sessions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_employee ON admin_sessions (employee_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at);

-- 4. Admin name search: btree for last_name prefix lookup in the Employees tab.

CREATE INDEX IF NOT EXISTS idx_employees_last_name ON employees (last_name);
