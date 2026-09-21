/**
 * Tests for the AI Task Planner conversation-persistence wiring in
 * routes/task-planner.ts:
 *   - POST /:sessionId/message creates a PlannerConversation on the first
 *     message of a planner session and appends the user message (with images
 *     replaced by an [image] marker, never the blob).
 *   - It does NOT persist for non-planner sessions.
 *   - GET/DELETE /conversations/:id surface 404 when the DB layer reports
 *     no owned conversation.
 *
 * The DB layer (db/planner-conversations.js) and session-manager are mocked;
 * no live AuraDB is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// A mutable session record the getSession mock returns.
let currentSession: any = { id: 5, name: "Task Planner", userId: 1, tabIds: [2], status: "running" };

vi.mock("../session-manager.js", () => ({
  createSession: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(),
  getSession: vi.fn(() => currentSession),
  getSessionOutput: vi.fn().mockReturnValue([]),
  sendPrompt: vi.fn().mockResolvedValue(true),
  getAllSessions: vi.fn().mockReturnValue([]),
  injectPendingRunner: vi.fn().mockReturnValue(false),
  registerTurnCompletionHook: vi.fn(),
}));

vi.mock("../db/planner-conversations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/planner-conversations.js")>();
  return {
    // Keep the real pure helpers (sanitize / derive) so the route's use of
    // them is exercised for real.
    ...actual,
    createPlannerConversation: vi.fn().mockResolvedValue({
      id: 42,
      shortDescription: "hello",
      createdAt: "x",
      lastMessageAt: "x",
    }),
    appendPlannerMessage: vi.fn().mockResolvedValue(0),
    listPlannerConversations: vi.fn().mockResolvedValue([]),
    getPlannerConversation: vi.fn().mockResolvedValue(null),
    deletePlannerConversation: vi.fn().mockResolvedValue(false),
    deleteExpiredPlannerConversations: vi.fn().mockResolvedValue(0),
  };
});

vi.mock("../error-store.js", () => ({ recordError: vi.fn() }));
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
vi.mock("../agent/kiro-runner.js", () => ({ KiroRunner: { create: vi.fn() } }));
vi.mock("./models.js", () => ({ getDetectedModelIds: vi.fn().mockResolvedValue([]) }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getUserId: () => 1,
}));
vi.mock("../logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

describe("task-planner conversation persistence wiring", () => {
  let app: express.Express;
  let db: typeof import("../db/planner-conversations.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    currentSession = { id: 5, name: "Task Planner", userId: 1, tabIds: [2], status: "running" };

    db = await import("../db/planner-conversations.js");
    const { default: router } = await import("./task-planner.js");
    app = express();
    app.use(express.json());
    app.use("/api/task-planner", router);
  });

  it("creates a conversation and appends the user message for a planner session", async () => {
    await supertest(app)
      .post("/api/task-planner/5/message")
      .send({ message: "hello world" })
      .expect(200);

    // Give the fire-and-forget persistence a tick to run.
    await new Promise((r) => setTimeout(r, 20));

    expect(db.createPlannerConversation).toHaveBeenCalledTimes(1);
    const createArg = (db.createPlannerConversation as any).mock.calls[0][0];
    expect(createArg.userId).toBe(1);
    expect(createArg.tabId).toBe(2);
    expect(createArg.firstUserMessage).toBe("hello world");

    expect(db.appendPlannerMessage).toHaveBeenCalledTimes(1);
    const appendArg = (db.appendPlannerMessage as any).mock.calls[0][0];
    expect(appendArg.conversationId).toBe(42);
    expect(appendArg.role).toBe("user");
    expect(appendArg.text).toBe("hello world");
  });

  it("replaces image blobs with an [image] marker and never stores the blob", async () => {
    await supertest(app)
      .post("/api/task-planner/5/message")
      .send({ message: "look", images: [{ data: "SECRETBLOB", mimeType: "image/png" }] })
      .expect(200);

    await new Promise((r) => setTimeout(r, 20));

    const appendArg = (db.appendPlannerMessage as any).mock.calls[0][0];
    expect(appendArg.text).toContain("[image]");
    expect(appendArg.text).not.toContain("SECRETBLOB");
  });

  it("does NOT persist for non-planner sessions", async () => {
    currentSession = { id: 7, name: "Chat", userId: 1, tabIds: [2], status: "running" };

    await supertest(app)
      .post("/api/task-planner/7/message")
      .send({ message: "hi" })
      .expect(200);

    await new Promise((r) => setTimeout(r, 20));

    expect(db.createPlannerConversation).not.toHaveBeenCalled();
    expect(db.appendPlannerMessage).not.toHaveBeenCalled();
  });

  it("GET /conversations/:id returns 404 when not owned", async () => {
    (db.getPlannerConversation as any).mockResolvedValue(null);
    await supertest(app).get("/api/task-planner/conversations/99").expect(404);
    expect(db.getPlannerConversation).toHaveBeenCalledWith(99, 1);
  });

  it("DELETE /conversations/:id returns 404 when not owned", async () => {
    (db.deletePlannerConversation as any).mockResolvedValue(false);
    await supertest(app).delete("/api/task-planner/conversations/99").expect(404);
    expect(db.deletePlannerConversation).toHaveBeenCalledWith(99, 1);
  });

  it("GET /conversations lists conversations for the current user", async () => {
    (db.listPlannerConversations as any).mockResolvedValue([
      { id: 1, shortDescription: "A", createdAt: "x", lastMessageAt: "y" },
    ]);
    const res = await supertest(app).get("/api/task-planner/conversations").expect(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(db.listPlannerConversations).toHaveBeenCalledWith(1);
  });
});
