-- 08_dept_governance.sql — Chief-only department management (rank >= 5)
-- Depends on: 01_core (departments, employees), 05_triggers (set_updated_at)
-- Rule: INSERT/UPDATE/DELETE ON departments allowed only for rank 5 (C-Suite) or 6 (Owner/CEO).
-- Actor is passed via SET LOCAL app.current_user_id = '<employee_id>' per transaction.
-- Writes without context fail closed. Seed rows (07) are grandfathered with created_by=NULL.

-- Audit columns (rerunnable)
ALTER TABLE departments ADD COLUMN IF NOT EXISTS created_by BIGINT
    REFERENCES employees (id) ON DELETE SET NULL;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_departments_created_by ON departments (created_by);

-- Enforcement function: handles INSERT / UPDATE / DELETE via TG_OP.
CREATE OR REPLACE FUNCTION enforce_dept_chief_only()
RETURNS trigger AS $$
DECLARE
    v_actor_txt TEXT := current_setting('app.current_user_id', true);
    v_actor_id  BIGINT;
    v_rank      INTEGER;
BEGIN
    IF v_actor_txt IS NULL OR v_actor_txt = '' THEN
        RAISE EXCEPTION 'departments: app.current_user_id login context required (fail closed)';
    END IF;
    BEGIN
        v_actor_id := v_actor_txt::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'departments: invalid app.current_user_id (%)', v_actor_txt;
    END;

    SELECT rank INTO v_rank FROM employees WHERE id = v_actor_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'departments: actor % does not exist', v_actor_id;
    END IF;
    IF v_rank < 5 THEN
        RAISE EXCEPTION 'departments: only rank >= 5 (C-Suite/CEO) can manage departments (actor % rank %)', v_actor_id, v_rank;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    -- INSERT: default created_by to actor; always stamp updated_at
    IF TG_OP = 'INSERT' AND NEW.created_by IS NULL THEN
        NEW.created_by := v_actor_id;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_departments_chief_ins ON departments;
CREATE TRIGGER trg_departments_chief_ins
    BEFORE INSERT ON departments
    FOR EACH ROW EXECUTE FUNCTION enforce_dept_chief_only();

DROP TRIGGER IF EXISTS trg_departments_chief_upd ON departments;
CREATE TRIGGER trg_departments_chief_upd
    BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION enforce_dept_chief_only();

DROP TRIGGER IF EXISTS trg_departments_chief_del ON departments;
CREATE TRIGGER trg_departments_chief_del
    BEFORE DELETE ON departments
    FOR EACH ROW EXECUTE FUNCTION enforce_dept_chief_only();
