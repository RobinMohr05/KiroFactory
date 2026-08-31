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
import type { Session } from "../src/types.js";
interface TabMcpConfig {
    atlassian: boolean;
    azureDevops: boolean;
    awsApi: boolean;
    awsDocs: boolean;
}
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
export declare function resolveEffectiveMcpConfig(session: Session): Promise<TabMcpConfig>;
export {};
//# sourceMappingURL=migrate-mcp-to-agents.d.ts.map