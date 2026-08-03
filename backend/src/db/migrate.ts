import { getPool, isDbAvailable, sql } from "./connection.js";

const SCHEMA_SQL = `
-- Tabs (formerly boards)
CREATE TABLE tabs (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    name            NVARCHAR(100)   NOT NULL UNIQUE,
    repository_url  NVARCHAR(500)   NULL,
    columns_json    NVARCHAR(MAX)   NOT NULL DEFAULT '["todo","in-progress","developed"]',
    created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

INSERT INTO tabs (name) VALUES ('generic');

-- Tasks
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

-- Junction: tasks <-> tabs (many-to-many)
CREATE TABLE task_tabs (
    task_id     INT NOT NULL,
    tab_id      INT NOT NULL,
    PRIMARY KEY (task_id, tab_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

-- Junction: agents <-> tabs (many-to-many)
CREATE TABLE agent_tabs (
    agent_name  NVARCHAR(100)   NOT NULL,
    tab_id      INT             NOT NULL,
    PRIMARY KEY (agent_name, tab_id),
    FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
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

  // Upgrade 3: Add agent_boards junction table (agents ↔ boards many-to-many)
  const agentBoardsExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME IN ('agent_boards', 'agent_tabs')
  `);

  if (agentBoardsExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: creating agent_boards junction table...");
    // Determine if tables are still called 'boards' or already renamed to 'tabs'
    const boardsOrTabs = await pool.request().query(`
      SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'boards'
    `);
    const parentTable = boardsOrTabs.recordset[0].cnt > 0 ? 'boards' : 'tabs';
    const junctionName = parentTable === 'boards' ? 'agent_boards' : 'agent_tabs';
    const colName = parentTable === 'boards' ? 'board_id' : 'tab_id';
    try {
      await pool.request().query(`
        CREATE TABLE ${junctionName} (
          agent_name  NVARCHAR(100)   NOT NULL,
          ${colName}  INT             NOT NULL,
          PRIMARY KEY (agent_name, ${colName}),
          FOREIGN KEY (${colName}) REFERENCES ${parentTable}(id) ON DELETE CASCADE
        )
      `);
      console.log(`[migrate] Upgrade complete: ${junctionName} table created.`);
    } catch (e: any) {
      console.warn(`[migrate] ⚠ Could not create agent junction table: ${e.message}. Continuing...`);
    }
  }

  // Upgrade 4: Add agents table (store agent definitions in the database)
  const agentsTableExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = 'agents'
  `);

  if (agentsTableExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: creating agents table...");
    await pool.request().query(`
      CREATE TABLE agents (
        name            NVARCHAR(100)   NOT NULL PRIMARY KEY,
        description     NVARCHAR(MAX)   NOT NULL DEFAULT '',
        prompt          NVARCHAR(MAX)   NOT NULL DEFAULT '',
        tools           NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
        allowed_tools   NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
        tools_settings  NVARCHAR(MAX)   NOT NULL DEFAULT '{}',
        resources       NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
        created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
        updated_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
      )
    `);
    console.log("[migrate] Upgrade complete: agents table created.");

    // Add FK from agent junction table to agents table
    try {
      // Table might be agent_boards or agent_tabs depending on whether rename already ran
      const junctionExists = await pool.request().query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN ('agent_boards', 'agent_tabs')
      `);
      if (junctionExists.recordset.length > 0) {
        const jTable = junctionExists.recordset[0].TABLE_NAME;
        await pool.request().query(`
          DELETE FROM ${jTable} WHERE agent_name NOT IN (SELECT name FROM agents)
        `);
        await pool.request().query(`
          ALTER TABLE ${jTable}
          ADD CONSTRAINT FK_${jTable}_agents
          FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
        `);
        console.log(`[migrate] Added FK constraint from ${jTable} to agents.`);
      }
    } catch (fkErr: any) {
      console.warn(`[migrate] ⚠ Could not add FK constraint: ${fkErr.message}`);
    }
  }

  // Upgrade 5: Add columns_json to boards/tabs table + relax state CHECK constraint
  const columnsColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN ('boards', 'tabs') AND COLUMN_NAME = 'columns_json'
  `);

  if (columnsColExists.recordset[0].cnt === 0) {
    // Determine current table name
    const boardsCheck = await pool.request().query(`SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'boards'`);
    const tblName = boardsCheck.recordset[0].cnt > 0 ? 'boards' : 'tabs';
    console.log(`[migrate] Upgrading: adding columns_json to ${tblName} table...`);
    try {
      await pool.request().query(`
        ALTER TABLE ${tblName}
        ADD columns_json NVARCHAR(MAX) NOT NULL DEFAULT '["todo","in-progress","developed"]'
      `);
      console.log(`[migrate] Upgrade complete: columns_json added to ${tblName}.`);
    } catch (e: any) {
      console.warn(`[migrate] ⚠ Could not add columns_json: ${e.message}. Continuing...`);
    }
  }

  // Drop the state CHECK constraint to allow custom column names
  const stateConstraintResult = await pool.request().query(`
    SELECT cc.CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
    JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
      ON cc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
    WHERE ccu.TABLE_NAME = 'tasks'
      AND ccu.COLUMN_NAME = 'state'
  `);

  if (stateConstraintResult.recordset.length > 0) {
    const constraintName = stateConstraintResult.recordset[0].CONSTRAINT_NAME;
    console.log(`[migrate] Upgrading: dropping state CHECK constraint (${constraintName})...`);
    await pool.request().query(`ALTER TABLE tasks DROP CONSTRAINT [${constraintName}]`);
    console.log("[migrate] Upgrade complete: state CHECK constraint dropped (custom columns allowed).");
  }

  // Widen state column from VARCHAR(20) to VARCHAR(50) to support longer custom column names
  const stateColInfo = await pool.request().query(`
    SELECT CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tasks' AND COLUMN_NAME = 'state'
  `);

  if (stateColInfo.recordset.length > 0 && stateColInfo.recordset[0].CHARACTER_MAXIMUM_LENGTH < 50) {
    console.log("[migrate] Upgrading: widening tasks.state column to VARCHAR(50)...");
    try {
      // Drop filtered index that references the state column (it blocks ALTER COLUMN)
      await pool.request().query(`
        IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tasks_todo_priority' AND object_id = OBJECT_ID('tasks'))
        DROP INDEX IX_tasks_todo_priority ON tasks
      `);
      // Drop any default constraints on state column
      const defaultConstraints = await pool.request().query(`
        SELECT dc.name
        FROM sys.default_constraints dc
        JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
        WHERE c.object_id = OBJECT_ID('tasks') AND c.name = 'state'
      `);
      for (const row of defaultConstraints.recordset) {
        await pool.request().query(`ALTER TABLE tasks DROP CONSTRAINT [${row.name}]`);
      }
      await pool.request().query(`ALTER TABLE tasks ALTER COLUMN state VARCHAR(50) NOT NULL`);
      // Re-add default
      await pool.request().query(`ALTER TABLE tasks ADD DEFAULT 'todo' FOR state`);
      // Recreate the index without the filter
      await pool.request().query(`CREATE INDEX IX_tasks_todo_priority ON tasks (priority, origin)`);
      console.log("[migrate] Upgrade complete: tasks.state widened to VARCHAR(50).");
    } catch (e: any) {
      console.warn(`[migrate] ⚠ Could not widen state column: ${e.message}. Continuing...`);
    }
  }

  // Upgrade 6: Rename boards → tabs, task_boards → task_tabs, agent_boards → agent_tabs
  // and add repository_url column to the tabs table.
  const tabsTableExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = 'tabs'
  `);

  if (tabsTableExists.recordset[0].cnt === 0) {
    // Only rename if 'boards' still exists (otherwise it was a fresh install with new schema)
    const boardsStillExists = await pool.request().query(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME = 'boards'
    `);

    if (boardsStillExists.recordset[0].cnt > 0) {
      console.log("[migrate] Upgrading: renaming boards → tabs...");

      // Drop FK constraints that reference boards before renaming
      // agent_boards → boards FK
      try {
        const fks = await pool.request().query(`
          SELECT fk.name AS fk_name, OBJECT_NAME(fk.parent_object_id) AS table_name
          FROM sys.foreign_keys fk
          WHERE OBJECT_NAME(fk.referenced_object_id) = 'boards'
        `);
        for (const fk of fks.recordset) {
          await pool.request().query(`ALTER TABLE [${fk.table_name}] DROP CONSTRAINT [${fk.fk_name}]`);
        }
      } catch (e: any) {
        console.warn(`[migrate] Warning dropping FKs: ${e.message}`);
      }

      // Rename tables
      await pool.request().query(`EXEC sp_rename 'boards', 'tabs'`);
      await pool.request().query(`EXEC sp_rename 'task_boards', 'task_tabs'`);
      await pool.request().query(`EXEC sp_rename 'agent_boards', 'agent_tabs'`);

      // Rename columns in junction tables
      await pool.request().query(`EXEC sp_rename 'task_tabs.board_id', 'tab_id', 'COLUMN'`);
      await pool.request().query(`EXEC sp_rename 'agent_tabs.board_id', 'tab_id', 'COLUMN'`);

      // Re-add FK constraints with new names
      await pool.request().query(`
        ALTER TABLE task_tabs
        ADD CONSTRAINT FK_task_tabs_tasks FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            CONSTRAINT FK_task_tabs_tabs FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
      `);
      await pool.request().query(`
        ALTER TABLE agent_tabs
        ADD CONSTRAINT FK_agent_tabs_tabs FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
      `);
      // Re-add agent FK if agents table exists
      const agentsExists2 = await pool.request().query(`
        SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'agents'
      `);
      if (agentsExists2.recordset[0].cnt > 0) {
        try {
          await pool.request().query(`
            ALTER TABLE agent_tabs
            ADD CONSTRAINT FK_agent_tabs_agents FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
          `);
        } catch (e: any) {
          console.warn(`[migrate] Could not add agent FK: ${e.message}`);
        }
      }

      console.log("[migrate] Upgrade complete: boards → tabs, task_boards → task_tabs, agent_boards → agent_tabs.");
    }
  }

  // Add repository_url column to tabs table if not present
  const repoUrlColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tabs' AND COLUMN_NAME = 'repository_url'
  `);

  if (repoUrlColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding repository_url to tabs table...");
    await pool.request().query(`
      ALTER TABLE tabs
      ADD repository_url NVARCHAR(500) NULL
    `);
    console.log("[migrate] Upgrade complete: repository_url added to tabs.");
  }

  // Upgrade 7: Add sort_order column to tabs table for user-defined tab ordering
  const sortOrderColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tabs' AND COLUMN_NAME = 'sort_order'
  `);

  if (sortOrderColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding sort_order to tabs table...");
    await pool.request().query(`
      ALTER TABLE tabs
      ADD sort_order INT NOT NULL DEFAULT 0
    `);
    // Initialize sort_order based on current name ordering
    await pool.request().query(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY name ASC) - 1 AS rn
        FROM tabs
      )
      UPDATE tabs SET sort_order = ordered.rn
      FROM tabs INNER JOIN ordered ON tabs.id = ordered.id
    `);
    console.log("[migrate] Upgrade complete: sort_order added to tabs.");
  }

  // Upgrade 8: Move all tasks from "generic" tab to "Vibecode Heaven" tab
  const genericTab = await pool.request().query(`
    SELECT id FROM tabs WHERE name = 'generic'
  `);

  if (genericTab.recordset.length > 0) {
    const genericId = genericTab.recordset[0].id as number;

    // Ensure the "Vibecode Heaven" tab exists (create if needed)
    let kiroFactoryTab = await pool.request().query(`
      SELECT id FROM tabs WHERE name = 'Vibecode Heaven'
    `);

    if (kiroFactoryTab.recordset.length === 0) {
      console.log('[migrate] Upgrading: creating "Vibecode Heaven" tab...');
      await pool.request().query(`INSERT INTO tabs (name) VALUES ('Vibecode Heaven')`);
      kiroFactoryTab = await pool.request().query(`
        SELECT id FROM tabs WHERE name = 'KiroFactory'
      `);
    }

    const kfId = kiroFactoryTab.recordset[0].id as number;

    // Check if there are tasks assigned to generic that aren't already on KiroFactory
    const tasksToMove = await pool.request()
      .input("genericId", sql.Int, genericId)
      .input("kfId", sql.Int, kfId)
      .query(`
        SELECT task_id FROM task_tabs
        WHERE tab_id = @genericId
          AND task_id NOT IN (SELECT task_id FROM task_tabs WHERE tab_id = @kfId)
      `);

    if (tasksToMove.recordset.length > 0) {
      console.log(`[migrate] Upgrading: moving ${tasksToMove.recordset.length} task(s) from "generic" to "KiroFactory"...`);

      // Assign tasks to KiroFactory
      for (const row of tasksToMove.recordset) {
        await pool.request()
          .input("taskId", sql.Int, row.task_id)
          .input("tabId", sql.Int, kfId)
          .query(`INSERT INTO task_tabs (task_id, tab_id) VALUES (@taskId, @tabId)`);
      }

      // Remove tasks from generic
      await pool.request()
        .input("genericId2", sql.Int, genericId)
        .query(`DELETE FROM task_tabs WHERE tab_id = @genericId2`);

      console.log(`[migrate] Upgrade complete: moved tasks from "generic" to "KiroFactory".`);
    }
  }

  // Upgrade 9: Add users table and settings table
  const usersTableExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = 'users'
  `);

  if (usersTableExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: creating users table...");
    await pool.request().query(`
      CREATE TABLE users (
        id                      INT             IDENTITY(1,1) PRIMARY KEY,
        email                   NVARCHAR(255)   NOT NULL UNIQUE,
        password_hash           NVARCHAR(MAX)   NOT NULL,
        kiro_api_key_encrypted  NVARCHAR(MAX)   NOT NULL,
        created_at              DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
        updated_at              DATETIME2       NOT NULL DEFAULT GETUTCDATE()
      )
    `);
    console.log("[migrate] Upgrade complete: users table created.");
  }

  const settingsTableExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = 'settings'
  `);

  if (settingsTableExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: creating settings table...");
    await pool.request().query(`
      CREATE TABLE settings (
        [key]       NVARCHAR(100)   NOT NULL PRIMARY KEY,
        value       NVARCHAR(MAX)   NOT NULL,
        updated_at  DATETIME2       NOT NULL DEFAULT GETUTCDATE()
      )
    `);
    // Default: registration is disabled (closed)
    await pool.request().query(`
      INSERT INTO settings ([key], value) VALUES ('registration_enabled', '0')
    `);
    console.log("[migrate] Upgrade complete: settings table created (registration_enabled = 0).");
  }

  // Upgrade 10: Add user_id FK column to tabs and agents tables for single-owner tenancy
  const tabsUserIdColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tabs' AND COLUMN_NAME = 'user_id'
  `);

  if (tabsUserIdColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding user_id to tabs table...");

    // Add column as nullable first (existing rows have no user)
    await pool.request().query(`
      ALTER TABLE tabs ADD user_id INT NULL
    `);

    // If there are existing tabs and at least one user, assign them to the first user
    const firstUser = await pool.request().query(`SELECT TOP 1 id FROM users ORDER BY id ASC`);
    if (firstUser.recordset.length > 0) {
      const userId = firstUser.recordset[0].id;
      await pool.request()
        .input("userId", sql.Int, userId)
        .query(`UPDATE tabs SET user_id = @userId WHERE user_id IS NULL`);
    }

    // If there are NO users but there are tabs, we cannot make it NOT NULL yet.
    // Check if all tabs have a user_id set.
    const nullCount = await pool.request().query(`SELECT COUNT(*) AS cnt FROM tabs WHERE user_id IS NULL`);
    if (nullCount.recordset[0].cnt === 0) {
      // Safe to add NOT NULL constraint and FK
      await pool.request().query(`ALTER TABLE tabs ALTER COLUMN user_id INT NOT NULL`);
      await pool.request().query(`
        ALTER TABLE tabs ADD CONSTRAINT FK_tabs_users
        FOREIGN KEY (user_id) REFERENCES users(id)
      `);
    } else {
      // Leave nullable for now — constraint will be enforced at app level.
      // Once all rows have a user_id, a future migration can add the NOT NULL + FK.
      console.log("[migrate] ⚠ tabs.user_id left nullable — no users exist yet to assign existing tabs to.");
      // Still add the FK (allows NULL values with FK)
      try {
        await pool.request().query(`
          ALTER TABLE tabs ADD CONSTRAINT FK_tabs_users
          FOREIGN KEY (user_id) REFERENCES users(id)
        `);
      } catch (e: any) {
        console.warn(`[migrate] ⚠ Could not add FK_tabs_users: ${e.message}`);
      }
    }

    console.log("[migrate] Upgrade complete: user_id added to tabs.");
  }

  const agentsUserIdColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'agents' AND COLUMN_NAME = 'user_id'
  `);

  if (agentsUserIdColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding user_id to agents table...");

    // Add column as nullable first (existing rows have no user)
    await pool.request().query(`
      ALTER TABLE agents ADD user_id INT NULL
    `);

    // If there are existing agents and at least one user, assign them to the first user
    const firstUser = await pool.request().query(`SELECT TOP 1 id FROM users ORDER BY id ASC`);
    if (firstUser.recordset.length > 0) {
      const userId = firstUser.recordset[0].id;
      await pool.request()
        .input("userId", sql.Int, userId)
        .query(`UPDATE agents SET user_id = @userId WHERE user_id IS NULL`);
    }

    // Check if all agents have a user_id set
    const nullCount = await pool.request().query(`SELECT COUNT(*) AS cnt FROM agents WHERE user_id IS NULL`);
    if (nullCount.recordset[0].cnt === 0) {
      await pool.request().query(`ALTER TABLE agents ALTER COLUMN user_id INT NOT NULL`);
      await pool.request().query(`
        ALTER TABLE agents ADD CONSTRAINT FK_agents_users
        FOREIGN KEY (user_id) REFERENCES users(id)
      `);
    } else {
      console.log("[migrate] ⚠ agents.user_id left nullable — no users exist yet to assign existing agents to.");
      try {
        await pool.request().query(`
          ALTER TABLE agents ADD CONSTRAINT FK_agents_users
          FOREIGN KEY (user_id) REFERENCES users(id)
        `);
      } catch (e: any) {
        console.warn(`[migrate] ⚠ Could not add FK_agents_users: ${e.message}`);
      }
    }

    console.log("[migrate] Upgrade complete: user_id added to agents.");
  }

  // Upgrade 11: Create sessions table (move from sessions.json to SQL Server)
  const sessionsTableExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME = 'sessions'
  `);

  if (sessionsTableExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: creating sessions table...");
    await pool.request().query(`
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
        user_id             INT             NULL,
        created_at          DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
        started_at          DATETIME2       NULL,
        current_task_id     INT             NULL,
        current_activity    NVARCHAR(MAX)   NULL,
        CONSTRAINT FK_sessions_users FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Create index for user_id filtering
    await pool.request().query(`
      CREATE INDEX IX_sessions_user_id ON sessions (user_id)
    `);

    // Create index for finding running sessions on restart
    await pool.request().query(`
      CREATE INDEX IX_sessions_status ON sessions (status) WHERE status = 'running'
    `);

    console.log("[migrate] Upgrade complete: sessions table created.");

    // Migrate existing sessions.json data if it exists
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const storePath = resolve(import.meta.dirname, "../../../sessions.json");
      if (existsSync(storePath)) {
        const raw = readFileSync(storePath, "utf-8");
        const persisted = JSON.parse(raw) as Array<Record<string, unknown>>;
        if (persisted.length > 0) {
          console.log(`[migrate] Migrating ${persisted.length} session(s) from sessions.json to DB...`);
          // Get first user for assignment
          const firstUser = await pool.request().query(`SELECT TOP 1 id FROM users ORDER BY id ASC`);
          const defaultUserId = firstUser.recordset.length > 0 ? firstUser.recordset[0].id as number : null;

          for (const s of persisted) {
            try {
              await pool
                .request()
                .input("id", sql.NVarChar(16), s.id as string)
                .input("name", sql.NVarChar(200), s.name as string)
                .input("agent", sql.NVarChar(100), s.agent as string)
                .input("status", sql.VarChar(20), s.status === "running" ? "stopped" : (s.status as string))
                .input("prompt", sql.NVarChar(sql.MAX), (s.prompt as string) || "")
                .input("interactive", sql.Bit, s.interactive !== false ? 1 : 0)
                .input("loop", sql.Bit, s.loop === true ? 1 : 0)
                .input("runs", sql.Int, (s.runs as number) ?? 0)
                .input("intervalSeconds", sql.Int, (s.intervalSeconds as number) ?? 10)
                .input("cwd", sql.NVarChar(500), s.cwd as string)
                .input("timeoutSeconds", sql.Int, (s.timeoutSeconds as number) ?? 0)
                .input("model", sql.NVarChar(100), (s.model as string) || null)
                .input("mcpServers", sql.NVarChar(sql.MAX), s.mcpServers ? JSON.stringify(s.mcpServers) : null)
                .input("tabIds", sql.NVarChar(sql.MAX), s.tabIds ? JSON.stringify(s.tabIds) : null)
                .input("userId", sql.Int, defaultUserId)
                .input("createdAt", sql.DateTime2, s.createdAt ? new Date(s.createdAt as string) : new Date())
                .input("startedAt", sql.DateTime2, s.startedAt ? new Date(s.startedAt as string) : null)
                .input("currentTaskId", sql.Int, (s.currentTaskId as number) || null)
                .query(`
                  INSERT INTO sessions (
                    id, name, agent, status, prompt, interactive, loop, runs,
                    interval_seconds, cwd, timeout_seconds, model, mcp_servers,
                    tab_ids, user_id, created_at, started_at, current_task_id
                  ) VALUES (
                    @id, @name, @agent, @status, @prompt, @interactive, @loop, @runs,
                    @intervalSeconds, @cwd, @timeoutSeconds, @model, @mcpServers,
                    @tabIds, @userId, @createdAt, @startedAt, @currentTaskId
                  )
                `);
            } catch (insertErr: any) {
              console.warn(`[migrate] ⚠ Could not migrate session ${s.id}: ${insertErr.message}`);
            }
          }
          console.log("[migrate] Session migration from sessions.json complete.");
        }
      }
    } catch (migErr: any) {
      console.warn(`[migrate] ⚠ Could not migrate sessions.json: ${migErr.message}. Continuing...`);
    }
  }

  // Upgrade 12: Add mcp_config JSON column to tabs table
  const mcpConfigColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tabs' AND COLUMN_NAME = 'mcp_config'
  `);

  if (mcpConfigColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding mcp_config to tabs table...");
    const defaultJson = JSON.stringify({ atlassian: true, azureDevops: true, awsApi: false, awsDocs: true });
    await pool.request().query(`
      ALTER TABLE tabs
      ADD mcp_config NVARCHAR(MAX) NULL
    `);
    // Set default value for existing rows
    await pool.request()
      .input("defaultMcp", sql.NVarChar(sql.MAX), defaultJson)
      .query(`UPDATE tabs SET mcp_config = @defaultMcp WHERE mcp_config IS NULL`);
    console.log("[migrate] Upgrade complete: mcp_config added to tabs.");
  }

  // Upgrade 13: Add retry_count and max_retries columns to tasks table
  const retryCountColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tasks' AND COLUMN_NAME = 'retry_count'
  `);

  if (retryCountColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding retry_count and max_retries to tasks table...");
    await pool.request().query(`
      ALTER TABLE tasks ADD
        retry_count   INT NOT NULL DEFAULT 0,
        max_retries   INT NOT NULL DEFAULT 5
    `);
    console.log("[migrate] Upgrade complete: retry_count and max_retries added to tasks.");
  }

  // Upgrade 14: Add encrypted credential columns to users table
  const credColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'cred_azure_devops_pat'
  `);

  if (credColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding credential columns to users table...");
    await pool.request().query(`
      ALTER TABLE users ADD
        cred_azure_devops_pat       NVARCHAR(MAX) NULL,
        cred_atlassian_api_token    NVARCHAR(MAX) NULL,
        cred_atlassian_username     NVARCHAR(MAX) NULL,
        cred_aws_access_key_id      NVARCHAR(MAX) NULL,
        cred_aws_secret_access_key  NVARCHAR(MAX) NULL
    `);
    console.log("[migrate] Upgrade complete: credential columns added to users table.");
  }

  // Upgrade 15: Add cred_github_pat column to users table
  const githubPatColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'cred_github_pat'
  `);

  if (githubPatColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding cred_github_pat column to users table...");
    await pool.request().query(`
      ALTER TABLE users ADD cred_github_pat NVARCHAR(MAX) NULL
    `);
    console.log("[migrate] Upgrade complete: cred_github_pat added to users table.");
  }

  // Upgrade 16: Add mcp_config_override JSON column to sessions table
  const mcpOverrideColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'mcp_config_override'
  `);

  if (mcpOverrideColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding mcp_config_override column to sessions...");
    await pool.request().query(`
      ALTER TABLE sessions ADD
        mcp_config_override NVARCHAR(MAX) NULL
    `);
    console.log("[migrate] Upgrade complete: mcp_config_override added to sessions.");
  }

  // Upgrade 17: Git provider selection — per-tab override + per-user default.
  // NULL on a tab means "inherit the user default"; NULL on a user means
  // "derive from the repository URL".
  const tabGitProviderColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tabs' AND COLUMN_NAME = 'git_provider'
  `);

  if (tabGitProviderColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding git_provider column to tabs table...");
    await pool.request().query(`
      ALTER TABLE tabs ADD git_provider VARCHAR(20) NULL
    `);
    console.log("[migrate] Upgrade complete: git_provider added to tabs.");
  }

  const userDefaultGitProviderColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'default_git_provider'
  `);

  if (userDefaultGitProviderColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding default_git_provider column to users table...");
    await pool.request().query(`
      ALTER TABLE users ADD default_git_provider VARCHAR(20) NULL
    `);
    console.log("[migrate] Upgrade complete: default_git_provider added to users.");
  }

  // Upgrade 18: Pinned "Chat" session — every user gets exactly one permanent,
  // agentless, interactive session that always sorts first in the UI and
  // cannot be deleted. Add the column, then backfill one for every user that
  // doesn't already have a pinned session.
  const pinnedColExists = await pool.request().query(`
    SELECT COUNT(*) AS cnt
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'pinned'
  `);

  if (pinnedColExists.recordset[0].cnt === 0) {
    console.log("[migrate] Upgrading: adding pinned column to sessions table...");
    await pool.request().query(`
      ALTER TABLE sessions ADD pinned BIT NOT NULL DEFAULT 0
    `);
    console.log("[migrate] Upgrade complete: pinned added to sessions.");
  }

  await backfillPinnedChatSessions(pool);
}

/**
 * Ensure every user has exactly one pinned, agentless "Chat" session.
 * Safe to run on every startup — it's a no-op for users that already have one.
 */
async function backfillPinnedChatSessions(pool: sql.ConnectionPool): Promise<void> {
  const usersWithoutPinned = await pool.request().query(`
    SELECT u.id, u.email
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.pinned = 1
    )
  `);

  if (usersWithoutPinned.recordset.length === 0) return;

  console.log(
    `[migrate] Backfilling pinned Chat session for ${usersWithoutPinned.recordset.length} user(s)...`
  );

  for (const user of usersWithoutPinned.recordset) {
    try {
      await createPinnedChatSession(pool, user.id as number);
    } catch (err: any) {
      console.warn(`[migrate] ⚠ Could not create pinned Chat session for user ${user.id}: ${err.message}`);
    }
  }
}

/**
 * Insert the permanent, agentless "Chat" session row for a single user.
 * Used by the startup backfill only — new users get theirs via
 * session-manager's createSession() during registration instead, so the
 * in-memory session map and WebSocket broadcast stay in sync.
 */
async function createPinnedChatSession(pool: sql.ConnectionPool, userId: number): Promise<void> {
  const { randomBytes } = await import("node:crypto");
  const id = randomBytes(4).toString("hex");
  const { resolve } = await import("node:path");
  const cwd = resolve(import.meta.dirname, "../../..");

  await pool
    .request()
    .input("id", sql.NVarChar(16), id)
    .input("name", sql.NVarChar(200), "Chat")
    .input("cwd", sql.NVarChar(500), cwd)
    .input("userId", sql.Int, userId)
    .query(`
      INSERT INTO sessions (
        id, name, agent, status, prompt, interactive, loop, runs,
        interval_seconds, cwd, timeout_seconds, user_id, created_at, pinned
      ) VALUES (
        @id, @name, '', 'stopped', '', 1, 0, 0,
        10, @cwd, 0, @userId, GETUTCDATE(), 1
      )
    `);
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
      WHERE TABLE_NAME IN ('boards', 'tabs')
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
