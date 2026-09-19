-- 13_project_chat.sql — Per-project chat: whole-project group + DMs + custom groups.
-- Depends on: 01_core (employees), 02_projects (projects, project_members).
-- Fully rerunnable (CREATE TABLE IF NOT EXISTS / DROP TRIGGER IF EXISTS).
--
-- Model:
--   project_chat_threads: one row per conversation inside a project.
--     type='project' = the whole-project room (exactly one per project,
--       membership is implicit = all project_members, no rows needed in
--       project_chat_thread_members).
--     type='direct'  = 1-1 DM between two project members (exactly 2 rows
--       in thread_members; deduped per pair per project).
--     type='group'   = custom subgroup (2+ members, title required).
--   project_chat_thread_members: explicit membership for direct/group only.
--   project_chat_messages: messages in any thread; sender must be a project
--     member (and a thread member for direct/group — enforced by trigger).

CREATE TABLE IF NOT EXISTS project_chat_threads (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('project','direct','group')),
    title       TEXT,
    created_by  BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (type = 'project' AND title IS NULL) OR
        (type = 'direct'  AND title IS NULL) OR
        (type = 'group')
    )
);

-- Exactly one whole-project room per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_chat_threads_project_room
    ON project_chat_threads (project_id) WHERE type = 'project';

CREATE TABLE IF NOT EXISTS project_chat_thread_members (
    thread_id   BIGINT NOT NULL REFERENCES project_chat_threads (id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, employee_id)
);

CREATE TABLE IF NOT EXISTS project_chat_messages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id   BIGINT NOT NULL REFERENCES project_chat_threads (id) ON DELETE CASCADE,
    sender_id   BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,
    is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_project_chat_threads_project ON project_chat_threads (project_id);
CREATE INDEX IF NOT EXISTS idx_project_chat_members_employee ON project_chat_thread_members (employee_id);
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_thread_created ON project_chat_messages (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_thread_id ON project_chat_messages (thread_id, id DESC);

-- Sender must belong to the project; for direct/group threads they must
-- additionally be an explicit thread member (project room is implicit).
CREATE OR REPLACE FUNCTION enforce_project_chat_sender()
RETURNS trigger AS $$
DECLARE
    v_project BIGINT;
    v_type TEXT;
BEGIN
    SELECT t.project_id, t.type INTO v_project, v_type
      FROM project_chat_threads t WHERE t.id = NEW.thread_id;
    IF v_project IS NULL THEN
        RAISE EXCEPTION 'enforce_project_chat_sender: unknown thread %', NEW.thread_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM project_members pm
         WHERE pm.project_id = v_project AND pm.employee_id = NEW.sender_id
    ) THEN
        RAISE EXCEPTION 'enforce_project_chat_sender: sender % is not a member of project %', NEW.sender_id, v_project;
    END IF;
    IF v_type IN ('direct','group') AND NOT EXISTS (
        SELECT 1 FROM project_chat_thread_members tm
         WHERE tm.thread_id = NEW.thread_id AND tm.employee_id = NEW.sender_id
    ) THEN
        RAISE EXCEPTION 'enforce_project_chat_sender: sender % is not in thread %', NEW.sender_id, NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_chat_messages_sender ON project_chat_messages;
CREATE TRIGGER trg_project_chat_messages_sender
    BEFORE INSERT OR UPDATE OF thread_id, sender_id ON project_chat_messages
    FOR EACH ROW EXECUTE FUNCTION enforce_project_chat_sender();

-- Explicit thread members must all belong to the project.
CREATE OR REPLACE FUNCTION enforce_project_chat_membership()
RETURNS trigger AS $$
DECLARE
    v_project BIGINT;
BEGIN
    SELECT project_id INTO v_project
      FROM project_chat_threads WHERE id = NEW.thread_id;
    IF v_project IS NULL THEN
        RAISE EXCEPTION 'enforce_project_chat_membership: unknown thread %', NEW.thread_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM project_members pm
         WHERE pm.project_id = v_project AND pm.employee_id = NEW.employee_id
    ) THEN
        RAISE EXCEPTION 'enforce_project_chat_membership: employee % is not a member of project %', NEW.employee_id, v_project;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_chat_thread_members ON project_chat_thread_members;
CREATE TRIGGER trg_project_chat_thread_members
    BEFORE INSERT OR UPDATE OF thread_id, employee_id ON project_chat_thread_members
    FOR EACH ROW EXECUTE FUNCTION enforce_project_chat_membership();
