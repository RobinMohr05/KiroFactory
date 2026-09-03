/**
 * Tests for the worker-reported task-create path — when a worker forwards a
 * `"task-create"` action (produced by the create_task MCP tool via
 * worker.js's logSessionUpdate()), session-manager's onWorkerTaskCreate hook
 * must call createTask() with origin "ai", scoped to the session's own tabs,
 * and broadcast a "task-created" event — mirroring
 * agent-error-self-report.test.ts's structure for the sibling self-report path.
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

vi.mock("../db/tasks.js", () => ({
  getTaskAutoMergePrs: vi.fn().mockResolvedValue(false),
  areAllGroupTasksDone: vi.fn().mockResolvedValue(true),
  createTask: vi.fn(),
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

import { createSession, handleWorkerTaskCreate } from "../session-manager.js";
import { createTask } from "../db/tasks.js";
import { broadcastToUser } from "../websocket-handler.js";
import type { CreateSessionInput } from "../types.js";

describe("handleWorkerTaskCreate (worker-reported task-create)", () => {
  let sessionId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    (createTask as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      title: "Hardcoded JWT secret fallback",
      description: "auth.ts falls back to a literal dev secret when JWT_SECRET is unset.",
      type: "bug",
      priority: 1,
      state: "todo",
      files: ["backend/src/routes/auth.ts"],
      origin: "ai",
      tabs: [],
      dependsOn: [],
      blockedBy: [],
    });

    const input: CreateSessionInput = {
      name: "Test Session",
      agent: "code-reviewer-agent",
      prompt: "Original prompt",
      cwd: "/workspace",
      timeoutSeconds: 300,
      model: "claude-sonnet-4",
      interactive: true,
      loop: true,
      runs: 5,
      intervalSeconds: 10,
      userId: 1,
      tabIds: [2],
    };
    const session = await createSession(input);
    sessionId = session.id;
  });

  it("calls createTask with origin 'ai' and the session's own tabIds, then broadcasts task-created", async () => {
    await handleWorkerTaskCreate(sessionId, {
      title: "Hardcoded JWT secret fallback",
      description: "auth.ts falls back to a literal dev secret when JWT_SECRET is unset.",
      type: "bug",
      priority: 1,
      files: ["backend/src/routes/auth.ts"],
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    const arg = (createTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.title).toBe("Hardcoded JWT secret fallback");
    expect(arg.description).toBe("auth.ts falls back to a literal dev secret when JWT_SECRET is unset.");
    expect(arg.type).toBe("bug");
    expect(arg.priority).toBe(1);
    expect(arg.files).toEqual(["backend/src/routes/auth.ts"]);
    expect(arg.origin).toBe("ai");
    expect(arg.tabIds).toEqual([2]);

    expect(broadcastToUser).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "task-created", task: expect.objectContaining({ id: 42 }) })
    );
  });

  it("does not call createTask for an unknown session id", async () => {
    await handleWorkerTaskCreate(999999, {
      title: "orphan task",
      description: "no session",
      type: "bug",
      priority: 1,
      files: [],
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(broadcastToUser).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "task-created" })
    );
  });

  it("does not throw and does not broadcast when createTask rejects", async () => {
    (createTask as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB write failed"));

    await expect(
      handleWorkerTaskCreate(sessionId, {
        title: "t",
        description: "d",
        type: "bug",
        priority: 1,
        files: [],
      })
    ).resolves.toBeUndefined();

    expect(broadcastToUser).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "task-created" })
    );
  });
});
