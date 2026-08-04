import { getPool, sql } from "./connection.js";
import type { Tab, CreateTabInput, Task, Session, TabMcpConfig, GitProvider } from "../types.js";
import { DEFAULT_MCP_CONFIG, isGitProvider } from "../types.js";
import { getAllSessions } from "../session-manager.js";
import { getAllErrors } from "../error-store.js";

/**
 * Map a raw DB row to a Tab object.
 */
function mapRowToTab(row: Record<string, unknown>): Tab {
  const DEFAULT_COLUMNS = ["todo", "in-progress", "developed", "in-code-review", "reviewed", "in-qa", "done"];
  let columns: string[];
  try {
    columns = JSON.parse((row.columns_json as string) || "[]");
    if (!Array.isArray(columns) || columns.length === 0) columns = DEFAULT_COLUMNS;
  } catch {
    columns = DEFAULT_COLUMNS;
  }

  let mcpConfig: TabMcpConfig;
  try {
    mcpConfig = JSON.parse((row.mcp_config as string) || "null") ?? DEFAULT_MCP_CONFIG;
  } catch {
    mcpConfig = { ...DEFAULT_MCP_CONFIG };
  }

  const gitProvider = row.git_provider as string | null | undefined;

  return {
    id: row.id as number,
    name: row.name as string,
    repositoryUrl: (row.repository_url as string) || null,
    gitProvider: isGitProvider(gitProvider) ? gitProvider : null,
    mcpConfig,
    columns,
    sortOrder: (row.sort_order as number) ?? 0,
    userId: (row.user_id as number) ?? 0,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

/**
 * Map a raw DB row to a Task object (used when populating tab tasks).
 */
function mapRowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    title: row.title as string,
    priority: row.priority as 1 | 2 | 3 | 4,
    type: row.type as Task["type"],
    state: row.state as string,
    description: row.description as string,
    files: JSON.parse((row.files as string) || "[]"),
    origin: row.origin as Task["origin"],
    branch: (row.branch as string) || null,
    pullRequestUrl: (row.pull_request_url as string) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getAllTabs(userId?: number): Promise<Tab[]> {
  const pool = await getPool();
  if (userId) {
    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query("SELECT * FROM tabs WHERE user_id = @userId ORDER BY sort_order ASC, name ASC");
    return result.recordset.map(mapRowToTab);
  }
  const result = await pool.request().query("SELECT * FROM tabs ORDER BY sort_order ASC, name ASC");
  return result.recordset.map(mapRowToTab);
}

/**
 * Reorder tabs by setting sort_order for each tab ID in the given order.
 * @param tabIds - Array of tab IDs in the desired display order
 */
export async function reorderTabs(tabIds: number[]): Promise<void> {
  const pool = await getPool();
  for (let i = 0; i < tabIds.length; i++) {
    await pool
      .request()
      .input(`id${i}`, sql.Int, tabIds[i])
      .input(`order${i}`, sql.Int, i)
      .query(`UPDATE tabs SET sort_order = @order${i} WHERE id = @id${i}`);
  }
}

export async function getTabById(id: number): Promise<Tab | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM tabs WHERE id = @id");

  if (result.recordset.length === 0) return null;
  return mapRowToTab(result.recordset[0]);
}

/**
 * Get a tab with all its related entities: tasks, sessions, and agents.
 */
export async function getTabWithTasks(id: number): Promise<Tab | null> {
  const pool = await getPool();

  const tabResult = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM tabs WHERE id = @id");

  if (tabResult.recordset.length === 0) return null;

  const tab = mapRowToTab(tabResult.recordset[0]);

  // Populate tasks via task_tabs junction
  const tasksResult = await pool
    .request()
    .input("tabId", sql.Int, id)
    .query(`
      SELECT t.*
      FROM tasks t
      INNER JOIN task_tabs tt ON tt.task_id = t.id
      WHERE tt.tab_id = @tabId
      ORDER BY t.priority ASC, t.created_at DESC
    `);

  tab.tasks = tasksResult.recordset.map(mapRowToTask);

  // Populate sessions — sessions store tabIds in memory/JSON, so filter from session-manager
  const allSessions = getAllSessions();
  tab.sessions = allSessions
    .filter((s) => s.tabIds?.includes(id))
    .map((s) => ({ id: s.id, name: s.name, agent: s.agent, status: s.status }));

  // Populate agents via agent_tabs junction.
  // Include agents directly assigned to this tab AND agents assigned to the
  // "generic" tab (which can be used on any tab).
  const agentsResult = await pool
    .request()
    .input("tabId2", sql.Int, id)
    .query(`
      SELECT DISTINCT a.name
      FROM agents a
      INNER JOIN agent_tabs at2 ON at2.agent_id = a.id
      WHERE at2.tab_id = @tabId2
         OR at2.tab_id IN (SELECT t.id FROM tabs t WHERE t.name = 'generic')
      ORDER BY a.name ASC
    `);

  tab.agents = agentsResult.recordset.map((row: Record<string, unknown>) => row.name as string);

  // Populate errors — errors store tabIds in memory, filter from error-store
  const allErrors = getAllErrors();
  tab.errors = allErrors.filter((e) => e.tabIds?.includes(id));

  return tab;
}

export async function createTab(input: CreateTabInput): Promise<Tab> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("name", sql.NVarChar(100), input.name)
    .input("repositoryUrl", sql.NVarChar(500), input.repositoryUrl || null)
    .input("gitProvider", sql.VarChar(20), input.gitProvider ?? null)
    .input("userId", sql.Int, input.userId)
    .query(`
      INSERT INTO tabs (name, repository_url, git_provider, user_id)
      OUTPUT INSERTED.*
      VALUES (@name, @repositoryUrl, @gitProvider, @userId)
    `);

  return mapRowToTab(result.recordset[0]);
}

