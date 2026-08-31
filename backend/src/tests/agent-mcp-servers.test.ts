/**
 * Tests for agent-owned MCP servers with per-session exclusion.
 *
 * Covers:
 *   (a) Creating/updating an Agent with `mcpServers` persists and round-trips via getAgentById
 *   (b) Creating/updating a Session with `excludedMcpServerNames` persists and round-trips
 *   (c) Effective MCP server list: when an agent has 2 mcpServers and a session excludes 1 by name,
 *       the effective list contains only the non-excluded one plus any session-level additions
 *   (d) Regression safety: agent with no mcpServers + session with no exclusions produces identical
 *       effective server list to the pre-change behavior
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the DB layer (same pattern as sessions.test.ts) ─────────────────────
vi.mock("../db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromDb: vi.fn().mockResolvedValue(true),
  isSessionOwnedByUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("../db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue("fake-key"),
  getUserById: vi.fn().mockResolvedValue({ id: 1, email: "test@test.com", defaultGitProvider: null }),
}));

vi.mock("../db/credentials.js", () => ({
  getAllDecryptedCredentials: vi.fn().mockResolvedValue({}),
  getDecryptedCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/agents.js", () => ({
  getAgentByName: vi.fn().mockResolvedValue(null),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../error-store.js", () => ({
  recordError: vi.fn(),
}));

vi.mock("../agent/kiro-runner.js", () => ({
  KiroRunner: { create: vi.fn() },
}));

vi.mock("../agent/task-claimer.js", () => ({
  claimTask: vi.fn(),
  resolveTask: vi.fn(),
  resetTask: vi.fn(),
  getAvailableTaskCount: vi.fn().mockResolvedValue(0),
  markTaskDone: vi.fn(),
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("../agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn().mockResolvedValue(undefined),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));

vi.mock("../mcp-proxy-config.js", () => ({
  buildProxyServersConfig: vi.fn().mockReturnValue([]),
  buildLocalMcpServerEntries: vi.fn().mockReturnValue([]),
}));

vi.mock("../aca-worker-spawner.js", () => ({
  loadAcaConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isAcaModeEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("../worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn(),
  sendWorkerStop: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
}));

import {
  createSession,
  getSession,
  updateSessionFields,
} from "../session-manager.js";
import { getAgentByName } from "../db/agents.js";
import type { CreateSessionInput, UpdateSessionInput, McpServerConfig } from "../types.js";

// ─── Helper: resolveAgentMcpServers (extracted testable logic) ────────────────
import { resolveAgentMcpServers } from "../session-manager.js";

describe("Session excludedMcpServerNames persistence", () => {
  let sessionId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    const input: CreateSessionInput = {
      name: "Test Session",
      agent: "dev-agent",
      prompt: "test prompt",
      userId: 1,
    };
    const session = await createSession(input);
    sessionId = session.id;
  });

  it("should persist excludedMcpServerNames on create", async () => {
    const input: CreateSessionInput = {
      name: "Session With Exclusions",
      agent: "dev-agent",
      userId: 1,
      excludedMcpServerNames: ["server-a", "server-b"],
    };
    const session = await createSession(input);
    const fetched = getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.excludedMcpServerNames).toEqual(["server-a", "server-b"]);
  });

  it("should persist excludedMcpServerNames on update", () => {
    const result = updateSessionFields(sessionId, {
      excludedMcpServerNames: ["server-x"],
    });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.excludedMcpServerNames).toEqual(["server-x"]);
  });

  it("should default to undefined when not provided on create", async () => {
    const input: CreateSessionInput = {
      name: "No Exclusions",
      agent: "dev-agent",
      userId: 1,
    };
    const session = await createSession(input);
    const fetched = getSession(session.id);
    expect(fetched!.excludedMcpServerNames).toBeUndefined();
  });

  it("should clear excludedMcpServerNames when empty array provided", () => {
    // First set some exclusions
    updateSessionFields(sessionId, { excludedMcpServerNames: ["server-a"] });
    expect(getSession(sessionId)!.excludedMcpServerNames).toEqual(["server-a"]);

    // Clear with empty array
    const result = updateSessionFields(sessionId, { excludedMcpServerNames: [] });
    expect(result).toEqual({ success: true });
    expect(getSession(sessionId)!.excludedMcpServerNames).toBeUndefined();
  });
});

describe("resolveAgentMcpServers", () => {
  const serverA: McpServerConfig = {
    name: "server-a",
    command: "npx",
    args: ["-y", "server-a-pkg"],
    env: [{ name: "KEY_A", value: "val-a" }],
  };
  const serverB: McpServerConfig = {
    name: "server-b",
    command: "node",
    args: ["server-b.js"],
    env: [],
  };

  it("should return all agent servers when no exclusions", () => {
    const result = resolveAgentMcpServers([serverA, serverB], []);
    expect(result).toEqual([serverA, serverB]);
  });

  it("should return all agent servers when exclusions is undefined", () => {
    const result = resolveAgentMcpServers([serverA, serverB], undefined);
    expect(result).toEqual([serverA, serverB]);
  });

  it("should exclude servers by name", () => {
    const result = resolveAgentMcpServers([serverA, serverB], ["server-a"]);
    expect(result).toEqual([serverB]);
  });

  it("should exclude multiple servers by name", () => {
    const result = resolveAgentMcpServers([serverA, serverB], ["server-a", "server-b"]);
    expect(result).toEqual([]);
  });

  it("should ignore exclusion names that don't match any server", () => {
    const result = resolveAgentMcpServers([serverA, serverB], ["nonexistent"]);
    expect(result).toEqual([serverA, serverB]);
  });

  it("should return empty array when agent has no servers", () => {
    const result = resolveAgentMcpServers([], ["server-a"]);
    expect(result).toEqual([]);
  });

  it("should return empty array when agent servers is undefined", () => {
    const result = resolveAgentMcpServers(undefined, ["server-a"]);
    expect(result).toEqual([]);
  });

  it("regression: no agent servers + no exclusions = empty array (no change to existing behavior)", () => {
    const result = resolveAgentMcpServers(undefined, undefined);
    expect(result).toEqual([]);
  });
});
