-- Drop in reverse dependency order
DROP TABLE IF EXISTS task_boards;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS boards;

-- Boards
CREATE TABLE boards (
    id          INT             IDENTITY(1,1) PRIMARY KEY,
    name        NVARCHAR(100)   NOT NULL UNIQUE,
    created_at  DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

INSERT INTO boards (name) VALUES ('generic');

-- Tasks
CREATE TABLE tasks (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    title           NVARCHAR(200)   NOT NULL,
    priority        TINYINT         NOT NULL CHECK (priority BETWEEN 1 AND 4),
    type            VARCHAR(20)     NOT NULL CHECK (type IN ('improvement', 'bug', 'feature')),
    state           VARCHAR(20)     NOT NULL CHECK (state IN ('todo', 'in-progress', 'developed')),
    description     NVARCHAR(MAX)   NOT NULL DEFAULT '',
    files           NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
    origin          VARCHAR(20)     NOT NULL CHECK (origin IN ('user', 'ai', 'user-assisted')),
    created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    updated_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_tasks_todo_priority ON tasks (priority, origin)
WHERE state = 'todo';

-- Junction: tasks <-> boards (many-to-many)
CREATE TABLE task_boards (
    task_id     INT NOT NULL,
    board_id    INT NOT NULL,
    PRIMARY KEY (task_id, board_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);
