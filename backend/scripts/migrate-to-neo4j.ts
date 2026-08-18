/**
 * One-time data migration: Azure SQL (mssql) -> Neo4j (AuraDB).
 *
 * Manually invoked, NOT part of app startup (parallel to seed-agents.ts /
 * seed-local-dev.ts) — see .kiro/specs/neo4j-migration/design.md, "One-time
 * migration script" section, and Requirement 5 in
 * .kiro/specs/neo4j-migration/requirements.md.
 *
 * WHAT THIS DOES:
 *   1. Connects to the source Azure SQL database (its own standalone mssql
 *      pool — the app's own db/connection.ts is Neo4j-only now, mssql was
 *      removed from it entirely) and the destination Neo4j driver.
 *   2. Runs the Neo4j schema bootstrap (constraints/indexes) first.
 *   3. Reads every row from every real table (users, settings, tabs, tasks,
 *      task_tabs, agents, agent_tabs, sessions) and imports it into Neo4j,
 *      preserving original IDs and timestamps exactly.
 *   4. Explicitly SKIPS the `boards` table (confirmed dead: one placeholder
 *      row, zero FK references anywhere) and the `tasks.retry_count` /
 *      `tasks.max_retries` columns (confirmed dead: nothing in the app reads
 *      them — the real retry logic lives in-memory in session-manager.ts).
 *   5. Seeds each entity's :Counter node to the max imported ID for that
 *      label, so post-migration getNextId() calls continue numbering above
 *      it rather than restarting at 1 and colliding with imported data.
 *   6. Prints a per-entity read-vs-created count table so the operator can
 *      visually confirm parity before treating the cutover as complete.
 *   7. Fails LOUDLY on any error — naming the entity/row that failed — and
 *      never completes a silent partial import (Requirement 5.5).
 *
 * WHY THIS SCRIPT WRITES ITS OWN CYPHER INSTEAD OF CALLING db/*.ts's
 * createTask()/insertSession()/etc.:
 *   Those functions all call getNextId() to allocate a BRAND NEW id for
 *   whatever they create — exactly wrong for a migration, which must
 *   PRESERVE each row's original SQL identity column value so that existing
 *   branch names ([type]/#[id]_[slug]), PR titles, and any external
 *   reference to a task/user/etc. by number keep meaning the same thing
 *   after the cutover. Every CREATE below sets `id: $id` explicitly from
 *   the source row instead.
 *
 * NEO4J NULL-PROPERTY BEHAVIOR RELIED ON THROUGHOUT (already documented and
 * confirmed empirically in db/sessions.ts's own file-header comment): setting
 * a property to a null-valued Cypher parameter is equivalent to never setting
 * it at all — the property is simply absent, not "present with value null".
 * This is what lets every OPTIONAL column below (branch, model, startedAt,
 * repositoryUrl, etc.) be written with one unconditional CREATE map instead
 * of per-field conditional Cypher branches.
 *
 * Usage (see backend/package.json's "migrate:to-neo4j" script):
 *   cd backend && npm run migrate:to-neo4j
 *
 * Requires backend/.env to have BOTH the source Azure SQL vars (DB_SERVER,
 * DB_DATABASE, DB_USER, DB_PASSWORD, DB_PORT, DB_ENCRYPT,
 * DB_TRUST_SERVER_CERTIFICATE) and the destination Neo4j vars (NEO4J_URI,
 * NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE) present simultaneously —
 * both are still in backend/.env today since Requirement 8.2's DB_* removal
 * is gated on the separate final-cutover approval (Task 11), not this step.
 */

import dotenv from "dotenv";
dotenv.config();

import sql from "mssql";
import type { ManagedTransaction } from "neo4j-driver";
import { tryConnect as tryConnectNeo4j, writeQuery, closePool as closeNeo4jDriver } from "../src/db/connection.js";
import { runMigration } from "../src/db/migrate.js";
import { ensureCounterAtLeast, type CounterLabel } from "../src/db/id-counter.js";
import { DEFAULT_MCP_CONFIG } from "../src/types.js";

