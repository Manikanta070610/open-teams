-- 02_projects.sql — Projects, members, tasks (downward handover)
-- Depends on: 01_core.sql (departments, employees)

CREATE TABLE projects (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                 TEXT NOT NULL,
    owning_department_id BIGINT NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
    status               TEXT NOT NULL DEFAULT 'planned'
                         CHECK (status IN ('planned','active','on_hold','completed','cancelled')),
    created_by           BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    start_date           DATE,
    end_date             DATE CHECK (end_date >= start_date),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
    project_id  BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner','lead','member','viewer','sponsor')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, employee_id)
);

-- Tasks (§6): downward delegation rule (assigned_by.rank >= assigned_to.rank
-- AND assigned_by != assigned_to) is enforced by trigger in 05_triggers.sql,
-- plus a cheap CHECK for self-assignment here.
CREATE TABLE tasks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    assigned_by BIGINT NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
    assigned_to BIGINT NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
    status      TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo','in_progress','in_review','done','blocked','cancelled')),
    priority    TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low','medium','high','urgent')),
    due_date    DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (assigned_by != assigned_to)
);
