/**
 * Schema bootstrap for Neo4j — replaces the 26-step incremental Azure SQL
 * `ALTER TABLE`-based migration runner.
 *
 * Neo4j is schema-optional: a node can start having a new property with no
 * DDL step required. There is no "add a column," "widen a column," or
 * "rename a table" operation to run — the only schema objects that exist at
 * all are constraints and indexes, and creating them is naturally idempotent
 * (`IF NOT EXISTS`) rather than something that needs 26 sequential,
 * version-gated upgrade steps. This file's job is just to make sure those
 * constraints/indexes exist; it is safe to run on every startup.
 *
 * See .kiro/specs/neo4j-migration/design.md, "Schema bootstrap" section, for
 * the full rationale and the constraint list this implements.
 */

import { isDbAvailable, tryConnect, runSchemaStatement, writeQuery } from "./connection.js";
import { insertSession } from "./sessions.js";
import type { Session } from "../types.js";

/**
 * Every constraint/index this app depends on existing. Statements are plain
 * strings (not parameterized — Cypher's CREATE CONSTRAINT/INDEX syntax does
 * not accept query parameters for the schema name/label/property position)
 * run one at a time via runSchemaStatement, which has its own retry for the
 * transient schema-lock contention observed when issuing several of these
 * back-to-back against the same AuraDB instance.
 */
const SCHEMA_STATEMENTS: string[] = [
  // ── Node key constraints (unique + required) — the ID counter in
  // db/id-counter.ts is what actually allocates these values; the constraint
  // just enforces the invariant it's designed to uphold. ──
  "CREATE CONSTRAINT user_id_key IF NOT EXISTS FOR (u:User) REQUIRE u.id IS NODE KEY",
  "CREATE CONSTRAINT tab_id_key IF NOT EXISTS FOR (t:Tab) REQUIRE t.id IS NODE KEY",
  "CREATE CONSTRAINT task_id_key IF NOT EXISTS FOR (t:Task) REQUIRE t.id IS NODE KEY",
  "CREATE CONSTRAINT agent_id_key IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS NODE KEY",
  "CREATE CONSTRAINT session_id_key IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS NODE KEY",
  "CREATE CONSTRAINT flock_id_key IF NOT EXISTS FOR (f:Flock) REQUIRE f.id IS NODE KEY",
  "CREATE CONSTRAINT turn_id_key IF NOT EXISTS FOR (t:Turn) REQUIRE t.id IS NODE KEY",

  // ── Infrastructure node keys (Counter, Settings — not domain entities) ──
  "CREATE CONSTRAINT counter_name_key IF NOT EXISTS FOR (c:Counter) REQUIRE c.name IS NODE KEY",
  "CREATE CONSTRAINT settings_key_key IF NOT EXISTS FOR (s:Settings) REQUIRE s.key IS NODE KEY",

  // ── Business-rule uniqueness (was a UNIQUE column constraint in SQL) ──
  "CREATE CONSTRAINT user_email_unique IF NOT EXISTS FOR (u:User) REQUIRE u.email IS UNIQUE",

  // ── Property existence (was NOT NULL columns with no other constraint) ──
  "CREATE CONSTRAINT task_title_exists IF NOT EXISTS FOR (t:Task) REQUIRE t.title IS NOT NULL",
  "CREATE CONSTRAINT task_state_exists IF NOT EXISTS FOR (t:Task) REQUIRE t.state IS NOT NULL",
  "CREATE CONSTRAINT task_priority_exists IF NOT EXISTS FOR (t:Task) REQUIRE t.priority IS NOT NULL",

  // ── Indexes supporting the hot-path queries ──
  // Matches the claim query's ORDER BY (state, priority, originRank, createdAt)
  // — the direct replacement for SQL Server's IX_tasks_todo_priority.
  "CREATE INDEX task_claim_order_idx IF NOT EXISTS FOR (t:Task) ON (t.state, t.priority, t.originRank, t.createdAt)",
  // Matches the previous filtered IX_sessions_status (status = 'running').
  // Neo4j has no partial/filtered index equivalent, so this indexes the full
  // property — the query predicate still filters to 'running' as before.
  "CREATE INDEX session_status_idx IF NOT EXISTS FOR (s:Session) ON (s.status)",
  // Supports sibling lookup by groupId for the shared branch/PR feature
  // (task #163) — direct replacement for SQL Server's filtered
  // IX_tasks_group_id (group_id IS NOT NULL). As above, Neo4j indexes the
  // full property; tasks with no groupId simply aren't queried by it.
  "CREATE INDEX task_group_id_idx IF NOT EXISTS FOR (t:Task) ON (t.groupId)",

  // ── Turn persistence (session-level turn tracking for the credits dashboard) ──
  // Node key constraint ensures no duplicate Turn nodes for the same session + number
  // (guards against session restart collisions at the DB level).
  "CREATE CONSTRAINT turn_session_number_key IF NOT EXISTS FOR (t:Turn) REQUIRE (t.sessionId, t.number) IS NODE KEY",
  // Index on turn number — helps if Neo4j's planner starts from Turn nodes,
  // though primary lookups traverse from Session via :HAS_TURN relationship.
  "CREATE INDEX turn_session_number_idx IF NOT EXISTS FOR (t:Turn) ON (t.number)",
  // Index on startedAt for date-range queries in usage/dashboard endpoints
  "CREATE INDEX turn_started_at_idx IF NOT EXISTS FOR (t:Turn) ON (t.startedAt)",
  // Supports usage queries filtered by timestamp range (datetime property)
  "CREATE INDEX turn_timestamp_idx IF NOT EXISTS FOR (t:Turn) ON (t.timestamp)",
  // ErrorEvent lookup by timestamp
  "CREATE INDEX error_event_timestamp_idx IF NOT EXISTS FOR (e:ErrorEvent) ON (e.timestamp)",
];

