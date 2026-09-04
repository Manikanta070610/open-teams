-- 05_triggers.sql — Enforcement triggers (§9) + chat sender rule (§8)
-- Depends on: 01_core, 02_projects, 03_hr, 04_collab_chat

-- 1. Downward delegation (§2, §6): assigned_by.rank >= assigned_to.rank.
CREATE OR REPLACE FUNCTION enforce_downward_delegation()
RETURNS trigger AS $$
DECLARE
    v_from INTEGER;
    v_to   INTEGER;
BEGIN
    SELECT rank INTO v_from FROM employees WHERE id = NEW.assigned_by;
    SELECT rank INTO v_to   FROM employees WHERE id = NEW.assigned_to;
    IF v_from IS NULL OR v_to IS NULL THEN
        RAISE EXCEPTION 'enforce_downward_delegation: unknown assigner (%) or assignee (%)', NEW.assigned_by, NEW.assigned_to;
    END IF;
    IF v_from < v_to THEN
        RAISE EXCEPTION 'enforce_downward_delegation: rank % cannot assign to rank % (upward delegation forbidden)', v_from, v_to;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_downward_delegation ON tasks;
CREATE TRIGGER trg_tasks_downward_delegation
    BEFORE INSERT OR UPDATE OF assigned_by, assigned_to ON tasks
    FOR EACH ROW EXECUTE FUNCTION enforce_downward_delegation();

-- 2. HR assignee must belong to HR department (§7). NULL allowed (unassigned).
CREATE OR REPLACE FUNCTION enforce_hr_assignee()
RETURNS trigger AS $$
DECLARE
    v_dept TEXT;
BEGIN
    IF NEW.assignee_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT d.name INTO v_dept
      FROM employees e
      JOIN departments d ON d.id = e.department_id
     WHERE e.id = NEW.assignee_id;
    IF v_dept IS NULL THEN
        RAISE EXCEPTION 'enforce_hr_assignee: assignee % does not exist', NEW.assignee_id;
    ELSIF v_dept <> 'HR' THEN
        RAISE EXCEPTION 'enforce_hr_assignee: assignee % is in % department, must be HR', NEW.assignee_id, v_dept;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hr_tickets_assignee ON hr_tickets;
CREATE TRIGGER trg_hr_tickets_assignee
    BEFORE INSERT OR UPDATE OF assignee_id ON hr_tickets
    FOR EACH ROW EXECUTE FUNCTION enforce_hr_assignee();

-- 3. Prevent manager cycles (§9.3): walk up the chain, raise if we loop back.
CREATE OR REPLACE FUNCTION prevent_manager_cycle()
RETURNS trigger AS $$
BEGIN
    IF NEW.manager_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.manager_id = NEW.id THEN
        RAISE EXCEPTION 'prevent_manager_cycle: employee cannot manage self (%)', NEW.id;
    END IF;
    IF EXISTS (
        WITH RECURSIVE chain(id) AS (
            SELECT NEW.manager_id
            UNION ALL
            SELECT e.manager_id
              FROM employees e
              JOIN chain c ON c.id = e.id
             WHERE e.manager_id IS NOT NULL
        )
        SELECT 1 FROM chain WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'prevent_manager_cycle: manager assignment creates a cycle for employee %', NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employees_manager_cycle ON employees;
CREATE TRIGGER trg_employees_manager_cycle
    BEFORE INSERT OR UPDATE OF manager_id ON employees
    FOR EACH ROW EXECUTE FUNCTION prevent_manager_cycle();

-- 4. Generic updated_at stamper (§9.4).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employees_updated_at ON employees;
CREATE TRIGGER trg_employees_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_tickets_updated_at ON hr_tickets;
CREATE TRIGGER trg_hr_tickets_updated_at
    BEFORE UPDATE ON hr_tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. Chat rule (§8): message sender must be a conversation participant.
CREATE OR REPLACE FUNCTION enforce_message_sender()
RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM conversation_participants cp
         WHERE cp.conversation_id = NEW.conversation_id
           AND cp.employee_id = NEW.sender_id
    ) THEN
        RAISE EXCEPTION 'enforce_message_sender: sender % is not a participant of conversation %', NEW.sender_id, NEW.conversation_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_sender ON messages;
CREATE TRIGGER trg_messages_sender
    BEFORE INSERT OR UPDATE OF conversation_id, sender_id ON messages
    FOR EACH ROW EXECUTE FUNCTION enforce_message_sender();