// ---------------------------------------------------------------------------
// Source (Azure SQL) connection — standalone, mirrors the pre-migration
// db/connection.ts config exactly (see that file's history at commit
// 9795785^) since the app's own connection.ts no longer has any mssql code
// to import. This is a one-shot script, so it skips that file's pooling/
// retry sophistication (min:0 idle pool, NTLM fallback, etc.) — a single
// connection opened once and closed once is all this needs.
// ---------------------------------------------------------------------------

const useWindowsAuth = !process.env.DB_USER;

const sqlConfig: sql.config = {
  server: process.env.DB_SERVER || "localhost",
  database: process.env.DB_DATABASE || "TecFactory",
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
  },
  connectionTimeout: 60000,
  requestTimeout: 30000,
  ...(useWindowsAuth
    ? {
        authentication: {
          type: "ntlm",
          options: {
            domain: process.env.DB_DOMAIN || "",
            userName: process.env.DB_NTLM_USER || "",
            password: process.env.DB_NTLM_PASSWORD || "",
          },
        },
      }
    : {
        user: process.env.DB_USER || "sa",
        password: process.env.DB_PASSWORD || "",
      }),
} as sql.config;

// ---------------------------------------------------------------------------
// Per-entity read-vs-created counters, printed as a final summary table
// (Requirement 5.4 — the operator's visual parity check).
// ---------------------------------------------------------------------------

interface EntityCount {
  entity: string;
  read: number;
  created: number;
}
const counts: EntityCount[] = [];

function record(entity: string, read: number, created: number): void {
  counts.push({ entity, read, created });
}

function printSummary(): void {
  console.log("\n[migrate-to-neo4j] ── Migration summary (read vs. created) ──");
  const rows = counts.map((c) => ({
    Entity: c.entity,
    "Read from SQL": c.read,
    "Created in Neo4j": c.created,
    Match: c.read === c.created ? "OK" : "MISMATCH",
  }));
  console.table(rows);
  const mismatches = counts.filter((c) => c.read !== c.created);
  if (mismatches.length > 0) {
    console.warn(
      `[migrate-to-neo4j] WARNING: ${mismatches.length} entity type(s) show a read/created mismatch — investigate before treating this migration as complete.`
    );
  }
}

// ---------------------------------------------------------------------------
// Small helpers for the JSON-string source columns
// ---------------------------------------------------------------------------

/** Parses a nullable JSON-array-of-strings column, defaulting to []. */
function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Same mapping as computeOriginRank() in backend/src/db/tasks.ts — origin is
 * immutable after creation there, so this is computed once per imported row
 * exactly the same way a fresh createTask() call would.
 */
function computeOriginRank(origin: string): number {
  switch (origin) {
    case "user":
      return 0;
    case "user-assisted":
      return 1;
    case "ai":
      return 2;
    default:
      return 3;
  }
}

/** Zips parallel {name,value} entries out of an Array<{name,value}>, mirrors sessions.ts's unzipEnv(). */
function unzipEnv(env: Array<{ name: string; value: string }>): { envNames: string[]; envValues: string[] } {
  return { envNames: env.map((e) => e.name), envValues: env.map((e) => e.value) };
}

// ---------------------------------------------------------------------------
// Main migration steps, one function per entity type, run in dependency
// order. Each wraps its node-creation in its own writeQuery() transaction so
// a failure partway through one entity type doesn't roll into the next
// entity type's work (each entity type is its own unit of atomicity here;
// there is no cross-entity rollback — Requirement 5.5's "fail loudly" is
// satisfied by aborting the whole script immediately on the first error
// rather than by transactional rollback across entities).
// ---------------------------------------------------------------------------

