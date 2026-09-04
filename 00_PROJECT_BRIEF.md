# Office Management System — Project Brief (PostgreSQL)

## 1. Stack / Conventions
- PostgreSQL 15+, `TIMESTAMPTZ`, `BIGINT GENERATED ALWAYS AS IDENTITY` PKs.
- Statuses via `CHECK (...)`, not native ENUM.
- FKs with explicit `ON DELETE`: `RESTRICT` for master data, `CASCADE` for members/messages, `SET NULL` for manager/head/creator.
- Files: `db/01_core.sql, 02_projects.sql, 03_hr.sql, 04_collab_chat.sql, 05_triggers.sql, 06_indexes.sql, 07_seed.sql`

## 2. Locked Decisions
- Delegation: `assigned_by.rank >= assigned_to.rank` AND `assigned_by != assigned_to`.
- Chat: unified `conversations(type=direct|group)` + participants + messages + read receipts.
- HR is omnipresent support layer; any rank 1-6 can file ticket, assignee must be HR dept.
- Avoid reserved word `groups` -> use `app_groups`.

## 3. Hierarchy
`job_levels(rank PK)`: 6 Owner/CEO, 5 C-Suite (CTO,CFO,CRO,CIO), 4 Manager, 3 L-3 Senior/Staff, 2 L-2 Associate, 1 L-1 Junior.
`employees(id IDENTITY PK, first_name, last_name, email CITEXT UNIQUE CHECK LIKE '%@%', rank FK->job_levels RESTRICT, department_id FK->departments RESTRICT, manager_id FK->employees SET NULL, hire_date DATE DEFAULT CURRENT_DATE, is_active BOOL DEFAULT TRUE, created_at/updated_at, CHECK(id != manager_id))`. CEO `manager_id=NULL`.

## 4. Departments
`departments(id IDENTITY PK, name UNIQUE NOT NULL, description, head_id FK->employees SET NULL DEFERRABLE, created_at)`. Seed: Engineering, Sales, Finance, Marketing, HR, IT. Add `head_id` via ALTER after employees to break cycle.

## 5. Projects
`projects(id IDENTITY PK, name, owning_department_id FK RESTRICT, status CHECK(planned,active,on_hold,completed,cancelled) DEFAULT planned, created_by FK SET NULL, start_date, end_date CHECK(end_date>=start_date))`.
`project_members(project_id CASCADE, employee_id CASCADE, role CHECK(owner,lead,member,viewer,sponsor), joined_at, PK(project_id,employee_id))`.

## 6. Tasks (downward handover)
`tasks(id IDENTITY PK, project_id FK CASCADE, title, description, assigned_by FK RESTRICT, assigned_to FK RESTRICT, status CHECK(todo,in_progress,in_review,done,blocked,cancelled) DEFAULT todo, priority CHECK(low,medium,high,urgent) DEFAULT medium, due_date, created_at/updated_at, CHECK(assigned_by != assigned_to))`.
Rule enforced by trigger, not CHECK.

## 7. HR Tickets
`hr_tickets(id IDENTITY PK, requester_id FK CASCADE, assignee_id FK SET NULL NULL-allowed, subject, description, category CHECK(inquiry,grievance,leave,payroll,benefits,other), priority, status CHECK(open,triaged,in_progress,awaiting_employee,resolved,closed,rejected) DEFAULT open, created_at/updated_at/resolved_at CHECK(resolved_at>=created_at))`.
Trigger: `assignee.department='HR'`.

## 8. Groups + Chat (app-ready)
`app_groups(id IDENTITY PK, name, description, created_by SET NULL, visibility CHECK(public,private,department) DEFAULT private, department_id FK SET NULL NULL-allowed, created_at)`.
`group_memberships(group_id CASCADE, employee_id CASCADE, role CHECK(owner,admin,member) DEFAULT member, joined_at, PK(group_id,employee_id))`.
`conversations(id IDENTITY PK, type CHECK(direct,group), group_id UNIQUE FK->app_groups CASCADE NULL-allowed, title, created_at, CHECK((type='group' AND group_id IS NOT NULL) OR (type='direct' AND group_id IS NULL)))`.
`conversation_participants(conversation_id CASCADE, employee_id CASCADE, joined_at, last_read_at, PK(...))`.
`messages(id IDENTITY PK, conversation_id CASCADE, sender_id CASCADE, body TEXT CHECK(1..5000 chars), created_at, edited_at, is_deleted DEFAULT FALSE)`.
`message_reads(message_id CASCADE, employee_id CASCADE, read_at, PK(...))`.
Trigger: sender must be participant.

## 9. Triggers (05_triggers.sql)
1. `enforce_downward_delegation() BEFORE INSERT OR UPDATE OF assigned_by,assigned_to ON tasks`: compare ranks, `IF v_from < v_to RAISE EXCEPTION`.
2. `enforce_hr_assignee() BEFORE INSERT OR UPDATE OF assignee_id ON hr_tickets`: allow NULL, else check dept=HR.
3. `prevent_manager_cycle() BEFORE INSERT OR UPDATE OF manager_id ON employees`: recursive CTE walk, raise on cycle.
4. `set_updated_at() BEFORE UPDATE`: `NEW.updated_at=now()`.

## 10. Indexes (06_indexes.sql)
All FKs + `employees(rank), tasks(status), hr_tickets(status,category), messages(conversation_id,created_at DESC), messages(conversation_id,id DESC)` for pagination, partial `hr_tickets WHERE status='open'`, partial `employees WHERE is_active`.

## 11. Seed (07_seed.sql)
Levels 1-6, departments incl HR, chain: CEO(6) -> CTO(5) -> Manager(4) -> L3 -> L2 -> L1, 1 HR staffer, 1 sample project + members cross-dept + 1 valid task.

## 12. Acceptance Checks
- `L1 -> CEO task` must FAIL.
- `non-HR assignee` must FAIL.
- `manager_id=self` or cycle must FAIL.
- `psql -f 01..07` clean in order.

## 13. Next Action for Agent
Implement files in numeric order with header comments. Verify with above checks.
