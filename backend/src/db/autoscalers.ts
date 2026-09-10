/**
 * Neo4j-backed data access for the `:AutoScaler` node label — auto-scaling
 * session pools that spin up single-claim sessions to match the number of
 * claimable tasks for a chosen agent, up to a concurrency cap.
 *
 * Graph model:
 *   (:User)-[:OWNS]->(:AutoScaler)    ownership
 *   (:AutoScaler)-[:IN_TAB]->(:Tab)   tab assignments (list property mirror)
 *   (:AutoScaler)-[:OWNS_SESSION {lastUsedAt}]->(:Session)   pooled worker sessions
 *
 * Follows the same patterns as db/agents.ts and db/sessions.ts.
 */

import type { ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import { getNextId } from "./id-counter.js";
import type { AutoScaler, CreateAutoScalerInput, AutoScalerStatus } from "../types.js";

/**
 * Map raw Neo4j record data to a AutoScaler object.
 */
function mapToAutoScaler(
  props: Record<string, unknown>,
  tabIds: number[],
  userId: number | null
): AutoScaler {
  return {
    id: props.id as number,
    name: props.name as string,
    userId: userId ?? 0,
    agentName: props.agentName as string,
    tabIds,
    model: (props.model as string) || undefined,
    maxConcurrency: (props.maxConcurrency as number) ?? 5,
    idleTimeoutSeconds: (props.idleTimeoutSeconds as number) ?? 30,
    keepWarmWhileTasksExist: (props.keepWarmWhileTasksExist as boolean) ?? false,
    status: (props.status as AutoScalerStatus) || "stopped",
    createdAt: (props.createdAt as { toString(): string }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new AutoScaler.
 */
export async function createAutoScaler(input: CreateAutoScalerInput): Promise<AutoScaler> {
  const id = await getNextId("AutoScaler");

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `CREATE (f:AutoScaler {
         id: $id, name: $name, agentName: $agentName,
         model: $model, maxConcurrency: $maxConcurrency,
         idleTimeoutSeconds: $idleTimeoutSeconds,
         keepWarmWhileTasksExist: $keepWarmWhileTasksExist,
         status: 'stopped', createdAt: datetime()
       })
       WITH f
       OPTIONAL MATCH (owner:User {id: $userId})
       FOREACH (_ IN CASE WHEN owner IS NOT NULL THEN [1] ELSE [] END | MERGE (owner)-[:OWNS]->(f))
       WITH f
       UNWIND $tabIds AS tid
       MATCH (t:Tab {id: tid})
       MERGE (f)-[:IN_TAB]->(t)
       WITH f, collect(t.id) AS tabs
       OPTIONAL MATCH (owner2:User)-[:OWNS]->(f)
       RETURN f{.*} AS autoScaler, tabs, owner2.id AS userId`,
      {
        id,
        name: input.name,
        agentName: input.agentName,
        model: input.model ?? null,
        maxConcurrency: input.maxConcurrency ?? 5,
        idleTimeoutSeconds: input.idleTimeoutSeconds ?? 30,
        keepWarmWhileTasksExist: input.keepWarmWhileTasksExist ?? false,
        userId: input.userId,
        tabIds: input.tabIds,
      }
    );

    // If no tabIds were provided, the UNWIND produces no rows, so handle
    // the empty-tabs case with a fallback query.
    if (result.records.length === 0) {
      const fallback = await tx.run(
        `MATCH (f:AutoScaler {id: $id})
         OPTIONAL MATCH (f)-[:IN_TAB]->(t:Tab)
         WITH f, collect(t.id) AS tabs
         OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
         RETURN f{.*} AS autoScaler, tabs, owner.id AS userId`,
        { id }
      );
      const record = fallback.records[0];
      return mapToAutoScaler(record.get("autoScaler"), record.get("tabs"), record.get("userId"));
    }

    const record = result.records[0];
    return mapToAutoScaler(record.get("autoScaler"), record.get("tabs"), record.get("userId"));
  });
}

/**
 * Get a AutoScaler by numeric ID.
 */
export async function getAutoScalerById(id: number): Promise<AutoScaler | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (f:AutoScaler {id: $id})
       OPTIONAL MATCH (f)-[:IN_TAB]->(t:Tab)
       WITH f, collect(t.id) AS tabIds
       OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
       RETURN f{.*} AS autoScaler, tabIds, owner.id AS userId`,
      { id }
    );
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return mapToAutoScaler(record.get("autoScaler"), record.get("tabIds"), record.get("userId"));
  });
}

/**
 * Get all AutoScalers for a given user.
 */
export async function getAllAutoScalers(userId: number): Promise<AutoScaler[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $userId})-[:OWNS]->(f:AutoScaler)
       OPTIONAL MATCH (f)-[:IN_TAB]->(t:Tab)
       WITH f, collect(t.id) AS tabIds
       OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
       RETURN f{.*} AS autoScaler, tabIds, owner.id AS userId
       ORDER BY f.createdAt DESC`,
      { userId }
    );
    return result.records.map((record) =>
      mapToAutoScaler(record.get("autoScaler"), record.get("tabIds"), record.get("userId"))
    );
  });
}