async function migrateUsers(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM users`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] users: read ${rows.length} row(s) from SQL`);

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      await tx.run(
        `CREATE (u:User {
           id: $id, email: $email, passwordHash: $passwordHash,
           kiroApiKeyEncrypted: $kiroApiKeyEncrypted, defaultGitProvider: $defaultGitProvider,
           credAzureDevOpsPat: $credAzureDevOpsPat, credAtlassianApiToken: $credAtlassianApiToken,
           credAtlassianUsername: $credAtlassianUsername, credAwsAccessKeyId: $credAwsAccessKeyId,
           credAwsSecretAccessKey: $credAwsSecretAccessKey, credGithubPat: $credGithubPat,
           createdAt: datetime($createdAt), updatedAt: datetime($updatedAt)
         })`,
        {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          kiroApiKeyEncrypted: row.kiro_api_key_encrypted,
          defaultGitProvider: row.default_git_provider ?? null,
          // Credential columns copied verbatim (still encrypted) — never
          // decrypted/re-encrypted here. Null stays null (-> absent property).
          credAzureDevOpsPat: row.cred_azure_devops_pat ?? null,
          credAtlassianApiToken: row.cred_atlassian_api_token ?? null,
          credAtlassianUsername: row.cred_atlassian_username ?? null,
          credAwsAccessKeyId: row.cred_aws_access_key_id ?? null,
          credAwsSecretAccessKey: row.cred_aws_secret_access_key ?? null,
          credGithubPat: row.cred_github_pat ?? null,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        }
      );
      created++;
    }
  });

  record("users", rows.length, created);
  if (rows.length > 0) {
    await ensureCounterAtLeast("User", Math.max(...rows.map((r) => r.id as number)));
  }
}

async function migrateSettings(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM settings`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] settings: read ${rows.length} row(s) from SQL`);

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      const key = row.key as string;
      if (key === "registration_enabled") {
        // Normalize the historically-ambiguous string convention (schema.sql
        // seeds 'true', migrate.ts's old incremental path seeded '0', the
        // read path only ever recognized literal "1") to a real boolean —
        // see db/settings.ts's file header for the full bug history this
        // fixes. Treated as enabled only for an exact (case-insensitive)
        // '1' or 'true'; anything else (including the historically-buggy
        // '0') normalizes to false.
        const raw = String(row.value).trim().toLowerCase();
        const enabled = raw === "1" || raw === "true";
        await tx.run(`CREATE (s:Settings {key: $key, enabled: $enabled})`, { key, enabled });
      } else {
        // Every other settings key (none exist today beyond
        // registration_enabled, but the source table is generic key/value)
        // keeps the plain string `value` property untouched.
        await tx.run(`CREATE (s:Settings {key: $key, value: $value})`, { key, value: row.value });
      }
      created++;
    }
  });

  record("settings", rows.length, created);
}

