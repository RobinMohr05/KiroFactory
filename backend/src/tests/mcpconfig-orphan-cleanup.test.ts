/**
 * Structural tests verifying that deleteSessionFromDb, updateSessionMeta,
 * and deleteTab properly clean up legacy `:McpConfig` nodes left behind by
 * the now-removed TabMcpConfig feature.
 *
 * After the migration off TabMcpConfig, existing sessions and tabs may still
 * have `(:Session)-[:HAS_MCP_CONFIG_OVERRIDE]->(:McpConfig)` and
 * `(:Tab)-[:HAS_MCP_CONFIG]->(:McpConfig)` relationships in the graph.
 * When those sessions/tabs are deleted or updated, the `:McpConfig` node
 * must also be deleted to prevent orphaned nodes.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Read the source files to structurally verify Cypher queries
const sessionsSource = readFileSync(
  new URL("../db/sessions.ts", import.meta.url),
  "utf-8"
);

const tabsSource = readFileSync(
  new URL("../db/tabs.ts", import.meta.url),
  "utf-8"
);

describe("legacy McpConfig orphan cleanup", () => {
  describe("deleteSessionFromDb", () => {
    it("should clean up legacy HAS_MCP_CONFIG_OVERRIDE → McpConfig nodes", () => {
      // Extract the deleteSessionFromDb function
      const match = sessionsSource.match(
        /export async function deleteSessionFromDb[\s\S]*?^}/m
      );
      expect(match).not.toBeNull();
      const body = match![0];

      // Must include OPTIONAL MATCH for legacy McpConfig override nodes
      expect(body).toMatch(/OPTIONAL MATCH.*HAS_MCP_CONFIG_OVERRIDE.*McpConfig/s);
    });

    it("should include legacy McpConfig in DETACH DELETE", () => {
      const match = sessionsSource.match(
        /export async function deleteSessionFromDb[\s\S]*?^}/m
      );
      expect(match).not.toBeNull();
      const body = match![0];

      // The DETACH DELETE must include the McpConfig alias
      // (it should delete s, mcp, raw, AND the legacy mcpOverride)
      expect(body).toMatch(/DETACH DELETE.*mcpOverride/s);
    });

    it("should not mention McpConfig override in the docstring", () => {
      // The docstring above deleteSessionFromDb should NOT reference McpConfig override
      // as currently maintained — it should describe the legacy cleanup purpose instead
      const docMatch = sessionsSource.match(
        /\/\*\*[\s\S]*?\*\/\s*export async function deleteSessionFromDb/
      );
      expect(docMatch).not.toBeNull();
      const docstring = docMatch![0];

      // Should NOT claim McpConfig override is an "exclusively owned sub-node" being
      // actively managed — it's legacy cleanup
      expect(docstring).not.toMatch(/McpConfig\s*\n?\s*\*\s*override.*exclusively owned/s);
    });
  });

  describe("updateSessionMeta", () => {
    it("should clean up legacy HAS_MCP_CONFIG_OVERRIDE → McpConfig nodes", () => {
      // Extract the updateSessionMeta function
      const match = sessionsSource.match(
        /export async function updateSessionMeta[\s\S]*?^}/m
      );
      expect(match).not.toBeNull();
      const body = match![0];

      // Must include OPTIONAL MATCH for legacy McpConfig override nodes
      expect(body).toMatch(/OPTIONAL MATCH.*HAS_MCP_CONFIG_OVERRIDE.*McpConfig/s);
    });
  });

  describe("deleteTab", () => {
    it("should clean up legacy HAS_MCP_CONFIG → McpConfig nodes", () => {
      // Extract the deleteTab function
      const match = tabsSource.match(
        /export async function deleteTab[\s\S]*?^}/m
      );
      expect(match).not.toBeNull();
      const body = match![0];

      // Must include OPTIONAL MATCH for legacy McpConfig nodes
      expect(body).toMatch(/OPTIONAL MATCH.*HAS_MCP_CONFIG.*McpConfig/s);
    });

    it("should include legacy McpConfig in deletion", () => {
      const match = tabsSource.match(
        /export async function deleteTab[\s\S]*?^}/m
      );
      expect(match).not.toBeNull();
      const body = match![0];

      // The deletion must include the McpConfig alias
      expect(body).toMatch(/DELETE.*mc/s);
    });
  });
});
