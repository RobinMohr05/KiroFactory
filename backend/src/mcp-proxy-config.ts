/**
 * MCP Proxy Config Generator — Per-Session servers.json Builder
 *
 * Generates the servers.json configuration for the MCP proxy sidecar based on:
 * 1. Tab-level MCP toggles (atlassian, azureDevops, awsApi, awsDocs)
 * 2. Per-user encrypted credentials (decrypted at runtime)
 * 3. Optional session-level MCP server overrides
 *
 * The resulting config is passed to the proxy container as a Base64-encoded
 * environment variable (MCP_SERVERS_JSON_B64), which the proxy decodes at
 * startup and writes to /config/servers.json.
 */

import type { TabMcpConfig, McpServerConfig } from "./types.js";
import type { CredentialKey } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Server definition in the proxy's servers.json format */
export interface ProxyServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Map of server name → server entry for the proxy */
export type ProxyServersConfig = Record<string, ProxyServerEntry>;

/** Credentials resolved for a session (decrypted, ready to inject) */
export interface SessionCredentials {
  azureDevOpsPat?: string;
  atlassianApiToken?: string;
  atlassianUsername?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

/** Options for building the proxy config */
export interface McpProxyBuildOptions {
  /** MCP toggle config from the session's tab */
  mcpConfig: TabMcpConfig;
  /** Decrypted credentials for the session's owning user */
  credentials: SessionCredentials;
  /** Optional extra MCP servers defined at session level */
  sessionMcpServers?: McpServerConfig[];
}

// ---------------------------------------------------------------------------
// MCP Server Definitions
// ---------------------------------------------------------------------------

/**
 * Build the Atlassian MCP server entry.
 * Uses the npx-based @anthropic/atlassian-mcp-server.
 */
function buildAtlassianServer(creds: SessionCredentials): ProxyServerEntry | null {
  if (!creds.atlassianApiToken || !creds.atlassianUsername) {
    return null;
  }

  return {
    command: "npx",
    args: ["-y", "@anthropic/atlassian-mcp-server"],
    env: {
      ATLASSIAN_API_TOKEN: creds.atlassianApiToken,
      ATLASSIAN_USERNAME: creds.atlassianUsername,
    },
  };
}

/**
 * Build the Azure DevOps MCP server entry.
 * Uses uvx-based azure-devops-mcp.
 */
function buildAzureDevopsServer(creds: SessionCredentials): ProxyServerEntry | null {
  if (!creds.azureDevOpsPat) {
    return null;
  }

  return {
    command: "uvx",
    args: ["azure-devops-mcp"],
    env: {
      AZURE_DEVOPS_EXT_PAT: creds.azureDevOpsPat,
    },
  };
}

/**
 * Build the AWS API MCP server entry (for live AWS interactions).
 * Uses the npx-based @anthropic/aws-mcp-server.
 */
function buildAwsApiServer(creds: SessionCredentials): ProxyServerEntry | null {
  if (!creds.awsAccessKeyId || !creds.awsSecretAccessKey) {
    return null;
  }

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

/**
 * Build the AWS Documentation MCP server entry (read-only docs).
 * Uses the npx-based @anthropic/aws-docs-mcp-server.
 * Does not require credentials.
 */
function buildAwsDocsServer(): ProxyServerEntry {
  return {
    command: "npx",
    args: ["-y", "@anthropic/aws-docs-mcp-server"],
    env: {},
  };
}

// ---------------------------------------------------------------------------
// Local (non-sidecar) server entries
// ---------------------------------------------------------------------------

/**
 * Shape expected by `KiroRunner.create()`'s `mcpServers` option
 * (`backend/src/agent/kiro-runner.ts`'s `McpServerEntry`). Duplicated here
 * (rather than imported) to avoid a dependency from this module onto
 * kiro-runner.ts — the two shapes are structurally identical by design.
 */
export interface LocalMcpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

function toLocalEntry(name: string, entry: ProxyServerEntry): LocalMcpServerEntry {
  return {
    name,
    command: entry.command,
    args: entry.args,
    env: Object.entries(entry.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
  };
}

/**
 * Resolve tab-level MCP toggles + credentials into a flat list of stdio MCP
 * server entries suitable for direct injection into `KiroRunner.create()`.
 *
 * This is the local-session counterpart to `buildProxyServersConfig()`: it
 * reuses the exact same per-server builders (so toggle/credential behavior
 * stays identical between hosted and local sessions), but skips the
 * proxy-sidecar/servers.json/Base64-env packaging entirely — a local
 * session's `KiroRunner` already spawns `kiro-cli` as a direct child
 * process on the same host, so it can spawn each MCP server the same way
 * (as its own stdio subprocess) without an intermediary container.
 *
 * Session-level overrides (`sessionMcpServers`) are intentionally NOT
 * merged here — callers already have a separate path for those (passed
 * directly to `KiroRunner.create()`'s `mcpServers` from `meta.mcpServers`).
 * Keeping this function toggle-only mirrors `buildProxyServersConfig`'s
 * inputs 1:1 for the parts that differ between hosted/local, and avoids
 * this function silently duplicating entries the caller already has.
 */
export function buildLocalMcpServerEntries(
  mcpConfig: TabMcpConfig,
  credentials: SessionCredentials
): LocalMcpServerEntry[] {
  const entries: LocalMcpServerEntry[] = [];

  if (mcpConfig.atlassian) {
    const entry = buildAtlassianServer(credentials);
    if (entry) entries.push(toLocalEntry("atlassian", entry));
  }

  if (mcpConfig.azureDevops) {
    const entry = buildAzureDevopsServer(credentials);
    if (entry) entries.push(toLocalEntry("azure-devops", entry));
  }

  if (mcpConfig.awsApi) {
    const entry = buildAwsApiServer(credentials);
    if (entry) entries.push(toLocalEntry("aws-api", entry));
  }

  if (mcpConfig.awsDocs) {
    entries.push(toLocalEntry("aws-docs", buildAwsDocsServer()));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the servers.json content for a session's MCP proxy sidecar.
 *
 * This merges:
 * - Tab-level MCP toggles (which servers are enabled)
 * - User credentials (injected per server as environment variables)
 * - Session-level overrides (custom MCP servers defined on the session)
 *
 * Returns the ProxyServersConfig (serializable as servers.json), or null
 * if no MCP servers are enabled/available.
 */
export function buildProxyServersConfig(
  options: McpProxyBuildOptions
): ProxyServersConfig | null {
  const { mcpConfig, credentials, sessionMcpServers } = options;
  const servers: ProxyServersConfig = {};

  // Add Atlassian server if enabled on tab and credentials available
  if (mcpConfig.atlassian) {
    const entry = buildAtlassianServer(credentials);
    if (entry) {
      servers["atlassian"] = entry;
    }
  }

  // Add Azure DevOps server if enabled on tab and credentials available
  if (mcpConfig.azureDevops) {
    const entry = buildAzureDevopsServer(credentials);
    if (entry) {
      servers["azure-devops"] = entry;
    }
  }

  // Add AWS API server if enabled on tab and credentials available
  if (mcpConfig.awsApi) {
    const entry = buildAwsApiServer(credentials);
    if (entry) {
      servers["aws-api"] = entry;
    }
  }

  // Add AWS Docs server if enabled (no credentials needed)
  if (mcpConfig.awsDocs) {
    servers["aws-docs"] = buildAwsDocsServer();
  }

  // Add session-level custom MCP servers (overrides/additions)
  if (sessionMcpServers && sessionMcpServers.length > 0) {
    for (const server of sessionMcpServers) {
      const envMap: Record<string, string> = {};
      if (server.env) {
        for (const { name, value } of server.env) {
          envMap[name] = value;
        }
      }
      servers[server.name] = {
        command: server.command,
        args: server.args || [],
        env: envMap,
      };
    }
  }

  // Return null if no servers configured (no need for a proxy sidecar)
  if (Object.keys(servers).length === 0) {
    return null;
  }

  return servers;
}

/**
 * Encode the servers config as a Base64 string for injection as an environment variable.
 * The proxy container decodes this at startup and writes to /config/servers.json.
 */
export function encodeServersConfigBase64(config: ProxyServersConfig): string {
  const json = JSON.stringify(config, null, 2);
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Extract the credential environment variables needed for the proxy sidecar.
 * Returns a flat array of { name, value } pairs suitable for ACA container env vars.
 *
 * These are injected into the proxy container so spawned MCP servers inherit them.
 * However, the primary mechanism is via servers.json per-server env — this is a
 * fallback for servers that read credentials from the process environment directly.
 */
export function buildProxyCredentialEnvVars(
  credentials: SessionCredentials
): Array<{ name: string; value: string }> {
  const envVars: Array<{ name: string; value: string }> = [];

  if (credentials.atlassianApiToken) {
    envVars.push({ name: "ATLASSIAN_API_TOKEN", value: credentials.atlassianApiToken });
  }
  if (credentials.atlassianUsername) {
    envVars.push({ name: "ATLASSIAN_USERNAME", value: credentials.atlassianUsername });
  }
  if (credentials.azureDevOpsPat) {
    envVars.push({ name: "AZURE_DEVOPS_EXT_PAT", value: credentials.azureDevOpsPat });
  }
  if (credentials.awsAccessKeyId) {
    envVars.push({ name: "AWS_ACCESS_KEY_ID", value: credentials.awsAccessKeyId });
  }
  if (credentials.awsSecretAccessKey) {
    envVars.push({ name: "AWS_SECRET_ACCESS_KEY", value: credentials.awsSecretAccessKey });
  }

  return envVars;
}
