-- 12_project_staffing.sql — Projects "now" scope: descriptions, lifecycle fields,
-- allocation, task essentials, subtasks, comments, watchers, updates, activity log.
-- Depends on: 01_core, 02_projects, 05_triggers (set_updated_at).
-- Fully rerunnable (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).

-- --- projects: charter + lifecycle bookkeeping (no status-enum change) ---
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS objective TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sponsor_id BIGINT
    REFERENCES employees (id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- project_members: shared-staff allocation (parity with workspaces) ---
ALTER TABLE project_members ADD COLUMN IF NOT EXISTS allocation_pct INTEGER
    NOT NULL DEFAULT 100 CHECK (allocation_pct BETWEEN 1 AND 100);
ALTER TABLE project_members ADD COLUMN IF NOT EXISTS is_primary BOOLEAN
    NOT NULL DEFAULT TRUE;

-- --- tasks: essentials + hygiene + single-level subtasks ---
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate TEXT
    CHECK (estimate IN ('XS','S','M','L','XL'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reviewer_id BIGINT
    REFERENCES employees (id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id BIGINT
    REFERENCES tasks (id) ON DELETE CASCADE;

-- --- task comments (decision trail lives with the work) ---
CREATE TABLE IF NOT EXISTS task_comments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id     BIGINT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    author_id   BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,
    is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
);

-- --- watchers: auto-filled now, notification sender plugs in later ---
CREATE TABLE IF NOT EXISTS task_watchers (
    task_id     BIGINT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, employee_id)
);

-- --- weekly status posts (accomplished / next / risks as free text) ---
CREATE TABLE IF NOT EXISTS project_updates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    author_id   BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    week        DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- append-only audit trail (no UPDATE/DELETE route) ---
CREATE TABLE IF NOT EXISTS project_activity_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    task_id     BIGINT REFERENCES tasks (id) ON DELETE CASCADE,
    actor_id    BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    detail      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_sponsor ON projects (sponsor_id);
CREATE INDEX IF NOT EXISTS idx_project_members_employee12 ON project_members (employee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewer ON tasks (reviewer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks (project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id);
CREATE INDEX IF NOT EXISTS idx_task_watchers_employee ON task_watchers (employee_id);
CREATE INDEX IF NOT EXISTS idx_project_updates_project ON project_updates (project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON project_activity_log (project_id, id DESC);
