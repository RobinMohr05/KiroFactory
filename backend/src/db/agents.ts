import { getPool, sql } from "./connection.js";
import type { Agent, CreateAgentInput, UpdateAgentInput } from "../types.js";

/**
 * Map a raw DB row to an Agent object.
 */
function mapRowToAgent(row: Record<string, unknown>): Agent {
  return {
    name: row.name as string,
    description: row.description as string,
    prompt: row.prompt as string,
    tools: JSON.parse((row.tools as string) || "[]"),
    allowedTools: JSON.parse((row.allowed_tools as string) || "[]"),
    toolsSettings: JSON.parse((row.tools_settings as string) || "{}"),
    resources: JSON.parse((row.resources as string) || "[]"),
    userId: (row.user_id as number) ?? 0,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get all agents, with their tab assignments.
 * If userId is provided, only returns agents owned by that user.
 */
export async function getAllAgents(userId?: number): Promise<Agent[]> {
  const pool = await getPool();
  let result;
  if (userId) {
    result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query("SELECT * FROM agents WHERE user_id = @userId ORDER BY name ASC");
  } else {
    result = await pool.request().query("SELECT * FROM agents ORDER BY name ASC");
  }
  const agents = result.recordset.map(mapRowToAgent);

  // Attach tabIds for each agent
  const tabsResult = await pool.request().query(
    "SELECT agent_name, tab_id FROM agent_tabs ORDER BY agent_name"
  );
  const tabMap = new Map<string, number[]>();
  for (const row of tabsResult.recordset) {
    const name = row.agent_name as string;
    if (!tabMap.has(name)) tabMap.set(name, []);
    tabMap.get(name)!.push(row.tab_id as number);
  }
  for (const agent of agents) {
    agent.tabIds = tabMap.get(agent.name) || [];
  }

  return agents;
}

/**
 * Get a single agent by name.
 */
export async function getAgentByName(name: string): Promise<Agent | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("name", sql.NVarChar(100), name)
    .query("SELECT * FROM agents WHERE name = @name");

  if (result.recordset.length === 0) return null;

  const agent = mapRowToAgent(result.recordset[0]);

  // Attach tabIds
  const tabsResult = await pool
    .request()
    .input("agentName", sql.NVarChar(100), name)
    .query("SELECT tab_id FROM agent_tabs WHERE agent_name = @agentName");
  agent.tabIds = tabsResult.recordset.map((row) => row.tab_id as number);

  return agent;
}

/**
 * Create a new agent.
 */
export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("name", sql.NVarChar(100), input.name)
    .input("description", sql.NVarChar(sql.MAX), input.description || "")
    .input("prompt", sql.NVarChar(sql.MAX), input.prompt || "")
    .input("tools", sql.NVarChar(sql.MAX), JSON.stringify(input.tools || []))
    .input("allowedTools", sql.NVarChar(sql.MAX), JSON.stringify(input.allowedTools || []))
    .input("toolsSettings", sql.NVarChar(sql.MAX), JSON.stringify(input.toolsSettings || {}))
    .input("resources", sql.NVarChar(sql.MAX), JSON.stringify(input.resources || []))
    .input("userId", sql.Int, input.userId)
    .query(`
      INSERT INTO agents (name, description, prompt, tools, allowed_tools, tools_settings, resources, user_id)
      OUTPUT INSERTED.*
      VALUES (@name, @description, @prompt, @tools, @allowedTools, @toolsSettings, @resources, @userId)
    `);

  const agent = mapRowToAgent(result.recordset[0]);

  // Assign to tabs if provided
  if (input.tabIds && input.tabIds.length > 0) {
    await setAgentTabAssignments(input.name, input.tabIds);
    agent.tabIds = input.tabIds;
  } else {
    agent.tabIds = [];
  }

  return agent;
}

/**
 * Update an existing agent. If name changes, the old name row is deleted and a new one is created.
 */
