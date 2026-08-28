/**
 * Tests for /api/flocks routes.
 * Uses the same mock-based pattern as routes/auth.viewmode.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../flock-manager.js", () => ({
  createFlockRecord: vi.fn(),
  getAllFlocks: vi.fn(),
  startFlock: vi.fn(),
  stopFlock: vi.fn(),
  deleteFlockRecord: vi.fn(),
  getFlockSessionCounts: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../db/flocks.js", () => ({
  getFlockById: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { createFlockRecord, getAllFlocks, startFlock, stopFlock, deleteFlockRecord } from "../flock-manager.js";
import { getFlockById } from "../db/flocks.js";
import flocksRouter from "./flocks.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/flocks", flocksRouter);
  return app;
}

const FLOCK_FIXTURE = {
  id: 1,
  name: "Test Flock",
  userId: 1,
  agentName: "developer-agent",
  tabIds: [1],
  maxConcurrency: 5,
  idleTimeoutSeconds: 30,
  status: "stopped" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("Flock routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/flocks", () => {
    it("returns all flocks for the authenticated user", async () => {
      vi.mocked(getAllFlocks).mockResolvedValue([FLOCK_FIXTURE]);

      const res = await request(createApp()).get("/api/flocks");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Test Flock");
      expect(res.body[0].runningSessionCount).toBe(0);
    });
  });

  describe("POST /api/flocks", () => {
    it("creates a flock and returns 201", async () => {
      vi.mocked(createFlockRecord).mockResolvedValue(FLOCK_FIXTURE);

      const res = await request(createApp())
        .post("/api/flocks")
        .send({ name: "Test Flock", agentName: "developer-agent", tabIds: [1] });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Test Flock");
      expect(createFlockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Flock",
          agentName: "developer-agent",
          tabIds: [1],
          userId: 1,
        })
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(createApp())
        .post("/api/flocks")
        .send({ agentName: "developer-agent", tabIds: [1] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name");
    });

    it("returns 400 when agentName is missing", async () => {
      const res = await request(createApp())
        .post("/api/flocks")
        .send({ name: "Test", tabIds: [1] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("agentName");
    });

    it("returns 400 when tabIds is empty", async () => {
      const res = await request(createApp())
        .post("/api/flocks")
        .send({ name: "Test", agentName: "dev", tabIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("tabIds");
    });
  });

  describe("POST /api/flocks/:id/start", () => {
    it("starts a flock owned by the user", async () => {
      vi.mocked(getFlockById).mockResolvedValue(FLOCK_FIXTURE);
      const runningFlock = { ...FLOCK_FIXTURE, status: "running" as const };
      vi.mocked(startFlock).mockResolvedValue(runningFlock);

      const res = await request(createApp())
        .post("/api/flocks/1/start");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("running");
    });

    it("returns 404 for another user's flock", async () => {
      vi.mocked(getFlockById).mockResolvedValue({ ...FLOCK_FIXTURE, userId: 2 });

      const res = await request(createApp())
        .post("/api/flocks/1/start");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/flocks/:id/stop", () => {
    it("stops a flock owned by the user", async () => {
      const runningFlock = { ...FLOCK_FIXTURE, status: "running" as const };
      vi.mocked(getFlockById).mockResolvedValue(runningFlock);
      const stoppedFlock = { ...FLOCK_FIXTURE, status: "stopped" as const };
      vi.mocked(stopFlock).mockResolvedValue(stoppedFlock);

      const res = await request(createApp())
        .post("/api/flocks/1/stop");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("stopped");
    });
  });

  describe("DELETE /api/flocks/:id", () => {
    it("deletes a flock owned by the user", async () => {
      vi.mocked(getFlockById).mockResolvedValue(FLOCK_FIXTURE);
      vi.mocked(deleteFlockRecord).mockResolvedValue(true);

      const res = await request(createApp())
        .delete("/api/flocks/1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for non-existent flock", async () => {
      vi.mocked(getFlockById).mockResolvedValue(null);

      const res = await request(createApp())
        .delete("/api/flocks/999");

      expect(res.status).toBe(404);
    });
  });
});
