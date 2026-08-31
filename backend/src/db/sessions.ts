/**
 * Sessions DB — Persists session metadata in Neo4j (AuraDB).
 *
 * Replaces the mssql-backed implementation. Sessions are scoped per user via
 * an (:User)-[:OWNS]->(:Session) relationship (0 or 1 owner in the graph,
 * though the `Session.userId` field itself is REQUIRED on the TS type —
 * every session created here gets an OWNS edge, see insertSession below).
 * Output buffers remain in-memory (too large/ephemeral for DB storage) —
 * `output` is always `[]` on the returned object, matching the original
 * mssql-backed mapRowToSession.
 *
 * Graph model (see .kiro/specs/neo4j-migration/design.md):
 *   (:Session) scalar properties: id, name, agent (plain string — NOT a
 *     relationship, deliberate exception), status, prompt, interactive,
 *     loop, runs, intervalSeconds, cwd, timeoutSeconds, model,
 *     activityType/activityDetail (flattened from `currentActivity`),
 *     currentTaskId (plain scalar — NOT a relationship, deliberate
 *     exception, mirrors `agent`), pinned, isPermanent, sortOrder,
 *     forceLocal, createdAt, startedAt.
 *   (:User)-[:OWNS]->(:Session)
 *   (:Session)-[:IN_TAB]->(:Tab)                                   0+
 *   (:Session)-[:HAS_MCP_CONFIG_OVERRIDE]->(:McpConfig)            0 or 1
 *   (:Session)-[:HAS_MCP_SERVER {position}]->(:McpServerConfig)    0+, ordered
 *   (:Session)-[:HAS_RAW_MCP_SERVER {position}]->(:RawMcpServerConfig)  0+, ordered
 *
 * A few Cypher/driver behaviors this file relies on, confirmed empirically
 * against the live AuraDB instance while writing it (not assumed from docs):
 *   - Creating/setting a property to a `null`-valued parameter simply omits
 *     that property from the node entirely (Neo4j has no concept of a
 *     "null property" — non-existence and null are the same thing). This
 *     is what lets optional scalars (model, startedAt, activityType, ...)
 *     be written with a single unconditional CREATE/SET map rather than
 *     conditional Cypher branches.
 *   - `datetime($isoStringOrNull)` propagates null through (returns null
 *     rather than erroring), so the same unconditional-map trick works for
 *     the two datetime properties.
 *   - `OPTIONAL MATCH` binds a variable to null (not "no row") when nothing
 *     matches — so `collect()` of an expression built from that variable
 *     does NOT automatically skip it as an empty list unless the collected
 *     expression itself evaluates to null. Every ordered-list read below
 *     therefore uses `collect(CASE WHEN x IS NOT NULL THEN {...} END)`
 *     followed by a `[v IN list WHERE v IS NOT NULL]` filter, rather than
 *     collecting the map literal directly.
 *   - `CALL (s) { ... }` scoped subqueries preserve the row order
 *     established by a preceding `WITH s ORDER BY ...` — confirmed so the
 *     pinned/sortOrder ordering from the original SQL `ORDER BY` survives
 *     resolving the sub-relationships afterward.
 *   - `DETACH DELETE` tolerates being given the same node multiple times
 *     (e.g. via a cross product from several `OPTIONAL MATCH` clauses) and
 *     tolerates null operands from an `OPTIONAL MATCH` that found nothing —
 *     both are safe no-ops, which is what makes the single-statement
 *     multi-`OPTIONAL MATCH` + `DETACH DELETE` shape in deleteSessionFromDb
 *     correct without needing per-relationship-type separate deletes.
 *   - IMPORTANT ROW-MULTIPLICATION PITFALL (caught by a live smoke test,
 *     not by `tsc` — this is exactly the kind of bug a clean TypeScript
 *     build can't catch): `OPTIONAL MATCH (s)-[:REL]->(old:Label)` produces
 *     one row PER MATCHED RELATIONSHIP, not one row per input `s`. If `s`
 *     previously had, say, 2 `HAS_MCP_SERVER` relationships, that
 *     `OPTIONAL MATCH` alone turns 1 incoming row into 2 rows, both still
 *     bound to the same `s`. Chaining several such cleanup blocks
 *     back-to-back without collapsing in between multiplies rows across
 *     blocks (2 old mcpServers x 1 old rawMcpServer x ... ), and since a
 *     trailing `CALL (s) { ... CREATE ... }` unit subquery runs once per
 *     *incoming* row, that multiplication directly duplicates every newly
 *     created node. `updateSessionMeta` therefore does `WITH DISTINCT s`
 *     (not plain `WITH s`) after every `OPTIONAL MATCH ... DELETE`/
 *     `DETACH DELETE` cleanup block, collapsing back to exactly one row
 *     bound to the same session node before the next cleanup step or the
 *     final recreate `CALL` blocks run.
 */

