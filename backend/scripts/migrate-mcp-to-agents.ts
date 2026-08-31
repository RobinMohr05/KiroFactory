#!/usr/bin/env node
/**
 * Migration script: freeze tab-toggle MCP servers into per-session entries.
 *
 * For every existing Session, this script computes its effective TabMcpConfig
 * (tab-level toggles merged with any session-level mcpConfigOverride), then
 * runs those toggles + the user's real credentials through the MCP server
 * builder functions to produce concrete McpServerConfig entries. Those entries
 * are appended to the session's existing `mcpServers` array (not overwritten).
 *
 * Idempotency: before appending, each builder result is checked against the
 * session's existing mcpServers by name — duplicates are skipped.
 *
 * NOTE: This script references types/logic that have been removed from the main
 * codebase (TabMcpConfig, DEFAULT_MCP_CONFIG, buildLocalMcpServerEntries). Those
 * are inlined here so the script remains runnable as a historical artifact even
 * after the removal — it was designed to be run exactly once before the removal.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-mcp-to-agents.ts
 *   cd backend && npx tsx scripts/migrate-mcp-to-agents.ts --dry-run
 *
 * Reads NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD from backend/.env via dotenv.
 */

import { parseArgs } from "node:util";
import dotenv from "dotenv";
dotenv.config();

import { tryConnect, closePool, readQuery } from "../src/db/connection.js";
import { getAllSessionsFromDb, updateSessionMeta } from "../src/db/sessions.js";
import { getAllDecryptedCredentials } from "../src/db/credentials.js";
import type { McpServerConfig, Session } from "../src/types.js";

// ─── Inlined types — removed from types.ts as part of this migration ─────────

interface TabMcpConfig {
  atlassian: boolean;
  azureDevops: boolean;
  awsApi: boolean;
  awsDocs: boolean;
}

const DEFAULT_MCP_CONFIG: TabMcpConfig = {
  atlassian: true,
  azureDevops: true,
  awsApi: false,
  awsDocs: true,
};

