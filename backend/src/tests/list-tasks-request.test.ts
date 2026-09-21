/**
 * Tests for the worker-reported list-tasks path — when an inspector-kind
 * worker (that can create tasks) forwards a `"list-tasks-request"` action
 * (produced by the list_tasks MCP tool over the worker's IPC socket, relayed
 * by worker.js over the orchestrator WebSocket), session-manager's
 * onWorkerListTasksRequest hook must:
 *   - resolve the tab the same way task creation does (taskCreationTabId ??
 *     tabIds[0]),
 *   - call getAllTasks() scoped to that tab + the session's user,
 *   - send a correlated `list-tasks-response` back to that worker with the
 *     { id, title, type, priority, state } shape.
 *
 * Mirrors task-create-self-report.test.ts's structure for the sibling
 * self-report path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getAllTasks: vi.fn(),
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
  sendWorkerListTasksResponse: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
}));

import { createSession, handleWorkerListTasksRequest } from "../session-manager.js";
import { getAllTasks } from "../db/tasks.js";
import { sendWorkerListTasksResponse } from "../worker-ws-handler.js";
import type { CreateSessionInput } from "../types.js";

const TASKS = [
  { id: 10, title: "Fix the thing", type: "bug", priority: 1, state: "todo", description: "d", files: [], origin: "ai", tabs: [], dependsOn: [], blockedBy: [] },
  { id: 11, title: "Add a feature", type: "feature", priority: 3, state: "developed", description: "d", files: [], origin: "ai", tabs: [], dependsOn: [], blockedBy: [] },
];

async function makeSession(overrides: Partial<CreateSessionInput> = {}): Promise<number> {
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
    ...overrides,
  };
  const session = await createSession(input);
  return session.id;
}

describe("handleWorkerListTasksRequest (worker-reported list-tasks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAllTasks as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(TASKS);
  });

  it("calls getAllTasks scoped to tabIds[0] and the session user, then responds with the trimmed shape", async () => {
    const sessionId = await makeSession({ tabIds: [2] });

    await handleWorkerListTasksRequest(sessionId, "lt-1");

    expect(getAllTasks).toHaveBeenCalledTimes(1);
    expect(getAllTasks).toHaveBeenCalledWith({ tabId: 2, userId: 1 });

    expect(sendWorkerListTasksResponse).toHaveBeenCalledTimes(1);
    const [sid, reqId, payload] = (sendWorkerListTasksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sid).toBe(sessionId);
    expect(reqId).toBe("lt-1");
    expect(payload).toEqual({
      tasks: [
        { id: 10, title: "Fix the thing", type: "bug", priority: 1, state: "todo" },
        { id: 11, title: "Add a feature", type: "feature", priority: 3, state: "developed" },
      ],
    });
  });

  it("prefers taskCreationTabId over tabIds[0] when set", async () => {
    const sessionId = await makeSession({
      tabIds: [2, 5],
      createTasksEnabled: true,
      taskCreationTabId: 5,
    });

    await handleWorkerListTasksRequest(sessionId, "lt-2");

    expect(getAllTasks).toHaveBeenCalledWith({ tabId: 5, userId: 1 });
  });

  it("does nothing for an unknown session id", async () => {
    await handleWorkerListTasksRequest(999999, "lt-3");
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(sendWorkerListTasksResponse).not.toHaveBeenCalled();
  });

  it("responds with an error payload when getAllTasks rejects", async () => {
    (getAllTasks as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB read failed"));
    const sessionId = await makeSession({ tabIds: [2] });

    await handleWorkerListTasksRequest(sessionId, "lt-4");

    expect(sendWorkerListTasksResponse).toHaveBeenCalledTimes(1);
    const [, , payload] = (sendWorkerListTasksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.error).toContain("DB read failed");
    expect(payload.tasks).toBeUndefined();
  });
});