/**
 * Runs the schema bootstrap if the DB is available.
 * Returns true if it succeeded (or the DB is available and statements ran
 * without error), false if the DB is unavailable. Does NOT throw — the
 * caller can decide how to proceed, matching the previous migrate.ts
 * contract exactly (index.ts and the standalone CLI entrypoint below both
 * depend on this never throwing).
 */
export async function runMigration(): Promise<boolean> {
  if (!isDbAvailable()) {
    console.warn("[migrate] ⚠ Database not available — skipping migration.");
    return false;
  }

  try {
    console.log(`[migrate] Applying ${SCHEMA_STATEMENTS.length} constraint/index statements...`);
    for (const statement of SCHEMA_STATEMENTS) {
      await runSchemaStatement(statement);
    }
    console.log("[migrate] Schema bootstrap complete.");

    // ── Chat session backfill ──────────────────────────────────────────────
    // Ensures every user has at least one permanent "Chat" session.
    // Referenced by backend/src/routes/auth.ts's registration handler, which
    // creates this session for new users but notes "the migration backfill
    // will catch it on the next server restart" if that initial insert fails.
    // Idempotent: the WHERE NOT EXISTS guard skips users who already have one.
    // Wrapped in its own try/catch so a backfill failure never prevents the
    // schema bootstrap's success from being reported.
    try {
      const userIds: number[] = await writeQuery(async (tx) => {
        const result = await tx.run(
          `MATCH (u:User) WHERE NOT EXISTS { (u)-[:OWNS]->(:Session {isPermanent: true}) } RETURN u.id AS id`
        );
        return result.records.map((r) => r.get("id") as number);
      });

      if (userIds.length > 0) {
        console.log(`[migrate] Backfilling Chat session for ${userIds.length} user(s)...`);
        for (const userId of userIds) {
          try {
            // Mirrors createSession()'s agentless-session defaults from
            // session-manager.ts (agent: "", status: "stopped", interactive: true,
            // loop: false, etc.) — see that function's doc comment. Uses
            // insertSession() directly (pure DB write) rather than createSession()
            // to avoid in-memory session-map and WebSocket-broadcast side effects
            // that are inappropriate at boot-time migration.
            const session: Session = {
              id: 0, // placeholder — insertSession allocates the real id via getNextId
              name: "Chat",
              agent: "",
              status: "stopped",
              prompt: "",
              interactive: true,
              loop: false,
              runs: 0,
              intervalSeconds: 10,
              cwd: "",
              timeoutSeconds: 0,
              userId,
              createdAt: new Date().toISOString(),
              output: [],
              pinned: true,
              isPermanent: true,
              sortOrder: 0,
              forceLocal: false,
            };
            await insertSession(session);
          } catch (err: any) {
            console.warn(`[migrate] ⚠ Failed to backfill Chat session for user ${userId}: ${err.message || err}`);
          }
        }
        console.log("[migrate] Chat session backfill complete.");
      }
    } catch (err: any) {
      console.warn(`[migrate] ⚠ Chat session backfill failed: ${err.message || err}`);
    }

    return true;
  } catch (err: any) {
    console.warn(`[migrate] ⚠ Migration failed: ${err.message || err}`);
    console.warn("[migrate] ⚠ Database features will be unavailable until the connection is restored.");
    return false;
  }
}

// Run directly: npx tsx src/db/migrate.ts
const isMain = import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
  // runMigration() only checks isDbAvailable() — it never connects itself.
  // Inside the running server, index.ts's start() calls tryConnect() before
  // runMigration(), so that's always already true by the time it's called
  // there. When this file is run standalone (`npm run migrate`), nothing
  // has connected yet, so isDbAvailable() would always be false and the
  // migration would silently no-op. Connect here first to match that.
  tryConnect()
    .then((driver) => {
      if (!driver) {
        console.error(
          "[migrate] ⚠ Could not connect to the database — check NEO4J_* settings in .env."
        );
        process.exit(1);
      }
      return runMigration();
    })
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error("[migrate] Migration failed:", err);
      process.exit(1);
    });
}
