/**
 * MCP Proxy Config Generator — Per-Session servers.json Builder
 *
 * Generates the servers.json configuration for the MCP proxy sidecar based on
 * session-level and agent-level MCP server configurations.
 *
 * The resulting config is passed to the proxy container as a Base64-encoded
 * environment variable (MCP_SERVERS_JSON_B64), which the proxy decodes at
 * startup and writes to /config/servers.json.
 */

import type { McpServerConfig } from "./types.js";

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
  /** Optional extra MCP servers defined at session level */
  sessionMcpServers?: McpServerConfig[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the servers.json content for a session's MCP proxy sidecar.
 *
 * This merges session-level MCP servers (custom MCP servers defined on the
 * session and/or inherited from the agent) into the proxy format.
 *
 * Returns the ProxyServersConfig (serializable as servers.json), or null
 * if no MCP servers are enabled/available.
 */
export function buildProxyServersConfig(
  options: McpProxyBuildOptions
): ProxyServersConfig | null {
  const { sessionMcpServers } = options;
  const servers: ProxyServersConfig = {};

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
