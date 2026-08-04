/**
 * Agent Config Writer — Materializes a DB-stored Agent record into the
 * `.kiro/agents/<name>.json` file kiro-cli reads at startup.
 *
 * Background: kiro-cli resolves `--agent <name>` against a file on disk, not
 * against KiroFactory's own `agents` database table. Without this step, a
 * session's DB-configured prompt/tools/resources have no effect at runtime —
 * kiro-cli either finds an unrelated pre-existing file in the target repo, or
 * (previously) a hardcoded fallback. This module bridges that gap.
 *
 * Policy: if the target workspace already ships its own
 * `.kiro/agents/<name>.json` (e.g. a repo-committed agent definition), it is
 * left alone — repo-provided config always wins. Only when no such file
 * exists do we synthesize one from the DB record.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../types.js";

/** Shape of a `.kiro/agents/<name>.json` file as read by kiro-cli. */
export interface AgentConfigFile {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  allowedTools?: string[];
  toolsSettings?: Record<string, unknown>;
  resources?: string[];
}

/** Tools available to a session if the DB agent record has none configured. */
const FALLBACK_TOOLS = ["read", "write", "shell", "grep", "glob", "code"];

/**
 * Build the `.kiro/agents/<name>.json` content for a DB-stored Agent.
 * Optional fields are omitted when empty rather than written as `[]`/`{}`,
 * matching the shape of hand-written agent files elsewhere in this repo.
 */
export function buildAgentConfigFile(agent: Agent): AgentConfigFile {
  const config: AgentConfigFile = {
    name: agent.name,
    description: agent.description || "",
    prompt: agent.prompt || "",
    tools: agent.tools.length > 0 ? agent.tools : FALLBACK_TOOLS,
  };
  if (agent.allowedTools.length > 0) config.allowedTools = agent.allowedTools;
  if (agent.resources.length > 0) config.resources = agent.resources;
  if (agent.toolsSettings && Object.keys(agent.toolsSettings).length > 0) {
    config.toolsSettings = agent.toolsSettings;
  }
  return config;
}

/**
 * Serialize an Agent's config as a Base64 JSON string, for injection into a
 * worker container as an environment variable (mirrors the MCP proxy's
 * MCP_SERVERS_JSON_B64 pattern).
 */
export function encodeAgentConfigBase64(agent: Agent): string {
  return Buffer.from(JSON.stringify(buildAgentConfigFile(agent), null, 2), "utf-8").toString("base64");
}

/**
 * Write `.kiro/agents/<agent.name>.json` into `workspaceDir` if (and only if)
 * no such file already exists there. Returns true if a file was written.
 *
 * Used by local (non-ACA) session mode, where the workspace directory is
 * directly accessible on the same filesystem as the orchestrator.
 */
export function materializeAgentConfigIfMissing(agent: Agent, workspaceDir: string): boolean {
  const agentsDir = join(workspaceDir, ".kiro", "agents");
  const agentFile = join(agentsDir, `${agent.name}.json`);

  if (existsSync(agentFile)) {
    return false; // Repo-provided config takes precedence — leave it alone.
  }

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(agentFile, JSON.stringify(buildAgentConfigFile(agent), null, 2), "utf-8");
  return true;
}
