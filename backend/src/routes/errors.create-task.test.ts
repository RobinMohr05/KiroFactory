/**
 * Tests for POST /api/errors/:id/create-task — creating a bug task from an
 * agent error, with a focus on the "authenticated user owns no tabs" edge case.
 *
 * Before the fix, a user with zero tabs would leave `tabIds` undefined; that
 * was passed straight into createTask(), which now throws an orphan-prevention
 * error ("tabIds must be a non-empty array"), surfacing to the caller as an
 * opaque 500. The handler should instead detect the no-tab case explicitly and
 * return an actionable 409.
 *
 * Uses the supertest + vi.mock pattern established by webhook-tasks.test.ts and
 * usage.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../error-store.js", () => ({
  getErrorsByUserId: vi.fn(),
  getErrorById: vi.fn(),
  markErrorTaskCreated: vi.fn(),
  dismissError: vi.fn(),
  clearErrorsByUserId: vi.fn(),
}));

vi.mock("../wsl-diagnostics-collector.js", () => ({
  getDiagnosticBuffer: vi.fn().mockReturnValue([]),
}));

vi.mock("../db/tasks.js", () => ({
  createTask: vi.fn(),
}));

vi.mock("../db/tabs.js", () => ({
  getAllTabs: vi.fn(),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../agent/task-claimer.js", () => ({
  notifyTaskAvailable: vi.fn(),
}));

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { getErrorById, markErrorTaskCreated } from "../error-store.js";
import { createTask } from "../db/tasks.js";
import { getAllTabs } from "../db/tabs.js";
import errorsRouter from "./errors.js";

function fakeError(overrides: Record<string, unknown> = {}) {
  return {
    id: "err-1",
    sessionId: 5,
    sessionName: "sess",
    agent: "developer",
    timestamp: "2026-09-22T16:00:00.000Z",
    message: "Something broke",
    context: "while doing work",
    taskCreated: false,
    userId: 1,
    ...overrides,
  } as any;
}

function fakeTab(id: number) {
  return { id, name: `Tab ${id}`, sortOrder: 0, userId: 1 } as any;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/errors", errorsRouter);
  return app;
}

describe("POST /api/errors/:id/create-task — no user tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 (not 500) when the user owns no tabs and no tabIds are provided", async () => {
    vi.mocked(getErrorById).mockReturnValue(fakeError());
    vi.mocked(getAllTabs).mockResolvedValue([]);

    const app = createApp();
    const res = await request(app).post("/api/errors/err-1/create-task").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/board|tab/i);
    // createTask must never be called in the no-tab case
    expect(createTask).not.toHaveBeenCalled();
    // The error must not be marked as task-created
    expect(markErrorTaskCreated).not.toHaveBeenCalled();
  });

  it("still creates a task normally when the user owns at least one tab", async () => {
    vi.mocked(getErrorById).mockReturnValue(fakeError());
    vi.mocked(getAllTabs).mockResolvedValue([fakeTab(2)]);
    vi.mocked(createTask).mockResolvedValue({ id: 42, tabIds: [2] } as any);

    const app = createApp();
    const res = await request(app).post("/api/errors/err-1/create-task").send({});

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ tabIds: [2] }),
    );
    expect(markErrorTaskCreated).toHaveBeenCalledWith("err-1", 42);
  });
});
