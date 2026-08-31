/**
 * Neo4j-backed implementation of the tabs data-access layer.
 *
 * Every exported function here keeps the exact name, parameter types, and
 * return type it had under the previous mssql-based implementation — see
 * .kiro/specs/neo4j-migration/design.md for the full :Tab node model and
 * migration rationale. Only the internals (SQL -> Cypher, mssql pool ->
 * neo4j-driver managed transactions) change.
 *
 * Node/relationship model (design.md):
 *   (:Tab {id, name, repositoryUrl, gitProvider, columns, sortOrder, createdAt})
 *   (:User)-[:OWNS]->(:Tab)                — 0 or 1 owner, not a stored property
 *   (:Task)-[:IN_TAB]->(:Tab)              — read-only here, tasks.ts owns writes
 *   (:Agent)-[:IN_TAB]->(:Tab)             — shared with db/agents.ts's own
 *                                             tab-assignment helper; same
 *                                             relationship type/direction,
 *                                             no relationship properties.
 *
 * Per Neo4j's current query-writing guidance (avoid OPTIONAL MATCH chains
 * for "0-or-1 related node"/"0-or-more related nodes, unordered" shapes),
 * every 0-or-1/0-or-more traversal below uses a list comprehension
 * (`[(pattern) | projection]`, optionally `[0]` for "at most one") instead
 * of `OPTIONAL MATCH` + `collect()`. This was verified against the live
 * AuraDB instance during implementation: `collect({id: dep.id, ...})` over
 * an OPTIONAL MATCH that finds nothing produces `[{id: null, ...}]` (a
 * false-positive non-empty list), not `[]` — the list-comprehension form
 * used throughout this file does not have that bug, and also avoids the
 * row-multiplication chained-OPTIONAL-MATCH is prone to.
 */

import { readQuery, writeQuery } from "./connection.js";
import type { ManagedTransaction } from "neo4j-driver";
import type { Tab, CreateTabInput, Task, GitProvider } from "../types.js";
import { isGitProvider } from "../types.js";
import { getNextId } from "./id-counter.js";
import { getAllSessions } from "../session-manager.js";
import { getAllErrors } from "../error-store.js";

/**
 * Minimal typed view of a Neo4j Node value pulled out of a query result
 * record — just the bit every mapper here needs.
 */
interface NodeResult {
  properties: Record<string, unknown>;
}

const DEFAULT_COLUMNS = ["todo", "in-progress", "developed", "in-code-review", "reviewed", "in-qa", "done"];

/**
 * Map a :Tab node's properties, plus its resolved ownerId, to a Tab object.
 */
function mapNodeToTab(
  tabProps: Record<string, unknown>,
  ownerId: number | null
): Tab {
  const columns = Array.isArray(tabProps.columns) && tabProps.columns.length > 0
    ? (tabProps.columns as string[])
    : DEFAULT_COLUMNS;

  const gitProvider = tabProps.gitProvider as string | null | undefined;

  return {
    id: tabProps.id as number,
    name: tabProps.name as string,
    repositoryUrl: (tabProps.repositoryUrl as string) || null,
    gitProvider: isGitProvider(gitProvider) ? gitProvider : null,
    autoMergePrs: !!(tabProps.autoMergePrs),
    columns,
    sortOrder: (tabProps.sortOrder as number) ?? 0,
    userId: ownerId ?? 0,
    // createdAt comes back as a neo4j-driver DateTime value, not a JS Date —
    // .toString() on it produces an ISO 8601 string directly.
    createdAt: (tabProps.createdAt as { toString(): string }).toString(),
  };
}

/**
 * Map a :Task node's properties (plus its blocked-by-dependency info) to a
 * Task object, for the read-only join in getTabWithTasks. Mirrors the shape
 * db/tasks.ts's own mapper produces, including the isBlocked/blockedBy
 * fields tasks.ts is adding to every task read path (see design.md's task
 * dependency section) — replicated here via the same list-comprehension
 * pattern rather than N+1 queries.
 */
function mapNodeToTaskWithBlocked(
  props: Record<string, unknown>,
  dependsOn: number[],
  blockedBy: Array<{ id: number; title: string }>
): Task {
  return {
    id: props.id as number,
    title: props.title as string,
    priority: props.priority as 1 | 2 | 3 | 4,
    type: props.type as Task["type"],
    state: props.state as string,
    description: props.description as string,
    files: (props.files as string[]) ?? [],
    origin: props.origin as Task["origin"],
    branch: (props.branch as string) || null,
    pullRequestUrl: (props.pullRequestUrl as string) || null,
    groupId: (props.groupId as string) || null,
    createdAt: (props.createdAt as { toString(): string }).toString(),
    updatedAt: (props.updatedAt as { toString(): string }).toString(),
    dependsOn,
    isBlocked: blockedBy.length > 0,
    blockedBy,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getAllTabs(userId?: number): Promise<Tab[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const query = userId
      ? `MATCH (u:User {id: $userId})-[:OWNS]->(t:Tab)
         RETURN t,
                $userId AS ownerId
         ORDER BY t.sortOrder ASC, t.name ASC`
      : `MATCH (t:Tab)
         RETURN t,
                [(owner:User)-[:OWNS]->(t) | owner.id][0] AS ownerId
         ORDER BY t.sortOrder ASC, t.name ASC`;

    const result = await tx.run(query, { userId });
    return result.records.map((record) => {
      const tabNode = record.get("t") as NodeResult;
      const ownerId = record.get("ownerId") as number | null;
      return mapNodeToTab(tabNode.properties, ownerId);
    });
  });
}

