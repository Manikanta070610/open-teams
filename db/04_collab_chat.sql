-- 04_collab_chat.sql — Groups + unified chat (§8)
-- Depends on: 01_core.sql. Avoids reserved word "groups" -> app_groups.
-- conversations(type=direct|group) + participants + messages + read receipts.

CREATE TABLE app_groups (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    created_by    BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    visibility    TEXT NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('public','private','department')),
    department_id BIGINT REFERENCES departments (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_memberships (
    group_id    BIGINT NOT NULL REFERENCES app_groups (id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, employee_id)
);

CREATE TABLE conversations (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type       TEXT NOT NULL CHECK (type IN ('direct','group')),
    group_id   BIGINT UNIQUE REFERENCES app_groups (id) ON DELETE CASCADE,
    title      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (type = 'group'  AND group_id IS NOT NULL) OR
        (type = 'direct' AND group_id IS NULL)
    )
);

CREATE TABLE conversation_participants (
    conversation_id BIGINT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    employee_id     BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_at    TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, employee_id)
);

CREATE TABLE messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender_id       BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ,
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE message_reads (
    message_id  BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, employee_id)
);