import type { ManagedTransaction, Record as Neo4jRecord } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import { getNextId } from "./id-counter.js";
import type { Session, McpServerConfig, Activity, TabMcpConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Shared Cypher fragments
// ---------------------------------------------------------------------------

/**
 * Resolves every sub-relationship for an already-bound `s` (Session) and
 * returns one row per session: `props` (flat scalar properties), `ownerId`,
 * `tabIds`, `mcpConfigOverride`, `mcpServersRaw`, `rawMcpServersJson`.
 *
 * Callers must bind `s` first (and apply any ORDER BY before this fragment —
 * row order survives through these CALL subqueries, confirmed empirically).
 */
const RESOLVE_SESSION_RELATIONSHIPS = `
  OPTIONAL MATCH (owner:User)-[:OWNS]->(s)
  CALL (s) {
    OPTIONAL MATCH (s)-[:IN_TAB]->(tab:Tab)
    RETURN collect(tab.id) AS tabIds
  }
  CALL (s) {
    OPTIONAL MATCH (s)-[:HAS_MCP_CONFIG_OVERRIDE]->(cfg:McpConfig)
    RETURN cfg {.*} AS mcpConfigOverride
  }
  CALL (s) {
    OPTIONAL MATCH (s)-[hms:HAS_MCP_SERVER]->(mcp:McpServerConfig)
    WITH hms, mcp ORDER BY hms.position ASC
    WITH collect(CASE WHEN mcp IS NOT NULL THEN mcp {.*} END) AS raw
    RETURN [x IN raw WHERE x IS NOT NULL] AS mcpServersRaw
  }
  CALL (s) {
    OPTIONAL MATCH (s)-[hrms:HAS_RAW_MCP_SERVER]->(raw:RawMcpServerConfig)
    WITH hrms, raw ORDER BY hrms.position ASC
    WITH collect(CASE WHEN raw IS NOT NULL THEN raw.json END) AS rawList
    RETURN [x IN rawList WHERE x IS NOT NULL] AS rawMcpServersJson
  }
  RETURN s {.*} AS props, owner.id AS ownerId, tabIds, mcpConfigOverride, mcpServersRaw, rawMcpServersJson
`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface McpServerRawRow {
  name: string;
  command: string;
  args: string[];
  envNames: string[];
  envValues: string[];
}

/** Zips parallel envNames/envValues lists back into `Array<{name, value}>`. */
function zipEnv(names: string[], values: string[]): Array<{ name: string; value: string }> {
  return names.map((name, i) => ({ name, value: values[i] }));
}

/** Unzips `Array<{name, value}>` into parallel envNames/envValues lists. */
function unzipEnv(env: Array<{ name: string; value: string }>): { envNames: string[]; envValues: string[] } {
  return {
    envNames: env.map((e) => e.name),
    envValues: env.map((e) => e.value),
  };
}

/**
 * Maps one row produced by RESOLVE_SESSION_RELATIONSHIPS to a Session object.
 */
function mapRecordToSession(record: Neo4jRecord): Session {
  const props = record.get("props") as Record<string, unknown>;
  const ownerId = record.get("ownerId") as number | null;
  const tabIdsRaw = (record.get("tabIds") as number[]) ?? [];
  const mcpConfigOverrideRaw = record.get("mcpConfigOverride") as TabMcpConfig | null;
  const mcpServersRaw = (record.get("mcpServersRaw") as McpServerRawRow[]) ?? [];
  const rawMcpServersJson = (record.get("rawMcpServersJson") as string[]) ?? [];

  const mcpServers: McpServerConfig[] | undefined =
    mcpServersRaw.length > 0
      ? mcpServersRaw.map((m) => ({
          name: m.name,
          command: m.command,
          args: m.args ?? [],
          env: zipEnv(m.envNames ?? [], m.envValues ?? []),
        }))
      : undefined;

  const rawMcpServers: unknown[] | undefined =
    rawMcpServersJson.length > 0 ? rawMcpServersJson.map((j) => JSON.parse(j)) : undefined;

  let currentActivity: Activity | undefined;
  const activityType = props.activityType as Activity["type"] | undefined;
  if (activityType) {
    currentActivity = {
      type: activityType,
      detail: (props.activityDetail as string) || undefined,
    };
  }

  return {
    id: props.id as number,
    name: props.name as string,
    agent: props.agent as string,
    status: props.status as Session["status"],
    prompt: props.prompt as string,
    interactive: props.interactive as boolean,
    loop: props.loop as boolean,
    runs: props.runs as number,
    intervalSeconds: props.intervalSeconds as number,
    cwd: props.cwd as string,
    timeoutSeconds: props.timeoutSeconds as number,
    model: (props.model as string) || undefined,
    mcpServers,
    mcpConfigOverride: mcpConfigOverrideRaw ?? undefined,
    rawMcpServers,
    excludedMcpServerNames:
      (props.excludedMcpServerNames as string[] | undefined)?.length
        ? (props.excludedMcpServerNames as string[])
        : undefined,
    tabIds: tabIdsRaw.length > 0 ? tabIdsRaw : undefined,
    userId: (ownerId ?? 0) as number,
    createdAt: (props.createdAt as { toString(): string }).toString(),
    startedAt: props.startedAt ? (props.startedAt as { toString(): string }).toString() : undefined,
    currentTaskId: (props.currentTaskId as number) || undefined,
    currentTaskTitle: (props.currentTaskTitle as string) || undefined,
    currentActivity,
    pinned: !!props.pinned,
    isPermanent: !!props.isPermanent,
    sortOrder: (props.sortOrder as number) ?? 0,
    forceLocal: !!props.forceLocal,
    output: [], // Output is in-memory only — never persisted, matches the original.
  };
}

/** Builds the ordered `$mcpServers` UNWIND param from a Session's mcpServers array. */
function buildMcpServerParams(mcpServers: McpServerConfig[] | undefined) {
  return (mcpServers ?? []).map((m, i) => {
    const { envNames, envValues } = unzipEnv(m.env ?? []);
    return {
      position: i,
      name: m.name,
      command: m.command,
      args: m.args ?? [],
      envNames,
      envValues,
    };
  });
}

/** Builds the ordered `$rawMcpServers` UNWIND param — each entry JSON.stringify'd (opaque, no fixed shape). */
function buildRawMcpServerParams(rawMcpServers: unknown[] | undefined) {
  return (rawMcpServers ?? []).map((entry, i) => ({ position: i, json: JSON.stringify(entry) }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get all sessions for a given user. Returns session metadata without output buffers.
 */
export async function getAllSessionsFromDb(userId?: number): Promise<Session[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const matchClause = userId
      ? `MATCH (u:User {id: $userId})-[:OWNS]->(s:Session)`
      : `MATCH (s:Session)`;
    const result = await tx.run(
      `
        ${matchClause}
        WITH s ORDER BY s.pinned DESC, s.sortOrder ASC
        ${RESOLVE_SESSION_RELATIONSHIPS}
      `,
      { userId: userId ?? null }
    );
    return result.records.map(mapRecordToSession);
  });
}

/**
 * Get a single session by ID.
 */
export async function getSessionFromDb(id: number): Promise<Session | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `
        MATCH (s:Session {id: $id})
        ${RESOLVE_SESSION_RELATIONSHIPS}
      `,
      { id }
    );
    if (result.records.length === 0) return null;
    return mapRecordToSession(result.records[0]);
  });
}

