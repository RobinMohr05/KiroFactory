/**
 * Tests for multi-task batch creation in the Task Planner create-task route.
 *
 * Mounts the actual task-planner router with vi.mock'd dependencies, so the
 * tests exercise the real handler code (validation, topo-sort, dependency
 * resolution, partial failure, session cleanup) rather than a hand-written copy.
 *
 * Covers:
 * 1. Backward compat: single task object body still works
 * 2. Batch body { tasks: [...] } creates multiple tasks
 * 3. Validation: rejects batch if any item missing required fields
 * 4. Dependency resolution: dependsOnBatchIndex resolves to real IDs
 * 5. Cycle detection: cyclic dependsOnBatchIndex within batch fails
 * 6. groupId pass-through: items sharing groupId get the same value
 * 7. Partial failure: some tasks fail, others succeed, response includes both
 * 8. Partial failure: records AgentError via recordError()
 * 9. Partial failure: session NOT cleaned up (left open)
 * 10. Full success: session cleaned up
 * 11. Input validation: non-array dependsOnBatchIndex rejected with 400
 * 12. Performance: getAllTabs queried once per request, not per batch item
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — same dependency-mocking pattern as task-planner-image.test.ts.
// These must come before any import that transitively reaches the mocked modules.
// ---------------------------------------------------------------------------

vi.mock("../db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromDb: vi.fn().mockResolvedValue(true),
  isSessionOwnedByUser: vi.fn().mockResolvedValue(true),
  reorderSessionsInDb: vi.fn().mockResolvedValue(undefined),
  updateSessionPinInDb: vi.fn().mockResolvedValue(undefined),
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

const mockGetAllTabs = vi.fn();
vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
  getAllTabs: (...args: unknown[]) => mockGetAllTabs(...args),
}));

vi.mock("../db/agents.js", () => ({
  getAgentByName: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/turns.js", () => ({
  createTurn: vi.fn().mockResolvedValue({ number: 1, sessionId: 1, startedAt: "2026-08-31T10:00:00.000Z" }),
  completeTurn: vi.fn().mockResolvedValue(null),
  createErrorEvent: vi.fn().mockResolvedValue(null),
  getMaxTurnNumber: vi.fn().mockResolvedValue(0),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

const mockRecordError = vi.fn();
vi.mock("../error-store.js", () => ({
  recordError: (...args: unknown[]) => mockRecordError(...args),
}));

vi.mock("../agent/kiro-runner.js", () => ({
  KiroRunner: { create: vi.fn() },
}));

vi.mock("../agent/task-claimer.js", () => ({
  claimTask: vi.fn(),
  resolveTask: vi.fn(),
  resetTask: vi.fn(),
  getAvailableTaskCount: vi.fn().mockResolvedValue(0),
  waitForTaskAvailable: vi.fn(),
  markTaskDone: vi.fn(),
  notifyTaskAvailable: vi.fn(),
  resetOrphanedTasks: vi.fn().mockResolvedValue(0),
  findSiblingTasks: vi.fn().mockResolvedValue([]),
  findSiblingTasksByGroupId: vi.fn().mockResolvedValue([]),
  describeClaimFailure: vi.fn().mockReturnValue("claim failed"),
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("../agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn().mockReturnValue(false),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));

vi.mock("../agent/repo-url-parser.js", () => ({
  buildPersistentBranchName: vi.fn().mockReturnValue("persistent-branch"),
  buildTaskBranchName: vi.fn().mockReturnValue("task-branch"),
}));

vi.mock("../mcp-proxy-config.js", () => ({
  buildProxyServersConfig: vi.fn().mockReturnValue(null),
}));

vi.mock("../aca-worker-spawner.js", () => ({
  loadAcaConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isAcaModeEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("../wsl-worker-spawner.js", () => ({
  loadWslConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isWslModeEnabled: vi.fn().mockReturnValue(false),
  captureContainerLogs: vi.fn(),
}));

vi.mock("../worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn(),
  sendWorkerStop: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
  connectToLocalWorker: vi.fn(),
}));

const mockCreateTask = vi.fn();
vi.mock("../db/tasks.js", () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  getTaskAutoMergePrs: vi.fn().mockResolvedValue(false),
  areAllGroupTasksDone: vi.fn().mockResolvedValue(false),
}));

// Mock auth middleware so requests pass through without a JWT
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  getUserId: () => 1,
}));

// ---------------------------------------------------------------------------
// Import the actual router AFTER mocks are set up
// ---------------------------------------------------------------------------

import { createSession, getSession, stopSession, deleteSession } from "../session-manager.js";
import { broadcastToUser } from "../websocket-handler.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import taskPlannerRouter from "../routes/task-planner.js";

// Typed access to mocked functions
const mockBroadcastToUser = vi.mocked(broadcastToUser);
const mockNotifyTaskAvailable = vi.mocked(notifyTaskAvailable);

/**
 * Build a test Express app that mounts the real task-planner router.
 */
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/task-planner", taskPlannerRouter);
  return app;
}

