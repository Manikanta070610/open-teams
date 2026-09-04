-- 06_indexes.sql — FK + query + partial indexes (§10)
-- Depends on: 01-04. Safe to re-run (IF NOT EXISTS).

-- --- Foreign-key / join indexes (all FKs) ---
CREATE INDEX IF NOT EXISTS idx_employees_rank           ON employees (rank);
CREATE INDEX IF NOT EXISTS idx_employees_department_id  ON employees (department_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager_id     ON employees (manager_id);
CREATE INDEX IF NOT EXISTS idx_departments_head_id      ON departments (head_id);

CREATE INDEX IF NOT EXISTS idx_projects_owning_dept     ON projects (owning_department_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by      ON projects (created_by);
CREATE INDEX IF NOT EXISTS idx_projects_status          ON projects (status);
CREATE INDEX IF NOT EXISTS idx_project_members_employee ON project_members (employee_id);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id    ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by   ON tasks (assigned_by);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to   ON tasks (assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status        ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority      ON tasks (priority);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date      ON tasks (due_date);

CREATE INDEX IF NOT EXISTS idx_hr_tickets_requester ON hr_tickets (requester_id);
CREATE INDEX IF NOT EXISTS idx_hr_tickets_assignee  ON hr_tickets (assignee_id);
CREATE INDEX IF NOT EXISTS idx_hr_tickets_status_category ON hr_tickets (status, category);

CREATE INDEX IF NOT EXISTS idx_app_groups_created_by   ON app_groups (created_by);
CREATE INDEX IF NOT EXISTS idx_app_groups_department   ON app_groups (department_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_employee ON group_memberships (employee_id);

CREATE INDEX IF NOT EXISTS idx_conversations_group_id  ON conversations (group_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_employee ON conversation_participants (employee_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id      ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_message_reads_employee  ON message_reads (employee_id);

-- --- Chat pagination (§10): keyset on (conversation_id, created_at DESC) and (id DESC) ---
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv_id      ON messages (conversation_id, id DESC);

-- --- Partial indexes (§10) ---
CREATE INDEX IF NOT EXISTS idx_hr_tickets_open
    ON hr_tickets (created_at DESC) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_employees_active
    ON employees (department_id, rank) WHERE is_active;
