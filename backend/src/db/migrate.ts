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
`;

/**
 * Runs incremental upgrades on an existing database.
 */
async function runUpgrades(pool: sql.ConnectionPool): Promise<void> {
  // Upgrade 1: rename task type 'problem' → 'bug'
  // Check if the old constraint still allows 'problem'
  const constraintResult = await pool.request().query(`
    SELECT cc.CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
    JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
      ON cc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
    WHERE ccu.TABLE_NAME = 'tasks'
      AND ccu.COLUMN_NAME = 'type'
      AND cc.CHECK_CLAUSE LIKE '%problem%'
  `);

  if (constraintResult.recordset.length > 0) {
    console.log("[migrate] Upgrading: renaming task type 'problem' → 'bug'...");
    const constraintName = constraintResult.recordset[0].CONSTRAINT_NAME;

    // Drop old constraint first so the UPDATE is allowed
    await pool.request().query(`
      ALTER TABLE tasks DROP CONSTRAINT [${constraintName}]
    `);

    // Update existing rows
    await pool.request().query(`
      UPDATE tasks SET type = 'bug' WHERE type = 'problem'
    `);

    // Add new constraint
    await pool.request().query(`
      ALTER TABLE tasks ADD CONSTRAINT CK_tasks_type
        CHECK (type IN ('improvement', 'bug', 'feature'))
    `);
    console.log("[migrate] Upgrade complete: task type 'problem' → 'bug'.");
  }

  // Upgrade 2: rename task type 'idea' → 'feature'
  // Check if the current constraint still allows 'idea'
  const ideaConstraintResult = await pool.request().query(`
    SELECT cc.CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
    JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
      ON cc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
    WHERE ccu.TABLE_NAME = 'tasks'
      AND ccu.COLUMN_NAME = 'type'
      AND cc.CHECK_CLAUSE LIKE '%idea%'
  `);

  if (ideaConstraintResult.recordset.length > 0) {
    console.log("[migrate] Upgrading: renaming task type 'idea' → 'feature'...");
    const constraintName = ideaConstraintResult.recordset[0].CONSTRAINT_NAME;

    // Drop old constraint first so the UPDATE is allowed
    await pool.request().query(`
      ALTER TABLE tasks DROP CONSTRAINT [${constraintName}]
    `);

    // Update existing rows
    await pool.request().query(`
      UPDATE tasks SET type = 'feature' WHERE type = 'idea'
    `);

    // Add new constraint
    await pool.request().query(`
      ALTER TABLE tasks ADD CONSTRAINT CK_tasks_type
        CHECK (type IN ('improvement', 'bug', 'feature'))
    `);
    console.log("[migrate] Upgrade complete: task type 'idea' → 'feature'.");
  }
}

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
      console.log("[migrate] Tables already exist — running upgrades...");
      await runUpgrades(pool);
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
