/**
 * Tests for multi-task batch creation in the Task Planner create-task route.
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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks ----

// Mock createTask so we can control success/failure per call
const mockCreateTask = vi.fn();
const mockGetAllTabs = vi.fn();
const mockGetSession = vi.fn();
const mockGetUserId = vi.fn();
const mockBroadcastToUser = vi.fn();
const mockNotifyTaskAvailable = vi.fn();
const mockStopSession = vi.fn();
const mockDeleteSession = vi.fn();
const mockRecordError = vi.fn();

/**
 * Build a test Express app that mirrors the batch create-task route logic.
 * This tests the route handler's own logic (validation, topo-sort, dependency
 * resolution, partial failure handling) in isolation from the real DB/session layer.
 */
function createBatchCreateApp() {
  const app = express();
  app.use(express.json());

  app.post("/api/task-planner/:sessionId/create-task", async (req, res) => {
    const userId = mockGetUserId();
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = mockGetSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    // Determine if this is a batch body or a single-object body
    const body = req.body;
    let batchItems: Array<{
      title: string;
      description?: string;
      priority: number;
      type: string;
      files?: string[];
      tabIds?: number[];
      dependsOnBatchIndex?: number[];
      groupId?: string;
    }>;

    if (body.tasks && Array.isArray(body.tasks)) {
      // Batch body
      batchItems = body.tasks;
    } else if (body.title) {
      // Single-object backward compat — wrap as one-element batch
      batchItems = [body];
    } else {
      res.status(400).json({ error: "Request body must be a task object or { tasks: [...] }" });
      return;
    }

    // Validate all items up front — reject the whole request if any item is invalid
    for (let i = 0; i < batchItems.length; i++) {
      const item = batchItems[i];
      if (!item.title || !item.priority || !item.type) {
        res.status(400).json({ error: `Task at index ${i} is missing required fields (title, priority, type)` });
        return;
      }
    }

    // Resolve tabIds
    const resolveTabIds = async (item: typeof batchItems[0]): Promise<number[]> => {
      if (item.tabIds && item.tabIds.length > 0) {
        const userTabs = await mockGetAllTabs(userId);
        const userTabIds = new Set(userTabs.map((t: { id: number }) => t.id));
        const unauthorized = item.tabIds.filter((id: number) => !userTabIds.has(id));
        if (unauthorized.length > 0) {
          throw new Error("Cannot assign task to tabs you do not own");
        }
        return item.tabIds;
      }
      if (session.tabIds && session.tabIds.length > 0) {
        return session.tabIds;
      }
      const userTabs = await mockGetAllTabs(userId);
      if (userTabs.length > 0) return [userTabs[0].id];
      return [];
    };

    // Topological sort based on dependsOnBatchIndex
    // Build adjacency and detect cycles
    const n = batchItems.length;
    const inDegree = new Array(n).fill(0);
    const adjList: number[][] = Array.from({ length: n }, () => []);

    for (let i = 0; i < n; i++) {
      const deps = batchItems[i].dependsOnBatchIndex;
      if (deps) {
        for (const dep of deps) {
          if (dep < 0 || dep >= n || dep === i) {
            res.status(400).json({ error: `Task at index ${i} has invalid dependsOnBatchIndex ${dep}` });
            return;
          }
          adjList[dep].push(i);
          inDegree[i]++;
        }
      }
    }

    // Kahn's algorithm
    const order: number[] = [];
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inDegree[i] === 0) queue.push(i);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const neighbor of adjList[node]) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) queue.push(neighbor);
      }
    }

    if (order.length !== n) {
      res.status(400).json({ error: "Cycle detected in dependsOnBatchIndex references" });
      return;
    }

    // Create tasks in topological order
    const createdTasks: any[] = [];
    const failedTasks: Array<{ task: any; error: string }> = [];
    const batchIdMap: Map<number, number> = new Map(); // batchIndex -> real task ID

    for (const idx of order) {
      const item = batchItems[idx];
      try {
        const tabIds = await resolveTabIds(item);

        // Resolve dependsOnBatchIndex to real IDs
        const dependsOn: number[] = [];
        if (item.dependsOnBatchIndex) {
          for (const depIdx of item.dependsOnBatchIndex) {
            const realId = batchIdMap.get(depIdx);
            if (realId === undefined) {
              // Dependency failed to create — skip this task too
              throw new Error(`Dependency at batch index ${depIdx} was not created successfully`);
            }
            dependsOn.push(realId);
          }
        }

        const taskInput = {
          title: item.title,
          description: item.description || "",
          priority: item.priority,
          type: item.type,
          files: item.files || [],
          origin: "user-assisted" as const,
          tabIds,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          groupId: item.groupId ?? null,
        };

        const task = await mockCreateTask(taskInput);
        createdTasks.push(task);
        batchIdMap.set(idx, task.id);

        mockBroadcastToUser(userId, { type: "task-created", task });
        mockNotifyTaskAvailable();
      } catch (err: any) {
        failedTasks.push({ task: item, error: err.message });
        mockRecordError({
          sessionId,
          sessionName: session.name || "Task Planner",
          agent: "task-planner",
          message: err.message,
          context: `Failed to create batch item at index ${idx}`,
          taskTitle: item.title,
          userId,
          tabIds: session.tabIds,
        });
      }
    }

    // Only clean up session on full success
    if (failedTasks.length === 0) {
      try {
        await mockStopSession(sessionId);
        mockDeleteSession(sessionId);
      } catch {
        // Non-fatal
      }
    }

    res.status(201).json({ created: createdTasks, failed: failedTasks });
  });

  return app;
}

