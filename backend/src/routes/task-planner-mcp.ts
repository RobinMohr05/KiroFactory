/**
 * Task Planner MCP Config — Builds MCP server entries for repo access.
 *
 * Instead of cloning the repository, the planner's kiro-cli session gets an
 * MCP server that provides file-browsing tools over the remote repo:
 *
 * - GitHub: HTTP MCP server at https://api.githubcopilot.com/mcp/
 * - Azure DevOps: stdio MCP server via @azure-devops/mcp
 */

import type { GitProvider } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerMcpInput {
  provider: GitProvider | null | undefined;
  repositoryUrl: string | null | undefined;
  githubPat?: string;
  azureDevOpsPat?: string;
}

/**
 * An HTTP-type MCP server entry for use in the ACP session/new mcpServers array.
 * Matches the ACP schema's `McpServerHttp & { type: "http" }`.
 * The `type: "http"` discriminant is REQUIRED by the ACP schema union.
 */
export interface HttpMcpServerEntry {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

/**
 * A stdio-type MCP server entry for use in the ACP session/new mcpServers array.
 * Matches the ACP schema's `McpServerStdio`. Note: NO `type` discriminant —
 * kiro-cli's ACP schema uses an untagged enum for McpServer, and the stdio
 * variant is matched by structure (has command/args/env/name, no type field).
 * Including an extra `type` property would cause the match to FAIL silently.
 */
export interface StdioMcpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export type PlannerMcpServerEntry = HttpMcpServerEntry | StdioMcpServerEntry;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Azure DevOps organization URL from a repository URL.
 *
 * Supports both formats:
 * - https://dev.azure.com/OrgName/Project/_git/Repo → https://dev.azure.com/OrgName
 * - https://OrgName.visualstudio.com/Project/_git/Repo → https://OrgName.visualstudio.com
 *
 * Returns null if the URL doesn't match either pattern.
 */
function extractAzureDevOpsOrgUrl(repositoryUrl: string): string | null {
  // dev.azure.com format
  const devAzureMatch = repositoryUrl.match(
    /^(https:\/\/dev\.azure\.com\/[^/]+)/
  );
  if (devAzureMatch) {
    return devAzureMatch[1];
  }

  // visualstudio.com format
  const vsMatch = repositoryUrl.match(
    /^(https:\/\/[^/]+\.visualstudio\.com)/
  );
  if (vsMatch) {
    return vsMatch[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an MCP server entry for the planner's repo access.
 *
 * Returns null if:
 * - No provider could be resolved
 * - No repository URL is available
 * - No credential (PAT) is available for the resolved provider
 * - Azure DevOps org URL cannot be extracted
 *
 * The caller should gracefully proceed without repo MCP context when null is returned.
 */
export function buildPlannerRepoMcpServer(
  input: PlannerMcpInput
): PlannerMcpServerEntry | null {
  const { provider, repositoryUrl, githubPat, azureDevOpsPat } = input;

  if (!repositoryUrl || !provider) {
    return null;
  }

  if (provider === "github") {
    if (!githubPat) return null;

    return {
      type: "http",
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: [
        { name: "Authorization", value: `Bearer ${githubPat}` },
      ],
    };
  }

  if (provider === "azure-devops") {
    if (!azureDevOpsPat) return null;

    const orgUrl = extractAzureDevOpsOrgUrl(repositoryUrl);
    if (!orgUrl) return null;

    return {
      name: "azure-devops",
      command: "npx",
      args: ["-y", "@azure-devops/mcp", orgUrl, "--authentication", "pat"],
      env: [
        { name: "PERSONAL_ACCESS_TOKEN", value: azureDevOpsPat },
      ],
    };
  }

  return null;
}
