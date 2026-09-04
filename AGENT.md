# agent.md — Working memory for this project (Office Management System, PostgreSQL)

> Read this first on every new session. Update the Changelog when you change schema or rules.

## 1. What this project is
- Source of truth: `00_PROJECT_BRIEF.md` (PostgreSQL 15+, office mgmt: hierarchy, departments,
  projects/tasks with downward delegation, HR tickets, groups + unified chat).
- Schema lives in `db/` and must apply cleanly in numeric order: `psql -f 01..09`.
- Conventions: `TIMESTAMPTZ`, `BIGINT GENERATED ALWAYS AS IDENTITY` PKs, statuses via
  `CHECK (...)` (no native ENUM), explicit `ON DELETE` (RESTRICT master / CASCADE members-messages /
  SET NULL manager-head-creator), `app_groups` (not `groups`).

## 2. File map
| File | Contents |
|---|---|
| `db/01_core.sql` | `citext` ext, `job_levels(rank PK 1-6)`, `departments` (head_id added via ALTER to break cycle), `employees` |
| `db/02_projects.sql` | `projects`, `project_members`, `tasks` (self-assign CHECK; rank rule in trigger) |
| `db/03_hr.sql` | `hr_tickets` (assignee HR-only via trigger) |
| `db/04_collab_chat.sql` | `app_groups`, `group_memberships`, `conversations`, `conversation_participants`, `messages`, `message_reads` |
| `db/05_triggers.sql` | `enforce_downward_delegation`, `enforce_hr_assignee`, `prevent_manager_cycle`, `set_updated_at`, `enforce_message_sender` |
| `db/06_indexes.sql` | All FK indexes, `employees(rank)`, `tasks(status)`, `hr_tickets(status,category)`, chat pagination, partial `open`/`active` |
| `db/07_seed.sql` | Levels 1-6, 6 depts, chain CEO(6)->CTO(5)->Mgr(4)->L3->L2->L1 + HR staffer, heads, 1 project + 5 cross-dept members + 1 valid task. Rerunnable |
| `db/08_dept_governance.sql` | Chief-only dept rule (rank >= 5): `created_by`, `updated_at`, `enforce_dept_chief_only()` on INSERT/UPDATE/DELETE via `app.current_user_id` |
| `db/09_admin.sql` | `allowed_email_domains` + `enforce_employee_email_domain()` (exact-domain, fail closed; seeds `example.com`), `admin_credentials` (scrypt hash, CASCADE), `admin_sessions` (SHA-256 opaque token, expiry), `idx_employees_last_name`. Fully rerunnable |
| `backend/src/db.js` | Shared `pg` Pool (env-driven: DATABASE_URL or PGHOST/PGPORT/...) |
| `backend/src/crypto.js` | scrypt hash/verify (node:crypto only), opaque token + SHA-256, constant-time setup-token compare |
| `backend/src/admin.js` | `requireAdmin` (session + active + rank-6-or-IT, `Cache-Control: no-store`), login rate limit (5/min/IP), `/api/admin/*`: bootstrap/login/logout, email-domains CRUD, departments list, employees paginated CRUD, overview |
| `backend/test/admin.test.js` | 12 API tests (ephemeral port, self-cleaning; needs schema 01..09 + SETUP_TOKEN) |
| `frontend/src/adminApi.js` | fetch helper, bearer token in module memory only |
| `frontend/src/AdminPanel.jsx` | Minimal login + first-time setup + 4 tabs (Overview/Employees/Domains/Access), abortable fetches, native confirm() on destructive actions |

## 3. Locked decisions
- Delegation: `assigned_by.rank >= assigned_to.rank AND assigned_by != assigned_to` (trigger, not CHECK).
- Chat: unified `conversations(type=direct|group)` + participants + messages + read receipts; sender must be participant.
- HR: any rank 1-6 files; assignee NULL or HR-dept only.
- Departments: unlimited count (`name UNIQUE`); writes restricted to rank >= 5 (C-Suite + CEO).
  Actor context: app must `SET LOCAL app.current_user_id = '<employee_id>'` per txn; fails closed without it.

