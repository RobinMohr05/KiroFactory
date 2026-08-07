/**
 * Sessions DB — Persists session metadata in SQL Server.
 *
 * Replaces the file-based sessions.json approach. Sessions are scoped per user_id.
 * Output buffers remain in-memory (too large/ephemeral for DB storage).
 * Activity is stored as a JSON column for quick status snapshots.
 */

import { getPool, sql } from "./connection.js";
import type { Session, McpServerConfig, Activity } from "../types.js";

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapRowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as number,
    name: row.name as string,
    agent: row.agent as string,
    status: row.status as Session["status"],
    prompt: row.prompt as string,
    interactive: row.interactive as boolean,
    loop: row.loop as boolean,
    runs: row.runs as number,
    intervalSeconds: row.interval_seconds as number,
    cwd: row.cwd as string,
    timeoutSeconds: row.timeout_seconds as number,
    model: (row.model as string) || undefined,
    mcpServers: row.mcp_servers
      ? JSON.parse(row.mcp_servers as string)
      : undefined,
    mcpConfigOverride: row.mcp_config_override
      ? JSON.parse(row.mcp_config_override as string)
      : undefined,
    tabIds: row.tab_ids ? JSON.parse(row.tab_ids as string) : undefined,
    userId: row.user_id as number,
    createdAt: (row.created_at as Date).toISOString(),
    startedAt: row.started_at
      ? (row.started_at as Date).toISOString()
      : undefined,
    currentTaskId: (row.current_task_id as number) || undefined,
    currentActivity: row.current_activity
      ? JSON.parse(row.current_activity as string)
      : undefined,
    pinned: !!row.pinned,
    sortOrder: (row.sort_order as number) ?? 0,
    output: [], // Output is in-memory only
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get all sessions for a given user. Returns session metadata without output buffers.
 */
export async function getAllSessionsFromDb(
  userId?: number
): Promise<Session[]> {
  const pool = await getPool();
  let result;

  if (userId) {
    result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query(
        "SELECT * FROM sessions WHERE user_id = @userId ORDER BY pinned DESC, sort_order ASC"
      );
  } else {
    result = await pool
      .request()
      .query("SELECT * FROM sessions ORDER BY pinned DESC, sort_order ASC");
  }

  return result.recordset.map(mapRowToSession);
}

/**
 * Get a single session by ID.
 */
export async function getSessionFromDb(id: number): Promise<Session | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM sessions WHERE id = @id");

  if (result.recordset.length === 0) return null;
  return mapRowToSession(result.recordset[0]);
}

/**
 * Get all sessions that were running when the server last shut down.
 * Used for auto-restart logic on server boot.
 */
export async function getRunningSessionsFromDb(): Promise<Session[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query("SELECT * FROM sessions WHERE status = 'running'");

  return result.recordset.map(mapRowToSession);
}

/**
 * Insert a new session into the database.
 * Returns the auto-generated numeric id (IDENTITY column).
 */
export async function insertSession(session: Session): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("name", sql.NVarChar(200), session.name)
    .input("agent", sql.NVarChar(100), session.agent || "")
    .input("status", sql.VarChar(20), session.status)
    .input("prompt", sql.NVarChar(sql.MAX), session.prompt)
    .input("interactive", sql.Bit, session.interactive ? 1 : 0)
    .input("loop", sql.Bit, session.loop ? 1 : 0)
    .input("runs", sql.Int, session.runs)
    .input("intervalSeconds", sql.Int, session.intervalSeconds)
    .input("cwd", sql.NVarChar(500), session.cwd)
    .input("timeoutSeconds", sql.Int, session.timeoutSeconds)
    .input("model", sql.NVarChar(100), session.model || null)
    .input(
      "mcpServers",
      sql.NVarChar(sql.MAX),
      session.mcpServers ? JSON.stringify(session.mcpServers) : null
    )
    .input(
      "tabIds",
      sql.NVarChar(sql.MAX),
      session.tabIds ? JSON.stringify(session.tabIds) : null
    )
    .input("userId", sql.Int, session.userId)
    .input("createdAt", sql.DateTime2, new Date(session.createdAt))
    .input(
      "startedAt",
      sql.DateTime2,
      session.startedAt ? new Date(session.startedAt) : null
    )
    .input("currentTaskId", sql.Int, session.currentTaskId || null)
    .input(
      "currentActivity",
      sql.NVarChar(sql.MAX),
      session.currentActivity
        ? JSON.stringify(session.currentActivity)
        : null
    )
    .input(
      "mcpConfigOverride",
      sql.NVarChar(sql.MAX),
      session.mcpConfigOverride
        ? JSON.stringify(session.mcpConfigOverride)
        : null
    )
    .input("pinned", sql.Bit, session.pinned ? 1 : 0)
    .input("sortOrder", sql.Int, session.sortOrder ?? 0)
    .query(`
      INSERT INTO sessions (
        name, agent, status, prompt, interactive, loop, runs,
        interval_seconds, cwd, timeout_seconds, model, mcp_servers,
        tab_ids, user_id, created_at, started_at, current_task_id, current_activity,
        mcp_config_override, pinned, sort_order
      )
      OUTPUT INSERTED.id
      VALUES (
        @name, @agent, @status, @prompt, @interactive, @loop, @runs,
        @intervalSeconds, @cwd, @timeoutSeconds, @model, @mcpServers,
        @tabIds, @userId, @createdAt, @startedAt, @currentTaskId, @currentActivity,
        @mcpConfigOverride, @pinned, @sortOrder
      )
    `);

  return result.recordset[0].id as number;
}