async function migrateTabs(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM tabs`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] tabs: read ${rows.length} row(s) from SQL`);

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      const columns = parseStringArray(row.columns_json);
      let mcp = DEFAULT_MCP_CONFIG;
      if (row.mcp_config) {
        try {
          const parsed = JSON.parse(row.mcp_config);
          mcp = {
            atlassian: !!parsed.atlassian,
            azureDevops: !!parsed.azureDevops,
            awsApi: !!parsed.awsApi,
            awsDocs: !!parsed.awsDocs,
          };
        } catch {
          // Corrupted mcp_config JSON — fall back to the default rather
          // than failing the whole migration over one tab's cosmetic config.
        }
      }

      // Chained CREATE (Tab + its always-present McpConfig sub-node) plus an
      // OPTIONAL owner match + FOREACH-CASE guard, exactly mirroring
      // db/tabs.ts's createTab() pattern — a plain (non-optional) MATCH on a
      // nonexistent owner would leave the CREATE committed but return zero
      // rows, which is not what we want for a bulk migration (a tab with a
      // dangling/nonexistent user_id should still import, just ownerless).
      await tx.run(
        `CREATE (t:Tab {
           id: $id, name: $name, repositoryUrl: $repositoryUrl, gitProvider: $gitProvider,
           columns: $columns, sortOrder: $sortOrder, createdAt: datetime($createdAt)
         })-[:HAS_MCP_CONFIG]->(:McpConfig {
           atlassian: $atlassian, azureDevops: $azureDevops, awsApi: $awsApi, awsDocs: $awsDocs
         })
         WITH t
         OPTIONAL MATCH (owner:User {id: $userId})
         FOREACH (_ IN CASE WHEN owner IS NOT NULL THEN [1] ELSE [] END |
           MERGE (owner)-[:OWNS]->(t)
         )`,
        {
          id: row.id,
          name: row.name,
          repositoryUrl: row.repository_url ?? null,
          gitProvider: row.git_provider ?? null,
          columns,
          sortOrder: row.sort_order ?? 0,
          createdAt: new Date(row.created_at).toISOString(),
          atlassian: mcp.atlassian,
          azureDevops: mcp.azureDevops,
          awsApi: mcp.awsApi,
          awsDocs: mcp.awsDocs,
          userId: row.user_id ?? null,
        }
      );
      created++;
    }
  });

  record("tabs", rows.length, created);
  if (rows.length > 0) {
    await ensureCounterAtLeast("Tab", Math.max(...rows.map((r) => r.id as number)));
  }
}

async function migrateTasks(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM tasks`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] tasks: read ${rows.length} row(s) from SQL`);
  console.log(
    "[migrate-to-neo4j] Skipped columns tasks.retry_count / tasks.max_retries (confirmed dead — nothing reads them)."
  );

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      const origin = row.origin as string;
      await tx.run(
        `CREATE (t:Task {
           id: $id, title: $title, priority: $priority, type: $type, state: $state,
           description: $description, files: $files, origin: $origin, originRank: $originRank,
           branch: $branch, pullRequestUrl: $pullRequestUrl,
           createdAt: datetime($createdAt), updatedAt: datetime($updatedAt)
         })`,
        {
          id: row.id,
          title: row.title,
          priority: row.priority,
          type: row.type,
          state: row.state,
          description: row.description ?? "",
          files: parseStringArray(row.files),
          origin,
          originRank: computeOriginRank(origin),
          branch: row.branch ?? null,
          pullRequestUrl: row.pull_request_url ?? null,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        }
      );
      created++;
    }
  });

  record("tasks", rows.length, created);
  console.log(
    "[migrate-to-neo4j] No DEPENDS_ON edges created for tasks — the source SQL schema has no dependency concept at all, so this relationship type starts empty."
  );
  if (rows.length > 0) {
    await ensureCounterAtLeast("Task", Math.max(...rows.map((r) => r.id as number)));
  }
}

async function migrateTaskTabs(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM task_tabs`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] task_tabs: read ${rows.length} row(s) from SQL`);

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      const r = await tx.run(
        `MATCH (t:Task {id: $taskId}), (tab:Tab {id: $tabId})
         MERGE (t)-[:IN_TAB]->(tab)
         RETURN t`,
        { taskId: row.task_id, tabId: row.tab_id }
      );
      if (r.records.length > 0) created++;
      else {
        console.warn(
          `[migrate-to-neo4j] task_tabs: skipped dangling reference task_id=${row.task_id}, tab_id=${row.tab_id} (task or tab not found)`
        );
      }
    }
  });

  record("task_tabs (IN_TAB edges)", rows.length, created);
}

