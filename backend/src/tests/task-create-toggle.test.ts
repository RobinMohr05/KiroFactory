/**
 * Tests for the createTasksEnabled / taskCreationTabId session fields.
 *
 * Covers:
 * 1. POST /api/sessions rejects createTasksEnabled: true with missing taskCreationTabId (400)
 * 2. POST /api/sessions rejects createTasksEnabled: true with a non-owned taskCreationTabId (400)
 * 3. POST /api/sessions accepts createTasksEnabled: true with a valid owned taskCreationTabId
 * 4. PATCH /api/sessions/:id rejects createTasksEnabled: true with missing taskCreationTabId (400)
 * 5. PATCH /api/sessions/:id rejects createTasksEnabled: true with non-owned taskCreationTabId (400)
 * 6. PATCH /api/sessions/:id accepts createTasksEnabled: true with valid owned taskCreationTabId
 * 7. handleWorkerTaskCreate files created task into taskCreationTabId when set
 * 8. handleWorkerTaskCreate falls back to session tabIds when taskCreationTabId is null
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must come before module imports
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

vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
  getAllTabs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/agents.js", () => ({
  getAgentByName: vi.fn().mockResolvedValue(null),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
  broadcastToAll: vi.fn(),
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
  waitForTaskAvailable: vi.fn(),
  describeClaimFailure: vi.fn(),
  resetOrphanedTasks: vi.fn().mockResolvedValue(0),
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
}));

vi.mock("../worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn(),
  sendWorkerStop: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
  connectToLocalWorker: vi.fn(),
}));

vi.mock("../scheduled-session-manager.js", () => ({
  armSession: vi.fn(),
  disarmSession: vi.fn(),
  triggerRunNow: vi.fn(),
}));

vi.mock("../cron-schedule.js", () => ({
  isValidCronExpression: vi.fn().mockReturnValue(true),
  isValidTimezone: vi.fn().mockReturnValue(true),
}));

vi.mock("../db/turns.js", () => ({
  getTurnsBySession: vi.fn().mockResolvedValue([]),
  createTurn: vi.fn().mockResolvedValue(undefined),
  completeTurn: vi.fn().mockResolvedValue(undefined),
  getMaxTurnNumber: vi.fn().mockResolvedValue(0),
}));

vi.mock("../session-sanitize.js", () => ({
  sanitizeSessionForClient: vi.fn().mockImplementation((s) => s),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getUserId: (_req: any) => 1,
}));

vi.mock("../logger.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logSessionEvent: vi.fn(),
  logWorkerEvent: vi.fn(),
  toErrorFields: (e: any) => ({ error: e?.message || String(e) }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createSession, handleWorkerTaskCreate } from "../session-manager.js";
import sessionsRouter from "../routes/sessions.js";
import { createTask } from "../db/tasks.js";
import { broadcastToUser } from "../websocket-handler.js";
import { getTabById } from "../db/tabs.js";
import type { CreateSessionInput } from "../types.js";

// ---------------------------------------------------------------------------
// Test app setup
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helper: owned tab mock
// ---------------------------------------------------------------------------

const OWNED_TAB = { id: 3, name: "My Tab", userId: 1, repositoryUrl: null, gitProvider: null, autoMergePrs: false, columns: [], sortOrder: 0, createdAt: new Date().toISOString() };
const OTHER_USER_TAB = { id: 99, name: "Other Tab", userId: 2, repositoryUrl: null, gitProvider: null, autoMergePrs: false, columns: [], sortOrder: 0, createdAt: new Date().toISOString() };

// ---------------------------------------------------------------------------
// Route tests (POST + PATCH /api/sessions)
// ---------------------------------------------------------------------------

describe("POST /api/sessions — createTasksEnabled validation", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it("rejects with 400 when createTasksEnabled is true and taskCreationTabId is missing", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ name: "Test", createTasksEnabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/taskCreationTabId/i);
  });

  it("rejects with 400 when createTasksEnabled is true and taskCreationTabId refers to a non-owned tab", async () => {
    (getTabById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OTHER_USER_TAB);

    const res = await request(app)
      .post("/api/sessions")
      .send({ name: "Test", createTasksEnabled: true, taskCreationTabId: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not owned|not found/i);
  });

  it("rejects with 400 when createTasksEnabled is true and tab does not exist", async () => {
    (getTabById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/sessions")
      .send({ name: "Test", createTasksEnabled: true, taskCreationTabId: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not owned|not found/i);
  });

  it("accepts with 201 when createTasksEnabled is true and taskCreationTabId is an owned tab", async () => {
    (getTabById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OWNED_TAB);

    const res = await request(app)
      .post("/api/sessions")
      .send({ name: "Test", createTasksEnabled: true, taskCreationTabId: 3 });

    expect(res.status).toBe(201);
  });

  it("accepts with 201 when createTasksEnabled is false (no tab required)", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({ name: "Test", createTasksEnabled: false });

    expect(res.status).toBe(201);
    expect(getTabById).not.toHaveBeenCalled();
  });

  it("forces taskCreationTabId to null when createTasksEnabled is false", async () => {
    const { insertSession } = await import("../db/sessions.js");

    const res = await request(app)
      .post("/api/sessions")
      .send({ name: "Test", createTasksEnabled: false, taskCreationTabId: 3 });

    expect(res.status).toBe(201);
    // The inserted session must not have taskCreationTabId set
    const insertedSession = (insertSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(insertedSession?.taskCreationTabId).toBeFalsy();
    expect(insertedSession?.createTasksEnabled).toBeFalsy();
  });
});

describe("PATCH /api/sessions/:id — createTasksEnabled validation", () => {
  let app: ReturnType<typeof buildApp>;
  let sessionId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();

    const input: CreateSessionInput = {
      name: "Existing Session",
      agent: "code-reviewer-agent",
      userId: 1,
      tabIds: [2],
    };
    const s = await createSession(input);
    sessionId = s.id;
  });

  it("rejects with 400 when createTasksEnabled is true and taskCreationTabId is missing", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ createTasksEnabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/taskCreationTabId/i);
  });

  it("rejects with 400 when createTasksEnabled is true and tab not owned by user", async () => {
    (getTabById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OTHER_USER_TAB);

    const res = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ createTasksEnabled: true, taskCreationTabId: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not owned|not found/i);
  });

  it("accepts when createTasksEnabled is true and tab is owned by user", async () => {
    (getTabById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OWNED_TAB);

    const res = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ createTasksEnabled: true, taskCreationTabId: 3 });

    expect(res.status).toBe(200);
  });

  it("accepts when createTasksEnabled is false (no tab check needed)", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ createTasksEnabled: false });

    expect(res.status).toBe(200);
    expect(getTabById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleWorkerTaskCreate — taskCreationTabId routing
// ---------------------------------------------------------------------------

describe("handleWorkerTaskCreate — taskCreationTabId routing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (createTask as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      title: "Created Task",
      description: "desc",
      type: "bug",
      priority: 2,
      state: "todo",
      files: [],
      origin: "ai",
      tabs: [],
      dependsOn: [],
      blockedBy: [],
    });
  });

  it("uses taskCreationTabId when set on the session", async () => {
    const input: CreateSessionInput = {
      name: "Inspector",
      agent: "qa-improvement-agent",
      userId: 1,
      tabIds: [10, 11],
      createTasksEnabled: true,
      taskCreationTabId: 10,
    };
    const s = await createSession(input);

    await handleWorkerTaskCreate(s.id, {
      title: "Bug found",
      description: "desc",
      type: "bug",
      priority: 2,
      files: [],
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    const arg = (createTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.tabIds).toEqual([10]);
    expect(arg.origin).toBe("ai");
  });

  it("falls back to session tabIds when taskCreationTabId is null", async () => {
    const input: CreateSessionInput = {
      name: "Inspector no target",
      agent: "qa-improvement-agent",
      userId: 1,
      tabIds: [10, 11],
      createTasksEnabled: false,
      taskCreationTabId: undefined,
    };
    const s = await createSession(input);

    await handleWorkerTaskCreate(s.id, {
      title: "Another bug",
      description: "desc",
      type: "improvement",
      priority: 3,
      files: [],
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    const arg = (createTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Should fall back to session.tabIds
    expect(arg.tabIds).toEqual([10, 11]);
    expect(arg.origin).toBe("ai");
  });
});