/**
 * Get every AutoScaler persisted with status "running", across all users.
 * Used by autoscaler-manager.ts's initAutoScalers() on server boot to resume
 * autoscalers that were running before the restart — mirrors
 * db/sessions.ts's getRunningSessionsFromDb().
 */
export async function getRunningAutoScalers(): Promise<AutoScaler[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (f:AutoScaler {status: 'running'})
       OPTIONAL MATCH (f)-[:IN_TAB]->(t:Tab)
       WITH f, collect(t.id) AS tabIds
       OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
       RETURN f{.*} AS autoScaler, tabIds, owner.id AS userId`
    );
    return result.records.map((record) =>
      mapToAutoScaler(record.get("autoScaler"), record.get("tabIds"), record.get("userId"))
    );
  });
}

/**
 * Update a AutoScaler's status.
 */
export async function updateAutoScalerStatus(id: number, status: AutoScalerStatus): Promise<AutoScaler | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (f:AutoScaler {id: $id})
       SET f.status = $status
       WITH f
       OPTIONAL MATCH (f)-[:IN_TAB]->(t:Tab)
       WITH f, collect(t.id) AS tabIds
       OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
       RETURN f{.*} AS autoScaler, tabIds, owner.id AS userId`,
      { id, status }
    );
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return mapToAutoScaler(record.get("autoScaler"), record.get("tabIds"), record.get("userId"));
  });
}

/**
 * Update an AutoScaler's editable fields and/or tab assignments.
 * Only the provided fields are SET; status is never changed here.
 */
export async function updateAutoScaler(
  id: number,
  fields: Partial<{
    name: string;
    agentName: string;
    tabIds: number[];
    model: string | null;
    maxConcurrency: number;
    idleTimeoutSeconds: number;
  }>
): Promise<AutoScaler | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    // Build a SET clause for scalar fields only (skip tabIds — handled separately).
    const scalarFields: Record<string, unknown> = {};
    if (fields.name !== undefined) scalarFields.name = fields.name;
    if (fields.agentName !== undefined) scalarFields.agentName = fields.agentName;
    if (fields.model !== undefined) scalarFields.model = fields.model;
    if (fields.maxConcurrency !== undefined) scalarFields.maxConcurrency = fields.maxConcurrency;
    if (fields.idleTimeoutSeconds !== undefined) scalarFields.idleTimeoutSeconds = fields.idleTimeoutSeconds;

    // Build SET assignments string for non-tabIds fields.
    const setEntries = Object.keys(scalarFields).map((k) => `f.${k} = $${k}`);

    let query: string;
    const params: Record<string, unknown> = { id, ...scalarFields };

    if (fields.tabIds !== undefined) {
      // Re-sync IN_TAB relationships: delete existing, MERGE new ones.
      // We MATCH (not OPTIONAL MATCH) for tab lookup so that we can detect
      // whether any provided IDs are valid. If none resolve to real Tab nodes,
      // we return null rather than silently deleting all tab assignments.
      //
      // Cardinality note: after UNWIND + FOREACH we have N rows (one per tid).
      // Adding WITH DISTINCT f collapses that back to 1 row before the final
      // OPTIONAL MATCH, preventing N×M row explosion in collect().
      params.tabIds = fields.tabIds;
      const setClause = setEntries.length > 0 ? `SET ${setEntries.join(", ")}` : "";
      query = `
        MATCH (f:AutoScaler {id: $id})
        ${setClause}
        WITH f
        OPTIONAL MATCH (f)-[r:IN_TAB]->(:Tab)
        DELETE r
        WITH f
        UNWIND $tabIds AS tid
        OPTIONAL MATCH (t:Tab {id: tid})
        FOREACH (_ IN CASE WHEN t IS NOT NULL THEN [1] ELSE [] END | MERGE (f)-[:IN_TAB]->(t))
        WITH DISTINCT f
        OPTIONAL MATCH (f)-[:IN_TAB]->(linked:Tab)
        WITH f, collect(linked.id) AS tabIds
        OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
        RETURN f{.*} AS autoScaler, tabIds, owner.id AS userId
      `;
    } else {
      // No tab changes — just update scalar fields.
      const setClause = setEntries.length > 0 ? `SET ${setEntries.join(", ")}` : "";
      query = `
        MATCH (f:AutoScaler {id: $id})
        ${setClause}
        WITH f
        OPTIONAL MATCH (f)-[:IN_TAB]->(t:Tab)
        WITH f, collect(t.id) AS tabIds
        OPTIONAL MATCH (owner:User)-[:OWNS]->(f)
        RETURN f{.*} AS autoScaler, tabIds, owner.id AS userId
      `;
    }

    const result = await tx.run(query, params);
    if (result.records.length === 0) return null;
    const record = result.records[0];

    // Guard against silent data loss: if the caller requested a tabIds re-sync
    // but every provided ID was non-existent, collect() returns [] — meaning
    // all previous tab assignments were deleted and none were replaced.
    // Return null so the route can surface a 404/422 rather than responding 200
    // with an auto-scaler that has no tabs.
    const resultTabIds: number[] = record.get("tabIds");
    if (fields.tabIds !== undefined && fields.tabIds.length > 0 && resultTabIds.length === 0) {
      return null;
    }

    return mapToAutoScaler(record.get("autoScaler"), resultTabIds, record.get("userId"));
  });
}

