/**
 * Tests for the DB-ownership fallback on the session turn/output routes
 * (PR #143 review): GET /api/sessions/:id/turns and /:id/output must remain
 * reachable for pooled sessions that have been stopped and evicted from the
 * in-memory `sessions` Map. Those sessions are still returned by
 * GET /api/autoscalers/:id/sessions (which falls back to getSessionFromDb),
 * so the turn browser must not 404 for them.
 *
 * Uses the same mock-based supertest pattern as routes/autoscalers.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../session-manager.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionTurnCount: vi.fn().mockReturnValue(0),
  getAllSessions: vi.fn().mockReturnValue([]),
  getSessionOutput: vi.fn().mockReturnValue([]),
  deleteSession: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  sendPrompt: vi.fn(),
  updateSessionTabs: vi.fn(),
  reorderSessions: vi.fn(),
  pinSession: vi.fn(),
  updateSessionFields: vi.fn().mockReturnValue({ success: true }),
  setScheduleActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("../scheduled-session-manager.js", () => ({
  armSession: vi.fn(),
  disarmSession: vi.fn(),
  triggerRunNow: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

vi.mock("../db/turns.js", () => ({ getTurnsBySession: vi.fn().mockResolvedValue([]) }));

vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/sessions.js", () => ({
  getSessionFromDb: vi.fn(),
}));

import { getSession, getSessionOutput } from "../session-manager.js";
import { getTurnsBySession } from "../db/turns.js";
import { getSessionFromDb } from "../db/sessions.js";
import sessionsRouter from "./sessions.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  return app;
}

const DB_SESSION_FIXTURE = {
  id: 42,
  name: "pooled-evicted",
  agent: "developer-agent",
  status: "stopped" as const,
  prompt: "",
  interactive: false,
  loop: true,
  runs: 0,
  intervalSeconds: 10,
  cwd: "/workspace",
  timeoutSeconds: 0,
  userId: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  output: [],
  pinned: false,
  isPermanent: false,
  sortOrder: 0,
};

const TURN_FIXTURE = {
  id: 1,
  sessionId: 42,
  turnNumber: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  verdict: "resolved",
};

describe("GET /api/sessions/:id/turns — DB ownership fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns turns from the DB when the session is not in memory but is owned in the DB", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getSessionFromDb).mockResolvedValue(DB_SESSION_FIXTURE as any);
    vi.mocked(getTurnsBySession).mockResolvedValue([TURN_FIXTURE as any]);

    const res = await request(createApp()).get("/api/sessions/42/turns");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
    expect(getSessionFromDb).toHaveBeenCalledWith(42);
  });

  it("returns 404 when the session is absent from memory AND the DB", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getSessionFromDb).mockResolvedValue(null);

    const res = await request(createApp()).get("/api/sessions/999/turns");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the DB session belongs to another user", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getSessionFromDb).mockResolvedValue({ ...DB_SESSION_FIXTURE, userId: 2 } as any);

    const res = await request(createApp()).get("/api/sessions/42/turns");

    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/output — DB ownership fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns output for a DB-owned session not resident in memory", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getSessionFromDb).mockResolvedValue(DB_SESSION_FIXTURE as any);
    vi.mocked(getSessionOutput).mockReturnValue([{ type: "stdout", data: "hi", timestamp: 1 } as any]);

    const res = await request(createApp()).get("/api/sessions/42/output");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ type: "stdout", data: "hi", timestamp: 1 }]);
    expect(getSessionFromDb).toHaveBeenCalledWith(42);
  });

  it("returns 404 when the session is absent from memory AND the DB", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getSessionFromDb).mockResolvedValue(null);

    const res = await request(createApp()).get("/api/sessions/999/output");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the DB session belongs to another user", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getSessionFromDb).mockResolvedValue({ ...DB_SESSION_FIXTURE, userId: 2 } as any);

    const res = await request(createApp()).get("/api/sessions/42/output");

    expect(res.status).toBe(404);
  });
});
