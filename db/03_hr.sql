-- 03_hr.sql — HR tickets (omnipresent support layer, §7)
-- Depends on: 01_core.sql (employees, departments)
-- Rule: any rank 1-6 can file; assignee must be NULL or from HR dept (trigger in 05).

CREATE TABLE hr_tickets (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    requester_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    assignee_id  BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    subject      TEXT NOT NULL,
    description  TEXT,
    category     TEXT NOT NULL
                 CHECK (category IN ('inquiry','grievance','leave','payroll','benefits','other')),
    priority     TEXT NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low','medium','high','urgent')),
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','triaged','in_progress','awaiting_employee','resolved','closed','rejected')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ CHECK (resolved_at >= created_at)
);