export async function updateAgent(
  currentName: string,
  input: UpdateAgentInput
): Promise<Agent | null> {
  const pool = await getPool();

  // Check the agent exists
  const existing = await getAgentByName(currentName);
  if (!existing) return null;

  const newName = input.name || currentName;
  const isRename = newName !== currentName;

  if (isRename) {
    // Check new name doesn't exist
    const conflict = await getAgentByName(newName);
    if (conflict) {
      throw new Error("An agent with this name already exists");
    }

    // Delete old agent (cascade removes agent_tabs entries)
    await pool
      .request()
      .input("oldName", sql.NVarChar(100), currentName)
      .query("DELETE FROM agents WHERE name = @oldName");

    // Insert as new name (preserve user_id from the existing agent)
    const result = await pool
      .request()
      .input("name", sql.NVarChar(100), newName)
      .input("description", sql.NVarChar(sql.MAX), input.description ?? existing.description)
      .input("prompt", sql.NVarChar(sql.MAX), input.prompt ?? existing.prompt)
      .input("tools", sql.NVarChar(sql.MAX), JSON.stringify(input.tools ?? existing.tools))
      .input("allowedTools", sql.NVarChar(sql.MAX), JSON.stringify(input.allowedTools ?? existing.allowedTools))
      .input("toolsSettings", sql.NVarChar(sql.MAX), JSON.stringify(input.toolsSettings ?? existing.toolsSettings))
      .input("resources", sql.NVarChar(sql.MAX), JSON.stringify(input.resources ?? existing.resources))
      .input("userId", sql.Int, existing.userId)
      .query(`
        INSERT INTO agents (name, description, prompt, tools, allowed_tools, tools_settings, resources, user_id)
        OUTPUT INSERTED.*
        VALUES (@name, @description, @prompt, @tools, @allowedTools, @toolsSettings, @resources, @userId)
      `);

    const agent = mapRowToAgent(result.recordset[0]);

    // Reassign tabs
    const tabIds = input.tabIds ?? existing.tabIds ?? [];
    if (tabIds.length > 0) {
      await setAgentTabAssignments(newName, tabIds);
    }
    agent.tabIds = tabIds;

    return agent;
  }

  // Simple update (no rename)
  const result = await pool
    .request()
    .input("name", sql.NVarChar(100), currentName)
    .input("description", sql.NVarChar(sql.MAX), input.description ?? existing.description)
    .input("prompt", sql.NVarChar(sql.MAX), input.prompt ?? existing.prompt)
    .input("tools", sql.NVarChar(sql.MAX), JSON.stringify(input.tools ?? existing.tools))
    .input("allowedTools", sql.NVarChar(sql.MAX), JSON.stringify(input.allowedTools ?? existing.allowedTools))
    .input("toolsSettings", sql.NVarChar(sql.MAX), JSON.stringify(input.toolsSettings ?? existing.toolsSettings))
    .input("resources", sql.NVarChar(sql.MAX), JSON.stringify(input.resources ?? existing.resources))
    .query(`
      UPDATE agents
      SET description = @description,
          prompt = @prompt,
          tools = @tools,
          allowed_tools = @allowedTools,
          tools_settings = @toolsSettings,
          resources = @resources,
          updated_at = GETUTCDATE()
      OUTPUT INSERTED.*
      WHERE name = @name
    `);

  if (result.recordset.length === 0) return null;
  const agent = mapRowToAgent(result.recordset[0]);

  // Update tab assignments if provided
  if (input.tabIds !== undefined) {
    await setAgentTabAssignments(currentName, input.tabIds);
    agent.tabIds = input.tabIds;
  } else {
    agent.tabIds = existing.tabIds;
  }

  return agent;
}

/**
 * Delete an agent by name.
 */
export async function deleteAgent(name: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("name", sql.NVarChar(100), name)
    .query("DELETE FROM agents WHERE name = @name");

  return (result.rowsAffected[0] ?? 0) > 0;
}

/**
 * Get agents available for a specific tab.
 * Returns agents directly assigned to the given tab OR assigned to the "generic" tab.
 * This implements the rule: "generic" agents can be used in any board,
 * while board-specific agents can only be used in their assigned board.
 */
export async function getAgentsForTab(tabId: number): Promise<Agent[]> {
  const pool = await getPool();

  // Get agents assigned to this tab OR to the "generic" tab
  const result = await pool
    .request()
    .input("tabId", sql.Int, tabId)
    .query(`
      SELECT DISTINCT a.*
      FROM agents a
      INNER JOIN agent_tabs at2 ON at2.agent_name = a.name
      WHERE at2.tab_id = @tabId
         OR at2.tab_id IN (SELECT t.id FROM tabs t WHERE t.name = 'generic')
      ORDER BY a.name ASC
    `);

  const agents = result.recordset.map(mapRowToAgent);

  // Attach tabIds for each agent
  if (agents.length > 0) {
    const names = agents.map((a) => a.name);
    const tabsResult = await pool.request().query(
      `SELECT agent_name, tab_id FROM agent_tabs WHERE agent_name IN (${names.map((_, i) => `@name${i}`).join(", ")})`
        .replace(/SELECT/, "SELECT") // no-op, just to use parameterized below
    );
    // Re-query with parameters for safety
    const tabRequest = pool.request();
    names.forEach((name, i) => {
      tabRequest.input(`name${i}`, sql.NVarChar(100), name);
    });
    const tabsRes = await tabRequest.query(
      `SELECT agent_name, tab_id FROM agent_tabs WHERE agent_name IN (${names.map((_, i) => `@name${i}`).join(", ")})`
    );
    const tabMap = new Map<string, number[]>();
    for (const row of tabsRes.recordset) {
      const name = row.agent_name as string;
      if (!tabMap.has(name)) tabMap.set(name, []);
      tabMap.get(name)!.push(row.tab_id as number);
    }
    for (const agent of agents) {
      agent.tabIds = tabMap.get(agent.name) || [];
    }
  }

  return agents;
}

// ---------------------------------------------------------------------------
// Tab assignment helpers
// ---------------------------------------------------------------------------

/**
 * Replace all tab assignments for an agent (set exactly to tabIds).
 */
async function setAgentTabAssignments(
  agentName: string,
  tabIds: number[]
): Promise<void> {
  const pool = await getPool();
  // Remove all existing
  await pool
    .request()
    .input("agentName", sql.NVarChar(100), agentName)
    .query("DELETE FROM agent_tabs WHERE agent_name = @agentName");
  // Add new ones
  for (const tabId of tabIds) {
    await pool
      .request()
      .input("agentName", sql.NVarChar(100), agentName)
      .input("tabId", sql.Int, tabId)
      .query("INSERT INTO agent_tabs (agent_name, tab_id) VALUES (@agentName, @tabId)");
  }
}