async function migrateAgents(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM agents`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] agents: read ${rows.length} row(s) from SQL`);

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      // tools_settings is already a JSON string in the source column, and
      // :ToolsSettings.json is also just a raw JSON string property — copy
      // as-is rather than parsing and re-serializing (see db/agents.ts's
      // ToolsSettings note: arbitrary/dynamic shape stays an opaque string).
      await tx.run(
        `CREATE (a:Agent {
           id: $id, name: $name, description: $description, prompt: $prompt,
           tools: $tools, allowedTools: $allowedTools, resources: $resources,
           kind: $kind, claimState: $claimState, workingState: $workingState,
           resolveState: $resolveState, requiresTask: $requiresTask,
           createdAt: datetime($createdAt), updatedAt: datetime($updatedAt)
         })-[:HAS_TOOLS_SETTINGS]->(:ToolsSettings {json: $toolsSettingsJson})
         WITH a
         OPTIONAL MATCH (owner:User {id: $userId})
         FOREACH (_ IN CASE WHEN owner IS NOT NULL THEN [1] ELSE [] END |
           MERGE (owner)-[:OWNS]->(a)
         )`,
        {
          id: row.id,
          name: row.name,
          description: row.description ?? "",
          prompt: row.prompt ?? "",
          tools: parseStringArray(row.tools),
          allowedTools: parseStringArray(row.allowed_tools),
          resources: parseStringArray(row.resources),
          kind: row.kind || "editor",
          claimState: row.claim_state || "todo",
          workingState: row.working_state || "in-progress",
          resolveState: row.resolve_state || "developed",
          requiresTask: !!row.requires_task,
          toolsSettingsJson: row.tools_settings ?? "{}",
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
          userId: row.user_id ?? null,
        }
      );
      created++;
    }
  });

  record("agents", rows.length, created);
  if (rows.length > 0) {
    await ensureCounterAtLeast("Agent", Math.max(...rows.map((r) => r.id as number)));
  }
}

async function migrateAgentTabs(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM agent_tabs`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] agent_tabs: read ${rows.length} row(s) from SQL`);

  let created = 0;
  await writeQuery(async (tx: ManagedTransaction) => {
    for (const row of rows) {
      const r = await tx.run(
        `MATCH (a:Agent {id: $agentId}), (tab:Tab {id: $tabId})
         MERGE (a)-[:IN_TAB]->(tab)
         RETURN a`,
        { agentId: row.agent_id, tabId: row.tab_id }
      );
      if (r.records.length > 0) created++;
      else {
        console.warn(
          `[migrate-to-neo4j] agent_tabs: skipped dangling reference agent_id=${row.agent_id}, tab_id=${row.tab_id} (agent or tab not found)`
        );
      }
    }
  });

  record("agent_tabs (IN_TAB edges)", rows.length, created);
}

