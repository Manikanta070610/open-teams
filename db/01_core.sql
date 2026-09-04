-- 01_core.sql — Office Management System core: levels, departments, employees
-- PostgreSQL 15+ | TIMESTAMPTZ | BIGINT GENERATED ALWAYS AS IDENTITY PKs
-- Order: extension -> job_levels -> departments (no head_id) -> employees -> ALTER departments ADD head_id
-- Breaks the departments <-> employees cycle per brief §4.

CREATE EXTENSION IF NOT EXISTS citext;

-- Hierarchy master (§3): 6 Owner/CEO ... 1 L-1 Junior. rank is the PK.
CREATE TABLE job_levels (
    rank        INTEGER PRIMARY KEY CHECK (rank BETWEEN 1 AND 6),
    title       TEXT NOT NULL,
    description TEXT
);

-- Departments (§4) without head_id first to break the cycle.
CREATE TABLE departments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Employees (§3). CEO has manager_id = NULL.
CREATE TABLE employees (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    email         CITEXT NOT NULL UNIQUE CHECK (email LIKE '%@%'),
    rank          INTEGER NOT NULL REFERENCES job_levels (rank) ON DELETE RESTRICT,
    department_id BIGINT NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
    manager_id    BIGINT REFERENCES employees (id) ON DELETE SET NULL,
    hire_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id != manager_id)
);

-- Add department head afterwards (§4). DEFERRABLE so seed can set heads in one txn.
ALTER TABLE departments
    ADD COLUMN head_id BIGINT
        REFERENCES employees (id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED;
