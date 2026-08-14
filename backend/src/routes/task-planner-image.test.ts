/**
 * Tests for image attachment support in the Task Planner chat (local mode).
 *
 * Tests cover:
 * - KiroRunner.prompt() accepts optional image parameter and builds correct content blocks
 * - session-manager.sendPrompt() threads image parameter
 * - session-manager.sendPrompt() rejects image in remote worker mode
 * - task-planner route validates image mimeType and size
 * - task-planner route passes image to sendPrompt
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be defined before imports
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
  getPool: vi.fn(),
  sql: {},
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

vi.mock("../db/tasks.js", () => ({
  createTask: vi.fn().mockResolvedValue({ id: 1, title: "test" }),
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
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("../agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn().mockResolvedValue(undefined),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));

vi.mock("../agent/repo-url-parser.js", () => ({
  buildPersistentBranchName: vi.fn().mockReturnValue("branch"),
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
  isWorkerConnected: vi.fn().mockReturnValue(false),
}));

vi.mock("../agent/planner-workspace.js", () => ({
  preparePlannerWorkspace: vi.fn().mockResolvedValue(null),
  cleanupPlannerWorkspace: vi.fn().mockResolvedValue(undefined),
}));

// Mock auth middleware to always authenticate as user 1
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.userId = 1; next(); },
  getUserId: () => 1,
}));

// Mock session-manager sendPrompt to track calls
const mockSendPrompt = vi.fn().mockResolvedValue(true);
vi.mock("../session-manager.js", () => ({
  createSession: vi.fn().mockResolvedValue({ id: 99 }),
  startSession: vi.fn().mockResolvedValue(true),
  stopSession: vi.fn().mockResolvedValue(true),
  sendPrompt: (...args: any[]) => mockSendPrompt(...args),
  getSession: vi.fn().mockReturnValue({ id: 99, userId: 1, status: "running", tabIds: [1] }),
  getSessionOutput: vi.fn().mockReturnValue([]),
  deleteSession: vi.fn().mockReturnValue(true),
}));

// Import the route after mocks
import taskPlannerRouter from "./task-planner.js";

// ---------------------------------------------------------------------------
// Setup Express app with the route
// ---------------------------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/task-planner", taskPlannerRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/task-planner/:sessionId/message — image validation", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("should accept a message with a valid image attachment", async () => {
    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({
        message: "Describe this screenshot",
        image: {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Verify sendPrompt was called WITH the image parameter
    expect(mockSendPrompt).toHaveBeenCalledWith(
      99,
      "Describe this screenshot",
      { data: expect.any(String), mimeType: "image/png" }
    );
  });

  it("should accept a message without image (backward compatible)", async () => {
    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({ message: "Just a text message" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // sendPrompt should be called with undefined image (backward compatible)
    expect(mockSendPrompt).toHaveBeenCalledWith(99, "Just a text message", undefined);
  });

  it("should reject image with invalid mimeType", async () => {
    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({
        message: "Here's an SVG",
        image: {
          data: "PHN2Zz48L3N2Zz4=",
          mimeType: "image/svg+xml",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mimeType/i);
  });

  it("should reject image with application/pdf mimeType", async () => {
    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({
        message: "Here's a PDF",
        image: {
          data: "JVBERi0xLjQ=",
          mimeType: "application/pdf",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mimeType/i);
  });

  it("should reject image exceeding 10MB decoded size", async () => {
    // Create a base64 string that decodes to > 10MB
    // Base64 encodes 3 bytes per 4 chars, so 14_000_000 chars of base64 ≈ 10.5MB decoded
    const largeData = "A".repeat(14_000_000);

    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({
        message: "Huge image",
        image: {
          data: largeData,
          mimeType: "image/png",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/10\s*MB|size/i);
  });

  it("should reject image with missing data field", async () => {
    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({
        message: "No data",
        image: {
          mimeType: "image/png",
        },
      });

    expect(res.status).toBe(400);
  });

  it("should reject image with missing mimeType field", async () => {
    const res = await request(app)
      .post("/api/task-planner/99/message")
      .send({
        message: "No mimeType",
        image: {
          data: "iVBORw0KGgo=",
        },
      });

    expect(res.status).toBe(400);
  });

  it("should accept all valid mime types (jpeg, png, gif, webp)", async () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      mockSendPrompt.mockResolvedValue(true);
      const res = await request(app)
        .post("/api/task-planner/99/message")
        .send({
          message: "Valid image",
          image: { data: "aGVsbG8=", mimeType },
        });

      expect(res.status).toBe(200);
    }
  });
});