/**
 * Reorder tabs by setting sortOrder for each tab ID in the given order.
 * @param tabIds - Array of tab IDs in the desired display order
 */
export async function reorderTabs(tabIds: number[]): Promise<void> {
  for (let i = 0; i < tabIds.length; i++) {
    await writeQuery(async (tx: ManagedTransaction) => {
      await tx.run(`MATCH (t:Tab {id: $id}) SET t.sortOrder = $order`, {
        id: tabIds[i],
        order: i,
      });
    });
  }
}

export async function getTabById(id: number): Promise<Tab | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Tab {id: $id})
       RETURN t,
              [(owner:User)-[:OWNS]->(t) | owner.id][0] AS ownerId`,
      { id }
    );
    if (result.records.length === 0) return null;

    const tabNode = result.records[0].get("t") as NodeResult;
    const ownerId = result.records[0].get("ownerId") as number | null;
    return mapNodeToTab(tabNode.properties, ownerId);
  });
}

/**
 * Get a tab with all its related entities: tasks, sessions, and agents.
 */
export async function getTabWithTasks(id: number): Promise<Tab | null> {
  const tab = await getTabById(id);
  if (!tab) return null;

  // Populate tasks via IN_TAB, including isBlocked/blockedBy (see module
  // comment — list comprehension, not OPTIONAL MATCH + collect, to avoid
  // the null-placeholder bug that pattern has).
  const tasks = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task)-[:IN_TAB]->(:Tab {id: $id})
       WITH t,
            [(t)-[:DEPENDS_ON]->(dep:Task) | dep.id] AS dependsOn,
            [(t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done' | {id: dep.id, title: dep.title}] AS blockedBy
       RETURN t, dependsOn, blockedBy
       ORDER BY t.priority ASC, t.createdAt DESC`,
      { id }
    );
    return result.records.map((record) => {
      const taskNode = record.get("t") as NodeResult;
      const dependsOn = record.get("dependsOn") as number[];
      const blockedBy = record.get("blockedBy") as Array<{ id: number; title: string }>;
      return mapNodeToTaskWithBlocked(taskNode.properties, dependsOn, blockedBy);
    });
  });
  tab.tasks = tasks;

  // Populate sessions — sessions store tabIds in memory/JSON, so filter from
  // session-manager. Completely unrelated to which database backs persistent
  // storage — left exactly as-is.
  const allSessions = getAllSessions();
  tab.sessions = allSessions
    .filter((s) => s.tabIds?.includes(id))
    .map((s) => ({ id: s.id, name: s.name, agent: s.agent, status: s.status }));

  // Populate agents: directly assigned to this tab OR unassigned to any tab
  // at all, restricted to the tab owner's own agents. An owner-less tab
  // (t has no OWNS edge) matches the original SQL's ANSI-NULL semantics —
  // `a.user_id = t.user_id` is never true when either side is NULL, so an
  // unowned tab always sees zero agents, never "all unassigned agents
  // regardless of owner." Confirmed against the live AuraDB instance.
  const agents = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Tab {id: $id})
       OPTIONAL MATCH (owner:User)-[:OWNS]->(t)
       WITH t, owner
       WHERE owner IS NOT NULL
       MATCH (owner)-[:OWNS]->(a:Agent)
       WHERE (a)-[:IN_TAB]->(t) OR NOT EXISTS { (a)-[:IN_TAB]->(:Tab) }
       RETURN DISTINCT a.name AS name
       ORDER BY name ASC`,
      { id }
    );
    return result.records.map((record) => record.get("name") as string);
  });
  tab.agents = agents;

  // Populate errors — errors store tabIds in memory, filter from
  // error-store. Left exactly as-is, same as sessions above.
  const allErrors = getAllErrors();
  tab.errors = allErrors.filter((e) => e.tabIds?.includes(id));

  return tab;
}

export async function createTab(input: CreateTabInput): Promise<Tab> {
  const id = await getNextId("Tab");

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `CREATE (t:Tab {
         id: $id,
         name: $name,
         repositoryUrl: $repositoryUrl,
         gitProvider: $gitProvider,
         autoMergePrs: $autoMergePrs,
         columns: $columns,
         sortOrder: 0,
         createdAt: datetime()
       })
       WITH t
       OPTIONAL MATCH (owner:User {id: $userId})
       FOREACH (_ IN CASE WHEN owner IS NOT NULL THEN [1] ELSE [] END |
         MERGE (owner)-[:OWNS]->(t)
       )
       RETURN t`,
      {
        id,
        name: input.name,
        repositoryUrl: input.repositoryUrl ?? null,
        gitProvider: input.gitProvider ?? null,
        autoMergePrs: false,
        columns: DEFAULT_COLUMNS,
        userId: input.userId ?? null,
      }
    );

    const tabNode = result.records[0].get("t") as NodeResult;
    return mapNodeToTab(tabNode.properties, input.userId ?? null);
  });
}

export async function updateTab(
  id: number,
  name: string,
  repositoryUrl?: string | null,
  gitProvider?: GitProvider | null,
  autoMergePrs?: boolean
): Promise<Tab | null> {
  const hasAutoMergePrs = autoMergePrs !== undefined;

  return writeQuery(async (tx: ManagedTransaction) => {
    // autoMergePrs uses FOREACH(CASE ...) pattern: only update the
    // property when the caller explicitly provided a value.
    const result = await tx.run(
      `MATCH (t:Tab {id: $id})
       SET t.name = $name,
           t.repositoryUrl = $repositoryUrl,
           t.gitProvider = $gitProvider
       WITH t
       FOREACH (_ IN CASE WHEN $hasAutoMergePrs THEN [1] ELSE [] END |
         SET t.autoMergePrs = $autoMergePrs
       )
       RETURN t,
              [(owner:User)-[:OWNS]->(t) | owner.id][0] AS ownerId`,
      {
        id,
        name,
        repositoryUrl: repositoryUrl ?? null,
        gitProvider: gitProvider ?? null,
        hasAutoMergePrs,
        autoMergePrs: hasAutoMergePrs ? autoMergePrs : false,
      }
    );

    if (result.records.length === 0) return null;

    const tabNode = result.records[0].get("t") as NodeResult;
    const ownerId = result.records[0].get("ownerId") as number | null;
    return mapNodeToTab(tabNode.properties, ownerId);
  });
}

export async function deleteTab(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Tab {id: $id})
       WITH t, t.id AS deletedId
       DETACH DELETE t
       RETURN deletedId`,
      { id }
    );
    return result.records.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Agent ↔ Tab management