interface SessionCredentials {
  azureDevOpsPat?: string;
  atlassianApiToken?: string;
  atlassianUsername?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

interface ProxyServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ─── Inlined builder functions — removed from mcp-proxy-config.ts ────────────

function buildAtlassianServer(creds: SessionCredentials): ProxyServerEntry | null {
  if (!creds.atlassianApiToken || !creds.atlassianUsername) return null;
  return {
    command: "npx",
    args: ["-y", "@anthropic/atlassian-mcp-server"],
    env: {
      ATLASSIAN_API_TOKEN: creds.atlassianApiToken,
      ATLASSIAN_USERNAME: creds.atlassianUsername,
    },
  };
}

function buildAzureDevopsServer(creds: SessionCredentials): ProxyServerEntry | null {
  if (!creds.azureDevOpsPat) return null;
  return {
    command: "uvx",
    args: ["azure-devops-mcp"],
    env: { AZURE_DEVOPS_EXT_PAT: creds.azureDevOpsPat },
  };
}

function buildAwsApiServer(creds: SessionCredentials): ProxyServerEntry | null {
  if (!creds.awsAccessKeyId || !creds.awsSecretAccessKey) return null;
  return {
    command: "npx",
    args: ["-y", "@anthropic/aws-mcp-server"],
    env: {
      AWS_ACCESS_KEY_ID: creds.awsAccessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.awsSecretAccessKey,
      AWS_DEFAULT_REGION: "eu-central-1",
    },
  };
}

function buildAwsDocsServer(): ProxyServerEntry {
  return { command: "npx", args: ["-y", "@anthropic/aws-docs-mcp-server"], env: {} };
}

function toMcpServerConfig(name: string, entry: ProxyServerEntry): McpServerConfig {
  return {
    name,
    command: entry.command,
    args: entry.args,
    env: Object.entries(entry.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
  };
}

function buildLocalMcpServerEntries(
  mcpConfig: TabMcpConfig,
  credentials: SessionCredentials
): McpServerConfig[] {
  const entries: McpServerConfig[] = [];

  if (mcpConfig.atlassian) {
    const entry = buildAtlassianServer(credentials);
    if (entry) entries.push(toMcpServerConfig("atlassian", entry));
  }
  if (mcpConfig.azureDevops) {
    const entry = buildAzureDevopsServer(credentials);
    if (entry) entries.push(toMcpServerConfig("azure-devops", entry));
  }
  if (mcpConfig.awsApi) {
    const entry = buildAwsApiServer(credentials);
    if (entry) entries.push(toMcpServerConfig("aws-api", entry));
  }
  if (mcpConfig.awsDocs) {
    entries.push(toMcpServerConfig("aws-docs", buildAwsDocsServer()));
  }

  return entries;
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`
Usage: cd backend && npx tsx scripts/migrate-mcp-to-agents.ts [--dry-run]

Freezes tab-toggle MCP servers (Atlassian, Azure DevOps, AWS API, AWS Docs)
into concrete per-session McpServerConfig entries, then the TabMcpConfig
mechanism can be safely removed.

Options:
  --dry-run   Log what would be migrated without writing to the database.
  -h, --help  Show this help.
`);
  process.exit(0);
}

const DRY_RUN = flags["dry-run"] === true;

// ─── Migration logic ─────────────────────────────────────────────────────────

/**
 * Resolve the effective TabMcpConfig for a session by reading from the DB.
 *
 * Since the Tab.mcpConfig and Session.mcpConfigOverride fields have been
 * removed from the runtime types, this function reads the :McpConfig nodes
 * directly via raw Cypher. The :HAS_MCP_CONFIG and :HAS_MCP_CONFIG_OVERRIDE
 * relationships still exist in Neo4j at migration time.
 *
 * Logic mirrors what session-manager.ts used to do:
 *   1. Start with DEFAULT_MCP_CONFIG
 *   2. If the session's first tab has a :McpConfig node, use that as the base
 *   3. If the session has a :HAS_MCP_CONFIG_OVERRIDE → :McpConfig, merge on top
 */
export async function resolveEffectiveMcpConfig(session: Session): Promise<TabMcpConfig> {
  let config: TabMcpConfig = { ...DEFAULT_MCP_CONFIG };

  // 1. Read tab's :McpConfig (from the session's first tab, if any)
  const firstTabId = session.tabIds?.[0];
  if (firstTabId != null) {
    const tabConfig = await readQuery(async (tx) => {
      const result = await tx.run(
        `MATCH (t:Tab {id: $tabId})-[:HAS_MCP_CONFIG]->(m:McpConfig)
         RETURN m {.*} AS mcpConfig`,
        { tabId: firstTabId }
      );
      if (result.records.length === 0) return null;
      return result.records[0].get("mcpConfig") as TabMcpConfig | null;
    });
    if (tabConfig) {
      config = {
        atlassian: !!tabConfig.atlassian,
        azureDevops: !!tabConfig.azureDevops,
        awsApi: !!tabConfig.awsApi,
        awsDocs: !!tabConfig.awsDocs,
      };
    }
  }

  // 2. Read session's :McpConfigOverride and merge on top
  const sessionOverride = await readQuery(async (tx) => {
    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})-[:HAS_MCP_CONFIG_OVERRIDE]->(m:McpConfig)
       RETURN m {.*} AS mcpConfig`,
      { sessionId: session.id }
    );
    if (result.records.length === 0) return null;
    return result.records[0].get("mcpConfig") as TabMcpConfig | null;
  });
  if (sessionOverride) {
    config = {
      ...config,
      atlassian: !!sessionOverride.atlassian,
      azureDevops: !!sessionOverride.azureDevops,
      awsApi: !!sessionOverride.awsApi,
      awsDocs: !!sessionOverride.awsDocs,
    };
  }

  return config;
}

async function main(): Promise<void> {
  console.log(DRY_RUN ? "🔍 DRY RUN — no changes will be written.\n" : "🚀 Starting migration...\n");

  await tryConnect();

  const sessions = await getAllSessionsFromDb();
  console.log(`Found ${sessions.length} session(s) total.\n`);

  let migratedCount = 0;
  let skippedCount = 0;

  for (const session of sessions) {
    // Skip sessions with no userId (shouldn't happen but be safe)
    if (!session.userId) {
      console.log(`  [SKIP] Session ${session.id} "${session.name}" — no userId`);
      skippedCount++;
      continue;
    }

    const effectiveConfig = await resolveEffectiveMcpConfig(session);

    // Get user's credentials
    let credentials: SessionCredentials;
    try {
      const rawCreds = await getAllDecryptedCredentials(session.userId);
      credentials = {
        azureDevOpsPat: rawCreds.azureDevOpsPat,
        atlassianApiToken: rawCreds.atlassianApiToken,
        atlassianUsername: rawCreds.atlassianUsername,
        awsAccessKeyId: rawCreds.awsAccessKeyId,
        awsSecretAccessKey: rawCreds.awsSecretAccessKey,
      };
    } catch (err) {
      console.log(`  [SKIP] Session ${session.id} "${session.name}" — failed to decrypt credentials: ${(err as Error).message}`);
      skippedCount++;
      continue;
    }

    // Build concrete server entries from toggles + credentials
    const newEntries = buildLocalMcpServerEntries(effectiveConfig, credentials);

    if (newEntries.length === 0) {
      console.log(`  [SKIP] Session ${session.id} "${session.name}" — no toggle-driven servers resolved (toggles off or no credentials)`);
      skippedCount++;
      continue;
    }

    // Filter out entries whose name already exists in the session's current mcpServers (idempotency)
    const existingNames = new Set((session.mcpServers ?? []).map((s) => s.name));
    const toAdd: McpServerConfig[] = [];
    for (const entry of newEntries) {
      if (existingNames.has(entry.name)) {
        console.log(`    [DUP] "${entry.name}" already in session ${session.id} mcpServers — skipping`);
        continue;
      }
      toAdd.push(entry);
    }

    if (toAdd.length === 0) {
      console.log(`  [SKIP] Session ${session.id} "${session.name}" — all resolved servers already present (idempotent)`);
      skippedCount++;
      continue;
    }

    // Append to existing mcpServers
    const updatedMcpServers = [...(session.mcpServers ?? []), ...toAdd];
    const updatedSession: Session = { ...session, mcpServers: updatedMcpServers };

    const serverNames = toAdd.map((s) => s.name).join(", ");
    if (DRY_RUN) {
      console.log(`  [DRY] Session ${session.id} "${session.name}" — would add: ${serverNames}`);
    } else {
      await updateSessionMeta(updatedSession);
      console.log(`  [MIGRATED] Session ${session.id} "${session.name}" — added: ${serverNames}`);
    }
    migratedCount++;
  }

  console.log(`\n${DRY_RUN ? "Dry run" : "Migration"} complete: ${migratedCount} session(s) ${DRY_RUN ? "would be " : ""}migrated, ${skippedCount} skipped.`);

  await closePool();
}

// Only run main() when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith("migrate-mcp-to-agents.ts");
if (isDirectExecution) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
