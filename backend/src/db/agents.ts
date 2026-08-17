import type { ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import { getNextId } from "./id-counter.js";
import type { Agent, AgentKind, CreateAgentInput, UpdateAgentInput } from "../types.js";

/**
 * Neo4j-backed data access for the `:Agent` node label. See design.md's
 * "Graph data model" section for the full node/relationship model:
 *
 *   (:User)-[:OWNS]->(:Agent)                     0 or 1 owner
 *   (:Agent)-[:IN_TAB]->(:Tab)                     0+, also independently
 *                                                  managed by db/tabs.ts
 *   (:Agent)-[:HAS_TOOLS_SETTINGS]->(:ToolsSettings)  0 or 1, arbitrary map
 *
 * `userId` and `tabIds` on the returned `Agent` object are derived from the
 * OWNS/IN_TAB relationships at read time — they are never stored as
 * properties on the `:Agent` node itself.
 *
 * ToolsSettings storage note: `toolsSettings` is typed `Record<string,
 * unknown>` — genuinely arbitrary/dynamic, not a fixed shape. Neo4j node
 * properties can only be primitives or arrays of primitives, never nested
 * objects, so a spread-merge (`SET ts += $map`) fails outright the moment a
 * caller's toolsSettings contains any nested value (confirmed empirically:
 * `Property values can only be of primitive types or arrays thereof`). This
 * is the same "arbitrary/unknown shape stays an opaque string" case
 * design.md calls out for RawMcpServerConfig — `:ToolsSettings` therefore
 * stores one property, `json` (a JSON string of the whole object), parsed
 * back to a plain object on every read.
 */

/**
 * Map the `a{.*}` map projection plus the separately-queried relationship
 * data (tabIds, toolsSettingsJson, userId) to an Agent object.
 *
 * toolsSettingsJson is a raw JSON string (see ToolsSettings note below) —
 * parsed back into a plain object here, defaulting to {} if absent/invalid.
 */
function mapToAgent(
  agentProps: Record<string, unknown>,
  tabIds: number[],
  toolsSettingsJson: string | null | undefined,
  userId: number | null
): Agent {
  let toolsSettings: Record<string, unknown> = {};
  if (toolsSettingsJson) {
    try {
      toolsSettings = JSON.parse(toolsSettingsJson);
    } catch {
      // Corrupted/unparseable — fall back to {} rather than throw.
    }
  }

  return {
    id: agentProps.id as number,
    name: agentProps.name as string,
    description: agentProps.description as string,
    prompt: agentProps.prompt as string,
    tools: (agentProps.tools as string[]) ?? [],
    allowedTools: (agentProps.allowedTools as string[]) ?? [],
    toolsSettings,
    resources: (agentProps.resources as string[]) ?? [],
    kind: (agentProps.kind as AgentKind) || "editor",
    tabIds,
    userId: userId ?? 0,
    claimState: (agentProps.claimState as string) || "todo",
    workingState: (agentProps.workingState as string) || "in-progress",
    resolveState: (agentProps.resolveState as string) || "developed",
    requiresTask:
      agentProps.requiresTask !== undefined && agentProps.requiresTask !== null
        ? !!agentProps.requiresTask
        : true,
    createdAt: (agentProps.createdAt as { toString(): string }).toString(),
    updatedAt: (agentProps.updatedAt as { toString(): string }).toString(),
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
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent)
       WHERE $userId IS NULL OR EXISTS { (:User {id: $userId})-[:OWNS]->(a) }
       OPTIONAL MATCH (a)-[:IN_TAB]->(t:Tab)
       WITH a, collect(t.id) AS tabIds
       OPTIONAL MATCH (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
       OPTIONAL MATCH (owner:User)-[:OWNS]->(a)
       RETURN a{.*} AS agent, tabIds, ts.json AS toolsSettingsJson, owner.id AS userId
       ORDER BY a.name ASC`,
      { userId: userId ?? null }
    );
    return result.records.map((record) =>
      mapToAgent(
        record.get("agent"),
        record.get("tabIds"),
        record.get("toolsSettingsJson"),
        record.get("userId")
      )
    );
  });
}

/**
 * Get a single agent by name.
 */
export async function getAgentByName(name: string): Promise<Agent | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent {name: $name})
       OPTIONAL MATCH (a)-[:IN_TAB]->(t:Tab)
       WITH a, collect(t.id) AS tabIds
       OPTIONAL MATCH (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
       OPTIONAL MATCH (owner:User)-[:OWNS]->(a)
       RETURN a{.*} AS agent, tabIds, ts.json AS toolsSettingsJson, owner.id AS userId`,
      { name }
    );
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return mapToAgent(
      record.get("agent"),
      record.get("tabIds"),
      record.get("toolsSettingsJson"),
      record.get("userId")
    );
  });
}