describe("Task Planner batch create-task route", () => {
  let app: express.Express;
  let taskIdCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    taskIdCounter = 100;
    mockGetUserId.mockReturnValue(1);
    mockGetSession.mockReturnValue({
      id: 1,
      userId: 1,
      name: "Task Planner",
      tabIds: [2],
    });
    mockGetAllTabs.mockResolvedValue([{ id: 2, name: "VCH" }]);
    mockCreateTask.mockImplementation(async (input: any) => {
      const id = taskIdCounter++;
      return { id, ...input, state: "todo", createdAt: new Date().toISOString() };
    });
    app = createBatchCreateApp();
  });

  // ---- Backward compatibility ----

  it("creates a single task from a plain object body (backward compat)", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        title: "Fix login bug",
        description: "The login page crashes on empty email",
        priority: 2,
        type: "bug",
        files: ["src/auth.ts"],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(0);
    expect(res.body.created[0].title).toBe("Fix login bug");
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  // ---- Batch creation ----

  it("creates multiple independent tasks from a batch body", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature" },
          { title: "Task B", priority: 3, type: "improvement" },
          { title: "Task C", priority: 1, type: "bug" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(3);
    expect(res.body.failed).toHaveLength(0);
    expect(mockCreateTask).toHaveBeenCalledTimes(3);
  });

  // ---- Validation ----

  it("rejects entire batch if any item is missing required fields", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Valid task", priority: 2, type: "feature" },
          { title: "Missing priority", type: "bug" }, // missing priority
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("index 1");
    expect(res.body.error).toContain("missing required fields");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  // ---- Dependency resolution ----

  it("resolves dependsOnBatchIndex to real task IDs", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Base task", priority: 2, type: "feature" },
          { title: "Dependent task", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);

    // The second createTask call should have dependsOn with the first task's ID
    const secondCall = mockCreateTask.mock.calls[1][0];
    expect(secondCall.dependsOn).toEqual([100]); // first task got id 100
  });

  // ---- Cycle detection ----

  it("rejects batch with cyclic dependsOnBatchIndex", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: [1] },
          { title: "Task B", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cycle detected");
  });

  // ---- groupId pass-through ----

  it("passes groupId through to createTask for items sharing the same groupId", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature", groupId: "batch-x" },
          { title: "Task B", priority: 3, type: "improvement" },
          { title: "Task C", priority: 2, type: "feature", groupId: "batch-x" },
        ],
      })
      .set("Content-Type", "application/json");

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
    mockCreateTask.mockImplementation(async (input: any) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("DB connection lost");
      }
      return { id: taskIdCounter++, ...input, state: "todo", createdAt: new Date().toISOString() };
    });

    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature" },
          { title: "Task B", priority: 3, type: "bug" },
          { title: "Task C", priority: 1, type: "improvement" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].task.title).toBe("Task B");
    expect(res.body.failed[0].error).toBe("DB connection lost");
  });

  it("records AgentError via recordError() on partial failure", async () => {
    mockCreateTask.mockImplementationOnce(async (input: any) => {
      return { id: 100, ...input, state: "todo" };
    });
    mockCreateTask.mockImplementationOnce(async () => {
      throw new Error("Constraint violation");
    });

    await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task OK", priority: 2, type: "feature" },
          { title: "Task Fail", priority: 3, type: "bug" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(mockRecordError).toHaveBeenCalledTimes(1);
    expect(mockRecordError.mock.calls[0][0]).toMatchObject({
      sessionId: 1,
      agent: "task-planner",
      message: "Constraint violation",
      taskTitle: "Task Fail",
    });
  });

  it("does NOT clean up the session on partial failure", async () => {
    mockCreateTask.mockImplementationOnce(async (input: any) => {
      return { id: 100, ...input, state: "todo" };
    });
    mockCreateTask.mockImplementationOnce(async () => {
      throw new Error("DB error");
    });

    await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task OK", priority: 2, type: "feature" },
          { title: "Task Fail", priority: 3, type: "bug" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(mockStopSession).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("cleans up the session on full success", async () => {
    await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(mockStopSession).toHaveBeenCalledWith(1);
    expect(mockDeleteSession).toHaveBeenCalledWith(1);
  });

  // ---- Session not found ----

  it("returns 404 when session is not found", async () => {
    mockGetSession.mockReturnValue(null);

    const res = await request(app)
      .post("/api/task-planner/999/create-task")
      .send({ title: "Test", priority: 2, type: "feature" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(404);
  });

  // ---- Invalid dependsOnBatchIndex ----

  it("rejects self-referential dependsOnBatchIndex", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: [0] },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid dependsOnBatchIndex");
  });

  it("rejects out-of-range dependsOnBatchIndex", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature", dependsOnBatchIndex: [5] },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid dependsOnBatchIndex");
  });

  // ---- broadcasts for each successful task ----

  it("broadcasts task-created and notifyTaskAvailable for each successful task", async () => {
    await request(app)
      .post("/api/task-planner/1/create-task")
      .send({
        tasks: [
          { title: "Task A", priority: 2, type: "feature" },
          { title: "Task B", priority: 3, type: "improvement" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(mockBroadcastToUser).toHaveBeenCalledTimes(2);
    expect(mockNotifyTaskAvailable).toHaveBeenCalledTimes(2);
  });
});
