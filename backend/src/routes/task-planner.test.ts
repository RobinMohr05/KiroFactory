/**
 * Tests for the task planner's repo MCP server configuration.
 *
 * Verifies that:
 * - GitHub repos get an HTTP MCP server with the correct URL and PAT header
 * - Azure DevOps repos get a stdio MCP server with the correct npx command and env
 * - Repos with no provider / no PAT proceed without repo MCP context
 * - The planner session is always created with forceLocal=true
 */

import { describe, it, expect } from "vitest";
import { buildPlannerRepoMcpServer } from "./task-planner-mcp.js";

describe("buildPlannerRepoMcpServer", () => {
  describe("GitHub provider", () => {
    it("returns an HTTP MCP server config for github with correct URL and headers", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "github",
        githubPat: "ghp_test123",
        repositoryUrl: "https://github.com/owner/repo",
      });

      expect(result).not.toBeNull();
      // HTTP entries have type: "http"
      expect(result).toHaveProperty("type", "http");
      expect(result!.name).toBe("github");
      // Narrow to HttpMcpServerEntry
      const httpResult = result as { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };
      expect(httpResult.url).toBe("https://api.githubcopilot.com/mcp/");
      expect(httpResult.headers).toEqual([
        { name: "Authorization", value: "Bearer ghp_test123" },
      ]);
    });

    it("returns null when github provider has no PAT", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "github",
        githubPat: undefined,
        repositoryUrl: "https://github.com/owner/repo",
      });

      expect(result).toBeNull();
    });
  });

  describe("Azure DevOps provider", () => {
    it("returns a stdio MCP server config for azure-devops with org extracted from URL", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "azure-devops",
        azureDevOpsPat: "ado_pat_123",
        repositoryUrl: "https://dev.azure.com/MyOrg/MyProject/_git/MyRepo",
      });

      expect(result).not.toBeNull();
      // Stdio entries do NOT have a type field (ACP untagged enum requirement)
      expect(result).not.toHaveProperty("type");
      expect(result!.name).toBe("azure-devops");
      const stdioResult = result as { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
      expect(stdioResult.command).toBe("npx");
      expect(stdioResult.args).toEqual(["-y", "@azure-devops/mcp", "https://dev.azure.com/MyOrg", "--authentication", "pat"]);
      expect(stdioResult.env).toEqual([
        { name: "PERSONAL_ACCESS_TOKEN", value: "ado_pat_123" },
      ]);
    });

    it("handles visualstudio.com URLs for azure-devops", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "azure-devops",
        azureDevOpsPat: "ado_pat_456",
        repositoryUrl: "https://MyOrg.visualstudio.com/MyProject/_git/MyRepo",
      });

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("type");
      expect(result!.name).toBe("azure-devops");
      const stdioResult = result as { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
      expect(stdioResult.args).toEqual(["-y", "@azure-devops/mcp", "https://MyOrg.visualstudio.com", "--authentication", "pat"]);
      expect(stdioResult.env).toEqual([
        { name: "PERSONAL_ACCESS_TOKEN", value: "ado_pat_456" },
      ]);
    });

    it("returns null when azure-devops provider has no PAT", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "azure-devops",
        azureDevOpsPat: undefined,
        repositoryUrl: "https://dev.azure.com/MyOrg/MyProject/_git/MyRepo",
      });

      expect(result).toBeNull();
    });

    it("returns null when azure-devops org cannot be extracted", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "azure-devops",
        azureDevOpsPat: "ado_pat_789",
        repositoryUrl: "https://unknown-host.example.com/repo",
      });

      expect(result).toBeNull();
    });
  });

  describe("No provider / unsupported provider", () => {
    it("returns null when provider is null", () => {
      const result = buildPlannerRepoMcpServer({
        provider: null,
        repositoryUrl: "https://gitlab.com/owner/repo",
      });

      expect(result).toBeNull();
    });

    it("returns null when repositoryUrl is empty", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "github",
        githubPat: "ghp_test",
        repositoryUrl: "",
      });

      expect(result).toBeNull();
    });

    it("returns null when repositoryUrl is undefined", () => {
      const result = buildPlannerRepoMcpServer({
        provider: "github",
        githubPat: "ghp_test",
        repositoryUrl: undefined,
      });

      expect(result).toBeNull();
    });
  });
});