/**
 * Get a single agent by numeric ID.
 */
export async function getAgentById(id: number): Promise<Agent | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent {id: $id})
       OPTIONAL MATCH (a)-[:IN_TAB]->(t:Tab)
       WITH a, collect(t.id) AS tabIds
       OPTIONAL MATCH (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
       OPTIONAL MATCH (owner:User)-[:OWNS]->(a)
       RETURN a{.*} AS agent, tabIds, ts.json AS toolsSettingsJson, owner.id AS userId`,
      { id }
    );
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return mapToAgent(
      record.get("agent"),
      record.get("tabIds"),
      record.get("toolsSettingsJson"),
      record.get("userId")
    );
  });
}

/**
 * Create a new agent.
 */
export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const id = await getNextId("Agent");

  const agent = await writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `CREATE (a:Agent {
         id: $id, name: $name, description: $description, prompt: $prompt,
         tools: $tools, allowedTools: $allowedTools, resources: $resources,
         kind: $kind, claimState: $claimState, workingState: $workingState,
         resolveState: $resolveState, requiresTask: $requiresTask,
         createdAt: datetime(), updatedAt: datetime()
       })
       CREATE (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings {json: $toolsSettingsJson})
       WITH a, ts
       OPTIONAL MATCH (owner:User {id: $userId})
       FOREACH (_ IN CASE WHEN owner IS NOT NULL THEN [1] ELSE [] END | MERGE (owner)-[:OWNS]->(a))
       RETURN a{.*} AS agent, ts.json AS toolsSettingsJson, owner.id AS userId`,
      {
        id,
        name: input.name,
        description: input.description || "",
        prompt: input.prompt || "",
        tools: input.tools || [],
        allowedTools: input.allowedTools || [],
        resources: input.resources || [],
        kind: input.kind || "editor",
        claimState: input.claimState || "todo",
        workingState: input.workingState || "in-progress",
        resolveState: input.resolveState || "developed",
        requiresTask: input.requiresTask !== false,
        toolsSettingsJson: JSON.stringify(input.toolsSettings ?? {}),
        userId: input.userId ?? null,
      }
    );

    const record = result.records[0];
    return mapToAgent(record.get("agent"), [], record.get("toolsSettingsJson"), record.get("userId"));
  });

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
  // Check the agent exists
  const existing = await getAgentById(agentId);
  if (!existing) return null;

  const newName = input.name || existing.name;
  // toolsSettings is a full replace, not a partial merge (matches the
  // original's JSON.stringify(input.toolsSettings ?? existing.toolsSettings)
  // semantics) — only touched at all when the caller explicitly provided it.
  const toolsSettingsProvided = input.toolsSettings !== undefined;

  const agent = await writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent {id: $id})
       SET a.name = $name,
           a.description = $description,
           a.prompt = $prompt,
           a.tools = $tools,
           a.allowedTools = $allowedTools,
           a.resources = $resources,
           a.kind = $kind,
           a.claimState = $claimState,
           a.workingState = $workingState,
           a.resolveState = $resolveState,
           a.requiresTask = $requiresTask,
           a.updatedAt = datetime()
       WITH a
       FOREACH (_ IN CASE WHEN $toolsSettingsProvided THEN [1] ELSE [] END |
         MERGE (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
         SET ts.json = $toolsSettingsJson
       )
       WITH a
       OPTIONAL MATCH (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
       OPTIONAL MATCH (owner:User)-[:OWNS]->(a)
       RETURN a{.*} AS agent, ts.json AS toolsSettingsJson, owner.id AS userId`,
      {
        id: agentId,
        name: newName,
        description: input.description ?? existing.description,
        prompt: input.prompt ?? existing.prompt,
        tools: input.tools ?? existing.tools,
        allowedTools: input.allowedTools ?? existing.allowedTools,
        resources: input.resources ?? existing.resources,
        kind: input.kind ?? existing.kind,
        claimState: input.claimState ?? existing.claimState,
        workingState: input.workingState ?? existing.workingState,
        resolveState: input.resolveState ?? existing.resolveState,
        requiresTask: input.requiresTask ?? existing.requiresTask,
        toolsSettingsProvided,
        // SET ts.json = ... (a plain scalar assignment) is already a full
        // replace, not a merge — this JSON string overwrites the previous
        // one outright, matching the original's JSON.stringify(input ??
        // existing) full-replace semantics with no extra "clear first" step
        // needed (unlike the old spread-merge approach, which is why this
        // no longer needs the SET ts = {} reset that used to precede it).
        toolsSettingsJson: JSON.stringify(input.toolsSettings ?? {}),
      }
    );

    if (result.records.length === 0) return null;
    const record = result.records[0];
    return mapToAgent(record.get("agent"), [], record.get("toolsSettingsJson"), record.get("userId"));
  });

  if (!agent) return null;

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
 * Also deletes the agent's linked ToolsSettings sub-node, if any, so it
 * doesn't become an orphaned node in the graph.
 */
