-- 11_workspaces.sql — Workspaces + shared staffing (reusable for future projects)
-- Depends on: 01_core (employees, departments), 05_triggers (set_updated_at)
-- Fully rerunnable (IF NOT EXISTS / OR REPLACE).
-- Model: workspace = long-lived container (like a department floor);
-- project (02_projects) = short-lived work inside it. Membership carries
-- allocation_pct (100 = full-time, <100 = shared, e.g. HR for Eng + Finance)
-- so the same procedure works for projects later via ALTER project_members.

CREATE TABLE IF NOT EXISTS workspaces (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 200),
    description TEXT,
    created_by  BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('planned','active','archived')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id   BIGINT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    employee_id    BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    role           TEXT NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner','lead','member','viewer')),
    allocation_pct INTEGER NOT NULL DEFAULT 100 CHECK (allocation_pct BETWEEN 1 AND 100),
    is_primary     BOOLEAN NOT NULL DEFAULT TRUE,
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, employee_id)
);

-- Staffing requests: CTO/COO/chief (rank >= 5) or admin creates workspace,
-- then requests people. HR staffs from existing active employees
-- (rank/dept match + priority from requester). No fit -> pending_hiring.
CREATE TABLE IF NOT EXISTS workspace_staff_requests (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id  BIGINT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    requester_id  BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    requirements  TEXT,
    headcount     INTEGER NOT NULL DEFAULT 1 CHECK (headcount >= 1),
    ranks_needed  INTEGER[] NOT NULL DEFAULT '{}',
    priority      TEXT NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low','medium','high','urgent')),
    status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','staffed','pending_hiring','closed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces (status);
CREATE INDEX IF NOT EXISTS idx_workspaces_created_by ON workspaces (created_by);
CREATE INDEX IF NOT EXISTS idx_workspace_members_employee ON workspace_members (employee_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members (workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_staff_req_workspace ON workspace_staff_requests (workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_staff_req_status ON workspace_staff_requests (status);

DROP TRIGGER IF EXISTS trg_workspaces_updated_at ON workspaces;
CREATE TRIGGER trg_workspaces_updated_at
    BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_staff_req_updated_at ON workspace_staff_requests;
CREATE TRIGGER trg_workspace_staff_req_updated_at
    BEFORE UPDATE ON workspace_staff_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