// ---------------------------------------------------------------------------

/**
 * Get all tab IDs an agent belongs to.
 */
export async function getAgentTabs(agentId: number): Promise<number[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent {id: $agentId})-[:IN_TAB]->(t:Tab) RETURN t.id AS tabId`,
      { agentId }
    );
    return result.records.map((record) => record.get("tabId") as number);
  });
}

/**
 * Assign an agent to one or more tabs (idempotent — duplicates are ignored).
 */
export async function assignAgentToTabs(
  agentId: number,
  tabIds: number[]
): Promise<void> {
  for (const tabId of tabIds) {
    await writeQuery(async (tx: ManagedTransaction) => {
      // MERGE on the relationship pattern is naturally idempotent — it
      // matches the existing edge if present instead of creating a
      // duplicate, replacing the original's explicit `IF NOT EXISTS` guard.
      await tx.run(
        `MATCH (a:Agent {id: $agentId}), (t:Tab {id: $tabId})
         MERGE (a)-[:IN_TAB]->(t)`,
        { agentId, tabId }
      );
    });
  }
}

/**
 * Remove an agent from a specific tab.
 */
export async function removeAgentFromTab(
  agentId: number,
  tabId: number
): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (a:Agent {id: $agentId})-[r:IN_TAB]->(t:Tab {id: $tabId})
       DELETE r
       RETURN count(r) AS deletedCount`,
      { agentId, tabId }
    );
    return (result.records[0]?.get("deletedCount") as number) > 0;
  });
}

/**
 * Replace all tab assignments for an agent (set exactly to tabIds).
 */
export async function setAgentTabs(
  agentId: number,
  tabIds: number[]
): Promise<void> {
  // Remove all existing IN_TAB edges for this agent.
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (a:Agent {id: $agentId})-[r:IN_TAB]->(:Tab) DELETE r`,
      { agentId }
    );
  });
  // Add fresh edges to each requested tab (same idempotent pattern as
  // assignAgentToTabs — MERGE, not CREATE, so no duplicates even if tabIds
  // has repeats).
  for (const tabId of tabIds) {
    await writeQuery(async (tx: ManagedTransaction) => {
      await tx.run(
        `MATCH (a:Agent {id: $agentId}), (t:Tab {id: $tabId})
         MERGE (a)-[:IN_TAB]->(t)`,
        { agentId, tabId }
      );
    });
  }
}