/**
 * Get all sessions that were running when the server last shut down.
 * Used for auto-restart logic on server boot.
 */
export async function getRunningSessionsFromDb(): Promise<Session[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`
      MATCH (s:Session {status: 'running'})
      ${RESOLVE_SESSION_RELATIONSHIPS}
    `);
    return result.records.map(mapRecordToSession);
  });
}

/**
 * Insert a new session into the database.
 * Returns the auto-generated numeric id.
 *
 * `session.userId` is required on the Session type and every session must
 * get an OWNS edge (see design.md's exception note — unlike Tab/Agent,
 * Session ownership is not optional here). The owner MATCH below is
 * therefore a strict (non-OPTIONAL) match: if no User with that id exists,
 * the whole CREATE never runs and zero rows come back, mirroring the
 * original schema's `user_id INT NULL REFERENCES users(id)` FK constraint
 * (an insert referencing a nonexistent user would fail there too, rather
 * than silently creating an ownerless row).
 */
export async function insertSession(session: Session): Promise<number> {
  const id = await getNextId("Session");

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `
        MATCH (owner:User {id: $userId})
        CREATE (s:Session {
          id: $id, name: $name, agent: $agent, status: $status, prompt: $prompt,
          interactive: $interactive, loop: $loop, runs: $runs, intervalSeconds: $intervalSeconds,
          cwd: $cwd, timeoutSeconds: $timeoutSeconds, model: $model,
          activityType: $activityType, activityDetail: $activityDetail, currentTaskId: $currentTaskId,
          currentTaskTitle: $currentTaskTitle,
          pinned: $pinned, isPermanent: $isPermanent, sortOrder: $sortOrder, forceLocal: $forceLocal,
          excludedMcpServerNames: $excludedMcpServerNames,
          createdAt: datetime($createdAt), startedAt: datetime($startedAt)
        })
        CREATE (owner)-[:OWNS]->(s)
        WITH s
        FOREACH (ignoreMe IN CASE WHEN $mcpConfigOverride IS NOT NULL THEN [1] ELSE [] END |
          CREATE (s)-[:HAS_MCP_CONFIG_OVERRIDE]->(:McpConfig {
            atlassian: $mcpConfigOverride.atlassian, azureDevops: $mcpConfigOverride.azureDevops,
            awsApi: $mcpConfigOverride.awsApi, awsDocs: $mcpConfigOverride.awsDocs
          })
        )
        WITH s
        CALL (s) {
          UNWIND $tabIds AS tabId
          MATCH (tab:Tab {id: tabId})
          CREATE (s)-[:IN_TAB]->(tab)
        }
        WITH s
        CALL (s) {
          UNWIND $mcpServers AS entry
          CREATE (s)-[:HAS_MCP_SERVER {position: entry.position}]->(:McpServerConfig {
            name: entry.name, command: entry.command, args: entry.args,
            envNames: entry.envNames, envValues: entry.envValues
          })
        }
        WITH s
        CALL (s) {
          UNWIND $rawMcpServers AS entry
          CREATE (s)-[:HAS_RAW_MCP_SERVER {position: entry.position}]->(:RawMcpServerConfig {json: entry.json})
        }
        RETURN s.id AS id
      `,
      {
        id,
        name: session.name,
        agent: session.agent || "",
        status: session.status,
        prompt: session.prompt,
        interactive: session.interactive,
        loop: session.loop,
        runs: session.runs,
        intervalSeconds: session.intervalSeconds,
        cwd: session.cwd,
        timeoutSeconds: session.timeoutSeconds,
        model: session.model ?? null,
        activityType: session.currentActivity?.type ?? null,
        activityDetail: session.currentActivity?.detail ?? null,
        currentTaskId: session.currentTaskId ?? null,
        currentTaskTitle: session.currentTaskTitle ?? null,
        pinned: session.pinned ? true : false,
        isPermanent: session.isPermanent ? true : false,
        sortOrder: session.sortOrder ?? 0,
        forceLocal: session.forceLocal ? true : false,
        excludedMcpServerNames: session.excludedMcpServerNames?.length ? session.excludedMcpServerNames : [],
        createdAt: session.createdAt,
        startedAt: session.startedAt ?? null,
        userId: session.userId,
        tabIds: session.tabIds ?? [],
        mcpConfigOverride: session.mcpConfigOverride ?? null,
        mcpServers: buildMcpServerParams(session.mcpServers),
        rawMcpServers: buildRawMcpServerParams(session.rawMcpServers),
      }
    );

    if (result.records.length === 0) {
      throw new Error(
        `insertSession: no User found with id ${session.userId} — cannot create an owned session`
      );
    }
    return result.records[0].get("id") as number;
  });
}

