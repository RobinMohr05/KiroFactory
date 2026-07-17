import { getPool, isDbAvailable, sql } from "./connection.js";

const SCHEMA_SQL = `
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
    type            VARCHAR(20)     NOT NULL CHECK (type IN ('improvement', 'problem', 'idea')),
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
`;

/**
 * Runs the database migration if needed.
 * Returns true if migration succeeded (or was skipped), false if the DB is unavailable.
 * Does NOT throw — the caller can decide how to proceed.
 */
export async function runMigration(): Promise<boolean> {
  if (!isDbAvailable()) {
    console.warn("[migrate] ⚠ Database not available — skipping migration.");
    return false;
  }

  try {
    const pool = await getPool();

    const result = await pool.request().query<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME = 'boards'
    `);

    const exists = result.recordset[0].cnt > 0;

    if (exists) {
      console.log("[migrate] Tables already exist — skipping migration.");
      return true;
    }

    console.log("[migrate] Creating tables...");
    await pool.request().batch(SCHEMA_SQL);
    console.log("[migrate] Migration complete.");
    return true;
  } catch (err: any) {
    console.warn(`[migrate] ⚠ Migration failed: ${err.message || err}`);
    console.warn("[migrate] ⚠ Database features will be unavailable until the connection is restored.");
    return false;
  }
}

// Run directly: npx tsx src/db/migrate.ts
const isMain =
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`;

if (isMain) {
  runMigration()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error("[migrate] Migration failed:", err);
      process.exit(1);
    });
}
