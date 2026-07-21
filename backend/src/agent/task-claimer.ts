/**
 * Task Claimer — Atomic task claiming from SQL Server
 *
 * Uses row-level locking (UPDLOCK, READPAST) to atomically claim the
 * highest-priority todo task without conflicts between concurrent agents.
 */

import { getPool, sql } from "../db/connection.js";
import type { Task } from "../types.js";

export interface ClaimedTask {
  id: number;
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "improvement" | "bug" | "feature";
  description: string;
  files: string[];
  origin: "user" | "ai" | "user-assisted";
}

/**
 * Atomically claim the highest-priority todo task.
 *
 * Uses SQL Server's UPDLOCK + READPAST hints:
 * - UPDLOCK: prevents other transactions from reading the same row
 * - READPAST: skips rows that are already locked by another session
 *
 * This means multiple agents can run concurrently without claiming the
 * same task — each agent will get the next available task.
 *
 * Priority ordering: priority ASC (1=Critical first), then by origin
 * (user > user-assisted > ai), then by creation date (oldest first).
 *
 * @param taskId Optional specific task ID to claim (skips priority ordering)
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are eligible. If empty/undefined, all todo tasks are eligible.
 * @returns The claimed task, or null if no claimable tasks exist
 */
export async function claimTask(taskId?: number, tabIds?: number[]): Promise<ClaimedTask | null> {
  const pool = await getPool();

  // Use a transaction with row locking for atomicity
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const request = new sql.Request(transaction);

    let query: string;

    if (taskId) {
      // Claim a specific task by ID
      request.input("taskId", sql.Int, taskId);
      query = `
        UPDATE tasks
        SET state = 'in-progress', updated_at = GETUTCDATE()
        OUTPUT
          INSERTED.id,
          INSERTED.title,
          INSERTED.priority,
          INSERTED.type,
          INSERTED.description,
          INSERTED.files,
          INSERTED.origin
        WHERE id = @taskId AND state = 'todo'
      `;
    } else if (tabIds && tabIds.length > 0) {
      // Claim the highest-priority task that belongs to at least one of the given tabs
      // Build a parameterized IN clause
      const tabIdParams = tabIds.map((id, i) => `@tabId${i}`);
      tabIds.forEach((id, i) => {
        request.input(`tabId${i}`, sql.Int, id);
      });

      query = `
        UPDATE tasks
        SET state = 'in-progress', updated_at = GETUTCDATE()
        OUTPUT
          INSERTED.id,
          INSERTED.title,
          INSERTED.priority,
          INSERTED.type,
          INSERTED.description,
          INSERTED.files,
          INSERTED.origin
        WHERE id = (
          SELECT TOP 1 t.id
          FROM tasks t WITH (UPDLOCK, READPAST)
          INNER JOIN task_tabs tt ON tt.task_id = t.id
          WHERE t.state = 'todo'
            AND tt.tab_id IN (${tabIdParams.join(", ")})
          ORDER BY
            t.priority ASC,
            CASE t.origin
              WHEN 'user' THEN 0
              WHEN 'user-assisted' THEN 1
              WHEN 'ai' THEN 2
              ELSE 3
            END ASC,
            t.created_at ASC
        )
      `;
    } else {
      // Claim the highest-priority available task (no board filter)
      // UPDLOCK + READPAST ensures concurrency safety
      query = `
        UPDATE tasks
        SET state = 'in-progress', updated_at = GETUTCDATE()
        OUTPUT
          INSERTED.id,
          INSERTED.title,
          INSERTED.priority,
          INSERTED.type,
          INSERTED.description,
          INSERTED.files,
          INSERTED.origin
        WHERE id = (
          SELECT TOP 1 id
          FROM tasks WITH (UPDLOCK, READPAST)
          WHERE state = 'todo'
          ORDER BY
            priority ASC,
            CASE origin
              WHEN 'user' THEN 0
              WHEN 'user-assisted' THEN 1
              WHEN 'ai' THEN 2
              ELSE 3
            END ASC,
            created_at ASC
        )
      `;
    }

    const result = await request.query(query);
    await transaction.commit();

    if (result.recordset.length === 0) {
      return null;
    }

    const row = result.recordset[0];
    return {
      id: row.id,
      title: row.title,
      priority: row.priority,
      type: row.type,
      description: row.description,
      files: JSON.parse(row.files || "[]"),
      origin: row.origin,
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Mark a task as "developed" (completed by the agent).
 */
export async function markTaskDeveloped(taskId: number): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, taskId)
    .query(`
      UPDATE tasks
      SET state = 'developed', updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}

/**
 * Reset a task back to "todo" (agent failed or timed out).
 */
export async function resetTaskToTodo(taskId: number): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, taskId)
    .query(`
      UPDATE tasks
      SET state = 'todo', updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}

/**
 * Reset all in-progress tasks back to "todo".
 * Used on server restart to recover tasks that were being worked on
 * when the kiro-cli process was killed (e.g., by tsx watch restarting the server).
 *
 * @returns The number of tasks that were reset.
 */
export async function resetOrphanedTasks(): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query(`
      UPDATE tasks
      SET state = 'todo', updated_at = GETUTCDATE()
      WHERE state = 'in-progress'
    `);
  return result.rowsAffected[0] ?? 0;
}

/**
 * Get the count of available (todo) tasks.
 *
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are counted. If empty/undefined, all todo tasks are counted.
 */
export async function getAvailableTaskCount(tabIds?: number[]): Promise<number> {
  const pool = await getPool();

  if (tabIds && tabIds.length > 0) {
    const request = pool.request();
    const tabIdParams = tabIds.map((id, i) => `@tabId${i}`);
    tabIds.forEach((id, i) => {
      request.input(`tabId${i}`, sql.Int, id);
    });

    const result = await request.query(`
      SELECT COUNT(DISTINCT t.id) as count
      FROM tasks t
      INNER JOIN task_tabs tt ON tt.task_id = t.id
      WHERE t.state = 'todo'
        AND tt.tab_id IN (${tabIdParams.join(", ")})
    `);
    return result.recordset[0].count;
  }

  const result = await pool
    .request()
    .query("SELECT COUNT(*) as count FROM tasks WHERE state = 'todo'");
  return result.recordset[0].count;
}
