/**
 * Tests for PATCH /api/sessions/:id — session field editing.
 *
 * These tests validate:
 * 1. Editable fields are accepted and persisted
 * 2. Non-editable fields (agent, id, status, userId, etc.) are rejected/ignored
 * 3. 409 when session is running
 * 4. Ownership check (404 for wrong user)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the session-manager module
const mockGetSession = vi.fn<(...args: any[]) => any>();
const mockUpdateSessionFields = vi.fn<(...args: any[]) => any>();
const mockGetAllSessions = vi.fn<(...args: any[]) => any>().mockReturnValue([]);
const mockCreateSession = vi.fn<(...args: any[]) => any>();
const mockGetSessionOutput = vi.fn<(...args: any[]) => any>().mockReturnValue([]);
const mockDeleteSession = vi.fn<(...args: any[]) => any>();
const mockStartSession = vi.fn<(...args: any[]) => any>();
const mockStopSession = vi.fn<(...args: any[]) => any>();
const mockSendPrompt = vi.fn<(...args: any[]) => any>();
const mockUpdateSessionTabs = vi.fn<(...args: any[]) => any>();

vi.mock("../session-manager.js", () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  updateSessionFields: (...args: any[]) => mockUpdateSessionFields(...args),
  getAllSessions: (...args: any[]) => mockGetAllSessions(...args),
  createSession: (...args: any[]) => mockCreateSession(...args),
  getSessionOutput: (...args: any[]) => mockGetSessionOutput(...args),
  deleteSession: (...args: any[]) => mockDeleteSession(...args),
  startSession: (...args: any[]) => mockStartSession(...args),
  stopSession: (...args: any[]) => mockStopSession(...args),
  sendPrompt: (...args: any[]) => mockSendPrompt(...args),
  updateSessionTabs: (...args: any[]) => mockUpdateSessionTabs(...args),
}));

// Mock the auth middleware
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  getUserId: () => 1,
}));

// Mock the logger
vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logSessionEvent: vi.fn(),
  toErrorFields: (e: unknown) => ({ error: String(e) }),
}));

import express from "express";
import request from "supertest";
import sessionRoutes from "./sessions.js";

// ─── Test App Setup ──────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionRoutes);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PATCH /api/sessions/:id", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  it("returns 400 for invalid session id", async () => {
    const res = await request(app).patch("/api/sessions/abc").send({ name: "test" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when session not found", async () => {
    mockGetSession.mockReturnValue(undefined);
    const res = await request(app).patch("/api/sessions/99").send({ name: "test" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when session belongs to a different user", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 999, status: "stopped" });
    const res = await request(app).patch("/api/sessions/5").send({ name: "test" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when session is running", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 1, status: "running" });
    const res = await request(app).patch("/api/sessions/5").send({ name: "new name" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/running/i);
  });

  it("accepts editable fields and calls updateSessionFields", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 1, status: "stopped" });
    mockUpdateSessionFields.mockReturnValue(true);

    const body = {
      name: "Updated Name",
      prompt: "new prompt",
      cwd: "/tmp",
      model: "claude-sonnet-4",
      timeoutSeconds: 300,
      interactive: false,
      loop: true,
      runs: 5,
      intervalSeconds: 20,
      tabIds: [1, 2],
    };

    const res = await request(app).patch("/api/sessions/5").send(body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdateSessionFields).toHaveBeenCalledWith(5, body);
  });

  it("strips non-editable fields (agent, id, status, userId, etc.) before passing to updateSessionFields", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 1, status: "stopped" });
    mockUpdateSessionFields.mockReturnValue(true);

    const body = {
      name: "Valid",
      agent: "should-be-stripped",
      id: 999,
      status: "running",
      userId: 42,
      createdAt: "2025-01-01",
      startedAt: "2025-01-01",
      currentTaskId: 7,
      currentActivity: { type: "working" },
      pinned: true,
      output: [{ text: "foo" }],
    };

    const res = await request(app).patch("/api/sessions/5").send(body);
    expect(res.status).toBe(200);

    // Only `name` should survive the whitelist filter
    const passedFields = mockUpdateSessionFields.mock.calls[0][1];
    expect(passedFields).toEqual({ name: "Valid" });
    expect(passedFields).not.toHaveProperty("agent");
    expect(passedFields).not.toHaveProperty("id");
    expect(passedFields).not.toHaveProperty("status");
    expect(passedFields).not.toHaveProperty("userId");
    expect(passedFields).not.toHaveProperty("createdAt");
    expect(passedFields).not.toHaveProperty("startedAt");
    expect(passedFields).not.toHaveProperty("currentTaskId");
    expect(passedFields).not.toHaveProperty("currentActivity");
    expect(passedFields).not.toHaveProperty("pinned");
    expect(passedFields).not.toHaveProperty("output");
  });

  it("accepts mcpServers and mcpConfigOverride as editable fields", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 1, status: "stopped" });
    mockUpdateSessionFields.mockReturnValue(true);

    const body = {
      mcpServers: [{ name: "test", command: "npx", args: ["-y", "foo"], env: [] }],
      mcpConfigOverride: { atlassian: true, azureDevops: false, awsApi: true, awsDocs: false },
    };

    const res = await request(app).patch("/api/sessions/5").send(body);
    expect(res.status).toBe(200);
    expect(mockUpdateSessionFields).toHaveBeenCalledWith(5, body);
  });

  it("returns 400 when body is empty (no editable fields)", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 1, status: "stopped" });

    const res = await request(app).patch("/api/sessions/5").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when only non-editable fields are sent", async () => {
    mockGetSession.mockReturnValue({ id: 5, userId: 1, status: "stopped" });

    const res = await request(app).patch("/api/sessions/5").send({ agent: "foo", id: 1 });
    expect(res.status).toBe(400);
  });
});