/**
 * Update session status, started_at, current_task_id, and current_activity.
 * This is called frequently during session lifecycle changes.
 *
 * `status` is always set. `startedAt`/`currentTaskId`/`activityType`/
 * `activityDetail` are written unconditionally from the (possibly-undefined,
 * coalesced-to-null) arguments — matching the original's "set to NULL to
 * clear" semantics. Setting a Neo4j property to a null-valued parameter is
 * documented as exactly equivalent to REMOVE (confirmed empirically too:
 * `SET s.prop = $x` with `x: null` leaves the property genuinely absent,
 * not present-with-value-null), so this is a plain unconditional SET rather
 * than conditionally choosing between SET and REMOVE per field.
 */
export async function updateSessionStatus(
  id: number,
  status: Session["status"],
  startedAt?: string,
  currentTaskId?: number,
  currentActivity?: Activity
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `
        MATCH (s:Session {id: $id})
        SET s.status = $status,
            s.startedAt = datetime($startedAt),
            s.currentTaskId = $currentTaskId,
            s.activityType = $activityType,
            s.activityDetail = $activityDetail
      `,
      {
        id,
        status,
        startedAt: startedAt ?? null,
        currentTaskId: currentTaskId ?? null,
        activityType: currentActivity?.type ?? null,
        activityDetail: currentActivity?.detail ?? null,
      }
    );
  });
}

