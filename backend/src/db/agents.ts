import { getPool, sql } from "./connection.js";
import type { Agent, AgentKind, CreateAgentInput, UpdateAgentInput } from "../types.js";

/**
 * Map a raw DB row to an Agent object.
 */
function mapRowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as number,
    name: row.name as string,
    description: row.description as string,
    prompt: row.prompt as string,
    tools: JSON.parse((row.tools as string) || "[]"),
    allowedTools: JSON.parse((row.allowed_tools as string) || "[]"),
    toolsSettings: JSON.parse((row.tools_settings as string) || "{}"),
    resources: JSON.parse((row.resources as string) || "[]"),
    kind: (row.kind as AgentKind) || "editor",
    claimState: (row.claim_state as string) || "todo",
    workingState: (row.working_state as string) || "in-progress",
    resolveState: (row.resolve_state as string) || "developed",
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
    "SELECT agent_id, tab_id FROM agent_tabs ORDER BY agent_id"
  );
  const tabMap = new Map<number, number[]>();
  for (const row of tabsResult.recordset) {
    const id = row.agent_id as number;
    if (!tabMap.has(id)) tabMap.set(id, []);
    tabMap.get(id)!.push(row.tab_id as number);
  }
  for (const agent of agents) {
    agent.tabIds = tabMap.get(agent.id) || [];
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
    .input("agentId", sql.Int, agent.id)
    .query("SELECT tab_id FROM agent_tabs WHERE agent_id = @agentId");
  agent.tabIds = tabsResult.recordset.map((row: Record<string, unknown>) => row.tab_id as number);

  return agent;
}

/**
 * Get a single agent by numeric ID.
 */
export async function getAgentById(id: number): Promise<Agent | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM agents WHERE id = @id");

  if (result.recordset.length === 0) return null;

  const agent = mapRowToAgent(result.recordset[0]);

  // Attach tabIds
  const tabsResult = await pool
    .request()
    .input("agentId", sql.Int, agent.id)
    .query("SELECT tab_id FROM agent_tabs WHERE agent_id = @agentId");
  agent.tabIds = tabsResult.recordset.map((row: Record<string, unknown>) => row.tab_id as number);

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
    .input("kind", sql.VarChar(20), input.kind || "editor")
    .input("claimState", sql.VarChar(50), input.claimState || "todo")
    .input("workingState", sql.VarChar(50), input.workingState || "in-progress")
    .input("resolveState", sql.VarChar(50), input.resolveState || "developed")
    .input("userId", sql.Int, input.userId)
    .query(`
      INSERT INTO agents (name, description, prompt, tools, allowed_tools, tools_settings, resources, kind, claim_state, working_state, resolve_state, user_id)
      OUTPUT INSERTED.*
      VALUES (@name, @description, @prompt, @tools, @allowedTools, @toolsSettings, @resources, @kind, @claimState, @workingState, @resolveState, @userId)
    `);

  const agent = mapRowToAgent(result.recordset[0]);

  // Assign to tabs if provided
  if (input.tabIds && input.tabIds.length > 0) {
    await setAgentTabAssignments(agent.id, input.tabIds);
    agent.tabIds = input.tabIds;
  } else {
    agent.tabIds = [];
  }

  return agent;
}

/**
 * Update an existing agent by numeric ID.
 */
export async function updateAgent(
  agentId: number,
  input: UpdateAgentInput
): Promise<Agent | null> {
  const pool = await getPool();

  // Check the agent exists
  const existing = await getAgentById(agentId);
  if (!existing) return null;

  const newName = input.name || existing.name;

  const result = await pool
    .request()
    .input("id", sql.Int, agentId)
    .input("name", sql.NVarChar(100), newName)
    .input("description", sql.NVarChar(sql.MAX), input.description ?? existing.description)
    .input("prompt", sql.NVarChar(sql.MAX), input.prompt ?? existing.prompt)
    .input("tools", sql.NVarChar(sql.MAX), JSON.stringify(input.tools ?? existing.tools))
    .input("allowedTools", sql.NVarChar(sql.MAX), JSON.stringify(input.allowedTools ?? existing.allowedTools))
    .input("toolsSettings", sql.NVarChar(sql.MAX), JSON.stringify(input.toolsSettings ?? existing.toolsSettings))
    .input("resources", sql.NVarChar(sql.MAX), JSON.stringify(input.resources ?? existing.resources))
    .input("kind", sql.VarChar(20), input.kind ?? existing.kind)
    .input("claimState", sql.VarChar(50), input.claimState ?? existing.claimState)
    .input("workingState", sql.VarChar(50), input.workingState ?? existing.workingState)
    .input("resolveState", sql.VarChar(50), input.resolveState ?? existing.resolveState)
    .query(`
      UPDATE agents
      SET name = @name,
          description = @description,
          prompt = @prompt,
          tools = @tools,
          allowed_tools = @allowedTools,
          tools_settings = @toolsSettings,
          resources = @resources,
          kind = @kind,
          claim_state = @claimState,
          working_state = @workingState,
          resolve_state = @resolveState,
          updated_at = GETUTCDATE()
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) return null;
  const agent = mapRowToAgent(result.recordset[0]);

  // Update tab assignments if provided
  if (input.tabIds !== undefined) {
    await setAgentTabAssignments(agentId, input.tabIds);
    agent.tabIds = input.tabIds;
  } else {
    agent.tabIds = existing.tabIds;
  }

  return agent;
}

/**
 * Delete an agent by numeric ID.
 */
export async function deleteAgent(id: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("DELETE FROM agents WHERE id = @id");

  return (result.rowsAffected[0] ?? 0) > 0;
}

/**
 * Get agents available for a specific tab.
 * Returns agents directly assigned to the given tab OR not assigned to any tab
 * at all (an empty tab assignment means "usable on every board"). Only agents
 * owned by the tab's owner are considered, so unassigned agents never leak
 * across accounts.
 */
export async function getAgentsForTab(tabId: number): Promise<Agent[]> {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("tabId", sql.Int, tabId)
    .query(`
      SELECT DISTINCT a.*
      FROM agents a
      INNER JOIN tabs t ON t.id = @tabId
      WHERE a.user_id = t.user_id
        AND (
          a.id IN (SELECT agent_id FROM agent_tabs WHERE tab_id = @tabId)
          OR a.id NOT IN (SELECT agent_id FROM agent_tabs)
        )
      ORDER BY a.name ASC
    `);

  const agents = result.recordset.map(mapRowToAgent);

  // Attach tabIds for each agent
  if (agents.length > 0) {
    const ids = agents.map((a: Agent) => a.id);
    const tabRequest = pool.request();
    ids.forEach((id: number, i: number) => {
      tabRequest.input(`id${i}`, sql.Int, id);
    });
    const tabsRes = await tabRequest.query(
      `SELECT agent_id, tab_id FROM agent_tabs WHERE agent_id IN (${ids.map((_: number, i: number) => `@id${i}`).join(", ")})`
    );
    const tabMap = new Map<number, number[]>();
    for (const row of tabsRes.recordset) {
      const id = row.agent_id as number;
      if (!tabMap.has(id)) tabMap.set(id, []);
      tabMap.get(id)!.push(row.tab_id as number);
    }
    for (const agent of agents) {
      agent.tabIds = tabMap.get(agent.id) || [];
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
