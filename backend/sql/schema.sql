-- ============================================================================
-- KiroFactory Database Schema (SQL Server / Azure SQL)
-- ============================================================================
-- Drop in reverse dependency order for clean re-creation
-- ============================================================================

DROP TABLE IF EXISTS agent_tabs;
DROP TABLE IF EXISTS task_tabs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS tabs;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS users;

-- ============================================================================
-- Users (authentication & API key storage)
-- ============================================================================

CREATE TABLE users (
    id                      INT             IDENTITY(1,1) PRIMARY KEY,
    email                   NVARCHAR(255)   NOT NULL UNIQUE,
    password_hash           NVARCHAR(MAX)   NOT NULL,
    kiro_api_key_encrypted  NVARCHAR(MAX)   NOT NULL,
    created_at              DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    updated_at              DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================================
-- Settings (key-value config, e.g. registration_enabled)
-- ============================================================================

CREATE TABLE settings (
    [key]       NVARCHAR(100)   NOT NULL PRIMARY KEY,
    value       NVARCHAR(MAX)   NOT NULL,
    updated_at  DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

INSERT INTO settings ([key], value) VALUES ('registration_enabled', 'true');

-- ============================================================================
-- Tabs (project workspaces, scoped per user)
-- ============================================================================

CREATE TABLE tabs (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    name            NVARCHAR(100)   NOT NULL,
    repository_url  NVARCHAR(500)   NULL,
    columns_json    NVARCHAR(MAX)   NOT NULL DEFAULT '["todo","in-progress","developed"]',
    sort_order      INT             NOT NULL DEFAULT 0,
    user_id         INT             NULL REFERENCES users(id),
    created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

INSERT INTO tabs (name) VALUES ('generic');

-- ============================================================================
-- Tasks
-- ============================================================================

CREATE TABLE tasks (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    title           NVARCHAR(200)   NOT NULL,
    priority        TINYINT         NOT NULL CHECK (priority BETWEEN 1 AND 4),
    type            VARCHAR(20)     NOT NULL CHECK (type IN ('improvement', 'bug', 'feature')),
    state           VARCHAR(50)     NOT NULL DEFAULT 'todo',
    description     NVARCHAR(MAX)   NOT NULL DEFAULT '',
    files           NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
    origin          VARCHAR(20)     NOT NULL CHECK (origin IN ('user', 'ai', 'user-assisted')),
    created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    updated_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_tasks_todo_priority ON tasks (priority, origin)
WHERE state = 'todo';

-- ============================================================================
-- Junction: tasks <-> tabs (many-to-many)
-- ============================================================================

CREATE TABLE task_tabs (
    task_id     INT NOT NULL,
    tab_id      INT NOT NULL,
    PRIMARY KEY (task_id, tab_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

-- ============================================================================
-- Agents (AI agent configurations, scoped per user)
-- ============================================================================

CREATE TABLE agents (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    name            NVARCHAR(100)   NOT NULL,
    description     NVARCHAR(MAX)   NOT NULL DEFAULT '',
    prompt          NVARCHAR(MAX)   NOT NULL DEFAULT '',
    tools           NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
    allowed_tools   NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
    tools_settings  NVARCHAR(MAX)   NOT NULL DEFAULT '{}',
    resources       NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
    user_id         INT             NULL REFERENCES users(id),
    created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    updated_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================================
-- Junction: agents <-> tabs (many-to-many)
-- ============================================================================

CREATE TABLE agent_tabs (
    agent_id    INT   NOT NULL,
    tab_id      INT   NOT NULL,
    PRIMARY KEY (agent_id, tab_id),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

-- ============================================================================
-- Sessions (ACP agent sessions, scoped per user, persisted for auto-restart)
-- ============================================================================

CREATE TABLE sessions (
    id                  NVARCHAR(16)    NOT NULL PRIMARY KEY,
    name                NVARCHAR(200)   NOT NULL,
    agent               NVARCHAR(100)   NOT NULL,
    status              VARCHAR(20)     NOT NULL DEFAULT 'stopped',
    prompt              NVARCHAR(MAX)   NOT NULL DEFAULT '',
    interactive         BIT             NOT NULL DEFAULT 1,
    loop                BIT             NOT NULL DEFAULT 0,
    runs                INT             NOT NULL DEFAULT 0,
    interval_seconds    INT             NOT NULL DEFAULT 10,
    cwd                 NVARCHAR(500)   NOT NULL,
    timeout_seconds     INT             NOT NULL DEFAULT 0,
    model               NVARCHAR(100)   NULL,
    mcp_servers         NVARCHAR(MAX)   NULL,
    tab_ids             NVARCHAR(MAX)   NULL,
    user_id             INT             NULL REFERENCES users(id),
    created_at          DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    started_at          DATETIME2       NULL,
    current_task_id     INT             NULL,
    current_activity    NVARCHAR(MAX)   NULL,
    mcp_config_override NVARCHAR(MAX)   NULL,
    -- Permanent, agentless "Chat" session every user gets on registration.
    -- Pinned sessions are always sorted first in the UI and cannot be deleted.
    pinned              BIT             NOT NULL DEFAULT 0
);