export async function deleteAgent(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent {id: $id})
       OPTIONAL MATCH (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
       DETACH DELETE a, ts
       RETURN count(a) AS deletedCount`,
      { id }
    );
    return result.records[0].get("deletedCount") > 0;
  });
}

/**
 * Get agents available for a specific tab.
 * Returns agents directly assigned to the given tab OR not assigned to any tab
 * at all (an empty tab assignment means "usable on every board"). Only agents
 * owned by the tab's owner are considered, so unassigned agents never leak
 * across accounts.
 */
export async function getAgentsForTab(tabId: number): Promise<Agent[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Tab {id: $tabId})
       MATCH (owner0:User)-[:OWNS]->(t)
       MATCH (owner0)-[:OWNS]->(a:Agent)
       WHERE (a)-[:IN_TAB]->(t) OR NOT EXISTS { (a)-[:IN_TAB]->(:Tab) }
       WITH DISTINCT a
       OPTIONAL MATCH (a)-[:IN_TAB]->(t2:Tab)
       WITH a, collect(t2.id) AS tabIds
       OPTIONAL MATCH (a)-[:HAS_TOOLS_SETTINGS]->(ts:ToolsSettings)
       OPTIONAL MATCH (owner:User)-[:OWNS]->(a)
       RETURN a{.*} AS agent, tabIds, ts.json AS toolsSettingsJson, owner.id AS userId
       ORDER BY agent.name ASC`,
      { tabId }
    );
    return result.records.map((record) =>
      mapToAgent(
        record.get("agent"),
        record.get("tabIds"),
        record.get("toolsSettingsJson"),
        record.get("userId")
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Tab assignment helpers
// ---------------------------------------------------------------------------

/**
 * Replace all tab assignments for an agent (set exactly to tabIds).
 */
async function setAgentTabAssignments(agentId: number, tabIds: number[]): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    // Remove all existing
    await tx.run(`MATCH (a:Agent {id: $agentId})-[r:IN_TAB]->(:Tab) DELETE r`, { agentId });
    // Add new ones
    for (const tabId of tabIds) {
      await tx.run(
        `MATCH (a:Agent {id: $agentId}), (t:Tab {id: $tabId}) MERGE (a)-[:IN_TAB]->(t)`,
        { agentId, tabId }
      );
    }
  });
}
