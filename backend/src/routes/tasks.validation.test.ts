/**
 * Tests for input validation of `type`, `priority`, and `state` on the
 * authenticated task routes (POST /api/tasks, PUT /api/tasks/:id).
 *
 * Task #1978: the routes previously accepted these fields straight from the
 * request body without validating them against their allowed domains, letting
 * a client persist out-of-domain values that corrupt board display and can
 * silently orphan tasks. These tests pin the intended 400-on-invalid behavior,
 * plus the underlying type-guard helpers in ../types.js.
 *
 * Uses the supertest + vi.mock pattern established by errors.create-task.test.ts
 * and other route tests in this codebase.
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

import { createTask, updateTask } from "../db/tasks.js";
import { getAllTabs } from "../db/tabs.js";
import tasksRouter from "./tasks.js";
import {
  TASK_TYPES,
  TASK_STATES,
  isTaskType,
  isTaskState,
  isValidPriority,
} from "../types.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", tasksRouter);
  return app;
}

describe("task type guards (types.ts)", () => {
  it("TASK_TYPES lists exactly bug, feature, improvement", () => {
    expect([...TASK_TYPES].sort()).toEqual(["bug", "feature", "improvement"]);
  });

  it("TASK_STATES lists the full TaskState domain", () => {
    expect([...TASK_STATES].sort()).toEqual(
      [
        "developed",
        "done",
        "in-code-review",
        "in-progress",
        "in-qa",
        "reviewed",
        "todo",
      ].sort(),
    );
  });

  it("isTaskType accepts valid types and rejects everything else", () => {
    expect(isTaskType("bug")).toBe(true);
    expect(isTaskType("feature")).toBe(true);
    expect(isTaskType("improvement")).toBe(true);
    expect(isTaskType("epic")).toBe(false);
    expect(isTaskType("")).toBe(false);
    expect(isTaskType(undefined)).toBe(false);
    expect(isTaskType(1)).toBe(false);
  });

  it("isTaskState accepts valid states and rejects everything else", () => {
    expect(isTaskState("todo")).toBe(true);
    expect(isTaskState("done")).toBe(true);
    expect(isTaskState("in-code-review")).toBe(true);
    expect(isTaskState("banana")).toBe(false);
    expect(isTaskState("")).toBe(false);
    expect(isTaskState(undefined)).toBe(false);
  });

  it("isValidPriority accepts 1-4 integers and rejects everything else", () => {
    expect(isValidPriority(1)).toBe(true);
    expect(isValidPriority(4)).toBe(true);
    expect(isValidPriority(0)).toBe(false);
    expect(isValidPriority(5)).toBe(false);
    expect(isValidPriority(2.5)).toBe(false);
    expect(isValidPriority("2")).toBe(false);
    expect(isValidPriority(undefined)).toBe(false);
  });
});

describe("POST /api/tasks validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createTask).mockResolvedValue({ id: 1 } as any);
  });

  it("returns 400 when type is not a valid task type", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "epic", tabIds: [2] });

    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when priority is out of the 1-4 range", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 7, type: "bug", tabIds: [2] });

    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when priority is not an integer", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2.5, type: "bug", tabIds: [2] });

    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when origin is not a valid origin", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "bug", origin: "martian", tabIds: [2] });

    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("creates the task when type, priority, and origin are all valid", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "bug", origin: "user", tabIds: [2] });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when user owns no tabs and no tabIds are provided", async () => {
    vi.mocked(getAllTabs).mockResolvedValueOnce([]);
    const app = createApp();
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "T", priority: 2, type: "bug" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tab/i);
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("PUT /api/tasks/:id validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateTask).mockResolvedValue({ id: 5 } as any);
  });

  it("returns 400 when state is not a valid task state", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/5")
      .send({ state: "banana" });

    expect(res.status).toBe(400);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("returns 400 when type is not a valid task type", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/5")
      .send({ type: "epic" });

    expect(res.status).toBe(400);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("returns 400 when priority is out of range", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/5")
      .send({ priority: 0 });

    expect(res.status).toBe(400);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("updates the task when state, type, and priority are all valid", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/5")
      .send({ state: "developed", type: "feature", priority: 3 });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("allows updates that omit type/priority/state entirely", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/tasks/5")
      .send({ title: "renamed" });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });
});
