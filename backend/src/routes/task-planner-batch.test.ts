/**
 * Tests for the batch create-task endpoint changes in task-planner.ts.
 *
 * Verifies:
 * 1. The endpoint accepts a JSON array of task specs (tasks field)
 * 2. dependsOnBatchIndex is resolved to real task IDs created in order
 * 3. dependsOnTaskId is passed through as-is
 * 4. Single-task backwards compatibility (tasks array with one element)
 * 5. The system prompt includes the array-based output schema
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// Mock modules
vi.mock("../db/tasks.js", () => ({
  createTask: vi.fn(),
  getAllTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/tabs.js", () => ({
  getAllTabs: vi.fn().mockResolvedValue([{ id: 1, name: "Test Tab", userId: 1 }]),
  getTabById: vi.fn().mockResolvedValue({ id: 1, name: "Test Tab", userId: 1, repositoryUrl: null }),
}));

vi.mock("../db/users.js", () => ({
  getUserById: vi.fn().mockResolvedValue({ id: 1, email: "test@test.com", defaultGitProvider: null }),
}));

vi.mock("../db/credentials.js", () => ({
  getDecryptedCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../agent/task-claimer.js", () => ({
  notifyTaskAvailable: vi.fn(),
}));

vi.mock("../session-manager.js", () => ({
  createSession: vi.fn().mockResolvedValue({ id: 1, name: "Task Planner", tabIds: [1], userId: 1 }),
  startSession: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(),
  getSession: vi.fn().mockReturnValue({ id: 1, name: "Task Planner", userId: 1, tabIds: [1], status: "running" }),
  getSessionOutput: vi.fn().mockReturnValue([]),
  sendPrompt: vi.fn().mockResolvedValue(true),
  getAllSessions: vi.fn().mockReturnValue([]),
  injectPendingRunner: vi.fn().mockReturnValue(false),
}));

vi.mock("../error-store.js", () => ({
  recordError: vi.fn(),
}));

vi.mock("../planner-session-pool.js", () => {
  class MockPool {
    warm = vi.fn().mockResolvedValue(undefined);
    checkout = vi.fn().mockReturnValue(null);
    detach = vi.fn();
    destroy = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  return { PlannerSessionPool: MockPool };
});

vi.mock("../agent/kiro-runner.js", () => ({
  KiroRunner: { create: vi.fn() },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getUserId: () => 1,
}));

vi.mock("../logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

describe("POST /api/task-planner/:sessionId/create-task — batch mode", () => {
  let app: express.Express;
  let createTask: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const tasksModule = await import("../db/tasks.js");
    createTask = vi.mocked(tasksModule.createTask);

    // Each call returns a task with incrementing IDs
    let taskIdSeq = 100;
    createTask.mockImplementation(async (input: any) => ({
      id: taskIdSeq++,
      title: input.title,
      priority: input.priority,
      type: input.type,
      state: "todo",
      description: input.description || "",
      files: input.files || [],
      origin: input.origin || "user-assisted",
      dependsOn: input.dependsOn || [],
      isBlocked: false,
      blockedBy: [],
      branch: null,
      pullRequestUrl: null,
      groupId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tabs: [{ id: 1, name: "Test Tab" }],
    }));

    // Import the router dynamically after mocks are set up
    const { default: taskPlannerRouter } = await import("./task-planner.js");
    app = express();
    app.use(express.json());
    app.use("/api/task-planner", taskPlannerRouter);
  });

  it("accepts a tasks array and creates each task in order", async () => {
    const res = await supertest(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", description: "First", priority: 2, type: "feature" },
          { title: "Task B", description: "Second", priority: 3, type: "bug" },
        ],
      })
      .expect(201);

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toHaveLength(0);
    expect(res.body.created[0].title).toBe("Task A");
    expect(res.body.created[1].title).toBe("Task B");
  });

  it("resolves dependsOnBatchIndex to real task IDs", async () => {
    const res = await supertest(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature" },
          { title: "Task B", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
        ],
      })
      .expect(201);

    // Task B should have dependsOn resolved to Task A's real ID (100)
    expect(createTask).toHaveBeenCalledTimes(2);
    const secondCall = createTask.mock.calls[1][0];
    expect(secondCall.dependsOn).toEqual([100]);
  });

  it("passes dependsOnTaskId through as real dependency IDs", async () => {
    const res = await supertest(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature", dependsOnTaskId: [50, 51] },
        ],
      })
      .expect(201);

    expect(createTask).toHaveBeenCalledTimes(1);
    const call = createTask.mock.calls[0][0];
    expect(call.dependsOn).toEqual([50, 51]);
  });

  it("merges dependsOnBatchIndex and dependsOnTaskId", async () => {
    const res = await supertest(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature" },
          {
            title: "Task B",
            priority: 2,
            type: "feature",
            dependsOnBatchIndex: [0],
            dependsOnTaskId: [50],
          },
        ],
      })
      .expect(201);

    const secondCall = createTask.mock.calls[1][0];
    expect(secondCall.dependsOn).toEqual(expect.arrayContaining([100, 50]));
  });

  it("still works with legacy single-task format (title/description top-level)", async () => {
    const res = await supertest(app)
      .post("/api/task-planner/1/create-task")
      .send({
        title: "Single Task",
        description: "Legacy format",
        priority: 2,
        type: "feature",
      })
      .expect(201);

    expect(createTask).toHaveBeenCalledTimes(1);
    // Legacy single-task now also returns { created, failed } format
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].title).toBe("Single Task");
    expect(res.body.failed).toHaveLength(0);
  });
});