/**
 * Update session status, started_at, current_task_id, and current_activity.
 * This is called frequently during session lifecycle changes.
 */
export async function updateSessionStatus(
  id: number,
  status: Session["status"],
  startedAt?: string,
  currentTaskId?: number,
  currentActivity?: Activity
): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, id)
    .input("status", sql.VarChar(20), status)
    .input(
      "startedAt",
      sql.DateTime2,
      startedAt ? new Date(startedAt) : null
    )
    .input("currentTaskId", sql.Int, currentTaskId || null)
    .input(
      "currentActivity",
      sql.NVarChar(sql.MAX),
      currentActivity ? JSON.stringify(currentActivity) : null
    ).query(`
      UPDATE sessions
      SET status = @status,
          started_at = @startedAt,
          current_task_id = @currentTaskId,
          current_activity = @currentActivity
      WHERE id = @id
    `);
}

/**
 * Update session metadata fields (name, agent, prompt, cwd, etc.).
 * Used when session config is modified.
 */
export async function updateSessionMeta(session: Session): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, session.id)
    .input("name", sql.NVarChar(200), session.name)
    .input("agent", sql.NVarChar(100), session.agent || "")
    .input("status", sql.VarChar(20), session.status)
    .input("prompt", sql.NVarChar(sql.MAX), session.prompt)
    .input("interactive", sql.Bit, session.interactive ? 1 : 0)
    .input("loop", sql.Bit, session.loop ? 1 : 0)
    .input("runs", sql.Int, session.runs)
    .input("intervalSeconds", sql.Int, session.intervalSeconds)
    .input("cwd", sql.NVarChar(500), session.cwd)
    .input("timeoutSeconds", sql.Int, session.timeoutSeconds)
    .input("model", sql.NVarChar(100), session.model || null)
    .input(
      "mcpServers",
      sql.NVarChar(sql.MAX),
      session.mcpServers ? JSON.stringify(session.mcpServers) : null
    )
    .input(
      "tabIds",
      sql.NVarChar(sql.MAX),
      session.tabIds ? JSON.stringify(session.tabIds) : null
    )
    .input(
      "startedAt",
      sql.DateTime2,
      session.startedAt ? new Date(session.startedAt) : null
    )
    .input("currentTaskId", sql.Int, session.currentTaskId || null)
    .input(
      "currentActivity",
      sql.NVarChar(sql.MAX),
      session.currentActivity
        ? JSON.stringify(session.currentActivity)
        : null
    )
    .input(
      "mcpConfigOverride",
      sql.NVarChar(sql.MAX),
      session.mcpConfigOverride
        ? JSON.stringify(session.mcpConfigOverride)
        : null
    )
    .input("pinned", sql.Bit, session.pinned ? 1 : 0)
    .input("sortOrder", sql.Int, session.sortOrder ?? 0)
    .query(`
      UPDATE sessions
      SET name = @name,
          agent = @agent,
          status = @status,
          prompt = @prompt,
          interactive = @interactive,
          loop = @loop,
          runs = @runs,
          interval_seconds = @intervalSeconds,
          cwd = @cwd,
          timeout_seconds = @timeoutSeconds,
          model = @model,
          mcp_servers = @mcpServers,
          tab_ids = @tabIds,
          started_at = @startedAt,
          current_task_id = @currentTaskId,
          current_activity = @currentActivity,
          mcp_config_override = @mcpConfigOverride,
          pinned = @pinned,
          sort_order = @sortOrder
      WHERE id = @id
    `);
}

/**
 * Delete a session from the database.
 */
export async function deleteSessionFromDb(id: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("DELETE FROM sessions WHERE id = @id");

  return (result.rowsAffected[0] ?? 0) > 0;
}

/**
 * Check if a session belongs to a specific user.
 */
export async function isSessionOwnedByUser(
  sessionId: number,
  userId: number
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, sessionId)
    .input("userId", sql.Int, userId)
    .query("SELECT 1 FROM sessions WHERE id = @id AND user_id = @userId");

  return result.recordset.length > 0;
}

/**
 * Bulk-update sort_order for a list of session IDs.
 * The array position determines the sort_order value.
 */
export async function reorderSessionsInDb(
  sessionIds: number[],
  userId: number
): Promise<void> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    for (let i = 0; i < sessionIds.length; i++) {
      await transaction
        .request()
        .input("id", sql.Int, sessionIds[i])
        .input("sortOrder", sql.Int, i)
        .input("userId", sql.Int, userId)
        .query(
          "UPDATE sessions SET sort_order = @sortOrder WHERE id = @id AND user_id = @userId"
        );
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Update the pinned state and sort_order of a session.
 */
export async function updateSessionPinInDb(
  sessionId: number,
  pinned: boolean,
  sortOrder: number
): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, sessionId)
    .input("pinned", sql.Bit, pinned ? 1 : 0)
    .input("sortOrder", sql.Int, sortOrder)
    .query(
      "UPDATE sessions SET pinned = @pinned, sort_order = @sortOrder WHERE id = @id"
    );
}