async function migrateSessions(pool: sql.ConnectionPool, validTabIds: Set<number>): Promise<void> {
  const result = await pool.request().query(`SELECT * FROM sessions`);
  const rows = result.recordset;
  console.log(`[migrate-to-neo4j] sessions: read ${rows.length} row(s) from SQL`);

  let created = 0;
  let skippedNoOwner = 0;
  let coercedRunning = 0;

  for (const row of rows) {
    // (:User)-[:OWNS]->(:Session) is NOT optional in this app's model
    // (unlike Tab/Agent) — every Session the app creates gets an owner via
    // insertSession()'s strict, non-OPTIONAL MATCH. sessions.user_id IS
    // nullable in the source schema though, so an ownerless row here has no
    // valid destination shape to import into. Skip and log rather than
    // silently inventing an owner or violating the app's own invariant.
    if (row.user_id === null || row.user_id === undefined) {
      skippedNoOwner++;
      console.warn(`[migrate-to-neo4j] sessions: skipped session id=${row.id} — user_id is null, but Session ownership is required`);
      continue;
    }

    // Requirement 5.3: a session that was 'running' when the source DB was
    // last read cannot be resumed across a persistence-layer switch — the
    // underlying kiro-cli process (if any) is long gone. Coerce to 'stopped'.
    let status = row.status as string;
    if (status === "running") {
      status = "stopped";
      coercedRunning++;
    }

    let currentActivity: { type: string; detail?: string } | null = null;
    if (row.current_activity) {
      try {
        currentActivity = JSON.parse(row.current_activity);
      } catch {
        currentActivity = null;
      }
    }

    let mcpConfigOverride: { atlassian: boolean; azureDevops: boolean; awsApi: boolean; awsDocs: boolean } | null = null;
    if (row.mcp_config_override) {
      try {
        const parsed = JSON.parse(row.mcp_config_override);
        mcpConfigOverride = {
          atlassian: !!parsed.atlassian,
          azureDevops: !!parsed.azureDevops,
          awsApi: !!parsed.awsApi,
          awsDocs: !!parsed.awsDocs,
        };
      } catch {
        mcpConfigOverride = null;
      }
    }

    const rawTabIds: number[] = row.tab_ids ? parseStringArray(row.tab_ids).map(Number) : [];
    const tabIds = rawTabIds.filter((id) => {
      const ok = validTabIds.has(id);
      if (!ok) {
        console.warn(`[migrate-to-neo4j] sessions: session id=${row.id} references nonexistent tab id=${id} — skipping that IN_TAB edge`);
      }
      return ok;
    });

    interface McpServerJson {
      name: string;
      command: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
    }
    let mcpServerEntries: McpServerJson[] = [];
    if (row.mcp_servers) {
      try {
        const parsed = JSON.parse(row.mcp_servers);
        if (Array.isArray(parsed)) mcpServerEntries = parsed;
      } catch {
        mcpServerEntries = [];
      }
    }
    const mcpServersParam = mcpServerEntries.map((m, i) => {
      const { envNames, envValues } = unzipEnv(m.env ?? []);
      return { position: i, name: m.name, command: m.command, args: m.args ?? [], envNames, envValues };
    });

    let rawMcpServerEntries: unknown[] = [];
    if (row.raw_mcp_servers) {
      try {
        const parsed = JSON.parse(row.raw_mcp_servers);
        if (Array.isArray(parsed)) rawMcpServerEntries = parsed;
      } catch {
        rawMcpServerEntries = [];
      }
    }
    const rawMcpServersParam = rawMcpServerEntries.map((entry, i) => ({ position: i, json: JSON.stringify(entry) }));

    await writeQuery(async (tx: ManagedTransaction) => {
      await tx.run(
        `MATCH (owner:User {id: $userId})
         CREATE (s:Session {
           id: $id, name: $name, agent: $agent, status: $status, prompt: $prompt,
           interactive: $interactive, loop: $loop, runs: $runs, intervalSeconds: $intervalSeconds,
           cwd: $cwd, timeoutSeconds: $timeoutSeconds, model: $model,
           activityType: $activityType, activityDetail: $activityDetail, currentTaskId: $currentTaskId,
           pinned: $pinned, isPermanent: $isPermanent, sortOrder: $sortOrder, forceLocal: $forceLocal,
           createdAt: datetime($createdAt), startedAt: datetime($startedAt)
         })
         CREATE (owner)-[:OWNS]->(s)
         WITH s
         FOREACH (_ IN CASE WHEN $mcpConfigOverride IS NOT NULL THEN [1] ELSE [] END |
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
         }`,
        {
          id: row.id,
          userId: row.user_id,
          name: row.name,
          agent: row.agent || "",
          status,
          prompt: row.prompt ?? "",
          interactive: !!row.interactive,
          loop: !!row.loop,
          runs: row.runs ?? 0,
          intervalSeconds: row.interval_seconds ?? 10,
          cwd: row.cwd,
          timeoutSeconds: row.timeout_seconds ?? 0,
          model: row.model ?? null,
          activityType: currentActivity?.type ?? null,
          activityDetail: currentActivity?.detail ?? null,
          currentTaskId: row.current_task_id ?? null,
          pinned: !!row.pinned,
          isPermanent: false, // is_permanent is not a real SQL column today (see schema.sql) — defaults false, matching current app behavior for pre-existing rows.
          sortOrder: row.sort_order ?? 0,
          forceLocal: !!row.force_local,
          createdAt: new Date(row.created_at).toISOString(),
          startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
          mcpConfigOverride,
          tabIds,
          mcpServers: mcpServersParam,
          rawMcpServers: rawMcpServersParam,
        }
      );
    });
    created++;
  }

  if (coercedRunning > 0) {
    console.log(`[migrate-to-neo4j] sessions: coerced ${coercedRunning} 'running' session(s) to 'stopped' on import (Requirement 5.3).`);
  }
  if (skippedNoOwner > 0) {
    console.log(`[migrate-to-neo4j] sessions: skipped ${skippedNoOwner} session(s) with no owner (user_id was null).`);
  }

  record("sessions", rows.length, created);
  if (rows.length > 0) {
    await ensureCounterAtLeast("Session", Math.max(...rows.map((r) => r.id as number)));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[migrate-to-neo4j] Starting one-time Azure SQL -> Neo4j migration...");
  console.log("[migrate-to-neo4j] Skipped table 'boards' (confirmed dead — single placeholder row, no FKs reference it).");

  let sqlPool: sql.ConnectionPool | null = null;

  try {
    console.log(`[migrate-to-neo4j] Connecting to source Azure SQL (${sqlConfig.server}/${sqlConfig.database})...`);
    sqlPool = await new sql.ConnectionPool(sqlConfig).connect();
    console.log("[migrate-to-neo4j] Connected to source Azure SQL.");

    console.log("[migrate-to-neo4j] Connecting to destination Neo4j...");
    const driver = await tryConnectNeo4j();
    if (!driver) {
      throw new Error("Could not connect to destination Neo4j — check NEO4J_* settings in backend/.env.");
    }
    console.log("[migrate-to-neo4j] Connected to destination Neo4j.");

    console.log("[migrate-to-neo4j] Running Neo4j schema bootstrap (constraints/indexes)...");
    const migrated = await runMigration();
    if (!migrated) {
      throw new Error("Neo4j schema bootstrap failed or the database was reported unavailable.");
    }

    // Dependency order: users -> settings -> tabs -> tasks (+task_tabs) ->
    // agents (+agent_tabs) -> sessions. Junction tables run immediately
    // after both sides of the relationship they describe already exist.
    await migrateUsers(sqlPool);
    await migrateSettings(sqlPool);
    await migrateTabs(sqlPool);
    await migrateTasks(sqlPool);
    await migrateTaskTabs(sqlPool);
    await migrateAgents(sqlPool);
    await migrateAgentTabs(sqlPool);

    // Sessions need the full set of valid tab ids to filter tab_ids against
    // (a session referencing a tab that doesn't exist should skip that one
    // edge, not fail the whole session's import) — read tabs.id fresh from
    // the source rather than re-deriving it from the tabs already imported,
    // since it's the exact same set either way and this avoids a second
    // round trip to Neo4j just to ask it what it already has.
    const tabIdRows = await sqlPool.request().query(`SELECT id FROM tabs`);
    const validTabIds = new Set<number>(tabIdRows.recordset.map((r: { id: number }) => r.id));
    await migrateSessions(sqlPool, validTabIds);

    printSummary();
    console.log("[migrate-to-neo4j] Migration completed successfully.");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n[migrate-to-neo4j] FATAL — migration aborted partway through.");
    console.error("[migrate-to-neo4j] Progress so far (entities completed before the failure):");
    printSummary();
    console.error("[migrate-to-neo4j] Error detail:", err instanceof Error ? err.stack || err.message : err);
    process.exitCode = 1;
  } finally {
    if (sqlPool) {
      try {
        await sqlPool.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    await closeNeo4jDriver();
  }
}

main();