/**
 * Delete a AutoScaler by numeric ID.
 */
export async function deleteAutoScaler(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (f:AutoScaler {id: $id})
       DETACH DELETE f
       RETURN count(f) AS deletedCount`,
      { id }
    );
    return result.records[0].get("deletedCount") > 0;
  });
}

// ---------------------------------------------------------------------------
// Pooled session ownership — (:AutoScaler)-[:OWNS_SESSION]->(:Session)
// ---------------------------------------------------------------------------
//
// Durable link between an AutoScaler and the worker sessions it owns, so the
// pool survives a server restart (see autoscaler-manager.ts's ManagedAutoScaler
// .sessionIds, which is otherwise in-memory only). The edge carries a
// `lastUsedAt` datetime property, updated via touchPooledSession — this is
// foundation for a later reuse-based scaling model and is not read/acted on
// by any scaling logic in this task.

/**
 * Link a session as owned/pooled by an AutoScaler. Idempotent (MERGE).
 * Sets lastUsedAt = datetime() on creation.
 */
export async function linkPooledSession(autoScalerId: number, sessionId: number): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (f:AutoScaler {id: $autoScalerId})
       MATCH (s:Session {id: $sessionId})
       MERGE (f)-[r:OWNS_SESSION]->(s)
       ON CREATE SET r.lastUsedAt = datetime()`,
      { autoScalerId, sessionId }
    );
  });
}

/**
 * Remove the OWNS_SESSION edge between an AutoScaler and a session.
 * (DETACH DELETE of the session also removes this edge — this helper is for
 * unlinking a session that is being returned to the pool or removed from
 * ownership without deleting the underlying Session node.)
 */
export async function unlinkPooledSession(autoScalerId: number, sessionId: number): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (f:AutoScaler {id: $autoScalerId})-[r:OWNS_SESSION]->(s:Session {id: $sessionId})
       DELETE r`,
      { autoScalerId, sessionId }
    );
  });
}

/**
 * Update the lastUsedAt timestamp on an existing OWNS_SESSION edge.
 * No-op if the edge does not exist.
 */
export async function touchPooledSession(autoScalerId: number, sessionId: number): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (f:AutoScaler {id: $autoScalerId})-[r:OWNS_SESSION]->(s:Session {id: $sessionId})
       SET r.lastUsedAt = datetime()`,
      { autoScalerId, sessionId }
    );
  });
}

/**
 * Get the IDs of all sessions currently pooled/owned by an AutoScaler.
 */
export async function getPooledSessionIds(autoScalerId: number): Promise<number[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (f:AutoScaler {id: $autoScalerId})-[:OWNS_SESSION]->(s:Session)
       RETURN s.id AS sessionId`,
      { autoScalerId }
    );
    return result.records.map((record) => record.get("sessionId") as number);
  });
}

/**
 * Get the IDs of every session pooled/owned by ANY AutoScaler (not scoped to
 * one). Used by session-manager.ts's initSessions() on server boot to exempt
 * pooled sessions from the generic auto-restart path — at that point in
 * startup, autoscalers haven't been resumed yet, so there is no single
 * autoScalerId to scope the query to.
 */
export async function getAllPooledSessionIds(): Promise<number[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (:AutoScaler)-[:OWNS_SESSION]->(s:Session)
       RETURN DISTINCT s.id AS sessionId`
    );
    return result.records.map((record) => record.get("sessionId") as number);
  });
}

/**
 * Get the pooled session IDs for an AutoScaler along with each edge's
 * lastUsedAt property (ISO string), for the reuse-based scaling model
 * added in a follow-up task.
 */
export async function getPooledSessionsWithLastUsed(
  autoScalerId: number
): Promise<Array<{ sessionId: number; lastUsedAt: string }>> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (f:AutoScaler {id: $autoScalerId})-[r:OWNS_SESSION]->(s:Session)
       RETURN s.id AS sessionId, r.lastUsedAt AS lastUsedAt`,
      { autoScalerId }
    );
    return result.records.map((record) => ({
      sessionId: record.get("sessionId") as number,
      lastUsedAt: (record.get("lastUsedAt") as { toString(): string }).toString(),
    }));
  });
}