/**
 * Update session metadata fields (name, agent, prompt, cwd, etc.).
 * Used when session config is modified.
 *
 * This is a full replace-everything update, matching the original SQL
 * UPDATE's "set every column to the new session object's current value"
 * semantics: every scalar property is rewritten, and every relationship set
 * (IN_TAB, HAS_MCP_CONFIG_OVERRIDE, HAS_MCP_SERVER, HAS_RAW_MCP_SERVER) is
 * torn down and recreated from the incoming session object. Tab nodes
 * themselves are shared (not owned by the session) so only the IN_TAB
 * relationship is deleted, never the Tab node; the McpConfig/McpServerConfig/
 * RawMcpServerConfig sub-nodes ARE exclusively owned by the session, so
 * those are DETACH DELETEd outright before being recreated.
 */
export async function updateSessionMeta(session: Session): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `
        MATCH (s:Session {id: $id})
        SET s.name = $name, s.agent = $agent, s.status = $status, s.prompt = $prompt,
            s.interactive = $interactive, s.loop = $loop, s.runs = $runs, s.intervalSeconds = $intervalSeconds,
            s.cwd = $cwd, s.timeoutSeconds = $timeoutSeconds, s.model = $model,
            s.activityType = $activityType, s.activityDetail = $activityDetail, s.currentTaskId = $currentTaskId,
            s.currentTaskTitle = $currentTaskTitle,
            s.pinned = $pinned, s.sortOrder = $sortOrder, s.forceLocal = $forceLocal,
            s.excludedMcpServerNames = $excludedMcpServerNames,
            s.startedAt = datetime($startedAt)
        WITH s
        OPTIONAL MATCH (s)-[oldTabRel:IN_TAB]->(:Tab)
        DELETE oldTabRel
        WITH DISTINCT s
        OPTIONAL MATCH (s)-[:HAS_MCP_CONFIG_OVERRIDE]->(oldCfg:McpConfig)
        DETACH DELETE oldCfg
        WITH DISTINCT s
        OPTIONAL MATCH (s)-[:HAS_MCP_SERVER]->(oldMcp:McpServerConfig)
        DETACH DELETE oldMcp
        WITH DISTINCT s
        OPTIONAL MATCH (s)-[:HAS_RAW_MCP_SERVER]->(oldRaw:RawMcpServerConfig)
        DETACH DELETE oldRaw
        WITH DISTINCT s
        FOREACH (ignoreMe IN CASE WHEN $mcpConfigOverride IS NOT NULL THEN [1] ELSE [] END |
          CREATE (s)-[:HAS_MCP_CONFIG_OVERRIDE]->(:McpConfig {
            atlassian: $mcpConfigOverride.atlassian, azureDevops: $mcpConfigOverride.azureDevops,
            awsApi: $mcpConfigOverride.awsApi, awsDocs: $mcpConfigOverride.awsDocs
          })
        )
        WITH s
        CALL (s) {
          UNWIND $tabIds AS tabId
          MATCH (tab:Tab {id: tabId})
          CREATE (s)-[:IN_TAB]->(tab)
        }
        WITH s
        CALL (s) {
          UNWIND $mcpServers AS entry
          CREATE (s)-[:HAS_MCP_SERVER {position: entry.position}]->(:McpServerConfig {
            name: entry.name, command: entry.command, args: entry.args,
            envNames: entry.envNames, envValues: entry.envValues
          })
        }
        WITH s
        CALL (s) {
          UNWIND $rawMcpServers AS entry
          CREATE (s)-[:HAS_RAW_MCP_SERVER {position: entry.position}]->(:RawMcpServerConfig {json: entry.json})
        }
      `,
      {
        id: session.id,
        name: session.name,
        agent: session.agent || "",
        status: session.status,
        prompt: session.prompt,
        interactive: session.interactive,
        loop: session.loop,
        runs: session.runs,
        intervalSeconds: session.intervalSeconds,
        cwd: session.cwd,
        timeoutSeconds: session.timeoutSeconds,
        model: session.model ?? null,
        activityType: session.currentActivity?.type ?? null,
        activityDetail: session.currentActivity?.detail ?? null,
        currentTaskId: session.currentTaskId ?? null,
        currentTaskTitle: session.currentTaskTitle ?? null,
        pinned: session.pinned ? true : false,
        sortOrder: session.sortOrder ?? 0,
        forceLocal: session.forceLocal ? true : false,
        excludedMcpServerNames: session.excludedMcpServerNames?.length ? session.excludedMcpServerNames : [],
        startedAt: session.startedAt ?? null,
        tabIds: session.tabIds ?? [],
        mcpConfigOverride: session.mcpConfigOverride ?? null,
        mcpServers: buildMcpServerParams(session.mcpServers),
        rawMcpServers: buildRawMcpServerParams(session.rawMcpServers),
      }
    );
  });
}

