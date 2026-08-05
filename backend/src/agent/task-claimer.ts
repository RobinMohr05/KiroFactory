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
  /** Existing branch name from a previous stage (null if first stage) */
  branch: string | null;
  /** Existing pull request URL from a previous stage (null if first stage) */
  pullRequestUrl: string | null;
  /** Repository URL from the task's associated tab (null if not set) */
  repositoryUrl: string | null;
  /** User ID of the tab owner (for credential lookup) */
  userId: number | null;
}

/**
 * Atomically claim the highest-priority task in the given claim state.
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
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are eligible. If empty/undefined, all tasks in claimState are eligible.
 * @param claimState The state to claim FROM (default: "todo")
 * @param workingState The state to transition TO on claim (default: "in-progress")
 * @returns The claimed task, or null if no claimable tasks exist
 */
export async function claimTask(
  taskId?: number,
  tabIds?: number[],
  claimState: string = "todo",
  workingState: string = "in-progress"
): Promise<ClaimedTask | null> {
  const pool = await getPool();

  // Use a transaction with row locking for atomicity
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const request = new sql.Request(transaction);
    request.input("claimState", sql.VarChar(50), claimState);
    request.input("workingState", sql.VarChar(50), workingState);

    let query: string;

    if (taskId) {
      // Claim a specific task by ID
      request.input("taskId", sql.Int, taskId);
      query = `
        UPDATE tasks
        SET state = @workingState, updated_at = GETUTCDATE()
        OUTPUT
          INSERTED.id,
          INSERTED.title,
          INSERTED.priority,
          INSERTED.type,
          INSERTED.description,
          INSERTED.files,
          INSERTED.origin,
          INSERTED.branch,
          INSERTED.pull_request_url
        WHERE id = @taskId AND state = @claimState
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
        SET state = @workingState, updated_at = GETUTCDATE()
        OUTPUT
          INSERTED.id,
          INSERTED.title,
          INSERTED.priority,
          INSERTED.type,
          INSERTED.description,
          INSERTED.files,
          INSERTED.origin,
          INSERTED.branch,
          INSERTED.pull_request_url
        WHERE id = (
          SELECT TOP 1 t.id
          FROM tasks t WITH (UPDLOCK, READPAST)
          INNER JOIN task_tabs tt ON tt.task_id = t.id
          WHERE t.state = @claimState
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
        SET state = @workingState, updated_at = GETUTCDATE()
        OUTPUT
          INSERTED.id,
          INSERTED.title,
          INSERTED.priority,
          INSERTED.type,
          INSERTED.description,
          INSERTED.files,
          INSERTED.origin,
          INSERTED.branch,
          INSERTED.pull_request_url
        WHERE id = (
          SELECT TOP 1 id
          FROM tasks WITH (UPDLOCK, READPAST)
          WHERE state = @claimState
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

    if (result.recordset.length === 0) {
      await transaction.commit();
      return null;
    }

    const row = result.recordset[0];

    // Fetch repository URL and user ID within the same transaction — avoids
    // a separate pool.request() round-trip after commit.
    const tabRequest = new sql.Request(transaction);
    tabRequest.input("claimedTaskId", sql.Int, row.id);
    const tabResult = await tabRequest.query(`
      SELECT TOP 1 t.repository_url, t.user_id
      FROM task_tabs tt
      INNER JOIN tabs t ON t.id = tt.tab_id
      WHERE tt.task_id = @claimedTaskId
    `);

    await transaction.commit();

    const tabRow = tabResult.recordset.length > 0 ? tabResult.recordset[0] : null;

    return {
      id: row.id,
      title: row.title,
      priority: row.priority,
      type: row.type,
      description: row.description,
      files: JSON.parse(row.files || "[]"),
      origin: row.origin,
      branch: row.branch || null,
      pullRequestUrl: row.pull_request_url || null,
      repositoryUrl: tabRow?.repository_url || null,
      userId: tabRow?.user_id || null,
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Resolve a task to the given target state (agent completed successfully).
 * Optionally persists the branch name and pull request URL in the same UPDATE.
 *
 * @param taskId The task to resolve
 * @param resolveState The target state (e.g. "developed", "reviewed", "done")
 * @param branch Optional branch name
 * @param pullRequestUrl Optional pull request URL
 */
export async function resolveTask(
  taskId: number,
  resolveState: string,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, taskId)
    .input("resolveState", sql.VarChar(50), resolveState)
    .input("branch", sql.NVarChar(250), branch ?? null)
    .input("pullRequestUrl", sql.NVarChar(500), pullRequestUrl ?? null)
    .query(`
      UPDATE tasks
      SET state = @resolveState, branch = @branch, pull_request_url = @pullRequestUrl, updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}

/**
 * Mark a task as "developed" (completed by the developer agent).
 * Thin wrapper around resolveTask for backward compatibility.
 */
export async function markTaskDeveloped(
  taskId: number,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  return resolveTask(taskId, "developed", branch, pullRequestUrl);
}

/**
 * Reset a task back to a given state (agent failed or timed out).
 * Each agent stage resets to its own claim state on failure — e.g. a failed
 * review resets to "developed" (the reviewer's claimState), not to "todo".
 *
 * Optionally persists branch/PR info if a best-effort push succeeded before the reset.
 * Set `preserveBranchInfo: true` when the caller has no branch/PR info to contribute
 * (e.g. an inspector agent that never pushes) — this leaves existing DB values intact
 * instead of overwriting them with null and losing the branch from a previous stage.
 *
 * @param taskId The task to reset
 * @param resetState The state to reset TO (default: "todo")
 * @param branch Optional branch name (or null to clear). Ignored when preserveBranchInfo is true.
 * @param pullRequestUrl Optional PR URL (or null to clear). Ignored when preserveBranchInfo is true.
 * @param preserveBranchInfo When true, skip updating branch/pull_request_url columns entirely.
 */
export async function resetTask(
  taskId: number,
  resetState: string,
  branch?: string | null,
  pullRequestUrl?: string | null,
  preserveBranchInfo = false
): Promise<void> {
  const pool = await getPool();

  if (preserveBranchInfo) {
    // Don't touch branch/pull_request_url — preserve whatever the previous stage stored.
    await pool
      .request()
      .input("id", sql.Int, taskId)
      .input("resetState", sql.VarChar(50), resetState)
      .query(`
        UPDATE tasks
        SET state = @resetState, updated_at = GETUTCDATE()
        WHERE id = @id
      `);
  } else {
    await pool
      .request()
      .input("id", sql.Int, taskId)
      .input("resetState", sql.VarChar(50), resetState)
      .input("branch", sql.NVarChar(250), branch !== undefined ? branch : null)
      .input("pullRequestUrl", sql.NVarChar(500), pullRequestUrl !== undefined ? pullRequestUrl : null)
      .query(`
        UPDATE tasks
        SET state = @resetState, branch = @branch, pull_request_url = @pullRequestUrl, updated_at = GETUTCDATE()
        WHERE id = @id
      `);
  }
}

/**
 * Reset a task back to "todo" (developer agent failed or timed out).
 * Thin wrapper around resetTask for backward compatibility.
 */
export async function resetTaskToTodo(
  taskId: number,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  return resetTask(taskId, "todo", branch, pullRequestUrl);
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
 * Get the count of available tasks in the given claim state.
 *
 * Uses a short TTL cache (5s) to avoid redundant COUNT queries when multiple
 * loop sessions poll simultaneously. The cache is keyed by the sorted tabIds
 * AND the claim state.
 *
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are counted. If empty/undefined, all tasks in the given state are counted.
 * @param claimState The state to count tasks in (default: "todo")
 */

interface CachedCount {
  value: number;
  expiresAt: number;
}

const countCache = new Map<string, CachedCount>();
const COUNT_CACHE_TTL_MS = 5000;

export async function getAvailableTaskCount(tabIds?: number[], claimState: string = "todo"): Promise<number> {
  // Build a stable cache key from the sorted tab IDs + claim state
  const tabPart = tabIds && tabIds.length > 0
    ? `tabs:${[...tabIds].sort((a, b) => a - b).join(",")}`
    : "all";
  const cacheKey = `${tabPart}:state:${claimState}`;

  const cached = countCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const pool = await getPool();
  let count: number;

  if (tabIds && tabIds.length > 0) {
    const request = pool.request();
    request.input("claimState", sql.VarChar(50), claimState);
    const tabIdParams = tabIds.map((id, i) => `@tabId${i}`);
    tabIds.forEach((id, i) => {
      request.input(`tabId${i}`, sql.Int, id);
    });

    const result = await request.query(`
      SELECT COUNT(DISTINCT t.id) as count
      FROM tasks t
      INNER JOIN task_tabs tt ON tt.task_id = t.id
      WHERE t.state = @claimState
        AND tt.tab_id IN (${tabIdParams.join(", ")})
    `);
    count = result.recordset[0].count;
  } else {
    const result = await pool
      .request()
      .input("claimState", sql.VarChar(50), claimState)
      .query("SELECT COUNT(*) as count FROM tasks WHERE state = @claimState");
    count = result.recordset[0].count;
  }

  countCache.set(cacheKey, { value: count, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
  return count;
}

/**
 * Mark a task as "done" — skipping remaining pipeline stages.
 * Used when an agent reports verdict "no_action_needed" (nothing to change/review),
 * indicating the task should bypass further stages and go straight to done.
 */
export async function markTaskDone(
  taskId: number,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.Int, taskId)
    .input("branch", sql.NVarChar(250), branch ?? null)
    .input("pullRequestUrl", sql.NVarChar(500), pullRequestUrl ?? null)
    .query(`
      UPDATE tasks
      SET state = 'done', branch = @branch, pull_request_url = @pullRequestUrl, updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}
