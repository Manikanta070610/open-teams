-- 07_seed.sql — Minimal seed (§11): levels, depts, chain CEO->L1, HR staffer, project + task
-- Depends on: 01-06. Rerunnable (ON CONFLICT DO NOTHING + lookups by email/name).

-- Levels 1-6
INSERT INTO job_levels (rank, title, description) VALUES
    (6, 'Owner/CEO',      'Owner / Chief Executive Officer'),
    (5, 'C-Suite',        'CTO, CFO, CRO, CIO'),
    (4, 'Manager',        'L-4 Manager'),
    (3, 'L-3 Senior',     'L-3 Senior / Staff'),
    (2, 'L-2 Associate',  'L-2 Associate'),
    (1, 'L-1 Junior',     'L-1 Junior')
ON CONFLICT (rank) DO NOTHING;

-- Departments incl HR
INSERT INTO departments (name, description) VALUES
    ('Engineering', 'Product and platform engineering'),
    ('Sales',       'Sales and business development'),
    ('Finance',     'Finance and accounting'),
    ('Marketing',   'Marketing and growth'),
    ('HR',          'Human resources'),
    ('IT',          'IT operations')
ON CONFLICT (name) DO NOTHING;

-- Chain: CEO(6) -> CTO(5) -> Manager(4) -> L3 -> L2 -> L1, plus HR staffer.
-- Insert top-down so manager_id FKs resolve. Email is the stable key.
INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Ava', 'Owner', 'ceo@example.com',
        6, (SELECT id FROM departments WHERE name = 'Engineering'), NULL)
ON CONFLICT (email) DO NOTHING;

INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Ben', 'CTO', 'cto@example.com',
        5, (SELECT id FROM departments WHERE name = 'Engineering'),
        (SELECT id FROM employees WHERE email = 'ceo@example.com'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Cara', 'Manager', 'manager@example.com',
        4, (SELECT id FROM departments WHERE name = 'Engineering'),
        (SELECT id FROM employees WHERE email = 'cto@example.com'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Dev', 'Senior', 'l3@example.com',
        3, (SELECT id FROM departments WHERE name = 'Engineering'),
        (SELECT id FROM employees WHERE email = 'manager@example.com'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Eli', 'Associate', 'l2@example.com',
        2, (SELECT id FROM departments WHERE name = 'Engineering'),
        (SELECT id FROM employees WHERE email = 'l3@example.com'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Fay', 'Junior', 'l1@example.com',
        1, (SELECT id FROM departments WHERE name = 'Engineering'),
        (SELECT id FROM employees WHERE email = 'l2@example.com'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO employees (first_name, last_name, email, rank, department_id, manager_id) VALUES
    ('Hana', 'HR', 'hr@example.com',
        3, (SELECT id FROM departments WHERE name = 'HR'),
        (SELECT id FROM employees WHERE email = 'ceo@example.com'))
ON CONFLICT (email) DO NOTHING;

-- Department heads (deferred FK allows this in one txn)
UPDATE departments SET head_id = (SELECT id FROM employees WHERE email = 'cto@example.com')
 WHERE name = 'Engineering' AND head_id IS NULL;
UPDATE departments SET head_id = (SELECT id FROM employees WHERE email = 'hr@example.com')
 WHERE name = 'HR' AND head_id IS NULL;

-- 1 sample project (owned by Engineering, created by CEO)
INSERT INTO projects (name, owning_department_id, status, created_by, start_date, end_date)
SELECT 'Apollo Launch',
       (SELECT id FROM departments WHERE name = 'Engineering'),
       'active',
       (SELECT id FROM employees WHERE email = 'ceo@example.com'),
       CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days'
WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = 'Apollo Launch');

-- Members cross-dept (Engineering chain + HR)
INSERT INTO project_members (project_id, employee_id, role)
SELECT p.id, e.id, v.role
  FROM (SELECT id FROM projects WHERE name = 'Apollo Launch') p
  JOIN (VALUES
      ('ceo@example.com',     'owner'),
      ('cto@example.com',     'lead'),
      ('manager@example.com', 'member'),
      ('l3@example.com',      'member'),
      ('hr@example.com',      'viewer')
  ) AS v(email, role) ON true
  JOIN employees e ON e.email = v.email
ON CONFLICT (project_id, employee_id) DO NOTHING;

-- 1 valid downward task: Manager(4) -> L3(3)
INSERT INTO tasks (project_id, title, description, assigned_by, assigned_to, status, priority, due_date)
SELECT (SELECT id FROM projects WHERE name = 'Apollo Launch'),
       'Design API contract',
       'Draft v1 of the Apollo API contract.',
       (SELECT id FROM employees WHERE email = 'manager@example.com'),
       (SELECT id FROM employees WHERE email = 'l3@example.com'),
       'todo', 'high', CURRENT_DATE + INTERVAL '14 days'
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Design API contract');
