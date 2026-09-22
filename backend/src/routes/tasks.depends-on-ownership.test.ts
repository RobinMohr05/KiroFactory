/**
 * Tests for cross-tenant dependency (IDOR) protection on the authenticated
 * task routes (POST /api/tasks, PUT /api/tasks/:id).
 *
 * Task #2019: both routes accepted a `dependsOn: number[]` straight from the
 * request body and passed it to createTask()/updateTask() -> replaceDependencies(),
 * which only checked that each dependency ID *exists* — not that it belongs to
 * the authenticated user. An authenticated user could therefore create a
 * DEPENDS_ON edge from their own task to ANY task ID in the system (OWASP A01 —
 * Broken Access Control / IDOR), leaking foreign task titles via `blockedBy`.
 *
 * These tests pin the intended behavior: dependsOn IDs the user does not own
 * (via their tabs) are rejected with 403 before the DB layer is touched, while
 * dependsOn IDs the user does own are accepted. Mirrors the guard already present
 * on the MCP path handleAddTaskDependency() in task-planner-board-mcp.ts.
 *
 * Uses the supertest + vi.mock pattern established by tasks.validation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mocks — must come before module imports
// ---------------------------------------------------------------------------

vi.mock("../db/tasks.js", () => ({
  getAllTasks: vi.fn().mockResolvedValue([]),
  getTaskById: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  assignTaskToTabs: vi.fn(),
  removeTaskFromTab: vi.fn(),
  isTaskOwnedByUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../db/tabs.js", () => ({
  getAllTabs: vi.fn().mockResolvedValue([{ id: 2, name: "VCH", userId: 1 }]),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../agent/task-claimer.js", () => ({
  notifyTaskAvailable: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { getAllTasks, createTask, updateTask } from "../db/tasks.js";
import tasksRouter from "./tasks.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", tasksRouter);
  return app;
}

// The user (id 1) owns tasks 10 and 11 via their tab(s); task 99 belongs to
// another tenant.
const OWNED_TASKS = [
  { id: 10, title: "Owned A" },
  { id: 11, title: "Owned B" },
];

describe("POST /api/tasks dependsOn ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllTasks).mockResolvedValue(OWNED_TASKS as any);
    vi.mocked(createTask).mockResolvedValue({ id: 1 } as any);
  });

  it("returns 403 when dependsOn contains a task the user does not own", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "bug", tabIds: [2], dependsOn: [10, 99] });

    expect(res.status).toBe(403);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("creates the task when all dependsOn IDs are owned by the user", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "bug", tabIds: [2], dependsOn: [10, 11] });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("creates the task when dependsOn is empty/omitted", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "bug", tabIds: [2] });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/tasks/:id dependsOn ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllTasks).mockResolvedValue(OWNED_TASKS as any);
    vi.mocked(updateTask).mockResolvedValue({ id: 10 } as any);
  });

  it("returns 403 when dependsOn contains a task the user does not own", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/10")
      .send({ dependsOn: [11, 99] });

    expect(res.status).toBe(403);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("updates the task when all dependsOn IDs are owned by the user", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/10")
      .send({ dependsOn: [11] });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("allows an update that clears dependsOn to an empty array", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/10")
      .send({ dependsOn: [] });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });
});