## 4. Local verification setup (important)
- System Postgres (`/var/run/postgresql:5432`) is NOT usable: peer-auth, no sudo, role `mani607` missing.
- Use the disposable cluster instead:
  - Binaries: `/usr/lib/postgresql/18/bin` (add to PATH)
  - Data: `/tmp/opencode/pgdata`, socket dir `/tmp/opencode`, port `5434`, superuser `postgres` (trust)
  - Start: `pg_ctl -D /tmp/opencode/pgdata -l /tmp/opencode/pg.log -o "-p 5434 -k /tmp/opencode" start`
  - Conn: `export PGHOST=/tmp/opencode PGPORT=5434 PGUSER=postgres`
- Fresh-build command (from workspace root):
  `dropdb --if-exists office_mgmt_final && createdb office_mgmt_final && for f in db/01_core.sql db/02_projects.sql db/03_hr.sql db/04_collab_chat.sql db/05_triggers.sql db/06_indexes.sql db/07_seed.sql db/08_dept_governance.sql db/09_admin.sql; do psql -d office_mgmt_final -v ON_ERROR_STOP=1 -q -f "$f"; done`
- Expected seed counts: `levels 6 / depts 6 / emps 7 / projs 1 / tasks 1 / domains 1`.
- Backend API tests need the schema + a setup token:
  `export PGHOST=/tmp/opencode PGPORT=5434 PGUSER=postgres PGDATABASE=office_mgmt_final SETUP_TOKEN=<any>; npm test --prefix backend`
  (tests create/delete their own owner/employees/domains; seed left untouched).
- Admin bootstrap (first credential): `POST /api/admin/bootstrap {email,password,setupToken}` with `SETUP_TOKEN` env; eligible = active rank-6 or IT. Unset SETUP_TOKEN after.
- Known harmless noise: first-run `NOTICE: trigger ... does not exist, skipping` from `DROP TRIGGER IF EXISTS`.

## 5. How to test (temp files, always delete after)
- Write temp test as `db/99_verify_*_TEMP.sql`, run `psql -v ON_ERROR_STOP=1 -f <file>`, confirm
  NOTICEs, then `rm` the file. Never leave `99_*` in the repo; DB must end with seed data only.
- Dept tests need actor context inside DO blocks via `PERFORM set_config('app.current_user_id', '<id>', false);`
  (`SET LOCAL` does not survive inside functions). Reset with `set_config(..., '', false)`.
- Core acceptance: L1->CEO task FAILs / CEO->L1 ok; non-HR assignee FAILs / HR+NULL ok;
  self-manager + cycle FAILs; outsider message FAILs; bad conversation combos FAIL;
  no-context dept write FAILs; Mgr/Jr dept write FAILs; CTO/CEO dept insert/update/delete PASS.

## 6. Changelog
- 2026-09-04: Implemented `db/01..07.sql` per brief §1-13; verified clean build + acceptance tests (temp file deleted).
- 2026-09-04: Added `db/08_dept_governance.sql` (chief-only dept management, rank >= 5, DB trigger);
  fixed `END IF` -> `END` syntax bug in exception block; verified clean `01..08` build + dept tests (temp file deleted).
- 2026-09-04: Created this `agent.md`.
- 2026-09-05: Added `db/09_admin.sql` (domain allowlist + trigger, credentials, sessions, last_name index; seeds `example.com`); backend admin API (`db.js`/`crypto.js`/`admin.js`, scrypt + opaque sessions + 5/min login limit, Owner-or-IT only) with 12 self-cleaning tests; minimal 4-tab `AdminPanel.jsx` (token in memory, abortable fetches); CI backend job now migrates a Postgres service DB; verified clean `01..09` build + acceptance (temp file deleted) + 13/13 tests + vite build.

## 7. Open items / next steps
- [ ] Decide if `UPDATE head_id`-only changes should stay chief-only or become delegable.
- [ ] Wire app to set `app.current_user_id` on every dept-write path (else writes fail closed).
- [ ] Consider documenting superuser/`TRUNCATE` bypass as out of scope.