/**
 * Delete a session from the database.
 * Also deletes every sub-node exclusively owned by the session (McpConfig
 * override, McpServerConfig/RawMcpServerConfig entries) so nothing is left
 * orphaned. Tab/User nodes are never touched — DETACH DELETE only removes
 * the relationships incident to the deleted nodes, not the nodes on the
 * other end.
 */
export async function deleteSessionFromDb(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `
        MATCH (s:Session {id: $id})
        OPTIONAL MATCH (s)-[:HAS_MCP_CONFIG_OVERRIDE]->(cfg:McpConfig)
        OPTIONAL MATCH (s)-[:HAS_MCP_SERVER]->(mcp:McpServerConfig)
        OPTIONAL MATCH (s)-[:HAS_RAW_MCP_SERVER]->(raw:RawMcpServerConfig)
        DETACH DELETE s, cfg, mcp, raw
        RETURN count(DISTINCT s) AS deletedCount
      `,
      { id }
    );
    return (result.records[0]?.get("deletedCount") as number) > 0;
  });
}

/**
 * Check if a session belongs to a specific user.
 */
export async function isSessionOwnedByUser(sessionId: number, userId: number): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $userId})-[:OWNS]->(s:Session {id: $sessionId}) RETURN s`,
      { sessionId, userId }
    );
    return result.records.length > 0;
  });
}

/**
 * Bulk-update sort_order for a list of session IDs.
 * The array position determines the sort_order value.
 *
 * The original wraps this in an explicit mssql transaction for an
 * all-or-nothing guarantee. A single UNWIND-based write here runs as one
 * managed transaction already — atomic by construction, no manual rollback
 * needed. Only sessions actually owned by `userId` are updated (mirrors the
 * original's `WHERE ... AND user_id = @userId` guard); a sessionId in the
 * list that isn't owned by this user is silently skipped, not an error.
 */
export async function reorderSessionsInDb(sessionIds: number[], userId: number): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `
        UNWIND $updates AS u
        MATCH (owner:User {id: $userId})-[:OWNS]->(s:Session {id: u.id})
        SET s.sortOrder = u.order
      `,
      {
        updates: sessionIds.map((id, i) => ({ id, order: i })),
        userId,
      }
    );
  });
}

/**
 * Update the pinned state and sort_order of a session.
 */
export async function updateSessionPinInDb(
  sessionId: number,
  pinned: boolean,
  sortOrder: number
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (s:Session {id: $sessionId}) SET s.pinned = $pinned, s.sortOrder = $sortOrder`,
      { sessionId, pinned, sortOrder }
    );
  });
}