export async function updateTab(
  id: number,
  name: string,
  repositoryUrl?: string | null,
  mcpConfig?: TabMcpConfig | null,
  gitProvider?: GitProvider | null
): Promise<Tab | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .input("name", sql.NVarChar(100), name)
    .input("repositoryUrl", sql.NVarChar(500), repositoryUrl ?? null)
    .input("mcpConfig", sql.NVarChar(sql.MAX), mcpConfig ? JSON.stringify(mcpConfig) : null)
    .input("gitProvider", sql.VarChar(20), gitProvider ?? null)
    .query(`
      UPDATE tabs
      SET name = @name,
          repository_url = @repositoryUrl,
          mcp_config = COALESCE(@mcpConfig, mcp_config),
          git_provider = @gitProvider
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) return null;
  return mapRowToTab(result.recordset[0]);
}

export async function deleteTab(id: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("DELETE FROM tabs WHERE id = @id");

  return (result.rowsAffected[0] ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Agent ↔ Tab management
// ---------------------------------------------------------------------------

/**
 * Get all tab IDs an agent belongs to.
 */
export async function getAgentTabs(agentId: number): Promise<number[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agentId", sql.Int, agentId)
    .query("SELECT tab_id FROM agent_tabs WHERE agent_id = @agentId");
  return result.recordset.map((row: Record<string, unknown>) => row.tab_id as number);
}

/**
 * Assign an agent to one or more tabs (idempotent — duplicates are ignored).
 */
export async function assignAgentToTabs(
  agentId: number,
  tabIds: number[]
): Promise<void> {
  const pool = await getPool();
  for (const tabId of tabIds) {
    await pool
      .request()
      .input("agentId", sql.Int, agentId)
      .input("tabId", sql.Int, tabId)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM agent_tabs WHERE agent_id = @agentId AND tab_id = @tabId
        )
        INSERT INTO agent_tabs (agent_id, tab_id) VALUES (@agentId, @tabId)
      `);
  }
}

/**
 * Remove an agent from a specific tab.
 */
export async function removeAgentFromTab(
  agentId: number,
  tabId: number
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agentId", sql.Int, agentId)
    .input("tabId", sql.Int, tabId)
    .query("DELETE FROM agent_tabs WHERE agent_id = @agentId AND tab_id = @tabId");
  return (result.rowsAffected[0] ?? 0) > 0;
}

/**
 * Replace all tab assignments for an agent (set exactly to tabIds).
 */
export async function setAgentTabs(
  agentId: number,
  tabIds: number[]
): Promise<void> {
  const pool = await getPool();
  // Remove all existing
  await pool
    .request()
    .input("agentId", sql.Int, agentId)
    .query("DELETE FROM agent_tabs WHERE agent_id = @agentId");
  // Add new ones
  for (const tabId of tabIds) {
    await pool
      .request()
      .input("agentId", sql.Int, agentId)
      .input("tabId", sql.Int, tabId)
      .query("INSERT INTO agent_tabs (agent_id, tab_id) VALUES (@agentId, @tabId)");
  }
}


// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Check if the given tab IDs include the "generic" tab.
 * Used by session-manager to decide if an agent can claim tasks from any tab.
 */
export async function includesGenericTab(tabIds: number[]): Promise<boolean> {
  if (tabIds.length === 0) return false;
  const pool = await getPool();
  const result = await pool
    .request()
    .query(`SELECT id FROM tabs WHERE name = 'generic' AND id IN (${tabIds.join(",")})`);
  return result.recordset.length > 0;
}