describe("Task Planner batch create-task route", () => {
  let app: express.Express;
  let taskIdCounter: number;
  let mockStopSession: ReturnType<typeof vi.spyOn>;
  let mockDeleteSession: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    taskIdCounter = 100;

    mockGetAllTabs.mockResolvedValue([{ id: 2, name: "VCH" }]);
    mockCreateTask.mockImplementation(async (input: Record<string, unknown>) => {
      const id = taskIdCounter++;
      return { id, ...input, state: "todo", createdAt: new Date().toISOString() };
    });

    // Create a planner session in the in-memory session store so the route
    // can find it via getSession(). The session must have userId matching
    // our mocked getUserId (1).
    const session = await createSession({
      name: "Task Planner",
      prompt: "system prompt",
      interactive: true,
      loop: false,
      runs: 0,
      intervalSeconds: 0,
      userId: 1,
    });
    // Verify session was created
    const s = getSession(session.id);
    if (!s) throw new Error("Session not created — test setup bug");

    // Spy on stopSession / deleteSession after session creation so we can
    // assert they're called during the request (not during setup).
    mockStopSession = vi.spyOn(await import("../session-manager.js"), "stopSession");
    mockDeleteSession = vi.spyOn(await import("../session-manager.js"), "deleteSession");

    // Clear mock call counts that accumulated during session creation
    // (e.g. broadcastToUser is called by createSession).
    mockBroadcastToUser.mockClear();
    mockNotifyTaskAvailable.mockClear();
    mockRecordError.mockClear();

    app = buildTestApp();
  });

  // Helper: POST to the batch create endpoint using session ID 1
  function postCreateTask(body: Record<string, unknown>) {
    return request(app)
      .post("/api/task-planner/1/create-task")
      .send(body)
      .set("Content-Type", "application/json");
  }

  // ---- Backward compatibility ----

  it("creates a single task from a plain object body (backward compat)", async () => {
    const res = await postCreateTask({
      title: "Fix login bug",
      description: "The login page crashes on empty email",
      priority: 2,
      type: "bug",
      files: ["src/auth.ts"],
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(0);
    expect(res.body.created[0].title).toBe("Fix login bug");
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  // ---- Batch creation ----

  it("creates multiple independent tasks from a batch body", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature" },
        { title: "Task B", priority: 3, type: "improvement" },
        { title: "Task C", priority: 1, type: "bug" },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(3);
    expect(res.body.failed).toHaveLength(0);
    expect(mockCreateTask).toHaveBeenCalledTimes(3);
  });

  // ---- Validation ----

  it("rejects entire batch if any item is missing required fields", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Valid task", priority: 2, type: "feature" },
        { title: "Missing priority", type: "bug" }, // missing priority
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("index 1");
    expect(res.body.error).toContain("missing required fields");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  // ---- Dependency resolution ----

  it("resolves dependsOnBatchIndex to real task IDs", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Base task", priority: 2, type: "feature" },
        { title: "Dependent task", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);

    // The second createTask call should have dependsOn with the first task's ID
    const secondCall = mockCreateTask.mock.calls[1][0];
    expect(secondCall.dependsOn).toEqual([100]); // first task got id 100
  });

  // ---- Cycle detection ----

  it("rejects batch with cyclic dependsOnBatchIndex", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: [1] },
        { title: "Task B", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cycle detected");
  });

  // ---- groupId pass-through ----

  it("passes groupId through to createTask for items sharing the same groupId", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature", groupId: "batch-x" },
        { title: "Task B", priority: 3, type: "improvement" },
        { title: "Task C", priority: 2, type: "feature", groupId: "batch-x" },
      ],
    });

    expect(res.status).toBe(201);
    const calls = mockCreateTask.mock.calls;
    // Tasks A and C should have the same groupId
    expect(calls[0][0].groupId).toBe("batch-x");
    expect(calls[1][0].groupId).toBeNull();
    expect(calls[2][0].groupId).toBe("batch-x");
  });

  // ---- Partial failure ----

  it("returns partial success when one task in the batch fails", async () => {
    let callCount = 0;
    mockCreateTask.mockImplementation(async (input: Record<string, unknown>) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("DB connection lost");
      }
      return { id: taskIdCounter++, ...input, state: "todo", createdAt: new Date().toISOString() };
    });

    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature" },
        { title: "Task B", priority: 3, type: "bug" },
        { title: "Task C", priority: 1, type: "improvement" },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].task.title).toBe("Task B");
    expect(res.body.failed[0].error).toBe("DB connection lost");
  });

  it("records AgentError via recordError() on partial failure", async () => {
    mockCreateTask.mockImplementationOnce(async (input: Record<string, unknown>) => {
      return { id: 100, ...input, state: "todo" };
    });
    mockCreateTask.mockImplementationOnce(async () => {
      throw new Error("Constraint violation");
    });

    await postCreateTask({
      tasks: [
        { title: "Task OK", priority: 2, type: "feature" },
        { title: "Task Fail", priority: 3, type: "bug" },
      ],
    });

    expect(mockRecordError).toHaveBeenCalledTimes(1);
    expect(mockRecordError.mock.calls[0][0]).toMatchObject({
      sessionId: 1,
      agent: "task-planner",
      message: "Constraint violation",
      taskTitle: "Task Fail",
    });
  });

  it("does NOT clean up the session on partial failure", async () => {
    mockCreateTask.mockImplementationOnce(async (input: Record<string, unknown>) => {
      return { id: 100, ...input, state: "todo" };
    });
    mockCreateTask.mockImplementationOnce(async () => {
      throw new Error("DB error");
    });

    await postCreateTask({
      tasks: [
        { title: "Task OK", priority: 2, type: "feature" },
        { title: "Task Fail", priority: 3, type: "bug" },
      ],
    });

    expect(mockStopSession).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("cleans up the session on full success", async () => {
    await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature" },
      ],
    });

    expect(mockStopSession).toHaveBeenCalledWith(1);
    expect(mockDeleteSession).toHaveBeenCalledWith(1);
  });

  // ---- Session not found ----

  it("returns 404 when session is not found", async () => {
    const res = await request(app)
      .post("/api/task-planner/999/create-task")
      .send({ title: "Test", priority: 2, type: "feature" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(404);
  });

  // ---- Invalid dependsOnBatchIndex ----

  it("rejects self-referential dependsOnBatchIndex", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid dependsOnBatchIndex");
  });

  it("rejects out-of-range dependsOnBatchIndex", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: [5] },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid dependsOnBatchIndex");
  });

  it("rejects non-array dependsOnBatchIndex with 400", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: 42 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be an array");
  });

  // ---- Empty batch rejection ----

  it("rejects an empty batch with 400 and does not destroy the session", async () => {
    const res = await postCreateTask({ tasks: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("At least one task is required");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(mockStopSession).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  // ---- broadcasts for each successful task ----

  it("broadcasts task-created and notifyTaskAvailable for each successful task", async () => {
    await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature" },
        { title: "Task B", priority: 3, type: "improvement" },
      ],
    });

    // broadcastToUser may be called extra times by session cleanup (e.g.
    // stopSession sets status which broadcasts a session-updated event).
    // Check specifically for the task-created broadcasts.
    const taskCreatedCalls = mockBroadcastToUser.mock.calls.filter(
      (call) => call[1]?.type === "task-created",
    );
    expect(taskCreatedCalls).toHaveLength(2);
    expect(mockNotifyTaskAvailable).toHaveBeenCalledTimes(2);
  });

  // ---- Performance: getAllTabs called once, not per batch item ----

  it("calls getAllTabs only once per request, not per batch item", async () => {
    const res = await postCreateTask({
      tasks: [
        { title: "Task A", priority: 2, type: "feature" },
        { title: "Task B", priority: 3, type: "improvement" },
        { title: "Task C", priority: 1, type: "bug" },
      ],
    });

    expect(res.status).toBe(201);
    // getAllTabs should be called exactly once (before the loop), not 3 times
    expect(mockGetAllTabs).toHaveBeenCalledTimes(1);
  });
});
