/**
 * Tests for the self-reported agent-error path — when a worker forwards an
 * `"agent-error"` action (produced by the report_agent_error MCP tool via
 * worker.js's logSessionUpdate()), session-manager's onWorkerAgentError hook
 * must record exactly one error with source "self-reported", carrying the
 * message/context through and enriching it with the session's own context
 * (sessionName, agent, userId, taskId/taskTitle) — the same context the
 * automatic recordError call site gathers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB / broadcast / spawner layers so createSession() works in isolation.
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
  isDbAvailable: vi.fn().mockReturnValue(false),
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

vi.mock("../db/error-events.js", () => ({
  createErrorEvent: vi.fn().mockResolvedValue(undefined),
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

import { createSession, handleWorkerAgentError } from "../session-manager.js";
import { recordError } from "../error-store.js";
import type { CreateSessionInput } from "../types.js";

describe("handleWorkerAgentError (self-reported errors)", () => {
  let sessionId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    const input: CreateSessionInput = {
      name: "Test Session",
      agent: "developer-agent",
      prompt: "Original prompt",
      cwd: "/workspace",
      timeoutSeconds: 300,
      model: "claude-sonnet-4",
      interactive: true,
      loop: true,
      runs: 5,
      intervalSeconds: 10,
      userId: 1,
    };
    const session = await createSession(input);
    sessionId = session.id;
  });

  it("records exactly one error with source 'self-reported' and passes message/context through", () => {
    handleWorkerAgentError(
      sessionId,
      "The atlassian MCP server failed to initialize",
      "MCP config issue: the atlassian server failed to initialize"
    );

    expect(recordError).toHaveBeenCalledTimes(1);
    const arg = (recordError as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.source).toBe("self-reported");
    expect(arg.message).toBe("The atlassian MCP server failed to initialize");
    expect(arg.context).toBe("MCP config issue: the atlassian server failed to initialize");
    // Session context is carried through
    expect(arg.sessionId).toBe(sessionId);
    expect(arg.sessionName).toBe("Test Session");
    expect(arg.agent).toBe("developer-agent");
    expect(arg.userId).toBe(1);
  });

  it("does not record anything for an unknown session id", () => {
    handleWorkerAgentError(999999, "orphan error", "no session");
    expect(recordError).not.toHaveBeenCalled();
  });
});
