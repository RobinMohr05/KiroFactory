/**
 * Tests for the scheduled-session additions to /api/sessions:
 *  - POST/PATCH validate cronExpression + cronTimezone (400 on invalid)
 *  - creating/updating cron fields (re)arms or disarms the scheduler
 *  - POST /api/sessions/:id/run-now triggers a one-shot run
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
  triggerRunNow: vi.fn().mockResolvedValue({ skipped: false, attempts: 1, succeeded: true }),
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

// sessions.ts imports getTabById from ../db/tabs.js (via validateCreateTasksFields),
// which statically pulls in db/connection.js (and its dotenv.config()). Mock it so
// the test never touches a live DB path — matching routes/sessions.test.ts.
vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));

import {
  createSession,
  getSession,
  deleteSession,
  updateSessionFields,
  setScheduleActive,
} from "../session-manager.js";
import { armSession, disarmSession, triggerRunNow } from "../scheduled-session-manager.js";
import sessionsRouter from "./sessions.js";

const updateSessionFieldsMock = vi.mocked(updateSessionFields);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  return app;
}

const SESSION_FIXTURE = {
  id: 1,
  name: "Scheduled",
  agent: "",
  status: "stopped" as const,
  prompt: "do a thing",
  interactive: false,
  loop: false,
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

describe("POST /api/sessions — cron validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for an invalid cron expression", async () => {
    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "not a cron", cronTimezone: "UTC" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cron/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid timezone", async () => {
    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "Mars/Base" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a scheduled session and does NOT arm it (scheduleActive defaults to false)", async () => {
    vi.mocked(createSession).mockResolvedValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "Europe/Berlin",
      retries: 2,
      scheduleActive: false,
    });

    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin", retries: 2 });

    expect(res.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin", retries: 2 })
    );
    // scheduleActive defaults to false → do NOT arm on creation
    expect(armSession).not.toHaveBeenCalled();
  });

  it("creates a scheduled session and arms it when scheduleActive=true", async () => {
    vi.mocked(createSession).mockResolvedValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "Europe/Berlin",
      retries: 2,
      scheduleActive: true,
    });

    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin", retries: 2, scheduleActive: true });

    expect(res.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin", retries: 2 })
    );
    expect(armSession).toHaveBeenCalledWith(1, "0 9 * * *", "Europe/Berlin", 2);
  });
});

describe("POST /api/sessions — retries validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for a non-numeric retries value", async () => {
    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retries/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns 400 for a negative retries value", async () => {
    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retries/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-integer retries value", async () => {
    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retries/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("accepts a valid non-negative integer retries value", async () => {
    vi.mocked(createSession).mockResolvedValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
      retries: 3,
    });

    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 3 });

    expect(res.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ retries: 3 }));
  });
});

describe("PATCH /api/sessions/:id — retries validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for a non-numeric retries value", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ retries: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retries/i);
    expect(updateSessionFieldsMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a negative retries value", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ retries: -2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retries/i);
    expect(updateSessionFieldsMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-integer retries value", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ retries: 2.7 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retries/i);
    expect(updateSessionFieldsMock).not.toHaveBeenCalled();
  });

  it("accepts a valid non-negative integer retries value", async () => {
    vi.mocked(getSession)
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC" })
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 4 });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ retries: 4 });

    expect(res.status).toBe(200);
    expect(updateSessionFieldsMock).toHaveBeenCalledWith(1, expect.objectContaining({ retries: 4 }));
  });
});

describe("PATCH /api/sessions/:id — cron validation & (dis)arm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for an invalid cron expression", async () => {
    vi.mocked(getSession).mockReturnValue(SESSION_FIXTURE);

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronExpression: "bogus", cronTimezone: "UTC" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cron/i);
  });

  it("returns 400 for an invalid timezone", async () => {
    vi.mocked(getSession).mockReturnValue(SESSION_FIXTURE);

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronExpression: "0 9 * * *", cronTimezone: "Nowhere/Land" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone/i);
  });

  it("returns 400 for a timezone-only update with an invalid tz on an already-scheduled session", async () => {
    // Already-scheduled session: cronExpression is stored, request omits it and
    // only changes the timezone to an invalid value. Must still validate.
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronTimezone: "Nowhere/Land" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone/i);
    expect(armSession).not.toHaveBeenCalled();
    expect(disarmSession).not.toHaveBeenCalled();
  });

  it("returns 400 for a retries-only update when the stored timezone is invalid", async () => {
    // Defensive: touching only retries on a scheduled session still validates
    // the effective (stored) cron config, so a persisted-bad tz can't slip
    // through and silently disarm the schedule.
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "Nowhere/Land",
    });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ retries: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone/i);
  });

  it("allows a timezone-only update with a valid tz on an already-scheduled session", async () => {
    vi.mocked(getSession)
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC", scheduleActive: true }) // ownership check
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin", scheduleActive: true }); // post-update read

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronTimezone: "Europe/Berlin" });

    expect(res.status).toBe(200);
    expect(armSession).toHaveBeenCalledWith(1, "0 9 * * *", "Europe/Berlin", undefined);
  });

  it("re-arms the scheduler when cron fields are set", async () => {
    vi.mocked(getSession)
      .mockReturnValueOnce(SESSION_FIXTURE) // ownership check
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 1, scheduleActive: true }); // post-update read

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 1 });

    expect(res.status).toBe(200);
    expect(armSession).toHaveBeenCalledWith(1, "0 9 * * *", "UTC", 1);
  });

  it("disarms the scheduler when cronExpression is cleared", async () => {
    vi.mocked(getSession)
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC" })
      .mockReturnValueOnce(SESSION_FIXTURE);

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronExpression: null });

    expect(res.status).toBe(200);
    expect(disarmSession).toHaveBeenCalledWith(1);
  });
});

describe("POST /api/sessions/:id/run-now", () => {
  beforeEach(() => vi.clearAllMocks());

  it("triggers a one-shot run honoring retries", async () => {
    vi.mocked(getSession).mockReturnValue({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 2 });

    const res = await request(createApp())
      .post("/api/sessions/1/run-now");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // one-shot run path invoked with the session's retry count
    expect(triggerRunNow).toHaveBeenCalledWith(1, 2);
  });

  it("returns 404 for another user's session", async () => {
    vi.mocked(getSession).mockReturnValue({ ...SESSION_FIXTURE, userId: 2 });

    const res = await request(createApp())
      .post("/api/sessions/1/run-now");

    expect(res.status).toBe(404);
    expect(triggerRunNow).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/sessions/:id — disarms the scheduler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disarms the scheduled session's timer after a successful delete", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });
    vi.mocked(deleteSession).mockReturnValue(true);

    const res = await request(createApp()).delete("/api/sessions/1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith(1);
    expect(disarmSession).toHaveBeenCalledWith(1);
  });

  it("does not disarm when the delete fails (session not found)", async () => {
    vi.mocked(getSession).mockReturnValue(SESSION_FIXTURE);
    vi.mocked(deleteSession).mockReturnValue(false);

    const res = await request(createApp()).delete("/api/sessions/1");

    expect(res.status).toBe(404);
    expect(disarmSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduleActive — POST /api/sessions creates session NOT armed by default
// ---------------------------------------------------------------------------

describe("POST /api/sessions — scheduleActive defaults to false (no auto-arm)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT arm the scheduler for a newly created scheduled session (scheduleActive defaults false)", async () => {
    vi.mocked(createSession).mockResolvedValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "Europe/Berlin",
      retries: 0,
      scheduleActive: false,
    });

    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin" });

    expect(res.status).toBe(201);
    // scheduleActive is false → do NOT arm
    expect(armSession).not.toHaveBeenCalled();
  });

  it("arms the scheduler when scheduleActive is true on a newly created scheduled session", async () => {
    vi.mocked(createSession).mockResolvedValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "Europe/Berlin",
      retries: 0,
      scheduleActive: true,
    });

    const res = await request(createApp())
      .post("/api/sessions")
      .send({ name: "S", cronExpression: "0 9 * * *", cronTimezone: "Europe/Berlin", scheduleActive: true });

    expect(res.status).toBe(201);
    expect(armSession).toHaveBeenCalledWith(1, "0 9 * * *", "Europe/Berlin", 0);
  });
});

// ---------------------------------------------------------------------------
// scheduleActive — PATCH arms only when scheduleActive === true
// ---------------------------------------------------------------------------

describe("PATCH /api/sessions/:id — arming respects scheduleActive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT arm when cronExpression is set but scheduleActive remains false", async () => {
    vi.mocked(getSession)
      .mockReturnValueOnce(SESSION_FIXTURE)
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC", scheduleActive: false });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronExpression: "0 9 * * *", cronTimezone: "UTC" });

    expect(res.status).toBe(200);
    expect(disarmSession).toHaveBeenCalledWith(1);
    expect(armSession).not.toHaveBeenCalled();
  });

  it("arms when cronExpression is set and scheduleActive is true", async () => {
    vi.mocked(getSession)
      .mockReturnValueOnce(SESSION_FIXTURE)
      .mockReturnValueOnce({ ...SESSION_FIXTURE, cronExpression: "0 9 * * *", cronTimezone: "UTC", scheduleActive: true });

    const res = await request(createApp())
      .patch("/api/sessions/1")
      .send({ cronExpression: "0 9 * * *", cronTimezone: "UTC", scheduleActive: true });

    expect(res.status).toBe(200);
    expect(armSession).toHaveBeenCalledWith(1, "0 9 * * *", "UTC", undefined);
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/schedule/activate
// ---------------------------------------------------------------------------

describe("POST /api/sessions/:id/schedule/activate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 for a non-existent session", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);

    const res = await request(createApp())
      .post("/api/sessions/99/schedule/activate");

    expect(res.status).toBe(404);
    expect(setScheduleActive).not.toHaveBeenCalled();
    expect(armSession).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's session", async () => {
    vi.mocked(getSession).mockReturnValue({ ...SESSION_FIXTURE, userId: 2 });

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/activate");

    expect(res.status).toBe(404);
    expect(setScheduleActive).not.toHaveBeenCalled();
  });

  it("returns 400 when session has no cronExpression", async () => {
    vi.mocked(getSession).mockReturnValue(SESSION_FIXTURE); // no cronExpression

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/activate");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cron/i);
    expect(setScheduleActive).not.toHaveBeenCalled();
    expect(armSession).not.toHaveBeenCalled();
  });

  it("sets scheduleActive=true and arms the session", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "Europe/Berlin",
      retries: 2,
    });
    vi.mocked(setScheduleActive).mockResolvedValue(true);

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/activate");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(setScheduleActive).toHaveBeenCalledWith(1, true);
    expect(armSession).toHaveBeenCalledWith(1, "0 9 * * *", "Europe/Berlin", 2);
  });

  it("works even when the session is currently running", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      status: "running" as const,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });
    vi.mocked(setScheduleActive).mockResolvedValue(true);

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/activate");

    expect(res.status).toBe(200);
    expect(setScheduleActive).toHaveBeenCalledWith(1, true);
    expect(armSession).toHaveBeenCalled();
  });

  it("returns 500 (does NOT arm) when persisting scheduleActive fails", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
    });
    // DB write rejects (e.g. DB temporarily unavailable) — must not respond 200.
    vi.mocked(setScheduleActive).mockRejectedValue(new Error("db down"));

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/activate");

    expect(res.status).toBe(500);
    expect(setScheduleActive).toHaveBeenCalledWith(1, true);
    // Persistence failed → the timer must NOT be armed on a false promise.
    expect(armSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/sessions/:id/schedule/deactivate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 for a non-existent session", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);

    const res = await request(createApp())
      .post("/api/sessions/99/schedule/deactivate");

    expect(res.status).toBe(404);
    expect(setScheduleActive).not.toHaveBeenCalled();
    expect(disarmSession).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's session", async () => {
    vi.mocked(getSession).mockReturnValue({ ...SESSION_FIXTURE, userId: 2 });

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/deactivate");

    expect(res.status).toBe(404);
    expect(setScheduleActive).not.toHaveBeenCalled();
  });

  it("sets scheduleActive=false and disarms the session", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
      scheduleActive: true,
    });
    vi.mocked(setScheduleActive).mockResolvedValue(true);

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/deactivate");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(setScheduleActive).toHaveBeenCalledWith(1, false);
    expect(disarmSession).toHaveBeenCalledWith(1);
  });

  it("works even when the session is currently running (does NOT abort the run)", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      status: "running" as const,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
      scheduleActive: true,
    });
    vi.mocked(setScheduleActive).mockResolvedValue(true);

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/deactivate");

    expect(res.status).toBe(200);
    expect(setScheduleActive).toHaveBeenCalledWith(1, false);
    expect(disarmSession).toHaveBeenCalledWith(1);
  });

  it("returns 500 (does NOT disarm) when persisting scheduleActive fails", async () => {
    vi.mocked(getSession).mockReturnValue({
      ...SESSION_FIXTURE,
      cronExpression: "0 9 * * *",
      cronTimezone: "UTC",
      scheduleActive: true,
    });
    vi.mocked(setScheduleActive).mockRejectedValue(new Error("db down"));

    const res = await request(createApp())
      .post("/api/sessions/1/schedule/deactivate");

    expect(res.status).toBe(500);
    expect(setScheduleActive).toHaveBeenCalledWith(1, false);
    expect(disarmSession).not.toHaveBeenCalled();
  });
});
